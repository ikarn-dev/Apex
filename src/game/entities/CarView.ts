/**
 * Visual representation of a car.
 *
 * Strictly a view: it reads `VehicleState` and writes transforms. No physics, no
 * decisions. That separation is what lets the simulation run headless for replay
 * verification.
 *
 * If the model fails to load — a bad network, a missing optimised GLB — a blocked
 * primitive stands in. A race that renders boxes is far better than a race that
 * does not render.
 */

import type { Object3D } from "three";
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  CircleGeometry,
  Vector3,
} from "three";
import type { CarDefinition } from "../config/cars";
import type { VehicleState } from "../physics/VehicleSim";
import type { QualitySettings } from "../config/quality";
import type { Resources } from "../engine/Resources";
import { clamp } from "@/lib/math";

/** Length every car is normalised to, metres. */
const TARGET_LENGTH = 4.2;
const FULL_TURN = Math.PI * 2;

/**
 * Transform rigs preserved by the asset pipeline.
 *
 * The supplied model exposes one pivot group per road wheel plus a steering
 * column pivot. Their own transforms carry a baked axis change from the source
 * FBX export, so this view never rotates them directly — it wraps each one in
 * pivots built from the visible geometry's bounding box.
 */
const WHEEL_PIVOT = /^(left|right)\s+(front|back|rear)\s+tire\s+pivot/i;
const STEERING_PIVOT = /^steering\s+wheel\s+pivot/i;

/** Steering wheel rotation per radian of road-wheel angle. */
const STEERING_RATIO = 7.5;

interface WheelRig {
  steerPivot: Group;
  spinPivot: Group;
  front: boolean;
}

/**
 * Detail level for a given car in a given race.
 *
 * - `hq`          full model, 1K textures. The player's car only.
 * - `lq`          reduced model, 512 textures. Rivals, and everything on MEDIUM.
 * - `placeholder` blocked-out primitive, 2 draw calls.
 *
 * The last one exists because of a real measurement: after optimisation the
 * Kimera still ships 216 mesh primitives, since its static skins prevent
 * gltf-transform from joining meshes. Five rivals at 216 primitives each is over
 * a thousand draw calls before the track is drawn, which no phone will hold at
 * 30fps. On the LOW tier rivals therefore render as stylised blocks — a
 * deliberate trade of rival fidelity for a playable frame rate.
 */
export type CarDetail = "hq" | "lq" | "placeholder";

