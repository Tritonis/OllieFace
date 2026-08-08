// Corruption is the router (launch spec §2): the band picks which Fracture
// opens, the middle band sees both, no band dead-ends, and the ending is
// keyed off the route taken.
import * as THREE from 'three';
import {
  REALM_BY_ID, FINALE_ROUTES, routesFor, ENDINGS, FINALE_STAGE,
} from '../src/data/realms.js';
import { Realms } from '../src/world/realms/Realms.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('every band reaches an ending — no dead ends');
{
  for (let band = 0; band <= 4; band++) {
    ok(routesFor(band).length >= 1, `band ${band} has at least one route`);
  }
  ok(routesFor(0).every((r) => r.realm === 'fracture'), 'Pristine opens only the clean route');
  ok(routesFor(1).every((r) => r.realm === 'fracture'), 'Seeded opens only the clean route');
  ok(routesFor(2).length === 2, 'Blighted sees both and must commit');
  ok(routesFor(3).every((r) => r.realm === 'fracture-void'), 'Overrun opens only the void route');
  ok(routesFor(4).every((r) => r.realm === 'fracture-void'), 'Consumed opens only the void route');
}

console.log('the void finale is a real realm riding the finale machinery');
{
  const def = REALM_BY_ID.get('fracture-void');
  ok(!!def, 'fracture-void is registered');
  ok(def.kind === 'finale' && def.exit === 'end' && def.combat === true, 'same contract as the Fracture');
  ok(def.bossScale?.health > 1 && def.bossScale?.damage > 1, 'the Herald has more teeth here');
  ok(def.voidLoot >= 1, 'the void route pays corrupted loot');
  ok(FINALE_ROUTES.every((r) => REALM_BY_ID.has(r.realm)), 'every route names a registered realm');
  ok(FINALE_ROUTES.every((r) => typeof r.name === 'string' && r.name.length), 'every route is nameable by the HUD');
}

console.log('endings key off the route');
{
  ok(ENDINGS.victoryVoid?.id === 'victory-void' && ENDINGS.victoryVoid.won === true, 'the void victory exists and counts as a win');
  ok(ENDINGS.victory.id === 'victory', 'the clean victory is untouched');
}

console.log('openPortals spawns the routes the band allows');
{
  const spawnFor = (band, { authority = true } = {}) => {
    const added = [];
    const ctx = {
      authority,
      corruption: { band },
      interactables: { add: (p) => added.push(p) },
      hud: null,
      events: { on() {}, emit() {} },
    };
    const realms = new Realms();
    realms.ctx = ctx;                       // init wiring not needed for this method
    realms.openPortals(new THREE.Vector3(0, 0, 0), FINALE_STAGE);
    return added;
  };
  ok(spawnFor(0).length === 1 && spawnFor(0)[0].label === routesFor(0)[0].label, 'Pristine: one portal, the clean one');
  ok(spawnFor(2).length === 2, 'Blighted: both portals stand side by side');
  const consumed = spawnFor(4);
  ok(consumed.length === 1 && consumed[0].label === routesFor(4)[0].label, 'Consumed: only the void way opens');
  ok(spawnFor(4, { authority: false }).length === 0, 'a client spawns nothing');
}

console.log('victory picks the ending for the realm it happened in');
{
  const endings = [];
  const realms = new Realms();
  realms.ctx = { progression: { finishRun: (e) => endings.push(e) } };
  realms.active = { def: REALM_BY_ID.get('fracture') };
  realms.victory();
  realms.active = { def: REALM_BY_ID.get('fracture-void') };
  realms.victory();
  ok(endings[0] === ENDINGS.victory, 'clean Fracture ends in the clean victory');
  ok(endings[1] === ENDINGS.victoryVoid, 'void Fracture ends in the void victory');
}

