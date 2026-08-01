import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM_BY_ID, TIERS } from '../data/items.js';

/**
 * Every world object the player can walk up to and press E on, plus the item
 * orbs those objects spit out.
 *
 * This is driven by Progression rather than registered with the Engine
 * directly: interactables are owned by the current stage, so their lifetime is
 * the stage's lifetime and Progression is what knows when that ends.
 */

const PROMPT_RANGE = 4.0;
// Tall enough to clear the stage's terrain from anywhere on it.
const BEACON_HEIGHT = 70;
// How close the player has to get before a resting orb starts homing. Generous
// on purpose: walking past the chest you just opened has to collect the item.
const ORB_SEEK_RANGE = 4.5;

// Snapshot discriminator so a client can build the right view for a replicated
// interactable. Values are wire constants — append, never renumber.
// Chests carry their size in the type id rather than a separate field: the size
// changes the mesh, and a client that only learned "chest" would render every
// legendary as a small one.
const TYPE_ID = {
  chest: 1, multishop: 2, shrineChance: 3, shrineBlood: 4, teleporter: 5, portal: 6,
  chestLarge: 7, chestLegendary: 8,
};

const CHEST_TYPE = { small: TYPE_ID.chest, large: TYPE_ID.chestLarge, legendary: TYPE_ID.chestLegendary };

const TIER_BIAS = {
  small: { common: 80, uncommon: 20, legendary: 1 },
  large: { common: 0, uncommon: 80, legendary: 8 },
  legendary: { common: 0, uncommon: 0, legendary: 1 },
};

let nextId = 1;

// ------------------------------------------------------- shared prop resources
//
// A stage carries 6-20 chests plus shrines and terminals, and every one of them
// used to allocate its own boxes and its own materials. That put the whole
// interactable set on the geometry budget for no reason and made detailing them
// expensive. Everything that is not *animated per instance* now comes out of
// these two caches, which is what buys the extra parts below: a chest is nine
// primitives instead of two and still costs one geometry and two materials for
// the entire stage.
//
// Anything cached is stamped `userData.shared` and Interactable.dispose() steps
// over it — a stage teardown must not free a buffer the next stage's chests are
// still pointing at.

const _geoCache = new Map();
const _matCache = new Map();

function sharedGeo(key, build) {
  let g = _geoCache.get(key);
  if (!g) { g = build(); g.userData.shared = true; _geoCache.set(key, g); }
  return g;
}

function sharedMat(key, build) {
  let m = _matCache.get(key);
  if (!m) { m = build(); m.userData.shared = true; _matCache.set(key, m); }
  return m;
}

/**
 * The interactable material ladder, deliberately parallel to the world's
 * (Materials.js): cast iron is a real metal with a real specular, the stone
 * plinths are matte, and only the tinted parts glow. A chest that is one flat
 * roughness-0.7 grey box is the "uniform matte plastic" failure in miniature.
 *
 * Two rules the round-2 version broke, both of which produced black cutouts:
 *
 *  1. **Metalness never reaches 1.** At a true 1.0 the diffuse term is
 *     identically zero and the whole surface is the IBL — and an interactable
 *     is usually standing in a hollow, where the IBL is the dark ground half of
 *     the sky dome. IRON_DARK at 0.8/0x14181f measured RGB(62,38,35) on its lit
 *     arc with no pixel above L 169 anywhere on it. The ceiling is now 0.45-0.62
 *     depending on the rung, which keeps a real dielectric floor for the key and the hemisphere to
 *     model, and the envMap lift pays the reflective read back where there is
 *     sky to reflect.
 *  2. **Base colours are not near-black.** 0x232830 under a 0.92 metalness is
 *     0.08 diffuse of a 0.02-linear albedo: nothing. Cast iron reads dark
 *     because it is *rough and cool*, not because its albedo is 14/255.
 *
 * Roughness sits low across the whole ladder on purpose. GGX's peak scales as
 * roughness^-4, so 0.38 -> 0.24 is a ~6x brighter highlight — which is the
 * difference between a specular that survives the tone curve above L 200 and
 * one that lands at 180 and reads as "slightly lighter grey".
 */
const IRON = () => sharedMat('iron', () => new THREE.MeshStandardMaterial({
  color: 0x4c545f, roughness: 0.24, metalness: 0.62, envMapIntensity: 2.6, flatShading: true,
}));
const IRON_DARK = () => sharedMat('ironDark', () => new THREE.MeshStandardMaterial({
  color: 0x454d5a, roughness: 0.30, metalness: 0.45, envMapIntensity: 3.0, flatShading: true,
}));
// Polished, and deliberately *smooth*-shaded — the one material in the ladder
// that is not flat. It is only ever put on surfaces of revolution (basin rims,
// shrine collars), where an interpolated normal field sweeps every elevation and
// therefore contains the exact half vector for any sun/camera pair. That makes a
// highlight a property of the material rather than a coincidence of the mesh: at
// roughness 0.20 the GGX peak is ~136, so the ring clips white where it crosses
// the half vector and falls away within a few degrees either side.
const IRON_POLISH = () => sharedMat('ironPolish', () => new THREE.MeshStandardMaterial({
  color: 0x5f6774, roughness: 0.20, metalness: 0.60, envMapIntensity: 3.0,
}));
const STONE = () => sharedMat('stone', () => new THREE.MeshStandardMaterial({
  color: 0x646875, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.9, flatShading: true,
}));
const trimMat = (hex) => sharedMat(`trim${hex}`, () => new THREE.MeshStandardMaterial({
  color: hex, roughness: 0.18, metalness: 0.62, envMapIntensity: 2.4,
  emissive: hex, emissiveIntensity: 0.22, flatShading: true,
}));
const glowMat = (hex) => sharedMat(`glow${hex}`, () => new THREE.MeshStandardMaterial({
  color: 0x05070a, emissive: hex, emissiveIntensity: 2.4, roughness: 0.5,
}));

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

// ---------------------------------------------------------------- base class

