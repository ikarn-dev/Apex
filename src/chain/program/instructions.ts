/**
 * Instruction builders for `apex_racing`.
 *
 * Account order in every `keys` array must match the field order of the
 * corresponding `#[derive(Accounts)]` struct after macro expansion. The
 * delegation case is the subtle one — see `delegateSessionIx`.
 */

import type {
  PublicKey} from "@solana/web3.js";
import {
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { APEX_PROGRAM_ID } from "../programId";
import { BorshWriter } from "./borsh";
import { IX } from "./discriminators";
import { driverProfilePda, nonceToLeBytes, raceSessionPda } from "./pda";

function programId(): PublicKey {
  if (!APEX_PROGRAM_ID) {
    throw new Error("apex_racing program id is not configured");
  }
  return APEX_PROGRAM_ID;
}

function data(discriminator: Uint8Array, write?: (w: BorshWriter) => void): Buffer {
  const w = new BorshWriter(128);
  w.bytes(discriminator);
  write?.(w);
  return w.toBuffer();
}

// ------------------------------------------------------------------ base layer

/** `InitializeDriver`: authority, driver_profile, system_program. */
export function initializeDriverIx(authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: driverProfilePda(authority), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data(IX.initializeDriver),
  });
}

/** `OpenSession`: authority, driver_profile, race_session, system_program. */
export function openSessionIx(args: {
  authority: PublicKey;
  nonce: bigint;
  levelIndex: number;
  carIndex: number;
  seed: bigint;
  sessionSigner: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      {
        pubkey: driverProfilePda(args.authority),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: raceSessionPda(args.authority, args.nonce),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data(IX.openSession, (w) =>
      w
        .u64(args.nonce)
        .u8(args.levelIndex)
        .u8(args.carIndex)
        .u64(args.seed)
        .pubkey(args.sessionSigner),
    ),
  });
}

/**
 * `DelegateSession`.
 *
 * `#[delegate]` rewrites the struct: for the field marked `#[account(mut, del)]`
 * it inserts the buffer, delegation record and delegation metadata accounts
 * *before* the field itself, then appends `owner_program`, `delegation_program`
 * and `system_program`. The resulting order is what this builder reproduces —
 * getting it wrong surfaces as an opaque `AccountNotEnoughKeys`.
 *
 * Note which program each PDA belongs to: the delegate buffer is derived under
 * *our* program, the record and metadata under the delegation program.
 */
export function delegateSessionIx(args: {
  payer: PublicKey;
  authority: PublicKey;
  nonce: bigint;
}): TransactionInstruction {
  const pid = programId();
  const session = raceSessionPda(args.authority, args.nonce);

  return new TransactionInstruction({
    programId: pid,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      {
        pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(session, pid),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationRecordPdaFromDelegatedAccount(session),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationMetadataPdaFromDelegatedAccount(session),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: pid, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data(IX.delegateSession, (w) => w.u64(args.nonce)),
  });
}

/** `ClaimXp`: authority, driver_profile, race_session. */
export function claimXpIx(args: {
  authority: PublicKey;
  nonce: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      {
        pubkey: driverProfilePda(args.authority),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: raceSessionPda(args.authority, args.nonce),
        isSigner: false,
        isWritable: true,
      },
    ],
    data: data(IX.claimXp),
  });
}

/** Same accounts as `claimXpIx` — the run is closed without crediting XP. */
export function abandonSessionIx(args: {
  authority: PublicKey;
  nonce: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      {
        pubkey: driverProfilePda(args.authority),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: raceSessionPda(args.authority, args.nonce),
        isSigner: false,
        isWritable: true,
      },
    ],
    data: data(IX.abandonSession),
  });
}

// ---------------------------------------------------------------- rollup writes

/**
 * `Tick`: race_session, session_signer.
 *
 * Signed by the throwaway session key, not the wallet. Deltas are aggregates
 * covering everything since the previous tick.
 */
export function tickIx(args: {
  sessionPda: PublicKey;
  sessionSigner: PublicKey;
  checkpoint: number;
  lap: number;
  driftDelta: number;
  collisionDelta: number;
  elapsedMs: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: args.sessionPda, isSigner: false, isWritable: true },
      { pubkey: args.sessionSigner, isSigner: true, isWritable: false },
    ],
    data: data(IX.tick, (w) =>
      w
        .u16(args.checkpoint)
        .u8(args.lap)
        .u32(args.driftDelta)
        .u16(args.collisionDelta)
        .u32(args.elapsedMs),
    ),
  });
}

/** `finish_race` reuses the `Tick` accounts struct. */
export function finishRaceIx(args: {
  sessionPda: PublicKey;
  sessionSigner: PublicKey;
  totalMs: number;
  bestLapMs: number;
  position: number;
  overtakes: number;
  bankDeferredLaps: number;
  checkpointsPerLap: number;
  replayHash: Uint8Array;
}): TransactionInstruction {
  if (args.replayHash.length !== 32) {
    throw new Error("replayHash must be 32 bytes");
  }
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: args.sessionPda, isSigner: false, isWritable: true },
      { pubkey: args.sessionSigner, isSigner: true, isWritable: false },
    ],
    data: data(IX.finishRace, (w) =>
      w
        .u32(args.totalMs)
        .u32(args.bestLapMs)
        .u8(args.position)
        .u16(args.overtakes)
        .u8(args.bankDeferredLaps)
        .u16(args.checkpointsPerLap)
        .bytes(args.replayHash),
    ),
  });
}

/**
 * `CommitSession`: payer, race_session, magic_program, magic_context.
 *
 * `#[commit]` appends the last two. Both `bank_run` and `settle_run` use this
 * layout; they differ only in the discriminator and in whether the rollup
 * releases the account afterwards.
 */
function commitLikeIx(
  discriminator: Uint8Array,
  args: { sessionPda: PublicKey; sessionSigner: PublicKey },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: args.sessionSigner, isSigner: true, isWritable: true },
      { pubkey: args.sessionPda, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ],
    data: data(discriminator),
  });
}

/** BANK RUN — flush to the base layer, stay delegated. */
export function bankRunIx(args: {
  sessionPda: PublicKey;
  sessionSigner: PublicKey;
}): TransactionInstruction {
  return commitLikeIx(IX.bankRun, args);
}

/** SETTLE — final flush and hand the account back to the base layer. */
export function settleRunIx(args: {
  sessionPda: PublicKey;
  sessionSigner: PublicKey;
}): TransactionInstruction {
  return commitLikeIx(IX.settleRun, args);
}

export { nonceToLeBytes };
