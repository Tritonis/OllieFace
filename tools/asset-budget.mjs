/**
 * The asset payload budget (issue #28).
 *
 * One module so the number a human reads and the number the gate enforces come
 * from the same code path:
 *
 *   node tools/asset-budget.mjs            # measure dist/ and report against the ceilings
 *   node tools/asset-budget.mjs --json     # the same, machine-readable
 *
 * The gate itself is `tests/asset-budget.test.mjs`, which imports from here.
 * The ceilings live in `docs/art/asset-budget.json`, beside the prose in
 * `docs/art/ASSET-SPEC.md` that justifies them.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const BUDGET_FILE = join(root, 'docs', 'art', 'asset-budget.json');
export const DIST = join(root, 'dist');

/** Extensions that are code/markup, not art payload. */
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.wasm']);

export function loadBudget() {
  return JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
}

export const MiB = (b) => `${(b / 1048576).toFixed(2)} MiB`;

/**
 * Walk a built dist/ and split it the way shipping splits it.
 *
 * Sourcemaps are measured but excluded from `shipped`, because
 * `package.json`'s `build.files` carries `!dist/**\/*.map` — gating on a
 * number the player never downloads would be gating on the wrong thing.
 */
export function measureDist(dir = DIST) {
  if (!existsSync(dir)) return null;
  let total = 0, code = 0, assets = 0, sourcemaps = 0, newestMtime = 0;
  const assetFiles = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      const st = statSync(f);
      total += st.size;
      newestMtime = Math.max(newestMtime, st.mtimeMs);
      const ext = extname(e.name).toLowerCase();
      if (ext === '.map') sourcemaps += st.size;
      else if (CODE_EXT.has(ext)) code += st.size;
      else { assets += st.size; assetFiles.push({ file: f.slice(dir.length + 1), bytes: st.size }); }
    }
  })(dir);
  assetFiles.sort((a, b) => b.bytes - a.bytes);
  return { total, code, assets, sourcemaps, shipped: code + assets, newestMtime, assetFiles };
}

/**
 * Is this build older than the sources it was built from?
 *
 * `npm test` must never quietly pass a payload gate on a build from last week,
 * so the answer travels with the measurement and the gate says it out loud.
 * (`gates:cheap` runs `test` before `build`, so under that tier the build being
 * checked is by construction the *previous* one — hence the note rather than a
 * failure: a stale-build failure would make the cheap tier unrunnable.)
 */
export function buildStaleness(measured) {
  let newestSrc = 0, newestFile = null;
  for (const rel of ['src', 'index.html', 'vite.config.js']) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    (function walk(f) {
      const st = statSync(f);
      if (st.isDirectory()) { for (const e of readdirSync(f)) walk(join(f, e)); return; }
      if (st.mtimeMs > newestSrc) { newestSrc = st.mtimeMs; newestFile = f.slice(root.length + 1); }
    })(p);
  }
  return { stale: newestSrc > measured.newestMtime, newestSrc, newestFile };
}

/** Every payload ceiling, checked. Returns a list of {name, actual, ceiling, ok}. */
export function checkPayload(measured, budget = loadBudget()) {
  const c = budget.ceilings;
  return [
    { name: 'shipped total', actual: measured.shipped, ceiling: c.shippedTotalBytes },
    { name: 'code', actual: measured.code, ceiling: c.codeBytes },
    { name: 'assets', actual: measured.assets, ceiling: c.assetBytes },
  ].map((r) => ({ ...r, ok: r.actual <= r.ceiling }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const budget = loadBudget();
  const m = measureDist();
  if (!m) {
    console.error('asset-budget: no dist/ — run `npm run build` first.');
    process.exit(2);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ measured: m, checks: checkPayload(m, budget) }, null, 2));
  } else {
    const s = buildStaleness(m);
    console.log(`dist/ total ${MiB(m.total)} (sourcemaps ${MiB(m.sourcemaps)}, never shipped)`);
    for (const r of checkPayload(m, budget)) {
      console.log(`  ${r.ok ? 'OK  ' : 'OVER'} ${r.name.padEnd(14)} ${MiB(r.actual).padStart(10)} / ${MiB(r.ceiling)}`);
    }
    if (s.stale) console.log(`  NOTE this build predates ${s.newestFile} — rebuild for a current number.`);
  }
}
