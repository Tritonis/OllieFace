# Round 7 — Agent B: content volume and depth

Branch `round7/content-and-polish`. 18 items (16 passive + 2 equipment), 1 survivor
with 4 abilities and a full `CharacterMesh` rig, 3 enemies with rigs and animators.

---

## 1. Items

All 18 are implemented purely against the existing hook vocabulary and the existing
`Items` API — no new stat-block fields, no new buff names the stat pipeline has to
know about, and no edits to `src/systems/Items.js` (which this round does not own).

### Common (3) — cards that buy *positions*, not numbers

The white tier already owns the flat stat ladder (Flint Shard, Kevlar Weave, Cured
Haunch); a fourth entry on it would be dead weight. What was missing was cards that
change where the player chooses to stand.

| id | name | effect | design intent |
|---|---|---|---|
| `bipod` | Folding Bipod | +40%/stack damage while `player.moving` is false | Reads the same planted/mobile flag the guns' spread model already uses, so the existing precision-vs-mobility split finally pays out. |
| `whetstone` | Chipped Whetstone | +70%/stack against a target not hit for 4s | The exact mirror of Hunter's Tag. The Tag pays for staying on one body; this pays for leaving it. Holding both is coherent: open on everything, finish the marked one. |
| `prey-instinct` | Prey Instinct | +18%/stack move speed below 40% health | Conditional *stats* are the one shape `Items.stats` cannot express (the cache is keyed on the base block and would not rebuild when health crossed the line), so this re-applies a short `quickfoot` buff from `onInterval` — it expires on its own when the condition stops. |

`whetstone` uses a module-local `WeakMap`, deliberately **not** `Items.mark`: the mark
table is Hunter's Tag's, and two items writing one shared set of marks would mean
picking up either silently powers the other.

### Uncommon (5) — multipliers on what the rest of the inventory already does

| id | name | effect | design intent |
|---|---|---|---|
| `affliction-index` | Afflictor's Index | +25%/stack vs enemies with burn/bleed/slow/freeze/shock | The "scales with other items" card. Warm Coals, Gutting Shiv, Frost Lattice, Concussion Charge and Hoarfrost Band were all previously terminal — apply an ailment, ailment does its own small damage. This gives the whole ailment half of the pool a second output. |
| `tether-harpoon` | Grapnel Tether | 10%/stack on hit to reel a target a third of the way in and slow it | Control at green tier. Bosses excluded (same rule as Collapsing Well). The displacement re-checks `ctx.authority`; the beam that draws it does not. |
| `emberwake` | Emberwake Cleats | while moving, a 3.2m cinder patch every 0.6s for 4s | Kiting becomes damage. Every other AoE in the file is earned by shooting; this is earned by retreating. Bounded for free by `Items.addCloud`'s `MAX_CLOUDS`. |
| `arc-capacitor` | Arc Capacitor | a non-primary cast charges the next hit into a chain | Rewards weaving — cast, then shoot. Primary is excluded on purpose: a held M1 is a skill use 60 times a minute and would make the charge permanent. |
| `scrapfly-hive` | Scrapfly Hive | every 14s, a scrapfly strikes once a second for 5s | First *item* to use `Items.addEffect` (previously equipment-only). Captures its stack count at schedule time — `_tickEffects` runs callbacks with `api.count = 1`, so a closure reading `a.count` would price every hive at one. |

### Legendary (3) — each attaches its payout to a resource the player already manages

| id | name | effect | design intent |
|---|---|---|---|
| `entropy-ledger` | Entropy Ledger | up to +80%/stack scaling with missing health | The inverse of every defensive item in the file: with Trauma Plate the right play is to stay topped up, with this it is to hold a wound. Capped at 80% missing so the peak is reachable without standing on 1 HP. |
| `temporal-echo` | Temporal Echo | 35%/stack for Secondary and Special to cast again, free, 0.9s later | Calls `ability.fire` directly, so it never emits `abilityUsed` and cannot echo itself; pays no cooldown and consumes no charge. Primary excluded (would be an attack-speed item with a delay); **Utility excluded** because every utility on the roster displaces the caster, and replaying a dash 0.9s later would teleport the survivor out of wherever they dodged to. |
| `gilded-reliquary` | Gilded Reliquary | +5%/stack damage per 250 gold held, capped at 8 steps | The only item in the game that argues with the shop. Every chest is now a choice between the item behind it and the damage the gold itself is worth. The cap keeps hoarding strong and never strictly correct. |

### Boss (1)

