"use client";

/**
 * The real connect control, rendered only once the wallet stack is mounted.
 *
 * Split from `ConnectButton` so that the `useWallet` / `useWalletModal` imports —
 * and therefore the adapter and web3.js — are reachable only from inside the
 * `WalletBoundary`.
 *
 * It opens the wallet modal on mount when it was reached by the player pressing
 * Connect, so activating the boundary and choosing a wallet is a single gesture
 * rather than two clicks on the same button.
 */

import { useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Button } from "@/components/ui/Button";
import { shortenAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

export function LiveConnectButton({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const openedOnce = useRef(false);

  // Open the picker as soon as we exist, unless the adapter is already
  // reconnecting a remembered wallet on its own.
  useEffect(() => {
    if (openedOnce.current || connected || connecting || wallet) return;
    openedOnce.current = true;
    setVisible(true);
  }, [connected, connecting, wallet, setVisible]);

  const onClick = useCallback(() => {
    if (connected) void disconnect();
    else setVisible(true);
  }, [connected, disconnect, setVisible]);

  if (connected && publicKey) {
    return (
      <Button
        variant="secondary"
        size={size}
        onClick={onClick}
        className={cn("group", className)}
        title={`${wallet?.adapter.name ?? "Wallet"} — click to disconnect`}
      >
        <span className="size-1.5 rounded-full bg-lime" aria-hidden="true" />
        <span className="group-hover:hidden">{shortenAddress(publicKey.toBase58())}</span>
        <span className="hidden group-hover:inline">Disconnect</span>
      </Button>
    );
  }

  return (
    <Button
      variant="primary"
      size={size}
      onClick={onClick}
      disabled={connecting}
      className={className}
    >
      {connecting ? "Connecting…" : "Connect Wallet"}
    </Button>
  );
}
