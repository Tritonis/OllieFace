/**
 * Re-analysis of the arm PNGs written by `layerarms.mjs`, from disk.
 *
 * Split out from the probe because the probe's own determinism arm came back
 * dirty (6419 px differ between two bit-identical re-renders) and a measurement
 * cannot be trusted until the noise has been located and fenced, rather than
 * averaged into the signal. This decodes the same PNGs the probe wrote, finds
 * where `full` and `fullB` disagree, and re-runs every statistic with those
 * pixels excluded by a mask that is *derived from the calibration arm* rather
 * than guessed from a y-band.
 *
 *   node armanalyse.mjs <dir>
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const KEYS = ['full', 'fullB', 'noadd', 'noalpha', 'bare', 'half'];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const imgs = {};
for (const k of KEYS) {
  const b64 = readFileSync(path.join(DIR, `arm-${k}.png`)).toString('base64');
  imgs[k] = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + src;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: Array.from(g.getImageData(0, 0, img.width, img.height).data) };
  }, b64);
}
await browser.close();

const W = imgs.full.w, H = imgs.full.h;
const px = {};
for (const k of KEYS) px[k] = imgs[k].data;
const L = (d, i) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];

// --- 1. locate the instability -------------------------------------------
const noise = new Uint8Array(W * H);
let nN = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
const rowHist = new Int32Array(H);
for (let i = 0; i < W * H; i++) {
  const d = Math.abs(L(px.full, i) - L(px.fullB, i));
  if (d <= 0.5) continue;
  noise[i] = 1; nN++;
  const x = i % W, y = (i / W) | 0;
  rowHist[y]++;
  if (x < x0) x0 = x; if (x > x1) x1 = x;
  if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const bands = [];
for (let y = 0; y < H; y++) {
  if (!rowHist[y]) continue;
  if (bands.length && y - bands[bands.length - 1].y1 <= 4) {
    bands[bands.length - 1].y1 = y; bands[bands.length - 1].n += rowHist[y];
  } else bands.push({ y0: y, y1: y, n: rowHist[y] });
}
console.log(`\n=== CALIBRATION A: determinism (full vs fullB, identical inputs) ===`);
console.log(`unstable px: ${nN} (${((nN / (W * H)) * 100).toFixed(3)}% of frame), bbox [${x0},${y0},${x1},${y1}]`);
console.log(`row bands: ${bands.map((b) => `y${b.y0}-${b.y1}:${b.n}px`).join(' ')}`);

// Dilate the noise mask by 2 px so an antialiased edge of an unstable glyph is
// fenced with it.
const mask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!noise[y * W + x]) continue;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= H || xx >= W) continue;
        mask[yy * W + xx] = 1;
      }
    }
  }
}
let maskN = 0; for (let i = 0; i < W * H; i++) if (mask[i]) maskN++;
console.log(`masked (dilated 2px): ${maskN} px`);
// What the unstable pixels *are*: isolated speckle or a moving object.
{
  let lum = 0, n = 0, isolated = 0;
  for (let i = 0; i < W * H; i++) {
    if (!noise[i]) continue;
    lum += L(px.full, i); n++;
    const x = i % W, y = (i / W) | 0;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if ((dx || dy) && yy >= 0 && xx >= 0 && yy < H && xx < W && noise[yy * W + xx]) nb++;
    }
    if (!nb) isolated++;
  }
  console.log(`unstable px: mean L in 'full' ${(lum / n).toFixed(1)}, isolated (no unstable 8-neighbour) ${isolated}/${n}`);
}
const NOMASK = process.argv.includes('--nomask');
if (NOMASK) { mask.fill(0); console.log('*** --nomask: calibration mask disabled for this run ***'); }

// HUD fence, same as the probe's, plus the calibration mask.
const inHud = (x, y) => y > H - 130 || (y < 110 && (x < 280 || x > 1400)) || (x > 1180 && y > 740);
const ok = (i) => {
  const x = i % W, y = (i / W) | 0;
  return !inHud(x, y) && !mask[i];
};

// Residual determinism after masking.
let m2 = 0, n2 = 0;
for (let i = 0; i < W * H; i++) {
  if (!ok(i)) continue;
  const d = Math.abs(L(px.full, i) - L(px.fullB, i));
  if (d > m2) m2 = d;
  if (d > 0.5) n2++;
}
console.log(`after mask: max |dL| = ${m2.toFixed(3)}, px over 0.5 = ${n2}`);

// --- 2. blast centre, derived from the arms themselves --------------------
// Not from a brightness search over the frame -- `tools/vfxmeasure.mjs`'s
// centroid of the brightest 0.2% lands at (850,194) on this frame, which is
// sky, because the probe's camera frames differently from the shipped
// `08-explosion` capture. `full - bare` is *by construction* zero everywhere
// except where the two particle layers drew, so its bright centroid is the
// blast and cannot be anything else.
let CX = Number(process.argv[3] ?? 0), CY = Number(process.argv[4] ?? 0);
if (!CX && !CY) {
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = ok(i) ? L(px.full, i) - L(px.bare, i) : 0;
  const cut = Float32Array.from(D).sort()[Math.floor(W * H * 0.998)];
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < W * H; i++) if (D[i] >= cut) { sx += i % W; sy += (i / W) | 0; n++; }
  CX = Math.round(sx / n); CY = Math.round(sy / n);
  console.log(`\nblast centre derived from centroid of the brightest 0.2% of (full - bare), n=${n}, cut=${cut.toFixed(1)} L`);
}
console.log(`blast centre used: ${CX},${CY}`);

const regions = {
  core: (x, y) => Math.hypot(x - CX, y - CY) < 40,
  disc: (x, y) => Math.hypot(x - CX, y - CY) < 120,
  skirt: (x, y) => { const r = Math.hypot(x - CX, y - CY); return r >= 120 && r < 260; },
  frame: () => true,
};
console.log(`\n=== REGION MEANS, display L, calibration-masked ===`);
const means = {};
for (const [rn, test] of Object.entries(regions)) {
  const acc = {}; for (const k of KEYS) acc[k] = 0;
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    if (!ok(i) || !test(x, y)) continue;
    n++;
    for (const k of KEYS) acc[k] += L(px[k], i);
  }
  means[rn] = { n };
  for (const k of KEYS) means[rn][k] = +(acc[k] / n).toFixed(2);
  const M = means[rn];
  means[rn].additiveDeposit = +(M.full - M.noadd).toFixed(2);
  means[rn].alphaAlone = +(M.bare - M.noadd).toFixed(2);
  means[rn].alphaInFull = +(M.noalpha - M.full).toFixed(2);
  means[rn].ratioAddOverAlphaAlone = +(means[rn].additiveDeposit / Math.max(means[rn].alphaAlone, 0.01)).toFixed(2);
  // Superposition residual: if the composite were linear in display L,
  // full = noalpha + noadd - bare. What it is short by is what the tonemap and
  // the bloom took out.
  means[rn].superpositionResidual = +(M.full - (M.noalpha + M.noadd - M.bare)).toFixed(2);
  console.log(`${rn.padEnd(6)} n=${String(n).padStart(7)}  ` + KEYS.map((k) => `${k}=${String(means[rn][k]).padStart(6)}`).join(' '));
  console.log(`       additive deposit +${means[rn].additiveDeposit} L | alpha alone -${means[rn].alphaAlone} L | alpha in full -${means[rn].alphaInFull} L | add:alpha ${means[rn].ratioAddOverAlphaAlone}:1 | superposition residual ${means[rn].superpositionResidual} L`);
}

// --- 3. alpha survival ----------------------------------------------------
let aloneN = 0, aloneSum = 0, inFullN = 0, inFullSum = 0, pairedSum = 0, pairedN = 0;
let wA = 0, wF = 0, pedestal = 0;
for (let i = 0; i < W * H; i++) {
  if (!ok(i)) continue;
  const dAlone = L(px.bare, i) - L(px.noadd, i);
  const dFull = L(px.noalpha, i) - L(px.full, i);
  if (dAlone > 8) {
    aloneN++; aloneSum += dAlone;
    pairedN++; pairedSum += dFull;
    wA += dAlone / Math.max(L(px.bare, i), 1);
    wF += dFull / Math.max(L(px.noalpha, i), 1);
    pedestal += L(px.noalpha, i) - L(px.bare, i);
  }
  if (dFull > 8) { inFullN++; inFullSum += dFull; }
}
console.log(`\n=== ALPHA SURVIVAL (mask = pixels the alpha layer darkens the bare scene by >8 L) ===`);
console.log(`mask size                      ${aloneN} px`);
console.log(`mean darkening on bare scene   -${(aloneSum / aloneN).toFixed(2)} L   (Weber ${(wA / pairedN).toFixed(4)})`);
console.log(`mean darkening in the composite -${(pairedSum / pairedN).toFixed(2)} L  (Weber ${(wF / pairedN).toFixed(4)})`);
console.log(`mean additive pedestal on that mask +${(pedestal / pairedN).toFixed(2)} L`);
console.log(`contrast retained               ${((wF / pairedN) / (wA / pairedN) * 100).toFixed(1)}%`);
console.log(`px still reading >8 L in composite ${inFullN} (${((inFullN / aloneN) * 100).toFixed(1)}% of the mask)`);

// --- 4. largest radial luminance step, per arm ---------------------------
const NB = 40, BW = 4;
console.log(`\n=== LARGEST RADIAL LUMINANCE STEP about the blast centre, 4px annuli ===`);
for (const k of ['full', 'noadd', 'noalpha', 'bare']) {
  const acc = Array.from({ length: NB }, () => ({ n: 0, l: 0 }));
  for (let y = Math.max(0, CY - NB * BW); y < Math.min(H, CY + NB * BW); y++) {
    for (let x = Math.max(0, CX - NB * BW); x < Math.min(W, CX + NB * BW); x++) {
      const i = y * W + x;
      if (!ok(i)) continue;
      const b = (Math.hypot(x - CX, y - CY) / BW) | 0;
      if (b >= NB) continue;
      acc[b].n++; acc[b].l += L(px[k], i);
    }
  }
  let best = 0, at = 0;
  for (let b = 1; b < NB; b++) {
    if (!acc[b].n || !acc[b - 1].n) continue;
    const d = Math.abs(acc[b].l / acc[b].n - acc[b - 1].l / acc[b - 1].n);
    if (d > best) { best = d; at = b * BW; }
  }
  console.log(`${k.padEnd(8)} maxStep ${best.toFixed(1)} L at r=${at}`);
}
