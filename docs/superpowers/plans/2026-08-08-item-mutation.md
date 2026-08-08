# Item Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At corruption thresholds a random held item stack mutates into its blight-tier counterpart — the corruption tier promoted from a lootable curiosity to the price the world extracts on its own; the last Phase 1 item of the launch design.

**Architecture:** No new system. `Items` (owner of the inventory and the existing blight transform `_settleBlight`) listens to `corruptionBand`: each upward threshold crossing at or above `MUTATION.minBand` converts one randomly chosen eligible base stack into its blight card via the existing `_set(..., 'corrupt')` semantics — so corruption charging, audio dedup, and client mirroring all work unchanged — and emits `itemMutated` for presentation. The pick is drawn from a derived `RNG` seeded per `(ctx.seed, band)` (the shrine-roll / void-bank precedent), so the shared `ctx.rng` stream is never touched. A peak-band guard makes bleed-then-reclimb oscillation mutate nothing twice. HUD announces via its existing `toast()`.

**Tech Stack:** Existing `BLIGHT_BY_BASE` map (`src/data/items.js:1848`), `Items._set` single mutation point, `RNG` from `src/core/MathUtil.js`, HUD `toast(text, tier, id)` (`src/ui/HUD.js:416`), headless self-running tests per repo convention.

## Global Constraints

