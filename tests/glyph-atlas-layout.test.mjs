// tests/glyph-atlas-layout.test.mjs
//
// The damage-readout glyph geometry (issue #92, items 3 and 4) was guarded by
// exactly one thing: the manual capture gate. That gate is a slow, headed GPU
// run that nobody triggers on a one-line constant edit, so the advance could
// disagree with its own mirror for as long as it took someone to look at a
// screenshot.
//
// Two mirrors exist, and neither is visible from where it breaks:
//
//   1. `NumberVert` lays glyphs out on `float cw`, interpolated from
//      `NUM_ADVANCE`. `NumberSystem._box` reserves the run's collision box on
//      the CPU using the same advance. Diverge them and the separation logic
//      reserves space for numerals of a width nothing draws.
//   2. `NumberFrag`'s halo is a ring of taps at a fixed *atlas texel* radius,
//      so it is only in-bounds while the tile has padding left after the font
//      and its stroke. Exceed it and a tap reads the neighbouring glyph — which
//      renders as faint ghost ink, not as a crash.
//
// The constants now live in `src/systems/GlyphAtlasLayout.js`, which imports
// nothing and touches no browser API, so this test asserts the *real*
// arithmetic rather than parsing values back out of source. What it still has
// to read as text is the shader — GLSL is a string, and the only way to know
// `cw` carries the advance is to read the string the GPU is handed.
//
// Sensitivity is the point. Every assertion below was checked to go red when
// one side of its pair is perturbed and the other is not; the extractor guards
// in the first block exist so that a refactor which stops the regexes matching
// fails loudly instead of passing vacuously.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLYPHS, NUM_ADVANCE, NUM_TILE, NUM_COLS, NUM_FONT_PX, NUM_STROKE_PX, NUM_HALO_PX,
  atlasSizePx, haloUv, tilePaddingPx, glyphRunWidthChars,
} from '../src/systems/GlyphAtlasLayout.js';

