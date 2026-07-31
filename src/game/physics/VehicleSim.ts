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
  /** Visual body roll and pitch, radians. `roll` includes the road's crossfall. */
  roll: number;
  pitch: number;
  /**
   * Body roll from cornering load alone, with the road's crossfall excluded.
   *
   * `roll` is what the car is drawn at, and through a banked corner most of it is
   * the road rather than the suspension. The view needs the two separated: leaning
   * on the springs lifts one side off the ground and has to be compensated for, but
   * matching the camber of a banked surface must not be.
   */
  bodyRoll: number;
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
    bodyRoll: 0,
    wheelSpin: 0,
    steerAngle: 0,
    onGround: true,
    rpm: 0,
    gear: 1,
  };
}

const GRAVITY = 9.81;



/**
 * Handbrake yaw may exceed the reduced rear-grip budget enough to create slip,
 * but not by enough to turn every initiated drift into an uncontrollable spin.
 */
const HANDBRAKE_YAW_OVERDRIVE = 1.85;

/**
 * Barrier friction: tangential speed lost per unit of normal impulse absorbed.
 *
 * 0.55 makes a glancing scrape cost a few m/s² — comparable to light braking —
 * while a square hit at 20m/s scrubs a large chunk of the speed along the wall in
 * one go.
 */
const WALL_FRICTION = 0.72;

/**
 * Rubbing loss while in contact, as a fraction of tangential speed per *second*.
 *
 * The Coulomb term above is proportional to the normal impulse the barrier
 * absorbs, and that is the right shape for an impact — but it is nearly zero for a
 * car that is merely touching a wall it does not need support from. Once the grip
 * budget was corrected to something like a real car's, that became the common case:
 * the tyres held the corner on their own, the barrier absorbed almost no impulse,
 * and a car could sit against concrete at 170km/h *gaining* speed under throttle.
 *
 * So contact also costs a rate. Bodywork grinding along a barrier scrubs speed
 * whether or not the car is leaning hard, and it scales with how fast the surfaces
 * are sliding past each other.
 *
 * Note the units, because this is the trap that has caught this file twice: a
 * fraction per *step* compounds with step count and is frame-rate coupled. A
 * fraction per second, multiplied by `dt`, is not — and because it is proportional
 * to tangential speed it also cannot drag the car to a halt, which is what a
 * constant deceleration would do at walking pace.
 */
const WALL_RUB_RATE = 0.26;

/**
 * Yaw disturbance from contact, as a fraction of yaw rate lost per *second*.
 *
 * Note the units, because this is the same trap the friction term above fell into
 * twice. It used to be `yawRate *= 1 - min(0.45, 0.05 * impact)` applied on every
 * step of contact — a fraction per step, so it compounds. Holding throttle and
 * steering into a barrier produces contact every step, and 0.55 per step at 60Hz is
 * 10^-16 of the original yaw rate after one second. The car could not rotate away
 * from the wall at all, which is precisely what "the steering does nothing when I'm
 * stuck on the side" is.
 *
 * A rate per second, multiplied by `dt`, is frame-rate independent and cannot
 * annihilate the steering. The cap is low on purpose: being unable to rotate off a
 * barrier is what makes one feel like glue.
 *
 * Units: fraction of yaw rate per second, per m/s of normal impulse. A hard hit
 * carries a large impulse for a step or two and genuinely unsettles the car; a
 * sustained scrape carries a small one every step and now barely touches the
 * steering, which is the case the player is trying to recover from.
 */
const WALL_YAW_DAMP_RATE = 0.16;
const WALL_YAW_DAMP_MAX = 0.35;

/**
 * Smallest speed contact pushes the car away from the wall at, m/s.
 *
 * Restitution alone is proportional to the impact, so a car sliding along a barrier
 * absorbs almost no normal impulse and is given almost no push — it stays exactly
 * flush against the concrete, step after step, and reads as sunk into it. A floor on
 * the separation speed means contact always *unsticks* the car, however gentle, and
 * the barrier stops behaving like a magnet.
 *
 * Small enough that it is a nudge rather than a bounce: 1.4m/s is walking pace and
 * clears the car's flank from the wall in about 30ms.
 */
const WALL_MIN_SEPARATION = 1.4;

/**
 * Extra yaw allowed while cornering on the throttle, as a multiple of the limit.
 *
 * This is the "lift the inside rear and rotate" behaviour that makes an arcade car
 * feel alive, and the only reason a slight drift appears when the player holds
 * throttle and steering together. The excess beyond what the tyres can track cannot
 * be cancelled by them, so it survives as a real slip angle — which is also what the
 * drift scoring reads.
 *
 * Kept modest. The handbrake is still the way to provoke a proper slide; this is a
 * hint of oversteer, not a drift button.
 */
