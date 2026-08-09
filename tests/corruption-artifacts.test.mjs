// Artifacts modify the corruption economy (launch spec §1): the Maw
// accelerates every feed, Atonement makes the refund generous and the feeds
// worse — and the cards obey the file's own rules (real marks, valid ids).
//
// `MARKS` is module-private in `src/ui/Icons.js`; `hasMark` is the exported
// question about it, so that is what this asks rather than widening the
// module's surface for a test.
import { ARTIFACTS, ARTIFACT_BY_ID } from '../src/data/artifacts.js';
import { Artifacts } from '../src/systems/Artifacts.js';
import { hasMark } from '../src/ui/Icons.js';

let pass = 0, fail = 0;
// `ATONEMENT_REFUND` is module-private; `corruptionMods()` is the exported
// question about it, so the tests read it from there rather than widen the
// module's surface (the same rule this file already applies to `MARKS`).
let ATONE_REFUND = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the cards exist and obey the card rules');
{
  const maw = ARTIFACT_BY_ID.get('maw');
  const atone = ARTIFACT_BY_ID.get('atonement');
  ok(!!maw && !!atone, 'both cards registered');
  ok(maw.unlock === null && atone.unlock === null, 'always-on: no challenge plumbing');
  for (const c of [maw, atone]) {
    ok(typeof c.name === 'string' && typeof c.description === 'string' && typeof c.flavour === 'string', `${c.id} has its words`);
    ok(hasMark(c.mark), `${c.id}'s mark is an authored vector in Icons.js`);
  }
  const ids = ARTIFACTS.map((a) => a.id);
  ok(new Set(ids).size === ids.length, 'no id collisions');
}

console.log('corruptionMods answers the economy question');
{
  // Constructed, never init()ed: corruptionMods reads only `this.set`, and
  // init drags storage/profile that a headless test has no business building.
  const art = new Artifacts();
  const mods = (ids) => { art.set.clear(); for (const id of ids) art.set.add(id); return { ...art.corruptionMods() }; };
  const base = mods([]);
  ok(base.feed === 1 && base.refund === 1, 'no cards, no change');
  const maw = mods(['maw']);
  ok(maw.feed === 2 && maw.refund === 1, 'the Maw doubles every feed');
  const atone = mods(['atonement']);
  ok(atone.feed === 1.25 && atone.refund > 1, 'Atonement: generous refund, worse feeds');
  const both = mods(['maw', 'atonement']);
  ok(Math.abs(both.feed - 2.5) < 1e-9 && both.refund === atone.refund, 'the two compose');
  ATONE_REFUND = atone.refund;
}

// The tuned figure is the EFFECTIVE bleed, not the multiplier: Atonement pays
// 15% of the world per Hollowed kill. The multiplier is only that target
// divided by the base refund, so re-pricing `VOIDTOUCHED.refund` without
// re-deriving `ATONEMENT_REFUND` silently re-tunes the card. This is the pin.
console.log('Atonement pays an effective 15% of the world per Hollowed kill');
{
  const { VOIDTOUCHED } = await import('../src/data/corruption.js');
  ok(Math.abs(VOIDTOUCHED.refund * ATONE_REFUND - 0.15) < 1e-9,
    `base refund x the Atonement multiplier is the tuned 0.15 (got ${VOIDTOUCHED.refund * ATONE_REFUND})`);
}

console.log('— consultation points —');
const { Corruption } = await import('../src/systems/Corruption.js');
const { VOIDTOUCHED } = await import('../src/data/corruption.js');

function makeCtx({ mods = null } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  if (mods) ctx.artifacts = { corruptionMods: () => mods };
  const c = new Corruption();
  c.init(ctx);
  return { ctx, c };
}
const P = () => ({ isPlayer: true, alive: true });

console.log('the Maw doubles every feed');
{
  const { c } = makeCtx({ mods: { feed: 2, refund: 1 } });
  const p = P();
  ok(c.feed(p, 10) === 20, 'feed returns the accelerated amount');
  ok(c.world === 20 && c.corruptionOf(p) === 20, 'and the ledgers carry it');
}