`tectonic-heart` — **Tectonic Heart**: every 3rd jump erupts a 9m quake and throws you
forward. The boss tier is otherwise entirely passive; this is the one card in it with a
button. Rides `tally` (a countable beat you can set up) rather than a chance, and
`tally` is host-only so the two machines cannot disagree about which jump it was.

### Lunar (2) — real trades

| id | name | effect | design intent |
|---|---|---|---|
| `vow-of-momentum` | Vow of Momentum | +110%/stack while moving; damage cut to `1/(1+0.9n)` while still | Folding Bipod inverted. A run holding both holds two items that cancel. The only Lunar drawback the player can play around moment to moment, which is why it can afford a much larger upside than Shattered Covenant's. |
| `ashen-pact` | Ashen Pact | all hits ignite; lose 2%/stack of current health per second, floored at 30% | Unconditional ignite hands the whole burn half of the pool a guaranteed trigger. Cost is per *second held*, so it does not scale with attack speed and cannot be outrun by a fast primary. Uses the existing `payHealth` floor: never lethal. |

### Blight (2)

Both obey the tier's two structural rules (nothing strictly better than what it eats;
every cost order-independent).

- `gorge-tooth` — **Gorging Tooth** (corrupts Marrow Tooth): heals 7%/stack of max
  health on kill, but shrinks the pool to `1/(1+0.22n)`. The two halves fight: the
  smaller the bar, the more a percentage heal refills and the fewer hits it survives.
- `splinter-bar` — **Splinter Bar** (corrupts Pry Bar): +130%/stack above 90% health,
  damage cut to `1/(1+0.5n)` below 25%. Both halves in one multiplicative `outgoing`,
  so there is no stat-ordering question. Places the cost on the *other* end of the
  health bar, which makes it an explicit argument with Hollowpoint Pouch.

### Equipment (2)

- `recall-beacon` — **Recall Beacon**: press with nothing planted to plant (free);
  press again within 60s to return and heal 25%. The tier's only two-state card. The
  plant deliberately returns `false` so `useEquipment` refunds the charge — the plant
  has no immediate effect and charging for it would make the card feel broken half the
  time it was pressed. The 60s window bounds staleness: an anchor is coordinates and
  nothing else, and a stage transition rebuilds the terrain under them.
- `aegis-emitter` — **Aegis Emitter**: a 10m dome for 8s, enemies inside slowed, +30
  armor while you stand in it. The tier's only *positional* card — drone, lantern and
  crown all follow the player, so holding them changes nothing about where you stand.
  The armour buff is re-granted every half second rather than once, so it lapses the
  moment you step out with no enter/exit bookkeeping to get wrong.

All 18 have a bespoke glyph case in `drawGlyph` — none falls through to `default:`
(verified, see §4). `gilded-reliquary` uses `glyph: 'gildedcup'` because Gale Reliquary
already owns `'reliquary'`.

---

## 2. Survivor — CINDER, the ash foreman

The roster's first **attrition** survivor. Every other kit resolves a fight on contact
(Ranger's rounds, Anvil's swing, Kestrel's lance, Rook's turret). Cinder deals almost
none: her output is deferred into `burn` stacks and lingering ground, and the Special
calls it all in at once. The loop is *apply → spread → detonate*, and the skill it asks
for is target management across a horde rather than accuracy against one body. She is
also the survivor the status half of the item pool was waiting for.

125 hp / 13 dmg / 6.9 m/s / 4 armor / 0.01 crit. Inside the Ranger's shadow on every
axis on purpose — pricing her direct damage at Ranger levels would have made the
deferred half free. Crit is left at the roster floor because nearly all her damage
arrives as burn ticks and explosions, neither of which can crit; that is a real build
signal, not an oversight.

| slot | ability | shape |
|---|---|---|
| primary | **Stoke** | 48° cone of flame, 95% damage, ignites everything caught. The weakest primary on the roster by direct damage and the only one that applies a status on every hit. |
| secondary | **Pyre Flask** | arc projectile, 260% burst, leaves a 6m pyre for 8s. Sited with `groundAim` at cast time — the projectile system owns its impact and hands out no callback, and the area *is* the ability, so it should land where it was aimed. |
| utility | **Backdraft** | 200% in 6m + ignite, and you are thrown clear. The only escape on the roster that damages what it is escaping from, in every direction. 0.12s of i-frames, half the Ranger's roll — the highest-damage escape must not also be the safest. |
| special | **Conflagration** | detonates every burning enemy within 34m for 600% each. Pays *per burning body*, so its value is entirely a function of how well the last ten seconds were spent. Snapshots the overlap buffer before the first `explode` (procs can rewrite it mid-loop). Never silent even when nothing is lit. |

