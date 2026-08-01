import * as THREE from 'three';
import { Interactables } from '../world/Interactables.js';
import { ITEMS_BY_TIER } from '../data/items.js';
import { BIOMES, stageNameFor } from '../world/Materials.js';
import { Profile } from './Profile.js';

/**
 * Progression drives the run: which stage we're on, how hard the game is
 * allowed to be, the teleporter event, and the numbers the death screen reads.
 *
 * It owns Interactables rather than main.js registering them, because the
 * interactables' lifetime is exactly one stage and this is the system that
 * knows when a stage ends.
 *
 * For the same reason it owns `Profile`: the profile's only lifecycle is "a run
 * started" / "a run ended", and this is the system that knows both. The profile
 * costs no frame time (every counter is an event handler, every write is on a
 * debounce timer), so giving it a slot in the engine's update loop would
 * advertise a cost it does not have.
 */

// How many stages you can play before a name repeats: four biomes, each with
// three named variants. The names themselves live with the biomes in
// Materials.js so a stage's name and its look can never drift apart.
const NAME_CYCLE = BIOMES.length * BIOMES[0].names.length;

/** The displayed stage name, loop suffix included. */
function fullStageName(index) {
  return stageNameFor(index) + (index >= NAME_CYCLE ? ` (Loop ${Math.floor(index / NAME_CYCLE) + 1})` : '');
}

const CHARGE_TIME = 90;      // seconds of standing in the ring to fill it
const LOOT_WINDOW = 8;       // beat between "boss dead" and the portal opening
const CHARGE_EMIT_STEP = 0.01;

/**
 * Survivor level.
 *
 * The run levels the whole team, RoR2-style: one shared level, earned from
 * every kill, driving the player stat curve in `Player._levelBase`. It lives
 * here rather than on Player because it is run state, not entity state — a
 * co-op host has several Player instances and they must all read one number,
 * or the host's simulation of a remote pawn and that client's own prediction
 * of it would use different stats.
 *
 * Cost curve: `5 * level^1.35`. Level 20 lands a little past 2500 total XP,
 * which is roughly a 20-minute run at the tuned spawn rate.
 */
const XP_BASE = 5;
const XP_EXP = 1.35;
export function xpForLevel(level) {
  return Math.max(1, Math.round(XP_BASE * Math.pow(Math.max(1, level), XP_EXP)));
}
// Same shape the Director uses for monster levels, so a level of parity means
// parity. See Director.js:10-11.
const XP_PER_MONSTER_LEVEL = 0.2;

