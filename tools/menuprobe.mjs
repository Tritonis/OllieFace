/**
 * Menu probe: the pre-run equipment picker and the pause run summary.
 *
 *   node tools/menuprobe.mjs [--port 5209] [--seed 1337] [--out shots-menu]
 *
 * Drives the real menus with real clicks — title, select, the Equipment
 * screen, a pick, launch — then asserts the run seeded the picked equipment,
 * opens pause, hovers an inventory tile for the tooltip, then walks into
 * settings to prove the Render scale slider moves the drawing-buffer ratio,
 * that Dynamic resolution Off disarms the adaptive controller, and that both
 * survive a reload. PNGs land in
 * `shots-menu/`; exit 1 if any assertion fails.
 *
 * Same launch recipe as tools/affixprobe.mjs (headed d3d11, offscreen window).
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--(\w+)$/);
  if (m) args[m[1]] = process.argv[++i];
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5209);
const OUT = path.resolve(args.out ?? 'shots-menu');
const W = 1600, H = 900;
const PICK = 'aegis-emitter';

await mkdir(OUT, { recursive: true });
const fail = [];
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS ' : 'FAIL '} ${msg}`); if (!cond) fail.push(msg); };

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
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); fail.push(`pageerror: ${e.message}`); });
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=2`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title', null, { timeout: 60000 });
const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

// -------------------------------------------------------------- pre-run flow
await page.click('[data-act="play"]');
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'select');
ok(await page.isVisible('[data-chip-equip]'), 'the select footer carries an Equipment chip');
ok((await page.textContent('[data-chip-equip]')).trim() === 'Random', 'the chip defaults to Random');
await shot('01-select.png');

await page.click('[data-act="equipment"]');
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'equipment');
const cards = await page.locator('[data-equip-grid] .art').count();
ok(cards >= 2, `the grid drew Random plus the catalogue (${cards} cards)`);
await shot('02-equipment.png');

await page.click(`[data-equip-id="${PICK}"]`);
ok(await page.locator(`[data-equip-id="${PICK}"].is-on`).count() === 1, 'the picked card lights up');
await shot('03-picked.png');

await page.click('.screen--equipment [data-act="back"]');
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'select');
ok((await page.textContent('[data-chip-equip]')).trim() !== 'Random', 'the chip names the pick');

await page.click('[data-act="launch"]');
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === null, null, { timeout: 30000 });
await page.waitForFunction(() => !!__GAME__.ctx.items?.equipmentId, null, { timeout: 30000 });
const equipped = await page.evaluate(() => __GAME__.ctx.items.equipmentId);
ok(equipped === PICK, `the run seeded the pick (got ${equipped})`);

// ------------------------------------------------------------- pause summary
// A believable mid-run haul, off the run's own drop table.
await page.evaluate(() => {
  const items = __GAME__.ctx.items;
  for (let i = 0; i < 6; i++) items.grant(items.rollItem(null, 'small'));
});
await page.evaluate(() => __GAME__.ctx.hud.menus.open('pause'));
await page.waitForSelector('[data-pause-stats] .stat');
const statCells = await page.locator('[data-pause-stats] .stat').count();
ok(statCells === 8, `eight stat cells drew (${statCells})`);
const tiles = await page.locator('[data-pause-inv] .ditem').count();
ok(tiles >= 2, `the haul drew (${tiles} tiles, equipment first)`);
ok(await page.locator(`[data-pause-inv] .ditem[data-tip-id="${PICK}"]`).count() === 1, 'the equipment tile is the pick');
await shot('04-pause.png');

await page.hover('[data-pause-inv] .ditem >> nth=1');
await page.waitForTimeout(350);
ok(await page.locator('#overlay .tip.is-open').count() === 1, 'hovering a tile opens the tooltip');
const tipName = (await page.textContent('#overlay .tip .tip-name'))?.trim();
ok(!!tipName, `the tooltip names the item (${tipName})`);
await shot('05-tooltip.png');

// ---------------------------------------------------------- render scale
// From pause into settings, with the run live underneath: the menus are open,
// so the adaptive controller is frozen (`_adapt` returns while paused) and
// the pixel ratio can only move because the slider moved it.
await page.click('.screen--pause [data-act="settings"]');  // scoped: the title screen carries the same data-act (pre-flight P1)
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'settings');
ok(await page.locator('input[data-key="renderScale"]').count() === 1, 'the settings screen carries a Render scale slider');
ok(await page.locator('[data-seg="dynamicRes"] .segbtn').count() === 2, 'the Dynamic resolution switch drew both positions');

const ratioBefore = await page.evaluate(() => __GAME__.ctx.pipeline.renderer.getPixelRatio());
await page.locator('input[data-key="renderScale"]').evaluate((el) => {
  el.value = '0.5';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const ratioAfter = await page.evaluate(() => __GAME__.ctx.pipeline.renderer.getPixelRatio());
ok(Math.abs(ratioAfter - ratioBefore * 0.5) < 1e-3,
  `render scale 50% halves the drawing-buffer ratio (${ratioBefore.toFixed(3)} -> ${ratioAfter.toFixed(3)})`);
ok((await page.textContent('output[data-out="renderScale"]')).trim() === '50%', 'the readout says 50%');

await page.click('[data-seg="dynamicRes"] [data-val="0"]');
const dyn = await page.evaluate(() => ({
  adaptOn: __GAME__.ctx.pipeline._adaptOn,
  resScale: __GAME__.ctx.pipeline._resScale,
  stored: JSON.parse(localStorage.getItem('telluric.settings')),
}));
ok(dyn.adaptOn === false, 'Off disarms the adaptive controller');
ok(dyn.resScale === 1, 'Off resets the adaptive term so the slider owns the buffer');
ok(dyn.stored.renderScale === 0.5 && dyn.stored.dynamicRes === 0, 'both settings persisted to localStorage');
await shot('06-render-scale.png');

// Reload: the saved settings must come back and land on the pipeline at boot.
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title', null, { timeout: 60000 });
const boot = await page.evaluate(() => ({
  userScale: __GAME__.ctx.pipeline._userScale,
  adaptOn: __GAME__.ctx.pipeline._adaptOn,
  pinned: __GAME__.ctx.pipeline._pinned,
}));
ok(boot.pinned === false || (boot.userScale === 1),
  'a pinned pipeline ignored the saved scale; an unpinned one may adopt it');
ok(boot.pinned || (boot.userScale === 0.5 && boot.adaptOn === false),
  `saved render scale survives a reload (userScale ${boot.userScale}, dynamic ${boot.adaptOn})`);

await browser.close();
await server.close();
console.log(fail.length ? `\nFAIL - ${fail.join('; ')}` : '\nPASS - picker, pause summary and render scale verified');
console.log(`PNGs in ${OUT}`);
process.exit(fail.length ? 1 : 0);
