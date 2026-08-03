# Round 4 — physics, co-op and damage accounting

Branch `round7/content-and-polish`, from HEAD `b18a2b4`. Nothing committed.

Files changed (mine only): `src/world/Stage.js`, `src/entities/Player.js`,
`src/systems/Combat.js`, `src/systems/Director.js`, `src/systems/Progression.js`.
195 insertions, 53 deletions across the five.

| # | Defect | Status |
|---|---|---|
| 1 | CRITICAL — Waxed Wing annihilated by `capsuleResolve`'s terrain test | **Fixed** |
| 2a | Co-op — a peer's jump spends the host's item hooks | **Fixed** |
| 2b | Co-op — a client drops its own jump impulse on replay | **Fixed** |
| 2c | Co-op — a teammate's damage fires the local hurt response; reflect lands on the wrong survivor | **Fixed** |
| 3 | MAJOR — barrier-absorbed damage counted as damage taken | **Fixed in `Progression`. `Profile` half is genuinely required and is not mine — see §3.** |
| 4 | MINOR — uncapped impulse tunnels a thin prop | **Fixed, at the solver rather than with a cap** |
| 5 | MINOR — `speedMultiplier` returns a literal 0 for freeze | **Fixed** |
| 6 | MAJOR — slowed burrower off contract | **Not fixed. Declined with reason — my instrument failed its own sanity check. See §6.** |

Build exit 0 (`✓ built in 678ms`). Capture 21/21 into
`reviews/round7/r4fix-physics/capture/`, `audioOk` with all twelve audio checks
passing, `clockPinned: true`, `frameDt 1/60`, `frameTimeouts: 0`, 0 console
errors, and **one** failing check — `06-loaded-hud` / "monsters under load",
object 6, `sepP50 0.13` against the 0.25 gate. Same shot, same subject, same
cause as `E-framing.md` §5 and the round-3 critique. Unchanged in kind, not
chased.

---

## Evidence, and where every number came from

Every figure below is quoted from a named file under
`reviews/round7/r4fix-physics/`, kept on disk:

| file | what it is |
|---|---|
| `probeA-before.json` / `probeA-after.json` | corridor sweeps + prop tunnelling |
| `probeB-before.json` / `probeB-after.json` | **the population sweep — the headline evidence** |
| `probeC-before.json` / `probeC-after.json` | containment gate (under-floor / out-of-bounds / cliff scaling) |
| `probeDiag-after.json` | branch attribution inside `capsuleResolve` |
| `probeCoop-before.json` / `probeCoop-after.json` | the real two-peer session |
| `probeSlow-after.json` | status multipliers, and the disqualified enemy-slow instrument |
| `capture/manifest.json` | the 21-shot run |

**Baseline capture method, named as the round asks.** "Before" numbers were not
taken from the critique. They were re-measured by
`git stash push -- <my five files>`, running the *identical* probe script, then
`git stash pop`. The other four fixers' work was live in the tree in both arms,
so before/after differ only by my five files. Every probe stops the engine
(`engine.stop()` + `__HARNESS__.freeze()`) and steps the simulation by hand
through `applyCommand`, so **none of these numbers pass through the
`Engine.start` double-loop being fixed in parallel** — the loop count cannot
affect a hand-stepped measurement. The one exception is the co-op probe, which
needs live net systems; see §2 for how that was handled.

---

## 1. CRITICAL — Waxed Wing's impulse, at both ends of the range

### What was actually wrong — measured, not assumed

Both critics were right about their own stand, and a single stand is why they
disagreed. My first two instruments reproduced *both* of their results depending
on where I stood, which is not a measurement. So the attribution was
instrumented instead: `Stage._climbable` was wrapped and every failure counted
(`probeDiag-after.json`), and then the whole thing was run as a **population**
over a deterministic grid of 138 walkable stands × 4 headings = 332 sprint-jumps
per stack count, the same stand list in both builds (`probeB-*.json`).

