// tests/chest-void-credit.test.mjs
//
// The chest, end to end: what the lid costs, and what the claim costs (issues
// #30, #166, #175). Real `Corruption` and real `Items` on one bus, because the
// property this file exists to hold is a property of the *seam* between them —
// a safe claim is only safe because the automatic `itemPickup` feed declined to
// charge the item the chest paid out, and a stubbed `Items` cannot show that at
// all. `rollItem` is the one seam stubbed: which item the table hands over is
// not the axis under test, and pinning it is what lets the corrupted arm exist.
//
// Chest is exported from Interactables.js purely so this test can construct one
// without dragging in the whole world; the export changes no behaviour.
import * as THREE from 'three';
import { Chest, Interactables } from '../src/world/Interactables.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { SOURCES } from '../src/data/corruption.js';
import { OFFER, premiumFor, salvageFor } from '../src/data/itemOffers.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A common base with a blight counterpart, so all three outcomes are dealt. */
const BASE = 'adrenal-syringe';
const BLIGHT = 'spasm-gland';
const FACE = SOURCES.itemFeed.common + premiumFor('common');

function makeCtx({ gold = 1000, authority = true, rolls = BASE } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    seed: 1234,
    // A seeded stream, not `Math.random`: a stage roll-over draws the stage's
    // equipment off it, and this file's arms must not move between runs.
    rng: new RNG(1234),
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    interactables: {
      spawned: [],
      spawnOrb(position, itemId, arc, ownerPawn) {
        const orb = { position, itemId, arc, ownerPawn };
        this.spawned.push(orb);
        return orb;
      },
      /** Land every orb the way `Interactables.fixedUpdate` does. */
      deliver() {
        for (const o of this.spawned) Items.of(ctx, o.ownerPawn)?.give(o.itemId, 1);
        this.spawned = [];
      },
    },
    audio: null,
  };
  new Items().init(ctx);
  ctx.items.gold = gold;
  // The table is not the axis under test; the claim is.
  ctx.items.rollItem = () => rolls;
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, cor: corruption, emitted };
}

const chestAt = (ctx, x, z, size = 'small', cost = 25) =>
  new Chest(ctx, new THREE.Vector3(x, 0, z), size, cost);

console.log('a paid open spends gold and pays the tithe — and nothing for the item yet');
{
  const { ctx, cor } = makeCtx({ gold: 100 });
  const chest = chestAt(ctx, 4, 9);
  ok(chest.interact() === true, 'open succeeds');
  ok(ctx.items.gold === 75, 'gold was spent');
  ok(cor.world === SOURCES.chestTithe.small, 'the tithe landed, alone');
  ok(cor.seeds.length === 1, 'every greed act plants a seed — paid opens included');
  ok(cor.seeds[0]?.strength === 1, 'a paid open is the gentlest mark');
  ok(cor.seeds[0]?.x === 4 && cor.seeds[0]?.z === 9, 'planted where it happened');
  ok(ctx.interactables.spawned.length === 0, 'no orb yet: the item is offered, not handed over');
  ok(chest.openOffer() !== null, 'the chest holds an open offer');
  ok(chest.used === true, 'chest consumed');
}

console.log('the safe claim delivers the item and feeds NOTHING for it');
{
  const { ctx, cor } = makeCtx({ gold: 100 });
  const chest = chestAt(ctx, 0, 0);
  chest.interact();
  const before = cor.world;
  ok(chest.answer('safe')?.outcome === 'safe', 'the safe card resolves');
  ok(ctx.interactables.spawned.length === 1, 'the item comes out as an orb');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 1, 'and lands in the pack');
  ok(cor.world === before,
    `the claim fed nothing (world ${cor.world}, tithe ${before})`);
  ok(chest.openOffer() === null, 'the window is closed');
}

