import * as THREE from 'three';
import { Player } from '../src/entities/Player.js';
import { Combat } from '../src/systems/Combat.js';
import { REVIVE } from '../src/data/revive.js';
import { ESTATE, BTN } from '../src/net/Protocol.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('ESTATE.DOWNED is exported at the wire value the snapshot vocabulary expects');
{
  ok(ESTATE.DOWNED === 3, 'DOWNED === 3');
}

console.log('a fresh pawn is not downed and reports ALIVE');
{
  // Real Player construction needs a live THREE/ctx world (mesh, camera rig,
  // physics); the remote-pawn idiom from tests/economy-ownership.test.mjs and
  // tests/render-scale.test.mjs (Object.create on the real prototype) gets us
  // the getters and _commit without any of that.
  const p = Object.create(Player.prototype);
  p.alive = true;
  p.downed = false;
  p.bleedout = 0;
  p.revive = 0;

  ok(p.downed === false, 'fresh pawn: downed === false');
  ok(p.bleedout === 0, 'fresh pawn: bleedout === 0');
  ok(p.netState === ESTATE.ALIVE, 'fresh pawn: netState === ALIVE');
}

console.log('downed flips the netState getter to DOWNED, ahead of the alive/dead split');
{
  const p = Object.create(Player.prototype);
  p.alive = true;
  p.downed = true;
  ok(p.netState === ESTATE.DOWNED, 'downed && alive: netState === DOWNED');

  // The invariant NetHost's snapshot skip relies on: downed never looks dead.
  ok(p.alive === true, 'downed pawn keeps alive === true');
}

console.log('undowned dead still reads DEAD, undowned alive still reads ALIVE');
{
  const dead = Object.create(Player.prototype);
  dead.alive = false;
  dead.downed = false;
  ok(dead.netState === ESTATE.DEAD, 'not downed, not alive: netState === DEAD');

  const alive = Object.create(Player.prototype);
  alive.alive = true;
  alive.downed = false;
  ok(alive.netState === ESTATE.ALIVE, 'not downed, alive: netState === ALIVE');
}

console.log('_commit still edges interactPressed and equipPressed off `pressed` (input-gate plumbing)');
{
  // applyCommand is what actually gates a downed pawn's input (it withholds
  // this call's `pressed` argument), but _commit itself is the edge-detector
  // this task's gate depends on — pin its contract here.
  const remote = {
    isPlayer: true, alive: true, downed: false, velocity: { x: 0, z: 0 }, _prevButtons: 0, _lastCmdTick: 0,
  };
  const cmd = { tick: 1, buttons: BTN.INTERACT | BTN.EQUIP };
  Player.prototype._commit.call(remote, cmd, BTN.INTERACT | BTN.EQUIP, BTN.INTERACT | BTN.EQUIP);
  ok(remote.interactPressed === true && remote.equipPressed === true, 'a live pawn: both edges fire on press');

  const remote2 = {
    isPlayer: true, alive: true, downed: true, velocity: { x: 0, z: 0 }, _prevButtons: 0, _lastCmdTick: 0,
  };
  const cmd2 = { tick: 1, buttons: BTN.INTERACT | BTN.EQUIP };
  // What applyCommand does for a downed pawn: pass 0 as `pressed` regardless
  // of what was actually pressed.
  Player.prototype._commit.call(remote2, cmd2, BTN.INTERACT | BTN.EQUIP, 0);
  ok(remote2.interactPressed === false && remote2.equipPressed === false,
    'downed pawn gate: withholding `pressed` suppresses both interact and equip edges');
}

// --------------------------------------------------------------- Combat fork
//
// Real `Combat`, real `applyDamage`, fake world — the harness idiom from
// tests/shield-regen-delay.test.mjs (real system, hand-built ctx) with the
// enemy cards swapped for plain player pawns, since the fork keys off
// `isPlayer` and `ctx.roster.count`, not off any spawn card.

function makeRng(seed = 12345) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

function makePawn(x = 0) {
  return {
    isPlayer: true, alive: true, downed: false, bleedout: 0, revive: 0,
    team: 'player', radius: 0.45, health: 100, maxHealth: 100, shield: 0,
    netId: 7, stats: { armor: 0 },
    position: new THREE.Vector3(x, 0, 0), velocity: new THREE.Vector3(),
  };
}

/** `rosterCount` pawns in the world; the fork only reads `count`. */
function makeCombatWorld(rosterCount) {
  const events = [];
  const ctx = {
    rng: makeRng(),
    time: 10,
    authority: true,
    scene: new THREE.Scene(),
    events: { emit(name, payload) { events.push({ name, payload }); }, on() {} },
    roster: { count: rosterCount },
  };
  const combat = new Combat();
  combat.init(ctx);
  const pawn = makePawn();
  ctx.player = pawn;
  return { ctx, combat, pawn, events, named: (n) => events.filter((e) => e.name === n) };
}

