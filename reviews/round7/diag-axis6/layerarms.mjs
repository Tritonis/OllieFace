/**
 * Additive-vs-alpha layer decomposition on one frozen `08-explosion` frame.
 *
 * Method is `tools/vfxprobe.mjs`'s and nothing about it is new: compose the shot
 * ONCE, freeze it, then re-render that single frame N times with one thing
 * toggled. Here the toggle is `layer.mesh.visible`, which touches no RNG stream
 * (emission has already happened, identically, in every arm) and no simulation
 * state -- so a diff between arms is the blend layer and nothing else.
 *
 * Arms:
 *   full     both particle layers visible          (the shipped composite)
 *   fullB    identical re-render of `full`          (determinism calibration)
 *   noadd    additive layer hidden                  (alpha over scene)
 *   noalpha  alpha layer hidden                     (additive over scene)
 *   bare     both hidden                            (scene bed)
 *   half     additive uIntensity 1.35 -> 0.675      (known-input calibration)
 *
 * node layerarms.mjs [--seed 1337] [--port 5303] [--out <dir>]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5303);
const ROOT = path.resolve(args.root ?? '.');
const OUT = path.resolve(args.out ?? 'shots-layerarms');
const W = 1600, H = 900;
const KEYS = ['full', 'fullB', 'noadd', 'noalpha', 'bare', 'half'];

const server = await createServer({
  root: ROOT,
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__.explosion());

const blast = await page.evaluate(() => {
  const ctx = globalThis.__GAME__.ctx;
  const b = ctx.vfx._blasts.reduce((a, x) => (a && a.radius >= x.radius ? a : x), null);
  if (!b) return null;
  const v = new globalThis.__GAME__.THREE.Vector3(b.x, b.y, b.z).project(ctx.camera);
  return {
    world: [b.x, b.y, b.z], radius: b.radius,
    x: Math.round((v.x + 1) * 0.5 * innerWidth),
    y: Math.round((1 - v.y) * 0.5 * innerHeight),
  };
});
if (!blast) { console.error('no blast record'); process.exit(2); }
console.log('blast', JSON.stringify(blast));

// Live per-layer particle census on the frozen frame, so the pixel numbers can
// be read against how many sprites of each layer are actually alive.
const census = await page.evaluate(() => {
  const L = globalThis.__GAME__.ctx.vfx.particles.layers;
  const out = {};
  for (const name in L) {
    const l = L[name];
    const t = l.attrs.aTime.array;
    let alive = 0;
    for (let i = 0; i < l.capacity; i++) if (t[i * 2 + 1] > 0) alive++;
    out[name] = {
      alive, capacity: l.capacity,
      intensity: l.mat.uniforms.uIntensity.value,
      maxIntensity: l.mat.uniforms.uMaxIntensity.value,
      lensFloor: l.mat.uniforms.uLensFloor.value,
      renderOrder: l.mesh.renderOrder,
      blending: l.mat.blending,
      depthWrite: l.mat.depthWrite,
      depthTest: l.mat.depthTest,
    };
  }
  return out;
});
console.log('census', JSON.stringify(census, null, 1));

await mkdir(OUT, { recursive: true });
const shots = {};
for (const key of KEYS) {
  await page.evaluate((key) => {
    const ctx = globalThis.__GAME__.ctx;
    const L = ctx.vfx.particles.layers;
    const undo = [];
    const hide = (l) => { l.mesh.visible = false; undo.push(() => { l.mesh.visible = true; }); };
    if (key === 'noadd') hide(L.add);
    else if (key === 'noalpha') hide(L.alpha);
    else if (key === 'bare') { hide(L.add); hide(L.alpha); }
    else if (key === 'half') {
      const u = L.add.mat.uniforms.uIntensity;
      const was = u.value;
      u.value = was * 0.5;
      undo.push(() => { u.value = was; });
    }
    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
    globalThis.__UNDO__ = undo;
  }, key);
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `arm-${key}.png`), buf);
  shots[key] = `data:image/png;base64,${buf.toString('base64')}`;
  await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  console.log(`rendered ${key}`);
}

const analysis = await page.evaluate(async ({ shots, w, h, blast }) => {
  const load = (url) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = url; });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const px = {};
  for (const [k, url] of Object.entries(shots)) {
    g.clearRect(0, 0, w, h);
    g.drawImage(await load(url), 0, 0);
    px[k] = g.getImageData(0, 0, w, h).data;
  }
  const L = (d, i) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  const inHud = (x, y) => y > h - 130 || (y < 110 && (x < 280 || x > 1400)) || (x > 1180 && y > 740);

  // Max absolute per-pixel difference between two arms (calibration).
  const maxAbs = (a, b) => {
    let m = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      const d = Math.abs(L(px[a], i) - L(px[b], i));
      if (d > m) m = d;
      if (d > 0.5) n++;
    }
    return { maxAbsDeltaL: +m.toFixed(3), pxOver0p5: n };
  };

  // Region means. `disc` = the fireball, `skirt` = the annulus the dust skirt
  // and smoke column occupy, `frame` = everything outside the HUD.
  const regions = {
    core: (x, y) => Math.hypot(x - blast.x, y - blast.y) < 40,
    disc: (x, y) => Math.hypot(x - blast.x, y - blast.y) < 120,
    skirt: (x, y) => {
      const r = Math.hypot(x - blast.x, y - blast.y);
      return r >= 120 && r < 260;
    },
    frame: () => true,
  };
  const means = {};
  for (const [rn, test] of Object.entries(regions)) {
    means[rn] = { n: 0 };
    const acc = {};
    for (const k of Object.keys(px)) acc[k] = 0;
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      const x = i % w, y = (i / w) | 0;
      if (inHud(x, y) || !test(x, y)) continue;
      n++;
      for (const k of Object.keys(px)) acc[k] += L(px[k], i);
    }
    means[rn].n = n;
    for (const k of Object.keys(px)) means[rn][k] = +(acc[k] / n).toFixed(2);
  }

  // Per-pixel survival of the alpha layer's darkening.
  //
  // `alone`  = how much the alpha layer darkens the bare scene   (bare - noadd)
  // `inFull` = how much it darkens the finished composite     (noalpha - full)
  // Same sprites, same pixels; the only difference is whether the additive sum
  // is underneath. A pixel counts as "reading" if the darkening is over 8 L,
  // which is roughly where a step becomes visible on a mid-tone.
  let aloneN = 0, aloneSum = 0, inFullN = 0, inFullSum = 0, pairedSum = 0, pairedN = 0;
  let weberAloneSum = 0, weberFullSum = 0;
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    if (inHud(x, y)) continue;
    const dAlone = L(px.bare, i) - L(px.noadd, i);
    const dFull = L(px.noalpha, i) - L(px.full, i);
    if (dAlone > 8) { aloneN++; aloneSum += dAlone; }
    if (dFull > 8) { inFullN++; inFullSum += dFull; }
    if (dAlone > 8) {
      pairedN++; pairedSum += dFull;
      weberAloneSum += dAlone / Math.max(L(px.bare, i), 1);
      weberFullSum += dFull / Math.max(L(px.noalpha, i), 1);
    }
  }

  // Radial profile of each arm, 8 px annuli out to 320 px.
  const NB = 40, BW = 8;
  const prof = Array.from({ length: NB }, () => {
    const o = { n: 0 };
    for (const k of Object.keys(px)) o[k] = 0;
    return o;
  });
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    if (inHud(x, y)) continue;
    const b = (Math.hypot(x - blast.x, y - blast.y) / BW) | 0;
    if (b >= NB) continue;
    prof[b].n++;
    for (const k of Object.keys(px)) prof[b][k] += L(px[k], i);
  }

  return {
    calib: {
      determinism: maxAbs('full', 'fullB'),
      knownInput: maxAbs('full', 'half'),
    },
    means,
    alphaSurvival: {
      aloneReadingPx: aloneN,
      aloneMeanDarkenL: aloneN ? +(aloneSum / aloneN).toFixed(2) : 0,
      inFullReadingPx: inFullN,
      inFullMeanDarkenL: inFullN ? +(inFullSum / inFullN).toFixed(2) : 0,
      onAloneMaskMeanDarkenInFullL: pairedN ? +(pairedSum / pairedN).toFixed(2) : 0,
      weberAlone: pairedN ? +(weberAloneSum / pairedN).toFixed(4) : 0,
      weberInFull: pairedN ? +(weberFullSum / pairedN).toFixed(4) : 0,
      maskPx: pairedN,
    },
    profile: prof.map((p, i) => {
      const o = { r: i * BW, n: p.n };
      for (const k of Object.keys(px)) o[k] = p.n ? +(p[k] / p.n).toFixed(1) : 0;
      return o;
    }),
  };
}, { shots, w: W, h: H, blast });

await browser.close();
await server.close();

console.log('\n=== CALIBRATION ===');
console.log(JSON.stringify(analysis.calib, null, 1));
console.log('\n=== REGION MEANS (display L) ===');
console.log(JSON.stringify(analysis.means, null, 1));
console.log('\n=== ALPHA SURVIVAL ===');
console.log(JSON.stringify(analysis.alphaSurvival, null, 1));
console.log('\n=== RADIAL PROFILE ===');
console.log('  r    full   noadd  noalpha  bare    half');
for (const p of analysis.profile) {
  console.log(`${String(p.r).padStart(4)} ${String(p.full).padStart(7)} ${String(p.noadd).padStart(7)} ${String(p.noalpha).padStart(7)} ${String(p.bare).padStart(7)} ${String(p.half).padStart(7)}`);
}
console.log(`\nPNGs in ${OUT}`);
