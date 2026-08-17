// src/systems/Codex.js
import { MUTATION } from '../data/corruption.js';
import { CODEX_BY_ID, ROUTE_BRIEF_STAGE } from '../data/codex.js';
import { BLIGHT_BY_BASE, ITEM_BY_ID } from '../data/items.js';

/**
 * The corruption codex's trigger wiring (issue #34).
 *
 * The logbook had 1069 lines and not one of them about the run's second
 * economy: everything a player knows about corruption is inferred from a gauge
 * moving. This system is the half that decides *when* a page is written. It
 * owns no frame time, changes nothing about the run, and every one of its
 * listeners is a pure read followed at most by a profile write.
 *
 * ## Progressive disclosure is the design, not a nicety
 *
 * Each page is written the moment the player first meets the mechanic it
 * describes and not one moment before. A corruption tab that opens fully
 * written is a tutorial wall on five systems the player has met none of; a tab
 * that fills in behind them is a record of their own run. So every trigger
 * below is an *event*, never a poll of "does the player probably know this by
 * now", and the sealed state is the default.
 *
 * ## Why this rides the bus rather than living in the systems it watches
 *
 * The same one-way rule `Corruption` documents: `Corruption`, `Items`,
 * `ArgentFont` and `Progression` all emit what they did, and what anybody does
 * about it is not their problem. Nothing here is imported by them, and deleting
 * this file changes no gameplay behaviour at all.
 *
 * ## Not authority-gated
 *
 * Deliberately, and for the reason `Profile` states in its own header: a client
 * earns their own unlocks playing on someone else's host. What *is* host-shaped
 * is the data — `Corruption.feed` is authority-gated and the gauge is not
 * replicated, so a client's world stays 0 and the corruption-driven pages
 * simply never fire there. That is a co-op gap in the gauge, not in this file,
 * and it closes the day corruption replicates.
 */
export class Codex {
  // Noncritical, and this is the one place it is worth arguing. Nothing here
  // is load-bearing: a throw costs a logbook page and the run continues
  // exactly as it would have. Halting a run because a paragraph could not be
  // filed would be the observation changing the thing observed.
  static critical = false;

  constructor() {
    this._unsub = [];
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.codex = this;
    const on = (name, fn) => {
      const off = ctx.events.on(name, fn);
      if (off) this._unsub.push(off);
    };

    // 1. First feed. `corruptionChanged` fires on every move of the gauge in
    //    both directions, so the guard is the world having left zero rather
    //    than the event having happened — a bleed on a pristine world would
    //    otherwise write the page about a price nobody paid.
    on('corruptionChanged', (e) => {
      const world = e?.world ?? 0;
      if (!(world > 0)) return;
      this.record('first-feed', { world, band: e?.band ?? 0 });
      // The blight-toll page is a *state*, not an instant — "you are in Seeded
      // and carrying something the next band can take" — so it is evaluated on
      // both of the two events that can make it true.
      this._checkToll();
    });

    // 2. Seeded. The band event, not a threshold comparison here: `bandOf` is
    //    the one derivation of what band a world is in and a second copy of it
    //    would be a second thing to re-tune.
    on('corruptionBand', (e) => {
      if ((e?.band ?? 0) >= 1) this.record('seeded', { world: this.ctx.corruption?.world ?? 0 });
      this._checkToll();
    });

    // 3. The toll, while it can still be avoided. See `_checkToll`.
    on('itemPickup', () => this._checkToll());

    // 4. The first font press. `fontUse` carries the whole transaction — the
    //    four numbers issue #29 asked the record for — and it is emitted only
    //    by a press that actually completed, so there is nothing to validate.
    on('fontUse', (e) => {
      if (!e) return;
      this.record('argent-font', {
        cost: e.cost, removed: e.removed,
        worldBefore: e.worldBefore, worldAfter: e.worldAfter,
        bandBefore: e.bandBefore, bandAfter: e.bandAfter,
        stage: e.stage,
      });
    });

    // 5. The finale briefing, one stage before the doors exist. `stageStart`
    //    carries the zero-based index; `ROUTE_BRIEF_STAGE` is the number the
    //    player sees, which is what the page's own copy talks in.
    on('stageStart', (e) => {
      const shown = (e?.index ?? 0) + 1;
      if (shown < ROUTE_BRIEF_STAGE) return;
      const cor = this.ctx.corruption;
      this.record('finale-route', { world: cor?.world ?? 0, band: cor?.band ?? 0, stage: shown });
    });
  }

  /**
   * The one page whose moment is a window rather than an instant: the world is
   * in the band below the first blight toll, and the pack is holding something
   * that toll could take. Both halves matter — the page's whole content is
   * "this will be taken from you, and here is what is eligible", and writing it
   * for an empty pack would name nothing.
   *
   * One known gap, stated rather than defended: a run that crosses from
   * Pristine straight past Seeded in a single act (a forced legendary chest on
   * greed time, the largest single source in the table) never occupies the
   * window and leaves the page sealed until a cleanse brings the world back
   * down to it. Firing it on the crossing instead would be a page about a toll
   * that has already been collected, which is the front-loaded reading this
   * feature exists to avoid.
   */
  _checkToll() {
    const band = this.ctx.corruption?.band ?? 0;
    if (band !== MUTATION.minBand - 1) return;
    const eligible = this.eligibleStacks();
    if (!eligible.length) return;
    this.record('blight-toll', { eligible, world: this.ctx.corruption?.world ?? 0 });
  }

  /**
   * The names of the held stacks a blight toll could take, sorted.
   *
   * Derived here from the public inventory and the `BLIGHT_BY_BASE` table
   * rather than asked of `Items`, so that observing the economy needs no seam
   * cut into the system that runs it. It is the same predicate `Items._mutateAt`
   * selects on — a stack held in a positive count that has a blight counterpart
   * — and the drift risk is real but bounded: this list is prose in a logbook,
   * never an input to a transaction.
   */
  eligibleStacks() {
    const inv = this.ctx.items?.inventory?.() || [];
    const out = [];
    for (const row of inv) {
      if (!row || !(row.count > 0) || !BLIGHT_BY_BASE.has(row.id)) continue;
      out.push(row.def?.name || ITEM_BY_ID.get(row.id)?.name || row.id);
    }
    out.sort();
    return out;
  }

  /**
   * Write a page, once. The unlock is the lifecycle and the facts are the
   * history; both refuse a second write, so a page cannot be rewritten by a
   * later, less formative version of its own moment.
   *
   * Returns true when this call is what earned it.
   */
  record(id, facts) {
    if (!CODEX_BY_ID.has(id)) return false;
    const profile = this.ctx?.profile;
    if (!profile?.unlock) return false;
    if (profile.unlockedAt?.('codex', id)) return false;
    // Facts first: `unlock` emits `unlockEarned`, and a toast that fires before
    // the numbers behind the page exist would open onto a half-written entry.
    profile.noteCodex?.(id, facts);
    return profile.unlock('codex', id);
  }

  /** Has the player earned this page? The logbook's gate. */
  has(id) {
    return !!this.ctx?.profile?.unlockedAt?.('codex', id);
  }

  dispose() {
    for (const off of this._unsub) off();
    this._unsub = [];
  }
}
