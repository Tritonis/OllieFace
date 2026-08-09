// tests/readability-gate.test.mjs
//
// The node-only half of the readability gate. `tools/silhouette.mjs` needs a
// GPU, a browser and about a minute; the arithmetic it runs on the masks it
// gets back needs none of those, and that arithmetic is where a gate silently
// stops measuring. So the math lives in tools/silhouette-metrics.mjs and is
// pinned here against masks this file draws itself.
import { maskReader, measureMask, shapeIoU, READABILITY } from '../tools/silhouette-metrics.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const W = 32, H = 32;

/** Draw a mask with a predicate and pack it exactly as the in-page code does. */
function synth(fn, w = W, h = H) {
  const bits = new Uint8Array(Math.ceil(w * h / 8));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (fn(x, y)) { const i = y * w + x; bits[i >> 3] |= 1 << (i & 7); }
  }
  return Buffer.from(bits).toString('base64');
}

console.log('mask reader round-trips the packing the renderer uses');
{
  const b64 = synth((x, y) => x === 3 && y === 7);
  const get = maskReader(b64, W);
  ok(get(3, 7) === 1, 'the set pixel reads back set');
  ok(get(7, 3) === 0, 'its transpose does not — row-major, not column-major');
  ok(get(0, 0) === 0 && get(W - 1, H - 1) === 0, 'corners clear');
}

console.log('measureMask on a solid 8x16 block');
{
  const m = measureMask(synth((x, y) => x >= 8 && x < 16 && y >= 4 && y < 20), W, H);
  ok(m.x0 === 8 && m.y0 === 4, 'bbox origin');
  ok(m.bw === 8 && m.bh === 16, 'bbox extent');
  ok(m.area === 128, 'area');
  ok(Math.abs(m.fill - 1) < 1e-9, 'a solid block fills its own bbox');
  ok(Math.abs(m.aspect - 0.5) < 1e-9, 'aspect is width over height');
  ok(Math.abs(m.cx - 0.5) < 0.05 && Math.abs(m.cy - 0.5) < 0.05, 'centroid at the middle');
  ok(m.holes === 0, 'no negative space');
  ok(m.bands.length === 10, 'ten bands');
  ok(m.bands.every((b) => Math.abs(b.w - 1) < 1e-9), 'every band spans the full width');
  ok(m.bands.every((b) => Math.abs(b.runs - 1) < 1e-9), 'every scanline is one solid run');
}

console.log('measureMask sees daylight through an outline');
{
  // A ring: 16x16 outer, 8x8 hole. The hole is the thing a blob does not have.
  const outer = (x, y) => x >= 8 && x < 24 && y >= 8 && y < 24;
  const hole = (x, y) => x >= 12 && x < 20 && y >= 12 && y < 20;
  const m = measureMask(synth((x, y) => outer(x, y) && !hole(x, y)), W, H);
  ok(m.holes === 64, 'the enclosed 8x8 counts as negative space');
  ok(m.bands.some((b) => b.runs > 1.5), 'the waist scanlines read as two separate runs');
  ok(m.fill < 0.8, 'fill is below solid');
}

console.log('measureMask survives an empty mask without throwing');
{
  const m = measureMask(synth(() => false), W, H);
  ok(m.area === 0 && m.bw === 0 && m.bh === 0, 'zeroed bbox');
  ok(m.bands.length === 10 && m.bands.every((b) => b.w === 0), 'ten zeroed bands');
  ok(m.sig.length === 64 * 64 && m.sig.every((v) => v === 0), 'zeroed signature');
  ok(m.holes === 0 && m.fill === 0 && m.aspect === 0, 'no NaN anywhere');
}

console.log('shapeIoU is scale-blind, which is the whole point of the signature');
{
  const small = measureMask(synth((x, y) => x >= 14 && x < 18 && y >= 14 && y < 18), W, H);
  const big = measureMask(synth((x, y) => x >= 4 && x < 28 && y >= 4 && y < 28), W, H);
  ok(shapeIoU(small.sig, big.sig) > 0.99, 'a square is a square at any size');
  const bar = measureMask(synth((x, y) => y >= 14 && y < 18 && x >= 2 && x < 30), W, H);
  ok(shapeIoU(small.sig, bar.sig) > 0.99, 'bbox normalisation also flattens aspect — IoU alone cannot see it');
  const cross = measureMask((() => {
    const f = (x, y) => (x >= 14 && x < 18) || (y >= 14 && y < 18);
    return synth(f);
  })(), W, H);
  ok(shapeIoU(small.sig, cross.sig) < 0.6, 'a plus is not a square');
  ok(shapeIoU(new Uint8Array(4096), new Uint8Array(4096)) === 0, 'empty against empty is zero, not NaN');
}

console.log('thresholds are exported and ordered');
{
  ok(typeof READABILITY === 'object' && READABILITY !== null, 'READABILITY exported');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
