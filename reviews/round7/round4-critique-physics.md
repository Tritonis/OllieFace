# Round 4 critique — physics, co-op, cross-cutting correctness
## Whole-branch review of `round7/content-and-polish` @ `a43cc70`

Final critic round. `RUBRIC.md` caps this project at four; there is no round 5.
This document is also the whole-branch merge review.

Raw data for everything below is on disk under `reviews/round7/r5-physics/`.
Nothing in `src/` was modified. Every probe script was deleted after use; the
JSON it produced was not.

**Headline:** the round-4 physics work is sound and its containment story is
*better* than it claimed. One of its headline metrics is a tautology and must be
struck. The burrower defect it declined is now settled — the contract is
honoured — but settling it turned up a shipping enemy that ignores `freeze`
outright. All nine co-op claims reproduce exactly. Co-op is nonetheless where
the risk lives: one **critical** defect nobody reached, one **regression this
branch introduced**, and two pre-existing MAJOR holes in the co-op damage and
scoring loops that seven rounds never opened.

| severity | count | items |
|---|---|---|
| CRITICAL | 1 | F-6 |
| MAJOR | 6 | F-1, F-2, F-3, F-7, F-9, F-10 |
| MINOR | 4 | F-4, F-5, F-8, F-11 |

---

## 0. Methodology, and the gate that makes the rest of it admissible

### The engine double-loop

The round asked me to treat inherited numbers as suspect because `Engine.start`
re-armed its rAF before `_frame`, so a `stop()`/`start()` pair inside one frame —
exactly what `Harness.freeze()`/`thaw()` does — left the old callback queued and
running alongside the new one. That is fixed in this commit by a generation
counter (`Engine.js:162-187`).

**Verified, mine.** `r5-phys7-engine-and-launch.json` → `S1_engineLoop`.
`Engine.prototype._frame` was wrapped and counted against presented rAF
callbacks after N freeze/thaw cycles:

| freeze/thaw cycles | `_loopGen` | `_frame` calls per presented frame |
|---|---|---|
| 1 | 2 | **1.000** |
| 3 | 5 | **1.000** |
| 10 | 15 | **1.000** |
| 25 | 40 | **1.000** |

Twenty-five cycles, one loop. The fix holds. (The zero-cycle row reads 0 because
the engine was stopped at that point; the rows that matter are those after a
`start()`.)

All of my own physics numbers are hand-stepped through `Player.applyCommand`
with the engine stopped, so the loop count could not have reached them either
way. The same is true of the burrower and co-op instruments.

### The instrument, and its sanity gate

Five instruments have been refuted in this project and two of those were in
round 4. So mine leads with its gate rather than its result.

To measure a before/after I needed the pre-fix solver without dirtying the tree.
I transcribed **both** `capsuleResolve` implementations into the page — the
shipped one from `Stage.js:516-660` and the pre-fix one from `ac85d85` — and
required the *shipped* transcription to reproduce the real `Stage.capsuleResolve`
**bit for bit** over long trajectories. If the new transcription is exact, the
old one built from the same parts is trustworthy.

**Gate result** (`r5-phys.json` → `gate`, `r5-phys2.json` → `gate`):

| | value |
|---|---|
| samples (position × vertical velocity × speed × heading × 60 steps) | 12,960 and 15,120 |
| max position/velocity divergence, my `resolveNew` vs shipped | **0.000000000** (exactly zero) |
| max divergence, my `resolveOld` vs shipped | 81.289 m (they are genuinely different solvers) |

**PASSES.** Every before/after number below rests on it.

### Where my own instruments failed, stated rather than buried

Three of mine failed and I am reporting that instead of their numbers.

1. **"Max ground height stood on over a long jump-spam" is not a climb
   measurement.** Probe 2 gave the new solver +20.8 m over the old at one steep
   site. Probe 3 traced it: the arms simply walked to different places — the old
   arm was circling a plateau at (−56, −36) y ≈ 23.8, the new arm had reached the
   map corner at (104, −104) y ≈ 42.4. It compares destinations, not capability.
   **The round-4 report's "+4.4 m max ground height on long wall-runs" has this
   exact defect**, and so did my probe 2. Discarded.
2. **My cliff-ratchet hypothesis was wrong.** I predicted that because `airborne`
   is `_vel.y > 0` and the vertical half cancels upward velocity only when it is
   negative (`Stage.js:637`), a capsule snapped *up* onto ground would keep
   rising velocity, stay "airborne", and ratchet 0.62 m per step up any face.
   `r5-phys5-ratchet.json` → `heldJump.summary.stepsGroundedAndRising` = **0**.
   It never happens; max rise per step is 0.203 m, which is just `vy·h`.
   Hypothesis **refuted by my own data**. The mechanism does not exist.
3. **Probe 4's drift gate was mis-sized** (25 m over a 20 s run when a sprint is
   10.15 m/s) and admitted 0 of 48 runs. Re-run with bounded windows it produced
   a median +12.9 m that probe 6 then showed to be the same
   max-over-transients artifact as (1). Discarded.

The containment number I do report comes from probe 6, which uses a *stable*
metric — net ascent after a no-input coast — under identical stands, identical
input and identical duration, with the solver as the only variable.

### Build and capture

- `vite build` — **exit 0**, `✓ built in 679ms`.
- 21-shot capture, real GPU, seed 1337, port 5312, into
  `reviews/round7/r5-physics/capture/`. `ready: true`, **21/21 shots**,
  `clockPinned: true`, `frameDt 0.016666…`, `frameTimeouts: 0`.
- **`audioOk: true`**, all twelve sub-checks passing: `armed`, `graphBuilt`,
  `contextRunning`, `sequencerRunning`, `notSilenced`, `musicBusOpen`,
  `masterOpen`, `stepsAdvanced` (Δ26 against a floor of 8), `musicAudible`
  (peak 0.137), `outputAudible` (peak 0.121), `sampled` (100 samples),
  `noNewErrors`.
- **One** failing subject check, and the single console error *is* that check:
  `06-loaded-hud` / "monsters under load", object 6, `px 135`, `sepP50 0.13`
  against the 0.25 gate. `E-framing.md` §5 documents the same shot, subject and
  object index at `px 137` / `sepP50 0.17`, "separate root cause, pre-existing,
  not fixed". **Unchanged in kind. Not chased**, per the round's instruction.
  Capture exit code 1 is wholly attributable to it.
- Four `toleratedAbsences` recorded (`04-combat`, `06-loaded-hud`,
  `08-explosion`, `10-inventory`), all pre-existing crowd-gate carries.

---

