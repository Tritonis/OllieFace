import * as THREE from 'three';
import { Interactables } from '../world/Interactables.js';
import { ITEMS_BY_TIER } from '../data/items.js';

/**
 * Progression drives the run: which stage we're on, how hard the game is
 * allowed to be, the teleporter event, and the numbers the death screen reads.
 *
 * It owns Interactables rather than main.js registering them, because the
 * interactables' lifetime is exactly one stage and this is the system that
 * knows when a stage ends.
 */

const STAGE_NAMES = [
  'Distant Roost', 'Titanic Plains', 'Abandoned Aqueduct', 'Wetland Aspect',
  'Rallypoint Delta', 'Scorched Acres', 'Abyssal Depths', 'Siren\'s Call',
  'Sundered Grove', 'Sky Meadow',
];

const CHARGE_TIME = 90;      // seconds of standing in the ring to fill it
const LOOT_WINDOW = 8;       // beat between "boss dead" and the portal opening
const CHARGE_EMIT_STEP = 0.01;

export class Progression {
  constructor() {
    this.stageIndex = 0;
    this.stageName = STAGE_NAMES[0];
    this.difficulty = 1;
    this.state = 'idle'; // idle | charging | complete | portal

    this.charge = 0;
    this._lastEmitted = -1;
    this.bossAlive = false;
    this.bossCleared = false;
    this.lootTimer = 0;

    this.interactables = new Interactables();
    this.stats = {
      time: 0, kills: 0, elites: 0, bosses: 0,
      damageDealt: 0, damageTaken: 0, highestHit: 0,
      items: 0, goldEarned: 0, stagesCleared: 0,
    };

    this._started = false;
    this._tmp = new THREE.Vector3();
  }

  init(ctx) {
    this.ctx = ctx;
    this.interactables.init(ctx);
    ctx.progression = this;

    ctx.events.on('bossSpawn', () => { this.bossAlive = true; });
    ctx.events.on('bossDead', (e) => {
      this.bossAlive = false;
      this.bossCleared = true;
      this.stats.bosses++;
      this._dropBossItem(e?.enemy?.position || this.interactables.teleporter?.position);
    });

    ctx.events.on('kill', (e) => {
      if (e.victim?.isPlayer) return;
      this.stats.kills++;
      if (e.isElite) this.stats.elites++;
    });
    ctx.events.on('damage', (e) => {
      if (e.source?.isPlayer) {
        this.stats.damageDealt += e.amount;
        if (e.amount > this.stats.highestHit) this.stats.highestHit = e.amount;
      } else if (e.target?.isPlayer) {
        this.stats.damageTaken += e.amount;
      }
    });
    ctx.events.on('itemPickup', () => { this.stats.items++; });
    ctx.events.on('goldChanged', (e) => {
      const delta = e.gold - (this._lastGold || 0);
      if (delta > 0) this.stats.goldEarned += delta;
      this._lastGold = e.gold;
    });
    ctx.events.on('playerDead', () => { this._endRun(false); });

    // A client never advances the run; it learns a stage happened and rebuilds
    // the same world from the host's seed. What sits *on* that world is
    // replicated rather than re-rolled, so it never populates.
    ctx.events.on('stageStart', (p) => {
      if (ctx.authority) return;
      this._applyStage(typeof p?.index === 'number' ? p.index : 0, false);
      this.interactables.clear();
    });
  }

  // --------------------------------------------------------------- stage flow

  fixedUpdate(ctx, h) {
    // First stage is built on the first step so every other system has run its
    // init and the player exists to be repositioned.
    if (!this._started && ctx.authority) { this._started = true; this._beginStage(0, true); }

    this.stats.time = ctx.time;
    // Difficulty climbs with wall clock and jumps per stage — the clock is what
    // makes looting slowly a real cost.
    this.difficulty = (1 + 0.4 * (ctx.time / 60)) * Math.pow(1.15, this.stageIndex);
    ctx.difficulty = this.difficulty;

    // Teleporter charge, boss gating and stage transitions are host decisions;
    // clients see the outcome as events.
    if (ctx.authority) this._tickTeleporter(ctx, h);
    this.interactables.fixedUpdate(ctx, h);
  }

  update(ctx, dt) {
    this.interactables.update(ctx, dt);
  }

  /** Host-side stage entry: build it, fill it, announce it. */
  _beginStage(index, first = false) {
    this._applyStage(index, first);
    this.interactables.populate(index);
    this.ctx.events.emit('stageStart', { index, name: this.stageName });
    this.ctx.audio?.play?.('stageStart');
  }

