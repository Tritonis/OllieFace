// Artifacts modify the corruption economy (launch spec §1): the Maw
// accelerates every feed, Atonement makes the refund generous and the feeds
// worse — and the cards obey the file's own rules (real marks, valid ids).
//
// `MARKS` is module-private in `src/ui/Icons.js`; `hasMark` is the exported
// question about it, so that is what this asks rather than widening the
// module's surface for a test.
import { ARTIFACTS, ARTIFACT_BY_ID } from '../src/data/artifacts.js';
import { Artifacts } from '../src/systems/Artifacts.js';
import { hasMark } from '../src/ui/Icons.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the cards exist and obey the card rules');
{
  const maw = ARTIFACT_BY_ID.get('maw');
  const atone = ARTIFACT_BY_ID.get('atonement');
  ok(!!maw && !!atone, 'both cards registered');
  ok(maw.unlock === null && atone.unlock === null, 'always-on: no challenge plumbing');
  for (const c of [maw, atone]) {
    ok(typeof c.name === 'string' && typeof c.description === 'string' && typeof c.flavour === 'string', `${c.id} has its words`);
    ok(hasMark(c.mark), `${c.id}'s mark is an authored vector in Icons.js`);
  }
  const ids = ARTIFACTS.map((a) => a.id);
  ok(new Set(ids).size === ids.length, 'no id collisions');
}

console.log('corruptionMods answers the economy question');
{
  // Constructed, never init()ed: corruptionMods reads only `this.set`, and
  // init drags storage/profile that a headless test has no business building.
  const art = new Artifacts();
  const mods = (ids) => { art.set.clear(); for (const id of ids) art.set.add(id); return { ...art.corruptionMods() }; };
  const base = mods([]);
  ok(base.feed === 1 && base.refund === 1, 'no cards, no change');
  const maw = mods(['maw']);
  ok(maw.feed === 2 && maw.refund === 1, 'the Maw doubles every feed');
  const atone = mods(['atonement']);
  ok(atone.feed === 1.25 && atone.refund === 5, 'Atonement: generous refund, worse feeds');
  const both = mods(['maw', 'atonement']);
  ok(Math.abs(both.feed - 2.5) < 1e-9 && both.refund === 5, 'the two compose');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