console.log('no artifacts system, no change — the fixture proves the default');
{
  const { c } = makeCtx();
  ok(c.feed(P(), 10) === 10, 'multiplier 1 when ctx.artifacts is absent');
}

console.log('Atonement multiplies the Voidtouched refund');
{
  const { ctx, c } = makeCtx({ mods: { feed: 1, refund: 5 } });
  const p = P();
  c.feed(p, 100);
  ctx.events.emit('kill', { victim: { affix: VOIDTOUCHED.affix }, source: p });
  const expected = 100 - 100 * VOIDTOUCHED.refund * 5;
  ok(Math.abs(c.world - expected) < 1e-9, 'five times the refund came back');
}

console.log('an ordinary kill still refunds nothing');
{
  const { ctx, c } = makeCtx({ mods: { feed: 1, refund: 5 } });
  const p = P();
  c.feed(p, 100);
  ctx.events.emit('kill', { victim: { affix: 'overloading' }, source: p });
  ok(c.world === 100, 'the multiplier gates on the Voidtouched affix as before');
}

console.log('the two halves agree — no stub: a real Artifacts drives a real Corruption');
{
  const listeners = new Map();
  const ctx = { authority: true, events: { emit(n, p) { for (const f of listeners.get(n) || []) f(p); },
    on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); } } };
  const art = new Artifacts(); ctx.artifacts = art; art.set.add('maw');
  const c = new Corruption(); c.init(ctx);
  ok(c.feed({ isPlayer: true }, 10) === 20, 'a real Artifacts drives a real Corruption');
}

console.log('the two halves agree — atonement composed with maw, and the refund');
{
  const listeners = new Map();
  const ctx = { authority: true, events: { emit(n, p) { for (const f of listeners.get(n) || []) f(p); },
    on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); } } };
  const art = new Artifacts(); ctx.artifacts = art;
  art.set.add('maw'); art.set.add('atonement');
  const c = new Corruption(); c.init(ctx);
  const p = P();
  ok(c.feed(p, 10) === 25, 'maw + atonement compose to ×2.5 on a real feed, real Artifacts driving real Corruption');
  ctx.events.emit('kill', { victim: { affix: VOIDTOUCHED.affix }, source: p });
  // The real card, so the expectation is the real effective bleed: 15% of the
  // world, stated as the tuned target rather than re-deriving the multiplier.
  const expected = 25 - 25 * 0.15;
  ok(Math.abs(c.world - expected) < 1e-9,
    `a real Atonement bleeds the tuned 15% on a real Corruption (got ${c.world})`);
}

console.log('the two halves agree — greed time composes with the real Maw to ×5.0');
{
  const listeners = new Map();
  const ctx = { authority: true, events: { emit(n, p) { for (const f of listeners.get(n) || []) f(p); },
    on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); } } };
  const art = new Artifacts(); ctx.artifacts = art;
  art.set.add('maw'); art.set.add('atonement');
  const c = new Corruption(); c.init(ctx);
  const p = P();
  ctx.events.emit('teleporterComplete');
  ok(c.feed(p, 10) === 50, 'greed time × the Maw × Atonement composes to ×5.0 on a real feed');
}

