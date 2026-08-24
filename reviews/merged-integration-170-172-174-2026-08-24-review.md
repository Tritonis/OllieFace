# Whole-batch integration review — merged master `2f723ad..f14540b`

Date: 2026-08-24
Tree: `C:\Users\tpzap\source\repos\OllieFace` (main tree, master, read-only for code)
Lanes merged: #174 (`33cd5e4`), #172 (`9ee3cd5`), #170 (`f14540b`)
Scope: cross-lane interaction on the merged result only. Per-lane review is not re-run.

## Verdicts

- **SPEC — REFUTED.** Two reproducible failures of claims made in the merged code:
  (M1) the salvage outcome banks a flat pure commitment for an act that provably moves
  nothing, which defeats the tolerance the alignment partition is built on and
  irreversibly closes a capstone in two presses; (m3) `_placeBargain`'s stated
  guarantee that a surfaced altar "stands in the same spot" as a populated one is
  false on the landmark-less path, demonstrated below.
- **QUALITY — NOT READY.** One Major. Everything else is minor or clean.

Counts: **0 Critical, 1 Major, 5 minor.**

## Commands run (on the merged tree)

| Command | Result |
|---|---|
| `npm test` | exit 0 — **161/161 test files passed** |
| `npm run gates:cheap -- --quiet` | exit 0 — **3/3 arms** (test 89.0s, build 1.7s, audit 1.6s, 1 allowlisted advisory) |
| cross-lane probe A (scratchpad `xlane.mjs`) | real `Items` + real `Corruption` on one bus; arms A/A2/A3/B/B2/C/D/E/F |
| cross-lane probe B (scratchpad `xlane2.mjs`) | arms C2/C3/C4/D2/E2 |
| placement-drift probe (inline `node --input-type=module`) | reproduces m3 |

`npm run probe:coop` **not run**, deliberately. Nothing in the range touches signalling,
formation, or connection lifecycle. The only net-adjacent surfaces are (a) the additive
`safe` field on the `itemPickup` payload, which is written host-side in `Items._set` and
never read by the client mirror (`Items.js:437-451` reads `id`/`count`/`owner` only), and
(b) the mid-stage prop add, which rides the existing per-snapshot walk of
`ctx.interactables.replicable()` in `NetHost._sendState` (`NetHost.js:787`) rather than any
new message or connection path. Neither is a formation or lifecycle change, so a coop probe
would exercise no new code.

---

## Findings

### MAJOR — M1

**`src/world/itemTransaction.js:141` and `:172`, with `src/data/alignment.js:115`, `:139`**

*Claim:* a salvage press banks the full `salvaged` pure commitment (weight 3) regardless of
whether any corruption was actually warded, and the ledger is monotone, so two no-op presses
permanently flip a fully-committed corrupt run to `mixed` and close `corruptCapstone` forever.

The payoff side is clamped and the commitment side is not:

```js
// itemTransaction.js:141 — clamped to the world that exists
const salvageTaken = Math.min(Math.max(0, cor?.world ?? 0), salvage);
...
// itemTransaction.js:172 — unconditional, never clamped
commitment: commitmentOf('salvaged'),          // weight 3
warding:    commitmentOf('warded', salvageTaken), // weight 0.05 * taken
```

`TOLERANCE.pure` is 3 and the test is strict `>` (`alignment.js:208`), so exactly one salvage
sits *on* the tolerance and holds. Two clear it.

**Reproduction** (`xlane2.mjs` C2/C4, and the inline two-salvage arm):

```
start ledger {"c":24,"p":0} corrupt capstone true
 after salvage#1 {"c":24,"p":3} world 0 align corrupt corruptCapstone true
 after salvage#2 {"c":24,"p":6} world 0 align mixed  corruptCapstone false
 after salvage#3 {"c":24,"p":9} world 0 align mixed  corruptCapstone false
```

Every one of those presses warded **zero** corruption — `world` never leaves 0. The quote
itself says so and is honest about the world half:

```
 world 0 | quote.salvage {"reward":{"itemId":null,"count":0,"warded":0},"corruption":0,
   "ask":16,"commitment":{"source":"salvaged","class":"pure","amount":3},
   "warding":{"source":"warded","class":"pure","amount":0},
   "line":"Salvage Gale Reliquary | -0 corruption warded"}
 resolved: {"corruption":0,"granted":null}
 => zero corruption actually warded, yet +3 pure commitment banked.
```

