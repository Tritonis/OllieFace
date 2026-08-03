# Round 7 bug hunt — round 3 critique

Branch `round7/content-and-polish`, HEAD `b18a2b4`. Fresh-eyes, read-only. No product code was
modified (`git status --porcelain -- src/` empty at the end of the run). Ten throwaway Playwright
probes (`tools/_r4probeA..J.mjs`) were written, run, and deleted; **their raw JSON output is kept
on disk** under `reviews/round7/r4-bugs/` and every number below is quoted from a named file there.

**Verdict: FAIL.** Four majors. One of them was named by round 3's own combat fixer, escalated,
and then landed by nobody. Three are new, and all three are the *same shape*: round 3 connected two
previously-dead channels (`jump`/`consumeImpulse`, `Combat.speedMultiplier`) and rerouted a third
(`damage.amount`), and in each case the payload carries no answer to the question "**which**
player?". In single-player that question has one answer and everything works. In co-op it has
several and the code takes the local one every time.

Round 2's central lesson was "every fix was verified against the arm it was reported in". Round 3
learned the *stated* half of that lesson — it named its untested arms, accurately, and I found real
defects in three of the nine it named. It did not learn the unstated half: the arm nobody names is
the one where an event says *a player* and the code hears *the player*.

---

## Methodology

Everything marked CONFIRMED was reproduced against a running build. Everything marked PLAUSIBLE was
reasoned from source and says so.

- **Build.** `node node_modules/vite/bin/vite.js build` — exit 0, `✓ built in 1.45s`. Only the
  pre-existing >500 kB chunk-size warning.
- **Full capture.** `node tools/capture.mjs --out reviews/round7/r4-bugs/capture --port 5341`.
  Exit 0. 21 shots. On disk at `reviews/round7/r4-bugs/capture/manifest.json`.
- **Probes.** Ten Playwright sessions on private ports (5351–5403), headed with
  `--use-angle=d3d11 --ignore-gpu-blocklist`, parked off-screen — the launch config
  `tools/spawnprobe.mjs` uses, chosen over the headless/SwiftShader path because these are
  simulation measurements, not pixel ones. Page at `?seed=1337&quality=1&harness=1&pinclock=1`.
  `pageerror` and `console.error` captured in every session: **zero across all ten.**
- **Determinism of the simulation probes.** Rather than driving `rAF` and hoping, every physics and
  damage measurement steps the engine by hand —
  `ctx.time += 1/60; for (const s of engine.systems) s.fixedUpdate?.(ctx, 1/60)` — after
  `engine.stop()`. One rendered frame is not in the loop at all, so nothing is load-dependent.
- **No repo test runner exists.** `package.json` scripts are `dev`/`build`/`preview`/`shots`/
  `dev:lan`/`signal`. The 21-shot capture and its `mustContain` gates are the suite, and that is
  what was run.
- **Instrument discipline.** Three of my own instruments failed their sanity check and were thrown
  out rather than reported — see "Refuted by probing". One hypothesis I was fairly confident in
  (the scene-node growth across stage transitions) turned out to be content scaling and is reported
  as refuted so nobody re-runs it.
- **Redundancy.** The co-op replay divergence and the join/leave leak were each measured in two
  independent sessions with different instrumentation. Where the two disagreed (probe F's replay
  reading) I discarded the weaker instrument and re-measured at the mechanism instead of the
  outcome — see finding 3.

Read first, per brief: `reviews/round7/round2-bugs.md`, `round3-fix-combat.md`,
`round3-fix-integration.md`, `round3-fix-audio.md`.

---

## 1. MAJOR — every point a barrier absorbs is counted as damage *taken*, and it makes the `Untouchable` and `Ironclad` challenges unachievable for any player holding a barrier item

**Files:** `src/systems/Progression.js:149`, `src/systems/Profile.js:1111–1113`.
Introduced by `ac85d85` (`src/systems/Combat.js:468`).

Round 3's own rule, written into `Combat.applyDamage`'s comment at `Combat.js:434–447`:

> Attacking side — `incoming`. […] Defending side — `dealt`.

The commit then changed the `damage` event's `amount` from `dealt` to `incoming`
(`Combat.js:468`) and audited the *attacking*-side consumers round 2 had named. There are three
**defending**-side consumers reading the same field, and they were not audited:

```js
// Progression.js:148-150 — the `else` branch is the defending side
} else if (e.target?.isPlayer) {
  this.stats.damageTaken += e.amount;          // <- incoming, not toHealth
}

// Profile.js:1111-1113
run.damageTaken += amount;                     // amount = num(e.amount, 0)
run.damageTakenThisStage += amount;
this.data.stats.damageTaken += amount;         // lifetime career stat
```

### Reproduced — CONFIRMED
`reviews/round7/r4-bugs/probeB2-damage.json` → `absorbedHitAccounting`. Player at 110/110 with a
1000-point barrier, one `applyDamage(player, 50, {source: null, procCoefficient: 0})`:

```
health                             110  ->  110      (nothing reached health)
shield                            1000  ->  950      (the barrier ate all of it)
Progression.stats.damageTaken        0  ->   50      <- Progression.js:149
Profile.run.damageTaken              0  ->   50      <- Profile.js:1111
Profile.run.damageTakenThisStage     0  ->   50      <- Profile.js:1112
Profile.data.stats.damageTaken       0  ->   50      <- Profile.js:1113 (lifetime)
```

### The half that is not a counter
`run.damageTakenThisStage` is not cosmetic. `Profile.js:1041`:

```js
if (run.damageTakenThisStage <= 0) run.flawlessStages++;
```

