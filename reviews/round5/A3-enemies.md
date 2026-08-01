# A3 — Bestiary expansion (round 5)

6 enemies / 1 boss card / 3 affixes  →  **16 spawn cards / 6 bosses / 5 affixes in 2 tiers**.

All randomness goes through `ctx.rng`; nothing new touches `ctx.fxRng`'s job. Every
state change added here is inside `Director.fixedUpdate` (already gated on
`ctx.authority`), inside `Enemy.fixedUpdate` (only ever stepped by the Director,
i.e. host-only), or inside `Director.summon` / the `damage` handler, both of which
carry their own `ctx.authority` check. Every unit registers through
`ctx.combat.register` via the unchanged `Enemy.spawn` path and satisfies the
Entity contract unchanged.

---

## Roster

`cost` is the director's credit price, `maxAlive` the per-card population ceiling,
`weight` its selection rarity.

| id | name | tier | role / threat | behaviour | cost | maxAlive | weight |
|---|---|---|---|---|---|---|---|
| `mite` | Chitter Mite | 1 | chaff swarmer, packs of 5-9, no real tell | `swarm` | 4 | 12 | 1.0 |
| `beetle` | Beetle | 1 | melee chaff (existing) | `melee` | 6 | 10 | 1.0 |
| `spitling` | Bile Spitling | 1 | lobbed acid over cover, slows | `kiter` | 9 | 6 | 0.9 |
| `lemurian` | Lemurian | 1 | melee + fireball bruiser (existing) | `melee` | 11 | 6 | 0.9 |
| `wisp` | Wisp | 1 | hovering homing bolts (existing) | `ranged` | 13 | 5 | 0.8 |
| `pest` | Blind Pest | 1 | suicide diver (existing) | `diver` | 16 | 5 | 0.7 |
| `harrier` | Cinder Harrier | 1 | fast flyer, **sweeping** strafe beam — punishes standing still | `kiter` | 18 | 4 | 0.6 |
| `charger` | Ridgeback Charger | 1 | telegraphed straight-line gore charge, knockback | `charger` | 22 | 4 | 0.55 |
| `burrower` | Silt Burrower | 2 | **burrower** — untouchable underground, erupts at your feet | `burrower` | 20 | 4 | 0.6 |
| `brood` | Brood Sac | 2 | stationary spawner, hatches 4 mites every 8 s | `stationary` | 24 | 2 | 0.4 |
| `warden` | Aegis Warden | 2 | **shielded bruiser** — 82% frontal damage cut, must be flanked | `melee` | 26 | 4 | 0.5 |
| `stalker` | Rift Stalker | 2 | blink-lunge assassin (vanishes mid-dash) | `melee` | 28 | 4 | 0.5 |
| `acolyte` | Grave Acolyte | 2 | **support** — heals + grafts shields onto the pack, ignores you | `support` | 30 | 2 | 0.35 |
| `golem` | Stone Golem | 2 | tracking beam artillery (existing) | `ranged` | 32 | 4 | 0.7 |
| `mortar` | Siege Bombard | 2 | **artillery** — 3 arcing shells with ground rings, scattered | `kiter` | 34 | 3 | 0.45 |
| `hulk` | Slag Hulk | 3 | armoured heavy: slam, molten volley, burn nova | `melee` | 46 | 2 | 0.25 |

Threat-space coverage: chaff swarmer (mite), ranged pressure (spitling, wisp,
golem), flyers (wisp, pest, harrier), charger (charger, stalker), burrower
(burrower), shielded/armoured bruiser (warden, hulk), artillery/mortar (mortar,
spitling), support (acolyte), spawner (brood). **Forces movement rather than
stand-and-shoot:** harrier (moving beam), mortar (walked ground rings), burrower
(erupts under you), charger (committed line), maw/thunderhead/vizier novas.

New AI is real behaviour, not stats. `src/ai/StateMachine.js` gained `CHARGE`,
`SUBMERGED` and `TEND`; `src/ai/Steering.js` gained `keepRange` (hold a standoff
band, strafe inside it) and `pursue` (lead the target). `Enemy.steer` now branches
on a `behavior` field with eight personalities, so two cards sharing an attack
still occupy the fight differently.

