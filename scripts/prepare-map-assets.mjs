#!/usr/bin/env node
/**
 * Supplied circuit pipeline.
 *
 * - Extracts a deterministic route from the supplied Suzuka GLB.
 * - Measures the real asphalt surface for width and elevation.
 * - Emits synchronous runtime samples consumed by Track.
 * - Optimises the four user-supplied map GLBs for browser delivery.
 * - Ships the CC-BY-4.0 attribution required by every source asset.
 *
 * No route coordinates are authored here. Ordering comes from the road mesh's
 * authored centre row; the drivable corridor, its centre, its width, and its
 * height all come from measuring material `282_69`, the circuit's asphalt.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Matrix4, Quaternion, Vector3 } from "three";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "assets", "source", "maps");
const OUTPUT_DIR = join(ROOT, "public", "models", "maps");
const ROUTE_PATH = join(ROOT, "src", "game", "track", "generated", "suzuka-route.json");
const CIRCUIT_SOURCE = join(SOURCE_DIR, "suzuka_circuit_2001_layout.glb");

const TARGET_SAMPLE_SPACING = 2.5;
/** Node/material carrying the authored centre row used only for ordering. */
const GUIDE_NODE = "Object_121";
const GUIDE_MATERIAL = "282_94";
/** Material of the circuit's drivable asphalt, measured for the corridor. */
const ASPHALT_MATERIAL = "282_69";

/** Lateral scan resolution and reach, metres. */
const SCAN_STEP = 0.25;
const SCAN_REACH = 11;
/** Vertical continuity tolerance while walking outward across the surface. */
const SCAN_RISE = 0.55;
/** Height search tolerance when probing the surface under a point. */
const PROBE_TOLERANCE = 3;
/** Bounds on the emitted drivable half-width, metres. */
const MIN_HALF_WIDTH = 3.2;
const MAX_HALF_WIDTH = 8.5;

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const MAPS = [
  {
    source: "suzuka_circuit_2001_layout.glb",
    output: "suzuka.glb",
    textureSize: "1024",
    simplifyError: "0.0015",
    budget: 18 * 1024 * 1024,
  },
  {
    source: "starting_line.glb",
    output: "starting-line.glb",
    textureSize: "1024",
    simplifyError: "0.001",
    budget: 4 * 1024 * 1024,
  },
  {
    source: "finish_line.glb",
    output: "finish-line.glb",
    textureSize: "512",
    simplifyError: "0.001",
    budget: 3 * 1024 * 1024,
  },
  {
    source: "tyre_barrier_single_model_from_asset_pack.glb",
    output: "tyre-barrier.glb",
    textureSize: "512",
    simplifyError: "0.002",
    budget: 3 * 1024 * 1024,
  },
];

const ATTRIBUTION = `APEX supplied map assets — CC-BY-4.0 attribution

Suzuka Circuit 2001 layout
This work is based on "Suzuka Circuit 2001 layout"
https://sketchfab.com/3d-models/suzuka-circuit-2001-layout-0b1085d93dfa4e81aab2c83c26bf185b
by Dave Bored SketchFab (https://sketchfab.com/Tyler_Dave), licensed under CC-BY-4.0.

Starting Line
This work is based on "Starting Line"
https://sketchfab.com/3d-models/starting-line-ecb35b3e5b424f9dbf54174e6c5907de
by Anthony Yanez (https://sketchfab.com/paulyanez), licensed under CC-BY-4.0.

Finish Line
This work is based on "Finish Line"
https://sketchfab.com/3d-models/finish-line-70aecb6bac234266bdebd22322396caa
by Kemal Çolak (https://sketchfab.com/kemalcolak), licensed under CC-BY-4.0.

Tyre Barrier (Single Model From Asset Pack)
This work is based on "Tyre Barrier (Single Model From Asset Pack)"
https://sketchfab.com/3d-models/tyre-barrier-single-model-from-asset-pack-21d2ff0e4e0c4c709b884a152ee8aa88
by Cherk (https://sketchfab.com/alex20010804), licensed under CC-BY-4.0.

License: https://creativecommons.org/licenses/by/4.0/
`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function round(value, places = 5) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// ----------------------------------------------------------------- glTF access

