# Round 7 — round-4 fixes, content arm

Answering `reviews/round7/round3-critique-content.md` for the findings inside
`src/data/*.js`, `src/systems/Items.js`, `src/entities/EnemyMeshes.js`,
`src/entities/CharacterMesh.js`. Round 4 is the last round `RUBRIC.md` allows.

---

## 1. Instrument, and what it is and is not good for

Five Playwright probes, launch config copied verbatim from `tools/capture.mjs`
(headed Chromium, `--use-angle=d3d11`, parked off-screen, one vite server per
probe on its own port 5481-5485). Raw JSON kept in
`reviews/round7/r4fix-content/`:

| file | contents |
|---|---|
| `probeA-lasher.json` | Lasher dps at 3 stands x 5 standoffs, roster comparison, first agency attempt |
| `probeB-items.json` | impulse channel, Conflagration set, Ashen Pact, Scrapfly |
| `probeC-confirm.json` | Lasher replication at 4 fresh stands, **paired old-code/new-code Conflagration x Temporal Echo**, paired agency attempt |
| `probeD-agency.json` | agency through the real input path, Scrapfly with a durable quarry |
| `probeE-final.json` | reel damage standing still vs sprinting away, Scrapfly after the strike cap |
| `probeF-scrapfly.json` / `probeF2-scrapfly.json` | one whole Scrapfly release, watched from its first tick, before and after the strike fix |

Every wait is `ctx.time`-based; no figure below is a frame count.

**The concurrent-engine bug is not in these numbers.** `src/core/Engine.js`'s
`_loopGen` fix was already in the working tree when probe A ran, and all three
probes that measured it report **`engineLoops: 1.00`** engine `_frame` calls per
rAF after `H.gameplay(); H.thaw()` — against the 2.00 the round-3 critique
measured at `b18a2b4`. Sim-second accounting would have been invariant to it
anyway; the number is recorded because the critique asked for it.

Fixture discipline, against the two traps named in the brief:

- **No 10 M-HP punchbags and no `_iframeUntil = Infinity`.** The survivor keeps
  its real maximum and real i-frames; health is topped up *after* each frame has
  booked its damage. Monster fixtures for the ability arms are given 4 000 or
  20 000 HP — enough to survive a cast so the arm measures damage rather than a
  kill count, low enough that nothing is immortal. Every arm records
  `aliveAfter` and the sim-seconds actually elapsed.
- **No single stand is a measurement.** The Lasher was measured at six
  independent walkable stands across two probes, five standoffs each, thirty
  arms total. One of those thirty is a stand where terrain blinds the unit
  completely — it is reported below rather than dropped.

### 1.1 What I could not measure, and am not claiming

**The suction's effect on a sprinting player is unverified by my instrument.**
Two attempts, both disqualified rather than shipped:

- `probeC-confirm.json` `agency`: I drove the survivor by writing
  `player.velocity` every rendered frame. That overwrite lands *after* the fixed
  step the pull wrote into, so it deletes exactly the quantity being measured.
  Paired with-pull/without-pull runs came back identical to within 6 mm, which
  is the instrument reporting itself, not the game.
- `probeD-agency.json` `agency`: real input path (`ctx.input.keys` +
  `KeyW`/`ShiftLeft`), paired against a stubbed `Enemy.pullPlayer` on the same
  stand. `reelSecondsOn/Off` both read 5.55 s of a 6.0 s window, which is
  impossible — `e.atk` is not cleared when an attack ends, so my "during the
  reel" gate was open for the whole run and the 1.5 s that matters is diluted
  into it. `groundStolen` came back 0.000-0.006 m; that number is not evidence.

I am not resting the agency claim on either. See §3.1 for what the claim rests
on instead, and §7 for this arm named as untested.

---

## 2. Changes

