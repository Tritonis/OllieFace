// src/systems/Vows.js
import { VOWS, VOW_WARD, selectVow } from '../data/vows.js';

/**
 * Stage Vows — the proactive Pure path (issue #177).
 *
 * One vow is offered at the top of every stage, and it is the run's only one:
 * a single visible promise with a condition the player can actually fail, as
 * against the clean route's previous action set of "decline things". `data/vows.js`
 * holds the table and the pure reducers; this class owns the scope — when a vow
 * opens, what closes it, and the one place it pays.
 *
 * ## The scope is the stage, and the stage boundary is `stageStart`
 *
 * `Progression` has no stage-*end* event, so the next `stageStart` is what
 * closes the previous vow, with `runEnd` as the other terminal. That is not a
 * workaround: a stage ends exactly when the next one begins, and hanging the
 * close off the same event that opens the successor means there is no reachable
 * state with two vows open or with none between stages.
 *
 * ## Host-authoritative, and visibly so
 *
 * `_open` is authority-gated, so a guest holds no vow and shows no vow line.
 * That is the prototype's deliberate scope: the ledger `vowKept` pays into is
 * host-local by construction (`Corruption.commit`), so a guest-side vow could
 * award nothing and would only ever be a promise the game could not keep. A
 * guest-visible mirror belongs with whatever replicates the ledger, not here.
 *
 * ## Failure costs nothing
 *
 * `_close` has exactly one branch that touches the world, and it is the kept
 * one. A broken vow emits its event, the HUD toasts it, and the run is
 * otherwise identical to one that was never offered a vow at all — see the
 * "Failure is legible and free" note in `data/vows.js` for why `vowBroken`
 * stays unwired despite being declared in the alignment table.
 */

/** Every event any vow subscribes to, deduplicated. Derived, never typed. */
const WATCHED = [...new Set(VOWS.flatMap((v) => v.events))];

export class Vows {
  /**
   * Non-critical. A Vows that threw and was disabled costs the run its purity
   * progression, which is a loss — but it owns no world state, no frame budget
   * anything else waits on, and no invariant another system reads. The run is
   * playable without it in a way it is not playable without `Progression`, and
   * that is exactly the line `critical` draws.
   */
  static critical = false;

  constructor() {
    /** `{ vow, index, count, t }` while a vow is open; null otherwise. */
    this.active = null;
    this.ctx = null;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.vows = this;
    ctx.events.on('stageStart', ({ index } = {}) => {
      // Close before open, so the outgoing vow's payout lands against the stage
      // it was made on and the incoming one starts from a clean scope.
      this._close('lapsed');
      this._open(Number.isFinite(index) ? index : 0);
    });
    ctx.events.on('runEnd', () => { this._close('lapsed'); });
    for (const name of WATCHED) {
      ctx.events.on(name, (payload) => this._step(name, payload));
    }
  }

  /** Stage-scoped seconds, which the timing vow reads as `state.t`. */
  update(ctx, dt) {
    if (this.active) this.active.t += dt;
  }

  /** One line for the HUD: the promise and how it stands. Empty when none. */
  get line() {
    const a = this.active;
    if (!a) return '';
    return `${a.vow.title} — ${a.vow.progress(a.vow, a)}`;
  }

  _open(index) {
    if (!this.ctx?.authority) return;
    const vow = selectVow(this.ctx.seed ?? 0, index);
    if (!vow) return;
    this.active = { vow, index, count: 0, t: 0 };
    this.ctx.events.emit('vowOffered', {
      id: vow.id, kind: vow.kind, title: vow.title, stage: index,
      text: vow.describe(vow),
    });
  }

  _step(name, payload) {
    const a = this.active;
    if (!a || !a.vow.events.includes(name)) return;
    const verdict = a.vow.step(name, payload, a, a.vow, this.ctx);
    if (verdict === 'kept' || verdict === 'broken') this._close(verdict);
  }

  /**
   * Resolve the open vow. `reason` is 'kept', 'broken', or 'lapsed' — the
   * stage ended with the condition neither met nor violated, which each vow
   * reads for itself through `keptOnClose` (restraint is kept by having lasted;
   * combat and timing simply did not happen).
   */
  _close(reason) {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const kept = reason === 'kept' || (reason === 'lapsed' && a.vow.keptOnClose === true);
    if (kept) {
      // The whole reward, in the order the ledger reads best: the warding
      // first, so `vowKept`'s history entry is the last word on the act.
      this.ctx?.corruption?.ward?.(VOW_WARD);
      this.ctx?.corruption?.commit?.('vowKept');
    }
    this.ctx?.events?.emit?.('vowResolved', {
      id: a.vow.id, kind: a.vow.kind, title: a.vow.title, stage: a.index,
      kept, reason, warded: kept ? VOW_WARD : 0,
    });
  }
}
