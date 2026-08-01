import * as THREE from 'three';
import { FINALE_PHASES } from '../../data/realms.js';
import { ENEMY_BY_ID } from '../../data/enemies.js';
import { raiseIslands } from './RealmArena.js';
import { pullToFloor } from './RealmStage.js';
import { lerp, clamp } from '../../core/MathUtil.js';

/**
 * The Fracture — the finale, and the only fight in the game where the arena is
 * a participant.
 *
 * The six teleporter bosses all escalate the same way: a phase break clears
 * their cooldowns and unlocks another row of the attack table. That is a fine
 * shape and this fight does it too, but it is not what makes it the last one.
 * What makes it the last one is that each break changes **what the player is
 * allowed to do**:
 *
 *  - **Phase 2** takes twelve metres of floor away — ground the player has
 *    spent the whole of phase 1 using — and *wards the boss completely* until
 *    three Rift Anchors are down. For that stretch the correct answer is not
 *    "shoot the boss", which is the only answer the other six ever have.
 *  - **Phase 3** cuts the floor again, to a disc barely wider than the boss's
 *    own nova, raises three islands as the only other ground, and suppresses
 *    healing for the rest of the fight. Every regen item in the inventory stops
 *    meaning anything at the exact moment the arena stops having room in it.
 *
 * The collapse is animated rather than snapped, because a floor that vanished
 * between frames would read as a bug; `COLLAPSE_TIME` is long enough to run
 * off, short enough to be frightening.
 */

const COLLAPSE_TIME = 2.2;
const VICTORY_HOLD = 6.0;     // beat between the last hit and the summary screen
const ANCHOR_HEALTH_FRAC = 0.10;

const _v = new THREE.Vector3();

export class FinaleController {
  constructor(realms, def) {
    this.realms = realms;
    this.def = def;
    this.boss = null;
    this.phase = 1;
    this.anchors = [];
    this.warded = false;
    this.islandsUp = false;
    this.targetRadius = def.floorRadius;
    this.collapseT = 0;
    this.fromRadius = def.floorRadius;
    this.victoryT = -1;
    this.done = false;
  }

  // -------------------------------------------------------------------------

  enter(ctx, stage) {
    if (!ctx.authority) return;
    const card = ENEMY_BY_ID.get('herald');
    if (!card) return;

    // Placed across the arena rather than on top of the player: the first thing
    // the finale has to do is let you look at it.
    const at = stage.origin.clone().add(_v.set(0, 0, -stage.floorRadius * 0.55).clone());
    const boss = ctx.director?.spawnOne?.(ctx, card, at, null);
    if (!boss) return;
    boss.isBoss = true;
    this.boss = boss;
    // Registered as *the* director boss so its death goes through the same
    // reaper and emits `bossDead` — the HUD bar, the boss item drop and the
    // profile's boss counter all hang off that one fact.
    ctx.director.boss = boss;
    ctx.events.emit('bossSpawn', { enemy: boss });
    // The HUD's boss sub-line is authored for the teleporter event. This is not
    // that, and the finale's own frame should not say it is.
    if (ctx.hud?.refs?.bossSub) ctx.hud.refs.bossSub.textContent = 'THE FRACTURE — FINAL';
    ctx.pipeline?.addShake?.(0.8);
    ctx.hud?.setObjective?.('Destroy the Herald');
  }

  // -------------------------------------------------------------------------

  fixedUpdate(ctx, h) {
    const stage = this.realms.active?.stage;
    if (!stage) return;
    this._animateCollapse(stage, h);
    if (!ctx.authority || this.done) return;

    // Phase 3's rule: nothing heals. Topped up every step rather than set once,
    // because the director's own lock is a deadline and any withering elite in
    // the run uses the same field.
    if (this.phase >= 3) ctx.director?.denyHealing?.(0.5);

    const boss = this.boss;
    if (boss && !boss.alive && this.victoryT < 0) {
      this.victoryT = VICTORY_HOLD;
      this._onKilled(ctx, stage);
    }
    if (this.victoryT >= 0) {
      this.victoryT -= h;
      if (this.victoryT <= 0) {
        this.done = true;
        this.realms.victory();
      }
      return;
    }
    if (!boss || !boss.alive) return;

    if (boss.phase !== this.phase) this._enterPhase(ctx, stage, boss.phase);
    if (this.warded) this._tickWard(ctx, stage, boss);

    // A boss that flew out over the void while the floor was shrinking has to
    // come back: the Herald hovers, so nothing else would ever bring it in.
    const r = Math.hypot(boss.position.x - stage.origin.x, boss.position.z - stage.origin.z);
    if (r > stage.floorRadius - 3) {
      const k = (stage.floorRadius - 3) / r;
      boss.position.x = stage.origin.x + (boss.position.x - stage.origin.x) * k;
      boss.position.z = stage.origin.z + (boss.position.z - stage.origin.z) * k;
    }
  }

  // -------------------------------------------------------------- phase break

