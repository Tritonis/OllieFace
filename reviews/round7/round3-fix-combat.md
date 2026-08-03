# Round 7 — round 3 fixes: Combat / Player / VFX / Coop

Branch `round7/content-and-polish`, base HEAD `75f87d6`. Files touched:
`src/systems/Combat.js`, `src/entities/Player.js`, `src/systems/VFX.js`.
**`src/net/Coop.js` was not modified** — the leak it was cited for lives entirely
in `Player.dispose()`, and `_despawnPawn`'s own comment is still accurate.

Nothing committed. Throwaway probes deleted; raw data kept.

---

## How everything below was measured

The shared tree was unusable for a live run for most of this session: a parallel
fixer left `src/ui/Menus.js` unparseable (`SyntaxError: Unexpected identifier
'paintFocus'`, reproduced outside the browser with `node --input-type=module -e
"import('file:///.../src/ui/Menus.js')"`). Every measurement below therefore
comes from two **git worktrees at `75f87d6`**, with `node_modules` junctioned in:

- `_r3base` — pristine `75f87d6`, no edits. Produces every **before** number.
- `_r3tree` — `75f87d6` plus this round's three changed files, nothing else.
  Produces every **after** number.

**One probe script, run unchanged against both trees.** That is deliberate:
last round's lesson was that a fix verified against its own arm closes nothing
else, and a before/after pair taken with two different instruments proves
nothing either. Launch config copied from `tools/capture.mjs` (headed Chromium
off-screen, `--use-angle=d3d11`), page at
`?seed=1337&quality=0&harness=1&pinclock=1`, driven through
`globalThis.__GAME__` / `__HARNESS__`.

Raw data on disk, and every number below names its file and key:

| file | what |
|---|---|
| `reviews/round7/r3-combat/before-HEAD.json` | pristine `75f87d6`, main probe |
| `reviews/round7/r3-combat/after-fix.json` | fixed tree, same probe |
| `reviews/round7/r3-combat/before-HEAD-2.json` | pristine, follow-up (clean pull + movement control) |
| `reviews/round7/r3-combat/after-fix-2.json` | fixed tree, same follow-up |
| `reviews/round7/r3-combat/probe1.json` | first pass, **superseded — see "a number I retract"** |
| `reviews/round7/r3-combat/capture/` | full 21-shot capture off the fixed tree |

Zero console errors and zero page errors in all four probe sessions
(`errors: []` in every JSON above).

---

## 1. CRITICAL — enemy-shield damage reported as zero. **Fixed.**

`src/systems/Combat.js:432-497`.

`4a1a098` moved `dealt` to after the shield block and then put it on every
channel. Its underlying finding was real, but it was a *player-side* finding and
the variable it redefined is read from both sides. The two sides want opposite
answers, so they now get opposite answers rather than one compromise:

- **Outgoing** (`damage` event, `onHit`, the return value) carries `incoming` —
  the hit as it landed, post-crit and post-armour, barrier or no barrier. A hit
  into a barrier landed; the barrier is what it landed on. `toHealth` and
  `absorbed` ride along for anything that wants the other figure.
- **Defending** (`playerHurt`, the `onDamaged` dispatch) keeps `dealt`. That is
  the half `4a1a098` was actually about, and it is untouched.

`applyDamage` now returns `incoming`; the doc comment says so. Grep confirms
nothing in `src/` consumes the return.

**Before/after** — `results.enemyShield` in `before-HEAD.json` / `after-fix.json`.
A `warden` spawned with the `warded` affix (`reflect 0.22, shield 1.1`, barrier
1795.2), 30 player hits of 120 each, i-frames cleared each hit so every reflect
that fires is counted:

| | `75f87d6` | fixed |
|---|---|---|
| `applyDamage` returned (hits 0 / 15 / 29) | 0, 0, 0 | 54, 54, 54 |
| `damage` event payload | `{amount: 0}` | `{amount: 54, toHealth: 0, absorbed: 54}` |
| `warded` reflect events fired | **0** | **30** |
| reflect damage dealt to the player | 0.0 | 356.4 |
| barrier drained | 1795.2 → 489.4 | 1795.2 → 519.3 |