## 1. Verification table — round 4's claims

| # | Round-4 claim | Verdict | My measurement |
|---|---|---|---|
| 1a | Sub-stepping + `_airClear` cuts mid-air annihilation of the launch | **CONFIRMED** (direction and magnitude) | 492-sample gated before/after: 12 stacks **17.9 % → 3.0 %**; 6 stacks 12.2 % → 3.0 %; 3 stacks 7.7 % → 1.6 %; 0 stacks 2.8 % → 1.0 % |
| 1b | "Terrain-attributed zeroings **181 → 0** at every stack 0–12" | **REFUTED as stated — the metric is a tautology** | §2 |
| 1c | mid-air zeroing 54.5 % → 13.0 % at 12 stacks | **NOT REPRODUCED** — direction confirmed; the absolute figures are a property of the stand list, not the build. Mine: 17.9 % → 3.0 % |
| 1d | launch is exactly `10.15 + 10n` | **CONFIRMED on clean corridors, unrepresentative in general** — over a random-stand population only **75.0 %** of 12-stack launches read the printed number | §3 |
| 2a | containment: 0 steps below the floor | **CONFIRMED — and structurally guaranteed** | 0 across 240,000 jump-spam steps, 48 controlled runs, and an extreme sweep to 800 m/s. `Stage.js:635-636` makes it unfailable |
| 2b | containment: 0 steps outside the bound, 0.0000 overshoot | **CONFIRMED — and structurally guaranteed** | same; `Stage.js:591-592` clamps inside the sweep loop |
| 2c | "+4.4 m max ground height on long wall-runs" — their one honest delta | **REFUTED as a measurement** | controlled, 12 faces at 82–84°, 10 s and 60 s: net-ascent delta **min −0.062 m, median 0.000 m, max +0.055 m** |
| 3 | barrier-absorbed damage no longer counted in `Progression` | **CONFIRMED** | `Progression.js:155` reads `e.toHealth ?? e.amount`; `Combat.js:473` really does emit `toHealth`, so the fix is not vacuous |
| 3b | "the `Profile` half is required; the two challenges stay unachievable" | **SUPERSEDED — now fixed on this branch** | `Profile.js:1365` reads `num(e?.toHealth ?? e?.amount, 0)`, guarded at 1366. The escalation is closed |
| 4 | prop tunnelling fixed at the solver, clean to 400 m/s | **CONFIRMED and extended to 800 m/s** | 0 under-floor, 0 OOB, 0 overshoot at 110/160/240/400/800 m/s at the bound and at the steepest face |
| 5 | `speedMultiplier` freeze → 0.15 player / 0 enemy | **CONFIRMED** | enemy multipliers measured 1.000 / 0.600 / 0.360 / 0.250 / 0.250 / freeze 0.000 |
| 6 | burrower slow contract — declined, unmeasured | **OVERTURNED — settled; the contract is honoured** | §5 |
| 2a–2c, 3 (co-op) | nine numbered co-op measurements | **9 / 9 CONFIRMED** | §7 |
| — | `Engine._loopGen` (round-4 engine fixer) | **CONFIRMED** | 1.000 `_frame` per presented frame after 25 freeze/thaw cycles |

**Score: 19 confirmed, 2 refuted, 1 not reproduced, 1 superseded.**

---

## 2. F-1 — MAJOR (reporting). "Terrain-attributed 181 → 0" is a tautology

`Stage.js:561-563`:

```js
const clear = airborne
  ? (x, z) => this._airClear(x, z, startY)
  : (x, z) => this._climbable(x, z, startY);
```

After the fix, `_climbable` **is not consulted at all for a body in the air**.
The round-4 headline metric is "how many mid-air zeroings coincided with a
`_climbable` rejection". That number is 0 by construction, at every stack count,
whether or not the fix helps anything. It measures the code change, not its
effect.

I instrumented **both** predicates and classified every zeroing by cause: same
492 samples, same stands, same headings, both solvers, gate passing
(`r5-phys2.json` → `Q1`).

| stacks | solver | zeroed mid-air | via `_climbable` | via `_airClear` terrain rise | via the map bound |
|---|---|---|---|---|---|
| 0 | old | 14 (2.8 %) | 11 | — | 3 |
| 0 | **new** | **5 (1.0 %)** | **0** | **2** | 3 |
| 3 | old | 38 (7.7 %) | 33 | — | 5 |
| 3 | **new** | **8 (1.6 %)** | **0** | **4** | 4 |
| 6 | old | 60 (12.2 %) | 54 | — | 6 |
| 6 | **new** | **15 (3.0 %)** | **0** | **10** | 5 |
| 12 | old | 88 (17.9 %) | 83 | — | 5 |
| 12 | **new** | **15 (3.0 %)** | **0** | **10** | 5 |

The honest statement of the same result is **83 → 10**, not 181 → 0. Terrain
still deletes launches; it is simply rejected by a different predicate, and that
predicate was not instrumented. The underlying improvement is real and large —
an 88 % reduction in terrain-caused annihilation at 12 stacks, 6× overall — and
it never needed overstating.

**Action:** no code change. Strike "The terrain test now deletes zero launches
at every stack count from 0 to 12" from `round4-fix-physics.md` §1 and replace it
with the measured 83 → 10, before anyone adopts that table as a regression
baseline.

---

## 3. F-2 — MAJOR (open, pre-existing). What the residual actually is

The round asked: *13 % of launches still zero at 12 stacks — find out what that
residual is.* Two answers, and the second is larger than the first.

### 3a. The mid-air residual: two thirds terrain, one third the map edge

At 12 stacks, of my 15 residual zeroings: **10 are `_airClear` rejecting terrain
genuinely above the capsule's feet**, and **5 are the map bound** (`|x| > 104` or
`|z| > 104` — `Stage.js:694` returns `false`, which annihilates the velocity
exactly as a wall does). **0 are props. 0 are `_climbable`.**

The terrain ten are legitimate and the numbers say so (`r5-phys.json` → `P1`,
12 stacks): median height above the launch point at the moment of zeroing
**2.167 m**, median terrain rise that caused the rejection **1.268 m**. The
player is two metres up and something three and a half metres above their launch
is in the way. Stopping is correct.

The five map-edge ones are correct in outcome and wrong in feel: hitting the
invisible arena boundary at 130 m/s deletes all horizontal velocity instantly,
with no wall to have seen coming.

### 3b. The residual the round-4 metric never counted: **15.2 % of 12-stack launches are clipped on the launch tick itself**

