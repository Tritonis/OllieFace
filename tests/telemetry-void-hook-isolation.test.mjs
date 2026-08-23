/**
 * The four void-economy hooks (`onVoidMarks`, `onVoidBargain`,
 * `onVoidSanctuary`, `onVoidRuin`) are isolated per-hook rather than sharing
 * the global `broken` latch every other capture hook still uses.
 *
 *   node tests/telemetry-void-hook-isolation.test.mjs
 *
 * Before the fix these four hooks were wrapped by the same `guard()` every
 * other hook uses, so one throwing hook set `this.broken = true` and every
 * other hook — void or not — went silent for the rest of the run, with the
 * export carrying no sign of which hook had died. This file proves the fix
 * red against that old behaviour first (a hand-rolled `oldGuard` reproducing
 * it), then green against the real module.
 */
import { Engine } from '../src/core/Engine.js';
import { installTelemetry, setTelemetryEnabled, readRuns } from '../src/systems/Telemetry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get size() { return m.size; },
  };
}

function fresh() {
  const engine = new Engine({ canvas: null, seed: 3 });
  engine.running = true;
  return engine;
}

function quietly(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { fn(); } finally { console.error = real; }
  return lines;
}

console.log('RED: the old global-latch behaviour would have voided every hook');
{
  // A minimal reproduction of the pre-fix `guard()` applied to all hooks
  // alike, to prove the old shape really did have this defect before
  // asserting the new module no longer does.
  class OldRecorder {
    constructor() { this.broken = false; this.marksHits = 0; this.sanctuaryHits = 0; }
    guard(fn) {
      return (payload) => {
        if (this.broken) return;
        try { fn.call(this, payload); } catch (err) { this.broken = true; }
      };
    }
    onVoidMarks() { throw new Error('boom in onVoidMarks'); }
    onVoidSanctuary() { this.sanctuaryHits++; }
  }
  const rec = new OldRecorder();
  const marks = rec.guard(rec.onVoidMarks);
  const sanctuary = rec.guard(rec.onVoidSanctuary);
  marks({});
  sanctuary({});
  ok(rec.broken === true, 'RED: one throwing hook set the global latch');
  ok(rec.sanctuaryHits === 0, 'RED: and a healthy sibling hook never ran again — the defect this ticket fixes');
}

console.log('GREEN: a throwing void hook disables only itself; siblings and the export stay live');
{
  const storage = fakeStorage();
  setTelemetryEnabled(true, storage);
  const engine = fresh();
  const ctx = engine.ctx;
  const rec = installTelemetry(ctx, { storage });
  ok(rec.active === true, 'the recorder is live');

  // Break exactly one void hook, the way a real defect would: corrupt the
  // state `onVoidMarks` itself reads, so the throw comes from inside the
  // live, subscribed hook rather than from a swapped-out method the bus
  // would never have dispatched to.
  rec.record.corruption.marks = null;

  const errors = quietly(() => {
    ctx.events.emit('voidMarksChanged', { marks: 5 });
    ctx.events.emit('voidMarksChanged', { marks: 6 }); // second call: silently skipped, not re-thrown
    ctx.events.emit('voidSanctuary', { seconds: 10, world: 3, greed: false });
    ctx.events.emit('voidBargain', { kind: 'sanctuary', id: 'a', marks: 1 });
    ctx.events.emit('voidRuin', {});
  });

  ok(rec.broken === false, '(a) the global latch was never tripped');
  ok(rec.record.sanctuaries.length === 1, '(a) onVoidSanctuary still recorded its event');
  ok(rec.record.bargains.length === 1, '(a) onVoidBargain still recorded its event');
  ok(rec.record.corruption.ruined === true, '(a) onVoidRuin still recorded its event');

  ctx.events.emit('runEnd', { won: true, stats: { kills: 0 } });
  ok(readRuns(storage).length === 1, '(b) the run export still emitted, despite the broken hook');

  const runs = readRuns(storage);
  const brokenNames = runs[0].brokenHooks.map((b) => b.name);
  ok(brokenNames.includes('onVoidMarks'), '(c) the export names which hook broke');
  ok(errors.length === 1, `the failure was logged exactly once, not once per later call (got ${errors.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
