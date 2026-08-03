# Round 7 bug hunt — round 2

Branch `round7/content-and-polish`, HEAD `75f87d6`, base `master`. Read-only hunt; no product
code was modified. Four throwaway Playwright probes (`tools/_r2probe.mjs` … `_r2probe4.mjs`)
were written to prove the findings against the live game and have been deleted.

**Verdict: FAIL.** One critical regression introduced by this branch, two majors that are
incomplete fixes of round 1's own findings.

---

## Methodology

Everything below that says CONFIRMED was reproduced against a running build, not reasoned about.

- **Build.** `node node_modules/vite/bin/vite.js build` — exit 0, `✓ built in 1.32s`, no errors.
  Only the pre-existing >500 kB chunk-size warning.
- **Full capture.** `node tools/capture.mjs --out reviews/round7/r2-bugs/capture --port 5231`,
  21 shots, real GPU path, seed 1337, clock pinned. On disk at
  `reviews/round7/r2-bugs/capture/manifest.json`. Results in "areas clean" below.
- **Live probes.** Four Playwright sessions against `vite` on private ports (5233/5235/5237/5239),
  headless Chromium with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
  --enable-webgl` copied from `tools/capture.mjs`, page at
  `?seed=1337&quality=0..1&harness=1&pinclock=1`, driving `globalThis.__GAME__` / `__HARNESS__`.
  Console and `pageerror` were captured in every session: **zero errors across all four.**
- **No repo test runner exists** (`package.json` scripts are `dev`/`build`/`preview`/`shots`/
  `dev:lan`/`signal`); there are no test files under `reviews/`. The capture suite's 21 shots and
  their `mustContain` gates are the test suite, and that is what was run.
- **Instrument sanity.** Every metric quoted was cross-checked against a second, independent
  observation before being relied on: the co-op leak is quoted both as `scene.children.length` and
  as a `scene.traverse` node count *and* as `pawn.projectiles.root.parent === ctx.scene`; the
  shield finding is quoted both as the emitted event payload and as the player's health delta.
  Two hypotheses were **refuted** by probing and are not reported (see "refuted" below).

Read first, per brief: `reviews/round7/D-bugs.md`, `reviews/round7/E-framing.md` §5–§6,
`reviews/round6/HANDOFF.md` "Open, in priority order" and "Standing hazards".

---

## 1. CRITICAL — every point of damage absorbed by an *enemy* shield is now reported as zero, which kills the `warded` affix outright and blanks three items and every damage counter

**File:** `src/systems/Combat.js:440–458` (introduced by commit `4a1a098`, round 1's fix for
D-bugs #2). Blast radius: `src/systems/Director.js:167–177`, `src/systems/VFX.js:2396`,
`src/ui/HUD.js:158`, `src/systems/Progression.js:144–151`, `src/systems/Profile.js:1049–1054`,
`src/data/items.js:310, 747, 1111`.

### What changed

```js
// Combat.js — master
let dealt = amount;                 // captured BEFORE the shield block
if (target.shield > 0) { ... amount -= absorbed; }

// Combat.js — HEAD (4a1a098)
const incoming = amount;
if (target.shield > 0) { ... amount -= absorbed; }
const dealt = amount;               // 447 — captured AFTER the shield block
...
ctx.events.emit('damage', { target, source, amount: dealt, crit, position: pos, ... });  // 456
this._dispatch('onHit', { target, source, amount: dealt, ... });                          // 481
return dealt;                                                                             // 489
```

Round 1's finding was about the **player's** shield and about `playerHurt` / `onDamaged`. The fix
changed `dealt` globally, so the `damage` event, the `onHit` item hook and `applyDamage`'s return
value all changed meaning for **enemy** targets too. `damage` is the game's only "a hit landed"
channel and six systems read its `amount`.

### The `warded` elite affix is now dead code in both branches

`src/data/enemies.js:1221–1224` — the tier-2 `warded` affix, documented as
*"a reflective barrier that must be broken before the unit takes real damage, and that pays a
quarter of everything you put into it straight back at you"*, `shield: 1.1, reflect: 0.22`. The
reflect is deliberately hung off the `damage` event rather than `Enemy.takeDamage`
(`Director.js:158–166` explains why at length, and `Enemy.js:381–385` explains why it is *not*
there). Its guard:

```js
// Director.js:171
if (!em || !em.reflect || !t.alive || t.shield <= 0) return;
...
this.ctx.combat?.applyDamage?.(p, e.amount * em.reflect, this._reflect);   // 176
```

Both branches are now unsatisfiable:

- shield survives the hit → `t.shield > 0` passes, but `e.amount === 0`, so the reflect applies
  `0 × 0.22 = 0` and `applyDamage` early-returns on `amount <= 0`;
- shield is exhausted by the hit → `t.shield === 0`, so the guard returns before the reflect.

**Reproduced — CONFIRMED.** Spawned a `warden` with the `warded` affix
(`ctx.director.spawnOne(ctx, card, pos, 'warded')`), gave the player full health and no shield,
and applied 30 identical player hits of 120 through `ctx.combat.applyDamage`:

```
elite: { reflect: 0.22, shield: 1.1 }   health 1632   shield 1795.2
hit  0: applyDamage returned 0, elite shield 1741.2, elite hp 1632, player hp 110
hit 15: applyDamage returned 0, elite shield  931.2, elite hp 1632, player hp 110
hit 29: applyDamage returned 0, elite shield  175.2, elite hp 1632, player hp 110