class Interactable {
  constructor(ctx, position) {
    this.id = nextId++;
    this.ctx = ctx;
    this.position = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.radius = 2.2;
    this.used = false;
    this.enabled = true;
    this.cost = 0;

    // Snapshot fields. Interactables are replicated rather than regenerated so
    // a client sees exactly the chests the host has left unopened; `health`
    // carries availability, which is the only state a view needs.
    this.typeId = 0;
    this.yaw = 0;
    this.maxHealth = 1;
    this.netState = 0;
  }
  get health() { return this.available() ? 1 : 0; }
  prompt() { return this.cost > 0 ? `Open ($${this.cost})` : 'Use'; }
  available() { return this.enabled && !this.used; }
  interact() {}
  update(dt) {}
  dispose() {
    this.group.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      const m = o.material;
      if (!m) return;
      for (const mm of (Array.isArray(m) ? m : [m])) if (!mm.userData.shared) mm.dispose();
    });
  }
}

// -------------------------------------------------------------------- chests

/**
 * Body: a stone-set plinth, the iron carcass, four corner posts, two banding
 * straps and a lock plate. The parts exist for silhouette, not for detail — a
 * plain box has one outline and reads as a crate at any distance, whereas the
 * proud posts and straps break the top edge and give the key something to catch
 * on. All of it is one merged buffer per chest size.
 */
