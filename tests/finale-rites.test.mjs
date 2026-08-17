// #37: the two finale routes have to express different *verbs*, not different
// numbers. Every arm below is written to fail if the two routes converge —
// the assertions are contrasts between the routes rather than checks that each
// route does something, because "each does something" passes just as happily
// when both do the same thing.
import * as THREE from 'three';
import {
  REALM_BY_ID, FINALE_RITES, FINALE_PHASES, riteFor, riteErosion, riteRadius, ritePower,
} from '../src/data/realms.js';
import { FinaleController } from '../src/world/realms/FinalBoss.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const CLEAN = riteFor('fracture');
const VOID = riteFor('fracture-void');

console.log('each route names a rite, and they are not the same rite');
{
  ok(!!CLEAN && !!VOID, 'both finale realms carry a rite');
  ok(CLEAN.id !== VOID.id, 'and they are different rites');
  ok(riteFor('crucible') === null, 'an ordinary realm has none');
  ok(FINALE_RITES[CLEAN.id].realm === 'fracture' && FINALE_RITES[VOID.id].realm === 'fracture-void',
     'each rite names the realm it belongs to');
}

// The verb, stated as an inequality. Containment can be *finished*; consumption
// cannot. If someone gave the void route breaches, or took the clean route's
// recovery away, these are the arms that notice.
console.log('containment can be stopped; consumption cannot');
{
  ok(CLEAN.breaches > 0, 'the clean route opens breaches to seal');
  ok(VOID.breaches === 0, 'the void route opens nothing — there is nothing to kill');
  ok(riteErosion(CLEAN, 0) === 0, 'sealing every breach stops the clean erosion dead');
  ok(riteErosion(VOID, 0) > 0, 'the void floor keeps going with no adds alive at all');
  ok(riteErosion(CLEAN, 3) > riteErosion(CLEAN, 1), 'and each open breach eats faster');
}

console.log('the floor: won back on one route, gone for good on the other');
{
  // Same starting radius, same elapsed time, nothing left alive on the ground.
  let clean = 20, dark = 20;
  for (let i = 0; i < 60; i++) {
    clean = riteRadius(clean, CLEAN, 0, 1 / 60, 22);
    dark = riteRadius(dark, VOID, 0, 1 / 60, 22);
  }
  ok(clean > 20, 'a second of a sealed containment wins ground back');
  ok(dark < 20, 'the same second on the void route loses it');
  ok(CLEAN.permanentLoss === false && VOID.permanentLoss === true, 'and the table says which is which');

  let capped = 21.9;
  for (let i = 0; i < 600; i++) capped = riteRadius(capped, CLEAN, 0, 1 / 60, 22);
  ok(Math.abs(capped - 22) < 1e-9, 'containment recovers to the phase radius and no further');

  let eaten = 20;
  for (let i = 0; i < 6000; i++) eaten = riteRadius(eaten, VOID, 0, 1 / 60, 22);
  ok(Math.abs(eaten - VOID.minRadius) < 1e-9, 'and the void floor bottoms out rather than vanishing');
  ok(VOID.minRadius > 0 && VOID.minRadius < FINALE_PHASES.at(-1).floorRadius,
     'the bottom is real ground, and less than the phase started with');
}

console.log('the void route spends the debt; the clean route has no debt to spend');
{
  ok(ritePower(CLEAN, 500, 40).spent === 0 && ritePower(CLEAN, 500, 40).bonus === 0,
     'containment buys nothing however corrupt the world got');
  const poor = ritePower(VOID, 100, 0);
  const rich = ritePower(VOID, 1000, 0);
  ok(rich.spent > poor.spent, 'a more corrupt run spends more of the ledger');
  ok(rich.bonus > poor.bonus, 'and is paid more for it');
  ok(Math.abs(rich.spent - 1000 * VOID.debtFraction) < 1e-9, 'the spend is the rite’s own fraction of the world');
  ok(ritePower(VOID, 1e9, 1e9).bonus === VOID.powerCap, 'the bargain is capped');
  // The debt half is capped below the total on purpose: without that, the runs
  // that took the void route hardest would arrive at the ceiling and the
  // consuming half of the verb would be worth nothing to them.
  ok(ritePower(VOID, 1e6, 5).bonus > ritePower(VOID, 1e6, 0).bonus,
     'even a maxed-out ledger is still paid for eating');
  ok(ritePower(VOID, 0, 10).bonus > ritePower(VOID, 0, 0).bonus, 'consuming adds pays even at zero debt');
  ok(ritePower(VOID, 0, 0).bonus === 0, 'and an uncorrupted run that eats nothing gets nothing');
}

// ------------------------------------------------------------ the controller

