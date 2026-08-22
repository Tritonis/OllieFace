// tests/argent-registries.test.mjs
// Argent is a tier in every table that decides what a card looks like.
//
// The pool shipped registered in exactly one of them — `TIERS` in
// `src/data/items.js` — and every other table went on believing there were
// seven tiers. Nothing threw. What happened instead was four quiet wrongs:
//
//   1. the end-of-run haul grid filtered its tiers through `TIER_ORDER` and
//      dropped every argent card the run had bought, off a screen whose whole
//      job is to show what the run bought;
//   2. the pickup banner asked `tierMeta` for a label, got the `|| TIERS.common`
//      fallback, and told the player their consecrated card was Common;
//   3. `Items.inventory()`'s comparator subtracted an undefined rank, and NaN
//      makes every comparison false — so the tier sort collapsed to a name sort
//      and argent cards interleaved among the whites;
//   4. the HUD strip had no argent group, so the icon went into the common one.
//
// Argent's *colour* is a parked decision (#140) and is deliberately outside the
// readability gate's proven palette; that is `TIER_ORDER`'s business. Everything
// this file checks is the other half — membership, order, label, grouping —
// which has no colour in it and had no excuse to be missing.
import { readFileSync } from 'node:fs';
import { Items } from '../src/systems/Items.js';
import { ITEMS_BY_TIER, ITEM_BY_ID } from '../src/data/items.js';
import { CONTENT_TIERS, TIER_ORDER, TIERS, tierMeta } from '../src/ui/Icons.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function makeItems() {
  const listeners = new Map();
  const ctx = {
    authority: true, seed: 7, rng: new RNG(7), time: 0,
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const items = new Items();
  items.init(ctx);
  return items;
}

console.log('the tier is in the content ladder, and the palette stays the palette');
{
  ok(CONTENT_TIERS.includes('argent'), 'argent is a content tier');
  // #140 put it in the gated palette too, by re-cutting all eight colours at
  // once rather than hunting an eighth against seven frozen ones. The two lists
  // are now the same set and differ only in order — the palette's order is
  // arbitrary, the content list's is the order the player reads.
  ok(TIER_ORDER.includes('argent'), 'and is in the gated palette as well');
  ok([...TIER_ORDER].sort().join() === [...CONTENT_TIERS].sort().join(),
     'the two lists carry the same tiers, and only their order differs');
  for (const t of TIER_ORDER) ok(CONTENT_TIERS.includes(t), `${t} is in both`);
  ok(CONTENT_TIERS.indexOf('argent') > CONTENT_TIERS.indexOf('blight'),
     'argent reads after blight');
  ok(CONTENT_TIERS.indexOf('argent') < CONTENT_TIERS.indexOf('equipment'),
     'and before the hardware slot');
  ok(new Set(CONTENT_TIERS).size === CONTENT_TIERS.length, 'no duplicates');
  for (const t of CONTENT_TIERS) ok(!!TIERS[t], `${t} has an entry in TIERS`);
}

console.log('the banner calls it Argent, not Common');
{
  const meta = tierMeta('argent');
  ok(meta.label === 'Argent', `tierMeta('argent') is labelled ${JSON.stringify(meta.label)}`);
  ok(meta !== tierMeta('common'), 'and is not the Common fallback object');
  ok(meta.color !== tierMeta('common').color, 'nor Common\'s colour');
  // The fallback is what produced the wrong label, and it must still be there
  // for genuinely unknown keys - the guard is that argent no longer reaches it.
  ok(tierMeta('no-such-tier') === TIERS.common, 'an unknown tier still falls back to Common');
}

