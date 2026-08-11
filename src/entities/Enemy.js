// The monster entity.
//
// One class covers every archetype — the differences live in `src/data/enemies.js`
// and in the attack `kind` switch. Instances are pooled by the Director and
// re-`spawn()`ed, and every vector they need is allocated in the constructor,
// so a 60-strong horde does zero allocation in the steady state.
//
// Gameplay runs in fixedUpdate (60Hz). Animation runs in update, off the real
// frame delta, so the procedural rigs stay smooth on high-refresh displays.

import * as THREE from 'three';
import { S, StateMachine } from '../ai/StateMachine.js';
import {
  arrive, seek, separate, avoidObstacles, moveGrounded, moveFlying,
  groundAt, orbitPoint, turnToward, angleDelta, approachArc, keepRange, pursue,
} from '../ai/Steering.js';
import { acquireRig, releaseRig, configureShadows, makeAnim, BEAM_MAX_LEN } from './EnemyMeshes.js';
import { ELITE_STATS } from '../data/enemies.js';
import { ESTATE } from '../net/Protocol.js';
import { Roster, acquireTarget } from '../systems/Roster.js';
import { clamp, damp, lerp } from '../core/MathUtil.js';

let NEXT_ID = 1;

const DEATH_TIME = 1.5;
const FLASH_TIME = 0.075;

// ---------------------------------------------------------------------------
// cross-system helpers — every call is guarded, the game must run with any
// subset of the other systems missing.
// ---------------------------------------------------------------------------

const _info = { source: null, position: new THREE.Vector3(), procCoefficient: 0, type: '' };

/**
 * How often an enemy reconsiders its target, in seconds.
 *
 * Too long and an enemy keeps swinging at a player who has already run out of
 * the fight; too short and 60 units re-query every step for a decision that
 * changes a few times a minute. Staggered per unit so they never land together
 * — the same reason `losT` is staggered in `spawn`.
 */
const RETARGET_INTERVAL = 0.5;

/**
 * A unit's starting re-query timer: already expired, by a per-unit amount.
 *
 * Returns a value in `[-RETARGET_INTERVAL, 0)`. Expired, so the unit acquires a
 * target on its very first step and never idles waiting for a phase it does not
 * have yet. Expired *by a different amount per unit*, so that when the
 * scheduled path adds one interval to it the sixty resulting deadlines are
 * sixty different deadlines. Adding rather than assigning is what carries the
 * offset forward for the life of the unit; assigning a constant would flatten
 * every unit onto one phase on step one and keep them there.
 *
 * `spawn` draws `this.noise` from `ctx.rng.range(0, 100)` — a phase offset for
 * `Math.sin`, where only the spread ever mattered and the scale never did.
 * Dividing by that range is what turns it into a fraction of one interval;
 * multiplying it raw would put a unit's first re-query up to 50 seconds out.
 */
function retargetSeed(noise) {
  return (noise / 100 - 1) * RETARGET_INTERVAL;
}

/**
 * Route through Combat's one damage path; fall back only if it isn't up.
 *
 * The victim is passed rather than looked up. It used to read `ctx.player`,
 * which on a host is the host's own survivor — so every directed attack in a
 * co-op session landed on one person no matter who it was aimed at. Measured at
 * 78 directed hits on the host and 0 on a pawn standing 3 m away over 30 s.
 */
function hurtPlayer(ctx, victim, source, amount, type, at) {
  const p = victim;
  if (!p || p.alive === false) return;
  _info.source = source;
  _info.procCoefficient = 0;
  _info.type = type;
  if (at) _info.position.copy(at); else _info.position.copy(source.position);
  const c = ctx.combat;
  if (c && c.applyDamage) c.applyDamage(p, amount, _info);
  else if (p.takeDamage) p.takeDamage(amount, _info);
}

/** Sphere blast that respects teams, armour and i-frames. */
function explodeAt(ctx, source, point, radius, damage, status) {
  const c = ctx.combat;
  if (c && c.explode) {
    c.explode(point, radius, damage, source, { proc: 0, status: status || null, type: 'blast' });
    return;
  }
  // Fallback only — reached when Combat is not up. It has to sweep the roster
  // for the same reason `combat.explode` does: a blast is a place, not a
  // person, and everyone standing in it is in it.
  ctx.roster?.forEachTargetable?.((p) => {
    if (dist2D(p.position, point) < radius + (p.radius || 0.45)) {
      hurtPlayer(ctx, p, source, damage, 'blast', point);
    }
  });
}

/** Elite on-hit riders, expressed as Combat's own status types. */
function statusPlayer(ctx, victim, source, type, count = 1, overrides = null) {
  const c = ctx.combat;
  if (c && c.applyStatus && victim) c.applyStatus(victim, type, source, count, overrides);
}

/**
 * The per-tick damage an elite's own status does, as an override, or null.
 *
 * `STATUS_DEFS.burn` is 0.25 of the source's damage stat every 0.5 s, which is
 * the rate a *player's* burn does to a monster. Applied by a monster to the
 * survivor it is a different quantity entirely: one capped stack from a
 * 42-damage elite is 21 dps against a 110 HP pool, i.e. more than twice the
 * whole output of the same card without an affix. Before this override the
 * affix table could only choose between that and no fire at all, and both
 * measured answers were wrong (`reviews/round8/balance/`).
 *
 * `overrides.stackDamage` is a parameter `Combat.applyStatus` has always
 * accepted and that nothing in `src/` passed. The player DoT stack cap is
 * unaffected: it tests `def.stackDamage`, not the override, so an emberclad burn is
 * still capped at three stacks.
 */
function eliteStatusOverride(em) {
  return em && em.burnTick != null ? { stackDamage: em.burnTick } : null;
}

function fx(ctx, name, a, b, c) {
  const v = ctx.vfx;
  if (v && typeof v[name] === 'function') v[name](a, b, c);
}

function sfx(ctx, name, a, b) {
  const s = ctx.audio;
  if (s && typeof s[name] === 'function') s[name](a, b);
}

// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class Enemy {
  constructor() {
    // --- entity contract ---
    this.id = 0;
    this.isPlayer = false;
    this.team = 'monster';
    this.alive = false;
    this.health = 1;
    this.maxHealth = 1;
    this.position = new THREE.Vector3();
    this.radius = 0.5;
    this.height = 1.8;

    // --- runtime ---
    this.def = null;
    this.name = '';
    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.yaw = 0;
    this.damage = 10;
    this.moveSpeed = 5;
    this.level = 1;
    this.affix = null;
    this.elite = null;
    this.isElite = false;
    this.baseArmor = 0;
    this.dying = false;
    this.shield = 0;
    this.maxShield = 0;
    this.shieldTimer = 0;
    this.isBoss = false;
    this.phase = 1;
    this.phaseAt = null;
    this.registered = false;
    this.despawned = true;
    this.diving = false;
    this._ctx = null;

    // Movement personality — see `behavior` in data/enemies.js.
    this.behavior = 'melee';
    // Committed-dash bookkeeping. `chargeHit` is a one-shot latch so a 1.3 s
    // dash through the player deals its damage exactly once.
    this.charging = false;
    this.chargeHit = false;
    this.chargeT = 0;
    // Underground: no rig, no hitbox, and closing faster than it walks.
    this.submerged = false;
    this.invuln = false;
    this.moundT = 0;
    // The ally a support unit is currently tending.
    this.ally = null;

    this.fsm = new StateMachine(this, STATES);
    this.anim = makeAnim();
    this.rig = null;

    // One slot per attack. Six covers the widest boss table with room to grow;
    // a card with more attacks than this would silently share cooldowns.
    this.cd = new Float32Array(6);
    this.gcd = 0;
    this.atk = null;
    this.atkIndex = 0;
    this.atkDone = false;
    this.burstLeft = 0;
    this.burstT = 0;
    this.sweepDir = 1;
    this.tickT = 0;
    this.orbitSign = 1;
    this.melee = false;
    this.arcCurve = 0;
    this.commitT = 0;
    this.stallT = 0;
    this.noise = 0;
    this.hasLOS = true;
    this.losT = 0;
    this.avoidT = 0;
    this.flashT = 0;
    this.deathT = 0;
    this.hurtT = 0;
    this.auraT = 0;
    this.distToPlayer = 999;
    this.spawnT = 0;

    // Who this unit is fighting. Null until the first evaluation, which the
    // `!targetable(null)` clause in `fixedUpdate` forces on the very first step
    // regardless of the stagger below.
    this.targetPlayer = null;
    this.retargetT = 0;

    this.home = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._sep = new THREE.Vector3();
    this._avoid = new THREE.Vector3();
    this._orbit = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  spawn(ctx, def, at, opts) {
    const em = opts.affix ? ELITE_STATS[opts.affix] : null;
    this._ctx = ctx;
    this.diving = false;

    this.id = NEXT_ID++;
    this.def = def;
    // Display name, for the boss bar and any other UI that names a unit. The
    // HUD has no route to the spawn card, so the entity has to carry it.
    this.name = def.name || '';
    // What a client resolves back into a rig; see ENEMY_BY_TYPE.
    this.typeId = def.typeId || 0;
    this.alive = true;
    this.dying = false;
    this.despawned = false;
    this.radius = def.radius;
    this.height = def.height;
    this.isBoss = !!def.isBoss;
    this.phase = 1;
    // Health fractions at which the fight changes shape. `phase2At` is the
    // one-break shorthand the original two bosses were written against.
    this.phaseAt = def.phaseAt || (def.phase2At ? [def.phase2At] : null);
    this.baseArmor = def.armor || 0;
    this.behavior = def.behavior || defaultBehavior(def);
    this.charging = false;
    this.chargeHit = false;
    this.chargeT = 0;
    this.submerged = false;
    this.invuln = false;
    this.moundT = 0;
    this.ally = null;
    this.level = opts.level || 1;
    this.affix = opts.affix || null;
    this.isElite = !!this.affix;   // read by Combat's kill payload and the HUD
    this.elite = em;

    this.maxHealth = Math.round(def.baseHealth * (opts.healthMult || 1) * (em ? em.health : 1));
    this.health = this.maxHealth;
    this.maxShield = em && em.shield ? this.maxHealth * em.shield : 0;
    this.shield = this.maxShield;
    this.shieldTimer = 0;
    this._wardPopped = false;
    this.damage = def.baseDamage * (opts.damageMult || 1) * (em ? em.damage : 1);
    this.moveSpeed = def.moveSpeed * (em ? em.speed : 1);

    this.position.copy(at);
    this.home.copy(at);
    if (!def.isFlyer) this.position.y = groundAt(ctx, at.x, at.z);
    else this.position.y = groundAt(ctx, at.x, at.z) + def.hoverHeight;
    this.velocity.set(0, 0, 0);
    this.yaw = ctx.rng.range(-Math.PI, Math.PI);

    this.cd.fill(0);
    this.gcd = 0.4;
    this.atk = null;
    this.atkIndex = 0;
    this.flashT = 0;
    this.deathT = 0;
    this.hurtT = 0;
    this.auraT = 0;
    this.spawnT = 0;
    this.orbitSign = ctx.rng.next() < 0.5 ? -1 : 1;
    // Approach personality, rolled once per spawn: which way this unit swings
    // on the run-in, how hard, and how long it holds at the edge of reach
    // before the first commit. Two scarabs out of the same pack therefore take
    // two different paths to the same player.
    //
    // `melee` is the *prowl* flag, not "has a melee attack": a swarmer has one
    // and never prowls, because the whole point of a swarmer is that it does
    // not wait its turn.
    this.melee = this.behavior === 'melee';
    this.arcCurve = this.melee ? ctx.rng.range(0.45, 0.95) : 0;
    this.commitT = this.melee ? ctx.rng.range(0.35, 1.3) : 0;
    this.stallT = 0;
    this.noise = ctx.rng.range(0, 100);
    // Staggered by unit so sixty enemies never re-query on one step, the same
    // way `losT` is. Starts already expired — see `retargetSeed`.
    this.retargetT = retargetSeed(this.noise);
    this.targetPlayer = null;
    this.hasLOS = true;
    this.losT = ctx.rng.range(0, 0.13);
    this.avoidT = ctx.rng.range(0, 0.1);

    const a = this.anim;
    a.t = ctx.rng.range(0, 10);
    a.stride = ctx.rng.range(0, Math.PI * 2);
    a.speed = 0; a.windup = 0; a.swing = 0; a.attack = '';
    a.hurt = 0; a.death = 0; a.phase = 1; a.sweep = 0;
    a.pitch = 0; a.lookY = 0; a.lean = 0;
    a.beamOn = false; a.beamLen = 0; a.lod = 0;
    a.fallX = 1; a.fallZ = 0; a.charge = 0;

    this.rig = acquireRig(def.meshFactory);
    configureShadows(this.rig);
    this.rig.setAffix(this.affix);
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    ctx.scene.add(this.rig.root);

    this.fsm.reset(this, STATES);
    this.fsm.set(S.SPAWN, ctx);

    if (!this.registered && ctx.combat && ctx.combat.register) {
      ctx.combat.register(this);
      this.registered = true;
    }
    return this;
  }

  despawn(ctx) {
    if (this.despawned) return;
    this.despawned = true;
    this.alive = false;
    if (ctx.combat && ctx.combat.unregister) ctx.combat.unregister(this);
    this.registered = false;
    releaseRig(this.rig);
    this.rig = null;
    this.def = null;
  }

  // -------------------------------------------------------------------------
  // damage
  // -------------------------------------------------------------------------

  /**
   * Directional armour, read by `Combat.armorOf` at the instant of the hit.
   *
   * Expressing the shield as armour rather than as a subtraction inside
   * `takeDamage` is deliberate: it runs through RoR2's own diminishing curve,
   * it composes with the slow debuff's armour break, and — the reason it
   * matters — the damage number the player sees is the number that actually
   * landed. A warden shot in the face has to *read* as a warden shot in the
   * face, or nobody learns to walk around it.
   */
  get armor() {
    const def = this.def;
    let a = this.baseArmor;
    if (!def) return a;
    // The tower shield only exists in the phase that is holding it up.
    const gated = def.frontArmorPhase ? this.phase <= def.frontArmorPhase : true;
    if (def.frontArmor && gated && this.targetPlayer && this.facingPlayer(def.frontArc || 1.0)) {
      a += fracToArmor(def.frontArmor);
    }
    // A warded elite's barrier is armour while the barrier is still up, which
    // is what makes "break the shield first" the readable instruction.
    const em = this.elite;
    if (em && em.wardArmor && this.shield > 0) a += fracToArmor(em.wardArmor);
    return a;
  }

  /**
   * Is the player this unit is fighting inside `arc` radians of its facing?
   *
   * The unit's *own* target, not the local screen's player. Reading the global
   * here inverted the shield in co-op: a warden whose target is the guest turns
   * to face the guest, but the arc was measured against the host, so the
   * guest's point-blank frontal shot arrived unmitigated while the host merely
   * standing in the front arc applied the full reduction to the guest's shot
   * from behind.
   *
   * This narrows the defect rather than closing it. `Combat.armorOf(entity)`
   * takes no attacker, so directional armour is attacker-agnostic by
   * construction and a shield still cannot be right for two shooters at once;
   * the complete fix threads `info.source` through that signature. Until then
   * the arc at least agrees with the direction the unit is actually facing,
   * which is the rule the animation is already telling the player.
   */
  facingPlayer(arc) {
    const p = this.targetPlayer;
    if (!p) return false;
    const dx = p.position.x - this.position.x, dz = p.position.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return true;
    return (dx / d) * Math.sin(this.yaw) + (dz / d) * Math.cos(this.yaw) > Math.cos(arc);
  }

  /**
   * Combat.applyDamage has already handled armour, crit and the shield pool
   * before this runs, and it will call `onDeath()` itself once health hits
   * zero — so this only books the damage and the reaction. The self-kill at the
   * bottom is the fallback for when Combat isn't registered.
   */
  takeDamage(amount, info) {
    if (!this.alive || this.invuln) return 0;
    this.shieldTimer = 7;
    this.health -= amount;
    this.flashT = FLASH_TIME;
    if (info && info.position) this._lastHit = info;
    // Big hits stagger; chip damage never interrupts a committed attack.
    const heavy = amount > this.maxHealth * 0.12;
    this.hurtT = heavy ? 0.32 : 0.16;
    if (this._ctx) {
      const st = this.fsm.state;
      if (heavy && !this.isBoss && st !== S.DIE && st !== S.ATTACK) this.fsm.set(S.STAGGER, this._ctx);
    }
    // Phase breaks. Each one is announced with its own blast and shake — a
    // boss that changed its attack table silently would just feel like the
    // fight got unfair, rather than like it escalated.
    const gates = this.phaseAt;
    while (gates && this.phase <= gates.length && this.health <= this.maxHealth * gates[this.phase - 1]) {
      this.phase++;
      this.anim.phase = this.phase;
      // Every phase break clears the attack table's cooldowns, so the new
      // phase opens with the attack it unlocked instead of an idle beat.
      this.cd.fill(0);
      this.gcd = 0.5;
      if (this._ctx) {
        const c = this.def.attacks[this.def.attacks.length - 1]?.color || 0xffa514;
        fx(this._ctx, 'explosion', this.position, 6 + this.radius * 2, c);
        this._ctx.director?.spawnWave?.(this.position, 8 + this.radius * 3, 34, 0, null, c);
        sfx(this._ctx, 'explosion', this.position, 1);
        this._ctx.pipeline?.addShake?.(0.35);
      }
    }

    // A warded barrier that just broke pays for itself on the way out.
    const emw = this.elite;
    if (emw && emw.reflect && this.shield <= 0 && !this._wardPopped) {
      this._wardPopped = true;
      if (this._ctx) {
        spawnBlast(this._ctx, this, emw.novaRadius, this.damage * emw.novaDamage, 0xc9a8ff, null);
      }
    }
    // Reflect is NOT here, deliberately. Combat drains the shield pool before it
    // ever calls this, so while the barrier is up `takeDamage` is not reached at
    // all — a reflect hung off it fired only once the barrier was already gone,
    // which is precisely backwards. It lives on the `damage` event instead; see
    // Director's handler.
    // Only self-kill when nothing else owns the kill path; otherwise Combat
    // emits `kill` and calls onDeath() for us.
    if (this.health <= 0) {
      this.health = 0;
      if (!this.registered) this.onDeath();
    }
    return amount;
  }

  onDeath() {
    if (this.dying) return;
    this.dying = true;
    this.alive = false;
    const ctx = this._ctx;
    if (!ctx) return;

    // Fall away from whatever killed us.
    const a = this.anim;
    const info = this._lastHit;
    if (info && info.position) {
      _v1.subVectors(this.position, info.position);
      const yaw = this.yaw;
      const local = Math.atan2(_v1.x, _v1.z) - yaw;
      a.fallX = Math.cos(local) > 0 ? -1 : 1;
      a.fallZ = Math.sin(local) * 0.5;
    } else {
      a.fallX = 1; a.fallZ = 0;
    }
    this.rig?.beginDeath(ctx.rng);
    this.deathT = 0;
    this.velocity.multiplyScalar(0.2);
    this.fsm.set(S.DIE, ctx);

    // Elite death effects. These are the reason you learn to kill an
    // Galvanic unit at range and never stand on a Rimebound's corpse.
    const em = this.elite;
    if (em && em.deathBlast) {
      spawnBlast(ctx, this, em.blastRadius, this.damage * em.deathBlast, 0x74a6ff, 'shock');
    } else if (em && em.novaRadius) {
      spawnBlast(ctx, this, em.novaRadius, this.damage * em.novaDamage, 0x8fe4ff, 'slow');
    }
  }

  // -------------------------------------------------------------------------
  // gameplay
  // -------------------------------------------------------------------------

  fixedUpdate(ctx, h) {
    this._ctx = ctx;
    const def = this.def;
    if (!def) return;

    for (let i = 0; i < def.attacks.length; i++) if (this.cd[i] > 0) this.cd[i] -= h;
    if (this.gcd > 0) this.gcd -= h;
    if (this.hurtT > 0) this.hurtT -= h;
    if (this.flashT > 0) this.flashT -= h;

    if (this.shieldTimer > 0) {
      this.shieldTimer -= h;
    } else if (this.maxShield > 0 && this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + this.maxShield * 0.5 * h);
    }

    // Who this unit is fighting. Re-evaluated on a stagger rather than every
    // step: the answer changes a few times a minute, and 60 units re-querying
    // the roster every step would pay for that sixty times a frame. Dropped
    // immediately — not on the next tick — when the held target stops being
    // targetable, so an enemy never spends half a second swinging at a corpse.
    this.retargetT -= h;
    if (this.retargetT <= 0) {
      // Scheduled path. The only branch that touches the timer, and it *adds*
      // rather than assigns, so this unit's offset survives every reset — see
      // `retargetSeed`. It is also the only branch a unit with no target at all
      // ever takes, which is what stops a stage where everyone is dead from
      // asking the roster the same question sixty times a step forever.
      this.retargetT += RETARGET_INTERVAL;
      this.targetPlayer = acquireTarget(ctx.roster, this.position, this.targetPlayer);
    } else if (this.targetPlayer && !Roster.targetable(this.targetPlayer)) {
      // Forced path: the target this unit is holding died, went down or left
      // the roster. Re-acquire on this step rather than the next scheduled one,
      // so an enemy never spends half a second swinging at a corpse. The timer
      // is deliberately left alone; there is nothing to re-schedule, only
      // something to drop.
      this.targetPlayer = acquireTarget(ctx.roster, this.position, this.targetPlayer);
    }

    // Everything below this line — the FSM, the steering, the attack selection —
    // reads these three fields and nothing else. They were always per-enemy;
    // only the source they were filled from was wrong.
    const p = this.targetPlayer;
    if (p && p.position) {
      this.target.copy(p.position);
      this.distToPlayer = dist2D(this.position, p.position);
    } else {
      this.distToPlayer = 999;
    }

    // Line of sight is re-tested on a stagger so 60 units never raycast in the
    // same step.
    this.losT -= h;
    if (this.losT <= 0) {
      this.losT = 0.18;
      this.hasLOS = this.checkLOS(ctx);
    }

    // Emberclad units cook anything standing next to them.
    const em = this.elite;
    if (em && em.auraDps && this.alive) {
      this.auraT -= h;
      if (this.auraT <= 0) {
        this.auraT = 0.5;
        if (this.distToPlayer < em.auraRadius) {
          hurtPlayer(ctx, this.targetPlayer, this, this.damage * em.auraDps, 'burn');
          statusPlayer(ctx, this.targetPlayer, this, 'burn', 1, eliteStatusOverride(em));
        }
      }
    }

    // Withering: the tier-2 healing lock. Line of sight matters — breaking
    // contact is the counterplay, and without the LOS test the debuff would be
    // a flat "no healing on this stage" with nothing to do about it.
    if (em && em.denyRadius && this.alive && !this.submerged) {
      this.auraT -= h;
      if (this.auraT <= 0) {
        this.auraT = 0.4;
        if (this.distToPlayer < em.denyRadius && this.hasLOS) {
          ctx.director?.denyHealing?.(em.denyTime, this.targetPlayer);
          if (this.distToPlayer < em.auraRadius) {
            hurtPlayer(ctx, this.targetPlayer, this, this.damage * em.thornDps, 'wither');
          }
        }
      }
    }

    // Voidtouched: the void eats. A drain aura that feeds the unit what it
    // takes — the counterplay is range, and the cost of ignoring it compounds,
    // because every tick you stand in is a tick of your damage undone.
    if (em && em.siphonDps && this.alive && !this.submerged) {
      this.auraT -= h;
      if (this.auraT <= 0) {
        this.auraT = 0.5;
        if (this.distToPlayer < em.siphonRadius) {
          hurtPlayer(ctx, this.targetPlayer, this, this.damage * em.siphonDps, 'void');
          this.health = Math.min(this.maxHealth, this.health + this.maxHealth * em.siphonHeal);
        }
      }
    }

    this.fsm.update(ctx, h);
    this.applyMovement(ctx, h);
  }

  checkLOS(ctx) {
    const p = this.targetPlayer;
    if (!p || !ctx.stage || !ctx.stage.raycast) return true;
    _v1.copy(this.position);
    _v1.y += this.height * 0.75;
    _v2.copy(p.position);
    _v2.y += 1.2;
    _v3.subVectors(_v2, _v1);
    const d = _v3.length();
    if (d < 1.5) return true;
    _v3.multiplyScalar(1 / d);
    const hit = ctx.stage.raycast(_v1, _v3, d - 0.8);
    return !hit;
  }

  /** Radius a melee unit prowls at while waiting for its turn to commit. */
  get circleRadius() { return Math.max(1.6, this.def.attackRange * 1.15); }

  /** Distance at which a melee unit stops closing and starts prowling. */
  get engageRadius() { return Math.max(2.6, this.def.attackRange * 1.7); }

  /**
   * A pack must not all land at once. When one unit commits, its close
   * neighbours push their own commit back, so five scarabs strike as a
   * readable sequence the player can react to instead of one instant burst.
   */
  staggerPack(ctx) {
    const list = ctx.director ? ctx.director.enemies : null;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === this || !o.alive || !o.melee) continue;
      const st = o.fsm.state;
      if (st !== S.CHASE && st !== S.CIRCLE) continue;
      // Never extend a unit that has already been holding — otherwise a busy
      // pack can keep one member waiting forever.
      if (st === S.CIRCLE && o.fsm.t > 1.2) continue;
      const dx = o.position.x - this.position.x;
      const dz = o.position.z - this.position.z;
      if (dx * dx + dz * dz > 100) continue;
      const wait = ctx.rng.range(0.35, 0.85);
      if (wait > o.commitT) o.commitT = wait;
    }
  }

  /** Wish-velocity for the current state, before separation and avoidance. */
  steer(ctx, h) {
    const def = this.def;
    const d = this._desired;
    const st = this.fsm.state;
    const speed = this.moveSpeed * (this.isBoss && this.phase === 2 ? 1.25 : 1);

    if (st === S.DIE) return d.set(0, 0, 0);

    if (st === S.WINDUP || st === S.ATTACK || st === S.RECOVER || st === S.STAGGER || st === S.SPAWN) {
      // Committed: the only motion is whatever the attack itself drives.
      return d.set(0, 0, 0);
    }

    if (st === S.CHARGE) {
      // A charge is a *committed* line. The unit gets a token amount of
      // steering — enough that it doesn't dash into a boulder every time —
      // and nowhere near enough to track a player who sidestepped it. That gap
      // is the entire counterplay.
      const a = this.atk;
      const s = (a && a.chargeSpeed) || 20;
      return d.set(Math.sin(this.yaw) * s, 0, Math.cos(this.yaw) * s);
    }

    if (st === S.SUBMERGED) {
      // Underground it is faster than it is on the surface and it steers
      // perfectly, because nothing down there can be dodged — the dodge is the
      // one you make when it comes up.
      return seek(d, this, this.target, def.burrowSpeed || speed * 2);
    }

    if (st === S.TEND) {
      // Support units hold station on the ally they are mending and back away
      // from the player while they do it.
      const ally = this.ally;
      if (!ally || !ally.alive) return d.set(0, 0, 0);
      arrive(d, this, ally.position, speed, 3, Math.max(3, def.attackRange * 0.4));
      if (this.distToPlayer < (def.preferredRange || 20) * 0.5) {
        seek(this._tmp, this, this.target, speed * 0.9);
        d.x -= this._tmp.x; d.z -= this._tmp.z;
      }
      return d;
    }

    if (st === S.REPOSITION) {
      const want = def.preferredRange || def.attackRange * 0.6;
      orbitPoint(this._orbit, this, this.target, want, this.orbitSign, 0.75);
      return seek(d, this, this._orbit, speed * 0.85);
    }

    if (st === S.CIRCLE) {
      // Hold just outside reach and prowl. The player gets a beat to read the
      // threat, and a pack in this state occupies a ring rather than a point.
      orbitPoint(this._orbit, this, this.target, this.circleRadius, this.orbitSign, 0.55);
      return arrive(d, this, this._orbit, speed * 0.72, 2.0, 0);
    }

    if (st === S.IDLE || !this.targetPlayer) {
      // Loose patrol around the spawn anchor so idle packs still drift.
      const t = ctx.time * 0.25 + this.noise;
      this._tmp.set(this.home.x + Math.cos(t) * 6, this.position.y, this.home.z + Math.sin(t * 0.8) * 6);
      return arrive(d, this, this._tmp, speed * 0.35, 4, 1);
    }

    // CHASE — one branch per movement personality. This is where two units
    // that share an attack stop feeling like the same monster.
    switch (this.behavior) {
      case 'stationary':
        return d.set(0, 0, 0);

      case 'swarm':
        // Straight in, leading the player slightly, with none of the arc or
        // patience a prowler gets. A swarm is supposed to arrive all at once.
        return pursue(d, this, this.target, this.targetPlayer?.velocity, speed, 0.25);

      case 'charger': {
        // Closes to charge range and then holds — the dash is what it wants to
        // be doing, so walking into contact would waste the whole unit.
        const want = def.preferredRange || 12;
        if (this.distToPlayer > want) return seek(d, this, this.target, speed);
        return keepRange(d, this, this.target, speed * 0.8, want, 3.5, this.orbitSign);
      }

      case 'kiter':
        return keepRange(d, this, this.target, speed,
          def.preferredRange || def.attackRange * 0.6, 3, this.orbitSign);

      case 'support': {
        // Never chases the player; drifts toward the pack and stays behind it.
        const ally = this.ally;
        if (ally && ally.alive) return arrive(d, this, ally.position, speed, 4, 6);
        return keepRange(d, this, this.target, speed, def.preferredRange || 24, 5, this.orbitSign);
      }

      case 'diver':
        return arrive(d, this, this.target, speed, 2.5, Math.max(0.6, def.attackRange * 0.55));

      case 'melee':
        return approachArc(d, this, this.target, speed,
          Math.max(0.6, def.attackRange * 0.55), this.orbitSign, this.arcCurve, 2.5);

      default: {
        // 'ranged' — close to preferred range, then hold and shoot.
        const stand = def.preferredRange || def.attackRange * 0.6;
        arrive(d, this, this.target, speed, 6, stand);
        if (this.distToPlayer < stand * 0.65) {
          seek(this._tmp, this, this.target, speed * 0.8);
          d.set(-this._tmp.x, 0, -this._tmp.z);
        }
        return d;
      }
    }
  }

  applyMovement(ctx, h) {
    const def = this.def;
    const d = this.steer(ctx, h);
    const st = this.fsm.state;
    const dying = st === S.DIE;

    /*
     * `slow` and `freeze` reach a monster here. `Combat.speedMultiplier` had no
     * callers at all, so Frost Lattice, Hoarfrost Band, Concussion Charge,
     * Grapnel Tether's slow and the Aegis Emitter's dome all changed nothing
     * about how fast anything moved.
     *
     * It is applied to the *whole* desired velocity and to the clamp above it,
     * not to `steer`'s `speed` argument alone. Scaling only that would leave
     * separation, obstacle avoidance and the shrike jitter running at full pace —
     * so a frozen unit would still slide around the field under its neighbours,
     * which is the opposite of what a freeze reads as. The charge and the
     * burrow return before that point and are scaled where they integrate.
     *
     * A dying unit is not slowed: its ragdoll is presentation, and freezing a
     * corpse mid-topple looks like a hitch.
     */
    const slow = dying ? 1 : (ctx.combat?.speedMultiplier?.(this) ?? 1);

    // A dash and a burrow both own their own integration: neither wants
    // separation (a charge that gets nudged off its line stops being readable),
    // and the burrow is under the terrain the capsule solver would push it out
    // of. Both are also above the normal speed clamp by definition.
    if (st === S.CHARGE) {
      const a = this.atk;
      d.x *= slow; d.z *= slow;
      this.velocity.x = d.x; this.velocity.z = d.z;
      moveGrounded(this, ctx, d, h, 200);
      this.yaw = turnToward(this.yaw, this.yaw, 0, h);
      if (a) this.chargeContact(ctx, a, h);
      return;
    }
    if (st === S.SUBMERGED) {
      const s = (def.burrowSpeed || this.moveSpeed * 2) * slow;
      const len = Math.hypot(d.x, d.z) || 1;
      this.position.x += (d.x / len) * s * h;
      this.position.z += (d.z / len) * s * h;
      // Ride a fixed depth under the heightfield so the spoil mound tracks the
      // surface exactly, whatever the terrain does above it.
      this.position.y = groundAt(ctx, this.position.x, this.position.z) - this.height - 0.6;
      this.velocity.set(0, 0, 0);
      this.yaw = turnToward(this.yaw,
        Math.atan2(this.target.x - this.position.x, this.target.z - this.position.z), 8, h);
      return;
    }

    if (!dying) {
      const dList = ctx.director ? ctx.director.enemies : null;
      if (dList) {
        // Melee units closing in claim more room than idle ones, so the pack
        // spreads across a front instead of converging on a single point. The
        // wider ring is deliberately the gentler one — at full strength a
        // five-strong pack just mills against itself and never arrives.
        const wide = this.melee && (st === S.CHASE || st === S.CIRCLE);
        separate(this._sep, this, dList, this.moveSpeed * (wide ? 0.8 : 1.5),
          def.isFlyer ? 3.5 : 0, wide ? 2.0 : 1);
        d.x += this._sep.x;
        d.z += this._sep.z;
      }

      this.avoidT -= h;
      if (this.avoidT <= 0) {
        this.avoidT = 0.12;
        avoidObstacles(this._avoid, this, ctx, d, def.isFlyer ? 3 : 2.6, def.isFlyer ? 0 : this.height * 0.5);
      }
      // Weighted by how close the obstruction is. A distant feeler hit is a
      // gentle bias that bends the approach; only a wall the unit is about to
      // wear gets to out-vote the chase. A flat 1.4x did the latter always, so
      // anything that so much as clipped a rock stopped closing for good.
      const avoidSq = this._avoid.lengthSq();
      if (avoidSq > 1e-5) {
        const k = this.moveSpeed * (0.6 + 1.1 * clamp(Math.sqrt(avoidSq), 0, 1));
        d.x += this._avoid.x * k;
        d.z += this._avoid.z * k;
      }

      // Shrikes jitter so a flight of them reads as a swarm, not a formation.
      if (def.erratic) {
        const t = ctx.time * 3.1 + this.noise;
        d.x += Math.sin(t) * this.moveSpeed * 0.35;
        d.z += Math.cos(t * 1.37) * this.moveSpeed * 0.35;
      }
    }

    // Wedged on geometry: it wants to move and isn't. There is no navmesh here,
    // so the recovery is to try passing the obstruction on the other side —
    // which is also the direction its approach arc swings, so an unstick reads
    // as the unit choosing a new line rather than as a glitch.
    if (!dying && (st === S.CHASE || st === S.CIRCLE)) {
      const wants = d.x * d.x + d.z * d.z > 1;
      const moving = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z > 0.6;
      if (wants && !moving) {
        this.stallT += h;
        if (this.stallT > 1.0) { this.stallT = 0; this.orbitSign = -this.orbitSign; }
      } else {
        this.stallT = 0;
      }
    }

    // The status scale lands here, after every contribution to the desired
    // velocity and on the ceiling as well, so a slow taxes the whole mover and
    // a freeze is an actual stop rather than a slide under separation.
    d.x *= slow; d.z *= slow;
    const max = this.moveSpeed * 1.9 * slow;
    const sq = d.x * d.x + d.z * d.z;
    if (sq > max * max) {
      const k = max / Math.sqrt(sq);
      d.x *= k; d.z *= k;
    }

    if (def.isFlyer) {
      if (dying) {
        // Flyers drop out of the sky.
        this.velocity.y -= 26 * h;
        this.velocity.x *= Math.pow(0.2, h);
        this.velocity.z *= Math.pow(0.2, h);
        this.position.addScaledVector(this.velocity, h);
        const g = groundAt(ctx, this.position.x, this.position.z);
        if (this.position.y < g + 0.3) { this.position.y = g + 0.3; this.velocity.set(0, 0, 0); }
      } else if (this.diving) {
        // The dive integrates its own velocity rather than going through the
        // movers, so it has to pay the status tax here or it pays it nowhere:
        // without this the committed dive ignores `slow` *and* `freeze`
        // outright, and every defensive item that buys time against a diving
        // flyer buys none.
        this.position.addScaledVector(this.velocity, h * slow);
      } else {
        const hover = def.hoverHeight + Math.sin(ctx.time * 0.9 + this.noise) * 0.6;
        moveFlying(this, ctx, d, h, 16, hover);
      }
    } else {
      moveGrounded(this, ctx, d, h, dying ? 40 : 26);
    }

    // Facing: track the player while fighting, track motion while roaming.
    // A melee unit on the long run-in points along its own curving path, which
    // is what makes the arc legible; it snaps onto the player once it closes.
    const combatFacing = st === S.WINDUP || st === S.ATTACK || st === S.CIRCLE || st === S.REPOSITION
      || (st === S.CHASE && (!this.melee || this.distToPlayer < this.engageRadius * 1.6));
    let want = this.yaw;
    if (combatFacing && this.targetPlayer) {
      want = Math.atan2(this.target.x - this.position.x, this.target.z - this.position.z);
    } else if (this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z > 0.4) {
      want = Math.atan2(this.velocity.x, this.velocity.z);
    }
    let rate = this.def.turnRate;
    if (st === S.WINDUP) rate *= 0.45;           // committing means you can dodge it
    else if (st === S.ATTACK || st === S.RECOVER) rate *= 0.1;
    if (!dying) this.yaw = turnToward(this.yaw, want, rate, h);
  }

  // -------------------------------------------------------------------------
  // attack selection + execution
  // -------------------------------------------------------------------------

  pickAttack(ctx) {
    const def = this.def;
    if (this.gcd > 0 || !this.targetPlayer || !this.hasLOS) return -1;
    let best = -1;
    let bestW = 0;
    for (let i = 0; i < def.attacks.length; i++) {
      const a = def.attacks[i];
      if (this.cd[i] > 0) continue;
      // Phase-gated attacks are the whole reason a boss fight changes shape.
      if (a.phase && this.phase < a.phase) continue;
      if (a.kind === 'mend') {
        // A heal with nothing to heal is a wasted channel and reads as the unit
        // being broken. It only offers itself when a neighbour is actually hurt.
        if (!this.findAlly(ctx, a.range, true)) continue;
      } else if (this.distToPlayer > a.range) continue;
      if (a.minRange && this.distToPlayer < a.minRange) continue;
      const w = (a.weight || 1) * (0.5 + ctx.rng.next());
      if (w > bestW) { bestW = w; best = i; }
    }
    return best;
  }

  beginAttack(ctx, index) {
    const a = this.def.attacks[index];
    this.atk = a;
    this.atkIndex = index;
    this.atkDone = false;
    this.burstLeft = a.burst || 1;
    this.burstT = 0;
    this.tickT = 0;
    this.sweepDir = ctx.rng.next() < 0.5 ? -1 : 1;
    this.cd[index] = a.cooldown;
    this.anim.attack = a.id;
    if (this.melee) this.staggerPack(ctx);
    this.fsm.set(S.WINDUP, ctx);
  }

  /** Scale every attack phase — phase-2 colossuss wind up noticeably faster. */
  get timeScale() { return this.isBoss && this.phase === 2 ? 0.72 : 1; }

  fireAttack(ctx) {
    const a = this.atk;
    if (!a) return;
    const dir = _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    switch (a.kind) {
      case 'melee': {
        // Cone check in front of the unit at the strike frame.
        const p = this.targetPlayer;
        if (p && this.distToPlayer < a.range + this.radius) {
          _v2.set(p.position.x - this.position.x, 0, p.position.z - this.position.z).normalize();
          if (_v2.dot(dir) > Math.cos(a.arc || 1)) {
            hurtPlayer(ctx, p, this, this.damage, 'melee');
            // The affix's melee rider. `burn` is the gate and `burnTick` is the
            // rate, and they are deliberately independent: no shipping affix
            // sets `burn` today (emberclad's went to 0 — see `ELITE_STATS`), so
            // this arm is currently unreachable, and it carries the override so
            // that the next affix to switch it on gets the elite burn rate
            // rather than the 21-dps-per-stack player rate the last one did.
            if (this.elite && this.elite.burn) {
              statusPlayer(ctx, p, this, 'burn', 2, eliteStatusOverride(this.elite));
            }
            if (this.elite && this.elite.slow) statusPlayer(ctx, p, this, 'slow', 1);
            ctx.pipeline?.addShake?.(0.03);
          }
        }
        // Committed lunge — the follow-through moves the whole body.
        this.velocity.x += dir.x * (a.lunge || 0);
        this.velocity.z += dir.z * (a.lunge || 0);
        break;
      }
      case 'projectile': {
        this.launchProjectile(ctx, a);
        break;
      }
      case 'beam': {
        this.fireBeam(ctx, a, a.beamRadius, this.damage * a.damage);
        break;
      }
      case 'dive': {
        this.diving = true;
        _v2.subVectors(this.target, this.position);
        _v2.y += 0.8;
        _v2.normalize().multiplyScalar(a.diveSpeed);
        this.velocity.copy(_v2);
        break;
      }
      case 'slam':
      case 'stomp': {
        spawnWave(ctx, this, a);
        sfx(ctx, 'explosion', this.position, a.blast * 0.5);
        ctx.pipeline?.addShake?.(a.kind === 'slam' ? 0.5 : 0.3);
        fx(ctx, 'explosion', this.position, a.blast * 0.4, a.color);
        break;
      }
      case 'barrage': {
        this.anim.beamOn = true;
        break;
      }
      case 'nova': {
        // Radial, self-centred, undodgeable by aim — only by distance. The
        // telegraph ring went up during the windup, so the player has already
        // been told how far "away" is.
        spawnBlast(ctx, this, a.blast, this.damage * a.damage, a.color, a.status || null);
        ctx.director?.spawnWave?.(this.position, a.blast, a.waveSpeed || 24, 0, null, a.color);
        sfx(ctx, 'explosion', this.position, a.blast * 0.5);
        ctx.pipeline?.addShake?.(clamp(a.blast * 0.025, 0.1, 0.5));
        break;
      }
      case 'summon': {
        this.summonAdds(ctx, a);
        break;
      }
      case 'burrow': {
        // The eruption itself. The unit is already back on the surface (see
        // the SUBMERGED state) — this is the ground going up around it.
        this.eruptAt(ctx, a);
        break;
      }
      case 'mend': {
        this.mendAllies(ctx, a);
        break;
      }
      case 'pull': {
        // Nothing happens on the strike frame; the suction lives for the whole
        // active window and is applied per step in the ATTACK state.
        sfx(ctx, 'zap', this.position);
        break;
      }
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // attack implementations that need more than one line
  // -------------------------------------------------------------------------

  /** Contact test for a committed dash. Latched, so one dash lands one hit. */
  chargeContact(ctx, a, h) {
    const p = this.targetPlayer;
    if (!p || this.chargeHit) return;
    const r = (a.hitRadius || 1.2) + this.radius + (p.radius || 0.45);
    if (dist2D(this.position, p.position) > r) return;
    this.chargeHit = true;
    hurtPlayer(ctx, p, this, this.damage * a.damage, 'charge');
    if (a.knock && p.velocity) {
      // Shoved along the dash line, not away from a point: being run over
      // should move you the way the thing that hit you was going.
      p.velocity.x += Math.sin(this.yaw) * a.knock;
      p.velocity.z += Math.cos(this.yaw) * a.knock;
      p.velocity.y += a.knock * 0.35;
    }
    fx(ctx, 'explosion', p.position, 2.2, a.color);
    ctx.pipeline?.addShake?.(0.3);
    sfx(ctx, 'explosion', this.position, 0.6);
  }

  /** Surfacing blast: the ground goes up, then the unit comes with it. */
  eruptAt(ctx, a) {
    this.submerged = false;
    this.invuln = false;
    if (this.rig) this.rig.root.visible = true;
    this.position.y = groundAt(ctx, this.position.x, this.position.z);
    this.velocity.set(0, 9, 0);
    spawnBlast(ctx, this, a.blast, this.damage * a.damage, a.color, a.status || null);
    ctx.director?.spawnWave?.(this.position, a.blast, a.waveSpeed || 20, 0, null, a.color);
    sfx(ctx, 'explosion', this.position, a.blast * 0.6);
    ctx.pipeline?.addShake?.(0.4);
  }

  /** Hatch a brood. Host-only, and it respects the director's population cap. */
  summonAdds(ctx, a) {
    const dr = ctx.director;
    if (!dr || !dr.summon) return;
    const n = a.count || 3;
    for (let i = 0; i < n; i++) {
      const ang = ctx.rng.range(0, Math.PI * 2);
      const rad = ctx.rng.range(this.radius + 0.8, this.radius + (a.spread || 3));
      _v2.set(this.position.x + Math.cos(ang) * rad, this.position.y, this.position.z + Math.sin(ang) * rad);
      if (!dr.summon(ctx, a.summon, _v2, this)) break;   // cap reached
      fx(ctx, 'explosion', _v2, 1.4, a.color);
    }
    sfx(ctx, 'explosion', this.position, 0.7);
  }

  /** Top the pack back up. The reason a support unit is the first thing to shoot. */
  mendAllies(ctx, a) {
    const list = ctx.director ? ctx.director.enemies : null;
    if (!list) return;
    let n = 0;
    for (let i = 0; i < list.length && n < (a.targets || 3); i++) {
      const o = list[i];
      if (o === this || !o.alive || o.dying) continue;
      if (dist2D(this.position, o.position) > a.range) continue;
      if (o.health >= o.maxHealth && o.shield >= o.maxShield) continue;
      o.health = Math.min(o.maxHealth, o.health + o.maxHealth * (a.healFrac || 0.12));
      // A grafted barrier, not just health: it stacks on units that already
      // have one and it is what makes an un-answered acolyte feel like a wall.
      o.maxShield = Math.max(o.maxShield, o.maxHealth * (a.shieldFrac || 0.2));
      o.shield = o.maxShield;
      fx(ctx, 'explosion', o.position, 1.2, a.color);
      n++;
    }
    sfx(ctx, 'heal', this.position);
  }

  /** Per-step suction while a `pull` attack is live. */
  pullPlayer(ctx, a, h) {
    const p = this.targetPlayer;
    if (!p || !p.velocity) return;
    _v2.set(this.position.x - p.position.x, 0, this.position.z - p.position.z);
    const d = _v2.length();
    if (d < 1e-3 || d > a.range) return;
    // Falls off with distance, and never quite wins against a player running
    // flat out — it steals ground, it does not take control away.
    const k = (a.pull || 20) * (1 - clamp(d / a.range, 0, 1)) * h;
    p.velocity.x += (_v2.x / d) * k;
    p.velocity.z += (_v2.z / d) * k;
    if (d < (a.blast || 6)) {
      this.tickT -= h;
      if (this.tickT <= 0) {
        this.tickT = 0.4;
        hurtPlayer(ctx, p, this, this.damage * a.damage, 'pull');
      }
    }
  }

  /** Nearest living ally, optionally only ones that would benefit from a mend. */
  findAlly(ctx, range, hurtOnly) {
    const list = ctx.director ? ctx.director.enemies : null;
    if (!list) return null;
    let best = null;
    let bestD = range * range;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === this || !o.alive || o.dying || o.behavior === 'support') continue;
      if (hurtOnly && o.health >= o.maxHealth) continue;
      const dx = o.position.x - this.position.x, dz = o.position.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = o; }
    }
    return best;
  }

  launchProjectile(ctx, a) {
    const pr = ctx.director && ctx.director.projectiles;
    if (!pr) return;
    _v1.set(this.position.x, this.position.y + (a.muzzleY || this.height * 0.7), this.position.z);
    _v1.x += Math.sin(this.yaw) * (a.muzzleZ || 0.5);
    _v1.z += Math.cos(this.yaw) * (a.muzzleZ || 0.5);

    // Artillery walks its shells around the player rather than landing them all
    // on the same square metre. That is what makes the ground itself dangerous
    // instead of just the player's exact position.
    _v2.copy(this.target);
    _v2.y += 1.0;
    if (a.scatter) {
      const ang = ctx.rng.range(0, Math.PI * 2);
      const rad = ctx.rng.range(0, a.scatter);
      _v2.x += Math.cos(ang) * rad;
      _v2.z += Math.sin(ang) * rad;
      _v2.y = groundAt(ctx, _v2.x, _v2.z) + 1.0;
    }

    // Lead the shot a little at range so slow projectiles aren't free to dodge.
    const flight = _v2.distanceTo(_v1) / a.speed;
    if (a.gravity) _v2.y += 0.5 * a.gravity * flight * flight;

    // The ground ring goes down the instant the shell leaves the barrel and
    // lives exactly as long as the shell's flight, so "get off that circle" is
    // a real instruction with a real deadline.
    if (a.telegraph) {
      _v3.set(this.target.x + (_v2.x - this.target.x), 0, this.target.z + (_v2.z - this.target.z));
      ctx.director?.spawnTelegraph?.(_v3.x, _v3.z, a.telegraph, flight, a.color);
    }

    _v2.sub(_v1).normalize().multiplyScalar(a.speed);
    const n = a.volley || 1;
    if (n === 1) {
      pr.fire(this, a, _v1, _v2);
    } else {
      // A cone, not a stack: each round is rotated off the aim line so the
      // spread has a readable shape and the gaps between rounds are dodgeable.
      const spread = a.volleySpread || 0.3;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2;
        const ang = t * spread;
        const c = Math.cos(ang), s = Math.sin(ang);
        _v3.set(_v2.x * c - _v2.z * s, _v2.y, _v2.x * s + _v2.z * c);
        pr.fire(this, a, _v1, _v3);
      }
    }
    _v3.copy(_v2).normalize();
    fx(ctx, 'muzzleFlash', _v1, _v3, 0.7);
    sfx(ctx, 'shoot', _v1, 0.8);
  }

  /**
   * Hitscan beam along the current facing, clipped by the world. Damage lands
   * if the player's capsule is within `radius` of the segment.
   */
  fireBeam(ctx, a, radius, damage) {
    const origin = _v1.set(this.position.x, this.position.y + this.height * 0.82, this.position.z);
    const dir = _v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const aim = this.targetPlayer;
    if (aim) {
      _v3.copy(aim.position);
      _v3.y += 1.0;
      const dy = _v3.y - origin.y;
      const dh = Math.hypot(_v3.x - origin.x, _v3.z - origin.z);
      dir.y = dh > 0.01 ? dy / dh : 0;
      dir.normalize();
    }
    let len = a.range;
    const hit = ctx.stage && ctx.stage.raycast ? ctx.stage.raycast(origin, dir, a.range) : null;
    if (hit) len = hit.distance;
    this.anim.beamLen = Math.min(len, BEAM_MAX_LEN);

    // Aimed at one player, but it damages everyone it passes through. A
    // hitscan beam that goes straight through your teammate without touching
    // them is the kind of thing that reads as broken rather than as a rule.
    //
    // The segment is copied into scalars first, and no module scratch is read
    // inside the loop. `origin` is `_v1` and `dir` is `_v2`, and damaging one
    // victim can re-enter this file: `Combat.applyDamage` dispatches
    // `onDamaged`, Razor Wire and the thorns card retaliate synchronously, and
    // an enemy dying to that retaliation runs `onDeath`, which writes `_v1`.
    // With one victim the geometry was finished before any damage landed; with
    // several, holding the vectors across the call would test the next player
    // against a segment that is now the difference of two enemy positions.
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    ctx.roster?.forEachTargetable?.((p) => {
      const vx = p.position.x - ox, vy = (p.position.y + 1.0) - oy, vz = p.position.z - oz;
      const t = clamp(vx * dx + vy * dy + vz * dz, 0, len);
      const px = ox + dx * t - p.position.x;
      const py = oy + dy * t - (p.position.y + 1.0);
      const pz = oz + dz * t - p.position.z;
      const r = radius + (p.radius || 0.45);
      if (px * px + py * py + pz * pz < r * r) hurtPlayer(ctx, p, this, damage, 'beam');
    });
    // Restored from the snapshot for the same reason: the trail is drawn after
    // the damage, so `_v1`/`_v2` may no longer hold the beam.
    const dr = ctx.director;
    if (dr && dr.spawnBeamTrail) {
      dr.spawnBeamTrail(origin.set(ox, oy, oz), dir.set(dx, dy, dz), len, a.color);
    }
  }

  detonate(ctx) {
    const a = this.atk;
    this.diving = false;
    if (a) {
      spawnBlast(ctx, this, a.blast, this.damage * a.damage, a.color, null);
      sfx(ctx, 'explosion', this.position, a.blast * 0.6);
      ctx.pipeline?.addShake?.(0.22);
    }
    if (this.alive) {
      // Route the self-kill through Combat rather than calling onDeath directly.
      // Combat owns the kill path, and bypassing it meant a suiciding unit
      // emitted no `kill` event — so it never counted toward the run's kill
      // tally, never triggered on-kill item procs, and (once kill rewards
      // existed) paid no gold.
      const combat = ctx.combat;
      if (combat?.applyDamage) {
        // Credited to whoever it was attacking, not to `ctx.player` — on a host
        // that read as the host's own survivor whichever player the shrike
        // actually dived on. What the attribution buys is the `kill` event's
        // `source` and the `onKill` dispatch, which only fires for
        // `source?.isPlayer`: a guest's on-kill items now proc off the shrike
        // that killed itself on them. Not gold — `Items.rewardKill(victim)`
        // takes no source and pays the local inventory either way.
        // Health plus shield, and past armour — a suicide is a certainty, not
        // a hit to be mitigated. Sized to the health pool alone, an elite's
        // detonation was eaten by its own shield: a Warded Shrike (shield 1.1x
        // max health, ward armour while it holds) took nothing to health,
        // never armed the shield-regen delay, and dived again at full strength
        // every cooldown — an unkillable bomber that exploded on screen and
        // stayed.
        // The +1 is float hygiene: the shield pool is a product (1.1 * max
        // health) whose absorption can leave 1e-13 health behind, and the kill
        // gate is `health <= 0`. A point of overkill costs nothing.
        combat.applyDamage(this, this.health + (this.shield || 0) + 1, {
          source: this.targetPlayer, procCoefficient: 0, ignoreArmor: true,
        });
      } else {
        this.health = 0;
        this.onDeath(null);
      }
    }
  }

  // -------------------------------------------------------------------------
  // presentation
  // -------------------------------------------------------------------------

  update(ctx, dt) {
    const rig = this.rig;
    if (!rig) return;
    const a = this.anim;
    a.t += dt;

    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    const norm = clamp(planar / Math.max(0.5, this.moveSpeed), 0, 1.4);
    a.speed = damp(a.speed, norm, 0.995, dt);
    a.stride += dt * (1.6 + a.speed * (this.def ? 9 / Math.max(1, this.def.height) : 5));
    a.state = this.fsm.state;
    a.stateT = this.fsm.t;
    a.hurt = damp(a.hurt, this.hurtT > 0 ? 1 : 0, 0.999, dt);
    a.lean = clamp(-this.velocity.x * Math.cos(this.yaw) + this.velocity.z * Math.sin(this.yaw), -1, 1) * 0.3;

    if (this.targetPlayer) {
      const yawToTarget = Math.atan2(this.target.x - this.position.x, this.target.z - this.position.z);
      a.lookY = clamp(angleDelta(this.yaw, yawToTarget), -1.1, 1.1);
      const dy = (this.target.y + 1.2) - (this.position.y + this.height * 0.8);
      a.pitch = clamp(Math.atan2(dy, Math.max(1, this.distToPlayer)), -0.7, 0.7);
    }

    if (this.fsm.state === S.DIE) {
      this.deathT += dt;
      a.death = clamp(this.deathT / DEATH_TIME, 0, 1);
    } else {
      a.death = 0;
    }

    rig.setFlash(this.flashT > 0);

    // Distance LOD: skip the IK legwork once a unit is a silhouette anyway.
    const cam = ctx.camera;
    const d2 = cam ? cam.position.distanceToSquared(this.position) : 0;
    a.lod = d2 > 3200 ? 1 : 0;

    rig.root.position.copy(this.position);
    rig.root.rotation.y = this.yaw;
    // Terrain height under the unit, for the rig's contact shadow. One
    // heightfield sample per unit per frame; flyers need it most, since their
    // blob is the only thing that says how high they are hovering.
    a.ground = groundAt(ctx, this.position.x, this.position.z);

    // Spawn pop: scale in from nothing so units don't blink into existence.
    if (this.fsm.state === S.SPAWN) {
      const k = clamp(this.fsm.t / 0.45, 0, 1);
      rig.root.scale.setScalar(0.2 + 0.8 * (k * k * (3 - 2 * k)));
    } else if (a.death > 0.75) {
      const f = 1 - (a.death - 0.75) / 0.25;
      rig.root.scale.setScalar(clamp(f, 0, 1));
    } else {
      rig.root.scale.setScalar(1);
    }

    rig.animate(rig, a, dt);
  }

  get finished() { return this.fsm.state === S.DIE && this.deathT >= DEATH_TIME; }

  /**
   * Snapshot lifecycle flag. Dying units must keep appearing in snapshots until
   * they are reaped — NetHost drops anything that is neither alive nor flagged
   * DEAD, and a unit that simply vanished from the feed would pop out of
   * existence on every client instead of playing its death.
   */
  get netState() {
    if (this.fsm.state === S.DIE || !this.alive) return ESTATE.DEAD;
    if (this.fsm.state === S.SPAWN) return ESTATE.SPAWNING;
    return ESTATE.ALIVE;
  }
}

