// Who pays, and who gets paid. Three axes, one rule: the *acting* pawn owns
// the transaction, never whoever this machine happens to be rendering.
//
//   1. A kill pays every registered pawn the full reward (no split).
//   2. An interact spends the acting pawn's purse.
//   3. A void-credit open attributes the corruption to the acting pawn.
//   4. Every economy event names its owner, host-local consumers act only on
//      the viewer's own, and the wire carries each one to one peer.
//
// Real Items and real Corruption; the world around them is stubbed, because
// the axis under test is ownership, not the loot table.
import * as THREE from 'three';
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Chest, Interactables } from '../src/world/Interactables.js';
import { SOURCES } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';
import { NetHost } from '../src/net/NetHost.js';
import { Coop } from '../src/net/Coop.js';
import { Player } from '../src/entities/Player.js';
import { Reader } from '../src/net/Protocol.js';
import { BLIGHT_BY_BASE } from '../src/data/items.js';
import { MUTATION } from '../src/data/corruption.js';
import { isLocalOwner } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  return {
    authority: true,
    seed: 90210,
    rng: new RNG(90210),
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    interactables: { orbs: [], spawnOrb(pos, id) { this.orbs.push(id); } },
    audio: null,
  };
}

/** A roster of exactly the pawns handed in — `all` and `count`, nothing else. */
const fakeRoster = (...pawns) => ({ all: pawns, get count() { return this.all.length; } });

console.log('a kill pays every registered pawn the full reward');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;
  ctx.roster = fakeRoster(host, remote);

  hostItems.gold = 0;
  remoteItems.gold = 0;
  const victim = { def: { cost: 100 }, position: new THREE.Vector3() };
  const expected = hostItems.killReward(victim);

  Items.rewardKillAll(ctx, victim);

  ok(expected > 0, 'the fixture victim is actually worth something');
  ok(hostItems.gold === expected, 'the host pawn was paid in full');
  ok(remoteItems.gold === expected, 'the remote pawn was paid in full too — no split, no kill steal');
}

console.log('a roster of one is the single-player call, unchanged');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  ctx.player = host;
  const hostItems = new Items();
  hostItems.init(ctx);
  hostItems.gold = 0;
  ctx.roster = fakeRoster(host);

  const victim = { def: { cost: 100 }, position: new THREE.Vector3() };
  const expected = hostItems.killReward(victim);
  Items.rewardKillAll(ctx, victim);
  ok(hostItems.gold === expected, 'the lone pawn is paid exactly once');

  // …and with no roster registered at all.
  ctx.roster = null;
  hostItems.gold = 0;
  Items.rewardKillAll(ctx, victim);
  ok(hostItems.gold === expected, 'no roster still pays the viewer');
}

console.log('an interact spends the acting pawn\'s purse, not the viewer\'s');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;

  hostItems.gold = 500;
  remoteItems.gold = 500;
  const corruption = new Corruption();
  corruption.init(ctx);

  const chest = new Chest(ctx, new THREE.Vector3(4, 0, 9), 'small', 25);
  ok(chest.interact(remote) === true, 'the remote pawn opens the chest');
  ok(remoteItems.gold === 475, 'the remote pawn paid');
  ok(hostItems.gold === 500, 'the viewer\'s purse is untouched');
}

console.log('void credit is charged to the pawn that forced the lid');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;

  hostItems.gold = 5000;   // the viewer could easily have paid — and must not
  remoteItems.gold = 3;
  const corruption = new Corruption();
  corruption.init(ctx);

  const chest = new Chest(ctx, new THREE.Vector3(-2, 0, 6), 'legendary', 400);
  ok(chest.interact(remote) === true, 'the void opens it for the broke pawn');
  ok(hostItems.gold === 5000 && remoteItems.gold === 3, 'nobody\'s gold moved');
  ok(corruption.corruptionOf(remote) === SOURCES.voidCredit.legendary, 'the remote pawn carries the debt');
  ok(corruption.corruptionOf(host) === 0, 'the viewer carries none of it');
}

