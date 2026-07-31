#!/usr/bin/env tsx
/**
 * Scenery placement test.
 *
 * Two failures worth catching before they reach a screenshot, neither visible to any
 * other check:
 *
 * 1. **A tree in the road or a sparse roadside.** Placement is a deterministic hash
 *    over the route. Every full crown must clear every circuit section, while the
 *    closest band still needs enough trees on both sides to read as jungle.
 *
 * 2. **A horizon with a hole in it.** The desert ring is generated, so it cannot
 *    fail to download — but it can fail to close. Azimuth coverage, peak elevation
 *    and far-plane fit are measured off the built vertex buffer rather than off the
 *    layout numbers, because the bug this replaces was placement arithmetic that was
 *    correct while nothing appeared on screen at all.
 *
 * Runs headless against `sceneryLayout` and `horizon`, which is why those modules
 * are separate from `Scenery`: the shipped tree GLBs use `EXT_texture_webp` and
 * decoding one needs a DOM.
 */

import { Color } from "three";
import { DESERT_SUNSET } from "../src/game/config/levels";
import { QUALITY_PRESETS, TIER_ORDER } from "../src/game/config/quality";
import { Track } from "../src/game/track/Track";
import {
  HORIZON_MAX_ELEVATION_DEGREES,
  HORIZON_MIN_ELEVATION_DEGREES,
  buildHorizon,
  horizonComposition,
  horizonFeatures,
} from "../src/game/world/horizon";
import { groundHeightFor, runoffInner } from "../src/game/world/terrain";
import {
  MAX_CANOPY_RADIUS,
  MIN_TREE_STANDOFF,
  TREE_GAP_CHANCE,
  TREE_SPECIES,
  TREE_STANDOFF,
  TREE_STANDOFF_LAYERS,
  canopyIntrusion,
  treePlacements,
} from "../src/game/world/sceneryLayout";

const track = new Track();
const groundHeight = groundHeightFor(track);
const failures: string[] = [];

console.log("\n  Scenery placement\n  " + "-".repeat(62));

// ------------------------------------------------------------------- the band

console.log(
  `  widest crown            ${MAX_CANOPY_RADIUS.toFixed(1)}m radius ` +
    `(standoff ${MIN_TREE_STANDOFF.toFixed(1)}m)`,
);
if (MAX_CANOPY_RADIUS > MIN_TREE_STANDOFF) {
  failures.push(
    `the widest crown is ${MAX_CANOPY_RADIUS.toFixed(1)}m but the tree band only ` +
      `guarantees ${MIN_TREE_STANDOFF.toFixed(1)}m of standoff`,
  );
}

// --------------------------------------------------------------- the tree line

const tallestTree = Math.max(...TREE_SPECIES.map((species) => species.maxHeight));
console.log(
  `  forest profile          ${TREE_STANDOFF_LAYERS.length} layers, ` +
    `${TREE_STANDOFF[0]}–${TREE_STANDOFF[1]}m deep, up to ${tallestTree.toFixed(1)}m tall`,
);
if (tallestTree > 14) {
  failures.push(`forest trees reach ${tallestTree.toFixed(1)}m — beyond the intended canopy`);
}
if (TREE_STANDOFF_LAYERS.length < 3 || TREE_STANDOFF[1] < 80) {
  failures.push("tree layout lacks enough depth to merge into the landscape");
}

const totalsByTier: number[] = [];
const expectedTotals = {
  low: [320, 370],
  medium: [400, 450],
  high: [500, 550],
} as const;
const minimumRoadsidePerSide = { low: 100, medium: 115, high: 140 } as const;

