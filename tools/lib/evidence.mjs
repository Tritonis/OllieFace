/**
 * Where a probe is allowed to put evidence (issue #71).
 *
 * ## The failure this exists to stop
 *
 * `tools/kitprobe.mjs` wrote its record and crops to `shots-modelkit/`, which
 * matches the `shots-` wildcard rule in `.gitignore`. Two *ratified* documents —
 * `docs/ART-STYLE-GUIDE.md` and `docs/art/ASSET-SPEC.md` — then quoted the
 * 209 / 195 / 67.0 / 93.8 figures out of that record. The file existed only in
 * a disposable agent worktree and would have become unverifiable at the next
 * `git worktree prune`. It was recovered by hand into `reviews/modelkit-seam/`,
 * but the mechanism that produced it was still armed, and several sibling
 * probes write into `shots-*` the same way.
 *
 * This repo already holds the convention that a number must name the on-disk
 * file it came from — adopted after four fix reports quoted before/after
 * figures no critic could reproduce. That convention is only as strong as the
 * file's survival. A citation to a path guaranteed to be deleted is the same
 * failure wearing a filename.
 *
 * ## What this module does about it
 *
 * `resolveOutDir` asks git whether the destination is ignored, and says so at
 * the moment of writing rather than at the moment someone tries to check a
 * quoted number months later. A probe declaring `citable: true` — one whose
 * output is *meant* to be quoted — refuses to run into an ignored directory
 * instead of merely warning.
 *
 * ## Why a warning and not a rewrite of every default
 *
 * Most probe output genuinely is disposable: hundreds of 1600x900 PNGs per
 * capture round, regenerable from the command their manifest records, and
 * correctly ignored. Forcing all of it into git would trade this defect for a
 * much worse one. The distinction that matters is not "screenshot vs JSON", it
 * is "will anything cite this" — which only the probe's author knows, so it is
 * a flag rather than a heuristic.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Is `target` ignored by git?
 *
 * `git check-ignore` exits 0 when the path IS ignored, 1 when it is not, and
 * something else on error. `--no-index` is deliberately omitted: a path that is
 * already tracked is not ignored in any sense that matters here, and that is
 * exactly the answer we want for `reviews/modelkit-seam/`.
 *
 * **The trailing slash is load-bearing.** The rule that caused issue #71 is
 * `shots-*` *with a trailing slash*, which git treats as directory-only. Asked
 * about `shots-modelkit`, check-ignore cannot tell whether that names a
 * directory — the path need not exist yet — so it answers "not ignored". Asked
 * about `shots-modelkit/` it answers "ignored". The first probe a fix like this
 * writes is therefore the exact question that returns the wrong answer, and it
 * returns it reassuringly. So a directory is always probed with a separator:
 * either because the caller said so, or because it is one on disk already.
 *
 * Returns `null` — meaning "unknown" — when git cannot answer at all, so that a
 * missing git or a non-repo checkout degrades to silence rather than to a false
 * accusation or a false reassurance.
 */
/**
 * Prefer these two over `isGitIgnored` at a call site.
 *
 * Whether the target is a directory is a question only the caller can answer
 * for a path that does not exist yet, and getting it wrong is the confidently
 * -wrong answer this module exists to abolish — the trap, moved one layer up.
 * Naming the two questions separately makes the caller pick by construction
 * rather than by remembering an option.
 *
 * Both genuinely force their semantics: `asDirectory` is a tri-state, so
 * `false` means "treat as a file" rather than "work it out", and the pair is
 * symmetric in behaviour and not only in name.
 */
export const isGitIgnoredDir = (target) => isGitIgnored(target, { asDirectory: true });
export const isGitIgnoredFile = (target) => isGitIgnored(target, { asDirectory: false });

/**
 * @param {object} [opts]
 * @param {boolean|'auto'} [opts.asDirectory] `true` / `false` assert the kind;
 *   `'auto'` (the default) infers it from disk and falls back to file for a
 *   path that does not exist — which is precisely the case that answers wrongly
 *   for a directory-only ignore rule, so assert it where you can.
 */