console.log('a bare interact() still means the local viewer');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  ctx.player = host;
  const hostItems = new Items();
  hostItems.init(ctx);
  hostItems.gold = 3;
  const corruption = new Corruption();
  corruption.init(ctx);

  const chest = new Chest(ctx, new THREE.Vector3(1, 0, 1), 'small', 25);
  ok(chest.interact() === true, 'the void opens it');
  ok(corruption.corruptionOf(host) === SOURCES.voidCredit.small, 'the debt lands on ctx.player');
}

console.log('an owned orb grants to its owner, even collected at another pawn\'s position');
{
  const ctx = makeCtx();
  ctx.fxRng = new RNG(1);
  const host = { isPlayer: true, alive: true, position: new THREE.Vector3(0, 0, 0) };
  const remote = { isPlayer: true, alive: true, peerId: 2, position: new THREE.Vector3(50, 0, 50) };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;
  ctx.roster = fakeRoster(host, remote);

  const interactables = new Interactables();
  interactables.ctx = ctx;
  ctx.interactables = interactables;

  const orb = interactables.spawnOrb(host.position.clone(), 'adrenal-syringe', 1.5, remote);
  // The fixture "collects" it at the local pawn's position — ownership, not
  // position, decides who gets paid.
  orb.position.copy(host.position);
  orb.claimed = true;
  interactables.fixedUpdate(ctx, 1 / 60);

  ok(remoteItems.count('adrenal-syringe') === 1, 'the owning pawn received the item');
  ok(hostItems.count('adrenal-syringe') === 0, 'the local viewer got nothing — it was never their orb');
}

console.log('an owner-less orb grants exactly as today — to ctx.items');
{
  const ctx = makeCtx();
  ctx.fxRng = new RNG(1);
  const host = { isPlayer: true, alive: true, position: new THREE.Vector3(0, 0, 0) };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);

  const interactables = new Interactables();
  interactables.ctx = ctx;
  ctx.interactables = interactables;

  const orb = interactables.spawnOrb(host.position.clone(), 'adrenal-syringe', 1.5);
  orb.claimed = true;
  interactables.fixedUpdate(ctx, 1 / 60);

  ok(hostItems.count('adrenal-syringe') === 1, 'the owner-less orb still grants to the viewer, unchanged');
}

/**
 * Drives an owned orb through the real arc -> hover -> seek -> claimed state
 * machine (no manual `claimed`/`position` overrides) so the homing target and
 * the grant recipient are exercised by the same code path a real pickup uses.
 * Caps at 400 fixed steps (~6.7s of sim time) so a regression that never
 * claims fails loudly instead of hanging the suite.
 */
function collectNaturally(interactables, ctx, orb) {
  for (let i = 0; i < 400 && !orb.claimed; i++) interactables.fixedUpdate(ctx, 1 / 60);
  return orb.claimed;
}

for (const [label, makeUntargetable] of [
  ['alive:false', (p) => { p.alive = false; }],
  ['downed:true', (p) => { p.downed = true; }],
]) {
  console.log(`an owner who goes untargetable mid-flight (${label}) pays the fallback, not the dead owner`);
  {
    const ctx = makeCtx();
    ctx.fxRng = new RNG(1);
    const host = { isPlayer: true, alive: true, position: new THREE.Vector3(0, 0, 0) };
    const remote = { isPlayer: true, alive: true, downed: false, peerId: 2, position: new THREE.Vector3(0, 0, 0) };
    ctx.player = host;

    const hostItems = new Items();
    hostItems.init(ctx);
    const remoteItems = new Items(remote);
    remoteItems.init(ctx);
    remote.items = remoteItems;
    ctx.roster = fakeRoster(host, remote);

    const interactables = new Interactables();
    interactables.ctx = ctx;
    ctx.interactables = interactables;

    // Owned by remote, but remote is untargetable from the moment it's
    // tossed — homing must fall back to the local viewer (host) for the
    // orb's entire flight, and the grant must follow the same pawn.
    const orb = interactables.spawnOrb(host.position.clone(), 'adrenal-syringe', 1.5, remote);
    makeUntargetable(remote);

    ok(collectNaturally(interactables, ctx, orb), 'the orb was claimed within the step budget');
    ok(hostItems.count('adrenal-syringe') === 1, 'the fallback pawn (host) received the item');
    ok(remoteItems.count('adrenal-syringe') === 0, 'the untargetable owner\'s inventory is unchanged');
  }
}

