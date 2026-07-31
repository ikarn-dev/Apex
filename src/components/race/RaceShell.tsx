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
import { RaceLeaderboard } from "./RaceLeaderboard";
import { SessionPanel } from "./SessionPanel";
import { StoryStrip } from "./StoryStrip";
import { LightweightHud, useHudPopups } from "./LightweightHud";
import { Engine } from "@/game/engine/Engine";
import { CARS, CAR_INDEX } from "@/game/config/cars";
import { MAX_DRIVER_NAME_LENGTH } from "@/game/config/drivers";
import { LEVEL_INDEX, type LevelDefinition } from "@/game/config/levels";
import { QUALITY_PRESETS } from "@/game/config/quality";
import { CHECKPOINTS_PER_LAP } from "@/game/track/Track";
import { XP_PER_CONTACT } from "@/game/scoring/xp";
import type { ControlScheme, GameBridge, GameEvent, Telemetry } from "@/game/types";
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

  const engineRef = useRef<Engine | null>(null);
  const sessionRef = useRef<ErSession | null>(null);
  const seedRef = useRef<bigint>(generateSeed());

  const { popups, spawnPopup } = useHudPopups();
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

  const wallet = useWalletBridge();
  const { refresh: refreshProfile } = useDriverProfile();

  const selectedCar = useRace((s) => s.selectedCar);
  const driverName = useRace((s) => s.driverName);
  const setDriverName = useRace((s) => s.setDriverName);
  const practice = useRace((s) => s.practice);
  const phase = useRace((s) => s.phase);
  const countdown = useRace((s) => s.countdown);
  const result = useRace((s) => s.result);
  const failure = useRace((s) => s.failure);
  const bankAvailable = useRace((s) => s.bankAvailable);
  const raceStore = useRace;

  const settings = useSettings();
  const committedXp = useProfile((s) => s.xpCommitted);
  const creditLocalXp = useProfile((s) => s.creditLocalXp);
  const queuePendingRun = useProfile((s) => s.queuePendingRun);
  const resolvePendingRun = useProfile((s) => s.resolvePendingRun);
  const failPendingRun = useProfile((s) => s.failPendingRun);
  const sessionStore = useSession;

  const [stage, setStage] = useState<Stage>("briefing");
  const [paused, setPaused] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [settleState, setSettleState] = useState<SettleState>("idle");
  const [settleError, setSettleError] = useState<string | null>(null);
  const [baseSignature, setBaseSignature] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  // Detected once, and then left alone: the frame-time governor now only softens
  // resolution under a sustained 25fps and never changes the tier mid-race.
  // `high` is the pre-hydration guess as well, because that is what nearly every
  // desktop can hold and the alternative was every browser that masks its GPU
  // string racing at medium for no reason.
  const device = typeof window === "undefined" ? null : getDeviceProfile();
  const tier = device ? detectQualityTier(device) : "high";
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
          spawnPopup(
            event.best ? "BEST LAP" : `LAP ${event.lap}`,
            event.best ? "xp" : "drift",
          );
          break;

        case "position":
          race.setPosition(event.position, engineRef.current?.telemetry.totalRacers ?? 1);
          if (event.position < event.previous) {
            spawnPopup("OVERTAKE +25", "xp");
          }
          break;

        case "drift-end":
          if (event.score > 40) {
            spawnPopup(
              `+${formatNumber(event.score)}  x${event.multiplier}`,
              "drift",
            );
          }
          break;

        case "collision":
          engineRef.current?.registerImpact(event.severity);
          // The cost, not just the fact. A callout that only says CONTACT does not
          // tell the player that contact is what is eating their XP.
          spawnPopup(`CONTACT −${XP_PER_CONTACT} XP`, "penalty");
          break;

        case "story":
          race.setStory(event.speaker, event.line);
          break;

        case "loaded":
          setModelsLoaded(true);
          break;

        case "load-failed":
          // The race is still playable on placeholders, so this is a warning on
          // the briefing rather than a hard failure.
          setModelError(event.reason);
          break;

        case "quality":
          // Only the governor emits this now, and it only ever demotes, so every
          // one of these is worth telling the player about.
          race.setStory("SYSTEM", `Quality reduced to ${event.tier} — ${event.reason}.`);
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
    [
      chainRun,
      creditLocalXp,
      level.bankingEnabled,
      level.laps,
      queuePendingRun,
      raceStore,
      sessionStore,
      spawnPopup,
    ],
  );

  /** Create the engine once. Renders immediately; starts on the player's cue. */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = sceneCanvasRef.current;
    if (!container || !canvas) return;

    const bridge: GameBridge = {
      onEvent: handleEvent,
      onTick: (payload) => {
        // Must return immediately. The queue coalesces and sends off-thread of
        // the render loop.
        sessionRef.current?.tick(payload);
      },
      // Already throttled to ~10Hz by the engine, so this is the only per-race
      // value that reaches React.
      onTelemetry: setTelemetry,
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
        // Read once, at construction. The engine is created before the briefing is
        // dismissed, so the name has to be settled before the grid is named — which
        // is why the field is on the briefing rather than a mid-race setting.
        driverName,
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

    return () => {
      document.body.removeAttribute("data-race");
      engine.dispose();
      engineRef.current = null;
      setTelemetry(null);
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
    engineRef.current?.setControls(controls);
  }, [controls]);

  useEffect(() => {
    engineRef.current?.setDriverName(driverName);
  }, [driverName]);

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
    // `ready` is also checked here, not just on the button: the chain path awaits
    // a wallet approval, and the button's disabled state is not authoritative
    // across that await.
    if (!engine || !engine.ready) return;

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
      spawnPopup("BANKED", "xp");
    } catch (error) {
      sessionStore
        .getState()
        .fail(error instanceof Error ? error.message : String(error));
    }
  }, [raceStore, sessionStore, spawnPopup]);

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

  // Rollup status line for the HUD. Derived from the store rather than pushed
  // into the HUD imperatively, which is the whole reason the DOM HUD is simpler
  // than the canvas one it replaced.
  const sessionPhase = useSession((s) => s.phase);
  const ticksLanded = useSession((s) => s.ticksLanded);
  const sessionLabel =
    sessionPhase === "idle"
      ? null
      : sessionPhase === "live"
        ? `ER LIVE · ${formatNumber(ticksLanded)} ticks`
        : sessionPhase === "simulated"
          ? "SIMULATION"
          : sessionPhase === "error"
            ? "ER ERROR"
            : sessionPhase.toUpperCase();
  const sessionTone =
    sessionPhase === "live"
      ? "live"
      : sessionPhase === "error"
        ? "error"
        : sessionPhase === "simulated"
          ? "warn"
          : "idle";

  const car = CARS[selectedCar];
  const showResults = phase === "finished" || phase === "failed";

  // -------------------------------------------------------------------- render

  return (
    <div ref={containerRef} className="relative h-dvh w-full overflow-hidden bg-void">
      <canvas ref={sceneCanvasRef} className="absolute inset-0 block size-full" />

      {stage === "running" && !showResults ? (
        <LightweightHud
          telemetry={telemetry}
          popups={popups}
          sessionLabel={sessionLabel}
          sessionTone={sessionTone}
        />
      ) : null}

      <StoryStrip />

      {chainRun && stage === "running" ? (
        <div className="safe-t pointer-events-none absolute right-4 top-4 z-20 hidden lg:block">
          <SessionPanel />
        </div>
      ) : null}

      {/*
        Left-hand side, below the HUD's lap/position block. Hidden on narrow
        viewports for the same reason as the session panel: there is not room for it
        beside the road.
      */}
      {stage === "running" && !showResults ? (
        <div className="absolute left-4 top-32 z-20 hidden lg:block">
          <RaceLeaderboard
            telemetry={telemetry}
            address={wallet?.publicKey?.toBase58() ?? null}
            committedXp={chainRun ? committedXp : null}
          />
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

          {/*
            Name entry lives here, not in a settings screen: it is the last thing
            before the grid is named, and this is the only screen where changing it
            has a visible consequence a moment later.
          */}
          <label className="mt-5 block">
            <span className="label text-fog">Driver name</span>
            <input
              type="text"
              value={driverName}
              maxLength={MAX_DRIVER_NAME_LENGTH}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setDriverName(event.target.value)}
              className="mt-1 w-full border border-steel bg-void px-2 py-2 font-mono text-sm uppercase tracking-wider text-chalk outline-none focus:border-apex"
              aria-describedby="driver-name-hint"
            />
            <span id="driver-name-hint" className="mt-1 block text-[10px] text-fog">
              Shown on the leaderboard. Stored in this browser only — never on chain.
            </span>
          </label>

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
            {!modelsLoaded ? <Badge tone="fog">Loading cars…</Badge> : null}
          </div>

          {modelError ? (
            <p className="mt-4 border-l-2 border-amber pl-3 text-[11px] leading-relaxed text-amber">
              {modelError} — the race will run with blocked-out stand-in cars.
            </p>
          ) : null}

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
            {/*
              Held until every car has attached its model. The grid used to be
              startable immediately, so a race that began before the GLBs arrived
              lined up blocked-out primitives against the player.
            */}
            <Button
              variant="primary"
              size="lg"
              disabled={!modelsLoaded}
              onClick={() => void beginRace()}
            >
              {!modelsLoaded ? "Loading…" : chainRun ? "Jack in" : "Start"}
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
