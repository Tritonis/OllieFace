# C2 — the corruption tier

Nine corrupted items, one new rarity, its drop plumbing, its tooltip and icon
treatment, and a 99-check unit suite.

**Every number below names the file on disk it was read from.** Three artifacts:

| file | what |
|---|---|
| `reviews/round6/base/manifest.json` | the immutable round-6 baseline (`fba0a91`) |
| `reviews/round6/items/manifest.json` | full capture with this work in the tree |
| `reviews/round6/items-control/manifest.json` | `--only 10-inventory`, transform disabled |
| `reviews/round6/C2-corruption.test.out.txt` | the drop-rate and transform measurements |

---

## 1. The tier is called **Blight**

Not Void, and nothing near it. `BRANDING-LEDGER.md` records ~50 verbatim RoR2
proper nouns already in the build and calls removing them a ship blocker; this
tier adds zero. The name, all nine card names, all nine flavour lines and all
nine glyph keys are original, and the test suite asserts it — `[1] catalogue`
greps the whole tier's text surface for `void` and for each of the eleven RoR2
void-item names and fails if any appears.

Why *Blight* rather than a coined word: the mechanic is that one card spreads
through the inventory and converts a specific ordinary item into more of itself.
Blight is exactly that noun — a thing that takes a crop and leaves a different,
worse crop — and it is concrete, agricultural and grim in the register the
original enemy roster already established (Bile Spitling, Silt Burrower, Brood
Sac, Slag Hulk). It is a word about *what happens to the things you own*, which
is the only tier in the game whose identity is about the rest of the inventory.

The tier colour is magenta `#e05aa8` (`Icons.js` `TIERS.blight`). It is the only
hue left: the six existing tiers occupy white, green, red, yellow, cyan and
orange, and a seventh plate that read as "a slightly different green" would be
worse than no colour. It is also deliberately *not* the blue-violet the
reference game uses for its version of this tier.

---

## 2. The nine items and their pairings

Each card names the ordinary item it eats in the `corrupts` field, and quotes
that item's display name in its own description via a lookup (`consumes(id)` in
`items.js`) rather than a literal — so the pending branding rename cannot leave
a corrupted card describing an item name that no longer exists.

| corrupted card | id | eats | upside | what it costs you |
|---|---|---|---|---|
| Spasm Gland | `spasm-gland` | Soldier's Syringe (common) | +26% attack speed/stack (base: +15%) | max health × 0.87/stack |
| Bloat Cyst | `bloat-cyst` | Bison Steak (common) | +55 max health/stack (base: +25) | −9 armor/stack |
| Clouded Eye | `clouded-eye` | Lens-Maker's Glasses (common) | +20% crit chance k (base: 10%) | crit *bonus* damage ×0.77/stack |
| Slag Ingot | `slag-ingot` | Repulsion Armor Plate (common) | −13 damage taken/stack (base: −5) | movement speed × 0.83/stack |
| Arc Rot | `arc-rot` | Ukulele (uncommon) | 40% chain k at 110% dmg, 5 bounces (base: 25%/80%/4) | 1.5% current health per arc (30% floor) |
| Bile Shell | `bile-shell` | AtG Missile Mk. 1 (uncommon) | 22% k, 450% shell (base: 10%/300%) | all your damage × 0.83/stack |
| Gristle Sickle | `gristle-sickle` | Harvester's Scythe (uncommon) | crits heal 24/stack (base: 8) | no passive regeneration |
| Rupture Gall | `rupture-gall` | Brilliant Behemoth (legendary) | every attack explodes for +105% (base: +60%) | max health × 0.74/stack |
| Loaded Knucklebone | `loaded-knucklebone` | 57 Leaf Clover (legendary) | +2 luck/stack (base: +1) | −40 armor/stack (+28.6% damage taken at 1) |

Four commons, three uncommons, two legendaries — no boss or lunar item is
corruptible, because both of those are already the reward for a specific act
(killing a teleporter boss, opting into a drawback) and quietly deleting one
would be taking back something the player was handed on purpose.

### Balance: "strictly better" is a bug, and the suite proves it is absent

`[2] balance` builds the stat block for *n* copies of the corrupted card and for
*n* copies of its base, at n = 1, 3 and 10, and requires at least one field to
come out **worse**. Eight of the nine fail that comparison by construction. The
ninth (Arc Rot) has no stat function at all — its cost is billed per proc
through `payHealth` — so it is checked against its own description text
instead. All nine also have to state a drawback in the text the player reads.

