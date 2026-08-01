import * as THREE from 'three';
import { REALM_ORIGIN_X, VOID_Y } from '../../data/realms.js';
import { clamp } from '../../core/MathUtil.js';

/**
 * A realm's stage.
 *
 * `ctx.stage`'s API is frozen (CONTRACTS.md): `raycast`, `sampleHeight`,
 * `capsuleResolve`, `randomWalkablePoint`. Everything that queries the world
 * goes through those four, so a realm satisfies them and every existing system
 * — the player's capsule, enemy pathing, the camera boom, the harness's own
 * framing probes — works inside a realm without being taught what a realm is.
 *
 * Two things make it much simpler than `world/Stage.js`, and both are the
 * point of the file rather than a shortcut:
 *
 *  - **The ground is analytic.** A realm floor is a disc at y = 0, so the
 *    heightfield is one `hypot` and the terrain raycast is one plane solve.
 *    There is no DDA and no baked grid because there is no relief to march.
 *  - **The floor can change size at runtime.** `setFloorRadius` is what lets
 *    the finale take the arena away between phases; the drawn disc, the
 *    collision test and the walkable sampler all read the same number, so they
 *    cannot disagree about where the edge is.
 *
 * Realms are built at `REALM_ORIGIN_X` on +X — four kilometres from any stage's
 * 220 m basin. That is what lets the world stage stay standing (and its chests
 * stay unopened) while the player is somewhere else: nothing is torn down, the
 * run's state is untouched, and coming back is a pointer swap rather than a
 * regeneration.
 */

const WALK_CLEARANCE = 0.6;
const SNAP_DIST = 0.42;

const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _hits = [];
const _hitN = new THREE.Vector3();
const _hitP = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _nmat = new THREE.Matrix3();

export class RealmStage {
  /**
   * @param ctx            engine ctx
   * @param def            the entry from `data/realms.js`
   */
  constructor(ctx, def) {
    this.ctx = ctx;
    this.def = def;
    this.isRealm = true;
    this.realmId = def.id;

    // Arena centre in world space. Y is the floor plane; everything below it is
    // either solid (walled realms) or the drop (the finale).
    this.origin = new THREE.Vector3(REALM_ORIGIN_X, 0, 0);

    this.floorRadius = def.floorRadius;
    this.wallRadius = def.wallRadius;

    // Stage-contract fields other systems read directly.
    this.half = def.wallRadius + 8;
    this.bound = def.wallRadius - 1.0;
    this.stageIndex = ctx.progression?.stageIndex ?? 0;
    this.stageName = def.name;
    this.biome = null;              // realms dress the sky themselves; see Realms.js
    this.landmarks = [{ kind: 'realm', x: this.origin.x, y: 0, z: this.origin.z, r: 6 }];
    this.minY = VOID_Y;
    this.maxY = 40;

    /** Cylinder colliders `{ x, z, r, y0, y1 }` in world space. */
    this.colliders = [];
    /** One-way circular platforms `{ x, y, z, r }`, same contract as Stage's. */
    this.platforms = [];
    /** Meshes the raycast considers. Kept small: a realm is an authored room. */
    this.propTargets = [];

    this.root = new THREE.Group();
    this.root.name = `realm:${def.id}`;
    ctx.scene.add(this.root);

    this._owned = [];               // geometry/materials this realm allocated
    this._floorMesh = null;
    this._center = new THREE.Vector3();
  }

  // --- construction ---------------------------------------------------------

  /** Register a mesh as part of the arena. `solid` puts it in the raycast set. */
  addMesh(mesh, { solid = true } = {}) {
    this.root.add(mesh);
    if (solid) this.propTargets.push(mesh);
    this._owned.push(mesh);
    return mesh;
  }

  /** A cylinder the capsule solver depenetrates against. */
  addCollider(x, z, r, y0 = -2, y1 = 20) {
    this.colliders.push({ x, z, r, y0, y1 });
  }

  addPlatform(x, y, z, r) {
    this.platforms.push({ x, y, z, r });
  }

  /**
   * The drawn floor. Kept as its own handle because the finale re-scales it
   * every phase and a second disc drawn over the first would z-fight.
   */
  setFloorMesh(mesh) {
    this._floorMesh = mesh;
    mesh.scale.setScalar(this.floorRadius);
    return mesh;
  }

  /**
   * Change the ground the player has. The drawn disc, the collision test and
   * the walkable sampler all read `floorRadius`, so they can never disagree.
   */
  setFloorRadius(r) {
    this.floorRadius = r;
    if (this._floorMesh) this._floorMesh.scale.setScalar(r);
    // Anything else the arena hung off the floor's edge — the Fracture's
    // underside and its rim band — follows the same number.
    this.onFloorRadius?.(r);
  }

