// tests/enemy-voice-release.test.mjs
//
// A sustained voice charges the mixer budget for as long as it is held and
// gives it back only through its own handle, so a handle nobody releases is a
// voice slot lost for the rest of the run. The state machine releases on the
// paths it owns; two ordinary paths bypass it entirely.
//
//   * a unit killed mid-windup leaves through `onDeath()`, which sets
//     `alive = false` — and the withering bed's release lived inside a guard
//     that tests `this.alive`, so once dead it could never run;
//   * `Director.clear()` calls `despawn()` directly at every stage transition
//     with no `fsm.set()` in between, so no `exit` handler runs at all.
//
// Both are asserted here against the real `onDeath` / `despawn`, on handles
// the fixture hands out itself, so the assertion is "the release() we gave it
// was called" and not "no exception was thrown".
//
// Falsification, run by hand before this file was committed: deleting the
// `releaseVoices()` call from `onDeath` reds the death cases; deleting it from
// `despawn` reds the stage-clear cases. Output quoted in the commit.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 99) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

function makeWorld() {
  const voices = [];
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 400, maxHealth: 400,
    takeDamage() { return 0; },
  };
  const roster = new Roster();
  roster.init(ctx);
  ctx.player = player;
  roster.add(player);
  ctx.director = {
    spawnTelegraph() {},
    denyHealing() {},
    healingDeniedFor() { return false; },
  };
  ctx.audio = {
    windupVoice() {
      const v = { released: false };
      voices.push(v);
      return { active: true, move() {}, release() { v.released = true; } };
    },
    elementTick() {}, elementTransient() {}, elementBeam() {},
  };
  ctx.vfx = { beams: { spawn() {} }, lights: { flick() {} }, healDenied() {}, hitSpark() {}, status() {} };
  return { ctx, player, voices };
}

function midWindup(cardId, attackId, affix) {
  const def = ENEMIES.find((e) => e.id === cardId);
  const idx = def.attacks.findIndex((a) => a.id === attackId);
  const w = makeWorld();
  const e = new Enemy();
  e.spawn(w.ctx, def, { x: 3.0, y: 0, z: 0 }, affix ? { affix } : {});
  e._ctx = w.ctx;
  e.targetPlayer = w.player;
  e.beginAttack(w.ctx, idx);
  const h = (def.attacks[idx].windup * e.timeScale) * 0.2;
  w.ctx.time += h;
  e.fsm.update(w.ctx, h);
  return { ...w, e };
}

console.log('a unit killed mid-windup gives its held voice back');
{
  const { e, voices } = midWindup('scarab', 'headbutt');
  ok(voices.length === 1 && !voices[0].released, 'precondition: one voice is held, still open');
  e.onDeath();
  ok(voices[0].released, 'onDeath() released the windup voice');
  ok(e.tellVoice === null, 'and dropped the handle, so a second death cannot double-release');
  e.onDeath();
  ok(voices.filter((v) => !v.released).length === 0, 'a repeated death is still clean');
}

console.log('\na withering elite killed inside its own bed gives that back too');
{
  const { ctx, e, voices } = midWindup('scarab', 'headbutt', 'withering');
  // Drive the aura long enough to open the held void bed. `fixedUpdate` is the
  // real path: it is where the bed is started and where the release the fix
  // replaces used to live, behind an `alive` test.
  for (let i = 0; i < 20; i++) { ctx.time += 0.1; e.fixedUpdate(ctx, 0.1); }
  ok(e.witherVoice != null, 'precondition: the deny bed is holding');
  const held = voices.filter((v) => !v.released).length;
  ok(held >= 1, `precondition: ${held} voice(s) open`);
  e.onDeath();
  // The old release was inside `if (em.denyRadius && this.alive ...)`, so
  // running the aura after death used to be the leak's second chance and was
  // not one. Keep updating to prove the fix does not depend on it.
  for (let i = 0; i < 10; i++) { ctx.time += 0.1; e.fixedUpdate(ctx, 0.1); }
  ok(voices.every((v) => v.released), 'every held voice was released by the death itself');
  ok(e.witherVoice === null, 'and the bed handle is gone');
}

console.log('\na stage transition clears units without going through the state machine');
{
  const { ctx, e, voices } = midWindup('colossus', 'barrage');
  ok(voices.length === 1 && !voices[0].released, 'precondition: the barrage windup is holding');
  const state = e.fsm.state;
  // What Director.clear() does: despawn straight out of whatever state the
  // unit is in. No fsm.set(), so no exit() handler.
  e.despawn(ctx);
  ok(e.fsm.state === state, 'no state change happened — no exit() handler could have run');
  ok(voices[0].released, 'despawn() released the windup voice anyway');
}

console.log('\nand the same for a pull, mid-drag');
{
  const { ctx, e, voices } = midWindup('lasher', 'reel');
  // Run out the windup and into ATTACK, where the drag voice is started.
  const a = e.atk;
  for (let i = 0; i < 60; i++) { ctx.time += 0.05; e.fsm.update(ctx, 0.05); if (e.pullVoice) break; }
  ok(e.pullVoice != null, `precondition: the ${a.active}s drag is voiced`);
  e.despawn(ctx);
  ok(voices.every((v) => v.released), `every voice released at stage clear (${voices.length} total)`);
  ok(e.pullVoice === null && e.tellVoice === null, 'and no handle is left behind');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