Two distinct faults, not one:

1. **The step is tested at one point.** `capsuleResolve` moved the whole
   horizontal displacement in one teleport and tested only the destination.
   At 110 m/s that is a 1.84 m jump over an untested path.
2. **The test is a *walking* test applied to a body in the air.** `_climbable`
   asks "could this capsule step up onto that, and is the face walkable" —
   `Stage.js:625`, the slope clause. A jump passing *over* ground that rises at
   all, at more than the 50° walk limit, fails it; no axis is free; and the
   `if (!moved) { _vel.x = 0; _vel.z = 0; }` line deletes the entire launch in
   mid-flight, over ground the player is metres above and never touches.

Fault 2 is the dominant one, and it is the one neither critique named. Fixing
only fault 1 (sub-stepping) moved 12-stack annihilation from 54.5 % to 35.5 % —
better, still broken.

### The fix

`Stage.js`. Three parts:

- `SWEEP_STEP = 0.3`, `SWEEP_MAX = 16`: the horizontal half is swept in
  sub-steps of at most 0.3 m, terrain **and** prop depenetration inside the
  loop, velocity re-read each sub-step so a wall projection is followed. `n` is
  **1 for every ordinary velocity in the game** (10 m/s is 0.17 m a step), so
  the common path is byte-for-byte the solver it has always been.
- `_airClear(x, z, fromY)`: the airborne companion to `_climbable`. Keeps the
  bound check and the `STEP_HEIGHT` allowance, drops the walk-slope clause,
  because how steep the ground you are flying over is is not a question about a
  body in the air.
- `airborne = _vel.y > 0 || startY > groundHeight + SNAP_DIST`. Rising counts:
  horizontal resolves before vertical, so on the very step a jump is taken the
  feet are still at ground height — and that is the longest step of the launch,
  the one being deleted outright.

### Before / after — the whole stack range, 332 samples each

`probeB-before.json` / `probeB-after.json`. "zeroed mid-air" is the count of
runs whose horizontal speed hit *exactly* 0 while airborne; "(climbFail)" is how
many of those coincided with a `_climbable` rejection, i.e. how many were the
terrain test rather than a real rock.

| stacks | printed launch | zeroed mid-air BEFORE | of which terrain | zeroed mid-air AFTER | of which terrain | mean jump travel before → after |
|---|---|---|---|---|---|---|
| 0 | 10.15 | 27 (8.1 %) | 27 | **6 (1.8 %)** | **0** | 9.28 → 9.28 m |
| 1 | 20.15 | 28 (8.4 %) | 28 | **10 (3.0 %)** | **0** | 10.67 → 10.65 |
| 2 | 30.15 | 44 (13.3 %) | 44 | **11 (3.3 %)** | **0** | 14.38 → 14.33 |
| 3 | 40.15 | 65 (19.6 %) | 65 | **14 (4.2 %)** | **0** | 18.33 → 18.13 |
| 4 | 50.15 | 86 (25.9 %) | 86 | **19 (5.7 %)** | **0** | 21.76 → 21.45 |
| 5 | 60.15 | 109 (32.8 %) | 109 | **26 (7.8 %)** | **0** | 24.36 → 23.86 |
| 6 | 70.15 | 121 (36.4 %) | 121 | **27 (8.1 %)** | **0** | 26.28 → 25.32 |
| 8 | 90.15 | 147 (44.3 %) | 147 | **30 (9.0 %)** | **0** | 29.74 → 28.41 |
| 10 | 110.15 | 171 (51.5 %) | 171 | **37 (11.1 %)** | **0** | 32.35 → 30.09 |
| 12 | 130.15 | 181 (54.5 %) | 181 | **43 (13.0 %)** | **0** | 31.77 → 30.78 |

