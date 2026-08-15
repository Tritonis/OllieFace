/**
 * Live route-preview probe — the "verify by playing" pass of the HUD half of
 * the corruption-routing slice, run headlessly because this environment has no
 * hands. Follows tools/voidprobe.mjs: real vite server, real page, real game
 * through `__GAME__`/`__HARNESS__`, and every reading taken off the live DOM.
 *
 *   1. early      before stage 3 the gauge says nothing about the route.
 *   2. stage 3    the line appears and names the clean Fracture at band 0.
 *   3. climb      feeding the gauge across band 2 flips it to "contested",
 *                 and past it to the void door.
 *   4. layout     the line is inside the HUD's top-left column and does not
 *                 collide with the band label or the inventory below it.
 *   5. console    zero page errors across the session.
 *
 *   node tools/routeprobe.mjs [--seed 1337] [--port 5224]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5224);
const W = 1600, H = 900;

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  — ${JSON.stringify(detail)}`}`);
};

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));
  await page.evaluate(() => globalThis.__HARNESS__.gameplay({ settleFrames: 60 }));

  /** Drive the live game to a stage/band and read the gauge off the DOM. */
  const read = async (stageIndex, targetBand) => page.evaluate(async ([stageIndex, targetBand]) => {
    const G = globalThis.__GAME__, Hz = globalThis.__HARNESS__, ctx = G.ctx;
    ctx.progression.stageIndex = stageIndex;
    // Climb by feeding the real system, not by writing a private field.
    let guard = 0;
    while (ctx.corruption.band < targetBand && guard++ < 400) ctx.corruption.feed(ctx.player, 5);
    Hz.thaw();
    await Hz.frames(10);
    const route = document.querySelector('.corruption-route');
    const band = document.querySelector('.corruption-band');
    const gauge = document.querySelector('.corruption');
    const inv = document.querySelector('.inventory');
    const r = route?.getBoundingClientRect();
    return {
      stageIndex: ctx.progression.stageIndex,
      band: ctx.corruption.band,
      world: Math.round(ctx.corruption.world),
      text: route?.textContent ?? null,
      on: !!route?.classList.contains('is-on'),
      hasRoute: !!gauge?.classList.contains('has-route'),
      display: route ? getComputedStyle(route).display : null,
      rect: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      bandBottom: band ? Math.round(band.getBoundingClientRect().bottom) : null,
      invTop: inv ? Math.round(inv.getBoundingClientRect().top) : null,
      vw: innerWidth,
    };
  }, [stageIndex, targetBand]);

  const early = await read(0, 0);
  check('stage 1: no route line', early.text === '' && !early.on && early.display === 'none', early);

  const s3 = await read(2, 0);
  check('stage 3 band 0: the clean door is named', s3.text === 'Route: The Fracture' && s3.on, s3);
  check('stage 3 band 0: the line is actually painted', s3.display === 'block' && s3.rect.w > 0 && s3.rect.h > 0, s3.rect);

  const contested = await read(2, 2);
  check('band 2: contested', contested.text === 'Route: contested' && contested.band === 2, contested);

  const void3 = await read(2, 3);
  check('band 3: the void door is named', void3.text === 'Route: The Hungering Fracture' && void3.band === 3, void3);

  const layout = void3;
  check('layout: the line clears the band label', layout.rect.y >= layout.bandBottom - 1,
    { routeTop: layout.rect.y, bandBottom: layout.bandBottom });
  check('layout: the line clears the inventory below it', layout.rect.y + layout.rect.h <= layout.invTop,
    { routeBottom: layout.rect.y + layout.rect.h, invTop: layout.invTop });
  check('layout: the longest label stays on screen', layout.rect.x >= 0 && layout.rect.x + layout.rect.w <= layout.vw,
    { x: layout.rect.x, right: layout.rect.x + layout.rect.w, vw: layout.vw });
  check('gauge bought the row', layout.hasRoute, layout.hasRoute);

  check('no page errors', pageErrors.length === 0, pageErrors);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
