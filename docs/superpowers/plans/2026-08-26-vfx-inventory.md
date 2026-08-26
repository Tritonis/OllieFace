# VFX/SFX inventory and geometry adoption (batch 2, plan-2026-08-25)

Full inventory of the player-facing effect surface as of the 212-entry showcase
(`src/core/Showcase.js`), organised by source, plus the adoption of the four
"unadopted geometry demos" (#149/#151 vocabulary wave, `docs/superpowers/plans/2026-08-23-new-vfx-geometries.md`)
into real gameplay. Every count below is re-derived from the same tables
`Showcase.js` iterates (`tests/showcase-surface.test.mjs` holds the total to
212); nothing here is typed by hand and not cross-checked against the tree.

Visual primitives are named as the engine spells them in `src/systems/VFX.js`:
`ring`/`rings` (expanding/contracting instanced rings), `beam`/`beams` (tapered
additive segments — a "line"), `missile`/`streak` (a travelling projectile
trail), `particles`/lace (per-particle emission), `hitSpark`/`radial-spark`
(a burst at a point), `lattice` (a mesh-shell figure), `sector` (a ground
wedge, G-1), `helix`/`vortex` (a spiral lace, G-2/G-3), `chain` (a jagged
multi-hop path, G-4).

## 1. Survivor abilities — 20 entries

Table: `src/data/abilities.js:341` (`export const ABILITIES`), one row per of
five survivors' four slots (M1/M2/utility/special). Each entry declares its
own `shape` field, read by nothing except `EFFECT-LANGUAGE.md`'s audit and
this inventory — the actual draw calls live in each `fire()` body.

| Survivor | Ability | shape | file:line | Audio |
|---|---|---|---|---|
| Ranger | Double Tap (M1) | line | abilities.js:349 | `ctx.audio?.shoot` |
| Ranger | Phase Round (M2) | line | abilities.js:377 | shoot |
| Ranger | Tactical Dive (util) | line | abilities.js:404 | footstep/dash |
| Ranger | Salvo (special) | streak | abilities.js:426 | ability |
| Anvil | Sweep (M1) | ring | abilities.js:482 | hit |
| Anvil | Slam (M2) | ring | abilities.js:541 | explosion |
| Anvil | Breach (util) | line | abilities.js:614 | shoot |
| Anvil | Bulwark (special) | ring | abilities.js:677 | ability |
| Kestrel | Mark (M1) | line | abilities.js:734 | shoot |
| Kestrel | Lance (M2) | charged-line | abilities.js:769 | charge/shoot |
| Kestrel | Vault (util) | line | abilities.js:824 | dash |
| Kestrel | Eclipse (special) | charged-line | abilities.js:876 | ability |
| Rook | Rivet (M1) | line | abilities.js:932 | shoot |
| Rook | Mines (M2) | streak | abilities.js:957 | shoot |
| Rook | Ward (util) | lattice | abilities.js:1008 | ability |
| Rook | Turret (special) | lattice | abilities.js:1049 | ability |
| Cinder | Stoke (M1) | streak-cone | abilities.js:1117 | shoot |
| Cinder | Pyre Flask (M2) | streak | abilities.js:1190 | shoot + explosion |
| Cinder | Backdraft (util) | streak-cone | abilities.js:1265 | ability |
| Cinder | Conflagration (special) | ring | abilities.js:1333 | ability |

All 20 speak through the shared `Audio` bus's procedural voices (`shoot`,
`hit`, `explosion`, `ability`) rather than the element-recipe/envelope table —
abilities predate the Effect Language's `cue()` and were never migrated onto
it (see gap list).

## 2. Equipment — 14 entries

Table: `src/data/equipment.js:81` (`export const EQUIPMENT`). Every active
speaks through `EQUIPMENT_EFFECTS` (`src/data/effects.js:395`) via the local
`speak()` helper (`equipment.js:54`), so audio is uniformly the Effect
Language's element/envelope pair — the one gameplay surface where every row
has been through the same audit.

