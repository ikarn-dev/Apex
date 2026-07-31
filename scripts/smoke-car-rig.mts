#!/usr/bin/env tsx
/**
 * Car rig and body-envelope test.
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
 *
 * Then, on the same normalised model, it checks the numbers `cars.ts` gives the
 * physics against the car that is actually drawn. `halfWidth` was 1.03m against a
 * 1.21m body, so whenever the simulation pressed the car against a barrier — which
 * it does exactly, to the millimetre — 180mm of the outboard side was inside the
 * wall, and the front wheel on that side disappeared into it. A collision box that
 * is smaller than its model is a rendering bug that looks like a missing mesh, so
 * it is asserted here rather than left to the eye.
 */

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { Node as GltfNode } from "@gltf-transform/core";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type Object3D,
} from "three";
import { CARS, DEFAULT_CAR } from "../src/game/config/cars";
import { rivalLivery } from "../src/game/config/drivers";
import {
  STEERING_RATIO,
  UNRIGGED_BASE_RATIO,
  UNRIGGED_TRACK_RATIO,
  carDetailFor,
} from "../src/game/entities/CarView";

const car = CARS[DEFAULT_CAR];
const MODEL = "public/models/cars/zagato.glb";
const WHEEL_GROUP = /^WHEEL_([LR])([FR])/i;
const TYRE_MATERIAL = /^EXT_WHEEL/i;
const MIN_TYRE_TRIANGLES = 1_800;

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
      const part = new Mesh(geometry);
      part.name = `material:${primitive.getMaterial()?.getName() ?? "(none)"}`;
      part.userData.materialName = primitive.getMaterial()?.getName() ?? "";
      part.userData.triangles = Math.floor(
        (primitive.getIndices()?.getCount() ?? position.getCount()) / 3,
      );
      merged.add(part);
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

// Same normalisation `Resources.prepareCar` applies, driven by the same config the
// game reads so a retune cannot make this test measure a different car.
const sourceBox = new Box3().setFromObject(root);
const sourceSize = sourceBox.getSize(new Vector3());
const scale = car.targetLength / Math.max(sourceSize.x, sourceSize.z);
root.scale.setScalar(scale);
root.rotation.y = car.modelYaw;
root.updateMatrixWorld(true);
root.position.y = -new Box3().setFromObject(root).min.y;

// The drawn car's own footprint, in the car's local frame — measured here, before
// the model is parented under a yawed group, so x is lateral and z is longitudinal
// exactly as `VehicleSim` treats `halfWidth` and `halfLength`.
const envelope = new Box3().setFromObject(root);
const bodyHalfWidth = Math.max(-envelope.min.x, envelope.max.x);
const bodyHalfLength = Math.max(-envelope.min.z, envelope.max.z);

// The wheel envelope, in the same frame. `CarView` needs this to keep a leaning or
// diving car's tyres on the road, and it derives it from the rig's own pivot
// positions — which live in the *model's* frame, at the model's own scale. Getting
// that conversion wrong produced an envelope of 0.014m instead of 1.45m, and the
// compensation it feeds then does nothing at all while looking perfectly plausible
// in the source. Measured here from the drawn geometry so the ratios `CarView` falls
// back to for un-rigged cars are checked too.
let wheelHalfBase = 0;
let wheelHalfTrack = 0;
root.traverse((node) => {
  if (!WHEEL_GROUP.test(node.name)) return;
  const box = new Box3().setFromObject(node);
  if (box.isEmpty()) return;
  const centre = box.getCenter(new Vector3());
  wheelHalfBase = Math.max(wheelHalfBase, Math.abs(centre.z));
  wheelHalfTrack = Math.max(wheelHalfTrack, Math.abs(centre.x));
});

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
  node: Object3D;
  rest: Matrix4;
  centre: Vector3;
  axis: Vector3;
  steerAxis: Vector3;
  front: boolean;
  spinSign: number;
}

/**
 * Pose a rig node exactly as `CarView.poseRig` does.
 *
 * `matrix = T(centre) · R · T(-centre) · rest`, composed from the rest pose every
 * time rather than accumulated.
 */
function poseRig(rig: Rig, rotation: Quaternion): void {
  const pose = new Matrix4().makeRotationFromQuaternion(rotation);
  const moved = rig.centre.clone().applyQuaternion(rotation);
  pose.setPosition(
    rig.centre.x - moved.x,
    rig.centre.y - moved.y,
    rig.centre.z - moved.z,
  );
  rig.node.matrix.multiplyMatrices(pose, rig.rest);
  rig.node.matrixWorldNeedsUpdate = true;
}

