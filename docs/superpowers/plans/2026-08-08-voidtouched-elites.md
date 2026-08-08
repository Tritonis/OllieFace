# Voidtouched Elite Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The fourth elite family: Voidtouched units that surface only where blight seeds were planted, on a spawn budget scaled by World Corruption, whose kills bleed corruption back — the blight stops being scenery and starts producing fights.

**Architecture:** No new system. The Director gains a second, separate credit bank (`voidCredits`) that accrues only while World Corruption is nonzero and blight seeds exist this stage, and spends it on elite-eligible ground cards affixed `voidtouched`, surfacing them on a telegraphed ring around a seed. Every roll on that path comes from a private `RNG` derived from `(ctx.seed, stageIndex)` — the shrine-type precedent (`src/world/Interactables.js:1719-1755`) — so a corruption-free run's shared `ctx.rng` stream is untouched. Corruption gains the counterplay valve: `bleed()`, driven by `kill` events of Voidtouched victims. The affix's combat identity is a siphon aura (drains the player, feeds the unit), implemented as a third rider block in `Enemy.fixedUpdate` following the blazing/withering pattern.

**Tech Stack:** Existing Director elite machinery (`spawnOne(ctx, def, at, affix)`), `ELITE_STATS` / `EnemyMeshes.ELITE` data tables, `RNG` from `src/core/MathUtil.js`, headless self-running tests per repo convention.

## Global Constraints

