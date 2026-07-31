// The combat director — Risk of Rain 2's pressure curve, faithfully.
//
// Three numbers drive the entire game's escalation:
//
//   difficultyCoefficient = (playerFactor + timeFactor) * stageFactor
//     playerFactor = 0.7 + 0.3 * playerCount            (1.0 solo)
//     timeFactor   = minutes * 0.0506 * playerCount^0.2 * DIFFICULTY_SCALE
//     stageFactor  = 1.15 ^ stagesCompleted             (compounds per stage)
//
//   monster level  = 1 + floor((difficulty - playerFactor) / 0.33)
//     health x (1 + 0.30 * (level - 1)),  damage x (1 + 0.20 * (level - 1))
//
//   credits/second = 0.75 * difficulty * (1 + 0.4 * (playerCount - 1)) * modeMult
//
// The director banks credits, re-rolls a monster card on an interval, and
// spends the bank on the most expensive card it can afford — so early waves are
// beetles and, twenty minutes in, the same bank buys golems by the pair.
//
// It also owns the enemy pool and every enemy-side effect pool (projectiles,
// shockwaves, beam trails) so nothing allocates once the fight is running.

import * as THREE from 'three';
import { Enemy } from '../entities/Enemy.js';
import {
  SPAWN_CARDS, BOSS_CARDS, TIER_UNLOCK, ELITE_AFFIXES, ELITE_STATS,
} from '../data/enemies.js';
import { prewarm, makeProjectile, makeShockwave } from '../entities/EnemyMeshes.js';
import { clamp, lerp } from '../core/MathUtil.js';

const DIFFICULTY_SCALE = 2.0;   // Rainstorm
const CREDIT_BASE = 0.95;
const CREDIT_SEED = 10;         // opening bank, so first contact lands in the first ~15s
const HARD_POP_CAP = 64;
const MIN_SPAWN_DIST = 34;      // far enough that the run-in is audible and visible
const MAX_SPAWN_DIST = 90;
const FAR_SPAWN_DIST = 52;      // beyond this, an on-screen spawn reads as "distant", not "popped in"
const EDGE_SPAWN_CHANCE = 0.3;
const BOSS_SPAWN_DIST = 22;   // just outside the teleporter's charge radius

const DIFFICULTY_NAMES = [
  [0.0, 'Easy'],
  [1.4, 'Medium'],
  [2.2, 'Hard'],
  [3.2, 'Very Hard'],
  [4.5, 'Insane'],
  [6.0, 'Impossible'],
  [8.0, 'I SEE YOU'],
  [10.5, "I'M COMING FOR YOU"],
  [13.5, 'HAHAHAHA'],
];

/** Enemy-side damage always goes through Combat's single path when it exists. */
function damagePlayer(ctx, target, amount, source, position, type) {
  const info = { source, position, procCoefficient: 0, type };
  const c = ctx.combat;
  if (c && c.applyDamage) c.applyDamage(target, amount, info);
  else if (target.takeDamage) target.takeDamage(amount, info);
}