player health 110 -> 110      reflect events fired: 0      reflect damage: 0
every 'damage' event for the elite: { amount: 0 }
```

The hits are landing — the barrier drains 1795 → 175 exactly as it should — and the affix's entire
mechanic never fires once. On `master` `e.amount` was the pre-shield figure and the reflect worked.

### The same zero reaches five more consumers

All of these are read off the identical `amount: 0`:

| consumer | file:line | effect |
|---|---|---|
| floating damage numbers | `VFX.js:2396` `Math.max(1, Math.round(amount))` | a 3000-damage hit into a barrier renders as **"1"** |
| HUD run damage counter | `HUD.js:158` `this.stats.damage += e.amount \|\| 0` | damage into any shield never counted |
| `Progression.stats` | `Progression.js:145–147` | `damageDealt` and `highestHit` never counted |
| `Profile` career + "Biggest hit" PB | `Profile.js:1039–1054` (`if (amount <= 0) return`) | lifetime `damageDealt` / `highestHit` never counted |
| `onHit` item hooks | `Combat.js:481` | see below |

Three shipped items lose their whole effect against any shielded target, because their hook
arithmetic is a multiple of `e.amount`:

- `items.js:310` — `api.combat.explode(..., e.amount * 1.05, ...)` → detonates for 0.
- `items.js:747` — Hoarfrost Band: `if (e.amount < api.items.baseDamage() * 4) return;` → the
  threshold can never be met, so the proc never fires.
- `items.js:1111` — Shrapnel Heart: `api.combat.explode(..., e.amount * 0.6, ...)` → detonates for 0.

### Why this is not a corner case

`overloading` is a **tier-1** affix with `unlock: 0` (`enemies.js:1192, 1215`) and carries
`shield: 0.5`. Elites with barriers are present from the first stage of every run, and the
`warded` tier unlocks at difficulty 3.2. Roughly the first third (overloading) to half (warded) of
an elite's effective HP is spent in a state where the player's damage numbers read "1", the HUD
counter is frozen, three items are inert and the affix that exists to punish trading damage does
nothing.

### Minimal fix

Keep `amount` on the `damage` event and on `onHit` meaning what it has always meant — the hit that
landed — and carry the health figure alongside, exactly as `playerHurt` already does with
`absorbed`:

```js
ctx.events.emit('damage', {
  target, source, amount: incoming, toHealth: dealt, absorbed: incoming - dealt,
  crit, position: pos, proc: info.procCoefficient || 0,
});
...
this._dispatch('onHit', { target, source, amount: incoming, ... });
```

`playerHurt` and the `onDamaged` gate keep `dealt`, which is what round 1's finding actually asked
for. `Director.js:171`'s guard then works again unchanged. `applyDamage`'s return should stay
`dealt` only if no caller consumes it — grep confirms none currently does, so either is safe, but
returning `incoming` matches the doc comment at `Combat.js:360–368`.

---

## 2. MAJOR — `playerHurt` is emitted at zero and three of its four listeners do not check the amount; Field Dressing and Siege Battery are broken by hits that cost nothing

**File:** `src/systems/Combat.js:460–466`. Consumers: `src/systems/Items.js:205`,
`src/systems/VFX.js:1197–1210`, `src/systems/Audio.js:100` + `594–608`, `src/ui/HUD.js:146–150`.

The round-1 fix deliberately keeps emitting `playerHurt` when a shield eats the whole hit, and its
comment justifies that by pointing at one consumer:

```js
// Combat.js:461-465
// Emitted even at zero so the HUD still flashes when a shield eats a hit
// — its handler already shakes the bar only when the amount is positive, ...
ctx.events.emit('playerHurt', { amount: dealt, absorbed: incoming - dealt, remaining: target.health });
```

`HUD.js:149` does guard (`if (amount > 0) this.pulse(this.refs.hpBar, 'is-shake')`). The other
three do not:

1. **`Items.js:205`** — `ctx.events.on('playerHurt', () => { this._lastHurt = ctx.time; })`.
   No amount is even destructured. D-bugs #2 named this exact knock-on ("Those items'
   `timeSinceHurt()` window resets on a fully-absorbed hit that dealt zero real damage") and the
   landed fix did not close it.
2. **`VFX.js:1197`** — `sev = clamp(amount / maxHealth, 0.08, 1)` floors at 0.08, then
   unconditionally applies `addShake`, `aberration +=`, `vignetteBoost +=` and
   `_hitstop(HITSTOP.playerHurt, true)`.
3. **`Audio.js:100 → 594`** — `sev = clamp(amount / 40, 0.3, 1.4)` floors at 0.3, plays the full
   player-hurt noise and tone, and **ducks the music bus to 10% for 0.7 s**.

**Reproduced — CONFIRMED**, twice, in two separate sessions. Player at 110/110 health with
`shield = 1000`, `_lastHurt` aged 30 s, then one `applyDamage(player, 50, { source: null,
procCoefficient: 0 })`:

```
health         110    ->  110      (nothing reached health)
shield        1000    ->  950      (the shield ate all of it, correctly)
timeSinceHurt   30 s  ->    0 s    <- Items.js:205
aberration       0    ->  0.00370  <- VFX
vignetteBoost    0    ->  0.18257  <- VFX
shake        0.1750   ->  0.20767  <- VFX
music gain    0.192   ->  0.0641   <- Audio, ducked to a third
damage event  { amount: 0 }        playerHurt event { amount: 0, absorbed: 50 }
```

An earlier run with a 40-damage hit and `shield = 500` gave the same `timeSinceHurt` result:
`tsBefore: 60 -> tsAfter: 0`, health 110 → 110, shield 500 → 460.

### The gameplay consequence, named

- **Field Dressing** (`items.js:578–587`) — *"After 5s without taking damage, gain a 12-point
  barrier every second"*, gated on `api.items.timeSinceHurt() < 5`. Its own barrier absorbing chip
  damage resets the clock that generates the barrier. The item cannot recharge while it is working.
- **Siege Battery** (`items.js:1205–1218`) — *"Every second without taking damage banks +6% damage,
  up to 10 charges. **Losing health spends them all.**"* The same fix correctly gated its
  `onDamaged` hook (`Combat.js:470` `if (ctx.items && dealt > 0)`), so an absorbed hit no longer
  spends the stacks — but `timeSinceHurt()` at `items.js:1212` is still reset by that hit, so the
  item stops *banking*. Two halves of one item now disagree about what "taking damage" means: the
  half the fix touched is right, the half it did not is wrong.
- Every absorbed hit costs the player a hitstop, a screen shake, a chromatic-aberration bump, a
  vignette flash, a full hurt sting and a 0.7 s music duck, for zero health lost. Under a barrier
  taking sustained chip damage that is a continuous stutter.

### Minimal fix

Guard the three consumers on the payload the fix already provides, rather than re-litigating the
emit:

```js
// Items.js:205
ctx.events.on('playerHurt', (e) => { if ((e?.amount ?? 0) > 0) this._lastHurt = ctx.time; });
// VFX.js:1197 — early-return, or scale the whole block by `amount > 0`
// Audio.js:100  — this.playerHurt(p?.amount ?? 0) only when it is > 0; the shield tick
//                 already has `shieldBroken` as its own channel (Combat.js:445).
```

---

## 3. MAJOR — every co-op join/leave still leaks two live scene-graph roots and 122 nodes; `Player.dispose()` does not release what its own comment says it releases

**Files:** `src/entities/Player.js:919–925` (`dispose`), `src/net/Coop.js:65`,
`src/entities/Projectile.js:33–35` + `265–267`, `src/entities/Placeables.js:84–85` + `418–420`.

Round 1's finding #3 (the leaked `stageStart` listener) is **fixed** — verified, see "clean" below.
The fix's doc comment goes further than the fix does:

```js
/**  Player.js:896-912
 * ... until now "dropped" meant removed from a list and detached from the scene,
 * which left its `stageStart` subscription live on the bus. A bus entry is a
 * strong reference, so the Player, its rig, **its projectile pool and its
 * placeable pool** all stayed resident for the session, once per join.
 */
