/**
 * Throwaway diagnostic: run a subset of the capture scenarios and dump, for
 * each, what the director actually has standing and where it projects on
 * screen. Not part of the shipped harness.
 *
 *   node tools/diag.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const W = 1600, H = 900;
const server = await createServer({ server: { port: 5201, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto('http://127.0.0.1:5201/?seed=1337&quality=3&harness=1', { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });

const probe = () => page.evaluate(() => {
  const g = globalThis.__GAME__;
  const ctx = g.ctx, cam = ctx.camera;
  cam.updateMatrixWorld(true);
  const THREE = g.THREE;
  const v = new THREE.Vector3();
  const proj = (x, y, z) => {
    v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    const front = -v.z;
    v.applyMatrix4(cam.projectionMatrix);
    return { x: +(v.x * 0.5 + 0.5).toFixed(3), y: +(0.5 - v.y * 0.5).toFixed(3), d: +front.toFixed(1) };
  };
  const list = ctx.director?.enemies ?? [];
  const p = ctx.player?.position;
  const inFrame = (s) => s.d > 0 && s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1;
  const rows = list.map((e) => {
    const s = proj(e.position.x, e.position.y + (e.def?.height ?? 2) * 0.5, e.position.z);
    return { id: e.def?.id, alive: e.alive, vis: e.rig?.root?.visible ?? null, s, on: inFrame(s) };
  });
  return {
    enemies: list.length,
    alive: rows.filter((r) => r.alive).length,
    onScreen: rows.filter((r) => r.alive && r.on).length,
    boss: ctx.director?.boss ? { id: ctx.director.boss.def?.id, alive: ctx.director.boss.alive, s: proj(ctx.director.boss.position.x, ctx.director.boss.position.y + 3.8, ctx.director.boss.position.z) } : null,
    player: p ? proj(p.x, p.y + 1, p.z) : null,
    camPos: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)],
    fov: +cam.fov.toFixed(1),
    rigEnabled: ctx.cameraRig?.enabled,
    rigYaw: +(ctx.cameraRig?.yaw ?? 0).toFixed(3),
    directorEnabled: ctx.director?.enabled,
    rows: rows.slice(0, 30),
  };
});

const steps = [
  ['17-artifacts', () => page.evaluate(() => globalThis.__HARNESS__.artifacts())],
  ['02-vista', () => page.evaluate(() => globalThis.__HARNESS__.vista())],
  ['03-thirdperson', () => page.evaluate(() => globalThis.__HARNESS__.gameplay())],
  ['09-survivors', () => page.evaluate(() => globalThis.__HARNESS__.survivors())],
  ['14', () => page.evaluate(() => globalThis.__HARNESS__.survivorSelect())],
  ['15', () => page.evaluate(() => globalThis.__HARNESS__.logbook())],
  ...[0, 1, 2, 3].map((i) => [`13-biomes-${i + 1}`, () => page.evaluate(
    ([n, last]) => globalThis.__HARNESS__.biomeVista({ index: n, restore: last }), [i, i === 3])]),
  ['04-combat', () => page.evaluate(() => globalThis.__HARNESS__.combat({ enemies: 24 }))],
  ['05-boss', () => page.evaluate(() => globalThis.__HARNESS__.boss())],
  ['07-interactables', () => page.evaluate(() => globalThis.__HARNESS__.interactables())],
  ['08-explosion', () => page.evaluate(() => globalThis.__HARNESS__.explosion())],
  ['11-bestiary', () => page.evaluate(() => globalThis.__HARNESS__.bestiary())],
  ['12-boss-phases', () => page.evaluate(() => globalThis.__HARNESS__.bossPhases())],
];

for (const [name, fn] of steps) {
  await fn();
  const r = await probe();
  const brief = { enemies: r.enemies, alive: r.alive, onScreen: r.onScreen, boss: r.boss, player: r.player, rigEnabled: r.rigEnabled, dirEnabled: r.directorEnabled, fov: r.fov };
  console.log(name, JSON.stringify(brief));
  if (['04-combat', '05-boss', '11-bestiary'].includes(name)) {
    await page.screenshot({ path: `shots-diag/${name}.png`, timeout: 30000, animations: 'disabled' });
  }
  if (['04-combat', '05-boss', '11-bestiary'].includes(name)) {
    console.log('   pixels', JSON.stringify(await page.evaluate(() => {
      const g = globalThis.__GAME__, ctx = g.ctx, THREE = g.THREE;
      const r = ctx.pipeline.renderer;
      const roots = (ctx.director?.enemies ?? []).filter((e) => e.rig?.root).map((e) => e.rig.root);
      const W = 480, H = 270;
      const rt = new THREE.WebGLRenderTarget(W, H);
      const a = new Uint8Array(W * H * 4), b = new Uint8Array(W * H * 4);
      const prevShadow = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      const prevRT = r.getRenderTarget();
      r.setRenderTarget(rt); r.render(ctx.scene, ctx.camera); r.readRenderTargetPixels(rt, 0, 0, W, H, a);
      const was = roots.map((o) => o.visible);
      roots.forEach((o) => { o.visible = false; });
      r.render(ctx.scene, ctx.camera); r.readRenderTargetPixels(rt, 0, 0, W, H, b);
      roots.forEach((o, i) => { o.visible = was[i]; });
      r.setRenderTarget(prevRT); r.shadowMap.autoUpdate = prevShadow;
      rt.dispose();
      let diff = 0;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        if (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]) > 12) diff++;
      }
      // sample one enemy's rig structure
      const e = (ctx.director?.enemies ?? []).find((x) => x.rig?.root);
      let info = null;
      if (e) {
        const box = new THREE.Box3().setFromObject(e.rig.root);
        let meshes = 0, hidden = 0, culled = 0;
        e.rig.root.traverse((o) => {
          if (!o.isMesh && !o.isInstancedMesh) return;
          meshes++;
          if (!o.visible) hidden++;
          if (o.isInstancedMesh && o.count === 0) culled++;
        });
        info = {
          id: e.def?.id, pos: e.position.toArray().map((v) => +v.toFixed(1)),
          rootPos: e.rig.root.position.toArray().map((v) => +v.toFixed(1)),
          scale: +e.rig.root.scale.x.toFixed(2),
          box: [box.min.toArray().map((v) => +v.toFixed(1)), box.max.toArray().map((v) => +v.toFixed(1))],
          meshes, hidden, culled, inScene: !!e.rig.root.parent,
          parentIsScene: e.rig.root.parent === ctx.scene,
        };
      }
      return { visiblePixels: diff, total: W * H, pct: +(100 * diff / (W * H)).toFixed(2), sample: info };
    })));
  }
  if (name === '04-combat' || name === '11-bestiary') console.log('   rows', JSON.stringify(r.rows));
}
console.log('ERRORS', errors.length, errors.slice(0, 5));
await browser.close();
await server.close();
