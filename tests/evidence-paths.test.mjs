// tests/evidence-paths.test.mjs
//
// The guard from issue #71: a probe whose output gets quoted by a document must
// not write that output somewhere git throws away.
//
// Two ratified documents cited `shots-modelkit/record.json`, a path matching
// the `shots-*/` rule in `.gitignore`, from a file that lived only in a
// disposable agent worktree. The numbers survived by luck and a hand recovery.
// These tests pin the mechanism that stops the next one.
import {
  isGitIgnored, isGitIgnoredDir, isGitIgnoredFile, resolveOutDir,
} from '../tools/lib/evidence.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('isGitIgnored reads this repo\'s actual rules');
{
  // These three are the exact shapes that mattered. `shots-modelkit` is the
  // trap; `reviews/modelkit-seam` is where the evidence was recovered to and
  // must read as safe, or the fix points somewhere no better than the problem.
  ok(isGitIgnored(join(root, 'shots-modelkit'), { asDirectory: true }) === true,
    'shots-modelkit is ignored (the trap that caused #71)');
  // The trap inside the fix. `.gitignore` says `shots-*` with a trailing slash,
  // which is directory-only, and the directory need not exist when a probe asks.
  // Without the separator git answers "not ignored" — reassuringly, and wrongly.
  // This assertion is the one that caught it.
  ok(isGitIgnored(join(root, 'shots-does-not-exist-yet'), { asDirectory: true }) === true,
    'a not-yet-created shots-* directory still reads as ignored');
  ok(isGitIgnored(join(root, 'reviews', 'modelkit-seam'), { asDirectory: true }) === false,
    'reviews/modelkit-seam is NOT ignored (the recovered, citable home)');
  ok(isGitIgnored(join(root, 'node_modules'), { asDirectory: true }) === true,
    'a plainly ignored path reads as ignored');
  ok(isGitIgnored(join(root, 'src'), { asDirectory: true }) === false,
    'a plainly tracked path reads as not ignored');
}

console.log('the two wrappers are symmetric in behaviour, not just in name');
{
  // `isGitIgnoredFile` used to pass the function's own default, so it asserted
  // nothing while its docstring claimed it did — the same "comment promises a
  // property the code lacks" defect these two issues are about. `asDirectory`
  // is a tri-state now, so each wrapper genuinely forces its reading.
  const dir = join(root, 'shots-modelkit'); // does not exist; ignored as a DIRECTORY only
  ok(isGitIgnoredDir(dir) === true, 'asked as a directory, the directory-only rule matches');
  ok(isGitIgnoredFile(dir) === false, 'asked as a file, it does not - and the pair disagree on purpose');
}

console.log('the per-file rules are finer than the per-directory ones');
{
  // Directory-level safety is not file-level safety: `reviews/**/*.png` ignores
  // captures even inside a committed review directory, with a scoped negation
  // for the crops two documents quote. A probe that checked only its --out
  // would call both of these safe.
  ok(isGitIgnored(join(root, 'reviews', 'modelkit-seam', 'crop-pair-seam.png')) === false,
    'the negated crop-*.png survives inside reviews/modelkit-seam');
  ok(isGitIgnored(join(root, 'reviews', 'modelkit-seam', '10-kit-clean.png')) === true,
    'a full frame in the same directory does not - the distinction is real');
  ok(isGitIgnored(join(root, 'reviews', 'modelkit-seam', 'record.json')) === false,
    'the record itself is committable, which is what the citations depend on');
}

console.log('resolveOutDir passes a safe path through untouched');
{
  const target = join(root, 'reviews', 'modelkit-seam');
  ok(resolveOutDir(target, { tool: 'test', citable: true }) === target,
    'a citable probe pointed at a committed directory just gets its path back');
}

console.log('an unanswerable question is not a reassuring answer');
{
  // `isGitIgnored` returns null when git cannot answer. `resolveOutDir` used to
  // early-return on `!== true`, which lumped null in with false and silently
  // disarmed the citable refusal on any machine without git on PATH — the one
  // environment least likely to notice. Checked by running the module in a
  // directory that is not a git repository at all.
  const probe = `
    import { isGitIgnored, resolveOutDir } from ${JSON.stringify(pathToFileURL(join(root, 'tools', 'lib', 'evidence.mjs')).href)};
    const unknown = isGitIgnored('anywhere', { asDirectory: true });
    let warned = false;
    const origWarn = console.warn;
    console.warn = (...a) => { warned = true; origWarn(...a); };
    resolveOutDir('anywhere', { tool: 'probe', citable: true });
    console.warn = origWarn;
    process.stdout.write(JSON.stringify({ unknown, warned }));
  `;
  const tmp = mkdtempSync(join(tmpdir(), 'no-git-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: tmp, encoding: 'utf8',
  });
  const out = /\{"unknown".*\}$/.exec(r.stdout ?? '');
  const got = out ? JSON.parse(out[0]) : null;
  ok(got?.unknown === null, 'outside a repository, the answer is null (unknown), not false');
  ok(got?.warned === true, 'a citable run warns rather than proceeding as if verified');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('kitprobe defaults to a committed location');
{
  // The specific regression: kitprobe's own default was the ignored path, so
  // the trap sprang on a bare `node tools/kitprobe.mjs` with no flags at all.
  const src = readFileSync(join(root, 'tools', 'kitprobe.mjs'), 'utf8');
  const def = /args\.out\s*\?\?\s*'([^']+)'/.exec(src);
  ok(def !== null, 'kitprobe declares an --out default');
  ok(def && isGitIgnored(join(root, def[1]), { asDirectory: true }) === false,
    `kitprobe's default --out (${def?.[1]}) is a committed location`);
  ok(/resolveOutDir/.test(src) && /citable:\s*true/.test(src),
    'kitprobe routes --out through the citable guard, so an override is checked too');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