dispose() {
  this._offStageStart?.();
  this._offStageStart = null;
  this.placeables?.clear?.();     // 922
  this.projectiles?.clear?.();    // 923
  this.group?.removeFromParent?.();
  this.alive = false;
}
```

`clear()` on both pools only deactivates live entries — it does not detach the pool root from the
scene and does not dispose anything:

```js
// Projectile.js:265   clear() { for (const p of this.items) if (p.alive) this._release(p); }
// Placeables.js:418   clear() { for (const p of this.items) if (p.alive) this._release(p); }
```

Both constructors do `ctx.scene.add(this.root)` (`Projectile.js:35`, `Placeables.js:85`), and each
root is populated with its full capacity at construction (96 projectile meshes, 24 placeable
groups). Each also builds its **own** geometry and material instances — `ProjectilePool` a
`ConeGeometry`, an `IcosahedronGeometry` and a per-colour material map; `PlaceablePool` five
materials. `dispose()` frees none of it and `Player.dispose` is the only teardown path.

**Reproduced — CONFIRMED.** Four `ctx.coop._spawnPawn(id)` / `ctx.coop._despawnPawn(pawn)` cycles
in one session (the same two calls `NetHost` drives on peer connect/disconnect):

```
                      before      after 4 cycles     per cycle
scene.children            25              33            +2
scene.traverse nodes     399             887          +122       (96 + 24 + the 2 roots)
event-bus listeners       74              74             0        <- round 1's leak is fixed
combat.entities            1               1             0        <- unregister works

