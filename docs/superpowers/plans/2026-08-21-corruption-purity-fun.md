# Corruption & purity: from tax to decision (issue #36, second pass)

Status: §1-§4 merged to master. Slices 1-3 (the mint clause, the telemetry,
warding/motes/Sanctuary) landed 2026-08-21; D2 (the HUD purse) and D3/D4 (the
altar's at-range echo and the shortfall line) landed 2026-08-22; D5 (the mint
sting and toast) is in flight in a parallel lane. §5, appended 2026-08-22, is
design only and unimplemented. Written 2026-08-21.

The first pass at #36 (`src/data/bandBoons.js`, `VoidBargain`, `Corruption._peak`
/`marks`) built four real upsides and a real currency. It is good work and this
document does not undo any of it. It argues that the pass stopped one step short
of the player: the upsides exist in the simulation and are almost entirely
absent from every surface the player reads *before deciding*. That gap, not a
missing mechanic, is why the system still plays as a tax.

---

## 1. Diagnosis, from the code

### D1 — the decision prompt is three clauses and all three are costs

`src/world/corruptionPrice.js` is the one surface a player reads immediately
before every corrupting press. Its contract, stated in its own header:

```
<gain now> | <debt added> | <next consequence>
```

`nextLine` → `bandEffect` (corruptionPrice.js:135) can return exactly three
things: `an item mutates`, `clean route closes`, `enemy scale +0.44`. Every one
is a cost. The mark mint — the thing the first pass calls "the spine" — is
minted inside `Corruption.feed` (Corruption.js:~168) on the very press this
prompt is describing, and the prompt never mentions it. **A player who reads
every word of every prompt in this game will never learn that corruption buys
anything.** This is the single highest-leverage defect in the system, and it is
one clause of text.

### D2 — void marks have no readout anywhere

`voidMarksChanged` is emitted twice (`spendMarks`, `feed`). Grep across
`src/ui/` finds no listener; `HUD.js:1564-1566` wires `corruption-band`,
`corruption-next` and `corruption-route` and nothing else. The purse is quoted
only inside `VoidBargain.prompt()`, i.e. only while standing on the altar. A
currency you cannot see is a currency you cannot save toward, and saving toward
something is the mechanism that would make a chest feel like progress.

### D3 — the redemption surface is invisible at range

`VoidBargain.offer()` returns `null` when the purse is short and the prompt
then reads "Blighted wants more than you hold" — again, only on the altar. The
altar's only long-range tell is `update()` lerping `maw.material.emissiveIntensity`
between 0.35 and 1.6. There is no signal anywhere that says *"you are 12
corruption from affording the pact"*, which is the sentence that would turn a
chest into a purchase.

### D4 — purity is abstinence plus a gold sink; it has no verb

The clean route's complete action set today:

* do not press the thing (abstinence);
* pay gold at an Argent Font, at a price that scales with the debt
  (`cleanseCost`, `goldPerWorld: 1.5`) — spending a resource to return to zero;
* kill a Voidtouched elite, which bleeds `world * 0.08` and mints nothing.

The third is the only *verb* in the list, and it is a pure subtraction: warding
the void off pays no currency, opens no offer, and is invisible in the run
export. `bandBoons.js` has no Pristine entry at all — band 0 is a hole in the
table. So the clean player's reward for playing well is a smaller number.

### D5 — the mint is silent and mid-fight

`marksMinted` is `floor(peak / 25)` and rides `feed`. Marks therefore arrive in
the middle of a fight, off a chest opened forty seconds ago, with an event
nobody renders and no sound. The causal link "I took that risk → I got that" is
never drawn.

### D6 — the upside is unmeasured

`Telemetry.init` (Telemetry.js:253-266) subscribes to sixteen events.
`voidBargain` and `voidRuin` are not among them, and neither is
`voidMarksChanged`. The run export carries `corruption: {peakWorld, peakBand,
fed, bled, crossings}` — the tax, in four numbers — and not one field recording
that a player ever *bought* anything with corruption. The acceptance criterion
for #36 ("players voluntarily take corruption-positive actions") is currently
un-evaluable from the export.

**Summary of the diagnosis.** The mechanics of the upside are built. The
*information* is not. Four of six defects (D1, D2, D3, D5) are disclosure, one
is measurement (D6), and exactly one is a genuinely missing mechanic (D4).

