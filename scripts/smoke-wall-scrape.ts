#!/usr/bin/env tsx
/**
 * Wall scrape test.
 *
 * Hitting a barrier should cost you time, not end your race. The failure this
 * catches is a car that stops dead against the wall instead of scraping along it.
 *
 * It has happened twice, the same way both times: expressing the tangential loss
 * as a fraction of speed *per step*. `along * 0.97` reads as a 3% graze and is
 * 0.97^60 at 60Hz — 16% of speed retained per second of contact. Measured, that
 * took a car from 168km/h to 49km/h in one second and pinned it at 21km/h at full
 * throttle. Correct friction is proportional to the normal impulse absorbed, which
 * is also the only version that does not change with step count.
 *
 * So there are two assertions here, and the second is the one that matters
 * long-term: contact must cost speed *gradually*, and it must cost the same
 * regardless of how finely the contact is sliced into steps.
 */

import { DEFAULT_CAR } from "../src/game/config/cars";
import { getLevel } from "../src/game/config/levels";
import { RaceDirector } from "../src/game/race/RaceDirector";
import type { GameBridge } from "../src/game/types";

const bridge: GameBridge = { onEvent: () => {}, onTick: () => {} };

interface Run {
  contactSpeed: number;
  afterOneSecond: number;
  sustained: number;
  contacted: boolean;
  /** Did steering away from the barrier actually get the car off it? */
  recovered: boolean;
  recoverySeconds: number;
  speedAfterRecovery: number;
}

/**
 * Accelerate down the straight until the circuit's own curvature carries the car
 * into the barrier, then hold full throttle and lean on it.
 *
 * Deliberately not steered into the wall from a standstill: the interesting case is
 * arriving at racing speed, which is what a player actually does.
 */
function scrape(dt: number): Run {
  const director = new RaceDirector({
    level: getLevel("act1-harbor")!,
    carId: DEFAULT_CAR,
    seed: 7n,
    maxRivals: 0,
    bridge,
    practice: true,
  });
  director.beginCountdown();

  const state = director.player.sim.state;
  const steps = (seconds: number) => Math.round(seconds / dt);
  const drive = () =>
    director.setPlayerInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });

  let contactSpeed = -1;
  let contactAt = -1;
  let side = 0;
  const speeds: number[] = [];

  // Phase 1 and 2: arrive, then lean on the barrier for a few seconds.
  for (let step = 0; step < steps(20); step += 1) {
    drive();
    director.update(dt);
    if (!director.telemetry.offTrack) continue;

    if (contactAt < 0) {
      contactAt = step;
      contactSpeed = state.speed;
      side = Math.sign(director.telemetry.lateralOffset) || 1;
    }
    speeds.push(state.speed);
    if (speeds.length >= steps(4)) break;
  }

  // Phase 3: steer away from the wall. This is the property that matters — a
  // barrier you cannot drive off is a barrier that ended your race.
  let recovered = false;
  let recoverySteps = 0;
  for (let step = 0; step < steps(3); step += 1) {
    director.setPlayerInput({
      throttle: 1,
      brake: 0,
      steer: -side * 0.6,
      handbrake: false,
    });
    director.update(dt);
    recoverySteps = step + 1;
    if (!director.telemetry.offTrack) {
      recovered = true;
      break;
    }
  }

  const at = (seconds: number) =>
    speeds[Math.min(speeds.length - 1, steps(seconds))] ?? 0;

  // Average of the last second, so a momentary bounce does not read as recovery.
  const tail = speeds.slice(-steps(1));
  const sustained = tail.length > 0 ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;

  return {
    contactSpeed,
    afterOneSecond: at(1),
    sustained,
    contacted: contactAt >= 0,
    recovered,
    recoverySeconds: recoverySteps * dt,
    speedAfterRecovery: state.speed,
  };
}

const kph = (ms: number) => `${(ms * 3.6).toFixed(1)} km/h`;

const base = scrape(1 / 60);
const fine = scrape(1 / 120);

console.log("\n  Wall scrape — arriving at speed, full throttle, held on the barrier");
console.log("  " + "-".repeat(66));
console.log(`  speed at first contact          ${kph(base.contactSpeed)}`);
console.log(`  after 1s of contact             ${kph(base.afterOneSecond)}`);
console.log(`  sustained scrape                ${kph(base.sustained)}`);
console.log(`  retained                        ${((base.sustained / base.contactSpeed) * 100).toFixed(0)}%`);
console.log(
  `  steered off the wall            ${base.recovered ? `yes, in ${base.recoverySeconds.toFixed(2)}s` : "NO"}` +
    ` (then ${kph(base.speedAfterRecovery)})`,
);
console.log(`  sustained scrape at 120Hz       ${kph(fine.sustained)}`);

const failures: string[] = [];

if (!base.contacted) {
  failures.push("the car never reached the barrier — the test is not exercising anything");
}
if (base.contactSpeed < 25) {
  failures.push(`only reached ${kph(base.contactSpeed)} before contact; expected racing speed`);
}

// The car must keep moving. This is the symptom the player reported.
if (base.sustained < 8) {
  failures.push(`sustained scrape is only ${kph(base.sustained)} — the car is stopping, not slowing`);
}
if (base.sustained < base.contactSpeed * 0.25) {
  failures.push(
    `only ${((base.sustained / base.contactSpeed) * 100).toFixed(0)}% of speed survives a sustained scrape`,
  );
}
// ...but contact must still hurt, or the barrier becomes a guide rail to lean on.
if (base.sustained > base.contactSpeed * 0.9) {
  failures.push("a sustained scrape costs almost nothing — the barrier is free speed");
}
if (base.afterOneSecond < base.contactSpeed * 0.45) {
  failures.push(
    `lost ${((1 - base.afterOneSecond / base.contactSpeed) * 100).toFixed(0)}% of speed in the first second — too abrupt`,
  );
}
if (!base.recovered) {
  failures.push("steering away from the barrier did not get the car off it within 3s");
}

// Frame-rate independence. A per-step fraction fails this badly: halving the step
// squares the retention, so the 120Hz run would scrape far faster than the 60Hz one.
const ratio = fine.sustained / Math.max(base.sustained, 1e-6);
if (ratio < 0.7 || ratio > 1.4) {
  failures.push(
    `sustained scrape is ${ratio.toFixed(2)}x different at 120Hz — the friction term is frame-rate coupled`,
  );
}

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("\n  PASS — contact slows the car gradually, keeps it driveable, and does not depend on step rate.\n");
}
