/**
 * The sustained move-speed knee (#188).
 *
 * Two things are locked here, and they pull against each other on purpose:
 * the curve must do *nothing* to an ordinary build (identity below the knee,
 * exactly, not approximately), and it must bend the pathological stack while
 * still paying something for every extra copy.
 *
 * The properties are checked against `Items.stats()` through real item counts
 * wherever a whole build is the claim, so a curve that is correct in isolation
 * but wired in at the wrong point in `stats()` — before a buff multiplies, or
 * after the clamps — fails here rather than passing.
 *
 * Each property closes with a mutation check: the same assertion re-run against
 * a deliberately wrong curve, which must come out false. A guard that cannot
 * fail is not a guard.
 */
import { Items, softenMove, MOVE_KNEE, MOVE_SPAN } from '../src/systems/Items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  return {
    authority: true,
    rng: { next: () => 0.5, range: (a, b) => a + (b - a) * 0.5, pick: (arr) => arr[0] },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
}

const BASE = {
  maxHealth: 110, healthRegen: 1, moveSpeed: 7, attackSpeed: 1, damage: 12,
  critChance: 0.01, critMult: 2, armor: 0, cooldownMult: 1, jumpCount: 1,
};

function speedWith(build, buffs = []) {
  const ctx = makeCtx();
  const items = new Items();
  items.init(ctx);
  for (const [id, n] of build) items.give(id, n);
  for (const [name, mag] of buffs) items.addBuff(name, 5, 1, mag);
  return items.stats({ ...BASE }).moveSpeed;
}

const hoof = (n) => speedWith(n > 0 ? [['cloven-hoof', n]] : []);

// A wrong-but-plausible curve: soft-caps from 1.0 instead of from the knee.
// Every "below the knee nothing changes" claim must reject it.
const noKnee = (b, s) => {
  const e = s / b - 1;
  return b * (1 + e / (1 + e / MOVE_SPAN));
};
// A hard cap: the shape the design explicitly refused. Every "still monotone,
// still pays" claim must reject it.
const hardCap = (b, s) => Math.min(s, b * (MOVE_KNEE + MOVE_SPAN));

console.log('Identity below the knee');
{
  // Three of any movement common, and every mix of them, must be untouched.
  // `raw` is the product the item `stat` functions would have produced with no
  // curve at all, written out independently of the implementation.
  const builds = [
    [[['cloven-hoof', 1]], 1 + 0.14],
    [[['cloven-hoof', 2]], 1 + 0.28],
    [[['cloven-hoof', 3]], 1 + 0.42],
    [[['runners-chalk', 3]], 1 + 0.15],
    [[['cloven-hoof', 2], ['runners-chalk', 1]], (1 + 0.28) * (1 + 0.05)],
    [[['runners-chalk', 6]], 1 + 0.30],
  ];
  for (const [b, raw] of builds) {
    const got = speedWith(b);
    ok(got === BASE.moveSpeed * raw,
      `${JSON.stringify(b)} is bit-for-bit unchanged (${got.toFixed(4)} m/s)`);
    ok(got <= BASE.moveSpeed * MOVE_KNEE + 1e-12,
      `${JSON.stringify(b)} stays under the knee`);
  }

  ok(softenMove(7, 7) === 7, 'zero items is bit-for-bit identity');
  ok(softenMove(7, 7 * 1.42) === 7 * 1.42, 'three Cloven Hoof is bit-for-bit identity');
  ok(noKnee(7, 7 * 1.42) !== 7 * 1.42, 'MUTATION: a curve without a knee would move three Hoof');

  // A gain-only build under the knee, with a cost on top, must come out at the
  // old arithmetic exactly: the curve is identity on the gains, and the cost
  // multiplies the finished number.
  const slag = 1 / (1 + 0.20);   // hyperbolicMult(0.20, 1), the shipped expression
  const hoof3Slag = speedWith([['cloven-hoof', 3], ['slag-ingot', 1]]);
  ok(hoof3Slag === hoof(3) * slag,
    `three Hoof plus a Slag Ingot is bit-for-bit the old arithmetic (${hoof3Slag.toFixed(5)})`);
}

console.log('\nCosts keep their whole bite, however deep the stack');
{
  // The case the review constructed. Above the knee, the penalty must still
  // remove exactly its advertised fraction of the curved speed — the surrounding
  // stack must not pay it off.
  const slag = 1 / (1 + 0.20);
  for (const n of [8, 12, 20, 40]) {
    const clean = hoof(n);
    const cursed = speedWith([['cloven-hoof', n], ['slag-ingot', 1]]);
    const bite = clean - cursed;
    const want = clean * (1 - slag);
    ok(Math.abs(bite - want) < 1e-12,
      `${n} Hoof + Slag: bite ${bite.toFixed(4)} m/s is the full ${((1 - slag) * 100).toFixed(2)}% of ${clean.toFixed(4)}`);
  }

  // MUTATION: fold the cost back into the aggregate — the shape that shipped
  // first — and the bite at eight Hoof collapses to well under its advertised
  // fraction. The measured survival there was 57%.
  const folded = (n) => softenMove(BASE.moveSpeed, BASE.moveSpeed * (1 + 0.14 * n) * slag);
  const foldedBite = hoof(8) - folded(8);
  const foldedWant = hoof(8) * (1 - slag);
  ok(foldedBite < foldedWant * 0.7,
    `MUTATION: folding the cost into the aggregate refunds most of it (${foldedBite.toFixed(4)} vs ${foldedWant.toFixed(4)} m/s)`);

  // And below the knee the two arrangements agree, which is why the first cut
  // looked correct: there is nothing above the knee for the curve to compress.
  ok(Math.abs((hoof(2) - speedWith([['cloven-hoof', 2], ['slag-ingot', 1]]))
    - (BASE.moveSpeed * 1.28 * (1 - slag))) < 1e-12,
    'below the knee the split makes no difference at all');
}

