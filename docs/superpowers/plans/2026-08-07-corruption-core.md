# Corruption Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The corruption gauge exists and moves: chests charge a corruption tithe, broke players can force chests open on void credit, item pickups feed the gauge by tier, greed time doubles the price, and the HUD shows the world band.

**Architecture:** One new engine system (`src/systems/Corruption.js`) that owns per-player corruption, the world sum, and band thresholds; one new data module (`src/data/corruption.js`) for tuning. Everything else integrates via existing seams — the chest interactable calls `ctx.corruption.feed(...)`, item feeds ride the existing `itemPickup` event, greed time rides `teleporterComplete`/`stageStart`. No other system imports Corruption; they reach it through `ctx.corruption` or events, per `CONTRACTS.md`.

**Tech Stack:** Vanilla JS ES modules, three.js (headless-safe in tests), the repo's own test harness (`node tests/run.mjs`, plain `ok()` assertions, deterministic LCG fixtures).

## Global Constraints

- Systems are classes with `init(ctx)` + optional `fixedUpdate(ctx, h)` / `update(ctx, dt)`; never import one system from another (`CONTRACTS.md`).
- Every state change gates on `ctx.authority`. Clients never mutate corruption.
- **The corruption core must draw from `ctx.rng` zero times.** Feeds are deterministic sums; there are no rolls in this plan. This is what keeps `sp-equivalence` and the shot-harness baselines green by construction. (Mutation rolls arrive in a later plan on a derived stream.)
- Cosmetic randomness, if any, uses `ctx.fxRng` — but this plan needs none.
- Tests: `tests/<name>.test.mjs`, self-running, `ok(cond, msg)` + exit code, LCG rng fixture — copy the shape of `tests/enemy-targeting.test.mjs`.
- Scope explicitly deferred to later plans: blight *visuals*, Voidtouched elites, item mutation, shrine feeds, cleansing fonts, pact shrines, co-op replication of corruption state (HUD on clients reads 0 until that plan), per-pawn attribution in co-op (all feeds attribute to `ctx.player` for now).
- Design decision (not an oversight): void credit is only offered when the player cannot afford the chest. A rich player always pays gold.

---

### Task 1: Corruption tuning data

**Files:**
- Create: `src/data/corruption.js`
- Test: `tests/corruption-data.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `BANDS` (array of `{ id, name, at }`, ascending `at`, ids 0–4), `SOURCES` (`{ chestTithe: {small,large,legendary}, voidCredit: {small,large,legendary}, itemFeed: {<tier>: number}, greedMult: number }`), `bandOf(world) -> 0..4`.

- [ ] **Step 1: Write the failing test**

```js
// tests/corruption-data.test.mjs
import { BANDS, SOURCES, bandOf } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('bands are a readable ladder');
ok(BANDS.length === 5, 'five bands, T0-T4');
ok(BANDS[0].at === 0 && BANDS[0].name === 'Pristine', 'T0 is Pristine at 0');
ok(BANDS.every((b, i) => i === 0 || b.at > BANDS[i - 1].at), 'thresholds strictly ascend');
ok(BANDS.every((b, i) => b.id === i), 'ids are their indices');

console.log('bandOf maps world corruption to the band whose threshold it has passed');
ok(bandOf(0) === 0, 'zero is Pristine');
ok(bandOf(BANDS[1].at - 0.001) === 0, 'just under T1 is still T0');
ok(bandOf(BANDS[1].at) === 1, 'exactly T1 enters band 1');
ok(bandOf(BANDS[4].at + 1000) === 4, 'no band above Consumed');
ok(bandOf(-5) === 0, 'negative clamps to Pristine');

console.log('sources are positive and shaped for their call sites');
for (const k of ['small', 'large', 'legendary']) {
  ok(SOURCES.chestTithe[k] > 0, `chestTithe.${k} positive`);
  ok(SOURCES.voidCredit[k] > SOURCES.chestTithe[k] * 3, `voidCredit.${k} is a steep multiple of the tithe`);
}
ok(SOURCES.itemFeed.common > 0, 'common items feed');
ok(SOURCES.itemFeed.blight >= SOURCES.itemFeed.legendary, 'corrupted-tier items feed most (spec)');
ok(SOURCES.greedMult > 1, 'greed time multiplies');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/corruption-data.test.mjs`
Expected: FAIL to load — `Cannot find module '../src/data/corruption.js'`

- [ ] **Step 3: Write the data module**

```js
// src/data/corruption.js
/**
 * Corruption tuning. One number drives the run's second economy: corruption is
 * the price tag on greed, and the player always chose it (see
 * docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md).
 *
 * Every value here is a playtest dial, not a law. The Phase-1 gate is "does
 * 'should we open that chest' become a real decision" — tune toward that.
 */