`r5-phys7-engine-and-launch.json` → `S2_launchShortfall`. "Zeroed **mid-air**"
only counts runs whose speed reaches exactly 0 while `grounded === false`. It
misses the launch being cut down on the very tick it is created — when the
capsule's feet are still at ground height and the sweep covers 2.17 m.

| stacks | samples | launch reads the printed number | run-up never reached sprint speed | **solver clipped the launch on the jump tick** | median speed lost when clipped |
|---|---|---|---|---|---|
| 0 | 492 | 442 (89.8 %) | 47 | 3 | 7.44 of 10.15 m/s |
| 12 | 492 | 369 (**75.0 %**) | 48 | **75 (15.2 %)** | **115.7 of 130.15 m/s** |

From a random walkable stand at 12 stacks, **one sprint-jump in four does not
deliver the number on the card**, and in 15 % of cases the solver removes almost
all of it inside the first 16.7 ms. This is *not* a regression — the old solver
read 77.8 % on the same metric — but it is the state the branch ships in, and it
is the honest answer to "what is the residual".

**Fix (not applied — this is a critique):** `Stage.js:587`
`if (!moved) { _vel.x = 0; _vel.z = 0; }` is the wrong response for a body in
the air at speed. Projecting velocity onto the blocking face — as the prop path
already does at `Stage.js:611-612` — would turn "launch deleted" into "launch
deflected along the rock", which is what a player expects. Separately, the bound
check inside `_airClear`/`_climbable` should be split out from the terrain check
so the arena edge can stop travel without zeroing the whole velocity vector.

### 3c. And the fix does not increase reach

Also from `Q1`, per sprint-jump, old → new:

| stacks | median travel | mean travel |
|---|---|---|
| 3 | 23.152 → 22.958 m | 23.117 → 22.965 m |
| 6 | 25.701 → 23.511 m | 34.017 → 33.568 m |
| 12 | 27.003 → **24.975 m** | 41.148 → **39.685 m** |

The fix changes *how* a launch ends, not how far it carries: sub-stepping stops
the capsule **at** the obstacle instead of teleporting it past, so median travel
is flat to slightly lower. The card feels better because it is no longer
deleted; it does not go further. Anyone reading the round-4 report's "mean jump
travel before → after" column should know the median tells the opposite story,
and the median is what a player experiences.

---

## 4. Containment — checked much harder, and clean

**Verdict: CONFIRMED CLEAN, more strongly than round 4 claimed.**

What I ran (`r5-phys.json` → `P2`/`extreme`; `r5-phys2.json` → `Q2`;
`r5-phys4.json`; `r5-phys6-ascent.json`):

- **240,000 steps** of jump-spam (40 runs × 6000 steps) at 6 programmatically
  located steepest faces plus 2 map corners, 0 and 12 stacks, `jumpCount` 1 and
  3 (stacked impulses on multi-jumps), both solvers.
- 9 further sites × 3 stack counts × 2 solvers × 900 steps at the four cliff
  walls, the four corners, and the steepest face.
- 48 bounded single-jump and five-jump runs into the 24 steepest faces.
- Extreme-speed sweep at 110 / 160 / 240 / **400 / 800** m/s driven straight at
  the bound and at the steepest face, 240 steps each.
- A 10 s and a 60 s hold-W + hold-Shift + hold-Space ascent at each of the 12
  steepest faces in the arena (82.4°–84.1°), both solvers, each followed by a
  300-step no-input coast so the slide force takes back whatever it can.

| | old | new |
|---|---|---|
| steps below the floor (all runs) | **0** | **0** |
| steps outside the bound (all runs) | **0** | **0** |
| max overshoot past the bound | 0.0000 | 0.0000 |
| under-floor / OOB at 800 m/s | 0 / 0 | 0 / 0 |
| net ascent delta, 12 steepest faces, 10 s | — | min −0.062 m, **median 0.000 m**, max +0.055 m |
| net ascent delta, 60 s | — | min −0.062 m, **median 0.000 m**, max +0.055 m |
| runs resting on unwalkable terrain | 15 / 24 | 15 / 24 |

**The fix changes containment by under six centimetres.** That is a better result
than round 4's own "+4.4 m", which I could not reproduce and which §0 shows to be
a path-divergence artifact of a free-running spam rather than a climb
measurement.

Specifically as the round asked:

- **Corners** — all four, at the bound and 12 m inside it. Clean.
- **Map edge** — the player is pressed flat against `x = ±104` / `z = ±104` in
  every wall run and never exceeds it. The clamp is inside the sweep loop, so it
  applies per sub-step, not once per frame.
- **Moving platforms** — there are none. Every `kind: 'platform'` collider
  (`Props.js:779`) is static geometry baked at stage build; the one-way catch at
  `Stage.js:624-632` is untouched by this branch.
- **Stacked impulses** — `jumpCount: 3` with the full impulse consumed on each
  jump: no under-floor, no OOB. Design note: `Player.js:648-649` *overwrites*
  horizontal velocity toward `moveSpeed` on an air jump, so a mid-launch double
  jump throws the launch away and re-buys it. Pre-existing and probably
  deliberate, but it means stacked impulses do not compound.
- **Impulse into a ceiling** — there is no ceiling geometry; prop cylinders carry
  a `y0`/`y1` span and are handled by depenetration, which now runs inside the
  sweep loop. The 800 m/s tunnelling sweep covers it: `penetratedSteps: 0`
  at every speed.
- **Pre-existing, not a regression:** a player can jump-spam up an 83° face and
  gain real height (up to +11.9 m net at face (−37, 17) over 60 s) and can come
  to rest on terrain steeper than the walk limit. **Both arms do this
  identically** — deltas of ±6 cm — so it is a property of the game as it stood
  before this branch. Worth a design ticket; not a merge blocker here.

**Sweep cost** (`r5-phys3.json` → `perfMicrosPerCall`): `capsuleResolve` costs
**2.25 µs** at `n = 1` (10 m/s) and **25.96 µs** at `n = 16` (130 m/s), 11.5×.
`n` is 1 below ~18 m/s, which covers every enemy in the game, so the common path
is unchanged; one player at 130 m/s costs 26 µs of a 16.7 ms budget. Round 4's
"I did not profile" is now covered: this is not a frame cost.

---

## 5. The burrower — SETTLED. The contract is honoured; the defect was the instrument

**Verdict: `slow` on the burrower is ON CONTRACT. The round-3 critic's
0.699 / 0.397 is an arrival artifact, and the round-4 fixer's unproven
hypothesis about `Enemy.js:1481` is now proven correct.**

