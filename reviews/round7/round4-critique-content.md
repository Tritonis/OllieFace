# Round 7 — round-4 (FINAL) critique: content

Reviewer: independent round-4 critic. Fresh eyes; not involved in building or
fixing any of this. Branch `round7/content-and-polish`, HEAD `a43cc70` (i.e.
with `Engine._loopGen` and the physics `capsuleResolve` work already in the
tree). Bar: shipped AAA quality. `RUBRIC.md` caps this project at four critic
rounds, so this is the last word on this domain.

Scope: `src/data/enemies.js`, `src/data/items.js`, `src/data/abilities.js`,
`src/systems/Items.js`, and the interactions those reach into
(`src/entities/Enemy.js`, `src/systems/Combat.js`). Inputs treated as claims to
re-derive, never as facts: the round-4 fix report
`reviews/round7/round4-fix-content.md` and the round-3 critique it answers,
`reviews/round7/round3-critique-content.md`.

**Headline: the Bramble Lasher rework is the best-evidenced fix in this round —
I reproduced its two headline numbers to the third decimal on an instrument the
fixer did not have, and I closed the agency arm it honestly declined to claim.
But the fixer nominated eight untested arms, and the two that mattered both
fail. Conflagration's "plateaus near 4x" ceiling — now written into the card as
the player-facing contract — is wrong; the real figure is 10.19x, and 20.39x
with crit. And a *blazing* Bramble Lasher does 73.95 dps against a survivor with
110 maximum health: 5.3x an affix that costs the Director the same 4.5 credits,
on the same card, at the same stand. The affix table is not this round's work,
but the round-4 Lasher fix is precisely what parks the player inside the aura
that feeds it, and no round has ever measured it.**

---

## Severity table

| ID | Sev | Finding | Where |
|---|---|---|---|
| **C1** | **CRITICAL** | A blazing Bramble Lasher deals **73.95 dps** against a 110-HP survivor — 5.3x equal-cost `glacial`, 11.4x the plain card. Player burn stacks are uncapped (`Combat.applyStatus`), the blazing aura applies one every 0.5 s inside 3.2 m, and this round's reel/`preferredRange` fix is what holds the player at a mean 4.35 m. Named untested by the fixer (§7.5). | `src/data/enemies.js:1350`, `src/entities/Enemy.js:467-475`, `src/systems/Combat.js:562-582` |
| **M1** | **MAJOR** | Conflagration's stated ceiling is wrong and is now the contract. The card comment asserts "plateaus near 4x printed and does not grow past it" and "the ratio falls, not rises". Measured: **5.59x / 6.72x / 10.19x** as the pack tightens, **20.39x** with crit. The `1 + 0.35(K-1)` bound applies the falloff *minimum* as if it were the average. The same wrong figure was used to decline a retune. | `src/data/abilities.js:1294-1305, 1241` |
| **M2** | **MAJOR** | Waxed Wing's printed linearity is unrealisable past ~4 stacks. Peak launch scales cleanly and without bound (9.88 → **99.88** m/s at x10; **148.57** with x10 vents), but delivered displacement saturates at **~26 m** from x4 onward, and the x8/x10 launches end in a single-step velocity zero (75.03→0, 95.5→0). Named untested by the fixer (§7.2) and handed to the physics arm; on the physics-fixed build it is still unreached. | `src/data/items.js:857-867`, `src/systems/Items.js:745` |
| **D1** | MODERATE | Scrapfly Hive's printed five strikes is conditional on an unbroken quarry supply. A replacement arriving 3 s late costs **2 of the 5 permanently**. This is the exact failure the fixer nominated as "the most likely place for this change to be wrong" (§7.8). | `src/data/items.js:1236-1268` |
| **D2** | MODERATE | "Every point of regeneration and healing the survivor receives from then on is eaten" is false. With 10x Ashen Pact + 10x Medkit + 10x Leeching Seed while fighting, the survivor sits at **1.000** of maximum for 13 of 14 s. Named untested by the fixer (§7.6). | `src/data/items.js:1778-1810` |
| **D3** | MODERATE | The roster ordering does not reproduce. The fixer puts Siege Bombard at 3.84/3.36 dps, below the reworked Lasher; I measure **9.81 / 9.82 / 9.80** at three stands — above it. Per credit the Lasher is the second-worst card in the six-card sample. | `reviews/round7/r5-content/probeA.json` → `roster` |
| **N1** | MINOR | Ashen Pact's break-even against a common healing item is a cliff, not a curve: 5 stacks of Leeching Seed settles at 0.558 *and still falling*; 10 settles at 0.925. A build pays the whole drawback or none of it. | `probeE.json` → `ashenHeal` |
| **N2** | MINOR | A stationary survivor reeled from a 6 m standoff ends at `minDist` **0.013 m** — inside the unit's own capsule — at all four stands. | `probeB.json` → `pairs[*].live.minDist` |
| **N3** | MINOR | `src/data/items.js:1233` states "22 of them per release, measured" as fact for the fly's motes. No instrument in this round can reproduce a fly-specific mote count; mine is not fly-specific and reads 104 on the same release. Unverifiable, and stated as measured. | `src/data/items.js:1233` |

**No new probes were needed.** Every number below comes from the JSON already on
disk in `reviews/round7/r5-content/`. Where that evidence could not settle a
claim, it is marked unverifiable rather than softened — including the one place
(M2) where I initially wanted a new probe and found the existing data already
discriminates the hypothesis. See "Why M2 did not need a new probe".

---

## Methodology

Everything below was measured live against HEAD `a43cc70`. The drivers are the
record of what was done and were read in full before any log line was trusted;
they were deleted after this report was written and every figure in it sourced.
`git status --porcelain -uno` is **empty** — no product code was modified.
`node node_modules/vite/bin/vite.js build` — **exit 0**, `✓ built in 921ms`,
only the pre-existing chunk-size advisory.

