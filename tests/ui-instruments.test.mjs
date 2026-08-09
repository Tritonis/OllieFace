/**
 * The seismograph trace is procedural, pure and deterministic.
 *
 *   node tests/ui-instruments.test.mjs
 *
 * The diegetic UI treatment (launch spec 3.3) is mostly CSS, which cannot be
 * unit-tested for how it looks — the shot harness judges that. But the trace
 * is the one part of it that is logic: a path string derived from data or from
 * a seed. It is tested the way `Icons.js`'s other procedural art wants to be
 * and never was: exact geometry, exact determinism.
 *
 * Determinism is not a nicety here. The traces are baked into committed
 * screenshot baselines, so a trace that wandered between runs would make every
 * UI baseline unreproducible.
 */
import { tracePath, tracePathFrom, hash } from '../src/ui/Icons.js';
import { gaugeGradations } from '../src/ui/HUD.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('tracePathFrom plots values exactly');
{
  ok(tracePathFrom([0, 0.5, 1], { h: 10 }) === 'M 0.00 10.00 L 50.00 5.00 L 100.00 0.00',
     'three values span the box, 0 at the floor and 1 at the ceiling');
  ok(tracePathFrom([1, 1], { h: 10 }) === 'M 0.00 0.00 L 100.00 0.00', 'a full pair rides the ceiling');
  ok(tracePathFrom([-4, 9], { h: 10 }) === 'M 0.00 10.00 L 100.00 0.00', 'out-of-range values clamp, they do not escape the box');
  ok(tracePathFrom([], { h: 10 }) === 'M 0.00 5.00 L 100.00 5.00', 'nothing to plot is a resting pen, not an empty attribute');
  ok(tracePathFrom([0.25], { h: 10 }) === 'M 0.00 5.00 L 100.00 5.00', 'one sample is not a line either');
  ok(tracePathFrom([0, 1], { h: 10, amp: 0 }) === 'M 0.00 5.00 L 100.00 5.00', 'amp 0 flattens without special-casing');
  ok(tracePathFrom([0, 1], { h: 4 }).endsWith('L 100.00 0.00'), 'h scales the box');
}

console.log('tracePath is a deterministic pen');
{
  const a = tracePath('telluric', { points: 16 });
  ok(a === tracePath('telluric', { points: 16 }), 'same seed, same path — baselines stay reproducible');
  ok(a !== tracePath('void', { points: 16 }), 'a different seed draws a different trace');
  ok(tracePath(1337, { points: 16 }) === tracePath('1337', { points: 16 }), 'numeric seeds coerce like every other Icons id');
  const pts = a.split(' L ').length;
  ok(pts === 16, `16 points requested, ${pts} drawn`);
  const nums = a.match(/-?\d+\.\d+/g).map(Number);
  ok(nums.every((n) => n >= 0), 'no coordinate escapes the box on the low side');
  const xs = nums.filter((_, i) => i % 2 === 0);
  ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), 'x advances monotonically — a plotter never backs up');
  ok(xs[0] === 0 && xs[xs.length - 1] === 100, 'the trace spans the full box');
  const yss = nums.filter((_, i) => i % 2 === 1);
  ok(yss.every((y) => y >= 0 && y <= 10), 'every y sits inside the default 10-high box');
  ok(new Set(yss).size > 4, 'the pen actually moves — a flat line is not a seismograph');
}

console.log('the gauge gradations are the real band thresholds');
{
  const g = gaugeGradations();
  ok(g.length === 4, 'four gradations for five bands — Pristine is the origin, not a mark');
  ok(g[0].name === 'Seeded' && g[0].pct === 10.53, `Seeded engraves at ${g[0].pct}% (20/190)`);
  ok(g[1].name === 'Blighted' && g[1].pct === 28.95, `Blighted engraves at ${g[1].pct}% (55/190)`);
  ok(g[2].name === 'Overrun' && g[2].pct === 57.89, `Overrun engraves at ${g[2].pct}% (110/190)`);
  ok(g[3].name === 'Consumed' && g[3].pct === 100, 'Consumed is the top of the scale');
  ok(gaugeGradations([{ id: 0, name: 'a', at: 0 }, { id: 1, name: 'b', at: 50 }])[0].pct === 100,
     'the function reads whatever BANDS it is handed, so re-tuning corruption re-engraves the gauge');
}

console.log('the gauge trace is a ring buffer written through the diff cache');
{
  const { HUD } = await import('../src/ui/HUD.js');
  // Same idiom as tests/hud-strip-hold.test.mjs: a real HUD needs a document,
  // so the method is driven through the prototype on a hand-built `this`
  // carrying only the fields the gauge block touches.
  let writes = 0, lastD = null;
  const noop = { toggle() {}, add() {}, remove() {} };
  const self = Object.create(HUD.prototype);
  self.c = {};
  self.moneyShown = 0;
  self.refs = {
    money: { classList: noop }, moneyVal: { textContent: '' },
    corruption: { dataset: {}, classList: noop },
    corruptionFill: { style: {} },
    corruptionBand: { textContent: '' },
    corruptionRoute: { textContent: '', classList: noop },
    corruptionTrace: { setAttribute: (k, v) => { writes++; lastD = v; } },
  };
  const ctx = (world) => ({
    items: { gold: 0 },
    corruption: { world, band: 0 },
    progression: { stageIndex: 0 },   // < 2, so the route branch stays out of this test
  });

  // Ten seconds at a flat zero. `_traceT` starts primed, so the pen strikes on
  // the first frame and then every 1.5 s: 7 samples in 600 frames at 1/60.
  for (let i = 0; i < 600; i++) self.updateMoney(ctx(0), 1 / 60);
  ok(self._trace.length === 7, `7 samples in 10 s at a 1.5 s interval (held ${self._trace.length})`);
  ok(writes === 7, `one write per sample while the window is still filling (wrote ${writes})`);

  // Once the window is full, a still instrument costs nothing: the buffer's
  // quantised key stops changing and `this.set` swallows every write. This is
  // the property that lets the pen live in the per-frame update at all.
  for (let i = 0; i < 5000; i++) self.updateMoney(ctx(0), 1 / 60);
  ok(self._trace.length === 48, `the ring buffer caps at 48 samples (held ${self._trace.length})`);
  const settled = writes;
  for (let i = 0; i < 600; i++) self.updateMoney(ctx(0), 1 / 60);
  ok(writes === settled, `a flat, full window writes nothing further (${writes - settled} extra writes)`);

  // A climbing run redraws.
  for (let i = 0; i < 600; i++) self.updateMoney(ctx(i), 1 / 60);
  ok(writes > settled, 'a climbing run redraws the pen');
  ok(typeof lastD === 'string' && lastD.startsWith('M '), `the pen writes a path (${lastD?.slice(0, 24)}...)`);
  ok(self._trace.length === 48, 'the window is still bounded after the climb');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
