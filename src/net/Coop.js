import { Player } from '../entities/Player.js';
import { installViewFactories } from './NetViews.js';

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
    pawn.group?.removeFromParent();
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
}