Instrument: engine stopped, every fixed step driven by hand through
`enemy.fixedUpdate(ctx, 1/60)`; the measured quantity is **per-step displacement
bucketed by FSM state**, never path length; enemy *and* player are re-anchored to
fixed world points before every step, so both arms integrate from identical
positions on identical terrain at an identical bearing; `fsm.t` pinned so the
state under test cannot time out. Raw: `slow-treadmill.json`,
`slow-artifact-and-paths.json`, `slow-dive-ramp-reach.json`,
`slow-live-dive-and-lunge.json`, `slow-SETTLED-summary.json`.

**All four sanity gates pass:**

| gate | result |
|---|---|
| identity (clean vs clean) | SUBMERGED **1.000000**, CHASE burrower **1.000000**, CHASE beetle **1.000000** |
| monotonicity | SUBMERGED 11.500 / 6.900 / 4.140 / 2.875 / 0.000 m/s; CHASE 5.200 / 3.120 / 1.872 / 1.300 / 0.000. No slowed unit ever outruns a clean one |
| analytic (`burrowSpeed · slow · h`) | expected 0.1916666667 / 0.115 / 0.069 / 0.0479166667 m per step; measured identical, worst relative error **6.96 × 10⁻⁹** |
| the multiplier itself | `speedMultiplier(burrower)` = 1.000 / 0.600 / 0.360 / 0.250 / 0.250 / freeze 0.000 — exactly the contract |

Measured ratios, per step: **SUBMERGED 0.600 / 0.360 / 0.250 / 0.000**;
**CHASE 0.600 / 0.360 / 0.250 / 0.000**; cross-checked on `beetle`, 0.600 / 0.250.

I verified the mechanism at source myself. `Enemy.js:695-698`:

```js
const s = (def.burrowSpeed || this.moveSpeed * 2) * slow;
const len = Math.hypot(d.x, d.z) || 1;
this.position.x += (d.x / len) * s * h;
this.position.z += (d.z / len) * s * h;
```

`d` is normalised before use, so the seek magnitude cannot contaminate it and
per-step displacement is exactly `burrowSpeed · slow · h`. **The contract is
satisfied by construction.**

**The artifact, proven live.** Player parked at 12 m: the clean burrower is cut
off by `Enemy.js:1481`'s `close = e.distToPlayer < 2.5` after 0.85 s having
travelled 9.583 m, while slow ×1 runs the full 1.400 s and travels 9.545 m —
**path-length ratio 0.996** against a true speed ratio of 0.605. At 30 m, where
neither arm can arrive, path length returns to 0.600. Round 3's numbers were
reproduced on this build with round 3's instrument shape (20 s free run, player
at 25 m → **0.680 / 0.459** against their 0.699 / 0.397) while the same build
measures 0.600 / 0.250 per step. The clean arm ends inside the burrower's 18 m
stand-off ring, where `arrive` damps it, so its path length understates its own
capability.

**Why round 4 never reached `SUBMERGED`:** `chooseAttack` (`Enemy.js:814`)
requires `hasLOS`, a real raycast. At the 25 m they parked the player at, the
burrower had line of sight **0.1 %** of 30 simulated seconds and never submerged.
At 12 m it has LOS 41.3 % and submerges within 1.1 s. Instrument siting, not a
product bug — but it is the second time in this project that standing in one
place produced a certified non-result.

Round 4's decision to decline was **correct given their evidence**. Their
hypothesis was right, and it is now proven.

---

## 6. New defects in the enemy movement layer

### F-3 — MAJOR. A committed flyer dive ignores `slow` **and** `freeze` entirely

`src/entities/Enemy.js:781-782`:

```js
} else if (this.diving) {
  this.position.addScaledVector(this.velocity, h);
```

The `slow` scalar computed at `Enemy.js:679` lands on the desired vector `d` at
line 764 and on the clamp at 765. This branch integrates `this.velocity`, which
is set once and unslowed in the `dive` case (`Enemy.js:885-889`,
`_v2.normalize().multiplyScalar(a.diveSpeed); this.velocity.copy(_v2);`) and
passes through neither. I confirmed both lines at source. The comment at
`Enemy.js:674-675` — "burrow return before that point and are scaled where they
integrate" — shows the author believed every path was covered. This one is the
gap.

**Reproduction.** Anchored rig, identical injected state in all arms, 30
hand-stepped fixed steps: clean, slow ×1, slow ×4 and **freeze** all travel
**8.500 m at 17.000 m/s — ratio 1.000** against contracted 0.600 / 0.250 / 0.000.
Live and unforced: a Blind Shrike picks its own dive at 11 m, freeze applied on
the commit step — `speedMultiplier` reads **0.000** for all 45 steps of the dive
and it still travels **6.709 m at a rock-constant 8.946 m/s** (clean arm 6.743 m,
8.990 m/s, same 45 steps).

**Why it matters.** The Blind Shrike is shipping tier-1 content,
`selectionWeight 0.7`, `suicide: true`. Frost Lattice, Hoarfrost Band,
Concussion Charge, Grapnel Tether and the Aegis Emitter dome all fail to so much
as *slow* — let alone freeze — a committed Shrike for the whole ~1.1 s / ~18 m
dive, which is precisely the window those cards are bought for. A freeze that
does not stop the thing diving at you is the worst possible failure mode for a
defensive item: it reads as the item being broken.

**Fix:** `this.position.addScaledVector(this.velocity, h * slow);` — `slow` is
already in scope and is already 1 for a dying unit, so the deliberate corpse
exemption at `Enemy.js:676-678` is preserved. Scaling the step rather than the
stored velocity keeps heading and speed intact for contact and recovery.

### F-4 — MINOR. The melee lunge impulse is unslowed

`src/entities/Enemy.js:871-872`:

```js
this.velocity.x += dir.x * (a.lunge || 0);
this.velocity.z += dir.z * (a.lunge || 0);
```

Velocity immediately after the impulse is **6.000 in all four arms**, freeze
included. Over the following 0.5 s the path is 2.506 / 1.788 / 1.088 / 0.643 m →
ratios **0.713 / 0.434 / 0.257** against 0.600 / 0.250 / 0.000; the first three
step speeds are identical in every arm (5.584, 5.206, 4.876 m/s). A slow ×4
burrower peaks at 5.58 m/s against its own slowed clamp of 2.47 m/s — a **2.26×
breach of the clamp** — with 0.461 m of excess travel, 0.643 m under freeze.

**Fix:** `const k = (a.lunge || 0) * (ctx.combat?.speedMultiplier?.(this) ?? 1);`
applied on both axes; `fireAttack` already takes `ctx`. If the lunge is *meant*
to be exempt as attack follow-through, mark it so at `Enemy.js:870` the way the
DIE exemption is marked at 675-678 — nothing currently says it is intentional.

