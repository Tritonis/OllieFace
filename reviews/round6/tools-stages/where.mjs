// Where is the salt? Per-tile isolated-bright fraction, two captures side by
// side, sorted by the biggest absolute rise.
//   node where.mjs <dirA> <dirB> <shot> [tile=50] [top=15]
import { readPNG } from './png.mjs';
import { saltFraction } from './salt.mjs';

const [dirA, dirB, shot, tileS = '50', topS = '15'] = process.argv.slice(2);
const T = Number(tileS), TOP = Number(topS);
const A = readPNG(`${dirA}/${shot}.png`), B = readPNG(`${dirB}/${shot}.png`);
const rows = [];
for (let y = 0; y + T <= A.h; y += T) {
  for (let x = 0; x + T <= A.w; x += T) {
    const roi = [x, y, x + T, y + T];
    const a = saltFraction(A, roi).saltPct, b = saltFraction(B, roi).saltPct;
    rows.push({ x, y, a, b, d: b - a });
  }
}
rows.sort((p, q) => q.d - p.d);
console.log(`${dirA} -> ${dirB}  ${shot}  tiles ${T}px  (top ${TOP} by rise)`);
for (const r of rows.slice(0, TOP)) {
  console.log(`  x ${String(r.x).padStart(4)} y ${String(r.y).padStart(4)}   ${r.a.toFixed(2)}% -> ${r.b.toFixed(2)}%   +${r.d.toFixed(2)}`);
}
