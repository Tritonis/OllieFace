import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getTextureSets, withRepeat } from '../Materials.js';

/**
 * The four authored arenas.
 *
 * A realm is a *room*, not a generated landscape, so none of this goes through
 * TerrainGen or Props. Each builder gets the realm's `RealmStage` and fills it
 * with geometry, colliders and light — and each one is written to a different
 * material and value key, because the whole reason a realm exists is that
 * arriving in it has to feel like arriving somewhere else.
 *
 * Budget rules, both learned from the stage kit:
 *
 *  - **Merge by material, not by object.** Ten columns with three material
 *    rungs is three draw calls, not thirty. Every builder below assembles
 *    `THREE.BufferGeometry` lists and merges them once.
 *  - **Roughness contrast carries the read.** Every arena has at least three
 *    rungs: a matte substrate, a specular metal, and an emissive. A room built
 *    from one roughness is the "uniform matte plastic" failure at room scale,
 *    and the arenas are the only frames in the game with no terrain in them to
 *    hide behind.
 */

const _tex = (name, repeat) => withRepeat(getTextureSets()[name], repeat);

/** A standard rung. Realms allocate their own materials and dispose them. */
function rung(set, repeat, opts) {
  return new THREE.MeshStandardMaterial({ ..._tex(set, repeat), flatShading: true, ...opts });
}

/** Untextured emissive — lanterns, seams, rift light. */
function glow(hex, intensity = 2.2, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: 0x06070a, emissive: hex, emissiveIntensity: intensity, roughness: 0.4, metalness: 0, ...opts,
  });
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

/** Merge a list of `{ g, x, y, z, ry }` into one buffer and free the parts. */
function mergeParts(parts) {
  const list = [];
  for (const p of parts) {
    // Non-indexed on the way in, always. `mergeGeometries` refuses a list that
    // mixes indexed and non-indexed buffers, and the primitives here do mix:
    // Icosahedron/Octahedron are non-indexed, Box/Cylinder/Cone/Torus are not.
    const g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
    if (p.ry) g.rotateY(p.ry);
    if (p.rx) g.rotateX(p.rx);
    if (p.rz) g.rotateZ(p.rz);
    g.translate(p.x || 0, p.y || 0, p.z || 0);
    list.push(g);
  }
  const out = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  for (const p of parts) p.g.dispose?.();
  return out;
}

/** Standard floor disc. Scaled to `floorRadius` by RealmStage.setFloorMesh. */
function floorDisc(stage, material, segments = 72) {
  const g = new THREE.CircleGeometry(1, segments);
  g.rotateX(-Math.PI / 2);
  // A unit circle scaled to 30 m would stretch one UV tile across the whole
  // arena, so the tiling is pushed into the geometry's own UVs instead.
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 22, uv.getY(i) * 22);
  const m = new THREE.Mesh(g, material);
  m.position.copy(stage.origin);
  m.receiveShadow = true;
  stage.setFloorMesh(m);
  stage.addMesh(m, { solid: false });   // the floor is raycast analytically
  return m;
}

/** A closed room wall: an inward-facing cylinder plus a heavy cornice. */
function roomWall(stage, radius, height, wallMat, trimMat, ribs = 16) {
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 48, 1, true), wallMat);
  shell.material.side = THREE.BackSide;
  shell.position.set(stage.origin.x, height * 0.5 - 1, stage.origin.z);
  stage.addMesh(shell);

  const parts = [];
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    // Buttresses proud of the wall. They are what stops a cylinder reading as
    // a cylinder: without a vertical rhythm the room has no scale cue at all.
    parts.push({ g: box(1.1, height, 1.6), x: Math.cos(a) * (radius - 0.5), y: height * 0.5 - 1,
                 z: Math.sin(a) * (radius - 0.5), ry: -a });
  }
  // Cornice: a torus at the top of the wall, the one smooth-shaded thing up
  // there, so the room has a specular line where wall meets dark.
  const cornice = new THREE.Mesh(
    new THREE.TorusGeometry(radius - 0.4, 0.42, 8, 56), trimMat);
  cornice.rotation.x = Math.PI / 2;
  cornice.position.set(stage.origin.x, height - 1.4, stage.origin.z);
  stage.addMesh(cornice);

  const rib = new THREE.Mesh(mergeParts(parts), wallMat);
  rib.position.copy(stage.origin);
  rib.castShadow = true;
  rib.receiveShadow = true;
  stage.addMesh(rib);
  return rib;
}

