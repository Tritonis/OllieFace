import * as THREE from 'three';
import { Player } from '../src/entities/Player.js';
import { Combat } from '../src/systems/Combat.js';
import { Roster } from '../src/systems/Roster.js';
import { Revive } from '../src/systems/Revive.js';
import { Interactables } from '../src/world/Interactables.js';
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

  // The hazard the fork's `!target.downed` clause exists for, asserted at the
  // one place that can still be reached directly: re-entering the downed state
  // must never refill the clock. A body whose `bleedout` is reset by every
  // stray hit can never finish bleeding out, and no guard can see it — `downed
  // && alive` is the legal state, so an endlessly reset timer looks like a
  // teammate taking their time.
  pawn.bleedout = 12;
  combat.enterDowned(pawn, null);
  ok(pawn.bleedout === 12, 'entering downed while already downed does not reset the bleed-out clock');
  ok(named('playerDowned').length === 1, 'and does not re-announce the pawn going down');
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
    // The downed branch pumps both pools (a downed pawn's shot still has to
    // land); this case is about the input gate, so they are inert here.
    projectiles: { fixedUpdate() {} }, placeables: { fixedUpdate() {} },
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

// -------------------------------------------------------------- Revive system
//
// Real `Revive`, real `Roster`, real `Combat`, fake world — the same hand-built
// ctx the Combat fork above uses, with a real roster of plain pawns so the
// targetable filter and the wipe count are the shipping ones. Every clock is
// stepped at the engine's fixed `h`, so a step count in a test is the number of
// frames a player would actually stand there.

const H = 1 / 60;
const BLEED_STEPS = Math.round(REVIVE.BLEEDOUT_S / H);
const REVIVE_STEPS = Math.round(REVIVE.REVIVE_S / H);

function makeBus(log) {
  const map = new Map();
  return {
    emit(name, payload) {
      log.push({ name, payload });
      for (const fn of [...(map.get(name) || [])]) fn(payload);
    },
    on(name, fn) {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(fn);
    },
  };
}

function makeRosterPawn(x, netId) {
  return {
    isPlayer: true, alive: true, downed: false, bleedout: 0, revive: 0,
    team: 'player', radius: 0.45, health: 100, maxHealth: 100, shield: 0,
    netId, stats: { armor: 0, maxHealth: 100 },
    // Identity carrier for the P2 seam: a pawn's build is never torn down, so
    // this exact object must survive death and stage return.
    items: { tag: 'items-' + netId },
    position: new THREE.Vector3(x, 0, 0), velocity: new THREE.Vector3(),
    interactPressed: false,
  };
}

/** `count` pawns in the roster at 10 m spacing; pawn 0 is `ctx.player`. */
function makeReviveWorld(count, xs = null) {
  const log = [];
  const ctx = {
    rng: makeRng(), time: 10, authority: true, scene: new THREE.Scene(),
    events: makeBus(log),
    stage: { sampleHeight: () => 0, spawnPoint: () => new THREE.Vector3() },
  };
  const roster = new Roster();
  roster.init(ctx);
  const combat = new Combat();
  combat.init(ctx);
  const pawns = [];
  for (let i = 0; i < count; i++) pawns.push(roster.add(makeRosterPawn(xs ? xs[i] : i * 10, 30 + i)));
  ctx.player = pawns[0];
  const revive = new Revive();
  revive.init(ctx);
  return {
    ctx, combat, roster, revive, pawns, log,
    step(n = 1) { for (let i = 0; i < n; i++) revive.fixedUpdate(ctx, H); },
    named(n) { return log.filter((e) => e.name === n); },
  };
}

console.log('a downed pawn nobody comes for bleeds out on the exact tick its clock runs out');
{
  const w = makeReviveWorld(2);
  const [down, mate] = w.pawns;
  w.combat.applyDamage(down, 500, {});
  ok(down.downed === true, 'the pawn is downed');
  void mate;

  w.step(BLEED_STEPS - 1);
  ok(down.downed === true, `still downed after ${BLEED_STEPS - 1} steps`);
  ok(w.named('playerBledOut').length === 0, 'no playerBledOut yet');

  w.step(1);
  ok(down.downed === false, `downed cleared on step ${BLEED_STEPS}`);
  ok(down.alive === false, 'and the pawn is dead');
  ok(w.named('playerBledOut').length === 1, 'exactly one playerBledOut');
  ok(w.named('playerBledOut')[0]?.payload.player === down, 'playerBledOut names the pawn');
  ok(w.named('playerDead').length === 1, 'exactly one playerDead');
  const iBled = w.log.findIndex((e) => e.name === 'playerBledOut');
  const iDead = w.log.findIndex((e) => e.name === 'playerDead');
  ok(iBled >= 0 && iDead > iBled, 'playerBledOut is announced before playerDead');
}

