/**
 * Same-tier icon collision floor.
 *
 * Round 4 established that no two items in the same tier may render as the same
 * shape, and set the floor at a minimum pairwise Hamming distance of 8.5% of the
 * glyph mask. The 95-glyph content wave drove it to 5.7% and nobody noticed,
 * because the check lived in a critic's scratchpad rather than in the repo.
 *
 * This renders every item's *shipped* HUD tile — `ui/Icons.js` `itemArt`, the
 * exact function the inventory calls — at the HUD's own tile size, thresholds
 * the glyph band to a bitmask, and XORs all same-tier pairs. It measures pixels,
 * not source, so a glyph that differs only in code still fails.
 *
 *   node tools/glyphdist.mjs [--floor 10] [--tile 34] [--top 12]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const eq = t.indexOf('=');
  if (eq !== -1) { args[t.slice(2, eq)] = t.slice(eq + 1); continue; }
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const FLOOR = Number(args.floor ?? 10);
const TILE = Number(args.tile ?? 34);
const TOP = Number(args.top ?? 12);

// HMR off: another agent saving a file mid-run reloads the page and destroys
// the evaluate context. This tool reads modules, not a live session.
const server = await createServer({ server: { port: 0, hmr: false, watch: null } });
await server.listen();
const base = `http://localhost:${server.config.server.port}/`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async ({ tile }) => {
  const items = await import('/src/data/items.js');
  const icons = await import('/src/ui/Icons.js');

  const load = (url) => new Promise((res) => {
    const im = new Image(); im.onload = () => res(im); im.src = url;
  });

  const c = document.createElement('canvas');
  c.width = c.height = tile;
  const g = c.getContext('2d', { willReadFrequently: true });

  // The glyph band only. The bottom-right of the tile is the stack count's,
  // and the outer ring is the tier keyline — neither carries identity.
  const x0 = Math.round(tile * 0.10), x1 = Math.round(tile * 0.90);
  const y0 = Math.round(tile * 0.06), y1 = Math.round(tile * 0.72);
  const bits = (x1 - x0) * (y1 - y0);

  const entries = [];
  for (const it of items.ITEMS) {
    const im = await load(icons.itemArt(it.id, it.tier));
    g.clearRect(0, 0, tile, tile);
    g.drawImage(im, 0, 0, tile, tile);
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const mask = new Uint8Array(bits);
    for (let i = 0; i < bits; i++) {
      const L = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      mask[i] = L > 96 ? 1 : 0;
    }
    entries.push({ id: it.id, name: it.name, tier: it.tier, glyph: it.glyph, mask });
  }

  const pairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].tier !== entries[j].tier) continue;
      const a = entries[i].mask, b = entries[j].mask;
      let x = 0;
      for (let k = 0; k < bits; k++) if (a[k] !== b[k]) x++;
      pairs.push({
        a: entries[i].glyph, b: entries[j].glyph,
        an: entries[i].name, bn: entries[j].name,
        tier: entries[i].tier, xor: x,
      });
    }
  }
  pairs.sort((p, q) => p.xor - q.xor);
  return { bits, count: entries.length, pairs: pairs.slice(0, 40), total: pairs.length };
}, { tile: TILE });

await browser.close();
await server.close();

const pct = (n) => ((n / result.bits) * 100).toFixed(2);
console.log(`items ${result.count} · same-tier pairs ${result.total} · mask ${result.bits} bits · tile ${TILE}px`);
console.log(`floor ${pct(result.pairs[0].xor)}%  (target >= ${FLOOR}%)`);
console.log('');
console.log('tightest same-tier pairs:');
for (const p of result.pairs.slice(0, TOP)) {
  const flag = (p.xor / result.bits) * 100 < FLOOR ? ' <-- UNDER FLOOR' : '';
  console.log(`  ${pct(p.xor).padStart(6)}%  ${p.tier.padEnd(10)} ${p.a}/${p.b}  (${p.an} / ${p.bn})${flag}`);
}
const fails = result.pairs.filter((p) => (p.xor / result.bits) * 100 < FLOOR).length;
console.log('');
console.log(fails ? `FAIL — ${fails} same-tier pair(s) under ${FLOOR}%` : `PASS — floor is above ${FLOOR}%`);
process.exit(fails ? 1 : 0);
