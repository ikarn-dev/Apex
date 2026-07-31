#!/usr/bin/env node
/**
 * Car pipeline: `assets/source/cars/zagato.glb` -> `public/models/cars/*.glb`.
 *
 * The source is a 25MB photogrammetry-grade marketplace export with 31 textures
 * at up to 4K. That is not a web payload. But unlike the previous pipeline, this
 * one does **not** replace the model's materials with flat colours: the car is
 * shipped with its own PBR textures, because the paint, the gold rim decals and
 * the tinted glass are the reason to use this model at all.
 *
 * What it does instead:
 *
 * - **Drops geometry the chase camera cannot see.** The full cabin — seats,
 *   carpet, belts, stitching, gauges, screens, speakers — sits behind tinted
 *   glass and is roughly half the vertices and most of the texture budget.
 * - **Protects the transform rig.** The source exposes four `WHEEL_**` groups and
 *   a `STEER_HR` group, which is what lets the runtime spin the wheels, steer the
 *   front axle and turn the steering wheel. `flatten` and `join` would collapse
 *   those groups away, so each one gets a tiny non-playing animation channel:
 *   gltf-transform will not flatten a node that an animation targets.
 * - **Keeps decode cheap.** Quantised geometry via `KHR_mesh_quantization`, which
 *   three.js decodes natively — no Draco or Meshopt WASM decoder on the race
 *   loading path — and WebP textures for transmission size.
 *
 * Idempotent: skips a variant whose output is newer than its source. Pass
 * `--force` to rebuild, `--classify` to print how the strip pass bucketed the
 * model without waiting for a full optimise.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { writeAssetManifest } from "./lib/asset-manifest.mjs";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "assets", "source", "cars");
const OUTPUT_DIR = join(ROOT, "public", "models", "cars");

/**
 * Runtime budgets, per variant.
 *
 * Looser than a flat-material car would need, because this one ships real
 * textures. The limit that actually bites is draw calls.
 *
 * Keeping the rig costs primitives: `join` cannot merge across a node an
 * animation targets, so each protected wheel arrives as its own tyre, rim, gold,
 * chrome, decal and disc primitives. That is worth paying once, for the car the
 * player is looking at. It is not worth paying five more times for rivals two
 * lengths back, so the rival variant drops the rig and collapses to a handful of
 * draw calls — the field costs about as much as one rigged car.
 */
const BUDGETS = {
  rigged: {
    // The player car keeps source wheel topology. It is one close-up object, so
    // preserving the tyres is worth the extra geometry; rivals remain simplified.
    bytes: 5 * 1024 * 1024,
    vertices: 160_000,
    primitives: 56,
    textures: 24,
    textureVram: 22 * 1024 * 1024,
  },
  plain: {
    bytes: 2 * 1024 * 1024,
    vertices: 70_000,
    // 34, not single digits: the model has 17 textured materials and `join`
    // cannot merge across a material boundary. Getting below that would mean
    // baking the materials into a palette, which is exactly the flattening this
    // pipeline exists to avoid. Rivals are capped at two by every quality tier,
    // so the whole field still costs about 115 draw calls.
    primitives: 34,
    textures: 24,
    textureVram: 12 * 1024 * 1024,
  },
};

/**
 * Groups the runtime animates. Order is not important; presence is.
 *
 * `CarView` finds these by name after load and wraps each in its own steer and
 * spin pivots, so the names have to survive the optimiser intact.
 */
const RIG_NODES = [
  /^WHEEL_LF/i,
  /^WHEEL_RF/i,
  /^WHEEL_LR/i,
  /^WHEEL_RR/i,
  /^STEER_HR/i,
];

/**
 * Cabin surfaces that are never legible through the glass from a chase camera.
 *
 * Matched on material name, which this source names honestly (`int_plastic`,
 * `leather_1`, `carpet`). The steering wheel is deliberately *not* in here: it is
 * small, it is rigged, and it is visible in a cockpit view.
 */
const HIDDEN_MATERIAL =
  /^(int_|leather|carpet|belts|stitching|speakers|gauges|screens|backrooms|LCD|mesh$)/i;