`Projectile.spawn` carries no `status` field and silently drops unknown keys, so the
flask does **not** claim one — the ignition comes from the pyre it leaves.

### The rig (`buildCinder`)

The roster's silhouettes are separated by where the volume sits: even (Ranger),
forward-hunched and shoulder-heavy (Anvil), thin and tall (Kestrel), bottom-heavy with
a rack (Rook). The shape none of them makes is a hard **inverted triangle**, so that is
what this rig is. Three decisions carry it:

1. **Twin tanks worn high and wide** on the `cape` pivot, above the shoulder line and
   outboard of it — the widest part of the rig is its very top. Rook's rack is the only
   other back-mounted mass and it deliberately hangs low and central.
2. **No coat, no cape, no skirt.** The three other non-Ranger rigs solve the hip region
   with cloth; a skirt here would restore the wide base the shape exists to refuse. The
   `coat` pivot carries two heavy hose loops instead (`CLOTH_GAIN.cinder` swings the
   hoses harder than fabric and the tanks far less).
3. **A forward, low head with a full respirator snout** — a fifth head shape, pushed
   forward so a neck notch stays visible under tanks that would otherwise close over it.

The palette is the one on the roster where the *light plate is the saturated one*
(brass over near-black soot), rather than a desaturated bright value with one accent
hung off it — which is what stops a warm survivor beside Anvil reading as a recolour of
him. `cellGain: 0.66` keeps the six-lamp burner bank from merging into one blown patch,
the same failure Rook's visor band had.

---

## 3. Enemies

Three new spawn cards, all built from existing `kind`s and `behavior`s, each with a
distinct rig, animator and palette hue no neighbour in its tier uses.

### `shriver` — Gloomshriver (tier 1 flyer, cost 15)

Deliberately the *least* dangerous unit in the tier by raw output — 8 base damage
against the Shrike's 16 — because what it takes is not health. Every shot lands a
`slow`, and a slowed player in a horde cannot leave. It is a `kiter` that parks *high*,
so answering the pack by backing off walks you further into its envelope. `burst: 2`
means the dodge has to be held rather than flicked.

Rig: a suspended **bell** — the only silhouette in the roster you can see through, and
the fourth flyer shape after the wisp's spire, the pest's parasol and the harrier's
arrowhead. The wind-up **flares** the bell (X/Z scale only), so the tell is a change in
the outline and survives being seen against a bright sky where brightness would not.
The clapper hangs below the rim, outside the body, and rings after the shot.

### `lasher` — Bramble Lasher (tier 2, cost 29) — *the one that changes how a fight is fought*

`pull` was previously boss-only (the Maw's draw, the Herald's collapse), which meant
"you cannot simply walk away" only ever appeared at the teleporter. Every answer this
game teaches for a horde is positional — kite, break line of sight, hold a ledge, back
off the melee — and the Lasher deletes all four for 1.5s at a time.

Counterplay is real and threefold: the suction falls off with distance and never beats a
full sprint (`Enemy.pullPlayer`), so you can run out of it; you can kill it; or you can
*let it pull you* and spend the free approach on whatever is standing next to it. That
last one is why its own melee is weak — the unit must not punish the player for
accepting its offer.

Rig: a thin trunk under a wide crown of six whipping tendrils. Every other tier-2 ground
unit keeps its mass low or central; this one is almost all crown and its outline is
mostly gaps. The wind-up hauls every arm outward and back at once — a whole-silhouette
anticipation, which it needs because the attack does not travel and there is no
projectile to read instead. The animator reads the reel off the *active* phase rather
than the recovery snap, because `pull` holds `swing` for the whole 1.5s window.

### `redoubt` — Ferrite Redoubt (tier 2, cost 36)

A `beam` unit behind a shield harder and wider than the Warden's (`frontArmor: 0.88`
over 1.3 rad, against 0.82 over 1.15). The load-bearing number is `turnRate: 1.1`, the
slowest on the roster: the beam can follow you, the *body* cannot. So the fight is
circling faster than it can traverse — a skill rather than a reaction — and it is
affordable because the unit has no way to close and punish the long way round. The
`backblast` nova is the answer to hugging it, so "walk around" is right and "stand on
top" is not.

Rig: designed to be identified *by which face you are looking at*. The front is one flat
unbroken plate with a single lens; the back is an open frame of ribs, vents and a hot
core. Front reads as a wall, back reads as machinery. Two shutters clamp over the lens
and peel back through the 1.7s charge (a brightness cue cannot carry a tell that long),
and the rear core breathes with the charge so a player already behind it still sees the
shot coming. Three legs, not four — an odd count reads as an emplacement, not a walker.

