/**
 * The Argent Reliquary — the spend surface (issue #36, third pass, plan §5).
 *
 * Motes bought twelve seconds and nothing else, ever; the altar's second rung
 * makes them buy a permanent card, and the rung *replaces* Sanctuary rather
 * than joining it, so banking past one mote is a real recurring decision.
 *
 * Two of these tests are written against failure modes rather than features.
 * The inert-alone guarantee (the pool lives in another lane) is only worth
 * anything if it is the `?.` doing the work — remove the optional call in
 * `_reliquaryStocked` and the "no pool" case throws instead of offering
 * Sanctuary, which is what the test asserts against.
 *
 * The third is the one that made the preview stop naming the card: `update()`
 * reads `signal()` reads `offer()` on every render frame, so a card drawn to be
 * previewed was a `ctx.rng` pull on the render path — the run's random sequence
 * became a function of frame rate the instant three motes were banked, with no
 * press anywhere. The draw is `interact`'s now, and the frame-loop arm below
 * counts. And the refused press asserts that
 * *nothing* moved — no grant, no event, no `spent` — because a bargain that
 * could fail after taking the purse is the one dishonest thing here.
 */
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { MOTE, RELIQUARY } from '../src/data/bandBoons.js';
import { VoidBargain } from '../src/world/Interactables.js';
import {
  installTelemetry, setTelemetryEnabled, ENABLED_KEY,
} from '../src/systems/Telemetry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const RELIC = 'pale-standard';

/**
 * A ctx with a real `Corruption` and a stubbed pack. `pool` is the cross-lane
 * seam: `'id'` is Lane B present, `null` is present-but-empty, and `'absent'`
 * is this lane merged on its own with no `rollArgent` in the tree at all.
 */
