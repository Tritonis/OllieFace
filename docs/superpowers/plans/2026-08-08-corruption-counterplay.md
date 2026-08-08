# Corruption Counterplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two counterplay interactables from the launch design — a cleansing font that bleeds world corruption for gold, and a pact shrine that lets a player voluntarily shoulder a share of a teammate's corruption. Phase 2 slice 2 (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md` §1 counterplay, §2 co-op).

**Architecture:** Two new `Interactable` subclasses in `src/world/Interactables.js` (the Argent Font and the Covenant Stone), drawn from the existing `_populateShrines` bag on its private shrine stream. The font pays `Corruption.bleed` (the counterplay valve that already exists); the pact rides a new `Corruption.transfer(from, to, amount)` that moves attribution between players without touching world corruption or the band. Tuning in exported constants `CLEANSE` and `PACT` in `src/data/corruption.js`.

**Tech Stack:** Existing `Interactable` base + `sharedGeo`/material helpers (`src/world/Interactables.js`), `Corruption` (`src/systems/Corruption.js`), `ctx.roster` (`src/systems/Roster.js`), headless self-running tests per repo convention.

## Global Constraints

- Systems are classes with `init(ctx)`; no system-to-system imports (`CONTRACTS.md`). Interactables reach corruption via `ctx.corruption`, players via `ctx.roster`.
- **Zero shared-stream displacement:** neither interactable draws from `ctx.rng` — the font and the pact roll nothing. Their bag entries ride `_populateShrines`' private `_shrineRng` stream (seeded per `(ctx.seed, stageIndex)`), which is not shared state; the gate draws (`ctx.rng.next() >= gates[n]`) are untouched in count and order.
- Host authority: `Corruption.bleed`/`transfer` are authority-gated; `populate` runs host-only already. Clients mirror the props through existing interactable replication.
- **Counterplay is costly, never free** (spec §1): the font charges gold and its price climbs per use; the pact costs the volunteer real corruption on their own ledger.
- Cleansing and pacting are NOT greed acts: neither calls `markGreed()` and neither feeds the gauge — no seed, no tithe. (The spec's "every greed act plants a seed" covers item-granting/trade uses; these grant no items and take nothing from the world.)
- Wire safety: `TYPE_ID` is append-only, never renumber — `argentFont: 13`, `covenantStone: 14`.
- Tuning lives in exported constants: `CLEANSE`, `PACT` in `src/data/corruption.js`.
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code — same fixture shape as `tests/greed-marks.test.mjs` (real interactable classes + real `Corruption`, stubbed `ctx.items`).
- `npm test` and `npm run gate:elite` must stay green with no baseline regeneration.

---

### Task 1: The ledger moves — `Corruption.transfer` and the tuning constants

**Files:**
- Modify: `src/data/corruption.js` (add `CLEANSE`, `PACT`)
- Modify: `src/systems/Corruption.js` (add `transfer`)
- Modify: `CONTRACTS.md` (event row `corruptionPact`)
- Test: `tests/corruption-counterplay.test.mjs`

**Interfaces:**
- Consumes: existing `Corruption._byPlayer` attribution map, the `feed`/`bleed` authority idiom.
- Produces (Task 2 relies on these exact names):
  - `CLEANSE = { gold: 60, goldGrowth: 1.25, amount: 30, maxUses: 2, costClimb: 1.4 }` exported from `src/data/corruption.js`.
  - `PACT = { share: 0.35, maxUses: 1 }` exported from `src/data/corruption.js`.
  - `Corruption.transfer(from, to, amount) -> number` — moves attribution, world/band untouched, emits `corruptionPact { from, to, amount }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/corruption-counterplay.test.mjs
// Counterplay is costly, never free (launch spec §1): the Argent Font bleeds
// world corruption for climbing gold, the Covenant Stone moves a teammate's
// burden onto a volunteer, and neither is a greed act — no seeds, no feeds.
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { CLEANSE, PACT } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true });

function makeCorruption({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const c = new Corruption();
  c.init(ctx);
  return { ctx, c, emitted };
}

console.log('the tuning constants exist and are sane');
{
  ok(CLEANSE.gold > 0 && CLEANSE.amount > 0 && CLEANSE.maxUses >= 1 && CLEANSE.costClimb > 1 && CLEANSE.goldGrowth > 1, 'CLEANSE shape');
  ok(PACT.share > 0 && PACT.share < 1 && PACT.maxUses >= 1, 'PACT shape');
}

console.log('transfer moves attribution and nothing else');
{
  const { c, emitted } = makeCorruption();
  const donor = P(), volunteer = P();
  c.feed(donor, 100);
  const worldBefore = c.world, bandBefore = c.band;
  const eventsBefore = emitted.length;
  const moved = c.transfer(donor, volunteer, 35);
  ok(moved === 35, 'returns what it moved');
  ok(c.corruptionOf(donor) === 65 && c.corruptionOf(volunteer) === 35, 'both ledgers moved');
  ok(c.world === worldBefore && c.band === bandBefore, 'world and band untouched');
  const pacts = emitted.slice(eventsBefore).filter((e) => e.name === 'corruptionPact');
  ok(pacts.length === 1 && pacts[0].payload.from === donor && pacts[0].payload.to === volunteer && pacts[0].payload.amount === 35, 'one pact event, correctly attributed');
  ok(!emitted.slice(eventsBefore).some((e) => e.name === 'corruptionChanged' || e.name === 'corruptionBand'), 'no world-change events for a move that changed no world');
}

console.log('transfer clamps, and refuses nonsense');
{
  const { c } = makeCorruption();
  const donor = P(), volunteer = P();
  c.feed(donor, 10);
  ok(c.transfer(donor, volunteer, 50) === 10, 'clamped to what the donor holds');
  ok(c.transfer(donor, volunteer, 5) === 0, 'an empty donor moves nothing');
  ok(c.transfer(volunteer, volunteer, 5) === 0, 'self-pact refused');
  ok(c.transfer(null, volunteer, 5) === 0 && c.transfer(donor, null, 5) === 0, 'null parties refused');
  ok(c.transfer(volunteer, donor, 0) === 0 && c.transfer(volunteer, donor, -3) === 0 && c.transfer(volunteer, donor, NaN) === 0, 'zero, negative, NaN refused');
}

console.log('a client cannot transfer');
{
  const { c } = makeCorruption({ authority: false });
  const a = P(), b = P();
  ok(c.transfer(a, b, 5) === 0, 'transfer returns 0 without authority');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/corruption-counterplay.test.mjs`
Expected: FAIL — `CLEANSE`/`PACT` not exported (import error), then `transfer` undefined.

- [ ] **Step 3: Implement**

In `src/data/corruption.js`, after the `MUTATION` block:

```js
/**
 * The cleansing font (Argent Font) — counterplay, costly, never free. One use
 * bleeds `amount` world corruption, attributed to the user, for gold that
 * climbs per use and per stage. The gold price is the point: cleansing
 * competes with the chest you were about to open.
 */
export const CLEANSE = {
  gold: 60,          // base cost on stage 0
  goldGrowth: 1.25,  // per-stage cost multiplier (the populate scale curve)
  amount: 30,        // world corruption bled per use
  maxUses: 2,
  costClimb: 1.4,    // per-use multiplier, same curve as the Auric Cairn
};

/**
 * The pact shrine (Covenant Stone) — co-op's social valve. A volunteer takes
 * this share of the most-corrupted teammate's ledger onto their own. World
 * corruption does not move: the pact re-attributes blame, it does not absolve
 * the party. Solo runs lose nothing — the stone simply refuses (spec §2).
 */
export const PACT = { share: 0.35, maxUses: 1 };
```

In `src/systems/Corruption.js`, after `bleed` and before `seed`:

```js
  /**
   * Move attribution from one player's ledger to another's — the pact shrine's
   * mechanism. World corruption and the band are deliberately untouched: a
   * pact re-attributes blame ahead of a route lock, it does not absolve the
   * party. Returns the amount actually moved, 0 when refused.
   */
  transfer(from, to, amount) {
    if (!this.ctx?.authority) return 0;
    if (!from || !to || from === to || !(amount > 0)) return 0;
    const own = this._byPlayer.get(from) || 0;
    const moved = Math.min(own, amount);
    if (!(moved > 0)) return 0;
    this._byPlayer.set(from, own - moved);
    this._byPlayer.set(to, (this._byPlayer.get(to) || 0) + moved);
    this.ctx.events.emit('corruptionPact', { from, to, amount: moved });
    return moved;
  }
```

In `CONTRACTS.md`, add to the events table under `voidtouchedSpawn`:

```markdown
| `corruptionPact` | `{ from, to, amount }` — a pact moved attribution between players; world unchanged | Corruption |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/corruption-counterplay.test.mjs` — all arms PASS.
Run: `node tests/corruption-system.test.mjs && node tests/greed-marks.test.mjs` — the corruption suites stay green.

- [ ] **Step 5: Commit**

```bash
git add src/data/corruption.js src/systems/Corruption.js CONTRACTS.md tests/corruption-counterplay.test.mjs
git commit -m "The ledger learns to move: pacts re-attribute blame without absolving the party"
```

---

### Task 2: The Argent Font and the Covenant Stone — the interactables

**Files:**
- Modify: `src/world/Interactables.js` (two new classes, `TYPE_ID` append, bag entries in `_populateShrines`, exports)
- Test: extend `tests/corruption-counterplay.test.mjs`

**Interfaces:**
- Consumes: `CLEANSE`, `PACT`, `Corruption.bleed`/`transfer` (Task 1); the `Interactable` base (`available`/`prompt`/`interact`/`update`, `markGreed` NOT used); `sharedGeo`, `plinthGeo`, `STONE()`, `IRON_POLISH()`, the per-instance emissive-material idiom (`IchorFont`'s constructor is the model); `ctx.roster` (may be absent — treat absent as solo); `ctx.items.spendGold`.
- Produces: `ArgentFont` (exported, `typeId` 13) and `CovenantStone` (exported, `typeId` 14), both in the `_populateShrines` bag; `ArgentFont(ctx, position, stageIndex)`, `CovenantStone(ctx, position)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/corruption-counterplay.test.mjs` (before the exit-code footer). The fixture follows `tests/greed-marks.test.mjs`: real classes, real `Corruption`, stubbed `items`.

```js
console.log('— interactables —');
const { ArgentFont, CovenantStone } = await import('../src/world/Interactables.js');

function makeWorldCtx({ gold = 1000, roster = null } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    player: { isPlayer: true, alive: true, health: 100, maxHealth: 100 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    items: {
      gold,
      spendGold(cost) { if (this.gold < cost) return false; this.gold -= cost; return true; },
    },
    vfx: null, audio: null,
  };
  if (roster) ctx.roster = roster;
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

console.log('the Argent Font bleeds the world for climbing gold');
{
  const ctx = makeWorldCtx({ gold: 1000 });
  ctx.corruption.feed(ctx.player, 100);
  const font = new ArgentFont(ctx, new THREE.Vector3(1, 0, 1), 0);
  const cost0 = font.cost;
  ok(cost0 === Math.round(CLEANSE.gold * Math.pow(CLEANSE.goldGrowth, 0)), 'stage-0 price is the base price');
  ok(font.interact() === true, 'a paid cleanse succeeds');
  ok(ctx.corruption.world === 100 - CLEANSE.amount, 'the world bled by the tuned amount');
  ok(ctx.items.gold === 1000 - cost0, 'and the gold is gone');
  ok(font.cost === Math.round(cost0 * CLEANSE.costClimb), 'the price climbed');
  ok(ctx.corruption.seeds.length === 0, 'cleansing is not a greed act — no seed');
  for (let i = font.uses; i < CLEANSE.maxUses; i++) font.interact();
  ok(font.available() === false, 'spent after maxUses');
}

console.log('the font refuses a pristine world and an empty purse');
{
  const ctx = makeWorldCtx({ gold: 1000 });
  const font = new ArgentFont(ctx, new THREE.Vector3(0, 0, 0), 0);
  ok(font.interact() === false, 'nothing to bleed, nothing charged');
  ok(ctx.items.gold === 1000, 'gold untouched by the refusal');
  ctx.corruption.feed(ctx.player, 50);
  ctx.items.gold = 1;
  ok(font.interact() === false, 'no gold, no cleanse');
  ok(ctx.corruption.world === 50, 'the world did not bleed for free');
}

console.log('the Covenant Stone moves the heaviest ledger onto the volunteer');
{
  const mateA = { isPlayer: true, alive: true, position: { x: 0, z: 0 } };
  const mateB = { isPlayer: true, alive: true, position: { x: 1, z: 0 } };
  const ctx = makeWorldCtx({ roster: { count: 3, all: [] } });
  ctx.roster.all = [ctx.player, mateA, mateB];
  ctx.corruption.feed(mateA, 40);
  ctx.corruption.feed(mateB, 80);
  const stone = new CovenantStone(ctx, new THREE.Vector3(2, 0, 2));
  ok(stone.interact() === true, 'the pact is struck');
  const share = 80 * PACT.share;
  ok(Math.abs(ctx.corruption.corruptionOf(mateB) - (80 - share)) < 1e-9, 'the heaviest teammate is relieved');
  ok(Math.abs(ctx.corruption.corruptionOf(ctx.player) - share) < 1e-9, 'the volunteer carries it now');
  ok(Math.abs(ctx.corruption.corruptionOf(mateA) - 40) < 1e-9, 'the lighter teammate untouched');
  ok(ctx.corruption.world === 120, 'world unchanged — blame moved, not absolved');
  ok(stone.available() === false, 'one covenant per stone');
  ok(ctx.corruption.seeds.length === 0, 'a pact is not a greed act — no seed');
}

console.log('solo, or a party with nothing to shoulder, is refused');
{
  const ctx = makeWorldCtx({ roster: { count: 1, all: [] } });
  ctx.roster.all = [ctx.player];
  const stone = new CovenantStone(ctx, new THREE.Vector3(0, 0, 0));
  ok(stone.interact() === false, 'no teammate, no pact');
  const ctx2 = makeWorldCtx({ roster: { count: 2, all: [] } });
  const mate = { isPlayer: true, alive: true, position: { x: 1, z: 0 } };
  ctx2.roster.all = [ctx2.player, mate];
  const stone2 = new CovenantStone(ctx2, new THREE.Vector3(0, 0, 0));
  ok(stone2.interact() === false, 'a clean teammate has nothing to hand over');
  ok(stone2.uses === 0, 'a refusal consumes no use');
}

console.log('wire values are appended, never renumbered');
{
  const font = new ArgentFont(makeWorldCtx(), new THREE.Vector3(), 0);
  const stone = new CovenantStone(makeWorldCtx(), new THREE.Vector3());
  ok(font.typeId === 13, 'argentFont is wire value 13');
  ok(stone.typeId === 14, 'covenantStone is wire value 14');
}
```

- [ ] **Step 2: Run to verify the new arms fail**

Run: `node tests/corruption-counterplay.test.mjs`
Expected: FAIL — `ArgentFont`/`CovenantStone` not exported.

- [ ] **Step 3: Implement**

In `src/world/Interactables.js`:

(a) Extend the `../data/corruption.js` import with `CLEANSE, PACT` (the file already imports `SOURCES` from it — verify and extend that line).

(b) Append to `TYPE_ID` (append-only, per the comment already on the map):

```js
  argentFont: 13, covenantStone: 14,
```

(c) Add the two classes in the shrines section, after `FallowVault`/`MarrowKiln` (match the file's class layout: geometry via `sharedGeo`, per-instance emissive materials because `interact` dims them):

```js
/**
 * The Argent Font — pay gold, bleed the world. The counterplay valve given a
 * body (launch spec §1): the font undoes what greed did, at a price that
 * climbs per use, and it is NOT a greed act — no seed, no tithe. Refuses a
 * pristine world outright rather than selling nothing.
 */
export class ArgentFont extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.uses = 0;
    this.maxUses = CLEANSE.maxUses;
    this.cost = Math.round(CLEANSE.gold * Math.pow(CLEANSE.goldGrowth, stageIndex || 0));
    this.typeId = TYPE_ID.argentFont;

    const base = new THREE.Mesh(sharedGeo('bloodBase', () => plinthGeo(1.0, 8)), STONE());
    // The Ichor Font's basin form in silver: the two fonts rhyme on purpose —
    // one takes, one gives back — and the palette is the whole difference.
    const rim = new THREE.Mesh(
      sharedGeo('bloodRim', () => new THREE.TorusGeometry(0.78, 0.075, 12, 32)
        .rotateX(Math.PI / 2).translate(0, 1.11, 0)),
      IRON_POLISH()
    );
    base.castShadow = rim.castShadow = true;
    base.receiveShadow = true;

    // Per-instance material: `interact` dims it when the font is spent.
    this.water = new THREE.Mesh(
      sharedGeo('argentWater', () => new THREE.CylinderGeometry(0.72, 0.72, 0.06, 20).translate(0, 1.05, 0)),
      new THREE.MeshStandardMaterial({
        color: 0xcfe8ff, emissive: 0x9fd4ff, emissiveIntensity: 0.8,
        roughness: 0.05, metalness: 0.2, envMapIntensity: 3.0,
      })
    );
    this.group.add(base, rim, this.water);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() { return `Argent Font — bleed the world ($${this.cost})`; }

  interact() {
    const cor = this.ctx.corruption;
    // Nothing to bleed means nothing to sell; refuse before taking the gold.
    if (!cor || !(cor.world > 0)) return false;
    if (!this.ctx.items?.spendGold(this.cost)) return false;
    this.uses++;
    cor.bleed(this.ctx.player, CLEANSE.amount);
    this.ctx.vfx?.burst?.(this.position, 0x9fd4ff);
    this.ctx.audio?.play?.('shrineWin', this.position);
    if (this.uses >= this.maxUses) this.water.material.emissiveIntensity = 0.05;
    this.cost = Math.round(this.cost * CLEANSE.costClimb);
    return true;
  }

  update(dt) {
    this.water.material.emissiveIntensity = this.available()
      ? 0.8 + Math.sin(this.ctx.time * 2.2) * 0.25 : 0.05;
  }
}

/**
 * The Covenant Stone — the pact shrine (launch spec §2). A volunteer takes a
 * share of the most-corrupted teammate's ledger onto their own; world
 * corruption does not move. Solo runs are refused, not punished: the stone
 * only spawns for parties, and a party with clean teammates gets its use back.
 * The volunteer is `ctx.player` — the same host-resolution rule every shrine
 * already follows.
 */
export class CovenantStone extends Interactable {
  constructor(ctx, position) {
    super(ctx, position);
    this.uses = 0;
    this.maxUses = PACT.maxUses;
    this.typeId = TYPE_ID.covenantStone;

    const base = new THREE.Mesh(sharedGeo('shrineBase', () => plinthGeo(1.1, 10)), STONE());
    base.castShadow = true;
    base.receiveShadow = true;
    // Two leaning slabs meeting at the top: the silhouette is a handshake.
    this.stones = new THREE.Mesh(
      sharedGeo('covenantStones', () => {
        const parts = [
          box(0.5, 2.4, 0.4, -0.55, 1.35, 0).rotateZ(-0.2),
          box(0.5, 2.4, 0.4, 0.55, 1.35, 0).rotateZ(0.2),
        ];
        const g = mergeGeometries(parts, false);
        for (const p of parts) p.dispose();
        return g;
      }),
      IRON_DARK()
    );
    this.stones.castShadow = true;
    // Per-instance material: dimmed once the covenant is struck.
    this.bond = new THREE.Mesh(
      sharedGeo('covenantBond', () => new THREE.TorusGeometry(0.34, 0.07, 8, 24).translate(0, 2.35, 0)),
      new THREE.MeshStandardMaterial({
        color: 0x0a0c10, emissive: 0x9fd4ff, emissiveIntensity: 1.6, roughness: 0.3,
      })
    );
    this.group.add(base, this.stones, this.bond);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() { return 'Covenant Stone — shoulder a share of the party\'s corruption'; }

  interact() {
    const cor = this.ctx.corruption;
    const me = this.ctx.player;
    if (!cor || !me) return false;
    // The heaviest ledger that is not the volunteer's own.
    let donor = null, worst = 0;
    for (const p of this.ctx.roster?.all || []) {
      if (p === me) continue;
      const own = cor.corruptionOf(p);
      if (own > worst) { worst = own; donor = p; }
    }
    if (!donor || !(worst > 0)) return false;
    const moved = cor.transfer(donor, me, worst * PACT.share);
    if (!(moved > 0)) return false;
    this.uses++;
    this.bond.material.emissiveIntensity = 0.1;
    this.ctx.vfx?.burst?.(this.position, 0x9fd4ff);
    this.ctx.audio?.play?.('shrineWin', this.position);
    return true;
  }

  update(dt) {
    if (!this.available()) return;
    this.bond.material.emissiveIntensity = 1.6 + Math.sin(this.ctx.time * 3.0) * 0.4;
  }
}
```

Note: `box`, `mergeGeometries`, `IRON_DARK`, `plinthGeo`, `sharedGeo`, `STONE`, `IRON_POLISH` are the file's existing helpers — verify the exact names against the live file (the shrine classes above `AuricCairn` use all of them).

(d) In `_populateShrines` (`Interactables.js:1768`), extend the bag (after the `FallowVault` entry, keeping every existing entry and gate untouched):

```js
      // Counterplay joins the bag once there is a run to have regrets about.
      { w: stageIndex >= 1 ? 14 : 0, build: (p) => new ArgentFont(ctx, p, stageIndex) },
      // The pact is a party mechanic: solo runs never see the stone (spec §2).
      { w: (ctx.roster?.count ?? 1) > 1 ? 16 : 0, build: (p) => new CovenantStone(ctx, p) },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/corruption-counterplay.test.mjs` — all arms PASS.
Run: `node tests/greed-marks.test.mjs && node tests/corruption-system.test.mjs` — green.
Run: `npm test` — full suite green.
Run: `npm run gate:elite` — green, no baseline regeneration (any diff is a real regression: stop).

- [ ] **Step 5: Verify live**

Live (headless-probe if interactive play is impossible, following `tools/voidprobe.mjs` conventions): on a stage-1+ run with corruption on the gauge, find an Argent Font → the prompt shows the price, using it drops the gauge and takes the gold, the price climbs. Record exactly which checks were performed and how. (The Covenant Stone needs a second player; assert its solo absence — no stone in the bag on a solo run — and record the co-op check as deferred to a live co-op session.)

- [ ] **Step 6: Commit**

```bash
git add src/world/Interactables.js tests/corruption-counterplay.test.mjs
git commit -m "Counterplay gets a body: the Argent Font sells absolution, the Covenant Stone shares blame"
```

---

## Self-review notes

- **Spec coverage (this slice):** cleansing fonts "bleed corruption for gold or max health" ✓ (gold chosen; the max-health price is deferred as a tuning variant — one price keeps the first playtest readable); "Voidtouched kills return a fraction" was Phase 1 ✓ (already shipped); pact shrines "voluntarily take a share of a teammate's corruption" ✓ (Task 2, `PACT.share` of the heaviest ledger); "(or their next stage's corruption)" deferred deliberately — forward-pacts need per-stage attribution bookkeeping that nothing else consumes yet; "solo loses nothing" ✓ (stone gated out of the bag solo, refusal costs nothing); "the HUD shows each player's contribution" deferred — it rides corruption replication (its own later plan), same deferral the mutation plan recorded for client toasts.
- **Type consistency:** `CLEANSE.{gold,goldGrowth,amount,maxUses,costClimb}`, `PACT.{share,maxUses}`, `transfer(from,to,amount) -> number`, event `corruptionPact { from, to, amount }`, `ArgentFont(ctx,position,stageIndex)`, `CovenantStone(ctx,position)` used identically across both tasks.
- **Known execution-time checks (deliberate):** the exact helper names (`box`, `IRON_DARK`, `mergeGeometries`) and the corruption-data import line in `Interactables.js` (Task 2c); whether `Interactable`'s constructor signature matches `(ctx, position)` for the two new classes (it does for every existing shrine — verify); `_populateShrines` bag-entry placement (Task 2d keeps the existing six entries and gates byte-identical). The implementer verifies against live files.
- **Shrine-stream note:** adding bag entries changes which shrines the private `_shrineRng` picks (allowed — it is not shared state, and `populate` is host-only); it does not change the count or order of `ctx.rng` gate draws, which is the invariant the sp-equivalence gates care about.
