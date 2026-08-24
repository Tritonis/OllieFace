# Whole-batch integration review — merged master `8395f29..84a1143`

Date: 2026-08-24. Tree: `C:\Users\tpzap\source\repos\OllieFace` (main worktree, read-only).
Lanes: #178 (`3bc763a`), #206 (`fadd86b`), #204+#205+#173 (`84a1143`).

**SPEC: CONFIRMED** — every behaviour the dispatch enumerated is present and does what it
claims; the hand-merge is provably a clean union of both parents.
**QUALITY: NOT READY** — 0 Critical, 3 Major, 4 Minor. All three Majors are player-facing
honesty/reachability defects in the Wound prototype and the new consecration window; none of
them is a merge artefact.

---

## Commands run

| Command | Result |
|---|---|
| `npm test` | **166/166 test files passed**, exit 0 |
| `npm run gates:cheap -- --quiet` | **PASSED (3/3)** — test 92.9s, build 1.8s, audit (1 allowlisted) |
| merge-equivalence diff (below) | both parents' hunks preserved exactly |
| 3 bespoke integration probes (A–I) | see Evidence |

`probe:coop` was **not** re-run: `git diff c29869b..84a1143 -- src/net/` is **0 lines**, i.e. the
merge did not touch the net path the controller already probed 9/9 on this exact tree.

---

## 1. The hand-merge (the thing I was asked to verify precisely)

Verified mechanically rather than by eye. With `MB = git merge-base fadd86b c29869b` (= `8395f29`):

```
diff <(git diff $MB..c29869b -- src/world/Interactables.js | grep '^[+-]')  \
     <(git diff fadd86b..84a1143  -- src/world/Interactables.js | grep '^[+-]')
  -> IDENTICAL
diff <(git diff $MB..fadd86b -- src/world/Interactables.js | grep '^[+-]')  \
     <(git diff c29869b..84a1143 -- src/world/Interactables.js | grep '^[+-]')
  -> differs by exactly two lines: a "  }" + blank line moved from position 162 to 203
```

That single relocation is `init()`'s closing brace moving down so `_promoteWound` follows the two
new client listeners — the reordering the controller described. `src/systems/Items.js` is
IDENTICAL on both sides. **Nothing was lost, duplicated, or mis-scoped from either parent.**

Region read in full (`Interactables.js` 2890–3020) and confirmed:

- constructor keeps `_woundStage` / `_woundOrdinal` / `_wounds` **and** `_remoteOffer` (2899–2909);
- `init()` registers the `blightSeed` promotion listener **and** both client-side
  `itemOfferOpened` / `itemOfferResolved` listeners, each with its own `if (ctx.authority) return`
  role check inside the handler (2916–2945);
- `_promoteWound` follows as a method of `Interactables`, not nested inside `init` (2948–2988);
- `clear()` carries the wound reset **and** the pre-existing `_bargainSite` reset (2992–3003).

**No finding.** This half of the review is clean.

---

## 2. Findings

### MAJOR

#### M1 — `src/world/Interactables.js:2540` — the Wound's feed line quotes face value and is 2x wrong in the condition wounds occur

`Wound.prompt()` builds its feed clause by hand:

```js
const feed = `Feed (+${WOUND.feedCorruption} corruption toward marks, the patch spreads, corrupt commitment)`;
```

Every other corrupting press in this repo routes its prompt through
`corruptionPrice.js:216 pricedPrompt`, which (a) applies `cor.priceOf` so the quote and the charge
are one expression, (b) appends `(x2 greed time)` when greed is on, (c) appends the mint forecast,
and (d) appends `nextLine(...)` — the band edge and what crossing it does. The Wound does none of
these four.

`Corruption.priceOf` (Corruption.js:432) multiplies by `SOURCES.greedMult = 2.0` during greed time,
and greed time is the condition that produces most wounds: `Corruption.seed` adds `+1` strength
during greed (Corruption.js:757), `WOUND.minStrength` is 2, and the common seeders pass strength 1
(`markGreed`, Interactables.js:230; `cor.seed(this.position, 1)`, Interactables.js:420). Only
large/legendary chests (Interactables.js:427) qualify a seed outside greed time.

**Reproduction (probe A/D, `Corruption` + `Blight` + `Interactables` on a real bus):**

```
=== A: greed time pricing vs the wound prompt ===
greed = true  priceOf(18) = 36
PROMPT: Blight Wound - Feed (+18 corruption toward marks, ...) | or Seal (hold 12s, -8 corruption, ...)
world delta = 36  prompt quoted 18

=== D: a greed-time feed crosses a band the prompt never mentions ===
world = 25 band = 1
PROMPT: Blight Wound - Feed (+18 corruption toward marks, ...) | or Seal (...)
-> world = 61 band = 2 corruptionBand fired: [{"band":2,"prev":1}]
```

