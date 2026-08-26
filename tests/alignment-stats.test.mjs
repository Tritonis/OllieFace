/**
 * Alignment statistics and the report tool (issue #166).
 *
 *   node tests/alignment-stats.test.mjs
 *
 * The arithmetic here is the input to a balance change, so the checks are of
 * three kinds.
 *
 * The first is that the numbers are right against a hand-built export whose
 * answer is known by counting.
 *
 * The second is backward compatibility, which is the property most easily lost
 * and least easily noticed: a version-2 record carries none of the #166 fields,
 * and the failure mode is not a crash but a *plausible* answer — every chest
 * counted as left standing, every run counted as holding nothing. So a v2
 * fixture is run through both `readRuns` and the report and must be excluded
 * with a warning rather than folded in.
 *
 * The third is determinism: the report body is a pure function of the records,
 * so the same export prints the same bytes. A clock in the output would make a
 * report undiffable across a balance change, which is the one use it has.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarise, verdict, annotateRun, poleOf, finalAlign, hasAlignment, isRemote } from '../tools/lib/alignment-stats.mjs';
import { readRuns, RECORD_VERSION } from '../src/systems/Telemetry.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, '..', 'tools', 'alignment-report.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const align = (argent, blight, other = 0, marks = 0, motes = 0) => ({ argent, blight, other, marks, motes, warded: 0 });

/** A version-3 run, spelled out so the expected totals are countable by eye. */
function run3({ id, offers = [], left = [], choices = [], stabilisations = 0, end = align(0, 0) }) {
  return {
    version: 3, id, complete: true,
    stages: left.map((n, i) => ({
      index: i, chestsLeft: n, alignIn: align(0, 0), alignOut: i === left.length - 1 ? end : align(0, 0),
    })),
    itemOffers: offers.map((outcome, i) => ({ t: i, stage: 0, kind: 'chest', outcome, cost: 25 })),
    mutationChoices: choices.map((outcome, i) => ({ t: i, band: 1, outcome })),
    stabilisations: Array.from({ length: stabilisations }, () => ({ t: 0 })),
    realmVisits: [],
  };
}

/** A record shaped the way version 2 wrote them — no #166 fields anywhere. */
const V2_RUN = {
  version: 2, id: 'old-1', complete: true,
  startedAt: '2026-08-01T00:00:00.000Z', endedAt: '2026-08-01T00:20:00.000Z',
  seed: 12345, survivor: 'ranger', difficulty: 'normal', artifacts: [], netRole: 'single',
  stages: [{ index: 0, name: 'the-shore', enteredAt: 0, leftAt: 120, corruptionIn: 0, corruptionOut: 30, bandIn: 0, bandOut: 1, items: 4, kills: 90 }],
  corruption: { peakWorld: 30, peakBand: 1, fed: 30, bled: 0, crossings: [], marks: { minted: 1, spent: 0 }, ruined: false, motes: { minted: 0, spent: 0, warded: 0 } },
  bargains: [], sanctuaries: [], argent: [], mutations: [{ t: 60, band: 1, baseId: 'a', blightId: 'b', count: 2 }],
  stabilisations: [], fonts: [], realmOffers: [], realmVisits: [], levels: [],
  route: { offered: [], taken: null }, outcome: { won: false, ending: null }, stats: null, fatal: null, brokenHooks: [],
};

console.log('the counts are what the records say');
{
  const runs = [
    run3({ id: 'a', offers: ['taken-normally', 'taken-normally', 'taken-corrupted'], left: [1, 2], choices: ['explicit-choice', 'timeout'], stabilisations: 1, end: align(2, 1) }),
    run3({ id: 'b', offers: ['taken-corrupted'], left: [0], choices: ['death'], end: align(0, 3) }),
  ];
  const r = summarise(runs);
  ok(r.runs === 2 && r.scored === 2 && r.stale === 0, 'both runs scored');
  ok(r.offers.takenNormally === 2 && r.offers.takenCorrupted === 2, 'the two currencies split 2/2');
  ok(r.offers.left === 3, 'three chests were left standing');
  ok(Math.abs(r.offers.takeRate - 4 / 7) < 1e-9, 'take rate is takes over takes plus left');
  ok(Math.abs(r.offers.corruptShare - 0.5) < 1e-9, 'half the takes were on credit');
  ok(r.offers.purifiedSalvaged === 1, 'the salvage is counted, and separately');
  ok(r.mutations['explicit-choice'] === 1 && r.mutations.timeout === 1 && r.mutations.death === 1,
    'every mutation outcome is tallied under its own name');
  ok(r.mutations.total === 3 && Math.abs(r.mutations.choiceRate - 1 / 3) < 1e-9, 'and the choice rate falls out');
  ok(r.poles.mixed === 1 && r.poles.blight === 1 && Math.abs(r.poles.mixedShare - 0.5) < 1e-9,
    'one run ended mixed, one blight-only');
}

