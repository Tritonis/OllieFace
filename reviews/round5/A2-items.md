# A2 — Items, Equipment, Lunar, Drop Tables

Round 5 content wave. Status: **complete**, with one integration point left open for
A4 (equipment barrel) and one honest gap (co-op equipment input bit).

---

## 1. Counts

| Tier | Before | Added | After |
|---|---:|---:|---:|
| Common (white) | 14 | +14 | **28** |
| Uncommon (green) | 14 | +12 | **26** |
| Legendary (red) | 6 | +9 | **15** |
| Boss (yellow) | 3 | +4 | **7** |
| Lunar (blue) | 0 | +7 | **7** |
| **Items total** | **37** | **+46** | **83** |
| Equipment (orange) | 0 | +12 | **12** |
| **All cards** | 37 | +58 | **95** |

All 37 pre-existing items are untouched in tuning. Two were corrected in *plumbing*
only, not in numbers:

- `fuel-cell` now writes `equipCharges` / `equipCooldownMult` instead of
  `extraCharges` / `cooldownMult`. Its description always said "equipment charge";
  before this round there was no equipment, so it was silently buying the
  survivor's *skill* charges instead. That is a bug fix, not a retune.
- No item changed tier. The existing spread was already correct.

Design space covered by the additions: on-hit procs (`copper-wire`, `squall-charm`,
`rebar-launcher`, `gravity-well`), proc-chain amplifiers (`star-chart`,
`resonance-coil`), stacking damage (`flint-shard`, `siege-battery`, `ammo-pouch`),
survivability (`kevlar-weave`, `carapace-plate`, `sunken-vertebra`,
`kinetic-recycler`), mobility (`updraft-vents`, `mercury-anklet`, `rubber-soles`),
cooldown (`bandolier`, `chronal-governor`, `gale-reliquary`), on-kill
(`spark-plug`, `overcharge-cell`, `warlock-ember`, `spore-sac`, `corpse-bloom`),
and economy (`scrap-magnet`, `tithe-of-ash`).

Names are original IP. The pre-existing 37 keep their RoR2-derived names because
the brief said to leave them alone.

## 2. Lunar tier — the drawbacks are real

Measured live, one stack of four Lunars on a level-1 survivor
(`tools/equipprobe.mjs`, output in §6):

| | clean | +4 Lunar |
|---|---:|---:|
| damage | 12 | **22** |
| maxHealth | 110 | **71** |
| armor | 0 | **−35** |
| healthRegen | 1.0 | **0** |
| attackSpeed | 1.0 | **2.0** |
| blockChance | (as rolled) | **0** |

Every card is a trade:

| Item | Upside | Cost |
|---|---|---|
| Shattered Covenant | +80% damage | max health × 0.65 |
| Hollow Vow | +100% attack speed | block chance and flat reduction set to 0 |
| Mercury Anklet | +50% move, +1 jump | −35 armor (≈ +26% damage taken) |
| Tithe of Ash | +200% gold on kill | −31% damage |
| Corpse Bloom | 8% max health per kill | passive regeneration disabled |
| Brittle Edge | +45% crit chance | 3% of current health per crit |
| Gale Reliquary | −46% skill cooldowns | 4% of max health per skill use |

Two implementation notes worth reviewing:

- **Order independence.** Multiplicative Lunar penalties go through `damageMult` /
  `healthMult` accumulators applied *after* every item's `stat()` has run. Touching
  `s.damage` directly would have made the result depend on the order the inventory
  `Map` iterates — i.e. on the order chests happened to be opened in.
- **`payHealth` floor (`data/items.js`).** Self-damage never bills below 30% of max
  health and is never lethal. The first capture of `10-inventory` shipped the
  survivor pinned at `1 / 375` — a "drawback" the player cannot act on is a bug, not
  a trade. Second capture reads `233 / 774`.

Lunar has weight 0 in every chest table. It is only reachable through
`rollTier('lunar')` / `rollItem('lunar')`, so a white chest can never hand out a
downside the player did not opt into.

## 3. Equipment — API for B3's HUD slot

`src/data/equipment.js` (12 cards) + the slot in `src/systems/Items.js`.
**Fully playable from the keyboard with no HUD at all.**

