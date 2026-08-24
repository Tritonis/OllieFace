/**
 * The two windows a guest can now answer (issues #204, #205).
 *
 * #175 built one choice panel and #168 built one reply message, and between
 * them they left two holes. A guest who opened a chest saw nothing at all —
 * `itemOfferOpened` was never forwarded, so the host's window lapsed safe and
 * the three-way claim was a decision only the host ever got to make. And the
 * Argent altar's three cards were painted by `prompt()` and then ignored: every
 * press took card 1, because nothing called `selectConsecration`.
 *
 * Both are closed the same way — the #168 machinery, generalised — so the axes
 * under test are the ones that generalisation could break:
 *
 *  1. **A reply reaches its own window and no other.** The pawn is re-derived
 *    from the peer the bytes arrived on and is not a field of the message, so
 *    a forged identifier is the only lie left to tell. Forge one seat's offer
 *    id onto the other seat's connection and the host must move nothing.
 *    Delete the `offer.offerId !== offerId` line in `Interactables.answerOffer`
 *    and 'a forged id is refused' goes red.
 *
 *  2. **The kind discriminator is load-bearing.** A blight window that ends
 *    without an answer pays the toll — that is the whole of #33 and it must
 *    not regress. An argent window that ends without an answer pays *no* toll:
 *    it hands over card 1 and nothing festers, because the player bought a
 *    card rather than crossed a threshold. Blind the discriminator — route
 *    both kinds through `_mutateAt` in `_closeMutationChoice`, or drop `kind`
 *    from `_openChoice` — and 'a lapsed consecration festers nothing' goes red
 *    while the blight arm stays green; route neither and the blight arm goes
 *    red instead. One flag, two opposite failures.
 *
 *  3. **The two id spaces do not collide.** `Items` and `itemTransaction` mint
 *    offer identifiers independently, so the same number is live in both as a
 *    matter of course. Delete the target byte from `writeMutate`/`readMutate`
 *    and a chest answer resolves a blight toll.
 *
 * Real `Items`, a real `NetHost` over fake peers, real `openItemOffer`
 * transactions and the real `Interactables` manager — nothing here mirrors the
 * code it tests.
 */
import * as THREE from 'three';
import { Items } from '../src/systems/Items.js';
import { Interactables } from '../src/world/Interactables.js';
import { openItemOffer } from '../src/world/itemTransaction.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { Reader, Writer, writeMutate, readMutate, MSG, MUTATE_TARGET } from '../src/net/Protocol.js';
import { BLIGHT_BY_BASE, ITEMS_BY_TIER } from '../src/data/items.js';
import { MUTATION } from '../src/data/corruption.js';
import { OFFER } from '../src/data/itemOffers.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const SEED = 8080;
const bases = [...BLIGHT_BY_BASE.keys()].sort();

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority, seed: SEED, rng: new RNG(31337), time: 0,
    netRole: authority ? 'host' : 'client',
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
        return () => { const a = listeners.get(name); a.splice(a.indexOf(fn), 1); };
      },
    },
  };
  return { ctx, emitted };
}

/** A chest-shaped holder for a real transaction, so `_offerHolder` finds it the
 *  way it finds a real lid: by asking every interactable what it has open. */
function holder(offer) {
  return {
    group: new THREE.Group(),
    position: new THREE.Vector3(),
    radius: 1, enabled: true,
    available: () => false,
    openOffer: () => (offer.resolved ? null : offer),
    answer: (outcome) => offer.resolve(outcome),
    update() {}, fixedUpdate() {}, dispose() {},
  };
}

const itemFor = () => ITEMS_BY_TIER.common[0].id;

// -------------------------------------------------------------- #205, guard (a)