for (const tier of TIER_ORDER) {
  const slots = treePlacements(track, groundHeight, TREE_GAP_CHANCE[tier]);
  const total = slots.reduce((sum, list) => sum + list.length, 0);
  totalsByTier.push(total);

  let worstIntrusion = -Infinity;
  let worstAt: string | null = null;
  let insideBarrier = 0;
  let leftSide = 0;
  let rightSide = 0;
  let farthest = 0;
  let invalidBand = 0;
  const layerSides = TREE_STANDOFF_LAYERS.map(() => [0, 0]);
  const layerDrops = TREE_STANDOFF_LAYERS.map(() => 0);

  slots.forEach((placements, index) => {
    const species = TREE_SPECIES[index]!;
    for (const placement of placements) {
      const projection = track.project(placement.position.x, placement.position.z, -1);
      const sample = track.samples[projection.index]!;
      const standoff = Math.abs(projection.lateral) - runoffInner(sample);
      if (standoff <= 0) insideBarrier += 1;
      const sideIndex = projection.lateral < 0 ? 0 : 1;
      if (sideIndex === 0) leftSide += 1;
      else rightSide += 1;
      layerSides[placement.layer]![sideIndex] += 1;
      farthest = Math.max(farthest, standoff);
      layerDrops[placement.layer] = Math.max(
        layerDrops[placement.layer]!,
        projection.height - placement.position.y,
      );

      const band = TREE_STANDOFF_LAYERS[placement.layer];
      if (!band || placement.standoff < band.min || placement.standoff > band.max) {
        invalidBand += 1;
      }

      const intrusion = canopyIntrusion(track, placement, species.canopyRatio);
      if (intrusion > worstIntrusion) {
        worstIntrusion = intrusion;
        worstAt = `${species.url.split("/").pop()} at ${placement.height.toFixed(1)}m`;
      }
    }
  });

  const perSpecies = slots.map((list) => list.length).join("/");
  const perLayer = layerSides.map(([left, right]) => `${left + right}`).join("/");
  console.log(
    `  ${tier.padEnd(7)} ${String(total).padStart(3)} trees (${perSpecies}) ` +
      `layers ${perLayer} near L/R ${layerSides[0]![0]}/${layerSides[0]![1]} ` +
      `all L/R ${leftSide}/${rightSide}   crown ${worstIntrusion.toFixed(1)}m ` +
      `out to ${farthest.toFixed(0)}m`,
  );

  if (farthest > TREE_STANDOFF[1] + 2) {
    failures.push(`${tier}: a tree stands ${farthest.toFixed(0)}m out, past the forest bands`);
  }
  if (layerDrops[0]! > 5) {
    failures.push(
      `${tier}: roadside layer drops ${layerDrops[0]!.toFixed(1)}m below the road`,
    );
  }
  if (insideBarrier > 0) {
    failures.push(`${tier}: ${insideBarrier} trees are planted inside the barrier line`);
  }
  if (worstIntrusion > 0) {
    failures.push(
      `${tier}: a crown overhangs the barrier by ${worstIntrusion.toFixed(1)}m (${worstAt})`,
    );
  }
  if (invalidBand > 0) {
    failures.push(`${tier}: ${invalidBand} trees escaped their assigned depth band`);
  }
  if (Math.min(leftSide, rightSide) < 40) {
    failures.push(`${tier}: jungle does not populate both road sides (${leftSide}/${rightSide})`);
  }
  layerSides.forEach(([left, right], layer) => {
    if (Math.min(left, right) < 5) {
      failures.push(`${tier}: forest layer ${layer} is missing from one road side (${left}/${right})`);
    }
  });
  const [roadsideLeft, roadsideRight] = layerSides[0]!;
  if (Math.min(roadsideLeft, roadsideRight) < minimumRoadsidePerSide[tier]) {
    failures.push(
      `${tier}: roadside jungle is still discontinuous (${roadsideLeft}/${roadsideRight}, ` +
        `need ${minimumRoadsidePerSide[tier]} per side)`,
    );
  }
  if (roadsideLeft <= roadsideRight || leftSide <= rightSide) {
    failures.push(
      `${tier}: requested left-side forest bias is absent ` +
        `(near ${roadsideLeft}/${roadsideRight}, all ${leftSide}/${rightSide})`,
    );
  }
  if (slots.some((placements) => placements.length === 0)) {
    failures.push(`${tier}: at least one supplied tree species is absent`);
  }
  const [minimum, maximum] = expectedTotals[tier];
  if (total < minimum || total > maximum) {
    failures.push(
      `${tier}: ${total} trees is outside the ${minimum}–${maximum} tier object budget`,
    );
  }
}

for (let index = 1; index < totalsByTier.length; index += 1) {
  if (totalsByTier[index]! <= totalsByTier[index - 1]!) {
    failures.push("tree density does not increase with the quality tier");
  }
}

// ------------------------------------------------------------- desert horizon

/**
 * Measured off the built geometry, not off the layout numbers.
 *
 * The failure this replaces was invisible to a layout-level check: the previous
 * backdrop's placement arithmetic was correct while the thing on screen was
 * absent. Reading azimuth and elevation back out of the vertex buffer is the only
 * version of this test that can tell the difference.
 *
 * Angles are measured from the ring's own base plane, which is where the
 * generator derives its heights from and where the mesh is parented — on the
 * ground plane, under the camera.
 */
const AZIMUTH_BINS = 72;
/**
 * Every heading has to carry *something*, which is the ring closing.
 *
 * Set just under the skirt, because the skirt is the element responsible for
 * closing it — the discrete features cannot, and asserting that they do only ever
 * produces a test that passes once enough mesas have been thrown at it.
 */
const MIN_BIN_ELEVATION = 2.4;
/** Relief, separately: this many headings must carry a real silhouette. */
const RELIEF_ELEVATION = 4;
const MIN_RELIEF_BINS = 58;
/** And the skyline has to reach at least this somewhere, degrees. */
const MIN_PEAK_ELEVATION = 9;

const palette = {
  haze: new Color(DESERT_SUNSET.fog),
  rock: new Color(DESERT_SUNSET.ground),
};