Two costs are worth calling out as designed rather than incidental:

- **Arc Rot bills per proc, not per stack.** Stacking already buys more procs;
  a per-stack bill would make the cost quadratic in the count and the card would
  stop being takeable at three copies. It routes through the same
  `SELF_COST_FLOOR` (30% of max health) the lunar tier uses, so it can never be
  the thing that kills you.
- **Clouded Eye scales the *bonus* half of the crit multiplier**, via a new
  `critEdge` accumulator applied after the whole inventory has contributed. A
  naive `critMult *= …` reaches a state at ten stacks where a critical strike
  deals *less* than an ordinary hit, which is not a gamble, it is a bug.

### Two order-independence fixes that came with it

Both are in the same spirit as the existing `noDefensive` flag:

- `s.critEdge` (new) — see above.
- `s.noRegen` (new) — Gristle Sickle removes passive regeneration, and so does
  the existing lunar **Corpse Bloom**, which did it with `s.healthRegen = 0`
  inside the item loop. That kept whatever regeneration an item inserted *later*
  into the inventory Map added, i.e. the survivor's regen depended on the order
  chests were opened in. Corpse Bloom now sets the flag too; the flag is
  consumed once the loop has finished.

---

## 3. Drop plumbing

Blight sits at `weight: 0` in `TIERS`, exactly like boss and lunar: it is never
reachable by multiplying the generic ladder. Instead `Items.rollTier` gives it
an explicit **4% share of whatever table it was handed** (`BLIGHT_SHARE`), and
`DROP_TABLES.blight` exists for anything that wants to hand one out on purpose.

A *share* rather than a weight, because the world's chest tables arrive as bias
objects that **multiply** the ladder — `{common:80, uncommon:20, legendary:1}`
against 80/20/1 is really 6400/400/1 — so a fixed weight tuned for a small chest
(≈283) would make blight the only thing the red chest, whose table totals 1,
ever paid. A share is scale-free.

The share is offered only to tables that can already pay an ordinary tier. Boss
and lunar pools name one tier and keep it: a teleporter boss must always pay a
boss item.

### Measured rates — `reviews/round6/C2-corruption.test.out.txt`

200,000 rolls per row, `RNG(20260801)`, through the real `Items.rollTier`:

```
small chest  (object bias): blight 3.98%   (target 4.00%)
large chest  (object bias): blight 3.98%
red chest    (object bias): blight 3.98%
named "small":              blight 3.98%
named "large":              blight 3.98%
named "legendary":          blight 3.98%
named "boss":               blight 0.00%
named "lunar":              blight 0.00%
```

3.98% on every ordinary table regardless of its scale, 0.00% on both
single-source pools. Against ~40-60 rolled drops in a full run that is two or
three corrupted cards — part of the game, still an event.

### It costs the gameplay RNG stream nothing

The share is pushed into the `entries` array **inside the single
`rng.weighted` draw that was already happening**. The suite asserts it
(`rollTier still advances the RNG by exactly one draw`, same `rng.s` before and
after as a bare `next()`). This matters because `Multishop`'s constructor calls
`rollItem` during stage generation: an extra draw there would have shifted every
later placement in the world and silently re-rolled every capture in the build.

`Artifact of Caprice` re-rolls the tier, and it is now guarded so it cannot
overwrite a corruption that has already been rolled — otherwise the artifact
would silently delete the whole tier from the run, which is not what "the shelf
is re-rolled" promises. `Artifact of Command` composes untouched: it picks
*which* corrupted card off the blight pool, exactly as it does for every
other tier.

---

## 4. Idempotency and order-independence — how it was proved

The transform lives in `Items._settleBlight` plus one interception in
`Items.give`, and there is only **one** direction of work: pull the base's
stacks in, guarded by the base's own count.

- **Base first, then the card.** `_settleBlight` sets the base to 0 and adds
  that many stacks to the corrupted card.
- **Card first, then the base.** `give` intercepts *before* the stack lands and
  routes it straight into the corrupted card, so the ordinary item never enters
  the inventory at all.
- **A second copy of the card** finds the base already at zero and does nothing
  beyond adding its own stack.

All inventory mutation now goes through one method, `_set(id, absoluteCount)`,
which is the single place the invariants live: no zero-count entries left in the
Map, hooks rebuilt, stat cache dirtied, and an **absolute** `itemPickup` on the
wire — absolute rather than a delta precisely so a client that drops or
duplicates one self-corrects on the next instead of drifting a stack apart from
the host forever. `take()` was rewritten onto it too and is otherwise unchanged.

