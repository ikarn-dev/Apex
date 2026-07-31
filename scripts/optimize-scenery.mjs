#!/usr/bin/env node
/**
 * Scenery pipeline: three intact trees and the complete supplied landscape.
 *
 * Geometry is not a performance knob here. Earlier tree reduction corrupted leaf
 * cards, and the earlier landscape filter deleted its forest before stretching four
 * remaining terrain sheets into the giant shards visible in-game. Every actual
 * ground, forest, hill, and mountain triangle now survives with unchanged bounds,
 * surface area, and edge lengths. The sole exclusion is Sketchfab's finite preview
 * panorama dome, which is not landscape geometry and otherwise renders as a blue orb.
 *
 * Trees retain their source primitive boundaries. The landscape is different only in
 * draw-call packaging: 3,686 scene objects contain about 35k vertices and share nine
 * environment materials, so they are flattened and joined by material into nine draws.
 * Joining changes neither shape nor shading. Textures are resized/compressed, while
 * geometry stays lossless and is validated before a candidate replaces public/.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Matrix4, Quaternion, Vector3 } from "three";
import { writeAssetManifest } from "./lib/asset-manifest.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TREE_DIR = join(ROOT, "assets", "source", "buildings_trees");
const BG_DIR = join(ROOT, "assets", "source", "bg");
const OUTPUT_DIR = join(ROOT, "public", "models", "env");

/**
 * Safe geometry tolerances for tree encoding.
 *
 * Quantization can move a coordinate by a tiny fraction of the model extent, but it
 * cannot explain a changed primitive/vertex/triangle count, a large bounds shift, or
 * a newly stretched edge. These checks reject the exact failure modes the previous
 * destructive reduction introduced before the candidate GLB is copied to public/.
 */
const BOUNDS_TOLERANCE = 0.01;
const SURFACE_AREA_TOLERANCE = 0.02;
const EDGE_LENGTH_TOLERANCE = 0.02;
const DEGENERATE_FRACTION_TOLERANCE = 0.0005;

const JOBS = [
  {
    label: "tree-conifer.glb",
    source: join(TREE_DIR, "conifer_tree_high-poly", "scene.gltf"),
    output: join(OUTPUT_DIR, "tree-conifer.glb"),
    preservePrimitives: true,
    textureSize: "256",
  },
  {
    label: "tree-poplar.glb",
    source: join(TREE_DIR, "realistic_hd_lombardy_poplar_175", "scene.gltf"),
    output: join(OUTPUT_DIR, "tree-poplar.glb"),
    preservePrimitives: true,
    textureSize: "256",
  },
  {
    label: "tree-poinciana.glb",
    source: join(TREE_DIR, "realistic_hd_royal_poinciana_1740", "scene.gltf"),
    output: join(OUTPUT_DIR, "tree-poinciana.glb"),
    preservePrimitives: true,
    textureSize: "256",
  },
  {
    label: "landscape.glb",
    source: join(BG_DIR, "landscape_forest__mountains", "scene.gltf"),
    output: join(OUTPUT_DIR, "landscape.glb"),
    // Preserve every ground, forest, hill and mountain triangle. The signed
    // Sketchfab preview dome is removed before integrity measurement, then the
    // remaining 3,686 objects are packaged by nine materials for runtime draws.
    preservePrimitives: false,
    textureSize: "512",
  },
];

/** Files a previous version of this pipeline shipped and this one does not. */
const RETIRED = ["trees.glb", "building.glb"];

/**
 * Sketchfab preview panorama embedded beside the actual landscape.
 *
 * This is not environment geometry: it is a finite double-sided sphere carrying a
 * sky equirectangular image. When the complete model is placed ahead of the camera,
 * that preview helper becomes the giant blue orb visible over the circuit. Match
 * its full signed identity so a real terrain mesh can never be removed by accident.
 */
const LANDSCAPE_PREVIEW_DOME = {
  node: "Sphere_Material.011_0",
  material: "Material.011",
  vertices: 559,
  indices: 2_880,
};

