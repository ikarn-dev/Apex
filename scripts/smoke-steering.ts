#!/usr/bin/env tsx
/**
 * Steering feel test.
 *
 * The complaint this exists for: releasing the keys did not return the wheel to
 * straight. That is the one property a car must have, and it is easy to break
 * silently — an exponential damp gets close to zero without ever arriving, and a
 * taper applied to the output rather than the wheel position leaves the two
 * disagreeing.
 *
 * So this drives the input manager directly and asserts the mechanics:
 * self-centring, centring faster than winding on, both scaling with speed, and a
 * heavier wheel the faster you go.
 */

import { CARS, DEFAULT_CAR } from "../src/game/config/cars";
import { InputManager } from "../src/game/engine/Input";
import { VehicleSim, type VehicleInput } from "../src/game/physics/VehicleSim";

const STEP = 1 / 60;

const car = CARS[DEFAULT_CAR];

/** Lateral acceleration the tyres can deliver at a speed, m/s². */
function gripAt(speed: number): number {
  return car.tuning.gripRear * (1 + car.tuning.downforce * speed * speed);
}

/** A car already at `speed` on flat, unbanked road, pointing down +Z. */
function carAtSpeed(speed: number): VehicleSim {
  const sim = new VehicleSim(car.tuning);
  sim.reset(0, 0, 0, 0);
  const s = sim.state;
  s.vz = speed;
  s.vLong = speed;
  s.speed = speed;
  return sim;
}

/**
 * Hold a stick position for `seconds` and report the yaw rate it settles at.
 *
 * Speed is pinned between steps rather than left to the throttle. The yaw ceiling
 * is a function of speed, so a car that accelerates while the yaw rate is still
 * ramping in measures its own acceleration as a steering deficiency — the first
 * version of this test read 90% at 40 m/s for exactly that reason.
 */
function settledYawRate(stick: number, speed: number, seconds = 2.5): number {
  const sim = carAtSpeed(speed);
  const input: VehicleInput = { throttle: 0, brake: 0, steer: stick, handbrake: false };
  let peak = 0;
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    sim.step(input, STEP, 0, 0, 0);
    const s = sim.state;
    const scale = speed / (Math.hypot(s.vx, s.vz) || 1);
    s.vx *= scale;
    s.vz *= scale;
    peak = Math.max(peak, Math.abs(s.yawRate));
  }
  return peak;
}

/** Hold a direction for `seconds`, then report the wheel position. */
function wind(input: InputManager, code: string, seconds: number, speed: number): number {
  press(code);
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) input.sample(STEP, speed);
  return input.steerPosition;
}

/** Release everything and report how long the wheel takes to reach centre. */
function timeToCentre(input: InputManager, speed: number): number {
  releaseAll();
  let elapsed = 0;
  for (let i = 0; i < 600; i += 1) {
    input.sample(STEP, speed);
    elapsed += STEP;
    if (input.steerPosition === 0) return elapsed;
  }
  return Infinity;
}

// The manager listens on a target we control, so a plain event shim is enough.
const listeners = new Map<string, ((event: unknown) => void)[]>();
const target = {
  addEventListener: (type: string, handler: (event: unknown) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), handler]);
  },
  removeEventListener: () => {},
} as unknown as Window;

function press(code: string): void {
  for (const handler of listeners.get("keydown") ?? []) {
    handler({ code, preventDefault: () => {} });
  }
}
function releaseAll(): void {
  for (const code of ["ArrowLeft", "ArrowRight", "KeyA", "KeyD"]) {
    for (const handler of listeners.get("keyup") ?? []) handler({ code });
  }
}

const input = new InputManager();
input.attach(target);

const failures: string[] = [];
const rows: [string, string][] = [];

// --- self-centring at rest ---------------------------------------------------
const heldSlow = wind(input, "ArrowRight", 1.0, 5);
const centreSlow = timeToCentre(input, 5);
rows.push(["wheel after 1.0s held (5 m/s)", heldSlow.toFixed(3)]);
rows.push(["returns to centre in", `${centreSlow.toFixed(2)}s`]);
if (heldSlow <= 0.2) failures.push("holding a key barely turns the wheel");
if (!Number.isFinite(centreSlow)) failures.push("the wheel never returns to centre");
if (centreSlow > 0.6) failures.push(`centring takes ${centreSlow.toFixed(2)}s, far too slow`);

