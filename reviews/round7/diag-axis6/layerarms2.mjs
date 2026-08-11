/**
 * Pass 2: (a) the proposed fix measured as an arm, (b) a second effect.
 *
 * Same frozen-frame method as `layerarms.mjs` and `tools/vfxprobe.mjs`.
 *
 * (a) `alphaLast` raises the alpha layer's renderOrder above the additive
 *     layer's, which is the one-line change under consideration. Rendering it
 *     as an arm on the same frozen frame measures what the fix would do
 *     without shipping it and without a second capture to compare against.
 *
 * (b) A muzzle flash is emitted in front of the camera and the same four arms
 *     are re-rendered around it, so the explosion's ratio can be checked
 *     against a second, much smaller effect built from the same layers.
 *     Particle time is advanced once by a fixed 0.12 s so the smoke has
 *     faded in; `ParticleSystem.update` takes no RNG draw (it only integrates
 *     analytic trajectories), so nothing downstream re-jitters.
 *
 * node layerarms2.mjs [--seed 1337] [--port 5343] [--out <dir>]
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
const PORT = Number(args.port ?? 5343);
const OUT = path.resolve(args.out ?? 'shots-layerarms');
const W = 1600, H = 900;

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__.explosion());

await mkdir(OUT, { recursive: true });

async function shoot(name, mutate) {
  await page.evaluate(async (mutateSrc) => {
    const ctx = globalThis.__GAME__.ctx;
    const L = ctx.vfx.particles.layers;
    const undo = [];
    // eslint-disable-next-line no-new-func
    (new Function('ctx', 'L', 'undo', mutateSrc))(ctx, L, undo);
    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
    globalThis.__UNDO__ = undo;
  }, mutate);
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `arm-${name}.png`), buf);
  await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  console.log(`rendered ${name}`);
}

const HIDE_ADD = `L.add.mesh.visible=false; undo.push(()=>{L.add.mesh.visible=true;});`;
const HIDE_ALPHA = `L.alpha.mesh.visible=false; undo.push(()=>{L.alpha.mesh.visible=true;});`;
const ALPHA_LAST = `const w=L.alpha.mesh.renderOrder; L.alpha.mesh.renderOrder=20; undo.push(()=>{L.alpha.mesh.renderOrder=w;});`;

// --- (a) the proposed fix, on the explosion -------------------------------
await shoot('p2-full', '');
await shoot('p2-alphaLast', ALPHA_LAST);
await shoot('p2-full2', '');

// --- (b) a second effect --------------------------------------------------
const muzzle = await page.evaluate(() => {
  const G = globalThis.__GAME__;
  const ctx = G.ctx, THREE = G.THREE;
  const cam = ctx.camera;
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const p = cam.position.clone().addScaledVector(fwd, 6).addScaledVector(right, 2.0).add(new THREE.Vector3(0, 1.2, 0));
  const before = (() => {
    let n = 0; for (const nm in ctx.vfx.particles.layers) {
      const l = ctx.vfx.particles.layers[nm], t = l.attrs.aTime.array;
      for (let i = 0; i < l.capacity; i++) if (t[i * 2 + 1] > 0) n++;
    } return n;
  })();
  ctx.vfx.muzzleFlash(p, fwd, 3);
  ctx.vfx.particles.update(ctx, 0.12);
  const after = (() => {
    let n = 0; for (const nm in ctx.vfx.particles.layers) {
      const l = ctx.vfx.particles.layers[nm], t = l.attrs.aTime.array;
      for (let i = 0; i < l.capacity; i++) if (t[i * 2 + 1] > 0) n++;
    } return n;
  })();
  const v = p.clone().project(cam);
  return { world: p.toArray(), aliveBefore: before, aliveAfter: after, camDist: cam.position.distanceTo(p),
    x: Math.round((v.x + 1) * 0.5 * innerWidth), y: Math.round((1 - v.y) * 0.5 * innerHeight) };
});
console.log('muzzle', JSON.stringify(muzzle));

await shoot('mz-full', '');
await shoot('mz-fullB', '');
await shoot('mz-noadd', HIDE_ADD);
await shoot('mz-noalpha', HIDE_ALPHA);
await shoot('mz-bare', HIDE_ADD + HIDE_ALPHA);

await browser.close();
await server.close();
console.log(`\nPNGs in ${OUT}`);
