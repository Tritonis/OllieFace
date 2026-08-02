// Round-3's mortar-course instrument, re-implemented: Hann-windowed vertical
// power spectrum of column-averaged luma, restricted to a 4-40 px period band.
// Reports the dominant period and the three-bin peak's share of in-band power.
// Hewn stone should show a sharp peak (>=40%); natural rock should stay broad.
//   node spec.mjs <png> x0 y0 x1 y1
//   node spec.mjs --selftest
import { readPNG, luma } from './png.mjs';

export function vspec(img, [x0, y0, x1, y1]) {
  const h = y1 - y0, w = x1 - x0;
  const col = new Float64Array(h);
  const L = luma(img);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += L[(y0 + y) * img.w + x0 + x];
    col[y] = s / w;
  }
  let mean = 0;
  for (let y = 0; y < h; y++) mean += col[y];
  mean /= h;
  for (let y = 0; y < h; y++) col[y] = (col[y] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (h - 1)));
  const power = [];
  for (let k = 1; k < h / 2; k++) {
    let re = 0, im = 0;
    for (let y = 0; y < h; y++) {
      const a = (-2 * Math.PI * k * y) / h;
      re += col[y] * Math.cos(a); im += col[y] * Math.sin(a);
    }
    power.push({ k, period: h / k, p: re * re + im * im });
  }
  const band = power.filter((b) => b.period >= 4 && b.period <= 40);
  const total = band.reduce((a, b) => a + b.p, 0);
  let best = band[0];
  for (const b of band) if (b.p > best.p) best = b;
  const i = band.indexOf(best);
  const peak3 = [band[i - 1], band[i], band[i + 1]].filter(Boolean).reduce((a, b) => a + b.p, 0);
  return { period: best.period, conc: total > 0 ? peak3 / total : 0, total };
}

function selftest() {
  const mk = (w, h, f) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, f(x, y))), d = (y * w + x) * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = v; rgba[d + 3] = 255;
    }
    return { w, h, rgba };
  };
  const roi = [0, 0, 64, 192];
  // A pure 12 px vertical stripe: the period must come back as 12 and the peak
  // must hold nearly all in-band power.
  const a = vspec(mk(64, 192, (x, y) => 128 + 60 * Math.cos((2 * Math.PI * y) / 12)), roi);
  // White noise: no period should dominate.
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const b = vspec(mk(64, 192, () => 128 + 60 * (rnd() - 0.5)), roi);
  const cases = [
    ['12px stripe period', a.period, 12, 0.5],
    ['12px stripe conc', a.conc, 1.0, 0.08],
    ['white noise conc', b.conc, 0.10, 0.10],
  ];
  let ok = true;
  for (const [n, got, want, tol] of cases) {
    const pass = Math.abs(got - want) <= tol;
    if (!pass) ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${n.padEnd(20)} got ${got.toFixed(3)}  want ${want}±${tol}`);
  }
  process.exit(ok ? 0 : 1);
}

const argv = process.argv[1]?.endsWith('spec.mjs') ? process.argv.slice(2) : [];
if (argv[0] === '--selftest') selftest();
else if (argv.length >= 5) {
  const r = vspec(readPNG(argv[0]), argv.slice(1, 5).map(Number));
  console.log(`${argv[0]}  roi ${argv.slice(1, 5).join(',')}  dominant ${r.period.toFixed(1)} px  conc ${(r.conc * 100).toFixed(1)}%`);
}