console.log('a teammate standing over the body picks it up in exactly REVIVE_S of frames');
{
  const w = makeReviveWorld(2, [0, 2]);
  const [down, mate] = w.pawns;
  w.combat.applyDamage(down, 500, {});
  mate.interactPressed = true;

  w.step(REVIVE_STEPS - 1);
  ok(down.downed === true, `still downed after ${REVIVE_STEPS - 1} steps`);
  ok(mate.reviving === true, 'the reviver is flagged `reviving` while the scan holds them');

  w.step(1);
  ok(down.downed === false, `revived on step ${REVIVE_STEPS}`);
  ok(down.alive === true, 'and never died');
  ok(down.health === REVIVE.REVIVE_HEALTH_FRAC * down.maxHealth,
    `stands up at ${REVIVE.REVIVE_HEALTH_FRAC * 100}% max health`);
  ok(down.bleedout === 0 && down.revive === 0, 'both clocks are cleared');
  ok(w.named('playerRevived').length === 1, 'exactly one playerRevived');
  ok(w.named('playerRevived')[0]?.payload.player === down, 'playerRevived names the pawn, by reference');
  ok(w.named('playerRevived')[0]?.payload.by === mate, 'and names the reviver');
  ok(w.named('playerDead').length === 0, 'no playerDead');

  w.step(1);
  ok(mate.reviving !== true, 'the flag is cleared once there is nobody left to pick up');
}

console.log('a reviver who walks away loses the progress at twice the speed they made it');
{
  const w = makeReviveWorld(2, [0, 2]);
  const [down, mate] = w.pawns;
  w.combat.applyDamage(down, 500, {});
  mate.interactPressed = true;
  w.step(REVIVE_STEPS / 2);
  ok(Math.abs(down.revive - 0.5) < 1e-6, 'half-way there');

  // Interrupted two ways at once, because both must stop the scan: the press
  // is released and the reviver steps out of the radius.
  mate.interactPressed = false;
  mate.position.x = REVIVE.REVIVE_RADIUS + 5;
  w.step(REVIVE_STEPS / 4);
  ok(Math.abs(down.revive) < 1e-9, `drained in ${REVIVE_STEPS / 4} steps — twice as fast as it filled`);
  ok(down.downed === true, 'and the pawn is still downed');
  ok(down.alive === true, 'still not dead — the bleed-out clock is the only thing that kills');

  w.step(30);
  ok(down.revive === 0, 'progress never goes negative');
}

console.log('two clocks run independently: reviving one body does not touch the other');
{
  const w = makeReviveWorld(3, [0, 30, 2]);
  const [a, b, c] = w.pawns;
  w.combat.applyDamage(a, 500, {});
  w.step(60);
  w.combat.applyDamage(b, 500, {});
  ok(a.downed && b.downed && Roster.targetable(c), 'two down, one still standing');

  c.interactPressed = true;
  w.step(REVIVE_STEPS);
  ok(a.downed === false && a.alive === true, 'the reachable body is up');
  ok(a.health === REVIVE.REVIVE_HEALTH_FRAC * a.maxHealth, 'at the revive fraction');
  ok(b.downed === true, 'the far body is still down');
  ok(b.revive === 0, 'and made no progress of its own');
  // b went down 60 steps after a and has been bleeding for REVIVE_STEPS since.
  const expected = REVIVE.BLEEDOUT_S - REVIVE_STEPS * H;
  ok(Math.abs(b.bleedout - expected) < 1e-6, `the far body's own clock reads ${expected.toFixed(2)}s`);
}

console.log('a downed pawn cannot pick anyone up — the reviver must be a legal target');
{
  const w = makeReviveWorld(3, [0, 2, 30]);
  const [a, b, c] = w.pawns;
  w.combat.applyDamage(a, 500, {});
  w.combat.applyDamage(b, 500, {});
  b.interactPressed = true;
  void c;

  w.step(REVIVE_STEPS + 10);
  ok(a.revive === 0, 'no progress from a downed neighbour');
  ok(a.downed === true && b.downed === true, 'both are still down');
  ok(w.named('playerRevived').length === 0, 'no playerRevived');
}

console.log('a wipe is one tick: nobody left standing finishes every body at once');
{
  const w = makeReviveWorld(2, [0, 2]);
  const [a, b] = w.pawns;
  w.combat.applyDamage(a, 500, {});
  w.combat.applyDamage(b, 500, {});
  ok(a.downed && b.downed, 'both down, nobody targetable');
  const before = w.log.length;

  w.step(1);
  ok(a.alive === false && b.alive === false, 'both dead');
  ok(a.downed === false && b.downed === false, 'and neither is left carrying the flag');
  ok(w.named('playerDead').length === 2, 'two playerDead');
  ok(w.named('playerBledOut').length === 0, 'a wipe is not a bleed-out');
  const deaths = w.log.slice(before).filter((e) => e.name === 'playerDead');
  ok(deaths.length === 2, 'both deaths landed in the same step');
}

