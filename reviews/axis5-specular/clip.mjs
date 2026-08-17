import { readPNG, luma } from '../round6/tools-stages/png.mjs';
for (const d of ['before', 'after']) {
  const img = readPNG(`reviews/axis5-specular/${d}/13-biomes-1.png`);
  const L = luma(img); const W = img.w;
  let anyc = 0, allc = 0, l255 = 0, l250 = 0, n = 0;
  for (let y = 540; y < 620; y++) for (let x = 520; x < 880; x++) {
    const i = y * W + x, o = i * 4; n++;
    const r = img.rgba[o], g = img.rgba[o + 1], b = img.rgba[o + 2];
    if (r >= 255 || g >= 255 || b >= 255) anyc++;
    if (r >= 255 && g >= 255 && b >= 255) allc++;
    if (L[i] >= 255) l255++;
    if (L[i] >= 250) l250++;
  }
  console.log(d, 'anyCh', (anyc / n * 100).toFixed(3), 'allCh', (allc / n * 100).toFixed(3),
    'luma255', (l255 / n * 100).toFixed(3), 'luma>=250', (l250 / n * 100).toFixed(3));
}