console.log('the void finale arms itself: boss scale applied, blight loot ringed');
{
  const { FinaleController } = await import('../src/world/realms/FinalBoss.js');
  const { REALM_BY_ID } = await import('../src/data/realms.js');
  const def = REALM_BY_ID.get('fracture-void');
  const orbs = [];
  const boss = { alive: true, maxHealth: 4000, health: 4000, damage: 40, position: new THREE.Vector3() };
  const ctx = {
    authority: true, seed: 424242,
    events: { on() {}, emit() {} },
    director: { spawnOne: () => boss, boss: null },
    interactables: { spawnOrb: (pos, id, s) => orbs.push({ pos: pos.clone(), id }) },
    items: {}, hud: null, pipeline: null,
  };
  const stage = {
    origin: new THREE.Vector3(0, 0, 0), floorRadius: def.floorRadius,
    root: new THREE.Group(),
  };
  const fc = new FinaleController({ active: { stage } }, def);
  fc.enter(ctx, stage);
  ok(boss.maxHealth === Math.round(4000 * def.bossScale.health), 'Herald health scaled');
  ok(boss.health === boss.maxHealth, 'and topped up to the new ceiling');
  ok(Math.abs(boss.damage - 40 * def.bossScale.damage) < 1e-9, 'Herald damage scaled');
  ok(orbs.length === def.voidLoot, `${def.voidLoot} corrupted orbs paid on arrival`);
  const { ITEM_BY_ID } = await import('../src/data/items.js');
  ok(orbs.every((o) => ITEM_BY_ID.get(o.id)?.tier === 'blight'), 'every orb is blight-tier');
  ok(orbs.every((o) => Math.abs(Math.hypot(o.pos.x, o.pos.z) - def.floorRadius * 0.7) < 1e-6), 'ringed at 0.7 x floor radius');

  // The clean finale is untouched: same stub, fracture def, nothing scales.
  const boss2 = { alive: true, maxHealth: 4000, health: 4000, damage: 40, position: new THREE.Vector3() };
  ctx.director.spawnOne = () => boss2;
  const orbCount = orbs.length;
  const fc2 = new FinaleController({ active: { stage } }, REALM_BY_ID.get('fracture'));
  fc2.enter(ctx, stage);
  ok(boss2.maxHealth === 4000 && boss2.damage === 40, 'clean Fracture Herald unscaled');
  ok(orbs.length === orbCount, 'clean Fracture pays no arrival loot');
}

// The HUD end of the routing table. Same prototype-driving idiom the item
// mutation arms use: `updateMoney` owns the corruption gauge, so it runs on a
// hand-built `this` holding only the refs that block touches. `set`'s
// memoisation lives on `this.c`, so each arm gets a fresh subject.
console.log('the gauge previews the route from stage 3');
{
  const { HUD } = await import('../src/ui/HUD.js');
  const el = () => ({
    textContent: '', style: {}, dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
  });
  const gauge = (band, stageIndex) => {
    const self = Object.create(HUD.prototype);
    self.c = {};
    self.moneyShown = 0;
    const refs = {
      money: el(), moneyVal: el(),
      corruption: el(), corruptionFill: el(), corruptionBand: el(), corruptionRoute: el(),
    };
    self.refs = refs;
    self.updateMoney({ items: { gold: 0 }, corruption: { world: 0, band }, progression: { stageIndex } }, 0.016);
    return refs;
  };

  const early = gauge(2, 0);
  ok(early.corruptionRoute.textContent === '', 'before stage 3 the gauge says nothing about the route');
  ok(!early.corruptionRoute.classList.contains('is-on'), 'and the line stays hidden');

  const contested = gauge(2, 2);
  ok(contested.corruptionRoute.textContent === 'Route: contested', 'Blighted at stage 3 sees both doors');
  ok(contested.corruptionRoute.classList.contains('is-on'), 'and the line is shown');
  ok(contested.corruption.classList.contains('has-route'), 'the gauge buys the row it needs');

  ok(gauge(0, 2).corruptionRoute.textContent === `Route: ${routesFor(0)[0].name}`, 'Pristine names the clean door');
  ok(gauge(4, 2).corruptionRoute.textContent === `Route: ${routesFor(4)[0].name}`, 'Consumed names the void door');

  // The HUD never invents a name the portals would not carry.
  ok(routesFor(0)[0].name !== routesFor(4)[0].name, 'the two doors read differently on the gauge');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
