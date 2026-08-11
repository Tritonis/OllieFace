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

// ------------------------------------------------------- blight tile polarity
// The corruption tier used to draw its tiles inverted — the tier colour as a
// solid field with the glyph punched out of it in black. The round-4 UI critic
// scored that as an axis-4 silhouette failure and it is now routed through the
// ordinary `Icons.itemArt` path. This arm proves the shipped tiles, composited
// on a real pause summary, have the same figure/ground polarity as every other
// tier's, and that the magenta tier rule that replaced the inversion survives.
//
// Polarity is read off the plate interior's own luma distribution, so no tier's
// hue enters it: `median` is the ground, and the marks are whatever sits
// furthest from it. `(p95 - median) - (median - p5)` is positive when the marks
// are brighter than the ground (a bright emblem on a dark plate, which is the
// build's rule) and negative when they are darker (the old inversion).
//
// The instrument is calibrated inside the page against a known input: the same
// function is run over a photographic negative of the blight tile, and must
// report the opposite sign. An instrument that cannot see the defect it was
// written to detect is not evidence, and this project has shipped three of them.
await page.evaluate(() => {
  const items = __GAME__.ctx.items;
  items.give('spasm-gland');   // blight, holds no base so it just lands
  items.give('hoof');
  items.give('will-o-wisp');
});
await page.evaluate(() => { const m = __GAME__.ctx.hud.menus; m.close(); m.open('pause'); });
await page.waitForSelector('[data-pause-inv] .ditem.t-blight');
await shot('06-pause-blight.png');

const pol = await page.evaluate(async () => {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });

  // Luma stats over the plate interior only — the chamfered corners are outside
  // the plate and would drag transparent pixels into the distribution.
  const stats = (px, negate) => {
    const lum = [], lit = [];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fx = x / S, fy = y / S;
        if (fx < 0.12 || fx > 0.88 || fy < 0.12 || fy > 0.88) continue;
        const i = (y * S + x) * 4;
        if (px[i + 3] < 250) continue;
        let r = px[i], gg = px[i + 1], b = px[i + 2];
        if (negate) { r = 255 - r; gg = 255 - gg; b = 255 - b; }
        const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        lum.push(l); lit.push([l, r, gg, b]);
      }
    }
    lum.sort((a, b) => a - b);
    const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
    const median = q(0.5), p95 = q(0.95), p5 = q(0.05);
    // Mean colour of the marks — what has to carry the tier hue now that the
    // field no longer does. Sampled as a *band* below the stroke's core: the
    // `color` composite in `itemArt` takes hue and saturation from the tier but
    // keeps the glyph's luminosity, and a pixel at L=1 is white in any hue. The
    // brightest core is therefore neutral on every tier, blight included, and
    // reading it would say nothing about tier colour on any of them.
    // Every pixel the glyph marked, then the most chromatic fifth of them: on
    // any tier the stroke's core is white and its body carries the hue, and the
    // chunkier a glyph's masses the more of it is core. Ranking by chroma asks
    // "is the tier hue in this tile" without assuming what share of the glyph
    // carries it, which a fixed luma band does assume and gets wrong per glyph.
    const marks = lit.filter((v) => v[0] > median + 20);
    const chroma = (v) => Math.max(v[1], v[2], v[3]) - Math.min(v[1], v[2], v[3]);
    const hot = marks.slice().sort((a, b) => chroma(b) - chroma(a)).slice(0, Math.max(1, Math.round(marks.length * 0.2)));
    const mean = (set) => {
      const n = Math.max(1, set.length);
      const m = [1, 2, 3].map((k) => Math.round(set.reduce((s, v) => s + v[k], 0) / n));
      return { r: m[0], g: m[1], b: m[2] };
    };
    return {
      n: lum.length,
      median: +median.toFixed(1),
      polarity: +((p95 - median) - (median - p5)).toFixed(1),
      markPx: marks.length,
      mark: mean(marks),
      hue: mean(hot),
      chroma: +(hot.reduce((s, v) => s + chroma(v), 0) / Math.max(1, hot.length)).toFixed(1),
    };
  };

  const read = async (img, negate) => {
    if (!img.complete) await img.decode();
    g.clearRect(0, 0, S, S);
    g.drawImage(img, 0, 0, S, S);
    return stats(g.getImageData(0, 0, S, S).data, negate);
  };

  const out = { tiers: {}, calib: null, rule: null };
  for (const el of document.querySelectorAll('[data-pause-inv] .ditem')) {
    const tier = [...el.classList].find((k) => k.startsWith('t-'))?.slice(2);
    const img = el.querySelector('img');
    if (!tier || !img || out.tiers[tier]) continue;
    out.tiers[tier] = await read(img, false);
    if (tier === 'blight') {
      // Same tile, figure and ground exchanged — the defect this arm exists for.
      out.calib = await read(img, true);
      out.rule = getComputedStyle(el).color;
    }
  }
  return out;
});

