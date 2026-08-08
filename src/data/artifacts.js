/**
 * Artifacts and difficulties — the run's rules, chosen before it starts.
 *
 * ## Artifact card shape
 *
 * ```js
 * {
 *   id,          // stable string; persisted and packed onto the wire, never rename
 *   name,        // player-facing title
 *   description, // what it does, in the player's words
 *   mark,        // key into `ui/Icons.js`'s MARKS — an authored vector, never
 *                // a text codepoint. This field used to hold a raw Unicode
 *                // dingbat, which had no glyph in the UI's font stack and so
 *                // rendered from whatever symbol font the OS supplied — at a
 *                // fallback font's metrics, which knocked the card grid's
 *                // titles onto three different baselines.
 *   unlock,      // challenge id from `data/challenges.js`, or null for always-on
 *   color,       // accent for the select grid
 *   flavour,     // one line of colour for the tooltip
 * }
 * ```
 *
 * The ids read like the genre's vocabulary (`command`, `swarms`, `glass`) because
 * they are *code* — every consultation point in the codebase is a literal
 * `has('swarms')` and a cute id there costs a reader a lookup every time. The
 * names and descriptions are ours.
 *
 * ## Where each one actually does something
 *
 * Nothing in this file has behaviour. Artifacts do not reach into other systems;
 * the other systems ask. Each card's effect lives at the consultation point
 * named below, and `systems/Artifacts.js` only answers questions.
 *
 * | id | consulted by |
 * |---|---|
 * | `command`   | `Items.rollItem` — the item is chosen, not rolled |
 * | `sacrifice` | `Items.rewardKill` (drops) + `Interactables.populate` (no chests/shops) |
 * | `swarms`    | `Director.populationCap`, `Director.spendCredits`, `Director.spawnOne` |
 * | `glass`     | `Items.stats` via `runMods()` |
 * | `caprice`   | `Items.rollItem` — the *tier* is re-rolled first |
 * | `honour`    | `Director.spendCredits` (forced affix) + `Director.spawnOne` |
 * | `evolution` | `Director.spawnOne` via `monsterScale()` |
 * | `maw`       | `Corruption.feed` via `corruptionMods()` |
 * | `atonement` | `Corruption.feed` + the Voidtouched-kill refund, via `corruptionMods()` |
 *
 * `unlock` must name the challenge that `UNLOCK_BINDINGS` binds to this same id.
 * `Artifacts.init` cross-checks the two and warns if they ever drift — one of
 * them being wrong silently deletes an artifact from the game.
 */

export const ARTIFACTS = [
  {
    id: 'command',
    name: 'Artifact of the Edict',
    description: 'You choose what you find. Every item drop resolves to a pick '
      + 'instead of a roll — by default, whatever you already hold most of in '
      + 'that tier.',
    flavour: 'The chest does not decide. You do.',
    mark: 'command',
    color: '#7fd4ff',
    unlock: 'hoarder',
  },
  {
    id: 'sacrifice',
    name: 'Artifact of the Tithe',
    description: 'Chests and terminals are gone from every stage. Monsters carry '
      + 'the loot instead, and drop it when they fall.',
    flavour: 'Nothing is bought. Everything is taken.',
    mark: 'sacrifice',
    color: '#e9e46b',
    unlock: 'richBeyondReason',
  },
  {
    id: 'swarms',
    name: 'Artifact of the Spate',
    description: 'Twice as many monsters arrive, with half the health each. The '
      + 'population ceiling doubles with them.',
    flavour: 'One at a time was never the arrangement.',
    mark: 'swarms',
    color: '#ff7a45',
    unlock: 'thousandCuts',
  },
  {
    id: 'glass',
    name: 'Artifact of the Filament',
    description: 'You deal five times damage and keep a tenth of your health. '
      + 'Everything dies in one hit, including you.',
    flavour: 'Drawn out thin enough, anything cuts.',
    mark: 'glass',
    color: '#ff4634',
    unlock: 'oneShot',
  },
  {
    id: 'caprice',
    name: 'Artifact of Caprice',
    description: 'Every drop forgets what it came out of. A wooden chest can pay '
      + 'a legendary; a legendary can pay a lunar.',
    flavour: 'The label was never load-bearing.',
    mark: 'caprice',
    color: '#b44dff',
    unlock: 'theLongHaul',
  },
  {
    id: 'honour',
    name: 'Artifact of Regalia',
    description: 'Every monster spawns with an elite affix. They cost the '
      + 'director far less and arrive at half health, but nothing is ever plain '
      + 'again.',
    flavour: 'A field of crowns, and not one of them yours.',
    mark: 'honour',
    color: '#ffb44f',
    unlock: 'eliteHunter',
  },
  {
    id: 'evolution',
    name: 'Artifact of Mimicry',
    description: 'Monsters learn from your inventory. Every item you hold makes '
      + 'the whole bestiary tougher and hit harder, for the rest of the run.',
    flavour: 'They have been watching what you pick up.',
    mark: 'evolution',
    color: '#8ef08a',
    unlock: 'bossSlayer',
  },
  {
    id: 'maw',
    name: 'Artifact of the Maw',
    description: 'The world corrupts twice as fast. Every greed act — every '
      + 'chest, item, shrine and credit — feeds the gauge double.',
    flavour: 'It was always hungry. You just started shovelling.',
    mark: 'maw',
    color: '#c72fd6',
    unlock: null,
  },
  {
    id: 'atonement',
    name: 'Artifact of Atonement',
    description: 'Hollowed kills return five times the corruption, but every '
      + 'greed act feeds a quarter more. The debt can be worked off; the '
      + 'interest cannot.',
    flavour: 'The void keeps a ledger, and it accepts payment in kind.',
    mark: 'atonement',
    color: '#9fd4ff',
    unlock: null,
  },
];

