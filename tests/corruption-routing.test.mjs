// Corruption is the router (launch spec §2): the band picks which Fracture
// opens, no band dead-ends, and the ending is keyed off the route taken. The
// clean route's band ceiling moved from Blighted down to Seeded on
// 2026-08-28 (#171/#218): Blighted now opens only the void door, and a
// second, ledger-gated axis decides whether a band <= Seeded run gets the
// PLAIN clean ending or the redeemed one (`cleanRouteEligible`).
import * as THREE from 'three';
import {
  REALM_BY_ID, FINALE_ROUTES, routesFor, ENDINGS, FINALE_STAGE, cleanRouteEligible,
} from '../src/data/realms.js';
import { BANDS } from '../src/data/corruption.js';
import { alignmentOf } from '../src/data/alignment.js';
import { Realms } from '../src/world/realms/Realms.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('every band reaches an ending — no dead ends');
{
  // Bounded by the band table itself, not by the bands that happen to exist
  // today: adding a sixth band without widening a route would dead-end the run,
  // and this loop is what has to notice.
  for (let band = 0; band < BANDS.length; band++) {
    ok(routesFor(band).length >= 1, `band ${band} has at least one route`);
  }
  ok(routesFor(0).every((r) => r.realm === 'fracture'), 'Pristine opens only the clean route');
  ok(routesFor(1).every((r) => r.realm === 'fracture'), 'Seeded opens only the clean route');
  ok(routesFor(2).length === 1 && routesFor(2)[0].realm === 'fracture-void', 'Blighted opens only the void route');
  ok(routesFor(3).every((r) => r.realm === 'fracture-void'), 'Overrun opens only the void route');
  ok(routesFor(4).every((r) => r.realm === 'fracture-void'), 'Consumed opens only the void route');
}

console.log('cleanRouteEligible: the whole (band x ledger-class) surface (#218)');
{
  // Four reachable ledger shapes, one per `alignmentOf` partition member —
  // see data/alignment.js invariant 2. Values are chosen well past
  // TOLERANCE so classification is unambiguous.
  const LEDGERS = {
    neutral: { corrupt: 0, pure: 0, mixed: 0, history: [] },
    pure: { corrupt: 0, pure: 25, mixed: 0, history: [] },
    corrupt: { corrupt: 25, pure: 0, mixed: 0, history: [] },
    mixed: { corrupt: 0, pure: 0, mixed: 5, history: [] },
  };
  for (let band = 0; band < BANDS.length; band++) {
    for (const [cls, ledger] of Object.entries(LEDGERS)) {
      const expected = band <= 1 && cls !== 'corrupt';
      ok(cleanRouteEligible(band, ledger) === expected,
        `band ${band} (${BANDS[band].name}) x ${cls} ledger -> clean-eligible=${expected}`);
      // The invariant this whole ticket exists to hold: no reachable
      // (band, ledger) state ever drops below one finale route. Ledger plays
      // no part in `routesFor` (band-only), so this is a whole-surface check
      // that the ledger axis never sneaks into the router and dead-ends one.
      ok(routesFor(band).length >= 1,
        `band ${band} x ${cls} ledger: still >= 1 route open`);
    }
  }
  // A neutral (empty) ledger and a missing one must agree — `alignmentOf`
  // treats both as 'neutral', and callers (Realms.victory) pass whichever a
  // client that never touched corruption happens to hold.
  ok(cleanRouteEligible(0, null) === true, 'a null ledger reads as clean-eligible at Pristine');
  ok(cleanRouteEligible(1, undefined) === true, 'an undefined ledger reads as clean-eligible at Seeded');
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
  ok(FINALE_ROUTES.every((r) => r.name === REALM_BY_ID.get(r.realm).name), 'the route name is the realm’s own');
  ok(FINALE_ROUTES.every((r) => r.label.includes(r.name)), 'and the prompt cannot drift from it');
}

console.log('endings key off the route');
{
  ok(ENDINGS.victoryVoid?.id === 'victory-void' && ENDINGS.victoryVoid.won === true, 'the void victory exists and counts as a win');
  ok(ENDINGS.victory.id === 'victory', 'the clean victory is untouched');
  ok(ENDINGS.redeemed?.id === 'redeemed' && ENDINGS.redeemed.won === true, 'the redeemed ending exists and counts as a win');
  ok(ENDINGS.redeemed.id !== ENDINGS.victory.id, 'and it is recorded distinctly from the plain clean victory');
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
  const blighted = spawnFor(2);
  ok(blighted.length === 1 && blighted[0].label === routesFor(2)[0].label, 'Blighted: one portal, the void one');
  const consumed = spawnFor(4);
  ok(consumed.length === 1 && consumed[0].label === routesFor(4)[0].label, 'Consumed: only the void way opens');
  ok(spawnFor(4, { authority: false }).length === 0, 'a client spawns nothing');
}