The band crossing is the expensive half: `corruptionBand` is what queues the toll
(`Items.js:2060`), so an unquoted crossing costs the player an item stack. `BANDS` (data/corruption.js:11)
puts Blighted at 55; a 36-point charge from world 25 clears it in one press with no line of text
about it.

**Minimal fix:** `return pricedPrompt(this.ctx, 'Blight Wound - Feed (the patch spreads, corrupt
commitment)', WOUND.feedCorruption)` for the feed clause, exactly as `AuricCairn`
(Interactables.js:897) and `GildedSnare` (Interactables.js:1340) do.

Severity note: currently latent as a *charge* because of M2 — the feed cannot be selected in the
shipped build — but the text is displayed at every wound today, and the mis-quote becomes a live
2x economy error the moment the binding lands.

---

#### M2 — `src/world/Interactables.js:2521` — `Wound.selectOutcome` has no production caller, so half the prompt advertises an unreachable outcome

```
grep -rn "selectOutcome" src/ tests/
  src/world/Interactables.js:2485   (docstring)
  src/world/Interactables.js:2521   (definition)
  tests/wounds.test.mjs:161, 220    (tests call it directly)
```

Nothing in `src/` calls it. `this.outcome` is initialised to `'seal'` (Interactables.js:2497) and
never reassigned outside `selectOutcome`. **Every wound in the shipped build seals**, and the
`Feed (...)` half of `prompt()` (2540) is printed at every wound as an offer the player cannot take.

This is flagged as a known follow-up in the dispatch, but the *integration* fact is what makes it
Major rather than a note. `Wound`'s own docstring (Interactables.js:2483–2487) justifies the design
by citing `VoidBargain.selectConsecration`'s precedent — and lane C removed exactly that precedent
in this same merge. `tests/remote-offer-and-argent-wire.test.mjs:9` states the diagnosis in lane C's
own words: *"press took card 1, because nothing called `selectConsecration`."* `selectConsecration`
still has no binding either (grep: only `_deliverConsecration` and tests call it), but #204 made it
moot by giving the altar a real three-card panel. Post-merge the Wound is the **last remaining
instance of the pattern this batch was fixing**, and it ships a prompt advertising the dead half.

**Fix direction:** either raise the wound's two outcomes through `Items.openArgentChoice`-shaped
window machinery the way #204 did, or suppress the Feed clause from `prompt()` until the input
exists. Shipping the advertisement without the button is the option to avoid.

---

#### M3 — `src/world/Interactables.js:2356` — the consecration guard sees only half the windows it can paint over

```js
if (offered.length > 1 && items.hasChoiceWindow?.()) return false;
```

`hasChoiceWindow()` (Items.js:936) reports `!!this._muteChoice` — the blight toll / argent slot
only. It does **not** see an open `itemTransaction` offer, which lives on the interactable and is
reached through `Interactables.openOfferFor(pawn)` (Interactables.js:3409). `Menus.showChoice`
(Menus.js:2479) is one slot: `this.mutate = {...}` overwrites unconditionally.

**Reproduction (probe G, real `openItemOffer` + real `VoidBargain` + real `Items`/`Corruption`):**

```
=== G: altar press while the pawn has a LIVE chest offer window ===
open offer id = 1  outcomes = [ 'safe', 'corrupt', 'salvage' ]
items.hasChoiceWindow() = false
interactables.openOfferFor(player) = true
altar offer kind = consecrate cards = 3
altar.interact -> true
mutationChoiceOffered emitted: [ { kind: 'argent', id: 1 } ]
chest offer still open? true remaining = 12
chest offer outcome after lapse = safe
```

The altar press is accepted, raises the argent window, `HUD.js:384` calls
`menus.showArgentChoice({id:'argent:1'})`, and the chest's `offer:1` panel is repainted out of the
one slot. The chest offer is never told, and lapses to `safe` — the player loses a live three-way
claim they were reading, on a *voluntary* press.

The reverse ordering is the worse one and is equally unguarded: `Chest.interact` calls
`settleOpenOffers(pawn)` (Interactables.js:446) but never `items.refuseMutation()`, so a chest press
while an argent window stands repaints over a consecration **already paid for in motes**, which then
lapses through `_deliverConsecration(items, null, ...)` to `offered[this.consecratePick()]` —
card 1 (Interactables.js:2124). Motes spent, choice silently forfeited to the default.