console.log('a mutation closed by a guest disconnecting is its own tally, not unknown (#202)');
{
  const r = summarise([run3({ id: 'a', choices: ['disconnect', 'explicit-choice'] })]);
  ok(r.mutations.disconnect === 1, 'the disconnect close has its own bucket');
  ok(r.mutations.unknown === 0, 'and is not folded into unknown');
}

console.log('a stage that could not be swept is neither a take nor a leave');
{
  const r = summarise([run3({ id: 'a', offers: ['taken-normally'], left: [null, 2] })]);
  ok(r.offers.left === 2 && r.offers.unknownStages === 1, 'the unsweepable stage is reported, not counted');
}

console.log('poles and the final snapshot');
{
  ok(poleOf(align(1, 1)) === 'mixed' && poleOf(align(1, 0)) === 'argent'
    && poleOf(align(0, 1)) === 'blight' && poleOf(align(0, 0)) === 'neither', 'the four shelves');
  ok(poleOf(null) === null, 'and an absent shelf is not a shelf of nothing');
  ok(finalAlign({ stages: [{ alignOut: align(1, 0) }, { alignOut: null }], realmVisits: [{ alignOut: align(0, 2) }] })?.argent === 1,
    'the last stage that closed wins over a realm');
  ok(finalAlign({ stages: [], realmVisits: [{ alignOut: align(0, 2) }] })?.blight === 2,
    'and a run that ended inside a realm falls back to it');
}

console.log('a version-2 export is readable, excluded, and never guessed at');
{
  ok(!hasAlignment(V2_RUN) && annotateRun(V2_RUN) === null, 'an old record cannot answer and says so');
  const r = summarise([V2_RUN, run3({ id: 'new', offers: ['taken-normally'], left: [0], end: align(1, 1) })]);
  ok(r.runs === 2 && r.scored === 1 && r.stale === 1, 'it is counted as stale, not as an empty run');
  ok(r.offers.left === 0, 'its stage does NOT become a chest left standing');
  ok(r.poles.known === 1, 'and its shelf does not become an empty shelf');

  // The same bytes through the runtime reader the export button writes for.
  const storage = { getItem: () => JSON.stringify([V2_RUN]), setItem() {}, removeItem() {} };
  const back = readRuns(storage);
  ok(back.length === 1 && back[0].version === 2 && RECORD_VERSION === 3,
    'and readRuns still hands a v2 record back intact under a v3 build');
}

/**
 * A co-op guest's record is the host's corruption trajectory wearing the
 * guest's name, and — because `interact` is authority-gated — a stage sheet of
 * chests nobody on that machine could open. Averaged in, it counts the host's
 * run once per peer and drags the take rate down by lobby size. The arithmetic
 * below is the measured case from the integration review: 0.50 host-only,
 * 0.33 with one guest folded in.
 */
console.log('a co-op guest never reaches the verdicts');
{
  const host = run3({ id: 'host', offers: ['taken-normally'], left: [1], end: align(1, 0) });
  host.netRole = 'host';
  // The guest saw the same stage: one chest standing, and no open of its own.
  const guest = run3({ id: 'guest', offers: [], left: [1], choices: ['timeout'], end: align(1, 0) });
  guest.netRole = 'client';

  const poisoned = summarise([host, guest]);
  ok(poisoned.remote === 1 && poisoned.scored === 1, 'the guest is excluded and counted as remote');
  ok(poisoned.stale === 0, 'and not confused with an old export');
  ok(Math.abs(poisoned.offers.takeRate - 0.5) < 1e-9,
    'the take rate is the host\'s 0.50, not the 0.33 a folded-in guest produces');
  ok(poisoned.mutations.total === 0, 'the guest\'s replicated mutation window is not a decision either');
  ok(poisoned.poles.known === 1, 'nor its replicated shelf a shelf');

  // The guard: if someone re-includes client runs, this arithmetic changes.
  // Spelled out rather than implied, so the regression is a failure and not a
  // silently different number.
  const folded = summarise([host, { ...guest, netRole: 'host' }]);
  ok(Math.abs(folded.offers.takeRate - 1 / 3) < 1e-9,
    'and the poisoned figure is reachable, so the exclusion is doing work');
  ok(annotateRun(guest) === null && isRemote(guest), 'a guest annotates to nothing');
  ok(!isRemote(host) && !isRemote({ version: 3 }),
    'host and role-less records are not remote — absence predates replication and is scored');
}

