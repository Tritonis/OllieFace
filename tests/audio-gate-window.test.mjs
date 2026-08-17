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

console.log('the derived settle covers the worst case Music.js can produce');
{
  const { barS, silenceS } = worstCaseSilenceS(M);
  const margin = captureNum('SETTLE_MARGIN_S');
  const settle = barS * (1 + M.rampBars) + margin;
  ok(settle >= silenceS, `settle ${settle.toFixed(3)}s >= worst-case silence ${silenceS.toFixed(3)}s`);
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
  const staleSettle = worstCaseSilenceS(M).barS * (1 + M.rampBars) + captureNum('SETTLE_MARGIN_S');
  const { silenceS } = worstCaseSilenceS(D);
  ok(staleSettle < silenceS,
    `a settle derived from the stale values (${staleSettle.toFixed(3)}s) is short of the drifted `
    + `worst case (${silenceS.toFixed(3)}s) — the coverage check goes red, not quietly green`);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
