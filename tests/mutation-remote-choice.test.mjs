// tests/mutation-remote-choice.test.mjs
// The blight toll's lever, extended over the wire (issue #168).
//
// Until now a remote player's toll was always paid the void's way: a satellite
// `Items` refused to open a window because there was no channel for an answer
// to come back on. There is one now — an offer identifier the host mints and
// addresses to the owning peer, and one bounded `MSG.MUTATE` reply — and the
// axis under test is that the reply is *never trusted*: the host re-derives
// whose pack it touches from the peer the bytes arrived on, and every other
// field is checked against the offer it claims to answer.
//
// The arms below drive real `Items` satellites on a real host bus, a real
// `NetHost` over fake peers, and the real client-side singleton, so nothing
// here is a mirror of the code it is testing.
import { Items } from '../src/systems/Items.js';
import { NetHost } from '../src/net/NetHost.js';
import { Reader, Writer, writeMutate, readMutate, MSG, PROTOCOL_VERSION } from '../src/net/Protocol.js';
import { BLIGHT_BY_BASE } from '../src/data/items.js';
import { MUTATION } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const SEED = 424242;
const BAND = MUTATION.minBand;
const bases = [...BLIGHT_BY_BASE.keys()].sort();

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority, seed: SEED, rng: new RNG(777), time: 0,
    netRole: authority ? 'host' : 'client',
    player: { isPlayer: true, alive: true },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of (listeners.get(name) || []).slice()) fn(p); },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
        return () => { const a = listeners.get(name); a.splice(a.indexOf(fn), 1); };
      },
    },
  };
  return { ctx, emitted };
}

/** The pick the void would have made for `band` out of `eligible` — the
 * deterministic fallback every non-answer resolves to. Mirrors `_mutateAt`'s
 * derived stream on purpose: it is the contract, not an implementation detail. */
const voidPick = (band, eligible) =>
  new RNG(((SEED >>> 0) ^ (0x6b2f8d43 * (band + 1))) >>> 0 || 1).pick([...eligible].sort());

const step = (ctx, items) => items.fixedUpdate(ctx, 1 / 60);

/** A host with two remote pawns, each holding four eligible stacks, each one
 * fixed step past the crossing that opens its window. */
function twoRemotes() {
  const { ctx, emitted } = makeCtx();
  const held = bases.slice(0, 4);
  const make = (peerId) => {
    const pawn = { isPlayer: true, alive: true, peerId, netId: 10 + peerId };
    const items = new Items(pawn);
    items.init(ctx);
    pawn.items = items;
    for (const id of held) items.give(id, 2);
    return { pawn, items };
  };
  const a = make(1), b = make(2);
  ctx.events.emit('corruptionBand', { band: BAND, prev: 0 });
  step(ctx, a.items);
  step(ctx, b.items);
  const offerFor = (pawn) => emitted.find((e) => e.name === 'mutationChoiceOffered' && e.payload.owner === pawn)?.payload;
  return { ctx, emitted, held, a, b, offerFor };
}

console.log('the host opens a window for a remote pawn and names it');
{
  const { emitted, a, b, offerFor, held } = twoRemotes();
  const oa = offerFor(a.pawn), ob = offerFor(b.pawn);
  ok(!!oa && !!ob, 'both remote pawns were asked');
  ok(oa.offerId > 0 && ob.offerId > 0, `each offer carries an identifier (${oa?.offerId}, ${ob?.offerId})`);
  ok(oa.offerId !== ob.offerId, 'and no two open offers share one');
  ok(oa.band === BAND && oa.seconds === MUTATION.choiceSeconds, 'the offer states its band and its clock');
  ok(oa.offers.every((o) => held.includes(o.baseId)), 'every card is a stack that pawn actually holds');
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'and nothing has festered while both offers stand');
}

