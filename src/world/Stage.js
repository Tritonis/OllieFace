import * as THREE from 'three';
import { Terrain, STAGE_HALF } from './TerrainGen.js';
import { Props } from './Props.js';
import { getMaterials, applyBiomeMaterials, biomeFor, stageNameFor } from './Materials.js';
import { clamp, RNG } from '../core/MathUtil.js';

/**
 * The world system: owns the terrain, the props, and every collision query the
 * rest of the game makes.
 *
 * capsuleResolve() runs for every entity every fixed step, so it never touches
 * a raycaster. Terrain is an analytic heightfield lookup; props are analytic
 * cylinders bucketed into a uniform grid.
 *
 * raycast() is split the same way: the terrain half is a march over the same
 * baked height grid sampleHeight() reads, so it never sees a triangle, and only
 * the props go through THREE.Raycaster — and then only out to the terrain hit,
 * so a ray that buries itself in a hillside does almost no prop work either.
 */

const WALK_DOT = Math.cos(THREE.MathUtils.degToRad(50)); // ~0.643
const STEP_HEIGHT = 0.62;
const SNAP_DIST = 0.42;
const SLIDE_ACCEL = 32;
const CELL = 10;

// Horizontal sweep granularity. `capsuleResolve` tests terrain at a *point*, so
// a step longer than this jumps the test clean over whatever is between here and
// there: the destination reads as a wall (and the whole velocity is deleted) or
// as clear (and the capsule lands on the far side of a prop). 0.3 m is well
// under the capsule radius, so at ordinary speeds — 10 m/s is 0.17 m a step —
// this resolves to a single pass and the solver is unchanged.
const SWEEP_STEP = 0.3;
// Ceiling on the sub-step count, so a pathological velocity costs bounded work
// rather than a frame. 16 covers 4.8 m of travel in one fixed step (288 m/s).
const SWEEP_MAX = 16;

// Safety stop for the terrain DDA. A ray can visit at most 2N+2 cells before
// leaving the grid; anything beyond that means the stepping has gone wrong.
const DDA_MAX_CELLS = 1024;

class ColliderGrid {
  constructor(half, cell) {
    this.half = half;
    this.cell = cell;
    this.dim = Math.ceil((half * 2) / cell) + 1;
    this.cells = new Array(this.dim * this.dim);
    this.items = [];
  }

  _idx(x, z) {
    const i = clamp(Math.floor((x + this.half) / this.cell), 0, this.dim - 1);
    const j = clamp(Math.floor((z + this.half) / this.cell), 0, this.dim - 1);
    return j * this.dim + i;
  }

  insert(c) {
    const id = this.items.length;
    this.items.push(c);
    const r = c.r;
    const i0 = clamp(Math.floor((c.x - r + this.half) / this.cell), 0, this.dim - 1);
    const i1 = clamp(Math.floor((c.x + r + this.half) / this.cell), 0, this.dim - 1);
    const j0 = clamp(Math.floor((c.z - r + this.half) / this.cell), 0, this.dim - 1);
    const j1 = clamp(Math.floor((c.z + r + this.half) / this.cell), 0, this.dim - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.dim + i;
        (this.cells[k] ||= []).push(id);
      }
    }
  }

  /** Fills `out` with colliders in the 3x3 cell neighbourhood of (x, z). */
  query(x, z, out) {
    out.length = 0;
    const ci = clamp(Math.floor((x + this.half) / this.cell), 0, this.dim - 1);
    const cj = clamp(Math.floor((z + this.half) / this.cell), 0, this.dim - 1);
    for (let j = cj - 1; j <= cj + 1; j++) {
      if (j < 0 || j >= this.dim) continue;
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (i < 0 || i >= this.dim) continue;
        const list = this.cells[j * this.dim + i];
        if (!list) continue;
        for (const id of list) {
          const c = this.items[id];
          if (!out.includes(c)) out.push(c);
        }
      }
    }
    return out;
  }
}

const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _mat4 = new THREE.Matrix4();
const _nmat = new THREE.Matrix3();
const _hitN = new THREE.Vector3();
const _hitP = new THREE.Vector3();
const _near = [];
const _hits = [];

/**
 * Stage generation must be a pure function of (ctx.seed, stageIndex) and must
 * never draw from ctx.rng — see NETCODE.md. The host spends the shared gameplay
 * stream on loot rolls and spawns and a client does not, so by stage 2 the two
 * stream positions have diverged; terrain taken from it would put the two
 * players on visibly different worlds. `salt` separates the independent draws
 * (terrain noise, prop placement, spawn point) within one stage.
 */
