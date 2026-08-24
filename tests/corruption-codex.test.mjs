/**
 * The corruption codex — the logbook's Corruption page (issue #34).
 *
 *   node tests/corruption-codex.test.mjs
 *
 * The whole feature is a claim about *timing*: five pages, each written the
 * moment the player first meets the mechanic it describes and not before. A
 * test that only asserts "the page exists once the run is over" would pass
 * against an implementation that unlocks all five at boot — which is exactly
 * the front-loaded tutorial wall the ticket exists to avoid. So every trigger
 * below is checked twice: sealed at the state just short of its moment, and
 * written at it.
 *
 * The second claim is persistence. A page is a record of the player's own run
 * and must survive the browser closing, so the profile round-trip is pinned
 * through the real `flush`/`_load` pair rather than through an in-memory copy.
 */
import { Corruption } from '../src/systems/Corruption.js';
import { Codex } from '../src/systems/Codex.js';
import { Profile } from '../src/systems/Profile.js';
import { CODEX, CODEX_IDS, CODEX_BY_ID, ROUTE_BRIEF_STAGE } from '../src/data/codex.js';
import { BANDS, MUTATION, bandOf } from '../src/data/corruption.js';
import { MOTE, RELIQUARY } from '../src/data/bandBoons.js';
import { BLIGHT_BY_BASE, ITEM_BY_ID } from '../src/data/items.js';
import { UNLOCK_TYPES } from '../src/data/challenges.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// `Profile.flush` and `_load` both go through `localStorage`, which does not
// exist in node. A Map behind the two methods they use is the whole surface.
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
});

// A base item the blight toll could take, chosen off the table rather than
// named here: a rebalance that retires one card must not silently turn this
// file's "eligible stack" into a stack that is not eligible.
const BASE_ID = [...BLIGHT_BY_BASE.keys()].sort()[0];
const BASE_NAME = ITEM_BY_ID.get(BASE_ID).name;

function makeRig({ inventory = [] } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    events: {
      emit(name, payload) { for (const fn of [...(listeners.get(name) || [])]) fn(payload); },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
        return () => {
          const a = listeners.get(name);
          a.splice(a.indexOf(fn), 1);
        };
      },
    },
    items: { inventory: () => inventory },
  };
  const profile = new Profile();
  ctx.profile = profile;
  const corruption = new Corruption();
  corruption.init(ctx);
  const codex = new Codex();
  codex.init(ctx);
  ctx.player = { isPlayer: true };
  return { ctx, profile, corruption, codex };
}

const sealed = (profile, ids) => ids.every((id) => profile.unlockedAt('codex', id) === 0);

console.log('the catalogue is the five pages the ticket names, in teaching order');
{
  ok(CODEX_IDS.join(',') === 'first-feed,seeded,blight-toll,argent-font,finale-route',
    'five pages, in the order a run teaches them');
  ok(CODEX.every((c) => c.id && c.name && c.sub && c.hint && typeof c.lines === 'function'),
    'every page carries a name, a subtitle, a sealed hint and a body');
  ok(UNLOCK_TYPES.includes('codex'), 'codex is an unlock type, so the profile persists and merges it');
  // A page that named a challenge would be gated by `Profile.isUnlocked`'s
  // real gate table and could never be earned by playing.
  ok(CODEX.every((c) => !c.unlock), 'no page is bound to a challenge');
}

console.log('a run that has not started has recorded nothing');
{
  const { profile } = makeRig();
  ok(sealed(profile, CODEX_IDS), 'all five pages are sealed at boot');
}

console.log('page 1 is written by the first feed, and not by the gauge existing');
{
  const inv = [{ id: BASE_ID, count: 2, def: ITEM_BY_ID.get(BASE_ID) }];
  const { profile, corruption, ctx } = makeRig({ inventory: inv });
  // A bleed against a pristine world moves nothing and must write nothing.
  corruption.bleed(ctx.player, 10);
  ok(sealed(profile, CODEX_IDS), 'a no-op bleed on a pristine world writes no page');

  corruption.feed(ctx.player, 5);
  ok(profile.unlockedAt('codex', 'first-feed') > 0, 'the first feed writes The Gauge');
  ok(profile.codexFacts('first-feed').world === 5, 'and records what the gauge read');
  // The whole progressive-disclosure claim: one moment writes one page.
  ok(sealed(profile, ['seeded', 'blight-toll', 'argent-font', 'finale-route']),
    'the other four are still sealed');
}

