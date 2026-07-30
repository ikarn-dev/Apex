"use client";

/**
 * Adapts wallet-adapter to the plain `WalletBridge` the chain layer wants.
 *
 * Keeps React out of `chain/er/*`: the session manager takes a pubkey and a
 * send function, and knows nothing about hooks or providers.
 */

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletBridge } from "../er/session";

export function useWalletBridge(): WalletBridge | null {
  const { publicKey, sendTransaction, connected } = useWallet();

  return useMemo(() => {
    if (!connected || !publicKey) return null;
    return {
      publicKey,
      sendTransaction: (tx, connection) => sendTransaction(tx, connection),
    };
  }, [connected, publicKey, sendTransaction]);
}
