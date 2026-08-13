import { REVIVE } from '../data/revive.js';
import { Roster } from './Roster.js';
import { BTN } from '../net/Protocol.js';

/**
 * The clock on a downed body, and the four ways it can stop.
 *
 * This system owns every transition *out* of the downed state: bleeding out
 * (the clock runs down and `Combat.finishDowned` makes it a real death), being
 * picked up (a teammate stands over you long enough), the wipe (nobody is left
 * to come for anyone, so every body finishes at once) and the stage return (a
 * new stage hands the whole party back their legs at half health). It never
 * puts anyone *into* the state — that fork is `Combat.applyDamage`'s and stays
 * there — never deals or heals damage through any path but the two health
 * fractions below, and never touches a pawn's build: `items` is not its
 * business and is exactly what survives a death untouched.
 *
 * Host-only, entirely. A client learns all four endings from the wire as the
 * events they emit, the same way it learns about a death.
 *
 * Single-player pays one loop over a roster of one and returns: nobody is ever
 * downed solo (the Combat fork needs two pawns), so the scan below cannot
 * reach anything that writes state. That is the invariant `npm run gate:sp`
 * holds this file to.
 */

/**
 * Clocks are seconds and steps are `1/60`, which do not divide: 2400 additions
 * of `h` land 1.3e-9 short of `BLEEDOUT_S` and 240 land 4e-16 short of a full
 * revive, so a bare `<= 0` / `>= 1` costs one extra frame at the end of every
 * clock in the game. The tuning table is written in seconds, so a tolerance of
 * a millionth of one makes the frame count match the number a designer typed.
 */
const EPS = 1e-6;

/**
 * Horizontal distance, `Roster.horizDist`'s formula (`Math.hypot`, not the
 * squared sum — see the note there; the two disagree on doubles and every
 * distance the roster answers is measured this way).
 */
function horizDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Is this pawn asking to pick someone up?
 *
 * The *held* bit, not `interactPressed`. That flag is an edge — `Player._commit`
 * recomputes it from `pressed`, so a key held down for four seconds sets it on
 * exactly one tick — and a revive is a hold. The edge is still honoured because
 * the tick a press starts is a tick the button is also down, and reading both
 * means a scan does not depend on where in the step order this system sits.
 *
 * `lastCommand` is written by `_commit` for every pawn the host simulates, the
 * local survivor included (`Player.fixedUpdate` samples the keyboard into one),
 * so this is the same question on both halves of a co-op session.
 */
function holdingInteract(p) {
  return p.interactPressed === true || ((p.lastCommand?.buttons | 0) & BTN.INTERACT) !== 0;
}

export class Revive {
  init(ctx) {
    this.ctx = ctx;
    ctx.revive = this;
    ctx.events.on('stageStart', () => this._returnParty());
  }

  fixedUpdate(ctx, h) {
    if (!ctx.authority) return;
    const list = ctx.roster?.all;
    if (!list) return;

    // One pass to clear last tick's `reviving` flags and count the room. The
    // flag has to be cleared for *every* pawn, not just the ones the scan below
    // reaches: a reviver who walks away while the body is still down would
    // otherwise keep a stale flag and never be able to open a chest again.
    let downed = 0;
    let standing = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      p.reviving = false;
      if (p.downed === true) downed++;
      else if (Roster.targetable(p)) standing++;
    }
    if (downed === 0) return;

