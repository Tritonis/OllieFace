/**
 * Round-4 audio FIX, probe I: the intensity model and the stop/reset latch,
 * measured on the REAL MusicEngine at both ends of every range, for the round-3
 * code and the round-4 code side by side in one process.
 *
 * `Music.round3.js` is `git show b18a2b4:src/systems/Music.js` with only its
 * import path rewritten. Nothing else differs.
 *
 * Node only; the stub AudioContext is the critic's from
 * reviews/round7/r4-audio/probeA.mjs, unchanged in behaviour.
 *
 *   node reviews/round7/r4fix-audio/probeI.mjs > reviews/round7/r4fix-audio/probeI.json
 */
import { MusicEngine as NewEngine } from '../../../src/systems/Music.js';
import { MusicEngine as OldEngine } from './Music.round3.js';

let NOW = 0;
function param(initial = 0) {
  const p = {
    _v: initial,
    get value() { return this._v; },
    set value(v) { this._v = v; },
    setValueAtTime() { return p; },
    linearRampToValueAtTime() { return p; },
    exponentialRampToValueAtTime() { return p; },
    setTargetAtTime() { return p; },
    cancelScheduledValues() { return p; },
  };
  return p;
}
const mkNode = (extra = {}) => ({
  connect(x) { return x; }, disconnect() {}, start() {}, stop() {}, ...extra,
});
const ac = {
  sampleRate: 48000,
  get currentTime() { return NOW; },
  destination: {},
  createGain: () => mkNode({ gain: param(0) }),
  createBiquadFilter: () => mkNode({ frequency: param(350), Q: param(1), detune: param(0), type: 'lowpass' }),
  createOscillator: () => mkNode({ frequency: param(440), detune: param(0), type: 'sine' }),
  createBufferSource: () => mkNode({ playbackRate: param(1), buffer: null, loop: false }),
};
const newEngine = (E) => new E(ac, mkNode({ gain: param(1) }), {});

/** Minimal ctx. `_scanSustain` reads only these fields. */
function mkCtx({ enemies = 0, cap = 18, diff = 1, paused = false, boss = false, charging = false, dist = 10 } = {}) {
  const list = [];
  for (let i = 0; i < enemies; i++) list.push({ alive: true, position: { x: dist, y: 0, z: 0 } });
  return {
    paused,
    player: { position: { x: 0, y: 0, z: 0 } },
    director: { difficultyCoefficient: diff, enemies: list, populationCap: cap, boss: boss ? { alive: true } : null },
    progression: { state: charging ? 'charging' : 'idle' },
  };
}
function run(eng, ctx, sec, fps = 30) {
  const dt = 1 / fps;
  for (let i = 0, n = Math.round(sec * fps); i < n; i++) { NOW += dt; eng.update(ctx, dt); }
}
const r4 = (x) => +x.toFixed(4);

const out = {};

/* ============ 1. BOTH ENDS OF THE RANGE, at every reachable difficulty ======
 * The round-3 defect is that `I` pins to 1 in an EMPTY arena from difficulty
 * 3.5. The round-2 defect it was fixed from is that `I` never rises. So the
 * measurement has to be the pair: empty arena and full arena, same difficulty,
 * same engine, and the gap between them is the thing that must never be zero.
 */
{
  const rows = [];
  for (const [label, E] of [['round3', OldEngine], ['round4', NewEngine]]) {
    for (const diff of [1.0, 1.5, 2.0, 2.875, 3.2, 3.5, 4.5, 6.0, 12.0]) {
      const cap = diff < 2 ? 18 : diff < 3.5 ? 40 : 60;
      const meas = (scen) => {
        NOW = 0;
        const eng = newEngine(E);
        eng.silent = true;                    // arithmetic only, no synthesis
        const ctx = mkCtx({ diff, cap, ...scen });
        run(eng, ctx, 240);                   // past the opening ceiling and settled
        return { I: r4(eng.intensity), pressure: r4(eng.pressure), arc: r4(eng.arc), bpm: +eng.bpm.toFixed(1) };
      };
      const empty = meas({ enemies: 0 });
      const full = meas({ enemies: cap });
      // `cool()` is the stage-transition dump: it must still move the track.
      NOW = 0;
      const eng = newEngine(E); eng.silent = true;
      const ctxFull = mkCtx({ diff, cap, enemies: cap });
      run(eng, ctxFull, 240);
      const beforeCool = r4(eng.intensity);
      eng.cool();
      for (const e of ctxFull.director.enemies) e.alive = false;   // a stage change empties the arena
      run(eng, ctxFull, 20);
      const afterCool = r4(eng.intensity);
      rows.push({
        build: label, diff,
        I_empty: empty.I, I_full: full.I, span: r4(full.I - empty.I),
        arc: full.arc, pressure_full: full.pressure, pressure_empty: empty.pressure,
        bpm_empty: empty.bpm, bpm_full: full.bpm,
        cool_from: beforeCool, cool_to: afterCool, cool_moved: r4(beforeCool - afterCool),
      });
    }
  }
  out.bothEnds = rows;
  const dead = rows.filter((r) => r.span <= 0.001);
  out.bothEndsVerdict = {
    round3_deadRows: dead.filter((r) => r.build === 'round3').map((r) => r.diff),
    round4_deadRows: dead.filter((r) => r.build === 'round4').map((r) => r.diff),
    invariant: 'span > 0 for every reachable difficulty',
  };
}

