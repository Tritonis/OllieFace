// tests/equipment-barrel.test.mjs
// The equipment barrel (issue #39) — the run's only in-run source of the Q
// slot, now that the stage-start re-seed is gone.
//
// Four claims:
//   1. Interacting fills the slot, and the barrel is spent afterwards.
//   2. It obeys the same ownership rule as Chest: the acting pawn's `Items`
//      takes the equipment, never the machine's own `ctx.player`.
//   3. It replaces — a second barrel overwrites what is held.
//   4. It carries a wire type id and a client view builds from it.
//
// Real Items, real Interactables, stubbed world.
import * as THREE from 'three';
import { Items } from '../src/systems/Items.js';
import { EquipmentBarrel, createInteractableView } from '../src/world/Interactables.js';
import { EQUIPMENT_BY_ID } from '../src/data/equipment.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  return {
    authority: true,
    seed: 4242,
    rng: new RNG(4242),
    time: 0,
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    audio: null,
  };
}

const origin = () => new THREE.Vector3();

console.log('interacting with a barrel fills the equipment slot and spends the barrel');
{
  const ctx = makeCtx();
  const player = { isPlayer: true, alive: true };
  ctx.player = player;
  const items = new Items();
  items.init(ctx);

  const barrel = new EquipmentBarrel(ctx, origin());
  ok(barrel.available(), 'a fresh barrel is available');
  ok(!items.equipmentId, 'the slot starts empty (no stage has started)');

  const took = barrel.interact(player);
  ok(took === true, 'interact reported success');
  ok(!!items.equipmentId && EQUIPMENT_BY_ID.has(items.equipmentId),
    `the slot holds a real equipment (got ${items.equipmentId})`);
  ok(barrel.used && !barrel.available(), 'the barrel is spent and no longer available');
}

console.log('ownership: the acting pawn is equipped, not the machine\'s own player');
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

  const barrel = new EquipmentBarrel(ctx, origin());
  barrel.interact(remote);

  ok(!!remoteItems.equipmentId, `the acting pawn was equipped (got ${remoteItems.equipmentId})`);
  ok(!hostItems.equipmentId, 'the viewer\'s own slot was untouched');
}

console.log('a barrel replaces — equipment is a commitment, not an accumulation');
{
  const ctx = makeCtx();
  const player = { isPlayer: true, alive: true };
  ctx.player = player;
  const items = new Items();
  items.init(ctx);

  const first = [...EQUIPMENT_BY_ID.keys()][0];
  items.setEquipment(first);
  ok(items.equipmentId === first, 'the slot was primed');

  // Roll until a barrel hands out something different, so the assertion is
  // about replacement and not about which id the stream happened to pick.
  let replaced = false;
  for (let i = 0; i < 40 && !replaced; i++) {
    items.setEquipment(first);
    const barrel = new EquipmentBarrel(ctx, origin());
    barrel.interact(player);
    replaced = items.equipmentId !== first;
  }
  ok(replaced, `a barrel overwrote the held equipment (now ${items.equipmentId})`);
}

console.log('the barrel replicates: a wire type id, and a client view for it');
{
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true };
  const barrel = new EquipmentBarrel(ctx, origin());
  ok(barrel.typeId > 0, `the barrel carries a wire type id (${barrel.typeId})`);

  const view = createInteractableView(ctx, barrel.typeId, origin());
  ok(view instanceof EquipmentBarrel, 'a client builds an EquipmentBarrel from that id');

  // Availability is the whole of the replicated state; NetViews writes `used`.
  view.update(0.016);
  ok(view.glow.visible, 'an unopened barrel shows its lamp');
  view.used = true;
  view.update(0.016);
  ok(!view.glow.visible, 'the replicated spent state puts the lamp out');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
