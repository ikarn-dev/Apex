/**
 * Deterministic arcade vehicle simulation.
 *
 * Design constraints, in priority order:
 *
 * 1. **Deterministic.** No `Math.random`, no wall-clock, no `performance.now`,
 *    fixed 60Hz step, `Float64` throughout. The same inputs and seed produce a
 *    bit-identical result on every device, which is what makes a replay hash
 *    meaningful to the on-chain verifier.
 * 2. **Allocation-free.** The step function mutates `this` and writes into
 *    caller-owned scratch. Nothing here creates a `Vector3`.
 * 3. **Fun before fidelity.** This is not a tyre model. Forces are integrated in
 *    world space so a slide behaves correctly — momentum carries in the
 *    direction the car was already going, not the direction it now points — but
 *    the grip curve is tuned by feel rather than measured.
 *
 * The one piece of real vehicle dynamics that matters here: lateral friction is
 * *capped*. Below the cap the tyres cancel sideways velocity and the car goes
 * where it is pointed. Above it, the excess survives as slip angle, and slip
 * angle is what the drift scoring reads.
 */

import type { CarTuning } from "../config/cars";
import { clamp, damp, sign0, wrapAngle } from "@/lib/math";

export interface VehicleInput {
  /** 0-1. */
  throttle: number;
  /** 0-1. */
  brake: number;
  /** -1 (left) to 1 (right). */
  steer: number;
  handbrake: boolean;
}

export interface VehicleState {
  x: number;
  y: number;
  z: number;
  /** Heading, radians. Forward is `(sin yaw, cos yaw)`. */
  yaw: number;
  /** World velocity, m/s. */
  vx: number;
  vz: number;
  /** Vertical velocity, used only for airtime over crests. */
  vy: number;
  yawRate: number;
  /** Cached local velocity components, refreshed every step. */
  vLong: number;
  vLat: number;
  speed: number;
  /** Signed angle between heading and travel direction, radians. */
  slipAngle: number;
  /** Visual body roll and pitch, radians. */
  roll: number;
  pitch: number;
  /** Wheel spin angle for the visual wheels, radians. */
  wheelSpin: number;
  /** Front wheel steer angle actually applied, radians. */
  steerAngle: number;
  onGround: boolean;
  /** 0-1 engine speed for audio and the tacho. */
  rpm: number;
  gear: number;
}

export function createVehicleState(): VehicleState {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    yawRate: 0,
    vLong: 0,
    vLat: 0,
    speed: 0,
    slipAngle: 0,
    roll: 0,
    pitch: 0,
    wheelSpin: 0,
    steerAngle: 0,
    onGround: true,
    rpm: 0,
    gear: 1,
  };
}

const GRAVITY = 9.81;

/**
 * Height above the road at which a car is treated as airborne, metres.
 *
 * Large enough that surface tessellation never flips the state, small enough
 * that a real crest still launches the car.
 */
const AIRBORNE_CLEARANCE = 0.12;

/**
 * Handbrake yaw may exceed the reduced rear-grip budget enough to create slip,
 * but not by enough to turn every initiated drift into an uncontrollable spin.
 */
const HANDBRAKE_YAW_OVERDRIVE = 1.85;

/** Simulated gearbox. Only drives the tacho and engine note. */
const GEAR_RATIOS = [0.18, 0.34, 0.5, 0.67, 0.84, 1.0] as const;

/**
 * Torque against normalised speed.
 *
 * Peaks just off idle and tails off near the limiter, so acceleration feels
 * strong out of corners without the top end being unreachable.
 */
function torqueCurve(speedRatio: number): number {
  const r = clamp(speedRatio, 0, 1.2);
  if (r < 0.08) {
    // Soft launch so a standing start does not just spin the car.
    return 0.55 + (r / 0.08) * 0.45;
  }
  if (r > 1) return Math.max(0, 1 - (r - 1) * 6);
  return 1 - 0.42 * r * r;
}

