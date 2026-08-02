/**
 * Pixel measurements for the round-6 VFX fixes, read from capture PNGs on disk.
 *
 * Every number this prints names the file it was decoded from, because a VFX
 * number whose source frame is not on disk is a memory, not a measurement (see
 * reviews/round6/BASELINE.md). It decodes the *shipped* capture frames rather
 * than re-rendering, so it cannot drift from what capture.mjs photographed.
 *
 *   node tools/vfxmeasure.mjs blast  <a.png> [b.png ...]
 *   node tools/vfxmeasure.mjs aberr  <a.png> [b.png ...]
 *
 * Decoding is done in headless Chromium, which is already a dependency and is
 * the same decoder the capture pipeline encoded with.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const mode = process.argv[2];
const argv = process.argv.slice(3);
// `--at cx,cy` pins the blast centre. Pinning matters: `08-explosion` is the
// same seed, camera and blast position in every frame compared here, so a
// per-frame centre search would let the two measurements drift onto different
// objects and report the difference as a fix.
const atIdx = argv.indexOf('--at');
const AT = atIdx === -1 ? null : argv[atIdx + 1].split(',').map(Number);
const files = argv.filter((a, i) => atIdx === -1 || (i !== atIdx && i !== atIdx + 1));
if (!mode || !files.length) {
  console.error('usage: node tools/vfxmeasure.mjs <blast|aberr> <png> [png ...]');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

/** Decode a PNG to {w, h, data: Uint8ClampedArray RGBA}. */
async function decode(file) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + src;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height);
    return { w: img.width, h: img.height, data: Array.from(d.data) };
  }, b64);
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Blast profile. The centre is found per-frame rather than read from the
 * manifest: the harness's framing for `08-explosion` is being changed in
 * parallel, so a pinned centre would silently start measuring sky. It is the
 * centroid of the brightest 0.2% of the upper 2/3 of the frame, which is the
 * fireball in every frame this is run on.
 */
function blast({ w, h, data }) {
  if (AT) return blastAt({ w, h, data }, AT[0], AT[1]);
  const yMax = Math.floor(h * 0.66);
  const L = new Float32Array(w * yMax);
  for (let y = 0; y < yMax; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      L[y * w + x] = lum(data[i], data[i + 1], data[i + 2]);
    }
  }
  const sorted = Float32Array.from(L).sort();
  const cut = sorted[Math.floor(sorted.length * 0.998)];
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < yMax; y++) {
    for (let x = 0; x < w; x++) {
      if (L[y * w + x] >= cut) { sx += x; sy += y; n++; }
    }
  }
  return blastAt({ w, h, data }, Math.round(sx / n), Math.round(sy / n));
}

function blastAt({ w, h, data }, cx, cy) {
  // 4 px annuli out to 160 px.
  const NB = 40, BW = 4;
  const acc = Array.from({ length: NB }, () => ({ n: 0, l: 0, over: 0, clip: 0, r: 0, g: 0, b: 0 }));
  let coreN = 0, coreR = 0, coreG = 0, coreB = 0, coreRclip = 0, coreL = 0;
  let discN = 0, discOver = 0, discL = 0, disc250 = 0;
  for (let y = Math.max(0, cy - 160); y < Math.min(h, cy + 160); y++) {
    for (let x = Math.max(0, cx - 160); x < Math.min(w, cx + 160); x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= 160) continue;
      const i = (y * w + x) * 4;
      const R = data[i], G = data[i + 1], B = data[i + 2];
      const l = lum(R, G, B);
      const bi = Math.floor(r / BW);
      const a = acc[bi];
      a.n++; a.l += l; a.r += R; a.g += G; a.b += B;
      if (l > 220) a.over++;
      if (R >= 255 || G >= 255 || B >= 255) a.clip++;
      if (r < 40) { coreN++; coreR += R; coreG += G; coreB += B; coreL += l; if (R >= 255) coreRclip++; }
      if (r < 120) { discN++; discL += l; if (l > 220) discOver++; if (l >= 250) disc250++; }
    }
  }
  // Largest luminance step between adjacent annuli — "is there an edge on this
  // object at all", which is the number the round-3 critic called decisive.
  let maxStep = 0, maxAt = 0;
  for (let i = 1; i < NB; i++) {
    if (!acc[i].n || !acc[i - 1].n) continue;
    const d = Math.abs(acc[i].l / acc[i].n - acc[i - 1].l / acc[i - 1].n);
    if (d > maxStep) { maxStep = d; maxAt = i * BW; }
  }
  // Per-ray gradient. The annulus-mean step above averages *around* the blast,
  // so an edge that is a ring reads as no edge at all unless it is perfectly
  // concentric and perfectly still — which no expanding rim photographed
  // mid-flight ever is. This walks 180 rays out from the centre instead and asks
  // the question the eye asks: on a typical ray, is there anywhere the value
  // falls off a cliff? Reported alongside the annulus number, never instead of
  // it, and computed identically on every frame compared.
  const RAYS = 180, STEP = 4, RMAX = 160;
  const at = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const i = (yi * w + xi) * 4;
    return lum(data[i], data[i + 1], data[i + 2]);
  };
  const rayMax = [];
  for (let k = 0; k < RAYS; k++) {
    const a = (k / RAYS) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    let best = 0;
    for (let r = 0; r + STEP <= RMAX; r += 2) {
      const p = at(cx + ca * r, cy + sa * r);
      const q = at(cx + ca * (r + STEP), cy + sa * (r + STEP));
      if (p == null || q == null) continue;
      const d = Math.abs(q - p);
      if (d > best) best = d;
    }
    rayMax.push(best);
  }
  rayMax.sort((a, b) => a - b);
  const rq = (p) => +rayMax[Math.floor(rayMax.length * p)].toFixed(1);

  return {
    centre: [cx, cy],
    rayGrad: { median: rq(0.5), p25: rq(0.25), p75: rq(0.75) },
    core: {
      rgb: [coreR / coreN, coreG / coreN, coreB / coreN].map((v) => +v.toFixed(1)),
      meanL: +(coreL / coreN).toFixed(1),
      rClipFrac: +(coreRclip / coreN).toFixed(4),
    },
    disc: {
      meanL: +(discL / discN).toFixed(1),
      overL220: +(discOver / discN).toFixed(4),
      overL250: +(disc250 / discN).toFixed(4),
    },
    maxStep: +maxStep.toFixed(1),
    maxStepAtR: maxAt,
    rings: acc.slice(0, 30).map((a, i) => (a.n ? {
      r: i * BW,
      meanL: +(a.l / a.n).toFixed(1),
      clip: +(a.clip / a.n).toFixed(3),
    } : null)).filter(Boolean),
  };
}

