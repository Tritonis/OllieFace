# Corruption Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corruption becomes the router — at the finale-gate stage the party's corruption band decides which Fracture opens (clean, void-saturated, or both at the middle band), endings key off the route taken, and from stage 3 the HUD previews the route so parties argue about it during the run. Phase 2 slice 1 of the launch design (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md` §2).

**Architecture:** No new engine machinery, exactly as the spec demands. `FINALE_ROUTES` in `src/data/realms.js` carries the corruption predicate (`bands: {min, max}`); `Realms.openPortals` filters routes by `ctx.corruption.band` where it already spawns the finale portal; a second finale realm def `fracture-void` reuses the existing `FinaleController`/`buildArena` machinery with corrupted air, a buffed Herald, and blight loot on entry; `Realms.victory` picks the ending by the realm it ended in. The HUD's existing corruption gauge grows a route line.

**Tech Stack:** Existing `REALMS`/`GATEWAYS`/`ENDINGS` data (`src/data/realms.js`), `Realms` (`src/world/realms/Realms.js`), `FinaleController` (`src/world/realms/FinalBoss.js`), `RNG` from `src/core/MathUtil.js`, HUD gauge block (`src/ui/HUD.js:665`), headless self-running tests per repo convention.

## Global Constraints

- Systems are classes with `init(ctx)`; no system-to-system imports (`CONTRACTS.md`). Realms and HUD read the band via `ctx.corruption` (`.band`), never by importing Corruption.
- **Zero shared-stream displacement:** no change may add, remove, or reorder a `ctx.rng` draw on any existing path. The existing three `GATEWAYS` entries get NO `bands` predicate (their data is untouched); the finale-portal block in `openPortals` draws no rng today and must draw none after. The void finale's entry loot draws from a derived `RNG` seeded `((ctx.seed >>> 0) ^ 0x51f0c3a1) >>> 0 || 1` (the shrine-roll precedent), never `ctx.rng`.
- Host authority: portal spawning, boss scaling, and loot are host-only (`openPortals` and `FinaleController.enter` already gate on `ctx.authority`; keep every addition inside those gates). Clients mirror portals through the existing replicated-interactable machinery.
- **No dead ends** (spec §2): every band 0–4 must match at least one route in `FINALE_ROUTES`; a test arm asserts full coverage. Band 2 (Blighted) sees both routes and must commit.
- Wire safety: realm ids are wire/persistence values — `'fracture-void'` once shipped is never renamed. `ENDINGS` ids likewise (`'victory-void'`).
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code — same shape as `tests/corruption-system.test.mjs`. Use the real `Realms` class and real data; stub only ctx.
- `npm test` and `npm run gate:elite` must stay green with no baseline regeneration.

---

### Task 1: The route table and the void finale — data

**Files:**
- Modify: `src/data/realms.js` (add `fracture-void` realm def, `FINALE_ROUTES`, `routesFor(band)`, `ENDINGS.victoryVoid`)
- Modify: `src/world/realms/RealmArena.js` (builder alias so `fracture-void` builds the fracture arena)
- Test: `tests/corruption-routing.test.mjs`

**Interfaces:**
- Consumes: existing `REALMS` array / `REALM_BY_ID`, `ENDINGS`, the `air()` helper already used by every realm def, `BUILDERS` map in `RealmArena.js`.
- Produces (Tasks 2–4 rely on these exact names):
  - `FINALE_ROUTES = [{ realm, name, label, tint, bands: { min, max } }, ...]` exported from `src/data/realms.js`.
  - `routesFor(band) -> route[]` exported from `src/data/realms.js`.
  - Realm def `fracture-void` in `REALMS` with `kind: 'finale'`, `bossScale: { health, damage }`, `voidLoot: 4`.
  - `ENDINGS.victoryVoid` with `id: 'victory-void'`, `won: true`.

- [ ] **Step 1: Write the failing test**

