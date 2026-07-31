/**
 * Shared geometry of the ground around the circuit.
 *
 * `CircuitView` builds the run-off and `Scenery` stands trees and buildings on it,
 * so both need the same answers about where the ground is and how far it reaches.
 * These used to be private constants inside `CircuitView`; duplicating them in a
 * second module would let the tree line drift off the terrain it is supposed to be
 * planted in.
 */

import { Vector3 } from "three";
import type { Track, TrackSample } from "../track/Track";

/** Concrete barrier thickness, metres. Scenery starts outside this. */
export const BARRIER_THICKNESS = 0.42;

/** How far the ground plane sits below the lowest point of the circuit. */
export const GROUND_CLEARANCE = 2.5;

/**
 * Sealed run-off, then a bank down to the surrounding ground.
 *
 * The circuit climbs and drops 30m, so a flat ground plane cannot meet the road
 * everywhere. The bank's reach grows with the height it has to cover, which holds
 * its gradient roughly constant and closes the gap at every point.
 */
export const RUNOFF_MIN_REACH = 26;
export const RUNOFF_REACH_PER_METRE = 3.2;

/** Normalised lateral stations across the run-off. */
export const RUNOFF_PROFILE = [0, 0.09, 0.26, 0.56, 1] as const;
/** The run-off is sealed surface out to this station, then it becomes bank. */
export const RUNOFF_SEALED = 2;

export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic 32-bit hash.
 *
 * Scenery placement must be identical on every device and every reload — no
 * `Math.random`, or a replay would not match the world it was driven in.
 */
export function hash(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Height of the ground plane, below the lowest point on the circuit.
 *
 * Not the mean: at mean elevation the plane buried 1,232 of 2,344 route samples,
 * so over half the lap ran through a trench with grass drawn over the top of it.
 */
export function groundHeightFor(track: Track): number {
  let lowest = Infinity;
  for (const sample of track.samples) lowest = Math.min(lowest, sample.y);
  return lowest - GROUND_CLEARANCE;
}

/**
 * A point on the road plane at a lateral offset.
 *
 * `banking` is the layout's crossfall, positive when the right edge is higher.
 * Everything trackside is placed through this helper, so kerbs, barriers and paint
 * sit on the banked surface rather than hovering over its low side.
 */
export function surfacePoint(
  sample: TrackSample,
  side: number,
  lateral: number,
  rise: number,
): Vector3 {
  const offset = side * lateral;
  return new Vector3(
    sample.x + sample.rx * offset,
    sample.y + offset * Math.tan(sample.banking) + rise,
    sample.z + sample.rz * offset,
  );
}

/** How far the run-off reaches before it meets the ground plane. */
export function runoffReach(baseY: number, groundHeight: number): number {
  return RUNOFF_MIN_REACH + Math.abs(baseY - groundHeight) * RUNOFF_REACH_PER_METRE;
}

/** Inner edge of the run-off at a sample: just outside the barrier. */
export function runoffInner(sample: TrackSample): number {
  return sample.halfWidth + BARRIER_THICKNESS;
}

/**
 * A point across the run-off, `t` running 0 (barrier) to 1 (ground plane).
 *
 * `Scenery` uses this so a tree planted on the bank sits on the same surface
 * `CircuitView` draws there, rather than floating above or sinking into it.
 */
export function runoffPoint(
  sample: TrackSample,
  side: number,
  t: number,
  groundHeight: number,
): Vector3 {
  const inner = runoffInner(sample);
  const baseY = sample.y + side * inner * Math.tan(sample.banking);
  const reach = runoffReach(baseY, groundHeight);
  const lateral = inner + reach * t;
  const offset = side * lateral;
  return new Vector3(
    sample.x + sample.rx * offset,
    baseY + (groundHeight - baseY) * smoothstep(t),
    sample.z + sample.rz * offset,
  );
}
