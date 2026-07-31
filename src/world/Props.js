import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BIOMES, getMaterials } from './Materials.js';
import { makeSimplex2D, STAGE_HALF } from './TerrainGen.js';
import { lerp } from '../core/MathUtil.js';

/**
 * Procedural set dressing. Everything here is either an InstancedMesh (scatter)
 * or one of a handful of hand-placed hero silhouettes.
 *
 * Colliders are emitted alongside the visuals as cheap analytic volumes —
 * vertical cylinders for anything you walk into, one-way discs for the tops of
 * floating islands. Stage.js buckets them into a uniform grid; nothing here
 * ever gets raycast for movement.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// --- geometry helpers ------------------------------------------------------

function makeNoise3(rng) {
  const a = makeSimplex2D((rng.next() * 0xffffffff) >>> 0);
  const b = makeSimplex2D((rng.next() * 0xffffffff) >>> 0);
  return (x, y, z) => (a(x, y) + b(y, z) + a(z + 7.1, x - 3.3)) / 3;
}

// Displace along the smooth normal while still indexed, so the shell stays
// watertight; facet it afterwards.
function deform(geo, noise3, amp, freq, off = 0) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = noise3(x * freq + off, y * freq, z * freq) * amp;
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  p.needsUpdate = true;
  return geo;
}

/**
 * Box-projected UVs. Sphere/torus UVs put a visible seam and a pole pinch on
 * every deformed rock; triplanar-style box projection has neither.
 */
function boxProjectUV(geo, scale = 0.35) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= az) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

const flat = (g) => (g.index ? g.toNonIndexed() : g);

function facet(geo, uvScale = 0.35) {
  const g = flat(geo);
  g.computeVertexNormals();
  boxProjectUV(g, uvScale);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// --- prop geometry ---------------------------------------------------------

function boulderGeo(rng, noise3) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  deform(g, noise3, rng.range(0.22, 0.42), rng.range(0.7, 1.4), rng.range(0, 40));
  // Squash so boulders sit rather than float — a sphere reads as a ball.
  g.scale(rng.range(0.85, 1.3), rng.range(0.55, 0.85), rng.range(0.85, 1.3));
  return facet(g, 0.5);
}

function pillarGeo(rng, noise3) {
  const g = new THREE.CylinderGeometry(0.62, 0.82, 1, 7, 5);
  deform(g, noise3, 0.07, 2.6, rng.range(0, 40));
  // Break the top: push the upper rings down unevenly so it reads as snapped.
  const p = g.attributes.position;
  const phase = rng.range(0, Math.PI * 2);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > 0.2) {
      const a = Math.atan2(p.getZ(i), p.getX(i));
      const t = (y - 0.2) / 0.3;
      p.setY(i, y - t * (0.18 + 0.22 * (Math.sin(a * 2 + phase) * 0.5 + 0.5)));
    }
  }
  p.needsUpdate = true;
  return facet(g, 0.6);
}

function archGeo(rng, noise3) {
  // Torus arc of PI in the XY plane is already a standing arch.
  const span = new THREE.TorusGeometry(1, 0.17, 5, 16, Math.PI);
  deform(span, noise3, 0.05, 3.0, rng.range(0, 40));
  const legL = new THREE.CylinderGeometry(0.2, 0.26, 0.5, 6);
  legL.translate(-1, -0.25, 0);
  const legR = new THREE.CylinderGeometry(0.2, 0.26, 0.5, 6);
  legR.translate(1, -0.25, 0);
  const merged = mergeGeometries(
    [flat(span), flat(legL), flat(legR)], false
  );
  span.dispose(); legL.dispose(); legR.dispose();
  merged.translate(0, 0.5, 0); // origin at ground level
  return facet(merged, 0.5);
}

function deadTreeGeo(rng, noise3) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.07, 0.19, 3.2, 6, 4);
  deform(trunk, noise3, 0.05, 2.0, rng.range(0, 40));
  trunk.translate(0, 1.6, 0);
  parts.push(flat(trunk));

  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const len = rng.range(0.9, 1.9);
    const b = new THREE.CylinderGeometry(0.025, 0.075, len, 5);
    b.translate(0, len * 0.5, 0);
    _e.set(rng.range(0.5, 1.15), rng.range(0, Math.PI * 2), 0, 'YXZ');
    // Rotate about Z for the lean, then Y for the azimuth.
    const m = new THREE.Matrix4().makeRotationZ(_e.x);
    m.premultiply(new THREE.Matrix4().makeRotationY(_e.y));
    m.setPosition(0, rng.range(1.5, 2.8), 0);
    b.applyMatrix4(m);
    parts.push(flat(b));
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return facet(merged, 0.8);
}

