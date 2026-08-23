import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';
import { RimStandardMaterial } from './CharacterMesh.js';
import { nearestEnemy } from './Projectile.js';

/**
 * Fixed-capacity pool of deployed constructs — the engineer's turrets, mines
 * and wards. Same shape and the same reasons as `ProjectilePool`: everything is
 * allocated up front, `spawn` only flips flags, and the pool is ticked from
 * `Player` (gameplay in `fixedUpdate`, presentation in `update`) because a pool
 * owned by an entity is not a registered system.
 *
 * Kinds:
 *   mine   — thrown, settles ballistically, arms, detonates on proximity
 *   ward   — static field: pulses damage + slow on hostiles, trickles health
 *            back to its owner while they stand inside it
 *   turret — static gun: reacquires the nearest hostile and hitscans it
 *
 * ## Why these are *not* registered with Combat
 *
 * The entity contract would make them damageable, which is the RoR2 behaviour —
 * but it also routes their destruction through `Combat._kill`, which emits
 * `kill`. Progression, Items and Director all listen to that event and would
 * book a player's own expiring turret as a monster kill (XP, gold, on-kill item
 * procs). They are also not in the snapshot protocol, so a host that let them
 * be killed and a client that could not see them killed would diverge.
 *
 * So a deployed construct is a *tracked, simulated, host-authoritative
 * object with a lifetime* rather than a damageable body: enemies ignore it, it
 * expires on its own clock, and every point of damage it deals still goes
 * through `ctx.combat` so crit, armour and the proc chain are decided in the
 * one place that is allowed to decide them. Making them destructible is a
 * protocol change, not a gameplay tweak.
 *
 * Damage is never gated here. `Combat.applyDamage` already early-returns off
 * `ctx.authority`, so a client's local copy of its own turret muzzle-flashes
 * and tracers exactly like the host's while resolving nothing — the same deal
 * projectiles already have.
 */

const CAPACITY = 24;

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

// Shared scratch for overlap snapshots. `applyDamage` can re-enter Combat and
// clobber its own `_overlap` buffer mid-iteration — the same trap `explode`
// documents — so anything that damages a group copies the group out first.
const _hits = [];

function mat(color, { rough = 0.5, metal = 0.45, emissive = 0, emissiveIntensity = 0,
  rimColor = 0xa9d2ff, rimStrength = 0.6 } = {}) {
  return new RimStandardMaterial({
    color, roughness: rough, metalness: metal, flatShading: true,
    emissive, emissiveIntensity, rimColor, rimStrength,
  });
}

function box(w, h, d, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = true;
  return m;
}

export class PlaceablePool {
  constructor(ctx) {
    this.ctx = ctx;

    // One material set for the whole pool. The accent is the engineer's acid
    // green so a field of deployables reads as one player's work at a glance,
    // which is the whole point of a per-survivor VFX language.
    this.mats = {
      shell: mat(0x39434c, { rough: 0.46, metal: 0.55 }),
      plate: mat(0xb9c2bb, { rough: 0.4, metal: 0.35, emissive: 0xb9c2bb, emissiveIntensity: 0.08, rimStrength: 0.2 }),
      dark: mat(0x161d22, { rough: 0.8, metal: 0.2, rimStrength: 0.95 }),
      accent: mat(0x0d1a10, { rough: 0.35, metal: 0.1, emissive: 0x9dff5a, emissiveIntensity: 2.2 }),
      hot: mat(0x1a1206, { rough: 0.35, metal: 0.1, emissive: 0xffb03c, emissiveIntensity: 2.0 }),
    };

    this.root = new THREE.Group();
    ctx.scene.add(this.root);

    this.items = [];
    for (let i = 0; i < CAPACITY; i++) {
      const group = new THREE.Group();
      group.visible = false;
      this.root.add(group);
      this.items.push({
        alive: false,
        kind: 'mine',
        // Rigs are built on first use of each kind and then kept: a run that
        // never deploys a ward never pays for one, and a run that deploys a
        // hundred builds at most CAPACITY.
        rigs: {},
        rig: null,
        group,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        life: 0, maxLife: 10,
        damage: 0, radius: 1, range: 0,
        timer: 0, period: 0.5, armTime: 0,
        owner: null, proc: 1, target: null,
        yaw: 0, pitch: 0, pulse: 0,
      });
    }
    this._free = this.items.slice();
  }