120 raw becomes 54 through the warden's armour, and the barrier drains at the
same rate on both arms — the hits always landed. Only what they said about
themselves changed. The affix fires for the first time in this branch's history.

That same `amount` is what `VFX.js:2396`, `HUD.js:158`, `Progression.js:145`,
`Profile.js:1049` and `items.js:310 / 747 / 1111` read, so all seven recover with
it.

### The mirror arm — player shields

`results.playerShield`. Player at 110/110, one 50-damage hit, three barrier
states. The `damage` event for a *player* target now also reports the pre-shield
figure:

| | `75f87d6` | fixed |
|---|---|---|
| shield 1000 (absorbed whole) | `{amount: 0}` | `{amount: 50, toHealth: 0, absorbed: 50}` |
| shield 20 (partly absorbed) | `{amount: 30}` | `{amount: 50, toHealth: 30, absorbed: 20}` |
| no shield | `{amount: 50}` | `{amount: 50, toHealth: 50, absorbed: 0}` |

**Accepted consequence, named rather than buried.** `Progression.js:151` and
`Profile.js:1044` add `e.amount` to *damage taken* for a player target, so
barrier-absorbed damage now counts as damage taken. That is what `master` did
for the whole project's history and what `4a1a098` changed; a
"took no damage this stage" goal will now break on a hit a barrier ate. The
payload carries `toHealth` for exactly this, and switching those two lines to
`e.toHealth ?? e.amount` is the one-line follow-up — in the meta/UI fixer's
files, not mine. I did not make that call unilaterally in someone else's file.

---

## 2. MAJOR — `playerHurt` at zero. **Fixed, at the emit site.**

`src/systems/Combat.js:474`. `playerHurt` is now emitted only when `dealt > 0`;
the `onDamaged` gate folded into the same condition. No listener changed, which
was the point — three of the four never checked the amount and two of them live
in files I may not touch.

**Before/after** — `results.playerShield.fullyAbsorbed`, shield 1000, hit 50,
hurt clock aged 30 s:

| | `75f87d6` | fixed |
|---|---|---|
| health | 110 → 110 | 110 → 110 |
| shield | 1000 → 950 | 1000 → 950 |
| `playerHurt` events emitted | 1, `{amount: 0, absorbed: 50}` | **0** |
| `Items.timeSinceHurt()` | 30 → **0.00** | 30 → **30.00** |
| `pipeline.aberration` | 0 → 0.00760 | 0.00273 → 0.00273 |
| `pipeline.vignetteBoost` | 0 → 0.20800 | unchanged |

Field Dressing can now recharge while it is working, and Siege Battery's two
halves finally agree about what "taking damage" means.

Hits that *do* cost health are provably unaffected — `partlyAbsorbed` and
`noShield` produce byte-identical `playerHurt` payloads on both arms
(`{amount: 30, absorbed: 20}` and `{amount: 50, absorbed: 0}`), reset the hurt
clock, and move aberration and vignette by the same deltas.

**What I could not measure:** the music duck. `Audio.js:100` cannot run without a
`playerHurt`, and none is emitted — that is a structural proof, not a
measurement. The bus gain itself is a scheduled ramp; an instantaneous read sees
nothing, and indeed reads `0.192 → 0.192` on the **pristine** arm where the duck
demonstrably does happen. I am not claiming a measured music result.

**One deliberate addition.** With the emit gone, an absorbed hit had no feedback
at all. `VFX.js` now listens to `shieldBroken` — a channel `Combat.js:458`
already emitted and which had **zero** subscribers — and does a single small
camera shake (0.035) and nothing else: no hitstop, no vignette, no aberration,
no sound. That is the "a barrier took that" read without the stutter that
sustained chip damage used to cause.

---

## 3. BLOCKING — `slow` inert on the player. **Fixed.**

