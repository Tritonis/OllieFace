import { Blight, radiusOf, RADIUS, MAX_PATCHES } from '../src/systems/Blight.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 4242) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
  };
  return r;
}

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    fxRng: makeRng(),
    corruption: { world: 0 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  return ctx;
}

console.log('radiusOf is monotonic in both inputs and capped');
{
  ok(radiusOf(1, 0) === RADIUS.base + RADIUS.perStrength, 'strength-1 seed at zero world');
  ok(radiusOf(3, 0) > radiusOf(1, 0), 'stronger seeds start bigger');
  ok(radiusOf(1, 100) > radiusOf(1, 10), 'world corruption grows every patch');
  ok(radiusOf(3, 10000) === RADIUS.cap, 'cap holds');
}

console.log('seeds become patch records via the event');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  ok(ctx.blight === b, 'init claims ctx.blight');
  ctx.events.emit('blightSeed', { x: 4, z: -9, strength: 2 });
  ok(b.patches.length === 1, 'one patch');
  const p = b.patches[0];
  ok(p.x === 4 && p.z === -9 && p.strength === 2, 'position and strength carried');
  ok(p.seedNoise >= 0 && p.seedNoise < 100, 'per-patch cosmetic noise drawn from fxRng');
  ok(p.maxR === RADIUS.cap, 'max radius reserved for growth headroom');
}

console.log('the patch list is capped and clears on stageStart');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  for (let i = 0; i < MAX_PATCHES + 20; i++) ctx.events.emit('blightSeed', { x: i, z: 0, strength: 1 });
  ok(b.patches.length === MAX_PATCHES, `capped at ${MAX_PATCHES}`);
  ok(b.patches[0].x === 20, 'oldest patches dropped first');
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  ok(b.patches.length === 0, 'a new stage starts clean');
}

console.log('band tracking follows corruptionBand');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  ok(b.band === 0, 'starts Pristine');
  ctx.events.emit('corruptionBand', { band: 3, prev: 2 });
  ok(b.band === 3, 'adopts the event band');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
