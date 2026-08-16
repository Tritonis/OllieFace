// tests/vfx-atlas-failure.test.mjs
//
// What happens when VFX cannot build its canvas atlases (issue #92, item 5).
//
// `makeGlyphAtlas` allocates a 640x640 canvas and draws the damage-readout
// glyphs into it, from `DamageNumbers`' constructor, which `VFX.init`
// constructs directly. On a constrained GPU that allocation can fail, and the
// throw lands in `Engine.add`. Today's behaviour is correct — VFX declares
// itself noncritical, so the system is dropped, its context publications are
// taken back, and the run carries on without damage numbers rather than
// showing a fatal overlay — but nothing asserted it, so any of those four
// could have been undone silently: reclassify VFX as critical and a GPU that
// cannot spare 1.6 MB of canvas gets a blank page instead of a game.
//
// The failure is forced by removing the only way any of these atlases can be
// built: `document.createElement('canvas')` throws, exactly as a browser out
// of GPU memory would. That is deliberately broader than the glyph atlas
// alone — emulating enough of a 2D context for the particle atlas to succeed
// and only the glyph atlas to fail would be several hundred lines of fiction,
// and the routing under test does not care which atlas threw. The static half
// below pins the part the runtime half cannot see: that a throw out of
// `makeGlyphAtlas` really does reach `Engine.add` rather than being swallowed
// on the way.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atlasSizePx } from '../src/systems/GlyphAtlasLayout.js';

const here = dirname(fileURLToPath(import.meta.url));
const vfxSrc = readFileSync(join(here, '..', 'src', 'systems', 'VFX.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the atlas under test is the 640x640 one');
{
  ok(atlasSizePx() === 640, `the glyph atlas is ${atlasSizePx()}x${atlasSizePx()}`);
  ok(/const cv = document\.createElement\('canvas'\);/.test(vfxSrc), 'makeGlyphAtlas allocates it through document.createElement');
}

console.log('a throw from the glyph atlas reaches Engine.add uncaught');
{
  // Two hops, and a `try` on either would mean the runtime half below is
  // testing a path the glyph atlas no longer takes: makeGlyphAtlas() runs in
  // DamageNumbers' constructor, and VFX.init constructs DamageNumbers.
  const dnAt = vfxSrc.indexOf('class DamageNumbers {');
  const atlasAt = vfxSrc.indexOf('makeGlyphAtlas();', dnAt);
  ok(dnAt >= 0 && atlasAt > dnAt, 'DamageNumbers builds the atlas in its constructor');
  ok(!vfxSrc.slice(dnAt, atlasAt).includes('try'), 'nothing catches it inside DamageNumbers');

  const initAt = vfxSrc.indexOf('\n  init(ctx) {');
  const newDnAt = vfxSrc.indexOf('new DamageNumbers(', initAt);
  ok(initAt >= 0 && newDnAt > initAt, 'VFX.init constructs DamageNumbers');
  ok(!vfxSrc.slice(initAt, newDnAt).includes('try'), 'and does not catch its throw either');
}

// Canvas allocation is impossible from here on, for anything that asks.
const asked = [];
globalThis.document = {
  createElement(tag) {
    asked.push(tag);
    throw new Error(`canvas allocation failed (${tag})`);
  },
};

const { Engine } = await import('../src/core/Engine.js');
const { VFX } = await import('../src/systems/VFX.js');

/** A system registered after VFX, so "did boot carry on" is answerable. */
class Witness {
  static critical = false;
  constructor() { this.updates = 0; }
  update() { this.updates++; }
}
/** Guards on `ctx.vfx` exactly as `Director.js:1143` does. */
class Consumer {
  static critical = true;
  update(ctx) { if (ctx.vfx && ctx.vfx.explosion) ctx.vfx.explosion({ x: 0, y: 0, z: 0 }); }
}

console.log('VFX losing its atlas costs the run its damage numbers, and nothing else');
{
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  const fatals = [];
  engine.ctx.events.on('fatalError', (e) => fatals.push(e));

  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  let escaped = null;
  const vfx = new VFX();
  try { engine.add(vfx); } catch (e) { escaped = e; } finally { console.error = realErr; }

  ok(escaped === null, 'add() did not propagate the failure out to module evaluation');
  ok(asked.includes('canvas'), 'the failure really came from a canvas allocation');
  ok(engine.fatal === null && engine.ctx.fatalError === null, 'the run was not halted');
  ok(fatals.length === 0, 'no fatalError was emitted, so no fatal overlay is raised');
  ok(engine.ctx.authority === true, 'authority was not surrendered');
  ok(!engine.systems.includes(vfx), 'the half-built VFX is not registered');
  ok(engine.ctx.vfx === null, 'and it was taken back off the context');
  ok(engine.ctx.frameErrors === 1, 'but the failure was counted');
  ok(errs.some((e) => e.includes('VFX.init')), 'and reported on the console by name');

  const w = engine.add(new Witness());
  engine.add(new Consumer());
  engine._frame();
  ok(w.updates === 1, 'boot carried on and the run keeps ticking');
  ok(engine.fatal === null, 'a critical consumer of ctx.vfx did not halt a later frame');
  ok(engine.ctx.frameErrors === 1, 'and no further error was ever counted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
