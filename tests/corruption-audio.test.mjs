import { VOID_LAYER, voidLayerGain } from '../src/systems/Audio.js';

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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