function parseGlb(bytes) {
  invariant(bytes.readUInt32LE(0) === GLB_MAGIC, "Source is not a binary glTF");
  invariant(bytes.readUInt32LE(4) === 2, "Only glTF 2.0 is supported");

  let json = null;
  let binary = null;
  let offset = 12;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      json = JSON.parse(data.toString("utf8").replace(/\u0000+$/g, "").trim());
    } else if (type === BIN_CHUNK) {
      binary = data;
    }
    offset += 8 + length;
  }

  invariant(json, "GLB has no JSON chunk");
  invariant(binary, "GLB has no binary chunk");
  return { json, binary };
}

const COMPONENT_READERS = {
  5120: { size: 1, read: (view, offset) => view.getInt8(offset) },
  5121: { size: 1, read: (view, offset) => view.getUint8(offset) },
  5122: { size: 2, read: (view, offset) => view.getInt16(offset, true) },
  5123: { size: 2, read: (view, offset) => view.getUint16(offset, true) },
  5125: { size: 4, read: (view, offset) => view.getUint32(offset, true) },
  5126: { size: 4, read: (view, offset) => view.getFloat32(offset, true) },
};

const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(json, binary, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  invariant(
    accessor && accessor.bufferView !== undefined,
    `Accessor ${accessorIndex} has no buffer view`,
  );
  invariant(!accessor.sparse, `Sparse accessor ${accessorIndex} is not supported`);
  const bufferView = json.bufferViews[accessor.bufferView];
  invariant(
    bufferView && (bufferView.buffer ?? 0) === 0,
    "Only the GLB binary buffer is supported",
  );

  const component = COMPONENT_READERS[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  invariant(component && components, `Unsupported accessor ${accessorIndex}`);

  const stride = bufferView.byteStride ?? component.size * components;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const values = new Float64Array(accessor.count * components);

  for (let i = 0; i < accessor.count; i += 1) {
    const base = start + i * stride;
    for (let c = 0; c < components; c += 1) {
      values[i * components + c] = component.read(view, base + c * component.size);
    }
  }

  return { values, count: accessor.count, components };
}

function worldMatrices(json) {
  const parents = new Array(json.nodes.length).fill(-1);
  for (let parent = 0; parent < json.nodes.length; parent += 1) {
    for (const child of json.nodes[parent].children ?? []) parents[child] = parent;
  }

  const cache = new Map();
  const resolveNode = (index) => {
    const cached = cache.get(index);
    if (cached) return cached;

    const node = json.nodes[index];
    const local = new Matrix4();
    if (node.matrix) {
      local.fromArray(node.matrix);
    } else {
      local.compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      );
    }

    const parent = parents[index];
    const world = parent >= 0 ? local.clone().premultiply(resolveNode(parent)) : local;
    cache.set(index, world);
    return world;
  };

  return json.nodes.map((_, index) => resolveNode(index));
}

// ------------------------------------------------------------- surface probing

/**
 * Horizontal triangles of one material, indexed on an XZ grid.
 *
 * `heightAt` answers "what is the road surface directly under this point,
 * nearest to this reference height" — which is what makes the figure-eight
 * overpass safe to measure.
 */