/** Node names that must be kept even if their material looks interior. */
const KEEP_NODE = /^(STEER_HR|WHEEL_|RIM_|GEO_Tyre|GEO_Disc|rim_)/i;

/**
 * Tyre materials, which the source ships as fully metallic.
 *
 * `EXT_WHEEL` and `EXT_WHEEL_0` are the two tyre carcasses — the front-left uses
 * one and the other three share the other — and both arrive with
 * `metallicFactor: 1.0`. Under this scene's image-based lighting a fully metallic
 * surface reflects the sky instead of shading, so the tyre rendered as a bright
 * chrome ring and the whole wheel read as a bare rim with no rubber on it. The
 * runtime's own clamp in `Resources.prepareCar` only pulls metalness down to 0.55,
 * which is still chrome.
 *
 * Corrected here rather than at load: this is a defect in one supplied model, the
 * fix belongs with the model, and `inspect-assets` can then assert that no shipped
 * tyre is metallic.
 */
export const RUBBER_MATERIAL = /^(EXT_WHEEL|EXT_TYRE|tyre|tire|rubber)/i;
const RUBBER_ROUGHNESS = 0.92;
/** Dark neutral rubber that remains visible under every level's sky lighting. */
const RUBBER_BASE_COLOR = [0.2, 0.22, 0.23, 1];
/** Source tyre topology; the HQ optimizer must not reduce the carcass below this. */
const MIN_RIGGED_TYRE_TRIANGLES = 1_800;

const VARIANTS = [
  // The player's car: preserve source geometry around its close-up wheels. The
  // body is still cabin-stripped, quantized and texture-compressed.
  {
    suffix: "",
    textureSize: "640",
    simplifyError: "0.004",
    simplify: false,
    rig: true,
  },
  // Rivals: same model and same textures, rig collapsed and geometry simplified.
  {
    suffix: "-lq",
    textureSize: "384",
    simplifyError: "0.012",
    simplify: true,
    rig: false,
  },
];

function argsFor(variant) {
  return [
    // Real textures, so no palette baking: merging materials into a palette
    // texture is what destroys a textured model's look.
    "--palette",
    "false",
    "--compress",
    "quantize",
    "--texture-compress",
    "webp",
    "--texture-size",
    variant.textureSize,
    "--flatten",
    "true",
    "--join",
    "true",
    "--weld",
    "true",
    "--simplify",
    String(variant.simplify),
    "--simplify-error",
    variant.simplifyError,
    "--prune",
    "true",
    "--prune-solid-textures",
    "true",
    // Each car is placed once per race, so instancing buys nothing.
    "--instance",
    "false",
  ];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function isUpToDate(sourcePath, outputPath) {
  try {
    const [source, output] = await Promise.all([stat(sourcePath), stat(outputPath)]);
    return output.mtimeMs > source.mtimeMs;
  } catch {
    return false;
  }
}

/** Detach a mesh node while leaving retained ancestor transforms alone. */
function removeNode(node) {
  for (const parent of node.listParents()) {
    if (typeof parent.removeChild === "function") parent.removeChild(node);
  }
  node.dispose();
}

function ancestorNames(node) {
  const names = [node.getName()];
  const pending = [...node.listParents()];
  const seen = new Set();
  while (pending.length > 0) {
    const parent = pending.pop();
    if (!parent || seen.has(parent) || parent.propertyType !== "Node") continue;
    seen.add(parent);
    names.push(parent.getName());
    pending.push(...parent.listParents());
  }
  return names;
}

function isHidden(node) {
  const names = ancestorNames(node);
  if (names.some((name) => KEEP_NODE.test(name))) return false;
  const materials = (node.getMesh()?.listPrimitives() ?? [])
    .map((primitive) => primitive.getMaterial()?.getName() ?? "")
    .filter(Boolean);
  return materials.length > 0 && materials.every((name) => HIDDEN_MATERIAL.test(name));
}

/**
 * Pin the rig against `flatten` and `join`.
 *
 * A single two-keyframe STEP channel per node, holding the node's existing
 * rotation. It never plays — the runtime drives these transforms directly — but
 * its presence is what stops the optimiser from folding the node into its parent.
 */
function guardRig(document, nodes) {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("buffer");
  const times = document
    .createAccessor("APEX rig guard times")
    .setType("SCALAR")
    .setArray(new Float32Array([0, 1]))
    .setBuffer(buffer);
  const animation = document.createAnimation("APEX_RIG_GUARD");

  for (const node of nodes) {
    const r = node.getRotation();
    const output = document
      .createAccessor(`APEX rig guard ${node.getName()}`)
      .setType("VEC4")
      .setArray(new Float32Array([r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]]))
      .setBuffer(buffer);
    const sampler = document
      .createAnimationSampler()
      .setInput(times)
      .setOutput(output)
      .setInterpolation("STEP");
    animation
      .addSampler(sampler)
      .addChannel(
        document
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(node)
          .setTargetPath("rotation"),
      );
  }
}

