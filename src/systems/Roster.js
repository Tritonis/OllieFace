/**
 * Every player in the run, and the one query that picks between them.
 *
 * `ctx.player` means three different things across this codebase: the player
 * this screen belongs to (HUD, camera, the local half of Combat), the one
 * player the authority simulates (Enemy, Director), and the owner of a piece of
 * gameplay state (Items, Progression). The first is correct and stays. This
 * system exists to answer the second, so that an enemy asks *which* player
 * rather than assuming there is one.
 *
 * It deliberately does not import THREE and does not know what a Player is: any
 * object with a `position` and an `alive` flag can register, which is what lets
 * a client register its interpolated `PlayerView`s for the HUD's teammate bars
 * without pulling the entity layer into the net layer.
 *
 * Single-player registers exactly one entity, `nearest()` returns it for every
 * query, and every number in the game is what it was before this file existed.
 * That invariant is the whole safety argument for the migration; see
 * `tests/sp-equivalence.mjs`.
 */

// Scratch for `distanceToNearest`, so the hot path allocates nothing.
const _q = { player: null, dist: Infinity };

export class Roster {
  constructor() {
    this.all = [];
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.roster = this;
  }

  /**
   * A legal target: present, alive, and not downed.
   *
   * `downed` is honoured here from the start even though nothing sets it yet.
   * Revive (P3) introduces a state where a player is registered, rendered and
   * addressable but must not be attacked; putting the check in now means that
   * round never has to reopen the targeting hot path.
   */
  static targetable(p) {
    return !!p && p.alive !== false && p.downed !== true;
  }

  add(p) {
    if (!p || this.all.indexOf(p) >= 0) return p;
    this.all.push(p);
    return p;
  }

  remove(p) {
    const i = this.all.indexOf(p);
    if (i >= 0) this.all.splice(i, 1);
  }

  get count() { return this.all.length; }

  /** The pawn this machine's camera and HUD follow. */
  get local() { return this.ctx?.player ?? null; }

  /**
   * Freshly allocated — for UI and reports, never for a per-enemy per-step
   * call. Hot paths use `nearest` or `forEachTargetable`, which allocate
   * nothing.
   */
  get alive() { return this.all.filter(Roster.targetable); }

  /**
   * Nearest targetable player to `pos`, by horizontal distance, or null.
   *
   * Horizontal because every consumer is a ground-based engagement range and
   * `dist2D` is already what `Enemy` compares against; including height would
   * make an enemy on a ledge below you read as further away than one across the
   * arena and change engagement ranges the encounter design is tuned around.
   *
   * Ties resolve to the earlier registration, which makes the result stable
   * across steps: two players standing exactly together must not make every
   * enemy in the arena flip target every time this is called.
   */
  nearest(pos, out = null) {
    let best = null;
    let bestD = Infinity;
    const list = this.all;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!Roster.targetable(p)) continue;
      const dx = p.position.x - pos.x;
      const dz = p.position.z - pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (out) { out.player = best; out.dist = best ? bestD : Infinity; }
    return best;
  }

  /** Horizontal distance to the nearest targetable player, or Infinity. */
  distanceToNearest(pos) {
    this.nearest(pos, _q);
    return _q.dist;
  }

  /** Visit every targetable player in registration order. Allocates nothing. */
  forEachTargetable(fn) {
    const list = this.all;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (Roster.targetable(p)) fn(p);
    }
  }
}

/**
 * How much nearer a rival has to be before a hunter will change its mind.
 *
 * At 1.0 there is no hysteresis at all and two players standing together make
 * every enemy in the arena flip target on every evaluation — the pack visibly
 * shivers and no attack ever completes its wind-up against one person. Near 0
 * an enemy never switches, so it will chase one survivor across the whole stage
 * past a teammate standing on top of it. 0.8 means "meaningfully closer".
 */
export const SWITCH_MARGIN = 0.8;

const _acq = { player: null, dist: Infinity };

/**
 * Pick who a hunter at `pos` is fighting, given who it is fighting now.
 *
 * Sticky: the current target is kept until it stops being targetable, leaves
 * the roster, or someone else is decisively nearer. Everything about co-op
 * combat reading as coherent rather than twitchy is in that word.
 *
 * Lives here rather than in `Enemy.js` because it is a question about the
 * roster, and because a 1600-line entity file should not be exporting symbols
 * that exist for a test.
 */
export function acquireTarget(roster, pos, current) {
  if (!roster) return null;
  roster.nearest(pos, _acq);
  const best = _acq.player;
  if (!best) return null;
  if (!current || !Roster.targetable(current) || roster.all.indexOf(current) < 0) return best;
  if (best === current) return current;
  const dx = current.position.x - pos.x;
  const dz = current.position.z - pos.z;
  const currentDist = Math.sqrt(dx * dx + dz * dz);
  return _acq.dist < currentDist * SWITCH_MARGIN ? best : current;
}