/** A ring of inlay bands on the floor. Pure composition: it gives the eye radii. */
function inlayRings(stage, radii, mat) {
  const parts = [];
  for (const r of radii) {
    const g = new THREE.TorusGeometry(r, 0.10, 5, 64);
    g.rotateX(Math.PI / 2);
    parts.push({ g, y: 0.03 });
  }
  const m = new THREE.Mesh(mergeParts(parts), mat);
  m.position.copy(stage.origin);
  stage.addMesh(m, { solid: false });
  return m;
}

// ---------------------------------------------------------------------------
// THE HOLLOW MARKET — a vaulted undercroft lit only by its own lanterns
// ---------------------------------------------------------------------------
//
// The read is *shelter*: a low warm ceiling, a ring of arcade columns, and
// pooled amber light on dark polished stone. It is the only place in the game
// with no sun in it, and the only one where the brightest things in frame are
// stationary and safe.

function buildBazaar(stage) {
  const R = stage.floorRadius;
  const stone = rung('stone', 3.2, { color: 0x3c3746, roughness: 0.72, metalness: 0.04, envMapIntensity: 1.1 });
  const polish = rung('stone', 4.0, { color: 0x2a2733, roughness: 0.28, metalness: 0.08, envMapIntensity: 2.0 });
  const brass = rung('metal', 2.6, { color: 0xa8794a, roughness: 0.22, metalness: 0.74, envMapIntensity: 2.6 });
  const lamp = glow(0xffb060, 3.0);

  floorDisc(stage, polish);
  inlayRings(stage, [R * 0.34, R * 0.62, R * 0.86], brass);
  roomWall(stage, R, 15, stone, brass, 12);

  // Arcade: ten column/arch bays. The arch lintels are what make it a market
  // hall rather than a silo — a straight column ring reads as fence posts.
  const cols = [];
  const caps = [];
  const N = 10, ringR = R - 3.6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * ringR, z = Math.sin(a) * ringR;
    cols.push({ g: new THREE.CylinderGeometry(0.72, 0.94, 7.2, 8), x, y: 3.6, z });
    caps.push({ g: box(2.0, 0.5, 2.0), x, y: 7.45, z, ry: -a });
    caps.push({ g: box(2.4, 0.34, 2.4), x, y: 0.17, z, ry: -a });
    // Lintel to the next bay, chorded across the ring.
    const a2 = ((i + 1) / N) * Math.PI * 2;
    const mx = (Math.cos(a) + Math.cos(a2)) * 0.5 * ringR;
    const mz = (Math.sin(a) + Math.sin(a2)) * 0.5 * ringR;
    const span = Math.hypot(Math.cos(a2) - Math.cos(a), Math.sin(a2) - Math.sin(a)) * ringR;
    cols.push({ g: box(span, 0.9, 0.85), x: mx, y: 8.1, z: mz,
                ry: -Math.atan2(Math.sin(a2) - Math.sin(a), Math.cos(a2) - Math.cos(a)) });
    stage.addCollider(stage.origin.x + x, stage.origin.z + z, 1.0, -2, 8);
  }
  const colMesh = new THREE.Mesh(mergeParts(cols), stone);
  colMesh.position.copy(stage.origin);
  colMesh.castShadow = true; colMesh.receiveShadow = true;
  stage.addMesh(colMesh);
  const capMesh = new THREE.Mesh(mergeParts(caps), brass);
  capMesh.position.copy(stage.origin);
  capMesh.castShadow = true;
  stage.addMesh(capMesh);

  // Lanterns hung between the bays, at head height and above it, so the light
  // in the room has two layers and the floor has something to pool under.
  const lanterns = [];
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    const x = Math.cos(a) * (ringR - 1.4), z = Math.sin(a) * (ringR - 1.4);
    lanterns.push({ g: new THREE.OctahedronGeometry(0.42, 0), x, y: 5.2, z });
    lanterns.push({ g: new THREE.OctahedronGeometry(0.28, 0), x: x * 0.62, y: 6.4, z: z * 0.62 });
  }
  const lampMesh = new THREE.Mesh(mergeParts(lanterns), lamp);
  lampMesh.position.copy(stage.origin);
  stage.addMesh(lampMesh, { solid: false });

  // Two real lights, and only two: this is an interior, and the sky's key does
  // almost nothing in here. A pair of warm points is what makes the amber pool
  // on the floor an actual light rather than an emissive texture.
  const l1 = new THREE.PointLight(0xffb066, 34, 46, 1.8);
  l1.position.set(stage.origin.x, 7.5, stage.origin.z);
  stage.addMesh(l1, { solid: false });
  const l2 = new THREE.PointLight(0xff8a4a, 18, 34, 2.0);
  l2.position.set(stage.origin.x - 10, 4.0, stage.origin.z + 8);
  stage.addMesh(l2, { solid: false });

  // Central dais the obelisk stands on.
  const dais = new THREE.Mesh(mergeParts([
    { g: new THREE.CylinderGeometry(5.2, 5.8, 0.34, 24), y: 0.17 },
    { g: new THREE.CylinderGeometry(4.4, 4.9, 0.30, 24), y: 0.48 },
  ]), stone);
  dais.position.copy(stage.origin);
  dais.receiveShadow = true;
  stage.addMesh(dais);
  stage.daisY = 0.63;
}

