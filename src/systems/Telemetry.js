// src/systems/Telemetry.js
import { isLocalKill, isLocalOwner, isLocalVictim } from '../core/Engine.js';

/**
 * The run record: what a run was, written to disk so a distribution can be
 * built out of many of them.
 *
 * Issue #29's premise is that this game is currently balanced from anecdotes,
 * and that three of the questions already on the board — is a corruption band
 * worth taking (#36), does the route change the ending (#37), is a side realm
 * ever a real choice (#38) — are questions about a *shape*, not about one run.
 * So this exists to answer them later rather than to be interesting now.
 *
 * ## Three properties, and why each is structural rather than a promise
 *
 * **Local.** There is no `fetch`, no `WebSocket`, no `Image` and no bridge call
 * in this file. Records land in `localStorage` (which the Electron shell
 * already mirrors into the save file, see `core/DesktopStore.js` — the
 * `telluric.` prefix is what puts them there) and leave the machine only when
 * a human presses Export and hands over the file that lands in their downloads
 * folder. `tests/telemetry-record.test.mjs` scans this module for the egress
 * vocabulary so "no network" stays a checked claim rather than a remembered one.
 *
 * **Opt-in, and free when off.** `installTelemetry` subscribes to nothing at
 * all unless the flag is set. Off is not a branch taken per event; off is an
 * early return at boot, after which no listener of this module's exists on the
 * bus and the run is byte-for-byte the run it was before the feature.
 *
 * **Unable to break a run.** Two independent reasons, and the first is the one
 * that matters:
 *
 *  1. This is not an engine system. It is never handed to `Engine.add`, so it
 *     has no `fixedUpdate`/`update`/`lateUpdate` and `Engine._call` — the only
 *     path in the codebase from a throw to `Engine._halt` — can never reach it.
 *     A telemetry defect therefore cannot end a run the way a `Corruption`
 *     defect can, because it is not standing anywhere a critical system stands.
 *  2. Every entry point is an `EventBus` listener, and `EventBus.emit`
 *     (`core/Engine.js`) already wraps each listener in its own try/catch so
 *     one bad subscriber cannot abort a dispatch or starve the subscribers
 *     behind it. `guard` below adds a second, narrower layer on top: it catches
 *     the same throw one frame earlier and then *disarms the recorder*, so a
 *     recorder that is broken stops being asked. Without that, a listener that
 *     throws on every `itemPickup` would be caught forever and print a console
 *     line per pickup — contained, but not quiet, and noise in the console is
 *     how a real bug gets missed.
 *
 * The recorder is deliberately a pure subscriber: it never calls into a system,
 * never writes to `ctx`, and consumes no `ctx.rng` draws, so it cannot move the
 * shared random stream `gate:sp` pins.
 *
 * ## What it does not know
 *
 * `realmEnter`, `realmExit` and the two new offer/font events are emitted under
 * `ctx.authority`, so a co-op *client* records its own stages, items, kills and
 * ending but no realm or font activity. That is stated rather than fixed: the
 * balance questions this feeds are asked of single-player and host runs, and
 * replicating them is a net-layer change.
 */

/** Storage keys. All under `telluric.` so the desktop save mirror carries them. */
export const ENABLED_KEY = 'telluric.telemetry.enabled';
export const RUNS_KEY = 'telluric.telemetry.runs';
export const PARTIAL_KEY = 'telluric.telemetry.partial';

/** Bumped whenever the record's shape changes, so old exports stay readable. */
export const RECORD_VERSION = 1;

/**
 * How many finished runs are kept. Fifty is roughly a fortnight of playtesting
 * for one person and a few hundred kilobytes; the point of a cap at all is that
 * `localStorage` is a small, shared quota and a telemetry buffer that grows
 * without bound eventually costs the player their save.
 */
const MAX_RUNS = 50;

/**
 * Per-list element caps inside one record. Every list here is one entry per
 * player *decision* — a band crossed, a font pressed, a realm offered — so a
 * hundred is far above any real run and exists only to bound a pathological one
 * (a player oscillating across a band boundary for an hour). Truncation is
 * recorded rather than silent: see `truncated`.
 */
const MAX_EVENTS = 100;

export function telemetryEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

/**
 * Turn recording on or off. Takes effect at the next boot, not mid-run: the
 * recorder subscribes once at install, and a run half of which was observed is
 * a record that would quietly lie about its own stage times.
 */
