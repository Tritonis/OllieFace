# Whole-batch integration review — merged master `a9bc08c..e0734b6`

**Date:** 2026-08-24
**Tree:** `C:\Users\tpzap\source\repos\OllieFace` (main tree, read-only for code)
**HEAD reviewed:** `e0734b616f64fc83343e0b47d29dc7462e68ef49`
**Scope:** cross-lane interaction only. #173 (consecration preview, merge `fa2816a`), #175 (chest
itemTransaction contract, merge `8a75e65`), #177 (stage vows, merge `e0734b6`).

## Verdicts

- **SPEC: CONFIRMED** — every cross-lane claim in the dispatch was independently reproduced on the
  merged tree. All six named seams behave as claimed; the hand-merged `Telemetry.js` is correct in
  all three respects asked for (record init, listener install, both handler bodies).
- **QUALITY: READY** — 0 Critical, 0 Major, 4 Minor, 2 Informational. Nothing here blocks the
  merge; m1 and m2 deserve follow-up issues.

**Counts:** 0C 0M 4m (+2 informational)
**Tests:** `npm test` 164/164 test files passed (exit 0); `npm run gates:cheap -- --quiet` 3/3 arms
PASSED (test 101.9 s, build 2.1 s, audit clean with 1 allowlisted). Custom cross-lane probes:
63/64 then 64/64 after correcting one mis-specified assertion (see "Probe corrections"), plus
5/5 ordering and 11/11 two-pawn.

---

## Findings

### m1 — `src/systems/Items.js:1897` — `previewArgent` carries the exact first-draw bias lane C documented and fixed for itself

`previewArgent` seeds `new RNG(((seed >>> 0) ^ (0x85ebca6b * ((key >>> 0) + 1))) >>> 0 || 1)` and
takes the first card with `rng.int(0, bag.length - 1)` on the **first draw** of that stream.
`src/data/vows.js:145-158` documents at length that this idiom is not safe for a small n-way pick,
because the salted values "differ only in their low bits and the generator's first draw does not
carry them into the high ones" — and lane C fixed its own selector by avalanching the salt through
fmix32 first (`src/data/vows.js:155-158`). Lane B's `previewArgent`, merged three commits earlier
in the same range, has the unfixed construction. On the merged tree the two coexist, one hardened
and one not.

**Evidence (reproducible):**

```
node -e "Promise.all([import('./src/systems/Items.js'),import('./src/data/bandBoons.js')]).then(([I,B])=>{
  for (const key of [0,1,2,3,7]) { const first=new Map(), whole=new Map();
    for (let s=1;s<=3000;s++){ const it=Object.create(I.Items.prototype); it.ctx={seed:s};
      const ids=it.previewArgent(B.RELIQUARY.choices,key);
      first.set(ids[0],(first.get(ids[0])||0)+1); whole.set(ids.join('>'),1); }
    console.log('key',key,'distinct first cards:',first.size,'distinct tables:',whole.size); }});"
```

Output — the argent pool holds 5 cards, so 5 first-slot values and 60 ordered triples are possible:

| key (stage) | distinct FIRST cards over seeds 1..3000 | distinct whole tables |
|---|---|---|
| 0 | **2** — `unblemished-plate` 1637 / `quicksilver-vein` 1363 | 24 of 60 |
| 1 | **2** — `pale-standard` 2181 / `chime-of-absolution` 819 | 24 of 60 |
| 2 | **2** — `chime-of-absolution` 2457 / `unblemished-plate` 543 | 24 of 60 |
| 3 | **2** — `chime-of-absolution` 2047 / `unblemished-plate` 953 | 24 of 60 |
| 7 | **2** — `quicksilver-vein` 2457 / `unblemished-plate` 543 | 24 of 60 |

Three of five cards can never appear in slot 1 at a given stage, and 36 of 60 tables are
unreachable. Slot 1 is what `consecratePick()` returns by default (`src/world/Interactables.js:2079-2083`),
so it is what a player who does not aim actually buys.