console.log("a guest's answer resolves its own offer and reaches no other seat's");
{
  const { ctx } = makeCtx();
  const inter = new Interactables();
  inter.init(ctx);

  const pawnA = { isPlayer: true, alive: true, netId: 11, position: new THREE.Vector3() };
  const pawnB = { isPlayer: true, alive: true, netId: 12, position: new THREE.Vector3() };
  for (const p of [pawnA, pawnB]) { p.items = new Items(p); p.items.init(ctx); }

  const id = itemFor();
  const offerA = openItemOffer(ctx, { itemId: id, owner: pawnA, seconds: OFFER.windowSeconds });
  const offerB = openItemOffer(ctx, { itemId: id, owner: pawnB, seconds: OFFER.windowSeconds });
  inter.list.push(holder(offerA), holder(offerB));
  ok(offerA.offerId !== offerB.offerId, `two seats, two identifiers (${offerA.offerId} vs ${offerB.offerId})`);

  // The host end of the wire, driven exactly as `_onMutate` drives it.
  const host = new NetHost();
  host.ctx = ctx;
  const deliver = (pawn, offerId, outcome) => {
    const w = new Writer(96);
    writeMutate(w, { offerId, baseId: outcome, target: MUTATE_TARGET.OFFER });
    const r = new Reader(w.bytes());
    r.u8();
    const m = readMutate(r, {});
    ok(m.target === MUTATE_TARGET.OFFER, 'the answer says which window it answers');
    return ctx.interactables.answerOffer(pawn, m.offerId, m.baseId);
  };

  // B's connection, carrying A's identifier. Structurally the pawn is B's, so
  // the only thing left to check is the id — and it is not B's offer's.
  const forged = deliver(pawnB, offerA.offerId, 'salvage');
  ok(forged === null, 'a forged id is refused');
  ok(offerA.resolved === false, "and the other seat's offer is untouched");
  ok(offerB.resolved === false, 'as is the forger\'s own');

  // A zero from a truncated message, and an offer nobody minted.
  ok(deliver(pawnB, 0, 'salvage') === null, 'a zero identifier is refused');
  ok(deliver(pawnB, 0xffff, 'salvage') === null, 'an identifier nobody minted is refused');
  ok(offerB.resolved === false, 'and none of it moved the offer');

  // The honest reply does land.
  const done = deliver(pawnB, offerB.offerId, 'salvage');
  ok(done?.outcome === 'salvage', "a guest's own identifier resolves its own offer");
  ok(offerB.resolved === true && offerA.resolved === false,
    'exactly one of the two offers resolved');
  // ...and only once: the second copy of a duplicated reply finds nothing open.
  ok(deliver(pawnB, offerB.offerId, 'corrupt') === null, 'a second copy of the answer is refused');
  ok(offerB.outcome === 'salvage', 'the first answer stands');
  void host;
}

console.log('the guest end sends one answer, shaped for the offer target');
{
  const { ctx, emitted } = makeCtx({ authority: false });
  const inter = new Interactables();
  inter.init(ctx);
  const sent = [];
  const client = new NetClient();
  client.init(ctx);
  client.peer = { sendEvent: (b) => sent.push(b) };

  ctx.events.emit('itemOfferOpened', {
    kind: 'item', itemId: itemFor(), offerId: 77, owner: null, seconds: 8, quote: { itemId: itemFor() },
  });
  ok(inter.openOfferFor(ctx.player)?.offerId === 77, 'the forwarded offer raises a panel on the guest');
  ok(inter.openOfferFor(ctx.player)?.remaining === 8, 'with the host\'s clock on it');
  inter.fixedUpdate(ctx, 1 / 60);
  ok(inter.openOfferFor(ctx.player).remaining < 8, 'that counts down locally');

  ok(inter.chooseOffer('corrupt') === null, 'a guest press decides nothing locally');
  ok(emitted.some((e) => e.name === 'itemOfferAnswer' && e.payload.outcome === 'corrupt'),
    'and rides the bus as an answer instead');
  ok(sent.length === 1, 'which reaches the wire exactly once');
  const r = new Reader(sent[0]);
  ok(r.u8() === MSG.MUTATE, 'as a MUTATE');
  const m = readMutate(r, {});
  ok(m.offerId === 77 && m.baseId === 'corrupt' && m.target === MUTATE_TARGET.OFFER,
    `carrying the host's own identifier and the outcome named (${m.offerId}/${m.baseId}/${m.target})`);

  ok(inter.chooseOffer('safe') === null, 'a second press decides nothing');
  ok(sent.length === 1, 'and sends nothing — one window, one reply');

  // The host's close ends it, and only its own close does.
  ctx.events.emit('itemOfferOpened', { kind: 'item', itemId: itemFor(), offerId: 78, owner: null, seconds: 8, quote: {} });
  ctx.events.emit('itemOfferResolved', { offerId: 77, outcome: 'safe', owner: null });
  ok(inter.openOfferFor(ctx.player)?.offerId === 78, "a stale close leaves the live window standing");
  ctx.events.emit('itemOfferResolved', { offerId: 78, outcome: 'safe', owner: null });
  ok(inter.openOfferFor(ctx.player) === null, 'its own close ends it');
}

