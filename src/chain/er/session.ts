/**
 * The Ephemeral Session lifecycle, end to end.
 *
 * ```
 *  base layer   open + delegate      (wallet signs — once, before the lights)
 *  rollup       tick × N             (session key signs — no prompts)
 *  rollup       finish_race          (session key)
 *  rollup       bank_run / settle_run(session key — commit / commit+undelegate)
 *  base layer   claim_xp             (wallet signs — once, after the flag)
 * ```
 *
 * Two wallet approvals per race, both outside of driving. Everything in between
 * is signed locally by a key that can only advance this one run.
 */

import type {
  Connection,
  Keypair,
  PublicKey} from "@solana/web3.js";
import {
  ComputeBudgetProgram,
  Transaction,
  type TransactionInstruction,
  type TransactionSignature,
} from "@solana/web3.js";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { COMMITMENT, ER_COMMIT_FREQUENCY_MS } from "../config";
import {
  abandonSessionIx,
  bankRunIx,
  claimXpIx,
  delegateSessionIx,
  finishRaceIx,
  initializeDriverIx,
  openSessionIx,
  settleRunIx,
} from "../program/instructions";
import { driverProfilePda, raceSessionPda } from "../program/pda";
import { decodeDriverProfile, decodeRaceSession } from "../program/state";
import type { DriverProfileAccount, RaceSessionAccount } from "../program/state";
import { getBaseConnection, getErConnection } from "./connections";
import {
  clearSessionKey,
  createSessionKey,
  persistSessionKey,
  setActiveSessionKey,
} from "./sessionKey";
import { TickQueue, type TickQueueStats } from "./tickQueue";
import type { TickPayload } from "@/game/types";

/** The slice of wallet-adapter this module needs. Keeps React out of here. */
export interface WalletBridge {
  publicKey: PublicKey;
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
}

export interface OpenSessionArgs {
  wallet: WalletBridge;
  levelIndex: number;
  carIndex: number;
  seed: bigint;
  onStats?: (stats: TickQueueStats) => void;
  onError?: (error: Error) => void;
}

export interface FinishArgs {
  totalMs: number;
  bestLapMs: number;
  position: number;
  overtakes: number;
  bankDeferredLaps: number;
  checkpointsPerLap: number;
  replayHash: Uint8Array;
}

/** Delegation adds a CPI chain and several account creations. */
const OPEN_COMPUTE_UNITS = 400_000;

export async function fetchDriverProfile(
  authority: PublicKey,
): Promise<DriverProfileAccount | null> {
  const connection = getBaseConnection();
  const info = await connection.getAccountInfo(driverProfilePda(authority), COMMITMENT);
  if (!info) return null;
  return decodeDriverProfile(new Uint8Array(info.data));
}

/**
 * Read a session from whichever layer currently owns it.
 *
 * While delegated, the base layer holds a stale copy and the live state is in
 * the rollup — so the rollup is tried first and the base layer is the fallback.
 */
export async function fetchRaceSession(
  authority: PublicKey,
  nonce: bigint,
): Promise<{ account: RaceSessionAccount; layer: "er" | "base" } | null> {
  const pda = raceSessionPda(authority, nonce);

  try {
    const erInfo = await getErConnection().getAccountInfo(pda, COMMITMENT);
    if (erInfo) {
      const decoded = decodeRaceSession(new Uint8Array(erInfo.data));
      if (decoded) return { account: decoded, layer: "er" };
    }
  } catch {
    // Rollup unreachable — fall through to the settled copy.
  }

  const baseInfo = await getBaseConnection().getAccountInfo(pda, COMMITMENT);
  if (!baseInfo) return null;
  const decoded = decodeRaceSession(new Uint8Array(baseInfo.data));
  return decoded ? { account: decoded, layer: "base" } : null;
}

export class ErSession {
  private queue: TickQueue | null = null;
  private finished = false;

  private constructor(
    readonly authority: PublicKey,
    readonly nonce: bigint,
    readonly sessionPda: PublicKey,
    readonly sessionKey: Keypair,
    readonly openSignature: TransactionSignature,
    private readonly wallet: WalletBridge,
  ) {}