function stageSeed(seed, stageIndex, salt) {
  let s = ((seed >>> 0) ^ Math.imul(stageIndex + 1, 0x9e3779b1) ^ salt) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) || 1;
}

const SALT_TERRAIN = 0x7f4a91c3;
const SALT_PROPS = 0x2c1b5de7;
const SALT_SPAWN = 0x51ed270b;

export class Stage {
  // Owns the terrain and every collision query the game makes. A throw here
  // drops entities through the world.
  static critical = true;

  init(ctx) {
    this.ctx = ctx;
    this.half = STAGE_HALF;
    // Keep entities a little inside the cliff walls; the walls themselves are
    // unclimbable but the outermost facets are steep enough to trap a capsule.
    this.bound = STAGE_HALF - 6;

    this.stageIndex = 0;
    this.biome = null;
    this.landmarks = [];
    this.stageName = '';
    this.terrain = null;
    this.props = null;
    this.propsGroup = null;
    this.terrainMesh = null;
    this.propTargets = [];
    this.platforms = [];
    this.grid = null;
    this._center = new THREE.Vector3();

    getMaterials();
    ctx.stage = this;

    this.build(0);
  }

  /**
   * Tear down whatever stage is standing and generate stage `stageIndex`.
   *
   * This is the whole point of the system: every stage of a run is a genuinely
   * new world — new heightfield, new props, new colliders, new biome — and the
   * old one's GPU buffers go back to the driver on the way out.
   *
   * Deliberately takes no RNG argument. See stageSeed() above.
   *
   * Synchronous: the whole transition happens inside this call, which on a real
   * GPU is the several-second hitch #182 is about. It survives as the only
   * entry point that can promise "the stage is standing when I return" — the
   * capture harness, the probe tools and every test rely on exactly that — but
   * the *game* goes through `buildSteps` instead. Both drain the same generator
   * in the same order, so a stage built either way is the same stage.
   */
  build(stageIndex = 0) {
    for (const _step of this.buildSteps(stageIndex)) { /* drained in one frame */ }
    return this;
  }

  /**
   * The same build, cut into steps a caller can spend across several frames.
   *
   * Two things make this safe to stretch out, and both are structural rather
   * than a matter of who remembers to check a flag:
   *
   *  · **Nothing is installed until it is finished.** The heightfield, the
   *    prop group and the collider grid are all generated into locals; the
   *    standing stage is torn down and replaced in one synchronous block at
   *    the `commit` step. So a camera fan, an enemy's ground sample or an
   *    interactable's placement query that lands mid-build reads the *old*
   *    stage — complete and correct — and the next one reads the new one.
   *    There is no window in which a half-built stage is observable, which is
   *    a stronger promise than gating every reader could make. The price is
   *    that both stages' geometry is resident for the length of the
   *    transition; a stage is a few megabytes and the window is under a
   *    second.
   *
   *  · **The order is the order `build` always used.** The biome dressing
   *    still lands before any of the new geometry is drawn, and the probe
   *    still bakes last, off a scene that is complete. Generation reads the
   *    biome it was handed, never the shared library, so the two are
   *    genuinely independent — but the ordering is kept anyway, because the
   *    cheapest way to know an incremental build produces the identical stage
   *    is for it to be the identical sequence of statements.
   *
   * Yields a short name per step, for a driver that wants to say where it is.
   */
  *buildSteps(stageIndex = 0) {
    const ctx = this.ctx;
    const biome = biomeFor(stageIndex);

    // Retint the shared library and re-light the sky before anything is built,
    // so the terrain's first compile already sees the biome's environment. This
    // is the one step that touches state the old stage is still drawn from — it
    // will be wearing the new biome's palette for the rest of the transition,
    // which is why the driver fades out before starting.
    applyBiomeMaterials(biome);
    ctx.environment?.applyBiome?.(biome);
    yield 'dress';

    const terrain = new Terrain(stageSeed(ctx.seed, stageIndex, SALT_TERRAIN), biome);
    // The heightfield and its mesh: the single largest slice of the build, and
    // the one worth having a frame to itself.
    const terrainMesh = terrain.build();
    yield 'terrain';

    const props = new Props(
      new RNG(stageSeed(ctx.seed, stageIndex, SALT_PROPS)), terrain, biome, stageIndex);
    const propsGroup = props.build();
    yield 'props';

    const grid = new ColliderGrid(STAGE_HALF, CELL);
    const platforms = [];
    for (const c of props.colliders) {
      if (c.kind === 'platform') platforms.push(c);
      grid.insert(c);
    }

    // Vertical extent of the heightfield, used to clip rays before marching.
    let lo = Infinity, hi = -Infinity;
    for (const h of terrain.grid) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    yield 'collision';

    // --- commit: the old world ends and the new one begins, in one block ----
    this._teardown();
    this.stageIndex = stageIndex;
    this.biome = biome;
    this.stageName = stageNameFor(stageIndex);
    this.terrain = terrain;
    this.terrainMesh = terrainMesh;
    ctx.scene.add(terrainMesh);
    this.props = props;
    this.propsGroup = propsGroup;
    ctx.scene.add(propsGroup);
    // The kit's 2-3 hand-authored structures, as `{ kind, x, y, z, r }`. Read
    // by Interactables so chests and the teleporter are sited against something
    // the player can navigate by rather than sprinkled over the basin.
    this.landmarks = props.landmarks;
    this.grid = grid;
    this.platforms = platforms;
    // Raycast targets, cached: rebuilding this list per query would allocate
    // every time something aims. Terrain is deliberately not in here — it is
    // marched analytically instead (see _terrainRay).
    this.propTargets = props.meshes.slice();
    this.minY = lo;
    this.maxY = hi;
    yield 'commit';

    // The reflection probe, now that there is a stage to reflect. `applyBiome`
    // above re-lights the sky and re-bakes from it, which is what the terrain's
    // first compile needs; this is the bake that actually puts terrain, props
    // and structures into the environment map, and it can only run once they
    // exist. Its own step: it is six full renders of the scene plus a roughness
    // chain, and it is the first time the new geometry is drawn at all, so it
    // is the step most likely to be the expensive one on any given machine.
    ctx.environment?.bakeProbe?.(terrain.sampleHeight(0, 0) + 12);
    yield 'probe';
  }