`src/entities/Player.js:495`. `Combat.speedMultiplier` computed the right answer
and had no callers; the player's movement path now asks it.

**Before/after** — `results.slowOnPlayer`. Player sprinting from a fixed home
position with the status re-applied every frame, 120 steps (2.0 s):

| condition | multiplier | peak speed `75f87d6` | peak speed fixed | 2 s distance `75f87d6` → fixed |
|---|---|---|---|---|
| clean | 1.000 | 10.150 | 10.150 | 10.27 → 9.99 |
| slow ×1 | 0.600 | 10.150 | **6.090** | 9.90 → 10.39 |
| slow ×5 | 0.250 | 10.150 | **2.538** | 9.99 → **4.90** |
| freeze ×1 | 0.000 | 10.150 | **0.000** | 9.99 → **0.00** |

6.090 and 2.538 are 10.15 × 0.600 and 10.15 × 0.250 to three figures. Peak speed
is the metric of record here; the 2 s distances include terrain the player runs
into and the slow ×1 row shows why they are the weaker instrument.

Freeze is a full stop by design (`speedMultiplier` returns 0 outright) and I left
it that way. Nothing in `data/enemies.js` applies `freeze` to the player — the
only player-facing statuses in that file are `slow`, `burn` and `shock` — so the
total-lockout case is not reachable from shipped content.

**The mirror arm I did not fix, and cannot:** `src/entities/Enemy.js:548`.
Monsters still ignore `slow` entirely. Frost Lattice, Hoarfrost Band, Concussion
Charge, Grapnel Tether's slow and the Aegis Emitter dome all still change nothing
about how fast a monster moves. It is the same one-line shape as the Player fix.
**Enemy.js is outside my file set, so this is escalated, not done.**

I also left `Combat.armorOf`'s player early-return alone: a slowed player taking
the `-15` armour penalty as well would be a balance change nobody asked for.

---

## 4. BLOCKING — no pull can move a grounded player. **Fixed.**

`src/entities/Player.js` — new `_harvestExternal`, `EXTERNAL_TAU`, and a strip/
restore around `_accelerate` in `_move`.

### The decision, and why

The brief asked for one of three: scale past the correction, suppress it, or
apply displacement. **None of the three, and here is the reasoning.**

- *Scale past it.* The controller corrects at 68–86 m/s². A pull that beats that
  beats the player's own input by construction — that is precisely "you lost
  control of the character".
- *Suppress the correction.* Same outcome, more abruptly: for the suppression
  window the stick does nothing.
- *Raw displacement.* Bypasses `capsuleResolve`, so a pull would drag the player
  through walls and up cliffs, and a reel would not be stoppable by geometry.

What is actually wrong is narrower than any of those. `_accelerate` caps its
correction at `rate * h` — 1.13 m/s per step — and the largest pull injection in
the game is 30 × (1/60) = 0.5 m/s. Being *under* the cap is the bug: the
correction snaps velocity exactly onto the target and the injected component is
discarded before it is ever integrated. It is not a weak pull, it is a deleted
one.

So the fix separates the two channels for one step. Whatever wrote to the
horizontal velocity while this pawn was not stepping is stripped off before the
correction runs and added back after it, so it survives into `_resolve` — through
the capsule solver, so a wall still stops a reel — while the player keeps full
authority over their own velocity the whole time. **It is drift on top of
control, never instead of it.** It ages out on a 0.25 s time constant rather than
being fought off, which is the only reason a sustained pull can build: a constant
injection settles at `accel × 0.25` instead of at zero.

Detection is a diff — velocity as this pawn left it versus velocity when it next
runs. Three cases would otherwise be misread as shoves and all three are handled:
an exactly-zero horizontal velocity is the signature of a hard reset (stage
respawn at `Progression.js:277`, a harness placement) and drops the accumulator;
`setNetState` clears it, because a host's velocity already has the host's pull
folded in; and `onDeath` clears it. In-step writers — ability leaps, the
dash-exit clamp, the capsule solver — all land *after* the harvest and are never
seen as external.

