/**
 * Connections to the two layers.
 *
 * The base layer settles; the rollup executes. They are separate RPC endpoints
 * with separate blockhashes, and a transaction sent to the wrong one fails in
 * confusing ways, so the split is explicit everywhere rather than hidden behind
 * one client.
 *
 * If `NEXT_PUBLIC_MAGIC_ROUTER_RPC` is set we also expose a
 * `ConnectionMagicRouter`, which inspects a transaction's writable accounts and
 * forwards it to whichever layer currently owns them. Useful, but the public
 * devnet router needs an access key, so it stays optional.
 */

import { Connection } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BASE_RPC, COMMITMENT, ER_RPC, ER_WS, MAGIC_ROUTER_RPC } from "../config";

let baseConnection: Connection | null = null;
let erConnection: Connection | null = null;
let routerConnection: ConnectionMagicRouter | null = null;

/** Solana base layer. Where XP is permanent. */
export function getBaseConnection(): Connection {
  baseConnection ??= new Connection(BASE_RPC, { commitment: COMMITMENT });
  return baseConnection;
}

/** The Ephemeral Rollup. Where the race actually happens. */
export function getErConnection(): Connection {
  erConnection ??= new Connection(ER_RPC, {
    commitment: COMMITMENT,
    wsEndpoint: ER_WS,
    // Ticks are fire-and-forget; a slow confirmation must never stall a frame.
    confirmTransactionInitialTimeout: 10_000,
  });
  return erConnection;
}

export function getRouterConnection(): ConnectionMagicRouter | null {
  if (!MAGIC_ROUTER_RPC) return null;
  routerConnection ??= new ConnectionMagicRouter(MAGIC_ROUTER_RPC, {
    commitment: COMMITMENT,
  });
  return routerConnection;
}

/**
 * Identity of the rollup validator serving us, for the HUD.
 *
 * Only the router exposes this; without one we show the endpoint host instead of
 * inventing a value.
 */
export async function getClosestValidator(): Promise<string | null> {
  const router = getRouterConnection();
  if (!router) return null;
  try {
    const validator = await router.getClosestValidator();
    return validator.identity;
  } catch {
    return null;
  }
}

/** Human-readable label for the ER endpoint, shown in the session panel. */
export function erEndpointLabel(): string {
  try {
    return new URL(ER_RPC).host;
  } catch {
    return ER_RPC;
  }
}

/** Is the rollup answering at all? Used to decide Simulation mode. */
export async function probeEr(): Promise<boolean> {
  try {
    const version = await getErConnection().getVersion();
    return typeof version === "object" && version !== null;
  } catch {
    return false;
  }
}