The mirror case is the same defect pointing the other way:

```
 8 pristine salvages: world 0 ledger {"c":0,"p":24} alignment pure pureCapstone true
```

`CAPSTONE.pure` is 20, so seven declined offers on a Pristine run open the pure capstone on a
run that has never warded a point.

*Why this is a cross-lane finding, not a #174-lane one.* Per-lane review saw `salvaged` in
isolation, where "declining an item costs you the item" reads as adequate payment. On the
merged tree the pristine line is the one the other two lanes push the player toward: #170
puts `blightGrace` at its 0.25 floor below world 27.5, so a non-blight build is strictly
better off scrubbed, and #172 now guarantees an altar at Pristine-with-motes so the purity
purse is spendable there. "Stay clean and decline items" is exactly the play M1 makes free,
and it is the play the alignment ledger's own header (`alignment.js:4-14`) says the ledger
exists to price.

*Reach today.* Not deferred to #171. `Progression._makeRecord` (`Progression.js:819-831`)
spreads `ctx.corruption.ledgerSummary()` into the permanent run record, and `Profile.js:1828`
normalises the `alignment` field, so the flipped verdict is written to the logbook now. The
transaction module is not yet wired to a reward source, so the *exploit* needs #175/#176 —
but the contract they are told to adopt is the one carrying the defect.

*Minimal fix (for the author to adjudicate, not applied):* scale or gate the `salvaged`
weight on `salvageTaken` — e.g. `commitmentOf('salvaged', salvageTaken > 0 ? 1 : 0)`, or make
`salvaged` a `perUnit` source like `warded` — so an act that wards nothing commits nothing.

---

### minor — m1

**`src/world/itemTransaction.js:143-187`** — the quote is silent on the one number #170 made
decision-relevant.

Under #170 the corrupted reward's power is `blightGrace(ctx)` of its printed payoff, floored
at 0.25, while its drawback is charged in full (`items.js:116-121`). At low world a premium
buyer pays real corruption and an explicit debt for a quarter-strength card. Measured
(`xlane.mjs` arm B, one `spasm-gland` after the corrupt feed):

```
quote.corrupt = {"reward":{"itemId":"spasm-gland","count":1,"targeted":true},
                 "corruption":3,"line":"Corrupt into Spasm Gland | +3 corruption ..."}
world after corrupt feed 3   blightGrace 0.250
attackSpeed with 1x spasm-gland = 1.0650   | full-strength would be 1.2600
healthMult drawback (UNSCALED) = 0.8696
=> pays 3 corruption + a corrupt commitment for 25.0% of the card and 100% of its drawback
```

