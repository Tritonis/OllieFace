/**
 * A transition started from inside an `exit` handler must be the one that wins.
 *
 *   node tests/fsm-die-reentrancy.test.mjs
 *
 * `StateMachine.set` runs the outgoing state's `exit` before it writes the new
 * state. If that exit handler transitions the machine itself, the nested `set`
 * completes and then the *outer* set resumes and overwrites `this.state` with
 * its own target — silently undoing the nested transition.
 *
 * The live casualty is the Blind Shrike. A dive that misses runs the active
 * window out, so `ATTACK.update` calls `fsm.set(RECOVER)`; `ATTACK.exit`
 * detonates a still-alive diver, the detonation self-kills through Combat,
 * `onDeath` sets DIE — and then the outer `set(RECOVER)` lands on the corpse.
 * What is left is a dead Shrike in a live state: unhittable (the ray path
 * skips `!alive`), unkillable (`takeDamage` early-returns on the dead), never
 * reaped (`finished` requires DIE), and still detonating at the player every
 * cooldown. Dives that connect die cleanly — that detonation's `set(DIE)` is
 * not nested inside anything.
 *
 * Headless is real, not mocked: real `Enemy`, real `Combat`, real `Roster`,
 * real rigs in a real `THREE.Scene`.
 */
import * as THREE from 'three';
import { StateMachine, S } from '../src/ai/StateMachine.js';
import { Enemy } from '../src/entities/Enemy.js';
import { Combat } from '../src/systems/Combat.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 12345) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

const byName = (name) => {
  const d = ENEMIES.find((e) => e.name === name);
  if (!d) throw new Error(`no enemy card named ${name}`);
  return d;
};

const H = 1 / 60;

// ---------------------------------------------------------------------------

console.log('a transition made from an exit handler is not overwritten by the outer set');
{
  const seen = [];
  // The `dying` latch mirrors `Enemy.onDeath`, which returns early once it has
  // run: the exit handler kills the owner exactly once.
  const owner = { dying: false };
  const table = {
    stateA: {
      exit(o, ctx, fsm) {
        seen.push('exitA');
        if (o.dying) return;
        o.dying = true;
        fsm.set('dead', ctx);
      },
    },
    stateB: {
      enter() { seen.push('enterB'); },
    },
    dead: {
      enter() { seen.push('enterDead'); },
    },
  };
  const fsm = new StateMachine(owner, table);
  fsm.set('stateA');
  fsm.set('stateB');

  ok(fsm.state === 'dead', `the exit handler's transition wins (state is '${fsm.state}')`);
  ok(!seen.includes('enterB'), `the abandoned target never enters (saw ${seen.join(',')})`);
  ok(seen.includes('enterDead'), 'the nested target did enter');
}

console.log('an ordinary transition is untouched');
{
  const table = {
    a: { exit() {} },
    b: { enter() {} },
  };
  const fsm = new StateMachine({}, table);
  fsm.set('a');
  fsm.set('b');
  ok(fsm.state === 'b', `plain transitions still land (state is '${fsm.state}')`);
  ok(fsm.prev === 'a', `prev is still recorded (got '${fsm.prev}')`);
}

// ---------------------------------------------------------------------------

function makeWorld() {
  const kills = [];
  const ctx = {
    rng: makeRng(),
    time: 0,
    authority: true,
    scene: new THREE.Scene(),
    events: { emit(name, payload) { if (name === 'kill') kills.push(payload); }, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
  };
  ctx.player = player;
  const roster = new Roster();
  roster.init(ctx);
  roster.add(player);
  ctx.roster = roster;
  return { ctx, player, kills };
}

console.log('a Blind Shrike whose dive misses dies instead of zombifying');
{
  const { ctx, player } = makeWorld();
  const e = new Enemy();
  e.spawn(ctx, byName('Blind Shrike'), new THREE.Vector3(0, 20, 0), {});
  e.targetPlayer = player;

  // Count detonations that happen once the unit is already a corpse — the
  // zombie's signature is a dead bomber that keeps exploding on the player.
  let postMortemBlasts = 0;
  const realDetonate = e.detonate.bind(e);
  e.detonate = (c) => { if (!e.alive) postMortemBlasts++; return realDetonate(c); };

  e.beginAttack(ctx, 0);

  // Hold the Shrike high and keep the player out of blast range every step, so
  // none of the three "hit" triggers (proximity, grounded, near the floor) can
  // fire. This is the dive that misses: the window simply runs out.
  const step = () => {
    e.position.y = 20;
    e.grounded = false;
    player.position.set(e.position.x + 200, 0, e.position.z);
    e.fixedUpdate(ctx, H);
    e.update(ctx, H);
    ctx.time += H;
  };

  // windup 0.85s + active 1.1s, with margin.
  for (let i = 0; i < 150; i++) step();

  ok(!e.alive, 'the diver is dead');
  ok(e.fsm.state === S.DIE, `and the machine agrees it is dead (state is '${e.fsm.state}')`);

  // Now stop helping: park the player back at the origin, in range, and let ten
  // seconds run. A corpse left in a live state chases, winds up and dives again
  // — twice over, on a 3s cooldown — which is the bug as the player meets it.
  player.position.set(0, 0, 0);
  for (let i = 0; i < 600; i++) { e.fixedUpdate(ctx, H); e.update(ctx, H); ctx.time += H; }

  ok(e.finished, `the corpse is reapable (state '${e.fsm.state}', deathT ${e.deathT.toFixed(2)})`);
  ok(postMortemBlasts === 0, `it never detonates again after dying (got ${postMortemBlasts})`);
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