**Blast radius is bounded, which is why this is Minor and not Major.** `src/main.js:49` defaults the
run seed to `(Math.random() * 0xffffffff) >>> 0`, and with full-range 32-bit seeds the distribution
is uniform (20 000 random seeds, key 0: 4068/4000/3993/3987/3952 across all five cards; 60 of 60
tables reachable). The bias bites only for **small contiguous seeds** — i.e. `?seed=N` repro runs,
QA, and every test fixture in the repo.

The guard that would have caught it is the one that does not have the shape: the isolated first-draw
bias is invisible to `tests/argent-consecration-choice.test.mjs:92-94`, which compares exactly one
seed pair (99 vs 7). Lane C's equivalent guard sweeps seeds 0..7 and is precisely how the bias was
found in the first place.

**Same unfixed idiom, pre-existing and out of this range** (informational, not attributable to this
merge): `src/systems/Items.js:1088` (`stabilise`), `src/world/Interactables.js:2938`
(guaranteed-font mark, `grng.int(0, 2)`), `src/world/Interactables.js:2983` (`_placeBargain`,
`brng.int(0, 2)`). Measured: `new RNG(seed ^ 0x2545f491).int(0,2)` returns `2` for all 2000 seeds
tested — the altar sits at the same landmark index for every small seed at a given stage.

**Suggested fix:** the three-line fmix32 finaliser already written at `src/data/vows.js:156-158`,
applied to the salt before it reaches `new RNG(...)`.

---

### m2 — `src/systems/Telemetry.js:843-848` — `onRunEnd` flushes `_openChoice` but has no equivalent for `_openVow`

The hand-merge added `_openVow` (`src/systems/Telemetry.js:342`) and its two handlers, but not the
run-end flush that `_openChoice` gets at `src/systems/Telemetry.js:848`. Today the vow row still
lands in the **persisted** record — but only because `src/main.js:124` (`engine.add(new Vows())`,
whose `init` runs immediately per `src/core/Engine.js:527`) registers its `runEnd` listener before
`src/main.js:195` (`installTelemetry(ctx)`). The correctness of a telemetry field therefore rests on
an undocumented ordering coupling between two lines 70 apart in `main.js`.

**Evidence — the guard was shown capable of failing.** Two ctxs, identical except for registration
order, real `Vows` + real `installTelemetry` + a Map-backed storage:

| order | in-memory `record.vows` | **persisted** `vows` |
|---|---|---|
| `new Vows().init(ctx)` then `installTelemetry(ctx)` (real `main.js` order) | 1 | `[{"stage":0,"id":"take-nothing-offered","kind":"restraint","kept":true,"reason":"lapsed","warded":16,...}]` |
| `installTelemetry(ctx)` then `new Vows().init(ctx)` | 1 | `[]` |

In the reversed order `onRunEnd` sets `record.complete = true` and calls `commit()` before
`vowResolved` is emitted; `onVowResolved` then pushes into an in-memory record that is never written
again. Every run's **final** vow — the one the analysis most wants — silently vanishes.

**Repro:** construct a ctx with `Items` + `Corruption`, install telemetry, then `new Vows().init(ctx)`;
emit `stageStart {index:0}` then `runEnd {}`; read `telluric.telemetry.runs` from the storage stub.

**Suggested fix:** mirror line 848 — `if (this._openVow) this.onVowResolved({ ...this._openVow, reason: 'runEnd' })`
before `this.commit()`, and let the later real `vowResolved` be refused the way `onMutationClosed`
already refuses a duplicate.

---

### m3 — `src/ui/Menus.js:2432-2450` — a chest offer painting over a live mutation window costs the player the mutation, and the comment justifies only the reverse direction

`showChoice`'s doc comment reads: *"One window at a time by construction, exactly as before: opening
a second paints over the first. The offer's lapse is the harmless outcome (`OFFER.windowDefault`), so
a band crossing that opens a mutation window on top of a chest offer costs the player the choice,
never the item."* That reasoning is sound in the direction stated, and false in the other:

- chest offer over mutation window → the mutation window is unanswerable and lapses;
  `src/systems/Items.js:957` calls `_closeMutationChoice(c, reason, null)` →
  `src/systems/Items.js:966` `this._mutateAt(c.band, null)` — the void picks the stack. That is not
  a harmless default.
- "exactly as before" is also not accurate: before #175 only one system opened this slot, so a
  chest could not paint over anything.

Chest opens are frequent and the mutation window runs 6 s, so the collision is not exotic. The
id-matched *close* discipline (`src/ui/Menus.js:2515`) correctly prevents the older decision tearing
down the newer panel — that part is verified working — but nothing prevents the newer decision
stealing the older one's answer window.

Not raised higher because it is an adjudicated design call inside one lane's own scope; it becomes
visible only on the merged tree, which is why it is recorded here.

---

### m4 — `src/data/vows.js:155` vs `src/systems/Items.js:1088` — the "different multiplier" rationale is true of the altar and false of `stabilise`

`selectVow` salts with `Math.imul(0x27d4eb2f, stageIndex + 1)`; `Items.stabilise` salts with
`0x27d4eb2f * ((salt | 0) + 1)` — the identical constant, and for small operands the plain multiply
and `Math.imul` agree after `ToInt32`, so the pre-mix values are bit-identical whenever the two salt
arguments coincide. The comment at `src/data/vows.js:133-135` claims "a different multiplier so a
stage's vow and its altar site are not correlated": true of `_placeBargain` (`0x2545f491`) and of the
font block (`0x51f0ab8d`), but it does not hold for `stabilise`.

**Practically harmless and verified so.** `stabilise`'s salt argument is
`stageIndex * CLEANSE.maxUses + press` with `maxUses = 3` (`src/data/corruption.js:120`), so the two
arguments coincide only at stage 0 / font press 0 — once per run at most — and the two derivations
diverge immediately afterwards (fmix32 finaliser vs an RNG stream). Recorded so the comment does not
outlive its accuracy.

---

### i1 — `src/net/NetHost.js:164-166` — the chest offer is not an addressed event, so a remote seat never gets the three-way choice

`itemOfferOpened` / `itemOfferResolved` are absent from the `_forwardOwned` list, which does carry
`mutationChoiceOffered` / `mutationChoiceClosed` for exactly the reason the offer would need. A
remote pawn's chest therefore opens a panel nobody sees and always settles into the lapsed SAFE
claim on the host's clock. This is stated deliberately at `src/ui/HUD.js:398-404` and is scope, not
a defect — but it is a co-op parity gap (host player gets a priced three-way decision, guests never
do) that should carry an issue rather than only a comment.

Behaviourally, a remote chest open changed from "orb immediately" to "same item, 8 s later, no
choice". Host-local; nothing on the wire changed.

### i2 — choice-window id namespaces (seam 1)

`'offer:<monotone int>'` (`src/ui/HUD.js:421`) and `'mutation:<band 0-5>'` (`src/ui/HUD.js:383`)
cannot collide — different prefixes, and no consecration path opens a choice window today
(`showChoice` / `showMutationChoice` have exactly two call sites, both in `HUD.js`). The altar
paints prompt text only, as claimed. #204 will need a third prefix (`consecrate:<stage>` is the
obvious one, since the altar already uses `stageIndex` as its offer id).

One latent sharpness: HUD keys the mutation window on `e.band` although
`mutationChoiceOffered` already carries a monotone `offerId` (`src/systems/Items.js:849`). That is
safe only while a band is billed once per run (which commit `2f723ad` establishes); keying on
`e.offerId` would be unconditionally safe.

---

## What was verified clean, with evidence

All numbers below come from a purpose-built cross-lane probe driving the **real** merged classes —
`Corruption`, `Items`, `Vows`, `Telemetry`, `Chest`, `VoidBargain`, and the real `Interactables`
methods bound over a plain list — never a stub of the code under test.

