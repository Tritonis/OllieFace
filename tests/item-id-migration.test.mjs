/**
 * Item id rename — `hopoo-feather`/`shatterspleen` leave, saves survive.
 *
 *   node tests/item-id-migration.test.mjs
 *
 * Two ids were themselves the Risk of Rain 2 vocabulary the round-6 branding
 * ledger renamed *around*: the cards already displayed "Hollow Plume" and
 * "Hoarfrost Band", but the ids under them still said `hopoo-feather` and
 * `shatterspleen`, and the ledger deferred them because ids reach save data.
 *
 * Ids reach save data in four places — the profile's unlock map, its encounter
 * log, the inventory rows of every recorded run, and the artifact store's
 * Command edict. This file pins all four, plus the property that makes the
 * rename safe to apply at all: the roll pools are positional, so a card's id
 * has no bearing on what `rollItem` draws and the determinism baselines cannot
 * move. The index assertions are the guard on that claim — if a future edit
 * reorders `ITEMS`, this fails and the baselines are genuinely in question.
 */
import { ITEMS, ITEMS_BY_TIER, ITEM_BY_ID } from '../src/data/items.js';
import { RENAMED_ITEM_IDS, renameItemId } from '../src/data/renamedItems.js';
import { Profile, PROFILE_VERSION } from '../src/systems/Profile.js';
import { Artifacts } from '../src/systems/Artifacts.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const OLD_PLUME = 'hopoo-feather', NEW_PLUME = 'hollow-plume';
const OLD_BAND = 'shatterspleen', NEW_BAND = 'hoarfrost-band';

console.log('the catalogue no longer carries the borrowed ids');
{
  const ids = ITEMS.map((i) => i.id);
  ok(!ids.includes(OLD_PLUME), `${OLD_PLUME} is gone`);
  ok(!ids.includes(OLD_BAND), `${OLD_BAND} is gone`);
  ok(ITEM_BY_ID.has(NEW_PLUME), `${NEW_PLUME} is the id now`);
  ok(ITEM_BY_ID.has(NEW_BAND), `${NEW_BAND} is the id now`);
  ok(new Set(ids).size === ids.length, 'ids are still unique');
  // Display names were already original and must not have moved with the ids.
  ok(ITEM_BY_ID.get(NEW_PLUME).name === 'Hollow Plume', 'Hollow Plume still displays as itself');
  ok(ITEM_BY_ID.get(NEW_BAND).name === 'Hoarfrost Band', 'Hoarfrost Band still displays as itself');
}

console.log('the roll pool did not move — this is what keeps the baselines valid');
{
  // `rollItem` is `rng.pick(ITEMS_BY_TIER[tier]).id`: a positional draw from an
  // array built in source order. Renaming a card's id changes nothing about
  // which slot it occupies, so no seed, no draw and no fingerprint moves. These
  // pinned indices are that argument made falsifiable.
  const u = ITEMS_BY_TIER.uncommon;
  ok(u.length === 31, 'the uncommon pool is still 31 cards');
  ok(u[4]?.id === NEW_BAND, 'Hoarfrost Band is still the 5th uncommon');
  ok(u[10]?.id === NEW_PLUME, 'Hollow Plume is still the 11th uncommon');
  ok(ITEMS.length === 108, 'the catalogue is still 108 cards');
}

console.log('the rename table');
{
  ok(RENAMED_ITEM_IDS[OLD_PLUME] === NEW_PLUME, `${OLD_PLUME} -> ${NEW_PLUME}`);
  ok(RENAMED_ITEM_IDS[OLD_BAND] === NEW_BAND, `${OLD_BAND} -> ${NEW_BAND}`);
  ok(renameItemId(OLD_PLUME) === NEW_PLUME, 'renameItemId translates a renamed id');
  ok(renameItemId('feeding-vial') === 'feeding-vial', 'and passes an untouched id through');
  ok(renameItemId(NEW_PLUME) === NEW_PLUME, 'and is idempotent on an already-new id');
  ok(renameItemId('') === '', 'an empty id is not invented into something');
  // Nothing may map onto a live id other than its own replacement, or the
  // migration would merge two players' unrelated records together.
  for (const [from, to] of Object.entries(RENAMED_ITEM_IDS)) {
    ok(!ITEM_BY_ID.has(from), `${from} is not also a live id`);
    ok(ITEM_BY_ID.has(to), `${to} is a live id`);
  }
}

// The migration runs behind `_migrate` + `_coerce`, which is exactly the pair
// `importProfile` and `_load` both go through. Calling them directly keeps the
// test off `localStorage`, which does not exist here.
const migrate = (blob) => { const p = new Profile(); return p._coerce(p._migrate(blob)); };

/** A v2 profile carrying both old ids everywhere a save can carry one. */
const v2Blob = () => ({
  version: 2,
  createdAt: 1000, updatedAt: 2000,
  unlocks: { survivor: {}, item: { [OLD_PLUME]: 111, [OLD_BAND]: 222, infusion: 333 }, equipment: {}, artifact: {}, skin: {} },
  challenges: {},
  encounters: {
    item: { [OLD_PLUME]: { at: 111, count: 7 }, [OLD_BAND]: { at: 222, count: 3 }, infusion: { at: 333, count: 1 } },
    equipment: {}, enemy: {}, boss: {}, survivor: {},
  },
  survivors: {},
  runs: [{
    at: 5000, survivorId: 'commando', outcome: 'victory',
    inventory: [{ id: OLD_PLUME, count: 4 }, { id: 'feeding-vial', count: 2 }, { id: OLD_BAND, count: 1 }],
  }],
});

