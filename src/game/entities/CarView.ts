/**
 * Visual representation of a car.
 *
 * Strictly a view: it reads `VehicleState` and writes transforms. No physics, no
 * decisions. That separation is what lets the simulation run headless for replay
 * verification.
 *
 * ## The rig
 *
 * The source model exposes four `WHEEL_**` groups and a `STEER_HR` column, and the
 * asset pipeline pins those five nodes so `flatten`/`join` cannot fold them away.
 * This view drives them every frame:
 *
 * - all four wheels spin at `wheelSpin`, derived from ground speed and the car's
 *   own rolling radius, so the tyres never look like they are skating,
 * - the front pair steers to the angle the simulation actually applied, which is
 *   rate-limited and speed-scaled — not the raw input,
 * - the steering wheel turns with them, geared up like a real rack,
 * - the body rolls and pitches on a separate node from the model, so a car with a
 *   `modelYaw` correction still rolls about its own forward axis,
 * - and the model is lifted by however far that roll and pitch would drive a
 *   wheel through the road, measured from the rig's own wheel centres.
 *
 * That last one is not a detail. The tilt node's origin is on the contact plane, so
 * rotating it pitches the car about the tarmac rather than about its own mass: a
 * 2.6° dive under braking buried the nose 110mm into the road, and hard cornering
 * did the same to one front corner. Compensating puts the loaded wheel back on the
 * surface and lets the unloaded end rise, which is what a car under brakes actually
 * does.
 *
 * If the model fails to load — bad network, missing GLB — a blocked-out primitive
 * stands in. A race that renders boxes is far better than a race that does not
 * render.
 */

import type { Material, Object3D } from "three";
import {
  Box3,
  BoxGeometry,
  CircleGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import type { CarDefinition } from "../config/cars";
import type { RivalLivery } from "../config/drivers";
import type { VehicleState } from "../physics/VehicleSim";
import type { QualitySettings, QualityTier } from "../config/quality";
import type { Resources } from "../engine/Resources";
import { clamp } from "@/lib/math";

const FULL_TURN = Math.PI * 2;

/** Yaw axis, for taking `modelYaw` back out of a measured rig position. */
const UP = new Vector3(0, 1, 0);

/**
 * Fallback wheel envelope if the rig is absent, as a fraction of the collision box.
 *
 * Rivals ship with the rig collapsed, so there are no wheel centres to measure.
 * A wheel sits well inside the bodywork at both ends, and these are the measured
 * ratios for the one car in the roster.
 */
export const UNRIGGED_BASE_RATIO = 0.62;
export const UNRIGGED_TRACK_RATIO = 0.74;

/**
 * Rig groups preserved by the asset pipeline.
 *
 * Matched on the group, not the meshes inside it, so each wheel stays a single
 * transformable subtree — rim, tyre, brake disc and decals together.
 */
const WHEEL_GROUP = /^WHEEL_([LR])([FR])/i;
const STEERING_GROUP = /^STEER_HR/i;

/** Steering wheel rotation per radian of road-wheel angle. */
export const STEERING_RATIO = 8;

/** Tyre carcass material. The one part of a wheel group that is a true disc. */
const TYRE_MATERIAL = /^EXT_WHEEL/i;

/**
 * The body panels a livery repaints.
 *
 * Deliberately just the one material. `ext_gloss`, `ext_carbon` and `ext_chrome`
 * are trim the car is recognisable by, and recolouring them turns a livery into a
 * different vehicle rather than the same one in team colours.
 */
const PAINT_MATERIAL = /^ext_carpaint$/i;

function isDescendantOf(node: Object3D, ancestor: Object3D): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent === ancestor) return true;
  }
  return false;
}

/** World direction as a direction in `node`'s parent frame. */
function verticalInParentFrame(node: Object3D, root: Object3D): Vector3 {
  // The car's vertical is the model's local Y — `modelYaw` is a Y rotation, so it
  // leaves that axis alone.
  const up = new Vector3(0, 1, 0);
  if (!node.parent || node.parent === root) return up;
  const parentToRoot = new Matrix4()
    .copy(node.parent.matrixWorld)
    .invert()
    .multiply(root.matrixWorld);
  return up.transformDirection(parentToRoot).normalize();
}