function crystalGeo(rng, noise3) {
  const parts = [];
  const n = rng.int(3, 6);
  for (let i = 0; i < n; i++) {
    const c = new THREE.OctahedronGeometry(1, 0);
    c.scale(rng.range(0.14, 0.3), rng.range(0.7, 1.7), rng.range(0.14, 0.3));
    const m = new THREE.Matrix4().makeRotationZ(rng.range(-0.42, 0.42));
    m.premultiply(new THREE.Matrix4().makeRotationY(rng.range(0, Math.PI * 2)));
    m.setPosition(rng.range(-0.34, 0.34), rng.range(0.35, 0.8), rng.range(-0.34, 0.34));
    c.applyMatrix4(m);
    parts.push(flat(c));
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return facet(merged, 0.6);
}

/**
 * Chew and tilt the top cap. Every island having a perfectly flat, perfectly
 * level lid is most of what makes fifteen of them read as one repeated mesh.
 */
function breakTop(geo, rng, amt) {
  const p = geo.attributes.position;
  const ph = rng.range(0, Math.PI * 2);
  const tx = rng.range(-0.13, 0.13), tz = rng.range(-0.13, 0.13);
  let maxY = -Infinity;
  for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < maxY - 1e-3) continue;
    const x = p.getX(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    // Same function of (x, z) for the cap ring and the wall's top ring, so the
    // shell stays closed.
    p.setY(i, y + x * tx + z * tz +
      (Math.sin(a * 3.0 + ph) * 0.6 + Math.sin(a * 5.0 - ph * 1.7) * 0.4) * amt);
  }
  p.needsUpdate = true;
  return geo;
}

// --- floating-island silhouette families -----------------------------------
// Three genuinely different forms, not three sizes of one form. Note the low
// UV scale on all of them: these get scaled to 4-10u, and at 0.4 the stone
// texture tiled a dozen times across a single island, which is what made the
// dark one read as high-frequency noise from a different scene.

/** Wide shelf over a short keel — the reachable-platform read. */
function islandDiscGeo(rng, noise3) {
  const top = new THREE.CylinderGeometry(1, 0.94, 0.55, 9, 2);
  deform(top, noise3, 0.09, 1.6, rng.range(0, 40));
  const keel = new THREE.ConeGeometry(0.93, 2.6, 9, 3);
  keel.rotateX(Math.PI);
  keel.translate(0, -1.55, 0);
  deform(keel, noise3, 0.16, 1.1, rng.range(0, 40));
  const merged = mergeGeometries([flat(top), flat(keel)], false);
  top.dispose(); keel.dispose();
  return facet(breakTop(merged, rng, 0.26), 0.12);
}

/** Stepped, elongated plateau — horizontal mass, reads as strata. */
function islandSlabGeo(rng, noise3) {
  const a = new THREE.CylinderGeometry(1.0, 0.86, 0.42, 6, 1);
  a.scale(1.25, 1, 0.7);
  const b = new THREE.CylinderGeometry(0.72, 0.58, 0.5, 6, 1);
  b.scale(1.2, 1, 0.72);
  b.translate(rng.range(-0.3, 0.3), 0.44, rng.range(-0.2, 0.2));
  const keel = new THREE.CylinderGeometry(0.8, 0.16, 1.5, 6, 2);
  keel.scale(1.2, 1, 0.72);
  keel.translate(0, -0.92, 0);
  deform(keel, noise3, 0.14, 1.3, rng.range(0, 40));
  const merged = mergeGeometries([flat(a), flat(b), flat(keel)], false);
  a.dispose(); b.dispose(); keel.dispose();
  return facet(breakTop(merged, rng, 0.18), 0.12);
}

/** Narrow deep shard — vertical mass, reads as a torn-out spire. */
function islandSpireGeo(rng, noise3) {
  const top = new THREE.CylinderGeometry(0.55, 0.5, 0.7, 5, 1);
  const body = new THREE.ConeGeometry(0.52, 4.4, 5, 4);
  body.rotateX(Math.PI);
  body.translate(0, -2.1, 0);
  deform(body, noise3, 0.22, 0.8, rng.range(0, 40));
  const merged = mergeGeometries([flat(top), flat(body)], false);
  top.dispose(); body.dispose();
  return facet(breakTop(merged, rng, 0.32), 0.16);
}