function hasMesh(node: Object3D): boolean {
  let found = false;
  node.traverse((child) => {
    if (child instanceof Mesh) found = true;
  });
  return found;
}

/**
 * A wheel's bounding box in the *model's* frame.
 *
 * `Box3.setFromObject` measures an axis-aligned box in world space, and the car in
 * this harness is parked at a 1.1 rad yaw — so the tyre's disc plane is oblique to
 * every world axis and its world AABB is far bigger than the disc. Spinning it then
 * changes that AABB by 25% no matter how perfect the axle is, which is exactly the
 * measurement that made a correct rig look broken and sent a "fix" after it.
 *
 * Measured in the model frame, a wheel spun about its own axle keeps its box.
 */
function boxInModelFrame(node: Object3D): Box3 {
  const box = new Box3();
  const point = new Vector3();
  root.updateMatrixWorld(true);
  node.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const position = child.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position as BufferAttribute, i);
      child.localToWorld(point);
      root.worldToLocal(point);
      box.expandByPoint(point);
    }
  });
  return box;
}

/**
 * Centre and least-variance axis of a subtree's vertices, in the model frame.
 *
 * The model frame, not the node's parent frame, so the same routine can be used to
 * ask "did the disc's plane tilt?" before and after the node is animated.
 */
function measureInModelFrame(
  node: Object3D,
  materialFilter: RegExp | null,
): { centre: Vector3; axis: Vector3 } | null {
  const points: Vector3[] = [];
  const scratch = new Vector3();
  const bounds = new Box3();
  root.updateMatrixWorld(true);

  node.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const position = child.geometry.getAttribute("position");
    if (!position) return;
    if (materialFilter && !materialFilter.test(String(child.userData.materialName))) return;
    child.updateWorldMatrix(true, false);
    const stride = Math.max(1, Math.floor(position.count / 2048));
    for (let i = 0; i < position.count; i += stride) {
      scratch.fromBufferAttribute(position as BufferAttribute, i);
      child.localToWorld(scratch);
      root.worldToLocal(scratch);
      bounds.expandByPoint(scratch);
      points.push(scratch.clone());
    }
  });
  if (points.length < 16 || bounds.isEmpty()) return null;

  const mean = new Vector3();
  for (const point of points) mean.add(point);
  mean.multiplyScalar(1 / points.length);

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const point of points) {
    const dx = point.x - mean.x;
    const dy = point.y - mean.y;
    const dz = point.z - mean.z;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  const trace = xx + yy + zz;
  if (!(trace > 0)) return null;

  const axis = new Vector3(0.3, 0.5, 0.81).normalize();
  const next = new Vector3();
  for (let i = 0; i < 64; i += 1) {
    next.set(
      (trace - xx) * axis.x - xy * axis.y - xz * axis.z,
      -xy * axis.x + (trace - yy) * axis.y - yz * axis.z,
      -xz * axis.x - yz * axis.y + (trace - zz) * axis.z,
    );
    if (next.lengthSq() < 1e-20) return null;
    axis.copy(next).normalize();
  }
  return { centre: bounds.getCenter(new Vector3()), axis };
}

/** Angle between two axes, ignoring sign, in degrees. */
function axisAngle(a: Vector3, b: Vector3): number {
  return (Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
}

/** Measure in a node's own parent frame, which is what `CarView` rigs against. */
function measureInParentFrame(
  node: Object3D,
  materialFilter: RegExp | null,
): { centre: Vector3; axis: Vector3 } | null {
  const parent = node.parent;
  const measured = measureInModelFrame(node, materialFilter);
  if (!measured || !parent) return measured;
  root.updateMatrixWorld(true);
  const rootToParent = new Matrix4()
    .copy(parent.matrixWorld)
    .invert()
    .multiply(root.matrixWorld);
  return {
    centre: measured.centre.clone().applyMatrix4(rootToParent),
    axis: measured.axis.clone().transformDirection(rootToParent).normalize(),
  };
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
/** Model-frame sizes, for the spin-axis check. */
const localSizes = new Map<string, Vector3>();
const tyreSizes = new Map<string, Vector3>();
const tyreTriangles = new Map<string, number>();
for (const wheel of found) {
  group.updateMatrixWorld(true);
  const box = new Box3().setFromObject(wheel.node);
  before.set(wheel.node.name, box.getCenter(new Vector3()));
  sizes.set(wheel.node.name, box.getSize(new Vector3()));
  localSizes.set(wheel.node.name, boxInModelFrame(wheel.node).getSize(new Vector3()));

  const tyreBox = new Box3();
  let triangles = 0;
  wheel.node.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    if (!TYRE_MATERIAL.test(String(child.userData.materialName))) return;
    tyreBox.union(new Box3().setFromObject(child));
    triangles += Number(child.userData.triangles) || 0;
  });
  if (!tyreBox.isEmpty()) tyreSizes.set(wheel.node.name, tyreBox.getSize(new Vector3()));
  tyreTriangles.set(wheel.node.name, triangles);
}

