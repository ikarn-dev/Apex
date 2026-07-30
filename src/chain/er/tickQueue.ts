/**
 * Tick queue.
 *
 * The engine can emit a state transition every physics step (60Hz). Sending one
 * transaction per step would swamp the validator without changing a single
 * number the player sees, so ticks are coalesced: deltas accumulate and a
 * transaction goes out at most every `TICK_FLUSH_MS`. Checkpoint and lap
 * crossings flush immediately, because those are the moments that matter.
 *
 * Two rules this file exists to enforce:
 *
 * 1. `enqueue()` is called from inside the fixed-step loop. It does arithmetic
 *    and returns. It never awaits, never allocates a transaction, never throws.
 * 2. A failed tick degrades scoring precision, never gameplay. Retries are
 *    bounded and then the tick is dropped and counted.
 *
 * Blockhashes are cached and refreshed on a timer for the same reason — a
 * `getLatestBlockhash` round-trip per tick would defeat the point of a 10ms
 * rollup.
 */

import type {
  Connection,
  Keypair,
  PublicKey} from "@solana/web3.js";
import {
  Transaction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { TICK_FLUSH_MS, TICK_MAX_IN_FLIGHT, TICK_RETRY_LIMIT } from "../config";
import { tickIx } from "../program/instructions";
import type { TickPayload } from "@/game/types";

const BLOCKHASH_TTL_MS = 4_000;

export interface TickQueueStats {
  landed: number;
  inFlight: number;
  dropped: number;
  lastRttMs: number;
}

export interface TickQueueOptions {
  connection: Connection;
  sessionPda: PublicKey;
  sessionKey: Keypair;
  onStats?: (stats: TickQueueStats) => void;
  onError?: (error: Error) => void;
}

interface PendingDeltas {
  checkpoint: number;
  lap: number;
  driftDelta: number;
  collisionDelta: number;
  elapsedMs: number;
  dirty: boolean;
}

export class TickQueue {
  private readonly connection: Connection;
  private readonly sessionPda: PublicKey;
  private readonly sessionKey: Keypair;
  private readonly onStats?: (stats: TickQueueStats) => void;
  private readonly onError?: (error: Error) => void;

  private pending: PendingDeltas = {
    checkpoint: 0,
    lap: 0,
    driftDelta: 0,
    collisionDelta: 0,
    elapsedMs: 0,
    dirty: false,
  };

  private landed = 0;
  private inFlight = 0;
  private dropped = 0;
  private lastRttMs = 0;

  private lastFlushAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private blockhash: BlockhashWithExpiryBlockHeight | null = null;
  private blockhashAt = 0;
  private blockhashInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(options: TickQueueOptions) {
    this.connection = options.connection;
    this.sessionPda = options.sessionPda;
    this.sessionKey = options.sessionKey;
    this.onStats = options.onStats;
    this.onError = options.onError;
  }

  start(): void {
    this.stopped = false;
    void this.refreshBlockhash();
    this.timer ??= setInterval(() => {
      void this.maybeFlush(false);
    }, TICK_FLUSH_MS);
  }

  /**
   * Called from the physics step. Synchronous, allocation-free, cannot throw.
   *
   * `checkpoint`, `lap` and `elapsedMs` are levels (latest wins); drift and
   * collisions are sums since the last flush, matching what the program's tick
   * handler expects.
   */
  enqueue(payload: TickPayload): void {
    if (this.stopped) return;
    const p = this.pending;
    const crossedGate = payload.checkpoint !== p.checkpoint || payload.lap !== p.lap;

    p.checkpoint = payload.checkpoint;
    p.lap = payload.lap;
    p.driftDelta += payload.driftDelta;
    p.collisionDelta += payload.collisions;
    p.elapsedMs = payload.elapsedMs;
    p.dirty = true;

    if (crossedGate) {
      // Don't wait out the coalescing window for a checkpoint or a lap line.
      void this.maybeFlush(true);
    }
  }

  /** Force out whatever is buffered. Called at the finish line. */
  async flush(): Promise<void> {
    await this.maybeFlush(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get stats(): TickQueueStats {
    return {
      landed: this.landed,
      inFlight: this.inFlight,
      dropped: this.dropped,
      lastRttMs: this.lastRttMs,
    };
  }

  private async maybeFlush(immediate: boolean): Promise<void> {
    if (this.stopped) return;
    const p = this.pending;
    if (!p.dirty) return;

    const now = Date.now();
    if (!immediate && now - this.lastFlushAt < TICK_FLUSH_MS) return;

    // Backpressure: if the rollup is behind, keep accumulating rather than
    // piling on more in-flight transactions.
    if (this.inFlight >= TICK_MAX_IN_FLIGHT) return;

    const batch = {
      checkpoint: p.checkpoint,
      lap: p.lap,
      driftDelta: Math.max(0, Math.round(p.driftDelta)),
      collisionDelta: Math.max(0, Math.round(p.collisionDelta)),
      elapsedMs: Math.max(0, Math.round(p.elapsedMs)),
    };

    // Reset before awaiting so ticks arriving during the send are not lost.
    p.driftDelta = 0;
    p.collisionDelta = 0;
    p.dirty = false;
    this.lastFlushAt = now;

    await this.send(batch, 0);
  }

  private async send(
    batch: {
      checkpoint: number;
      lap: number;
      driftDelta: number;
      collisionDelta: number;
      elapsedMs: number;
    },
    attempt: number,
  ): Promise<void> {
    this.inFlight += 1;
    const startedAt = performance.now();

    try {
      const blockhash = await this.getBlockhash();
      const tx = new Transaction();
      tx.add(
        tickIx({
          sessionPda: this.sessionPda,
          sessionSigner: this.sessionKey.publicKey,
          ...batch,
        }),
      );
      tx.recentBlockhash = blockhash.blockhash;
      tx.feePayer = this.sessionKey.publicKey;
      tx.sign(this.sessionKey);

      // Fire and forget: skip preflight and do not wait for confirmation. The
      // race must not pause for the chain.
      await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });

      this.landed += 1;
      this.lastRttMs = performance.now() - startedAt;
    } catch (error) {
      if (attempt < TICK_RETRY_LIMIT && !this.stopped) {
        // A stale blockhash is the usual cause; drop it and try once more.
        this.blockhash = null;
        this.inFlight -= 1;
        await this.send(batch, attempt + 1);
        return;
      }
      this.dropped += 1;
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (this.inFlight > 0) this.inFlight -= 1;
      this.onStats?.(this.stats);
    }
  }

  private async getBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    const fresh =
      this.blockhash !== null && Date.now() - this.blockhashAt < BLOCKHASH_TTL_MS;
    if (fresh) return this.blockhash!;
    await this.refreshBlockhash();
    if (!this.blockhash) throw new Error("no rollup blockhash available");
    return this.blockhash;
  }

  private async refreshBlockhash(): Promise<void> {
    // Collapse concurrent refreshes into one request.
    this.blockhashInFlight ??= (async () => {
      try {
        this.blockhash = await this.connection.getLatestBlockhash("processed");
        this.blockhashAt = Date.now();
      } finally {
        this.blockhashInFlight = null;
      }
    })();
    await this.blockhashInFlight;
  }
}
