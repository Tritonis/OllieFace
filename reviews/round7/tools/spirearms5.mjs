/**
 * Second arm set for the b2 canyon-fin residual. Same runtime-only discipline
 * as `spireprobe.mjs`: every arm is applied through the page and undone, no
 * source file is touched, and two identical controls bracket the set so the
 * cost of the three rendered frames each arm spends is measured.
 *
 *   node reviews/round7/tools/spirearms5.mjs --out reviews/round7/captures/diag-spire-arms5 --port 5304
 *
 * The arms answer two separate questions:
 *
 *  - **Dose-response on the two levers a fix could pull.** `r0.74/0.78/0.82`
 *    walk the canyon's terrain roughness back up toward `MAT_TUNE_BASE`
 *    (0.82); `d0.70/d0.50` scale the detail pass's two amplitudes down.
 *  - **Is the existing specular-AA term saturated or blind?** `uDetE.w` is the
 *    baked field's gradient RMS and enters `detHidden` squared, so it is a pure
 *    gain on `detVarW` — the world-space half of `detAlpha`. If multiplying it
 *    by 4 (a 16x gain on that term) does not move PEAK, then `detVarW` is not
 *    small because the gain is wrong; it is small because `1 - res*res` is
 *    near zero, i.e. the pass believes its octaves are resolved here.
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
const OUT = path.resolve(args.out ?? 'reviews/round7/captures/diag-spire-arms5');
const PORT = Number(args.port ?? 5304);
const SEED = Number(args.seed ?? 1337);
const log = (...m) => console.log('[spirearms5]', ...m);

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
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.setDefaultNavigationTimeout(120000);
await mkdir(OUT, { recursive: true });
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
const pinned = await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60) ?? false);
log('clockPinned', pinned);

for (const s of ['title', 'artifacts', 'difficulty', 'vista', 'gameplay',
                 'survivors', 'survivorSelect', 'logbook']) {
  await page.evaluate((n) => globalThis.__HARNESS__?.[n]?.().catch?.(() => {}), s).catch(() => {});
}
await page.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 0, restore: false })).catch(() => {});
await page.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 1, restore: false })).catch(() => {});
log('on 13-biomes-2');

const ARMS = [
  ['ctrl-a', {}],
  ['ff110', { fineFade: 110 }],
  ['ff160', { fineFade: 160 }],
  ['ff110r082', { fineFade: 110, rough: 0.82 }],
  ['ff160r082', { fineFade: 160, rough: 0.82 }],
  ['ff220', { fineFade: 220 }],
  ['ctrl-b', {}],
];
for (const [name, cfg] of ARMS) {
  await page.evaluate((c) => {
    const G = globalThis.__GAME__;
    const M = G.ctx.stage.terrain.mesh.material;
    const S = (G.__armSave ||= {
      rough: M.roughness,
      detA: M.userData.det.uDetA.value.clone(),
      detB: M.userData.det.uDetB.value.clone(),
      detD: M.userData.det.uDetD.value.clone(),
      detE: M.userData.det.uDetE.value.clone(),
    });
    M.roughness = S.rough;
    M.userData.det.uDetA.value.copy(S.detA);
    M.userData.det.uDetB.value.copy(S.detB);
    M.userData.det.uDetD.value.copy(S.detD);
    M.userData.det.uDetE.value.copy(S.detE);
    if (c.rough !== undefined) M.roughness = c.rough;
    if (c.detK !== undefined) {
      M.userData.det.uDetA.value.set(S.detA.x, S.detA.y * c.detK, S.detA.z, S.detA.w * c.detK);
    }
    if (c.fineAmp !== undefined) M.userData.det.uDetA.value.y = c.fineAmp;
    if (c.coarseAmp !== undefined) M.userData.det.uDetA.value.w = c.coarseAmp;
    if (c.cavity !== undefined) M.userData.det.uDetB.value.z = c.cavity;
    if (c.roughMod !== undefined) M.userData.det.uDetB.value.w = c.roughMod;
    if (c.fineFade !== undefined) M.userData.det.uDetD.value.w = c.fineFade;
    if (c.gradK !== undefined) M.userData.det.uDetE.value.w = S.detE.w * c.gradK;
    M.needsUpdate = true;
    G.engine.start();
  }, cfg);
  await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const tick = () => (++n >= 3 ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  await page.evaluate(() => globalThis.__GAME__.engine.stop());
  await page.screenshot({ path: path.join(OUT, `arm-${name}.png`) });
  log('arm', name, JSON.stringify(cfg));
}
await writeFile(path.join(OUT, 'arms.json'),
  JSON.stringify({ seed: SEED, clockPinned: pinned, arms: ARMS, errors }, null, 2));
await browser.close();
await server.close();
log('done ->', OUT);
