import {
  CHALLENGES, CHALLENGE_BY_ID, UNLOCK_TYPES, bindingStamp, goalOf,
} from '../data/challenges.js';
// Imported for its module-evaluation side effect as much as for its API: this
// is what discovers the reward bindings off the content cards and generates the
// per-survivor mastery challenges, and it has to have run before the first gate
// question. See the header of that file for why it is not an `init` hook.
import { catalogueSizes, catalogueHas, unlockName } from './UnlockRegistry.js';
import { isLocalVictim, isLocalOwner } from '../core/Engine.js';
import { adoptLegacyKey } from '../core/LegacyStorage.js';
import { renameItemId, renameEnemyId } from '../data/renamedIds.js';

/**
 * The persistent player profile — everything that outlives a run.
 *
 * This is the **only** module in the codebase that touches localStorage for
 * meta state (`src/ui/Menus.js` owns the settings blob, and `GpuNotice.js` owns
 * one dismissal flag; neither overlaps with anything here). Keeping it to one
 * owner is what makes schema migration tractable: there is exactly one reader,
 * one writer, and one version number.
 *
 * Six things live in here:
 *
 *  - **unlocks** — which survivors / items / equipment / artifacts the player
 *    has earned. Note the default is *unlocked*: see `isUnlocked`.
 *  - **challenge progress** — counters that survive across runs, advanced from
 *    the event bus rather than polled.
 *  - **encounters** — every id the player has ever met, with a first-seen stamp
 *    and a running count. The logbook reads both: "seen" gates the entry, the
 *    count is the line that makes the bestiary feel like *your* bestiary.
 *  - **per-survivor career** — runs, wins and bests, one row per survivor. This
 *    is what the generated mastery challenges track and what the survivor select
 *    screen could show; it is keyed by survivor id and needs no roster import.
 *  - **run history** — the last `MAX_RUNS` runs, for the logbook's run list.
 *  - **lifetime stats** — the aggregate roll-up, plus the personal bests.
 *
 * ## The run report
 *
 * `commitRun` returns, and stores, a *report*: what this run changed. Unlocks
 * earned, challenges completed, challenges advanced, personal bests beaten, new
 * content met. It exists because the post-run screen is the only moment where a
 * player decides whether to press restart, and "you died on stage 4" is not a
 * reason to. It is computed by diffing against snapshots taken at `beginRun`,
 * which is the only point where the before-state is still available.
 *
 * ## Why it is not registered in main.js
 *
 * `Progression` constructs and inits this, exactly the way it already owns
 * `Interactables`. Two reasons: the profile owns no frame time (every write is
 * debounced onto a timer, every counter is an event handler), so a slot in the
 * engine's update loop would be a lie; and Progression is the system that knows
 * when a run begins and ends, which is the only lifecycle the profile has.
 *
 * ## Co-op
 *
 * The profile is per-client and local. It is deliberately **not** gated on
 * `ctx.authority` — a client earns their own unlocks playing on someone else's
 * host, and gating on authority would mean nobody but the host ever unlocks
 * anything. What it *is* gated on is witness: see `_isLocalSource`. A client
 * receives replicated `kill` and `damage` events for the whole session,
 * including the host's own kills, and crediting those to the client's lifetime
 * stats would let one player farm another player's play time.
 *
 * Shared facts — a stage cleared, a teleporter charged, a boss downed — are
 * credited to everyone present, because everyone present was in that fight.
 * That is the same call RoR2 makes and it is the one that matches how the
 * numbers read to a player.
 */

// Bump this whenever the persisted shape changes, and add the matching entry to
// MIGRATIONS below. Never reuse a number.
export const PROFILE_VERSION = 4;

/**
 * One key, one JSON blob, forever.
 *
 * Deliberately *not* re-keyed for v2. The key carries `v1` because that is the
 * generation of the storage contract, not the generation of the shape inside
 * it: `docs/STEAM.md` wants the whole profile in a single blob a native build
 * can lift wholesale, and a key that moves with every schema bump means a port
 * has to know the history of the key as well as the history of the shape. The
 * key changes only if a shape is ever so alien that migration is not worth
 * writing, and then the old blob is left on disk rather than mangled.
 */
const STORE_KEY = 'telluric.profile.v1';

/**
 * What the key was called while the game was called Petrichor. `_load` adopts
 * it once; see `src/core/LegacyStorage.js` for why the move is byte-level.
 */
const LEGACY_STORE_KEY = 'petrichor.profile.v1';

// Run history is what the logbook's "recent runs" list reads. 25 is about two
// evenings of play and keeps the serialised profile comfortably under 20 KB,
// which is what lets the debounced write stay sub-millisecond.
const MAX_RUNS = 25;

// How long after the last change we actually write. Long enough that a burst of
// twenty kills in one second is one write; short enough that a browser crash
// costs at most this much progress.
const WRITE_DEBOUNCE_MS = 1500;

// Challenge evaluation is cheap (a dozen arithmetic predicates) but `damage`
// fires hundreds of times a second in a horde, so counter updates only *mark*
// the evaluation dirty and this timer runs it. Discrete milestones (stage,
// boss, run end) evaluate immediately — those are the ones a player is watching
// for a toast on.
const EVAL_DEBOUNCE_MS = 250;

// The deepest corruption band a run may end in and still count as a clean
// ending. 1 is Seeded (`BANDS` in data/corruption.js) — the band a player
// reaches by opening a few chests, so the condition is "restrained", not
// "took nothing". Not imported from there: this is a challenge threshold, and
// re-tuning where Seeded *starts* must not silently re-tune what wins the Vigil.
const CLEAN_ENDING_BAND = 1;

// Which endings count as "finished a run at the Fracture" — the wording the
// player is shown on the `unbrokenSeal` row. `ENDINGS` (data/realms.js) marks
// three outcomes `won: true`, and the third is `obliterated`: the Obelisk of
// Departure in the market, reachable from stage 1, which ends the run on the
// player's terms without ever seeing the Fracture. That is a win for every
// other purpose and must not be one here, so this list is positive — a future
// ending has to be named before it can seal the Vigil, rather than qualifying
// by default the moment someone adds it.
const FINALE_VICTORY_ENDINGS = new Set(['victory', 'victory-void']);

// The window the `massacre` challenge measures its burst over. Ten seconds is
// about one teleporter-boss add wave, which is the fight the challenge is
// describing.
const BURST_WINDOW_MS = 10000;

/** A profile with nothing in it. Also the shape every migration must produce. */
function freshProfile() {
  const now = Date.now();
  return {
    version: PROFILE_VERSION,
    createdAt: now,
    updatedAt: now,
    // id -> epoch ms of the unlock, per type. A map rather than an array so
    // repeated unlocks are idempotent and the logbook can show *when*.
    unlocks: emptyByType(),
    // id -> { progress, done, doneAt, goal }. `goal` is stored because it can be
    // a function of the catalogue size (see challenges.js "Dynamic goals") and
    // the logbook has to draw a bar before the first evaluation of a session.
    challenges: {},
    // Logbook "have I ever met this" record, per kind: id -> { at, count }.
    // Populated from play, so it needs no id list of its own and cannot drift
    // from the content data.
    encounters: emptyByKind(),
    // Per-survivor career: id -> { runs, wins, deaths, kills, time, bestStage,
    // bestTime }. Keyed by id and never enumerated against a roster, so a
    // survivor added or removed by another agent costs nothing here.
    survivors: {},
    // Newest first.
    runs: [],
    stats: {
      runs: 0, wins: 0, deaths: 0,
      timePlayed: 0, kills: 0, elites: 0, bosses: 0,
      damageDealt: 0, damageTaken: 0, items: 0, gold: 0,
      stagesCleared: 0, teleporters: 0,
      // Personal bests, kept alongside the sums because they are the numbers a
      // player actually quotes and recomputing them from a 25-run window would
      // silently forget anything older.
      bestStage: 0, bestTime: 0, bestKills: 0, highestHit: 0,
      bestLevel: 0, bestGold: 0, bestItems: 0,
    },
  };
}

/** The kinds the encounter log files things under. */
export const ENCOUNTER_KINDS = ['item', 'equipment', 'enemy', 'boss', 'survivor'];

function emptyByType() {
  const out = {};
  for (const t of UNLOCK_TYPES) out[t] = {};
  return out;
}

function emptyByKind() {
  const out = {};
  for (const k of ENCOUNTER_KINDS) out[k] = {};
  return out;
}

/**
 * Schema migrations, keyed by the version being migrated *from*. Each entry
 * takes the old object and returns the next version's object; the chain is run
 * until it reaches PROFILE_VERSION, so a v0 profile on a v5 build runs five
 * small functions rather than one big one that has to know every past shape.
 *
 * Entry 0 covers profiles written before the payload carried a version at all.
 * Those are structurally the current shape minus the stamp, so the migration is
 * the identity plus the stamp — `_coerce` below does the rest of the work by
 * merging against the fresh defaults, which is what makes *every* migration
 * additive-safe: a field introduced after the blob was written appears with its
 * default rather than as `undefined` leaking into arithmetic.
 */