and `flawlessStages` is the whole of two shipped challenges — `untouchable` ("Clear a stage
without taking damage", `challenges.js:266–274`) and `ironclad` ("Clear three stages in one run
without taking damage", `:275–284`).

**Reproduced — CONFIRMED.** `reviews/round7/r4-bugs/probeD-state.json` → `untouchable`. Two clean
stage clears as a control, then one stage in which the only hit is fully absorbed by a barrier:

```
control: two clean clears        flawlessStages 1, then 2
then, on stage 3:
  health                         unchanged        (healthUnchanged: true)
  shield                         1000 -> 950
  damageTakenThisStage           50
  flawlessStages after the clear 2                (expected 3)
  BROKEN                         true
```

So a player holding Field Dressing, Rubber Soles, Personal Shield, or any of the `addBarrier`
items — i.e. the players most likely to be *going for* a no-damage stage — cannot complete either
challenge if a single hit touches the barrier they bought for exactly that purpose. The two halves
of the game now disagree about what "taking damage" means: `playerHurt` and the `onDamaged` hooks
say *health lost* (correctly, since `ac85d85`), and the challenge that is literally named
"Untouchable" says *anything that arrived*.

### This was known
`round3-fix-combat.md:442–444`, under "Not fixed, with reasons":

> **`Progression`/`Profile` "damage taken" now counting absorbed damage** — the one-line switch to
> `toHealth` belongs in the meta/UI fixer's files. Named in defect 1 rather than done silently.

The escalation was correct and the routing was correct. The integration commit `b18a2b4` exists
precisely to close escalations the file partition prevented, and it did not take this one. What
the escalation *under-stated* is that this is not a counter bug: the `damageTakenThisStage` limb
gates content.

### Minimal fix
The payload already carries the right number.

```js
// Progression.js:149
this.stats.damageTaken += e.toHealth ?? e.amount;

// Profile.js:1101-1113 — split the two directions, since `amount` is now
// direction-dependent. `_onDamage` reads it once at the top:
const amount = num(e?.amount, 0);
const taken  = num(e?.toHealth ?? e?.amount, 0);
...
if (e?.target?.isPlayer) {
  if (taken <= 0) return;                 // a barrier-only hit is not damage taken
  run.damageTaken += taken;
  run.damageTakenThisStage += taken;
  this.data.stats.damageTaken += taken;
}
```

Note the `if (amount <= 0) return;` guard at `Profile.js:1105` currently sits above both branches
and must not be allowed to swallow the attacking side, which legitimately wants `incoming`.

---

## 2. MAJOR — in co-op, every remote peer's jump spends the *host's* item hooks: the host is paid a barrier, the host's quake fires at the host's own feet, and the peer is launched by an item it does not own

**File:** `src/entities/Player.js:676–688` (added by `b18a2b4`), with
`src/systems/Items.js:178`, `:728–729`, `:904`, and `src/systems/Items.js:889–891`
(`api.player = this.ctx.player`).

`b18a2b4` connected both ends of a channel that had a writer and no reader. The emit is global and
carries no identity:

```js
// Player.js:677-688 — runs in EVERY Player's _jump, local pawn or remote
ctx.events?.emit?.('jump', { air: !canGround, jumps: this.jumpsUsed });
const impulse = ctx.items?.consumeImpulse?.() || 0;
if (impulse > 0) { this.velocity.x += dx * impulse; this.velocity.z += dz * impulse; }
```

There is exactly one `Items` instance per client (`Items.init` does `ctx.items = this`), it
subscribes to that bus event (`Items.js:178`), and its hook API hard-binds the local survivor
(`Items.js:891` — `api.player = this.ctx.player`). `NetHost` drives `applyCommand` on a remote
pawn off the wire with a fresh tick, so `_replaying` is false and the emit fires. Three consequences,
all measured together.

### Reproduced — CONFIRMED, twice
`reviews/round7/r4-bugs/probeF-coop-tunnel.json` → `remoteJumpCrossTalk`, corroborating
`probeC-coop.json` → `remotePawnJump`. Host holds Waxed Wing ×3 (30 m/s impulse), Rubber Soles ×1
(10-point barrier on jump) and Tectonic Heart ×1 (9 m quake every 3rd jump). **The host never
jumps.** A pawn spawned via `ctx.coop._spawnPawn('peer-X')`, standing 25 m away, jumps three times:

```
host barrier            0 -> 30            <- Rubber Soles paid the HOST 10 per peer jump
peer pawn velocity.z    30, 30             <- the peer got the HOST's Waxed Wing launch
host velocity           0                  (the impulse went to the pawn, not the host)
quake rings drawn       1                  <- Tectonic Heart's 3rd-jump quake fired,
                                              at api.player.position = the HOST, 25 m away
```

Probe C's independent run measured the barrier at `0 -> 30` for the same three jumps.

So: a peer's jump mints barrier for the host, launches the peer with an item the peer does not
hold, advances the host's `tally('tectonic-heart', 3)` — which the card's own comment says is
host-only *so that the beat stays countable* (`items.js:1590–1594`) — and detonates a 9 m
player-team explosion at the host's feet with no input from the host at all. Two players jumping
alternately make the host's "every 3rd jump" quake fire on a beat the host cannot see.

`items.js:855` (Waxed Wing), `:965` (Updraft Vents), `:641` (Rubber Soles) and `:1595` (Tectonic
Heart) are all reachable this way; there is no shipping card on the `onJump` list that is safe.

### Minimal fix
Put the identity on the payload and gate the hooks on it — the emit site is already the right layer,
as `ac85d85` argued for `playerHurt`.

```js
// Player.js:677
ctx.events?.emit?.('jump', { player: this, air: !canGround, jumps: this.jumpsUsed });
const impulse = (this.local && ctx.items) ? (ctx.items.consumeImpulse?.() || 0) : 0;

// Items.js:178
ctx.events.on('jump', (e) => { if (!e?.player || e.player === this.ctx.player) this.onJump(e); });
```

`Player` already carries the flag — `Coop._spawnPawn` constructs with `{ local: false }`
(`Coop.js:41`).

---

## 3. MAJOR — a co-op client silently drops its own jump impulse on every replay, mispredicting its position by up to a 30 m/s launch per corrected jump

**File:** `src/entities/Player.js:676` — `if (!this._replaying) { … }`.

Every agent this round named this as an untested arm (`round3-fix-combat.md:422–424`:
*"Likewise the replay path — a replayed command runs `_harvestExternal` like any other and I did
not test rollback"*). It is real, and it is worse than the physics half they were worried about:
the *impulse* is inside the `!_replaying` block, so a replayed command produces a different
trajectory from the one it produced live.

`NetClient` corrects by applying a host snapshot and re-running every unacknowledged command
(`Player.applyCommand` sets `replay = c.tick > 0 && c.tick <= this._lastCmdTick`). Every replayed
jump therefore yields `vy = JUMP_SPEED` and **no horizontal impulse at all**.

### Reproduced — CONFIRMED, measured at the mechanism
`reviews/round7/r4-bugs/probeG-attrib-replay.json` → `replayGate`. Local inventory holds Waxed Wing
×3. A pawn is primed at tick 700, jumps live at tick 701, then the *same tick 701 command* is
replayed from an identical reset state, with `Items.consumeImpulse` instrumented:

```
live   : jump events emitted 1,  consumeImpulse returned [30]
replay : jump events emitted 0,  consumeImpulse never called   ([])
verdict: client replay silently drops the jump impulse -> mispredict
```

An earlier, weaker measurement (`probeC-coop.json` → `jumpReplay`) read the same divergence as a
30 m/s gap in post-solve velocity. I re-measured at the mechanism because a third session
(`probeF-coop-tunnel.json` → `replayDivergence`) read **zero** divergence — that run's pawn had
been placed on un-climbable ground, so `capsuleResolve` zeroed the horizontal velocity in *both*
arms and hid the difference. The mechanism-level reading is the one to trust; the outcome-level
one is terrain-dependent.

Impact: a client holding any of the four `onJump` impulse items rubber-bands on every jump that
gets corrected, by up to `impulse × EXTERNAL_TAU`-scale distances — and unlike a normal mispredict
this one does not converge, because the replay is *deterministically* missing the impulse rather
than merely starting from a different state.

### Minimal fix
The `!_replaying` gate exists to stop one-shot *effects* (VFX, audio, projectiles) firing twice. The
impulse is not an effect, it is movement, and movement must re-run identically. Split them:

```js
// Player.js:676-688
if (!this._replaying) ctx.audio?.footstep?.(this.position, 'dirt');
// Movement re-runs on replay; only the announcement is one-shot.
if (!this._replaying) ctx.events?.emit?.('jump', { player: this, air: !canGround, jumps: this.jumpsUsed });
const impulse = this._replaying ? (this._lastJumpImpulse || 0)
                                : (this._lastJumpImpulse = ctx.items?.consumeImpulse?.() || 0);
```

Caching the value the live pass consumed is the smallest change that makes the replay reproduce it;
the alternative (letting the replay re-fire `onJump`) would double-pay Rubber Soles' barrier and
re-roll Tectonic Heart's tally, which is what the gate is there to prevent.

---

## 4. MAJOR — the third arm of the shield fix: in co-op a *teammate's* damage resets the local player's hurt timer, fires the local hurt response, and reflects a teammate's hit onto the local player

**Files:** `src/systems/Combat.js:471–484`, `src/systems/Director.js:168–177`, with
`src/systems/Items.js:205`, `src/systems/VFX.js:1197`, `src/systems/Audio.js:158`,
`src/ui/HUD.js:146`.

Round 1 fixed player shields and broke enemy shields. Round 2 found that. Round 3 split the channels
by *direction*. Neither round asked the other question the payload cannot answer: **whose** player.

`Combat.js:471` gates on `target.isPlayer && dealt > 0`. `Coop._spawnPawn` registers every remote
pawn with Combat (`Coop.js:46` → `Player.init`), and a remote pawn is `isPlayer`. So the local bus
carries `playerHurt` and `shieldBroken` for damage to **other people's survivors**, and every
listener treats it as its own.

### Reproduced — CONFIRMED
`reviews/round7/r4-bugs/probeC-coop.json` → `remotePawnDamage`. A remote pawn 40 m from the local
player, local `Items._lastHurt` aged 30 s:

```
                               local playerHurt   local shieldBroken   local timeSinceHurt
pawn shield 1000, hit 50 (absorbed whole)   0            1                    30      <- correct half
pawn shield 0,    hit 50 (health lost)      1            1                     0      <- WRONG
                                                                 pawn health 110 -> 60
                                                                 local health 110 (untouched)
```

The absorbed arm is right — that is round 3's `dealt > 0` gate working. The arm underneath it is
not: **a teammate losing health resets the local player's "time since hurt" to zero.** That is the
exact knock-on round 2's finding 2 was about (`Items.js:205`, and the two items keyed on it —
Field Dressing at `items.js:578` and Siege Battery at `:1205`), reopened through a door round 2
never looked at. It also drives the local hitstop, vignette, aberration, HUD flash and 0.7 s music
duck from a hit 40 m away that cost the local player nothing.

The absorbed arm has its own, smaller version: `shieldBroken` fires locally for a *remote* pawn's
barrier and `VFX._onShieldAbsorb` (`VFX.js:1236`, new in `ac85d85`) shakes the local camera for it.

### The same blind spot in the reflect
`Director.js:172–176`, PLAUSIBLE (read, not driven — I have no two-machine harness):

```js
if (!ctx.authority || !e || !e.source?.isPlayer) return;   // any player's hit, including a peer's
...
const p = ctx.player;                                       // always the LOCAL survivor
this.ctx.combat?.applyDamage?.(p, e.amount * em.reflect, this._reflect);
```

A teammate shooting a warded elite reflects onto the host's own survivor. Before `ac85d85` this was
inert (`e.amount` was 0 while the barrier was up, which is round 2's finding 1); the fix that made
the reflect fire also made this reachable. `probeB-damage.json` → `wardedReflect` shows the reflect
is now live and lethal — 9 reflect hits took a 110 HP player to 0 in 30 identical attacks.

### Minimal fix
```js
// Combat.js:471 — these two channels mean "the survivor this client is playing"
if (target === ctx.player && dealt > 0) { ... }
// Combat.js:466 shieldBroken likewise:
if (target === ctx.player) ctx.events.emit('shieldBroken', ...)
// Director.js:174 — reflect at the attacker, not at whoever is local
const p = e.source;
```
`Profile._onDamage` already does exactly this (`Profile.js:1109` —
`if (e.target !== this.ctx?.player && this.ctx?.netRole !== 'single') return;`), so the pattern and
its justification are already in the tree; three call sites simply never adopted it.
`Progression.js:145–150` has no such guard either and folds teammates' damage into the local run
summary — see informational note 4.

---

## 5. MINOR — round 2's finding 4 (the music one-way latch) is unfixed, confirmed live on HEAD, and in co-op a teammate's death still silences the surviving player's soundtrack permanently

**Files:** `src/systems/Audio.js:709`, `src/systems/Music.js:790`, `src/systems/Combat.js:509`.

Round 3's combat fixer routed it correctly (`round3-fix-combat.md:439–440`: *"The music one-way
latch (round2-bugs #4) — `Audio.js` / `Music.js`, the audio fixer's"*). The audio fixer's report
closes with "MINOR 10 — the rest of the round-2 minors: all four are fixed", but those four are
round 2's *audio* minors (fade-out tail, the bed, `_impact`/`_riser`, the silent sequencer). This
one was not taken by anybody.

**Reproduced — CONFIRMED.** `reviews/round7/r4-bugs/probeJ-latch-slow.json` → `musicLatch`. Real
audio graph (a `KeyZ` gesture is issued before the probe, so the sequencer is genuinely running at
14 steps):

```
before            stopped false   _musicOff null    stepsEmitted 14
emit playerDead   stopped true    _musicOff true
emit stageStart   stopped true    _musicOff true    steps gained in 1 s: 0
                  musicEngine.resume === undefined
```

Both latches are still write-once, and there is still no `resume()`. `Combat._kill` still emits a
bare `ctx.events.emit('playerDead', {})` for any entity with `isPlayer` (`Combat.js:509`), so in
co-op one teammate dying kills the surviving player's music for the rest of the session while the
run continues. Single-player remains bounded by `location.reload()` on restart.

Filed MINOR, matching round 2, and re-filed rather than dropped because a fix routed to a named
owner that the owner did not take is exactly the failure mode this round exists to catch.

**Minimal fix:** unchanged from round 2 — give `MusicEngine` a `resume()` that clears `stopped` and
re-seats `_musicTime = ac.currentTime + 0.15`, and clear `_musicOff` from the `stageStart` handler
that already calls `musicEngine.cool()` (`Audio.js:105–110`).

---

## 6. MINOR — the newly-connected jump impulse has no ceiling, and above ~79 m/s the player tunnels through thin props

**Files:** `src/entities/Player.js:684–686`, `src/world/Stage.js:516–535`.

`b18a2b4` wired `applyImpulse`/`consumeImpulse` and added no clamp. Waxed Wing is
`linear(10, n)` m/s per stack (`items.js:856`), added straight onto `velocity`.

**Measured — CONFIRMED.** `reviews/round7/r4-bugs/probeA2-physics.json` → `waxedWing`, peak
horizontal speed while sprint-jumping:

| stacks | peak horiz speed | metres per fixed step |
|---|---|---|
| 0 | 10.156 | 0.169 |
| 1 | 20.150 | 0.336 |
| 3 | 40.150 | 0.669 |
| 10 | 110.150 | **1.836** |

`Stage.capsuleResolve` resolves horizontally with a single non-swept `_climbable` point test
followed by a depenetration pass **at the destination** (`Stage.js:516–560`). A step longer than
`2 × (cylinder.r + player.radius)` lands the player entirely past the prop's influence radius, so
the depenetration pass never sees it.

**Reproduced — CONFIRMED.** `reviews/round7/r4-bugs/probeF-coop-tunnel.json` → `tunnelling`, driven
straight at the thinnest cylinder on the seed-1337 stage (r = 0.21 m, one of 315):

```
speed  10 m/s (0.167 m/step)  passedThrough false
speed  20 m/s (0.333 m/step)  passedThrough false
speed  40 m/s (0.667 m/step)  passedThrough false
speed 110 m/s (1.833 m/step)  passedThrough TRUE
```

Threshold is `60 × 2 × (r + 0.45)` ≈ 79 m/s for r = 0.21, i.e. **seven stacks of one uncommon**.
Everything shipping *below* that is clean — see the clean list for the wall, prop and terrain cases.

**Minimal fix:** clamp the impulse where it is applied, at a value the solver can service:
`const impulse = Math.min(ctx.items?.consumeImpulse?.() || 0, MAX_IMPULSE)` with `MAX_IMPULSE`
around 30 (three stacks, the value round 3 tuned against). Sub-stepping `capsuleResolve` is the
principled fix and a much larger one.

---

## 7. MINOR — `Combat.speedMultiplier` returns a literal `0` for `freeze`, bypassing its own floor, and that number is now multiplied straight into the player's move speed

**Files:** `src/systems/Combat.js:596`, `src/entities/Player.js:568–569`.

```js
speedMultiplier(entity) {
  ...
  if (s.type === 'freeze') return 0;     // <- returns before the floor below
  if (s.type === 'slow') mult *= 1 - s.magnitude;
  return Math.max(0.25, mult);           // the floor `slow` gets and `freeze` does not
}
```

`ac85d85` wired this into `Player._move` (`Player.js:569` — `stats.moveSpeed * … * status`). For an
*enemy* a hard zero is correct and is the point (`Enemy.js:678`). For the player it is a 100 %
movement lock with no duration display, no i-frames and no counterplay, and the `Math.max(0.25, …)`
floor that the author clearly intended as the safety rail is unreachable on that path.

**Measured — CONFIRMED that the wiring produces it.** `probeJ-latch-slow.json` → `playerSpeed`:
`clean 7.000`, `slow×1 1.132`, `freeze 0.005` m/s peak over 2 s.

**Not currently reachable.** `grep -o "status: '[a-z]*'" src/data/enemies.js` gives exactly
`burn ×4, shock ×2, slow ×4` — nothing in shipping enemy data applies `freeze` to the player. Round
3 verified the same thing by grep and said so (`round3-fix-combat.md:429–430`). Filed as latent: the
next card that gives an elite a freeze rider will discover it, and the guard costs one word.

**Minimal fix:** `if (s.type === 'freeze') return entity.isPlayer ? 0.15 : 0;` — or let freeze fall
through to the existing floor and keep the hard zero on the enemy side only.

---

## 8. MINOR — a barrier absorbing a hit now produces no sound at all

**Files:** `src/systems/Combat.js:471`, `src/systems/Audio.js:158`, `src/systems/VFX.js:1236`.

`ac85d85` moved the gate to the emit site — correctly, and its reasoning is sound — and gave VFX a
replacement channel (`VFX._onShieldAbsorb`, a 0.035 camera shake off `shieldBroken`). Audio got
nothing. `Audio.js:158` subscribes only to `playerHurt`, which no longer fires, and there is no
`shieldBroken` subscriber anywhere in `Audio.js`.

**Measured.** `probeB2-damage.json` → `absorbedFeedback`: `playerHurt 0, shieldBroken 1`, camera
shake `0.2307 → 0.2657` (+0.035, the VFX response), aberration and hitstop unchanged. Correct on
every axis except that the player's **primary off-screen threat signal is silent**. Round 3's own
audio report opens by arguing at length (`round3-fix-audio.md:40–43`) that
*"the 'I am taking damage' sound is the player's primary off-screen threat signal"* — and under a
barrier there is now no such sound, from any direction, at any severity.

**Minimal fix:** `e.on('shieldBroken', (p) => this.shieldTick(p?.absorbed ?? 0));` with a quieter,
distinct cue — the same shape as VFX's deliberately-reduced response.

---

## Observed but not confirmed (informational)

1. **`Director._reflect` is a shared mutable `info` object handed to a re-entrant function.**
   `Director.js:111` allocates one object; `:174–176` mutates `source`/`position` on it and passes
   it into `applyDamage`, which reads `info.procCoefficient` and `info.procDepth` at
   `Combat.js:490–491` — *after* it has emitted `damage`, which can synchronously re-enter the
   reflect handler. Harmless today because both of those fields are constants on `_reflect` and
   never written; it becomes a live aliasing bug the moment anyone adds a per-hit field. Newly
   relevant because the reflect actually fires now. Measured nesting: 4 (`probeB2` →
   `reflectChain`).

2. **`_external` is not reconciled when `capsuleResolve` zeroes only one horizontal axis.** Under an
   artificial stress (18 shoves of 40 m/s into the stage bound) `probeA-physics.json` → `boundPush`
   recorded `_external` accumulating to 42.206 and a velocity of −18.272 m/s the player never asked
   for, with position correctly clamped and `outSteps: 0`. Not reproducible from any shipping input
   — the largest `knock` in `data/enemies.js` is 12, and every realistic case came back clean (see
   the clean list). Reported because the bookkeeping *is* wrong, not because I can make it hurt.

3. **`Progression` and `Profile` disagree about which direction self-damage points.**
   `Progression.js:144` tests `e.source?.isPlayer` first, so a self-inflicted hit (Arc Rot's
   `payHealth`, Shrine of Blood) counts as damage **dealt** and can set `highestHit`;
   `Profile.js:1106` tests `e.target?.isPlayer` first and counts the same hit as **taken**.
   `probeB2` → `selfAndEnv` shows both events firing (`playerHurt 2, damage 2`) for a self-hit and
   an environmental one.

4. **`Progression.js:145–150` has no local-player guard.** `Profile._onDamage` explicitly filters
   remote pawns (`Profile.js:1109`, with a comment explaining why); `Progression` does not, so in
   co-op the run summary's `damageDealt`, `highestHit` and `damageTaken` include every teammate's.

5. **`EventBus.emit` still has no per-listener try/catch** (`Engine.js:239–243`). A listener that
   throws aborts the emit for everything registered after it. Unchanged from round 2's
   informational note; `stageStart` and `damage` now carry more subscribers than they did.

6. **`Items.give()` still no-ops for 11 of the 108 items on a maximal inventory** — 108 given,
   97 non-zero counts (`probeE-lifecycle.json` → `itemsGiven`). Byte-identical to round 2's
   informational reading. Almost certainly the Blight corruption tier converting on arrival. Not
   filed, for the same reason round 2 did not file it.

7. **Scene-graph node count grows unboundedly with stage index, by design.** 399 nodes at stage 0,
   765 at stage 12 (`probeE` → `stageTrace`). This is `Interactables.populate`'s
   `chestCount = 14 + stageIndex * 4` (`Interactables.js:1637`) — see "Refuted by probing". Not a
   defect, but a 30-stage run puts ~130 chest groups in front of `projectObject` every frame with
   no cap and no LOD, and nothing in the codebase acknowledges that.

---

## Refuted by probing — reported so nobody re-runs them

- **"Stage transitions leak scene-graph nodes."** The strongest-looking signal of the run: node
  count rose monotonically 399 → 765 across 12 transitions with `scene.children` pinned at 25, and
  identity-stable attribution (`probeH-attribution.json`) pinned +283 nodes onto one child.
  Naming that child (`probeI-rootnames.json`) made it `ctx.interactables.root`, and driving
  `Interactables.populate` directly settled it (`probeJ` → `interactablesScaling`): 24 / 46 / 66 /
  88 root children at stage index 0 / 3 / 6 / 9, exactly tracking `14 + 4n` chests plus `2 + n`
  shops. `clear()` is called first thing in `populate` and works. **Not a leak.** Geometry, texture
  and program counts are flat or oscillating across the same 12 transitions.
- **"The first jump of a session loses its impulse."** Probe C read `0.07 m/s` on a remote pawn's
  first jump and I hypothesised an uninitialised `_pendingImpulse` producing `Math.max(undefined, 30)
  = NaN`. `Items.js:142` initialises it to `0`, and `probeG` → `localFirstJumps` measured
  `consumeImpulse` returning `[30, 30, 30]` on the first three jumps. Probe C's pawn had been placed
  on un-climbable ground and `capsuleResolve` zeroed its horizontal velocity. **Probe artefact.**
- **My own enemy slow/freeze instrument.** `probeJ` → `enemyTravel2s` read
  `clean 1.074, slow 2.392, freeze 1.073` m over 2 s. A slowed enemy travelling *further* than a
  clean one is impossible, so the instrument is measuring FSM state, not movement, and I am not
  reporting anything off it. Round 3's integration claim that a frozen enemy measures 0.000 is
  therefore listed **UNVERIFIABLE by this probe**, not refuted. The player-side half of the same
  claim I did measure and it holds.

---

## Areas checked that came back clean

- **Build.** `node node_modules/vite/bin/vite.js build`, exit 0, 1.45 s, no errors.
- **Full 21-shot capture**, `reviews/round7/r4-bugs/capture/manifest.json`: exit 0, `ready: true`,
  `clockPinned: true`, `frameDt 0.016666`, `frameTimeouts: 0`, **0 page errors, 0 console errors**.
  `perf` is byte-identical to round 2's run — `programs 87, geometries 681, textures 53,
  sceneObjects 395` — so the suite is still deterministic at seed 1337 across two commits.
- **`audioOk: true`**, `{ready: true, state: "running", stepsEmitted: 300, newErrors: []}`. The new
  gate works and the sequencer is genuinely running under it. Round 2's capture has no `audio` block
  at all, so this is the first capture in the project's history that proves any of `Audio.js` or
  `Music.js` executed.
- **`06-loaded-hud` / "monsters under load" — the one known failing check, unchanged in kind.**
  Same shot, same subject, same object index 6, same `sepP50: 0.17`, same cause (per-object
  separation below the 0.25 gate). Its pixel count drifted `137 → 145` and neighbouring objects
  moved by single digits, which is content drift between `75f87d6` and `b18a2b4`, not a new failure.
  This is the failure `E-framing.md` §5 records and declines to fix. **Not chased.**
- **Round-2 finding 3 — the co-op join/leave leak. FIXED.** 15 `_spawnPawn`/`_despawnPawn` cycles
  (`probeC-coop.json` → `joinLeave15`): `scene.children 25 → 25`, `scene.traverse 399 → 399`, bus
  listeners `75 → 75`, `combat.entities 1 → 1`, `coop.pawns.length 0`. Round 2 measured +2 children
  and +122 nodes per *four* cycles; there is now no growth at fifteen.
- **Round-2 finding 5 — the survivor-swap geometry leak. FIXED.** Three full passes through the
  five-survivor roster, 15 swaps (`probeD-state.json` → `survivorSwaps`):
  `geometries 396 → 343 → 343 → 343`. Round 2 measured `462 → 728 → 994 → 1260`. The first pass now
  *drops* 53 geometries (the initial rig being disposed for the first time) and the count is flat
  thereafter.
- **Round-2 finding 2 — `playerHurt` at zero. FIXED, single-player arm.** `probeB2` →
  `absorbedFeedback`: a 50-damage hit into a 1000 barrier gives `playerHurt 0`, `shieldBroken 1`,
  `timeSinceHurt 30 → 30` (was `30 → 0`), aberration unchanged, hitstop unchanged, camera shake
  +0.035 from the deliberate `shieldBroken` response. The co-op arm is finding 4.
- **Round-2 finding 1 — the warded reflect. FIXED.** `probeB-damage.json` → `wardedReflect`: 30
  identical 120-damage hits into a `warded` elite with a live barrier produced **9 reflect hits
  totalling 118.8**, taking the player from 110 HP to 0. Round 2 measured 0 reflects and 0 damage.
  (Nine rather than thirty because the player dies on the ninth — the affix works.)
- **The reflect ↔ thorns chain is bounded.** `probeB2` → `reflectChain`, warded elite with a 50 000
  barrier, player holding Iron Thornplate ×3 and Barb Snare ×3, one 5000-damage hit:
  `applyDamageCalls 6, maxNesting 4`. The player's 0.1 s i-frames (`Player.js:176`) terminate it.
  No runaway, despite `Combat.js:429`'s `Math.max(1, amount)` floor making a decaying chain
  non-decaying in principle.
- **`capsuleResolve` genuinely still stops a reel at a wall.** `probeA2` → `reelIntoWall`: a
  `pull: 26` reel dragging the player straight into a 3.74 m cylinder for 300 steps —
  `minGap 0.000, penetratedSteps 0, crossedSteps 0`, final velocity 0. The player ends flush against
  the prop and does not enter it.
- **Knockback into a prop and into un-climbable terrain: no penetration, no rebound, no residue.**
  `probeA2` → `knockIntoProp`: a 12 m/s shove (the largest `knock` in the game) into a cylinder
  zeroes the velocity at step 4 and `_external` self-clears to 0 at step 5 via the zero-horizontal
  reset. `knockIntoTerrain`: `peakBackwardVx 0.000`. No spurious rebound in either.
- **Knockback displacement is linear and matches the reported figure.** `probeA` → `knockback`:
  `dx = 0.2411 × k` exactly for k = 3/6/9/12/20 (0.723, 1.447, 2.170, 2.894, 4.823 m). A 9 m/s shove
  moves the player **2.170 m**; `b18a2b4`'s commit message says 2.136. Same number to within the
  difference in start conditions, and 5.5× the 0.398 m of the pre-fix build.
- **The external channel does not survive a stage transition or a death.** `probeD` →
  `extAcrossStage` (`11.226 → 0`) and `extAcrossDeath` (`11.226 → 0`).
- **Dash clears the external channel.** `probeA` → `dashClearsExternal`: `8.420 → 0`.
- **No out-of-bounds, no under-floor, no escape at any impulse stack count.** `probeA2` →
  `waxedWing` at 0/1/3/10 stacks over 600 steps of sprint-jumping: `stepsBelowFloor 0`,
  `outOfBounds false` at every stack. `probeA` → `boundPush`: 18 shoves of 40 m/s at the stage
  bound, `outSteps 0, maxOver 0.0000`.
- **The empty-`attacks` guard (`b18a2b4`'s claim). CONFIRMED.** `probeE` → `emptyAttacks`: a spawn
  card with `attacks: []` spawns and runs 240 frames with **0 frame errors**. Round 3 measured 212
  errors in 240 frames before the guard.
- **The three new enemies.** `probeE` → `newEnemies`: `shriver`, `lasher`, `redoubt` all present,
  9 spawned, 240 frames, 0 frame errors, all torn down by the next `stageStart`
  (`enemies 0, entities 1`).
- **All 108 items at ×3 stacks through a 14-enemy fight including warded elites**, 300 fixed steps:
  `probeE` → `bigFight`, `frameErrorsDelta 0`, `lastFrameError null`.
- **Logbook open/close ×12.** `probeE` → `logbookTrace`: geometries, textures, scene nodes, scene
  children and bus listeners identical across all twelve. DOM grows once (+51) on the first open and
  is then flat at 585 for cycles 2–12 — the lazy build, not a leak.
- **Stage transitions ×12.** `probeE` → `stageTrace`: bus listeners flat at 75, `scene.children`
  flat at 25, textures flat at 53, programs settle at 83 by transition 4, geometries oscillate
  396–403 with no trend, `combat.entities 1`, `combat.statuses 0`, `Items._clouds 0`,
  `director.enemies 0` after every one.
- **`applyDamage`'s return value still has no consumer** anywhere in `src/`, re-grepped after five
  agents' edits. The doc comment at `Combat.js:369–373` and the `return incoming` at `:501` agree
  with each other and bind nothing.
- **DoT correctly bypasses i-frames and is absorbed correctly.** `probeB2` → `dotIntoShield`:
  `{amount: 40, toHealth: 0, absorbed: 40}` through a hard `_iframeUntil`.
- **`slow` and `freeze` now reach the player** (`ac85d85`'s claim 3, directionally). `probeJ` →
  `playerSpeed`: `clean 7.000`, `slow×1 1.132`, `freeze 0.005` m/s peak. The mechanism is live; my
  absolute numbers do not reproduce the report's (different sprint state and start position), so the
  *magnitudes* are listed UNVERIFIABLE below rather than confirmed.
- **Zero console errors and zero page errors across all ten probe sessions and the capture.**

---

## Verification table — round 3's claims

| # | Claim | Source | Verdict |
|---|---|---|---|
| 1 | Enemy-shield damage no longer reports zero; `damage` carries `{amount, toHealth, absorbed}` | fix-combat §1 | **CONFIRMED** — `probeB2` → `dotIntoShield`, `probeB` → `wardedReflect` |
| 2 | The `warded` reflect fires where it fired 0 | fix-combat §1 | **CONFIRMED** — 9 reflect hits, 118.8 damage, player 110 → 0 |
| 3 | A fully-absorbed hit emits no `playerHurt`; `timeSinceHurt` survives it | fix-combat §2 | **CONFIRMED** — `30 → 30`, aberration and hitstop unchanged |
| 4 | No listener needed changing; the emit site was the right layer | fix-combat §2 | **CONFIRMED for single-player. REFUTED for co-op** — see finding 4; the emit gates on `isPlayer`, not on *which* player |
| 5 | `slow`/`freeze` now reach the player | fix-combat §3 | **CONFIRMED** (mechanism). Magnitudes **UNVERIFIABLE** — my `clean 7.000 / slow 1.132` does not reproduce their `10.150 / 6.090` |
| 6 | A frozen *enemy* measures 0.000 | integration | **UNVERIFIABLE** — my instrument failed its own sanity check (slowed enemy travelled further than clean); not refuted, not confirmed |
| 7 | Pull now moves a grounded player; lasher `reel` at 26 lands them inside its 6 m blast | integration | **CONFIRMED, numbers not reproduced** — `probeA` → `pull`: stationary at 10 m ends at **4.568 m** (report says 5.13); inside the blast either way. Escape figures likewise directionally right, numerically different |
| 8 | Knockback keeps the larger displacement (~2.1 m for a 9 m/s shove) | integration | **CONFIRMED** — 2.170 m measured, linear at 0.2411 × k across k = 3…20 |
| 9 | `capsuleResolve` still stops a pull at a wall | fix-combat §4 | **CONFIRMED** — 300 steps of reel into a 3.74 m cylinder, `minGap 0.000`, `penetratedSteps 0` |
| 10 | Waxed Wing takes a jump to 19.36 / 39.36 m/s at 1 / 3 stacks, exactly linear | integration | **CONFIRMED as linear, numbers differ** — I measure peak 20.150 / 40.150 (`10.15 + 10n`); the 0.79 gap is one deceleration step. Also **unbounded** — see finding 6 |
| 11 | `consumeImpulse` and the `jump` emit are now both connected | integration | **CONFIRMED** — `[30, 30, 30]` on the first three jumps. And **newly broken in two directions** — findings 2 and 3 |
| 12 | An `Enemy` with empty `attacks` is guarded in all three places | integration | **CONFIRMED** — 240 frames, 0 errors |
| 13 | The co-op join/leave leak is closed (round-2 #3) | fix-combat §5 | **CONFIRMED** — 15 cycles, zero growth on four independent counters |
| 14 | `setSurvivor` no longer leaks ~53 geometries a swap (round-2 #5) | fix-combat §5 | **CONFIRMED** — 15 swaps, flat at 343 |
| 15 | The capture harness now gates on audio (`stepsEmitted > 0`) | fix-audio | **CONFIRMED** — `audioOk: true`, `stepsEmitted: 300`, exit 0 |
| 16 | `Progression`/`Profile` "damage taken" counts absorbed damage — *named, not fixed* | fix-combat "Not fixed" | **CONFIRMED as still broken**, and its severity under-stated — finding 1 |
| 17 | The music one-way latch — *named, routed to the audio fixer, not fixed* | fix-combat "Not fixed" | **CONFIRMED as still broken** — finding 5 |
| 18 | Untested arm: "the client path… the replay path… I did not test rollback" | fix-combat §"Arms I did not test" 5 | **DEFECT FOUND in that arm** — finding 3 |
| 19 | Untested arm: "co-op over a real connection… no NetHost peer test" | fix-combat §"Arms" 4 | **DEFECTS FOUND in that arm** — findings 2 and 4 |
| 20 | Untested arm: "dash while a pull is live — read in code, not driven" | fix-combat §"Arms" 7 | **CONFIRMED clean** — `dashClearsExternal 8.420 → 0` |
| 21 | Untested arm: "freeze on the player, proved unreachable by grep not by play" | fix-combat §"Arms" 8 | **CONFIRMED unreachable** (`burn ×4, shock ×2, slow ×4` only) — but the code path is a hard 0 with no floor, finding 7 |
| 22 | Untested arm: "the `onHit` items against a shielded enemy, not run live" | fix-combat §"Arms" 2 | **CONFIRMED clean** — 108 items ×3 through 14 enemies including warded elites, 0 frame errors |

---

## Summary

| # | Severity | File:line | Status |
|---|---|---|---|
| 1 | **Major** | `Progression.js:149`, `Profile.js:1111–1113` (from `Combat.js:468`) | Confirmed — reproduced twice. Breaks `untouchable` / `ironclad`. **Known, escalated, never landed.** |
| 2 | **Major** | `Player.js:676–688`, `Items.js:178/891` | Confirmed — reproduced twice. **New in `b18a2b4`.** Co-op: host's items pay for a peer's jump. |
| 3 | **Major** | `Player.js:676` | Confirmed at the mechanism. **New in `b18a2b4`.** Co-op client mispredicts every corrected jump. |
| 4 | **Major** | `Combat.js:466/471`, `Director.js:174` | Confirmed (hurt-timer arm); reflect arm plausible. The third arm of the shield fix. |
| 5 | Minor | `Audio.js:709`, `Music.js:790`, `Combat.js:509` | Confirmed — round-2 #4, routed and dropped. |
| 6 | Minor | `Player.js:684`, `Stage.js:516` | Confirmed — tunnels a 0.21 m prop at 110 m/s (7+ stacks). |
| 7 | Minor | `Combat.js:596`, `Player.js:569` | Confirmed mechanism; unreachable from shipping data. Latent. |
| 8 | Minor | `Audio.js:158` | Confirmed — an absorbed hit is now silent. |

Build: **pass**. Capture: **21/21 shots, exit 0, `audioOk: true` (300 sequencer steps), 0 console
errors, 0 page errors, 1 failing check (`06-loaded-hud` / "monsters under load") unchanged in kind
from round 2 and from `E-framing.md` §5.** No repo test runner exists.

The physics change — the thing the brief flagged as the highest risk in the branch — **holds**. I
pushed it at walls, at props, at un-climbable terrain, at the stage bound, through dashes, through
stage transitions, through death, at five knockback magnitudes and four pull strengths, and could
not get the player through geometry, out of bounds, under the floor or off the map. The one thing
that *does* get through geometry is the impulse channel `b18a2b4` newly connected, and only above
seven stacks of one uncommon.

The real damage this round is not in the physics. It is that three separate mechanisms —
`damage.amount`, `jump`, and `playerHurt` — carry a payload that names a *quantity* and not a
*subject*, and every consumer resolves the missing subject to `ctx.player`. Round 1 broke the
enemy/player axis of that. Round 3 fixed it and introduced the local/remote axis of the same thing,
in the same three files, in the same week. The four majors above are one defect wearing four
costumes, and the fix for all of them is the same word: put the entity on the event.