  /**
   * A walkable player start on the current stage. Deterministic from
   * (seed, stageIndex) like everything else here, and biased toward the middle
   * of the basin so the teleporter and both landmarks are a walk away rather
   * than underfoot.
   */
  spawnPoint() {
    const rng = new RNG(stageSeed(this.ctx.seed, this.stageIndex, SALT_SPAWN));
    return this.randomWalkablePoint(rng, { minRadius: 0.05, maxRadius: 0.32 });
  }

  /**
   * Basin centre at ground level — what the title-screen camera orbits and the
   * one point every stage is guaranteed to have, since the basin is flat by
   * construction. Returns a shared vector; callers read it, they don't keep it.
   */
  get center() {
    return this._center.set(0, this.terrain ? this.terrain.sampleHeight(0, 0) : 0, 0);
  }

  /**
   * Release the standing stage. Every geometry here was generated for this
   * stage alone, so all of it is disposed; materials and their textures are the
   * shared library and are left in place — disposing them would force a shader
   * recompile on the next stage, which is exactly the multi-second freeze this
   * design exists to avoid.
   */
  _teardown() {
    const ctx = this.ctx;
    if (this.terrainMesh) ctx.scene.remove(this.terrainMesh);
    this.terrain?.dispose();
    if (this.propsGroup) ctx.scene.remove(this.propsGroup);
    this.props?.dispose();
    this.terrain = null;
    this.terrainMesh = null;
    this.props = null;
    this.propsGroup = null;
    this.propTargets = [];
    this.platforms = [];
    this.landmarks = [];
    this.grid = null;
  }

  // --- queries -------------------------------------------------------------

  sampleHeight(x, z) {
    return this.terrain.sampleHeight(x, z);
  }

  sampleNormal(x, z, out) {
    return this.terrain.sampleNormal(x, z, out);
  }

  raycast(origin, dir, maxDist = 1000) {
    const tTerrain = this._terrainRay(origin, dir, maxDist);
    const prop = this._propRay(origin, dir, tTerrain >= 0 ? tTerrain : maxDist);

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
      return {
        point: prop.point.clone(),
        normal: _hitN.clone(),
        distance: prop.distance,
        object: prop.object,
      };
    }