function makeCtx({ pool = RELIC, spendMotes = null } = {}) {
  const listeners = new Map();
  const granted = [];
  const emitted = [];
  const ctx = {
    authority: true,
    seed: 12345,
    time: 0,
    netRole: 'single',
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { emitted.push({ name, p }); for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    interactables: { list: [] },
  };
  ctx.items = {
    grant: (id) => { granted.push(id); return true; },
    // Empty, so no band's own bargain ever stands and the purity offer is the
    // one under test - which is precisely the party this rung is written for.
    blightHeld: () => new Map(), convertibleStacks: () => new Map(), addBuff: () => {},
  };
  if (pool !== 'absent') {
    ctx.items.rollArgent = () => pool;
    // The preview's question, and the only one it is allowed to ask: stocked,
    // not drawn. `null` is the pool present but empty.
    ctx.items.argentStocked = () => pool !== null;
  }
  const corruption = new Corruption();
  corruption.init(ctx);
  if (spendMotes) corruption.spendMotes = spendMotes;
  return { ctx, granted, emitted };
}

/** Ward `motes` worth of corruption out of the world, the only way to mint. */
function withMotes(fixture, motes) {
  const cor = fixture.ctx.corruption;
  if (motes <= 0) return fixture;
  cor.feed(fixture.ctx.player, MOTE.per * motes);
  cor.bleed(fixture.ctx.player, MOTE.per * motes);
  return fixture;
}

const altarOf = (fixture) => new VoidBargain(fixture.ctx, new THREE.Vector3(), 0);

console.log('the ladder: one mote is a window, three is a card');
{
  for (const n of [1, 2]) {
    const f = withMotes(makeCtx(), n);
    ok(f.ctx.corruption.motes === n, `${n} mote${n === 1 ? '' : 's'} in the purse`);
    ok(altarOf(f)._argent()?.kind === 'sanctuary', `and the altar offers Sanctuary at ${n}`);
  }
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const offer = altarOf(f)._argent();
  ok(f.ctx.corruption.motes >= RELIQUARY.motes, `${RELIQUARY.motes} motes in the purse`);
  ok(offer?.kind === 'consecrate', 'the deeper rung replaces the shallower one');
  ok(offer.motes === RELIQUARY.motes, `and names its price (${offer.motes})`);
  ok(offer.id === undefined, 'and does not name the card, which would mean drawing it');
  ok(offer.marks === 0, 'priced in the other currency entirely');
}

console.log('and none of it at zero');
{
  const f = makeCtx();
  ok(f.ctx.corruption.motes === 0 && altarOf(f)._argent() === null, 'an empty purse is offered nothing');
}

console.log('inert alone: with no pool in the tree the altar is exactly what it was');
{
  // The guarantee this lane merges on. Remove the `?.` from `argentStocked?.()`
  // in `_reliquaryStocked` and this case throws a TypeError instead of falling
  // to Sanctuary - which is the failure this assertion exists to catch.
  for (const pool of ['absent', null]) {
    const f = withMotes(makeCtx({ pool }), RELIQUARY.motes + 1);
    const altar = altarOf(f);
    let offer = 'threw';
    try { offer = altar._argent(); } catch { /* offer stays 'threw' */ }
    ok(offer !== 'threw', `a ${pool === null ? 'null draw' : 'missing rollArgent'} does not throw`);
    ok(offer?.kind === 'sanctuary', 'and a rich purse still buys the window');
    ok(altar._reliquaryStocked() === false, 'the seam reports no card');
  }
}

console.log('the card is drawn by the press and by nothing else');
{
  // The whole of the regression, stated as a count. A full purse and a render
  // loop: 240 frames of `update()`, every prompt read, every signal read, and
  // the gameplay stream must not have moved a single step. It is `ctx.rng` that
  // is counted and not just the stub, because it is `ctx.rng` that same-seed
  // runs share - a preview that drew from it made frame rate an input.
  let draws = 0;
  const f = makeCtx();
  f.ctx.rng = {
    next() { draws++; return 0.5; },
    range(a) { draws++; return a; },
    pick(list) { draws++; return list[0]; },
  };
  let rolls = 0;
  // The stub models the real `Items.rollArgent`, which is a `ctx.rng.pick`.
  f.ctx.items.rollArgent = () => { rolls++; return f.ctx.rng.pick([RELIC]); };
  withMotes(f, RELIQUARY.motes + 2);
  const altar = altarOf(f);
  ok(f.ctx.corruption.motes >= RELIQUARY.motes, 'the purse is full enough to consecrate');
  draws = 0; rolls = 0;
  for (let i = 0; i < 240; i++) {
    altar.update(1 / 60);
    altar.signal();
    altar.prompt();
    altar.available();
  }
  ok(rolls === 0, `240 frames at a full purse draw no card (${rolls})`);
  ok(draws === 0, `and take nothing off the gameplay stream (${draws})`);
  ok(altar.offer()?.kind === 'consecrate', 'though the rung was standing the whole time');
  ok(!/Pale Standard|Warden/.test(altar.prompt()), 'and the prompt never named a card');

  // The press is where it happens, exactly once.
  ok(altar.interact(f.ctx.player) === true, 'the press succeeds');
  ok(rolls === 1 && draws === 1, `and draws once (${rolls} roll, ${draws} draw)`);

  // A spent altar stops evaluating anything: `offer()` refuses before it can
  // ask the pool a question at all.
  const after = draws;
  for (let i = 0; i < 60; i++) { altar.update(1 / 60); altar.prompt(); }
  ok(altar.offer() === null, 'a spent altar offers nothing');
  ok(draws === after, `and draws nothing further (${draws})`);
}

console.log('a ruined run is refused at every purse');
{
  for (const n of [0, 1, RELIQUARY.motes, RELIQUARY.motes + 5]) {
    const f = withMotes(makeCtx(), n);
    f.ctx.corruption.ruin();
    ok(f.ctx.corruption.ruined, 'the run is ruined');
    ok(altarOf(f)._argent() === null, `and nothing is sold at ${f.ctx.corruption.motes} motes`);
  }
}

console.log('the prompt prices, previews and posts the fade');
{
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const line = altarOf(f).prompt();
  ok(/Consecrate/.test(line), `the offer is named: ${JSON.stringify(line)}`);
  ok(line.includes(`${RELIQUARY.motes} of ${f.ctx.corruption.motes} argent mote`), 'the price and the purse');
  ok(/paying \d+%/.test(line), 'and what the card is worth at this gauge');
  // The fade clause is not a constant: dive and the quoted percentage falls.
  const before = Number(line.match(/paying (\d+)%/)[1]);
  f.ctx.corruption.feed(f.ctx.player, RELIQUARY.fadeAt / 2);
  const after = Number(altarOf(f).prompt().match(/paying (\d+)%/)[1]);
  ok(after < before, `a dirtier world pays less (${before}% -> ${after}%)`);
}

console.log('a press that cannot pay moves nothing');
{
  const f = withMotes(makeCtx({ spendMotes: () => false }), RELIQUARY.motes);
  const altar = altarOf(f);
  ok(altar._argent()?.kind === 'consecrate', 'the offer stands');
  const before = f.emitted.length;
  ok(altar.interact(f.ctx.player) === false, 'the press is refused');
  ok(f.granted.length === 0, 'nothing was granted');
  ok(f.emitted.length === before, 'nothing was emitted');
  ok(altar.spent === false, 'and the altar is not spent');
}

console.log('a press that pays grants, spends and announces - in that order');
{
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const storage = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  setTelemetryEnabled(true, storage);
  ok(storage.getItem(ENABLED_KEY) === '1', 'recording is on for this fixture');
  const rec = installTelemetry(f.ctx, { storage });

  const altar = altarOf(f);
  const motesBefore = f.ctx.corruption.motes;
  ok(altar.interact(f.ctx.player) === true, 'the press succeeds');
  ok(f.granted.length === 1 && f.granted[0] === RELIC, `the card was granted (${f.granted[0]})`);
  ok(f.ctx.corruption.motes === motesBefore - RELIQUARY.motes, `and paid for (${motesBefore} -> ${f.ctx.corruption.motes})`);
  ok(altar.spent === true, 'the altar is spent');
  ok(altar.available() === false, 'and offers nothing further');

  const names = f.emitted.map((e) => e.name);
  const iBargain = names.indexOf('voidBargain');
  const iArgent = names.indexOf('argentConsecrate');
  ok(iBargain >= 0 && iArgent > iBargain, 'voidBargain then argentConsecrate');
  ok(f.emitted[iBargain].p.kind === 'consecrate' && f.emitted[iBargain].p.id === RELIC,
    'the existing acceptance field sees the press');
  ok(f.emitted[iArgent].p.id === RELIC && f.emitted[iArgent].p.motes === RELIQUARY.motes,
    'and the new one carries the gauge it was bought at');

  ok(rec.record.bargains.filter((b) => b.kind === 'consecrate').length === 1, 'one row in bargains');
  ok(rec.record.argent.length === 1 && rec.record.argent[0].id === RELIC, 'one row in argent');
  ok(rec.record.argent[0].world === Math.round(f.ctx.corruption.world), 'with the world at the press');
}

console.log('the mote purse is measured, the backfill §3 promised');
{
  const storage = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  setTelemetryEnabled(true, storage);

  // A run that never wards leaves all three at 0 - and it is a run that fed,
  // so an implementation that read `fed` would be caught here.
  const clean = makeCtx();
  const cleanRec = installTelemetry(clean.ctx, { storage });
  clean.ctx.corruption.feed(clean.ctx.player, MOTE.per * 3);
  const cm = cleanRec.record.corruption.motes;
  ok(cm.minted === 0 && cm.spent === 0 && cm.warded === 0,
    `no warding, no purse (${JSON.stringify(cm)})`);
  ok(cleanRec.record.corruption.fed > 0, 'though the run certainly fed');

  const f = makeCtx();
  const rec = installTelemetry(f.ctx, { storage });
  withMotes(f, RELIQUARY.motes + 1);
  const m = rec.record.corruption.motes;
  ok(m.minted === RELIQUARY.motes + 1, `warding mints (${m.minted})`);
  ok(m.warded === Math.round(f.ctx.corruption.warded), `and the corruption warded is carried (${m.warded})`);
  ok(m.spent === 0, 'nothing spent yet');

  // A window bought at four motes is a player who chose it over the card, and
  // `motesHeld` is the only field that can tell the two apart.
  const heldBefore = f.ctx.corruption.motes;
  f.ctx.corruption.spendMotes(MOTE.motes);
  f.ctx.corruption.sanctuary();
  ok(rec.record.corruption.motes.spent === MOTE.motes, 'the spend is counted');
  ok(rec.record.corruption.motes.minted === RELIQUARY.motes + 1, 'and does not disturb the mint');
  ok(rec.record.sanctuaries[0]?.motesHeld === heldBefore,
    `the window records the purse it was bought from (${rec.record.sanctuaries[0]?.motesHeld} of ${heldBefore})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
