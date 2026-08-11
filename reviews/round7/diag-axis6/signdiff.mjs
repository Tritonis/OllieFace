/**
 * Signed per-shot difference between two capture directories.
 *
 * `tools/shotdiff.mjs` reports |delta|, which cannot tell the two things this
 * change does apart: opacity that now occludes the additive layer makes a pixel
 * DARKER, and opacity that the discard threshold deleted makes a pixel BRIGHTER
 * (whatever the sprite was covering is now uncovered). This prints both counts
 * so a shot's movement can be attributed to one or the other.
 *
 * Both frames are decoded and differenced *inside* the browser and only the
 * counts cross the CDP boundary: handing back a 5.7M-entry pixel array per
 * image, as the first version did, did not finish 46 images in seven minutes.
 *
 *   node signdiff.mjs <dirA> <dirB> [nameSubstrings...]
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const A = path.resolve(process.argv[2]), B = path.resolve(process.argv[3]);
const only = process.argv.slice(4);
const names = readdirSync(A).filter((f) => f.endsWith('.png') && (!only.length || only.some((o) => f.includes(o))));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

console.log('shot                       darker>8L          brighter>8L        net mean L');
for (const n of names) {
  const r = await page.evaluate(async ([sa, sb]) => {
    const dec = async (src) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, d: g.getImageData(0, 0, img.width, img.height).data };
    };
    const a = await dec(sa), b = await dec(sb);
    if (a.w !== b.w || a.h !== b.h) return null;
    const W = a.w, H = a.h;
    const L = (d, i) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    let dn = 0, ds = 0, bn = 0, bs = 0, net = 0, tot = 0;
    for (let i = 0; i < W * H; i++) {
      const y = (i / W) | 0, x = i % W;
      if (y > H - 130 || (y < 110 && (x < 280 || x > 1400))) continue; // HUD bands
      tot++;
      const v = L(b.d, i) - L(a.d, i);
      net += v;
      if (v < -8) { dn++; ds -= v; }
      if (v > 8) { bn++; bs += v; }
    }
    return { dn, ds, bn, bs, net, tot };
  }, [readFileSync(path.join(A, n)).toString('base64'), readFileSync(path.join(B, n)).toString('base64')]);
  if (!r) { console.log(`${n} size mismatch`); continue; }
  console.log(`${n.padEnd(24)} ${String(r.dn).padStart(7)}/${(r.dn ? r.ds / r.dn : 0).toFixed(1).padStart(6)} L ${String(r.bn).padStart(11)}/${(r.bn ? r.bs / r.bn : 0).toFixed(1).padStart(6)} L ${(r.net / r.tot).toFixed(3).padStart(11)}`);
}
await browser.close();
