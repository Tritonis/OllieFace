/**
 * Round-4 audio critique (round 7), probe 6: the refusal rate, and the
 * WORLD_VOICES sweep round 4 listed as untested arm 6.
 *
 * p4's sweep measured nothing — `combat()` leaves the director disabled and the
 * arena empties, so it recorded 0 `_take` calls in 25 s. That is an instrument
 * failure and it is reported as one. This probe uses the recipe that actually
 * sustains a fight: re-enable the director, neuter damage to the player so the
 * run cannot end mid-measurement, and hold everything inside one page context.
 *
 * `_take` is REPLACED with a faithful reimplementation parameterised on the
 * world budget, so the graph genuinely behaves differently at each value —
 * refusals change which nodes exist, which changes occupancy, which changes the
 * next refusal. Recomputing refusals after the fact from one run's call log
 * would not capture that.
 *
 *   node reviews/round7/r5-audio/p6-sweep.mjs [--port 5701]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5701);
const SECONDS = Number(args.seconds ?? 40);
const out = { seconds: SECONDS, runs: [] };
const log = (...a) => console.log('[p6]', ...a);

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 180000, headless: false,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--force_high_performance_gpu', '--window-position=-2400,-2400'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 120000 });
await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.up();
await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.audio?.ready === true, null, { timeout: 30000 });
log('ready');

// One-time: a counting wrapper that records the cost of every refusal, and a
// damage cap so the player cannot die inside a measurement.
await page.evaluate(() => {
  const ctx = globalThis.__GAME__.ctx;
  const c = ctx.combat;
  if (c?.applyDamage && !c.__capped) {
    const orig = c.applyDamage.bind(c);
    c.applyDamage = (t, amt, info) => orig(t, t?.isPlayer ? 0.001 : amt, info);
    c.__capped = true;
  }
});

for (const budget of [30, 44, 60, 88]) {
  await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
  await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
  const row = await page.evaluate(async ({ B, secs }) => {
    const ctx = globalThis.__GAME__.ctx, a = ctx.audio;
    // p6's first attempt measured 0 takes and 0 enemies at difficulty 1.000:
    // the page was sitting paused behind a menu, so no fixed step ran and the
    // director never banked a credit. Force the run state, and record it per
    // sample so a repeat of that failure is visible instead of silent.
    ctx.hud?.menus?.close?.();
    ctx.paused = false;
    ctx.director.enabled = true;
    a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
    const R = { takes: 0, refusals: 0, byCost: {}, worldRefusals: 0, priorityRefusals: 0 };
    a._take = (cost = 1, priority = false) => {
      const ok = priority ? a.priorityVoices + cost <= 28 : a.worldVoices + cost <= B;
      R.takes++;
      if (!ok) {
        R.refusals++;
        R.byCost[cost] = (R.byCost[cost] ?? 0) + 1;
        if (priority) R.priorityRefusals++; else R.worldRefusals++;
        return false;
      }
      a._priorityCharge = priority;
      return true;
    };
    const rows = [];
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      await new Promise((r) => setTimeout(r, 500));
      ctx.paused = false; ctx.director.enabled = true;
      rows.push({
        paused: !!ctx.paused, time: +(ctx.time ?? 0).toFixed(1),
        t: +((performance.now() - t0) / 1000).toFixed(1),
        alive: (ctx.director.enemies ?? []).filter((e) => e.alive).length,
        cap: ctx.director.populationCap,
        diff: +ctx.director.difficultyCoefficient.toFixed(3),
        I: +a.musicEngine.intensity.toFixed(4),
        pressure: +a.musicEngine.pressure.toFixed(4),
        arc: +a.musicEngine.arc.toFixed(4),
        voices: a.voices, world: a.worldVoices, prio: a.priorityVoices,
        red: +a.limiter.reduction.toFixed(3),
        sfxRed: +a.sfxLimiter.reduction.toFixed(3),
        stopped: a.musicEngine.stopped, dead: ctx.player?.alive === false,
      });
    }
    delete a._take;                       // back to the shipped gate
    const secsReal = (performance.now() - t0) / 1000;
    const mean = (f) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(3);
    return {
      budget: B, seconds: +secsReal.toFixed(1), samples: rows.length,
      takes: R.takes, refusals: R.refusals,
      refusalPct: +(100 * R.refusals / Math.max(1, R.takes)).toFixed(1),
      refusalsPerSec: +(R.refusals / secsReal).toFixed(1),
      refusalsByCost: R.byCost,
      worldRefusals: R.worldRefusals, priorityRefusals: R.priorityRefusals,
      enemiesMean: mean((r) => r.alive), enemiesMax: Math.max(...rows.map((r) => r.alive)),
      capMax: Math.max(...rows.map((r) => r.cap)), diffMax: Math.max(...rows.map((r) => r.diff)),
      voicesPeak: Math.max(...rows.map((r) => r.voices)),
      worldPeak: Math.max(...rows.map((r) => r.world)),
      priorityPeak: Math.max(...rows.map((r) => r.prio)),
      I: { min: Math.min(...rows.map((r) => r.I)), max: Math.max(...rows.map((r) => r.I)), mean: mean((r) => r.I) },
      pressure: { max: Math.max(...rows.map((r) => r.pressure)), mean: mean((r) => r.pressure) },
      masterRed: { worst: Math.min(...rows.map((r) => r.red)), mean: mean((r) => r.red) },
      sfxRed: { worst: Math.min(...rows.map((r) => r.sfxRed)), mean: mean((r) => r.sfxRed) },
      engineStoppedSamples: rows.filter((r) => r.stopped).length,
      playerDeadSamples: rows.filter((r) => r.dead).length,
    };
  }, { B: budget, secs: SECONDS });
  out.runs.push(row);
  log(JSON.stringify(row));
}

/* The shipped configuration, unmodified `_take`, as the control. */
await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
out.shippedControl = await page.evaluate(async (secs) => {
  const ctx = globalThis.__GAME__.ctx, a = ctx.audio;
  ctx.hud?.menus?.close?.();
  ctx.paused = false;
  ctx.director.enabled = true;
  a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
  a._takes = 0; a._refusals = 0;
  const rows = [];
  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    ctx.paused = false; ctx.director.enabled = true;
    rows.push({
      alive: (ctx.director.enemies ?? []).filter((e) => e.alive).length,
      I: +a.musicEngine.intensity.toFixed(4), pressure: +a.musicEngine.pressure.toFixed(4),
      world: a.worldVoices, prio: a.priorityVoices, voices: a.voices,
      red: +a.limiter.reduction.toFixed(3), sfxRed: +a.sfxLimiter.reduction.toFixed(3),
      diff: +ctx.director.difficultyCoefficient.toFixed(3),
      stopped: a.musicEngine.stopped, dead: ctx.player?.alive === false,
    });
  }
  const secsReal = (performance.now() - t0) / 1000;
  const mean = (f) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(3);
  return {
    seconds: +secsReal.toFixed(1), takes: a._takes, refusals: a._refusals,
    refusalPct: +(100 * a._refusals / Math.max(1, a._takes)).toFixed(1),
    refusalsPerSec: +(a._refusals / secsReal).toFixed(1),
    enemiesMean: mean((r) => r.alive), enemiesMax: Math.max(...rows.map((r) => r.alive)),
    worldPeak: Math.max(...rows.map((r) => r.world)),
    priorityPeak: Math.max(...rows.map((r) => r.prio)),
    voicesPeak: Math.max(...rows.map((r) => r.voices)),
    I: { min: Math.min(...rows.map((r) => r.I)), max: Math.max(...rows.map((r) => r.I)), mean: mean((r) => r.I) },
    pressureMax: Math.max(...rows.map((r) => r.pressure)),
    diffMax: Math.max(...rows.map((r) => r.diff)),
    masterRed: { worst: Math.min(...rows.map((r) => r.red)), mean: mean((r) => r.red) },
    sfxRed: { worst: Math.min(...rows.map((r) => r.sfxRed)), mean: mean((r) => r.sfxRed) },
    engineStoppedSamples: rows.filter((r) => r.stopped).length,
    playerDeadSamples: rows.filter((r) => r.dead).length,
  };
}, SECONDS);
log('shipped control', JSON.stringify(out.shippedControl));

/* Voice drain: does the counter come back down while sound is still being made? */
out.drain = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx, a = ctx.audio;
  ctx.director.enabled = false;
  for (const e of ctx.director.enemies) e.alive = false;
  const t0 = a._takes;
  const series = [];
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    series.push([a.voices, a.worldVoices, a.priorityVoices]);
  }
  return { series, newTakesDuringDrain: a._takes - t0 };
});
out.errors = errs.slice(0, 10);

await writeFile('reviews/round7/r5-audio/p6b-sweep.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
