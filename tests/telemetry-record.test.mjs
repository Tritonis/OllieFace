/**
 * The run record (issue #29): opt-in, local, complete, and unable to end a run.
 *
 *   node tests/telemetry-record.test.mjs
 *
 * Four things are guarded here, and they are not equally interesting.
 *
 * The first is the one the feature would be withdrawn over: a capture hook that
 * throws must not halt the engine. As of `c83caef` a throw out of a critical
 * system stops the run, and telemetry hangs off events that critical systems
 * emit from inside their own `fixedUpdate` — so the containment is exercised in
 * exactly that position, on a real `Engine` with a real `EventBus`, rather than
 * against a hand-rolled bus that would prove nothing about the one in the game.
 *
 * The second is that "no network" is a property of the source, not a promise in
 * a comment, so the module is scanned for the egress vocabulary.
 *
 * The third is that off means *absent*: with the flag unset, not one listener
 * of this module's is registered, which is what makes "costs nothing when off"
 * checkable rather than plausible.
 *
 * The fourth walks a whole run through the bus and reads the record back out of
 * storage, field by field against issue #29's list. Three other issues (#36,
 * #37, #38) state their acceptance criteria in terms of these numbers, so a
 * field quietly going missing is the failure that matters most after the halt.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Engine } from '../src/core/Engine.js';
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { ArgentFont } from '../src/world/Interactables.js';
import { BLIGHT_BY_BASE } from '../src/data/items.js';
import { BANDS, MUTATION } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';
import {
  installTelemetry, telemetryEnabled, setTelemetryEnabled,
  readRuns, exportText, promotePartial,
  ENABLED_KEY, PARTIAL_KEY, RUNS_KEY,
} from '../src/systems/Telemetry.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A localStorage stand-in. Node has no web storage, and the module takes one. */
function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    get size() { return m.size; },
  };
}

/** An engine with the loop flag set but no rAF — frames are driven by hand. */
function fresh() {
  const engine = new Engine({ canvas: null, seed: 7 });
  engine.running = true;
  return engine;
}

/** How many listeners the bus is carrying, across every event name. */
function listenerCount(bus) {
  let n = 0;
  for (const set of bus.map.values()) n += set.size;
  return n;
}

console.log('the module reaches for no network primitive');
{
  const src = readFileSync(join(SRC, 'systems/Telemetry.js'), 'utf8');
  // Comment prose in this file names some of these deliberately ("there is no
  // `fetch`"), so the scan runs against code with block and line comments
  // stripped. A word that only ever appears in a sentence is not a call.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['fetch', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'RTCPeerConnection', 'navigator.', 'http://', 'https://']) {
    ok(!code.includes(bad), `no \`${bad}\` in Telemetry.js`);
  }
}

