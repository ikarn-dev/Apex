"use client";

import type { ReactNode } from "react";
import { WalletBoundary } from "./WalletBoundary";

/**
 * The single client boundary for the whole app.
 *
 * Deliberately thin. The wallet and chain stack is *not* mounted here — see
 * `WalletBoundary` — because putting 260KB gzip of Solana libraries above every
 * route made the landing page cost 457KB to read. Screens below this are free to
 * be server components where they have no interactivity.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <WalletBoundary>{children}</WalletBoundary>;
}
