/**
 * Purity has to stay spendable (issue #172).
 *
 * The altar was placed on one condition — the band — and the purity purse it
 * also sells against is minted by doing the opposite of descending. So a party
 * that entered a stage Pristine with motes banked found no altar at all: the
 * one currency you earn by playing clean had, on exactly those stages, nowhere
 * to be spent.
 *
 * Three things are pinned here, and each is written so it can fail rather than
 * merely be true: that a banked purse *places* the altar, that a purse which
 * becomes spendable mid-stage surfaces one and only one, and that neither costs
 * the shared gameplay stream a single draw — the property `gate:sp` exists to
 * defend, asserted here against a counted `ctx.rng`.
 */
import * as THREE from 'three';
import { Interactables, VoidBargain } from '../src/world/Interactables.js';
import { RNG } from '../src/core/MathUtil.js';
import { BOON, MOTE, RELIQUARY } from '../src/data/bandBoons.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// The populate-level harness from corruption-counterplay.test.mjs: real
// landmarks and a rejecting `isWalkable`, so each siting costs a *variable*
// number of draws and a leaked draw cannot hide behind a flat count.
const STAGE = () => ({
  bound: 44,
  landmarks: [{ x: -14, z: 6, r: 5 }, { x: 12, z: -9, r: 7 }, { x: 2, z: 18, r: 4 }],
  isWalkable: (x, z) => x * x + z * z > 36 && Math.sin(x * 0.31) + Math.cos(z * 0.27) > -1.2,
  sampleHeight: (x, z) => Math.sin(x * 0.11) * 0.7 + Math.cos(z * 0.09) * 0.5,
});

/** A mutable gauge stub: band and purse are dialled, nothing is fed. */
const gauge = (band = 0, motes = 0) => ({ band, motes, world: band * 40, peak: band * 40, marks: 0 });

function populated(stageIndex, corruption, seed = 1234, authority = true) {
  const raw = new RNG(seed);
  let draws = 0;
  const rng = {
    next: () => (draws++, raw.next()),
    range: (a, b) => (draws++, raw.range(a, b)),
    int: (a, b) => (draws++, raw.int(a, b)),
    pick: (a) => (draws++, raw.pick(a)),
    weighted: (a, w) => (draws++, raw.weighted(a, w)),
  };
  const ctx = {
    seed, rng, authority, stage: STAGE(),
    scene: new THREE.Group(),
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    events: { emit() {}, on() {} },
    items: { gold: 0, spendGold: () => false },
    time: 0,
  };
  ctx.items.rollItem = () => { ctx.rng.next(); return 'adrenal-syringe'; };
  if (corruption) ctx.corruption = corruption;
  const inter = new Interactables();
  inter.init(ctx);
  inter.populate(stageIndex);
  return { ctx, inter, draws: () => draws };
}

const altars = (p) => p.inter.list.filter((i) => i instanceof VoidBargain);
// Null-safe on purpose: an absent altar is the failure these arms are written
// to catch, and it has to read as a FAIL line rather than a stack trace.
const where = (a) => (a ? `${a.position.x.toFixed(6)},${a.position.z.toFixed(6)}` : 'nowhere');
const tick = (p, n = 3) => { for (let i = 0; i < n; i++) p.inter.update(p.ctx, 1 / 60); };

console.log('a pristine run with a banked purse finds an altar');
{
  // The discriminating pair: same band, same seed, same stage — only the purse
  // differs. If the altar were still gated on the band alone both arms read 0.
  let placed = 0, empty = 0;
  for (let s = 0; s <= 4; s++) {
    if (altars(populated(s, gauge(0, RELIQUARY.motes))).length === 1) placed++;
    if (altars(populated(s, gauge(0, 0))).length === 0) empty++;
  }
  ok(placed === 5, `every stage entered Pristine with motes carries the altar (${placed}/5)`);
  ok(empty === 5, `and an empty purse at Pristine still carries none (${empty}/5)`);
  ok(altars(populated(2, gauge(0, MOTE.motes))).length === 1,
    `one mote — the price of Sanctuary — is enough to place it`);
}