const stub = (realmId, { world = 800 } = {}) => {
  const def = REALM_BY_ID.get(realmId);
  const spawned = [], objectives = [], buffs = [], bled = [];
  const boss = {
    alive: true, phase: 1, maxHealth: 4000, health: 4000, damage: 40,
    baseArmor: 0, position: new THREE.Vector3(),
  };
  let first = true;
  const subs = new Map();
  const radii = [];
  const stage = {
    origin: new THREE.Vector3(0, 0, 0), floorRadius: def.floorRadius,
    root: new THREE.Group(), anchorSites: [],
    setFloorRadius(r) { this.floorRadius = r; radii.push(r); },
    addPlatform() {}, addMesh() {},
  };
  const ctx = {
    authority: true, seed: 7,
    events: {
      on(k, f) { if (!subs.has(k)) subs.set(k, new Set()); subs.get(k).add(f); return () => subs.get(k).delete(f); },
      off(k, f) { subs.get(k)?.delete(f); },
      emit(k, e) { for (const f of subs.get(k) ?? []) f(e); },
    },
    corruption: {
      world,
      bleed(p, amount) { bled.push(amount); this.world = Math.max(0, this.world - amount); },
    },
    player: { alive: true, position: new THREE.Vector3(), grantBuff: (b, d) => buffs.push(b) },
    director: {
      boss: null, enemies: [],
      spawnOne: (c, card, at) => {
        if (first) { first = false; return boss; }
        const e = { alive: true, health: 100, maxHealth: 100, position: at.clone(), rig: null };
        spawned.push(e);
        return e;
      },
      spawnWave() {}, denyHealing() {},
    },
    interactables: { spawnOrb() {} },
    hud: { setObjective: (s) => objectives.push(s) },
    vfx: { burst() {}, explosion() {} },
    audio: { play() {} },
    pipeline: { addShake() {} },
  };
  const fc = new FinaleController({ active: { stage } }, def);
  fc.enter(ctx, stage);
  // Straight to the rite phase, with the collapse already settled: the rite is
  // what this section is about, not the animation in front of it.
  boss.phase = 3;
  fc.fixedUpdate(ctx, 1 / 60);
  fc.collapseT = 0;
  return { fc, ctx, stage, boss, spawned, objectives, buffs, bled, radii };
};

console.log('entering phase 3 does different things on the two routes');
{
  const c = stub('fracture');
  const v = stub('fracture-void');
  ok(c.spawned.length === CLEAN.breaches, `the clean route tears open ${CLEAN.breaches} breaches`);
  ok(v.spawned.length === 0, 'the void route tears open none');
  ok(c.bled.length === 0, 'the clean route drains no corruption');
  ok(v.bled.length === 1 && v.bled[0] > 0, 'the void route drains the ledger exactly once');
  ok(v.ctx.corruption.world < 800, 'and the world is genuinely less corrupt afterwards');
  ok(v.buffs.length === 1 && v.buffs[0].damageMult > 1, 'the debt comes back as damage');
  ok(c.buffs.length === 0, 'the clean route is paid nothing');
  ok(c.objectives.at(-1) === CLEAN.objective && v.objectives.at(-1) === VOID.objective,
     'and the HUD tells the player which fight this is');
  ok(CLEAN.objective !== VOID.objective, 'the two objective lines are not the same sentence');
}

console.log('the clean route can save its arena by sealing; the void route cannot');
{
  const c = stub('fracture');
  const before = c.stage.floorRadius;
  for (let i = 0; i < 60; i++) c.fc.fixedUpdate(c.ctx, 1 / 60);
  const eroded = c.stage.floorRadius;
  ok(eroded < before, 'with breaches open the floor is going');
  for (const e of c.spawned) e.alive = false;
  for (let i = 0; i < 60; i++) c.fc.fixedUpdate(c.ctx, 1 / 60);
  ok(c.stage.floorRadius > eroded, 'sealing them wins the ground back');
  ok(c.objectives.at(-1) === CLEAN.doneObjective, 'and the objective says so');

  const v = stub('fracture-void');
  const vBefore = v.stage.floorRadius;
  for (let i = 0; i < 120; i++) v.fc.fixedUpdate(v.ctx, 1 / 60);
  const vMid = v.stage.floorRadius;
  ok(vMid < vBefore, 'the void floor goes with nothing on it');
  for (let i = 0; i < 120; i++) v.fc.fixedUpdate(v.ctx, 1 / 60);
  ok(v.stage.floorRadius < vMid, 'and keeps going — there is no sealing it');
}

console.log('the void route feeds on the swarm');
{
  const v = stub('fracture-void');
  const paid = v.buffs.length;
  for (let i = 0; i < 5; i++) v.ctx.events.emit('kill', { victim: { alive: false } });
  ok(v.fc.consumed === 5, 'five adds consumed');
  ok(v.buffs.length > paid, 'and each one moved the multiplier');
  const total = v.buffs.reduce((a, b) => a * b.damageMult, 1);
  ok(Math.abs(total - (1 + v.fc.ritePowerBonus)) < 1e-9,
     'the granted buffs multiply out to exactly the bonus the rite priced');

  v.ctx.events.emit('kill', { victim: v.boss });
  ok(v.fc.consumed === 5, 'the Herald itself is not food');

  const c = stub('fracture');
  for (let i = 0; i < 5; i++) c.ctx.events.emit('kill', { victim: { alive: false } });
  ok(c.fc.consumed === 0 && c.buffs.length === 0, 'the clean route eats nothing and is paid nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
