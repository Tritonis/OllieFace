/**
 * The diegetic-ui money shot — the corruption gauge doing its job.
 *
 * Follows tools/routeprobe.mjs exactly (real vite server, real page, the real
 * game through `__GAME__`/`__HARNESS__`, every number read off the live DOM),
 * and adds the one thing a probe does not do: it takes a photograph.
 *
 * The frame is composed the way a player would arrive at it, not by writing
 * private fields:
 *
 *   1. `lateRun()` — the same harness arm `06-loaded-hud` uses, so the panel
 *      photographs loaded: full inventory strip, real difficulty, real gold.
 *   2. the climb — the world is driven along a rising curve across `--secs`
 *      seconds of pinned simulation time using the two real public levers,
 *      `corruption.feed` and `corruption.bleed`, so the chart recorder has a
 *      *shape* rather than a flat line. One trace sample lands every 1.5 s
 *      (HUD.TRACE_INTERVAL), so the default 75 s turns the pen's 48-sample ring
 *      over completely.
 *   3. the shot — the whole 1600x900 frame, because the thesis is that the
 *      panel reads as one instrument, and a crop would beg that question.
 *
 * Alongside the PNG it writes the five numbers that let the next critique argue
 * with the frame instead of about it: the world corruption at capture, the
 * band, the `.corruption-grad` marks with the pixels each one actually draws
 * inside the track's clip box, the sample count in `HUD._trace`, and the `d`
 * attribute the pen last wrote.
 *
 * Renderer note: headed d3d11, same as capture.mjs with no `--software`. The
 * money shot is compared by eye against ui-shots-after/, so it is taken on the
 * same adapter.
 *
 *   node tools/gaugeshot.mjs [--seed 1337] [--port 5225] [--secs 66]
 *                            [--target 150] [--out reviews/round8/ui-money-shot.png]
 *                            [--record reviews/round8/ui-gauge-probe-record.json]
 *                            [--software]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5225);
// 75 s is not a round number by accident: the pen's ring buffer holds 48
// samples at 1.5 s each, so 50 steps turns it over completely and nothing
// `lateRun` did to the gauge before the climb started survives into the frame.
const SECS = Number(args.secs ?? 75);
// 150 sits in band 3 (Overrun opens at 110, Consumed at 190): the fill clears
// the redline, and the two gradations above it are still visible ahead of the
// pen. Band 4 would peg the bar at 100% and flatten the top of the trace.
const TARGET = Number(args.target ?? 150);
const OUT = String(args.out ?? 'reviews/round8/ui-money-shot.png');
const RECORD = String(args.record ?? 'reviews/round8/ui-gauge-probe-record.json');
const SOFTWARE = 'software' in args;
const W = 1600, H = 900;

const TRACE_INTERVAL = 1.5;   // HUD.js — one pen sample per 1.5 s
const FRAME_DT = 1 / 60;      // the pinned capture clock
const CHUNK = Math.round(TRACE_INTERVAL / FRAME_DT);   // 90 frames = one sample
const STEPS = Math.max(1, Math.round(SECS / TRACE_INTERVAL));

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
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=swiftshader', `--window-size=${W},${H}`]
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--disable-frame-rate-limit', '--force_high_performance_gpu',
      '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });

let record = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));
  await page.evaluate(() => globalThis.__HARNESS__.lateRun());

  // The climb. Each step buys exactly one pen sample, and the target curve is
  // superlinear because that is how a real run rots: slowly while the player is
  // still paying for chests in gold, then faster once the void is extending
  // credit.
  //
  // The world is driven *to* the curve each step, through both of the real
  // public levers — `feed` (the void's tithe) and `bleed` (the counterplay
  // refund) — rather than up towards it. That matters here: `lateRun` hands the
  // player all 97 items at once and `itemGained` tithes every one of them, so
  // the run arrives at the climb already Consumed, with the bar pegged and
  // nothing left for the pen to draw. Correcting in both directions makes the
  // frame show the shape the curve asks for, whatever the rest of the
  // simulation is doing underneath it, and leaves the final reading exactly on
  // `--target`. No rng anywhere; the correction is read off the live world.
  for (let k = 1; k <= STEPS; k++) {
    await page.evaluate(async ([k, steps, target, chunk]) => {
      const ctx = globalThis.__GAME__.ctx, Hz = globalThis.__HARNESS__;
      const want = target * Math.pow(k / steps, 1.6);
      const delta = want - (ctx.corruption?.world ?? 0);
      if (delta > 0) ctx.corruption.feed(ctx.player, delta);
      else if (delta < 0) ctx.corruption.bleed(ctx.player, -delta);
      Hz.thaw();
      await Hz.frames(chunk, 60000);
    }, [k, STEPS, TARGET, CHUNK]);
  }
  // One last correction after the final settle, so the number under the shutter
  // is the number the record publishes.
  await page.evaluate((target) => {
    const ctx = globalThis.__GAME__.ctx;
    const d = target - (ctx.corruption?.world ?? 0);
    if (d > 0) ctx.corruption.feed(ctx.player, d);
    else if (d < 0) ctx.corruption.bleed(ctx.player, -d);
  }, TARGET);
  await page.evaluate(async () => {
    const Hz = globalThis.__HARNESS__;
    await Hz.frames(4);
    Hz.freeze();
  });

  record = await page.evaluate(() => {
    const ctx = globalThis.__GAME__.ctx;
    const hud = ctx.hud;
    const gauge = document.querySelector('.corruption');
    return {
      world: +(ctx.corruption?.world ?? 0).toFixed(3),
      band: ctx.corruption?.band ?? null,
      bandName: document.querySelector('.corruption-band')?.textContent ?? null,
      dataBand: gauge?.dataset.band ?? null,
      fillPct: document.querySelector('.corruption-fill')?.style.width ?? null,
      // `style.left` is a DOM-presence read: it says where a mark was asked to
      // go, not whether a single pixel of it survived the track's clip box.
      // The band-4 mark sat outside it for the whole slice and this record
      // published it as rendered. So the reading is the mark's own rect
      // intersected with the track's padding box, in pixels.
      gradations: (() => {
        const track = document.querySelector('.corruption-track');
        const t = track?.getBoundingClientRect();
        const cs = track ? getComputedStyle(track) : null;
        // The clip box of `overflow: hidden` is the padding box: border in,
        // padding included.
        const clip = t && cs ? {
          left: t.left + parseFloat(cs.borderLeftWidth),
          right: t.right - parseFloat(cs.borderRightWidth),
          top: t.top + parseFloat(cs.borderTopWidth),
          bottom: t.bottom - parseFloat(cs.borderBottomWidth),
        } : null;
        return [...document.querySelectorAll('.corruption-grad')].map((el) => {
          const r = el.getBoundingClientRect();
          const w = clip ? Math.min(r.right, clip.right) - Math.max(r.left, clip.left) : 0;
          const h = clip ? Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top) : 0;
          return {
            band: el.dataset.band,
            left: el.style.left,
            renderedPx: { w: +Math.max(0, w).toFixed(2), h: +Math.max(0, h).toFixed(2) },
          };
        });
      })(),
      redlineLeft: getComputedStyle(document.querySelector('.corruption-redline'), null).left,
      traceSamples: hud?._trace?.length ?? null,
      traceFirst: hud?._trace?.length ? +hud._trace[0].toFixed(4) : null,
      traceLast: hud?._trace?.length ? +hud._trace[hud._trace.length - 1].toFixed(4) : null,
      traceD: document.querySelector('.corruption-trace path')?.getAttribute('d') ?? null,
      route: document.querySelector('.corruption-route')?.textContent ?? null,
      inventory: ctx.hud?.inv?.size ?? 0,
      simTime: +(ctx.time ?? 0).toFixed(3),
    };
  });

  await page.screenshot({ path: OUT });

  // The frame is only worth publishing if the five numbers say the instrument
  // was actually doing something when the shutter opened.
  check('deep band', record.band >= 3, { band: record.band, name: record.bandName, world: record.world });
  // Four marks, at the real thresholds, each of them actually drawing pixels
  // inside the track's clip box — the last clause is the one that matters, and
  // the one this check used to be missing.
  check('the gauge is engraved with the real thresholds',
    record.gradations.length === 4 && record.gradations[0].left.startsWith('10.5')
      && record.gradations.every((g) => g.renderedPx.w >= 1 && g.renderedPx.h >= 1),
    record.gradations);
  check('the pen has a window to show', record.traceSamples >= 40, record.traceSamples);
  check('the trace is a climb, not a flat line',
    record.traceLast - record.traceFirst > 0.3, { first: record.traceFirst, last: record.traceLast });
  check('the pen wrote a path', /^M [\d.]+ [\d.]+ L /.test(record.traceD ?? ''), (record.traceD ?? '').slice(0, 48));
  check('the panel is loaded', record.inventory >= 10, record.inventory);
  check('no page errors', pageErrors.length === 0, pageErrors);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter((c) => !c.pass).length;
writeFileSync(RECORD, `${JSON.stringify({
  tool: 'tools/gaugeshot.mjs',
  command: `node tools/gaugeshot.mjs --seed ${SEED} --secs ${SECS} --target ${TARGET}`,
  renderer: SOFTWARE ? 'swiftshader (headless)' : 'd3d11 (headed)',
  viewport: { w: W, h: H },
  seed: SEED,
  shot: OUT,
  traceIntervalS: TRACE_INTERVAL,
  climbSteps: STEPS,
  gauge: record,
  checks,
  pageErrors,
  ok: failed === 0,
}, null, 2)}\n`);
console.log(`\nwrote ${OUT}\nwrote ${RECORD}`);
console.log(`${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
