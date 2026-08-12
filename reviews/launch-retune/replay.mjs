/**
 * The gate replay behind this directory's sensitivity table — committed rather
 * than described, because the table's one load-bearing assumption is invisible
 * in its numbers.
 *
 * Both the baseline (`reviews/round9/juice-probe.json`, c6795cb) and the after
 * record (`juice-probe-after.json`) carry `raw[].kills` in emission order with
 * `frac` and `isElite` per kill, which is exactly the input
 * `LaunchGate.shouldLaunch` takes. So the shipped rule can be re-run over a
 * recorded kill stream and its launch count compared to what the live game
 * counted through the wrapped `VFX.corpseLaunch`.
 *
 * ## The ring-reset convention, which changes the answer
 *
 * `VFX._overkillRecent` is allocated once (`src/systems/VFX.js:204`) and never
 * reset, and the probe runs both arms on **one page**. So the live `late` arm
 * opens with `mid`'s last 32 fractions still in the window — tiny numbers, so a
 * low p70, so `late`'s first ~24 kills pass almost free until the window has
 * refilled with late-run fractions. Two models, and only one of them is the
 * measurement:
 *
 *   carried  one ring across both arms — what the probe actually ran.
 *   fresh    a ring per arm — what a single-fixture run, or a real session
 *            that only ever has one damage profile, would see.
 *
 * Records written before `isBoss` was added to the probe's kill recorder
 * (tools/juiceprobe.mjs) carry no `isBoss` field and replay every kill as a
 * non-boss, ordinary kill — this does not affect either committed record,
 * since both fixtures contain zero bosses.
 *
 * Run: node reviews/launch-retune/replay.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE, shouldLaunch } from '../../src/systems/LaunchGate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FLOOR = 0.35;
const load = async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8'));

/** Replay one record. `carried` = one ring across all arms, as the game runs. */
function replay(record, percentile, carried) {
  const gate = { ...GATE, percentile };
  let ring = [];
  return record.raw.map((a) => {
    if (!carried) ring = [];
    let launched = 0;
    for (const k of a.kills) {
      if (shouldLaunch(k.frac, ring, FLOOR, !!k.isElite, gate)) launched++;
      ring.push(k.frac);
      if (ring.length > gate.window) ring.shift();
    }
    return { arm: a.arm, launched, sample: a.kills.length,
      frac: +(launched / a.kills.length).toFixed(4) };
  });
}

const baseline = await load('reviews/round9/juice-probe.json');
const after = await load('reviews/launch-retune/juice-probe-after.json');
const PS = [0.60, 0.65, 0.70, 0.75, 0.80];
const row = (rs) => rs.map((r) => `${r.arm} ${r.launched}/${r.sample} = ${r.frac}`).join('   ');

console.log(`GATE = ${JSON.stringify(GATE)}, floor ${FLOOR}\n`);
for (const model of ['carried', 'fresh']) {
  console.log(`--- percentile sweep over the c6795cb baseline stream, ring model: ${model}`);
  for (const p of PS) console.log(`  p=${p.toFixed(2)}  ${row(replay(baseline, p, model === 'carried'))}`);
  console.log('');
}

// The check that makes the record re-derivable: the shipped percentile, the
// carried ring, the after record's own kill stream, against what the live
// wrapped `corpseLaunch` counted.
console.log('--- shipped percentile against the after record\'s own counters');
for (const model of ['carried', 'fresh']) {
  const rs = replay(after, GATE.percentile, model === 'carried');
  for (const r of rs) {
    const rec = after.arms.find((s) => s.arm === r.arm)?.overkill?.launchedCount;
    const mark = model === 'carried' ? (r.launched === rec ? 'EXACT' : 'MISMATCH') : '';
    console.log(`  ${model.padEnd(8)} ${r.arm}: replay ${r.launched}, recorded ${rec}  ${mark}`);
  }
}
