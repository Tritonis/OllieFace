// tests/damage-elements.test.mjs
//
// The damage vocabulary is open — every item that deals damage may invent a
// type string — and the read families are closed. This file pins the mapping
// between them, and pins hardest on the one property that keeps the change
// invisible where it should be: an untyped hit must render exactly as it did
// before elements existed.
import { ELEMENTS, ELEMENT_HUE, elementOf, sparkColour } from '../src/data/damageTypes.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the read families are closed and every one has a hue');
{
  ok(ELEMENTS.length === 7, 'seven families');
  ok(ELEMENTS[0] === 'kinetic', 'kinetic is the default and comes first');
  for (const e of ELEMENTS) {
    const h = ELEMENT_HUE[e];
    ok(h && Number.isInteger(h.core) && Number.isInteger(h.tail) && Number.isInteger(h.ring),
       `${e} carries core/tail/ring hexes`);
  }
}

console.log('an open vocabulary lands in a closed set');
{
  ok(elementOf('fire') === 'fire' && elementOf('meteor') === 'fire', 'the fire family');
  ok(elementOf('frost') === 'ice', 'the ice family');
  ok(elementOf('lightning') === 'shock' && elementOf('overload') === 'shock'
     && elementOf('resonance') === 'shock', 'the shock family');
  ok(elementOf('spore') === 'nature' && elementOf('swarm') === 'nature'
     && elementOf('thorns') === 'nature', 'the nature family');
  ok(elementOf('void') === 'void', 'the void family');
  ok(elementOf('blast') === 'blast' && elementOf('missile') === 'blast'
     && elementOf('behemoth') === 'blast', 'the blast family');
  ok(elementOf('melee') === 'kinetic' && elementOf('hitscan') === 'kinetic'
     && elementOf('projectile') === 'kinetic' && elementOf('hit') === 'kinetic',
     'the ordinary hit is kinetic');
}

console.log('anything unmapped is kinetic, and nothing throws');
{
  ok(elementOf('a-type-no-one-has-written-yet') === 'kinetic', 'an unknown type is kinetic');
  ok(elementOf(undefined) === 'kinetic' && elementOf(null) === 'kinetic', 'so is nothing at all');
  ok(elementOf(7) === 'kinetic' && elementOf({}) === 'kinetic', 'so is a non-string');
  ok(ELEMENTS.includes(elementOf('reflect')), 'every answer is in the closed set');
  ok(elementOf('constructor') === 'kinetic' && elementOf('hit', 'toString') === 'kinetic',
     'and a type named after an Object prototype key is still just kinetic');
}

console.log('a status names the element when the type does not');
{
  ok(elementOf('hit', 'burn') === 'fire', 'a burning ordinary hit reads as fire');
  ok(elementOf('hit', 'slow') === 'ice', 'a chilling one reads as ice');
  ok(elementOf('hit', 'shock') === 'shock', 'and a shocking one as shock');
  ok(elementOf('frost', 'burn') === 'ice', 'but an explicit type outranks the status it also applies');
  ok(elementOf(null, 'burn') === 'fire', 'the status alone is enough');
  ok(elementOf('hit', 'nonsense') === 'kinetic', 'an unknown status changes nothing');
}

console.log('the default spark is the spark that ships today');
{
  // src/systems/VFX.js:1169 — `p.crit ? 0xffd24a : 0xffe9b0`. Every untyped hit
  // in the game goes through this pair, and if either moves, sp-equivalence is
  // not what catches it — nothing is.
  ok(sparkColour('kinetic', false) === 0xffe9b0, 'plain kinetic is the shipped 0xffe9b0');
  ok(sparkColour('kinetic', true) === 0xffd24a, 'crit kinetic is the shipped 0xffd24a');
  ok(sparkColour('nope', false) === 0xffe9b0, 'an unknown element falls back to kinetic, not to black');
}

console.log('every other element is a different colour, and crits are hotter');
{
  const seen = new Set();
  for (const e of ELEMENTS) {
    const c = sparkColour(e, false);
    ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `${e} spark is a hex`);
    ok(!seen.has(c), `${e} spark is distinct from every element before it`);
    seen.add(c);
    ok(sparkColour(e, true) !== c, `${e} crit differs from its plain spark`);
  }
}

