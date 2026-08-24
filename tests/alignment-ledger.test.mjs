// tests/alignment-ledger.test.mjs
// The alignment commitment ledger and its anti-laundering invariants (#169).
//
// The defect this guards is the 2026-08-23 audit's Critical: cleansing drops
// live corruption while every historical benefit survives, so a run can hold
// the corrupt build and buy back the clean route. These tests hold the four
// invariants in src/data/alignment.js — monotonicity, capstone exclusivity by
// construction, history read from the ledger rather than the band, and totals
// surviving a truncated history — and they hold each *wired* source to
// incrementing exactly one class exactly once per act.
import { Corruption } from '../src/systems/Corruption.js';
import {
  ALIGNMENT, ALIGNMENT_UNKNOWN, CAPSTONE, COMMITMENT, HISTORY_MAX, SOURCES, TOLERANCE,
  alignmentOf, classOf, commitmentTotals, corruptCapstoneEligible, emptyLedger,
  hasCommitted, pureCapstoneEligible, routeHistory, sanitizeLedger, weightOf,
} from '../src/data/alignment.js';
import { Profile } from '../src/systems/Profile.js';
import { Progression } from '../src/systems/Progression.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true });

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const seen = [];
  const ctx = {
    authority,
    player: P(),
    events: {
      emit(name, p) { seen.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    interactables: { list: [] },
  };
  const cor = new Corruption();
  cor.init(ctx);
  return { ctx, cor, seen };
}

console.log('\n-- the ledger is monotone: cleansing lowers danger, never commitment --');
{
  const { ctx, cor } = makeCtx();
  const p = ctx.player;
  cor.feed(p, 200);
  cor.commit('ruin');
  cor.commit('bargainSynergy');
  const committed = cor.ledger.corrupt;
  ok(committed > 0, `a descent commits (${committed})`);
  ok(cor.world === 200, `the world is deep (${cor.world})`);

  cor.bleed(p, 200);          // the whole gauge cleansed at a font
  ok(cor.world === 0, 'cleansing takes the live gauge to zero');
  ok(cor.band === 0, 'and the live band with it');
  ok(cor.ledger.corrupt === committed,
    `corrupt commitment is unmoved by cleansing (${cor.ledger.corrupt} vs ${committed})`);
  ok(cor.peak === 200, 'peak survives too, as it always did');

  // Sanctuary is the other live-danger valve; it must not launder either.
  cor.sanctuary(12);
  ok(cor.ledger.corrupt === committed, 'opening a sanctuary does not reduce commitment');
}

console.log('\n-- exclusivity is a property of the partition, not of two thresholds --');
{
  // The impossibility attempt. `alignmentOf` is single-valued, so both
  // capstones cannot be open at once for ANY ledger — not merely for the ones
  // the current weights happen to produce. Enumerate a wide grid, including
  // absurd and hostile values, and try to construct a counterexample.
  const values = [
    0, 1, TOLERANCE.pure, TOLERANCE.pure + 0.001, TOLERANCE.corrupt, TOLERANCE.corrupt + 0.001,
    CAPSTONE.pure - 0.001, CAPSTONE.pure, CAPSTONE.corrupt, CAPSTONE.corrupt + 1,
    1e6, Number.MAX_SAFE_INTEGER,
  ];
  let both = null, neitherName = 0;
  for (const corrupt of values) {
    for (const pure of values) {
      for (const mixed of [0, 1, 1e6]) {
        const l = { corrupt, pure, mixed, history: [] };
        if (corruptCapstoneEligible(l) && pureCapstoneEligible(l)) both = l;
        const a = alignmentOf(l);
        if (![ALIGNMENT.neutral, ALIGNMENT.pure, ALIGNMENT.corrupt, ALIGNMENT.mixed].includes(a)) neitherName++;
      }
    }
  }
  ok(both === null, `no ledger in ${values.length ** 2 * 3} constructed states is both-eligible`);
  ok(neitherName === 0, 'every ledger reads as exactly one of the four alignments');

  // Junk and hostile shapes too — the predicates must not throw or agree.
  for (const l of [null, undefined, {}, { corrupt: NaN, pure: NaN }, { corrupt: -5, pure: -5 },
    { corrupt: Infinity, pure: Infinity }, { corrupt: '99', pure: '99' }]) {
    if (corruptCapstoneEligible(l) && pureCapstoneEligible(l)) both = l;
  }
  ok(both === null, 'nor is any malformed ledger');

  // And the ends of the reachable space, built through the real verb.
  const { ctx: c1, cor: maxCorrupt } = makeCtx();
  maxCorrupt.commit('ruin'); maxCorrupt.commit('bargainPact'); maxCorrupt.commit('blightMutation');
  ok(corruptCapstoneEligible(maxCorrupt.ledger), 'a committed corrupt run is corrupt-capstone eligible');
  ok(!pureCapstoneEligible(maxCorrupt.ledger), 'and is NOT pure-capstone eligible');
  ok(alignmentOf(maxCorrupt.ledger) === ALIGNMENT.corrupt, 'it reads as corrupt');
  void c1;

  const { cor: maxPure } = makeCtx();
  maxPure.commit('warded', 400); maxPure.commit('consecration'); maxPure.commit('sanctuary');
  ok(pureCapstoneEligible(maxPure.ledger), 'a committed pure run is pure-capstone eligible');
  ok(!corruptCapstoneEligible(maxPure.ledger), 'and is NOT corrupt-capstone eligible');

  // The launderer: everything corruption mints, then the gauge scrubbed clean.
  const { ctx, cor: launder } = makeCtx();
  launder.feed(ctx.player, 400);
  launder.commit('bargainSynergy'); launder.commit('blightMutation'); launder.commit('corruptChest');
  launder.bleed(ctx.player, 400);   // 400 warded = 20 pure commitment
  ok(launder.world === 0 && launder.band === 0, 'the launderer checks out at Pristine');
  ok(alignmentOf(launder.ledger) === ALIGNMENT.mixed, 'but the ledger reads mixed');
  ok(!pureCapstoneEligible(launder.ledger) && !corruptCapstoneEligible(launder.ledger),
    'and neither capstone is open to it — the laundering buys nothing');
}

console.log('\n-- each wired source increments exactly one class, exactly once per act --');
{
  // The mis-wire guard. Every wired source is driven through its real path and
  // the delta compared against an expectation written HERE, in literals.
  //
  // That duplication is the point and must not be refactored away: an earlier
  // draft read the expected class out of `classOf(source)`, which is the same
  // table the wiring reads — flipping `stabilised` from pure to corrupt in
  // SOURCES kept every assertion green, because the guard moved with the bug.
  // A guard that reads its own subject cannot fail. These literals are a second
  // opinion; changing an alignment on purpose costs one line here and should.
  const cases = [
    ['corruptChest', COMMITMENT.corrupt, 3, (c, ctx) => ctx.events.emit('itemOffer', { kind: 'chest', size: 'small', outcome: 'corrupt', owner: ctx.player })],
    ['blightMutation', COMMITMENT.corrupt, 4, (c, ctx) => ctx.events.emit('itemMutated', { baseId: 'a', blightId: 'b', count: 1, band: 2, owner: ctx.player })],
    ['bargainReroll', COMMITMENT.corrupt, 1, (c, ctx) => ctx.events.emit('voidBargain', { kind: 'reroll', marks: 1, owner: ctx.player })],
    ['bargainSynergy', COMMITMENT.corrupt, 4, (c, ctx) => ctx.events.emit('voidBargain', { kind: 'synergy', marks: 2, owner: ctx.player })],
    ['bargainPact', COMMITMENT.corrupt, 5, (c, ctx) => ctx.events.emit('voidBargain', { kind: 'pact', marks: 3, owner: ctx.player })],
    ['sanctuary', COMMITMENT.pure, 2, (c) => c.sanctuary(12)],
    ['consecration', COMMITMENT.pure, 5, (c, ctx) => ctx.events.emit('voidBargain', { kind: 'consecrate', motes: 3, owner: ctx.player })],
    ['stabilised', COMMITMENT.pure, 3, (c, ctx) => ctx.events.emit('itemStabilised', { blightId: 'b', baseId: 'a', count: 1, owner: ctx.player })],
    ['corruptUpgrade', COMMITMENT.corrupt, 4, (c, ctx) => ctx.events.emit('itemOfferResolved', { kind: 'item', itemId: 'a', outcome: 'corrupt', owner: ctx.player })],
    // `warded` is load-bearing: a salvage that took nothing back out of the
    // world commits nothing at all. See the arm below.
    ['salvaged', COMMITMENT.pure, 3, (c, ctx) => ctx.events.emit('itemOfferResolved', { kind: 'item', itemId: 'a', outcome: 'salvage', warded: 4, owner: ctx.player })],
    ['ruin', COMMITMENT.corrupt, 24, (c) => c.ruin()],
    // A Wound fed (#178). `corruption: 0` keeps this a single-class delta: the
    // real feed also charges corruption, which mints marks and — on a world
    // with something in it — would ward nothing but still moves other numbers.
    // The full path, corruption and all, is `tests/wounds.test.mjs`.
    ['woundFed', COMMITMENT.corrupt, 5, (c, ctx) => ctx.events.emit('woundResolved', { outcome: 'feed', owner: ctx.player, corruption: 0 })],
    // A Tempering (#179), now wired: `Items.temper()` emits `itemTempered`
    // once a trade actually lands, and `Corruption` commits it unconditionally.
    ['tempered', COMMITMENT.mixed, 8, (c, ctx) => ctx.events.emit('itemTempered', {
      id: 'tempered-capacitor', argent: 'quicksilver-vein', blight: 'arc-rot', owner: ctx.player,
    })],
  ];
  for (const [source, cls, want, act] of cases) {
    const { ctx, cor } = makeCtx();
    const before = commitmentTotals(cor.ledger);
    act(cor, ctx);
    const after = commitmentTotals(cor.ledger);
    ok(classOf(source) === cls && Math.abs(weightOf(source, 1) - want) < 1e-9,
      `${source} is declared as ${want} into ${cls} (table says ${weightOf(source, 1)} into ${classOf(source)})`);
    const moved = Object.keys(after).filter((k) => after[k] !== before[k]);
    ok(moved.length === 1 && moved[0] === cls && Math.abs(after[cls] - before[cls] - want) < 1e-9,
      `${source} pays ${want} into ${cls} and nothing else (moved ${JSON.stringify(moved)}, ` +
      `delta ${(after[cls] - before[cls]).toFixed(3)})`);
    const rows = routeHistory(cor.ledger, { source });
    ok(rows.length === 1, `${source} writes exactly one history entry (${rows.length})`);
  }

  // Warding is priced per point, not per act, and rides `taken` not the ask.
  const { ctx, cor } = makeCtx();
  cor.feed(ctx.player, 50);
  cor.bleed(ctx.player, 500);       // clamps to 50
  ok(Math.abs(cor.ledger.pure - weightOf('warded', 50)) < 1e-9,
    `warding pays for what was actually taken (${cor.ledger.pure})`);

  // A salvage against a world with nothing to give back is a decline, not an
  // act of purity. Without this gate a free, unlimited button mints pure
  // commitment: eight presses would open the pure capstone having warded zero.
  {
    const { ctx: c3, cor: c3cor } = makeCtx();
    for (let i = 0; i < 8; i++) {
      c3.events.emit('itemOfferResolved', { kind: 'item', itemId: 'a', outcome: 'salvage', warded: 0, owner: c3.player });
    }
    ok(c3cor.ledger.pure === 0, `eight no-op salvages commit nothing (${c3cor.ledger.pure})`);
    ok(!pureCapstoneEligible(c3cor.ledger), 'and open no capstone');
  }

  // The blight re-stack is not a fresh corruption act — `reason: 'corrupt'` is
  // the mutation writing back stacks it already charged for.
  const { ctx: c2, cor: c2cor } = makeCtx();
  c2.events.emit('itemOffer', { kind: 'chest', size: 'small', outcome: 'gold', owner: c2.player });
  ok(c2cor.ledger.corrupt === 0, 'a chest paid for in gold commits nothing');

  // Every source in the table is either wired and covered above, or explicitly
  // future work. A new wired source with no case here fails this.
  // `vowKept` is wired and covered, but not HERE: a kept vow pays `vowKept`
  // AND the warding its payout earns, so its delta into `pure` is two weights
  // and cannot be written as this table's single literal. Its real path — the
  // Vows system driven through a stage boundary — is held open by
  // `tests/stage-vows.test.mjs`, which blinds the payout to prove it fails.
  // `woundSealed` joins them for exactly the same reason: a seal pays
  // `woundSealed` AND the `warded` its bleed earns, so its delta into `pure` is
  // two weights. Its real path — a Wound held to the end of its window against
  // a dirtied world — is held open by `tests/wounds.test.mjs`, which blinds the
  // payout to prove it fails.
  const covered = new Set(cases.map((c) => c[0]).concat(['warded', 'vowKept', 'woundSealed']));
  const missing = Object.entries(SOURCES)
    .filter(([id, d]) => d.wired && !covered.has(id)).map(([id]) => id);
  ok(missing.length === 0, `every wired source has a case (missing: ${missing.join(', ') || 'none'})`);
  const stubs = Object.entries(SOURCES).filter(([, d]) => !d.wired).map(([id]) => id);
  ok(stubs.length > 0 && stubs.every((s) => weightOf(s, 1) > 0 && classOf(s)),
    `the future sources are declared and priced, not merely named (${stubs.join(', ')})`);
  // And the extension point works: a downstream ticket adds one call, no more.
  // `vowBroken` is the standing example now that #179 wired `tempered` (the
  // previous example) alongside both wound sources #178 wired before it. The
  // guard is the same and it can still fail: point it at a source that is not
  // in the table and `weightOf` returns 0.
  const { cor: stubCor } = makeCtx();
  stubCor.commit('vowBroken');
  ok(stubCor.ledger.corrupt === weightOf('vowBroken', 1), 'an unwired source commits the moment it is called');
}

console.log('\n-- the queries are pure --');
{
  const l = sanitizeLedger({
    corrupt: 12, pure: 4, mixed: 0,
    history: [{ t: 1, stage: 0, source: 'ruin', amount: 24 }, { t: 2, stage: 1, source: 'warded', amount: 40 }],
  });
  const snap = JSON.stringify(l);
  const seq = [alignmentOf, corruptCapstoneEligible, pureCapstoneEligible, commitmentTotals,
    hasCommitted, (x) => routeHistory(x), (x) => routeHistory(x, { cls: COMMITMENT.pure }),
    (x) => routeHistory(x, { sinceStage: 1 })];
  const first = seq.map((f) => JSON.stringify(f(l)));
  for (let i = 0; i < 40; i++) {
    const f = seq[i % seq.length];
    ok(JSON.stringify(f(l)) === first[i % seq.length], `${f.name || 'query'} is deterministic across repeats`);
  }
  ok(JSON.stringify(l) === snap, 'no query mutated the ledger');
  const copy = routeHistory(l);
  copy[0].source = 'tempered';
  ok(routeHistory(l)[0].source === 'ruin', 'routeHistory hands back a copy, not the live rows');
  ok(routeHistory(l, { cls: COMMITMENT.pure }).length === 1, 'history filters by class');
  ok(routeHistory(l, { sinceStage: 1 }).length === 1, 'and by stage boundary');
  ok(alignmentOf(emptyLedger()) === ALIGNMENT.neutral && !hasCommitted(emptyLedger()),
    'an untouched run is neutral and has committed nothing');
}

console.log('\n-- totals are authoritative; history is a bounded window --');
{
  const { cor } = makeCtx();
  for (let i = 0; i < HISTORY_MAX + 50; i++) cor.commit('bargainReroll');
  ok(cor.ledger.history.length === HISTORY_MAX, `history is capped at ${HISTORY_MAX} (${cor.ledger.history.length})`);
  ok(Math.abs(cor.ledger.corrupt - weightOf('bargainReroll', 1) * (HISTORY_MAX + 50)) < 1e-9,
    `the total counts every act, not just the retained ones (${cor.ledger.corrupt})`);
}

console.log('\n-- commitment is host-local: a guest never half-sees it --');
{
  // The replication decision (#169, see docs/adr/0003). The ledger does not
  // ride the wire: `commit` is authority-gated like every other mutator here,
  // and `applyNetState` deliberately leaves it alone. A guest therefore reads a
  // *consistent* neutral ledger, never a partial one built from its own
  // locally-observed events.
  const { ctx, cor: guest } = makeCtx({ authority: false });
  ctx.events.emit('itemOffer', { kind: 'chest', size: 'small', outcome: 'corrupt', owner: ctx.player });
  ctx.events.emit('voidBargain', { kind: 'pact', marks: 3, owner: ctx.player });
  ctx.events.emit('itemMutated', { baseId: 'a', blightId: 'b', count: 1, band: 3, owner: ctx.player });
  guest.commit('ruin');
  ok(guest.ledger.corrupt === 0 && guest.ledger.pure === 0,
    'a guest accrues nothing locally, however many host events it observes');

  const host = makeCtx();
  host.cor.feed(host.ctx.player, 300);
  host.cor.ruin();
  const applied = guest.applyNetState(host.cor.netState());
  ok(applied === true, 'the guest still adopts the world economy');
  ok(guest.world === 300 && guest.ruined === true, 'gauge, band and the one-way door cross as before');
  ok(!('ledger' in host.cor.netState()) && !('commitCorrupt' in host.cor.netState()),
    'the ledger is not on the wire — no field for a guest to half-read');
  ok(guest.ledger.corrupt === 0 && guest.ledger.pure === 0 && guest.ledger.history.length === 0,
    'and applying the host state leaves the guest ledger neutral, not partial');
  ok(alignmentOf(guest.ledger) === ALIGNMENT.neutral,
    'so a guest reads a consistent neutral alignment rather than a wrong one');
}

console.log('\n-- world-threshold commitment is seat-count independent --');
{
  // The integration review's M1. A band crossing is ONE world event, but the
  // mutation toll it triggers runs once per seat: each pawn's `Items` emits its
  // own `itemMutated` on the same bus. Billing every one of them made corrupt
  // commitment scale linearly with party size against a `warded` side that runs
  // once through `bleed` — so a two-seat run was corrupt-capstone eligible with
  // zero deliberate acts, and no co-op run could ever read pure.
  //
  // `seats` here is the number of `Items` instances on the bus; the fixture
  // reproduces the fall-through single-tree by emitting one toll per seat per
  // crossing, which is exactly what the real emitters do.
  // The fixture mirrors `Items`' REAL emission (Items.js:440-446), which an
  // earlier draft of this test did not: `Items` queues one mutation per
  // DISTINCT band crossed, from `max(prev + 1, nextTollBand())` up to the new
  // band, and drains them in one frame. Emitting one synthetic toll per
  // `corruptionBand` event instead modelled the implementation's assumption
  // rather than the emitter, and so stayed green on a fix that billed a
  // three-threshold jump once. `_mutePeak` is per-seat and monotone, so each
  // seat tolls each band at most once per run.
  const seatOf = (seats) => {
    const peak = new Array(seats).fill(0);
    return { peak, next: (s) => Math.max(2 /* MUTATION.minBand */, peak[s] + 1) };
  };
  const runAt = (seats, feeds) => {
    const { ctx, cor } = makeCtx();
    const st = seatOf(seats);
    ctx.events.on('corruptionBand', ({ band, prev }) => {
      if (!(band > prev)) return;
      for (let s = 0; s < seats; s++) {
        for (let b = Math.max(prev + 1, st.next(s)); b <= band; b++) {
          st.peak[s] = b;
          ctx.events.emit('itemMutated', { baseId: 'a', blightId: 'b', count: 1, band: b, owner: { isPlayer: true, seat: s } });
        }
      }
    });
    for (const f of feeds) cor.feed(ctx.player, f);
    return cor;
  };
  const bills = (cor) => routeHistory(cor.ledger, { source: 'blightMutation' }).length;

  // (a) one feed spanning three toll bands, solo. Bands 2, 3 and 4 are three
  // thresholds and therefore three acts — this is the under-count red.
  const solo = runAt(1, [200]);
  ok(bills(solo) === 3, `a single feed across three thresholds bills three times (${bills(solo)})`);
  ok(Math.abs(solo.ledger.corrupt - weightOf('blightMutation', 3)) < 1e-9,
    `and the total says so (${solo.ledger.corrupt})`);

  // (b) the same jump at 2 and 4 seats: still exactly three.
  const duo = runAt(2, [200]), quad = runAt(4, [200]);
  ok(bills(duo) === 3, `two seats bill the same three thresholds (${bills(duo)})`);
  ok(bills(quad) === 3, `four seats bill the same three thresholds (${bills(quad)})`);
  ok(JSON.stringify(quad.ledgerSummary()) === JSON.stringify(solo.ledgerSummary()),
    'the whole verdict at N seats is identical to solo');
  ok(!solo.corruptCapstone && !quad.corruptCapstone,
    'and an incidental descent with no deliberate act is capstone-eligible at NO seat count');

  // (c) batching independence: the same corruption arriving one band at a time
  // must produce an identical ledger to the single jump, at any seat count.
  for (const seats of [1, 2, 4]) {
    const stepped = runAt(seats, [60, 60, 80]);   // Blighted, Overrun, Consumed
    ok(bills(stepped) === 3 && JSON.stringify(stepped.ledgerSummary()) === JSON.stringify(solo.ledgerSummary()),
      `${seats} seat(s) stepping one band at a time match the jump (${bills(stepped)} bills)`);
  }

  // (d) a threshold is billed at most once per run, because `Items._mutePeak`
  // is monotone and never tolls it twice. Asserting a re-bill here would be
  // asserting behaviour only a synthetic event can produce.
  const recross = (() => {
    const { ctx, cor } = makeCtx();
    const st = seatOf(1);
    ctx.events.on('corruptionBand', ({ band, prev }) => {
      if (!(band > prev)) return;
      for (let b = Math.max(prev + 1, st.next(0)); b <= band; b++) { st.peak[0] = b; ctx.events.emit('itemMutated', { band: b, owner: ctx.player }); }
    });
    cor.feed(ctx.player, 60); const one = bills(cor);
    cor.bleed(ctx.player, 60);
    cor.feed(ctx.player, 60);
    return [one, bills(cor)];
  })();
  ok(recross[0] === 1 && recross[1] === 1,
    `bleeding below a threshold and climbing back does not re-bill it (${recross.join(' -> ')}), ` +
    'because the real emitter never tolls it again');

  // Symmetry: the pure side was never seat-inflated, and must stay that way.
  const wardAt = (seats) => {
    const { ctx, cor } = makeCtx();
    cor.feed(ctx.player, 100);
    const base = cor.ledger.pure;
    for (let s = 0; s < seats; s++) cor.bleed({ isPlayer: true, seat: s }, 25);
    return cor.ledger.pure - base;
  };
  ok(Math.abs(wardAt(4) - wardAt(1) * 4) < 1e-9,
    'warding is per point removed, so N hands removing N times as much commit N times as much');
  // The asymmetry that mattered is gone: one world act bills once on both sides.
  ok(duo.ledger.pure === solo.ledger.pure, 'and no seat count changes the pure side of a crossing either');
}

console.log('\n-- a guest never files a verdict it did not simulate --');
{
  // The integration review's M2. `_endRun` runs on every machine; the ledger is
  // host-local. The old code spread the guest's empty `ledgerSummary()` into the
  // run stats, so a guest's permanent logbook recorded a deeply corrupted co-op
  // run as alignment:'neutral', commitCorrupt:0 — a false verdict, in
  // disagreement with the host's record of the same run.
  // Driven through the REAL `Progression.runStats` on a real `Corruption`, not
  // through a re-implementation of the authority check: an earlier draft of
  // this test built the summary inline and stayed green when the gate in
  // Progression.js was reverted, which is the same guard-reads-its-own-subject
  // failure the mis-wire cases above document.
  const p = new Profile();
  const statsOf = (authority) => {
    const { ctx, cor } = makeCtx({ authority: true });
    cor.feed(ctx.player, 300); cor.ruin(); cor.commit('bargainPact');
    ok(cor.alignment === ALIGNMENT.corrupt, 'the host ledger for this run is non-neutral');
    // The guest is the same world with the authority flag down and its OWN,
    // empty ledger — which is precisely what a co-op guest holds, because
    // `commit` is authority-gated and the ledger does not ride the wire.
    const prog = Object.create(Progression.prototype);
    prog.stats = {}; prog.stageIndex = 0; prog.stageName = ''; prog.difficulty = 1;
    prog.corruptionPeakBand = 0; prog.ending = null;
    prog.ctx = { authority, corruption: authority ? cor : new Corruption(), items: null };
    return prog.runStats();
  };
  const hostStats = statsOf(true), guestStats = statsOf(false);
  const hostRec = p._coerce({ v: 1, runs: [{ outcome: 'death', ...hostStats }] }).runs[0];
  const guestRec = p._coerce({ v: 1, runs: [{ outcome: 'death', ...guestStats }] }).runs[0];
  ok(!('alignment' in guestStats),
    'a guest\'s runStats carries no alignment field at all — absence, not a claim');
  ok(hostRec.alignment === ALIGNMENT.corrupt && hostRec.commitCorrupt > 0,
    `the host files the real verdict (${hostRec.alignment}, ${hostRec.commitCorrupt})`);
  ok(guestRec.alignment !== ALIGNMENT.neutral,
    `the guest does NOT file 'neutral' for that run (${guestRec.alignment})`);
  ok(guestRec.alignment === ALIGNMENT_UNKNOWN, "it files 'unknown'");
  ok(guestRec.commitCorrupt === null && guestRec.commitPure === null,
    'and files no totals at all — null says "not simulated here", 0 would claim "committed nothing"');
}

console.log('\n-- old saves load unchanged --');
{
  // A run record in exactly the shape master writes today, with no ledger
  // fields at all. It must survive normalisation with every existing value
  // intact and a neutral ledger appended.
  const legacy = {
    v: 1,
    runs: [{
      at: 1700000000000, survivorId: 'ranger', difficultyId: 'normal', difficulty: 1.5,
      stage: 3, stageName: 'Ashen Reach', time: 900, kills: 400, elites: 9, bosses: 1,
      damageDealt: 90000, damageTaken: 4000, highestHit: 3000, items: 22, gold: 500,
      level: 14, outcome: 'victory', corruption: 12, corruptionBand: 1, corruptionPeakBand: 4,
      inventory: [{ id: 'cured-haunch', count: 3 }],
    }],
  };
  const before = JSON.parse(JSON.stringify(legacy.runs[0]));
  const p = new Profile();
  const norm = p._coerce(legacy);
  const r = norm.runs[0];
  let intact = true;
  for (const k of Object.keys(before)) if (JSON.stringify(r[k]) !== JSON.stringify(before[k])) intact = false;
  ok(intact, 'every field an old record already carried survives normalisation unchanged');
  // Absent reads UNKNOWN, not neutral. A pre-#169 record has no ledger, and
  // "this run committed to nothing" is a claim nothing in it supports — the
  // same reason a guest may not file one (M2 above).
  ok(r.alignment === ALIGNMENT_UNKNOWN, `an absent ledger reads unknown, not neutral (${r.alignment})`);
  ok(r.commitCorrupt === null && r.commitPure === null && r.commitMixed === null,
    'and carries no totals rather than a zero that would read as a verdict');

  // A record written by this build round-trips.
  const modern = { ...before, alignment: ALIGNMENT.corrupt, commitCorrupt: 33, commitPure: 1, commitMixed: 0 };
  const r2 = p._coerce({ v: 1, runs: [modern] }).runs[0];
  ok(r2.alignment === ALIGNMENT.corrupt && r2.commitCorrupt === 33 && r2.commitPure === 1,
    'a modern record round-trips its ledger summary');

  // Junk in the alignment slot falls back to neutral rather than propagating.
  const junk = { ...before, alignment: 'sovereign', commitCorrupt: 'lots' };
  const r3 = p._coerce({ v: 1, runs: [junk] }).runs[0];
  ok(r3.alignment === ALIGNMENT_UNKNOWN && r3.commitCorrupt === null,
    'an unrecognised alignment reads unknown, and drops the totals that came with it');

  ok(sanitizeLedger({ corrupt: 5, history: [{ source: 'nope', amount: 9 }, { t: 1, stage: 0, source: 'ruin', amount: 24 }] })
    .history.length === 1, 'sanitizeLedger drops history rows naming sources that do not exist');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