console.log('a remote answer mutates that pawn\'s pack and only that pawn\'s');
{
  const { emitted, held, a, b, offerFor } = twoRemotes();
  const oa = offerFor(a.pawn);
  const dice = voidPick(BAND, held);
  const mine = oa.offers.map((o) => o.baseId).find((id) => id !== dice) ?? oa.offers[0].baseId;
  ok(mine !== dice, `the answer is not the pick the void wanted (${mine} vs ${dice})`);

  ok(a.items.answerMutation(oa.offerId, mine) === true, 'the host accepted the remote answer');
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 1 && mut[0].payload.owner === a.pawn, 'exactly one pack festered, and it is the answering one');
  ok(mut[0].payload.baseId === mine && mut[0].payload.chosen === true, 'it took the chosen stack, and says the player owned it');
  ok(a.items.count(mine) === 0 && a.items.count(BLIGHT_BY_BASE.get(mine).id) === 2, 'the chosen stack moved whole');
  ok(b.items.count(mine) === 2, 'the other pawn\'s copy of the same stack is untouched');
  ok(!!b.items.mutationChoice(), 'and the other pawn\'s window still stands');
  const closed = emitted.find((e) => e.name === 'mutationChoiceClosed' && e.payload.owner === a.pawn);
  ok(closed?.payload.reason === 'chosen', `the close is recorded on the host bus (${closed?.payload.reason})`);
  ok(closed?.payload.baseId === mine, 'naming the card, so the run record reads the same on the host as the toll it collected');
}

console.log('every answer the host did not offer fails closed');
{
  // Forged identifier.
  {
    const { a, b, offerFor } = twoRemotes();
    const oa = offerFor(a.pawn);
    ok(a.items.answerMutation(oa.offerId + 9999, oa.offers[0].baseId) === false, 'an identifier nobody minted is refused');
    ok(!!a.items.mutationChoice() && a.items.count(oa.offers[0].baseId) === 2, 'the window and the stack both survive it');
    ok(a.items.answerMutation(0, oa.offers[0].baseId) === false, 'and so is a zeroed one');
    void b;
  }
  // Somebody else's identifier, arriving on this peer's own satellite — the
  // shape a peer replaying a teammate's offer over the wire would take.
  {
    const { a, b, offerFor } = twoRemotes();
    const oa = offerFor(a.pawn), ob = offerFor(b.pawn);
    ok(a.items.answerMutation(ob.offerId, oa.offers[0].baseId) === false,
      'one peer cannot answer another peer\'s offer');
    ok(!!a.items.mutationChoice() && !!b.items.mutationChoice(), 'neither window moved');
  }
  // A stack that was never on the table.
  {
    const { held, a, offerFor } = twoRemotes();
    const oa = offerFor(a.pawn);
    const offered = oa.offers.map((o) => o.baseId);
    const notOffered = held.find((id) => !offered.includes(id));
    ok(a.items.answerMutation(oa.offerId, notOffered) === false, `a stack that was not offered (${notOffered}) is refused`);
    ok(a.items.count(notOffered) === 2 && !!a.items.mutationChoice(), 'the stack survives and the window stands');
  }
  // The second copy of a duplicated answer.
  {
    const { emitted, a, offerFor } = twoRemotes();
    const oa = offerFor(a.pawn);
    const offered = oa.offers.map((o) => o.baseId);
    ok(a.items.answerMutation(oa.offerId, offered[0]) === true, 'the first valid answer wins');
    ok(a.items.answerMutation(oa.offerId, offered[1]) === false, 'the duplicate behind it changes nothing');
    ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'and only one stack ever festered');
  }
  // An answer arriving after the window lapsed.
  {
    const { ctx, emitted, held, a, offerFor } = twoRemotes();
    const oa = offerFor(a.pawn);
    for (let t = 0; t < MUTATION.choiceSeconds * 60 + 2 && a.items.mutationChoice(); t++) step(ctx, a.items);
    ok(!a.items.mutationChoice(), 'the remote window lapsed on the host\'s own clock');
    const closed = emitted.find((e) => e.name === 'mutationChoiceClosed' && e.payload.owner === a.pawn);
    ok(closed?.payload.reason === 'timeout', `and closed for the stated reason (${closed?.payload.reason})`);
    const m = emitted.find((e) => e.name === 'itemMutated' && e.payload.owner === a.pawn);
    ok(m?.payload.baseId === voidPick(BAND, held) && m.payload.chosen === false,
      `the lapse pays the void's own pick (${m?.payload.baseId})`);
    ok(a.items.answerMutation(oa.offerId, oa.offers[0].baseId) === false, 'and a late answer is refused');
    ok(emitted.filter((e) => e.name === 'itemMutated' && e.payload.owner === a.pawn).length === 1,
      'the pack festers exactly once however late the answer is');
  }
}