const MIGRATIONS = {
  0: (p) => ({ ...p, version: 1 }),

  /**
   * v1 -> v2. Two real data moves, neither of which `_coerce` could do alone.
   *
   * **`discovered` -> `encounters`.** v1 stored `kind -> id -> timestamp`; v2
   * stores `kind -> id -> { at, count }`, because "you have killed 412 Sentinels"
   * is the line that makes a bestiary read as a record of *your* play rather
   * than as a catalogue with some rows greyed out. Every first-seen stamp is
   * carried across verbatim; the count starts at zero and is honest about it —
   * inventing a count from a timestamp would be fabricating play history, and
   * the logbook simply omits the line until a kill lands.
   *
   * **`survivors` reconstructed from `runs`.** The per-survivor career table is
   * new, and the generated mastery challenges read it. A returning player whose
   * table started empty would see every mastery challenge at zero despite
   * twenty-five recorded runs, which reads as lost progress. The last MAX_RUNS
   * runs are the only history that exists, so that is what it is rebuilt from —
   * an undercount for a very long-lived profile, but an undercount that only
   * ever moves the number toward the truth as the player keeps playing.
   */
  1: (p) => {
    const encounters = {};
    for (const kind of ENCOUNTER_KINDS) {
      encounters[kind] = {};
      const src = isObj(p.discovered) ? p.discovered[kind] : null;
      if (!isObj(src)) continue;
      for (const id of Object.keys(src)) {
        encounters[kind][id] = { at: num(src[id], 0), count: 0 };
      }
    }

    const survivors = isObj(p.survivors) ? { ...p.survivors } : {};
    if (Array.isArray(p.runs)) {
      for (const r of p.runs) {
        if (!isObj(r) || typeof r.survivorId !== 'string' || !r.survivorId) continue;
        const row = survivors[r.survivorId] || (survivors[r.survivorId] = {
          runs: 0, wins: 0, deaths: 0, kills: 0, time: 0, bestStage: 0, bestTime: 0,
        });
        row.runs++;
        if (r.outcome === 'victory') row.wins++; else row.deaths++;
        row.kills += num(r.kills, 0);
        row.time += num(r.time, 0);
        row.bestStage = Math.max(row.bestStage, num(r.stage, 0));
        row.bestTime = Math.max(row.bestTime, num(r.time, 0));
      }
    }

    // `discovered` is dropped rather than kept alongside: `_coerce` builds from
    // the fresh defaults, so a field the current shape does not name is gone
    // after the next write, and keeping a dead copy would double the part of
    // the blob that grows with the catalogue.
    const out = { ...p, version: 2, encounters, survivors };
    delete out.discovered;
    return out;
  },

  /**
   * v2 -> v3, and v3 -> v4. Ids were renamed, so every record keyed by one
   * moves. Both entries are `remapIds` and differ only in which kinds they
   * carry; the shape of the work is identical and doing it twice is free.
   *
   * v3 was `hopoo-feather` and `shatterspleen` — the two ids that were
   * themselves Risk of Rain 2 vocabulary rather than merely attached to it.
   * v4 is the rest of them (`reviews/round7/FIX-ror2-ids.md`): thirty-seven
   * more item ids and the six enemy ids. A profile records an item id in three
   * places and an enemy id in two, and a bare rename would have read as "the
   * game forgot I ever found that" and "the game forgot I ever killed one".
   *
   * **The v2 entry now translates more than it did when it was written**, and
   * that is deliberate rather than an oversight: it calls the shared table, the
   * table has grown, and a v2 profile arriving today gets the round-7 item ids
   * applied at step one and then again — idempotently — at step two. What
   * matters is that no chain reaches v4 with an old id in it, and every chain
   * ends in the v3 entry.
   *
   * Nothing here is a merge of *different* things, so every join is the one the
   * cross-tab merge already uses for that field: earliest wins for a first-seen
   * or unlock stamp, counts add. The old and new id cannot both be present in a
   * profile this build wrote — but `importProfile` accepts arbitrary blobs
   * through this same path, and a collision that silently dropped one side
   * would be a data loss discovered months later.
   */
  2: (p) => remapIds(p, 3, { items: true }),
  3: (p) => remapIds(p, 4, { items: true, enemies: true }),
};

/** Earliest non-zero stamp wins; an unset stamp is 0 and must not win. */
const earlierStamp = (a, b) => (a > 0 && b > 0 ? Math.min(a, b) : Math.max(num(a, 0), num(b, 0)));

/** Fold `{ at, count }` encounter rows that collided onto one id. */
function mergeEncounters(src, rename) {
  const out = {};
  for (const [id, rec] of Object.entries(src)) {
    const k = rename(id);
    const at = num(rec?.at, 0);
    const count = num(rec?.count, 0);
    const prev = out[k];
    out[k] = prev
      ? { at: earlierStamp(prev.at, at), count: prev.count + count }
      : { at, count };
  }
  return out;
}

/**
 * Re-key every id-keyed record in a profile, and stamp it at `version`.
 *
 * `kinds` names which tables to consult, so a migration entry declares what its
 * own step was for rather than translating everything by accident. Enemy ids
 * reach the encounter log's `enemy` and `boss` kinds and nothing else — the
 * per-survivor career table is keyed by survivor id, and no survivor was
 * renamed.
 */
function remapIds(p, version, { items = false, enemies = false } = {}) {
  const out = { ...p, version };

  if (items && isObj(p.unlocks) && isObj(p.unlocks.item)) {
    const item = {};
    for (const [id, at] of Object.entries(p.unlocks.item)) {
      const k = renameItemId(id);
      // An unlock stamp is "when did I first earn this"; 0/absent must lose.
      item[k] = earlierStamp(num(item[k], 0), num(at, 0));
    }
    out.unlocks = { ...p.unlocks, item };
  }

  if (isObj(p.encounters)) {
    const encounters = { ...p.encounters };
    if (items && isObj(p.encounters.item)) {
      encounters.item = mergeEncounters(p.encounters.item, renameItemId);
    }
    if (enemies) {
      // Both kinds, and for the same reason: a card that is a boss on one
      // stage is an ordinary spawn on another, so the same id is filed under
      // whichever role the player met it in.
      for (const kind of ['enemy', 'boss']) {
        if (isObj(p.encounters[kind])) {
          encounters[kind] = mergeEncounters(p.encounters[kind], renameEnemyId);
        }
      }
    }
    out.encounters = encounters;
  }

  if (items && Array.isArray(p.runs)) {
    out.runs = p.runs.map((r) => {
      if (!isObj(r) || !Array.isArray(r.inventory)) return r;
      // One row per id: two rows for the same item is not a shape the run
      // report or the logbook's item strip knows how to draw.
      const rows = new Map();
      for (const entry of r.inventory) {
        if (!isObj(entry)) continue;
        const k = renameItemId(entry.id);
        rows.set(k, { id: k, count: num(rows.get(k)?.count, 0) + num(entry.count, 0) });
      }
      return { ...r, inventory: [...rows.values()] };
    });
  }

  return out;
}

/**
 * Lifetime totals that are *sums*, and so merge as deltas: whatever this tab
 * added since it last saw the disk is added to whatever is on the disk now.
 */
const SUM_STATS = [
  'runs', 'wins', 'deaths', 'timePlayed', 'kills', 'elites', 'bosses',
  'damageDealt', 'damageTaken', 'items', 'gold', 'stagesCleared', 'teleporters',
];

/** Personal bests, which merge as a maximum. */
const MAX_STATS = [
  'bestStage', 'bestTime', 'bestKills', 'highestHit', 'bestLevel', 'bestGold', 'bestItems',
];

/**
 * Which challenges count in seconds.
 *
 * The right home for this is a `format` field on the challenge definition
 * itself, next to `goal` — but `src/data/challenges.js` belongs to the content
 * agents this round, so the mapping lives here, where the two consumers
 * (`_buildReport` and `challengeState`) already are. Both entries are checked
 * against a real definition at module scope below, so if a content change
 * renames or drops one, the console says so rather than the UI silently
 * reverting to raw seconds.
 */
const TIME_GOAL_CHALLENGES = new Set(['marathon', 'clockedIn']);
for (const id of TIME_GOAL_CHALLENGES) {
  if (!CHALLENGE_BY_ID[id]) console.warn(`[profile] no challenge '${id}' to format as a duration`);
}

/** The unit a challenge's progress readout should be drawn in. */
function challengeFormat(id) {
  return TIME_GOAL_CHALLENGES.has(id) ? 'time' : 'number';
}