console.log("");
for (const tier of TIER_ORDER) {
  const { drawDistance } = QUALITY_PRESETS[tier];
  const composition = horizonComposition(drawDistance);
  const geometry = buildHorizon(composition, palette);
  const position = geometry.getAttribute("position");

  const binPeak = new Float64Array(AZIMUTH_BINS);
  let farthest = 0;
  let nearest = Infinity;
  let peak = 0;
  let below = 0;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const horizontal = Math.hypot(x, z);
    if (y < -1e-6) below += 1;
    farthest = Math.max(farthest, horizontal);
    nearest = Math.min(nearest, horizontal);

    const elevation = (Math.atan2(y, horizontal) * 180) / Math.PI;
    peak = Math.max(peak, elevation);

    let azimuth = Math.atan2(x, z);
    if (azimuth < 0) azimuth += Math.PI * 2;
    const bin = Math.min(AZIMUTH_BINS - 1, Math.floor((azimuth / (Math.PI * 2)) * AZIMUTH_BINS));
    binPeak[bin] = Math.max(binPeak[bin]!, elevation);
  }

  let emptyBins = 0;
  let reliefBins = 0;
  let lowestBin = Infinity;
  for (let bin = 0; bin < AZIMUTH_BINS; bin += 1) {
    lowestBin = Math.min(lowestBin, binPeak[bin]!);
    if (binPeak[bin]! < MIN_BIN_ELEVATION) emptyBins += 1;
    if (binPeak[bin]! >= RELIEF_ELEVATION) reliefBins += 1;
  }

  console.log(
    `  ${tier.padEnd(7)} horizon ring ${composition.radius.toFixed(0)}m  ` +
      `${(position.count / 1000).toFixed(1)}k verts  ` +
      `${nearest.toFixed(0)}–${farthest.toFixed(0)}m out  ` +
      `peaks ${peak.toFixed(1)}° up, thinnest ${lowestBin.toFixed(1)}°, ` +
      `relief on ${reliefBins}/${AZIMUTH_BINS}`,
  );

  if (reliefBins < MIN_RELIEF_BINS) {
    failures.push(
      `${tier}: only ${reliefBins} of ${AZIMUTH_BINS} headings reach ${RELIEF_ELEVATION}° — ` +
        `the range is a flat band rather than a skyline`,
    );
  }

  if (farthest >= drawDistance) {
    failures.push(
      `${tier}: the horizon reaches ${farthest.toFixed(0)}m, past the ${drawDistance}m far plane`,
    );
  }
  if (below > 0) {
    failures.push(
      `${tier}: ${below} horizon vertices sit below the ground plane the ring stands on`,
    );
  }
  if (emptyBins > 0) {
    failures.push(
      `${tier}: ${emptyBins} of ${AZIMUTH_BINS} headings have no horizon above ` +
        `${MIN_BIN_ELEVATION}° — the ring does not close`,
    );
  }
  if (peak < MIN_PEAK_ELEVATION || peak > HORIZON_MAX_ELEVATION_DEGREES + 0.5) {
    failures.push(
      `${tier}: peaks reach ${peak.toFixed(1)}°, outside the ${MIN_PEAK_ELEVATION}–` +
        `${HORIZON_MAX_ELEVATION_DEGREES}° horizon band`,
    );
  }

  geometry.dispose();
}

// Every kind has to survive into the layout, or the skyline quietly loses its
// turbines or its arch and still passes every angular check above.
const features = horizonFeatures(horizonComposition(QUALITY_PRESETS.high.drawDistance).radius);
const census = new Map<string, number>();
for (const feature of features) {
  census.set(feature.kind, (census.get(feature.kind) ?? 0) + 1);
}
console.log(
  `  features                ${features.length} total — ` +
    [...census.entries()].map(([kind, count]) => `${count} ${kind}`).join(", "),
);
for (const kind of ["mesa", "butte", "spire", "arch", "turbine"]) {
  if ((census.get(kind) ?? 0) === 0) failures.push(`the horizon has no ${kind}s`);
}
for (const feature of features) {
  if (
    feature.elevationDegrees < HORIZON_MIN_ELEVATION_DEGREES ||
    feature.elevationDegrees > HORIZON_MAX_ELEVATION_DEGREES
  ) {
    failures.push(
      `a ${feature.kind} is laid out at ${feature.elevationDegrees.toFixed(1)}°, outside the band`,
    );
    break;
  }
}

// Determinism: the horizon is part of the world a replay was driven in.
{
  const composition = horizonComposition(QUALITY_PRESETS.high.drawDistance);
  const first = buildHorizon(composition, palette).getAttribute("position").array;
  const second = buildHorizon(composition, palette).getAttribute("position").array;
  let identical = first.length === second.length;
  for (let i = 0; identical && i < first.length; i += 1) {
    if (first[i] !== second[i]) identical = false;
  }
  console.log(`  determinism             ${identical ? "identical rebuild" : "DIVERGED"}`);
  if (!identical) failures.push("rebuilding the horizon produces different geometry");
}

if (failures.length > 0) {
  console.error(`\n  FAIL\n${failures.map((failure) => `    - ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log(
    `\n  PASS — every crown clears the barrier, the near jungle fills both sides, ` +
      `and the desert horizon closes on all ${TIER_ORDER.length} tiers.\n`,
  );
}
