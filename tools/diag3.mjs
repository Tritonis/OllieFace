/** Throwaway: is each combat enemy occluded by terrain/props from the lens? */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const W = 1600, H = 900;
const server = await createServer({ server: { port: 5203, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto('http://127.0.0.1:5203/?seed=1337&quality=3&harness=1', { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });

const seq = [
  () => page.evaluate(() => globalThis.__HARNESS__.artifacts()),
  () => page.evaluate(() => globalThis.__HARNESS__.vista()),
  () => page.evaluate(() => globalThis.__HARNESS__.gameplay()),
  () => page.evaluate(() => globalThis.__HARNESS__.survivors()),
  () => page.evaluate(() => globalThis.__HARNESS__.survivorSelect()),
  () => page.evaluate(() => globalThis.__HARNESS__.logbook()),
  ...[0, 1, 2, 3].map((i) => () => page.evaluate(
    ([n, last]) => globalThis.__HARNESS__.biomeVista({ index: n, restore: last }), [i, i === 3])),
  () => page.evaluate(() => globalThis.__HARNESS__.combat({ enemies: 24 })),
];
for (const f of seq) await f();

console.log(JSON.stringify(await page.evaluate(() => {
  const g = globalThis.__GAME__, ctx = g.ctx, THREE = g.THREE, cam = ctx.camera;
  cam.updateMatrixWorld(true);
  const dir = new THREE.Vector3(), tgt = new THREE.Vector3(), v = new THREE.Vector3();
  const rc = new THREE.Raycaster();
  const out = [];
  for (const e of ctx.director.enemies) {
    const h = e.def?.height ?? 2;
    tgt.set(e.position.x, e.position.y + h * 0.5, e.position.z);
    dir.subVectors(tgt, cam.position);
    const dist = dir.length(); dir.normalize();
    const stageHit = ctx.stage.raycastDistance(cam.position, dir, dist - 0.2);
    // what does a full-scene raycast hit first?
    rc.set(cam.position, dir); rc.far = dist + 0.5; rc.near = 0.1;
    const hits = rc.intersectObject(ctx.scene, true).filter((x) => x.object.visible && x.distance > 0.2);
    const first = hits[0];
    v.copy(tgt).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    out.push({
      id: e.def?.id, dist: +dist.toFixed(1),
      sx: +(v.x * 0.5 + 0.5).toFixed(3), sy: +(0.5 - v.y * 0.5).toFixed(3),
      stageHit: typeof stageHit === 'number' ? +stageHit.toFixed(1) : null,
      firstHit: first ? `${first.object.name || first.object.type}@${first.distance.toFixed(1)}` : null,
      groundY: +ctx.stage.sampleHeight(e.position.x, e.position.z).toFixed(2),
      y: +e.position.y.toFixed(2),
      camY: +cam.position.y.toFixed(2),
    });
  }
  return out;
}), null, 1));

await browser.close();
await server.close();