console.log('the recorder is not an engine system');
{
  // The containment below rests on this: `Engine._call` is the only path from a
  // throw to `Engine._halt`, and it only ever reaches registered systems.
  const main = readFileSync(join(SRC, 'main.js'), 'utf8');
  ok(/installTelemetry\(ctx\)/.test(main), 'main.js installs the recorder');
  ok(!/engine\.add\([^)]*Telemetry/.test(main), 'main.js never registers it as a system');
  const mod = readFileSync(join(SRC, 'systems/Telemetry.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bfixedUpdate\b|\blateUpdate\b/.test(mod) && !/^\s*update\s*\(/m.test(mod),
    'the recorder declares no engine frame phase');
}

console.log('off by default, and off means no listeners at all');
{
  const storage = fakeStorage();
  const engine = fresh();
  const before = listenerCount(engine.ctx.events);
  ok(telemetryEnabled(storage) === false, 'the flag is off on a fresh install');
  const t = installTelemetry(engine.ctx, { storage });
  ok(t.active === false, 'install returns inactive');
  ok(listenerCount(engine.ctx.events) === before, 'not one listener was registered');
  engine.ctx.events.emit('runEnd', { won: true, stats: {} });
  ok(storage.size === 0, 'a whole run end wrote nothing');
}

console.log('a throw inside a capture hook cannot halt the run');
{
  const storage = fakeStorage();
  setTelemetryEnabled(true, storage);
  const engine = fresh();

  /**
   * A critical system that emits from inside its own fixedUpdate — the exact
   * position `Corruption`, `Items` and `Progression` emit from. If a listener's
   * throw escaped the dispatch, it would surface as a throw out of *this*
   * system's phase and `Engine._halt` would end the run.
   */
  class Emitter {
    static critical = true;
    init(ctx) { this.ctx = ctx; }
    fixedUpdate(ctx) { ctx.events.emit('stageStart', { index: 0, name: 'Ashen Shelf' }); this.ticks = (this.ticks || 0) + 1; }
  }
  class Witness {
    static critical = true;
    constructor() { this.fixed = 0; }
    fixedUpdate() { this.fixed++; }
  }

  const emitter = engine.add(new Emitter());
  const witness = engine.add(new Witness());
  const rec = installTelemetry(engine.ctx, { storage });
  ok(rec.active === true, 'the recorder is live');

  // Break a capture hook the way a real defect would. `t()` is reached through
  // `this` from inside `onStageStart`, so this is a genuine throw from within a
  // live hook rather than a listener swapped out from underneath the bus — the
  // subscription captured the method at install and replacing the property
  // would never have been dispatched to.
  rec.t = () => { throw new Error('boom in capture'); };

  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    engine.accumulator = 0.02;
    engine._frame();
    engine.accumulator = 0.02;
    engine._frame();
  } finally { console.error = realError; }

  ok(engine.fatal === null, 'the engine did not halt');
  ok(engine.ctx.fatalError === null, 'no fatal error was published');
  ok(engine.running === true, 'the loop is still running');
  ok(engine.ctx.frameErrors === 0, 'no frame error was attributed to any system');
  ok(engine.ctx.authority === true, 'authority survived');
  ok(emitter.ticks === 2 && witness.fixed === 2, 'both frames ran every system');
  ok(rec.broken === true, 'the recorder disarmed itself');
  ok(errors.length === 1, `the failure was reported exactly once (got ${errors.length})`);

  // And a disarmed recorder stays out of the way rather than writing a
  // half-record over a good one.
  engine.ctx.events.emit('runEnd', { won: true, stats: { kills: 1 } });
  ok(readRuns(storage).length === 0, 'a broken recorder files nothing');
}

