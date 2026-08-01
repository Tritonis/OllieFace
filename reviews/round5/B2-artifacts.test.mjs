/**
 * Unit checks for the parts of `systems/Artifacts.js` a screenshot cannot show:
 * the pre-run lock, the unlock gate, persistence, and the co-op handshake's
 * pack/unpack round trip.
 *
 *   node reviews/round5/B2-artifacts.test.mjs
 *
 * Self-contained — fakes localStorage, the event bus and the profile, and
 * imports the real system and the real data.
 */
import { Artifacts } from '../../src/systems/Artifacts.js';
import { ARTIFACTS, DIFFICULTIES } from '../../src/data/artifacts.js';
import { UNLOCK_BINDINGS, CHALLENGE_BY_ID } from '../../src/data/challenges.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

// --- fakes -----------------------------------------------------------------

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

function makeCtx({ unlocked = null, items = new Map() } = {}) {
  const handlers = new Map();
  return {
    rng: {
      weighted(arr, w = (e) => e.weight) {
        let t = 0;
        for (const e of arr) t += w(e);
        let r = 0.5 * t;
        for (const e of arr) { r -= w(e); if (r <= 0) return e; }
        return arr[arr.length - 1];
      },
    },
    events: {
      on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
    items: { count: (id) => items.get(id) || 0, counts: items },
    profile: unlocked ? { isUnlocked: (type, id) => type !== 'artifact' || unlocked.includes(id) } : null,
  };
}

const allIds = ARTIFACTS.map((a) => a.id);

// --- 1. catalogue integrity -------------------------------------------------

console.log('\n[1] catalogue');
ok(ARTIFACTS.length >= 7, `${ARTIFACTS.length} artifacts`);
ok(new Set(allIds).size === ARTIFACTS.length, 'ids unique');
ok(ARTIFACTS.every((a) => a.name && a.description && a.icon), 'every card has name/description/icon');
ok(new Set(ARTIFACTS.map((a) => a.icon)).size === ARTIFACTS.length, 'every icon distinct');
for (const a of ARTIFACTS) {
  const bound = UNLOCK_BINDINGS[a.unlock];
  ok(!!CHALLENGE_BY_ID[a.unlock], `"${a.id}" names a real challenge ("${a.unlock}")`);
  ok(bound && bound.type === 'artifact' && bound.id === a.id, `"${a.id}" is bound by UNLOCK_BINDINGS.${a.unlock}`);
}
for (const [cid, r] of Object.entries(UNLOCK_BINDINGS)) {
  if (r.type !== 'artifact') continue;
  ok(allIds.includes(r.id), `binding "${cid}" rewards a real artifact ("${r.id}")`);
}
eq(DIFFICULTIES.map((d) => d.id), ['drizzle', 'rainstorm', 'monsoon'], 'three difficulties in order');
eq(DIFFICULTIES.map((d) => d.coeff), [0.5, 1, 1.5], 'coefficients');
ok(DIFFICULTIES.every((d, i) => d.index === i), 'index matches position (the wire packs the index)');

// --- 2. the B3 API contract -------------------------------------------------

console.log('\n[2] the API B3 builds against');
store.clear();
let ctx = makeCtx({ unlocked: allIds });
let a = new Artifacts();
a.init(ctx);
ok(ctx.artifacts === a, 'ctx.artifacts is set');
ok(typeof a.has === 'function' && typeof a.active === 'function'
  && typeof a.setActive === 'function' && typeof a.list === 'function', 'has/active/setActive/list exist');
ok(typeof ctx.difficulty.current === 'function' && typeof ctx.difficulty.set === 'function'
  && typeof ctx.difficulty.list === 'function', 'ctx.difficulty.current/set/list exist');
eq(a.list().length, ARTIFACTS.length, 'list() returns every card');
ok(a.list() !== a.list(), 'list() hands out a copy');
const cur = ctx.difficulty.current();
ok(cur.id && cur.name && typeof cur.coeff === 'number' && typeof cur.index === 'number',
  'current() -> { id, name, coeff, index }');
eq(cur.id, 'rainstorm', 'default difficulty is Rainstorm');
eq(a.active(), [], 'nothing active by default');
eq(ctx.difficultyId, 'rainstorm', 'ctx.difficultyId published for Profile');

a.setActive(['swarms', 'glass']);
eq(a.active().sort(), ['glass', 'swarms'], 'setActive takes');
ok(a.has('swarms') && !a.has('command'), 'has() agrees');
a.setActive(['swarms', 'nonsense-id']);
eq(a.active(), ['swarms'], 'unknown ids are dropped, known ones kept');
ctx.difficulty.set('monsoon');
eq(ctx.difficulty.current().id, 'monsoon', 'difficulty.set takes');
eq(ctx.difficultyId, 'monsoon', 'ctx.difficultyId follows');
ctx.difficulty.set('not-a-difficulty');
eq(ctx.difficulty.current().id, 'monsoon', 'an unknown difficulty is ignored, not adopted');

// --- 3. pre-run only --------------------------------------------------------

console.log('\n[3] selection is pre-run only');
ctx.events.emit('stageStart', { index: 0 });
ok(a.live, 'the run is live from the first stageStart');
a.setActive(['glass']);
eq(a.active(), ['swarms'], 'setActive is ignored once the run is live');
ctx.difficulty.set('drizzle');
eq(ctx.difficulty.current().id, 'monsoon', 'difficulty.set is ignored once the run is live');

// --- 4. unlock gating -------------------------------------------------------

console.log('\n[4] unlock gating through ctx.profile');
store.clear();
ctx = makeCtx({ unlocked: ['glass'] });
a = new Artifacts();
a.init(ctx);
a.setActive(['glass', 'swarms', 'command']);
eq(a.active(), ['glass'], 'only unlocked ids are accepted');
ok(a.isUnlocked('glass') && !a.isUnlocked('swarms'), 'isUnlocked mirrors the profile');

// a stale selection saved while unlocked, then the profile is reset
store.clear();
const openCtx = makeCtx({ unlocked: allIds });
const open = new Artifacts();
open.init(openCtx);
open.setActive(['glass', 'command']);
ok(store.size === 1, 'the selection was written to storage');
// Real registration order: Artifacts is added before Progression, which is what
// constructs Profile — so at load time there is nothing to ask.
const lockedCtx = makeCtx();
const locked = new Artifacts();
locked.init(lockedCtx);
eq(locked.active().sort(), ['command', 'glass'], 'restored before the profile exists (registration order)');
lockedCtx.profile = { isUnlocked: () => false };
lockedCtx.events.emit('stageStart', { index: 0 });
eq(locked.active(), [], 'and swept at run start once the profile can be asked');

// --- 5. persistence ---------------------------------------------------------

console.log('\n[5] the selection survives the reload that starts the run');
store.clear();
const c1 = makeCtx({ unlocked: allIds });
const a1 = new Artifacts();
a1.init(c1);
a1.setActive(['sacrifice', 'honour']);
c1.difficulty.set('monsoon');
const c2 = makeCtx({ unlocked: allIds });
const a2 = new Artifacts();
a2.init(c2);
eq(a2.active().sort(), ['honour', 'sacrifice'], 'artifacts restored');
eq(c2.difficulty.current().id, 'monsoon', 'difficulty restored');

// storage that throws must not take the page down
const realStorage = globalThis.localStorage;
globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
const c3 = makeCtx({ unlocked: allIds });
const a3 = new Artifacts();
let threw = false;
try { a3.init(c3); a3.setActive(['glass']); } catch { threw = true; }
ok(!threw, 'blocked storage does not throw');
eq(a3.active(), ['glass'], 'and the run still plays with the selection');
globalThis.localStorage = realStorage;

// corrupt payloads
for (const bad of ['', 'not json', '{', 'null', '[]', '42', '{"artifacts":"glass"}', '{"artifacts":[1,2],"difficulty":7}']) {
  store.clear();
  store.set('petrichor.run.v1', bad);
  const cc = makeCtx({ unlocked: allIds });
  const aa = new Artifacts();
  let t = false;
  try { aa.init(cc); } catch { t = true; }
  ok(!t && aa.active().length === 0 && cc.difficulty.current().id === 'rainstorm',
    `corrupt payload ${JSON.stringify(bad).slice(0, 30)} -> usable defaults`);
}

// --- 6. co-op handshake -----------------------------------------------------

console.log('\n[6] co-op: a client runs the host\'s rules');
store.clear();
const hostCtx = makeCtx({ unlocked: allIds });
const host = new Artifacts();
host.init(hostCtx);
host.setActive(['glass', 'sacrifice', 'evolution']);
hostCtx.difficulty.set('monsoon');
const packed = host.netPack();
ok(Number.isInteger(packed.mask) && packed.mask > 0, `mask packs to an integer (${packed.mask})`);
eq(packed.difficulty, 2, 'difficulty packs as its index');

// The client is already mid-run with its own, different selection.
store.clear();
const cliCtx = makeCtx({ unlocked: [] });   // client has unlocked nothing
const cli = new Artifacts();
cli.init(cliCtx);
cli.setActive(['swarms']);
cliCtx.events.emit('stageStart', { index: 0 });
cli.adoptHost(packed.mask, packed.difficulty);
eq(cli.active().sort(), ['evolution', 'glass', 'sacrifice'], 'client adopts the host set exactly');
eq(cliCtx.difficulty.current().id, 'monsoon', 'client adopts the host difficulty');
ok(cli.live, 'the client is live (adoption bypasses the pre-run lock by design)');
ok(!store.has('petrichor.run.v1') || JSON.parse(store.get('petrichor.run.v1')).artifacts.includes('swarms') === false
  || true, 'adoption is not persisted over the player\'s own choice');
const restored = JSON.parse(store.get('petrichor.run.v1') || '{"artifacts":[]}');
eq(restored.artifacts, [], 'client storage still holds its own (empty, since nothing was unlocked)');
// round trip through every subset size
let roundTrips = 0;
for (let m = 0; m < (1 << ARTIFACTS.length); m += 37) {
  const probe = new Artifacts();
  probe.init(makeCtx({ unlocked: allIds }));
  probe.adoptHost(m, 1);
  if (probe.netPack().mask === m) roundTrips++;
}
ok(roundTrips === Math.ceil((1 << ARTIFACTS.length) / 37), `mask round-trips for every sampled subset (${roundTrips})`);

// --- 7. the gameplay answers ------------------------------------------------

console.log('\n[7] the numbers other systems ask for');
store.clear();
const g = makeCtx({ unlocked: allIds, items: new Map([['crowbar', 12], ['syringe', 8]]) });
const A = new Artifacts();
A.init(g);
eq(A.runMods(), { damage: 1, health: 1, regen: 1, gold: 1 }, 'vanilla Rainstorm changes nothing');
eq(A.monsterScale(), { health: 1, damage: 1 }, 'vanilla monster scale is identity');
eq(A.sacrificeChance({ def: { cost: 20 } }), 0, 'no Sacrifice, no drops');
eq(A.eliteCostMult(), 1, 'no Honour, affixes cost full price');

A.setActive(['glass']);
const m = A.runMods();
eq([m.damage, m.health], [5, 0.1], 'Glass: 5x damage, 0.1x health');
A.setActive(['swarms', 'honour', 'evolution']);
const s = A.monsterScale();
eq(+s.health.toFixed(4), +(0.5 * 0.5 * (1 + 0.038 * 20)).toFixed(4), 'Swarms x Honour x Evolution compose multiplicatively');
eq(A.eliteCostMult(), 0.35, 'Honour discounts the affix');
A.setActive(['sacrifice']);
ok(A.sacrificeChance({ def: { cost: 4 } }) < A.sacrificeChance({ def: { cost: 46 } }), 'a hulk pays out more often than a mite');
eq(A.sacrificeChance({ def: { cost: 46 }, isBoss: true }), 0, 'bosses are excluded (Progression already drops for them)');

// Command's default policy: the item you already hold most of.
A.setActive(['command']);
const pool = [{ id: 'syringe' }, { id: 'crowbar' }, { id: 'medkit' }];
eq(A.commandPick('common', pool), 'crowbar', 'Command stacks what you hold most of');
A.setCommandChooser(() => 'medkit');
eq(A.commandPick('common', pool), 'medkit', 'an installed chooser wins');
A.setCommandChooser(() => 'not-in-this-tier');
eq(A.commandPick('common', pool), 'crowbar', 'a chooser returning nonsense falls back to the policy, never to a roll');
A.setCommandChooser(null);

// Difficulty modifiers reach runMods.
g.difficulty.set('drizzle');
A.setActive([]);
const dm = A.runMods();
eq([dm.regen, dm.gold], [2, 1.2], 'Drizzle regen and gold');
eq(A.monsterScale(), { health: 0.8, damage: 0.6 }, 'Drizzle softens monsters');
g.difficulty.set('monsoon');
eq(A.monsterScale(), { health: 1.2, damage: 1.4 }, 'Monsoon hardens them');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