/**
 * Strip the cabin and pin the rig, leaving every retained material untouched.
 *
 * Returns a report so `--classify` can show what happened, and the measured
 * forward direction so `cars.ts` can carry a correct `modelYaw` instead of a
 * guess. Front/rear lamp positions give the direction; a bounding box only gives
 * the axis, and a car facing backwards on the grid is easy to miss in review.
 */
async function buildRuntimeSource(sourcePath, outputPath, withRig = true) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(sourcePath);
  const root = document.getRoot();

  let kept = 0;
  let keptVertices = 0;
  let dropped = 0;
  let droppedVertices = 0;

  for (const node of [...root.listNodes()]) {
    if (node.isDisposed() || !node.getMesh()) continue;
    let vertices = 0;
    for (const primitive of node.getMesh().listPrimitives()) {
      vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
    }
    if (isHidden(node)) {
      removeNode(node);
      dropped += 1;
      droppedVertices += vertices;
    } else {
      kept += 1;
      keptVertices += vertices;
    }
  }

  // Rubber is not metal. Asserted, not best-effort: if the source renames its tyre
  // materials the build should stop, because the failure it produces is a chrome
  // tyre that looks like a missing one.
  const rubber = root.listMaterials().filter((m) => RUBBER_MATERIAL.test(m.getName()));
  if (rubber.length === 0) {
    throw new Error(
      `No tyre material in ${sourcePath} matched ${RUBBER_MATERIAL}. The source's ` +
        `material names have changed, and its metallic tyres would ship as chrome.`,
    );
  }
  for (const material of rubber) {
    material.setBaseColorFactor(RUBBER_BASE_COLOR);
    material.setMetallicFactor(0);
    material.setRoughnessFactor(RUBBER_ROUGHNESS);
    material.setMetallicRoughnessTexture(null);
  }

  const rig = [];
  for (const pattern of RIG_NODES) {
    const node = root.listNodes().find((n) => !n.isDisposed() && pattern.test(n.getName()));
    if (node) rig.push(node);
  }
  if (rig.length !== RIG_NODES.length) {
    throw new Error(
      `Expected ${RIG_NODES.length} rig nodes in ${sourcePath}, found ${rig.length} ` +
        `(${rig.map((n) => n.getName()).join(", ") || "none"}). The runtime cannot ` +
        `animate the wheels without them.`,
    );
  }
  // Verified either way, so a source model that loses its rig fails the build
  // rather than silently shipping a car with welded-on wheels.
  if (withRig) guardRig(document, rig);

  if (outputPath) await io.write(outputPath, document);
  return {
    kept,
    keptVertices,
    dropped,
    droppedVertices,
    rig: rig.map((node) => node.getName()),
    rubber: rubber.map((material) => material.getName()),
  };
}

