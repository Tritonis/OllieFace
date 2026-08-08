import { ELITE_STATS, ELITE_TIERS, ELITE_AFFIXES, eliteAffixesFor } from '../src/data/enemies.js';
import { VOIDTOUCHED, voidCreditRate } from '../src/data/corruption.js';
import { ELITE } from '../src/entities/EnemyMeshes.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the affix card exists and never enters the normal roll');
{
  const s = ELITE_STATS.voidtouched;
  ok(!!s, 'ELITE_STATS.voidtouched exists');
  ok(s.label === 'Hollowed', 'display label is Hollowed, not the RoR2 name');
  ok(s.siphonRadius > 0 && s.siphonDps > 0 && s.siphonHeal > 0, 'siphon rider knobs present');
  ok(!ELITE_AFFIXES.includes('voidtouched'), 'not in the flat affix list');
  ok(!ELITE_TIERS.some((t) => t.affixes.includes('voidtouched')), 'not in any unlock tier');
  ok(!eliteAffixesFor(999).includes('voidtouched'), 'no difficulty ever unlocks it into the roll');
}

console.log('the tuning block is a spend curve, not a faucet');
{
  ok(VOIDTOUCHED.affix === 'voidtouched', 'affix key matches the stats key');
  ok(voidCreditRate(0) === 0, 'a pristine world accrues nothing');
  ok(voidCreditRate(100) > voidCreditRate(50), 'rate scales with World Corruption');
  ok(voidCreditRate(-5) === 0, 'negative world clamps to zero');
  ok(VOIDTOUCHED.refund > 0 && VOIDTOUCHED.refund < 1, 'kill refund is a fraction');
  ok(VOIDTOUCHED.spawnRing.min > 0 && VOIDTOUCHED.spawnRing.max > VOIDTOUCHED.spawnRing.min, 'ring is a band');
  ok(VOIDTOUCHED.minPlayerDist > VOIDTOUCHED.spawnRing.max, 'a seed at your feet cannot surface one in your face');
}

console.log('the rig table knows the family');
{
  const v = ELITE.voidtouched;
  ok(!!v, 'ELITE.voidtouched exists');
  ok(v.name === 'Hollowed', 'rig table name agrees with the stats label');
  ok(typeof v.tint === 'number' && typeof v.aura === 'number', 'tint and aura are colours');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
