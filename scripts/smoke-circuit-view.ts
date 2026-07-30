#!/usr/bin/env tsx
/**
 * Circuit geometry test.
 *
 * Catches the class of bug that produced a green race track: a surface built with
 * its winding reversed. Backface culling then hides it completely, and because the
 * kerbs and barriers around it were wound correctly, the result looked like a
 * deliberate art choice rather than 14,667 invisible triangles.
 *
 * The rule it enforces is narrow and checkable: any roughly horizontal triangle
 * sitting over the driving corridor must face up. That covers the asphalt, the
 * edge lines, the timing lines and the start chequer, and it deliberately does not
 * care about the underside of a gantry beam or a lighting boom, which are meant to
 * be visible from below.
 */

import { Color, Mesh, Vector3 } from "three";
import { DAYLIGHT_CIRCUIT } from "../src/game/config/levels";
import { QUALITY_PRESETS } from "../src/game/config/quality";
import { CircuitView } from "../src/game/track/CircuitView";
import { Track } from "../src/game/track/Track";

const track = new Track();
const view = new CircuitView(track, DAYLIGHT_CIRCUIT, QUALITY_PRESETS.high);

/** Roughly horizontal, either way up. */
const HORIZONTAL = 0.5;
/** How far above the road surface a triangle can be and still count as surface. */
const SURFACE_BAND = 1.2;

let meshes = 0;
let triangles = 0;
let surfaceUp = 0;
const surfaceDown: { x: number; z: number; y: number }[] = [];

/**
 * Asphalt, in the renderer's working colour space.
 *
 * Checked as well as the winding, because "the road is invisible" and "the road is
 * the wrong colour" look identical from the driver's seat, and only one of them is
 * a winding bug.
 */
const asphalt = new Color(DAYLIGHT_CIRCUIT.city.asphalt);
let centreSamples = 0;
let centreWrongColour = 0;

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const centroid = new Vector3();
const normal = new Vector3();
const edge1 = new Vector3();
const edge2 = new Vector3();

view.group.traverse((node) => {
  if (!(node instanceof Mesh)) return;
  meshes += 1;
  const position = node.geometry.getAttribute("position");
  const index = node.geometry.getIndex();
  if (!index) return;

  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    triangles += 1;

    normal.crossVectors(edge1.subVectors(b, a), edge2.subVectors(c, a)).normalize();
    if (Math.abs(normal.y) < HORIZONTAL) continue;

    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const projection = track.project(centroid.x, centroid.z, -1);
    const sample = track.samples[projection.index]!;

    // Only judge geometry that is actually part of the driving surface.
    const onCorridor = Math.abs(projection.lateral) <= sample.halfWidth;
    const atSurface = Math.abs(centroid.y - projection.height) <= SURFACE_BAND;
    if (!onCorridor || !atSurface) continue;

    if (normal.y > 0) surfaceUp += 1;
    else {
      surfaceDown.push({
        x: +centroid.x.toFixed(1),
        z: +centroid.z.toFixed(1),
        y: +centroid.y.toFixed(2),
      });
      continue;
    }

    // Mid-road and at surface height: this must be asphalt. Markings are
    // deliberately excluded — they sit 4cm proud of the surface so they cannot
    // z-fight, and the timing lines and start chequer are legitimately white.
    if (Math.abs(projection.lateral) > sample.halfWidth * 0.5) continue;
    // The surface height at this lateral offset, banking included. `projection`
    // reports the centreline height, and the crossfall reaches ±0.3m across the
    // road — far more than the 4cm the markings are raised by, so the banking has
    // to be accounted for before "is this proud of the surface" means anything.
    const surfaceY = projection.height + projection.lateral * Math.tan(sample.banking);
    if (centroid.y - surfaceY > 0.02) continue;
    const colour = node.geometry.getAttribute("color");
    if (!colour) continue;
    centreSamples += 1;
    const dr = colour.getX(index.getX(i)) - asphalt.r;
    const dg = colour.getY(index.getX(i)) - asphalt.g;
    const db = colour.getZ(index.getX(i)) - asphalt.b;
    if (Math.hypot(dr, dg, db) > 0.02) centreWrongColour += 1;
  }
});

console.log("\n  Circuit geometry\n  " + "-".repeat(52));
console.log(`  chunk meshes            ${meshes}`);
console.log(`  triangles               ${triangles.toLocaleString("en-US")}`);
console.log(`  driving-surface faces   ${surfaceUp.toLocaleString("en-US")} up, ${surfaceDown.length} down`);
console.log(
  `  mid-road colour         ${centreSamples.toLocaleString("en-US")} checked, ` +
    `${centreWrongColour} not asphalt`,
);

if (centreWrongColour > 0) {
  console.error(
    `\n  FAIL — ${centreWrongColour} mid-road vertices are not the asphalt colour. ` +
      `The road is rendering, but as something else.\n`,
  );
  process.exitCode = 1;
} else if (surfaceDown.length > 0) {
  console.error(
    `\n  FAIL — ${surfaceDown.length} driving-surface triangles face downward and ` +
      `will be culled.\n  First few: ${JSON.stringify(surfaceDown.slice(0, 3))}\n`,
  );
  process.exitCode = 1;
} else if (surfaceUp < 4_000) {
  console.error(
    `\n  FAIL — only ${surfaceUp} upward driving-surface triangles found; the road ` +
      `is missing, not merely inverted.\n`,
  );
  process.exitCode = 1;
} else {
  console.log("\n  PASS — the whole driving surface faces the camera.\n");
}

view.dispose();