---

## 2. The design

### 2.0 Principle

Every corruption-positive action must be **priced, previewed and posted**:
priced in the prompt that precedes it, previewed as a named outcome rather than
a category, and posted to the run export so a blind test can be read afterward.

### 2.1 Pristine — *the purity verb: Warding and Sanctuary*

Purity gets its own currency, its own verb, and its own bargain, mirroring the
void's three.

* **The verb is warding.** Corruption you bleed *by your own hand* — a
  Voidtouched kill, an Argent Font press — accumulates on
  `Corruption._warded`. Passive decay does not count; there is none. Warding is
  therefore something you go and do, and note the shape it forces: Voidtouched
  elites only exist because the world is corrupt
  (`VOIDTOUCHED.ratePerWorld * world`), so the clean route is now a *cycle* —
  dip in, ward it back out — rather than a refusal to play. That is the point.
  A player who never touches corruption gets no motes either, and that is
  correct: abstinence should not be the way to farm the purity currency.
* **The currency is the argent mote**, one per `MOTE.per` (40) points warded.
  Same monotone-high-water honesty as marks: minted by having done the work,
  and spending is tracked separately so nothing can be laundered.
* **The bargain is Sanctuary**, and it stands on the **Void Bargain altar**,
  not the Argent Font. (This document originally proposed the font; the altar
  is where it went, and the reason is better: `VoidBargain.offer()` returns
  `null` — a rock with nothing to say — at Pristine *and* at every band whose
  price the purse cannot meet, which is exactly the population that has been
  warding. Sanctuary is the fallback in that null case only, so the void's own
  bargain is still checked first and a party that can afford the pact is never
  argued down to a window.) Spend 1 mote: for
  `MOTE.sanctuarySeconds` seconds, `Corruption.priceOf` returns 0 — every
  chest, every pickup, every point of greed time is *free*.

  The decision this creates is the mirror image of the pact's. The pact spends
  marks to buy power at the cost of debt; sanctuary spends motes to buy *greed*
  at no debt. And it is a timing decision with a wrong answer: burn it on a
  small chest and you wasted it, hold it for the post-teleporter greed window
  (where the multiplier is 2.0) and one mote is worth twice as much. The clean
  player is no longer abstaining — they are hunting Voidtouched to bank a window
  in which they can loot like a greedy one.
* **Where you see it before committing.** The altar prompt names the mote
  price, the purse it is priced against, the window length, and — the clause
  that *is* the decision — whether greed time is running, because the window is
  worth exactly double while it is. The gauge should carry the mote count
  beside the mark count; that half is not built (see §4).

### 2.2 Seeded — *the mint clause*

`pricedPrompt`'s debt clause gains the other half of the transaction:

```
Ossuary Chest ($120) | +12 corruption -> mints a void mark | Blighted in 31: an item mutates
Small Chest ($40)    | +2 corruption (6 to the next void mark) | ...
```

Two states, both true, both derived from one pure function `mintForecast(peak,
added)` in `bandBoons.js` so the quote and `Corruption.feed`'s mint cannot
drift. This is the fix for D1 and it is the whole of tonight's first slice.

The decision it creates: two chests, one of which lands you on a mark boundary.
That is a reason to prefer the expensive one, and it is the first time in this
game that a corruption number has ever argued *for* a press.

### 2.3 Blighted — *the preview is already there; make it reachable*

`VoidBargain.offer()` already computes a `synergyPlan` and the prompt already
names the synergy, the stack it will eat and the blurb, before the press. That
half of the brief is done and done well. What is missing is D3: you have to be
standing on the altar to learn any of it. **Design (not built tonight):** the
altar's prompt text, when the party is within N metres, is echoed to the gauge's
route line — the same slot that already says which Fracture a band opens.

### 2.4 Overrun — *the pact is fine; the shortfall is not*

`offer()` returning `null` when the purse is short means an Overrun party one
mark short reads "Overrun wants more than you hold" with no number. **Design
(not built tonight):** name the shortfall and, crucially, name the corruption
distance to it — "3 marks: you hold 2, 19 corruption to the third". That is the
sentence that makes the next chest a purchase.