console.log('a new stage brings the whole party back, at half health, with their builds intact');
{
  const w = makeReviveWorld(3, [0, 30, 60]);
  const [a, b, c] = w.pawns;
  const items = w.pawns.map((p) => p.items);
  // One really dead (bled out), one still down, one untouched.
  w.combat.applyDamage(a, 500, {});
  w.combat.finishDowned(a);
  w.combat.applyDamage(b, 500, {});
  ok(a.alive === false && b.downed === true, 'one corpse, one body');
  c.position.set(0, 0, 0);
  w.ctx.player = c;
  const anchor = c.position.clone();

  w.ctx.events.emit('stageStart', { index: 1, name: 'Stage 2' });

  ok(a.alive === true && a.downed === false, 'the corpse is back');
  ok(b.alive === true && b.downed === false, 'the body is back');
  ok(a.health === REVIVE.RETURN_HEALTH_FRAC * a.maxHealth, `corpse returns at ${REVIVE.RETURN_HEALTH_FRAC * 100}%`);
  ok(b.health === REVIVE.RETURN_HEALTH_FRAC * b.maxHealth, `body returns at ${REVIVE.RETURN_HEALTH_FRAC * 100}%`);
  ok(a.bleedout === 0 && a.revive === 0 && b.bleedout === 0 && b.revive === 0, 'no clock survives the stage');
  ok(c.health === 100, 'a pawn who never went down is not touched');
  ok(a.items === items[0] && b.items === items[1], 'their builds are the same objects they died with');
  ok(a.position.distanceTo(anchor) < 4 && b.position.distanceTo(anchor) < 4,
    'both are parked on the local player, where a joining pawn lands');
}

console.log('single-player: a roster of one with nobody down is a no-op scan');
{
  const w = makeReviveWorld(1);
  const [solo] = w.pawns;
  const before = { ...solo, position: solo.position.clone() };
  w.step(600);
  ok(w.log.length === 0, 'ten seconds of stepping emits nothing');
  ok(solo.alive === true && solo.downed === false, 'the pawn is untouched');
  ok(solo.health === before.health && solo.position.equals(before.position), 'health and position unchanged');
}

console.log('the last survivor of a pair going down does not wipe alone... but a solo roster never downs');
{
  // Wipe needs 2+ pawns. A roster of one that somehow carried the flag must not
  // be finished by this system — solo lethal damage is a plain death and never
  // reaches here (see the Combat fork above).
  const w = makeReviveWorld(1);
  const [solo] = w.pawns;
  solo.downed = true;
  solo.bleedout = REVIVE.BLEEDOUT_S;
  w.step(1);
  ok(solo.alive === true, 'no wipe on a roster of one');
  ok(w.named('playerDead').length === 0, 'and no death');
}

console.log('Interactables skips a pawn whose press is spent holding a teammate up');
{
  // The real roster scan, without the world it normally sits in: `Object.create`
  // on the prototype (the render-scale.test.mjs idiom) with the orb sweep and
  // the focus update stubbed, so the branch under test is the roster loop.
  const asked = [];
  const inter = Object.create(Interactables.prototype);
  inter.orbs = [];
  inter._updateFocus = () => {};
  inter.requestInteract = (p) => { asked.push(p); return true; };

  const reviver = { interactPressed: true, reviving: true };
  const opener = { interactPressed: true, reviving: false };
  const ctx = { authority: true, roster: { all: [reviver, opener] } };
  inter.fixedUpdate(ctx, H);

  ok(asked.length === 1, 'exactly one interact resolved');
  ok(asked[0] === opener, 'the pawn holding a teammate up does not also open the chest');
}

// ------------------------------------------------- a downed pawn's own pools
//
// Downing is not death: `Combat.enterDowned` runs none of `_kill`'s teardown,
// so nothing clears the shot that is already in the air or the turret already
// on the ground. Those two pools are pumped from exactly one place — the tail
// of `Player.applyCommand` — and the downed branch used to return above it, so
// a body on the floor froze its own projectiles mid-flight and stopped its
// placeables expiring for the whole 40 s clock. Real pools here, real Combat,
// so "lands and damages" is the pool's own arithmetic and not a spy.

