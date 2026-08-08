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
  ok(atone.feed === 1.25 && atone.refund === 5, 'Atonement: generous refund, worse feeds');
  const both = mods(['maw', 'atonement']);
  ok(Math.abs(both.feed - 2.5) < 1e-9 && both.refund === 5, 'the two compose');
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
  const expected = 25 - 25 * VOIDTOUCHED.refund * 5;
  ok(Math.abs(c.world - expected) < 1e-9, 'a real Atonement refunds ×5 on a real Corruption');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
