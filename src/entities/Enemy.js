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
  groundAt, orbitPoint, turnToward, angleDelta, approachArc,
} from '../ai/Steering.js';
import { acquireRig, releaseRig, configureShadows, makeAnim } from './EnemyMeshes.js';
import { ELITE_STATS } from '../data/enemies.js';
import { clamp, damp, lerp } from '../core/MathUtil.js';

let NEXT_ID = 1;

const DEATH_TIME = 1.5;
const FLASH_TIME = 0.075;

// ---------------------------------------------------------------------------
// cross-system helpers — every call is guarded, the game must run with any
// subset of the other systems missing.
// ---------------------------------------------------------------------------

const _info = { source: null, position: new THREE.Vector3(), procCoefficient: 0, type: '' };

/** Route through Combat's one damage path; fall back only if it isn't up. */
function hurtPlayer(ctx, source, amount, type, at) {
  const p = ctx.player;
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
  const p = ctx.player;
  if (p && dist2D(p.position, point) < radius + (p.radius || 0.45)) {
    hurtPlayer(ctx, source, damage, 'blast', point);
  }
}

/** Elite on-hit riders, expressed as Combat's own status types. */
function statusPlayer(ctx, source, type, count = 1) {
  const c = ctx.combat;
  if (c && c.applyStatus && ctx.player) c.applyStatus(ctx.player, type, source, count);
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
    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.yaw = 0;
    this.damage = 10;
    this.moveSpeed = 5;
    this.level = 1;
    this.affix = null;
    this.elite = null;
    this.isElite = false;
    this.armor = 0;
    this.dying = false;
    this.shield = 0;
    this.maxShield = 0;
    this.shieldTimer = 0;
    this.isBoss = false;
    this.phase = 1;
    this.registered = false;
    this.despawned = true;
    this.diving = false;
    this._ctx = null;

    this.fsm = new StateMachine(this, STATES);
    this.anim = makeAnim();
    this.rig = null;

    this.cd = new Float32Array(4);
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
    this.alive = true;
    this.dying = false;
    this.despawned = false;
    this.radius = def.radius;
    this.height = def.height;
    this.isBoss = !!def.isBoss;
    this.phase = 1;
    this.level = opts.level || 1;
    this.affix = opts.affix || null;
    this.isElite = !!this.affix;   // read by Combat's kill payload and the HUD
    this.elite = em;

    this.maxHealth = Math.round(def.baseHealth * (opts.healthMult || 1) * (em ? em.health : 1));
    this.health = this.maxHealth;
    this.maxShield = em && em.shield ? this.maxHealth * em.shield : 0;
    this.shield = this.maxShield;
    this.shieldTimer = 0;
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
    // before the first commit. Two beetles out of the same pack therefore take
    // two different paths to the same player.
    this.melee = def.attacks[0].kind === 'melee';
    this.arcCurve = this.melee ? ctx.rng.range(0.45, 0.95) : 0;
    this.commitT = this.melee ? ctx.rng.range(0.35, 1.3) : 0;
    this.stallT = 0;
    this.noise = ctx.rng.range(0, 100);
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
    a.fallX = 1; a.fallZ = 0;

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
   * Combat.applyDamage has already handled armour, crit and the shield pool
   * before this runs, and it will call `onDeath()` itself once health hits
   * zero — so this only books the damage and the reaction. The self-kill at the
   * bottom is the fallback for when Combat isn't registered.
   */
  takeDamage(amount, info) {
    if (!this.alive) return 0;
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
    if (this.isBoss && this.phase === 1 && this.health <= this.maxHealth * (this.def.phase2At || 0.5)) {
      this.phase = 2;
      this.anim.phase = 2;
      if (this._ctx) {
        fx(this._ctx, 'explosion', this.position, 8, 0xffa514);
        this._ctx.pipeline?.addShake?.(0.35);
      }
    }
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
    // Overloading unit at range and never stand on a Glacial's corpse.
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

    const p = ctx.player;
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

    // Blazing units cook anything standing next to them.
    const em = this.elite;
    if (em && em.auraDps && this.alive) {
      this.auraT -= h;
      if (this.auraT <= 0) {
        this.auraT = 0.5;
        if (this.distToPlayer < em.auraRadius) {
          hurtPlayer(ctx, this, this.damage * em.auraDps, 'burn');
          statusPlayer(ctx, this, 'burn', 1);
        }
      }
    }

    this.fsm.update(ctx, h);
    this.applyMovement(ctx, h);
  }

  checkLOS(ctx) {
    const p = ctx.player;
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
   * neighbours push their own commit back, so five beetles strike as a
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

    if (st === S.IDLE || !ctx.player) {
      // Loose patrol around the spawn anchor so idle packs still drift.
      const t = ctx.time * 0.25 + this.noise;
      this._tmp.set(this.home.x + Math.cos(t) * 6, this.position.y, this.home.z + Math.sin(t * 0.8) * 6);
      return arrive(d, this, this._tmp, speed * 0.35, 4, 1);
    }

    // CHASE
    if (this.melee) {
      return approachArc(d, this, this.target, speed,
        Math.max(0.6, def.attackRange * 0.55), this.orbitSign, this.arcCurve, 2.5);
    }
    const melee = def.attacks[0].kind === 'dive';
    const stand = melee ? Math.max(0.6, def.attackRange * 0.55) : (def.preferredRange || def.attackRange * 0.6);
    arrive(d, this, this.target, speed, melee ? 2.5 : 6, stand);
    if (!melee && this.distToPlayer < stand * 0.65) {
      // Too close for a ranged unit — back off while still facing the player.
      seek(this._tmp, this, this.target, speed * 0.8);
      d.set(-this._tmp.x, 0, -this._tmp.z);
    }
    return d;
  }

  applyMovement(ctx, h) {
    const def = this.def;
    const d = this.steer(ctx, h);
    const st = this.fsm.state;
    const dying = st === S.DIE;

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

      // Pests jitter so a flight of them reads as a swarm, not a formation.
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

    const max = this.moveSpeed * 1.9;
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
        this.position.addScaledVector(this.velocity, h);
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
    if (combatFacing && ctx.player) {
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
    if (this.gcd > 0 || !ctx.player || !this.hasLOS) return -1;
    let best = -1;
    let bestW = 0;
    for (let i = 0; i < def.attacks.length; i++) {
      const a = def.attacks[i];
      if (this.cd[i] > 0) continue;
      if (this.distToPlayer > a.range) continue;
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

  /** Scale every attack phase — phase-2 titans wind up noticeably faster. */
  get timeScale() { return this.isBoss && this.phase === 2 ? 0.72 : 1; }

  fireAttack(ctx) {
    const a = this.atk;
    if (!a) return;
    const dir = _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    switch (a.kind) {
      case 'melee': {
        // Cone check in front of the unit at the strike frame.
        const p = ctx.player;
        if (p && this.distToPlayer < a.range + this.radius) {
          _v2.set(p.position.x - this.position.x, 0, p.position.z - this.position.z).normalize();
          if (_v2.dot(dir) > Math.cos(a.arc || 1)) {
            hurtPlayer(ctx, this, this.damage, 'melee');
            if (this.elite && this.elite.burn) statusPlayer(ctx, this, 'burn', 2);
            if (this.elite && this.elite.slow) statusPlayer(ctx, this, 'slow', 1);
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
      default: break;
    }
  }

  launchProjectile(ctx, a) {
    const pr = ctx.director && ctx.director.projectiles;
    if (!pr) return;
    _v1.set(this.position.x, this.position.y + (a.muzzleY || this.height * 0.7), this.position.z);
    _v1.x += Math.sin(this.yaw) * (a.muzzleZ || 0.5);
    _v1.z += Math.cos(this.yaw) * (a.muzzleZ || 0.5);
    _v2.copy(this.target);
    _v2.y += 1.0;
    // Lead the shot a little at range so slow projectiles aren't free to dodge.
    const flight = _v2.distanceTo(_v1) / a.speed;
    if (a.gravity) _v2.y += 0.5 * a.gravity * flight * flight;
    _v2.sub(_v1).normalize().multiplyScalar(a.speed);
    pr.fire(this, a, _v1, _v2);
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
    if (ctx.player) {
      _v3.copy(ctx.player.position);
      _v3.y += 1.0;
      const dy = _v3.y - origin.y;
      const dh = Math.hypot(_v3.x - origin.x, _v3.z - origin.z);
      dir.y = dh > 0.01 ? dy / dh : 0;
      dir.normalize();
    }
    let len = a.range;
    const hit = ctx.stage && ctx.stage.raycast ? ctx.stage.raycast(origin, dir, a.range) : null;
    if (hit) len = hit.distance;
    this.anim.beamLen = len;

    const p = ctx.player;
    if (p) {
      _v3.copy(p.position);
      _v3.y += 1.0;
      _v3.sub(origin);
      const t = clamp(_v3.dot(dir), 0, len);
      const px = origin.x + dir.x * t - (p.position.x);
      const py = origin.y + dir.y * t - (p.position.y + 1.0);
      const pz = origin.z + dir.z * t - (p.position.z);
      const r = radius + (p.radius || 0.45);
      if (px * px + py * py + pz * pz < r * r) hurtPlayer(ctx, this, damage, 'beam');
    }
    const dr = ctx.director;
    if (dr && dr.spawnBeamTrail) dr.spawnBeamTrail(origin, dir, len, a.color);
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
      // existed) paid no gold. Credited to the player, since the pest died
      // completing an attack on them.
      const combat = ctx.combat;
      if (combat?.applyDamage) {
        combat.applyDamage(this, this.health, { source: ctx.player, procCoefficient: 0 });
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

    if (ctx.player) {
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
      if (ctx.player && e.distToPlayer < 70) fsm.set(S.CHASE, ctx);
    },
  },

  [S.CHASE]: {
    update(e, ctx, h, fsm) {
      if (!ctx.player) { fsm.set(S.IDLE, ctx); return; }
      // Melee units don't get to walk straight from spawn into contact: once
      // inside the engage band they prowl until their commit timer runs out.
      if (e.melee && e.commitT > 0 && e.distToPlayer < e.engageRadius) {
        fsm.set(S.CIRCLE, ctx);
        return;
      }
      const i = e.pickAttack(ctx);
      if (i >= 0) { e.beginAttack(ctx, i); return; }
      // Ranged units that can't shoot yet go find a better angle instead of
      // standing still — this is what stops golem/wisp clusters looking inert.
      const def = e.def;
      const ranged = def.attacks[0].kind !== 'melee' && def.attacks[0].kind !== 'dive';
      if (ranged && fsm.t > 1.2 && (!e.hasLOS || e.distToPlayer < (def.preferredRange || 10) * 0.7)) {
        e.orbitSign = ctx.rng.next() < 0.5 ? -1 : 1;
        fsm.set(S.REPOSITION, ctx);
      }
    },
  },

  [S.CIRCLE]: {
    update(e, ctx, h, fsm) {
      if (!ctx.player) { fsm.set(S.IDLE, ctx); return; }
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

  [S.WINDUP]: {
    enter(e, ctx) {
      e.anim.windup = 0;
      e.anim.swing = 0;
      const a = e.atk;
      // Beams show their targeting line for the whole windup: that thin line
      // is the entire "get out of the way" signal.
      if (a && (a.kind === 'beam' || a.kind === 'barrage')) {
        e.anim.beamOn = true;
        e.anim.beamLen = Math.min(a.range, Math.max(4, e.distToPlayer));
      }
    },
    update(e, ctx, h, fsm) {
      const a = e.atk;
      if (!a) { fsm.set(S.CHASE, ctx); return; }
      const dur = a.windup * e.timeScale;
      e.anim.windup = clamp(fsm.t / dur, 0, 1);
      if (a.kind === 'beam' || a.kind === 'barrage') {
        e.anim.beamLen = lerp(e.anim.beamLen, Math.min(a.range, Math.max(4, e.distToPlayer)), 0.2);
      }
      if (fsm.t >= dur) fsm.set(S.ATTACK, ctx);
    },
    exit(e) { e.anim.windup = 0; },
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
      } else if (a.kind === 'dive') {
        const p = ctx.player;
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
      e.diving = false;
    },
    update() { /* the Director reaps once `finished` goes true */ },
  },
};
