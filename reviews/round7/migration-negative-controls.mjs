/**
 * Negative controls for `tests/item-id-migration.test.mjs`.
 *
 *   node reviews/round7/migration-negative-controls.mjs
 *
 * A migration test that passes proves nothing on its own: it has to be shown to
 * fail when the migration is broken. Each arm below breaks exactly one thing the
 * test claims to cover and re-runs it. An arm reporting `HOLE` is a gap in the
 * test, not a pass.
 *
 * Every edit is made to the real file and reverted from a backup kept in the
 * OS temp directory, so an interrupted run leaves nothing in the repo but the
 * file it was already editing — and the revert is a byte copy of what was there,
 * not a `git checkout`, which would silently take uncommitted work with it. That
 * is not hypothetical: the first attempt at this used `git checkout` and undid
 * half the migration, and the arm it was testing then reported a false pass
 * because the test was crashing on an unresolvable import rather than running.
 *
 * Recorded result at the commit this shipped in:
 *
 *   CAUGHT   12 failures  enemy kinds dropped from the v3 migration
 *   CAUGHT    1 failures  one item table entry deleted
 *   CAUGHT    1 failures  difficulty translation removed from the store
 *   CAUGHT   23 failures  item translation stubbed to the identity
 */
import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scratch = mkdtempSync(join(tmpdir(), 'negctl-'));

const ARMS = [
  ['enemy kinds dropped from the v3 migration', 'src/systems/Profile.js',
    'remapIds(p, 4, { items: true, enemies: true })', 'remapIds(p, 4, { items: true })'],
  ['one item table entry deleted', 'src/data/renamedIds.js',
    "  medkit: 'stitch-kit',\n", ''],
  ['difficulty translation removed from the store', 'src/systems/Artifacts.js',
    'const difficulty = renameDifficultyId(data.difficulty);', 'const difficulty = data.difficulty;'],
  ['item translation stubbed to the identity', 'src/data/renamedIds.js',
    'export const renameItemId = translator(RENAMED_ITEM_IDS);', 'export const renameItemId = (id) => id;'],
];

let holes = 0;
for (const [name, rel, from, to] of ARMS) {
  const file = join(ROOT, rel);
  const bak = join(scratch, `${basename(rel)}.bak`);
  copyFileSync(file, bak);
  try {
    const src = readFileSync(file, 'utf8');
    if (!src.includes(from)) { console.log(`SKIP    ${name} — anchor not found in ${rel}`); holes++; continue; }
    writeFileSync(file, src.replace(from, to));
    let out = '';
    try {
      out = execFileSync('node', ['tests/item-id-migration.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) { out = (e.stdout ?? '') + (e.stderr ?? ''); }
    const fails = (out.match(/ {2}FAIL/g) || []).length;
    // A crash is not a caught failure: it means the test stopped rather than
    // reported, and the arms after the crash point were never evaluated.
    const crashed = /^\s+at .*node:internal/m.test(out);
    if (fails > 0 && !crashed) console.log(`CAUGHT ${String(fails).padStart(4)} failures  ${name}`);
    else { holes++; console.log(`HOLE   ${String(fails).padStart(4)} failures  ${name}${crashed ? '  (the test CRASHED — harden it)' : ''}`); }
  } finally {
    copyFileSync(bak, file);
  }
}
rmSync(scratch, { recursive: true, force: true });
process.exit(holes ? 1 : 0);