| # | severity | file | change |
|---|---|---|---|
| 1 | CRITICAL-2 / MAJOR-6 / MAJOR-8 / MINOR-2 | `src/data/enemies.js` | Bramble Lasher: `preferredRange` 18 -> 11, reel `blast` 6 -> 9 and `cooldown` 8.0 -> 6.5, `flail.range` 4.2 -> 6.5, `thorns.damage` deliberately unchanged |
| 2 | MAJOR-4 | `src/systems/Items.js`, `src/data/items.js` | `applyImpulse` sums instead of `Math.max`; Tectonic Heart's "composes" comment corrected |
| 3 | MAJOR-2 | `src/data/abilities.js` | Conflagration's blasts drop the `status: 'burn'` rider |
| 4 | MAJOR-3 | `src/data/abilities.js` | Conflagration's description states the overlap; the measured ceiling recorded in the card |
| 5 | MAJOR-5 | `src/data/items.js` | Ashen Pact bills a fraction of *maximum* health at a **50%** floor; `payHealth` takes a per-card floor |
| 6 | MINOR-1 | `src/data/enemies.js` | Redoubt's counterplay-band comment corrected to 9-13 m |
| 7 | MINOR-3 | `src/data/items.js` | Scrapfly Hive now draws its fly, and strikes the five times it prints instead of four |
| 8 | MINOR-4 / MINOR-5 | `src/systems/Items.js` | both declined, with the reasoning and the measured ceiling written into the code |

Nothing was changed in `src/entities/EnemyMeshes.js` or
`src/entities/CharacterMesh.js`.

---

## 3. The Bramble Lasher — the decision, and why

**Decision: keep the card and move its frame, not its numbers. It is now a
close-mid grappler that stands at 11 m, not an artillery piece that stands at
18 m.**

Three rounds moved numbers inside a frame that was wrong. Round 2 called the
card inert; round 3 fixed the volley and re-tuned `pull` from 19 to 26 — and the
re-tune was measured, carefully, *at 10 m*, which is not where the card stands.
At its own `preferredRange` of 18 the same 26 steals 2.435 m, ending the player
at 15.6 m against a 6 m damage radius, and `pullPlayer` only ticks damage
`if (d < a.blast)`. Hence the critique's count: **six reels fired and
contributed 0 of the 57.8 HP the card dealt in 42 s, at every standoff from 8 m
to 22 m.** The same 18 m is also further than this terrain reliably permits —
0.605 of (stand, bearing) pairs have clear LOS at 18 m against 0.818 at 10 m,
and one live engagement in six was a 29-credit monster standing at 24 m doing
nothing for thirty seconds.

Cutting the card was on the table and rejected: `pull` on an ordinary spawn is
the only place outside a boss where the game teaches "you cannot simply walk
away", and that lesson is worth a card. What was not worth keeping was an
18 m stand-off that made every other number on the card unreachable.

So:

- **`preferredRange: 18 -> 11`** — inside the range its own pull was tuned at,
  and inside what the terrain permits.
- **reel `blast: 6 -> 9`** — `Enemy` draws the ground telegraph at `a.blast` for
  the whole 1.15 s wind-up, so the blast radius *is* the warning. At 6 m that
  telegraph was a ring around the monster's feet that a player at 18 m was never
  in and could never be dragged into. At 9 m, from an 11 m stand, it reaches
  most of the way to the player: "you are on the edge of this, and it is about
  to pull you in."
- **reel `cooldown: 8.0 -> 6.5`** — the reel is the card; at 8 s it was a third
  of the attacks selected.
- **`flail.range: 4.2 -> 6.5`** — 6.5 is not a number picked to be bigger, it is
  where the reel leaves the player. That turns two unrelated attacks into a
  two-beat sequence.
- **`thorns.damage` left at 0.55.** The critique proposed ~1.6, and that was
  correct *given* a reel that paid nothing. With the reel working, raising it
  would pay twice for one problem. Measured split over thirty arms: reel ~60%,
  thorns ~23%, flail ~17%.

### 3.1 The threat end

Thirty 30 s arms, six stands, standoffs 8/11/14/18/22 m, stationary survivor,
real i-frames, `?seed=1337`. Sources: `probeA-lasher.json` `result.arms`,
`probeC-confirm.json` `lasher.arms`.

| | before (critique probe 7) | after |
|---|---|---|
| dps at every standoff 8-22 m | **1.37**, identical at all four | **0.00 - 10.03**, mean **6.5** |
| reel's share of the damage | **0 of 57.8** | ~60% (`pull` present in 28 of 30 arms) |
| `flail` selections | **0 across 15 arms** | 1-5 per arm, `melee` damage in 20 of 30 |
| worst arm | — | 0.00 dps, `losFraction 0.008` (§3.3) |

Roster comparison, my instrument, two independent stands, same 30 s window:

