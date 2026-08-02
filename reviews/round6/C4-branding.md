# C4 — branding rename

Applies `reviews/round6/BRANDING-LEDGER.md`. Every verbatim Risk of Rain 2 proper
noun in the owned file set is gone from display strings and from the comments that
quoted them. `id` values are untouched everywhere.

**Verification capture: `reviews/round6/branding/manifest.json`** (21 shots, seed 1337,
`ready: true`, `clockPinned: true`, `partial: false`, `subjectsOk: false`, 4 errors).
Failing set is **identical** to `reviews/round6/merged3/manifest.json`:

| shot | failing subject | merged3 | branding |
|---|---|---|---|
| `04-combat` | horde | fail | fail |
| `06-loaded-hud` | monsters under load | fail | fail |
| `08-explosion` | the blast | fail | fail |
| `11-bestiary` | the whole spawn roster | fail | fail |

No fifth failure. No shot that was passing in `merged3` fails in `branding`.

---

## 1. Items — 39 renamed (`src/data/items.js`, `name:` field only)

The ledger's prose says "40 of 83" but enumerates 39 ids; 39 is the real count.
The 43 original names and the 9 `blight`-tier names were not touched. The three
borderline entries the ledger declined to flag (`molten-core` Molten Core,
`rebar-launcher` Rebar Launcher, `sentry-drone` Sentry Drone) were left alone.

### Common

| id | old | new | why it reads as the mechanic |
|---|---|---|---|
| `syringe` | Soldier's Syringe | **Adrenal Syringe** | attack speed |
| `hoof` | Paul's Goat Hoof | **Cloven Hoof** | movement speed |
| `steak` | Bison Steak | **Cured Haunch** | max health |
| `roll-of-pennies` | Roll of Pennies | **Bruised Coinpurse** | gold *when hurt* — the bruise is the trigger |
| `tougher-times` | Tougher Times | **Dented Buckler** | block chance; the dents are the blocks |
| `armor-plate` | Repulsion Armor Plate | **Trauma Plate** | flat damage reduction (real term for the plate) |
| `crowbar` | Crowbar | **Pry Bar** | same tool, keeps "It opens things" |
| `predatory` | Predatory Instincts | **Bloodscent** | crit → attack-speed stacks; keeps "Blood in the water" |
| `glasses` | Lens-Maker's Glasses | **Gunsmith's Loupe** | crit chance = precision optics |
| `sticky-bomb` | Sticky Bomb | **Tar Charge** | adhesive + explosive |
| `gasoline` | Gasoline | **Leaking Jerrycan** | kill spreads fire |
| `monster-tooth` | Monster Tooth | **Marrow Tooth** | heal on kill |
| `topaz-brooch` | Topaz Brooch | **Amber Clasp** | kill grants a barrier — encased |
| `medkit` | Medkit | **Stitch Kit** | heal after being hurt |

### Uncommon

| id | old | new | why |
|---|---|---|---|
| `ukulele` | Ukulele | **Cracked Zither** | strings, so "it only knows one chord" survives; chain lightning |
| `atg` | AtG Missile Mk. 1 | **Missile Rack Mk. I** | proc missile |
| `tri-tip` | Tri-Tip Dagger | **Gutting Shiv** | bleed |
| `stun-grenade` | Stun Grenade | **Concussion Charge** | stun |
| `shatterspleen` | Runald's Band | **Hoarfrost Band** | big hits freeze and blast |
| `infusion` | Infusion | **Feeding Vial** | kills convert to permanent max health |
| `harvesters-scythe` | Harvester's Scythe | **Reaping Hook** | crits heal |
| `leeching-seed` | Leeching Seed | **Thirsting Burr** | damage drains life |
| `afterburner` | Hardlight Afterburner | **Bailout Thrusters** | extra utility charges = more escapes |
| `wax-quail` | Wax Quail | **Waxed Wing** | sprint-jump forward launch |
| `hopoo-feather` | **Hopoo Feather** | **Hollow Plume** | extra jump; "Weightless, mostly" still lands |
| `will-o-wisp` | Will-o'-the-Wisp | **Corpse Flare** | a kill erupts into a flame pillar |
| `fuel-cell` | Fuel Cell | **Dry Cell** | equipment charges + cooldown |
| `berzerkers-pauldron` | Berzerker's Pauldron | **Red-Mist Pauldron** | matches "the world goes red" exactly |
| `razor-wire` | Razor Wire | **Barb Snare** | hurt → lashes everything close |

### Legendary

| id | old | new | why |
|---|---|---|---|
| `behemoth` | Brilliant Behemoth | **Shrapnel Heart** | every attack detonates |
| `clover` | 57 Leaf Clover | **Pressed Clover** | luck; keeps the clover glyph honest |
| `alien-head` | Alien Head | **Cortex Jar** | cooldown reduction; "It is still thinking" |
| `frost-relic` | Frost Relic | **Killing Frost** | ice storm that grows with each kill |
| `ceremonial-dagger` | Ceremonial Dagger | **Mourner's Dagger** | "the dead keep fighting for you" |
| `brainstalks` | Brainstalks | **Whisper Stalks** | "it whispers cooldown numbers at you" |

