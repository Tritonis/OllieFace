// Every number the round-6 stages report quotes, in one run, each line naming
// the file it was decoded from.
//   node report.mjs <fixDir>
import { readPNG } from './png.mjs';
import { saltFraction } from './salt.mjs';

const FIX = process.argv[2] ?? 'reviews/round6/stages';
const ARMS = [
  ['OFF  base', 'reviews/round6/base'],
  ['PRE  nogate', 'reviews/round6/detPRE'],
  ['ON   gated', 'reviews/round6/detON'],
  ['FIX', FIX],
];
const SHOTS = ['13-biomes-1', '13-biomes-2', '13-biomes-3', '13-biomes-4', '02-vista', '07-interactables'];
const ROIS = [
  ['b1 far mountain', '13-biomes-1', [300, 422, 425, 456]],
  ['b1 near mesa', '13-biomes-1', [520, 620, 880, 760]],
  ['b2 far spires', '13-biomes-2', [1090, 45, 1250, 145]],
];

console.log('== frame-wide isolated-bright fraction');
for (const s of SHOTS) {
  for (const [label, dir] of ARMS) {
    const f = `${dir}/${s}.png`;
    try {
      console.log(`  ${s.padEnd(17)} ${label.padEnd(12)} ${saltFraction(readPNG(f)).saltPct.toFixed(3)}%   ${f}`);
    } catch { console.log(`  ${s.padEnd(17)} ${label.padEnd(12)} --       ${f} (missing)`); }
  }
}
for (const [name, shot, roi] of ROIS) {
  console.log(`== ${name}  roi ${roi.join(',')}`);
  for (const [label, dir] of ARMS) {
    const f = `${dir}/${shot}.png`;
    try {
      const r = saltFraction(readPNG(f), roi);
      console.log(`  ${label.padEnd(12)} ${r.saltPct.toFixed(3)}%  (${r.salt}/${r.total})   ${f}`);
    } catch { console.log(`  ${label.padEnd(12)} --   ${f} (missing)`); }
  }
}
