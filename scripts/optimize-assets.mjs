#!/usr/bin/env node
/**
 * Car model pipeline: `assets/source/cars/*.glb` -> `public/models/cars/*.glb`.
 *
 * The source models are film-quality scans, 25-37MB each, and 198MB total. That
 * is not a web payload — it is most of a mobile data plan for three cars. The
 * bulk of it is texture data at 4K, plus vertex counts far beyond what a chase
 * camera can resolve.
 *
 * The pipeline: cap textures at 1K and recompress to WebP, Draco-compress
 * geometry, weld and mildly simplify meshes, join meshes to cut draw calls, and
 * prune anything the scene does not reference. Target is under 2.5MB per car.
 *
 * WebP rather than KTX2 for the textures: KTX2 wins on VRAM, WebP wins on
 * download size, and download size is the constraint that decides whether
 * someone on a phone ever sees the game. `src/game/engine/Resources.ts` is
 * configured for both, so switching is a one-line change here.
 *
 * Idempotent: skips a car whose output is newer than its source. Pass `--force`
 * to rebuild everything.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "assets", "source", "cars");
const OUTPUT_DIR = join(ROOT, "public", "models", "cars");

/** Fail the build above this, in bytes. See PRD F-P3. */
const SIZE_BUDGET = 2.5 * 1024 * 1024;
/** Warn above this, so drift toward the budget is visible early. */
const SIZE_WARN = 2.0 * 1024 * 1024;

/**
 * Two variants per car.
 *
 * `hq` is what the player drives — they look at it for three minutes straight.
 * `-lq` is for rival cars and for mobile, which never resolve 1K textures at
 * chase distance and would otherwise pay full VRAM for five cars only ever seen
 * from behind. Halving texture dimensions is roughly a quarter of the VRAM.
 */
const VARIANTS = [
  { suffix: "", textureSize: "1024", simplifyError: "0.0008" },
  { suffix: "-lq", textureSize: "512", simplifyError: "0.004" },
];

const BASE_ARGS = [
  // Draco for geometry: better ratio than meshopt for static meshes, and the
  // decoder is a widely cached WASM blob.
  "--compress",
  "draco",
  "--texture-compress",
  "webp",
  // Fewer, larger meshes: a car arriving as 80 separate meshes is 80 draw calls.
  "--flatten",
  "true",
  "--join",
  "true",
  "--simplify",
  "true",
  "--weld",
  "true",
  "--prune",
  "true",
  "--prune-solid-textures",
  "true",
  // Palette merging matters more here than it looks. These models carry ~67
  // materials, and most are untextured solid colours (paint, trim, plastics).
  // Baking those into a small palette texture lets `join` actually merge the
  // primitives behind them, which is the difference between ~225 draw calls per
  // car and something a phone can render six of.
  "--palette",
  "true",
  "--palette-min",
  "2",
  // GPU instancing is pointless here: each car is placed once per race.
  "--instance",
  "false",
];

