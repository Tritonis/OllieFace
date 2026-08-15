/**
 * Per-layer A/B of the explosion (rubric axis 6).
 *
 * The rubric grades the blast on four *layers* — flash + particles +
 * distortion + light — plus a soft-particle depth fade. Round 5 found three of
 * them either absent or present-but-invisible while the frame still looked
 * busy, because a screenshot cannot tell you which layer put a pixel there.
 * This can.
 *
 * ## Why it re-renders one frozen frame instead of re-running the shot
 *
 * The obvious build runs `08-explosion` five times with a different layer
 * suppressed each time. That version was written and thrown away: the harness
 * scenario free-runs on rAF, so two runs of it diverge by hundreds of
 * milliseconds of monster AI, and the diffs came back at 40% of the frame — all
 * of it scene drift, none of it the layer under test. A measurement whose noise
 * floor is ten times its signal is worse than none.
 *
 * So the shot is composed *once* and frozen, and the five variants are five
 * re-renders of that single frozen frame with one layer switched off in place:
 *
 *  - flash  — the life of every additive particle on `FRAME.CORE` is zeroed, so
 *             the vertex shader's dead-particle guard culls it;
 *  - light  — the blast's `LightPool` entries drop to zero intensity;
 *  - distort— `uBlastCount` on the grade pass drops to zero;
 *  - soft   — `uSoftEnabled` drops to zero on both particle layers and the ring.
 *
 * Everything else — camera, geometry, monsters, every other particle — is bit
 * identical between variants, so a diff is the layer and nothing else.
 *
 *   node tools/vfxprobe.mjs [--seed 1337] [--port 5218] [--out shots-vfxprobe]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveOutDir } from './lib/evidence.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5218);
// shots-vfxprobe is git-ignored by the `shots-` rule; route through the helper
// so that fact is announced instead of discovered after the fact (#71).
const OUT = resolveOutDir(args.out ?? 'shots-vfxprobe', { tool: 'vfxprobe' });
const W = 1600, H = 900;
const KEYS = ['full', 'no-flash', 'no-light', 'no-distort', 'no-soft'];

const server = await createServer({
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

// Where the blast is, taken from the live shockwave record rather than guessed
// from the bright pixels. The *largest* record, not the first: the scenario is
// a live fight and small blasts from dying monsters share the list, and the
// first run of this probe profiled one of those and reported a hollow core for
// a frame whose core is 700 px away.
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
if (!blast) { console.error('no live blast to profile'); process.exit(1); }

// Re-render the frozen frame with one layer suppressed, and screenshot each.
await mkdir(OUT, { recursive: true });
const shots = {};
for (const key of KEYS) {
  await page.evaluate(async ({ key, blast }) => {
    const { FRAME } = await import('/src/fx/ParticleSystem.js');
    const ctx = globalThis.__GAME__.ctx;
    const vfx = ctx.vfx;
    const undo = [];

    if (key === 'no-flash') {
      // Only the cores belonging to *this* blast. Every muzzle flash and hit
      // spark in a live fight is also on FRAME.CORE, and suppressing the lot
      // turns the measurement into "how much of the frame is any flash".
      const [bx, by, bz] = blast.world;
      const reach = blast.radius * blast.radius;
      for (const name in vfx.particles.layers) {
        const L = vfx.particles.layers[name];
        const life = L.attrs.aTime.array, misc = L.attrs.aMisc.array;
        const sp = L.attrs.aSpawn.array;
        for (let i = 0; i < L.capacity; i++) {
          if (Math.round(misc[i * 4 + 1]) !== FRAME.CORE) continue;
          const was = life[i * 2 + 1];
          if (was <= 0) continue;
          const dx = sp[i * 3] - bx, dy = sp[i * 3 + 1] - by, dz = sp[i * 3 + 2] - bz;
          if (dx * dx + dy * dy + dz * dz > reach) continue;
          life[i * 2 + 1] = 0;
          undo.push(() => { life[i * 2 + 1] = was; L.attrs.aTime.needsUpdate = true; });
        }
        L.attrs.aTime.needsUpdate = true;
      }
    } else if (key === 'no-light') {
      for (const e of vfx.lights.lights) {
        const was = e.light.intensity;
        if (was <= 0) continue;
        e.light.intensity = 0;
        undo.push(() => { e.light.intensity = was; });
      }
    } else if (key === 'no-distort') {
      const u = ctx.pipeline.passes.grade.uniforms.uBlastCount;
      const was = u.value;
      u.value = 0;
      undo.push(() => { u.value = was; });
    } else if (key === 'no-soft') {
      const mats = [...Object.values(vfx.particles.layers).map((L) => L.mat), vfx.rings.mat];
      for (const m of mats) {
        const u = m.uniforms.uSoftEnabled;
        const was = u.value;
        if (!was) continue;
        u.value = 0;
        undo.push(() => { u.value = was; });
      }
    }

    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
    globalThis.__UNDO__ = undo;
  }, { key, blast });
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `08-${key}.png`), buf);
  shots[key] = `data:image/png;base64,${buf.toString('base64')}`;
  await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  console.log(`rendered ${key}`);
}

// ---------------------------------------------------------------- analysis
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
  // The HUD is drawn over the frame, never changes between variants and is not
  // what is being measured; these bands fence it out.
  const inHud = (x, y) => y > h - 130 || (y < 110 && (x < 280 || x > 1400)) || (x > 1180 && y > 740);

  /** Count / mean / extremes of `full - other`, optionally masked. */
  const diff = (other, { min = 3, skip = null, signed = true } = {}) => {
    let n = 0, sum = 0, hi = 0, lo = 0, hiAt = -1, loAt = -1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    for (let i = 0; i < w * h; i++) {
      const x = i % w, y = (i / w) | 0;
      if (inHud(x, y) || (skip && skip[i])) continue;
      const d = L(px.full, i) - L(px[other], i);
      if (d > hi) { hi = d; hiAt = i; }
      if (d < lo) { lo = d; loAt = i; }
      if ((signed ? Math.abs(d) : d) > min) {
        n++; sum += d;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return {
      pixels: n, pctOfFrame: +((n / (w * h)) * 100).toFixed(2),
      meanDelta: n ? +(sum / n).toFixed(2) : 0,
      maxDelta: +hi.toFixed(1), maxAt: hiAt >= 0 ? [hiAt % w, (hiAt / w) | 0] : null,
      minDelta: +lo.toFixed(1), minAt: loAt >= 0 ? [loAt % w, (loAt / w) | 0] : null,
      bbox: n ? [x0, y0, x1, y1] : null,
    };
  };

  const out = {};

  // --- 1. flash / core ----------------------------------------------------
  out.flash = diff('no-flash', { min: 4, signed: false });
  // The core's own footprint, so the light measurement below can exclude it and
  // report what the blast does to *other* geometry.
  const coreMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (L(px.full, i) - L(px['no-flash'], i) > 4) coreMask[i] = 1;
  }
  // Radial luminance profile about the blast's projected centre. A core reads
  // as a monotonic falloff from a hot centre; round 5's failure was a hollow
  // ring, which reads as a *dip* at r=0 with a bump further out.
  const RB = 20, RSTEP = 10;
  const prof = Array.from({ length: RB }, () => ({ sum: 0, off: 0, n: 0, peak: 0 }));
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    if (inHud(x, y)) continue;
    const b = (Math.hypot(x - blast.x, y - blast.y) / RSTEP) | 0;
    if (b >= RB) continue;
    const v = L(px.full, i);
    prof[b].sum += v; prof[b].off += L(px['no-flash'], i); prof[b].n++;
    if (v > prof[b].peak) prof[b].peak = v;
  }
  out.flash.centre = [blast.x, blast.y];
  out.flash.profile = prof.map((p, i) => ({
    r: i * RSTEP,
    full: p.n ? +(p.sum / p.n).toFixed(1) : 0,
    noFlash: p.n ? +(p.off / p.n).toFixed(1) : 0,
    peak: +p.peak.toFixed(1),
  }));

  // --- 2. light contribution ----------------------------------------------
  out.light = diff('no-light', { min: 2, skip: coreMask, signed: false });

  // --- 3. distortion ------------------------------------------------------
  out.distort = diff('no-distort', { min: 3 });

  // --- 4. soft-particle depth fade ----------------------------------------
  // A depth fade only ever *removes* particle light near a surface, so the mean
  // of `full - noSoft` has to come back negative; a positive mean would mean
  // something other than a fade moved.
  out.soft = diff('no-soft', { min: 3 });

  return out;
}, { shots, w: W, h: H, blast });

