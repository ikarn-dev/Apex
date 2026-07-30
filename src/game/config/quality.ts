/**
 * Quality tiers.
 *
 * Detection is deliberately pessimistic: a wrong guess upward means a machine
 * that stutters, a wrong guess downward means slightly softer shadows. The
 * runtime governor may only ever *demote* a tier, never promote, so a machine
 * that thermally throttles settles instead of oscillating.
 */

export type QualityTier = "low" | "medium" | "high";

export interface QualitySettings {
  tier: QualityTier;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  /** 0 disables shadow mapping entirely. */
  shadowMapSize: number;
  bloom: boolean;
  /** Antialiasing in the WebGL context. */
  antialias: boolean;
  /** Rival cars actually spawned, capped from the level definition. */
  maxRivals: number;
  /** Roadside props drawn per side. */
  propDensity: number;
  /** Tyre-smoke particle budget. */
  particleBudget: number;
  /** Anisotropic filtering cap. */
  anisotropy: number;
  /** Camera far plane, metres. Pairs with fog density. */
  drawDistance: number;
  /** Reflections on car bodywork. */
  envProbe: boolean;
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: "low",
    maxPixelRatio: 1,
    shadowMapSize: 0,
    bloom: false,
    antialias: false,
    maxRivals: 3,
    propDensity: 6,
    particleBudget: 0,
    anisotropy: 1,
    drawDistance: 600,
    envProbe: false,
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 1.25,
    shadowMapSize: 512,
    bloom: false,
    antialias: false,
    maxRivals: 5,
    propDensity: 14,
    particleBudget: 48,
    anisotropy: 2,
    drawDistance: 900,
    envProbe: false,
  },
  high: {
    tier: "high",
    maxPixelRatio: 2,
    shadowMapSize: 1024,
    bloom: true,
    antialias: true,
    maxRivals: 5,
    propDensity: 26,
    particleBudget: 128,
    anisotropy: 4,
    drawDistance: 1400,
    envProbe: true,
  },
};

export const TIER_ORDER: QualityTier[] = ["low", "medium", "high"];

/** One step down, or the same tier if already at the bottom. */
export function demote(tier: QualityTier): QualityTier {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, i - 1)]!;
}