```js
// tests/corruption-routing.test.mjs
// Corruption is the router (launch spec §2): the band picks which Fracture
// opens, the middle band sees both, no band dead-ends, and the ending is
// keyed off the route taken.
import * as THREE from 'three';
import {
  REALM_BY_ID, FINALE_ROUTES, routesFor, ENDINGS, FINALE_STAGE,
} from '../src/data/realms.js';
import { Realms } from '../src/world/realms/Realms.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('every band reaches an ending — no dead ends');
{
  for (let band = 0; band <= 4; band++) {
    ok(routesFor(band).length >= 1, `band ${band} has at least one route`);
  }
  ok(routesFor(0).every((r) => r.realm === 'fracture'), 'Pristine opens only the clean route');
  ok(routesFor(1).every((r) => r.realm === 'fracture'), 'Seeded opens only the clean route');
  ok(routesFor(2).length === 2, 'Blighted sees both and must commit');
  ok(routesFor(3).every((r) => r.realm === 'fracture-void'), 'Overrun opens only the void route');
  ok(routesFor(4).every((r) => r.realm === 'fracture-void'), 'Consumed opens only the void route');
}

console.log('the void finale is a real realm riding the finale machinery');
{
  const def = REALM_BY_ID.get('fracture-void');
  ok(!!def, 'fracture-void is registered');
  ok(def.kind === 'finale' && def.exit === 'end' && def.combat === true, 'same contract as the Fracture');
  ok(def.bossScale?.health > 1 && def.bossScale?.damage > 1, 'the Herald has more teeth here');
  ok(def.voidLoot >= 1, 'the void route pays corrupted loot');
  ok(FINALE_ROUTES.every((r) => REALM_BY_ID.has(r.realm)), 'every route names a registered realm');
  ok(FINALE_ROUTES.every((r) => typeof r.name === 'string' && r.name.length), 'every route is nameable by the HUD');
}

console.log('endings key off the route');
{
  ok(ENDINGS.victoryVoid?.id === 'victory-void' && ENDINGS.victoryVoid.won === true, 'the void victory exists and counts as a win');
  ok(ENDINGS.victory.id === 'victory', 'the clean victory is untouched');
}

console.log('openPortals spawns the routes the band allows');
{
  const spawnFor = (band, { authority = true } = {}) => {
    const added = [];
    const ctx = {
      authority,
      corruption: { band },
      interactables: { add: (p) => added.push(p) },
      hud: null,
      events: { on() {}, emit() {} },
    };
    const realms = new Realms();
    realms.ctx = ctx;                       // init wiring not needed for this method
    realms.openPortals(new THREE.Vector3(0, 0, 0), FINALE_STAGE);
    return added;
  };
  ok(spawnFor(0).length === 1 && spawnFor(0)[0].label === routesFor(0)[0].label, 'Pristine: one portal, the clean one');
  ok(spawnFor(2).length === 2, 'Blighted: both portals stand side by side');
  const consumed = spawnFor(4);
  ok(consumed.length === 1 && consumed[0].label === routesFor(4)[0].label, 'Consumed: only the void way opens');
  ok(spawnFor(4, { authority: false }).length === 0, 'a client spawns nothing');
}

console.log('victory picks the ending for the realm it happened in');
{
  const endings = [];
  const realms = new Realms();
  realms.ctx = { progression: { finishRun: (e) => endings.push(e) } };
  realms.active = { def: REALM_BY_ID.get('fracture') };
  realms.victory();
  realms.active = { def: REALM_BY_ID.get('fracture-void') };
  realms.victory();
  ok(endings[0] === ENDINGS.victory, 'clean Fracture ends in the clean victory');
  ok(endings[1] === ENDINGS.victoryVoid, 'void Fracture ends in the void victory');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/corruption-routing.test.mjs`
Expected: FAIL — import error, `FINALE_ROUTES` / `routesFor` not exported from data/realms.js.

- [ ] **Step 3: Implement the data**

In `src/data/realms.js`:

(a) Append to `REALMS`, after the `fracture` entry (same `air()` helper, same field set):

```js
  {
    id: 'fracture-void',
    name: 'The Hungering Fracture',
    kind: 'finale',
    combat: true,
    exit: 'end',
    floorRadius: 34,
    wallRadius: 62,
    objective: 'Destroy the Herald',
    toast: 'The Hungering Fracture',
    // The void route's teeth and its pay. The Herald here is the same fight
    // with less forgiveness; the loot is the richest corrupted haul in the
    // game, paid on arrival — you already paid for it all run.
    bossScale: { health: 1.5, damage: 1.35 },
    voidLoot: 4,
    air: air({
      // The Fracture's palette dragged all the way into the blight ramp
      // (hud.css: #7a4fd0 -> #ff2fb0): denser dust, magenta haze, and the rim
      // light is the blight edge colour itself. Same sun geometry as the
      // clean finale — the room reads as the same place, further gone.
      zenith: 0x120420, horizon: 0x521a4e, haze: 0xc72fd6, ground: 0x0a0410,
      sun: 0xff9ae0, cloud: 0x241030, cloudAmount: 0.7, hazePow: 3.4,
      ceiling: 0x120826, ceilingAmount: 0.5,
      fogColor: 0x2a1038, fogDensity: 0.011,
      sunEl: 18, sunAz: 35, sunColor: 0xff70d8, sunIntensity: 4.6,
      hemiSky: 0x58286a, hemiGround: 0x140818, hemiIntensity: 0.6,
      rim: 0xff2fb0, rimIntensity: 1.4, envIntensity: 0.5,
      dustColor: 0xff8ae0, dustOpacity: 1.0,
    }),
  },
```

