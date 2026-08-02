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
 *   category,    // key into CHALLENGE_CATEGORIES — grouping only, never logic
 *   hidden,      // true = name/description masked until complete
 *   goal,        // number, or (facts) => number for a catalogue-sized goal
 *   track(profileStats, runStats, facts) -> number,
 *   unlocks,     // { type, id } | null — written by the registry, see below
 * }
 * ```
 *
 * `track` is a **pure read** of three plain objects. It must not touch `ctx`,
 * the DOM, or randomness: `Profile._evaluate` runs it on an event-driven timer,
 * possibly several times a second in a fight, and takes the high-water mark of
 * whatever it returns. Returning a boolean-ish 0/1 against `goal: 1` is the
 * normal way to write a one-shot.
 *
 *  - `profileStats` is `profile.data.stats` — lifetime sums and personal bests.
 *  - `runStats` is the live run counter block from `Profile.beginRun`, which is
 *    also passed one final time from `commitRun`. Anything phrased "in a single
 *    run" reads this; anything phrased "ever" reads the other.
 *  - `facts` is `Profile.facts()` — the derived career view: how much of each
 *    catalogue has been met, and the per-survivor record. It is the third
 *    argument rather than a field on `profileStats` because `profileStats` is
 *    persisted verbatim and these are computed; putting them there would write
 *    a stale copy of a derived number into every save.
 *
 * Progress only ever climbs (see `_evaluate`), so a run-scoped condition does
 * not lose its high-water mark when the run ends.
 *
 * ## Dynamic goals
 *
 * `goal` may be a function of `facts`. That exists for exactly one kind of
 * challenge — "meet every monster", "collect every item" — whose target is the
 * size of a catalogue that other agents are still adding to. Hardcoding 22 in
 * this file would mean the twenty-third monster silently un-completes a
 * challenge a player already earned, or (worse) that the completion threshold
 * and the content disagree in the direction that makes it unreachable.
 *
 * The resolved number is persisted alongside the progress (`challenges[id].goal`)
 * so the logbook can draw a bar before the first evaluation of a session, and
 * so a challenge already completed against an older, smaller catalogue stays
 * completed — `_evaluate` never re-runs a done challenge.
 *
 * ## Where the rewards come from
 *
 * Every `unlocks` below is `null` in this file, and stays null. Rewards are
 * *discovered* at runtime by `systems/UnlockRegistry.js`, which reads the
 * `unlock` field off the content cards themselves and calls
 * `registerUnlockBinding` here. That inversion is deliberate: a content agent
 * adding a survivor writes one field on their own card and it becomes gated,
 * with no edit to this file and no id of theirs hardcoded in it. A table here
 * would be a second copy of the same fact, and the two copies drifting is how
 * an artifact gets permanently locked.
 *
 * `UNLOCK_BINDINGS` survives as the resolved map — the registry writes into it
 * and `systems/Artifacts.js` audits against it — plus a manual override slot
 * for content that has nowhere to declare an `unlock` of its own.
 */

/**
 * The unlock namespaces. `Profile` builds one map per entry, so adding a type
 * here is all it takes for the profile to persist it.
 */
export const UNLOCK_TYPES = ['survivor', 'item', 'equipment', 'artifact', 'skin'];

/**
 * Grouping for the logbook's challenge index, in display order.
 *
 * Purely presentational — nothing in `Profile` reads a category. It exists
 * because a flat list of thirty rows is a list nobody reads: the player's
 * question is "what is close?", and that question is answered by a section
 * heading far better than by scrolling.
 */
export const CHALLENGE_CATEGORIES = [
  { id: 'origins', label: 'First Steps' },
  { id: 'depth', label: 'Depth' },
  { id: 'combat', label: 'Combat' },
  { id: 'economy', label: 'Fortune' },
  { id: 'discovery', label: 'Survey' },
  { id: 'mastery', label: 'Mastery' },
  { id: 'career', label: 'Career' },
];

const MINUTE = 60;

/** How many of `map`'s ids have been met. `facts.distinct` is precomputed. */
const distinct = (facts, kind) => facts?.distinct?.[kind] ?? 0;
/** How many ids exist in that catalogue right now. Zero if nobody registered it. */
const catalogue = (facts, kind) => facts?.catalogue?.[kind] ?? 0;

export const CHALLENGES = [
  // ---- first steps ---------------------------------------------------------
  {
    id: 'firstBlood',
    name: 'First Blood',
    description: 'Kill your first monster.',
    category: 'origins',
    hidden: false,
    goal: 1,
    track: (p) => p.kills,
    unlocks: null,
  },
  {
    id: 'warmingUp',
    name: 'Warming Up',
    description: 'Clear a stage.',
    category: 'origins',
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
    category: 'origins',
    hidden: false,
    goal: 1,
    track: (p) => p.teleporters,
    unlocks: null,
  },
  {
    id: 'firstBoss',
    name: 'Something Bigger',
    description: 'Defeat a teleporter boss.',
    category: 'origins',
    hidden: false,
    goal: 1,
    track: (p) => p.bosses,
    unlocks: null,
  },

  // ---- depth ---------------------------------------------------------------
  {
    id: 'theLongHaul',
    name: 'The Long Haul',
    description: 'Reach stage 5 in a single run.',
    category: 'depth',
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
    category: 'depth',
    hidden: false,
    goal: 13,
    track: (p, r) => Math.min(13, (r?.maxStageIndex ?? 0) + 1),
    unlocks: null,
  },
  {
    id: 'deepLoop',
    name: 'Past the Second Turn',
    description: 'Reach stage 25 in a single run.',
    category: 'depth',
    hidden: false,
    goal: 25,
    track: (p, r) => Math.min(25, (r?.maxStageIndex ?? 0) + 1),
    unlocks: null,
  },
  {
    id: 'marathon',
    name: 'Marathon',
    description: 'Survive for 30 minutes in a single run.',
    category: 'depth',
    hidden: false,
    goal: 30 * MINUTE,
    track: (p, r) => Math.min(30 * MINUTE, r?.time ?? 0),
    unlocks: null,
  },
  {
    id: 'blitz',
    name: 'Ahead of the Curve',
    // The difficulty coefficient is a function of wall clock, so arriving early
    // is the only thing that makes a late stage survivable. This is the
    // challenge that teaches that, phrased as the thing the player must do
    // rather than as the mechanic it is about.
    description: 'Reach stage 5 within 10 minutes.',
    category: 'depth',
    hidden: false,
    goal: 1,
    track: (p, r) => ((r?.maxStageIndex ?? 0) >= 4 && (r?.time ?? 0) <= 10 * MINUTE ? 1 : 0),
    unlocks: null,
  },
  {
    id: 'finisher',
    name: 'The Way Out',
    description: 'Finish a run at the Fracture instead of dying in it.',
    category: 'depth',
    hidden: false,
    goal: 1,
    track: (p) => Math.min(1, p.wins),
    unlocks: null,
  },

  // ---- combat --------------------------------------------------------------
  {
    id: 'bossSlayer',
    name: 'Boss Slayer',
    description: 'Defeat 10 bosses.',
    category: 'combat',
    hidden: false,
    goal: 10,
    track: (p) => p.bosses,
    unlocks: null,
  },
  {
    id: 'eliteHunter',
    name: 'Elite Hunter',
    description: 'Kill 100 elite monsters.',
    category: 'combat',
    hidden: false,
    goal: 100,
    track: (p) => p.elites,
    unlocks: null,
  },
  {
    id: 'thousandCuts',
    name: 'A Thousand Cuts',
    description: 'Kill 1,000 monsters.',
    category: 'combat',
    hidden: false,
    goal: 1000,
    track: (p) => p.kills,
    unlocks: null,
  },
  {
    id: 'oneShot',
    name: 'Glass Cannon',
    description: 'Deal 1,000 damage with a single hit.',
    category: 'combat',
    hidden: false,
    goal: 1000,
    track: (p) => Math.min(1000, p.highestHit),
    unlocks: null,
  },
  {
    id: 'overkill',
    name: 'Overkill',
    description: 'Deal 25,000 damage with a single hit.',
    category: 'combat',
    hidden: false,
    goal: 25000,
    track: (p) => Math.min(25000, p.highestHit),
    unlocks: null,
  },
  {
    id: 'untouchable',
    name: 'Untouchable',
    description: 'Clear a stage without taking damage.',
    category: 'combat',
    hidden: false,
    goal: 1,
    track: (p, r) => ((r?.flawlessStages ?? 0) > 0 ? 1 : 0),
    unlocks: null,
  },
  {
    id: 'ironclad',
    name: 'Ironclad',
    description: 'Clear three stages in one run without taking damage.',
    category: 'combat',
    hidden: false,
    goal: 3,
    track: (p, r) => Math.min(3, r?.flawlessStages ?? 0),
    unlocks: null,
  },
  {
    id: 'massacre',
    name: 'Massacre',
    // Rolling ten-second window, maintained in `Profile._onKill`. A lifetime
    // kill count says you played a lot; this one says a specific ten seconds
    // went very well, which is the thing a player actually remembers.
    description: 'Kill 25 monsters within ten seconds.',
    category: 'combat',
    hidden: false,
    goal: 25,
    track: (p, r) => Math.min(25, r?.bestKillBurst ?? 0),
    unlocks: null,
  },

  // ---- economy -------------------------------------------------------------
  {
    id: 'hoarder',
    name: 'Hoarder',
    description: 'Hold 30 items at once in a single run.',
    category: 'economy',
    hidden: false,
    goal: 30,
    track: (p, r) => Math.min(30, r?.items ?? 0),
    unlocks: null,
  },
  {
    id: 'packMule',
    name: 'Pack Mule',
    description: 'Hold 80 items at once in a single run.',
    category: 'economy',
    hidden: false,
    goal: 80,
    track: (p, r) => Math.min(80, r?.items ?? 0),
    unlocks: null,
  },
  {
    id: 'richBeyondReason',
    name: 'Rich Beyond Reason',
    description: 'Earn 5,000 gold in a single run.',
    category: 'economy',
    hidden: false,
    goal: 5000,
    track: (p, r) => Math.min(5000, r?.goldEarned ?? 0),
    unlocks: null,
  },
  {
    id: 'mintCondition',
    name: 'Mint Condition',
    description: 'Earn 100,000 gold across all runs.',
    category: 'economy',
    hidden: false,
    goal: 100000,
    track: (p) => Math.min(100000, p.gold),
    unlocks: null,
  },

  // ---- survey --------------------------------------------------------------
  //
  // Every entry here is sized off the live catalogue rather than a literal,
  // because the catalogues are being written in parallel with this file. See
  // "Dynamic goals" at the top.
  {
    id: 'firstContact',
    name: 'First Contact',
    description: 'Record ten distinct monsters in the bestiary.',
    category: 'discovery',
    hidden: false,
    goal: 10,
    track: (p, r, f) => Math.min(10, distinct(f, 'enemy')),
    unlocks: null,
  },
  {
    id: 'fieldGuide',
    name: 'Field Guide',
    description: 'Record every monster in the bestiary.',
    category: 'discovery',
    hidden: false,
    // One is the floor so a build with no bestiary at all cannot report a
    // completed challenge against a goal of zero.
    goal: (f) => Math.max(1, catalogue(f, 'enemy')),
    track: (p, r, f) => distinct(f, 'enemy'),
    unlocks: null,
  },
  {
    id: 'apexSurvey',
    name: 'Apex Survey',
    description: 'Defeat every kind of teleporter boss.',
    category: 'discovery',
    hidden: false,
    goal: (f) => Math.max(1, catalogue(f, 'boss')),
    track: (p, r, f) => distinct(f, 'boss'),
    unlocks: null,
  },
  {
    id: 'collector',
    name: 'Collector',
    description: 'Pick up 25 distinct items.',
    category: 'discovery',
    hidden: false,
    goal: 25,
    track: (p, r, f) => Math.min(25, distinct(f, 'item')),
    unlocks: null,
  },
  {
    id: 'curator',
    name: 'Curator',
    description: 'Pick up every item in the game at least once.',
    category: 'discovery',
    hidden: false,
    goal: (f) => Math.max(1, catalogue(f, 'item')),
    track: (p, r, f) => distinct(f, 'item'),
    unlocks: null,
  },
  {
    id: 'quartermaster',
    name: 'Quartermaster',
    description: 'Hold every piece of equipment at least once.',
    category: 'discovery',
    hidden: false,
    goal: (f) => Math.max(1, catalogue(f, 'equipment')),
    track: (p, r, f) => distinct(f, 'equipment'),
    unlocks: null,
  },

  // ---- mastery -------------------------------------------------------------
  //
  // The per-survivor mastery challenges are *generated*, not written here —
  // `systems/UnlockRegistry.js` builds one per roster entry at boot. What is
  // written here is the aggregate that sits over them, which needs no id of any
  // survivor either.
  {
    id: 'wholeRoster',
    name: 'Whole Roster',
    description: 'Finish a run with every survivor.',
    category: 'mastery',
    hidden: false,
    goal: (f) => Math.max(1, catalogue(f, 'survivor')),
    track: (p, r, f) => f?.survivorsPlayed ?? 0,
    unlocks: null,
  },

  // ---- career --------------------------------------------------------------
  {
    id: 'veteran',
    name: 'Veteran',
    description: 'Finish 25 runs.',
    category: 'career',
    hidden: false,
    goal: 25,
    track: (p) => p.runs,
    unlocks: null,
  },
  {
    id: 'centurion',
    name: 'Centurion',
    description: 'Finish 100 runs.',
    category: 'career',
    hidden: false,
    goal: 100,
    track: (p) => p.runs,
    unlocks: null,
  },
  {
    id: 'clockedIn',
    name: 'Clocked In',
    description: 'Spend 10 hours in the field.',
    category: 'career',
    hidden: false,
    goal: 10 * 60 * MINUTE,
    track: (p) => Math.min(10 * 60 * MINUTE, p.timePlayed),
    unlocks: null,
  },
  {
    id: 'noSurvivors',
    name: 'No Survivors',
    // Hidden because it is a joke about losing, and telling a new player their
    // twenty-fifth death is an achievement lands better as a surprise.
    description: 'Die 25 times.',
    category: 'career',
    hidden: true,
    goal: 25,
    track: (p) => p.deaths,
    unlocks: null,
  },
];

/**
 * id -> definition. Mutable by design: `registerChallenges` adds to both this
 * and `CHALLENGES`, and every consumer holds the same object reference rather
 * than a snapshot.
 */
export const CHALLENGE_BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));

/**
 * Resolve a challenge's goal against the current career facts.
 *
 * Always a positive integer. A dynamic goal that throws or returns garbage
 * falls back to 1 rather than to 0 — a goal of zero would mark the challenge
 * complete on the first evaluation, which is a strictly worse failure than one
 * that is merely too easy.
 */
export function goalOf(def, facts) {
  if (!def) return 1;
  if (typeof def.goal !== 'function') return Math.max(1, def.goal || 1);
  let g;
  try {
    g = def.goal(facts);
  } catch (e) {
    console.warn(`[challenges] dynamic goal for "${def.id}" threw:`, e);
    return 1;
  }
  return Number.isFinite(g) && g > 0 ? Math.round(g) : 1;
}

// ---------------------------------------------------------------------------
// EXTENSION POINTS
// ---------------------------------------------------------------------------

/**
 * Resolved reward map: challenge id -> `{ type, id }`.
 *
 * This used to be the *authored* table and is now the *output* of
 * `systems/UnlockRegistry.js`. It keeps its name and its shape because
 * `systems/Artifacts.js` audits its own cards against it at boot, and because
 * one hand-written entry is still occasionally the right answer for content
 * that has no card of its own to declare an `unlock` on.
 *
 * Anything written here by hand is an **override**: it wins over a card's own
 * declaration, and `registerUnlockBinding` will not silently replace it.
 */
export const UNLOCK_BINDINGS = {};

/** Ids that were written here by hand rather than discovered. */
const MANUAL = new Set(Object.keys(UNLOCK_BINDINGS));

// Bumped by anything that changes the binding table or the challenge list, so
// `Profile`'s cached gate map can tell it is stale. In a normal session this
// settles before the first `isUnlocked`; it matters for hot reload and for
// tests that register content at runtime.
let _stamp = 0;
export function bindingStamp() { return _stamp; }

/**
 * Bind a reward to a challenge. Returns true if the table changed.
 *
 * Rejects, loudly, everything that would quietly delete content:
 *
 *  - an unknown challenge id (the reward would never be granted, and
 *    `Profile.isUnlocked` would gate the content on a condition nothing tracks,
 *    i.e. lock it forever);
 *  - a malformed reward;
 *  - a second binding for a challenge that already has one, unless it is the
 *    same reward. Two content cards naming the same challenge is a content bug
 *    and the first one silently winning is how it stays invisible.
 */
export function registerUnlockBinding(challengeId, reward, { manual = false } = {}) {
  const c = CHALLENGE_BY_ID[challengeId];
  if (!c) {
    console.warn(`[challenges] unlock binding names unknown challenge "${challengeId}"`);
    return false;
  }
  if (!reward || !UNLOCK_TYPES.includes(reward.type) || typeof reward.id !== 'string' || !reward.id) {
    console.warn(`[challenges] challenge "${challengeId}" was given a malformed unlock binding`);
    return false;
  }
  const prev = UNLOCK_BINDINGS[challengeId];
  if (prev) {
    if (prev.type === reward.type && prev.id === reward.id) return false;
    if (MANUAL.has(challengeId) && !manual) {
      console.warn(`[challenges] "${challengeId}" is bound by hand to ${prev.type}:${prev.id}; `
        + `ignoring the declared ${reward.type}:${reward.id}`);
      return false;
    }
    console.warn(`[challenges] "${challengeId}" is claimed by both ${prev.type}:${prev.id} `
      + `and ${reward.type}:${reward.id} — one of them will never unlock`);
    return false;
  }
  if (manual) MANUAL.add(challengeId);
  UNLOCK_BINDINGS[challengeId] = { type: reward.type, id: reward.id };
  c.unlocks = { type: reward.type, id: reward.id };
  _stamp++;
  return true;
}

/**
 * Add challenges that could not be written here.
 *
 * The only current caller generates one per survivor, which this file cannot do
 * itself: importing `data/survivors.js` from the module that `Profile` imports
 * would make the roster a dependency of the save system, and the content agents
 * would then be one careless import away from a cycle between a data file and
 * the profile.
 *
 * Idempotent by id, so a hot reload that re-runs the generator replaces its
 * definitions in place rather than growing the list. Persisted progress is keyed
 * by id and is unaffected by a replacement.
 */
export function registerChallenges(defs) {
  let added = 0;
  for (const def of defs || []) {
    if (!def || typeof def.id !== 'string' || typeof def.track !== 'function') {
      console.warn('[challenges] refused a malformed generated challenge:', def);
      continue;
    }
    const entry = {
      hidden: false, category: 'mastery', unlocks: null, goal: 1, description: '',
      ...def,
    };
    const at = CHALLENGES.findIndex((c) => c.id === def.id);
    if (at >= 0) CHALLENGES[at] = entry;
    else CHALLENGES.push(entry);
    CHALLENGE_BY_ID[def.id] = entry;
    added++;
  }
  if (added) _stamp++;
  return added;
}

/**
 * Re-apply the resolved bindings onto the challenge objects.
 *
 * Kept as a public entry point because tests and hot reload both need a way to
 * say "the table changed under you". `registerUnlockBinding` already writes
 * `c.unlocks` as it goes, so in a normal boot this never has anything to do.
 */
export function applyUnlockBindings() {
  for (const c of CHALLENGES) c.unlocks = null;
  for (const [challengeId, reward] of Object.entries(UNLOCK_BINDINGS)) {
    const c = CHALLENGE_BY_ID[challengeId];
    if (c) c.unlocks = { type: reward.type, id: reward.id };
  }
  _stamp++;
}

applyUnlockBindings();
