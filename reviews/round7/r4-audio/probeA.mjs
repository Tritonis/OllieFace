/**
 * Round-4 audio critique, probe A: drives the REAL MusicEngine from src/ on a
 * stub AudioContext that records every node creation and every AudioParam write
 * with its scheduled time. No product code is modified or copied.
 *
 * Node-only, no browser: everything measured here is scheduling / arithmetic.
 */
import { MusicEngine } from '../../../src/systems/Music.js';

// ---------------------------------------------------------------- stub graph
let EVENTS = [];   // {param, kind, value, time, t2}
let NODES = [];    // {type, at}
let NOW = 0;

function param(name, initial = 0) {
  const p = {
    _v: initial,
    get value() { return this._v; },
    set value(v) { this._v = v; EVENTS.push({ param: name, kind: 'set', value: v, time: NOW }); },
    setValueAtTime(v, t) { EVENTS.push({ param: name, kind: 'setValueAtTime', value: v, time: t }); return p; },
    linearRampToValueAtTime(v, t) { EVENTS.push({ param: name, kind: 'linearRamp', value: v, time: t }); return p; },
    exponentialRampToValueAtTime(v, t) { EVENTS.push({ param: name, kind: 'expRamp', value: v, time: t }); return p; },
    setTargetAtTime(v, t, tc) { EVENTS.push({ param: name, kind: 'setTarget', value: v, time: t, tc }); return p; },
    cancelScheduledValues(t) { EVENTS.push({ param: name, kind: 'cancel', time: t }); return p; },
  };
  return p;
}

let nodeId = 0;
function mkNode(type, extra = {}) {
  const id = ++nodeId;
  NODES.push({ id, type, at: NOW });
  const n = {
    _id: id, _type: type,
    connect(x) { return x; },
    disconnect() {},
    start(t, off) { NODES[NODES.length - 1].start = t; },
    stop(t) { NODES[NODES.length - 1].stop = t; },
    ...extra,
  };
  return n;
}

const ac = {
  sampleRate: 48000,
  get currentTime() { return NOW; },
  destination: {},
  createGain: () => mkNode('gain', { gain: param('gain') }),
  createBiquadFilter: () => {
    const n = mkNode('biquad');
    const id = n._id;
    n.frequency = param('biquad'+id+'.frequency', 350);
    n.Q = param('biquad'+id+'.Q', 1);
    n.detune = param('biquad'+id+'.detune', 0);
    n.type = 'lowpass';
    return n;
  },
  createOscillator: () => {
    const n = mkNode('osc');
    n.frequency = param('osc.frequency', 440);
    n.detune = param('osc.detune', 0);
    n.type = 'sine';
    return n;
  },
  createBufferSource: () => {
    const n = mkNode('bufsrc');
    n.playbackRate = param('bufsrc.playbackRate', 1);
    n.buffer = null; n.loop = false;
    return n;
  },
};

function newEngine() {
  NOW = 0; EVENTS = []; NODES = []; nodeId = 0;
  const bus = mkNode('gain', { gain: param('bus.gain', 1) });
  return new MusicEngine(ac, bus, {});
}

/** Minimal game ctx. */
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

/** Run the engine for `sec` of simulated wall-clock at `fps`. */
function run(eng, ctx, sec, fps = 60, hook = null) {
  const dt = 1 / fps;
  const n = Math.round(sec * fps);
  for (let i = 0; i < n; i++) {
    NOW += dt;
    if (hook) hook(i, eng, ctx);
    eng.update(ctx, dt);
  }
}

const out = {};
const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));