console.log('a peer that leaves mid-offer still pays the void\'s toll');
{
  const { emitted, held, a } = twoRemotes();
  a.items.dispose();
  ok(!a.items.mutationChoice(), 'the departing pawn\'s window closed with it');
  const closed = emitted.find((e) => e.name === 'mutationChoiceClosed' && e.payload.owner === a.pawn);
  ok(closed?.payload.reason === 'disconnect', `and said why (${closed?.payload.reason})`);
  const m = emitted.find((e) => e.name === 'itemMutated' && e.payload.owner === a.pawn);
  ok(m?.payload.baseId === voidPick(BAND, held) && m.payload.chosen === false,
    `a disconnect resolves to the same pick a silence would (${m?.payload.baseId})`);
}

console.log('the offer is addressed to the one peer that owns it');
{
  const { ctx, a, b, offerFor } = twoRemotes();
  const fakePeer = (id) => ({ id, sent: [], sendEvent(bytes) { this.sent.push(bytes); } });
  const net = new NetHost();
  net.init(ctx);
  const peerA = fakePeer(1), peerB = fakePeer(2);
  net.clients.set(1, { peer: peerA, pawn: a.pawn, inputs: [], lastTick: 0 });
  net.clients.set(2, { peer: peerB, pawn: b.pawn, inputs: [], lastTick: 0 });

  // `NetHost.init` subscribes after the windows above opened, so re-open one.
  peerA.sent.length = 0; peerB.sent.length = 0;
  const oa = offerFor(a.pawn);
  a.items.answerMutation(oa.offerId, oa.offers[0].baseId);
  const decode = (frame) => { const r = new Reader(frame); r.u8(); return { name: r.str(), payload: r.json() }; };
  const namesA = peerA.sent.map((f) => decode(f).name);
  ok(namesA.includes('mutationChoiceClosed'), `the close reached the owning peer (${namesA.join(', ')})`);
  ok(!peerB.sent.map((f) => decode(f).name).includes('mutationChoiceClosed'), 'and reached nobody else');
  ok(!('owner' in decode(peerA.sent[namesA.indexOf('mutationChoiceClosed')]).payload),
    'the host-side owner reference stops at the wire');

  // The reply, arriving as bytes on the peer that owns the pawn.
  const ob = offerFor(b.pawn);
  const pickB = ob.offers[0].baseId;
  net._handleMessage(peerB, writeMutate(new Writer(64), { offerId: ob.offerId, baseId: pickB }).bytes());
  ok(!b.items.mutationChoice() && b.items.count(pickB) === 0, 'a reply off the owning peer resolves that pawn\'s window');

  // The same bytes replayed by the wrong peer touch nothing: peer A's pawn has
  // no open offer left, and peer B's is already resolved.
  const { ctx: ctx2, a: a2, b: b2, offerFor: offerFor2 } = twoRemotes();
  const net2 = new NetHost();
  net2.init(ctx2);
  const pA = fakePeer(1), pB = fakePeer(2);
  net2.clients.set(1, { peer: pA, pawn: a2.pawn, inputs: [], lastTick: 0 });
  net2.clients.set(2, { peer: pB, pawn: b2.pawn, inputs: [], lastTick: 0 });
  const ob2 = offerFor2(b2.pawn);
  net2._handleMessage(pA, writeMutate(new Writer(64), { offerId: ob2.offerId, baseId: ob2.offers[0].baseId }).bytes());
  ok(!!a2.items.mutationChoice() && !!b2.items.mutationChoice(),
    'peer A replaying peer B\'s reply moves neither pack');
}

console.log('the reply message is bounded and reads defensively');
{
  /** Past the kind byte, which the dispatch switch has already eaten. */
  const body = (bytes) => { const r = new Reader(bytes); ok(r.u8() === MSG.MUTATE, 'the reply is its own message kind'); return r; };
  const round = readMutate(body(writeMutate(new Writer(64), { offerId: 7, baseId: 'x-ray' }).bytes()));
  ok(round.offerId === 7 && round.baseId === 'x-ray', 'a well-formed reply survives the round trip');
  const empty = readMutate(body(new Writer(8).u8(MSG.MUTATE).bytes()));
  ok(empty.offerId === 0 && empty.baseId === '', 'a bodiless reply reads as an unanswerable one rather than throwing');
  const long = readMutate(body(writeMutate(new Writer(4096), { offerId: 3, baseId: 'z'.repeat(4000) }).bytes()));
  ok(long.baseId === null, 'an id longer than any item in the game is dropped, not read as a refusal');
  ok(PROTOCOL_VERSION >= 11, `the protocol version moved with the new kind (${PROTOCOL_VERSION})`);
}

