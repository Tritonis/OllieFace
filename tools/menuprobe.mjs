/**
 * Menu probe: the pre-run equipment picker and the pause run summary.
 *
 *   node tools/menuprobe.mjs [--port 5209] [--seed 1337] [--out shots-menu]
 *
 * Drives the real menus with real clicks — title, select, the Equipment
 * screen, a pick, launch — then asserts the run seeded the picked equipment,
 * opens pause, and hovers an inventory tile for the tooltip. PNGs land in
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

await browser.close();
await server.close();
console.log(fail.length ? `\nFAIL - ${fail.join('; ')}` : '\nPASS - picker and pause summary verified');
console.log(`PNGs in ${OUT}`);
process.exit(fail.length ? 1 : 0);