### The proofs (`[3] transform`, all passing)

| check | result |
|---|---|
| base ×3 then card ×1 | base 0, card 4; the consumed id is **deleted**, not left at 0 |
| card ×1 then base ×3 | base 0, card 4 — identical |
| card ×1 twice, then base ×5 later | base 0, card 9 — a later base pickup still converts |
| `_settleBlight` called twice more | inventory byte-identical — no-op |
| **200 random permutations** of all 9 pairs (18 pickups) | every one reaches **one identical inventory**: 3 of each corrupted card, none of any base |
| the resulting **stat block** under two opposite orders | identical, field for field |
| client (`authority: false`) | adopts host totals; a host count of 0 **deletes** the entry rather than storing a 0; `give` transforms nothing locally |

The permutation test is the load-bearing one: it is not "does the happy path
work", it is "is the final state a function of the multiset of pickups and not
of their order", which is the actual requirement.

---

## 5. Visual treatment — inversion, not decoration

`10-inventory` is the worst-scoring shot in the project (4.2 across three
rounds) and it is already dense, so the tier adds **nothing** to the strip: no
badge, no overlay, no second frame, no extra row of chrome. It changes the two
elements the tile already has and exchanges them.

**Every other tile in the build is a bright tier-coloured silhouette on a
near-black plate. A blight tile is the photographic negative of that** — the
plate takes the tier colour as a solid field and the glyph is punched out of it
in the plate's own black (`Icons.drawInverted`). In a row of eighty bright-on-
dark tiles the corrupted ones read as holes, which is both instantly findable
and thematically exact.

It is done with compositing rather than by recolouring, because `drawGlyph`
picks its own fills and strokes: the glyph is drawn onto an empty plate,
`source-in` floods the pixels it marked with black, and `destination-over`
paints the field in behind everything it did not. That works for all ninety-odd
glyphs without any of them knowing the tier exists.

The tooltip says the same thing the same way (`Tooltip.show`): the item name
sits **in** the tier colour rather than being written in it — one inverted chip
on the element the eye reaches first, no extra row.

Each corrupted card also has its own new glyph, authored as a *deformed echo* of
the glyph it eats: Spasm Gland is the syringe's three bars seizing, Clouded Eye
is the glasses' ring filmed over, Rupture Gall is the Behemoth nova going off
inside a growth. The suite asserts all nine glyph keys are unique and that none
reuses an existing item's glyph.

---

## 6. Capture status — one shot changed, and it is an assertion, not a defect

**`10-inventory` now fails, and I could not fix it, because the fix is one line
in `src/core/Harness.js`, which this round's file ownership excludes.**

The assertion (`Harness.js:2910-2913`) is:

```js
subject: 'every tier in the inventory strip',
dom: () => (ctx.hud?.inv?.size ?? 0) >= ITEMS.length - 2,
detail: () => ({ shown: ctx.hud?.inv?.size ?? 0, items: ITEMS.length }),
```

It counts the strip against **the catalogue**. The scenario gives one of every
item in `ITEMS`; nine of those are now corrupted cards which eat nine ordinary
items on arrival, so the correct strip holds 83 tiles for a 92-card catalogue.

| capture | shown | items | verdict |
|---|---|---|---|
| `reviews/round6/base/manifest.json` | **83** | 83 | pass |
| `reviews/round6/items/manifest.json` | **83** | 92 | fail |
| `reviews/round6/items-control/manifest.json` (transform disabled) | 92 | 92 | pass |

**The strip renders exactly 83 tiles in both the baseline and this work** — the
same number, one tile per item actually held, no ghosts, no clutter. The shot is
not busier. The only thing that grew is the denominator the assertion happens to
use.

The control run is the attribution: with `_settleBlight` stubbed to `return
null` and nothing else changed, the shot reads 92/92 and passes. So the check is
a pure function of the transform and no other part of the scenario is affected
by the tier.

### The one-line change this needs, for whoever owns `Harness.js`

The subject is named "every tier in the inventory **strip**", and the honest
denominator is the inventory, not the catalogue. This is strictly a stronger
assertion — it still catches the HUD failing to draw a tile:

```js
dom: () => (ctx.hud?.inv?.size ?? 0) >= (ctx.items?.inventory?.().length ?? ITEMS.length) - 2,
detail: () => ({ shown: ctx.hud?.inv?.size ?? 0, items: ctx.items?.inventory?.().length ?? ITEMS.length }),
```

### The other capture deltas are not mine