const rigs: Rig[] = [];
const restAxes = new Map<string, Vector3>();
for (const wheel of found) {
  const measured = measureInParentFrame(wheel.node, TYRE_MATERIAL);
  const inModel = measureInModelFrame(wheel.node, TYRE_MATERIAL);
  if (!measured || !inModel) continue;
  restAxes.set(wheel.node.name, inModel.axis);

  const up = new Vector3(0, 1, 0);
  if (wheel.node.parent && wheel.node.parent !== root) {
    root.updateMatrixWorld(true);
    up.transformDirection(
      new Matrix4().copy(wheel.node.parent.matrixWorld).invert().multiply(root.matrixWorld),
    ).normalize();
  }

  rigs.push({
    name: wheel.node.name,
    node: wheel.node,
    rest: wheel.node.matrix.clone(),
    centre: measured.centre,
    axis: measured.axis,
    steerAxis: up,
    front: wheel.front,
    spinSign: wheel.left ? 1 : -1,
  });
  wheel.node.matrixAutoUpdate = false;
}

// ----------------------------------------------------------------- assertions

const failures: string[] = [];
console.log("\n  Car rig\n  " + "-".repeat(66));

if (rigs.length !== 4) failures.push(`found ${rigs.length} of 4 wheels`);

// 2: the rest pose must be an exact identity. `CarView` composes every frame from
// the node's shipped matrix, so posing it with no rotation has to put it back
// precisely where the model had it — otherwise the car creeps as it drives.
for (const rig of rigs) poseRig(rig, new Quaternion());
group.updateMatrixWorld(true);
let worstDrift = 0;
for (const rig of rigs) {
  const now = new Box3().setFromObject(rig.node).getCenter(new Vector3());
  worstDrift = Math.max(worstDrift, now.distanceTo(before.get(rig.name)!));
}
if (worstDrift > 0.001) {
  failures.push(`the rest pose moved a wheel by ${worstDrift.toFixed(4)}m`);
}
console.log(`  wheels found            ${rigs.length}/4`);
console.log(`  rest pose drift         ${worstDrift.toFixed(5)}m`);

// 4: spinning must not tilt the tyre's plane. This is the assertion that says "it
// is turning about its own axle": a disc rotated about its axis has the same axis
// afterwards, and one rotated about anything else does not.
//
// Bounding boxes were the previous measure and they are a poor one — a world-space
// AABB of a wheel on a car parked at a 1.1 rad yaw changes by 25% under a perfectly
// correct spin, purely because the disc is oblique to the world axes. That reading
// made a working rig look broken and a wrong "fix" look right.
const spinReport: string[] = [];
for (const rig of rigs) {
  poseRig(rig, new Quaternion().setFromAxisAngle(rig.axis, 1.9 * rig.spinSign));
}
group.updateMatrixWorld(true);
for (const rig of rigs) {
  const now = measureInModelFrame(rig.node, TYRE_MATERIAL);
  const was = restAxes.get(rig.name)!;
  const tilt = now ? axisAngle(was, now.axis) : 90;
  const was2 = localSizes.get(rig.name)!;
  const size = boxInModelFrame(rig.node).getSize(new Vector3());
  const grew = Math.max(size.x / was2.x, size.y / was2.y, size.z / was2.z);
  spinReport.push(
    `${rig.name} axle tilt ${tilt.toFixed(3)}°, model bounds ×${grew.toFixed(3)}`,
  );
  if (tilt > 0.5) {
    failures.push(
      `${rig.name} tilts its axle ${tilt.toFixed(2)}° when spun — it is coning out of ` +
        `plane rather than rotating in it`,
    );
  }
}