  // --- stage contract -------------------------------------------------------

  /** Radial distance from the arena axis. */
  _r(x, z) {
    const dx = x - this.origin.x, dz = z - this.origin.z;
    return Math.hypot(dx, dz);
  }

  sampleHeight(x, z) {
    // Platforms are deliberately absent here, exactly as they are in Stage:
    // `sampleHeight` is the terrain, and a one-way platform is resolved by the
    // capsule solver so you can jump up through it.
    return this._r(x, z) <= this.floorRadius ? 0 : VOID_Y;
  }

  sampleNormal(x, z, out) {
    return (out || _nrm).set(0, 1, 0);
  }

  get center() { return this._center.copy(this.origin); }

  /** Deterministic player start: just inside the rim, facing the middle. */
  spawnPoint() {
    return new THREE.Vector3(
      this.origin.x + Math.cos(2.4) * (this.floorRadius - 6), 0,
      this.origin.z + Math.sin(2.4) * (this.floorRadius - 6));
  }

  isWalkable(x, z, clearance = WALK_CLEARANCE) {
    if (this._r(x, z) > this.floorRadius - 1.0) return false;
    for (const c of this.colliders) {
      if (c.y1 < 0.1) continue;
      const dx = x - c.x, dz = z - c.z;
      const rr = c.r + clearance;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }

  /**
   * Same signature and the same options as `Stage.randomWalkablePoint`, so the
   * Director and Interactables place things in a realm without a special case.
   * `maxRadius`/`minRadius` are fractions of the *floor*, not of the basin.
   */
  randomWalkablePoint(rng, opts = {}) {
    const { minDistFrom = null, minDist = 0 } = opts;
    const maxR = (opts.maxRadius ?? 0.88) * this.floorRadius;
    const minR = (opts.minRadius ?? 0) * this.floorRadius;
    const minDist2 = minDist * minDist;
    for (let i = 0; i < 60; i++) {
      const rad = Math.sqrt(minR * minR + rng.next() * (maxR * maxR - minR * minR));
      const a = rng.range(0, Math.PI * 2);
      const x = this.origin.x + Math.cos(a) * rad;
      const z = this.origin.z + Math.sin(a) * rad;
      if (!this.isWalkable(x, z)) continue;
      if (minDistFrom) {
        const dx = x - minDistFrom.x, dy = -minDistFrom.y, dz = z - minDistFrom.z;
        if (dx * dx + dy * dy + dz * dz < minDist2) continue;
      }
      return new THREE.Vector3(x, 0, z);
    }
    // The middle of an arena is walkable by construction.
    return this.origin.clone();
  }

  raycast(origin, dir, maxDist = 1000) {
    const tFloor = this._floorRay(origin, dir, maxDist);
    const prop = this._propRay(origin, dir, tFloor >= 0 ? tFloor : maxDist);
    if (prop) {
      if (prop.face) {
        _hitN.copy(prop.face.normal);
        if (prop.object.isInstancedMesh && prop.instanceId !== undefined) {
          prop.object.getMatrixAt(prop.instanceId, _mat4);
          _mat4.premultiply(prop.object.matrixWorld);
          _nmat.getNormalMatrix(_mat4);
        } else {
          _nmat.getNormalMatrix(prop.object.matrixWorld);
        }
        _hitN.applyMatrix3(_nmat).normalize();
      } else {
        _hitN.set(0, 1, 0);
      }
      return { point: prop.point.clone(), normal: _hitN.clone(), distance: prop.distance, object: prop.object };
    }
    if (tFloor < 0) return null;
    _hitP.copy(dir).multiplyScalar(tFloor).add(origin);
    return { point: _hitP.clone(), normal: new THREE.Vector3(0, 1, 0), distance: tFloor, object: this._floorMesh };
  }

  raycastDistance(origin, dir, maxDist = 1000) {
    const tFloor = this._floorRay(origin, dir, maxDist);
    const prop = this._propRay(origin, dir, tFloor >= 0 ? tFloor : maxDist);
    return prop ? prop.distance : tFloor;
  }

  /**
   * Ray vs the floor disc. Front faces only, matching Stage's terrain march: a
   * ray that starts under the floor reports nothing, which is what stops the
   * camera boom from catching on the underside of the arena.
   */
  _floorRay(origin, dir, maxDist) {
    if (dir.y >= -1e-9) return -1;
    if (origin.y <= 0) return -1;
    const t = -origin.y / dir.y;
    if (t < 0 || t > maxDist) return -1;
    const x = origin.x + dir.x * t, z = origin.z + dir.z * t;
    return this._r(x, z) <= this.floorRadius ? t : -1;
  }

  _propRay(origin, dir, far) {
    if (far <= 0 || !this.propTargets.length) return null;
    _ray.set(origin, dir);
    _ray.near = 0;
    _ray.far = far;
    _hits.length = 0;
    _ray.intersectObjects(this.propTargets, false, _hits);
    return _hits.length ? _hits[0] : null;
  }

  /**
   * Kinematic capsule sweep. Same order as Stage's — horizontal, then props,
   * then vertical — so movement feels identical inside a realm.
   *
   * The one thing that is different is the boundary: a realm is a room, so the
   * outer wall is a radial clamp rather than a heightfield, and the velocity is
   * projected onto it so sliding along a curved wall reads smoothly instead of
   * sticking.
   */
  capsuleResolve(position, radius, height, velocity, dt) {
    _pos.copy(position);
    _vel.copy(velocity);
    const startY = _pos.y;

    _pos.x += _vel.x * dt;
    _pos.z += _vel.z * dt;

    // --- outer wall: radial clamp with velocity projection ---
    const ox = _pos.x - this.origin.x, oz = _pos.z - this.origin.z;
    const limit = this.wallRadius - radius;
    const d = Math.hypot(ox, oz);
    if (d > limit && d > 1e-4) {
      const nx = ox / d, nz = oz / d;
      _pos.x = this.origin.x + nx * limit;
      _pos.z = this.origin.z + nz * limit;
      const into = _vel.x * nx + _vel.z * nz;
      if (into > 0) { _vel.x -= nx * into; _vel.z -= nz * into; }
    }

    // --- props: depenetrate horizontally, project velocity onto the wall ---
    for (let iter = 0; iter < 2; iter++) {
      let hit = false;
      for (const c of this.colliders) {
        if (_pos.y + height < c.y0 || _pos.y > c.y1) continue;
        let px = _pos.x - c.x, pz = _pos.z - c.z;
        const minD = c.r + radius;
        let dd = Math.hypot(px, pz);
        if (dd >= minD) continue;
        if (dd < 1e-4) { px = 1; pz = 0; dd = 1e-4; }
        const nx = px / dd, nz = pz / dd;
        _pos.x += nx * (minD - dd);
        _pos.z += nz * (minD - dd);
        const into = _vel.x * nx + _vel.z * nz;
        if (into < 0) { _vel.x -= nx * into; _vel.z -= nz * into; }
        hit = true;
      }
      if (!hit) break;
    }

    // --- vertical ---
    _pos.y += _vel.y * dt;
    let ground = this.sampleHeight(_pos.x, _pos.z);
    for (const p of this.platforms) {
      const dx = _pos.x - p.x, dz = _pos.z - p.z;
      if (dx * dx + dz * dz > p.r * p.r) continue;
      // One-way, exactly as Stage does it: it only catches you if you were
      // above the surface at the start of the step.
      if (startY < p.y - 0.05 || p.y <= ground) continue;
      ground = p.y;
    }

    let grounded = false;
    if (_pos.y <= ground) {
      _pos.y = ground;
      if (_vel.y < 0) _vel.y = 0;
      grounded = true;
    } else if (_vel.y <= 0 && _pos.y - ground <= SNAP_DIST) {
      _pos.y = ground;
      _vel.y = 0;
      grounded = true;
    }

    return {
      position: _pos.clone(),
      velocity: _vel.clone(),
      grounded,
      normal: new THREE.Vector3(0, 1, 0),
      slope: 1,
    };
  }

  // --- teardown -------------------------------------------------------------

  /**
   * Release the arena.
   *
   * Every geometry and material here was built for this one realm — realms are
   * rare and short, so nothing is cached across them — and all of it goes back
   * to the driver. The shared texture sets from Materials.js are *not* disposed:
   * the world stage is still standing behind us and is still using them.
   */
  dispose() {
    this.ctx.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      const m = o.material;
      if (!m) return;
      for (const mm of (Array.isArray(m) ? m : [m])) {
        if (!mm.userData.shared) mm.dispose();
      }
    });
    this.propTargets.length = 0;
    this.colliders.length = 0;
    this.platforms.length = 0;
    this._owned.length = 0;
    this._floorMesh = null;
  }
}

/** Clamp a world point back onto the realm floor. Used by the void recovery. */
export function pullToFloor(stage, position, inset = 4) {
  const dx = position.x - stage.origin.x, dz = position.z - stage.origin.z;
  const d = Math.hypot(dx, dz) || 1;
  const r = clamp(d, 0, Math.max(2, stage.floorRadius - inset));
  position.set(stage.origin.x + (dx / d) * r, 0.6, stage.origin.z + (dz / d) * r);
  return position;
}
