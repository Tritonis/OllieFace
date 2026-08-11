/**
 * b2 far-spire diagnostic probe. Read-only with respect to the repo: every arm
 * is a *runtime* mutation applied through the page, then undone, so no source
 * file changes and nothing here can ship.
 *
 *   node reviews/round7/tools/spireprobe.mjs --out reviews/round7/captures/diag-spire --port 5304
 *
 * It does two things the on-disk round-6 arms cannot:
 *
 *  1. **Names the geometry under the ROI.** Raycasts a grid of ROI pixels into
 *     the live scene and reports, per hit, the object name, the material, the
 *     hit distance, and the world size of one pixel there — which converts the
 *     ROI's measured autocorrelation period from pixels into metres, so it can
 *     be compared against the terrain facet step and the detail field's tile.
 *
 *  2. **Bisects the residual with arms.** Each arm mutates one term on the
 *     material the ROI actually hits, renders three frames on the pinned clock,
 *     shoots, and restores. Two identical control arms bracket the set, so the
 *     drift those three frames cost is measured rather than assumed.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const OUT = path.resolve(args.out ?? 'reviews/round7/captures/diag-spire');
const PORT = Number(args.port ?? 5304);
const SEED = Number(args.seed ?? 1337);
const W = 1600, H = 900;
const ROI = [1000, 30, 1180, 260];
const log = (...m) => console.log('[spireprobe]', ...m);

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
         '--window-position=-4000,-4000'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.message)));

page.setDefaultNavigationTimeout(120000);
await mkdir(OUT, { recursive: true });
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load' });
const ready = await page
  .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 })
  .then(() => true).catch(() => false);
log('ready', ready);
const pinned = await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60) ?? false);
log('clockPinned', pinned);

// The scenario prefix, in `tools/capture.mjs`'s order, and it is not optional.
//
// Every scenario draws from the shared RNG stream, and `13-biomes-2` calls
// `ctx.stage.build(1)` *after* eight of them have. Run on its own, `biomeVista`
// index 1 builds a demonstrably different world: the frame it produces
// correlates 0.028 with `reviews/round6/resume/13-biomes-2.png` on a Sobel
// registration that scores 0.930 between `resume/` and `FINAL/`, and its ROI
// carries PEAK 0.010% instead of 0.227%. Reproducing the shot means reproducing
// the draw count in front of it.
const PREFIX = ['title', 'artifacts', 'difficulty', 'vista', 'gameplay',
                'survivors', 'survivorSelect', 'logbook'];
for (const s of PREFIX) {
  await page.evaluate((n) => globalThis.__HARNESS__?.[n]?.().catch?.(() => {}), s)
    .catch((e) => log('prefix', s, 'threw:', String(e).slice(0, 120)));
  log('prefix', s);
}
await page.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 0, restore: false }))
  .catch((e) => log('13-biomes-1 threw:', String(e).slice(0, 120)));
await page.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 1, restore: false }))
  .catch((e) => log('13-biomes-2 threw:', String(e).slice(0, 120)));
await page.screenshot({ path: path.join(OUT, '13-biomes-2.png') });
log('base shot written');

// --- scene facts ----------------------------------------------------------
const facts = await page.evaluate(([roi, w, h]) => {
  const G = globalThis.__GAME__, THREE = G.THREE, ctx = G.ctx;
  const cam = ctx.camera, scene = ctx.scene;
  const rc = new THREE.Raycaster();
  const hits = [];
  const step = 20;
  for (let y = roi[1]; y < roi[3]; y += step) {
    for (let x = roi[0]; x < roi[2]; x += step) {
      const ndc = new THREE.Vector2((x / w) * 2 - 1, -((y / h) * 2 - 1));
      rc.setFromCamera(ndc, cam);
      const hit = rc.intersectObjects(scene.children, true)
        .find((it) => it.object.visible && it.object.type === 'Mesh');
      if (!hit) { hits.push({ x, y, miss: true }); continue; }
      const m = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
      hits.push({
        x, y, dist: +hit.distance.toFixed(2),
        obj: hit.object.name || '(unnamed)',
        matName: m?.name || '(unnamed)',
        detKind: m?.userData?.detKind ?? null,
        rough: m?.roughness, metal: m?.metalness, env: m?.envMapIntensity,
        nScale: m?.normalScale ? [m.normalScale.x, m.normalScale.y] : null,
        hasNormalMap: !!m?.normalMap,
        mapRepeat: m?.map ? [m.map.repeat.x, m.map.repeat.y] : null,
      });
    }
  }
  const T = ctx.stage?.terrain;
  const M = T?.mesh?.material;
  const det = M?.userData?.det;
  return {
    camera: { pos: cam.position.toArray().map((v) => +v.toFixed(3)), fov: cam.fov,
              aspect: cam.aspect, near: cam.near, far: cam.far },
    // Vertical half-extent of one pixel in metres per metre of distance. The
    // ROI's autocorrelation period in pixels times this times the hit distance
    // is the artefact's world period.
    mPerPxPerM: (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) / h,
    terrain: T ? { step: T.step, segments: T.segments, half: T.half,
                   profile: T.profile, spires: (T.features?.spires ?? []).length } : null,
    terrainMat: M ? {
      name: M.name, type: M.type, flatShading: M.flatShading,
      roughness: M.roughness, metalness: M.metalness, envMapIntensity: M.envMapIntensity,
      normalScale: M.normalScale ? [M.normalScale.x, M.normalScale.y] : null,
      hasNormalMap: !!M.normalMap, hasEnvMap: !!M.envMap,
      sceneEnvironment: !!ctx.scene.environment,
      mapRepeat: M.map ? [M.map.repeat.x, M.map.repeat.y] : null,
      detKind: M.userData?.detKind ?? null,
      det: det ? {
        uDetA: det.uDetA.value.toArray(), uDetB: det.uDetB.value.toArray(),
        uDetC: det.uDetC.value.toArray(), uDetD: det.uDetD.value.toArray(),
        uDetE: det.uDetE.value.toArray(),
      } : null,
    } : null,
    spireList: (T?.features?.spires ?? []).map((s) => ({
      x: +s.x.toFixed(2), z: +s.z.toFixed(2), r: +s.r.toFixed(2),
      h: +s.h.toFixed(2), p: +s.p.toFixed(2),
      dist: +Math.hypot(s.x - cam.position.x, s.z - cam.position.z).toFixed(2),
    })),
  };
}, [ROI, W, H]);
log('camera', JSON.stringify(facts.camera));
log('terrain', JSON.stringify(facts.terrain));

// --- arms -----------------------------------------------------------------
// Each mutates one term on the terrain material, renders three frames on the
// pinned clock, shoots, restores. `ctrl-a` and `ctrl-b` are the same no-op arm
// at either end of the set: whatever they differ by is the cost of the frames,
// and any arm that moves by less than that has not moved.
const ARMS = [
  ['ctrl-a', 'no change'],
  ['env0', 'envMapIntensity = 0 on the terrain material (removes the b09c3d4 probe reflection)'],
  ['rough1', 'roughness = 1.0 (round 6\'s decisive specular bisect)'],
  ['det0', 'detail-pass fine and coarse amplitudes = 0'],
  ['nmap0', 'normalMap detached'],
  ['ctrl-b', 'no change'],
];
for (const [name, doc] of ARMS) {
  await page.evaluate((arm) => {
    const G = globalThis.__GAME__;
    const M = G.ctx.stage.terrain.mesh.material;
    const S = (G.__probeSave ||= {
      rough: M.roughness, env: M.envMapIntensity, nmap: M.normalMap,
      detA: M.userData.det.uDetA.value.clone(),
    });
    M.roughness = S.rough; M.envMapIntensity = S.env; M.normalMap = S.nmap;
    M.userData.det.uDetA.value.copy(S.detA);
    if (arm === 'env0') M.envMapIntensity = 0;
    if (arm === 'rough1') M.roughness = 1.0;
    if (arm === 'det0') M.userData.det.uDetA.value.set(S.detA.x, 0, S.detA.z, 0);
    if (arm === 'nmap0') M.normalMap = null;
    M.needsUpdate = true;
    G.engine.start();
  }, name);
  await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const tick = () => (++n >= 3 ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  await page.evaluate(() => globalThis.__GAME__.engine.stop());
  await page.screenshot({ path: path.join(OUT, `arm-${name}.png`) });
  log('arm', name, '-', doc);
}

await writeFile(path.join(OUT, 'facts.json'),
  JSON.stringify({ seed: SEED, ready, clockPinned: pinned, roi: ROI, arms: ARMS, facts, errors },
                 null, 2));
await browser.close();
await server.close();
log('done ->', OUT);
