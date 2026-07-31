/**
 * Content-addressed model URLs.
 *
 * The asset pipeline writes fixed filenames, so the only thing that distinguishes
 * one build of `zagato-lq.glb` from the next is its contents. Appending the content
 * hash to the URL makes each build a distinct cache key, which is what lets
 * `/models/*` be served with a long immutable cache without the risk that a
 * rebuilt car is never picked up.
 *
 * That risk was not hypothetical: an early build shipped Draco-compressed geometry,
 * the loader later dropped its Draco decoder, and browsers holding the old bytes
 * under `Cache-Control: immutable, max-age=1y` kept failing to load a car that was
 * correct on disk. No rebuild or reload could fix it, because the URL never moved.
 */

import manifest from "./generated/asset-manifest.json";

const HASHES = manifest.assets as Record<string, string>;

/**
 * Versioned URL for a shipped asset.
 *
 * Falls back to the bare path when the manifest has no entry — a missing hash
 * should cost cache precision, never the asset itself.
 */
export function assetUrl(path: string): string {
  const hash = HASHES[path];
  return hash ? `${path}?v=${hash}` : path;
}
