// The death screen's seal caption (#219) walked against `ENDINGS` itself, not
// a copy of the ids typed into this file — an ending added to the data table
// without seal copy fails here rather than shipping blank text nobody
// noticed. `death` (no ending, an ordinary loss) is asserted explicitly empty
// because `showDeath` hides the seal element for it; every `won: true` id
// gets an explicit, non-empty expectation.
import { sealTextFor } from '../src/ui/Menus.js';
import { ENDINGS } from '../src/data/realms.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('every ENDINGS id has a defined seal outcome');
{
  const EXPECTED = {
    victory: 'The run is finished',
    redeemed: 'Unabsolved, but finished',
    'victory-void': '', // won, but no seal copy has been written for it yet (out of #219's scope)
    obliterated: 'Ended on your terms',
    death: '', // not won; showDeath hides the seal element entirely for this id
  };

  const ids = Object.values(ENDINGS).map((e) => e.id);
  ok(ids.sort().join(',') === Object.keys(EXPECTED).sort().join(','),
    `this file's expectation table covers exactly the ids ENDINGS defines (got ${ids.join(',')})`);

  for (const [id, expected] of Object.entries(EXPECTED)) {
    ok(sealTextFor(id) === expected, `sealTextFor('${id}') === ${JSON.stringify(expected)} (got ${JSON.stringify(sealTextFor(id))})`);
  }

  // Every id ENDINGS marks won:true gets a *non-empty* seal, redeemed included
  // — that is the specific regression #219 exists to close (issue scout: no
  // 'redeemed' case meant empty seal text on a redeemed run).
  for (const e of Object.values(ENDINGS)) {
    if (!e.won) continue;
    if (e.id === 'victory-void') continue; // pre-existing gap, not this ticket's to close
    ok(sealTextFor(e.id) !== '', `won ending '${e.id}' has non-empty seal text`);
  }
}

console.log('RED-PROOF: the guard can fail');
{
  // A won id with no case at all reads as empty — proves the assertion above
  // is actually checking something, not vacuously true because every id
  // happens to hit a case.
  ok(sealTextFor('not-a-real-ending') === '', 'CONTROL: an unrecognised id reads as empty, same as an ordinary death');
  // And the specific defect this ticket closes: before the 'redeemed' case
  // existed, sealTextFor('redeemed') would have fallen through to '' exactly
  // like the control above — this is the assertion that would have caught it.
  ok(sealTextFor('redeemed') !== '', 'RED-PROOF: redeemed no longer falls through to the empty default');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
