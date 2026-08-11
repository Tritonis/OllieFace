/**
 * Analysis of the pass-2 arms. Same discipline as `armanalyse.mjs`: a
 * determinism pair fences the unstable pixels before any statistic is read.
 *
 *   node analyse2.mjs <dir>
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const KEYS = ['p2-full', 'p2-full2', 'p2-alphaLast', 'mz-full', 'mz-fullB', 'mz-noadd', 'mz-noalpha', 'mz-bare'];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const px = {};
let W = 0, H = 0;
for (const k of KEYS) {
  const b64 = readFileSync(path.join(DIR, `arm-${k}.png`)).toString('base64');
  const r = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + src;
    await img.decode();
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

/** Dilated mask of pixels that differ between two identical re-renders. */
function noiseMask(a, b) {
  const n = new Uint8Array(W * H);
  let raw = 0;
  for (let i = 0; i < W * H; i++) if (Math.abs(L(px[a], i) - L(px[b], i)) > 0.5) { n[i] = 1; raw++; }
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!n[y * W + x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < H && xx < W) m[yy * W + xx] = 1;
    }
  }
  let after = 0, mx = 0;
  for (let i = 0; i < W * H; i++) {
    if (m[i]) continue;
    const d = Math.abs(L(px[a], i) - L(px[b], i));
    if (d > mx) mx = d;
    if (d > 0.5) after++;
  }
  console.log(`calibration ${a} vs ${b}: ${raw} unstable px; after 2px dilation, residual max |dL| ${mx.toFixed(3)} on ${after} px`);
  return m;
}

function centreOf(hot, cold, mask) {
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    D[i] = (!inHud(x, y) && !mask[i]) ? L(px[hot], i) - L(px[cold], i) : 0;
  }
  const cut = Float32Array.from(D).sort()[Math.floor(W * H * 0.998)];
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < W * H; i++) if (D[i] >= cut) { sx += i % W; sy += (i / W) | 0; n++; }
  return [Math.round(sx / n), Math.round(sy / n), n, +cut.toFixed(1)];
}

// ---------------------------------------------------------------- (a) fix
console.log('\n=== (a) PROPOSED FIX ARM: alpha layer drawn after the additive layer ===');
const m1 = noiseMask('p2-full', 'p2-full2');
const [cx, cy, n1, cut1] = centreOf('p2-full', 'p2-alphaLast', m1);
console.log(`region centre from the centroid of the brightest 0.2% of (full - alphaLast): ${cx},${cy} (n=${n1}, cut ${cut1} L)`);

{
  const ok = (i) => !inHud(i % W, (i / W) | 0) && !m1[i];
  let n = 0, sum = 0, weber = 0, mx = 0, mxAt = -1;
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const d = L(px['p2-full'], i) - L(px['p2-alphaLast'], i);
    if (d > mx) { mx = d; mxAt = i; }
    if (d > 8) {
      n++; sum += d; weber += d / Math.max(L(px['p2-full'], i), 1);
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  console.log(`pixels newly darkened by >8 L: ${n}, mean -${(sum / n).toFixed(2)} L, Weber ${(weber / n).toFixed(4)}, peak -${mx.toFixed(1)} L at [${mxAt % W},${(mxAt / W) | 0}], bbox [${x0},${y0},${x1},${y1}]`);
  // Radial step, the round-3 critic's decisive statistic, on both arms.
  for (const k of ['p2-full', 'p2-alphaLast']) {
    const NB = 40, BW = 4, acc = Array.from({ length: NB }, () => ({ n: 0, l: 0 }));
    for (let y = Math.max(0, cy - 160); y < Math.min(H, cy + 160); y++)
      for (let x = Math.max(0, cx - 160); x < Math.min(W, cx + 160); x++) {
        const i = y * W + x;
        if (!ok(i)) continue;
        const b = (Math.hypot(x - cx, y - cy) / BW) | 0;
        if (b >= NB) continue;
        acc[b].n++; acc[b].l += L(px[k], i);
      }
    let best = 0, at = 0;
    for (let b = 1; b < NB; b++) {
      if (!acc[b].n || !acc[b - 1].n) continue;
      const d = Math.abs(acc[b].l / acc[b].n - acc[b - 1].l / acc[b - 1].n);
      if (d > best) { best = d; at = b * BW; }
    }
    console.log(`${k.padEnd(13)} largest radial step ${best.toFixed(1)} L at r=${at}`);
  }
}

// ------------------------------------------------------- (b) second effect
console.log('\n=== (b) SECOND EFFECT: muzzleFlash, same four arms ===');
const m2 = noiseMask('mz-full', 'mz-fullB');
const MX = Number(process.argv[3] ?? 1085), MY = Number(process.argv[4] ?? 503);
console.log(`muzzle centre (projected emit point): ${MX},${MY}`);
{
  const ok = (i) => !inHud(i % W, (i / W) | 0) && !m2[i];
  for (const [label, rad] of [['r<40', 40], ['r<120', 120]]) {
    const acc = { 'mz-full': 0, 'mz-noadd': 0, 'mz-noalpha': 0, 'mz-bare': 0 };
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = (i / W) | 0;
      if (!ok(i) || Math.hypot(x - MX, y - MY) >= rad) continue;
      n++;
      for (const k in acc) acc[k] += L(px[k], i);
    }
    const M = {}; for (const k in acc) M[k] = acc[k] / n;
    const add = M['mz-full'] - M['mz-noadd'];
    const alone = M['mz-bare'] - M['mz-noadd'];
    const inFull = M['mz-noalpha'] - M['mz-full'];
    console.log(`${label} n=${n} full=${M['mz-full'].toFixed(2)} noadd=${M['mz-noadd'].toFixed(2)} noalpha=${M['mz-noalpha'].toFixed(2)} bare=${M['mz-bare'].toFixed(2)}`);
    console.log(`     additive deposit +${add.toFixed(2)} L | alpha alone ${alone >= 0 ? '-' : '+'}${Math.abs(alone).toFixed(2)} L | alpha in full ${inFull >= 0 ? '-' : '+'}${Math.abs(inFull).toFixed(2)} L | add:alpha ${(add / Math.max(Math.abs(alone), 0.01)).toFixed(2)}:1`);
  }
  let n = 0, sumA = 0, sumF = 0, wA = 0, wF = 0, ped = 0, still = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ok(i)) continue;
    const dA = L(px['mz-bare'], i) - L(px['mz-noadd'], i);
    const dF = L(px['mz-noalpha'], i) - L(px['mz-full'], i);
    if (dA > 8) {
      n++; sumA += dA; sumF += dF;
      wA += dA / Math.max(L(px['mz-bare'], i), 1);
      wF += dF / Math.max(L(px['mz-noalpha'], i), 1);
      ped += L(px['mz-noalpha'], i) - L(px['mz-bare'], i);
      if (dF > 8) still++;
    }
  }
  if (n) {
    console.log(`alpha mask ${n} px: alone -${(sumA / n).toFixed(2)} L (Weber ${(wA / n).toFixed(4)}), in composite -${(sumF / n).toFixed(2)} L (Weber ${(wF / n).toFixed(4)}), pedestal +${(ped / n).toFixed(2)} L, contrast retained ${((wF / wA) * 100).toFixed(1)}%, still reading ${still} px (${((still / n) * 100).toFixed(1)}%)`);
  } else console.log('alpha mask empty');
}
