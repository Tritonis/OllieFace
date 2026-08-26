// tests/corruption-lightning.test.mjs
//
// Ambient blight lightning (docs/superpowers/plans/2026-08-26-corruption-atmosphere.md):
// a cosmetic `chainBolt` crackle that fires only once the world is Blighted
// (band 2) or worse, drawn through `VFX._updateCorruptionAtmosphere`. Each
// assertion is paired with the one line whose removal turns it red.

import * as THREE from 'three';
import { VFX } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function vfxWithBolt() {
  const bolts = [];
  const vfx = Object.create(VFX.prototype);
  vfx.chainBolt = (pts, colour, opts) => bolts.push({ pts, colour, opts });
  return { vfx, bolts };
}

function ctxAt(band, playerPos = new THREE.Vector3(0, 0, 0)) {
  return { corruption: { band }, player: { position: playerPos } };
}

console.log('\nno bolt below Blighted (band 2), however long the clock runs');
{
  const { vfx, bolts } = vfxWithBolt();
  vfx._blightBoltT = 0; // already expired
  // RED ARM (confirmed by hand): dropping the `band < CORRUPTION_LIGHTNING.minBand`
  // guard fires a bolt at band 0/1 too, and this goes from 0 to >0.
  vfx._updateCorruptionAtmosphere(ctxAt(1), 100);
  ok(bolts.length === 0, 'Seeded (band 1) stays silent even after 100s');
  vfx._updateCorruptionAtmosphere(ctxAt(0), 100);
  ok(bolts.length === 0, 'Pristine (band 0) stays silent too');
}

console.log('\na bolt fires once the timer expires at Blighted or worse');
{
  const { vfx, bolts } = vfxWithBolt();
  vfx._blightBoltT = 0.05;
  vfx._updateCorruptionAtmosphere(ctxAt(2), 0.01);
  ok(bolts.length === 0, 'timer not yet expired: no bolt');
  vfx._updateCorruptionAtmosphere(ctxAt(2), 1);
  // RED ARM (confirmed by hand): commenting out the `this.chainBolt(pts, ...)`
  // call at the end of `_updateCorruptionAtmosphere` leaves this at 0.
  ok(bolts.length === 1, 'timer expired: exactly one bolt drawn');
  ok(bolts[0].pts.length === 3, 'the bolt is a three-point path, not a single beam');
  ok(vfx._blightBoltT > 0, 'the timer is re-armed to a positive interval');
}

console.log('\nno bolt at all with no live player (menu, loading)');
{
  const { vfx, bolts } = vfxWithBolt();
  vfx._blightBoltT = 0;
  vfx._updateCorruptionAtmosphere({ corruption: { band: 4 }, player: null }, 10);
  ok(bolts.length === 0, 'a null player position is refused rather than drawn at the origin');
}

console.log('\ndeeper bands re-arm to a shorter interval');
{
  const { vfx } = vfxWithBolt();
  const sample = (band) => {
    vfx._blightBoltT = 0;
    vfx._updateCorruptionAtmosphere(ctxAt(band), 1);
    return vfx._blightBoltT;
  };
  // Sample several draws per band since the interval is randomised; the
  // ranges (Blighted 6-9s, Overrun 3.5-5.5s, Consumed 1.5-3s) are disjoint,
  // so even one draw each is proof the band selects a different table row —
  // but several rules out a fluke of Math.random() landing at a shared edge.
  let blighted = Infinity, consumed = -Infinity;
  for (let i = 0; i < 20; i++) {
    blighted = Math.min(blighted, sample(2));
    consumed = Math.max(consumed, sample(4));
  }
  // RED ARM (confirmed by hand): making `interval()` return the same pair for
  // every band collapses this gap to <= 0.
  ok(blighted > consumed, `Blighted's shortest draw (${blighted.toFixed(2)}) still exceeds ` +
    `Consumed's longest (${consumed.toFixed(2)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
