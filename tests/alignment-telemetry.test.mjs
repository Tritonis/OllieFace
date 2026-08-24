/**
 * Alignment telemetry (issue #166): the recorder half.
 *
 *   node tests/alignment-telemetry.test.mjs
 *
 * The audit's core question — is the corruption economy a decision anyone
 * makes, or a tax everyone pays — is unanswerable from the record as it stood,
 * because the three things it turns on left no trace: which currency opened a
 * chest, whether a mutation window was answered or merely suffered, and what
 * the shelf looked like at each boundary.
 *
 * Three things are checked here, and the second is the one that matters.
 *
 * The first is that every event the recorder now listens to lands in the right
 * field, driven by hand off a fake bus.
 *
 * The second is that EVERY resolution a mutation window can have is covered,
 * including the two that arrive by way of the run ending rather than the
 * player pressing anything. A classifier that silently bins an unanticipated
 * reason into `refusal` would make the explicit-choice rate — the whole point
 * of the field — quietly optimistic, so an unknown reason is carried through
 * verbatim and that is checked too.
 *
 * The third is against the real `Chest` and the real bus: the hand-driven arms
 * above prove the recorder reads `itemOffer` correctly and prove nothing at
 * all about whether the game emits it.
 */
import * as THREE from 'three';
import { RNG } from '../src/core/MathUtil.js';
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Chest, ArgentFont } from '../src/world/Interactables.js';
import {
  installTelemetry, readRuns, isChestLike, RECORD_VERSION, ENABLED_KEY,
} from '../src/systems/Telemetry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** A bus and a context the recorder can be installed on, with no engine. */
function rig({ inventory = [], chests = [], marks = 0, motes = 0 } = {}) {
  const listeners = new Map();
  const player = { isPlayer: true, alive: true };
  const ctx = {
    seed: 7, time: 0, authority: true, player,
    corruption: { world: 0, band: 0, marks, motes, warded: 0 },
    items: { gold: 0, inventory: () => inventory },
    interactables: { list: chests },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const storage = fakeStorage({ [ENABLED_KEY]: '1' });
  const rec = installTelemetry(ctx, { storage });
  return { ctx, storage, rec, fire: (n, p) => ctx.events.emit(n, p) };
}

const chest = (used) => ({ openT: -1, size: 'small', cost: 25, enabled: true, used, available() { return this.enabled && !this.used; } });

console.log('chest opens are recorded with the currency that paid for them');
{
  const { fire, storage } = rig({ chests: [chest(false), chest(false), chest(true)] });
  fire('stageStart', { index: 0, name: 'the-shore' });
  fire('itemOffer', { kind: 'chest', size: 'small', cost: 25, outcome: 'gold' });
  fire('itemOffer', { kind: 'chest', size: 'large', cost: 60, outcome: 'corrupt' });
  fire('itemStabilised', { blightId: 'b', baseId: 'a', count: 2 });
  fire('runEnd', { won: false, stats: null });

  const run = readRuns(storage)[0];
  ok(run.version === RECORD_VERSION && RECORD_VERSION === 3, 'the record announces version 3');
  ok(run.itemOffers.length === 2, 'both opens landed');
  ok(run.itemOffers[0].outcome === 'taken-normally', 'a gold open is taken-normally');
  ok(run.itemOffers[1].outcome === 'taken-corrupted', 'a void-credit open is taken-corrupted');
  ok(run.itemOffers[1].size === 'large' && run.itemOffers[1].cost === 60, 'carrying the chest it was');
  ok(run.stages[0].chestsLeft === 2, 'and the two unopened chests are the `left` arm');
  ok(run.stabilisations.length === 1, 'a salvage is counted beside the offers, not inside them');
}

console.log('a stage with no interactable list says so rather than reporting zero');
{
  const { ctx, fire, storage } = rig();
  ctx.interactables = null;
  fire('stageStart', { index: 0 });
  fire('runEnd', {});
  ok(readRuns(storage)[0].stages[0].chestsLeft === null, 'chestsLeft is null, not 0');
}

console.log('every mutation resolution is classified');
{
  const cases = [
    ['chosen', 'explicit-choice'], ['refused', 'refusal'], ['timeout', 'timeout'],
    ['superseded', 'superseded'], ['death', 'death'], ['runEnd', 'run-end'],
  ];
  for (const [reason, outcome] of cases) {
    const { fire, storage } = rig();
    fire('stageStart', { index: 0 });
    fire('mutationChoiceOffered', { band: 2, seconds: 12, offers: [{ baseId: 'a' }, { baseId: 'b' }] });
    fire('mutationChoiceClosed', { band: 2, reason, baseId: reason === 'chosen' ? 'a' : null });
    fire('runEnd', {});
    const m = readRuns(storage)[0].mutationChoices;
    ok(m.length === 1 && m[0].outcome === outcome, `${reason} -> ${outcome}`);
    ok(JSON.stringify(m[0].offers) === '["a","b"]', `  and ${reason} keeps what was on the table`);
    ok(m[0].band === 2 && m[0].stage === 0, `  and where it happened`);
  }
}

console.log('an unanticipated reason is carried through, never binned');
{
  const { fire, storage } = rig();
  fire('stageStart', { index: 0 });
  fire('mutationChoiceOffered', { band: 1, seconds: 12, offers: [] });
  fire('mutationChoiceClosed', { band: 1, reason: 'swallowed-by-a-portal' });
  fire('runEnd', {});
  ok(readRuns(storage)[0].mutationChoices[0].outcome === 'swallowed-by-a-portal',
    'the outcome is the reason itself');
}

console.log('a window still open when the run ends is filed exactly once');
{
  const { fire, storage } = rig();
  fire('stageStart', { index: 0 });
  fire('mutationChoiceOffered', { band: 3, seconds: 12, offers: [{ baseId: 'a' }] });
  fire('runEnd', {});
  // `Items` closes its own window from its own `runEnd` listener, and the bus
  // gives no ordering guarantee. Whichever arrives second must add nothing.
  fire('mutationChoiceClosed', { band: 3, reason: 'runEnd' });
  const m = readRuns(storage)[0].mutationChoices;
  ok(m.length === 1 && m[0].outcome === 'run-end', 'one entry, and it is the run-end one');
}

console.log('the reverse order — Items first — files exactly one too');
{
  const { fire, storage } = rig();
  fire('stageStart', { index: 0 });
  fire('mutationChoiceOffered', { band: 3, seconds: 12, offers: [{ baseId: 'a' }] });
  fire('mutationChoiceClosed', { band: 3, reason: 'runEnd' });
  fire('runEnd', {});
  const m = readRuns(storage)[0].mutationChoices;
  ok(m.length === 1 && m[0].outcome === 'run-end', 'still one entry');
}

console.log('boundary snapshots carry both purses and the shelf');
{
  const inv = [
    { id: 'wardens-tally', count: 2, def: { tier: 'argent' } },
    { id: 'rot', count: 3, def: { tier: 'blight' } },
    { id: 'boots', count: 5, def: { tier: 'common' } },
  ];
  const { ctx, fire, storage } = rig({ inventory: inv, marks: 4, motes: 1 });
  fire('stageStart', { index: 0 });
  ctx.corruption.marks = 2;
  ctx.corruption.motes = 3;
  fire('realmEnter', { id: 'the-hollow' });
  fire('realmExit', {});
  fire('runEnd', {});

  const run = readRuns(storage)[0];
  const s = run.stages[0];
  ok(s.alignIn.marks === 4 && s.alignOut.marks === 2, 'void marks at both edges of the stage');
  ok(s.alignIn.motes === 1 && s.alignOut.motes === 3, 'argent motes at both edges');
  ok(s.alignOut.argent === 2 && s.alignOut.blight === 3 && s.alignOut.other === 5,
    'and the shelf split into the two poles and the rest');
  const v = run.realmVisits[0];
  ok(v.alignIn?.marks === 2 && v.alignOut?.motes === 3, 'a realm visit gets the same pair');
}

/**
 * Everything above proves the recorder reads the events. This proves the game
 * emits one of them, against the real `Chest`, the real `Items` and the real
 * `Corruption` — the gap the hand-driven bus cannot close.
 */
console.log('the real chest reports which currency opened it');
{
  const seen = [];
  const listeners = new Map();
  const ctx = {
    authority: true, seed: 5, time: 0, rng: new RNG(11),
    player: { isPlayer: true, alive: true },
    scene: { add() {}, remove() {} },
    interactables: { spawnOrb() {} },
    events: {
      emit(name, p) { if (name === 'itemOffer') seen.push(p); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);

  const rich = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  items.addGold(1000);
  ok(rich.interact(ctx.player) === true, 'a paid open resolved');
  ok(seen.length === 1 && seen[0].outcome === 'gold' && seen[0].kind === 'chest',
    'and reported the gold currency');

  const broke = new Chest(ctx, new THREE.Vector3(), 'large', 99999);
  ok(broke.interact(ctx.player) === true, 'a forced open resolved');
  ok(seen.length === 2 && seen[1].outcome === 'corrupt' && seen[1].size === 'large',
    'and reported the void credit');
  ok(seen[1].owner === ctx.player, 'naming the pawn that owes the debt');
}

console.log('the chest predicate matches chests and nothing else');
{
  const ctx = { scene: { add() {}, remove() {} }, events: { emit() {}, on() {} } };
  ok(isChestLike(new Chest(ctx, new THREE.Vector3(), 'small', 25)), 'a real Chest matches');
  ok(!isChestLike(new ArgentFont(ctx, new THREE.Vector3(), 2)), 'an ArgentFont does not');
  ok(!isChestLike(null) && !isChestLike({}), 'and neither does junk');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