// --------------------------------------------------------------- owner tags
//
// From here down: the tag itself, the host-local consumers that must read it,
// and the wire that routes on it.

/** Records every economy event the bus carries, in order. */
function watchEconomy(ctx) {
  const seen = [];
  for (const name of ['itemPickup', 'goldChanged', 'goldReward', 'equipmentChanged', 'itemMutated']) {
    ctx.events.on(name, (p) => seen.push({ name, p }));
  }
  seen.last = (name) => [...seen].reverse().find((e) => e.name === name)?.p;
  return seen;
}

console.log('every economy event names the pawn it belongs to');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;
  const seen = watchEconomy(ctx);

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;

  remoteItems.addGold(10);
  ok(seen.last('goldChanged')?.owner === remote, 'a satellite tags goldChanged with its own pawn');

  remoteItems.give('adrenal-syringe', 1);
  ok(seen.last('itemPickup')?.owner === remote, 'itemPickup carries the owner');

  remoteItems.setEquipment(remoteItems.rollEquipment());
  ok(seen.last('equipmentChanged')?.owner === remote, 'equipmentChanged carries the owner');

  remoteItems.rewardKill({ def: { cost: 100 }, position: new THREE.Vector3() });
  ok(seen.last('goldReward')?.owner === remote, 'goldReward carries the owner');

  hostItems.addGold(5);
  ok(seen.last('goldChanged')?.owner === host, 'the viewer\'s own instance tags ctx.player, never null');
}

// `playerHurt` is deliberately NOT exercised for a satellite here. `Combat.js:565`
// emits it for `ctx.player` alone and nothing re-emits a remote pawn's hit onto
// the host bus, so a satellite's subscription is inert by construction — see the
// KNOWN GAP note at its subscription. Asserting on a payload production never
// produces would be assurance about a path that does not exist. What is real, and
// is what this arm keeps, is the *viewer's* side: a teammate's hit must not reset
// the viewer's hurt timer, whatever puts one on the bus.
console.log('a teammate\'s blood is not the viewer\'s hurt timer');
{
  const ctx = makeCtx();
  ctx.time = 12;
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);

  ctx.events.emit('playerHurt', { target: host, amount: 5 });
  ok(hostItems._lastHurt === 12, 'the viewer felt its own');

  hostItems._lastHurt = -999;
  ctx.events.emit('playerHurt', { target: remote, amount: 5 });
  ok(hostItems._lastHurt < 0, 'and never felt the remote pawn\'s');
}

console.log('a satellite\'s item hooks act on its own pawn, never on the viewer\'s body');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true, health: 200, shield: 0, stats: { maxHealth: 200 } };
  const remote = { isPlayer: true, alive: true, peerId: 2, health: 200, shield: 0, stats: { maxHealth: 200 } };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;

  // The lunar is held by the satellite alone — the viewer's pack is empty. Its
  // `onAbility` hook bills `api.player`'s health for every cast.
  remoteItems.give('gale-reliquary', 1);
  ctx.events.emit('abilityUsed', { slot: 'special', ability: { slot: 'special' }, player: remote });

  ok(remote.health < 200, `the caster paid for its own cast (${remote.health})`);
  ok(host.health === 200,
    'the viewer paid nothing — a client\'s inventory cannot bill the host\'s health');

  // The other half of the same binding: everything the hook API writes onto a
  // body goes to the owner, and decays there.
  remoteItems.addBarrier(40);
  ok(remote.shield === 40 && host.shield === 0, 'a satellite\'s barrier lands on its own pawn');
  remoteItems.fixedUpdate(ctx, 1 / 60);
  ok(remote.shield < 40 && host.shield === 0, 'and decays there, not on the viewer');
}

