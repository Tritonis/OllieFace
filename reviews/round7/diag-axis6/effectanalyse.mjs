/**
 * Reads the per-effect arms from effectarms.mjs and reports, per effect, how
 * many pixels the alpha layer covers before and after the fix.
 *
 * Coverage is measured against that effect's own `noalpha` frame — the same
 * frozen emission with only the alpha layer hidden — so it is that layer's
 * contribution and nothing else's. A coverage of zero after the fix means the
 * emitter's sprites never reach the discard threshold and the effect is not
 * drawn at all.
 *
 * **Calibrated per effect, and it has to be.** `pre` and `pre2` are the same
 * frozen emission rendered twice with the same toggle, so every pixel must
 * agree; those that do not, plus a 2 px dilation, are excluded from both
 * counts. The uncalibrated first version of this analyser credited effects that
 * emit no alpha sprites at all (`levelUp`, `healPop`, `itemPickupBurst`,
 * `shieldBreak`) with 1,836-2,210 px of coverage, which is drift between
 * consecutive re-renders. Those four are kept in the run as the null arms: with
 * the mask on, their coverage is what this instrument reads when the true
 * answer is zero.
 *
 *   node effectanalyse.mjs <dir>
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const names = [...new Set(readdirSync(DIR).filter((f) => f.endsWith('-pre.png')).map((f) => f.slice(4, -8)))];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

console.log('effect             pre-fix       post-fix      kept     mean |dL| pre / post   masked px');
for (const n of names) {
  const b64 = (t) => readFileSync(path.join(DIR, `eff-${n}-${t}.png`)).toString('base64');
  const r = await page.evaluate(async ([a, a2, b, c]) => {
    const dec = async (src) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
      const cv = new OffscreenCanvas(img.width, img.height);
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, d: g.getImageData(0, 0, img.width, img.height).data };
    };
    const A = await dec(a), A2 = await dec(a2), B = await dec(b), C = await dec(c);
    const W = A.w, H = A.h;
    const L = (d, i) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    const noise = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (Math.abs(L(A.d, i) - L(A2.d, i)) > 0.5) noise[i] = 1;
    const mask = new Uint8Array(W * H);
    let maskN = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!noise[y * W + x]) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < H && xx < W && !mask[yy * W + xx]) { mask[yy * W + xx] = 1; maskN++; }
      }
    }
    let pn = 0, ps = 0, qn = 0, qs = 0;
    for (let i = 0; i < W * H; i++) {
      const y = (i / W) | 0, x = i % W;
      if (y > H - 130 || (y < 110 && (x < 280 || x > 1400)) || mask[i]) continue;
      const dp = Math.abs(L(A.d, i) - L(C.d, i));
      const dq = Math.abs(L(B.d, i) - L(C.d, i));
      if (dp > 4) { pn++; ps += dp; }
      if (dq > 4) { qn++; qs += dq; }
    }
    return { pn, ps, qn, qs, maskN };
  }, [b64('pre'), b64('pre2'), b64('post'), b64('noalpha')]);
  const kept = r.pn ? ((r.qn / r.pn) * 100).toFixed(1) + '%' : 'n/a';
  console.log(`${n.padEnd(18)} ${String(r.pn).padStart(7)} px ${String(r.qn).padStart(9)} px ${kept.padStart(8)}   ${(r.pn ? r.ps / r.pn : 0).toFixed(1)} / ${(r.qn ? r.qs / r.qn : 0).toFixed(1)} L ${String(r.maskN).padStart(12)}`);
}
await browser.close();