function argsFor(variant) {
  return [
    ...BASE_ARGS,
    "--texture-size",
    variant.textureSize,
    // Simplification tolerance. Conservative on hq — these models carry far more
    // triangles than the silhouette needs, but panel gaps and badges go to mush
    // if pushed hard. Looser on lq, where nothing is close to the camera.
    "--simplify-error",
    variant.simplifyError,
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

/**
 * Transform rigs the runtime animates.
 *
 * The supplied model exposes `Left Front Tire Pivot`-style groups plus a
 * `Steering Wheel Pivot`. Matching the pivot groups (rather than the tyre meshes
 * inside them) keeps each wheel a single transformable subtree.
 */
const WHEEL_PIVOT = /^(left|right)\s+(front|back|rear)\s+tire\s+pivot$/i;
const STEERING_PIVOT = /^steering\s+wheel\s+pivot$/i;

/**
 * Ground-shadow disc baked into the source scene.
 *
 * It is a 6.9m plane, which is wider than the car and would otherwise dominate
 * the model bounds and break length-based auto-scaling. It also reads as a hard
 * grey circle under the car in a daylight scene.
 */
const FAKE_SHADOW = /^circle(\.\d+)?$/i;

/**
 * Runtime file name for a source model.
 *
 * Source files keep their long marketplace names; the runtime URLs in
 * `src/game/config/cars.ts` are short and stable.
 */
const RUNTIME_NAMES = {
  "car_generic_hatchback_gameready_with_interior.glb": "hatch",
};

function runtimeName(sourceName) {
  const mapped = RUNTIME_NAMES[sourceName];
  if (!mapped) {
    throw new Error(
      `No runtime name mapped for ${sourceName}. Add it to RUNTIME_NAMES and to CARS.`,
    );
  }
  return mapped;
}

function hasMesh(root) {
  let found = false;
  root.traverse((node) => {
    if (node.getMesh()) found = true;
  });
  return found;
}

/**
 * Keep each animated rig as a transformable subtree through `flatten` + `join`,
 * and drop the baked shadow disc.
 *
 * glTF Transform intentionally leaves animated nodes and their descendants in
 * place. A tiny, non-playing guard clip therefore protects only the rig roots
 * while the rest of the car is still flattened and joined for low draw counts.
 * Three.js loads the clip but CarView never plays it; simulation state remains
 * the sole animation source.
 */
async function protectWheelHierarchy(sourcePath, protectedPath) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(sourcePath);
  const nodes = document.getRoot().listNodes();

  for (const node of nodes) {
    if (!FAKE_SHADOW.test(node.getName())) continue;
    for (const parent of node.listParents()) {
      if (typeof parent.removeChild === "function") parent.removeChild(node);
    }
    node.dispose();
  }

  const wheels = nodes.filter(
    (node) => !node.isDisposed() && WHEEL_PIVOT.test(node.getName()) && hasMesh(node),
  );
  const steering = nodes.filter(
    (node) => !node.isDisposed() && STEERING_PIVOT.test(node.getName()) && hasMesh(node),
  );

  if (wheels.length !== 4) {
    throw new Error(
      `Expected 4 mesh-bearing wheel pivots in ${sourcePath}, found ${wheels.length}`,
    );
  }

  const rigs = [...wheels, ...steering];
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("buffer");
  const times = document
    .createAccessor("APEX wheel guard times")
    .setType("SCALAR")
    .setArray(new Float32Array([0, 1]))
    .setBuffer(buffer);
  const animation = document.createAnimation("APEX_WHEEL_HIERARCHY_GUARD");

  for (const wheel of rigs) {
    const rotation = wheel.getRotation();
    const rotations = document
      .createAccessor(`APEX wheel guard ${wheel.getName()}`)
      .setType("VEC4")
      .setArray(
        new Float32Array([
          rotation[0],
          rotation[1],
          rotation[2],
          rotation[3],
          rotation[0],
          rotation[1],
          rotation[2],
          rotation[3],
        ]),
      )
      .setBuffer(buffer);
    const sampler = document
      .createAnimationSampler()
      .setInput(times)
      .setOutput(rotations)
      .setInterpolation("STEP");
    const channel = document
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(wheel)
      .setTargetPath("rotation");
    animation.addSampler(sampler).addChannel(channel);
  }

  await io.write(protectedPath, document);
  return rigs.length;
}

async function main() {
  const force = process.argv.includes("--force");

  let sources;
  try {
    sources = (await readdir(SOURCE_DIR)).filter((name) => name.endsWith(".glb")).sort();
  } catch {
    console.error(
      `\n  No source models at ${SOURCE_DIR}\n\n` +
        `  The raw GLBs are git-ignored because they are very large. Drop the\n` +
        `  supplied car model in assets/source/cars/, then re-run:\n` +
        `  npm run assets:optimize\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (sources.length === 0) {
    console.error(`  No .glb files found in ${SOURCE_DIR}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const temporaryDir = await mkdtemp(join(tmpdir(), "apex-assets-"));

  console.log(
    `\n  APEX asset pipeline — ${sources.length} model(s) × ${VARIANTS.length} variants\n`,
  );

  let totalBefore = 0;
  let totalAfter = 0;
  let overBudget = 0;
  let skipped = 0;

  for (const name of sources) {
    const sourcePath = join(SOURCE_DIR, name);
    const before = await fileSize(sourcePath);
    if (before === null) continue;
    totalBefore += before;
    let protectedSourcePath = null;

    for (const variant of VARIANTS) {
      const outputName = `${runtimeName(name)}${variant.suffix}.glb`;
      const outputPath = join(OUTPUT_DIR, outputName);

      if (!force && (await isUpToDate(sourcePath, outputPath))) {
        const existing = await fileSize(outputPath);
        console.log(
          `  = ${outputName.padEnd(18)} up to date  ${formatBytes(existing ?? 0)}`,
        );
        totalAfter += existing ?? 0;
        skipped += 1;
        continue;
      }

      process.stdout.write(
        `  → ${outputName.padEnd(18)} ${formatBytes(before).padStart(9)} … `,
      );
      const startedAt = Date.now();

      try {
        if (!protectedSourcePath) {
          protectedSourcePath = join(temporaryDir, name);
          await protectWheelHierarchy(sourcePath, protectedSourcePath);
        }

        await execFileAsync(
          "npx",
          [
            "gltf-transform",
            "optimize",
            protectedSourcePath,
            outputPath,
            ...argsFor(variant),
          ],
          {
            cwd: ROOT,
            // Draco + WebP encoding on a 37MB model produces a lot of log output.
            maxBuffer: 64 * 1024 * 1024,
          },
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
      const flag =
        after > SIZE_BUDGET ? "  OVER BUDGET" : after > SIZE_WARN ? "  near budget" : "";
      console.log(`${formatBytes(after).padStart(9)}  −${ratio}%  ${seconds}s${flag}`);

      if (after > SIZE_BUDGET) overBudget += 1;
      totalAfter += after;
    }
  }

  await rm(temporaryDir, { recursive: true, force: true });

  console.log(
    `\n  Total ${formatBytes(totalBefore)} source → ${formatBytes(totalAfter)} shipped` +
      (totalBefore > 0
        ? `  (−${((1 - totalAfter / totalBefore) * 100).toFixed(1)}%)`
        : "") +
      (skipped > 0 ? `   [${skipped} skipped]` : ""),
  );

  if (overBudget > 0) {
    console.error(
      `\n  ${overBudget} model(s) exceed the ${formatBytes(SIZE_BUDGET)} budget.\n` +
        `  Try --texture-size 512, or --simplify-ratio 0.6 for a harder cut.\n`,
    );
    process.exitCode = 1;
  } else {
    console.log(`  All models within the ${formatBytes(SIZE_BUDGET)} budget.\n`);
  }
}

await main();
