/**
 * The inventory strip's re-measure window is a second, not sixty frames.
 *
 *   node tests/hud-strip-hold.test.mjs
 *
 * `updateStripRect` held a counter of 60 and decremented it once per update,
 * while its comment promised "the next second". At 30 fps that is two seconds
 * of a forced layout flush every frame; at 144 fps it is 0.42 s, which can lapse
 * before the tiles have finished animating in and leaves `VFX.DamageNumbers`
 * clipping against a stale rect. Same unit confusion as NetHost's HELLO gate.
 *
 * A real `HUD` needs a document, so the timing is driven through the prototype
 * on a hand-built `this` holding only the fields `updateStripRect` touches.
 * The assertion that matters is rate-independence: the same wall-clock window
 * at 30 fps and at 144 fps, whatever the call count.
 */
import { HUD } from '../src/ui/HUD.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const HOLD_SEC = 1.0;   // mirrors STRIP_HOLD_SEC in HUD.js

function fakeHUD() {
  const self = Object.create(HUD.prototype);
  self.stripRect = null;
  self.measures = 0;
  self.refs = {
    inventory: {
      getBoundingClientRect: () => { self.measures++; return { left: 10, top: 20, width: 300, height: 48 }; },
    },
  };
  self.markStripDirty();
  return self;
}

/**
 * Run `seconds` of simulated time at a fixed dt; return the simulated time of
 * the last re-measure and how many there were.
 */
function drive(self, dt, seconds) {
  let t = 0, last = -1, before = self.measures;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const n = self.measures;
    self.updateStripRect(dt);
    t += dt;
    if (self.measures > n) last = t;
  }
  return { last, count: self.measures - before };
}

console.log('the window is one second of wall clock at 30 fps');
{
  const self = fakeHUD();
  const { last, count } = drive(self, 1 / 30, 3);
  ok(last <= HOLD_SEC + 2 / 30, `last re-measure at ~${last.toFixed(3)}s, not later than the window`);
  ok(last >= HOLD_SEC - 2 / 30, 'and not appreciably earlier');
  ok(count >= 29 && count <= 32, `~30 measures at 30 fps (got ${count})`);
}

console.log('and one second of wall clock at 144 fps — not 0.42s');
{
  const self = fakeHUD();
  const { last, count } = drive(self, 1 / 144, 3);
  ok(last <= HOLD_SEC + 2 / 144, `last re-measure at ~${last.toFixed(3)}s`);
  ok(last >= HOLD_SEC - 2 / 144, 'the window did not close early at high frame rate');
  ok(count >= 143 && count <= 146, `~144 measures at 144 fps (got ${count})`);
}

console.log('the two frame rates agree on duration while disagreeing on call count');
{
  const slow = fakeHUD(), fast = fakeHUD();
  const a = drive(slow, 1 / 30, 3);
  const b = drive(fast, 1 / 144, 3);
  ok(Math.abs(a.last - b.last) < 0.05, `windows match within 50 ms (${a.last.toFixed(3)} vs ${b.last.toFixed(3)})`);
  ok(b.count > a.count * 3, 'while the frame counts differ by ~5x — the counter was never the unit');
}

console.log('a huge dt hitch closes the window rather than banking frames');
{
  const self = fakeHUD();
  const { last, count } = drive(self, 0.5, 3);
  ok(count <= 3, `a 2 fps stall spends the window in ~2 steps (got ${count})`);
  ok(last <= 1.5 + 1e-9, 'and does not run on for 60 of those steps');
}

console.log('the rect is published, and re-measuring stops rather than never starting');
{
  const self = fakeHUD();
  self.updateStripRect(1 / 60);
  ok(self.stripRect && self.stripRect.x === 10 && self.stripRect.w === 300, 'rect published from the element');
  drive(self, 1 / 60, 5);
  const settled = self.measures;
  drive(self, 1 / 60, 5);
  ok(self.measures === settled, 'no layout flush at all once the window has lapsed');
}

console.log('markStripDirty restarts the full second mid-flight');
{
  const self = fakeHUD();
  drive(self, 1 / 60, 5);          // let it lapse
  const settled = self.measures;
  self.markStripDirty();
  const { last, count } = drive(self, 1 / 60, 3);
  ok(self.measures > settled, 'dirtying re-opens the window');
  ok(count >= 59 && count <= 62, `a fresh full second of measures (got ${count})`);
  ok(last <= HOLD_SEC + 2 / 60, 'and closes a second later, not immediately');
}

console.log('a missing element clears the rect instead of throwing');
{
  const self = fakeHUD();
  self.refs.inventory = null;
  self.stripRect = { x: 1, y: 1, w: 1, h: 1 };
  self.updateStripRect(1 / 60);
  ok(self.stripRect === null, 'stale rect dropped when the strip is gone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