  /**
   * Open the run and hand it to the rollup in a single transaction, so the
   * player sees one approval instead of two.
   */
  static async open(args: OpenSessionArgs): Promise<ErSession> {
    const base = getBaseConnection();
    const authority = args.wallet.publicKey;

    const profile = await fetchDriverProfile(authority);
    const nonce = profile ? profile.sessionNonce : 0n;

    const sessionKey = createSessionKey();
    const sessionPda = raceSessionPda(authority, nonce);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: OPEN_COMPUTE_UNITS }));
    if (!profile) {
      // First race: registration rides along in the same approval.
      tx.add(initializeDriverIx(authority));
    }
    tx.add(
      openSessionIx({
        authority,
        nonce,
        levelIndex: args.levelIndex,
        carIndex: args.carIndex,
        seed: args.seed,
        sessionSigner: sessionKey.publicKey,
      }),
    );
    tx.add(delegateSessionIx({ payer: authority, authority, nonce }));

    const signature = await args.wallet.sendTransaction(tx, base);
    const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
    await base.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    );

    persistSessionKey({
      keypair: sessionKey,
      nonce,
      sessionPda: sessionPda.toBase58(),
      authority: authority.toBase58(),
    });

    const session = new ErSession(
      authority,
      nonce,
      sessionPda,
      sessionKey,
      signature,
      args.wallet,
    );

    session.queue = new TickQueue({
      connection: getErConnection(),
      sessionPda,
      sessionKey,
      onStats: args.onStats,
      onError: args.onError,
    });
    session.queue.start();

    return session;
  }

  /** Called from the physics step. Synchronous and non-throwing by contract. */
  tick(payload: TickPayload): void {
    this.queue?.enqueue(payload);
  }

  get tickStats(): TickQueueStats {
    return (
      this.queue?.stats ?? { landed: 0, inFlight: 0, dropped: 0, lastRttMs: 0 }
    );
  }

  /**
   * Close the run inside the rollup. This is the transaction that produces the
   * authoritative XP, so unlike ticks it is confirmed before we continue.
   */
  async finish(args: FinishArgs): Promise<TransactionSignature> {
    if (this.queue) {
      await this.queue.flush();
      this.queue.stop();
    }
    this.finished = true;

    return this.sendOnRollup(
      finishRaceIx({
        sessionPda: this.sessionPda,
        sessionSigner: this.sessionKey.publicKey,
        ...args,
      }),
    );
  }

  /**
   * BANK RUN — commit rollup state to the base layer, stay delegated.
   *
   * Returns both signatures: the rollup transaction, and the base-layer
   * signature the commit produced once the validator relayed it.
   */
  async bank(): Promise<{ erSignature: string; baseSignature: string | null }> {
    const erSignature = await this.sendOnRollup(
      bankRunIx({
        sessionPda: this.sessionPda,
        sessionSigner: this.sessionKey.publicKey,
      }),
    );
    return { erSignature, baseSignature: await this.commitmentSignature(erSignature) };
  }

  /** SETTLE — final commit, then ownership returns to the base layer. */
  async settle(): Promise<{ erSignature: string; baseSignature: string | null }> {
    const erSignature = await this.sendOnRollup(
      settleRunIx({
        sessionPda: this.sessionPda,
        sessionSigner: this.sessionKey.publicKey,
      }),
    );
    return { erSignature, baseSignature: await this.commitmentSignature(erSignature) };
  }

  /** Move the settled XP onto the profile. The player's second approval. */
  async claim(): Promise<TransactionSignature> {
    const base = getBaseConnection();
    const tx = new Transaction();
    tx.add(claimXpIx({ authority: this.authority, nonce: this.nonce }));

    const signature = await this.wallet.sendTransaction(tx, base);
    const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
    await base.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    );
    this.dispose();
    return signature;
  }

  /** FLATLINE — retire without committing. Rent back, XP gone. */
  async abandon(): Promise<TransactionSignature> {
    const base = getBaseConnection();
    const tx = new Transaction();
    tx.add(abandonSessionIx({ authority: this.authority, nonce: this.nonce }));
    const signature = await this.wallet.sendTransaction(tx, base);
    this.dispose();
    return signature;
  }

  dispose(): void {
    this.queue?.stop();
    this.queue = null;
    setActiveSessionKey(null);
    clearSessionKey();
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Sign locally with the session key and confirm on the rollup. */
  private async sendOnRollup(
    ...instructions: TransactionInstruction[]
  ): Promise<TransactionSignature> {
    const er = getErConnection();
    const tx = new Transaction();
    tx.add(...instructions);

    const { blockhash, lastValidBlockHeight } = await er.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.sessionKey.publicKey;
    tx.sign(this.sessionKey);

    const signature = await er.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await er.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    );
    return signature;
  }

  /**
   * Resolve the base-layer signature a rollup commit produced.
   *
   * Best-effort: the commit is already scheduled and the ER's own
   * `commit_frequency_ms` will flush it regardless, so a timeout here costs us a
   * clickable explorer link, not the XP.
   */
  private async commitmentSignature(erSignature: string): Promise<string | null> {
    try {
      return await Promise.race([
        GetCommitmentSignature(erSignature, getErConnection()),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.min(ER_COMMIT_FREQUENCY_MS, 15_000)),
        ),
      ]);
    } catch {
      return null;
    }
  }
}