/** World-corruption thresholds. A band is entered at `at` and holds until the next. */
export const BANDS = [
  { id: 0, name: 'Pristine', at: 0 },
  { id: 1, name: 'Seeded', at: 20 },
  { id: 2, name: 'Blighted', at: 55 },
  { id: 3, name: 'Overrun', at: 110 },
  { id: 4, name: 'Consumed', at: 190 },
];

export const SOURCES = {
  // Paid chest opens: gold price unchanged, plus this tithe.
  chestTithe: { small: 2, large: 5, legendary: 12 },
  // Forced opens with no gold: the void extends credit, at a steep multiple.
  voidCredit: { small: 10, large: 22, legendary: 45 },
  // Per item that lands in an inventory, by tier. Unknown tiers fall back to 1.
  itemFeed: { common: 1, uncommon: 2, legendary: 5, boss: 5, lunar: 8, blight: 8, equipment: 2 },
  // Feeds after the teleporter event completes are multiplied by this.
  greedMult: 2.0,
};

export function bandOf(world) {
  let band = 0;
  for (let i = 0; i < BANDS.length; i++) if (world >= BANDS[i].at) band = i;
  return band;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/corruption-data.test.mjs`
Expected: PASS, `13 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/data/corruption.js tests/corruption-data.test.mjs
git commit -m "Corruption gets its tuning table: five bands and the price of greed"
```

---

### Task 2: The Corruption system — feed, attribution, bands, events

**Files:**
- Create: `src/systems/Corruption.js`
- Test: `tests/corruption-system.test.mjs`

**Interfaces:**
- Consumes: `BANDS`, `SOURCES`, `bandOf` from `src/data/corruption.js`; `ctx.authority`, `ctx.events` (`emit`/`on`), `ctx.player`.
- Produces (later tasks and plans rely on these exact names):
  - `ctx.corruption` set by `init(ctx)`.
  - `feed(player, amount, position) -> number` — host-only; returns the amount actually added (post greed multiplier), `0` on non-authority or bad input.
  - `seed(position, strength) -> void` — records a blight seed `{ x, z, strength }`, emits `blightSeed`.
  - `corruptionOf(player) -> number`, `get world() -> number`, `get band() -> 0..4`.
  - `seeds` — readonly array of `{ x, z, strength }`, capped at 64 (oldest dropped).
  - Events emitted: `corruptionChanged { world, band }` on every non-zero feed; `corruptionBand { band, prev }` when the band index changes; `blightSeed { x, z, strength }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/corruption-system.test.mjs
import { Corruption } from '../src/systems/Corruption.js';
import { BANDS, SOURCES } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    events: {
      emit(name, payload) {
        emitted.push({ name, payload });
        for (const fn of listeners.get(name) || []) fn(payload);
      },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
    },
  };
  return { ctx, emitted };
}

const P = () => ({ isPlayer: true, alive: true });

console.log('feeds accumulate per player and sum to world');
{
  const { ctx } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  ok(ctx.corruption === c, 'init claims ctx.corruption');
  const a = P(), b = P();
  ok(c.feed(a, 10) === 10, 'feed returns what it added');
  c.feed(b, 5);
  ok(c.corruptionOf(a) === 10 && c.corruptionOf(b) === 5, 'attribution is per player');
  ok(c.world === 15, 'world is the sum');
  ok(c.corruptionOf(P()) === 0, 'an unknown player reads zero');
}

console.log('a client cannot mutate corruption');
{
  const { ctx } = makeCtx({ authority: false });
  const c = new Corruption();
  c.init(ctx);
  ok(c.feed(P(), 50) === 0, 'feed returns 0 without authority');
  ok(c.world === 0, 'nothing accumulated');
}