### 2.5 Consumed — *the finale consequence exists; the announcement does not*

`RUIN` is implemented, one-way, and reaches the finale through
`ruinedRite`. It is the strongest piece of the first pass. The gap is D5/D6
only: nothing renders `voidRuin` and nothing records it.

---

## 3. Telemetry — what will prove or refute this

All via the existing `ctx.events` → `Telemetry` pattern; the export grows:

| Field | Answers |
|---|---|
| `corruption.marks: {minted, spent}` | did the currency ever get used, or only accrue? |
| `corruption.motes: {minted, spent, warded}` | is anyone playing the purity verb at all? |
| `corruption.ruined` | did Consumed's door ever get opened? |
| `bargains: [{t, kind, id, marks, world, band}]` | **the acceptance criterion.** A run with zero entries and a nonzero `fed` is a player paying the tax and taking nothing back — the exact failure #36 names. |
| `sanctuaries: [{t, world, greed, fed}]` | was Sanctuary spent in greed time (the right answer) or out of it? |

Refutation conditions, stated in advance so the morning review is not free to
move them:

* **D1's fix fails** if `bargains` stays empty across blind runs whose prompts
  now quote the mint. That would mean the information was never the blocker and
  the upsides themselves are underpriced.
* **The purity verb fails** if `motes.minted > 0` but `motes.spent === 0` — the
  window is either too short, too cheap to notice, or arrives at the wrong time.
* **The purity verb is a balance hazard** if `sanctuaries[].greed` is true in
  nearly every entry *and* `fed` collapses: free greed time may simply be too
  strong. The dial is `MOTE.per` before `sanctuarySeconds`.

---

## 4. What tonight's prototype does and does not implement

**Built (slices 1-3):**

1. §2.2 the mint clause in `pricedPrompt`, off a new pure `mintForecast`.
2. §3 the telemetry: `bargains`, `sanctuaries`, `corruption.marks/motes/ruined`.
3. §2.1 warding, argent motes, and Sanctuary at the Void Bargain altar, with the
   font prompt disclosing the offer before the press.

**Not built, deliberately, and named so the review can weigh them:**

* D2 — the HUD purse (marks *and* motes on the gauge). This is a DOM/CSS change
  in `HUD.js` + `hud.css` and it is the single most valuable remaining item;
  it is left out only because it is the least testable in a headless suite and
  the most likely to need eyes. **Start here in the morning.**
* D3 — the at-range echo of the altar offer (§2.3) and the shortfall line
  (§2.4).
* D5 — a mint sting and toast on `voidMarksChanged`.
* Any tuning. `MOTE.per = 40` and `sanctuarySeconds = 12` are first guesses
  chosen to make a mote cost roughly one Voidtouched kill at Blighted depth.
  They have not been playtested and should not be defended.

**Sim-path honesty.** Slice 3 adds `Corruption.update` and a zero-branch inside
`priceOf`. Both are inert while `_sanctuaryT === 0`, no `ctx.rng` draw is added
anywhere, and `gate:sp --lane C` reported *no fields moved* against
`reviews/round7/baseline-00f8900.json` on the finished branch.

**One consequence worth arguing about in the morning.** Sanctuary makes
`priceOf` return 0, and `pricedPrompt` quotes through `priceOf` — so inside a
window every chest prompt re-prices itself to `+0 corruption`, which is
intended and is most of the pleasure of the thing. But `pricedPrompt` then
appends the mint clause off that same zero, so a sanctified prompt reads
"+0 corruption (25 to the next void mark)". That is *true* — a free press mints
nothing — but it reads as a discouragement in the one moment the player should
feel unleashed. Suppressing the mint clause while `sanctified` is a one-line
change and I did not make it, because it is a wording call rather than a
correctness one and it belongs to whoever reviews this.

---

## 5. The Argent Reliquary — purity as a build (issue #36, third pass)

Written 2026-08-22, against a merged §1-§4 (slices 1-3, D2, D3; D5 in flight).

### 5.0 What is still wrong

