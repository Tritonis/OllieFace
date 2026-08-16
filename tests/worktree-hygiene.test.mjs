// tests/worktree-hygiene.test.mjs
//
// Issue #90: 28 stale worktrees under .claude/worktrees/ once made vite serve
// a single CSS file in 79.9s, which blew `npm run shots`'s goto timeout 3/3
// (tools/capture.mjs:337 at the time). Nine of those worktrees held directory
// JUNCTIONS into the main checkout's node_modules — a recursive delete run
// against one of those walks the junction and deletes the main tree's
// packages, which is the best explanation on record for issues #67 and #83.
//
// This is a cheap-tier static check (runs inside `npm test`, so it's part of
// `gates:cheap`) that fails loud on the two shapes of accumulation that
// caused that incident:
//
//   (a) too many entries under .claude/worktrees/ — a raw count, not
//       correctness of each one. Three parallel lanes plus a verifier that
//       spins up its own worktree is the normal ceiling in this repo's
//       working mode (see CLAUDE.md "Parallel lanes"); with churn across a
//       batch (a lane finishing and a new one starting before the old one is
//       swept) that can transiently touch ~5-6. 8 gives that headroom without
//       being loose enough to miss real accumulation — the incident this
//       guards against was 28.
//
//   (b) an ORPHANED node_modules junction: a directory under
//       .claude/worktrees/ that (i) is not a registered git worktree
//       (`git worktree list`) AND (ii) still holds a node_modules reparse
//       point targeting the main repo's node_modules. A *live*, registered
//       worktree legitimately holds such a junction for its lifetime (see
//       CLAUDE.md) — this only fires once a worktree has been removed from
//       git's registry (or never was one) but its directory, and the
//       junction inside it, were left behind. That is exactly the shape that
//       makes a later recursive delete of "just cleaning up a stale
//       directory" catastrophic.
//
// The core of each check is factored out to take a directory path so it can
// be red/green tested against a disposable fixture in the OS temp dir,
// without ever writing into the real .claude/worktrees/ (writing into the
// main checkout from a worktree-isolated agent is out of bounds here).
//
// Skip condition: this check inspects the MAIN checkout's .claude/worktrees/.
// Running it from inside a worktree would either inspect the wrong directory
// or (worse) construct a path that doesn't exist there at all, so it is a
// loud SKIP — not a silent pass — whenever `git rev-parse --git-common-dir`
// shows we are not sitting in the main checkout.

import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/**
 * Registered worktree directories (absolute, normalized), from `git
 * worktree list --porcelain` run against `cwd`.
 */
function registeredWorktrees(cwd) {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
  const dirs = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dirs.push(resolve(line.slice('worktree '.length).trim()));
  }
  return dirs;
}

/**
 * Core of check (a): does `worktreesDir` hold more than `limit` entries.
 * Takes a plain directory path so it can be pointed at a scratch fixture.
 */
function countCheck(worktreesDir, limit) {
  if (!existsSync(worktreesDir)) return { count: 0, over: false, entries: [] };
  const entries = readdirSync(worktreesDir);
  return { count: entries.length, over: entries.length > limit, entries };
}

/**
 * Core of check (b): scan `worktreesDir` for entries that are NOT in
 * `registeredDirs` but still carry a node_modules reparse point whose target
 * resolves under `mainNodeModules`. Returns the list of orphans found (empty
 * = clean). Never throws on a directory that isn't a worktree at all — a
 * stray non-worktree folder with no node_modules junction is not this bug.
 */
function orphanJunctionCheck(worktreesDir, registeredDirs, mainNodeModules) {
  const orphans = [];
  if (!existsSync(worktreesDir)) return orphans;
  const registered = new Set(registeredDirs.map((d) => resolve(d)));
  const mainTarget = existsSync(mainNodeModules) ? resolve(realpathSync(mainNodeModules)) : resolve(mainNodeModules);
  for (const entry of readdirSync(worktreesDir)) {
    const dir = resolve(join(worktreesDir, entry));
    if (registered.has(dir)) continue; // live, registered worktree: expected to hold a junction
    const nm = join(dir, 'node_modules');
    let st;
    try { st = lstatSync(nm); } catch { continue; } // no node_modules at all: not this bug
    if (!st.isSymbolicLink()) continue; // a real installed node_modules, not a junction: not this bug
    let target;
    try { target = resolve(readlinkSync(nm)); } catch { continue; }
    if (target === mainTarget) orphans.push({ dir, target });
  }
  return orphans;
}

