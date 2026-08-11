// Frame-PEAK comparison across two capture directories.
//
//   node reviews/round7/tools/fixcompare.mjs <dirA> <dirB> [labelA] [labelB]
//
// Reports frame-wide PEAK for every shot present in both directories, plus the
// delta in percentage points and as a multiple. The harness is not bit-exact,
// so a delta only means something against the control pair's own spread — run
// this on two same-tree captures first to learn that floor, then on the fix.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readPNG, luma } from '../../round6/tools-stages/png.mjs';

export function framePeak(file) {
  const img = readPNG(file);
  const { w, h } = img;
  const L = luma(img);
  let hits = 0, tot = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = Math.max(L[i - w - 1], L[i - w], L[i - w + 1], L[i - 1], L[i + 1],
                         L[i + w - 1], L[i + w], L[i + w + 1]);
      if (L[i] - m > 25) hits++;
      tot++;
    }
  }
  return (100 * hits) / tot;
}

const [dirA, dirB, labA = 'A', labB = 'B'] = process.argv.slice(2);
const shots = readdirSync(dirA).filter((f) => f.endsWith('.png'))
  .filter((f) => readdirSync(dirB).includes(f)).sort();

console.log(`| shot | ${labA} | ${labB} | delta pp | delta % |`);
console.log('|---|---:|---:|---:|---:|');
for (const s of shots) {
  const a = framePeak(path.join(dirA, s));
  const b = framePeak(path.join(dirB, s));
  const pp = b - a;
  const rel = a > 1e-9 ? (100 * pp) / a : 0;
  console.log(`| ${s.replace(/\.png$/, '')} | ${a.toFixed(4)}% | ${b.toFixed(4)}% | ${pp >= 0 ? '+' : ''}${pp.toFixed(4)} | ${rel >= 0 ? '+' : ''}${rel.toFixed(1)}% |`);
}
