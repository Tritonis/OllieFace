import { Items } from '../src/systems/Items.js';
import { RNG } from '../src/core/MathUtil.js';

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

// Task 1 left this arm asserting the *interim* rule — a satellite's slot stayed
// empty because `setEquipment` had no owner-scoping and its jingle and its
// logbook write would have been attributed to the viewer. Task 5 gave the event
// an owner and the seeding is live, so the arm now asserts what replaced that
// rule: the slot fills, silently, in the satellite's own name.
console.log('satellite stageStart seeds its own slot — owner-tagged, and silent on this machine');
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
  const equipmentChanged = [];
  ctx.events.on('equipmentChanged', (e) => equipmentChanged.push(e));

  ctx.startEquipmentId = 'blink-anchor';   // the *viewer's* pre-run pick
  const remote = new Items(remotePawn);
  remote.init(ctx);
  remotePawn.items = remote;

  ctx.events.emit('stageStart', { index: 1 });

  ok(typeof remote.equipmentId === 'string', 'the satellite seeded a slot of its own');
  ok(remote.equipmentId !== ctx.startEquipmentId,
    'and rolled for it — the equipment screen\'s pick belongs to the viewer alone');
  ok(equipmentChanged.length === 1 && equipmentChanged[0].owner === remotePawn,
    'one equipmentChanged, named for the pawn whose slot filled');
  ok(ctx._audioCalls.length === 0, 'satellite stageStart plays no audio on this machine');
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

console.log('satellite rolls come off a derived stream, never the singleton\'s');
{
  const ctx = makeCtx();
  ctx.seed = 424242;
  ctx.rng = new RNG(ctx.seed);
  const localPawn = { isPlayer: true };
  ctx.player = localPawn;

  const local = new Items();
  local.init(ctx);

  const pawn2 = { isPlayer: true, peerId: 2 };
  const pawn3 = { isPlayer: true, peerId: 3 };
  const sat2 = new Items(pawn2);
  sat2.init(ctx);
  const sat3 = new Items(pawn3);
  sat3.init(ctx);

  // Peek what ctx.rng would yield next without consuming it — clone the
  // xorshift's exact state into a scratch RNG and draw off the clone.
  const peekNext = (rng) => new RNG(rng.s).next();
  const before = peekNext(ctx.rng);

  const roll = (items) => {
    const out = [];
    for (let i = 0; i < 5; i++) out.push(items.rollItem('common'));
    return out;
  };
  const seq2 = roll(sat2);
  const seq3 = roll(sat3);

  const after = peekNext(ctx.rng);
  ok(before === after, "constructing/rolling on satellites does not advance the singleton's next draw");

  ok(JSON.stringify(seq2) !== JSON.stringify(seq3), 'the two satellites draw different sequences from each other');

  const seqLocal = roll(local);
  ok(JSON.stringify(seq2) !== JSON.stringify(seqLocal), "a satellite's sequence differs from the singleton's");
  ok(JSON.stringify(seq3) !== JSON.stringify(seqLocal), "the other satellite's sequence also differs from the singleton's");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
