/**
 * Challenges — the unlock conditions, and the only place that says what a
 * challenge *is*.
 *
 * ## Shape
 *
 * ```js
 * {
 *   id,          // stable string; persisted, so never rename one in place
 *   name,        // shown in the logbook
 *   description, // the condition, in the player's words, not the code's
 *   hidden,      // true = name/description masked until complete
 *   goal,        // the number `track` has to reach
 *   track(profileStats, runStats) -> number,
 *   unlocks,     // { type, id } | null — see UNLOCK_BINDINGS at the bottom
 * }
 * ```
 *
 * `track` is a **pure read** of two plain objects. It must not touch `ctx`, the
 * DOM, or randomness: `Profile._evaluate` runs it on an event-driven timer,
 * possibly several times a second in a fight, and takes the high-water mark of
 * whatever it returns. Returning a boolean-ish 0/1 against `goal: 1` is the
 * normal way to write a one-shot.
 *
 *  - `profileStats` is `profile.data.stats` — lifetime sums and personal bests.
 *  - `runStats` is the live run counter block from `Profile.beginRun`, which is
 *    also passed one final time from `commitRun`. Anything phrased "in a single
 *    run" reads this; anything phrased "ever" reads the other.
 *
 * Progress only ever climbs (see `_evaluate`), so a run-scoped condition does
 * not lose its high-water mark when the run ends.
 *
 * ## Why every `unlocks` here is null right now
 *
 * A challenge that rewards an id which does not exist is worse than no
 * challenge: it gates content behind a reward the game cannot grant, and
 * `Profile.isUnlocked` would lock an id nothing can ever unlock. The survivor,
 * item, equipment and artifact catalogues are being written in parallel with
 * this file and none of their ids can be verified from here yet.
 *
 * So the machinery ships complete and the rewards ship unbound. Every challenge
 * below depends on nothing but generic run and lifetime numbers, which are real
 * today. Binding happens in one place — `UNLOCK_BINDINGS`, at the bottom.
 */

/**
 * The unlock namespaces. `Profile` builds one map per entry, so adding a type
 * here is all it takes for the profile to persist it.
 */
export const UNLOCK_TYPES = ['survivor', 'item', 'equipment', 'artifact', 'skin'];

const MINUTE = 60;

export const CHALLENGES = [
  // ---- first steps ---------------------------------------------------------
  {
    id: 'firstBlood',
    name: 'First Blood',
    description: 'Kill your first monster.',
    hidden: false,
    goal: 1,
    track: (p) => p.kills,
    unlocks: null,
  },
  {
    id: 'warmingUp',
    name: 'Warming Up',
    description: 'Clear a stage.',
    hidden: false,
    goal: 1,
    track: (p) => p.stagesCleared,
    unlocks: null,
  },
  {
    id: 'shockAndAwe',
    name: 'Shock and Awe',
    // Charging a teleporter is a different act from walking through a portal,
    // so it gets its own counter rather than reusing `stagesCleared`.
    description: 'Complete a teleporter event.',
    hidden: false,
    goal: 1,
    track: (p) => p.teleporters,
    unlocks: null,
  },

  // ---- depth ---------------------------------------------------------------
  {
    id: 'theLongHaul',
    name: 'The Long Haul',
    description: 'Reach stage 5 in a single run.',
    hidden: false,
    goal: 5,
    // `maxStageIndex` is zero-based; stage 5 is index 4.
    track: (p, r) => Math.min(5, (r?.maxStageIndex ?? 0) + 1),
    unlocks: null,
  },
  {
    id: 'looper',
    name: 'Looper',
    // Twelve stages is one full pass of the biome/name cycle, so stage 13 is
    // where the world starts repeating — the moment a run becomes a loop.
    description: 'Reach stage 13 in a single run.',
    hidden: false,
    goal: 13,
    track: (p, r) => Math.min(13, (r?.maxStageIndex ?? 0) + 1),
    unlocks: null,
  },
  {
    id: 'marathon',
    name: 'Marathon',
    description: 'Survive for 30 minutes in a single run.',
    hidden: false,
    goal: 30 * MINUTE,
    track: (p, r) => Math.min(30 * MINUTE, r?.time ?? 0),
    unlocks: null,
  },

  // ---- combat --------------------------------------------------------------
  {
    id: 'bossSlayer',
    name: 'Boss Slayer',
    description: 'Defeat 10 bosses.',
    hidden: false,
    goal: 10,
    track: (p) => p.bosses,
    unlocks: null,
  },
  {
    id: 'eliteHunter',
    name: 'Elite Hunter',
    description: 'Kill 100 elite monsters.',
    hidden: false,
    goal: 100,
    track: (p) => p.elites,
    unlocks: null,
  },
  {
    id: 'thousandCuts',
    name: 'A Thousand Cuts',
    description: 'Kill 1,000 monsters.',
    hidden: false,
    goal: 1000,
    track: (p) => p.kills,
    unlocks: null,
  },
  {
    id: 'oneShot',
    name: 'Glass Cannon',
    description: 'Deal 1,000 damage with a single hit.',
    hidden: false,
    goal: 1000,
    track: (p) => Math.min(1000, p.highestHit),
    unlocks: null,
  },
  {
    id: 'untouchable',
    name: 'Untouchable',
    description: 'Clear a stage without taking damage.',
    hidden: false,
    goal: 1,
    track: (p, r) => (r?.flawlessStages ?? 0) > 0 ? 1 : 0,
    unlocks: null,
  },

  // ---- economy -------------------------------------------------------------
  {
    id: 'hoarder',
    name: 'Hoarder',
    description: 'Hold 30 items at once in a single run.',
    hidden: false,
    goal: 30,
    track: (p, r) => Math.min(30, r?.items ?? 0),
    unlocks: null,
  },
  {
    id: 'richBeyondReason',
    name: 'Rich Beyond Reason',
    description: 'Earn 5,000 gold in a single run.',
    hidden: false,
    goal: 5000,
    track: (p, r) => Math.min(5000, r?.goldEarned ?? 0),
    unlocks: null,
  },

  // ---- persistence ---------------------------------------------------------
  {
    id: 'veteran',
    name: 'Veteran',
    description: 'Finish 25 runs.',
    hidden: false,
    goal: 25,
    track: (p) => p.runs,
    unlocks: null,
  },
  {
    id: 'noSurvivors',
    name: 'No Survivors',
    // Hidden because it is a joke about losing, and telling a new player their
    // twenty-fifth death is an achievement lands better as a surprise.
    description: 'Die 25 times.',
    hidden: true,
    goal: 25,
    track: (p) => p.deaths,
    unlocks: null,
  },
];