console.log('the host forwards an item offer to the seat it belongs to');
{
  const { ctx } = makeCtx();
  const host = new NetHost();
  host.init(ctx);
  const pawn = { isPlayer: true, alive: true, netId: 21 };
  const other = { isPlayer: true, alive: true, netId: 22 };
  const boxes = { mine: [], theirs: [] };
  host.clients.set(1, { peer: { id: 1, sendEvent: (b) => boxes.mine.push(b) }, pawn, inputs: [], lastTick: 0 });
  host.clients.set(2, { peer: { id: 2, sendEvent: (b) => boxes.theirs.push(b) }, pawn: other, inputs: [], lastTick: 0 });

  // A real transaction's own quote, so the depth the payload actually has is
  // the depth `sanitise` is tested at: the panel paints its cards off
  // `quote[outcome].reward.itemId`, which is three objects down, and a quote
  // that arrives flattened is a guest looking at a blank window.
  pawn.items = new Items(pawn);
  pawn.items.init(ctx);
  const real = openItemOffer(ctx, { itemId: itemFor(), owner: pawn, seconds: OFFER.windowSeconds });
  ok(boxes.mine.length === 1, 'the owning seat is told');
  ok(boxes.theirs.length === 0, 'and nobody else is');
  const r = new Reader(boxes.mine[0]);
  r.u8();
  ok(r.str() === 'itemOfferOpened', 'by name');
  const wire = JSON.parse(r.str());
  ok(wire.offerId === real.offerId, 'carrying the offer identifier the answer must echo');
  ok(wire.owner == null, 'and no owner tag — an addressed event means "yours"');
  ok(Array.isArray(wire.quote?.outcomes) && wire.quote.outcomes.length === 3,
    `with all three claims (${wire.quote?.outcomes?.join?.(', ')})`);
  ok(typeof wire.quote?.corrupt?.reward?.itemId === 'string',
    `and the corrupted reward survives the depth (${wire.quote?.corrupt?.reward?.itemId})`);
  boxes.mine.length = 0;

  real.resolve('safe');
  const named = boxes.mine.map((b) => { const q = new Reader(b); q.u8(); return { name: q.str(), body: JSON.parse(q.str()) }; });
  ok(boxes.theirs.length === 0, 'and nobody else hears the close either');
  const close = named.find((e) => e.name === 'itemOfferResolved');
  ok(!!close, 'the close is addressed to the owning seat');
  ok(close?.body.offerId === real.offerId, 'naming the window it closes');
}

// -------------------------------------------------------------- #204, guard (b)

