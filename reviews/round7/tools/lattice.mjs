// Lattice / PEAK diagnostic for the b2 far-spire ROI.
//
//   node reviews/round7/tools/lattice.mjs <png> <x0> <y0> <x1> <y1>
//
// PEAK is the round-4 world critic's definition, reproduced here so its numbers
// can be checked against this file: a pixel whose luma exceeds the MAXIMUM of
// its 8 neighbours by more than 25. It fires only on single-pixel peaks and
// calibrates to 0.000% on resolved 2x2 / 3x3 relief.
//
// The lattice half is new: high-pass the ROI (subtract a 5x5 box mean), then
// take the 1-D autocorrelation of the high-pass along x and along y, averaged
// over rows / columns. A stochastic aliasing field decorrelates at lag 1 and
// stays near zero; a spatially periodic artefact (a tiling, or a mesh facet
// grid) puts a positive bump at its period.
import { readPNG, luma } from '../../round6/tools-stages/png.mjs';

export function peakFraction(img, roi) {
  const { w, h } = img;
  const L = luma(img);
  const x0 = Math.max(1, roi[0]), y0 = Math.max(1, roi[1]);
  const x1 = Math.min(w - 1, roi[2]), y1 = Math.min(h - 1, roi[3]);
  let peak = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const m = Math.max(
        L[i - w - 1], L[i - w], L[i - w + 1],
        L[i - 1], L[i + 1],
        L[i + w - 1], L[i + w], L[i + w + 1]);
      if (L[i] - m > 25) peak++;
      total++;
    }
  }
  return { peakPct: (100 * peak) / total, peak, total };
}

/** ROI luma high-passed against a (2r+1)^2 box mean. */
function highpass(img, roi, r = 2) {
  const { w } = img;
  const L = luma(img);
  const [x0, y0, x1, y1] = roi;
  const W = x1 - x0, H = y1 - y0;
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const sx = x0 + x + dx, sy = y0 + y + dy;
          if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
          s += L[sy * w + sx]; n++;
        }
      }
      out[y * W + x] = L[(y0 + y) * w + (x0 + x)] - s / n;
    }
  }
  return { hp: out, W, H };
}

/** Mean normalised autocorrelation of the high-pass, per axis, lags 1..maxLag. */
export function autocorr(img, roi, maxLag = 40, r = 2) {
  const { hp, W, H } = highpass(img, roi, r);
  const ax = new Float64Array(maxLag + 1);
  const ay = new Float64Array(maxLag + 1);
  let var0 = 0;
  for (let i = 0; i < hp.length; i++) var0 += hp[i] * hp[i];
  var0 /= hp.length;
  for (let k = 1; k <= maxLag; k++) {
    let sx = 0, nx = 0, sy = 0, ny = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x + k < W; x++) { sx += hp[y * W + x] * hp[y * W + x + k]; nx++; }
    }
    for (let y = 0; y + k < H; y++) {
      for (let x = 0; x < W; x++) { sy += hp[y * W + x] * hp[(y + k) * W + x]; ny++; }
    }
    ax[k] = sx / nx / var0;
    ay[k] = sy / ny / var0;
  }
  return { ax, ay, var0, W, H };
}

function selftest() {
  const mk = (w, h, f) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = f(x, y), d = (y * w + x) * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = v; rgba[d + 3] = 255;
    }
    return { w, h, rgba };
  };
  const W = 200, H = 200, roi = [1, 1, W - 1, H - 1];
  const rows = [];
  // PEAK calibration, same four inputs the round-4 critic published.
  rows.push(['flat 128', peakFraction(mk(W, H, () => 128), roi).peakPct, 0]);
  rows.push(['ramp', peakFraction(mk(W, H, (x) => 20 + x), roi).peakPct, 0]);
  rows.push(['1-in-100 specks +60',
    peakFraction(mk(W, H, (x, y) => (x % 10 === 5 && y % 10 === 5 ? 188 : 128)), roi).peakPct, 1.02]);
  rows.push(['2x2 blocks every 12',
    peakFraction(mk(W, H, (x, y) => (x % 12 < 2 && y % 12 < 2 ? 188 : 128)), roi).peakPct, 0]);
  rows.push(['3x3 blocks every 12',
    peakFraction(mk(W, H, (x, y) => (x % 12 < 3 && y % 12 < 3 ? 188 : 128)), roi).peakPct, 0]);
  for (const [n, got, want] of rows) {
    console.log(`${n.padEnd(24)} PEAK ${got.toFixed(3)}%   expect ${want.toFixed(3)}%`);
  }
  // Autocorrelation calibration: white noise must decorrelate; a planted grid at
  // period 10 must put its largest lag>=3 bump at 10.
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const noise = mk(W, H, () => 128 + (rnd() - 0.5) * 40);
  const grid = mk(W, H, (x, y) => 128 + (x % 10 === 0 || y % 10 === 0 ? 30 : 0));
  for (const [n, img] of [['white noise', noise], ['grid period 10', grid]]) {
    const { ax, ay } = autocorr(img, roi, 24);
    const best = (a) => { let b = 3; for (let k = 4; k <= 24; k++) if (a[k] > a[b]) b = k; return b; };
    console.log(`${n.padEnd(24)} peak lag x=${best(ax)} (${ax[best(ax)].toFixed(3)})  y=${best(ay)} (${ay[best(ay)].toFixed(3)})`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--selftest') { selftest(); }
else if (args.length >= 5) {
  const [file, ...r] = args;
  const roi = r.slice(0, 4).map(Number);
  const img = readPNG(file);
  const p = peakFraction(img, roi);
  const { ax, ay } = autocorr(img, roi, 40);
  console.log(`${file}  ROI ${roi.join(' ')}  n=${p.total}`);
  console.log(`  PEAK ${p.peakPct.toFixed(3)}%  (${p.peak})`);
  const fmt = (a) => Array.from(a.slice(1, 25)).map((v, i) => `${i + 1}:${v.toFixed(3)}`).join(' ');
  console.log(`  acf x  ${fmt(ax)}`);
  console.log(`  acf y  ${fmt(ay)}`);
  const best = (a) => { let b = 3; for (let k = 4; k <= 40; k++) if (a[k] > a[b]) b = k; return b; };
  console.log(`  strongest lag>=3   x=${best(ax)} (${ax[best(ax)].toFixed(3)})   y=${best(ay)} (${ay[best(ay)].toFixed(3)})`);
} else {
  console.log('usage: lattice.mjs <png> x0 y0 x1 y1   |   --selftest');
}