export const CHALLENGE_BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
// EXTENSION POINT — bind content ids here once A1–A3 land
// ---------------------------------------------------------------------------
//
// Add `'<challengeId>': { type, id }` entries below and the corresponding
// content becomes locked until that challenge is complete. Nothing else has to
// change: `Profile.isUnlocked` treats an id named here as gated and every other
// id as available, so this table is the single switch between "content exists"
// and "content must be earned".
//
// Rules, in order of how much damage breaking them does:
//
//  1. `type` must be one of UNLOCK_TYPES.
//  2. `id` must be an id that actually exists in `data/survivors.js`,
//     `data/items.js`, `data/equipment.js` or `data/artifacts.js`. A typo here
//     locks content behind a reward the game will grant to a name nothing
//     reads, i.e. it deletes the content. `applyUnlockBindings` warns about an
//     unknown *challenge* id but cannot check the content id — nothing in this
//     module is allowed to import the content catalogues, or a data module and
//     the profile would become a cycle.
//  3. Never gate the starting survivor or a common-tier item. The default is
//     unlocked; use that.
//
// Example, once the ids are real:
//
//   export const UNLOCK_BINDINGS = {
//     looper:      { type: 'artifact', id: 'sacrifice' },
//     bossSlayer:  { type: 'survivor', id: 'engineer' },
//     untouchable: { type: 'equipment', id: 'blastShower' },
//   };
//
// The seven artifacts, one per challenge, chosen so the condition reads as the
// artifact's own premise rather than as an arbitrary toll:
//
//   - `glass` behind a 1,000-damage hit — the challenge is literally named
//     Glass Cannon, and the artifact is what a glass cannon is.
//   - `honour` behind 100 elites, `evolution` behind 10 bosses: you unlock the
//     thing that makes every monster elite by having fought elites.
//   - `command` behind 30 items in a run and `sacrifice` behind 5,000 gold —
//     both are about the loot economy, and both are earned by mastering the one
//     they then replace.
//   - `caprice` behind stage 5 and `swarms` behind 1,000 kills are the two
//     "keep playing" slots, deliberately reachable inside the first evening.
//
// `looper`, `untouchable`, `veteran`, `noSurvivors`, `firstBlood`, `warmingUp`,
// `shockAndAwe` and `marathon` are left unbound on purpose: some are the
// tutorial beats and some are the very long tail, and gating an artifact behind
// stage 13 would mean most players never see one. Survivors and equipment are
// not bound here — nobody owns those catalogues this round.
export const UNLOCK_BINDINGS = {
  hoarder: { type: 'artifact', id: 'command' },
  richBeyondReason: { type: 'artifact', id: 'sacrifice' },
  thousandCuts: { type: 'artifact', id: 'swarms' },
  oneShot: { type: 'artifact', id: 'glass' },
  theLongHaul: { type: 'artifact', id: 'caprice' },
  eliteHunter: { type: 'artifact', id: 'honour' },
  bossSlayer: { type: 'artifact', id: 'evolution' },
};

// Bumped by `applyUnlockBindings` so `Profile`'s cached gate map can tell it is
// stale. Only matters for hot reload and for tests that rebind at runtime;
// in a normal session this is called once, before the first `isUnlocked`.
let _stamp = 0;
export function bindingStamp() { return _stamp; }

/**
 * Write `UNLOCK_BINDINGS` onto the challenge objects. Idempotent — call it
 * again after editing the table (a test, or a hot reload) and the previous
 * bindings are cleared first, so removing an entry really does un-gate it.
 */
export function applyUnlockBindings() {
  for (const c of CHALLENGES) c.unlocks = null;
  for (const [challengeId, reward] of Object.entries(UNLOCK_BINDINGS)) {
    const c = CHALLENGE_BY_ID[challengeId];
    if (!c) {
      console.warn(`[challenges] UNLOCK_BINDINGS names unknown challenge "${challengeId}"`);
      continue;
    }
    if (!reward || !UNLOCK_TYPES.includes(reward.type) || typeof reward.id !== 'string') {
      console.warn(`[challenges] challenge "${challengeId}" has a malformed unlock binding`);
      continue;
    }
    c.unlocks = { type: reward.type, id: reward.id };
  }
  _stamp++;
}

applyUnlockBindings();
