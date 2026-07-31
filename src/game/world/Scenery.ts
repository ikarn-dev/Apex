/**
 * Roadside vegetation, and the desert horizon behind it.
 *
 * Each supplied tree species is baked once into a reusable template. Four staggered
 * depth bands on both road sides clone those templates into a tree line that starts
 * beyond the barriers and recedes toward the horizon. Every clone has its own world
 * transform and frustum-culling decision while sharing BufferGeometry and Material
 * references, so density does not duplicate GPU resources.
 *
 * The horizon is not a downloaded model any more — see `./horizon`. It is generated
 * as a full ring of mesas, spires and turbines, which is why this class no longer
 * has to aim anything at the camera or survive a failed asset fetch.
 *
 * Against a sun 9° above the horizon the tree line is backlit, so the trees are
 * tinted hard toward the environment and darkened. That is not a stylistic choice
 * about the models: a lit green canopy in front of a sunset reads as pasted-in,
 * and roadside vegetation at this time of day is very nearly a silhouette.
 */

import {
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import type { LevelEnvironment } from "../config/levels";
import type { QualitySettings } from "../config/quality";
import type { Resources } from "../engine/Resources";
import type { Track } from "../track/Track";
import { createHorizonMesh, horizonComposition } from "./horizon";
import {
  TREE_GAP_CHANCE,
  TREE_SPECIES,
  treePlacements,
  type Placement,
} from "./sceneryLayout";

/** Compared against, never mutated — a base colour of pure black hides its map. */
const BLACK = new Color(0x000000);

type BakedMaterial = Material | Material[];

interface BakedPart {
  geometry: BufferGeometry;
  material: BakedMaterial;
  name: string;
}

/** A loaded model with exporter transforms baked into reusable shared resources. */
interface BakedModel {
  parts: BakedPart[];
  /** Full vertical extent, for normalising a tree to a wanted height. */
  height: number;
}

export class Scenery {
  /** World-space dressing: independently placed roadside trees. */
  readonly group = new Object3D();

  /** Camera-facing landscape horizon, kept separate from world-space trees. */
  readonly backdrop = new Object3D();

  private readonly treeRoots: Object3D[] = [];
  private readonly ownedGeometries = new Set<BufferGeometry>();
  private readonly ownedMaterials = new Set<Material>();
  private disposed = false;

  constructor(
    private readonly track: Track,
    private readonly quality: QualitySettings,
    private readonly groundHeight: number,
    private readonly environment: LevelEnvironment,
  ) {
    this.group.name = "scenery";
    this.backdrop.name = "backdrop";
    this.buildBackdrop();
  }

  /**
   * Load the downloaded half of the scenery.
   *
   * Only the tree line has anything to fetch. The horizon is generated in the
   * constructor, so a slow connection costs a bare roadside and never a missing
   * skyline.
   */
  async load(resources: Resources): Promise<void> {
    await this.loadTrees(resources);
  }

  // --------------------------------------------------------------------- trees

  private async loadTrees(resources: Resources): Promise<void> {
    const models = await Promise.all(
      TREE_SPECIES.map(async (species) => ({
        species,
        model: await resources.load(species.url),
      })),
    );
    if (this.disposed) return;

    const variants = models.map(({ model }, speciesIndex) => {
      const baked = this.bake(resources.instantiate(model));
      return {
        baked,
        template: this.createTreeTemplate(baked, speciesIndex),
      };
    });

    const slots = treePlacements(
      this.track,
      this.groundHeight,
      TREE_GAP_CHANCE[this.quality.tier],
    );

    variants.forEach(({ baked, template }, speciesIndex) => {
      slots[speciesIndex]!.forEach((placement, placementIndex) => {
        this.addTreeClone(
          template,
          placement,
          placement.height / baked.height,
          speciesIndex,
          placementIndex,
        );
      });
    });
  }

  /**
   * One unattached template per species. Object3D.clone(true) creates fresh Mesh
   * objects but Mesh.copy intentionally retains geometry and material references.
   */
  private createTreeTemplate(model: BakedModel, speciesIndex: number): Object3D {
    const template = new Object3D();
    template.name = `tree-species-${speciesIndex}-template`;

    for (const part of model.parts) {
      const mesh = new Mesh(part.geometry, part.material);
      mesh.name = part.name;
      mesh.castShadow = this.quality.shadowMapSize > 0;
      mesh.receiveShadow = false;
      // This remains true on every clone. Culling is now per placed tree part, not
      // disabled for one mesh spanning the full 5.86km circuit.
      mesh.frustumCulled = true;
      template.add(mesh);
    }
    return template;
  }

  private addTreeClone(
    template: Object3D,
    placement: Placement,
    scale: number,
    speciesIndex: number,
    placementIndex: number,
  ): void {
    const tree = template.clone(true);
    tree.name = `tree-${speciesIndex}-${placementIndex}`;
    tree.position.copy(placement.position);

    const yaw = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      placement.yaw,
    );
    const lean = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      placement.lean,
    );
    tree.quaternion.copy(yaw.multiply(lean));
    tree.scale.setScalar(scale);

    this.treeRoots.push(tree);
    this.group.add(tree);
  }

  /**
   * Flatten a loaded model into reusable parts, re-centred on its footprint.
   *
   * Exporter node transforms are baked into cloned geometry so every placement can
   * have a simple transform. Geometry and materials are cloned only here, once per
   * source part; all placed tree objects share those owned resources.
   */
  private bake(root: Object3D): BakedModel {
    root.updateMatrixWorld(true);

    const parts: BakedPart[] = [];
    root.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);
      geometry.computeBoundingBox();
      this.ownedGeometries.add(geometry);
      parts.push({
        geometry,
        material: this.prepareMaterials(node.material),
        name: node.name || "scenery-part",
      });
    });
    if (parts.length === 0) return { parts, height: 1 };

    const box = parts[0]!.geometry.boundingBox!.clone();
    for (const part of parts.slice(1)) box.union(part.geometry.boundingBox!);

    // Centred on its footprint and sitting on its lowest vertex, so a placement is
    // a position and a scale rather than a position, a scale and a fudge.
    const offset = new Vector3(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );
    for (const part of parts) {
      part.geometry.translate(offset.x, offset.y, offset.z);
      part.geometry.computeBoundingBox();
      part.geometry.computeBoundingSphere();
    }

    return { parts, height: Math.max(0.01, box.max.y - box.min.y) };
  }

  // ------------------------------------------------------------------ backdrop

  /**
   * Build the desert horizon.
   *
   * Synchronous, and that is the point: the previous backdrop was a GLB, so a
   * failed or slow download meant a race with no horizon. This one exists before
   * the first frame and cannot fail to arrive.
   *
   * The ring renders after the sky and the ground but before every world mesh,
   * then clears depth. That ordering is load-bearing in both directions: the
   * ground is a 6.5km plane drawn with default depth, so a horizon drawn *after*
   * it needs the clear to keep roads in front, and a horizon drawn *before* it
   * would be painted over by the ground entirely.
   */
  private buildBackdrop(): void {
    const composition = horizonComposition(this.quality.drawDistance);
    const { mesh, geometry, material } = createHorizonMesh(composition, {
      // The base converges on the fog colour, so the range dissolves into the
      // haze instead of ending on a line.
      haze: new Color(this.environment.fog),
      // Peaks are the ground colour taken well down toward dusk: distant rock
      // against a low sun is much darker than the sky behind it.
      rock: new Color(this.environment.ground)
        .lerp(new Color(this.environment.fog), 0.22)
        .multiplyScalar(0.5),
    });

    mesh.renderOrder = -1;
    mesh.onAfterRender = (renderer) => renderer.clearDepth();
    this.ownedGeometries.add(geometry);
    this.ownedMaterials.add(material);
    this.backdrop.add(mesh);
  }

  /**
   * Keep the horizon centred on the camera, standing on the ground plane.
   *
   * A full ring needs no yaw: there is no facing to get wrong and no heading that
   * can catch its open back, which is what the previous single authored chunk had
   * to be rotated every frame to avoid. Only the horizontal position follows the
   * camera — the base stays on the ground plane, so the range stands on the
   * desert and sinks a little as the circuit climbs, exactly as distant rock does.
   */
  syncBackdrop(cameraPosition: Vector3): void {
    this.backdrop.position.set(cameraPosition.x, this.groundHeight, cameraPosition.z);
  }

  // ------------------------------------------------------------------ materials

  private prepareMaterials(source: Material | Material[]): BakedMaterial {
    return Array.isArray(source)
      ? source.map((material) => this.prepareMaterial(material))
      : this.prepareMaterial(source);
  }

  /**
   * Clone once, then adapt the supplied PBR and alpha settings to a backlit dusk.
   *
   * Textures are left intact; the tint is a lerp toward the level's own ground and
   * fog colours followed by a darkening. The previous 6% tint was tuned against a
   * high-sun daylight sky and leaves the canopy reading as bright green cut-outs
   * once the sun is 9° up — the trees are between the camera and the sunset, so
   * they should be losing their colour, not keeping it.
   */
  private prepareMaterial(source: Material): Material {
    const material = source.clone();
    this.ownedMaterials.add(material);

    if (material instanceof MeshStandardMaterial) {
      if (material.color.equals(BLACK)) material.color.setHex(0xffffff);
      material.metalness = 0;

      const duskTint = new Color(this.environment.ground).lerp(
        new Color(this.environment.fog),
        0.18,
      );
      material.color.lerp(duskTint, 0.34).multiplyScalar(0.72);
      material.roughness = Math.max(material.roughness, 0.8);
      // Low, so the sky gradient's warm bounce reaches the canopy without
      // relighting it as though the sun were overhead.
      material.envMapIntensity = 0.22;

      if (material.transparent) {
        material.transparent = false;
        material.depthWrite = true;
        material.alphaTest = Math.max(material.alphaTest, 0.5);
      }
      material.needsUpdate = true;
    }
    return material;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.treeRoots.length = 0;
    this.group.clear();
    this.backdrop.clear();

    // Geometry/material references are shared by every clone and disposed exactly
    // once here, never once per tree or landscape part.
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedGeometries.clear();
    this.ownedMaterials.clear();
  }
}