export const ARTIFACT_BY_ID = new Map(ARTIFACTS.map((a) => [a.id, a]));

/**
 * Tiers Caprice draws from, and how often.
 *
 * Deliberately not `Items.TIER_WEIGHTS`: that ladder is the *chest* ladder,
 * where legendary is a 1-in-80 event. Caprice re-rolling onto the same ladder
 * would be almost indistinguishable from no artifact at all. This is a flat-ish
 * table with the two opt-in tiers (boss, lunar) present but rare, so a common
 * chest paying a legendary is a real and frequent event — which is the whole
 * point of the card.
 */
export const CAPRICE_TIERS = [
  { tier: 'common', weight: 32 },
  { tier: 'uncommon', weight: 30 },
  { tier: 'legendary', weight: 22 },
  { tier: 'boss', weight: 10 },
  { tier: 'lunar', weight: 6 },
];

// ---------------------------------------------------------------------------
// difficulty
// ---------------------------------------------------------------------------

/**
 * Difficulty cards.
 *
 * `coeff` multiplies the Director's existing time term — it does **not** replace
 * the curve. That is the same lever RoR2 pulls: the per-player and per-stage
 * factors are untouched, so the run still ramps for the same reasons, just
 * faster or slower on the clock. Downpour is 1.0 by definition, which is why
 * `Director.DIFFICULTY_SCALE` is still the tuned constant it always was and
 * every existing pacing measurement remains the Downpour measurement.
 *
 * The other four numbers are the quality-of-life half. RoR2's easy mode is not
 * only a slower clock — monsters hit softer and you recover faster, which is
 * what makes it a different *game* rather than the same game later. Deluge
 * takes the same three away.
 *
 * | | coeff | enemy hp | enemy dmg | gold | your regen |
 * |---|---|---|---|---|---|
 * | Settling  | 0.5 | 0.80 | 0.60 | 1.20 | 2.0 |
 * | Fracture  | 1.0 | 1.00 | 1.00 | 1.00 | 1.0 |
 * | Cataclysm | 1.5 | 1.20 | 1.40 | 0.90 | 0.5 |
 */
export const DIFFICULTIES = [
  {
    id: 'drizzle',
    name: 'Settling',
    index: 0,
    coeff: 0.5,
    description: 'A forgiving run. The clock climbs at half speed, monsters hit '
      + 'softer, gold is plentiful and you mend quickly.',
    mark: 'settling',
    color: '#7fd4ff',
    enemyHealth: 0.8,
    enemyDamage: 0.6,
    gold: 1.2,
    regen: 2.0,
  },
  {
    id: 'rainstorm',
    name: 'Fracture',
    index: 1,
    coeff: 1.0,
    description: 'The intended run. Every number in the game is the tuned one.',
    mark: 'fracture',
    color: '#8ef08a',
    enemyHealth: 1,
    enemyDamage: 1,
    gold: 1,
    regen: 1,
  },
  {
    id: 'monsoon',
    name: 'Cataclysm',
    index: 2,
    coeff: 1.5,
    description: 'A punishing run. The clock climbs half again as fast, monsters '
      + 'are tougher and hit far harder, and you heal at half rate.',
    mark: 'cataclysm',
    color: '#ff4634',
    enemyHealth: 1.2,
    enemyDamage: 1.4,
    gold: 0.9,
    regen: 0.5,
  },
];

export const DIFFICULTY_BY_ID = new Map(DIFFICULTIES.map((d) => [d.id, d]));
export const DEFAULT_DIFFICULTY = 'rainstorm';