console.log('a downed pawn keeps ticking the shot already in the air and the turret already down');
{
  const { ProjectilePool } = await import('../src/entities/Projectile.js');
  const { PlaceablePool } = await import('../src/entities/Placeables.js');

  const w = makeReviveWorld(2, [0, 2]);
  const ctx = w.ctx;
  ctx.stage = { sampleHeight: () => 0, spawnPoint: () => new THREE.Vector3(), raycast: () => null };

  const owner = Object.create(Player.prototype);
  Object.assign(owner, makePawn(0), {
    ctx, netId: 77, _prevButtons: 0, _lastCmdTick: 0,
    _refreshStats() {}, _harvestExternal() {}, _tickTimers() {}, _tickCooldowns() {},
    _resolve() {}, _land() {}, _aim() {}, _abilities() {}, _move() {}, _regen() {},
    _commit() {},
  });
  owner._sched = new Array(32);
  for (let i = 0; i < 32; i++) owner._sched[i] = { t: 0, fn: null };
  owner.projectiles = new ProjectilePool(ctx);
  owner.placeables = new PlaceablePool(ctx);

  // A target 3 m down the +X axis, and a slow shot already travelling at it.
  const victim = {
    tag: 'victim', alive: true, team: 'monster', radius: 0.5, height: 1.6,
    health: 100, maxHealth: 100, shield: 0, stats: { armor: 0 },
    position: new THREE.Vector3(3, 0.8, 0), velocity: new THREE.Vector3(),
  };
  w.ctx.combat.register(victim);

  owner.projectiles.spawn({
    position: new THREE.Vector3(0, 0.8, 0), velocity: new THREE.Vector3(6, 0, 0),
    kind: 'linear', damage: 25, radius: 0.22, life: 4, owner,
  });
  // A mine with a short fuse and no proximity trigger in reach: what is being
  // asserted is that its lifetime runs out on schedule, not that it detonates.
  owner.placeables.spawn({
    kind: 'mine', position: new THREE.Vector3(-20, 0, 0), velocity: new THREE.Vector3(),
    damage: 10, radius: 1, life: 0.5, armTime: 10, owner,
  });

  const shot = owner.projectiles.items.find((p) => p.alive);
  const mine = owner.placeables.items.find((p) => p.alive);
  ok(!!shot && !!mine, 'a shot is in the air and a mine is on the ground');

  // Down the owner, then keep stepping its command exactly as the host does.
  w.combat.applyDamage(owner, 500, {});
  ok(owner.downed === true, 'the owner is downed with both still live');

  const startX = shot.position.x;
  const cmd = { tick: 1, buttons: 0 };
  for (let i = 0; i < 30 && shot.alive; i++) { cmd.tick = i + 1; owner.applyCommand(cmd, H); }

  ok(shot.position.x > startX, `the shot kept travelling while its owner was down (x ${startX.toFixed(2)} -> ${shot.position.x.toFixed(2)})`);
  ok(shot.alive === false, 'and it landed rather than hanging in the air');
  ok(victim.health < 100, `and it damaged what it hit (${victim.health})`);

  const mineSteps = Math.round(0.5 / H) + 2;
  for (let i = 0; i < mineSteps; i++) { cmd.tick = 100 + i; owner.applyCommand(cmd, H); }
  ok(mine.alive === false, 'the mine expired on its own clock while its owner lay downed');
}

console.log('but nothing NEW spawns: a scheduled volley does not fire out of a body on the floor');
{
  const w = makeReviveWorld(2, [0, 2]);
  const ctx = w.ctx;

  const owner = Object.create(Player.prototype);
  Object.assign(owner, makePawn(0), {
    ctx, netId: 78, _prevButtons: 0, _lastCmdTick: 0,
    _refreshStats() {}, _harvestExternal() {}, _tickTimers() {}, _tickCooldowns() {},
    _resolve() {}, _land() {}, _aim() {}, _abilities() {}, _move() {}, _regen() {},
    _commit() {},
    projectiles: { fired: 0, fixedUpdate() {} },
    placeables: { fixedUpdate() {} },
  });
  owner._sched = new Array(32);
  for (let i = 0; i < 32; i++) owner._sched[i] = { t: 0, fn: null };

  let fired = 0;
  owner.schedule(0.2, () => { fired++; });
  w.combat.applyDamage(owner, 500, {});

  const cmd = { tick: 1, buttons: 0 };
  for (let i = 0; i < 60; i++) { cmd.tick = i + 1; owner.applyCommand(cmd, H); }
  ok(fired === 0, 'the queued volley did not fire while downed');

  // And it is held, not thrown away: standing up hands the shot back.
  owner.downed = false;
  for (let i = 0; i < 60; i++) { cmd.tick = 100 + i; owner.applyCommand(cmd, H); }
  ok(fired === 1, 'the same volley fires once the pawn is back on its feet');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
