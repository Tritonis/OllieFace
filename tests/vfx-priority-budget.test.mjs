// tests/vfx-priority-budget.test.mjs
//
// #225: a gameplay-priority budget for combat VFX. Two independent gaps,
// covered here without a GPU:
//
//  1. RingPool/SectorPool are fixed-capacity ring buffers (48/24 slots) that
//     used to wrap with a bare `head = (head + 1) % capacity`, overwriting
//     whatever was in the next slot whether or not it was still an active
//     cue. This pins the fix: reuse an expired slot first, and only when
//     every slot is genuinely live evict the one closest to naturally
//     expiring (never the newest), counting the eviction.
//
//  2. `ParticleSystem.emit` had no notion of priority at all — decoration and
//     a threat-relevant burst competed for the same pool on equal footing.
//     This pins the budget: decoration sheds once too much of it is alive at
//     once, a `threat: true` emit never does, and the whole decision is
//     deterministic (no `Math.random()`).
//
// Falsification, run by hand before this file was committed:
//   * reverting `acquireCueSlot` to `head = (head + 1) % capacity` turns the
//     "no active telegraph is silently overwritten" checks red;
//   * removing the `decorationBudget` gate in `emit()` turns 'the shed
//     counter actually counts something' red, and disabling
//     `decorationShedEnabled` is the guard-can-fail arm: it turns 'decoration
//     stays under budget' red on the very scenario the budget is meant to
//     catch, proving that arm is not vacuously true.
// `ParticleSystem.init` allocates a canvas atlas via `document.createElement`,
// which does not exist in plain Node. Stubbed the same way
// `vfx-atlas-failure.test.mjs` stubs it for its failure path, except here the
// stub succeeds: every 2D context call is a recorded no-op rather than a
// throw, so the atlas drawers run to completion and `init()` gets a real
// layer/attribute set to spawn into. Nothing under test reads canvas pixels.
function stub2dContext() {
  const store = {};
  const handler = {
    get(_t, prop) { return prop in store ? store[prop] : (() => stub2dContext()); },
    set(_t, prop, v) { store[prop] = v; return true; },
  };
  return new Proxy({}, handler);
}
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    return { width: 0, height: 0, getContext: () => stub2dContext() };
  },
};
globalThis.innerWidth ??= 800;
globalThis.innerHeight ??= 600;

import * as THREE from 'three';
import { RingPool, SectorPool } from '../src/systems/VFX.js';
import { ParticleSystem, DECORATION_BUDGET } from '../src/fx/ParticleSystem.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const sceneCtx = () => ({ scene: new THREE.Scene() });
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const AXIS = V(0, 1, 0);
const FACING = V(0, 0, 1);

/** Read the origin.x this pool stored in slot `i`, so a test can tell slots apart. */
const originX = (pool, i) => pool.aOrigin.array[i * 3];

console.log('RingPool: an expired slot is reused before anything live is touched');
{
  const pool = new RingPool(sceneCtx(), 4);
  // Fill all 4 slots, tagging each with a distinct origin.x. Slot 1 gets a
  // short life; the rest are long-lived so they must still be standing at
  // the end of this block.
  pool.spawn(V(10, 0, 0), AXIS, 0xffffff, 0, 1, 5.0);
  pool.spawn(V(11, 0, 0), AXIS, 0xffffff, 0, 1, 0.1); // short-lived
  pool.spawn(V(12, 0, 0), AXIS, 0xffffff, 0, 1, 5.0);
  pool.spawn(V(13, 0, 0), AXIS, 0xffffff, 0, 1, 5.0);
  ok(pool.evictions === 0, 'filling exactly to capacity evicts nothing');

  // Let slot 1's cue expire, but nothing else's.
  pool.update(0.2, null, null, 0, 0);

  // A 5th spawn must land in the now-expired slot 1, not force out one of
  // the three still-live cues.
  pool.spawn(V(99, 0, 0), AXIS, 0xffffff, 0, 1, 5.0);
  ok(pool.evictions === 0, 'reusing an expired slot is not counted as an eviction');
  const xs = [0, 1, 2, 3].map((i) => originX(pool, i));
  ok(xs.includes(10) && xs.includes(12) && xs.includes(13),
     `the three live cues are all still present (got [${xs}])`);
  ok(xs.includes(99) && !xs.includes(11),
     'the new cue took the expired slot, not a live one');
}

console.log('RingPool: once every slot is genuinely live, eviction (never the newest) is forced and counted');
{
  const pool = new RingPool(sceneCtx(), 3);
  pool.spawn(V(1, 0, 0), AXIS, 0xffffff, 0, 1, 10.0);
  pool.spawn(V(2, 0, 0), AXIS, 0xffffff, 0, 1, 10.0);
  // The soonest-to-expire of the three: this is the one that must go.
  pool.spawn(V(3, 0, 0), AXIS, 0xffffff, 0, 1, 1.0);
  pool.update(0.05, null, null, 0, 0);

  pool.spawn(V(4, 0, 0), AXIS, 0xffffff, 0, 1, 10.0);
  ok(pool.evictions === 1, `exactly one eviction was counted (got ${pool.evictions})`);
  const xs = [0, 1, 2].map((i) => originX(pool, i));
  ok(xs.includes(1) && xs.includes(2) && xs.includes(4),
     `the two long-lived cues survive alongside the new one (got [${xs}])`);
  ok(!xs.includes(3), 'and the cue closest to expiring on its own is the one that was pushed out');
}