  /**
   * @param {object} o { kind, position, velocity, damage, radius, range, life,
   *                     period, armTime, owner, proc }
   */
  spawn(o) {
    const p = this._free.pop();
    // Pool exhausted: drop the deploy rather than allocate mid-fight. The
    // charge is still spent, exactly like a dropped projectile.
    if (!p) return null;

    p.alive = true;
    p.kind = o.kind || 'mine';
    p.position.copy(o.position);
    p.velocity.copy(o.velocity || _v.set(0, 0, 0));
    p.life = 0;
    p.maxLife = o.life ?? 12;
    p.damage = o.damage || 0;
    p.radius = o.radius ?? 2;
    p.range = o.range ?? 0;
    p.period = o.period ?? 0.5;
    p.timer = p.period;
    p.armTime = o.armTime ?? 0;
    p.owner = o.owner || null;
    p.proc = o.proc ?? 1;
    p.target = null;
    p.yaw = o.yaw ?? 0;
    p.pitch = 0;
    p.pulse = 0;

    let rig = p.rigs[p.kind];
    if (!rig) {
      rig = p.rigs[p.kind] = this._buildRig(p.kind);
      p.group.add(rig.root);
    }
    for (const k in p.rigs) p.rigs[k].root.visible = (k === p.kind);
    p.rig = rig;
    p.group.visible = true;
    p.group.position.copy(p.position);
    p.group.rotation.y = p.yaw;
    p.group.scale.setScalar(0.001); // pops open on the first presentation frame
    return p;
  }

  // ------------------------------------------------------------------ rigs