### Before/after — the pull itself

`results.pullClean` in `before-HEAD-2.json` / `after-fix-2.json`. Measured with a
**bare object**, not a live unit — `pullPlayer` reads only `position`, `tickT`
and `damage` — so this is the suction and nothing else, with no AI also driving
it. Held at fixed range, player standing still, 90 steps (1.5 s):

| attack | `pull` | range | accel | ground closed `75f87d6` | ground closed fixed | terminal drag |
|---|---|---|---|---|---|---|
| Lasher `reel` @10 m | 19 | 26 | 11.69 m/s² | **0.000 m** | **3.558 m** | 2.82 m/s |
| Lasher `reel` @5 m | 19 | 26 | 15.35 m/s² | **0.000 m** | **4.670 m** | 3.70 m/s |
| Maw `draw` @10 m | 26 | 34 | 18.35 m/s² | **0.000 m** | **5.585 m** | 4.43 m/s |
| Herald `collapse` @10 m | 30 | 40 | 22.50 m/s² | **0.000 m** | **6.220 m** | 5.43 m/s |

Terminal drag lands within 4% of `accel × EXTERNAL_TAU` in every row, which is
the model behaving as designed rather than as a tuned coincidence.

### The player has not lost control — measured

`results.sprintOutOfHeraldPull`, the strongest pull in the game at 10 m, player
sprinting directly away for 2 s:

| | `75f87d6` | fixed |
|---|---|---|
| ground gained | 12.70 m | **11.60 m** |
| distance to the puller | 10 → 22.70 m | 10 → **21.60 m** |
| closest the pull ever dragged them | 10.00 m | **10.00 m** |

A full sprint still wins outright. The pull costs 1.1 m of ground over two
seconds and never reverses the player's direction for a single frame. The card
comment — "never quite wins against a player running flat out — it steals ground,
it does not take control away" — is now true instead of aspirational.

### Ordinary movement is untouched — measured

`results.ordinaryMovement`, on a field verified empty
(`director.enabled false`, `enemies 0` throughout):

| | `75f87d6` | fixed |
|---|---|---|
| sprint distance, 2 s | 9.99 m | **9.99 m** |
| max external held during the sprint | (n/a) | **0.000** |
| frames to a dead stop after release | 1 | **1** |
| drift in the 1 s after stopping | 0.0000 m | **0.0000 m** |

### The mirror arm — knockback

`results.knockback` in probe 1. Knockback goes through the same channel and
`Enemy.js:929` writes it the same way, so it changed too, and it changed a lot:

| `knock` | displacement in 1 s `75f87d6` | fixed |
|---|---|---|
| 9 (Charger `gore`) | 0.398 m | **2.116 m** |
| 12 (Colossus `advance`) | 0.740 m | **2.811 m** |

**This is the one judgement call in this report that wants a human's eyes.** It
is not a side effect I overlooked: knockback was being eaten by the same
correction, just more slowly (9 m/s takes ~7 steps to grind off), and the channel
cannot distinguish a shove from a suction. The two are tied together by
`EXTERNAL_TAU` — halving the knockback halves the pull. 2.1 m of shove off a
charging beast reads to me as correct rather than excessive, and the player keeps
full steering throughout, but this is the change most likely to be felt and the
number to argue with is `EXTERNAL_TAU = 0.25` at `Player.js:76`.

### A number I retract

`probe1.json` → `results.movementControl` reports `driftIn1sAfterStop: 1.8026`
and `externalHeld: 1.3583` on the fixed arm against `0` on HEAD, which reads
exactly like a leak in the new channel. It is not. That stage ran on a field
where five units had been spawned and retired by earlier stages and was **not
verified empty**. `before-HEAD-2.json` / `after-fix-2.json` re-ran it with the
field asserted empty every frame and got `maxExternalDuringSprint: 0.000`,
`driftIn1sAfterStop: 0.0000` and `sprintDist2s: 9.99` on both arms. The
superseded file is left on disk rather than deleted so the retraction is
checkable.