// ---------------------------------------------------------------------------
// THE CRUCIBLE — a sunken iron pit with the fire underneath it
// ---------------------------------------------------------------------------
//
// The read is *no exit*: a hard vertical wall right at the floor's edge, an
// orange under-light through the grating, and nothing to hide behind except
// four blocks you will run out of. Everything here is the opposite of the
// market — cold metal lit hot from below.

function buildCrucible(stage) {
  const R = stage.floorRadius;
  const iron = rung('metal', 3.0, { color: 0x4a4e58, roughness: 0.34, metalness: 0.58, envMapIntensity: 2.2 });
  const dark = rung('metal', 2.4, { color: 0x2e3138, roughness: 0.62, metalness: 0.35, envMapIntensity: 1.2 });
  const seam = glow(0xff5a18, 2.6);

  floorDisc(stage, dark);
  // Radial seams glowing up through the grate. They are also the only thing in
  // the arena telling you where the middle is once the fight starts.
  const seams = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    seams.push({ g: box(R * 0.94, 0.06, 0.30), x: Math.cos(a) * R * 0.47, y: 0.05,
                 z: Math.sin(a) * R * 0.47, ry: -a });
  }
  seams.push({ g: (() => { const g = new THREE.TorusGeometry(R * 0.55, 0.14, 5, 56); g.rotateX(Math.PI / 2); return g; })(), y: 0.05 });
  const seamMesh = new THREE.Mesh(mergeParts(seams), seam);
  seamMesh.position.copy(stage.origin);
  stage.addMesh(seamMesh, { solid: false });

  roomWall(stage, R, 13, iron, iron, 18);

  // Four cover blocks on a square, deliberately not symmetrical with the wall
  // ribs: the arena has to have a shape you can learn inside five waves.
  const blocks = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    const x = Math.cos(a) * R * 0.5, z = Math.sin(a) * R * 0.5;
    blocks.push({ g: box(3.0, 2.2, 3.0), x, y: 1.1, z, ry: -a });
    blocks.push({ g: box(3.6, 0.3, 3.6), x, y: 2.35, z, ry: -a });
    stage.addCollider(stage.origin.x + x, stage.origin.z + z, 2.0, -2, 2.5);
  }
  const blockMesh = new THREE.Mesh(mergeParts(blocks), iron);
  blockMesh.position.copy(stage.origin);
  blockMesh.castShadow = true; blockMesh.receiveShadow = true;
  stage.addMesh(blockMesh);

  // Braziers on the rim: the arena's key light, and the reason the wall has a
  // lit side and a dark side rather than one even value all the way round.
  const bowls = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const x = Math.cos(a) * (R - 2.2), z = Math.sin(a) * (R - 2.2);
    bowls.push({ g: new THREE.CylinderGeometry(1.0, 0.4, 1.2, 8), x, y: 2.6, z });
    bowls.push({ g: new THREE.CylinderGeometry(0.22, 0.34, 2.2, 6), x, y: 1.1, z });
    if (i % 3 === 0) {
      const l = new THREE.PointLight(0xff6a20, 16, 30, 2.0);
      l.position.set(stage.origin.x + x, 4.2, stage.origin.z + z);
      stage.addMesh(l, { solid: false });
    }
  }
  const bowlMesh = new THREE.Mesh(mergeParts(bowls), iron);
  bowlMesh.position.copy(stage.origin);
  bowlMesh.castShadow = true;
  stage.addMesh(bowlMesh);

  const fires = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    fires.push({ g: new THREE.IcosahedronGeometry(0.85, 0), x: Math.cos(a) * (R - 2.2), y: 3.4, z: Math.sin(a) * (R - 2.2) });
  }
  const fireMesh = new THREE.Mesh(mergeParts(fires), glow(0xff7a20, 3.4));
  fireMesh.position.copy(stage.origin);
  stage.addMesh(fireMesh, { solid: false });
}