console.log('co-op: lethal damage downs a player pawn instead of killing it');
{
  const { combat, pawn, named } = makeCombatWorld(2);
  combat.applyDamage(pawn, 500, { position: new THREE.Vector3() });

  ok(pawn.downed === true, 'downed === true');
  ok(pawn.alive === true, 'alive stays true (the snapshot invariant)');
  ok(pawn.health === 0, 'health clamped to 0');
  ok(pawn.bleedout === REVIVE.BLEEDOUT_S, `bleedout === REVIVE.BLEEDOUT_S (${REVIVE.BLEEDOUT_S})`);
  ok(pawn.revive === 0, 'revive progress starts at 0');
  ok(named('playerDowned').length === 1, 'exactly one playerDowned');
  ok(named('playerDowned')[0]?.payload.player === pawn, 'playerDowned names the pawn');
  ok(named('playerDead').length === 0, 'no playerDead');
  ok(named('kill').length === 0, 'no kill event — a downed player is not a kill');
}

console.log('a downed pawn is damage-proof: bleed-out is a timer, not damage');
{
  const { combat, pawn, named } = makeCombatWorld(2);
  combat.applyDamage(pawn, 500, {});
  const before = named('damage').length;

  const dealt = combat.applyDamage(pawn, 500, {});
  ok(dealt === 0, 'applyDamage on a downed pawn returns 0');
  ok(pawn.alive === true && pawn.downed === true, 'stray AoE leaves the downed state untouched');
  ok(named('damage').length === before, 'no damage event for the ignored hit');
  ok(named('playerDead').length === 0, 'still no playerDead');
  ok(named('playerDowned').length === 1, 'no second playerDowned');
}

console.log('finishDowned is the real death: the normal kill sequence, exactly once');
{
  const { combat, pawn, named } = makeCombatWorld(2);
  combat.applyDamage(pawn, 500, {});
  combat.finishDowned(pawn);

  ok(pawn.alive === false, 'alive === false');
  ok(pawn.downed === false, 'downed cleared');
  ok(named('playerDead').length === 1, 'exactly one playerDead');
  ok(named('kill').length === 1, 'exactly one kill event');
  const order = named('playerDowned').length && named('playerDead').length;
  ok(order === 1, 'downed then dead, one of each');
}

console.log('solo: the fork is not taken at all — lethal damage is a plain death');
{
  const { combat, pawn, named } = makeCombatWorld(1);
  combat.applyDamage(pawn, 500, {});

  ok(pawn.alive === false, 'roster of one: alive === false');
  ok(pawn.downed === false, 'roster of one: downed stays false');
  ok(named('playerDead').length === 1, 'roster of one: playerDead fires directly');
  ok(named('playerDowned').length === 0, 'roster of one: no playerDowned');
}

console.log('the one-state invariant is loud: killing a still-downed pawn warns');
{
  const { combat, pawn } = makeCombatWorld(2);
  combat.applyDamage(pawn, 500, {});

  const real = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // The illegal path: `_kill` reached with `downed` still set. Nothing in the
    // codebase should do this — `finishDowned` clears the flag first — so the
    // guard exists to make the mistake audible rather than let the pawn drop
    // silently out of every snapshot.
    combat._kill(pawn, null, pawn.position, 0, null, 0);
  } finally {
    console.warn = real;
  }

  ok(warnings.length === 1, 'exactly one warning');
  ok(warnings.length === 1 && warnings[0].includes(String(pawn.netId)), 'the warning names the pawn');
  ok(pawn.downed === false, 'the guard restores the invariant (downed cleared)');
  ok(pawn.alive === false, 'the kill still happened');
}

console.log('a press buffered on the exact tick a pawn goes down dies with the transition');
{
  const { ctx, combat, pawn: bystander } = makeCombatWorld(2);

  // A real `Player` needs a live THREE/ctx world; `Object.create` on the real
  // prototype (the render-scale.test.mjs idiom) gets us the real `applyCommand`
  // and the real `_commit`. Only the world-touching helpers are stubbed — the
  // branch under test is Player's own.
  const p = Object.create(Player.prototype);
  Object.assign(p, makePawn(3), {
    ctx, netId: 11, _prevButtons: 0, _lastCmdTick: 0,
    _refreshStats() {}, _harvestExternal() {}, _runSchedule() {}, _tickTimers() {},
    _tickCooldowns() {}, _resolve() {}, _land() {}, _aim() {}, _abilities() {},
    _move() {}, _regen() {},
  });
  void bystander;

  // The press is buffered *before* the pawn goes down: `_prevButtons` is 0, so
  // this tick's buttons read as a fresh edge.
  const cmd = { tick: 1, buttons: BTN.INTERACT | BTN.EQUIP };
  combat.applyDamage(p, 500, {});
  ok(p.downed === true, 'the pawn went down on this tick');

  p.applyCommand(cmd, 1 / 60);
  ok(p.interactPressed === false, 'the buffered interact press does not act');
  ok(p.equipPressed === false, 'the buffered equip press does not act');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