// 3: steering on top of that must still not fling the wheel across the car.
for (const rig of rigs) {
  const rotation = new Quaternion().setFromAxisAngle(rig.axis, 1.9 * rig.spinSign);
  if (rig.front) {
    rotation.premultiply(new Quaternion().setFromAxisAngle(rig.steerAxis, 0.35));
  }
  poseRig(rig, rotation);
}
group.updateMatrixWorld(true);

let worstShift = 0;
const axisReport: string[] = [];
for (const rig of rigs) {
  const box = new Box3().setFromObject(rig.node);
  const shift = box.getCenter(new Vector3()).distanceTo(before.get(rig.name)!);
  worstShift = Math.max(worstShift, shift);
  axisReport.push(`${rig.name} centre moved ${(shift * 1000).toFixed(1)}mm under full lock`);
}
if (worstShift > 0.12) {
  failures.push(`rotating flung a wheel ${worstShift.toFixed(2)}m from its centre`);
}
for (const line of spinReport) console.log(`    ${line}`);
console.log(`  shift when animated     ${worstShift.toFixed(4)}m`);
for (const line of axisReport) console.log(`    ${line}`);

// ------------------------------------------------------------- steering column

/**
 * The steering wheel has to turn in its own plane too, and it is the part most
 * likely not to: the column is raked, so its axis is nowhere near a model axis, and
 * the view multiplies the road-wheel angle by 8 before applying it. A wrong axis is
 * invisible at speed — the lock available at 94m/s moves the rim 4.6° — and then
 * throws the steering wheel out of the dashboard the moment the car stops and full
 * lock becomes available.
 */
const steering = root.getObjectByName("STEER_HR_231");
if (!steering) {
  failures.push("STEER_HR_231 is missing — the steering wheel cannot be driven");
} else {
  const restPlane = measureInModelFrame(steering, null);
  const inParent = measureInParentFrame(steering, null);
  if (!restPlane || !inParent) {
    failures.push("the steering wheel's rotation axis could not be measured");
  } else {
    const rig: Rig = {
      name: steering.name,
      node: steering,
      rest: steering.matrix.clone(),
      centre: inParent.centre,
      axis: inParent.axis,
      steerAxis: new Vector3(0, 1, 0),
      front: false,
      spinSign: 1,
    };
    steering.matrixAutoUpdate = false;

    // Full lock at a standstill, times the ratio the view uses. This is the case
    // that matters: the lock available at 94m/s turns the rim 4.6°, so a wrong axis
    // is invisible until the car stops and the full 0.42rad becomes available.
    const fullLock = -car.tuning.steerAngleMax * STEERING_RATIO;
    const tiltAbout = (about: Vector3): number => {
      poseRig(rig, new Quaternion().setFromAxisAngle(about, fullLock));
      group.updateMatrixWorld(true);
      const now = measureInModelFrame(steering, null);
      return now ? axisAngle(restPlane.axis, now.axis) : 90;
    };

    const aboutColumn = tiltAbout(inParent.axis);
    const aboutLocalZ = tiltAbout(new Vector3(0, 0, 1));
    poseRig(rig, new Quaternion().setFromAxisAngle(inParent.axis, fullLock));
    group.updateMatrixWorld(true);

    const rake = axisAngle(restPlane.axis, new Vector3(0, 0, 1));
    console.log(
      `\n  steering column         raked ${rake.toFixed(2)}° off local Z; at full lock the ` +
        `wheel's plane tilts ${aboutColumn.toFixed(2)}° about the column, ` +
        `${aboutLocalZ.toFixed(2)}° about Z`,
    );
    // Turning a wheel about its own column cannot tilt the plane it lies in. About
    // anything else it must, and 192° of lock about an axis 16° out tilts it far
    // enough to push the rim through the dashboard.
    if (aboutColumn > 0.5) {
      failures.push(
        `the steering wheel's plane tilts ${aboutColumn.toFixed(2)}° at full lock — it is ` +
          `tumbling rather than turning about its column`,
      );
    }
    if (aboutLocalZ < 5) {
      failures.push(
        `rotating the steering wheel about local Z tilts it only ${aboutLocalZ.toFixed(2)}°, so ` +
          `this test would not have caught the bug it exists for`,
      );
    }
  }
}

// ---------------------------------------------------------- tyre carcass detail

