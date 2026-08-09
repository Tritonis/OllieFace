// tests/start-equipment.test.mjs
// The pre-run equipment pick. `Menus.launch` writes the player's choice to
// `ctx.startEquipmentId`; the stage-start seeding in `Items` must honour it,
// and must still roll randomly when no choice was made (the Random card, and
// every run started before the picker existed).
//
// Real Items, real equipment catalogue — same headless harness as
// tests/item-mutation.test.mjs.
import { Items } from '../src/systems/Items.js';
import { EQUIPMENT } from '../src/data/equipment.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ authority = true, startEquipmentId = null } = {}) {
  const listeners = new Map();
  const ctx = {
    authority, seed: 424242, rng: new RNG(777), time: 0,
    startEquipmentId,
    player: { isPlayer: true, alive: true },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const items = new Items();
  items.init(ctx);
  return { ctx, items };
}

const chosen = EQUIPMENT[EQUIPMENT.length - 1].id;

console.log('a chosen starting equipment is the one the stage seeds');
{
  const { ctx, items } = makeCtx({ startEquipmentId: chosen });
  ctx.events.emit('stageStart', {});
  ok(items.equipmentId === chosen, `slot holds the pick (got ${items.equipmentId})`);
}

console.log('no choice still seeds a random equipment (control arm)');
{
  const { ctx, items } = makeCtx();
  ctx.events.emit('stageStart', {});
  ok(!!items.equipmentId, `slot was seeded (got ${items.equipmentId})`);
}

console.log('the pick only fills an empty slot — a held equipment survives stage transitions');
{
  const { ctx, items } = makeCtx({ startEquipmentId: chosen });
  const other = EQUIPMENT[0].id;
  items.setEquipment(other);
  ctx.events.emit('stageStart', {});
  ok(items.equipmentId === other, `the held equipment stays (got ${items.equipmentId})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