const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export class Director {
  constructor() {
    this.enemies = [];
    this.pool = new Map();

    this.difficultyCoefficient = 1;
    this.difficultyName = 'Easy';
    this.difficultyIndex = 0;
    this.level = 1;
    this.playerCount = 1;
    this.stagesCompleted = 0;

    this.credits = CREDIT_SEED;
    this.creditRate = 0;
    this.card = null;
    this.rerollT = 0;
    this.spawnT = 2.0;
    this.eventActive = false;
    this.boss = null;
    this.enabled = true;

    this.projectiles = new Projectiles();
    this.waves = new Waves();
    this.trails = new Trails();

    this._frustum = new THREE.Frustum();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 7);
    this._point = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
  }

  init(ctx) {
    ctx.director = this;
    this.ctx = ctx;

    // Warm the mesh pools so the first contact doesn't hitch on geometry work.
    prewarm('beetle', 12);
    prewarm('lemurian', 8);
    prewarm('wisp', 5);
    prewarm('pest', 5);
    prewarm('golem', 3);

    this.projectiles.init(ctx);
    this.waves.init(ctx);
    this.trails.init(ctx);

    ctx.events.on('teleporterCharging', () => {
      if (!this.eventActive) this.beginTeleporterEvent(ctx);
    });
    ctx.events.on('teleporterComplete', () => this.endTeleporterEvent(ctx));
    ctx.events.on('stageStart', (p) => {
      this.stagesCompleted = p && typeof p.index === 'number' ? p.index : this.stagesCompleted + 1;
      this.credits = CREDIT_SEED;
      this.eventActive = false;
      this.boss = null;
      this.clear(ctx);
    });
    ctx.events.on('playerDead', () => { this.enabled = false; });

    this.updateDifficulty(ctx);
    this.card = SPAWN_CARDS[0];
  }

  // -------------------------------------------------------------------------
  // difficulty
  // -------------------------------------------------------------------------

  get playerFactor() { return 0.7 + 0.3 * this.playerCount; }

  updateDifficulty(ctx) {
    const pf = this.playerFactor;
    const timeFactor = (ctx.time / 60) * 0.0506 * Math.pow(this.playerCount, 0.2) * DIFFICULTY_SCALE;
    const stageFactor = Math.pow(1.15, this.stagesCompleted);
    this.difficultyCoefficient = (pf + timeFactor) * stageFactor;

    this.level = 1 + Math.floor(Math.max(0, this.difficultyCoefficient - pf) / 0.33);
    this.healthMult = 1 + 0.30 * (this.level - 1);
    this.damageMult = 1 + 0.20 * (this.level - 1);

    let idx = 0;
    for (let i = 0; i < DIFFICULTY_NAMES.length; i++) {
      if (this.difficultyCoefficient >= DIFFICULTY_NAMES[i][0]) idx = i;
    }
    this.difficultyIndex = idx;
    this.difficultyName = DIFFICULTY_NAMES[idx][1];
  }

  get populationCap() {
    const base = 12 + this.difficultyCoefficient * 6;
    return Math.min(HARD_POP_CAP, Math.round(base * (this.eventActive ? 1.5 : 1)));
  }

  /** Alias used by tools/spawnprobe.mjs. */
  get popCap() { return this.populationCap; }

  get eliteChance() {
    if (this.difficultyCoefficient < 1.25) return 0;
    return clamp(0.02 + (this.difficultyCoefficient - 1.25) * 0.05, 0, 0.38) * (this.eventActive ? 1.35 : 1);
  }

  /**
   * Seconds between spend attempts — tightens as the run heats up.
   *
   * Short on purpose: the bank is spent on whatever it can afford (see
   * `spendCredits`), so a frequent, small spend is what produces a continuous
   * trickle early instead of a 30-second lull followed by a six-beetle dump.
   */
  get spawnInterval() {
    const base = lerp(2.6, 1.0, clamp((this.difficultyCoefficient - 1) / 6, 0, 1));
    return this.eventActive ? base * 0.5 : base;
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  fixedUpdate(ctx, h) {
    // The director is the host's alone — spawning, credits and the difficulty
    // curve all feed off the shared gameplay RNG. A client's enemies arrive as
    // snapshot views and never live in `this.enemies`.
    if (!ctx.authority) return;

    this.updateDifficulty(ctx);

    const list = this.enemies;
    for (let i = 0; i < list.length; i++) list[i].fixedUpdate(ctx, h);

    // Reap finished corpses back into the pool.
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.finished) continue;
      if (e === this.boss) {
        this.boss = null;
        ctx.events.emit('bossDead', { enemy: e });
      }
      const id = e.def ? e.def.id : null;
      e.despawn(ctx);
      list.splice(i, 1);
      if (id) {
        const p = this.pool.get(id);
        if (p) p.push(e); else this.pool.set(id, [e]);
      }
    }

    this.projectiles.fixedUpdate(ctx, h);
    this.waves.fixedUpdate(ctx, h);

    if (!this.enabled || !ctx.player) return;

    this.creditRate = CREDIT_BASE * this.difficultyCoefficient
      * (1 + 0.4 * (this.playerCount - 1)) * (this.eventActive ? 2.4 : 1);
    this.credits += this.creditRate * h;

    this.rerollT -= h;
    if (this.rerollT <= 0) {
      this.rerollT = this.eventActive ? 4 : 8;
      this.card = this.rollCard(ctx);
    }

    this.spawnT -= h;
    if (this.spawnT <= 0) {
      this.spawnT = this.spawnInterval;
      this.spendCredits(ctx);
    }
  }

  update(ctx, dt) {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) list[i].update(ctx, dt);
    this.projectiles.update(ctx, dt);
    this.waves.update(ctx, dt);
    this.trails.update(ctx, dt);
  }

  // -------------------------------------------------------------------------
  // spawn selection
  // -------------------------------------------------------------------------

  /**
   * Re-roll the wave's monster. Biased hard toward the most expensive card the
   * bank can currently afford, with a small chance of something cheaper so
   * waves aren't monotone.
   */
  rollCard(ctx) {
    const d = this.difficultyCoefficient;
    let best = null;
    const affordable = [];
    for (const c of SPAWN_CARDS) {
      if (d < (TIER_UNLOCK[c.tier] || 0)) continue;
      if (c.cost > this.credits) continue;
      affordable.push(c);
      if (!best || c.cost > best.cost) best = c;
    }
    if (!affordable.length) {
      // Nothing affordable yet: keep saving toward the cheapest unlocked card.
      let cheap = SPAWN_CARDS[0];
      for (const c of SPAWN_CARDS) {
        if (d < (TIER_UNLOCK[c.tier] || 0)) continue;
        if (c.cost < cheap.cost) cheap = c;
      }
      return cheap;
    }
    if (ctx.rng.next() < 0.7) return best;
    return ctx.rng.weighted(affordable, (c) => c.cost);
  }

  /** Buy and place one group. */
  spendCredits(ctx) {
    const card = this.card;
    if (!card) return;
    const cap = this.populationCap;
    if (this.enemies.length >= cap) return;

    // Elites cost 4-5x, so they arrive as small, expensive groups. If the bank
    // can't cover one, quietly downgrade to a normal pack rather than stalling.
    let eliteAffix = ctx.rng.next() < this.eliteChance && card.eliteEligible
      ? ctx.rng.pick(ELITE_AFFIXES)
      : null;
    let unit = card.cost * (eliteAffix ? ELITE_STATS[eliteAffix].cost : 1);
    if (this.credits < unit) {
      if (!eliteAffix) return;
      eliteAffix = null;
      unit = card.cost;
      if (this.credits < unit) return;
    }

    // Partial packs are deliberate. Holding the bank until a whole pack was
    // affordable meant 18-36 credits at 0.77/s — half a minute of nothing, then
    // six beetles at once behind the player. Buying whatever the bank covers on
    // a short interval gives a thin, continuous trickle in the opening minute,
    // and once the credit rate outgrows the card the same code buys whole packs
    // on its own, so the escalation shape is unchanged.
    const affordable = Math.floor(this.credits / unit);
    const want = Math.min(affordable, eliteAffix
      ? ctx.rng.int(1, Math.max(1, Math.ceil(card.packMax * 0.5)))
      : ctx.rng.int(card.packMin, card.packMax));
    const anchor = this.findSpawnPoint(ctx);
    if (!anchor) return;

    let placed = 0;
    for (let i = 0; i < want; i++) {
      if (this.credits < unit || this.enemies.length >= cap) break;
      this.credits -= unit;
      // Fan the group out around the anchor so they don't stack on spawn.
      const ang = ctx.rng.range(0, Math.PI * 2);
      const rad = ctx.rng.range(0, 1.4 + card.radius * want * 0.6);
      this._scratch.set(anchor.x + Math.cos(ang) * rad, anchor.y, anchor.z + Math.sin(ang) * rad);
      this.spawnOne(ctx, card, this._scratch, eliteAffix);
      placed++;
    }
    return placed;
  }

  spawnOne(ctx, def, at, affix) {
    let list = this.pool.get(def.id);
    if (!list) { list = []; this.pool.set(def.id, list); }
    const e = list.length ? list.pop() : new Enemy();
    e.spawn(ctx, def, at, {
      affix: def.eliteEligible ? affix : null,
      level: this.level,
      healthMult: this.healthMult,
      damageMult: this.damageMult,
    });
    this.enemies.push(e);
    return e;
  }

  /**
   * A walkable point at least MIN_SPAWN_DIST from the player and outside the
   * camera frustum. Falls back to the furthest candidate rather than failing —
   * a spawn behind a rock in view beats no pressure at all.
   *
   * The off-screen rule is what stops monsters materialising in front of you,
   * but applied strictly it also means every monster is always behind you, and
   * a pack that only ever arrives from your blind side reads as an ambush. So a
   * candidate far enough away is allowed on screen some of the time: watching a
   * beetle crest a ridge 55m out is a telegraph, not a pop-in.
   */
  findSpawnPoint(ctx) {
    const cam = ctx.camera;
    if (cam) {
      cam.updateMatrixWorld();
      _m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(_m4);
    }
    const player = ctx.player ? ctx.player.position : _v.set(0, 0, 0);
    let fallback = null;
    let fallbackD = -1;

    for (let i = 0; i < 16; i++) {
      const p = this.samplePoint(ctx, player);
      if (!p) continue;
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      if (d < MIN_SPAWN_DIST || d > MAX_SPAWN_DIST) continue;
      this._sphere.center.set(p.x, p.y + 2, p.z);
      const visible = cam ? this._frustum.intersectsSphere(this._sphere) : false;
      if (!visible) return this._point.copy(p);
      if (d >= FAR_SPAWN_DIST && ctx.rng.next() < EDGE_SPAWN_CHANCE) return this._point.copy(p);
      if (d > fallbackD) { fallbackD = d; fallback = this._point.copy(p); }
    }
    return fallback;
  }

  samplePoint(ctx, player) {
    const stage = ctx.stage;
    if (stage && stage.randomWalkablePoint) {
      const p = stage.randomWalkablePoint(ctx.rng, { minDistFrom: player, minDist: MIN_SPAWN_DIST });
      if (p) return p;
    }
    // No stage yet — ring around the player, clamped to terrain.
    const ang = ctx.rng.range(0, Math.PI * 2);
    const rad = ctx.rng.range(MIN_SPAWN_DIST + 4, 55);
    _v2.set(player.x + Math.cos(ang) * rad, 0, player.z + Math.sin(ang) * rad);
    _v2.y = stage && stage.sampleHeight ? stage.sampleHeight(_v2.x, _v2.z) : 0;
    return _v2;
  }

  // -------------------------------------------------------------------------
  // teleporter event
  // -------------------------------------------------------------------------

  /**
   * Place the teleporter boss. Progression calls this the moment the ring
   * starts charging, so the boss is the event and the charge is only its timer.
   *
   * `difficulty` is Progression's own curve; the director already tracks the
   * same escalation in `difficultyCoefficient`, which is what the elite roll
   * and the level scaling read, so it is accepted for the call signature and
   * not re-derived from here.
   */
  spawnBoss(stageIndex = 0, difficulty = this.difficultyCoefficient, position = null) {
    const ctx = this.ctx;
    if (!ctx || !ctx.authority || this.boss) return null;
    const card = BOSS_CARDS[stageIndex % BOSS_CARDS.length];
    if (!card) return null;

    // Ring the teleporter rather than landing on it: the boss has to be walked
    // to, and spawning inside the charge radius drops it on the player's head.
    const at = this._scratch.copy(position || ctx.player?.position || _v.set(0, 0, 0));
    const ang = ctx.rng.range(0, Math.PI * 2);
    at.x += Math.cos(ang) * BOSS_SPAWN_DIST;
    at.z += Math.sin(ang) * BOSS_SPAWN_DIST;
    const ground = ctx.stage?.sampleHeight?.(at.x, at.z);
    if (typeof ground === 'number' && isFinite(ground)) at.y = ground;

    const affix = ctx.rng.next() < clamp(this.eliteChance * 1.5, 0, 0.6)
      ? ctx.rng.pick(ELITE_AFFIXES) : null;
    const boss = this.spawnOne(ctx, card, at, affix);
    boss.isBoss = true;
    this.boss = boss;
    ctx.pipeline?.addShake?.(0.5);
    // `bossDead` is emitted by the reaper in fixedUpdate when this corpse is
    // recycled, so both ends of the fight are on the bus.
    ctx.events.emit('bossSpawn', { enemy: boss });
    return boss;
  }

  beginTeleporterEvent(ctx) {
    this.eventActive = true;
    this.rerollT = 0;
    this.spawnT = 0.5;
    // The event pays for itself: an instant bank so pressure lands immediately.
    this.credits += 40 * this.difficultyCoefficient;

    const card = BOSS_CARDS[0];
    if (!card || this.boss) return;
    const at = this.findSpawnPoint(ctx) || this._scratch.set(
      (ctx.player?.position.x || 0) + 18, 0, (ctx.player?.position.z || 0) + 18);
    const affix = ctx.rng.next() < clamp(this.eliteChance * 1.5, 0, 0.6)
      ? ctx.rng.pick(ELITE_AFFIXES) : null;
    const boss = this.spawnOne(ctx, card, at, affix);
    boss.isBoss = true;
    this.boss = boss;
    ctx.pipeline?.addShake?.(0.5);
    ctx.events.emit('bossSpawn', { enemy: boss });
  }

  endTeleporterEvent(ctx) {
    this.eventActive = false;
    this.spawnT = Math.max(this.spawnT, 3);
  }

  // -------------------------------------------------------------------------
  // effect entry points used by Enemy
  // -------------------------------------------------------------------------

  spawnWave(position, radius, speed, damage, source, color) {
    this.waves.spawn(position, radius, speed, damage, source, color);
  }

  spawnBeamTrail(origin, dir, length, color) {
    this.trails.spawn(origin, dir, length, color);
  }

  clear(ctx) {
    for (const e of this.enemies) e.despawn(ctx);
    this.enemies.length = 0;
    this.projectiles.clear();
    this.waves.clear();
  }

  /** HUD helper: 0..1 across the current difficulty band. */
  get difficultyProgress() {
    const i = this.difficultyIndex;
    const lo = DIFFICULTY_NAMES[i][0];
    const hi = i + 1 < DIFFICULTY_NAMES.length ? DIFFICULTY_NAMES[i + 1][0] : lo + 4;
    return clamp((this.difficultyCoefficient - lo) / (hi - lo), 0, 1);
  }
}

