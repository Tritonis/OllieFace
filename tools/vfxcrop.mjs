/**
 * Magnified crop of a capture PNG, for visual inspection of a named region.
 *   node tools/vfxcrop.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, outp, x, y, w, h, sc = 2] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const b64 = await page.evaluate(async ([src, x, y, w, h, sc]) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
  const c = new OffscreenCanvas(w * sc, h * sc);
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * sc, h * sc);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}, [readFileSync(inp).toString('base64'), +x, +y, +w, +h, +sc]);
writeFileSync(outp, Buffer.from(b64, 'base64'));
await browser.close();
console.log('wrote', outp);
