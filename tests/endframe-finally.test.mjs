/**
 * Input is closed out every frame, whatever else the frame did.
 *
 *   node tests/endframe-finally.test.mjs
 *
 * `Input.endFrame` clears `pressed` and zeroes the mouse deltas, and it is the
 * only thing that does. A frame that does not reach it leaves every key held
 * since reading as pressed forever — `Menus.update`'s `hit('Digit1')` firing a
 * pick on every frame — and `mouse.dx` accumulating unbounded under pointer
 * lock while `CameraRig` applies it.
 *
 * This file used to state that invariant against the renderer's `lateUpdate`,
 * which called `endFrame` in a `finally`, and it drove exactly one frame. That
 * made it a guard that could not fail at the thing it guarded: a `finally`
 * protects `endFrame` from an exception, and the failure that actually arrived
 * was the whole renderer being DISABLED — noncritical, registered, dropped
 * after `DISABLE_AFTER` wedged frames (issue #72), taking the only `endFrame`
 * call in `src/` with it. One frame never reaches that threshold, so the test
 * stayed green while the invariant it names was broken.
 *
 * So it now asserts the invariant where the invariant lives — the Engine's
 * frame epilogue — and drives well past the disable threshold. Three ways a
 * frame can fail to reach the end of the update list, all of which must still
 * clear input:
 *
 *   1. the renderer disabled outright;
 *   2. a system throwing mid-frame;
 *   3. a critical system halting the run.
 *
 * The last check keeps `src/main.js` honest about the move: the renderer must
 * NOT call `endFrame` itself any more, or a frame closes input twice.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '..', 'src', 'main.js'), 'utf8');

function fresh() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  return engine;
}

function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

/** The two things `Input.endFrame` exists to do, and a count of the doing. */
function fakeInput() {
  return {
    critical: false,
    ends: 0,
    pressed: new Set(),
    mouse: { dx: 0, dy: 0, leftEdge: false, rightEdge: false },
    /** What a real frame's worth of events would have left behind. */
    press() {
      this.pressed.add('Digit1');
      this.mouse.dx += 5;
      this.mouse.dy += 7;
      this.mouse.leftEdge = true;
    },
    endFrame() {
      this.ends++;
      this.pressed.clear();
      this.mouse.dx = 0;
      this.mouse.dy = 0;
      this.mouse.leftEdge = false;
      this.mouse.rightEdge = false;
    },
  };
}

/** The shape `main.js` registers: noncritical, and the frame's last system. */
class Renderer {
  static critical = false;
  constructor(render) { this.render = render; this.frames = 0; }
  lateUpdate() { this.frames++; this.render(); }
}

console.log('input is still closed out after the renderer has been disabled');
{
  // The live regression. Six wedged frames drop the renderer; from the seventh
  // on, nothing in the update list touches input at all.
  const engine = fresh();
  const input = fakeInput();
  engine.ctx.input = input;
  const renderer = engine.add(new Renderer(() => { throw new Error('device lost'); }));

  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) { input.press(); engine._frame(); } });
  ok(!engine.systems.includes(renderer), 'the renderer was disabled, as a wedged noncritical system must be');

  const endsAtDisable = input.ends;
  for (let i = 0; i < 5; i++) { input.press(); engine._frame(); }
  ok(input.ends === endsAtDisable + 5, `endFrame still ran on all five later frames (${input.ends - endsAtDisable})`);
  ok(input.pressed.size === 0, 'pressed keys are cleared, so hit() cannot latch true forever');
  ok(input.mouse.dx === 0 && input.mouse.dy === 0, 'mouse deltas are zeroed, so the camera cannot spin on a stale delta');
  ok(input.mouse.leftEdge === false, 'and the click edges go with them');
}

console.log('nor can a throw mid-frame skip it');
{
  const engine = fresh();
  const input = fakeInput();
  engine.ctx.input = input;
  engine.add({ critical: false, update() { throw new Error('boom in update'); } });
  input.press();
  quietly(() => engine._frame());
  ok(input.ends === 1, 'the epilogue ran');
  ok(input.pressed.size === 0 && input.mouse.dx === 0, 'and cleared the frame despite the throw');
}