§2.1 gave purity a verb (warding), a currency (argent motes) and a bargain
(Sanctuary), and it works. But look at what a mote can *become*: twelve seconds
of free greed, and nothing else, ever. That is a consumable, and a consumable
is not a build. The corruption route accrues **permanent state** — blight
cards, a bought synergy, a pact, RUIN — and the purity route accrues a
stopwatch. A player asked "what am I building toward?" on the clean line still
has no answer, and "spend a mote for a good twelve seconds" is a smaller
sentence than "I am running a Slag Heart deck".

So the third pass adds the missing half: **motes buy permanent items**, out of a
pool that only purity can reach, whose cards are written so that they are
strongest exactly where blight cards are weakest.

### 5.1 The shape, and why this shape

The user pre-approved three shapes — an item pool, synergies/boons, an active
verb. The right answer is **all three, unified by one price ladder**, because
each alone fails:

* *An item pool alone* has no spend decision. Motes would just be a slower
  chest.
* *Synergies alone* re-run §2.3's Blighted bargain with the sign flipped, which
  is precisely the mistake the 2026-08-08 playtest warns against.
* *An active verb alone* is what Sanctuary already is, and its ceiling is the
  problem being fixed.

The unification: **one purse, one altar, two rungs.**

```
motes >= 1   ->  Sanctuary        (12s of free greed)      §2.1, shipped
motes >= 3   ->  Consecration     (one argent item, kept)  new
```

The deeper rung *replaces* the shallower one, which is exactly the rule
`VoidBargain.offer()` already states for the void's four bands and defends at
length: descending is a series of trades, not a growing menu. Applied here it
produces the decision the purity route has never had — **spend at one mote and
you never bank to three.** Every Sanctuary you take is an argent item you did
not buy. That is a real, legible, recurring choice made out of a currency the
player can already see on the gauge (D2 shipped), and it needs no new prop, no
new key, and no new prompt slot.

### 5.2 Why it does not dominate the corruption route

The failure mode named in the brief is flipping the sign on greed. The defence
is structural rather than numeric, and it is the design's actual content:

1. **Argent cards fade with the gauge.** Every argent payoff is multiplied by
   `grace = clamp01(1 - world / ARGENT.fadeAt)`, `fadeAt = 110` — the Overrun
   threshold (`data/corruption.js` BANDS). At Pristine an argent card pays
   full; at Blighted (55) it pays half; at Overrun and below it pays nothing at
   all. Blight cards do the opposite. A hedged inventory is therefore *worse
   than either pure line*, and the middle of the gauge is the worst place to
   stand. That is the build decision, and it is symmetric.
2. **Motes require corruption to have existed.** Nothing decays; the only two
   `bleed` callers are a Voidtouched kill and an Argent Font press, and
   Voidtouched exist at a rate proportional to World Corruption. An abstainer
   mints nothing. The purity route is a *cycle* — dip, ward it back out — and
   §2.1 already committed to this.
3. **The price is real.** 3 motes is 120 corruption warded. Against
   `VOIDTOUCHED.refund = 0.08` of a world near Blighted, that is roughly
   3 elite kills *plus* the descent that spawned them, or a font press and a
   couple of kills. It buys about one to two argent cards in a full run —
   deliberate parity with the two or three blight cards `BLIGHT_SHARE = 0.04`
   pays out over the same run.
4. **Consecration and Sanctuary eat the same purse.** The strongest purity
   play (bank to 3, take the card) is also the one that goes without the
   window, and the window is what makes greed time survivable.
5. **A ruined run is refused**, like every clean thing (`_sanctuary()` already
   does this; `_consecration()` inherits it).

### 5.3 The argent tier

A sixth zero-weight tier, `argent`, alongside `boss` / `lunar` / `blight`. It is
**never added to `rollTier`** — no share, no weight, no entry in any
`DROP_TABLES` bias that a chest reaches. The only door into the pool is
`Items.rollArgent()`, called by the Consecration press. This is load-bearing for
sp-equivalence: a run that never presses the reliquary takes **no additional
`ctx.rng` draw anywhere**, so the equivalence baseline cannot move (§4's
sim-path honesty, same argument).

**Hard constraint for the implementer:** argent payoffs ride `hooks`
(`onHit` / `onKill` / `onDamaged` / `outgoing`), never `stat(count, s)`.
`Items.stats()` is frame-cached behind `_dirty`, and `_dirty` is set by
inventory and buff changes only — a `stat()` that read World Corruption would
return a stale block for as long as nobody picked anything up. Hooks receive
`api.ctx` and are evaluated at use.

