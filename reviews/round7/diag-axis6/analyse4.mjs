/**
 * Pass-4 analysis: one frozen frame, one controlled blast phase, all arms.
 *
 * Calibration is the first thing printed and the mask it produces fences every
 * statistic below it: two bit-identical re-renders of the same frozen frame are
 * differenced, and any pixel that moves between them (plus a 2 px dilation) is
 * excluded, so nothing downstream can be reading render noise as signal.
 *
 *   node analyse4.mjs <dir> [cx] [cy]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const CX = Number(process.argv[3] ?? 568), CY = Number(process.argv[4] ?? 326);
const KEYS = ['p4-full', 'p4-full2', 'p4-noadd', 'p4-noalpha', 'p4-bare', 'p4-half',
  'p4-alphaLast', 'p4-depthWrite', 'p4-both'];

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
for (let i = 0; i < W * H; i++) if (Math.abs(L(px['p4-full'], i) - L(px['p4-full2'], i)) > 0.5) { noise[i] = 1; raw++; }
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
  const d = Math.abs(L(px['p4-full'], i) - L(px['p4-full2'], i));
  if (d > mx) mx = d;
  if (d > 0.5) after++;
}
console.log('=== CALIBRATION A -- determinism, two identical re-renders ===');
console.log(`unstable px ${raw}; dilated mask ${maskN} px; residual after mask: max |dL| ${mx.toFixed(3)} on ${after} px`);
const ok = (i) => !inHud(i % W, (i / W) | 0) && !mask[i];

// --- CALIBRATION B: known input ------------------------------------------
// The additive layer's uIntensity is halved. The arm must move the additive
// deposit down and must move nothing where the additive layer does not draw.
{
  let inBlast = 0, outBlast = 0, offN = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    const d = Math.abs(L(px['p4-full'], i) - L(px['p4-half'], i));
    const addHere = L(px['p4-full'], i) - L(px['p4-noalpha'], i);
    if (d > 1) {
      if (Math.hypot(x - CX, y - CY) < 260) inBlast++; else outBlast++;
      if (Math.abs(addHere) < 0.5 && Math.abs(L(px['p4-full'], i) - L(px['p4-noadd'], i)) < 1) offN++;
    }
  }
  console.log('\n=== CALIBRATION B -- known input, additive uIntensity 1.35 -> 0.675 ===');
  console.log(`px moved >1 L: ${inBlast} within r<260 of the blast, ${outBlast} elsewhere; of all moved px, ${offN} sit where the additive layer contributes <1 L (should be ~0)`);
}

console.log(`\nblast centre used: ${CX},${CY}`);

// --- 1. layer decomposition ----------------------------------------------
console.log('\n=== 1. ADDITIVE vs ALPHA, region means in display L ===');
const R = { 'core r<40': 40, 'disc r<120': 120 };
for (const [label, rad] of Object.entries(R)) {
  const acc = {}; for (const k of KEYS) acc[k] = 0;
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    if (!ok(i) || Math.hypot(x - CX, y - CY) >= rad) continue;
    n++; for (const k of KEYS) acc[k] += L(px[k], i);
  }
  const M = {}; for (const k of KEYS) M[k] = acc[k] / n;
  const add = M['p4-full'] - M['p4-noadd'];
  const alone = M['p4-bare'] - M['p4-noadd'];
  const inFull = M['p4-noalpha'] - M['p4-full'];
  const res = M['p4-full'] - (M['p4-noalpha'] + M['p4-noadd'] - M['p4-bare']);
  console.log(`${label} n=${n}`);
  console.log(`  full ${M['p4-full'].toFixed(2)}  noadd ${M['p4-noadd'].toFixed(2)}  noalpha ${M['p4-noalpha'].toFixed(2)}  bare ${M['p4-bare'].toFixed(2)}  half ${M['p4-half'].toFixed(2)}`);
  console.log(`  additive deposit +${add.toFixed(2)} L | alpha's own darkening -${alone.toFixed(2)} L | additive:alpha ${(add / Math.max(alone, 0.01)).toFixed(1)}:1`);
  console.log(`  that darkening as it survives in the composite -${inFull.toFixed(2)} L (${((inFull / alone) * 100).toFixed(0)}% of it) | superposition residual ${res.toFixed(2)} L`);
  console.log(`  halving the additive intensity removes ${(M['p4-full'] - M['p4-half']).toFixed(2)} L of the ${add.toFixed(2)} L deposit (${(((M['p4-full'] - M['p4-half']) / add) * 100).toFixed(0)}%)`);
}

// --- 2. survival on the alpha layer's own pixels --------------------------
console.log("\n=== 2. SURVIVAL on the alpha layer's own coverage (>8 L darkening of the bare scene) ===");
let n = 0, sA = 0, sF = 0, wA = 0, wF = 0, ped = 0, still = 0;
for (let i = 0; i < W * H; i++) {
  if (!ok(i)) continue;
  const dA = L(px['p4-bare'], i) - L(px['p4-noadd'], i);
  const dF = L(px['p4-noalpha'], i) - L(px['p4-full'], i);
  if (dA <= 8) continue;
  n++; sA += dA; sF += dF;
  wA += dA / Math.max(L(px['p4-bare'], i), 1);
  wF += dF / Math.max(L(px['p4-noalpha'], i), 1);
  ped += L(px['p4-noalpha'], i) - L(px['p4-bare'], i);
  if (dF > 8) still++;
}
console.log(`mask ${n} px | alone -${(sA / n).toFixed(2)} L, Weber ${(wA / n).toFixed(4)}`);
console.log(`             in composite -${(sF / n).toFixed(2)} L, Weber ${(wF / n).toFixed(4)}`);
console.log(`additive pedestal on that mask +${(ped / n).toFixed(2)} L | contrast retained ${((wF / wA) * 100).toFixed(1)}% | px still reading >8 L: ${still} (${((still / n) * 100).toFixed(1)}%)`);

// --- 2b. coverage, and modulation rather than darkening -------------------
// "Darkening" is the wrong frame at the blast centre: the bare scene there is
// dark terrain and the smoke column's own grey (0x54504c) is *brighter* than
// it, so the alpha layer can be doing its job -- replacing background with an
// opaque body -- while the signed difference comes out positive. What the
// silhouette needs is that the alpha layer *modulates* the finished pixel at
// all, in either direction, so this cut is on |delta|.
console.log('\n=== 2b. COVERAGE and MODULATION (|alpha layer changes the bare scene| > 4 L) ===');
for (const [label, rad] of [['core r<40', 40], ['disc r<120', 120], ['skirt r120-260', -260], ['frame', 0]]) {
  let tot = 0, cov = 0, sAlone = 0, sFull = 0, ped = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    const r = Math.hypot(x - CX, y - CY);
    const inR = rad > 0 ? r < rad : rad < 0 ? (r >= 120 && r < -rad) : true;
    if (!inR) continue;
    tot++;
    const dAlone = Math.abs(L(px['p4-noadd'], i) - L(px['p4-bare'], i));
    if (dAlone <= 4) continue;
    cov++; sAlone += dAlone;
    sFull += Math.abs(L(px['p4-full'], i) - L(px['p4-noalpha'], i));
    ped += L(px['p4-noalpha'], i) - L(px['p4-bare'], i);
  }
  console.log(`${label.padEnd(15)} covered ${cov}/${tot} px (${((cov / tot) * 100).toFixed(1)}%) | on that coverage: |change to bare scene| ${(sAlone / cov).toFixed(2)} L, |change to the composite| ${(sFull / cov).toFixed(2)} L (${((sFull / sAlone) * 100).toFixed(0)}% survives), additive pedestal under it +${(ped / cov).toFixed(2)} L`);
}

// --- 3. candidate fixes ---------------------------------------------------
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
  return `${best.toFixed(1)} L @ r=${at}`;
};
console.log('\n=== 3. CANDIDATE FIXES, same frozen frame ===');
console.log('arm             core r<40   px darkened>8L   mean    peak     peak at        largest radial step');
for (const k of ['p4-full', 'p4-alphaLast', 'p4-depthWrite', 'p4-both']) {
  let cn = 0, cl = 0, dn = 0, ds = 0, pk = 0, pkAt = -1;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    if (Math.hypot(x - CX, y - CY) < 40) { cn++; cl += L(px[k], i); }
    const d = L(px['p4-full'], i) - L(px[k], i);
    if (d > pk) { pk = d; pkAt = i; }
    if (d > 8) { dn++; ds += d; }
  }
  console.log(`${k.padEnd(14)} ${(cl / cn).toFixed(2).padStart(8)} ${String(dn).padStart(14)} ${(dn ? ds / dn : 0).toFixed(2).padStart(8)} ${pk.toFixed(1).padStart(8)}  ${(pkAt >= 0 ? `[${pkAt % W},${(pkAt / W) | 0}]` : '-').padStart(12)}   ${stepOf(k)}`);
}
console.log('\nwhere each candidate removes light (px darkened >8 L / mean L removed)');
console.log('arm             r<40         r40-120      r120-260     r>260');
for (const k of ['p4-alphaLast', 'p4-depthWrite', 'p4-both']) {
  const bins = [0, 1, 2, 3].map(() => ({ n: 0, s: 0 }));
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const x = i % W, y = (i / W) | 0;
    const d = L(px['p4-full'], i) - L(px[k], i);
    if (d <= 8) continue;
    const r = Math.hypot(x - CX, y - CY);
    const bi = r < 40 ? 0 : r < 120 ? 1 : r < 260 ? 2 : 3;
    bins[bi].n++; bins[bi].s += d;
  }
  console.log(`${k.padEnd(14)} ` + bins.map((b) => `${String(b.n).padStart(6)}/${(b.n ? b.s / b.n : 0).toFixed(1).padStart(5)}`).join('  '));
}
// Brightening is the tell for a wrong occlusion: nothing about these candidates
// should ever *add* light.
for (const k of ['p4-alphaLast', 'p4-depthWrite', 'p4-both']) {
  let bn = 0, bs = 0, bp = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const d = L(px[k], i) - L(px['p4-full'], i);
    if (d > bp) bp = d;
    if (d > 8) { bn++; bs += d; }
  }
  console.log(`${k.padEnd(14)} px BRIGHTENED >8 L: ${bn}${bn ? ` (mean +${(bs / bn).toFixed(1)} L)` : ''}, peak +${bp.toFixed(1)} L`);
}
