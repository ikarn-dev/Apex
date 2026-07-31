# APEX — Architecture

## Stack (verified versions)

| Layer | Choice | Version |
|---|---|---|
| App shell | Next.js App Router (Turbopack), React 19 | 16.2.12 / 19.2.8 |
| Language | TypeScript strict | 6.0.3 |
| UI styling | Tailwind CSS v4 (`@tailwindcss/postcss`) | 4.3.3 |
| 3D | **Vanilla** three.js | 0.185.1 |
| HUD | DOM, fed by throttled telemetry | — |
| State bridge | zustand | 5.0.14 |
| Chain | `@solana/web3.js` | 1.98.4 |
| Auth | `@solana/wallet-adapter-{base,react,react-ui}` | 0.9.27 / 0.15.39 / 0.9.39 |
| Rollup | `@magicblock-labs/ephemeral-rollups-sdk` | 0.16.2 |
| Program | Anchor / `ephemeral_rollups_sdk` (Rust) | 0.32.1 |

### Why vanilla three.js and not react-three-fiber

The render loop must not pass through React reconciliation. A racer mutates ~40 object
transforms per frame at 60Hz; doing that through JSX means React work every frame for
zero benefit. The engine is a plain class tree that owns its own `requestAnimationFrame`
loop, and React only mounts it, feeds it config, and reads coarse state (lap, position,
race phase) through a throttled bridge. No React state changes at frame rate.

### Why the HUD is DOM and not a second canvas

It used to be a full PixiJS application: 130KB gzip, its own WebGL context competing with
the scene for the GPU, and a second render loop to keep in step with the engine's. It was
replaced by a handful of DOM elements fed by `GameBridge.onTelemetry`, which the engine
publishes ~10 times a second.

The trade that makes this work is that **nothing in the HUD animates per frame**. React
reconciles ten times a second while the scene runs at sixty, and the gauges use CSS
transitions rather than per-frame interpolation. A needle arriving 100ms late is not
something a driver can see; a second GL context on a weak mobile GPU is.

### Why `@solana/wallet-adapter-wallets` is *not* installed

That meta-package pulls WalletConnect, Torus, web3auth and Stellar into the graph
(~1 GB installed, hundreds of KB shipped). Phantom, Solflare and Backpack all implement
the **Wallet Standard**, which `@solana/wallet-adapter-react` auto-discovers with an
empty `wallets` array.

---

## Directory map

```
Apex/
├── docs/                     PRD, story bible, this file
├── programs/apex_racing/     Anchor program (Rust) + ER delegation CPIs
├── assets/source/cars/       Raw 24MB source GLB (not shipped, git-ignored)
├── scripts/                  Asset pipeline + headless test suites (Node/tsx)
├── public/models/cars/       Optimised web GLBs (quantised geometry + WebP)
└── src/
    ├── app/                  Routes only — thin, mostly server components
    │   ├── layout.tsx        Fonts, metadata, viewport, providers
    │   ├── (menu)/           Landing, campaign, garage, profile, settings
    │   └── race/[levelId]/   Race shell (dynamic, ssr:false)
    ├── components/
    │   ├── ui/               Primitives (Button, Panel, Badge, Meter…)
    │   ├── wallet/           Connect button, boundary, chain status
    │   ├── race/             Race shell, DOM HUD, results, session panel
    │   ├── screens/          Composed screen bodies
    │   ├── layout/           App shell, XP pill
    │   └── providers/        Client provider tree
    ├── game/                 ZERO React imports below this line
    │   ├── engine/           Engine, Renderer, Resources, Input, Audio, ChaseCamera, World
    │   ├── physics/          Deterministic vehicle sim
    │   ├── track/            layout (circuit definition), Track (queries), CircuitView
    │   ├── world/            MeshBuilder — indexed geometry accumulator
    │   ├── entities/         CarView (model + wheel/steering rig)
    │   ├── ai/               Racing-line driver
    │   ├── race/             Race director + state machine + collision
    │   ├── scoring/          XP + drift scoring (mirrors on-chain math)
    │   └── config/           Cars, levels, progression, quality, asset manifest
    ├── chain/
    │   ├── config.ts         Cluster + ER endpoints, program id
    │   ├── program/          PDAs, instruction encoders, account decoders, borsh
    │   ├── er/               Router connection, session manager, tick queue
    │   └── hooks/            React bindings (useDriverProfile, useWalletBridge…)
    ├── stores/               zustand slices (settings, profile, session, race)
    ├── hooks/                useHydrated, useDeviceProfile
    └── lib/                  cn, device, math, seeded RNG, format
```