| card | tier | cost | dps (probe A, stand 0, 14 m) | dps (probe C, stand 3, 12 m) |
|---|---|---|---|---|
| Basalt Sentinel | 2 | 32 | 14.59 | 21.88 |
| Ferrite Redoubt | 2 | 36 | 15.69 | 15.32 |
| **Bramble Lasher** | **2** | **29** | **8.42** | **8.33** |
| Bile Spitling | 1 | 9 | 0.00 * | 7.09 |
| Siege Bombard | 2 | 34 | 3.84 | 3.36 |
| Gloomshriver | 1 | 15 | 1.12 | 2.99 |

\* the Spitling's probe-A arm sat at a stand where it held 15.87 m and its
twelve spits all missed a pinned target. That cell is my instrument, not the
card, and it is why the table carries two stands.

The claim I am making is the narrow one the numbers support: a 29-credit tier-2
card that dealt a quarter of a 9-credit tier-1 card's output now beats it and
sits at roughly half the tier's turret, at 81% of the turret's cost, while being
the only ordinary spawn that moves the player. I am **not** claiming it "sits
just below the tier's turret" — that was round 3's claim and it was wrong by
7.5x; mine would be wrong by 1.8x.

### 3.2 The agency end

This is the end round 3's audio retune got wrong in the other direction, so it
is stated explicitly.

**What did not change: `pull: 26`, `range: 26`, `minRange: 4`.** The suction
term in `Enemy.pullPlayer` is byte-identical to the one round 3 measured and the
round-3 critique confirmed — 26 costs a sprinting player 0.22 m of a 10.57 m
escape at 10 m, and 1.48 m of a 10.31 m escape at 5 m, never reversing their
direction for a frame. `blast` gates only the damage tick (`if (d < a.blast)`),
`cooldown` gates only selection, and `preferredRange` is a steering target;
none of the three can reach the velocity write. My own attempts to re-measure
the escape are disqualified in §1.1.

**What did change is the damage radius, so that is what I measured instead**,
and it is the decision-relevant question: does a bigger blast punish a player
who does the thing the card asks for? Paired arms at the same stand, 30 s each,
one standing still and one holding `KeyW`+`ShiftLeft` under the real input
path (`probeE-final.json` `reelBand`, four stands, unit placed 11 m behind the
survivor so `KeyW` runs directly away from it):

| stand | standing still, dps | sprinting away, dps | reel damage standing still | reel damage sprinting | closest approach sprinting |
|---|---|---|---|---|---|
| 0 | 5.56 | **1.15** | 132.3 | **0.0** | 11.01 m |
| 1 | 6.26 | **1.54** | 132.3 | **0.0** | 11.01 m |
| 2 | 6.65 | **0.77** | 132.3 | **0.0** | 11.01 m |
| 3 | 6.65 | **1.39** | 132.3 | **0.0** | 11.01 m |

**A survivor who runs takes zero reel damage at all four stands.** The reel is
still selected (3-4 times per arm), the pull still fires, and it still never
gets them inside the 9 m blast: the closest approach is 11.01 m at every stand,
against a mean distance of 4.6 m for the survivor who stands there. Total output
falls by 4.3x to 8.6x, to thorn chip alone.

That is the shape the card is supposed to have and both ends of it are now on
record: **ignore the reel and it costs 132.3 HP per 30 s and drags you to
contact; answer it and it costs nothing.** The bigger blast did not turn the
attack into an unavoidable one — it turned a telegraph nobody could be inside
into a telegraph that means something.

### 3.3 What is still true, and named

At one of six stands the Lasher spent a whole 30 s engagement blind
(`losFraction 0.008`, zero attacks, zero damage — `probeC-confirm.json`,
stand 0, standoff 8 m). Moving to 11 m raises the clear-LOS fraction from 0.605
to about 0.80 and the measured `losFraction` across thirty arms is 0.89 mean
with 27 of 30 above 0.79 — but it does not make the problem go away, because
`Enemy.pickAttack` returns -1 without LOS and `S.REPOSITION` will not call it
without LOS either. **The structural fix is in `Enemy.js`, which is not mine**:
a blind ranged unit should fall through to `CHASE` immediately rather than
orbit for 1.6 s at a radius it already cannot see from. Recorded, not fixed.

---

## 4. Items

### 4.1 MAJOR-4 — the impulse channel now sums

