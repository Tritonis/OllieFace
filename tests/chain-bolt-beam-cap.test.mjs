// tests/chain-bolt-beam-cap.test.mjs
//
// Integration fix wave, plan-2026-08-25, MAJOR 2. `VFX.chainBolt` draws
// `segments * 2` beams per hop (a rim beam plus a white-hot core, per §1.2).
// `BeamPool` is a fixed-capacity ring with no liveness check (`spawn()` just
// overwrites `head`), so a chain-lightning bolt with enough hops can, on its
// own, wrap the whole ring and erase whatever else was mid-flight.
//
// `cracked-zither`'s bounce count grows with stacks (`2 + linear(2, count)`),
// so a heavy stack is the way a single item produces an unusually long chain.
// The scenario under test is the reviewer's own worst case: a fully-stacked
// zither proc landing in the same frame as Tesla Crown's periodic bolt,
// Overcharge Cell x5's on-kill bolt, and one ambient blight bolt.
import * as THREE from 'three';
import { VFX, BeamPool } from '../src/systems/VFX.js';
import { chainLightning } from '../src/data/items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const scene = () => ({ scene: { add() {} } });

/** An endless line of fresh targets, so a long chain never runs out of hops. */
function combatWithEndlessTargets() {
  let n = 0;
  return {
    nearestHostile: () => ({ position: V(++n, 0, 0) }),
    applyDamage() {},
  };
}

function makeVfx(capacity) {
  const beams = new BeamPool(scene(), capacity);
  const vfx = Object.create(VFX.prototype);
  vfx.beams = beams;
  return { vfx, beams };
}

console.log('chainBolt caps one call\'s own segment budget');
{
  // A bolt with far more hops than the cap allows still draws something, and
  // still lands on every one of its own endpoints (still one contiguous
  // line), but does not scale beams linearly with hop count forever.
  const { vfx, beams } = makeVfx(4096); // capacity irrelevant here; isolating the per-call cap
  const points = [];
  for (let i = 0; i <= 18; i++) points.push(V(i, 0, 0));
  const drawn = vfx.chainBolt(points, 0x9fd8ff, { segments: 5 });
  const naiveDrawn = 18 * 5; // what the old, uncapped code would have drawn
  ok(drawn < naiveDrawn, `18-hop bolt at 5 segments/hop draws ${drawn} links, not the naive ${naiveDrawn}`);
  ok(drawn >= 18, 'and still draws at least one link per hop, so no hop is skipped');
}

console.log('ordinary stack counts are untouched or only mildly softened');
{
  // A lightly-stacked zither (bounces 2 + linear(2, 1) = 4 hops) sits well
  // under the cap at the default 5 segments/hop and must draw exactly what
  // it always drew — the cap is only meant to bite at the extremes.
  const { vfx } = makeVfx(4096);
  const zitherX1 = [V(0, 0, 0), V(1, 0, 0), V(2, 0, 0), V(3, 0, 0), V(4, 0, 0)];
  ok(vfx.chainBolt(zitherX1, 0x9fd8ff) === 20, 'an x1 zither bolt (4 hops) still draws 20 links (5/hop)');

  // A heavier zither (x3: bounces 2 + linear(2, 3) = 8 hops) is the same hop
  // count Tesla Crown and an x5 Overcharge Cell reach, and is where this cap
  // has to start trading a little jaggedness for staying off the ring's
  // capacity in the pile-up below — still at least 3 segments/hop, still one
  // contiguous line through every hop, just not the full 5.
  const zitherX3 = [];
  for (let i = 0; i <= 8; i++) zitherX3.push(V(i, 0, 0));
  const drawnX3 = vfx.chainBolt(zitherX3, 0x9fd8ff);
  ok(drawnX3 >= 8 * 3, `an x3 zither bolt (8 hops) still draws at least 3 segments/hop (${drawnX3} links)`);
  ok(drawnX3 < 8 * 5, 'but no longer the full 5/hop, which is what the cap is for');
}

console.log('the reviewer\'s exact pile-up stays comfortably under BeamPool(192) with room for ~40 ambient beams');
{
  const CAPACITY = 192;
  const { vfx, beams } = makeVfx(CAPACITY);
  ok(beams.live === 0, 'a fresh pool has nothing live');

  // cracked-zither at x8: bounces = 2 + linear(2, 8) = 18.
  chainLightning(
    { combat: combatWithEndlessTargets(), player: {}, ctx: { vfx }, procDepth: 0 },
    { position: V(0, 0, 0), entity: {} }, 10, 18, { frame: 'chain' },
  );
  // Tesla Crown: fixed 5 bounces.
  chainLightning(
    { combat: combatWithEndlessTargets(), player: {}, ctx: { vfx }, procDepth: 0 },
    { position: V(0, 0, 0), entity: {} }, 10, 5, { frame: 'chain' },
  );
  // overcharge-cell at x5: bounces = 3 + linear(1, 5) = 8.
  chainLightning(
    { combat: combatWithEndlessTargets(), player: {}, ctx: { vfx }, procDepth: 0 },
    { position: V(0, 0, 0), entity: {} }, 10, 8, { frame: 'chain' },
  );
  // One ambient blight bolt, `_updateCorruptionAtmosphere`'s own shape: 3
  // points (2 hops), explicit segments: 4.
  vfx.chainBolt([V(0, 5, 0), V(3, 7, 2), V(6, 5, 0)], 0x6d3bb8,
    { segments: 4, jitter: 0.6, life: 0.22, width: 0.09 });

  ok(beams.live <= CAPACITY, `the pile-up used ${beams.live} of ${CAPACITY} slots, never past capacity`);
  ok(CAPACITY - beams.live >= 40,
    `and leaves ${CAPACITY - beams.live} slots free — room for ~40 ambient beams on top`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