console.log('nor can a genuine exception that escapes _runFrame entirely');
{
  // `_call` swallows an ordinary system throw, and a `FrameHalt` is already
  // handled by `_frame`'s own catch — neither exercises what `finally` is for.
  // The one place `_runFrame` touches something outside a `_call`-wrapped
  // invocation is its own guard on input polling: `if (this.ctx.input?.pollPad)`
  // reads `pollPad` directly. A throwing getter there escapes uncaught, is not
  // a `FrameHalt`, and so is rethrown out of `_frame` after its `finally` runs —
  // exactly the case a bare trailing statement (no `finally`) would skip.
  const engine = fresh();
  const input = fakeInput();
  Object.defineProperty(input, 'pollPad', {
    get() { throw new Error('pad enumeration blew up'); },
  });
  engine.ctx.input = input;
  input.press();
  let threw = null;
  quietly(() => {
    try { engine._frame(); } catch (e) { threw = e; }
  });
  ok(threw !== null && threw.message === 'pad enumeration blew up', 'the genuine exception escaped _frame uncaught');
  ok(input.ends === 1, 'and the epilogue still ran on the way out');
  ok(input.pressed.size === 0 && input.mouse.dx === 0, 'clearing input even though the frame never reached the update list');
}

console.log('nor can a critical halt, which abandons the rest of the frame');
{
  class Authoritative {
    static critical = true;
    update() { throw new Error('the damage authority died'); }
  }
  const engine = fresh();
  const input = fakeInput();
  engine.ctx.input = input;
  engine.add(new Authoritative());
  const w = engine.add({ critical: false, updates: 0, update() { this.updates++; } });
  input.press();
  quietly(() => engine._frame());
  ok(engine.fatal !== null && w.updates === 0, 'the frame was abandoned at the halt');
  ok(input.ends === 1, 'and input was closed out anyway, on the way out');
}

console.log('a frame with no input at all does not throw');
{
  // Headless drivers and most of this suite run without an Input. The epilogue
  // must not be the thing that introduces a failure.
  const engine = fresh();
  engine._frame();
  ok(engine.ctx.frameErrors === 0, 'no input, no error');
  engine.ctx.input = { critical: false };            // present, but no endFrame
  engine._frame();
  ok(engine.ctx.frameErrors === 0, 'an input without an endFrame is left alone');
}

console.log('an endFrame that throws is degraded, not fatal');
{
  const engine = fresh();
  engine.ctx.input = { critical: false, endFrame() { throw new Error('boom closing out'); } };
  quietly(() => engine._frame());
  ok(engine.fatal === null, 'the run was not halted');
  ok(engine.ctx.lastFrameError?.who === 'Object.endFrame', 'and the failure was reported by name');
}

console.log('the clean path still renders, exactly once per frame');
{
  const engine = fresh();
  const input = fakeInput();
  engine.ctx.input = input;
  const renderer = engine.add(new Renderer(() => {}));
  engine._frame();
  ok(renderer.frames === 1, 'the renderer drew the frame');
  ok(input.ends === 1, 'and input was closed out once, not twice');
}

console.log('src/main.js leaves closing-out to the Engine');
{
  // The move only holds if the renderer stopped doing it too — otherwise a
  // frame calls endFrame twice, and the second call clears edges that the
  // epilogue had already cleared for a frame that has not happened yet.
  const addAt = mainSrc.indexOf('engine.add({');
  const block = addAt >= 0 ? mainSrc.slice(addAt, mainSrc.indexOf('});', addAt)) : '';
  ok(addAt >= 0 && block.includes('pipeline.render('), 'found the renderer registration block');
  ok(!/endFrame\(/.test(block), 'and it no longer closes out input itself');
  ok(!/endFrame\(/.test(mainSrc), 'nothing else in main.js does either');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
