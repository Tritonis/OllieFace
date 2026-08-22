// tests/audio-sustained.test.mjs
//
// `startSustained` is the first voice in this mixer with a lifetime the caller
// owns, which makes it the first one that can leak the voice budget. A held
// voice must charge its cost for as long as it is held and give every unit of
// it back when it ends, and `release()` must actually stop the sources rather
// than merely returning.
//
// Both halves are written so they CAN fail, which in this repo is the point:
// the counter assertions distinguish "held" from "released" (a release that
// forgot to decrement, or a start that forgot to charge, breaks one of them),
// and the stop assertions read the scheduled stop time and the closing ramp off
// the stub graph, so a `release()` reduced to a no-op fails rather than passes
// quietly.
import { Audio } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// Recording stub graph. `stop()` records its argument and does NOT fire
// `onended` — real Web Audio fires it when the scheduled stop is reached, so
// the budget is still charged in between, and the test drives that transition
// explicitly through `endAll()`.
const param = (v = 0) => ({
  value: v,
  ramps: [], sets: [], cancels: 0,
  setValueAtTime(x) { this.sets.push(x); this.value = x; },
  cancelScheduledValues() { this.cancels++; },
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime(x, t) { this.ramps.push([x, t]); },
  setTargetAtTime() {},
});
const node = (kind) => {
  const n = {
    kind, out: [], onended: null,
    gain: param(), frequency: param(), Q: param(), detune: param(), playbackRate: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    starts: [], stops: [],
    connect(d) { n.out.push(d); return d; },
    disconnect() {},
    start(t) { n.starts.push(t); },
    stop(t) { n.stops.push(t); },
  };
  return n;
};
function makeAc() {
  const made = [];
  const make = (kind) => { const n = node(kind); made.push(n); return n; };
  return {
    currentTime: 10, sampleRate: 48000, made, state: 'running',
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
    sources: () => made.filter((n) => n.kind === 'osc' || n.kind === 'src'),
    // Everything the context would eventually hand back, handed back now.
    // A source nobody stopped is deliberately NOT ended: `onended` only fires
    // at a scheduled stop, so a voice that was never stopped keeps its budget
    // forever, and a stub that ended it anyway would hide exactly that leak.
    endAll() {
      for (const n of made) {
        if (n.onended && n.stops.length) { const f = n.onended; n.onended = null; f(); }
      }
    },
  };
}
function makeAudio() {
  const a = new Audio();
  a.ac = makeAc();
  a.sfx = node('sfx');
  a.noiseBuf = {};
  return a;
}
const counters = (a) => [a.voices, a.worldVoices, a.priorityVoices];

console.log('a held voice is charged for as long as it is held');
{
  const a = makeAudio();
  ok(counters(a).join() === '0,0,0', 'idle mixer holds nothing');

  const h = a.startBeam({ x: 1, y: 2, z: 3 });
  ok(h.active, 'the beam started');
  // startBeam is two tones plus a noise layer: three source nodes.
  ok(a.voices === 3, `three source nodes charged while held (saw ${a.voices})`);
  ok(a.worldVoices === 3, 'charged to the world budget, not the reserve');
  ok(a.priorityVoices === 0, 'the player reserve is untouched');

  // Time passes; nothing releases it. A burst would have expired by now.
  a.ac.currentTime = 40;
  ok(a.voices === 3, 'still charged after 30 s — a held voice does not expire on its own');

  h.release();
  ok(!h.active, 'the handle reports itself released');
  ok(a.voices === 3, 'still charged during the release fade — the nodes are still running');

  a.ac.endAll();
  ok(counters(a).join() === '0,0,0', 'every unit of budget came back once the voice ended');
}