class SurfaceIndex {
  constructor(triangles, cellSize = 4) {
    this.triangles = triangles;
    this.cellSize = cellSize;
    this.cells = new Map();

    for (let t = 0; t < triangles.length / 9; t += 1) {
      const o = t * 9;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < 3; v += 1) {
        const x = triangles[o + v * 3];
        const z = triangles[o + v * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const x0 = Math.floor(minX / cellSize);
      const x1 = Math.floor(maxX / cellSize);
      const z0 = Math.floor(minZ / cellSize);
      const z1 = Math.floor(maxZ / cellSize);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cz = z0; cz <= z1; cz += 1) {
          const key = cx * 100003 + cz;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(t);
        }
      }
    }
  }

  get triangleCount() {
    return this.triangles.length / 9;
  }

  heightAt(x, z, referenceY, tolerance = PROBE_TOLERANCE) {
    const key =
      Math.floor(x / this.cellSize) * 100003 + Math.floor(z / this.cellSize);
    const candidates = this.cells.get(key);
    if (!candidates) return null;

    const tri = this.triangles;
    let best = null;
    let bestDelta = Infinity;

    for (const t of candidates) {
      const o = t * 9;
      const ax = tri[o];
      const ay = tri[o + 1];
      const az = tri[o + 2];
      const bx = tri[o + 3];
      const by = tri[o + 4];
      const bz = tri[o + 5];
      const cx = tri[o + 6];
      const cy = tri[o + 7];
      const cz = tri[o + 8];

      // Barycentric containment in the XZ plane.
      const v0x = cx - ax;
      const v0z = cz - az;
      const v1x = bx - ax;
      const v1z = bz - az;
      const v2x = x - ax;
      const v2z = z - az;

      const dot00 = v0x * v0x + v0z * v0z;
      const dot01 = v0x * v1x + v0z * v1z;
      const dot02 = v0x * v2x + v0z * v2z;
      const dot11 = v1x * v1x + v1z * v1z;
      const dot12 = v1x * v2x + v1z * v2z;

      const denominator = dot00 * dot11 - dot01 * dot01;
      if (Math.abs(denominator) < 1e-12) continue;

      const u = (dot11 * dot02 - dot01 * dot12) / denominator;
      const v = (dot00 * dot12 - dot01 * dot02) / denominator;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;

      const y = ay + u * (cy - ay) + v * (by - ay);
      const delta = Math.abs(y - referenceY);
      if (delta <= tolerance && delta < bestDelta) {
        bestDelta = delta;
        best = y;
      }
    }

    return best;
  }
}

function collectSurface(json, binary, matrices, materialName) {
  const values = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const normal = new Vector3();

  for (let nodeIndex = 0; nodeIndex < json.nodes.length; nodeIndex += 1) {
    const node = json.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    for (const primitive of json.meshes[node.mesh].primitives) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (json.materials[primitive.material]?.name !== materialName) continue;

      const positions = readAccessor(json, binary, primitive.attributes.POSITION);
      const indices = readAccessor(json, binary, primitive.indices);
      const matrix = matrices[nodeIndex];

      for (let i = 0; i < indices.count; i += 3) {
        const ia = indices.values[i];
        const ib = indices.values[i + 1];
        const ic = indices.values[i + 2];
        a.set(
          positions.values[ia * 3],
          positions.values[ia * 3 + 1],
          positions.values[ia * 3 + 2],
        ).applyMatrix4(matrix);
        b.set(
          positions.values[ib * 3],
          positions.values[ib * 3 + 1],
          positions.values[ib * 3 + 2],
        ).applyMatrix4(matrix);
        c.set(
          positions.values[ic * 3],
          positions.values[ic * 3 + 1],
          positions.values[ic * 3 + 2],
        ).applyMatrix4(matrix);

        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac);
        const area2 = normal.length();
        if (area2 < 1e-9) continue;
        // Drivable surface only: walls and kerb faces are not road.
        if (Math.abs(normal.y / area2) < 0.7) continue;

        values.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    }
  }

  return new SurfaceIndex(Float64Array.from(values));
}

// ------------------------------------------------------------ route extraction

function addAdjacency(adjacency, a, b) {
  let aSet = adjacency.get(a);
  if (!aSet) adjacency.set(a, (aSet = new Set()));
  aSet.add(b);
  let bSet = adjacency.get(b);
  if (!bSet) adjacency.set(b, (bSet = new Set()));
  bSet.add(a);
}

function extractCycles(adjacency) {
  const remaining = new Set(adjacency.keys());
  const cycles = [];

  while (remaining.size > 0) {
    let start = Infinity;
    for (const vertex of remaining) if (vertex < start) start = vertex;

    const cycle = [];
    let previous = -1;
    let current = start;

    do {
      cycle.push(current);
      remaining.delete(current);
      const neighbours = [...(adjacency.get(current) ?? [])].sort((x, y) => x - y);
      invariant(
        neighbours.length === 2,
        `Cycle vertex ${current} has degree ${neighbours.length}`,
      );
      const next = neighbours[0] === previous ? neighbours[1] : neighbours[0];
      previous = current;
      current = next;
      invariant(cycle.length <= adjacency.size + 1, "Cycle traversal did not close");
    } while (current !== start);

    cycles.push(cycle);
  }

  return cycles;
}

