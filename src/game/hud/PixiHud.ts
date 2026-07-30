/**
 * PixiJS HUD.
 *
 * Gauges, drift meter and XP popups animate every frame. In the DOM that is
 * layout and paint work sixty times a second; on a canvas it is a handful of
 * batched draws. So the HUD is a second, transparent canvas composited over the
 * WebGL one.
 *
 * The cost is a second GL context, which a desktop GPU can afford.
 *
 * Static gauge geometry is drawn once and never touched again. Only the needle,
 * bars and popups are redrawn per frame.
 */

import {
  Application,
  Container,
  Graphics,
  Text,
  type ColorSource,
} from "pixi.js";
import type { HudLayer, Telemetry } from "../types";
import { formatLapTime } from "@/lib/format";
import { clamp, lerp, TAU } from "@/lib/math";

/**
 * Daylight palette.
 *
 * The scene is a bright circuit under a midday sky, so the HUD is dark type on
 * light plates. Light-on-dark type without a backing plate is unreadable against
 * pale asphalt and sky, which is what the previous neon palette produced.
 */
const COLORS = {
  accent: 0x087ea4,
  ink: 0x0d1a24,
  slate: 0x53656f,
  plate: 0xf4f8fa,
  ember: 0xb3261e,
  amber: 0x9a5b00,
  lime: 0x11703a,
  violet: 0x6b3fa0,
} as const;

/** Opacity of the HUD's backing plates. */
const PLATE_ALPHA = 0.76;

const MONO = "JetBrains Mono, ui-monospace, monospace";

/** Gauge sweep: start and end angles, radians. */
const GAUGE_START = Math.PI * 0.75;
const GAUGE_SWEEP = Math.PI * 1.5;

interface XpPopup {
  container: Container;
  life: number;
  ttl: number;
}

export interface PixiHudOptions {
  canvas: HTMLCanvasElement;
  /** Level accent, used for the gauge sweep and XP figures. */
  accent?: number;
  /** Clamp on resolution; the HUD does not need 3x. */
  maxResolution?: number;
  /** Hide the rollup indicator in practice mode. */
  showSessionPanel: boolean;
}

export class PixiHud implements HudLayer {
  private app: Application | null = null;
  private ready = false;
  private destroyed = false;

  private readonly accent: number;
  private readonly showSessionPanel: boolean;

  private width = 1;
  private height = 1;
  private compact = false;

  // Layers
  private root = new Container();
  private plates = new Graphics();
  private gaugeStatic = new Graphics();
  private gaugeDynamic = new Graphics();
  private driftGraphics = new Graphics();
  private popupLayer = new Container();

  // Text
  private speedText: Text | null = null;
  private speedUnit: Text | null = null;
  private gearText: Text | null = null;
  private lapText: Text | null = null;
  private lapLabel: Text | null = null;
  private timeText: Text | null = null;
  private deltaText: Text | null = null;
  private positionText: Text | null = null;
  private positionLabel: Text | null = null;
  private driftText: Text | null = null;
  private xpText: Text | null = null;
  private sessionText: Text | null = null;

  private popups: XpPopup[] = [];

  /** Rollup state, pushed in by the race shell. */
  private sessionLabel = "";
  private sessionColor: number = COLORS.fog;

  private smoothedSpeed = 0;
  private smoothedRpm = 0;

  constructor(private readonly options: PixiHudOptions) {
    this.accent = options.accent ?? COLORS.accent;
    this.showSessionPanel = options.showSessionPanel;
  }

  async init(width: number, height: number): Promise<void> {
    if (this.destroyed) return;
    this.width = width;
    this.height = height;

    const app = new Application();
    await app.init({
      canvas: this.options.canvas,
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      // The HUD is flat vector art; 2x is already more than enough.
      resolution: Math.min(
        typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
        this.options.maxResolution ?? 2,
      ),
      autoDensity: true,
      // Driven from the engine's render step, not its own rAF.
      autoStart: false,
      // The HUD is drawn over an opaque 3D scene; no need to clear before.
      clearBeforeRender: true,
      preference: "webgl",
    });

    if (this.destroyed) {
      app.destroy(true);
      return;
    }

    this.app = app;
    app.stage.addChild(this.root);
    this.root.addChild(
      this.plates,
      this.gaugeStatic,
      this.gaugeDynamic,
      this.driftGraphics,
      this.popupLayer,
    );

    this.buildText();
    this.layout(width, height);
    this.ready = true;
  }

  // -------------------------------------------------------------------- build

  private label(text: string, size: number, color: ColorSource, alpha = 1): Text {
    const item = new Text({
      text,
      style: {
        fontFamily: MONO,
        fontSize: size,
        fontWeight: "500",
        fill: color,
        letterSpacing: 1.2,
      },
    });
    item.alpha = alpha;
    return item;
  }