console.log('bad input is inert');
{
  const { ctx } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  ok(c.feed(null, 10) === 0, 'null player');
  ok(c.feed(P(), 0) === 0, 'zero amount');
  ok(c.feed(P(), -4) === 0, 'negative amount');
  ok(c.feed(P(), NaN) === 0, 'NaN amount');
  ok(c.world === 0, 'world untouched by all of it');
}

console.log('band events fire exactly on threshold crossings');
{
  const { ctx, emitted } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  const p = P();
  c.feed(p, BANDS[1].at - 1);
  ok(c.band === 0, 'still Pristine just under T1');
  ok(!emitted.some((e) => e.name === 'corruptionBand'), 'no band event yet');
  c.feed(p, 1);
  ok(c.band === 1, 'entered Seeded');
  const bandEvents = emitted.filter((e) => e.name === 'corruptionBand');
  ok(bandEvents.length === 1, 'exactly one band event');
  ok(bandEvents[0].payload.band === 1 && bandEvents[0].payload.prev === 0, 'payload carries band and prev');
  c.feed(p, BANDS[4].at); // vaults several bands at once
  const last = emitted.filter((e) => e.name === 'corruptionBand').pop();
  ok(last.payload.band === 4, 'a vaulting feed lands on the final band');
  const changed = emitted.filter((e) => e.name === 'corruptionChanged');
  ok(changed.length === 3, 'corruptionChanged fired once per non-zero feed');
  ok(changed.every((e) => typeof e.payload.world === 'number' && typeof e.payload.band === 'number'),
    'corruptionChanged carries world and band');
}

console.log('greed time multiplies feeds between teleporterComplete and stageStart');
{
  const { ctx } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  const p = P();
  c.feed(p, 10);
  ctx.events.emit('teleporterComplete', {});
  ok(c.feed(p, 10) === 10 * SOURCES.greedMult, 'post-completion feed pays the greed multiplier');
  ctx.events.emit('stageStart', { index: 1, name: 'x' });
  ok(c.feed(p, 10) === 10, 'a new stage resets greed time');
}