console.log('the verdicts refuse to guess, and then do not');
{
  const thin = verdict(summarise([run3({ id: 'a', offers: ['taken-normally'], left: [0] })]));
  ok(thin.rewards.verdict === 'NO VERDICT' && thin.inventories.verdict === 'NO VERDICT', 'one run answers nothing');

  const greedy = [];
  for (let i = 0; i < 12; i++) greedy.push(run3({ id: `g${i}`, offers: ['taken-normally', 'taken-corrupted'], left: [0], end: align(1, 1) }));
  const g = verdict(summarise(greedy));
  ok(g.rewards.verdict === 'TAKES EVERYTHING', 'nothing left standing is the tension-free case');
  ok(g.inventories.verdict === 'MIXED DOMINANT', 'and every run ending mixed is the other one');

  const choosy = [];
  for (let i = 0; i < 12; i++) choosy.push(run3({ id: `c${i}`, offers: ['taken-normally'], left: [3], end: align(2, 0) }));
  const c = verdict(summarise(choosy));
  ok(c.rewards.verdict === 'DECLINES SOME' && c.inventories.verdict === 'POLES HOLD', 'and the refutations are reachable');
}

console.log('the report tool is deterministic and reads both export shapes');
{
  const dir = mkdtempSync(join(tmpdir(), 'align-'));
  const runs = [
    run3({ id: 'a', offers: ['taken-normally', 'taken-corrupted'], left: [1], choices: ['explicit-choice'], end: align(1, 1) }),
    V2_RUN,
  ];
  const wrapped = join(dir, 'export.json');
  const bare = join(dir, 'bare.json');
  writeFileSync(wrapped, JSON.stringify({ version: 3, exportedAt: '2026-08-23T00:00:00.000Z', runs }, null, 2));
  writeFileSync(bare, JSON.stringify(runs, null, 2));

  const call = (p, extra = []) => spawnSync(process.execPath, [TOOL, p, ...extra], { encoding: 'utf8' });
  const a = call(wrapped);
  const b = call(wrapped);
  ok(a.status === 0 && a.stdout.length > 0, 'the tool ran');
  ok(a.stdout === b.stdout, 'and printed byte-identical output twice');
  ok(!/\d{4}-\d{2}-\d{2}T/.test(a.stdout), 'with no timestamp anywhere in the body');
  ok(call(bare).stdout === a.stdout, 'a bare array reads the same as a wrapped export');
  ok(a.stdout.includes('1 run(s) predate record version 3'), 'and the stale run is announced');
  ok(a.stdout.includes('taken corrupted'), 'the offer taxonomy is printed');

  const j = call(wrapped, ['--json']);
  const parsed = JSON.parse(j.stdout);
  ok(parsed.scored === 1 && parsed.verdict.rewards.verdict === 'NO VERDICT', '--json carries the same figures');

  const bad = spawnSync(process.execPath, [TOOL, join(dir, 'nope.json')], { encoding: 'utf8' });
  ok(bad.status === 2, 'a missing file exits 2 rather than printing a report of nothing');
}

console.log('an export with runs but zero scored evidence fails loudly instead of printing NO VERDICT (#216)');
{
  const dir = mkdtempSync(join(tmpdir(), 'align-empty-'));
  const guest = run3({ id: 'guest', offers: ['taken-normally'], left: [0] });
  guest.netRole = 'client';
  const emptyPath = join(dir, 'empty.json');
  writeFileSync(emptyPath, JSON.stringify([V2_RUN, guest], null, 2));

  const call = (extra = []) => spawnSync(process.execPath, [TOOL, emptyPath, ...extra], { encoding: 'utf8' });

  const text = call();
  ok(text.status !== 0, 'zero scored runs exits non-zero in text mode');
  ok(/stale/i.test(text.stderr + text.stdout) && /1/.test(text.stderr + text.stdout),
    'the failure names the stale count');
  ok(/remote|guest/i.test(text.stderr + text.stdout), 'the failure names the remote/guest count');
  ok(!/NO VERDICT/.test(text.stdout), 'the misleading NO VERDICT report is not printed for zero scored runs');

  const json = call(['--json']);
  ok(json.status !== 0, 'zero scored runs exits non-zero in --json mode too');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
