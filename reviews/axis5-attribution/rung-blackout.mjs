/**
 * Issue #107 — which material rung owns `13-biomes-1`'s clipping mesa-top pixels?
 *
 * Method: ONE page boot, ONE composed `biomeVista({ index: 0 })` frame, then a
 * per-rung blackout sweep. Every distinct material instance in the scene is
 * enumerated and grouped; each group in turn is forced to a black, matte,
 * unlit-in-practice surface (albedo 0, roughness 1, metalness 0, envMapIntensity
 * 0, no maps, no emissive) and the frame is re-shot. A blackened rung still
 * occludes what is behind it, so the shot is a clean subtraction: the rung whose
 * blackout collapses the ROI's clip255 owns those pixels.
 *
 * Why a blackout sweep and not a parameter sweep: #102 died guessing parameters.
 * Why one boot: the harness is not bit-exact across boots (~0.68% shot-level
 * drift), so cross-boot comparison cannot resolve this. Inside one boot the
 * camera, seed and stage are literally the same objects, and the only drift is
 * the two frames each re-render costs. A second baseline is shot at the END of
 * the sweep, after every mutation has been restored, and the baseline-to-
 * baseline delta is the run's own noise floor, measured rather than assumed.
 *
 * These are PARTIAL-RUN numbers (one scenario, not a full capture). They buy an
 * attribution, never an acceptance.
 *
 *   node reviews/axis5-attribution/rung-blackout.mjs [--port 5241] [--seed 1337]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readPNG, luma } from '../round6/tools-stages/png.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const PORT = Number(args.port ?? 5241);
const SEED = Number(args.seed ?? 1337);
const OUT = path.join('reviews', 'axis5-attribution', 'frames');
const W = 1600, H = 900;

// reviews/axis5-specular/measure.mjs, verbatim box.
const ROI = { x0: 520, y0: 540, x1: 880, y1: 620 };

function roiStats(file) {
  const img = readPNG(file);
  const L = luma(img), Wp = img.w;
  let clip = 0, n = 0, sum = 0;
  for (let y = ROI.y0; y < ROI.y1; y++) {
    for (let x = ROI.x0; x < ROI.x1; x++) {
      const i = y * Wp + x, o = i * 4;
      n++; sum += L[i];
      if (img.rgba[o] >= 255 || img.rgba[o + 1] >= 255 || img.rgba[o + 2] >= 255) clip++;
    }
  }
  return { clip255: (clip / n) * 100, mean: sum / n };
}

const log = (m) => console.log(`[attr] ${m}`);

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-2400,-2400'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await mkdir(OUT, { recursive: true });

await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!globalThis.__HARNESS__, null, { timeout: 120000 });
log('booted; composing 13-biomes-1 (biomeVista index 0)');

// Prove the shot/biome pairing from the running build rather than from a read.
const mapping = await page.evaluate(() => {
  const g = globalThis.__GAME__;
  return { seed: g?.seed ?? null };
});

await page.evaluate(() => globalThis.__HARNESS__.biomeVista({ index: 0 }));
const stageName = await page.evaluate(() => globalThis.__GAME__?.ctx?.stage?.stageName ?? null);
log(`stage name in frame: ${stageName}`);

// --- enumerate the rungs actually on screen --------------------------------
//
// Grouped by material object identity, labelled by an intrinsic descriptor
// (type + albedo + roughness/metalness) so no import or naming convention is
// relied on. `material.name` is used when the build set one.
const rungs = await page.evaluate(() => {
  const g = globalThis.__GAME__;
  const scene = g.ctx.scene ?? g.ctx.pipeline?.scene;
  const byMat = new Map();
  scene.traverse((o) => {
    if (!o.visible || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.color) continue;
      if (!byMat.has(m.uuid)) {
        byMat.set(m.uuid, {
          uuid: m.uuid,
          label: m.name || `${m.type}:#${m.color.getHexString()}`,
          hex: m.color.getHexString(),
          rough: m.roughness ?? null,
          metal: m.metalness ?? null,
          env: m.envMapIntensity ?? null,
          emissive: m.emissive ? m.emissive.getHexString() : null,
          meshes: 0,
        });
      }
      byMat.get(m.uuid).meshes++;
    }
  });
  globalThis.__ATTR__ = { scene, mats: new Map() };
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (m?.color) globalThis.__ATTR__.mats.set(m.uuid, m);
  });
  return [...byMat.values()].sort((a, b) => b.meshes - a.meshes);
});
log(`enumerated ${rungs.length} distinct materials in the composed frame`);

// --- blackout / restore / re-render ----------------------------------------
await page.evaluate(() => {
  const A = globalThis.__ATTR__;
  A.saved = null;
  A.blackout = (uuid) => {
    const m = A.mats.get(uuid);
    if (!m) return false;
    A.saved = {
      m,
      color: m.color.getHex(),
      emissive: m.emissive ? m.emissive.getHex() : null,
      emissiveIntensity: m.emissiveIntensity,
      roughness: m.roughness, metalness: m.metalness,
      envMapIntensity: m.envMapIntensity,
      map: m.map, emissiveMap: m.emissiveMap, roughnessMap: m.roughnessMap,
      metalnessMap: m.metalnessMap, lightMap: m.lightMap,
    };
    m.color.setHex(0x000000);
    if (m.emissive) m.emissive.setHex(0x000000);
    m.emissiveIntensity = 0;
    m.roughness = 1; m.metalness = 0; m.envMapIntensity = 0;
    m.map = null; m.emissiveMap = null; m.roughnessMap = null;
    m.metalnessMap = null; m.lightMap = null;
    m.needsUpdate = true;
    return true;
  };
  A.restore = () => {
    const s = A.saved;
    if (!s) return;
    const m = s.m;
    m.color.setHex(s.color);
    if (m.emissive && s.emissive != null) m.emissive.setHex(s.emissive);
    m.emissiveIntensity = s.emissiveIntensity;
    m.roughness = s.roughness; m.metalness = s.metalness;
    m.envMapIntensity = s.envMapIntensity;
    m.map = s.map; m.emissiveMap = s.emissiveMap; m.roughnessMap = s.roughnessMap;
    m.metalnessMap = s.metalnessMap; m.lightMap = s.lightMap;
    m.needsUpdate = true;
    A.saved = null;
  };
  // The scenario froze the engine. Advance exactly two frames so the material
  // edit reaches the composited canvas, then freeze again — identical cost for
  // every rung, so the accumulated drift is uniform and the end-of-sweep
  // baseline measures it.
  A.repaint = () => new Promise((res) => {
    const e = globalThis.__GAME__.engine;
    e.start();
    let i = 0;
    const step = () => (++i >= 2 ? (e.stop(), requestAnimationFrame(() => res())) : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
});

const shoot = async (tag) => {
  const f = path.join(OUT, `${tag}.png`);
  await page.screenshot({ path: f, timeout: 60000, animations: 'disabled' });
  return { tag, ...roiStats(f) };
};

const rows = [];
rows.push({ ...(await shoot('baseline-start')), rung: 'BASELINE (start)' });
log(`baseline-start clip255 ${rows[0].clip255.toFixed(3)}%`);

for (let i = 0; i < rungs.length; i++) {
  const r = rungs[i];
  const ok = await page.evaluate((u) => globalThis.__ATTR__.blackout(u), r.uuid);
  if (!ok) continue;
  await page.evaluate(() => globalThis.__ATTR__.repaint());
  const s = await shoot(`rung-${String(i).padStart(2, '0')}`);
  await page.evaluate(() => globalThis.__ATTR__.restore());
  await page.evaluate(() => globalThis.__ATTR__.repaint());
  rows.push({ ...s, rung: r.label, hex: r.hex, rough: r.rough, metal: r.metal, env: r.env, meshes: r.meshes });
  log(`${r.label.padEnd(34)} clip255 ${s.clip255.toFixed(3)}%  mean ${s.mean.toFixed(1)}`);
}

rows.push({ ...(await shoot('baseline-end')), rung: 'BASELINE (end)' });

const b0 = rows[0].clip255, b1 = rows[rows.length - 1].clip255;
console.log('\n=== 13-biomes-1 mesa-top ROI (x520-880 y540-620) — PARTIAL RUN ===');
console.log(`stage in frame: ${stageName}   seed ${mapping.seed}`);
console.log(`within-boot noise floor: baseline start ${b0.toFixed(3)}% -> end ${b1.toFixed(3)}%  (|d| ${Math.abs(b1 - b0).toFixed(3)}pp)\n`);
for (const r of rows.slice(1, -1).sort((a, b) => a.clip255 - b.clip255)) {
  const d = r.clip255 - b0;
  console.log(`${String(r.rung).padEnd(34)} clip255 ${r.clip255.toFixed(3).padStart(7)}%  d ${d >= 0 ? '+' : ''}${d.toFixed(3)}pp  mean ${r.mean.toFixed(1).padStart(5)}  [#${r.hex} r${r.rough} m${r.metal} env${r.env} x${r.meshes}]`);
}
if (errors.length) console.log('\npage errors:', errors.slice(0, 5));

await browser.close();
await server.close();
