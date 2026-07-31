/**
 * The circuit's plan view, as an SVG path.
 *
 * Drawn from the same route the physics reads, so the shape on a campaign card is
 * the shape the player drives — move a control point in `./layout` and the card
 * follows. The alternative was a decorative squiggle, which is worse than no
 * graphic at all: a track map that does not match its track is a lie the player
 * eventually notices.
 *
 * Pure arithmetic and no DOM, so it can run at build time in a server component
 * and keep `./layout` out of the client bundle entirely.
 */

import { buildRoute } from "./layout";

/**
 * Points kept from the route.
 *
 * The route has 2,344 samples at 2.5m. At the size a card draws this — a few
 * hundred pixels across — anything past ~150 points is sub-pixel detail paid for
 * in path length, and the hairpin still reads at 150.
 */
const OUTLINE_POINTS = 150;

/** Padding inside the viewBox, in viewBox units, so the stroke is never clipped. */
const PADDING = 6;

/** Coordinate space the path is emitted in. Square, so aspect is preserved. */
export const OUTLINE_VIEWBOX = 100;

let cached: string | null = null;

/**
 * A closed SVG path for the circuit, in a `0 0 100 100` viewBox.
 *
 * Uniformly scaled and centred: the circuit is not square, so it is fitted to the
 * tighter axis and centred on the other. Scaling each axis to fill would stretch
 * the layout into a shape that is not the circuit.
 */
export function circuitOutlinePath(): string {
  if (cached !== null) return cached;

  const { samples } = buildRoute();
  const stride = Math.max(1, Math.floor(samples.length / OUTLINE_POINTS));

  const points: [number, number][] = [];
  for (let i = 0; i < samples.length; i += stride) {
    const sample = samples[i]!;
    // x, z — the plan view. y is elevation and is not drawn.
    points.push([sample[0], sample[2]]);
  }
  if (points.length < 3) {
    cached = "";
    return cached;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const span = Math.max(maxX - minX, maxZ - minZ, 1e-6);
  const usable = OUTLINE_VIEWBOX - PADDING * 2;
  const scale = usable / span;
  // Centre the shorter axis in the leftover room.
  const offsetX = PADDING + (usable - (maxX - minX) * scale) / 2;
  const offsetZ = PADDING + (usable - (maxZ - minZ) * scale) / 2;

  const commands = points.map(([x, z], index) => {
    const px = offsetX + (x - minX) * scale;
    const py = offsetZ + (z - minZ) * scale;
    return `${index === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
  });

  cached = `${commands.join(" ")} Z`;
  return cached;
}