function resampleClosed(points, targetSpacing) {
  const cumulative = [0];
  for (let i = 0; i < points.length; i += 1) {
    cumulative.push(cumulative[i] + points[i].distanceTo(points[(i + 1) % points.length]));
  }

  const length = cumulative[cumulative.length - 1];
  const count = Math.max(64, Math.round(length / targetSpacing));
  const spacing = length / count;
  const samples = [];
  let segment = 0;

  for (let i = 0; i < count; i += 1) {
    const distance = i * spacing;
    while (segment + 1 < cumulative.length && cumulative[segment + 1] <= distance) {
      segment += 1;
    }
    const next = (segment + 1) % points.length;
    const segmentLength = cumulative[segment + 1] - cumulative[segment] || 1;
    const t = (distance - cumulative[segment]) / segmentLength;
    samples.push(points[segment].clone().lerp(points[next], t));
  }

  return { samples, length, spacing };
}

function frameAt(points, spacing, index, window = 3) {
  const n = points.length;
  const previous = points[(index - window + n) % n];
  const next = points[(index + window) % n];
  let fx = next.x - previous.x;
  let fz = next.z - previous.z;
  const horizontal = Math.hypot(fx, fz) || 1;
  fx /= horizontal;
  fz /= horizontal;

  const before = points[(index - window * 2 + n) % n];
  const after = points[(index + window * 2) % n];
  const previousHeading = Math.atan2(
    points[index].x - before.x,
    points[index].z - before.z,
  );
  const nextHeading = Math.atan2(after.x - points[index].x, after.z - points[index].z);
  let delta = nextHeading - previousHeading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  return {
    fx,
    fz,
    rx: fz,
    rz: -fx,
    heading: Math.atan2(fx, fz),
    curvature: delta / (spacing * window * 2),
    slope: (next.y - previous.y) / horizontal,
  };
}

/** Walk outward across the asphalt until the surface stops being continuous. */
function scanEdge(surface, point, rx, rz, startY) {
  let previousY = startY;
  let reached = 0;

  for (let distance = SCAN_STEP; distance <= SCAN_REACH; distance += SCAN_STEP) {
    const y = surface.heightAt(
      point.x + rx * distance,
      point.z + rz * distance,
      previousY,
      SCAN_RISE,
    );
    if (y === null) break;
    previousY = y;
    reached = distance;
  }

  return { distance: reached, edgeY: previousY };
}

function measureCorridor(surface, points, spacing) {
  const n = points.length;
  const measurements = new Array(n);

  for (let i = 0; i < n; i += 1) {
    const point = points[i];
    const frame = frameAt(points, spacing, i);
    const centreY = surface.heightAt(point.x, point.z, point.y, PROBE_TOLERANCE);
    if (centreY === null) {
      measurements[i] = null;
      continue;
    }

    const right = scanEdge(surface, point, frame.rx, frame.rz, centreY);
    const left = scanEdge(surface, point, -frame.rx, -frame.rz, centreY);
    measurements[i] = {
      frame,
      centreY,
      right: right.distance,
      left: left.distance,
      rightY: right.edgeY,
      leftY: left.edgeY,
    };
  }

  return measurements;
}

/** Fill unmeasured samples from their nearest measured neighbours, cyclically. */
function fillGaps(measurements, key) {
  const n = measurements.length;
  const values = measurements.map((m) => (m ? m[key] : null));
  const filled = values.slice();

  for (let i = 0; i < n; i += 1) {
    if (values[i] !== null) continue;
    let back = 1;
    while (back < n && values[(i - back + n) % n] === null) back += 1;
    let forward = 1;
    while (forward < n && values[(i + forward) % n] === null) forward += 1;
    const a = values[(i - back + n) % n];
    const b = values[(i + forward) % n];
    invariant(a !== null || b !== null, "No measured samples to interpolate from");
    if (a === null) filled[i] = b;
    else if (b === null) filled[i] = a;
    else filled[i] = a + ((b - a) * back) / (back + forward);
  }

  return filled;
}

function smoothClosed(values, passes) {
  const n = values.length;
  let current = values.slice();
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Array(n);
    for (let i = 0; i < n; i += 1) {
      next[i] = (current[(i - 1 + n) % n] + 2 * current[i] + current[(i + 1) % n]) / 4;
    }
    current = next;
  }
  return current;
}

