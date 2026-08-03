/** Probe A2: acid filter timeline, isolated to the ONE shared acidFilter node. */
import { MusicEngine } from '../../../src/systems/Music.js';

let EVENTS = [], NOW = 0, nodeId = 0;
function param(name, initial = 0) {
  const p = {
    _v: initial,
    get value() { return this._v; },
    set value(v) { this._v = v; },
    setValueAtTime(v, t) { EVENTS.push({ param: name, kind: 'setValueAtTime', value: v, time: t }); return p; },
    linearRampToValueAtTime(v, t) { EVENTS.push({ param: name, kind: 'linearRamp', value: v, time: t }); return p; },
    exponentialRampToValueAtTime(v, t) { EVENTS.push({ param: name, kind: 'expRamp', value: v, time: t }); return p; },
    setTargetAtTime(v, t, tc) { EVENTS.push({ param: name, kind: 'setTarget', value: v, time: t, tc }); return p; },
    cancelScheduledValues(t) { EVENTS.push({ param: name, kind: 'cancel', time: t }); return p; },
  };
  return p;
}
function mkNode(type, extra = {}) { const id = ++nodeId; return { _id: id, _type: type, connect(x) { return x; }, disconnect() {}, start() {}, stop() {}, ...extra }; }
const ac = {
  sampleRate: 48000, destination: {},
  get currentTime() { return NOW; },
  createGain: () => { const n = mkNode('gain'); n.gain = param('g' + n._id); return n; },
  createBiquadFilter: () => { const n = mkNode('biquad'); n.frequency = param('bq' + n._id + '.f', 350); n.Q = param('bq' + n._id + '.Q', 1); n.detune = param('bq' + n._id + '.d', 0); n.type = 'lowpass'; return n; },
  createOscillator: () => { const n = mkNode('osc'); n.frequency = param('o' + n._id + '.f', 440); n.detune = param('o' + n._id + '.d', 0); n.type = 'sine'; return n; },
  createBufferSource: () => { const n = mkNode('bs'); n.playbackRate = param('bs' + n._id + '.r', 1); n.buffer = null; n.loop = false; return n; },
};
function mkCtx(o = {}) {
  const list = []; for (let i = 0; i < (o.enemies ?? 0); i++) list.push({ alive: true, position: { x: 10, y: 0, z: 0 } });
  return { paused: false, player: { position: { x: 0, y: 0, z: 0 } },
    director: { difficultyCoefficient: o.diff ?? 1, enemies: list, populationCap: o.cap ?? 18, boss: null },
    progression: { state: 'idle' } };
}

const out = {};
function analyse(label, opts) {
  NOW = 0; EVENTS = []; nodeId = 0;
  const bus = mkNode('gain', { gain: param('bus') });
  const eng = new MusicEngine(ac, bus, {});
  const AF = 'bq' + eng.acidFilter._id + '.f';
  const ctx = mkCtx(opts);
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 200; i++) { NOW += dt; eng.update(ctx, dt); }
  if (opts.pinI !== undefined) eng.intensity = opts.pinI;
  EVENTS = [];
  const t0 = NOW;
  for (let i = 0; i < 60 * 20; i++) {
    NOW += dt; eng.update(ctx, dt);
    if (opts.pinI !== undefined) eng.intensity = opts.pinI;
  }
  const ev = EVENTS.filter((e) => e.param === AF);
  // 1. monotonic ordering
  let ooo = 0, worst = 0, prev = -Infinity;
  for (const e of ev) { if (e.time < prev - 1e-9) { ooo++; worst = Math.max(worst, prev - e.time); } prev = Math.max(prev, e.time); }
  // 2. flat holds: gap between a ramp's end and the next setValueAtTime
  const holds = [];
  for (let i = 0; i + 1 < ev.length; i++) {
    if (ev[i].kind === 'expRamp' && ev[i + 1].kind === 'setValueAtTime') holds.push(ev[i + 1].time - ev[i].time);
  }
  holds.sort((a, b) => b - a);
  // 3. do consecutive pairs overlap? pair i = [setValueAtTime, expRamp]
  let overlaps = 0, worstOverlap = 0;
  for (let i = 0; i + 3 < ev.length; i += 2) {
    const rampEnd = ev[i + 1].time, nextStart = ev[i + 2].time;
    if (rampEnd > nextStart + 1e-9) { overlaps++; worstOverlap = Math.max(worstOverlap, rampEnd - nextStart); }
  }
  // 4. per-note ramp length distribution
  const lens = [];
  for (let i = 0; i + 1 < ev.length; i += 2) if (ev[i].kind === 'setValueAtTime' && ev[i + 1].kind === 'expRamp') lens.push(ev[i + 1].time - ev[i].time);
  const uniq = [...new Set(lens.map((l) => +(l * 1000).toFixed(2)))].sort((a, b) => a - b);
  out[label] = {
    intensity: +eng.intensity.toFixed(3), bpm: +eng.bpm.toFixed(2),
    stepDur_ms: +(60 / eng.bpm / 4 * 1000).toFixed(2),
    events: ev.length, outOfOrder: ooo, worstBacktrack_ms: +(worst * 1000).toFixed(3),
    rampsCrossingNextNote: overlaps, worstOverlap_ms: +(worstOverlap * 1000).toFixed(3),
    longestFlatHold_ms: +(holds[0] * 1000).toFixed(2),
    medianFlatHold_ms: +(holds[Math.floor(holds.length / 2)] * 1000).toFixed(2),
    negativeHolds: holds.filter((h) => h < -1e-9).length,
    rampLengths_ms: uniq,
  };
}

analyse('pinnedI_1.0', { enemies: 60, cap: 60, diff: 6, pinI: 1 });
analyse('free_diff6_full', { enemies: 60, cap: 60, diff: 6 });
analyse('pinnedI_0.75', { enemies: 60, cap: 60, diff: 6, pinI: 0.75 });
analyse('rising_bpm', { enemies: 60, cap: 60, diff: 2.0 });   // bpm still climbing

console.log(JSON.stringify(out, null, 2));