    // The wipe. Bodies on the floor and nobody upright: there is no ending left
    // to wait for, so the party dies now rather than watching four clocks run
    // down in silence. The deaths are ordinary ones and cascade into the
    // existing run-end (`Progression`'s `playerDead` listener, :218 — each
    // machine ends its own run on its own pawn's death, and in a wipe every
    // pawn dies). Guarded on two pawns because a roster of one is never downed
    // in the first place; if one ever were, this must not be what kills it.
    if (standing === 0 && list.length > 1) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p?.downed === true) ctx.combat?.finishDowned?.(p);
      }
      return;
    }

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.downed !== true) continue;

      // The clock runs no matter who is standing over the body — a revive is a
      // race against it, not a pause button.
      p.bleedout -= h;
      if (p.bleedout <= EPS) {
        // Announced before the death it causes, so a listener can tell a body
        // that ran out of time from one that was shot.
        ctx.events.emit('playerBledOut', { player: p, position: p.position });
        ctx.combat?.finishDowned?.(p);
        continue;
      }

      const by = this._reviverFor(list, p);
      if (by) {
        by.reviving = true;
        p.revive += h / REVIVE.REVIVE_S;
        if (p.revive >= 1 - EPS) this._stand(p, by);
      } else {
        // Twice as fast down as up: leaving a body half-picked-up has to cost
        // something, or the safe play is to tap it between waves forever.
        p.revive = Math.max(0, p.revive - 2 * h / REVIVE.REVIVE_S);
      }
    }
  }

  /**
   * The first legal pawn holding interact within reach of this body, in
   * registration order. Allocates nothing.
   *
   * `Roster.targetable` is the filter and it is the whole rule: a downed pawn
   * cannot pick up another downed pawn (two bodies next to each other are a
   * wipe waiting to happen, not a rescue), and neither can a corpse.
   */
  _reviverFor(list, downedPawn) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || r === downedPawn || !Roster.targetable(r)) continue;
      if (!holdingInteract(r)) continue;
      if (horizDist(r.position, downedPawn.position) <= REVIVE.REVIVE_RADIUS) return r;
    }
    return null;
  }

  /** Picked up. Both clocks are cleared; the health is the whole cost of it. */
  _stand(pawn, by) {
    pawn.downed = false;
    pawn.bleedout = 0;
    pawn.revive = 0;
    pawn.health = REVIVE.REVIVE_HEALTH_FRAC * maxHealthOf(pawn);
    // Broadcast, not directed, like `playerDowned`: every peer needs to see a
    // teammate get back up. The pawns ride by reference — the wire translation
    // is `NetHost.sanitise`'s job, not this system's.
    this.ctx.events.emit('playerRevived', { player: pawn, by, position: pawn.position });
  }

  /**
   * A new stage is the amnesty: everyone who is dead or down comes back.
   *
   * Nothing is rebuilt to do it. A pawn's `items` was never torn down when it
   * died, so the build that walks into the next stage is the one that fell in
   * the last one — the only things this writes are the flags, the clocks, the
   * health and where the pawn is standing.
   *
   * Placement copies `Coop._spawnPawn`: park them on the local player, who
   * `Progression._applyStage` has already moved onto the new ground by the time
   * `stageStart` is emitted. The anchor is read once, before anyone moves, so a
   * party of four does not walk itself two metres further out per pawn.
   */
  _returnParty() {
    const ctx = this.ctx;
    if (!ctx.authority) return;
    const list = ctx.roster?.all;
    if (!list) return;

    const anchor = ctx.player?.position;
    const ax = anchor ? anchor.x : 0;
    const ay = anchor ? anchor.y : 0;
    const az = anchor ? anchor.z : 0;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || (p.alive !== false && p.downed !== true)) continue;

      p.alive = true;
      p.downed = false;
      p.bleedout = 0;
      p.revive = 0;
      p.reviving = false;
      p.health = REVIVE.RETURN_HEALTH_FRAC * maxHealthOf(p);
      p.velocity?.set?.(0, 0, 0);

      if (anchor) {
        const y = ctx.stage?.sampleHeight?.(ax + 2, az + 2);
        p.position.set(ax + 2, typeof y === 'number' && isFinite(y) ? y + 0.2 : ay, az + 2);
      }
    }
  }
}

/** `stats.maxHealth` first, the mirrored field behind it — `Player.heal`'s idiom. */
function maxHealthOf(p) {
  return p.stats?.maxHealth || p.maxHealth || 100;
}