/* -------------------------------------------------------------------------
 * The end-to-end arm.
 *
 * Everything above tests `elementOf` in isolation, and `elementOf` in
 * isolation was already going to pass before any of the forwarding in Step 4b
 * existed. That is exactly the shape of a green test over a feature that does
 * not fire: the status fallback has no live caller until `explode`,
 * `damageGroup` and the DOT tick actually put `status` on the info object.
 * So this block drives the real `Combat` and reads the real `damage` event.
 *
 * The fixture is tests/shrike-detonate.test.mjs's `makeWorld()`: a real
 * `THREE.Scene`, a real `Combat`, `authority: true`, and an events object that
 * records. The registry method is `Combat.register` (Combat.js:92) — that is
 * what puts an entity in the spatial hash `explode`'s `sphereOverlap` reads.
 * ---------------------------------------------------------------------- */
const THREE = await import('three');
const { Combat } = await import('../src/systems/Combat.js');

function makeWorld() {
  const events = [];
  const ctx = {
    time: 0, authority: true,
    rng: { next: () => 0.5, range: (a, b) => (a + b) * 0.5 },
    scene: new THREE.Scene(),
    events: { emit(name, p) { events.push({ name, p }); }, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);
  const source = { isPlayer: true, alive: true, team: 'player', stats: { damage: 20 },
                   position: new THREE.Vector3(0, 0, 0) };
  return { ctx, combat, source, events };
}

const makeVictim = (x) => ({ alive: true, team: 'monster', health: 5000, maxHealth: 5000,
                             shield: 0, radius: 0.5, position: new THREE.Vector3(x, 0, 0) });

console.log('a burn tick reaches the damage event as fire, through real Combat');
{
  const { ctx, combat, source, events } = makeWorld();
  const victim = makeVictim(3);

  // STATUS_DEFS.burn is { duration: 4.0, tick: 0.5, ... } (Combat.js:26), and
  // a fresh stack starts with `timer` at `tick`, so exactly one 0.5 s step
  // fires exactly one tick.
  combat.applyStatus(victim, 'burn', source, 1);
  events.length = 0;
  combat._tickStatuses(ctx, 0.5);

  const dmg = events.filter((e) => e.name === 'damage').map((e) => e.p);
  ok(dmg.length === 1, `the burn ticked once (got ${dmg.length} damage events)`);
  ok(dmg[0]?.status === 'burn', 'and the event carries the status that dealt it');
  ok(elementOf(dmg[0]?.type, dmg[0]?.status) === 'fire',
     'so the spark that ticks off a burning monster is a fire spark, not a kinetic one');
  ok(sparkColour(elementOf(dmg[0]?.type, dmg[0]?.status), false) === ELEMENT_HUE.fire.tail,
     'and it draws the fire tail colour');
  ok(dmg[0]?.type === 'burn', 'and `type` still carries the status name items key off');
}

console.log('an explosion forwards the status it also applies');
{
  const { combat, source, events } = makeWorld();
  const victim = makeVictim(1);
  combat.register(victim);
  events.length = 0;
  combat.explode(new THREE.Vector3(0, 0, 0), 6, 50, source, { proc: 0, type: 'fire', status: 'burn' });
  const dmg = events.filter((e) => e.name === 'damage').map((e) => e.p);
  ok(dmg.length >= 1, 'the blast damaged the victim');
  ok(dmg[0]?.status === 'burn', 'and told presentation what it lit');
  ok(elementOf(dmg[0]?.type, dmg[0]?.status) === 'fire', 'which reads as fire either way here');
}

console.log('an untyped hit still reads exactly as it did before elements existed');
{
  const { combat, source } = makeWorld();
  const victim = makeVictim(1);
  const events = [];
  combat.ctx.events.emit = (name, p) => events.push({ name, p });
  combat.applyDamage(victim, 10, { source, position: victim.position });
  const d = events.find((e) => e.name === 'damage')?.p;
  ok(d?.type === 'hit', 'the event defaults to the same `hit` the proc dispatch uses');
  ok(d?.status === null, 'and carries no status');
  ok(sparkColour(elementOf(d?.type, d?.status), false) === 0xffe9b0, 'the shipped plain spark');
  ok(sparkColour(elementOf(d?.type, d?.status), true) === 0xffd24a, 'the shipped crit spark');
}

console.log('the default kill is the kill that ships today, all four values');
{
  const k = ELEMENT_HUE.kinetic;
  ok(k.killCore === 0xffffff && k.killTail === 0xff5a20, 'the shipped burst pair');
  ok(k.ring === 0xff7030, 'the shipped ring colour');
  ok(k.killFlick === 0xff8030, 'the shipped light-flick colour, which is NOT the ring colour');
  ok(k.killFlick !== k.ring, 'and the two are held apart on purpose');
  for (const e of ELEMENTS.filter((x) => x !== 'kinetic')) {
    ok(ELEMENT_HUE[e].killFlick === undefined, `${e} has no kill override and falls back to its own ring`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