### F-5 — MINOR. `S.CHARGE` writes an unslowed velocity that is immediately overwritten

`Enemy.js:1424` sets `e.velocity` without the `slow` scalar, but
`Enemy.js:687-688` overwrites it with the slow-scaled desired vector on the same
step. Measured over a Ridgeback Charger's full 69-step active window:
29.611 / 17.764 / 7.397 m → **0.5999 / 0.2498**. On contract; the line is a dead
assignment. Cosmetic — but it is exactly the kind of dead write that becomes a
live bug the next time the ordering changes.

---

## 7. Co-op — the arm nobody tested for seven rounds

**Every round-4 co-op claim reproduces.** An independent two-peer session was
built from scratch, with a build gate proving each arm really was the arm it
claimed (`gates.build.jumpGatesOnLocal` false in the before arm, true in the
after arm; `substitutedModules` naming the four files swapped for the baseline;
`buildMatchesArm: true` on both). **The correct baseline is `b18a2b4`, not
`ac85d85`:** the ungated `jump` emit was added in `b18a2b4`, so `ac85d85` has no
jump emit at all and comparing against it would have measured the wrong change. Raw: `coop-claims-before.json`,
`coop-claims-after.json`, `coop-hunt1-after.json`, `coop-hunt2-after.json`,
`coop-live-d3d11.json`, `coop-diag-impulse.json`, `coop-SUMMARY.json`,
`coop-hunt3-before-drained.json`, `coop-hunt3-after-drained.json`.

Session reality: `hostClients 1`, `hostAuthority true`, `hostHasPawn true`,
`pawnIsLocal false`, `pawnIsPlayer true`, `pawnIsCtxPlayer false`,
`clientAuthority false`. Sanity gate before every measurement: host and client
at rest diverge **0.000** over 30 ticks with 0 replayed reconciles
(`restGate.PASS: true`).

| claim | round 4 said | I measured | verdict |
|---|---|---|---|
| host shield from a **peer's** jump | 0→55 ⇒ 0→0 | **0→55 ⇒ 0→0** | CONFIRMED |
| `jump` events on the host's bus | 6 ⇒ 0 | **6 ⇒ 0** | CONFIRMED |
| host `consumeImpulse` calls | [30,30,36,30,30,36] ⇒ [] | **[30,30,36,30,30,36] ⇒ []** | CONFIRMED |
| pawn peak horizontal speed | 36 ⇒ 0 | **35.89 ⇒ 0** | CONFIRMED |
| client replay divergence | 30.000 ⇒ 0.000 | **30 ⇒ 0** (live hs 30 in both arms; replay hs 0 ⇒ 30) | CONFIRMED |
| local `playerHurt` from a teammate's damage | 2 ⇒ 0 | **2 ⇒ 0** | CONFIRMED |
| local `timeSinceHurt` | 30→0 ⇒ 30→30 | **30→0 ⇒ 30→30** | CONFIRMED |
| warded reflect | host 110→66 / pawn 60→60 ⇒ host 110→110 / pawn 60→16 | **identical**; `reflectLandedOnAttacker` false ⇒ true | CONFIRMED |
| `Progression.stats.damageTaken` into a barrier | +50 ⇒ +0 | **+50 ⇒ +0** | CONFIRMED |
| *(control)* host's **own** jump still pays its items | implied | shield rises, 1 `jump` event, 1 non-zero `consumeImpulse`, hs 30 | CONFIRMED — the gate did not over-fire |

Nine for nine, plus a control showing the gate is not too wide. The round-4
co-op work is real and correctly measured. Everything below is what it did
**not** cover.

### F-6 — CRITICAL. Joining a co-op game locks the client out of its own abilities for as long as it played single-player first

`src/entities/Player.js:418`:

```js
const replay = c.tick > 0 && c.tick <= this._lastCmdTick;
```

`_lastCmdTick` is the highest command tick this pawn has ever simulated. In
single-player — or sitting on the title screen, which still steps — it climbs
with wall time. `NetClient`'s tick counter starts again at **0** on join. So
every command for the first `_lastCmdTick` ticks after joining satisfies the
predicate and is classified as a **replay**.

**Reproduction** (`coop-hunt2-after.json` → `replayLock`): idle to
`localTick 512`, then join — `netTick 0`, `playerLastCmdTick 512`. Of the first
40 ticks pumped, **40 were classified as replay**, with
`remainingLockedTicks: 472`. Past tick 517 the lock clears
(`stillLocked: false`), confirming the mechanism exactly.

Reproduced in **both** arms, so the lock itself pre-dates this branch:
`lockedTicksAtJoin` **312** (before) and **313** (after), **5.2 s** at 60 Hz
(`coop-hunt3-*-drained.json` → `lockVerdict`).

What `_replaying` actually gates, verified at source rather than inferred:

| line | skipped while `replay` | consequence during the lock |
|---|---|---|
| `Player.js:428` | `this._runSchedule(dt)` | scheduled and delayed ability volleys never execute |
| `Player.js:451-453` | `projectiles.fixedUpdate` | **projectiles that are fired do not move or collide** |
| `Player.js:451-453` | `placeables.fixedUpdate` | turrets, mines and drones do not tick |
| `Player.js:651` | air-jump `vfx.impact` | no double-jump feedback |
| `Player.js:660` | `audio.footstep` | no footsteps |
| `Player.js:702-708` | **new on this branch** | the Waxed Wing / Updraft Vents / Tectonic Heart impulse reads `_jumpImpulses`, finds it empty, and applies 0 |

**Instrument note, stated rather than buried.** The probe's attempt to
demonstrate projectile suppression live **failed its own control**: the
past-lock arm recorded `liveProjectiles: 0, spawnCalls: 0` as well as the
inside-lock arm, so that run proves nothing either way. The table above is
therefore **confirmed by source and by the measured 40/40 and 90/90 replay
classification**, not by a live firing demonstration. Note also that spawning
happens in `_abilities`, which is *not* gated — so the accurate statement is
that a joining client's shots **spawn and then hang motionless**, not that they
cannot be fired.

So a player who joins a friend's game after five seconds of menu spends the next
five seconds with dead projectiles, dead placeables, no scheduled volleys and no
movement items. After ten minutes of single-player first, it is ten minutes.
Co-op is a front-page menu item (`Menus.js:158`, "Co-op — host or join"), so
this is the first thirty seconds of the co-op experience.

