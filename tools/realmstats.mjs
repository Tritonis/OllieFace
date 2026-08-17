/**
 * Is a side realm ever a real choice? (issue #38)
 *
 *   node tools/realmstats.mjs reviews/runs/telluric-runs-2026-08-17.json
 *   node tools/realmstats.mjs export.json --json
 *
 * Reads one or more run exports — the file the Export button drops, or a bare
 * array of records — and prints the numbers the issue asks for: offer rate,
 * acceptance rate, mean realm duration, items gained, post-realm win rate and
 * time to the next stage, broken down by realm, by build, by corruption band
 * and by difficulty.
 *
 * It is a reader, not a probe: no port, no browser, no engine. All of the
 * arithmetic lives in `lib/realm-stats.mjs` and is covered by
 * `tests/realm-stats.test.mjs`, because a silently miscomputed acceptance rate
 * is the input to a balance change.
 *
 * The last line is the verdict against the issue's own rule — acceptance above
 * roughly 75% regardless of build or run state means the detour costs nothing
 * to take and needs a price. It will say NO VERDICT rather than guess.
 */
import { readFileSync } from 'node:fs';
import { summarise, verdict } from './lib/realm-stats.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const paths = args.filter((a) => !a.startsWith('--'));

if (!paths.length) {
  console.error('usage: node tools/realmstats.mjs <export.json> [more.json ...] [--json]');
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
const call = verdict(report);

if (asJson) {
  console.log(JSON.stringify({ ...report, verdict: call }, null, 2));
  process.exit(0);
}

const pct = (v) => (v === null ? '   --' : `${(v * 100).toFixed(0).padStart(4)}%`);
const sec = (v) => (v === null ? '    --' : `${v.toFixed(1).padStart(5)}s`);
const dec = (v) => (v === null ? '   --' : v.toFixed(2).padStart(5));

function table(title, buckets) {
  console.log(`\n${title}`);
  console.log('  bucket                      offers  takeable  visits  accept  dur    items  ->next  win');
  for (const [name, b] of Object.entries(buckets)) {
    console.log(
      `  ${name.slice(0, 26).padEnd(26)}  ${String(b.offers).padStart(6)}  `
      + `${String(b.eligibleOffers).padStart(8)}  ${String(b.visits).padStart(6)}  `
      + `${pct(b.acceptance)}  ${sec(b.meanDuration)} ${dec(b.meanItems)}  ${sec(b.meanTimeToNextStage)}  ${pct(b.postRealmWinRate)}`);
  }
}

console.log(`\nSide-realm acceptance (issue #38) — ${report.runs} run(s), ${report.stages} stage(s)`);
if (report.staleRuns) {
  console.log(`  WARNING: ${report.staleRuns} run(s) predate record version 2 and carry no gold at`);
  console.log('           offer time, so affordability — half the decided denominator — is unknown');
  console.log('           for their priced gateways. Those offers are counted as unclassifiable.');
}
console.log(`  offer rate: ${report.offerRate === null ? '--' : report.offerRate.toFixed(2)} detour offers per stage`);
console.log(`  denominator: offers the player could actually take (affordable, realm not already used)`);

table('overall', { 'all detours': report.overall });
table('by realm', report.byRealm);
table('by build', report.byBuild);
table('by corruption band at offer', report.byBand);
table('by difficulty', report.byDifficulty);

console.log(`\nVERDICT: ${call.verdict}`);
console.log(`  ${call.why}`);
if (call.verdict === 'NO TENSION') {
  console.log('  Candidate costs, in the issue\'s order of preference: corruption-specific entry');
  console.log('  costs, forfeited teleporter rewards, route locks, reduced repeat frequency.');
}