`src/systems/Items.js` `applyImpulse`: `Math.max` -> `+=`.

Measured from a standing jump, so the number *is* the impulse with no sprint
speed folded in (`probeB-items.json` `impulse`, peak airborne horizontal):

| held | before (critique probe 7) | after |
|---|---|---|
| nothing | — | 0.00 |
| 1x Updraft Vents | 15.15 | 4.68 (impulse 5) |
| 1x Waxed Wing | 20.15 | 9.36 (impulse 10) |
| **1x Waxed Wing + 1x Updraft Vents** | **20.15 — the Wing alone** | **14.03 (impulse 15)** |
| 2x Waxed Wing + 1x Updraft Vents | — | 23.39 (impulse 25) |
| Tectonic Heart + Waxed Wing, jumps 1/2/3 | — | 9.36 / 9.36 / **16.00** (10 + the Heart's 6 on the third) |

Summed rather than capped, and the comment says why: any cap low enough to
matter clips Waxed Wing's own printed linearity before it clips a combination,
and the largest single contributor was already unbounded under `Math.max`, so
summing adds no new order of magnitude.

Every trail above decays smoothly with no zero — none of these arms is inside
the band where `Stage.capsuleResolve` annihilates the launch (CRITICAL-1, the
physics fixer's). That was deliberate: the arms were chosen at or below 25 m/s,
which the critique's own table puts inside the working band. **The combined
inventories a real run reaches — several Waxed Wings plus Updraft Vents — will
land above 40 m/s and are the physics fix's business, not testable here.**
`src/world/Stage.js` was still unmodified in the working tree when these arms
ran and had been modified by the time I finished, so the high-stack band should
be re-measured against the physics fixer's build, not against this one.

### 4.2 MAJOR-2 — Temporal Echo x Conflagration

`src/data/abilities.js`: the `status: 'burn'` rider is gone from Conflagration's
own blasts. Snapshotting `_lit` closed the cascade within one cast; the rider
re-opened it across casts, because every detonation left a much larger burning
set behind for the echo 0.9 s later.

**Paired in one run, same build, same stand, same bodies** — the old code path
is reconstructed by wrapping `Combat.explode` to re-inject `status: 'burn'`, and
`abil.fire` is counted so no arm can silently be a one-cast arm
(`probeC-confirm.json` `echo`; ten pinned mites at 2.2 m, exactly one lit, crit
forced off):

| arm | casts | fire damage | vs printed 72 | burning after |
|---|---|---|---|---|
| no echo, shipped | 1 | 140.4 | 1.95x | 1 |
| **echo, shipped** | **2** | **277.3** | **3.85x** | **1** |
| no echo, burn rider reinstated (= `b18a2b4`) | 1 | 140.4 | 1.95x | 3 |
| **echo, burn rider reinstated (= `b18a2b4`)** | **2** | **673.1** | **9.35x** | **5** |

The baseline row reproduces the critique's 673.2 to within 0.1, which is what
makes the 277.3 meaningful. The free second cast is now worth **0.97x the
first** (136.9 against 140.4) instead of 4.79x — which is what the card says it
is. Bodies the player lit stay lit; `explode` cannot put a burn out, so the echo
still pays for setup that was actually spent.

### 4.3 MAJOR-3 — Conflagration's ceiling is stated

Not retuned. The critique's alternative — scaling per-blast damage by
`1 / sqrt(litCount)` — would push the mild formations *below* printed (the
8-at-3 m, 3-lit case goes from 1.76x to 1.01x), which is the same overshoot
shape the round warns about. The description is the contract, so the contract
now says it, and the card records the measured curve
(`probeB-items.json` `conflag`, pinned bodies, crit off):

| formation | printed | measured | ratio |
|---|---|---|---|
| 1 body, lit | 72 | **72.0** | 1.00x |
| 8 @3 m, 0 lit | 0 | 0 | — |
| 8 @3 m, 1 lit | 72 | 104.2 | 1.45x |
| 8 @3 m, 3 lit | 216 | 379.6 | 1.76x |
| **8 @1.2 m, all 8 lit** | **576** | **2302.9** | **4.00x** |
| 12 @1.5 m, all 12 lit | 864 | 2410.2 | 2.79x |

The ratio *falls* once the pack is wider than one blast, which is the bound: a
body inside K overlapping blasts pays at worst `1 + 0.35(K-1)` of printed, so
the cast plateaus near 4x and does not grow past it.

### 4.4 MAJOR-5 — Ashen Pact

Two things were wrong and both in the same direction. A fraction of *current*
health is an exponential decay onto the floor, so the bill shrinks every second
and the last one before the floor is nearly nothing; and the shared 30% floor is
exactly where Prey Instinct (below 40%) and Entropy Ledger (missing health) pay
best. `payHealth` now takes a per-card floor, and the pact bills
`maxHealth * linear(0.015, n)` at a **50%** floor.

Measured with the item really billing — no keep-alive, no topped-up health
(`probeB-items.json` `ashen`; 10x Ashen Pact + 1x Entropy Ledger + 1x Prey
Instinct):

| | before (critique probe 6) | after |
|---|---|---|
| settled health fraction | **0.303** | **0.501** |
| Entropy Ledger on a 100 hit | 169.7 (+69.7%, 87% of its 1-stack maximum) | **149.9 (+49.9%)** |
| Prey Instinct live | **true**, moveSpeed 8.26 | **false**, moveSpeed 7.00 = base |
| health fraction by second | 0.809 0.656 0.534 0.436 0.358 0.309 0.309 0.300 ... | 0.851 0.710 0.569 **0.501** 0.501 ... |
| survivor alive | yes | yes |

Both ends. At **10 stacks** the drain is 15% of maximum a second, so the bar
pins at 0.501 in four seconds and every point of regeneration and healing the
survivor receives from then on is eaten — a permanent, ongoing cost, not a
one-off eight seconds. At **1 stack** it is 1.5% of maximum a second against the
survivor's own regeneration, and the measured net is 0.0058 of maximum a second
(0.986 -> 0.905 over fourteen seconds) — it takes most of a stage to reach the
floor, which is the shape a single Lunar stack should have. Never lethal at
either end: `alive: true` in both arms.

What this deliberately does **not** do is make the card unplayable with Entropy
Ledger. +49.9% is still a large bonus. The difference is that the player now
gives up half their effective health bar for it and has to take real damage,
with real risk, to reach Prey Instinct's band on top — which is a build rather
than a freebie.

### 4.5 MINOR-3 — the Scrapfly is drawn

`src/data/items.js`. The card promised "release a scrapfly" and drew a beam that
teleported between two points once a second. The effect now ticks four times a
second: a mote (`vfx.hitSpark` at the fly's own position) is drawn on every
tick, the fly closes 0.18 per tick instead of 0.6 per second so it covers the
same ground, and the strike and the bleed still land once a second.

It also strikes exactly five times now, which it did not before, and finding
that out took three arms and one retracted conclusion — recorded because the
retraction is the point.

- `probeD-agency.json` `scrapfly`: 8 strikes, 37 motes, 124.8 damage over a
  20 s window. I read that as the new tick rate over-paying and wrote a cap
  against it.
- `probeF-scrapfly.json`, one release watched from its **first** tick with every
  instrument installed before the item is given: **4 strikes**, gaps
  1.07/1.06/1.07 s, 19 motes, 62.4 damage. So probe D's 8 was two releases
  inside its longer window, not one release paying double, and the justification
  I had written into the code was wrong. It is corrected there.
- The real defect the clean arm exposed is the opposite one: the card prints
  five strikes and paid **four**. `Items._tickEffects` re-arms `t` after
  subtracting the step, so a requested 0.25 s interval realises as 0.267 s and a
  5.0 s effect gets 19 ticks instead of 20. The old 1.0 s interval quantised to
  1.067 s and lost the same strike, so this predates the change.

Fixed by giving the effect 5.6 s of slack and letting the explicit counter own
the ceiling. Re-measured, one clean release (`probeF2-scrapfly.json`):

| | before this round | after |
|---|---|---|
| releases observed | 1 | 1 |
| strikes | **4** | **5** |
| bleeds | 4 | **5** |
| strike spacing | 1.07 / 1.06 / 1.07 s | 1.07 / 1.06 / 1.07 / 1.07 s |
| total strike damage | 62.4 | **78.0** = 5 x 15.6, the printed 130% |
| fly motes drawn | 19 | 22 |
| quarry alive | yes | yes |

---

## 5. Declined, with reasons

- **MINOR-4, two overlapping pyres double a body's cloud dps.** Kept, and the
  reasoning written into `Items._tickClouds`. Every overlapping AoE in the game
  pays per source; the flask has two charges precisely so overlapping them is a
  decision worth making; halving the second cloud makes the second charge worth
  nothing. The thing that must not stack is the *status*, and that is capped and
  verified (peak 1 burn stack with 2 clouds alive).
- **MINOR-5, the `outgoing` chain is fully multiplicative.** Kept, and recorded
  at `Items.modifyOutgoing` with the measured ceiling (x172.8 healthy, x5443.2
  at 20% health against an ailing target, at 10 of 11 items). It is the genre's
  shape and it is the reason a minute-25 inventory feels like a different game.
  The note also records the useful half of the finding: two cards, Chipped
  Whetstone at x8 and Entropy Ledger at x9, are x72 of the x172.8, so if a
  ceiling is ever wanted it belongs on the individual conditionals rather than
  on the product.
- **MAJOR-1 (`Engine.start`), MAJOR-7 (the burrower's slow), CRITICAL-1
  (`Stage.capsuleResolve`)** — not my files. The first was already fixed in the
  tree when I probed and I measured it at 1.00.

---

## 6. Build and capture

`node node_modules/vite/bin/vite.js build` — **exit 0**, `✓ built in 4.92s`,
only the pre-existing chunk-size advisory.

`node tools/capture.mjs --out reviews/round7/r4fix-content/shots --port 5497
--seed 1337` — **exit 0, 21/21 PNGs**, `ready: true`, `partial: false`,
`clockPinned: true`, `frameDt: 1/60`, `frameTimeouts: 0`.

**One failing check, and it is the known one.** `06-loaded-hud` /
"monsters under load": `px 759` against `minPx 300`, `visibleObjects 8/10`
against `minObjects 3`, `sepP50 0.69` against `minSep 0.25` — every gate it is
scored on passes except the per-object one, which fails on object 6
(`px 135, sepP50 0.13`, i.e. one monster of ten overlapping another). Same
subject, same check, same shape as `E-framing.md` §5 and as the last three
rounds. **Unchanged in kind and not chased.** It is the only console error in
the run (`errors: 1`), and it is that check announcing itself. Every other
scenario's checks pass.

Note for whoever reads the audio gate here: this manifest reports
`audioOk: true` with `stepsEmitted: 612`. That gate is the audio arm's
finding C2, not mine, and I am not offering it as evidence of anything.

---

## 7. Arms I did not test

1. **The suction against a sprinting player.** Both attempts disqualified
   (§1.1). The claim that agency is unchanged rests on `pull`/`range`/`minRange`
   being untouched, not on a measurement of mine.
2. **The impulse channel above ~25 m/s.** Deliberately avoided while
   `Stage.capsuleResolve` annihilates large launches; the combined inventories a
   real run reaches are exactly the untested band.
3. **Multiplayer.** Every `ctx.authority` guard is unexercised, as in rounds 3
   and 4's critique. `Items.applyImpulse` now sums on a channel that
   `Player._jump` records and replays per tick — the replay path is read, not
   run.
4. **The Lasher against a *moving* player's reel damage** beyond the paired
   sprint arm in §3.2: no arm samples a player who strafes, dashes or jumps out
   of the 9 m blast.
5. **The Lasher in a pack** (`packMax: 2`) and **with elite affixes**. Every arm
   is one clean unit.
6. **Ashen Pact against healing items.** The steady state is "all healing is
   eaten", and I measured that against the survivor's passive regeneration only,
   not against Aid Kit / Blood Siphon / a Cauterizer.
7. **Conflagration with crit live.** Every ability arm forces `critChance = 0`.
8. **The Scrapfly's re-acquire** after a kill, under the new tick rate. Probe B
   saw it work at the old rate (one body died at t+1.0, the fly struck the
   second) and lost a strike in the gap; probes E and F use a durable quarry so
   they never re-acquire. The interaction between the new `struck >= 5` counter
   and a re-acquire gap — whether a strike lost to a dead quarry is now
   permanently lost rather than shifted — is **not** tested and is the most
   likely place for this change to be wrong.
9. **The Redoubt's `backblast`** — the comment was corrected from arithmetic and
   code reading, not from a fired nova.
10. **`EnemyMeshes.js` and `CharacterMesh.js`** are untouched, so nothing in
    them was re-verified.
