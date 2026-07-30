/**
 * Campaign definition.
 *
 * Every act now races on the same supplied Suzuka circuit. Levels retain their
 * progression, scoring, rival, and surface-grip differences, but no longer own
 * procedural map descriptors or visual track palettes.
 */

import type { CarId } from "./cars";

export type LevelId =
  | "act1-harbor"
  | "act2-neon-mile"
  | "act3-sector7"
  | "act4-ridgeline"
  | "act5-apex"
  | "endless-time-attack";

export interface LevelEnvironment {
  /** Horizon and zenith sky colours. */
  skyTop: number;
  skyBottom: number;
  fog: number;
  /** Exponential fog density. Higher hides more distance = cheaper draw. */
  fogDensity: number;
  ground: number;
  sunColor: number;
  sunIntensity: number;
  /** Sun elevation/azimuth, radians. */
  sunElevation: number;
  sunAzimuth: number;
  ambient: number;
  ambientIntensity: number;
  /** Readable blue accent for daylight HUD and status details. */
  accent: number;
}

export interface StoryBeat {
  speaker: "HALO" | "KESTREL" | "VALIDATOR" | "SYSTEM";
  line: string;
  /** When to show it: before the countdown, on a given lap, or at the finish. */
  at: "pre" | "start" | "finish" | number;
}

export interface LevelDefinition {
  id: LevelId;
  act: number;
  /** Short code shown in the level list, e.g. "ACT I". */
  actLabel: string;
  title: string;
  /** The ER primitive this level exists to teach. */
  concept: string;
  conceptDetail: string;
  laps: number;
  rivals: number;
  /** Target time in ms. XP scales against this. */
  parMs: number;
  /** Fastest physically plausible time. The program rejects anything below. */
  floorMs: number;
  baseXp: number;
  driftMultiplier: number;
  cleanBonus: number;
  /** Act III gate: minimum drift score to pass. 0 = no gate. */
  driftTarget: number;
  /** Placing needed to clear the level. */
  targetPosition: number;
  /** Act I runs on the base layer only, to make the contrast felt. */
  erEnabled: boolean;
  /** Act IV: player may commit at each lap for an escalating risk multiplier. */
  bankingEnabled: boolean;
  /** Act V: rival AI runs at full skill with no rubber-banding. */
  bossRace: boolean;
  /** Driver XP required to unlock. */
  unlockXp: number;
  recommendedCar: CarId;
  /** Surface grip multiplier; geometry always comes from the supplied map. */
  gripScale: number;
  env: LevelEnvironment;
  story: StoryBeat[];
}

export const DAYLIGHT_CIRCUIT: LevelEnvironment = {
  skyTop: 0x68b7e4,
  skyBottom: 0xe8f4f8,
  fog: 0xcfe2e9,
  fogDensity: 0.00075,
  ground: 0x78a965,
  sunColor: 0xfff3d6,
  sunIntensity: 2.35,
  sunElevation: 0.72,
  sunAzimuth: -0.85,
  ambient: 0xd9e7ec,
  ambientIntensity: 1.15,
  accent: 0x087ea4,
};