// The gate opens once; corruption does not stop moving. The doors on the ground
// and the route the HUD previews have to still agree ten seconds later.
console.log('the band keeps routing after the gate opens');
{
  const bus = () => {
    const subs = new Map();
    return {
      on(k, f) { if (!subs.has(k)) subs.set(k, []); subs.get(k).push(f); },
      emit(k, e) { for (const f of subs.get(k) ?? []) f(e); },
    };
  };
  const world = (band) => {
    const added = [], objectives = [], sounds = [];
    const corruption = { band };
    const ctx = {
      authority: true,
      corruption,
      interactables: { add: (p) => added.push(p) },
      hud: { setObjective: (s) => objectives.push(s) },
      audio: { play: (n) => sounds.push(n) },
      events: bus(),
    };
    const realms = new Realms();
    realms.init(ctx);
    realms.openPortals(new THREE.Vector3(0, 0, 0), FINALE_STAGE);
    const band_ = (b) => { corruption.band = b; ctx.events.emit('corruptionBand', { band: b }); };
    return { ctx, realms, added, objectives, sounds, band: band_ };
  };

  const w = world(1);
  ok(w.added.length === 1, 'Seeded: the gate opens on the clean door alone');
  const clean = w.added[0];

  w.band(4);
  ok(w.added.length === 2, 'the world rots on the walk over and the void door arrives');
  const voidDoor = w.added[1];
  ok(voidDoor.label === routesFor(4)[0].label, 'the late arrival is the Hungering Fracture');
  ok(clean.position.distanceTo(voidDoor.position) > clean.radius + voidDoor.radius,
     'and it stands where it would have stood at the gate, clear of the first');

  w.band(4);
  ok(w.added.length === 2, 'a band event that allows nothing new opens nothing');

  ok(clean.interact() === false, 'the door the band left behind refuses the press');
  ok(w.realms._pendingEnter === null, 'nobody walks into the clean Fracture at Consumed');
  ok(clean.available(), 'the refused door stays standing — refusal is not removal');
  ok(w.sounds.includes('deny'), 'the refusal is audible');
  ok(w.objectives.at(-1).includes('too far gone'), 'and the HUD says which way the world went');

  ok(voidDoor.interact() === true, 'the door the band opened takes the press');
  ok(w.realms._pendingEnter === 'fracture-void', 'and the void route is the one entered');

  // The mirror case: a Voidtouched refund bleeds the party back down, and the
  // door that refused a moment ago works again. Nothing was destroyed.
  w.realms._pendingEnter = null;
  w.band(1);
  ok(w.added.length === 2, 'bleeding back opens no third door');
  ok(clean.interact() === true, 'the clean door works again');
  ok(w.realms._pendingEnter === 'fracture', 'and it is the clean Fracture that opens');

  // A client neither sites doors nor reacts to a band it cannot compute.
  const c = world(1);
  c.ctx.authority = false;
  c.band(4);
  ok(c.added.length === 1, 'a client adds no door of its own when the band moves');
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
  ok(endings[0] === ENDINGS.victory, 'clean Fracture ends in the clean victory (no corruption context: neutral ledger)');
  ok(endings[1] === ENDINGS.victoryVoid, 'void Fracture ends in the void victory');
}

