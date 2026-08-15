/**
 * Side-by-side crop of two frames, for the eye rather than the arithmetic.
 *
 *   node compose.mjs <a.png> <b.png> <out.png> <x> <y> <w> <h> [scale]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [a, b, out, x, y, w, h, sc = 2] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const b64 = await page.evaluate(async ([sa, sb, x, y, w, h, sc]) => {
  const dec = async (src) => { const i = new Image(); i.src = 'data:image/png;base64,' + src; await i.decode(); return i; };
  const A = await dec(sa), B = await dec(sb);
  const c = new OffscreenCanvas(w * sc * 2 + 8, h * sc);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#ff00ff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(A, x, y, w, h, 0, 0, w * sc, h * sc);
  g.drawImage(B, x, y, w, h, w * sc + 8, 0, w * sc, h * sc);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const v of buf) s += String.fromCharCode(v);
  return btoa(s);
}, [readFileSync(a).toString('base64'), readFileSync(b).toString('base64'), +x, +y, +w, +h, +sc]);
writeFileSync(out, Buffer.from(b64, 'base64'));
await browser.close();
console.log('wrote', out);