console.log('release actually stops the sources, and ramps first');
{
  const a = makeAudio();
  a.ac.currentTime = 5;
  const h = a.startSustained({ x: 0, y: 0, z: 0 }, {
    tones: [{ type: 'sine', f0: 200, gain: 0.2 }], release: 0.08,
  });
  const src = a.ac.sources();
  ok(src.length === 1, 'one source for a one-tone recipe');
  ok(src[0].starts.length === 1 && src[0].stops.length === 0, 'started, and left running');

  a.ac.currentTime = 9;
  h.release();
  ok(src[0].stops.length === 1, 'release scheduled a stop');
  const stopAt = src[0].stops[0];
  ok(stopAt > 9, `the stop is in the future, not at the cut (${stopAt})`);
  ok(stopAt >= 9.08, 'the stop waits out the fade rather than truncating it');

  // The closing ramp lives on the gain node feeding the source's chain.
  const g = a.ac.made.find((n) => n.kind === 'gain');
  const closing = g.gain.ramps.filter(([v]) => v <= 0.0001);
  ok(closing.length === 1, 'exactly one ramp to silence');
  ok(closing[0][1] <= stopAt, 'the ramp completes at or before the stop — no click');
  ok(g.gain.cancels > 0 || g.gain.sets.length > 1, 'the held envelope was cancelled/held before the ramp');
}

console.log('releasing twice is a no-op');
{
  const a = makeAudio();
  const h = a.startSustained(null, { tones: [{ f0: 100 }] });
  h.release();
  const src = a.ac.sources()[0];
  ok(src.stops.length === 1, 'first release stopped it');
  h.release();
  h.release();
  ok(src.stops.length === 1, 'further releases scheduled nothing');
  a.ac.endAll();
  ok(counters(a).join() === '0,0,0', 'the budget was returned exactly once');
}

console.log('a refused voice is inert and safe to release');
{
  const a = makeAudio();
  const held = [];
  // Fill the world budget with held voices. WORLD_VOICES is 44; ten four-node
  // voices leaves four, which is less than the beam's three plus the next
  // four-node voice.
  for (let i = 0; i < 11; i++) {
    held.push(a.startSustained({ x: i, y: 0, z: 0 }, {
      tones: [{ f0: 100 }, { f0: 120 }, { f0: 140 }, { f0: 160 }],
    }));
  }
  const charged = a.worldVoices;
  ok(charged === 44, `the budget filled to WORLD_VOICES (${charged})`);

  const refused = a.startBeam({ x: 0, y: 0, z: 0 });
  ok(!refused.active, 'the over-budget voice was refused');
  ok(a.worldVoices === charged, 'a refused voice charges nothing');
  let threw = false;
  try { refused.release(); refused.release(); refused.move({ x: 1, y: 1, z: 1 }); } catch { threw = true; }
  ok(!threw, 'the inert handle is safe to release and move');
  ok(a.worldVoices === charged, 'releasing the inert handle did not credit budget it never took');

  for (const h of held) h.release();
  a.ac.endAll();
  ok(counters(a).join() === '0,0,0', 'the whole held set gave its budget back');
}

console.log('no context, unplaceable positions, and a dead source do not throw');
{
  const a = new Audio(); // never given a context, and none in this process
  const h = a.startBeam({ x: 0, y: 0, z: 0 });
  ok(!h.active, 'no AudioContext yields an inert handle');
  let threw = false;
  try { h.release(); h.move({ x: 1, y: 1, z: 1 }); } catch { threw = true; }
  ok(!threw, 'and it is safe to drive');

  const b = makeAudio();
  const nan = b.startSustained({ x: NaN, y: 0, z: 0 }, { tones: [{ f0: 100 }] });
  ok(nan.active, 'an unplaceable voice still plays, unpanned');
  threw = false;
  try { nan.move({ x: 2, y: 2, z: 2 }); } catch { threw = true; }
  ok(!threw, 'moving an unpanned voice is a no-op, not a throw');

  const c = makeAudio();
  const dead = c.startSustained(null, { tones: [{ f0: 100 }] });
  c.ac.sources()[0].stop = () => { throw new Error('InvalidStateError'); };
  threw = false;
  try { dead.release(); } catch { threw = true; }
  ok(!threw, 'a source the context already tore down does not escape release()');
}