// ---------------------------------------------------------------------------
// effect spawners routed through the director (it owns the pools)
// ---------------------------------------------------------------------------

function spawnBlast(ctx, e, radius, damage, color, status) {
  explodeAt(ctx, e, e.position, radius, damage, status);
  ctx.director?.spawnWave?.(e.position, radius, 60, 0, null, color);
  fx(ctx, 'explosion', e.position, radius, color);
  ctx.pipeline?.addShake?.(clamp(radius * 0.02, 0.05, 0.4));
}

function spawnWave(ctx, e, a) {
  ctx.director?.spawnWave?.(e.position, a.blast, a.waveSpeed, e.damage * a.damage, e, a.color);
}

function dist2D(a, b) {
  if (!a || !b) return 999;
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

/**
 * Movement personality for a card that doesn't name one.
 *
 * Kept as a fallback rather than a requirement so the original five cards read
 * exactly as they did before `behavior` existed.
 */
function defaultBehavior(def) {
  // Same empty-`attacks` landmine as the REPOSITION test: this one fires once
  // per spawn rather than once per frame, but it throws just as hard.
  const k = def.attacks[0]?.kind;
  if (k === 'melee') return 'melee';
  if (k === 'dive') return 'diver';
  return 'ranged';
}

/**
 * Convert a "cut damage by this fraction" number into RoR2 armour.
 *
 * The armour curve is `100 / (100 + armor)`, so a 0.82 reduction is 455 armour.
 * Designers think in fractions; the combat maths wants armour.
 */
function fracToArmor(f) {
  const c = clamp(f, 0, 0.95);
  return 100 * c / (1 - c);
}

// ---------------------------------------------------------------------------
// the shared state table — one object, referenced by every enemy alive
// ---------------------------------------------------------------------------

const STATES = {
  [S.SPAWN]: {
    update(e, ctx, h, fsm) {
      if (fsm.t >= 0.45) fsm.set(S.CHASE, ctx);
    },
  },

  [S.IDLE]: {
    update(e, ctx, h, fsm) {
      if (e.targetPlayer && e.distToPlayer < 70) fsm.set(S.CHASE, ctx);
    },
  },

  [S.CHASE]: {
    update(e, ctx, h, fsm) {
      if (!e.targetPlayer) { fsm.set(S.IDLE, ctx); return; }
      // Support units live in their own loop: find someone to mend, go stand
      // near them, and only look at the player to decide how far to run away.
      if (e.behavior === 'support' && fsm.t > 0.4) {
        e.ally = e.findAlly(ctx, e.def.attackRange * 1.6, false);
        if (e.ally) { fsm.set(S.TEND, ctx); return; }
      }
      // Melee units don't get to walk straight from spawn into contact: once
      // inside the engage band they prowl until their commit timer runs out.
      if (e.melee && e.commitT > 0 && e.distToPlayer < e.engageRadius) {
        fsm.set(S.CIRCLE, ctx);
        return;
      }
      const i = e.pickAttack(ctx);
      if (i >= 0) { e.beginAttack(ctx, i); return; }
      // Ranged units that can't shoot yet go find a better angle instead of
      // standing still — this is what stops sentinel/mote clusters looking inert.
      const def = e.def;
      // `attacks` is empty for no shipping card, but a spawn card or a test
      // dummy written without one used to throw here *every frame* — thousands
      // of frame errors for a missing array element. A unit with nothing to
      // fire has no reason to reposition for a better angle, so an empty list
      // reads as "not ranged".
      const first = def.attacks[0];
      const ranged = !!first && first.kind !== 'melee' && first.kind !== 'dive';
      if (ranged && fsm.t > 1.2 && (!e.hasLOS || e.distToPlayer < (def.preferredRange || 10) * 0.7)) {
        e.orbitSign = ctx.rng.next() < 0.5 ? -1 : 1;
        fsm.set(S.REPOSITION, ctx);
      }
    },
  },

  [S.CIRCLE]: {
    update(e, ctx, h, fsm) {
      if (!e.targetPlayer) { fsm.set(S.IDLE, ctx); return; }
      e.commitT -= h;
      // The player broke away — go back to closing, and re-arm a short hold so
      // the next arrival is prowled rather than charged.
      if (e.distToPlayer > e.engageRadius * 1.9) {
        e.commitT = Math.max(e.commitT, ctx.rng.range(0.2, 0.7));
        fsm.set(S.CHASE, ctx);
        return;
      }
      // Patience cap: a unit prowls for at most this long before it goes in
      // regardless of what the rest of the pack is doing.
      if (e.commitT <= 0 || fsm.t > 2.4) {
        e.commitT = 0;
        fsm.set(S.CHASE, ctx);
      }
    },
  },

  [S.REPOSITION]: {
    update(e, ctx, h, fsm) {
      const i = e.hasLOS ? e.pickAttack(ctx) : -1;
      if (i >= 0) { e.beginAttack(ctx, i); return; }
      if (fsm.t > 1.6) fsm.set(S.CHASE, ctx);
    },
  },

  [S.TEND]: {
    update(e, ctx, h, fsm) {
      const i = e.pickAttack(ctx);
      if (i >= 0) { e.beginAttack(ctx, i); return; }
      const ally = e.ally;
      if (!ally || !ally.alive || fsm.t > 4) fsm.set(S.CHASE, ctx);
    },
  },

  [S.WINDUP]: {
    enter(e, ctx) {
      e.anim.windup = 0;
      e.anim.swing = 0;
      const a = e.atk;
      // Ground telegraph for anything that is about to make a hole in the
      // floor. The ring is placed and sized where the damage will be and lives
      // exactly as long as the wind-up, so the wind-up *is* the warning rather
      // than being a pose the player has to have learned.
      if (a && a.blast && (a.kind === 'nova' || a.kind === 'slam' || a.kind === 'stomp' || a.kind === 'pull')) {
        ctx.director?.spawnTelegraph?.(e.position.x, e.position.z, a.blast,
          a.windup * e.timeScale, a.color);
      }
      // Beams show their targeting line for the whole windup: that thin line
      // is the entire "get out of the way" signal.
      if (a && (a.kind === 'beam' || a.kind === 'barrage')) {
        e.anim.beamOn = true;
        // Drawn length only. The hitscan still runs to `a.range` (55 m for the
        // colossus); the quad stops at BEAM_MAX_LEN so a distant shooter fires a
        // bolt out of its own muzzle instead of ruling a wire across the frame.
        e.anim.beamLen = Math.min(a.range, Math.max(4, e.distToPlayer), BEAM_MAX_LEN);
      }
    },
    update(e, ctx, h, fsm) {
      const a = e.atk;
      if (!a) { fsm.set(S.CHASE, ctx); return; }
      const dur = a.windup * e.timeScale;
      e.anim.windup = clamp(fsm.t / dur, 0, 1);
      if (a.kind === 'beam' || a.kind === 'barrage') {
        e.anim.beamLen = lerp(e.anim.beamLen, Math.min(a.range, Math.max(4, e.distToPlayer), BEAM_MAX_LEN), 0.2);
      }
      // A dash and a burrow both leave the wind-up into a state of their own —
      // they have real travel between the tell and the hit, which is exactly
      // the window the player is being given.
      if (fsm.t >= dur) {
        if (a.kind === 'charge') fsm.set(S.CHARGE, ctx);
        else if (a.kind === 'burrow') fsm.set(S.SUBMERGED, ctx);
        else fsm.set(S.ATTACK, ctx);
      }
    },
    exit(e) { e.anim.windup = 0; },
  },

  [S.CHARGE]: {
    enter(e, ctx) {
      const a = e.atk;
      e.charging = true;
      e.chargeHit = false;
      e.anim.swing = 0.001;
      e.anim.charge = 1;
      const s = (a && a.chargeSpeed) || 20;
      e.velocity.set(Math.sin(e.yaw) * s, e.velocity.y, Math.cos(e.yaw) * s);
      // A blink dash removes the unit for the length of the dash: the rift
      // shell collapsing is the tell, and the arrival is supposed to be the
      // first time you see it again.
      if (a && a.blink && e.rig) {
        e.rig.root.visible = false;
        fx(ctx, 'explosion', e.position, 2.0, a.color);
      }
      sfx(ctx, 'shoot', e.position, 0.6);
    },
    update(e, ctx, h, fsm) {
      const a = e.atk;
      if (!a) { fsm.set(S.CHASE, ctx); return; }
      const dur = a.active * e.timeScale;
      e.anim.swing = clamp(fsm.t / (dur + a.recover * e.timeScale), 0.001, 1);
      // Stopped dead against terrain: the dash is spent, and following through
      // with the animation while pinned against a rock reads as broken.
      const speed2 = e.velocity.x * e.velocity.x + e.velocity.z * e.velocity.z;
      const stalled = fsm.t > 0.15 && speed2 < 4;
      if (fsm.t >= dur || stalled || (e.chargeHit && a.blink)) fsm.set(S.RECOVER, ctx);
    },
    exit(e, ctx) {
      e.charging = false;
      e.anim.charge = 0;
      const a = e.atk;
      if (a && a.blink && e.rig) {
        e.rig.root.visible = true;
        fx(ctx, 'explosion', e.position, 2.4, a.color);
      }
      // Bleed the dash off rather than stopping on a dime — the overshoot is
      // the follow-through, and it is also the window to punish the miss.
      e.velocity.x *= 0.35;
      e.velocity.z *= 0.35;
    },
  },

  [S.SUBMERGED]: {
    enter(e, ctx) {
      e.submerged = true;
      e.invuln = true;
      e.moundT = 0;
      if (e.rig) e.rig.root.visible = false;
      fx(ctx, 'explosion', e.position, 2.6, e.atk?.color || 0xd8a860);
      sfx(ctx, 'explosion', e.position, 0.4);
    },
    update(e, ctx, h, fsm) {
      const a = e.atk;
      if (!a) { fsm.set(S.CHASE, ctx); return; }
      const dur = (a.submerge || 2.0) * e.timeScale;
      // Spoil mound: a small ring dragged along behind it, which is the only
      // thing the player can read while it is under. Without this the unit is
      // an invisible timer, which is not a mechanic, it is a coin flip.
      e.moundT -= h;
      if (e.moundT <= 0) {
        e.moundT = 0.1;
        ctx.director?.spawnTelegraph?.(e.position.x, e.position.z, e.radius * 1.6, 0.45, a.color);
      }
      const close = e.distToPlayer < 2.5;
      if (fsm.t >= dur || close) {
        // Surfacing ring, sized to the blast, so the last beat before the hit
        // is spent looking at exactly how far "clear" is.
        ctx.director?.spawnTelegraph?.(e.position.x, e.position.z, a.blast, 0.32, a.color);
        fsm.set(S.ATTACK, ctx);
      }
    },
    exit(e) {
      e.submerged = false;
      e.invuln = false;
      if (e.rig) e.rig.root.visible = true;
    },
  },

  [S.ATTACK]: {
    enter(e, ctx) {
      e.anim.swing = 0.001;
      e.fireAttack(ctx);
      const at = e.atk;
      if (at && (at.kind === 'beam' || at.kind === 'barrage')) sfx(ctx, 'zap', e.position);
    },
    update(e, ctx, h, fsm) {
      const a = e.atk;
      if (!a) { fsm.set(S.CHASE, ctx); return; }
      let dur = a.active * e.timeScale;
      if (a.burst && a.burst > 1) dur = Math.max(dur, (a.burst - 1) * a.burstGap + 0.06);
      e.anim.swing = clamp(fsm.t / (dur + a.recover * e.timeScale), 0.001, 1);

      if (a.kind === 'projectile' && a.burst > 1) {
        e.burstT -= h;
        if (e.burstT <= 0 && e.burstLeft > 1) {
          e.burstLeft--;
          e.burstT = a.burstGap;
          e.launchProjectile(ctx, a);
        }
      } else if (a.kind === 'beam') {
        // Continuous damage for the short active window.
        e.tickT -= h;
        if (e.tickT <= 0) {
          e.tickT = 0.1;
          e.fireBeam(ctx, a, a.beamRadius, e.damage * a.damage * 0.35);
        }
      } else if (a.kind === 'barrage') {
        // Sweeping laser: the yaw rotates through the arc, so the safe spot
        // moves and the player has to keep moving with it.
        const k = clamp(fsm.t / dur, 0, 1);
        e.anim.sweep = Math.sin(k * Math.PI * 2) * a.sweep * e.sweepDir;
        e.yaw += e.sweepDir * a.sweep * (Math.cos(k * Math.PI * 2) * Math.PI * 2 / dur) * h;
        e.tickT -= h;
        if (e.tickT <= 0) {
          e.tickT = a.tick;
          e.fireBeam(ctx, a, a.beamRadius, e.damage * a.damage);
        }
      } else if (a.kind === 'pull') {
        // The suction is the attack. It runs every step of the active window
        // and the damage only starts once you have actually been dragged in.
        e.pullPlayer(ctx, a, h);
        e.anim.beamOn = true;
        e.anim.beamLen = Math.min(a.range, Math.max(4, e.distToPlayer));
      } else if (a.kind === 'dive') {
        const p = e.targetPlayer;
        const near = p ? e.position.distanceTo(p.position) : 99;
        if (near < 2.2 || e.grounded || e.position.y < groundAt(ctx, e.position.x, e.position.z) + 0.9) {
          e.detonate(ctx);
          return;
        }
      }

      if (fsm.t >= dur) fsm.set(S.RECOVER, ctx);
    },
    exit(e) {
      e.anim.beamOn = false;
      e.anim.sweep = 0;
      e.diving = false;
      if (e.atk && e.atk.kind === 'dive' && e.alive) e.detonate(e._ctx);
    },
  },

  [S.RECOVER]: {
    update(e, ctx, h, fsm) {
      const a = e.atk;
      const dur = (a ? a.recover : 0.3) * e.timeScale;
      if (a) {
        const active = a.active * e.timeScale;
        e.anim.swing = clamp((active + fsm.t) / (active + dur), 0, 1);
      }
      if (fsm.t >= dur) {
        e.gcd = 0.25;
        e.anim.swing = 0;
        e.anim.attack = '';
        // Re-arm the prowl so a melee unit backs off and circles between
        // swings rather than grinding against the player.
        if (e.melee) e.commitT = ctx.rng.range(0.3, 1.0);
        fsm.set(S.CHASE, ctx);
      }
    },
  },

  [S.STAGGER]: {
    enter(e) { e.anim.swing = 0; e.anim.windup = 0; e.anim.beamOn = false; },
    update(e, ctx, h, fsm) {
      if (fsm.t >= 0.28) fsm.set(S.CHASE, ctx);
    },
  },

  [S.DIE]: {
    enter(e, ctx) {
      e.anim.beamOn = false;
      e.anim.windup = 0;
      e.anim.swing = 0;
      e.anim.charge = 0;
      e.diving = false;
      // A unit killed mid-blink or mid-burrow must not die invisible or
      // underground — both states hide the rig, and a corpse the player cannot
      // see is a kill the player does not get credit for having made.
      e.charging = false;
      e.submerged = false;
      e.invuln = false;
      if (e.rig) {
        e.rig.root.visible = true;
        if (e.position.y < groundAt(ctx, e.position.x, e.position.z)) {
          e.position.y = groundAt(ctx, e.position.x, e.position.z);
        }
      }
    },
    update() { /* the Director reaps once `finished` goes true */ },
  },
};
