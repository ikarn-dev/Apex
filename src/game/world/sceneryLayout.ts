/**
 * Which trees stand where, and where the landscape backdrop sits.
 *
 * Split out of `Scenery` so it can be checked without a browser. `Scenery` itself
 * cannot run headless — the shipped GLBs use `EXT_texture_webp`, and decoding WebP
 * needs a DOM — but placement is the half that can put a tree on the racing line,
 * and it is pure arithmetic over the route. `scripts/smoke-scenery.ts` exercises
 * exactly this module.
 *
 * The species table lives here rather than with the loader because the band the
 * trees are planted in is derived from how wide their crowns are: the numbers only
 * make sense next to each other.
 *
 * Nothing here calls `Math.random`. Every position comes from `hash` over the route
 * index, so the world is identical on every device and every reload; a replay has
 * to be driven through the world it was recorded in.
 */

import type { Vector3 } from "three";
import { assetUrl } from "../config/assets";
import type { Track, TrackSample } from "../track/Track";
import { hash, runoffInner, runoffPoint, runoffReach } from "./terrain";

export interface TreeSpecies {
  /**
   * Content-hashed URL, like the cars: `public/models` is served immutable, so a
   * rebuilt tree that kept its filename would never be picked up.
   */
  url: string;
  /** Height range this species is normalised to, metres. */
  minHeight: number;
  maxHeight: number;
  /**
   * Widest crown radius as a fraction of the tree's height.
   *
   * Measured on the shipped models, and the reason the first forest band starts
   * where it does: a royal poinciana is as wide as it is tall, so planting it by
   * height alone would hang its crown over the barrier and into the racing line.
   */
  canopyRatio: number;
  /** Relative placement frequency; expensive broad-crown trees stay accents. */
  frequency: number;
}

/**
 * The tree line's three species.
 *
 * The models arrive at wildly different scales — the poplar is authored 3.9m tall,
 * the poinciana 4.3m tall and 9m across — so shipped size says nothing about intended
 * size. These ranges are the real trees: a Lombardy poplar is a tall narrow column, a
 * royal poinciana a wide low crown, a fir in between.
 */
export const TREE_SPECIES: readonly TreeSpecies[] = [
  {
    url: assetUrl("/models/env/tree-conifer.glb"),
    minHeight: 6,
    maxHeight: 10,
    canopyRatio: 0.54,
    frequency: 0.5,
  },
  {
    url: assetUrl("/models/env/tree-poplar.glb"),
    minHeight: 8,
    maxHeight: 14,
    canopyRatio: 0.11,
    frequency: 0.34,
  },
  {
    url: assetUrl("/models/env/tree-poinciana.glb"),
    minHeight: 5,
    maxHeight: 8,
    canopyRatio: 1.07,
    frequency: 0.16,
  },
];

/** Tier-scaled thinning across four bands and both road sides. */
export const TREE_GAP_CHANCE = { low: 0.76, medium: 0.64, high: 0.52 } as const;

/** Extra retention on the circuit's left side, where the authored route opens up. */
export const LEFT_FOREST_GAP_BIAS = -0.12;

/**
 * Four staggered depth bands beyond each barrier, metres.
 *
 * The roadside band is sampled every ~30m of route before deterministic thinning,
 * with progressively coarser layers behind it. This produces overlapping crowns in
 * a normal chase-camera window instead of isolated trees hundreds of metres apart;
 * the left bias deliberately fills the sparse side visible in trackside views.
 */
export const TREE_STANDOFF_LAYERS = [
  { min: 10, max: 22, sampleOffset: 0, spacing: 12, gapBias: -0.28 },
  { min: 25, max: 44, sampleOffset: 9, spacing: 30, gapBias: -0.06 },
  { min: 48, max: 76, sampleOffset: 18, spacing: 42, gapBias: -0.01 },
  { min: 80, max: 118, sampleOffset: 27, spacing: 54, gapBias: 0.01 },
] as const;

/** Full forest depth, retained for placement invariants and diagnostics. */
export const TREE_STANDOFF = [
  TREE_STANDOFF_LAYERS[0].min,
  TREE_STANDOFF_LAYERS[TREE_STANDOFF_LAYERS.length - 1]!.max,
] as const;

/** Most a tree leans off vertical, radians. Real trees are not plumb. */
export const TREE_MAX_LEAN = 0.05;

/** Widest crown any species can present, metres. Checked against the standoff. */
export const MAX_CANOPY_RADIUS = Math.max(
  ...TREE_SPECIES.map((species) => species.canopyRatio * species.maxHeight),
);

/** Standoff the near edge of the band guarantees, metres. */
export const MIN_TREE_STANDOFF = TREE_STANDOFF[0];

