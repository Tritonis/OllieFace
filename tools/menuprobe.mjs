/**
 * Menu probe: the pre-run equipment picker and the pause run summary.
 *
 *   node tools/menuprobe.mjs [--port 5222] [--seed 1337] [--out shots-menu]
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
import { resolveOutDir } from './lib/evidence.mjs';
import { TIERS } from '../src/ui/Icons.js';
import { parseArgs, strArg } from './lib/parse-args.mjs';

// The tier colours as the browser will report them, so every assertion below
// compares against the shipped table rather than against a copy of it.
const rgbOf = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});
const cssRgb = (hex) => { const c = rgbOf(hex); return `rgb(${c.r}, ${c.g}, ${c.b})`; };

let args;
try { args = parseArgs(process.argv.slice(2)); }
catch (e) { console.error(`menuprobe: ${e.message}`); process.exit(64); }
const SEED = Number(strArg(args.seed, 1337));
const PORT = Number(strArg(args.port) ?? 5222);
// `shots-menu` is a git-ignored default; the helper flags it so nobody quotes
// one of these PNGs as if it were still there after a clean checkout (#71).
const OUT = resolveOutDir(strArg(args.out, 'shots-menu'), { tool: 'menuprobe' });
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
  const luma = (r, g2, b) => 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
  const inPlate = (x, y) => {
    const fx = x / S, fy = y / S;
    return fx >= 0.12 && fx <= 0.88 && fy >= 0.12 && fy <= 0.88;
  };
  const stats = (px) => {
    const lum = [], lit = [];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (!inPlate(x, y)) continue;
        const i = (y * S + x) * 4;
        if (px[i + 3] < 250) continue;
        const r = px[i], gg = px[i + 1], b = px[i + 2];
        const l = luma(r, gg, b);
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

  const read = async (img) => {
    if (!img.complete) await img.decode();
    g.clearRect(0, 0, S, S);
    g.drawImage(img, 0, 0, S, S);
    return stats(g.getImageData(0, 0, S, S).data);
  };

  // The calibration input: the historical `drawInverted` composite, rebuilt.
  // Deleted in e3efe97 — its source is `git show e3efe97^:src/ui/Icons.js`, and
  // these are the two colours it actually mixed, `mix('#e05aa8','#ffffff',0.10)`
  // at the top of the field and `mix('#e05aa8', TIERS.blight.plate, 0.45)` at the
  // bottom, with every glyph pixel flooded to the plate black by `source-in`.
  //
  // Rebuilt from the shipped tile's *own* glyph mask, so it is the same eleven
  // glyphs at the same geometry with only figure and ground exchanged, which is
  // exactly the defect the round-4 critic scored. It is deliberately NOT a
  // channel negation of the shipped tile: `L = 0.2126r + 0.7152g + 0.0722b` has
  // weights summing to 1, so negation maps `L -> 255 - L`, reverses every
  // percentile, and forces `polarity(negated) = -polarity(original)` as an
  // algebraic identity — for any image whatsoever, including a photograph of a
  // cat. A gate built on that cannot fail and proves nothing about whether this
  // instrument can see the real composite. (It shipped that way once; the
  // round-7 review caught it, and the assertion below now pins the difference.)
  const HIST = { hole: [5, 7, 10], top: [227, 107, 177], bot: [140, 57, 105] };
  const reconstruct = async (img) => {
    if (!img.complete) await img.decode();
    g.clearRect(0, 0, S, S);
    g.drawImage(img, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S), px = d.data;
    const ground = stats(px).median;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        if (px[i + 3] < 250) continue;
        const mark = luma(px[i], px[i + 1], px[i + 2]) > ground + 20;
        const t = y / S;
        for (let k = 0; k < 3; k++) {
          px[i + k] = mark ? HIST.hole[k] : Math.round(HIST.top[k] + (HIST.bot[k] - HIST.top[k]) * t);
        }
      }
    }
    return stats(px);
  };

  const out = { tiers: {}, calib: null, rule: null };
  for (const el of document.querySelectorAll('[data-pause-inv] .ditem')) {
    const tier = [...el.classList].find((k) => k.startsWith('t-'))?.slice(2);
    const img = el.querySelector('img');
    if (!tier || !img || out.tiers[tier]) continue;
    out.tiers[tier] = await read(img);
    if (tier === 'blight') {
      out.calib = await reconstruct(img);
      out.rule = getComputedStyle(el).color;
    }
  }
  return out;
});

const bl = pol.tiers.blight;
const controls = Object.entries(pol.tiers).filter(([t]) => t !== 'blight');
ok(!!bl && bl.n > 800, `the blight tile was sampled (${bl?.n} px inside the plate)`);
ok(controls.length >= 2, `control tiers sampled for comparison (${controls.map(([t]) => t).join(', ')})`);
// Calibration, against a rebuild of the defect this arm was written to catch —
// not against a transform that flips sign on any input. Both gates the shipped
// tile passes must FAIL on the historical composite, or they are not measuring
// what they claim to.
ok(pol.calib && pol.calib.polarity < 0,
  `calibration: the instrument scores the historical drawInverted composite as inverted `
  + `(polarity ${pol.calib?.polarity} vs shipped ${bl?.polarity})`);
ok(pol.calib && pol.calib.median > 70,
  `calibration: and scores its field as bright ground, failing the dark-plate gate `
  + `(median luma ${pol.calib?.median} vs shipped ${bl?.median}, gate is < 70)`);
// Guards the gate above against regressing to the tautology it replaced: a
// channel negation would land the reconstruction at exactly -polarity.
ok(Math.abs(pol.calib.polarity + bl.polarity) > 1,
  `calibration is a rebuilt composite, not a negation of the shipped tile `
  + `(|${pol.calib?.polarity} + ${bl?.polarity}| = ${Math.abs(pol.calib.polarity + bl.polarity).toFixed(1)}, a negation would give 0)`);
ok(bl.polarity > 0, `the blight tile is a bright emblem on a dark plate (polarity ${bl.polarity})`);
ok(controls.every(([, v]) => v.polarity > 0),
  `every control tier has the same polarity (${controls.map(([t, v]) => `${t} ${v.polarity}`).join(', ')})`);
ok(bl.median < 70, `the blight plate is dark ground, not a magenta field (median luma ${bl.median})`);
ok(bl.hue.r > bl.hue.g + 25 && bl.hue.b > bl.hue.g + 15,
  `the blight glyph carries the tier magenta (hue rgb ${bl.hue.r},${bl.hue.g},${bl.hue.b})`);
// Against the tier's declared colour, not against the other tiers: `common` is
// deliberately near-neutral (chroma 14), so a floor derived from the controls
// would be ~8 and would pass a tile with no tier colour in it at all.
//
// Read out of `Icons.js`, not written down here. This probe carried the tier's
// rgb as three literals and #140's re-cut of the palette turned four of its
// checks red without anything being wrong with the build — a probe that has to
// be edited every time the thing it measures legitimately changes is a probe
// people learn to edit without looking.
const TIER_RGB = rgbOf(TIERS.blight.color);
const off = (h) => Math.max(...['r', 'g', 'b'].map((k) => Math.abs(h[k] - TIER_RGB[k])));
ok(bl.chroma > 80 && off(bl.hue) <= 40,
  `and it is the declared tier colour, saturated (chroma ${bl.chroma}, off ${TIERS.blight.color} by ${off(bl.hue)})`);
ok(pol.rule === cssRgb(TIERS.blight.color),
  `the magenta tier rule survives (.t-blight color ${pol.rule}, want ${cssRgb(TIERS.blight.color)})`);

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
ok(tip?.color === cssRgb(TIERS.blight.color),
  `the blight name is written in the tier magenta (${tip?.color}, want ${cssRgb(TIERS.blight.color)})`);
// The chip it must not have is the *inverted* one — a magenta field with black
// type punched out of it — and the way that chip would come back is inline, off
// the hover path that sets it, where it would then follow the player onto the
// next card. What the name does sit on is `--tier-bg`, the opaque near-black
// backing #104 put behind every tier-coloured string so the lit scene stops
// reaching the type; that is a stylesheet rule, it is deliberate, and the
// readability gate asserts it. This arm read `rgba(0, 0, 0, 0)` from before
// #104 and has been red on master since, measuring the fix as if it were the
// defect. It asks the real question now, and the inline check below is what
// actually guards the stale-chip case.
ok(tip?.bg === 'rgb(5, 7, 10)',
  `and sits on the opaque tier backing, not a chip of its own (background ${tip?.bg})`);
ok(!/background|padding/.test(tip?.inline ?? ''), `no inverted chip styling survives inline (style="${tip?.inline}")`);
await shot('07-tooltip-blight.png');
console.log(`  polarity: ${Object.entries(pol.tiers).map(([t, v]) => `${t} ${v.polarity} (median ${v.median})`).join(' | ')}`);
console.log(`  glyph hue: ${Object.entries(pol.tiers).map(([t, v]) => `${t} rgb(${v.hue.r},${v.hue.g},${v.hue.b}) chroma ${v.chroma}`).join(' | ')}`);

// ---------------------------------------------------------- render scale
// From pause into settings, with the run live underneath: the menus are open,
// so the adaptive controller is frozen (`_adapt` returns while paused) and
// the pixel ratio can only move because the slider moved it. This arm runs
// last: it ends in a reload that discards the live run the arms above need.
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
ok((await page.textContent('output[data-out="renderScale"]')).trim() === 'up to 50%',
  'while Auto is on, the readout admits the slider is a ceiling');

await page.click('[data-seg="dynamicRes"] [data-val="0"]');
ok((await page.textContent('output[data-out="renderScale"]')).trim() === '50%',
  'with Dynamic resolution Off, the readout is the scale itself');
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

// B4: hostile persisted values must be clamped by load(), not adopted.
// A hand-edited renderScale of 7 used to render the thumb at the clamp while
// the readout printed 700%, and dynamicRes 5 matched neither segment button.
// This runs after the block above for the same reason that one runs last: it
// reloads again, and the page it lands on has no run and no pause screen.
await page.evaluate(() => {
  const KEY = Object.keys(localStorage).find((k) => localStorage.getItem(k)?.includes('renderScale'));
  const st = JSON.parse(localStorage.getItem(KEY));
  st.renderScale = 7;
  st.dynamicRes = 5;
  st.fov = 9999;
  localStorage.setItem(KEY, JSON.stringify(st));
});
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title', null, { timeout: 60000 });
await page.click('.screen--title [data-act="settings"]');
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'settings');
const clamped = await page.evaluate(() => {
  const input = document.querySelector('input[data-key="renderScale"]');
  const out = document.querySelector('output[data-out="renderScale"]');
  const fovOutEl = document.querySelector('output[data-out="fov"]');
  const on = [...document.querySelectorAll('[data-seg="dynamicRes"] .segbtn')]
    .filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.val);
  return { val: input.value, text: out.textContent.trim(), fovOut: fovOutEl.textContent.trim(), on };
});
ok(clamped.val === '1', `hostile renderScale 7 loads as the 1.0 ceiling (thumb ${clamped.val})`);
ok(clamped.text.includes('100%'), `and the readout agrees with the thumb (${clamped.text})`);
ok(clamped.fovOut.startsWith('110'), `hostile fov 9999 clamps to the slider max, readout included (${clamped.fovOut})`);
ok(clamped.on.length === 1 && clamped.on[0] === '1', `hostile dynamicRes 5 lands on Auto, one segment lit (${clamped.on})`);
await shot('08-hostile-store.png');

await browser.close();
await server.close();
console.log(fail.length ? `\nFAIL - ${fail.join('; ')}` : '\nPASS - picker, pause summary and render scale verified');
console.log(`PNGs in ${OUT}`);
process.exit(fail.length ? 1 : 0);
