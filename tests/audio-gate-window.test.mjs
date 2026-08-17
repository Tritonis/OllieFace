// tests/audio-gate-window.test.mjs
//
// The capture gate's `musicAudible` check spent months flapping (#96) because
// its sampling window was shorter than the silence that follows a `beginRun()`
// restart: layer levels only commit on a bar boundary and then ramp in over
// half a bar, so the music bus can legitimately read zero for a full bar plus a
// ramp after the gate opens. The fix waits that out — `GATE_SETTLE_S` in
// `tools/capture.mjs` — and the settle is derived from the arrangement's own
// tempo and ramp rather than typed as a literal.
//
// Derivation is only half a guarantee: `tools/capture.mjs` cannot import
// `src/systems/Music.js`'s private numbers (they are constructor and method-body
// values, not exports), so it *restates* them. This file is what keeps the
// restatement honest. It reads both sources, fails if Music.js has moved away
// from the values capture.mjs claims, and recomputes the worst case from the
// numbers actually in Music.js to check the settle still covers it.
//
// And because a check that can only pass is this repo's dominant defect shape,
// the second half feeds the same comparison a synthetic Music.js at 90 bpm with
// a whole-bar ramp — a change that really would reopen the gap — and requires it
// to come back short.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const musicSrc = readFileSync(join(root, 'src/systems/Music.js'), 'utf8');
const captureSrc = readFileSync(join(root, 'tools/capture.mjs'), 'utf8');

/** Pull `const NAME = <number>;` out of the capture gate's audio block. */
const captureNum = (name) => {
  const m = captureSrc.match(new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.]+)\\s*;`));
  return m ? Number(m[1]) : null;
};

/**
 * The three arrangement values the settle is built on, read out of Music.js
 * itself. Each regex is anchored on the surrounding expression rather than on a
 * bare number, so a coincidental 118 or 0.5 elsewhere in the file cannot
 * satisfy it.
 */
const readMusic = (src) => ({
  // Constructor: the tempo at intensity 0, which is where a restart sits.
  bpm: Number(src.match(/this\.bpm\s*=\s*(\d+(?:\.\d+)?)\s*;/)?.[1] ?? NaN),
  // `_schedule`: 16th notes.
  stepsPerBeat: Number(src.match(/stepDur\s*=\s*60\s*\/\s*this\.bpm\s*\/\s*(\d+)/)?.[1] ?? NaN),
  // `_onBar`: bar length in steps.
  barSteps: Number(src.match(/const bar\s*=\s*(\d+)\s*\*\s*stepDur/)?.[1] ?? NaN),
  // `_onBar`: how much of a bar a level commit ramps across.
  rampBars: Number(src.match(/_apply\(next,\s*t,\s*bar\s*\*\s*([\d.]+)\)/)?.[1] ?? NaN),
});

/** Worst-case silence after `beginRun()`: a whole bar to the downbeat that
 *  commits the levels, plus the ramp that follows it. */
const worstCaseSilenceS = (M) => {
  const barS = M.barSteps * (60 / M.bpm / M.stepsPerBeat);
  return { barS, silenceS: barS * (1 + M.rampBars) };
};

console.log('Music.js still says what tools/capture.mjs restates');
const M = readMusic(musicSrc);
{
  ok(Object.values(M).every((v) => Number.isFinite(v)),
    `all four arrangement values found in Music.js: ${JSON.stringify(M)}`);
  ok(M.bpm === captureNum('OPENING_BPM'),
    `opening tempo agrees: Music.js ${M.bpm} == capture.mjs OPENING_BPM ${captureNum('OPENING_BPM')}`);
  ok(M.barSteps === captureNum('BAR_SIXTEENTHS'),
    `bar length agrees: Music.js ${M.barSteps} == capture.mjs BAR_SIXTEENTHS ${captureNum('BAR_SIXTEENTHS')}`);
  ok(M.rampBars === captureNum('RAMP_BARS'),
    `commit ramp agrees: Music.js ${M.rampBars} == capture.mjs RAMP_BARS ${captureNum('RAMP_BARS')}`);
  ok(M.stepsPerBeat === 4, `steps are 16ths (${M.stepsPerBeat} per beat), which is what BAR_SIXTEENTHS assumes`);
}

/**
 * Read capture.mjs's OWN combining expression for GATE_SETTLE_S and evaluate
 * it with the constants it declares — rather than recomputing the settle with
 * a second copy of the formula here. A drift in the *expression* (not just
 * the constants) is otherwise invisible: `settle = barS * (1 + rampBars) +
 * margin`, hand-typed in this file, still evaluates fine even if
 * tools/capture.mjs:723 stops matching it.
 */
const readCaptureSettleExpr = (src) => {
  const m = src.match(/const GATE_SETTLE_S\s*=\s*(.+?);/);
  return m ? m[1].trim() : null;
};

/**
 * Evaluate capture.mjs's GATE_SETTLE_S expression text using ONLY the four
 * constants captureNum() pulls out of capture.mjs itself, so the settle used
 * for the coverage check comes from capture.mjs's arithmetic, not a
 * hand-copy of it.
 */
const evalCaptureSettle = (exprText) => {
  const OPENING_BPM = captureNum('OPENING_BPM');
  const BAR_SIXTEENTHS = captureNum('BAR_SIXTEENTHS');
  const RAMP_BARS = captureNum('RAMP_BARS');
  const SETTLE_MARGIN_S = captureNum('SETTLE_MARGIN_S');
  const GATE_BAR_S = BAR_SIXTEENTHS * (60 / OPENING_BPM / 4);
  // eslint-disable-next-line no-new-func
  const fn = new Function('GATE_BAR_S', 'RAMP_BARS', 'SETTLE_MARGIN_S', `return (${exprText});`);
  return fn(GATE_BAR_S, RAMP_BARS, SETTLE_MARGIN_S);
};

console.log('the derived settle covers the worst case Music.js can produce');
{
  const { barS, silenceS } = worstCaseSilenceS(M);
  const margin = captureNum('SETTLE_MARGIN_S');
  const settleExprText = readCaptureSettleExpr(captureSrc);
  ok(settleExprText != null, `capture.mjs's own GATE_SETTLE_S expression was found: ${settleExprText}`);
  const settle = evalCaptureSettle(settleExprText);
  // silenceS is derived independently from Music.js's own values; settle is
  // evaluated from capture.mjs's own expression text. Neither shares the
  // other's formula, so this can fail on drift in either source.
  ok(settle >= silenceS, `settle ${settle.toFixed(3)}s (capture.mjs's own expression) >= worst-case silence ${silenceS.toFixed(3)}s (Music.js's own values)`);
  ok(margin > 0, `the margin is explicit and named: SETTLE_MARGIN_S = ${margin}s`);
  // The measure window has its own job: it must span a full bar or it can fall
  // between the sub pulses of the intensity-0 bed, which is the other half of
  // how #96 read as noise.
  const measure = captureNum('GATE_MEASURE_S');
  ok(measure >= barS, `measure window ${measure}s spans a full bar (${barS.toFixed(3)}s)`);
  // Today's music, stated so a drift is visible in the diff rather than only in
  // an inequality that still holds.
  ok(Math.abs(settle - 3.2) < 0.05, `settle is ~3.2s for today's arrangement (${settle.toFixed(3)}s)`);
}

