# The RoR2 id layer, removed

Round 6 renamed ~50 verbatim Risk of Rain 2 **display** strings
(`reviews/round6/BRANDING-LEDGER.md`) and deliberately left the **ids** alone,
because an id is written into save data and a rename without a migration is a
save wipe. `reviews/round6/HANDOFF.md` closes with the residue as a standing
hazard: *"~40 code identifiers still carry RoR2 names … ids need a save
migration and a golden-hash re-baseline as one decision."*

This is that decision, executed. Branch `worktree-agent-ad29ac6a5a4473b9b`,
three commits plus this report.

| commit | what |
|---|---|
| `04421d2` | enumeration + rename |
| `21b1033` | save migration, `PROFILE_VERSION` 4, `PROTOCOL_VERSION` 5 |
| `00f8900` | baselines learn to name their own source commit |
| *(this)* | the re-baseline, the gate re-pointing, and this report |

Two of the forty were already gone before this branch started: `hopoo-feather`
and `shatterspleen` went in `3a86486` with the v2→v3 profile migration that this
work extends. Everything else was still in the tree.

---

## 1. The enumeration

Written before anything was renamed. The method was a scan for every quoted
occurrence of every RoR2 proper noun in the ledger's three lists (items,
enemies, difficulties) plus the RoR2 elite-affix and bestiary vocabulary the
ledger did not enumerate, across `src/`, `tests/`, `tools/`, `shotlib/`,
`desktop/` and `index.html`. **50 identifiers, 190 quoted references, 47 files.**

The counts below are the pre-rename scan. Where a row says only `items.js`, all
its references are the card's own definition, its corruption partner's
`corrupts:` field and that partner's `consumes()` call.

### 1a. Items — 37 ids

Every new id is the display name round 6 already gave the card above it.

| old id | display name (round 6) | new id | references |
|---|---|---|---|
| `syringe` | Adrenal Syringe | `adrenal-syringe` | items.js(3), chest-void-credit, corruption-counterplay, corruption-system(2), greed-marks(2), artifactprobe, lootprobe |
| `hoof` | Cloven Hoof | `cloven-hoof` | items.js(1) |
| `steak` | Cured Haunch | `cured-haunch` | items.js(3) |
| `roll-of-pennies` | Bruised Coinpurse | `bruised-coinpurse` | items.js(1) |
| `tougher-times` | Dented Buckler | `dented-buckler` | items.js(1), artifactprobe |
| `armor-plate` | Trauma Plate | `trauma-plate` | items.js(3) |
| `crowbar` | Pry Bar | `pry-bar` | items.js(3), artifactprobe(2) |
| `predatory` | Bloodscent | `bloodscent` | items.js(1) |
| `glasses` | Gunsmith's Loupe | `gunsmiths-loupe` | items.js(3) |
| `sticky-bomb` | Tar Charge | `tar-charge` | items.js(1) |
| `gasoline` | Leaking Jerrycan | `leaking-jerrycan` | items.js(1) |
| `monster-tooth` | Marrow Tooth | `marrow-tooth` | items.js(3) |
| `topaz-brooch` | Amber Clasp | `amber-clasp` | items.js(1) |
| `medkit` | Stitch Kit | `stitch-kit` | items.js(2) |
| `ukulele` | Cracked Zither | `cracked-zither` | items.js(3) |
| `atg` | Missile Rack Mk. I | `missile-rack` | items.js(3) |
| `tri-tip` | Gutting Shiv | `gutting-shiv` | items.js(1) |
| `stun-grenade` | Concussion Charge | `concussion-charge` | items.js(1) |
| `infusion` | Feeding Vial | `feeding-vial` | items.js(1), item-id-migration(3) |
| `harvesters-scythe` | Reaping Hook | `reaping-hook` | items.js(3) |
| `leeching-seed` | Thirsting Burr | `thirsting-burr` | items.js(1) |
| `afterburner` | Bailout Thrusters | `bailout-thrusters` | items.js(1) |
| `wax-quail` | Waxed Wing | `waxed-wing` | items.js(1) |
| `will-o-wisp` | Corpse Flare | `corpse-flare` | items.js(1) |
| `fuel-cell` | Dry Cell | `dry-cell` | items.js(1) |
| `berzerkers-pauldron` | Red-Mist Pauldron | `red-mist-pauldron` | items.js(1) |
| `razor-wire` | Barb Snare | `barb-snare` | items.js(2) |
| `behemoth` | Shrapnel Heart | `shrapnel-heart` | items.js(5), damageTypes.js(1, **unquoted key**), damage-elements |
| `clover` | Pressed Clover | `pressed-clover` | items.js(3 of 6 — see §5) |
| `alien-head` | Cortex Jar | `cortex-jar` | items.js(1) |
| `frost-relic` | Killing Frost | `killing-frost` | items.js(1) |
| `ceremonial-dagger` | Mourner's Dagger | `mourners-dagger` | items.js(1) |
| `brainstalks` | Whisper Stalks | `whisper-stalks` | items.js(1) |
| `titanic-knurl` | Monolith Knuckle | `monolith-knuckle` | items.js(1) |
| `planula` | Grafted Polyp | `grafted-polyp` | items.js(1) |
| `queens-gland` | Hive Gland | `hive-gland` | items.js(1) |
| `corpse-bloom` | Charnel Bloom | `charnel-bloom` | items.js(1) |

