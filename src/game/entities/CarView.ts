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
 *   `modelYaw` correction still rolls about its own forward axis.
 *
 * If the model fails to load — bad network, missing GLB — a blocked-out primitive
 * stands in. A race that renders boxes is far better than a race that does not
 * render.
 */

import type { Object3D } from "three";
import {
  Box3,
  BoxGeometry,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from "three";
import type { CarDefinition } from "../config/cars";
import type { VehicleState } from "../physics/VehicleSim";
import type { QualitySettings } from "../config/quality";
import type { Resources } from "../engine/Resources";
import { clamp } from "@/lib/math";

const FULL_TURN = Math.PI * 2;

/**
 * Rig groups preserved by the asset pipeline.
 *
 * Matched on the group, not the meshes inside it, so each wheel stays a single
 * transformable subtree — rim, tyre, brake disc and decals together.
 */
const WHEEL_GROUP = /^WHEEL_([LR])([FR])/i;
const STEERING_GROUP = /^STEER_HR/i;

/** Steering wheel rotation per radian of road-wheel angle. */
const STEERING_RATIO = 8;

interface WheelRig {
  steerPivot: Group;
  spinPivot: Group;
  front: boolean;
  /** Left-hand wheels face the other way, so their spin axis is inverted. */
  spinSign: number;
}

/**
 * Detail level for a given car in a given race.
 *
 * - `hq` rigged model, larger textures. The player.
 * - `lq` same model and textures, rig collapsed to save draw calls. Rivals.
 */
export type CarDetail = "hq" | "lq";

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
  private steeringRig: Group | null = null;
  private readonly disposables: { dispose: () => void }[] = [];
  private modelYOffset = 0;

  constructor(
    readonly car: CarDefinition,
    private readonly quality: QualitySettings,
    private readonly detail: CarDetail = "lq",
  ) {
    this.group.name = `car-${car.id}`;
    this.tilt.name = "tilt";
    this.group.add(this.tilt);
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

  /** Find the pinned rig groups and wrap each in pivots it can be turned about. */
  private bindRig(root: Object3D): void {
    const wheels: { node: Object3D; front: boolean; left: boolean }[] = [];
    let steering: Object3D | null = null;

    root.traverse((node) => {
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

    for (const wheel of wheels) {
      const rig = this.wrapInPivots(root, wheel.node);
      if (!rig) continue;
      this.wheelRigs.push({
        ...rig,
        front: wheel.front,
        // Mirrored wheels spin the opposite way about a shared axis.
        spinSign: wheel.left ? 1 : -1,
      });
    }

    if (steering) {
      const rig = this.wrapInPivots(root, steering);
      if (rig) this.steeringRig = rig.spinPivot;
    }
  }

  /**
   * Wrap a subtree in an outer (steering) and inner (spin) pivot, centred on the
   * subtree's own visible geometry.
   *
   * The source rig's nodes sit at baked, rotated offsets rather than at the
   * visible wheel centre, so rotating them directly swings the tyre around the
   * car instead of turning it. Bounding-box centres give a correct axis for every
   * wheel, and `attach()` preserves each source transform underneath.
   */
  private wrapInPivots(
    root: Object3D,
    node: Object3D,
  ): { steerPivot: Group; spinPivot: Group } | null {
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(node);
    if (bounds.isEmpty()) return null;

    const center = bounds.getCenter(new Vector3());
    root.worldToLocal(center);

    const steerPivot = new Group();
    steerPivot.name = `steer-pivot-${node.name}`;
    steerPivot.position.copy(center);

    const spinPivot = new Group();
    spinPivot.name = `spin-pivot-${node.name}`;

    root.add(steerPivot);
    steerPivot.add(spinPivot);
    root.updateMatrixWorld(true);
    spinPivot.attach(node);

    return { steerPivot, spinPivot };
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

    const wheelSpin = state.wheelSpin % FULL_TURN;
    for (const wheel of this.wheelRigs) {
      wheel.steerPivot.rotation.y = wheel.front ? state.steerAngle : 0;
      wheel.spinPivot.rotation.x = wheelSpin * wheel.spinSign;
    }

    if (this.steeringRig) {
      this.steeringRig.rotation.z = -state.steerAngle * STEERING_RATIO;
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