// ---------------------------------------------------------------------------
// THE GILDED VAULT — one room, one guard, one prize
// ---------------------------------------------------------------------------
//
// The read is *value under guard*: black stone, a lot of gold, and a single
// enormous chest on a lit dais that you can see the whole time you are fighting
// for it. The composition is built around that one object.

function buildVault(stage) {
  const R = stage.floorRadius;
  const marble = rung('stone', 3.4, { color: 0x241f22, roughness: 0.26, metalness: 0.10, envMapIntensity: 2.4 });
  const wall = rung('stone', 2.6, { color: 0x332b26, roughness: 0.74, metalness: 0.05, envMapIntensity: 1.0 });
  const gold = rung('metal', 2.8, { color: 0xc99a34, roughness: 0.17, metalness: 0.86, envMapIntensity: 3.0 });

  floorDisc(stage, marble);
  inlayRings(stage, [R * 0.28, R * 0.55, R * 0.82], gold);
  roomWall(stage, R, 12, wall, gold, 14);

  // Eight gilded pillars, thick and close: a treasury is a *heavy* room.
  const pil = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39;
    const x = Math.cos(a) * (R - 4.5), z = Math.sin(a) * (R - 4.5);
    pil.push({ g: new THREE.CylinderGeometry(1.05, 1.25, 8.4, 10), x, y: 4.2, z });
    pil.push({ g: box(2.9, 0.6, 2.9), x, y: 8.7, z, ry: -a });
    stage.addCollider(stage.origin.x + x, stage.origin.z + z, 1.35, -2, 9);
  }
  const pilMesh = new THREE.Mesh(mergeParts(pil), wall);
  pilMesh.position.copy(stage.origin);
  pilMesh.castShadow = true; pilMesh.receiveShadow = true;
  stage.addMesh(pilMesh);

  // Bullion heaps between the pillars. Icosahedra at three scales, which at
  // this material reads as coin and ingot rather than as rocks painted yellow.
  const heaps = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39;
    const bx = Math.cos(a) * (R - 6.6), bz = Math.sin(a) * (R - 6.6);
    for (let k = 0; k < 7; k++) {
      const ka = a + (k - 3) * 0.10, kr = (R - 6.6) + (k % 3) * 0.9;
      heaps.push({ g: new THREE.IcosahedronGeometry(0.30 + (k % 4) * 0.14, 0),
                   x: Math.cos(ka) * kr, y: 0.16 + (k % 3) * 0.18, z: Math.sin(ka) * kr, ry: k });
    }
    heaps.push({ g: new THREE.ConeGeometry(1.5, 1.1, 7), x: bx, y: 0.55, z: bz });
  }
  const heapMesh = new THREE.Mesh(mergeParts(heaps), gold);
  heapMesh.position.copy(stage.origin);
  heapMesh.castShadow = true;
  stage.addMesh(heapMesh, { solid: false });

  // The dais. The vault chest is an interactable and is built in RealmProps.
  const dais = new THREE.Mesh(mergeParts([
    { g: new THREE.CylinderGeometry(4.6, 5.4, 0.4, 20), y: 0.20 },
    { g: new THREE.CylinderGeometry(3.9, 4.4, 0.4, 20), y: 0.58 },
  ]), marble);
  dais.position.copy(stage.origin);
  dais.receiveShadow = true;
  stage.addMesh(dais);
  stage.daisY = 0.78;

  const key = new THREE.PointLight(0xffd280, 40, 44, 1.7);
  key.position.set(stage.origin.x, 8.5, stage.origin.z);
  stage.addMesh(key, { solid: false });
}

// ---------------------------------------------------------------------------
// THE FRACTURE — a broken disc over nothing
// ---------------------------------------------------------------------------
//
// The read is *no ground to spare*. There is no wall: the arena simply stops,
// and the ring of monoliths beyond it is far enough out to be scenery rather
// than cover. The floor is the only thing here, which is what makes taking it
// away between phases the whole fight.