function selectStart(points, spacing) {
  const frames = points.map((_, index) => frameAt(points, spacing, index));
  const straight = frames.map(
    (frame) => Math.abs(frame.curvature) < 0.0025 && Math.abs(frame.slope) < 0.07,
  );
  const n = straight.length;
  let bestStart = 0;
  let bestLength = 0;
  let runStart = 0;
  let runLength = 0;

  for (let i = 0; i < n * 2; i += 1) {
    if (straight[i % n]) {
      if (runLength === 0) runStart = i;
      runLength = Math.min(runLength + 1, n);
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
      }
    } else {
      runLength = 0;
    }
  }

  if (bestLength > 0) return (bestStart + Math.floor(bestLength / 2)) % n;

  const window = Math.max(1, Math.round(80 / spacing));
  let bestIndex = 0;
  let bestScore = Infinity;
  for (let i = 0; i < n; i += 1) {
    let score = 0;
    for (let offset = -window; offset <= window; offset += 1) {
      const frame = frames[(i + offset + n) % n];
      score += Math.abs(frame.curvature) + Math.abs(frame.slope) * 0.002;
    }
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Ordered closed guide loop from the road mesh's authored centre row. */
function extractGuideLoop(json, binary, matrices) {
  const nodeIndex = json.nodes.findIndex((node) => node.name === GUIDE_NODE);
  invariant(nodeIndex >= 0, `Could not find ${GUIDE_NODE}`);
  const node = json.nodes[nodeIndex];
  invariant(node.mesh !== undefined, `${GUIDE_NODE} has no mesh`);
  const mesh = json.meshes[node.mesh];
  invariant(mesh.primitives.length === 1, `${GUIDE_NODE} must contain one primitive`);
  const primitive = mesh.primitives[0];
  invariant(
    json.materials[primitive.material]?.name === GUIDE_MATERIAL,
    `${GUIDE_NODE} no longer uses material ${GUIDE_MATERIAL}`,
  );

  const positions = readAccessor(json, binary, primitive.attributes.POSITION);
  const uvs = readAccessor(json, binary, primitive.attributes.TEXCOORD_0);
  const indices = readAccessor(json, binary, primitive.indices);

  const welded = [];
  const weldedForSource = new Array(positions.count);
  const weldedUvs = [];
  const positionMap = new Map();

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.values[i * 3];
    const y = positions.values[i * 3 + 1];
    const z = positions.values[i * 3 + 2];
    const key = `${x}|${y}|${z}`;
    let index = positionMap.get(key);
    if (index === undefined) {
      index = welded.length;
      positionMap.set(key, index);
      welded.push(new Vector3(x, y, z));
      weldedUvs.push(new Set());
    }
    weldedForSource[i] = index;
    weldedUvs[index].add(uvs.values[i * 2]);
  }

  const allEdges = new Map();
  for (let i = 0; i < indices.count; i += 3) {
    const a = weldedForSource[indices.values[i]];
    const b = weldedForSource[indices.values[i + 1]];
    const c = weldedForSource[indices.values[i + 2]];
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      allEdges.set(edgeKey(from, to), [from, to]);
    }
  }

  const uCounts = new Map();
  for (let i = 0; i < uvs.count; i += 1) {
    const u = uvs.values[i * 2];
    uCounts.set(u, (uCounts.get(u) ?? 0) + 1);
  }
  const centreU = [...uCounts]
    .filter(([u, count]) => u > 0.1 && u < 0.9 && count > 1000)
    .sort((a, b) => Math.abs(a[0] - 0.5) - Math.abs(b[0] - 0.5))[0]?.[0];
  invariant(centreU !== undefined, "Could not identify the authored centre row");

  const centreVertices = new Set();
  for (let i = 0; i < weldedUvs.length; i += 1) {
    if (weldedUvs[i].has(centreU)) centreVertices.add(i);
  }

  const adjacency = new Map();
  for (const [a, b] of allEdges.values()) {
    if (centreVertices.has(a) && centreVertices.has(b)) addAdjacency(adjacency, a, b);
  }

  const cycles = extractCycles(adjacency).sort((a, b) => b.length - a.length);
  invariant(cycles.length >= 1, "Authored centre row did not form a cycle");

  const matrix = matrices[nodeIndex];
  return cycles[0].map((index) => welded[index].clone().applyMatrix4(matrix));
}