    if (tTerrain < 0) return null;
    _hitP.copy(dir).multiplyScalar(tTerrain).add(origin);
    return {
      point: _hitP.clone(),
      normal: this._terrainNormal(_hitP.x, _hitP.z, _hitN).clone(),
      distance: tTerrain,
      object: this.terrainMesh,
    };
  }

  /**
   * Distance to the first obstruction, or -1. Same query as raycast() without
   * the result object — the camera runs a fan of these every frame and cannot
   * afford the two Vector3 clones per ray.
   */
  raycastDistance(origin, dir, maxDist = 1000) {
    const tTerrain = this._terrainRay(origin, dir, maxDist);
    const prop = this._propRay(origin, dir, tTerrain >= 0 ? tTerrain : maxDist);
    return prop ? prop.distance : tTerrain;
  }

  /** Nearest prop intersection within `far`, or null. */
  _propRay(origin, dir, far) {
    if (far <= 0) return null;
    _ray.set(origin, dir);
    _ray.near = 0;
    _ray.far = far;
    _hits.length = 0;
    _ray.intersectObjects(this.propTargets, false, _hits);
    return _hits.length ? _hits[0] : null;
  }

  /**
   * Ray vs the terrain heightfield. Returns the hit distance, or -1.
   *
   * The surface is piecewise linear over the same baked grid sampleHeight()
   * reads, so this walks the ray cell by cell with a 2D DDA and solves the
   * crossing inside each cell in closed form — no stepping, no bisection, and
   * no chance of skimming over a one-facet crest. Exact to the drawn mesh, and
   * a camera boom touches four or five cells instead of 51k triangles.
   *
   * Front faces only, matching the raycaster it replaces: a ray that starts
   * underground reports nothing.
   */
  _terrainRay(origin, dir, maxDist) {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    const half = this.half;

    // Clip to the heightfield's box first. Outside it sampleHeight() clamps to
    // the edge row, so marching there would invent ground that isn't drawn.
    let t0 = 0, t1 = maxDist;
    if (dx > 1e-9 || dx < -1e-9) {
      let a = (-half - ox) / dx, b = (half - ox) / dx;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    } else if (ox < -half || ox > half) return -1;
    if (dz > 1e-9 || dz < -1e-9) {
      let a = (-half - oz) / dz, b = (half - oz) / dz;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    } else if (oz < -half || oz > half) return -1;
    if (dy > 1e-9 || dy < -1e-9) {
      let a = (this.minY - 1e-3 - oy) / dy, b = (this.maxY + 1e-3 - oy) / dy;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    } else if (oy < this.minY - 1e-3 || oy > this.maxY + 1e-3) return -1;
    if (t1 <= t0) return -1;

    // Grid space: one unit per cell, so the DDA boundaries are integers.
    const T = this.terrain;
    const N = T.segments, cs = T.step, g = T.grid, row = N + 1;
    const gx = (ox + half) / cs, gz = (oz + half) / cs;
    const gdx = dx / cs, gdz = dz / cs;

    let i = clamp(Math.floor(gx + gdx * t0), 0, N - 1);
    let j = clamp(Math.floor(gz + gdz * t0), 0, N - 1);
    const stepI = gdx >= 0 ? 1 : -1;
    const stepJ = gdz >= 0 ? 1 : -1;
    const dtI = gdx !== 0 ? Math.abs(1 / gdx) : Infinity;
    const dtJ = gdz !== 0 ? Math.abs(1 / gdz) : Infinity;
    let tNextI = gdx !== 0 ? ((gdx > 0 ? i + 1 : i) - gx) / gdx : Infinity;
    let tNextJ = gdz !== 0 ? ((gdz > 0 ? j + 1 : j) - gz) / gdz : Infinity;

    let t = t0;
    for (let c = 0; c < DDA_MAX_CELLS && t < t1; c++) {
      const tOut = Math.min(tNextI, tNextJ, t1);
      if (tOut > t) {
        const hA = g[j * row + i];
        const hB = g[j * row + i + 1];
        const hC = g[(j + 1) * row + i + 1];
        const hD = g[(j + 1) * row + i];
        // The cell's two triangles meet on u + v = 1, which the ray crosses at
        // most once, so the span inside the cell splits into at most two pieces
        // that each lie on a single plane.
        const sc = gx - i + gz - j - 1;
        const sm = gdx + gdz;
        let tMid = -1;
        if (sm !== 0) {
          const ts = -sc / sm;
          if (ts > t && ts < tOut) tMid = ts;
        }
        const a0 = t, b0 = tMid >= 0 ? tMid : tOut;
        const hit = this._cellHit(i, j, a0, b0, hA, hB, hC, hD, gx, gz, gdx, gdz, oy, dy, sc, sm);
        if (hit >= 0) return hit;
        if (tMid >= 0) {
          const hit2 = this._cellHit(i, j, tMid, tOut, hA, hB, hC, hD, gx, gz, gdx, gdz, oy, dy, sc, sm);
          if (hit2 >= 0) return hit2;
        }
      }
      t = tOut;
      if (t >= t1) break;
      if (tNextI <= tNextJ) { i += stepI; tNextI += dtI; } else { j += stepJ; tNextJ += dtJ; }
      if (i < 0 || i >= N || j < 0 || j >= N) break;
    }
    return -1;
  }

  /**
   * Solve the ray against one of a cell's two triangle planes over [ta, tb].
   * Height is linear in t there, so the crossing is a single division.
   *
   * Only a downward crossing counts, which is what makes this front-face-only
   * like the raycaster it replaces: a ray that is already under the surface
   * reports nothing until it has come back out and gone in again.
   */
  _cellHit(i, j, ta, tb, hA, hB, hC, hD, gx, gz, gdx, gdz, oy, dy, sc, sm) {
    if (tb <= ta) return -1;
    // Which side of the diagonal this piece is on, sampled at its midpoint.
    const lower = sc + sm * (ta + tb) * 0.5 <= 0;
    const u0 = gx - i, v0 = gz - j;
    let m, k;
    if (lower) {                       // triangle (A, D, B)
      m = dy - gdx * (hB - hA) - gdz * (hD - hA);
      k = oy - hA - u0 * (hB - hA) - v0 * (hD - hA);
    } else {                           // triangle (B, D, C)
      m = dy + gdx * (hD - hC) + gdz * (hB - hC);
      k = oy - hC - (1 - u0) * (hD - hC) - (1 - v0) * (hB - hC);
    }
    const fa = k + m * ta;
    if (fa <= 0) return -1;
    const fb = k + m * tb;
    if (fb > 0) return -1;
    return ta + (tb - ta) * (fa / (fa - fb));
  }

  /**
   * Face normal of the terrain triangle containing (x, z) — the same split
   * sampleHeight() uses, so it is the normal of the drawn facet rather than the
   * smoothed one sampleNormal() returns.
   */
  _terrainNormal(x, z, out) {
    const T = this.terrain;
    const N = T.segments, half = T.half, step = T.step, g = T.grid;
    const i = clamp(Math.floor((x + half) / step), 0, N - 1);
    const j = clamp(Math.floor((z + half) / step), 0, N - 1);
    const u = clamp((x + half) / step - i, 0, 1);
    const v = clamp((z + half) / step - j, 0, 1);
    const row = N + 1;
    const hA = g[j * row + i];
    const hB = g[j * row + i + 1];
    const hC = g[(j + 1) * row + i + 1];
    const hD = g[(j + 1) * row + i];
    let du, dv;
    if (u + v <= 1) { du = hB - hA; dv = hD - hA; }
    else { du = hC - hD; dv = hC - hB; }
    return out.set(-du, step, -dv).normalize();
  }

  /** True if (x, z) is gentle enough to stand on and clear of prop volumes. */
  isWalkable(x, z, clearance = 0.6) {
    if (Math.abs(x) > this.bound || Math.abs(z) > this.bound) return false;
    if (this.terrain.slopeDot(x, z) < WALK_DOT) return false;
    const y = this.terrain.sampleHeight(x, z);
    this.grid.query(x, z, _near);
    for (const c of _near) {
      if (c.kind !== 'cyl') continue;
      if (y + 1.5 < c.y0 || y > c.y1) continue;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < (c.r + clearance) * (c.r + clearance)) return false;
    }
    return true;
  }

  randomWalkablePoint(rng, opts = {}) {
    const { minDistFrom = null, minDist = 0 } = opts;
    const maxR = (opts.maxRadius ?? 0.66) * this.half;
    const minR = (opts.minRadius ?? 0) * this.half;
    const minDist2 = minDist * minDist;
    for (let i = 0; i < 80; i++) {
      const rad = Math.sqrt(minR * minR + rng.next() * (maxR * maxR - minR * minR));
      const a = rng.range(0, Math.PI * 2);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (!this.isWalkable(x, z)) continue;
      const y = this.terrain.sampleHeight(x, z);
      if (minDistFrom) {
        const dx = x - minDistFrom.x, dy = y - minDistFrom.y, dz = z - minDistFrom.z;
        if (dx * dx + dy * dy + dz * dz < minDist2) continue;
      }
      return new THREE.Vector3(x, y, z);
    }
    // Fallback: the basin centre is flat by construction.
    return new THREE.Vector3(0, this.terrain.sampleHeight(0, 0), 0);
  }

  // --- movement ------------------------------------------------------------

  /**
   * Kinematic capsule sweep. `position` is the capsule's *base* (feet), matching
   * the eye-height convention in CONTRACTS.md.
   *
   * Order is horizontal-then-vertical on purpose: resolving vertically first
   * makes a capsule walking into a ramp pop upward before it has moved, which
   * is the classic source of stair jitter.
   */
  capsuleResolve(position, radius, height, velocity, dt) {
    const T = this.terrain;
    _pos.copy(position);
    _vel.copy(velocity);

    const startY = _pos.y;
    const dx = _vel.x * dt;
    const dz = _vel.z * dt;

    /*
     * The horizontal half is swept in sub-steps rather than taken as one
     * teleport. Both terrain and props are tested at a single destination point,
     * which is correct only while the destination is close enough to stand in
     * for the path: a 10 m/s walk covers 0.17 m a step and it is. A jump impulse
     * does not. At 40 m/s the step is 0.67 m and at 110 m/s it is 1.84 m, and
     * over that distance the destination test answers a different question from
     * the one the solver is asking — it deleted the whole velocity because the
     * far end of the leap happened to land on a rise (`_climbable` fails, both
     * components zeroed, launch gone), and it let the capsule land past a thin
     * prop entirely, so the depenetration pass never saw it.
     *
     * `n` is 1 for every ordinary velocity in the game, so this is the same
     * single pass it has always been unless something is genuinely moving fast.
     */
    const n = Math.min(SWEEP_MAX, Math.max(1, Math.ceil(Math.hypot(dx, dz) / SWEEP_STEP)));

    /*
     * `_climbable` is a *walking* test — "could this capsule step up onto that,
     * and is the face it would step onto shallow enough to walk". Applied to a
     * body in the air it asks the wrong question and answers it destructively:
     * a jump passing over ground that rises at all, at more than the walk slope,
     * fails the test, no axis is free, and both horizontal components are set to
     * zero. The launch is deleted in mid-flight, over ground the player is
     * metres above and never touches.
     *
     * Airborne, the only thing that can stop a horizontal move is terrain that
     * is actually in the way — above the capsule's feet. How steep it is and
     * whether it could have been walked up are questions for a body on the
     * ground, and this one is not on the ground.
     */
    // Rising counts as airborne too. Horizontal is resolved before vertical, so
    // on the very step a jump is taken the capsule's feet are still at ground
    // height — and that is the longest step of the whole launch, the one the
    // walking test was deleting outright.
    const airborne = _vel.y > 0 || startY > T.sampleHeight(_pos.x, _pos.z) + SNAP_DIST;
    const clear = airborne
      ? (x, z) => this._airClear(x, z, startY)
      : (x, z) => this._climbable(x, z, startY);

    for (let step = 0; step < n; step++) {
      // Read the velocity fresh each sub-step: a wall hit in an earlier one has
      // already projected it, and the rest of the move must follow that.
      const sx = _vel.x * dt / n, sz = _vel.z * dt / n;

      // --- terrain: full move, else slide along whichever axis is free ---
      if (sx !== 0 || sz !== 0) {
        const tx = _pos.x + sx, tz = _pos.z + sz;
        if (clear(tx, tz)) {
          _pos.x = tx; _pos.z = tz;
        } else {
          let moved = false;
          if (sx !== 0 && clear(_pos.x + sx, _pos.z)) {
            _pos.x += sx; moved = true;
          } else {
            _vel.x = 0;
          }
          if (sz !== 0 && clear(_pos.x, _pos.z + sz)) {
            _pos.z += sz; moved = true;
          } else {
            _vel.z = 0;
          }
          if (!moved) { _vel.x = 0; _vel.z = 0; }
        }
      }

      _pos.x = clamp(_pos.x, -this.bound, this.bound);
      _pos.z = clamp(_pos.z, -this.bound, this.bound);

      // --- props: depenetrate horizontally, project velocity onto the wall ---
      this.grid.query(_pos.x, _pos.z, _near);
      for (let iter = 0; iter < 2; iter++) {
        let hit = false;
        for (const c of _near) {
          if (c.kind !== 'cyl') continue;
          // Capsule vertical span vs cylinder span.
          if (_pos.y + height < c.y0 || _pos.y > c.y1) continue;
          let ox = _pos.x - c.x, oz = _pos.z - c.z;
          const minD = c.r + radius;
          let d = Math.hypot(ox, oz);
          if (d >= minD) continue;
          if (d < 1e-4) { ox = 1; oz = 0; d = 1e-4; }
          const nx = ox / d, nz = oz / d;
          const push = minD - d;
          _pos.x += nx * push;
          _pos.z += nz * push;
          const into = _vel.x * nx + _vel.z * nz;
          if (into < 0) { _vel.x -= nx * into; _vel.z -= nz * into; }
          hit = true;
        }
        if (!hit) break;
      }
    }

    // --- vertical ---
    _pos.y += _vel.y * dt;

    let ground = T.sampleHeight(_pos.x, _pos.z);
    let onPlatform = false;
    for (const c of _near) {
      if (c.kind !== 'platform') continue;
      const dx2 = _pos.x - c.x, dz2 = _pos.z - c.z;
      if (dx2 * dx2 + dz2 * dz2 > c.r * c.r) continue;
      // One-way: only catches you if you were above the surface last step.
      if (startY < c.y - 0.05 || c.y <= ground) continue;
      ground = c.y;
      onPlatform = true;
    }

    let grounded = false;
    if (_pos.y <= ground) {
      _pos.y = ground;
      if (_vel.y < 0) _vel.y = 0;
      grounded = true;
    } else if (_vel.y <= 0 && _pos.y - ground <= SNAP_DIST) {
      // Stick to downhill ground and to terrace lips instead of launching.
      _pos.y = ground;
      _vel.y = 0;
      grounded = true;
    }

    if (onPlatform) {
      _nrm.set(0, 1, 0);
    } else {
      T.sampleNormal(_pos.x, _pos.z, _nrm);
    }

    // --- slide off anything steeper than the walkable limit ---
    if (grounded && !onPlatform && _nrm.y < WALK_DOT) {
      const steep = (WALK_DOT - _nrm.y) / WALK_DOT;
      _vel.x += _nrm.x * SLIDE_ACCEL * steep * dt;
      _vel.z += _nrm.z * SLIDE_ACCEL * steep * dt;
    }

    // Fresh vectors, not the scratch temporaries: callers that stash the result
    // (`this.position = r.position`) are common and would otherwise alias.
    return {
      position: _pos.clone(),
      velocity: _vel.clone(),
      grounded,
      normal: _nrm.clone(),
      slope: _nrm.y,
    };
  }

  /**
   * Can a capsule at `fromY` enter (x, z)? Anything that would need more than a
   * step-up of climb is a wall. Steep-but-shallow ground is allowed through and
   * handled by the slide force, so walls feel solid but ramps stay smooth.
   */
  _climbable(x, z, fromY) {
    if (Math.abs(x) > this.bound || Math.abs(z) > this.bound) return false;
    const h = this.terrain.sampleHeight(x, z);
    if (h - fromY > STEP_HEIGHT) return false;
    // A long unbroken 65° face rises less than a step per tick, so the step-up
    // test alone lets you walk straight up the cliff walls. Ascending into
    // ground steeper than the walk limit is a wall regardless of rise rate.
    if (h > fromY + 0.01 && this.terrain.slopeDot(x, z) < WALK_DOT) return false;
    return true;
  }

  /**
   * The airborne counterpart of `_climbable`. A body off the ground cannot
   * "step up" onto anything and does not care how steep the ground it is flying
   * over is; the only terrain that can stop it is terrain that is genuinely in
   * the way. Same step-up allowance so that a landing on a low lip is a landing
   * rather than a wall, and the same bound check.
   */
  _airClear(x, z, fromY) {
    if (Math.abs(x) > this.bound || Math.abs(z) > this.bound) return false;
    return this.terrain.sampleHeight(x, z) - fromY <= STEP_HEIGHT;
  }

  dispose() {
    this._teardown();
  }
}