console.log('a whole run produces a readable record');
{
  const storage = fakeStorage();
  setTelemetryEnabled(true, storage);
  const engine = fresh();
  const ctx = engine.ctx;
  const bus = ctx.events;

  const player = { isPlayer: true, alive: true };
  ctx.player = player;
  ctx.survivorId = 'kestrel';
  ctx.difficultyId = 'cataclysm';
  ctx.artifactIds = ['sacrifice', 'command'];
  const cor = { world: 0, band: 0 };
  ctx.corruption = cor;

  const rec = installTelemetry(ctx, { storage });
  ok(rec.active === true, 'the recorder is live');

  const at = (t) => { ctx.time = t; };
  const setCor = (world, band) => {
    const prev = cor.band;
    cor.world = world; cor.band = band;
    bus.emit('corruptionChanged', { world, band });
    if (band !== prev) bus.emit('corruptionBand', { band, prev });
  };

  at(0);
  bus.emit('stageStart', { index: 0, name: 'Ashen Shelf' });
  bus.emit('realmOffer', { id: 'market', kind: 'gateway', stage: 0, cost: 120 });
  bus.emit('realmOffer', { id: 'crucible', kind: 'gateway', stage: 0, cost: 0 });
  at(30);
  setCor(24, 1);                                        // crossed into Seeded
  bus.emit('itemPickup', { id: 'syringe', delta: 2, tier: 'common' });
  bus.emit('itemPickup', { id: 'syringe', delta: 3, reason: 'corrupt' });   // a restack, not a haul
  bus.emit('itemMutated', { baseId: 'syringe', blightId: 'blight-syringe', count: 2, band: 1, eligible: ['lens', 'syringe'] });
  bus.emit('kill', { victim: { isPlayer: false }, source: player, isElite: true });
  bus.emit('levelUp', { level: 2, xp: 0, xpToNext: 12 });

  at(60);
  bus.emit('realmEnter', { id: 'market' });
  bus.emit('itemPickup', { id: 'lens', delta: 1, tier: 'uncommon' });
  at(95);
  bus.emit('realmExit', {});

  at(120);
  setCor(10, 0);                                        // an Argent Font walked it back
  bus.emit('fontUse', {
    stage: 0, press: 0, cost: 140, removed: 14,
    worldBefore: 24, worldAfter: 10, bandBefore: 1, bandAfter: 0,
  });
  bus.emit('itemStabilised', { blightId: 'blight-syringe', baseId: 'syringe', count: 2 });

  at(150);
  bus.emit('stageStart', { index: 1, name: 'Sunken Reach' });
  bus.emit('realmOffer', { id: 'fracture', kind: 'finale', stage: 1, cost: 0 });
  bus.emit('realmOffer', { id: 'fracture-void', kind: 'finale', stage: 1, cost: 0 });
  at(200);
  bus.emit('realmEnter', { id: 'fracture-void' });
  at(240);
  bus.emit('kill', {
    victim: player, source: { def: { id: 'hollow-warden' }, isBoss: true },
    type: 'void', status: 'blighted', overkill: 41,
  });
  bus.emit('playerDead', { victim: player });
  bus.emit('runEnd', {
    won: false,
    stats: { time: 240, kills: 1, elites: 1, stage: 2, ending: null, corruption: 10, corruptionPeakBand: 1, inventory: [] },
  });

  const runs = readRuns(storage);
  ok(runs.length === 1, `exactly one run was filed (got ${runs.length})`);
  const r = runs[0] || {};

  // --- issue #29's list, field by field.
  ok(r.seed === 7, 'seed');
  ok(r.survivor === 'kestrel', 'survivor');
  ok(r.difficulty === 'cataclysm', 'difficulty');
  ok(JSON.stringify(r.artifacts) === JSON.stringify(['command', 'sacrifice']), 'artifacts selected');
  ok(r.complete === true, 'the record is marked complete');

  ok(r.stages?.length === 2, `stage count (got ${r.stages?.length})`);
  ok(r.stages?.[0]?.enteredAt === 0 && r.stages[0].leftAt === 150, 'stage 0 times');
  ok(r.stages?.[0]?.name === 'Ashen Shelf', 'stage name');
  // Two on the stage plus the one taken inside the Market, which happened
  // during stage 0 and belongs to it. The three-stack `reason: 'corrupt'`
  // restack is not an acquisition and is excluded — with it this would be 6.
  ok(r.stages?.[0]?.items === 3, `stage haul excludes the corrupt restack (got ${r.stages?.[0]?.items})`);
  ok(r.stages?.[0]?.kills === 1, 'stage kills');
  ok(r.stages?.[1]?.leftAt === 240, 'the final stage is closed at run end');

  ok(r.stages?.[0]?.corruptionIn === 0 && r.stages[0].corruptionOut === 10, 'corruption at the stage boundary');
  ok(r.stages?.[0]?.bandIn === 0 && r.stages[0].bandOut === 0, 'band at the stage boundary');
  ok(r.corruption?.crossings?.length === 2, `both crossings recorded (got ${r.corruption?.crossings?.length})`);
  ok(r.corruption?.crossings?.[0]?.dir === 'up' && r.corruption.crossings[1].dir === 'down', 'crossing direction');
  ok(r.corruption?.peakWorld === 24 && r.corruption?.peakBand === 1, 'corruption high-water mark');
  ok(r.corruption?.fed === 24 && r.corruption?.bled === 14, 'corruption taken on versus bought back');

  ok(r.mutations?.length === 1, 'mutation recorded');
  ok(r.mutations?.[0]?.blightId === 'blight-syringe' && r.mutations[0].count === 2, 'what converted');
  ok(JSON.stringify(r.mutations?.[0]?.eligible) === JSON.stringify(['lens', 'syringe']), 'what was eligible');
  ok(r.stabilisations?.length === 1, 'the stack the font handed back');

  ok(r.fonts?.length === 1, 'font use recorded');
  ok(r.fonts?.[0]?.cost === 140 && r.fonts[0].removed === 14, 'cost paid and corruption removed');
  ok(r.fonts?.[0]?.bandBefore === 1 && r.fonts[0].bandAfter === 0, 'band before and after');

  ok(r.realmOffers?.length === 4, `every offer counted (got ${r.realmOffers?.length})`);
  ok(r.realmVisits?.length === 2, `both visits recorded (got ${r.realmVisits?.length})`);
  const market = r.realmVisits?.find((v) => v.id === 'market');
  ok(market?.duration === 35, `realm duration (got ${market?.duration})`);
  ok(market?.items === 1, 'items gained inside the realm');
  ok(market?.exitedAt === 95, 'realm exit time');
  const fracture = r.realmVisits?.find((v) => v.id === 'fracture-void');
  ok(fracture?.exitedAt === null, 'the realm the run ended inside is filed unfinished');

  ok(JSON.stringify(r.route?.offered) === JSON.stringify(['fracture', 'fracture-void']), 'both finale routes were offered');
  ok(r.route?.taken === 'fracture-void', 'the route taken');

  ok(r.outcome?.won === false, 'outcome');
  ok(r.outcome?.cause?.source === 'hollow-warden', 'death cause names the source');
  ok(r.outcome?.cause?.type === 'void' && r.outcome.cause.status === 'blighted', 'death cause carries the damage provenance');
  ok(r.outcome?.cause?.realm === 'fracture-void', 'death cause knows where it happened');
  ok(r.stats?.kills === 1 && r.stats?.time === 240, 'the summary snapshot rides along');
  ok(r.levels?.length === 1 && r.levels[0].level === 2, 'levelling');

  // Readable, and readable *as a file*.
  const text = exportText(storage);
  ok(text.includes('"runs"') && JSON.parse(text).runs.length === 1, 'the export parses and carries the run');
}