/** An `Items` one step past a band crossing, with a window standing. */
function blightWindow() {
  const { ctx, emitted } = makeCtx();
  const items = new Items();
  items.init(ctx);
  for (const id of bases.slice(0, 4)) items.give(id, 2);
  ctx.events.emit('corruptionBand', { band: MUTATION.minBand, prev: 0 });
  items.fixedUpdate(ctx, 1 / 60);
  return { ctx, items, emitted };
}

/** An argent window over three cards, opened the way the altar opens it: the
 *  purchase already charged, the resolution supplied by the caller. */
function argentWindow() {
  const { ctx, emitted } = makeCtx();
  const items = new Items();
  items.init(ctx);
  for (const id of bases.slice(0, 4)) items.give(id, 2);
  const cards = ITEMS_BY_TIER.argent.slice(0, 3).map((d) => ({ baseId: d.id, argentId: d.id, argentName: d.name, argentDescription: '', held: 0 }));
  const taken = [];
  const opened = items.openArgentChoice({
    cards, seconds: 8, resolve: (id) => { taken.push(id ?? cards[0].baseId); items.grant(id ?? cards[0].baseId); },
  });
  return { ctx, items, emitted, cards, taken, opened };
}

console.log('a lapsed blight window still pays the toll');
{
  const { ctx, items, emitted } = blightWindow();
  const before = bases.slice(0, 4).map((id) => items.count(id));
  for (let i = 0; i < 60 * (MUTATION.choiceSeconds + 1); i++) items.fixedUpdate(ctx, 1 / 60);
  const closed = emitted.filter((e) => e.name === 'mutationChoiceClosed').map((e) => e.payload);
  ok(closed.length === 1 && closed[0].reason === 'timeout', 'the window lapses');
  ok(closed[0].kind === 'blight', 'as a blight window');
  ok(emitted.some((e) => e.name === 'itemMutated'), 'and something festers — the toll is paid');
  const after = bases.slice(0, 4).map((id) => items.count(id));
  ok(after.join() !== before.join(), `a stack was taken (${before.join()} -> ${after.join()})`);
}

console.log('a lapsed consecration hands over card 1 and festers nothing');
{
  const { ctx, items, emitted, cards, taken, opened } = argentWindow();
  ok(opened === true, 'the window opens');
  const offered = emitted.find((e) => e.name === 'mutationChoiceOffered').payload;
  ok(offered.kind === 'argent', 'and says which kind it is');
  ok(offered.offers.length === 3 && offered.offers[0].argentName, 'carrying argent cards, not blight ones');
  const before = bases.slice(0, 4).map((id) => items.count(id));
  for (let i = 0; i < 60 * 9; i++) items.fixedUpdate(ctx, 1 / 60);
  const closed = emitted.filter((e) => e.name === 'mutationChoiceClosed').map((e) => e.payload);
  ok(closed.length === 1 && closed[0].reason === 'timeout' && closed[0].kind === 'argent', 'it lapses as an argent window');
  ok(taken.length === 1 && taken[0] === cards[0].baseId, `and card 1 is delivered (${taken[0]})`);
  // The guard the kind exists for.
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'nothing festered');
  ok(!emitted.some((e) => e.name === 'itemStabilised'), 'and nothing was reshuffled either');
  ok(bases.slice(0, 4).map((id) => items.count(id)).join() === before.join(),
    'every held stack is exactly where it was — no toll on an argent lapse');
}

console.log('an argent card is answerable, and answers nothing else');
{
  const { items, cards, taken, emitted } = argentWindow();
  const offerId = emitted.find((e) => e.name === 'mutationChoiceOffered').payload.offerId;
  ok(items.answerMutation(offerId + 1, cards[1].baseId) === false, "another window's identifier is refused");
  ok(items.answerMutation(offerId, 'not-a-card') === false, 'a card that was never offered is refused');
  ok(taken.length === 0, 'and neither moved anything');
  ok(items.answerMutation(offerId, cards[1].baseId) === true, 'the offered card, under the right id, is taken');
  ok(taken.join() === cards[1].baseId, `card 2 was delivered (${taken.join()})`);
  ok(items.answerMutation(offerId, cards[2].baseId) === false, 'and the window is gone — no second answer');
  ok(taken.length === 1, 'one window, one card');
}