/**
 * Three-way merge of two profiles that diverged from a common ancestor.
 *
 * `base` is what this tab last saw on disk, `remote` is what is on disk *now*
 * (another tab wrote it), `mine` is this tab's in-memory state. Every field
 * has a join that cannot lose work, chosen from what the field means:
 *
 *  - **sums** (lifetime kills, time played, per-survivor runs, encounter
 *    counts) take `remote + (mine - base)` — each tab's own contribution, once.
 *    This is why the ancestor is kept at all; without it the only safe answer
 *    is `max`, which throws away the smaller tab's play entirely.
 *  - **bests, goals and challenge progress** take the maximum.
 *  - **unlocks, completions and first-seen stamps** take the union, keeping the
 *    *earliest* timestamp, because "when did I first earn this" is a fact about
 *    the player and the later write is not a re-earning.
 *  - **run history** is unioned by its `at` stamp and re-capped, so a completed
 *    run can only be dropped by being older than `MAX_RUNS` other runs — the
 *    same rule a single tab already plays by.
 *
 * Returns the merged profile and whether it contains anything `remote` did
 * not. That flag is what stops two tabs writing back and forth forever: a tab
 * with nothing of its own to contribute adopts the remote copy and goes quiet.
 */
function mergeProfiles(base, remote, mine) {
  const out = freshProfile();
  let tookLocal = false;
  /** Choose `v`, and remember whether it says something `remote` did not. */
  const pick = (v, remoteV) => {
    if (v !== remoteV) tookLocal = true;
    return v;
  };
  const sum = (b, r, m) => Math.max(0, num(r, 0) + (num(m, 0) - num(b, 0)));
  // An unset stamp is 0, and 0 must not win a "first seen" race.
  const earliest = (a, b) => (a > 0 && b > 0 ? Math.min(a, b) : Math.max(num(a, 0), num(b, 0)));

  out.version = PROFILE_VERSION;
  out.createdAt = earliest(num(remote.createdAt, 0), num(mine.createdAt, 0)) || Date.now();
  out.updatedAt = Math.max(num(remote.updatedAt, 0), num(mine.updatedAt, 0));

  for (const type of UNLOCK_TYPES) {
    const r = remote.unlocks[type] || {};
    const m = mine.unlocks[type] || {};
    for (const id of new Set([...Object.keys(r), ...Object.keys(m)])) {
      out.unlocks[type][id] = pick(earliest(num(r[id], 0), num(m[id], 0)), r[id]);
    }
  }

  for (const id of new Set([...Object.keys(remote.challenges), ...Object.keys(mine.challenges)])) {
    const r = remote.challenges[id];
    const m = mine.challenges[id];
    const merged = {
      progress: Math.max(num(r?.progress, 0), num(m?.progress, 0)),
      done: !!(r?.done || m?.done),
      doneAt: earliest(num(r?.doneAt, 0), num(m?.doneAt, 0)),
      goal: Math.max(num(r?.goal, 0), num(m?.goal, 0)),
    };
    if (!r || merged.progress !== r.progress || merged.done !== !!r.done
      || merged.doneAt !== num(r.doneAt, 0) || merged.goal !== num(r.goal, 0)) tookLocal = true;
    out.challenges[id] = merged;
  }

  for (const kind of ENCOUNTER_KINDS) {
    const b = base.encounters?.[kind] || {};
    const r = remote.encounters[kind] || {};
    const m = mine.encounters[kind] || {};
    for (const id of new Set([...Object.keys(r), ...Object.keys(m)])) {
      const merged = {
        at: earliest(num(r[id]?.at, 0), num(m[id]?.at, 0)),
        count: sum(b[id]?.count, r[id]?.count, m[id]?.count),
      };
      if (!r[id] || merged.at !== r[id].at || merged.count !== r[id].count) tookLocal = true;
      out.encounters[kind][id] = merged;
    }
  }

  for (const id of new Set([...Object.keys(remote.survivors), ...Object.keys(mine.survivors)])) {
    const b = base.survivors?.[id];
    const r = remote.survivors[id];
    const m = mine.survivors[id];
    const merged = {
      runs: sum(b?.runs, r?.runs, m?.runs),
      wins: sum(b?.wins, r?.wins, m?.wins),
      deaths: sum(b?.deaths, r?.deaths, m?.deaths),
      kills: sum(b?.kills, r?.kills, m?.kills),
      time: sum(b?.time, r?.time, m?.time),
      bestStage: Math.max(num(r?.bestStage, 0), num(m?.bestStage, 0)),
      bestTime: Math.max(num(r?.bestTime, 0), num(m?.bestTime, 0)),
    };
    if (!r || Object.keys(merged).some((k) => merged[k] !== r[k])) tookLocal = true;
    out.survivors[id] = merged;
  }

  // A run is identified by when it was committed. Two runs cannot end in the
  // same millisecond in the same profile, and across tabs a collision would
  // have to be a millisecond-exact tie — in which case either record is a
  // truthful one and keeping one of them is correct.
  const byAt = new Map();
  for (const r of remote.runs) byAt.set(num(r.at, 0), r);
  for (const r of mine.runs) if (!byAt.has(num(r.at, 0))) { byAt.set(num(r.at, 0), r); tookLocal = true; }
  out.runs = [...byAt.values()].sort((a, b) => num(b.at, 0) - num(a.at, 0)).slice(0, MAX_RUNS);
  // Losing the tail to the cap is not "taking something local" — it is the
  // same trim a single tab performs, and flagging it would write back forever.

  for (const k of Object.keys(out.stats)) {
    const v = SUM_STATS.includes(k)
      ? sum(base.stats?.[k], remote.stats[k], mine.stats[k])
      : Math.max(num(remote.stats[k], 0), num(mine.stats[k], 0));
    out.stats[k] = pick(v, num(remote.stats[k], 0));
  }
  if (!MAX_STATS.every((k) => k in out.stats)) console.warn('[profile] merge stat table is out of date');

  return { data: out, tookLocal };
}

export class Profile {
  constructor() {
    this.data = freshProfile();
    // Unlocks earned this session that no UI has shown yet. B3's toast drains
    // this; nothing else should. Kept off `data` on purpose — it is session
    // state, not profile state, and persisting it would re-toast on reload.
    this._pendingUnlocks = [];
    // Unlocks and completions attributable to the run in flight. Reset at
    // `beginRun`, read once by `commitRun` to build the report.
    this._earnedThisRun = [];
    this._completedThisRun = [];
    // Progress and personal bests as they stood when the run started; the run
    // report is the diff against these.
    this._beforeChallenges = {};
    this._beforeStats = {};
    /** The last committed run's report. Read by the summary screen. */
    this.lastReport = null;
    this._facts = null;
    this._factsAt = 0;
    this._writeTimer = null;
    this._evalTimer = null;
    this._dirty = false;
    // The bytes, and the parsed copy, of what this tab last saw on disk. The
    // ancestor for the cross-tab three-way merge; see `_reconcile`.
    this._baseRaw = null;
    this._baseData = null;
    // Set only by `reset`/`importProfile`, which must overwrite rather than merge.
    this._authoritative = false;
    // Set while a run is in flight. Null between runs so a stray event after
    // the death screen cannot append to a committed run.
    this.run = null;
    this._lastGold = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    this.data = this._load();
    ctx.profile = this;

    const on = (name, fn) => ctx.events.on(name, fn);

    // ---- run-scoped counters ------------------------------------------------
    //
    // These duplicate a few of Progression's own `stats` fields on purpose: the
    // profile needs per-stage counters Progression has no use for, and it keeps
    // lifetime totals Progression's per-run object cannot hold.
    //
    // The old reason given here — that Progression's numbers "correctly count
    // the whole team's work" and only the profile needs a witness filter — is no
    // longer true and was never a rule worth keeping. Progression's `stats` are
    // the *local* survivor's run summary (`_endRun` files it when this machine's
    // player dies), and `goldEarned` is a delta against `_lastGold`, so two
    // purses interleaving on one bus produced a figure belonging to nobody. Both
    // sides now filter on the same predicate (`isLocalOwner`).

    on('stageStart', (e) => this._onStageStart(e));
    on('kill', (e) => this._onKill(e));
    on('damage', (e) => this._onDamage(e));
    // The logbook is a record of what *this player* has met and carried, so
    // every economy channel it reads is owner-filtered. On a host the same bus
    // carries each remote pawn's satellite economy (`Items.of`), and without
    // the test a teammate's loot and a teammate's equipment were written into
    // this machine's permanent profile — unlocks earned by somebody else's run.
    on('itemPickup', (e) => { if (isLocalOwner(ctx, e)) this._onItemPickup(e); });
    // Equipment is a slot, not a stack, so it has no `itemPickup` of its own and
    // was the one catalogue the logbook could never mark as met. `equipmentChanged`
    // is a slot changing (`Items.setEquipment`); which slot is what `owner`
    // answers. `previous` is ignored: putting one down is not meeting it.
    on('equipmentChanged', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      if (typeof e?.id === 'string' && e.id) this.discover('equipment', e.id, 1);
    });
    on('goldChanged', (e) => { if (isLocalOwner(ctx, e)) this._onGold(e); });
    on('bossDead', (e) => this._onBossDead(e));
    on('teleporterComplete', () => this._onTeleporterComplete());
    // A teammate's death is not this run's death; see `isLocalVictim`.
    // Same gap as `Progression`'s: `_onDamage` hangs off `damage`, which a
    // client never sees. Without this a co-op client took no damage all run, so
    // `damageTakenThisStage` stayed 0 and every stage it cleared counted as
    // flawless - `Untouchable` and `Ironclad` unlocked for free.
    on('playerHurt', (e) => {
      if (this.ctx?.authority !== false) return;
      this._onDamage({ target: this.ctx.player, amount: e?.amount ?? 0, toHealth: e?.amount ?? 0 });
    });
    on('playerDead', (p) => { if (this.run && isLocalVictim(this.ctx, p)) this.run.died = true; });

