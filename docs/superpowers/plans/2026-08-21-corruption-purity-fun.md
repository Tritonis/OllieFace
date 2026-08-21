# Corruption & purity: from tax to decision (issue #36, second pass)

Status: design + prototype, branch only, unmerged. Written 2026-08-21.

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
* **The bargain is Sanctuary.** Spend 1 mote at an Argent Font: for
  `MOTE.sanctuarySeconds` seconds, `Corruption.priceOf` returns 0 — every
  chest, every pickup, every point of greed time is *free*.

  The decision this creates is the mirror image of the pact's. The pact spends
  marks to buy power at the cost of debt; sanctuary spends motes to buy *greed*
  at no debt. And it is a timing decision with a wrong answer: burn it on a
  small chest and you wasted it, hold it for the post-teleporter greed window
  (where the multiplier is 2.0) and one mote is worth twice as much. The clean
  player is no longer abstaining — they are hunting Voidtouched to bank a window
  in which they can loot like a greedy one.
* **Where you see it before committing.** The font prompt gains a fourth line
  naming the mote price, the window, and the greed multiplier currently in
  force. The gauge carries the mote count beside the mark count.

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
3. §2.1 warding, argent motes, and Sanctuary at the Argent Font, with the
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
anywhere, and `gate:sp` was run on the result — see the branch's final report.