function buildFracture(stage) {
  const R = stage.floorRadius;
  const slab = rung('stone', 3.0, { color: 0x33284a, roughness: 0.66, metalness: 0.08, envMapIntensity: 1.5 });
  const edge = rung('stone', 2.2, { color: 0x1d1730, roughness: 0.46, metalness: 0.16, envMapIntensity: 2.2 });
  const rift = glow(0xd050ff, 2.8);

  floorDisc(stage, slab, 96);

  // The floor's under-structure, so the disc reads as a slab with thickness
  // rather than as a decal. It is scaled with the floor by `onFloorRadius`.
  const under = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.72, 3.4, 64, 1, true), edge);
  under.material.side = THREE.DoubleSide;
  under.position.set(stage.origin.x, -1.7, stage.origin.z);
  stage.addMesh(under, { solid: false });

  // A rim band, likewise scaled: it is the line that says exactly where the
  // ground ends, and in phase 2 it is what visibly moves inward.
  const rim = new THREE.Mesh((() => {
    const g = new THREE.TorusGeometry(1, 0.022, 6, 96);
    g.rotateX(Math.PI / 2);
    return g;
  })(), rift);
  rim.position.set(stage.origin.x, 0.12, stage.origin.z);
  stage.addMesh(rim, { solid: false });

  // Scaling hook — RealmStage owns `floorRadius`, and these two follow it.
  stage.onFloorRadius = (r) => {
    under.scale.set(r, 1, r);
    rim.scale.set(r, 1, r);
  };
  stage.onFloorRadius(R);

  // Rift veins across the floor. Radial, so they point at the middle from
  // anywhere — a readability aid disguised as decoration.
  const veins = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.2;
    const len = R * (0.5 + (i % 3) * 0.16);
    veins.push({ g: box(len, 0.05, 0.22), x: Math.cos(a) * len * 0.5, y: 0.04, z: Math.sin(a) * len * 0.5, ry: -a });
  }
  const veinMesh = new THREE.Mesh(mergeParts(veins), rift);
  veinMesh.position.copy(stage.origin);
  stage.addMesh(veinMesh, { solid: false });

  // Monoliths at the far edge. They sit beyond the wall radius so they can
  // never be reached; their job is to give the void a horizon and the frame a
  // background layer, which a bare skybox cannot do.
  const mono = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.17;
    const d = 54 + (i % 4) * 6;
    const h = 20 + (i % 5) * 9;
    mono.push({ g: box(4.4 + (i % 3) * 1.6, h, 3.2), x: Math.cos(a) * d,
                y: h * 0.5 - 8 - (i % 3) * 4, z: Math.sin(a) * d, ry: -a, rz: (i % 2 ? 0.06 : -0.05) });
  }
  const monoMesh = new THREE.Mesh(mergeParts(mono), edge);
  monoMesh.position.copy(stage.origin);
  monoMesh.castShadow = true;
  stage.addMesh(monoMesh, { solid: false });

  const key = new THREE.PointLight(0xb060ff, 30, 70, 1.5);
  key.position.set(stage.origin.x, 22, stage.origin.z);
  stage.addMesh(key, { solid: false });

  // Anchor pylons: dark until phase 2 lights them. They stand on the phase-2
  // floor radius so the collapse never strands one over the void.
  stage.anchorSites = [];
  const pylons = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const x = Math.cos(a) * 16, z = Math.sin(a) * 16;
    pylons.push({ g: new THREE.CylinderGeometry(0.9, 1.5, 3.2, 6), x, y: 1.6, z });
    stage.anchorSites.push(new THREE.Vector3(stage.origin.x + x, 3.2, stage.origin.z + z));
  }
  const pylonMesh = new THREE.Mesh(mergeParts(pylons), edge);
  pylonMesh.position.copy(stage.origin);
  pylonMesh.castShadow = true;
  stage.addMesh(pylonMesh);
}

/**
 * Raise the phase-3 islands.
 *
 * Called by the finale controller rather than at build time: they are a *rule
 * change*, and a player who could see three spare platforms from the opening
 * of the fight would read the collapse as scripted scenery instead of as the
 * arena being taken away.
 */
export function raiseIslands(stage, { count = 3, radius = 4.6, dist = 24, height = 3.2 }) {
  const mat = rung('stone', 2.6, { color: 0x3a2c58, roughness: 0.6, metalness: 0.1, envMapIntensity: 1.8 });
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.9;
    const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
    parts.push({ g: new THREE.CylinderGeometry(radius, radius * 0.62, 2.6, 12), x, y: height - 1.3, z });
    stage.addPlatform(stage.origin.x + x, height, stage.origin.z + z, radius);
  }
  const m = new THREE.Mesh(mergeParts(parts), mat);
  m.position.copy(stage.origin);
  m.castShadow = true;
  m.receiveShadow = true;
  stage.addMesh(m);
  return m;
}

const BUILDERS = {
  bazaar: buildBazaar,
  crucible: buildCrucible,
  vault: buildVault,
  fracture: buildFracture,
};

/** Build the arena for a realm onto its stage. */
export function buildArena(stage) {
  const b = BUILDERS[stage.realmId];
  if (b) b(stage);
  return stage;
}