console.log('seeds are recorded, broadcast, and capped');
{
  const { ctx, emitted } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  c.seed({ x: 3, y: 0, z: -7 }, 2);
  ok(c.seeds.length === 1 && c.seeds[0].x === 3 && c.seeds[0].z === -7 && c.seeds[0].strength === 2,
    'seed stores x, z, strength');
  ok(emitted.some((e) => e.name === 'blightSeed' && e.payload.x === 3), 'blightSeed event emitted');
  for (let i = 0; i < 100; i++) c.seed({ x: i, y: 0, z: 0 }, 1);
  ok(c.seeds.length === 64, 'seed list capped at 64');
  ok(c.seeds[0].x === 37, 'oldest seeds dropped first');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/corruption-system.test.mjs`
Expected: FAIL to load — `Cannot find module '../src/systems/Corruption.js'`

- [ ] **Step 3: Write the system**

```js
// src/systems/Corruption.js
import { bandOf, SOURCES } from '../data/corruption.js';

/**
 * The run's second economy. Corruption rises only through choices — chest
 * tithes, void credit, item pickups, greed time — and never passively. This
 * system owns the numbers and the band events; what the world *does* about
 * them (blight visuals, Voidtouched spawns, route gates) belongs to the
 * systems that listen.
 *
 * Host-authoritative like every other state change: `feed` is a no-op off the
 * host, and clients will learn the world value from replication (later plan).
 * Deliberately consumes NO ctx.rng draws — there is nothing to roll here, and
 * staying off the shared stream is what keeps sp-equivalence green.
 */
const MAX_SEEDS = 64;

export class Corruption {
  constructor() {
    this._byPlayer = new Map();   // player entity -> corruption
    this._world = 0;
    this._band = 0;
    this._greed = false;
    this.seeds = [];              // { x, z, strength }, oldest first
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.corruption = this;
    // Greed time: looting after the teleporter has finished is the one
    // passive-looking source, and it is still a choice — leaving is free.
    ctx.events.on('teleporterComplete', () => { this._greed = true; });
    ctx.events.on('stageStart', () => { this._greed = false; });
  }

  get world() { return this._world; }
  get band() { return this._band; }
  corruptionOf(player) { return this._byPlayer.get(player) || 0; }

  /**
   * Add corruption, attributed to `player`. Returns the amount actually added
   * (after the greed multiplier), 0 when refused. `position` is advisory —
   * callers that mark a place also call `seed()`; feed itself plants nothing.
   */
  feed(player, amount, position = null) {
    if (!this.ctx?.authority) return 0;
    if (!player || !(amount > 0)) return 0;   // rejects 0, negatives and NaN in one test
    const added = this._greed ? amount * SOURCES.greedMult : amount;
    this._byPlayer.set(player, (this._byPlayer.get(player) || 0) + added);
    this._world += added;
    const prev = this._band;
    this._band = bandOf(this._world);
    this.ctx.events.emit('corruptionChanged', { world: this._world, band: this._band });
    if (this._band !== prev) this.ctx.events.emit('corruptionBand', { band: this._band, prev });
    return added;
  }

  /** Record where greed happened. The blight-visuals plan grows fields from these. */
  seed(position, strength = 1) {
    if (!this.ctx?.authority || !position) return;
    const s = { x: position.x, z: position.z, strength };
    this.seeds.push(s);
    if (this.seeds.length > MAX_SEEDS) this.seeds.shift();
    this.ctx.events.emit('blightSeed', s);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/corruption-system.test.mjs`
Expected: PASS, `24 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/systems/Corruption.js tests/corruption-system.test.mjs
git commit -m "The Corruption system: greed is metered, attributed, and announced"
```

---

### Task 3: Chest tithe and void credit

**Files:**
- Modify: `src/world/Interactables.js` — the `Chest` class (`prompt()` around line 322, `interact()` around line 324) and the file's imports.
- Test: `tests/chest-void-credit.test.mjs`

**Interfaces:**
- Consumes: `ctx.corruption.feed(player, amount, position)` and `ctx.corruption.seed(position, strength)` from Task 2; `SOURCES` from Task 1; existing `ctx.items.spendGold(cost)`, `ctx.items.rollItem(null, bias)`, `ctx.interactables.spawnOrb(...)`.
- Produces: the two chest open paths. Paid: gold spent + `chestTithe[size]` corruption. Forced (insufficient gold): no gold, `voidCredit[size]` corruption + a blight seed of strength 1/2/3 for small/large/legendary. No corruption system present (harness contexts) → behaviour identical to today.

- [ ] **Step 1: Write the failing test**

```js
// tests/chest-void-credit.test.mjs
// Real Corruption, stubbed Items — the axis under test is who pays what, not
// the loot table. Chest is not exported, so drive it through
// Interactables.populate? No: construct it via the module's export seam —
// Interactables.js does not export Chest, so this test goes through a tiny
// fixture: a chest-shaped interactable is obtained by calling
// `interactables.populate` on a stubbed stage... that drags in the whole
// world. Instead: export Chest for tests (see Step 3 — add `export` to the
// class declaration; it changes no behaviour).
import * as THREE from 'three';
import { Chest } from '../src/world/Interactables.js';
import { Corruption } from '../src/systems/Corruption.js';
import { SOURCES } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ gold = 1000 } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    items: {
      gold,
      spendGold(cost) { if (this.gold < cost) return false; this.gold -= cost; return true; },
      rollItem() { return 'syringe'; },
    },
    interactables: { orbs: [], spawnOrb(pos, id) { this.orbs.push(id); } },
    audio: null,
  };
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

console.log('a paid open spends gold and pays the tithe');
{
  const ctx = makeCtx({ gold: 100 });
  const chest = new Chest(ctx, new THREE.Vector3(4, 0, 9), 'small', 25);
  ok(chest.interact() === true, 'open succeeds');
  ok(ctx.items.gold === 75, 'gold was spent');
  ok(ctx.corruption.world === SOURCES.chestTithe.small, 'the tithe landed');
  ok(ctx.corruption.seeds.length === 0, 'a paid open plants no seed');
  ok(ctx.interactables.orbs.length === 1, 'the item came out');
  ok(chest.used === true, 'chest consumed');
}

console.log('a broke player forces the chest open on void credit');
{
  const ctx = makeCtx({ gold: 3 });
  const chest = new Chest(ctx, new THREE.Vector3(-2, 0, 6), 'legendary', 400);
  ok(chest.interact() === true, 'the void opens it');
  ok(ctx.items.gold === 3, 'no gold taken');
  ok(ctx.corruption.world === SOURCES.voidCredit.legendary, 'the full credit price landed');
  ok(ctx.corruption.seeds.length === 1, 'and the void remembers where');
  ok(ctx.corruption.seeds[0].strength === 3, 'legendary seeds are the strongest');
  ok(ctx.interactables.orbs.length === 1, 'the item still came out');
}

console.log('the prompt tells the player which price they are about to pay');
{
  const ctx = makeCtx({ gold: 100 });
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  ok(chest.prompt().includes('$25'), 'affordable chest quotes gold');
  ctx.items.gold = 3;
  ok(/corruption/i.test(chest.prompt()), 'unaffordable chest says corruption');
}

console.log('without a corruption system, behaviour is exactly the old one');
{
  const ctx = makeCtx({ gold: 3 });
  ctx.corruption = null;
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  ok(chest.interact() === false, 'a broke player is refused, as before');
  ok(chest.used === false, 'chest untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/chest-void-credit.test.mjs`
Expected: FAIL — `Chest` is not exported (SyntaxError on the named import).

- [ ] **Step 3: Modify Interactables.js**

Three edits:

1. Add to the imports at the top of `src/world/Interactables.js`:

```js
import { SOURCES } from '../data/corruption.js';
```

2. Export the class (no behaviour change): `class Chest extends Interactable {` → `export class Chest extends Interactable {`

3. Replace `Chest.prompt()` and `Chest.interact()`:

```js
  prompt() {
    const name = this.size === 'legendary' ? 'Legendary Chest' : this.size === 'large' ? 'Large Chest' : 'Chest';
    // When the gold isn't there and the void will extend credit, the prompt is
    // the informed-consent line: the player must know which price they are
    // about to pay. `gold` may be undefined on stub contexts — treat as broke.
    const gold = this.ctx.items?.gold ?? 0;
    if (this.ctx.corruption && gold < this.cost) return `${name} — pay in corruption`;
    return `${name} ($${this.cost})`;
  }

  interact() {
    const cor = this.ctx.corruption;
    if (this.ctx.items?.spendGold(this.cost)) {
      // Paid open: gold as before, plus the tithe. The void takes its cut of
      // every transaction; it just doesn't leave a mark on this one.
      cor?.feed(this.ctx.player, SOURCES.chestTithe[this.size] ?? SOURCES.chestTithe.small, this.position);
    } else if (cor) {
      // Void credit: the most deliberate corruption choice in the game. Steep
      // lump, and a seed planted where it happened.
      cor.feed(this.ctx.player, SOURCES.voidCredit[this.size] ?? SOURCES.voidCredit.small, this.position);
      cor.seed(this.position, this.size === 'legendary' ? 3 : this.size === 'large' ? 2 : 1);
    } else {
      return false;
    }
    this.used = true;
    this.openT = 0;
    const id = this.ctx.items.rollItem(null, TIER_BIAS[this.size]);
    this.ctx.interactables.spawnOrb(this.position, id, 1.2 * this._scale);
    this.ctx.audio?.play?.('chest', this.position);
    return true;
  }
```

Note: `TIER_BIAS` already exists in the file; do not redeclare it. If `ctx.items.gold` is not a public field on the real Items system (check `src/systems/Items.js` — search `get gold` / `this.gold`), add a `get gold()` accessor there returning the current gold; the `goldChanged { gold }` event in `CONTRACTS.md` shows the number already exists internally.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/chest-void-credit.test.mjs`
Expected: PASS, `14 passed, 0 failed`

- [ ] **Step 5: Run the whole suite — the chest changed under every existing harness**

Run: `npm test`
Expected: all test files pass. If a harness context trips on the new `ctx.corruption` reads, they are all behind `?.` / `if (cor)` guards — investigate before patching.

- [ ] **Step 6: Commit**

```bash
git add src/world/Interactables.js tests/chest-void-credit.test.mjs
git commit -m "Chests charge the tithe, and the void extends credit to the broke"
```

---

### Task 4: Item pickups feed the gauge

**Files:**
- Modify: `src/systems/Corruption.js` (extend `init`)
- Test: extend `tests/corruption-system.test.mjs`

**Interfaces:**
- Consumes: the existing `itemPickup { id, count }` event (emitted by Items, `CONTRACTS.md`); `ITEM_BY_ID` from `src/data/items.js`; `SOURCES.itemFeed`.
- Produces: every item that lands in the local inventory feeds `itemFeed[tier] * count`, attributed to `ctx.player`. Unknown tier feeds 1 per count.

- [ ] **Step 1: Write the failing test — append to tests/corruption-system.test.mjs**

Add `import { ITEM_BY_ID } from '../src/data/items.js';` to the imports, then append before the final summary lines:

```js
console.log('item pickups feed by tier through the itemPickup event');
{
  const { ctx } = makeCtx();
  ctx.player = P();
  const c = new Corruption();
  c.init(ctx);
  // Find one real item of a known tier so the test tracks the live item table.
  const common = [...ITEM_BY_ID.values()].find((i) => i.tier === 'common');
  ctx.events.emit('itemPickup', { id: common.id, count: 2 });
  ok(c.world === SOURCES.itemFeed.common * 2, `two commons feed ${SOURCES.itemFeed.common * 2} (got ${c.world})`);
  ctx.events.emit('itemPickup', { id: 'not-a-real-item', count: 1 });
  ok(c.world === SOURCES.itemFeed.common * 2 + 1, 'unknown items feed the fallback 1');
}
```

- [ ] **Step 2: Run test to verify the new arm fails**

Run: `node tests/corruption-system.test.mjs`
Expected: the new arm FAILS (`got 0`); all earlier arms still pass.

- [ ] **Step 3: Extend Corruption.init**

Add to the imports of `src/systems/Corruption.js`:

```js
import { ITEM_BY_ID } from '../data/items.js';
```

Append inside `init(ctx)`, after the `stageStart` subscription:

```js
    // Items feed by tier. Riding the event rather than patching Items keeps
    // the systems decoupled (CONTRACTS.md) and means blight transforms, chest
    // bursts and shop buys all pay without knowing corruption exists. `feed`
    // is authority-gated, so the same event firing on a client is inert.
    ctx.events.on('itemPickup', ({ id, count = 1 }) => {
      const tier = ITEM_BY_ID.get(id)?.tier;
      this.feed(ctx.player, (SOURCES.itemFeed[tier] ?? 1) * count);
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/corruption-system.test.mjs`
Expected: PASS, all arms.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Corruption.js tests/corruption-system.test.mjs
git commit -m "Every item pays its corruption feed, priced by tier"
```

---

### Task 5: Register the system and show the gauge

**Files:**
- Modify: `src/main.js` (system registration), `src/ui/HUD.js` (template, refs, update poll), the HUD stylesheet (find it: `grep -rn "hud" index.html src/ui/*.css` — HUD styles may be inline in `index.html` or a css file; put the new rules with the existing HUD block).
- Test: manual verification (DOM systems have no headless harness in this repo; the polled value is already covered by Task 2's unit tests).

**Interfaces:**
- Consumes: `ctx.corruption.world`, `.band` (Task 2); `BANDS` from `src/data/corruption.js`.
- Produces: a corruption gauge on the HUD — thin bar + band name, visible from run start, restyled per band via a `data-band` attribute.

- [ ] **Step 1: Register Corruption in main.js**

In `src/main.js`, locate the system-registration block (search for `new Director()`). Add, with the other system imports:

```js
import { Corruption } from './systems/Corruption.js';
```

and register it immediately after the Combat system is added (corruption has no frame hooks, so order barely matters — but it must exist before HUD reads `ctx.corruption`):

```js
engine.add(new Corruption());
```

Match the exact `add`/registration call shape used by the neighbouring systems in that block — copy their form, whatever it is (`engine.add(...)` or `systems.push(...)`).

- [ ] **Step 2: Add the gauge to the HUD template**

In `src/ui/HUD.js`: find the `TEMPLATE` and add, adjacent to the gold/money readout markup:

```html
<div class="corruption" data-ref="corruption" data-band="0">
  <div class="corruption-fill" data-ref="corruptionFill"></div>
  <b class="corruption-band" data-ref="corruptionBand">Pristine</b>
</div>
```

If `collectRefs` keys on a different attribute than `data-ref` (check its implementation ~line 93), use whatever attribute the existing refs use — the three ref names stay `corruption`, `corruptionFill`, `corruptionBand`.

- [ ] **Step 3: Poll it in the HUD update**

In the HUD's per-frame update (the method that polls gold — search `goldChanged` comment "value polled in update"), add:

```js
    // Corruption gauge: world value + band, polled like gold. Band 4's `at` is
    // the top of the bar; past it the bar just stays full.
    const cor = this.ctx.corruption;
    if (cor && this.refs.corruption) {
      const top = BANDS[BANDS.length - 1].at;
      const frac = Math.min(1, cor.world / top);
      this.set('corruptionFrac', Math.round(frac * 100), (v) => {
        this.refs.corruptionFill.style.width = `${v}%`;
      });
      this.set('corruptionBand', cor.band, (v) => {
        this.refs.corruption.dataset.band = String(v);
        this.refs.corruptionBand.textContent = BANDS[v].name;
      });
    }
```

Add `import { BANDS } from '../data/corruption.js';` to HUD.js's imports. Use the file's existing `this.set(key, value, apply)` change-detection helper (visible at lines 457–567) so the DOM only writes on change.

- [ ] **Step 4: Style it**

With the existing HUD styles, add:

```css
.corruption { position: relative; width: 180px; height: 6px; background: rgba(20, 12, 30, 0.55); border: 1px solid rgba(160, 120, 255, 0.25); border-radius: 3px; }
.corruption-fill { height: 100%; width: 0%; background: #7a4fd0; border-radius: 2px; transition: width 0.3s ease; }
.corruption-band { position: absolute; left: 0; top: 8px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #b9a1e8; }
.corruption[data-band="2"] .corruption-fill { background: #9a3fe0; }
.corruption[data-band="3"] .corruption-fill { background: #c72fd6; box-shadow: 0 0 6px #c72fd6; }
.corruption[data-band="4"] .corruption-fill { background: #ff2fb0; box-shadow: 0 0 10px #ff2fb0; }
```

Place the gauge element near the gold readout in the layout (same container), so the two prices of the same transaction read together.

- [ ] **Step 5: Verify by playing**

Run: `npm run dev`, start a run, and confirm:
- Gauge visible at 0 / "Pristine" on stage 1.
- Opening a chest nudges the fill (tithe).
- Spending down to broke and using a chest opens it anyway; the gauge jumps hard and the prompt said "pay in corruption" beforehand.
- Loot after the teleporter completes and watch feeds land double (compare two identical chests before/after completion).
- Band label changes as thresholds cross.

Also run: `npm test` — expected all green (HUD/main changes have no headless coverage, this catches accidental import breakage via the harness tests that boot systems).

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/ui/HUD.js index.html
git commit -m "The corruption gauge reaches the HUD, next to the price it shadows"
```

(Adjust the `git add` list if the styles landed in a css file instead of `index.html`.)

---

### Task 6: Full-suite gate and baseline check

**Files:**
- None created; verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: the green light for the next plan (blight visuals).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all test files pass, including the three new ones.

- [ ] **Step 2: sp-equivalence spot check**

Run: `npm run gate:elite`
Expected: passes unchanged — the corruption core draws nothing from `ctx.rng`, so the elite-DPS fingerprint must be byte-identical. If this gate moves, something in this plan touched the shared stream: find it before proceeding (nothing in this plan may roll).

- [ ] **Step 3: Commit any stragglers and mark the plan done**

```bash
git status --short   # should be clean; commit anything intentional that remains
```

---

## Self-review notes

- **Spec coverage (this slice):** chest tithe ✓ (Task 3), void credit + seed ✓ (Task 3), item feeds by tier with blight-tier highest ✓ (Tasks 1, 4), greed time ✓ (Task 2), bands T0–T4 with names ✓ (Tasks 1, 2), HUD gauge ✓ (Task 5), authority gating ✓ (Task 2), no-rng constraint ✓ (global + Task 6 gate). Deferred items are listed in Global Constraints, matching the plan-split note.
- **Known execution-time checks (deliberate, not placeholders):** `ctx.items.gold` accessor existence (Task 3 Step 3 note), `collectRefs` attribute convention and the exact `TEMPLATE`/style locations (Task 5) — the implementer verifies against the live file rather than trusting a line number that may drift.
- **Type consistency:** `feed(player, amount, position?) -> number`, `seed(position, strength) -> void`, `seeds: {x,z,strength}[]`, events `corruptionChanged {world, band}` / `corruptionBand {band, prev}` / `blightSeed {x,z,strength}` are used identically in Tasks 2–5.
