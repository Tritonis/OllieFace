// tests/voidtouched-director.test.mjs
// A real Director, driven headless. Short sims on purpose: the normal spawn
// path first fires at spawnT = 2.0 s, so everything below stays under that and
// the only spawns in play are the void path's own.
import * as THREE from 'three';
import { Director } from '../src/systems/Director.js';
import { Roster } from '../src/systems/Roster.js';
import { RNG } from '../src/core/MathUtil.js';
import { VOIDTOUCHED, voidCreditRate, voidBankCap, isVoidtouched } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeEvents() {
  const listeners = new Map();
  return {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
  };
}

function makePlayer(x, z) {
  return {
    isPlayer: true, alive: true, team: 'player', radius: 0.45, health: 110, maxHealth: 110,
    position: { x, y: 0, z }, velocity: { x: 0, y: 0, z: 0 },
    takeDamage() { return 0; },
  };
}

function makeWorld({ world = 0, seedRng = 777 } = {}) {
  const ctx = {
    rng: new RNG(seedRng), seed: 424242, time: 0, authority: true, netRole: 'single',
    scene: new THREE.Scene(), events: makeEvents(),
    stage: { sampleHeight: () => 0 },
    corruption: { world },
  };
  const roster = new Roster();
  roster.init(ctx);
  const player = makePlayer(100, 100);          // far from any seed at the origin
  ctx.player = player;
  roster.add(player);
  const d = new Director();
  d.init(ctx);
  return { ctx, d, player };
}

const H = 1 / 60;
const step = (ctx, d, seconds) => { for (let i = 0; i < Math.round(seconds / H); i++) { ctx.time += H; d.fixedUpdate(ctx, H); } };
const voids = (d) => d.enemies.filter((e) => e.affix === 'voidtouched');

console.log('a pristine world never touches the void path');
{
  const { ctx, d } = makeWorld({ world: 0 });
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  step(ctx, d, 1.9);
  ok(d.voidCredits === 0, 'no accrual at world 0');
  ok(voids(d).length === 0, 'no spawns');
}

console.log('no seeds, no spawns — corruption alone is not enough');
{
  const { ctx, d } = makeWorld({ world: 150 });
  step(ctx, d, 1.9);
  ok(d.voidCredits === 0, 'the bank only runs where greed left a mark');
  ok(voids(d).length === 0, 'no spawns');
}

console.log('world + seed = a Hollowed unit surfaces on the ring, telegraphed');
{
  const { ctx, d } = makeWorld({ world: 150 });
  const spawnEvents = [];
  ctx.events.on('voidtouchedSpawn', (p) => spawnEvents.push(p));
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = voidBankCap(150);          // skip the accrual wait; spend logic is under test
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  const v = voids(d);
  ok(v.length === 1, 'exactly one surfaced');
  ok(spawnEvents.length === 1 && spawnEvents[0].id === v[0].def.id, 'voidtouchedSpawn event fired with the card id');
  const r = Math.hypot(v[0].position.x, v[0].position.z);
  ok(r >= VOIDTOUCHED.spawnRing.min - 0.01 && r <= VOIDTOUCHED.spawnRing.max + 0.01, `on the ring (got ${r.toFixed(2)} m)`);
  ok(!v[0].def.isFlyer && v[0].def.eliteEligible, 'a ground card the affix is legal on');
  ok(d.voidCredits < voidBankCap(150), 'the spawn was paid for');
}

console.log('placement draws nothing from the shared stream');
{
  const a = makeWorld({ world: 150 });
  const b = makeWorld({ world: 150 });
  for (let i = 0; i < 5; i++) b.ctx.rng.next();  // displace B's shared stream
  for (const w of [a, b]) {
    w.ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
    w.d.voidCredits = voidBankCap(150);
    step(w.ctx, w.d, VOIDTOUCHED.telegraph + 0.4);
  }
  const va = voids(a.d)[0], vb = voids(b.d)[0];
  ok(!!va && !!vb, 'both worlds surfaced one');
  ok(va.position.x === vb.position.x && va.position.z === vb.position.z,
    'identical surfacing point despite a displaced ctx.rng — every roll came from the derived stream');
  ok(va.def.id === vb.def.id, 'and the same card');
}

console.log('it will not surface in your face');
{
  const { ctx, d, player } = makeWorld({ world: 150 });
  player.position.x = 0; player.position.z = 0;   // standing ON the seed
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = voidBankCap(150);
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  ok(voids(d).length === 0, 'every candidate inside minPlayerDist was refused');
}

