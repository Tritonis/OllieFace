/**
 * Id rename — the Risk of Rain 2 vocabulary leaves the code, saves survive.
 *
 *   node tests/item-id-migration.test.mjs
 *
 * Round 6 renamed fifty RoR2 display strings and ruled ids out of scope
 * because an id is written into save data. Round 7 took the ids
 * (`reviews/round7/FIX-ror2-ids.md`): thirty-nine item ids, six enemy ids and
 * the three difficulty rungs.
 *
 * Ids reach save data in six places — the profile's unlock map, its encounter
 * log under `item`, `enemy` and `boss`, the inventory rows of every recorded
 * run, and the artifact store's Command edict and remembered rung. This file
 * pins all six, plus the property that makes the rename safe to apply at all:
 * the roll pools are positional, so a card's id has no bearing on what
 * `rollItem` draws and the determinism baselines cannot move. The index
 * assertions are the guard on that claim — if a future edit reorders `ITEMS`,
 * this fails and the baselines are genuinely in question.
 *
 * Both storage paths land here. In the browser `localStorage` is the store; on
 * the desktop `DesktopStore` copies the save file into `localStorage` at boot
 * and every read afterwards is the same read. There is one hydrate point and
 * this is the migration behind it.
 */
import { ITEMS, ITEMS_BY_TIER, ITEM_BY_ID } from '../src/data/items.js';
import { ENEMIES, ENEMY_BY_ID } from '../src/data/enemies.js';
import { DIFFICULTY_BY_ID } from '../src/data/artifacts.js';
import {
  RENAMED_ITEM_IDS, RENAMED_ENEMY_IDS, RENAMED_DIFFICULTY_IDS,
  renameItemId, renameEnemyId, renameDifficultyId,
} from '../src/data/renamedIds.js';
import { Profile, PROFILE_VERSION } from '../src/systems/Profile.js';
import { Artifacts } from '../src/systems/Artifacts.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const OLD_PLUME = 'hopoo-feather', NEW_PLUME = 'hollow-plume';
const OLD_BAND = 'shatterspleen', NEW_BAND = 'hoarfrost-band';
const OLD_SYRINGE = 'syringe', NEW_SYRINGE = 'adrenal-syringe';
const OLD_GOLEM = 'golem', NEW_GOLEM = 'sentinel';
const OLD_TITAN = 'titan', NEW_TITAN = 'colossus';

console.log('the catalogues no longer carry the borrowed ids');
{
  const itemIds = ITEMS.map((i) => i.id);
  const enemyIds = ENEMIES.map((e) => e.id);
  ok(new Set(itemIds).size === itemIds.length, 'item ids are still unique');
  ok(new Set(enemyIds).size === enemyIds.length, 'enemy ids are still unique');

  // The tables are the enumeration. Every entry must name a departed id on the
  // left and a live one on the right, which is what makes "nothing was left
  // behind" checkable rather than asserted.
  for (const [table, has, label] of [
    [RENAMED_ITEM_IDS, (id) => ITEM_BY_ID.has(id), 'item'],
    [RENAMED_ENEMY_IDS, (id) => ENEMY_BY_ID.has(id), 'enemy'],
    [RENAMED_DIFFICULTY_IDS, (id) => DIFFICULTY_BY_ID.has(id), 'difficulty'],
  ]) {
    for (const [from, to] of Object.entries(table)) {
      // Nothing may map onto a live id other than its own replacement, or the
      // migration would merge two players' unrelated records together.
      ok(!has(from), `${label} ${from} is not also a live id`);
      ok(has(to), `${label} ${to} is a live id`);
    }
  }
  ok(Object.keys(RENAMED_ITEM_IDS).length === 39, 'thirty-nine item ids moved');
  ok(Object.keys(RENAMED_ENEMY_IDS).length === 6, 'six enemy ids moved');
  ok(Object.keys(RENAMED_DIFFICULTY_IDS).length === 3, 'all three rungs moved');

  // Display names were already original and must not have moved with the ids.
  ok(ITEM_BY_ID.get(NEW_PLUME).name === 'Hollow Plume', 'Hollow Plume still displays as itself');
  ok(ITEM_BY_ID.get(NEW_SYRINGE).name === 'Adrenal Syringe', 'Adrenal Syringe still displays as itself');
  ok(ENEMY_BY_ID.get(NEW_GOLEM).name === 'Basalt Sentinel', 'the Basalt Sentinel still displays as itself');
  ok(DIFFICULTY_BY_ID.get('fracture').name === 'Fracture', 'the middle rung still displays as itself');
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
  // 108 through the rename; 113 since the five argent cards (plan §5). They sit
  // after the blight block and before Common, so every index this test pins is
  // ahead of them and none of the pinned pool positions moved.
  ok(ITEMS.length === 113, 'the catalogue is 113 cards');
  // The same argument for the wire: a snapshot carries `typeId`, which is the
  // enemy's index in `ENEMIES` and not its id.
  ok(ENEMY_BY_ID.get(NEW_GOLEM).typeId === ENEMIES.findIndex((e) => e.id === NEW_GOLEM) + 1,
     'typeId is still the array index, so no snapshot byte moved');
}