/* ============================ 2. THE OTHER END: the opening must stay sparse */
{
  const meas = (E) => {
    NOW = 0;
    const eng = newEngine(E); eng.silent = true;
    // 45 s on a paused survivor-select screen, then a run begins.
    run(eng, mkCtx({ paused: true }), 45);
    const idle = { runT: +eng._runT.toFixed(2), I: r4(eng.intensity) };
    eng.reset();
    const ctx = mkCtx({ enemies: 20, cap: 18, diff: 1.05 });
    run(eng, ctx, 6);
    const at6 = r4(eng.intensity);
    run(eng, ctx, 54);
    const at60 = r4(eng.intensity);
    return { idle, at6, at60, ceilingAt6s: r4(0.10 + 6 / 60 * 0.70) };
  };
  out.openingCeiling = { round3: meas(OldEngine), round4: meas(NewEngine) };
}

/* ================== 3. FLOORS: boss / teleporter / full arena separation ==== */
{
  const rows = [];
  for (const [label, E] of [['round3', OldEngine], ['round4', NewEngine]]) {
    for (const diff of [1.0, 2.0, 3.5, 6.0]) {
      const meas = (scen) => {
        NOW = 0;
        const eng = newEngine(E); eng.silent = true;
        run(eng, mkCtx({ diff, cap: 40, ...scen }), 240);
        return r4(eng.intensity);
      };
      const boss = meas({ enemies: 0, boss: true });
      const charging = meas({ enemies: 0, charging: true });
      const full = meas({ enemies: 40 });
      rows.push({ build: label, diff, boss, charging, full, separation: r4(full - boss) });
    }
  }
  out.floors = rows;
}

/* ================================= 4. stop() / reset(): is the latch one-way? */
{
  const meas = (E) => {
    NOW = 0;
    const eng = newEngine(E);
    const ctx = mkCtx({ enemies: 20, cap: 18, diff: 1.2 });
    run(eng, ctx, 6, 60);
    const before = eng.stepsEmitted;
    eng.stop(NOW);                       // what playerDead does
    run(eng, ctx, 3, 60);
    const afterStop = eng.stepsEmitted;
    eng.reset();                         // what a new run does
    run(eng, ctx, 5, 60);
    const afterReset = eng.stepsEmitted;
    return {
      stepsBeforeStop: before, stepsAfterStop: afterStop, stepsAfterReset: afterReset,
      emittedAfterReset: afterReset - afterStop,
      stoppedFlagAfterReset: eng.stopped,
      verdict: afterReset > afterStop ? 'revived' : 'reset() does NOT revive a stopped engine',
    };
  };
  out.stopLatch = { round3: meas(OldEngine), round4: meas(NewEngine) };
}

/* ========== 5. REGRESSION GUARDS: things round 3 got right, re-measured ===== */
{
  const guard = (E) => {
    // (a) resync keeps the bar counter monotone across stalls
    NOW = 0;
    const eng = newEngine(E);
    const ctx = mkCtx({ enemies: 20, cap: 18, diff: 1.2 });
    let rewinds = 0, last = eng._bar, resyncs = 0;
    const dt = 1 / 60;
    for (let t = 0; t < 12; t += dt) {
      if (Math.abs(t - 3) < dt / 2 || Math.abs(t - 6) < dt / 2 || Math.abs(t - 9) < dt / 2) { NOW += 0.6; t += 0.6; }
      NOW += dt;
      const mt = eng._musicTime;
      eng.update(ctx, dt);
      if (mt < NOW) resyncs++;
      if (eng._bar < last) rewinds++;
      last = eng._bar;
    }
    const resync = { bars: eng._bar, rewinds, resyncs };
    // (b) stageStart index>0 must not reset the run clock (Audio's job, but the
    //     engine must carry `_runT` across anything but reset())
    const runTBefore = +eng._runT.toFixed(2);
    // (c) `silent` keeps integrating but stops synthesising
    const stepsBefore = eng.stepsEmitted;
    eng.silent = true;
    run(eng, ctx, 5, 60);
    const stepsDuringSilent = eng.stepsEmitted - stepsBefore;
    eng.silent = false;
    return { resync, runTBefore, stepsDuringSilent, intensityStillMoving: eng.intensity > 0 };
  };
  out.guards = { round3: guard(OldEngine), round4: guard(NewEngine) };
}

/* ============================== 6. LAYER TABLE: the clap peak retune (D1) === */
{
  const clapOf = (E) => {
    NOW = 0;
    const eng = newEngine(E);
    return eng.layers.get('clap').max;
  };
  const kickOf = (E) => { NOW = 0; return newEngine(E).layers.get('kick').max; };
  out.clap = {
    round3: { clapMax: clapOf(OldEngine), kickMax: kickOf(OldEngine) },
    round4: { clapMax: clapOf(NewEngine), kickMax: kickOf(NewEngine) },
    dB_change: +(20 * Math.log10(clapOf(NewEngine) / clapOf(OldEngine))).toFixed(2),
  };
}

console.log(JSON.stringify(out, null, 2));
