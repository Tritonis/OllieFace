# A1 — Survivor roster (round 5)

One hardcoded loadout → a roster of four mechanically and visually distinct survivors,
16 abilities, four separately sculpted rigs, and a persistent-deployable entity pool.

---

## 1. What shipped

### `src/data/survivors.js` (new)

Survivor cards. Shape as specified, plus one addition (`trailColor`) noted below.

```js
{ id, name, subtitle, lore, baseStats, abilities: {primary, secondary, utility, special},
  meshKey, unlock, accentColor, trailColor }
```

`baseStats` is exactly the CONTRACTS.md "Stat pipeline" base block —
`{ maxHealth, healthRegen, moveSpeed, attackSpeed, damage, critChance, critMult, armor,
cooldownMult, jumpCount }` — and nothing else. It is handed straight to
`ctx.items.stats()` after Player raises it by level, so every item stacks onto every
survivor with no per-survivor code anywhere.

`trailColor` was added because the Ranger's dash ribbon has always been cold cyan
against his warm kit and hardcoding that in `Player` would have made it wrong for the
other three. It defaults to `accentColor` if a card omits it.

The roster:

| id | name | archetype | hp | dmg | speed | armor | jumps | crit | accent |
|---|---|---|---|---|---|---|---|---|---|
| `ranger` | RANGER | all-rounder (unchanged) | 110 | 12 | 7.0 | 0 | 1 | 1% | `0xff7a3d` |
| `anvil` | ANVIL | close-range bruiser | 170 | 15 | 6.5 | 8 | 1 | 1% | `0xff5a2a` |
| `kestrel` | KESTREL | ranged precision/burst | 90 | 17 | 7.4 | 0 | 2 | 5% | `0xc9a4ff` |
| `rook` | ROOK | engineer / summoner | 135 | 11 | 6.3 | 4 | 1 | 1% | `0x9dff5a` |

**Naming note:** the bruiser was originally `warden`. Agent A3 shipped an enemy called
**Aegis Warden** in `data/enemies.js` during this wave, so it was renamed to `ANVIL`
throughout (id, mesh key, palette key, all four ability ids) to avoid a roster/bestiary
name collision. The rename is complete — `grep -rn warden src/data/survivors.js
src/data/abilities.js src/entities/` returns only A3's enemy.

### `src/data/abilities.js` — 12 new abilities (16 total)

Restructured from slot-keyed to **id-keyed**, since four survivors can no longer share
one `ABILITIES.primary`. The Ranger's four are byte-identical in behaviour; only their
keys changed (`primary` → `rangerDoubleTap`, etc.) and each gained an `id` field.

Same shape as before: data + `fire(ctx, player)`, cooldown in seconds pre-`cooldownMult`,
damage as coefficients of `stats.damage`, `scalesWithAttackSpeed` on primaries only.

| survivor | slot | ability | cd | coefficient | mechanic |
|---|---|---|---|---|---|
| anvil | M1 | Riving Sweep | 0.44 | 210% | 132° melee cone, alternating handedness |
| anvil | M2 | Seismic Slam | 4.5 | 480% + slow | 7 m ground slam; airborne it lands when *you* do |
| anvil | Q | Breach Charge | 5.0 | 260% | **gap-closer**: aim-directed 30 m/s charge, damages everything run through, one hit per body |
| anvil | R | Bulwark | 12.0 | — | **defensive cooldown**: 45% max-hp barrier + 25 armor for 6 s |
| kestrel | M1 | Mark | 0.62 | 250% | precision hitscan, pierces 1, 4× moving-spread penalty |
| kestrel | M2 | Focus Lance | 6.0 | 700% | **0.5 s charge-up**, aimed at *release*, pierces all |
| kestrel | Q | Vault | 4.0 | — | **reposition**: back-and-up kick, refreshes air jumps, 0.2 s i-frames |
| kestrel | R | Eclipse Round | 11.0 | 1100% + 400% | 0.35 s windup, pierces all, detonates r=6 at the terminal point |
| rook | M1 | Rivet Gun | 0.17 | 85% | fast stream, proc 0.75 |
| rook | M2 | Scatter Charges | 5.5 ×2 | 320% ea | 3 lobbed **proximity mines** (placeables) |
| rook | Q | Harmonic Ward | 9.0 | 55%/pulse | **ward**: 6 m, 12 s, slows + grinds, mends the owner inside |
| rook | R | Sentry | 14.0 ×2 | 120%/shot | **turret**: 24 s, 34 m range, 2 shots/s |