To the brief's question: the quote is **not dishonest** — `reward` names the card, not a power
level, and the catalogue's own `description(n)` is now grace-aware ("+26% attack speed,
scaled by how corrupt the world is ... reduced to 87%, always"). But the quote carries no
description at all, unlike `Items._openMutationChoice`, which ships `blightDescription` on
every offer (`Items.js:863`). An adopting surface (#175/#176) therefore has nothing
grace-aware to print, and the module's own promise that "every clause the ticket requires is a
field, not prose" (`itemTransaction.js:118-122`) does not cover effective power. Recommend
adding the catalogue description (or the live `blightGrace` factor) to `outcomes.corrupt`.

### minor — m2

**`src/world/itemTransaction.js:62-67`** — `corrupt` is a strictly dominated outcome for 91 of
102 non-blight items, and is quoted as a choice.

`corruptRewardFor` falls back to the *same* item when `BLIGHT_BY_BASE` has no counterpart.
Measured (`xlane.mjs` arm B2):

```
safe.reward    {"itemId":"cloven-hoof","count":1,"targeted":false}
corrupt.reward {"itemId":"cloven-hoof","count":1,"targeted":false}  cost 3
corrupt.line : Corrupt into Cloven Hoof | +3 corruption (22 to the next void mark) | ...
=> identical item, 3 corruption, +4 corrupt commitment
items with a blight counterpart: 11 of 102 non-blight items
```

The player pays corruption and a permanent corrupt commitment for a reward identical to the
free one. (Not *literally* nothing — the feed can mint a mark and raises `blightGrace` for
cards already held, and both are quoted in `mint`/`threshold` — but the reward clause offers
no upside.) Either suppress the `corrupt` outcome where `targeted === false`, or have the line
say what is being bought.

### minor — m3

**`src/world/Interactables.js:2803-2833`** — `_placeBargain`'s determinism comment is false on
the landmark-less path.

The comment states: *"Placement is a pure function of (run seed, stage index) ... so an altar
placed at population and an altar surfaced forty seconds later stand in the same spot."*
`_bargainSite.spawn` is the **un-cloned live** `ctx.player.position` (`Interactables.js:2609`:
`const spawn = ctx.player?.position || new THREE.Vector3();`). When `_nearLandmark` returns
null — no landmarks on the stage, or 40 failed samples — `_sited` falls through to
`_point(spawn, brng)` (`:2596-2597`), and `Stage.randomWalkablePoint` rejects candidates by
distance from that live position (`Stage.js:556-560`), so the accepted point depends on where
the player is standing at surface time.

Reproduction (same seed, same stage index, landmark-less fallback):

```
placed at populate time (player at origin):        {"x":-29.98,"z":-28.75}
same seed, player standing ON that spot 40s later: {"x":-2.91, "z":-62.46}
```

`ctx.rng` is genuinely untouched (`brng` is threaded through every call), so sp-equivalence is
unaffected and `gate:sp` is not needed — the defect is the "same spot" promise and the live
reference, not the stream. Clone `spawn` at populate time.

### minor — m4

**`src/world/itemTransaction.js:82`** — the quote's threshold clause is not per-owner, though
the module's attribution guarantee (`itemTransaction.js:46-49`) enumerates feed/bleed/grant/
`ownerPawn` as if it were.

`thresholdOf` reads `ctx?.items?.nextTollBand?.()` — the viewer's singleton — rather than
`Items.of(ctx, owner).nextTollBand()`. Measured (`xlane.mjs` arm F, a remote pawn whose
satellite has `_mutePeak = 9`):

```
owner is remote? true | threshold.tollBand 2 | remote.nextTollBand() 10 | ctx.items.nextTollBand() 2
```

A teammate's quote therefore computes `mutates` against the host's toll history. Harmless
today (nothing opens an offer for a remote pawn yet) and it is a display-only clause, but it
is the one hop the module's own guarantee misses.

### minor — m5

**`src/data/items.js:113`** — doc drift. The comment says *"`Items.update` does that by
watching this value"*; the watch is in `Items.fixedUpdate` (`Items.js:1986-1987`) and `Items`
has no `update` method.

---

## Cross-lane interactions verified clean

Listed because the brief named them; each was exercised, not read.

**2 — the `safe` flag survives every hop on the merged tree.** Traced with real `Items` +
real `Corruption` on one bus (`xlane.mjs` A/A2/A3):

- `itemTransaction.grant` → `spawnOrb(pos, id, arc, pawn, {safe:true})` → `ItemOrb.giveOpts`
  (`Interactables.js:2411-2418`) → `Items.of(ctx, orb.recipient()).give(id, 1, orb.giveOpts)`
  (`:2898`) → `_set(..., opts)` → `payload.safe = true` (`Items.js:696-697`) → Corruption's
  bypass (`Corruption.js:134`). Result: `count 1, world 0`.
- through `give`'s blight-intercept branch (blight card already held, `Items.js:651-654`):
  `world before 8 after 8`.
- through `_settleBlight` (base held, blight card claimed safe): `world before 3 after 3`,
  base driven to 0, blight stack 4. The re-stack rides `reason:'corrupt'`, already ignored.

**All 12 pre-existing `spawnOrb` call sites pass at most 4 positional args** (`Progression.js:749`,
`Interactables.js:422/618/830/1167/1271`, `FinalBoss.js:246`, `RealmProps.js:329/408/598`,
`Realms.js:668`), and the 5th parameter defaults to `null`, so no legacy orb grows a `safe`
flag from #174's signature change.

**3 — no feed path escapes the `_blightGrace` watch.** #174's corrupt path grants an item, so
`_set` sets `_dirty` on the same tick; #174's salvage path writes no inventory, so the block
is stale for at most one fixed step and `Items.fixedUpdate` (`Items.js:1986`) rebuilds it —
measured: attackSpeed 1.2600 immediately after a salvage bleed (stale), 1.2411 after one
`fixedUpdate`. That is the same one-step latency every pre-existing bleed (Argent Font,
Voidtouched kill) already had, not a new hole. Quantisation to 1/1000 is a world delta of
0.11, far below any real feed. The mutation drain (`:1970-1973`) writes only `'corrupt'`
pickups, which cannot re-enter the feed.

**4 — merged `Interactables.js` is coherent.** Read the merged regions, not the diffs. The
guaranteed-block body moved wholesale into `_placeBargain`; there is no shadowed or duplicated
placement path. Dedup is doubled — `_bargainSite = null` before any work, plus
`list.some(i => i instanceof VoidBargain)` — and `clear()` nulls `_bargainSite` so a torn-down
stage cannot surface an altar into the next one. `_surfaceBargain()` runs before the list loop
in `update` (`:2972`), so a same-frame altar gets its first `update`. `_placeBargain` threads
the salted `brng` through `_sited` → `_nearLandmark`/`_point`, so `ctx.rng` is untouched and
#172's "zero ctx.rng impact" claim holds. The three lanes' edits (`signal()` motes branch
:2031-2038, `grantSynergy` :2198-2204, `spawnOrb` :2877, `_placeBargain` :2814) are disjoint
regions.