    // Last line of defence for the debounce: a tab closed inside the window
    // would otherwise drop up to WRITE_DEBOUNCE_MS of progress. `pagehide` and
    // a hidden `visibilitychange` are the two that actually fire on mobile and
    // on a killed tab; `unload` does not, reliably.
    //
    // The two events are registered on *different* targets, and that is not a
    // stylistic difference. `pagehide` fires on the window; `visibilitychange`
    // fires on the document and does not propagate to the window, so the bare
    // (window-scoped) `addEventListener` this used to use registered the
    // hidden-tab flush on a target the event never reaches — the half of the
    // net that covers a backgrounded mobile tab was inert for its whole life.
    if (typeof addEventListener === 'function') {
      this._onHide = () => this.flush();
      addEventListener('pagehide', this._onHide);

      // Converge as soon as another tab writes, rather than only at this tab's
      // next flush. Without this the two tabs still cannot lose each other's
      // work — `_reconcile` catches it on the way to disk — but this tab would
      // keep showing a logbook that predates the other tab's unlocks, and a
      // player who closes it without ever earning anything else would never
      // learn otherwise. `key === null` is `localStorage.clear()`, which
      // `_reconcile` treats as "the disk lost the profile, ours is the copy".
      this._onForeignWrite = (e) => {
        if (e && e.key !== null && e.key !== STORE_KEY) return;
        if (this._storageBlocked) return;
        // Write back only if this tab holds something the other one does not —
        // otherwise every tab answers every write and they never settle.
        if (this._reconcile()) { this._dirty = true; this.flush(); }
      };
      addEventListener('storage', this._onForeignWrite);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this._onVisibility = () => {
        if (document.visibilityState === 'hidden') this.flush();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  // ------------------------------------------------------------------ storage

  /**
   * Read the profile, or hand back a fresh one.
   *
   * Every failure mode collapses to the same answer: a player whose storage
   * contains garbage, a half-written blob, an array, a string, or a profile
   * from a build that no longer exists gets a working game. Throwing here would
   * take the whole page down before the first frame, which is a far worse
   * outcome than a lost profile — and this is the exact code path that a
   * quota-exceeded partial write leaves behind.
   */
  _load() {
    let raw = null;
    try {
      // The boot read, and the only place the pre-rename key is looked at: a
      // profile stored under the Petrichor name is adopted here and is a
      // `telluric.*` profile from this line on. `_reconcile` re-reads the new
      // key alone, because by the time another tab can write there is nothing
      // left under the old one.
      raw = adoptLegacyKey(STORE_KEY, LEGACY_STORE_KEY, localStorage);
    } catch {
      // Private mode / storage disabled. Play un-persisted rather than not at all.
      this._storageBlocked = true;
      return freshProfile();
    }
    // Remember the exact bytes this tab started from. `flush` compares against
    // them to notice another tab has written since, and `mergeProfiles` needs
    // the *ancestor* to tell this tab's own contribution from the disk's.
    this._baseRaw = raw;
    const data = raw ? (this._parse(raw) ?? freshProfile()) : freshProfile();
    this._baseData = JSON.parse(JSON.stringify(data));
    return data;
  }

  /**
   * Parse one stored blob into a usable profile, or null if it is not one.
   *
   * Split out of `_load` because the cross-tab reconcile has to read exactly
   * the same way — a foreign write is no more trustworthy than a stored one,
   * and it arrives through the identical migrate/coerce path.
   */
  _parse(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[profile] stored profile is not valid JSON — ignoring it');
      return null;
    }
    // `null`, arrays and primitives all parse cleanly and are all unusable.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[profile] stored profile is not an object — ignoring it');
      return null;
    }

    try {
      return this._coerce(this._migrate(parsed));
    } catch (e) {
      console.warn('[profile] migration failed — ignoring the stored profile:', e);
      return null;
    }
  }

  /**
   * Walk the migration chain from whatever version the blob claims up to
   * PROFILE_VERSION.
   *
   * A version *newer* than this build (the player opened a newer deploy, then
   * an older cached one) is not migrated backwards — there is no honest way to
   * do that. It falls through to `_coerce`, which keeps every field this build
   * understands and drops the rest; the newer build's own fields survive
   * untouched only if it re-adds them, which it will, because it wrote them.
   */
  _migrate(p) {
    let v = Number.isFinite(p.version) ? p.version : 0;
    let out = p;
    let guard = 0;
    while (v < PROFILE_VERSION && guard++ < 64) {
      const step = MIGRATIONS[v];
      if (!step) {
        // A gap in the chain is a bug, not a player problem. Stamp and let
        // `_coerce` normalise; worst case a field or two reverts to default.
        console.warn(`[profile] no migration from v${v} — normalising instead`);
        out = { ...out, version: PROFILE_VERSION };
        break;
      }
      out = step(out);
      v = Number.isFinite(out.version) ? out.version : v + 1;
    }
    return out;
  }

  /**
   * Merge a (possibly ancient, possibly hostile) object onto the fresh
   * defaults, keeping only values of the right type.
   *
   * This is the half of migration that does not need to be written per version:
   * any field added since the blob was saved gets its default, any field
   * removed is dropped, and any field whose stored value is the wrong type
   * (a string where a number belongs, because someone hand-edited storage)
   * cannot poison arithmetic downstream.
   */
  _coerce(p) {
    const out = freshProfile();
    out.createdAt = num(p.createdAt, out.createdAt);
    out.updatedAt = num(p.updatedAt, out.updatedAt);

    if (isObj(p.unlocks)) {
      for (const type of UNLOCK_TYPES) {
        const src = p.unlocks[type];
        if (!isObj(src)) continue;
        for (const id of Object.keys(src)) out.unlocks[type][id] = num(src[id], 0);
      }
    }

    if (isObj(p.challenges)) {
      for (const id of Object.keys(p.challenges)) {
        const c = p.challenges[id];
        if (!isObj(c)) continue;
        out.challenges[id] = {
          progress: Math.max(0, num(c.progress, 0)),
          done: !!c.done,
          doneAt: num(c.doneAt, 0),
          // Zero means "never resolved"; `challengeState` re-resolves in that
          // case rather than drawing a bar against a goal of nothing.
          goal: Math.max(0, num(c.goal, 0)),
        };
      }
    }

    if (isObj(p.encounters)) {
      for (const kind of ENCOUNTER_KINDS) {
        const src = p.encounters[kind];
        if (!isObj(src)) continue;
        for (const id of Object.keys(src)) {
          const e = src[id];
          // Tolerates the v1 shape (a bare timestamp) as well as the v2 one, so
          // a blob that reached here without the migration — a hand-edited
          // store, or a version field somebody deleted — still loads.
          out.encounters[kind][id] = isObj(e)
            ? { at: num(e.at, 0), count: Math.max(0, num(e.count, 0)) }
            : { at: num(e, 0), count: 0 };
        }
      }
    }

    if (isObj(p.survivors)) {
      for (const id of Object.keys(p.survivors)) {
        const s = p.survivors[id];
        if (!isObj(s)) continue;
        out.survivors[id] = {
          runs: Math.max(0, num(s.runs, 0)),
          wins: Math.max(0, num(s.wins, 0)),
          deaths: Math.max(0, num(s.deaths, 0)),
          kills: Math.max(0, num(s.kills, 0)),
          time: Math.max(0, num(s.time, 0)),
          bestStage: Math.max(0, num(s.bestStage, 0)),
          bestTime: Math.max(0, num(s.bestTime, 0)),
        };
      }
    }

    if (Array.isArray(p.runs)) {
      out.runs = p.runs.filter(isObj).slice(0, MAX_RUNS).map((r) => ({
        at: num(r.at, 0),
        survivorId: str(r.survivorId),
        difficultyId: str(r.difficultyId),
        difficulty: num(r.difficulty, 1),
        stage: num(r.stage, 0),
        stageName: str(r.stageName) || '',
        time: num(r.time, 0),
        kills: num(r.kills, 0),
        elites: num(r.elites, 0),
        bosses: num(r.bosses, 0),
        damageDealt: num(r.damageDealt, 0),
        damageTaken: num(r.damageTaken, 0),
        highestHit: num(r.highestHit, 0),
        items: num(r.items, 0),
        gold: num(r.gold, 0),
        level: num(r.level, 1),
        outcome: r.outcome === 'victory' || r.outcome === 'quit' ? r.outcome : 'death',
        corruption: num(r.corruption, 0),
        corruptionBand: num(r.corruptionBand, 0),
        corruptionPeakBand: num(r.corruptionPeakBand, 0),
        inventory: Array.isArray(r.inventory)
          ? r.inventory.filter(isObj).map((i) => ({ id: str(i.id), count: num(i.count, 0) }))
          : [],
      }));
    }

    if (isObj(p.stats)) {
      for (const k of Object.keys(out.stats)) out.stats[k] = Math.max(0, num(p.stats[k], out.stats[k]));
    }

    return out;
  }