/* ============================================================ 1. INTENSITY */
// Claim: I reaches 0.886 in a stage-1 fight; acid (0.70) and lead (0.86) enter.
{
  const rows = [];
  // sweep: full arena, stage-1 difficulty ramp, 300 s
  for (const scen of [
    { name: 'stage1-full-arena (cap18,18 near,diff1.25)', enemies: 18, cap: 18, diff: 1.25 },
    { name: 'stage1-full-arena diff1.0', enemies: 18, cap: 18, diff: 1.0 },
    { name: 'stage1-24-enemies cap18', enemies: 24, cap: 18, diff: 1.25 },
    { name: 'stage4 arc-dominant (cap60,60 near,diff3.5)', enemies: 60, cap: 60, diff: 3.5 },
    { name: 'stage4 EMPTY arena diff3.5', enemies: 0, cap: 60, diff: 3.5 },
    { name: 'stage4 half arena diff3.5', enemies: 30, cap: 60, diff: 3.5 },
    { name: 'boss floor (0 enemies, boss alive)', enemies: 0, cap: 40, diff: 2.0, boss: true },
    { name: 'teleporter charging (0 enemies)', enemies: 0, cap: 40, diff: 2.0, charging: true },
    { name: 'boss + full arena diff3.5', enemies: 60, cap: 60, diff: 3.5, boss: true },
    { name: 'diff 6 (Collapse) full arena', enemies: 60, cap: 60, diff: 6 },
  ]) {
    const eng = newEngine();
    eng.silent = true; // arithmetic only; do not synthesise
    const ctx = mkCtx(scen);
    let maxI = 0, maxP = 0, maxArc = 0, maxSus = 0;
    run(eng, ctx, 300, 30, () => {});
    // sample after full 300 s convergence
    for (let i = 0; i < 60; i++) {
      NOW += 1 / 30; eng.update(ctx, 1 / 30);
      maxI = Math.max(maxI, eng.intensity); maxP = Math.max(maxP, eng.pressure);
      maxArc = Math.max(maxArc, eng.arc); maxSus = Math.max(maxSus, eng._sustain);
    }
    const lv = {};
    for (const [name, enter, band, max] of [
      ['sub', -0.06, 0.30, 0.89], ['pad', -0.08, 0.34, 0.19], ['kick', 0.13, 0.12, 0.50],
      ['hat', 0.24, 0.14, 0.82], ['bass', 0.31, 0.14, 0.52], ['openhat', 0.45, 0.12, 0.95],
      ['clap', 0.52, 0.12, 3.50], ['perc', 0.64, 0.12, 1.98], ['acid', 0.70, 0.14, 0.49],
      ['lead', 0.86, 0.12, 2.12]]) {
      lv[name] = +(Math.min(Math.max((maxI - enter) / band, 0), 1) * max).toFixed(3);
    }
    rows.push({ scen: scen.name, I: +maxI.toFixed(4), pressure: +maxP.toFixed(4), arc: +maxArc.toFixed(4), sustain: +maxSus.toFixed(4), levels: lv });
  }
  out.intensity = rows;
}

/* ================================================ 2. THE ARITHMETIC CEILING */
// What is the maximum attainable I as a function of arc and pressure?
{
  const f = (arc, p) => arc + (1 - arc) * p * 0.88;
  const grid = [];
  for (const arc of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    grid.push({ arc, pMax: +f(arc, 1).toFixed(4), pTypical0_95: +f(arc, 0.95).toFixed(4) });
  }
  // sustain ceiling: near/full * 0.9, full = max(7, cap*0.5)
  out.ceiling = {
    formula: 'I = arc + (1-arc)*pressure*0.88, pressure_target = clamp(sustain+heat,0,1), sustain <= 0.9',
    grid,
    note_sustain_max: 0.9,
    note_pressure_without_heat: 0.9,
    I_at_arc0_no_heat: +f(0, 0.9).toFixed(4),
    I_at_arc0_full_heat: +f(0, 1).toFixed(4),
    lead_enter: 0.86, lead_full: 0.86 + 0.12,
  };
}

/* ==================================================== 3. OPENING CEILING */
{
  const eng = newEngine(); eng.silent = true;
  const ctxMenu = mkCtx({ paused: true, enemies: 0 });
  run(eng, ctxMenu, 45, 30);
  const idle = { runT: +eng._runT.toFixed(3), I: +eng.intensity.toFixed(4) };
  // start of run
  eng.reset();
  const ctxRun = mkCtx({ enemies: 20, cap: 18, diff: 1.05 });
  run(eng, ctxRun, 6, 30);
  const at6 = { runT: +eng._runT.toFixed(3), I: +eng.intensity.toFixed(4) };
  run(eng, ctxRun, 54, 30);
  const at60 = { runT: +eng._runT.toFixed(3), I: +eng.intensity.toFixed(4) };
  out.ceiling_run = { idle, at6, at60, ceilingAt6s: +(0.10 + 6 / 60 * 0.70).toFixed(4) };
}

/* ================================================= 4. stop()/reset() LATCH */
{
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 20 });
  run(eng, ctx, 3, 60);
  const beforeStop = eng.stepsEmitted;
  eng.stop(NOW);
  run(eng, ctx, 3, 60);
  const afterStop = eng.stepsEmitted;
  eng.reset();                       // what stageStart(index 0) calls
  run(eng, ctx, 5, 60);
  const afterReset = eng.stepsEmitted;
  out.stopLatch = {
    stepsBeforeStop: beforeStop, stepsAfterStop: afterStop, stepsAfterReset: afterReset,
    stoppedFlagAfterReset: eng.stopped,
    verdict: afterReset === afterStop ? 'reset() does NOT revive a stopped engine' : 'revived',
  };
}