console.log('SectorPool: the same slot-preservation rule holds for ground-arc telegraphs');
{
  const pool = new SectorPool(sceneCtx(), 3);
  pool.spawn(V(1, 0, 0), AXIS, FACING, 0.5, 0xffffff, 0, 1, 10.0);
  pool.spawn(V(2, 0, 0), AXIS, FACING, 0.5, 0xffffff, 0, 1, 10.0);
  pool.spawn(V(3, 0, 0), AXIS, FACING, 0.5, 0xffffff, 0, 1, 1.0);
  pool.update(0.05, null, null, 0, 0);
  pool.spawn(V(4, 0, 0), AXIS, FACING, 0.5, 0xffffff, 0, 1, 10.0);
  ok(pool.evictions === 1, `exactly one eviction was counted (got ${pool.evictions})`);
  const xs = [0, 1, 2].map((i) => originX(pool, i));
  ok(xs.includes(1) && xs.includes(2) && xs.includes(4) && !xs.includes(3),
     `the soonest-to-expire arc was evicted, not the two still telling the player something (got [${xs}])`);
}

function makeRng(seed) {
  let n = seed >>> 0;
  return { next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; } };
}

/** A `ParticleSystem` wired far enough to `emit()` into real ring buffers. */
function makeParticleSystem() {
  const ps = new ParticleSystem({ capacityAdditive: 4096, capacityAlpha: 2048 });
  ps.init({ scene: new THREE.Scene(), fxRng: makeRng(2225), pipeline: { quality: 0 } });
  return ps;
}

// A fixed, dense, over-budget sequence: ten more bursts than the budget can
// hold concurrently, each the same size, each with a fixed non-varying life
// so the expected shed count is exact, not approximate.
const BURST = Math.ceil(DECORATION_BUDGET / 10);
const BURSTS = 20;
const emitDecoration = (ps) => {
  for (let i = 0; i < BURSTS; i++) {
    ps.emit({ position: new THREE.Vector3(i, 0, 0), count: BURST, life: 1.0, lifeVar: 0 });
  }
};

console.log('ParticleSystem: decoration sheds once too much of it is alive at once, deterministically');
{
  const ps = makeParticleSystem();
  emitDecoration(ps);
  const snap = ps.decorationBudgetSnapshot();
  // 10 of the 20 bursts fit under budget exactly; the other 10 are shed in full.
  const expectedShed = (BURSTS - Math.floor(DECORATION_BUDGET / BURST)) * BURST;
  ok(snap.active === DECORATION_BUDGET, `active decoration lands exactly at budget (${snap.active} === ${DECORATION_BUDGET})`);
  ok(snap.shed === expectedShed, `shed count is exact, not approximate (${snap.shed} === ${expectedShed})`);
  ok(snap.shed > 0, 'and it is nonzero — the guard actually fired');
}

console.log('ParticleSystem: a threat-tagged emit is never shed, even while decoration is saturated');
{
  const ps = makeParticleSystem();
  emitDecoration(ps);
  const L = ps.layers.add;
  const before = L.head;
  const n = 37;
  const activeBefore = ps.decorationBudgetSnapshot().active;
  ps.emit({ position: new THREE.Vector3(), count: n, life: 1.0, lifeVar: 0, threat: true });
  const delta = (L.head - before + L.capacity) % L.capacity;
  ok(delta === n, `the full threat-tagged count landed in the pool despite saturation (${delta} === ${n})`);
  ok(ps.decorationBudgetSnapshot().active === activeBefore,
     'and a threat emit does not itself count against, or grow, the decoration budget');
}

console.log('guard-can-fail: disabling the shed gate lets decoration blow past budget, proving the gate is load-bearing');
{
  const ps = makeParticleSystem();
  ps.decorationShedEnabled = false;
  emitDecoration(ps);
  const snap = ps.decorationBudgetSnapshot();
  ok(snap.active === BURST * BURSTS,
     `with shedding off, every particle in the same over-budget script lands (${snap.active} === ${BURST * BURSTS})`);
  ok(snap.active > DECORATION_BUDGET, `which is over budget (${snap.active} > ${DECORATION_BUDGET})`);
  ok(snap.shed === 0, 'and nothing was counted as shed, confirming this run exercised the gate being off, not a no-op scenario');
}

console.log('ParticleSystem: a short-lived burst queued behind a long-lived one still decays on its own schedule (fix wave)');
{
  // The reviewer's exact repro: mixed-life bursts are the normal case (smoke
  // seconds-long, sparks sub-second), and `expireAt` is not non-decreasing in
  // insertion order. A queue that only ever inspects its front entry gets
  // stuck behind the long-lived one and over-reports `active` — which
  // over-sheds decoration well past what the true live count justifies.
  const ps = new ParticleSystem({ capacityAdditive: 4096, capacityAlpha: 2048, decorationBudget: 200 });
  ps.init({ scene: new THREE.Scene(), fxRng: makeRng(2225), pipeline: { quality: 0 } });

  ps.time = 0;
  ps.emit({ position: new THREE.Vector3(), count: 150, life: 10, lifeVar: 0 }); // long-lived smoke
  ps.time = 1;
  ps.emit({ position: new THREE.Vector3(), count: 100, life: 0.2, lifeVar: 0 }); // short-lived sparks
  let snap = ps.decorationBudgetSnapshot();
  ok(snap.active === 200, `at t=1 active sits at budget (${snap.active})`);
  ok(snap.shed === 50, `and only the 50 sparks that didn't fit were shed (${snap.shed})`);

  ps.time = 1.3; // past the sparks' 1.2 s expiry, well short of the smoke's 10 s
  ps._decayDecoration();
  snap = ps.decorationBudgetSnapshot();
  ok(snap.active === 150,
     `at t=1.3 the short burst has expired out and active reflects only the still-live smoke (${snap.active})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