| driver (deleted) | artefact | what it did |
|---|---|---|
| `tools/_r5boot.mjs` | — | shared launch: headed Chromium, `--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization --force_high_performance_gpu`, window parked off-screen, own Vite server per probe on ports **5501-5506** (never 5199), `?seed=1337&quality=1&harness=1&pinclock=1`, then `pinClock(1/60)` → `gameplay()` → `thaw()` |
| `tools/_r5timing.mjs` | `timing.json` / `.log` | engine-loop census, direct step-rate, `__HARNESS__.determinism()` |
| `tools/_r5probeA.mjs` | `probeA.json` / `.log` | Lasher dps at 4 stands x 5 standoffs (20 arms x 30 s) with per-attack pick census, LOS and distance; 6-card roster at 3 stands; `packMax` pairs; all 5 elite affixes at 2 stands |
| `tools/_r5probeB.mjs` | `probeB.json` / `.log` | the agency arm: 32 paired live/pull-muted reels at 4 stands x 4 reactions x 2 standoffs, two independent displacement instruments plus a muted control |
| `tools/_r5probeC.mjs` | `probeC.json` / `.log` | first pass at the item arms — **superseded by probe D**, retained for the x10-wing + x10-vents impulse row and as the record of its own failed spot search |
| `tools/_r5probeD.mjs` | `probeD.json` / `.log` | corrected item arms: impulse over 4 bearings with displacement + a `capsuleResolve` zero counter; Conflagration on a planar cluster through the real `abilityUsed` event; Ashen Pact with health set after the items |
| `tools/_r5probeE.mjs` | `probeE.json` / `.log` | Scrapfly strike/bleed/mote accounting across quarry-death and replacement timings + 10-stack scaling; Ashen Pact heal-vs-drain settle curves |

Every arm is `ctx.time`-based. `frameErrors: 0` and `errors: []` in **all five**
probe records.

### Instrument sanity — including three failures of my own

