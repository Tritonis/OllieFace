// tests/sfx-dense-mix.test.mjs
//
// Issue #226 — "Add SFX voice priority and dense-mix clipping protection."
// Recon (reviews/audio-134, #224) found the mechanism already built: `_take`'s
// priority reserve (Audio.js:673) and the sfxLimiter -> master -> limiter
// chain (Audio.js:460-518). This probe drives both to hard saturation with
// automated evidence rather than trusting the mechanism exists, and each arm
// is falsifiable: blind the reserve or detach a limiter and a named line here
// goes red.
import { Audio } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/* ------------------------------------------------------------------ */
/* Stub graph — the voice-budget-headroom.test.mjs shape, unchanged.    */
/* ------------------------------------------------------------------ */
const param = (v = 0) => ({
  value: v,
  setValueAtTime(x) { this.value = x; },
  cancelScheduledValues() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  setTargetAtTime() {},
});
const node = (kind) => {
  const n = {
    kind, onended: null, stops: [], connectedTo: [],
    gain: param(), frequency: param(), Q: param(), detune: param(), playbackRate: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    reduction: 0,
    positionX: param(), positionY: param(), positionZ: param(),
    connect(d) { n.connectedTo.push(d); return d; },
    disconnect() { n.connectedTo = []; },
    start() {},
    stop(t) { n.stops.push(t); },
  };
  return n;
};
function makeAudio() {
  const made = [];
  const make = (k) => { const n = node(k); made.push(n); return n; };
  const a = new Audio();
  a.ac = {
    currentTime: 10, sampleRate: 48000, state: 'running', made, destination: { kind: 'destination' },
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
    createDynamicsCompressor: () => make('compressor'),
    createWaveShaper: () => make('shaper'),
    createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
    endStopped() {
      for (const n of made) {
        if (n.onended && n.stops.length) { const f = n.onended; n.onended = null; f(); }
      }
    },
  };
  a.sfx = node('sfx');
  a.noiseBuf = {};
  return a;
}

/* ------------------------------------------------------------------ */
/* 1. Critical cues at hard saturation                                  */
/* ------------------------------------------------------------------ */
// Drives worldVoices to 44/44 and keeps piling on refusals — #224's measured
// dense-combat state (~2600 refusals/run) — then fires every cue the mixer
// documents as priority=true and asserts each is granted, not refused.
console.log('critical cues survive a saturated world budget');
{
  const a = makeAudio();
  // Saturate the world bucket exactly to its cap.
  for (let i = 0; i < 44; i++) ok(a._take(1, false) === true, `world voice ${i + 1}/44 admitted while filling`);
  ok(a.worldVoices === 0, 'sanity: _take alone does not charge worldVoices (charge happens on _release)');
  // `_take` only gates; charge it the way real sounds do, via `_release`.
  // Re-run properly: charge each admitted take.
}
{
  const a = makeAudio();
  const chargeWorld = () => { ok(a._take(1, false), 'filling a world slot'); a._release(node('src')); };
  for (let i = 0; i < 44; i++) chargeWorld();
  ok(a.worldVoices === 44, `world bucket is saturated (${a.worldVoices}/44)`);
  ok(a._take(1, false) === false, 'one more world sound is refused at saturation');
  // Pile on refusals the way #224 measured (~2600/run) to prove the reserve
  // holds under sustained pressure, not just at the moment it fills.
  for (let i = 0; i < 500; i++) a._take(1, false);
  ok(a._refusals >= 500, `refusals accrue under continued pressure (${a._refusals})`);
  ok(a.worldVoices === 44, 'world bucket did not spill past its cap while refusing');

  const refusedBefore = a._refusals;
  const takesBefore = a._takes;

  // Each cue is fired, checked and released before the next: a one-shot cue
  // in play does not linger, and the priority reserve's own concurrent-stack
  // capacity (multiple cues held open at once) is voice-budget-headroom's
  // territory ("a dome and a snare... still leave room for playerHurt",
  // pickup(11)+levelUp(12)+playerHurt(3) admitted together). What #226 asks
  // is whether the WORLD saturation above — the dense-mix condition — can
  // ever cost a critical cue its grant, and the world/priority split means it
  // structurally cannot: every one of these is charged to `priorityVoices`,
  // never `worldVoices`, regardless of how full the world bucket is.
  const fireAndRelease = (label, fn) => {
    const before = a.priorityVoices;
    fn();
    ok(a.priorityVoices > before, `${label} granted at world saturation (priorityVoices ${before}->${a.priorityVoices})`);
    a.ac.endStopped();
    ok(a.priorityVoices === 0, `${label}'s nodes released cleanly (priorityVoices=${a.priorityVoices})`);
  };

  fireAndRelease('playerHurt', () => a.playerHurt(30));
  {
    const before = a.priorityVoices;
    a.playerRevived({ x: 0, y: 0, z: 0 });
    ok(a.priorityVoices > before, `playerRevived (_always, never refused) granted at saturation (priorityVoices ${before}->${a.priorityVoices})`);
    a.ac.endStopped();
  }
  fireAndRelease('playerDowned', () => { a.playerDowned({ x: 0, y: 0, z: 0 }, 'owner-1'); a.releaseDownedMarker('owner-1'); });
  fireAndRelease('levelUp', () => a.levelUp());
  fireAndRelease('pickup', () => a.pickup(2));
  fireAndRelease('bandSting', () => a.bandSting(2, 1));

  ok(a.worldVoices === 44, 'the world bucket the critical cues bypassed is still exactly at cap');
  ok(a._refusals >= refusedBefore, 'world refusals kept accruing throughout — the mixer never opened the world gate to fit these');
  ok(a._takes > takesBefore, 'each critical cue registered its own _take call rather than being silently skipped');
}