/** A point in `node`'s parent frame, expressed in the model's frame. */
function toModelFrame(node: Object3D, root: Object3D, point: Vector3): Vector3 {
  if (!node.parent || node.parent === root) return point.clone();
  const parentToRoot = new Matrix4()
    .copy(root.matrixWorld)
    .invert()
    .multiply(node.parent.matrixWorld);
  return point.clone().applyMatrix4(parentToRoot);
}

/**
 * The centre and axis a disc-shaped subtree turns about, in its parent's frame.
 *
 * Nothing in the glTF declares either one, so both are measured. A wheel and a
 * steering wheel are each thin in one direction and wide in the other two, so the
 * axis is the direction of *least* variance in the vertex cloud — the weakest
 * eigenvector of the covariance matrix, obtained by power-iterating on
 * `trace * I - C`, whose dominant eigenvector is exactly that.
 *
 * Measuring matters most for the steering column, because it is *raked*: its axis
 * is 16.3° off the model's local Z on this car, and the view used to turn the
 * steering wheel about local Z regardless. At speed that is invisible, because the
 * simulation limits the lock to what the tyres can use — 94m/s allows 0.01rad, so
 * the steering wheel moves 4.6°. At a standstill the full 0.42rad is available,
 * which at a ratio of 8 is 192° about an axis 16° out, and the wheel tumbles out of
 * the dashboard instead of turning in it. That is a black leather ring appearing in
 * mid-air on the front left of the car, and only ever when it is stopped.
 *
 * The centre comes from the bounding box rather than the vertex mean, because tread
 * blocks make the mesh's vertex density uneven while its extents stay symmetric.
 */
