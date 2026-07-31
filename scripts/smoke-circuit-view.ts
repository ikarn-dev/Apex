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
import { DESERT_SUNSET } from "../src/game/config/levels";
import { QUALITY_PRESETS } from "../src/game/config/quality";
import { CircuitView } from "../src/game/track/CircuitView";
import { Track } from "../src/game/track/Track";

const track = new Track();
const view = new CircuitView(track, DESERT_SUNSET, QUALITY_PRESETS.high);

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
const asphalt = new Color(DESERT_SUNSET.city.asphalt);
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
    // reports the centreline height, and the crossfall reaches ±0.65m across the
    // road, so the banking has to be accounted for before "is this proud of the
    // surface" means anything.
    //
    // The tolerance covers this reconstruction's own error, not the paint's: the
    // banking used here is the nearest sample's, while the paint was built from
    // its own, and across a banking gradient that differs by a couple of
    // centimetres at the road's edge. Paint is raised 6cm, so anything within 3cm
    // of the surface is asphalt and everything above it is a marking.
    const surfaceY = projection.height + projection.lateral * Math.tan(sample.banking);
    if (centroid.y - surfaceY > 0.03) continue;
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

// ------------------------------------------------------------------- signage

/**
 * The corner census and the boards painted from it.
 *
 * A sign that disagrees with the road is worse than no sign, and nothing else
 * checks these numbers: they are derived from smoothed curvature, so a change to
 * the layout or to the smoothing passes moves them silently.
 */
const signage: string[] = [];
const corners = view.corners;

console.log(`\n  Corner census\n  ${"-".repeat(52)}`);
console.log(`  corners found           ${corners.length}`);
for (const corner of corners) {
  const at = ((track.samples[corner.apexIndex]!.distance / track.length) * 100).toFixed(0);
  console.log(
    `  ${corner.direction > 0 ? "right" : "left "} ${`R${corner.radius.toFixed(0)}m`.padStart(7)}` +
      `  sev ${corner.severity}  ${String(corner.advisoryKph).padStart(3)} km/h` +
      `  ${corner.length.toFixed(0).padStart(3)}m long  at ${at.padStart(2)}% of lap`,
  );
}

if (corners.length < 6 || corners.length > 20) {
  signage.push(
    `${corners.length} corners found on a circuit with a long straight at each end — ` +
      `the curvature thresholds are picking up noise or missing bends`,
  );
}

const spacing = track.sampleSpacing;
for (const corner of corners) {
  const apex = track.samples[corner.apexIndex]!;
  if (Math.sign(apex.curvature) !== corner.direction) {
    signage.push(`a corner points ${corner.direction > 0 ? "right" : "left"} but its apex turns the other way`);
  }
  if (corner.advisoryKph % 10 !== 0 || corner.advisoryKph < 40 || corner.advisoryKph > 300) {
    signage.push(`advisory speed ${corner.advisoryKph} km/h is not a signable number`);
  }
  // The advisory has to be slower than the corner's own limit, or the board is
  // inviting the player into the barrier.
  const limit = Math.sqrt(19 * corner.radius) * 3.6;
  if (corner.advisoryKph > limit) {
    signage.push(
      `a ${corner.radius.toFixed(0)}m corner is signed ${corner.advisoryKph} km/h, past its ` +
        `${limit.toFixed(0)} km/h limit`,
    );
  }
  // The board must sit on the approach, not in the corner it is warning about.
  let gap = (corner.entryIndex - corner.boardIndex) * spacing;
  if (gap < 0) gap += track.length;
  if (Math.abs(gap - 110) > spacing * 2) {
    signage.push(`a warning board sits ${gap.toFixed(0)}m before turn-in rather than 110m`);
  }
}

// Radius and advisory speed have to move together, or the numbers are decoration.
const byRadius = [...corners].sort((a, b) => a.radius - b.radius);
for (let i = 1; i < byRadius.length; i += 1) {
  if (byRadius[i]!.advisoryKph < byRadius[i - 1]!.advisoryKph) {
    signage.push("a tighter corner is signed faster than a wider one");
    break;
  }
}

/**
 * The barrier strip: present, and facing the road.
 *
 * The strip is single-sided and its winding depends on which barrier it is on —
 * `forward x up` is -right, so the order that faces the road from the right-hand
 * barrier faces away from it on the left. Get that backwards and exactly half the
 * lighting disappears, on whichever side the test driver happened not to look at.
 * So every strip triangle's normal is checked against the inward direction.
 */
let glowMeshes = 0;
let glowTriangles = 0;
let glowFacingAway = 0;
view.group.traverse((node) => {
  if (!(node instanceof Mesh) || !node.name.startsWith("circuit-glow")) return;
  glowMeshes += 1;
  const position = node.geometry.getAttribute("position");
  const index = node.geometry.getIndex();
  if (!index) return;
  glowTriangles += index.count / 3;

  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    normal.crossVectors(edge1.subVectors(b, a), edge2.subVectors(c, a)).normalize();
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    const projection = track.project(centroid.x, centroid.z, -1);
    const sample = track.samples[projection.index]!;
    // Inward is toward the centreline: the opposite of the side the strip is on.
    const side = Math.sign(projection.lateral) || 1;
    const inward = -side;
    if (normal.x * sample.rx * inward + normal.z * sample.rz * inward < 0) {
      glowFacingAway += 1;
    }
  }
});
if (glowFacingAway > 0) {
  signage.push(
    `${glowFacingAway} barrier strip triangles face away from the road and will be ` +
      `culled — one side of the circuit has no lighting`,
  );
}
console.log(
  `  barrier light strip     ${glowMeshes} meshes, ` +
    `${glowTriangles.toLocaleString("en-US")} triangles, ` +
    `${glowFacingAway} facing away`,
);
if (glowMeshes === 0 || glowTriangles < 4_000) {
  signage.push(`the barrier light strip is missing or nearly empty (${glowTriangles} triangles)`);
}

if (signage.length > 0) {
  console.error(`\n  FAIL\n${signage.map((f) => `    - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else if (centreWrongColour > 0) {
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