  _enterPhase(ctx, stage, phase) {
    this.phase = phase;
    const spec = FINALE_PHASES[Math.min(phase, FINALE_PHASES.length) - 1];
    if (!spec) return;

    // The collapse. Announced hard — this is the fight's loudest moment and the
    // player has `COLLAPSE_TIME` to be somewhere that will still be there.
    if (spec.floorRadius < stage.floorRadius) {
      this.fromRadius = stage.floorRadius;
      this.targetRadius = spec.floorRadius;
      this.collapseT = COLLAPSE_TIME;
      ctx.pipeline?.addShake?.(0.9);
      ctx.audio?.play?.('explosion', stage.origin);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        _v.set(stage.origin.x + Math.cos(a) * stage.floorRadius, 0.5,
               stage.origin.z + Math.sin(a) * stage.floorRadius);
        ctx.vfx?.explosion?.(_v, 5, 0xd050ff);
      }
      ctx.director?.spawnWave?.(stage.origin, stage.floorRadius, 46, 0, null, 0xd050ff);
    }

    if (spec.anchors > 0) this._raiseAnchors(ctx, stage, spec.anchors);

    if (spec.platforms && !this.islandsUp) {
      this.islandsUp = true;
      raiseIslands(stage, {
        count: spec.platforms, radius: spec.platformRadius,
        dist: spec.platformDist, height: spec.platformHeight,
      });
    }

    if (!this.warded) {
      ctx.hud?.setObjective?.(phase >= 3 ? 'No quarter — end it' : 'Destroy the Herald');
    }
  }

  /**
   * Phase 2's gate.
   *
   * The anchors carry a fixed fraction of the Herald's own health rather than
   * their card's, so the gate is the same length of fight whether the finale is
   * reached at minute eighteen or at minute fifty. The `warded` affix is doing
   * two jobs: it repaints them violet so they read as pieces of the boss, and
   * its reflect makes standing in front of one while you break its barrier a
   * decision rather than a formality.
   */
  _raiseAnchors(ctx, stage, count) {
    const card = ENEMY_BY_ID.get('anchor');
    const sites = stage.anchorSites ?? [];
    const hp = Math.max(200, Math.round((this.boss?.maxHealth ?? 4000) * ANCHOR_HEALTH_FRAC));
    for (let i = 0; i < count; i++) {
      const at = sites[i % Math.max(1, sites.length)]?.clone()
        ?? stage.origin.clone().add(_v.set(Math.cos(i) * 16, 0, Math.sin(i) * 16).clone());
      const e = ctx.director?.spawnOne?.(ctx, card, at, 'warded');
      if (!e) continue;
      e.maxHealth = hp;
      e.health = hp;
      e.maxShield = hp * 0.35;
      e.shield = e.maxShield;
      this.anchors.push(e);
      ctx.vfx?.burst?.(at, 0xd050ff);
    }
    if (!this.anchors.length) return;

    this.warded = true;
    // Not `invuln`: a hit that reports nothing at all reads as a broken hitbox.
    // Absurd armour puts a visible `1` on the screen instead, which is the
    // universal "this is immune" read and keeps the hit feedback honest.
    this._savedArmor = this.boss.baseArmor;
    this.boss.baseArmor = 1e6;
    ctx.hud?.setObjective?.('The Herald is warded — destroy the three anchors');
    ctx.pipeline?.addShake?.(0.5);
  }

  _tickWard(ctx, stage, boss) {
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      if (!this.anchors[i].alive) this.anchors.splice(i, 1);
    }
    if (this.anchors.length) return;
    this.warded = false;
    boss.baseArmor = this._savedArmor ?? 0;
    // The ward breaking is the phase's payoff and has to be as loud as the
    // collapse that opened it.
    ctx.vfx?.explosion?.(boss.position, 12, 0xff4ad0);
    ctx.director?.spawnWave?.(boss.position, 26, 40, 0, null, 0xff4ad0);
    ctx.pipeline?.addShake?.(0.7);
    ctx.audio?.play?.('explosion', boss.position);
    ctx.hud?.setObjective?.('The ward is down — destroy the Herald');
  }

  // ------------------------------------------------------------- the collapse

  _animateCollapse(stage, h) {
    if (this.collapseT <= 0) return;
    this.collapseT = Math.max(0, this.collapseT - h);
    const k = 1 - clamp(this.collapseT / COLLAPSE_TIME, 0, 1);
    // Ease-in: the rim creeps for the first half-second and then goes, which is
    // what makes "get to the middle" the reaction rather than "walk inward".
    stage.setFloorRadius(lerp(this.fromRadius, this.targetRadius, k * k));
  }

  // ------------------------------------------------------------------ the end

  _onKilled(ctx, stage) {
    ctx.pipeline?.addShake?.(1.0);
    ctx.hitstop = 0.12;
    ctx.vfx?.explosion?.(this.boss.position, 18, 0xff4ad0);
    ctx.hud?.setObjective?.('The Herald falls');
    // Anything still standing goes with it — the run is over and a stray wisp
    // killing the player during the outro would flip a victory into a death.
    // Through Combat rather than by zeroing health, so each one plays its own
    // death and is reaped normally instead of standing there at 0 hp.
    const kill = { source: null, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'finale' };
    for (const e of (ctx.director?.enemies ?? []).slice()) {
      if (e !== this.boss && e.alive) ctx.combat?.applyDamage?.(e, e.health + e.shield + 1, kill);
    }
    // Put the player back on solid ground for the outro, whatever the last
    // exchange did to them.
    const p = ctx.player;
    if (p && p.alive && p.position.y < 0) pullToFloor(stage, p.position);
  }

  abort() { this.done = true; }

  exit(ctx) {
    ctx.hud?.clearBoss?.();
    if (ctx.director) ctx.director.boss = null;
  }
}
