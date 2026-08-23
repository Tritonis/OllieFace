// tests/enemy-windup-telegraph.test.mjs
//
// C6: sixteen telegraph windows were both silent and unmarked. The WINDUP
// state spawned a ground ring only for `a.blast && kind in
// [nova, slam, stomp, pull]`, so every melee swing, every non-blink charge,
// every summon cast and the shrike's dive opened and closed with nothing but
// an animation the player had to have already learned.
//
// The thing that makes this test worth having is that it is easy to write a
// version of it that cannot fail: assert "no exception", or assert against a
// re-implementation of the emit recipe rather than the code. So it drives a
// real Enemy through its real `beginAttack` into its real state machine, and
// asks the two collaborators the windup is supposed to talk to — the
// Director's telegraph pool and the Audio bus — what they were actually told.
//
// Falsification, run by hand before this file was committed:
//   * re-excluding melee (restoring the `a.blast && kind in [...]` guard)
//     turns 'melee: a ground ring went up' and the whole per-kind sweep red;
//   * deleting the `windupVoice` call turns every voice assertion red.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';
import { attackElement } from '../src/data/elementVoice.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 4242) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

function makeWorld() {
  const rings = [];
  const voices = [];
  const ticks = [];
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 110, maxHealth: 110,
    takeDamage() { return 0; },
  };
  const roster = new Roster();
  roster.init(ctx);
  ctx.player = player;
  roster.add(player);
  ctx.director = {
    spawnTelegraph: (x, z, radius, life, color) => rings.push({ x, z, radius, life, color }),
  };
  ctx.audio = {
    windupVoice(pos, element, duration, gain) {
      const v = { element, duration, gain, released: false, moves: 0 };
      voices.push(v);
      return { active: true, move: () => { v.moves++; }, release: () => { v.released = true; } };
    },
    elementTick: (pos, element, rate) => ticks.push({ element, rate }),
    elementTransient() {},
    elementBeam() {},
  };
  ctx.vfx = { beams: { spawn: () => {} }, lights: { flick: () => {} } };
  return { ctx, player, rings, voices, ticks };
}

/** Drive one enemy card's named attack through its whole windup window. */
function windup(cardId, attackId, steps = 24) {
  const def = ENEMIES.find((e) => e.id === cardId);
  const idx = def.attacks.findIndex((a) => a.id === attackId);
  const w = makeWorld();
  const e = new Enemy();
  e.spawn(w.ctx, def, { x: 3.2, y: 0, z: 0 }, {});
  e.targetPlayer = w.player;
  e.beginAttack(w.ctx, idx);
  const a = def.attacks[idx];
  const dur = a.windup * e.timeScale;
  // Stop just short of the end so the window is still open: the point of the
  // assertions below is what happens *during* it.
  const h = (dur * 0.95) / steps;
  for (let i = 0; i < steps; i++) { w.ctx.time += h; e.fsm.update(w.ctx, h); }
  return { ...w, e, a, dur };
}

console.log('a melee windup — the most common behaviour in the game — now announces itself');
{
  const { rings, voices, e, a, dur } = windup('scarab', 'headbutt');
  ok(rings.length >= 1, `melee: a ground ring went up (${rings.length})`);
  const first = rings[0];
  ok(first && first.radius > 0, `melee: the ring has real reach (${first?.radius?.toFixed(2)} m)`);
  ok(first && Math.abs(first.life - dur) < 1e-6,
    `melee: it lives exactly as long as the window (${first?.life} vs ${dur})`);
  ok(voices.length === 1, 'melee: exactly one held windup voice was started');
  ok(voices[0] && Math.abs(voices[0].duration - dur) < 1e-6,
    'melee: and it rises for the length of the window, not a fixed time');
  ok(voices[0] && voices[0].element === attackElement(a),
    `melee: in the attacker's element ('${voices[0]?.element}')`);
  ok(voices[0] && voices[0].moves > 0, 'melee: the voice tracks the body it belongs to');
  ok(!voices[0].released, 'melee: and it is still holding while the window is open');
  // Leaving the window releases it — a held voice that outlived its state
  // would be the one failure mode a sustained primitive can have.
  e.fsm.set('recover', {});
  ok(voices[0].released, 'melee: leaving the window releases it');
}

console.log('\na charger paws the ground, and the pawing accelerates');
{
  const { rings, voices, ticks } = windup('charger', 'gore', 40);
  ok(rings.length >= 1, `charge: a ground ring went up (${rings.length})`);
  ok(voices.length === 1, 'charge: with a held windup voice');
  ok(ticks.length >= 3, `charge: and a series of scuff ticks (${ticks.length})`);
  const rates = ticks.map((t) => t.rate);
  ok(rates.every((r, i) => i === 0 || r >= rates[i - 1]),
    'charge: whose rate only ever rises, into the dash');
  ok(rates[rates.length - 1] > rates[0] + 0.2,
    `charge: and rises audibly (${rates[0].toFixed(2)} -> ${rates[rates.length - 1].toFixed(2)})`);
}

console.log('\na beam spools up: beads down the aim line for the length of the charge');
{
  const beads = [];
  const def = ENEMIES.find((e) => e.id === 'colossus');
  const idx = def.attacks.findIndex((a) => a.id === 'barrage');
  const w = makeWorld();
  w.ctx.vfx.beams.spawn = (from, to) => beads.push({ from: { ...from }, to: { ...to } });
  const e = new Enemy();
  e.spawn(w.ctx, def, { x: 12, y: 0, z: 0 }, {});
  e.targetPlayer = w.player;
  e.beginAttack(w.ctx, idx);
  const dur = def.attacks[idx].windup * e.timeScale;
  for (let i = 0; i < 40; i++) { w.ctx.time += dur / 41; e.fsm.update(w.ctx, dur / 41); }
  ok(beads.length >= 5, `barrage: the kestrelLance bead grammar fired (${beads.length} beads)`);
  ok(beads.length <= 6, 'barrage: six beads whatever the window length, not one per frame');
  ok(w.voices.length === 1 && Math.abs(w.voices[0].duration - dur) < 1e-6,
    `barrage: the 1.9s window — the largest measured — is held for all of it (${dur.toFixed(2)}s)`);
}

console.log('\nno windup in the roster is silent or unmarked any more');
{
  const missing = [];
  const kinds = new Set();
  for (const def of ENEMIES) {
    for (const a of def.attacks || []) {
      if (!(a.windup > 0)) continue;
      kinds.add(a.kind);
      const w = makeWorld();
      const e = new Enemy();
      e.spawn(w.ctx, def, { x: 3.2, y: 0, z: 0 }, {});
      e.targetPlayer = w.player;
      e.beginAttack(w.ctx, def.attacks.indexOf(a));
      if (!w.rings.length || !w.voices.length) missing.push(`${def.id}/${a.id} (${a.kind})`);
    }
  }
  ok(missing.length === 0,
    `every telegraphed attack opens with a ring and a voice — ${missing.length} silent: ${missing.join(', ') || 'none'}`);
  ok(kinds.size >= 10, `and the sweep really covered the registry (${kinds.size} kinds: ${[...kinds].sort().join(', ')})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
