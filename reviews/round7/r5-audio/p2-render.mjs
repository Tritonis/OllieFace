/**
 * Round-4 audio critique (round 7), probe 2: REAL LISTENING, by rendering.
 *
 * Renders the real `MusicEngine` and the real `Audio` graph sample-exactly into
 * an `OfflineAudioContext` behind a settable-clock facade and analyses the
 * waveform: per-layer isolated peak/RMS (the arm round 4 did NOT re-render),
 * DC offset, clipping, clicks at layer commits and across the stop/reset
 * revival the capture gate drives, phase cancellation (mix vs sum of parts
 * under a seeded RNG), near-Nyquist energy, and the gate's own PEAK_FLOOR
 * margin measured in the gate's exact configuration.
 *
 *   node reviews/round7/r5-audio/p2-render.mjs [--port 5502]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5502);

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 180000, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/reviews/round7/r5-audio/blank.html`, { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  const { MusicEngine } = await import('/src/systems/Music.js');
  const { Audio } = await import('/src/systems/Audio.js');
  const SR = 48000;
  const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));
  const out = { notes: [] };

  /* ---- deterministic RNG so two renders of the same thing are comparable -- */
  const realRandom = Math.random;
  let seedState = 1;
  const seedRandom = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; };
  const withSeed = (s, fn) => { seedState = s >>> 0; Math.random = seedRandom; try { return fn(); } finally { Math.random = realRandom; } };

  function stats(a) {
    let sum = 0, sq = 0, peak = 0, clipped = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i]; sum += v; sq += v * v;
      const m = v < 0 ? -v : v; if (m > peak) peak = m; if (m > 1) clipped++;
    }
    const n = a.length;
    const W = Math.round(SR * 0.05); const wins = [];
    for (let s = 0; s + W <= n; s += W) { let p = 0; for (let i = s; i < s + W; i++) { const m = Math.abs(a[i]); if (m > p) p = m; } wins.push(p); }
    wins.sort((x, y) => x - y);
    let slew = 0, slewAt = 0;
    for (let i = 1; i < n; i++) { const d = Math.abs(a[i] - a[i - 1]); if (d > slew) { slew = d; slewAt = i / SR; } }
    const DW = Math.round(SR * 0.02); let worstDC = 0;
    for (let s = 0; s + DW <= n; s += DW) { let m = 0; for (let i = s; i < s + DW; i++) m += a[i]; m /= DW; if (Math.abs(m) > Math.abs(worstDC)) worstDC = m; }
    return {
      rms_dB: +dB(Math.sqrt(sq / n)).toFixed(2),
      peak_dB: +dB(peak).toFixed(2),
      peak_lin: +peak.toFixed(5),
      dc_mean: +(sum / n).toExponential(2),
      worst20msDC: +worstDC.toExponential(2),
      maxSlew: +slew.toFixed(4), maxSlew_at_s: +slewAt.toFixed(3),
      clipped,
      win50_min_dB: +dB(wins[0] ?? 0).toFixed(1),
      win50_count: wins.length,
    };
  }

  function gameCtx({ enemies = 0, cap = 60, diff = 1, paused = false } = {}) {
    const list = []; for (let i = 0; i < enemies; i++) list.push({ alive: true, position: { x: 5, y: 0, z: 0 } });
    return { paused, player: { position: { x: 0, y: 0, z: 0 } },
      director: { difficultyCoefficient: diff, enemies: list, populationCap: cap, boss: null },
      progression: { state: 'idle' } };
  }

  function mkOffline(seconds) {
    const oac = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    let clock = 0;
    Object.defineProperty(oac, 'currentTime', { get: () => clock, configurable: true });
    const noise = oac.createBuffer(1, SR * 2, SR);
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return { oac, noise, set: (t) => { clock = t; } };
  }

  /* ============ 1. per-layer isolated peak / RMS at max reachable I ======== */
  const LAYER_NAMES = ['kick', 'clap', 'bass', 'lead', 'openhat', 'hat', 'acid', 'perc', 'sub', 'pad'];
  const SEC = 14;
  out.layerIsolated = {};
  for (const name of LAYER_NAMES) {
    const { oac, noise, set } = mkOffline(SEC);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const eng = new MusicEngine(oac, bus, noise);
    eng.duck.disconnect();
    for (const L of eng.layers.values()) L.g.disconnect();
    eng.layers.get(name).g.connect(oac.destination);
    eng._runT = 500;
    const ctx = gameCtx({ diff: 12, enemies: 60, cap: 60 });
    const dt = 1 / 60;
    withSeed(12345, () => {
      for (let t = 0; t < SEC - 0.6; t += dt) { set(t); eng.update(ctx, dt); eng.bump(0.02); }
    });
    const buf = await oac.startRendering();
    const a = buf.getChannelData(0).subarray(Math.round(buf.length / 2));
    out.layerIsolated[name] = {
      ...stats(a),
      finalI: +eng.intensity.toFixed(4),
      layerTarget: +eng.layers.get(name).target.toFixed(3),
      maxGain: eng.layers.get(name).max,
    };
  }
  {
    const k = out.layerIsolated.kick;
    out.layerBalance = { relKick: {}, spanRMS: 0, spanPeak: 0 };
    const rows = [];
    for (const n of LAYER_NAMES) {
      const L = out.layerIsolated[n];
      rows.push({ layer: n, rms_dB: L.rms_dB, relKickRMS: +(L.rms_dB - k.rms_dB).toFixed(2), peak_dB: L.peak_dB, relKickPeak: +(L.peak_dB - k.peak_dB).toFixed(2), target: L.layerTarget });
    }
    rows.sort((x, y) => y.peak_dB - x.peak_dB);
    out.layerBalance.rows = rows;
    out.layerBalance.spanRMS = +(Math.max(...rows.map((r) => r.rms_dB)) - Math.min(...rows.map((r) => r.rms_dB))).toFixed(2);
    out.layerBalance.spanPeak = +(Math.max(...rows.map((r) => r.peak_dB)) - Math.min(...rows.map((r) => r.peak_dB))).toFixed(2);
    out.layerBalance.clapOverKick_peak_dB = +(out.layerIsolated.clap.peak_dB - k.peak_dB).toFixed(2);
  }

  /* ============ 2. full mixes: DC, clipping, window peaks ================== */
  out.mixes = {};
  async function mix(label, { seconds = 14, runT = 500, diff = 1, enemies = 0, cap = 60, heat = 0, seed = 999 }) {
    const { oac, noise, set } = mkOffline(seconds);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const eng = new MusicEngine(oac, bus, noise);
    eng._runT = runT;
    const ctx = gameCtx({ diff, enemies, cap });
    const dt = 1 / 60;
    withSeed(seed, () => {
      for (let t = 0; t < seconds - 0.6; t += dt) { set(t); eng.update(ctx, dt); if (heat) eng.bump(heat); }
    });
    const buf = await oac.startRendering();
    const a = buf.getChannelData(0).subarray(Math.round(buf.length / 2));
    out.mixes[label] = { ...stats(a), I: +eng.intensity.toFixed(4), bpm: +eng.bpm.toFixed(1) };
    return buf;
  }
  await mix('opening_I0.10', { runT: 0, diff: 1, enemies: 0 });
  await mix('lateEmpty_I0.65', { diff: 6, enemies: 0 });
  await mix('lateFull_I0.958', { diff: 6, enemies: 60, heat: 0.02 });
  await mix('earlyFull_I0.88', { diff: 1, enemies: 60, heat: 0.02 });

  /* ============ 3. clicks: a full 0 -> 1 ramp, slews vs layer commits ====== */
  {
    const seconds = 70;
    const { oac, noise, set } = mkOffline(seconds);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const eng = new MusicEngine(oac, bus, noise);
    const ctx = gameCtx({ diff: 12, enemies: 60, cap: 60 });
    const dt = 1 / 60;
    const commits = [];
    const origApply = eng._apply.bind(eng);
    eng._apply = (lv, t, r) => { commits.push(+t.toFixed(4)); origApply(lv, t, r); };
    withSeed(777, () => {
      for (let t = 0; t < seconds - 1.2; t += dt) { set(t); eng.update(ctx, dt); eng.bump(0.02); }
    });
    const buf = await oac.startRendering();
    const a = buf.getChannelData(0);
    const tops = [];
    for (let i = 1; i < a.length; i++) { const d = Math.abs(a[i] - a[i - 1]); if (d > 0.02) tops.push([d, i / SR]); }
    tops.sort((x, y) => y[0] - x[0]);
    out.ramp = {
      commits: commits.length,
      top12: tops.slice(0, 12).map(([d, t]) => ({ d: +d.toFixed(4), t: +t.toFixed(4), nearCommit: commits.some((c) => Math.abs(c - t) < 0.005) })),
      of200LargestNearCommit: tops.slice(0, 200).filter(([, t]) => commits.some((c) => Math.abs(c - t) < 0.005)).length,
      ...stats(a),
    };
  }

  /* ============ 4. the revival the capture gate drives: stop() then reset() = */
  {
    const seconds = 26;
    const { oac, noise, set } = mkOffline(seconds);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const eng = new MusicEngine(oac, bus, noise);
    eng._runT = 300;
    const ctx = gameCtx({ diff: 3, enemies: 40, cap: 60 });
    const dt = 1 / 60;
    let stopAt = 0, resetAt = 0;
    withSeed(4242, () => {
      let t = 0;
      for (; t < 10; t += dt) { set(t); eng.update(ctx, dt); }
      stopAt = t; set(t); eng.stop(t);
      for (; t < 16; t += dt) { set(t); eng.update(ctx, dt); }
      resetAt = t; set(t); eng.reset();
      for (; t < seconds - 0.6; t += dt) { set(t); eng.update(ctx, dt); }
    });
    const buf = await oac.startRendering();
    const a = buf.getChannelData(0);
    const win = (t0, t1) => stats(a.subarray(Math.round(t0 * SR), Math.round(t1 * SR)));
    // biggest slew in the 300 ms either side of the reset
    let revSlew = 0, revAt = 0;
    for (let i = Math.round((resetAt - 0.3) * SR); i < Math.round((resetAt + 0.6) * SR); i++) {
      const d = Math.abs(a[i] - a[i - 1]); if (d > revSlew) { revSlew = d; revAt = i / SR; }
    }
    out.revival = {
      stopAt: +stopAt.toFixed(2), resetAt: +resetAt.toFixed(2),
      beforeStop: win(8, 10), afterStop: win(13, 16),
      justAfterReset_0to3s: win(resetAt, resetAt + 3),
      settled_3to9s: win(resetAt + 3, Math.min(seconds - 0.7, resetAt + 9)),
      maxSlewNearReset: +revSlew.toFixed(4), maxSlewNearReset_at_s: +revAt.toFixed(3),
      stepsEmitted: eng.stepsEmitted,
    };
  }

  /* ============ 5. phase cancellation: mix vs sum of isolated parts ======== */
  {
    const seconds = 10;
    const render = async (solo) => {
      const { oac, noise, set } = mkOffline(seconds);
      const bus = oac.createGain(); bus.connect(oac.destination);
      const eng = new MusicEngine(oac, bus, noise);
      eng._runT = 500;
      // Disconnect once. The kick's sidechain writes to `duck.gain` happen
      // regardless of what is connected, so every solo render is ducked
      // identically to the mix and the parts remain summable.
      if (solo) for (const [n, Ly] of eng.layers) if (n !== solo) Ly.g.disconnect();
      const ctx = gameCtx({ diff: 12, enemies: 60, cap: 60 });
      const dt = 1 / 60;
      withSeed(31337, () => {
        for (let t = 0; t < seconds - 0.6; t += dt) { set(t); eng.update(ctx, dt); eng.bump(0.02); }
      });
      const buf = await oac.startRendering();
      return buf.getChannelData(0).slice();
    };
    const full = await render(null);
    const sum = new Float32Array(full.length);
    for (const n of LAYER_NAMES) { const p = await render(n); for (let i = 0; i < sum.length; i++) sum[i] += p[i]; }
    const h = Math.round(full.length / 2);
    const fs = stats(full.subarray(h)), ss = stats(sum.subarray(h));
    let diff = 0;
    for (let i = h; i < full.length; i++) { const d = full[i] - sum[i]; diff += d * d; }
    out.phase = {
      mix_rms_dB: fs.rms_dB, sumOfParts_rms_dB: ss.rms_dB,
      delta_dB: +(fs.rms_dB - ss.rms_dB).toFixed(2),
      residual_rms_dB: +dB(Math.sqrt(diff / (full.length - h))).toFixed(2),
      note: 'a large negative delta_dB would be destructive cancellation between layers',
    };
  }

  /* ============ 6. near-Nyquist energy (aliasing proxy) ==================== */
  {
    const seconds = 8;
    const { oac, noise, set } = mkOffline(seconds);
    const bus = oac.createGain(); bus.connect(oac.destination);
    const eng = new MusicEngine(oac, bus, noise);
    eng._runT = 500;
    const ctx = gameCtx({ diff: 12, enemies: 60, cap: 60 });
    const dt = 1 / 60;
    withSeed(2024, () => { for (let t = 0; t < seconds - 0.6; t += dt) { set(t); eng.update(ctx, dt); eng.bump(0.02); } });
    const buf = await oac.startRendering();
    const a = buf.getChannelData(0);
    // one-pole HP cascade at 18 kHz vs total
    const rc = 1 / (2 * Math.PI * 18000), dtS = 1 / SR, al = rc / (rc + dtS);
    let yp = 0, xp = 0, hp = 0, tot = 0;
    for (let i = 0; i < a.length; i++) { const y = al * (yp + a[i] - xp); yp = y; xp = a[i]; hp += y * y; tot += a[i] * a[i]; }
    out.nearNyquist = { above18k_rel_dB: +(10 * Math.log10(Math.max(1e-12, hp / Math.max(1e-12, tot)))).toFixed(2) };
  }

  /* ============ 7. the CAPTURE GATE's own configuration, rendered ========== */
  // What the gate actually measures: beginRun() -> reset() -> runT 0 -> I 0.10,
  // on a graph that has just been through playerDead(). Measure the music-bus
  // peak per 16 ms the way the gate's analyser does, and report the margin over
  // PEAK_FLOOR = 1e-3.
  {
    const seconds = 8;
    const { oac, noise, set } = mkOffline(seconds);
    const RealAC = globalThis.AudioContext;
    globalThis.AudioContext = class { constructor() { return oac; } };
    const a = new Audio();
    try { a.init({ events: { on() {}, emit() {} } }); a._ensure(); } finally { globalThis.AudioContext = RealAC; }
    a.setMasterVolume(0.8); a.setSfxVolume(0.9); a.setMusicVolume(0.6);
    // tap the music bus the way the gate does
    const tap = oac.createGain(); tap.gain.value = 1;
    a.music.connect(tap); tap.connect(oac.destination);
    a.master.disconnect();          // isolate: measure the music bus alone
    const ctx = gameCtx({ diff: 1, enemies: 0, cap: 18, paused: false });
    a.ctx = ctx;
    const dt = 1 / 60;
    let t = 0;
    withSeed(5150, () => {
      a.musicEngine._runT = 40;
      for (; t < 3; t += dt) { set(t); a.musicEngine.update(ctx, dt); }
      set(t); a.playerDead();                     // the state the gate arrives in
      for (; t < 5; t += dt) { set(t); a.musicEngine.update(ctx, dt); }
      set(t); a.beginRun();                       // what the gate does
      for (; t < seconds - 0.6; t += dt) { set(t); a.musicEngine.update(ctx, dt); }
    });
    const buf = await oac.startRendering();
    const arr = buf.getChannelData(0);
    const winPeak = (t0, t1) => { let p = 0; for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) { const m = Math.abs(arr[i]); if (m > p) p = m; } return p; };
    // the gate opens its window at reset and runs 3 s (GATE_FRAMES 180 @ 60 fps)
    const gateWindow = winPeak(5, 8 - 0.6);
    const perWindow = [];
    for (let s = 5; s < 7.3; s += 0.25) perWindow.push(+winPeak(s, s + 0.25).toFixed(5));
    out.gateConfig = {
      musicBusPeak_inGateWindow: +gateWindow.toFixed(5),
      marginOverFloor_dB: +dB(gateWindow / 1e-3).toFixed(1),
      per250ms: perWindow,
      firstQuarterSecondPeak: perWindow[0],
      note: 'PEAK_FLOOR in tools/capture.mjs is 1e-3',
    };
  }

  return out;
});

await writeFile('reviews/round7/r5-audio/p2-render.json', JSON.stringify({ result, logs }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 30).join('\n'));
await browser.close();
await server.close();
