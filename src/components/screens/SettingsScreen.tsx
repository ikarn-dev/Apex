"use client";

import { Panel, PanelHeader, Badge } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { QUALITY_PRESETS } from "@/game/config/quality";
import type { ControlScheme } from "@/game/types";
import { detectQualityTier } from "@/lib/device";
import { useDeviceProfile } from "@/hooks/useDeviceProfile";
import { useSettings } from "@/stores/settings";
// String constants only — importing the parsed PublicKey here would pull
// @solana/web3.js into a screen that never sends a transaction.
import {
  APEX_PROGRAM_ID_BASE58,
  BASE_RPC,
  CHAIN_ENABLED,
  CLUSTER,
  ER_RPC,
} from "@/chain/config";
import { cn } from "@/lib/cn";

const CONTROL_OPTIONS: { value: ControlScheme; label: string; hint: string }[] = [
  { value: "keyboard", label: "Keyboard", hint: "WASD or arrows · Space handbrake" },
  { value: "gamepad", label: "Gamepad", hint: "Analog stick and triggers" },
];

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
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-mono text-xs text-chalk">{label}</p>
        {hint ? <p className="mt-1 text-[10px] leading-relaxed text-fog">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{children}</div>
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
      className={cn(
        "relative h-11 w-20 border font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
        on ? "border-apex/60 bg-apex/15 text-apex" : "border-steel text-fog",
      )}
    >
      {on ? "On" : "Off"}
    </button>
  );
}

export function SettingsScreen() {
  const settings = useSettings();
  // Device probing touches browser globals, so it yields null on the server.
  const device = useDeviceProfile();
  const detected = device ? detectQualityTier(device) : null;
  const preset = detected ? QUALITY_PRESETS[detected] : null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header>
        <span className="label">Settings</span>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
          Tuning
        </h1>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-fog">
          Graphics are not a setting. The tier is detected from your device and
          then lowered automatically if frames start dropping — the governor never
          raises it again, because a device that just recovered would fall over
          immediately and the player would watch the resolution pump.
        </p>
      </header>

      <Panel className="mt-8 p-0">
        <PanelHeader
          label="Graphics"
          action={detected ? <Badge tone="fog">Automatic · {detected}</Badge> : null}
        />
        <div className="divide-y divide-steel">
          <Row
            label="Detected profile"
            hint={
              preset
                ? `DPR cap ${preset.maxPixelRatio}× · shadows ${
                    preset.shadowMapSize || "off"
                  } · ${preset.drawDistance}m draw · ${preset.maxRivals} rivals`
                : "Probing your device…"
            }
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog">
              {detected ?? "—"}
            </span>
          </Row>

          <Row
            label="Reduced motion"
            hint="Disables camera shake and screen effects. Follows your OS setting by default."
          >
            <Toggle
              on={settings.reducedMotion}
              onChange={() => settings.setReducedMotion(!settings.reducedMotion)}
              label="Reduced motion"
            />
          </Row>

          <Row label="Telemetry overlay" hint="Frame rate, draw calls and rollup tick counters.">
            <Toggle
              on={settings.showTelemetry}
              onChange={settings.toggleTelemetry}
              label="Telemetry overlay"
            />
          </Row>
        </div>
      </Panel>

      <Panel className="mt-6 p-0">
        <PanelHeader label="Controls" />
        <div className="divide-y divide-steel">
          <Row
            label="Scheme"
            hint="Keyboard by default; a connected gamepad takes over automatically."
          >
            <Button
              variant={settings.controls === null ? "primary" : "secondary"}
              size="sm"
              onClick={() => settings.setControls(null)}
            >
              Auto
            </Button>
            {CONTROL_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={settings.controls === option.value ? "primary" : "secondary"}
                size="sm"
                onClick={() => settings.setControls(option.value)}
                title={option.hint}
              >
                {option.label}
              </Button>
            ))}
          </Row>
        </div>
      </Panel>

      <Panel className="mt-6 p-0">
        <PanelHeader label="Audio" />
        <div className="divide-y divide-steel">
          <Row
            label="Sound effects"
            hint="Engine, tyres and impacts are synthesised in the browser — no audio files are downloaded."
          >
            <Toggle on={settings.sfxEnabled} onChange={settings.toggleSfx} label="Sound effects" />
          </Row>
          <Row label="Master volume">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(settings.masterVolume * 100)}
              onChange={(event) =>
                settings.setMasterVolume(Number(event.target.value) / 100)
              }
              aria-label="Master volume"
              className="h-11 w-40 accent-apex"
            />
          </Row>
        </div>
      </Panel>

      <Panel className="mt-6 p-0">
        <PanelHeader
          label="Chain"
          action={
            <Badge tone={CHAIN_ENABLED ? "lime" : "amber"}>
              {CHAIN_ENABLED ? "Live" : "Simulation"}
            </Badge>
          }
        />
        <dl className="divide-y divide-steel">
          <Row label="Cluster">
            <code className="font-mono text-[11px] text-chalk">{CLUSTER}</code>
          </Row>
          <Row label="Base layer RPC">
            <code className="max-w-[220px] truncate font-mono text-[11px] text-chalk">
              {BASE_RPC}
            </code>
          </Row>
          <Row label="Ephemeral Rollup">
            <code className="max-w-[220px] truncate font-mono text-[11px] text-chalk">
              {ER_RPC}
            </code>
          </Row>
          <Row
            label="apex_racing program"
            hint={
              CHAIN_ENABLED
                ? undefined
                : "Unset. The game runs in Simulation mode: identical gameplay, XP kept locally."
            }
          >
            <code className="max-w-[220px] truncate font-mono text-[11px] text-chalk">
              {CHAIN_ENABLED ? APEX_PROGRAM_ID_BASE58 : "not deployed"}
            </code>
          </Row>
        </dl>
      </Panel>

      {device ? (
        <Panel className="mt-6 p-0">
          <PanelHeader label="Detected device" />
          <dl className="divide-y divide-steel">
            <Row label="GPU">
              <code className="max-w-[240px] truncate font-mono text-[11px] text-chalk">
                {device.gpu ?? "masked"}
              </code>
            </Row>
            <Row label="Cores / memory">
              <code className="font-mono text-[11px] text-chalk">
                {device.cores} / {device.memoryGb ? `${device.memoryGb} GB` : "unreported"}
              </code>
            </Row>
            <Row label="Pixel ratio">
              <code className="font-mono text-[11px] text-chalk">
                {device.pixelRatio}×
                {preset ? ` (capped at ${preset.maxPixelRatio}×)` : null}
              </code>
            </Row>
            <Row label="WebGL 2">
              <code className="font-mono text-[11px] text-chalk">
                {device.hasWebGL2 ? "yes" : "no"}
              </code>
            </Row>
          </dl>
        </Panel>
      ) : null}
    </div>
  );
}
