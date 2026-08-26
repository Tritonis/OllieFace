// tests/temper-pity.test.mjs
// Bounded pity for the first eligible Tempered craft (issue #223): repeated
// RNG denial of the missing half of a held Tempered recipe is bounded rather
// than open-ended, without touching #222's placement guarantee (pity only
// engages the NATURAL roll, tier === null) and without moving the shared
// `ctx.rng` stream by even one extra draw between the forced and unforced
// paths (the determinism constraint the issue is built on).
import { Items, TEMPER_PITY_BOUND } from '../src/systems/Items.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(over = {}) {
  const listeners = new Map();
  return {
    authority: true,
    seed: 4242,
    rng: new RNG(4242),
    time: 0,
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    ...over,
  };
}

function makeItems(ctx) {
  const items = new Items();
  ctx.player = ctx.player || { isPlayer: true, alive: true };
  items.init(ctx);
  return items;
}

console.log(`the pity bound is a small, named, positive constant (${TEMPER_PITY_BOUND})`);
{
  ok(Number.isInteger(TEMPER_PITY_BOUND) && TEMPER_PITY_BOUND >= 5 && TEMPER_PITY_BOUND <= 8,
    `TEMPER_PITY_BOUND is bounded in 5..8 (${TEMPER_PITY_BOUND})`);
}

console.log('blight pity: armed only once exactly one parent of a recipe is held, targets the missing blight parent');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);

  // Nothing held at all: not armed, natural rolls are untouched.
  ok(items._pityMissingParents().blight === null, 'no parent held: not armed for blight');

  items.give('quicksilver-vein', 1); // argent parent of tempered-capacitor
  ok(items._pityMissingParents().blight === 'arc-rot', 'holding only the argent parent arms pity on the missing blight, arc-rot');

  items.give('arc-rot', 1); // now both parents held
  ok(items._pityMissingParents().blight === null, 'once both parents are held, pity has nothing left to target');
}

console.log('blight pity: N-1 misses do not force, the Nth miss (counter reaching the bound) forces the very next roll');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('quicksilver-vein', 1); // arms pity on arc-rot

  // Boundary, white-box, and immune to which id the pool happens to pick:
  // drive the internal resolver directly with a naturalId that is NOT the
  // target, the exact shape rollItem() feeds it on a blight-tier roll.
  items._pity.blightMisses = TEMPER_PITY_BOUND - 1;
  const notForced = items._pityRollItem('blight', 'slag-ingot');
  ok(notForced === 'slag-ingot', `counter sitting at bound-1 (${TEMPER_PITY_BOUND - 1}) never forces on its own`);
  ok(items._pity.blightMisses === TEMPER_PITY_BOUND, 'and that miss carries the counter to the bound');

  // The NEXT roll must force, regardless of what tier or id it would have
  // naturally rolled.
  const forced = items._pityRollItem('common', 'cured-haunch');
  ok(forced === 'arc-rot', `counter at the bound forces the missing parent on the next roll, even off a non-blight tier (got ${forced})`);
  ok(items._pity.blightMisses === 0, 'forcing the parent resets the miss counter to zero');
}

console.log('blight pity: a lucky natural hit resets the counter without forcing anything');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('quicksilver-vein', 1);
  items._pity.blightMisses = TEMPER_PITY_BOUND - 2;

  // Bypass RNG luck entirely: call the internal resolver directly with a
  // natural id that IS the target, the same shape rollItem() feeds it.
  const resolved = items._pityRollItem('blight', 'arc-rot');
  ok(resolved === 'arc-rot', 'a natural hit is returned unchanged');
  ok(items._pity.blightMisses === 0, 'and it resets the counter — no debt carries into the next recipe');
}

console.log('blight pity: only a blight-TIER roll counts as a missed opportunity; other tiers never move the counter');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('quicksilver-vein', 1);
  items._pity.blightMisses = 0;
  for (let i = 0; i < 10; i++) items._pityRollItem('common', 'cured-haunch');
  ok(items._pity.blightMisses === 0, 'ten non-blight-tier rolls leave the counter untouched');
}

console.log('blight pity disarms permanently after the first successful temper this run');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('quicksilver-vein', 1);
  items.give('arc-rot', 1);
  ok(items._pityMissingParents().blight === null, 'sanity: both parents held, nothing to target yet anyway');

  items.temper('tempered-capacitor');
  ok(items._pity.disarmed === true, 'a successful temper disarms pity for the run');

  // Re-arm the ingredients for a SECOND recipe and prove pity stays off.
  items.give('unblemished-plate', 1); // argent parent of tempered-bulwark
  ok(items._pityMissingParents().blight === null, 'disarmed: a fresh half-held recipe is never targeted again this run');
  ok(items._pityRollItem('blight', 'slag-ingot') === 'slag-ingot', 'and the resolver is a pure passthrough once disarmed');
}

console.log('argent pity COMMIT: an assembled offer missing the needed argent parent is a miss, and forces on the bound');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('arc-rot', 1); // blight parent of tempered-capacitor -> arms on missing argent quicksilver-vein

  ok(items._pityMissingParents().argent === 'quicksilver-vein', 'armed on the missing argent parent');

  items._pity.argentMisses = TEMPER_PITY_BOUND - 1;
  const notForced = items.commitArgentPity(['unblemished-plate', 'chime-of-absolution', 'gorge-tooth']);
  ok(!notForced.includes('quicksilver-vein'), 'bound-1 misses do not force an injection');
  ok(items._pity.argentMisses === TEMPER_PITY_BOUND, 'and the miss is counted, reaching the bound');

  const forced = items.commitArgentPity(['unblemished-plate', 'chime-of-absolution', 'gorge-tooth']);
  ok(forced.includes('quicksilver-vein'), `the bound forces the missing argent parent into the offer (${forced})`);
  ok(forced.length === 3, 'the offer keeps its original size — a slot is replaced, not appended');
  ok(items._pity.argentMisses === 0, 'forcing resets the argent miss counter');
}