function chestBodyGeo(s) {
  const parts = [
    box(1.52 * s, 0.15 * s, 1.12 * s, 0, 0.075 * s, 0),              // plinth
    box(1.36 * s, 0.72 * s, 0.98 * s, 0, 0.51 * s, 0),               // carcass
    box(1.42 * s, 0.09 * s, 1.03 * s, 0, 0.30 * s, 0),               // lower strap
    box(1.42 * s, 0.09 * s, 1.03 * s, 0, 0.70 * s, 0),               // upper strap
    box(0.26 * s, 0.30 * s, 0.10 * s, 0, 0.60 * s, 0.52 * s),        // lock plate
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.14 * s, 0.80 * s, 0.14 * s, sx * 0.66 * s, 0.50 * s, sz * 0.47 * s));
      // Proud cap on each post. A flat-topped post ends the silhouette on the
      // same line as the carcass; a wider cap notches it, and its top face is a
      // small horizontal plane the key hits close to head-on — the brightest
      // thing on the chest and the reason the corners read at distance.
      parts.push(box(0.21 * s, 0.07 * s, 0.21 * s, sx * 0.66 * s, 0.925 * s, sz * 0.47 * s));
    }
  }
  // Hasp: two arms flanking the lock plate, so the front face has depth.
  for (const sx of [-1, 1]) {
    parts.push(box(0.07 * s, 0.42 * s, 0.07 * s, sx * 0.22 * s, 0.60 * s, 0.51 * s));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/** A barrel top, hinged at the back. Local origin sits on the body's top edge. */
function chestLidGeo(s) {
  // 16 segments, not 9. The lid is the chest's glossy rung (trimMat, roughness
  // 0.18) and the only curved surface on it, so it is where the one specular
  // highlight per chest has to come from; at 9 segments the barrel is a coarse
  // prism and the highlight either misses entirely or covers a whole facet.
  const dome = new THREE.CylinderGeometry(0.50 * s, 0.50 * s, 1.40 * s, 16, 1, false, 0, Math.PI);
  dome.rotateZ(Math.PI / 2);   // half-barrel opening downward, axis along X
  const parts = [
    dome,
    box(1.44 * s, 0.10 * s, 1.06 * s, 0, -0.04 * s, 0),              // rim under the barrel
    box(0.20 * s, 0.16 * s, 1.08 * s, 0, 0.34 * s, 0),               // spine band
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

class Chest extends Interactable {
  constructor(ctx, position, size, cost) {
    super(ctx, position);
    this.size = size;
    this.cost = cost;
    this.openT = -1;
    this.typeId = CHEST_TYPE[size] || TYPE_ID.chest;

    const tint = size === 'legendary' ? 0xf0453f : size === 'large' ? 0x49d67a : 0xc0c8d4;
    const scale = size === 'small' ? 1 : size === 'large' ? 1.35 : 1.5;

    const body = new THREE.Mesh(sharedGeo(`chestBody${size}`, () => chestBodyGeo(scale)), IRON());
    body.castShadow = true;
    body.receiveShadow = true;

    // The item light lives inside the carcass and is only revealed as the lid
    // swings, so opening a chest is a light event and not just an animation.
    this.glow = new THREE.Mesh(
      sharedGeo(`chestGlow${size}`, () => box(1.10 * scale, 0.06 * scale, 0.78 * scale, 0, 0.83 * scale, 0)),
      glowMat(tint)
    );

    this.lid = new THREE.Mesh(sharedGeo(`chestLid${size}`, () => chestLidGeo(scale)), trimMat(tint));
    this.lid.castShadow = true;
    // Pivot at the back edge so the lid hinges instead of floating.
    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(0, 0.87 * scale, -0.49 * scale);
    this.lid.position.set(0, 0.04 * scale, 0.49 * scale);
    this.lidPivot.add(this.lid);

    this.group.add(body, this.glow, this.lidPivot);
    this.radius = 2.2 * scale;
    this._scale = scale;
  }

  prompt() { return `${this.size === 'legendary' ? 'Legendary Chest' : this.size === 'large' ? 'Large Chest' : 'Chest'} ($${this.cost})`; }

  interact() {
    if (!this.ctx.items?.spendGold(this.cost)) return false;
    this.used = true;
    this.openT = 0;
    const id = this.ctx.items.rollItem(null, TIER_BIAS[this.size]);
    this.ctx.interactables.spawnOrb(this.position, id, 1.2 * this._scale);
    this.ctx.audio?.play?.('chest', this.position);
    return true;
  }

  update(dt) {
    if (this.openT < 0) return;
    this.openT = Math.min(1, this.openT + dt * 2.2);
    // Overshoot then settle — the little bounce is what sells the pop.
    const t = this.openT;
    const eased = 1 - Math.pow(1 - t, 3);
    this.lidPivot.rotation.x = -eased * 2.0 + Math.sin(t * Math.PI) * 0.35;
  }
}

// -------------------------------------------------------- multishop terminal

class MultishopTerminal extends Interactable {
  constructor(ctx, position, cost, group, index) {
    super(ctx, position);
    this.cost = cost;
    this.shopGroup = group;
    this.itemId = ctx.items.rollItem(null, TIER_BIAS.small);
    this.radius = 2.0;
    this.typeId = TYPE_ID.multishop;

    const def = ITEM_BY_ID.get(this.itemId);
    const tint = TIERS[def?.tier || 'common'].colour;
    // Foot, post, and a bezel that surrounds the display on three sides with a
    // hood over it. The hood matters more than it sounds: it puts the emissive
    // panel in its own small shadow, so the screen reads as lit-from-within
    // instead of as a coloured sticker on a box.
    const frame = new THREE.Mesh(sharedGeo('shopFrame', () => {
      const parts = [
        new THREE.CylinderGeometry(0.46, 0.58, 0.14, 8).translate(0, 0.07, 0),
        new THREE.CylinderGeometry(0.16, 0.22, 1.34, 8).translate(0, 0.81, 0),
        box(1.14, 0.14, 0.30, 0, 1.20, 0.02),        // shelf under the display
        box(0.14, 1.08, 0.26, -0.50, 1.72, 0.0),     // left bezel
        box(0.14, 1.08, 0.26, 0.50, 1.72, 0.0),      // right bezel
        box(1.14, 0.16, 0.42, 0, 2.20, 0.09),        // hood
        box(1.02, 0.94, 0.08, 0, 1.72, -0.10),       // backing plate
        // Lip along the hood's leading edge. A 6mm proud strip is the only
        // horizontal specular line on the terminal, and it is what stops the
        // hood reading as a shadow the frame happens to end in.
        box(1.20, 0.05, 0.07, 0, 2.10, 0.30),
      ];
      const g = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      return g;
    }), IRON());
    frame.castShadow = true;
    frame.receiveShadow = true;

    this.screen = new THREE.Mesh(
      sharedGeo('shopScreen', () => new THREE.BoxGeometry(0.86, 0.88, 0.10)),
      new THREE.MeshStandardMaterial({
        color: 0x0d1118, emissive: tint, emissiveIntensity: 0.9,
        roughness: 0.16, metalness: 0.0, envMapIntensity: 1.2,
      })
    );
    this.screen.position.set(0, 1.72, 0.02);
    this.group.add(frame, this.screen);
    this.group.rotation.y = (index / 3) * Math.PI * 2;
  }

  prompt() { return `${ITEM_BY_ID.get(this.itemId)?.name || 'Item'} ($${this.cost})`; }

  interact() {
    if (!this.ctx.items?.spendGold(this.cost)) return false;
    this.used = true;
    this.ctx.interactables.spawnOrb(this.position, this.itemId, 1.6);
    // Buying one terminal closes the others: the choice has to cost something.
    for (const t of this.shopGroup) {
      if (t === this) continue;
      t.used = true;
      t.enabled = false;
      t.screen.material.emissiveIntensity = 0;
      t.screen.material.color.setHex(0x0a0c10);
    }
    this.ctx.audio?.play?.('purchase', this.position);
    return true;
  }
}

// ------------------------------------------------------------------- shrines
//
// Both shrines are built as a stone substructure plus one animated emissive
// piece. Splitting them that way is what lets the base be genuinely matte rock
// while the offering above it is the only glossy thing in the silhouette —
// which is the roughness contrast the rest of the stage is being tuned for,
// applied at prop scale.

/** Stepped stone plinth: cap, drum, foot. */
function plinthGeo(r, sides) {
  const parts = [
    new THREE.CylinderGeometry(r * 1.20, r * 1.32, 0.16, sides).translate(0, 0.08, 0),
    new THREE.CylinderGeometry(r * 0.96, r * 1.08, 0.32, sides).translate(0, 0.32, 0),
    new THREE.CylinderGeometry(r * 1.08, r * 0.98, 0.14, sides).translate(0, 0.55, 0),
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/** Broken columns leaning in around the plinth rim — the "ruined site" read. */
function shrineColumnsGeo(r, count, seedPhase) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + seedPhase;
    const h = 0.75 + ((i * 7) % 5) * 0.16;
    const c = new THREE.CylinderGeometry(0.10, 0.15, h, 5).translate(0, h * 0.5, 0);
    const m = new THREE.Matrix4()
      .makeRotationZ(-0.16)
      .premultiply(new THREE.Matrix4().makeRotationY(-a))
      .setPosition(Math.cos(a) * r, 0.55, Math.sin(a) * r);
    parts.push(c.applyMatrix4(m));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/** A shard cluster rather than a single octahedron: three facets, one peak. */
function shardClusterGeo() {
  const parts = [];
  const spec = [[0, 0, 1.0, 0], [0.26, 0.10, 0.62, 0.5], [-0.20, -0.16, 0.5, 2.1]];
  for (const [x, z, s, tilt] of spec) {
    const o = new THREE.OctahedronGeometry(0.5, 0);
    o.scale(0.55 * s, 1.35 * s, 0.55 * s);
    const m = new THREE.Matrix4().makeRotationZ(tilt * 0.16)
      .premultiply(new THREE.Matrix4().makeRotationY(tilt))
      .setPosition(x, 0, z);
    parts.push(o.applyMatrix4(m));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * The blood spike.
 *
 * The thing this replaces was `ConeGeometry(0.34, 1.5, 6)` under an emissive
 * that carried ~88% of every pixel, and it measured as a flat vector triangle:
 * left-half mean R 205.2 against right-half 205.1 — a 0.05% shading gradient
 * across a cone — with 61.7% of its pixels at G exactly 0. Three things were
 * wrong and all three are geometry-or-material, not grade:
 *
 *  - **Nothing to shade.** A normal-independent emissive constant is the same
 *    value on every facet by definition, so `flatShading` had nothing to do.
 *    The emissive is now 0.10 rather than 0.5 and the *lit* term carries the
 *    read, which is what puts a Lambert ramp back across the form.
 *  - **Nothing to shade it on.** Six facets on a smooth taper is one silhouette
 *    and two visible planes. This is a socket, a tapered octagonal shaft, a
 *    flared shoulder that undercuts, a twelve-sided blade and three barbs — so
 *    there are hard plane breaks at three heights, an edge at the shoulder for
 *    the key to catch, and a silhouette that is not a triangle.
 *  - **No material response.** The blade is dry, faceted, roughness 0.42; the
 *    sheath over its lower half and the pool in the basin are the same substance
 *    *wet*, smooth-shaded at roughness 0.05. Smooth shading is deliberate on the
 *    sheath: a continuous normal field means some band of it always satisfies
 *    the half-vector, so the specular break exists from any bearing rather than
 *    only when a facet happens to line up.
 *
 * Albedo green is 0x43 rather than 0x1f for a measured reason: the grade applies
 * saturation after its toe and clamps to zero, so a channel that starts under
 * ~0.02 linear is driven to hard 0 and the shrine channel-clips. 0x43 lands the
 * green around 36/255 after the lit term, which is clear of the clamp.
 */
function bloodSpikeGeo() {
  const parts = [
    new THREE.CylinderGeometry(0.30, 0.44, 0.20, 10).translate(0, 0.10, 0),   // socket
    new THREE.CylinderGeometry(0.215, 0.30, 0.60, 8).translate(0, 0.50, 0),   // shaft
    new THREE.CylinderGeometry(0.28, 0.215, 0.11, 8).translate(0, 0.855, 0),  // shoulder
    new THREE.ConeGeometry(0.24, 1.02, 12).translate(0, 1.42, 0),             // blade
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.55;
    parts.push(new THREE.ConeGeometry(0.075, 0.44, 5)
      .rotateZ(-1.0).rotateY(-a)
      .translate(Math.cos(a) * 0.235, 0.96, Math.sin(a) * 0.235));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * The wet half: a sheath run down the shaft, a drip collar under the blade, and
 * the pool in the basin.
 *
 * The profiles are *convex and smooth-shaded*, and that is the whole engineering
 * of the highlight. A straight cone of revolution has exactly one normal
 * elevation, so unless the half vector happens to sit at that elevation nothing
 * on it is anywhere near the specular peak — at roughness 0.05 the lobe is about
 * three degrees wide, so "nearly aligned" is the same as "black". That is the
 * shape of the round-2 failure: a low roughness on simple geometry produces no
 * highlight at all rather than a bright one.
 *
 * A bulged lathe sweeps its normal elevation continuously across the profile and
 * the collar is a torus, which sweeps the full 360 degrees; between them there is
 * a point at the exact half vector for *any* sun and camera, so the highlight is
 * guaranteed rather than lucky, and at roughness 0.05 it is a hard bright break
 * a few pixels wide — which is what wet reads as.
 */
function bloodSlickGeo() {
  const profile = [
    [0.235, 0.18], [0.292, 0.30], [0.322, 0.44],
    [0.312, 0.58], [0.268, 0.71], [0.238, 0.80],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const parts = [
    new THREE.LatheGeometry(profile, 16),
    new THREE.TorusGeometry(0.252, 0.058, 10, 24).rotateX(Math.PI / 2).translate(0, 0.90, 0),
    new THREE.CircleGeometry(0.50, 16).rotateX(-Math.PI / 2).translate(0, -0.115, 0),
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

class ShrineOfChance extends Interactable {
  constructor(ctx, position, cost) {
    super(ctx, position);
    this.cost = cost;
    this.uses = 0;
    this.maxUses = 3;
    this.spin = 0;
    this.typeId = TYPE_ID.shrineChance;

    const base = new THREE.Mesh(sharedGeo('shrineBase', () => plinthGeo(1.1, 10)), STONE());
    const cols = new THREE.Mesh(sharedGeo('shrineCols', () => shrineColumnsGeo(1.02, 5, 0.4)), STONE());
    // One iron collar between the stone and the offering: a hard specular band
    // that separates the two matte-vs-glossy halves of the silhouette.
    const collar = new THREE.Mesh(
      sharedGeo('shrineCollar', () => new THREE.TorusGeometry(0.62, 0.08, 12, 30).rotateX(Math.PI / 2).translate(0, 0.70, 0)),
      IRON_POLISH()
    );
    base.castShadow = cols.castShadow = collar.castShadow = true;
    base.receiveShadow = true;

    this.crystal = new THREE.Mesh(
      sharedGeo('shard', shardClusterGeo),
      new THREE.MeshStandardMaterial({
        // Same correction as the blood spike, one rung down: the emissive was
        // carrying most of the pixel value and flattening the shards. 0.45 lets
        // the lit term model the facets while the offering still glows.
        color: 0xffd23f, emissive: 0xffa000, emissiveIntensity: 0.45,
        roughness: 0.09, metalness: 0.0, envMapIntensity: 2.6, flatShading: true,
      })
    );
    this.crystal.position.y = 1.5;
    this.crystal.castShadow = true;
    this.group.add(base, cols, collar, this.crystal);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() { return `Shrine of Chance ($${this.cost})`; }

  interact() {
    if (!this.ctx.items?.spendGold(this.cost)) return false;
    this.uses++;
    // 1-in-4 base; luck grants extra rolls exactly like a chance-on-hit item,
    // which is what makes Clover a shrine item as well as a combat item.
    const win = this.ctx.items.roll(0.25, 1);
    if (win) {
      const id = this.ctx.items.rollItem(null, TIER_BIAS.small);
      this.ctx.interactables.spawnOrb(this.position, id, 2.0);
      this.ctx.vfx?.burst?.(this.position, 0xffd23f);
      this.ctx.audio?.play?.('shrineWin', this.position);
    } else {
      this.ctx.vfx?.burst?.(this.position, 0x5a6070);
      this.ctx.audio?.play?.('shrineFail', this.position);
    }
    if (this.uses >= this.maxUses) this.crystal.material.emissiveIntensity = 0.05;
    // Cost climbs so a shrine can't be farmed with one big purse.
    this.cost = Math.round(this.cost * 1.4);
    return true;
  }

  update(dt) {
    this.spin += dt * (this.available() ? 1.6 : 0.2);
    this.crystal.rotation.y = this.spin;
    this.crystal.position.y = 1.5 + Math.sin(this.spin * 1.5) * 0.12;
  }
}

class ShrineOfBlood extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.uses = 0;
    this.maxUses = 2;
    this.stageIndex = stageIndex;
    this.typeId = TYPE_ID.shrineBlood;

    const base = new THREE.Mesh(sharedGeo('bloodBase', () => plinthGeo(1.0, 8)), STONE());
    // An open basin the spike stands in, with four buttresses. The basin is the
    // read that tells you this shrine takes something rather than gives it.
    const basin = new THREE.Mesh(sharedGeo('bloodBasin', () => {
      const parts = [
        new THREE.CylinderGeometry(0.78, 0.52, 0.42, 8, 1, true).translate(0, 0.90, 0),
        new THREE.CylinderGeometry(0.53, 0.53, 0.05, 8).translate(0, 0.71, 0),
      ];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        parts.push(box(0.10, 0.44, 0.22, 0, 0, 0)
          .rotateY(-a).translate(Math.cos(a) * 0.66, 0.90, Math.sin(a) * 0.66));
      }
      const g = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      return g;
    }), IRON_DARK());
    // The rim is split out of the merged basin and given the polished, smooth
    // rung. Merged into the flat-shaded drum it was four radial segments of
    // near-black metal at metalness 0.8, which measured RGB(62,38,35) with no
    // pixel above L 169 anywhere on it; as its own smooth torus it is the piece
    // of the shrine that carries the specular.
    const rim = new THREE.Mesh(
      sharedGeo('bloodRim', () => new THREE.TorusGeometry(0.78, 0.075, 12, 32)
        .rotateX(Math.PI / 2).translate(0, 1.11, 0)),
      IRON_POLISH()
    );
    base.castShadow = basin.castShadow = rim.castShadow = true;
    base.receiveShadow = true;

    // Per-instance materials, not shared ones: `interact()` dims the emissive
    // when the shrine is spent, and a shared material would dim every shrine a
    // client has ever built.
    this.spike = new THREE.Mesh(
      sharedGeo('bloodSpike', bloodSpikeGeo),
      new THREE.MeshStandardMaterial({
        color: 0xb8434a, emissive: 0xd02f3e, emissiveIntensity: 0.10,
        roughness: 0.42, metalness: 0.0, envMapIntensity: 1.5, flatShading: true,
      })
    );
    this.slick = new THREE.Mesh(
      sharedGeo('bloodSlick', bloodSlickGeo),
      new THREE.MeshStandardMaterial({
        color: 0x8a3a3f, emissive: 0x7a2028, emissiveIntensity: 0.07,
        roughness: 0.05, metalness: 0.10, envMapIntensity: 3.4,
        side: THREE.DoubleSide,
      })
    );
    this.spike.castShadow = true;
    // Both halves turn together, so the specular break travels round the form
    // rather than sitting still on one facet.
    this.spin = new THREE.Group();
    this.spin.position.y = 0.86;
    this.spin.add(this.spike, this.slick);
    this.group.add(base, basin, rim, this.spin);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() { return 'Shrine of Blood (pay 40% health)'; }

  interact() {
    const p = this.ctx.player;
    if (!p?.alive) return false;
    const max = p.stats?.maxHealth || p.maxHealth || 100;
    const cost = max * 0.4;
    // Never lethal — the shrine is a gamble on time-to-heal, not on dying.
    if (p.health <= cost + 1) return false;
    this.uses++;
    this.ctx.combat?.applyDamage(p, cost, {
      source: null, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'shrine',
      position: this.position,
    });
    const payout = Math.round((cost * 1.2 + 25) * Math.pow(1.2, this.stageIndex));
    this.ctx.items?.addGold(payout);
    this.ctx.vfx?.burst?.(this.position, 0xd0203a);
    this.ctx.audio?.play?.('shrineBlood', this.position);
    if (this.uses >= this.maxUses) {
      this.spike.material.emissiveIntensity = 0.02;
      this.slick.material.emissiveIntensity = 0.0;
    }
    return true;
  }

  update(dt) { this.spin.rotation.y += dt * 0.6; }
}

// ---------------------------------------------------------------- teleporter

class Teleporter extends Interactable {
  constructor(ctx, position) {
    super(ctx, position);
    this.radius = 3.0;
    this.chargeRadius = 12;
    this.progress = 0;
    this.state = 'idle'; // idle -> charging -> complete
    this.typeId = TYPE_ID.teleporter;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 2.6, 0.5, 16),
      new THREE.MeshStandardMaterial({ color: 0x2c3340, roughness: 0.7, metalness: 0.4 })
    );
    base.position.y = 0.25;

    this.ringGeo = new THREE.TorusGeometry(2.0, 0.14, 8, 48, Math.PI * 2);
    this.ring = new THREE.Mesh(this.ringGeo, new THREE.MeshStandardMaterial({
      color: 0x2ad0ff, emissive: 0x2ad0ff, emissiveIntensity: 1.2, roughness: 0.2,
    }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.7;
    // The arc is drawn by the draw range, so charge progress is literally the
    // ring closing on itself.
    this.ring.geometry.setDrawRange(0, 0);

    this.pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 3.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x101820, emissive: 0x2ad0ff, emissiveIntensity: 0.4 })
    );
    this.pillar.position.y = 1.5;

    // Findability. The teleporter is one prop on a 220m stage and the whole
    // objective is to go and press E on it, so it carries a beacon column tall
    // enough to clear the terrain between here and anywhere, plus a static
    // collar ring so the base still reads once you are close.
    //
    // Both are opaque emissive MeshStandardMaterials on purpose. A transparent
    // or additive material is a new shader permutation, and a PointLight would
    // change numPointLights and fork *every* program in the scene; these reuse
    // the permutation the pillar and the charge ring already compiled. Bloom
    // does the glow work for free because the emissive runs well above 1.
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.9, BEACON_HEIGHT, 8, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x0a2b3a, emissive: 0x2ad0ff, emissiveIntensity: 2.4, roughness: 0.4,
      })
    );
    this.beacon.position.y = BEACON_HEIGHT * 0.5 + 2.0;

    this.collar = new THREE.Mesh(
      new THREE.TorusGeometry(3.4, 0.22, 6, 28),
      new THREE.MeshStandardMaterial({
        color: 0x102a36, emissive: 0x2ad0ff, emissiveIntensity: 1.6, roughness: 0.3,
      })
    );
    this.collar.rotation.x = -Math.PI / 2;
    this.collar.position.y = 0.12;

    this.group.add(base, this.ring, this.pillar, this.beacon, this.collar);
  }

  available() { return this.state === 'idle'; }
  prompt() { return 'Activate Teleporter'; }

  interact() {
    if (this.state !== 'idle') return false;
    this.state = 'charging';
    this.ctx.audio?.play?.('teleporterStart', this.position);
    return true;
  }

  setProgress(t) {
    this.progress = t;
    const count = this.ringGeo.index ? this.ringGeo.index.count : 0;
    this.ring.geometry.setDrawRange(0, Math.floor(count * t));
  }

  update(dt) {
    const active = this.state === 'charging';
    this.ring.rotation.z += dt * (active ? 1.4 : 0.2);
    const pulse = active ? 1.2 + Math.sin(this.ctx.time * 6) * 0.5 : 0.4;
    this.pillar.material.emissiveIntensity = this.state === 'complete' ? 2.2 : pulse;

    // The beacon breathes while the teleporter is waiting to be found, burns
    // steady while it charges, and dims to a marker once the event is over so a
    // cleared stage stops shouting. Emissive intensity only — the meshes are
    // never toggled, so the draw count and the shader cache both stay put.
    const breathe = 0.5 + Math.sin(this.ctx.time * 1.6) * 0.5;
    const k = this.state === 'complete' ? 0.25
      : active ? 1.15
      : 0.7 + breathe * 0.6;
    this.beacon.material.emissiveIntensity = 2.4 * k;
    this.collar.material.emissiveIntensity = 1.6 * k;
  }
}

// -------------------------------------------------------------------- portal

class Portal extends Interactable {
  constructor(ctx, position, onEnter) {
    super(ctx, position);
    this.onEnter = onEnter;
    this.radius = 2.5;
    this.spin = 0;
    this.typeId = TYPE_ID.portal;

    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.8, 24),
      new THREE.MeshBasicMaterial({ color: 0x9b5cff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
    );
    this.disc.position.y = 2.0;
    this.frame = new THREE.Mesh(
      new THREE.TorusGeometry(1.85, 0.12, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0x9b5cff, emissive: 0x9b5cff, emissiveIntensity: 1.6, roughness: 0.2 })
    );
    this.frame.position.y = 2.0;
    this.light = new THREE.PointLight(0x9b5cff, 4, 16);
    this.light.position.y = 2.0;
    this.group.add(this.disc, this.frame, this.light);
  }

  prompt() { return 'Enter Portal'; }

  interact() {
    this.used = true;
    this.onEnter?.();
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.frame.rotation.z = this.spin * 0.8;
    // Billboard the disc so the portal always reads as a doorway, never as a
    // flat sliver seen edge-on.
    this.disc.quaternion.copy(this.ctx.camera.quaternion);
    this.frame.rotation.x = 0;
    this.light.intensity = 4 + Math.sin(this.spin * 3) * 1.5;
  }
}

// ------------------------------------------------------------------ item orb

class ItemOrb {
  constructor(ctx, position, itemId, arc) {
    this.ctx = ctx;
    this.itemId = itemId;
    this.def = ITEM_BY_ID.get(itemId);
    this.position = position.clone().add(new THREE.Vector3(0, 1.2, 0));
    // Which way the orb is tossed is decoration — the item it carries was
    // already decided off the gameplay stream, and it always homes to the
    // player in the end. Drawing it from `rng` would shift every later roll.
    this.velocity = new THREE.Vector3(
      ctx.fxRng.range(-1, 1) * arc, 6 + arc, ctx.fxRng.range(-1, 1) * arc
    );
    this.state = 'arc';
    this.age = 0;
    this.hover = 0;
    this.claimed = false;

    const colour = TIERS[this.def?.tier || 'common'].colour;
    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 0),
      new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 1.4, roughness: 0.25 })
    );
    this.halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 10),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.16, depthWrite: false })
    );
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.halo);
    this.group.position.copy(this.position);
    this.light = new THREE.PointLight(colour, 2.5, 8);
    this.group.add(this.light);
  }

  fixedUpdate(h) {
    this.age += h;
    const player = this.ctx.player;

    if (this.state === 'arc') {
      this.velocity.y -= 26 * h;
      this.position.addScaledVector(this.velocity, h);
      const ground = this.ctx.stage?.sampleHeight?.(this.position.x, this.position.z) ?? 0;
      if (this.position.y <= ground + 1.1 && this.velocity.y < 0) {
        this.position.y = ground + 1.1;
        this.hoverBase = this.position.y;
        this.state = 'hover';
      }
    } else if (this.state === 'hover') {
      this.hover += h;
      this.position.y = this.hoverBase + Math.sin(this.hover * 2.2) * 0.18;
      if (player?.alive && player.position.distanceToSquared(this.position) < ORB_SEEK_RANGE * ORB_SEEK_RANGE) this.state = 'seek';
    } else if (this.state === 'seek' && player) {
      // Accelerating homing so the pickup reads as being *pulled* in.
      const dir = TMP.copy(player.position).setY(player.position.y + 1).sub(this.position);
      const dist = dir.length();
      if (dist < 0.7) { this.claimed = true; return; }
      dir.multiplyScalar(1 / dist);
      this.position.addScaledVector(dir, Math.min(26, 8 + this.age * 14) * h);
    }
    this.group.position.copy(this.position);
  }

  update(dt) {
    this.mesh.rotation.y += dt * 2.0;
    this.mesh.rotation.x += dt * 1.1;
    const s = 1 + Math.sin(this.ctx.time * 4) * 0.08;
    this.halo.scale.setScalar(s);
  }

  dispose() {
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.halo.geometry.dispose(); this.halo.material.dispose();
  }
}

