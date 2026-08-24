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

/**
 * Bumped whenever the record's shape changes, so old exports stay readable.
 *
 * 2 — realm offers carry `gold`, `goldMax` and `band`. Version 1 records cannot
 *     say whether a priced gateway was affordable, which is half of #38's
 *     denominator, and `tools/realmstats.mjs` refuses a verdict on them rather
 *     than approximating one.
 *
 * 3 — alignment telemetry (#166): `itemOffers`, `mutationChoices`, and the
 *     purse/inventory halves of the stage and realm boundary snapshots. Older
 *     records simply lack the keys, and every reader here treats an absent key
 *     as "this run cannot answer that question" rather than as a zero — a run
 *     that recorded no chest opens because the build could not see them is not
 *     a run in which the player left every chest.
 */
export const RECORD_VERSION = 3;

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

/**
 * `Items`' own word for how a mutation window ended, in the audit's terms
 * (#166). Every one of these except `chosen` leaves the void with the pick, so
 * they are indistinguishable in `mutations` — which is precisely why the
 * distinction has to be recorded here. `superseded` is kept separate from
 * `timeout` because a window buried by the next threshold is a window the
 * player may never have had time to read.
 */
const MUTATION_OUTCOME = {
  chosen: 'explicit-choice',
  refused: 'refusal',
  timeout: 'timeout',
  superseded: 'superseded',
  death: 'death',
  runEnd: 'run-end',
};

/**
 * Is this interactable a chest? Duck-typed on the three fields only `Chest`
 * carries together — property names, which survive minification, where a class
 * name does not — rather than on its wire `typeId`, which would mean keeping a
 * second copy of a numbering this module has no business knowing.
 * `tests/alignment-telemetry.test.mjs` checks the predicate against a real
 * `Chest` and against the other interactables, so a drift here is caught.
 */