export class VehicleSim {
  readonly state = createVehicleState();

  /** Steering angle after rate limiting, radians. Persisted across steps. */
  private currentSteer = 0;

  constructor(private tuning: CarTuning) {}

  setTuning(tuning: CarTuning): void {
    this.tuning = tuning;
  }

  reset(x: number, y: number, z: number, yaw: number): void {
    const s = this.state;
    s.x = x;
    s.y = y;
    s.z = z;
    s.yaw = yaw;
    s.vx = 0;
    s.vz = 0;
    s.vy = 0;
    s.yawRate = 0;
    s.vLong = 0;
    s.vLat = 0;
    s.speed = 0;
    s.slipAngle = 0;
    s.roll = 0;
    s.pitch = 0;
    s.wheelSpin = 0;
    s.steerAngle = 0;
    s.onGround = true;
    s.rpm = 0;
    s.gear = 1;
    this.currentSteer = 0;
  }

  /**
   * Advance one fixed step.
   *
   * `groundHeight` and `groundSlope` come from the track projection; the sim
   * stays agnostic about how they were obtained.
   */
  step(
    input: VehicleInput,
    dt: number,
    groundHeight: number,
    groundSlope: number,
  ): void {
    const s = this.state;
    const t = this.tuning;

    // --- local frame -------------------------------------------------------
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    const rx = fz;
    const rz = -fx;

    let vLong = s.vx * fx + s.vz * fz;
    let vLat = s.vx * rx + s.vz * rz;
    const speed = Math.hypot(vLong, vLat);

    // --- steering ----------------------------------------------------------
    // Authority falls off with speed, otherwise a flick at 300km/h spins the
    // car instantly and the top end becomes unusable.
    const speedRatio = clamp(speed / t.maxSpeed, 0, 1);
    const steerLimit =
      t.steerAngleMax * (1 - (1 - t.highSpeedSteerFactor) * speedRatio);
    const targetSteer = clamp(input.steer, -1, 1) * steerLimit;
    this.currentSteer = damp(this.currentSteer, targetSteer, t.steerRate, dt);
    s.steerAngle = this.currentSteer;

    // --- longitudinal ------------------------------------------------------
    const driveForce =
      clamp(input.throttle, 0, 1) *
      t.enginePower *
      torqueCurve(Math.abs(vLong) / t.maxSpeed);

    let aLong = driveForce / t.mass;

    // Brakes act against travel; below walking pace they let the car creep back.
    if (input.brake > 0.01) {
      if (vLong > 0.5) {
        aLong -= (input.brake * t.brakeForce) / t.mass;
      } else {
        // Held brake with no forward speed becomes reverse.
        aLong -= (input.brake * t.enginePower * 0.42) / t.mass;
      }
    }

    // Drag and rolling resistance.
    aLong -= (t.drag * vLong * Math.abs(vLong)) / t.mass;
    aLong -= (t.rollingResistance * sign0(vLong)) / t.mass;

    // Gravity along the slope: climbs cost speed, descents give it back.
    aLong -= GRAVITY * groundSlope;

    // Handbrake locks the rears: strong longitudinal scrub, little grip.
    if (input.handbrake) {
      aLong -= (sign0(vLong) * t.brakeForce * 0.35) / t.mass;
    }

    vLong += aLong * dt;
    vLong = clamp(vLong, -t.maxReverseSpeed, t.maxSpeed);

    // --- grip and yaw ------------------------------------------------------
    // Steering and lateral correction share one grip budget. Normal driving
    // limits yaw to what the tyres can track; the handbrake lowers rear grip and
    // permits a bounded amount of yaw beyond that budget, so intentional drift
    // still carries the car's existing world-space momentum.
    const load = 1 + t.downforce * speed * speed;
    const handbrakeFactor = input.handbrake ? t.handbrakeGripFactor : 1;
    const maxLatAccel = t.gripRear * handbrakeFactor * load;

    // Bicycle-model yaw rate, with a floor on the speed term so the car still
    // rotates when crawling.
    const effectiveLong = Math.abs(vLong) < 2 ? sign0(vLong) * 2 : vLong;
    let targetYawRate = (effectiveLong / t.wheelbase) * Math.tan(s.steerAngle);

    // A sliding rear end rotates the car further than steering alone would.
    const slideAssist = clamp(Math.abs(vLat) / 12, 0, 1);
    targetYawRate *= 1 + slideAssist * 0.55;

    // Track the grip limit during ordinary driving. With the handbrake down,
    // allow a controlled amount of excess yaw: enough to break rear traction,
    // but bounded so a drift initiation does not immediately become a spin.
    const trackingYawLimit = maxLatAccel / Math.max(Math.abs(vLong), 2);
    const yawLimit =
      trackingYawLimit * (input.handbrake ? HANDBRAKE_YAW_OVERDRIVE : 1);
    targetYawRate = clamp(targetYawRate, -yawLimit, yawLimit);

    // Front grip sets how quickly the car responds to the wheel.
    s.yawRate = damp(s.yawRate, targetYawRate, t.gripFront * 0.65, dt);
    s.yawRate = clamp(s.yawRate, -yawLimit, yawLimit);
    s.yaw = wrapAngle(s.yaw + s.yawRate * dt);

    // --- lateral grip ------------------------------------------------------
    // First preserve momentum in the pre-turn frame, then measure that velocity
    // in the new heading. Tyres spend their finite grip budget cancelling the
    // steering-created lateral component. Under the cap it reaches zero and the
    // car follows its nose; over the cap (most notably with the handbrake down)
    // the remainder survives as a real slip angle.
    const provisionalVx = fx * vLong + rx * vLat;
    const provisionalVz = fz * vLong + rz * vLat;

    const nextFx = Math.sin(s.yaw);
    const nextFz = Math.cos(s.yaw);
    const nextRx = nextFz;
    const nextRz = -nextFx;

    vLong = provisionalVx * nextFx + provisionalVz * nextFz;
    vLat = provisionalVx * nextRx + provisionalVz * nextRz;

    const neededLatAccel = -vLat / dt;
    const appliedLatAccel = clamp(neededLatAccel, -maxLatAccel, maxLatAccel);
    vLat += appliedLatAccel * dt;

    // --- back to world space -----------------------------------------------
    // Rebuilding from the post-yaw local frame applies only the lateral tyre
    // acceleration above. Residual slip remains world-space momentum rather than
    // snapping to the chassis heading.
    s.vx = nextFx * vLong + nextRx * vLat;
    s.vz = nextFz * vLong + nextRz * vLat;

    s.x += s.vx * dt;
    s.z += s.vz * dt;

    // --- vertical ----------------------------------------------------------
    // The road height arrives already interpolated along the centreline, so a
    // grounded car is placed exactly on the surface. An earlier version eased
    // toward it, which produced a steady-state error proportional to climb rate
    // — the car visibly sank into descents and floated over crests at speed.
    const targetY = groundHeight;
    if (s.y > targetY + AIRBORNE_CLEARANCE) {
      s.vy -= GRAVITY * dt;
      s.y += s.vy * dt;
      s.onGround = false;
      if (s.y <= targetY) {
        s.y = targetY;
        s.vy = 0;
        s.onGround = true;
      }
    } else {
      s.y = targetY;
      s.vy = 0;
      s.onGround = true;
    }

    // --- bookkeeping -------------------------------------------------------
    s.vLong = vLong;
    s.vLat = vLat;
    s.speed = Math.hypot(vLong, vLat);
    s.slipAngle = s.speed > 1.5 ? Math.atan2(vLat, Math.abs(vLong)) : 0;

    // Body roll from lateral load, pitch from acceleration. Visual only.
    const rollTarget = clamp(-appliedLatAccel / 30, -0.09, 0.09);
    s.roll = damp(s.roll, rollTarget, 7, dt);
    const pitchTarget = clamp(-aLong / 60, -0.045, 0.045);
    s.pitch = damp(s.pitch, pitchTarget, 6, dt);

    // Rolling radius comes from the car's own wheels so the visual spin rate
    // matches ground speed instead of a hardcoded guess.
    s.wheelSpin += (vLong / t.wheelRadius) * dt;

    // Simulated gearbox for the tacho and engine note.
    const ratio = clamp(Math.abs(vLong) / t.maxSpeed, 0, 1);
    let gearIndex = 0;
    while (gearIndex < GEAR_RATIOS.length - 1 && ratio > GEAR_RATIOS[gearIndex]!) {
      gearIndex += 1;
    }
    s.gear = gearIndex + 1;
    const low = gearIndex === 0 ? 0 : GEAR_RATIOS[gearIndex - 1]!;
    const high = GEAR_RATIOS[gearIndex]!;
    const inGear = high > low ? (ratio - low) / (high - low) : 0;
    s.rpm = clamp(0.16 + inGear * 0.84, 0, 1);
  }