const TMP = new THREE.Vector3();

// -------------------------------------------------------------------- system

export class Interactables {
  constructor() {
    this.list = [];
    this.orbs = [];
    this.root = new THREE.Group();
    this.teleporter = null;
    this.focus = null;
    this._lastPrompt = null;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.interactables = this;
    ctx.scene.add(this.root);
  }

  /** Wipes the stage's interactables. Called on every stage transition. */
  clear() {
    for (const i of this.list) { this.root.remove(i.group); i.dispose(); }
    for (const o of this.orbs) { this.root.remove(o.group); o.dispose(); }
    this.list.length = 0;
    this.orbs.length = 0;
    this.teleporter = null;
    this.focus = null;
  }

  add(obj) {
    this.list.push(obj);
    this.root.add(obj.group);
    return obj;
  }

  _point(minDistFrom) {
    return this.ctx.stage?.randomWalkablePoint?.(this.ctx.rng, { minDistFrom, minDist: 8 })
      || new THREE.Vector3(this.ctx.rng.range(-40, 40), 0, this.ctx.rng.range(-40, 40));
  }

  /**
   * A walkable point in the annulus `[r0, r1]` around a landmark, or null.
   *
   * Everything on the stage used to be sited by `randomWalkablePoint` over the
   * whole basin, which is uniform by construction: a player who has found one
   * chest has learned nothing about where the next one is, and a wide framing
   * gets an even sprinkle of props with no reason for any of them to be where
   * it is. Siting the interactables in rings around the kit's 2-3 landmarks
   * makes the landmarks worth walking to, gives every chest a backdrop, and
   * gives the composition a subject and a foreground in the same frame.
   *
   * All of it draws from `ctx.rng`, so a co-op client that regenerates the
   * stage and replays the same stream lands on the same chests.
   */
  _nearLandmark(lm, r0, r1) {
    const st = this.ctx.stage, rng = this.ctx.rng;
    if (!lm || !st?.isWalkable) return null;
    for (let i = 0; i < 40; i++) {
      const a = rng.range(0, Math.PI * 2);
      // sqrt keeps the ring area-uniform rather than crowding the inner edge.
      const rad = Math.sqrt(r0 * r0 + rng.next() * (r1 * r1 - r0 * r0));
      const x = lm.x + Math.cos(a) * rad, z = lm.z + Math.sin(a) * rad;
      if (Math.abs(x) > st.bound || Math.abs(z) > st.bound) continue;
      if (!st.isWalkable(x, z, 1.6)) continue;
      return new THREE.Vector3(x, st.sampleHeight(x, z), z);
    }
    return null;
  }

