import { Audio, VOID_LAYER, voidLayerGain } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

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

  // The layer hangs off `master`, not the ambient bus, so the Music slider
  // cannot silence world state. That makes the curve's absolute values load
  // bearing: they are the original ambient-bus figures times that bus's own
  // 0.4, which is what keeps the reroute loudness-neutral at default Music.
  // If the routing ever moves back onto `ambient`, these have to move with it.
  const AMBIENT_BUS = 0.4;
  ok(Math.abs(voidLayerGain(2) - 0.05 * AMBIENT_BUS) < 1e-9, 'band 2 priced against master');
  ok(Math.abs(voidLayerGain(3) - 0.11 * AMBIENT_BUS) < 1e-9, 'band 3 priced against master');
  ok(Math.abs(voidLayerGain(4) - 0.18 * AMBIENT_BUS) < 1e-9, 'band 4 priced against master');
}

console.log('void layer routing: master, not the music-owned ambient bus');
{
  // The curve above is only half the claim; the other half is a wire, and a
  // wire is exactly the kind of thing a pure-function test cannot see. This
  // runs the real `_buildAmbient` against a stub graph and reads the edges.
  const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {} });
  const node = (kind) => {
    const n = {
      kind, out: [], gain: param(), frequency: param(), Q: param(), detune: param(),
      connect(d) { n.out.push(d); return d; }, disconnect() {}, start() {}, stop() {},
    };
    return n;
  };
  const ac = {
    currentTime: 0, sampleRate: 48000,
    createGain: () => node('gain'), createBiquadFilter: () => node('filter'),
    createOscillator: () => node('osc'), createBufferSource: () => node('src'),
  };

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