The classifier bug pre-dates this branch. **The round-4 fix widened its blast
radius** by making movement — the jump impulse — depend on `_replaying` too;
before, only one-shot effects did.

**Fix:** reset the epoch when the tick origin changes. Either set
`this._lastCmdTick = 0` on the `netRole` transition into `'client'` (or in
`setNetState`, which already runs at join), or treat a large backwards jump as a
new epoch rather than a replay:

```js
const replay = c.tick > 0 && c.tick <= this._lastCmdTick
            && this._lastCmdTick - c.tick < 256;
```

The first is the correct fix; the second is the safe one-liner.

### F-7 — MAJOR. A client's item jump-impulses have no authority, so the host erases every launch

The `this.local` gate at `Player.js:701` is right as far as it goes — a remote
pawn must not spend this client's inventory. But no other path carries the
impulse into the authoritative simulation: `Items` is per-client, the host has no
model of a peer's inventory, and the host simulates the pawn with
`local === false`. So the host's pawn never launches.

**Reproduction** (`coop-hunt2-after.json` → `realReconcileWithJump`; settle gate
`maxDivergence 0`, PASS): client holds Waxed Wing ×3 and jumps.
`clientSelfPeakHs` **30**, `hostPawnPeakHs` **0**, `maxDivergence 6.013 m`,
71 reconciles of which 40 replayed, `maxErr 0.506`, **`maxYank 2.181 m`**. The
correction trace shows the launch being strangled:

| acked tick | client horizontal speed, before → after correction | yank |
|---|---|---|
| 528 | 28.72 → 27.43 | 1.22 m |
| 529 | 27.32 → **15.50** | 1.60 m |
| 530 | 14.07 → **8.83** | 2.18 m |
| 531 | 7.40 → 4.80 | 1.36 m |
| 533 | 1.97 → **0** | 0.65 m |

Thirty metres per second to zero in five snapshots, about 0.3 s. It stays below
`SNAP_THRESHOLD`, so it is smoothed into the render offset rather than a
teleport — which is exactly why it will read as *the item not working* rather
than as lag. **In co-op, for a client, Waxed Wing, Updraft Vents and Tectonic
Heart's impulse are inert.** Divergence at rest is 0.000, so this is entirely
the impulse.

**And it is a regression, resting on a premise that does not hold in this
codebase.** The fix's stated reasoning is "a pawn is somebody else's inventory;
it cannot spend ours". That is not how `Items` works here: **a client's
inventory is a mirror of the host's.** `Items.js:251-252` — `give()` returns
early unless `ctx.authority` — and `Items.js:211-215` rebuilds the client's
counts from the replicated `itemPickup`. Both ends hold identical stacks; the
session recorded `host {wax 3, soles 1, tect 1}` and `clientMirror {wax 3,
soles 1, tect 1}`.

So before the fix both ends computed the **same** impulse and agreed exactly.
Draining the host's input queue each tick so that only the solver differs
(`coop-hunt3-before-drained.json` / `coop-hunt3-after-drained.json`, settle gate
`settleGateMax 0` on both):

| | host pawn peak | client peak | max divergence | tail |
|---|---|---|---|---|
| **before** | **30 m/s** | 30 m/s | **0.0000 m** | 0.0000 |
| **after** | **0** | 30 m/s | 0.500 m | 0.014 m |

Zero divergence before, half a metre after — six metres once the product's own
lag is present. **This branch introduced it.**

**What this is not.** It is not a permanent desync: the tail settles to
0.0091–0.014 m, one snapshot quantum (`1/64 = 0.0156 m`). Reconciliation
converges cleanly, and that is a good netcode result worth saying plainly. The
defect is that it converges onto a trajectory in which the item never fired.

**Fix — and it is small.** The two halves of the gate are not the same gate,
and only one belongs behind `this.local`:

- the **`jump` emit** must stay gated — that is what stopped the host paying a
  peer's Rubber Soles barrier and detonating Tectonic Heart at its own feet, and
  my measurements confirm that half is correct;
- the **impulse application** must not be — because the inventories are mirrors,
  the host can consume and apply the same impulse for the pawn and both ends
  agree, exactly as they did before the fix.

No protocol change is required. If the mirror is ever weakened, carry the
consumed impulse on the input command (already recorded per tick in
`_jumpImpulses`) with a server-side clamp.

### F-8 — MINOR. `MAX_INPUT_BACKLOG` silently eats the oldest inputs, jump included

`src/net/NetHost.js:127`. Reproduced exactly (`coop-hunt1-after.json` →
`inputBacklog`): a 25-command burst leaves a backlog of 12; **13 commands are
dropped (ticks 72–84)**; the jump was on tick 72; `jumpTickApplied: false`;
`jumpBearingCommandsQueued: 0`.

**My verdict: acceptable design, unacceptable silence.** Dropping the *oldest* is
the right choice — the alternative lets a client act in the past — and
`NetHost.js:21-23` says so. But the comment describes a *client* that has
fallen behind while the code implements a *host* catch-up policy that discards
without resyncing anything. `Engine.js` clamps both ends to `MAX_SUBSTEPS = 5`,
so a client cannot burst from its own throttling — the reachable trigger is
**host-side**: a hitch below ~48 effective steps/s builds the queue at 12/s, and
a **backgrounded host** (rAF halts, so it consumes nothing) discards everything
the peer did except the newest 12. Alt-tabbing the host is an everyday action.
Symptom: silently lost jumps and dodges plus a snap-back — not a permanent
desync, since the client's history still holds the acked tick and `_reconcile`
converges. **Fix:** drain up to 2 commands per tick above a small target buffer,
or at minimum OR the dropped button bits into the next applied command — and
count the drops.

### F-9 — MAJOR. The `damageDealt` branch beside the fix was left unguarded

`src/systems/Progression.js:145-148`:

```js
if (e.source?.isPlayer) {
  this.stats.damageDealt += e.amount;
  if (e.amount > this.stats.highestHit) this.stats.highestHit = e.amount;
} else if (e.target?.isPlayer) {
  ...  if (!ctx.player || e.target === ctx.player) {   // <- the round-4 guard
```

Round 4 added the local-survivor guard to the *defending* branch and left the
*attacking* branch three lines above it untouched. `isPlayer` is true of every
remote pawn, so a teammate's hits are credited to this run. **Measured:** a 777
hit whose `source` is the remote pawn gives `damageDealt +777` and
`highestHit 200 → 777`, **identical in both arms** — so it is pre-existing, but
it sits in the file round 4 edited and it makes the run summary and the
"highest hit" record wrong for every co-op player.

