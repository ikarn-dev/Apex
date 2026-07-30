"use client";

/**
 * Ephemeral Session state.
 *
 * This is the store the HUD's ER indicator reads, and it exists so the rollup
 * lifecycle is always visible rather than implied. Tick counters are updated at
 * a throttled rate by the tick queue — never per physics step.
 */

import { create } from "zustand";

export type SessionPhase =
  | "idle"
  | "opening"
  | "delegating"
  | "live"
  | "committing"
  | "committed"
  | "settling"
  | "settled"
  | "error"
  | "simulated";

export interface SessionSignature {
  label: string;
  signature: string;
  /** Which layer the signature belongs to. */
  layer: "base" | "er";
  at: number;
}

interface SessionState {
  phase: SessionPhase;
  /** RaceSession PDA, base58. */
  sessionPda: string | null;
  /** Nonce that derives the PDA. */
  nonce: string | null;
  /** Public key of the in-memory key authorised to advance this session. */
  sessionSigner: string | null;
  /** ER validator identity serving the session. */
  validator: string | null;
  /** Ticks accepted by the rollup. */
  ticksLanded: number;
  /** Ticks queued but not yet acknowledged. */
  ticksInFlight: number;
  /** Ticks abandoned after exhausting retries. */
  ticksDropped: number;
  /** Rolling average round-trip of a tick, ms. */
  avgTickMs: number;
  /** XP the rollup currently believes is earned. */
  xpInSession: number;
  /** Times the run has been banked mid-race (Act IV). */
  banks: number;
  signatures: SessionSignature[];
  error: string | null;

  begin: (args: {
    sessionPda: string;
    nonce: string;
    sessionSigner: string;
    validator: string | null;
  }) => void;
  setPhase: (phase: SessionPhase) => void;
  setValidator: (validator: string | null) => void;
  recordTick: (args: { landed: number; inFlight: number; rttMs: number }) => void;
  dropTicks: (count: number) => void;
  setXpInSession: (xp: number) => void;
  addSignature: (sig: SessionSignature) => void;
  registerBank: () => void;
  fail: (error: string) => void;
  reset: () => void;
}

const INITIAL = {
  phase: "idle" as SessionPhase,
  sessionPda: null,
  nonce: null,
  sessionSigner: null,
  validator: null,
  ticksLanded: 0,
  ticksInFlight: 0,
  ticksDropped: 0,
  avgTickMs: 0,
  xpInSession: 0,
  banks: 0,
  signatures: [] as SessionSignature[],
  error: null,
};

export const useSession = create<SessionState>()((set) => ({
  ...INITIAL,

  begin: ({ sessionPda, nonce, sessionSigner, validator }) =>
    set({
      ...INITIAL,
      phase: "delegating",
      sessionPda,
      nonce,
      sessionSigner,
      validator,
    }),

  setPhase: (phase) => set({ phase }),
  setValidator: (validator) => set({ validator }),

  recordTick: ({ landed, inFlight, rttMs }) =>
    set((s) => ({
      ticksLanded: landed,
      ticksInFlight: inFlight,
      // Exponential moving average keeps the HUD number stable.
      avgTickMs: s.avgTickMs === 0 ? rttMs : s.avgTickMs * 0.8 + rttMs * 0.2,
    })),

  dropTicks: (count) => set((s) => ({ ticksDropped: s.ticksDropped + count })),

  setXpInSession: (xp) => set({ xpInSession: xp }),

  addSignature: (sig) =>
    set((s) => ({ signatures: [...s.signatures.slice(-19), sig] })),

  registerBank: () => set((s) => ({ banks: s.banks + 1 })),

  fail: (error) => set({ phase: "error", error }),

  reset: () => set({ ...INITIAL }),
}));