console.log('the corrupted claim charges once — the premium, and not the pickup too');
{
  const { ctx, cor } = makeCtx({ gold: 100 });
  const chest = chestAt(ctx, 0, 0);
  chest.interact();
  const tithe = cor.world;
  const r = chest.answer('corrupt');
  ok(r?.outcome === 'corrupt', 'the corrupted card resolves');
  ok(cor.world === tithe + FACE, `charged exactly the face price once (${cor.world} = ${tithe} + ${FACE})`);
  ctx.interactables.deliver();
  ok(ctx.items.count(BLIGHT) === 1, 'the blight counterpart landed');
  ok(ctx.items.count(BASE) === 0, 'and the base item did not');
  ok(cor.world === tithe + FACE, 'delivering the orb did not charge a second time');
}

console.log('salvage forgoes the item and wards corruption back out');
{
  const { ctx, cor } = makeCtx({ gold: 1000 });
  // A deep enough world that the ward has something to take back.
  const first = chestAt(ctx, 0, 0, 'legendary', 400);
  first.interact();
  first.answer('safe');
  ctx.interactables.deliver();
  const chest = chestAt(ctx, 1, 1);
  chest.interact();
  const before = cor.world;
  const held = ctx.items.count(BASE);
  const r = chest.answer('salvage');
  ok(r?.outcome === 'salvage', 'the salvage card resolves');
  ok(r.warded === salvageFor('common'), `it warded ${salvageFor('common')}`);
  ok(cor.world === before - salvageFor('common'), 'the world came back down');
  ok(ctx.interactables.spawned.length === 0, 'no item came out — that is the price');
  ok(ctx.items.count(BASE) === held, 'the pack is exactly as it was');
}

console.log('an unanswered window lapses into the safe claim');
{
  const { ctx, cor } = makeCtx({ gold: 100 });
  const chest = chestAt(ctx, 0, 0);
  chest.interact();
  const tithe = cor.world;
  for (let i = 0; i < Math.ceil(OFFER.windowSeconds * 60) + 2; i++) chest.update(1 / 60);
  ok(chest.openOffer() === null, 'the window lapsed');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 1, 'the item is still the player\'s — lapsing is not a punishment');
  ok(cor.world === tithe, `and it cost nothing (world ${cor.world})`);
}

console.log('the claim is billed to the pawn that pressed, not to the local player');
{
  const { ctx, cor } = makeCtx({ gold: 100 });
  const mate = { isPlayer: true, alive: true, peerId: 7 };
  mate.items = new Items(mate);
  mate.items.init(ctx);
  mate.items.rollItem = () => BASE;
  mate.items.gold = 100;
  const chest = chestAt(ctx, 0, 0);
  ok(chest.interact(mate) === true, 'a teammate opens it');
  chest.answer('corrupt');
  ctx.interactables.deliver();
  ok(Items.of(ctx, mate).count(BLIGHT) === 1, 'the teammate got the card');
  ok(ctx.items.count(BLIGHT) === 0, 'and the local pack did not');
  ok(chest.openOffer() === null, 'the offer was theirs to answer');
  void cor;
}

console.log('two chests cannot hold two open offers over one seat');
{
  const { ctx, cor } = makeCtx({ gold: 1000 });
  // The real `Interactables` methods on a real list, with only the orb courier
  // stubbed: `openOfferFor`, `chooseOffer` and `settleOpenOffers` are the code
  // under test and a renderer is not.
  const world = Object.create(Interactables.prototype);
  world.ctx = ctx;
  world.list = [];
  const courier = ctx.interactables;
  world.spawnOrb = courier.spawnOrb.bind(courier);
  const deliver = () => courier.deliver();
  ctx.interactables = world;

  const a = chestAt(ctx, 0, 0);
  const b = chestAt(ctx, 6, 0);
  b.ctx.items.rollItem = () => 'cloven-hoof';
  world.list.push(a, b);

  a.interact();
  const itemA = a.offer.itemId;
  ctx.items.rollItem = () => 'cloven-hoof';
  b.interact();

  ok(a.openOffer() === null, 'opening the second offer settled the first');
  ok(a.offer.outcome === 'safe', 'and settled it as the safe claim, exactly as its own lapse would');
  ok(b.openOffer() !== null, 'the second chest holds the only live offer');
  ok(world.openOfferFor(ctx.player) === b.offer,
    'which is the one the panel is painting, so the press and the picture agree');

  // The press the player makes on what they can see lands on what they can see.
  const r = world.chooseOffer('salvage', ctx.player);
  ok(r?.itemId === 'cloven-hoof', `the press answered the shown chest (${r?.itemId})`);
  ok(b.offer.outcome === 'salvage', 'the shown chest carries the outcome');
  ok(a.offer.outcome === 'safe', 'and the older one was never answered by that press');
  deliver();
  ok(ctx.items.count(itemA) === 1, 'the older chest\'s item is still the player\'s');
  void cor;
}

