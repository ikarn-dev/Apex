/**
 * Asset loading.
 *
 * A plain `GLTFLoader` with no decoder plugins, deliberately.
 *
 * `scripts/optimize-assets.mjs` turns the 24MB source car into 2MB using
 * `KHR_mesh_quantization` for geometry and `EXT_texture_webp` for textures, and
 * three.js decodes both natively. There used to be a `DRACOLoader` and a
 * `KTX2Loader` wired in here for formats the pipeline never emits — verified
 * against the shipped GLBs, whose only extensions are `EXT_texture_webp`,
 * `KHR_mesh_quantization`, `KHR_materials_clearcoat` and `KHR_texture_transform`.
 * Removing them takes two third-party CDN fetches and a WASM decoder off the race
 * loading path, and takes the deprecated `setDecoderConfig` call with it.
 *
 * Loaded models are cached and cloned per car, and the cache survives across
 * races — reloading a 2MB GLB between attempts is the difference between an
 * instant retry and a loading screen.
 */

import type {
  Object3D} from "three";
import {
  Box3,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Group,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

export interface LoadedModel {
  scene: Group;
  /** Bounding box of the source model, for auto-scaling. */
  size: Vector3;
}

export class Resources {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<LoadedModel>>();
  private disposed = false;

  /**
   * Load a GLB, cached by URL.
   *
   * Concurrent callers share one in-flight promise, so spawning six cars of the
   * same model issues one request.
   */
  load(url: string): Promise<LoadedModel> {
    const existing = this.cache.get(url);
    if (existing) return existing;

    const promise = new Promise<LoadedModel>((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          const box = new Box3().setFromObject(gltf.scene);
          const size = new Vector3();
          box.getSize(size);
          resolve({ scene: gltf.scene as Group, size });
        },
        undefined,
        (error) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });

    // A failed load must not poison the cache — a retry should be able to work.
    promise.catch(() => this.cache.delete(url));
    this.cache.set(url, promise);
    return promise;
  }

  /**
   * Independent copy of a cached model.
   *
   * `SkeletonUtils.clone` rather than `Object3D.clone` because it also
   * duplicates skinned meshes correctly. Materials are shared on purpose: six
   * cars with the same body material is one shader program and one set of
   * uniforms.
   */
  instantiate(model: LoadedModel): Object3D {
    return cloneSkinned(model.scene);
  }

  /**
   * Prepare a freshly loaded car for the scene.
   *
   * Applies quality-dependent texture settings, enables shadows where wanted,
   * and normalises the model to a target length so the three source cars (which
   * come from different authors at different scales) sit correctly on the road.
   */
  prepareCar(
    root: Object3D,
    options: {
      targetLength: number;
      sourceSize: Vector3;
      anisotropy: number;
      castShadow: boolean;
      envMapIntensity: number;
    },
  ): { scale: number; yOffset: number } {
    const longest = Math.max(options.sourceSize.x, options.sourceSize.z);
    const scale = longest > 0.01 ? options.targetLength / longest : 1;

    root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = options.castShadow;
      child.receiveShadow = false;
      // The chase camera sits low and close, so culling individual body parts
      // causes visible popping for a negligible saving on a handful of meshes.
      child.frustumCulled = false;

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial)) continue;
        material.envMapIntensity = options.envMapIntensity;

        // Source exports frequently ship fully-metallic, mirror-smooth values
        // for painted panels. Under image-based lighting that renders as a dark
        // chrome blob, so clamp both toward car-paint values.
        if (material.metalness > 0.7 && !material.metalnessMap) {
          material.metalness = 0.55;
        }
        if (material.roughness < 0.12 && !material.roughnessMap) {
          material.roughness = 0.25;
        }

        for (const map of [
          material.map,
          material.normalMap,
          material.roughnessMap,
          material.metalnessMap,
        ]) {
          if (map) (map as Texture).anisotropy = options.anisotropy;
        }
      }
    });

    root.scale.setScalar(scale);

    // Drop the model so its lowest point sits on y=0.
    const scaledBox = new Box3().setFromObject(root);
    return { scale, yOffset: -scaledBox.min.y };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
  }
}
