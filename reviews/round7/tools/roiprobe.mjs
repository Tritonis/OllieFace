/**
 * Names the geometry under an ROI and computes the detail pass's own
 * resolution gate on it.
 *
 *   node reviews/round7/tools/roiprobe.mjs --port 5304 --roi 240,120,560,420
 *
 * `detRes(featM, fw) = 1 - smoothstep(0.20, 0.60, fw/featM)` (Materials.js:376)
 * decides how much of an octave the pass believes the pixel resolves, and
 * `detHidden` (Materials.js:414) charges `1 - res*res` of its energy to the
 * specular lobe. So `fw` — the world extent of one pixel on the surface — is
 * the number that decides whether the specular-AA fix fires at all. This
 * reconstructs it from the hit distance and the surface incidence:
 *
 *     fw ~= dist * (2 tan(fov/2) / h) / cos(incidence)
 *
 * which is the longer of the two screen axes of the pixel footprint, i.e. what
 * `max(length(dFdx(vDetW)), length(dFdy(vDetW)))` returns.
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
const PORT = Number(args.port ?? 5304);
const ROI = String(args.roi ?? '240,120,560,420').split(',').map(Number);
const OUT = path.resolve(args.out ?? 'reviews/round7/captures/diag-spire-arms');
const log = (...m) => console.log('[roiprobe]', ...m);

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-4000,-4000'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultNavigationTimeout(120000);
await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=3&harness=1&pinclock=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60));
for (const s of ['title', 'artifacts', 'difficulty', 'vista', 'gameplay',
                 'survivors', 'survivorSelect', 'logbook']) {
  await page.evaluate((n) => globalThis.__HARNESS__?.[n]?.().catch?.(() => {}), s).catch(() => {});
}
await page.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 0, restore: false })).catch(() => {});
await page.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 1, restore: false })).catch(() => {});

const out = await page.evaluate(([roi]) => {
  const G = globalThis.__GAME__, THREE = G.THREE, ctx = G.ctx;
  const cam = ctx.camera, W = 1600, H = 900;
  const mPerPxPerM = (2 * Math.tan((cam.fov * Math.PI / 180) / 2)) / H;
  const rc = new THREE.Raycaster();
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const detRes = (featM, fw) => 1 - smooth(0.20, 0.60, fw / featM);
  const rows = [];
  for (let y = roi[1]; y < roi[3]; y += 10) {
    for (let x = roi[0]; x < roi[2]; x += 10) {
      rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -((y / H) * 2 - 1)), cam);
      const hit = rc.intersectObjects(ctx.scene.children, true).find((it) => it.object.type === 'Mesh' && it.object.visible);
      if (!hit) { rows.push({ miss: true }); continue; }
      const m = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
      const n = hit.face ? hit.face.normal.clone().applyMatrix3(
        new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize() : null;
      const cosI = n ? Math.abs(n.dot(rc.ray.direction)) : 1;
      const fw = hit.distance * mPerPxPerM / Math.max(cosI, 0.02);
      rows.push({
        obj: hit.object.name || '(unnamed)', detKind: m?.userData?.detKind ?? null,
        rough: m?.roughness, dist: +hit.distance.toFixed(2), cosI: +cosI.toFixed(3),
        fw: +fw.toFixed(4), fineRes: +detRes(0.46, fw).toFixed(3),
        coarseRes: +detRes(2.2, fw).toFixed(3),
      });
    }
  }
  const hits = rows.filter((r) => !r.miss);
  const agg = (k) => {
    const v = hits.map((r) => r[k]).sort((a, b) => a - b);
    return { p10: v[Math.floor(v.length * 0.1)], p50: v[Math.floor(v.length * 0.5)], p90: v[Math.floor(v.length * 0.9)] };
  };
  const byObj = {};
  for (const r of hits) byObj[`${r.obj}/${r.detKind}`] = (byObj[`${r.obj}/${r.detKind}`] ?? 0) + 1;
  return {
    camFov: cam.fov, mPerPxPerM, n: hits.length, misses: rows.length - hits.length, byObj,
    dist: agg('dist'), cosI: agg('cosI'), fw: agg('fw'),
    fineRes: agg('fineRes'), coarseRes: agg('coarseRes'),
    // What the fine octave's own gate leaves for the specular-AA term.
    fineHiddenFrac: agg('fineRes').p50 != null
      ? +(1 - agg('fineRes').p50 * agg('fineRes').p50).toFixed(4) : null,
  };
}, [ROI]);
console.log(JSON.stringify(out, null, 2));
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'roi-probe.json'), JSON.stringify({ roi: ROI, ...out }, null, 2));
await browser.close();
await server.close();
log('done');
