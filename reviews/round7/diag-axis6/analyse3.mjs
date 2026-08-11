/**
 * Pass-3 analysis: the two candidate fixes against the same frozen frame.
 *
 * Reports, for each candidate, (i) how much silhouette it restores on the
 * pixels the alpha layer actually covers, and (ii) what it does to the
 * fireball's own core, which is where an order-only change is expected to punch
 * a hole because neither layer writes depth.
 *
 *   node analyse3.mjs <dir>
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const KEYS = ['p3-full', 'p3-full2', 'p3-alphaLast', 'p3-depthWrite', 'p3-both', 'p3-noadd', 'p3-bare'];
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

const noise = new Uint8Array(W * H);
let raw = 0;
for (let i = 0; i < W * H; i++) if (Math.abs(L(px['p3-full'], i) - L(px['p3-full2'], i)) > 0.5) { noise[i] = 1; raw++; }
const mask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!noise[y * W + x]) continue;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const yy = y + dy, xx = x + dx;
    if (yy >= 0 && xx >= 0 && yy < H && xx < W) mask[yy * W + xx] = 1;
  }
}
let after = 0, mx = 0;
for (let i = 0; i < W * H; i++) {
  if (mask[i]) continue;
  const d = Math.abs(L(px['p3-full'], i) - L(px['p3-full2'], i));
  if (d > mx) mx = d;
  if (d > 0.5) after++;
}
console.log(`CALIBRATION p3-full vs p3-full2: ${raw} unstable px; after 2px dilation residual max |dL| ${mx.toFixed(3)} on ${after} px`);
const ok = (i) => !inHud(i % W, (i / W) | 0) && !mask[i];

// Blast centre from (full - bare): only the particle layers differ.
{
  var CX, CY;
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = ok(i) ? L(px['p3-full'], i) - L(px['p3-bare'], i) : 0;
  const cut = Float32Array.from(D).sort()[Math.floor(W * H * 0.998)];
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < W * H; i++) if (D[i] >= cut) { sx += i % W; sy += (i / W) | 0; n++; }
  CX = Math.round(sx / n); CY = Math.round(sy / n);
  console.log(`blast centre (centroid of brightest 0.2% of full-bare): ${CX},${CY}, cut ${cut.toFixed(1)} L`);
}

// This frame's own pedestal and alpha contrast, so the fix numbers below can be
// read against how hot this particular frozen frame is.
{
  let n = 0, sumA = 0, ped = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const dA = L(px['p3-bare'], i) - L(px['p3-noadd'], i);
    if (dA > 8) { n++; sumA += dA; ped += L(px['p3-full'], i) - L(px['p3-noadd'], i); }
  }
  console.log(`alpha mask ${n} px: alone -${(sumA / n).toFixed(2)} L, additive pedestal on it +${(ped / n).toFixed(2)} L`);
}

const step = (k) => {
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
  return { best: +best.toFixed(1), at, r0: +(acc[0].l / acc[0].n).toFixed(1), r8: +(acc[2].l / acc[2].n).toFixed(1) };
};

console.log('\narm            coreMeanL(r<40)  darkened>8L px  meanDark  peakDark  peakAt          maxStep');
for (const k of ['p3-full', 'p3-alphaLast', 'p3-depthWrite', 'p3-both']) {
  let cn = 0, cl = 0, n = 0, sum = 0, pk = 0, pkAt = -1;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    if (Math.hypot(x - CX, y - CY) < 40) { cn++; cl += L(px[k], i); }
    if (k === 'p3-full') continue;
    const d = L(px['p3-full'], i) - L(px[k], i);
    if (d > pk) { pk = d; pkAt = i; }
    if (d > 8) { n++; sum += d; }
  }
  const s = step(k);
  console.log(`${k.padEnd(14)} ${(cl / cn).toFixed(2).padStart(8)}   ${String(n).padStart(12)}  ${(n ? sum / n : 0).toFixed(2).padStart(8)}  ${pk.toFixed(1).padStart(8)}  ${(pkAt >= 0 ? `[${pkAt % W},${(pkAt / W) | 0}]` : '-').padStart(12)}  ${String(s.best).padStart(6)} @r=${s.at}`);
}

// Where the darkening lands relative to the blast: inside the fireball (a hole)
// or on its rim and outside it (a silhouette).
console.log('\ndarkening by radius from the blast centre (px darkened >8 L / mean L removed)');
console.log('arm             r<40        r40-120     r120-260    r>260');
for (const k of ['p3-alphaLast', 'p3-depthWrite', 'p3-both']) {
  const bins = [[0, 40], [40, 120], [120, 260], [260, 1e9]].map(() => ({ n: 0, s: 0 }));
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    const d = L(px['p3-full'], i) - L(px[k], i);
    if (d <= 8) continue;
    const r = Math.hypot(x - CX, y - CY);
    const bi = r < 40 ? 0 : r < 120 ? 1 : r < 260 ? 2 : 3;
    bins[bi].n++; bins[bi].s += d;
  }
  console.log(`${k.padEnd(14)} ` + bins.map((b) => `${String(b.n).padStart(5)}/${(b.n ? b.s / b.n : 0).toFixed(1).padStart(5)}`).join('  '));
}