**Mid-stage altar replicates to clients.** `NetHost._sendState` walks
`ctx.interactables.replicable()` — which returns the live `this.list` (`:2953`) — on every
snapshot, not once at stage start. `_surfaceBargain` is host-gated (`this.ctx.authority`).

**`signal()`'s new motes branch cannot lie.** It gates on `off.motes > 0`, and `_argent()`
(`:1938-1956`) returns a motes-priced offer only when `motes >= RELIQUARY.motes` (with the
reliquary stocked) or `motes >= MOTE.motes`. There is no state where it reads `afford` for an
offer the purse cannot meet.

**`_synergies` + `blightGrace` compose correctly.** Rotting Chorus (magnitude 0.22,
maxStacks 2): attackSpeed 1.2200 at world 220 (grace 1.0), 1.0550 after scrubbing to world 0
(grace 0.25 → 0.055). No `maxStacks` double-count — the `cf2aed1` fix holds on the merged
tree — and the cleansed pack does relinquish the payoff.

**HUD blight dead-state reaches the screen.** The `if (!blight) return;` at `HUD.js:681-682`
is unreachable in practice: both `.inv-group[data-tier="argent"]` and `[data-tier="blight"]`
are emitted statically for every `CONTENT_TIERS` entry (`HUD.js:1946`) and resolved into
`refs.tierGroups` at build (`:1788-1790`), so the argent early return at `:669` cannot swallow
the blight poll.

**`itemOfferResolved` on `cancel()`** carries `outcome: 'cancelled'`, which matches neither
branch of Corruption's listener (`Corruption.js:201-204`) — a cancel commits nothing, as
documented.

**Safe claims correctly do not move `blightGrace`.** 20 safe claims leave `world 0`,
`blightGrace 0.250`. Coherent with #170's design: nothing was fed, so nothing activates.

**`OFFER.premium.equipment` / `OFFER.salvage.equipment` are unreachable today** — no item in
`ITEMS` carries `tier: 'equipment'`, and `openItemOffer` refuses ids absent from `ITEM_BY_ID`.
Harmless dead data, noted only so a future adopter does not assume equipment is offerable.

## Probe scripts

Kept outside the repo, in the session scratchpad:

- `C:\Users\tpzap\AppData\Local\Temp\claude\C--Users-tpzap-source-repos-OllieFace\53b146ae-e836-4155-bb9f-b75ffd281480\scratchpad\xlane.mjs`
- `C:\Users\tpzap\AppData\Local\Temp\claude\C--Users-tpzap-source-repos-OllieFace\53b146ae-e836-4155-bb9f-b75ffd281480\scratchpad\xlane2.mjs`