console.log('a satellite is stepped by Coop, so its corruption toll is actually paid');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;

  const base = [...BLIGHT_BY_BASE.keys()].sort()[0];
  const blight = BLIGHT_BY_BASE.get(base).id;
  hostItems.give(base, 5);
  remoteItems.give(base, 5);

  const mutated = [];
  ctx.events.on('itemMutated', (e) => mutated.push(e));
  ctx.events.emit('corruptionBand', { band: MUTATION.minBand, prev: 0 });

  // The engine steps exactly one `Items` — the registered singleton.
  hostItems.fixedUpdate(ctx, 1 / 60);
  ok(hostItems.count(blight) === 5, 'the viewer\'s pack festered on the engine\'s own step');
  ok(remoteItems.count(base) === 5, 'the satellite\'s has not — nothing has stepped it yet');

  // Coop is the seam that steps a satellite: it owns the pawn's whole lifecycle.
  const coop = new Coop();
  coop.ctx = ctx;
  coop.pawns = [remote];
  coop.fixedUpdate(ctx, 1 / 60);

  ok(remoteItems.count(base) === 0 && remoteItems.count(blight) === 5,
    'once Coop steps it, the satellite pays the same toll');
  ok(mutated.length === 2 && mutated.some((e) => e.owner === remote),
    'and its itemMutated names the pawn whose pack festered');

  coop.fixedUpdate(ctx, 1 / 60);
  ok(mutated.length === 2, 'the queue drained — a second step mutates nothing again');
}

console.log('a remote pawn\'s jump launches the remote pawn');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);

  // A pawn shaped exactly as much as `Player._jump` reads, so the real method
  // runs: the launch has to come out of the *jumper's* bank.
  const remote = {
    isPlayer: true, alive: true, peerId: 2, local: false,
    jumpBuffer: 0, jumpsUsed: 0, grounded: true, coyote: 0, moving: true,
    stats: { jumpCount: 1, moveSpeed: 8 },
    velocity: new THREE.Vector3(), position: new THREE.Vector3(),
    groundNormal: new THREE.Vector3(0, 1, 0),
    _wish: new THREE.Vector3(1, 0, 0), _fwd: new THREE.Vector3(1, 0, 0),
    _replaying: false, _cmdTick: 1, _jumpImpulses: new Map(),
    _recordJumpImpulse: Player.prototype._recordJumpImpulse,
  };
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;

  // Waxed Wing: `onJump` banks a horizontal launch through `applyImpulse`.
  remoteItems.give('waxed-wing', 1);

  Player.prototype._jump.call(remote, ctx, 1 / 60, true);

  ok(remote.velocity.x > 0, `the remote pawn was launched (${remote.velocity.x.toFixed(2)} m/s)`);
  ok(remoteItems.consumeImpulse() === 0, 'its bank was spent, not left sitting');
  ok(hostItems.consumeImpulse() === 0, 'and the viewer\'s bank was never touched');
}

/** One EVENT frame off a fake peer's outbox, decoded. `Writer.bytes()` hands
 * out an `ArrayBuffer`, which is exactly what a `Reader` takes. */
function decodeEvent(frame) {
  const r = new Reader(frame);
  r.u8();
  return { name: r.str(), payload: r.json() };
}

const fakePeer = (id) => ({ id, sent: [], sendEvent(b) { this.sent.push(b); } });

console.log('an owned economy event reaches exactly the peer that owns it');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const pawnA = { isPlayer: true, alive: true, peerId: 1, netId: 11 };
  const pawnB = { isPlayer: true, alive: true, peerId: 2, netId: 12 };
  ctx.player = host;

  const net = new NetHost();
  net.init(ctx);
  const peerA = fakePeer(1), peerB = fakePeer(2);
  net.clients.set(1, { peer: peerA, pawn: pawnA });
  net.clients.set(2, { peer: peerB, pawn: pawnB });

  const itemsB = new Items(pawnB);
  itemsB.init(ctx);
  pawnB.items = itemsB;

  itemsB.addGold(40);
  ok(peerB.sent.length === 1 && peerA.sent.length === 0, 'only the owning peer was told');
  const msg = decodeEvent(peerB.sent[0]);
  ok(msg.name === 'goldChanged' && msg.payload.gold === 40, `the frame is the purse (${msg.name})`);
  ok(!('owner' in msg.payload), 'the host-side owner ref never reaches the wire');

  peerA.sent.length = 0; peerB.sent.length = 0;
  itemsB.give('adrenal-syringe', 1);
  ok(peerB.sent.length === 1 && peerA.sent.length === 0, 'a pickup is directed the same way');
  ok(decodeEvent(peerB.sent[0]).name === 'itemPickup', 'and it is the pickup');

  peerA.sent.length = 0; peerB.sent.length = 0;
  const hostItems = new Items();
  hostItems.init(ctx);
  hostItems.addGold(7);
  ok(peerA.sent.length === 0 && peerB.sent.length === 0,
    'the host player\'s own economy is replicated to nobody');
}

