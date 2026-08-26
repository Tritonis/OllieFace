/**
 * Does the corruption economy ask anyone anything? (issue #166)
 *
 *   node tools/alignment-report.mjs reviews/runs/telluric-runs-2026-08-23.json
 *   node tools/alignment-report.mjs export.json more.json --json
 *
 * Reads one or more run exports — the file the Export button drops, or a bare
 * array of records — and prints the alignment behaviour the audit asks after:
 * how chest offers resolved, how mutation windows resolved, and what shelf the
 * runs ended holding.
 *
 * A reader, not a probe: no port, no browser, no engine, and no clock. The
 * output body is a pure function of the records given, so the same export
 * prints byte-identical text twice — which is what lets a report be diffed
 * across a balance change rather than merely read.
 *
 * All arithmetic lives in `lib/alignment-stats.mjs`, covered by
 * `tests/alignment-stats.test.mjs`.
 */
import { readFileSync } from 'node:fs';
import { summarise, verdict, MUTATION_OUTCOMES, MIN_ALIGNMENT_VERSION } from './lib/alignment-stats.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const paths = args.filter((a) => !a.startsWith('--'));

if (!paths.length) {
  console.error('usage: node tools/alignment-report.mjs <export.json> [more.json ...] [--json]');
  process.exit(2);
}

const runs = [];
for (const p of paths) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`could not read ${p}: ${err.message}`);
    process.exit(2);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.runs;
  if (!Array.isArray(list)) {
    console.error(`${p} has no run list — expected an array or an object with a "runs" array`);
    process.exit(2);
  }
  runs.push(...list);
}

const report = summarise(runs);

if (report.scored === 0) {
  const lines = [
    `no scored runs: ${report.runs} run(s) read, 0 carry alignment evidence`,
    `  stale (pre-v${MIN_ALIGNMENT_VERSION}, no alignment fields): ${report.stale}`,
    `  remote (co-op guest, excluded on role): ${report.remote}`,
    '  a verdict needs at least one run with alignment fields, played as host or single-player',
  ];
  if (asJson) {
    console.log(JSON.stringify({ ...report, error: lines[0], detail: lines.slice(1) }, null, 2));
  } else {
    for (const l of lines) console.error(l);
  }
  process.exit(1);
}

const call = verdict(report);

if (asJson) {
  console.log(JSON.stringify({ ...report, verdict: call }, null, 2));
  process.exit(0);
}

const pct = (v) => (v === null ? '   --' : `${(v * 100).toFixed(0).padStart(4)}%`);
const n = (v) => String(v).padStart(6);

console.log(`\nAlignment behaviour (issue #166) — ${report.runs} run(s), ${report.scored} scored`);
if (report.stale) {
  console.log(`  WARNING: ${report.stale} run(s) predate record version 3 and carry no offer, mutation`);
  console.log('           or boundary-alignment fields. They are excluded rather than counted as');
  console.log('           runs in which nothing happened.');
}
if (report.remote) {
  console.log(`  EXCLUDED: ${report.remote} run(s) were played as a co-op guest. A guest's corruption is`);
  console.log('            the host\'s, replicated, and a guest opens no chests at all — averaging one');
  console.log('            in would count the host\'s run twice and sink the take rate by lobby size.');
}
if (report.offers.unknownStages) {
  console.log(`  NOTE: ${report.offers.unknownStages} stage(s) could not be swept for chests left standing;`);
  console.log('        those stages contribute to neither the numerator nor the denominator.');
}

console.log('\nchest offers');
console.log(`  taken normally (gold)     ${n(report.offers.takenNormally)}`);
console.log(`  taken corrupted (credit)  ${n(report.offers.takenCorrupted)}`);
console.log(`  left standing             ${n(report.offers.left)}`);
console.log(`  take rate                 ${pct(report.offers.takeRate)}   corrupt share of takes ${pct(report.offers.corruptShare)}`);
console.log(`  purified / salvaged       ${n(report.offers.purifiedSalvaged)}   (blight stacks bought back, counted beside the above)`);

console.log('\nmutation windows');
for (const k of MUTATION_OUTCOMES) console.log(`  ${k.padEnd(24)}  ${n(report.mutations[k])}`);
console.log(`  ${'total'.padEnd(24)}  ${n(report.mutations.total)}   explicit-choice rate ${pct(report.mutations.choiceRate)}`);

console.log('\nshelf at the last boundary');
for (const k of ['mixed', 'argent', 'blight', 'neither', 'unknown']) {
  console.log(`  ${k.padEnd(24)}  ${n(report.poles[k])}`);
}
console.log(`  ${'mixed share'.padEnd(24)}  ${pct(report.poles.mixedShare)}`);

console.log(`\nVERDICT do players still take every available reward?  ${call.rewards.verdict}`);
console.log(`  ${call.rewards.why}`);
console.log(`VERDICT do mixed inventories dominate?                 ${call.inventories.verdict}`);
console.log(`  ${call.inventories.why}`);