**The terrain test now deletes zero launches at every stack count from 0 to 12.**
Before, it deleted every single one of the 181 that died at 12 stacks, and its
share rose monotonically with the launch — the exact signature the content
critic described. The residue after the fix (13 % at 12 stacks against 1.8 % at
0) is the player meeting an actual rock, and it scales with how far they travel,
which is correct.

**Stating the failure at both ends, as required.** Low end: 0 stacks went 8.1 % →
1.8 %, terrain-attributed 27 → 0 — the fix helps the *plain jump* too, and does
not overshoot into "nothing can ever stop you". High end: 12 stacks 54.5 % →
13 %, and a launch is still stoppable, which the containment gate below proves.

### On clean ground, the printed number is now exactly the number

`probeA-after.json`, three corridors chosen for 45 m of walkable ground with the
nearest prop 9.6–11.2 m off the line, each proved with a 0-stack control before
use. At every stack from 0 to 12 in all three corridors, launch speed and peak
airborne speed are **exactly `10.15 + 10n`**, `zeroedAtAirStep: -1`. This also
held on the baseline in those corridors — clean ground was never the problem,
which is precisely why a single-stand measurement certified the card as "linear".

### Containment — the regression this fix could plausibly have caused

Relaxing a terrain test for airborne bodies is only correct if it does not also
let them somewhere new. `probeC-*.json`: 900 fixed steps of jump-spam driven
straight at all four cliff walls and at the steepest face in the stage
(`slopeDot 0.111` at 56, −77), at 0 / 3 / 6 / 12 stacks, 36 runs per build.

| | before | after |
|---|---|---|
| steps below the floor | 0 | **0** |
| steps outside the stage bound (104) | 0 | **0** |
| max overshoot past the bound | 0.0000 | **0.0000** |
| max ground height reached, wall runs | 28.39 m | 32.81 m |
| max ground height reached, cliff runs | 8.75 m | 8.47 m |

No under-floor, no out-of-bounds, and no stack-dependent climb at the steepest
face (8.4–8.5 m at every stack count in both builds). The one honest difference
is +4.4 m of ground height on the long wall-runs: an airborne player can now
settle on terrain a little higher than before over 15 s of continuous
jump-spam at a cliff. Reported rather than buried; it is bounded by the same
`STEP_HEIGHT` allowance the walking test always had, and the map bound holds.

---

## 2. Co-op — a real two-peer session

This is the arm the summary said "nearly every agent named and nobody tested".

**It is a genuine session.** Two browser pages, `ctx.lobby.createInvite()` →
`joinManual` → `acceptAnswer`, a real WebRTC data channel, `NetHost` with
`clients.size 1` and `authority true`, `NetClient` with `authority false`, and a
pawn created by the real peer-join path (`hostHasPawn: true`). Jumps are pressed
into the client's own `Input` and travel `NetClient._sampleInput` →
`writeInput` → data channel → `NetHost._onMessage` → `pawn.applyCommand`. The
after-run recorded **18 commands carrying the jump bit applied to the pawn** out
of 66 applied (`probeCoop-after.json` → `jumpCrossTalk.wire`).

**Two concessions, both stated.** (a) Both engines are kept frozen and
`NetClient.fixedUpdate` / `NetHost.fixedUpdate` are pumped by hand: two live
SwiftShader sessions in one browser crashed the renderer on this machine, and
the pumped path is the entire input path anyway. Every figure here is an event
count or a boolean, not a per-second rate, so engine-loop multiplicity cannot
distort it. (b) The two sides must be stepped in **lockstep** — `NetHost` keeps
at most `MAX_INPUT_BACKLOG = 12` queued commands per peer and splices the
*oldest* off on overflow, so bursting a round's ticks before the host consumes
any silently drops exactly the leading tick, which is the one carrying the jump.
That cost four probe runs and is a property of the product, not a bug: a live
client sends at the rate the host consumes.

### Before / after, same probe, my five files stashed for the baseline