console.log('page 2 waits for the band, not for a number the test picked');
{
  const { profile, corruption, ctx } = makeRig();
  corruption.feed(ctx.player, BANDS[1].at - 1);
  ok(profile.unlockedAt('codex', 'seeded') === 0, 'one point short of Seeded records nothing');
  corruption.feed(ctx.player, 1);
  ok(profile.unlockedAt('codex', 'seeded') > 0, 'crossing into Seeded writes it');
}

console.log('page 3 is written inside the window, never at band 0 and never after the toll');
{
  const inv = [{ id: BASE_ID, count: 2, def: ITEM_BY_ID.get(BASE_ID) }];
  const { profile, corruption, ctx } = makeRig({ inventory: inv });
  const pickup = () => ctx.events.emit('itemPickup', { id: BASE_ID, count: 2, delta: 0 });

  // Band 0 with an eligible stack: the toll is two bands away and the page
  // would be a warning about nothing.
  pickup();
  corruption.feed(ctx.player, 5);
  pickup();
  ok(profile.unlockedAt('codex', 'blight-toll') === 0, 'Pristine with an eligible stack writes nothing');

  corruption.feed(ctx.player, BANDS[1].at);
  ok(corruption.band === MUTATION.minBand - 1, 'the world is in the band below the first toll');
  ok(profile.unlockedAt('codex', 'blight-toll') > 0, 'Seeded with an eligible stack writes The Blight Toll');
  ok(profile.codexFacts('blight-toll').eligible.includes(BASE_NAME),
    'and names the stack that is actually at risk');
}

console.log('page 3 is not written for an empty pack');
{
  const { profile, corruption, ctx } = makeRig({ inventory: [] });
  corruption.feed(ctx.player, BANDS[1].at);
  ok(corruption.band === 1, 'the world reached Seeded');
  ok(profile.unlockedAt('codex', 'blight-toll') === 0, 'nothing eligible, nothing written');
}

console.log('page 4 is the first font press and keeps that press, not a later one');
{
  const { profile, ctx } = makeRig();
  ok(profile.unlockedAt('codex', 'argent-font') === 0, 'sealed until a font is paid');
  ctx.events.emit('fontUse', {
    stage: 1, press: 0, cost: 214, removed: 44,
    worldBefore: 200, worldAfter: 156, bandBefore: 3, bandAfter: 3,
  });
  const f = profile.codexFacts('argent-font');
  ok(profile.unlockedAt('codex', 'argent-font') > 0, 'the press writes The Argent Font');
  ok(f.cost === 214 && f.worldBefore === 200 && f.worldAfter === 156 && f.bandBefore === 3,
    'the exact before/after and price are the ones recorded');
  ctx.events.emit('fontUse', {
    stage: 4, press: 0, cost: 999, removed: 9,
    worldBefore: 40, worldAfter: 31, bandBefore: 1, bandAfter: 1,
  });
  ok(profile.codexFacts('argent-font').cost === 214, 'a later press does not overwrite the first');
}

console.log(`page 5 is written on stage ${ROUTE_BRIEF_STAGE} and no earlier`);
{
  const { profile, corruption, ctx } = makeRig();
  corruption.feed(ctx.player, 70);
  for (let shown = 1; shown < ROUTE_BRIEF_STAGE; shown++) {
    ctx.events.emit('stageStart', { index: shown - 1, name: `s${shown}` });
    ok(profile.unlockedAt('codex', 'finale-route') === 0, `stage ${shown} writes nothing`);
  }
  ctx.events.emit('stageStart', { index: ROUTE_BRIEF_STAGE - 1, name: 'brief' });
  ok(profile.unlockedAt('codex', 'finale-route') > 0, `stage ${ROUTE_BRIEF_STAGE} writes The Fracture`);
  ok(profile.codexFacts('finale-route').band === corruption.band, 'and records the band that routes it');
}

console.log('every page renders, with the facts it was given and without any');
{
  for (const c of CODEX) {
    const bare = c.lines({});
    ok(Array.isArray(bare) && bare.length > 0 && bare.every((l) => typeof l === 'string' && l.length > 20),
      `${c.id} renders paragraphs with no facts at all`);
  }
  const withFacts = CODEX_BY_ID.get('argent-font').lines({
    cost: 214, removed: 44, worldBefore: 200, worldAfter: 156, bandBefore: 3, bandAfter: 2,
  }).join(' ');
  ok(withFacts.includes('214') && withFacts.includes('200') && withFacts.includes('156'),
    'the font page quotes the press it recorded');
  ok(withFacts.includes(BANDS[3].name) && withFacts.includes(BANDS[2].name),
    'and the exact before/after band');
  // The tuning table is the source, never a number typed into the copy.
  const gauge = CODEX_BY_ID.get('first-feed').lines({ world: 5, band: 0 }).join(' ');
  ok(gauge.includes(String(BANDS[1].at)) && gauge.includes(BANDS[1].name),
    'the gauge page quotes the next threshold off BANDS');
}

