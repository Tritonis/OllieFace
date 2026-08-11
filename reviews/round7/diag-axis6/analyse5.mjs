/**
 * Pass-5 analysis: the fix against its own pre-fix state, same frozen frame.
 *
 * Calibration A is printed first and its mask fences every statistic below it,
 * exactly as in analyse4.mjs: `p5-pre` and `p5-pre2` are the same frozen frame
 * rendered twice with the same toggle applied, so every pixel must agree; those
 * that do not (plus a 2 px dilation) are excluded everywhere below.
 *
 * The reference arm for every difference is `p5-pre`, the pre-fix state, so the
 * numbers here are directly comparable with DIAG-axis6-vfx.md section 4, whose
 * reference was the same state under the name `p4-full`.
 *
 *   node analyse5.mjs <dir> [cx] [cy]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const CX = Number(process.argv[3] ?? 568), CY = Number(process.argv[4] ?? 326);
const KEYS = ['p5-pre', 'p5-pre2', 'p5-post', 'p5-cut15', 'p5-cut25', 'p5-cut45', 'p5-prepass'];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const px = {}; let W = 0, H = 0;
for (const k of KEYS) {
  const b64 = readFileSync(path.join(DIR, `arm-${k}.png`)).toString('base64');
  const r = await page.evaluate(async (src) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: Array.from(g.getImageData(0, 0, img.width, img.height).data) };
  }, b64);
  px[k] = r.data; W = r.w; H = r.h;
}
await browser.close();

const L = (d, i) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
const inHud = (x, y) => y > H - 130 || (y < 110 && (x < 280 || x > 1400)) || (x > 1180 && y > 740);

// --- CALIBRATION A: determinism ------------------------------------------
const noise = new Uint8Array(W * H);
let raw = 0;
for (let i = 0; i < W * H; i++) if (Math.abs(L(px['p5-pre'], i) - L(px['p5-pre2'], i)) > 0.5) { noise[i] = 1; raw++; }
const mask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!noise[y * W + x]) continue;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const yy = y + dy, xx = x + dx;
    if (yy >= 0 && xx >= 0 && yy < H && xx < W) mask[yy * W + xx] = 1;
  }
}
let after = 0, mx = 0, maskN = 0;
for (let i = 0; i < W * H; i++) {
  if (mask[i]) { maskN++; continue; }
  const d = Math.abs(L(px['p5-pre'], i) - L(px['p5-pre2'], i));
  if (d > mx) mx = d;
  if (d > 0.5) after++;
}
console.log('=== CALIBRATION A -- determinism, two identical re-renders of the pre-fix arm ===');
console.log(`unstable px ${raw}; dilated mask ${maskN} px; residual after mask: max |dL| ${mx.toFixed(3)} on ${after} px`);
const ok = (i) => !inHud(i % W, (i / W) | 0) && !mask[i];

console.log(`\nblast centre used: ${CX},${CY}`);

const stepOf = (k) => {
  const NB = 40, BW = 4, acc = Array.from({ length: NB }, () => ({ n: 0, l: 0 }));
  for (let y = Math.max(0, CY - 160); y < Math.min(H, CY + 160); y++)
    for (let x = Math.max(0, CX - 160); x < Math.min(W, CX + 160); x++) {
      const i = y * W + x;
      if (!ok(i)) continue;
      const b = (Math.hypot(x - CX, y - CY) / BW) | 0;
      if (b >= NB) continue;
      acc[b].n++; acc[b].l += L(px[k], i);
    }
  let best = 0, at = 0;
  for (let b = 1; b < NB; b++) {
    if (!acc[b].n || !acc[b - 1].n) continue;
    const d = Math.abs(acc[b].l / acc[b].n - acc[b - 1].l / acc[b - 1].n);
    if (d > best) { best = d; at = b * BW; }
  }
  return { step: best, at };
};

console.log('\n=== 1. THE DECISIVE STATISTIC: largest radial luminance step about the blast centre ===');
console.log('arm            core r<40   disc r<120   largest radial step');
for (const k of KEYS.filter((k) => k !== 'p5-pre2')) {
  let cn = 0, cl = 0, dn = 0, dl = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0, r = Math.hypot(x - CX, y - CY);
    if (r < 40) { cn++; cl += L(px[k], i); }
    if (r < 120) { dn++; dl += L(px[k], i); }
  }
  const s = stepOf(k);
  console.log(`${k.padEnd(13)} ${(cl / cn).toFixed(2).padStart(9)} ${(dl / dn).toFixed(2).padStart(12)}    ${s.step.toFixed(1)} L @ r=${s.at}`);
}

console.log('\n=== 2. THE ARTIFACT CLASS: px darkened >8 L against the pre-fix arm, by radius ===');
console.log('(DIAG section 4 measured the un-cut depthWrite arm at 979 px / mean -101.6 L in r<40)');
console.log('arm            r<40           r40-120        r120-260       r>260');
for (const k of KEYS.filter((k) => k !== 'p5-pre' && k !== 'p5-pre2')) {
  const bins = [0, 1, 2, 3].map(() => ({ n: 0, s: 0 }));
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    const d = L(px['p5-pre'], i) - L(px[k], i);
    if (d <= 8) continue;
    const r = Math.hypot(x - CX, y - CY);
    const bi = r < 40 ? 0 : r < 120 ? 1 : r < 260 ? 2 : 3;
    bins[bi].n++; bins[bi].s += d;
  }
  console.log(`${k.padEnd(13)} ` + bins.map((b) => `${String(b.n).padStart(6)}/${(b.n ? b.s / b.n : 0).toFixed(1).padStart(6)} L`).join('  '));
}

console.log('\n=== 3. LIGHT ADDED: nothing here should brighten anything ===');
for (const k of KEYS.filter((k) => k !== 'p5-pre' && k !== 'p5-pre2')) {
  let bn = 0, bs = 0, bp = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const d = L(px[k], i) - L(px['p5-pre'], i);
    if (d > bp) bp = d;
    if (d > 8) { bn++; bs += d; }
  }
  console.log(`${k.padEnd(13)} px BRIGHTENED >8 L: ${bn}${bn ? ` (mean +${(bs / bn).toFixed(1)} L)` : ''}, peak +${bp.toFixed(1)} L`);
}