console.log('stageStart wipes seeds, pending surfacings and the bank');
{
  const { ctx, d } = makeWorld({ world: 150 });
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = voidBankCap(150);
  step(ctx, d, 0.2);                              // telegraph queued, not yet surfaced
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  ok(voids(d).length === 0, 'the pending surfacing died with the stage');
  ok(d._voidSeeds.length === 0 && d.voidCredits === 0, 'seeds and bank cleared');
}

console.log('the bank is capped');
{
  const { ctx, d } = makeWorld({ world: 10000 });
  ctx.events.emit('blightSeed', { x: 500, z: 500, strength: 1 });  // far seed: accrual runs, spends fail (no walkable check needed — ring points are fine, but keep the player 100,100 far so spends succeed; cap still binds first at this rate)
  step(ctx, d, 1.5);
  ok(d.voidCredits <= voidBankCap(10000) + 1e-9, 'the scaling cap holds');
  ok(voidBankCap(10000) === VOIDTOUCHED.maxBank, 'and at this depth the cap is maxBank');
}

console.log('cleansing the world confiscates the savings the void made at depth');
{
  // The clamp is two-way by design (Director.fixedUpdate): a bank filled at
  // world 300 is cut to the shallow cap the moment a refund or an Argent Font
  // cleanse drops the world. Without this, a hoarded 240 would keep paying for
  // waves the cleansed world no longer earns — the counterplay would not land.
  const { ctx, d } = makeWorld({ world: 300 });
  ctx.events.emit('blightSeed', { x: 500, z: 500, strength: 1 });
  d.voidCredits = voidBankCap(300);
  d.voidSpawnT = VOIDTOUCHED.interval;      // no spend inside the window: the clamp is what is under test
  ok(d.voidCredits === 240 && voidBankCap(300) === 240, 'primed full at the deep cap');
  ctx.corruption.world = 50;                 // the cleanse lands
  step(ctx, d, 0.1);
  ok(voidBankCap(50) === 115, 'the shallow cap is 115');
  ok(Math.abs(d.voidCredits - voidBankCap(50)) < 1e-9,
    `the bank was cut to the new world's cap on the next tick (got ${d.voidCredits})`);
}

console.log('the void pressures harder and banks deeper as the world rots');
{
  ok(VOIDTOUCHED.ratePerWorld === 0.02, 'rate re-priced');
  ok(Math.abs(voidCreditRate(400) - 8.0) < 1e-9, 'world 400 pays 8 credits/s');
  ok(voidBankCap(0) === 90, 'pristine bank cap unchanged — the old flat 90');
  ok(voidBankCap(100) === 140, 'the bank deepens with the world');
  ok(voidBankCap(300) === 240, 'deep-red bank caps at 240 (90 + 150, capped)');
  ok(voidBankCap(-5) === 90 && voidBankCap(NaN) === 90, 'junk reads as pristine');
}

console.log('a Voidtouched kill is cleansing, not farming');
{
  ok(VOIDTOUCHED.rewardMult === 0.25 && VOIDTOUCHED.refund === 0.08, 'reward down, refund up');
  // The affix id lives on the enemy itself (Enemy.spawn), not on the
  // ELITE_STATS record `victim.elite` points at.
  ok(isVoidtouched({ affix: 'voidtouched' }), 'recognises the live victim shape');
  ok(!isVoidtouched({ affix: 'warded' }) && !isVoidtouched({}) && !isVoidtouched(null),
    'everything else is not');
  ok(!isVoidtouched({ elite: { cost: 5.5 } }), 'a stats record alone is not an affix id');
}

console.log('the void pays its executioners a quarter');
{
  // A real Enemy off a real card, so the multiplier is measured through the
  // whole killReward product rather than against a hand-built stub.
  const { Enemy } = await import('../src/entities/Enemy.js');
  const { Items } = await import('../src/systems/Items.js');
  const { ENEMIES } = await import('../src/data/enemies.js');
  const scarab = ENEMIES.find((e) => e.id === 'scarab');
  const { ctx } = makeWorld({ world: 150 });
  ctx.director = { difficultyCoefficient: 1 };
  const items = new Items();
  items.init(ctx);

  const plain = new Enemy();
  plain.spawn(ctx, scarab, { x: 0, y: 0, z: 0 }, { affix: 'warded' });
  const hollow = new Enemy();
  hollow.spawn(ctx, scarab, { x: 0, y: 0, z: 0 }, { affix: 'voidtouched' });
  // Equal `elite.cost` is what makes the comparison the multiplier alone.
  hollow.elite = plain.elite;

  const a = items.killReward(plain), b = items.killReward(hollow);
  ok(a > 0 && b > 0, `both pay something (${a} vs ${b})`);
  ok(Math.abs(b - a * VOIDTOUCHED.rewardMult) <= 1,
    `the Hollowed pays rewardMult of the same elite, within the rounding (${a} -> ${b})`);
}

