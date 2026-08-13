// Who pays, and who gets paid. Three axes, one rule: the *acting* pawn owns
// the transaction, never whoever this machine happens to be rendering.
//
//   1. A kill pays every registered pawn the full reward (no split).
//   2. An interact spends the acting pawn's purse.
//   3. A void-credit open attributes the corruption to the acting pawn.
//
// Real Items and real Corruption; the world around them is stubbed, because
// the axis under test is ownership, not the loot table.
import * as THREE from 'three';
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Chest, Interactables } from '../src/world/Interactables.js';
import { SOURCES } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