console.log('argent pity COMMIT: an offer that already contains the target resets the counter without forcing');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('arc-rot', 1);
  items._pity.argentMisses = TEMPER_PITY_BOUND - 2;
  const out = items.commitArgentPity(['quicksilver-vein', 'gorge-tooth', 'unblemished-plate']);
  ok(out.join(',') === 'quicksilver-vein,gorge-tooth,unblemished-plate', 'an offer already carrying the target is returned unchanged');
  ok(items._pity.argentMisses === 0, 'and the counter resets on the lucky arrival');
}

console.log('argent pity PEEK: reads the same decision as commit, but never mutates — issue #223 round 2');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('arc-rot', 1);

  // Below the bound: peek matches the plain list, and looking at it any
  // number of times moves nothing.
  items._pity.argentMisses = TEMPER_PITY_BOUND - 1;
  for (let i = 0; i < 50; i++) {
    const peeked = items.peekArgentPity(['unblemished-plate', 'chime-of-absolution', 'gorge-tooth']);
    if (peeked.includes('quicksilver-vein')) { ok(false, 'peek forced below the bound'); break; }
  }
  ok(items._pity.argentMisses === TEMPER_PITY_BOUND - 1, `fifty peeks below the bound leave the counter untouched (${items._pity.argentMisses})`);

  // At the bound: peek shows what commit WOULD do, over and over, still
  // without moving the counter — the exact fix for the walk-past-an-altar
  // drift (round 1's `_pityPreviewArgent` would have forced-and-reset on the
  // very first of these calls).
  items._pity.argentMisses = TEMPER_PITY_BOUND;
  const peek1 = items.peekArgentPity(['unblemished-plate', 'chime-of-absolution', 'gorge-tooth']);
  const peek2 = items.peekArgentPity(['unblemished-plate', 'chime-of-absolution', 'gorge-tooth']);
  ok(peek1.includes('quicksilver-vein') && peek2.includes('quicksilver-vein'),
    `peek shows the forced card at the bound, repeatably (${peek1}, ${peek2})`);
  ok(items._pity.argentMisses === TEMPER_PITY_BOUND, 'and neither peek moved the counter at all');

  // Only `commitArgentPity` actually spends it.
  const committed = items.commitArgentPity(['unblemished-plate', 'chime-of-absolution', 'gorge-tooth']);
  ok(committed.includes('quicksilver-vein'), 'the commit forces the same card the peek already showed');
  ok(items._pity.argentMisses === 0, 'and THIS is what resets the counter');
}

console.log('DETERMINISM: pity never changes how many draws rollItem takes off ctx.rng, forced or not');
{
  // Two independent Items instances on two independent RNGs seeded
  // identically. One is armed for blight pity and eventually forces; the
  // other never holds a parent and is never touched by pity. Both perform
  // the exact same sequence of rollItem calls; if pity consumed a different
  // number of draws on the forced path, the two RNG's internal state (`.s`)
  // would diverge and every roll AFTER the fork would disagree.
  const seed = 999331;
  const ctxA = makeCtx({ seed, rng: new RNG(seed) });
  const ctxB = makeCtx({ seed, rng: new RNG(seed) });
  const armed = makeItems(ctxA);
  const inert = makeItems(ctxB);
  armed.give('quicksilver-vein', 1); // arms pity toward arc-rot
  armed._pity.blightMisses = TEMPER_PITY_BOUND; // next natural blight-tier roll forces

  // Only 2 calls: the test never actually gives the forced id, so leaving
  // the target permanently un-held would re-arm and re-force again a few
  // rolls later, which is real and correct behaviour but not what this
  // probe is isolating — one forced roll, then one ordinary roll right
  // after it, is enough to prove the draws stay lockstep either way.
  const seqArmed = [armed.rollItem(null, 'blight'), armed.rollItem(null, 'blight')];
  const seqInert = [inert.rollItem(null, 'blight'), inert.rollItem(null, 'blight')];
  ok(seqArmed[0] === 'arc-rot', 'sanity: the armed instance really did force on the first roll');
  ok(ctxA.rng.s === ctxB.rng.s, `identical seeds stay bit-identical after both rolls despite one forced draw (${ctxA.rng.s} vs ${ctxB.rng.s})`);

  // And the two sequences differ ONLY at the forced index, proving the fork
  // is a substitution of the returned id and not a skipped/extra draw.
  let divergences = 0;
  for (let i = 0; i < seqArmed.length; i++) if (seqArmed[i] !== seqInert[i]) divergences++;
  ok(divergences === 1, `exactly one index diverges between the armed and inert sequences (${divergences})`);
}

console.log('DETERMINISM: previewArgent is pure again (issue #223 round 2) — pity never touches ctx.rng, and never mutates from previewArgent itself');
{
  const ctx = makeCtx();
  const items = makeItems(ctx);
  items.give('arc-rot', 1);
  items._pity.argentMisses = TEMPER_PITY_BOUND;
  const before = ctx.rng.s;
  const a = items.previewArgent(3, 0);
  const b = items.previewArgent(3, 0);
  ok(ctx.rng.s === before, 'previewArgent never advances ctx.rng');
  ok(a.join(',') === b.join(','), 'and repeated calls at the SAME key agree exactly — no pity state leaks into it any more');
  ok(items._pity.argentMisses === TEMPER_PITY_BOUND, 'two calls to previewArgent itself never move the pity counter at all');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