### Seam 2 — Vows × chest transactions (the "silently-never-breaking vow" Critical)

- **(2c) void-credit OPEN breaks the restraint vow on the merged tree.** `Chest.interact`
  (`src/world/Interactables.js:428-431`) still emits `itemOffer { outcome: 'corrupt' }`, and
  `src/data/vows.js:107` reads it: one `itemOffer` emitted, `outcome=corrupt`, exactly one
  `vowResolved` with `kept=false, reason='broken'`. Payload shapes did **not** drift between lanes.
  The subsequent corrupt claim does not double-resolve.
- **(2b) A corrupt CLAIM through the real merged chest path breaks it exactly once.** Paid open →
  0 resolutions, vow still standing; `chest.answer('corrupt')` → exactly 1 `vowResolved`,
  `kept=false`.
- **(2a) `settleOpenOffers` emits `safe` and does not break the vow.** Two chests, `c1.interact()`
  then `c2.interact()`: exactly one `itemOfferResolved`, `outcome='safe'`, `offerId` equal to the
  **first** offer's id, `lapsed=false`; zero `vowResolved`. `chooseOffer` then resolved the surviving
  (newest) offer. Closing the stage produced `kept=true, warded=16`, `Corruption.warded === 16`, and
  `cor.world === 2 * SOURCES.chestTithe.small` — i.e. the vow ward did **not** scrub the world.
- Window lapse via `Chest.update(dt)` (200 × 0.1 s): one `itemOfferResolved`, `outcome='safe'`,
  `lapsed=true`, zero `vowResolved`.
- Consecration press with a restraint vow open: zero `vowResolved` — Sanctuary/Consecration correctly
  excluded from `CORRUPT_BARGAIN` (`src/data/vows.js:74`).

### Seam 3 — ruin emit × the altar region lane B edited

Real `VoidBargain` at band 4 after `cor.feed(player, 5000)`:

- `offer().kind === 'ruin'`, prompt renders, press returns `true`.
- **Exactly one** `voidBargain { kind: 'ruin' }` emit (`src/world/Interactables.js:2342`).
- `ledger.corrupt` moved by **exactly 24 = `weightOf('ruin')`** — no double-billing.
  `BARGAIN_COMMIT` (`src/systems/Corruption.js:32-37`) has no `ruin` key, as its comment claims.
- Restraint vow broke exactly once.
- Telemetry's isolated `onVoidBargain` handled the new kind: `record.brokenHooks === []`, and the row
  landed: `{"kind":"ruin","id":null,"marks":0,"world":5000,"band":4}`. No exhaustive switch.
- A spent altar refuses a second press; still exactly one ruin emit.

### Seam 4 — deterministic streams

