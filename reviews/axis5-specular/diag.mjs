import { readPNG } from '../round6/tools-stages/png.mjs';

// Which channel is at 255 on b1's mesa top, and how bright are those pixels?
{
  const img = readPNG('reviews/axis5-specular/before/13-biomes-1.png');
  const W = img.w;
  let cr = 0, cg = 0, cb = 0, n = 0, sum = [0, 0, 0], cn = 0;
  for (let y = 540; y < 620; y++) for (let x = 520; x < 880; x++) {
    const o = (y * W + x) * 4; n++;
    const r = img.rgba[o], g = img.rgba[o + 1], b = img.rgba[o + 2];
    if (r >= 255) cr++; if (g >= 255) cg++; if (b >= 255) cb++;
    if (r >= 255 || g >= 255 || b >= 255) { sum[0] += r; sum[1] += g; sum[2] += b; cn++; }
  }
  console.log('b1 mesa clipped-px: R', (cr / n * 100).toFixed(3), 'G', (cg / n * 100).toFixed(3),
    'B', (cb / n * 100).toFixed(3));
  console.log('  mean RGB of clipped px:', sum.map((s) => (s / cn).toFixed(0)).join(' '));
}

// 13-biomes-4: scan the whole frame for the container band and report the
// brightest 0.1% of pixels, so "is there a lobe anywhere" is answered from
// pixels rather than from a guessed box.
for (const d of ['before', 'after']) {
  const img = readPNG(`reviews/axis5-specular/${d}/13-biomes-4.png`);
  const W = img.w, H = img.h;
  const v = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    v.push(Math.max(img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]));
  }
  v.sort((a, b) => a - b);
  const p = (q) => v[Math.floor(v.length * q)];
  console.log(`b4 ${d} maxch percentiles  p50 ${p(0.5)}  p90 ${p(0.9)}  p99 ${p(0.99)}  p999 ${p(0.999)}  max ${v[v.length - 1]}`);
}
