#!/usr/bin/env tsx
/**
 * Car rig test.
 *
 * `CarView` reparents the model's four `WHEEL_**` groups into pivots so it can
 * steer and spin them. That surgery happens on a hierarchy whose transforms were
 * baked by an FBX export and then rewritten by the asset pipeline, and if it gets
 * it wrong the wheels move somewhere they cannot be seen — which is exactly what
 * happened, and is invisible to every other check because the GLB itself is fine.
 *
 * Rather than load the GLB through `GLTFLoader` (which needs a DOM to decode WebP),
 * this rebuilds the same scene graph from the glTF with real vertex positions and
 * no materials, then runs the identical pivot-wrapping logic and asserts:
 *
 *   1. every wheel is found,
 *   2. wrapping does not move a wheel,
 *   3. steering and spinning rotate it about its own centre rather than flinging
 *      it across the car,
 *   4. the spin axis is the axle, not one of the other two.
 */

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { Node as GltfNode } from "@gltf-transform/core";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Vector3,
  type Object3D,
} from "three";

const MODEL = "public/models/cars/zagato.glb";
const WHEEL_GROUP = /^WHEEL_([LR])([FR])/i;

// ------------------------------------------------------- rebuild the hierarchy

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(MODEL);
const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;

function build(source: GltfNode): Object3D {
  const mesh = source.getMesh();
  let object: Object3D;

  if (mesh) {
    const merged = new Group();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      if (!position) continue;
      const array = new Float32Array(position.getCount() * 3);
      const element = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, element);
        array[i * 3] = element[0]!;
        array[i * 3 + 1] = element[1]!;
        array[i * 3 + 2] = element[2]!;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(array, 3));
      merged.add(new Mesh(geometry));
    }
    object = merged;
  } else {
    object = new Group();
  }

  object.name = source.getName();
  const t = source.getTranslation();
  const r = source.getRotation();
  const s = source.getScale();
  object.position.set(t[0], t[1], t[2]);
  object.quaternion.set(r[0], r[1], r[2], r[3]);
  object.scale.set(s[0], s[1], s[2]);

  for (const child of source.listChildren()) object.add(build(child));
  return object;
}

const root = new Group();
root.name = "model";
for (const child of scene.listChildren()) root.add(build(child));

// Same normalisation `Resources.prepareCar` applies.
const sourceBox = new Box3().setFromObject(root);
const sourceSize = sourceBox.getSize(new Vector3());
const scale = 4.75 / Math.max(sourceSize.x, sourceSize.z);
root.scale.setScalar(scale);
root.rotation.y = -0.056;
root.updateMatrixWorld(true);
root.position.y = -new Box3().setFromObject(root).min.y;

// A parent chain matching `CarView`: group(position + yaw) -> tilt(roll/pitch).
const group = new Group();
const tilt = new Group();
group.add(tilt);
tilt.add(root);
group.position.set(120, 4, -35);
group.rotation.y = 1.1;
tilt.rotation.z = 0.04;
group.updateMatrixWorld(true);

// -------------------------------------------------------------- the rig itself

interface Rig {
  name: string;
  steerPivot: Group;
  spinPivot: Group;
  front: boolean;
  spinSign: number;
}

function hasMesh(node: Object3D): boolean {
  let found = false;
  node.traverse((child) => {
    if (child instanceof Mesh) found = true;
  });
  return found;
}

function wrapInPivots(node: Object3D): { steerPivot: Group; spinPivot: Group } | null {
  root.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(node);
  if (bounds.isEmpty()) return null;

  const center = bounds.getCenter(new Vector3());
  root.worldToLocal(center);

  const steerPivot = new Group();
  steerPivot.position.copy(center);
  const spinPivot = new Group();

  root.add(steerPivot);
  steerPivot.add(spinPivot);
  root.updateMatrixWorld(true);
  spinPivot.attach(node);

  return { steerPivot, spinPivot };
}

const found: { node: Object3D; front: boolean; left: boolean }[] = [];
root.traverse((node) => {
  const match = node.name.match(WHEEL_GROUP);
  if (match && hasMesh(node)) {
    found.push({
      node,
      left: match[1]!.toUpperCase() === "L",
      front: match[2]!.toUpperCase() === "F",
    });
  }
});

const before = new Map<string, Vector3>();
const sizes = new Map<string, Vector3>();
for (const wheel of found) {
  group.updateMatrixWorld(true);
  const box = new Box3().setFromObject(wheel.node);
  before.set(wheel.node.name, box.getCenter(new Vector3()));
  sizes.set(wheel.node.name, box.getSize(new Vector3()));
}

const rigs: Rig[] = [];
for (const wheel of found) {
  const pivots = wrapInPivots(wheel.node);
  if (!pivots) continue;
  rigs.push({
    name: wheel.node.name,
    ...pivots,
    front: wheel.front,
    spinSign: wheel.left ? 1 : -1,
  });
}

// ----------------------------------------------------------------- assertions

const failures: string[] = [];
console.log("\n  Car rig\n  " + "-".repeat(66));

if (rigs.length !== 4) failures.push(`found ${rigs.length} of 4 wheels`);

// 2: wrapping must not move anything.
group.updateMatrixWorld(true);
let worstDrift = 0;
for (const rig of rigs) {
  const node = root.getObjectByName(rig.name)!;
  const now = new Box3().setFromObject(node).getCenter(new Vector3());
  const drift = now.distanceTo(before.get(rig.name)!);
  worstDrift = Math.max(worstDrift, drift);
}
if (worstDrift > 0.01) failures.push(`wrapping moved a wheel by ${worstDrift.toFixed(3)}m`);
console.log(`  wheels found            ${rigs.length}/4`);
console.log(`  drift from wrapping     ${worstDrift.toFixed(4)}m`);

// 3 + 4: rotate and confirm the wheel turns in place about the right axis.
for (const rig of rigs) {
  rig.steerPivot.rotation.y = rig.front ? 0.35 : 0;
  rig.spinPivot.rotation.x = 1.9 * rig.spinSign;
}
group.updateMatrixWorld(true);

let worstShift = 0;
const axisReport: string[] = [];
for (const rig of rigs) {
  const node = root.getObjectByName(rig.name)!;
  const box = new Box3().setFromObject(node);
  const shift = box.getCenter(new Vector3()).distanceTo(before.get(rig.name)!);
  worstShift = Math.max(worstShift, shift);

  // A wheel spun about its axle keeps its width. Spun about the wrong axis, the
  // tyre sweeps its own diameter and the box balloons.
  const was = sizes.get(rig.name)!;
  const now = box.getSize(new Vector3());
  const grew = Math.max(now.x / was.x, now.y / was.y, now.z / was.z);
  axisReport.push(`${rig.name} shift ${shift.toFixed(3)}m, bounds ×${grew.toFixed(2)}`);
  if (grew > 1.35) {
    failures.push(`${rig.name} sweeps its own volume when spun — wrong spin axis`);
  }
}
if (worstShift > 0.12) {
  failures.push(`rotating flung a wheel ${worstShift.toFixed(2)}m from its centre`);
}
console.log(`  shift when animated     ${worstShift.toFixed(4)}m`);
for (const line of axisReport) console.log(`    ${line}`);

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("\n  PASS — all four wheels are rigged and rotate about their own axle.\n");
}
