// Plumbing sanity check ONLY. Two partial runs, so these numbers can never
// accept a fix — the single question they answer is whether the rMin uniform
// can change a pixel at all.
import { readPNG, luma } from '../round6/tools-stages/png.mjs';
for (const d of ['after2', 'probe-rmin90']) {
  const img = readPNG(`reviews/axis5-specular/${d}/13-biomes-1.png`);
  const L = luma(img); const W = img.w;
  let clip = 0, n = 0, sum = 0;
  for (let y = 540; y < 620; y++) for (let x = 520; x < 880; x++) {
    const i = y * W + x, o = i * 4; n++; sum += L[i];
    if (img.rgba[o] >= 255 || img.rgba[o + 1] >= 255 || img.rgba[o + 2] >= 255) clip++;
  }
  console.log(d.padEnd(14), 'mesa-top clip255', (clip / n * 100).toFixed(3) + '%',
    ' mean luma', (sum / n).toFixed(1));
}