export function isChestLike(i) {
  return !!i && i.openT !== undefined && i.size !== undefined
    && i.cost !== undefined && typeof i.available === 'function';
}

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
      // Minted once, here, and never rewritten — including by the second
      // checkpoint write in `commit`. It is what lets `promotePartial`
      // recognise a run it has already filed, which is the only thing standing
      // between a failed `removeItem` and the same run appearing twice.
      id: mintId(ctx.seed),
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
      // Provisional. `NetClient.init` sets `ctx.netRole` *after* the engine is
      // built, so the value read here says 'single' on a machine that is about
      // to become a guest — and a guest's record is not a record of local play
      // at all: its `Corruption` is written by the host's replicated events, so
      // the whole corruption trajectory is the host's, counted once per peer.
      // Refreshed at every checkpoint and at run end; see `refreshRole`.
      netRole: ctx.netRole ?? 'single',
      stages: [],
      // `fed`/`bled` is the tax; `marks` and `ruined` are the half of #36 that
      // the export could not see. A run whose `marks.minted` climbed and whose
      // `marks.spent` stayed at 0 is the design's own refutation condition —
      // an upside that accrued and that nobody ever found — and it has to be
      // distinguishable from a run that simply never went deep enough to mint.
      corruption: {
        peakWorld: 0, peakBand: 0, fed: 0, bled: 0, crossings: [],
        marks: { minted: 0, spent: 0 }, ruined: false,
        // Purity's purse, the backfill §3 promised and never shipped. Without
        // it §3's refutation conditions cannot be evaluated at all: `warded` is
        // whether anyone plays the verb, `minted` versus `spent` whether the
        // currency it pays out ever leaves the pocket. A run that never wards
        // leaves all three at 0, which is a finding and not a gap.
        motes: { minted: 0, spent: 0, warded: 0 },
      },
      // Every bargain actually struck, in order. This is issue #36's acceptance
      // criterion in one field: a run with a nonzero `fed` and an empty
      // `bargains` is a player who paid the whole tax and took nothing back.
      bargains: [],
      // Purity's side (`data/bandBoons.js` MOTE). `greed` on each entry is the
      // one that decides whether the window was spent well: greed time doubles
      // the price a sanctuary waives, so a run whose sanctuaries all land
      // outside it is a run that has not understood the offer — or an offer
      // that arrives at the wrong moment, which is the same finding pointed at
      // the designer instead of the player.
      sanctuaries: [],
      // Every consecration, with the gauge it was bought at (§5.6). An argent
      // card is worth what `grace` says at the moment it fires, so the world
      // at the press is the only honest price tag on the row.
      argent: [],
      mutations: [],
      // Every mutation window that opened, with how it resolved (#166). The
      // audit's question is whether the lever is *played* — an explicit choice
      // — or merely suffered, and a timeout, a refusal and a death all look
      // identical in `mutations` alone because all three end in the void's own
      // pick. See `onMutationClosed` for the reason-to-outcome mapping.
      mutationChoices: [],
      stabilisations: [],
      // Item offers the player actually resolved, one entry per chest opened
      // (#166). The taxonomy is deliberately narrow: `taken-normally` and
      // `taken-corrupted` are the two currencies a chest can be paid in, and
      // they are the only two acquisition outcomes any system in the game can
      // distinguish today. `left` is not an entry here — an offer nobody
      // touched raises no event, so it is counted at stage close instead; see
      // `chestsLeft` on each stage.
      itemOffers: [],
      fonts: [],
      realmOffers: [],
      realmVisits: [],
      levels: [],
      route: { offered: [], taken: null },
      outcome: null,
      stats: null,
      fatal: null,
      // Names of hooks that threw and were individually disabled, with the
      // message each died on. Empty on a clean run, so a consumer never has to
      // special-case its absence. See `guard()`.
      brokenHooks: [],
    };
    this._stage = null;      // the open stage entry, or null before stage 0
    this._realm = null;      // the open realm visit, or null outside one
    this._lastWorld = 0;     // previous corruption world value, for feed/bleed direction
    this._lastMarks = 0;     // previous void-mark balance, for the mint/spend split
    this._lastMotes = 0;     // previous argent-mote balance, same split
    this._motesBefore = 0;   // the purse an in-flight spend is being taken from
    this._lastKill = null;   // the most recent kill of this machine's survivor
    // Offers whose door is still standing, so `goldChanged` can raise their
    // high-water purse. Emptied at `stageStart`, because that is where `Realms`
    // clears its gateways and drops the armed realm — every door in the list
    // ceases to exist at exactly that moment.
    this._openOffers = [];
    // The mutation window currently standing, or null. Kept so a run that ends
    // with one open still records the offer — `Items` closes it from its own
    // `runEnd` listener, and listener order on the bus is not a thing this
    // module gets to depend on. Whichever of the two arrives first wins; see
    // `onMutationClosed`.
    this._openChoice = null;
    // Names of hooks disabled by their own throw — see `guard()`. Separate from
    // `this.broken`, which is reserved for a failure that really is global (the
    // storage write itself failing in `save()`): a defect confined to one hook
    // must not cost every other hook's data, or the run export.
    this._brokenHooks = new Set();
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

  /**
   * Same contract as `guard()`, but isolated to the one hook rather than
   * joining the global `broken` latch — for the four void-economy hooks
   * (`onVoidMarks`, `onVoidBargain`, `onVoidSanctuary`, `onVoidRuin`), which
   * previously shared `guard()` and so a defect in any one of them — say
   * `onVoidBargain` choking on a malformed payload — silently stopped
   * `onVoidSanctuary`, `onVoidRuin`, and every *other* hook in the file from
   * recording anything for the rest of the run, with the export giving no
   * sign which hook had died.
   *
   * `this.broken` is still checked first and still unconditional: a truly
   * global failure (the storage write itself failing in `save()`) is not
   * something any hook's data survives, so it still wins over per-hook
   * isolation. What it no longer does is get *set* by one hook's throw.
   *
   * `record.brokenHooks` is what keeps this backward-compatible in the shape
   * that matters: a reader that never looks at the field sees exactly the
   * record it always did, and one that wants to know what died can.
   */
  guardHook(fn) {
    const name = fn.name || 'hook';
    return (payload) => {
      if (this.broken || this._brokenHooks.has(name)) return;
      try {
        fn.call(this, payload);
      } catch (err) {
        this._brokenHooks.add(name);
        this.record.brokenHooks.push({ name, message: String(err && err.message || err) });
        console.error(`[telemetry] hook ${name} disabled after an error`, err);
      }
    };
  }

  install() {
    const { ctx } = this;
    const on = (name, fn) => ctx.events.on(name, this.guard(fn));
    // The four void-economy hooks get their own isolation — see `guardHook()`.
    const onIsolated = (name, fn) => ctx.events.on(name, this.guardHook(fn));

    on('stageStart', this.onStageStart);
    on('corruptionChanged', this.onCorruptionChanged);
    on('corruptionBand', this.onCorruptionBand);
    on('itemPickup', this.onItemPickup);
    on('itemMutated', this.onItemMutated);
    on('itemStabilised', this.onItemStabilised);
    on('itemOffer', this.onItemOffer);
    on('mutationChoiceOffered', this.onMutationOffered);
    on('mutationChoiceClosed', this.onMutationClosed);
    on('fontUse', this.onFontUse);
    onIsolated('voidMarksChanged', this.onVoidMarks);
    on('argentMotesChanged', this.onArgentMotes);
    on('argentConsecrate', this.onArgentConsecrate);
    onIsolated('voidBargain', this.onVoidBargain);
    onIsolated('voidSanctuary', this.onVoidSanctuary);
    onIsolated('voidRuin', this.onVoidRuin);
    on('goldChanged', this.onGoldChanged);
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
    this._openOffers.length = 0;
    this._stage = {
      index: e?.index ?? 0,
      name: e?.name ?? null,
      enteredAt: this.t(),
      leftAt: null,
      corruptionIn: this.world(),
      corruptionOut: null,
      bandIn: this.band(),
      bandOut: null,
      // The alignment state at the boundary (#166). Corruption alone says how
      // deep the run went; these say what the run is *holding* while it is
      // that deep, which is the pair the "do mixed inventories dominate"
      // question is asked of.
      alignIn: this.align(),
      alignOut: null,
      // Chests still standing when this stage closed — the `left` arm of the
      // offer taxonomy. Null when the stage ended somewhere the interactable
      // list could not be read, which is a different fact from zero.
      chestsLeft: null,
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
    // `warded` is monotonic on the system and is simply mirrored: a bleed
    // clamps to what exists, so the system's own total is the only one that
    // cannot over-count.
    c.motes.warded = round(this.ctx.corruption?.warded ?? 0);
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

  /**
   * A chest was opened, and in which currency (#166). `outcome` is the
   * emitter's own word for the branch it took, mapped here onto the audit's
   * vocabulary so a reader never has to know what "voidCredit" meant.
   */
  onItemOffer(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    this.push(this.record.itemOffers, {
      t: this.t(), stage: this._stage?.index ?? null,
      kind: e?.kind ?? null, size: e?.size ?? null, cost: Number(e?.cost) || 0,
      outcome: e?.outcome === 'corrupt' ? 'taken-corrupted' : 'taken-normally',
      world: this.world(), band: this.band(),
    });
  }

  /** A mutation window opened. Held, not pushed: the entry needs its ending. */
  onMutationOffered(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    this._openChoice = {
      t: this.t(), stage: this._stage?.index ?? null,
      band: e?.band ?? null, seconds: Number(e?.seconds) || 0,
      offers: Array.isArray(e?.offers) ? e.offers.map((o) => o?.baseId ?? null) : [],
      reason: null, outcome: null, baseId: null, resolvedAt: null,
    };
  }

  /**
   * The window resolved. `Items` names the reason; the outcome is that reason
   * in the audit's five terms, and an unrecognised reason is carried through
   * verbatim rather than binned into `refusal` — a resolution nobody
   * anticipated must be visible as one.
   */
  onMutationClosed(e) {
    if (this.record.complete || !isLocalOwner(this.ctx, e)) return;
    const c = this._openChoice;
    this._openChoice = null;
    // A window this recorder never saw open (installed mid-band, or truncated
    // away) still resolved, and the resolution is the interesting half.
    const entry = c ?? {
      t: this.t(), stage: this._stage?.index ?? null, band: e?.band ?? null,
      seconds: 0, offers: [],
    };
    entry.reason = e?.reason ?? null;
    entry.outcome = MUTATION_OUTCOME[entry.reason] ?? entry.reason ?? 'unknown';
    entry.baseId = e?.baseId ?? null;
    entry.resolvedAt = this.t();
    this.push(this.record.mutationChoices, entry);
  }

  onFontUse(e) {
    this.push(this.record.fonts, {
      t: this.t(), stage: e?.stage ?? null, press: e?.press ?? 0,
      cost: e?.cost ?? 0, removed: e?.removed ?? 0,
      worldBefore: e?.worldBefore ?? 0, worldAfter: e?.worldAfter ?? 0,
      bandBefore: e?.bandBefore ?? 0, bandAfter: e?.bandAfter ?? 0,
    });
  }

  /**
   * The void-mark purse moved (issue #36). Two shapes ride one event: a mint,
   * which raises the balance with `spent: 0`, and a spend, which lowers it by
   * `spent`. Both totals are kept because they answer different questions — did
   * the run go deep enough to earn the currency, and did anyone ever use it —
   * and the second is the design's stated refutation condition.
   *
   * Derived from the balance delta rather than trusted from the payload, so a
   * mint whose size the emitter did not state is still counted. `_lastMarks`
   * starts at 0, which is where every run starts.
   */
  onVoidMarks(e) {
    const marks = Number(e?.marks) || 0;
    const spent = Math.max(0, Number(e?.spent) || 0);
    const m = this.record.corruption.marks;
    // balance_now = balance_before + minted - spent, so minted falls out.
    const minted = marks - this._lastMarks + spent;
    if (minted > 0) m.minted += minted;
    m.spent += spent;
    this._lastMarks = marks;
  }

  /**
   * The same split for the other purse. `_motesBefore` is the balance the spend
   * was taken *from*, kept because `sanctuaries[].motesHeld` is the ladder
   * decision measured: a window bought at one mote is a player who could not
   * wait for the reliquary, one bought at two chose the window over the card.
   * The spend event fires before the window opens, so this is always current.
   */
  onArgentMotes(e) {
    const motes = Number(e?.motes) || 0;
    const spent = Math.max(0, Number(e?.spent) || 0);
    const m = this.record.corruption.motes;
    const minted = motes - this._lastMotes + spent;
    if (minted > 0) m.minted += minted;
    m.spent += spent;
    if (spent > 0) this._motesBefore = motes + spent;
    this._lastMotes = motes;
  }

  /** An argent card was bought. `world` is its price tag; see `argent`. */
  onArgentConsecrate(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    this.push(this.record.argent, {
      t: this.t(),
      id: e?.id ?? null,
      // The table, not only the pick. A row that says only what was bought
      // cannot distinguish a card players want from a card they were the only
      // one offered, which is the whole question a previewed offer raises.
      offered: Array.isArray(e?.offered) ? e.offered.slice() : [],
      motes: Number(e?.motes) || 0,
      world: this.world(),
      band: this.band(),
    });
  }

  /**
   * A bargain was struck — the one field #36's acceptance criterion is written
   * in. The world and band at the moment of the press are recorded alongside
   * the price, because the interesting question is not only whether players buy
   * but *how deep they were willing to go* before they did.
   */
  onVoidBargain(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    this.push(this.record.bargains, {
      t: this.t(),
      kind: e?.kind ?? null,
      id: e?.id ?? null,
      marks: Number(e?.marks) || 0,
      world: this.world(),
      band: this.band(),
    });
  }

  /** A sanctuary window was bought. See `sanctuaries` for what `greed` decides. */
  onVoidSanctuary(e) {
    this.push(this.record.sanctuaries, {
      t: this.t(),
      seconds: Number(e?.seconds) || 0,
      world: this.world(),
      greed: !!e?.greed,
      motesHeld: this._motesBefore,
    });
  }

  /** Consumed's one-way door was opened. A flag, because it happens at most once. */
  onVoidRuin() {
    this.record.corruption.ruined = true;
  }

  /**
   * A door was offered, and — since #38's decided denominator is offers the
   * player could *actually take* — what the purse could answer it with.
   *
   * `gold` is the purse at the instant the door appeared; `goldMax` is the most
   * gold held while it still stood, and it is the one affordability should be
   * read off. A gateway stands for a whole stage, so a player who walks past a
   * 120g door with 60g, kills for ninety seconds and comes back was never
   * priced out of it — scoring that offer as unaffordable would shrink the
   * denominator with exactly the offers that were live choices. `band` is the
   * run state the same decision was made under, which is the other half of the
   * "regardless of build or run state" the >75% rule is written against.
   */
  onRealmOffer(e) {
    const entry = {
      t: this.t(), stage: e?.stage ?? null, id: e?.id ?? null,
      kind: e?.kind ?? null, cost: e?.cost ?? 0,
      gold: this.gold(), goldMax: this.gold(), band: this.band(),
    };
    this.push(this.record.realmOffers, entry);
    // Only offers that made it past `push`'s cap are tracked: an entry dropped
    // for truncation is not in the record to be updated.
    if (this.record.realmOffers[this.record.realmOffers.length - 1] === entry) {
      this._openOffers.push(entry);
    }
    // A finale door is an offer like any other, and also the run's route
    // question (#37). Recorded in both places on purpose: the offer list is
    // what #38's offer-rate denominator counts, and `route.offered` is what
    // makes "the void door was never open to them" distinguishable from "they
    // were offered it and walked past".
    if (entry.kind === 'finale' && !this.record.route.offered.includes(entry.id)) {
      this.record.route.offered.push(entry.id);
    }
  }

  /**
   * Raise the high-water purse on every door still standing. Absolute value,
   * not a delta — `Items.addGold`/`spend` both emit the total.
   */
  onGoldChanged(e) {
    if (!isLocalOwner(this.ctx, e)) return;
    const gold = Number(e?.gold);
    if (!Number.isFinite(gold)) return;
    for (const o of this._openOffers) if (gold > o.goldMax) o.goldMax = gold;
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
      alignIn: this.align(),
      alignOut: null,
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
    r.alignOut = this.align();
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
    // A window still standing when the run ended is a resolution too, and it is
    // the one the run's own listener may or may not get to first. Filed here
    // and then refused above if `Items` closes it a moment later.
    if (this._openChoice) this.onMutationClosed({ reason: 'runEnd', owner: this.ctx.player });
    this.closeStage();
    // The realm the run ended inside is still worth having, marked as unfinished.
    if (this._realm) { this.push(this.record.realmVisits, this._realm); this._realm = null; }
    const stats = e?.stats ?? null;
    this.record.complete = true;
    this.record.endedAt = new Date().toISOString();
    this.record.survivor = this.ctx.survivorId ?? this.record.survivor;
    this.record.difficulty = this.ctx.difficultyId ?? this.record.difficulty;
    this.record.artifacts = artifactIds(this.ctx);
    this.refreshRole();
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
    this.refreshRole();
    this.closeStage();
    this.commit();
  }

  // ---------------------------------------------------------------- plumbing

  t() { return round(this.ctx.time ?? 0); }
  world() { return round(this.ctx.corruption?.world ?? 0); }
  band() { return this.ctx.corruption?.band ?? 0; }
  gold() { return Math.round(this.ctx.items?.gold ?? 0); }

  /**
   * Stamp the role the run is *actually* being played in.
   *
   * Sticky in one direction: a run that was ever a guest stays labelled one,
   * because the reason the label exists is that a guest's corruption numbers
   * came off the wire, and a teardown that clears `ctx.netRole` on the way out
   * does not un-replicate them. Host and single may still be corrected upward
   * — a run that opened solo and became a host is a host's record.
   */
  refreshRole() {
    if (this.record.netRole === 'client') return;
    const role = this.ctx.netRole;
    if (typeof role === 'string' && role) this.record.netRole = role;
  }

  /**
   * The alignment snapshot (#166): both purses, and the shape of the shelf.
   *
   * `argent` and `blight` are counted as *copies held*, not as distinct cards,
   * because the audit's "do mixed inventories dominate" is a question about
   * weight rather than variety — one player holding four blight stacks and one
   * argent card is not in the same place as one holding one of each. `other`
   * closes the arithmetic so a reader never has to sum the tiers to learn how
   * much of the shelf the two poles account for.
   */
  align() {
    const c = this.ctx.corruption;
    const inv = this.inventoryOf();
    return {
      marks: Math.max(0, Math.round(c?.marks ?? 0)),
      motes: Math.max(0, Math.round(c?.motes ?? 0)),
      warded: round(c?.warded ?? 0),
      argent: inv.argent, blight: inv.blight, other: inv.other,
    };
  }

  /** Copies held, split into the two poles and everything else. */
  inventoryOf() {
    const out = { argent: 0, blight: 0, other: 0 };
    let list = null;
    try { list = this.ctx.items?.inventory?.(); } catch { list = null; }
    if (!Array.isArray(list)) return out;
    for (const e of list) {
      const n = Number(e?.count) || 0;
      const tier = e?.def?.tier;
      if (tier === 'argent') out.argent += n;
      else if (tier === 'blight') out.blight += n;
      else out.other += n;
    }
    return out;
  }

  /**
   * Chests still standing, which is the only way `left` is observable: an offer
   * nobody walked up to raises no event, so it has to be counted by looking at
   * what survived the stage. Null when there is no interactable list to read —
   * a harness run, or a stage closed after the world was already torn down —
   * because a zero there would read as "the player took everything".
   */
  chestsLeft() {
    const list = this.ctx.interactables?.list;
    if (!Array.isArray(list)) return null;
    let n = 0;
    for (const i of list) if (isChestLike(i) && i.available?.()) n++;
    return n;
  }

  closeStage() {
    const s = this._stage;
    if (!s) return;
    this._stage = null;
    s.leftAt = this.t();
    s.corruptionOut = this.world();
    s.bandOut = this.band();
    s.alignOut = this.align();
    s.chestsLeft = this.chestsLeft();
    this.refreshRole();
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
   * A checkpoint left behind is never filed twice, and that is now a property
   * of the record's `id` rather than of this `removeItem` succeeding — see
   * `promotePartial`, which refuses an identity the buffer already holds. So
   * the `removeItem` throwing here costs one wasted read on the next boot and
   * nothing more.
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
 * The four outcomes are deliberately distinct:
 *
 *  · **Already filed.** The buffer holds a record with this one's `id`. Drop
 *    the checkpoint and file nothing. This is what makes "a run cannot be filed
 *    twice" a property of identity rather than a property of a `removeItem`
 *    happening to succeed — see below.
 *  · **Filed.** Appended, then deleted.
 *  · **Unparseable.** Cleared, and not filed. A half-written or hand-mangled
 *    checkpoint is unrecoverable by definition, and an earlier ordering — parse
 *    inside the same `try` as the delete — meant the throw jumped over the
 *    delete and the same junk was re-read, and re-thrown over, on every
 *    subsequent boot. Permanently stuck, permanently silent.
 *  · **Unwritable.** Kept. Storage is full or refusing writes; the checkpoint is
 *    the only copy and the next boot may have room.
 *
 * ## Why append-then-delete needs the identity check to be safe
 *
 * Append-then-delete is the right order for the *append* failing: the copy is
 * never spent before its replacement is good. But it says nothing about the
 * *delete* failing, and a `removeItem` that throws after a successful append
 * leaves a checkpoint that has already been filed — which the next boot files
 * again. Delete-first trades that for the Unparseable bug above, so neither
 * ordering is safe on its own.
 *
 * Identity breaks the trade. Every record carries an `id` minted once at
 * creation, so a re-read is recognised and refused. The delete failing then
 * costs one wasted read on the next boot and nothing else, which is the right
 * price for a rare storage fault:
 *
 *   append  delete  ->  outcome
 *   ok      ok          filed once, checkpoint gone
 *   ok      throws      filed once, checkpoint survives, next boot recognises
 *                       and clears it
 *   throws  --          not filed, checkpoint survives, next boot retries
 *
 * A record with neither an `id` nor a `startedAt` cannot be recognised, and is
 * filed on a best-effort basis. No build produces one; the fallback exists so a
 * hand-edited store degrades to the old behaviour instead of being dropped.
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

  const runs = readRuns(storage);
  const id = identityOf(record);
  if (id !== null && runs.some((r) => identityOf(r) === id)) {
    // A previous boot filed this and could not clear it. Clearing it is all
    // that is left to do, and if that throws again the next boot lands here
    // again and files nothing again — wasteful, never wrong.
    try { storage.removeItem(PARTIAL_KEY); } catch { /* private mode */ }
    return null;
  }

  try {
    runs.push(record);
    while (runs.length > MAX_RUNS) runs.shift();
    storage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch { return null; }
  try { storage.removeItem(PARTIAL_KEY); } catch { /* private mode */ }
  return record;
}

/**
 * A record's identity, or null when it has none to offer.
 *
 * `id` is what every record this build writes carries. The `seed`/`startedAt`
 * pair is the fallback for a record from before ids existed: a run is one page
 * load, and two page loads cannot share both a seed and a millisecond.
 */
function identityOf(record) {
  if (typeof record?.id === 'string' && record.id) return record.id;
  if (record?.startedAt) return `${record.seed ?? '?'}@${record.startedAt}`;
  return null;
}

/**
 * A run's identity, minted once when the record is created and never rewritten.
 * `randomUUID` where the platform has it; a seed-and-clock composite where it
 * does not, which is every path this game actually runs on plus the tests.
 */
function mintId(seed) {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* locked-down crypto; the composite below is enough */ }
  return `${seed ?? '?'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
