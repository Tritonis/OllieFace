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

// The interim stage-start source is gone (issue #39): the run seeds the slot
// once, at its first stage, and after that the only source is a barrel. An
// emptied slot must therefore stay empty across a stage transition — if it
// silently refilled, spending an equipment would cost nothing but a wait.
console.log('the slot is seeded once per run — stage 2 does not refill an emptied one');
{
  const { ctx, items } = makeCtx({ startEquipmentId: chosen });
  ctx.events.emit('stageStart', {});
  ok(items.equipmentId === chosen, 'stage 1 seeded the pick');
  items.setEquipment(null);
  ok(items.equipmentId === null, 'the slot was emptied');
  ctx.events.emit('stageStart', {});
  ok(items.equipmentId === null, `stage 2 left it empty (got ${items.equipmentId})`);
  ctx.events.emit('stageStart', {});
  ok(items.equipmentId === null, `stage 3 left it empty too (got ${items.equipmentId})`);
}

// The pre-run pick is the load-bearing half of that one seeding, and it is the
// ONLY read of `ctx.startEquipmentId` in the codebase. This arm exists so that
// deleting or bypassing that read fails loudly: it pins the exact id, on a
// context whose rng would pick something else.
console.log('the pre-run pick is honoured specifically, not merely "something was seeded"');
{
  const { ctx, items } = makeCtx({ startEquipmentId: chosen });
  const { ctx: cctx, items: control } = makeCtx();
  ctx.events.emit('stageStart', {});
  cctx.events.emit('stageStart', {});
  ok(items.equipmentId === chosen, `the picked id and no other (got ${items.equipmentId})`);
  ok(control.equipmentId !== chosen || EQUIPMENT.length === 1,
    'and the unpicked control does not happen to roll the same id, so the arm can fail');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
