import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getTextureSets, withRepeat, attachWorldSurface } from '../Materials.js';

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

/**
 * A standard rung. Realms allocate their own materials and dispose them.
 *
 * Through `attachWorldSurface`, so an arena floor takes the blight mask like
 * any other world surface. `glow` below deliberately does not: an emissive
 * lantern or rift seam is light, not substance, and has no surface to corrupt.
 */
function rung(set, repeat, opts) {
  return attachWorldSurface(new THREE.MeshStandardMaterial({ ..._tex(set, repeat), flatShading: true, ...opts }));
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

/**
 * The one-sided variant of a material this helper does *not* own.
 *
 * `roomWall` and `roomCeiling` need `BackSide` on their own shell, and both
 * used to get it by writing `mesh.material.side = BackSide` — on the object the
 * caller passed in. Every other mesh sharing that rung then rendered back-face
 * only: the bazaar's pale columns and its two-tier dais share `paleStone` with
 * the ceiling, the crucible's cover blocks and brazier bowls share `iron` with
 * both. With `flatShading: true` a back face takes its normal from screen
 * derivatives, so those meshes lost their form shading entirely — measured on
 * `reviews/round6/audfix-pre-full/realms/22-realm-bazaar.png`, the "pale
 * limestone" columns came back *darker* than the mid-grey floor they stand on,
 * which is the exact inverse of the value separation the room is built around.
 *
 * One clone per room shell, at build time, is the whole cost.
 */
function backSided(mat) {
  const m = mat.clone();
  m.side = THREE.BackSide;
  return m;
}

/** A closed room wall: an inward-facing cylinder plus a heavy cornice. */
function roomWall(stage, radius, height, wallMat, trimMat, ribs = 16) {
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 48, 1, true), backSided(wallMat));
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

/**
 * A roof.
 *
 * The first capture of all three walled realms came back as an *open-air*
 * amphitheatre under the world's sunset sky, with a blown sun disc reflected
 * off the floor — the arena geometry was right and the room still read as a
 * field, because you could see the sky from inside it. A cone roof is the fix
 * and it is also the cheapest possible one: one open-ended cone, back faces,
 * no shadow casting (the key light is still allowed through, so the room keeps
 * a direction; what is blocked is the *view* of the sky and the horizon).
 */
