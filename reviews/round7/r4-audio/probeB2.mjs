/** Probe B2: the real Audio graph, with the offline-render artefacts of B fixed
 *  (voice counter reset per SFX, limiters bypassed by rewiring rather than by
 *  neutral settings, ambient isolated). */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {}; for (let i = 2; i < process.argv.length; i++) { const t = process.argv[i]; if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1]; }
const PORT = Number(args.port ?? 5316);
const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const logs = []; page.on('pageerror', (e) => logs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/reviews/round7/r4-audio/blank.html`, { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  const { Audio } = await import('/src/systems/Audio.js');
  const SR = 48000, dB = (x) => 20 * Math.log10(Math.max(1e-12, x));
  const stats = (buf) => {
    const a = buf.getChannelData(0); let sq = 0, peak = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i]; sq += v * v; const m = Math.abs(v); if (m > peak) peak = m; }
    return { rms_dB: +dB(Math.sqrt(sq / a.length)).toFixed(2), peak_dB: +dB(peak).toFixed(2) };
  };
  const gameCtx = () => { const l = []; for (let i = 0; i < 60; i++) l.push({ alive: true, position: { x: 10, y: 0, z: 0 } });
    return { paused: false, player: { position: { x: 0, y: 0, z: 0 } },
      director: { difficultyCoefficient: 6, enemies: l, populationCap: 60, boss: null }, progression: { state: 'idle' } }; };

  const out = {};
  async function render(label, { music = true, ambient = false, boomsPerSec = 0, limiters = true, seconds = 12, runT = 500 }) {
    const oac = new OfflineAudioContext(1, SR * seconds, SR);
    let clock = 0; Object.defineProperty(oac, 'currentTime', { get: () => clock, configurable: true });
    const Real = globalThis.AudioContext; class Fake { constructor() { return oac; } }
    globalThis.AudioContext = Fake;
    const a = new Audio();
    try { a.init({ events: { on() {}, emit() {} } }); a._ensure(); } finally { globalThis.AudioContext = Real; }
    a.setMasterVolume(0.8); a.setSfxVolume(0.9); a.setMusicVolume(0.6);   // Menus.js shipped defaults
    if (!limiters) {                       // true bypass: rewire past both compressors
      a.master.disconnect(); a.master.connect(oac.destination);
      a.sfx.disconnect(); a.sfx.connect(a.master);
    }
    if (!ambient) a.ambient.disconnect();
    if (!music) { a.musicEngine.silent = true; a.music.disconnect(); }
    a.musicEngine._runT = runT;
    const ctx = gameCtx(); const dt = 1 / 60; let next = 1;
    for (let t = 0; t < seconds - 0.8; t += dt) {
      clock = t;
      a.musicEngine.update(ctx, dt);
      if (boomsPerSec && t >= next) { a.voices = 0; a.explosion({ x: 0, y: 0, z: 0 }, 5); next += 1 / boomsPerSec; }
    }
    const buf = await oac.startRendering();
    const half = oac.createBuffer(1, Math.round(buf.length / 2), SR);
    half.getChannelData(0).set(buf.getChannelData(0).subarray(Math.round(buf.length / 2)));
    out[label] = { ...stats(half), musicBus: +a.music.gain.value.toFixed(4), sfxBus: +a.sfx.gain.value.toFixed(4), master: +a.master.gain.value.toFixed(3) };
    return out[label];
  }
  await render('music_I1', {});
  await render('music_I1_noLimiters', { limiters: false });
  await render('music_opening', { runT: 0 });
  await render('explosions_1s', { music: false, boomsPerSec: 1 });
  await render('explosions_1s_noLimiters', { music: false, boomsPerSec: 1, limiters: false });
  await render('both_1s', { boomsPerSec: 1 });
  await render('both_1s_noLimiters', { boomsPerSec: 1, limiters: false });
  await render('both_3s', { boomsPerSec: 3 });
  await render('both_3s_noLimiters', { boomsPerSec: 3, limiters: false });
  out._derived = {
    music_to_explosion_deficit_dB: +(out.explosions_1s.rms_dB - out.music_I1.rms_dB).toFixed(2),
    engine_dynamic_range_dB: +(out.music_I1.rms_dB - out.music_opening.rms_dB).toFixed(2),
    limiting_on_music_only_dB: +(out.music_I1.rms_dB - out.music_I1_noLimiters.rms_dB).toFixed(2),
    limiting_on_both_1s_dB: +(out.both_1s.rms_dB - out.both_1s_noLimiters.rms_dB).toFixed(2),
    limiting_on_both_3s_dB: +(out.both_3s.rms_dB - out.both_3s_noLimiters.rms_dB).toFixed(2),
    limiting_on_explosions_dB: +(out.explosions_1s.rms_dB - out.explosions_1s_noLimiters.rms_dB).toFixed(2),
  };
  return out;
});
await writeFile('reviews/round7/r4-audio/probeB2.json', JSON.stringify({ result, logs: logs.slice(0, 5) }, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close(); await server.close();
