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
 * object with a `position` and an `alive` flag can register. The reason that is
 * worth the constraint today is testability — `tests/roster.test.mjs` and
 * `tests/targeting.test.mjs` between them drive every path in this file,
 * including the targeting hysteresis, which is `targeting.test.mjs`'s subject
 * and not `roster.test.mjs`'s. Both do it with plain object literals, and a
 * suite that had to build real `Player`s to ask a question about a roster would
 * not be the decisive one it is.
 *
 * Forward intent, stated as intent because it is not built: a client *could*
 * register its interpolated `PlayerView`s here for teammate health bars without
 * pulling the entity layer into the net layer. Nothing does. `add` has exactly
 * one caller (`Player.init`), the net layer never mentions this file, and there
 * are no teammate bars in the HUD. Do not read the paragraph above as a live
 * requirement; if that consumer never arrives, the testability argument is the
 * one that has to carry the constraint on its own.
 *
 * Single-player registers exactly one entity, `nearest()` returns it for every
 * query, and every number in the game is what it was before this file existed.
 * That invariant is the whole safety argument for the migration; see
 * `tests/sp-equivalence.mjs`.
 */

// Scratch for `distanceToNearest`, so the hot path allocates nothing.
const _q = { player: null, dist: Infinity };

/**
 * Horizontal distance between two `{x, z}` points.
 *
 * `Math.hypot(dx, dz)` and not `Math.sqrt(dx * dx + dz * dz)`, and the choice is
 * load-bearing rather than stylistic: `dist2D` in `Enemy.js` — the function this
 * system exists to take over — is `Math.hypot`, and the two disagree on doubles.
 * Over 2,000,000 random coordinate pairs in a +/-60 m arena they return a
 * different double 38.5% of the time, by up to 2 ulp, because `hypot` is
 * computed to avoid intermediate overflow while `dx * dx + dz * dz` rounds twice
 * before the root. An enemy that picks its target through this file and then
 * measures the range with `dist2D` would be comparing one player's arithmetic
 * against another's, and `Enemy.js` tests that distance against tuned engagement
 * thresholds — a single evaluation landing on a threshold flips a state
 * transition. Matching the formula makes the migration bit-exact by construction
 * instead of by argument. `tests/roster.test.mjs` asserts the parity.
 *
 * Sign does not matter: `hypot` works on magnitudes, so the reversed operand
 * order here relative to `dist2D`'s (enemy - player) is exact, not approximate.
 *
 * One definition, used by every distance in this file. The hysteresis in
 * `acquireTarget` compares a held target's distance against a rival's, so the
 * two must be computed the same way or `SWITCH_MARGIN` stops meaning what its
 * comment says.
 */
function horizDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export class Roster {
  // The registry every targeting query in the game reads. A throw here leaves
  // enemies choosing between the wrong players, or between none.
  static critical = true;

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

  /**
   * The pawn this machine's camera and HUD follow.
   *
   * This is `ctx.player` and nothing more: it does **not** imply membership of
   * `all`, nor targetability. `ctx.player` outlives the local player's death
   * (`alive` goes false and nothing clears the reference) and would outlive a
   * `dispose` that spliced the entity out of the roster. Ask `nearest` or
   * `Roster.targetable` if what you want is a legal target.
   */
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
   * `dist2D` is already what `Enemy` compares against — same formula, see
   * `horizDist`; including height would make an enemy on a ledge below you read
   * as further away than one across the arena and change engagement ranges the
   * encounter design is tuned around.
   *
   * `pos` is required and is dereferenced without a guard. A caller that has no
   * position has no question to ask, so throwing is the honest answer.
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
      const d = horizDist(p.position, pos);
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
 * roster, and because a 1,758-line entity file (`wc -l src/entities/Enemy.js`,
 * at this commit) should not be exporting symbols that exist for a test.
 *
 * `roster` is guarded and `pos` is not, deliberately. Callers reach this through
 * `ctx.roster`, which is legitimately absent in a headless or partially built
 * context — the same reason `Player.init` writes `ctx.roster?.add?.(this)`. A
 * missing `pos` is a caller bug with no sensible fallback, so it throws.
 *
 * The membership test is not redundant with the targetable one: a despawned pawn
 * is spliced out of `all` while still reading as alive, and it is usually the
 * nearest thing to the enemy that was fighting it. Without that clause the
 * margin keeps it and the enemy chases a released mesh forever.
 */
export function acquireTarget(roster, pos, current) {
  if (!roster) return null;
  roster.nearest(pos, _acq);
  const best = _acq.player;
  if (!best) return null;
  if (!current || !Roster.targetable(current) || roster.all.indexOf(current) < 0) return best;
  if (best === current) return current;
  const currentDist = horizDist(current.position, pos);
  return _acq.dist < currentDist * SWITCH_MARGIN ? best : current;
}