| measurement | BEFORE | AFTER |
|---|---|---|
| **2a. peer's jump spends host's items** — host holds Waxed Wing ×3, Rubber Soles ×1, Tectonic Heart ×1, and never jumps | | |
| host shield (Rubber Soles paying out) | 0 → **55** | 0 → **0** |
| `jump` events on the host's bus | **6** | **0** |
| host `consumeImpulse` calls | **[30, 30, 36, 30, 30, 36]** | **[]** |
| pawn peak horizontal speed (host's Waxed Wing launching the peer) | **36 m/s** | **0** |
| host `jumpsUsed` (never jumped, both arms) | 0 | 0 |
| **2b. client replay** — client holds Waxed Wing ×3, same tick applied live then replayed from an identical state | | |
| live velocity / `consumeImpulse` | 31.133 / `[30]` | 31.133 / `[30]` |
| replay velocity / `consumeImpulse` | **1.133** / `[]` | **31.133** / `[]` |
| divergence | **30.000** | **0.000** |
| **2c. teammate damage** — pawn 40 m away takes 50 to health, local hurt timer aged 30 s | | |
| local `playerHurt` events | **2** | **0** |
| local `timeSinceHurt` | 30 → **0** | 30 → **30** |
| host health | 110 → **66** | 110 → **110** |
| **2c. warded reflect** — the *pawn* hits a warded elite with a live barrier | | |
| host health | 110 → **66**, `reflectLandedOnHost: true` | 110 → 110, `reflectLandedOnHost: false` |
| pawn health | 60 → 60, `reflectLandedOnAttacker: false` | 60 → **16**, `reflectLandedOnAttacker: true` |

Zero page errors and zero console errors in both arms.

### The fixes

- `Player._jump` — two gates, and they are not the same gate. `this.local` stops
  a remote pawn spending this client's inventory (there is one `Items` per
  client and `api.player` hard-binds the local survivor). `_replaying` stops
  one-shot *effects* firing twice — but the impulse is movement, not an effect,
  so the live pass records what it consumed against `this._cmdTick` in a
  `_jumpImpulses` map and the replay re-applies that same number. Keyed by tick,
  not a single cached value, because a rollback re-runs several unacknowledged
  commands and Updraft Vents is conditional while Tectonic Heart pays on every
  third jump — two jumps in one replay window can legitimately differ. The map
  is pruned past 128 ticks. The payload now carries `player: this`.
  `Items.js:178` is the only `jump` listener in the tree (re-grepped), so gating
  at the emit closes it without touching the content fixer's file.
- `Combat.applyDamage` — `target.isPlayer` → `target === ctx.player` on both
  `shieldBroken` and `playerHurt`, and both payloads now carry `target`. The
  pattern was already in the tree at `Profile._onDamage`; three call sites had
  not adopted it.
- `Director` warded reflect — `const p = ctx.player` → `const p = e.source`. The
  reflect pays back whoever landed the hit; `e.source` is already known to be a
  player from the guard above it.

---

## 3. MAJOR — barrier-absorbed damage counted as damage taken

`Progression.js` now reads `e.toHealth ?? e.amount`, and guards the defending
branch on the local survivor (a remote pawn is `isPlayer`, and a teammate's
blood is not this run's — the round-3 critique's informational note 4).

`probeCoop-*.json` → `barrierAccounting`, a 50-damage hit into a 1000-point
barrier:

| | BEFORE | AFTER |
|---|---|---|
| health | 110 → 110 | 110 → 110 |
| shield | 1000 → 950 | 1000 → 950 |
| `Progression.stats.damageTaken` | **+50** | **+0** |
| `Profile.run.damageTakenThisStage` | +50 | **+50** |

### The `Profile` half is genuinely required, and it is not mine

