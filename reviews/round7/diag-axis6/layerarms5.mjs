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
 *   p5-pre / p5-pre2  the alpha layer's depth pass hidden — no depth relationship
 *                     between the layers at all, i.e. the pre-fix engine (twice,
 *                     for calibration A)
 *   p5-post           shipped state, untouched: colour pass at cut 0.004 with no
 *                     depth write, depth-only pass at renderOrder 11, cut 0.35
 *   p5-cut15/25/45    the same, with the *occlusion* cut swept
 *   p5-discard        the mechanism this branch abandoned, kept as an arm so its
 *                     cost stays on the record from the same boot: no depth pass,
 *                     the alpha colour pass writing depth with its own cut raised
 *                     to 0.35 — one constant doing both jobs.
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
const AGE = Number(args.age ?? 4.0);
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

const info = await page.evaluate(([phase, age]) => {
  const G = globalThis.__GAME__, ctx = G.ctx;
  const b = ctx.vfx._blasts.reduce((a, x) => (a && a.radius >= x.radius ? a : x), null);
  const p = new G.THREE.Vector3(b.x, b.y, b.z);
  // Age the scenario's own blast out of the frame before emitting the measured
  // one. Pass 4 left it in, and it is a second particle field sitting on top of
  // the controlled one at a phase the shutter lottery picks: across two boots of
  // this script with it present, the largest radial step about the same centre
  // came out 7.6 -> 29.7 L and 9.2 -> 9.7 L. The controlled phase is only a
  // constant of the measurement if nothing *else* in the frame is still moving.
  ctx.vfx.particles.update(ctx, age);
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
      alphaCut: l.mat.uniforms.uAlphaCut?.value ?? null,
      depthPass: l.depthMesh
        ? { renderOrder: l.depthMesh.renderOrder, depthWrite: l.depthMat.depthWrite,
          colorWrite: l.depthMat.colorWrite, cut: l.depthMat.uniforms.uAlphaCut.value }
        : null };
  }
  return { world: [b.x, b.y, b.z], radius: b.radius, phase, age, layers: alive,
    x: Math.round((v.x + 1) * 0.5 * innerWidth), y: Math.round((1 - v.y) * 0.5 * innerHeight) };
}, [PHASE, AGE]);
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

// Pre-fix engine: hide the depth-only pass and nothing else. The colour passes
// are already exactly what they were before this branch.
const PRE = `
L.alpha.depthMesh.visible=false;
undo.push(()=>{L.alpha.depthMesh.visible=true;});
`;
const cutTo = (v) => `
const cut=L.alpha.depthMat.uniforms.uAlphaCut.value;
L.alpha.depthMat.uniforms.uAlphaCut.value=${v};
undo.push(()=>{L.alpha.depthMat.uniforms.uAlphaCut.value=cut;});
`;
// The abandoned mechanism: one constant deciding visibility and occlusion both.
const DISCARD = PRE + `
const cut=L.alpha.mat.uniforms.uAlphaCut.value;
L.alpha.mat.uniforms.uAlphaCut.value=0.35;
L.alpha.mat.depthWrite=true; L.alpha.mat.needsUpdate=true;
undo.push(()=>{L.alpha.mat.uniforms.uAlphaCut.value=cut; L.alpha.mat.depthWrite=false; L.alpha.mat.needsUpdate=true;});
`;

for (const [name, src] of [
  ['p5-pre', PRE], ['p5-pre2', PRE],
  ['p5-post', ''],
  ['p5-cut15', cutTo(0.15)], ['p5-cut25', cutTo(0.25)], ['p5-cut45', cutTo(0.45)],
  ['p5-discard', DISCARD],
]) await shoot(name, src);

await browser.close();
await server.close();
console.log(`\nPNGs in ${OUT}`);