---

## 5. MAJOR — co-op join/leave leaks two scene roots and 122 nodes. **Fixed.**

`src/entities/Player.js:919` (`dispose`) plus a new module-local
`releaseSubtree`. `clear()` on both pools only deactivates live entries; the
roots are added to the scene in the pools' constructors and populated to full
capacity there. `dispose` now detaches *and* disposes both pool roots and the
rig.

The doc comment is rewritten. Its claim that the rigs share material instances
is false — `makeCharacterMats` is called from the `CharacterMesh` constructor and
builds a fresh set per instance, as does every geometry in that file — and it was
the stated reason for freeing nothing.

**Before/after** — `results.coop`, four `_spawnPawn` / `_despawnPawn` cycles (the
two calls `NetHost` drives on peer connect/disconnect):

| | `75f87d6` | fixed |
|---|---|---|
| `scene.children` | 26 → **34** (+2/cycle) | 26 → **26** |
| `scene.traverse` nodes | 434 → **922** (+122/cycle) | 424 → **424** |
| `renderer.info.memory.geometries` | 403 → **607** | 401 → **401** |
| pool roots still parented to the scene | **8 of 8** | **0 of 8** |
| event-bus listeners | 74 → 74 | 75 → 75 |
| `combat.entities` | 1 → 1 | 1 → 1 |

The listener count is 75 rather than 74 on the fixed arm because of the new
`shieldBroken` subscription in VFX. It is flat across cycles on both arms, which
is the thing being tested — round 1's listener fix still holds.

`src/net/Coop.js` needed no change. Its comment describes the listener half,
which is accurate and still the reason `dispose()` exists.

---

## 6. MINOR — `setSurvivor` leaks ~53 geometries a swap. **Fixed.**

`src/entities/Player.js:296`. The old rig goes through the same `releaseSubtree`.
The comment's two stated hazards are both false and are replaced: rigs share
nothing (above), and `VFX.hitFlash` clones **materials** onto the meshes it is
flashing — which are these meshes, so they go with them — not geometry.

**Before/after** — `results.setSurvivor`, three full passes through the
five-survivor roster (15 swaps), `renderer.info.memory.geometries`:

| | `75f87d6` | fixed |
|---|---|---|
| after 0 / 5 / 10 / 15 swaps | 607 → 820 → 1086 → **1352** | 401 → 396 → 396 → **396** |
| per swap | ~+53 | **0** |
| `scene.children` | 34 flat | 26 flat |

---

## Build and capture

Both from `_r3tree` (fixed files on a clean `75f87d6`):

- `node node_modules/vite/bin/vite.js build` — **exit 0**, `✓ built in 5.70s`,
  only the pre-existing >500 kB chunk-size warning.
- `node tools/capture.mjs --out reviews/round7/r3-combat/capture --port 5397` —
  **21/21 shots**, `ready: true`, `clockPinned: true`, `frameDt 0.016666`,
  `frameTimeouts: 0`, `partial: false`. **Zero console errors, zero page
  errors.** One failing check, `06-loaded-hud` / `monsters under load`.

  That failure is byte-identical to the one `E-framing.md` §5 records and
  declines to fix, and to the one round 2 measured — diffed against
  `reviews/round7/r2-bugs/capture/manifest.json`, not eyeballed: the same single
  `objectFailures` entry `{i: 6, px: 137, sepP50: 0.17}`, the same
  `perPx [8,7,25,201,55,34,137,72,88,126]` and the same
  `perSep [0.37,0.43,0.31,0.49,0.37,0.29,0.17,0.71,0.15,0.85]`. The manifest's
  single `errors` entry is that harness message, not a JS error. `09-survivors`
  returns `perPx [1229, 1685, 1391, 1355, 1340]`, also identical, so the suite is
  still deterministic at seed 1337. **This round did not make it worse and did
  not move a pixel of any other shot's subject metrics.**

The three changed files in the main working tree are byte-identical to the ones
these two runs were made against (`diff -q` against `_r3tree`), so the build and
capture results describe the code that is on disk.