const here = dirname(fileURLToPath(import.meta.url));
const vfx = readFileSync(join(here, '..', 'src', 'systems', 'VFX.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/**
 * The value NumberVert's `float cw` ends up carrying, or null.
 *
 * GLSL here is a template literal, so `cw` is written one of two ways and both
 * have to be readable: interpolated from the constant
 * (`${NUM_ADVANCE.toFixed(3)}`, the correct form) or hard-coded as a number
 * (the divergence this test exists to catch). Any *third* form — some other
 * constant, an expression — yields null and fails the extractor guard rather
 * than passing quietly, because a cw this test cannot read is a cw it cannot
 * check. The interpolated form is evaluated at the same precision the shader
 * gets, so a value needing more decimals than `toFixed` keeps shows up as the
 * mismatch it is.
 */
const shaderCw = (() => {
  const m = /\bfloat\s+cw\s*=\s*(?:\$\{NUM_ADVANCE\.toFixed\((\d+)\)\}|([0-9]*\.?[0-9]+))\s*;/.exec(vfx);
  if (!m) return null;
  return m[1] !== undefined ? Number(NUM_ADVANCE.toFixed(Number(m[1]))) : Number(m[2]);
})();

/** `const half = len * 0.5 - 0.5;` in the spawn path, as a function. */
const shaderHalfMatch = /const\s+half\s*=\s*len\s*\*\s*0\.5\s*-\s*0\.5\s*;/.test(vfx);

/**
 * NumberVert's `vec2 corner = vec2(...)` body, whitespace-normalised.
 *
 * Extracting only the scalar `cw` and then re-typing the layout *formula* into
 * this test is not a derivation — it is a second copy of the thing under test,
 * and it is blind by construction. Verified the expensive way: mutating the
 * shader to `(position.x + (aGlyph.y - aGlyph.z) * cw * 2.0) * scale` doubles
 * the drawn advance with every constant untouched, and a scalar-only test
 * passed it 20/20.
 *
 * So the formula's *shape* is pinned too. `CORNER_FORMS` maps each exact
 * accepted spelling to the layout function this test may then assume; anything
 * else — a new term, a different factor, a restructure — is not in the table,
 * yields null, and trips the loud extractor guard rather than silently
 * licensing the width sweep's assumptions. Widening the table is a deliberate
 * act: add a spelling only alongside the layout function that matches it.
 */
const CORNER_FORMS = new Map([
  [
    '(position.x + (aGlyph.y - aGlyph.z) * cw) * scale, position.y * scale',
    /** @returns the glyph-space x of a quad corner, in quad widths. */
    (px, col, half, cw) => px + (col - half) * cw,
  ],
]);

const cornerXForm = (() => {
  const m = /vec2\s+corner\s*=\s*vec2\(([\s\S]*?)\)\s*;/.exec(vfx);
  if (!m) return null;
  const normalised = m[1].replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
  return CORNER_FORMS.get(normalised) ?? null;
})();

/**
 * The layout the sweeps below use. An unrecognised formula has already failed
 * the extractor guard, and yields NaN here so every downstream comparison fails
 * too — a blind sweep must not go quiet, and must not throw either.
 */
const cornerX = cornerXForm ?? (() => NaN);

console.log('the extractors still see what they are checking');
{
  ok(vfx.length > 50000, `VFX.js read (${vfx.length} chars)`);
  ok(/from\s+'\.\/GlyphAtlasLayout\.js'/.test(vfx),
    'VFX.js sources the glyph geometry from GlyphAtlasLayout.js rather than redeclaring it');
  ok(shaderCw !== null,
    'NumberVert still declares `float cw = <number>;` — if this fails the shader was restructured and every cw assertion below is blind');
  ok(shaderHalfMatch,
    'the spawn path still writes aGlyph.z as `len * 0.5 - 0.5`');
  ok(cornerXForm !== null,
    'NumberVert lays the glyph out with a corner formula this test recognises -- if this fails the formula was restructured (a new term, a different factor) and the width sweep below is asserting against a layout the shader no longer performs');
  ok(!/^\s*const\s+NUM_(ADVANCE|TILE|COLS|HALO_PX|FONT_PX|STROKE_PX)\s*=/m.test(vfx),
    'no glyph-geometry constant has been re-declared locally in VFX.js, shadowing the import');
}

console.log('the shader and the CPU reservation share one advance');
{
  // Interpolated as `${NUM_ADVANCE.toFixed(3)}`, so a value needing more than
  // three decimals silently reaches the GPU rounded while `_box` keeps the
  // exact one. That is a real divergence, so it is a failure, not a tolerance.
  ok(shaderCw !== null && shaderCw === NUM_ADVANCE,
    `shader cw ${shaderCw} equals NUM_ADVANCE ${NUM_ADVANCE}`
    + (shaderCw !== NUM_ADVANCE ? ' -- MIRROR BROKEN: the GPU lays glyphs out on a different advance than _box reserves' : ''));

  ok(/out\.hx\s*=\s*\(glyphRunWidthChars\(len\)\s*\*\s*h\s*\*\s*0\.5\s*\*\s*p00\)\s*\/\s*dist\s*;/.test(vfx),
    '_box derives its half-width from glyphRunWidthChars() rather than re-inlining the formula');

  // The run width the shader actually draws, swept over every glyph in a run,
  // and compared against what `_box` reserves.
  //
  // What is taken from VFX.js: the advance (`shaderCw`), the aGlyph.z spelling
  // (`shaderHalfMatch`), and the corner.x formula itself — `cornerX` is one of
  // the accepted spellings in CORNER_FORMS, so a shader whose layout expression
  // changes shape is not silently modelled by the old one.
  //
  // What this test still assumes rather than reads: that `position.x` spans a
  // unit quad's [-0.5, 0.5] (PlaneGeometry(1, 1) upstream), that `aGlyph.y` is
  // the glyph's column index within the run, and that `scale` is a uniform
  // positive factor and so cannot change the ratio of drawn width to reserved
  // width. Those three are the residual blind spots here.
  let widthsAgree = true, firstBad = '';
  for (let len = 1; len <= 8; len++) {
    const half = len * 0.5 - 0.5;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < len; i++) {
      lo = Math.min(lo, cornerX(-0.5, i, half, shaderCw));
      hi = Math.max(hi, cornerX(0.5, i, half, shaderCw));
    }
    const drawn = hi - lo;
    if (!near(drawn, glyphRunWidthChars(len), 1e-12)) {
      widthsAgree = false;
      if (!firstBad) firstBad = `len ${len}: shader draws ${drawn}, _box reserves ${glyphRunWidthChars(len)}`;
    }
  }
  ok(widthsAgree,
    widthsAgree
      ? 'the reserved run width equals the width NumberVert actually draws, for runs of 1-8 glyphs'
      : `reservation disagrees with the drawn layout -- ${firstBad}`);

  // The run is centred on its origin: aGlyph.z is chosen so the extent is
  // symmetric, which is what lets _box report a centre plus a half-extent at
  // all. A change to `half` that breaks this leaves the box off to one side.
  const len = 5, half = len * 0.5 - 0.5;
  const lo = cornerX(-0.5, 0, half, shaderCw), hi = cornerX(0.5, len - 1, half, shaderCw);
  ok(near(lo, -hi, 1e-12), `a ${len}-glyph run is centred on its origin (${lo} .. ${hi})`);
}

console.log('the atlas fits what is drawn into it');
{
  ok(GLYPHS.length <= NUM_COLS * NUM_COLS,
    `${GLYPHS.length} glyphs fit in a ${NUM_COLS}x${NUM_COLS} atlas`);
  ok(new Set(GLYPHS).size === GLYPHS.length, 'no glyph is duplicated (indices are the atlas map)');
  ok(atlasSizePx() === NUM_TILE * NUM_COLS, `atlas is ${atlasSizePx()} px square`);
  ok(/cv\.width\s*=\s*cv\.height\s*=\s*tile\s*\*\s*cols\s*;/.test(vfx),
    'makeGlyphAtlas sizes a square canvas as tile * cols -- NumberVert divides both uv axes by uAtlasCols, so a non-square atlas skews every glyph');
  ok(/uAtlasCols:\s*\{\s*value:\s*NUM_COLS\s*\}/.test(vfx),
    'uAtlasCols carries NUM_COLS');
  ok(/uHaloUv:\s*\{\s*value:\s*haloUv\(\)\s*\}/.test(vfx),
    'uHaloUv is derived by haloUv() rather than re-inlining halo / (tile * cols)');
  ok(near(haloUv(), NUM_HALO_PX / (NUM_TILE * NUM_COLS)),
    `haloUv() is ${haloUv()} = ${NUM_HALO_PX} texels of a ${atlasSizePx()} px atlas`);
}

console.log('the halo stays inside its own tile');
{
  const padding = tilePaddingPx();
  ok(NUM_FONT_PX * 0.9 + NUM_STROKE_PX < NUM_TILE,
    `the inked glyph (${NUM_FONT_PX * 0.9 + NUM_STROKE_PX} px) fits inside a ${NUM_TILE} px tile`);
  ok(padding > 0, `tile padding is ${padding} texels`);
  // The contract NUM_HALO_PX's comment states, asserted instead of remembered:
  // a tap beyond the padding samples the next tile, and the atlas is packed, so
  // the next tile is always another glyph.
  ok(NUM_HALO_PX <= padding,
    NUM_HALO_PX <= padding
      ? `halo radius ${NUM_HALO_PX} stays within the ${padding} texel padding`
      : `halo radius ${NUM_HALO_PX} EXCEEDS the ${padding} texel padding -- taps cross into the neighbouring glyph`);
  ok(NUM_HALO_PX > 0, 'the halo has a nonzero radius (it is the plate the readout is legible on)');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