| Equipment | frame (audit) | file:line (def / effects row) |
|---|---|---|
| Blink Anchor | (no row — teleport, no damage) | equipment.js:83 |
| Mending Flare | radial-spark·rising (C5) | equipment.js:125 / effects.js:401 |
| Thermal Lance | line | equipment.js:153 / effects.js:396 |
| Gravity Snare | ring·contracting | equipment.js:173 / effects.js:397 |
| Sentry Drone | (seeking-strike, own line) | equipment.js:221 |
| Overload Cell | ring·expanding, heavy | equipment.js:238 / effects.js:398 |
| Frostbite Canister | ring·expanding | equipment.js:261 / effects.js:399 |
| Combat Stim | (buff, no figure) | equipment.js:281 |
| Phase Veil | (i-frame buff) | equipment.js:296 |
| Spirit Lantern | (held ally-facing) | equipment.js:314 |
| Meteor Beacon | (bespoke sky drop, `_sky` streak) | equipment.js:328 |
| Tesla Crown | beam (`shape:'beam'`), chain lightning | equipment.js:349 |
| Recall Beacon | (marker/heal, no row) | equipment.js:369 |
| Aegis Emitter | lattice·rising | equipment.js:426 / effects.js:400 |

`gravity-snare` and `tesla-crown` are the two adopted this batch (§5).

## 3. Item combat hooks — 116 items, 78 hook entries

Table: `src/data/items.js` `export const ITEMS` (116 rows). Hook counts by
kind (`onHit`/`onKill`/`onDamaged`/`onInterval`, `Showcase.js:196`):
onHit 30, onKill 25, onDamaged 11, onInterval 12 — 78 total.

Visuals split three ways, all cited off `src/data/effects.js`:

- **13 named-promise figures** (`FIGURES`, effects.js:428) — bespoke
  multi-call draws (rings, beams, bursts) authored per item, e.g.
  `chime-of-absolution` (two rings, effects.js:430), `molten-core`
  (`explosion` + ring, effects.js:478).