// ---------------------------------------------------------------------------
// enemy projectiles
// ---------------------------------------------------------------------------

class Projectiles {
  constructor() {
    this.list = [];
    this.pool = [];
    this.meshPool = new Map();
  }

  init(ctx) { this.ctx = ctx; }

  take(color) {
    let mp = this.meshPool.get(color);
    if (!mp) { mp = []; this.meshPool.set(color, mp); }
    return mp.length ? mp.pop() : makeProjectile(color);
  }

  give(color, mesh) {
    const mp = this.meshPool.get(color);
    if (mp) mp.push(mesh); else this.meshPool.set(color, [mesh]);
  }

  fire(owner, def, position, velocity) {
    const p = this.pool.length ? this.pool.pop() : {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), mesh: null,
      def: null, owner: null, life: 0, color: 0, spin: 0,
    };
    p.pos.copy(position);
    p.vel.copy(velocity);
    p.def = def;
    p.owner = owner;
    p.life = def.life || 4;
    p.color = def.color || 0xff7a1e;
    p.spin = 0;
    p.mesh = this.take(p.color);
    p.mesh.position.copy(p.pos);
    p.mesh.scale.setScalar(def.radius ? def.radius / 0.3 : 1);
    this.ctx.scene.add(p.mesh);
    this.list.push(p);
    return p;
  }

  fixedUpdate(ctx, h) {
    const player = ctx.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const d = p.def;
      p.life -= h;

      if (d.homing && player) {
        // Gentle homing — dodgeable, but it punishes standing still.
        _v.subVectors(player.position, p.pos);
        _v.y += 1.0;
        const len = _v.length();
        if (len > 0.01) {
          _v.multiplyScalar(1 / len);
          const s = p.vel.length();
          p.vel.x = lerp(p.vel.x, _v.x * s, clamp(d.homing * h, 0, 1));
          p.vel.y = lerp(p.vel.y, _v.y * s, clamp(d.homing * h, 0, 1));
          p.vel.z = lerp(p.vel.z, _v.z * s, clamp(d.homing * h, 0, 1));
        }
      }
      if (d.gravity) p.vel.y -= d.gravity * h;
      p.pos.addScaledVector(p.vel, h);

      let hit = false;
      if (player && player.position) {
        const r = (d.radius || 0.3) + (player.radius || 0.45);
        const dx = p.pos.x - player.position.x;
        const dy = p.pos.y - (player.position.y + 0.9);
        const dz = p.pos.z - player.position.z;
        if (dx * dx + dy * dy + dz * dz < r * r) hit = true;
      }
      const ground = ctx.stage && ctx.stage.sampleHeight ? ctx.stage.sampleHeight(p.pos.x, p.pos.z) : 0;
      if (!hit && p.pos.y <= ground + 0.1) hit = true;

      if (hit || p.life <= 0) {
        if (hit) this.detonate(ctx, p);
        this.recycle(i);
      }
    }
  }

  detonate(ctx, p) {
    const d = p.def;
    const owner = p.owner;
    const dmg = owner ? owner.damage * d.damage : d.damage * 10;
    const player = ctx.player;
    if (player) {
      const reach = (d.blast || 0) + (player.radius || 0.45) + (d.radius || 0.3);
      const dx = p.pos.x - player.position.x;
      const dz = p.pos.z - player.position.z;
      const dy = p.pos.y - (player.position.y + 0.9);
      if (dx * dx + dy * dy + dz * dz < reach * reach && owner) {
        damagePlayer(ctx, player, dmg, owner, p.pos, 'projectile');
        ctx.pipeline?.addShake?.(0.05);
      }
    }
    if (d.blast) ctx.director?.spawnWave(p.pos, d.blast, 40, 0, null, p.color);
    if (ctx.vfx && ctx.vfx.explosion) ctx.vfx.explosion(p.pos, d.blast || 0.6, p.color);
  }

  recycle(i) {
    const p = this.list[i];
    this.ctx.scene.remove(p.mesh);
    this.give(p.color, p.mesh);
    p.mesh = null;
    p.owner = null;
    p.def = null;
    this.list.splice(i, 1);
    this.pool.push(p);
  }

  update(ctx, dt) {
    for (const p of this.list) {
      p.spin += dt;
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.y = p.spin * 3.2;
      p.mesh.rotation.x = p.spin * 2.1;
      const husk = p.mesh.userData.husk;
      husk.rotation.y = -p.spin * 5;
      husk.scale.setScalar(1 + Math.sin(p.spin * 22) * 0.12);
    }
  }

  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this.recycle(i);
  }
}