console.log('the answering client echoes identifiers and never decides anything');
{
  const { ctx, emitted } = makeCtx({ authority: false });
  const items = new Items();
  items.init(ctx);
  const offers = bases.slice(0, 3).map((id) => ({ baseId: id, blightId: BLIGHT_BY_BASE.get(id).id, count: 2 }));
  // What arrives over the wire: owner stripped by `NetHost._send`, so the
  // client's own HUD reads it as its own — which it is.
  ctx.events.emit('mutationChoiceOffered', { band: BAND, seconds: MUTATION.choiceSeconds, offerId: 4242, offers });
  ok(!!items.mutationChoice(), 'the client holds the offer for the panel to paint');
  ok(items.mutationChoice().remaining === MUTATION.choiceSeconds, 'and a clock for it to count down');

  ok(items.chooseMutation('a-stack-that-does-not-exist') === false, 'a card the offer never carried is not sent at all');
  ok(items.chooseMutation(offers[1].baseId) === true, 'the player\'s pick is accepted for sending');
  const answer = emitted.find((e) => e.name === 'mutationAnswer');
  ok(answer?.payload.offerId === 4242 && answer.payload.baseId === offers[1].baseId,
    'the reply echoes the host\'s own identifier and the card id, and nothing else');
  ok(Object.keys(answer.payload).sort().join(',') === 'baseId,offerId', 'no client-authored card data rides along');
  ok(items.count(offers[1].baseId) === 0, 'and the client mutated nothing itself — the host owns that');
  ok(items.chooseMutation(offers[0].baseId) === false, 'one offer, one reply');
  ok(emitted.filter((e) => e.name === 'mutationAnswer').length === 1, 'so a second press sends no second reply');

  // The join order, which is the order every real client actually boots in:
  // every system inits into a single-player context (`ctx.authority` true) and
  // only becomes a client later, when `NetClient.init` runs at the join. An
  // `Items` that decided its role when it subscribed would hold no offer here —
  // and that is not hypothetical: it is what `coopprobe`'s
  // `remote-mutation-round-trip` caught, three cards painted over a dead button.
  {
    const { ctx: c4, emitted: e4 } = makeCtx({ authority: true });
    const i4 = new Items();
    i4.init(c4);
    c4.authority = false;
    c4.netRole = 'client';
    c4.events.emit('mutationChoiceOffered', { band: BAND, seconds: 12, offerId: 77, offers });
    ok(!!i4.mutationChoice(), 'an Items that booted single-player still hears the offer once it is a client');
    ok(i4.chooseMutation(offers[0].baseId) === true && e4.some((e) => e.name === 'mutationAnswer'),
      'and its card press reaches the wire');
  }

  // Refusal is the same channel with an empty card.
  const { ctx: c2, emitted: e2 } = makeCtx({ authority: false });
  const i2 = new Items();
  i2.init(c2);
  c2.events.emit('mutationChoiceOffered', { band: BAND, seconds: 12, offerId: 99, offers });
  ok(i2.refuseMutation() === true, 'declining is answerable too');
  const r2 = e2.find((e) => e.name === 'mutationAnswer');
  ok(r2?.payload.offerId === 99 && r2.payload.baseId === '', 'and crosses as the same message with no card');

  // The host's close is what ends it, not the client's own clock.
  const { ctx: c3, emitted: e3 } = makeCtx({ authority: false });
  const i3 = new Items();
  i3.init(c3);
  c3.events.emit('mutationChoiceOffered', { band: BAND, seconds: 12, offerId: 5, offers });
  for (let t = 0; t < 12 * 60 + 120; t++) step(c3, i3);
  ok(!e3.some((e) => e.name === 'itemMutated'), 'a client never pays a toll of its own, however long it waits');
  c3.events.emit('mutationChoiceClosed', { band: BAND, reason: 'timeout', baseId: null });
  ok(!i3.mutationChoice(), 'the host\'s close is what clears the panel');
  ok(i3.chooseMutation(offers[0].baseId) === false, 'and a press after it sends nothing');
  ok(!e3.some((e) => e.name === 'mutationAnswer'), 'no reply was ever sent for a window nobody answered');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