// --- self-centring is stronger at speed --------------------------------------
input.reset();
releaseAll();
wind(input, "ArrowRight", 1.0, 50);
const centreFast = timeToCentre(input, 50);
rows.push(["returns to centre at 50 m/s", `${centreFast.toFixed(2)}s`]);
if (centreFast >= centreSlow) {
  failures.push("self-centring does not strengthen with speed");
}

// --- the wheel is heavier at speed -------------------------------------------
input.reset();
releaseAll();
const heldFast = wind(input, "ArrowRight", 0.25, 50);
input.reset();
releaseAll();
const heldRest = wind(input, "ArrowRight", 0.25, 0);
rows.push(["0.25s of lock at rest / 50 m/s", `${heldRest.toFixed(3)} / ${heldFast.toFixed(3)}`]);
if (Math.abs(heldFast) >= Math.abs(heldRest)) {
  failures.push("the wheel is not heavier at speed");
}

// --- centring is quicker than winding on -------------------------------------
input.reset();
releaseAll();
const quarter = Math.abs(wind(input, "ArrowRight", 0.25, 20));
const backFromQuarter = timeToCentre(input, 20);
rows.push(["wind on 0.25s, unwind in", `${backFromQuarter.toFixed(3)}s`]);
if (backFromQuarter >= 0.25) failures.push("unwinding is slower than winding on");

// --- counter-steer passes through centre -------------------------------------
input.reset();
releaseAll();
wind(input, "ArrowRight", 1.0, 20);
releaseAll();
const counter = wind(input, "ArrowLeft", 0.12, 20);
rows.push(["counter-steer after 0.12s", counter.toFixed(3)]);
if (counter >= quarter) failures.push("counter-steering does not unwind the wheel");

// --- the car answers the wheel at speed --------------------------------------
//
// The reported bug: at high speed the left and right controls "don't really
// work". Two causes, and neither shows up in the wheel mechanics above. The lock
// was derived from the grip budget times a 1.6 margin while the yaw rate was
// clamped to the tracking limit, so the clamp bound at 62% of stick travel and
// the rest of the wheel did nothing; and only 1.9g of grip at top speed put the
// minimum radius at 361m. So this drives `VehicleSim` directly and asserts that
// full stick reaches the tyres' limit, that the stick is proportional, and that
// the whole input chain answers quickly enough to be usable.

const carRows: [string, string][] = [];
const topSpeed = car.tuning.maxSpeed;

for (const speed of [40, 70, topSpeed]) {
  const full = settledYawRate(1, speed);
  const half = settledYawRate(0.5, speed);
  const ceiling = gripAt(speed) / speed;
  const reached = full / ceiling;
  const share = full > 1e-6 ? half / full : 0;
  const radius = full > 1e-6 ? speed / full : Infinity;

  carRows.push([
    `${speed.toFixed(0)} m/s full/half lock`,
    `${full.toFixed(3)} / ${half.toFixed(3)} rad/s, ${(reached * 100).toFixed(0)}% of grip, ` +
      `R${radius.toFixed(0)}m`,
  ]);

  if (reached < 0.92) {
    failures.push(
      `at ${speed} m/s full lock only reaches ${(reached * 100).toFixed(0)}% of the ` +
        `grip-limited yaw rate — part of the wheel's travel does nothing`,
    );
  }
  if (share < 0.42 || share > 0.58) {
    failures.push(
      `at ${speed} m/s half lock gives ${(share * 100).toFixed(0)}% of full lock's yaw ` +
        `rate — the wheel is not proportional`,
    );
  }
}

// --- a slight drift when cornering on the throttle ---------------------------
//
// Holding throttle and steering together should rotate the car a little further
// than the tyres can track, so the excess survives as a real slip angle. That is
// the "slight drift" the car is supposed to have; the handbrake remains the way to
// provoke a proper slide.

