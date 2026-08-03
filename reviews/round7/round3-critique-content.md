# Round 7 — round-3 critique, content arm (critic C4)

Independent, fresh-eyes review of the round-7 content at HEAD `b18a2b4` on
`round7/content-and-polish`. Working tree clean (`git status --porcelain -uno`
empty), so everything below was measured against committed code.

Answering `reviews/round7/round3-fix-content.md` and the content half of
`reviews/round7/round3-fix-integration.md`.

**Verdict: FAIL.** 2 critical, 8 major, 5 minor.

---

## 1. Methodology

Seven Playwright probes, launch config copied verbatim from `tools/capture.mjs`
(headed Chromium, `--use-angle=d3d11`, parked off-screen, one vite server per
probe on its own port 5471-5477). Raw JSON is kept:

| file | contents |
|---|---|
| `reviews/round7/r4-content/probe1-lasher.json` | Lasher attack-selection census at 7 standoffs, plus per-attack eligibility/rejection reasons |
| `reviews/round7/r4-content/probe2-los.json` | stage-wide line-of-sight geometry survey; live Lasher engagement from 6 random stands |
| `reviews/round7/r4-content/probe3-items.json` | Aegis, Tether (isolated), Whetstone (×DoT, ×cloud, ×pooling, ×Hunter's Tag), Waxed Wing, Scrapfly (mortal + immortal fixtures), Prey/Spurs |
| `reviews/round7/r4-content/probe4-combat.json` | first Conflagration/Redoubt/slow pass — **partly invalid, see §1.2** |
| `reviews/round7/r4-content/probe5-final.json` | engine-loop count, Conflagration pinned + crit-off, Redoubt, Lasher, Tether over a 12 s window, Waxed Wing, slow (5 units), drop tables, per-step item cost |
| `reviews/round7/r4-content/probe6-interactions.json` | Temporal Echo × Conflagration, Ashen Pact loop, `outgoing` stack at 10×, two overlapping pyres, Whetstone × Ashen Pact |
| `reviews/round7/r4-content/probe7-dps-and-impulse.json` | monster dps with real i-frames, roster comparison, impulse stack sweep on sloped and flat ground |

Throwaway drivers `tools/_r4boot.mjs`, `_r4diag.mjs`, `_r4probe{1..7}.mjs`
deleted after the run. `node node_modules/vite/bin/vite.js build` — exit 0,
`✓ built in 1.60s`, only the pre-existing chunk advisory. Zero page errors and
`ctx.frameErrors === 0` in every probe.

### 1.1 Three instrument failures I hit, and what they cost

Recorded because two of them are the same class of error that produced the
numbers I am refuting.

1. **Punchbag mites killed the player.** Probe 3 v1 spawned 100 k-HP mites next
   to a survivor with 110 HP. A dead player stops `Items._tickEffects`
   (`Items.js:1069` gates on `ctx.player?.alive`), stops `Player.step` — so
   `player.stats` and the input path freeze — and stops `ctx.time`. Four arms
   reported clean-looking, entirely fictional zeros. Fixed with a keep-alive
   system; every arm from v2 onward records `aliveBefore/aliveAfter` and the
   sim-seconds actually elapsed.
2. **`_iframeUntil = Infinity` denies all damage.** The obvious keep-alive is
   the harness's own `invulnerable()`. `Combat.applyDamage:387` early-returns 0
   for any non-DoT hit inside i-frames, so probes 4 and 5 measured every
   monster's dps as exactly 0. Their dps columns are void; probe 7 re-ran them
   with health topped up and i-frames left alone. **Probe 4's and probe 5's
   `damage`/`dps` columns must not be cited.**
3. **Rendered frames are not simulation seconds** — see finding **MAJOR-1**,
   which is the most consequential thing in this review. Every wait in probes 5,
   6 and 7 is `ctx.time`-based, never a frame count.

### 1.2 What is inconclusive

- Probe 4's slow arms sampled each stack count in a different FSM state and
  produced nonsense (a slowed Titan "5.6× faster than clean"). Superseded by
  probe 5's paired sampling; the probe-4 slow block should be ignored.
- Multiplayer/client is untested here, as it was in round 3. Every guard behind
  `ctx.authority` remains unexercised.
- Gamepad is untested. Input drove `ctx.input.keys` directly.
- The Lasher's `reel` damage tick against a *moving* player was not measured —
  my instrument pins the player, which suppresses the pull. See **MAJOR-8** for
  why that does not rescue the card.

---

## 2. The 18 m reel lead — closed

`round3-fix-integration.md` §4 reported, reproduced four times and explicitly
not chased: *"at the Lasher's own `preferredRange` of 18 m the reel fired zero
times in 25 s in four separate runs."*

**It is not a `pickAttack`/`REPOSITION` gap and it is not a pinned-unit
artefact. It is line of sight.**

`Enemy.pickAttack` (`src/entities/Enemy.js:814`) returns −1 unconditionally when
`!this.hasLOS`, and `S.REPOSITION` (`:1358`) does not even call it without LOS.
Probe 1 held an exact standoff while letting the unit's FSM run free, and
instrumented every `pickAttack` call with the per-attack rejection reason:

| standoff | pickAttack calls | `noLOS` calls | reel eligible | reel chosen | thorns chosen |
|---|---|---|---|---|---|
| 6 m | 909 | 11 | 7 | 6 | 7 |
| 8 m | 986 | 0 | 7 | 7 | 6 |
| 12 m | 996 | 31 | 6 | 6 | 6 |
| **18 m** | **1296** | **1296 (100%)** | **0** | **0** | **0** |
| 22 m | 1296 | 1296 (100%) | 0 | 0 | 0 |

At that particular stand the terrain occluded everything past ~13 m, so the
unit was blind and inert for the whole run — and a Lasher spawned 30 m out
walked to a mean 24 m and stood there for 45 s without ever attacking.

Probe 2 then established that this is location-dependent, not universal. A
geometry survey (60 walkable stands × 16 bearings, casting exactly what
`Enemy.checkLOS` casts — eye at +1.2 m to a Lasher chest at +1.95 m):

| distance | 6 m | 10 m | 13 m | **18 m** | 20 m | 25 m |
|---|---|---|---|---|---|---|
| fraction of (stand, bearing) pairs with clear LOS | 0.950 | 0.818 | 0.749 | **0.605** | 0.521 | 0.378 |

and six live 30 s engagements from random stands: **5 of 6 settled at exactly
18 m and fired 8 reels + 7 thorns**; the sixth had `losFraction 0.002` and fired
nothing at all for the entire fight.

**So: the reel does fire at 18 m, in about five stands out of six.** The
integration fixer's four runs all happened at the one bad stand. The finding
that remains is not "the reel never fires" — it is **MAJOR-8**: the reel fires
and pays nothing, because `pull: 26` was tuned at a 10 m start and the unit
fights at 18 m. That is the "tuning something the player never experiences"
risk, confirmed.

---

## 3. Verification table — round 3's headline claims

Mine measured at HEAD with the instrument named. Sim-seconds throughout.

| # | claim | round 3 | mine | verdict |
|---|---|---|---|---|
| 1 | Lasher **0 → 11.54 dps** at a 12 m standoff, 42 s, stationary player | 485.1 HP / 42 hurt / **11.54 dps** | 57.8 HP / 5 hurt / **1.37 dps** over 42.03 sim-s, `losFraction 1.000` | **REFUTED** (probe7) |
| 1b | "the Lasher now sits just below the tier's turret (12.58 dps)" | — | Lasher **1.37** vs Redoubt **10.26**, same stand, same probe, same 40 s | **REFUTED** |
| 2 | Conflagration 4.3× → **1.4×** (8 @3 m, 1 lit) | 103 vs 72 stated | **104.7 vs 72 = 1.45×** | **CONFIRMED** |
| 2b | 5.6× → **1.7×** (3 lit) | 369 vs 216 | **379.6 vs 216 = 1.76×** | **CONFIRMED** |
| 2c | isolated body pays *exactly* the printed number | 72 | **72.0** | **CONFIRMED** |
| 2d | 0 lit → 0 damage | 0 | **0** | **CONFIRMED** |
| 3 | Conflagration is **order-independent** (byte-identical arrays forward/reverse) | identical | **identical in all 6 formations** — `[72,32.7,0…]`, `[104.7,137.5,104.7,32.7,0…]`, `[219.3,275.6,316.1,341.3,341.3,316.1,275.6,219.3]` both directions | **CONFIRMED** (only once bodies are pinned; unpinned they drift and diverge — probe 4) |
| 4 | Grapnel Tether **0.02 → 6.02 m** floor | 6.02 m | **6.000 m exactly**, 3 procs over 12 sim-s, at 1 and 10 stacks, ground and flyer | **CONFIRMED** |
| 4b | flyers stay airborne — "the reel never writes `y`" | y untouched | **`largestYWriteByReel: 0.0000`** on `shriver` (`hoverHeight` 6.4) at 1 and 10 stacks | **CONFIRMED** |
| 4c | boss exclusion | read, not run | **`totalReelDisplacement: 0.000`** over 200 hits on a Titan | **CONFIRMED** (their untested arm #6) |
| 5 | Aegis Emitter grants **exactly 30** armor | 30 at 12/12 samples | **30 at 24/24 samples**; 0 before, 0 after leaving | **CONFIRMED** |
| 6 | Redoubt behind-shield fraction **0.01 → 0.567** circling | 0.567 | **0.636** at 13 m; **0.529** at 20 m; **0.573** at 70 % sprint speed | **CONFIRMED** |
| 6b | standing still stays low (0.12) | 0.12 | **0.137** | **CONFIRMED** |
| 7 | Whetstone fires through a **player-applied burn** | 170 | **170** (first 170, after a 10.6 s gap 170) | **CONFIRMED** |
| 7b | Whetstone fires through a **player-owned cloud** | 170 | **170** for a plain fire cloud *and* for a burn-applying pyre cloud | **CONFIRMED** |
| 7c | Whetstone survives **pooling** | 170 / 100 / 170, ids 21→22 | **170 / 100 / 170**, `sameObjectReused: true`, ids 12→13 | **CONFIRMED** |
| 8 | Waxed Wing **10.15 → 19.36 / 39.36 m/s** at 1× / 3× | 19.357 / 39.357 | **20.15 / 40.15** peak airborne | **CONFIRMED at 1× and 3×** |
| 8b | "exactly linear in stacks" | asserted from n=1, n=3 | **REFUTED from 4× up** — 4× 5.55, 5× 8.33, 8× 10.15, 10× 10.15 m/s airborne. See **CRITICAL-1** | **REFUTED** |
| 9 | Prey Instinct / Spurs no longer collide | 8.40 / 8.26 / 9.91 / 23.52 | **8.40 / 8.26 / 9.91 / 23.52**, `quickfoot.remaining 14.07 s` | **CONFIRMED** (exact) |
| 10 | Scrapfly re-acquire path (their weakest arm, never actually run) | untested | **runs**: with 120 HP bodies the fly killed `a` at t+1.0 and struck `b` at t+2.0 | **CONFIRMED** |
| 11 | slow works on the **enemy** side (their untested arms 3-5) | untested for flyer/charger/boss | flyer 0.610 / 0.262; charger 0.603 / 0.255; boss 0.480 / 0.254 against expected 0.60 / 0.25 | **CONFIRMED** for flyer, charger, boss; **REFUTED for the burrower** (0.699 / 0.397) |
| 12 | two overlapping pyres do not stack burn (their untested arm #10) | "by construction" | **peak 1 burn stack with 2 clouds alive** | **CONFIRMED** |
| 13 | Whetstone × Hunter's Tag (their untested arm #7) | untested | opener 170 (Whetstone only), follow-up 118 (Tag only), after the window 170 — never both, exactly as the card comment describes | **CONFIRMED** |
| 14 | elite affixes vs the Redoubt (their untested arm #4) | untested | all 5 affixes spawn, `armor` 733 facing (856 warded), behind-arc fraction 0.503-0.670 — the traverse counterplay survives every affix | **CONFIRMED** |
| 15 | `LSH_CROWN` removed; `trackDuring` removed from all three cards; CINDER lamp comment corrected; Emberwake 3.2 m | — | `git grep` returns zero hits for both; `CharacterMesh.js:1685-1690` builds 3 lamps at 0.09 m spacing; `items.js:1157` passes 3.2 | **CONFIRMED** |

---

## 4. Findings

### CRITICAL-1 — Waxed Wing's printed impulse is annihilated by the terrain step test from 4 stacks up

`src/data/items.js:855-857` (`onJump: applyImpulse(linear(10, count))`) →
`src/entities/Player.js:677-687` → `src/world/Stage.js:511-533`.

`capsuleResolve` moves the capsule the **whole step displacement in one
teleport** and tests only the destination with `_climbable(tx, tz, startY)`
(`Stage.js:618-627`). If the destination fails either the `STEP_HEIGHT = 0.62`
rise test or the walk-slope test, the branch runs `_vel.x = 0; _vel.z = 0` and
the entire launch is deleted. The faster the launch, the longer the untested
jump: at 20 m/s the step is 0.34 m; at 110 m/s it is 1.84 m, and almost no
terrain in this generator passes a 0.62 m rise budget over 1.84 m.

Measured (probe 7, `impulse`, sprinting, peak **airborne** horizontal speed,
first eight per-step speeds shown):

| stacks | printed | peak airborne | per-step trail |
|---|---|---|---|
| 0 | — | 10.15 | 10.15, 10.15, 10.15, … |
| 1 | +10 | **20.15** ✓ | 20.15, 19.75, 19.36, 18.96, … |
| 2 | +20 | **30.15** ✓ | 30.15, 29.75, 29.36, … |
| 3 | +30 | **40.15** ✓ | 40.15, 39.75, 39.36, … |
| 4 | +40 | **5.55** | 50.15, 49.02, 47.88, 46.75, … |
| 5 | +50 | **8.33** | 60.15, 59.02, 57.88, 56.75, **0**, 0.4, … |
| 6 | +60 | **8.73** | 70.15, 69.02, 67.88, **0**, 0.4, … |
| 8 | +80 | **10.15** | 90.15, **0**, 0.4, … |
| 10 | +100 | **10.15** | 110.15, **0**, 0.4, … |

The speed goes to *exactly* 0 — that is the `_vel.x = 0; _vel.z = 0` line, not
drag. At 10 stacks the launch survives one fixed step (1.84 m) and is deleted;
the item is worth nothing, and 10 stacks of an uncommon is an ordinary
minute-25 inventory.

It is not the stand: on the flattest ground in the whole stage (relief 0.46 m
over a 24 m square, `impulseFlat`) 1× is cut at step 5, 3× at step 3, 5× at
step 2, and **10× never reaches its printed speed at all** (peak 27.71 against
110.15).

`round3-fix-integration.md` §3 certifies this card as *"exactly linear in
stacks"* from an n=1 and an n=3 sample. Both of those are inside the working
band.

**Reproduction.** `?harness=1`, `__HARNESS__.gameplay()`, `thaw()`, give
`wax-quail` ×10, hold `KeyW`+`ShiftLeft` for 2 s, press `Space`, sample
`hypot(player.velocity.x, player.velocity.z)` every fixed step while
`!player.grounded`.

**Fix.** Sub-step the horizontal move in `Stage.capsuleResolve` so no single
`_climbable` test spans more than about the capsule radius:

```js
const dist = Math.hypot(dx, dz);
const n = Math.max(1, Math.ceil(dist / 0.4));
for (let i = 0; i < n && (dx || dz); i++) { /* existing test on dx/n, dz/n */ }
```

This also fixes the same annihilation for dashes, knockback and the Lasher's
pull, all of which write large horizontal velocities through the same path.

---

### CRITICAL-2 — the Bramble Lasher still deals ~nothing; round 2's blocking finding is not closed

`src/data/enemies.js:591-671`.

Probe 7, at a stand with `losFraction 1.000`, player stationary, 42.0
**simulation** seconds, real i-frames, `?seed=1337`:

| standoff | attacks fired | player hurt events | damage | dps |
|---|---|---|---|---|
| 8 m | reel 6, thorns 5 | 5 | 57.8 | **1.37** |
| 12 m | reel 6, thorns 5 | 5 | 57.8 | **1.37** |
| **18 m** (`preferredRange`) | reel 6, thorns 5 | 5 | 57.8 | **1.37** |
| 22 m | reel 6, thorns 5 | 5 | 57.8 | **1.37** |

57.8 / 5 = 11.56 per event, which is exactly `baseDamage 21 × thorns.damage
0.55`. **Every point of damage the card dealt in 42 s came from the thorn
volley. All six reels paid zero** — see MAJOR-8.

The same probe, same stand, same 40 s window, same instrument:

| card | tier | cost | dps vs a stationary player |
|---|---|---|---|
| Basalt Sentinel (`golem`) | 2 | 32 | **16.41** |
| Siege Bombard (`mortar`) | 2 | 34 | **12.95** |
| Ferrite Redoubt | 2 | 36 | **10.26** |
| Bile Spitling | 1 | 9 | **5.44** |
| Gloomshriver | 1 | 15 | **3.12** |
| **Bramble Lasher** | **2** | **29** | **1.37** |

A 29-credit tier-2 card deals a quarter of a 9-credit tier-1 card's output and
44 % of the tier-1 flyer's. Round 3's `volley 4 → 5` fix is real and did lift it
off zero, but the card comment's claim that it "now sits just below the tier's
turret" is wrong by a factor of 7.5.

**Fix.** Two independent levers, both in the card:
`thorns.damage 0.55 → ~1.6` brings the thorn half to ~4 dps, and MAJOR-8's
range problem has to be fixed before the reel contributes anything. Do not
re-run the round-3 measurement to check it — see MAJOR-1.

---

### MAJOR-1 — `freeze()`/`thaw()` duplicates the engine loop; every per-second figure in round 3 is inflated

`src/core/Engine.js:160-178`.

```js
const tick = () => {
  if (!this.running) return;
  requestAnimationFrame(tick);   // re-armed BEFORE _frame
  try { this._frame(); } catch (e) { this._onFrameError(e); }
};
```

`stop()` only clears `running`. When it is called from inside a rAF-driven
async chain — which is what `Harness.freeze()` (`:152`) does at the end of
every scenario — the *next* tick is already queued. `thaw()` (`:177`) then sets
`running = true` and schedules a **second** chain. Both see `running === true`
and both re-arm. The loops accumulate.

Measured (probe 5, `engineLoops`, `_frame` calls per rAF over 60 rAF):

| state | engine frames per rAF |
|---|---|
| as booted | **1.00** |
| after 1 freeze/thaw cycle | **2.00** |
| after 2 cycles | **3.00** |
| after 3 cycles | **4.00** |
| after `H.gameplay()` + `thaw()` | **5.00** |

`determinism()` reports `clockPinned: true, frameDt: 1/60` throughout, so the
pin is working and reports healthy — the frames are simply happening N times
per presented frame.

Consequences:

- **Every round-3 probe** used the `H.gameplay(); H.thaw()` preamble, which on
  a clean boot leaves **2 loops**. Any figure they expressed as "over 42 s",
  "over 40 s", "over 25 s" or as a dps ran for twice that much simulation. The
  Lasher's "485.1 HP in 42 s = 11.54 dps" is at best 485.1 HP in 84 s = 5.77
  dps, and my independent measurement of the same configuration is 1.37.
- **`tools/capture.mjs` freezes and thaws 21 times.** By the last scenario the
  simulation is advancing roughly twenty times per rendered frame, so every
  VFX lifetime, spawn timer and physics step in the late shots is at a
  different point in its life than the frame budget implies. This is a
  plausible contributor to the run-to-run flapping of the `06-loaded-hud`
  separation check that three reports now describe as "alternates pass/fail run
  to run".

**Not a shipped-gameplay defect** — `git grep` shows `engine.start()`/`stop()`
have exactly two callers, `main.js:90` and `Harness.js:152/177`; the pause menu
uses `ctx.paused`. It is a measurement and capture defect, which is why it is
major rather than critical.

**Fix.** Guard the chain identity:

```js
start() {
  if (this.running) return;
  this.running = true;
  const gen = ++this._gen;
  const tick = () => {
    if (!this.running || gen !== this._gen) return;
    requestAnimationFrame(tick);
    …
  };
  requestAnimationFrame(tick);
}
```

**Reproduction.** Boot with `?harness=1`, wrap `engine._frame`, count calls per
`requestAnimationFrame` before and after `H.freeze(); H.thaw()`.

---

### MAJOR-2 — Temporal Echo reinstates the Conflagration cascade round 3 removed, at 9.35× printed

`src/data/items.js:1463-1489` × `src/data/abilities.js:1234-1325`. Both shipped
in the same commit (`cf7e63e`).

Round 3's fix #4 captures the burning set *before the first detonation* so that
"a body lit by an earlier blast" cannot be paid. That closes the cascade
**within one cast**. Each detonation still passes `status: 'burn'` to
`Combat.explode` (`abilities.js:1310`), so the cast leaves a much larger burning
set behind it — and Temporal Echo fires the identical ability again 0.9 s later.

Measured (probe 6, 10 pinned mites at 2.2 m spacing, exactly one lit at cast
time, crit forced off, damage counted as non-DoT `type: 'fire'`):

| | casts | fire damage | vs printed 72 | bodies burning after |
|---|---|---|---|---|
| no Temporal Echo | 1 | **140.4** | 1.95× | 3 |
| 10× Temporal Echo | 2 | **673.2** | **9.35×** | 5 |

The "free second cast" is worth **4.79× the first**, because it inherits a
burning set the first cast created. The card says "cast a second time, free".

**Fix.** Either drop the `status: 'burn'` rider from Conflagration's own blasts
(the ability is a payout, not a setup tool — the Pyre Flask and Stoke are the
setup), or have the echo replay against the *original* snapshot. The first is
one word and preserves the card's stated identity.

---

### MAJOR-3 — Conflagration's real payout ceiling is 4× printed, and round 3 stopped measuring at the mild formation

`src/data/abilities.js:1295-1315`.

Round 3 tested 8 bodies at 3 m spacing and reported 1.4× and 1.7×. Both
confirmed. But the CINDER kit exists to *create* tight burning packs (Stoke
cone, 6 m Pyre Flask), and at that spacing the overlapping 5.5 m blasts still
compound, because `Combat.explode`'s falloff bottoms out at 0.35
(`Combat.js:346`) and eight bodies at 1.2 m are all inside all eight blasts.

Measured (probe 5, pinned bodies, crit off, both spawn orders — identical):

| formation | printed total | measured | ratio |
|---|---|---|---|
| 8 @3 m, 1 lit | 72 | 104.7 | 1.45× |
| 8 @3 m, 3 lit | 216 | 379.6 | 1.76× |
| **8 @1.2 m, all 8 lit** | **576** | **2304.6** | **4.00×** |
| **12 @1.5 m, all 12 lit** | **864** | **3124.4** | **3.62×** |

It is bounded — it plateaus around 4× rather than scaling in the square of the
pack size, so round 3's stated design goal is met. What is wrong is that the
card prints 600% per burning body and delivers ~2400% in the formation the kit
is built to produce, and nobody measured it.

**Fix.** Either state it (the description is the contract) or scale the
per-blast damage by `1 / sqrt(litCount)` so a pile pays super-linearly but not
4× per body. `abilities.js:1298` already has `litCount` in hand.

---

### MAJOR-4 — the impulse channel is winner-takes-all; three cards advertise otherwise

`src/systems/Items.js:728` — `applyImpulse(speed) { this._pendingImpulse = Math.max(this._pendingImpulse, speed); }`

Measured (probe 7, `impulseCombined`, peak airborne horizontal):

| held | peak |
|---|---|
| 1× Updraft Vents | **15.15** |
| 1× Waxed Wing | **20.15** |
| **1× Waxed Wing + 1× Updraft Vents** | **20.15** |

Updraft Vents' entire movement clause contributes **nothing** while any Waxed
Wing is held, and `linear(10, n) > linear(5, n)` for every n, so it can never
contribute. Tectonic Heart's 6 m/s "throws you forward"
(`items.js:1600`) is likewise dead in any inventory with one Waxed Wing.

The comment at `items.js:1599-1601` calls this "composes with Waxed Wing and
Updraft Vents rather than competing". Discarding the smaller value is the
definition of competing. No card description mentions it.

**Fix.** Either sum with a cap (`_pendingImpulse = Math.min(CAP,
_pendingImpulse + speed)`), or keep `Math.max` and say so in all three
descriptions. The first is preferable — Updraft Vents currently has a
one-clause card and half of it is unreachable.

---

### MAJOR-5 — Ashen Pact is a permanent free enabler for Entropy Ledger and Prey Instinct, not a cost

`src/data/items.js:1734-1755` (lunar) × `:1443-1460` (legendary) × `:724-747`
(common). All three are round-7 cards from the same commit.

The lunar tier's stated identity is *"every card here is a trade… a Lunar item
with a downside the player can ignore is a green item wearing a blue frame"*
(`items.js:1739-1742`). Measured (probe 6, keep-alive off so the item really
bills, 10× Ashen Pact + 1× Entropy Ledger + 1× Prey Instinct):

```
health fraction, by second: 0.809 0.656 0.534 0.436 0.358 0.309 0.309
                            0.300 0.300 0.300 0.301 0.301
settled at 0.303 of max, permanently, in 8 seconds
Entropy Ledger on a 100 hit: 169.7   (+69.7%, i.e. 87% of its 1-stack maximum)
Prey Instinct live: true, moveSpeed 8.26 (base 7)
every hit ignites: true
```

`payHealth` (`items.js:125-133`) refuses to bill below `SELF_COST_FLOOR`, so
after eight seconds the drawback costs literally zero per second and the player
sits forever in exactly the band that Entropy Ledger (missing-health scaling)
and Prey Instinct (below 40 % health) both pay for. Gorging Tooth shrinks the
maximum, making the floor cheaper in absolute HP still.

This is a coherent risk build and I am not arguing it should not exist — but as
shipped, the lunar's *only* cost is spent in the first eight seconds of holding
it, and after that it is a strictly positive card in a tier whose contract says
it cannot be.

**Fix.** Make the drain a *fraction of maximum* rather than of current health
(`player.health * linear(0.02, n)` → `player.stats.maxHealth * linear(0.01,
n)`), so it keeps costing at the floor and the player has to keep paying to
stay in the band. One line, `items.js:1752`.

---

### MAJOR-6 — the Lasher's 18 m `preferredRange` is beyond what this terrain reliably permits

`src/data/enemies.js:610` (`preferredRange: 18`), `src/entities/Enemy.js:814`.

Probe 2's geometry survey: LOS is clear for **0.605** of (stand, bearing) pairs
at 18 m, against 0.818 at 10 m and 0.749 at 13 m. A `ranged` unit holds
`preferredRange` (`Enemy.js:644-648`) and `pickAttack` returns −1 without LOS,
so at the bad stands the unit is completely inert — and `S.REPOSITION` cannot
rescue it, because it does not call `pickAttack` without LOS either
(`Enemy.js:1358`) and its 1.6 s timeout just bounces it back to `CHASE`.

Live confirmation, six random stands, 30 s each: **one in six** produced
`losFraction 0.002`, zero attacks and zero damage for the entire engagement,
with the Lasher parked at a mean 24 m. A player who fights near cover meets a
29-credit monster that does nothing.

The Ferrite Redoubt shares the shape but is much less exposed: its 13 m stand-off
sits at 0.749 LOS.

**Fix.** `preferredRange: 18 → 13` for the lasher (matching the Redoubt), which
raises the clear-LOS fraction from 0.605 to 0.749 and — see MAJOR-8 — is also
where its own reel tuning is valid. A structural fix would be to let a blind
ranged unit close rather than orbit: in `S.REPOSITION`, fall through to `CHASE`
immediately when `!e.hasLOS` instead of orbiting for 1.6 s at a radius it
already cannot see from.

---

### MAJOR-7 — a slowed burrower is not slowed to the contracted amount

`src/entities/Enemy.js` `applyMovement` scaling, exercised from
`src/data/enemies.js:368` (`burrower`).

`round3-fix-integration.md` §2 states *"the charge and the burrow return before
that point and are scaled where they integrate"* and names both as untested
(their arm #3). Measured (probe 5, paired sampling, mean horizontal speed over
2 sim-s per stack count, unit re-placed identically before each pass):

| unit | clean | slow ×1 | ratio (want 0.600) | slow ×5 | ratio (want 0.250) |
|---|---|---|---|---|---|
| mite | 8.498 | 5.407 | 0.636 | 2.218 | 0.261 |
| shriver (flyer) | 4.860 | 2.967 | 0.610 | 1.272 | 0.262 |
| charger | 5.261 | 3.175 | 0.603 | 1.339 | 0.255 |
| titan (boss) | 2.992 | 1.435 | 0.480 | 0.761 | 0.254 |
| **burrower** | 3.400 | 2.377 | **0.699** | 1.349 | **0.397** |

Four of five land on the contract. The burrower is 17 % under-slowed at one
stack and **59 % under-slowed at five** — a Frost Lattice freeze that stops
everything else on the roster leaves this one moving at 40 % of speed.

**Fix.** Apply the same multiplier to the burrow integration site that
`applyMovement` applies to the surface path, and to its ceiling. The
integration report says this was "read in code and built into the same `slow`
local"; it is not reaching the burrow branch at full strength.

---

### MAJOR-8 — `pull: 26` was tuned at 10 m; the unit fights at 18 m, where the reel can never reach its own blast

`src/data/enemies.js:648-651` (the reel), `:610` (`preferredRange: 18`),
`src/entities/Enemy.js:1011-1029` (`pullPlayer`).

The re-tune's whole justification (`round3-fix-integration.md` §4) is: *"at 19
a stationary player at 10 m ends 6.44 m away — outside this attack's own 6 m
`blast`… 26 steals 4.87 m and lands them at 5.13 m, inside the blast with
margin."* That reasoning is sound **at 10 m**. It is not the range the card
fights at.

The same report's own table gives the 18 m row: `pull: 26` steals **2.435 m**
over the 1.5 s `active` window. From 18 m that ends the player at 15.6 m —
2.6× outside the 6 m blast. `pullPlayer` only ticks damage `if (d < (a.blast ||
6))`, so the reel's entire payoff is unreachable from the unit's own standing
position.

Confirmed live (probe 7): at every standoff from 8 m to 22 m, **6 reels fired
and contributed 0 of the 57.8 HP dealt** — all of it was thorns at exactly
11.56 per hit.

So the reel is, at the range the unit chooses to stand, still what round 2
called it: an attack with no output. The re-tune moved a number without moving
the card.

**Fix.** The range term is the lever the fixer identified and then did not
pull. Either `preferredRange: 18 → 12` (which also fixes MAJOR-6 and puts the
10 m tuning inside the fight), or give the reel a `maxRange` so it is only
selected inside ~11 m, where 26 does what it was measured to do.

---

### MINOR-1 — the Redoubt's stated counterplay band is 4 m wide, not 7

`src/data/enemies.js:698-699` (comment) vs `:738-741` (`backblast`).

The comment reasons: *"The `backblast` nova (6 m) is the inner wall, which
leaves a 6-13 m band where the stated counterplay is the play."* `backblast`
has `range: 6` (the distance at which `pickAttack` will select it) and
`blast: 9` (the radius it actually damages — `Enemy.js:907`,
`spawnBlast(ctx, this, a.blast, …)`, and the windup telegraph is drawn at
`a.blast` too). The inner wall is 9 m. The stated corridor is 9-13 m: **4 m,
not 7** — 43 % narrower than the arithmetic the card is written around.

**Fix.** Either correct the comment to 9-13 m, or set `blast: 6` to match the
selection range so the number the comment reasons about is the number the
player experiences.

### MINOR-2 — the Lasher's `flail` never fires

`src/data/enemies.js:670`. `flail` has `range: 4.2`; the card is
`behavior: 'ranged'` with `preferredRange: 18`, and `Enemy.steer`'s ranged
branch only closes below `stand * 0.65` = 11.7 m to *back away*. Across 15 probe
arms at standoffs from 6 m to 25 m, `flail` was `tooFar` on every single
`pickAttack` call and fired **zero** times. A third of the card's attack table is
unreachable.

**Fix.** Remove it, or give the card a melee-punish behaviour that can actually
reach 4.2 m.

### MINOR-3 — Scrapfly Hive still promises an entity it does not draw

`src/data/items.js:1186`: *"release a scrapfly that hunts one enemy at a time"*.
There is no scrapfly — only `ctx.vfx?.beam?.(fly, quarry.position, 0xc8d86a)`
(`:1222`). Round 3 states this openly and I am not re-litigating the decision to
keep the card; I am recording that the description still describes a creature
the player never sees, which is the same class of defect as the Spore-Sac-green
"cinder patch" round 3 fixed two items away.

**Fix.** Reword to what is drawn ("a scavenging beam"), or draw it.

### MINOR-4 — two overlapping pyres double a body's cloud dps

`src/systems/Items.js:1080-1113`. The burn *status* is correctly capped at one
stack (verified: `peakBurnStacks: 1` with `cloudsAlive: 2`), but `_tickClouds`
runs `applyDamage` once per cloud per body per 0.5 s, so standing in two Pyre
Flasks takes 2× the printed 90 % dps. That is defensible for two AoEs — it is
recorded here because it is the half of "two overlapping pyres" that round 3's
"by construction" argument does not cover, and because the ability has two
charges and a 6 s cooldown, so overlapping them is the normal case, not a corner.

### MINOR-5 — the `outgoing` chain is fully multiplicative at 10 stacks

Measured (probe 6): 11 items carrying `outgoing` hooks
(`splinter-bar, crowbar, ammo-pouch, bipod, whetstone, hunters-tag,
affliction-index, siege-battery, entropy-ledger, gilded-reliquary,
vow-of-momentum`), 10 of each:

| condition | damage multiplier from `outgoing` alone |
|---|---|
| healthy player, clean target | **×172.8** |
| 20 % health, target burning + bleeding + slowed | **×5443.2** |

This is before crit, before proc chains, before Shrapnel Heart. Genre-normal
for RoR2-likes and I am not calling it a bug — but round 7 added four of those
eleven (`whetstone`, `bipod`, `affliction-index`, `entropy-ledger`,
`gilded-reliquary`, `splinter-bar`, `vow-of-momentum` — seven, in fact), and
Whetstone ×8 and Entropy Ledger ×9 together are ×72 of the ×172.8. If any
ceiling is ever wanted, this is the round that made it necessary.

---

## 5. What is genuinely good

- **The Grapnel Tether fix is the best piece of work in the round.** With the
  body pinned so that nothing but the reel can move it, the floor is hit
  *exactly* — `minDistanceReached: 6.000` — and `largestYWriteByReel` is
  `0.0000` on a 6.4 m flyer at both 1 and 10 stacks. The stacking curve really
  did move from depth to breadth: 3 procs in 12 s at 1 stack and at 10, because
  `TETHER_RECOVER` binds per body. The boss exclusion holds at zero
  displacement over 200 hits. Four separate claims, four exact confirmations.
- **The Chipped Whetstone fix is complete and it is complete in the arms nobody
  asked about.** 170 through a player-applied burn, 170 through a plain fire
  cloud, 170 through a burn-*applying* pyre cloud, 170 on a pooled body with
  `sameObjectReused: true` and the id ticking 12→13, 100 correctly denied to an
  immediate follow-up, and 170/118 correctly alternating against Hunter's Tag
  exactly as the card comment predicts. The `Enemy.id` carried alongside the
  timestamp is the right primitive and it is used identically by `onceEvery`.
- **The Aegis Emitter is exact.** 30 armor at 24 of 24 samples across three
  seconds, 0 before, 0 after leaving. Routing through `Items.addBuff` instead of
  halving the constant was the correct call and it produces a number that does
  not drift.
- **The Prey Instinct / Bloodied Spurs repair reproduces to the decimal** —
  8.40, 8.26, 9.91, 23.52, with `quickfoot.remaining` at 14.07 s instead of
  0.50. Refusing the "better and one line" `Math.max` alternative was right.
- **Conflagration's determinism fix is real.** Six formations, forward and
  reverse spawn order, byte-identical per-body arrays in every one. The `_lit`
  second scratch buffer is the correct shape and the reasoning in the comment is
  the reasoning the measurement supports.
- **The Ferrite Redoubt re-tune delivers the fight it describes.** 0.137 of
  frames behind the arc standing still against 0.636 circling at 13 m, 0.529 at
  20 m, and — the arm nobody ran — 0.573 at 70 % of sprint speed, so it is not a
  machine-circle artefact. It survives all five elite affixes (0.503-0.670)
  while the front armour reads 733 (856 warded). 10.26 dps stationary, 0
  circling: the counterplay is worth executing and the unit is worth respecting.
- **The item hooks are cheap.** With 10 of every non-blight, non-lunar item (88
  ids, 880 stacks), 12 live bodies and the player under 40 % health so Prey
  Instinct re-applies every step, `Items.fixedUpdate` costs **0.020 ms per fixed
  step** against 0.0022 empty — 0.12 % of a 16.6 ms frame. The stat-cache fix
  that stopped `addBuff` dirtying on a pure timer refresh is doing its job.
- **The drop tables are exactly the declared shape.** 20 000 rolls: small chest
  75.6 % common / 19.5 % uncommon / 0.91 % legendary / 4.05 % blight; large
  chest 87.6 % uncommon / 8.6 % legendary. The sixteen new items diluted the
  pools evenly (common 28→31, uncommon 26→31, legendary 15→18) with no tier
  distorted relative to another.
- **Every fix report in this round names its untested arms.** Eleven of them in
  the content report, eleven in the integration report. Seven of the ones I
  chased came back clean. That habit is what let me spend my time on the two
  that did not.

---

## 6. Checked and clean

Verified and found to have nothing wrong with them, recorded so the next
reviewer does not pay for them again:

- `git grep LSH_CROWN` → zero hits. `git grep trackDuring` → one hit, a comment
  saying it was removed.
- `CharacterMesh.js:1685-1690` builds exactly three lamps at 0.09 m spacing (a
  0.18 m strip) plus one pilot light at `:1721` — the corrected comment is
  accurate.
- Emberwake Cleats passes `3.2` to `addCloud` (`items.js:1157`) and its
  description says 3.2 m.
- Pyre Flask's cloud is `radius 6, duration 8, status 'burn', colour 0xff7a2a,
  type 'fire'` — matches its description word for word.
- Two overlapping burn-applying clouds top the status up rather than stacking it:
  1 burn stack with 2 clouds alive.
- Whetstone × Ashen Pact (guaranteed ignition on every hit): 170 / 170 across a
  6 s gap. The `isDot` early-return holds under the worst case in the pool.
- Scrapfly Hive's re-acquire branch executes and re-targets: with 120 HP bodies
  the fly killed `a` at t+1.0 s and struck `b` at t+2.0 s. Its strike component
  is exactly linear in stacks (15.6 / 31.2 / 156 at 1 / 2 / 10).
- Slow reaches flyers, chargers and bosses at the contracted 0.60 / 0.25.
- A frozen flyer hangs rather than dropping (`drop: −0.23 m` over 3 s of
  continuous freeze on a `hoverHeight` 6.4 shriver).
- All five elite affixes spawn on a Redoubt without error and compose correctly
  with the front-arc armour.
- `node node_modules/vite/bin/vite.js build` — exit 0.
- Zero `frameErrors`, zero page errors and zero console errors across all seven
  probes.

---

## 7. Verdict

**FAIL** — 2 critical, 8 major, 5 minor.

Round 3 did good work and most of it holds: of the twenty claims I could test,
**fifteen are confirmed exactly**, several of them in arms the fixers named as
untested and I chased anyway. The Tether, the Whetstone, the Aegis, the
Prey/Spurs collision and Conflagration's determinism are all genuinely closed.

What fails is not the craft, it is the calibration. Two of the round's headline
numbers were produced by an instrument that was running the simulation at twice
the rate it believed (MAJOR-1), and both of those numbers were the ones used to
certify that a blocking finding had been closed. The Bramble Lasher is still
the worst card on its tier by a factor of four against a monster costing a third
as much (CRITICAL-2), its reel still cannot reach its own damage radius from the
range it fights at (MAJOR-8), and Waxed Wing — certified "exactly linear in
stacks" from two samples — is worth nothing at the stack counts a real run
reaches (CRITICAL-1).

The two design calls I was asked to re-audit come out differently from each
other. **The Ferrite Redoubt re-tune is correct** and the measurements support
every sentence of its comment except the backblast arithmetic. **The Gloomshriver
repricing is fine** — at 3.12 dps against the Spitling's 5.44 it is paying for
altitude and homing rather than raw output, which is what the comment claims.
**The Scrapfly Hive rebuild works** and the re-acquire path that was the report's
weakest verification does what it says. **Ashen Pact, Entropy Ledger and Prey
Instinct should not have shipped in the same round without someone holding all
three at once** (MAJOR-5), and neither should Temporal Echo and Conflagration
(MAJOR-2).

Do not re-measure any of this with a frame-counted wait until `Engine.start` is
fixed.
