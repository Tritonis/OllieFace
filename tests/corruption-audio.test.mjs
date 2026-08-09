import { Audio, VOID_LAYER, voidLayerGain, BAND_STING_WINDOW } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// A recording stub graph. Every node remembers what it was connected to, and
// the context remembers every node it made, which is what lets a test ask both
// "is this wired the way the mix assumes" and "did anything start playing".
const param = () => ({
  value: 0,
  setTargetAtTime() {}, setValueAtTime() {}, cancelScheduledValues() {},
  linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
});
const node = (kind) => {
  const n = {
    kind, out: [], gain: param(), frequency: param(), Q: param(), detune: param(),
    connect(d) { n.out.push(d); return d; }, disconnect() {}, start() {}, stop() {},
  };
  return n;
};
function makeAc() {
  const made = [];
  const make = (kind) => { const n = node(kind); made.push(n); return n; };
  const ac = {
    currentTime: 0, sampleRate: 48000, made,
    createGain: () => make('gain'), createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'), createBufferSource: () => make('src'),
    oscCount: () => made.filter((n) => n.kind === 'osc').length,
  };
  return ac;
}
function makeCtx() {
  const listeners = new Map();
  return {
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
}

console.log('void layer gain curve');
{
  ok(VOID_LAYER.length === 5, 'five bands');
  ok(voidLayerGain(0) === 0 && voidLayerGain(1) === 0, 'silent through band 1 — the audio must not spend itself early');
  ok(voidLayerGain(2) > 0, 'audible from band 2');
  ok(voidLayerGain(3) > voidLayerGain(2) && voidLayerGain(4) > voidLayerGain(3), 'monotonic');
  ok(voidLayerGain(99) === VOID_LAYER[4], 'clamps high');
  ok(voidLayerGain(-3) === 0, 'clamps low');
  ok(voidLayerGain(NaN) === 0, 'non-finite reads as band 0');
  ok(voidLayerGain(2.7) === VOID_LAYER[2], 'fractional bands floor');
}

console.log('void layer curve, re-priced against master with tones in-band');
{
  // The old figures were the ambient-bus values folded through that bus's 0.4,
  // which made the layer loudness-neutral against a routing change and
  // inaudible against the combat mix — the 2026-08-08 playtest heard nothing.
  // These are absolute master-bus numbers, chosen against the mix floor.
  ok(VOID_LAYER.length === 5, 'five bands');
  ok(voidLayerGain(0) === 0 && voidLayerGain(1) === 0, 'silent through band 1');
  ok(voidLayerGain(2) === 0.05 && voidLayerGain(3) === 0.10 && voidLayerGain(4) === 0.16, 'audible-at-the-mix-floor values');
}

console.log('void layer routing: master, not the music-owned ambient bus');
{
  // The curve above is only half the claim; the other half is a wire, and a
  // wire is exactly the kind of thing a pure-function test cannot see. This
  // runs the real `_buildAmbient` against a stub graph and reads the edges.
  const ac = makeAc();

  const a = new Audio();
  a.ac = ac;
  a.master = node('master');
  a.ambient = node('ambient');
  a.noiseBuf = {};
  a._buildAmbient();

  ok(!!a.voidGain, 'the void layer was built');
  ok(a.voidGain.out.includes(a.master), 'voidGain feeds master directly');
  ok(!a.voidGain.out.includes(a.ambient), 'voidGain does not touch the ambient bus the Music slider scales');
  // The rest of the bed still belongs to ambient — the reroute is surgical.
  ok(!!a.droneGain && a.droneGain.out.includes(a.ambient), 'the drone stays on ambient');
}

console.log('void layer topology: the tritone pair bypasses the noise bandpass');
{
  // The playtest root cause. The bandpass sits at 2400 Hz Q1.4; the tones are
  // 523 and 740 Hz, roughly -25 dB through it. The identity of the layer was
  // being filtered out by the layer's own filter, so no gain value could have
  // rescued it. The filter belongs to the noise bed and nothing else.
  const ac = makeAc();
  const a = new Audio();
  a.ac = ac;
  a.master = node('master');
  a.ambient = node('ambient');
  a.noiseBuf = {};
  a._buildAmbient();

  const voidFilter = ac.made.find((n) => n.kind === 'filter' && n.out.includes(a.voidGain) && n.frequency.value === 2400);
  ok(!!voidFilter, 'the void bandpass exists and feeds voidGain');

  const tones = ac.made.filter((n) => n.kind === 'osc' && (n.frequency.value === 523.25 || n.frequency.value === 739.99));
  ok(tones.length === 2, 'both tritone oscillators are built');
  for (const o of tones) {
    const g = o.out[0];
    ok(!!g && g.kind === 'gain', `tone ${o.frequency.value} runs through its own gain`);
    ok(!!g && g.out.includes(a.voidGain), `tone ${o.frequency.value} reaches voidGain directly`);
    ok(!!g && !g.out.includes(voidFilter), `tone ${o.frequency.value} does not pass the 2400 Hz bandpass`);
  }

  const vnoise = ac.made.find((n) => n.kind === 'src' && n.out.length);
  const vng = vnoise?.out[0];
  ok(!!vng && vng.out.includes(voidFilter), 'the noise bed still goes through the bandpass');
}

console.log('a band crossing announces itself');
{
  // `init` registers the page-gesture unlock listeners on the global.
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};

  const ac = makeAc();
  const ctx = makeCtx();
  const a = new Audio();
  a.ac = ac;
  a.master = node('master');
  a.sfx = node('sfx');
  a.init(ctx);

  const before = ac.oscCount();
  ctx.events.emit('corruptionBand', { band: 2, prev: 1 });
  const afterUp = ac.oscCount();
  ok(afterUp > before, 'an ascending crossing plays a sting');

  // A threshold the world is sitting on can be crossed twice in a frame (a font
  // bleed and a Maw feed either side of it). One announcement, not four.
  ctx.events.emit('corruptionBand', { band: 3, prev: 2 });
  ok(ac.oscCount() === afterUp, '_stingReady holds off a second sting in the same instant');

  // The window is an exported dial, not a literal, and it is deliberately blunt:
  // it suppresses genuinely distinct crossings too, so screen and gauge announce
  // twice where the ears announce once. See BAND_STING_WINDOW's comment.
  ok(BAND_STING_WINDOW === 1.6, 'the sting guard is a tuned, exported constant');
  ac.currentTime = BAND_STING_WINDOW - 0.01;
  ctx.events.emit('corruptionBand', { band: 4, prev: 3 });
  ok(ac.oscCount() === afterUp, 'a real crossing inside the window is still suppressed');
  ac.currentTime = BAND_STING_WINDOW + 0.01;
  ctx.events.emit('corruptionBand', { band: 3, prev: 4 });
  ok(ac.oscCount() > afterUp, 'and the guard opens exactly one window after the sting');

  ac.currentTime = 10;
  ctx.events.emit('corruptionBand', { band: 2, prev: 3 });
  ok(ac.oscCount() > afterUp, 'a descending crossing stings once the guard has expired');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