- Systems are classes with `init(ctx)` + update hooks; no system-to-system imports (`CONTRACTS.md`). Director reads `ctx.corruption?.world`; Corruption listens to `kill` events — neither imports the other.
- **Zero shared-stream displacement:** the Voidtouched path must draw NOTHING from `ctx.rng`. All selection/placement rolls come from a private `RNG` seeded `((ctx.seed >>> 0) ^ (0x7f4a7c15 * (stageIndex + 1))) >>> 0 || 1` (the shrine-roll shape). A corruption-zero run must be bit-identical to today; `npm run gate:elite` is the proof.
- `voidtouched` must NEVER enter the normal elite roll: it is not added to `ELITE_TIERS`, so `eliteAffixesFor()` can never return it. It spawns only via the Director's void path.
- Branding (`tests/branding-display.test.mjs`): every `ELITE_STATS` entry needs a `label` that is not RoR2 vocabulary. "Voidtouched" is RoR2's DLC elite name — the key stays `voidtouched` (spec vocabulary, save-load-bearing), the display label is **`Hollowed`**.
- Host authority: the Director's void path already sits behind `fixedUpdate`'s `ctx.authority` gate (Director.js:300); `Corruption.bleed` gates on `ctx.authority` itself like `feed` does.
- Seeds are per-stage for spawning purposes: the Director tracks its own copy from `blightSeed` events and clears it on `stageStart` (Corruption's run-scoped `seeds` array may hold stale prior-stage coordinates — never spawn from it directly).
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code, LCG or real-`RNG` fixtures — same shape as `tests/enemy-targeting.test.mjs` / `tests/blight-system.test.mjs`. three.js constructs meshes headless; no GL compile in tests.
- Palette continuity: Voidtouched visuals use the blight ramp — `0xd8479b` (Blight tier pink) for telegraphs, `0xff2fb0` / violet family for the elite aura (`src/ui/hud.css` band ramp).
- Every tuning value lives in exported constants (`VOIDTOUCHED` in `src/data/corruption.js`, stats in `ELITE_STATS`).

---

### Task 1: Data — the affix card, the tuning block, and the visual entry

**Files:**
- Modify: `src/data/enemies.js` (add `voidtouched` to `ELITE_STATS`; do NOT touch `ELITE_TIERS`)
- Modify: `src/data/corruption.js` (add `VOIDTOUCHED` + `voidCreditRate`)
- Modify: `src/entities/EnemyMeshes.js` (add `voidtouched` to `ELITE`)
- Test: `tests/voidtouched-data.test.mjs`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `ELITE_STATS.voidtouched = { label: 'Hollowed', health: 4.2, damage: 2.0, cost: 5.5, speed: 1.05, siphonRadius: 3.6, siphonDps: 0.10, siphonHeal: 0.012 }`
  - `VOIDTOUCHED = { affix: 'voidtouched', ratePerWorld: 0.012, maxBank: 90, interval: 4, telegraph: 1.1, spawnRing: { min: 2.5, max: 6.5 }, minPlayerDist: 12, refund: 0.03 }` exported from `src/data/corruption.js`
  - `voidCreditRate(world) -> credits/second` exported from `src/data/corruption.js`
  - `ELITE.voidtouched` visual entry in `EnemyMeshes.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/voidtouched-data.test.mjs
import { ELITE_STATS, ELITE_TIERS, ELITE_AFFIXES, eliteAffixesFor } from '../src/data/enemies.js';
import { VOIDTOUCHED, voidCreditRate } from '../src/data/corruption.js';
import { ELITE } from '../src/entities/EnemyMeshes.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the affix card exists and never enters the normal roll');
{
  const s = ELITE_STATS.voidtouched;
  ok(!!s, 'ELITE_STATS.voidtouched exists');
  ok(s.label === 'Hollowed', 'display label is Hollowed, not the RoR2 name');
  ok(s.siphonRadius > 0 && s.siphonDps > 0 && s.siphonHeal > 0, 'siphon rider knobs present');
  ok(!ELITE_AFFIXES.includes('voidtouched'), 'not in the flat affix list');
  ok(!ELITE_TIERS.some((t) => t.affixes.includes('voidtouched')), 'not in any unlock tier');
  ok(!eliteAffixesFor(999).includes('voidtouched'), 'no difficulty ever unlocks it into the roll');
}

console.log('the tuning block is a spend curve, not a faucet');
{
  ok(VOIDTOUCHED.affix === 'voidtouched', 'affix key matches the stats key');
  ok(voidCreditRate(0) === 0, 'a pristine world accrues nothing');
  ok(voidCreditRate(100) > voidCreditRate(50), 'rate scales with World Corruption');
  ok(voidCreditRate(-5) === 0, 'negative world clamps to zero');
  ok(VOIDTOUCHED.refund > 0 && VOIDTOUCHED.refund < 1, 'kill refund is a fraction');
  ok(VOIDTOUCHED.spawnRing.min > 0 && VOIDTOUCHED.spawnRing.max > VOIDTOUCHED.spawnRing.min, 'ring is a band');
  ok(VOIDTOUCHED.minPlayerDist > VOIDTOUCHED.spawnRing.max, 'a seed at your feet cannot surface one in your face');
}

console.log('the rig table knows the family');
{
  const v = ELITE.voidtouched;
  ok(!!v, 'ELITE.voidtouched exists');
  ok(v.name === 'Hollowed', 'rig table name agrees with the stats label');
  ok(typeof v.tint === 'number' && typeof v.aura === 'number', 'tint and aura are colours');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/voidtouched-data.test.mjs`
Expected: FAIL — `ELITE_STATS.voidtouched` undefined, `VOIDTOUCHED` not exported.

- [ ] **Step 3: Add the data**

In `src/data/enemies.js`, append to `ELITE_STATS` (after the `warded` entry, keeping the table's comment style):

```js
  // The void's own family. Not in ELITE_TIERS — the normal roll can never
  // produce one; the Director's void path is the only door, and it opens only
  // where a blight seed was planted (see VOIDTOUCHED in data/corruption.js).
  // The rider is a siphon: `damage x siphonDps` every 0.5 s to anyone inside
  // `siphonRadius`, and the unit heals `maxHealth x siphonHeal` per tick it
  // connects — breaking contact starves it, standing in it feeds it. Kills
  // refund corruption (Corruption's kill listener), which is why its cost sits
  // between the tier-1s and the tier-2s: it is nasty, but killing it is the
  // one elite kill that pays twice.
  voidtouched: { label: 'Hollowed', health: 4.2, damage: 2.0, cost: 5.5, speed: 1.05, siphonRadius: 3.6, siphonDps: 0.10, siphonHeal: 0.012 },
```

In `src/data/corruption.js`, append after `bandOf`:

```js
/**
 * Voidtouched spawn economy. The void's bank is separate from the Director's
 * credits by design: its rate is a function of World Corruption alone, so a
 * pristine run never pays a single frame of cost for the feature existing.
 * `refund` is the counterplay valve — each Voidtouched kill returns this
 * fraction of the *current* world corruption, so the refund is worth most
 * exactly when the party is deepest in the red.
 */
export const VOIDTOUCHED = {
  affix: 'voidtouched',
  ratePerWorld: 0.012,   // void credits per second per point of World Corruption
  maxBank: 90,           // ~2 queued elites; the void saves, it does not flood
  interval: 4,           // seconds between spend attempts
  telegraph: 1.1,        // seconds of warning ring before the unit surfaces
  spawnRing: { min: 2.5, max: 6.5 },  // metres from the chosen seed
  minPlayerDist: 12,     // never surfaces in someone's face
  refund: 0.03,          // fraction of World Corruption returned per kill
};

export function voidCreditRate(world) {
  return VOIDTOUCHED.ratePerWorld * Math.max(0, world);
}
```

In `src/entities/EnemyMeshes.js`, append to `ELITE` (after `warded`):

```js
  // The void's family. Blight-ramp magenta pulled toward black: the read is
  // "eaten", not "empowered". Two slow bands plus seven shards — ringed like
  // the tier-1s so it still reads elite at 40 m, but in the one hue family no
  // other affix owns, which is what lets the ground and the monster agree.
  voidtouched: { tint: 0x8a2fd0, aura: 0xff2fb0, glow: 2.7, name: 'Hollowed', bands: 2, tilt: 0.9, bits: 7, shape: 'shard', bitScale: 0.16, spin: 1.1, bandAlpha: 0.6 },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/voidtouched-data.test.mjs` — all arms PASS.
Run: `node tests/branding-display.test.mjs` — still green (the new entry has a compliant label).

- [ ] **Step 5: Commit**

```bash
git add src/data/enemies.js src/data/corruption.js src/entities/EnemyMeshes.js tests/voidtouched-data.test.mjs
git commit -m "The void gets a family: Hollowed affix card, spend curve, and rig entry"
```

---

### Task 2: The siphon rider — the void eats

**Files:**
- Modify: `src/entities/Enemy.js` (one new rider block in `fixedUpdate`, after the withering block that ends near line 606)
- Test: `tests/voidtouched-affix.test.mjs`

**Interfaces:**
- Consumes: `ELITE_STATS.voidtouched.{siphonRadius, siphonDps, siphonHeal}` (Task 1); the existing `hurtPlayer(ctx, victim, source, amount, type)` helper and `this.auraT` cadence field.
- Produces: a Voidtouched enemy drains `damage * siphonDps` from its target every 0.5 s inside `siphonRadius` and heals `maxHealth * siphonHeal` per connecting tick. No new exports.

- [ ] **Step 1: Write the failing test**

```js
// tests/voidtouched-affix.test.mjs
// A real Enemy, driven headless, with the voidtouched affix — same fixture
// shape as tests/enemy-targeting.test.mjs. No ctx.combat: hurtPlayer falls
// back to victim.takeDamage, which is what the recorder below is.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES, ELITE_STATS } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 12345) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

function makePlayer(x, z) {
  const hits = [];
  return {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x, y: 0, z }, velocity: { x: 0, y: 0, z: 0 },
    health: 110, maxHealth: 110, hits,
    takeDamage(amount, info) { hits.push({ amount, type: info?.type }); this.health -= amount; return amount; },
  };
}

function makeWorld(px, pz) {
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const roster = new Roster();
  roster.init(ctx);
  const player = makePlayer(px, pz);
  ctx.player = player;
  roster.add(player);
  return { ctx, player };
}

const beetle = ENEMIES.find((e) => e.id === 'beetle');
const S = ELITE_STATS.voidtouched;
const H = 1 / 60;

console.log('inside the ring, the siphon ticks and the unit feeds');
{
  const { ctx, player } = makeWorld(2, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, { affix: 'voidtouched' });
  ok(e.affix === 'voidtouched' && e.isElite, 'affix took');
  e.health = e.maxHealth * 0.5;
  const h0 = e.health;
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);   // 0.66 s — at least one 0.5 s tick
  const drained = player.hits.filter((x) => x.type === 'void');
  ok(drained.length >= 1, 'at least one void tick landed');
  ok(Math.abs(drained[0].amount - e.damage * S.siphonDps) < 1e-6, 'tick is damage x siphonDps');
  ok(e.health > h0, 'the unit healed off the drain');
  ok(Math.abs(e.health - h0 - drained.length * e.maxHealth * S.siphonHeal) < 1e-6, 'heal is maxHealth x siphonHeal per connecting tick');
}

console.log('outside the ring, nothing happens');
{
  const { ctx, player } = makeWorld(S.siphonRadius + 3, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, { affix: 'voidtouched' });
  e.health = e.maxHealth * 0.5;
  const h0 = e.health;
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);
  ok(player.hits.filter((x) => x.type === 'void').length === 0, 'no drain at range');
  ok(e.health === h0, 'and no free healing');
}

console.log('a plain beetle is untouched by the new block');
{
  const { ctx, player } = makeWorld(2, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, {});
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);
  ok(player.hits.filter((x) => x.type === 'void').length === 0, 'no affix, no siphon');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/voidtouched-affix.test.mjs`
Expected: first block FAILS (`no void tick landed`) — the rider does not exist yet. The other two blocks pass vacuously; that is fine, the first is the discriminating arm.

- [ ] **Step 3: Implement the rider**

In `src/entities/Enemy.js`, `fixedUpdate`, directly after the withering block (the `if (em && em.denyRadius && ...)` block ending near line 606) and before `this.fsm.update(ctx, h)`:

```js
    // Voidtouched: the void eats. A drain aura that feeds the unit what it
    // takes — the counterplay is range, and the cost of ignoring it compounds,
    // because every tick you stand in is a tick of your damage undone.
    if (em && em.siphonDps && this.alive) {
      this.auraT -= h;
      if (this.auraT <= 0) {
        this.auraT = 0.5;
        if (this.distToPlayer < em.siphonRadius) {
          hurtPlayer(ctx, this.targetPlayer, this, this.damage * em.siphonDps, 'void');
          this.health = Math.min(this.maxHealth, this.health + this.maxHealth * em.siphonHeal);
        }
      }
    }
```

(`this.auraT` is shared with the blazing/withering blocks by design — a unit has exactly one affix, so exactly one block ever runs.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/voidtouched-affix.test.mjs` — all arms PASS.
Run: `node tests/enemy-targeting.test.mjs && node tests/shrike-detonate.test.mjs && node tests/fsm-die-reentrancy.test.mjs` — the existing Enemy suites stay green.

- [ ] **Step 5: Commit**

```bash
git add src/entities/Enemy.js tests/voidtouched-affix.test.mjs
git commit -m "The Hollowed siphon: standing in the ring feeds the thing draining you"
```

---

### Task 3: Corruption.bleed — kills pay back

**Files:**
- Modify: `src/systems/Corruption.js` (add `bleed()`, add the `kill` listener in `init`)
- Test: extend `tests/corruption-system.test.mjs` (append arms before the summary lines, same fixture)

**Interfaces:**
- Consumes: `kill` event payload `{ victim, source }` (`CONTRACTS.md`); `victim.affix === 'voidtouched'` set by `Enemy.spawn` (Enemy.js:278); `VOIDTOUCHED.refund` (Task 1).
- Produces: `bleed(player, amount) -> number` — authority-gated, clamps to available world corruption, decrements the player's own pool (floor 0) and the world, emits `corruptionChanged` always and `corruptionBand` on a downward crossing. Task 4 does not call it; it exists for the kill listener and, later, cleansing fonts.

- [ ] **Step 1: Write the failing test**

Open `tests/corruption-system.test.mjs`, find the final summary lines (`console.log(`\n${pass} passed...` / `process.exit`), and insert before them, reusing the file's existing `makeCtx`/fixture helpers (the file already constructs a ctx with `authority`, `events`, and a player — mirror exactly how its existing arms build state):

```js
console.log('bleed drains the gauge and walks bands back down');
{
  const ctx = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  c.feed(ctx.player, 120);                       // band 3 (Overrun, at 110)
  const events = [];
  ctx.events.on('corruptionBand', (p) => events.push(p));
  const taken = c.bleed(ctx.player, 70);
  ok(taken === 70, 'bleed returns what it took');
  ok(c.world === 50, 'world dropped');
  ok(c.band === 1, 'band recomputed downward (50 is Seeded)');
  ok(events.length === 1 && events[0].band === 1 && events[0].prev === 3, 'downward crossing emitted');
  ok(c.corruptionOf(ctx.player) === 50, 'attribution followed');
  ok(c.bleed(ctx.player, 999) === 50, 'clamped to what exists');
  ok(c.world === 0, 'floor is zero');
  ok(c.bleed(ctx.player, -5) === 0 && c.bleed(ctx.player, NaN) === 0, 'junk refused');
}

console.log('a Hollowed kill refunds a fraction of the world');
{
  const ctx = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  c.feed(ctx.player, 100);
  ctx.events.emit('kill', { victim: { affix: 'voidtouched' }, source: ctx.player, position: null, isElite: true, isBoss: false });
  ok(Math.abs(c.world - 100 * (1 - VOIDTOUCHED.refund)) < 1e-9, 'refund is refund-fraction of current world');
  const w = c.world;
  ctx.events.emit('kill', { victim: { affix: 'blazing' }, source: ctx.player, position: null, isElite: true, isBoss: false });
  ctx.events.emit('kill', { victim: null, source: ctx.player, position: null, isElite: false, isBoss: false });
  ok(c.world === w, 'other kills refund nothing');
}
```

Add `VOIDTOUCHED` to the test file's imports: `import { VOIDTOUCHED } from '../src/data/corruption.js';`

- [ ] **Step 2: Run test to verify the new arms fail**

Run: `node tests/corruption-system.test.mjs` — new arms FAIL (`c.bleed is not a function`); existing arms still pass.

- [ ] **Step 3: Implement**

In `src/systems/Corruption.js`, add to the imports: `import { bandOf, SOURCES, VOIDTOUCHED } from '../data/corruption.js';` (extending the existing line).

In `init(ctx)`, after the `itemPickup` listener:

```js
    // Counterplay: a Voidtouched kill bleeds a fraction of the world's
    // corruption back to whoever landed it. Riding the kill event keeps
    // Combat ignorant of corruption — the same one-way rule as every feed.
    ctx.events.on('kill', ({ victim, source }) => {
      if (!victim || victim.affix !== VOIDTOUCHED.affix) return;
      const player = source && source.isPlayer ? source : ctx.player;
      this.bleed(player, this._world * VOIDTOUCHED.refund);
    });
```

After `feed()`:

```js
  /**
   * Remove corruption, attributed to `player` — the counterplay valve
   * (Voidtouched kills now; cleansing fonts later). Clamped to what exists;
   * band events fire on the way down exactly as they do on the way up, which
   * is what lets the HUD gauge, the grade pass and the route gate all walk
   * back without knowing why.
   */
  bleed(player, amount) {
    if (!this.ctx?.authority || !(amount > 0)) return 0;
    const taken = Math.min(this._world, amount);
    if (!(taken > 0)) return 0;
    if (player) {
      const own = this._byPlayer.get(player) || 0;
      this._byPlayer.set(player, Math.max(0, own - taken));
    }
    this._world -= taken;
    const prev = this._band;
    this._band = bandOf(this._world);
    this.ctx.events.emit('corruptionChanged', { world: this._world, band: this._band });
    if (this._band !== prev) this.ctx.events.emit('corruptionBand', { band: this._band, prev });
    return taken;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/corruption-system.test.mjs` — all arms PASS.
Run: `node tests/blight-system.test.mjs` — still green (Blight already handles downward band events: grading eases back, scars stay by design).

- [ ] **Step 5: Commit**

```bash
git add src/systems/Corruption.js tests/corruption-system.test.mjs
git commit -m "Corruption learns to bleed: Hollowed kills buy the world back"
```

---

### Task 4: The Director's void bank — spawns that surface from blight

**Files:**
- Modify: `src/systems/Director.js` (void bank state, seed tracking, `spendVoidCredits`, `findVoidPoint`, pending-surfacing loop)
- Test: `tests/voidtouched-director.test.mjs`

**Interfaces:**
- Consumes: `VOIDTOUCHED`, `voidCreditRate` (Task 1); `ELITE_STATS.voidtouched.cost`; `ctx.corruption?.world`; `blightSeed` / `stageStart` events; `ctx.seed`; `RNG` from `src/core/MathUtil.js`; existing `spawnOne`, `spawnTelegraph`, `countAlive`, `populationCap`, `SPAWN_CARDS`, `TIER_UNLOCK` (all already imported except `RNG`, `VOIDTOUCHED`, `voidCreditRate`).
- Produces: `voidtouchedSpawn { x, z, id }` event on each surfacing (for later audio/VFX passes); Director fields `voidCredits`, `_voidSeeds`, `_voidPending`, `_voidRng` (tests read these).

- [ ] **Step 1: Write the failing test**

```js
// tests/voidtouched-director.test.mjs
// A real Director, driven headless. Short sims on purpose: the normal spawn
// path first fires at spawnT = 2.0 s, so everything below stays under that and
// the only spawns in play are the void path's own.
import * as THREE from 'three';
import { Director } from '../src/systems/Director.js';
import { Roster } from '../src/systems/Roster.js';
import { RNG } from '../src/core/MathUtil.js';
import { VOIDTOUCHED } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeEvents() {
  const listeners = new Map();
  return {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
  };
}

function makePlayer(x, z) {
  return {
    isPlayer: true, alive: true, team: 'player', radius: 0.45, health: 110, maxHealth: 110,
    position: { x, y: 0, z }, velocity: { x: 0, y: 0, z: 0 },
    takeDamage() { return 0; },
  };
}

function makeWorld({ world = 0, seedRng = 777 } = {}) {
  const ctx = {
    rng: new RNG(seedRng), seed: 424242, time: 0, authority: true, netRole: 'single',
    scene: new THREE.Scene(), events: makeEvents(),
    stage: { sampleHeight: () => 0 },
    corruption: { world },
  };
  const roster = new Roster();
  roster.init(ctx);
  const player = makePlayer(100, 100);          // far from any seed at the origin
  ctx.player = player;
  roster.add(player);
  const d = new Director();
  d.init(ctx);
  return { ctx, d, player };
}

const H = 1 / 60;
const step = (ctx, d, seconds) => { for (let i = 0; i < Math.round(seconds / H); i++) { ctx.time += H; d.fixedUpdate(ctx, H); } };
const voids = (d) => d.enemies.filter((e) => e.affix === 'voidtouched');

console.log('a pristine world never touches the void path');
{
  const { ctx, d } = makeWorld({ world: 0 });
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  step(ctx, d, 1.9);
  ok(d.voidCredits === 0, 'no accrual at world 0');
  ok(voids(d).length === 0, 'no spawns');
}

console.log('no seeds, no spawns — corruption alone is not enough');
{
  const { ctx, d } = makeWorld({ world: 150 });
  step(ctx, d, 1.9);
  ok(d.voidCredits === 0, 'the bank only runs where greed left a mark');
  ok(voids(d).length === 0, 'no spawns');
}

console.log('world + seed = a Hollowed unit surfaces on the ring, telegraphed');
{
  const { ctx, d } = makeWorld({ world: 150 });
  const spawnEvents = [];
  ctx.events.on('voidtouchedSpawn', (p) => spawnEvents.push(p));
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = VOIDTOUCHED.maxBank;          // skip the accrual wait; spend logic is under test
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  const v = voids(d);
  ok(v.length === 1, 'exactly one surfaced');
  ok(spawnEvents.length === 1 && spawnEvents[0].id === v[0].def.id, 'voidtouchedSpawn event fired with the card id');
  const r = Math.hypot(v[0].position.x, v[0].position.z);
  ok(r >= VOIDTOUCHED.spawnRing.min - 0.01 && r <= VOIDTOUCHED.spawnRing.max + 0.01, `on the ring (got ${r.toFixed(2)} m)`);
  ok(!v[0].def.isFlyer && v[0].def.eliteEligible, 'a ground card the affix is legal on');
  ok(d.voidCredits < VOIDTOUCHED.maxBank, 'the spawn was paid for');
}

console.log('placement draws nothing from the shared stream');
{
  const a = makeWorld({ world: 150 });
  const b = makeWorld({ world: 150 });
  for (let i = 0; i < 5; i++) b.ctx.rng.next();  // displace B's shared stream
  for (const w of [a, b]) {
    w.ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
    w.d.voidCredits = VOIDTOUCHED.maxBank;
    step(w.ctx, w.d, VOIDTOUCHED.telegraph + 0.4);
  }
  const va = voids(a.d)[0], vb = voids(b.d)[0];
  ok(!!va && !!vb, 'both worlds surfaced one');
  ok(va.position.x === vb.position.x && va.position.z === vb.position.z,
    'identical surfacing point despite a displaced ctx.rng — every roll came from the derived stream');
  ok(va.def.id === vb.def.id, 'and the same card');
}

console.log('it will not surface in your face');
{
  const { ctx, d, player } = makeWorld({ world: 150 });
  player.position.x = 0; player.position.z = 0;   // standing ON the seed
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = VOIDTOUCHED.maxBank;
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  ok(voids(d).length === 0, 'every candidate inside minPlayerDist was refused');
}

console.log('stageStart wipes seeds, pending surfacings and the bank');
{
  const { ctx, d } = makeWorld({ world: 150 });
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = VOIDTOUCHED.maxBank;
  step(ctx, d, 0.2);                              // telegraph queued, not yet surfaced
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  ok(voids(d).length === 0, 'the pending surfacing died with the stage');
  ok(d._voidSeeds.length === 0 && d.voidCredits === 0, 'seeds and bank cleared');
}

console.log('the bank is capped');
{
  const { ctx, d } = makeWorld({ world: 10000 });
  ctx.events.emit('blightSeed', { x: 500, z: 500, strength: 1 });  // far seed: accrual runs, spends fail (no walkable check needed — ring points are fine, but keep the player 100,100 far so spends succeed; cap still binds first at this rate)
  step(ctx, d, 1.5);
  ok(d.voidCredits <= VOIDTOUCHED.maxBank + 1e-9, 'maxBank holds');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/voidtouched-director.test.mjs`
Expected: FAIL — `d.voidCredits` undefined, no spawns surface.

- [ ] **Step 3: Implement**

In `src/systems/Director.js`:

**Imports** — extend the existing lines: add `RNG` to the `../core/MathUtil.js` import (currently `clamp`, `lerp`); add a new import `import { VOIDTOUCHED, voidCreditRate } from '../data/corruption.js';`.

**Constructor** (with the other state fields near line 93):

```js
    // The void's own economy — see VOIDTOUCHED in data/corruption.js. Seeds
    // are tracked here (not read from ctx.corruption.seeds) because that list
    // is run-scoped and this one must die with the stage.
    this.voidCredits = 0;
    this.voidSpawnT = 0;
    this._voidSeeds = [];
    this._voidPending = [];
    this._voidRng = new RNG(1);
```

**`init(ctx)`** — after the existing `stageStart` listener block (line ~175-181), add inside that same handler the void resets, and register the seed listener after it. The stageStart handler becomes:

```js
    ctx.events.on('stageStart', (p) => {
      this.stagesCompleted = p && typeof p.index === 'number' ? p.index : this.stagesCompleted + 1;
      this.credits = CREDIT_SEED;
      this.eventActive = false;
      this.boss = null;
      this.clear(ctx);
      // The void's slate is per-stage: seeds, queued surfacings and the bank
      // all die with the ground they referred to. The stream is re-derived
      // from (run seed, stage) — the shrine-roll shape — so a corrupted run
      // is deterministic per stage without ever touching ctx.rng.
      this._voidSeeds.length = 0;
      this._voidPending.length = 0;
      this.voidCredits = 0;
      this.voidSpawnT = 0;
      this._voidRng = new RNG(((ctx.seed >>> 0) ^ (0x7f4a7c15 * (this.stagesCompleted + 1))) >>> 0 || 1);
    });
    // Where greed happened. Capped mirror of the event stream, oldest first.
    ctx.events.on('blightSeed', (s) => {
      this._voidSeeds.push({ x: s.x, z: s.z, strength: s.strength });
      if (this._voidSeeds.length > 32) this._voidSeeds.shift();
    });
```

Also seed `_voidRng` once at the end of `init` (stage 0 has no `stageStart` before play in every path, and `RNG(1)` must never survive to a real roll):

```js
    this._voidRng = new RNG(((ctx.seed >>> 0) ^ (0x7f4a7c15 * (this.stagesCompleted + 1))) >>> 0 || 1);
```

**`reset()`** (line ~866) — add the same five void resets (`_voidSeeds.length = 0`, `_voidPending.length = 0`, `voidCredits = 0`, `voidSpawnT = 0`, and re-derive `_voidRng` with the same expression, using `this.ctx.seed`, guarded: `if (ctx) this._voidRng = new RNG(((ctx.seed >>> 0) ^ (0x7f4a7c15 * (stageIndex + 1))) >>> 0 || 1);`).

**`fixedUpdate`** — after the `spawnT` / `spendCredits` block (line ~341-345), still inside the method:

```js
    // The void's bank. A separate stream and a separate budget: rate is a
    // function of World Corruption alone, spends happen only where a blight
    // seed exists this stage, and none of it draws on ctx.rng — which is the
    // whole sp-equivalence argument: at world 0 this block is two reads.
    const world = ctx.corruption?.world || 0;
    if (world > 0 && this._voidSeeds.length) {
      this.voidCredits = Math.min(VOIDTOUCHED.maxBank, this.voidCredits + voidCreditRate(world) * h);
      this.voidSpawnT -= h;
      if (this.voidSpawnT <= 0) {
        this.voidSpawnT = VOIDTOUCHED.interval;
        this.spendVoidCredits(ctx);
      }
    }
    // Queued surfacings ripen on their own clock so the telegraph is honest.
    for (let i = this._voidPending.length - 1; i >= 0; i--) {
      const p = this._voidPending[i];
      p.t -= h;
      if (p.t > 0) continue;
      this._voidPending.splice(i, 1);
      if (this.enemies.length >= this.populationCap) continue;
      this._scratch.set(p.x, p.y, p.z);
      const e = this.spawnOne(ctx, p.card, this._scratch, VOIDTOUCHED.affix);
      ctx.events.emit('voidtouchedSpawn', { x: p.x, z: p.z, id: p.card.id });
    }
```

**New methods** (after `spendCredits`, before `spawnOne`):

```js
  /**
   * Buy one Voidtouched unit at a blight seed. Every roll here comes from
   * `_voidRng` — the per-(run seed, stage) derived stream — because this path
   * only exists when corruption does, and a single draw on ctx.rng would shift
   * every later shared roll relative to a corruption-free run of the same
   * seed, which is exactly what the sp-equivalence gate forbids.
   */
  spendVoidCredits(ctx) {
    if (!this._voidSeeds.length || this.enemies.length >= this.populationCap) return;
    const stats = ELITE_STATS[VOIDTOUCHED.affix];
    // Ground-walking, elite-eligible, tier-unlocked, under its own cap: the
    // void corrupts the stage's fauna, it does not import new species.
    const d = this.difficultyCoefficient;
    const pool = [];
    for (const c of SPAWN_CARDS) {
      if (!c.eliteEligible || c.isFlyer) continue;
      if (d < (TIER_UNLOCK[c.tier] ?? Infinity)) continue;
      if (this.countAlive(c) >= (c.maxAlive || 99)) continue;
      pool.push(c);
    }
    if (!pool.length) return;
    const card = this._voidRng.weighted(pool, (c) => (c.selectionWeight ?? 1));
    const unit = card.cost * stats.cost;
    if (this.voidCredits < unit) return;
    const seed = this._voidRng.pick(this._voidSeeds);
    const at = this.findVoidPoint(ctx, seed);
    if (!at) return;
    this.voidCredits -= unit;
    this.spawnTelegraph(at.x, at.z, 2.2, VOIDTOUCHED.telegraph, 0xd8479b);
    this._voidPending.push({ t: VOIDTOUCHED.telegraph, x: at.x, y: at.y, z: at.z, card });
  }

  /** A surfacing point on the ring around a seed, clear of every player. */
  findVoidPoint(ctx, seed) {
    const min2 = VOIDTOUCHED.minPlayerDist * VOIDTOUCHED.minPlayerDist;
    for (let i = 0; i < 8; i++) {
      const a = this._voidRng.range(0, Math.PI * 2);
      const r = this._voidRng.range(VOIDTOUCHED.spawnRing.min, VOIDTOUCHED.spawnRing.max);
      const x = seed.x + Math.cos(a) * r;
      const z = seed.z + Math.sin(a) * r;
      let tooClose = false;
      const check = (p) => {
        const dx = p.position.x - x, dz = p.position.z - z;
        if (dx * dx + dz * dz < min2) tooClose = true;
      };
      if (ctx.roster) ctx.roster.forEachTargetable(check);
      else if (ctx.player) check(ctx.player);
      if (tooClose) continue;
      const y = ctx.stage?.sampleHeight?.(x, z);
      return { x, y: Number.isFinite(y) ? y : 0, z };
    }
    return null;
  }
```

Note: `findVoidPoint` deliberately skips `findSpawnPoint`'s `MIN_SPAWN_DIST` (34 m) — the whole point is that these surface *near* the party's past greed, just outside `minPlayerDist` fairness range.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/voidtouched-director.test.mjs` — all arms PASS.
Run: `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Director.js tests/voidtouched-director.test.mjs
git commit -m "The blight produces fights: Hollowed units surface where greed left seeds"
```

---

### Task 5: Contracts, gates, live verification, and the shot

**Files:**
- Modify: `CONTRACTS.md` (events table + ctx note)
- Possibly regenerate: `reviews/round8/elite-baseline-HEAD.json` (only if the gate diff is exactly the new affix block — see Step 2)
- Create: `shots-voidtouched/` captures via `tools/capture.mjs` conventions

**Interfaces:** none new — this task proves the previous four.

- [ ] **Step 1: Document the contract**

In `CONTRACTS.md`, add to the events table:

```markdown
| `voidtouchedSpawn` | `{ x, z, id }` — a Hollowed unit surfaced from blight | Director |
```

And extend the `corruption` row's description: `read `world`/`band`, call `feed`/`seed`/`bleed`. Never import it`.

- [ ] **Step 2: Run the gates**

Run: `npm test` — full suite green.
Run: `npm run gate:elite` — expected: **no fields moved**. The void path draws zero `ctx.rng` and is inert at world 0, so the equivalence fixture must be bit-identical. If the gate reports a diff, inspect it: a diff that is *only* the presence of a new `voidtouched` block in the report means the harness enumerates `ELITE_STATS` and the baseline predates the affix — regenerate the baseline via the same command the file header documents, commit it with its capture source named in the message (repo baseline-capture convention), and re-run to green. **Any other diff is a real regression: stop and fix, do not regenerate.**

- [ ] **Step 3: Verify by playing**

Run `npm run dev`, start a run, and confirm:
- Void-credit a chest (or open several paid ones) to plant seeds and climb the gauge → within ~30 s a pink telegraph ring appears beside a blight patch and a magenta-ringed elite surfaces out of it.
- The unit reads as its own family at range: violet/magenta tint, two rings, shard bits — not confusable with Warded (purple but ringless/barrier) at 40 m.
- Stand next to it: health drains in 0.5 s ticks while its own bar refills; back out of ~3.6 m and both stop.
- Kill it: the HUD corruption gauge visibly drops.
- The kill feed / boss label shows **Hollowed**, never "voidtouched".
- It never surfaces within ~12 m of you, and never on a pristine (band 0, no-chest) run.
- New stage → no carryover surfacings; console: zero errors.

If driving the game interactively is impossible in this environment, verify what is checkable headlessly and report exactly which checks were not performed.

- [ ] **Step 4: Capture the shot**

Via `tools/capture.mjs` conventions into `shots-voidtouched/`: a Hollowed unit mid-surface on its telegraph ring at a blight patch edge, HUD gauge in frame — the "blight produces fights" beat of the trailer thesis shot.

- [ ] **Step 5: Commit**

```bash
git add CONTRACTS.md shots-voidtouched
git commit -m "The void keeps receipts: contract rows, gates green, first Hollowed shots"
```

---

## Self-review notes

- **Spec coverage (this slice):** "fourth elite family that only emerges from blight" ✓ (Task 4 — seed-anchored spawns, not in the normal roll), "spawn budget scaled by World Corruption" ✓ (Task 1 `voidCreditRate` + Task 4 bank), "rides the existing Director elite affix machinery" ✓ (`spawnOne(ctx, def, at, 'voidtouched')`, `ELITE_STATS`, `EnemyMeshes.ELITE`), "Voidtouched kills return a fraction of corruption" ✓ (Tasks 1+3), sp-equivalence / derived-stream requirement ✓ (Task 4 derived `RNG` + the displaced-stream test arm + Task 5 gate). Deliberately deferred: per-band audio sting for `voidtouchedSpawn` (audio pass), a bespoke surfacing VFX beyond the telegraph ring (VFX pass), item mutation (its own slice), co-op replication of void spawns (rides the existing enemy replication — host spawns, clients see enemies; the event row is documented for the net pass to confirm).
- **Type consistency:** `VOIDTOUCHED.{affix, ratePerWorld, maxBank, interval, telegraph, spawnRing.min/max, minPlayerDist, refund}`, `voidCreditRate(world)`, `ELITE_STATS.voidtouched.{label, health, damage, cost, speed, siphonRadius, siphonDps, siphonHeal}`, `bleed(player, amount) -> number`, event `voidtouchedSpawn { x, z, id }`, Director fields `voidCredits/_voidSeeds/_voidPending/_voidRng/voidSpawnT` — used identically across Tasks 1–5.
- **Known execution-time checks (deliberate):** `tests/corruption-system.test.mjs` fixture helper names (Task 3 Step 1 says mirror the file's own `makeCtx` idiom); the exact `gate:elite` report shape if it diffs (Task 5 Step 2 decision rule); `Director.reset()`'s local variable names when adding the void resets (Task 4 Step 3 describes the exact fields, implementer matches surrounding style).
