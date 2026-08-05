/**
 * Round-4 audio critique (round 7), probe 1: the intensity model, the layer
 * arrangement it drives, and the stop/reset latches — analytically, with no
 * browser engine loop and no rendering, so the concurrent-`Engine.start` bug
 * cannot touch any of it.
 *
 * Drives the REAL `MusicEngine` on a real `OfflineAudioContext` whose
 * `currentTime` is a settable facade. `silent = true` skips note emission (the
 * product's own documented behaviour) so the model integrates at full speed.
 *
 *   node reviews/round7/r5-audio/p1-model.mjs [--port 5501]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5501);

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
await page.goto(`http://127.0.0.1:${PORT}/reviews/round7/r5-audio/blank.html`, { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  const { MusicEngine } = await import('/src/systems/Music.js');
  const SR = 48000;
  const out = {};

  function mk(seconds = 1) {
    const oac = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    let clock = 0;
    Object.defineProperty(oac, 'currentTime', { get: () => clock, configurable: true });
    const noise = oac.createBuffer(1, SR, SR);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const bus = oac.createGain(); bus.connect(oac.destination);
    const eng = new MusicEngine(oac, bus, noise);
    return { oac, bus, eng, set: (t) => { clock = t; } };
  }

  function gameCtx({ enemies = 0, cap = 60, diff = 1, paused = false, boss = false, charging = false } = {}) {
    const list = [];
    for (let i = 0; i < enemies; i++) list.push({ alive: true, position: { x: 5, y: 0, z: 0 } });
    return {
      paused,
      player: { position: { x: 0, y: 0, z: 0 } },
      director: { difficultyCoefficient: diff, enemies: list, populationCap: cap, boss: boss ? { alive: true } : null },
      progression: { state: charging ? 'charging' : 'idle' },
    };
  }

  /** Run the model for `seconds` at 60 Hz. `onFrame(t)` may bump/cool. */
  function run(eng, ctx, seconds, onFrame) {
    const dt = 1 / 60;
    let t = 0;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      t += dt;
      if (onFrame) onFrame(t, i);
      eng.update(ctx, dt);
    }
    return t;
  }

  const levels = (eng) => {
    const o = {};
    for (const [n, L] of eng.layers) o[n] = +(L.target ?? 0).toFixed(3);
    return o;
  };
  // What the *arrangement* is at a given intensity, independent of bar timing:
  // the layer table's own fade formula.
  const arrange = (eng, I) => {
    const o = {};
    for (const [n, L] of eng.layers) {
      o[n] = +Math.max(0, Math.min(1, (I - L.enter) / L.band)).toFixed(3);
    }
    return o;
  };

  /* ---------------- 1. Both ends of the range, per difficulty ------------- */
  {
    const rows = [];
    const diffs = [1.0, 1.5, 2.0, 2.5, 2.875, 3.2, 3.5, 4.5, 6.0, 12.0];
    for (const diff of diffs) {
      // empty arena
      const A = mk(); A.eng.silent = true;
      run(A.eng, gameCtx({ diff, enemies: 0 }), 300);
      const Iempty = A.eng.intensity;
      // full arena (60 enemies, cap 60 -> sustain saturates at 0.9)
      const B = mk(); B.eng.silent = true;
      run(B.eng, gameCtx({ diff, enemies: 60, cap: 60 }), 300);
      const Ifull = B.eng.intensity;
      // full arena + combat heat (bump 0.35 every 0.5 s, which is what a fight
      // actually supplies) -> the true ceiling
      const C = mk(); C.eng.silent = true;
      const cctx = gameCtx({ diff, enemies: 60, cap: 60 });
      run(C.eng, cctx, 300, (t, i) => { if (i % 30 === 0) C.eng.bump(0.35); });
      const Ihot = C.eng.intensity;
      // cool() from the full-arena-with-heat state, then let the arena empty
      const D = mk(); D.eng.silent = true;
      const dctx = gameCtx({ diff, enemies: 60, cap: 60 });
      run(D.eng, dctx, 300, (t, i) => { if (i % 30 === 0) D.eng.bump(0.35); });
      const IbeforeCool = D.eng.intensity;
      D.eng.cool();
      dctx.director.enemies.length = 0;
      run(D.eng, dctx, 1);            // one second later
      const IcoolAt1s = D.eng.intensity;
      run(D.eng, dctx, 14);           // 15 s after the transition
      const IcoolAt15s = D.eng.intensity;

      rows.push({
        diff,
        arc: +A.eng.arc.toFixed(4),
        Iempty: +Iempty.toFixed(4),
        Ifull: +Ifull.toFixed(4),
        Ihot: +Ihot.toFixed(4),
        span_emptyToFull: +(Ifull - Iempty).toFixed(4),
        span_emptyToHot: +(Ihot - Iempty).toFixed(4),
        bpmEmpty: +A.eng.bpm.toFixed(1),
        bpmHot: +C.eng.bpm.toFixed(1),
        coolFrom: +IbeforeCool.toFixed(4),
        coolAt1s: +IcoolAt1s.toFixed(4),
        coolAt15s: +IcoolAt15s.toFixed(4),
        coolDrop15s: +(IbeforeCool - IcoolAt15s).toFixed(4),
        layersEmpty: arrange(A.eng, Iempty),
        layersHot: arrange(C.eng, Ihot),
      });
    }
    out.bothEnds = rows;
    out.bothEndsVerdict = {
      deadRows: rows.filter((r) => r.span_emptyToHot <= 0.001).map((r) => r.diff),
      minSpan: Math.min(...rows.map((r) => r.span_emptyToHot)),
      maxI: Math.max(...rows.map((r) => r.Ihot)),
    };
  }

  /* ---------------- 2. Floors: boss / charging / full --------------------- */
  {
    const rows = [];
    for (const diff of [1.0, 2.0, 3.5, 6.0]) {
      const one = (opts) => {
        const S = mk(); S.eng.silent = true;
        run(S.eng, gameCtx({ diff, ...opts }), 300);
        return +S.eng.intensity.toFixed(4);
      };
      const empty = one({ enemies: 0 });
      const boss = one({ enemies: 0, boss: true });
      const charging = one({ enemies: 0, charging: true });
      const full = one({ enemies: 60, cap: 60 });
      rows.push({ diff, empty, boss, charging, full, bossToFull: +(full - boss).toFixed(4), spread: +(full - boss).toFixed(4) });
    }
    out.floors = rows;
  }

  /* ---------------- 3. Opening ceiling ------------------------------------ */
  {
    const S = mk(); S.eng.silent = true;
    // 45 s on a paused survivor-select screen
    run(S.eng, gameCtx({ diff: 1, enemies: 0, paused: true }), 45);
    const afterMenu = { runT: +S.eng._runT.toFixed(3), I: +S.eng.intensity.toFixed(4) };
    // then a busy run
    const ctx = gameCtx({ diff: 1, enemies: 60, cap: 60 });
    const marks = {};
    run(S.eng, ctx, 120, (t, i) => {
      if (i % 30 === 0) S.eng.bump(0.35);
      const k = Math.round(S.eng._runT);
      if ([6, 30, 60, 90, 120].includes(k) && marks[k] === undefined) marks[k] = +S.eng.intensity.toFixed(4);
    });
    out.openingCeiling = { afterMenu, atSeconds: marks, formulaAt6s: +(0.10 + 6 / 60 * 0.70).toFixed(4) };
  }

  /* ---------------- 4. stop() / reset() latch ----------------------------- */
  {
    const S = mk(60);
    const ctx = gameCtx({ diff: 1, enemies: 30, cap: 60 });
    // real emission this time so stepsEmitted moves
    const dt = 1 / 60;
    let clock = 0;
    const step = (n) => { for (let i = 0; i < n; i++) { clock += dt; S.set(clock); S.eng.update(ctx, dt); } };
    step(300);                                    // 5 s
    const beforeStop = S.eng.stepsEmitted;
    S.eng.stop(clock);
    step(300);
    const afterStop = S.eng.stepsEmitted;
    S.eng.reset();
    step(300);
    const afterReset = S.eng.stepsEmitted;
    out.stopLatch = {
      beforeStop, afterStop, afterReset,
      revived: afterReset > afterStop,
      stoppedAfterReset: S.eng.stopped,
      runTAfterReset: +S.eng._runT.toFixed(3),
      pendingAfterReset: S.eng._pending,
    };
  }

  /* ---------------- 5. resync / bar monotonicity -------------------------- */
  {
    const S = mk(120);
    const ctx = gameCtx({ diff: 2, enemies: 40, cap: 60 });
    const dt = 1 / 60;
    let clock = 0, rewinds = 0, lastBar = 0, lastStep = -1, resyncs = 0;
    let prevMusicTime = S.eng._musicTime;
    for (let i = 0; i < 60 * 60; i++) {
      // three 0.6 s stalls
      if (i === 600 || i === 1800 || i === 3000) clock += 0.6;
      clock += dt; S.set(clock); S.eng.update(ctx, dt);
      if (S.eng._bar < lastBar) rewinds++;
      lastBar = S.eng._bar;
      if (S.eng._musicTime - prevMusicTime > 0.5) resyncs++;
      prevMusicTime = S.eng._musicTime;
      lastStep = S.eng._step;
    }
    out.resync = { bars: lastBar, rewinds, resyncs, finalStep: lastStep, steps: S.eng.stepsEmitted };
  }

  /* ---------------- 6. hat quantisation under dither ---------------------- */
  {
    const S = mk(90);
    const ctx = gameCtx({ diff: 1, enemies: 20, cap: 40 });
    const dt = 1 / 60;
    let clock = 0;
    const flips = [];
    let prev = S.eng._hat16, prevBar = S.eng._bar, flipsThisBar = 0;
    for (let i = 0; i < 45 * 60; i++) {
      clock += dt; S.set(clock);
      S.eng.update(ctx, dt);
      // dither intensity right across the 0.55 hat threshold
      S.eng.intensity = 0.55 + (Math.random() - 0.5) * 0.04;
      if (S.eng._bar !== prevBar) { flips.push(flipsThisBar); flipsThisBar = 0; prevBar = S.eng._bar; }
      if (S.eng._hat16 !== prev) { flipsThisBar++; prev = S.eng._hat16; }
    }
    out.hatQuantise = { bars: flips.length, barsWithMoreThanOneFlip: flips.filter((f) => f > 1).length, totalFlips: flips.reduce((a, b) => a + b, 0) };
  }

  /* ---------------- 7. layer entry map ------------------------------------ */
  {
    const S = mk(); S.eng.silent = true;
    const map = {};
    for (const [n, L] of S.eng.layers) map[n] = { enter: L.enter, band: L.band, max: L.max, fullAt: +(L.enter + L.band).toFixed(3) };
    out.layerTable = map;
    // Which layers are up at the two ends of the late-run range
    out.lateRunArrangement = { atI: {} };
    for (const I of [0.650, 0.6918, 0.9272, 0.958]) out.lateRunArrangement.atI[I] = arrange(S.eng, I);
  }

  return out;
});

await writeFile('reviews/round7/r5-audio/p1-model.json', JSON.stringify({ result, logs }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 30).join('\n'));
await browser.close();
await server.close();