  private buildText(): void {
    this.speedText = this.label("0", 46, COLORS.ink);
    this.speedUnit = this.label("KM/H", 10, COLORS.slate);
    this.gearText = this.label("1", 20, this.accent);
    this.lapText = this.label("1/3", 20, COLORS.ink);
    this.lapLabel = this.label("LAP", 9, COLORS.slate);
    this.timeText = this.label("0:00.000", 20, COLORS.ink);
    this.deltaText = this.label("", 13, COLORS.slate);
    this.positionText = this.label("1", 30, COLORS.ink);
    this.positionLabel = this.label("POS", 9, COLORS.slate);
    this.driftText = this.label("", 16, COLORS.amber);
    this.xpText = this.label("0 XP", 13, this.accent);
    this.sessionText = this.label("", 9, COLORS.slate);

    this.root.addChild(
      this.speedText,
      this.speedUnit,
      this.gearText,
      this.lapText,
      this.lapLabel,
      this.timeText,
      this.deltaText,
      this.positionText,
      this.positionLabel,
      this.driftText,
      this.xpText,
      this.sessionText,
    );
  }

  // ------------------------------------------------------------------- layout

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (!this.app) return;
    this.app.renderer.resize(width, height);
    this.layout(width, height);
  }

  /**
   * Position everything for the current viewport.
   *
   * Below 760px wide the HUD switches to a compact arrangement — a smaller
   * gauge and stacked timers — because a phone in landscape has plenty of width
   * but very little height, and the road must stay visible.
   */
  private layout(width: number, height: number): void {
    this.compact = width < 760 || height < 420;

    const pad = this.compact ? 14 : 28;
    const gaugeRadius = this.compact ? 52 : 78;
    const gaugeCx = width - pad - gaugeRadius;
    const gaugeCy = height - pad - gaugeRadius;

    this.drawPlates(width, height, pad);
    this.drawGaugeBezel(gaugeCx, gaugeCy, gaugeRadius);

    if (this.speedText && this.speedUnit && this.gearText) {
      this.speedText.style.fontSize = this.compact ? 30 : 46;
      this.speedText.anchor.set(0.5, 0.5);
      this.speedText.position.set(gaugeCx, gaugeCy - (this.compact ? 4 : 8));

      this.speedUnit.anchor.set(0.5, 0);
      this.speedUnit.position.set(gaugeCx, gaugeCy + (this.compact ? 12 : 22));

      this.gearText.style.fontSize = this.compact ? 15 : 20;
      this.gearText.anchor.set(0.5, 0.5);
      this.gearText.position.set(gaugeCx, gaugeCy + gaugeRadius * 0.62);
    }

    // Lap and time block, top left.
    if (this.lapLabel && this.lapText && this.timeText && this.deltaText) {
      this.lapLabel.position.set(pad, pad);
      this.lapText.style.fontSize = this.compact ? 16 : 20;
      this.lapText.position.set(pad, pad + 12);
      this.timeText.style.fontSize = this.compact ? 16 : 20;
      this.timeText.position.set(pad, pad + (this.compact ? 34 : 40));
      this.deltaText.position.set(pad, pad + (this.compact ? 54 : 64));
    }

    // Position, top right.
    if (this.positionLabel && this.positionText) {
      this.positionLabel.anchor.set(1, 0);
      this.positionLabel.position.set(width - pad, pad);
      this.positionText.style.fontSize = this.compact ? 22 : 30;
      this.positionText.anchor.set(1, 0);
      this.positionText.position.set(width - pad, pad + 12);
    }

    // Drift readout, centred above the gauge.
    if (this.driftText) {
      this.driftText.anchor.set(0.5, 0.5);
      this.driftText.style.fontSize = this.compact ? 13 : 16;
      this.driftText.position.set(width / 2, height * (this.compact ? 0.3 : 0.34));
    }

    // XP and rollup status share the now-unobstructed lower-left corner.
    if (this.xpText && this.sessionText) {
      this.xpText.style.fontSize = this.compact ? 11 : 13;
      this.xpText.anchor.set(0, 1);
      this.xpText.position.set(
        pad,
        height - pad - (this.showSessionPanel ? (this.compact ? 15 : 18) : 0),
      );
      this.sessionText.anchor.set(0, 1);
      this.sessionText.position.set(pad, height - pad);
      this.sessionText.visible = this.showSessionPanel;
    }
  }

  private drawGaugeBezel(cx: number, cy: number, radius: number): void {
    const g = this.gaugeStatic;
    g.clear();

    // Light backing disc so dark digits stay readable against asphalt or sky.
    g.circle(cx, cy, radius + 6).fill({ color: COLORS.plate, alpha: PLATE_ALPHA });
    g.circle(cx, cy, radius + 6).stroke({
      width: 1,
      color: COLORS.ink,
      alpha: 0.12,
    });

    // Track arc.
    g.arc(cx, cy, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP).stroke({
      width: 2,
      color: COLORS.slate,
      alpha: 0.4,
    });

    // Ticks every 10%, longer every 20%.
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const angle = GAUGE_START + GAUGE_SWEEP * t;
      const long = i % 2 === 0;
      const inner = radius - (long ? 11 : 6);
      g.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      g.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      g.stroke({
        width: long ? 2 : 1,
        color: t > 0.82 ? COLORS.ember : COLORS.slate,
        alpha: t > 0.82 ? 0.85 : 0.6,
      });
    }

    this.gaugeCx = cx;
    this.gaugeCy = cy;
    this.gaugeRadius = radius;
  }

  /** Backing plates behind the corner text clusters. */
  private drawPlates(width: number, height: number, pad: number): void {
    const g = this.plates;
    g.clear();

    const plate = (x: number, y: number, w: number, h: number) => {
      g.roundRect(x, y, w, h, 3).fill({ color: COLORS.plate, alpha: PLATE_ALPHA });
      g.roundRect(x, y, w, h, 3).stroke({ width: 1, color: COLORS.ink, alpha: 0.1 });
    };

    const inset = 8;
    // Lap, clock and delta, top left.
    plate(
      pad - inset,
      pad - inset,
      this.compact ? 118 : 140,
      this.compact ? 76 : 92,
    );
    // Position, top right.
    const positionWidth = this.compact ? 74 : 92;
    plate(width - pad - positionWidth + inset, pad - inset, positionWidth, this.compact ? 48 : 60);
    // XP and session status, bottom left.
    const statusHeight = this.showSessionPanel
      ? this.compact ? 42 : 50
      : this.compact ? 26 : 32;
    plate(pad - inset, height - pad - statusHeight + inset, this.compact ? 150 : 186, statusHeight);
  }

  private gaugeCx = 0;
  private gaugeCy = 0;
  private gaugeRadius = 60;

  // ------------------------------------------------------------------- update

  /** Pushed in by the race shell so the HUD can show the rollup state. */
  setSessionStatus(label: string, tone: "idle" | "live" | "warn" | "error"): void {
    this.sessionLabel = label;
    this.sessionColor =
      tone === "live"
        ? COLORS.lime
        : tone === "warn"
          ? COLORS.amber
          : tone === "error"
            ? COLORS.ember
            : COLORS.fog;
  }

  /** Floating "+1,240 XP" style popup. */
  spawnPopup(text: string, tone: "xp" | "drift" | "penalty" = "xp"): void {
    if (!this.ready || this.destroyed) return;
    // Cap concurrent popups: a long drift chain can generate a lot of these.
    if (this.popups.length > 6) {
      const oldest = this.popups.shift();
      oldest?.container.destroy({ children: true });
    }

    const color =
      tone === "penalty" ? COLORS.ember : tone === "drift" ? COLORS.amber : this.accent;
    const item = this.label(text, this.compact ? 14 : 18, color);
    item.anchor.set(0.5, 0.5);

    const container = new Container();
    container.addChild(item);
    container.position.set(this.width / 2, this.height * 0.42);
    this.popupLayer.addChild(container);

    this.popups.push({ container, life: 0, ttl: 1.15 });
  }

  update(telemetry: Readonly<Telemetry>, dt: number): void {
    if (!this.ready || !this.app || this.destroyed) return;

    // Smooth the needle and digits so they do not flicker between frames.
    this.smoothedSpeed = lerp(this.smoothedSpeed, telemetry.speedKph, 0.25);
    this.smoothedRpm = lerp(this.smoothedRpm, telemetry.rpm, 0.3);

    this.drawGaugeNeedle(telemetry);
    this.drawDriftMeter(telemetry);
    this.updateTexts(telemetry);
    this.updatePopups(dt);

    this.app.render();
  }

  private drawGaugeNeedle(telemetry: Readonly<Telemetry>): void {
    const g = this.gaugeDynamic;
    const cx = this.gaugeCx;
    const cy = this.gaugeCy;
    const radius = this.gaugeRadius;
    g.clear();

    // Tacho sweep.
    const rpm = clamp(this.smoothedRpm, 0, 1);
    if (rpm > 0.01) {
      g.arc(cx, cy, radius - 3, GAUGE_START, GAUGE_START + GAUGE_SWEEP * rpm).stroke({
        width: 5,
        color: rpm > 0.88 ? COLORS.ember : this.accent,
        alpha: 0.9,
        cap: "round",
      });
    }

    // Needle driven by speed rather than rpm, since that is the number shown.
    const speedRatio = clamp(this.smoothedSpeed / 340, 0, 1);
    const angle = GAUGE_START + GAUGE_SWEEP * speedRatio;
    const inner = radius * 0.24;
    const outer = radius - 14;
    g.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    g.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    g.stroke({ width: 2.5, color: COLORS.ink, alpha: 0.95, cap: "round" });

    // Handbrake and off-track tells, drawn on the bezel so they are unmissable.
    if (telemetry.handbrake) {
      g.circle(cx, cy, radius + 10).stroke({
        width: 2,
        color: COLORS.amber,
        alpha: 0.8,
      });
    }
    if (telemetry.offTrack) {
      g.circle(cx, cy, radius + 14).stroke({
        width: 2,
        color: COLORS.ember,
        alpha: 0.7,
      });
    }
  }

  private drawDriftMeter(telemetry: Readonly<Telemetry>): void {
    const g = this.driftGraphics;
    g.clear();
    if (!telemetry.drifting && telemetry.driftChain <= 0) return;

    const width = this.compact ? 140 : 200;
    const height = 5;
    const x = this.width / 2 - width / 2;
    const y = this.height * (this.compact ? 0.34 : 0.38);

    g.roundRect(x - 1, y - 1, width + 2, height + 2, 2).fill({
      color: COLORS.plate,
      alpha: PLATE_ALPHA,
    });

    const fill = clamp(telemetry.driftMultiplier / 5, 0, 1);
    g.roundRect(x, y, width * fill, height, 2).fill({
      color: telemetry.driftMultiplier >= 4 ? COLORS.violet : COLORS.amber,
      alpha: 0.95,
    });

    // Multiplier step markers.
    for (let i = 1; i < 5; i += 1) {
      const mx = x + (width * i) / 5;
      g.moveTo(mx, y - 1);
      g.lineTo(mx, y + height + 1);
      g.stroke({ width: 1, color: COLORS.ink, alpha: 0.35 });
    }
  }

  private updateTexts(telemetry: Readonly<Telemetry>): void {
    if (this.speedText) this.speedText.text = String(Math.round(this.smoothedSpeed));
    if (this.gearText) this.gearText.text = `G${telemetry.gear}`;
    if (this.lapText) {
      this.lapText.text = `${telemetry.lap}/${telemetry.totalLaps}`;
    }
    if (this.timeText) this.timeText.text = formatLapTime(telemetry.raceTimeMs);

    if (this.deltaText) {
      if (telemetry.bestLapMs > 0 && telemetry.currentLapMs > 0) {
        const delta = telemetry.deltaMs;
        const sign = delta < 0 ? "-" : "+";
        this.deltaText.text = `${sign}${(Math.abs(delta) / 1000).toFixed(2)}`;
        this.deltaText.style.fill = delta < 0 ? COLORS.lime : COLORS.ember;
      } else {
        this.deltaText.text = formatLapTime(telemetry.currentLapMs);
        this.deltaText.style.fill = COLORS.slate;
      }
    }

    if (this.positionText) {
      this.positionText.text = `${telemetry.position}/${telemetry.totalRacers}`;
    }

    if (this.driftText) {
      if (telemetry.drifting || telemetry.driftChain > 0) {
        this.driftText.text = `${Math.floor(telemetry.driftChain)}  x${telemetry.driftMultiplier}`;
        this.driftText.visible = true;
      } else {
        this.driftText.visible = false;
      }
    }

    if (this.xpText) {
      this.xpText.text = `${telemetry.projectedXp.toLocaleString("en-US")} XP`;
    }

    if (this.sessionText) {
      this.sessionText.text = this.sessionLabel;
      this.sessionText.style.fill = this.sessionColor;
    }
  }

  private updatePopups(dt: number): void {
    for (let i = this.popups.length - 1; i >= 0; i -= 1) {
      const popup = this.popups[i]!;
      popup.life += dt;
      const t = popup.life / popup.ttl;
      if (t >= 1) {
        popup.container.destroy({ children: true });
        this.popups.splice(i, 1);
        continue;
      }
      // Rise and fade.
      popup.container.y -= dt * 46;
      popup.container.alpha = 1 - t * t;
      const scale = 1 + Math.sin(Math.min(t * 4, TAU)) * 0.04;
      popup.container.scale.set(scale);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    for (const popup of this.popups) popup.container.destroy({ children: true });
    this.popups = [];
    this.app?.destroy(true, { children: true, texture: true });
    this.app = null;
  }
}
