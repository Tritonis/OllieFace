# Round 7 bug hunt — D

Branch `round7/content-and-polish`. Read-only hunt; nothing in the repo was modified.
Two throwaway Playwright scripts (`tools/_verify_coop_leak.mjs`, `tools/_verify_shield_event.mjs`)
were written to prove findings #2 and #3 against the live game and have been deleted.

Method: read `src/systems/Combat.js`, `src/systems/Items.js`, `src/systems/Director.js`,
`src/core/Engine.js`, `src/entities/Player.js`, `src/entities/Enemy.js`, all of `src/net/*`,
`src/world/Interactables.js`, `src/fx/Decals.js`, `src/systems/VFX.js` (LightPool + damage-number
paths) in full, plus targeted greps for the runtime-light-count, RNG-discipline and
authority-gating bug classes across the rest of `src/`. Two findings were proven against the
running game via `tools/capture.mjs`-style Playwright harness scripts using `?harness=1` and
`globalThis.__GAME__`; the console-error finding (#1) surfaced unprompted in that same session.

---

## 1. CRITICAL — Music never plays: `Audio.js` throws every frame on a missing import

**File:** `src/systems/Audio.js:663`, import list at `src/systems/Audio.js:1-3`

```js
import { clamp } from '../core/MathUtil.js';   // line 2 — lerp is never imported
...
_scheduleMusic() {
  ...
  const bpm = lerp(88, 132, this.intensity);   // line 663 — ReferenceError: lerp is not defined
```

`_scheduleMusic()` is called unconditionally from `Audio.update(ctx, dt)` (last statement before
the ambient drone-bed gain update). It throws a `ReferenceError` on the very first call and on
every call thereafter. `Engine._call` catches the throw so the frame survives, but it logs the
error only once and the practical effect is:

- The music step sequencer never runs, for the whole session, from frame 1 — **no music plays,
  ever**, in any run.
- Everything in `Audio.update` *after* the `_scheduleMusic()` call also never executes each frame,
  including the ambient drone-bed intensity ramp (`this.droneGain.gain.setTargetAtTime(...)`),
  since the throw aborts the rest of that `update()` invocation.
- 3D listener positioning (which runs *before* the throw) still works, so positional SFX are
  unaffected — only music and the drone bed are silent.

**Reproduced — confirmed.** Loading the game with `?harness=1` and calling
`globalThis.__HARNESS__.gameplay()` immediately logs, every frame:

```
[engine] error in Audio.update (frame 3) — continuing: ReferenceError: lerp is not defined
    at Audio._scheduleMusic (.../src/systems/Audio.js:663:17)
    at Audio.update (.../src/systems/Audio.js:789:10)
```

Independently confirmed by reading the file: it imports only `{ clamp }` from `MathUtil.js` (line
2) but calls `lerp(...)` at line 663. `MathUtil.js` does export a `lerp` function (used correctly
by `Director.js`, `Player.js`, etc.) — it's just not imported here.

**Note:** `src/systems/Audio.js` is on the list of files another agent is editing concurrently
this round. Reported anyway per the brief, since it's a directly observed, currently-reproducing
defect with a one-line root cause, not a speculative one. Worth flagging even if it's already
mid-fix elsewhere.

**Minimal fix:** `import { clamp, lerp } from '../core/MathUtil.js';`

---

## 2. MAJOR — Shield-absorbed hits still fire full-damage events: false gold, false damage numbers, false "time since hurt" resets

**File:** `src/systems/Combat.js:369-467` (`applyDamage`), specifically lines 428-450

```js
let dealt = amount;                                   // 428 — the PRE-shield amount
if (target.shield > 0) {
  const absorbed = Math.min(target.shield, amount);
  target.shield -= absorbed;
  amount -= absorbed;                                 // amount now reflects what actually landed
  if (target.isPlayer) ctx.events.emit('shieldBroken', { remaining: target.shield });
}
...
if (amount > 0) {                                      // 438 — only mutates health if amount > 0
  if (target.takeDamage) target.takeDamage(amount, info);
  else target.health -= amount;
}

ctx.events.emit('damage', {
  target, source, amount: dealt, crit, position: pos, proc: info.procCoefficient || 0,  // 444 — dealt, not amount
});

if (target.isPlayer) {
  ctx.events.emit('playerHurt', { amount: dealt, remaining: target.health });           // 448 — dealt again
  if (ctx.items) this._dispatch('onDamaged', { target, source, amount: dealt, ... });    // 449 — dealt again
}
```

`dealt` is captured *before* the shield absorbs any of it and is never adjusted afterward. When a
hit is fully (or partially) absorbed by shield, `amount` (the real health loss) drops to 0 (or a
fraction), but every downstream event — `damage`, `playerHurt`, and the `onDamaged` proc hook —
still reports the full pre-absorption `dealt` value, as if it had actually landed on health.

Concrete failure path, fully reproduced against the running game:

1. Give the player **Bruised Coinpurse** (`roll-of-pennies` — "Gain 2 gold whenever you are hurt",
   hooked on `onDamaged`).
2. Set `player.shield = 100` (any barrier/shield source — Items' own `addBarrier`, an equipment
   like a barrier item, etc. — reaches the same code path).
3. Call `ctx.combat.applyDamage(player, 10, { source: null, procCoefficient: 0 })` — a hit fully
   inside the shield.

Result:
```json
{
  "healthBefore": 110, "healthAfter": 110,     // zero real damage — shield ate all of it
  "shieldAfter": 90,                            // shield correctly debited
  "goldBefore": 0, "goldAfter": 2,              // Bruised Coinpurse paid out anyway
  "dmgEventAmount": 10, "hurtEventAmount": 10   // both events report the full pre-shield hit
}
```

Health didn't move at all, yet the player was paid gold for taking damage they didn't take, and
both the `damage` and `playerHurt` events lied about what happened.

Knock-on effects beyond the reproduced gold case, from reading the rest of `Items.js`:
- `Items.init` listens on `playerHurt` purely to stamp `this._lastHurt = ctx.time` (line ~205 —
  "How long since I was last hit… backs three items (Field Dressing, Siege Battery, Mineral
  Lick)"). Those items' `timeSinceHurt()` window resets on a fully-absorbed hit that dealt zero
  real damage, denying their payoff even though the player was untouched.
- Any other `onDamaged` hook (current or future) fires with an inflated `amount` on a shield tick,
  and VFX's damage-number popup (which reads the `damage` event) shows a number that doesn't match
  the health bar, which reads as "my shield didn't work" even though it did.

**Reproduced — confirmed**, via the numbers above.

**Minimal fix:** compute `dealt` as what actually reached health (i.e. after the shield
subtraction — `dealt = amount` read *after* the shield block, or an explicit `const dealt = amount
- healthAmount` split), and keep the shield-absorbed portion out of `damage`/`playerHurt`/
`onDamaged`. If a "shield took a hit" signal is wanted for VFX, that's what the existing
`shieldBroken` event is already for — it doesn't need to be smuggled through `damage`.

---

## 3. MAJOR — Every co-op join/leave cycle leaks a `stageStart` listener and its `Player`

**Files:** `src/entities/Player.js:198` (the leaked registration), `src/net/Coop.js:39-66`
(`_spawnPawn` / `_despawnPawn`, which never cleans it up)

```js
// Player.js:198, inside init(ctx) — runs for every Player, local AND remote:
ctx.events?.on?.('stageStart', () => this.placeables.clear());
```

```js
// Coop.js — _spawnPawn creates a new Player and calls pawn.init(ctx) (line 46),
// which registers the listener above. _despawnPawn:
_despawnPawn(pawn) {
  const i = this.pawns.indexOf(pawn);
  if (i >= 0) this.pawns.splice(i, 1);
  this.ctx.combat?.unregister?.(pawn);
  pawn.group?.removeFromParent();
  // no ctx.events.off(...) anywhere — the closure above is never removed
}
```

`Player.init()` unconditionally subscribes an inline closure to the shared `ctx.events` bus. For
the local player this is a one-time, session-lifetime cost. For a **remote** co-op pawn
(`Coop._spawnPawn`, used every time `NetHost` gets a new peer), the same subscription happens, but
nothing in `Coop._despawnPawn` — which runs on every peer disconnect — ever calls the unsubscribe
function `events.on()` returns. Each join/leave cycle (a reconnect after a dropped connection, a
player leaving and being replaced, etc.) permanently leaks:

- one closure in the `EventBus`'s `Map<string, Set<fn>>` for `'stageStart'`, which keeps firing
  `placeables.clear()` on a detached, otherwise-dead `Player` object forever, and
- the `Player` object itself (with its `CharacterMesh`, `ProjectilePool`, `PlaceablePool`, and
  fixed-size scratch arrays) — it can never be garbage-collected because the `EventBus` still holds
  a live reference to it via the closure.

**Reproduced — confirmed.** Calling `ctx.coop._spawnPawn(id)` immediately followed by
`ctx.coop._despawnPawn(pawn)` five times in a row against the live game (bypassing only the
WebRTC transport layer, which `NetHost`/`NetClient` normally drive these same two calls through):

```json
{ "before": 11, "after": 16, "delta": 5, "expectedIfLeaking": 5, "pawnsArrayLenAfter": 0 }
```

`coop.pawns.length` correctly returns to 0 (the bookkeeping *looks* clean), but the listener count
on `'stageStart'` grew by exactly one per cycle — a clean, deterministic leak, not noise.

Impact is proportional to churn: a long-running host session with players reconnecting over a
flaky connection, or players cycling through a lobby, accumulates one zombie `Player` + one zombie
listener per cycle, for the life of the host process/tab.

**Minimal fix:** capture the unsubscribe function `Player.init()` already has available
(`ctx.events.on(...)` returns one — see `EventBus.on` in `Engine.js`) and call it from
`Player`'s own teardown, or have `Coop._despawnPawn` call it directly. Since only remote pawns are
ever despawned mid-session, the simplest fix is probably to store the returned unsubscribe on the
pawn (e.g. `this._offStageStart = ctx.events.on(...)`) and call `pawn._offStageStart?.()` from
`Coop._despawnPawn`.

---

## Also observed, not confirmed against current source (informational only)

While capturing the console output for finding #1, the same session also logged one instance of:

```
[engine] error in Progression.fixedUpdate (frame 3) — continuing: TypeError: Cannot read
properties of undefined (reading 'survivor')
    at Profile.discover (.../src/systems/Profile.js:543:35)
    at Profile.beginRun (.../src/systems/Profile.js:603:35)
    at Profile._onStageStart (.../src/systems/Profile.js:680:10)
```

`src/systems/Profile.js` is on the list of files another agent is actively editing this round, and
by the time I read the file moments later (to pin down the exact line), the code around
`discover`/`beginRun` no longer matched the stack trace's line numbers or an obvious cause — the
file had already changed under me. I can't respec this against current source with confidence, so
I'm not filing it as a numbered finding; flagging only so it isn't lost if it turns out to still be
live once that file's edits settle.

---

## Areas checked that came back clean

- **Runtime light-count / shader-permutation freezes** (the `PointLight` class of bug): grepped
  every `new THREE.PointLight/SpotLight/DirectionalLight` in `src/`. `VFX.js`'s `LightPool`
  (`src/systems/VFX.js:1669-1709`) and `Environment.js`'s three directional lights are the only
  ones, both created once at boot and never added/removed/hidden afterward — exactly the pattern
  the codebase's own `Prewarm.js` and `Interactables.js` comments prescribe. `ItemOrb` and the
  teleporter beacon deliberately use emissive+bloom instead of lights, with comments citing this
  exact bug class by name (`src/world/Interactables.js:1468-1478`) — already fixed here, not a
  live bug.
- **Aim convergence** (`stage.raycast`-only aim, from the brief's own example): already fixed —
  `Player.aimRay()` (`src/entities/Player.js:871-888`) resolves against both `stage.raycast` and
  `Combat.probeDistance` (added specifically for this, per its doc comment at
  `src/systems/Combat.js:280-291`) and takes whichever is nearer.
- **`ctx.authority` gating**: `Combat.applyDamage`, `Items.give/take/rollItem/rollTier/roll/
  useEquipment/setEquipment`, `Director.fixedUpdate/spawnBoss/summon`, `Interactables.
  requestInteract` all gate correctly. Enemy AI (`Enemy.js`) never runs on a client — clients get a
  separate, non-simulating `EnemyView` (`src/net/NetViews.js`) — so the many un-gated `ctx.rng`
  calls inside `Enemy.js`'s state table are safe by construction.
- **`ctx.rng` stream discipline**: spot-checked `Director.js`, `Items.js`, `Interactables.js`'s
  shrines (`ringPoint`, `summonRing`, `GildedSnare.interact`), `TrialController`/`VaultController`
  in `Realms.js`. Every draw is behind an `authority` check, either directly or transitively (e.g.
  `GildedSnare.interact`'s `ctx.rng.pick(affixes)` is unreachable on a client because the
  `rollItem` call two lines above it already returns `null` under `!ctx.authority` and the function
  returns early). Cosmetic-only randomness (orb toss velocity, decal variant/rotation) correctly
  uses `ctx.fxRng`/`ctx.fxRng ?? ctx.rng`, not `ctx.rng`.
- **Resource leaks / pooling**: `EnemyMeshes.js`'s `acquireRig`/`releaseRig` pool correctly removes
  the rig from the scene graph before pooling it; `NetViews.EnemyView.dispose()` routes through it
  correctly. `Decals.js` is a fixed-capacity GPU ring buffer with no allocation per placement.
  `Director.js`'s `Projectiles`/`Waves`/`Telegraphs`/`Trails` sub-pools all recycle correctly on
  both the despawn and the `clear()` paths. Did not find another per-instance `ctx.events.on(...)`
  registration without a matching teardown outside of finding #3 above (checked
  `Placeables.js`, `Projectile.js`, `abilities.js`, `Artifacts.js`, `Realms.js` and its
  controllers).
- **Off-by-one / boundary**: `Combat`'s spatial hash, hit pool (`HIT_POOL`/`OVERLAP_POOL`) and
  pierce-budget truncation; `Snapshot.js`'s interpolation pair-finding and `MAX_SNAPSHOTS` ring;
  `Protocol.js`'s position/angle quantisation. Nothing found.
- **Event-ordering**: `Engine.js`'s system update order (`fixedUpdate` → `update` → `lateUpdate`
  across all systems) and `NetHost`'s "apply remote input before the sim step, snapshot after" — as
  documented, and correct on inspection.
- **UI/CSS `[hidden]`-class bugs**: not reached in depth this round — deprioritised in favour of
  the gameplay/net/combat surfaces the brief weighted highest. Flagging as unexamined rather than
  clean.

---

## Summary

| # | Severity | File | Status |
|---|---|---|---|
| 1 | Critical | `src/systems/Audio.js:663` | Confirmed — reproduced |
| 2 | Major | `src/systems/Combat.js:428-450` | Confirmed — reproduced |
| 3 | Major | `src/entities/Player.js:198` / `src/net/Coop.js:61-66` | Confirmed — reproduced |

All three were reproduced against the live game via a Playwright harness session
(`?harness=1`, `globalThis.__GAME__`/`__HARNESS__`), not reasoned about in the abstract. No product
code was modified; the two throwaway verification scripts used to prove #2 and #3 have been
deleted.