// --- Unit tests against a scratch fixture (RED/GREEN proof) ----------------
// Never touches the real .claude/worktrees/. Junctions are created with the
// platform's directory-junction primitive so the fixture matches what a real
// stale worktree looks like.
console.log('orphanJunctionCheck: unit fixture');
{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wth-fixture-'));
  const worktreesDir = join(fixtureRoot, 'worktrees');
  const fakeMainNodeModules = join(fixtureRoot, 'main-node_modules');
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(fakeMainNodeModules, { recursive: true });

  const liveDir = join(worktreesDir, 'live-lane');
  const orphanDir = join(worktreesDir, 'orphan-lane');
  const cleanDir = join(worktreesDir, 'no-junction-lane');
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(orphanDir, { recursive: true });
  mkdirSync(cleanDir, { recursive: true });

  const isWindows = process.platform === 'win32';
  const junction = (link, targetDir) => {
    if (isWindows) {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, targetDir]);
    } else {
      // Non-Windows dev/CI fallback: a plain symlink exercises the same code
      // path (isSymbolicLink + readlink) even though real junctions are a
      // Windows-only concept.
      execFileSync('ln', ['-s', targetDir, link]);
    }
  };

  junction(join(liveDir, 'node_modules'), fakeMainNodeModules);
  junction(join(orphanDir, 'node_modules'), fakeMainNodeModules);
  // cleanDir gets no node_modules at all.

  // RED: before registering `liveDir`, both liveDir and orphanDir look orphaned.
  let orphans = orphanJunctionCheck(worktreesDir, [], fakeMainNodeModules);
  ok(orphans.length === 2, 'RED: with nothing registered, both junctioned dirs report as orphans');

  // GREEN: once liveDir is a registered worktree, only orphanDir remains flagged.
  orphans = orphanJunctionCheck(worktreesDir, [liveDir], fakeMainNodeModules);
  ok(orphans.length === 1 && orphans[0].dir === resolve(orphanDir),
    'GREEN: registering the live lane clears it, leaving only the true orphan');

  // A directory with no junction at all is never flagged, registered or not.
  orphans = orphanJunctionCheck(worktreesDir, [], fakeMainNodeModules);
  ok(!orphans.some((o) => o.dir === resolve(cleanDir)), 'a worktree dir with no node_modules junction is never flagged');

  console.log('countCheck: unit fixture');
  ok(countCheck(worktreesDir, 8).count === 3 && !countCheck(worktreesDir, 8).over, '3 entries under an 8 limit does not trip the count check');
  ok(countCheck(worktreesDir, 2).over, '3 entries over a 2 limit does trip the count check');

  rmSync(fixtureRoot, { recursive: true, force: true });
}

// --- Live check against the real repo ---------------------------------------
console.log('live check against the real .claude/worktrees/');
{
  const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const mainRoot = resolve(gitCommonDir, '..');
  const isMainCheckout = resolve(mainRoot) === resolve(repoRoot);

  if (!isMainCheckout) {
    console.log('  SKIP  running from a worktree, not the main checkout — inspecting', mainRoot, 'instead would not reflect this run; skipped by design');
  } else {
    const worktreesDir = join(mainRoot, '.claude', 'worktrees');
    const COUNT_LIMIT = 8;
    const { count, over, entries } = countCheck(worktreesDir, COUNT_LIMIT);
    if (over) console.log(`    entries under .claude/worktrees/: ${entries.join(', ')}`);
    ok(!over, `.claude/worktrees/ holds ${count} entries (limit ${COUNT_LIMIT}) — accumulation guard`);

    const registered = registeredWorktrees(mainRoot);
    const mainNodeModules = join(mainRoot, 'node_modules');
    const orphans = orphanJunctionCheck(worktreesDir, registered, mainNodeModules);
    if (orphans.length) {
      console.log('    orphaned node_modules junctions found:');
      for (const o of orphans) console.log(`      ${o.dir} -> ${o.target}`);
    }
    ok(orphans.length === 0, 'no orphaned node_modules junctions under .claude/worktrees/');
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
