/**
 * Chain configuration.
 *
 * All endpoints are overridable through `NEXT_PUBLIC_*` env vars so the same
 * build can point at devnet, a local validator, or a private ER.
 */

/**
 * Note what this module does *not* import: `@solana/web3.js`.
 *
 * It is 226KB gzip, and a single `new PublicKey()` at module scope here would
 * drag it into the bundle of every route that reads a cluster name — including
 * Settings and the landing page, which never touch the chain. The parsed
 * `PublicKey` lives in `./programId` instead, which only chain code imports.
 */

export type Cluster = "devnet" | "testnet" | "mainnet-beta" | "custom";

/** Placeholder id from .env.example — means "no program deployed yet". */
const UNSET_PROGRAM_ID = "ApeXRacing11111111111111111111111111111111";

function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : fallback;
}

export const CLUSTER = env("NEXT_PUBLIC_SOLANA_CLUSTER", "devnet") as Cluster;

export const BASE_RPC = env("NEXT_PUBLIC_SOLANA_RPC", "https://api.devnet.solana.com");

/** Verified reachable 2026-07-29: magicblock-core 0.13.17. */
export const ER_RPC = env("NEXT_PUBLIC_ER_RPC", "https://devnet.magicblock.app");
export const ER_WS = env("NEXT_PUBLIC_ER_WS", "wss://devnet.magicblock.app");

/**
 * Optional magic-router endpoint. When present, one connection transparently
 * routes each transaction to the base layer or the ER based on whether its
 * writable accounts are delegated. The public devnet router requires an access
 * key (it answers 403 without one), so this stays opt-in.
 */
export const MAGIC_ROUTER_RPC = process.env.NEXT_PUBLIC_MAGIC_ROUTER_RPC ?? null;

/** How often the ER flushes delegated state to the base layer on its own. */
export const ER_COMMIT_FREQUENCY_MS = Number(
  env("NEXT_PUBLIC_ER_COMMIT_FREQUENCY_MS", "30000"),
);

/** Raw, unparsed program id. `./programId` turns this into a `PublicKey`. */
export const APEX_PROGRAM_ID_BASE58 = env(
  "NEXT_PUBLIC_APEX_PROGRAM_ID",
  UNSET_PROGRAM_ID,
);

/**
 * Whether the chain path is even possible in this deployment.
 *
 * `false` puts the game into Simulation mode: identical gameplay, XP kept in
 * local storage, an explicit banner, and no pretence that anything settled.
 *
 * Base58 is checked by shape only, so this stays free of web3.js. The real parse
 * happens in `./programId`.
 */
export const CHAIN_ENABLED =
  APEX_PROGRAM_ID_BASE58 !== UNSET_PROGRAM_ID &&
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(APEX_PROGRAM_ID_BASE58);

export const EXPLORER_BASE = "https://explorer.solana.com";

export function explorerTx(signature: string): string {
  const suffix = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;
  return `${EXPLORER_BASE}/tx/${signature}${suffix}`;
}

export function explorerAddress(address: string): string {
  const suffix = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;
  return `${EXPLORER_BASE}/address/${address}${suffix}`;
}

/** Commitment used everywhere. `confirmed` is the right trade for a game. */
export const COMMITMENT = "confirmed" as const;

/**
 * Tick batching.
 *
 * The engine can produce a state transition every physics step. Sending each
 * one individually would flood the validator for no visible benefit, so ticks
 * are coalesced into at most one transaction per `TICK_FLUSH_MS`. Checkpoint
 * and lap crossings bypass the coalescing and flush immediately.
 */
export const TICK_FLUSH_MS = 120;
export const TICK_MAX_IN_FLIGHT = 3;
export const TICK_RETRY_LIMIT = 2;