/** Peak slip angle from holding a stick position at a speed, degrees. */
function settledSlip(stick: number, throttle: number, speed: number): number {
  const sim = carAtSpeed(speed);
  const input: VehicleInput = { throttle, brake: 0, steer: stick, handbrake: false };
  let peak = 0;
  for (let i = 0; i < 150; i += 1) {
    sim.step(input, STEP, 0, 0, 0);
    const s = sim.state;
    const scale = speed / (Math.hypot(s.vx, s.vz) || 1);
    s.vx *= scale;
    s.vz *= scale;
    peak = Math.max(peak, Math.abs((s.slipAngle * 180) / Math.PI));
  }
  return peak;
}

{
  const coasting = settledSlip(1, 0, 45);
  const onPower = settledSlip(1, 1, 45);
  const handbrake = (() => {
    const sim = carAtSpeed(45);
    let peak = 0;
    for (let i = 0; i < 150; i += 1) {
      sim.step({ throttle: 1, brake: 0, steer: 1, handbrake: true }, STEP, 0, 0, 0);
      const s = sim.state;
      const scale = 45 / (Math.hypot(s.vx, s.vz) || 1);
      s.vx *= scale;
      s.vz *= scale;
      peak = Math.max(peak, Math.abs((s.slipAngle * 180) / Math.PI));
    }
    return peak;
  })();

  carRows.push([
    "slip: coast / power / handbrake",
    `${coasting.toFixed(1)}° / ${onPower.toFixed(1)}° / ${handbrake.toFixed(1)}°`,
  ]);

  if (onPower <= coasting + 0.5) {
    failures.push(
      `cornering on the throttle slips ${onPower.toFixed(1)}° against ${coasting.toFixed(1)}° ` +
        `coasting — there is no power oversteer at all`,
    );
  }
  if (onPower > 12) {
    failures.push(
      `cornering on the throttle slips ${onPower.toFixed(1)}° — that is a slide, not the ` +
        `slight drift it is meant to be`,
    );
  }
  if (handbrake <= onPower) {
    failures.push(
      `the handbrake (${handbrake.toFixed(1)}°) no longer provokes more slip than the ` +
        `throttle alone (${onPower.toFixed(1)}°)`,
    );
  }
}

const topRadius = topSpeed / settledYawRate(1, topSpeed);
carRows.push(["minimum radius at top speed", `${topRadius.toFixed(0)}m`]);
if (topRadius > 330) {
  failures.push(
    `the car needs ${topRadius.toFixed(0)}m to turn at top speed — it cannot change ` +
      `direction on a circuit whose tightest corner is 36m`,
  );
}

// End to end: keyboard through the wheel model, the rack and the yaw damp, which
// is the path the player actually feels.
{
  input.reset();
  releaseAll();
  const sim = carAtSpeed(topSpeed);
  const target = settledYawRate(1, topSpeed) * 0.9;
  press("ArrowRight");
  let elapsed = Infinity;
  let t = 0;
  for (let i = 0; i < 240; i += 1) {
    sim.step(input.sample(STEP, sim.state.speed), STEP, 0, 0, 0);
    t += STEP;
    if (Math.abs(sim.state.yawRate) >= target) {
      elapsed = t;
      break;
    }
  }
  releaseAll();
  carRows.push(["keys to 90% of that yaw", Number.isFinite(elapsed) ? `${elapsed.toFixed(2)}s` : "never"]);
  if (!(elapsed <= 0.75)) {
    failures.push(
      `holding a steering key at top speed takes ${
        Number.isFinite(elapsed) ? `${elapsed.toFixed(2)}s` : "forever"
      } to reach 90% of the available yaw rate`,
    );
  }
}

input.detach(target);

console.log("\n  Steering mechanics\n  " + "-".repeat(52));
for (const [label, value] of rows) console.log(`  ${label.padEnd(32)}${value}`);
console.log("\n  Steering authority at speed\n  " + "-".repeat(52));
for (const [label, value] of carRows) console.log(`  ${label.padEnd(32)}${value}`);

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log(
    "\n  PASS — the wheel self-centres, loads up with speed, and the car answers " +
      "all of it.\n",
  );
}