| stream | salt multiplier | site |
|---|---|---|
| consecration preview (#173) | `0x85ebca6b` | `src/systems/Items.js:1897` |
| vow selection (#177) | `0x27d4eb2f` (+ fmix32) | `src/data/vows.js:155` |
| altar placement (#172) | `0x2545f491` | `src/world/Interactables.js:2983` |
| guaranteed font | `0x51f0ab8d` | `src/world/Interactables.js:2938` |
| `Items.stabilise` | `0x27d4eb2f` | `src/systems/Items.js:1088` |

No two of the four *in-range* streams share a constant. The one duplicate is `selectVow` /
`stabilise` — see m4, harmless in practice.

`ctx.rng` consumption on the merged tree, measured with a counting proxy:

- Vow selection consumes **zero** draws. (My probe initially flagged one; a stack-trace probe
  attributed it to the pre-existing `Items.rollEquipment` at `src/systems/Items.js:1917` on stage
  roll-over — identical count with and without `Vows` registered. See "Probe corrections".)
- 300 × (`altar.prompt()` + `signal()` + `consecrationPreview()`) consume **zero** draws.
- 200 × `chest.prompt()` consume **zero** draws — the new `claimOutcomeRange` quote is draw-free.
- `previewArgent` is pure in `(seed, key)` and samples without replacement (no card quoted twice).
- Vow selection is deterministic and roughly uniform over 2000 (seed, stage) pairs:
  684 / 688 / 628, spread 1.096.

### Seam 5 — HUD coexistence

- HUD installs its listeners exactly once: `bind(ctx)` has a single call site,
  `src/ui/HUD.js:261`, inside `init`. `itemOfferResolved` is registered once in HUD
  (`src/ui/HUD.js:432`) and once in Telemetry (`src/systems/Telemetry.js:415`). No leak.
- `mutationChoiceClosed` always carries `band` (single emit site, `src/systems/Items.js:963-965`,
  paired to the offer's `band` at `:848`), so the id-matched close cannot miss.
- Ordering under a double chest open is correct: `itemOffer` → `settleOpenOffers` →
  `itemOfferResolved(offer 1)` → `hideChoice('offer:1')` → `itemOfferOpened(offer 2)` →
  `showChoice('offer:2')`. The panel is never left showing a dead offer.
- The vow pill is present unconditionally in `TEMPLATE` (`src/ui/HUD.js:2038`) and collected at
  `:1862-1863`; `HUD.update` dereferences `refs.vowText` with the same unguarded pattern as
  `refs.objectiveText` (`src/ui/HUD.js:780`), and `HUD.critical === false`.
- Guest path: `Vows.init` publishes `ctx.vows` before its authority gate, so a guest has
  `vows.active === null` and `vows.line === ''` — an empty pill, no throw.

### Seam 6 — `Corruption.ward()` vs the salvage warding path

Both funnel through the single `_credit` door (`src/systems/Corruption.js:~470`); `bleed` calls it
with the clamped `taken`, `ward` calls it with the raw amount. Driven across a 40 boundary in one
stage with real chests and a real vow:

- salvages parked `_warded` at 24, the vow ward added exactly 16 → 40.
- `motes === floor(40 / 40) === 1`, up exactly 1 from 0.
- **exactly one** `argentMotesChanged` for the crossing — no double-mint.
- `corruptionWarded` amounts sum to `_warded` exactly (40 vs 40).
- `ward()` is authority-gated: a guest's `cor.ward(16)` returns 0 and leaves `warded === 0`.
- A vow ward does **not** move `cor.world` (verified separately in seam 2a).

### Telemetry hand-merge (explicitly requested)

- **Record init:** `itemClaims: []` and `vows: []` both present in the record literal; `_openVow = null`
  in the constructor (`src/systems/Telemetry.js:342`). Both tables populated at runtime in the probe.
- **Listener install:** `on('itemOfferResolved', this.onItemClaim)`, `on('vowOffered', ...)`,
  `on('vowResolved', ...)` all present at `src/systems/Telemetry.js:415-417`, all wrapped by
  `guard()`, which does `fn.call(this, payload)` — so the unbound method references are correctly
  re-bound. Verified live: rows land.
- **Handler bodies:** `onItemClaim` is owner-filtered via `isLocalOwner`; `onVowOffered` /
  `onVowResolved` deliberately are not (a vow has no owner on the event). `itemClaims` and the legacy
  `itemOffers` stay distinct — one chest open produced exactly one row in each:
  `itemClaims: [{"kind":"chest","itemId":"adrenal-syringe","outcome":"safe","corruption":0,"warded":0,"granted":"adrenal-syringe"}]`,
  `itemOffers.length === 1`. `record.brokenHooks === []` throughout.
- The one gap is m2 above.

### Co-op shape (host-local, two pawns with per-pawn packs)

`p1` and `p2` each with their own `Items` instance (`pawn.items`, the `src/systems/Items.js:593-596`
resolution path): `p2` opening chest B did **not** settle `p1`'s open offer (0 resolutions); both
seats held their own live offer; `openOfferFor` returned each seat's own; `p1`'s press resolved only
`p1`'s; the run-level restraint vow broke exactly once and `p2`'s later corrupt claim did not
re-resolve the closed vow.

---

## `npm run probe:coop` — NOT run, and why

No file under `src/net/` is touched anywhere in `a9bc08c..e0734b6` (full changed-file list is 28
files, none of them `NetHost.js`, `NetClient.js`, `Protocol.js`, `Coop.js`, or `Lobby*`). Nothing in
the range changes signalling, formation, or connection lifecycle, which is the trigger
`CLAUDE.md` sets for the probe. The four new events (`itemOfferOpened`, `itemOfferResolved`,
`vowOffered`, `vowResolved`) are not added to any broadcast or addressed-forward list, so no wire
message changed shape. The one co-op-visible consequence is host-local behaviour and is recorded as
i1.

## Probe corrections (stated for honesty about my own evidence)

One probe assertion of mine was mis-specified and I chased it down rather than reporting it:
"vow selection consumed no `ctx.rng` draw" failed at 0 → 1. A stack-trace-instrumented rerun with and
without `Vows` registered showed the identical single draw in both, attributed to
`Items.rollEquipment` (`src/systems/Items.js:1917`) on the stage roll-over — pre-existing, not from
`Vows`. `selectVow` is a pure function that takes no `ctx` at all and therefore cannot touch the
stream. Not a finding.

A second probe initially reported `p2` failing to open a chest; that was my fixture lacking a
per-pawn `Items` (`Items.of` returns `pawn.items`, which was unset). Corrected per the idiom in
`tests/items-per-pawn.test.mjs:41-43`; the real behaviour is clean.

## Commands run

```
git log --oneline a9bc08c..e0734b6 ; git diff --stat a9bc08c..e0734b6
git diff a9bc08c..e0734b6 -- src/systems/Telemetry.js
git diff a9bc08c..e0734b6 -- src/world/Interactables.js
git diff a9bc08c..e0734b6 -- src/systems/Corruption.js src/world/itemTransaction.js src/world/corruptionPrice.js
git diff a9bc08c..e0734b6 -- src/ui/HUD.js src/ui/Menus.js src/main.js src/data/alignment.js src/systems/Items.js
git diff a9bc08c..e0734b6 -- src/systems/Tutorial.js src/systems/Audio.js src/data/bandBoons.js src/data/items.js src/ui/hud.css
npm test                                   -> exit 0, 164/164 test files passed
npm run gates:cheap -- --quiet             -> exit 0, GATES CHEAP: PASSED (3/3 arms)
node xlane-probe.tmp.mjs                   -> 63 passed / 1 mis-specified (see corrections)
node xlane-probe2.tmp.mjs                  -> ctx.rng draw attribution
node xlane-probe3.tmp.mjs                  -> 5/5, runEnd ordering (m2 evidence)
node xlane-probe4.tmp.mjs                  -> 11/11, two-pawn offer scoping
node -e "... previewArgent seed sweep ..."  -> m1 evidence
node -e "... RNG first-draw sweep ..."      -> m1 evidence
```

All four `xlane-probe*.tmp.mjs` files were deleted after the run; `git status --porcelain` at close
shows only the pre-existing `M reviews/round9/coopprobe-base.json` and untracked `recorded-runs/`
that were present when this review began. No code was modified.

## Clean

Telemetry hand-merge, `Corruption._credit`/`ward`/`bleed`, `itemTransaction` offerId plumbing,
`Chest.answer`/`openOffer`/`update`, `Interactables._offerHolder`/`settleOpenOffers`/`chooseOffer`,
`Menus.showChoice`/`hideChoice` id discipline, HUD listener install and vow pill, `VoidBargain`
ruin branch and consecration preview, `claimOutcomeRange`/`biasTiers`, `alignment.js` `vowKept`
wiring, salt uniqueness across the four in-range streams, per-pawn offer scoping, guest-side
inertness.