function measureRotation(
  node: Object3D,
  materialFilter: RegExp | null,
): { centre: Vector3; axis: Vector3 } | null {
  const meshes: Mesh[] = [];
  node.traverse((child) => {
    if (!(child instanceof Mesh) || !child.geometry.getAttribute("position")) return;
    if (materialFilter) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      if (!materials.some((material) => materialFilter.test(material.name ?? ""))) return;
    }
    meshes.push(child);
  });
  // No tyre found by material name — the pipeline may have renamed it. Better a
  // whole-group measurement than no rig at all.
  if (meshes.length === 0 && materialFilter) return measureRotation(node, null);
  if (meshes.length === 0) return null;

  const parent = node.parent;
  const toParent = new Matrix4();
  const bounds = new Box3();
  const point = new Vector3();
  const points: Vector3[] = [];

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    toParent.copy(mesh.matrixWorld);
    if (parent) toParent.premultiply(new Matrix4().copy(parent.matrixWorld).invert());

    const position = mesh.geometry.getAttribute("position");
    // Every vertex is overkill for an axis; a stride keeps this to a few thousand
    // on a 12,000-vertex steering wheel without changing the answer.
    const stride = Math.max(1, Math.floor(position.count / 2048));
    for (let i = 0; i < position.count; i += stride) {
      point.fromBufferAttribute(position, i).applyMatrix4(toParent);
      bounds.expandByPoint(point);
      points.push(point.clone());
    }
  }
  if (points.length < 16 || bounds.isEmpty()) return null;

  const mean = new Vector3();
  for (const sample of points) mean.add(sample);
  mean.multiplyScalar(1 / points.length);

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const sample of points) {
    const dx = sample.x - mean.x;
    const dy = sample.y - mean.y;
    const dz = sample.z - mean.z;
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
  for (let iteration = 0; iteration < 64; iteration += 1) {
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

/**
 * A rig node driven by the simulation, animated in place.
 *
 * `rest` is the node's own local matrix as the model shipped it, and every frame's
 * transform is composed from it — so an animated wheel is always exactly one
 * rotation away from the pose the artist authored, no matter what happened on the
 * frames before. Nothing is reparented and no extra nodes exist, which is the
 * point: the previous version wrapped each wheel in two `Group` pivots and moved
 * the source node into them with `attach()`, so the rig depended on world matrices
 * being current at the moment the model finished downloading. That is a lot of
 * machinery to hang a tyre on.
 */
interface RigPart {
  node: Object3D;
  /** The node's local matrix before any animation is applied. */
  rest: Matrix4;
  /** Centre of rotation, in the node's own parent frame. */
  centre: Vector3;
  /** Rotation axis, in the node's own parent frame. */
  axis: Vector3;
}

interface WheelRig extends RigPart {
  front: boolean;
  /** Left-hand wheels face the other way, so their spin axis is inverted. */
  spinSign: number;
  /** The car's vertical, in the node's parent frame. Steering turns about it. */
  steerAxis: Vector3;
}



/**
 * Detail level for a given car in a given race.
 *
 * - `hq` rigged model, larger textures. The player.
 * - `lq` same model and textures, rig collapsed to save draw calls. Rivals.
 */
export type CarDetail = "hq" | "lq";

/**
 * Which variant a car in a race should use.
 *
 * A pure function rather than a branch inside the engine so it can be asserted: the
 * rule it encodes is not obvious, and getting it wrong is invisible in code review
 * and glaring on screen. `lq` has its rig collapsed to 30 flat meshes with no
 * `WHEEL_**` nodes, so any car using it has wheels welded to the bodyshell. That is
 * only an acceptable trade on the lowest tier.
 */
export function carDetailFor(isPlayer: boolean, tier: QualityTier): CarDetail {
  if (isPlayer) return "hq";
  return tier === "low" ? "lq" : "hq";
}

export class CarView {
  readonly group = new Group();

  /**
   * Carries body roll and pitch.
   *
   * Separate from the model so `modelYaw` cannot rotate the axes roll and pitch
   * are applied around. With both on one object, a car needing a 90° correction
   * would roll when it should pitch.
   */
  private readonly tilt = new Group();
  private body: Object3D | null = null;
  private shadowBlob: Mesh | null = null;
  private readonly wheelRigs: WheelRig[] = [];
  private steeringRig: RigPart | null = null;
  private readonly disposables: { dispose: () => void }[] = [];

  /** Frame scratch, so `sync` allocates nothing. */
  private readonly spin = new Quaternion();
  private readonly steer = new Quaternion();
  private readonly pose = new Matrix4();
  private readonly offset = new Vector3();
  private modelYOffset = 0;

  /**
   * Distance from the car's centre to the outermost wheel centres, metres.
   *
   * Measured off the rig rather than taken from the collision box: the box is the
   * whole silhouette including the mirrors, and lifting the car by a mirror's
   * leverage would make it visibly hover.
   */
  private wheelHalfBase: number;
  private wheelHalfTrack: number;

  constructor(
    readonly car: CarDefinition,
    private readonly quality: QualitySettings,
    private readonly detail: CarDetail = "lq",
    /** Team colours for a rival. `null` keeps the model's own factory paint. */
    private readonly livery: RivalLivery | null = null,
  ) {
    this.group.name = `car-${car.id}`;
    this.tilt.name = "tilt";
    this.group.add(this.tilt);
    this.wheelHalfBase = car.tuning.halfLength * UNRIGGED_BASE_RATIO;
    this.wheelHalfTrack = car.tuning.halfWidth * UNRIGGED_TRACK_RATIO;
    this.buildPlaceholder();
    // Real shadow mapping replaces the blob where the tier can afford it.
    if (quality.shadowMapSize === 0) this.buildBlobShadow();
  }

  /**
   * Swap in the real model once loaded.
   *
   * Called after construction so a race can start rendering immediately and
   * upgrade in place rather than blocking on the network.
   */
  async attachModel(resources: Resources): Promise<void> {
    const url = this.detail === "hq" ? this.car.model : this.car.modelLq;
    try {
      const model = await resources.load(url);
      const instance = resources.instantiate(model);
      const { yOffset } = resources.prepareCar(instance, {
        targetLength: this.car.targetLength,
        sourceSize: model.size,
        anisotropy: this.quality.anisotropy,
        castShadow: this.quality.shadowMapSize > 0,
        // The sky gradient is pre-filtered into an environment map, which is what
        // stops this car's metallic paint and chrome from rendering near-black.
        envMapIntensity: 1,
      });

      instance.rotation.y = this.car.modelYaw;
      instance.position.y = yOffset + this.car.modelYOffset;
      this.modelYOffset = yOffset;

      // Before the rig, and before anything reads a material: the paint has to be
      // swapped for a clone or every car on the grid changes colour together.
      if (this.livery) this.applyLivery(instance, this.livery);

      this.clearBody();
      this.body = instance;
      this.tilt.add(instance);
      // Only the player's variant ships the rig; on a rival this finds nothing
      // and the wheels ride along with the body, which is correct for the trade.
      this.bindRig(instance);
    } catch (error) {
      // The placeholder stays, so the race is still playable. But this must not be
      // silent: a missing GLB used to leave blocked-out boxes on the grid with
      // nothing anywhere saying why.
      throw new Error(
        `Could not load ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Repaint the body panels in this car's team colours.
   *
   * `Resources.instantiate` shares materials between instances on purpose — six
   * cars with one body material is one shader program and one set of uniforms — so
   * the paint has to be cloned here or setting a colour on one rival sets it on the
   * whole grid, the player's car included.
   *
   * The clone is memoised per source material, not per mesh: the body is split
   * across many meshes that share one paint material, and cloning per mesh would
   * turn one draw call into a dozen.
   */
  private applyLivery(root: Object3D, livery: RivalLivery): void {
    const repainted = new Map<Material, MeshStandardMaterial>();

    const repaint = (material: Material): Material => {
      if (!PAINT_MATERIAL.test(material.name ?? "")) return material;
      const existing = repainted.get(material);
      if (existing) return existing;
      if (!(material instanceof MeshStandardMaterial)) return material;

      const clone = material.clone();
      clone.name = `${material.name}-livery`;
      clone.color.setHex(livery.color);
      clone.roughness = livery.roughness;
      repainted.set(material, clone);
      this.disposables.push(clone);
      return clone;
    };

    root.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.material = Array.isArray(node.material)
        ? node.material.map(repaint)
        : repaint(node.material);
    });
  }

  /** Blocked-out stand-in: readable silhouette, two draw calls. */
  private buildPlaceholder(): void {
    const shell = new Group();

    const bodyGeometry = new BoxGeometry(1.95, 0.6, 4.5);
    const bodyMaterial = new MeshStandardMaterial({
      color: this.car.accent,
      roughness: 0.7,
      metalness: 0.04,
    });
    const bodyMesh = new Mesh(bodyGeometry, bodyMaterial);
    bodyMesh.position.y = 0.52;
    shell.add(bodyMesh);

    const cabinGeometry = new BoxGeometry(1.6, 0.46, 1.9);
    const cabinMaterial = new MeshStandardMaterial({
      color: 0x17232b,
      roughness: 0.74,
      metalness: 0.02,
    });
    const cabin = new Mesh(cabinGeometry, cabinMaterial);
    cabin.position.set(0, 0.95, -0.2);
    shell.add(cabin);

    this.disposables.push(bodyGeometry, bodyMaterial, cabinGeometry, cabinMaterial);

    this.body = shell;
    this.tilt.add(shell);
  }

  /**
   * Contact shadow.
   *
   * There is no shadow mapping in the render budget on any tier, and a car with
   * nothing under it looks like it is hovering. One unlit disc fixes that for the
   * price of a single transparent draw.
   */
  private buildBlobShadow(): void {
    const geometry = new CircleGeometry(1.7, 14);
    const material = new MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      fog: false,
    });
    const blob = new Mesh(geometry, material);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.03;
    blob.scale.y = 1.35;
    blob.name = "blob-shadow";
    this.group.add(blob);
    this.shadowBlob = blob;
    this.disposables.push(geometry, material);
  }

  /**
   * Find the pinned rig nodes and measure what each one turns about.
   *
   * The source rig's nodes sit at baked, rotated offsets rather than at the visible
   * wheel centre, so a node cannot simply be rotated where it stands — that swings
   * the tyre around the car. What it needs is a centre and an axis, and both are
   * measured off the geometry rather than assumed, because nothing in the file
   * declares them: see `measureRotation`.
   */
  private bindRig(root: Object3D): void {
    const wheels: { node: Object3D; front: boolean; left: boolean }[] = [];
    let steering: Object3D | null = null;

    root.traverse((node) => {
      // Skip anything already inside a matched wheel: a nested name would
      // otherwise be rigged twice and fight itself.
      if (wheels.some((found) => isDescendantOf(node, found.node))) return;

      const wheel = node.name.match(WHEEL_GROUP);
      if (wheel && this.hasRenderableMesh(node)) {
        wheels.push({
          node,
          left: wheel[1]!.toUpperCase() === "L",
          front: wheel[2]!.toUpperCase() === "F",
        });
        return;
      }
      if (!steering && STEERING_GROUP.test(node.name) && this.hasRenderableMesh(node)) {
        steering = node;
      }
    });

    root.updateMatrixWorld(true);

    let halfBase = 0;
    let halfTrack = 0;
    for (const wheel of wheels) {
      // The tyre carcass, not the whole group: it is the one part that is a true
      // disc, so it gives both the axle direction and the centre cleanly. The rim
      // and brake disc share the axle but a valve or a decal pulls a bounding box
      // slightly off it.
      const measured = measureRotation(wheel.node, TYRE_MATERIAL);
      if (!measured) continue;

      const rest = wheel.node.matrix.clone();
      wheel.node.matrixAutoUpdate = false;

      this.wheelRigs.push({
        node: wheel.node,
        rest,
        centre: measured.centre,
        axis: measured.axis,
        steerAxis: verticalInParentFrame(wheel.node, root),
        front: wheel.front,
        // Mirrored wheels spin the opposite way about a shared axle.
        spinSign: wheel.left ? 1 : -1,
      });

      // The wheel envelope, for keeping a diving or leaning car's tyres on the
      // road. `centre` is in the node's parent frame, which is neither scaled to
      // metres nor aligned with the car — `prepareCar` puts a ~105x scale on the
      // model and `modelYaw` rotates it. Both have to be undone, or the envelope
      // comes out in source units (0.014 instead of 1.45m) and the compensation it
      // feeds silently does nothing.
      const inCarSpace = toModelFrame(wheel.node, root, measured.centre)
        .multiplyScalar(root.scale.x)
        .applyAxisAngle(UP, this.car.modelYaw);
      halfTrack = Math.max(halfTrack, Math.abs(inCarSpace.x));
      halfBase = Math.max(halfBase, Math.abs(inCarSpace.z));
    }

    // A wheel centre has to land inside the collision box and outside its middle.
    // Anything else means the frames were not reconciled, and quietly trusting the
    // number is how a broken measurement went unnoticed once already; the
    // proportional fallback is wrong by a few centimetres, which is far better than
    // wrong by two orders of magnitude.
    const { halfLength, halfWidth } = this.car.tuning;
    if (
      halfBase > halfLength * 0.3 &&
      halfBase < halfLength &&
      halfTrack > halfWidth * 0.3 &&
      halfTrack < halfWidth
    ) {
      this.wheelHalfBase = halfBase;
      this.wheelHalfTrack = halfTrack;
    }

    if (steering) {
      const measured = measureRotation(steering, null);
      if (measured) {
        this.steeringRig = {
          node: steering,
          rest: (steering as Object3D).matrix.clone(),
          centre: measured.centre,
          axis: measured.axis,
        };
        (steering as Object3D).matrixAutoUpdate = false;
      }
    }
  }

  /**
   * Pose a rig node: rotate `angle` about its measured axis, through its measured
   * centre, applied on top of the transform the model shipped.
   *
   * `matrix = T(centre) · R · T(-centre) · rest`, written straight into the node
   * with `matrixAutoUpdate` off. Composing from `rest` every frame rather than
   * accumulating means a bad value can never persist past the frame that caused it.
   */
  private poseRig(part: RigPart, rotation: Quaternion): void {
    // A rotation about a point is `T(c) · R · T(-c)`, whose translation column is
    // simply `c - R·c`.
    this.pose.makeRotationFromQuaternion(rotation);
    this.offset.copy(part.centre).applyQuaternion(rotation);
    this.pose.setPosition(
      part.centre.x - this.offset.x,
      part.centre.y - this.offset.y,
      part.centre.z - this.offset.z,
    );
    part.node.matrix.multiplyMatrices(this.pose, part.rest);
    part.node.matrixWorldNeedsUpdate = true;
  }

  private hasRenderableMesh(root: Object3D): boolean {
    let found = false;
    root.traverse((node) => {
      if (node instanceof Mesh) found = true;
    });
    return found;
  }

  private clearBody(): void {
    this.wheelRigs.length = 0;
    this.steeringRig = null;
    if (!this.body) return;
    this.tilt.remove(this.body);
    this.body = null;
  }

  /** Called every rendered frame with the interpolated physics state. */
  sync(state: VehicleState, interpolatedPosition: Vector3): void {
    this.group.position.copy(interpolatedPosition);
    this.group.rotation.set(0, state.yaw, 0);

    // Roll and pitch live on the tilt child so the group transform stays a clean
    // position + yaw, which the camera relies on.
    this.tilt.rotation.z = state.roll;
    this.tilt.rotation.x = state.pitch;

    // Then lift the model by however far that rotation pushed its lowest wheel
    // below the road. The tilt origin is on the contact plane, so a wheel at
    // longitudinal distance `b` drops by `b·sin(pitch)` — 110mm at full brake
    // dive, which read as the nose sinking into the tarmac.
    //
    // `bodyRoll`, not `roll`: the crossfall part of the total is the road tilting
    // under a car that is still sitting on all four tyres, and compensating for it
    // would float the car through every banked corner.
    if (this.body) {
      const lift =
        Math.abs(Math.sin(state.pitch)) * this.wheelHalfBase +
        Math.abs(Math.sin(state.bodyRoll)) * this.wheelHalfTrack;
      this.body.position.y = this.modelYOffset + this.car.modelYOffset + lift;
    }

    // A non-finite angle here is unrecoverable: it poisons the pivot's matrix, and
    // every matrix downstream of it, for the rest of the race — the tyre is drawn
    // at an undefined position and nothing on the view side can bring it back.
    // Rather than trust the simulation forever, hold the last good pose.
    const steerAngle = Number.isFinite(state.steerAngle) ? state.steerAngle : 0;
    const wheelSpin = Number.isFinite(state.wheelSpin) ? state.wheelSpin % FULL_TURN : 0;

    for (const wheel of this.wheelRigs) {
      // Spin about the measured axle, then steer the front pair about the car's
      // vertical. Both go through the same measured centre, so the tyre turns and
      // rolls where it sits instead of orbiting anything.
      this.spin.setFromAxisAngle(wheel.axis, wheelSpin * wheel.spinSign);
      if (wheel.front && steerAngle !== 0) {
        this.steer.setFromAxisAngle(wheel.steerAxis, steerAngle);
        this.spin.premultiply(this.steer);
      }
      this.poseRig(wheel, this.spin);
    }

    if (this.steeringRig) {
      // About the raked column, not local Z. See `measureRotation`.
      this.steer.setFromAxisAngle(this.steeringRig.axis, -steerAngle * STEERING_RATIO);
      this.poseRig(this.steeringRig, this.steer);
    }

    if (this.shadowBlob) {
      // Fades and shrinks with airtime so a crest reads correctly.
      const airborne = clamp((interpolatedPosition.y - state.y) * 0.5, 0, 1);
      const material = this.shadowBlob.material as MeshBasicMaterial;
      material.opacity = 0.34 * (1 - airborne);
      this.shadowBlob.position.y = 0.03 - (interpolatedPosition.y - state.y);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  get yOffset(): number {
    return this.modelYOffset;
  }

  /** Number of wheels this view is actually animating. Surfaced for diagnostics. */
  get riggedWheels(): number {
    return this.wheelRigs.length;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.wheelRigs.length = 0;
    this.steeringRig = null;
    this.tilt.clear();
    this.group.clear();
  }
}
