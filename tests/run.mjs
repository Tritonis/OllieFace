/**
 * Runs every tests/*.test.mjs in its own process.
 *
 *   npm test
 *
 * Deliberately tiny: this repo has no test framework and does not need one.
 * Each test file is standalone, prints PASS/FAIL lines and exits non-zero on
 * failure, matching the idiom in reviews/round6/C2-corruption.test.mjs.
 *
 * `sp-equivalence.mjs` is deliberately NOT named `.test.mjs` — it needs a
 * browser and about two minutes, and is run explicitly by the tasks that
 * compare against a baseline.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

// `npm test -- --quiet` prints only the closing tally on a green run. A FAILING
// file is still shown in full, under the same header, because the output that
// matters is the output nobody reads until something breaks — quiet captures it
// rather than discarding it.
const quiet = process.argv.includes('--quiet') || process.argv.includes('--summary');

let failed = 0;
for (const f of files) {
  if (!quiet) console.log(`\n=== ${f} ===`);
  const r = quiet
    ? spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8' })
    : spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    if (quiet) {
      console.log(`\n=== ${f} ===`);
      // Stdout in full, then stderr in full. `spawnSync` hands back two
      // finished buffers with no interleaving information, so a thrown stack
      // trace appears BELOW the PASS/FAIL lines rather than at the point it
      // interrupted them. Labelled, because an unlabelled trace at the bottom
      // reads as if it came after the last check rather than during one.
      console.log(`${r.stdout ?? ''}`.replace(/\s+$/, ''));
      if (r.stderr?.trim()) {
        console.log('--- stderr (captured separately; not interleaved with the above) ---');
        console.log(r.stderr.replace(/\s+$/, ''));
      }
    }
    console.log(`--- ${f} FAILED ---`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