// The codex is the written spec playtesters read, so a page that describes a
// retired mechanic is a defect and not a copy nit (issue #199). These are the
// checks the stale font page would have failed: it explained fonts purely as a
// gold-for-gauge refund and never mentioned the purity purse the bleeding
// actually feeds, and the toll page said the stack was "chosen for you" a
// release after `MUTATION.choiceOffers` gave the player the say. Asserted
// through the live constants for the usual reason — a re-tuned mote price must
// break this rather than leave the page quoting the old one.
console.log('the pages describe the economy the code actually runs');
{
  const font = CODEX_BY_ID.get('argent-font').lines({}).join(' ');
  ok(/mote/i.test(font) && font.includes(String(MOTE.per)),
    'the font page names the mote and what a mote costs in warding');
  ok(/sanctuary/i.test(font) && font.includes(String(MOTE.sanctuarySeconds)),
    'and the window a mote buys, with its length off MOTE');
  ok(/consecration/i.test(font) && font.includes(String(RELIQUARY.motes)),
    'and the deeper rung that replaces it, priced off RELIQUARY');
  ok(font.includes(BANDS[bandOf(RELIQUARY.fadeAt)].name),
    'and the band at which an argent card has faded to nothing');

  const toll = CODEX_BY_ID.get('blight-toll').lines({}).join(' ');
  ok(toll.includes(String(MUTATION.choiceOffers)) && toll.includes(String(MUTATION.choiceSeconds)),
    'the toll page gives the player the choice the crossing actually offers');
  ok(!/chosen for you/i.test(toll), 'and no longer says the stack is chosen for you');

  const seeded = CODEX_BY_ID.get('seeded').lines({}).join(' ');
  ok(/ward/i.test(seeded) && seeded.includes(String(MOTE.per)),
    'the Hollowed page says the refund is also what mints a mote');
}

console.log('pages survive the browser closing');
{
  store.clear();
  const inv = [{ id: BASE_ID, count: 2, def: ITEM_BY_ID.get(BASE_ID) }];
  const { profile, corruption, ctx } = makeRig({ inventory: inv });
  corruption.feed(ctx.player, BANDS[1].at);
  ctx.events.emit('fontUse', {
    stage: 1, press: 0, cost: 214, removed: 44,
    worldBefore: 200, worldAfter: 156, bandBefore: 3, bandAfter: 2,
  });
  const earned = CODEX_IDS.filter((id) => profile.unlockedAt('codex', id) > 0);
  // The feed to Seeded writes The Gauge, Seeded and The Blight Toll; the font
  // press writes the fourth. Only the finale briefing is left.
  ok(earned.length === 4, 'four pages earned in this run');
  profile.flush();
  clearTimeout(profile._writeTimer);

  const reloaded = new Profile();
  reloaded.data = reloaded._load();
  for (const id of earned) {
    ok(reloaded.unlockedAt('codex', id) > 0, `${id} survives the reload`);
  }
  ok(sealed(reloaded, CODEX_IDS.filter((id) => !earned.includes(id))),
    'and the pages that were never earned are still sealed');
  const f = reloaded.codexFacts('argent-font');
  ok(f && f.cost === 214 && f.worldAfter === 156, 'the recorded press survives with its numbers');
  ok(reloaded.codexFacts('blight-toll').eligible.includes(BASE_NAME),
    'and the eligible list survives as strings');
}

console.log('a hand-edited store cannot put structure in front of the page');
{
  const p = new Profile();
  const coerced = p._coerce({
    codex: {
      'argent-font': { cost: 12, note: 'ok', nested: { evil: true }, eligible: ['A', 7, 'B'], nan: NaN },
      'first-feed': 'not an object',
      'blight-toll': {},
    },
  });
  const f = coerced.codex['argent-font'];
  ok(f.cost === 12 && f.note === 'ok', 'scalars are kept');
  ok(!('nested' in f) && !('nan' in f), 'an object and a NaN are dropped rather than repaired');
  ok(f.eligible.join(',') === 'A,B', 'a mixed array keeps only its strings');
  ok(!('first-feed' in coerced.codex) && !('blight-toll' in coerced.codex),
    'a non-object and an empty blob store nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