// ---------------------------------------------------------------------------
// expanding shockwave rings (slams, stomps, elite death novas, blasts)
// ---------------------------------------------------------------------------

class Waves {
  constructor() { this.list = []; this.pool = []; this.meshPool = new Map(); }
  init(ctx) { this.ctx = ctx; }

  spawn(position, maxRadius, speed, damage, source, color) {
    const w = this.pool.length ? this.pool.pop() : { pos: new THREE.Vector3(), r: 0, max: 0, speed: 0, damage: 0, source: null, mesh: null, color: 0, hit: false };
    w.pos.copy(position);
    w.r = 0.6;
    w.max = maxRadius;
    w.speed = speed;
    w.damage = damage;
    w.source = source;
    w.hit = false;
    w.color = color || 0xffa514;
    let mp = this.meshPool.get(w.color);
    if (!mp) { mp = []; this.meshPool.set(w.color, mp); }
    w.mesh = mp.length ? mp.pop() : makeShockwave(w.color);
    w.mesh.position.set(position.x, position.y + 0.15, position.z);
    w.mesh.scale.setScalar(w.r);
    w.mesh.material.opacity = 0.9;
    this.ctx.scene.add(w.mesh);
    this.list.push(w);
    return w;
  }

  fixedUpdate(ctx, h) {
    const player = ctx.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i];
      const prev = w.r;
      w.r += w.speed * h;
      // Damage lands exactly when the visible ring crosses you.
      if (w.damage > 0 && !w.hit && player) {
        const d = Math.hypot(player.position.x - w.pos.x, player.position.z - w.pos.z);
        const pr = player.radius || 0.45;
        if (d >= prev - pr && d <= w.r + pr && Math.abs(player.position.y - w.pos.y) < 4) {
          w.hit = true;
          damagePlayer(ctx, player, w.damage, w.source, w.pos, 'shockwave');
        }
      }
      if (w.r >= w.max) this.recycle(i);
    }
  }

  update(ctx, dt) {
    for (const w of this.list) {
      w.mesh.scale.set(w.r, w.r, 1);
      w.mesh.material.opacity = clamp(0.9 * (1 - w.r / w.max), 0, 0.9);
    }
  }

  recycle(i) {
    const w = this.list[i];
    this.ctx.scene.remove(w.mesh);
    const mp = this.meshPool.get(w.color);
    if (mp) mp.push(w.mesh);
    w.mesh = null;
    w.source = null;
    this.list.splice(i, 1);
    this.pool.push(w);
  }

  clear() { for (let i = this.list.length - 1; i >= 0; i--) this.recycle(i); }
}