All three are registered in `EnemyMeshes.BUILDERS`, which is what puts them in
`ENEMY_IDS` and therefore into `fx/Prewarm.js`'s catalogue walk. No runtime lights were
created anywhere in this round's content; every glow is emissive material or
`VFX.lights.flick` (the pool).

---

## 4. Verification

### Build

`npm run build` — passes (`✓ built in 1.58s`).

> Note for whoever runs this next: partway through, `node_modules/@rolldown/binding-win32-x64-msvc/package.json`
> vanished and the build died with "Cannot find native binding". This is the known
> `npx`-deletes-one-package.json hazard, **not** a code problem. Recreated the file by
> hand (version 1.2.1, `main: rolldown-binding.win32-x64-msvc.node`);
> `package-lock.json` is still `lockfileVersion: 3`. No reinstall was run.

### Runtime assertions (throwaway Playwright script, since deleted)

Booted `?harness=1&pinclock=1` with the seed capture uses, on the real GPU path.

**Icons and tooltips — 18/18.** Every new id resolves through `ITEM_BY_ID` /
`EQUIPMENT_BY_ID`, returns a `description(1)` string and a `flavour`, and renders a
non-empty icon (3524 lit px for every item plate; 621-622 px for the two equipment
glyphs drawn bare). Each glyph was also re-rendered on its own and compared against a
deliberately-unknown glyph (`default:` draws 859 px): **no new glyph matched the
default**, i.e. every one has a real case. Per-glyph lit pixels ranged 338 (`harpoon`)
to 1070 (`tectonic`).

**Item hooks — 18/18 fired, observed through a measured effect.** Onto a registered
dummy, with the engine frozen and `Items.fixedUpdate` driven by hand for the
`onInterval` cards (the live Player recomputes `moving` every fixed step, so a test
that sets the flag and waits on the real loop is testing a flag that was already
overwritten):

| item | measurement |
|---|---|
| bipod | 100 dmg moving → 140 still |
| whetstone | 170 first hit → 100 second hit |
| prey-instinct | `quickfoot` stacks 1, magnitude 0.18 at 20% health |
| affliction-index | 100 clean → 125 burning |
| tether-harpoon | target distance 12.0 m → 0.12 m |
| emberwake | 0 clouds standing still → 3 clouds moving |
| arc-capacitor | charge 1 after a Secondary cast; 79.2 damage spilled to two bystanders; charge consumed to 0 |
| scrapfly-hive | effect installed, 46.8 damage over 2.5s |
| entropy-ledger | 100 at full health → 180 at 10% |
| gilded-reliquary | 100 at 0 gold → 140 at 4000 gold |
| tectonic-heart | 0 damage after 1 jump → 28 after 3 |
| vow-of-momentum | 210 moving → 52.6 standing still |
| ashen-pact | target ignited; 6.47 self-damage over 2.5s |
| gorge-tooth | ate 3 Marrow Teeth → 4 stacks; 1000 base max health → 531.9; healed 1 → 149.9 on kill |
| splinter-bar | ate 2 Pry Bars → 3 stacks; 490 vs a full-health target, 40 vs a 10%-health one |
| recall-beacon | plant returned `false` and spent **no charge** (1 → 1); recall returned `true` and landed 0.10 m from the anchor |
| aegis-emitter | fired, effect running, target slowed |
| temporal-echo | 1 free replay of a Secondary |

**Survivor abilities — 4/4.** `H.abilityAudit()` fired all four Cinder slots
(`cinderStoke`, `cinderPyreFlask`, `cinderBackdraft`, `cinderConflagration`) with
`ok: true`, `frameErrorsAdded: 0`, and no failures anywhere on the roster.

**Enemies — 3/3 spawn, move, attack and die.** Placement searched for a bearing with
clear line of sight (`Enemy.pickAttack` refuses everything while `hasLOS` is false, so a
spawn behind a ridge produces a unit that walks and never fires — a property of the
terrain, not the card):

| id | spawn dist | LOS | moved | attacks begun | max windup | died | retired from `director.enemies` | frame errors |
|---|---|---|---|---|---|---|---|---|
| shriver | 34.0 m | 0.95 | 43.0 m | 1 | 0.979 | yes | yes | 0 |
| lasher | 34.0 m | 1.00 | 12.1 m | 2 | 0.971 | yes | yes | 0 |
| redoubt | 37.4 m | 1.00 | 19.2 m | 1 | 0.971 | yes | yes | 0 |