per despawned pawn:  group.parent = null              (detached, correct)
                     projectiles.root.parent === ctx.scene = true   (leaked, 96 children)
                     placeables.root.parent  === ctx.scene = true   (leaked, 24 children)
```

A second session measured the same figures at 5 cycles (`sceneChildren 25 -> 35`).

Impact scales with churn exactly as round 1 described: a host with players reconnecting over a
flaky link permanently adds 122 scene-graph nodes per cycle that three.js walks in
`updateMatrixWorld` and `projectObject` every frame, plus one never-freed geometry/material set,
for the life of the tab. `coop.pawns.length` still reads 0, which is what makes it invisible.

### Minimal fix

```js
dispose() {
  this._offStageStart?.();
  this._offStageStart = null;
  this.placeables?.clear?.();
  this.projectiles?.clear?.();
  this.placeables?.root?.removeFromParent?.();
  this.projectiles?.root?.removeFromParent?.();
  this.group?.removeFromParent?.();
  this.alive = false;
}
```

Detaching the roots is enough to stop the per-frame cost and to let the whole subtree be collected.
Disposing the pools' geometries/materials as well is safe here and is *not* subject to the sharing
concern the comment raises — see finding 5.

---

## 4. MINOR — the music engine has two one-way latches and no way back; a co-op teammate's death permanently silences the local player's soundtrack

**Files:** `src/systems/Audio.js:615–620`, `src/systems/Music.js:647–655`,
`src/systems/Combat.js:503–505`.

`Audio.playerDead()` sets `this._musicOff = true` (pre-existing on master) **and now also** calls
`this.musicEngine.stop(t)`, which sets `MusicEngine.stopped = true`. `MusicEngine.update` returns
immediately while `stopped`, and nothing anywhere resets either flag or constructs a second
`MusicEngine` — `grep -rn "_musicOff|musicEngine" src/` finds no writer other than these.

**Reproduced — CONFIRMED** that the latch is one-way:

```
before:  musicEngine.stopped = false,  _musicOff = undefined,  stepsEmitted = 11
emit 'playerDead'  ->  stopped = true,  _musicOff = true
emit 'stageStart'  ->  stopped = true,  _musicOff = true,  music bus gain 0.184 and falling
```

In single-player this is bounded: the only restart path is `location.reload()`
(`Menus.js:1028, 1032`), which rebuilds `Audio`. **It is not bounded in co-op.** `Combat._kill`
emits a bare `ctx.events.emit('playerDead', {})` for *any* entity with `isPlayer`
(`Combat.js:503`), and `Coop._spawnPawn` registers every remote pawn with Combat, so a teammate
dying silences the surviving player's music for the rest of the session while the run continues.

Filed as MINOR and marked carefully: the un-targeted `playerDead` emit and the `_musicOff` latch
both exist on `master` (`Progression.js` is untouched by this branch), so the *class* is
inherited. What this round added is a **second** one-way latch on top of it, so a fix to
`_musicOff` alone would no longer restore the soundtrack. Flagged per the brief's "report if this
round made an inherited problem worse".

**Minimal fix:** give `MusicEngine` a `resume()` that clears `stopped` and re-seats
`_musicTime = ac.currentTime + 0.15`, and clear `_musicOff` from the `stageStart` handler that
already calls `musicEngine.cool()` (`Audio.js:105–110`). Targeting `playerDead` at the local
player is a separate, larger, inherited fix and is not proposed here.

---

## 5. MINOR — `Player.setSurvivor` leaks ~53 GPU geometries per swap, on a rationale that is not true

**File:** `src/entities/Player.js:296–304`; comment claim cross-checked against
`src/entities/CharacterMesh.js:431, 522`.

```js
// Player.js:296-300
// Rebuild the rig. The old one is dropped rather than disposed: a swap
// happens between runs, at most a handful of times a session ...
ctx.scene.remove(this.group);
this.mesh = new CharacterMesh(card.meshKey);
```

**Measured — CONFIRMED.** Three full passes through the five-survivor roster
(`ctx.setSurvivor(id)` for each, 15 swaps):

```
renderer.info.memory.geometries:  462 -> 728 -> 994 -> 1260     (+266 per pass, ~53 per swap)
scene.children:                    46 ->  46 ->  46 ->   46     (the group is detached, correctly)
```

Severity is MINOR rather than MAJOR because the shipping path calls `setSurvivor` **once per page
session**, from `Menus.launch()` (`Menus.js:1061`), and restart is a reload. The survivor-select
screen and the logbook's survivor tab both build their own preview rigs and release them properly
(`Logbook.js:812` passes `disposeTree` as the release). This is reachable at scale only from the
harness (`__HARNESS__.survivors()` / `survivorSelect()`).

**The stated reason not to dispose is however factually wrong, and it is quoted again in
`Player.dispose()`'s comment** (`Player.js:905–909`: *"The character rigs share material instances
(see `makeCharacterMats`), so disposing a departing pawn's would blank the rig of anyone still
wearing the same survivor"*). `makeCharacterMats` is called per-instance from the `CharacterMesh`
constructor (`CharacterMesh.js:522` — `this.mats = makeCharacterMats(PALETTES[this.key])`) and
builds a fresh set every time; every geometry in the file is likewise a `new THREE.*Geometry` inside
the per-instance build. Nothing is shared. That matters because it is the reason given for *not*
freeing anything in finding 3.

---

## Observed but not confirmed (informational)

- **`Items.give()` silently no-ops for 11 of the 108 items when a maximal inventory is already
  held** — `syringe`, `steak`, `armor-plate`, `crowbar`, `glasses`, `monster-tooth`, `ukulele`,
  `atg`, `harvesters-scythe`, `behemoth`, `clover`. Measured: giving all 108 ids in array order to
  one inventory yields 97 non-zero counts and 97 `itemPickup` discoveries. The most likely cause is
  the Blight corruption tier converting them on arrival, which would make this correct behaviour
  under an artificial condition no run reaches. I did not isolate it and am **not** filing it. It
  does mean `__HARNESS__.runSummary`'s haul is 11 items short of what it looks like.
- **`Music.js:550` and `:634` use `Math.random()`** for the riser start offset and the noise read
  offset. It is not on `ctx.rng`/`ctx.fxRng`, so it cannot displace the shared streams the
  HANDOFF's standing hazard is about, and audio is not captured — but it does make the soundtrack
  non-reproducible in a build whose every other subsystem is seed-deterministic.
- **`.screen--death`'s bounding box extends 16 px below the viewport at 1600×900**
  (`screenRect.bottom 916` against `innerHeight 900`), while `screenOverflows` reads false and the
  nav is fully visible. Probably a transition transform sampled mid-animation. **Inconclusive** —
  not cited as evidence either way.
- **`EventBus.emit` (`Engine.js:239–243`) has no per-listener try/catch.** A listener that throws
  aborts the emit for every listener registered after it. Nothing currently throws (zero console
  errors across four probe sessions and a full capture), so this is a latent hazard, not a defect.
  It is worth knowing that `stageStart` now carries 11 subscribers, several of them new this round.

### Refuted by probing — reported so nobody re-runs them

- **"Cinder's Pyre Flask never places its pyre."** Probe 2 showed `_clouds.length === 0` after
  firing. Probe 3 verified the simulation was actually stepping first (a control `player.schedule`
  fired, `pendingSched` drained to 0) and then reproduced the ability cleanly: cloud present at
  frame 70, `{ radius: 6, remaining: 7.88, dps: 0.9 }`. Probe 2's reading was a probe artifact.
  **Not a bug.**
- **"Closing the logbook disposes materials shared with the live player rig."** `Logbook.js:812`
  passes `disposeTree` as the release for a survivor entry, which disposes geometries *and*
  materials. Refuted by reading `CharacterMesh.js:522` — every rig owns its own set (see finding 5).
  **Not a bug**, though it is the mirror image of the wrong comment in finding 5.

---

## Areas checked that came back clean

- **Build.** `node node_modules/vite/bin/vite.js build`, exit 0.
- **Full 21-shot capture** (`reviews/round7/r2-bugs/capture/manifest.json`): `ready: true`,
  `clockPinned: true`, `frameDt 0.016666`, `frameTimeouts: 0`. **Zero console errors and zero page
  errors on every shot.** One failing check, `06-loaded-hud` / `monsters under load`, object 6 at
  `px: 137, sepP50: 0.17` — **byte-identical to the failure `E-framing.md` §5 records and declines
  to fix.** This round did not make it worse. `09-survivors` returns
  `perPx [1229, 1685, 1391, 1355, 1340]`, reproducing `E-after` exactly, so the suite is still
  deterministic at seed 1337 and E's framing work holds.
- **D-bugs #1 (missing `lerp` import).** Fixed and gone; `Music.js:1` imports `{ clamp, lerp }`.
  No `ReferenceError` in any session.
- **D-bugs #3 (`stageStart` listener leak).** Fixed. Five co-op join/leave cycles:
  `'stageStart'` listener count 11 → 11, total bus listeners 74 → 74. `Player._offStageStart` is
  captured and called. (The object-lifetime half of the same finding is **not** fixed — finding 3.)
- **D-bugs' informational `Profile.discover` crash.** Not reproducible on current source.
  `discover` guards `const m = this.data.encounters[kind]; if (!m) return false;`
  (`Profile.js:663–664`) and `freshProfile()` always populates `encounters`. Zero errors across
  three sessions that each drove `beginRun`/`commitRun` repeatedly.
- **Listener growth across stage transitions.** Ten consecutive `stageStart` emits: bus total
  74 → 74, no key changed.
- **Real stage transitions ×4** (`ctx.progression.advanceStage()` + 30 frames each): bus listeners
  flat at 74, `scene.children` flat at 33, `combat.entities` back to 1, `combat.statuses` 0,
  `director.enemies` 0 after every transition. `Items._clouds` is cleared on `stageStart`
  (`Items.js:182`). The +3 DOM nodes per stage are the HUD's own stage toast, which expires.
- **Repeated run cycles in one page session ×3** (`stageStart` ×2 → kills → damage → `commitRun`):
  the run report diffs correctly against the `beginRun` snapshot every time. Cycle 2's `advanced`
  reads `oneShot 600 -> 700`, `veteran 2 -> 3`, `eliteHunter 2 -> 3`; `records` correctly reports
  `highestHit 700 (was 600)`. `_earnedThisRun` / `_completedThisRun` reset at `beginRun`, so no run
  inherits the previous run's ribbon. Lifetime stats accumulate correctly (runs 1→2→3,
  damageDealt 500→1100→1800). No contamination found — this was round 1's own bug class and it is
  clean here.
- **A maximal run report cannot strand the player** (the claim of commit `75f87d6`). Rendered the
  death screen with 7 unlocks + 14 completions + 3 advanced + 4 records + a 60-item strip at
  1600×900, 1366×768, 1280×720 and 1024×640. At all four: `run-report` scrolls
  (`scrollHeight > clientHeight`), the nav row and the Restart button are fully inside the
  viewport, `screen.scrollHeight <= innerHeight`. Verified rather than assumed.
- **CINDER end to end.** `ctx.setSurvivor('cinder')` resolves all four slots
  (`cinderStoke`/`cinderPyreFlask`/`cinderBackdraft`/`cinderConflagration`); all four fire with no
  throw; Pyre Flask's scheduled pyre lands (`radius 6, remaining 7.88`); a stage transition with a
  schedule pending produces no cloud on the new stage and no error.
- **The three new enemies.** `shriver`, `lasher`, `redoubt` all spawn via
  `director.spawnOne`, register with Combat (entities 1 → 10), and are torn down by the next
  `stageStart` (entities back to 1, enemies 0). No console errors.
- **All 108 items held at once, ×3 stacks, through a 12-enemy fight** (240 frames): zero console
  errors, zero page errors.
- **Logbook open/close ×5, cycling all five tabs each time**: `scene.children`, `sceneNodes`,
  `geometries`, `textures`, `programs`, bus listeners and DOM node count are all *identical* across
  all five cycles. `ModelPreview.dispose()` (`Logbook.js:198–214`) does call `forceContextLoss()`.
  Whether a second WebGL context is actually created under SwiftShader is **inconclusive** — that
  specific question was not settled and is flagged rather than claimed clean.
- **Profile persistence, migration and the unlock layer.** `MIGRATIONS` chain is guarded
  (`guard < 64`, missing step warns and normalises); `_coerce` type-checks every field;
  `goalOf` floors at 1 so no dynamic goal can complete a challenge instantly. Catalogue sizes
  resolve correctly (`survivor 5, item 108, equipment 14, enemy 19, boss 6`); `SPAWN_CARDS` and
  `BOSS_CARDS` have **no id overlap** and **no zero-weight cards**, so `fieldGuide` and
  `apexSurvey` are both reachable. A maximal forced run completed 10 challenges and granted
  `artifact:caprice` and `artifact:glass` through `_evaluate → unlock`, and the profile flushed to
  `localStorage` (8109 bytes, 1 run). No instant-completes, no double-grants.
- **RNG stream discipline in the new content** (`HANDOFF.md`'s standing hazard): the only draws in
  `items.js`, `equipment.js`, `enemies.js` and `abilities.js` are `abilities.js:60–61` (`ctx.rng`,
  inside an authority-gated caller) and `abilities.js:261` (`ctx.fxRng ?? Math.random`, cosmetic).
  Nothing new sits on the shared gameplay stream.
- **`applyDamage`'s changed return value.** Grepped every call site; nothing in `src/` consumes the
  return of `applyDamage`, so the return-value half of finding 1 has no live consumer today.

---

## Summary

| # | Severity | File | Status |
|---|---|---|---|
| 1 | **Critical** | `src/systems/Combat.js:440–458` (+ `Director.js:171`, `VFX.js:2396`, `HUD.js:158`, `Progression.js:145`, `Profile.js:1049`, `items.js:310/747/1111`) | Confirmed — reproduced. **Regression introduced by `4a1a098`.** |
| 2 | Major | `src/systems/Combat.js:466` / `Items.js:205`, `VFX.js:1197`, `Audio.js:100` | Confirmed — reproduced twice. Incomplete fix of D-bugs #2. |
| 3 | Major | `src/entities/Player.js:919–925` / `Coop.js:65` | Confirmed — reproduced twice. Incomplete fix of D-bugs #3. |
| 4 | Minor | `src/systems/Audio.js:615–620` / `src/systems/Music.js:647` | Confirmed one-way latch; co-op impact reasoned. Inherited class, made worse this round. |
| 5 | Minor | `src/entities/Player.js:296–304` (+ wrong comment at `:905–909`) | Confirmed — measured. Pre-existing; low reachability. |

Build: **pass**. Capture: **21/21 shots, 1 failing check (`06-loaded-hud`, pre-existing and
unchanged), 0 console errors, 0 page errors.** No repo test runner exists.

Findings 1–3 all live in the same seam: `Combat.applyDamage`'s event payloads. Round 1 correctly
identified that the payload lied about the *player's* shield and fixed it by redefining one
variable; the redefinition then propagated to every *enemy* consumer of the same field, and the
half of round 1's own finding that lived outside `Combat.js` was never closed. Fixing 1 and 2
together is a single, small change to what `Combat.js:456–472` puts on the bus, plus three one-line
guards in the consumers.