console.log('the inventory sort ranks it instead of giving up');
{
  // The comparator's failure mode is not a crash, it is a *silent* fallback:
  // `undefined - 5` is NaN, NaN is falsy, and `||` hands the whole decision to
  // `localeCompare`. A name sort agrees with a tier sort about half the time,
  // so the holdings are picked to disagree - the two argent cards are the two
  // whose names sort EARLIEST, and the three commons the three whose names sort
  // LATEST. Under a name sort the argents come first, which is exactly wrong.
  const byName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const argentIds = byName(ITEMS_BY_TIER.argent || []).slice(0, 2).map((d) => d.id);
  ok(argentIds.length === 2, `the pool has cards to sort (${argentIds.join(', ')})`);
  const commonDefs = byName(ITEMS_BY_TIER.common || []).slice(-3);
  const commons = commonDefs.map((d) => d.id);
  ok(commons.length === 3, 'and three commons to interleave with');
  const lastArgentName = ITEM_BY_ID.get(argentIds[1]).name;
  ok(commonDefs.every((d) => d.name.localeCompare(lastArgentName) > 0),
     `every common sorts after both argent cards by name (${lastArgentName})`);

  const items = makeItems();
  for (const id of [...argentIds, ...commons]) items.give(id, 1);
  const inv = items.inventory();
  ok(inv.length === 5, `five cards held (${inv.length})`);

  const ranks = inv.map((e) => CONTENT_TIERS.indexOf(e.def.tier));
  ok(ranks.every((r) => r >= 0), 'every held tier has a rank');
  let ordered = true;
  for (let i = 1; i < ranks.length; i++) if (ranks[i] < ranks[i - 1]) ordered = false;
  ok(ordered, `the strip reads in tier order (${inv.map((e) => e.def.tier).join(', ')})`);

  const firstArgent = inv.findIndex((e) => e.def.tier === 'argent');
  const lastCommon = inv.map((e) => e.def.tier).lastIndexOf('common');
  ok(firstArgent > lastCommon, 'no argent card is interleaved among the whites');

  // Deterministic, not merely sorted-this-once: the same holdings sort the same
  // way twice, which a NaN comparator cannot promise.
  ok(items.inventory().map((e) => e.id).join() === inv.map((e) => e.id).join(),
     'and the same order on a second read');
}

console.log('the haul grid and the strip group off the content ladder');
{
  const menus = src('../src/ui/Menus.js');
  ok(/const tiers = CONTENT_TIERS\.filter\(/.test(menus),
     'the end-of-run haul grid filters CONTENT_TIERS');
  ok(!/TIER_ORDER\.filter\(/.test(menus), 'and nothing in Menus filters the palette list');

  const hud = src('../src/ui/HUD.js');
  ok(/CONTENT_TIERS\.map\(\(t\) => `<div class="inv-group/.test(hud),
     'the strip builds one inv-group per content tier');
  ok(!/\bTIER_ORDER\b/.test(hud), 'and the HUD does not reach for the palette list at all');

  // The grid drops a tier it cannot name, so the membership claim above is only
  // worth what the filter itself is: prove it keeps an argent card.
  const held = new Map([['argent', [{ id: 'x', tier: 'argent', count: 1 }]],
                        ['common', [{ id: 'y', tier: 'common', count: 1 }]]]);
  const shown = CONTENT_TIERS.filter((t) => held.get(t)?.length);
  ok(shown.includes('argent'), `an argent haul survives the filter (${shown.join(', ')})`);
  ok(shown.length === 2, 'alongside the whites');
}

console.log('and the stylesheet has somewhere to paint it');
{
  const css = src('../src/ui/hud.css');
  const m = css.match(/--t-argent:\s*(#[0-9a-f]{6})/i);
  ok(!!m, `hud.css declares --t-argent (${m?.[1]})`);
  ok(m?.[1]?.toLowerCase() === TIERS.argent.color, 'and it agrees with Icons.js');
  ok(/\.t-argent\s*\{[^}]*--tc:\s*var\(--t-argent\)/.test(css), '.t-argent relays it as --tc');
  // Every argent card the pool ships can be drawn as a plate.
  for (const def of ITEMS_BY_TIER.argent || []) {
    ok(ITEM_BY_ID.get(def.id)?.tier === 'argent', `${def.id} is an argent card`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
