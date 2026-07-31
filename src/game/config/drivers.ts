/**
 * Driver identity.
 *
 * Names are cosmetic and local. Nothing here is ever written to the chain: the
 * program keys everything on the wallet's `DriverProfile` PDA, and a display name
 * is not something worth paying rent for or exposing to anyone else. The
 * leaderboard shows the player their own name and their wallet's short address; a
 * rival is just a name over an AI.
 *
 * Rival names are drawn deterministically from the run's seed, so the same seed
 * fields the same grid — which matters because a replay has to be verifiable
 * against the race it was driven in, and "who was P3" is part of that.
 */

import type { Rng } from "@/lib/rng";

/**
 * Rival name pool: surnames of well-known racing drivers.
 *
 * Surnames only, and ASCII only. The HUD and the leaderboard are monospaced and
 * narrow, so `HAKKINEN` fits where `Mika Häkkinen` does not, and a diacritic that
 * the display font lacks renders as a box.
 */
export const RIVAL_NAMES = [
  "SENNA",
  "PROST",
  "SCHUMACHER",
  "HAKKINEN",
  "HAMILTON",
  "VERSTAPPEN",
  "ALONSO",
  "VETTEL",
  "CLARK",
  "LAUDA",
  "FANGIO",
  "STEWART",
  "MANSELL",
  "RAIKKONEN",
  "HUNT",
  "VILLENEUVE",
  "ANDRETTI",
  "GURNEY",
  "MOSS",
  "BRABHAM",
  "MCRAE",
  "LOEB",
  "OGIER",
  "PETTY",
] as const;

/**
 * Rival liveries: body colour and paint finish.
 *
 * The roster is one car, so without this every rival is the same pale factory
 * paint as the player's and a six-car grid reads as one car photocopied. Only the
 * `ext_carpaint` material is retouched — the glass, carbon, chrome and rims stay
 * as authored, which is what keeps a recoloured car still looking like this car.
 *
 * `roughness` is here as well as colour because two cars in different colours but
 * identical finish still read as the same object. A matte entry and a gloss entry
 * next to each other look like two teams prepared them.
 *
 * Chosen against a low sun on orange rock: saturated mid-tones and one near-black
 * read clearly, while anything amber or sand-coloured disappears into the horizon.
 */
export interface RivalLivery {
  color: number;
  /** 0 is a mirror, 1 is chalk. The stock paint sits near 0.41. */
  roughness: number;
}

export const RIVAL_LIVERIES: readonly RivalLivery[] = [
  { color: 0x1f5fd8, roughness: 0.32 },
  { color: 0xc4302b, roughness: 0.45 },
  { color: 0xe9e7e1, roughness: 0.3 },
  { color: 0x17181d, roughness: 0.52 },
  { color: 0x1d9163, roughness: 0.38 },
  { color: 0x6d3fb8, roughness: 0.34 },
  { color: 0x2aa8bd, roughness: 0.42 },
  { color: 0xd06a1c, roughness: 0.5 },
];

/**
 * The livery for a given rival slot.
 *
 * Indexed rather than drawn from the seeded `Rng`, so the grid's colours are stable
 * for a given field size and two rivals can never collide on one colour while the
 * field is smaller than the palette.
 */
export function rivalLivery(index: number): RivalLivery {
  return RIVAL_LIVERIES[index % RIVAL_LIVERIES.length]!;
}

/** Shown when the player has not named themselves. */
export const DEFAULT_DRIVER_NAME = "PRIVATEER";

/** Longest name the leaderboard can show without truncating. */
export const MAX_DRIVER_NAME_LENGTH = 14;

/**
 * Normalise a player-supplied name.
 *
 * Uppercased and stripped to the character set the display font actually has, so a
 * pasted emoji or a right-to-left mark cannot break the layout of a panel that is
 * drawn over the race. Empty input falls back rather than rendering a blank row.
 */
export function sanitiseDriverName(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 .'-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DRIVER_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : DEFAULT_DRIVER_NAME;
}

/**
 * Distinct rival names for one grid.
 *
 * Drawn with a partial Fisher-Yates shuffle off the run's seeded `Rng` rather than
 * `rng.pick` per rival: picking independently repeats names on a six-car grid often
 * enough to notice, and two cars called SENNA in the same race reads as a bug.
 */
export function rivalNames(rng: Rng, count: number): string[] {
  const pool = [...RIVAL_NAMES];
  const wanted = Math.min(count, pool.length);
  for (let i = 0; i < wanted; i += 1) {
    const j = i + Math.floor(rng.next() * (pool.length - i));
    const swap = pool[j]!;
    pool[j] = pool[i]!;
    pool[i] = swap;
  }
  // A grid larger than the pool is not a case worth failing over; number the
  // overflow instead of repeating a name silently.
  return Array.from(
    { length: count },
    (_, i) => pool[i] ?? `CAR ${String(i + 1).padStart(2, "0")}`,
  );
}