- **~46 floor-only procs** (§1d, effects.js:284) — a single `radial-spark`
  (`hitSpark`) in the item's element at tick intensity, nothing more. This is
  the largest single bucket in the game and it is intentionally minimal
  (§4.2's proc-grammar floor).
- **The rest** (C1's shock arcs, C2 rings, C3 lines/streaks, chain-lightning
  callers) draw through `ITEM_EFFECTS` rows (effects.js:250-282) whose
  `frame` is read only for the bucketing audit — the actual figure for most
  of these is drawn inline in the item's own hook via `chainLightning()`
  (items.js:173) or `seekingStrike()` (items.js:201), not through `cue()`.

Audio: every hook that calls `cue(api, id, ...)` (effects.js:544) speaks
through the element/envelope voice table (`RECIPES`/`ENVELOPES`,
effects.js:128/181), with a sampled override for the seven `#148` ids
(`SAMPLES`, `src/data/samples.js`).

## 4. Enemy attacks — 52 attacks across all spawn + boss cards

Table: `SPAWN_CARDS`/`BOSS_CARDS`, `src/data/enemies.js`. Split by whether the
table gives the attack a `telegraph`/`blast` radius:

- **29 telegraphed** — a ground ring/blast radius, a held element voice for
  the windup, a per-kind tell, an element-cored release (`Showcase.js:232-248`
  documents the shape).
- **23 windup-only (C6, "silent windows")** — melee, charge, summon and dive
  kinds, none of which marks the ground it is aimed at. Deliberate design
  (see gap list — not a target for sector adoption this batch).

Every attack fires through the real `beginAttack` state machine
(`tests/showcase-enemy-attack.test.mjs` holds this open), so the visual and
audio are whatever `Enemy.js`'s attack pipeline actually draws, not a
showcase stand-in.

## 5. Elite modifiers — 6 entries

Table: `ELITE_STATS`, `src/data/enemies.js` (Showcase.js:343). Each is a tint
+ aura (three drain affixes, forced through one `fixedUpdate` tick via
`forceAuraTick`, Showcase.js:91) plus a death signature (three corpse-nova
affixes, fired through a real killing blow). `tests/showcase-elite-tick.test.mjs`
holds the aura tick to landing real damage.

## 6. Pickups — 9 entries (one per tier)

Table: `TIERS`, `src/data/items.js`. `itemPickupBurst` (a burst + tier-colour
ring) plus the pickup jingle through Audio's inventory watcher.

## 7. Sampled voices — 7 entries (#148)

Table: `SAMPLES`, `src/data/samples.js`. Audio-only by construction — no
visual primitive of their own; they replace the procedural recipe for the
seven ids `SAMPLES_BY_ID` names, elsewhere paired with whatever visual that
id's row already draws.

## 8. Run-level moments — 22 entries

Not table-driven (`Showcase.js:389`): 15 named one-offs (level up, teleporter
aura, boss horn, stage sting, shield break, downed/revived, coin, the three
purity moments, temper, kill signature, damage number) plus 7 status-applied
voices (`STATUS_VOICE`, `src/data/elementVoice.js`).

## 9. Geometry demos — 4 entries, all now adopted

Table: `GEOMETRY_DEMOS`, `src/data/effects.js:98`. `sector`, `helix`, `vortex`,
`chain` — see §10 for what wired each into a real effect.

---

## 10. Adoption (this batch)

The four geometries added 2026-08-23 as vocabulary
(`docs/superpowers/plans/2026-08-23-new-vfx-geometries.md`) had no gameplay
adopter — `VFX.js:2632`'s own doc comment names this as "the user's design
call, not this layer's." Each is adopted below where it makes a real effect
more legible, not everywhere it could technically fit.

- **chain (G-4) -> three of `chainLightning()`'s eight callers.**
  `chainLightning()` (items.js:173) has eight call sites in total:
  `cracked-zither` (items.js:1140), `overcharge-cell` (items.js:1397) and
  Tesla Crown (equipment.js:360) now pass `frame: 'chain'` — the roster's only
  effects literally named "chain lightning." `arc-capacitor` (items.js:1595)
  passes an explicit `frame: 'radial-spark'`, a deliberate pre-existing choice
  (a charged hit that shatters at each target, not a travelling arc) and not a
  default-frame oversight. The remaining three — `arc-rot` (items.js:459),
  `quicksilver-vein` (items.js:600) and `tempered-capacitor` (items.js:690) —
  are left on the default `'line'` frame: each already carries its own C1
  colour/envelope separation (toxic, physical, and shock-with-a-different-
  envelope-from-copper-wire, respectively) and forcing all of them onto one
  geometry would undo that separation rather than clarify anything. Before
  this batch, `chainLightning()` drew every bounce as its own disjoint
  straight beam — the "dashed line of disconnected sparks" `chainBolt`'s own
  doc comment (VFX.js:2735) names as the failure a contiguous jagged path
  fixes. The new option collects the resolved bounce path (only knowable
  after `nearestHostile` has walked it) and draws it as one `chainBolt` call.
  **`copper-wire`** (items.js:956) is the eighth candidate and stays
  unadopted: its call is hardcoded to `bounces = 1` (the description caps it
  at "1 nearby enemy" and never scales with stacks), so a chain-frame draw
  there is a single two-point path — `chainBolt`'s defining feature, multiple
  contiguous hops, never shows up. Adopting it would only jitter one straight
  beam into one jagged one on the cheapest common item in the game, not
  demonstrate the geometry it exists to sell.
- **sector (G-1) -> Cinder's Stoke (`cinderStoke`, abilities.js:1115).** Stoke
  is a facing-locked ~48-degree cone fired as a continuous wash — exactly
  G-1's "ground arc with a facing and an aperture." Its own comment
  (abilities.js:1145) already named the gap: "a spray of short beams down the
  axis" gives the cone depth along the aim ray but never marked its width
  across the ground, so a target standing at the aperture's edge had no way
  to see they were inside it. A `sectorTelegraph` call at the player's feet,
  using the same `_dir`/`half`/`range` the damage query itself uses, now
  pulses with the 0.30s stream.
- **helix (G-2) -> Mending Flare (`mending-flare`, equipment.js:125).** The
  one heal in the game big enough (50% max health, one press) to earn a
  figure beyond the shared `healPop` number: a helix rises off the survivor
  at the moment of the burst, restorative-element, reading as something
  climbing rather than the flat sting a `hitSpark` scale-up gives every other
  heal.
- **vortex (G-3) -> Gravity Snare (`gravity-snare`, equipment.js:173).** The
  snare's two contracting rings say how far the pull reaches but never which
  way — a ring is a boundary, not a direction. `vortexDraw`'s "the same lace,
  falling inward" is exactly the missing half; it is the first place in the
  game a gravity well is drawn rather than merely implied by two rings
  closing.

Tests: `tests/vfx-geometries.test.mjs`'s new "2026-08-26: the four demos get
adopted" section drives each of the four through its real function
(`chainLightning`, `ABILITIES.cinderStoke.fire`, and the two
`EQUIPMENT_BY_ID.get(...).use`) with a spy `ctx.vfx`, asserting the new
geometry method is actually called with the effect's real position/facing/
path. Each assertion was confirmed to fail (`git stash` on the three source
files, rerun, all four groups red) before being restored green — the guard
demonstrably can fail, not merely hasn't yet.

---

## 11. Gap list

Effects that are audio-only, visual-only, or visibly weaker than their
gameplay significance. One line each, for the atmosphere-VFX pass this
inventory is meant to seed.

- **The 46-entry §1d floor (effects.js:284)** is the largest bucket in the
  game and the flattest: every one of those procs is the same `hitSpark`
  radius-scaled by intensity step. Deliberate as a floor, but it means almost
  a third of all item procs are visually indistinguishable from each other
  except by colour.
- **23 silent (C6) enemy-attack windows** (enemies.js, melee/charge/summon/dive
  kinds) mark nothing on the ground at all — by design (an untelegraphed
  threat is the point of those kinds), but it means nearly half the enemy
  attack surface gives a player no visual read before it lands, which is a
  much bigger asymmetry than "telegraphed vs. not" sounds like.
- **Sampled voices (#148) are audio-only additions** — none of the seven ids
  gained a visual companion when the samples were recorded; they ride on
  whatever that id's row already drew, so the *upgrade* from #148 is
  inaudible to a deaf reading of the same effect.
- **Abilities never migrated onto the Effect Language's element/envelope
  table** (§1) — all 20 speak through the older shared `shoot`/`hit`/
  `explosion`/`ability` voices, so the survivor kit is the one surface the
  §1.1-§1.4 audit (`tools/bucket-effects.mjs`) cannot see into at all.
- **Recall Beacon, Blink Anchor, Combat Stim, Phase Veil, Spirit Lantern**
  (equipment.js) carry no `EQUIPMENT_EFFECTS` row — five of fourteen actives,
  over a third of the tier, are outside the one audited surface in the game.
- **`scrapfly-hive`** is the sole `TABLE_EXEMPT` id (effects.js:513): a
  five-strike bespoke sequence at a literal, undeclared hue (`0xc8d86a`) that
  sits outside `ELEMENTS` entirely — the one player-facing colour in the game
  not walked by `assertLanguage()`.
- **Melee `arc` fields (enemies.js, e.g. `arc: 1.4` at enemies.js:83) drive
  hit detection but no visual** — the swing's angular width is real gameplay
  data with no on-screen expression; `sectorTelegraph` could show it, but
  doing so for every melee mob would remove the "un-telegraphed" property
  those attacks are designed around (see the C6 gap above), so it stays a
  design decision for whoever owns that tradeoff, not a VFX gap to close
  blindly.
- **`chainLightning`'s three remaining default-`'line'` callers** (Arc Rot,
  Quicksilver Vein, Tempered Capacitor — `arc-capacitor`'s `radial-spark` is a
  separate, deliberate choice, not this bucket) still draw disjoint per-bounce
  beams — correct per C1 (each already carries its own colour/envelope
  separation), but worth a second look once C1's separation is revisited,
  since the jagged chain reads better than a straight beam for *any*
  multi-hop effect with more than one bounce, not only the ones currently
  wired to it. `copper-wire`'s single-bounce call is excluded from that
  future look for the reason given in §10: one hop shows nothing `chainBolt`
  is for.