New helpers alongside the existing `hitscan()`/`fireFlash()`:

- `gatherCone(ctx, origin, dir, range, halfAngle)` — cone overlap against body *centres*,
  with a "already inside the swing" bypass so a body at contact range is still hittable.
- `arcSlash(...)` — the swing drawn as 9 tapered beam segments + a white core pass, not a
  billboard puff.
- `arcRibbon(...)` — a `Trails` ribbon *flown* along the arc over the next 5 fixed steps,
  so the swing has real motion rather than a static crescent.
- `damageGroup(...)` — group damage with the `_overlap`-clobber snapshot discipline
  `Combat.explode` documents.
- `groundAim(ctx, player, maxDist, out)` — aim ray dropped onto the height field, so
  deployables land on a surface and never inside terrain.
- `chargeTell(...)` — beads collapsing onto the muzzle over a windup.

**VFX density.** Every one of the 12 emits at least three layers plus a camera response
plus audio, matching the original four. Nothing uses a single-layer effect. Examples:
Seismic Slam = 3 rings (hot inner, dust outer, debris) + 2 `impact` calls + light flick +
shake 0.16 + camera punch + hitstop + explosion audio. Bulwark = 6 dome ribs as
beam+core pairs + 2 ground rings + `block()` + light flick + two scheduled re-pulses over
the buff duration.

### `src/entities/Placeables.js` (new) — persistent deployables

Fixed-capacity pool (24), same ownership model as `ProjectilePool`: allocated up front,
stepped from `Player.fixedUpdate` (gameplay) and `Player.update` (presentation).
Kinds: `mine` (ballistic settle → arm → proximity detonate → detonates on expiry too),
`ward` (pulsing damage + `slow` + owner regen, breathing additive dome), `turret`
(reacquires nearest hostile, traverses, hitscans with tracer + muzzle flash).

Each is a tracked entity record with id-equivalent identity, position, lifetime, damage,
owner and a procedural rig. **They are deliberately not registered with `ctx.combat`** —
see the deferred-work section for why and what that costs.

All damage flows through `ctx.combat.applyDamage` / `hitscan` / `explode`, which
host-gate internally. Nothing in the pool gates on `ctx.authority` itself, matching how
projectiles already work: a client's local copy renders and resolves nothing.

### `src/entities/CharacterMesh.js` — four rigs

- `PALETTES` — four full palettes, each keeping the Ranger's *value structure*
  (near-black shell / one light plate / one mid / one saturated accent) but its own hue,
  plus per-palette overrides for the four near-blacks the Ranger hardcoded and a
  palette-scoped fresnel rim (`rim`). The Ranger omits every override, so
  `makeCharacterMats()` with no argument returns exactly what it always did — which is
  also what `fx/Prewarm.js` and `net/NetViews.js` keep getting.
- `CLOTH_GAIN` — per-rig gain on the animator's cloth layer, so Anvil's bolted rear
  plates and Rook's equipment rack do not flap like a cape while still going through the
  same code path. Ranger is `{1, 1}`.
- `new CharacterMesh(meshKey = 'ranger')`; unknown keys fall back to the Ranger.
- `build()` dispatches to `buildRanger()` / `buildAnvil()` / `buildKestrel()` /
  `buildRook()`, then a shared `_finish()` (receive-shadow pass + contact decal, now
  scaled per rig by `blobScale`).

The four rigs are written out separately rather than parameterised from one builder.
That is deliberate and commented in the file: a shared builder with four sets of
proportions produces four rigs carrying the *same masses at different sizes*, which is
exactly the axis-4 failure. What separates these at 110 px is where the volume is.

| rig | height | shoulder span | top of silhouette | signature |
|---|---|---|---|---|
| ranger | ~1.9 m | 0.66 | crest + antenna | cape, slung carbine, sidearm |
| anvil | ~1.6 m | 1.05 | flat cowl, no neck | slab pauldron one side, huge gauntlet the other, two raked stacks |
| kestrel | ~2.0 m | 0.40 | pointed hood | 1.1 m rifle, split coat tails, tall back vane |
| rook | ~1.6 m | 0.86 | small dome, no crest | rectangular pack, 2 diagonal exhaust stacks, folded crane arm |

