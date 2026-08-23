// tests/enemy-mend-polarity.test.mjs
//
// EFFECT-LANGUAGE C5 (issue #159). The acolyte's mend shared a point with
// every blast in the game — it called `explosion` — and nothing separated an
// enemy heal from the player's own mint flare.
//
// C5's ruling for this entry is polarity, not shape: healing stays
// radial-spark rising, and an *enemy* mend takes enemy polarity, an element
// core rather than the white-hot core §1.2 reserves for player-facing cues.
// Two assertions, therefore:
//
//   1. `mendAllies` fires `enemyMend` in the attack's own colour and never
//      `explosion`;
//   2. `enemyMend`'s particle ramp starts at the element hue, where
//      `healPop`'s starts white-ward — the inversion is the whole separation,
//      so a copy of `healPop` under a new name would red here.
//
// Falsification, run by hand: restoring `fx(ctx, 'explosion', ...)` at
// Enemy.js reds case 1; setting `e.color0` to `healPop`'s pale mint reds
// case 2.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { VFX } from '../src/systems/VFX.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const card = ENEMIES.find((e) => e.id === 'acolyte');
const mend = card.attacks.find((a) => a.id === 'mend');

console.log('the acolyte mend calls its own cue, not the blast');
{
  const calls = [];
  const hurt = {
    alive: true, dying: false, position: { x: 1, y: 0, z: 0 },
    health: 10, maxHealth: 100, shield: 0, maxShield: 0,
  };
  const ctx = {
    director: { enemies: [hurt] },
    vfx: new Proxy({}, {
      has: () => true,
      get: (_t, name) => (typeof name === 'string'
        ? (...args) => calls.push({ name, args })
        : undefined),
    }),
    audio: { heal() {} },
  };
  const e = new Enemy();
  e.position = new THREE.Vector3(0, 0, 0);
  e.mendAllies(ctx, mend);

  ok(hurt.health > 10, 'precondition: the mend actually healed someone');
  ok(!calls.some((c) => c.name === 'explosion'), 'no `explosion` — a mend is not a blast');
  const cue = calls.find((c) => c.name === 'enemyMend');
  ok(!!cue, '`enemyMend` fired instead');
  ok(cue && cue.args[1] === mend.color,
    `and carries the attack's own hue (0x${mend.color.toString(16)})`);
}

console.log('\nand it is drawn at enemy polarity: element core, not white core');
{
  // Drive the real method bodies against a recording emitter rather than a
  // GPU: what is under test is the colour ramp they write, nothing else.
  const shot = () => {
    const rec = [];
    const ep = () => {
      const e = {
        position: { copy() {}, y: 0 }, dir: { set() {} },
        color0: { hex: null, set(h) { this.hex = h; } },
        color1: { hex: null, set(h) { this.hex = h; } },
      };
      rec.push(e);
      return e;
    };
    const self = {
      _ep: ep,
      particles: { emit() {} },
      lights: { flick() {} },
      numbers: { spawn() {} },
      ctx: { audio: { heal() {} } },
    };
    return { self, rec };
  };

  const a = shot();
  VFX.prototype.enemyMend.call(a.self, { x: 0, y: 0, z: 0 }, mend.color);
  const core = a.rec[0]?.color0?.hex;
  ok(core === mend.color, `enemyMend's core is the element itself (0x${(core ?? 0).toString(16)})`);

  const b = shot();
  VFX.prototype.healPop.call(b.self, { x: 0, y: 0, z: 0 }, 0);
  const player = b.rec[0]?.color0?.hex;
  ok(player !== core, 'and is not the core the player-facing healPop uses');
  // Player polarity is the pale end of the ramp; enemy polarity is not.
  const pale = (h) => ((h >> 16) & 255) > 150 && ((h >> 8) & 255) > 150 && (h & 255) > 150;
  ok(pale(player), 'precondition: healPop starts white-ward (player polarity, §1.2)');
  ok(!pale(core), 'enemyMend does not');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