console.log('a broke player forces the chest open on void credit');
{
  const { ctx, cor } = makeCtx({ gold: 3 });
  const chest = chestAt(ctx, -2, 6, 'legendary', 400);
  ok(chest.interact() === true, 'the void opens it');
  ok(ctx.items.gold === 3, 'no gold taken');
  ok(cor.world === SOURCES.voidCredit.legendary, 'the full credit price landed');
  ok(cor.seeds.length === 1, 'and the void remembers where');
  ok(cor.seeds[0].strength === 3, 'legendary seeds are the strongest');
  chest.answer('safe');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 1, 'the item still comes out');
  ok(cor.world === SOURCES.voidCredit.legendary, 'the forced lid is the whole bill');
}

console.log('greed time deepens the mark on both open paths');
{
  const { ctx, cor } = makeCtx({ gold: 100 });
  ctx.events.emit('teleporterComplete', {});
  const paid = chestAt(ctx, 1, 1);
  ok(paid.interact() === true, 'paid open succeeds during greed time');
  ok(cor.seeds[0]?.strength === 2, 'greed-time paid seed is strength 1 + 1');
  ctx.items.gold = 0;
  const forced = chestAt(ctx, 2, 2, 'large', 60);
  ok(forced.interact() === true, 'void credit still opens during greed time');
  ok(cor.seeds[1]?.strength === 3, 'greed-time large void seed is strength 2 + 1');
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  ctx.items.gold = 100;
  const fresh = chestAt(ctx, 3, 3);
  ok(fresh.interact() === true, 'open on the new stage');
  ok(cor.seeds[2]?.strength === 1, 'a new stage plants gentle seeds again');
}

console.log('the prompt quotes the lid and every claim it can lead to');
{
  const { ctx } = makeCtx({ gold: 100 });
  const chest = chestAt(ctx, 0, 0);
  const p = chest.prompt();
  ok(p.includes('$25'), 'affordable chest quotes gold');
  ok(p.includes(`+${SOURCES.chestTithe.small}-`), 'the floor is the tithe alone — a safe claim is free');
  ok(/salvage/i.test(p) && /warded/.test(p), 'and the ward the third card pays');
  ctx.items.gold = 3;
  ok(/corruption/i.test(chest.prompt()), 'unaffordable chest says corruption');
}

console.log('a client presses nothing open');
{
  const { ctx, cor } = makeCtx({ gold: 100, authority: false });
  const chest = chestAt(ctx, 0, 0);
  chest.interact();
  const before = cor.world;
  ok(chest.answer('corrupt') === null, 'a client cannot settle the transaction');
  ok(cor.world === before, 'and moved nothing trying');
  ok(chest.openOffer() !== null, 'the offer stands for the host to lapse');
}

console.log('without a corruption system, behaviour is exactly the old one');
{
  const { ctx } = makeCtx({ gold: 3 });
  ctx.corruption = null;
  const chest = chestAt(ctx, 0, 0);
  ok(chest.interact() === false, 'a broke player is refused, as before');
  ok(chest.used === false, 'chest untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