Shared helper, exported from `src/data/items.js`:

```js
export const ARGENT = { fadeAt: 110, reliquary: { motes: 3 } };
/** How much an argent card pays right now: 1 at Pristine, 0 at Overrun. */
export const grace = (ctx) =>
  Math.max(0, Math.min(1, 1 - (ctx?.corruption?.world ?? 0) / ARGENT.fadeAt));
```

The five cards. **All magnitudes are first-guess and untested.** Cards 1, 3 and
5 are the must-ship three if the lane budget bites; 2 and 4 are the stretch.

| id | name | glyph | effect (n = stack count) |
|---|---|---|---|
| `wardens-tally` | Warden's Tally | `ring` | `onKill`, Voidtouched only (`isVoidtouched(e.victim)`): `addBuff('frenzy', 8, 3, linear(0.12, n))`. **Not** grace-scaled — this one pays the verb directly. |
| `quicksilver-vein` | Quicksilver Vein | `drop` | `onHit`: `roll(hyperbolic(0.08, n) * grace(api.ctx))` -> `chainLightning(api, e, api.items.baseDamage() * 1.6, 2)`. |
| `unblemished-plate` | Unblemished Plate | `shield` | `onDamaged`: `addBuff('aegis', 4, 1, linear(14, n) * grace(api.ctx))`. |
| `chime-of-absolution` | Chime of Absolution | `hex` | `onKill`, **only while `api.ctx.corruption?.sanctified`**, host only (`api.ctx.authority`): `api.ctx.corruption.bleed(api.player, linear(1.5, n))`. |
| `pale-standard` | Pale Standard | `triangle` | `outgoing`: `amount * (1 + linear(0.30, n) * grace(api.ctx) * (api.items.count('wardens-tally') > 0 ? 1.5 : 1))`. |

Two of those deserve their argument written down.

**The Chime is the synergy half of the brief**, and it is deliberately not a
second `SYNERGIES` table. It converts ordinary kills into warding — i.e. into
motes — but *only inside a Sanctuary window*, which means it is dead for anyone
who has not spent a mote, and it is rate-limited by how many windows the run can
afford. It closes the purity loop into an engine (ward -> mote -> window ->
Chime wards harder -> mote) while still requiring the spend verb to turn over,
and it is the one argent card that is worthless at Pristine, because `bleed`
clamps to what exists. It is also the reason the pool is not simply "good
items": it has an internal shape.

**Pale Standard is the pair**, and it is the whole of the "argent synergies"
shape. A `held(other)` multiplier inside one card's own hook is a synergy that
needs no new table, no new preview surface, and no cross-file coupling — which
is what keeps Lane B inside one file's worth of judgement. If a later pass wants
a previewed argent bargain in the shape of §2.3, this is the seam it grows from.

### 5.4 The Consecration offer

`VoidBargain._sanctuary()` becomes `_argent()`, and gains the upper rung. The
class comment's rule is preserved exactly: the void's own bargain is still
checked first, and the purity offer still appears only in what used to be the
`null` case.

```js
_argent() {
  const cor = this.ctx.corruption;
  if (cor?.ruined) return null;
  const motes = cor?.motes ?? 0;
  // The deeper rung replaces the shallower one - `offer()`'s own rule, in the
  // other currency. Banking past Sanctuary is the decision this is for.
  if (motes >= ARGENT.reliquary.motes && this._reliquaryId()) {
    return { kind: 'consecrate', marks: 0, motes: ARGENT.reliquary.motes, id: this._reliquaryId() };
  }
  if (motes >= MOTE.motes) return { kind: 'sanctuary', marks: 0, motes: MOTE.motes };
  return null;
}
```

`_reliquaryId()` is the **cross-lane seam** and must be written defensively:

```js
/**
 * What the reliquary would hand over, or null when the pool is not there.
 * Derived once per altar and cached, never re-drawn per frame: the prompt names
 * the card before the press (the §2.0 principle - priced, previewed, posted),
 * and a card that changed every frame would be a slot machine rather than an
 * offer. Null-safe against `rollArgent` not existing, so this lane merges and
 * stays inert on its own.
 */
_reliquaryId() {
  if (this._relic === undefined) {
    this._relic = Items.of(this.ctx, this.ctx.player)?.rollArgent?.() ?? null;
  }
  return this._relic;
}
```