/* ============================================== 5. RESYNC: bars and rewinds */
{
  function resyncTest(stalls) {
    const eng = newEngine();
    const ctx = mkCtx({ enemies: 20, cap: 18, diff: 1.2 });
    let bars = 0, rewinds = 0, last = eng._bar, resyncs = 0, lastStep = eng._step;
    const dt = 1 / 60;
    const T = 12;
    const stallAt = stalls.map((s) => s.at);
    let t = 0;
    while (t < T) {
      const si = stallAt.findIndex((a) => Math.abs(a - t) < dt / 2);
      if (si >= 0) { NOW += stalls[si].len; t += stalls[si].len; }
      else { NOW += dt; t += dt; }
      const stepBefore = eng._step;
      const mtBefore = eng._musicTime;
      eng.update(ctx, dt);
      if (mtBefore < NOW) resyncs++;
      if (eng._bar > last) bars += eng._bar - last;
      if (eng._bar < last) rewinds++;
      last = eng._bar;
    }
    return { bars, rewinds, resyncs, steps: eng.stepsEmitted, finalBar: eng._bar };
  }
  out.resync = {
    three_0p6s_stalls: resyncTest([{ at: 3, len: 0.6 }, { at: 6, len: 0.6 }, { at: 9, len: 0.6 }]),
    no_stall: resyncTest([]),
    tab_backgrounded_30s: (() => {
      const eng = newEngine();
      const ctx = mkCtx({ enemies: 20 });
      const dt = 1 / 60;
      for (let i = 0; i < 120; i++) { NOW += dt; eng.update(ctx, dt); }
      const barBefore = eng._bar, stepBefore = eng._step;
      NOW += 30;                       // tab hidden 30 s, rAF stopped
      eng.update(ctx, dt);
      return { barBefore, barAfter: eng._bar, stepBefore, stepAfter: eng._step, jumped: eng._step - stepBefore };
    })(),
  };
}

/* ======================================== 6. HAT 8th/16th BAR QUANTISATION */
{
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 12, cap: 18, diff: 1.1 });
  // dither intensity around the 0.55 threshold by dithering enemy count
  const perBar = new Map();
  let curBar = 0, hats = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 30; i++) {
    NOW += dt;
    // force intensity to hover on the threshold
    eng.update(ctx, dt);
    eng.intensity = 0.55 + (Math.sin(i * 0.7) * 0.02);
  }
  // recount by instrumenting: rerun counting emitted hat noise nodes per bar
  const eng2 = newEngine();
  const ctx2 = mkCtx({ enemies: 12, cap: 18, diff: 1.1 });
  // Bring layers up so `hat` is on, then pin intensity on the threshold.
  for (let i = 0; i < 60 * 40; i++) { NOW += dt; eng2.update(ctx2, dt); }
  const barsSeen = [];
  const origEmit = eng2._emit.bind(eng2);
  let bucket = { bar: eng2._bar, hats: 0 };
  eng2._emit = function (t, sd) {
    if (this._bar !== bucket.bar) { barsSeen.push(bucket.hats); bucket = { bar: this._bar, hats: 0 }; }
    const n0 = NODES.length;
    origEmit(t, sd);
    // hat notes are the only noise emitted on odd 16ths at s%2===0 gating; count
    // via the hat layer flag instead:
    if (this._on('hat', t) && (this._hat16 || (this._step % 16) % 2 === 0)) bucket.hats++;
  };
  for (let i = 0; i < 60 * 30; i++) {
    NOW += dt;
    eng2.update(ctx2, dt);
    eng2.intensity = 0.55 + Math.sin(i * 0.31) * 0.02;   // dither +/-0.02
  }
  out.hatQuantise = { perBar: barsSeen.slice(1, -1), clean: barsSeen.slice(1, -1).filter((h) => h === 8 || h === 16).length, total: barsSeen.slice(1, -1).length };
}