// ---------------------------------------------------------------------------
// The Vigil of the Unbroken Seal — the one card greed cannot buy.
//
// Everything below drives the REAL machinery: the card declares a challenge id,
// `systems/UnlockRegistry.js` discovers it and binds it, and a real `Profile`
// gates the artifact on it. Nothing here stubs the gate, because a stubbed gate
// would pass with the binding missing — which is the exact failure that would
// leave the Vigil either permanently locked or free for the taking.
console.log('Vigil of the Unbroken Seal — the card, and the condition on it');
{
  // Importing the registry is what resolves `UNLOCK_BINDINGS`; it runs at module
  // evaluation and binds every card that names a challenge.
  await import('../src/systems/UnlockRegistry.js');
  const { CHALLENGE_BY_ID, UNLOCK_BINDINGS } = await import('../src/data/challenges.js');

  const vigil = ARTIFACT_BY_ID.get('vigil');
  ok(!!vigil, 'the card is registered');
  ok(vigil?.name === 'Vigil of the Unbroken Seal', 'and carries its name');
  ok(typeof vigil?.description === 'string' && typeof vigil?.flavour === 'string', 'it has its words');
  ok(hasMark(vigil?.mark), "the Vigil's mark is an authored vector in Icons.js — no fallback glyph");
  ok(typeof vigil?.unlock === 'string' && !!vigil.unlock,
    'it is earned, not given: `unlock` names a challenge rather than being null');
  ok(!!CHALLENGE_BY_ID[vigil?.unlock], `"${vigil?.unlock}" is a real challenge`);
  const bound = UNLOCK_BINDINGS[vigil?.unlock];
  ok(bound?.type === 'artifact' && bound?.id === 'vigil',
    'and the registry bound that challenge to this artifact');

  // `Artifacts.netPack` is a `1 << i` bitmask over ARTIFACTS in array order, and
  // a host and a client on mismatched builds must agree on every bit. So the
  // order is a wire format: new cards go on the end, and the two assertions
  // below are what make a mid-array insertion a red test rather than a silent
  // reinterpretation of every bit above it.
  ok(ARTIFACTS[ARTIFACTS.length - 1].id === 'vigil',
    'the Vigil is appended LAST — every netPack bit below it keeps its meaning');
  ok(ARTIFACTS.length === 10,
    'ten cards, so the whole mask still fits a u32 (update this number when a card is added)');
}

console.log('the Vigil discounts every feed and leaves the refund alone');
{
  const art = new Artifacts();
  const mods = (ids) => { art.set.clear(); for (const id of ids) art.set.add(id); return { ...art.corruptionMods() }; };
  const v = mods(['vigil']);
  ok(Math.abs(v.feed - 0.65) < 1e-9, 'feeds cost 35% less');
  ok(v.refund === 1, 'and the refund is untouched — the discount is on what you take');
  const vm = mods(['vigil', 'maw']);
  ok(Math.abs(vm.feed - 1.3) < 1e-9, 'it composes with the Maw rather than replacing it');
}

console.log('the two halves agree — a real Vigil drives a real Corruption');
{
  const listeners = new Map();
  const ctx = { authority: true, events: { emit(n, p) { for (const f of listeners.get(n) || []) f(p); },
    on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); } } };
  const art = new Artifacts(); ctx.artifacts = art; art.set.add('vigil');
  const c = new Corruption(); c.init(ctx);
  ok(Math.abs(c.feed({ isPlayer: true }, 10) - 6.5) < 1e-9, 'ten points of greed feeds 6.5');
}

