# Round 7 — round-3 cross-file integration

Closing the six leftovers the four parallel round-3 fixers escalated out of their
own file sets. Base HEAD `ac85d85` on `round7/content-and-polish`. Nothing
committed; the work is in the tree.

Files changed: `src/systems/Items.js`, `src/systems/Audio.js`,
`src/entities/Enemy.js`, `src/entities/Player.js`, `src/data/enemies.js`,
`src/data/items.js`.

## How every number below was produced

**One probe script, run unchanged against both arms.** `tools/_r7int.mjs`
(deleted before finishing) drove a live game through Playwright with the launch
config copied from `tools/capture.mjs` — headed Chromium on `--use-angle=d3d11`
parked off-screen, page at `?seed=1337&quality=0&harness=1&pinclock=1`, driven
through `globalThis.__GAME__` / `__HARNESS__`, with a real `KeyZ` gesture before
anything so the audio graph is allowed to run (`audioState: "running"` in both
files, so no audio number below is a measurement of a suspended context).

The two arms are the **same working tree** at two states, not two worktrees: the
four changed engine files were copied aside, `git stash push` took the tree back
to `ac85d85`, the before run was taken, and the files were copied back. No
`node_modules` junction was created anywhere.

| file | what produced it |
|---|---|
| `reviews/round7/r3-integration/before-HEAD.json` | the probe, tree at `ac85d85` |
| `reviews/round7/r3-integration/after-fix.json` | the probe, fixed tree |
| `reviews/round7/r3-integration/shots/` | full 21-shot capture + manifest, fixed tree |

Every figure below names its file and its key. `errors: []` and
`frameErrors: 0` on the after arm; the before arm's `frameErrors: 212` is
finding 6 firing, and is the measurement, not a fault.

---

# 1. The pickup path — rewired at the emitter

`Items.js`, `Audio.js`.

### What was actually wrong, which is not quite what the brief said

The brief said the audio fix "is currently inert in-game". Measured, it is not:
the audio fixer's `ITEM_BY_ID` fallback works, and at `ac85d85` the correct tier
already reached the sound. What was wrong was three narrower things, all of them
real:

1. **Every `give` fired the cue twice** — once off `itemPickup` at the right
   tier, once off the direct `play('pickup')` at tier 0. Whether the second one
   was silent depended on a 40 ms throttle keyed on `AudioContext.currentTime`,
   and **that throttle is a race, not a guarantee**: two runs of the identical
   probe against the identical `ac85d85` tree disagreed. The first before-run
   had the tier-0 duplicate emit a full 6 voices on 3 of 8 cases (uncommon,
   legendary, blight); the final before-run on disk collapsed all 8. Both are
   the same code. *(The first run's JSON was overwritten by a later run of the
   same probe and is not on disk — the load-bearing before-arm claims below are
   all from `before-HEAD.json`.)* This is exactly the fragility the audio fixer
   flagged; the ordering hazard they warned about is now structurally
   impossible, because there is no second call site left to order.
2. **Equipment played the legendary rung.** `Items.js:798` passed the raw index
   `2`, bypassing `PICKUP_TIER` entirely.
3. **The wire carried neither tier nor delta**, which is why `Audio.js` had to
   import `data/items.js` and keep a shadow copy of the inventory.

### The changes

- `Items._set` now emits `{ id, count, tier, delta }`. `count` stays absolute —
  that is what makes the client mirror safe to apply twice or out of order —
  and `delta` rides beside it because a listener cannot derive direction from an
  absolute total without keeping its own shadow inventory, which is precisely
  what `Audio` had been reduced to.
- The three direct `play('pickup')` calls are deleted: `Items.js:266` (`give`),
  `:261` (the blight-waiting branch) and `:220` (the client mirror).
- `Items.setEquipment` sends `play('pickup', null, 'equipment')` — a tier
  *name*; `Audio.play` maps a string through `PICKUP_TIER` and still accepts a
  number as a raw rung.
- `import { ITEM_BY_ID }` is gone from `Audio.js`. The layering cost the audio
  fixer accepted is paid back.

### Before / after — measured per tier, by voices actually emitted

`pickup.cases` in both files. The probe counts `_tone`/`_noise` calls inside
`pickup()` rather than calls to `pickup()`, because the de-duplication lives
*inside* `pickup()` and a wrapper above it reports a silent call as if it played.

