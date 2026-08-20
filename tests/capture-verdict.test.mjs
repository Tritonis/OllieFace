// tests/capture-verdict.test.mjs
//
// Issue #124: the capture gate (`npm run shots`) was made advisory only —
// it reports, it never blocks. This is a unit test of the pure decision in
// `tools/lib/capture-verdict.mjs` (deliberately NOT `tools/capture.mjs`
// itself, which boots vite and a real chromium as a top-level side effect
// the moment it is imported — see that file's own header).
//
// The whole point of this ticket is the exit-code split, so this file
// demonstrates BOTH directions failing on purpose: a legibility/advisory
// run that must exit 0, and an infrastructure run that must still exit
// non-zero. A test that only ever sees exit 0 would prove nothing.

import { captureVerdict } from '../tools/lib/capture-verdict.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('a clean run: ready, no shot errors, no subject/audio findings — exit 0, no advisory');
{
  const v = captureVerdict({
    ready: true,
    shots: [{ name: '01-title' }, { name: '02-vista' }],
    errors: [],
    subjectFailures: [],
    audioOk: true,
  });
  ok(v.infraFailed === false, 'infraFailed is false');
  ok(v.advisoryFindings === false, 'advisoryFindings is false');
}

console.log('legibility/advisory failure: subject failures + [harness] diagnostics + a dead mix — MUST exit 0');
{
  const v = captureVerdict({
    ready: true,
    shots: [{ name: '01-title' }, { name: '04-combat' }],
    // A `[harness]` message is the subject-failure detail itself, logged by
    // the scenario that just failed a siting check — not a crash.
    errors: ['[harness] 09-survivors: no flat, unoccluded row on any bearing; using the fallback'],
    subjectFailures: [{ name: '04-combat', failed: ['enemy-3'] }],
    audioOk: false,
  });
  ok(v.infraFailed === false, 'a run with subject failures, [harness] diagnostics and a failed audio check still has infraFailed === false');
  ok(v.advisoryFindings === true, 'advisoryFindings is true — the findings are real, just not blocking');
  ok(v.infra.bootFailed === false, 'infra.bootFailed is false');
  ok(v.infra.shotErrors.length === 0, 'infra.shotErrors is empty — nothing threw');
  ok(v.infra.consoleErrors.length === 0, 'the [harness]-prefixed message is excluded from infra.consoleErrors');
}

console.log('infrastructure failure #1: boot never reached ready — MUST exit non-zero');
{
  const v = captureVerdict({ ready: false, shots: [], errors: [], subjectFailures: [], audioOk: null });
  ok(v.infraFailed === true, 'a failed boot sets infraFailed');
  ok(v.infra.bootFailed === true, 'infra.bootFailed is true');
}

console.log('infrastructure failure #2: a scenario threw (navigation/shot timeout, page crash) — MUST exit non-zero');
{
  const v = captureVerdict({
    ready: true,
    shots: [{ name: '01-title' }, { name: '08-explosion', error: 'TimeoutError: page.screenshot: Timeout 30000ms exceeded' }],
    errors: [],
    subjectFailures: [],
    audioOk: true,
  });
  ok(v.infraFailed === true, 'a shot with an .error field sets infraFailed even though ready and audioOk are both fine');
  ok(v.infra.shotErrors.length === 1 && /08-explosion/.test(v.infra.shotErrors[0]), 'infra.shotErrors names the failed scenario');
}

console.log('infrastructure failure #3: a real (non-[harness]) console/page error — MUST exit non-zero');
{
  const v = captureVerdict({
    ready: true,
    shots: [{ name: '01-title' }],
    errors: ['TypeError: Cannot read properties of undefined (reading \'x\')\n    at Engine._frame'],
    subjectFailures: [],
    audioOk: true,
  });
  ok(v.infraFailed === true, 'a genuine JS error sets infraFailed');
  ok(v.infra.consoleErrors.length === 1, 'the real error lands in infra.consoleErrors, not treated as advisory');
}

console.log('a run can carry BOTH an infra failure and advisory findings — infra still wins the exit code');
{
  const v = captureVerdict({
    ready: true,
    shots: [{ name: '08-explosion', error: 'crashed' }],
    errors: [],
    subjectFailures: [{ name: '04-combat', failed: ['enemy-3'] }],
    audioOk: false,
  });
  ok(v.infraFailed === true, 'infraFailed is true');
  ok(v.advisoryFindings === true, 'advisoryFindings is also true — both are reported, but only infra blocks');
}

console.log(`\ncapture-verdict: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
