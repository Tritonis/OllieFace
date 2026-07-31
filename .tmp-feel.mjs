// Re-measures the tuned movement constants after the applyCommand refactor.
// Expected (from the original headless harness): 0.117s to top speed,
// jump apex 3.34m, 1.23s airtime, coyote 0.12s, buffer 0.15s, dash 22 m/s,
// 0.32s i-frames.
import * as THREE from 'three';
import { Player } from './src/entities/Player.js';
import { BTN } from './src/net/Protocol.js';
import { RNG } from './src/core/MathUtil.js';

const H = 1 / 60;
const FLAT = 0;

function makeStage(sampleHeight) {
  return {
    sampleHeight,
    raycast: () => null,
    capsuleResolve(position, r, h, velocity, dt) {
      const p = position.clone().addScaledVector(velocity, dt);
      const v = velocity.clone();
      const floor = sampleHeight(p.x, p.z);
      let grounded = false;
      if (p.y <= floor) { p.y = floor; if (v.y < 0) v.y = 0; grounded = true; }
      return { position: p, velocity: v, grounded, normal: new THREE.Vector3(0, 1, 0) };
    },
  };
}

function makePlayer(sampleHeight = () => FLAT) {
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    stage: makeStage(sampleHeight), time: 0, authority: true,
    rng: new RNG(1), fxRng: new RNG(2),
    events: { on() {}, emit() {} },
  };
  const p = new Player();
  p.init(ctx);
  p.position.set(0, FLAT, 0);
  p.velocity.set(0, 0, 0);
  return { p, ctx };
}

const cmd = (o = {}) => ({ tick: 0, moveX: 0, moveZ: 0, buttons: 0, yaw: 0, pitch: 0, ...o });
let tick = 0;
const step = (p, o) => { const c = cmd(o); c.tick = ++tick; p.applyCommand(c, H); };

// --- time to top speed ------------------------------------------------------
{
  tick = 0;
  const { p } = makePlayer();
  step(p, {});                       // settle on the ground
  const top = p.stats.moveSpeed;
  let t = 0;
  for (let i = 0; i < 200; i++) {
    step(p, { moveZ: 1 });
    t += H;
    if (Math.hypot(p.velocity.x, p.velocity.z) >= top - 1e-9) break;
  }
  console.log('time to top speed :', t.toFixed(4), 's  (top =', top, 'm/s)');
}

// --- jump apex + airtime ----------------------------------------------------
{
  tick = 0;
  const { p } = makePlayer();
  step(p, {});
  let apex = 0, air = 0, held = true;
  for (let i = 0; i < 400; i++) {
    // Full-height jump: hold the button for the whole rise.
    if (p.velocity.y < 0) held = false;
    step(p, { buttons: held ? BTN.JUMP : 0 });
    apex = Math.max(apex, p.position.y);
    if (!p.grounded) air += H;
    else if (air > 0) break;
  }
  console.log('jump apex         :', apex.toFixed(4), 'm');
  console.log('airtime           :', air.toFixed(4), 's');
}

// --- coyote window ----------------------------------------------------------
{
  // Walk off a ledge, then jump N ticks later; find the last N that still works.
  let last = 0;
  for (let delay = 0; delay < 20; delay++) {
    tick = 0;
    const { p } = makePlayer((x) => (x < 2 ? FLAT : -50));
    step(p, {});
    while (p.position.x < 2.2) step(p, { moveX: 1 });   // off the edge
    for (let i = 0; i < delay; i++) step(p, {});
    const before = p.velocity.y;
    step(p, { buttons: BTN.JUMP });
    if (p.velocity.y > before + 5) last = delay;
  }
  console.log('coyote window     :', ((last + 1) * H).toFixed(4), 's');
}

// --- jump buffer ------------------------------------------------------------
{
  let last = 0;
  for (let early = 0; early < 20; early++) {
    tick = 0;
    const { p } = makePlayer();
    step(p, {});
    p.position.y = 6; p.velocity.y = 0; p.grounded = false;
    // Fall until `early` ticks remain before landing, then tap jump and hold.
    const ticksToLand = [];
    while (!p.grounded) { step(p, {}); ticksToLand.push(p.position.y); }
    const fall = ticksToLand.length;

    tick = 0;
    const { p: q } = makePlayer();
    step(q, {});
    q.position.y = 6; q.velocity.y = 0; q.grounded = false;
    for (let i = 0; i < fall - early - 1; i++) step(q, {});
    step(q, { buttons: BTN.JUMP });                 // tap, released after
    for (let i = 0; i <= early + 2; i++) step(q, {});
    if (q.velocity.y > 4) last = early;
  }
  console.log('jump buffer       :', ((last + 1) * H).toFixed(4), 's');
}

// --- dash speed + i-frames --------------------------------------------------
{
  tick = 0;
  const { p } = makePlayer();
  step(p, {});
  step(p, { moveZ: 1, buttons: BTN.UTILITY });
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  console.log('dash speed        :', speed.toFixed(4), 'm/s');
  console.log('dash i-frames     :', p.iframes.toFixed(4), 's');
  let dashT = 0;
  while (p.dashTime > 0) { step(p, { moveZ: 1 }); dashT += H; }
  console.log('dash duration     :', dashT.toFixed(4), 's');
}
