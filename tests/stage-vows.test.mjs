/**
 * Stage Vows — purity's proactive verb (issue #177).
 *
 * The audit's finding was that the clean route had no verbs, only refusals, and
 * that paying commitment for a refusal turns restraint into a free tap. A Vow
 * is the answer: a promise made in advance, with a condition that can be met or
 * violated by conduct, and a payout that mints toward an Argent Mote.
 *
 * Three properties carry the whole system, and each guard below is written so
 * that it CAN fail — the payout arm blinds the reward and asserts the ledger
 * stops moving, the restraint arm plants the violation, and the determinism arm
 * re-derives the selection from a deliberately different stream and asserts the
 * answers diverge. A guard that only ever sees the passing case is the defect
 * shape this repo keeps finding; these do not have that shape.
 */
import { readFileSync } from 'node:fs';
import { Corruption } from '../src/systems/Corruption.js';
import { Vows } from '../src/systems/Vows.js';
import { VOWS, VOW_WARD, VOW_BY_ID, selectVow } from '../src/data/vows.js';
import { weightOf, CAPSTONE, pureCapstoneEligible, alignmentOf } from '../src/data/alignment.js';
import { MOTE } from '../src/data/bandBoons.js';
import { RNG } from '../src/core/MathUtil.js';
import { VOIDTOUCHED } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(seed = 12345) {
  const l = new Map();
  const ctx = {
    authority: true,
    seed,
    player: { isPlayer: true },
    events: {
      emit(n, p) { for (const fn of [...(l.get(n) || [])]) fn(p); },
      on(n, fn) { if (!l.has(n)) l.set(n, []); l.get(n).push(fn); return () => {}; },
    },
  };
  const cor = new Corruption();
  cor.init(ctx);
  const vows = new Vows();
  vows.init(ctx);
  return { ctx, cor, vows };
}

/** The first stage index at which this seed offers `id`. Uses the real selector. */
function stageOffering(seed, id) {
  for (let i = 0; i < 64; i++) if (selectVow(seed, i).id === id) return i;
  throw new Error(`seed ${seed} never offers ${id}`);
}

/** A victim the real `isVoidtouched` accepts, built off the same affix table. */
const hollowed = () => ({ elite: true, affix: VOIDTOUCHED.affix });

console.log('the table itself covers the three kinds of conduct the ticket asked for');
{
  const kinds = new Set(VOWS.map((v) => v.kind));
  ok(VOWS.length >= 3 && VOWS.length <= 5, `three to five vows (${VOWS.length})`);
  ok(kinds.has('combat') && kinds.has('restraint') && kinds.has('timing'),
    `combat, restraint and timing are all present (${[...kinds].join(', ')})`);
  ok(new Set(VOWS.map((v) => v.id)).size === VOWS.length, 'ids are unique');
  for (const v of VOWS) {
    ok(typeof v.describe(v) === 'string' && v.describe(v).length > 0,
      `${v.id} describes itself to the player`);
    ok(Array.isArray(v.events) && v.events.length > 0, `${v.id} names the events it watches`);
  }
}

