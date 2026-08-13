/**
 * summarizeStats — pure reduction over a WebRTC getStats() iterable.
 *
 *   node tests/icediag.test.mjs
 *
 * The poller (`attachIceDiag`) and the co-op panel it feeds are DOM/browser
 * concerns and are probe-verified rather than unit-tested here (see this
 * slice's task-5 probe run).
 */
import { summarizeStats } from '../src/net/IceDiag.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --- (a) host+srflx locals, succeeded pair srflx/host, rtt 0.047 -----------
{
  const stats = [
    { type: 'local-candidate', id: 'L1', candidateType: 'host' },
    { type: 'local-candidate', id: 'L2', candidateType: 'srflx' },
    { type: 'remote-candidate', id: 'R1', candidateType: 'host' },
    {
      type: 'candidate-pair', state: 'succeeded',
      localCandidateId: 'L2', remoteCandidateId: 'R1', currentRoundTripTime: 0.047,
    },
  ];
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
  const s = summarizeStats([], { gathering: 'new', turnConfigured: false });
  ok(s.selected === null, 'case b: no candidate pairs -> selected null');
  ok(s.localTypes.length === 0, 'case b: localTypes empty');
  ok(s.remoteTypes.length === 0, 'case b: remoteTypes empty');
  ok(s.gathering === 'new', 'case b: gathering passed through');
}

// --- (c) relay-only both sides ----------------------------------------------
{
  const stats = [
    { type: 'local-candidate', id: 'L1', candidateType: 'relay' },
    { type: 'remote-candidate', id: 'R1', candidateType: 'relay' },
    {
      type: 'candidate-pair', nominated: true,
      localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.1,
    },
  ];
  const s = summarizeStats(stats, { gathering: 'complete', turnConfigured: true });
  ok(JSON.stringify(s.localTypes) === JSON.stringify(['relay']), 'case c: localTypes relay-only');
  ok(JSON.stringify(s.remoteTypes) === JSON.stringify(['relay']), 'case c: remoteTypes relay-only');
  ok(s.selected && s.selected.local === 'relay' && s.selected.remote === 'relay', 'case c: nominated pair selected');
  ok(s.turnConfigured === true, 'case c: turnConfigured true');
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
