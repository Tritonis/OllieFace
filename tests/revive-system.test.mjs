import { Player } from '../src/entities/Player.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
