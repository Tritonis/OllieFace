// Axis 5 specular measurement. Instrument: reviews/round6/tools-stages/png.mjs
// reused verbatim for decode + luma, exactly as the #100 re-score did, so the
// numbers are comparable to reviews/axis5-rescore/SCORE.md.
import { readPNG, luma } from '../round6/tools-stages/png.mjs';
import path from 'node:path';

const ROIS = [
  ['13-biomes-1', 'mesa top', 520, 540, 880, 620],
  ['13-biomes-1', 'hero arch', 660, 140, 1000, 480],
  ['07-interactables', 'chest body', 600, 560, 1050, 820],
  ['07-interactables', 'ground', 200, 700, 1400, 880],
  ['13-biomes-4', 'containers R', 700, 480, 1400, 760],
  ['02-vista', 'right cliff', 900, 520, 1500, 880],
];

function stats(img, x0, y0, x1, y1) {
  const L = luma(img);
  const W = img.w;
  const vals = [];
  const uniq = new Set();
  let clip = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const v = L[i];
      vals.push(v); uniq.add(Math.round(v)); n++;
      const o = i * 4;
      // Any channel at 255, which is the definition reviews/axis5-rescore
      // used: it reproduces that report's 1.601% on b1's mesa top as 1.580%
      // on a fresh unmodified capture.
      if (img.rgba[o] >= 255 || img.rgba[o + 1] >= 255 || img.rgba[o + 2] >= 255) clip++;
    }
  }
  // High-frequency sd: residual after a 9x9 box blur, same construction as
  // round 6's HF sd.
  let acc = 0, cnt = 0;
  const R = 4;
  for (let y = y0 + R; y < y1 - R; y++) {
    for (let x = x0 + R; x < x1 - R; x++) {
      let s = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) s += L[(y + dy) * W + x + dx];
      const d = L[y * W + x] - s / ((2 * R + 1) ** 2);
      acc += d * d; cnt++;
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  // Peak-to-plateau: the top 0.1% mean minus the median. A specular lobe is a
  // peak above its own surface; a flat colour has none.
  const sorted = [...vals].sort((a, b) => a - b);
  const med = sorted[Math.floor(n / 2)];
  const top = sorted.slice(Math.floor(n * 0.999));
  const peak = top.reduce((a, b) => a + b, 0) / top.length;
  return {
    uniq: uniq.size, mean: mean.toFixed(1), sd: sd.toFixed(2),
    hf: Math.sqrt(acc / cnt).toFixed(2),
    clip255: ((clip / n) * 100).toFixed(3),
    lobe: (peak - med).toFixed(1),
  };
}

const dirs = process.argv.slice(2);
const rows = [];
for (const [shot, name, ...box] of ROIS) {
  const r = { shot, roi: name };
  for (const d of dirs) {
    const img = readPNG(path.join(d, `${shot}.png`));
    const s = stats(img, ...box);
    for (const k in s) r[`${path.basename(d)}.${k}`] = s[k];
  }
  rows.push(r);
}
for (const r of rows) {
  console.log(`${r.shot} / ${r.roi}`);
  for (const d of dirs) {
    const b = path.basename(d);
    console.log(`   ${b.padEnd(7)} uniq ${String(r[`${b}.uniq`]).padStart(3)}  mean ${String(r[`${b}.mean`]).padStart(5)}  sd ${String(r[`${b}.sd`]).padStart(6)}  HF ${String(r[`${b}.hf`]).padStart(6)}  clip255 ${String(r[`${b}.clip255`]).padStart(7)}%  lobe ${String(r[`${b}.lobe`]).padStart(6)}`);
  }
}
