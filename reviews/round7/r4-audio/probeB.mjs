/**
 * Round-4 audio critique, probe B: renders the REAL MusicEngine and the REAL
 * Audio graph sample-exactly in an OfflineAudioContext and analyses the
 * waveform. Product code is imported, never modified.
 *
 *   node reviews/round7/r4-audio/probeB.mjs [--port 5311]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5311);

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  timeout: 120000, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/reviews/round7/r4-audio/blank.html`, { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  const { MusicEngine } = await import('/src/systems/Music.js');
  const { Audio } = await import('/src/systems/Audio.js');
  const SR = 48000;

  const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));

  function stats(buf) {
    const a = buf.getChannelData(0);
    let sum = 0, sq = 0, peak = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i]; sum += v; sq += v * v; const m = v < 0 ? -v : v; if (m > peak) peak = m; }
    const n = a.length;
    // 50 ms window peaks
    const W = Math.round(SR * 0.05); const wins = [];
    for (let s = 0; s + W <= n; s += W) { let p = 0; for (let i = s; i < s + W; i++) { const m = Math.abs(a[i]); if (m > p) p = m; } wins.push(p); }
    wins.sort((x, y) => x - y);
    // max sample-to-sample slew (click proxy)
    let slew = 0, slewAt = 0;
    for (let i = 1; i < n; i++) { const d = Math.abs(a[i] - a[i - 1]); if (d > slew) { slew = d; slewAt = i / SR; } }
    // windowed DC (worst 20 ms mean)
    const DW = Math.round(SR * 0.02); let worstDC = 0, worstDCAt = 0;
    for (let s = 0; s + DW <= n; s += DW) { let m = 0; for (let i = s; i < s + DW; i++) m += a[i]; m /= DW; if (Math.abs(m) > Math.abs(worstDC)) { worstDC = m; worstDCAt = s / SR; } }
    return {
      rms_dB: +dB(Math.sqrt(sq / n)).toFixed(2),
      peak_dB: +dB(peak).toFixed(2),
      peak_lin: +peak.toFixed(4),
      dc_mean: +(sum / n).toExponential(2),
      worstWindowDC: +worstDC.toExponential(2), worstWindowDC_at_s: +worstDCAt.toFixed(2),
      maxSlew: +slew.toFixed(4), maxSlew_at_s: +slewAt.toFixed(3),
      win50_min_dB: +dB(wins[0]).toFixed(1),
      win50_median_dB: +dB(wins[Math.floor(wins.length / 2)]).toFixed(1),
      win50_below_m50dB: wins.filter((w) => dB(w) < -50).length,
      win50_count: wins.length,
      clipped: (() => { let c = 0; for (let i = 0; i < n; i++) if (Math.abs(a[i]) > 1) c++; return c; })(),
    };
  }

  /** Sub-30 Hz energy fraction via a crude one-pole comparison. */
  function lowEnergy(buf) {
    const a = buf.getChannelData(0);
    // 2nd-order butterworth-ish LP at 30 Hz (RC cascade)
    const rc = 1 / (2 * Math.PI * 30), dt = 1 / SR, al = dt / (rc + dt);
    let y1 = 0, y2 = 0, lp = 0, tot = 0;
    for (let i = 0; i < a.length; i++) {
      y1 += al * (a[i] - y1); y2 += al * (y1 - y2);
      lp += y2 * y2; tot += a[i] * a[i];
    }
    return +(10 * Math.log10(Math.max(1e-12, lp / Math.max(1e-12, tot)))).toFixed(2);
  }

  function gameCtx({ enemies = 60, cap = 60, diff = 6, paused = false, boss = false } = {}) {
    const list = []; for (let i = 0; i < enemies; i++) list.push({ alive: true, position: { x: 10, y: 0, z: 0 } });
    return { paused, player: { position: { x: 0, y: 0, z: 0 } },
      director: { difficultyCoefficient: diff, enemies: list, populationCap: cap, boss: boss ? { alive: true } : null },
      progression: { state: 'idle' } };
  }

  function mkOffline(seconds) {
    const oac = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    let clock = 0;
    Object.defineProperty(oac, 'currentTime', { get: () => clock, configurable: true });
    return { oac, set: (t) => { clock = t; }, get: () => clock };
  }

  const out = { layerIsolated: {}, mixes: {}, notes: [] };

  /* ---------------- 1. per-layer isolated loudness at I = 1 ---------------- */
  const LAYER_NAMES = ['kick', 'clap', 'bass', 'lead', 'openhat', 'hat', 'acid', 'perc', 'sub', 'pad'];
  const SEC = 12;
  for (const name of LAYER_NAMES) {
    const { oac, set } = mkOffline(SEC);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const noise = oac.createBuffer(1, SR * 2, SR);
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const eng = new MusicEngine(oac, bus, noise);
    // isolate: everything off the graph, this layer straight at destination
    eng.duck.disconnect();
    for (const L of eng.layers.values()) L.g.disconnect();
    eng.layers.get(name).g.connect(oac.destination);
    eng._runT = 500;          // past the opening ceiling
    const ctx = gameCtx({});
    const dt = 1 / 60;
    for (let t = 0; t < SEC - 0.6; t += dt) { set(t); eng.update(ctx, dt); }
    const buf = await oac.startRendering();
    // measure only the settled back half so layer fade-ins are excluded
    const half = oac.createBuffer(1, Math.round(buf.length / 2), SR);
    half.getChannelData(0).set(buf.getChannelData(0).subarray(Math.round(buf.length / 2)));
    out.layerIsolated[name] = { ...stats(half), finalIntensity: +eng.intensity.toFixed(3), target: eng.layers.get(name).target };
  }

  /* ------------- 2. full mix at I=1 and at the sparse opening -------------- */
  async function mix(label, { seconds = 12, runT = 500, diff = 6, enemies = 60, cap = 60, pinLow = false }) {
    const { oac, set } = mkOffline(seconds);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const noise = oac.createBuffer(1, SR * 2, SR);
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const eng = new MusicEngine(oac, bus, noise);
    eng._runT = runT;
    const ctx = gameCtx({ diff, enemies, cap });
    const dt = 1 / 60;
    for (let t = 0; t < seconds - 0.6; t += dt) { set(t); eng.update(ctx, dt); }
    const buf = await oac.startRendering();
    const half = oac.createBuffer(1, Math.round(buf.length / 2), SR);
    half.getChannelData(0).set(buf.getChannelData(0).subarray(Math.round(buf.length / 2)));
    out.mixes[label] = { ...stats(half), sub30Hz_dB: lowEnergy(half), intensity: +eng.intensity.toFixed(3), levels: eng.levels() };
  }
  await mix('full_I1', {});
  await mix('opening_I0.10', { runT: 0, diff: 1, enemies: 0, cap: 18 });
  await mix('mid_I0.5', { runT: 30, diff: 1.2, enemies: 9, cap: 18 });

  /* ---- 3. a full 0 -> 1 ramp: does any layer entry produce a click? ------- */
  {
    const seconds = 90;
    const { oac, set } = mkOffline(seconds);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const noise = oac.createBuffer(1, SR * 2, SR);
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const eng = new MusicEngine(oac, bus, noise);
    const ctx = gameCtx({ diff: 6, enemies: 60, cap: 60 });
    const dt = 1 / 60;
    const commits = [];
    const origApply = eng._apply.bind(eng);
    eng._apply = (lv, t, r) => { commits.push(+t.toFixed(4)); origApply(lv, t, r); };
    for (let t = 0; t < seconds - 1.2; t += dt) { set(t); eng.update(ctx, dt); }
    const buf = await oac.startRendering();
    const a = buf.getChannelData(0);
    // top slews and whether they sit within 5 ms of a commit
    const tops = [];
    for (let i = 1; i < a.length; i++) { const d = Math.abs(a[i] - a[i - 1]); if (d > 0.02) tops.push([d, i / SR]); }
    tops.sort((x, y) => y[0] - x[0]);
    out.ramp = {
      commits: commits.length,
      topSlews: tops.slice(0, 12).map(([d, t]) => ({ d: +d.toFixed(4), t: +t.toFixed(4), nearCommit: commits.some((c) => Math.abs(c - t) < 0.005) })),
      slewsNearCommits: tops.slice(0, 200).filter(([, t]) => commits.some((c) => Math.abs(c - t) < 0.005)).length,
      ...stats(buf),
    };
  }

  /* --------- 4. the real Audio graph: music vs SFX, and the limiters ------- */
  async function graphRender(label, { music = true, explosions = 0, seconds = 10, noLimit = false, runT = 500 }) {
    const { oac, set } = mkOffline(seconds);
    const RealAC = globalThis.AudioContext;
    class FakeAC { constructor() { return oac; } }
    globalThis.AudioContext = FakeAC;
    const events = { on() {}, emit() {} };
    const a = new Audio();
    try {
      a.init({ events, audio: null });
      a._ensure();
    } finally { globalThis.AudioContext = RealAC; }
    // shipped defaults (Menus.js): master 0.8, sfx 0.9, music 0.6
    a.setMasterVolume(0.8); a.setSfxVolume(0.9); a.setMusicVolume(0.6);
    if (noLimit) {
      a.limiter.threshold.value = 0; a.limiter.ratio.value = 1;
      a.sfxLimiter.threshold.value = 0; a.sfxLimiter.ratio.value = 1;
    }
    a.musicEngine._runT = runT;
    if (!music) a.musicEngine.silent = true;
    const ctx = gameCtx({});
    const dt = 1 / 60;
    let nextBoom = 1;
    for (let t = 0; t < seconds - 0.8; t += dt) {
      set(t);
      a.musicEngine.update(ctx, dt);
      if (explosions && t >= nextBoom) { a.explosion({ x: 0, y: 0, z: 0 }, 5); nextBoom += 1 / explosions; }
    }
    const buf = await oac.startRendering();
    const half = oac.createBuffer(1, Math.round(buf.length / 2), SR);
    half.getChannelData(0).set(buf.getChannelData(0).subarray(Math.round(buf.length / 2)));
    out.mixes[label] = { ...stats(half), sub30Hz_dB: lowEnergy(half), musicBusGain: +a.music.gain.value.toFixed(5), sfxBusGain: +a.sfx.gain.value.toFixed(5), masterGain: +a.master.gain.value.toFixed(4) };
    return out.mixes[label];
  }
  await graphRender('graph_musicOnly_I1', { explosions: 0 });
  await graphRender('graph_musicOnly_I1_noLimit', { explosions: 0, noLimit: true });
  await graphRender('graph_explosions1s', { music: false, explosions: 1 });
  await graphRender('graph_explosions1s_noLimit', { music: false, explosions: 1, noLimit: true });
  await graphRender('graph_both', { explosions: 1 });
  await graphRender('graph_both_noLimit', { explosions: 1, noLimit: true });
  await graphRender('graph_both_4boomsPerSec', { explosions: 4 });
  await graphRender('graph_both_4boomsPerSec_noLimit', { explosions: 4, noLimit: true });
  await graphRender('graph_musicOnly_opening', { explosions: 0, runT: 0 });

  return out;
});

await writeFile('reviews/round7/r4-audio/probeB.json', JSON.stringify({ result, logs }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (logs.length) console.log('LOGS:', logs.slice(0, 20).join('\n'));
await browser.close();
await server.close();