/* ================================== 7. ACID FILTER TIMELINE ORDER (MAJOR 3) */
{
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 60, cap: 60, diff: 6 });   // drive I to 1
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 120; i++) { NOW += dt; eng.update(ctx, dt); }
  eng.intensity = 1;
  EVENTS = [];
  for (let i = 0; i < 60 * 10; i++) { NOW += dt; eng.update(ctx, dt); }
  const fev = EVENTS.filter((e) => e.param === 'biquad.frequency' && e.kind !== 'set');
  // out-of-order detection: an event scheduled at a time earlier than a
  // previously-scheduled event on the same param
  let ooo = 0, maxBack = 0, prevT = -1;
  const flats = [];
  for (let i = 0; i < fev.length; i++) {
    const e = fev[i];
    if (e.time < prevT - 1e-9) { ooo++; maxBack = Math.max(maxBack, prevT - e.time); }
    prevT = Math.max(prevT, e.time);
  }
  // flat spans: between a ramp END and the next setValueAtTime the param holds
  for (let i = 0; i + 1 < fev.length; i++) {
    if (fev[i].kind === 'expRamp' && fev[i + 1].kind === 'setValueAtTime') {
      flats.push(+(fev[i + 1].time - fev[i].time).toFixed(5));
    }
  }
  flats.sort((a, b) => b - a);
  out.acid = {
    events: fev.length,
    outOfOrder: ooo, worstBacktrack: +maxBack.toFixed(5),
    longestFlatHold_ms: +(flats[0] * 1000).toFixed(2),
    top5FlatHolds_ms: flats.slice(0, 5).map((f) => +(f * 1000).toFixed(2)),
    negativeFlats: flats.filter((f) => f < 0).length,
    stepDur_at142bpm_ms: +(60 / 142 / 4 * 1000).toFixed(2),
  };
}

/* ============================ 8. BPM DRIFT vs ACID CLAMP (untested by r3) */
{
  // The clamp uses the CURRENT stepDur. If bpm rises between schedule calls the
  // grid shrinks; does a previously-written ramp then cross the next step?
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 60, cap: 60, diff: 6 });
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 60; i++) { NOW += dt; eng.update(ctx, dt); }
  EVENTS = [];
  for (let i = 0; i < 60 * 20; i++) { NOW += dt; eng.update(ctx, dt); }
  const fev = EVENTS.filter((e) => e.param === 'biquad.frequency' && e.kind !== 'set');
  let cross = 0;
  for (let i = 0; i + 2 < fev.length; i += 2) {
    // pairs are [setValueAtTime(top), expRamp(base)]
    if (fev[i].kind === 'setValueAtTime' && fev[i + 1].kind === 'expRamp' && fev[i + 2]) {
      if (fev[i + 1].time > fev[i + 2].time + 1e-9) cross++;
    }
  }
  out.acidBpmDrift = { pairs: Math.floor(fev.length / 2), rampsCrossingNextNote: cross };
}

/* ============================================= 9. VOICE COUNT / node budget */
{
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 60, cap: 60, diff: 6 });
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 120; i++) { NOW += dt; eng.update(ctx, dt); }
  const start = NODES.length, t0 = NOW;
  let peak = 0;
  for (let i = 0; i < 60 * 20; i++) { NOW += dt; eng.update(ctx, dt); peak = Math.max(peak, eng.voices); }
  out.musicNodes = {
    intensity: +eng.intensity.toFixed(3),
    nodesPerSecond: +((NODES.length - start) / (NOW - t0)).toFixed(1),
    reportedVoicesPeak: peak,
    note: 'engine .voices never decrements here (no onended in stub) - nodes/s is the real figure',
  };
}

/* ======================================= 10. SILENT: model keeps integrating */
{
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 20, cap: 18, diff: 1.2 });
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 30; i++) { NOW += dt; eng.update(ctx, dt); }
  const before = { steps: eng.stepsEmitted, I: +eng.intensity.toFixed(4), musicTime: +eng._musicTime.toFixed(3), bar: eng._bar };
  eng.silent = true;
  for (let i = 0; i < 60 * 20; i++) { NOW += dt; eng.update(ctx, dt); }
  const during = { steps: eng.stepsEmitted, I: +eng.intensity.toFixed(4), musicTime: +eng._musicTime.toFixed(3), bar: eng._bar };
  eng.silent = false;
  const barBefore = eng._bar;
  NOW += dt; eng.update(ctx, dt);
  const after = { steps: eng.stepsEmitted, bar: eng._bar, jumpedSteps: null, musicTime: +eng._musicTime.toFixed(3) };
  after.barJump = eng._bar - barBefore;
  out.silentResume = { before, during, after };
}

/* ================================== 11. LAYER GAIN: is `cur` ever a lie?  */
{
  // A resync inside the half-bar ramp means the gain has NOT reached L.cur.
  const eng = newEngine();
  const ctx = mkCtx({ enemies: 60, cap: 60, diff: 3 });
  const dt = 1 / 60;
  let mismatches = 0;
  for (let i = 0; i < 60 * 90; i++) {
    NOW += dt;
    if (i === 1800) NOW += 0.7;   // stall inside a ramp
    eng.update(ctx, dt);
  }
  out.layerCur = { note: 'informational', bar: eng._bar, steps: eng.stepsEmitted };
}

console.log(JSON.stringify(out, null, 2));