console.log('\nMonotone increasing, forever');
{
  let mono = true, capped = false, capMono = true;
  let prev = hoof(0);
  for (let n = 1; n <= 40; n++) {
    const cur = hoof(n);
    if (!(cur > prev)) mono = false;
    if (!(hardCap(BASE.moveSpeed, BASE.moveSpeed * (1 + 0.14 * n))
      > hardCap(BASE.moveSpeed, BASE.moveSpeed * (1 + 0.14 * (n - 1))))) capMono = false;
    prev = cur;
  }
  ok(mono, 'every extra Cloven Hoof, out to 40, is strictly faster than the last');
  ok(!capMono, 'MUTATION: a hard cap stops being strictly increasing');

  // No dead pickups: the 40th stack is still worth a visible amount.
  const marginal40 = hoof(40) - hoof(39);
  ok(marginal40 > 0.01, `the 40th Hoof is still worth ${marginal40.toFixed(3)} m/s`);
  capped = hardCap(BASE.moveSpeed, BASE.moveSpeed * (1 + 0.14 * 40))
    - hardCap(BASE.moveSpeed, BASE.moveSpeed * (1 + 0.14 * 39));
  ok(!(capped > 0.01), 'MUTATION: under a hard cap the 40th Hoof is a dead pickup');
}

console.log('\nDiminishing above the knee');
{
  let falling = true;
  let prevMarginal = Infinity;
  for (let n = 5; n <= 20; n++) {
    const m = hoof(n) - hoof(n - 1);
    if (!(m < prevMarginal)) falling = false;
    prevMarginal = m;
  }
  ok(falling, 'past the knee each Cloven Hoof is worth strictly less than the one before');

  // ...and below it, each one is worth exactly as much as the last (linear).
  const m2 = hoof(2) - hoof(1);
  const m3 = hoof(3) - hoof(2);
  ok(Math.abs(m2 - m3) < 1e-12, 'below the knee the stacking is still flatly linear');

  const flat = (n) => BASE.moveSpeed * (1 + 0.14 * n);
  ok(!((flat(20) - flat(19)) < (flat(19) - flat(18))),
    'MUTATION: the uncurved linear stack has no diminishing returns to find');
}

console.log('\nThe numbers the design was chosen on (base 7.0 m/s)');
{
  const table = [[0, 7.00], [2, 8.96], [4, 10.87], [8, 13.39], [12, 14.88]];
  for (const [n, want] of table) {
    const got = hoof(n);
    ok(Math.abs(got - want) < 0.01, `${n} Cloven Hoof -> ${got.toFixed(2)} m/s (design: ${want.toFixed(2)})`);
  }
  ok(hoof(8) < BASE.moveSpeed * (1 + 0.14 * 8) - 1,
    'eight Hoof is more than 1 m/s slower than it used to be');
  ok(hoof(4) > BASE.moveSpeed * (1 + 0.14 * 4) - 0.1,
    'four Hoof is barely touched');
}

console.log('\nThe aggregate is the input, not the item');
{
  // Order-independence: the same inventory reached two ways is the same speed.
  // The tolerance is one ULP, and it is the *item loop's* float associativity,
  // not the curve's — `softenMove` is a pure function of the finished
  // aggregate, so it cannot introduce order dependence of its own. A per-item
  // curve, which is what this check exists to forbid, would separate these two
  // by whole percent.
  const a = speedWith([['cloven-hoof', 6], ['runners-chalk', 4]]);
  const b = speedWith([['runners-chalk', 4], ['cloven-hoof', 6]]);
  ok(Math.abs(a - b) < 1e-12, `pickup order does not change the result (${a}, ${b})`);

  // MUTATION: the per-item curve this design rejected, applied to the same two
  // orders, is visibly order-dependent.
  const perItem = (order) => {
    let m = 1;
    for (const [mult] of order) m *= softenMove(1, m * mult) / m;
    return m;
  };
  const p1 = perItem([[1.84], [1.20]]);
  const p2 = perItem([[1.20], [1.84]]);
  ok(Math.abs(p1 - p2) > 1e-6, 'MUTATION: a per-item curve would make order matter');

  // A single Mercury Anklet must still land as a shock: 1.50 is a hair over the
  // knee, so it keeps essentially all of its +50%.
  const anklet = speedWith([['mercury-anklet', 1]]);
  const ankletRaw = BASE.moveSpeed * 1.5;
  ok(ankletRaw - anklet < 0.05, `one Mercury Anklet keeps its jolt (${anklet.toFixed(3)} vs ${ankletRaw.toFixed(3)})`);

  // Bloodied Spurs' window enters the aggregate: on a bare build it is fully
  // linear, and it is only trimmed once it lands on a stack already past the knee.
  const bare = speedWith([]);
  const bareSpurs = speedWith([], [['quickfoot', 0.2]]);
  ok(Math.abs(bareSpurs - bare * 1.2) < 1e-12, 'a Spurs window on a bare build is untouched');

  const stacked = speedWith([['cloven-hoof', 8]]);
  const stackedSpurs = speedWith([['cloven-hoof', 8]], [['quickfoot', 0.2]]);
  ok(stackedSpurs > stacked, 'a Spurs window on a stacked build still speeds the player up');
  ok(stackedSpurs < stacked * 1.2, 'but it is degraded, because the aggregate is already past the knee');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