console.log('victory: the clean door splits on the ledger, not just the band (#218)');
{
  const endingFor = (band, ledger) => {
    const endings = [];
    const realms = new Realms();
    realms.ctx = {
      progression: { finishRun: (e) => endings.push(e) },
      corruption: { band, ledger },
    };
    realms.active = { def: REALM_BY_ID.get('fracture') };
    realms.victory();
    return endings[0];
  };
  const clean = { corrupt: 0, pure: 0, mixed: 0, history: [] };
  const corrupted = { corrupt: 25, pure: 0, mixed: 0, history: [] };
  const mixedLedger = { corrupt: 0, pure: 0, mixed: 5, history: [] };

  ok(endingFor(0, clean) === ENDINGS.victory, 'Pristine, clean ledger: plain victory');
  ok(endingFor(1, clean) === ENDINGS.victory, 'Seeded, clean ledger: plain victory');
  ok(endingFor(0, corrupted) === ENDINGS.redeemed, 'Pristine, corrupt-classed ledger: redeemed, not victory');
  ok(endingFor(1, corrupted) === ENDINGS.redeemed, 'Seeded, corrupt-classed ledger: redeemed, not victory');
  ok(endingFor(1, mixedLedger) === ENDINGS.victory, 'a mixed-classed ledger does not bar the clean ending');

  // The void door is unaffected by any of this: `realmId` alone picks
  // `victoryVoid`, and `cleanRouteEligible` is never consulted for it.
  const voidEndings = [];
  const voidRealms = new Realms();
  voidRealms.ctx = { progression: { finishRun: (e) => voidEndings.push(e) }, corruption: { band: 3, ledger: corrupted } };
  voidRealms.active = { def: REALM_BY_ID.get('fracture-void') };
  voidRealms.victory();
  ok(voidEndings[0] === ENDINGS.victoryVoid, 'void Fracture always ends in the void victory, ledger notwithstanding');
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
  const gauge = (band, stageIndex, ledger = null) => {
    const self = Object.create(HUD.prototype);
    self.c = {};
    self.moneyShown = 0;
    const refs = {
      money: el(), moneyVal: el(),
      corruption: el(), corruptionFill: el(), corruptionBand: el(),
      corruptionNext: el(), corruptionRoute: el(),
    };
    self.refs = refs;
    // `alignment`, not just `ledger` (#220): HUD now reads `cor.alignment`
    // directly, the same field a real `Corruption` instance's getter (or a
    // guest's replicated class) always carries, rather than re-deriving it
    // from a ledger a guest never has the numbers for. Computed fresh on
    // every call, which is what lets the RED-PROOF block below hand-mutate
    // `ledger` in place and see the line move on the next `gauge()` call.
    self.updateMoney({
      items: { gold: 0 },
      corruption: { world: 0, band, ledger, alignment: alignmentOf(ledger) },
      progression: { stageIndex },
    }, 0.016);
    return refs;
  };

  const early = gauge(2, 0);
  ok(early.corruptionRoute.textContent === '', 'before stage 3 the gauge says nothing about the route');
  ok(!early.corruptionRoute.classList.contains('is-on'), 'and the line stays hidden');

  const blighted = gauge(2, 2);
  ok(blighted.corruptionRoute.textContent === `Route: ${routesFor(2)[0].name}`, 'Blighted at stage 3 names the void door');
  ok(blighted.corruptionRoute.classList.contains('is-on'), 'and the line is shown');
  ok(blighted.corruption.classList.contains('has-route'), 'the gauge buys the row it needs');

  ok(gauge(0, 2).corruptionRoute.textContent === `Route: ${routesFor(0)[0].name}`, 'Pristine names the clean door');
  ok(gauge(4, 2).corruptionRoute.textContent === `Route: ${routesFor(4)[0].name}`, 'Consumed names the void door');

  // The HUD never invents a name the portals would not carry.
  ok(routesFor(0)[0].name !== routesFor(4)[0].name, 'the two doors read differently on the gauge');

  // The barred line (#171/#219): a corrupt-classed ledger at a band that would
  // otherwise open the clean door. The whole (band x ledger-class) surface,
  // walked through the real `updateMoney` and checked against `cleanRouteEligible`
  // itself — never a second copy of the predicate — so the HUD text and the
  // realm's own eligibility check cannot drift apart.
  const BARRED_LINE = 'History bars the clean gate - a redeemed route stands open';
  const LEDGERS = {
    neutral: { corrupt: 0, pure: 0, mixed: 0, history: [] },
    pure: { corrupt: 0, pure: 25, mixed: 0, history: [] },
    corrupt: { corrupt: 25, pure: 0, mixed: 0, history: [] },
    mixed: { corrupt: 0, pure: 0, mixed: 5, history: [] },
  };
  for (let band = 0; band < BANDS.length; band++) {
    for (const [cls, ledger] of Object.entries(LEDGERS)) {
      const eligible = cleanRouteEligible(band, ledger);
      const refs = gauge(band, 2, ledger);
      if (eligible) {
        ok(refs.corruptionRoute.textContent === `Route: ${routesFor(band)[0].name}`,
          `band ${band} (${BANDS[band].name}) x ${cls} ledger: eligible -> names the real door`);
      } else {
        // Ineligibility has two causes (band alone, or the ledger on top of a
        // band that would allow it) and only the second one is the barred
        // line — the void door at a high band is not "barred", it was never
        // on offer, so it still just names itself.
        const bandAllowsClean = cleanRouteEligible(band, null);
        const expectBarred = bandAllowsClean;
        ok(refs.corruptionRoute.textContent === (expectBarred ? BARRED_LINE : `Route: ${routesFor(band)[0].name}`),
          `band ${band} (${BANDS[band].name}) x ${cls} ledger: ${expectBarred ? 'ledger bars the clean gate' : 'band never offered it'}`);
      }
    }
  }
  // RED-PROOF: a hand-mutated corrupt ledger at Pristine must show the barred
  // line, and reverting the ledger to neutral must bring the clean door name
  // straight back — proves the guard can actually go red on the bug it exists
  // to catch, not just agree with itself.
  const mutable = { corrupt: 0, pure: 0, mixed: 0, history: [] };
  ok(gauge(0, 2, mutable).corruptionRoute.textContent === `Route: ${routesFor(0)[0].name}`,
    'RED-PROOF setup: a neutral ledger at Pristine names the clean door');
  mutable.corrupt = 25;
  ok(gauge(0, 2, mutable).corruptionRoute.textContent === BARRED_LINE,
    'RED-PROOF: mutating the same ledger corrupt closes the door and shows the decided line');
  mutable.corrupt = 0;
  ok(gauge(0, 2, mutable).corruptionRoute.textContent === `Route: ${routesFor(0)[0].name}`,
    'RED-PROOF: reverting the ledger reopens the clean door name');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
