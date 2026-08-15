/**
 * Per-effect coverage of the alpha layer, pre-fix vs post-fix, on one frozen
 * frame at a pinned phase.
 *
 * The capture set only exercises a few of the effects that emit `layer:'alpha'`,
 * and the discard threshold is a *visibility* cut as well as a depth cut, so
 * "which effects lose sprites" has to be asked of every emitter rather than
 * inferred from the two shots that happen to photograph one.
 *
 * Method avoids the null the DIAG's `muzzleFlash` arm hit (section 0.2): every
 * effect is emitted at the harness blast's own world position, which is known to
 * be on screen and unoccluded, and each effect is measured against a frame in
 * which only the alpha layer is hidden — so the difference is that layer's own
 * contribution and nothing else's. Emission happens once per effect and both
 * arms re-render that same frozen state, so no `ctx.fxRng` draw separates them.
 *
 *   node effectarms.mjs [--port 5373] [--out <dir>] [--phase 0.09]
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
const PORT = Number(args.port ?? 5373);
const PHASE = Number(args.phase ?? 0.09);
const OUT = path.resolve(args.out ?? 'shots-effectarms');
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
await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=3&harness=1`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__.explosion());

await mkdir(OUT, { recursive: true });

// Each entry emits exactly one effect at the shared world position `P`.
const EFFECTS = {
  muzzleFlash: 'v.muzzleFlash(P, new T.Vector3(1,0.1,0), 1.6)',
  impact: 'v.impact(P, new T.Vector3(0,1,0), "stone")',
  bloodHit: 'v.bloodHit(P, new T.Vector3(1,0.2,0))',
  explosion: 'v.explosion(P, 6, 0xff8a20)',
  teleporterAura: 'v.teleporterAura(P, 0.5)',
  ring: 'v.ring(P, 3, 0xff7a2a)',
  missile: 'v.missile(P.clone().add(new T.Vector3(-6,0,0)), P, 0xffa040)',
  levelUp: 'v.levelUp(P)',
  itemPickupBurst: 'v.itemPickupBurst(P, 0xffffff)',
  healPop: 'v.healPop(P, 20)',
  shieldBreak: 'v.shieldBreak(P)',
};

const shoot = async (name) => {
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `eff-${name}.png`), buf);
};

const results = [];
for (const [name, call] of Object.entries(EFFECTS)) {
  // Fresh page state per effect: reload so no previous effect's sprites are
  // still alive in the ring buffer and counted as this one's coverage.
  await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=3&harness=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.explosion());

  const info = await page.evaluate(([call, phase]) => {
    const G = globalThis.__GAME__, ctx = G.ctx, T = G.THREE, v = ctx.vfx;
    const b = ctx.vfx._blasts.reduce((a, x) => (a && a.radius >= x.radius ? a : x), null);
    const P = new T.Vector3(b.x, b.y + 1.5, b.z);
    // The harness's own explosion is what puts a camera on something worth
    // photographing, and it emits 64 alpha sprites of its own. Age the whole
    // system past the longest lifetime any of them has (2.4 s) before the
    // measured effect is emitted, or every effect below reports the harness
    // blast's coverage instead of its own -- which is exactly what the first
    // run of this probe did: `healPop` emitted 0 alpha sprites and still
    // measured 11,513 px of alpha-layer coverage.
    v.particles.update(ctx, 4.0);
    const before = {};
    for (const nm in v.particles.layers) before[nm] = v.particles.layers[nm].head;
    // eslint-disable-next-line no-new-func
    (new Function('v', 'P', 'T', 'ctx', `return ${call};`))(v, P, T, ctx);
    v.particles.update(ctx, phase);
    const emitted = {};
    for (const nm in v.particles.layers) {
      const L = v.particles.layers[nm];
      emitted[nm] = (L.head - before[nm] + L.capacity) % L.capacity;
    }
    return { emitted, cut: v.particles.layers.alpha.mat.uniforms.uAlphaCut?.value ?? null };
  }, [call, PHASE]);

  // Three renders of that one frozen emission.
  const render = async (src, tag) => {
    await page.evaluate((s) => {
      const ctx = globalThis.__GAME__.ctx;
      const L = ctx.vfx.particles.layers;
      const undo = [];
      // eslint-disable-next-line no-new-func
      (new Function('ctx', 'L', 'undo', s))(ctx, L, undo);
      ctx.pipeline.render(ctx.scene, ctx.camera, 0);
      globalThis.__UNDO__ = undo;
    }, src);
    await shoot(`${name}-${tag}`);
    await page.evaluate(() => { (globalThis.__UNDO__ ?? []).forEach((f) => f()); });
  };
  const PRE = `const dw=L.alpha.mat.depthWrite,c=L.alpha.mat.uniforms.uAlphaCut.value;
    L.alpha.mat.depthWrite=false; L.alpha.mat.uniforms.uAlphaCut.value=0.004; L.alpha.mat.needsUpdate=true;
    undo.push(()=>{L.alpha.mat.depthWrite=dw; L.alpha.mat.uniforms.uAlphaCut.value=c; L.alpha.mat.needsUpdate=true;});`;
  const HIDE = `L.alpha.mesh.visible=false; undo.push(()=>{L.alpha.mesh.visible=true;});`;
  // `pre2` is `pre` again with nothing else changed: the two must agree pixel
  // for pixel, and where they do not, the analyser masks the pixel out. Without
  // it this probe reported ~2,000 px of "alpha layer coverage" for effects that
  // emit no alpha sprites at all, which is render drift between consecutive
  // re-renders and not coverage.
  await render(PRE, 'pre');
  await render(PRE, 'pre2');
  await render('', 'post');
  await render(PRE + HIDE, 'noalpha');

  results.push({ name, ...info });
  console.log(name, JSON.stringify(info.emitted));
}

await browser.close();
await server.close();
console.log(`\nPNGs in ${OUT}`);
console.log(JSON.stringify(results, null, 1));