// Per-family placement: local top-face height, platform radius, and the
// height/width aspect range that makes each family read as its own form.
const ISLAND_FAMILIES = [
  { top: 0.275, rad: 0.85, aspect: [0.75, 1.25] },
  { top: 0.690, rad: 0.90, aspect: [0.45, 0.75] },
  { top: 0.350, rad: 0.46, aspect: [1.35, 2.10] },
];

function debrisGeo(rng, noise3) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  deform(g, noise3, 0.34, 1.8, rng.range(0, 40));
  g.scale(rng.range(0.6, 1.2), rng.range(0.6, 1.4), rng.range(0.6, 1.2));
  return facet(g, 0.8);
}

function monolithGeo(rng, noise3) {
  const g = new THREE.BoxGeometry(1, 1, 1, 3, 10, 3);
  deform(g, noise3, 0.055, 2.4, rng.range(0, 40));
  // Taper toward the top so the silhouette has direction.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) + 0.5;
    const k = lerp(1.0, 0.62, t);
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  p.needsUpdate = true;
  return facet(g, 0.25);
}

// --- placement -------------------------------------------------------------

export class Props {
  /**
   * @param {RNG}    rng      stage-local stream, derived from (seed, stageIndex)
   * @param {Terrain} terrain the freshly built heightfield to sit on
   * @param {object} biome    entry from BIOMES; supplies the prop mix
   */
  constructor(rng, terrain, biome = BIOMES[0], stageIndex = 0) {
    this.rng = rng;
    this.terrain = terrain;
    this.biome = biome;
    this.stageIndex = stageIndex;
    // Every biome drives the *same* nine materials with different counts and
    // colours. Nothing here may introduce a material the others don't use, or
    // the program count would step at a stage transition.
    this.P = biome.props;
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.colliders = [];
    this.meshes = [];
    this._geos = [];
  }

  _collider(x, z, r, y0, y1) {
    this.colliders.push({ kind: 'cyl', x, z, r, y0, y1 });
  }

  _platform(x, z, r, y) {
    this.colliders.push({ kind: 'platform', x, z, r, y });
  }

  /** Rejection sampling for a spot that satisfies slope / radius constraints. */
  _spot({ rMin = 0, rMax = 0.66, minDot = 0.7, tries = 30 }) {
    const rng = this.rng, T = this.terrain, H = STAGE_HALF;
    for (let i = 0; i < tries; i++) {
      // sqrt keeps the distribution area-uniform instead of centre-heavy.
      const rad = Math.sqrt(lerp(rMin * rMin, rMax * rMax, rng.next())) * H;
      const a = rng.range(0, Math.PI * 2);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (T.slopeDot(x, z) < minDot) continue;
      return { x, z, y: T.sampleHeight(x, z) };
    }
    return null;
  }

  _batch(variants, material, count, place) {
    const lists = variants.map(() => []);
    for (let i = 0; i < count; i++) {
      const vi = this.rng.int(0, variants.length - 1);
      const m = place(this.rng);
      if (m) lists[vi].push(m);
    }
    variants.forEach((geo, vi) => {
      const list = lists[vi];
      if (!list.length) { geo.dispose(); return; }
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((mat, i) => im.setMatrixAt(i, mat));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false; // one instanced mesh spans the whole stage
      this.group.add(im);
      this.meshes.push(im);
      this._geos.push(geo);
    });
  }

