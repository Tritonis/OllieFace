// tools/gates.mjs — the local gate runner.
//
//   npm run gates:cheap    npm test, a production build, npm audit   (~2 min)
//   npm run gates:heavy    gate:sp, gate:mp1, gate:elite, serial     (~6 min)
//   npm run gates:status   the staleness report alone, runs nothing
//
// WHY THIS EXISTS (issue #82). Every gate in CLAUDE.md was a *remembered* gate:
// there was no single command that ran the cheap ones, and nothing that said
// which heavy ones were overdue. The value of the staleness record below is not
// that it runs anything — it is knowing that `gate:elite` has not run in nine
// days.
//
// WHY NOT CI. GitHub Actions was considered and rejected: the repo is private
// (billed minutes), and the gates that matter are Windows/GPU/Steam-bound —
// `gate:mp1` drives two Chromium pages under the d3d11 ANGLE backend
// (`tools/coopprobe.mjs`), and `smoke:steam` needs a live logged-in Steam
// client. A hosted Linux runner can run none of them. This is a command a human
// chooses to run; it installs no hooks and touches no `.github/`.

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ---------------------------------------------------------------------------
// Ports
//
// All three heavy arms run through `tests/sp-equivalence.mjs`, which defaults
// to 5209. Run serially they would still be fine, but two *worktrees* running
// the heavy tier at once collide on it, and the loser fails in a way that reads
// as a bug in its own branch — that cost two agents a diagnosis cycle each
// (#68). So every heavy arm is handed an explicit port, and the runner never
// relies on sp-equivalence's own default.
//
// These are the SHIPPED defaults, claimed by this file and enforced unique by
// `tests/probe-ports.test.mjs`. Nothing else in `tools/` or `tests/` claims
// above 5233, and the 5240-5269 lane blocks in CLAUDE.md are reserved for
// parallel agent lanes, so 5234-5236 is the free window between them.
// `--port-base N` shifts all three: a lane C agent runs `--port-base 5260`.
const GATE_SP_PORT = 5234;
const GATE_MP1_PORT = 5235;
const GATE_ELITE_PORT = 5236;
const DEFAULT_PORT_BASE = GATE_SP_PORT;

// ---------------------------------------------------------------------------
// npm audit policy
//
// Threshold: fail on **high and critical**, ignore moderate and below.
//
// Picked against what this repo actually reports rather than in the abstract.
// Today `npm audit` finds exactly one advisory: GHSA-2v37-7h3g-55p8, high, on
// `nanoid <3.3.18`, reached only as postcss's dependency inside vite — a
// devDependency, used at build time, never shipped. A threshold of `moderate`
// would add nothing here and would be the first thing to go red on unrelated
// tooling churn; `critical` would have let a real high through. `high` is the
// line at which a finding is worth stopping a commit for.
//
// The allowlist is what keeps this from becoming permanent red — the failure
// mode this arm has to avoid is training people to ignore the runner. An entry
// in `gates.audit-allow.json` suppresses one advisory, and every entry carries
// a `reviewBy` date. **An expired entry fails the arm**, with a message naming
// it. That is deliberate: an allowlist without an expiry is just a mute button,
// and the whole point of this runner is that nothing important goes quiet.
const AUDIT_FAIL_SEVERITIES = new Set(['high', 'critical']);
const AUDIT_ALLOWLIST = join(root, 'gates.audit-allow.json');

// ---------------------------------------------------------------------------
// smoke:steam is excluded BY CONSTRUCTION
//
// `npm run smoke:steam` needs a running, logged-in Steam client, and its
// network-impairment settings are GLOBAL to the Steam library — a second run
// corrupts the first regardless of ports or worktrees, so it can never be part
// of a batch that something else might also be running. It is also the one gate
// a person must be sitting in front of.
//
// A comment saying "we don't run it" would not be enough. The exclusion is a
// structural property in three parts:
//
//   1. No arm in ARMS names it. (Necessary, not sufficient — a table is edited.)
//   2. `assertNoSteam` runs over the full argv of EVERY arm immediately before
//      spawn, and throws. There is no code path from this file to a child
//      process whose command line mentions Steam, whatever the table says.
//   3. `tests/gates.test.mjs` asserts both — including that the guard throws on
//      a synthetic steam-bearing arm, so it cannot pass while blind.
//
// The tier prints a reminder that the gate exists. Printing is the entire
// interaction this runner is allowed to have with it.
const FORBIDDEN_ARM = /steam/i;