console.log('a poisoned recipe param never reaches a node');
{
  // Real `AudioParam` scheduling throws on a non-finite value, and `_out`
  // already guards positions for that reason. The same discipline applies to
  // the recipe: a bad number in a later layer must not be able to throw after
  // an earlier layer has already started.
  const a = makeAudio();
  const bad = [];
  for (const p of [{ value: NaN }, { value: Infinity }, { value: undefined }]) {
    const h = a.startSustained({ x: 0, y: 0, z: 0 }, {
      tones: [{ f0: 180, gain: 0.14 }, { f0: p.value, gain: p.value, detune: p.value }],
      attack: p.value,
    });
    bad.push(h);
  }
  ok(bad.every((h) => h.active), 'each voice survived its poisoned layer');
  ok(a.voices === 6, `both layers of all three voices are charged (saw ${a.voices})`);
  const ramps = a.ac.made.filter((n) => n.kind === 'gain').flatMap((n) => n.gain.ramps);
  ok(ramps.length > 0 && ramps.every(([v, t]) => Number.isFinite(v) && Number.isFinite(t)),
    'every scheduled ramp value and time is finite');
  const freqs = a.ac.made.filter((n) => n.kind === 'osc').flatMap((n) => n.frequency.sets);
  ok(freqs.every((v) => Number.isFinite(v) && v >= 1), 'every scheduled frequency is finite and audible');
  for (const h of bad) h.release();
  a.ac.endAll();
  ok(counters(a).join() === '0,0,0', 'and all of it came back');
}

console.log('a mid-construction throw strands nothing');
{
  // The leak this guards: sustained sources have no self-expiry, so a source
  // started before the throw would play forever on budget nothing can free.
  // Poisoned numbers are handled above, so this drives the residual case — a
  // node the context itself refuses to build — through the same unwind.
  const a = makeAudio();
  const before = counters(a);
  let built = 0;
  const realOsc = a.ac.createOscillator;
  a.ac.createOscillator = function () {
    if (++built === 3) throw new Error('context refused the node');
    return realOsc.call(this);
  };

  let threw = false;
  let h = null;
  try {
    h = a.startSustained({ x: 0, y: 0, z: 0 }, {
      tones: [{ f0: 100 }, { f0: 120 }, { f0: 140 }, { f0: 160 }],
    });
  } catch { threw = true; }

  ok(!threw, 'the throw did not escape into the caller');
  ok(h && !h.active, 'the caller gets an inert handle, not a half-built voice');

  const started = a.ac.sources();
  ok(started.length === 2, `two sources were started before the failure (saw ${started.length})`);
  ok(started.every((s) => s.stops.length === 1), 'every started source had a stop scheduled by the unwind');

  a.ac.endAll();
  ok(counters(a).join() === before.join(), 'every unit of budget the part-built voice took came back');

  // And the mixer is not poisoned for the next caller.
  a.ac.createOscillator = realOsc;
  const next = a.startSustained(null, { tones: [{ f0: 200 }] });
  ok(next.active, 'the next voice still starts');
  next.release();
  a.ac.endAll();
  ok(counters(a).join() === '0,0,0', 'and settles back to nothing');
}

console.log('move() repositions a placed voice');
{
  const a = makeAudio();
  const h = a.startSustained({ x: 1, y: 2, z: 3 }, { tones: [{ f0: 100 }] });
  const p = a.ac.made.find((n) => n.kind === 'panner');
  ok(p.positionX.value === 1 && p.positionZ.value === 3, 'placed where it was started');
  h.move({ x: 9, y: 8, z: 7 });
  ok(p.positionX.value === 9 && p.positionY.value === 8 && p.positionZ.value === 7, 'move() follows the source');
  h.release();
  h.move({ x: 0, y: 0, z: 0 });
  ok(p.positionX.value === 9, 'a released handle stops moving');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
