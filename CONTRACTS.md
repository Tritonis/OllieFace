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
| `vfx` | VFX | `src/systems/VFX.js` |
| `audio` | Audio | `src/systems/Audio.js` |
| `hud` | HUD | `src/ui/HUD.js` |
| `pipeline` | main | `src/core/RenderPipeline.js` |
| `input` | main | `src/core/Input.js` |

## Events (`ctx.events.emit(name, payload)`)

| name | payload | emitted by |
|---|---|---|
| `damage` | `{ target, source, amount, crit, position, proc }` | Combat |
| `kill` | `{ victim, source, position, isElite, isBoss }` | Combat |
| `playerHurt` | `{ amount, remaining }` | Combat |
| `itemPickup` | `{ id, count }` | Items |
| `goldChanged` | `{ gold }` | Items |
| `abilityUsed` | `{ slot, ability }` | Player |
| `teleporterCharging` | `{ progress }` | Progression |
| `teleporterComplete` | `{}` | Progression |
| `stageStart` | `{ index, name }` | Progression |
| `bossSpawn` / `bossDead` | `{ enemy }` | Director |
| `playerDead` | `{}` | Combat |

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
