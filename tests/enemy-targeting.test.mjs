/**
 * A real `Enemy`, driven headless, with two players in the roster.
 *
 *   node tests/enemy-targeting.test.mjs
 *
 * `tests/targeting.test.mjs` covers the acquisition *rule* in isolation. This
 * file covers the thing the rule was written for: that an enemy decides from
 * its own target rather than from `ctx.player`. Nothing else in the suite
 * constructs an `Enemy` or puts a second player in the roster, and the
 * single-player fingerprint cannot tell the two apart by construction — with
 * one player, `ctx.player` and `enemy.targetPlayer` are the same object.
 *
 * Every assertion below is written so that it FAILS against the pre-image. The
 * host is always registered first and is always `ctx.player`, so any code path
 * that still reaches for the global picks the host and the assertion breaks.
 *
 * Headless is real, not mocked: `Enemy.spawn` and `Enemy.fixedUpdate` are the
 * shipping functions, the rigs are real `EnemyMeshes` objects in a real
 * `THREE.Scene`, and the roster is the real `Roster`. Only `ctx.stage`,
 * `ctx.combat` and the presentation systems are absent, which the entity
 * already tolerates by design — every cross-system call in `Enemy.js` is
 * guarded so the game runs with any subset of the others missing.
 */
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// A deterministic LCG, so a failure is always the same failure.
function makeRng(seed = 12345) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

const P = (x, z) => ({
  isPlayer: true, alive: true, team: 'player', radius: 0.45,
  position: { x, y: 0, z }, velocity: { x: 0, y: 0, z: 0 },
});

/**
 * The host is added FIRST and is `ctx.player`, which is what makes these
 * assertions discriminating: `Roster.nearest` breaks ties toward the earlier
 * registration, so a stale global read and a correct roster read only diverge
 * when the guest is the nearer one — which is how every case below is set up.
 */