  /** Ring placement if the stage has landmarks, uniform scatter if it doesn't. */
  _sited(lm, r0, r1, fallbackFrom) {
    return this._nearLandmark(lm, r0, r1) || this._point(fallbackFrom);
  }

  /**
   * Fills a freshly built stage. Count and price both scale with stage index:
   * later stages have more to buy and charge more for it, which is what keeps
   * gold pressure constant while the player's income explodes.
   */
  populate(stageIndex) {
    this.clear();
    const ctx = this.ctx;
    const scale = Math.pow(1.25, stageIndex);
    const spawn = ctx.player?.position || new THREE.Vector3();
    const marks = ctx.stage?.landmarks ?? [];
    // Round-robin rather than random, so all 2-3 landmarks get loot and the
    // player is never rewarded for visiting only the nearest one.
    const mark = (i) => (marks.length ? marks[i % marks.length] : null);

    // Sacrifice takes the shops away — everything purchasable, not just chests,
    // or the artifact's premise ("nothing is bought") survives as three
    // terminals in a field. Shrines stay: they cost health or risk, not gold,
    // and the teleporter is the run, not loot.
    const bought = !ctx.artifacts?.has('sacrifice');

    const chestCount = bought ? 6 + stageIndex * 2 : 0;
    for (let i = 0; i < chestCount; i++) {
      const roll = ctx.rng.next();
      const size = roll > 0.94 ? 'legendary' : roll > 0.75 ? 'large' : 'small';
      const base = size === 'legendary' ? 400 : size === 'large' ? 125 : 25;
      const m = mark(i);
      // The better the chest, the tighter it sits to the structure — a
      // legendary tucked against the landmark's own footing is a reward for
      // having gone there, where one out at 30m is just a chest in a field.
      const near = size === 'small' ? 1.0 : 0.45;
      const pos = this._sited(m, (m?.r ?? 0) + 4, (m?.r ?? 0) + 6 + 22 * near, spawn);
      this.add(new Chest(ctx, pos, size, Math.round(base * scale)));
    }

    const shopCount = bought ? 1 + Math.floor(stageIndex / 2) : 0;
    for (let s = 0; s < shopCount; s++) {
      // Terminals go *between* two landmarks rather than at either, so the
      // walk between the stage's two anchors has a reason to be taken.
      const a = mark(s), b = mark(s + 1);
      let centre = null;
      if (a && b && a !== b) {
        const mid = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5, r: 0 };
        centre = this._nearLandmark(mid, 0, 14);
      }
      centre = centre || this._sited(a, (a?.r ?? 0) + 6, (a?.r ?? 0) + 20, spawn);
      const group = [];
      for (let i = 0; i < 3; i++) {
        const offset = new THREE.Vector3(Math.cos((i / 3) * Math.PI * 2) * 2.4, 0, Math.sin((i / 3) * Math.PI * 2) * 2.4);
        const t = new MultishopTerminal(ctx, centre.clone().add(offset), Math.round(50 * scale), group, i);
        group.push(t);
        this.add(t);
      }
    }

