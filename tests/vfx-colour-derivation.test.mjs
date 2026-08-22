/**
 * #147 — explosion's core/pip pair and bloodHit's layer colours are now
 * parameterised (`coreColour` on explosion, derived from `colour` on
 * bloodHit) instead of four/three independently hardcoded hex constants.
 * With no override, both must reproduce today's exact hex values byte for
 * byte; with an override, the derived companions must move with it.
 *
 * `explosion`/`bloodHit` build meshes against a live renderer and cannot run
 * headless, so this test imports and calls the exported production
 * derivation helper (`_shiftWarm`) directly at the exact ratios the methods
 * use — no reimplementation, no copy-pasted math. A grep-guard on the ratio
 * literals is kept as a cheap supplement, not the substance.
 *
 *   node tests/vfx-colour-derivation.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { _shiftWarm } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// Supplementary guard: confirm the source still contains the exact ratio
// literals this test exercises, so a change to the ratios without updating
// this file is at least flagged here too (the real proof is _shiftWarm above).
const vfxSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systems', 'VFX.js'),
  'utf8',
);
console.log('VFX.js still carries the documented derivation ratios');
{
  ok(vfxSrc.includes('9 / 11, 37 / 75'), 'explosion core ratio literal present');
  ok(vfxSrc.includes('61 / 55, 36 / 25'), 'explosion pip0 ratio literal present');
  ok(vfxSrc.includes('52 / 61, 61 / 108'), 'explosion pip1 ratio literal present');
  ok(vfxSrc.includes('60 / 156, 4 / 13, 10 / 24'), 'blood gout-trail ratio literal present');
  ok(vfxSrc.includes('122 / 156, 10 / 13, 20 / 24'), 'blood mist-near ratio literal present');
  ok(vfxSrc.includes('44 / 156, 3 / 13, 8 / 24'), 'blood mist-far ratio literal present');
  ok(vfxSrc.includes('255 / 156, 90 / 13, 90 / 24'), 'blood spark ratio literal present');
}

console.log('explosion: default coreColour reproduces the legacy hex exactly (via production _shiftWarm)');
{
  const core0 = 0xffdc96;
  const core1 = _shiftWarm(core0, 1, 9 / 11, 37 / 75);
  const pip0 = _shiftWarm(core0, 1, 61 / 55, 36 / 25);
  const pip1 = _shiftWarm(pip0, 1, 52 / 61, 61 / 108);
  ok(core1 === 0xffb44a, `core1 = 0x${core1.toString(16)} == 0xffb44a`);
  ok(pip0 === 0xfff4d8, `pip0 = 0x${pip0.toString(16)} == 0xfff4d8`);
  ok(pip1 === 0xffd07a, `pip1 = 0x${pip1.toString(16)} == 0xffd07a`);
}

console.log('explosion: an overridden coreColour moves the derived companions (via production _shiftWarm)');
{
  const core0 = 0x40a0ff; // a cold blue core, nothing like the default warm one
  const core1 = _shiftWarm(core0, 1, 9 / 11, 37 / 75);
  const pip0 = _shiftWarm(core0, 1, 61 / 55, 36 / 25);
  const pip1 = _shiftWarm(pip0, 1, 52 / 61, 61 / 108);
  ok(core1 !== 0xffb44a, 'core1 differs from the legacy default');
  ok(pip0 !== 0xfff4d8, 'pip0 differs from the legacy default');
  ok(pip1 !== 0xffd07a, 'pip1 differs from the legacy default');
  ok(((core0 >> 16) & 0xff) === ((core1 >> 16) & 0xff), 'r channel preserved through the derivation (ratio 1)');
}

console.log('bloodHit: default colour reproduces the legacy layer hexes exactly (via production _shiftWarm)');
{
  const colour = 0x9c0d18;
  const goutTrail = _shiftWarm(colour, 60 / 156, 4 / 13, 10 / 24);
  const mistNear = _shiftWarm(colour, 122 / 156, 10 / 13, 20 / 24);
  const mistFar = _shiftWarm(colour, 44 / 156, 3 / 13, 8 / 24);
  const spark = _shiftWarm(colour, 255 / 156, 90 / 13, 90 / 24);
  ok(goutTrail === 0x3c040a, `goutTrail = 0x${goutTrail.toString(16)} == 0x3c040a`);
  ok(mistNear === 0x7a0a14, `mistNear = 0x${mistNear.toString(16)} == 0x7a0a14`);
  ok(mistFar === 0x2c0308, `mistFar = 0x${mistFar.toString(16)} == 0x2c0308`);
  ok(spark === 0xff5a5a, `spark = 0x${spark.toString(16)} == 0xff5a5a`);
}

console.log('bloodHit: an overridden colour recolours the whole splat (via production _shiftWarm)');
{
  const colour = 0x1030ff; // an icy blue element colour
  const goutTrail = _shiftWarm(colour, 60 / 156, 4 / 13, 10 / 24);
  const mistNear = _shiftWarm(colour, 122 / 156, 10 / 13, 20 / 24);
  const mistFar = _shiftWarm(colour, 44 / 156, 3 / 13, 8 / 24);
  const spark = _shiftWarm(colour, 255 / 156, 90 / 13, 90 / 24);
  ok(goutTrail !== 0x3c040a, 'goutTrail differs from the legacy default');
  ok(mistNear !== 0x7a0a14, 'mistNear differs from the legacy default');
  ok(mistFar !== 0x2c0308, 'mistFar differs from the legacy default');
  ok(spark !== 0xff5a5a, 'spark differs from the legacy default');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
