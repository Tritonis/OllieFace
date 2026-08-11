// Worst-window PEAK scan over a whole frame.
//
//   node reviews/round7/tools/peakscan.mjs <png> [win] [stride]
//
// A named ROI only reports on the surface it was drawn around. When the frame
// under it changes, the ROI stops being a measurement of the defect and starts
// being a measurement of wherever it happens to land — so before believing that
// a PEAK failure has gone away, scan for the worst window anywhere in frame.
// Reports the top windows by PEAK, plus the frame-wide figure.
import { readPNG, luma } from '../../round6/tools-stages/png.mjs';

const [file, winArg, strideArg] = process.argv.slice(2);
const WIN = Number(winArg ?? 180);
const STRIDE = Number(strideArg ?? 60);
const img = readPNG(file);
const { w, h } = img;
const L = luma(img);

// Per-pixel PEAK flag once, then integral-image the flags so every window is
// an O(1) lookup rather than a rescan.
const flag = new Uint8Array(w * h);
let frameHits = 0, frameTot = 0;
for (let y = 1; y < h - 1; y++) {
  for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const m = Math.max(L[i - w - 1], L[i - w], L[i - w + 1], L[i - 1], L[i + 1],
                       L[i + w - 1], L[i + w], L[i + w + 1]);
    if (L[i] - m > 25) { flag[i] = 1; frameHits++; }
    frameTot++;
  }
}
const I = new Int32Array((w + 1) * (h + 1));
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    I[(y + 1) * (w + 1) + x + 1] = flag[y * w + x]
      + I[y * (w + 1) + x + 1] + I[(y + 1) * (w + 1) + x] - I[y * (w + 1) + x];
  }
}
const sum = (x0, y0, x1, y1) =>
  I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];

const out = [];
for (let y = 1; y + WIN < h - 1; y += STRIDE) {
  for (let x = 1; x + WIN < w - 1; x += STRIDE) {
    const n = sum(x, y, x + WIN, y + WIN);
    out.push({ x, y, pct: (100 * n) / (WIN * WIN), n });
  }
}
out.sort((a, b) => b.pct - a.pct);
console.log(`${file}  ${w}x${h}  win ${WIN} stride ${STRIDE}`);
console.log(`  frame PEAK ${(100 * frameHits / frameTot).toFixed(4)}%  (${frameHits}/${frameTot})`);
for (const r of out.slice(0, 6)) {
  console.log(`  x${r.x}-${r.x + WIN} y${r.y}-${r.y + WIN}  PEAK ${r.pct.toFixed(3)}%  (${r.n})`);
}