function makeWorld() {
  const rng = makeRng();
  const host = P(0, 0);
  const guest = P(40, 0);
  const roster = new Roster();
  const ctx = { rng, time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  roster.init(ctx);
  ctx.player = host;
  roster.add(host);
  roster.add(guest);
  return { ctx, roster, host, guest };
}

const byName = (name) => {
  const d = ENEMIES.find((e) => e.name === name);
  if (!d) throw new Error(`no enemy card named ${name}`);
  return d;
};

const H = 1 / 60;

// ---------------------------------------------------------------------------

console.log('an enemy standing by the guest fights the guest, not ctx.player');
{
  const { ctx, host, guest } = makeWorld();
  const e = new Enemy();
  e.spawn(ctx, byName('Chitter Mite'), { x: 38, y: 0, z: 0 }, {});
  e.fixedUpdate(ctx, H);

  ok(e.targetPlayer === guest, 'targetPlayer is the guest');
  ok(e.targetPlayer !== ctx.player, 'and is NOT ctx.player, which is the host');
  ok(Math.abs(e.target.x - guest.position.x) < 1e-9, 'this.target tracks the guest');
  ok(Math.abs(e.distToPlayer - 2) < 1e-6, `distToPlayer is the 2 m to the guest, not the 38 m to the host (got ${e.distToPlayer.toFixed(3)})`);
  ok(host.position.x === 0, 'the host was never moved — the divergence is real, not a setup artefact');
}

console.log('two enemies at opposite ends fight different players');
{
  const { ctx, host, guest } = makeWorld();
  const near = new Enemy(), far = new Enemy();
  near.spawn(ctx, byName('Chitter Mite'), { x: 2, y: 0, z: 0 }, {});
  far.spawn(ctx, byName('Chitter Mite'), { x: 38, y: 0, z: 0 }, {});
  near.fixedUpdate(ctx, H);
  far.fixedUpdate(ctx, H);

  ok(near.targetPlayer === host, 'the one by the host fights the host');
  ok(far.targetPlayer === guest, 'the one by the guest fights the guest');
  ok(near.targetPlayer !== far.targetPlayer, 'a pack does not share one target — the whole point of the change');
}

console.log('a target that dies is dropped on the SAME step, not the next interval');
{
  const { ctx, guest, host } = makeWorld();
  const e = new Enemy();
  e.spawn(ctx, byName('Chitter Mite'), { x: 38, y: 0, z: 0 }, {});
  e.fixedUpdate(ctx, H);
  ok(e.targetPlayer === guest, 'holding the guest');

  const heldTimer = e.retargetT;
  ok(heldTimer > H, 'with time still on the retarget timer');

  guest.alive = false;
  e.fixedUpdate(ctx, H);
  ok(e.targetPlayer === host, 'switched to the surviving host immediately');
  ok(Math.abs(e.distToPlayer - 38) < 1e-6, 'and distToPlayer was refilled from the host on that same step');
}

console.log('with nobody targetable the enemy holds null and does not thrash the roster');
{
  const { ctx, roster, host, guest } = makeWorld();
  let queries = 0;
  const realNearest = roster.nearest.bind(roster);
  roster.nearest = (pos, out) => { queries++; return realNearest(pos, out); };

  const e = new Enemy();
  e.spawn(ctx, byName('Chitter Mite'), { x: 38, y: 0, z: 0 }, {});
  host.alive = false; guest.alive = false;
  for (let i = 0; i < 120; i++) e.fixedUpdate(ctx, H);

  ok(e.targetPlayer === null, 'target is null');
  ok(e.distToPlayer === 999, 'distToPlayer is the no-target sentinel');
  ok(queries < 120, `does not re-query on every one of 120 steps (got ${queries})`);
}

console.log('the stagger survives the first step — 60 units do not re-query together');
{
  const { ctx, roster } = makeWorld();
  const perStep = [];
  let queries = 0;
  const realNearest = roster.nearest.bind(roster);
  roster.nearest = (pos, out) => { queries++; return realNearest(pos, out); };

  const def = byName('Chitter Mite');
  const units = [];
  for (let i = 0; i < 60; i++) {
    const e = new Enemy();
    e.spawn(ctx, def, { x: 20 + (i % 10), y: 0, z: -10 + Math.floor(i / 10) }, {});
    units.push(e);
  }
  // Step 1 is the forced first acquisition: every unit has no target yet, so
  // 60 queries there is correct and expected. The stagger claim is about the
  // 120 steps after it.
  queries = 0;
  for (const e of units) e.fixedUpdate(ctx, H);
  const firstStep = queries;

  for (let s = 0; s < 120; s++) {
    queries = 0;
    for (const e of units) e.fixedUpdate(ctx, H);
    perStep.push(queries);
  }

  const busiest = Math.max(...perStep);
  const total = perStep.reduce((a, b) => a + b, 0);
  const distinctPhases = new Set(units.map((e) => e.retargetT.toFixed(6))).size;

  console.log(`    first step: ${firstStep} queries (forced acquisition, expected 60)`);
  console.log(`    steps 2-121: ${total} queries, busiest single step ${busiest}/60, distinct phases ${distinctPhases}`);

  // 120 steps is 2 s, which is four RETARGET_INTERVALs, so 60 units owe about
  // 240 re-queries. The claim under test is not how many but how they land.
  ok(firstStep === 60, 'every unit acquires on its first step, so none idles waiting for its phase');
  ok(distinctPhases >= 55, `units hold distinct re-query phases after stepping (got ${distinctPhases}/60)`);
  ok(busiest <= 6, `no step carries more than a handful of the 60 re-queries (busiest ${busiest})`);
  ok(total >= 200 && total <= 280, `each unit still re-queries about four times over 2 s (total ${total})`);
}

console.log('directional armour is measured against the unit\'s own target');
{
  const { ctx, host, guest } = makeWorld();
  const e = new Enemy();
  // A Vault Warden between the two, nearer the guest, so it fights the guest.
  e.spawn(ctx, byName('Vault Warden'), { x: 30, y: 0, z: 0 }, {});
  e.fixedUpdate(ctx, H);
  ok(e.targetPlayer === guest, 'the warden fights the guest');

  const bare = e.baseArmor;
  // Facing +x, which is the guest at x=40. The host at x=0 is directly behind.
  e.yaw = Math.PI / 2;
  const facingGuest = e.armor;
  // Facing -x, which is the host. The guest is now behind the shield.
  e.yaw = -Math.PI / 2;
  const facingHost = e.armor;

  ok(facingGuest > bare, 'the shield counts while the warden faces the player it is fighting');
  ok(facingHost === bare, 'and does NOT count while it faces the other player, who it is not fighting');
  ok(e.facingPlayer(e.def.frontArc) === false, 'facingPlayer measures the target, not ctx.player standing in the arc');
}

console.log('a beam damages everyone on the segment, even when a victim retaliates fatally');
{
  const { ctx, roster, host, guest } = makeWorld();
  // Both players on the +x axis, so one beam line covers both.
  host.position.x = 6; guest.position.x = 14;

  const shooter = new Enemy();
  shooter.spawn(ctx, byName('Chitter Mite'), { x: 0, y: 0, z: 0 }, {});
  shooter.fixedUpdate(ctx, H);
  shooter.yaw = Math.PI / 2;                 // aim down +x
  shooter.targetPlayer = host;               // aim at the near one

  // A bystander that will die mid-sweep. `Enemy.onDeath` writes the module
  // scratch `_v1`, which is the same vector `fireBeam` uses for the beam
  // origin — the re-entrancy this test exists to pin.
  const bystander = new Enemy();
  bystander.spawn(ctx, byName('Chitter Mite'), { x: 3, y: 0, z: 3 }, {});
  bystander._lastHit = { position: { x: 900, y: 900, z: 900 } };

  const hits = [];
  ctx.combat = {
    applyDamage(victim, amount) {
      hits.push(victim);
      // Razor Wire / thorns shape: damaging a player synchronously kills a
      // nearby enemy, re-entering Enemy.js before the sweep has finished.
      if (victim === host && bystander.alive) bystander.onDeath();
      return amount;
    },
  };

  shooter.fireBeam(ctx, { range: 40, color: 0 }, 0.8, 10);

  ok(hits.includes(host), 'the aimed-at host is hit');
  ok(hits.includes(guest), 'the teammate further down the same beam is hit too');
  ok(!bystander.alive, 'the bystander really did die inside the sweep — the hazard was exercised');
  ok(hits.length === 2, `exactly the two players on the line (got ${hits.length})`);
}

console.log('a beam does not hit a player who is nowhere near the line');
{
  const { ctx, host, guest } = makeWorld();
  host.position.x = 6;
  guest.position.x = 14; guest.position.z = 25;   // far off the beam axis

  const shooter = new Enemy();
  shooter.spawn(ctx, byName('Chitter Mite'), { x: 0, y: 0, z: 0 }, {});
  shooter.fixedUpdate(ctx, H);
  shooter.yaw = Math.PI / 2;
  shooter.targetPlayer = host;

  const hits = [];
  ctx.combat = { applyDamage(victim) { hits.push(victim); } };
  shooter.fireBeam(ctx, { range: 40, color: 0 }, 0.8, 10);

  ok(hits.includes(host), 'the host on the line is hit');
  ok(!hits.includes(guest), 'the guest off the line is not — the sweep is a segment test, not a roster-wide hit');
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