### Boss / lunar

| id | old | new | why |
|---|---|---|---|
| `titanic-knurl` | Titanic Knurl | **Monolith Knuckle** | health + regen; "a shard of something that used to walk" |
| `planula` | Planula | **Grafted Polyp** | heals when you are hit, symbiotically |
| `queens-gland` | Queen's Gland | **Hive Gland** | releases a swarm |
| `corpse-bloom` | Corpse Bloom | **Charnel Bloom** | heals only on kills, no passive regen |

### Flavour text changed (3, only where the rename made it nonsense)

- `steak` — `'Rare. Very rare.'` was a doneness pun on *Steak*. Now
  `'Salted three winters ago. It has outlasted the man who salted it.'`
- `tri-tip` — `'Three edges, three reasons.'` described the Tri-Tip's blade. Now
  `'One edge, and it never lets the wound close.'`
- `harvesters-scythe` — `'Reap what the Providence sowed.'` was the last
  **Providence** in the codebase. Now `'It takes its cut on the way past.'`

All other flavour lines survive their rename unchanged and were left alone.

### Comments updated in `src/data/items.js`

The glyph-authoring block names each item beside the shape it draws, and the
`blight` corruption block names the base item each corrupted item derives from —
both are load-bearing documentation, so both were retracked:
`Crowbar`→Pry Bar, `Roll of Pennies`→Bruised Coinpurse, `Predatory Instincts`→Bloodscent,
`Sticky Bomb`→Tar Charge, `Tougher Times`→Dented Buckler, `Titanic Knurl`→Monolith Knuckle,
`Bison Steak`→Cured Haunch, `Afterburner / Wax Quail / Hopoo Feather`→Bailout Thrusters /
Waxed Wing / Hollow Plume, `Berzerker's Pauldron`→Red-Mist Pauldron,
`Gasoline`→Leaking Jerrycan, `Runald's Band`→Hoarfrost Band, `Corpse Bloom`→Charnel Bloom,
and the nine `blight` derivation notes (Spasm Gland, Bloat Cyst, Clouded Eye, Slag Ingot,
Arc Rot, Bile Shell, Gristle Sickle, Rupture Gall, Loaded Knucklebone).
Also the `fuel-cell` design note (`"Fuel Cell is good with equipment"` → `"Dry Cell …"`).

## 2. Enemies — 6 renamed (`src/data/enemies.js`, `name:` field only)

| id | old | new |
|---|---|---|
| `beetle` | Beetle | **Plated Scarab** |
| `lemurian` | Lemurian | **Emberjaw Skink** |
| `wisp` | Wisp | **Guttering Mote** |
| `pest` | Blind Pest | **Blind Shrike** |
| `golem` | Stone Golem | **Basalt Sentinel** |
| `titan` | Stone Titan | **Basalt Colossus** |

`golem`/`titan` deliberately stay a matched pair the way Stone Golem/Stone Titan were.
`Basalt Sentinel` also keeps its existing Logbook blurb ("Quarry stone that stood up")
true without editing it — verified in `reviews/round6/branding/15-logbook.png`.

The Logbook blurb table (`src/ui/Logbook.js:262-282`) is keyed by **id**, so no blurb
needed changing. One comment there ("the Stone Golem at a little over half the panel",
"a Titan's horns clip", "a Titan is four times wider") and one in `enemies.js:96`
("The beetle is the first thing anyone meets") were retracked.

## 3. Difficulty rungs

| old | new | files |
|---|---|---|
| Drizzle | **Overcast** | `data/artifacts.js:172`, `ui/Menus.js:53` |
| Rainstorm | **Downpour** | `data/artifacts.js:186`, `ui/Menus.js:54` |
| Monsoon | **Deluge** | `data/artifacts.js:199`, `ui/Menus.js:55` |

Weather ladder kept, because the game is called Petrichor and the rungs' icons and
`color` fields are rain glyphs. The ascending severity reads the same.
The `artifacts.js` design comment (the coeff table and the two paragraphs naming
Rainstorm as the 1.0 baseline) and the `Progression.js:182-183` reference were
retracked with it.

**The `18-difficulty` harness assertion does not match on the rung string.**
The ledger predicted it would; it does not. `Harness.js:3982-3993` asserts on
`menus.screen`, `[data-difficulty]` element count and `[data-difficulty].is-on` —
all id- and DOM-keyed. The only occurrences of the rung words in `Harness.js` were
in the prose comment at :160-164 describing the old assertion bug, which was retracked
anyway. `18-difficulty` passes, and the shot shows OVERCAST / DOWNPOUR / DELUGE
(`reviews/round6/branding/18-difficulty.png`).

## 4. World nouns

| old | new | where |
|---|---|---|
| Newt Altar | **Tithe Altar** | `data/realms.js:222` (the `name:`), plus comments at `world/realms/Realms.js:48,122` and `systems/Progression.js:352` |
| Rallypoint Ferrous | **Ferrous Muster** | `world/Materials.js:1282` biome `names[0]`, plus the section comment at `Materials.js:1274`, `world/Props.js:1406`, `core/Harness.js:81` |
| Providence | — removed | `data/items.js` `harvesters-scythe` flavour (see §1) |

