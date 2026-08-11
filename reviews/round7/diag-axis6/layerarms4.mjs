/**
 * Pass 4: the whole decomposition and both candidate fixes on ONE frozen frame
 * at a CONTROLLED blast phase.
 *
 * Passes 1-3 inherited the harness scenario's shutter, which is not fixed
 * across boots: the same seed and the same `__HARNESS__.explosion()` froze at
 * sim 0.083 s, 0.117 s and 0.333 s on three consecutive runs, and at 0.333 s
 * the harness itself reports the blast absent (777 px against a 1200 px floor)
 * so the pass-3 fix arms measured fixes to a fireball that had already gone
 * out. Comparing arms across passes is therefore invalid, and pass 3's numbers
 * are withdrawn.
 *
 * This pass does not use the scenario's blast at all. It freezes the frame,
 * emits its own `explosion()` at the same world position the harness used, and
 * advances particle time by exactly 0.09 s before rendering any arm --- so the
 * phase is a constant of the measurement rather than a lottery, and every arm
 * below sees the identical particle state.
 *
 * `ParticleSystem.update` integrates analytic trajectories and takes no RNG
 * draw, and this is a throwaway probe process, so nothing in the shipped
 * capture stream is affected either way.
 *
 * node layerarms4.mjs [--port 5361] [--out <dir>] [--phase 0.09]
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
const PORT = Number(args.port ?? 5361);
const PHASE = Number(args.phase ?? 0.09);
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

const info = await page.evaluate((phase) => {
  const G = globalThis.__GAME__, ctx = G.ctx;
  const b = ctx.vfx._blasts.reduce((a, x) => (a && a.radius >= x.radius ? a : x), null);
  const p = new G.THREE.Vector3(b.x, b.y, b.z);
  ctx.vfx.explosion(p, 6, 0xff8a20);
  ctx.vfx.particles.update(ctx, phase);
  const v = p.clone().project(ctx.camera);
  const L = ctx.vfx.particles.layers;
  const alive = {};
  for (const nm in L) {
    const l = L[nm], t = l.attrs.aTime.array;
    let n = 0;
    for (let i = 0; i < l.capacity; i++) if (t[i * 2 + 1] > 0) n++;
    alive[nm] = { alive: n, capacity: l.capacity, renderOrder: l.mesh.renderOrder,
      intensity: l.mat.uniforms.uIntensity.value, maxIntensity: l.mat.uniforms.uMaxIntensity.value,
      lensFloor: l.mat.uniforms.uLensFloor.value, depthWrite: l.mat.depthWrite, depthTest: l.mat.depthTest };
  }
  return { world: [b.x, b.y, b.z], radius: b.radius, phase, layers: alive,
    x: Math.round((v.x + 1) * 0.5 * innerWidth), y: Math.round((1 - v.y) * 0.5 * innerHeight) };
}, PHASE);
console.log('probe', JSON.stringify(info, null, 1));

await mkdir(OUT, { recursive: true });
async function shoot(name, src) {
  await page.evaluate(async (s) => {
    const ctx = globalThis.__GAME__.ctx;
    const L = ctx.vfx.particles.layers;
    const undo = [];
    // eslint-disable-next-line no-new-func
    (new Function('ctx', 'L', 'undo', s))(ctx, L, undo);
    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
    globalThis.__UNDO__ = undo;
  }, src);
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `arm-${name}.png`), buf);
  await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  console.log(`rendered ${name}`);
}

const HIDE_ADD = `L.add.mesh.visible=false; undo.push(()=>{L.add.mesh.visible=true;});`;
const HIDE_ALPHA = `L.alpha.mesh.visible=false; undo.push(()=>{L.alpha.mesh.visible=true;});`;
const LAST = `const a=L.alpha.mesh.renderOrder; L.alpha.mesh.renderOrder=20; undo.push(()=>{L.alpha.mesh.renderOrder=a;});`;
const DW = `const b=L.alpha.mat.depthWrite; L.alpha.mat.depthWrite=true; L.alpha.mat.needsUpdate=true; undo.push(()=>{L.alpha.mat.depthWrite=b; L.alpha.mat.needsUpdate=true;});`;
const HALF = `const c=L.add.mat.uniforms.uIntensity.value; L.add.mat.uniforms.uIntensity.value=c*0.5; undo.push(()=>{L.add.mat.uniforms.uIntensity.value=c;});`;

for (const [name, src] of [
  ['p4-full', ''], ['p4-full2', ''],
  ['p4-noadd', HIDE_ADD], ['p4-noalpha', HIDE_ALPHA], ['p4-bare', HIDE_ADD + HIDE_ALPHA],
  ['p4-half', HALF], ['p4-alphaLast', LAST], ['p4-depthWrite', DW], ['p4-both', LAST + DW],
]) await shoot(name, src);

await browser.close();
await server.close();
console.log(`\nPNGs in ${OUT}`);