`reviews/round6/items/manifest.json` lists five failing shots against the
baseline's four, and the tree contains six other agents' uncommitted work. Only
`10-inventory` is attributable here:

| shot | baseline | this run | mine? |
|---|---|---|---|
| `04-combat` | horde (6 objects at **0 px**) + open arena + lens | horde only, 23/24 visible, worst object 7 px | **no** — improved by someone else's work |
| `06-loaded-hud` | passing | "monsters under load", object 0 at 6 px | **no** — enemy rendering, no item content |
| `08-explosion` | monsters + damage numbers | "the blast" (vfx pools) | **no** — the VFX agent's live target |
| `09-survivors` | failing | **passing** | **no** — fixed by someone else |
| `10-inventory` | passing | strip assertion | **yes — see above** |
| `11-bestiary` | roster | roster | unchanged |

`04-combat`'s six zero-pixel objects are gone and `09-survivors` now passes, so
the tree has moved forward underneath this work in both directions. A clean
attribution for anything other than `10-inventory` would need a capture of a
tree that no longer exists.

---

## 7. Known limitation, with the patch: the HUD item strip cannot retire a tile

`ui/HUD.js`'s `onItemPickup` creates a tile the first time it sees an id and
there is no path that ever removes one. An id driven to **zero** therefore keeps
its tile with a blank stack badge.

**This is pre-existing, not introduced here**: `Items.take()` has always had the
same effect and the Hollow Market's refinery already calls it. But corruption
makes it routine, so it needs closing.

It is worked around in the one direction where a workaround exists: `give`
intercepts a base item that is about to be corrupted *before* the stack lands,
so the doomed tile is never created at all. That is why the `10-inventory`
strip is clean at 83 tiles. In the other direction — the common one in a real
run, where you already hold the ordinary item and then find the corrupted card —
the base tile does remain, blank.

Two things are needed, neither in files this round owns:

1. **`ui/HUD.js`, in `onItemPickup`** — retire the tile when the count reaches
   zero:
   ```js
   if (total <= 0) {
     const row = entry.el.parentElement;
     entry.el.remove();
     if (row && !row.childElementCount) row.remove();
     if (!group.querySelector('.item')) group.classList.remove('has-items');
     this.inv.delete(id);
     return;
   }
   ```
   (`group` is already in scope on the creation path; it needs lifting out of
   the `if (!entry)` block.)
2. **`ui/hud.css`** — add `.t-blight { --tc: var(--t-blight); color: var(--tc); }`
   and `--t-blight: #e05aa8;` alongside the other six. Nothing breaks without
   it — the tile art and the tooltip both carry their own colour — but the
   strip's group rule for the tier draws uncoloured until it lands.

Until (1) lands, the pickup banner is the only feedback the transform gets, so
`Tooltip.describeItem` now answers a zero count with *"Consumed by a corruption
in your inventory."* rather than describing an item the player has just stopped
owning as though they had gained it. That is a stopgap that stays useful after
the HUD fix.

---

## 8. Files changed

| file | what |
|---|---|
| `src/data/items.js` | `TIERS.blight`; the 9-card BLIGHT section; `BLIGHT_ITEMS`/`BLIGHT_BY_BASE` with structural pairing validation; 9 new glyphs in `drawGlyph`; Corpse Bloom moved onto `noRegen` |
| `src/systems/Items.js` | `_set` as the single mutation point; `_settleBlight`; the `give` interception; `BLIGHT_SHARE` in `rollTier`; `DROP_TABLES.blight`; Caprice guard; `critEdge`/`noRegen` in `stats()`; client mirror deletes on 0; `TIER_ORDER` |
| `src/ui/Icons.js` | `TIERS.blight`, `TIER_ORDER`, `drawInverted` |
| `src/ui/Tooltip.js` | inverted name chip; `describeItem` answers a zero count |
| `reviews/round6/C2-corruption.test.mjs` | 99 checks, house style (`node reviews/round6/C2-corruption.test.mjs`) |

`ITEMS` declares the BLIGHT section **before** COMMON rather than in rarity
order. That is deliberate and stated in the file: anything that replays the
catalogue in order and gives one of everything then introduces each corrupting
card before the card it corrupts, so the replay ends in the state a real run
would reach. It is also the reason `10-inventory` shows no stale tiles, which
means that shot is **not** evidence that the direction-A HUD path is correct —
§7 is.

Pre-existing suite failures, unchanged by this work (verified by stashing):
`B2-artifacts` 84/2, `B1-profile` 65/1.
