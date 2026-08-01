"use client";

/**
 * Settings.
 *
 * Only things that change how the game plays: input, sound, camera. Every row here
 * writes to a value the engine actually reads at runtime — `RaceShell` passes
 * `controls`, `sfxEnabled`, `masterVolume` and `reducedMotion` into `RaceConfig`,
 * and volume is pushed into the live engine as it moves.
 *
 * What is deliberately absent:
 *
 * - Graphics. The tier is detected and then owned by the runtime governor, which
 *   may only ever demote (see `stores/settings`). There was never a control here,
 *   only a readout of what had been detected — diagnostics wearing a setting's
 *   clothes.
 * - Cluster, RPC endpoints, program id. Build-time constants a player cannot act
 *   on. `ChainStatus` already says whether the chain is live.
 * - The device probe. GPU string, core count, pixel ratio, WebGL support. Useful
 *   in a bug report, not on a settings screen.
 * - Telemetry overlay. `showTelemetry` is read by nothing: the HUD has no frame
 *   counter to reveal. The store field stays — dropping it needs a version bump
 *   and a migration — but a switch that does nothing does not belong on screen.
 */

import type { ControlScheme } from "@/game/types";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/cn";

const CONTROL_OPTIONS: { value: ControlScheme; label: string; hint: string }[] = [
  { value: "keyboard", label: "Keyboard", hint: "WASD or arrows · Space handbrake" },
  { value: "gamepad", label: "Gamepad", hint: "Analog stick and triggers" },
];

/**
 * Shared shape for every control in the card.
 *
 * Same notch and the same gold-on-navy selected state as a nav tab, so a chosen
 * option reads as the same kind of "this is the live one" it does in the header.
 * `h-11` throughout: these are touch targets.
 */
const CHIP =
  "clip-notch inline-flex h-11 items-center justify-center font-ui text-[11px] " +
  "font-semibold uppercase tracking-[0.14em] transition-colors duration-150 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const CHIP_ON = "bg-gold text-navy";
const CHIP_OFF = "bg-cream/10 text-cream/55 hover:bg-cream/20 hover:text-cream";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-b grid-rule last:border-b-0">
      <h2 className="grid-face px-5 py-3 font-mono text-[10px] uppercase leading-none tracking-[0.18em] text-cream/50 sm:px-8">
        {label}
      </h2>
      <div className="divide-y divide-cream/10">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-10 sm:px-8">
      <div className="min-w-0">
        <p className="font-display text-sm font-semibold leading-none text-cream">{label}</p>
        {hint ? (
          <p className="mt-2 max-w-prose font-mono text-[11px] leading-relaxed text-cream/50">
            {hint}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={cn(CHIP, "w-20", on ? CHIP_ON : CHIP_OFF)}
    >
      {on ? "On" : "Off"}
    </button>
  );
}

function Choice({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cn(CHIP, "px-5", active ? CHIP_ON : CHIP_OFF)}
    >
      {children}
    </button>
  );
}

export function SettingsScreen() {
  const settings = useSettings();
  const volume = Math.round(settings.masterVolume * 100);

  return (
    <div className="w-full px-4 py-10 sm:px-8">
      <header>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream/45">
          Settings
        </span>
        <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-cream">
          Tuning
        </h1>
        <p className="mt-2 max-w-xl font-mono text-[11px] leading-relaxed text-cream/50">
          Input, sound and camera. Graphics are detected from your device and tuned
          while you drive, so there is nothing to set here.
        </p>
      </header>

      {/* One container, cut from the same die as the nav tabs and the connect
          button, at the larger scale a full-width surface can carry. */}
      <div className="clip-notch-lg grid-band card-glow mt-8">
        <Section label="Controls">
          <Row
            label="Input scheme"
            hint="Keyboard by default. A connected gamepad takes over automatically on Auto."
          >
            <Choice active={settings.controls === null} onClick={() => settings.setControls(null)}>
              Auto
            </Choice>
            {CONTROL_OPTIONS.map((option) => (
              <Choice
                key={option.value}
                active={settings.controls === option.value}
                onClick={() => settings.setControls(option.value)}
                title={option.hint}
              >
                {option.label}
              </Choice>
            ))}
          </Row>
        </Section>

        <Section label="Audio">
          <Row
            label="Sound effects"
            hint="Engine, tyres and impacts are synthesised in the browser — no audio files are downloaded."
          >
            <Toggle
              on={settings.sfxEnabled}
              onChange={settings.toggleSfx}
              label="Sound effects"
            />
          </Row>
          <Row label="Master volume" hint="Applies to the running race immediately.">
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(event) => settings.setMasterVolume(Number(event.target.value) / 100)}
              aria-label="Master volume"
              className="h-11 w-44 accent-gold"
            />
            <span className="w-11 text-right font-mono text-xs tabular-nums text-cream">
              {volume}%
            </span>
          </Row>
        </Section>

        <Section label="Camera">
          <Row
            label="Reduced motion"
            hint="Holds the chase camera steady. It still follows the car, it just stops reacting to impacts and kerbs."
          >
            <Toggle
              on={settings.reducedMotion}
              onChange={() => settings.setReducedMotion(!settings.reducedMotion)}
              label="Reduced motion"
            />
          </Row>
        </Section>
      </div>
    </div>
  );
}
