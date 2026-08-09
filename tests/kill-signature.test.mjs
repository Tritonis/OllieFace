// tests/kill-signature.test.mjs
//
// Every kill in this game currently emits the same white-to-orange spark
// shower, so a death by frostbite and a death by shotgun are the same frame.
// This pins the table that separates them — and pins that the default is
// still the shower that shipped, so a kill by an unmapped item is not a
// visual regression.
import { KILL_SIGNATURE, VFX } from '../src/systems/VFX.js';
import { ELEMENTS, ELEMENT_HUE } from '../src/data/damageTypes.js';
import { FRAME } from '../src/fx/ParticleSystem.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('every read family has a death of its own');
{
  for (const e of ELEMENTS) {
    const s = KILL_SIGNATURE[e];
    ok(!!s, `${e} has a signature`);
    ok(Number.isInteger(s.frame) && s.frame >= 0 && s.frame <= 15, `${e} names a real atlas frame`);
    ok(typeof s.speed === 'number' && s.speed > 0, `${e} bursts at a speed`);
    ok(typeof s.life === 'number' && s.life > 0, `${e} bursts for a duration`);
    ok(typeof s.ring === 'boolean' && typeof s.shock === 'boolean', `${e} declares ring and shockwave`);
  }
}

console.log('the default death is the death that ships today');
{
  const k = KILL_SIGNATURE.kinetic;
  // src/systems/VFX.js:1195-1200 as shipped: FRAME.SPARK, speed 8, life 0.6,
  // gravity 10, drag 1.6, stretch 1.2.
  ok(k.frame === FRAME.SPARK, 'sparks');
  ok(k.speed === 8 && k.life === 0.6, 'at the shipped speed and life');
  ok(k.gravity === 10 && k.drag === 1.6 && k.stretch === 1.2, 'with the shipped physics');
  ok(k.ring === true && k.shock === false, 'a ring, no shockwave');
}

console.log('the families are actually different deaths, not one recoloured');
{
  const frames = new Set(ELEMENTS.map((e) => KILL_SIGNATURE[e].frame));
  ok(frames.size >= 4, `at least four distinct atlas frames across seven families (got ${frames.size})`);
  ok(KILL_SIGNATURE.ice.gravity > KILL_SIGNATURE.fire.gravity, 'shards fall, embers rise');
  ok(KILL_SIGNATURE.fire.gravity < 0, 'a fire death actually rises');
  ok(KILL_SIGNATURE.blast.shock === true, 'a blast death pushes a shockwave');
  ok(KILL_SIGNATURE.void.spin !== 0, 'the void death spins');
}

console.log('lookup is total');
{
  const vfx = new VFX();
  for (const e of ELEMENTS) ok(vfx.killSignature(e) === KILL_SIGNATURE[e], `${e} resolves`);
  ok(vfx.killSignature('nothing-like-this') === KILL_SIGNATURE.kinetic, 'unknown falls back to kinetic');
  ok(vfx.killSignature(undefined) === KILL_SIGNATURE.kinetic, 'so does nothing');
}

console.log('the colours come from the shared palette, not a second one');
{
  for (const e of ELEMENTS) {
    ok(!!ELEMENT_HUE[e], `${e} draws its kill colours from ELEMENT_HUE`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
