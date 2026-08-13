/**
 * summarizeStats — pure reduction over a WebRTC getStats() iterable.
 *
 *   node tests/icediag.test.mjs
 *
 * Fixtures are built as real `Map`s, id-keyed exactly like the
 * `RTCStatsReport` `pc.getStats()` resolves to — its default iterator (a
 * bare `for...of`) yields `[id, statsObject]` pairs, not the stats objects
 * themselves, and plain-array fixtures hid that bug entirely (review
 * task-1-review.md finding #1). One compatibility case at the bottom keeps a
 * plain array working too, since `summarizeStats` accepts either.
 *
 * The poller (`attachIceDiag`) and the co-op panel it feeds are DOM/browser
 * concerns and are probe-verified rather than unit-tested here (see this
 * slice's task-5 probe run).
 */
import { summarizeStats } from '../src/net/IceDiag.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A Map keyed by `id`, exactly the shape `pc.getStats()` resolves to. */
function report(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.id, e);
  return m;
}

// --- (a) host+srflx locals, succeeded pair srflx/host, rtt 0.047 -----------
{
  const stats = report([
    { id: 'L1', type: 'local-candidate', candidateType: 'host' },
    { id: 'L2', type: 'local-candidate', candidateType: 'srflx' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
    {
      id: 'P1', type: 'candidate-pair', state: 'succeeded',
      localCandidateId: 'L2', remoteCandidateId: 'R1', currentRoundTripTime: 0.047,
    },
  ]);
  const s = summarizeStats(stats, { gathering: 'complete', turnConfigured: false });
  ok(s.gathering === 'complete', 'case a: gathering passed through');
  ok(JSON.stringify(s.localTypes) === JSON.stringify(['host', 'srflx']), 'case a: localTypes distinct, in order seen');
  ok(JSON.stringify(s.remoteTypes) === JSON.stringify(['host']), 'case a: remoteTypes');
  ok(s.selected && s.selected.local === 'srflx' && s.selected.remote === 'host', 'case a: selected pair types');
  ok(s.selected.rttMs === 47, 'case a: rttMs = currentRoundTripTime * 1000');
  ok(s.turnConfigured === false, 'case a: turnConfigured passed through');
}

// --- (b) empty stats --------------------------------------------------------
{
  const s = summarizeStats(report([]), { gathering: 'new', turnConfigured: false });
  ok(s.selected === null, 'case b: no candidate pairs -> selected null');
  ok(s.localTypes.length === 0, 'case b: localTypes empty');
  ok(s.remoteTypes.length === 0, 'case b: remoteTypes empty');
  ok(s.gathering === 'new', 'case b: gathering passed through');
}

// --- (c) relay-only both sides ----------------------------------------------
{
  const stats = report([
    { id: 'L1', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'relay' },
    {
      id: 'P1', type: 'candidate-pair', nominated: true,
      localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.1,
    },
  ]);
  const s = summarizeStats(stats, { gathering: 'complete', turnConfigured: true });
  ok(JSON.stringify(s.localTypes) === JSON.stringify(['relay']), 'case c: localTypes relay-only');
  ok(JSON.stringify(s.remoteTypes) === JSON.stringify(['relay']), 'case c: remoteTypes relay-only');
  ok(s.selected && s.selected.local === 'relay' && s.selected.remote === 'relay', 'case c: nominated pair selected');
  ok(s.turnConfigured === true, 'case c: turnConfigured true');
}

// --- (d) first qualifying pair wins over a later one ------------------------
{
  const stats = report([
    { id: 'L1', type: 'local-candidate', candidateType: 'host' },
    { id: 'L2', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
    { id: 'R2', type: 'remote-candidate', candidateType: 'relay' },
    // Stale succeeded pair from before a hypothetical ICE restart, seen first.
    {
      id: 'P1', type: 'candidate-pair', state: 'succeeded',
      localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.02,
    },
    // A later nominated pair — must NOT override the first qualifying pair.
    {
      id: 'P2', type: 'candidate-pair', nominated: true,
      localCandidateId: 'L2', remoteCandidateId: 'R2', currentRoundTripTime: 0.2,
    },
  ]);
  const s = summarizeStats(stats, { gathering: 'complete', turnConfigured: true });
  ok(s.selected.local === 'host' && s.selected.remote === 'host', 'case d: first qualifying pair wins, not the last');
}

// --- compatibility: a plain array of already-unwrapped stats still works ---
{
  const stats = [
    { id: 'L1', type: 'local-candidate', candidateType: 'host' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
    {
      id: 'P1', type: 'candidate-pair', state: 'succeeded',
      localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.02,
    },
  ];
  const s = summarizeStats(stats, { gathering: 'complete', turnConfigured: false });
  ok(s.selected && s.selected.local === 'host' && s.selected.rttMs === 20, 'compat: plain array input still works');
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