const POWER_OVERSTEER = 1.16;
/** Throttle and steering above which power oversteer starts to apply. */
const POWER_OVERSTEER_THROTTLE = 0.5;
const POWER_OVERSTEER_STEER = 0.2;

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

  /**
   * Last two derivatives of the surface height under the car.
   *
   * Kept so the step can tell a road that is falling away from a car that has
   * genuinely been launched. `surfaceTracked` guards the first step, where there is
   * no previous surface to difference against and a bogus acceleration would
   * otherwise launch every car off the grid.
   */
  private lastSurfaceY = 0;
  private lastSurfaceVy = 0;
  private surfaceTracked = false;

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
    s.bodyRoll = 0;
    s.wheelSpin = 0;
    s.steerAngle = 0;
    s.onGround = true;
    s.rpm = 0;
    s.gear = 1;
    this.currentSteer = 0;
    this.surfaceTracked = false;
  }

  /**
   * Advance one fixed step.
   *
   * `groundHeight`, `groundSlope` and `groundBanking` come from the track
   * projection; the sim stays agnostic about how they were obtained.
   *
   * `groundBanking` is the road's crossfall in radians, positive when the
   * right-hand edge is the high one.
   */
  step(
    input: VehicleInput,
    dt: number,
    groundHeight: number,
    groundSlope: number,
    groundBanking = 0,
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

    // --- grip budget -------------------------------------------------------
    // Computed before steering, because how much lock is useful depends on how
    // much lateral acceleration the tyres can actually deliver.
    //
    // `downforce` is deliberately small. It was 0.0021, which multiplies grip by
    // 15.1 at 82m/s: a peak of 183m/s², or 18.6g. At that budget the yaw limit
    // never binds, so any flick of the wheel was answered instantly with a
    // fighter-jet change of direction, and the car was uncontrollable at speed
    // for a reason that had nothing to do with steering. 1.23g at rest rising to
    // 1.9g flat out is a fast GT.
    const load = 1 + t.downforce * speed * speed;
    /** What the tyres can do with all four planted, m/s². */
    const gripLimit = t.gripRear * load;
    const handbrakeFactor = input.handbrake ? t.handbrakeGripFactor : 1;
    const maxLatAccel = gripLimit * handbrakeFactor;
    // Yaw allowed beyond what the tyres can track. The handbrake gets a lot;
    // cornering on the throttle gets a little, which is where the slight drift on
    // "forward and turn" comes from.
    const onPower =
      clamp(input.throttle, 0, 1) > POWER_OVERSTEER_THROTTLE &&
      Math.abs(input.steer) > POWER_OVERSTEER_STEER;
    const yawOverdrive = input.handbrake
      ? HANDBRAKE_YAW_OVERDRIVE
      : onPower
        ? POWER_OVERSTEER
        : 1;
    /** Yaw rate ceiling this step, rad/s. The steering lock is derived from it. */
    const yawBudget = maxLatAccel * yawOverdrive;

    // --- steering ----------------------------------------------------------
    // Lock is limited by what the tyres can use, not by a taper against top
    // speed. Useful lock falls with the *square* of speed, because the Ackermann
    // angle for a given lateral acceleration is `wheelbase * a / v²`.
    //
    // The lock has to be derived from the yaw budget the step will actually
    // allow, and this is where the wheel went dead at speed. It used to be
    // derived from `gripLimit * steerLockMargin` with the margin at 1.6, while
    // the yaw rate below is clamped to what the tyres can *track*. Full lock
    // therefore commanded 1.6x a ceiling it could not pass, so the clamp bound at
    // 62% of stick travel and the last 38% of the wheel did nothing at all — at
    // 82m/s, a car that answered a flick and then ignored the rest of the input.
    // Worse under the handbrake, where the lock ignored the reduced rear grip
    // entirely and saturated within a third of the range.
    //
    // Deriving it from `yawBudget` makes full stick mean exactly "as much
    // rotation as this car can give at this speed", at every speed and with or
    // without the handbrake. `steerLockMargin` is now only the headroom needed
    // for the clamp to be reachable through the rack and yaw lags rather than
    // approached asymptotically, so it sits just above 1.
    const gripSteer = Math.atan(
      (t.wheelbase * yawBudget * t.steerLockMargin) / Math.max(vLong * vLong, 4),
    );
    const steerLimit = Math.min(t.steerAngleMax, gripSteer);
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

    // --- yaw ---------------------------------------------------------------
    // Steering and lateral correction share the grip budget computed above.
    // Normal driving limits yaw to what the tyres can track; the handbrake lowers
    // rear grip and permits a bounded amount of yaw beyond that budget, so
    // intentional drift still carries the car's existing world-space momentum.
    //
    // Bicycle-model yaw rate, with a floor on the speed term so the car still
    // rotates when crawling.
    const effectiveLong = Math.abs(vLong) < 2 ? sign0(vLong) * 2 : vLong;
    let targetYawRate = (effectiveLong / t.wheelbase) * Math.tan(s.steerAngle);

    // A sliding rear end rotates the car further than steering alone would.
    const slideAssist = clamp(Math.abs(vLat) / 12, 0, 1);
    targetYawRate *= 1 + slideAssist * 0.55;

    // Track the grip limit during ordinary driving. With the handbrake down,
    // `yawOverdrive` allows a controlled amount of excess yaw: enough to break
    // rear traction, but bounded so a drift initiation does not become a spin.
    // The steering lock above is derived from this same budget, which is what
    // keeps the whole range of the wheel proportional.
    const yawLimit = yawBudget / Math.max(Math.abs(vLong), 2);
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

    // Gravity across a banked surface, before the tyres get a say. With the
    // right-hand edge high the car is pulled left, so the component along the
    // car's right axis is negative. The layout banks into every corner, so this
    // is what lets a committed line through a bend actually pay off instead of
    // the banking being decoration.
    if (s.onGround) vLat += -GRAVITY * Math.sin(groundBanking) * dt;

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
    // A grounded car sits exactly on the surface it was handed. It leaves that
    // surface only when the surface itself falls away faster than gravity can pull
    // the car down — that is, when the road's own downward acceleration exceeds g.
    //
    // The previous test was "is the car more than 120mm above the surface", and it
    // cannot work now that the surface height accounts for the road's crossfall.
    // This layout banks 4.87° across a road up to 15.2m wide, so simply changing
    // line across a banked corner moves the target by up to a metre. The car was
    // declared airborne every time and left to fall, which at speed read as the car
    // flying. Comparing accelerations is the honest test, and it is immune to the
    // car's own lateral motion because that motion is smooth: it is the *second*
    // derivative that has to be large, and only a sharp crest produces one.
    const targetY = groundHeight;
    const surfaceVy = this.surfaceTracked ? (targetY - this.lastSurfaceY) / dt : 0;
    const surfaceAccel = this.surfaceTracked ? (surfaceVy - this.lastSurfaceVy) / dt : 0;
    this.lastSurfaceY = targetY;
    this.lastSurfaceVy = surfaceVy;
    this.surfaceTracked = true;

    if (s.onGround && surfaceAccel < -GRAVITY) {
      // A crest sharp enough to throw the car off it. The car keeps the surface's
      // vertical velocity, so it leaves the road along the tangent rather than
      // popping upward.
      s.onGround = false;
      s.vy = surfaceVy;
    }

    if (s.onGround) {
      s.y = targetY;
      s.vy = 0;
    } else {
      s.vy -= GRAVITY * dt;
      s.y += s.vy * dt;
      if (s.y <= targetY) {
        s.y = targetY;
        s.vy = 0;
        s.onGround = true;
      }
    }

    // --- bookkeeping -------------------------------------------------------
    s.vLong = vLong;
    s.vLat = vLat;
    s.speed = Math.hypot(vLong, vLat);
    s.slipAngle = s.speed > 1.5 ? Math.atan2(vLat, Math.abs(vLong)) : 0;

    // Body roll from lateral load, pitch from acceleration. Visual only.
    //
    // A car leans *away* from the corner: in a right-hander the tyres push the
    // chassis right, the sprung mass rolls left, and the right-hand side lifts.
    // `CarView` rotates about the car's forward axis where a positive angle lifts
    // the right side, so this term is positive. It used to be negated, which
    // leaned the car into every corner like a motorcycle.
    //
    // Banking is added on top so the body sits parallel to the road through a
    // banked corner instead of upright on a tilted plane.
    // Suspension roll is tracked on its own as well as folded into the total. The
    // view has to lift the car by however far leaning on the springs would push a
    // wheel through the road, and the crossfall term must not contribute to that:
    // a car sitting parallel to a 4.9° banked corner is resting on all four tyres,
    // not leaning off one of them.
    const bodyRollTarget = clamp(appliedLatAccel / 30, -0.09, 0.09);
    const rollTarget = bodyRollTarget + (s.onGround ? groundBanking : 0);
    s.bodyRoll = damp(s.bodyRoll, bodyRollTarget, 7, dt);
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
   * Only the velocity component *into* the wall is cancelled; the component along
   * it survives, minus friction. Getting that friction term right is the whole
   * difficulty, and it has been wrong twice in the same way.
   *
   * The trap is expressing the loss as a fraction of tangential speed *per step*.
   * A car leaning on a barrier gets a fresh contact every step, so the fraction
   * compounds: `along * 0.97` reads as a 3% graze and is 0.97^60 — 16% of speed
   * retained per second of contact at 60Hz. Measured, that took a car from
   * 168km/h to 49km/h in one second and then pinned it against the wall at 21km/h
   * at full throttle, unable to recover. It is also frame-rate coupled, so the
   * same contact costs a different amount at a different step count.
   *
   * The fix is Coulomb friction: tangential loss proportional to the *normal
   * impulse the barrier actually absorbs*. A real impact costs a lot and costs it
   * once, and it does not depend on how many steps the contact was sliced into —
   * because for a sustained push the per-step impulse already scales with `dt`.
   *
   * Coulomb alone turned out not to be enough, though, and the reason is
   * instructive. It only charges for contact the car *needs*: once the grip budget
   * was corrected from a fictional 18g down to 1.9g, the tyres could hold most
   * corners unaided, the barrier absorbed almost no impulse, and a car could sit
   * against concrete at 170km/h and accelerate. So there is a second term for the
   * rubbing itself — see `WALL_RUB_RATE`, which is a fraction of tangential speed
   * per *second*, not per step.
   */
  applyWallImpact(
    normalX: number,
    normalZ: number,
    restitution: number,
    dt: number,
  ): number {
    const s = this.state;
    const into = s.vx * normalX + s.vz * normalZ;
    if (into >= 0) return 0;

    // Split into wall-normal and wall-tangential components.
    const tangentX = -normalZ;
    const tangentZ = normalX;
    const along = s.vx * tangentX + s.vz * tangentZ;

    /** Normal impulse absorbed this step, m/s. */
    const impact = -into;

    // Two losses: one proportional to the impulse the barrier absorbed, which is
    // what makes a real hit expensive, and one proportional to how fast the
    // bodywork is sliding along it, which is what makes leaning on a barrier cost
    // something even when the tyres are carrying the corner unaided.
    //
    // Capped at the tangential speed itself, so friction can slow the car along
    // the wall but can never drag it backwards.
    // Bounce out along the normal, but never by less than `WALL_MIN_SEPARATION`.
    // A hard hit is dominated by restitution and reads as a real rebound; a graze
    // gets the floor, which is what stops the car sitting flush against the
    // concrete for as long as the player holds the wheel into it.
    const separation = Math.max(impact * restitution, WALL_MIN_SEPARATION);

    // Coulomb friction is charged on the *whole* change in normal velocity, the
    // push-off included — not just on the arriving impact. That is what makes the
    // separation floor pay for itself: without it, nudging the car off the wall
    // ended contact before the friction term could accumulate, and a barrier became
    // a free guide rail worth 120% of the speed the car arrived at.
    const normalImpulse = impact + separation;
    const scrub = Math.min(
      Math.abs(along),
      WALL_FRICTION * normalImpulse + WALL_RUB_RATE * Math.abs(along) * dt,
    );
    const remaining = along - sign0(along) * scrub;

    s.vx = normalX * separation + tangentX * remaining;
    s.vz = normalZ * separation + tangentZ * remaining;

    // Contact unsettles the car in proportion to how hard it landed, as a rate per
    // second rather than per step — see `WALL_YAW_DAMP_RATE`. Bounded so a scrape
    // can never take the steering away, because being unable to rotate off a wall
    // is what makes a barrier feel like glue.
    const yawLoss = Math.min(WALL_YAW_DAMP_MAX, WALL_YAW_DAMP_RATE * impact * dt);
    s.yawRate *= 1 - yawLoss;

    return impact;
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
    s.bodyRoll = 0;
    // Recovery pauses the cinematic before another physics step. Reset the public
    // angle as well as the private rack state or the front wheels remain frozen at
    // their pre-recovery lock and appear edge-on in the orbiting recovery camera.
    s.steerAngle = 0;
    this.currentSteer = 0;
    // Every other field the view reads is zeroed here; this one was not, so a
    // recovered car kept whatever spin angle it had when it stopped. `reset` has
    // always cleared it, and a car being placed back on the line should present
    // the same clean pose as one on the grid — a respawn is the one moment the
    // player is looking straight at a stationary wheel.
    s.wheelSpin = 0;
    // A recovered car is placed somewhere else entirely; differencing against the
    // surface it left would launch it.
    this.surfaceTracked = false;
  }

  /** Cheap separation impulse for car-to-car contact. */
  applyCarImpact(normalX: number, normalZ: number, strength: number): void {
    const s = this.state;
    s.vx += normalX * strength;
    s.vz += normalZ * strength;
    s.yawRate += (normalX * Math.cos(s.yaw) - normalZ * Math.sin(s.yaw)) * 0.35;
  }
}
