/**
 * Issue #134, live arm: the REAL game in a real Chromium with a real
 * AudioContext, driven into a dense fight, taps the destination through an
 * `AnalyserNode` and reports peak / clipped-frame counts alongside both
 * limiters' gain reduction.
 *
 * The offline arm (`dense-sfx.mjs`) can be driven to any density; this one says
 * what density the game actually produces, so the offline numbers can be read
 * against a real fight instead of an invented one.
 *
 *   node reviews/audio-134/live-dense.mjs [--port 5241] [--seconds 45]
 *                                         [--enemies 24] [--out <path>]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) { const t = process.argv[i]; if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1]; }
const PORT = Number(args.port ?? 5241);
const SECONDS = Number(args.seconds ?? 45);
const ENEMIES = Number(args.enemies ?? 24);
const MASTER = args.master === undefined ? null : Number(args.master);
const SFXVOL = args.sfx === undefined ? null : Number(args.sfx);
const BLIND = args.blind ?? 'none';
const OUT = args.out ?? `reviews/audio-134/live-${ENEMIES}${MASTER === null ? '' : `-m${MASTER}`}${SFXVOL === null ? '' : `-s${SFXVOL}`}${BLIND === 'none' ? '' : `-blind-${BLIND}`}.json`;
const log = (...a) => console.log('[live134]', ...a);

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 180000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--force_high_performance_gpu', '--window-position=-2400,-2400', '--window-size=1280,720'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/?seed=7&quality=3&harness=1`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 120000 });
await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.up();
await page.evaluate((n) => globalThis.__HARNESS__?.combat?.({ enemies: n }), ENEMIES);
await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.audio?.ready === true, null, { timeout: 30000 });
log('ready');

// The player must survive the measurement.
await page.evaluate(() => {
  const c = globalThis.__GAME__.ctx.combat;
  if (c?.applyDamage && !c.__capped) {
    const orig = c.applyDamage.bind(c);
    c.applyDamage = (t, amt, info) => orig(t, t?.isPlayer ? 0.001 : amt, info);
    c.__capped = true;
  }
});

const result = await page.evaluate(async ({ secs, master, sfxVol, blind }) => {
  const ctx = globalThis.__GAME__.ctx, a = ctx.audio;
  const ac0 = a.ac;
  // The loudest legal player configuration is a real operating point: the
  // sliders go to 1, and the boot default is 0.8.
  if (master !== null) a.setMasterVolume(master);
  if (sfxVol !== null) a.setSfxVolume(sfxVol);
  // Falsification arm: take a limiter out of the chain, so a meter that cannot
  // report clipping is visible as such rather than being read as a clean mix.
  const blinded = [];
  if (blind === 'sfx' || blind === 'both') { a.sfx.disconnect(); a.sfx.connect(a.master); blinded.push('sfxLimiter'); }
  if (blind === 'master' || blind === 'both') { a.master.disconnect(); a.master.connect(ac0.destination); blinded.push('masterLimiter'); }
  ctx.director.enabled = true;
  const ac = a.ac;
  const an = ac.createAnalyser();
  an.fftSize = 2048;
  // Tap the very end of the chain: what leaves for the speakers.
  (blinded.includes('masterLimiter') ? a.master : a.limiter).connect(an);
  const buf = new Float32Array(an.fftSize);

  a._takes = 0; a._refusals = 0;
  let peak = 0, clippedFrames = 0, frames = 0, sumSq = 0, sumN = 0;
  const rows = [];
  const t0 = performance.now();
  let lastRow = 0;
  await new Promise((done) => {
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) { const m = Math.abs(buf[i]); if (m > p) p = m; sumSq += buf[i] * buf[i]; }
      sumN += buf.length;
      frames++;
      if (p > peak) peak = p;
      if (p >= 0.999) clippedFrames++;
      const now = performance.now();
      if (now - lastRow >= 500) {
        lastRow = now;
        rows.push({
          t: +((now - t0) / 1000).toFixed(1),
          alive: (ctx.director.enemies ?? []).filter((e) => e.alive).length,
          voices: a.voices, world: a.worldVoices, prio: a.priorityVoices,
          peak: +p.toFixed(4),
          sfxRed: +a.sfxLimiter.reduction.toFixed(3),
          masterRed: +a.limiter.reduction.toFixed(3),
          I: +a.musicEngine.intensity.toFixed(3),
        });
      }
      if (now - t0 >= secs * 1000) done(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const secsReal = (performance.now() - t0) / 1000;
  const mean = (f) => +(rows.reduce((s, r) => s + f(r), 0) / Math.max(1, rows.length)).toFixed(3);
  return {
    blinded,
    masterVolume: a.masterVolume, sfxVolume: a.sfxVolume, musicVolume: a.musicVolume,
    seconds: +secsReal.toFixed(1), analyserFrames: frames, rowSamples: rows.length,
    peak_lin: +peak.toFixed(4),
    peak_dBFS: +(20 * Math.log10(Math.max(1e-9, peak))).toFixed(2),
    framesAtOrOverFullScale: clippedFrames,
    rms_dBFS: +(20 * Math.log10(Math.max(1e-9, Math.sqrt(sumSq / sumN)))).toFixed(2),
    takes: a._takes, refusals: a._refusals,
    refusalPct: +(100 * a._refusals / Math.max(1, a._takes)).toFixed(1),
    takesPerSec: +(a._takes / secsReal).toFixed(1),
    voicesPeak: Math.max(...rows.map((r) => r.voices)),
    enemiesMean: mean((r) => r.alive), enemiesMax: Math.max(...rows.map((r) => r.alive)),
    sfxRed: { mean: mean((r) => r.sfxRed), worst: Math.min(...rows.map((r) => r.sfxRed)) },
    masterRed: { mean: mean((r) => r.masterRed), worst: Math.min(...rows.map((r) => r.masterRed)) },
    rows,
  };
}, { secs: SECONDS, master: MASTER, sfxVol: SFXVOL, blind: BLIND });

await writeFile(OUT, JSON.stringify({ result, errors: errs }, null, 2));
const { rows, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
if (errs.length) console.log('ERRORS:\n' + errs.slice(0, 10).join('\n'));
await browser.close();
await server.close();