console.log('the rename tables translate, pass through and repeat safely');
{
  ok(renameItemId(OLD_PLUME) === NEW_PLUME, `${OLD_PLUME} -> ${NEW_PLUME}`);
  ok(renameItemId(OLD_SYRINGE) === NEW_SYRINGE, `${OLD_SYRINGE} -> ${NEW_SYRINGE}`);
  ok(renameEnemyId(OLD_GOLEM) === NEW_GOLEM, `${OLD_GOLEM} -> ${NEW_GOLEM}`);
  ok(renameDifficultyId('monsoon') === 'cataclysm', 'monsoon -> cataclysm');
  ok(renameItemId('emberwake') === 'emberwake', 'an untouched item id passes through');
  ok(renameEnemyId('mite') === 'mite', 'an untouched enemy id passes through');
  ok(renameItemId(NEW_PLUME) === NEW_PLUME, 'and translation is idempotent on an already-new id');
  ok(renameEnemyId(NEW_GOLEM) === NEW_GOLEM, 'for enemies too');
  ok(renameItemId('') === '', 'an empty id is not invented into something');
  ok(renameItemId(undefined) === undefined, 'and neither is a missing one');
  // The three tables are separate namespaces on purpose: a difficulty rung and
  // a realm are both called `fracture`, and an id must not be translated by
  // the wrong table.
  ok(renameItemId(OLD_GOLEM) === OLD_GOLEM, 'the item table does not translate an enemy id');
  ok(renameEnemyId(OLD_SYRINGE) === OLD_SYRINGE, 'and the enemy table does not translate an item id');
}

// The migration runs behind `_migrate` + `_coerce`, which is exactly the pair
// `importProfile` and `_load` both go through. Calling them directly keeps the
// test off `localStorage`, which does not exist here.
const migrate = (blob) => { const p = new Profile(); return p._coerce(p._migrate(blob)); };

/** A profile at `version`, carrying an old id everywhere a save can carry one. */
const oldBlob = (version) => ({
  version,
  createdAt: 1000, updatedAt: 2000,
  unlocks: {
    survivor: {},
    item: { [OLD_PLUME]: 111, [OLD_SYRINGE]: 222, emberwake: 333 },
    equipment: {}, artifact: {}, skin: {},
  },
  challenges: {},
  encounters: {
    item: { [OLD_PLUME]: { at: 111, count: 7 }, [OLD_SYRINGE]: { at: 222, count: 3 }, emberwake: { at: 333, count: 1 } },
    enemy: { [OLD_GOLEM]: { at: 400, count: 412 }, mite: { at: 401, count: 9 } },
    boss: { [OLD_TITAN]: { at: 500, count: 4 } },
    equipment: {}, survivor: {},
  },
  survivors: { ranger: { runs: 3, wins: 1, deaths: 2, kills: 90, time: 600, bestStage: 5, bestTime: 300 } },
  runs: [{
    at: 5000, survivorId: 'ranger', outcome: 'victory',
    inventory: [{ id: OLD_PLUME, count: 4 }, { id: 'emberwake', count: 2 }, { id: OLD_SYRINGE, count: 1 }],
  }],
});

for (const from of [2, 3]) {
  console.log(`a v${from} profile is carried onto the new ids, with nothing dropped`);
  const p = migrate(oldBlob(from));
  ok(p.version === PROFILE_VERSION, `migrates up to v${PROFILE_VERSION}`);

  ok(p.unlocks.item[NEW_PLUME] === 111, 'the plume unlock keeps its timestamp under the new id');
  ok(p.unlocks.item[NEW_SYRINGE] === 222, 'the syringe unlock keeps its timestamp under the new id');
  ok(p.unlocks.item[OLD_PLUME] === undefined && p.unlocks.item[OLD_SYRINGE] === undefined,
     'and no old unlock key is left behind');
  ok(p.unlocks.item.emberwake === 333, 'an untouched unlock is untouched');
  ok(Object.keys(p.unlocks.item).length === 3, 'three unlocks in, three unlocks out');

  ok(p.encounters.item[NEW_PLUME]?.count === 7 && p.encounters.item[NEW_PLUME]?.at === 111,
     'the plume encounter keeps its count and its first-seen stamp');
  ok(p.encounters.item[NEW_SYRINGE]?.count === 3, 'and the syringe its count');
  ok(p.encounters.item.emberwake?.count === 1, 'an untouched encounter is untouched');
  ok(Object.keys(p.encounters.item).length === 3, 'three item encounters in, three out');

  ok(p.encounters.enemy[NEW_GOLEM]?.count === 412, 'you have still killed 412 Basalt Sentinels');
  ok(p.encounters.enemy[NEW_GOLEM]?.at === 400, 'and still met your first one when you did');
  ok(p.encounters.enemy[OLD_GOLEM] === undefined, 'the old enemy key is gone');
  ok(p.encounters.enemy.mite?.count === 9, 'an untouched enemy encounter is untouched');
  ok(p.encounters.boss[NEW_TITAN]?.count === 4, 'the boss log moved too');
  ok(p.encounters.boss[OLD_TITAN] === undefined, 'and left no old boss key');

  const inv = p.runs[0].inventory;
  ok(inv.find((i) => i.id === NEW_PLUME)?.count === 4, 'the recorded run still shows 4 plumes');
  ok(inv.find((i) => i.id === NEW_SYRINGE)?.count === 1, 'and 1 syringe');
  ok(inv.find((i) => i.id === 'emberwake')?.count === 2, 'and 2 of the untouched item');
  ok(!inv.some((i) => i.id === OLD_PLUME || i.id === OLD_SYRINGE), 'no old id is left in the inventory');
  ok(inv.length === 3, 'and no row was dropped or duplicated');

  ok(p.survivors.ranger?.kills === 90, 'the per-survivor career is untouched');
  ok(p.runs[0].survivorId === 'ranger' && p.runs[0].outcome === 'victory', 'and the run record itself');
}