export const LEVELS: Record<LevelId, LevelDefinition> = {
  "act1-harbor": {
    id: "act1-harbor",
    act: 1,
    actLabel: "ACT I",
    title: "Cold Start",
    concept: "Base layer",
    conceptDetail:
      "This run is recorded straight onto the Settlement Layer: one write, at the end, and you feel the wait. Everything after this exists to remove that wait.",
    laps: 1,
    rivals: 3,
    parMs: 249500,
    floorMs: 154500,
    baseXp: 400,
    driftMultiplier: 0.04,
    cleanBonus: 150,
    driftTarget: 0,
    targetPosition: 3,
    erEnabled: false,
    bankingEnabled: false,
    bossRace: false,
    unlockXp: 0,
    recommendedCar: "hatch",
    gripScale: 1,
    env: DAYLIGHT_CIRCUIT,
    story: [
      {
        speaker: "HALO",
        at: "pre",
        line: "No record, no session. Two laps on the main line so the ledger learns you exist.",
      },
      {
        speaker: "HALO",
        at: "finish",
        line: "Felt that pause at the line? That's the Settlement Layer thinking. We're going to fix that.",
      },
    ],
  },

  "act2-neon-mile": {
    id: "act2-neon-mile",
    act: 2,
    actLabel: "ACT II",
    title: "Delegation",
    concept: "delegate → commit",
    conceptDetail:
      "Your race account is handed off to an Ephemeral Session. Writes drop to ~10ms and cost you nothing. At the line you choose to commit — and only then is it real.",
    laps: 1,
    rivals: 5,
    parMs: 243000,
    floorMs: 150500,
    baseXp: 700,
    driftMultiplier: 0.06,
    cleanBonus: 250,
    driftTarget: 0,
    targetPosition: 3,
    erEnabled: true,
    bankingEnabled: false,
    bossRace: false,
    unlockXp: 0,
    recommendedCar: "hatch",
    gripScale: 1,
    env: DAYLIGHT_CIRCUIT,
    story: [
      {
        speaker: "HALO",
        at: "pre",
        line: "Handing your race off the main line. Ten milliseconds a write, zero toll. Don't get attached — it isn't real until we commit.",
      },
      {
        speaker: "HALO",
        at: "start",
        line: "Session's live. Every checkpoint you clip is already on the rollup.",
      },
      {
        speaker: "HALO",
        at: "finish",
        line: "Now bank it. One write to the Settlement Layer and the whole run is yours.",
      },
    ],
  },

  "act3-sector7": {
    id: "act3-sector7",
    act: 3,
    actLabel: "ACT III",
    title: "Tick Rate",
    concept: "High-frequency writes",
    conceptDetail:
      "Every tick of a slide is its own state transition. Hold a drift and watch the tick counter climb into the thousands — on the base layer that single corner would bankrupt you.",
    laps: 1,
    rivals: 5,
    parMs: 225000,
    floorMs: 139500,
    baseXp: 850,
    driftMultiplier: 0.14,
    cleanBonus: 300,
    // Measured: a clean lap scores ~30, a drift-seeking lap ~360.
    driftTarget: 220,
    targetPosition: 3,
    erEnabled: true,
    bankingEnabled: false,
    bossRace: false,
    unlockXp: 2_500,
    recommendedCar: "hatch",
    // Act III keeps a lower-grip surface so controlled handbrake drift remains
    // the level objective without changing the supplied circuit geometry.
    gripScale: 0.72,
    env: DAYLIGHT_CIRCUIT,
    story: [
      {
        speaker: "KESTREL",
        at: "pre",
        line: "Count them, rookie. Every ten milliseconds of slide is a line in the session. Try that on the main line and you'd go broke in one corner.",
      },
      {
        speaker: "KESTREL",
        at: "start",
        line: "That's it — stay sideways. The rollup doesn't care how many writes you throw at it.",
      },
      {
        speaker: "HALO",
        at: "finish",
        line: "Four figures of writes, zero lamports out of your pocket. That's the whole trick.",
      },
    ],
  },

  "act4-ridgeline": {
    id: "act4-ridgeline",
    act: 4,
    actLabel: "ACT IV",
    title: "The Commit Window",
    concept: "Finality as a choice",
    conceptDetail:
      "You may commit at the end of any lap. Bank early and the XP is permanent. Defer and every uncommitted lap adds +25% — but flatline now and you lose all of it, because none of it was ever settled.",
    laps: 2,
    rivals: 5,
    parMs: 477000,
    floorMs: 295500,
    baseXp: 1_100,
    driftMultiplier: 0.09,
    cleanBonus: 400,
    driftTarget: 0,
    targetPosition: 2,
    erEnabled: true,
    bankingEnabled: true,
    bossRace: false,
    unlockXp: 10_000,
    recommendedCar: "hatch",
    gripScale: 0.92,
    env: DAYLIGHT_CIRCUIT,
    story: [
      {
        speaker: "VALIDATOR",
        at: "pre",
        line: "You mistake speed for a result. A number no one has settled is a rumour.",
      },
      {
        speaker: "HALO",
        at: "start",
        line: "Ignore him. But — Rookie — he's not wrong about the rumour part. Bank when your gut says bank.",
      },
      {
        speaker: "HALO",
        at: 2,
        line: "Multiplier's climbing. So is what you stand to lose.",
      },
    ],
  },

  "act5-apex": {
    id: "act5-apex",
    act: 5,
    actLabel: "ACT V",
    title: "Undelegate",
    concept: "commit_and_undelegate",
    conceptDetail:
      "The clean close. Final state is flushed to the Settlement Layer and ownership of your account returns to the base layer, carrying everything you earned. Handing it back is the point, not the defeat.",
    // One full supplied-circuit lap keeps the finale near five minutes.
    laps: 1,
    rivals: 5,
    parMs: 242500,
    floorMs: 150500,
    baseXp: 1_600,
    driftMultiplier: 0.1,
    cleanBonus: 600,
    driftTarget: 0,
    targetPosition: 1,
    erEnabled: true,
    bankingEnabled: true,
    bossRace: true,
    unlockXp: 30_000,
    recommendedCar: "hatch",
    gripScale: 1,
    env: DAYLIGHT_CIRCUIT,
    story: [
      {
        speaker: "VALIDATOR",
        at: "pre",
        line: "Sanctioned circuit. My rules. Nothing you have done off the main line counts here.",
      },
      {
        speaker: "HALO",
        at: "start",
        line: "One full lap. Win it and I close the session properly — committed and handed back.",
      },
      {
        speaker: "HALO",
        at: "finish",
        line: "Committing and returning the account. Ledger's got it. That's permanent now — you're on the board, Rookie.",
      },
    ],
  },

  "endless-time-attack": {
    id: "endless-time-attack",
    act: 6,
    actLabel: "ENDLESS",
    title: "Time Attack",
    concept: "Session on demand",
    conceptDetail:
      "One session, one clean lap set, commit or discard. No rivals, no excuses — just you and whatever the ledger already thinks you're worth.",
    laps: 1,
    rivals: 0,
    parMs: 255500,
    floorMs: 158500,
    baseXp: 600,
    driftMultiplier: 0.11,
    cleanBonus: 350,
    driftTarget: 0,
    targetPosition: 1,
    erEnabled: true,
    bankingEnabled: true,
    bossRace: false,
    unlockXp: 0,
    recommendedCar: "hatch",
    gripScale: 0.96,
    env: DAYLIGHT_CIRCUIT,
    story: [
      {
        speaker: "HALO",
        at: "pre",
        line: "Session's open. Nobody's watching but the ledger.",
      },
    ],
  },
};

export const CAMPAIGN_ORDER: LevelId[] = [
  "act1-harbor",
  "act2-neon-mile",
  "act3-sector7",
  "act4-ridgeline",
  "act5-apex",
];

export const LEVEL_IDS = Object.keys(LEVELS) as LevelId[];

/** Stable index used by the on-chain program (u8). Order must never change. */
export const LEVEL_INDEX: Record<LevelId, number> = {
  "act1-harbor": 0,
  "act2-neon-mile": 1,
  "act3-sector7": 2,
  "act4-ridgeline": 3,
  "act5-apex": 4,
  "endless-time-attack": 5,
};

export function isLevelId(value: string): value is LevelId {
  return value in LEVELS;
}

export function getLevel(id: string): LevelDefinition | undefined {
  return isLevelId(id) ? LEVELS[id] : undefined;
}

export function levelFromIndex(index: number): LevelDefinition | undefined {
  const id = LEVEL_IDS.find((l) => LEVEL_INDEX[l] === index);
  return id ? LEVELS[id] : undefined;
}
