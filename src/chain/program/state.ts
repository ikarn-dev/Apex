/**
 * Account decoders.
 *
 * Field order mirrors `programs/apex_racing/src/state.rs` exactly. Anchor lays
 * out an 8-byte discriminator followed by plain Borsh, so a hand-rolled reader
 * is enough and saves shipping the IDL machinery.
 */

import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { BorshReader, toSafeNumber } from "./borsh";
import { ACCOUNT, discriminatorMatches } from "./discriminators";

export interface DriverProfileAccount {
  authority: PublicKey;
  xpCommitted: number;
  /** Nonce to use for the next session. */
  sessionNonce: bigint;
  racesFinished: number;
  /** Indexed by level index; 0 means unset. */
  bestTimesMs: number[];
  /** Bitmask of cleared level indices. */
  clearedLevels: number;
  rank: number;
  bump: number;
}

export const SESSION_STATE = {
  open: 0,
  finished: 1,
  banked: 2,
  settled: 3,
  abandoned: 4,
} as const;

export type SessionStateValue = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

export interface RaceSessionAccount {
  authority: PublicKey;
  sessionSigner: PublicKey;
  nonce: bigint;
  seed: bigint;
  openedAt: number;
  xpEarned: number;
  xpBanked: number;
  tick: number;
  totalMs: number;
  bestLapMs: number;
  driftScore: number;
  elapsedMs: number;
  checkpointsHit: number;
  collisions: number;
  overtakes: number;
  levelId: number;
  carId: number;
  lapsCompleted: number;
  position: number;
  bankDeferredLaps: number;
  state: number;
  cleared: boolean;
  bump: number;
  replayHash: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeDriverProfile(data: Uint8Array): DriverProfileAccount | null {
  if (!discriminatorMatches(data, ACCOUNT.driverProfile)) return null;
  const r = new BorshReader(data, 8);
  return {
    authority: r.pubkey(),
    xpCommitted: toSafeNumber(r.u64()),
    sessionNonce: r.u64(),
    racesFinished: r.u32(),
    bestTimesMs: r.u32Array(8),
    clearedLevels: r.u16(),
    rank: r.u8(),
    bump: r.u8(),
  };
}

export function decodeRaceSession(data: Uint8Array): RaceSessionAccount | null {
  if (!discriminatorMatches(data, ACCOUNT.raceSession)) return null;
  const r = new BorshReader(data, 8);
  return {
    authority: r.pubkey(),
    sessionSigner: r.pubkey(),
    nonce: r.u64(),
    seed: r.u64(),
    openedAt: toSafeNumber(r.i64()),
    xpEarned: toSafeNumber(r.u64()),
    xpBanked: toSafeNumber(r.u64()),
    tick: r.u32(),
    totalMs: r.u32(),
    bestLapMs: r.u32(),
    driftScore: r.u32(),
    elapsedMs: r.u32(),
    checkpointsHit: r.u16(),
    collisions: r.u16(),
    overtakes: r.u16(),
    levelId: r.u8(),
    carId: r.u8(),
    lapsCompleted: r.u8(),
    position: r.u8(),
    bankDeferredLaps: r.u8(),
    state: r.u8(),
    cleared: r.u8() === 1,
    bump: r.u8(),
    replayHash: toHex(r.fixedBytes(32)),
  };
}

export function decodeDriverProfileAccount(
  account: AccountInfo<Buffer> | null,
): DriverProfileAccount | null {
  if (!account) return null;
  return decodeDriverProfile(new Uint8Array(account.data));
}

export function decodeRaceSessionAccount(
  account: AccountInfo<Buffer> | null,
): RaceSessionAccount | null {
  if (!account) return null;
  return decodeRaceSession(new Uint8Array(account.data));
}

/** Expand the on-chain bitmask into level indices. */
export function clearedLevelIndices(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i += 1) {
    if ((mask & (1 << i)) !== 0) out.push(i);
  }
  return out;
}
