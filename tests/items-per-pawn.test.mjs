import { Items } from '../src/systems/Items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  const audioCalls = [];
  const ctx = {
    authority: true,
    rng: { next: () => 0.5, range: (a, b) => a + (b - a) * 0.5, pick: (arr) => arr[0] },
    audio: { play: (...args) => audioCalls.push(args) },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {
        const arr = listeners.get(name);
        if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      }; },
    },
  };
  ctx._audioCalls = audioCalls;
  return ctx;
}

console.log('Items is instantiable per pawn, and Items.of() resolves owner -> instance');
{
  const ctx = makeCtx();
  const localPawn = { isPlayer: true };
  ctx.player = localPawn;
  const remotePawn = { isPlayer: true, peerId: 2 };

  // 1. Singleton path: owner-less instance adopts ctx.player and registers.
  const local = new Items();
  local.init(ctx);
  ok(ctx.items === local, 'owner-less Items registers as ctx.items');
  ok(Items.of(ctx, ctx.player) === local, 'Items.of resolves local pawn to ctx.items');
  ok(Items.of(ctx, null) === local, 'Items.of(null) falls back to viewer instance');

  // 2. Satellite path: owned instance does not steal ctx.items.
  const remote = new Items(remotePawn);
  remote.init(ctx);
  remotePawn.items = remote;
  ok(ctx.items === local, 'satellite Items must not replace ctx.items');
  ok(Items.of(ctx, remotePawn) === remote, 'Items.of resolves remote pawn to its own instance');

  // 3. Isolation: gold and stacks do not bleed between instances.
  local.gold = 0; remote.gold = 0;
  remote.addGold(25);
  ok(local.gold === 0 && remote.gold === 25, 'gold mutations stay on the owning instance');
}

console.log('satellite stageStart is inert: no equipmentChanged, no audio, no equipment adopted');
{
  const ctx = makeCtx();
  const localPawn = { isPlayer: true };
  ctx.player = localPawn;
  const remotePawn = { isPlayer: true, peerId: 2 };

  const local = new Items();
  local.init(ctx);
  // Give the local viewer its own equipment first, so its stageStart seeding
  // (still active) is not itself the thing under test below.
  ctx.events.emit('stageStart', { index: 0 });
  const localEquipAfterFirstStage = local.equipmentId;
  ctx._audioCalls.length = 0;
  let equipmentChangedCount = 0;
  ctx.events.on('equipmentChanged', () => { equipmentChangedCount++; });

  const remote = new Items(remotePawn);
  remote.init(ctx);
  remotePawn.items = remote;

  ctx.events.emit('stageStart', { index: 1 });

  ok(remote.equipmentId === null, 'satellite equipment slot stays unseeded on stageStart');
  ok(equipmentChangedCount === 0, 'satellite stageStart emits no equipmentChanged');
  ok(ctx._audioCalls.length === 0, 'satellite stageStart plays no audio');
  ok(local.equipmentId === localEquipAfterFirstStage, 'the local viewer is unaffected by the satellite stageStart');
}

console.log('dispose() actually removes the satellite\'s bus subscriptions');
{
  const ctx = makeCtx();
  const localPawn = { isPlayer: true };
  ctx.player = localPawn;
  const remotePawn = { isPlayer: true, peerId: 2 };

  const local = new Items();
  local.init(ctx);

  const remote = new Items(remotePawn);
  remote.init(ctx);
  remotePawn.items = remote;

  // A satellite only subscribes stageStart; wrap it with a counter by
  // watching the cooldowns Map it clears, which is a side effect exclusive
  // to that handler running.
  remote.cooldowns.set('sentinel', 999);
  remote.dispose();
  ctx.events.emit('stageStart', { index: 2 });

  ok(remote.cooldowns.has('sentinel'), 'disposed satellite no longer reacts to stageStart');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