  _buildRig(kind) {
    const M = this.mats;
    const root = new THREE.Group();
    if (kind === 'mine') {
      // Squat hex puck with a hot centre and three stubby legs — small, but the
      // emissive eye is what makes it findable on dark ground.
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.26, 0.13, 6), M.shell);
      body.castShadow = true;
      body.position.y = 0.09;
      root.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 0.05, 6), M.plate);
      cap.position.y = 0.17;
      root.add(cap);
      const eye = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), M.accent);
      eye.position.y = 0.21;
      root.add(eye);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = box(0.045, 0.10, 0.045, M.dark);
        leg.position.set(Math.sin(a) * 0.19, 0.04, Math.cos(a) * 0.19);
        root.add(leg);
      }
      return { root, eye, head: null, muzzle: null, dome: null };
    }

    if (kind === 'ward') {
      // A tripod pylon under a faceted dome. The dome is the readable shape —
      // it has to say "field" from across the arena, so it is wide, low-poly
      // and additively lit rather than a wire circle on the floor.
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.16, 0.9, 6), M.shell);
      post.castShadow = true;
      post.position.y = 0.45;
      root.add(post);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const foot = box(0.10, 0.08, 0.34, M.dark);
        foot.position.set(Math.sin(a) * 0.22, 0.05, Math.cos(a) * 0.22);
        foot.rotation.y = a;
        root.add(foot);
      }
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.09, 6), M.plate);
      collar.position.y = 0.93;
      root.add(collar);
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 0), M.accent);
      core.position.y = 1.12;
      root.add(core);

      // Additive shell, no depth write: it reads as a volume rather than as a
      // solid that hides whatever is standing in it, which is the difference
      // between a field and an obstruction at gameplay readability.
      const dome = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: 0x9dff5a, transparent: true, opacity: 0.14,
          blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true, fog: true,
        }),
      );
      dome.position.y = 0.2;
      root.add(dome);
      return { root, eye: core, head: null, muzzle: null, dome };
    }

    // turret
    const legs = new THREE.Group();
    root.add(legs);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      const leg = box(0.08, 0.55, 0.10, M.dark);
      leg.position.set(Math.sin(a) * 0.20, 0.28, Math.cos(a) * 0.20);
      leg.rotation.z = Math.sin(a) * 0.22;
      leg.rotation.x = -Math.cos(a) * 0.22;
      legs.add(leg);
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.16, 6), M.shell);
    base.castShadow = true;
    base.position.y = 0.62;
    root.add(base);

    const head = new THREE.Group();
    head.position.y = 0.78;
    root.add(head);
    const housing = box(0.30, 0.22, 0.34, M.plate);
    housing.castShadow = true;
    head.add(housing);
    const visor = box(0.20, 0.06, 0.04, M.accent);
    visor.position.set(0, 0.05, 0.18);
    head.add(visor);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.42, 6), M.dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, -0.03, 0.30);
    barrel.castShadow = true;
    head.add(barrel);
    const fin = box(0.05, 0.20, 0.16, M.dark);
    fin.position.set(0, 0.16, -0.10);
    head.add(fin);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, -0.03, 0.52);
    head.add(muzzle);
    return { root, eye: visor, head, muzzle, dome: null };
  }

  // -------------------------------------------------------------- gameplay

  fixedUpdate(ctx, h) {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.life += h;
      if (p.life >= p.maxLife) { this._expire(ctx, p); continue; }
      if (p.kind === 'mine') this._stepMine(ctx, p, h);
      else if (p.kind === 'ward') this._stepWard(ctx, p, h);
      else this._stepTurret(ctx, p, h);
    }
  }

  _stepMine(ctx, p, h) {
    // Ballistic until it finds ground, then it stays where it landed. A mine
    // that keeps integrating on a slope slides downhill for its whole life.
    if (p.velocity.lengthSq() > 1e-6) {
      p.velocity.y -= 26 * h;
      p.position.addScaledVector(p.velocity, h);
      const g = ctx.stage?.sampleHeight?.(p.position.x, p.position.z);
      const floor = Number.isFinite(g) ? g : 0;
      if (p.position.y <= floor) {
        p.position.y = floor;
        p.velocity.set(0, 0, 0);
        ctx.vfx?.impact?.(p.position, _up, 'dirt');
      }
    }
    if (p.life < p.armTime) return;

    const c = ctx.combat;
    if (!c?.sphereOverlap) return;
    // Trip radius, not blast radius: the charge has to detonate *before* the
    // body walks over it or the falloff eats most of the hit.
    if (c.nearestHostile?.(p.position, p.radius, 'player')) this._detonate(ctx, p);
  }

  _detonate(ctx, p) {
    const blast = p.radius * 2.1;
    ctx.combat?.explode?.(p.position, blast, p.damage, p.owner, { proc: p.proc, type: 'blast' });
    // `explode` draws its own fireball; the ring and the shake are the layers
    // that make a mine read as a *charge* rather than as a grenade.
    ctx.vfx?.rings?.spawn?.(p.position, _up, 0x9dff5a, blast * 0.2, blast * 1.4, 0.35, 0.8);
    ctx.pipeline?.addShake?.(0.06);
    this._release(p);
  }

  _stepWard(ctx, p, h) {
    p.timer -= h;
    if (p.timer > 0) return;
    p.timer += p.period;
    p.pulse++;

    const c = ctx.combat;
    if (c?.sphereOverlap) {
      const n = c.sphereOverlap(p.position, p.radius, 'player');
      _hits.length = 0;
      for (let i = 0; i < n; i++) _hits.push(c.overlapAt(i));
      for (let i = 0; i < _hits.length; i++) {
        c.applyDamage(_hits[i], p.damage, {
          source: p.owner, procCoefficient: p.proc, position: p.position, type: 'blast',
        });
        c.applyStatus?.(_hits[i], 'slow', p.owner, 1);
      }
      _hits.length = 0;
    }

    // The ward is a *position* the player is meant to want to stand on, so the
    // regen only pays out inside it.
    const o = p.owner;
    if (o?.alive && o.position.distanceToSquared(p.position) < p.radius * p.radius) {
      const amount = (o.maxHealth || 100) * 0.012;
      if (c?.heal) c.heal(o, amount); else o.heal?.(amount);
    }

    ctx.vfx?.rings?.spawn?.(p.position, _up, 0x9dff5a, p.radius * 0.25, p.radius, 0.5, 0.55);
    ctx.vfx?.lights?.flick?.(p.position, 0x9dff5a, 10, p.radius * 1.6, 0.18);
  }

  _stepTurret(ctx, p, h) {
    p.timer -= h;
    if (!p.target?.alive || p.target.position.distanceToSquared(p.position) > p.range * p.range) {
      p.target = nearestEnemy(ctx, p.position, p.range, p.owner);
    }
    const t = p.target;
    if (!t?.alive) return;

    _to.copy(t.position);
    _to.y += (t.height || 1.8) * 0.5;
    _from.copy(p.position).setY(p.position.y + 0.78);
    _dir.subVectors(_to, _from);
    const dist = _dir.length();
    if (dist < 1e-3) return;
    _dir.divideScalar(dist);

    // Traverse is a presentation value, but it is derived here so the barrel is
    // pointing where the shot came from on the frame the shot is drawn.
    p.yaw = Math.atan2(_dir.x, _dir.z);
    p.pitch = Math.asin(clamp(_dir.y, -1, 1));

    if (p.timer > 0) return;
    p.timer += p.period;

    if (p.rig?.muzzle) {
      p.rig.muzzle.updateWorldMatrix(true, false);
      _from.setFromMatrixPosition(p.rig.muzzle.matrixWorld);
      _dir.subVectors(_to, _from).normalize();
    }

    ctx.combat?.hitscan?.(_from, _dir, p.range, {
      damage: p.damage, source: p.owner, team: 'player', pierce: 0, proc: p.proc, type: 'hitscan',
    });
    _v.copy(_from).addScaledVector(_dir, Math.min(dist, p.range));
    // Dressed as a missile rather than a bare tracer (#190) — presentation
    // only. The hitscan above has already resolved; this draws the shot that
    // just happened, in Rook's green, and arrives inside a couple of frames.
    ctx.vfx?.sentryMissile?.(_from, _v, 0xbfff7a);
    ctx.vfx?.muzzleFlash?.(_from, _dir, 0.32);
  }

  _expire(ctx, p) {
    // A mine that runs out of clock still goes off — an armed charge that
    // silently evaporates is the single most confusing thing a placeable can do.
    if (p.kind === 'mine' && p.life >= p.armTime) { this._detonate(ctx, p); return; }
    ctx.vfx?.burst?.(p.position, p.kind === 'ward' ? 0x9dff5a : 0xbfff7a);
    this._release(p);
  }

  // ---------------------------------------------------------- presentation

  update(ctx, dt) {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.group.position.copy(p.position);

      // Deploy pop and expiry shrink, both on the same scalar: a construct that
      // appears and vanishes at full size reads as a rendering glitch.
      const inT = clamp(p.life / 0.18, 0, 1);
      const outT = clamp((p.maxLife - p.life) / 0.3, 0, 1);
      const pop = 1 + Math.sin(clamp(inT, 0, 1) * Math.PI) * 0.22;
      p.group.scale.setScalar(inT * outT * pop);

      if (p.kind === 'turret') {
        p.group.rotation.y = p.yaw;
        if (p.rig.head) p.rig.head.rotation.x = -(p.pitch || 0);
      } else if (p.kind === 'ward') {
        const d = p.rig.dome;
        if (d) {
          // Breathing dome, keyed off gameplay pulses rather than wall time so
          // the visual beat and the damage beat are the same beat.
          const phase = 1 - clamp(p.timer / Math.max(p.period, 1e-3), 0, 1);
          d.scale.setScalar(p.radius * (0.94 + phase * 0.08));
          d.material.opacity = 0.10 + (1 - phase) * 0.10;
          d.rotation.y += dt * 0.35;
        }
      } else if (p.rig.eye) {
        // Arming blink: fast when live, absent while still settling.
        const armed = p.life >= p.armTime;
        p.rig.eye.visible = !armed || Math.sin(p.life * 14) > -0.2;
      }
    }
  }

  clear() {
    for (const p of this.items) if (p.alive) this._release(p);
  }

  _release(p) {
    p.alive = false;
    p.target = null;
    p.owner = null;
    p.group.visible = false;
    this._free.push(p);
  }
}
