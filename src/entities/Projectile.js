import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';

/**
 * Fixed-capacity projectile pool. Every projectile, mesh, and scratch vector is
 * allocated once in the constructor — `spawn` only ever flips flags, so a
 * missile salvo mid-fight never triggers a GC pause.
 *
 * Kinds:
 *   linear  — straight line, no gravity
 *   arc     — ballistic, `gravity` m/s², explodes on contact
 *   homing  — steers toward the nearest enemy within `seekRange`
 *
 * The pool is ticked from Player.fixedUpdate (gameplay) and Player.update
 * (visual interpolation), since projectiles are not a registered system.
 */

const CAPACITY = 96;
const MAX_STEP = 0.6; // metres per collision segment; longer travel is subdivided

export class ProjectilePool {
  constructor(ctx) {
    this.ctx = ctx;
    this.items = [];

    // One shared geometry per shape, one material per colour bucket.
    const bodyGeo = new THREE.ConeGeometry(0.12, 0.46, 6);
    bodyGeo.rotateX(Math.PI / 2); // point down +Z
    const orbGeo = new THREE.IcosahedronGeometry(0.16, 0);
    this.geo = { body: bodyGeo, orb: orbGeo };
    this.mats = new Map();

    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    for (let i = 0; i < CAPACITY; i++) {
      const mesh = new THREE.Mesh(bodyGeo, this._material(0xffaa55));
      mesh.visible = false;
      mesh.castShadow = false;
      this.root.add(mesh);
      this.items.push({
        alive: false, mesh,
        position: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        kind: 'linear', damage: 0, radius: 0.2, splash: 0,
        gravity: 0, life: 0, maxLife: 2, seekRange: 0, turnRate: 0,
        target: null, owner: null, proc: 1, crit: false,
        trail: null, spin: 0, armTime: 0,
      });
    }
    this._free = this.items.slice();

    this._v = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  _material(color) {
    let m = this.mats.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 2.2,
        roughness: 0.4, metalness: 0, flatShading: true,
      });
      this.mats.set(color, m);
    }
    return m;
  }

  /**
   * @param {object} o { position, velocity, kind, damage, radius, splash,
   *                     gravity, life, seekRange, turnRate, color, orb,
   *                     owner, proc, crit, armTime }
   */
  spawn(o) {
    const p = this._free.pop();
    if (!p) return null; // pool exhausted — drop the shot rather than allocate

    p.alive = true;
    p.position.copy(o.position);
    p.prev.copy(o.position);
    p.velocity.copy(o.velocity);
    p.kind = o.kind || 'linear';
    p.damage = o.damage || 0;
    p.radius = o.radius ?? 0.22;
    p.splash = o.splash || 0;
    p.gravity = o.gravity || 0;
    p.maxLife = o.life ?? 4;
    p.life = 0;
    p.seekRange = o.seekRange || 0;
    p.turnRate = o.turnRate || 0;
    p.target = null;
    p.owner = o.owner || null;
    p.proc = o.proc ?? 1;
    p.armTime = o.armTime || 0;
    p.spin = o.spin || 0;

    const color = o.color ?? 0xffaa55;
    p.mesh.geometry = o.orb ? this.geo.orb : this.geo.body;
    p.mesh.material = this._material(color);
    p.mesh.position.copy(o.position);
    p.mesh.visible = true;
    p.mesh.scale.setScalar(o.scale ?? 1);

    // Ribbon trail. The pool is small and steals from the shortest trail when
    // full, so a big volley degrades gracefully instead of failing.
    p.trail = this.ctx.vfx?.trails?.spawn({
      position: p.position, color, coreColor: 0xffffff,
      width: p.radius * 1.1, life: o.trailLife ?? 0.22, minDist: 0.12,
    }) || null;
    return p;
  }

  fixedUpdate(ctx, h) {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.life += h;
      if (p.life >= p.maxLife) { this._expire(ctx, p); continue; }

      if (p.kind === 'arc') {
        p.velocity.y -= p.gravity * h;
      } else if (p.kind === 'homing') {
        this._steer(ctx, p, h);
      }

      p.prev.copy(p.position);
      const dist = p.velocity.length() * h;
      // Subdivide fast movement so nothing tunnels through a wall or an enemy.
      const steps = Math.max(1, Math.ceil(dist / MAX_STEP));
      const sh = h / steps;
      let done = false;
      for (let i = 0; i < steps && !done; i++) {
        this._v.copy(p.velocity).multiplyScalar(sh);
        const segLen = this._v.length();
        if (segLen > 1e-5) {
          this._dir.copy(this._v).divideScalar(segLen);
          const hit = ctx.stage?.raycast?.(p.position, this._dir, segLen + p.radius) || null;
          if (hit && hit.point) {
            p.position.copy(hit.point);
            this._impact(ctx, p, hit.normal || this._up);
            done = true;
            break;
          }
        }
        p.position.add(this._v);
        if (p.life >= p.armTime) {
          const target = this._entityAt(ctx, p);
          if (target) { this._hitEntity(ctx, p, target); done = true; }
        }
      }
      if (done) continue;

      // Fallback if the stage has no collision yet: never fall forever.
      if (p.position.y < -60) this._expire(ctx, p);
    }
  }

  /** Presentation only: orient meshes along travel, feed trails, spin. */
  update(ctx, dt) {
    const trails = ctx.vfx?.trails;
    for (const p of this.items) {
      if (!p.alive) continue;
      p.mesh.position.copy(p.position);
      if (p.trail && trails) trails.move(p.trail, p.position.x, p.position.y, p.position.z);
      const v = p.velocity;
      if (v.lengthSq() > 1e-4) {
        this._v.copy(p.position).add(v);
        p.mesh.lookAt(this._v);
      }
      if (p.spin) p.mesh.rotateZ(p.spin * dt);
    }
  }

  _steer(ctx, p, h) {
    if (!p.target || !p.target.alive) p.target = nearestEnemy(ctx, p.position, p.seekRange, p.owner);
    if (!p.target) return;
    const speed = p.velocity.length();
    this._v.copy(p.target.position);
    this._v.y += (p.target.height || 1.6) * 0.5;
    this._v.sub(p.position);
    const d = this._v.length();
    if (d < 1e-4) return;
    this._v.divideScalar(d);
    // Turn rate scales up as the missile closes, so the arc reads as a lazy
    // launch that snaps onto the target rather than a laser-straight line.
    const t = clamp(p.turnRate * h * (1 + 6 / Math.max(d, 1)), 0, 1);
    p.velocity.normalize().lerp(this._v, t).normalize().multiplyScalar(speed);
  }

  _entityAt(ctx, p) {
    const list = enemyList(ctx);
    if (!list) return null;
    for (const e of list) {
      if (!e || !e.alive || e === p.owner) continue;
      if (p.owner && e.team === p.owner.team) continue;
      const hh = (e.height || 1.6) * 0.5;
      const dx = e.position.x - p.position.x;
      const dz = e.position.z - p.position.z;
      const dy = (e.position.y + hh) - p.position.y;
      const r = (e.radius || 0.5) + p.radius;
      if (dx * dx + dz * dz < r * r && Math.abs(dy) < hh + p.radius) return e;
    }
    return null;
  }

  _hitEntity(ctx, p, target) {
    if (p.splash > 0) { this._explode(ctx, p); this._release(p); return; }
    // Crit is deliberately left undefined: Combat rolls it from the owner's
    // stats so the number on screen is the number that landed.
    const info = { source: p.owner, procCoefficient: p.proc, position: p.position, type: 'projectile' };
    if (ctx.combat?.applyDamage) ctx.combat.applyDamage(target, p.damage, info);
    else target.takeDamage?.(p.damage, info);
    // VFX draws the hit confirm off the `damage` event; adding one here would
    // double it.
    this._release(p);
  }

  _impact(ctx, p, normal) {
    if (p.splash > 0) { this._explode(ctx, p); this._release(p); return; }
    ctx.vfx?.impact?.(p.position, normal, 'stone');
    this._release(p);
  }

  _explode(ctx, p) {
    // Combat.explode fires its own explosion VFX; only draw ours when it isn't
    // there to do it, so the effect never doubles up.
    if (ctx.combat?.explode) {
      ctx.combat.explode(p.position, p.splash, p.damage, p.owner, { proc: p.proc, type: 'blast' });
    } else {
      ctx.vfx?.explosion?.(p.position, p.splash, p.mesh.material.color.getHex());
      const list = enemyList(ctx);
      if (list) {
        for (const e of list) {
          if (!e || !e.alive || (p.owner && e.team === p.owner.team)) continue;
          const d = e.position.distanceTo(p.position);
          if (d > p.splash + (e.radius || 0.5)) continue;
          const falloff = clamp(1 - d / (p.splash + 0.001), 0.35, 1);
          e.takeDamage?.(p.damage * falloff, { source: p.owner, position: p.position });
        }
      }
    }
    ctx.audio?.explosion?.(p.position, p.splash);
    ctx.pipeline?.addShake?.(0.05);
  }

  _expire(ctx, p) {
    if (p.splash > 0 && p.kind !== 'linear') this._explode(ctx, p);
    this._release(p);
  }

  _release(p) {
    p.alive = false;
    p.target = null;
    p.mesh.visible = false;
    // Stop emitting but let the tail fly out and recycle itself.
    if (p.trail) { this.ctx.vfx?.trails?.stop(p.trail); p.trail = null; }
    this._free.push(p);
  }

  clear() {
    for (const p of this.items) if (p.alive) this._release(p);
  }
}

// --- shared enemy queries ---------------------------------------------------
// Combat owns the entity registry but the contract only guarantees `register`,
// so probe for whichever accessor exists and degrade to "no targets".

export function enemyList(ctx) {
  const c = ctx.combat;
  if (!c) return null;
  if (Array.isArray(c.entities)) return c.entities;
  if (Array.isArray(c.enemies)) return c.enemies;
  if (typeof c.all === 'function') return c.all();
  return null;
}

export function nearestEnemy(ctx, position, range, owner) {
  if (ctx.combat?.nearestHostile) return ctx.combat.nearestHostile(position, range, owner?.team || null) || null;
  const list = enemyList(ctx);
  if (!list) return null;
  let best = null, bestD = range * range;
  for (const e of list) {
    if (!e || !e.alive || e === owner) continue;
    if (owner && e.team === owner.team) continue;
    const d = e.position.distanceToSquared(position);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