console.log('the two id spaces cannot answer each other');
{
  // A choice window and an item offer standing at once on one pawn. The two
  // counters are independent, so their numbers overlap as a matter of course —
  // and the target byte is the only thing that says which one an answer meant.
  const { ctx, items, emitted } = blightWindow();
  const inter = new Interactables();
  inter.init(ctx);
  const tollId = emitted.find((e) => e.name === 'mutationChoiceOffered').payload.offerId;
  const pawn = ctx.player;
  pawn.items = items;
  const offer = openItemOffer(ctx, { itemId: itemFor(), owner: pawn, seconds: OFFER.windowSeconds });
  inter.list.push(holder(offer));

  // The real dispatch, off real bytes: `NetHost._onMutate` is what decides
  // which window an answer meant, and it is the code under test here.
  const route = (host, seat, id, body, target) => {
    const w = new Writer(96);
    writeMutate(w, { offerId: id, baseId: body, target });
    const r = new Reader(w.bytes());
    r.u8();
    host._onMutate({ pawn: seat }, r);
  };
  const host = new NetHost();
  host.ctx = ctx;

  // A chest answer carrying the *toll's* identifier. It must reach the offer
  // side and be judged there — never the toll — whether or not the numbers
  // happen to collide today.
  // The positive half first, and it is what makes the byte load-bearing rather
  // than merely present: under the offer target the answer reaches the *offer*,
  // with a toll window standing on the same pawn the whole time. Ignore the
  // byte and this answer is handed to `answerMutation`, which has no such card.
  route(host, pawn, offer.offerId, 'salvage', MUTATE_TARGET.OFFER);
  ok(offer.resolved === true && offer.outcome === 'salvage',
    'a chest answer reaches the chest');
  ok(items.hasChoiceWindow() === true, 'and the toll window is still standing after it');

  // ...and the toll's own identifier, sent under the offer target, reaches no
  // window at all: the offer it names is not one, whether or not the two
  // counters happen to collide today.
  const second = openItemOffer(ctx, { itemId: itemFor(), owner: pawn, seconds: OFFER.windowSeconds });
  inter.list.push(holder(second));
  route(host, pawn, tollId, 'safe', MUTATE_TARGET.OFFER);
  ok(items.hasChoiceWindow() === true, 'a chest answer never closes the toll window');
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'and no stack was taken by it');
  ok(second.resolved === (tollId === second.offerId),
    'and it touches an offer only when it is genuinely that offer\'s own id');

  // ...and a toll answer carrying the *chest's* identifier, on a fresh pair so
  // the first arm's resolution cannot be mistaken for this one's.
  const f = blightWindow();
  const inter2 = new Interactables();
  inter2.init(f.ctx);
  const pawn2 = f.ctx.player;
  pawn2.items = f.items;
  const offer2 = openItemOffer(f.ctx, { itemId: itemFor(), owner: pawn2, seconds: OFFER.windowSeconds });
  inter2.list.push(holder(offer2));
  const host2 = new NetHost();
  host2.ctx = f.ctx;
  route(host2, pawn2, offer2.offerId, bases[0], MUTATE_TARGET.CHOICE);
  ok(offer2.resolved === false, 'a toll answer never resolves an item offer');

  // The byte is load-bearing and not decoration: a message that omits it reads
  // as the choice target, which is what every pre-#205 client sends.
  const bare = new Writer(96);
  bare.u8(MSG.MUTATE).u32(offer2.offerId >>> 0);
  const br = new Reader(bare.bytes());
  br.u8();
  ok(readMutate(br, {}).target === MUTATE_TARGET.CHOICE,
    'a truncated answer falls back to the window that was the whole message before');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
