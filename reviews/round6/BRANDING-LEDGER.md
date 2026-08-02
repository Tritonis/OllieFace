# Branding ledger — verbatim Risk of Rain 2 names still in the build

Compiled 2026-08-01 in the main session while the four fix agents ran.
**Nothing has been renamed yet.** This is the audit; the rename is a separate,
sequenced job because it touches files three of the four agents currently own.

## Why this is a ship blocker, not a polish item

`Hopoo Feather` is not just a Risk of Rain 2 item name — **Hopoo Games is the actual
developer's studio name.** Shipping it as an item is the single clearest piece of
evidence that this build copied its content wholesale. `Runald's Band` and
`Shatterspleen` are the same class of problem. RoR2 is the declared *visual*
reference target in `RUBRIC.md`, which is fine and stays; lifting ~50 proper nouns
verbatim is not the same thing and does not stay.

## The good news: `id` and `name` are separate fields

```js
{ id: 'syringe', name: "Soldier's Syringe", tier: 'common', … }
```

Display names live only in `name:`. Renaming them does **not** touch save data,
`UNLOCK_BINDINGS`, the golden RNG hashes, or any id-keyed lookup. The blast radius
is `name:` fields plus the handful of places that quote a display string literally.

Two ids are themselves infringing and DO carry save-data risk if changed:
`hopoo-feather` and `shatterspleen`. Rename the display names first; treat the ids
as a separate decision with a save-migration attached.

## Items — 40 of 83 are verbatim RoR2

`syringe` Soldier's Syringe · `hoof` Paul's Goat Hoof · `steak` Bison Steak ·
`roll-of-pennies` Roll of Pennies · `tougher-times` Tougher Times ·
`armor-plate` Repulsion Armor Plate · `crowbar` Crowbar ·
`predatory` Predatory Instincts · `glasses` Lens-Maker's Glasses ·
`sticky-bomb` Sticky Bomb · `gasoline` Gasoline · `monster-tooth` Monster Tooth ·
`topaz-brooch` Topaz Brooch · `medkit` Medkit · `ukulele` Ukulele ·
`atg` AtG Missile Mk. 1 · `tri-tip` Tri-Tip Dagger · `stun-grenade` Stun Grenade ·
`infusion` Infusion · `harvesters-scythe` Harvester's Scythe ·
`leeching-seed` Leeching Seed · `afterburner` Hardlight Afterburner ·
`wax-quail` Wax Quail · **`hopoo-feather` Hopoo Feather** ·
`will-o-wisp` Will-o'-the-Wisp · `fuel-cell` Fuel Cell ·
`berzerkers-pauldron` Berzerker's Pauldron · `razor-wire` Razor Wire ·
`frost-relic` Frost Relic · `ceremonial-dagger` Ceremonial Dagger ·
`brainstalks` Brainstalks · `behemoth` Brilliant Behemoth · `clover` 57 Leaf Clover ·
`alien-head` Alien Head · `titanic-knurl` Titanic Knurl · `planula` Planula ·
`queens-gland` Queen's Gland · `corpse-bloom` Corpse Bloom ·
**`shatterspleen` Runald's Band** (id *and* name are both RoR2, from two different items).

Borderline, judgment call, listed for completeness rather than flagged:
`molten-core` Molten Core (RoR2 has "Molten Perforator"), `rebar-launcher` Rebar
Launcher (RoR2 has "Rebar Puncher"), `sentry-drone` Sentry Drone.

The other 43 item names are original and should be left alone — they are the
reference for the register the replacements should match.

## Enemies — 6 of 23. The roster is mostly original already

`beetle` Beetle · `lemurian` Lemurian · `wisp` Wisp · `pest` Blind Pest ·
`golem` Stone Golem · `titan` Stone Titan.

Everything else — Chitter Mite, Bile Spitling, Cinder Harrier, Ridgeback Charger,
Silt Burrower, Brood Sac, Aegis Warden, Rift Stalker, Grave Acolyte, Siege Bombard,
Slag Hulk, Pyre Matron, Ossuary Wyrm, Verdant Maw — is original work and is the
proof this project can name its own things. Match that register.

## Difficulties — all 3 are verbatim

`Drizzle` / `Rainstorm` / `Monsoon`, at `src/data/artifacts.js:172,186,199` and
`src/ui/Menus.js:52-54`. **These are also asserted by the harness** — the
`18-difficulty` scenario matches on the rung string, so renaming them without
updating `src/core/Harness.js` will break a shot that another agent is fixing
right now. Sequence this after that agent lands.

## World nouns

| string | where |
|---|---|
| `Newt Altar` | `src/world/realms/Realms.js:48,122` · `src/data/realms.js:222` · `src/systems/Progression.js:316` |
| `Shrine of Chance` | `src/world/Interactables.js:578` · `src/systems/Items.js:61` |
| `Rallypoint` | `src/world/Props.js:1406` · `src/world/Materials.js:1208,1216` · `src/core/Harness.js:81` |
| `Providence` | `src/data/items.js:469` (flavour text) |
| `Risk of Rain` | `src/systems/VFX.js:19` · `src/systems/Director.js:1` (comments citing the reference — these are fine, keep) |

`Teleporter` appears ~90 times and is deliberately **not** on this list: it is a
generic genre noun, not a distinctive mark, and renaming it would churn a third of
the codebase for no benefit.

## Sequencing — do NOT start this yet

Three of the four in-flight agents own files on this list: `Harness.js` (difficulty
rung + `RALLYPOINT`), `Materials.js` / `Props.js` (`Rallypoint`), and
`realms/Realms.js` (`Newt Altar`). Apply after they land and their work is committed.

Order when it runs:
1. `src/data/items.js` + `src/data/enemies.js` — pure `name:` edits, zero blast radius.
2. Difficulty rungs, together with the matching `Harness.js` assertion.
3. World nouns, together with their harness/material references.
4. Then a full `capture.mjs` run: renames can only break things through literal
   string matches, and the harness is where those live.

Leave `id` values alone in passes 1–4. `hopoo-feather` and `shatterspleen` as ids
get their own decision with a save migration.
