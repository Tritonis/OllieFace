/**
 * Round-4 audio critique (round 7), probe 3: instrument sanity.
 *
 * Two things p2 could not be trusted on:
 *  1. the clap-vs-kick peak claim, which turns on a single number — measured
 *     here across five independent seeds so the spread is visible;
 *  2. phase cancellation, where p2's sum-of-parts read 9.7 dB HOTTER than the
 *     mix. That is not a product result, it is a broken instrument: `mkOffline`
 *     filled the shared noise buffer from the *real* `Math.random`, so every
 *     render got a different noise buffer and the parts were not summable.
 *     Here the buffer is seeded too, and every solo render is reported so an
 *     outlier is visible rather than hidden inside a sum.
 *
 *   node reviews/round7/r5-audio/p3-check.mjs [--port 5503]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5503);

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 180000, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/reviews/round7/r5-audio/blank.html`, { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  const { MusicEngine } = await import('/src/systems/Music.js');
  const SR = 48000;
  const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));
  const out = {};

  const realRandom = Math.random;
  let seedState = 1;
  const seedRandom = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; };
  const setSeed = (s) => { seedState = s >>> 0; };

  function stats(a) {
    let sq = 0, peak = 0, sum = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i]; sq += v * v; sum += v; const m = v < 0 ? -v : v; if (m > peak) peak = m; }
    return { rms_dB: +dB(Math.sqrt(sq / a.length)).toFixed(2), peak_dB: +dB(peak).toFixed(2), peak_lin: +peak.toFixed(5), dc: +(sum / a.length).toExponential(2) };
  }
  function gameCtx() {
    const list = []; for (let i = 0; i < 60; i++) list.push({ alive: true, position: { x: 5, y: 0, z: 0 } });
    return { paused: false, player: { position: { x: 0, y: 0, z: 0 } },
      director: { difficultyCoefficient: 12, enemies: list, populationCap: 60, boss: null },
      progression: { state: 'idle' } };
  }

  /* ---- everything seeded, including the noise buffer --------------------- */
  async function render(seconds, seed, { solo = null, isolateToDestination = false } = {}) {
    Math.random = seedRandom;
    try {
      setSeed(seed);
      const oac = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
      let clock = 0;
      Object.defineProperty(oac, 'currentTime', { get: () => clock, configurable: true });
      const noise = oac.createBuffer(1, SR * 2, SR);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = seedRandom() * 2 - 1;
      const bus = oac.createGain(); bus.connect(oac.destination);
      const eng = new MusicEngine(oac, bus, noise);
      eng._runT = 500;
      if (isolateToDestination && solo) {
        eng.duck.disconnect();
        for (const L of eng.layers.values()) L.g.disconnect();
        eng.layers.get(solo).g.connect(oac.destination);
      } else if (solo) {
        for (const [n, L] of eng.layers) if (n !== solo) L.g.disconnect();
      }
      const ctx = gameCtx();
      const dt = 1 / 60;
      for (let t = 0; t < seconds - 0.6; t += dt) { clock = t; eng.update(ctx, dt); eng.bump(0.02); }
      const buf = await oac.startRendering();
      return { data: buf.getChannelData(0).slice(), I: eng.intensity };
    } finally { Math.random = realRandom; }
  }

  /* ==== 1. clap vs kick across five seeds ================================= */
  {
    const rows = [];
    for (const seed of [11, 2222, 33333, 444444, 5555555]) {
      const k = await render(14, seed, { solo: 'kick', isolateToDestination: true });
      const c = await render(14, seed, { solo: 'clap', isolateToDestination: true });
      const h = Math.round(k.data.length / 2);
      const ks = stats(k.data.subarray(h)), cs = stats(c.data.subarray(h));
      rows.push({ seed, kick_peak_dB: ks.peak_dB, clap_peak_dB: cs.peak_dB,
        clapOverKick_peak_dB: +(cs.peak_dB - ks.peak_dB).toFixed(2),
        kick_rms_dB: ks.rms_dB, clap_rms_dB: cs.rms_dB,
        clapOverKick_rms_dB: +(cs.rms_dB - ks.rms_dB).toFixed(2), I: +k.I.toFixed(3) });
    }
    const v = rows.map((r) => r.clapOverKick_peak_dB);
    out.clapVsKick = { rows, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), min: Math.min(...v), max: Math.max(...v) };
  }

  /* ==== 2. phase: mix vs sum of parts, everything seeded ================== */
  {
    const NAMES = ['kick', 'clap', 'bass', 'lead', 'openhat', 'hat', 'acid', 'perc', 'sub', 'pad'];
    const SEED = 31337, SEC = 10;
    const full = await render(SEC, SEED);
    const sum = new Float32Array(full.data.length);
    const parts = {};
    for (const n of NAMES) {
      const p = await render(SEC, SEED, { solo: n });
      const h = Math.round(p.data.length / 2);
      parts[n] = stats(p.data.subarray(h));
      for (let i = 0; i < sum.length; i++) sum[i] += p.data[i];
    }
    const h = Math.round(full.data.length / 2);
    const fs = stats(full.data.subarray(h)), ss = stats(sum.subarray(h));
    let res = 0;
    for (let i = h; i < full.data.length; i++) { const d = full.data[i] - sum[i]; res += d * d; }
    out.phase = {
      parts, mix: fs, sumOfParts: ss,
      delta_dB: +(fs.rms_dB - ss.rms_dB).toFixed(2),
      residual_rms_dB: +dB(Math.sqrt(res / (full.data.length - h))).toFixed(2),
      residualBelowMix_dB: +(dB(Math.sqrt(res / (full.data.length - h))) - fs.rms_dB).toFixed(2),
    };
  }

  return out;
});

await writeFile('reviews/round7/r5-audio/p3-check.json', JSON.stringify({ result, logs }, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
await server.close();