console.log('a run that crashes keeps everything up to the last stage boundary');
{
  const storage = fakeStorage();
  setTelemetryEnabled(true, storage);
  const engine = fresh();
  const ctx = engine.ctx;
  ctx.corruption = { world: 0, band: 0 };

  const rec = installTelemetry(ctx, { storage });
  ctx.time = 0;
  ctx.events.emit('stageStart', { index: 0, name: 'Ashen Shelf' });
  ctx.time = 40;
  ctx.events.emit('stageStart', { index: 1, name: 'Sunken Reach' });
  ok(storage.getItem(PARTIAL_KEY) !== null, 'the stage boundary checkpointed the run in flight');
  ok(readRuns(storage).length === 0, 'nothing is filed as a finished run yet');

  // The tab dies here. Next boot finds the partial and files it.
  const promoted = promotePartial(storage);
  ok(promoted?.stages?.length === 1, 'the promoted record carries the stage that completed');
  ok(promoted?.complete === false, 'and is labelled incomplete');
  ok(readRuns(storage).length === 1, 'it is now in the buffer');
  ok(storage.getItem(PARTIAL_KEY) === null, 'and the partial is gone, so it cannot be filed twice');
  ok(rec.active === true, 'the recorder that wrote it was live');
}

console.log('a halted engine still files what it had');
{
  const storage = fakeStorage();
  setTelemetryEnabled(true, storage);
  const engine = fresh();
  const ctx = engine.ctx;
  ctx.corruption = { world: 0, band: 0 };
  installTelemetry(ctx, { storage });
  ctx.events.emit('stageStart', { index: 0, name: 'Ashen Shelf' });

  class Doomed {
    static critical = true;
    fixedUpdate() { throw new Error('the run is over'); }
  }
  engine.add(new Doomed());
  const realError = console.error;
  console.error = () => {};
  try { engine.accumulator = 0.02; engine._frame(); } finally { console.error = realError; }

  ok(engine.fatal !== null, 'the engine halted, as a critical throw must');
  const runs = readRuns(storage);
  ok(runs.length === 1, `the run was filed anyway (got ${runs.length})`);
  ok(runs[0]?.complete === false, 'marked incomplete');
  ok(runs[0]?.fatal?.who?.startsWith('Doomed'), 'and it names what killed the engine');
}

