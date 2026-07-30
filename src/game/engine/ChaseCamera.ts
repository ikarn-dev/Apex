/**
 * Chase camera.
 *
 * The camera does most of the work in making a racing game feel fast, so a few
 * things here are intentional rather than incidental:
 *
 * - It follows the **velocity** direction, not the car's heading. In a drift the
 *   car is sideways but the camera keeps looking where the car is going, which
 *   reads as controlled rather than nauseating.
 * - FOV widens with speed. A fixed FOV makes 300km/h look like 100km/h.
 * - Position is critically damped, not lerped by a constant, so it behaves the
 *   same at 30fps and 144fps.
 * - All shake is scaled by one factor that the reduced-motion setting can zero.
 */

import { Vector3, type PerspectiveCamera } from "three";
import type { VehicleState } from "../physics/VehicleSim";
import { clamp, damp, lerp, wrapAngle } from "@/lib/math";

const BASE_DISTANCE = 7.6;
const BASE_HEIGHT = 2.85;
const LOOK_HEIGHT = 1.15;

const BASE_FOV = 60;
const MAX_FOV = 82;

/** Extra distance at top speed, metres. */
const SPEED_PULLBACK = 2.6;

export class ChaseCamera {
  private readonly position = new Vector3();
  private readonly target = new Vector3();
  private readonly desired = new Vector3();
  private readonly lookAt = new Vector3();

  /** Smoothed follow angle, radians. */
  private angle = 0;
  private initialised = false;
  private shake = 0;
  private shakeSeed = 0;

  /** 0 disables all camera shake. */
  motionScale = 1;

  reset(state: VehicleState): void {
    this.angle = state.yaw;
    this.initialised = false;
    this.shake = 0;
  }

  /** Kick the camera on impact. `severity` is impact speed in m/s. */
  impulse(severity: number): void {
    this.shake = Math.min(1, this.shake + clamp(severity / 22, 0, 0.8));
  }

  update(
    camera: PerspectiveCamera,
    state: VehicleState,
    maxSpeed: number,
    dt: number,
    carY: number,
  ): void {
    const speedRatio = clamp(state.speed / maxSpeed, 0, 1);

    // Follow the direction of travel above walking pace, otherwise the heading.
    const travelAngle =
      state.speed > 3 ? Math.atan2(state.vx, state.vz) : state.yaw;

    // Blend toward heading at low speed so reversing does not whip the camera
    // around behind the car.
    const blended = lerp(state.yaw, travelAngle, clamp(state.speed / 12, 0, 1));

    if (!this.initialised) {
      this.angle = blended;
    } else {
      // Shortest-path angular damping, otherwise crossing ±π spins the camera.
      const delta = wrapAngle(blended - this.angle);
      this.angle = wrapAngle(this.angle + delta * (1 - Math.exp(-6.5 * dt)));
    }

    const distance = BASE_DISTANCE + SPEED_PULLBACK * speedRatio;
    const height = BASE_HEIGHT + 0.4 * speedRatio;

    this.desired.set(
      state.x - Math.sin(this.angle) * distance,
      carY + height,
      state.z - Math.cos(this.angle) * distance,
    );

    if (!this.initialised) {
      this.position.copy(this.desired);
      this.initialised = true;
    } else {
      this.position.x = damp(this.position.x, this.desired.x, 9, dt);
      this.position.y = damp(this.position.y, this.desired.y, 6.5, dt);
      this.position.z = damp(this.position.z, this.desired.z, 9, dt);
    }

    // Look slightly ahead of the car, further ahead the faster it goes.
    const leadDistance = 5 + speedRatio * 9;
    this.target.set(
      state.x + Math.sin(this.angle) * leadDistance,
      carY + LOOK_HEIGHT,
      state.z + Math.cos(this.angle) * leadDistance,
    );

    this.lookAt.copy(this.target);

    // --- shake -------------------------------------------------------------
    // Speed adds a constant tremor; impacts add a decaying one.
    const speedShake = speedRatio * speedRatio * 0.055;
    const total = (this.shake + speedShake) * this.motionScale;
    if (total > 0.0005) {
      // Deterministic pseudo-noise: no allocation, no Math.random, and it does
      // not need to be reproducible across runs since it is view-only.
      this.shakeSeed += dt * 60;
      const nx = Math.sin(this.shakeSeed * 12.9898) * 0.5;
      const ny = Math.sin(this.shakeSeed * 7.233 + 1.7) * 0.5;
      this.position.x += nx * total;
      this.position.y += ny * total * 0.6;
      this.lookAt.x += nx * total * 0.5;
    }
    this.shake = Math.max(0, this.shake - dt * 2.4);

    camera.position.copy(this.position);
    camera.lookAt(this.lookAt);

    const targetFov = lerp(BASE_FOV, MAX_FOV, speedRatio * speedRatio);
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov = damp(camera.fov, targetFov, 3.5, dt);
      camera.updateProjectionMatrix();
    }
  }

  /** Camera world position, for audio panning and the sun's shadow target. */
  get worldPosition(): Vector3 {
    return this.position;
  }
}