const bl = pol.tiers.blight;
const controls = Object.entries(pol.tiers).filter(([t]) => t !== 'blight');
ok(!!bl && bl.n > 800, `the blight tile was sampled (${bl?.n} px inside the plate)`);
ok(controls.length >= 2, `control tiers sampled for comparison (${controls.map(([t]) => t).join(', ')})`);
ok(pol.calib && pol.calib.polarity < 0 && bl.polarity > 0,
  `calibration: the instrument flips sign on an inverted copy of the same tile `
  + `(shipped ${bl?.polarity} -> negated ${pol.calib?.polarity})`);
ok(bl.polarity > 0, `the blight tile is a bright emblem on a dark plate (polarity ${bl.polarity})`);
ok(controls.every(([, v]) => v.polarity > 0),
  `every control tier has the same polarity (${controls.map(([t, v]) => `${t} ${v.polarity}`).join(', ')})`);
ok(bl.median < 70, `the blight plate is dark ground, not a magenta field (median luma ${bl.median})`);
ok(bl.hue.r > bl.hue.g + 25 && bl.hue.b > bl.hue.g + 15,
  `the blight glyph carries the tier magenta (hue rgb ${bl.hue.r},${bl.hue.g},${bl.hue.b})`);
// Against the tier's declared colour, not against the other tiers: `common` is
// deliberately near-neutral (chroma 14), so a floor derived from the controls
// would be ~8 and would pass a tile with no tier colour in it at all.
const TIER_RGB = { r: 224, g: 90, b: 168 };   // TIERS.blight.color, #e05aa8
ok(bl.chroma > 80 && ['r', 'g', 'b'].every((k) => Math.abs(bl.hue[k] - TIER_RGB[k]) <= 40),
  `and it is the declared tier colour, saturated (chroma ${bl.chroma}, off #e05aa8 by `
  + `${Math.max(...['r', 'g', 'b'].map((k) => Math.abs(bl.hue[k] - TIER_RGB[k])))})`);
ok(pol.rule === 'rgb(224, 90, 168)', `the magenta tier rule survives (.t-blight color ${pol.rule})`);

// The measurement above is of one surface. It generalises to the other eight
// only because all nine call sites (HUD strip, pickup toast, pickup banner,
// pause summary, death summary, Edict tab seal, Edict grid, logbook detail,
// logbook grid) render the same `Icons.itemArt` data URL out of the same cache.
// Proven rather than asserted: the live HUD strip's blight tile and the pause
// summary's are byte-identical strings, so no surface can have its own polarity.
const sameArt = await page.evaluate(() => {
  const strip = document.querySelector('#hud .item.t-blight img')?.getAttribute('src');
  const pause = document.querySelector('[data-pause-inv] .ditem.t-blight img')?.getAttribute('src');
  return { has: !!strip && !!pause, same: strip === pause, len: strip?.length ?? 0 };
});
ok(sameArt.has && sameArt.same,
  `the HUD strip and the pause summary draw the identical blight art (${sameArt.len} chars)`);

// The card that opens off a blight tile. It used to invert too — dark text on a
// magenta chip — to echo the inverted tile. Nothing in the build reverses figure
// and ground now, so the name is written in the tier colour like every other
// tier's, and the chip's background must be genuinely absent rather than merely
// dark: this element is reused across hovers, so a stale inline background would
// follow the player onto the next card they opened.
await page.hover('[data-pause-inv] .ditem.t-blight');
await page.waitForTimeout(350);
const tip = await page.evaluate(() => {
  const n = document.querySelector('#overlay .tip.is-open .tip-name');
  if (!n) return null;
  const cs = getComputedStyle(n);
  return { name: n.textContent.trim(), color: cs.color, bg: cs.backgroundColor, inline: n.getAttribute('style') || '' };
});
ok(!!tip, 'hovering the blight tile opens its card');
ok(tip?.color === 'rgb(224, 90, 168)', `the blight name is written in the tier magenta (${tip?.color})`);
ok(tip?.bg === 'rgba(0, 0, 0, 0)', `and sits on no chip of its own (background ${tip?.bg})`);
ok(!/background|padding/.test(tip?.inline ?? ''), `no inverted chip styling survives inline (style="${tip?.inline}")`);
await shot('07-tooltip-blight.png');
console.log(`  polarity: ${Object.entries(pol.tiers).map(([t, v]) => `${t} ${v.polarity} (median ${v.median})`).join(' | ')}`);
console.log(`  glyph hue: ${Object.entries(pol.tiers).map(([t, v]) => `${t} rgb(${v.hue.r},${v.hue.g},${v.hue.b}) chroma ${v.chroma}`).join(' | ')}`);

await browser.close();
await server.close();
console.log(fail.length ? `\nFAIL - ${fail.join('; ')}` : '\nPASS - picker and pause summary verified');
console.log(`PNGs in ${OUT}`);
process.exit(fail.length ? 1 : 0);
