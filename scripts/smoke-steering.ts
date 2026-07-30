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

import { InputManager } from "../src/game/engine/Input";

const STEP = 1 / 60;

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

input.detach(target);

console.log("\n  Steering mechanics\n  " + "-".repeat(52));
for (const [label, value] of rows) console.log(`  ${label.padEnd(32)}${value}`);

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("\n  PASS — the wheel self-centres and loads up with speed.\n");
}
