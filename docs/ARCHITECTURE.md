# APEX — Architecture

## Stack (verified versions)

| Layer | Choice | Version |
|---|---|---|
| App shell | Next.js App Router, React 19 | 16.2.12 / 19.2.8 |
| Language | TypeScript strict | 7.0.2 |
| UI styling | Tailwind CSS v4 (`@tailwindcss/postcss`) | 4.3.3 |
| 3D | **Vanilla** three.js | 0.185.1 |
| 2D HUD | PixiJS v8 | 8.19.0 |
| State bridge | zustand | 5.0.14 |
| Chain | `@solana/web3.js` | 1.98.4 |
| Auth | `@solana/wallet-adapter-*` (+ mobile adapter) | 0.15.39 / 0.9.39 |
| Rollup | `@magicblock-labs/ephemeral-rollups-sdk` | 0.16.2 |
| Program | Anchor / `ephemeral_rollups_sdk` (Rust) | 0.32 |

### Why vanilla three.js and not react-three-fiber

The render loop must not pass through React reconciliation. A racer mutates ~40 object
transforms per frame at 60Hz; doing that through JSX means React work every frame for
zero benefit. The engine is a plain class tree that owns its own `requestAnimationFrame`
loop, and React only mounts it, feeds it config, and reads coarse state (lap, position,
race phase) through a throttled zustand bridge. No React state changes at frame rate.

### Why PixiJS for the HUD

Gauges, minimap, drift meter and XP popups animate every frame. In the DOM that is
layout thrash; in Pixi it is one extra canvas with batched draws. The HUD is a separate
2D context composited over the WebGL canvas, and it is **disabled on the LOW quality
tier** in favour of a static DOM HUD, because two GL contexts on a weak mobile GPU is a
worse trade than losing the animated gauges.

### Why `@solana/wallet-adapter-wallets` is *not* installed

That meta-package pulls WalletConnect, Torus, web3auth and Stellar into the graph
(~1 GB installed, hundreds of KB shipped). Phantom, Solflare and Backpack all implement
the **Wallet Standard**, which `@solana/wallet-adapter-react` auto-discovers with an
empty `wallets` array. Only `@solana-mobile/wallet-adapter-mobile` is added explicitly,
for Android MWA deep-linking.

---

## Directory map

```
Apex/
├── docs/                     PRD, story bible, this file
├── programs/apex_racing/     Anchor program (Rust) + ER delegation CPIs
├── assets/source/cars/       Raw 25–37MB GLBs (not shipped, git-ignored)
├── scripts/                  Asset optimisation + inspection (Node)
├── public/models/cars/       Optimised web GLBs (≤2.5MB, Draco + WebP)
└── src/
    ├── app/                  Routes only — thin, mostly server components
    │   ├── layout.tsx        Fonts, metadata, viewport, providers
    │   ├── page.tsx          Landing
    │   ├── campaign/         Level select
    │   ├── garage/           Car select
    │   ├── profile/          XP + claim
    │   ├── race/[levelId]/   Race shell (dynamic, ssr:false)
    │   └── settings/
    ├── components/
    │   ├── ui/               Primitives (Button, Panel, Stat, Meter…)
    │   ├── wallet/           Connect button, gate, session badge
    │   ├── hud/              React HUD shell + DOM fallback HUD
    │   ├── screens/          Composed screen bodies
    │   └── providers/        Client provider tree
    ├── game/                 ZERO React imports below this line
    │   ├── engine/           Engine, Loop, Renderer, Resources, Input, Audio, Quality
    │   ├── physics/          Deterministic vehicle sim + collision
    │   ├── track/            Spline, mesh builder, checkpoints, racing line
    │   ├── entities/         PlayerCar, RivalCar, Ghost
    │   ├── ai/               Racing-line driver
    │   ├── race/            Race director + state machine
    │   ├── scoring/          XP + drift scoring (mirrors on-chain math)
    │   ├── hud/              Pixi HUD renderer
    │   └── config/           Cars, levels, tuning, quality tiers
    ├── chain/
    │   ├── config.ts         Cluster + ER endpoints, program id
    │   ├── program/          IDL, PDAs, instruction encoders, account decoders
    │   ├── er/               Router connection, session manager, tick queue
    │   └── hooks/            React bindings (useDriverProfile, useRaceSession…)
    ├── stores/               zustand slices (settings, profile, session, race)
    ├── lib/                  utils, device, math, seeded RNG, storage, format
    └── types/
```

**Dependency rule:** `game/*` never imports React, `chain/*`, or `stores/*`. The engine
receives a small callback interface (`GameBridge`) from the React layer and calls it.
This keeps the simulation testable, portable, and free of chain concerns.

---

## Runtime data flow

```
 wallet-adapter ──▶ chain/hooks ──▶ stores/profile ──▶ React screens
                                          │
                                    race config
                                          ▼
 React <RaceCanvas/> ──mount──▶ game/engine/Engine
                                          │  60Hz fixed step
                                   physics + AI + track
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                   three.js render   Pixi HUD draw    GameBridge events
                                                          │
                                              (checkpoint / drift / lap / finish)
                                                          ▼
                                                  chain/er/TickQueue
                                                   coalesce + batch
                                                          ▼
                                        ER tx signed by in-memory session key
                                                          ▼
                                          commit ──▶ Solana base layer
```

### The fixed-step loop