  build() {
    const rng = this.rng;
    const T = this.terrain;
    const M = getMaterials();
    const P = this.P;
    const n3 = makeNoise3(rng);

    // --- boulders: the connective tissue, everywhere, including slopes ---
    this._batch(
      [boulderGeo(rng, n3), boulderGeo(rng, n3), boulderGeo(rng, n3)],
      M.rock, P.boulders,
      (r) => {
        const s = this._spot({ rMax: 0.8, minDot: 0.45 });
        if (!s) return null;
        const sc = r.range(P.boulderScale[0], P.boulderScale[1]);
        // Sink a fraction of the radius so nothing hovers on uneven facets.
        _v.set(s.x, s.y - sc * 0.28, s.z);
        _q.setFromEuler(_e.set(r.range(-0.2, 0.2), r.range(0, 6.283), r.range(-0.2, 0.2)));
        _s.setScalar(sc);
        if (sc > 1.5) this._collider(s.x, s.z, sc * 0.85, s.y - 1, s.y + sc * 0.9);
        return _m.compose(_v, _q, _s).clone();
      }
    );

    // --- shattered pillars: vertical accents, only on ground you could stand on ---
    this._batch(
      [pillarGeo(rng, n3), pillarGeo(rng, n3)],
      M.cliff, P.pillars,
      (r) => {
        const s = this._spot({ rMin: 0.08, rMax: 0.62, minDot: 0.82 });
        if (!s) return null;
        const h = r.range(P.pillarHeight[0], P.pillarHeight[1]);
        const rad = r.range(0.5, 1.05);
        _v.set(s.x, s.y - 0.4, s.z);
        _q.setFromEuler(_e.set(r.range(-0.09, 0.09), r.range(0, 6.283), r.range(-0.09, 0.09)));
        _s.set(rad, h, rad);
        this._collider(s.x, s.z, rad * 0.8, s.y - 1, s.y + h);
        return _m.compose(_v, _q, _s).clone();
      }
    );

    // --- small arches: read as ruined structure at mid distance ---
    this._batch(
      [archGeo(rng, n3)],
      M.cliff, P.arches,
      (r) => {
        const s = this._spot({ rMin: 0.12, rMax: 0.6, minDot: 0.9 });
        if (!s) return null;
        const sc = r.range(P.archScale[0], P.archScale[1]);
        _v.set(s.x, s.y - 0.25, s.z);
        _q.setFromEuler(_e.set(0, r.range(0, 6.283), 0));
        _s.setScalar(sc);
        // Only the legs block; the span is overhead.
        this._collider(s.x, s.z, sc * 0.35, s.y - 1, s.y + sc * 0.5);
        return _m.compose(_v, _q, _s).clone();
      }
    );

    // --- dead trees: thin high-frequency silhouettes against the sky ---
    this._batch(
      [deadTreeGeo(rng, n3), deadTreeGeo(rng, n3)],
      M.wood, P.trees,
      (r) => {
        const s = this._spot({ rMin: 0.06, rMax: 0.66, minDot: 0.86 });
        if (!s) return null;
        const sc = r.range(P.treeScale[0], P.treeScale[1]);
        _v.set(s.x, s.y - 0.15, s.z);
        _q.setFromEuler(_e.set(0, r.range(0, 6.283), 0));
        _s.set(sc * r.range(0.85, 1.15), sc, sc * r.range(0.85, 1.15));
        this._collider(s.x, s.z, 0.35, s.y - 1, s.y + 3.2 * sc);
        return _m.compose(_v, _q, _s).clone();
      }
    );

    // --- crystals: the one cool self-lit accent, placed as a handful of
    //     clusters rather than as scatter. Sixty of them spread evenly over the
    //     basin read as confetti — an accent has to be somewhere to function as
    //     a focal point and as something to navigate by ---
    {
      const variants = [crystalGeo(rng, n3), crystalGeo(rng, n3)];
      const lists = [[], []];
      for (let c = 0; c < P.crystalClusters; c++) {
        const s = this._spot({ rMin: 0.14, rMax: 0.7, minDot: 0.7 });
        if (!s) continue;
        const n = rng.int(P.crystalPer[0], P.crystalPer[1]);
        for (let i = 0; i < n; i++) {
          const a = rng.range(0, 6.283);
          // sqrt again: without it every cluster is a ring.
          const r = Math.sqrt(rng.next()) * 5.5;
          const px = s.x + Math.cos(a) * r, pz = s.z + Math.sin(a) * r;
          // Big in the middle, small at the fringe, so a cluster has a peak.
          const sc = rng.range(P.crystalScale[0], P.crystalScale[1]) * (1 - r / 9);
          _v.set(px, T.sampleHeight(px, pz) - sc * 0.15, pz);
          _q.setFromEuler(_e.set(rng.range(-0.25, 0.25), rng.range(0, 6.283), rng.range(-0.25, 0.25)));
          _s.setScalar(sc);
          lists[rng.int(0, 1)].push(_m.compose(_v, _q, _s).clone());
        }
      }
      this._addInstanced(variants[0], M.crystal, lists[0]);
      this._addInstanced(variants[1], M.crystal, lists[1]);
    }

    this._buildFloatingIslands(n3);
    this._buildHeroes(n3);

    return this.group;
  }

