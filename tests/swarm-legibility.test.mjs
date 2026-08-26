// tests/swarm-legibility.test.mjs
//
// Status legibility gap named in docs/superpowers/plans/2026-08-26-corruption-atmosphere.md:
// burn already streams embers for its whole duration (VFX.js's STATUS table),
// but the three insect items (carrion-flies, hive-gland, scrapfly-hive) tagged
// nothing onto a victim beyond the strike itself. This drives each of the
// three through its real hook with a spy `ctx.vfx.status` and insists the
// swarm overlay actually fires — and, per this repo's standard, that the
// assertion can fail: each block is preceded by a comment describing the one
// line whose removal turns it red (confirmed by hand, not merely asserted).

import * as THREE from 'three';
import { ITEM_BY_ID } from '../src/data/items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeTarget(id) {
  return { id, alive: true, position: new THREE.Vector3(3, 0, 0), radius: 0.5, height: 1.6 };
}

function baseApi(ctx, overrides = {}) {
  const cooldowns = new Map();
  const player = { position: new THREE.Vector3(0, 0, 0), alive: true, isPlayer: true };
  return {
    ctx, count: 1, procDepth: 1, player,
    roll: () => true,
    combat: {
      applyDamage: () => {}, applyStatus: () => {},
      nearestHostile: () => null, sphereOverlap: () => 0, overlapAt: () => null,
      ...overrides.combat,
    },
    items: {
      baseDamage: () => 10,
      cooldownReady: (key, secs) => {
        const prev = cooldowns.get(key);
        if (prev !== undefined && ctx.time - prev < secs) return false;
        cooldowns.set(key, ctx.time);
        return true;
      },
      addEffect: (id, dur, interval, cb) => { ctx._effect = cb; },
      ...overrides.items,
    },
  };
}

function statusRig() {
  const statuses = [];
  const ctx = {
    time: 10,
    vfx: {
      status: (entity, type, colour) => statuses.push({ entity, type, colour }),
      beam: () => {}, missile: () => {}, hitSpark: () => {}, burst: () => {},
    },
  };
  return { ctx, statuses };
}

console.log('\ncarrion-flies marks a swarmed victim, throttled per target');
{
  const { ctx, statuses } = statusRig();
  const target = makeTarget(1);
  const api = baseApi(ctx, { combat: { sphereOverlap: () => 1, overlapAt: () => target } });
  ITEM_BY_ID.get('carrion-flies').hooks.onInterval({ dt: 0.1 }, api);
  ok(statuses.length === 1 && statuses[0].type === 'swarm' && statuses[0].entity === target,
    'first tick tags the victim swarm');
  // RED ARM (confirmed by hand): removing the `cooldownReady` guard and
  // calling `vfx.status` unconditionally on every tick turns this second
  // assertion red — a second tick 0.1s later would re-fire before the 1.5s
  // throttle window closes.
  ITEM_BY_ID.get('carrion-flies').hooks.onInterval({ dt: 0.1 }, api);
  ok(statuses.length === 1, 'a second tick inside the 1.5s window does not re-fire');
}

console.log('\nhive-gland (seekingStrike, type swarm) marks its victim');
{
  const { ctx, statuses } = statusRig();
  const target = makeTarget(2);
  const seenSets = [];
  const api = baseApi(ctx, {
    combat: {
      nearestHostile: (from, range, team, seen) => {
        seenSets.push(seen);
        return seen.includes(target) ? null : target;
      },
    },
  });
  // RED ARM (confirmed by hand): deleting `seekingStrike`'s
  // `if (type === 'swarm') ctx.vfx?.status?.(...)` line leaves this at 0.
  ITEM_BY_ID.get('hive-gland').hooks.onInterval({ dt: 0.1 }, api);
  ok(statuses.some((s) => s.type === 'swarm' && s.entity === target),
    'hive-gland tags its struck target as swarmed');
}

console.log('\nscrapfly-hive tags its bled quarry as swarmed on every strike');
{
  const { ctx, statuses } = statusRig();
  const quarry = makeTarget(3);
  const api = baseApi(ctx, {
    combat: { nearestHostile: () => quarry },
  });
  ITEM_BY_ID.get('scrapfly-hive').hooks.onInterval({ dt: 0.1 }, api);
  ok(typeof ctx._effect === 'function', 'the fly effect callback was registered');
  // Strikes land every 4th tick (see the item's own comment); four ticks
  // reach the first strike.
  for (let i = 0; i < 4; i++) ctx._effect(api);
  // RED ARM (confirmed by hand): deleting the added
  // `a.ctx.vfx?.status?.(quarry, 'swarm', ...)` line after `applyStatus`
  // leaves this at 0 while the bleed-only behaviour stays intact.
  ok(statuses.some((s) => s.type === 'swarm' && s.entity === quarry),
    'scrapfly-hive marks its quarry as swarmed alongside the bleed');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