console.log('one kill, one reward on the viewer\'s screen');
{
  const ctx = makeCtx();
  const host = { isPlayer: true, alive: true };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const hostItems = new Items();
  hostItems.init(ctx);
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  remote.items = remoteItems;
  ctx.roster = fakeRoster(host, remote);

  let all = 0, mine = 0;
  ctx.events.on('goldReward', (e) => { all++; if (isLocalOwner(ctx, e)) mine++; });
  Items.rewardKillAll(ctx, { def: { cost: 100 }, position: new THREE.Vector3() });

  ok(all === 2, 'both pawns were paid — the full-payout rule is untouched');
  ok(mine === 1, 'exactly one reward belongs to the viewer, so exactly one popup');
}

console.log('a satellite\'s equipment never enters the viewer\'s logbook');
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const { Profile } = await import('../src/systems/Profile.js');

  const ctx = makeCtx();
  ctx.netRole = 'host';
  const host = { isPlayer: true, alive: true, survivorId: null };
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const profile = new Profile();
  profile.init(ctx);

  const remoteItems = new Items(remote);
  remoteItems.init(ctx);
  const rolled = remoteItems.rollEquipment();
  remoteItems.setEquipment(rolled);
  ok(profile.isDiscovered('equipment', rolled) === false,
    'the remote pawn\'s equipment is not something this profile has met');

  remoteItems.give('adrenal-syringe', 1);
  ok(profile.isDiscovered('item', 'adrenal-syringe') === false,
    'nor is the remote pawn\'s loot');

  const hostItems = new Items();
  hostItems.init(ctx);
  hostItems.setEquipment('blink-anchor');
  ok(profile.isDiscovered('equipment', 'blink-anchor') === true,
    'the viewer\'s own equipment still records, exactly as in single-player');
}

// The reject path at the real consumers. `Audio` and `Progression` both stand up
// in node behind small stubs (a no-op DOM for the unlock listeners, a scene stub
// for Interactables), so these are the live subscriptions, not copies of them.
// HUD's reject path is covered against a real `HUD.bind` in
// `tests/item-mutation.test.mjs`. `VFX` is the one filter with no test: its
// `init` builds a particle atlas through a real 2D canvas (`ParticleSystem.js:400`
// reads back `ImageData`), which node has no way to provide.
console.log('a foreign-owned event moves nothing at the real consumers');
{
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.localStorage ??= {
    getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
  };
  const { Audio } = await import('../src/systems/Audio.js');
  const { Progression } = await import('../src/systems/Progression.js');

  const ctx = makeCtx();
  ctx.scene = { add() {}, remove() {} };
  const host = { isPlayer: true, alive: true, position: new THREE.Vector3() };
  const foreign = { isPlayer: true, alive: true, peerId: 2 };
  ctx.player = host;

  const audio = new Audio();
  audio.init(ctx);
  const progression = new Progression();
  progression.init(ctx);
  // The two cues, counted at the method the subscription calls — the WebAudio
  // graph below them needs a browser and is not what is under test.
  let cues = 0;
  audio.itemChanged = () => { cues++; };
  audio.coin = () => { cues++; };

  const pickup = (owner) => ({ id: 'adrenal-syringe', count: 1, delta: 1, reason: 'give', owner });
  ctx.events.emit('itemPickup', pickup(foreign));
  ctx.events.emit('goldChanged', { gold: 100, owner: foreign });

  ok(cues === 0, 'a teammate\'s pickup and purse are silent on this machine');
  ok(progression.stats.items === 0, 'and score no item on the viewer\'s run summary');
  ok(progression.stats.goldEarned === 0, 'and no gold on it either');

  ctx.events.emit('itemPickup', pickup(host));
  ctx.events.emit('goldChanged', { gold: 40, owner: host });

  ok(cues === 2, 'the viewer\'s own pickup and purse still speak');
  ok(progression.stats.items === 1, 'and count once on the run summary');
  ok(progression.stats.goldEarned === 40,
    `and bank the viewer's gain alone, not the teammate's 100 (${progression.stats.goldEarned})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
