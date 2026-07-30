#!/usr/bin/env tsx
/**
 * Containment test.
 *
 * The failure this exists to catch: a car leaving the circuit and never coming
 * back. It happened, it is invisible to the normal smoke test (a reference driver
 * that stays on the racing line never probes the barrier), and it is the single
 * worst bug a racing game can have — the player ends up in an empty field with no
 * way to rejoin.
 *
 * So this drives *badly* on purpose. Four adversarial policies, each designed to
 * put the car through a wall, and after every step it asserts that the car is
 * still inside the barrier line and still on the road surface.
 */

import { CARS, DEFAULT_CAR } from "../src/game/config/cars";
import { getLevel } from "../src/game/config/levels";
import { FIXED_STEP, RaceDirector } from "../src/game/race/RaceDirector";
import { Track } from "../src/game/track/Track";
import type { VehicleInput } from "../src/game/physics/VehicleSim";
import type { GameBridge } from "../src/game/types";

const track = new Track();
const car = CARS[DEFAULT_CAR];

/** The barrier's inner face. Nothing may ever be outside this. */
const BARRIER = track.samples.map((s) => s.halfWidth);

const bridge: GameBridge = { onEvent: () => {}, onTick: () => {} };

interface Policy {
  name: string;
  input(step: number): VehicleInput;
}

const POLICIES: Policy[] = [
  {
    name: "full throttle, hard left",
    input: () => ({ throttle: 1, brake: 0, steer: -1, handbrake: false }),
  },
  {
    name: "full throttle, hard right",
    input: () => ({ throttle: 1, brake: 0, steer: 1, handbrake: false }),
  },
  {
    name: "flat out, slaloming into the walls",
    input: (step) => ({
      throttle: 1,
      brake: 0,
      steer: Math.sin(step / 22) > 0 ? 1 : -1,
      handbrake: false,
    }),
  },
  {
    name: "handbrake spins at full speed",
    input: (step) => ({
      throttle: step % 240 < 170 ? 1 : 0,
      brake: 0,
      steer: step % 240 < 170 ? 0 : 1,
      handbrake: step % 240 >= 170,
    }),
  },
];

let failures = 0;
const STEPS = 60 * 150;

console.log("\n  Containment — adversarial driving\n  " + "-".repeat(56));

for (const policy of POLICIES) {
  const level = getLevel("endless-time-attack")!;
  const director = new RaceDirector({
    level,
    carId: DEFAULT_CAR,
    seed: 99n,
    maxRivals: 0,
    bridge,
    practice: true,
  });
  director.beginCountdown();

  let worstOutside = 0;
  let worstOutsideAt = -1;
  let worstDrop = 0;
  const player = director.player;

  for (let step = 0; step < STEPS; step += 1) {
    director.setPlayerInput(policy.input(step));
    director.update(FIXED_STEP);

    const state = player.sim.state;
    // Global search on purpose: a test that trusts the hint would reproduce the
    // very bug it is checking for.
    const projection = track.project(state.x, state.z, -1);
    const limit = BARRIER[projection.index]!;

    // The car's flank, not its centre.
    const outside = Math.abs(projection.lateral) + car.tuning.halfWidth - limit;
    if (outside > worstOutside) {
      worstOutside = outside;
      worstOutsideAt = step;
    }

    const drop = projection.height - state.y;
    if (drop > worstDrop) worstDrop = drop;
  }

  // Tolerance covers one step of penetration before the solver reacts: at 82m/s
  // a step is 1.37m of travel, and only the lateral part of that can leak.
  const outsideOk = worstOutside <= 0.35;
  const heightOk = worstDrop <= 3;
  if (!outsideOk || !heightOk) failures += 1;

  console.log(
    `  ${outsideOk && heightOk ? "ok  " : "FAIL"}  ${policy.name.padEnd(38)}` +
      `max ${worstOutside <= 0 ? "inside" : `${worstOutside.toFixed(2)}m past barrier`}` +
      (worstOutsideAt >= 0 && worstOutside > 0.35 ? ` @ step ${worstOutsideAt}` : "") +
      `, max drop ${worstDrop.toFixed(2)}m`,
  );
}

if (failures > 0) {
  console.error(`\n  FAIL — ${failures} of ${POLICIES.length} policies escaped the circuit.\n`);
  process.exitCode = 1;
} else {
  console.log(
    `\n  PASS — the car stayed inside the barriers and on the surface under all ` +
      `${POLICIES.length} policies.\n`,
  );
}
