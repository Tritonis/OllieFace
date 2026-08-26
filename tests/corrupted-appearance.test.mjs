// tests/corrupted-appearance.test.mjs
//
// Corrupted appearance on normal mobs (docs/superpowers/plans/2026-08-26-corruption-atmosphere.md,
// mechanism (b)): a non-elite, non-boss spawn deep in corruption may wear a
// blight tint. Two halves: the roll in `Enemy.spawn` (gated on band, isElite,
// isBoss, and drawn off `Math.random()` rather than `ctx.rng`), and the
// material itself (`EnemyMeshes.setAffix`/`matsFor`) actually changing.

import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { acquireRig, releaseRig } from '../src/entities/EnemyMeshes.js';
import { ENEMIES } from '../src/data/enemies.js';
import { corruptedAppearanceChance } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 7) {
  let n = seed >>> 0;
  return {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + this.next() * (b - a); },
  };
}

function spawnOne(band, affix, isBoss, forceRandom) {
  const ctx = {
    rng: makeRng(), time: 0, scene: { add() {} },
    corruption: band == null ? undefined : { band },
  };
  const def = { ...ENEMIES[0], isBoss: !!isBoss };
  const e = new Enemy();
  const origRandom = Math.random;
  if (forceRandom != null) Math.random = () => forceRandom;
  try {
    e.spawn(ctx, def, { x: 0, y: 0, z: 0 }, { affix });
  } finally {
    Math.random = origRandom;
  }
  releaseRig(e.rig);
  return e;
}

console.log('\nthe threshold table itself');
{
  ok(corruptedAppearanceChance(0) === 0 && corruptedAppearanceChance(1) === 0,
    'Pristine and Seeded never roll corrupted');
  ok(corruptedAppearanceChance(2) > 0 && corruptedAppearanceChance(3) > corruptedAppearanceChance(2)
    && corruptedAppearanceChance(4) > corruptedAppearanceChance(3),
    'the chance climbs monotonically from Blighted through Consumed');
}

console.log('\nEnemy.spawn only rolls corrupted for a plain unit deep enough in the red');
{
  // RED ARM (confirmed by hand): dropping the `ctx.corruption?.band ?? 0`
  // read down to a hardcoded 0 makes this fail — a roll forced to land
  // (Math.random() = 0 < any positive chance) would never flip true.
  const e = spawnOne(3, null, false, 0);
  ok(e.corrupted === true, 'a forced-low roll at Overrun (chance > 0) turns corrupted on');

  const e2 = spawnOne(3, null, false, 0.999999);
  ok(e2.corrupted === false, 'a forced-high roll (over the ceiling) stays clean');

  const e3 = spawnOne(1, null, false, 0);
  ok(e3.corrupted === false, 'Seeded (band 1) never rolls true even at Math.random() = 0');

  const e4 = spawnOne(4, 'emberclad', false, 0);
  ok(e4.corrupted === false, 'an elite never wears the corrupted tint, whatever the roll');

  const e5 = spawnOne(4, null, true, 0);
  ok(e5.corrupted === false, 'neither does a boss');

  const e6 = spawnOne(null, null, false, 0);
  ok(e6.corrupted === false, 'no corruption system at all (menus, a realm) reads as band 0');
}

console.log('\nthe corrupted tint actually changes the rendered material');
{
  const plain = acquireRig(ENEMIES[0].meshFactory ? ENEMIES[0].meshFactory : 'mite');
  plain.setAffix(null, false);
  const plainColor = plain.mats.body.color.getHex();

  const corrupt = acquireRig('scarab');
  corrupt.setAffix(null, true);
  const corruptColor = corrupt.mats.body.color.getHex();
  // RED ARM (confirmed by hand): removing the `corrupted ? CORRUPT_TINT : null`
  // fallback in `matsFor` (leaving `tint = e ? e.tint : null`) collapses this
  // to the same hex as the plain body colour.
  ok(corruptColor !== plainColor, `corrupted body colour (0x${corruptColor.toString(16)}) ` +
    `differs from plain (0x${plainColor.toString(16)})`);

  // An elite ignores the corrupted flag entirely (setAffix forces it false
  // when an affix is present) — same material either way.
  const eliteA = acquireRig('scarab');
  eliteA.setAffix('emberclad', false);
  const eliteAColor = eliteA.mats.body.color.getHex();
  const eliteB = acquireRig('scarab');
  eliteB.setAffix('emberclad', true);
  const eliteBColor = eliteB.mats.body.color.getHex();
  ok(eliteAColor === eliteBColor, 'an elite affix tint is unaffected by the corrupted flag');
  ok(eliteA.corrupted === false && eliteB.corrupted === false,
    'and the rig itself never reports an elite as corrupted');

  releaseRig(plain); releaseRig(corrupt); releaseRig(eliteA); releaseRig(eliteB);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
