import { surveyManifest } from '../tools/margin-survey.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// Known shapes: crowd/object-set pair, and single-subject pair.
{
  const manifest = {
    shots: [
      {
        name: '04-combat',
        subject: { checks: [
          { kind: 'pixels', subject: 'horde', worstGatedSep: 0.29, marginPerSep: 0.27 },
        ] },
      },
      {
        name: '03-thirdperson',
        subject: { checks: [
          { kind: 'pixels', subject: 'survivor', sepP50: 0.51, marginSep: 0.27 },
        ] },
      },
      { name: '19-overkill', skipped: 'only-path-enforced', why: 'stated in the fixture' },
    ],
  };
  const { rows, skipped } = surveyManifest(manifest);
  ok(rows.length === 2, 'two graded measurements found');
  ok(rows[0].shot === '04-combat' && Math.abs(rows[0].headroom - 0.02) < 1e-9,
    'combat horde headroom computed as worstGatedSep - marginPerSep');
  ok(rows[1].shot === '03-thirdperson' && Math.abs(rows[1].headroom - 0.24) < 1e-9,
    'thirdperson survivor headroom computed as sepP50 - marginSep');
  ok(skipped.length === 1 && skipped[0].name === '19-overkill', 'skipped shot listed, not omitted');
}

// Unrecognised shape: a pixels check with a separation-flavoured field under
// neither known pair. This is the red-then-green case — before the
// `else` branch existed, a shape like this was silently dropped from the
// table instead of surfacing. Reproduce that regression here by asserting
// the branch's actual behavior.
{
  const manifest = {
    shots: [
      {
        name: '99-fixture',
        subject: { checks: [
          { kind: 'pixels', subject: 'mystery', someNewSepStat: 0.9, someNewThreshold: 0.5 },
        ] },
      },
    ],
  };
  const { rows } = surveyManifest(manifest);
  ok(rows.length === 1, 'unrecognised measurement is not dropped');
  ok(rows[0]?.unrecognised === true, 'unrecognised measurement is flagged, not silently paired');
  ok(Array.isArray(rows[0]?.keys) && rows[0].keys.includes('someNewSepStat'),
    'unrecognised measurement reports its own keys');
}

console.log(`\nmargin-survey: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