(b) After `FINALE_PHASES`, add the route table:

```js
/**
 * Corruption is the router (launch spec §2). At the finale-gate stage the
 * party's corruption band decides which Fracture opens: Pristine/Seeded see
 * the clean route, Overrun/Consumed see the void-saturated one, and Blighted
 * — the middle band — sees both and must commit. Every band matches at least
 * one route: corruption changes which game you are playing, never whether
 * you finish (tests/corruption-routing.test.mjs asserts the coverage).
 */
export const FINALE_ROUTES = [
  {
    realm: 'fracture',
    name: 'The Fracture',
    label: 'Enter The Fracture — this ends the run',
    tint: 0xff4ad0,
    bands: { min: 0, max: 2 },
  },
  {
    realm: 'fracture-void',
    name: 'The Hungering Fracture',
    label: 'Enter The Hungering Fracture — this ends the run',
    tint: 0xc72fd6,
    bands: { min: 2, max: 4 },
  },
];

/** The routes a party at this corruption band may take. Never empty. */
export function routesFor(band) {
  return FINALE_ROUTES.filter((r) => band >= r.bands.min && band <= r.bands.max);
}
```

(c) Add to `ENDINGS`, after `victory`:

```js
  victoryVoid: {
    id: 'victory-void',
    won: true,
    title: 'The Herald Drowns',
    line: 'You fed the world to the void, and broke the thing it sent to thank you.',
  },
```

(d) In `src/world/realms/RealmArena.js`, immediately after the `BUILDERS` map is defined (check the exact identifier — `buildArena` at `RealmArena.js:861` reads `BUILDERS[stage.realmId]`), alias the void finale onto the fracture builder:

```js
// The Hungering Fracture is the same arena further gone: the air and the
// Herald carry the difference, not the geometry.
BUILDERS['fracture-void'] = BUILDERS.fracture;
```

- [ ] **Step 4: Run tests**

Run: `node tests/corruption-routing.test.mjs`
Expected: the data arms PASS; the `openPortals` arms still FAIL (Realms spawns the hardcoded single portal), and the `victory` arm FAILs. That is correct — they are Task 2's targets. If the data arms pass, proceed.

- [ ] **Step 5: Commit**

```bash
git add src/data/realms.js src/world/realms/RealmArena.js tests/corruption-routing.test.mjs
git commit -m "The void gets a second door: route table, the Hungering Fracture, and its ending"
```

---

### Task 2: The router and the endings — Realms consults the band

**Files:**
- Modify: `src/world/realms/Realms.js` (`openPortals` finale block; `victory`)
- Modify: `src/systems/Progression.js` (`runStats` gains the corruption record)
- Test: `tests/corruption-routing.test.mjs` (arms already written in Task 1)