export class Progression {
  constructor() {
    this.stageIndex = 0;
    this.stageName = stageNameFor(0);
    this.difficulty = 1;
    this.state = 'idle'; // idle | charging | complete | portal

    this.charge = 0;
    this._lastEmitted = -1;
    this.bossAlive = false;
    this.bossCleared = false;
    this.lootTimer = 0;

    // Survivor level — read by the HUD through `ctx.player.level` and by
    // `Player._levelBase` for the stat curve. Run-scoped, so a stage change
    // deliberately leaves it alone.
    this.level = 1;
    this.xp = 0;
    this.xpToNext = xpForLevel(1);

    // Where this stage's teleporter is, or null before one exists. This is the
    // one field the objective HUD and VFX.teleporterAura both drive off, so it
    // has to be published the moment the stage is populated.
    this.teleporterPosition = null;

    this.interactables = new Interactables();
    // Meta-progression. Per-client and local in co-op — never synced, and
    // deliberately not gated on `ctx.authority`, or only the host would ever
    // earn an unlock. See Profile.js for the witness rules that replace it.
    this.profile = new Profile();
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
    // Before our own listeners: the profile's `playerDead` handler records the
    // outcome, and `_endRun` (registered below) is what commits it. Registering
    // in this order means the commit already sees the flag.
    this.profile.init(ctx);
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
      // XP is game state, so only the host awards it. Clients learn the result
      // from the `levelUp` event below, which NetHost already forwards.
      if (ctx.authority) this._awardKillXp(e);
    });

    // Client side of the same fact. The wire strips object references, so this
    // payload carries only the three numbers the HUD and the stat curve need.
    ctx.events.on('levelUp', (e) => {
      if (!ctx.authority && e) {
        this.level = e.level ?? this.level;
        this.xp = e.xp ?? 0;
        this.xpToNext = e.xpToNext ?? xpForLevel(this.level);
      }
      // Cosmetic, so both roles run it.
      if (ctx.player) ctx.vfx?.levelUp?.(ctx.player.position);
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
    // `ctx.difficulty` used to mirror this number. It is now the difficulty
    // *selection* API owned by `systems/Artifacts.js` (Drizzle/Rainstorm/
    // Monsoon), and this value keeps the one name it was ever read under —
    // `progression.difficulty`, which `_tickTeleporter` and `runStats` already
    // use. Its single external reader (`Items.killReward`, as a fallback behind
    // the director's coefficient) now reads the director directly.

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
    const tp = this.interactables.populate(index);
    // Publish before `stageStart` so anything that reacts to the new stage
    // already has an objective to point at.
    this.teleporterPosition = tp?.position?.clone() || null;
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
    this.stageName = fullStageName(index);
    this.state = 'idle';
    this.charge = 0;
    this._lastEmitted = -1;
    this.bossAlive = false;
    this.bossCleared = false;
    this.lootTimer = 0;
    // The old stage's teleporter is gone; the new one is published by
    // _beginStage once the stage is populated. A client leaves this null until
    // the host replicates the interactable.
    this.teleporterPosition = null;

    if (!first) {
      // Stage 0 is already standing (Stage.init built it); every subsequent
      // stage is a full regeneration. `build` takes no RNG on purpose — it is a
      // pure function of (ctx.seed, index), so host and client land on the same
      // world even though their gameplay streams have long since diverged.
      ctx.stage?.build?.(index);
      ctx.director?.reset?.(index);
    }

    // Reposition the player onto the freshly built ground before anything asks
    // for a spawn-relative point. Also derived from the seed, not from ctx.rng.
    const spawn = ctx.stage?.spawnPoint?.() || this._tmp.set(0, 2, 0);
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

  /**
   * Adopt the host's stage on joining a co-op game.
   *
   * Deliberately routed through the same `stageStart` event a mid-run stage
   * transition uses, rather than rebuilding directly: that event is also what
   * tells the Director to drop the enemies this client was simulating a moment
   * ago as a single-player host, and what resets the HUD. Marking the run as
   * started stops `fixedUpdate` from ever building stage 0 locally if authority
   * is later handed back.
   */
  syncStage(index) {
    this._started = true;
    this.ctx.events.emit('stageStart', { index, name: fullStageName(index) });
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

  // ----------------------------------------------------------------- levelling

  /**
   * Host-only. A monster is worth its card's `xp`, scaled by the level the
   * Director spawned it at (the same 0.2/level ramp its health and damage use)
   * and doubled for elites, so the reward tracks the effort.
   */
  _awardKillXp(e) {
    const v = e.victim;
    if (!v) return;
    const base = v.def?.xp ?? v.xp ?? 1;
    const lvl = Math.max(1, v.level || 1);
    let amount = base * (1 + XP_PER_MONSTER_LEVEL * (lvl - 1));
    if (e.isElite) amount *= 2;
    this.addExperience(amount);
  }

  /**
   * Host-only entry point. Announces every level gained as one `levelUp` event
   * carrying the whole state, which is what keeps a client's bar honest without
   * adding a snapshot field.
   */
  addExperience(amount) {
    if (!this.ctx.authority || !(amount > 0)) return;
    this.xp += amount;
    let levelled = false;
    // A boss can be worth several levels at once; drain the whole surplus.
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = xpForLevel(this.level);
      levelled = true;
    }
    if (levelled) {
      this.ctx.events.emit('levelUp', {
        level: this.level,
        xp: Math.round(this.xp),
        xpToNext: this.xpToNext,
      });
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
    const stats = this.runStats();
    // Commit to the persistent profile *before* the event, so anything that
    // renders off `runEnd` (the death screen, and B3's unlock toast) already
    // sees the committed record, the updated lifetime totals and any unlock the
    // final challenge pass just granted. `runEnd`'s payload is unchanged.
    this.profile.commitRun(won, stats);
    this.ctx.events.emit('runEnd', { won, stats });
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
