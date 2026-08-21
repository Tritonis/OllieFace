/**
 * Mean absolute pixel difference between two PNGs, decoded in a real browser
 * because this repo carries no image library and a comparison arm is not worth
 * a dependency.
 *
 * It exists for one job: telling an A/B pair that actually differs from one
 * that only claims to. A toggle whose "after" frame is pixel-identical to its
 * "before" is the characteristic failure here — the guard reports green on the
 * very thing it was written to catch — so the number below is what turns
 * "the swap ran" into "the swap landed on screen".
 *
 *   node tools/shot-diff.mjs a.png b.png [more.png ...]
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const files = process.argv.slice(2);
if (files.length < 2) { console.error('usage: node tools/shot-diff.mjs a.png b.png [...]'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage();
// Data URLs rather than `file://`: an `about:blank` page loading a file:// image
// taints the canvas, and `getImageData` then throws a bare SecurityError that
// reads like a decode failure.
const urls = files.map((f) => 'data:image/png;base64,' + readFileSync(f).toString('base64'));

const out = await page.evaluate(async (urls) => {
  const load = async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return { d: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  };
  const base = await load(urls[0]);
  const rows = [];
  for (let i = 1; i < urls.length; i++) {
    const other = await load(urls[i]);
    let sum = 0, changed = 0, worst = 0;
    for (let p = 0; p < base.d.length; p += 4) {
      const dr = Math.abs(base.d[p] - other.d[p]);
      const dg = Math.abs(base.d[p + 1] - other.d[p + 1]);
      const db = Math.abs(base.d[p + 2] - other.d[p + 2]);
      const m = (dr + dg + db) / 3;
      sum += m;
      if (m > 2) changed++;
      if (m > worst) worst = m;
    }
    const px = base.d.length / 4;
    rows.push({ index: i, meanAbs: +(sum / px).toFixed(3), pctChanged: +(100 * changed / px).toFixed(2), worst });
  }
  return rows;
}, urls);

for (const r of out) {
  console.log(`${files[0]} vs ${files[r.index]}: meanAbs=${r.meanAbs} changed>2/255=${r.pctChanged}% worst=${r.worst}`);
}
await browser.close();