/**
 * Everything above drives the bus by hand, which proves the recorder reads
 * these events correctly and proves nothing whatever about whether the game
 * emits them. The two blocks below close that gap on the two events this change
 * introduced into gameplay code, against the real systems and the real data.
 */
console.log('the real mutation toll carries what it could have taken');
{
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority: true, seed: 424242, rng: new RNG(777), time: 0,
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);

  const bases = [...BLIGHT_BY_BASE.keys()].sort();
  items.give(bases[0], 3);
  items.give(bases[1], 2);
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - corruption.world);
  items.fixedUpdate(ctx, 1 / 60);

  const mut = emitted.find((e) => e.name === 'itemMutated');
  ok(!!mut, 'the toll fired');
  const eligible = mut?.payload?.eligible;
  ok(Array.isArray(eligible), 'the payload carries an eligible list');
  ok(JSON.stringify(eligible) === JSON.stringify([bases[0], bases[1]].sort()),
    'naming both stacks the toll could have taken, not only the one it did');
  ok(eligible?.includes(mut.payload.baseId), 'the stack it converted is one of them');
}

console.log('the real Argent Font reports the transaction it just made');
{
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority: true, seed: 99, rng: new RNG(3), time: 0,
    player: { isPlayer: true, alive: true },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  corruption.feed(ctx.player, 90);
  items.addGold(9999);

  const font = new ArgentFont(ctx, new THREE.Vector3(0, 0, 0), 2);
  const cost = font.cost;
  const worldBefore = corruption.world;
  const bandBefore = corruption.band;
  ok(font.interact(ctx.player) === true, 'the press resolved');

  const use = emitted.find((e) => e.name === 'fontUse')?.payload;
  ok(!!use, 'a fontUse was emitted');
  ok(use?.cost === cost, `the cost reported is the cost charged (${use?.cost} vs ${cost})`);
  ok(use?.removed > 0 && use.removed === worldBefore - corruption.world, 'the corruption removed is real');
  ok(use?.worldBefore === worldBefore && use?.worldAfter === corruption.world, 'world before and after');
  ok(use?.bandBefore === bandBefore && use?.bandAfter === corruption.band, 'band before and after');
  ok(use?.press === 0 && use?.stage === 2, 'the press index and stage it happened on');

  // A refused press must say nothing: a record of a transaction that did not
  // happen is worse than no record.
  const before = emitted.filter((e) => e.name === 'fontUse').length;
  while (font.available()) font.interact(ctx.player);
  const spent = emitted.filter((e) => e.name === 'fontUse').length;
  ok(font.interact(ctx.player) === false, 'a spent font refuses');
  ok(emitted.filter((e) => e.name === 'fontUse').length === spent && spent > before,
    'and emits nothing for the refusal');
}

console.log('the flag round-trips and nothing else is stored under it');
{
  const storage = fakeStorage();
  ok(telemetryEnabled(storage) === false, 'off');
  setTelemetryEnabled(true, storage);
  ok(storage.getItem(ENABLED_KEY) === '1' && telemetryEnabled(storage), 'on');
  setTelemetryEnabled(false, storage);
  ok(telemetryEnabled(storage) === false, 'off again');
  ok([ENABLED_KEY, RUNS_KEY, PARTIAL_KEY].every((k) => k.startsWith('telluric.')),
    'every key is under the prefix the desktop save mirror carries');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
