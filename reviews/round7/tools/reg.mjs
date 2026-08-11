// Framing identity check between two captures of the same shot.
//
//   node reviews/round7/tools/reg.mjs <a.png> <b.png>
//
// Two arms of the same scenario are only comparable ROI-for-ROI if the camera
// did not move. Block-mean luma cannot tell a re-framing from an exposure
// change (the round-4 world critic's `w4frame.mjs` was withdrawn for exactly
// that), so this registers on *structure* instead: a Sobel edge magnitude map,
// mean-removed and variance-normalised per image, cross-correlated over integer
// shifts. An exposure or material change leaves the edge positions alone and
// peaks at (0,0); a camera move peaks somewhere else.
import { readPNG, luma } from '../../round6/tools-stages/png.mjs';

function edges(img) {
  const { w, h } = img;
  const L = luma(img);
  const e = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1])
               - (L[i - w - 1] + 2 * L[i - 1] + L[i + w - 1]);
      const gy = (L[i + w - 1] + 2 * L[i + w] + L[i + w + 1])
               - (L[i - w - 1] + 2 * L[i - w] + L[i - w + 1]);
      e[i] = Math.hypot(gx, gy);
    }
  }
  let m = 0;
  for (let i = 0; i < e.length; i++) m += e[i];
  m /= e.length;
  let v = 0;
  for (let i = 0; i < e.length; i++) { e[i] -= m; v += e[i] * e[i]; }
  v = Math.sqrt(v / e.length) || 1;
  for (let i = 0; i < e.length; i++) e[i] /= v;
  return e;
}

const [fa, fb, ...rest] = process.argv.slice(2);
const A = readPNG(fa), B = readPNG(fb);
if (A.w !== B.w || A.h !== B.h) throw new Error('size mismatch');
const ea = edges(A), eb = edges(B);
const R = Number(rest[0] ?? 6);
const M = 60;                        // margin, so every shift has full support
let best = null;
const rows = [];
for (let dy = -R; dy <= R; dy++) {
  for (let dx = -R; dx <= R; dx++) {
    let s = 0, n = 0;
    for (let y = M; y < A.h - M; y += 2) {
      for (let x = M; x < A.w - M; x += 2) {
        s += ea[y * A.w + x] * eb[(y + dy) * A.w + (x + dx)]; n++;
      }
    }
    const c = s / n;
    if (!best || c > best.c) best = { dx, dy, c };
    if (dx === 0 && dy === 0) rows.push(['(0,0)', c]);
  }
}
console.log(`${fa}\n${fb}`);
console.log(`  correlation at (0,0)      ${rows[0][1].toFixed(4)}`);
console.log(`  best shift (${best.dx},${best.dy})  ${best.c.toFixed(4)}`);
// Mean luma, so an exposure change is visible next to the registration.
const la = luma(A), lb = luma(B);
let sa = 0, sb = 0;
for (let i = 0; i < la.length; i++) { sa += la[i]; sb += lb[i]; }
console.log(`  mean L  ${(sa / la.length).toFixed(2)}  vs  ${(sb / lb.length).toFixed(2)}`);