**Dependency rule:** `game/*` never imports React, `chain/*`, or `stores/*`. The engine
receives a small callback interface (`GameBridge`) from the React layer and calls it.
This keeps the simulation testable, portable, and free of chain concerns.

The one place this rule is bent deliberately: `game/config/{cars,levels,types}` are
imported by `chain/*` and `stores/*`, because the car and level indices are part of the
on-chain account format. Those files are protocol definitions, not engine internals.

---

## The circuit

APEX International is **generated at load**, not downloaded. `game/track/layout.ts`
authors it as a closed ring of control points and turns it into uniformly spaced route
samples; `Track` answers queries against those samples; `CircuitView` builds the visible
geometry from the same data.

It replaced a supplied Suzuka GLB whose centreline had been extracted offline into a
committed JSON. That source asset is no longer available, so the route could not be
regenerated from anything — and a supplied mesh can drift out of agreement with its
extracted route, where generated geometry cannot.

Two properties are protected deliberately:

- **It closes exactly.** A centripetal Catmull-Rom through a closed ring cannot leave a
  seam. Lap counting derives from monotonic arc length, so a discontinuity at the
  start/finish join would read as a teleport.
- **It is exactly 5,860m.** The authored shape is measured and then scaled to hit that
  number, because every level's `parMs`/`floorMs` is calibrated against lap distance.
  Pinning it means the layout can be reshaped without silently invalidating the campaign's
  timing or the on-chain `floor_ms` rejection threshold.

Geometry, per `npm run circuit:inspect`: 2,344 samples at 2.5m, 35.9m tightest radius,
3.1% steepest gradient, 30.5m elevation range, 9.2–15.2m road width, 4.9° maximum
banking.

### Trackside rendering

Everything is untextured, vertex-coloured, flat-shaded geometry, so the whole lap draws
from one material — 66k triangles across 25 chunks of ~240m, of which roughly four are
in frustum at a time.

Two details that are load-bearing rather than cosmetic:

- **Faces get their own vertices.** `computeVertexNormals` would otherwise average a kerb
  into the asphalt and round off every hard edge.
- **Paint is separate geometry lifted 4cm off the surface.** Coplanar markings z-fight at
  every distance the chase camera actually uses.

The ground plane sits below the *lowest* point of the circuit and the run-off banks down
to meet it, with reach proportional to the height it has to cover. Using mean elevation
instead buried 1,232 of 2,344 samples: over half the lap ran through a trench with the
grass drawn over the top of it.

---

## The car

One vehicle, the Aston Martin DBS GT Zagato, shipped **with its own PBR textures** rather
than flattened to solid colours — the paint, gold rim decals and tinted glass are the
reason to use the model at all.

`scripts/optimize-assets.mjs` takes it from 24MB to 2MB by dropping cabin geometry a chase
camera cannot see (92 of 204 mesh nodes, 86k vertices) and quantising the rest. It uses
`KHR_mesh_quantization` and `EXT_texture_webp`, both of which three.js decodes natively —
so `Resources` is a bare `GLTFLoader` with **no Draco and no KTX2 plugin**, keeping two
CDN fetches and a WASM decoder off the race loading path.

### The rig

The source exposes four `WHEEL_**` groups and a `STEER_HR` column. `flatten`/`join` would
fold them away, so the pipeline pins each with a tiny non-playing animation channel —
gltf-transform will not flatten a node an animation targets. `CarView` then wraps each in
a steer pivot and a spin pivot built from the subtree's own bounding box, because the
source pivots sit at baked, rotated offsets rather than at the visible wheel centre.

Keeping the rig costs primitives, since `join` cannot merge across an animated node. So
only the player's car pays for it:

| | `zagato.glb` | `zagato-lq.glb` |
|---|---|---|
| Used by | player | rivals |
| Rig | preserved | collapsed |
| Draw calls | 52 | 31 |
| Size / VRAM | 1.99MB / 20.5MB | 1.40MB / 9.4MB |

At five rivals the whole field is ~200 draw calls, and one rigged car costs about as much
as two rivals.

### Steering

`InputManager` models a steering wheel and column; `VehicleSim` converts wheel position to
a road-wheel angle and applies the speed-dependent lock limit. Keeping that split means
one file describes how a driver behaves and the other how tyres do.

Three properties a real car has: it **self-centres** (0.18s to straight, 0.10s at speed),
**unwinds faster than it winds on** (caster assists), and **loads up with speed** (the same
input gives 0.60 lock at rest and 0.355 at 50 m/s). Speed-based lock limiting lives in
exactly one place — applying it to the input's output as well left the wheel position and
the road-wheel angle disagreeing.