export class CarView {
  readonly group = new Group();
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
    this.buildPlaceholder();
    if (quality.shadowMapSize === 0) this.buildBlobShadow();
  }

  /**
   * Swap in the real model once loaded.
   *
   * Called after construction so a race can start rendering immediately and
   * upgrade in place rather than blocking on the network. On the `placeholder`
   * detail level this is a no-op and the blocked-out car is the final look.
   */
  async attachModel(resources: Resources): Promise<void> {
    if (this.detail === "placeholder") return;
    try {
      const url = this.detail === "hq" ? this.car.model : this.car.modelLq;
      const model = await resources.load(url);
      const instance = resources.instantiate(model);
      const { yOffset } = resources.prepareCar(instance, {
        targetLength: TARGET_LENGTH,
        sourceSize: model.size,
        anisotropy: this.quality.anisotropy,
        castShadow: this.quality.shadowMapSize > 0,
        // The scene always provides a pre-filtered sky environment now, so the
        // bodywork has something to reflect on every tier.
        envMapIntensity: this.quality.envProbe ? 1.15 : 0.9,
      });

      instance.rotation.y = this.car.modelYaw;
      instance.position.y = yOffset + this.car.modelYOffset;
      this.modelYOffset = yOffset;

      this.clearBody();
      this.body = instance;
      this.group.add(instance);
      this.bindWheelRigs(instance);
    } catch {
      // Keep the placeholder. Already visible, already correct size.
    }
  }

  /** Blocked-out stand-in: readable silhouette, one draw call per part. */
  private buildPlaceholder(): void {
    const shell = new Group();

    const bodyGeometry = new BoxGeometry(1.9, 0.62, 4.3);
    const bodyMaterial = new MeshStandardMaterial({
      color: this.car.accent,
      roughness: 0.42,
      metalness: 0.55,
    });
    const bodyMesh = new Mesh(bodyGeometry, bodyMaterial);
    bodyMesh.position.y = 0.55;
    bodyMesh.castShadow = this.quality.shadowMapSize > 0;
    shell.add(bodyMesh);

    const cabinGeometry = new BoxGeometry(1.55, 0.5, 1.9);
    const cabinMaterial = new MeshStandardMaterial({
      color: 0x0b0f14,
      roughness: 0.16,
      metalness: 0.35,
    });
    const cabin = new Mesh(cabinGeometry, cabinMaterial);
    cabin.position.set(0, 1.02, -0.15);
    shell.add(cabin);

    this.disposables.push(bodyGeometry, bodyMaterial, cabinGeometry, cabinMaterial);

    this.body = shell;
    this.group.add(shell);
  }

  /** Cheap contact shadow for the LOW tier, where shadow mapping is off. */
  private buildBlobShadow(): void {
    const geometry = new CircleGeometry(1.55, 12);
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
    blob.name = "blob-shadow";
    this.group.add(blob);
    this.shadowBlob = blob;
    this.disposables.push(geometry, material);
  }

  /**
   * Build a steering pivot and an axle pivot around each imported wheel.
   *
   * The supplied rig's pivot nodes sit at baked, rotated offsets rather than at
   * the visible wheel centre, so rotating them directly would swing the tyre
   * around the car. Bounding-box centres give a correct axis of rotation for
   * every wheel, and `attach()` preserves each source transform underneath.
   */
  private bindWheelRigs(root: Object3D): void {
    const wheels: { node: Object3D; front: boolean }[] = [];
    let steeringWheel: Object3D | null = null;

    root.traverse((node) => {
      if (!this.hasRenderableMesh(node)) return;
      const wheel = node.name.match(WHEEL_PIVOT);
      if (wheel) {
        wheels.push({ node, front: /front/i.test(wheel[2]!) });
        return;
      }
      if (!steeringWheel && STEERING_PIVOT.test(node.name)) steeringWheel = node;
    });

    for (const wheel of wheels) {
      const rig = this.wrapInPivots(root, wheel.node);
      if (!rig) continue;
      this.wheelRigs.push({ ...rig, front: wheel.front });
    }

    if (steeringWheel) {
      const rig = this.wrapInPivots(root, steeringWheel);
      // The steering wheel's disc is thinnest in Z, so its column axis is Z.
      if (rig) this.steeringRig = rig.spinPivot;
    }
  }

  /**
   * Wrap a subtree in an outer (steering) and inner (spin) pivot centred on the
   * subtree's own visible geometry.
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
    this.group.remove(this.body);
    this.body = null;
  }

  /** Called every rendered frame with the interpolated physics state. */
  sync(state: VehicleState, interpolatedPosition: Vector3): void {
    this.group.position.copy(interpolatedPosition);
    this.group.rotation.set(0, state.yaw, 0);

    if (this.body) {
      // Body roll and pitch live on the child so the group transform stays a
      // clean position + yaw, which the camera relies on.
      this.body.rotation.z = state.roll;
      this.body.rotation.x = state.pitch;
      this.body.rotation.y = this.car.modelYaw;
    }

    const wheelSpin = state.wheelSpin % FULL_TURN;
    for (const wheel of this.wheelRigs) {
      wheel.steerPivot.rotation.y = wheel.front ? state.steerAngle : 0;
      wheel.spinPivot.rotation.x = wheelSpin;
    }

    if (this.steeringRig) {
      this.steeringRig.rotation.z = -state.steerAngle * STEERING_RATIO;
    }

    if (this.shadowBlob) {
      // Fades and shrinks with airtime so a jump reads correctly.
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

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.wheelRigs.length = 0;
    this.steeringRig = null;
    this.group.clear();
  }
}