Prompt (mirrors the Sanctuary case's three lines):

```
Void Bargain - Consecrate: Pale Standard (3 of 4 argent motes)
argent cards pay full at Pristine and nothing at Overrun
the world stands at 41 - Blighted - paying 63%
```

The third clause is the decision, exactly as the greed clause is for Sanctuary:
it is the only place the game ever tells a player that a purchase is worth less
the dirtier the gauge is.

`interact()` gains a `consecrate` arm beside `sanctuary`: `spendMotes(3)`, then
`Items.of(ctx, pawn).grant(id)`, then `vfx.burst(pos, 0x9fd4ff)` and
`audio.play('shrineWin', pos)` (both already used by ArgentFont), then
`this.spent = true`, then emit **both** `voidBargain` (`{kind:'consecrate',
id, marks:0}` — so the existing acceptance field sees it) and a new
`argentConsecrate` (`{id, motes, world, band}`). Spend before grant, and refuse
the whole press if `spendMotes` returns false; `_relic` is cleared to
`undefined` only if the press failed.

### 5.5 Numbers, all first-guess and none playtested

| Dial | Value | Why this number |
|---|---|---|
| `ARGENT.reliquary.motes` | 3 | 120 warded ≈ 3 Voidtouched at Blighted depth. 1-2 cards a run, parity with blight's 2-3. |
| `ARGENT.fadeAt` | 110 | Overrun's `at`. Makes the fade land on a band boundary the player already reads. |
| Warden's Tally | 12% / 8 s / 3 | Roughly Bloodscent on a rarer trigger. |
| Quicksilver Vein | k=0.08, 160%, 2 bounces | Tar Charge's shape, grace-gated. |
| Unblemished Plate | 14 armour / 4 s | Half an Aegis dome at Pristine, nothing at Overrun. |
| Chime of Absolution | 1.5 per kill | Inside a 12 s window at ~10 kills that is ~15 warded — a third of a mote. Self-funding, not self-sustaining. |
| Pale Standard | 30%, 1.5x paired | The only always-on argent number; the pair bonus is what makes a second card feel like a deck. |

Existing economy numbers are untouched: `MOTE.per = 40`, `BOON.markPer = 25`,
`BLIGHT_SHARE = 0.04`, every band `at`. No retune is argued for here, and the
first tuning dial if this proves too strong is `reliquary.motes` (3 -> 4) before
`fadeAt`.

### 5.6 Telemetry — extending §3

`corruption.motes` was promised in §3 and never shipped: `Telemetry.js:212` has
`marks: {minted, spent}` and `ruined`, and no mote fields at all. That is a
prerequisite, not a nice-to-have — without it the refutation conditions §3 wrote
down cannot be evaluated.

| Field | Answers |
|---|---|
| `corruption.motes: {minted, spent, warded}` | **backfill of §3.** Is anyone playing the purity verb? |
| `corruption.grace` (at run end, and per stage row) | did argent holders actually keep the gauge clean, or did they buy cards and then dive? |
| `argent: [{t, id, world, band, motes}]` | every consecration, with the gauge it was bought at. |
| `argentHeld: {id: count}` at outcome | how big a purity deck ever gets. |
| `sanctuaries[].motesHeld` | **the ladder decision, measured.** A window bought at 1 mote is a player who could not wait; one bought at 2 is a player who chose the window over the card. |

Refutation conditions, fixed in advance:

* **The ladder fails** if `sanctuaries[].motesHeld` is 1 in nearly every entry
  and `argent` is empty across blind runs. Nobody is banking; 3 motes is out of
  reach and the rung should come down to 2 before anything else moves.
* **The fade fails** if `argent` is non-empty and `corruption.grace` at outcome
  is consistently below 0.3. Players bought cards and then dived, which means
  the cards are not paying enough to hold the line and the whole anti-dominance
  argument in §5.2 is decorative.
* **Argent dominates** if `corruption.peakWorld` collapses across runs that
  consecrate, *and* outcome win rate rises. The clean line has become the only
  line, which is the 2026-08-08 finding with the sign flipped — the exact
  failure this pass is written to avoid.
* **Argent is dead weight** if `argentHeld` is non-empty and `bargains` still
  carries pacts and synergies in the same runs. The hedge is winning, which
  means `fadeAt` is too generous.

### 5.7 Lane split

Two lanes, disjoint file surfaces, either mergeable alone.

**Lane A — the spend surface.** Owns:
`src/data/bandBoons.js` (ARGENT re-export note only; the table itself lives in
items.js — see the seam), `src/world/Interactables.js` (**`VoidBargain` only**),
`src/systems/Telemetry.js`, `tests/argent-reliquary.test.mjs`.
Does **not** touch `items.js`, `Items.js`, `Corruption.js`.

Acceptance (headless, `tests/argent-reliquary.test.mjs`):
1. `_argent()` returns `sanctuary` at 1-2 motes and `consecrate` at >= 3, given
   a stub whose `rollArgent()` returns an id.
2. `_argent()` returns `sanctuary` at >= 3 motes when `rollArgent` is absent or
   returns null — the inert-alone guarantee. **This test must be shown to fail
   if the `?.` is removed**; state that in the report.
3. `_reliquaryId()` returns the same id across 100 calls (no per-frame re-draw).
4. A ruined run returns `null` at every mote count.
5. `interact()` on a `consecrate` offer with a stub `spendMotes` returning false
   grants nothing, emits nothing, and leaves `spent === false`.
6. A successful press emits `voidBargain{kind:'consecrate'}` *and*
   `argentConsecrate`, in that order, and `Telemetry` records one row in
   `bargains` and one in `argent`.
7. `corruption.motes.{minted,spent,warded}` populates off `argentMotesChanged`
   and the existing corruption events; a run that never wards leaves all three 0.

**Lane B — the pool.** Owns:
`src/data/items.js` (TIERS.argent, ARGENT, `grace`, five cards),
`src/systems/Items.js` (`rollArgent()` only — **no change to `rollTier`,
`DROP_TABLES`, `BLIGHT_SHARE` or `ORDINARY_TIERS`**), `src/ui/Icons.js` (the
tier colour), `tests/argent-items.test.mjs`.
Does **not** touch `Interactables.js`, `Telemetry.js`, `Corruption.js`,
`bandBoons.js`.

Colour: `#8fd7ff` in both `data/items.js` TIERS and `ui/Icons.js` TIERS.
`tests/readability-gate.test.mjs` fails if they diverge and must be run.

Acceptance (headless, `tests/argent-items.test.mjs`):
1. `rollTier` never returns `'argent'` over 10 000 draws against every entry in
   `DROP_TABLES` and against a bare bias object. **Show this test failing** by
   temporarily adding argent to `TIER_WEIGHTS`.
2. `grace()` is 1 at world 0, 0.5 at 55, 0 at 110 and 0 at 400; null-ctx reads 1.
3. Each card's hook is a no-op at world >= 110 (Chime excepted) and pays at
   world 0.
4. Chime does nothing when `sanctified` is false, and calls `bleed` exactly once
   per kill when it is true; it is a no-op off `ctx.authority`.
5. Pale Standard's `outgoing` is exactly 1.5x its unpaired multiplier bonus when
   a `wardens-tally` stack is held.
6. No argent card defines `stat` (assert over the pool) — the frame-cache rule.
7. `rollArgent()` returns null off `ctx.authority` and never touches
   `ctx.rng` on that path.

**Integration, controller-owned, on the merged result:** one run through
`npm run gates:cheap`, then `npm run gate:sp` — the equivalence baseline must
report **no fields moved**, and if it does the §5.3 no-extra-draw claim is
wrong and the merge stops. Lane A runs on lane block A, Lane B on block B.

**Follow-up, explicitly not in either lane** (the D5 lane holds `HUD.js` and
`Audio.js` today):

* The gauge's mote pip should read `n / 3` once the run has ever warded, so the
  ladder is visible without standing on the altar. This is the D2 argument
  applied to the new rung and it is the single most valuable follow-up.
* A consecration sting on `argentConsecrate`, distinct from the mint sting D5 is
  building for `voidMarksChanged`.
* An argent tier colour pass over the pickup banner and the Codex.