Height ratio ranges 1.6–2.0 m and span 0.40–1.05 m, so the four separate as pure black
shapes on proportion alone before any detail resolves.

### `src/entities/Player.js` — survivor-driven

- `BASE` constant removed; `this.base` comes from the card.
- `_applyCard(card)` — the one place stats, loadout and derived values come from.
- `setSurvivor(id)` — live swap: rebuilds stats, slots, rig, clears deployables/buffs.
- `_effectiveBase()` / `_buffTotals()` / `grantBuff()` — timed stat buffs folded into
  the **base block**, never onto `ctx.items.stats()`'s return value (that is a shared
  cache Items hands back by reference; writing to it would compound the buff every frame
  and never expire). With no buffs live it returns `_levelBase()`'s block untouched, so
  Items' cache stays hot and the common path costs what it did before.
- `grantBarrier()`, `grantIFrames()`, `aimForward(out)`, `wishDirection()`.
- `beginDash(o)` now takes optional `{ direction, speed, time, iframes }`;
  `beginDash()` with no argument is the Ranger's roll, unchanged.
- `_tryFire` replay branch changed from a hardcoded `if (slot === 'utility')
  this.beginDash()` to `s.ability.replayFire?.(ctx, this)`. Ranger's utility supplies
  `replayFire(){ player.beginDash(); }`, so its replay behaviour is identical.
- `getNetState`/`setNetState` gained `dashSpeed` and `dashMaxTime` — a 30 m/s charge
  rewinds to a very different position than a 22 m/s roll, and only the pawn knows which
  is in flight.
- `placeables` pool created, ticked, cleared on `stageStart`, on death, and on swap.

The kinematic capsule sim, netcode authority gating and level scaling are untouched
except for reading `this.base` instead of the module constant.

### `src/core/Engine.js` — 6 lines appended inside the ctx literal

`survivorId: 'ranger'` plus its comment. A literal rather than an import: the Engine
owns no game content and Player resolves an unknown id back to the default anyway.

### `src/core/Harness.js` — two additions, appended

`survivors()` (the `09-survivors` scenario) and `abilityAudit()` (below).

### `tools/capture.mjs` — one SCENARIOS entry

`09-survivors`, inserted **before** `04-combat` rather than last, because the scenario
removes its display rigs after `freeze()` (see below) and therefore wants the clean
early-run HUD instead of `06-loaded-hud`'s 37-item inventory panel.

---

## 2. API for B3's survivor-select UI

Nothing in `ui/` was touched. This is the whole surface:

```js
import { SURVIVORS, SURVIVOR_BY_ID, DEFAULT_SURVIVOR,
         getSurvivor, loadoutOf, isUnlocked } from '../data/survivors.js';

SURVIVORS            // ordered array of cards — iterate this to build the grid
getSurvivor(id)      // card, never null, falls back to the Ranger
loadoutOf(card)      // the 4 ability objects in slot order — name/key/description/
                     // cooldown/charges, for the skill panel on the select screen
isUnlocked(card, ctx.profile)   // true when B1's Profile is absent, so it is safe now
```

Runtime:

| hook | owner | meaning |
|---|---|---|
| `ctx.survivorId` | Engine (default) / Player | id the next `Player.init` boots; kept current by `setSurvivor` |
| `ctx.setSurvivor(id)` | Player (local only) | live swap. Returns the card. Rebuilds stats, loadout and rig; clears deployables and buffs; refills health |
| `new Player({ survivor: 'kestrel' })` | — | explicit override, beats `ctx.survivorId` |
| `survivorChanged` event | Player | `{ survivor, player }` — **new event, additive to CONTRACTS.md**. HUD should rebuild its skill icons on it; the menu should re-render the card |
| `ctx.player.survivor` / `.survivorId` | Player | the live card |

**Pre-run selection** (what the select screen should do): write `ctx.survivorId` before
the run starts, or call `ctx.setSurvivor(id)` from the menu — either works.
`setSurvivor` is intended for the lobby, not mid-fight; it refills health and resets
cooldowns. That gate is left to the caller deliberately so the harness can photograph
the roster.

**Zero-UI default is preserved**: `engine.add(new Player())` with nothing set boots the
Ranger with identical stats and identical abilities. Verified in `03-thirdperson` below.

`ctx.player.slots` keeps its existing HUD read contract exactly
(`{ slot, ability, name, description, key, charges, maxCharges, cd, cdMax, cooldown }`),
so the current HUD needs no change to keep working.