Killed through `Combat.applyDamage`, not `takeDamage` directly, so the death dispatch,
the reward and the rig dissolve were all exercised.

**Console errors: 0. `ctx.frameErrors`: 0.**

### Capture

Baseline (before any of this round's changes) is on disk at
`reviews/round7/_baseline/manifest.json`; the after run is at
`reviews/round7/_after/manifest.json`. Same seed, same shot list, same command.

```
node tools/capture.mjs --out reviews/round7/_after --port 5211 \
  --only 01-title,04-combat,09-survivors,11-bestiary,10-inventory
```

| | baseline (master) | after |
|---|---|---|
| `errorCount` | **2** | **2** |
| `subjectsOk` | false | false |
| failing subjects | `04-combat: horde`, `10-inventory: monsters standing in it` | `09-survivors: the four survivors`, `11-bestiary: the whole spawn roster` |

**`errorCount: 0` was not achievable and was not achievable before this round either** —
the baseline on master reports 2, and both entries are the harness's own
`console.error` for a failed subject gate. There are no *thrown* errors in either run:
`frameErrors` is 0 in every shot of both. Two subjects failed before and two fail after;
they are different shots.

Honest account of what moved and why:

- **`04-combat` and `10-inventory` now pass.** Composition drift only. Adding content
  shifts the shared `ctx.rng` sequence, which moves enemy spawn positions; both were
  failing on marginal per-object separation at the baseline site and land better now.
  Nothing was fixed — the dice moved.
- **`09-survivors` now fails.** Not broken; out-framed, and by arithmetic that is
  structural. The gate is `perObject: true, minPixels: 4000, minObjects: SURVIVORS.length`,
  so `minPerPx = 4000/5 = 800` — the floor is *unchanged* by adding a survivor, while
  the row widens by one slot and the camera fits it, shrinking every rig by roughly
  `(4/5)² = 64%` in area. Object 0 (the Ranger, the thinnest rig on the roster, not the
  new one) came in at **785 px against a floor of 800** — 98% of the bar. Cinder itself
  measured 953 px, comfortably clear, and all five bodies were visible and well
  separated (`sepP50` 0.47 against a 0.25 floor, `legible` 0.851). The fix is one line
  in `Harness.js` `survivors()` — either tighten `SPACING`/`fill` so the wider row is
  framed closer, or make `minPixels` scale with the roster instead of being a fixed
  4000. **I do not own `Harness.js` this round and did not touch it.**
- **`11-bestiary` now fails.** Same shape, and the margin was eaten rather than the shot
  broken. `SPAWN_CARDS` went 16 → 19, so `bestiary()`'s `perRow = ceil(19/3)` went 6 →
  7; the rank is a slot wider and everything in it is ~14% smaller linearly. The mite —
  the shortest card in the game at 0.5 m, and object 0 in the height-sorted rank —
  measured **146 px against a floor of `3500/19 = 184`**. All 19 were visible, roster
  `sepP50` 0.65 against 0.25, and 18 of 19 cleared their floor. I measured this directly:
  in an isolated `H.bestiary({ rows: 3 })` run on different ground the same 19 cards
  **pass**, worst object 236 px against the same 184 floor — so the framing is
  site-dependent and 19 cards simply no longer have headroom at the site the ordered
  capture reaches. I also measured `rows: 4` (worst 354 px, but object 15 fails on
  separation at 0.21) and `rows: 5` (worst 215 px, object 6 fails on separation at
  0.23), so a naive rank change is not the fix either — it wants a `standoff`/`rankGap`
  retune, again in `Harness.js`.

Neither failure is a runtime defect: no shot threw, every subject was *present* and
above every aggregate floor, and both misses are a single object under a per-object
pixel floor that shrinks with roster size while the objects shrink with it.

## 5. Files touched

- `src/data/items.js` — 16 items, 16 glyph cases, 2 equipment glyph cases, 3 helpers
- `src/data/equipment.js` — 2 equipment cards
- `src/data/survivors.js` — Cinder card
- `src/data/abilities.js` — 4 Cinder abilities
- `src/data/enemies.js` — 3 spawn cards
- `src/entities/CharacterMesh.js` — Cinder palette, cloth gain, pose, `buildCinder`
- `src/entities/EnemyMeshes.js` — 3 palettes, 3 builders, 3 animators, `BUILDERS` entries
- `node_modules/@rolldown/binding-win32-x64-msvc/package.json` — repaired, see above

`src/data/artifacts.js` was not touched (no artifacts added; `DIFFICULTIES` and
`DEFAULT_DIFFICULTY` untouched as instructed). No system files were edited.
