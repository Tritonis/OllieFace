import { Items } from '../src/systems/Items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    authority: true,
    rng: { next: () => 0.5, range: (a, b) => a + (b - a) * 0.5 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {
        const arr = listeners.get(name);
        if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      }; },
    },
  };
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