console.log('\n-- (a) a kept vow actually moves the warding purse and the ledger --');
{
  // Driven all the way through the real path: the combat vow is selected by the
  // real selector, the kills arrive as real `kill` events with victims the real
  // `isVoidtouched` accepts, and nothing here calls `commit` or `ward` by hand.
  const seed = 999;
  const stage = stageOffering(seed, 'seal-the-hollowed');
  const { ctx, cor } = makeCtx(seed);
  ctx.events.emit('stageStart', { index: stage });

  const target = VOW_BY_ID['seal-the-hollowed'].target;
  ok(cor.warded === 0 && cor.ledger.pure === 0, 'the run starts owing nothing and holding nothing');
  for (let i = 0; i < target - 1; i++) ctx.events.emit('kill', { victim: hollowed(), source: ctx.player });
  ok(cor.warded === 0, `short of the target the vow has paid nothing (${cor.warded})`);

  ctx.events.emit('kill', { victim: hollowed(), source: ctx.player });
  ok(cor.warded === VOW_WARD, `the kept vow wards ${VOW_WARD} (${cor.warded})`);
  // Both weights, and they are separately identifiable: the promise and the
  // points it returned are two commitments, the same split `salvaged` uses.
  const want = weightOf('vowKept', 1) + weightOf('warded', VOW_WARD);
  ok(Math.abs(cor.ledger.pure - want) < 1e-9,
    `and commits ${want} pure — vowKept plus the warding (${cor.ledger.pure})`);
  ok(cor.ledger.corrupt === 0, 'and nothing at all to the corrupt side');
  ok(cor.history({ source: 'vowKept' }).length === 1, 'one vowKept entry in the route history');

  // The world is untouched. A vow does not scrub corruption; it earns standing.
  // This is the property `bleed` could not have given us — a bleed clamps to
  // the world, so a spotless run would have been paid nothing.
  ok(cor.world === 0, 'the world is exactly where it was — no corruption was removed');

  // BLINDED ARM. Take the payout away and the guard above must go red. Without
  // this the assertions are compatible with a system that pays nothing and a
  // ledger that was already moving for some other reason.
  {
    const b = makeCtx(seed);
    b.cor.ward = () => 0;
    const realCommit = b.cor.commit.bind(b.cor);
    b.cor.commit = (source, amount) => (source === 'vowKept' ? 0 : realCommit(source, amount));
    b.ctx.events.emit('stageStart', { index: stage });
    for (let i = 0; i < target; i++) b.ctx.events.emit('kill', { victim: hollowed(), source: b.ctx.player });
    ok(b.cor.warded === 0 && b.cor.ledger.pure === 0,
      'blinding the payout leaves the purse and the ledger flat — the arm above can fail');
  }
}

console.log('\n-- three kept vows are a mote and the pure capstone, without ever descending --');
{
  const seed = 999;
  const stage = stageOffering(seed, 'seal-the-hollowed');
  const { ctx, cor } = makeCtx(seed);
  const target = VOW_BY_ID['seal-the-hollowed'].target;
  // The same stage index three times: the scope is what the vow is measured
  // against, and re-entering it is the cheapest way to say "three kept vows".
  for (let n = 0; n < 3; n++) {
    ctx.events.emit('stageStart', { index: stage });
    for (let i = 0; i < target; i++) ctx.events.emit('kill', { victim: hollowed(), source: ctx.player });
  }
  ok(cor.warded === VOW_WARD * 3, `three vows ward ${VOW_WARD * 3} (${cor.warded})`);
  ok(cor.motes >= 1, `which is at least one Argent Mote (${cor.motes}, per=${MOTE.per})`);
  ok(cor.ledger.pure >= CAPSTONE.pure, `and clears the pure capstone floor (${cor.ledger.pure.toFixed(2)})`);
  ok(alignmentOf(cor.ledger) === 'pure' && pureCapstoneEligible(cor.ledger),
    'the run reads pure and the capstone is open — earned without a point of corruption');
  ok(cor.world === 0 && cor.band === 0, 'and it never once crossed into the void to get there');
}