| case | `ac85d85` | fixed |
|---|---|---|
| `give` common | `pickup(0)` 6v **+ `pickup(0)` 0v** | `pickup(0)` 6v |
| `give` uncommon | `pickup(1)` 8v **+ `pickup(0)` 0v** | `pickup(1)` 8v |
| `give` legendary | `pickup(2)` 11v **+ `pickup(0)` 0v** | `pickup(2)` 11v |
| `give` boss | `pickup(3)` 11v **+ `pickup(0)` 0v** | `pickup(3)` 11v |
| `give` lunar | `pickup(4)` 11v **+ `pickup(0)` 0v** | `pickup(4)` 11v |
| `give` blight | `pickup(0)` 6v + `pickup(0)` **6v** + `deny` + `pickup(0)` 0v | `pickup(0)` 6v + `deny` + `pickup(0)` 6v |
| `setEquipment` | **`pickup(2)` 11v** — the legendary rung | **`pickup(1)` 8v** |
| wire payload | `{id, count}`, `tier: null`, `delta: null` on every row | `{id, count, tier: "legendary", delta: 1}` |

All six tiers are distinct and correct, and each fires exactly once per stack
change. The removal path is visible in the blight row: the syringe the
corruption eats emits `{count: 0, delta: -1}` and plays `deny()`.

### Not fixed, deliberately

A blight card still plays the plain tier-0 reward jingle plus a `deny` for the
base it consumed. The `deny` is arguably correct — an item really was taken —
but the pair is not a designed cue. This is the same design call the audio fixer
declined to invent and I decline for the same reason: it needs a sound written,
not a defect fixed.

---

# 2. `Enemy.js` — the enemy half of `slow`. Fixed, and it is **not** one line

The combat fixer reported this as "one line of the same shape as the Player
fix". **I checked that claim before trusting it, and it is wrong.**

`Enemy.js:548` only sets the `speed` argument that `steer` hands to
`seek`/`arrive`/`keepRange`. Downstream of `steer`, `applyMovement` adds pack
separation, obstacle avoidance and the pest jitter to the desired velocity — all
scaled off raw `moveSpeed` — and then clamps at `moveSpeed * 1.9`. Scaling only
`steer`'s argument would leave a **frozen unit still sliding around the field
under its neighbours' separation force**, which is the opposite of what a freeze
reads as, and would leave the clamp at full speed.

So the multiplier is applied once, in `applyMovement`, to the whole desired
velocity *and* to the ceiling above it, after every contribution has landed. The
charge and the burrow return before that point and are scaled where they
integrate. A dying unit is exempt — its ragdoll is presentation, and freezing a
corpse mid-topple is a hitch.

**Before / after** — `enemySlow` in both files. A `mite` (`moveSpeed` 8.4)
chasing from 40 m, status stripped and re-applied every frame so the stack count
is exact, 60 frames of warm-up out of `SPAWN`, then 120 frames measured:

| condition | `speedMultiplier` | peak speed `ac85d85` | peak speed fixed | 2 s distance |
|---|---|---|---|---|
| clean | 1.000 | 8.400 | 8.400 | 16.80 → 16.80 |
| slow ×1 | 0.600 | **8.400** | **5.040** | 16.80 → **10.08** |
| slow ×5 | 0.250 | **8.400** | **2.100** | 16.80 → **4.20** |
| freeze ×1 | 0.000 | **8.400** | **0.000** | 16.80 → **0.00** |

5.040 and 2.100 are 8.4 × 0.600 and 8.4 × 0.250 exactly. The multiplier column
is the *same* in both arms — `Combat.speedMultiplier` always computed the right
answer and nothing asked it. Frost Lattice, Hoarfrost Band, Concussion Charge,
Grapnel Tether's slow and the Aegis Emitter's dome all now do something.

---

# 3. `Items.consumeImpulse` — both ends of the channel were dead

The combat fixer filed this as "`consumeImpulse` has no caller in `src/`". It is
worse than that: **nothing in the project ever emitted the `jump` event either.**
`Items.js:178` has listened for one since it was written; `git grep "'jump'"`
returns that one line and nothing else. So `onJump` never ran, so `applyImpulse`
was never called, so the missing consumer was the second of two breaks in the
same chain.

Three shipped cards sat behind it doing literally nothing: **Waxed Wing**,
**Updraft Vents**, and **Tectonic Heart** — whose every-third-jump 9 m quake
never counted a jump, so the boss tier's only active card never fired at all.

`Player._jump` now emits `jump` and consumes the impulse in the same statement.
That is on purpose: the hooks run synchronously inside `emit`, so whatever they
push lands before the read on the next line and there is no ordering question.

The impulse goes onto the player's **own** velocity, not through the external
channel. It is self-caused — the player pressed jump — so they keep authority
over it, and air control steers and bleeds it. Routed through the external
channel it would decay on the fixed 0.25 s timer and be gone before the apex,
turning a 10 m/s launch into a two-metre shove the player watches happen.

