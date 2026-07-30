"use client";

/**
 * The race view.
 *
 * This is the only place the three halves of the game meet: the engine (a plain
 * class that owns its own render loop), the rollup session (fire-and-forget chain
 * I/O), and React (menus, overlays, touch controls).
 *
 * The rules it exists to enforce:
 *
 * - React never renders at frame rate. The engine writes per-frame values into a
 *   mutable `Telemetry` object that the Pixi HUD reads directly; only discrete
 *   events (lap, checkpoint, position, finish) cross into React state.
 * - The chain never stalls a frame. `onTick` hands a payload to a queue and
 *   returns. A failed write costs scoring precision, never gameplay.
 * - The engine is created once and torn down once. It is held in a ref, not
 *   state, because re-creating a WebGL context on re-render would be a disaster.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Panel";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { ResultsOverlay, type SettleState } from "./ResultsOverlay";
import { SessionPanel } from "./SessionPanel";
import { StoryStrip } from "./StoryStrip";
import { Engine } from "@/game/engine/Engine";
import { PixiHud } from "@/game/hud/PixiHud";
import { CARS, CAR_INDEX } from "@/game/config/cars";
import { LEVEL_INDEX, type LevelDefinition } from "@/game/config/levels";
import { QUALITY_PRESETS } from "@/game/config/quality";
import { CHECKPOINTS_PER_LAP } from "@/game/track/Track";
import type { ControlScheme, GameBridge, GameEvent } from "@/game/types";
import { detectQualityTier, getDeviceProfile } from "@/lib/device";
import { generateSeed } from "@/lib/rng";
import { formatNumber } from "@/lib/format";
import { CHAIN_ENABLED } from "@/chain/config";
import { ErSession } from "@/chain/er/session";
import { useWalletBridge } from "@/chain/hooks/useWalletBridge";
import { useDriverProfile } from "@/chain/hooks/useDriverProfile";
import { useProfile } from "@/stores/profile";
import { useRace } from "@/stores/race";
import { useSession } from "@/stores/session";
import { useSettings } from "@/stores/settings";

type Stage = "briefing" | "opening" | "running";

export function RaceShell({ level }: { level: LevelDefinition }) {
  const router = useRouter();

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);

  const engineRef = useRef<Engine | null>(null);
  const hudRef = useRef<PixiHud | null>(null);
  const sessionRef = useRef<ErSession | null>(null);
  const seedRef = useRef<bigint>(generateSeed());

  const wallet = useWalletBridge();
  const { refresh: refreshProfile } = useDriverProfile();

  const selectedCar = useRace((s) => s.selectedCar);
  const practice = useRace((s) => s.practice);
  const phase = useRace((s) => s.phase);
  const countdown = useRace((s) => s.countdown);
  const result = useRace((s) => s.result);
  const failure = useRace((s) => s.failure);
  const bankAvailable = useRace((s) => s.bankAvailable);
  const raceStore = useRace;

  const settings = useSettings();
  const creditLocalXp = useProfile((s) => s.creditLocalXp);
  const queuePendingRun = useProfile((s) => s.queuePendingRun);
  const resolvePendingRun = useProfile((s) => s.resolvePendingRun);
  const failPendingRun = useProfile((s) => s.failPendingRun);
  const sessionStore = useSession;

  const [stage, setStage] = useState<Stage>("briefing");
  const [paused, setPaused] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [settleState, setSettleState] = useState<SettleState>("idle");
  const [settleError, setSettleError] = useState<string | null>(null);
  const [baseSignature, setBaseSignature] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  const device = typeof window === "undefined" ? null : getDeviceProfile();
  const tier = settings.qualityOverride ?? (device ? detectQualityTier(device) : "medium");
  const preset = QUALITY_PRESETS[tier];

  const controls: ControlScheme = settings.controls ?? "keyboard";

  // A chain run needs a wallet, a deployed program, and a level that uses the
  // rollup at all — Act I is deliberately base-layer only.
  const chainRun = !practice && CHAIN_ENABLED && wallet !== null && level.erEnabled;

  // ---------------------------------------------------------------- lifecycle

  /** Events the engine pushes at us. Discrete only, never per-frame. */
  const handleEvent = useCallback(
    (event: GameEvent) => {
      const race = raceStore.getState();
      const session = sessionStore.getState();

      switch (event.type) {
        case "phase":
          race.setPhase(event.phase);
          break;

        case "countdown":
          race.setCountdown(event.value);
          break;

        case "lap":
          race.setLap(event.lap + 1, level.laps);
          race.setLapTimes(event.lapMs, engineRef.current?.telemetry.bestLapMs ?? 0);
          // Act IV: banking is offered at each lap line.
          if (level.bankingEnabled && chainRun) race.setBankAvailable(true);
          hudRef.current?.spawnPopup(
            event.best ? "BEST LAP" : `LAP ${event.lap}`,
            event.best ? "xp" : "drift",
          );
          break;

        case "position":
          race.setPosition(event.position, engineRef.current?.telemetry.totalRacers ?? 1);
          if (event.position < event.previous) {
            hudRef.current?.spawnPopup("OVERTAKE +25", "xp");
          }
          break;

        case "drift-end":
          if (event.score > 40) {
            hudRef.current?.spawnPopup(
              `+${formatNumber(event.score)}  x${event.multiplier}`,
              "drift",
            );
          }
          break;

        case "collision":
          engineRef.current?.registerImpact(event.severity);
          hudRef.current?.spawnPopup("CONTACT", "penalty");
          break;

        case "story":
          race.setStory(event.speaker, event.line);
          break;

        case "loaded":
          setModelsLoaded(true);
          break;

        case "quality":
          // Only surface automatic demotions; a user change is not news.
          if (event.reason !== "user") {
            race.setStory("SYSTEM", `Quality reduced to ${event.tier} — ${event.reason}.`);
          }
          break;

        case "failed":
          race.fail(event.reason);
          break;

        case "finish": {
          race.finish(event.result);
          const engineSession = sessionRef.current;

          if (!chainRun) {
            // Practice or Simulation: credit locally and label it as such.
            creditLocalXp(event.result);
            setSettleState("unavailable");
            return;
          }

          // Close the run inside the rollup straight away — the XP number the
          // player is reading comes from the program, so it has to be computed
          // before they act on it.
          session.setPhase("committing");
          void engineSession
            ?.finish({
              totalMs: event.result.totalMs,
              bestLapMs: event.result.bestLapMs,
              position: event.result.position,
              overtakes: event.result.overtakes,
              bankDeferredLaps: event.result.bankDeferredLaps,
              checkpointsPerLap: CHECKPOINTS_PER_LAP,
              replayHash: engineRef.current!.race.replayDigest(),
            })
            .then((signature) => {
              sessionStore.getState().addSignature({
                label: "finish_race",
                signature,
                layer: "er",
                at: Date.now(),
              });
              sessionStore.getState().setXpInSession(event.result.xp.total);
              sessionStore.getState().setPhase("committed");
              const id = queuePendingRun(
                event.result,
                engineSession?.nonce.toString() ?? null,
              );
              setPendingRunId(id);
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              sessionStore.getState().fail(message);
              setSettleState("error");
              setSettleError(message);
              // Still queue it: the run happened, and the profile screen can retry.
              const id = queuePendingRun(
                event.result,
                engineSession?.nonce.toString() ?? null,
              );
              setPendingRunId(id);
            });
          break;
        }

        default:
          break;
      }
    },
    [chainRun, creditLocalXp, level.bankingEnabled, level.laps, queuePendingRun, raceStore, sessionStore],
  );

  /** Create the engine once. Renders immediately; starts on the player's cue. */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = sceneCanvasRef.current;
    if (!container || !canvas) return;

    let cancelled = false;
    let pendingHud: PixiHud | null = null;

    const bridge: GameBridge = {
      onEvent: handleEvent,
      onTick: (payload) => {
        // Must return immediately. The queue coalesces and sends off-thread of
        // the render loop.
        sessionRef.current?.tick(payload);
      },
    };

    // Deliberately not wrapped in try/catch. If the WebGL context cannot be
    // created there is no race to show, and the route's error boundary gives a
    // better result than a half-mounted shell reporting its own failure.
    const engine = new Engine({
      canvas,
      container,
      bridge,
      config: {
        levelId: level.id,
        carId: selectedCar,
        seed: seedRef.current.toString(),
        quality: tier,
        controls,
        practice: !chainRun,
        masterVolume: settings.masterVolume,
        sfxEnabled: settings.sfxEnabled,
        reducedMotion: settings.reducedMotion,
      },
    });

    engineRef.current = engine;
    document.body.dataset.race = "active";

    // Pixi HUD is async (it initialises its own GL context), so it attaches once
    // ready rather than blocking the first frame. A late resolution after
    // unmount is destroyed instead of being attached to a disposed engine.
    if (hudCanvasRef.current) {
      const hud = new PixiHud({
        canvas: hudCanvasRef.current,
        accent: level.env.accent,
        showSessionPanel: chainRun,
      });
      pendingHud = hud;
      const rect = container.getBoundingClientRect();
      void hud
        .init(rect.width, rect.height)
        .then(() => {
          if (cancelled || engineRef.current !== engine) {
            hud.destroy();
            return;
          }
          pendingHud = null;
          hudRef.current = hud;
          engine.setHud(hud);
        })
        .catch(() => {
          pendingHud = null;
          hud.destroy();
        });
    }

    return () => {
      cancelled = true;
      pendingHud?.destroy();
      pendingHud = null;
      document.body.removeAttribute("data-race");
      engine.dispose();
      engineRef.current = null;
      hudRef.current = null;
    };
    // Engine identity must not depend on changing settings; volume and quality
    // are pushed in through setters below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push live setting changes into the running engine.
  useEffect(() => {
    engineRef.current?.setVolume(settings.masterVolume);
  }, [settings.masterVolume]);

  useEffect(() => {
    engineRef.current?.setQuality(tier);
  }, [tier]);

  useEffect(() => {
    engineRef.current?.setControls(controls);
  }, [controls]);

  // Reset transient race state on mount so a previous run's results do not flash.
  useEffect(() => {
    raceStore.getState().resetRace();
    sessionStore.getState().reset();
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [raceStore, sessionStore]);

  /** Pause when the tab goes away: unseen frames are wasted battery. */
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        engineRef.current?.pause();
        setPaused(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /** Escape pauses. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Escape" || stage !== "running") return;
      if (phase === "finished" || phase === "failed") return;
      setPaused((current) => {
        if (current) engineRef.current?.resume();
        else engineRef.current?.pause();
        return !current;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, phase]);

  // ------------------------------------------------------------------ actions

  const beginRace = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (!chainRun) {
      sessionStore.getState().setPhase(practice ? "idle" : "simulated");
      setStage("running");
      engine.start();
      return;
    }

    setStage("opening");
    setOpenError(null);
    sessionStore.getState().setPhase("opening");

    try {
      const session = await ErSession.open({
        wallet: wallet!,
        levelIndex: LEVEL_INDEX[level.id],
        carIndex: CAR_INDEX[selectedCar],
        seed: seedRef.current,
        onStats: (stats) => {
          sessionStore.getState().recordTick({
            landed: stats.landed,
            inFlight: stats.inFlight,
            rttMs: stats.lastRttMs,
          });
          if (stats.dropped > 0) sessionStore.getState().dropTicks(0);
        },
        onError: () => {
          // Individual tick failures are expected under load and are already
          // counted; surfacing each one would be noise.
        },
      });

      sessionRef.current = session;
      const store = sessionStore.getState();
      store.begin({
        sessionPda: session.sessionPda.toBase58(),
        nonce: session.nonce.toString(),
        sessionSigner: session.sessionKey.publicKey.toBase58(),
        validator: null,
      });
      store.addSignature({
        label: "open + delegate",
        signature: session.openSignature,
        layer: "base",
        at: Date.now(),
      });
      store.setPhase("live");

      setStage("running");
      engine.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenError(message);
      sessionStore.getState().fail(message);
      setStage("briefing");
    }
  }, [chainRun, level.id, practice, selectedCar, sessionStore, wallet]);

  /** Act IV: bank the run mid-race without ending the session. */
  const bankRun = useCallback(async () => {
    const session = sessionRef.current;
    const engine = engineRef.current;
    if (!session || !engine) return;

    raceStore.getState().setBankAvailable(false);
    sessionStore.getState().setPhase("committing");

    try {
      const { erSignature, baseSignature: settled } = await session.bank();
      engine.markBanked();
      const store = sessionStore.getState();
      store.registerBank();
      store.addSignature({
        label: "bank_run",
        signature: erSignature,
        layer: "er",
        at: Date.now(),
      });
      if (settled) {
        store.addSignature({
          label: "commit",
          signature: settled,
          layer: "base",
          at: Date.now(),
        });
      }
      store.setPhase("live");
      hudRef.current?.spawnPopup("BANKED", "xp");
    } catch (error) {
      sessionStore
        .getState()
        .fail(error instanceof Error ? error.message : String(error));
    }
  }, [raceStore, sessionStore]);

  /** Commit and undelegate, then claim onto the profile. */
  const settleRun = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !result) return;

    setSettleState("settling");
    setSettleError(null);
    sessionStore.getState().setPhase("settling");

    try {
      const { erSignature, baseSignature: committed } = await session.settle();
      const store = sessionStore.getState();
      store.addSignature({
        label: "settle_run",
        signature: erSignature,
        layer: "er",
        at: Date.now(),
      });
      if (committed) {
        store.addSignature({
          label: "commit + undelegate",
          signature: committed,
          layer: "base",
          at: Date.now(),
        });
      }
      store.setPhase("settled");

      setSettleState("claiming");
      const claimSignature = await session.claim();
      store.addSignature({
        label: "claim_xp",
        signature: claimSignature,
        layer: "base",
        at: Date.now(),
      });
      setBaseSignature(claimSignature);

      await refreshProfile();
      if (pendingRunId) {
        resolvePendingRun(pendingRunId, useProfile.getState().xpCommitted);
      }
      setSettleState("settled");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettleError(message);
      setSettleState("error");
      sessionStore.getState().fail(message);
      if (pendingRunId) failPendingRun(pendingRunId, message);
    }
  }, [failPendingRun, pendingRunId, refreshProfile, resolvePendingRun, result, sessionStore]);

  /** FLATLINE: close the session without committing. */
  const discardRun = useCallback(async () => {
    const session = sessionRef.current;
    if (session) {
      try {
        await session.abandon();
      } catch {
        // Nothing to do — the session simply stays uncommitted, which is the
        // same outcome the player asked for.
      }
    }
    if (pendingRunId) useProfile.getState().dropPendingRun(pendingRunId);
    router.push("/campaign");
  }, [pendingRunId, router]);

  const retry = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    sessionStore.getState().reset();
    raceStore.getState().resetRace();
    setSettleState("idle");
    setSettleError(null);
    setBaseSignature(null);
    setPendingRunId(null);
    seedRef.current = generateSeed();
    setStage("briefing");
  }, [raceStore, sessionStore]);

  const resume = useCallback(() => {
    engineRef.current?.resume();
    setPaused(false);
  }, []);

  const retire = useCallback(() => {
    engineRef.current?.resume();
    setPaused(false);
    engineRef.current?.retire();
  }, []);

  // Keep the Pixi HUD's session line in step with the store.
  const sessionPhase = useSession((s) => s.phase);
  const ticksLanded = useSession((s) => s.ticksLanded);
  useEffect(() => {
    const label =
      sessionPhase === "live"
        ? `ER LIVE · ${formatNumber(ticksLanded)} ticks`
        : sessionPhase === "simulated"
          ? "SIMULATION"
          : sessionPhase === "error"
            ? "ER ERROR"
            : sessionPhase.toUpperCase();
    const tone =
      sessionPhase === "live"
        ? "live"
        : sessionPhase === "error"
          ? "error"
          : sessionPhase === "simulated"
            ? "warn"
            : "idle";
    hudRef.current?.setSessionStatus(label, tone);
  }, [sessionPhase, ticksLanded]);

  const car = CARS[selectedCar];
  const showResults = phase === "finished" || phase === "failed";

  // -------------------------------------------------------------------- render

  return (
    <div ref={containerRef} className="relative h-dvh w-full overflow-hidden bg-void">
      <canvas ref={sceneCanvasRef} className="absolute inset-0 block size-full" />
      <canvas
        ref={hudCanvasRef}
        className="pointer-events-none absolute inset-0 z-10 block size-full"
      />

      <StoryStrip />

      {chainRun && stage === "running" ? (
        <div className="safe-t pointer-events-none absolute right-4 top-4 z-20 hidden lg:block">
          <SessionPanel />
        </div>
      ) : null}

      {/* Countdown */}
      {stage === "running" && phase === "countdown" && countdown > 0 ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <span className="font-display text-[22vw] font-bold leading-none text-chalk/90 tabular-nums sm:text-[14vw]">
            {countdown}
          </span>
        </div>
      ) : null}

      {/* Act IV bank prompt */}
      {stage === "running" && bankAvailable && !showResults ? (
        <div className="safe-b absolute bottom-28 left-1/2 z-30 -translate-x-1/2 sm:bottom-8">
          <Button variant="primary" size="md" onClick={() => void bankRun()}>
            Bank run
          </Button>
        </div>
      ) : null}

      {/* Briefing */}
      {stage === "briefing" ? (
        <Overlay>
          <span className="label text-apex">{level.actLabel}</span>
          <h1 className="mt-2 font-display text-4xl font-bold leading-none text-chalk sm:text-5xl">
            {level.title}
          </h1>
          <code className="mt-3 block text-[11px] text-amber">{level.concept}</code>
          <p className="mt-3 text-xs leading-relaxed text-fog">{level.conceptDetail}</p>

          <dl className="mt-5 grid grid-cols-3 gap-4 border-y border-steel py-4 font-mono text-[10px]">
            <div>
              <dt className="text-fog">Car</dt>
              <dd className="mt-1 text-chalk">{car.name}</dd>
            </div>
            <div>
              <dt className="text-fog">Laps</dt>
              <dd className="mt-1 tabular-nums text-chalk">{level.laps}</dd>
            </div>
            <div>
              <dt className="text-fog">Rivals</dt>
              <dd className="mt-1 tabular-nums text-chalk">
                {Math.min(level.rivals, preset.maxRivals)}
              </dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge tone={chainRun ? "lime" : "amber"}>
              {chainRun
                ? "Ephemeral session"
                : practice
                  ? "Practice — XP is local"
                  : !level.erEnabled
                    ? "Base layer only"
                    : !CHAIN_ENABLED
                      ? "Simulation mode"
                      : "Wallet not connected"}
            </Badge>
            <Badge tone="fog">{tier} quality</Badge>
            <Badge tone="fog">{controls}</Badge>
            {!modelsLoaded ? <Badge tone="fog">Loading models…</Badge> : null}
          </div>

          {!chainRun && !practice && level.erEnabled && CHAIN_ENABLED && !wallet ? (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="text-[11px] text-fog">
                Connect a wallet to open a real session and settle this run.
              </p>
              <ConnectButton size="sm" />
            </div>
          ) : null}

          {openError ? (
            <p className="mt-4 border-l-2 border-ember pl-3 text-[11px] leading-relaxed text-ember">
              {openError}
            </p>
          ) : null}

          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <Button variant="primary" size="lg" onClick={() => void beginRace()}>
              {chainRun ? "Jack in" : "Start"}
            </Button>
            <ButtonLink href="/campaign" variant="ghost" size="lg">
              Back
            </ButtonLink>
          </div>

          {chainRun ? (
            <p className="mt-4 text-[10px] leading-relaxed text-fog">
              One wallet approval now — it opens the run and delegates it to the
              rollup in a single transaction. Nothing will interrupt you while
              driving.
            </p>
          ) : null}
        </Overlay>
      ) : null}

      {/* Opening the session */}
      {stage === "opening" ? (
        <Overlay>
          <span className="label text-apex">Jacking in</span>
          <h2 className="mt-2 font-display text-3xl font-bold text-chalk">
            Opening the session
          </h2>
          <p className="mt-3 text-xs leading-relaxed text-fog">
            Creating your race account on the Settlement Layer and delegating it to
            the rollup. Approve the transaction in your wallet.
          </p>
          <div className="mt-5 h-1 w-full overflow-hidden bg-steel/60">
            <div className="h-full w-1/3 animate-pulse-apex bg-apex" />
          </div>
        </Overlay>
      ) : null}

      {/* Pause */}
      {paused && !showResults ? (
        <Overlay>
          <span className="label">Paused</span>
          <h2 className="mt-2 font-display text-3xl font-bold text-chalk">
            {level.title}
          </h2>
          {chainRun ? (
            <p className="mt-3 text-[11px] leading-relaxed text-amber">
              The session is still open. Retiring now discards it — the XP goes
              with it.
            </p>
          ) : null}
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <Button variant="primary" size="md" onClick={resume}>
              Resume
            </Button>
            <Button variant="danger" size="md" onClick={retire}>
              Retire
            </Button>
          </div>
        </Overlay>
      ) : null}

      {/* Results */}
      {showResults ? (
        <ResultsOverlay
          level={level}
          result={result}
          failure={failure}
          practice={practice || !level.erEnabled}
          chainEnabled={chainRun}
          settleState={settleState}
          settleError={settleError}
          baseSignature={baseSignature}
          onSettle={() => void settleRun()}
          onRetry={retry}
          onDiscard={() => void discardRun()}
        />
      ) : null}

    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-void/80 p-4 backdrop-blur-md">
      <div className="safe-t safe-b w-full max-w-lg animate-rise">
        <Panel className="p-6 sm:p-8">{children}</Panel>
      </div>
    </div>
  );
}