  /**
   * Mark the profile changed. The actual write happens on a timer, never in the
   * caller's stack — a kill in a 24-enemy fight must not pay for a
   * `JSON.stringify` of the whole profile.
   */
  _touch() {
    this._dirty = true;
    if (this._writeTimer !== null) return;
    this._writeTimer = setTimeout(() => { this._writeTimer = null; this.flush(); }, WRITE_DEBOUNCE_MS);
  }

  /**
   * Write now. Safe to call at any time; a no-op when nothing changed.
   *
   * The serialised payload is bounded by construction (MAX_RUNS runs, and id
   * maps whose size is the content catalogue), so this is a sub-millisecond
   * stringify — but it still only ever runs on a timer or on page hide, never
   * inside a frame.
   */
  /**
   * Fold in anything another tab has written since this one last touched disk.
   *
   * Every tab of the same origin shares one `localStorage`, holds its own
   * in-memory snapshot taken at `init()`, and used to `setItem` that snapshot
   * over whatever was there. Two tabs open at once — a duplicated tab, a
   * restored session, a player checking a build in a second window — meant the
   * one that wrote *last* won in full: a 25-kill profile was silently replaced
   * by a 13-kill one, and an unlock earned in the losing tab was gone with no
   * error and no way for either tab to know.
   *
   * So the write is now a compare-and-merge, not an overwrite. The compare is
   * the raw bytes: if the disk still holds exactly what this tab last read or
   * wrote, nobody else has been here and the write is unconditional. If it has
   * moved, the two profiles are merged against their common ancestor (see
   * `mergeProfiles`) and the merge is what gets written.
   *
   * Returns whether the merge kept anything the disk did not already have.
   */
  _reconcile() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch {
      return false;
    }
    if (raw === this._baseRaw) return false;
    const remote = raw ? this._parse(raw) : null;
    // Unreadable, or cleared out from under us. This tab's copy is the only
    // usable profile left, so it is the one that gets written.
    if (!remote) { this._baseRaw = raw; return true; }
    const { data, tookLocal } = mergeProfiles(this._baseData || freshProfile(), remote, this.data);
    this.data = data;
    // Anything derived from the profile was computed against the pre-merge copy.
    this._facts = null;
    this._baseRaw = raw;
    this._baseData = remote;
    return tookLocal;
  }

  flush() {
    if (!this._dirty || this._storageBlocked) return;
    this._dirty = false;
    // `reset()` and `importProfile()` are deliberate replacements — the player
    // asked for this profile to *become* something. Merging a wipe against the
    // copy it is wiping would undo it.
    if (this._authoritative) this._authoritative = false;
    else this._reconcile();
    this.data.updatedAt = Date.now();
    try {
      const json = JSON.stringify(this.data);
      localStorage.setItem(STORE_KEY, json);
      // The bytes we just wrote are the new ancestor: the next divergence is
      // measured from here, not from whatever this tab loaded at boot.
      this._baseRaw = json;
      this._baseData = JSON.parse(json);
    } catch (e) {
      // Quota, private mode, or a storage partition that went away mid-session.
      // Stop retrying every 1.5s; the run still plays, it just will not persist.
      this._storageBlocked = true;
      console.warn('[profile] could not persist profile — continuing without saving:', e);
    }
  }

  // ------------------------------------------------- read API (for the UI, B3)

  /**
   * Is this content available to the player?
   *
   * **The default is unlocked.** Only an id that some challenge names as its
   * reward is gated, and only until that challenge is complete. This is the
   * single most important line in the file for the content agents: adding a
   * survivor, item or artifact does not lock it — writing a challenge that
   * rewards it does. It also means the pre-binding state of `challenges.js`
   * (rewards not yet wired to real ids) leaves the whole game playable rather
   * than leaving it all locked behind challenges that name nothing.
   */
  isUnlocked(type, id) {
    if (!id) return true;
    if (this.data.unlocks[type]?.[id]) return true;
    const gate = gateFor(type, id);
    return !gate;
  }

  /** Every id the player has explicitly earned in `type`, oldest first. */
  unlockedIds(type) {
    const m = this.data.unlocks[type];
    if (!m) return [];
    return Object.keys(m).sort((a, b) => m[a] - m[b]);
  }

  /**
   * Grant an unlock. Returns true only the first time, which is what the toast
   * should key off — calling this on every run start is intentionally cheap and
   * silent after the first.
   */
  unlock(type, id, { challenge = null, silent = false } = {}) {
    if (!id || !this.data.unlocks[type]) return false;
    if (this.data.unlocks[type][id]) return false;
    this.data.unlocks[type][id] = Date.now();
    this._touch();
    if (!silent) {
      const entry = { type, id, challenge, name: unlockName(type, id) };
      this._pendingUnlocks.push(entry);
      // The run report wants "earned during *this run*", which is a shorter
      // window than the session `_pendingUnlocks` covers — a player who opened
      // the logbook and closed it has drained nothing, and a run that unlocked
      // nothing must not inherit the previous run's ribbon.
      this._earnedThisRun.push(entry);
      this.ctx?.events?.emit?.('unlockEarned', entry);
    }
    return true;
  }

  /**
   * The full state of one challenge, ready to render.
   *
   * A hidden challenge that is not yet complete is returned with its name and
   * description masked, because that is the whole point of hiding it — the UI
   * must not have to remember to do this, or one screen will leak it.
   */
  challengeState(id) {
    const def = CHALLENGE_BY_ID[id];
    if (!def) return null;
    const st = this.data.challenges[id];
    // A challenge completed against an older, smaller catalogue keeps the goal
    // it was completed against — re-resolving it would redraw a finished bar as
    // unfinished the day someone adds the twenty-third monster.
    const goal = st?.goal > 0 ? st.goal : goalOf(def, this.facts());
    const progress = Math.min(goal, st?.progress ?? 0);
    const done = !!st?.done;
    const masked = def.hidden && !done;
    const reward = def.unlocks
      ? { ...def.unlocks, name: unlockName(def.unlocks.type, def.unlocks.id) }
      : null;
    return {
      id: def.id,
      name: masked ? '???' : def.name,
      description: masked ? 'Hidden challenge.' : def.description,
      category: def.category || 'career',
      hidden: !!def.hidden,
      masked,
      progress,
      goal,
      // The unit `progress`/`goal` are counted in, so the logbook's list row and
      // detail panel can print a duration as a duration.
      format: challengeFormat(def.id),
      fraction: goal > 0 ? progress / goal : 0,
      done,
      doneAt: st?.doneAt ?? 0,
      unlocks: reward,
    };
  }

  /** Every challenge, in definition order. */
  challengeStates() {
    return CHALLENGES.map((c) => this.challengeState(c.id));
  }

  /**
   * The derived career view handed to every `track` as its third argument, and
   * to `goalOf` for the catalogue-sized goals.
   *
   * Memoised for one animation frame's worth of calls. `_evaluate` runs up to
   * four times a second in a fight and `challengeState` is called once per row
   * when the logbook opens; recomputing the distinct counts on each of those is
   * a handful of `Object.keys` over maps whose size is the content catalogue,
   * which is cheap but not free, and none of the inputs can change between two
   * calls in the same tick.
   */
  facts() {
    const now = Date.now();
    if (this._facts && now - this._factsAt < 100) return this._facts;
    const distinct = {};
    for (const kind of ENCOUNTER_KINDS) distinct[kind] = Object.keys(this.data.encounters[kind] || {}).length;

    let survivorsPlayed = 0;
    for (const id of Object.keys(this.data.survivors)) {
      if (this.data.survivors[id].runs > 0) survivorsPlayed++;
    }

    this._facts = {
      distinct,
      // Sizes come from the registry rather than from anything persisted: they
      // are a property of the *build*, and a stale copy in the save file would
      // let a "collect every item" challenge complete against last week's
      // catalogue.
      catalogue: catalogueSizes(),
      survivorRuns: this.data.survivors,
      survivorsPlayed,
    };
    this._factsAt = now;
    return this._facts;
  }

  /** Has the player ever seen this piece of content? Drives logbook greying. */
  isDiscovered(kind, id) { return !!this.data.encounters[kind]?.[id]; }

  /**
   * How many of this thing the player has met, and when they first did.
   * Null for something never encountered, so the UI can tell "zero" from
   * "no record" without a second call.
   */
  encounter(kind, id) {
    const e = this.data.encounters[kind]?.[id];
    return e ? { at: e.at, count: e.count } : null;
  }

  /**
   * Record an encounter. Returns true only the first time — the run report's
   * "new this run" counts key off that, and everything else wants the count.
   *
   * `n` is the number to add to the tally, which is 1 for a kill and 1 per
   * stack for an item pickup. It is separate from the first-seen stamp on
   * purpose: an item picked up in a stack of three is one discovery and three
   * pickups, and collapsing those loses the more interesting of the two.
   */
  discover(kind, id, n = 1) {
    if (!id) return false;
    const m = this.data.encounters[kind];
    if (!m) return false;
    const first = !m[id];
    if (first) m[id] = { at: Date.now(), count: 0 };
    m[id].count += Math.max(0, n);
    // Invalidate the derived view: a first sighting moves a distinct count, and
    // a survey challenge evaluated against the memo would miss the tick it
    // completed on.
    if (first) { this._facts = null; if (this.run) this.run.discoveries[kind] = (this.run.discoveries[kind] || 0) + 1; }
    this._touch();
    return first;
  }

  /** Newest first. A defensive copy — the UI must not be able to edit history. */
  runHistory() { return this.data.runs.map((r) => ({ ...r })); }

  /** Lifetime aggregate stats. Copy, same reason. */
  lifetime() { return { ...this.data.stats }; }

  /**
   * One survivor's career row, or a zeroed one for a survivor never played.
   * Never null, so the logbook can render the line unconditionally — a roster
   * entry with no row is a survivor at zero, not a survivor with no record.
   */
  survivorCareer(id) {
    const r = this.data.survivors[id];
    return r ? { ...r } : { runs: 0, wins: 0, deaths: 0, kills: 0, time: 0, bestStage: 0, bestTime: 0 };
  }

  /**
   * Drain the unlocks earned since the last call. B3's notification toast owns
   * this; draining is what stops the same unlock being announced twice.
   */
  drainPendingUnlocks() {
    const out = this._pendingUnlocks;
    this._pendingUnlocks = [];
    return out;
  }

  /** Live counters for the run in flight, or null between runs. */
  currentRun() { this._syncRunClock(); return this.run ? { ...this.run } : null; }

  /**
   * Pull the run clock off the simulation.
   *
   * `run.time` is the field every "…in a single run" challenge reads as
   * `r.time`, and nothing pushed it: `Progression` owns the clock and only ever
   * wrote its own `stats.time`, which reaches the *persisted record* at
   * `commitRun` and never reaches the live object the `track` functions are
   * handed. So `marathon` ("survive 30 minutes") could not advance on any run
   * of any length, and `blitz` ("reach stage 5 within 10 minutes") had its time
   * half satisfied by a permanent zero and collapsed to "reach stage 5".
   *
   * Pulled rather than pushed because `Profile` is not a registered system and
   * has no frame of its own; every reader of `run.time` goes through
   * `_evaluate` or `currentRun`, so sampling there is exactly as fresh as a
   * per-frame copy would be and costs nothing between events.
   *
   * `ctx.time` is the raw simulation clock — the same value the persisted
   * record's `time` is taken from, so the challenge and the run history can
   * never disagree — and it only advances while unpaused, so a run does not
   * accrue minutes on the title screen or in a menu. Monotonic on purpose: a
   * run clock never runs backwards, and the harness sets `ctx.time` by hand.
   */
  _syncRunClock() {
    if (!this.run) return;
    const t = num(this.ctx?.time, 0);
    if (t > this.run.time) this.run.time = t;
  }

  /** Wipe everything. Used by the settings screen; there is no undo. */
  reset() {
    this.data = freshProfile();
    this._pendingUnlocks = [];
    this._earnedThisRun = [];
    this._completedThisRun = [];
    this._beforeChallenges = {};
    this._beforeStats = {};
    this.lastReport = null;
    // The derived view is a cache of data that no longer exists.
    this._facts = null;
    this._dirty = true;
    // A wipe is not a divergence to be merged away.
    this._authoritative = true;
    this.flush();
  }

  /**
   * The whole profile as one JSON-safe object.
   *
   * `docs/STEAM.md` wants a native build to be able to lift the save wholesale
   * rather than reconstruct it from a set of keys, and a browser build to be
   * able to hand a player their own data. This is that seam: the same bytes
   * `flush` writes, and the same shape `_load` accepts back.
   */
  exportProfile() { return JSON.parse(JSON.stringify(this.data)); }

  /**
   * Replace the profile from an exported blob, running it through the same
   * migration and coercion path a stored one takes. Returns false — and changes
   * nothing — if the blob is unusable, because a failed import that wiped the
   * player's actual profile would be the worst bug in the file.
   */
  importProfile(blob) {
    if (!isObj(blob)) return false;
    let next;
    try {
      next = this._coerce(this._migrate(blob));
    } catch (e) {
      console.warn('[profile] import rejected:', e);
      return false;
    }
    this.data = next;
    this._facts = null;
    this._dirty = true;
    // The player handed us this file to *be* their profile; merging the copy it
    // replaces back into it would make the import a partial one.
    this._authoritative = true;
    this.flush();
    return true;
  }

  // --------------------------------------------------------- run lifecycle

  /**
   * Called from the first `stageStart` of the session, whatever its index — a
   * client that joins a host mid-run starts its own run record at stage 7, and
   * that run is real play that should count.
   */
  beginRun() {
    if (this.run) return;
    const ctx = this.ctx;
    this.run = {
      startedAt: Date.now(),
      // Both of these are null until A1 lands survivors and B2/B3 land
      // difficulty selection. Read rather than assumed: inventing an id here
      // would put a wrong one in every run record written before then.
      survivorId: ctx?.player?.survivorId ?? ctx?.survivorId ?? null,
      difficultyId: ctx?.difficultyId ?? null,
      time: 0, kills: 0, elites: 0, bosses: 0,
      damageDealt: 0, damageTaken: 0, highestHit: 0,
      items: 0, goldEarned: 0, stagesCleared: 0,
      stageIndex: 0, maxStageIndex: 0, teleporters: 0,
      // Reset at every stage boundary; `flawlessStages` is the counter a
      // "clear a stage untouched" challenge reads.
      damageTakenThisStage: 0, flawlessStages: 0,
      // Best kills inside any ten-second window this run, and the sliding
      // window it is measured from. The window is a wall-clock one rather than
      // a `ctx.time` one because it must not stop counting while the game is
      // paused *or* keep counting through a menu — `Date.now()` on a kill event
      // is only advanced by kills, so a paused game simply produces no samples.
      bestKillBurst: 0, killTimes: [],
      // kind -> how many *first* sightings happened during this run.
      discoveries: {},
      died: false,
    };
    // Snapshot the before-state the report is a diff against. Taken here rather
    // than at `commitRun` for the obvious reason: by then the after-state has
    // already overwritten it.
    this._earnedThisRun = [];
    this._completedThisRun = [];
    this._beforeStats = { ...this.data.stats };
    this._beforeChallenges = {};
    for (const id of Object.keys(this.data.challenges)) {
      const st = this.data.challenges[id];
      this._beforeChallenges[id] = { progress: st.progress, done: st.done };
    }
    if (this.run.survivorId) this.discover('survivor', this.run.survivorId, 0);
    this._lastGold = 0;
  }

  /**
   * Commit the run. Called by Progression on death or victory; idempotent, so a
   * `playerDead` immediately followed by a run-end event writes one record.
   */
  commitRun(won, stats = {}) {
    const run = this.run;
    if (!run) return null;
    // Last sample before the live object is let go: from here on `_evaluate`
    // has nothing to pull from, so the "…in a single run" challenges must see
    // the clock's final value on this pass.
    this._syncRunClock();
    this.run = null;

    const record = {
      at: Date.now(),
      survivorId: run.survivorId,
      difficultyId: run.difficultyId,
      difficulty: num(stats.difficulty, 1),
      stage: num(stats.stage, run.maxStageIndex + 1),
      stageName: str(stats.stageName) || '',
      time: num(stats.time, run.time),
      kills: run.kills,
      elites: run.elites,
      bosses: run.bosses,
      damageDealt: Math.round(run.damageDealt),
      damageTaken: Math.round(run.damageTaken),
      highestHit: Math.round(run.highestHit),
      items: run.items,
      gold: num(stats.gold, 0),
      level: num(this.ctx?.progression?.level, 1),
      outcome: won ? 'victory' : 'death',
      // The run's corruption record, persisted rather than derived-and-dropped:
      // `cleanVictory` below is decided from the peak band, and a granted (or
      // refused) Vigil should leave the evidence behind it in the logbook.
      corruption: num(stats?.corruption, 0),
      corruptionBand: num(stats?.corruptionBand, 0),
      corruptionPeakBand: num(stats?.corruptionPeakBand, 0),
      inventory: Array.isArray(stats.inventory)
        ? stats.inventory.map((i) => ({ id: str(i.id), count: num(i.count, 0) }))
        : [],
    };

    this.data.runs.unshift(record);
    if (this.data.runs.length > MAX_RUNS) this.data.runs.length = MAX_RUNS;

    const s = this.data.stats;
    s.runs++;
    if (won) s.wins++; else s.deaths++;
    s.timePlayed += record.time;
    s.bestStage = Math.max(s.bestStage, record.stage);
    s.bestTime = Math.max(s.bestTime, record.time);
    s.bestKills = Math.max(s.bestKills, record.kills);
    s.bestLevel = Math.max(s.bestLevel, record.level);
    s.bestGold = Math.max(s.bestGold, record.gold);
    s.bestItems = Math.max(s.bestItems, record.items);

    // Per-survivor career. Written before the challenge pass, because the
    // generated mastery challenges read exactly this table and the run that
    // reaches stage 5 must be the run that completes its own mastery — not the
    // one after it.
    if (record.survivorId) {
      const row = this.data.survivors[record.survivorId] || (this.data.survivors[record.survivorId] = {
        runs: 0, wins: 0, deaths: 0, kills: 0, time: 0, bestStage: 0, bestTime: 0,
      });
      row.runs++;
      if (won) row.wins++; else row.deaths++;
      row.kills += record.kills;
      row.time += record.time;
      row.bestStage = Math.max(row.bestStage, record.stage);
      row.bestTime = Math.max(row.bestTime, record.time);
      // The survivor's encounter count is "runs played as them", which is what
      // the logbook's roster line wants to say.
      this.discover('survivor', record.survivorId, 1);
      // A new row moves `survivorsPlayed`, which `wholeRoster` tracks.
      this._facts = null;
    }

    // Restraint's proof, written onto the run block the instant before the last
    // evaluation can read it: a Fracture finale carried home by a world that
    // never went past Seeded. Three things must all hold, and each fails closed:
    //
    //   * `won` — a defeat can never set it, however spotless.
    //   * the ending is a named Fracture finale (see FINALE_VICTORY_ENDINGS) —
    //     `won` alone also covers the Obelisk's stage-1 exit, which the row's
    //     wording promises does not count.
    //   * the band is a real band at or under the line. Anything that is not a
    //     whole number in range — missing, NaN, Infinity, a string — declines,
    //     because the failure direction for the game's one unbuyable card must
    //     be "not earned", not "handed out".
    //
    // The band tested is the run's PEAK (`corruptionPeakBand`), not the one it
    // ended in. Reading the ending band made the card buyable: rot the world all
    // run for the loot and the mutations, then launder it back down at the
    // guaranteed fonts on the way to the door and collect the artifact awarded
    // for never having needed them. The peak is what "unbroken" means, and it
    // leaves the redemption arc intact — laundering still buys the clean route,
    // the easier Herald and the ending; it just no longer buys this card.
    //
    // `stats` is Progression's snapshot at the ending (`runStats()`), which
    // carries `ending`, `corruptionBand` and `corruptionPeakBand`. This is the
    // only writer, and the `unbrokenSeal` challenge (data/challenges.js) is the
    // only reader.
    const band = stats?.corruptionPeakBand;
    run.cleanVictory = won
      && FINALE_VICTORY_ENDINGS.has(stats?.ending)
      && Number.isInteger(band) && band >= 0 && band <= CLEAN_ENDING_BAND
      ? 1 : 0;

    // Final evaluation before the run counters are gone: a challenge phrased
    // "…in a single run" can only be true at this instant.
    this._facts = null;
    this._evaluate(run, true);
    this.lastReport = this._buildReport(record, run);
    this._touch();
    // The death screen is up and the player is about to alt-tab; do not sit on
    // the debounce with a whole run's progress unwritten.
    this.flush();
    return record;
  }

  /**
   * What this run changed, in the order a player cares about it.
   *
   * The whole file exists so that this method can be honest. Everything here is
   * a diff against a snapshot taken at `beginRun` — nothing is inferred, and a
   * run that changed nothing produces a report whose arrays are all empty,
   * which is the signal the summary screen uses to show nothing rather than to
   * show an empty heading.
   */
  _buildReport(record, run) {
    const before = this._beforeChallenges;
    const advanced = [];
    for (const id of Object.keys(this.data.challenges)) {
      const st = this.data.challenges[id];
      // Completions are reported separately and would otherwise appear twice.
      if (st.done) continue;
      const was = before[id]?.progress ?? 0;
      if (st.progress <= was) continue;
      const def = CHALLENGE_BY_ID[id];
      if (!def || (def.hidden && !st.done)) continue;
      advanced.push({
        id, name: def.name, from: was, to: st.progress, goal: st.goal || goalOf(def, this.facts()),
        // Same tag `records` below carries, for the same reason: `marathon`'s
        // progress is seconds, and "1,074 / 1,800" on the one readout built to
        // answer "how close am I" is a number the player has to divide by 60 in
        // their head. See `challengeFormat`.
        format: challengeFormat(id),
      });
    }
    // Closest to done first: the row a player is one run away from is the row
    // that makes them press restart, and it is not usually the row that moved
    // the most.
    advanced.sort((a, b) => (b.to / b.goal) - (a.to / a.goal));

    // Personal bests, phrased as "you beat your own number" rather than as the
    // number itself. A best that was already held is not news and is omitted;
    // the *first* run of a profile beats every best trivially, so a zero
    // previous value is reported as a first rather than as a record.
    const bs = this._beforeStats;
    const s = this.data.stats;
    const records = [];
    const best = (key, label, value, format) => {
      if (!(value > (bs[key] ?? 0))) return;
      records.push({ key, label, value, previous: bs[key] ?? 0, format: format || 'number' });
    };
    best('bestStage', 'Deepest stage', s.bestStage);
    best('bestTime', 'Longest run', s.bestTime, 'time');
    best('bestKills', 'Most kills', s.bestKills);
    best('highestHit', 'Biggest hit', Math.round(s.highestHit));
    best('bestItems', 'Largest haul', s.bestItems);
    best('bestGold', 'Richest run', s.bestGold);

    const discoveries = [];
    for (const kind of ENCOUNTER_KINDS) {
      const n = run.discoveries[kind] || 0;
      if (n > 0) discoveries.push({ kind, count: n });
    }

    return {
      at: record.at,
      runNumber: s.runs,
      outcome: record.outcome,
      unlocks: this._earnedThisRun.slice(),
      completed: this._completedThisRun.slice(),
      // Both lists are capped, and the caps are here rather than in the
      // renderer because they are a statement about *attention*, not about
      // layout: three near-misses is a shortlist a player reads, and eight is a
      // table they skip. The measured consequence of not capping was concrete —
      // a first run beats all six bests at once and advances a dozen
      // challenges, and the resulting readout pushed the summary panel's own
      // buttons off the bottom of a 1600x900 frame.
      advanced: advanced.slice(0, 3),
      records: records.slice(0, 4),
      discoveries,
      // The career line: what this run did to the totals. Cheap to compute here
      // and impossible to compute later, once the summary is the only thing
      // holding a reference to the run.
      lifetime: { runs: s.runs, wins: s.wins, kills: s.kills, timePlayed: s.timePlayed },
    };
  }

  /** The last committed run's report, or null before the first run ends. */
  report() { return this.lastReport; }

  // ---------------------------------------------------------- event handlers

  /**
   * Did the local player cause this?
   *
   * In single-player everything is local by definition. In co-op the event bus
   * carries the host's replicated facts too, so a client would otherwise be
   * credited kills and damage it merely watched. Procs and summons name the
   * player as `owner`, so those count; a null source (fall damage, a hazard) is
   * nobody's credit and is excluded from *earned* counters.
   */
  _isLocalSource(src) {
    if (!this.ctx || this.ctx.netRole === 'single') return true;
    if (!src) return false;
    const me = this.ctx.player;
    return !!me && (src === me || src.owner === me);
  }

  _onStageStart(e) {
    const first = !this.run;
    this.beginRun();
    const run = this.run;
    if (!run) return;
    const index = Number.isFinite(e?.index) ? e.index : 0;
    // The first `stageStart` of a session opens the run *at* that index rather
    // than at zero. A client joining a host on stage 7 receives one
    // `stageStart` with index 7, and treating that as an arrival from stage 0
    // would credit it seven stage clears it did not play.
    if (first) {
      run.stageIndex = index;
      run.maxStageIndex = index;
      run.damageTakenThisStage = 0;
      this._touch();
      return;
    }
    // A stage the player *left* counts as cleared; the first stage of the run
    // is an arrival, not a clear.
    if (index > run.stageIndex) {
      run.stagesCleared++;
      this.data.stats.stagesCleared++;
      if (run.damageTakenThisStage <= 0) run.flawlessStages++;
    }
    run.stageIndex = index;
    run.maxStageIndex = Math.max(run.maxStageIndex, index);
    run.damageTakenThisStage = 0;
    this._evaluate(run, true);
    this._touch();
  }

  /**
   * Record a monster sighting, but only for a monster the bestiary knows.
   *
   * `fieldGuide` and `apexSurvey` are fractions: the numerator is
   * `distinct('enemy'|'boss')` and the denominator is `catalogue('enemy'|'boss')`,
   * which is sized off `SPAWN_CARDS`/`BOSS_CARDS`. Those two arrays exclude the
   * `special: true` finale monsters (anchor, warden_vault, herald) — placed by
   * name, never rolled — so a Herald kill used to move the numerator while
   * leaving the denominator alone, and "defeat every kind of teleporter boss"
   * could read 6/6 with one of the six never fought.
   *
   * One definition of "content", applied to both halves, and it is the
   * catalogue's: the logbook lists exactly these arrays too, so anything
   * excluded here was never displayable as a bestiary entry in the first place.
   * Filtering the numerator rather than growing the denominator is the choice
   * that keeps the survey goals at the counts they already ship with, and keeps
   * a bestiary challenge from quietly requiring a full clear of the game.
   */
  _discoverMonster(kind, id) {
    if (!catalogueHas(kind, id)) return false;
    return this.discover(kind, id);
  }

  _onKill(e) {
    const run = this.run;
    if (!run || e?.victim?.isPlayer) return;
    // Discovery is a "have I seen this" fact and is credited on sight, host or
    // client — a client that watched a Colossus die has seen a Colossus.
    const vid = e?.victim?.def?.id ?? e?.victim?.id;
    if (typeof vid === 'string') this._discoverMonster(e.isBoss ? 'boss' : 'enemy', vid);

    if (!this._isLocalSource(e?.source)) return;
    run.kills++;
    this.data.stats.kills++;
    if (e.isElite) { run.elites++; this.data.stats.elites++; }

    // Sliding ten-second window. An array of timestamps rather than a counter
    // with a reset, because a tumbling window silently undercounts every burst
    // that straddles a boundary — and a boss room clear is exactly the kind of
    // ten seconds that lands wherever it likes. The array is bounded by how
    // many things can die in ten seconds, so the shift loop is a handful of
    // elements even in a horde.
    const now = Date.now();
    const times = run.killTimes;
    times.push(now);
    while (times.length && now - times[0] > BURST_WINDOW_MS) times.shift();
    if (times.length > run.bestKillBurst) run.bestKillBurst = times.length;

    this._scheduleEval();
  }

  _onDamage(e) {
    const run = this.run;
    if (!run) return;
    const amount = num(e?.amount, 0);
    if (amount <= 0) return;
    if (e?.target?.isPlayer) {
      // Only damage to *this* client's own survivor. On a client the event
      // stream includes every player's hits, and "took no damage this stage"
      // must mean this player.
      if (e.target !== this.ctx?.player && this.ctx?.netRole !== 'single') return;
      // A hit a barrier ate whole is not damage taken. `amount` is what the
      // attack carried; `toHealth` is what reached the survivor, and the two
      // differ by exactly the absorbed part. Counting the former made
      // `untouchable` and `ironclad` unachievable for anyone holding a barrier
      // item -- the shield did its job and the challenge punished them for it.
      const taken = num(e?.toHealth ?? e?.amount, 0);
      if (taken <= 0) return;
      run.damageTaken += taken;
      run.damageTakenThisStage += taken;
      this.data.stats.damageTaken += taken;
    } else if (e?.source?.isPlayer) {
      if (!this._isLocalSource(e.source)) return;
      run.damageDealt += amount;
      this.data.stats.damageDealt += amount;
      if (amount > run.highestHit) run.highestHit = amount;
      if (amount > this.data.stats.highestHit) this.data.stats.highestHit = amount;
    } else {
      return;
    }
    this._scheduleEval();
  }

  _onItemPickup(e) {
    const run = this.run;
    // `reason: 'corrupt'` is the blight transform moving stacks the player
    // already owns from one id to another. Nothing was acquired, so it feeds no
    // counter — not the run's, and least of all `data.stats.items`, which is
    // persisted and drives achievement evaluation: a band crossing was booking
    // four lifetime items for a conversion the player never chose, and scoring
    // the *emptied* base as one of them because `count: 0` floors to 1 below.
    //
    // The logbook is the single exception, and only for copies that genuinely
    // arrive (`delta > 0`): the player is holding that blight card now, which
    // is what "met" means. The emptied side discovers nothing.
    if (e?.reason === 'corrupt') {
      const arrived = num(e?.delta, 0);
      if (arrived > 0 && typeof e?.id === 'string') this.discover('item', e.id, arrived);
      return;
    }
    // `itemPickup` is replicated as *this* client's inventory change (see
    // NETCODE.md), so there is no witness filter to apply here.
    const count = Math.max(1, num(e?.count, 1));
    if (typeof e?.id === 'string') this.discover('item', e.id, count);
    if (!run) return;
    run.items += count;
    this.data.stats.items += count;
    this._scheduleEval();
  }

  _onGold(e) {
    const run = this.run;
    if (!run) return;
    const gold = num(e?.gold, 0);
    const delta = gold - this._lastGold;
    this._lastGold = gold;
    // Only income. Spending at a chest must not read as negative earnings.
    if (delta > 0) { run.goldEarned += delta; this.data.stats.gold += delta; }
    this._scheduleEval();
  }

  _onBossDead(e) {
    const run = this.run;
    const bid = e?.enemy?.def?.id ?? e?.enemy?.id;
    if (typeof bid === 'string') this._discoverMonster('boss', bid);
    if (!run) return;
    // Shared credit: everyone in the fight downed the boss.
    run.bosses++;
    this.data.stats.bosses++;
    this._evaluate(run, true);
    this._touch();
  }

  _onTeleporterComplete() {
    const run = this.run;
    if (!run) return;
    run.teleporters++;
    this.data.stats.teleporters++;
    this._evaluate(run, true);
    this._touch();
  }

  // -------------------------------------------------------------- challenges

  /**
   * Coalesce evaluation. High-frequency counters (`damage`, `kill`) call this;
   * milestones call `_evaluate` directly because a player who just cleared a
   * stage should see the toast on the same frame the banner appears.
   */
  _scheduleEval() {
    this._touch();
    if (this._evalTimer !== null) return;
    this._evalTimer = setTimeout(() => {
      this._evalTimer = null;
      if (this.run) this._evaluate(this.run);
    }, EVAL_DEBOUNCE_MS);
  }

  /**
   * Run every incomplete challenge's `track` against (lifetime stats, run
   * stats) and take the high-water mark.
   *
   * High-water rather than last-value on purpose: a run-scoped challenge like
   * "30 items in one run" reports 30 during the run and 0 once the run ends, and
   * a naive assignment would erase it. Progress therefore only ever climbs, and
   * a completed challenge is never re-evaluated at all.
   */
  _evaluate(runStats, force = false) {
    this._syncRunClock();
    const stats = this.data.stats;
    const store = this.data.challenges;
    const facts = this.facts();
    let changed = false;

    for (const def of CHALLENGES) {
      let st = store[def.id];
      if (st?.done) continue;
      let progress = 0;
      try {
        progress = num(def.track(stats, runStats, facts), 0);
      } catch (e) {
        // A broken predicate must cost that challenge, not the profile. This is
        // the same posture Engine takes with a throwing system.
        console.warn(`[profile] challenge "${def.id}" threw while tracking:`, e);
        continue;
      }
      if (!st) { st = store[def.id] = { progress: 0, done: false, doneAt: 0, goal: 0 }; }
      // Re-resolved on every pass while incomplete: a catalogue-sized goal grows
      // when content is added, and a bar drawn against last session's smaller
      // catalogue would sit at 100% without completing.
      const goal = goalOf(def, facts);
      if (st.goal !== goal) { st.goal = goal; changed = true; }
      if (progress <= st.progress && !force) continue;
      // Per-challenge, not the loop-wide `changed`: the first evaluation of a
      // session resolves every dynamic goal and so sets `changed` on the first
      // row, which would then announce "progress" on every later row in the
      // list whether or not any of them had moved.
      let advanced = false;
      if (progress > st.progress) { st.progress = progress; changed = advanced = true; }

      if (st.progress >= goal) {
        st.done = true;
        st.doneAt = Date.now();
        changed = true;
        this._completedThisRun.push({ id: def.id, name: def.name });
        this.ctx?.events?.emit?.('challengeComplete', { id: def.id, name: def.name });
        if (def.unlocks) this.unlock(def.unlocks.type, def.unlocks.id, { challenge: def.id });
      } else if (advanced) {
        this.ctx?.events?.emit?.('challengeProgress', {
          id: def.id, progress: st.progress, goal,
        });
      }
    }
    if (changed) this._touch();
  }
}

// --------------------------------------------------------------------- helpers

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v) => (typeof v === 'string' ? v : null);

/**
 * Which challenge, if any, gates this (type, id)?
 *
 * Built lazily and cached, and deliberately *not* frozen at module load: the
 * content agents bind rewards by mutating `UNLOCK_BINDINGS` in challenges.js and
 * calling `applyUnlockBindings()`, which invalidates this. See the extension
 * point at the bottom of `src/data/challenges.js`.
 */
let _gates = null;
let _gatesStamp = -1;
function gateFor(type, id) {
  if (_gates === null || _gatesStamp !== bindingStamp()) {
    _gates = new Map();
    for (const c of CHALLENGES) {
      if (c.unlocks) _gates.set(`${c.unlocks.type}:${c.unlocks.id}`, c.id);
    }
    _gatesStamp = bindingStamp();
  }
  return _gates.get(`${type}:${id}`) || null;
}