**Fix:** `if (e.source?.isPlayer && (!ctx.player || e.source === ctx.player))`,
matching the guard already on the branch below.

### F-10 — MAJOR. A co-op client never receives damage feedback at all, so every `onDamaged` item is dead for it

Three lines, all confirmed at source:

- `Combat.js:382` — `if (!ctx.authority) return 0;` — a client never resolves
  damage locally.
- `NetHost.js:57-59` — the forwarded-event list is `kill`, `itemPickup`,
  `goldChanged`, `teleporterCharging`, `teleporterComplete`, `stageStart`,
  `bossSpawn`, `bossDead`, `playerDead`, `levelUp`, `realmEnter`, `realmExit`.
  **`playerHurt` and `shieldBroken` are not on it.**
- `Items.js:205` — `ctx.events.on('playerHurt', ...)` is the only writer of
  `_lastHurt`.

So on a client `_lastHurt` never moves. **Measured on a live client after the
host had resolved damage against it: `timeSinceHurt()` reads 1000.52** — still
the `-999` sentinel. Field Dressing, Siege Battery and Mineral Lick are
permanently "not hit in ages" for every non-host player, and every `onDamaged`
hook is dead for them.

This is **architectural and pre-existing** — round 4's
`target.isPlayer → target === ctx.player` change is correct and does not cause
it. But it means the co-op damage loop has a hole nobody has looked at, and it
is wider than anything round 4 touched.

**Fix:** forward `playerHurt` and `shieldBroken` on the `NetHost` list, filtered
to the receiving peer, and dispatch `onDamaged` locally from the forwarded event.

### F-11 — MINOR. A joining peer's pawn is placed 35.8 m from where that client thinks it is

`src/net/Coop.js:52-55` parks the new pawn at `ctx.player.position + (2, ·, 2)`.
On the client, `ctx.player` is its own survivor, wherever its regenerated stage
put it. **Measured gap: 35.811 m** — past `SNAP_THRESHOLD`, so it reads as a
teleport on the first snapshot rather than a lasting desync. (I had filed this
as clean on the strength of "not stacked"; the gap is the defect, not the
overlap.)

### Checked and clean in co-op

- **Three peers.** `maxPlayers: 4`, so this is in-protocol. Two clients + host,
  `clients 2`, `pawns 2`, `playerCount 3`: `hostShield 0`, `hostJumpEvents 0`,
  **`tectonicTallyFires 0`**, `hostConsumeCallsNonZero []`,
  `pawnJumpsUsed [1,1]`, `hostJumpsUsed 0`. The `this.local` gate makes pawn
  count irrelevant exactly as claimed, and Tectonic Heart's every-third-jump
  tally is not polluted.
- **Peer leaves.** `clients 2→1`, `pawns 2→1`, `combatEntities 3→2`, no throw,
  **0 orphaned player entities in combat**, `frameErrors 0`.
- **Join mid-stage.** Host at `stageIndex 3`, `time 1.52`; the joining client
  lands on `stageIndex 3`, `seed 1337`, `time 1.52`, `netId 28`, `error: null`.
  Placement gap between joiner and host pawn 35.8 m — not stacked.
- **`_jumpImpulses` does not leak.** 4000 monotonic jumps → map size **106**;
  2000 jumps across a tick reset → **102**. Bounded by the 128-tick prune as
  designed.
- **Reconciliation at rest** diverges 0.000 with 0 replays and `maxErr 0.0108`,
  under the 0.02 threshold.
- **Zero host and client console errors** in both hunt sessions. One
  `AudioParam ... non-finite` error appeared on the client in the claims session
  only; it did not recur in either hunt session and did not appear in the 21-shot
  capture, so I record it as **unreproduced**, not as a defect.
- **Two live engines — the round-4 concession is REFUTED.** Two free-running
  engines in one headed chromium (`--use-angle=d3d11`) ran 20 s with **0 page
  errors, 0 console errors, 0 `frameErrors`, 0 `webglcontextlost` and no
  renderer crash** (`coop-live-d3d11.json`). "Two live SwiftShader sessions in
  one browser crashed the renderer" is a property of SwiftShader on that
  machine, not of the product. Measurements here still used frozen engines and
  hand-pumped `fixedUpdate` — for determinism, not necessity — and every figure
  is an event count, a boolean or a hand-stepped displacement, so loop
  multiplicity cannot reach any of them.

---

## 8. Checked and clean — cross-cutting

- `Combat.js:473` really does emit `toHealth`, so `Progression.js:155`'s
  `e.toHealth ?? e.amount` is not silently falling through to `amount`. Verified
  at source: the fix is live, not vacuous.
- `Profile.js:1353`'s `if (amount <= 0) return;` sits above both branches — as
  the round-4 report warned it must — and reads `incoming`, so the attacking
  branch is not swallowed while the defending branch is correctly gated on
  `taken <= 0` at line 1366. The escalated `Profile` half is **closed**.
- Exactly one `jump` emit (`Player.js:706`) and exactly one listener
  (`Items.js:178`), re-grepped. The new `player` field on the payload has no
  consumer — harmless today; whoever adds a second listener must read `e.player`.
- `slow` does **not** affect enemy attack rate or windups, and nothing promises
  it does. `speedMultiplier` has exactly two callers (`Enemy.js:679`,
  `Player.js:578`), both movers; windups scale only by `e.timeScale`. Measured:
  windup → attack → recover → chase transitions land on the **identical step**
  (31 / 39 / 65) at clean, slow ×4, and freeze. `CONTRACTS.md` says nothing about
  statuses; item text promises "chill" / "slow it" with no number. Consistent.
  (`isStunned()` returns true under freeze but the attack FSM never consults it —
  latent, harmless today.)
- Grounded `chase` is exactly proportional to `slow` at steady state
  (5.200 / 3.120 / 1.872 / 1.300 / 0.000 m/s). The one non-proportional regime —
  `moveGrounded`'s accel of 26 is not slow-scaled, so all arms accelerate
  identically for 3 steps out of rest — is bounded above by the clean arm at
  every step and lasts ≤ 50 ms. Benign.
- Prop tunnelling: `penetratedSteps` 0 at every speed tested to 800 m/s.
- Zero page errors and zero console errors across all seven of my physics probes
  (`pageErrors: []` in every raw file).

---

## 9. MERGE JUDGEMENT

### Verdict

**Merge the branch. Do not ship Co-op from it until F-6 is fixed.**