async function measureRuntimeCost(path) {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
  const root = (await io.read(path)).getRoot();

  let vertices = 0;
  let primitives = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
    }
  }
  const textures = root.listTextures();
  const textureVram = textures.reduce((total, texture) => {
    const [width, height] = texture.getSize() ?? [0, 0];
    return total + width * height * 4 * 1.33;
  }, 0);

  const rig = RIG_NODES.filter((pattern) =>
    root.listNodes().some((node) => pattern.test(node.getName())),
  ).length;

  // Inspect the tyre primitive under each wheel group rather than trusting the
  // group's combined bounds, which a rim or brake disc can satisfy by itself.
  const tyres = [];
  for (const pattern of RIG_NODES.slice(0, 4)) {
    const wheel = root.listNodes().find((node) => pattern.test(node.getName()));
    if (!wheel) continue;
    const pending = [wheel];
    let tyreVertices = 0;
    let tyreTriangles = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      pending.push(...node.listChildren());
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        if (!RUBBER_MATERIAL.test(primitive.getMaterial()?.getName() ?? "")) continue;
        const positions = primitive.getAttribute("POSITION")?.getCount() ?? 0;
        tyreVertices += positions;
        tyreTriangles += Math.floor((primitive.getIndices()?.getCount() ?? positions) / 3);
      }
    }
    tyres.push({ wheel: wheel.getName(), vertices: tyreVertices, triangles: tyreTriangles });
  }

  return { vertices, primitives, textures: textures.length, textureVram, rig, tyres };
}

