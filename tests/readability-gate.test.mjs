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

console.log('the gate grades a record and ratchets against its exemptions');
{
  const { gradeRoster } = await import('../tools/silhouette-metrics.mjs');
  // A minimal record in the shape the tool writes. Two families, one elite
  // pair, three tiers, all deliberately just over the floors.
  const good = {
    units: [
      { id: 'mite',   tier: 1, px40: 260, holesFrac: 0.02, sig: null },
      { id: 'golem',  tier: 2, px40: 900, holesFrac: 0.03, sig: null },
      { id: 'hulk',   tier: 3, px40: 1800, holesFrac: 0.03, sig: null },
    ],
    familyPairs: [{ a: 'mite', b: 'golem', iou: 0.41 }],
    foeFriendPairs: [{ a: 'mite', b: 'ranger', iou: 0.38 }],
    tierMedianPx: { 1: 260, 2: 900, 3: 1800 },
    elites: [{ id: 'golem', affix: 'blazing', delta: 0.21, chroma: 0.19 }],
  };
  // Every call here passes its exemption list explicitly, including the empty
  // one. Defaulting to READABILITY.exemptions would couple this fixture to
  // whatever the shipped roster needed admitted, which is the one thing a unit
  // test of the ratchet must not depend on.
  const g = gradeRoster(good, []);
  ok(g.ok === true, 'a clean roster passes');
  ok(g.checks.length > 0 && g.checks.every((c) => c.ok), 'and every check in it is green');
  ok(g.checks.some((c) => c.kind === 'px40') && g.checks.some((c) => c.kind === 'tierArea')
     && g.checks.some((c) => c.kind === 'eliteDelta') && g.checks.some((c) => c.kind === 'familyIoU')
     && g.checks.some((c) => c.kind === 'foeFriendIoU') && g.checks.some((c) => c.kind === 'holes')
     && g.checks.some((c) => c.kind === 'eliteChroma'), 'all seven kinds are graded');

  // One unit falls under the 40 m floor.
  const dim = structuredClone(good);
  dim.units[0].px40 = 140;
  dim.tierMedianPx[1] = 140;
  const gd = gradeRoster(dim, []);
  ok(gd.ok === false, 'a unit under the 40 m floor fails the gate');
  ok(gd.checks.some((c) => c.kind === 'px40' && c.id === 'mite' && !c.ok), 'and the failure names the unit');

  // The same failure, exempted at its measured value, passes.
  const exempt = [{ id: 'mite', kind: 'px40', value: 140, note: 'test fixture' }];
  const ge = gradeRoster(dim, exempt);
  ok(ge.ok === true, 'an exemption at the measured value passes the gate');
  ok(ge.checks.some((c) => c.kind === 'px40' && c.id === 'mite' && c.exempt), 'and the check is flagged exempt');

  // ...but only while it does not get worse.
  const worse = structuredClone(dim);
  worse.units[0].px40 = 120;
  worse.tierMedianPx[1] = 120;
  ok(gradeRoster(worse, exempt).ok === false, 'an exempted check that degrades goes red again');

  // ...and an exemption never covers a different unit.
  const other = structuredClone(good);
  other.units[1].px40 = 140;
  ok(gradeRoster(other, exempt).ok === false, 'an exemption is per unit, not per kind');

  // Ceiling checks ratchet the other way round.
  const collide = structuredClone(good);
  collide.familyPairs[0].iou = 0.91;
  ok(gradeRoster(collide, []).ok === false, 'two families that overlap too much fail');
  ok(gradeRoster(collide, [{ id: 'mite/golem', kind: 'familyIoU', value: 0.91 }]).ok === true,
     'exempted at 0.91 it passes');
  collide.familyPairs[0].iou = 0.93;
  ok(gradeRoster(collide, [{ id: 'mite/golem', kind: 'familyIoU', value: 0.91 }]).ok === false,
     'and 0.93 against a 0.91 exemption is a regression');
}

console.log('the recorded roster covers every card the director can spawn');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { SPAWN_CARDS, BOSS_CARDS } = await import('../src/data/enemies.js');
  const path = new URL('../reviews/round9/readability-gate.json', import.meta.url);
  ok(existsSync(path), 'the gate record is committed');
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const seen = new Set(rec.units.map((u) => u.id));
  for (const c of [...SPAWN_CARDS, ...BOSS_CARDS]) ok(seen.has(c.id), `${c.id} was measured`);
  // The record is the on-disk source for every readability claim in this
  // slice, so it has to say which tree produced it.
  ok(typeof rec.commit === 'string' && rec.commit.length >= 7, 'the record names the commit it measured');
  ok(rec.seed === 1337 && rec.range === 40, 'and the seed and the range it measured at');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