`Tithe Altar` names the mechanic it actually is — gold paid up front to arm a
market portal — and sits beside its siblings Trial Obelisk and Gilded Beacon.
`Ferrous Muster` keeps the biome's iron register beside `Ironsilt Reach` and
`The Sunken Yard`.

`Shrine of Chance` was **already renamed** before this pass; `world/Interactables.js:552`
now only carries a comment explaining the rename, and `systems/Items.js:61`'s stale
lowercase `shrine of chance` is now `wager shrine`.

`Teleporter` left alone, per the ledger.

## 5. The `Menus.js` run-summary fix (unrelated finding from `AUDIT-f9b47c4.md`)

`src/ui/Menus.js:1200` read
`won ? ['Time to the Fracture', stats.time] : ['Items collected', stats.itemCount]`.
`stats.time` is the exact value already printed one tile earlier as `Time survived`,
so a won run showed one number under two names — and under a name for a place the
*death* screen's player never reaches, on the one screen where the two are compared.

There is no separate fracture clock in `stats` (`HUD.onDeath` supplies
`time, stage, stageName, level, kills, damage, itemCount, difficulty, items`), so the
fix is not to invent one. The sixth tile is now `Items collected` on **both**
outcomes, and the item list's heading below reverted from `Items Collected — N` to
plain `Items Collected` — so the count also appears exactly once. The stat grid is
`repeat(3, 1fr)`, so six tiles still fill 2×3 with no hole; verified in
`reviews/round6/branding/16-run-summary.png`.

---

## Left alone on purpose — decisions someone else has to make

### The two infringing `id` values (need a save migration)

- **`hopoo-feather`** — display name is now `Hollow Plume`, id unchanged.
- **`shatterspleen`** — display name is now `Hoarfrost Band`, id unchanged.
  Note this id is *doubly* wrong: `shatterspleen` and the old name `Runald's Band`
  are two different RoR2 items.

Both ids are keys into save data, `UNLOCK_BINDINGS` and the golden RNG hashes.
They do not render anywhere, but they ship in the bundle as string literals. Changing
them requires a save migration and a golden-hash re-baseline; that is a separate job.
`shatterspleen`'s hook also uses the cooldown key `'runald'` (`items.js:610`), which is
internal state and is in the same bucket.

### Difficulty `id` and `mark` values

`'drizzle' / 'rainstorm' / 'monsoon'` remain as `id` and `mark` on the difficulty
cards (`artifacts.js:171,177,185,190,198,204` and `Menus.js:53-55`). They are never
displayed — `mark` selects a glyph, `id` is the profile's stored selection — but they
are the same class of literal as the two item ids above and carry the same
stored-selection risk. Same decision, same migration.

### Files outside this task's ownership that still carry a mark (comments only)

- `src/systems/Director.js:30,204,206` — `// Rainstorm`, `// Drizzle/Rainstorm/Monsoon`.
- `src/data/equipment.js:12,33` — `Fuel Cell` in the cooldown docs.
- `src/entities/Player.js:746` — `Hardlight Afterburner`.
- `src/systems/Combat.js:368` — `Tougher Times: a full negate`.
- `tools/capture-realms.mjs:46` — `Newt Altar` inside a scenario `doc:` string, which
  **does** ship into that tool's manifest as caption text. Worth fixing.
- `tools/realmprobe.mjs:9,102` — `Newt Altar` / `'newt altar arms the market'` in a
  probe step label.

All are one-line text edits. None affects behaviour; the `capture-realms.mjs` doc is
the only one that reaches an output artifact.

## Verification

1. `node node_modules/vite/bin/vite.js build` — clean (no `npx`, per the constraint).
2. `node tools/capture.mjs --out reviews/round6/branding --port 5220` — 21 shots,
   4 errors, failing set identical to `merged3` (table at top).
3. After each of the three rename steps, `grep` across all of `src/` and `tools/` for
   the old strings. The only survivors are the out-of-ownership comments listed above.
4. `node --check` on all 14 owned files — all parse.

### One caveat on the capture, stated plainly

The passing capture is timestamped 20:06:39. Two later things happened:

- I made **comment-only** edits after it (`enemies.js:96`, three in `Logbook.js`).
  No executable text changed; the shots are unaffected.
- A second confirmation run at 20:09 **failed to boot** with
  `Unexpected identifier 'createParticleMaterial'`. That is the parallel agent's
  in-flight edit to `src/shaders/ParticleShader.js` / `src/systems/VFX.js`, which I do
  not own and did not touch (`git status` shows both modified by them). The failed run
  wrote `reviews/round6/branding/00-FAILED-TO-BOOT.png` and
  `manifest.FAILED.json` and left `manifest.json` and the 21 PNGs from the good run
  intact — both artifacts are still on disk as evidence. Re-run the capture once the
  VFX agent's tree parses.