console.log('\n-- (b) the restraint vow fails when its condition is violated --');
{
  const seed = 4242;
  const stage = stageOffering(seed, 'take-nothing-offered');

  // Kept: the stage passes without a single void-credit act, and the NEXT
  // stageStart is what closes it. `keptOnClose` is the whole difference.
  const a = makeCtx(seed);
  a.ctx.events.emit('stageStart', { index: stage });
  a.ctx.events.emit('itemOffer', { kind: 'chest', outcome: 'gold', owner: a.ctx.player });
  a.ctx.events.emit('voidBargain', { kind: 'sanctuary', motes: 1, owner: a.ctx.player });
  const wardedBeforeClose = a.cor.warded;
  a.ctx.events.emit('stageStart', { index: stage + 1 });
  ok(a.cor.warded === wardedBeforeClose + VOW_WARD,
    `a stage bought in gold keeps the Closed Hand (+${VOW_WARD}, now ${a.cor.warded})`);

  // PLANTED VIOLATION. One chest forced on void credit and the vow is gone.
  for (const [label, ev, payload] of [
    ['a lid forced on void credit', 'itemOffer', { kind: 'chest', outcome: 'corrupt' }],
    ['an item taken as a corrupted upgrade', 'itemOfferResolved', { kind: 'item', outcome: 'corrupt' }],
    ['a pact struck at the altar', 'voidBargain', { kind: 'pact', marks: 3 }],
    ['the void let all the way in', 'voidBargain', { kind: 'ruin', marks: 0, motes: 0 }],
  ]) {
    const b = makeCtx(seed);
    b.ctx.events.emit('stageStart', { index: stage });
    const pureBefore = b.cor.ledger.pure;
    b.ctx.events.emit(ev, { ...payload, owner: b.ctx.player });
    ok(b.vows.active === null, `${label} breaks the vow on the spot`);
    // Closing the stage afterwards must not resurrect it — an unresolved-vs-
    // broken confusion here would pay for the exact act the vow forbade.
    b.ctx.events.emit('stageStart', { index: stage + 1 });
    ok(b.cor.ledger.pure === pureBefore,
      `${label}: no purity is paid, at the break or at the close (${b.cor.ledger.pure})`);
    ok(b.cor.warded === 0, `${label}: and nothing is warded`);
  }

  // RUIN — the review's Critical, driven through the real verb rather than the
  // event alone. `Corruption.ruin()` is the heaviest corrupt act in the table
  // (24, above the capstone floor by itself) and the altar used to settle it
  // silently, so a run could let the void all the way in and still be paid for
  // the Vow of the Closed Hand in the same stage.
  {
    const r = makeCtx(seed);
    r.ctx.events.emit('stageStart', { index: stage });
    ok(r.vows.active?.vow.id === 'take-nothing-offered', 'the Closed Hand is standing');
    // Exactly what the altar's ruin branch does, in its order: the verb first,
    // then the bargain event that announces it.
    const opened = r.cor.ruin();
    r.ctx.events.emit('voidBargain', { kind: 'ruin', marks: 0, motes: 0, owner: r.ctx.player });
    ok(opened && r.cor.ruined, 'the one-way door is open');
    ok(r.cor.ledger.corrupt === weightOf('ruin', 1),
      `and the run is billed ruin's full weight (${r.cor.ledger.corrupt})`);
    ok(r.vows.active === null, 'RUIN breaks the vow');
    r.ctx.events.emit('stageStart', { index: stage + 1 });
    ok(r.cor.warded === 0 && r.cor.ledger.pure === 0,
      `and the stage closes paying nothing at all (warded ${r.cor.warded}, pure ${r.cor.ledger.pure})`);
    ok(!pureCapstoneEligible(r.cor.ledger) && alignmentOf(r.cor.ledger) === 'corrupt',
      'the run reads corrupt, with no purity bought on the way in');
  }

  // The event is only half the fix; the altar has to actually emit it. Read out
  // of the source, because a test that drives the event by hand passes just as
  // happily against a ruin branch that emits nothing — which is exactly the
  // state this finding was found in.
  {
    const src = readFileSync(new URL('../src/world/Interactables.js', import.meta.url), 'utf8');
    const branch = src.slice(src.indexOf("if (offer.kind === 'ruin')"));
    const body = branch.slice(0, branch.indexOf('\n    }'));
    ok(body.includes('cor.ruin()'), 'the altar ruin branch is where it was expected');
    ok(/emit\('voidBargain',\s*\{\s*kind:\s*'ruin'/.test(body),
      "and it emits a voidBargain of kind 'ruin' — the vow has something to hear");
  }

  // Failure never costs. This is the adjudicated contract and the reason
  // `vowBroken` stays unwired: an offered vow can only ever pay.
  const c = makeCtx(seed);
  c.ctx.events.emit('stageStart', { index: stage });
  c.ctx.events.emit('voidBargain', { kind: 'pact', marks: 3, owner: c.ctx.player });
  const afterBreak = c.cor.ledger.corrupt;
  c.ctx.events.emit('stageStart', { index: stage + 1 });
  ok(c.cor.ledger.corrupt === afterBreak,
    'breaking a vow bills no corrupt commitment of its own — the pact alone is charged');
  ok(c.cor.history({ source: 'vowBroken' }).length === 0, 'and writes no vowBroken entry');
}

console.log('\n-- the timing vow is kept fast and broken slow --');
{
  const seed = 7;
  const stage = stageOffering(seed, 'do-not-linger');
  const limit = VOW_BY_ID['do-not-linger'].target;

  const fast = makeCtx(seed);
  fast.ctx.events.emit('stageStart', { index: stage });
  fast.vows.update(fast.ctx, limit - 1);
  fast.ctx.events.emit('teleporterComplete', {});
  ok(fast.cor.warded === VOW_WARD, `charged with a second to spare, the vow is kept (${fast.cor.warded})`);

  const slow = makeCtx(seed);
  slow.ctx.events.emit('stageStart', { index: stage });
  slow.vows.update(slow.ctx, limit + 1);
  slow.ctx.events.emit('teleporterComplete', {});
  ok(slow.cor.warded === 0, 'a second late and it is broken');
  ok(slow.vows.active === null, 'and it does not linger open into the next stage');
}

console.log('\n-- (c) selection is deterministic, and off its OWN stream --');
{
  for (const seed of [1, 12345, 0xdeadbeef, 7]) {
    for (const stage of [0, 1, 5, 17]) {
      ok(selectVow(seed, stage).id === selectVow(seed, stage).id,
        `seed ${seed} stage ${stage} answers the same vow twice`);
    }
  }
  // Two seeds must not be locked together, or "deterministic" would be
  // satisfied by a constant and the guard would prove nothing.
  const across = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => selectVow(s, 0).id);
  ok(new Set(across).size > 1, `different seeds offer different vows (${new Set(across).size} distinct)`);

  // The load-bearing property: the draw comes off a salted local stream keyed on
  // (seed, stage), NOT off a shared gameplay stream. A shared stream would make
  // the presence of a vow move every later loot roll.
  //
  // MUTATED ARM: re-derive the selection from a stream that has been advanced,
  // the way a shared `ctx.rng` would be. If selection were stream-positional the
  // answers would still agree with the salted ones; they must not.
  const shared = new RNG(12345);
  shared.next(); shared.next(); shared.next();
  const positional = [0, 1, 2, 3].map(() => VOWS[shared.int(0, VOWS.length - 1)].id);
  const salted = [0, 1, 2, 3].map((i) => selectVow(12345, i).id);
  ok(JSON.stringify(positional) !== JSON.stringify(salted),
    'a stream-positional draw disagrees with the salted one — the arm can fail');

  // And a live run really does take no gameplay draw. `ctx.rng` is not even
  // present on the fixture ctx, so a selector reaching for it would throw.
  const { ctx, vows } = makeCtx(12345);
  ctx.rng = { next: () => { throw new Error('gameplay stream consumed by vow selection'); } };
  let threw = null;
  try { ctx.events.emit('stageStart', { index: 3 }); } catch (err) { threw = err; }
  ok(threw === null && vows.active?.vow.id === selectVow(12345, 3).id,
    'opening a vow consumes no gameplay draw and lands on the seeded answer');
}

console.log('\n-- a guest holds no vow --');
{
  const { ctx, cor, vows } = makeCtx(999);
  ctx.authority = false;
  ctx.events.emit('stageStart', { index: stageOffering(999, 'seal-the-hollowed') });
  ok(vows.active === null && vows.line === '', 'with no authority no vow opens and the HUD line is empty');
  const target = VOW_BY_ID['seal-the-hollowed'].target;
  for (let i = 0; i < target; i++) ctx.events.emit('kill', { victim: hollowed(), source: ctx.player });
  ok(cor.warded === 0, 'and nothing accrues on a guest');
}

console.log('\n-- the HUD line names the vow and its standing --');
{
  const seed = 999;
  const { ctx, vows } = makeCtx(seed);
  ctx.events.emit('stageStart', { index: stageOffering(seed, 'seal-the-hollowed') });
  ok(vows.line.includes(VOW_BY_ID['seal-the-hollowed'].title), 'the line carries the vow title');
  ok(vows.line.includes('0/'), 'and its progress, which starts at zero');
  ctx.events.emit('kill', { victim: hollowed(), source: ctx.player });
  ok(vows.line.includes('1/'), 'and moves with the conduct');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
