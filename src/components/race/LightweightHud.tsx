"use client";

/**
 * The race HUD.
 *
 * DOM, not a second canvas. The previous HUD was a full PixiJS application with
 * its own WebGL context and its own animation frame — 130KB gzip, a second GL
 * context competing with the scene for the GPU, and a whole render loop to keep
 * in step with the engine's. This replaces it with a handful of elements fed by
 * the engine's throttled telemetry snapshot.
 *
 * The trade that makes it work: nothing here animates per frame. The engine
 * publishes ~10 snapshots a second, so React reconciles ten times a second while
 * the scene runs at 60. Gauges therefore use CSS transitions rather than
 * per-frame interpolation, and the needle catching up 100ms later is not
 * something a driver can see.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Telemetry } from "@/game/types";
import { formatLapTime, formatNumber } from "@/lib/format";

export type PopupTone = "xp" | "drift" | "penalty";

export interface HudPopup {
  id: number;
  text: string;
  tone: PopupTone;
}

const POPUP_MS = 1_600;

/** Rising, fading callouts: lap times, overtakes, drift payouts, contact. */
export function useHudPopups() {
  const [popups, setPopups] = useState<HudPopup[]>([]);
  const nextId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    },
    [],
  );

  // Stable identity: the race shell's event handlers list this in their
  // dependencies, and an unstable callback there would re-create the engine.
  const spawnPopup = useCallback((text: string, tone: PopupTone) => {
    const id = nextId.current++;
    // Cap the stack so a long drift chain cannot fill the screen with callouts.
    setPopups((current) => [...current.slice(-3), { id, text, tone }]);
    timers.current.push(
      setTimeout(() => {
        setPopups((current) => current.filter((popup) => popup.id !== id));
      }, POPUP_MS),
    );
  }, []);

  return { popups, spawnPopup };
}

const TONE_CLASS: Record<PopupTone, string> = {
  xp: "text-lime",
  drift: "text-amber",
  penalty: "text-ember",
};

export interface LightweightHudProps {
  telemetry: Telemetry | null;
  popups: HudPopup[];
  /** Rollup status line. Hidden entirely for practice and base-layer runs. */
  sessionLabel: string | null;
  sessionTone: "live" | "warn" | "error" | "idle";
}

const SESSION_TONE: Record<LightweightHudProps["sessionTone"], string> = {
  live: "text-lime",
  warn: "text-amber",
  error: "text-ember",
  idle: "text-fog",
};

export function LightweightHud({
  telemetry,
  popups,
  sessionLabel,
  sessionTone,
}: LightweightHudProps) {
  if (!telemetry) return null;

  const speed = Math.max(0, Math.round(telemetry.speedKph));
  // The tacho is the one thing that has to feel immediate, so it is a width
  // transition on a fixed track rather than a re-laid-out element.
  const rpm = Math.min(100, Math.max(0, telemetry.rpm * 100));

  return (
    <div className="pointer-events-none absolute inset-0 z-10 select-none font-mono">
      {/* Lap, position, timers */}
      <div className="safe-t absolute left-4 top-4 flex flex-col gap-2">
        <Readout label="Lap">
          {telemetry.lap}
          <span className="text-fog">/{telemetry.totalLaps}</span>
        </Readout>
        <Readout label="Pos">
          {telemetry.position}
          <span className="text-fog">/{telemetry.totalRacers}</span>
        </Readout>
      </div>

      <div className="safe-t absolute left-1/2 top-4 -translate-x-1/2 text-center">
        <p className="label text-fog">Time</p>
        <p className="text-xl font-bold tabular-nums text-chalk">
          {formatLapTime(telemetry.currentLapMs)}
        </p>
        {telemetry.bestLapMs > 0 ? (
          <p className="mt-0.5 text-[10px] tabular-nums text-fog">
            Best {formatLapTime(telemetry.bestLapMs)}
            {telemetry.deltaMs !== 0 ? (
              <span className={telemetry.deltaMs < 0 ? "text-lime" : "text-ember"}>
                {"  "}
                {telemetry.deltaMs < 0 ? "−" : "+"}
                {formatLapTime(Math.abs(telemetry.deltaMs))}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* Drift chain and XP */}
      <div className="safe-t absolute right-4 top-4 flex flex-col items-end gap-2">
        {sessionLabel ? (
          <p className={`text-[10px] font-bold tracking-wider ${SESSION_TONE[sessionTone]}`}>
            {sessionLabel}
          </p>
        ) : null}
        <Readout label="XP" align="right">
          {formatNumber(telemetry.projectedXp)}
        </Readout>
        {telemetry.drifting ? (
          <div className="text-right">
            <p className="label text-amber">Drift</p>
            <p className="text-lg font-bold tabular-nums text-amber">
              {formatNumber(telemetry.driftChain)}
              <span className="ml-1 text-xs">×{telemetry.driftMultiplier.toFixed(1)}</span>
            </p>
          </div>
        ) : null}
      </div>

      {/* Callouts */}
      <div className="absolute left-1/2 top-1/3 flex -translate-x-1/2 flex-col items-center gap-1">
        {popups.map((popup) => (
          <p
            key={popup.id}
            className={`animate-rise text-sm font-bold tracking-wide ${TONE_CLASS[popup.tone]}`}
          >
            {popup.text}
          </p>
        ))}
      </div>

      {/* Speed, gear, tacho */}
      <div className="safe-b absolute bottom-4 right-4 text-right">
        <div className="h-1 w-40 overflow-hidden bg-steel/60">
          <div
            className="h-full bg-apex transition-[width] duration-100 ease-linear"
            style={{ width: `${rpm}%` }}
          />
        </div>
        <p className="mt-1 text-4xl font-bold leading-none tabular-nums text-chalk">
          {speed}
          <span className="ml-1 text-xs font-normal text-fog">km/h</span>
        </p>
        <p className="text-[11px] text-fog">
          Gear <span className="text-chalk">{telemetry.gear}</span>
        </p>
      </div>

      {telemetry.offTrack ? (
        <p className="safe-b absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] font-bold text-ember">
          OFF TRACK
        </p>
      ) : null}
    </div>
  );
}

function Readout({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : undefined}>
      <p className="label text-fog">{label}</p>
      <p className="text-lg font-bold leading-none tabular-nums text-chalk">{children}</p>
    </div>
  );
}