async function extractRoute() {
  const { json, binary } = parseGlb(await readFile(CIRCUIT_SOURCE));
  const matrices = worldMatrices(json);

  const surface = collectSurface(json, binary, matrices, ASPHALT_MATERIAL);
  invariant(
    surface.triangleCount > 10000,
    `Asphalt material ${ASPHALT_MATERIAL} yielded only ${surface.triangleCount} triangles`,
  );

  const guide = extractGuideLoop(json, binary, matrices);
  const guideResampled = resampleClosed(guide, TARGET_SAMPLE_SPACING);

  // Pass one: recentre the guide inside the measured asphalt corridor.
  const firstPass = measureCorridor(surface, guideResampled.samples, guideResampled.spacing);
  const offsets = smoothClosed(
    fillGaps(
      firstPass.map((m) => (m ? { offset: (m.right - m.left) / 2 } : null)),
      "offset",
    ),
    8,
  );

  const centred = guideResampled.samples.map((point, i) => {
    const frame = frameAt(guideResampled.samples, guideResampled.spacing, i);
    const offset = Math.max(-SCAN_REACH, Math.min(SCAN_REACH, offsets[i]));
    return new Vector3(
      point.x + frame.rx * offset,
      point.y,
      point.z + frame.rz * offset,
    );
  });

  let points = resampleClosed(centred, TARGET_SAMPLE_SPACING).samples;
  const startIndex = selectStart(points, TARGET_SAMPLE_SPACING);
  points = [...points.slice(startIndex), ...points.slice(0, startIndex)];

  // One canonical forward direction so generated data is reproducible.
  const startFrame = frameAt(points, TARGET_SAMPLE_SPACING, 0);
  if (startFrame.fz < 0 || (Math.abs(startFrame.fz) < 1e-8 && startFrame.fx < 0)) {
    points = [points[0], ...points.slice(1).reverse()];
  }

  const finalResampled = resampleClosed(points, TARGET_SAMPLE_SPACING);
  points = finalResampled.samples;

  // Pass two: measure the corridor and surface height on the final centreline.
  const secondPass = measureCorridor(surface, points, finalResampled.spacing);
  const measuredCount = secondPass.filter(Boolean).length;
  invariant(
    measuredCount / secondPass.length > 0.95,
    `Only ${measuredCount}/${secondPass.length} samples found asphalt beneath them`,
  );

  const halfWidths = smoothClosed(
    fillGaps(
      secondPass.map((m) =>
        m ? { halfWidth: Math.min(m.left, m.right) + SCAN_STEP * 0.5 } : null,
      ),
      "halfWidth",
    ),
    6,
  );
  const surfaceY = smoothClosed(
    fillGaps(
      secondPass.map((m, i) => ({ y: m ? m.centreY : points[i].y })),
      "y",
    ),
    2,
  );
  const crossfall = smoothClosed(
    fillGaps(
      secondPass.map((m) => {
        if (!m) return null;
        const span = m.left + m.right || 1;
        return { bank: Math.atan2(m.rightY - m.leftY, span) };
      }),
      "bank",
    ),
    6,
  );

  const samples = [];
  const widthValues = [];
  for (let i = 0; i < points.length; i += 1) {
    const halfWidth = Math.max(MIN_HALF_WIDTH, Math.min(MAX_HALF_WIDTH, halfWidths[i]));
    widthValues.push(halfWidth);
    samples.push([
      round(points[i].x),
      round(surfaceY[i]),
      round(points[i].z),
      round(halfWidth),
      round(Math.max(-0.12, Math.min(0.12, crossfall[i])), 6),
    ]);
  }

  const xs = samples.map((s) => s[0]);
  const ys = samples.map((s) => s[1]);
  const zs = samples.map((s) => s[2]);
  const output = {
    sourceAsset: "assets/source/maps/suzuka_circuit_2001_layout.glb",
    guideNode: GUIDE_NODE,
    asphaltMaterial: ASPHALT_MATERIAL,
    extraction:
      "authored centre row recentred and measured against the circuit asphalt surface",
    sampleSpacing: round(finalResampled.spacing, 8),
    length: round(finalResampled.length, 5),
    bounds: {
      min: [round(Math.min(...xs)), round(Math.min(...ys)), round(Math.min(...zs))],
      max: [round(Math.max(...xs)), round(Math.max(...ys)), round(Math.max(...zs))],
    },
    halfWidthRange: [round(Math.min(...widthValues)), round(Math.max(...widthValues))],
    measuredSamples: measuredCount,
    samples,
  };

  invariant(
    output.length > 5000 && output.length < 6500,
    `Unexpected route length ${output.length}m`,
  );
  invariant(output.samples.length > 2000, "Route sample count is unexpectedly low");
  invariant(
    output.halfWidthRange[0] >= MIN_HALF_WIDTH,
    `Route pinches to ${output.halfWidthRange[0]}m half-width`,
  );

  await mkdir(dirname(ROUTE_PATH), { recursive: true });
  await writeFile(ROUTE_PATH, `${JSON.stringify(output)}\n`);

  const mean = widthValues.reduce((sum, v) => sum + v, 0) / widthValues.length;
  console.log(
    `  route  ${output.samples.length.toLocaleString("en-US")} samples, ` +
      `${(output.length / 1000).toFixed(3)} km, half-width ` +
      `${output.halfWidthRange[0].toFixed(2)}–${output.halfWidthRange[1].toFixed(2)} m ` +
      `(mean ${mean.toFixed(2)} m), asphalt triangles ${surface.triangleCount.toLocaleString("en-US")}`,
  );
}

