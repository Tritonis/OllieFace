// tests/gates.test.mjs
//
// The exclusion of `smoke:steam` from the gate runner is a *claim*, and a claim
// that only ever gets observed passing is worth nothing here — a guard that
// reports green on the very thing it was written to catch is this repo's
// dominant defect shape. So this file does not only assert that no arm mentions
// Steam today (a table is edited, and an assertion about a table drifts with
// it); it also feeds `assertNoSteam` a synthetic Steam-bearing arm and requires
// it to throw. If the guard is ever gutted, the second half fails even while
// the first half still passes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, assertNoSteam, stalenessReport } from '../tools/gates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the tiers are the ones issue #82 asked for');
{
  const cheap = ARMS.filter((a) => a.tier === 'cheap').map((a) => a.id);
  const heavy = ARMS.filter((a) => a.tier === 'heavy').map((a) => a.id);
  ok(cheap.join(',') === 'test,build,audit', `cheap tier runs, in order: ${cheap.join(' -> ')}`);
  ok(heavy.join(',') === 'gate:sp,gate:mp1,gate:elite', `heavy tier runs, in order: ${heavy.join(' -> ')}`);
}

console.log('smoke:steam is excluded by construction');
{
  // (1) Nothing in the table names it...
  const tokens = ARMS.flatMap((a) => [a.id, ...a.argv]).map(String);
  ok(!tokens.some((t) => /steam/i.test(t)), 'no arm command line mentions steam');

  // ...and specifically none of package.json's steam-driven scripts is invoked.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const steamScripts = Object.keys(pkg.scripts).filter((s) => /steam/i.test(s));
  ok(steamScripts.length > 0, `package.json still has steam scripts to exclude: ${steamScripts.join(', ')}`);
  ok(steamScripts.every((s) => !tokens.includes(s)), 'no steam script appears in any arm');

  // (2) ...and the guard that runs before every spawn actually throws. This is
  // the half that keeps the check from passing vacuously: it demonstrates the
  // guard CAN fail, on an arm shaped exactly like the one someone would add.
  let threw = false;
  try {
    assertNoSteam({ id: 'smoke:steam', argv: ['npm', 'run', 'smoke:steam'] });
  } catch (e) { threw = /steam/i.test(e.message) && /refusing to run/.test(e.message); }
  ok(threw, 'assertNoSteam throws on an arm that names smoke:steam');

  // The token can hide anywhere in the argv, not just in the id.
  let threwNested = false;
  try {
    assertNoSteam({ id: 'sneaky', argv: ['node', 'tools/steamsmoke.mjs'] });
  } catch { threwNested = true; }
  ok(threwNested, 'assertNoSteam throws when steam is buried in the argv, not the id');

  // And it does NOT throw on the real arms — a guard that rejects everything is
  // as useless as one that rejects nothing.
  let clean = true;
  for (const a of ARMS) { try { assertNoSteam(a); } catch { clean = false; } }
  ok(clean, 'assertNoSteam passes every real arm');
}

console.log('every heavy arm carries its own explicit port');
{
  const heavy = ARMS.filter((a) => a.tier === 'heavy');
  const ports = heavy.map((a) => {
    const i = a.argv.indexOf('--port');
    return i >= 0 ? Number(a.argv[i + 1]) : null;
  });
  ok(ports.every((p) => Number.isInteger(p)), `each heavy arm passes --port: ${ports.join(', ')}`);
  ok(new Set(ports).size === ports.length, 'the heavy arms do not share a port');
  // The whole reason for the explicit ports: sp-equivalence's own default is
  // 5209 and all three gates run through it (#68).
  ok(!ports.includes(5209), 'no heavy arm falls back to the shared 5209 default');
}

console.log('the staleness report answers the question it exists for');
{
  // An arm with no recorded run is overdue — "gate:elite has not run in nine
  // days" is the output this record exists to produce.
  const empty = stalenessReport(ARMS, { arms: {} });
  ok(empty.every((r) => r.stale), 'with no state file, every arm reads as overdue');
  ok(empty.every((r) => r.reason === 'never run in this checkout'), 'and says why');

  // A run older than the last commit touching the arm's paths is stale; a run
  // newer than it is not. Both directions, so the check cannot pass by always
  // returning one answer.
  const long_ago = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const just_now = new Date().toISOString();
  const old = stalenessReport(ARMS, { arms: Object.fromEntries(ARMS.map((a) => [a.id, { at: long_ago, verdict: 'pass' }])) });
  const fresh = stalenessReport(ARMS, { arms: Object.fromEntries(ARMS.map((a) => [a.id, { at: just_now, verdict: 'pass' }])) });
  ok(old.some((r) => r.stale), 'a run predating the last commit to its paths is overdue');
  ok(fresh.every((r) => !r.stale), 'a run made after the last such commit is not');
  ok(old.every((r) => r.ageDays > 89), 'the record reports the age in days');
}

console.log('the audit allowlist is dated and reasoned');
{
  const allow = JSON.parse(readFileSync(join(root, 'gates.audit-allow.json'), 'utf8'));
  const entries = Object.entries(allow.advisories ?? {});
  ok(entries.every(([, e]) => typeof e.reviewBy === 'string' && !Number.isNaN(Date.parse(e.reviewBy))),
    `every allowlist entry carries a parseable reviewBy (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
  ok(entries.every(([, e]) => typeof e.reason === 'string' && e.reason.length > 40),
    'every allowlist entry explains why the advisory does not reach this product');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