**Before / after** — `jumpImpulse` and `tectonic` in both files. Peak horizontal
speed over the 1 s after a real `Space` press through `ctx.input`, player
sprinting at 10.15 m/s:

| held | `jump` events `ac85d85` → fixed | peak horiz `ac85d85` | peak horiz fixed |
|---|---|---|---|
| nothing, standing | 0 → 1 | 0.000 | 0.000 |
| nothing, sprinting | 0 → 1 | 10.150 | 10.150 |
| 1× Waxed Wing, standing | 0 → 1 | **0.000** | **9.767** |
| 1× Waxed Wing, sprinting | 0 → 1 | **10.150** | **19.357** |
| 3× Waxed Wing, sprinting | 0 → 1 | **10.150** | **39.357** |
| 1× Updraft Vents, sprinting | 0 → 1 | **10.150** | **14.357** |

19.357 and 39.357 are 10.15 + `linear(10, n)` for n = 1 and 3; 14.357 is
10.15 + `linear(5, 1)`. The card's printed number is what arrives, and it is
exactly linear in stacks. From a standstill the impulse alone is 9.767 m/s and
carries the player **0.000 m → 5.889 m** over the second.

Tectonic Heart, four jumps in a row (`tectonic`):

| | `ac85d85` | fixed |
|---|---|---|
| peak horiz per jump | `[10.15, 10.15, 10.15, 10.15]` | `[10.15, 10.15, **16.15**, 10.15]` |
| quakes fired | **`[]`** | **1** — radius 9, damage 42, on jump 3 |

`Waxed Wing`'s description said "jumping *while sprinting*" and its hook has
never checked sprint. Now that the card is live that text is a lie the player
can feel, so the description says what the code does: "Every jump". The
mechanic is unchanged.

**The 1 s displacement column is not reported for the sprinting rows**, and the
reason is on disk: `dist1s` reads 4.82–4.98 m on every sprinting row including
the 3× Waxed Wing one at 39 m/s peak, which is geometry stopping the player
about five metres ahead of the measurement origin, not the item. Peak velocity
is the metric of record here for exactly the reason the combat fixer gave for
the slow measurement.

---

# 4. Bramble Lasher — `pull: 19` → `26`, re-tuned against a working pull

`data/enemies.js`. The content fixer left this deliberately and correctly: 19
was chosen when no pull could move a grounded player, so it had never been
measured against anything.

**The instrument** is `pull` / `pullClose` / `pullSprint` / `pullSprintClose` in
both files: a bare object at a held distance, exactly as the combat fixer
measured it (`pullPlayer` reads only `position`, `tickT` and `damage`), for the
90 steps that are this attack's 1.5 s `active` window. It is byte-identical
across the two arms — nothing in the pull path changed this round — and exactly
linear in `pull`, so it is a clean ruler.

| stationary player, 1.5 s | `pull: 19` | `pull: 26` | `pull: 30` |
|---|---|---|---|
| ground closed at 10 m | 3.558 m | **4.869 m** | 5.619 m |
| ends up at | 6.44 m — **outside** the reel's own 6 m `blast` | **5.13 m — inside it** | 4.38 m |
| ground closed at 5 m | 4.670 m | 6.162 m | 6.253 m |
| ground closed at 18 m | 1.779 m | 2.435 m | — |

**19 could not deliver its own damage tick.** The reel's `blast: 6` is what
makes `hurtPlayer` fire; at 19 a stationary player at 10 m ends 6.44 m away,
just outside it, so the attack's whole payoff was unreachable. 26 lands them at
5.13 m with margin. That is the threat, and it is a legible one: ignore the reel
and it drags you into its own damage radius.

**It does not take control away**, measured on the arm that matters:

| sprinting player, 1.5 s, ground gained | `pull: 0` | `19` | `26` | `30` |
|---|---|---|---|---|
| from 10 m | 10.572 m | 10.609 m | **10.356 m** (−0.22) | 9.606 m (−0.97) |
| from 5 m — the closest the reel may start | 10.309 m | 10.424 m | **8.834 m** (−1.48) | 7.851 m (−2.46) |

The player never reverses direction for a frame at any value. **30 was measured
and rejected**: it takes a quarter of the 5 m escape, which starts to read as
being held rather than slowed.

26 is deliberately the Maw's `draw` number, and that is not laziness — `pull` is
meaningless without `range`, because the falloff is `1 - d/range`. At 10 m this
reel is 16.0 m/s² against the Maw's 18.4 and the Herald's 22.5. The bosses stay
stronger; the ordering lives in the range term, which is where it belongs.

