import { Player } from '../entities/Player.js';
import { installViewFactories } from './NetViews.js';
import { Items } from '../systems/Items.js';

/**
 * The seam between the netcode and the game.
 *
 * `src/net/` is written to be independent of the gameplay systems: NetHost asks
 * for a pawn when someone joins, NetClient asks for a view when an entity
 * appears, and neither knows what those are. This system answers all three
 * questions, and is the only place that imports both halves.
 *
 * It is a normal engine system so it costs a single no-op `update` in
 * single-player, where `pawns` is empty and no client exists.
 */
export class Coop {
  constructor() {
    this.pawns = [];
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.coop = this;

    // --- host side: a pawn per remote player ------------------------------
    ctx.spawnRemotePlayer = (peerId) => this._spawnPawn(peerId);
    ctx.despawnRemotePlayer = (pawn) => this._despawnPawn(pawn);

    // --- client side: adopt the host's world -------------------------------
    ctx.events.on('netWelcome', (w) => this._onWelcome(w.seed, w.stageIndex, w.time, w.artifactMask, w.difficulty));
  }

  /** Called by Lobby the moment a NetClient exists, before it connects. */
  attachClient(client) {
    installViewFactories(client, this.ctx);
  }

  // ------------------------------------------------------------------ host

  _spawnPawn(peerId) {
    const ctx = this.ctx;
    const pawn = new Player({ local: false });
    // `init` is the whole of Player's construction — it registers with Combat
    // (so enemies target this player and it can be hurt), builds its rig and
    // parks it on the stage. It skips claiming `ctx.player` because it is not
    // the local one.
    pawn.init(ctx);
    pawn.peerId = peerId;

    // Its own economy: a remote pawn's items and gold must never share the
    // local viewer's `ctx.items`, or a joiner's pickup would show up in the
    // host's own inventory. `Items.of` is how every later economy action
    // finds this instance again.
    pawn.items = new Items(pawn);
    pawn.items.init(ctx);

    // Drop it on the local player rather than the origin, so a joiner lands in
    // the fight instead of walking in from spawn.
    const anchor = ctx.player?.position;
    if (anchor) {
      const y = ctx.stage?.sampleHeight?.(anchor.x + 2, anchor.z + 2);
      pawn.position.set(anchor.x + 2, typeof y === 'number' && isFinite(y) ? y + 0.2 : anchor.y, anchor.z + 2);
    }

    this.pawns.push(pawn);
    return pawn;
  }

  _despawnPawn(pawn) {
    const i = this.pawns.indexOf(pawn);
    if (i >= 0) this.pawns.splice(i, 1);
    this.ctx.combat?.unregister?.(pawn);
    // Detaching the group is not releasing the pawn: `Player.init` subscribes
    // to `stageStart`, and a live bus subscription pins the whole object. This
    // list going empty while the listeners accumulated is exactly what made the
    // leak invisible — `pawns.length` read zero and looked correct. The pawn's
    // satellite `Items` has the same problem and the same fix.
    pawn.items?.dispose?.();
    pawn.dispose?.();
  }

  // ---------------------------------------------------------------- client

  _onWelcome(seed, stageIndex, time, artifactMask = 0, difficulty = 1) {
    const ctx = this.ctx;
    // Rules before the world: `Interactables` and the stat block both read the
    // artifact set the moment the stage below is rebuilt, and a client that
    // adopted Sacrifice one frame late would have spawned the chests first.
    ctx.artifacts?.adoptHost?.(artifactMask, difficulty);
    // The world is never streamed — it is regenerated from this one number.
    // Stage.build is a pure function of (ctx.seed, index), so setting the seed
    // before the rebuild is what makes host and client stand on the same rock.
    ctx.seed = seed >>> 0;
    ctx.time = time || 0;
    ctx.progression?.syncStage(stageIndex || 0);
  }

  // ---------------------------------------------------------------- frames

  /**
   * Remote pawns are simulated by NetHost (it feeds them `applyCommand` off the
   * wire) but nothing animates them: they are not engine systems, so their
   * `update` — the rig, the dash trail, their projectile pool — has to be
   * driven from here.
   */
  update(ctx, dt) {
    for (let i = 0; i < this.pawns.length; i++) this.pawns[i].update(ctx, dt);
  }

  /**
   * The same gap on the simulation side, for the same reason: a remote pawn's
   * `Items` is not an engine system either, so nothing stepped it. Everything
   * `Items.fixedUpdate` owns was therefore dead for a joiner — the corruption
   * tolls the band claimed never drained (its pack never festered, so the
   * directed `itemMutated` could never fire), buffs never expired, the barrier
   * never decayed, `onInterval` cards never ticked and the equipment slot never
   * recharged.
   *
   * Driven from here rather than by registering satellites with the Engine:
   * `Engine.fixedUpdate` iterates `this.systems` in registration order, and
   * splicing pawns in and out of that list as players join and leave would
   * reorder the whole simulation mid-run. This is one call in a slot that
   * already exists, and the pawn list is empty in single-player.
   *
   * Host-only, like every other satellite: a client owns no pawns.
   */
  fixedUpdate(ctx, h) {
    if (!ctx.authority) return;
    for (let i = 0; i < this.pawns.length; i++) this.pawns[i].items?.fixedUpdate?.(ctx, h);
  }
}