function removeLandscapePreviewDome(document, label) {
  if (label !== "landscape.glb") return;

  const matches = document
    .getRoot()
    .listNodes()
    .filter((node) => node.getName() === LANDSCAPE_PREVIEW_DOME.node);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${LANDSCAPE_PREVIEW_DOME.node} preview dome, found ${matches.length}`,
    );
  }

  const node = matches[0];
  const primitives = node.getMesh()?.listPrimitives() ?? [];
  const primitive = primitives[0];
  const vertices = primitive?.getAttribute("POSITION")?.getCount() ?? 0;
  const indices = primitive?.getIndices()?.getCount() ?? 0;
  const material = primitive?.getMaterial()?.getName() ?? "";
  if (
    primitives.length !== 1 ||
    material !== LANDSCAPE_PREVIEW_DOME.material ||
    vertices !== LANDSCAPE_PREVIEW_DOME.vertices ||
    indices !== LANDSCAPE_PREVIEW_DOME.indices
  ) {
    throw new Error(
      `${LANDSCAPE_PREVIEW_DOME.node} no longer matches its signed preview-dome ` +
        `shape (material ${material || "none"}, ${vertices} vertices, ${indices} indices)`,
    );
  }

  for (const parent of node.listParents()) {
    if (typeof parent.removeChild === "function") parent.removeChild(node);
  }
  node.dispose();
  console.log(
    `      removed preview dome ${LANDSCAPE_PREVIEW_DOME.node} ` +
      `(${vertices} verts / ${Math.floor(indices / 3)} tris)`,
  );
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

function localMatrix(node) {
  const translation = node.getTranslation();
  const rotation = node.getRotation();
  const scale = node.getScale();
  return new Matrix4().compose(
    new Vector3(translation[0], translation[1], translation[2]),
    new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
    new Vector3(scale[0], scale[1], scale[2]),
  );
}

/**
 * Measure rendered triangle geometry in world space.
 *
 * Walking scene nodes rather than root.listMeshes() accounts for exporter wrapper
 * transforms and mesh reuse. Measurements therefore remain comparable after the CLI
 * flattens those transforms into vertex data.
 */
function geometrySummary(document) {
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error("model has no scene");

  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const entries = [];
  let primitives = 0;
  let vertices = 0;
  let triangles = 0;

  const element = [0, 0, 0];
  const point = new Vector3();
  const walk = (node, parentMatrix) => {
    const world = parentMatrix.clone().multiply(localMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        if (primitive.getMode() !== 4) {
          throw new Error(`tree primitive uses unsupported mode ${primitive.getMode()}, expected TRIANGLES`);
        }
        const position = primitive.getAttribute("POSITION");
        if (!position) continue;
        const indices = primitive.getIndices()?.getArray() ?? null;
        const triangleCount = Math.floor((indices?.length ?? position.getCount()) / 3);

        primitives += 1;
        vertices += position.getCount();
        triangles += triangleCount;
        entries.push({ position, indices, triangleCount, world: world.clone() });

        for (let index = 0; index < position.getCount(); index += 1) {
          position.getElement(index, element);
          point.set(element[0], element[1], element[2]).applyMatrix4(world);
          min.min(point);
          max.max(point);
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };

  for (const child of scene.listChildren()) walk(child, new Matrix4());
  if (entries.length === 0) throw new Error("model has no triangle geometry");

  const diagonal = Math.max(1e-9, min.distanceTo(max));
  const degenerateArea = diagonal * diagonal * 1e-12;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  let surfaceArea = 0;
  let maxEdge = 0;
  let degenerates = 0;

  const readPoint = (position, index, matrix, target) => {
    position.getElement(index, element);
    return target.set(element[0], element[1], element[2]).applyMatrix4(matrix);
  };

  for (const entry of entries) {
    for (let triangle = 0; triangle < entry.triangleCount; triangle += 1) {
      const offset = triangle * 3;
      const ia = entry.indices ? Number(entry.indices[offset]) : offset;
      const ib = entry.indices ? Number(entry.indices[offset + 1]) : offset + 1;
      const ic = entry.indices ? Number(entry.indices[offset + 2]) : offset + 2;
      readPoint(entry.position, ia, entry.world, a);
      readPoint(entry.position, ib, entry.world, b);
      readPoint(entry.position, ic, entry.world, c);

      maxEdge = Math.max(maxEdge, a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area = ab.cross(ac).length() * 0.5;
      surfaceArea += area;
      if (area <= degenerateArea) degenerates += 1;
    }
  }

  return {
    primitives,
    vertices,
    triangles,
    degenerates,
    surfaceArea,
    maxEdge,
    bounds: { min: min.toArray(), max: max.toArray() },
  };
}

function relativeDifference(before, after) {
  return Math.abs(after - before) / Math.max(Math.abs(before), 1e-9);
}

function boundsDrift(before, after) {
  let worst = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const extent = Math.max(1e-6, before.max[axis] - before.min[axis]);
    worst = Math.max(
      worst,
      Math.abs(after.min[axis] - before.min[axis]) / extent,
      Math.abs(after.max[axis] - before.max[axis]) / extent,
    );
  }
  return worst;
}

/** Reject any candidate whose rendered geometry is not an intact encoding of source. */
function assertGeometryIntegrity(label, source, candidate, preservePrimitives) {
  const failures = [];
  if (preservePrimitives && candidate.primitives !== source.primitives) {
    failures.push(`primitives ${candidate.primitives} != ${source.primitives}`);
  }
  if (candidate.vertices !== source.vertices) {
    failures.push(`vertices ${candidate.vertices} != ${source.vertices}`);
  }
  if (candidate.triangles !== source.triangles) {
    failures.push(`triangles ${candidate.triangles} != ${source.triangles}`);
  }

  const drift = boundsDrift(source.bounds, candidate.bounds);
  const areaDrift = relativeDifference(source.surfaceArea, candidate.surfaceArea);
  const edgeDrift = relativeDifference(source.maxEdge, candidate.maxEdge);
  const addedDegenerates = Math.max(0, candidate.degenerates - source.degenerates);
  const allowedDegenerates = Math.max(
    4,
    Math.ceil(source.triangles * DEGENERATE_FRACTION_TOLERANCE),
  );

  if (drift > BOUNDS_TOLERANCE) {
    failures.push(`bounds moved ${(drift * 100).toFixed(2)}% (limit ${BOUNDS_TOLERANCE * 100}%)`);
  }
  if (areaDrift > SURFACE_AREA_TOLERANCE) {
    failures.push(
      `surface area changed ${(areaDrift * 100).toFixed(2)}% ` +
        `(limit ${SURFACE_AREA_TOLERANCE * 100}%)`,
    );
  }
  if (edgeDrift > EDGE_LENGTH_TOLERANCE) {
    failures.push(
      `longest triangle edge changed ${(edgeDrift * 100).toFixed(2)}% ` +
        `(limit ${EDGE_LENGTH_TOLERANCE * 100}%)`,
    );
  }
  if (addedDegenerates > allowedDegenerates) {
    failures.push(
      `${addedDegenerates} new collapsed triangles (limit ${allowedDegenerates})`,
    );
  }

  const primitiveReport = preservePrimitives
    ? `${source.primitives} prims`
    : `${source.primitives} → ${candidate.primitives} prims (joined only)`;
  console.log(
    `      intact ${primitiveReport} / ${source.vertices.toLocaleString("en-US")} verts / ` +
      `${source.triangles.toLocaleString("en-US")} tris   ` +
      `bounds ${(drift * 100).toFixed(3)}%  area ${(areaDrift * 100).toFixed(3)}%  ` +
      `edge ${(edgeDrift * 100).toFixed(3)}%`,
  );

  if (failures.length > 0) {
    throw new Error(`${label} geometry integrity failed: ${failures.join(", ")}`);
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const temporaryDir = await mkdtemp(join(tmpdir(), "apex-scenery-"));

  console.log(`\n  APEX scenery pipeline — ${JOBS.length} models\n`);

  for (const name of RETIRED) {
    try {
      await unlink(join(OUTPUT_DIR, name));
      console.log(`  − ${name.padEnd(20)} removed (no longer shipped)`);
    } catch {
      // Already gone.
    }
  }

  for (const job of JOBS) {
    const before = await fileSize(job.source);
    if (before === null) {
      console.error(`  ! ${job.label.padEnd(20)} missing source ${job.source}`);
      process.exitCode = 1;
      continue;
    }

    console.log(`  → ${job.label}`);
    const temporaryInput = join(temporaryDir, `${job.label}.gltf`);
    const candidateOutput = join(temporaryDir, `${job.label}.candidate.glb`);

    try {
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
      const document = await io.read(job.source);
      removeLandscapePreviewDome(document, job.label);
      // Integrity starts after removing the signed preview helper, so every actual
      // environment triangle must still survive candidate optimization unchanged.
      const sourceGeometry = geometrySummary(document);

      await io.write(temporaryInput, document);
      await execFileAsync(
        "npx",
        [
          "gltf-transform",
          "optimize",
          temporaryInput,
          candidateOutput,
          // Geometry remains lossless for all four models. Quantization collapsed
          // small foliage triangles in both the tree assets and the full landscape.
          "--compress", "false",
          "--texture-compress", "webp",
          "--texture-size", job.textureSize,
          "--flatten", "true",
          // Trees keep authored primitive boundaries. The landscape is joined by
          // its nine real environment materials after the preview dome is removed,
          // reducing 3,686 objects without changing an environment triangle.
          "--join", job.preservePrimitives ? "false" : "true",
          "--weld", "false",
          "--simplify", "false",
          "--palette", "false",
          "--prune", "true",
          "--prune-solid-textures", "true",
          "--instance", "false",
        ],
        { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      );

      const candidate = await io.read(candidateOutput);
      assertGeometryIntegrity(
        job.label,
        sourceGeometry,
        geometrySummary(candidate),
        job.preservePrimitives,
      );

      // A failed integrity check never replaces the last known-good public asset.
      await copyFile(candidateOutput, job.output);
    } catch (error) {
      console.error(`      FAILED: ${error.stderr || error.message}\n`);
      process.exitCode = 1;
      continue;
    }

    const after = await fileSize(job.output);
    console.log(`      ${formatBytes(before)} source → ${formatBytes(after ?? 0)} shipped\n`);
  }

  await rm(temporaryDir, { recursive: true, force: true });

  const manifest = await writeAssetManifest();
  for (const [url, hash] of Object.entries(manifest)) {
    console.log(`  ${url.padEnd(34)} v=${hash}`);
  }
  console.log("");
}

await main();