The brief said to report rather than edit if the `Profile` side is genuinely
required. **It is.** `flawlessStages` — the whole of both the `untouchable` and
`ironclad` challenges — is incremented from
`Profile.js:1205` (`if (run.damageTakenThisStage <= 0) run.flawlessStages++`),
and that counter is written at `Profile.js:1276` from `num(e?.amount, 0)`. My
`Progression` fix corrects the run summary and nothing else; **the two
challenges remain unachievable for any player holding a barrier item until
`Profile._onDamage` is changed.** Measured above at +50 on the current tree,
which already contains the Profile fixer's in-progress edits.

The one-line shape, for whoever owns it — note `Profile.js:1269`'s
`if (amount <= 0) return;` sits above both branches and must not swallow the
attacking side, which legitimately wants `incoming`:

```js
const taken = num(e?.toHealth ?? e?.amount, 0);
if (e?.target?.isPlayer) {
  if (taken <= 0) return;              // a barrier-only hit is not damage taken
  run.damageTaken += taken;
  run.damageTakenThisStage += taken;
  this.data.stats.damageTaken += taken;
}
```

---

## 4. MINOR — the uncapped impulse tunnelling a thin prop

Fixed at the solver, **not** with the suggested `MAX_IMPULSE ≈ 30` clamp. A cap
at three stacks would have re-broken §1 as a design failure the moment it was
fixed as a physics one: every stack past the third would buy nothing again.
Moving the prop depenetration inside the sub-step loop makes the solver service
the speed instead.

`probeA-*.json` → `tunnelling`, driven straight at the thinnest cylinder whose
vertical span actually overlaps a standing capsule (r = 0.225 m at 24.3, 56.4,
one of 315):

| speed | m/step | crossed the prop BEFORE | AFTER |
|---|---|---|---|
| 10 | 0.167 | no | no |
| 20 | 0.333 | no | no |
| 40 | 0.667 | no | no |
| **80** | **1.333** | **YES** | **no** |
| 110 | 1.833 | no | no |
| 160 | 2.667 | no | no |
| 240 | 4.000 | no | no |
| 400 | 6.667 | no | no |

`penetratedSteps: 0` at every speed in the after arm. Both ends stated: the
crossing that existed at 80 m/s is gone, and nothing new appears up to 400 m/s
(6.67 m a step — past `SWEEP_MAX × SWEEP_STEP = 4.8 m`, so the sweep is
saturated there and it still holds, because the terrain half stops it first).

---

## 5. MINOR — `speedMultiplier` returning a literal 0 for freeze

`Combat.js`: `if (s.type === 'freeze') return entity?.isPlayer ? 0.15 : 0;`
A hard zero is the point on a monster. On a player it is a total movement lock
with no duration readout and no counterplay, and it skipped the `Math.max(0.25,
…)` floor every other status obeys.

`probeSlow-after.json` → `statusFloor`, both ends:

| | value |
|---|---|
| player, clean | 1.0000 |
| player, `slow` ×1 | 0.6000 |
| player, `slow` ×4 | 0.2500 (the floor) |
| **player, `freeze`** | **0.1500** (was a hard 0) |
| **enemy, `freeze`** | **0.0000** (unchanged — the stop is still a stop) |
| enemy, `slow` ×4 | 0.2500 |

Still unreachable from shipping enemy data, as round 3 and the critique both
established by grep. Latent, and now guarded.

---

## 6. MAJOR — the slowed burrower. NOT FIXED, and declined with reason

The round-3 critique's own frozen-enemy instrument failed its sanity check (a
slowed enemy travelled further than a clean one) and it correctly disqualified
itself. The brief told me to build my own and sanity-check it before trusting
it. **I built two, and both failed the same gate, so I am reporting nothing off
them.**

- **Instrument 1** (distance to a reachable target) reproduced the round-3
  failure exactly, for the reason that failure exists: an enemy that *arrives*
  stops moving, so the clean arm stops early and the ratio measures arrival.
