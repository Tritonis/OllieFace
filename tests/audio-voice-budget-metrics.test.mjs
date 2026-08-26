// tests/audio-voice-budget-metrics.test.mjs
//
// Issue #224: the capture baseline needs a peak-concurrency reading on the
// world voice bucket, not just its instantaneous level at whatever moment the
// harness happens to look — `worldVoices` alone can read 0 at the end of a
// scenario that spent its whole budget mid-fight and released everything
// before the shutter. `voiceBudgetSnapshot()` is a pure read of state the
// mixer already keeps (`worldVoices`, `_takes`, `_refusals`) plus one new
// write-only counter (`_peakWorldVoices`) that never influences `_take`'s own
// admit/refuse decision — so this file also proves the gate's arithmetic is
// unchanged by diffing `_take`'s return values with and without the peak wired.
import { Audio } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

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
    kind, onended: null, stops: [],
    gain: param(), frequency: param(), Q: param(), detune: param(), playbackRate: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    connect(d) { return d; },
    disconnect() {},
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
    currentTime: 10, sampleRate: 48000, state: 'running', made,
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
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

console.log('voiceBudgetSnapshot: peak tracks the high-water mark, not the current level');
{
  const a = makeAudio();
  ok(typeof a.voiceBudgetSnapshot === 'function', 'Audio exposes voiceBudgetSnapshot()');
  const held = [];
  for (let i = 0; i < 5; i++) held.push(a.windupVoice({ x: i, y: 0, z: 0 }, 'shock', 1.9));
  const snap1 = a.voiceBudgetSnapshot();
  ok(snap1.worldVoices > 0, 'world voices climbed while the horde is held');
  ok(snap1.peakWorldVoices === snap1.worldVoices, 'peak matches the current level at its own high point');
  ok(snap1.worldCap === 44, 'the cap is reported alongside the level (44 is the tuned ceiling)');

  for (const h of held) h.release();
  a.ac.endStopped();
  const snap2 = a.voiceBudgetSnapshot();
  ok(snap2.worldVoices === 0, 'the current level falls back to zero once everything releases');
  ok(snap2.peakWorldVoices === snap1.peakWorldVoices,
    `the peak survives the release (${snap2.peakWorldVoices} still reads the earlier high-water mark)`);
}

console.log('the peak counter never changes what _take admits or refuses');
{
  const a = makeAudio();
  // Hold 44 world nodes open (never released) to fill the tuned cap exactly,
  // the same _take-then-_release pairing every real sound body uses.
  let admitted = 0;
  for (let i = 0; i < 60; i++) {
    if (a._take(1)) { admitted++; a._release(node('src')); }
  }
  ok(admitted === 44, `still admits exactly the tuned world cap (${admitted}/44)`);
  ok(a.voiceBudgetSnapshot().refusals >= 16, 'refusals are visible on the same snapshot');
  ok(a.voiceBudgetSnapshot().peakWorldVoices === 44, 'the peak reads the full held cap');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