console.log("  tyre carcasses");
const tyreDiameters: number[] = [];
for (const wheel of found) {
  const tyre = tyreSizes.get(wheel.node.name);
  const triangles = tyreTriangles.get(wheel.node.name) ?? 0;
  if (!tyre) {
    failures.push(`${wheel.node.name} has no tyre carcass mesh`);
    console.log(`    ${wheel.node.name} missing`);
    continue;
  }
  const diameter = tyre.y;
  tyreDiameters.push(diameter);
  console.log(
    `    ${wheel.node.name} ${diameter.toFixed(3)}m diameter, ` +
      `${triangles.toLocaleString("en-US")} triangles`,
  );
  if (triangles < MIN_TYRE_TRIANGLES) {
    failures.push(
      `${wheel.node.name} tyre was reduced to ${triangles} triangles ` +
        `(minimum ${MIN_TYRE_TRIANGLES})`,
    );
  }
  if (Math.abs(diameter / 2 - car.tuning.wheelRadius) > 0.03) {
    failures.push(
      `${wheel.node.name} tyre radius ${(diameter / 2).toFixed(3)}m does not match ` +
        `the configured ${car.tuning.wheelRadius.toFixed(3)}m`,
    );
  }
}
if (tyreDiameters.length === 4) {
  const smallest = Math.min(...tyreDiameters);
  const largest = Math.max(...tyreDiameters);
  if (largest / smallest > 1.02) {
    failures.push(
      `tyre diameters differ by ${((largest / smallest - 1) * 100).toFixed(1)}% — ` +
        `one wheel is visibly mis-scaled`,
    );
  }
}

// ---------------------------------------------------- collision box vs the model

const { halfWidth, halfLength, wheelRadius } = car.tuning;
console.log(
  `\n  body half-width         ${bodyHalfWidth.toFixed(3)}m ` +
    `(collision ${halfWidth.toFixed(2)}m)`,
);
console.log(
  `  body half-length        ${bodyHalfLength.toFixed(3)}m ` +
    `(collision ${halfLength.toFixed(2)}m)`,
);

// The barrier constraint puts the box edge exactly on the wall, so anything of the
// model outside the box is inside the wall.
if (halfWidth + 1e-3 < bodyHalfWidth) {
  failures.push(
    `halfWidth ${halfWidth}m is inside the drawn body (${bodyHalfWidth.toFixed(3)}m) — ` +
      `${((bodyHalfWidth - halfWidth) * 1000).toFixed(0)}mm of car would sit inside a barrier`,
  );
}
if (halfLength + 1e-3 < bodyHalfLength) {
  failures.push(
    `halfLength ${halfLength}m is inside the drawn body (${bodyHalfLength.toFixed(3)}m)`,
  );
}
// A box far larger than the car reads as an invisible bumper, which is just as
// wrong and much harder to spot.
if (halfWidth > bodyHalfWidth + 0.15) {
  failures.push(`halfWidth ${halfWidth}m stands off the body by more than 150mm`);
}
if (halfLength > bodyHalfLength + 0.15) {
  failures.push(`halfLength ${halfLength}m stands off the body by more than 150mm`);
}

// ------------------------------------------------------- wheel envelope vs config

console.log(
  `  wheel half-base         ${wheelHalfBase.toFixed(3)}m   ` +
    `half-track ${wheelHalfTrack.toFixed(3)}m`,
);
// The window `CarView` uses to decide whether its own measurement is believable
// before falling back to a proportion of the collision box.
if (!(wheelHalfBase > halfLength * 0.3 && wheelHalfBase < halfLength)) {
  failures.push(
    `wheel half-base ${wheelHalfBase.toFixed(3)}m is outside the plausible window ` +
      `CarView checks against halfLength ${halfLength}m`,
  );
}
if (!(wheelHalfTrack > halfWidth * 0.3 && wheelHalfTrack < halfWidth)) {
  failures.push(
    `wheel half-track ${wheelHalfTrack.toFixed(3)}m is outside the plausible window ` +
      `CarView checks against halfWidth ${halfWidth}m`,
  );
}
// And the fallback ratios have to actually approximate the car they stand in for.
const baseRatio = wheelHalfBase / halfLength;
const trackRatio = wheelHalfTrack / halfWidth;
console.log(
  `  fallback ratios         base ${baseRatio.toFixed(2)} · track ${trackRatio.toFixed(2)}` +
    `  (CarView uses ${UNRIGGED_BASE_RATIO} / ${UNRIGGED_TRACK_RATIO})`,
);
if (
  Math.abs(baseRatio - UNRIGGED_BASE_RATIO) > 0.06 ||
  Math.abs(trackRatio - UNRIGGED_TRACK_RATIO) > 0.06
) {
  failures.push(
    `CarView's un-rigged fallback ratios ` +
      `(${UNRIGGED_BASE_RATIO}/${UNRIGGED_TRACK_RATIO}) no longer match this car ` +
      `(${baseRatio.toFixed(2)}/${trackRatio.toFixed(2)})`,
  );
}