function roomCeiling(stage, radius, height, mat, rise = 7) {
  const g = new THREE.ConeGeometry(radius * 1.02, rise, 40, 1, true);
  const m = new THREE.Mesh(g, backSided(mat));
  m.position.set(stage.origin.x, height + rise * 0.5 - 1.2, stage.origin.z);
  m.receiveShadow = true;
  stage.addMesh(m, { solid: false });
  // Boss and lens both live under it, so it must never be something the camera
  // boom can catch on or a ray can stop against.
  return m;
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
// THE HOLLOW MARKET — the bright room
// ---------------------------------------------------------------------------
//
// The read is *safe*, and safe has to be carried by the light rather than by
// the HUD line. The first pass was a dark amber undercroft that measured 52.5
// mean luma against the Crucible's 52.4 — the hub and the kill-pit were the
// same photograph. This is now the brightest interior in the game by a wide
// margin: pale limestone under a cool ivory fill, near-nothing in shadow, and
// the lanterns supplying the only warm channel in the room.
//
// Three concrete rules the geometry below follows, all from the critique:
//
//  - **The columns must step off the wall by ≥2.5:1 in value.** Pale ivory
//    columns in front of a mid-grey wall plane, not one stone for both.
//  - **Every column needs contact.** A dark plinth skirt and a shadow collar
//    at the base, because an unsupported column reads as a painted backdrop.
//  - **A lantern is a fixture, not a billboard.** Bracket, chain, housing
//    cage, then the flame — the same four parts on all twenty of them.

function buildBazaar(stage) {
  const R = stage.floorRadius;
  // Three stone rungs instead of one, and they are two full stops apart. The
  // wall is the darkest, the columns are the brightest, the floor sits between.
  const wallStone = rung('stone', 3.2, { color: 0x3f5058, roughness: 0.88, metalness: 0.03, envMapIntensity: 0.7 });
  const paleStone = rung('stone', 2.4, { color: 0xb9c6c8, roughness: 0.76, metalness: 0.02, envMapIntensity: 1.0 });
  // Cool polished flagstone. Light enough to bounce, matte enough not to mirror
  // the ceiling back at the camera.
  const polish = rung('stone', 4.0, { color: 0x64777d, roughness: 0.62, metalness: 0.05, envMapIntensity: 0.8 });
  // Contact/plinth rung: the dark value that puts the columns on the ground.
  const plinth = rung('stone', 2.0, { color: 0x2e393e, roughness: 0.9, metalness: 0.02, envMapIntensity: 0.4 });
  const brass = rung('metal', 2.6, { color: 0xb98a4a, roughness: 0.26, metalness: 0.78, envMapIntensity: 2.2 });
  const iron = rung('metal', 2.0, { color: 0x39424a, roughness: 0.55, metalness: 0.6, envMapIntensity: 1.0 });
  const lamp = glow(0xffc07a, 2.6);

  floorDisc(stage, polish);
  inlayRings(stage, [R * 0.34, R * 0.62, R * 0.86], brass);
  roomWall(stage, R, 15, wallStone, brass, 12);
  roomCeiling(stage, R, 15, paleStone, 8);

  // Arcade: ten column/arch bays. The arch lintels are what make it a market
  // hall rather than a silo — a straight column ring reads as fence posts.
  const cols = [];
  const caps = [];
  const bases = [];
  const N = 10, ringR = R - 3.6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * ringR, z = Math.sin(a) * ringR;
    cols.push({ g: new THREE.CylinderGeometry(0.72, 0.94, 7.2, 8), x, y: 3.6, z });
    caps.push({ g: box(2.0, 0.5, 2.0), x, y: 7.45, z, ry: -a });
    // Contact: a dark plinth block, then a wider skirt disc under it. Without
    // this the columns floated — there was no AO at a single junction.
    bases.push({ g: box(2.4, 0.5, 2.4), x, y: 0.25, z, ry: -a });
    bases.push({ g: new THREE.CylinderGeometry(2.05, 2.35, 0.14, 16), x, y: 0.06, z });
    // Lintel to the next bay, chorded across the ring.
    const a2 = ((i + 1) / N) * Math.PI * 2;
    const mx = (Math.cos(a) + Math.cos(a2)) * 0.5 * ringR;
    const mz = (Math.sin(a) + Math.sin(a2)) * 0.5 * ringR;
    const span = Math.hypot(Math.cos(a2) - Math.cos(a), Math.sin(a2) - Math.sin(a)) * ringR;
    cols.push({ g: box(span, 0.9, 0.85), x: mx, y: 8.1, z: mz,
                ry: -Math.atan2(Math.sin(a2) - Math.sin(a), Math.cos(a2) - Math.cos(a)) });
    stage.addCollider(stage.origin.x + x, stage.origin.z + z, 1.0, -2, 8);
  }
  const colMesh = new THREE.Mesh(mergeParts(cols), paleStone);
  colMesh.position.copy(stage.origin);
  colMesh.castShadow = true; colMesh.receiveShadow = true;
  stage.addMesh(colMesh);
  const capMesh = new THREE.Mesh(mergeParts(caps), brass);
  capMesh.position.copy(stage.origin);
  capMesh.castShadow = true;
  stage.addMesh(capMesh);
  const baseMesh = new THREE.Mesh(mergeParts(bases), plinth);
  baseMesh.position.copy(stage.origin);
  baseMesh.castShadow = true; baseMesh.receiveShadow = true;
  stage.addMesh(baseMesh);

  // Lanterns hung between the bays. Each is four parts, because the critique's
  // complaint was exact: flat diamond billboards with no chain, bracket or
  // housing, some haloed and some not. Bracket and chain are iron, the cage is
  // brass, and only the flame inside is emissive — so every lantern in frame
  // reads the same way whatever the bloom does to it.
  const lanterns = [];
  const irons = [];
  const cages = [];
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    const put = (rad, y, s) => {
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      // bracket off the lintel, chain down to the housing
      irons.push({ g: box(0.9 * s, 0.12, 0.12), x: x + Math.cos(a) * 0.35 * s, y: y + 1.5 * s, z: z + Math.sin(a) * 0.35 * s, ry: -a });
      irons.push({ g: new THREE.CylinderGeometry(0.035, 0.035, 1.35 * s, 4), x, y: y + 0.82 * s, z });
      // housing: a cage of four uprights and a lid, brass
      cages.push({ g: new THREE.CylinderGeometry(0.34 * s, 0.40 * s, 0.10, 6), x, y: y + 0.44 * s, z });
      cages.push({ g: new THREE.CylinderGeometry(0.40 * s, 0.30 * s, 0.10, 6), x, y: y - 0.46 * s, z });
      for (let k = 0; k < 4; k++) {
        const ka = a + k * Math.PI * 0.5;
        cages.push({ g: box(0.05, 0.94 * s, 0.05), x: x + Math.cos(ka) * 0.3 * s, y, z: z + Math.sin(ka) * 0.3 * s });
      }
      lanterns.push({ g: new THREE.OctahedronGeometry(0.30 * s, 0), x, y, z });
    };
    put(ringR - 1.4, 5.2, 1.0);
    put((ringR - 1.4) * 0.62, 6.4, 0.72);
  }
  const lampMesh = new THREE.Mesh(mergeParts(lanterns), lamp);
  lampMesh.position.copy(stage.origin);
  stage.addMesh(lampMesh, { solid: false });
  const ironMesh = new THREE.Mesh(mergeParts(irons), iron);
  ironMesh.position.copy(stage.origin);
  ironMesh.castShadow = true;
  stage.addMesh(ironMesh, { solid: false });
  const cageMesh = new THREE.Mesh(mergeParts(cages), brass);
  cageMesh.position.copy(stage.origin);
  cageMesh.castShadow = true;
  stage.addMesh(cageMesh, { solid: false });

  // The light. A soft cool overhead fill is what lifts the room to twice the
  // pit's level and puts nothing in deep shadow; four warm lantern points are
  // the accent, and they are the *only* warm light in the arena. Split like
  // this the room is unmistakably lit rather than unmistakably bright.
  // One soft source, high in the vault and well clear of the dais. A second
  // low centre fill was tried and it put a blown white pool on the dais that
  // was the brightest thing in frame — a fill light you can see the shape of is
  // a key, and this room already has one.
  const fill = new THREE.PointLight(0xd8ecf2, 52, 74, 1.30);
  fill.position.set(stage.origin.x, 13.5, stage.origin.z);
  stage.addMesh(fill, { solid: false });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.55;
    const l = new THREE.PointLight(0xffb066, 22, 26, 1.9);
    l.position.set(stage.origin.x + Math.cos(a) * (ringR - 2.2), 5.2, stage.origin.z + Math.sin(a) * (ringR - 2.2));
    stage.addMesh(l, { solid: false });
  }

  // Central dais the obelisk stands on. Pale on top, dark at the contact.
  const dais = new THREE.Mesh(mergeParts([
    { g: new THREE.CylinderGeometry(5.2, 5.8, 0.34, 24), y: 0.17 },
    { g: new THREE.CylinderGeometry(4.4, 4.9, 0.30, 24), y: 0.48 },
  ]), paleStone);
  dais.position.copy(stage.origin);
  dais.receiveShadow = true;
  stage.addMesh(dais);
  const daisFoot = new THREE.Mesh(
    new THREE.CylinderGeometry(6.1, 6.5, 0.12, 32), plinth);
  daisFoot.position.set(stage.origin.x, 0.05, stage.origin.z);
  daisFoot.receiveShadow = true;
  stage.addMesh(daisFoot, { solid: false });
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
  // Cold blue-steel, all three rungs. Nothing in this room is warm except the
  // seam and the fire: the critique's measurement was that the pit and the safe
  // hub sat 11 dE apart on one amber key, so the heat is now strictly confined
  // to emissives and everything the light lands on is a blue-grey.
  const iron = rung('metal', 3.0, { color: 0x3c4553, roughness: 0.44, metalness: 0.58, envMapIntensity: 1.0 });
  // Lighter caps on the cover blocks. The critique: the blocks' drop shadows
  // were the same value as the blocks, so they read as holes in the floor. A
  // lit top plate two stops above the body is what makes them objects.
  const steel = rung('metal', 2.2, { color: 0x707d8c, roughness: 0.36, metalness: 0.62, envMapIntensity: 1.5 });
  // The floor is a grate, not a mirror. It measured as the brightest object in
  // the first capture — a sun streak on wet-looking metal — which is the wrong
  // thing for a room whose whole point is that the light comes from below.
  const dark = rung('metal', 2.4, { color: 0x1e242e, roughness: 0.82, metalness: 0.22, envMapIntensity: 0.45 });
  const seam = glow(0xff5a18, 1.5);

  floorDisc(stage, dark);
  // Radial seams glowing up through the grate. They are also the only thing in
  // the arena telling you where the middle is once the fight starts.
  const seams = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    // A band, not a spoke all the way to the middle. Full-radius bars converge
    // on the centre of the frame and owned the first capture of this arena.
    seams.push({ g: box(R * 0.44, 0.06, 0.14), x: Math.cos(a) * R * 0.70, y: 0.05,
                 z: Math.sin(a) * R * 0.70, ry: -a });
  }
  seams.push({ g: (() => { const g = new THREE.TorusGeometry(R * 0.55, 0.14, 5, 56); g.rotateX(Math.PI / 2); return g; })(), y: 0.05 });
  const seamMesh = new THREE.Mesh(mergeParts(seams), seam);
  seamMesh.position.copy(stage.origin);
  stage.addMesh(seamMesh, { solid: false });

  roomWall(stage, R, 13, iron, iron, 18);
  roomCeiling(stage, R, 13, iron, 7);

  // Four cover blocks on a square, deliberately not symmetrical with the wall
  // ribs: the arena has to have a shape you can learn inside five waves.
  const blocks = [];
  const caps = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    const x = Math.cos(a) * R * 0.5, z = Math.sin(a) * R * 0.5;
    blocks.push({ g: box(3.0, 2.2, 3.0), x, y: 1.1, z, ry: -a });
    caps.push({ g: box(3.6, 0.3, 3.6), x, y: 2.35, z, ry: -a });
    // A skirt at the base, one value below the block, so the block's own
    // shadow is not the only thing touching the floor under it.
    blocks.push({ g: box(3.9, 0.16, 3.9), x, y: 0.08, z, ry: -a });
    stage.addCollider(stage.origin.x + x, stage.origin.z + z, 2.0, -2, 2.5);
  }
  const blockMesh = new THREE.Mesh(mergeParts(blocks), iron);
  blockMesh.position.copy(stage.origin);
  blockMesh.castShadow = true; blockMesh.receiveShadow = true;
  stage.addMesh(blockMesh);
  const capMesh = new THREE.Mesh(mergeParts(caps), steel);
  capMesh.position.copy(stage.origin);
  capMesh.castShadow = true; capMesh.receiveShadow = true;
  stage.addMesh(capMesh);

  // Braziers on the rim. Their light is deliberately short-range now: at 16/30
  // they were repainting the walls orange and taking the whole room with them.
  // They pool at the rim and leave the middle of the pit cold.
  const bowls = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const x = Math.cos(a) * (R - 2.2), z = Math.sin(a) * (R - 2.2);
    bowls.push({ g: new THREE.CylinderGeometry(1.0, 0.4, 1.2, 8), x, y: 2.6, z });
    bowls.push({ g: new THREE.CylinderGeometry(0.22, 0.34, 2.2, 6), x, y: 1.1, z });
    if (i % 3 === 0) {
      const l = new THREE.PointLight(0xff6a20, 9, 15, 2.2);
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
    fires.push({ g: new THREE.IcosahedronGeometry(0.62, 0), x: Math.cos(a) * (R - 2.2), y: 3.3, z: Math.sin(a) * (R - 2.2) });
  }
  const fireMesh = new THREE.Mesh(mergeParts(fires), glow(0xff7a20, 2.6));
  fireMesh.position.copy(stage.origin);
  stage.addMesh(fireMesh, { solid: false });

  // The cold key: one hard white-blue downlight in the roof cone. It is what
  // gives the steel a top plane and the blocks a lit face, and it is what stops
  // "the light comes from below" turning into "the room is orange".
  const key = new THREE.PointLight(0xa8c8e8, 34, 46, 1.7);
  key.position.set(stage.origin.x, 11.5, stage.origin.z);
  stage.addMesh(key, { solid: false });
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
  // True black, both stone rungs. The critique: "the only committed grade among
  // the three realms — push the walls to true black so the gold has something
  // to read against." At 0x332b26 the wall was a warm brown that put the whole
  // frame 10.4 dE from an ordinary biome; at 0x0d0b0a it is a value floor and
  // the only chroma left in the room is metal.
  // Rougher than the first pass: with a hard downlight overhead, a 0.40 marble
  // put a blown specular pool on the dais that outshone the chest standing on
  // it. A treasury floor is polished stone, not a mirror.
  const marble = rung('stone', 3.4, { color: 0x141116, roughness: 0.66, metalness: 0.06, envMapIntensity: 0.7 });
  const wall = rung('stone', 2.6, { color: 0x0d0b0a, roughness: 0.80, metalness: 0.04, envMapIntensity: 0.55 });
  // Pushed off amber towards true gold: less red, more yellow, so the vault
  // owns a hue band (~45 degrees) that no ordinary biome sits in.
  const gold = rung('metal', 2.8, { color: 0xe0ad2e, roughness: 0.15, metalness: 0.90, envMapIntensity: 3.4 });

  floorDisc(stage, marble);
  inlayRings(stage, [R * 0.28, R * 0.55, R * 0.82], gold);
  roomWall(stage, R, 12, wall, gold, 14);
  roomCeiling(stage, R, 12, wall, 7);

  /* Gilding on the wall itself, and the reason it has to be emitted.
   *
   * "True black walls so the gold has something to read against" was the right
   * call and it did not survive contact with the grade. `GradeShader` carries a
   * deliberate cool-shadow pedestal — `uLift = (0.016, 0.020, 0.048)`, applied
   * as `col*uGain + uLift*(1-col)` — so a surface with no light of its own does
   * not render black, it renders *the lift*. The round-6 baseline measured this
   * room's upper half at RGB 37,33,57, hue 248: forty-five per cent of the
   * frame was the shader's blue pedestal, which is how a gold treasury ended up
   * 9.7 dE76 from ordinary biome 4 — closer than any two of the four biomes are
   * to each other (13.7 at the tightest).
   *
   * A black wall therefore cannot be left unlit; it can only be black *next to*
   * something. So the wall keeps its 0x0d0b0a stone and gets its own light in
   * two forms: emitted gilding, which costs no light budget and cannot be
   * dimmed by the room's near-zero ambient, and three grazing wall-washes that
   * give the stone between the gilding a warm falloff instead of a blue floor.
   */
  const gilt = glow(0xffc41a, 3.4);
  const band = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    // A gilt fillet down the face of every buttress: the vertical rhythm the
    // ribs already give the room, now the brightest thing on the wall.
    band.push({ g: box(0.34, 9.4, 0.16), x: Math.cos(a) * (R - 1.28), y: 4.0,
                z: Math.sin(a) * (R - 1.28), ry: -a });
  }
  const giltMesh = new THREE.Mesh(mergeParts(band), gilt);
  giltMesh.position.copy(stage.origin);
  stage.addMesh(giltMesh, { solid: false });

  // The frieze: one unbroken line of gold at eye height, all the way round. It
  // is what makes the wall a *wall of the vault* from any bearing rather than
  // only where a fillet happens to be.
  const frieze = new THREE.Mesh(new THREE.TorusGeometry(R - 0.62, 0.17, 6, 64), gilt);
  frieze.rotation.x = Math.PI / 2;
  frieze.position.set(stage.origin.x, 4.6, stage.origin.z);
  stage.addMesh(frieze, { solid: false });

  /* Lighting the wall was tried and measured and is wrong, and the measurement
   * is worth keeping because it is counter-intuitive.
   *
   * Three grazing wall-washes plus a wash under the roof took the frame from
   * L 21.5 / b* −2.4 to L 25.8 / b* +3.9 — a warmer room, and **closer** to
   * ordinary biome 4 (dE76 9.7 -> 6.4), because biome 4 is itself a mid-dark
   * warm frame at L 28.7 / a* 14.2 / b* 1.3. Every lumen added to this room
   * walked it into the biome it was supposed to be furthest from. Files:
   * `reviews/round6/base/realms/24-realm-vault.png` (9.7),
   * `reviews/round6/realms-w2/24-realm-vault.png` (6.4).
   *
   * So the room goes the other way, which is also what it was authored to be:
   * the gilding is the only thing that emits, it is emitted at a *saturated*
   * gold rather than a pale one so it buys chroma instead of luminance, and the
   * key's reach is pulled in so the far wall genuinely falls off. Dark and
   * chromatic is a place the four biomes do not have.
   */

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

  // One hard downlight over the dais and nothing else. A treasury lit evenly is
  // a warehouse; the prize has to be the brightest thing in the room by a long
  // way and the walls have to fall off into black behind it.
  //
  // Tuned by measurement, not by eye: at 62/decay 2.1 the chest came back at
  // luminance 21.4 against a background of 19.8 — 3.7% contrast, which is a
  // prize you cannot find. This is the light that puts it back on top.
  const key = new THREE.PointLight(0xffd070, 210, 27, 1.85);
  key.position.set(stage.origin.x, 9.5, stage.origin.z);
  stage.addMesh(key, { solid: false });
  // A second, tight and low, throwing the chest's own front face. Short range
  // on purpose: the pillars and the wall must stay in the dark.
  //
  // Re-sited, because at 46/16/1.9 from (0, 3.2, -7.5) the arithmetic said the
  // brightest lit surface in the room was a patch of empty floor between the
  // camera and the prize: 46 / 3.2^1.9 = 5.05 on the floor directly beneath it
  // against 46 / 7.8^1.9 = 0.92 on the chest's front face, i.e. **5.5x** the
  // subject, and 1.6x what the key puts on the dais (210 / 9.5^1.85 = 3.27).
  // `reviews/round6/audfix-pre-full/realms/24-realm-vault.png` shows that as a
  // gold wash across the lower half of the frame, against a room whose stated
  // rule is that the walls fall off into black.
  //
  // A fill for a subject has to be closer to the subject than to anything else.
  // At (0, 2.9, -3.0) it stands just off the dais lip: the chest's front face
  // (~1.2 m out, ~1.6 m up) is 2.2 m away and the nearest floor it can pool on
  // is the dais top 2.1 m below it, which is the prize's own plinth rather than
  // open ground. 27 / 2.22^1.9 x cos(35 deg) = 4.0 on the face against
  // 27 / 2.9^1.9 = 3.5 on the dais — the subject is now the brightest thing the
  // fill touches, and the fill no longer reaches past the dais at all.
  const face = new THREE.PointLight(0xffe0a0, 27, 9, 1.9);
  face.position.set(stage.origin.x, 2.9, stage.origin.z - 3.0);
  stage.addMesh(face, { solid: false });
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
  // Lifted off near-black: the first capture had the arena reading as a hole in
  // the frame with only its rim visible, so the one surface the whole fight
  // happens on carried no value of its own at all.
  const slab = rung('stone', 3.0, { color: 0x4a3c6e, roughness: 0.68, metalness: 0.08, envMapIntensity: 1.3 });
  const edge = rung('stone', 2.2, { color: 0x241d3a, roughness: 0.50, metalness: 0.14, envMapIntensity: 1.8 });
  const rift = glow(0xd050ff, 1.3);

  floorDisc(stage, slab, 96);

  // The floor's under-structure, so the disc reads as a slab with thickness
  // rather than as a decal. It is scaled with the floor by `onFloorRadius`.
  //
  // Much deeper than the first pass (3.4 m -> 14 m) and it tapers hard: the
  // critique was that with a clean machined rim and no void visible in frame,
  // a player could not tell the floor had moved. A long dark taper falling away
  // under the lip is the *persistent* void read — it is there in every frame at
  // every radius, not only during the two seconds of the collapse.
  // Cloned, not mutated: `edge` is also the rim teeth and the monoliths, and
  // making those double-sided is a silent cost nobody asked this line for.
  const underMat = edge.clone();
  underMat.side = THREE.DoubleSide;
  const under = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.18, 14, 64, 1, true), underMat);
  under.position.set(stage.origin.x, -7, stage.origin.z);
  stage.addMesh(under, { solid: false });

  // The rim. **Serrated, not machined.** The first pass was a smooth torus and
  // photographed as "a clean, unbroken, machined magenta tube" — a collapse
  // that leaves the rim looking lathed is not a collapse. This is 96 tapered
  // teeth of broken slab at alternating lengths and tilts, with the emissive
  // band threaded behind them, so the edge is a fracture line at any radius.
  //
  // The first version of this block drew nothing at all, for four independent
  // reasons, and the 4x rim crop of
  // `reviews/round6/audfix-pre-full/realms/26-finale-phase2.png` shows the
  // smooth band it was written to break up:
  //
  //  1. every tooth sat at 0.970-0.990 of the floor radius, i.e. *inside* the
  //     opaque floor disc;
  //  2. `y` ran -0.12..-0.02 against a floor disc at exactly y = 0, so what was
  //     not inside the disc was under it;
  //  3. `onFloorRadius` scales X and Z by 34 and leaves Y at 1, so a cone whose
  //     Y extent is its own 0.02-0.03 radius came out 2-3 cm tall and a metre
  //     wide;
  //  4. `mergeParts` applies rotateY *before* rotateZ, so the per-tooth `ry`
  //     turned a cone that still pointed along +Y — a no-op — and the shared
  //     `rz: pi/2` then swung all 96 axes to world -X together.
  //
  // So the rotations are baked here, in order, and handed to `mergeParts` as a
  // finished geometry with only a translation left to apply. Y is pre-scaled by
  // `R` to cancel the hook's anisotropy, which is exact at the phase-1 radius
  // and leaves the teeth slightly taller than wide once the floor has collapsed
  // — the right way for that error to point on a rim made of broken slab.
  const teeth = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    // Deterministic jitter — no RNG in a realm builder, ever.
    const j = Math.sin(i * 12.9898) * 43758.5453;
    const f = j - Math.floor(j);
    // Unit-space, so `onFloorRadius` carries them: 1.5-3.4 m long and
    // 1.8-2.6 m across at R = 34, against a 2.2 m tooth pitch.
    const len = 0.045 + f * 0.055;
    const rad = 0.026 + f * 0.012;
    const g = new THREE.ConeGeometry(rad, len, 4);
    // +Y axis -> +X, tip outward, with a per-tooth pitch so the rim is not a
    // single lathed bevel. Then swung to bearing `a` (matching the `ry: -a`
    // convention used everywhere else in this file).
    g.rotateZ(-Math.PI * 0.5 + (f - 0.5) * 0.55);
    g.rotateX((f - 0.5) * 0.8);
    g.rotateY(-a);
    // Cancel the hook's X/Z-only scale so the tooth is not a ribbon. 0.55 keeps
    // it wider than it is tall, which is what broken slab looks like.
    g.scale(1, R * 0.55, 1);
    // Rooted just inside the lip and projecting past it: `len * 0.35` of the
    // tooth is buried in the floor disc and the rest overhangs the void, which
    // is the part that has to break the silhouette.
    const seat = 1 - len * 0.35 + len * 0.5;
    teeth.push({ g, x: Math.cos(a) * seat, y: -0.10 - f * 0.30, z: Math.sin(a) * seat });
  }
  const rimTeeth = new THREE.Mesh(mergeParts(teeth), edge);
  rimTeeth.position.set(stage.origin.x, 0.02, stage.origin.z);
  rimTeeth.castShadow = true;
  stage.addMesh(rimTeeth, { solid: false });

  const rim = new THREE.Mesh((() => {
    const g = new THREE.TorusGeometry(0.985, 0.016, 6, 96);
    g.rotateX(Math.PI / 2);
    return g;
  })(), rift);
  rim.position.set(stage.origin.x, 0.12, stage.origin.z);
  stage.addMesh(rim, { solid: false });

  // Scaling hook — RealmStage owns `floorRadius`, and these follow it.
  stage.onFloorRadius = (r) => {
    under.scale.set(r, 1, r);
    rim.scale.set(r, 1, r);
    rimTeeth.scale.set(r, 1, r);
    veinMesh.scale.set(r, 1, r);
  };

  // Rift veins across the floor. Radial, so they point at the middle from
  // anywhere — a readability aid disguised as decoration.
  //
  // Built at *unit* scale and scaled with the floor, because the first pass
  // baked them at the phase-1 radius and after the collapse nine bright bars
  // were left hanging out over the void, which read as the floor still being
  // there. They are also much thinner than the first pass: at 0.22 m and
  // emissive 2.8 they were the loudest thing in the frame.
  const veins = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.2;
    const len = 0.5 + (i % 3) * 0.16;
    veins.push({ g: box(len, 0.05, 0.006), x: Math.cos(a) * len * 0.5, y: 0, z: Math.sin(a) * len * 0.5, ry: -a });
  }
  const veinMesh = new THREE.Mesh(mergeParts(veins), rift);
  veinMesh.position.set(stage.origin.x, 0.04, stage.origin.z);
  stage.addMesh(veinMesh, { solid: false });
  // Only now that every follower exists: the hook closes over veinMesh.
  stage.onFloorRadius(R);

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