console.log('and a quarter of the XP — gold and XP are separate funnels');
{
  // Scope note: stubbing `addExperience` on an un-`init`ed Progression measures
  // `_awardKillXp`'s ARITHMETIC only. It deliberately does NOT cover the
  // authority gate — neither `ctx.authority` at Progression's kill listener nor
  // the one inside the real `addExperience` (`Progression.js:426`) runs here.
  // No suite covers that gate today; it is the same `ctx.authority` guard every
  // other host-only entry point uses, and it is out of scope for a multiplier
  // arm — but say so rather than let a green line imply coverage it has not got.
  const { Progression } = await import('../src/systems/Progression.js');
  const p = new Progression();
  let granted = 0;
  p.addExperience = (amount) => { granted = amount; };
  const victim = (affix) => ({ def: { xp: 12 }, level: 1, affix });

  p._awardKillXp({ victim: victim('warded'), isElite: true });
  const plain = granted;
  p._awardKillXp({ victim: victim('voidtouched'), isElite: true });
  ok(plain > 0 && Math.abs(granted - plain * VOIDTOUCHED.rewardMult) < 1e-9,
    `a Hollowed kill is worth rewardMult of an ordinary elite's XP (${plain} -> ${granted})`);
}

console.log('the world itself turns hostile as it rots');
{
  const { PRESSURE } = await import('../src/data/corruption.js');
  ok(PRESSURE.perWorld === 0.004, 'pressure constant pinned');

  // Two identical Directors, same clock, same stage count: the only difference
  // is the second ledger. A non-zero stagesCompleted is deliberate — the term
  // must ride *inside* the stage product, not be bolted on after it.
  const mk = (world) => {
    const { ctx, d } = makeWorld({ world });
    ctx.time = 300;
    d.stagesCompleted = 2;
    d.updateDifficulty(ctx);
    return d;
  };
  const stageFactor = Math.pow(1.15, 2);
  const a = mk(0), b = mk(400);
  const expected = 400 * PRESSURE.perWorld * stageFactor;
  ok(Math.abs((b.difficultyCoefficient - a.difficultyCoefficient) - expected) < 1e-9,
    `a Consumed world adds exactly perWorld*stage (${(b.difficultyCoefficient - a.difficultyCoefficient).toFixed(6)} vs ${expected.toFixed(6)})`);
  ok(b.level > a.level, 'and it reads out as real Director levels, not just a number');

  // Regression pin for sp-equivalence: at world 0 the coefficient must equal
  // the pre-change formula (pf + timeFactor) * stageFactor to the bit.
  const pf = a.playerFactor;
  const scale = 2.0 * 1;   // DIFFICULTY_SCALE, no difficulty provider in the fixture
  const timeFactor = (300 / 60) * 0.0506 * Math.pow(a.playerCount, 0.2) * scale;
  ok(a.difficultyCoefficient === (pf + timeFactor) * stageFactor,
    'a pristine world is byte-identical to the formula before this term existed');

  // The other half of the same ledger: pressure buys threat, never gold. Gold is
  // quadratic in the coefficient the payout reads (the director banks credits at
  // 0.95 x coef and a corpse refunds cost x coef) while HP and damage are only
  // linear in `level`, so a corrupted world that fed both ends paid 2.34x for
  // 1.55x the HP. `rewardCoefficient` is the same curve minus the corruption
  // term, and it is what `Items.killReward` pays against.
  ok(b.difficultyCoefficient > a.difficultyCoefficient, 'world 400 moved the difficulty coefficient');
  ok(b.rewardCoefficient === a.rewardCoefficient,
    `and left the reward coefficient exactly where it was (${a.rewardCoefficient} vs ${b.rewardCoefficient})`);
  ok(a.rewardCoefficient === a.difficultyCoefficient,
    'at world 0 the two are the same float, so a pristine run is unchanged');

  // Through the real `killReward`, not the formula: same victim, same clock,
  // same stage — a rotted world must not raise the payout by one gold.
  const { Items } = await import('../src/systems/Items.js');
  const payout = (d) => {
    const items = new Items();
    items.init({ authority: true, events: { on() {}, emit() {} }, director: d });
    return items.killReward({ def: { cost: 40 }, elite: null });
  };
  const goldClean = payout(a), goldRotten = payout(b);
  ok(goldClean > 0 && goldClean === goldRotten,
    `the same kill pays the same at world 0 and world 400 (${goldClean} vs ${goldRotten})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