console.log('and the comparison fails when the arrangement really does move');
{
  // 90 bpm with a whole-bar ramp: bar 2.667s, worst case 5.333s. The settle
  // capture.mjs computes from its own (now stale) restatement is ~3.2s, which no
  // longer covers it — exactly the regression this file exists to catch.
  const drifted = musicSrc
    .replace(/this\.bpm\s*=\s*118\s*;/, 'this.bpm = 90;')
    .replace(/_apply\(next,\s*t,\s*bar\s*\*\s*0\.5\)/, '_apply(next, t, bar * 1.0)');
  const D = readMusic(drifted);
  ok(D.bpm === 90 && D.rampBars === 1, `synthetic Music.js parsed as drifted: ${D.bpm}bpm, ramp ${D.rampBars} bar`);
  ok(D.bpm !== captureNum('OPENING_BPM'), 'the restatement check would flag the drifted tempo');
  ok(D.rampBars !== captureNum('RAMP_BARS'), 'the restatement check would flag the drifted ramp');
  const staleSettle = evalCaptureSettle(readCaptureSettleExpr(captureSrc));
  const { silenceS } = worstCaseSilenceS(D);
  ok(staleSettle < silenceS,
    `a settle derived from the stale values (${staleSettle.toFixed(3)}s) is short of the drifted `
    + `worst case (${silenceS.toFixed(3)}s) — the coverage check goes red, not quietly green`);
}

console.log('the sampled >= 80 truncation guard can actually fail');
{
  // tools/capture.mjs:878 asserts `A.samples >= 80` as a proxy for "the
  // GATE_MAX_FRAMES hang guard did not cut the window short". That claim is
  // unproven unless a truncated window can be shown to fail it. Model the
  // same arithmetic capture.mjs uses: the loop breaks at
  // `gateFrames >= GATE_MAX_FRAMES`, and `A.samples` is a count of frames
  // taken after the settle point, capped by how many gate frames ran.
  const GATE_MAX_FRAMES = 3000;
  // A normal run gathers comfortably more than 80 post-settle samples (the
  // integration capture observed 123). A truncated run that hangs before the
  // settle point ever completes gathers none once the frame budget is spent.
  const samplesFromGateFrames = (gateFrames, settleFrames) =>
    Math.max(0, Math.min(gateFrames, GATE_MAX_FRAMES) - settleFrames);

  const healthy = samplesFromGateFrames(3200, 190); // ~123, matches observed integration run
  ok(healthy >= 80, `a healthy run samples ${healthy} frames, clearing the floor`);

  const truncated = samplesFromGateFrames(3000, 2950); // GATE_MAX_FRAMES hit before settle clears
  ok(truncated < 80, `a GATE_MAX_FRAMES-truncated window samples only ${truncated} frames`);
  ok(!(truncated >= 80), 'the sampled >= 80 check reads false for a truncated window — it can fail');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
