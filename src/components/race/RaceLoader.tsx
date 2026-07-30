"use client";

/**
 * Lazy boundary for the race view.
 *
 * three.js and pixi.js together are the largest thing this app ships. Loading
 * them behind `ssr: false` keeps them out of every other route's bundle, and out
 * of the server build entirely — neither library can be evaluated without a DOM.
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