// `wheelSpin` is ground distance / rolling radius; a wrong radius makes the tyres
// visibly skate even though nothing else looks amiss.
const measuredRadius =
  tyreDiameters.length > 0
    ? Math.max(...tyreDiameters) / 2
    : Math.max(...[...sizes.values()].map((s) => Math.max(s.y, s.z))) / 2;
console.log(`  rolling radius          ${measuredRadius.toFixed(3)}m (config ${wheelRadius}m)`);
if (Math.abs(measuredRadius - wheelRadius) > 0.06) {
  failures.push(
    `wheelRadius ${wheelRadius}m against a ${measuredRadius.toFixed(3)}m tyre — wheels will skate`,
  );
}

// ------------------------------------------------------- who gets which variant

/**
 * The rival grid has to be rigged, and it has to not all be one colour.
 *
 * Both were wrong and both were only visible on screen. Rivals loaded the `lq`
 * variant, whose rig is collapsed to flat meshes, so their wheels did not turn at
 * any speed; and `Resources.instantiate` shares materials, so every car wore the
 * same factory paint as the player.
 */
const lqDoc = await io.read("public/models/cars/zagato-lq.glb");
const lqRigNodes = lqDoc
  .getRoot()
  .listNodes()
  .filter((node) => WHEEL_GROUP.test(node.getName())).length;

console.log(`\n  variants                hq rig ${rigs.length} wheels, lq rig ${lqRigNodes} wheels`);
if (lqRigNodes > 0) {
  console.log("    (lq now carries a rig; the tier rule below could be relaxed)");
}

for (const tier of ["low", "medium", "high"] as const) {
  const rival = carDetailFor(false, tier);
  const player = carDetailFor(true, tier);
  if (player !== "hq") {
    failures.push(`the player is given the ${player} variant on ${tier} — it has no rig`);
  }
  // Above the lowest tier a rival must get a variant that can actually turn a
  // wheel. On `low` the draw-call saving is worth stationary tyres.
  if (tier !== "low" && rival === "lq" && lqRigNodes === 0) {
    failures.push(
      `rivals get the un-rigged lq variant on ${tier}, so their wheels will not rotate`,
    );
  }
}
console.log(
  `  rival variant by tier   low ${carDetailFor(false, "low")}, ` +
    `medium ${carDetailFor(false, "medium")}, high ${carDetailFor(false, "high")}`,
);

// Liveries: distinct, and not the paint the player is already wearing.
const paint = document
  .getRoot()
  .listMaterials()
  .find((material) => /^ext_carpaint$/i.test(material.getName()));
const stock = paint?.getBaseColorFactor() ?? [1, 1, 1, 1];
const stockHex =
  (Math.round(stock[0]! * 255) << 16) |
  (Math.round(stock[1]! * 255) << 8) |
  Math.round(stock[2]! * 255);

const grid = Array.from({ length: 5 }, (_, i) => rivalLivery(i));
const colours = new Set(grid.map((livery) => livery.color));
console.log(
  `  rival liveries          ${grid.length} on the grid, ${colours.size} distinct, ` +
    `stock paint #${stockHex.toString(16).padStart(6, "0")}`,
);
if (colours.size !== grid.length) {
  failures.push(`a five-car grid draws only ${colours.size} distinct rival colours`);
}
if (new Set(grid.map((livery) => livery.roughness)).size < 3) {
  failures.push("rival liveries barely vary their finish, so they read as one car recoloured");
}
for (const livery of grid) {
  const dr = ((livery.color >> 16) & 0xff) / 255 - stock[0]!;
  const dg = ((livery.color >> 8) & 0xff) / 255 - stock[1]!;
  const db = (livery.color & 0xff) / 255 - stock[2]!;
  if (Math.hypot(dr, dg, db) < 0.12) {
    failures.push(
      `rival colour #${livery.color.toString(16)} is within 0.12 of the player's stock paint`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log(
    "\n  PASS — all four wheels are rigged, rotate about their own axle, the collision box\n" +
      "         contains the car that is drawn, and the rival grid is rigged and repainted.\n",
  );
}