- **Instrument 2** (`probeSlow-after.json`) put the player on a treadmill —
  re-parked every fixed step at a constant 25 m offset on a fixed bearing, so
  neither arm ever arrives — and accumulated path length and dwell time per FSM
  state. It **still fails**: `beetle` in `chase` reads
  `clean 2.869, slow×1 3.115` — ratio **1.086**, a slowed unit outrunning a
  clean one, which is impossible. `burrower` in `chase` reads the same shape
  (1.052). The cause is that `chase` is not a straight line: separation,
  obstacle avoidance and the stall-unstick swing put the two arms on different
  paths over different terrain, and path length stops being a proxy for speed.
- **And it never reached the state under test.** Over 20 simulation seconds at
  25 m — inside `erupt`'s 30 m range — the burrower entered only `chase` and
  `reposition`. **I have no measurement of the burrow integration at all.**

What I can offer is a code reading and a hypothesis, both explicitly unproven:
`Enemy.js:695` scales the submerged integration correctly
(`s = (def.burrowSpeed || moveSpeed * 2) * slow`, with the direction normalised
so `seek`'s magnitude cannot contaminate it), and I could not find a scaling
error by reading. The likeliest source of 0.699 / 0.397 against 0.600 / 0.250 is
`Enemy.js:1481-1482` — `const close = e.distToPlayer < 2.5;` ends the submerged
state early — so a **clean** burrower reaches the player and surfaces sooner
than a slowed one, travels less in the window, and inflates the slowed/clean
ratio. That is the arrival artifact again, one state deeper, and if it is right
the burrow is on contract and the measurement is not. **I could not prove it,
so I did not act on it.** This defect is open.

---

## Arms I did not test

Named, per the round's rule.

1. **The burrow, at all** — §6. No measurement, in either build.
2. **A real client-side rollback.** §2b drives `applyCommand` at the same tick
   twice from an identical restored state, which is the mechanism
   `NetClient._reconcile` uses, but I did not force a genuine host correction
   (`err >= 0.02` with a real snapshot divergence) and watch the trajectory
   reconverge. The impulse now re-applies on replay; whether the reconverged
   position is *identical* rather than merely non-divergent is untested.
3. **More than two peers.** One host, one client. `Items` cross-talk with two
   simultaneous pawns, and Tectonic Heart's tally under two peers jumping
   alternately, are unmeasured — though the `this.local` gate makes pawn count
   irrelevant by construction.
4. **The `jump` payload's new `player` field has no consumer.** `Items.js:178`
   is the only listener and it is the content fixer's file; I gated at the emit
   instead. If anyone later adds a second `jump` listener, it must read
   `e.player`.
5. **Enemies through the new sweep.** Every capsule in the game uses
   `capsuleResolve`, and I measured the player exhaustively and enemies not at
   all. Flyers in particular are permanently `airborne` by the new test, so they
   now pass the relaxed clause always. The step-up allowance is unchanged, so
   nothing they could not already enter has opened, but I did not drive a flyer
   at a cliff.
6. **Performance of the sweep.** `n` is 1 below ~18 m/s so the common case is
   unchanged by construction, and the capture's `perf` block is intact — but I
   did not profile a fight with many fast-moving entities.
7. **The reflect against a *dead* attacker.** `const p = e.source` is guarded on
   `p.alive`, read not driven.
8. **Two live engines in one browser** crashes SwiftShader on this machine, so
   no co-op measurement here ran with both simulations free-running; see §2.

## Declined

- **An impulse cap** (§4). Fixed at the solver instead; a cap at 30 would
  re-break §1 by design.
- **Touching `Profile.js`, `Items.js`, `Engine.js`** — not mine. The `Profile`
  half of defect 3 is escalated in §3 with the exact edit and the reason it is
  load-bearing rather than cosmetic.
- **`Items.applyImpulse`** — the brief calls it `Math.max`; on this tree at
  `Items.js:745` it reads `this._pendingImpulse += speed`. Either way it is the
  content fixer's, and I did not work around it.
