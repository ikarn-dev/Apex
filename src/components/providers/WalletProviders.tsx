"use client";

/**
 * Wallet plumbing.
 *
 * Sign-in is wallet-adapter only — there is no email, social or custodial path
 * anywhere in this app.
 *
 * Note the empty `wallets` array. Phantom, Solflare, Backpack and every other
 * modern Solana wallet implements the Wallet Standard, which
 * `@solana/wallet-adapter-react` discovers at runtime. Installing
 * `@solana/wallet-adapter-wallets` to get named adapters would drag
 * WalletConnect, Torus and web3auth into the bundle for wallets we already
 * detect for free.
 */

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { ProfileSync } from "./ProfileSync";
import type { Adapter } from "@solana/wallet-adapter-base";
import { BASE_RPC, COMMITMENT } from "@/chain/config";

import "@solana/wallet-adapter-react-ui/styles.css";

export function WalletProviders({ children }: { children: ReactNode }) {
  // Desktop build: extension and Wallet Standard wallets only.
  const wallets = useMemo<Adapter[]>(() => [], []);

  return (
    <ConnectionProvider endpoint={BASE_RPC} config={{ commitment: COMMITMENT }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {/* Lives here rather than in the root layout so it only exists once
              there is a wallet to sync from. */}
          <ProfileSync />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