console.log('a purse that becomes spendable mid-stage surfaces one altar, once');
{
  const p = populated(2, gauge(0, 0));
  ok(altars(p).length === 0, 'the stage begins with no altar');
  tick(p);
  ok(altars(p).length === 0, 'and ticking a stage with nothing to sell places none');

  p.ctx.corruption.motes = MOTE.motes;
  tick(p);
  ok(altars(p).length === 1, `warding into the first mote surfaces the altar (${altars(p).length})`);
  const spot = where(altars(p)[0]);

  // Every later crossing asks again, and must be refused: the band crossing is
  // a *different* condition from the purse crossing, which is precisely the
  // pair that would double-place if the dedup were the caller's discretion.
  tick(p, 30);
  p.ctx.corruption.band = BOON.reroll.band;
  tick(p, 30);
  p.ctx.corruption.band = BOON.pact.band;
  p.ctx.corruption.motes = 9;
  tick(p, 30);
  ok(altars(p).length === 1, `sixty more frames and three more crossings place no second altar (${altars(p).length})`);
  ok(where(altars(p)[0]) === spot, 'and the one standing has not moved');
}

console.log('a guest never conjures its own');
{
  const p = populated(2, gauge(0, 0), 1234, false);
  p.ctx.corruption.motes = 4;
  tick(p, 20);
  ok(altars(p).length === 0, `off authority the purse surfaces nothing (${altars(p).length})`);
  // The same run on the host does surface one, so the arm above is a guard and
  // not a harness that simply never fires.
  const h = populated(2, gauge(0, 0), 1234, true);
  h.ctx.corruption.motes = 4;
  tick(h, 20);
  ok(altars(h).length === 1, 'and the host, identically driven, surfaces exactly one');
}

console.log('placement is the seed\'s answer, whenever it is asked');
{
  const a = populated(3, gauge(0, 3), 99991);
  const b = populated(3, gauge(0, 3), 99991);
  ok(where(altars(a)[0]) === where(altars(b)[0]), 'two runs on one seed place it identically');

  // The stronger claim: an altar surfaced forty seconds in stands where the
  // altar placed at population would have stood. Same seed, same stage, one
  // arrives late.
  const late = populated(3, gauge(0, 0), 99991);
  late.ctx.corruption.motes = 3;
  tick(late);
  ok(altars(late).length === 1, 'the late purse surfaces an altar');
  ok(where(altars(late)[0]) === where(altars(a)[0]),
    `and it stands where population would have put it (${where(altars(late)[0])})`);

  // Different seeds must disagree, or "identical" above is vacuous.
  const other = populated(3, gauge(0, 3), 1234);
  ok(where(altars(other)[0]) !== where(altars(a)[0]), 'a different seed puts it somewhere else');
}

console.log('and the shared stream never hears about any of it');
{
  // The property gate:sp defends: the altar is sited off a salted private
  // stream, so a stage populated with a purse takes exactly the ctx.rng draws
  // it took without one — and the teleporter, sited from ctx.rng *after* the
  // shrines, does not move.
  const tp = (p) => `${p.inter.teleporter.position.x.toFixed(6)},${p.inter.teleporter.position.z.toFixed(6)}`;
  let drift = 0, cases = 0;
  for (const seed of [1234, 1337, 7, 99991]) {
    for (let s = 0; s <= 4; s++) {
      const clean = populated(s, gauge(0, 0), seed);
      const pure = populated(s, gauge(0, 5), seed);
      cases++;
      if (clean.draws() !== pure.draws() || tp(clean) !== tp(pure)) drift++;
      // And the mid-stage surfacing is the same claim in the other direction.
      const late = populated(s, gauge(0, 0), seed);
      const before = late.draws();
      late.ctx.corruption.motes = 5;
      tick(late, 10);
      if (late.draws() !== before) drift++;
    }
  }
  ok(cases === 20 && drift === 0, `a purse costs the gameplay stream nothing (${cases} cases)`);
}

console.log('the maw does not read as a rock to a party that can spend');
{
  // A band deep enough to price a bargain in marks, a purse that cannot meet
  // it, and motes that can: the altar *is* offering Sanctuary, and at range it
  // used to burn the ember that means "saving up, nothing here yet".
  const ctx = {
    seed: 4242, authority: true,
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    events: { emit() {}, on() {} },
    interactables: { list: [] },
    corruption: { band: BOON.pact.band, marks: 0, motes: 0, world: 30, peak: 30, ruined: false },
  };
  const altar = new VoidBargain(ctx, new THREE.Vector3(), 1);
  ok(altar.signal().state === 'short', `a short purse with no motes still reads short (${altar.signal().state})`);
  ctx.corruption.motes = MOTE.motes;
  const off = altar.offer();
  ok(off && off.kind === 'sanctuary', `and the altar is in fact offering something (${off && off.kind})`);
  ok(altar.signal().state === 'afford', `so it reads as afforded (${altar.signal().state})`);
  for (let i = 0; i < 200; i++) altar.update(0.1);
  ok(altar.maw.material.emissive.getHex() === 0x7a2fae, 'and burns violet rather than the ember');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
