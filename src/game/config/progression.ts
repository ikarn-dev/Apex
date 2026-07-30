/** Rank tiers. Mirrored in `programs/apex_racing/src/xp.rs::rank_for_xp`. */

import type { CarId } from "./cars";
import type { LevelId } from "./levels";

export type RankId = "rookie" | "street" | "circuit" | "apex" | "legend";

export interface RankDefinition {
  id: RankId;
  /** u8 stored on the driver profile. */
  index: number;
  name: string;
  xp: number;
  accent: number;
  cssAccent: string;
  unlocks: string[];
}

export const RANKS: RankDefinition[] = [
  {
    id: "rookie",
    index: 0,
    name: "ROOKIE",
    xp: 0,
    accent: 0x6b7885,
    cssAccent: "var(--color-fog)",
    unlocks: ["EVO-37", "Act I – II"],
  },
  {
    id: "street",
    index: 1,
    name: "STREET",
    xp: 2_500,
    accent: 0x4ade80,
    cssAccent: "var(--color-lime)",
    unlocks: ["Act III", "Neon liveries"],
  },
  {
    id: "circuit",
    index: 2,
    name: "CIRCUIT",
    xp: 10_000,
    accent: 0x00e5ff,
    cssAccent: "var(--color-apex)",
    unlocks: ["PHANTOM 765", "Act IV"],
  },
  {
    id: "apex",
    index: 3,
    name: "APEX",
    xp: 30_000,
    accent: 0xffb300,
    cssAccent: "var(--color-amber)",
    unlocks: ["ZAGATO GT", "Act V"],
  },
  {
    id: "legend",
    index: 4,
    name: "LEGEND",
    xp: 75_000,
    accent: 0xa855f7,
    cssAccent: "var(--color-violet)",
    unlocks: ["Ghost Duel", "Legend livery"],
  },
];

export function rankForXp(xp: number): RankDefinition {
  let current = RANKS[0]!;
  for (const rank of RANKS) {
    if (xp >= rank.xp) current = rank;
  }
  return current;
}

export function nextRank(xp: number): RankDefinition | null {
  return RANKS.find((r) => r.xp > xp) ?? null;
}

/** Progress toward the next rank, 0-1. Returns 1 at LEGEND. */
export function rankProgress(xp: number): number {
  const current = rankForXp(xp);
  const next = nextRank(xp);
  if (!next) return 1;
  const span = next.xp - current.xp;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (xp - current.xp) / span));
}

export function isCarUnlocked(carUnlockXp: number, xp: number): boolean {
  return xp >= carUnlockXp;
}

export function isLevelUnlocked(levelUnlockXp: number, xp: number): boolean {
  return xp >= levelUnlockXp;
}

/** Everything newly available when crossing from `beforeXp` to `afterXp`. */
export function unlocksBetween(
  beforeXp: number,
  afterXp: number,
  cars: { id: CarId; name: string; unlockXp: number }[],
  levels: { id: LevelId; title: string; unlockXp: number }[],
): { cars: CarId[]; levels: LevelId[]; rank: RankDefinition | null } {
  const rankBefore = rankForXp(beforeXp);
  const rankAfter = rankForXp(afterXp);
  return {
    cars: cars.filter((c) => c.unlockXp > beforeXp && c.unlockXp <= afterXp).map((c) => c.id),
    levels: levels
      .filter((l) => l.unlockXp > beforeXp && l.unlockXp <= afterXp)
      .map((l) => l.id),
    rank: rankAfter.index > rankBefore.index ? rankAfter : null,
  };
}