Plus the two already done in `3a86486`, carried in the same table:
`hopoo-feather` → `hollow-plume`, `shatterspleen` → `hoarfrost-band`. **39
entries in `RENAMED_ITEM_IDS`.**

### 1b. Enemies — 6 ids

Each id was also the `meshFactory` key, the `EnemyMeshes.PALETTE` key, the
`MESH` map key, and the stem of a `build*`/`anim*` function pair.

| old id | display name (round 6) | new id | references |
|---|---|---|---|
| `beetle` | Plated Scarab | `scarab` | Harness.js, enemies.js(2), EnemyMeshes.js, Director.js, sp-equivalence, voidtouched-affix, voidtouched-director, artifactprobe(4), reckoningprobe, silhouette.mjs |
| `lemurian` | Emberjaw Skink | `skink` | enemies.js(2), EnemyMeshes.js, Director.js, sp-equivalence, silhouette-metrics |
| `wisp` | Guttering Mote | `mote` | enemies.js(3, incl. the Herald's `summon:`), EnemyMeshes.js(2), Director.js, silhouette-metrics |
| `pest` | Blind Shrike | `shrike` | enemies.js(2), EnemyMeshes.js, Director.js, shrike-detonate, silhouette-metrics |
| `golem` | Basalt Sentinel | `sentinel` | Harness.js(3), enemies.js(2), EnemyMeshes.js, Director.js, readability-gate(3), artifactprobe, silhouette-metrics, silhouette.mjs |
| `titan` | Basalt Colossus | `colossus` | enemies.js(2), EnemyMeshes.js, silhouette-metrics |

### 1c. Elite affixes — 3 keys

`ELITE_STATS` already carried original `label`s; the keys were still verbatim
RoR2. New keys are those labels.

| old key | label (round 6) | new key | references |
|---|---|---|---|
| `blazing` | Emberclad | `emberclad` | enemies.js, EnemyMeshes.js(2), VFX.js, branding-display, corruption-system, readability-gate, sp-equivalence(3), affixprobe(2) |
| `overloading` | Galvanic | `galvanic` | enemies.js, branding-display, corruption-artifacts, shield-regen-delay, shrike-detonate, affixprobe(2) |
| `glacial` | Rimebound | `rimebound` | Harness.js, enemies.js(2), Combat.js, branding-display, sp-equivalence, affixprobe |

### 1d. Difficulty rungs — 3 ids

These cards already carried a `mark:` field holding the new word, so the id, the
mark and the display name are now one word each.

| old id | display name (round 6) | new id | references |
|---|---|---|---|
| `drizzle` | Settling | `settling` | artifacts.js, Menus.js, artifactprobe |
| `rainstorm` | Fracture | `fracture` | Harness.js, artifacts.js(2, incl. `DEFAULT_DIFFICULTY`), Menus.js, artifactprobe(2) |
| `monsoon` | Cataclysm | `cataclysm` | Harness.js, artifacts.js, Menus.js, artifactprobe |

### 1e. Realm — 1 id

| old id | display name | new id | references |
|---|---|---|---|
| `bazaar` | The Hollow Market | `market` | realms.js(2), RealmHarness.js(2), RealmProps.js(1) |

Not on the round-6 ledger's world-noun list, but "Bazaar Between Time" is RoR2's
shop realm and the display name was already `The Hollow Market`, so the
id-layer-twin argument applies. Consequences: `realmBazaar` → `realmMarket` on
the harness, `buildBazaar` → `buildMarket`, and the realm capture scenario
`22-realm-bazaar` → `22-realm-market`. The two comments that cite the *existing
file* `reviews/round6/audfix-pre-full/realms/22-realm-bazaar.png` keep the old
name: that PNG is on disk under it.

**Total: 50 ids renamed, 47 files touched in the rename commit.**

---

## 2. What was deliberately left, and why

| left alone | why |
|---|---|
| `molten-core`, `rebar-launcher`, `sentry-drone` | The round-6 ledger lists these as *"borderline, judgment call, listed for completeness rather than flagged"* and left their display names alone. The id-layer-twin rule is "follow the card above you"; these cards did not move, so neither do their ids. |
| `glyph: 'clover'` (items.js:1297, 2148-2149) | An art key in the glyph namespace, not the card's id. The card under it is now `pressed-clover`. It was the one collision where a blanket quoted replace would have been wrong, and it was done by hand. |
| `teleporter` (~90 sites) | The round-6 ledger's own ruling: a generic genre noun, not a distinctive mark. |
| `dustWisp` (ParticleSystem.js) | A particle-atlas frame name. "Dust wisp" is ordinary English and owes nothing to the RoR2 Wisp; the codemod caught it and it was reverted. |
| `ROR2_DISPLAY` in `tests/branding-display.test.mjs` | The set of RoR2 words the display layer must never say. It has to spell them out — it is now the only place in the tree that names them. |
| `RoR2` in comments citing the reference | The ledger's ruling, kept: `VFX.js:19`, `Director.js:1`, `artifacts.js`, `enemies.js`'s Malachite/Celestine note. Citing a reference is not lifting a name. |
| `docs/superpowers/plans/*` | Historical plan records. They describe what was done at the time and are not rewritten. |

---

## 3. The migration

`src/data/renamedItems.js` → `src/data/renamedIds.js`, holding three tables and
three translators. `Profile` and `Artifacts` both need it and neither may import
a content catalogue.

**Where a save carries an id, and what handles it:**

| store | field | handled by |
|---|---|---|
| `telluric.profile.v1` | `unlocks.item` | `MIGRATIONS[3]` → `remapIds({items})` |
| | `encounters.item` | same |
| | `encounters.enemy`, `encounters.boss` | `remapIds({enemies})` |
| | `runs[].inventory[].id` | `remapIds({items})` |
| `telluric.run.v1` | `edict.<tier>` | `Artifacts._load` → `renameItemId` |
| | `difficulty` | `Artifacts._load` → `renameDifficultyId` |

`PROFILE_VERSION` 3 → 4. The v2 and v3 migration entries are now one `remapIds`
differing only in which kinds they carry. The v2 entry therefore translates more
than it did the day it was written; that is deliberate and idempotent, and what
matters is that no chain reaches v4 holding an old id.

**The difficulty rung was the one that failed quietly.** `Artifacts._load`
validates against `DIFFICULTY_BY_ID` and *silently* substitutes the default for
anything it does not recognise. Without a translation, a returning player's
Cataclysm run would have started on Fracture with nothing said. It is now
translated before it is validated.

**Both storage paths land on the same code.** In the browser `localStorage` is
the store. Under the Electron shell `DesktopStore.initDesktopStore` copies
`save.json` into `localStorage` at boot (`48d75f0`, `e4079c8`) and every read
afterwards is the same read. There is one hydrate point and the migration sits
behind it, so no desktop-specific migration exists or is needed.

**What needed no table:** elite affix keys reach no save (`ELITE_STATS` keys
live in entity state and probe output; the profile counts elites, it does not
name them) and realm ids reach no persisted field. The per-survivor career table
is keyed by survivor id and no survivor was renamed.

### 3a. Migration test evidence

`tests/item-id-migration.test.mjs`, 63 assertions → **189, all passing**. It
covers all six stores, from both a v2 and a v3 fixture, and keeps the existing
merge / idempotence / junk-blob arms.

The fixture carries an old id in every one of the six places and an untouched id
alongside each, so "nothing was dropped" and "nothing extra was touched" are
both checked. Row counts are asserted, not just contents: three unlocks in,
three out; three inventory rows in, three out.

**Four negative controls, run against file copies so the tree is never left
mutated** (`reviews/round7/migration-negative-controls.mjs`):

```
CAUGHT   12 failures  enemy kinds dropped from the v3 migration
CAUGHT    1 failures  one item table entry deleted
CAUGHT    1 failures  difficulty translation removed from the store
CAUGHT   23 failures  item translation stubbed to the identity
```

None is silent. The first run of this exercise reported a false "0 failures" on
the second arm because a `git checkout` used to undo it had reverted unrelated
edits and the test was crashing on an unresolvable import rather than passing —
the arms above are the re-run after that was found and the test hardened to
report rather than throw on a broken build.

---

## 4. Protocol

**`PROTOCOL_VERSION` 4 → 5.** Not for a layout change — for the reason the 4
bump was made, which that file states as *"the number, not the bytes"*.

- **Ids that cross as strings, and therefore matter.** The events channel is
  reliable JSON and `NetHost` forwards `itemPickup` (item id) and
  `realmEnter`/`realmExit` (realm id). A 4-with-old-ids peer paired with a
  4-with-new-ids peer reads every byte correctly and then acts on a name the
  other end has never heard of: the wrong pickup, the wrong room, and every
  mechanism that would have complained satisfied. That is the silently-wrong
  session `PROTOCOL_VERSION` exists to refuse, and both ends already refuse a
  mismatch out loud via `MSG.REFUSE`.
- **Ids that cross as an index, and therefore do not.** An entity's `typeId` is
  its position in `ENEMIES` (`enemies.js:1293`), so renaming six enemy ids moved
  no wire byte. `WELCOME`'s difficulty is `DIFFICULTIES` index, not the rung id
  (`Artifacts.netPack`). Neither contributed to the bump.

`NETCODE.md` now states the layout-**or**-vocabulary rule, so the next bump does
not have to re-derive it.

---

## 5. The re-baseline

**Baseline name: `reviews/round7/baseline-00f8900.json` and
`reviews/round7/elite-baseline-00f8900.json`.** Both name their source commit
`00f89006620aa17bba4c09cecb1537bea96fc67f` in a `source` block inside the file,
alongside the tool, the mode, the seed, the dirty flag and the capture time.
(Correction from review F1: the elite baseline reads `dirty: true` — the first
capture had just written `baseline-00f8900.json` as an untracked file, which the
second capture's `git status` saw. No source change was involved; the
`rebaseline-proof.mjs` run's 251 explained fields stand.)
`00f8900` also added that block to the instrument, so this is the first pair of
baselines in the repo that carry their own provenance rather than relying on a
filename.

`npm run gate:elite` and `tools/juiceprobe.mjs` now point at them. The round-8
baselines stay on disk as history.

**Why a re-baseline at all, and why it is not a laundered regression.** Both
gates are keyed by id in places — `damageToPlayerBySource.<id>`,
`arms.<affix>@<metres>`, `sourceKeys.<card>+<affix>` — so a rename moves the
keys and nothing else. That claim is not asserted, it is measured:

```
$ node reviews/round7/rebaseline-proof.mjs
fingerprint gate: 52 fields, 0 moved after re-keying the old baseline
elite gate: 199 fields, 0 moved after re-keying the old baseline

PROVEN: every number in both baselines is byte-identical once the ids are translated.
```

The script (committed at `reviews/round7/rebaseline-proof.mjs`, output at
`rebaseline-proof.txt`) applies the rename map to the **old** round-8 baselines
and deep-compares against the **new** captures over exactly the fields each gate
reads. 251 fields, zero unexplained. A re-baseline that hides a regression
cannot produce that result.

The pre-capture `--compare` run against the round-8 fingerprint said the same
thing directly, and it is worth quoting because it is the entire safety argument
for the rename in two lines:

```
SINGLE-PLAYER MOVED vs reviews/round8/baseline-HEAD.json — 2 field(s):
  damageToPlayerBySource.lemurian   baseline: 21    now: undefined
  damageToPlayerBySource.skink      baseline: undefined   now: 21
```

One key, one name, the same 21.

**Why the rename could not have moved a draw.** `rollItem` is
`rng.pick(ITEMS_BY_TIER[tier]).id` — a positional draw from an array built in
source order — so a card's id has no bearing on which slot it occupies. The
migration test pins those slots (`ITEMS.length === 108`, Hoarfrost Band 5th
uncommon, Hollow Plume 11th), so if a future edit reorders `ITEMS` the test
fails and these baselines are correctly put back in question. No `ctx.rng` or
`ctx.fxRng` draw site was touched.

### 5a. The readability record

`reviews/round9/readability-gate.json` was **re-keyed, not re-measured**, and
says so in a `rekeyed` block it now carries. A silhouette is not a function of
its id, so every measured number is still the one its `commit` field
(`8ff3eb4`) produced; only the stored verdicts were re-derived from those same
numbers, which re-orders them under the new ids. `gradeRoster` is pure
arithmetic over the stored units — the test that reads it says so — so this
needed no GPU and invented nothing.

---

## 6. Verification

| gate | result |
|---|---|
| `node tests/run.mjs` | **46/46 files pass** |
| `node tests/item-id-migration.test.mjs` | **189 passed, 0 failed** |
| `node node_modules/vite/bin/vite.js build` | green |
| `node tests/sp-equivalence.mjs --compare reviews/round7/baseline-00f8900.json` | *single-player unchanged — no fields moved* |
| `npm run gate:elite` (new baseline) | *elite damage unchanged — no fields moved* |
| `reviews/round7/rebaseline-proof.mjs` | 251 fields, 0 unexplained |

Three test files failed mid-rename and were fixed rather than adjusted around:

1. `branding-display` — the codemod rewrote the `ROR2_DISPLAY` set itself, which
   is the one place that must keep the RoR2 words. Reverted, and the file's
   header no longer claims ids are out of scope.
2. `damage-elements` — `behemoth: 'blast'` in `damageTypes.js` is an *unquoted*
   object key and the quoted-literal rule for items missed it. It was the only
   one; a whole-word sweep for the fifteen single-word item ids confirmed that.
3. `readability-gate` — the record, per §5a.

**One environmental note for the next agent:** `tests/sp-equivalence.mjs` timed
out at its 60 s stage wait on the *first* invocation after a cold vite cache,
three times, and passed on the immediate retry every time. It is a cold-start
cost, not a flake in the gate — an identical launch (headed, `--use-angle=d3d11`,
offscreen, port 5209) booted in seconds once warm. Run it twice before believing
a timeout.