/** Throws unless every token of the arm's command line is Steam-free. */
export function assertNoSteam(arm) {
  const tokens = [arm.id, ...arm.argv];
  const bad = tokens.find((t) => FORBIDDEN_ARM.test(String(t)));
  if (bad !== undefined) {
    throw new Error(
      `gates: refusing to run arm "${arm.id}" — its command line contains ${JSON.stringify(bad)}.\n`
      + '  Steam-driven gates are excluded from every tier by construction: `smoke:steam`\n'
      + '  needs a live logged-in client and sets library-global impairment. Run it by hand.',
    );
  }
}

// ---------------------------------------------------------------------------
// Manual arms — tracked, never runnable by a tier
//
// `smoke:steam` is invisible to `gates:status` by construction: it names no
// arm at all, so the staleness report can never ask about it. That is right
// for Steam (nobody should mistake it for a thing this file schedules), but
// it is the wrong shape for `npm run shots` (the capture/silhouette gate,
// `tools/capture.mjs`) — that one SHOULD be able to go OVERDUE, because
// nothing else exercises the separation/margin logic in `src/core/Harness.js`
// (installHarness itself is also exercised by sp-equivalence's `?harness=1`
// boot and by `tools/verify-trickle.mjs`). A gate nobody is ever told is stale is a gate people
// learn to ignore.
//
// So a manual arm is a full member of ARMS — it appears in the staleness
// report and can read OVERDUE — but is marked `manual: true` in its own
// definition, which is the single source of truth two things read:
//
//   1. `armsFor(tier)`'s filter (`a.tier === tier`) already excludes it,
//      since its tier is `'manual'`, not `'cheap'` or `'heavy'`.
//   2. `assertManual`, mirroring `assertNoSteam`, runs immediately before
//      every spawn in `runArm` and throws on any arm carrying `manual: true`
//      — so a future edit that mis-tiers a manual arm into `'cheap'` or
//      `'heavy'` still cannot spawn it. Two independent reasons it cannot
//      run, exactly the "not sufficient alone" shape `assertNoSteam` uses.
export function assertManual(arm) {
  if (arm.manual) {
    throw new Error(
      `gates: refusing to run arm "${arm.id}" — it is a manual-only arm.\n`
      + '  It is tracked for staleness but never invoked by a tier: run it by hand\n'
      + `  (${arm.argv.join(' ')}), then record it with:\n`
      + `    node tools/gates.mjs status --record ${arm.id}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The arm table

/**
 * Heavy arms shell out to the `gate:*` scripts rather than restating their
 * arguments, so the baseline paths stay defined in exactly one place
 * (package.json) and cannot drift out of sync with what a human runs by hand.
 * `--` forwards the port through npm to sp-equivalence's own `--port` flag.
 */
function armsFor(portBase) {
  const sp = portBase;
  const mp1 = portBase + (GATE_MP1_PORT - GATE_SP_PORT);
  const elite = portBase + (GATE_ELITE_PORT - GATE_SP_PORT);
  return Object.freeze([
    {
      id: 'test',
      tier: 'cheap',
      label: 'npm test — every tests/*.test.mjs',
      argv: ['npm', 'test'],
      paths: ['src', 'tests', 'tools'],
    },
    {
      id: 'build',
      tier: 'cheap',
      label: 'vite production build',
      argv: ['npm', 'run', 'build'],
      paths: ['src', 'index.html', 'vite.config.js', 'package.json'],
    },
    {
      id: 'audit',
      tier: 'cheap',
      label: 'npm audit — high and critical, minus the dated allowlist',
      argv: ['npm', 'audit', '--json'],
      paths: ['package.json', 'package-lock.json', 'gates.audit-allow.json'],
      custom: auditArm,
    },
    {
      id: 'gate:sp',
      tier: 'heavy',
      label: `single-player equivalence baseline (port ${sp})`,
      argv: ['npm', 'run', 'gate:sp', '--', '--port', String(sp)],
      paths: ['src', 'tests/sp-equivalence.mjs'],
    },
    {
      id: 'gate:mp1',
      tier: 'heavy',
      label: `co-op host roster-of-one equivalence (port ${mp1})`,
      argv: ['npm', 'run', 'gate:mp1', '--', '--port', String(mp1)],
      paths: ['src', 'tests/sp-equivalence.mjs'],
    },
    {
      id: 'gate:elite',
      tier: 'heavy',
      label: `elite-dps equivalence baseline (port ${elite})`,
      argv: ['npm', 'run', 'gate:elite', '--', '--port', String(elite)],
      paths: ['src', 'tests/sp-equivalence.mjs'],
    },
    {
      id: 'capture',
      tier: 'manual',
      manual: true,
      label: 'headed GPU silhouette/separation capture (npm run shots) — run by hand, tracked so it can go OVERDUE',
      argv: ['npm', 'run', 'shots'],
      paths: ['src/core/Harness.js', 'tools/capture.mjs', 'tools/lib/evidence.mjs'],
    },
    {
      id: 'trickle',
      tier: 'manual',
      manual: true,
      label: 'trickle-ICE real-join timing probe (npm run probe:trickle) — run by hand, tracked so it can go OVERDUE',
      argv: ['npm', 'run', 'probe:trickle'],
      paths: ['tools/verify-trickle.mjs', 'src/net', 'src/core/Harness.js'],
    },
    {
      id: 'perf',
      tier: 'manual',
      manual: true,
      label: 'headed GPU combat-24 frame-time record (node tools/perf.mjs --out reviews/asset-budget/perf-combat24.json) — run by hand, tracked so it can go OVERDUE',
      argv: ['node', 'tools/perf.mjs', '--out', 'reviews/asset-budget/perf-combat24.json'],
      paths: ['src', 'tools/perf.mjs'],
    },
  ]);
}

export const ARMS = armsFor(DEFAULT_PORT_BASE);

// ---------------------------------------------------------------------------
// The staleness record
//
// Gitignored: it is a fact about this machine and this checkout, not about the
// code, and committing it would conflict on every merge.
const STATE_FILE = join(root, '.gates', 'state.json');

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { arms: {} }; }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function recordRun(armId, verdict, durationMs) {
  const state = readState();
  state.arms ??= {};
  state.arms[armId] = {
    at: new Date().toISOString(),
    verdict,
    durationMs,
    commit: gitOut(['rev-parse', 'HEAD']) || null,
  };
  writeState(state);
}

function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/** ISO time of the newest commit touching any of `paths`, or '' if none. */
function lastCommitTouching(paths) {
  const present = paths.filter((p) => existsSync(join(root, p)));
  if (!present.length) return '';
  return gitOut(['log', '-1', '--format=%cI', '--', ...present]);
}

const DAY = 86_400_000;

/**
 * One line per arm: when it last ran, what it said, and whether a commit has
 * touched its inputs since. "Stale" here means *the code moved under it*, which
 * is a sharper question than "how long ago" — a gate that ran a month ago
 * against a file nobody has touched since is still telling the truth.
 */
export function stalenessReport(arms, state = readState()) {
  const now = Date.now();
  return arms.map((arm) => {
    const rec = state.arms?.[arm.id];
    const touched = lastCommitTouching(arm.paths);
    const ranAt = rec?.at ? Date.parse(rec.at) : null;
    const touchedAt = touched ? Date.parse(touched) : null;
    const stale = ranAt === null || (touchedAt !== null && touchedAt > ranAt);
    return {
      id: arm.id,
      tier: arm.tier,
      verdict: rec?.verdict ?? null,
      ageDays: ranAt === null ? null : (now - ranAt) / DAY,
      stale,
      reason: ranAt === null
        ? 'never run in this checkout'
        : stale
          ? `code touched ${((now - touchedAt) / DAY).toFixed(1)}d ago, last run ${((now - ranAt) / DAY).toFixed(1)}d ago`
          : `last run ${((now - ranAt) / DAY).toFixed(1)}d ago`,
    };
  });
}

function printStaleness(arms) {
  const manualIds = new Set(arms.filter((a) => a.manual).map((a) => a.id));
  console.log('\n--- gate staleness -------------------------------------------------');
  for (const r of stalenessReport(arms)) {
    const mark = r.stale ? 'OVERDUE' : r.verdict === 'pass' ? 'ok     ' : r.verdict === 'fail' ? 'RED    ' : '?      ';
    const tag = manualIds.has(r.id) ? ' (manual — run by hand, then: gates.mjs status --record ' + r.id + ')' : '';
    console.log(`  ${mark} ${r.id.padEnd(10)} ${r.reason}${tag}`);
  }
  console.log('  (not run by any tier: smoke:steam — needs a live Steam client, run it by hand)');
  console.log('--------------------------------------------------------------------\n');
}

/** Records a hand-run of a manual arm. Refuses anything not marked `manual`. */
export function recordManualRun(arms, armId) {
  const arm = arms.find((a) => a.id === armId);
  if (!arm) throw new Error(`gates: unknown arm "${armId}"`);
  if (!arm.manual) throw new Error(`gates: "${armId}" is not a manual arm — it is run (and recorded) by its own tier.`);
  recordRun(arm.id, 'pass', 0);
  return arm;
}

// ---------------------------------------------------------------------------
// The audit arm

function auditArm() {
  // `npm audit` exits non-zero whenever anything is found, at any severity, so
  // its exit code is not the verdict — the parsed report is.
  const r = spawnSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', shell: true });
  let report;
  try { report = JSON.parse(r.stdout); } catch {
    console.error(r.stdout || r.stderr);
    return { ok: false, detail: 'npm audit produced output that is not JSON' };
  }

  let allow = { advisories: {} };
  if (existsSync(AUDIT_ALLOWLIST)) allow = JSON.parse(readFileSync(AUDIT_ALLOWLIST, 'utf8'));

  const now = Date.now();
  const blocking = [];
  const suppressed = [];
  const expired = [];

  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    if (!AUDIT_FAIL_SEVERITIES.has(v.severity)) continue;
    for (const via of v.via ?? []) {
      if (typeof via === 'string') continue;           // an indirect "via <pkg>" edge
      if (!AUDIT_FAIL_SEVERITIES.has(via.severity)) continue;
      const key = via.url || String(via.source);
      const id = key.split('/').pop();
      const entry = allow.advisories?.[id] ?? allow.advisories?.[key];
      const line = `${via.severity.toUpperCase()} ${pkg}: ${via.title} (${key})`;
      if (!entry) { blocking.push(line); continue; }
      if (!entry.reviewBy || Date.parse(entry.reviewBy) < now) {
        expired.push(`${id} — allowlist entry expired ${entry.reviewBy ?? '(no reviewBy set)'}: ${entry.reason ?? ''}`);
      } else {
        suppressed.push(`${id} (allowlisted until ${entry.reviewBy}) — ${entry.reason ?? ''}`);
      }
    }
  }

  const m = report.metadata?.vulnerabilities ?? {};
  console.log(`  npm audit: ${m.critical ?? 0} critical, ${m.high ?? 0} high, ${m.moderate ?? 0} moderate, ${m.low ?? 0} low`);
  for (const s of suppressed) console.log(`  allowlisted: ${s}`);
  for (const b of blocking) console.log(`  BLOCKING:    ${b}`);
  for (const e of expired) console.log(`  EXPIRED:     ${e}`);

  if (blocking.length || expired.length) {
    return {
      ok: false,
      detail: expired.length
        ? `${expired.length} allowlist entr${expired.length === 1 ? 'y has' : 'ies have'} expired and must be re-reviewed`
        : `${blocking.length} unallowlisted high/critical advisor${blocking.length === 1 ? 'y' : 'ies'}`,
    };
  }
  return { ok: true, detail: `no unallowlisted high/critical advisories (${suppressed.length} allowlisted)` };
}

// ---------------------------------------------------------------------------
// Running

function runArm(arm) {
  assertNoSteam(arm);                       // (2) above — every arm, every time.
  assertManual(arm);                        // manual arms are tracked, never spawned.
  console.log(`\n=== ${arm.id} — ${arm.label}`);
  console.log(`    ${arm.argv.join(' ')}`);
  const started = Date.now();
  let result;
  if (arm.custom) {
    result = arm.custom();
  } else {
    const [cmd, ...args] = arm.argv;
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
    result = { ok: r.status === 0, detail: `exit code ${r.status ?? 'signal ' + r.signal}` };
  }
  const durationMs = Date.now() - started;
  recordRun(arm.id, result.ok ? 'pass' : 'fail', durationMs);
  console.log(`--- ${arm.id}: ${result.ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s) — ${result.detail}`);
  return { ...result, durationMs };
}

// ---------------------------------------------------------------------------
// The heavy-tier lock
//
// Keyed by port base, because the port block IS the contended resource: two
// worktrees on the shipped default would fight over 5234-5236, while a lane
// agent on `--port-base 5260` is genuinely independent and must not be blocked.
// The lock lives in the OS temp dir rather than the repo, because worktrees do
// not share a `.gates/`.
function lockPath(portBase) { return join(tmpdir(), `telluric-void-gates-heavy-${portBase}.lock`); }

function acquireHeavyLock(portBase) {
  const p = lockPath(portBase);
  if (existsSync(p)) {
    let held;
    try { held = JSON.parse(readFileSync(p, 'utf8')); } catch { held = null; }
    // `kill(pid, 0)` throws for two very different reasons, and treating them
    // alike is how a lock silently stops locking: ESRCH means the holder is
    // gone, but EPERM means it is alive and merely owned by another user or a
    // higher-integrity token — routine on Windows. Only ESRCH is death.
    let alive = false;
    if (held?.pid) {
      try { process.kill(held.pid, 0); alive = true; }
      catch (e) { alive = e?.code !== 'ESRCH'; }
    }
    if (alive) {
      console.error(
        `\ngates:heavy REFUSED — ports ${portBase}-${portBase + 2} are already claimed by another run.\n`
        + `  pid ${held.pid}, started ${held.at}\n`
        + `  in  ${held.cwd}\n`
        + '  The three heavy gates all bind sp-equivalence\'s dev-server port; a second run\n'
        + '  would lose the bind and fail in a way that reads as a bug in its own branch (#68).\n'
        + `  Give this run its own block:  npm run gates:heavy -- --port-base ${portBase + 20}\n`,
      );
      process.exit(2);
    }
    console.log(`  (clearing a stale heavy lock left by dead pid ${held?.pid})`);
  }
  writeFileSync(p, JSON.stringify({ pid: process.pid, cwd: root, at: new Date().toISOString() }));
  return () => { try { unlinkSync(p); } catch { /* already gone */ } };
}

// ---------------------------------------------------------------------------

function main(argv) {
  const tier = argv[0];
  if (!['cheap', 'heavy', 'status'].includes(tier)) {
    console.error('usage: node tools/gates.mjs <cheap|heavy|status> [--port-base N]');
    console.error('       node tools/gates.mjs status --record <armId>   (record a hand-run of a manual arm)');
    return 64;
  }
  const i = argv.indexOf('--port-base');
  const portBase = Number(i >= 0 ? argv[i + 1] : (process.env.GATES_PORT_BASE ?? DEFAULT_PORT_BASE));
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65_530) {
    console.error(`gates: --port-base must be an integer in 1024-65530, got ${portBase}`);
    return 64;
  }

  const all = armsFor(portBase);

  const recordIdx = argv.indexOf('--record');
  if (recordIdx >= 0) {
    if (tier !== 'status') {
      console.error('gates: --record is only valid with the "status" command');
      return 64;
    }
    const armId = argv[recordIdx + 1];
    try {
      const arm = recordManualRun(all, armId);
      console.log(`gates: recorded a manual run of "${arm.id}" at ${new Date().toISOString()}`);
    } catch (e) {
      console.error(e.message);
      return 64;
    }
  }

  printStaleness(all);
  if (tier === 'status') return 0;

  const arms = all.filter((a) => a.tier === tier);
  const release = tier === 'heavy' ? acquireHeavyLock(portBase) : () => {};

  // Fail fast, in order: there is no value in building a tree whose tests are
  // red, and the summary below is more useful when it names one arm.
  const results = [];
  let failed = null;
  try {
    for (const arm of arms) {
      if (failed) { results.push({ id: arm.id, status: 'SKIPPED' }); continue; }
      const r = runArm(arm);
      results.push({ id: arm.id, status: r.ok ? 'PASS' : 'FAIL', detail: r.detail });
      if (!r.ok) failed = { arm, detail: r.detail };
    }
  } finally { release(); }

  console.log(`\n====================================================================`);
  for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
  if (failed) {
    // The point of this line: the last tool's stderr tells you a test failed,
    // not which ARM of which tier owns it.
    console.log(`\n  GATES ${tier.toUpperCase()}: FAILED`);
    console.log(`  FAILING ARM: ${failed.arm.id} — ${failed.arm.label}`);
    console.log(`  ${failed.detail}`);
    console.log(`  reproduce: ${failed.arm.argv.join(' ')}`);
    console.log(`====================================================================\n`);
    return 1;
  }
  console.log(`\n  GATES ${tier.toUpperCase()}: PASSED (${results.length}/${results.length} arms)`);
  console.log(`====================================================================\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