console.log('a v2 profile is carried onto the new ids');
{
  const p = migrate(v2Blob());
  ok(p.version === PROFILE_VERSION, `migrates up to v${PROFILE_VERSION}`);

  ok(p.unlocks.item[NEW_PLUME] === 111, 'the plume unlock keeps its timestamp under the new id');
  ok(p.unlocks.item[NEW_BAND] === 222, 'the band unlock keeps its timestamp under the new id');
  ok(p.unlocks.item[OLD_PLUME] === undefined, 'the old plume unlock key is gone');
  ok(p.unlocks.item[OLD_BAND] === undefined, 'the old band unlock key is gone');
  ok(p.unlocks.item.infusion === 333, 'an untouched unlock is untouched');

  ok(p.encounters.item[NEW_PLUME]?.count === 7, 'the plume encounter count survives');
  ok(p.encounters.item[NEW_PLUME]?.at === 111, 'and its first-seen stamp');
  ok(p.encounters.item[NEW_BAND]?.count === 3, 'the band encounter count survives');
  ok(p.encounters.item[OLD_PLUME] === undefined, 'the old plume encounter key is gone');
  ok(p.encounters.item[OLD_BAND] === undefined, 'the old band encounter key is gone');
  ok(p.encounters.item.infusion?.count === 1, 'an untouched encounter is untouched');

  const inv = p.runs[0].inventory;
  ok(inv.find((i) => i.id === NEW_PLUME)?.count === 4, 'the recorded run still shows 4 plumes');
  ok(inv.find((i) => i.id === NEW_BAND)?.count === 1, 'and 1 band');
  ok(inv.find((i) => i.id === 'feeding-vial')?.count === 2, 'and 2 of the untouched item');
  ok(!inv.some((i) => i.id === OLD_PLUME || i.id === OLD_BAND), 'no old id is left in the inventory');
  ok(inv.length === 3, 'and no row was dropped or duplicated');
}

console.log('a profile holding both ids merges rather than clobbers');
{
  // Not reachable from this build, but an imported blob is arbitrary and the
  // resolution has to be defined: counts add, the earlier first-seen wins,
  // and the earlier unlock wins, matching how the cross-tab merge joins them.
  const blob = v2Blob();
  blob.unlocks.item[NEW_PLUME] = 90;
  blob.encounters.item[NEW_PLUME] = { at: 90, count: 5 };
  blob.runs[0].inventory.push({ id: NEW_PLUME, count: 6 });
  const p = migrate(blob);
  ok(p.unlocks.item[NEW_PLUME] === 90, 'the earlier unlock stamp wins');
  ok(p.encounters.item[NEW_PLUME].count === 12, 'encounter counts add (7 + 5)');
  ok(p.encounters.item[NEW_PLUME].at === 90, 'the earlier first-seen stamp wins');
  const rows = p.runs[0].inventory.filter((i) => i.id === NEW_PLUME);
  ok(rows.length === 1, 'the inventory keeps one row for the id');
  ok(rows[0].count === 10, 'and its counts add (4 + 6)');
}

console.log('migrating is safe to repeat and safe on nothing');
{
  const once = migrate(v2Blob());
  const twice = migrate(JSON.parse(JSON.stringify(once)));
  ok(JSON.stringify(twice.unlocks.item) === JSON.stringify(once.unlocks.item), 'a migrated profile is not re-migrated');
  ok(twice.encounters.item[NEW_PLUME].count === 7, 'and its counts are not doubled');

  for (const junk of [{}, { version: 2 }, { version: 2, encounters: null, unlocks: 'no', runs: 'no' },
    { version: 2, encounters: { item: null }, unlocks: { item: 5 }, runs: [null, 3] }]) {
    let threw = null;
    try { migrate(junk); } catch (e) { threw = e; }
    ok(threw === null, `${JSON.stringify(junk)} migrates without throwing`);
  }
  const empty = migrate({ version: 2 });
  ok(Object.keys(empty.encounters.item).length === 0, 'an empty profile stays empty');
}

console.log('the artifact store carries a Command edict onto the new id');
{
  // `telluric.run.v1` holds `edict: { tier: itemId }` — the item Command will
  // hand out next run. A stale id there is a pick that silently stops working.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const map = new Map([['telluric.run.v1', JSON.stringify({
    artifacts: [], difficulty: 'normal',
    edict: { uncommon: OLD_BAND, common: 'adrenal-syringe', legendary: OLD_PLUME },
  })]]);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  try {
    const a = new Artifacts();
    a._load();
    ok(a.edictFor('uncommon') === NEW_BAND, 'the band edict moved to the new id');
    ok(a.edictFor('legendary') === NEW_PLUME, 'the plume edict moved to the new id');
    ok(a.edictFor('common') === 'adrenal-syringe', 'an untouched edict is untouched');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