`accumulator += min(dt, 100ms)`, then `while (accumulator >= 1/60) step()`. Rendering
interpolates between the last two physics states. Consequences: identical results on a
144Hz monitor and a throttled phone, replays are reproducible, and a long GC pause
cannot tunnel a car through a wall.

### Determinism

Physics uses only `Float64` arithmetic, a seeded xorshift128 RNG (no `Math.random`), and
a fixed step. Given `(seed, carId, levelId, inputLog)` the outcome is bit-identical
across devices. That gives us the replay hash the program range-checks, and it is the
foundation for real replay verification later.

### The engine ↔ React bridge

Frame-rate state (position, rpm, wheel slip) never enters React. It is written into a
plain mutable `Telemetry` object that Pixi reads directly. Only *discrete* events cross
into zustand: phase changes, lap completions, checkpoint indices, position changes,
finish. React re-renders a handful of times per race, not 60 times per second.

---

## Chain architecture

### Accounts

| Account | Seeds | Lifetime | Home |
|---|---|---|---|
| `DriverProfile` | `["driver", authority]` | Permanent | Base layer |
| `RaceSession` | `["session", authority, nonce_le]` | One run | Base layer → **delegated to ER** → back |

### Lifecycle

1. **`initialize_driver`** — base layer, once per wallet. Wallet signs.
2. **`open_session(nonce, level, car, seed, session_signer)`** — base layer. Creates the
   `RaceSession` and records the **session key** that may drive it. Wallet signs.
3. **`delegate_session`** — base layer, CPIs into the delegation program. After this the
   account is owned by the ER. Wallet signs. *(2 and 3 are one transaction, so the
   player approves once.)*
4. **`tick(checkpoint, drift_delta, collisions, elapsed_ms)`** — **executed in the ER**,
   many times per race, signed by the in-memory session key. No wallet prompt, ~10ms.
5. **`finish_race(total_ms, best_lap_ms, position, overtakes, replay_hash)`** — in the
   ER. Computes `xp_earned` with the same formula as the client.
6. **`bank_run`** — in the ER, CPIs `commit_accounts`. State is flushed to the base layer
   while the account stays delegated (Act IV mid-race banking).
7. **`settle_run`** — in the ER, CPIs `commit_and_undelegate_accounts`. Final flush,
   ownership returns to the base layer.
8. **`claim_xp`** — base layer, once undelegated. Moves `xp_pending → xp_committed`,
   recomputes rank and unlocks, closes the session. Wallet signs.

Two wallet approvals per race, both outside of driving.

### Session keys (why there are no popups mid-race)

A fresh `Keypair` is generated in the browser per race and its pubkey is written into the
`RaceSession` at `open_session`. ER instructions require
`session_signer == race_session.session_signer`, so the client can sign ticks locally at
speed. The key can do exactly one thing — advance the state of that one race — and is
discarded when the race ends. It cannot move lamports, touch the profile, or claim XP.

### Endpoints (probed live, 2026-07-29)

| Purpose | URL | Status |
|---|---|---|
| Base layer | `https://api.devnet.solana.com` | solana-core 4.2.0-beta.1 |
| ER (default) | `https://devnet.magicblock.app` | magicblock-core 0.13.17 |
| ER (asia) | `https://devnet-as.magicblock.app` | magicblock-core 0.13.17 |
| Magic router | `https://devnet-router.magicblock.app` | 403 without key — opt-in via env |

All overridable through `NEXT_PUBLIC_*` env vars.

### Degradation ladder

| Condition | Behaviour |
|---|---|
| No wallet connected | Practice mode. Full gameplay, local XP, cannot commit. |
| Program not deployed | **Simulation mode** banner. Gameplay identical, XP local-only. |
| ER unreachable mid-race | Ticks queue and retry; race continues. Commit falls back to base layer. |
| Commit fails | Run held in local `pendingRuns`, retryable from Profile. |

The rule: **the chain may never stall a frame.** All chain I/O is off the render path,
fire-and-forget, and a failure downgrades scoring fidelity rather than gameplay.

---

## Performance strategy

| Concern | Approach |
|---|---|
| Initial payload | Engine, three, and Pixi are `dynamic(..., {ssr:false})` on the race route only |
| Models | Draco geometry + WebP textures, ≤2.5MB/car, loaded per selected car |
| Draw calls | Track built as merged chunk meshes; instanced props; ≤120 calls |
| Shadows | HIGH: one 1024 cascade. MEDIUM: 512. LOW: baked blob shadow only |
| Post FX | HIGH only, and only bloom |
| DPR | `min(devicePixelRatio, mobile ? 1.5 : 2)`, auto-downscaled when frame time >20ms for 30 frames |
| Textures | KTX2/WebP, `generateMipmaps`, anisotropy capped at 4 |
| GC | Zero allocation in the hot loop: pre-allocated scratch vectors, object pools for particles |
| Thermals | Runtime quality demotion, never promotion, to avoid oscillation |
| Tab hidden | Loop paused, audio suspended, ER ticks flushed |

## Quality tiers

Detected from `deviceMemory`, `hardwareConcurrency`, GPU renderer string via
`WEBGL_debug_renderer_info`, and a live frame-time probe over the first 60 frames.
User-overridable in Settings and persisted.

| | LOW | MEDIUM | HIGH |
|---|---|---|---|
| DPR cap | 1.0 | 1.25 | 2.0 |
| Shadows | none | 512 | 1024 |
| Post FX | none | none | bloom |
| Rivals | 3 | 5 | 5 |
| Pixi HUD | DOM fallback | yes | yes |
| Env reflections | flat colour | low probe | probe |