**Interfaces:**
- Consumes: `FINALE_ROUTES`/`routesFor` and `ENDINGS.victoryVoid` (Task 1); `ctx.corruption.band` (read-only, may be absent); existing `RealmPortal` and `requestEnter`.
- Produces: finale portals filtered by band; `Realms.victory()` route-keyed; `runStats()` gains `corruption` (rounded world) and `corruptionBand` fields (Task 4's HUD/live checks and the logbook read these).

- [ ] **Step 1: Confirm the failing arms**

Run: `node tests/corruption-routing.test.mjs` — the `openPortals` and `victory` arms fail (single hardcoded portal; `ENDINGS.victory` always).

- [ ] **Step 2: Implement**

In `src/world/realms/Realms.js`:

(a) Extend the import from `../../data/realms.js` with `routesFor` (the file already imports `GATEWAYS`, `REALM_BY_ID`, `FINALE_STAGE`, `ENDINGS` — verify and extend the existing line).

(b) Replace the finale block of `openPortals` (currently `Realms.js:154-161`, the `if (stageIndex >= FINALE_STAGE)` block) with:

```js
    if (stageIndex >= FINALE_STAGE) {
      // Corruption is the router: the band decides which Fracture is offered.
      // Both portals stand beside the ordinary one — the run still never
      // forces you to finish, whatever the band says.
      const routes = routesFor(ctx.corruption?.band ?? 0);
      routes.forEach((route, i) => {
        const p = new RealmPortal(ctx, _v.copy(at).add(new THREE.Vector3(i * 6, 0, -8)).clone(), {
          label: route.label, tint: route.tint,
          onEnter: () => this.requestEnter(route.realm),
        });
        ctx.interactables.add(p);
      });
      ctx.hud?.setObjective?.(routes.length > 1
        ? 'Proceed — or commit to a Fracture and finish it'
        : 'Proceed — or take the Fracture and finish it');
    }
```

(c) Replace `victory()` (`Realms.js:361-363`):

```js
  /** Called by the finale controller once the Herald is down. */
  victory() {
    // Endings key off the route taken (launch spec §2): the void Fracture has
    // its own record, and both count as wins.
    const ending = this.realmId === 'fracture-void' ? ENDINGS.victoryVoid : ENDINGS.victory;
    this.ctx.progression?.finishRun?.(ending);
  }
```

In `src/systems/Progression.js`, in `runStats()` (the object literal at `Progression.js:500-514`), add two fields after `gold`:

```js
      // The run's corruption record: how deep, and which band it ended in.
      // Endings key off band plus route (launch spec §2); the summary screen
      // and the logbook read these if they know about them and ignore them
      // if they do not.
      corruption: Math.round(this.ctx.corruption?.world ?? 0),
      corruptionBand: this.ctx.corruption?.band ?? 0,
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `node tests/corruption-routing.test.mjs` — all arms PASS.
Run: `node tests/corruption-system.test.mjs && node tests/branding-display.test.mjs` — the corruption suite and the branding/endings display suite stay green.

- [ ] **Step 4: Commit**

```bash
git add src/world/realms/Realms.js src/systems/Progression.js
git commit -m "The band picks the door: finale portals filter by corruption, endings follow the route"
```

---

### Task 3: The void finale's teeth — buffed Herald, corrupted loot on entry

**Files:**
- Modify: `src/world/realms/FinalBoss.js` (`FinaleController.enter`)
- Test: extend `tests/corruption-routing.test.mjs`

**Interfaces:**
- Consumes: `def.bossScale { health, damage }` and `def.voidLoot` (Task 1); `ITEMS_BY_TIER` from `../../data/items.js` (new import); `RNG` from `../../core/MathUtil.js` (new import — check the existing MathUtil import line, which already brings `lerp, clamp`, and extend it); `ctx.interactables.spawnOrb(position, id, scale)`.
- Produces: entering `fracture-void` yields a Herald with `bossScale` applied and `voidLoot` blight-tier item orbs ringed at 0.7 × floor radius. Entering `fracture` is byte-identical to before.

- [ ] **Step 1: Write the failing test**

Append to `tests/corruption-routing.test.mjs` (before the exit-code footer):

```js
console.log('the void finale arms itself: boss scale applied, blight loot ringed');
{
  const { FinaleController } = await import('../src/world/realms/FinalBoss.js');
  const { REALM_BY_ID } = await import('../src/data/realms.js');
  const def = REALM_BY_ID.get('fracture-void');
  const orbs = [];
  const boss = { alive: true, maxHealth: 4000, health: 4000, damage: 40, position: new THREE.Vector3() };
  const ctx = {
    authority: true, seed: 424242,
    events: { on() {}, emit() {} },
    director: { spawnOne: () => boss, boss: null },
    interactables: { spawnOrb: (pos, id, s) => orbs.push({ pos: pos.clone(), id }) },
    items: {}, hud: null, pipeline: null,
  };
  const stage = {
    origin: new THREE.Vector3(0, 0, 0), floorRadius: def.floorRadius,
    root: new THREE.Group(),
  };
  const fc = new FinaleController({ active: { stage } }, def);
  fc.enter(ctx, stage);
  ok(boss.maxHealth === Math.round(4000 * def.bossScale.health), 'Herald health scaled');
  ok(boss.health === boss.maxHealth, 'and topped up to the new ceiling');
  ok(Math.abs(boss.damage - 40 * def.bossScale.damage) < 1e-9, 'Herald damage scaled');
  ok(orbs.length === def.voidLoot, `${def.voidLoot} corrupted orbs paid on arrival`);
  const { ITEM_BY_ID } = await import('../src/data/items.js');
  ok(orbs.every((o) => ITEM_BY_ID.get(o.id)?.tier === 'blight'), 'every orb is blight-tier');
  ok(orbs.every((o) => Math.abs(Math.hypot(o.pos.x, o.pos.z) - def.floorRadius * 0.7) < 1e-6), 'ringed at 0.7 x floor radius');

  // The clean finale is untouched: same stub, fracture def, nothing scales.
  const boss2 = { alive: true, maxHealth: 4000, health: 4000, damage: 40, position: new THREE.Vector3() };
  ctx.director.spawnOne = () => boss2;
  const orbCount = orbs.length;
  const fc2 = new FinaleController({ active: { stage } }, REALM_BY_ID.get('fracture'));
  fc2.enter(ctx, stage);
  ok(boss2.maxHealth === 4000 && boss2.damage === 40, 'clean Fracture Herald unscaled');
  ok(orbs.length === orbCount, 'clean Fracture pays no arrival loot');
}
```

Note: the test file's top-level `await import` requires the arms to run in the file's module scope — the existing arms are plain blocks, so `await` at top level is legal in `.mjs`. If `_dressBoss` requires more of `stage`/`ctx` than stubbed here, extend the stub minimally (it needs `stage.root` as a THREE.Group; `ctx.hud`/`ctx.pipeline` are optional-chained).

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/corruption-routing.test.mjs`
Expected: FAIL — boss stats unscaled, zero orbs.

- [ ] **Step 3: Implement**

In `src/world/realms/FinalBoss.js`, extend the imports: add `RNG` to the `../../core/MathUtil.js` import, and add `ITEMS_BY_TIER` from `'../../data/items.js'` (new import line if the file has none from data/items.js).

In `FinaleController.enter` (`FinalBoss.js:167`), after `ctx.events.emit('bossSpawn', { enemy: boss });` (still inside the authority-gated tail), append:

```js
    // The void route's teeth and its pay (launch spec §2). Both are def-driven
    // so the clean Fracture — with neither field — is byte-identical to before.
    const scale = this.def.bossScale;
    if (scale) {
      boss.maxHealth = Math.round(boss.maxHealth * (scale.health ?? 1));
      boss.health = boss.maxHealth;
      boss.damage = (boss.damage ?? 0) * (scale.damage ?? 1);
    }
    if (this.def.voidLoot > 0) {
      // The richest corrupted loot in the game, paid on arrival. The pick
      // rides a derived stream — a ctx.rng draw here would displace the
      // fight's own rolls relative to a run that took the clean door.
      const rng = new RNG(((ctx.seed >>> 0) ^ 0x51f0c3a1) >>> 0 || 1);
      const pool = ITEMS_BY_TIER.blight || [];
      for (let i = 0; i < this.def.voidLoot && pool.length; i++) {
        const a = (i / this.def.voidLoot) * Math.PI * 2;
        const p = stage.origin.clone().add(
          new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(stage.floorRadius * 0.7));
        ctx.interactables.spawnOrb(p, rng.pick(pool).id, 1.4);
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `node tests/corruption-routing.test.mjs` — all arms PASS.
Run: `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/world/realms/FinalBoss.js tests/corruption-routing.test.mjs
git commit -m "The Hungering Fracture bares its teeth: a harder Herald, paid in blight on the doorstep"
```

---

### Task 4: The argument is the gameplay — HUD route preview, docs, gates

**Files:**
- Modify: `src/ui/HUD.js` (route line under the corruption gauge)
- Modify: `src/ui/hud.css` (one rule for the route line)
- Modify: `CONTRACTS.md` (note the `runStats` corruption fields on the Progression row if the file documents runStats; otherwise no contract change — verify)
- Test: extend `tests/corruption-routing.test.mjs` ONLY if the HUD is headless-drivable the way `tests/item-mutation.test.mjs`'s HUD arms drive it — otherwise the preview is verified live in Step 3 and the omission recorded.

**Interfaces:**
- Consumes: `routesFor` (Task 1 — HUD already imports `BANDS` from `../data/corruption.js`; add a new import line from `../data/realms.js`); `ctx.progression?.stageIndex`; the gauge update block at `HUD.js:665-675` and its `set()` memoisation idiom; the corruption TEMPLATE block at `HUD.js:1113-1115` and refs at `HUD.js:1019-1021`.
- Produces: from stage 3 (stageIndex >= 2) the gauge shows `Route: <name>` (or `Route: contested` when the band sees both); before stage 3, nothing.

- [ ] **Step 1: Wire the preview**

In `src/ui/HUD.js`:

(a) Import `routesFor` from `'../data/realms.js'` next to the existing `BANDS` import.

(b) In the TEMPLATE's corruption block (after `<b class="corruption-band">Pristine</b>`), add:

```html
    <i class="corruption-route"></i>
```

(c) In the refs table (next to `corruptionBand`), add:

```js
    corruptionRoute: q('.corruption-route'),
```

(d) In the gauge update block (inside the `if (cor && this.refs.corruption)` branch at `HUD.js:665`), after the band `set(...)`, add:

```js
      // Route preview, not surprise (launch spec §2): from stage 3 the party
      // can see which Fracture their band is buying, and argue about it.
      const stageIdx = ctx.progression?.stageIndex ?? 0;
      let route = '';
      if (stageIdx >= 2) {
        const open = routesFor(cor.band ?? 0);
        route = open.length > 1 ? 'Route: contested' : `Route: ${open[0]?.name ?? ''}`;
      }
      this.set('corruptionRoute', route, (v) => {
        this.refs.corruptionRoute.textContent = v;
        this.refs.corruptionRoute.classList.toggle('is-on', !!v);
      });
```

(e) In `src/ui/hud.css`, next to the existing `.corruption-band` rule (match its font/spacing conventions — verify against the live file):

```css
.corruption-route { display: none; font-style: normal; font-size: 10px; letter-spacing: 0.08em; opacity: 0.75; }
.corruption-route.is-on { display: block; }
```

- [ ] **Step 2: Headless HUD arm if drivable**

Check how `tests/item-mutation.test.mjs` drives HUD headlessly (it carries the prototype idiom). If that fixture can reach `update()`'s gauge block with a stubbed `ctx.progression`, add one arm: at stageIndex 2 with band 2, `corruption-route` text is `Route: contested` and has `is-on`; at stageIndex 0 it is empty. If the fixture cannot reach it without a browser, record the omission in the report and rely on Step 3.

- [ ] **Step 3: Verify live and run the gates**

- `npm test` — full suite green.
- `npm run gate:elite` — green, no baseline regeneration (any diff is a real regression: stop).
- Live (headless-probe if interactive play is impossible, following `tools/voidprobe.mjs` conventions): reach stage 3, climb the gauge across band 2 → the route line appears and flips from `Route: The Fracture` to `Route: contested` to `Route: The Hungering Fracture` as the band climbs. Record exactly which checks were performed and how.

- [ ] **Step 4: Commit**

```bash
git add src/ui/HUD.js src/ui/hud.css tests/corruption-routing.test.mjs CONTRACTS.md
git commit -m "The route is on the gauge: from stage 3 the party sees which door they are buying"
```

---

## Self-review notes

- **Spec coverage (this slice):** finale gateway eligibility by band ✓ (Tasks 1–2, `FINALE_ROUTES` predicate); Pristine→clean / Consumed→void / middle sees both ✓ (route table + coverage test); endings key off band+route ✓ (Task 2 `victory()`, `runStats` band stamp); route preview from stage 3 ✓ (Task 4); no dead ends ✓ (coverage arm); "void-saturated realms with the richest corrupted loot" ✓ (Task 1 air + Task 3 teeth/loot); "no new engine machinery" ✓ (data predicate + existing controller). Deferred deliberately: per-gateway band predicates on the three mid-run GATEWAYS (the spec's routing clause is about the finale-gate stage; gating existing mid-run content is a balance decision for playtest), party-band aggregation nuance (band is world-corruption-derived and already party-wide), co-op route toast replication (rides corruption replication, its own later plan).
- **Type consistency:** `FINALE_ROUTES[{realm,name,label,tint,bands:{min,max}}]`, `routesFor(band) -> route[]`, `ENDINGS.victoryVoid.id === 'victory-void'`, `def.bossScale{health,damage}`, `def.voidLoot` used identically across Tasks 1–4.
- **Known execution-time checks (deliberate):** the exact `BUILDERS` identifier/export shape in `RealmArena.js` (Task 1d); the exact import lines extended in `Realms.js`/`FinalBoss.js`/`HUD.js`; whether `_dressBoss` needs more stub surface than `stage.root` (Task 3 test note); `hud.css`'s conventions for the route rule (Task 4e); whether `CONTRACTS.md` documents `runStats` at all (Task 4). The implementer verifies against live files.