// ------------------------------------------------------------ map optimisation

async function isUpToDate(sourcePath, outputPath) {
  try {
    const [source, output] = await Promise.all([stat(sourcePath), stat(outputPath)]);
    return output.mtimeMs > source.mtimeMs;
  } catch {
    return false;
  }
}

async function optimiseMaps(force) {
  for (const map of MAPS) {
    const sourcePath = join(SOURCE_DIR, map.source);
    const outputPath = join(OUTPUT_DIR, map.output);
    const before = (await stat(sourcePath)).size;

    if (!force && (await isUpToDate(sourcePath, outputPath))) {
      const after = (await stat(outputPath)).size;
      console.log(`  = ${map.output.padEnd(20)} up to date  ${formatBytes(after)}`);
      continue;
    }

    process.stdout.write(`  → ${map.output.padEnd(20)} ${formatBytes(before).padStart(9)} … `);
    const startedAt = Date.now();
    try {
      await execFileAsync(
        "npx",
        [
          "gltf-transform",
          "optimize",
          sourcePath,
          outputPath,
          "--compress",
          "draco",
          "--texture-compress",
          "webp",
          "--texture-size",
          map.textureSize,
          "--flatten",
          "true",
          "--join",
          "true",
          "--simplify",
          "true",
          "--simplify-error",
          map.simplifyError,
          "--weld",
          "true",
          "--prune",
          "true",
          "--prune-solid-textures",
          "true",
          "--palette",
          "true",
          "--palette-min",
          "2",
          "--instance",
          "true",
        ],
        { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 },
      );
    } catch (error) {
      process.stdout.write("FAILED\n");
      throw new Error(error.stderr || error.message, { cause: error });
    }

    const after = (await stat(outputPath)).size;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const reduction = ((1 - after / before) * 100).toFixed(1);
    const warning = after > map.budget ? "  OVER BUDGET" : "";
    console.log(`${formatBytes(after).padStart(9)}  −${reduction}%  ${elapsed}s${warning}`);
    invariant(after <= map.budget, `${map.output} exceeds its ${formatBytes(map.budget)} budget`);
  }
}

async function main() {
  const force = process.argv.includes("--force");
  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log("\n  APEX supplied-map pipeline\n");
  await extractRoute();
  await optimiseMaps(force);
  await writeFile(join(OUTPUT_DIR, "ATTRIBUTION.txt"), ATTRIBUTION);
  console.log(`\n  attribution  ${join("public", "models", "maps", "ATTRIBUTION.txt")}\n`);
}

await main();