The single-player game on `round7/content-and-polish` is in good shape and is a
clear improvement on `master`. It builds, it captures 21/21 with a live
soundtrack, and its one failing check is the documented pre-existing one. The
physics work at the centre of this round is genuinely well-founded: the Waxed
Wing launch is annihilated six times less often, containment is untouched to
within six centimetres, and the solver is now clean against tunnelling to
800 m/s. The one defect this project would otherwise have shipped unmeasured —
the burrower's `slow` contract — is measured, and it is on contract.

What stops this being an unqualified yes is Co-op, a front-page menu item and
the one arm that had never been tested until this round. It carries the branch's
only regression (F-7), a critical join-time defect (F-6), and two pre-existing
MAJOR holes in its damage and scoring loops (F-9, F-10) that no previous round
had looked for. F-7 and F-6 are both small fixes; F-9 is one line; F-10 needs a
forwarded event. None of them is a reason to hold the *branch* — all of them are
reasons to hold the *Co-op menu entry*.

### What a reviewer must know before merging

1. **F-6 is a shipping blocker for Co-op, not for the branch.** A client that
   played single-player for ten minutes and then joins a friend has dead
   projectiles, dead placeables and no scheduled volleys for ten minutes
   (5.2 s measured from a 5 s menu idle; it scales with how long they played). The bug pre-dates this branch, but this branch widened it by
   putting jump movement behind the same `_replaying` flag. The one-line
   mitigation is in §7. Either fix it, or hide the Co-op menu entry, before
   this reaches players.
2. **F-7 is the one true regression on this branch, and it is cheap to fix.**
   The `this.local` gate was applied to both halves of the jump channel when only
   one half needed it. Because a client's inventory is a *mirror* of the host's
   (`Items.js:251-252`, `Items.js:211-215`), the host can and should still apply
   the impulse to the pawn — as it did before, with **0.0000 m** divergence.
   Keep the `jump` **emit** gated; ungate the **impulse application**. No
   protocol change needed. Left as-is, Waxed Wing, Updraft Vents and Tectonic
   Heart are inert for every non-host player.
3. **F-3 is the highest-value single-line fix on the list.** A shipping tier-1
   flyer ignores `freeze` outright for the whole of its suicide dive. Five
   defensive items are silently useless against it. One line, `Enemy.js:782`.
4. **One number in `round4-fix-physics.md` must be struck.** "Terrain-attributed
   zeroings 181 → 0" is a tautology (§2). Anyone who adopts it as a regression
   baseline will conclude a future change broke something that was never fixed.
   The correct figure is 83 → 10.
5. **The `Profile` escalation in `round4-fix-physics.md` §3 is already closed**
   on this branch. `untouchable` and `ironclad` are achievable. Do not re-open
   it.
6. **Co-op has two pre-existing holes wider than anything round 4 touched.**
   F-10: clients never receive damage feedback, so `timeSinceHurt` is frozen at
   the sentinel and every `onDamaged` card is dead for them. F-9: a teammate's
   damage is credited to your own run summary and `highestHit`. Neither was
   introduced here and neither is round 4's fault — but no one should merge Co-op
   believing the damage loop has been reviewed, because until this round it had
   not been.
7. **`06-loaded-hud` still fails one check** and capture exits 1 because of it.
   It is documented in `E-framing.md` §5 and is unchanged in kind. It is not a
   reason to hold the branch; it *is* a reason not to wire this capture into CI
   as a pass/fail gate without an allowlist for that shot.

### What is still open

| ref | severity | new? | one-line |
|---|---|---|---|
| F-6 | CRITICAL | pre-existing, widened here | joining co-op freezes the client's projectiles, placeables, scheduled volleys and item impulses for as many ticks as it played single-player (5.2–6.2 s measured; scales with session length) |
| F-7 | MAJOR | **regression, this branch** | the `this.local` gate removed the jump impulse from the host only; divergence went 0.0000 m → 0.500 m (6.013 m with real lag) and three items became inert for clients |
| F-3 | MAJOR | pre-existing | a committed flyer dive ignores `slow` **and** `freeze` completely |
| F-10 | MAJOR | pre-existing | a co-op client never receives `playerHurt`/`shieldBroken`, so `timeSinceHurt` is stuck at the sentinel and every `onDamaged` item is dead for it |
| F-9 | MAJOR | pre-existing | `Progression`'s `damageDealt` branch is unguarded — a teammate's 777 hit becomes this run's `highestHit` |
| F-2 | MAJOR | pre-existing | 15.2 % of 12-stack launches are clipped on the launch tick; only 75 % deliver the printed number |
| F-1 | MAJOR (doc) | — | the round-4 "181 → 0" headline is a tautology and must be struck |
| F-4 | MINOR | pre-existing | the melee lunge impulse is unslowed; 2.26× breach of the slowed clamp |
| F-8 | MINOR | pre-existing | `MAX_INPUT_BACKLOG` drops the oldest inputs silently, jump included; reachable by alt-tabbing the host |
| F-11 | MINOR | pre-existing | a joining peer's pawn is placed 35.8 m from where that client thinks it is |
| F-5 | MINOR | pre-existing | dead unslowed velocity write in `S.CHARGE` |
| — | design | jump-spam ascends 83° faces by up to +11.9 m; **pre-existing, identical in both solvers**, not a branch regression |
| — | design | air jumps overwrite horizontal velocity, so stacked impulses do not compound |

### Arms I did not test

Named, per the round's own rule.

1. **Enemies through the new sweep.** I measured the player exhaustively and
   enemies through `capsuleResolve` not at all. Round 4 flagged the same gap.
   Flyers are permanently `airborne` by the new predicate and so always take the
   relaxed clause; the step-up allowance is unchanged, so nothing they could not
   already enter has opened, but I did not drive a flyer at a cliff either.
2. **A long co-op session under real network conditions.** Everything here runs
   over a loopback WebRTC channel on one machine. Latency variance, packet loss
   and jitter are untested by anyone in seven rounds.
2b. **Four peers** (the protocol allows three clients; I ran two), **leaving
   during a boss** specifically, and **reconnect after `Lobby.leave()`** — the
   last shares F-6's stale-`_lastCmdTick` mechanism and reproduces it
   synthetically (`staleLastCmdTick 168` vs fresh tick 1 →
   `classifiedAsReplay: true`), but I did not drive a real reconnect.
3. **Performance under load.** I measured `capsuleResolve` in isolation
   (2.25 µs / 25.96 µs) but did not profile a full fight; the capture's `perf`
   block is intact (87 programs, 681 geometries, 53 textures, 395 objects).
4. **The other four fixers' domains** — audio, content, meta, engine — beyond the
   cross-cutting checks in §8 and the capture gate.