  /**
   * The half both roles run: name the stage, rebuild the terrain from the
   * shared seed, reset the run flags, put the player on the new ground.
   */
  _applyStage(index, first = false) {
    const ctx = this.ctx;
    this.stageIndex = index;
    this.stageName = STAGE_NAMES[index % STAGE_NAMES.length] + (index >= STAGE_NAMES.length ? ` (Loop ${Math.floor(index / STAGE_NAMES.length) + 1})` : '');
    this.state = 'idle';
    this.charge = 0;
    this._lastEmitted = -1;
    this.bossAlive = false;
    this.bossCleared = false;
    this.lootTimer = 0;

    if (!first) {
      if (ctx.stage?.build) ctx.stage.build(index, ctx.rng);
      else ctx.stage?.rebuild?.(index);
      ctx.director?.reset?.(index);
    }

    // Reposition the player onto the freshly built ground before anything asks
    // for a spawn-relative point.
    const spawn = ctx.stage?.spawnPoint?.() || ctx.stage?.randomWalkablePoint?.(ctx.rng, { minDist: 0 }) || this._tmp.set(0, 2, 0);
    const p = ctx.player;
    if (p && !first) {
      if (p.respawnAt) p.respawnAt(spawn);
      else {
        p.position.copy(spawn);
        p.velocity?.set(0, 0, 0);
      }
    }
  }

  advanceStage() {
    this.stats.stagesCleared++;
    this._beginStage(this.stageIndex + 1);
  }

  // -------------------------------------------------------------- teleporter

  _tickTeleporter(ctx, h) {
    const tp = this.interactables.teleporter;
    if (!tp) return;

    if (this.state === 'idle') {
      if (tp.state === 'charging') {
        this.state = 'charging';
        // The boss is the event; the charge is just the timer on it.
        ctx.director?.spawnBoss?.(this.stageIndex, this.difficulty, tp.position);
        ctx.events.emit('teleporterCharging', { progress: 0 });
      }
      return;
    }

    if (this.state === 'charging') {
      const p = ctx.player;
      const inRing = p?.alive && p.position.distanceToSquared(tp.position) < tp.chargeRadius * tp.chargeRadius;
      if (inRing && this.charge < 1) {
        this.charge = Math.min(1, this.charge + h / CHARGE_TIME);
        tp.setProgress(this.charge);
        if (this.charge - this._lastEmitted >= CHARGE_EMIT_STEP || this.charge >= 1) {
          this._lastEmitted = this.charge;
          ctx.events.emit('teleporterCharging', { progress: this.charge });
        }
      }
      // Both conditions, in either order: the ring can finish while the boss is
      // still up, and the boss can die while the ring is empty.
      if (this.charge >= 1 && this.bossCleared && !this.bossAlive) {
        this.state = 'complete';
        tp.state = 'complete';
        this.lootTimer = LOOT_WINDOW;
        ctx.events.emit('teleporterComplete', {});
        ctx.audio?.play?.('teleporterComplete', tp.position);
        ctx.vfx?.burst?.(tp.position, 0x2ad0ff);
      }
      return;
    }

    if (this.state === 'complete') {
      this.lootTimer -= h;
      ctx.events.emit('lootWindow', { remaining: Math.max(0, this.lootTimer) });
      if (this.lootTimer <= 0) {
        this.state = 'portal';
        const at = tp.position.clone().add(this._tmp.set(4, 0, 0));
        this.interactables.spawnPortal(at, () => this.advanceStage());
      }
    }
  }

  _dropBossItem(position) {
    // `bossDead` is replicated, so a client reaches here too — and picking from
    // the boss pool would advance the gameplay stream it must not touch.
    if (!this.ctx.authority || !position) return;
    const pool = ITEMS_BY_TIER.boss;
    if (!pool?.length) return;
    const id = this.ctx.rng.pick(pool).id;
    // Boss items come from the boss, not the teleporter, so the drop lands
    // where the kill happened and the player has to go get it.
    this.interactables.spawnOrb(position, id, 2.2);
  }

  // ------------------------------------------------------------------ run end

  _endRun(won) {
    if (this._ended) return;
    this._ended = true;
    this.ctx.events.emit('runEnd', {
      won,
      stats: this.runStats(),
    });
  }

  /** Snapshot for the death screen. */
  runStats() {
    const items = this.ctx.items?.inventory?.() || [];
    return {
      ...this.stats,
      stage: this.stageIndex + 1,
      stageName: this.stageName,
      difficulty: this.difficulty,
      gold: this.ctx.items?.gold || 0,
      inventory: items,
      timeText: formatTime(this.stats.time),
    };
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