await browser.close();
await server.close();

const f = analysis.flash;
console.log(`\n=== 08-explosion per-layer A/B on one frozen frame (seed ${SEED}) ===`);
console.log(`blast centre on screen: ${f.centre}\n`);
console.log(`1. FLASH/CORE  ${f.pixels} px (${f.pctOfFrame}% of frame), mean +${f.meanDelta} L, peak +${f.maxDelta} at ${f.maxAt}, bbox ${f.bbox}`);
console.log('   radial luminance profile about the blast centre:');
console.log('     r(px)   mean   peak   no-core   core adds');
for (const p of f.profile) {
  console.log(`     ${String(p.r).padStart(4)}  ${String(p.full).padStart(6)} ${String(p.peak).padStart(6)}  ${String(p.noFlash).padStart(8)}  ${(p.full - p.noFlash).toFixed(1).padStart(9)}`);
}
const row = (n, o, unit) => console.log(`${n}  ${o.pixels} px (${o.pctOfFrame}%), mean ${o.meanDelta > 0 ? '+' : ''}${o.meanDelta} L, ${unit}, bbox ${o.bbox}`);
row('\n2. LIGHT     ', analysis.light, `max +${analysis.light.maxDelta} at ${analysis.light.maxAt}`);
row('3. DISTORTION', analysis.distort, `range ${analysis.distort.minDelta}..+${analysis.distort.maxDelta}`);
row('4. SOFT FADE ', analysis.soft, `deepest cut ${analysis.soft.minDelta} at ${analysis.soft.minAt}`);
console.log(`\nPNGs in ${OUT}`);

const fail = [];
if (f.pixels < 3000) fail.push(`flash/core covers only ${f.pixels}px`);
if (f.profile[0].full - f.profile[0].noFlash < 15) fail.push('core adds under 15 L at the blast centre');
if (f.profile[0].full < f.profile[3].full) fail.push('centre darker than r=30 — the core is hollow');
if (analysis.light.pixels < 15000) fail.push(`light reaches only ${analysis.light.pixels}px of geometry`);
if (analysis.distort.pixels < 4000) fail.push(`distortion displaces only ${analysis.distort.pixels}px`);
if (analysis.soft.pixels < 2000) fail.push(`depth fade changes only ${analysis.soft.pixels}px`);
if (analysis.soft.meanDelta >= 0) fail.push('depth fade is not subtractive');
console.log(fail.length ? `\nFAIL — ${fail.join('; ')}` : '\nPASS — all four layers measurably present');
process.exit(fail.length ? 1 : 0);