/**
 * The collapse, drawn.
 *
 * The critique of phase 2 was that the rule change of the whole fight was
 * communicated by a line of yellow HUD text: the rim was clean, there was no
 * fracture, no falling slab, no debris and no dust. This is that evidence —
 * a ring of slabs torn off between the old radius and the new one, which tip
 * outward, fall, and take a settling dust plane down with them.
 *
 * Returned as `{ update(dt) -> boolean, dispose() }` so the finale controller
 * owns its lifetime and the arena owns its look. Nothing here touches gameplay
 * RNG: the scatter is a hash of the slab index.
 */
export function spawnCollapseDebris(stage, fromR, toR, life = 3.4) {
  const N = 26;
  const slabs = [];
  const mat = rung('stone', 2.4, { color: 0x3a2c58, roughness: 0.7, metalness: 0.08, envMapIntensity: 1.4 });
  const dustMat = new THREE.MeshBasicMaterial({
    color: 0xc890ff, transparent: true, opacity: 0.30, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
  });
  const group = new THREE.Group();
  group.position.copy(stage.origin);
  stage.root.add(group);

  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const j = Math.sin(i * 78.233) * 43758.5453;
    const f = j - Math.floor(j);
    const r = toR + (fromR - toR) * (0.25 + f * 0.7);
    const w = (fromR - toR) * (0.28 + f * 0.34);
    const m = new THREE.Mesh(box(w, 0.55 + f * 0.5, 2.2 + f * 3.4), mat);
    m.position.set(Math.cos(a) * r, -0.2, Math.sin(a) * r);
    m.rotation.y = -a;
    m.castShadow = true;
    m.userData.spin = (f - 0.5) * 2.4;
    m.userData.out = 0.7 + f * 1.6;
    m.userData.vy = -1.2 - f * 2.0;
    m.userData.dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    group.add(m);
    slabs.push(m);
  }

  // The dust plane: one disc at the lip that fades and sinks. It is what makes
  // the collapse leave a mark on the *air* rather than only on the geometry.
  const dg = new THREE.CircleGeometry(fromR * 1.02, 48);
  dg.rotateX(-Math.PI / 2);
  const dust = new THREE.Mesh(dg, dustMat);
  dust.position.y = -0.4;
  group.add(dust);

  let t = 0;
  return {
    update(dt) {
      t += dt;
      const k = t / life;
      for (const m of slabs) {
        m.position.addScaledVector(m.userData.dir, m.userData.out * dt);
        m.userData.vy -= 16 * dt;
        m.position.y += m.userData.vy * dt;
        m.rotation.z += m.userData.spin * dt;
        m.rotation.x += m.userData.spin * 0.6 * dt;
      }
      dust.position.y = -0.4 - t * 2.2;
      dust.scale.setScalar(1 + t * 0.10);
      dustMat.opacity = Math.max(0, 0.30 * (1 - k * 1.25));
      return t < life;
    },
    dispose() {
      stage.root.remove(group);
      for (const m of slabs) m.geometry.dispose();
      dg.dispose();
      mat.dispose();
      dustMat.dispose();
    },
  };
}

const BUILDERS = {
  bazaar: buildBazaar,
  crucible: buildCrucible,
  vault: buildVault,
  fracture: buildFracture,
};

// The Hungering Fracture is the same arena further gone: the air and the
// Herald carry the difference, not the geometry.
BUILDERS['fracture-void'] = BUILDERS.fracture;

/** Build the arena for a realm onto its stage. */
export function buildArena(stage) {
  const b = BUILDERS[stage.realmId];
  if (b) b(stage);
  return stage;
}