Of the four orderings, one is guarded:

| standing window | press | guarded? |
|---|---|---|
| choice window (toll or argent) | altar consecrate | **yes** (2356) |
| item offer | altar consecrate | **no** — probe G |
| argent choice | chest | **no** — reverse of G |
| band toll | chest | no (pre-existing; adjudicated at Menus.js:2474) |

`Menus.js:2474` explicitly accepts the paint-over *for the involuntary band toll* ("costs the player
the choice, never the item"). #204's own guard comment ("A window already standing on this pack is
somebody else's decision and not this press's to paint over") shows a voluntary press was meant to
refuse — the guard just reads the wrong one of the two window registries.

**Minimal fix:** widen 2356 to `if (offered.length > 1 && (items.hasChoiceWindow?.() ||
this.ctx.interactables?.openOfferFor?.(pawn))) return false;` and, for the reverse, have the chest's
`settleOpenOffers` path also decline a standing argent window (or refuse the chest press while one
stands).

---

### MINOR

#### m1 — `src/data/vows.js:100` / `src/world/itemTransaction.js:361` — a guest can now break the host's run-scoped Vow of the Closed Hand

Payload shape checks out exactly: `offer.resolve('corrupt')` emits
`itemOfferResolved { outcome: 'corrupt', owner: <guest pawn>, ... }` on the **host** bus
(itemTransaction.js:349–361), and `take-nothing-offered.step` returns `'broken'` on
`payload?.outcome === 'corrupt'` with no owner filter. So a guest's wire answer
(`NetHost.js:428 -> answerOffer -> chooseOffer -> resolve`) breaks the vow.

This is *new*: pre-#205 a guest never saw the panel and the host's clock lapsed every guest offer to
`safe`, so a guest could not break it. It is defensible — the vow is run-scoped and the reward
(`VOW_WARD = 16`, vows.js:60) is a run-level payout — but it means a teammate's press now forfeits a
reward the host was earning. Reported, not adjudicated, per the dispatch.

#### m2 — `src/ui/HUD.js:411-414` — stale comment contradicted by its own lane

> "a teammate's chest is a teammate's decision, and **this build does not send the offer over the
> wire** — an unaddressed seat simply never sees a panel and the host's clock lapses the window into
> the safe claim"

`NetHost.js:174` added `'itemOfferOpened', 'itemOfferResolved'` to the addressed-forward list in this
same merge. The comment now states the bug it fixed as current behaviour, next to live code.

#### m3 — `src/world/Interactables.js:2992-3003` — `clear()` resets every stage field except `_remoteOffer`

`clear()` resets `list`, `orbs`, `teleporter`, `focus`, `_bargainSite`, `_wounds` — but not
`_remoteOffer`, the one constructor field added by lane C. A client's shadow offer therefore
survives a stage transition, and `openOfferFor` will keep returning it. Impact is low (the host's
`itemOfferResolved` normally clears it first, and a stale echo fails `answerOffer`'s
`offer.offerId !== offerId` check at Interactables.js:3500), but it is a gap in an otherwise
exhaustive reset.

#### m4 — `src/world/Interactables.js:2539` — the seal line quotes `-8 corruption` unconditionally

`Corruption.bleed` clamps to `this._world` (Corruption.js:544). Probe C, world = 3:

```
PROMPT: Blight Wound - Seal (hold 12s, -8 corruption, pure commitment) | or Feed (...)
state = sealed world after seal = 0 warded = 3
```

Quoted 8, delivered 3. The commit (`woundSealed`, 5 pure) is correct and unconditional — only the
ward is clamped — so this is a display gap, and the smaller sibling of M1.

---

## 3. Seams attacked and found clean

Listed bare, per the return contract; each was probed, not merely read.

**Seam 2 — salt streams (#206 x #178).** No shared stream and no correlation. `saltedSeed(seed,
stage, 0x51f0ab8d)` (font) vs `saltedSeed(seed, stage, 0x2545f491)` (bargain): **0 collisions over
4096 seeds x 6 stages** (98304 pairs). `promoteWound` folds a second salt (`0x85ebca6b * (ordinal+1)`,
wounds.js:74) before fmix32, so although its pre-mix value coincides with the shrine stream's raw
seed (`0x9e3779b9`, Interactables.js:3191), the finalised outputs are independent. Promotion rate
0.3346 / 0.3307 / 0.3358 across stages 0–2 (target 1/3, no stuck wheel). Independence of
"promotes ordinal 0" and "font picks landmark 0" over 20000 seeds: P(both) = 0.1145 vs product
0.1116 (~1.3 sd) — no correlated picks. Wound promotion takes **zero** draws from `ctx.rng`
(asserted by `tests/wounds.test.mjs` and re-checked here).

**Seam 3 — guest `_remoteOffer` shadow x wound events.** Probe E, `authority: false`:
`blightSeed` runs, `_promoteWound` returns null on the `!ctx.authority` line (Interactables.js:2969)
before touching `_woundOrdinal` (stays 0), 0 wounds promoted; `itemOfferOpened` sets `_remoteOffer`,
`openOfferFor` returns it, `itemOfferResolved` with the matching id clears it; **no throw**. Wounds
do reach guests: `replicable()` returns `this.list` (Interactables.js:3523) and `VIEW_BUILDERS[17]`
is registered (Interactables.js:3580). Guests never seal — `requestInteract` is authority-gated
(3394) and a view Wound's `update` returns immediately in state `'open'`.

**Seam 1 — Wound press x choice windows.** Probe H: a wound press with an argent window standing
puts the wound into `sealing` and leaves the window untouched; a feed press resolves and leaves the
window untouched. `Wound` opens no panel, so it cannot re-open the #175 collision from its own side.
The altar-guard asymmetry the dispatch asked about is **harmless for wounds** — but not harmless for
item offers, which is M3.

**Seam 6 — mint accounting across three credit sources.** Probe I: `bleed(30)` + `ward(16)` +
`bleed(8)` (seal) + `bleed(40)` = 94 warded -> `motes = 2`, mint events `[1, 2]`. Exactly one mint
per `MOTE.per = 40`, no double-count. All three sources funnel `_credit` (Corruption.js:497), which
is the only writer of `_warded` and the only emitter of `argentMotesChanged`.

**Seam 7 — protocol v12.** `git diff c29869b..84a1143 -- src/net/` is **0 lines**: the merge did not
touch `Protocol.js`, `NetHost.js` or `NetClient.js`. `PROTOCOL_VERSION = 12` (Protocol.js:127);
refusal in both directions (`NetHost.js:499`, `NetClient.js:218-219` with `REFUSE.VERSION`).
`MUTATE_TARGET` handling is fail-closed: a truncated body reads `CHOICE` (Protocol.js:202), an
unrecognised target reaches neither branch (`NetHost.js:423-433`), the pawn is re-derived from the
connection and cannot be named, `answerOffer` rejects any id that is not that pawn's own live
offer (Interactables.js:3499-3501), and `offer.resolve` re-validates the outcome name against
`offeredOutcomes(itemId)` (itemTransaction.js:325) — so the outcome string riding in the id field is
never trusted.

**Also clean:** `Blight._woundResolved` clamps `expand` at the thing that grows rather than trusting
the payload (Blight.js:507-510); `Director`'s seal handler suppresses void seeds locally rather than
globally and leaves telegraphed surfacings to ripen (Director.js:215-238);
`Telemetry.onWoundResolved` closes the *nearest* open row rather than the newest (Telemetry.js:661)
and pushes an orphan row rather than dropping an unmatched answer;
`alignment.js` flips `woundSealed` / `woundFed` to `wired: true` with the two-weight split matching
`salvaged` / `vowKept`.

---

## 4. Verdicts

- **SPEC: CONFIRMED.** Wound promotion (max 3/stage, fmix32-salted, minStrength 2, minSpacing 16),
  seal (12s hold -> `woundResolved` -> `woundSealed` 5 pure + `bleed(8)` + patch recycled + local
  Director suppression), feed (`woundFed` 5 corrupt + `feed(18)` + capped expansion), the `wounds`
  telemetry array, the four `saltedSeed` sites, the generalized `kind: 'blight'|'argent'` window,
  the wire-forwarded chest offer answered by id and host-verified, and PROTOCOL_VERSION 11->12 all
  behave as claimed. (Note: the dispatch names the events `woundSealed` / `woundFed`; the emitted
  event is a single `woundResolved` carrying `outcome`, and `woundSealed`/`woundFed` are the
  `alignment.js` commitment sources it bills. Naming only, not a defect.)
- **QUALITY: NOT READY.** M1 and M2 together mean the Wound ships a prompt that advertises an
  outcome the player cannot select and mis-quotes its price by 2x when they eventually can. M3 is a
  newly-introduced voluntary-press forfeit of a paid decision, in a guard written to prevent exactly
  that. None blocks the merge's *integrity* — the hand-merge is exact — but all three are
  player-facing and all three are cheap to fix.