---

## 3. Verification (real output)

### Build

```
$ npm run build
vite v8.2.0 building client environment for production...
transforming...✓ 80 modules transformed.
rendering chunks...
dist/assets/survivors-CZ2db8bc.js        18.79 kB │ gzip:   6.53 kB
dist/assets/CharacterMesh-XD6HPgeq.js    25.40 kB │ gzip:   8.22 kB
dist/assets/index-Ccm_6eom.js           885.44 kB │ gzip: 274.84 kB
✓ built in 1.10s
```

Clean. (The >500 kB chunk warning is pre-existing and unrelated.)

### All 16 abilities fire, with VFX, without throwing

`__HARNESS__.abilityAudit()` swaps to each survivor, calls every `fire()` and waits
0.9 s of simulation time for scheduled follow-ups, then reports what threw *and* what
the Engine swallowed into `ctx.frameErrors` (a throwing system is degraded, not fatal —
without checking that counter an ability can be completely dead while every screenshot
comes back clean).

```
{
  "results": [ ... 16 entries, every one "ok": true ... ],
  "failed": [],
  "frameErrorsAdded": 0,
  "lastFrameError": null
}

CONSOLE ERRORS: 0
```

Per-ability, all `ok: true`:
`rangerDoubleTap, rangerPhaseRound, rangerTacticalDive, rangerSalvo,
anvilSweep, anvilSlam, anvilBreach, anvilBulwark,
kestrelMark, kestrelLance, kestrelVault, kestrelEclipse,
rookRivet, rookMines, rookWard, rookTurret`

### Capture

```
$ node tools/capture.mjs
[ 0.806s] navigating...
[10.065s] loaded; waiting for stage...
... 16 scenarios ...
{
  "ready": true,
  "shots": ["01-title","02-vista","03-thirdperson","04-combat","05-boss",
            "06-loaded-hud","07-interactables","08-explosion","09-survivors",
            "10-inventory","11-bestiary","12-boss-phases",
            "13-biomes-1","13-biomes-2","13-biomes-3","13-biomes-4"],
  "errorCount": 0,
  "perf": { "programs": 63, "geometries": 568, "textures": 50, "sceneObjects": 374 }
}
```

`shots/manifest.json`: `ready: true`, `partial: false`, top-level `errors: []`, and
**every** shot `frameErrors: 0`, `newErrors: []`, no `error` key. Verified per-shot, not
just in aggregate.

### `09-survivors`

Shot exists and contains its subject. Row on flat sunlit ground, all four at the same
height and the same apparent size, each ~230 px of a 900 px frame, three-quarter view,
clean early-run HUD, terrain and sky behind them for the silhouettes to read against.

The four are distinguishable at a glance in the frame: the tallest is the pointed hood
and the metre of rifle above the head (Kestrel); the widest is the flat-topped
no-neck block with one slab shoulder (Anvil); the boxy one with two diagonal stacks and
a green band (Rook); the caped one with a light helm and orange hem (Ranger).

Three framing bugs were found and fixed by looking at the actual pixels, not by
reasoning about the code:

1. First shot put the lens on a ridge eight metres above the row and photographed a
   top-down of a slope — the camera lift was clamped to `groundY(camera) + 1.5` rather
   than to the *subjects'* plane. Fixed, and the placement search now sweeps bearings as
   well as distances and scores flatness at 20× the weight of anything else.
2. First shot ran after `10-inventory`, so a 37-item inventory panel covered the
   left third. Fixed by moving it early — `freeze()` only clears `Engine.running` and the
   canvas keeps presenting the frame it last drew, so removing the four display rigs
   *after* the freeze takes them out of the world without taking them out of the
   photograph.
3. Second shot had each survivor at 110 px with a third of the frame on foreground rock.
   The FOV is now solved from the row's span for ~68% frame-width occupancy rather than
   being a fixed 44°.

### No regression on the existing survivor

`03-thirdperson` after the change: `110/110` health, level 1, and the four skill icons
read `DOUBLE TAP / PHASE ROU… / TACT. DIVE / SUPP. SALVO`. Same stats, same loadout, same
rig, same cyan dash ribbon. The Ranger's `buildRanger()` body is the original `build()`
body with only its shared tail (`root.traverse` + contact blob) lifted into `_finish()`,
and every palette override it would have used is defaulted to the value it hardcoded.