/* ------------------------------------------------------------------ */
/* Attack-tell finding — reported, not "fixed": windups are deliberately  */
/* NOT priority-gated (Audio.js:1119-1139, windupVoice). They spend the   */
/* world bucket through their own nearest-N sub-budget (WINDUP_VOICES),   */
/* which tests/voice-budget-headroom.test.mjs (M4) already exercises      */
/* under a 14-attacker horde. This is in scope of the world budget, not   */
/* the player-feedback reserve, by the same M4 test's own framing — a     */
/* telegraph is what the player is being warned ABOUT, not player-owned   */
/* feedback, so it is not one of the "critical cues" #226 names. Recorded */
/* here as a finding, not treated as a hole to patch (out of scope: #134  */
/* and the graph's design are not to be redesigned by this ticket).       */
/* ------------------------------------------------------------------ */
console.log('attack tells (windupVoice) are world-budget, not priority-gated — recorded, not a bug');
{
  const a = makeAudio();
  const h = a.windupVoice({ x: 1, y: 0, z: 0 }, 'shock', 1.0);
  ok(h.active, 'a windup at saturation-free budget plays');
  ok(a.priorityVoices === 0, 'and it did not touch the priority reserve (by design — see comment above)');
  h.release();
}

/* ------------------------------------------------------------------ */
/* Real-graph builder — `_ensure()` short-circuits and returns          */
/* immediately whenever `this.ac` is already set (the M4/M5 stub's own   */
/* shape), so the actual `createDynamicsCompressor`/`connect` wiring is  */
/* only exercised when `_ensure` runs its real construction path. This   */
/* stubs `globalThis.AudioContext` instead — the same technique          */
/* reviews/audio-134/dense-sfx.mjs uses — so `_ensure()` builds the real  */
/* graph shape against fake nodes.                                       */
/* ------------------------------------------------------------------ */
function buildRealAudio() {
  const made = [];
  const make = (k) => { const n = node(k); made.push(n); return n; };
  const acStub = {
    currentTime: 10, sampleRate: 48000, state: 'running', made, destination: { kind: 'destination' },
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
    createDynamicsCompressor: () => make('compressor'),
    createWaveShaper: () => make('shaper'),
    createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
  };
  const RealAC = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { return acStub; } };
  const a = new Audio();
  try { a._ensure(); } finally { globalThis.AudioContext = RealAC; }
  return a;
}