New attack kinds implemented in `Enemy.fireAttack` / the state table: `charge`
(committed dash with a one-shot contact latch and knockback, optional `blink`
which hides the rig for the dash), `burrow` (dig tell → invulnerable submerged
pursuit trailing spoil rings → surfacing eruption), `nova` (self-centred radial
with a wind-up ground ring), `summon` (adds, counted against the population cap),
`mend` (heal + grafted shield on up to N allies), `pull` (per-step suction on the
player's velocity). `projectile` gained `volley`/`volleySpread` (cones),
`scatter` (artillery walking shells around you), `telegraph` (impact ring that
lives exactly as long as the shell's flight) and `status` riders.

## Bosses

Six, drawn from a shuffled bag so a run never repeats one until all six are used.
Each is multi-phase (`phaseAt`), each phase break resets cooldowns, fires a blast
+ shake, and unlocks a `phase`-gated attack that changes what the player must do.

| id | name | h (m) | silhouette | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| `titan` | Stone Titan | 7.6 | colossal stone slab-stack, waist furnace | slam / stomp / sweeping barrage | 65% — faster wind-ups, core cracks | 28% — adds `meltdown`, an 18 m burn nova |
| `wyrm` | Ossuary Wyrm | 5.4 | a **curve**: 7 tapering segments arching out of a spoil crater into a 4-part splayed jaw | surface tail sweep | 62% — lives underground, only surfaces to erupt (9 m blast) | 26% — both, plus a 7-shard bone volley |
| `thunderhead` | Thunderhead | 5.0 | **rings**: 3 counter-rotating plate rings round a storm core, conductor spines beneath | high-altitude homing bolt volleys | 60% — descends, rules the ground with a sweeping arc | 25% — adds a 20 m shock discharge |
| `matron` | Pyre Matron | 5.8 | arachnid cage: 8 legs arched *over* a low thorax, egg-lit abdomen | scattered pyre mortars w/ ground rings | 66% — hatches 6 broodlings per cast, arena fills | 30% — closes, adds a 15 m flame nova |
| `vizier` | Iron Vizier | 6.4 | crowned humanoid, 3.6 m tower shield on one side, poleaxe on the other | shield up: 85% frontal cut, shield-charge + sunder | 62% — **shield drops** (visible pose change), twin beam sweep | 24% — adds `verdict`, a 17 m slowing nova |
| `maw` | Verdant Maw | 5.2 | the only **horizontal** boss: 6 petals round a toothed throat in a rooted crater | tendril slam waves + spore volleys | 64% — `pull` drags you back into range | 28% — petals open further (boss is literally bigger), 22 m bloom |

None of them is "a big enemy with more HP": every one has an attack kind or a
movement rule that no spawn card has (`pull`, `summon`, phase-gated tables,
stationary, boss-scale burrow), and every one is a distinct silhouette family
(stack / curve / rings / cage / armoured column / crater).

## Elite affixes

Two tiers. Tier 2 does not exist until the difficulty coefficient reaches 3.2
(measured: available at 25 min solo, earlier with stages completed), which is the
RoR2 Malachite/Celestine gate expressed on the director's own clock.

| affix | tier | unlock | hp / dmg / cost | mechanic | visual signature |
|---|---|---|---|---|---|
| blazing | 1 | 0 | 4.0 / 2.0 / 4.5x | burn aura | red tint, 5 orbiting ico bits |
| overloading | 1 | 0 | 3.2 / 2.0 / 5.0x | shield, death blast | blue tint, 5 orbiting ico bits |
| glacial | 1 | 0 | 4.0 / 2.0 / 4.5x | slow, death nova | pale cyan, 6 **shard** bits |
| **withering** | 2 | 3.2 | 5.0 / 2.2 / 6.8x | **healing denial** — all healing nullified while it has LOS within 16 m, + thorn aura | sick green, **9 thorn spikes climbing a slow vertical helix** |
| **warded** | 2 | 3.2 | 3.4 / 2.2 / 7.2x | **reflective barrier** — 110% hp shield, 55% damage cut while it holds, **22% of everything reflected back**, nova when it pops | violet, **faceted barrier shell + wireframe edge pass** — the only affix that changes the unit's outline |

Healing denial is enforced in `Director.enforceHealDenial` as a running ceiling on
player health rather than by editing `Combat.heal` — every heal source in the
game is nullified at once, including ones written after this code, and it costs
one comparison per step when nothing withering is alive. `ctx.director.healingDenied`
is exposed for the HUD (B3). Reflect hangs off the `damage` event, not
`Enemy.takeDamage`: Combat drains the shield pool *before* calling `takeDamage`,
so a reflect there only fires once the barrier is already gone.

## Meshes

All 16 new rigs (11 enemies + 5 bosses) are hand-built in `EnemyMeshes.js` in the
existing idiom — merged primitive clusters cached by key, `body`/`dark`/`accent`/`eye`
slots, crumble registration for the death collapse, procedural animators with
anticipation + follow-through, LOD-gated IK. `EnemyMeshes.js` went 1650 → 3858
lines. Each species has its own palette entry (no two neighbours in a tier share
a hue) and a deliberately distinct black-shape read: mite = tiny wedge with a
vertical tail spike, spitling = top-heavy sac on three legs, harrier = arrowhead
delta, charger = wedge with hips higher than head, burrower = eyeless digger with
oversized claws, brood = bulb on a rooted stalk, warden = asymmetric wall,
stalker = four lines and a floating halo, acolyte = legless cone + halo (also the
only rig with no per-frame IK, which is why it is affordable as a common card),
mortar = squat quadruped under a tube taller than itself, hulk = lopsided brute
with one huge arm.

## Director

- Spawn pool: all 16 cards, tier-gated (`TIER_UNLOCK` now `{1:0, 2:1.55, 3:2.6, 4:∞}`).
- `rollCard` rewritten: 30% "most expensive affordable", otherwise weighted by
  `selectionWeight * sqrt(cost) * reach`. The pool is deliberately **not** filtered
  to affordable cards — that is how the bank saves toward heavies — with a
  half-bank filler spend on 45% of the saving intervals so the arena never goes
  quiet. Per-card `maxAlive` stops the cheapest card owning the population cap.
- `HARD_POP_CAP` (64) and the `spawnRate` setting contract are untouched;
  `populationCap` and the credit rate still scale together off `spawnRateMult`.
- New: `Telegraphs` pool (ground rings, own material instance per ring so six
  shells in flight show six different countdowns), `summon()` (cap-respecting),
  `spawnTelegraph()`, `denyHealing()` / `healingDenied`, `pickBossCard()` bag,
  `countAlive()`, `fillerCard()`. Projectiles now apply `def.status` riders.
- Mesh pools prewarmed for every spawn card (4 per tier-1 card, 2 otherwise).

---

# Verification (real output)

## Build

```
$ npm run build
vite v8.2.0 building client environment for production...
✓ 80 modules transformed.
✓ built in 945ms
```
(only the pre-existing >500 kB chunk-size advisory)

## Capture — `node tools/capture.mjs`

```
{ "ready": true, "shots": [ "01-title","02-vista","03-thirdperson","04-combat","05-boss",
  "06-loaded-hud","07-interactables","08-explosion","09-survivors","10-inventory",
  "11-bestiary","12-boss-phases","13-biomes-1","13-biomes-2","13-biomes-3","13-biomes-4" ],
  "errorCount": 0 }

$ node -e "...manifest..."
ready: true | total errors: 0 | shots with problems: 0
```
Every shot: `frameErrors: 0`, `lastFrameError: null`, `newErrors: []`.

New scenarios (both added to `Harness.js` and `capture.mjs`, appended only):
- **`11-bestiary`** — all 16 spawn cards in two ranks, sorted small-to-large with
  the tall half at the back, three-quarter view, with a **withering** golem and a
  **warded** warden in the line so both tier-2 signatures are photographed. The
  rank position is searched: candidate centres are scored on ground flatness
  along the rank axis *and* per-slot line of sight from a `clearCam` vantage, and
  the rank axis is derived from the accepted camera rather than from a world axis.
- **`12-boss-phases`** — Iron Vizier driven into phase 3 through the real damage
  path (`ignoreArmor: true` is load-bearing: its phase-1 tower shield is 85%
  frontal reduction, and without it an 80%-of-health hit took 11% off and the
  "late phase" shot documented phase 1), frozen at 85% of a `verdict` wind-up.
  Shot shows the boss bar at 21%, the shield dropped, and the ground telegraph ring.

## Perf — `node tools/perf.mjs`, quality 3, RTX 2070, 1600x900

**Before (baseline, two runs, taken before any of this work):**

| run | avg | median | p95 | worst | saturated |
|---|---|---|---|---|---|
| 1 | 15.60 | 16.40 | 20.0 | 21.4 | 0 |
| 2 | 21.83 | 20.80 | 27.6 | 29.7 | 0 |

**After (three runs):**

| run | avg | median | p95 | worst | saturated |
|---|---|---|---|---|---|
| 1 | 42.04 | 20.50 | 28.9 | 517.8 | 1 |
| 2 | 45.47 | 20.90 | 472.5 | 472.5 | 1 |
| 3 | 21.33 | 20.50 | 27.7 | 27.7 | 0 |

Median and p95 (runs 1 and 3) are inside the baseline's own two-run range. The
~500 ms `worst` frame in runs 1-2 is **one** frame and always coincides with
`saturatedFrames: 1` — it is the engine's wake-up catch-up frame after
`Harness.combat()` calls `freeze()`, which `perf.mjs` then samples across; the
baseline happened not to wake inside its window (`saturatedFrames: 0`).

Because that artifact makes `perf.mjs` a poor A/B, I ran a **controlled
isolation** with the engine genuinely running (~380-570 frames per 8 s window),
24 units, quality 3, alternating rosters in one session:

```
original-5   frames 570  avg 13.51  med 12.3  p95 21.5  worst 43.0   newPrograms []
full-roster  frames 453  avg 17.85  med 14.2  p95 28.9  worst 595.3  newPrograms [1 program]
original-5b  frames 340  avg 23.24  med 14.3  p95 59.4  worst 166.1  newPrograms []
full-roster2 frames 395  avg 20.00  med 14.4  p95 50.6  worst 74.0   newPrograms []
```
and a second pass of the same probe after that one program was in the cache:
```
original-5   med 17.1  worst 69.9   newPrograms []
full-roster  med 16.1  worst 98.5   newPrograms []
original-5b  med 13.8  worst 129.5  newPrograms []
full-roster2 med 15.3  worst 75.3   newPrograms []
```
Conclusion: the full roster costs ~1-2 ms of median frame time over the original
five at 24 units, and once the program cache is warm its worst-frame behaviour is
indistinguishable from the original five. **No regression attributable to the roster.**

## Spawn pacing — `node tools/spawnprobe.mjs`

```
{ "authority": true, "netRole": "single", "frameErrors": 0, "lastFrameError": null,
  "director": { "enabled": true, "credits": 11, "creditRate": 0.952,
    "difficultyCoefficient": 1.002, "spawnInterval": 2.5995, "card": "spitling",
    "popCap": 18, "eventActive": false },
  "spawnPointSearch": { "samplePoint": "200/200", "findSpawnPoint": "200/200",
                        "randomWalkablePoint": "200/200" } }
```

Card-selection distribution across the curve (600 rolls per point, sweeping a
realistic bank range; % of rolls):

| minute / difficulty | top of the distribution |
|---|---|
| 0 min, d=1.00 | mite 21, charger 17, beetle 15, wisp 11, lemurian 10, spitling 9, pest 9, harrier 8 |
| 8 min, d=1.81 | mortar 17, mite 13, beetle 11, wisp 8, pest 6, lemurian 6, spitling 5, burrower 5, golem 5, charger 5, stalker 5, warden 4, harrier 4, brood 4, acolyte 3 |
| 18 min, d=2.82 | hulk 21, beetle 8, mite 8, spitling 7, pest 6, lemurian 6, golem 6, mortar 6, wisp 6, harrier 5, burrower 5, warden 5, stalker 4, brood 4, charger 2, acolyte 2 |
| 25 min, d=3.53 | hulk 23, spitling 8, mortar 8, beetle 8, wisp 6, lemurian 6, mite 6, golem 6, burrower 5, acolyte 5, pest 4, warden 4, stalker 4, charger 3, brood 3, harrier 3 |

All 16 cards are represented from the 8-minute mark on, no card exceeds 23% of
rolls, and chaff keeps arriving at minute 25 — the RoR2 shape. (First cut of this
was **53% hulk** at 18 min and a field of 24 identical mites at 12 min; both are
fixed by `selectionWeight` + `maxAlive` + the saving/filler rewrite, all measured.)

Elite tiers by difficulty: `tier1` at 0/4/8/12/18 min, `tier1+tier2` at 25 min
(d=3.53 ≥ 3.2). Population caps 18 → 33 and elite chance 0 → 0.134 over the same
span, unchanged from the tuned curve.

Boss bag draw over 8 events: `maw, wyrm, matron, vizier, titan, thunderhead,
matron, vizier` — all six before any repeat.

Live 45 s windows from an empty field (no attrition), director untouched:

| start | difficulty | popCap | alive after 45 s | species standing |
|---|---|---|---|---|
| 0 min | 1.08 | 18 | 8 | spitling, mite |
| 12 min | 2.28 | 26 | 13 | wisp, mite, beetle, lemurian |
| 22 min | 3.30 | 32 | 16 | mite, beetle, warden, charger |

## Mechanics smoke test (scratch probe, since removed)

Every one of the 22 cards spawned, forced through **every** attack in its table,
run to completion:

- 22/22 cards: `newFrameErrors: 0`, `lastFrameError: null`, 0 page errors.
- States actually reached: `charge` (charger, stalker, vizier), `submerged`
  (burrower, wyrm), plus `windup/attack/recover/chase` on all.
- `brood` hatch produced 4 adds; `matron` brood produced 6 adds.
- **Withering:** `healingDenied: true`, 300 healing attempted → **0 retained**.
  After the elite dies: `healingDenied: false`, 42.9 attempted → **42.9 retained**.
- **Warded:** 400-damage hit → 180 absorbed by the barrier (rest cut by ward
  armour), **39.6 reflected to the player** (= 22% of 180).
- **Warden frontal armour:** identical 500-damage hit — **90 lost from the front,
  480 from behind** (5.3x), i.e. flanking is worth exactly what the card claims.

---

## Left undone / known issues

1. **`11-bestiary` composition.** All 16 read and both tier-2 affixes are legible,
   but the biome the seed lands on is wooded and a foreground tree still clips the
   left of the rank. The placement search maximises per-slot visibility but cannot
   guarantee a clearing on every seed. A `declutter`-style prop-suppression pass
   for that one scenario would fix it; I did not add one because prop code is A4's.
2. **`perf.mjs` samples a frozen engine.** `Harness.combat()` ends in `freeze()`,
   so the profile window catches ~20 sporadic frames and one wake-up catch-up
   frame that dominates `avg`/`worst`. Not introduced here and not mine to change
   (the tool is shared), but every `avg`/`worst` number that tool prints — before
   and after — should be read as noise around the median.
3. **Vizier core blowout.** The phase-3 chest core still clips slightly white
   through bloom in `12-boss-phases`; I reduced its scale swing from 1.65x to
   1.32x, which helped but did not eliminate it.
4. **`ctx.director.healingDenied` has no HUD treatment** — exposed for B3 to
   render; a player currently learns about the debuff only by watching heals do
   nothing.
5. **No unit-level regression test** for the new attack kinds; verification above
   is a one-shot probe rather than something that runs in CI (the repo has no test
   runner).

## Files touched

Owned:
- `src/data/enemies.js` (+688)
- `src/entities/Enemy.js` (+588)
- `src/entities/EnemyMeshes.js` (+2208)
- `src/systems/Director.js` (+337)
- `src/ai/StateMachine.js` (+10), `src/ai/Steering.js` (+41)

Shared, append-only:
- `src/core/Harness.js` — two new scenarios (`bestiary`, `bossPhases`) added to the
  `H` object; no surrounding code reformatted.
- `tools/capture.mjs` — two scenario entries inserted before the `lateRun` block.

`src/core/Engine.js` needed no change. Nothing in `ui/`, `world/`, `data/items.js`,
`data/abilities.js`, `entities/Player.js` or `systems/Items.js` was modified.
