/**
 * A run record's ending id survives the trip through a save (issue #220).
 *
 *   node tests/profile-ending-migration.test.mjs
 *
 * `PROFILE_VERSION` moved 4 -> 5: a run record gains `endingId`, the specific
 * finale a win resolved to (`ENDINGS` in data/realms.js), or `'death'` for a
 * plain defeat. A v4 record predates the field entirely, and `legacyEndingFor`
 * (src/systems/Profile.js) is the one place its best-effort recovery is
 * decided: `death` maps back with certainty (there has only ever been one
 * death ending), `victory` maps to the `LEGACY_VICTORY_ENDING` sentinel
 * because which finale it actually was is genuinely lost, and anything else
 * (`quit`) never had an ending to lose and stays null.
 *
 * Follows the migration-test pattern `tests/item-id-migration.test.mjs` set:
 * call `_migrate` + `_coerce` directly (the pair `_load`/`importProfile` both
 * go through) on a real blob shaped like a saved profile, off `localStorage`.
 */
import { Profile, PROFILE_VERSION, LEGACY_VICTORY_ENDING } from '../src/systems/Profile.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const migrate = (blob) => { const p = new Profile(); return p._coerce(p._migrate(blob)); };

/** A genuine v4 profile — the shape written before `endingId` existed. */
const v4Blob = () => ({
  version: 4,
  createdAt: 1000, updatedAt: 2000,
  unlocks: { survivor: {}, item: {}, equipment: {}, artifact: {}, skin: {} },
  challenges: {},
  encounters: { item: {}, enemy: {}, boss: {}, equipment: {}, survivor: {} },
  survivors: { ranger: { runs: 3, wins: 1, deaths: 2, kills: 90, time: 600, bestStage: 5, bestTime: 300 } },
  runs: [
    { at: 5000, survivorId: 'ranger', outcome: 'victory', stage: 6, kills: 200, inventory: [] },
    { at: 6000, survivorId: 'ranger', outcome: 'death', stage: 4, kills: 80, inventory: [] },
    { at: 7000, survivorId: 'anvil', outcome: 'quit', stage: 2, kills: 10, inventory: [] },
  ],
});

console.log('a v4 profile gains a deterministic endingId on every run, with nothing else disturbed');
{
  const p = migrate(v4Blob());
  ok(p.version === PROFILE_VERSION, `migrates up to v${PROFILE_VERSION}`);
  ok(p.runs.length === 3, 'no run was dropped or duplicated');

  const [victory, death, quit] = p.runs;
  ok(victory.outcome === 'victory' && victory.endingId === LEGACY_VICTORY_ENDING,
     'a legacy victory outcome gets the "which finale is lost" sentinel, not a guess');
  ok(death.outcome === 'death' && death.endingId === 'death',
     'a legacy death outcome maps back to the one death ending with certainty');
  ok(quit.outcome === 'quit' && quit.endingId === null,
     'a legacy quit never had an ending, and stays null rather than inventing one');

  // Untouched by the ending migration: same guarantee `item-id-migration`
  // pins for the id rename.
  ok(victory.stage === 6 && victory.kills === 200, 'the victory record itself is otherwise untouched');
  ok(p.survivors.ranger?.kills === 90, 'the per-survivor career is untouched');
}

console.log('migrating is safe to repeat — a record that already has an endingId keeps it');
{
  const once = migrate(v4Blob());
  const twice = migrate(JSON.parse(JSON.stringify(once)));
  ok(twice.runs[0].endingId === LEGACY_VICTORY_ENDING, 'the sentinel is not re-derived into something else');
  ok(twice.runs[1].endingId === 'death', 'nor is the death mapping run twice');
  ok(twice.runs[2].endingId === null, 'nor does a second pass invent one for the quit');
}

console.log('a real ending id written by a v5+ build survives untouched');
{
  const blob = v4Blob();
  blob.version = 5;
  blob.runs = [
    { at: 8000, survivorId: 'ranger', outcome: 'victory', endingId: 'redeemed', stage: 6, kills: 300, inventory: [] },
    { at: 9000, survivorId: 'ranger', outcome: 'victory', endingId: 'victory-void', stage: 6, kills: 300, inventory: [] },
  ];
  const p = migrate(blob);
  ok(p.runs[0].endingId === 'redeemed', 'a real redeemed ending id is not overwritten by the legacy rule');
  ok(p.runs[1].endingId === 'victory-void', 'nor is a real void-victory ending id');
}

console.log('the guard actually distinguishes the three outcomes — not merely present on every record');
{
  // A guard that maps every outcome to the same value would still pass the
  // presence checks above. This asserts the three legacy outcomes resolve to
  // three DIFFERENT values, which is the property the whole migration exists
  // to establish.
  const p = migrate(v4Blob());
  const ids = new Set(p.runs.map((r) => r.endingId));
  ok(ids.size === 3, 'victory, death and quit map to three distinct endingId values');
}

console.log('migrating is safe on junk, same as every other migration entry');
{
  for (const junk of [{}, { version: 4 }, { version: 4, runs: null }, { version: 4, runs: [null, 3, {}] }]) {
    let threw = null;
    try { migrate(junk); } catch (e) { threw = e; }
    ok(threw === null, `${JSON.stringify(junk)} migrates without throwing`);
  }
  const empty = migrate({ version: 4, runs: [] });
  ok(Array.isArray(empty.runs) && empty.runs.length === 0, 'an empty run list stays empty');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