    // Shrines get the landmarks the chests do not lead with, and sit close in —
    // a shrine is a destination and reads best with mass directly behind it.
    if (ctx.rng.next() < 0.7) {
      this.add(new ShrineOfChance(ctx, this._sited(mark(1), (mark(1)?.r ?? 0) + 3.5, (mark(1)?.r ?? 0) + 11, spawn),
        Math.round(35 * scale)));
    }
    if (ctx.rng.next() < 0.5) {
      this.add(new ShrineOfBlood(ctx, this._sited(mark(2), (mark(2)?.r ?? 0) + 3.5, (mark(2)?.r ?? 0) + 11, spawn),
        stageIndex));
    }

    this.teleporter = new Teleporter(ctx, this._teleporterSite(marks, spawn));
    this.add(this.teleporter);
    return this.teleporter;
  }

  /**
   * Where the teleporter goes.
   *
   * The one thing on the stage that has to be *findable* and that the player
   * will fight a boss on top of, so it wants open ground — but open ground with
   * the primary landmark standing behind it, because the teleporter event is
   * the run's set piece and a set piece needs a backdrop. Sited on the line
   * from the first landmark toward the basin centre, which is the sight line
   * every wide framing already looks down.
   */
  _teleporterSite(marks, spawn) {
    const st = this.ctx.stage;
    const lm = marks[0];
    if (lm && st?.isWalkable) {
      const a = Math.atan2(-lm.z, -lm.x);   // inward, toward the basin centre
      for (let i = 0; i < 26; i++) {
        const d = lm.r + 12 + i * 1.6;
        const th = a + this.ctx.rng.range(-0.5, 0.5);
        const x = lm.x + Math.cos(th) * d, z = lm.z + Math.sin(th) * d;
        if (Math.abs(x) > st.bound || Math.abs(z) > st.bound) continue;
        if (!st.isWalkable(x, z, 3.4)) continue;
        return new THREE.Vector3(x, st.sampleHeight(x, z), z);
      }
    }
    return this._point(spawn);
  }

  spawnPortal(position, onEnter) {
    return this.add(new Portal(this.ctx, position, onEnter));
  }

  spawnOrb(position, itemId, arc = 1.5) {
    // A dud orb is worse than no orb: it plays the whole pop-and-fly animation
    // and then gives nothing, which reads exactly like "the chest ate my gold".
    // The only way to get here with a bad id is a roll that had no pool, so
    // fail visibly at the source instead.
    if (!itemId || !ITEM_BY_ID.has(itemId)) return null;
    const orb = new ItemOrb(this.ctx, position, itemId, arc);
    this.orbs.push(orb);
    this.root.add(orb.group);
    return orb;
  }

  fixedUpdate(ctx, h) {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      orb.fixedUpdate(h);
      if (!orb.claimed) continue;
      ctx.items?.give(orb.itemId, 1);
      ctx.vfx?.burst?.(orb.position, TIERS[orb.def?.tier || 'common'].colour);
      this.root.remove(orb.group);
      orb.dispose();
      this.orbs[i] = this.orbs[this.orbs.length - 1];
      this.orbs.pop();
    }

    this._updateFocus(ctx);
    // Pressing E is a *request*: it rides the command stream as BTN.INTERACT
    // and only the host turns it into an opened chest.
    if (ctx.player?.interactPressed) this.requestInteract(ctx.player);
  }

  /**
   * Resolve one pawn's interact request. Host only — the result reaches
   * clients as the events the interaction itself emits (item pickups, gold,
   * teleporter charge).
   */
  requestInteract(pawn) {
    if (!this.ctx.authority || !pawn) return false;
    const target = this._nearest(pawn);
    if (!target) return false;
    return !!target.interact();
  }

  /** Nearest available interactable within prompt range of `entity`. */
  _nearest(entity) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const it = this.list[i];
      if (!it.available()) continue;
      const d = it.position.distanceToSquared(entity.position);
      const range = it.radius + PROMPT_RANGE;
      if (d > range * range || d >= bestD) continue;
      bestD = d;
      best = it;
    }
    return best;
  }

  /** The host's snapshot feed for this stage's props. */
  replicable() { return this.list; }

  _updateFocus(ctx) {
    const p = ctx.player;
    if (!p) { this.focus = null; return; }
    const best = this._nearest(p);
    this.focus = best;

    // Only push to the HUD when the prompt actually changes — this runs at
    // 60Hz and the HUD does DOM work.
    const text = best ? best.prompt() : null;
    if (text !== this._lastPrompt) {
      this._lastPrompt = text;
      ctx.hud?.setPrompt?.(text);
      ctx.events.emit('prompt', { text, target: best });
    }
  }

  update(ctx, dt) {
    for (let i = 0; i < this.list.length; i++) this.list[i].update(dt);
    for (let i = 0; i < this.orbs.length; i++) this.orbs[i].update(dt);
  }
}

