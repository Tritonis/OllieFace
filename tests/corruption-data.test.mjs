import { BANDS, SOURCES, bandOf } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('bands are a readable ladder');
ok(BANDS.length === 5, 'five bands, T0-T4');
ok(BANDS[0].at === 0 && BANDS[0].name === 'Pristine', 'T0 is Pristine at 0');
ok(BANDS.every((b, i) => i === 0 || b.at > BANDS[i - 1].at), 'thresholds strictly ascend');
ok(BANDS.every((b, i) => b.id === i), 'ids are their indices');

console.log('bandOf maps world corruption to the band whose threshold it has passed');
ok(bandOf(0) === 0, 'zero is Pristine');
ok(bandOf(BANDS[1].at - 0.001) === 0, 'just under T1 is still T0');
ok(bandOf(BANDS[1].at) === 1, 'exactly T1 enters band 1');
ok(bandOf(BANDS[4].at + 1000) === 4, 'no band above Consumed');
ok(bandOf(-5) === 0, 'negative clamps to Pristine');

console.log('sources are positive and shaped for their call sites');
for (const k of ['small', 'large', 'legendary']) {
  ok(SOURCES.chestTithe[k] > 0, `chestTithe.${k} positive`);
  ok(SOURCES.voidCredit[k] > SOURCES.chestTithe[k] * 3, `voidCredit.${k} is a steep multiple of the tithe`);
}
ok(SOURCES.itemFeed.common > 0, 'common items feed');
ok(SOURCES.itemFeed.blight >= SOURCES.itemFeed.legendary, 'corrupted-tier items feed most (spec)');
ok(SOURCES.greedMult > 1, 'greed time multiplies');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
