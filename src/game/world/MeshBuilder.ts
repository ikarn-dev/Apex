/**
 * Indexed geometry accumulator for generated scenery.
 *
 * Everything the circuit draws is flat-shaded, vertex-coloured, untextured
 * geometry, so it can all be welded into a handful of merged meshes. This is the
 * one place that knows how to do that: callers push vertices, get indices back,
 * and stitch them into quads.
 *
 * Vertex colours are written in the renderer's working (linear) colour space.
 * `three`'s `Color` already converts a hex literal out of sRGB on assignment, so
 * reading `.r/.g/.b` from one is correct here; pushing raw hex bytes would not be.
 */

import { BufferAttribute, BufferGeometry, type Color } from "three";

export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  get empty(): boolean {
    return this.indices.length === 0;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Returns the new vertex's index, for use in `quad`. */
  vertex(x: number, y: number, z: number, color: Color): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.colors.push(color.r, color.g, color.b);
    return index;
  }

  /** Two triangles across four corners, wound `a → b → c → d`. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /**
   * A closed box, from its minimum corner and its size.
   *
   * The base is omitted: every box the circuit places either sits on the ground
   * or is a lighting column, and neither is ever viewed from below.
   */
  box(
    minX: number,
    minY: number,
    minZ: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    side: Color,
    top: Color = side,
  ): void {
    const x1 = minX + sizeX;
    const y1 = minY + sizeY;
    const z1 = minZ + sizeZ;

    // Each face gets its own vertices so `computeVertexNormals` leaves the edges
    // hard instead of averaging them into a rounded blob.
    const face = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
      color: Color,
    ) => {
      this.quad(
        this.vertex(ax, ay, az, color),
        this.vertex(bx, by, bz, color),
        this.vertex(cx, cy, cz, color),
        this.vertex(dx, dy, dz, color),
      );
    };

    face(minX, minY, z1, x1, minY, z1, x1, y1, z1, minX, y1, z1, side); // +Z
    face(x1, minY, minZ, minX, minY, minZ, minX, y1, minZ, x1, y1, minZ, side); // -Z
    face(x1, minY, z1, x1, minY, minZ, x1, y1, minZ, x1, y1, z1, side); // +X
    face(minX, minY, minZ, minX, minY, z1, minX, y1, z1, minX, y1, minZ, side); // -X
    face(minX, y1, z1, x1, y1, z1, x1, y1, minZ, minX, y1, minZ, top); // +Y
  }

  build(name: string): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.name = name;
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(this.positions), 3),
    );
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