// ---------------------------------------------------------------- client views

/**
 * Rebuild one replicated prop client-side.
 *
 * A client's stage is regenerated from the host's seed but its *contents* are
 * not re-rolled (`Progression` clears them on `stageStart`), so every chest and
 * shrine a client sees arrives through here. The object is a real Interactable
 * — it renders and prompts exactly as the host's does — but it never resolves
 * an interaction: `Interactables.requestInteract` is gated on `ctx.authority`,
 * so pressing E only sets the INTERACT command bit and the host decides.
 *
 * Costs read 0 because a client is never told them. That is a visible gap in
 * the prompt text, not a gameplay one.
 */
const VIEW_BUILDERS = {
  [TYPE_ID.chest]: (ctx, p) => new Chest(ctx, p, 'small', 0),
  [TYPE_ID.chestLarge]: (ctx, p) => new Chest(ctx, p, 'large', 0),
  [TYPE_ID.chestLegendary]: (ctx, p) => new Chest(ctx, p, 'legendary', 0),
  [TYPE_ID.multishop]: (ctx, p) => new MultishopTerminal(ctx, p, 0, [], 0),
  [TYPE_ID.shrineChance]: (ctx, p) => new ShrineOfChance(ctx, p, 0),
  [TYPE_ID.shrineBlood]: (ctx, p) => new ShrineOfBlood(ctx, p, 0),
  [TYPE_ID.teleporter]: (ctx, p) => new Teleporter(ctx, p),
  [TYPE_ID.portal]: (ctx, p) => new Portal(ctx, p, null),
};

export function createInteractableView(ctx, typeId, position) {
  const build = VIEW_BUILDERS[typeId];
  if (!build) return null;
  const obj = build(ctx, position);
  // The teleporter is the run's objective marker; Progression reads it off the
  // manager on both roles, so a client's replicated one has to land there too.
  if (typeId === TYPE_ID.teleporter && ctx.interactables) {
    ctx.interactables.teleporter = obj;
    if (ctx.progression) ctx.progression.teleporterPosition = obj.position.clone();
  }
  return obj;
}