console.log('a profile holding both ids merges rather than clobbers');
{
  // Not reachable from this build, but an imported blob is arbitrary and the
  // resolution has to be defined: counts add, the earlier first-seen wins,
  // and the earlier unlock wins, matching how the cross-tab merge joins them.
  const blob = oldBlob(3);
  blob.unlocks.item[NEW_PLUME] = 90;
  blob.encounters.item[NEW_PLUME] = { at: 90, count: 5 };
  blob.encounters.enemy[NEW_GOLEM] = { at: 350, count: 8 };
  blob.runs[0].inventory.push({ id: NEW_PLUME, count: 6 });
  const p = migrate(blob);
  ok(p.unlocks.item[NEW_PLUME] === 90, 'the earlier unlock stamp wins');
  ok(p.encounters.item[NEW_PLUME]?.count === 12, 'encounter counts add (7 + 5)');
  ok(p.encounters.item[NEW_PLUME]?.at === 90, 'the earlier first-seen stamp wins');
  ok(p.encounters.enemy[NEW_GOLEM]?.count === 420, 'enemy counts add too (412 + 8)');
  ok(p.encounters.enemy[NEW_GOLEM]?.at === 350, 'and take the earlier stamp');
  const rows = p.runs[0].inventory.filter((i) => i.id === NEW_PLUME);
  ok(rows.length === 1, 'the inventory keeps one row for the id');
  ok(rows[0].count === 10, 'and its counts add (4 + 6)');
}

console.log('migrating is safe to repeat and safe on nothing');
{
  const once = migrate(oldBlob(2));
  const twice = migrate(JSON.parse(JSON.stringify(once)));
  ok(JSON.stringify(twice.unlocks.item) === JSON.stringify(once.unlocks.item), 'a migrated profile is not re-migrated');
  ok(twice.encounters.item[NEW_PLUME]?.count === 7, 'and its item counts are not doubled');
  ok(twice.encounters.enemy[NEW_GOLEM]?.count === 412, 'nor its enemy counts');

  for (const junk of [{}, { version: 2 }, { version: 3 },
    { version: 2, encounters: null, unlocks: 'no', runs: 'no' },
    { version: 3, encounters: { item: null, enemy: 'no', boss: 7 }, unlocks: { item: 5 }, runs: [null, 3] }]) {
    let threw = null;
    try { migrate(junk); } catch (e) { threw = e; }
    ok(threw === null, `${JSON.stringify(junk)} migrates without throwing`);
  }
  const empty = migrate({ version: 2 });
  ok(Object.keys(empty.encounters.item).length === 0, 'an empty profile stays empty');
  ok(Object.keys(empty.encounters.enemy).length === 0, 'in both kinds');
}

console.log('the artifact store carries the edict and the rung onto the new ids');
{
  // `telluric.run.v1` holds `difficulty` and `edict: { tier: itemId }`. A stale
  // id in either is a silent loss: the rung falls back to the default because
  // `_load` validates it, and the edict is a Command pick that stops working.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const map = new Map([['telluric.run.v1', JSON.stringify({
    artifacts: [], difficulty: 'monsoon',
    edict: { uncommon: OLD_BAND, common: OLD_SYRINGE, legendary: 'emberwake' },
  })]]);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  try {
    const a = new Artifacts();
    a._load();
    ok(a.difficultyId === 'cataclysm', 'the remembered rung moved to the new id rather than resetting');
    ok(a.edictFor('uncommon') === NEW_BAND, 'the band edict moved to the new id');
    ok(a.edictFor('common') === NEW_SYRINGE, 'the syringe edict moved to the new id');
    ok(a.edictFor('legendary') === 'emberwake', 'an untouched edict is untouched');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