```js
ctx.items.equipment            // read-only snapshot, or null:
                               // { id, def, ready, charges, maxCharges,
                               //   cooldown, cooldownMax }
ctx.items.equipmentFraction()  // 0..1 — draw the cooldown sweep from THIS,
                               // not from cooldown/cooldownMax. 1 means a
                               // charge is banked, which has no fraction.
ctx.items.useEquipment()       // -> bool, true if it actually went off
ctx.items.setEquipment(id)     // equip/swap; returns the displaced id
ctx.items.equipmentMaxCharges()
ctx.items.equipmentCooldownMax()
```

Bus events (both fire on host; `equipmentChanged` is mirrored by clients):

```
equipmentChanged  { id, previous, charges, cooldown }
equipmentUsed     { id, charges }
```

Icons — `src/ui/Icons.js`:

```js
import { equipmentArt, cardDef } from './Icons.js';
equipmentArt(id)   // the orange-plate card for the Q slot
cardDef(id)        // item OR equipment definition — for tooltips.
                   // Tooltip.js currently reads ITEM_BY_ID directly and will
                   // render an equipment as a bare id; swapping that one import
                   // for cardDef() is all it needs.
```

Keybind — **F, not Q.** `EQUIPMENT_KEY_LABEL` is exported from
`src/systems/Items.js`; print that rather than hardcoding a letter. Q was already
bound to the utility skill (`Player.js`: `input.down('KeyQ')` → `BTN.UTILITY`) and
Shift to sprint, so the RoR2 layout was not available.

The 12 cards, each with a real visible effect:

| id | cd | effect |
|---|---:|---|
| `blink-anchor` | 18 | teleport 22m along the camera axis, terrain-stepped |
| `mending-flare` | 40 | heal 50% max health + 25% barrier |
| `thermal-lance` | 26 | 1400% × 5 seeking lances |
| `gravity-snare` | 34 | drag everything within 22m in, slow it |
| `sentry-drone` | 45 | 18s of 300% strikes twice a second |
| `overload-cell` | 30 | 16m nova, 1100%, stun, hitstop, shake |
| `frostbite-canister` | 50 | freeze everything within 26m for 4s |
| `stim-injector` | 32 | +150% attack speed / +50% move for 8s |
| `phase-veil` | 55 | 6s untouchable + 30% move |
| `spirit-lantern` | 48 | 12s of 3 seeking spirits per second |
| `meteor-beacon` | 60 | 8 meteors over 4s, 600% each |
| `tesla-crown` | 42 | 10s of 5-target chain lightning every 0.4s |

All of them fire real `ctx.vfx` (burst / ring / beam / missile / explosion /
healPop) and real `ctx.audio` and route damage through `combat.applyDamage` /
`combat.explode` with proc depth carried, so equipment procs items like any other
player-sourced hit.

Two behaviours the HUD should not have to know about but which matter:

- **A refused use costs nothing.** `use()` returning `false` (nothing in range,
  nowhere to blink) refunds the charge. Burning a 60s cooldown on a mis-press with
  no feedback is the worst thing an active can do.
- **Charges recharge sequentially, not in parallel.** With Fuel Cell stacked, a
  parallel timer would refill the whole bank in one cooldown and the slot would
  stop being a resource.

## 4. Drop tables

`DROP_TABLES` exported from `src/systems/Items.js`:

| table | common | uncommon | legendary | measured over 4000 rolls |
|---|---:|---:|---:|---|
| `small` | 80 | 20 | 1 | 78.9% / 20.0% / 1.2% |
| `large` | 0 | 80 | 8 | 90.0% / 10.0% |
| `legendary` | — | — | 1 | 100% legendary |
| `boss` | — | — | — | 100% boss |
| `lunar` | — | — | — | 100% lunar |

