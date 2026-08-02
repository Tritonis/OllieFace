// Isolated-bright ("salt") fraction, as defined by the round-3 stages critic:
//   a pixel whose luma exceeds the median of its 8 neighbours by more than 25.
// Reported as a percentage of the pixels considered (border pixels excluded).
//
//   node salt.mjs <shotA.png> <shotB.png> [x0 y0 x1 y1]
//   node salt.mjs --selftest
import { readPNG, luma } from './png.mjs';

export function saltFraction(img, roi) {
  const { w, h } = img;
  const L = luma(img);
  const x0 = Math.max(1, roi?.[0] ?? 0), y0 = Math.max(1, roi?.[1] ?? 0);
  const x1 = Math.min(w - 1, roi?.[2] ?? w), y1 = Math.min(h - 1, roi?.[3] ?? h);
  let salt = 0, total = 0, sum = 0;
  const n = new Float32Array(8);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      n[0] = L[i - w - 1]; n[1] = L[i - w]; n[2] = L[i - w + 1];
      n[3] = L[i - 1]; n[4] = L[i + 1];
      n[5] = L[i + w - 1]; n[6] = L[i + w]; n[7] = L[i + w + 1];
      // median of 8 = mean of the 4th and 5th order statistics
      const s = Array.prototype.slice.call(n).sort((a, b) => a - b);
      const med = (s[3] + s[4]) * 0.5;
      if (L[i] - med > 25) salt++;
      sum += L[i];
      total++;
    }
  }
  return { saltPct: (100 * salt) / total, salt, total, meanL: sum / total };
}

function selftest() {
  // Calibration against inputs whose answer is known by construction. The round-2
  // critic's retraction came from trusting an uncalibrated filter, so this runs
  // before any real frame is measured.
  const mk = (w, h, f) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = f(x, y), d = (y * w + x) * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = v; rgba[d + 3] = 255;
    }
    return { w, h, rgba };
  };
  const W = 200, H = 200;
  const interior = (W - 2) * (H - 2);
  const cases = [];

  // 1. Flat field: no isolated brights at all.
  cases.push(['flat 128', saltFraction(mk(W, H, () => 128)).saltPct, 0]);

  // 2. Smooth ramp (max local gradient 1 luma/px): a gradient must not read as salt.
  cases.push(['ramp', saltFraction(mk(W, H, (x) => 20 + x)).saltPct, 0]);

  // 3. Planted isolated specks on a flat field, every 10th pixel in both axes,
  //    +60 luma. Exactly one in 100 interior pixels should be salt.
  const speck = mk(W, H, (x, y) => (x % 10 === 5 && y % 10 === 5 ? 188 : 128));
  cases.push(['1-in-100 specks +60', saltFraction(speck).saltPct, 100 / 100]);

  // 4. Same specks at +20, below the 25-luma threshold: must score zero.
  const weak = mk(W, H, (x, y) => (x % 10 === 5 && y % 10 === 5 ? 148 : 128));
  cases.push(['1-in-100 specks +20', saltFraction(weak).saltPct, 0]);

  // 5. A hard step edge (half black, half white). An edge is not salt: on the
  //    bright side of the boundary a pixel's 8-neighbour median is also bright.
  cases.push(['step edge', saltFraction(mk(W, H, (x) => (x < 100 ? 10 : 240))).saltPct, 0]);

  // 6. Bright 1px-wide vertical lines every 10 px. These are NOT isolated in y,
  //    but each pixel's 8-neighbourhood has 6 dark and 2 bright members, so the
  //    median is dark and the line does score. Known answer: 1 column in 10.
  cases.push(['1px lines every 10', saltFraction(mk(W, H, (x) => (x % 10 === 5 ? 200 : 120))).saltPct, 10]);

  // 7. A 3x3 bright block every 12 px: a *resolved* feature. Only its 4 corner
  //    pixels score (3 of their 8 neighbours are bright, so the median is dark).
  //    The centre has 8 bright neighbours and each edge-midpoint has 5, so both
  //    have a bright median. 4/144 = 2.78%. A resolved 3x3 feature therefore
  //    contributes about a quarter of what the same area of 1px specks would:
  //    the statistic does discriminate resolved detail from sub-pixel detail.
  const blk = mk(W, H, (x, y) => (x % 12 >= 5 && x % 12 <= 7 && y % 12 >= 5 && y % 12 <= 7 ? 200 : 120));
  cases.push(['3x3 blocks every 12', saltFraction(blk).saltPct, (4 / 144) * 100]);

  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = Math.abs(got - want) < 0.25;
    if (!pass) ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} got ${got.toFixed(3)}%  want ~${want.toFixed(3)}%`);
  }
  console.log(`interior px = ${interior}`);
  process.exit(ok ? 0 : 1);
}

const argv = process.argv[1]?.endsWith('salt.mjs') ? process.argv.slice(2) : [];
if (argv[0] === '--selftest') selftest();
else if (argv.length) {
  const roi = argv.length >= 6 ? argv.slice(2, 6).map(Number) : null;
  const label = roi ? `roi ${roi.join(',')}` : 'full frame';
  for (const f of [argv[0], argv[1]].filter(Boolean)) {
    const r = saltFraction(readPNG(f), roi);
    console.log(`${f}  ${label}  salt ${r.saltPct.toFixed(3)}%  (${r.salt}/${r.total})  meanL ${r.meanL.toFixed(2)}`);
  }
}