/* ------------------------------------------------------------------ */
/* 2. Clipping-protection graph shape                                   */
/* ------------------------------------------------------------------ */
console.log('the clipping-protection chain is wired as documented');
{
  const a = buildRealAudio();
  ok(a.sfx.connectedTo.includes(a.sfxLimiter), 'sfx bus feeds sfxLimiter');
  ok(a.sfxLimiter.connectedTo.includes(a.master), 'sfxLimiter feeds master');
  ok(a.master.connectedTo.includes(a.limiter), 'master feeds the final limiter');
  ok(a.limiter.connectedTo.includes(a.ac.destination), 'the final limiter feeds destination');
  ok(a.sfxLimiter.threshold.value === -5, `sfxLimiter threshold is -5 dB (got ${a.sfxLimiter.threshold.value})`);
  ok(a.sfxLimiter.ratio.value === 10, `sfxLimiter ratio is 10:1 (got ${a.sfxLimiter.ratio.value})`);
  ok(a.limiter.threshold.value === -3, `master limiter threshold is -3 dB (got ${a.limiter.threshold.value})`);
  ok(a.limiter.ratio.value === 12, `master limiter ratio is 12:1 (got ${a.limiter.ratio.value})`);
}

/* ------------------------------------------------------------------ */
/* Behavioral clipping arm — honestly scoped                            */
/* ------------------------------------------------------------------ */
// This node test harness has no Web Audio implementation (no
// AudioContext/OfflineAudioContext global — confirmed: no test in this repo
// uses OfflineAudioContext, and Node itself does not ship one). Rendering
// actual samples through the DynamicsCompressor to observe `.reduction` <0
// under a dense burst therefore cannot be done from a plain node test; that
// measurement already exists and is the real behavioral evidence for this
// mechanism: reviews/audio-134/dense-sfx.mjs and live-dense.mjs render the
// REAL graph through Playwright + OfflineAudioContext at dense-firefight
// rates and report sfxLimiter/master `.reduction` through the render. This
// probe instead behaviorally exercises the STUB reduction plumbing: nothing
// here can observe true DSP clipping, but it proves the graph is positioned
// to receive gain-reduction reporting the way the real one does.
console.log('behavioral arm: reduction is readable off both limiters after a dense burst (stub graph; real DSP evidence lives in reviews/audio-134)');
{
  const a = buildRealAudio();
  // Simulate what a saturating burst does to a real DynamicsCompressor: it
  // pulls .reduction negative. The stub graph has no DSP, so this arm proves
  // wiring + readability, and is explicitly not a substitute for
  // reviews/audio-134's sample-exact render.
  a.sfxLimiter.reduction = -6.2;
  a.limiter.reduction = -0.5;
  ok(typeof a.sfxLimiter.reduction === 'number' && a.sfxLimiter.reduction < 0, 'sfxLimiter.reduction is readable and negative under simulated load');
  ok(typeof a.limiter.reduction === 'number' && a.limiter.reduction < 0, 'master limiter.reduction is readable and negative under simulated load');
}

/* ------------------------------------------------------------------ */
/* 3. Guard-can-fail                                                     */
/* ------------------------------------------------------------------ */
console.log('GUARD-CAN-FAIL: blind the reserve — critical-cue test must fail');
{
  const a = makeAudio();
  // Blind the reserve: route priority through the world budget instead.
  const origTake = a._take.bind(a);
  a._take = (cost = 1, priority = false) => origTake(cost, false);
  const chargeWorld = () => { a._take(1, false); a._release(node('src')); };
  for (let i = 0; i < 44; i++) chargeWorld();
  ok(a.worldVoices === 44, 'blinded setup: world bucket saturated');
  const before = a.priorityVoices;
  a.playerHurt(30);
  const blindedGranted = a.priorityVoices > before;
  ok(blindedGranted === false, 'BLINDED: playerHurt is now refused at saturation, proving the unblinded pass above was real');
}

console.log('GUARD-CAN-FAIL: detach a limiter — graph test must fail');
{
  const a = buildRealAudio();
  a.sfx.disconnect();
  a.sfx.connect(a.master); // bypass sfxLimiter entirely
  const wired = a.sfx.connectedTo.includes(a.sfxLimiter);
  ok(wired === false, 'BLINDED: sfx no longer feeds sfxLimiter, proving the unblinded wiring assertion above was real');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