console.log('the clean ending is what seals it — a real Profile, a real commit');
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const { Profile } = await import('../src/systems/Profile.js');

  /**
   * A fresh profile mid-run: empty storage, one stage started, then one ending.
   * `ending` is the id `Progression.runStats()` reports — `ENDINGS.victory` by
   * default, because that is the run the challenge's wording describes.
   */
  // `peak` defaults to the ending band — a run that never moved — but an
  // explicitly passed `undefined` must stay undefined, because "the field is
  // missing" is one of the shapes the gate has to decline.
  function endRun(won, corruptionBand, ending = 'victory', ...rest) {
    const peak = rest.length ? rest[0] : corruptionBand;
    store.clear();
    const listeners = new Map();
    const ctx = {
      authority: true, netRole: 'single', player: { isPlayer: true, survivorId: null },
      events: { on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); },
        emit(n, p) { for (const f of listeners.get(n) || []) f(p); } },
    };
    const profile = new Profile();
    profile.init(ctx);
    ctx.events.emit('stageStart', { index: 0, name: 'Stage 1' });
    // The same shape `Progression.runStats()` hands `commitRun`.
    profile.commitRun(won, {
      stage: 1, stageName: 'Stage 1', time: 300, difficulty: 1, gold: 0,
      corruption: 12, corruptionBand, corruptionPeakBand: peak, inventory: [], ending,
    });
    return profile;
  }
  const sealed = (...args) => endRun(...args).isUnlocked('artifact', 'vigil');

  ok(sealed(true, 0) === true, 'a victory carried home Pristine seals the Vigil');
  ok(sealed(true, 1) === true, 'so does one at Seeded — band 1 is the line');
  ok(sealed(true, 0, 'victory-void') === true,
    'the void route is still a Fracture finish — the Herald drowns and the seal holds');
  ok(sealed(true, 2) === false,
    'a victory at Blighted does not: greed cannot buy this one');
  ok(sealed(false, 0) === false,
    'and dying spotless does not — the seal is carried out, not died with');

  // The Obelisk of Departure stands in the bazaar from stage 1 and its ending
  // carries `won: true` (ENDINGS.obliterated, data/realms.js). Ending the run on
  // your own terms two minutes in is not "finishing a run at the Fracture", and
  // the row the player reads says so.
  ok(sealed(true, 0, 'obliterated') === false,
    'walking into the Obelisk on stage 1 with a spotless world does NOT seal it');
  ok(sealed(true, 0, null) === false,
    'and neither does a win with no named ending at all');

  // The purity test. The laundering line the economy review walked: rot the
  // world to Consumed for the loot and the gold, then buy it back down at the
  // guaranteed fonts on the way to the Fracture and arrive at Seeded. That run
  // still gets the clean route, the easier Herald and the ending — it does not
  // get the card that says the seal was never broken.
  ok(sealed(true, 1, 'victory', 4) === false,
    'a run laundered from Consumed down to Seeded at the door does NOT seal the Vigil');
  ok(sealed(true, 0, 'victory', 2) === false,
    'not even one that ends Pristine, if it was ever Blighted');
  ok(sealed(true, 1, 'victory', 1) === true,
    'a run that genuinely never passed Seeded still does');
  // Fails closed on the peak in the same seven ways the ending band did, and
  // it is the peak that is read: a spotless ending band cannot stand in for it.
  for (const [peak, label] of [[undefined, 'a missing peak'], [null, 'a null peak'], [NaN, 'NaN'],
    [Infinity, 'Infinity'], ['0', 'the string "0"'], [-1, 'a negative peak'], [1.5, 'a fractional peak']]) {
    ok(sealed(true, 0, 'victory', peak) === false, `${label} declines the seal rather than granting it`);
  }

  // Where the peak comes from: the real Progression, listening to the real
  // Corruption's band events. A snapshot taken at the ending cannot see a world
  // that was Consumed an hour ago and has since been bought back down, so the
  // mark has to be kept as it happens.
  {
    const { Progression } = await import('../src/systems/Progression.js');
    const { Corruption } = await import('../src/systems/Corruption.js');
    const listeners = new Map();
    const player = { isPlayer: true, alive: true, survivorId: null };
    const ctx = {
      authority: true, netRole: 'single', player, time: 0,
      scene: { add() {} },
      events: { on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); },
        emit(n, p) { for (const f of listeners.get(n) || []) f(p); } },
    };
    const prog = new Progression();
    prog.init(ctx);
    const cor = new Corruption();
    cor.init(ctx);

    cor.feed(player, 400);
    ok(cor.band === 4 && prog.corruptionPeakBand === 4, `the mark follows the world up (${prog.corruptionPeakBand})`);
    cor.bleed(player, 390);
    ok(cor.band < 4, 'and the world comes back down');
    const stats = prog.runStats();
    ok(stats.corruptionBand === cor.band && stats.corruptionPeakBand === 4,
      `runStats reports both the ending band (${stats.corruptionBand}) and the peak (${stats.corruptionPeakBand})`);
  }

  // And the run record keeps the evidence, so a granted seal can be audited.
  {
    const p = endRun(true, 1, 'victory', 4);
    const rec = p.data.runs[0];
    ok(rec.corruptionBand === 1 && rec.corruptionPeakBand === 4 && rec.corruption === 12,
      `the persisted run carries the corruption it was judged on (${JSON.stringify(
        { c: rec.corruption, band: rec.corruptionBand, peak: rec.corruptionPeakBand })})`);
  }

  // The band predicate fails closed: the one unbuyable card is never handed out
  // by a caller that simply forgot the field.
  for (const [band, label] of [[undefined, 'a missing band'], [null, 'a null band'], [NaN, 'NaN'],
    [Infinity, 'Infinity'], ['0', 'the string "0"'], [-1, 'a negative band'], [1.5, 'a fractional band']]) {
    ok(sealed(true, band) === false, `${label} declines the seal rather than granting it`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