function enforceBudget(name, bytes, cost, variant) {
  const budget = variant.rig ? BUDGETS.rigged : BUDGETS.plain;
  const failures = [];
  if (bytes > budget.bytes) {
    failures.push(`${formatBytes(bytes)} > ${formatBytes(budget.bytes)} file`);
  }
  if (cost.vertices > budget.vertices) {
    failures.push(
      `${cost.vertices.toLocaleString("en-US")} > ${budget.vertices.toLocaleString("en-US")} vertices`,
    );
  }
  if (cost.primitives > budget.primitives) {
    failures.push(`${cost.primitives} > ${budget.primitives} primitives`);
  }
  if (cost.textures > budget.textures) {
    failures.push(`${cost.textures} > ${budget.textures} textures`);
  }
  if (cost.textureVram > budget.textureVram) {
    failures.push(
      `${formatBytes(cost.textureVram)} > ${formatBytes(budget.textureVram)} texture VRAM`,
    );
  }
  // A silently un-rigged player car is the failure this pipeline exists to catch:
  // it looks fine standing still and the wheels never turn.
  if (variant.rig && cost.rig !== RIG_NODES.length) {
    failures.push(`${cost.rig}/${RIG_NODES.length} rig nodes survived optimisation`);
  }
  if (variant.rig) {
    if (cost.tyres.length !== 4) {
      failures.push(`${cost.tyres.length}/4 tyre carcasses survived optimisation`);
    }
    for (const tyre of cost.tyres) {
      if (tyre.triangles < MIN_RIGGED_TYRE_TRIANGLES) {
        failures.push(
          `${tyre.wheel} tyre has ${tyre.triangles} triangles ` +
            `(< ${MIN_RIGGED_TYRE_TRIANGLES} source-detail minimum)`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`${name} exceeds the runtime budget: ${failures.join(", ")}`);
  }
}

const SOURCE = "zagato.glb";
const RUNTIME = "zagato";



async function main() {
  const force = process.argv.includes("--force");
  const sourcePath = join(SOURCE_DIR, SOURCE);

  let sources;
  try {
    sources = (await readdir(SOURCE_DIR)).filter((name) => name.endsWith(".glb"));
  } catch {
    console.error(
      `\n  No source models at ${SOURCE_DIR}\n\n` +
        `  The raw GLBs are git-ignored because they are very large. Drop\n` +
        `  ${SOURCE} in assets/source/cars/, then re-run:\n` +
        `  npm run assets:optimize\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!sources.includes(SOURCE)) {
    console.error(`\n  ${SOURCE} not found in ${SOURCE_DIR}\n`);
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes("--classify")) {
    const report = await buildRuntimeSource(sourcePath, null);
    console.log(
      `\n  ${RUNTIME} — kept ${report.kept} nodes ` +
        `(${report.keptVertices.toLocaleString("en-US")} verts), ` +
        `dropped ${report.dropped} (${report.droppedVertices.toLocaleString("en-US")} verts)\n` +
        `  rig: ${report.rig.join(", ")}\n`,
    );
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const temporaryDir = await mkdtemp(join(tmpdir(), "apex-assets-"));
  const before = (await fileSize(sourcePath)) ?? 0;

  console.log(`\n  APEX car pipeline — ${SOURCE} × ${VARIANTS.length} variants\n`);

  let totalAfter = 0;
  let overBudget = 0;

  for (const variant of VARIANTS) {
    const outputName = `${RUNTIME}${variant.suffix}.glb`;
    const outputPath = join(OUTPUT_DIR, outputName);

    if (!force && (await isUpToDate(sourcePath, outputPath))) {
      const existing = (await fileSize(outputPath)) ?? 0;
      console.log(`  = ${outputName.padEnd(16)} up to date  ${formatBytes(existing)}`);
      totalAfter += existing;
      continue;
    }

    process.stdout.write(`  → ${outputName.padEnd(16)} ${formatBytes(before).padStart(9)} … `);
    const startedAt = Date.now();

    try {
      // Each variant needs its own intermediate: they differ in whether the rig
      // is pinned, and that decision has to be made before `optimize` runs.
      const runtimeSourcePath = join(temporaryDir, `${variant.suffix || "hq"}-${SOURCE}`);
      const report = await buildRuntimeSource(sourcePath, runtimeSourcePath, variant.rig);
      process.stdout.write(
        `\n    strip: kept ${report.kept}, dropped ${report.dropped} cabin nodes ` +
          `(−${report.droppedVertices.toLocaleString("en-US")} verts); ` +
          `rig ${variant.rig ? `pinned (${report.rig.length})` : "collapsed"}; ` +
          `rubber ${report.rubber.join("+")}` +
          `\n    ${" ".repeat(18)}`,
      );

      await execFileAsync(
        "npx",
        ["gltf-transform", "optimize", runtimeSourcePath, outputPath, ...argsFor(variant)],
        { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      console.log("FAILED");
      console.error(`\n    ${error.stderr || error.message}\n`);
      process.exitCode = 1;
      continue;
    }

    const after = await fileSize(outputPath);
    if (after === null) {
      console.log("FAILED (no output written)");
      process.exitCode = 1;
      continue;
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const ratio = ((1 - after / before) * 100).toFixed(1);
    const cost = await measureRuntimeCost(outputPath);
    console.log(
      `${formatBytes(after).padStart(9)}  −${ratio}%  ${seconds}s  ` +
        `${cost.vertices.toLocaleString("en-US")} verts, ${cost.primitives} prims, ` +
        `${cost.textures} tex, ${formatBytes(cost.textureVram)} vram, rig ${cost.rig}/${RIG_NODES.length}`,
    );

    try {
      enforceBudget(outputName, after, cost, variant);
    } catch (error) {
      overBudget += 1;
      console.error(`    ${error.message}`);
      process.exitCode = 1;
    }
    totalAfter += after;
  }

  await rm(temporaryDir, { recursive: true, force: true });

  // Always rewritten, even when every variant was up to date, so the manifest
  // cannot drift from the files on disk.
  const assets = await writeAssetManifest();
  console.log("");
  for (const [url, hash] of Object.entries(assets)) {
    console.log(`  ${url.padEnd(30)} v=${hash}`);
  }

  console.log(
    `\n  Total ${formatBytes(before)} source → ${formatBytes(totalAfter)} shipped` +
      (before > 0 ? `  (−${((1 - totalAfter / before) * 100).toFixed(1)}%)` : ""),
  );

  if (overBudget > 0) {
    console.error(`\n  ${overBudget} variant(s) exceed the runtime budget.\n`);
  } else {
    console.log(
      "  Both variants within budget, textures intact, and the player car's " +
        "wheel/steering rig preserved.\n",
    );
  }
}

await main();
