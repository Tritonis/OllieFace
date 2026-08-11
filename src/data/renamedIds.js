/**
 * Ids that changed name, and the translation every save read goes through.
 *
 * The round-6 branding pass (`reviews/round6/BRANDING-LEDGER.md`) renamed the
 * *display* names of every borrowed Risk of Rain 2 noun and deliberately left
 * the ids alone, because an id is written into save data and a rename without a
 * migration is a save wipe. Round 7 (`reviews/round7/FIX-ror2-ids.md`) took the
 * ids, and this is the table that lets a save written before it still load.
 *
 * Three of the four id kinds a save can carry moved:
 *
 *  - **items** — the profile's unlock map, its encounter log, the inventory
 *    rows of every recorded run, and the artifact store's Command edict.
 *  - **enemies** — the encounter log's `enemy` and `boss` kinds, which is what
 *    the logbook draws "you have killed 412 Basalt Sentinels" from.
 *  - **difficulties** — the artifact store's remembered rung. This one fails
 *    quietly rather than loudly: `Artifacts._load` validates against
 *    `DIFFICULTY_BY_ID` and an unrecognised rung is silently replaced by the
 *    default, so without this table a returning player's Cataclysm run starts
 *    on Fracture and nothing says why.
 *
 * The fourth kind — elite affixes — reaches no save. `ELITE_STATS` keys appear
 * in live entity state and in probe output only; the profile counts elites, it
 * does not name them. Realm ids likewise: `bazaar` became `market` and no
 * persisted field has ever held one.
 *
 * A file of its own, holding no more than the tables: `Profile` and `Artifacts`
 * both need it and neither may import a content catalogue. `Artifacts`
 * especially — it stores a Command edict without ever validating it against the
 * item table, and pulling in `data/items.js` to translate a string would put
 * the whole catalogue in a module that has managed without it.
 *
 * Entries are permanent. A save written five years ago is still a save, and the
 * cost of an entry is one property on an object read at boot.
 */

/**
 * Item ids. The first two went in round 6's own follow-up — `hopoo-feather`
 * names RoR2's developer and `shatterspleen` is a verbatim RoR2 item — and the
 * rest went in round 7, where each new id is the display name the branding pass
 * had already given the card above it.
 */
export const RENAMED_ITEM_IDS = {
  'hopoo-feather': 'hollow-plume',
  shatterspleen: 'hoarfrost-band',

  syringe: 'adrenal-syringe',
  hoof: 'cloven-hoof',
  steak: 'cured-haunch',
  'roll-of-pennies': 'bruised-coinpurse',
  'tougher-times': 'dented-buckler',
  'armor-plate': 'trauma-plate',
  crowbar: 'pry-bar',
  predatory: 'bloodscent',
  glasses: 'gunsmiths-loupe',
  'sticky-bomb': 'tar-charge',
  gasoline: 'leaking-jerrycan',
  'monster-tooth': 'marrow-tooth',
  'topaz-brooch': 'amber-clasp',
  medkit: 'stitch-kit',
  ukulele: 'cracked-zither',
  atg: 'missile-rack',
  'tri-tip': 'gutting-shiv',
  'stun-grenade': 'concussion-charge',
  infusion: 'feeding-vial',
  'harvesters-scythe': 'reaping-hook',
  'leeching-seed': 'thirsting-burr',
  afterburner: 'bailout-thrusters',
  'wax-quail': 'waxed-wing',
  'will-o-wisp': 'corpse-flare',
  'fuel-cell': 'dry-cell',
  'berzerkers-pauldron': 'red-mist-pauldron',
  'razor-wire': 'barb-snare',
  behemoth: 'shrapnel-heart',
  clover: 'pressed-clover',
  'alien-head': 'cortex-jar',
  'frost-relic': 'killing-frost',
  'ceremonial-dagger': 'mourners-dagger',
  brainstalks: 'whisper-stalks',
  'titanic-knurl': 'monolith-knuckle',
  planula: 'grafted-polyp',
  'queens-gland': 'hive-gland',
  'corpse-bloom': 'charnel-bloom',
};

/** Enemy ids, from the same source: the card's own round-6 display name. */
export const RENAMED_ENEMY_IDS = {
  beetle: 'scarab',        // Plated Scarab
  lemurian: 'skink',       // Emberjaw Skink
  wisp: 'mote',            // Guttering Mote
  pest: 'shrike',          // Blind Shrike
  golem: 'sentinel',       // Basalt Sentinel
  titan: 'colossus',       // Basalt Colossus
};

/**
 * Difficulty rungs. The new ids are the `mark` values the branding pass already
 * put on these cards, so the id, the mark and the display name are one word.
 */
export const RENAMED_DIFFICULTY_IDS = {
  drizzle: 'settling',
  rainstorm: 'fracture',
  monsoon: 'cataclysm',
};

/**
 * The current id for whatever a save calls it.
 *
 * Unknown ids pass through untouched rather than being dropped: an id this
 * build does not recognise may belong to a newer build, or to content a
 * downstream fork added, and every reader that consumes one already validates
 * against the live table.
 */
const translator = (table) => (id) => (typeof id === 'string' && table[id]) || id;

export const renameItemId = translator(RENAMED_ITEM_IDS);
export const renameEnemyId = translator(RENAMED_ENEMY_IDS);
export const renameDifficultyId = translator(RENAMED_DIFFICULTY_IDS);
