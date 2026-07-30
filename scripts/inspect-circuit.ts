#!/usr/bin/env tsx
/**
 * Circuit report.
 *
 * Prints the geometry the campaign is calibrated against — lap distance, tightest
 * radius, steepest gradient, width range — plus the sanity checks that would
 * otherwise only fail as strange driving: uneven sample spacing, a seam at the
 * start/finish join, or a layout that crosses itself.
 */

import { Track } from "../src/game/track/Track";
import { buildRoute } from "../src/game/track/layout";

const route = buildRoute();
const track = new Track();

const curvatures = track.samples.map((s) => Math.abs(s.curvature));
const slopes = track.samples.map((s) => Math.abs(s.slope));
const widths = track.samples.map((s) => s.halfWidth);
const banking = track.samples.map((s) => Math.abs(s.banking));
const elevations = track.samples.map((s) => s.y);

let minGap = Infinity;
let maxGap = 0;
for (let i = 0; i < track.samples.length; i += 1) {
  const a = track.samples[i]!;
  const b = track.samples[(i + 1) % track.samples.length]!;
  const gap = Math.hypot(a.x - b.x, a.z - b.z);
  minGap = Math.min(minGap, gap);
  maxGap = Math.max(maxGap, gap);
}

/** Nearest approach between non-adjacent parts of the lap. */
let closest = Infinity;
let closestAt = 0;
const n = track.samples.length;
for (let i = 0; i < n; i += 1) {
  for (let j = i + 24; j < n; j += 1) {
    if (Math.min(j - i, n - (j - i)) < 24) continue;
    const a = track.samples[i]!;
    const b = track.samples[j]!;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < closest) {
      closest = d;
      closestAt = i;
    }
  }
}

const rows: [string, string][] = [
  ["lap distance", `${(route.length / 1000).toFixed(3)} km`],
  ["samples", `${route.samples.length} @ ${route.sampleSpacing.toFixed(3)}m`],
  ["sample gap", `${minGap.toFixed(3)}m – ${maxGap.toFixed(3)}m`],
  ["tightest radius", `${(1 / Math.max(...curvatures)).toFixed(1)}m`],
  ["steepest gradient", `${(Math.max(...slopes) * 100).toFixed(2)}%`],
  ["elevation range", `${(Math.max(...elevations) - Math.min(...elevations)).toFixed(1)}m`],
  ["road width", `${(Math.min(...widths) * 2).toFixed(1)}m – ${(Math.max(...widths) * 2).toFixed(1)}m`],
  ["max banking", `${((Math.max(...banking) * 180) / Math.PI).toFixed(2)}°`],
  ["bounds radius", `${track.boundsRadius.toFixed(0)}m`],
  ["checkpoints", `${track.checkpointIndices.length}`],
  ["closest self-approach", `${closest.toFixed(1)}m at sample ${closestAt}`],
];

console.log("\n  APEX International\n  " + "-".repeat(46));
for (const [label, value] of rows) {
  console.log(`  ${label.padEnd(24)}${value}`);
}

const failures: string[] = [];
if (Math.abs(maxGap - minGap) > 0.35) failures.push("sample spacing is uneven");
if (closest < Math.max(...widths) * 2 + 6) {
  failures.push(`layout self-approaches to ${closest.toFixed(1)}m, which the road would overlap`);
}
if (Math.max(...slopes) > 0.14) failures.push("gradient exceeds 14%");
if (1 / Math.max(...curvatures) < 18) failures.push("a corner is tighter than 18m radius");

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("\n  OK — geometry is drivable and the lap closes cleanly.\n");
}