---

## 4. Contract compliance

- **Stat pipeline** — every survivor's numbers go through `ctx.items.stats(base)`.
  Nothing reads item counts. Buffs modify the *base* block, never the returned cache.
- **Authority** — Bulwark's barrier and armor grant is inside `if (ctx.authority)`; its
  visual tell is not. All ability damage routes through `Combat`, which host-gates.
  Deployables resolve nothing on a client for the same reason projectiles don't.
- **`ctx.rng` vs `ctx.fxRng`** — `chargeTell`'s bead jitter is the only new randomness
  in this work and uses `ctx.fxRng`. Nothing new touches `ctx.rng`. (The pre-existing
  `hitscan()` spread still uses `ctx.rng`; left as-is — changing the gameplay stream's
  consumption pattern is not a change to make silently in a parallel wave. Flagged
  below.)
- **No cross-system imports** — everything goes through `ctx.*` or `ctx.events`.
- **Replay determinism** — one-shot effects stay out of the replay path via
  `replayFire`; buff expiry is an absolute `ctx.time`, never a countdown, so a replayed
  window cannot tick it down twice.
- **File ownership** — only `data/survivors.js`, `data/abilities.js`,
  `entities/CharacterMesh.js`, `entities/Player.js`, the new `entities/Placeables.js`,
  appends to `core/Engine.js` and `core/Harness.js`, and one SCENARIOS entry in
  `tools/capture.mjs`. Nothing in `ui/`, `world/`, `systems/`, `data/items.js` or
  `data/enemies.js` was touched.

---

## 5. Left undone / known gaps

1. **Deployables are not damageable.** They are not registered with `ctx.combat`, so
   enemies ignore them and they only ever die on their own clock. The reason is in a
   long comment at the top of `Placeables.js`: registering them routes their destruction
   through `Combat._kill`, which emits `kill`, and Progression/Items/Director all listen
   to that event — a player's own expiring turret would book XP, gold and on-kill item
   procs. They are also not in the snapshot protocol, so a host that could kill them and
   a client that could not see them killed would diverge. Making them destructible is a
   protocol change, not a gameplay tweak, and belongs in a round that owns
   `net/Protocol.js`.
2. **`hitscan()` spread still draws from `ctx.rng`.** Pre-existing, and NETCODE.md says
   clients must not advance the gameplay stream after stage generation. A client firing
   its own primary does advance it. Not introduced here and not fixed here — the fix
   touches how every existing ability rolls and wants its own change.
3. **No survivor-select UI** — by design; that is B3's. The API above is the whole
   contract and is live now.
4. **`survivorChanged` is a new event** not yet in `CONTRACTS.md`. Someone who owns that
   file should add the row: `survivorChanged | { survivor, player } | Player`.
5. **Balance is unmeasured.** The coefficients were set by feel against the Ranger's
   existing numbers; no DPS comparison was run and none of the four has been played
   against the real difficulty curve. Kestrel's Eclipse Round (1100% + a 400% blast on an
   11 s cooldown) and Rook's Sentry (2 charges, 24 s each, 2 shots/s) are the two most
   likely outliers.
6. **`setSurvivor` leaks the old rig's geometry.** Deliberate — it is a between-runs
   action and disposing buffers that `VFX.hitFlash` may still hold a clone of is a worse
   failure than a few retained kilobytes. Commented in place.
7. **Deployables do not appear in any screenshot.** `09-survivors` photographs the rigs,
   not Rook's turrets in the field. `abilityAudit` proves they fire and build without
   error, but a critic cannot grade a sentry's model or a ward's dome from the current
   shot set. A `09b-deployables` scenario would close that.

---

## 6. Files touched

| file | status |
|---|---|
| `src/data/survivors.js` | new |
| `src/entities/Placeables.js` | new |
| `src/data/abilities.js` | rewritten (4 existing preserved, 12 added, helpers added) |
| `src/entities/CharacterMesh.js` | palettes + 3 new body kits + `_finish()` refactor |
| `src/entities/Player.js` | survivor-driven loadout, buffs, deployables, dash options |
| `src/core/Engine.js` | +6 lines (`ctx.survivorId`) |
| `src/core/Harness.js` | +2 methods (`survivors`, `abilityAudit`) |
| `tools/capture.mjs` | +1 SCENARIOS entry (`09-survivors`) |
| `shots/09-survivors.png` | new capture |
