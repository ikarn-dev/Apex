"use client";

/**
 * Retry a claim for a run whose settlement did not land.
 *
 * The race shell drives the happy path (finish → settle → claim). This exists
 * for the unhappy one: the commit landed but the wallet rejected the claim, the
 * tab was closed, the RPC dropped. The XP is still sitting in a settled session
 * on the base layer, so all that is needed is `claim_xp` again.
 */

import { useCallback, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { COMMITMENT, CHAIN_ENABLED } from "../config";
import { getBaseConnection } from "../er/connections";
import { abandonSessionIx, claimXpIx } from "../program/instructions";
import { fetchDriverProfile } from "../er/session";
import { useWalletBridge } from "./useWalletBridge";
import { useProfile } from "@/stores/profile";

type Status = "idle" | "claiming" | "done" | "error";

export function useClaimRun() {
  const wallet = useWalletBridge();
  const resolvePendingRun = useProfile((s) => s.resolvePendingRun);
  const failPendingRun = useProfile((s) => s.failPendingRun);
  const dropPendingRun = useProfile((s) => s.dropPendingRun);

  const [status, setStatus] = useState<Status>("idle");
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const claim = useCallback(
    async (runId: string, sessionNonce: string | null): Promise<boolean> => {
      if (!CHAIN_ENABLED || !wallet || sessionNonce === null) {
        setError("No settleable session for this run.");
        setStatus("error");
        return false;
      }

      setStatus("claiming");
      setError(null);

      try {
        const base = getBaseConnection();
        const tx = new Transaction();
        tx.add(
          claimXpIx({ authority: wallet.publicKey, nonce: BigInt(sessionNonce) }),
        );

        const sig = await wallet.sendTransaction(tx, base);
        const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
        await base.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          COMMITMENT,
        );

        // Re-read rather than trusting a local increment: the profile is the
        // authority on how much XP is actually settled.
        const profile = await fetchDriverProfile(wallet.publicKey);
        resolvePendingRun(runId, profile?.xpCommitted ?? 0);

        setSignature(sig);
        setStatus("done");
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failPendingRun(runId, message);
        setError(message);
        setStatus("error");
        return false;
      }
    },
    [wallet, resolvePendingRun, failPendingRun],
  );

  /** FLATLINE by choice: close the session, recover the rent, forfeit the XP. */
  const discard = useCallback(
    async (runId: string, sessionNonce: string | null): Promise<void> => {
      if (CHAIN_ENABLED && wallet && sessionNonce !== null) {
        try {
          const base = getBaseConnection();
          const tx = new Transaction();
          tx.add(
            abandonSessionIx({
              authority: wallet.publicKey,
              nonce: BigInt(sessionNonce),
            }),
          );
          await wallet.sendTransaction(tx, base);
        } catch {
          // The account may already be gone. Either way, stop tracking it.
        }
      }
      dropPendingRun(runId);
    },
    [wallet, dropPendingRun],
  );

  return { claim, discard, status, signature, error, canClaim: Boolean(wallet) };
}