The standing expectation on this project (`round3-SUMMARY.md`, "Instrument
discipline") is that a critic disqualifies its own evidence rather than shipping
it. Four things here required that.

- **The engine fix is not in these numbers, and this is measured, not assumed.**
  `timing.json` → `engineLoops`: `framesPerRaf 1`, `frames 60`, `raf 60` after
  `gameplay(); thaw()`. `determinism`: `clockPinned true`, `frameDt 1/60`,
  `frameTimeouts 0`. Against the 2.00 the round-3 critique measured at `b18a2b4`.
- **The gate was failed on purpose.** `probeB.json` → `control` is the reel arm
  with `Enemy.pullPlayer` stubbed to a no-op: `extIntegralMagnitude` **0**,
  `extIntegralAlongPull` **0**, `reelDamage` **0**, `reversedSteps` **0**. The
  suction instrument reads exactly zero when the suction is removed and non-zero
  when it is not. This is the control round 3 said every gate needs.
- **Two instruments, required to agree, and reported where they don't.** Ground
  stolen is measured both as the integral of `Player._external` along the escape
  bearing (`groundStolen_ext`) and as a paired live/muted endpoint difference
  (`groundStolen_paired`). They agree exactly where they measure the same thing
  (`active` @11 m: **3.5294** vs **3.5294** at three of four stands) and diverge
  where the geometry makes them measure different things (`strafe` @6 m: 4.79
  paired vs 2.12 ext — the ext integral only sees the along-bearing component of
  a sideways move). Where they diverge I quote the paired figure and say so.
- **Failure 1 — probe C's spot search silently failed.** `probeC.log` line 3:
  `flat spot {"x":0,"y":3.38,"z":0,"relief":-1}`. `relief: -1` is the driver's
  fallback for "found nothing", so every probe-C impulse and Conflagration arm
  ran at the world origin on unvalidated ground. **Probe C's item numbers are
  disqualified** and probe D supersedes them; probe C is quoted below for
  exactly one row (x10 wing + x10 vents, where the fact of interest is the peak,
  not the ground) and as the record of the failure.
- **Failure 2 — `aliveAfter` and `enemiesOnStage` in probe A are meaningless.**
  `_r5probeA.mjs:136` calls `ctx.director.clear(ctx)` *before* the return object
  on lines 137-147 is constructed, so both fields read the state after the
  clear. They are `0` in all 41 arms and nothing may be inferred from them.
  Unit liveness is instead established by `losFraction`, which is gated on
  `u.alive` per step and reads 1.000 in 13 of 20 Lasher arms (mean 0.947, worst 0.422).
- **Failure 3 — a cross-arm damage-attribution leak, quantified and excluded.**
  The `overloading` stand-0 elite arm books `"burn": 157.5`, but `overloading`
  has no `burn` and no `auraDps` key (`enemies.js:1351`) and there are only
  three paths in `Enemy.js` that can burn the player, all gated on those two
  fields. The `overloading` stand-1 arm books no burn at all. The signature is
  carryover from the preceding blazing arm through a recycled `Enemy` instance,
  which defeats the `K.mine.has(info.source)` foreign-damage filter. It is
  self-consistent to the decimal: blazing s1 (1995.0) − blazing s0 (1837.5) =
  **157.5**, the same figure. **Load-bearing consequence: the blazing figure I
  quote is stand 0's 73.95 dps, which is the first elite arm and preceded only
  by plain-Lasher pack arms that book zero burn — it cannot be contaminated.**
  Stand 1 corrects from 80.08 to 74.63. `overloading` corrects to 13.05/14.02.
- **A uniform 2-5% dps inflation, disclosed.** 1800 pinned `_frame()` calls
  advance `ctx.time` by 28.47-29.43 s, not 30.00. All dps figures are
  `damage / ctx.time` and are therefore 2-5% high against a wall-clock 30 s. It
  is uniform across arms, so every comparison in this report holds.

### Fixture discipline, and where mine is weaker than the fixer's

The fixer's §1 makes a point of using 4 000/20 000-HP fixtures rather than
punchbags. **My Conflagration bodies have 400 000 HP, which is a punchbag**, and
I say so before quoting them. It does not change the M1 conclusion — the
fixer's own arms deal 2 302.9 across 8 bodies (288 each), nowhere near even a
4 000-HP fixture's threshold, so no arm on either side was truncated by a death
— but the disclosure belongs before the number, not after it.

Where my fixtures are *stronger*: probe A pins `director.level`, `healthMult`
and `damageMult` to 1 at every spawn (the difficulty curve steps `damage` 20%
per level, so arm 20 is otherwise not arm 1), disables the Director outright,
and attributes damage by `info.source` rather than `info.type`. The check that
this held: `foreignDamage` is **0.0 in all 41 arms**.

---

## Verification table — round 4's claims

21 confirmed, 5 refuted, 4 unverifiable.

| # | §  | Round 4's claim | My number | Verdict |
|---|---|---|---|---|
| 1 | 1 | `engineLoops: 1.00` per rAF after `gameplay()`/`thaw()` | `framesPerRaf 1`, 60 `_frame` per 60 rAF; `frameTimeouts 0`. `timing.json` | **CONFIRMED** |
| 2 | 3.1 | Lasher dps 0.00-10.03, mean **6.5** across 30 arms | 20 arms, 4 stands x 5 standoffs: **3.04-8.50, mean 6.101, median 6.05**. `probeA.json` → `lasher` | **CONFIRMED** (mean within 6%) |
| 3 | 3.1 | Reel's share ~60%; `pull` present in 28 of 30 arms | `pull` = **63.8%** of 3 512.1 HP total; present in **20 of 20** | **CONFIRMED**, and stronger |
| 4 | 3.1 | Split reel ~60 / thorns ~23 / flail ~17 | **63.8 / 23.7 / 12.6** | **CONFIRMED** |
| 5 | 3.1 | `flail` 1-5 selections per arm; `melee` damage in 20 of 30 | 1-5 per arm exactly; melee damage in **12 of 20** (60% vs 67%) | **CONFIRMED** |
| 6 | 3.1 | The reworked card beats the 9-credit tier-1 Spitling | Lasher **6.24 / 6.19 / 7.89** vs Spitling **4.56 / 4.56 / 4.56** at 12 m, 3 stands | **CONFIRMED** |
| 7 | 3.1 | It sits at roughly half the tier's turret | Lasher mean 6.77 vs Basalt Sentinel mean 15.18 → **0.446** | **CONFIRMED** |
| 8 | 3.1 | Siege Bombard 3.84/3.36 — below the Lasher | **9.81 / 9.82 / 9.80** at three stands, *above* the Lasher at all three | **REFUTED** — D3 |
| 9 | 3.2 | A survivor who runs takes **zero** reel damage; closest approach **11.01 m** at every stand | `reelDamage` **0.0** in all 8 `tell` arms; `minDist` **11.0189** at all four stands @11 m, **6.0189** @6 m. `probeB.json` | **CONFIRMED** to 3 dp, independent instrument |
| 10 | 3.2 | Ignore the reel and it costs **132.3 HP** per 30 s and drags you to contact | `pull` = **132.3** at 3 of 4 stands @11 m (122.85 at the 4th); `minDist` 4.73 @11 m and **0.013** @6 m | **CONFIRMED** exactly |
| 11 | 3.2 | `pull: 26` never reverses a sprinting player for a frame | `reversedSteps` **0** in all 8 sprinting (`tell`) arms. In the `active` arms — where the player is standing when the suction lands — it is **1 of 91 steps** (17 ms) before sprint acceleration wins | **CONFIRMED** as scoped |
| 12 | 3.2 | The bigger blast did not make the attack unavoidable | Both ends now on record from one instrument: react to the tell and it costs **0.02-1.09 m** of a 38.4 m escape and 0 damage; ignore it and you lose 5.31-6.27 m and take 18.9-37.8 | **CONFIRMED** |
| 13 | 3.3 | At one stand in six the unit was blind for a whole engagement (`losFraction 0.008`) | **Not reproduced** in 20 arms across 4 different stands. Worst `losFraction` **0.422** (stand 3 @22 m); mean **0.947** against their 0.89 | **UNVERIFIABLE** (different stand sample; a tail event I cannot refute) |
| 14 | 4.1 | `applyImpulse` sums instead of capping | `Items.js:745` is `this._pendingImpulse += speed`, and it measures: **0 / 4.88 / 9.88 / 14.88 / 24.88** for none / vents / wing / wing+vents / 2wing+vents; Tectonic's third jump **16.00** in both reports | **CONFIRMED** |
| 15 | 4.1 | "Summing adds no new order of magnitude"; a cap would clip Waxed Wing's own printed linearity | True of **peak speed** (linear to 99.88 at x10, 148.57 with x10 vents). False of **delivered distance**, which saturates at ~26 m from x4 | **REFUTED in part** — M2 |
| 16 | 4.1 / 7.2 | The high-stack band is the physics fixer's business; re-measure against their build | Done, on `a43cc70`. Round 3 measured peaks of **5.55 / 8.33 / 10.15 / 10.15** at x4/x5/x8/x10; they are now **39.88 / 49.88 / 79.88 / 99.88**. The physics CRITICAL-1 annihilation of peak velocity **is fixed** | **CONFIRMED** (cross-domain) |
| 17 | 4.2 | Dropping the `status: 'burn'` rider closes the cross-cast cascade | `burningAfter` **1** shipped vs **8** (no echo) / **10** (echo) with the rider reinstated; echo amplification **8.42x** shipped vs **41.88x** with the rider. `probeD.json` → `conflag` | **CONFIRMED** in mechanism; their absolute figures not reproduced (see M1 note) |
| 18 | 4.2 | The free second cast is now worth **0.97x** the first, not 4.79x | 606.1 with echo vs 290.5 without → second cast **1.086x** the first | **CONFIRMED in substance** |
| 19 | 4.3 | "The whole cast plateaus near 4x printed and does not grow past it"; "the ratio falls, not rises, once the pack is wider than one blast" | 8@1.2/8 lit **5.59x**; 12@1.5/12 lit **6.72x** (rises); 16@1.0/16 lit **10.19x**; with crit **11.18x** and **20.39x** | **REFUTED** — M1 |
| 20 | 4.3 | The `1/sqrt(litCount)` retune was declined because it pushes 8@3 m/3-lit from 1.76x below printed to 1.01x | My 8@3/3-lit is **2.53x**; 2.53/√3 = **1.46x**, comfortably above printed. The stated reason for declining rests on the same contaminated geometry | **REFUTED** — M1 |
| 21 | 4.4 | Ashen Pact settles at **0.501**; Ledger on a 100 hit **149.9**; Prey Instinct **false**; moveSpeed **7.00**; trace 0.851 / 0.710 / 0.569 / 0.501 | `probeD.json` → `ashen[2]`: settled **0.501**, `outgoingOn100` **149.9**, `preyLive` **false**, `moveSpeed` **7.00**, trace `[1, 0.851, 0.71, 0.57, 0.501, 0.501, …]` | **CONFIRMED** digit for digit |
| 22 | 4.4 | 1 stack: 0.986 → **0.905** over fourteen seconds | 1 → **0.903** over fifteen. `probeD.json` → `ashen[1]` | **CONFIRMED** |
| 23 | 4.4 | Never lethal at either end — `alive: true` | `alive: true` in all 6 probe-D arms and all 7 probe-E arms; the floor holds at 0.500-0.525 | **CONFIRMED** |
| 24 | 4.4 | At 10 stacks "every point of regeneration and healing the survivor receives from then on is eaten — a permanent, ongoing cost" | 10x pact + 10x medkit + 10x burr, fighting: settled **1.000**, full health for 13 of 14 s | **REFUTED** — D2 |
| 25 | 4.5 | One clean release: **5 strikes**, 5 bleeds, **78.0** = 5 x 15.6, spacing 1.07/1.06/1.07/1.07, quarry alive | `strikes 5`, `bleedTicks 35`, `strikeDamage 78`, `perStrike [15.6 x5]`, `gaps [1.066, 1.067, 1.067, 1.066]`. `probeE.json` → `scrapfly[0]` | **CONFIRMED** exactly |
| 26 | 4.5 | 22 fly motes drawn per release | My `hitSpark` counter is global, not fly-specific: 104 on the same release, and it scales with strikes and bleed ticks (11 on a 1-strike arm) | **UNVERIFIABLE** — N3 |
| 27 | 7.8 | *Their own nominated weak point:* whether a strike lost to a dead quarry is now permanently lost | It is. 6 spare bodies → **5** strikes; one spare → **2**; none → **1**; replacement at 3 s → **3**, gaps `[2.933, 1.067]` | **CONFIRMED as a defect** — D1 |
| 28 | 6 | Build exit 0; capture 21/21, `ready true`, `partial false`, `clockPinned true`, `frameTimeouts 0`; one failing check, `06-loaded-hud` `px 759`/`minPx 300`, `visibleObjects 8/10`, `sepP50 0.69`, failing object 6 at `px 135, sepP50 0.13` | Every figure verified against `r4fix-content/shots/manifest.json` on disk; 21 scenarios; `errors` is exactly that one check announcing itself. My own build: exit 0 | **CONFIRMED** verbatim |
| 29 | 2 / MINOR-1 | Redoubt's counterplay band is 9-13 m | Holds `meanDist` **11.53-12.00**, `minDist` **11.50-12.00** at three stands | **CONFIRMED** |
| 30 | 5 / MINOR-5 | The multiplicative `outgoing` chain reaches x172.8 healthy and x5443.2 at 20% health | Only measured `modifyOutgoing(100)` at 1.499x with two items. The 11-item arm was not run | **UNVERIFIABLE** |
| 31 | 5 / MINOR-4 | Two overlapping pyres peak at 1 burn stack | Not measured by any arm of mine | **UNVERIFIABLE** |
| 32 | 7.5 | *Named untested:* the Lasher in a pack | 2 Lashers @11 m: **15.21 / 11.74 / 13.29**, mean 13.41, against 6.46 solo — **2.08x**, additive, no compounding | **CLEAN** (new arm) |
| 33 | 7.5 | *Named untested:* the Lasher with elite affixes | blazing **73.95 dps**; glacial 13.90/13.86; withering 21.06/22.29; warded 15.28/16.20; overloading 13.05/14.02 | **CRITICAL** — C1 (new arm) |
| 34 | 7.7 | *Named untested:* Conflagration with crit live | Exactly **2.00x**, both formations (3221.1→6442.1; 11744.0→23487.9). No interaction with the overlap term | **CLEAN** (new arm), but it doubles M1's ceiling |

---

## Findings, most severe first

### C1 — CRITICAL — a blazing Bramble Lasher kills a full-health survivor in under two seconds, and this round's fix is what lets it

**Where:** `src/data/enemies.js:1350` (`blazing: { … burn: 0.35, auraRadius: 3.2, auraDps: 0.35 }`), `src/entities/Enemy.js:467-475` (the aura), `src/systems/Combat.js:562-582` (`applyStatus`), amplified by `src/data/enemies.js:618, 701-702, 745` (this round's `preferredRange`, `blast` and `flail.range` changes).

**Measured.** All five affixes, on the same card, at the same two stands, at the
same 11 m standoff, 30 s each, identical stationary survivor
(`probeA.json` → `elite`). Carryover-corrected per Methodology "Failure 3":

| affix | Director cost | dps (stand 0) | dps (stand 1) | damage in 30 s | `events` |
|---|---|---|---|---|---|
| **blazing** | **4.5** | **73.95** | 74.63 | **2 133.6** | **182** |
| glacial | 4.5 | 13.90 | 13.86 | 399.0 | 19 |
| overloading | 5.0 | 13.05 | 14.02 | 375.9 | 33 |
| warded | 7.2 | 15.28 | 16.20 | 438.9 | 19 |
| withering | 6.8 | 21.06 | 22.29 | 579.8 | 40 |
| *(no affix, same stand/standoff)* | — | 6.46 mean | | 178.5-227.8 | |

Blazing is **5.32x** glacial at an identical 4.5-credit cost, **3.5x**
withering at 66% of withering's cost, and **11.4x** the plain card. Of its
2 133.6 HP, **1 837.5 is `burn`** — more than four times the *entire* output of
any other tier-1 affix arm.

**Mechanism, read from source and consistent with the numbers.**
`Combat.applyStatus` (`Combat.js:562-582`) pushes `count` new entries onto the
target's status list with **no cap of any kind**. `burn` is
`{ duration: 4.0, tick: 0.5, stackDamage: 0.25 }` (`Combat.js:25`), so at the
elite's `damage` of 42 (21 base x the affix's 2.0, confirmed by
`unitDamageStat: 42`) one stack pays 10.5 every 0.5 s for 4 s = 84 HP. The
blazing aura fires every 0.5 s while `distToPlayer < 3.2`, and each firing does
*both* `hurtPlayer(damage * 0.35, 'burn')` **and** `statusPlayer('burn', 1)`
(`Enemy.js:472-473`). Two new stacks per second, each living four seconds,
against no cap. 1 837.5 / 84 = **21.9 stack-lifetimes in 29 s**, i.e. the
survivor was inside 3.2 m for roughly 28% of the arm — which is exactly what
`meanDist 4.35, minDist 0.01` describes.

**Why this round owns it even though it did not write the affix table.** The
aura's radius is 3.2 m. The fixer's own §3 computes that the *pre-fix* card, at
`preferredRange: 18`, left a stationary player at **15.6 m** — 4.9x outside the
aura, which is why no previous round ever saw this. This round moved
`preferredRange` to 11, widened the reel `blast` from 6 to 9, and extended
`flail.range` from 4.2 to 6.5 specifically so that "6.5 is … where the reel
leaves the player". It worked: my `probeB` measures a stationary survivor reeled
from 11 m to `minDist` 4.73 m and from 6 m to **0.013 m**, and the elite arms
sit at `meanDist` **4.35 m**. The fix is correct on its own terms and it
delivers the player into an uncapped burn aura.

**The honest caveat, stated up front.** My survivor is topped to `maxHealth`
every frame, so stacks accumulate for 30 s where a real survivor dies at ~1.5 s
(73.95 dps against the 110 `maxHealth` measured in `probeD.json` → `ashen`, or
1.9 s against the 143 in `probeE.json`). The 73.95 figure is therefore a *rate*,
not a survivable outcome, and it is the punchbag trap inverted. **The
load-bearing number is not the absolute dps — it is the 5.32x ratio against
glacial**, which was measured on the same fixture with the same pinning and so
cancels the caveat entirely. And `probeB` establishes that the counterplay is
real: a survivor who answers the telegraph never gets closer than 11.02 m and
never enters the aura. What is not defensible is that the cheapest tier-1 affix,
unlocked at difficulty 0, is 5x the next-worst on the one card in the roster
whose whole design is to stop the player from running.

**What I would do:** cap concurrent `burn` stacks on the player in
`Combat.applyStatus`, or stop the aura applying a status on top of its direct
damage tick (`Enemy.js:473`). Either is a one-line change; the second is the
smaller one and leaves the aura's printed 0.35 dps meaning what it says.

---

### M1 — MAJOR — Conflagration's ceiling is wrong, it is now the player-facing contract, and it was used to decline a retune

**Where:** `src/data/abilities.js:1294-1305` (the comment asserting the bound) and `:1241` (the description that the fix report calls "the contract").

**What the code claims.** Verbatim from `abilities.js:1294-1301`:

> "a body inside K overlapping blasts pays at worst 1 + 0.35(K-1) of the printed
> 600%, so the whole cast plateaus near 4x printed and does not grow past it.
> Measured: … 8 at 1.2 m all lit pay 4.00x (2302.9 against 576); 12 at 1.5 m all
> lit pay 2.79x (2410.2 against 864) — **the ratio falls, not rises**, once the
> pack is wider than one blast."

**Measured** (`probeD.json` → `conflag`; a square cluster on one plane, bodies
re-pinned every frame, one cast counted, crit forced off unless stated):

| formation | printed | fix report | **mine** | ratio |
|---|---|---|---|---|
| 1 body, lit | 72 | 72.0 (1.00x) | **72.0** | **1.00x** |
| 8 @3 m, 0 lit | 0 | 0 | **0** | — |
| 8 @3 m, 1 lit | 72 | 104.2 (1.45x) | **162.7** | **2.26x** |
| 8 @3 m, 3 lit | 216 | 379.6 (1.76x) | **545.9** | **2.53x** |
| 8 @1.2 m, 8 lit | 576 | 2 302.9 (**4.00x**) | **3 221.1** | **5.59x** |
| 12 @1.5 m, 12 lit | 864 | 2 410.2 (**2.79x**) | **5 802.2** | **6.72x** |
| **16 @1.0 m, 16 lit** | 1 152 | *not run* | **11 744.0** | **10.19x** |
| 8 @1.2 m, 8 lit, **crit** | 576 | *not run* | **6 442.1** | **11.18x** |
| **16 @1.0 m, 16 lit, crit** | 1 152 | *not run* | **23 487.9** | **20.39x** |

Three separate parts of the claim fail:

1. **The ratio rises, it does not fall.** 12 bodies at *wider* 1.5 m spacing pay
   **6.72x** against 8 bodies at 1.2 m paying 5.59x. The fixer's own two
   formations, re-run, invert their ordering.
2. **There is no plateau near 4x.** 16 at 1.0 m is 10.19x — 2.5x past the stated
   ceiling — and crit is a clean **2.00x** on top (verification-table row 34),
   taking it to 20.39x for a single Special cast.
3. **The algebra is wrong, not just the fixture.** `falloff` bottoms out at
   0.35; the comment uses that *minimum* as if it were the *average*
   contribution of every overlapping blast. Recovering the average from my own
   data: at 16 @1.0 m the grid's longest diagonal is 3√2 = 4.24 m, inside the
   5.5 m blast, so every one of the 16 blasts reaches every one of the 16
   bodies. Ratio = K·f̄ gives f̄ = 10.19/16 = **0.637**, not 0.35. The true shape
   is **linear in the number of overlapping blasts**, with a coefficient nearly
   twice the assumed one. Nothing in the mechanic produces a plateau.

**Why I believe my geometry and not theirs.** Probe D's header names the
correction: probe C laid the bodies along a *line* over sloped ground, and
`Combat.sphereOverlap` tests in 3-D (`Combat.js:151-171`, comparing against the
capsule *centre*), so neighbours drop out on a hillside and every ratio comes
out low. Probe C, uncorrected, produced **2.47x** and **2.65x** for the two
formations — bracketing the fix report's 4.00x and 2.79x from below. The fix
report's numbers sit between a known-bad arrangement and a controlled one, which
is the signature of partial contamination. Probe D pins all bodies to a common
Y in a square. **Neither fixture is truncated by deaths** — 2 302.9 across 8
bodies is 288 each, far under even a 4 000-HP fixture — so mortality is not the
explanation and my 400 000-HP punchbags are not doing the work here.

**Why this is MAJOR and not MODERATE.** The wrong number is not confined to a
report. It is (a) written into the shipping source as measured fact, (b) the
stated justification for declining the `1/sqrt(litCount)` retune the round-3
critique proposed — and that justification independently fails, because with my
8@3/3-lit figure of 2.53x the retune lands at 2.53/√3 = **1.46x**, above printed,
not the 1.01x the comment claims — and (c) the reason the player-facing string
says only "pays several times over" for something that pays twenty times over.
The fix report's §4.3 heading is "Conflagration's ceiling is **stated**". The
ceiling that is stated is not the ceiling.

The half of §4.2 that is *right* deserves saying plainly, because it is the more
important half: **removing the `status: 'burn'` rider genuinely closes the
cross-cast cascade.** `burningAfter` is 1 on the shipped path and 8 (no echo) /
**10** (echo) with the rider reinstated, and Temporal Echo's amplification drops
from **41.88x** to **8.42x**. That is the defect round 3 found, and it is fixed.

---

### M2 — MAJOR — Waxed Wing's printed linearity cannot be delivered past ~4 stacks

**Where:** `src/data/items.js:857-867` (`Every jump boosts you forward by ${linear(10, n)} m/s`), `src/systems/Items.js:745`.

The summing fix itself is correct and I confirm it (row 14). What the fixer
declined to measure — §7.2, "the impulse channel above ~25 m/s … deliberately
avoided while `Stage.capsuleResolve` annihilates large launches … the combined
inventories a real run reaches are exactly the untested band" — is measured
here, on the build that contains the physics fix.

Four bearings from the flattest walkable spot the search could find (best of 400
candidates; relief 5.44 m over a 16 m radius). `probeD.json` → `impulse`:

| stacks | peak (m/s), 4 bearings | displacement (m), 4 bearings | air steps | `capsuleResolve` zeroes |
|---|---|---|---|---|
| x1 | 9.88 x4 | 5.73 / 6.61 / 6.66 / 5.15 | 45-60 | 0 |
| x2 | 19.88 x4 | 16.34 / 16.56 / 13.61 / 8.32 | 25-58 | 0 |
| x3 | 29.88 x4 | 23.02 / 20.63 / 16.34 / 7.77 | 14-51 | 1 |
| x4 | 39.88 / 39.88 / 39.88 / 38.57 | **25.15** / 23.22 / 18.26 / 7.43 | 9-45 | 0 |
| x5 | 48.57 / 49.88 / 49.88 / 45.70 | **25.77** / 24.08 / 19.91 / 6.88 | 4-39 | 0 |
| x8 | 77.13 / 79.88 / 79.88 / 75.70 | **26.49** / 21.67 / 22.29 / 11.25 | 1-25 | **1 / 1 / 0 / 0** |
| x10 | 97.13 / 99.88 / 99.88 / 97.13 | **26.33** / 21.71 / 21.69 / 14.27 | 1-57 | **1 / 1 / 2 / 0** |

Plus, from probe C: **x10 wing + x10 vents peaks at 148.57 m/s** — the channel
has no bound at all.

Three things follow.

1. **The physics fix landed, and this is the content-side confirmation of it.**
   Round 3's critique measured peaks of 5.55 / 8.33 / 10.15 / 10.15 at
   x4/x5/x8/x10 — *below* the unloaded baseline, the annihilation signature. On
   `a43cc70` those are 39.88 / 49.88 / 79.88 / 99.88, linear to ten stacks. The
   speed-triggered annihilation is gone.
2. **Distance stops being bought at four stacks.** Best-bearing displacement is
   25.15 m at x4, 25.77 at x5, 26.49 at x8, and 26.33 at x10 — flat, and the
   x10 figure is *below* the x8 one. A player who takes the fifth, sixth or
   tenth Waxed Wing gets no additional ground anywhere the search could find.
   The card promises `+10 m/s` per stack; that promise is realisable in the
   stat and not in the world.
3. **The extra speed converts into a dead stop.** At x8 and x10, `capsuleResolve`
   hands back a horizontal velocity of 0 from an input of 75.03 and 95.50
   respectively — the `trail0` rows show 19 frames at ~76 m/s then `0`, and 15
   frames at ~96 m/s then `0`, with no rebound. Airborne frames collapse from
   57-58 at x2 to **1** at x8/x10 on two of four bearings. Whatever the player
   is meant to feel at 96 m/s, a single-frame stop at 0.25 s is not it.

Bearing sensitivity is also worth recording as a design fact: the fourth bearing
(yaw 4.712 rad) yields 6.88-14.27 m against the first bearing's 25-26 m, so the
item's value swings 2-4x on which way the survivor happened to be facing.

#### Why M2 did not need a new probe

I intended to write one, to separate "`capsuleResolve` still annihilates, just
at a higher threshold" from "the player hit a hill". **The data already
discriminates it.** Four different launch speeds — 39.88, 48.57, 77.13 and
97.13 m/s — all terminate between **25.15 and 26.49 m** from the identical
origin along the identical bearing. A speed-triggered annihilation would fire on
the *first* resolve, i.e. within 1.6 m at 96 m/s, and its stopping distance
would scale with speed. A fixed obstacle at ~26 m produces exactly the observed
constant. The x4 and x5 launches reach the same place and simply land
(`zeroCount 0`); x8 and x10 arrive faster and are stopped dead.

So the *mechanism* is terrain, and the residual question — whether a 96 m/s
impact should zero velocity with no rebound — belongs to the physics arm, not to
content. **The content finding stands independently and does not depend on which
answer that gets:** the flattest spot on this map does not contain 26 m of
runway, so an item that scales its launch speed without bound cannot pay past
four stacks. The fixer's justification for declining a cap — "any cap low enough
to matter clips Waxed Wing's own printed linearity before it clips a
combination" — is true of the number in the stat block and false of anything the
player experiences.

---

### D1 — MODERATE — the Scrapfly's printed five strikes is conditional, exactly where the fixer said it would break

**Where:** `src/data/items.js:1236-1268`.

§7.8 of the fix report: *"The interaction between the new `struck >= 5` counter
and a re-acquire gap — whether a strike lost to a dead quarry is now permanently
lost rather than shifted — is **not** tested and is the most likely place for
this change to be wrong."* It is wrong there.

`probeE.json` → `scrapfly`, one release each, 10-12 s windows:

| arm | strikes | gaps (s) | damage |
|---|---|---|---|
| durable quarry (control) | **5** | 1.066 / 1.067 / 1.067 / 1.066 | 78.00 |
| quarry dies each strike, 6 spare bodies | **5** | 1.067 x4 | 84.24 |
| quarry dies, ONE spare body | **2** | 1.067 | 37.44 |
| quarry dies, NO replacement | **1** | — | 18.72 |
| quarry dies, replacement arrives at 3 s | **3** | **2.933** / 1.067 | 56.16 |
| durable quarry, 10 stacks | **5** | 1.066 / 1.067 / 1.067 / 1.066 | 936.00 |

**Re-acquire itself works perfectly** — with a spare body available the fly
switches within one tick and pays all five strikes with unchanged spacing. What
fails is idle time. The mechanism, read from source: `addEffect('scrapfly-hive',
5.6, 0.25, …)` gives the effect a **5.6 s wall clock**; the realised tick period
is 0.267 s (the fixer's own analysis, and my 1.066 s gaps are exactly 4 x 0.267
confirming it); five strikes need ticks 4/8/12/16/20 = **5.34 s**. The
`if (!quarry) return` on line 1240 sits *before* `++tick`, so the counter is
correctly preserved across a gap — but the 5.6 s duration is not, and there is
only 0.26 s of slack in it. A 2.9 s gap therefore costs **two of five strikes,
permanently**, and no counter can give them back.

The fix report's own standard for this is the right one and it is quoted from
the source it edited: *"the number a card prints is the contract."* On that
standard the contract is met with a continuously-available target and broken
otherwise — which is the case the card's own comment advertises as the
distinguishing feature ("it re-acquires from where it is rather than from where
the player is … so it works while the player retreats").

**Checked and clean at the same time:** the 10-stack row is exactly linear —
`perStrike` 187.2 against 15.6, and `linear(1.3, 10)` x `baseDamage 14.4` =
187.2 to the decimal, with the same 5 strikes and the same gaps. This is one of
the two places the brief flagged as where an overshoot would show. **There is no
overshoot; the card pays precisely what it prints.**

---

### D2 — MODERATE — "all healing is eaten" is not true of Ashen Pact

**Where:** `src/data/items.js:1778-1810`, and §4.4 of the fix report.

The retune itself is excellent and I confirm every figure of it to the digit
(rows 21-23). The overreach is one sentence: *"At 10 stacks the drain is 15% of
maximum a second, so the bar pins at 0.501 in four seconds and every point of
regeneration and healing the survivor receives from then on is eaten — a
permanent, ongoing cost."* §7.6 correctly names this as measured against passive
regeneration only.

Measured against real healing items (`probeD.json` → `ashen`, 14 s, actively
fighting so the on-hit and on-hurt heals fire):

| arm | settled | trace |
|---|---|---|
| pact x10 alone | 0.500 | 1 → 0.85 → 0.71 → 0.569 → **0.500** flat |
| **pact x10 + medkit x10 + burr x10, fighting** | **1.000** | 1 → 0.851 → **1.000** for the remaining 12 s |
| **pact x1 + medkit x10 + burr x10, fighting** | **1.000** | **1.000** throughout |

And the break-even, isolated (`probeE.json` → `ashenHeal`, Leeching Seed only,
3 player hits/s, 143 max HP, 21.4 HP/s drain):

| burr stacks | 0 | 1 | 2 | 3 | 5 | 10 |
|---|---|---|---|---|---|---|
| settled at 12 s | 0.503 | 0.511 | 0.519 | 0.525 | **0.558**, still falling | **0.925** |

The drawback is real for most of a run and **evaporates entirely** once the
survivor reaches a stack count a real run reaches. Note also the self-correction
this creates: the Entropy Ledger synergy the fix was designed to price
(+49.9% at half health, row 21) pays *nothing* at 1.000 health, so the medkit
build cancels its own reason to hold the Lunar. That is arguably good design
falling out by accident — but it is not what the report says is happening, and
on a four-round cap the record should say the true thing.

**N1 (MINOR)** falls out of the same table: 5 stacks settles at 0.558 *and is
still descending linearly* at the end of the window, while 10 stacks holds
0.925. There is no middle. A build either pays the entire 50% health cost or
none of it, which makes the incremental healing item a cliff rather than a
decision.

---

### D3 — MODERATE — the roster ordering does not reproduce, and the per-credit picture is not the one the report paints

`probeA.json` → `roster`: six cards, three stands, 12 m standoff, 30 s,
Director disabled, level/damage pinned at 1, `foreignDamage 0` in every arm.

| card | tier | cost | fix report | **my three stands** | mean | dps/credit |
|---|---|---|---|---|---|---|
| Basalt Sentinel | 2 | 32 | 14.59 / 21.88 | 16.10 / 16.10 / 13.34 | 15.18 | 0.474 |
| Ferrite Redoubt | 2 | 36 | 15.69 / 15.32 | 14.01 / 11.16 / 14.02 | 13.06 | 0.363 |
| **Siege Bombard** | 2 | 34 | **3.84 / 3.36** | **9.81 / 9.82 / 9.80** | **9.81** | 0.289 |
| **Bramble Lasher** | 2 | 29 | 8.42 / 8.33 | 6.24 / 6.19 / 7.89 | 6.77 | **0.234** |
| Bile Spitling | 1 | 9 | 0.00 / 7.09 | 4.56 / 4.56 / 4.56 | 4.56 | 0.507 |
| Gloomshriver | 1 | 15 | 1.12 / 2.99 | 2.75 / 2.47 / 2.47 | 2.56 | 0.171 |

The two central claims survive: the Lasher **does** now beat the tier-1 Spitling
(6.77 vs 4.56) and **does** sit at roughly half the tier's turret (0.446 of the
Sentinel). The sub-claim that it beats the Siege Bombard does not: I measure the
Bombard at 9.81 with a spread of 0.02 dps across three stands, half again the
Lasher. My instrument is the tighter one here (three stands at one standoff, all
agreeing to within 0.2%, versus two stands at two different standoffs), but the
likelier explanation is that the Bombard is standoff-sensitive — it is a mortar,
and it holds `meanDist` 17.96-23.19 m — so the honest statement is that the
ordering depends on range and the report states it unconditionally.

The report also invites the per-credit reading — *"at 81% of the turret's
cost"* — and that reading does not flatter the card: at 0.234 dps per credit the
reworked Lasher is **fifth of six**, ahead only of the Gloomshriver, and less
than half the Spitling's 0.507. The report's own framing is the right defence
(*"while being the only ordinary spawn that moves the player"*), and `probeB`
now proves that utility is real and answerable. It just isn't a dps story, and
§3.1 half-tells it as one.

---

### N2 — MINOR — a reeled survivor ends inside the unit

`probeB.json` → `pairs`, `react: 'none'`, standoff 6 m: `minDist` **0.013 m** at
all four stands, with `groundStolen_paired` 5.311 and `reelDamage` 37.8. From
11 m the same arm ends at 4.73 m, which is the intended "dragged inside the 9 m
blast". From 6 m it is co-location with a 0.7-radius capsule. Cosmetic rather
than exploitable, and only reachable by a player who does nothing at all — but
it is the visible end of the card's headline mechanic.

---

## Checked, and clean

These are the things I went at hardest and could not break. On a final round
they matter as much as the findings.

- **The Lasher rework is real and the evidence for it is the strongest in this
  round.** Two headline numbers reproduced on an instrument the fixer did not
  have, at different stands, to three decimal places: `reelDamage 0` and closest
  approach **11.0189 m** for a survivor who runs; **132.3 HP** of reel damage for
  one who does not. The attack table is now genuinely three attacks — `pull`
  63.8% / `thorns` 23.7% / `flail` 12.6%, `flail` selected 1-5 times in every one
  of 20 arms after firing **zero** times in fifteen arms before the fix. dps
  falls monotonically with standoff (7.84 / 6.46 / 6.52 / 5.15 / 4.54 at
  8/11/14/18/22 m), which is the shape a close-mid grappler should have and the
  precise opposite of round 3's flat 1.37 at every range.
- **The agency arm the fixer honestly refused to claim.** §1.1 disqualified two
  of its own attempts and rested the claim on "`pull`/`range`/`minRange` are
  untouched". I measured it, with a muted control that reads exactly zero, two
  instruments required to agree, four stands and four player reactions. The card
  behaves exactly as its design comment says: **react to the telegraph and it
  costs 0.02-1.09 m of a 38.4 m escape and zero damage; react only when the
  suction lands and it costs 3.36-6.80 m but you still escape; ignore it and it
  takes 5.31-6.27 m and drags you to contact.** A sprinting player is never
  reversed for a single frame in any of eight arms. Round 3's most contested
  claim is now measured rather than argued.
- **Packs are additive.** Two Lashers pay 2.08x one Lasher (13.41 vs 6.46 mean).
  No compounding, no pathological co-reeling. `packMax: 2` is safe.
- **Crit does not interact with the Conflagration overlap term.** Exactly 2.00x
  at both formations. Whatever else is wrong with that card, the crit path is
  clean.
- **The impulse channel sums, and Tectonic Heart composes.** `Items.js:745` is a
  `+=` and it measures as one; both reports independently get **16.00** for the
  Heart's third jump.
- **The Ashen Pact retune is the best-measured change in the round** and I
  reproduced it digit for digit, including the two numbers it was designed to
  move: Entropy Ledger from +69.7% to **+49.9%**, and Prey Instinct from live to
  dead with `moveSpeed` back at base 7.00. It is never lethal at either end of
  its range — thirteen arms, `alive: true` in all of them.
- **The Scrapfly's damage is honest at ten stacks**, to the decimal, with
  unchanged cadence. This was one of the two nominated overshoot sites and it is
  clean.
- **The build and capture claims are true.** Verified against the manifest on
  disk rather than the report: `ready true`, `partial false`, `clockPinned true`,
  `frameDt 1/60`, `frameTimeouts 0`, 21 scenarios, and one failing check whose
  every quoted figure — `px 759`, `minPx 300`, `visibleObjects 8/10`,
  `sepP50 0.69`, failing object 6 at `px 135 / sepP50 0.13` — matches exactly.
  The report's refusal to claim the `audioOk: true` line as its own evidence is
  correct and I echo it.
- **Zero errors.** `frameErrors: 0` and `errors: []` in all five probe records,
  across all five probes and roughly 25 minutes of pinned simulated time.

---

## Not tested, and named

1. **The `blazing` fix.** C1 identifies the mechanism and the one-line
   candidates; I did not measure a build with either applied.
2. **The Conflagration formations in live play.** My clusters are pinned every
   frame. A real pack is subject to separation forces, so whether 16 bodies at
   1.0 m spacing is reachable is unknown — but 8 at 1.2 m and 12 at 1.5 m are the
   *fix report's own* chosen formations, and both refute the plateau on their
   own.
3. **The impulse channel against real level geometry other than the one spot.**
   Four bearings from the flattest of 400 candidates. A genuinely open arena, if
   one exists on another seed or realm, was not searched.
4. **Multiplayer.** Every `ctx.authority` guard is unexercised, as in rounds 2,
   3 and 4. `Combat.applyDamage` returns 0 outright for a client
   (`Combat.js:382`) and nothing in this report exercised that branch.
5. **The `outgoing` multiplicative chain at 10-11 items** (their MINOR-5's
   x172.8 / x5443.2). Unverifiable from my evidence.
6. **Overlapping pyre clouds and the burn-stack cap on *enemies*** (their
   MINOR-4). Unverifiable from my evidence — and note that C1 concerns the cap
   on the *player*, which is a different code path with no cap at all.
7. **The `losFraction 0.008` blind stand.** Not reproduced in 20 arms at 4
   different stands (worst 0.422, mean 0.947). Their `Enemy.js` structural
   recommendation — a blind ranged unit should fall through to `CHASE` rather
   than orbit — is unevaluated by me and I have no evidence against it.
8. **A hand-played run.** Every number here is a pinned-clock probe against a
   scripted survivor.

---

## For whoever decides whether to ship

The Bramble Lasher is fixed. That is the headline the round wanted and it has
earned it: three rounds of moving numbers inside a wrong frame were replaced by
one decision about the frame, and both ends of the card's range are now on
record from two independent instruments that agree to three decimal places. The
Ashen Pact retune is the cleanest piece of measurement in the round. The burn
rider is genuinely gone and the Temporal Echo cascade with it. The impulse
channel sums. Ninety percent of this domain's round-4 work is right, and where
the report says it is uncertain, it is uncertain in the honest direction.

What stops it shipping is that the fixer listed ten arms it did not test, and
the two most consequential both fail — which is the same lesson round 2 taught
and round 3 obeyed, arriving one layer deeper. The blazing affix is a
first-stage, cheapest-in-tier elite doing five times the damage of its
equal-cost sibling on the one card the round just redesigned to hold the player
still; a one-line cap in `Combat.applyStatus` or the removal of one
`statusPlayer` call at `Enemy.js:473` closes it. Conflagration's ceiling needs
either a real bound or an honest description, and right now the card asserts a
measured plateau that does not exist, in a comment, as justification for
declining the retune that would have created one. Waxed Wing needs to stop
selling stacks it cannot deliver.

Against this round's own stated lesson — *a fix aimed at a number can overshoot
into the opposite failure, and a gate that has never been failed on purpose is
not a gate* — the domain gets a split verdict, and it is worth being precise
about. **The gate discipline is exemplary**: the fixer disqualified two of its
own agency attempts rather than shipping them, retracted a Scrapfly conclusion
in public, and named the arm most likely to be wrong; my own muted-pull control
reads exactly zero, and the two nominated overshoot sites (Scrapfly at ten
stacks, the impulse trails) came back clean on the item's own terms. **The
overshoot lesson was not learned in one place**: §4.3 declined a retune on the
strength of a measurement taken through a contaminated fixture, wrote that
measurement into the source as fact, and called it the contract. A wrong number
in a report is a round's problem. A wrong number in a card comment, presented as
measured, is the next person's problem — and on a four-round cap there is no
next round to catch it.

**SPEC: REFUTED** — five of round 4's claims fail independent re-derivation,
each with a reproducible counter-measurement: the Conflagration ceiling and the
reason for declining its retune (§4.3), the "all healing is eaten" steady state
(§4.4), the Siege Bombard roster ordering (§3.1), and the no-cap justification
for the impulse channel (§4.1).

**QUALITY: NOT READY** — one CRITICAL and two MAJORs, all three of them in arms
the fixer correctly predicted were the risky ones. None is expensive to close:
C1 is one line, M1 is a number and a sentence, M2 is a cap or an honest
description. The work underneath them is good enough that it deserves not to
ship with them attached.
