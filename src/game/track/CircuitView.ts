/**
 * Visual circuit assembled exclusively from the supplied map GLBs.
 *
 * The route and collision ribbon come from the same Suzuka source mesh (see
 * Track.ts). This view adds no generated road, kerb, checkpoint, or neon mesh:
 * the circuit, line structures, and barriers are all instances of user assets.
 */

import { Box3, Group, Mesh, Texture, Vector3 } from "three";
import type { Material, Object3D } from "three";
import type { QualitySettings } from "../config/quality";
import type { Resources, LoadedModel } from "../engine/Resources";
import type { Track, TrackSample } from "./Track";

const CIRCUIT_URL = "/models/maps/suzuka.glb";
const START_URL = "/models/maps/starting-line.glb";
const FINISH_URL = "/models/maps/finish-line.glb";
const BARRIER_URL = "/models/maps/tyre-barrier.glb";

export class CircuitView {
  readonly group = new Group();

  private disposed = false;
  private readonly geometries = new Set<{ dispose: () => void }>();
  private readonly materials = new Set<Material>();
  private readonly textures = new Set<Texture>();

  constructor(
    private readonly track: Track,
    private readonly quality: QualitySettings,
  ) {
    this.group.name = "supplied-suzuka-circuit";
  }

  async load(resources: Resources): Promise<void> {
    const [circuit, startingLine, finishLine, barrier] = await Promise.all([
      resources.load(CIRCUIT_URL),
      resources.load(START_URL),
      resources.load(FINISH_URL),
      resources.load(BARRIER_URL),
    ]);
    if (this.disposed) return;

    const circuitRoot = resources.instantiate(circuit);
    circuitRoot.name = "suzuka-circuit-model";
    this.prepare(circuitRoot, false);
    this.group.add(circuitRoot);

    const finish = resources.instantiate(finishLine);
    finish.name = "finish-line-model";
    this.placeGate(finish, finishLine, 0, 1.8);
    this.prepare(finish, true);
    this.group.add(finish);

    const start = resources.instantiate(startingLine);
    start.name = "starting-line-model";
    this.placeGate(start, startingLine, -28, 2.2);
    this.prepare(start, true);
    this.group.add(start);

    this.addBarriers(resources, barrier);
  }

  private prepare(root: Object3D, castsShadow: boolean): void {
    root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = castsShadow && this.quality.shadowMapSize > 0;
      child.receiveShadow = this.quality.shadowMapSize > 0;
      this.geometries.add(child.geometry);

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        this.materials.add(material);
        for (const value of Object.values(material)) {
          if (!(value instanceof Texture)) continue;
          value.anisotropy = this.quality.anisotropy;
          this.textures.add(value);
        }
      }
    });
  }

  /** Place a supplied arch across the asset-derived start straight. */
  private placeGate(
    root: Object3D,
    model: LoadedModel,
    distance: number,
    extraWidth: number,
  ): void {
    const sample = this.track.sampleAtDistance(distance);
    const targetWidth = sample.halfWidth * 2 + extraWidth;
    const sourceWidth = Math.max(model.size.x, 0.001);
    root.scale.setScalar(targetWidth / sourceWidth);
    root.rotation.y = sample.heading;
    this.placeBoundsOnRoad(root, sample);
  }

  private placeBoundsOnRoad(root: Object3D, sample: TrackSample): void {
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root);
    const centre = bounds.getCenter(new Vector3());
    root.position.set(
      sample.x - centre.x,
      sample.y - bounds.min.y,
      sample.z - centre.z,
    );
    root.updateMatrixWorld(true);
  }

  /**
   * Instance supplied tyre-barrier scenes on the outside of substantial bends.
   * Sampling density comes from the quality tier; placement comes entirely from
   * the extracted route curvature and measured edge width.
   */
  private addBarriers(resources: Resources, model: LoadedModel): void {
    const targetCount = this.quality.propDensity * 2;
    if (targetCount <= 0) return;

    const candidates: number[] = [];
    const minimumSpacing = Math.max(22, this.track.length / (targetCount * 5));
    let lastDistance = -Infinity;

    for (let i = 0; i < this.track.samples.length; i += 1) {
      const sample = this.track.samples[i]!;
      if (sample.distance < 90 || this.track.length - sample.distance < 90) continue;
      if (Math.abs(sample.curvature) < 0.006) continue;
      if (sample.distance - lastDistance < minimumSpacing) continue;
      candidates.push(i);
      lastDistance = sample.distance;
    }

    candidates
      .sort(
        (a, b) =>
          Math.abs(this.track.samples[b]!.curvature) -
          Math.abs(this.track.samples[a]!.curvature),
      )
      .slice(0, targetCount)
      .sort((a, b) => a - b)
      .forEach((index) => {
        const sample = this.track.samples[index]!;
        const instance = resources.instantiate(model);
        const sourceHeight = Math.max(model.size.y, 0.001);
        const scale = 1.05 / sourceHeight;
        const outside = sample.curvature > 0 ? -1 : 1;
        const barrierDepth = model.size.z * scale;
        const lateral = outside * (sample.halfWidth + barrierDepth * 0.5 + 0.2);

        instance.name = `tyre-barrier-${index}`;
        instance.scale.setScalar(scale);
        // The supplied barrier's long axis is local X; align it to the tangent.
        instance.rotation.y = sample.heading - Math.PI / 2;
        this.placeBoundsOnRoad(instance, {
          ...sample,
          x: sample.x + sample.rx * lateral,
          z: sample.z + sample.rz * lateral,
        });
        this.prepare(instance, true);
        this.group.add(instance);
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.clear();
    for (const texture of this.textures) texture.dispose();
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.textures.clear();
    this.materials.clear();
    this.geometries.clear();
  }
}
