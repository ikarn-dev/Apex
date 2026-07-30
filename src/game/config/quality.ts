/**
 * Quality tiers.
 *
 * Detection is deliberately pessimistic: a wrong guess upward means a machine
 * that stutters, a wrong guess downward means slightly softer shadows. The
 * runtime governor may only ever *demote* a tier, never promote, so a machine
 * that thermally throttles settles instead of oscillating.
 *
 * Only knobs the renderer actually reads live here. `bloom`, `propDensity`,
 * `particleBudget` and `envProbe` were declared and never consumed by anything;
 * they are gone rather than left as documentation of features that do not exist.
 */

export type QualityTier = "low" | "medium" | "high";

export interface QualitySettings {
  tier: QualityTier;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  /** Shadow map resolution. 0 disables shadow mapping entirely. */
  shadowMapSize: number;
  /** Antialiasing in the WebGL context. */
  antialias: boolean;
  /**
   * Rival cars actually spawned, capped from the level definition.
   *
   * This is a draw-call budget, not a gameplay one. The car ships with its real
   * textures, so a rival costs ~31 draw calls and the player's rigged car ~52;
   * five rivals is about 200 calls for the field before the circuit is drawn.
   */
  maxRivals: number;
  /** Anisotropic filtering cap. */
  anisotropy: number;
  /** Camera far plane, metres. Pairs with fog density. */
  drawDistance: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: "low",
    maxPixelRatio: 1,
    shadowMapSize: 0,
    antialias: false,
    maxRivals: 2,
    anisotropy: 1,
    drawDistance: 650,
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 1.25,
    shadowMapSize: 1024,
    antialias: false,
    maxRivals: 3,
    anisotropy: 4,
    drawDistance: 950,
  },
  high: {
    tier: "high",
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    antialias: true,
    maxRivals: 5,
    anisotropy: 8,
    drawDistance: 1400,
  },
};

export const TIER_ORDER: QualityTier[] = ["low", "medium", "high"];

/** One step down, or the same tier if already at the bottom. */
export function demote(tier: QualityTier): QualityTier {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, i - 1)]!;
}