### Asset URLs are content-addressed

The pipeline writes fixed filenames, so nothing in the URL tells a browser that a model
changed. It writes a hash manifest instead, and `game/config/assets.ts` appends
`?v=<hash>`, which is what allows `/models/*` to be served `immutable` honestly.

This is not hypothetical: the header once claimed immutability the filenames never
provided. An early Draco-compressed build stayed pinned in browser caches against a loader
that no longer had a Draco decoder, and no rebuild or reload could dislodge it.

---

## Runtime data flow

```
 wallet-adapter ──▶ chain/hooks ──▶ stores/profile ──▶ React screens
                                          │
                                    race config
                                          ▼
 React <RaceShell/> ──mount──▶ game/engine/Engine
                                          │  60Hz fixed step
                                   physics + AI + track
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                   three.js render   onTelemetry     GameBridge events
                                     (~10Hz → DOM HUD)    │
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

### Containment

A car cannot leave the ribbon. `RaceDirector.resolveTrackEdge` clamps lateral offset to
the measured half-width less the car's **full** half-width, so it stops with its flank on
the barrier face that `CircuitView` draws at exactly that half-width. Besides being the
obvious arcade behaviour, this is what makes the derived-progress model safe: a car that
cannot leave the road cannot shortcut a corner and claim arc length it did not cover.

Three things all have to hold, and each has failed at least once:

1. The wall is where the barrier is drawn.
2. The width and the offset come from the **same** route sample. Reading the width from a
   cached index while re-projecting the offset let a car through a narrowing corner by the
   difference between them.
3. A car already outside can be found again. `Track.project` searches a ±24-sample window
   around a hint — an optimisation that becomes a trap, because once a car is off the
   ribbon the nearest sample may fall outside that window and the clamp starts measuring
   against the wrong part of the circuit. A car more than 12m past the edge now gets a
   full search before being clamped.

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

`abandon_session` closes a run without committing (the FLATLINE path).

Two wallet approvals per race, both outside of driving.

### Session keys (why there are no popups mid-race)

A fresh `Keypair` is generated in the browser per race and its pubkey is written into the
`RaceSession` at `open_session`. ER instructions require
`session_signer == race_session.session_signer`, so the client can sign ticks locally at
speed. The key can do exactly one thing — advance the state of that one race — and is
discarded when the race ends. It cannot move lamports, touch the profile, or claim XP.

### Level timing is duplicated on purpose

`game/config/levels.ts` and `programs/apex_racing/src/xp.rs` both carry `parMs`/`floorMs`
per level, because the program recomputes XP rather than trusting the client and range-
checks `floor_ms` as an anti-cheat threshold. They are generated together by
`npm run calibrate`, which drives a reference policy round the real circuit in the real
car, and **must be re-run whenever the layout or the car's tuning changes** — a stale
`floor_ms` rejects legitimate runs.

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
| Car model fails to load | Blocked-out stand-in cars, warning on the briefing. Race is playable. |

The rule: **the chain may never stall a frame.** All chain I/O is off the render path,
fire-and-forget, and a failure downgrades scoring fidelity rather than gameplay.

---

## Performance strategy

| Concern | Approach |
|---|---|
| Initial payload | Engine and three are `dynamic(..., {ssr:false})` on the race route only |
| Models | Quantised geometry + WebP textures, ~3.4MB for both car variants, ~1.9MB for all scenery |
| Circuit | Generated at load — no download, complete before the first frame |
| Draw calls | 25 merged circuit chunks (~4 in frustum) + 52 player + 31/rival + 26 instanced trees + 4 backdrop |
| Scenery | Three supplied HD trees reduced by role — structure simplified, foliage decimated by whole leaf cards — then instanced both sides of the circuit |
| Backdrop | One landscape model, relief only, ringed around the camera in X/Z at 0.85 of the draw distance |
| Lighting | One directional light, ambient, hemisphere, plus a PMREM environment map |
| Shadows | HIGH 2048, MEDIUM 1024, LOW blob shadow under each car |
| DPR | Capped per tier, auto-downscaled after sustained frame time >21ms |
| GC | Zero allocation in the hot loop: pre-allocated scratch vectors |
| Thermals | Runtime quality demotion, never promotion, to avoid oscillation |
| Tab hidden | Loop paused, audio suspended |

### Why the sky feeds image-based lighting

The car's paint is metallic, and a metallic surface with nothing to reflect renders
near-black no matter how bright the sun is. The same gradient the sky dome uses is
pre-filtered into an environment map once at load, which costs one small render and no
downloaded HDRI.

## Quality tiers

Detected from `deviceMemory`, `hardwareConcurrency`, and the GPU renderer string via
`WEBGL_debug_renderer_info`, then owned by the runtime frame-time governor.

| | LOW | MEDIUM | HIGH |
|---|---|---|---|
| DPR cap | 1.0 | 1.25 | 2.0 |
| Shadows | none (blob) | 1024 | 2048 |
| Rivals | 2 | 3 | 5 |
| Anisotropy | 1 | 4 | 8 |
| Draw distance | 650m | 950m | 1400m |
| MSAA | off | off | on |

**Quality is not a user setting.** The governor may only ever *demote*, so a pinned tier
was actively broken: a player selecting HIGH on hardware that could not hold it left the
watchdog no move except stepping down from the tier the user had pinned, and the setting
either did nothing or produced a permanently stuttering race. Settings shows the detected
profile read-only.

---

## Verification

`npm run verify` runs the whole chain. Each suite was confirmed to **fail on the broken
code**, not merely pass on the fixed code — a test that has never failed has not been
tested.

| Command | Asserts |
|---|---|
| `typecheck`, `lint` | — |
| `assets:inspect` | Per-variant budgets, rig survival, no extension the loader cannot decode, manifest matches file hashes |
| `test:sim` | 93 checks: determinism, replay hash stability, every level completable, par times reachable, drift gate meaningful, leaderboard feed ordered/named/charging for contact |
| `test:containment` | Four adversarial policies driven into the walls for 150s each; the car stays inside the barriers and on the *banked* surface |
| `test:wall` | A sustained barrier scrape costs speed gradually, stays driveable, and costs the same at 60Hz and 120Hz |
| `test:steering` | Self-centring, centring faster than winding on, both scaling with speed |
| `test:view` | Every horizontal triangle over the driving corridor faces up, and mid-road geometry is asphalt |
| `test:rig` | All four wheels found, zero drift from pivot wrapping, rotation about the axle, collision box contains the drawn body, wheel envelope in the frame `CarView` expects |
| `test:scenery` | No crown overhangs the barrier, no tree sits far down the bank, the backdrop ring closes and its peaks reach the intended angle on every tier |
| `build` | — |

`circuit:inspect` and `calibrate` are diagnostics, run on demand rather than in `verify`.

### Why `test:view` exists

A surface built with its winding reversed is hidden completely by backface culling. The
road, its edge lines and its markings were all wound `left → right → forward`, which is
the intuitive order and is wrong — `cross(right, forward)` is −Y, so all of it faced the
ground. The result was a green race track, and it read as a deliberate art choice because
the kerbs and barriers around it happened to be wound correctly.

### Why the vertical solver compares accelerations

The car used to be treated as airborne whenever it sat more than 120mm above the surface
it was handed. That worked only while the surface was the centreline height. Once it
accounted for the road's crossfall — which it has to, or the car hovers up to 0.65m above
the low side of every banked corner — the target moved by up to a metre whenever the
driver changed line, the car was declared airborne, and it was left to fall. At speed that
read as the car flying.

A grounded car now sits exactly on its surface and leaves it only when the surface's own
*vertical acceleration* exceeds gravity, which is the real condition for losing contact
over a crest. It is also immune to the car's lateral motion, because that motion is smooth:
it is the second derivative that has to be large.

### Why the tree band is measured in metres

The run-off's width is not constant — it grows 3.2m for every metre the road sits above
the surrounding ground plane, so on a section 20m up it is 90m wide. Planting trees at a
*fraction* of that width therefore meant "beside the road where the circuit is low, fifty
metres away and twelve metres below it where the circuit is high", and most of this layout
is high. The tree line rendered as small dark clumps out on the grass. A standoff in metres
plants them 9–22m out everywhere, where the bank has barely started to fall.

### Why the backdrop is scaled non-uniformly

Closing a ring of terrain chunks around the camera and giving the peaks a believable
angular height are two different requirements, and a single uniform scale cannot satisfy
both: the frontage needed to cover a 1.2km arc in ten pieces is nine times the model, and
the relief that reads as a distant range is under four. Scaling uniformly to close the ring
put 450m peaks 540m from the camera and filled the sky with green shards. Stretching each
copy along its arc and setting the vertical scale from a fixed 9° elevation resolves it,
and `test:scenery` asserts both properties on every tier.