  /**
   * Floating shelves sit above the play area with a one-way disc collider on
   * top, so they contribute verticality you can actually land on rather than
   * being pure backdrop.
   */
  _buildFloatingIslands(n3) {
    const rng = this.rng, T = this.terrain, M = getMaterials();
    const islandVariants = [
      islandDiscGeo(rng, n3), islandSlabGeo(rng, n3), islandSpireGeo(rng, n3),
    ];
    const debrisVariants = [debrisGeo(rng, n3)];
    // All three families share one material. Splitting them across `rock` and
    // `cliff` put one near-black island next to mid-value neighbours at the
    // same depth, which read as an asset from a different scene.
    const islandMats = [[], [], []];
    const debrisMats = [];

    const P = this.P;
    const COUNT = P.islands;
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const rad = rng.range(0.18, 0.72) * STAGE_HALF;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const ground = T.sampleHeight(x, z);
      const scale = rng.range(P.islandScale[0], P.islandScale[1]);
      // Low ones are reachable platforms, high ones are composition.
      const y = ground + (i % 3 === 0
        ? rng.range(P.islandLow[0], P.islandLow[1])
        : rng.range(P.islandHigh[0], P.islandHigh[1]));

      const fi = rng.int(0, ISLAND_FAMILIES.length - 1);
      const F = ISLAND_FAMILIES[fi];

      _v.set(x, y, z);
      _q.setFromEuler(_e.set(rng.range(-0.08, 0.08), rng.range(0, 6.283), rng.range(-0.08, 0.08)));
      _s.set(scale, scale * rng.range(F.aspect[0], F.aspect[1]), scale);
      islandMats[fi].push(_m.compose(_v, _q, _s).clone());
      this._platform(x, z, scale * F.rad, y + _s.y * F.top);

      // Hanging debris trailing off the keel sells the "torn loose" read.
      const debrisCount = rng.int(3, 6);
      for (let d = 0; d < debrisCount; d++) {
        const da = rng.range(0, 6.283);
        const dr = rng.range(0.2, 1.1) * scale;
        const ds = rng.range(0.35, 1.4);
        _v.set(x + Math.cos(da) * dr, y - rng.range(2, 9) * (scale / 6), z + Math.sin(da) * dr);
        _q.setFromEuler(_e.set(rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)));
        _s.setScalar(ds);
        debrisMats.push(_m.compose(_v, _q, _s).clone());
      }
    }

    islandVariants.forEach((geo, i) => this._addInstanced(geo, M.rock, islandMats[i]));
    this._addInstanced(debrisVariants[0], M.rock, debrisMats);
  }

  _addInstanced(geo, material, list) {
    if (!list.length) { geo.dispose(); return; }
    const im = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    this.group.add(im);
    this.meshes.push(im);
    this._geos.push(geo);
  }

  /**
   * Hand-placed landmarks. Placed by composition, not by the scatter sampler:
   * they exist so the player always has a readable direction, and so a
   * screenshot from anywhere in the basin has a large shape in it.
   */
  _buildHeroes(n3) {
    const rng = this.rng, T = this.terrain, M = getMaterials();
    const add = (geo, mat, x, y, z, sx, sy, sz, ry, tilt = 0) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(tilt, ry, 0);
      mesh.scale.set(sx, sy, sz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.meshes.push(mesh);
      this._geos.push(geo);
      return mesh;
    };

    const P = this.P;
    // The two anchors keep their composition — opposed, off-centre, one
    // horizontal and one vertical — but their bearing rotates per stage, so a
    // player crossing into a new stage doesn't find the same landmark in the
    // same place with a new coat of paint.
    //
    // The offsets below are the hand-placed originals — arch (46,-34),
    // monolith (-52,30), boulder stack (8,58) — re-expressed as bearings
    // relative to the arch, so the spread between the three anchors is exactly
    // the composition that was tuned. Later stages rotate that whole triangle
    // as a rigid body, which is what stops every stage having its landmark in
    // the same place with a new coat of paint.
    //
    // The rotation is a function of the stage index and *not* of the RNG, and
    // it is zero on stage 1. Rolling it meant the reference stage's landmarks
    // could land anywhere — including squarely on the sight line the framing
    // was tuned against, with the monolith filling the middle of the frame.
    // The golden angle keeps successive stages far apart in bearing.
    const bearing = this.stageIndex * 2.399963;
    const place = (radius, offsetDeg) => {
      const a = bearing + (offsetDeg - 36.5) * (Math.PI / 180);
      return { x: Math.cos(a) * radius, z: Math.sin(a) * radius };
    };

    // The great arch: off-centre and rotated across the main sight line so it
    // frames the sky rather than sitting flat against it.
    {
      const { x, z } = place(57.2, 0);
      const y = T.sampleHeight(x, z);
      const sc = P.archHeroScale;
      add(archGeo(rng, n3), M.cliff, x, y - 1.4, z, sc, sc * 1.15, sc * 0.55, -0.62);
      this._collider(x - Math.cos(-0.62) * sc, z + Math.sin(-0.62) * sc, sc * 0.22, y - 2, y + sc * 0.6);
      this._collider(x + Math.cos(-0.62) * sc, z - Math.sin(-0.62) * sc, sc * 0.22, y - 2, y + sc * 0.6);
    }

    // The monolith: single tall vertical, deliberately opposite the arch so the
    // basin has two anchors instead of one.
    {
      const { x, z } = place(60.0, 186.5);
      const y = T.sampleHeight(x, z);
      const mh = P.monolithHeight;
      add(monolithGeo(rng, n3), M.metalRuin, x, y + mh * 0.44, z, 5.2, mh, 3.6, 0.7, 0.045);
      this._collider(x, z, 3.4, y - 2, y + mh * 0.96);
      // Crystal spill at the base ties the two accent colours together.
      const cg = crystalGeo(rng, n3);
      const list = [];
      for (let i = 0; i < 9; i++) {
        const a = rng.range(0, 6.283), r = rng.range(3.5, 9);
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        _v.set(px, T.sampleHeight(px, pz) - 0.3, pz);
        _q.setFromEuler(_e.set(rng.range(-0.2, 0.2), rng.range(0, 6.283), rng.range(-0.2, 0.2)));
        _s.setScalar(rng.range(1.6, 3.6));
        list.push(_m.compose(_v, _q, _s).clone());
      }
      this._addInstanced(cg, M.crystal, list);
    }

    // A leaning stack of huge boulders near the basin edge — mid-scale mass
    // between the scatter boulders and the two landmarks.
    {
      const { x: bx, z: bz } = place(58.5, 118.6);
      const base = T.sampleHeight(bx, bz);
      const g = boulderGeo(rng, n3);
      const list = [];
      let y = base + 1.5;
      for (let i = 0; i < 4; i++) {
        const sc = 6.5 - i * 1.1;
        _v.set(bx + rng.range(-1.6, 1.6), y, bz + rng.range(-1.6, 1.6));
        _q.setFromEuler(_e.set(rng.range(-0.4, 0.4), rng.range(0, 6.283), rng.range(-0.4, 0.4)));
        _s.setScalar(sc);
        list.push(_m.compose(_v, _q, _s).clone());
        y += sc * 1.05;
      }
      this._addInstanced(g, M.wetStone, list);
      this._collider(bx, bz, 5.5, base - 2, y);
    }

    // A ring of half-buried metal ruin slabs marks the arena centre without
    // blocking it — reads as a teleporter pad site.
    {
      const g = monolithGeo(rng, n3);
      const list = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.3;
        const r = 15.5;
        const px = Math.cos(a) * r, pz = Math.sin(a) * r;
        const py = T.sampleHeight(px, pz);
        _v.set(px, py + 1.4, pz);
        _q.setFromEuler(_e.set(Math.cos(a) * 0.16, -a, Math.sin(a) * 0.16));
        _s.set(2.6, 5.2, 0.9);
        list.push(_m.compose(_v, _q, _s).clone());
        this._collider(px, pz, 1.3, py - 1, py + 4);
      }
      this._addInstanced(g, M.metalRuin, list);
    }
  }

  /**
   * Full teardown. Geometry here is generated per stage and shared with nobody,
   * so all of it must go back to the driver — a run that reaches stage 5 would
   * otherwise be holding five stages' worth of buffers. Materials and their
   * textures come from the cached library and are deliberately left alone.
   */
  dispose() {
    for (const m of this.meshes) {
      // InstancedMesh.dispose() releases the instance matrix buffer, which is
      // the largest single allocation on a 260-instance boulder batch.
      m.dispose?.();
    }
    for (const g of this._geos) g.dispose();
    this._geos.length = 0;
    this.meshes.length = 0;
    this.colliders.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}
