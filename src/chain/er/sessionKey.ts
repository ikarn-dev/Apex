/**
 * Session keys.
 *
 * The problem: a race writes 80-500 state transitions. If the wallet had to
 * approve each one, the game would be unplayable — and batching them until the
 * end would throw away the entire point of a 10ms rollup.
 *
 * The fix: mint a throwaway `Keypair` in the browser, record its pubkey in the
 * `RaceSession` account at `open_session`, and let it sign rollup transactions
 * locally. The program checks `race_session.session_signer == signer.key()`, so
 * this key's authority is exactly one thing: advancing that one race.
 *
 * What it cannot do — move lamports, touch the `DriverProfile`, claim XP, or
 * affect any other session. It is generated per race, kept in memory, and
 * dropped when the race ends.
 *
 * `sessionStorage` is used only so a mid-race page refresh can resume rather
 * than orphan the run. It is cleared on settle, and never written to
 * `localStorage`, so it does not outlive the tab.
 */

import { Keypair } from "@solana/web3.js";

const STORAGE_KEY = "apex.session-key.v1";

export interface StoredSessionKey {
  secret: number[];
  nonce: string;
  sessionPda: string;
  authority: string;
  createdAt: number;
}

let active: Keypair | null = null;

export function createSessionKey(): Keypair {
  active = Keypair.generate();
  return active;
}

export function getActiveSessionKey(): Keypair | null {
  return active;
}

export function setActiveSessionKey(keypair: Keypair | null): void {
  active = keypair;
}

/** Persist for the current tab only, so a refresh mid-race can resume. */
export function persistSessionKey(args: {
  keypair: Keypair;
  nonce: bigint;
  sessionPda: string;
  authority: string;
}): void {
  if (typeof sessionStorage === "undefined") return;
  const payload: StoredSessionKey = {
    secret: Array.from(args.keypair.secretKey),
    nonce: args.nonce.toString(),
    sessionPda: args.sessionPda,
    authority: args.authority,
    createdAt: Date.now(),
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private browsing or a full quota. Losing resume-after-refresh is
    // acceptable; the run itself is unaffected.
  }
}

export function loadSessionKey(): { keypair: Keypair; stored: StoredSessionKey } | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredSessionKey;
    if (!Array.isArray(stored.secret) || stored.secret.length !== 64) return null;
    // A stale session from hours ago is not worth resuming.
    if (Date.now() - stored.createdAt > 30 * 60 * 1000) {
      clearSessionKey();
      return null;
    }
    const keypair = Keypair.fromSecretKey(Uint8Array.from(stored.secret));
    active = keypair;
    return { keypair, stored };
  } catch {
    return null;
  }
}

export function clearSessionKey(): void {
  active = null;
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the in-memory key is already gone.
  }
}
