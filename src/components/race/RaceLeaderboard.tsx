"use client";

/**
 * Live running order, down the left-hand side of the race.
 *
 * Fed from the same ~10Hz telemetry snapshot as the HUD, so it costs one React
 * reconcile per snapshot and nothing per frame. Rows are keyed on the racer id
 * rather than the array index, so a position swap animates as a reorder instead of
 * re-labelling two rows in place.
 *
 * What it shows, and why only this:
 *
 * - **Name.** Rivals are named after well-known drivers; the player names
 *   themselves before the race. Names are local — see `game/config/drivers`.
 * - **Gap.** Distance behind the leader, in metres. A time gap would be the
 *   conventional choice and it is a worse one here: converting distance to time
 *   needs a speed, and the honest speed to use changes every frame, so the number
 *   jitters. Metres are exact and mean the same thing at every point on the lap.
 * - **Penalty points.** XP already forfeited to contact. Shown on every row, so a
 *   rival who has been in the barriers is visibly paying for it too.
 * - **Wallet and XP, on the player's row only.** The address is the identity the
 *   program actually keys on, and the XP figure is what `claim_xp` will credit to
 *   it. A rival has neither, because a rival is an AI with a famous name.
 */

import type { StandingEntry, Telemetry } from "@/game/types";
import { formatNumber, shortenAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

export interface RaceLeaderboardProps {
  telemetry: Telemetry | null;
  /** Base58 wallet address, or null when running unconnected. */
  address: string | null;
  /** XP already committed on chain, for context next to the run's projection. */
  committedXp: number | null;
}

export function RaceLeaderboard({ telemetry, address, committedXp }: RaceLeaderboardProps) {
  const standings = telemetry?.standings ?? [];
  // A solo time attack has nothing to rank, and an empty panel over the road is
  // worse than no panel.
  if (standings.length < 2) return null;

  return (
    <div className="pointer-events-none select-none font-mono">
      <div className="w-56 border border-steel/70 bg-void/70 backdrop-blur-sm">
        <div className="flex items-baseline justify-between border-b border-steel/70 px-2 py-1">
          <span className="label text-fog">Order</span>
          <span className="label text-fog">Pen</span>
        </div>

        <ol>
          {standings.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ol>

        {address ? (
          <div className="border-t border-steel/70 px-2 py-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] text-fog">{shortenAddress(address)}</span>
              <span className="text-[10px] tabular-nums text-lime">
                +{formatNumber(telemetry?.projectedXp ?? 0)} XP
              </span>
            </div>
            {committedXp !== null ? (
              <p className="mt-0.5 text-[9px] tabular-nums text-fog">
                {formatNumber(committedXp)} XP banked · claim after the finish
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: StandingEntry }) {
  return (
    <li
      className={cn(
        "flex items-baseline gap-1.5 px-2 py-0.5 text-[11px] leading-tight",
        entry.isPlayer ? "bg-apex/15 text-chalk" : "text-fog",
      )}
    >
      <span className="w-3 shrink-0 tabular-nums text-right">{entry.position}</span>
      <span className={cn("flex-1 truncate", entry.isPlayer && "font-bold text-apex")}>
        {entry.name}
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums">
        {entry.position === 1 ? (
          entry.finished ? (
            "FIN"
          ) : (
            "—"
          )
        ) : (
          <span>{formatGap(entry.gapM)}</span>
        )}
      </span>
      <span
        className={cn(
          "w-9 shrink-0 text-right tabular-nums",
          entry.penaltyPoints > 0 ? "text-ember" : "text-steel",
        )}
      >
        {entry.penaltyPoints > 0 ? `−${formatNumber(entry.penaltyPoints)}` : "0"}
      </span>
    </li>
  );
}

/** Metres for anything close, kilometres once a car is a lap adrift. */
function formatGap(metres: number): string {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)}km`;
  return `${Math.round(metres)}m`;
}