// ---------------------------------------------------------------------------
// fading beam trails left by golem / titan lasers
// ---------------------------------------------------------------------------

class Trails {
  constructor() { this.list = []; this.pool = []; this.meshes = []; }
  init(ctx) { this.ctx = ctx; }

  spawn(origin, dir, length, color) {
    if (length < 0.5) return;
    let mesh;
    if (this.meshes.length) {
      mesh = this.meshes.pop();
      mesh.material.color.setHex(color || 0x22d3ff);
    } else {
      const geo = new THREE.CylinderGeometry(0.14, 0.14, 1, 6);
      const mat = new THREE.MeshBasicMaterial({
        color: color || 0x22d3ff, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
    }
    _q.setFromUnitVectors(_up, _v.copy(dir).normalize());
    mesh.quaternion.copy(_q);
    mesh.position.copy(origin).addScaledVector(_v, length * 0.5);
    mesh.scale.set(1, length, 1);
    mesh.material.opacity = 0.85;
    this.ctx.scene.add(mesh);
    const t = this.pool.length ? this.pool.pop() : { mesh: null, life: 0 };
    t.mesh = mesh;
    t.life = 0.16;
    this.list.push(t);
  }

  update(ctx, dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.life -= dt;
      const k = clamp(t.life / 0.16, 0, 1);
      t.mesh.material.opacity = 0.85 * k;
      t.mesh.scale.x = t.mesh.scale.z = 0.4 + k * 0.6;
      if (t.life <= 0) {
        this.ctx.scene.remove(t.mesh);
        this.meshes.push(t.mesh);
        t.mesh = null;
        this.list.splice(i, 1);
        this.pool.push(t);
      }
    }
  }
}
