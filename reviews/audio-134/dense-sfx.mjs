/**
 * Issue #134 — "audio clips badly under many simultaneous sound effects".
 *
 * Renders the REAL `Audio` graph (and the real `MusicEngine` behind it)
 * sample-exactly into an `OfflineAudioContext` behind a settable clock, driven
 * at dense-firefight SFX rates, and reports what actually arrives at the
 * destination: peak sample, clipped-sample count (|v| > 1), and the gain
 * reduction of BOTH limiters sampled through the render.
 *
 * Product code is imported, never modified.
 *
 *   node reviews/audio-134/dense-sfx.mjs [--port 5240] [--seconds 20]
 *                                        [--blind none|sfx|master|both]
 *                                        [--scale 1] [--out <path>]
 *
 * `--blind` is the meter's own falsification arm: it removes one or both
 * limiters from the chain so a meter that cannot report clipping is visible as
 * such. If a blinded run does not clip, the numbers from an unblinded run mean
 * nothing.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5240);
const SECONDS = Number(args.seconds ?? 20);
const BLIND = args.blind ?? 'none';
const SCALE = Number(args.scale ?? 1);
const OUT = args.out ?? `reviews/audio-134/dense-${BLIND}-x${SCALE}.json`;

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
await page.goto(`http://127.0.0.1:${PORT}/reviews/audio-134/blank.html`, { waitUntil: 'load' });

const result = await page.evaluate(async ({ SECONDS, BLIND, SCALE }) => {
  const { Audio } = await import('/src/systems/Audio.js');
  const SR = 48000;
  const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));

  /* deterministic RNG: two runs of the same arm are comparable */
  const realRandom = Math.random;
  let seedState = 20260821 >>> 0;
  const seedRandom = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; };

  const oac = new OfflineAudioContext(2, Math.round(SR * SECONDS), SR);
  let clock = 0;
  Object.defineProperty(oac, 'currentTime', { get: () => clock, configurable: true });

  const RealAC = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { return oac; } };
  const a = new Audio();
  try {
    a.init({ events: { on() {}, emit() {} } });
    a._ensure();
  } finally { globalThis.AudioContext = RealAC; }

  // Shipped defaults: masterVolume 0.85, sfx 1, music 1 (see the constructor).
  const blinded = [];
  if (BLIND === 'sfx' || BLIND === 'both') {
    a.sfx.disconnect(); a.sfx.connect(a.master); blinded.push('sfxLimiter');
  }
  if (BLIND === 'master' || BLIND === 'both') {
    a.master.disconnect(); a.master.connect(oac.destination); blinded.push('masterLimiter');
  }

  const enemies = [];
  for (let i = 0; i < 60; i++) enemies.push({ alive: true, position: { x: 8, y: 0, z: 0 } });
  const gctx = {
    paused: false,
    player: { position: { x: 0, y: 0, z: 0 }, alive: true },
    director: { difficultyCoefficient: 14, enemies, populationCap: 60, boss: null },
    progression: { state: 'idle' },
  };
  a.ctx = gctx;

  /* ---- limiter gain-reduction sampling, every 100 ms of render time ------ */
  const gr = [];
  for (let t = 0.1; t < SECONDS - 0.2; t += 0.1) {
    const at = t;
    oac.suspend(at).then(() => {
      gr.push({ t: +at.toFixed(2), sfx: a.sfxLimiter.reduction, master: a.limiter.reduction });
      oac.resume();
    });
  }

  /* ---- the fight -------------------------------------------------------- */
  // Rates per second at SCALE 1, chosen to sit at or above the voice budget:
  // the arm is checked against `_takes`/`_refusals` afterwards, so "did the
  // graph actually run out of voices" is measured rather than assumed.
  const RATES = {
    shoot: 11, hit: 26, impact: 16, enemyVocal: 7, death: 3.2,
    explosion: 1.6, zap: 2.4, footstep: 4, playerHurt: 1.4, coin: 1.2,
  };
  // Positions are listener-relative, and the listener is the CAMERA, not the
  // player: `CameraRig` sits DIST 7.1 back and PIVOT_HEIGHT 1.68 up, so a
  // sound 3 m from the survivor is ~8 m from the ear. Placing sources around
  // the origin instead would render a mix several dB hotter than the game's.
  const CAM = { x: 0, y: -1.68, z: -7.1 };
  const near = () => {
    const r = 2 + seedRandom() * 10, th = seedRandom() * Math.PI * 2;
    return { x: Math.cos(th) * r + CAM.x, y: CAM.y, z: Math.sin(th) * r + CAM.z };
  };
  const dt = 1 / 60;
  const acc = {}; for (const k of Object.keys(RATES)) acc[k] = 0;

  // Voice retirement. Scheduling a whole render up front means `onended` never
  // fires while the graph is being built, so `worldVoices` would climb to the
  // cap in the first second and stay there: without this the arm measures a
  // graph that refuses 98% of the fight, i.e. a mix far SPARSER than the real
  // one, which is exactly the wrong direction for a clipping question. Every
  // source records its own stop time and is retired through the product's own
  // `onended` when the driving clock passes it.
  const live = [];
  for (const P of [globalThis.AudioBufferSourceNode, globalThis.OscillatorNode]) {
    const orig = P.prototype.stop;
    P.prototype.stop = function (when) { this.__stopAt = when ?? 0; return orig.call(this, when); };
  }
  const origRelease = a._release.bind(a);
  a._release = (node) => { origRelease(node); live.push(node); };
  const retire = (now) => {
    for (let i = live.length - 1; i >= 0; i--) {
      const n = live[i];
      if ((n.__stopAt ?? 0) <= now) { live.splice(i, 1); n.onended?.(); }
    }
  };

  Math.random = seedRandom;
  let peakVoices = 0;
  try {
    for (let t = 0; t < SECONDS - 0.6; t += dt) {
      clock = t;
      retire(t);
      a.update(gctx, dt);
      for (const [k, rate] of Object.entries(RATES)) {
        acc[k] += rate * SCALE * dt;
        while (acc[k] >= 1) {
          acc[k] -= 1;
          switch (k) {
            case 'shoot': a.shoot(near(), 1); break;
            case 'hit': a.hit(near(), seedRandom() < 0.25); break;
            case 'impact': a.impact(near(), ['stone', 'metal', 'dirt', 'concrete'][(seedRandom() * 4) | 0]); break;
            case 'enemyVocal': a.enemyVocal(near(), seedRandom() < 0.2 ? 'big' : 'small'); break;
            case 'death': a.death(near(), seedRandom() < 0.2); break;
            case 'explosion': a.explosion(near(), 4 + seedRandom() * 4); break;
            case 'zap': a.zap(near()); break;
            case 'footstep': a.footstep(near(), 'dirt'); break;
            case 'playerHurt': a.playerHurt(8 + seedRandom() * 20); break;
            case 'coin': a.coin(); break;
          }
        }
      }
      if (a.voices > peakVoices) peakVoices = a.voices;
    }
  } finally { Math.random = realRandom; }

  const takes = a._takes, refusals = a._refusals;

  const buf = await oac.startRendering();
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  let peak = 0, clipped = 0, sq = 0, n = 0;
  for (const arr of chans) {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i], m = v < 0 ? -v : v;
      if (m > peak) peak = m;
      if (m > 1) clipped++;
      sq += v * v; n++;
    }
  }
  // Loudest 50 ms window, so a lone transient is distinguishable from a wall.
  const W = Math.round(SR * 0.05);
  const wins = [];
  for (let s = 0; s + W <= chans[0].length; s += W) {
    let p = 0;
    for (const arr of chans) for (let i = s; i < s + W; i++) { const m = Math.abs(arr[i]); if (m > p) p = m; }
    wins.push(p);
  }
  wins.sort((x, y) => y - x);

  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  const sfxGR = gr.map((r) => r.sfx), masterGR = gr.map((r) => r.master);

  return {
    blinded, scale: SCALE, seconds: SECONDS,
    peak_lin: +peak.toFixed(5),
    peak_dBFS: +dB(peak).toFixed(2),
    clippedSamples: clipped,
    totalSamples: n,
    rms_dBFS: +dB(Math.sqrt(sq / n)).toFixed(2),
    loudest50ms_lin: +wins[0].toFixed(5),
    p95_50ms_lin: +wins[Math.floor(wins.length * 0.05)].toFixed(5),
    voices: { peak: peakVoices, takes, refusals, refusalRate: +(refusals / Math.max(1, takes)).toFixed(3) },
    sfxLimiter_dB: { mean: +mean(sfxGR).toFixed(2), worst: +Math.min(...sfxGR).toFixed(2) },
    masterLimiter_dB: { mean: +mean(masterGR).toFixed(2), worst: +Math.min(...masterGR).toFixed(2) },
    grSamples: gr.length,
  };
}, { SECONDS, BLIND, SCALE });

await writeFile(OUT, JSON.stringify({ result, logs }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 20).join('\n'));
await browser.close();
await server.close();