**The live-card arm is on disk and is confounded — I am not citing it as the
tuning evidence.** `lasherLive` spawns a real Lasher with only the reel in its
attack table and pins it in place. What it establishes: the reel does fire in a
real fight and does drag a stationary player from a 12 m standoff to 5–6 m, and
a sprinting player escapes to 67 m. What it cannot do is compare 19 against 26,
because pinning the unit stops `REPOSITION` ever resolving and the two arms
fired 189 and 91 active frames of reel respectively — a comparison of attack
selection, not of pull. Recorded rather than deleted, with one finding worth
someone's time: **at the Lasher's own `preferredRange` of 18 m the reel fired
zero times in 25 s in four separate runs.** I did not chase why; it is a
pinned-unit artefact or a real gap in `pickAttack`/`REPOSITION`, and telling
those apart is a separate piece of work.

---

# 5. Knockback — the judgement call. **Keep it. Do not split the constants.**

The combat fixer's external-velocity channel moved a 9 m/s knock from 0.398 m to
2.116 m of displacement and asked for a human's eyes.

**The numbers, and where each comes from.** Pre-round is
`reviews/round7/r3-combat/probe1.json` → `results.knockback`, measured at
`75f87d6`. Post-round is `knockback` in *both* of my files — identical, because
nothing I changed touches it:

| `knock` | `75f87d6` | `ac85d85` and fixed |
|---|---|---|
| 9 (Charger `gore`) | **0.398 m** | **2.136 m** |
| 12 (Colossus `advance`) | **0.740 m** | **2.848 m** |
| 20 | — | 4.747 m |

**This is a fix, not a regression, and the old number is the tell.** 0.398 m for
a 9 m/s shove implies the whole impulse was absorbed in about 44 ms — faster
than a human can perceive, let alone react to. Every knockback attack in the
game was cosmetic. 2.136 m is what "you were pushed at 9 m/s and it took a
quarter second to recover" actually looks like; it is `knock × EXTERNAL_TAU`
plus the controller's own recovery, and it is the same arithmetic that makes the
pull work. There was never a separate knockback design that this broke — there
was a knockback that had been deleted by the same bug, more slowly.

**Agency check** (`knockAgainstInput`, both files): a player sprinting *into* a
shove pointed the other way.

| `knock` | net ground gained in 1 s | worst backward giveback |
|---|---|---|
| 0 (control) | 2.306 m | **0.000 m** |
| 9 | 2.098 m | **0.000 m** |
| 12 | 2.110 m | **−0.024 m** |

The player's position never goes backwards. (The absolute gains are compressed
by the same geometry that flattened the jump displacements — that is why there
is a `knock: 0` control on the same ground; the comparison is what is being read,
not the metre count.)

**I did not split `EXTERNAL_TAU` into separate pull and knockback constants**,
and that is a deliberate refusal. The channel cannot tell a shove from a
suction because both are literally the same operation — something wrote to
`player.velocity` while the pawn was not stepping. Splitting them means
inventing a tagging API that every external writer has to opt into, to serve a
feel difference nobody has reported and that I cannot measure. That is the
speculative-abstraction move. If someone plays it and the shove feels wrong, the
one number to move is `EXTERNAL_TAU` at `Player.js:76`, and moving it will move
the pull with it — which is stated in the comment already sitting on that line.

---

# 6. `Enemy.js` — `def.attacks[0]` unguarded. Fixed, in three places

Found by the content fixer's probe tooling. Reproduced live and it is worse than
filed — there are three unguarded sites on two different paths, and the one that
was reported is not the one you hit first.

**Before / after** — `emptyAttacks` in both files. Two dummy cards with
`attacks: []`, each spawned and run for 240 frames:

| dummy | `ac85d85` | fixed |
|---|---|---|
| no `behavior` — dies in `defaultBehavior` at spawn | **throws out of `spawnOne`**: `Cannot read properties of undefined (reading 'kind')` | spawns clean, 0 frame errors |
| `behavior: 'ranged'` — survives spawn, reaches the `REPOSITION` test | **212 frame errors in 240 frames**, `Enemy.js:1297`, one per frame, via `Director.fixedUpdate` | **0 frame errors** |

Guarded: the reported `REPOSITION` test (an empty attack list now reads as "not
ranged" — a unit with nothing to fire has no reason to reposition for a better
angle), `defaultBehavior`, and the boss phase-break colour read at `Enemy.js:365`
which is the same landmine on the boss path.

---

# Build and capture