`rollTier(name)` selects a named table; `rollTier(obj)` keeps the **old**
multiply-the-ladder behaviour so `world/Interactables.js` (A4's file) keeps working
untouched — verified: its `{common:0, uncommon:80, legendary:8}` object still
produces 99.4% / 0.6%, exactly as before this round.

New: `rollEquipment()` (12 distinct ids over 400 rolls) and `grant(id)`, which
routes an id to the slot or the inventory depending on which catalogue owns it.

Everything is host-only and draws off `ctx.rng`; clients get the floor tier and
never touch the stream.

## 5. Stacking rules

All three shapes live in `Items.js` / `data/items.js` and nowhere else:

- **linear** `per * count` — flat adds.
- **hyperbolic** `1 − 1/(1 + k·count)` — every chance.
- **flat / non-stacking** — Equipment. You hold one; what scales is
  `equipCooldownMult` and `equipCharges`, both fed by *other* items.

Every one of the 95 cards states its behaviour in its `description(n)`.

No gameplay code reads item counts. New stat-block fields, all applied here:
`procBonus`, `equipCooldownMult`, `equipCharges`, `noDefensive`, `damageMult`,
`healthMult`. Notably `star-chart` (all procs +30%) is folded into `Items.roll()`,
the single random gate every chance item passes through, rather than into 30
separate items.

New Items services backing the hooks: `tally`, `mark`/`isMarked`, `timeSinceHurt`,
`buffMagnitude`, `clearBuff`, `addEffect`, `addCloud`. New hook `onAbility`, driven
off the existing `abilityUsed` bus event rather than a second channel.

## 6. Verification — actual output

The shared working tree could not boot during this session: three other agents are
mid-refactor in it. Both failures were in files I do not own and did not touch —

```
# 07:58 — A1's abilities.js
TypeError: Cannot read properties of undefined (reading 'name')
 > src/entities/Player.js:171  const a = ABILITIES[slot];  ...  a.name

# 08:2x — A3's EnemyMeshes.js
TypeError: BUILDERS[id] is not a function
    at prewarm (src/entities/EnemyMeshes.js:3015)
    at Director.init (src/systems/Director.js:119)
```

So the browser verification was run in a **detached worktree at HEAD** carrying only
my four owned files plus my two appended hunks (`Harness.js` scenario,
`capture.mjs` entry) — i.e. my changes against a known-good baseline. The worktree
has been removed.

### `npm run build` — on the real tree, passes

```
> vite build
transforming...✓ 78 modules transformed.
dist/assets/index-Ds_SSngs.js    886.09 kB │ gzip: 275.76 kB
✓ built in 913ms
```

### `node tools/capture.mjs` — all 9 scenarios, isolated worktree

```
{ "ready": true,
  "shots": ["01-title","02-vista","03-thirdperson","04-combat","05-boss",
            "06-loaded-hud","07-interactables","08-explosion","10-inventory"],
  "errorCount": 0 }
```

Per-shot engine telemetry from `manifest.json` (copied to
`reviews/round5/A2-manifest.json`):

```
01-title        {"frameErrors":0,"lastFrameError":null}  newErrors: []
02-vista        {"frameErrors":0,"lastFrameError":null}  newErrors: []
03-thirdperson  {"frameErrors":0,"lastFrameError":null}  newErrors: []
04-combat       {"frameErrors":0,"lastFrameError":null}  newErrors: []
05-boss         {"frameErrors":0,"lastFrameError":null}  newErrors: []
06-loaded-hud   {"frameErrors":0,"lastFrameError":null}  newErrors: []
07-interactables{"frameErrors":0,"lastFrameError":null}  newErrors: []
08-explosion    {"frameErrors":0,"lastFrameError":null}  newErrors: []
10-inventory    {"frameErrors":0,"lastFrameError":null}  newErrors: []
```

`ready: true`, `frameErrors: 0`, `newErrors: []` on every shot including the new one.

### `node tools/lootprobe.mjs` — still works, isolated worktree

```
"interactables": { "total": 11, "byType": { "Chest": 6, "MultishopTerminal": 3,
                   "ShrineOfBlood": 1, "Teleporter": 1 } },
"afterAddGold": 500,
"chest": { "cost": 25, "opened": true, "orbsBefore": 0, "orbsAfter": 1,
           "usedAfter": true },
"giveItem": { "invBefore": 0, "invAfter": 1 },
"authority": true, "frameErrors": 0, "lastFrameError": null
```

Chest → tier roll → orb → inventory is intact end to end after the drop-table
rewrite.

### Catalogue audit (no browser needed, runs on the real tree)

```
items: 83 equipment: 12 ITEM_BY_ID: 83 EQUIPMENT_BY_ID: 12
by tier: { common: 28, uncommon: 26, legendary: 15, boss: 7, lunar: 7, equipment: 12 }
distinct glyphs: 95 of 95 cards
PROBLEMS: none
```

Asserts, per card: unique id, valid tier, a `glyph` that has a real `case` in
`drawGlyph` (no card falls through to the placeholder), a non-empty
`description(1)` free of `NaN`/`undefined`, flavour text, `stat` or `hooks` for
items / `use` + cooldown ≥ 2 for equipment, finite stat output at 1 and 12 stacks,
and `drawGlyph` executing without throwing. **95 cards, 95 distinct glyphs — no
shared or placeholder icons.**

### Equipment + Lunar + drop tables, live

`tools/equipprobe.mjs`, run in the worktree:

```json
{ "seededOnStageStart": "mending-flare",
  "api": { "id": "overload-cell", "name": "Overload Cell", "ready": true,
           "charges": 1, "maxCharges": 1, "cooldownMax": 30, "fraction": 1 },
  "fired": true,
  "afterFire": { "charges": 0, "fraction": 0, "usedEvents": 1 },
  "secondPressRefused": true,
  "cooldownTicking": true,
  "fuelCell": { "cooldownBefore": 30, "cooldownAfter": 18.8,
                "maxCharges": 5, "skillChargesUntouched": 0 },
  "refusedWithNoTargets": true,
  "lunar": { "damage": [12,22], "maxHealth": [110,71], "armor": [0,-35],
             "healthRegen": [1,0], "attackSpeed": [1,2],
             "blockChanceZeroed": true },
  "tables": { "small": {"common":3154,"uncommon":798,"legendary":48},
              "large": {"uncommon":3599,"legendary":401},
              "legendary": {"legendary":200}, "boss": {"boss":200},
              "lunar": {"lunar":200},
              "legacyBiasObject": {"uncommon":3975,"legendary":25} },
  "distinctEquipmentRolled": 12,
  "frameErrors": 0, "lastFrameError": null }
```

### The shot

`reviews/round5/A2-10-inventory.png`. All five item tiers render as distinct
plates with distinct glyphs, stack badges vary, the Lunar pickups toast in blue,
the Overload Cell nova is mid-flight with shockwave rings and damage numbers, and
the health bar reads `233 / 774` (Lunar cost visible, floor holding).

Caveat on that specific PNG: it is from an `--only 10-inventory` re-run, so it did
not inherit the preceding scenarios' camera state and the blast sits lower-right of
frame than in the full run. The full-run version was the better composition; the
`--only` re-run overwrote it. Re-shoot with a full `node tools/capture.mjs` once
the shared tree boots.

## 7. Files touched

Owned:
- `src/data/items.js` — +46 items, Lunar tier, `payHealth`, exported
  `chainLightning`/`seekingStrike`/`nearbyHostiles`, 55 new glyphs in `drawGlyph`
- `src/data/equipment.js` — **new**, 12 cards
- `src/systems/Items.js` — equipment slot, drop tables, stat-block extensions,
  timed effects, clouds, marks, tallies
- `src/ui/Icons.js` — `cardDef`, `equipmentArt`, tier-aware `itemArt`

Shared, appended only (no surrounding reformatting):
- `src/core/Harness.js` — `inventory()` scenario
- `tools/capture.mjs` — `10-inventory` entry (placed after `06-loaded-hud`, before
  A1's `09-survivors`, for the same "loads every item and never unloads them"
  reason the file already documents)

Not touched: `ui/Menus.js`, `ui/HUD.js`, `ui/Tooltip.js`, `data/abilities.js`,
`entities/Player.js`, `data/enemies.js`, `systems/Director.js`, `world/*`,
`core/Engine.js` (needed no registration — `Items` is already added in `main.js`).

## 8. Left undone / for other agents

1. **Equipment barrel (A4).** The barrel belongs in `world/Interactables.js`, which
   I do not own. As an interim source, `Items` seeds the slot on `stageStart` if it
   is empty — clearly marked in the code for deletion. The barrel's `interact()`
   should be one line: `ctx.items.grant(ctx.items.rollEquipment())`. Note
   `spawnOrb` currently rejects any id not in `ITEM_BY_ID`, so an equipment orb
   needs that guard widened to `cardDef` (or the barrel can grant directly).
2. **HUD slot (B3).** API in §3. `EQUIPMENT_KEY_LABEL` is `'F'`, not `'Q'`.
3. **Tooltip (B3).** `ui/Tooltip.js` imports `ITEM_BY_ID` directly; swap that for
   `cardDef` from `Icons.js` and equipment gets tooltips for free.
4. **Co-op equipment input — honest gap.** `useEquipment()` is host-only, correctly.
   But there is no `BTN.EQUIPMENT` bit in `net/Protocol.js`, so a *client's* F press
   does not reach the host and does nothing. Single-player and host are fully
   functional. `Protocol.js` is outside my ownership; the fix is one bit plus a read
   in `Player.applyCommand`, mirroring `BTN.INTERACT`.
5. **Not attempted:** Void tier, item unlocks/logbook entries (B1's `challenges.js`
   can hang off `itemPickup`), per-item 3D pickup meshes (orbs still use the shared
   icosahedron tinted by tier).
