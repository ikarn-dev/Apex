#!/usr/bin/env node
/**
 * Compact report on the shipped car models.
 *
 * `gltf-transform inspect` prints hundreds of rows per model; this prints the
 * four numbers that decide whether the game runs well:
 *
 *   size        — download cost, budget 2.5MB
 *   primitives  — draw calls per car, and the field has up to six cars
 *   vertices    — vertex shader work
 *   textures    — VRAM, the usual mobile ceiling
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = join(ROOT, "public", "models", "cars");

/** Draw calls per car. Six cars on track has to stay inside the frame budget. */
const PRIMITIVE_WARN = 60;
const SIZE_BUDGET = 2.5 * 1024 * 1024;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

  let files;
  try {
    files = (await readdir(MODELS_DIR)).filter((n) => n.endsWith(".glb")).sort();
  } catch {
    console.error(
      `  No optimised models at ${MODELS_DIR}\n  Run: npm run assets:optimize\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n  ${"model".padEnd(14)}${"size".padStart(10)}${"prims".padStart(8)}` +
      `${"verts".padStart(10)}${"textures".padStart(10)}${"vram".padStart(10)}\n` +
      `  ${"-".repeat(60)}`,
  );

  let warnings = 0;

  for (const name of files) {
    const path = join(MODELS_DIR, name);
    const size = (await stat(path)).size;
    const document = await io.read(path);
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
    // Uncompressed RGBA in VRAM, plus a third again for the mip chain.
    const vram = textures.reduce((total, texture) => {
      const [w, h] = texture.getSize() ?? [0, 0];
      return total + w * h * 4 * 1.33;
    }, 0);

    const flags = [];
    if (size > SIZE_BUDGET) flags.push("OVER SIZE BUDGET");
    if (primitives > PRIMITIVE_WARN) flags.push(`${primitives} draw calls`);
    if (flags.length > 0) warnings += 1;

    console.log(
      `  ${name.padEnd(14)}${formatBytes(size).padStart(10)}` +
        `${String(primitives).padStart(8)}${vertices.toLocaleString("en-US").padStart(10)}` +
        `${String(textures.length).padStart(10)}${formatBytes(vram).padStart(10)}` +
        (flags.length > 0 ? `   ${flags.join(", ")}` : ""),
    );
  }

  console.log();
  if (warnings > 0) {
    console.log(
      `  ${warnings} model(s) flagged. Above ~${PRIMITIVE_WARN} primitives per car,\n` +
        `  a six-car field starts costing more in draw calls than in pixels.\n`,
    );
  } else {
    console.log(`  All models within size and draw-call budgets.\n`);
  }
}

await main();