export function isGitIgnored(target, { asDirectory = 'auto' } = {}) {
  let isDir = asDirectory === true;
  if (asDirectory === 'auto') {
    try { isDir = statSync(target).isDirectory(); } catch { /* may not exist yet */ }
  }
  const probe = isDir ? target.replace(/[\\/]+$/, '') + '/' : target;

  const r = spawnSync('git', ['check-ignore', '-q', '--', probe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/**
 * Resolve a probe's `--out` and check it is somewhere its output can survive.
 *
 * @param {string} out         the requested output directory, relative or absolute
 * @param {object} opts
 * @param {string} opts.tool   the probe's name, for the message
 * @param {boolean} opts.citable  true when this probe's output is intended to be
 *                             quoted by a document. Turns the warning into a refusal.
 * @param {string} [opts.suggest]  a committed directory to recommend instead
 * @returns {string} the resolved absolute path
 */
export function resolveOutDir(out, { tool, citable = false, suggest = 'reviews/<topic>/' } = {}) {
  const resolved = path.resolve(out);
  const ignored = isGitIgnoredDir(resolved);

  if (ignored === false) return resolved;

  // `null` means git could not answer — no git on PATH, or not a repository.
  // That is NOT the same as "the path is fine", and collapsing the two would
  // disarm the refusal below in exactly the environment least able to notice:
  // `CLAUDE.md` already records that `gh` goes missing from PATH in
  // non-interactive shells here, so an absent tool is an established failure
  // mode rather than an exotic one. A citable run that cannot verify its
  // destination says so instead of proceeding as though it had.
  if (ignored === null) {
    if (!citable) return resolved;
    console.warn(
      `\n[${tool}] CANNOT VERIFY OUTPUT PATH\n\n`
      + `  git could not say whether ${out} is ignored (no git on PATH, or not a\n`
      + '  repository). This run is meant to produce citable evidence, so check by\n'
      + '  hand that the output is committed before quoting a number from it.\n',
    );
    return resolved;
  }

  const rel = path.relative(process.cwd(), resolved).replace(/\\/g, '/') || out;
  const lines = [
    '',
    `  ${rel} is ignored by git.`,
    '',
    '  Output written here is not evidence. It does not survive a clone, a',
    '  worktree prune, or a clean checkout, so any document that quotes a number',
    '  from it is quoting a path that is guaranteed to disappear (issue #71).',
    `  If nothing will cite this run, that is fine — this is the disposable case.`,
    `  If something will, write to a committed location instead:  --out ${suggest}`,
    '',
  ];

  if (!citable) {
    console.warn([`\n[${tool}] NOTE`, ...lines].join('\n'));
    return resolved;
  }

  // The `citable` case is the one that actually burned us, so it stops.
  if (process.env.EVIDENCE_ALLOW_IGNORED === '1') {
    console.warn([
      `\n[${tool}] WARNING - EVIDENCE_ALLOW_IGNORED=1, proceeding anyway`, ...lines,
    ].join('\n'));
    return resolved;
  }
  console.error([
    `\n[${tool}] REFUSING TO WRITE CITED EVIDENCE INTO AN IGNORED PATH`, ...lines,
    '  Set EVIDENCE_ALLOW_IGNORED=1 to override for a genuinely throwaway run.',
    '',
  ].join('\n'));
  process.exit(2);
}

/**
 * Report which of the files a run just wrote will actually survive.
 *
 * Directory-level ignoring is the coarse trap; this is the fine one. A probe
 * may write into a committed directory and still lose individual files, because
 * `.gitignore` carries per-extension rules — `reviews/**\/*.png` ignores every
 * capture under `reviews/`, with a scoped negation for the crops that two
 * documents quote. So "the directory is fine" does not mean "the picture you
 * are about to cite is fine", and the difference is invisible until it matters.
 *
 * Printed at the end of a run, next to the record path, so the person deciding
 * what to quote can see what is quotable.
 */
export function reportSurvival(outDir, filenames, { tool } = {}) {
  const rows = filenames.map((name) => {
    const full = path.join(outDir, name);
    // `'auto'` rather than either wrapper, deliberately: these names come from a
    // directory listing of files that already exist, and an entry may itself be
    // a subdirectory. Asserting a kind here would be asserting something the
    // caller does not know, and disk can simply be asked.
    return { name, ignored: isGitIgnored(full, { asDirectory: 'auto' }) };
  });
  const lost = rows.filter((r) => r.ignored === true);
  const kept = rows.filter((r) => r.ignored === false);
  const unknown = rows.filter((r) => r.ignored === null);

  if (unknown.length === rows.length) return rows; // no git; say nothing

  console.log(`\n[${tool}] evidence survival`);
  console.log(`  ${kept.length} file(s) are committable and safe to cite`);
  if (lost.length) {
    console.log(`  ${lost.length} file(s) are gitignored and will NOT survive a clean checkout:`);
    for (const r of lost.slice(0, 8)) console.log(`    ${r.name}`);
    if (lost.length > 8) console.log(`    ... and ${lost.length - 8} more`);
    console.log('  Do not quote a number read off those without committing them first.');
  }
  return rows;
}