/**
 * Radial chromatic aberration, in pixels of R-to-B separation.
 *
 * Per-channel strongest-gradient position on strong vertical edges, exactly the
 * instrument the round-3 critic used. The one thing added is a hard exclusion of
 * the HUD band: the critic's round-2 *withdrawal* of this defect was wrong
 * precisely because it sampled a HUD chamfer, and the HUD is composited after
 * the post stack so it can never carry the effect. Only rows in the 3D-only
 * band are sampled, and every edge is required to be a real edge in G.
 */
function aberr({ w, h, data }, opts = {}) {
  const y0 = opts.y0 ?? 90, y1 = opts.y1 ?? 470;   // 3D-only band, above any HUD
  const MARGIN = 220;                              // width of each margin window
  const ch = (x, y, c) => data[(y * w + x) * 4 + c];
  const grad = (x, y, c) => ch(x + 1, y, c) - ch(x - 1, y, c);

  function scan(xa, xb) {
    const seps = [];
    for (let y = y0; y < y1; y++) {
      for (let x = xa + 8; x < xb - 8; x++) {
        // A strong vertical edge in G, and a local maximum of it, so each
        // physical edge contributes one sample rather than its whole ramp.
        const g0 = Math.abs(grad(x, y, 1));
        if (g0 < 26) continue;
        if (g0 < Math.abs(grad(x - 1, y, 1)) || g0 <= Math.abs(grad(x + 1, y, 1))) continue;
        const arg = [];
        for (const c of [0, 1, 2]) {
          let best = -1, bx = x;
          for (let k = -7; k <= 7; k++) {
            const m = Math.abs(grad(x + k, y, c));
            if (m > best) { best = m; bx = x + k; }
          }
          arg.push({ x: bx, m: best });
        }
        // Both outer channels must show a real edge here too, or the "position"
        // of a channel with no edge is just noise.
        if (arg[0].m < 12 || arg[2].m < 12) continue;
        seps.push(arg[0].x - arg[2].x);
      }
    }
    seps.sort((a, b) => a - b);
    if (!seps.length) return { n: 0 };
    const q = (p) => seps[Math.min(seps.length - 1, Math.floor(seps.length * p))];
    return { n: seps.length, median: q(0.5), p90: q(0.9), absMedian: seps.map(Math.abs).sort((a, b) => a - b)[Math.floor(seps.length * 0.5)] };
  }
  return {
    band: [y0, y1],
    left: scan(0, MARGIN),
    right: scan(w - MARGIN, w),
    centre: scan(Math.floor(w / 2) - 110, Math.floor(w / 2) + 110),
  };
}

for (const f of files) {
  const img = await decode(f);
  const out = mode === 'blast' ? blast(img) : aberr(img);
  console.log(`\n=== ${f} (${img.w}x${img.h}) ===`);
  console.log(JSON.stringify(out, null, 1));
}

await browser.close();