**The shared tree also builds**, once the parallel fixer's `Menus.js` parsed
again: `node node_modules/vite/bin/vite.js build`, `✓ built in 1.28s`, with all
four fixers' changes present. Both scratch worktrees have been removed and
`git worktree list` is back to this repo plus another agent's `OllieFace-r3base`.

### Two shared-tree hazards hit during this session, both repaired

1. `src/ui/Menus.js` was unparseable in the shared tree for roughly half the
   session, which is why the isolation above exists. It parses now; I did not
   touch it.
2. **The rolldown binding was destroyed mid-session** — the documented
   `npx` hazard, both halves of it at once:
   `node_modules/@rolldown/binding-win32-x64-msvc/package.json` deleted and
   `node_modules/rolldown/dist/shared/rolldown-binding.win32-x64-msvc.node`
   missing. I did not run `npx`. Repaired in place rather than reinstalling:
   the minimal `package.json` rewritten at version 1.2.1 to match
   `package-lock.json`, and the `.node` copied back from the intact
   `@rolldown/` package. `package-lock.json` still reports
   `lockfileVersion: 3`, and the build above is the proof it took. Worth
   knowing that this can happen to a tree while three agents are mid-flight.

---

## Arms I did not test — named, per the round's lesson

1. **Enemy movement under `slow`** (`Enemy.js:548`). Not fixed and not tested.
   Outside my file set. This is the other half of defect 3 and the one thing in
   this report that still leaves a shipped mechanic inert.
2. **The `onHit` items against a shielded enemy** — `items.js:310` (explode),
   `747` (Hoarfrost threshold), `1111` (Shrapnel Heart). I proved the payload
   they read now carries the pre-shield figure; I did not run the three items
   live against a barrier.
3. **The music duck.** Structural proof only — see defect 2.
4. **Co-op over a real connection.** Measured through `Coop._spawnPawn` /
   `_despawnPawn` on a host only. No two-machine or `NetHost` peer test.
5. **The client path.** `setNetState` clears the external channel; never
   exercised with `netRole === 'client'`. Likewise the replay path — a replayed
   command runs `_harvestExternal` like any other and I did not test rollback.
6. **Gamepad.** Every movement measurement drove `ctx.input.keys`. Round 2's own
   lesson was mouse-but-not-gamepad; I have tested keyboard and not gamepad.
7. **Dash while a pull is live.** The dash branch clears the external channel;
   read in code, not driven.
8. **Freeze on the player** as a *shipped* case — proved unreachable from
   `data/enemies.js` by grep, not by play.
9. **Items that grant the player a barrier, in a real fight.** The shield cases
   were driven by setting `player.shield` directly, not by holding Field Dressing.

## Not fixed, with reasons

- **Bramble Lasher `volley: 4`** (round2-content #3) — `data/enemies.js`, the
  content fixer's file.
- **Redoubt `trackDuring`** (round2-content #11) — same.
- **The music one-way latch** (round2-bugs #4) — `Audio.js` / `Music.js`, the
  audio fixer's.
- **`Enemy.js:548`** — see above. Escalated.
- **`Progression`/`Profile` "damage taken" now counting absorbed damage** — the
  one-line switch to `toHealth` belongs in the meta/UI fixer's files. Named in
  defect 1 rather than done silently.

## Found while working, filed rather than fixed

`Items.consumeImpulse` (`src/systems/Items.js:664`) has **no caller anywhere in
`src/`**. `applyImpulse` is written by three shipped items — `items.js:795` and
`:905` (jump impulses) and `:1470` (Tectonic Heart's movement stack) — and the
value they set is never read by anything. It is the same class of defect as the
pull: a channel with a writer and no consumer. I found it looking for somewhere
to route the pull. Items.js is off limits to me; the consumer would belong in
`Player._move` next to the external channel, which is my file, but wiring one end
of someone else's dead channel without owning the other end is how two systems
end up disagreeing. Filed for whoever owns Items.
