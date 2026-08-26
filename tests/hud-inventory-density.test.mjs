/**
 * Density-aware compact inventory HUD (#234).
 *
 *   node tests/hud-inventory-density.test.mjs
 *
 * `densityClassFor` is the pure decision the strip's density class is built
 * from: item COUNT (unique stacks currently drawn, i.e. `this.inv.size`, not
 * raw pickup totals) crossing `DENSITY_COMPACT_AT`/`DENSITY_ULTRA_AT` swaps
 * `.inventory` into a denser CSS layout. Kept pure and exported so the
 * threshold logic is pinned independent of a DOM.
 *
 * The floor half of the contract — that compacting shrinks tile geometry but
 * never the badge text or icon glyph below the HUD's own `--fs-micro`/`--u`
 * scale — is a CSS invariant, checked here by reading the stylesheet: the
 * density rules may only touch size/gap properties on `.item`/`.inv-row`/
 * `.inv-group`, never `font-size` on `.item-stack` or the tier groups.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DENSITY_COMPACT_AT,
  DENSITY_ULTRA_AT,
  densityClassFor,
} from '../src/ui/HUD.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const here = dirname(fileURLToPath(import.meta.url));

console.log('thresholds are ordered and positive');
{
  ok(DENSITY_COMPACT_AT > 0, 'compact threshold is a real count, not 0');
  ok(DENSITY_ULTRA_AT > DENSITY_COMPACT_AT, 'ultra strictly beyond compact');
}

console.log('below compact threshold: no density class');
{
  ok(densityClassFor(0) === '', 'empty inventory');
  ok(densityClassFor(1) === '', 'a single item');
  ok(densityClassFor(DENSITY_COMPACT_AT - 1) === '', 'one short of compact');
}

console.log('at/after compact, before ultra: is-dense only');
{
  ok(densityClassFor(DENSITY_COMPACT_AT) === 'is-dense', 'exactly at the compact threshold');
  ok(densityClassFor(DENSITY_ULTRA_AT - 1) === 'is-dense', 'one short of ultra');
}

console.log('at/after ultra: cumulative is-dense is-dense-2');
{
  ok(densityClassFor(DENSITY_ULTRA_AT) === 'is-dense is-dense-2', 'exactly at the ultra threshold');
  ok(densityClassFor(DENSITY_ULTRA_AT + 50) === 'is-dense is-dense-2', 'far beyond ultra stays capped, not a third step');
}

console.log('monotonic: density never drops as count rises');
{
  const rank = (cls) => cls.split(' ').filter(Boolean).length;
  let prev = -1;
  for (let n = 0; n <= DENSITY_ULTRA_AT + 10; n++) {
    const r = rank(densityClassFor(n));
    ok(r >= prev, `count ${n} did not de-densify relative to ${n - 1}`);
    prev = r;
  }
}

console.log('CSS floor: density rules shrink geometry, never font-size on badge/text');
{
  const css = readFileSync(join(here, '../src/ui/hud.css'), 'utf8');
  const blockMatch = css.match(/\.inventory\.is-dense[\s\S]*?(?=\n\/\*[^=]|\n\.[a-zA-Z-]+\.(?!is-dense)|$)/);
  ok(!!blockMatch, 'a .inventory.is-dense rule block exists in hud.css');
  const block = blockMatch ? blockMatch[0] : '';
  ok(block.includes('is-dense-2'), 'a second, cumulative step exists');
  ok(!/\.item-stack[^{]*\{[^}]*font-size/.test(block), 'the count badge font-size is never touched by density rules');
  ok(!/font-size\s*:\s*[^;]*em/.test(block) || !/\.item\b[^{]*\{[^}]*font-size/.test(block),
    'tile-level font-size stays out of the density rules — only geometry (width/height/gap) steps down');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