  /**
   * Resolve contact with a wall.
   *
   * `normal` points away from the wall, into the road.
   *
   * The important detail is that only the velocity component *into* the wall is
   * cancelled. An earlier version also scaled total velocity by a constant every
   * step, which looked reasonable in isolation and was a disaster in practice: a
   * car steering gently into a barrier gets a fresh impact every step, so the
   * scale compounded and the car ground to a halt against the wall and could not
   * recover. Measured with the headless smoke test — 36% of a run was spent
   * crawling at under 5km/h.
   *
   * Now a graze keeps almost all of its longitudinal speed and the car scrapes
   * along the barrier, which is both the arcade-correct behaviour and stable.
   */
  applyWallImpact(normalX: number, normalZ: number, restitution: number): number {
    const s = this.state;
    const into = s.vx * normalX + s.vz * normalZ;
    if (into >= 0) return 0;

    // Split into wall-normal and wall-tangential components.
    const tangentX = -normalZ;
    const tangentZ = normalX;
    const along = s.vx * tangentX + s.vz * tangentZ;

    // Cancel the normal component, bounce back a little, and scrub the
    // tangential component only lightly — that is the scrape along the barrier.
    const bounce = -into * restitution;
    const scrubbed = along * 0.97;

    s.vx = normalX * bounce + tangentX * scrubbed;
    s.vz = normalZ * bounce + tangentZ * scrubbed;

    // Contact unsettles the car, but must not lock the steering out.
    s.yawRate *= 0.82;

    return Math.abs(into);
  }

  /**
   * Place the car back on the road facing forward.
   *
   * Used by the recovery timer when a car has come to rest somewhere it cannot
   * drive out of. Keeps a little forward speed so the player is rolling rather
   * than stationary.
   */
  recoverTo(x: number, y: number, z: number, yaw: number, speed: number): void {
    const s = this.state;
    s.x = x;
    s.y = y;
    s.z = z;
    s.yaw = yaw;
    s.vx = Math.sin(yaw) * speed;
    s.vz = Math.cos(yaw) * speed;
    s.vy = 0;
    s.yawRate = 0;
    s.vLong = speed;
    s.vLat = 0;
    s.speed = speed;
    s.slipAngle = 0;
    s.roll = 0;
    s.pitch = 0;
    this.currentSteer = 0;
  }

  /** Cheap separation impulse for car-to-car contact. */
  applyCarImpact(normalX: number, normalZ: number, strength: number): void {
    const s = this.state;
    s.vx += normalX * strength;
    s.vz += normalZ * strength;
    s.yawRate += (normalX * Math.cos(s.yaw) - normalZ * Math.sin(s.yaw)) * 0.35;
  }
}
