/**
 * Pass 5: the FIX, measured against its own pre-fix state on one frozen frame
 * at the same pinned 0.09 s blast phase pass 4 used.
 *
 * Method is pass 4's, unchanged (reviews/round7/diag-axis6/layerarms4.mjs):
 * freeze the shot, emit a controlled `explosion(pos, 6)` at the harness blast's
 * world position, advance particle time by exactly PHASE, then re-render that
 * one frame per arm with exactly one thing toggled. Nothing here draws from
 * `ctx.fxRng`: emission has already happened, identically, before the first arm
 * renders.
 *
 * This pass runs against the FIXED tree, so the un-toggled arm IS the shipped
 * fix and the "pre" arm restores the old constants. Both therefore come from
 * the same boot, the same emission and the same phase -- the shutter lottery
 * documented in DIAG-axis6-vfx.md section 0.2 cannot enter the comparison.
 *
 * Arms:
 *   p5-pre / p5-pre2  alpha layer depthWrite false, cut 0.004  (pre-fix; twice, for calibration A)
 *   p5-post           shipped fixed state, untouched            (depthWrite true, cut 0.35)
 *   p5-cut15/25/45    the same, with the alpha cut swept
 *   p5-prepass        pre-fix colour pass + a colour-less depth-only pass of the
 *                     same geometry at cut 0.35, renderOrder 11 (after the alpha
 *                     colour pass, before the additive layer). Separates "which
 *                     fragments are drawn" from "which fragments occlude", which
 *                     a single-pass discard cannot.
 *
 * node layerarms5.mjs [--port 5371] [--out <dir>] [--phase 0.09]
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
const PORT = Number(args.port ?? 5371);
const PHASE = Number(args.phase ?? 0.09);
const OUT = path.resolve(args.out ?? 'shots-layerarms5');
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
    alive[nm] = { alive: n, renderOrder: l.mesh.renderOrder, depthWrite: l.mat.depthWrite,
      alphaCut: l.mat.uniforms.uAlphaCut?.value ?? null };
  }
  return { world: [b.x, b.y, b.z], radius: b.radius, phase, layers: alive,
    x: Math.round((v.x + 1) * 0.5 * innerWidth), y: Math.round((1 - v.y) * 0.5 * innerHeight) };
}, PHASE);
console.log('probe', JSON.stringify(info, null, 1));

await mkdir(OUT, { recursive: true });
async function shoot(name, src) {
  await page.evaluate(async (s) => {
    const ctx = globalThis.__GAME__.ctx;
    const THREE = globalThis.__GAME__.THREE;
    const L = ctx.vfx.particles.layers;
    const undo = [];
    // eslint-disable-next-line no-new-func
    (new Function('ctx', 'L', 'undo', 'THREE', s))(ctx, L, undo, THREE);
    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
    globalThis.__UNDO__ = undo;
  }, src);
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `arm-${name}.png`), buf);
  await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  console.log(`rendered ${name}`);
}

// Restore the pre-fix alpha layer: no depth write, and the old fixed 0.004 cut.
const PRE = `
const dw=L.alpha.mat.depthWrite, cut=L.alpha.mat.uniforms.uAlphaCut.value;
L.alpha.mat.depthWrite=false; L.alpha.mat.uniforms.uAlphaCut.value=0.004;
L.alpha.mat.needsUpdate=true;
undo.push(()=>{L.alpha.mat.depthWrite=dw; L.alpha.mat.uniforms.uAlphaCut.value=cut; L.alpha.mat.needsUpdate=true;});
`;
const cutTo = (v) => `
const cut=L.alpha.mat.uniforms.uAlphaCut.value;
L.alpha.mat.uniforms.uAlphaCut.value=${v};
undo.push(()=>{L.alpha.mat.uniforms.uAlphaCut.value=cut;});
`;
// Depth-only pass: the alpha layer's own geometry drawn a second time with no
// colour write, after its colour pass and before the additive layer.
const PREPASS = PRE + `
const src=L.alpha.mat;
const dm=src.clone();
dm.uniforms=THREE.UniformsUtils.clone(src.uniforms);
for (const k in src.uniforms) dm.uniforms[k].value=src.uniforms[k].value;
dm.uniforms.uAlphaCut={value:0.35};
dm.colorWrite=false; dm.depthWrite=true; dm.depthTest=true; dm.transparent=false; dm.blending=THREE.NoBlending;
dm.needsUpdate=true;
const dmesh=new THREE.Mesh(L.alpha.geo, dm);
dmesh.frustumCulled=false; dmesh.renderOrder=11; dmesh.matrixAutoUpdate=false;
ctx.vfx.particles.root.add(dmesh);
undo.push(()=>{ ctx.vfx.particles.root.remove(dmesh); dm.dispose(); });
`;

for (const [name, src] of [
  ['p5-pre', PRE], ['p5-pre2', PRE],
  ['p5-post', ''],
  ['p5-cut15', cutTo(0.15)], ['p5-cut25', cutTo(0.25)], ['p5-cut45', cutTo(0.45)],
  ['p5-prepass', PREPASS],
]) await shoot(name, src);

await browser.close();
await server.close();
console.log(`\nPNGs in ${OUT}`);