export function setTelemetryEnabled(on, storage = globalThis.localStorage) {
  try { storage?.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/** Every stored run, oldest first. Returns [] rather than throwing on junk. */
export function readRuns(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(RUNS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * The whole buffer as the JSON text a player hands over. Separate from the
 * download so a test — and a future desktop "reveal in folder" — can get at the
 * bytes without a DOM.
 */
export function exportText(storage = globalThis.localStorage) {
  return JSON.stringify({
    version: RECORD_VERSION,
    exportedAt: new Date().toISOString(),
    runs: readRuns(storage),
  }, null, 2);
}

/**
 * Hand the file to the player. A `Blob` and an object URL — the bytes never
 * leave the process, which is the point; an object URL is a pointer into this
 * page's own memory and not a network address.
 *
 * Returns the number of runs written, or -1 if there was nothing to write, so
 * the caller can say something truthful on the button.
 */
export function downloadRuns(storage = globalThis.localStorage, doc = globalThis.document) {
  const runs = readRuns(storage);
  if (!runs.length || !doc) return -1;
  let url = null;
  try {
    const blob = new Blob([exportText(storage)], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = `telluric-runs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    return runs.length;
  } catch (err) {
    console.error('[telemetry] export failed', err);
    return -1;
  } finally {
    // Deferred: revoking before the click has been serviced cancels the save in
    // Chromium. A frame is plenty, and leaking the URL costs nothing if it is not.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Discard everything recorded so far. The player's own off-switch for the buffer. */
export function clearRuns(storage = globalThis.localStorage) {
  try { storage?.removeItem(RUNS_KEY); storage?.removeItem(PARTIAL_KEY); } catch { /* private mode */ }
}

/**
 * Start recording, if the player has asked for it.
 *
 * Returns the recorder, or `{ active: false }` when telemetry is off — in which
 * case not one listener has been registered and nothing in this file will run
 * again for the life of the page.
 */
export function installTelemetry(ctx, { storage = globalThis.localStorage } = {}) {
  if (!ctx?.events || !storage || !telemetryEnabled(storage)) return { active: false };
  // Before the new run opens its own partial, or this boot would overwrite the
  // evidence of the run that crashed.
  promotePartial(storage);
  const rec = new RunRecorder(ctx, storage);
  rec.install();
  return rec;
}

class RunRecorder {
  constructor(ctx, storage) {
    this.ctx = ctx;
    this.storage = storage;
    this.active = true;
    // Set by the first throw out of any hook. Once true the recorder is inert:
    // see the class comment for why disarming beats catching forever.
    this.broken = false;
    this.record = {
      version: RECORD_VERSION,
      complete: false,
      truncated: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
      seed: ctx.seed ?? null,
      survivor: ctx.survivorId ?? null,
      difficulty: ctx.difficultyId ?? null,
      // Read at run end as well — the pre-run screens write these onto ctx
      // after the engine is built, and a run started from the harness never
      // writes them at all.
      artifacts: [],
      netRole: ctx.netRole ?? 'single',
      stages: [],
      corruption: { peakWorld: 0, peakBand: 0, fed: 0, bled: 0, crossings: [] },
      mutations: [],
      stabilisations: [],
      fonts: [],
      realmOffers: [],
      realmVisits: [],
      levels: [],
      route: { offered: [], taken: null },
      outcome: null,
      stats: null,
      fatal: null,
    };
    this._stage = null;      // the open stage entry, or null before stage 0
    this._realm = null;      // the open realm visit, or null outside one
    this._lastWorld = 0;     // previous corruption world value, for feed/bleed direction
    this._lastKill = null;   // the most recent kill of this machine's survivor
  }

  // ------------------------------------------------------------------ wiring

  /**
   * Wrap a hook so a defect in it costs a console line and the rest of the
   * record, and nothing else. `broken` is checked first so the second failure
   * of a repeatedly-failing hook is silent.
   */
  guard(fn) {
    return (payload) => {
      if (this.broken) return;
      try {
        fn.call(this, payload);
      } catch (err) {
        this.broken = true;
        console.error('[telemetry] recording stopped after an error in a capture hook', err);
      }
    };
  }

  install() {
    const { ctx } = this;
    const on = (name, fn) => ctx.events.on(name, this.guard(fn));

    on('stageStart', this.onStageStart);
    on('corruptionChanged', this.onCorruptionChanged);
    on('corruptionBand', this.onCorruptionBand);
    on('itemPickup', this.onItemPickup);
    on('itemMutated', this.onItemMutated);
    on('itemStabilised', this.onItemStabilised);
    on('fontUse', this.onFontUse);
    on('realmOffer', this.onRealmOffer);
    on('realmEnter', this.onRealmEnter);
    on('realmExit', this.onRealmExit);
    on('kill', this.onKill);
    on('levelUp', this.onLevelUp);
    on('runEnd', this.onRunEnd);
    on('fatalError', this.onFatalError);
  }

  // ------------------------------------------------------------------- hooks

  onStageStart(e) {
    this.closeStage();
    this._stage = {
      index: e?.index ?? 0,
      name: e?.name ?? null,
      enteredAt: this.t(),
      leftAt: null,
      corruptionIn: this.world(),
      corruptionOut: null,
      bandIn: this.band(),
      bandOut: null,
      items: 0,
      kills: 0,
    };
  }

  /**
   * The corruption timeline is sampled at stage boundaries and at band
   * crossings — never per change. A `corruptionChanged` fires on every item
   * picked up, so storing one sample each would put thousands of points in a
   * record whose whole purpose is to be read in aggregate. What the per-change
   * event is used for instead is the pair of running totals: how much
   * corruption a run took on, against how much it bought back. #36 asks whether
   * players take corruption *on purpose*, and `fed` versus `bled` is the
   * cheapest honest measure of that.
   */
  onCorruptionChanged(e) {
    const world = Number(e?.world) || 0;
    const delta = world - this._lastWorld;
    this._lastWorld = world;
    const c = this.record.corruption;
    if (delta > 0) c.fed += delta; else c.bled -= delta;
    if (world > c.peakWorld) c.peakWorld = world;
  }

  onCorruptionBand(e) {
    const band = e?.band ?? 0;
    const prev = e?.prev ?? 0;
    const c = this.record.corruption;
    if (band > c.peakBand) c.peakBand = band;
    this.push(c.crossings, {
      t: this.t(), stage: this._stage?.index ?? null,
      band, prev, dir: band > prev ? 'up' : 'down', world: this.world(),
    });
  }

  /**
   * `reason: 'corrupt'` is the blight transform moving stacks the player
   * already holds between two ids, and `delta <= 0` is a removal or a restack —
   * neither is an acquisition, and counting either inflates the haul. The same
   * two exclusions `Progression`'s own item counter carries, for the same reason.
   */
  onItemPickup(e) {
    if (e?.reason === 'corrupt' || !isLocalOwner(this.ctx, e)) return;
    const delta = e?.delta === undefined ? (e?.count ?? 1) : e.delta;
    if (!(delta > 0)) return;
    if (this._stage) this._stage.items += delta;
    if (this._realm) this._realm.items += delta;
  }

  onItemMutated(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    this.push(this.record.mutations, {
      t: this.t(), stage: this._stage?.index ?? null,
      band: e?.band ?? null, baseId: e?.baseId ?? null, blightId: e?.blightId ?? null,
      count: e?.count ?? 0,
      // What the toll could have taken, beside what it did. There is no player
      // choice in a mutation today — `Items._mutateAt` picks off a derived
      // stream — so this is the whole of #29's "what was eligible / what
      // converted", and the "what the player chose" third of that line has no
      // referent until a mutation becomes a decision.
      eligible: Array.isArray(e?.eligible) ? e.eligible.slice() : null,
    });
  }

  onItemStabilised(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    this.push(this.record.stabilisations, {
      t: this.t(), blightId: e?.blightId ?? null, baseId: e?.baseId ?? null, count: e?.count ?? 0,
    });
  }

  onFontUse(e) {
    this.push(this.record.fonts, {
      t: this.t(), stage: e?.stage ?? null, press: e?.press ?? 0,
      cost: e?.cost ?? 0, removed: e?.removed ?? 0,
      worldBefore: e?.worldBefore ?? 0, worldAfter: e?.worldAfter ?? 0,
      bandBefore: e?.bandBefore ?? 0, bandAfter: e?.bandAfter ?? 0,
    });
  }

  onRealmOffer(e) {
    const entry = {
      t: this.t(), stage: e?.stage ?? null, id: e?.id ?? null,
      kind: e?.kind ?? null, cost: e?.cost ?? 0,
    };
    this.push(this.record.realmOffers, entry);
    // A finale door is an offer like any other, and also the run's route
    // question (#37). Recorded in both places on purpose: the offer list is
    // what #38's offer-rate denominator counts, and `route.offered` is what
    // makes "the void door was never open to them" distinguishable from "they
    // were offered it and walked past".
    if (entry.kind === 'finale' && !this.record.route.offered.includes(entry.id)) {
      this.record.route.offered.push(entry.id);
    }
  }

  onRealmEnter(e) {
    const id = e?.id ?? null;
    this._realm = {
      id, stage: this._stage?.index ?? null,
      enteredAt: this.t(), exitedAt: null, duration: null,
      items: 0, kills: 0,
      corruptionIn: this.world(),
      // Set at exit. A realm the run ends inside never gets one, which is
      // itself the interesting case for #38 and must not be filled in with a
      // guess.
      corruptionOut: null,
    };
    if (this.record.route.offered.includes(id)) this.record.route.taken = id;
  }

  onRealmExit() {
    const r = this._realm;
    if (!r) return;
    this._realm = null;
    r.exitedAt = this.t();
    r.duration = r.exitedAt - r.enteredAt;
    r.corruptionOut = this.world();
    this.push(this.record.realmVisits, r);
  }

  /**
   * Kills are counted, never listed: a run produces thousands and the summary
   * `stats` already carries the totals. The one kill kept whole is the last one
   * whose victim was this machine's survivor, because that is the death cause —
   * `playerDead` carries only the victim, while `kill` carries the source, the
   * damage type and the status that finished them.
   */
  onKill(e) {
    if (isLocalVictim(this.ctx, e)) {
      const src = e?.source;
      this._lastKill = {
        t: this.t(), stage: this._stage?.index ?? null, realm: this._realm?.id ?? null,
        type: e?.type ?? null, status: e?.status ?? null, overkill: e?.overkill ?? 0,
        source: src ? (src.def?.id ?? src.id ?? src.constructor?.name ?? null) : null,
        sourceIsPlayer: !!src?.isPlayer, sourceIsElite: !!src?.isElite, sourceIsBoss: !!src?.isBoss,
      };
      return;
    }
    if (e?.victim?.isPlayer || !isLocalKill(this.ctx, e)) return;
    if (this._stage) this._stage.kills++;
    if (this._realm) this._realm.kills++;
  }

  onLevelUp(e) {
    this.push(this.record.levels, { t: this.t(), level: e?.level ?? null, stage: this._stage?.index ?? null });
  }

  /**
   * The run is over. This is the only place a finished record is written, and
   * it is reached from `Progression._endRun`, which is raised by both real
   * conclusions and by death.
   */
  onRunEnd(e) {
    if (this.record.complete) return;
    this.closeStage();
    // The realm the run ended inside is still worth having, marked as unfinished.
    if (this._realm) { this.push(this.record.realmVisits, this._realm); this._realm = null; }
    const stats = e?.stats ?? null;
    this.record.complete = true;
    this.record.endedAt = new Date().toISOString();
    this.record.survivor = this.ctx.survivorId ?? this.record.survivor;
    this.record.difficulty = this.ctx.difficultyId ?? this.record.difficulty;
    this.record.artifacts = artifactIds(this.ctx);
    this.record.outcome = {
      won: !!e?.won,
      ending: stats?.ending ?? null,
      endingTitle: stats?.endingTitle ?? null,
      // Null when the run ended standing up — an obelisk or a dead Herald has
      // no cause of death, and a zeroed one would read as an unattributed kill.
      cause: this._lastKill,
    };
    this.record.stats = stats ? { ...stats, inventory: stats.inventory ?? [] } : null;
    this.commit();
  }

  /**
   * The engine has halted. Nothing after this frame will be recorded, so file
   * what there is — incomplete and labelled so, which is far more use than a
   * missing record when the question is what the run was doing when it died.
   */
  onFatalError(e) {
    if (this.record.complete) return;
    this.record.fatal = { who: e?.who ?? null, message: e?.message ?? null, frame: e?.frame ?? null };
    this.closeStage();
    this.commit();
  }

  // ---------------------------------------------------------------- plumbing

  t() { return round(this.ctx.time ?? 0); }
  world() { return round(this.ctx.corruption?.world ?? 0); }
  band() { return this.ctx.corruption?.band ?? 0; }

  closeStage() {
    const s = this._stage;
    if (!s) return;
    this._stage = null;
    s.leftAt = this.t();
    s.corruptionOut = this.world();
    s.bandOut = this.band();
    this.push(this.record.stages, s);
    // A stage boundary is the crash checkpoint: a handful of writes per run
    // rather than one per event, and it bounds what a browser tab closed
    // mid-run can cost to the stage in flight. See `commit` for the promotion
    // that turns one of these into a real record on the next boot.
    this.save(PARTIAL_KEY, this.record);
  }

  /**
   * Append the record to the buffer, and drop the checkpoint only once it is
   * genuinely filed.
   *
   * The ordering is the whole of this function. Dropping the checkpoint
   * unconditionally made a *detected* failure destroy more than an undetected
   * one: `onRunEnd` closes the last stage first, which writes a good
   * checkpoint, and a quota-exhausted `setItem` on the runs list would then be
   * followed by a `removeItem` that erased the one copy `promotePartial` could
   * have recovered on the next boot. A run was lost precisely because the
   * failure was caught.
   *
   * So `save` reports rather than only recording, and the checkpoint outlives a
   * commit that did not land. Reading `save`'s own answer beats consulting
   * `broken`: the flag is also raised by hook throws, and "did *this* write
   * succeed" is the only question the `removeItem` actually depends on.
   *
   * A checkpoint left behind is never a duplicate: the next boot promotes it
   * and deletes it, and the finished record it duplicates was, by construction,
   * never written.
   */
  commit() {
    const runs = readRuns(this.storage);
    runs.push(this.record);
    while (runs.length > MAX_RUNS) runs.shift();
    if (!this.save(RUNS_KEY, runs)) {
      // Upgrade the checkpoint to the finished record before giving up. The
      // copy `closeStage` left is the last *stage boundary*, so it predates the
      // outcome, the death cause and the summary snapshot — the half of the
      // record the balance questions are actually asked of. Writing one record
      // is a far smaller ask than writing the whole buffer, so this frequently
      // succeeds where the line above did not; when it does not, the older
      // checkpoint is still standing and nothing has been made worse.
      this.save(PARTIAL_KEY, this.record);
      return;
    }
    try { this.storage.removeItem(PARTIAL_KEY); } catch { /* private mode */ }
  }

  /**
   * Bounded append. Past the cap the list stops growing and the record says so,
   * because an analysis that silently read a truncated list as a whole run
   * would draw the wrong conclusion quietly, which is the one failure mode this
   * whole feature exists to remove.
   */
  push(list, entry) {
    if (list.length >= MAX_EVENTS) { this.record.truncated = true; return; }
    list.push(entry);
  }

  /** Write one key. Returns whether the bytes actually landed — see `commit`. */
  save(key, value) {
    try {
      this.storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      // Quota exhausted, or private mode. Recording on is a favour the player
      // is doing us; it may not cost them the ability to save their profile.
      this.broken = true;
      console.error('[telemetry] recording stopped — the record could not be stored', err);
      return false;
    }
  }
}

/**
 * Promote a record left behind by a run that never reached its end — a crash,
 * an alt-F4, a closed tab. Called at boot, before the new run opens its own.
 *
 * A record that parses is filed exactly as it was found, `complete` flag and
 * all, so nothing downstream has to guess. Usually that flag is false — the
 * checkpoint is a stage boundary. It is true in one case: a run that reached
 * its end and could not be filed, which `commit` writes here as its last act
 * before giving up. Both are recovered; only the reader can tell them apart,
 * and the flag is how.
 *
 * The three outcomes are deliberately distinct, and the middle one is the one
 * that used to be wrong:
 *
 *  · **Filed.** The checkpoint is appended and then deleted, in that order —
 *    the same rule `commit` follows, so a write that does not land never costs
 *    the copy it was going to replace.
 *  · **Unparseable.** Cleared, and not filed. A half-written or hand-mangled
 *    checkpoint is unrecoverable by definition, and the old ordering — parse
 *    inside the same `try` as the delete — meant the throw jumped over the
 *    delete and the same junk was re-read, and re-thrown over, on every
 *    subsequent boot. Permanently stuck, permanently silent.
 *  · **Unwritable.** Kept. Storage is full or refusing writes; the checkpoint is
 *    the only copy and the next boot may have room.
 */
export function promotePartial(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = storage?.getItem(PARTIAL_KEY); } catch { return null; }
  if (!raw) return null;

  let record = null;
  try { record = JSON.parse(raw); } catch { /* junk; cleared below */ }
  if (!record || typeof record !== 'object') {
    try { storage.removeItem(PARTIAL_KEY); } catch { /* private mode */ }
    return null;
  }

  try {
    const runs = readRuns(storage);
    runs.push(record);
    while (runs.length > MAX_RUNS) runs.shift();
    storage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch { return null; }
  try { storage.removeItem(PARTIAL_KEY); } catch { /* private mode */ }
  return record;
}

/**
 * The artifacts this run is being played with. `Artifacts.set` is the system's
 * own live answer; `ctx.artifactIds` is what the menu writes before the system
 * exists to be asked. Read in that order and never guessed at.
 */
function artifactIds(ctx) {
  const live = ctx?.artifacts?.set;
  if (live && typeof live.values === 'function') return [...live].map(String).sort();
  return Array.isArray(ctx?.artifactIds) ? ctx.artifactIds.map(String).sort() : [];
}

/** Two decimals. Seconds to the centisecond is finer than any question here. */
function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
