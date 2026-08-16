/**
 * The renderer's lateUpdate closes out input even when render() throws.
 *
 *   node tests/endframe-finally.test.mjs
 *
 * `main.js` registers the renderer as a noncritical system whose lateUpdate
 * calls `pipeline.render` then `input.endFrame()`. If render throws, the
 * Engine's noncritical handling logs and continues the run (see
 * engine-criticality.test.mjs) — but a throw between those two calls must not
 * skip endFrame(), or this frame's pressed keys and mouse edges bleed into
 * the next frame and a single input reads as pressed twice.
 *
 * `main.js` is a top-level bootstrap script (reads `location`, touches the
 * DOM on import) and cannot be imported directly in a headless test, so this
 * pulls the actual `lateUpdate` function body out of its source text and runs
 * it against a mock ctx/pipeline/input — the same idiom as
 * engine-criticality.test.mjs's source-scanning half, applied to exercise
 * real behaviour instead of just checking a declaration is present. This is
 * deliberately NOT a hand-written reimplementation of the fix: if `src/main.js`
 * regresses, this test breaks with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '..', 'src', 'main.js'), 'utf8');

// Pull the renderer's registration block: `engine.add({ ... critical: false ...
// lateUpdate(c, dt) { ... } ... });` — the only object-literal system in
// main.js (engine-criticality.test.mjs's completeness scan relies on that too).
const addAt = mainSrc.indexOf('engine.add({');
const criticalAt = addAt >= 0 ? mainSrc.indexOf('critical: false,', addAt) : -1;
const lateUpdateAt = criticalAt >= 0 ? mainSrc.indexOf('lateUpdate(c, dt) {', criticalAt) : -1;
const bodyStart = lateUpdateAt >= 0 ? mainSrc.indexOf('{', lateUpdateAt) + 1 : -1;
const closeMatch = bodyStart >= 0 ? mainSrc.slice(bodyStart).match(/\},\r?\n\}\);/) : null;
const bodyEnd = closeMatch ? bodyStart + closeMatch.index : -1;
ok(bodyStart >= 0 && bodyEnd > bodyStart, 'found the renderer registration block in src/main.js');
const lateUpdateBody = mainSrc.slice(bodyStart, bodyEnd);

// Run the extracted body as a real function, closing over a mock module-level
// `ctx` the same way main.js's lateUpdate does (it reads `ctx.pipeline`
// directly, not through its own `c` parameter).
const runLateUpdate = new Function('ctx', 'c', 'dt', lateUpdateBody);

function fakeInput() {
  return {
    pressed: new Set(['Space']),
    mouse: { dx: 5, dy: 7, leftEdge: true, rightEdge: true },
    endFrame() {
      this.pressed.clear();
      this.mouse.dx = 0;
      this.mouse.dy = 0;
      this.mouse.leftEdge = false;
      this.mouse.rightEdge = false;
    },
  };
}

console.log('a throw between render and endFrame still clears input edges');
{
  const input = fakeInput();
  const mockCtx = {
    pipeline: { render() { throw new Error('boom in render'); } },
    scene: {},
    camera: {},
    input,
  };

  let threw = null;
  try {
    runLateUpdate(mockCtx, mockCtx, 0.016);
  } catch (e) {
    threw = e;
  }

  ok(threw !== null && threw.message === 'boom in render', 'the render throw still propagates');
  ok(input.pressed.size === 0, 'pressed keys were cleared despite the throw');
  ok(input.mouse.dx === 0 && input.mouse.dy === 0, 'mouse deltas were cleared despite the throw');
  ok(input.mouse.leftEdge === false && input.mouse.rightEdge === false, 'mouse edges were cleared despite the throw');
}

console.log('the clean path is unchanged: render runs, then endFrame, no throw');
{
  const input = fakeInput();
  let rendered = false;
  const mockCtx = {
    pipeline: { render() { rendered = true; } },
    scene: {},
    camera: {},
    input,
  };

  runLateUpdate(mockCtx, mockCtx, 0.016);

  ok(rendered === true, 'render still runs on the clean path');
  ok(input.pressed.size === 0, 'endFrame still clears input on the clean path');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
