import { CHALLENGES, CHALLENGE_BY_ID, UNLOCK_TYPES, bindingStamp } from '../data/challenges.js';

/**
 * The persistent player profile — everything that outlives a run.
 *
 * This is the **only** module in the codebase that touches localStorage for
 * meta state (`src/ui/Menus.js` owns the settings blob, and `GpuNotice.js` owns
 * one dismissal flag; neither overlaps with anything here). Keeping it to one
 * owner is what makes schema migration tractable: there is exactly one reader,
 * one writer, and one version number.
 *
 * Four things live in here:
 *
 *  - **unlocks** — which survivors / items / equipment / artifacts the player
 *    has earned. Note the default is *unlocked*: see `isUnlocked`.
 *  - **challenge progress** — counters that survive across runs, advanced from
 *    the event bus rather than polled.
 *  - **run history** — the last `MAX_RUNS` runs, for the logbook's run list.
 *  - **lifetime stats** — the aggregate roll-up, plus the personal bests.
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
export const PROFILE_VERSION = 1;

// Versioned in the key as well as in the payload. If a future shape is ever so
// different that migration is not worth writing, the key changes and the old
// blob is simply left on disk rather than mangled.
const STORE_KEY = 'petrichor.profile.v1';

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
    // id -> { progress, done, doneAt }
    challenges: {},
    // Logbook "have I ever seen this" set, per kind. Populated from play, so it
    // needs no id list of its own and cannot drift from the content data.
    discovered: { item: {}, equipment: {}, enemy: {}, boss: {}, survivor: {} },
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
    },
  };
}

function emptyByType() {
  const out = {};
  for (const t of UNLOCK_TYPES) out[t] = {};
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
};

export class Profile {
  constructor() {
    this.data = freshProfile();
    // Unlocks earned this session that no UI has shown yet. B3's toast drains
    // this; nothing else should. Kept off `data` on purpose — it is session
    // state, not profile state, and persisting it would re-toast on reload.
    this._pendingUnlocks = [];
    this._writeTimer = null;
    this._evalTimer = null;
    this._dirty = false;
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
    // These duplicate a few of Progression's own `stats` fields on purpose. The
    // profile needs the co-op witness filter applied (Progression's stats are
    // the *run's* numbers and correctly count the whole team's work), and it
    // needs per-stage counters Progression has no use for.

    on('stageStart', (e) => this._onStageStart(e));
    on('kill', (e) => this._onKill(e));
    on('damage', (e) => this._onDamage(e));
    on('itemPickup', (e) => this._onItemPickup(e));
    on('goldChanged', (e) => this._onGold(e));
    on('bossDead', (e) => this._onBossDead(e));
    on('teleporterComplete', () => this._onTeleporterComplete());
    on('playerDead', () => { if (this.run) this.run.died = true; });

    // Last line of defence for the debounce: a tab closed inside the window
    // would otherwise drop up to WRITE_DEBOUNCE_MS of progress. `pagehide` and
    // a hidden `visibilitychange` are the two that actually fire on mobile and
    // on a killed tab; `unload` does not, reliably.
    if (typeof addEventListener === 'function') {
      this._onHide = () => this.flush();
      addEventListener('pagehide', this._onHide);
      addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.flush();
      });
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
      raw = localStorage.getItem(STORE_KEY);
    } catch {
      // Private mode / storage disabled. Play un-persisted rather than not at all.
      this._storageBlocked = true;
      return freshProfile();
    }
    if (!raw) return freshProfile();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[profile] stored profile is not valid JSON — starting fresh');
      return freshProfile();
    }
    // `null`, arrays and primitives all parse cleanly and are all unusable.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[profile] stored profile is not an object — starting fresh');
      return freshProfile();
    }

    try {
      return this._coerce(this._migrate(parsed));
    } catch (e) {
      console.warn('[profile] migration failed — starting fresh:', e);
      return freshProfile();
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
        };
      }
    }

    if (isObj(p.discovered)) {
      for (const kind of Object.keys(out.discovered)) {
        const src = p.discovered[kind];
        if (!isObj(src)) continue;
        for (const id of Object.keys(src)) out.discovered[kind][id] = num(src[id], 0);
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
  flush() {
    if (!this._dirty || this._storageBlocked) return;
    this._dirty = false;
    this.data.updatedAt = Date.now();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
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
      const entry = { type, id, challenge };
      this._pendingUnlocks.push(entry);
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
    const progress = Math.min(def.goal, st?.progress ?? 0);
    const done = !!st?.done;
    const masked = def.hidden && !done;
    return {
      id: def.id,
      name: masked ? '???' : def.name,
      description: masked ? 'Hidden challenge.' : def.description,
      hidden: !!def.hidden,
      masked,
      progress,
      goal: def.goal,
      fraction: def.goal > 0 ? progress / def.goal : 0,
      done,
      doneAt: st?.doneAt ?? 0,
      unlocks: def.unlocks || null,
    };
  }

  /** Every challenge, in definition order. */
  challengeStates() {
    return CHALLENGES.map((c) => this.challengeState(c.id));
  }

  /** Has the player ever seen this piece of content? Drives logbook greying. */
  isDiscovered(kind, id) { return !!this.data.discovered[kind]?.[id]; }

  discover(kind, id) {
    if (!id) return false;
    const m = this.data.discovered[kind];
    if (!m || m[id]) return false;
    m[id] = Date.now();
    this._touch();
    return true;
  }

  /** Newest first. A defensive copy — the UI must not be able to edit history. */
  runHistory() { return this.data.runs.map((r) => ({ ...r })); }

  /** Lifetime aggregate stats. Copy, same reason. */
  lifetime() { return { ...this.data.stats }; }

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
  currentRun() { return this.run ? { ...this.run } : null; }

  /** Wipe everything. Used by the settings screen; there is no undo. */
  reset() {
    this.data = freshProfile();
    this._pendingUnlocks = [];
    this._dirty = true;
    this.flush();
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
      died: false,
    };
    if (this.run.survivorId) this.discover('survivor', this.run.survivorId);
    this._lastGold = 0;
  }

  /**
   * Commit the run. Called by Progression on death or victory; idempotent, so a
   * `playerDead` immediately followed by a run-end event writes one record.
   */
  commitRun(won, stats = {}) {
    const run = this.run;
    if (!run) return null;
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

    // Final evaluation before the run counters are gone: a challenge phrased
    // "…in a single run" can only be true at this instant.
    this._evaluate(run);
    this._touch();
    // The death screen is up and the player is about to alt-tab; do not sit on
    // the debounce with a whole run's progress unwritten.
    this.flush();
    return record;
  }

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

  _onKill(e) {
    const run = this.run;
    if (!run || e?.victim?.isPlayer) return;
    // Discovery is a "have I seen this" fact and is credited on sight, host or
    // client — a client that watched a Titan die has seen a Titan.
    const vid = e?.victim?.def?.id ?? e?.victim?.id;
    if (typeof vid === 'string') this.discover(e.isBoss ? 'boss' : 'enemy', vid);

    if (!this._isLocalSource(e?.source)) return;
    run.kills++;
    this.data.stats.kills++;
    if (e.isElite) { run.elites++; this.data.stats.elites++; }
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
      run.damageTaken += amount;
      run.damageTakenThisStage += amount;
      this.data.stats.damageTaken += amount;
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
    // `itemPickup` is replicated as *this* client's inventory change (see
    // NETCODE.md), so there is no witness filter to apply here.
    const count = Math.max(1, num(e?.count, 1));
    if (typeof e?.id === 'string') this.discover('item', e.id);
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
    if (typeof bid === 'string') this.discover('boss', bid);
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
    const stats = this.data.stats;
    const store = this.data.challenges;
    let changed = false;

    for (const def of CHALLENGES) {
      let st = store[def.id];
      if (st?.done) continue;
      let progress = 0;
      try {
        progress = num(def.track(stats, runStats), 0);
      } catch (e) {
        // A broken predicate must cost that challenge, not the profile. This is
        // the same posture Engine takes with a throwing system.
        console.warn(`[profile] challenge "${def.id}" threw while tracking:`, e);
        continue;
      }
      if (!st) { st = store[def.id] = { progress: 0, done: false, doneAt: 0 }; }
      if (progress <= st.progress && !force) continue;
      if (progress > st.progress) { st.progress = progress; changed = true; }

      if (st.progress >= def.goal) {
        st.done = true;
        st.doneAt = Date.now();
        changed = true;
        this.ctx?.events?.emit?.('challengeComplete', { id: def.id, name: def.name });
        if (def.unlocks) this.unlock(def.unlocks.type, def.unlocks.id, { challenge: def.id });
      } else if (changed) {
        this.ctx?.events?.emit?.('challengeProgress', {
          id: def.id, progress: st.progress, goal: def.goal,
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
