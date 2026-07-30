#!/usr/bin/env node
/**
 * Fail-fast runtime asset report.
 *
 * The two car GLBs are the only 3D payloads a race downloads — the circuit is
 * generated at load, so there is no map asset to check. Budgets cover the costs
 * that actually stall a first frame: download size, draw calls, vertex work,
 * image decode count, and uncompressed texture memory including mipmaps.
 *
 * The rig count is checked too, because a player car that quietly loses its
 * `WHEEL_**` groups during optimisation still looks correct parked on the grid
 * and never turns a wheel once moving.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;

const RIG_NODES = [/^WHEEL_LF/i, /^WHEEL_RF/i, /^WHEEL_LR/i, /^WHEEL_RR/i, /^STEER_HR/i];

/**
 * glTF extensions three.js decodes without a plugin loader.
 *
 * `Resources` deliberately builds a bare `GLTFLoader` — no `DRACOLoader`, no
 * `KTX2Loader` — so anything the pipeline emits has to be on this list. When the
 * two disagreed, every car silently fell back to a blocked-out placeholder box and
 * the only clue was a console line, because a GLTFLoader that is handed a
 * Draco-compressed primitive with no decoder simply rejects.
 */
const NATIVE_EXTENSIONS = new Set([
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "KHR_materials_clearcoat",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_unlit",
  "KHR_materials_volume",
  "KHR_lights_punctual",
  "KHR_texture_basisu",
  "EXT_texture_webp",
  "EXT_meshopt_compression",
]);

const ASSETS = [
  {
    label: "zagato.glb",
    note: "player · rigged",
    path: join(ROOT, "public", "models", "cars", "zagato.glb"),
    rig: RIG_NODES.length,
    budget: { bytes: 3 * MB, primitives: 56, vertices: 90_000, textures: 24, vram: 22 * MB },
  },
  {
    label: "zagato-lq.glb",
    note: "rivals · rig collapsed",
    path: join(ROOT, "public", "models", "cars", "zagato-lq.glb"),
    rig: 0,
    budget: { bytes: 2 * MB, primitives: 34, vertices: 70_000, textures: 24, vram: 12 * MB },
  },
];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(2)} MB`;
}

function overages(asset, cost) {
  const b = asset.budget;
  const failures = [];
  if (cost.bytes > b.bytes) failures.push(`size ${formatBytes(cost.bytes)} > ${formatBytes(b.bytes)}`);
  if (cost.primitives > b.primitives) failures.push(`primitives ${cost.primitives} > ${b.primitives}`);
  if (cost.vertices > b.vertices) {
    failures.push(`vertices ${cost.vertices.toLocaleString("en-US")} > ${b.vertices.toLocaleString("en-US")}`);
  }
  if (cost.textures > b.textures) failures.push(`textures ${cost.textures} > ${b.textures}`);
  if (cost.vram > b.vram) failures.push(`VRAM ${formatBytes(cost.vram)} > ${formatBytes(b.vram)}`);
  if (cost.rig !== asset.rig) failures.push(`rig ${cost.rig} != ${asset.rig} expected`);
  for (const extension of cost.required) {
    if (!NATIVE_EXTENSIONS.has(extension)) {
      failures.push(`requires ${extension}, which the runtime loader cannot decode`);
    }
  }
  return failures;
}

/**
 * Read `extensionsRequired` from the GLB's JSON chunk directly.
 *
 * gltf-transform decodes compression on read, so the parsed Document no longer
 * reports it — the only honest source is the bytes the browser will be handed.
 */
/**
 * The generated manifest must match the bytes on disk.
 *
 * A stale hash is worse than no hash: it re-points the URL at a cache entry for
 * different contents, which is precisely the failure the manifest exists to
 * prevent.
 */
async function checkManifest() {
  const manifestPath = join(ROOT, "src", "game", "config", "generated", "car-assets.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    console.error(`\n  Missing ${manifestPath} — run npm run assets:optimize`);
    return 1;
  }

  let failures = 0;
  for (const asset of ASSETS) {
    const url = `/models/cars/${asset.label}`;
    const expected = manifest.assets?.[url];
    const actual = createHash("sha256")
      .update(await readFile(asset.path))
      .digest("hex")
      .slice(0, 10);

    if (expected !== actual) {
      console.error(
        `  ${asset.label}: manifest says v=${expected ?? "(absent)"} but the file ` +
          `hashes to v=${actual} — run npm run assets:optimize`,
      );
      failures += 1;
    }
  }
  return failures;
}

async function requiredExtensions(path) {
  const bytes = await readFile(path);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  return json.extensionsRequired ?? [];
}

async function main() {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });

  console.log(
    `\n  ${"runtime asset".padEnd(16)}${"size".padStart(9)}${"prims".padStart(7)}` +
      `${"verts".padStart(9)}${"tex".padStart(5)}${"vram".padStart(9)}${"rig".padStart(5)}   note\n` +
      `  ${"-".repeat(78)}`,
  );

  let failures = 0;
  for (const asset of ASSETS) {
    const [file, document] = await Promise.all([stat(asset.path), io.read(asset.path)]);
    const root = document.getRoot();

    let primitives = 0;
    let vertices = 0;
    for (const mesh of root.listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        primitives += 1;
        vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
      }
    }
    const textures = root.listTextures();
    const vram = textures.reduce((total, texture) => {
      const [width, height] = texture.getSize() ?? [0, 0];
      return total + width * height * 4 * 1.33;
    }, 0);
    const rig = RIG_NODES.filter((pattern) =>
      root.listNodes().some((node) => pattern.test(node.getName())),
    ).length;

    const required = await requiredExtensions(asset.path);
    const cost = {
      bytes: file.size,
      primitives,
      vertices,
      textures: textures.length,
      vram,
      rig,
      required,
    };
    const exceeded = overages(asset, cost);
    failures += exceeded.length;

    console.log(
      `  ${asset.label.padEnd(16)}${formatBytes(cost.bytes).padStart(9)}` +
        `${String(cost.primitives).padStart(7)}${cost.vertices.toLocaleString("en-US").padStart(9)}` +
        `${String(cost.textures).padStart(5)}${formatBytes(cost.vram).padStart(9)}` +
        `${String(cost.rig).padStart(5)}   ${asset.note}` +
        (exceeded.length > 0 ? `\n      ${exceeded.join(", ")}` : ""),
    );
  }

  failures += await checkManifest();

  if (failures > 0) {
    console.error(`\n  Runtime asset budgets failed (${failures} overage${failures === 1 ? "" : "s"}).\n`);
    process.exitCode = 1;
  } else {
    console.log(
      "\n  All runtime assets within budget, natively decodable, cache-busted, " +
        "and the player car's rig intact.\n",
    );
  }
}

await main();