export interface Placement {
  position: Vector3;
  yaw: number;
  /** Height in metres this tree is normalised to. */
  height: number;
  /** Lean off vertical, radians. */
  lean: number;
  /** Zero is roadside; larger values recede toward the landscape. */
  layer: number;
  /** Requested distance beyond the barrier, metres. */
  standoff: number;
}

/**
 * Point at a metric standoff, following the drawn bank and then continuing across
 * the surrounding ground plane. Far forest bands therefore keep their intended
 * depth even where the run-off reaches ground after only 26m.
 */
function treePointAtStandoff(
  sample: TrackSample,
  side: number,
  standoff: number,
  groundHeight: number,
): Vector3 {
  const inner = runoffInner(sample);
  const baseY = sample.y + side * inner * Math.tan(sample.banking);
  const reach = runoffReach(baseY, groundHeight);
  if (standoff <= reach) {
    return runoffPoint(sample, side, standoff / reach, groundHeight);
  }

  const edge = runoffPoint(sample, side, 1, groundHeight);
  const extra = standoff - reach;
  edge.x += sample.rx * side * extra;
  edge.z += sample.rz * side * extra;
  return edge;
}

function pickSpecies(value: number): number {
  const total = TREE_SPECIES.reduce((sum, species) => sum + species.frequency, 0);
  let cursor = value * total;
  for (let index = 0; index < TREE_SPECIES.length; index += 1) {
    cursor -= TREE_SPECIES[index]!.frequency;
    if (cursor <= 0) return index;
  }
  return TREE_SPECIES.length - 1;
}

/**
 * Layered forest slots, grouped by species for shared-template cloning.
 *
 * Four staggered bands on both road sides create canopy depth. A candidate is
 * rejected when its full crown would approach any circuit section, not only the
 * sample that generated it; this matters on switchbacks where a far forest band can
 * otherwise cross another part of the track.
 */
export function treePlacements(
  track: Track,
  groundHeight: number,
  gapChance: number,
): Placement[][] {
  const slots: Placement[][] = TREE_SPECIES.map(() => []);
  const samples = track.samples.length;

  for (const side of [-1, 1] as const) {
    TREE_STANDOFF_LAYERS.forEach((layer, layerIndex) => {
      const sideBias = side < 0 ? LEFT_FOREST_GAP_BIAS : 0;
      const effectiveGap = Math.min(
        0.95,
        Math.max(0, gapChance + layer.gapBias + sideBias),
      );
      for (let base = 0; base < samples; base += layer.spacing) {
        const seed = base + layerIndex * 10_007;
        if (hash(seed, side + layerIndex * 101) < effectiveGap) continue;

        const jitter = Math.round(
          (hash(seed, side + 211) - 0.5) * layer.spacing * 0.6,
        );
        const sampleIndex =
          (base + layer.sampleOffset + jitter + samples) % samples;
        const sample = track.samples[sampleIndex]!;
        const standoff =
          layer.min + hash(seed, side + 307) * (layer.max - layer.min);
        const pick = pickSpecies(hash(seed, side + 401));
        const kind = TREE_SPECIES[pick]!;
        const height =
          kind.minHeight + hash(seed, side + 503) * (kind.maxHeight - kind.minHeight);
        const position = treePointAtStandoff(sample, side, standoff, groundHeight);

        // Protect every road section from the whole crown. Far bands can approach a
        // different leg of the circuit even while remaining far from their source.
        const nearest = track.project(position.x, position.z, -1);
        const nearestSample = track.samples[nearest.index]!;
        const clearance = Math.abs(nearest.lateral) - runoffInner(nearestSample);
        if (clearance < height * kind.canopyRatio + 1) continue;

        slots[pick]!.push({
          position,
          yaw: hash(seed, side + 607) * Math.PI * 2,
          height,
          lean: (hash(seed, side + 701) - 0.5) * 2 * TREE_MAX_LEAN,
          layer: layerIndex,
          standoff,
        });
      }
    });
  }

  return slots;
}

/**
 * How far a placement's crown reaches back toward the road, metres.
 *
 * Positive means it overhangs the barrier line. Exposed so the invariant the forest
 * bands exist to satisfy can be asserted against the real route rather than argued
 * from the minimum-reach case alone.
 */
export function canopyIntrusion(
  track: Track,
  placement: Placement,
  canopyRatio: number,
): number {
  const projection = track.project(placement.position.x, placement.position.z, -1);
  const sample = track.samples[projection.index]!;
  const standoff = Math.abs(projection.lateral) - runoffInner(sample);
  return placement.height * canopyRatio - standoff;
}


