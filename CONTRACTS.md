# Shared contracts

Every system is a class with `init(ctx)` plus any of `fixedUpdate(ctx, h)`,
`update(ctx, dt)`, `lateUpdate(ctx, dt)`. `ctx` is the object built in
`src/core/Engine.js`. Do not import one system from another — go through
`ctx.<name>` or `ctx.events`.

## ctx fields

| field | owner | type |
|---|---|---|
| `scene`, `camera` | Engine | THREE.Scene / PerspectiveCamera |
| `rng` | Engine | `RNG` from `core/MathUtil.js` — **all** randomness goes through this |
| `time` | Engine | seconds of unpaused gameplay; drives difficulty |
| `hitstop` | Engine | set `ctx.hitstop = 0.06` to freeze gameplay for impact frames |
| `player` | Player | `src/entities/Player.js` |
| `stage` | Stage | `src/world/Stage.js` |
| `director` | Director | `src/systems/Director.js` |
| `combat` | Combat | `src/systems/Combat.js` |
| `items` | Items | `src/systems/Items.js` |
| `corruption` | Corruption | `src/systems/Corruption.js` — the run's second economy; read `world`/`band`, call `feed`/`seed`/`bleed`. Never import it |
| `blight` | Blight | `src/systems/Blight.js` — presentation only. Nothing in gameplay may read it; it is published so tools and tests can see the patch registry |
| `vfx` | VFX | `src/systems/VFX.js` |
| `audio` | Audio | `src/systems/Audio.js` |
| `hud` | HUD | `src/ui/HUD.js` |
| `pipeline` | main | `src/core/RenderPipeline.js` |
| `input` | main | `src/core/Input.js` |
| `coop` | Coop | `src/net/Coop.js` — the netcode/gameplay seam |
| `lobby` | main | `src/net/Lobby.js` — host/join flow for the UI; not a system |
| `authority` | Engine | `true` on host and single-player. Gate every state change on it |
| `netRole` | Engine | `'single'` \| `'host'` \| `'client'` |
| `fxRng` | Engine | cosmetic randomness — never `ctx.rng`, see NETCODE.md |

## Events (`ctx.events.emit(name, payload)`)

| name | payload | emitted by |
|---|---|---|
| `damage` | `{ target, source, amount, crit, position, proc }` | Combat |
| `kill` | `{ victim, source, position, isElite, isBoss }` | Combat |
| `playerHurt` | `{ amount, remaining }` | Combat |
| `itemPickup` | `{ id, count, tier, delta, reason }` — `count` is the **absolute new stack total**, `delta` the change (negative on removal); `reason` is `'give'` \| `'take'` \| `'corrupt'` (`'corrupt'` = the blight transform re-stacking items the player already owns, not an acquisition) | Items |
| `goldChanged` | `{ gold }` | Items |
| `abilityUsed` | `{ slot, ability }` | Player |
| `teleporterCharging` | `{ progress }` | Progression |
| `teleporterComplete` | `{}` | Progression |
| `stageStart` | `{ index, name }` | Progression |
| `bossSpawn` / `bossDead` | `{ enemy }` | Director |
| `playerDead` | `{}` | Combat |
| `corruptionChanged` | `{ world, band }` — fired on every non-zero feed | Corruption |
| `corruptionBand` | `{ band, prev }` — only on a threshold crossing | Corruption |
| `blightSeed` | `{ x, z, strength }` — where greed happened | Corruption |
| `itemMutated` | `{ baseId, blightId, count, band }` — a corruption threshold converted a held stack | Items |
| `voidtouchedSpawn` | `{ x, z, id }` — a Hollowed unit surfaced from blight | Director |

## Settings

`ctx.settings` is owned by `src/ui/Menus.js`, persisted to localStorage, and is
the one hook systems read player preferences from. Each system pulls its own
value rather than being pushed to:

| key | read by | meaning |
|---|---|---|
| `quality` | RenderPipeline | preset index, 0-3 |
| `fov`, `sensitivity` | main / CameraRig | |
| `master`, `sfx`, `music` | Audio | 0-1 |
| `shake` | RenderPipeline | screen-shake scale |
| `spawnRate` | Director | enemy pacing, 0-3 (1 = tuned curve). Scales credit rate and population cap together; `HARD_POP_CAP` still wins. Host-only in co-op |

## Stat pipeline

`ctx.items.stats(base)` returns the modified stat block. Never read item counts
directly in gameplay code — always go through the stat block so stacking rules
live in one place.

Base block shape:
```js
{ maxHealth, healthRegen, moveSpeed, attackSpeed, damage, critChance, critMult,
  armor, cooldownMult, jumpCount }
```

## Collision / queries

`ctx.stage` exposes:
- `raycast(origin, dir, maxDist) -> { point, normal, distance } | null`
- `sampleHeight(x, z) -> y` (terrain height, ignores props)
- `capsuleResolve(position, radius, height, velocity, dt) -> { position, velocity, grounded, normal }`
- `randomWalkablePoint(rng, { minDistFrom, minDist }) -> THREE.Vector3`

## Entity contract

Anything damageable registers with `ctx.combat.register(entity)` and provides:
```js
{ id, isPlayer, alive, health, maxHealth, position: THREE.Vector3,
  radius, height, team: 'player'|'monster',
  takeDamage(amount, info), onDeath() }
```

## Units

1 world unit = 1 metre. Player capsule: radius 0.45, height 1.8, eye 1.6.
Gravity 26 m/s² (snappier than real, matches the RoR2 arc). Base move 7 m/s.
