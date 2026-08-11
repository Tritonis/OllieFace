/**
 * Pass 3: two candidate fixes, armed against each other on one frozen frame.
 *
 *  p3-alphaLast  alpha layer's renderOrder raised above the additive layer's.
 *                Order-only: it occludes the fireball whether the dust is in
 *                front of it or behind it, which pass 2 measured as a 177 L
 *                hole at the blast centre.
 *  p3-depthWrite alpha layer keeps its place in the order but writes depth, so
 *                the additive fragments *behind* it are z-rejected and the ones
 *                in front are not. Depth-correct by construction; the risk it
 *                carries is that `ParticleFragmentShader` discards only below
 *                a = 0.004, so a near-transparent dust fragment would also
 *                write depth. This arm is what measures whether that risk bites.
 *  p3-both       both, to separate the two effects.
 *
 * node layerarms3.mjs [--port 5351] [--out <dir>]
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
const PORT = Number(args.port ?? 5351);
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
  await page.evaluate(async (src) => {
    const ctx = globalThis.__GAME__.ctx;
    const L = ctx.vfx.particles.layers;
    const undo = [];
    // eslint-disable-next-line no-new-func
    (new Function('ctx', 'L', 'undo', src))(ctx, L, undo);
    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
    globalThis.__UNDO__ = undo;
  }, mutate);
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `arm-${name}.png`), buf);
  await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  console.log(`rendered ${name}`);
}

const LAST = `const w=L.alpha.mesh.renderOrder; L.alpha.mesh.renderOrder=20; undo.push(()=>{L.alpha.mesh.renderOrder=w;});`;
const DW = `const w2=L.alpha.mat.depthWrite; L.alpha.mat.depthWrite=true; L.alpha.mat.needsUpdate=true; undo.push(()=>{L.alpha.mat.depthWrite=w2; L.alpha.mat.needsUpdate=true;});`;
const HIDE_ADD = `L.add.mesh.visible=false; undo.push(()=>{L.add.mesh.visible=true;});`;
const HIDE_ALPHA = `L.alpha.mesh.visible=false; undo.push(()=>{L.alpha.mesh.visible=true;});`;

await shoot('p3-full', '');
await shoot('p3-full2', '');
await shoot('p3-alphaLast', LAST);
await shoot('p3-depthWrite', DW);
await shoot('p3-both', LAST + DW);
await shoot('p3-noadd', HIDE_ADD);
await shoot('p3-bare', HIDE_ADD + HIDE_ALPHA);

await browser.close();
await server.close();
console.log(`\nPNGs in ${OUT}`);
