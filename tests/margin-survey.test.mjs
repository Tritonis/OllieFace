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

// Both-pairs shape: a single check can carry worstGatedSep/marginPerSep AND
// sepP50/marginSep simultaneously (6 of 16 pixels checks in the reference
// manifest do). Both independently gate `marginOk` in Harness.js, so both
// must survive as their own row. The sepP50 row here has LESS headroom than
// the worstGatedSep row — the inverted case a naive else-if would drop,
// producing a false floor while the worse row silently disappeared.
{
  const manifest = {
    shots: [
      {
        name: '04-combat',
        subject: { checks: [
          {
            kind: 'pixels', subject: 'horde',
            worstGatedSep: 0.50, marginPerSep: 0.27, // headroom 0.23 — the LARGER one
            sepP50: 0.29, marginSep: 0.27,            // headroom 0.02 — the true, smaller floor
          },
        ] },
      },
    ],
  };
  const { rows } = surveyManifest(manifest);
  ok(rows.length === 2, 'a check carrying both gates produces two rows, not one');
  const wgs = rows.find((r) => r.statName === 'worstGatedSep');
  const sp50 = rows.find((r) => r.statName === 'sepP50');
  ok(!!wgs && Math.abs(wgs.headroom - 0.23) < 1e-9, 'worstGatedSep row keeps its own headroom');
  ok(!!sp50 && Math.abs(sp50.headroom - 0.02) < 1e-9,
    'sepP50 row is not dropped even though worstGatedSep matched first — this is the false-floor case');
  ok(rows[0] === sp50, 'the smaller (true floor) row sorts first, not the row a single-match survey would have kept');
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