- Systems are classes with `init(ctx)`; no system-to-system imports (`CONTRACTS.md`). Items reads the band from the `corruptionBand` payload — never from `ctx.corruption`.
- **Zero shared-stream displacement:** the mutation pick draws NOTHING from `ctx.rng`. Seed the derived stream `((ctx.seed >>> 0) ^ (0x6b2f8d43 * (band + 1))) >>> 0 || 1` per crossing. A test arm must prove a displaced `ctx.rng` does not change the pick.
- **Mutation is not an acquisition:** every inventory write uses the existing `reason: 'corrupt'` (per `CONTRACTS.md` and `Items._set`'s doc: "stacks the player already owns moved from one id to another"). `Corruption`'s `itemPickup` listener already exempts `'corrupt'` — a test arm must prove world corruption is unchanged by a mutation.
- Host authority: the listener gates on `ctx.authority`; clients mirror the result through the absolute-count `itemPickup` events `_set` already emits.
- Upward crossings only; one mutation per threshold crossed (a band jump 1→3 mutates twice, for bands 2 and 3); a band never mutates twice per run (peak guard, instance-scoped like the rest of Items' run state).
- Determinism: the eligible-stack list must be sorted by id before the pick — Map iteration order is insertion order, which differs between host and a test fixture.
- Tuning lives in exported constants: `MUTATION` in `src/data/corruption.js`.
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code — same shape as `tests/greed-marks.test.mjs`. Use real `Items`, real `Corruption`, real item data (pick eligible ids from `BLIGHT_BY_BASE` at test time rather than hardcoding names).
- `npm run gate:elite` must stay green with no baseline regeneration (nothing here touches enemies or the shared stream).

---

### Task 1: The mutation core — Items listens to the gauge

**Files:**
- Modify: `src/data/corruption.js` (add `MUTATION`)
- Modify: `src/systems/Items.js` (listener in `init`, `_mutateAt(band)` method, `_mutePeak` field)
- Test: `tests/item-mutation.test.mjs`

**Interfaces:**
- Consumes: `corruptionBand { band, prev }` event; `BLIGHT_BY_BASE` (already imported by Items); `RNG` (new import from `../core/MathUtil.js`); `ctx.seed`.
- Produces (Task 2 relies on these exact names):
  - `MUTATION = { minBand: 2 }` exported from `src/data/corruption.js`.
  - `itemMutated { baseId, blightId, count, band }` event, emitted after the two `_set` writes.
  - `Items._mutePeak` — highest band that has mutated this run (starts 0).
  - `_mutateAt(band) -> boolean` — mutates one stack for this threshold; false if nothing eligible.

- [ ] **Step 1: Write the failing test**

```js
// tests/item-mutation.test.mjs
// Real Items + real Corruption, real item data. The axis under test: the
// gauge's upward threshold crossings convert one held base stack into its
// blight counterpart, deterministically, off the shared rng, without charging.
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { BLIGHT_BY_BASE } from '../src/data/items.js';
import { MUTATION, BANDS } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority, seed: 424242, rng: new RNG(777), time: 0,
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, items, corruption, emitted };
}

// Two distinct base items that blight cards corrupt — from the real data, so
// the test never goes stale against the catalogue.
const bases = [...BLIGHT_BY_BASE.keys()].sort();
const baseA = bases[0], baseB = bases[1];
const blightOf = (id) => BLIGHT_BY_BASE.get(id).id;

console.log('crossing into minBand mutates exactly one eligible stack');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  items.give(baseB, 2);
  const worldBefore = corruption.world;
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - worldBefore);  // cross into minBand once
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 1, 'one mutation for one threshold');
  const { baseId, blightId, count, band } = mut[0].payload;
  ok(baseId === baseA || baseId === baseB, 'a held base was chosen');
  ok(blightId === blightOf(baseId), 'into its own counterpart');
  ok(band === MUTATION.minBand, 'stamped with the threshold that fired');
  ok(items.count(baseId) === 0, 'base stack gone');
  ok(items.count(blightId) === count && count > 0, 'blight stack holds the moved copies');
}

console.log('the pick ignores the shared rng stream');
{
  const a = makeCtx();
  const b = makeCtx();
  for (let i = 0; i < 7; i++) b.ctx.rng.next();          // displace B's shared stream
  for (const w of [a, b]) {
    w.items.give(baseA, 3);
    w.items.give(baseB, 2);
    w.corruption.feed(w.ctx.player, BANDS[MUTATION.minBand].at + 1);
  }
  const pick = (w) => w.emitted.find((e) => e.name === 'itemMutated')?.payload.baseId;
  ok(pick(a) !== undefined && pick(a) === pick(b), 'identical pick despite displaced ctx.rng');
}

console.log('mutation itself never feeds the gauge');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  const beforeFeed = corruption.world;                    // the give's own tier feed
  const fed = BANDS[MUTATION.minBand].at + 1 - beforeFeed;
  corruption.feed(ctx.player, fed);
  // Any wrongful charge for the mutation's 'corrupt' writes would land
  // synchronously inside this feed (the mutation runs inside the band event),
  // so the only honest check is arithmetic: world === exactly what was fed.
  ok(emitted.some((e) => e.name === 'itemMutated'), 'a mutation happened');
  ok(Math.abs(corruption.world - (beforeFeed + fed)) < 1e-9, 'world is exactly the feeds — the conversion charged nothing');
}

console.log('below minBand nothing mutates; downward crossings never mutate');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  corruption.feed(ctx.player, BANDS[1].at + 1);           // into band 1 only
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'band 1 is below the mutation floor');
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at - corruption.world + 1);  // into band 2
  ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'band 2 mutates');
  corruption.bleed(ctx.player, corruption.world);         // bleed to zero — bands walk down
  items.give(baseB, 2);
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1);  // reclimb into band 2
  ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'a reclaimed band never mutates twice');
}

console.log('a band jump crosses two thresholds and mutates twice');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  items.give(baseB, 2);
  corruption.feed(ctx.player, BANDS[3].at + 1);           // 0 -> band 3 in one lump
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 2, 'bands 2 and 3 each took a stack');
  ok(mut[0].payload.band === 2 && mut[1].payload.band === 3, 'in threshold order');
  ok(mut[0].payload.baseId !== mut[1].payload.baseId, 'two different stacks (both were eligible)');
}

console.log('nothing eligible, nothing mutated — and no event');
{
  const { ctx, corruption, emitted } = makeCtx();          // empty inventory
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1);
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'no eligible stack, no event');
}

console.log('a client never mutates');
{
  const { ctx, items, corruption, emitted } = makeCtx({ authority: false });
  items.counts.set(baseA, 3);                              // mirror state, set directly
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'authority-gated');
  ok(items.counts.get(baseA) === 3, 'mirror untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/item-mutation.test.mjs`
Expected: FAIL — `MUTATION` is not exported from data/corruption.js (import error), then after a stub export, arms fail with zero `itemMutated` events.

- [ ] **Step 3: Implement**

In `src/data/corruption.js`, after the `VOIDTOUCHED` block:

```js
/**
 * Item mutation — the gauge reaching into the inventory. Each upward band
 * crossing at or above `minBand` converts one randomly chosen held stack into
 * its blight counterpart (data/items.js BLIGHT_BY_BASE). Band 1 is exempt for
 * the same reason band 1 has no screen grade: Seeded is the warning, Blighted
 * is when the world starts taking.
 */
export const MUTATION = { minBand: 2 };
```

In `src/systems/Items.js`:

Imports — extend the data import with `MUTATION` from `'../data/corruption.js'` (new import line; Items already imports from `'../data/items.js'`), and add `RNG` to whatever it imports from `'../core/MathUtil.js'` (check the existing import line; add one if absent).

Constructor — with the other run-state fields:

```js
    // Highest band that has already taken a stack this run. Bleeding the gauge
    // down and reclimbing must not pay a second time — the threshold is a
    // one-way door, like the blight scar that never shrinks.
    this._mutePeak = 0;
```

`init(ctx)` — with the other listeners:

```js
    // The gauge reaching into the inventory (launch spec §1, expression 3).
    // Upward crossings only, one stack per threshold, never the same band
    // twice. The writes ride the 'corrupt' reason, so Corruption does not
    // re-charge and a client mirrors them like any other inventory change.
    ctx.events.on('corruptionBand', ({ band, prev }) => {
      if (!ctx.authority || band <= prev) return;
      for (let b = Math.max(prev + 1, MUTATION.minBand, this._mutePeak + 1); b <= band; b++) {
        this._mutePeak = b;
        this._mutateAt(b);
      }
    });
```

Method — next to `_settleBlight`, whose transform semantics it reuses:

```js
  /**
   * One threshold's toll: convert a random held base stack into its blight
   * card. The pick comes off a derived stream seeded per (run seed, band) —
   * one draw on ctx.rng here would displace every later shared roll relative
   * to a run whose inventory happened to differ, which is the sp-equivalence
   * hazard the shrine-type roll already documents. Eligible ids are sorted so
   * the pick cannot depend on Map insertion order.
   */
  _mutateAt(band) {
    const eligible = [];
    for (const [id, count] of this.counts) {
      if (count > 0 && BLIGHT_BY_BASE.has(id)) eligible.push(id);
    }
    if (!eligible.length) return false;
    eligible.sort();
    const rng = new RNG(((this.ctx.seed >>> 0) ^ (0x6b2f8d43 * (band + 1))) >>> 0 || 1);
    const baseId = rng.pick(eligible);
    const blight = BLIGHT_BY_BASE.get(baseId);
    const held = this.count(baseId);
    this._set(baseId, 0, 'corrupt');
    this._set(blight.id, this.count(blight.id) + held, 'corrupt');
    this.ctx.events.emit('itemMutated', { baseId, blightId: blight.id, count: held, band });
    return true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/item-mutation.test.mjs` — all arms PASS.
Run: `node tests/corruption-system.test.mjs && node tests/chest-void-credit.test.mjs && node tests/greed-marks.test.mjs` — the corruption-economy suites stay green.

- [ ] **Step 5: Commit**

```bash
git add src/data/corruption.js src/systems/Items.js tests/item-mutation.test.mjs
git commit -m "The gauge reaches into the pack: thresholds mutate a stack into blight"
```

---

### Task 2: The announcement, the contract, and the gates

**Files:**
- Modify: `src/ui/HUD.js` (toast on `itemMutated`)
- Modify: `CONTRACTS.md` (event row)
- Test: extend `tests/item-mutation.test.mjs` with one HUD-shape arm ONLY if HUD is headless-testable the way the branding test drives it — otherwise the toast is verified live in Step 3 and the omission recorded.

**Interfaces:**
- Consumes: `itemMutated { baseId, blightId, count, band }` (Task 1); HUD's `toast(text, tier, id)` (`src/ui/HUD.js:416`) and its existing event-listener registration idiom (see how it subscribes to `itemPickup` near line 321 — match it exactly).
- Produces: a blight-tier toast on every mutation; the documented event.

- [ ] **Step 1: Wire the toast**

In `src/ui/HUD.js`, next to the existing `itemPickup` subscription, register (adapting to the file's actual listener idiom and name lookup — `ITEM_BY_ID` may already be imported for the pickup toast; if not, import it the way the file imports its other data):

```js
    ctx.events.on('itemMutated', ({ baseId, blightId, count }) => {
      const base = ITEM_BY_ID.get(baseId), blight = ITEM_BY_ID.get(blightId);
      if (!blight) return;
      this.toast(`${base?.name || baseId} festers — ${count}x ${blight.name}`, 'blight', blightId);
    });
```

- [ ] **Step 2: Document the contract**

In `CONTRACTS.md`, add to the events table under `blightSeed`:

```markdown
| `itemMutated` | `{ baseId, blightId, count, band }` — a corruption threshold converted a held stack | Items |
```

- [ ] **Step 3: Verify live and run the gates**

- `npm test` — full suite green (now including `tests/item-mutation.test.mjs`).
- `npm run gate:elite` — green, no baseline regeneration (any diff here is a real regression: stop).
- Live (headless-probe if interactive play is impossible, following `tools/voidprobe.mjs` conventions): climb the gauge past band 2 while holding at least one mutatable base item → the stack visibly converts in the HUD strip, the blight-tier toast fires, world corruption shows no extra charge from the conversion. Record exactly which checks were performed and how.

- [ ] **Step 4: Commit**

```bash
git add src/ui/HUD.js CONTRACTS.md
git commit -m "The mutation announces itself: blight toast and a contract row"
```

---

### Task 3: The HUD learns what 'corrupt' means — tile retirement, no false acquisitions

Added during execution: Task 2's live probe surfaced two pre-existing HUD defects on the `reason: 'corrupt'` write path, one of which blocks this plan's own "the stack visibly converts in the HUD strip" check. `Items._settleBlight`'s docblock has said since round 6 that this fix belongs in HUD.js once "corruption makes it routine" — mutation makes it routine.

**Files:**
- Modify: `src/ui/HUD.js` (`onItemPickup`: retire a tile driven to zero; render no pickup toast/card for `reason: 'corrupt'` writes)
- Test: extend `tests/item-mutation.test.mjs` (the HUD arm added in Task 2 shows the prototype-driving idiom)

**Interfaces:**
- Consumes: `itemPickup { id, count, tier, delta, reason }` (`CONTRACTS.md` — `count` is the absolute new total; `'corrupt'` = stacks moved between ids, not an acquisition); the HUD strip's tile map and `toast()`.
- Produces: on a `'corrupt'` write with `count <= 0`, the item's strip tile is removed (not left with a blank badge); on any `'corrupt'` write, no pickup toast and no pickup card are rendered (the `itemMutated` toast from Task 2 is the mutation's only announcement; a taken blight card's own `'give'` still toasts). Non-`'corrupt'` behavior byte-identical.

- [ ] **Step 1: Write the failing test** — two arms in `tests/item-mutation.test.mjs`, using Task 2's HUD fixture idiom: (a) drive a mutation and assert the base item's tile is gone from the strip structure while the blight tile is present with the moved count; (b) count toasts rendered during the mutation — exactly one (the `itemMutated` blight toast), zero pickup toasts from the two `'corrupt'` writes.
- [ ] **Step 2: Run to verify both arms fail** for the stated reasons (stale tile present; three toasts).
- [ ] **Step 3: Implement** in `onItemPickup`: early behavior split on `e.reason === 'corrupt'` — skip the toast/card path entirely; and for any write with `e.count <= 0`, retire the tile (remove its element and map entry) instead of leaving a blank badge. Match the surrounding code's style; touch nothing else.
- [ ] **Step 4: Run** `node tests/item-mutation.test.mjs`, then `node tests/hud-strip-hold.test.mjs`, then `npm test` — all green.
- [ ] **Step 5: Commit**

```bash
git add src/ui/HUD.js tests/item-mutation.test.mjs
git commit -m "The strip tells the truth: corrupt writes retire tiles and stay quiet"
```

---

## Self-review notes

- **Spec coverage:** "At corruption thresholds, a random item stack mutates into its corrupted counterpart" ✓ (Task 1 — per-threshold, random, derived-stream); "the existing corruption tier promoted" ✓ (reuses `BLIGHT_BY_BASE` + `_set('corrupt')` — no new item content); "Mutations are stronger, with teeth" ✓ by construction (blight cards already carry their trade-offs); "mutation rolls: headless unit tests, deterministic" ✓ (Task 1 arms, displaced-stream proof). Deferred deliberately: client-side toast in co-op (corruption replication is its own later plan — clients mirror the inventory change but have no band context), mutation VFX on the HUD strip tile (presentation pass).
- **Type consistency:** `MUTATION.minBand`, `itemMutated { baseId, blightId, count, band }`, `_mutateAt(band) -> boolean`, `_mutePeak` used identically across both tasks.
- **Known execution-time checks (deliberate):** Items' exact MathUtil import line (Task 1 Step 3); HUD's listener registration idiom and whether `ITEM_BY_ID` is already imported there (Task 2 Step 1); whether HUD is headless-testable for the toast arm (Task 2 preamble).