- `node node_modules/vite/bin/vite.js build` — **exit 0**, `✓ built in 1.28s`,
  only the pre-existing >500 kB chunk advisory.
- `node tools/capture.mjs --out reviews/round7/r3-integration/shots --port 5413`
  — **21/21 shots**, `partial: false`, `ready: true`, `clockPinned: true`,
  `frameTimeouts: 0`, **`audioOk: true`** with `stepsEmitted: 294`, context
  `running`, `newErrors: []`. `errorCount: 1`, and that entry *is* the harness's
  own assertion for the known failing check — zero page errors, zero other
  console errors. Exit 1, which is what that one check has always produced.

**The one failing check is unchanged, and that is a diff rather than an
eyeball.** `06-loaded-hud` / `monsters under load` against
`reviews/round7/r3-content/shots/manifest.json`: the same single
`objectFailures` entry `{i: 6, px: 145, sepP50: 0.17}` and the same
`perPx [8,7,25,201,60,30,145,72,89,126]`. `E-framing.md` §5 records the same
object failing on separation, not size. No other shot's subject metrics moved.

---

# Arms I did **not** test

Named explicitly, because round 2's lesson was that a fix verified against the
arm it was reported in leaves the other arm live.

1. **Multiplayer, in every one of the six items.** All six changes have a client
   or replay arm and none of them was run:
   - The `jump` emit is gated on `!this._replaying`, so a **coop client holding
     Waxed Wing will mispredict its own jump** — the impulse is applied on the
     first pass and not on the reconciliation replay. That is a real, named gap,
     not an oversight; fixing it properly means deciding whether `onJump` should
     be authority-gated the way `onAbility` is, which is a protocol call.
   - `Items.js:220`'s client mirror no longer plays `pickup` directly and now
     relies on `Audio` hearing the replicated `itemPickup`. Statically that is
     the same event, but no networked session was run.
   - The enemy slow, the retuned reel and the impulse are all host-authoritative
     in a single-player session here.
2. **Gamepad.** Every movement and jump measurement drove `ctx.input.keys`.
   Round 2's own lesson was mouse-but-not-gamepad and I have repeated it.
3. **A slowed enemy mid-charge or mid-burrow.** Both paths are scaled by the
   same multiplier, read in code and built into the same `slow` local, but the
   probe only exercised `CHASE`. No shipped card applies `slow` to a charging
   Charger in my runs.
4. **A slowed flyer.** The multiplier scales the horizontal desired velocity and
   deliberately not `hoverHeight`, so a frozen flyer should hang rather than
   drop. Reasoned, not measured — the probe used a grounded `mite`.
5. **A slowed boss.** `isBoss && phase === 2` multiplies `moveSpeed` inside
   `steer`; the status scale is applied after it, so they compose. Not run.
6. **The Lasher's reel at its own `preferredRange` in a live fight** — see §4.
   Zero reels fired in 25 s across four runs and I did not diagnose it.
7. **The reel against a moving-but-not-sprinting player**, and against a player
   mid-dash (the dash branch clears the external channel).
8. **Two Lashers reeling at once.** The suction is additive on one channel; not
   measured.
9. **Real playback of any of the pickup cues.** Voices emitted and tier indices
   are counted, never heard. The tier *ladder* is the audio fixer's judgement
   and I did not re-litigate it.
10. **`--software` capture.** Every capture and probe here is the GPU path.
11. **A run past stage 1**, for the reel's re-tune. `difficultyMult` scales
    monster damage, not `pull`, so the ground-stolen figures should be
    stage-invariant — but that is arithmetic, not a measurement.

# Not fixed, with reasons

- **A designed cue for blight cards.** See §1. Needs a sound written.
- **The `EXTERNAL_TAU` split.** See §5 — a deliberate refusal, with reasoning.
- **Why the Lasher's reel never fires at 18 m.** See §4 — real enough to be worth
  someone's time, too tangled with a pinned-unit artefact to close inside this
  task's scope.
- **`Progression.js:151` / `Profile.js:1044` counting barrier-absorbed damage as
  damage taken.** The combat fixer named this as a one-line `e.toHealth ??
  e.amount` follow-up in the meta/UI fixer's files. It is not one of the six
  items I was given and I did not take it; it is still open.
- **The content fixer's flag to "confirm exactly one of the two guards exists"**
  for `Items.timeSinceHurt` on a fully-absorbed hit. Confirmed by reading, not
  by measurement: the only guard is at the emit site (`Combat.js`, `playerHurt`
  is not emitted when `dealt === 0`), and `Items.js:205` has no second guard.
  Exactly one. I did not add a probe for it.
