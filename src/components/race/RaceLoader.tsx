"use client";

/**
 * Lazy boundary for the race view.
 *
 * three.js is the largest thing this app ships. Loading it behind `ssr: false`
 * keeps it out of every other route's bundle, and out of the server build
 * entirely — it cannot be evaluated without a DOM. That also means the race view
 * never server-renders, so the engine, the device probe and the seeded RNG inside
 * it can read browser globals directly without risking a hydration mismatch.
 */

import dynamic from "next/dynamic";
import { useRequireWallet } from "@/components/providers/WalletBoundary";
import type { LevelDefinition } from "@/game/config/levels";

const RaceShell = dynamic(
  () => import("./RaceShell").then((module) => module.RaceShell),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-dvh w-full items-center justify-center bg-void">
        <div className="text-center">
          <p className="font-display text-2xl font-bold tracking-tight text-chalk">
            APEX
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-fog">
            Loading engine
          </p>
        </div>
      </div>
    ),
  },
);

export function RaceLoader({ level }: { level: LevelDefinition }) {
  // Mount the wallet stack *before* the engine exists. Activating the boundary
  // changes the element type above the tree, which remounts it — harmless on a
  // menu, catastrophic mid-race, since it would tear down the WebGL context. So
  // the race route always pays for it up front, even in Practice mode.
  const walletReady = useRequireWallet();

  if (!walletReady) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-void">
        <div className="text-center">
          <p className="font-display text-2xl font-bold tracking-tight text-chalk">APEX</p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-fog">
            Opening the grid
          </p>
        </div>
      </div>
    );
  }

  return <RaceShell level={level} />;
}
