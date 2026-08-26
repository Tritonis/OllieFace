import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM_BY_ID, TIERS, TEMPER_BY_ID, TEMPERED_ITEMS, ANVIL, temperRecipeStates } from '../data/items.js';
import { eliteAffixesFor } from '../data/enemies.js';
import {
  SOURCES, CLEANSE, PACT, BANDS, MUTATION, PRESSURE,
  bandOf, voidBankCap, cleanseAmount, cleanseCost,
} from '../data/corruption.js';
// Every prompt that feeds the void is priced through one formatter, so the
// three parts of the decision cannot drift apart between shrines (issue #30).
import { pricedPrompt, claimOutcomeRange, fixedClaimFace } from './corruptionPrice.js';
// The chest's payout is a transaction, not a tax (issue #175).
import { openItemOffer } from './itemTransaction.js';
// What each band gives back, and the currency it is bought with (issue #36).
import { BOON, MOTE, PACTS, RELIQUARY, RUIN, synergyPlan } from '../data/bandBoons.js';
// Blight Wounds: the caps, and the pure promotion predicate (#178).
import { WOUND, WOUND_PICK, promoteWound } from '../data/wounds.js';
import { saltedSeed } from '../data/rngSalt.js';
import { RNG } from '../core/MathUtil.js';
import { Items } from '../systems/Items.js';
import { Roster } from '../systems/Roster.js';
import { getTextureSets, withRepeat, attachWorldSurface } from './Materials.js';

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
// Rest-state emissive for the beacon shaft and its ground collar. Held here
// because the constructor and `update` must not drift apart: the constructor
// value is what the first frame renders and the harness photographs.
const BEACON_EMISSIVE = 0.42;
const COLLAR_EMISSIVE = 0.80;
// How close the player has to get before a resting orb starts homing. Generous
// on purpose: walking past the chest you just opened has to collect the item.
const ORB_SEEK_RANGE = 4.5;

// Snapshot discriminator so a client can build the right view for a replicated
// interactable. Values are wire constants — append, never renumber.
// Chests carry their size in the type id rather than a separate field: the size
// changes the mesh, and a client that only learned "chest" would render every
// legendary as a small one.
const TYPE_ID = {
  chest: 1, auricCairn: 3, ichorFont: 4, teleporter: 5, portal: 6,
  multishop: 2, chestLarge: 7, chestLegendary: 8,
  // Shrines added in round 6. `auricCairn` and `ichorFont` keep wire values 3
  // and 4 — those two were `shrineChance` / `shrineBlood` and only the *key*
  // was renamed, because the value is a wire constant and the rule above is
  // append, never renumber.
  hollowChime: 9, gildedSnare: 10, fallowVault: 11, marrowKiln: 12,
  // Counterplay shrines, round 7.
  argentFont: 13, covenantStone: 14,
  // The band upsides' altar, round 8.
  voidBargain: 15,
  // The equipment barrel — the only in-run source of the Q slot (issue #39).
  equipmentBarrel: 16,
  // Blight Wounds, round 9 (#178).
  wound: 17,
  // The Tempering Anvil, round 9 (#208).
  temperingAnvil: 18,
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
/**
 * The maps are the half of this that was missing. Every rung below was authored
 * with a roughness and a metalness and *no texture at all*, so a chest body
 * measured eight distinct luma values across two thousand pixels — flatter than
 * the film grain, and flatter than the terrain it stands on. Roughness is a
 * property of a surface, and a surface with one normal and one roughness value
 * over its whole area has nothing for a key light to find. These pull from the
 * world's own texture sets so an interactable is made of the same substances the
 * stage is.
 *
 * Repeats are in the 1.2-2.6 band because interactable parts are 0.1-1.5u: the
 * tile has to be small enough that a single strap carries several cycles of
 * grain rather than one flat sample of it.
 */
const SET = (name, repeat) => withRepeat(getTextureSets()[name], repeat);

const IRON = () => sharedMat('iron', () => attachWorldSurface(new THREE.MeshStandardMaterial({
  ...SET('metal', 1.8),
  color: 0x4c545f, roughness: 0.24, metalness: 0.62, envMapIntensity: 2.6, flatShading: true,
  normalScale: new THREE.Vector2(1.35, 1.35),
}), 'ironPart'));
const IRON_DARK = () => sharedMat('ironDark', () => attachWorldSurface(new THREE.MeshStandardMaterial({
  ...SET('metal', 1.8),
  color: 0x454d5a, roughness: 0.30, metalness: 0.45, envMapIntensity: 3.0, flatShading: true,
  normalScale: new THREE.Vector2(1.35, 1.35),
}), 'ironPart'));
// Polished, and deliberately *smooth*-shaded — the one material in the ladder
// that is not flat. It is only ever put on surfaces of revolution (basin rims,
// shrine collars), where an interpolated normal field sweeps every elevation and
// therefore contains the exact half vector for any sun/camera pair. That makes a
// highlight a property of the material rather than a coincidence of the mesh: at
// roughness 0.20 the GGX peak is ~136, so the ring clips white where it crosses
// the half vector and falls away within a few degrees either side.
const IRON_POLISH = () => sharedMat('ironPolish', () => attachWorldSurface(new THREE.MeshStandardMaterial({
  ...SET('metal', 2.6),
  color: 0x5f6774, roughness: 0.20, metalness: 0.60, envMapIntensity: 3.0,
  normalScale: new THREE.Vector2(0.9, 0.9),
}), 'ironPart'));
const STONE = () => sharedMat('stone', () => attachWorldSurface(new THREE.MeshStandardMaterial({
  ...SET('stone', 1.2),
  color: 0x646875, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.9, flatShading: true,
  normalScale: new THREE.Vector2(1.3, 1.3),
}), 'stonePart'));
/**
 * The warm band. A chest that is one value plus a lid is a slab; the acceptance
 * criterion is three luma plateaus, and this is the top one — brass over cast
 * iron over stone, on the straps, the post caps and the lock. It is the only
 * warm rung in the interactable ladder, so the key's own hue lands on it
 * instead of on a cool grey that neutralises the specular to white.
 */
const BRASS = () => sharedMat('brass', () => attachWorldSurface(new THREE.MeshStandardMaterial({
  ...SET('metal', 2.4),
  color: 0xa8794a, roughness: 0.22, metalness: 0.72, envMapIntensity: 2.8, flatShading: true,
  normalScale: new THREE.Vector2(1.0, 1.0),
}), 'ironPart'));
const trimMat = (hex) => sharedMat(`trim${hex}`, () => attachWorldSurface(new THREE.MeshStandardMaterial({
  ...SET('metal', 2.2),
  color: hex, roughness: 0.18, metalness: 0.62, envMapIntensity: 2.4,
  emissive: hex, emissiveIntensity: 0.22, flatShading: true,
  normalScale: new THREE.Vector2(1.1, 1.1),
}), 'ironPart'));
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
  /**
   * Every greed act plants a seed (spec §1). Interactables that grant items or
   * trade resources call this at their success point; Chest passes its own
   * size-scaled strengths instead. Corruption applies the greed-time bump, so
   * a mark left after the teleporter has finished is automatically deeper.
   */
  markGreed(strength = 1) { this.ctx.corruption?.seed(this.position, strength); }
  /**
   * Resolve a press by `pawn` — the survivor who actually walked up and hit E,
   * which on a host is not necessarily the survivor this machine is rendering.
   * Every cost, every corruption debt and every payout inside an `interact`
   * must resolve through this parameter (`Items.of(this.ctx, pawn)` for the
   * purse), never through `ctx.player`.
   *
   * It defaults to the local viewer so the whole single-player surface — and
   * every bare `interact()` in the tests, probes and realm harness — keeps
   * meaning exactly what it meant before the parameter existed.
   */
  interact(pawn = this.ctx.player) {}
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
  // Two groups, two materials: cast-iron carcass under a brass band set. The
  // parts were always there; what they lacked was a *value* difference, so the
  // whole body measured as one plateau and the straps read as shadow lines
  // rather than as metal laid over metal.
  const carcass = [
    box(1.52 * s, 0.15 * s, 1.12 * s, 0, 0.075 * s, 0),              // plinth
    box(1.36 * s, 0.72 * s, 0.98 * s, 0, 0.51 * s, 0),               // carcass
  ];
  const band = [
    box(1.42 * s, 0.09 * s, 1.03 * s, 0, 0.30 * s, 0),               // lower strap
    box(1.42 * s, 0.09 * s, 1.03 * s, 0, 0.70 * s, 0),               // upper strap
    box(0.26 * s, 0.30 * s, 0.10 * s, 0, 0.60 * s, 0.52 * s),        // lock plate
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      carcass.push(box(0.14 * s, 0.80 * s, 0.14 * s, sx * 0.66 * s, 0.50 * s, sz * 0.47 * s));
      // Proud cap on each post. A flat-topped post ends the silhouette on the
      // same line as the carcass; a wider cap notches it, and its top face is a
      // small horizontal plane the key hits close to head-on — the brightest
      // thing on the chest and the reason the corners read at distance.
      band.push(box(0.21 * s, 0.07 * s, 0.21 * s, sx * 0.66 * s, 0.925 * s, sz * 0.47 * s));
    }
  }
  // Hasp: two arms flanking the lock plate, so the front face has depth.
  for (const sx of [-1, 1]) {
    band.push(box(0.07 * s, 0.42 * s, 0.07 * s, sx * 0.22 * s, 0.60 * s, 0.51 * s));
  }
  return twoGroup(carcass, band);
}

/**
 * Merge two part lists into one buffer carrying one draw group each, so a
 * multi-material object still costs a single geometry and a single mesh.
 */
function twoGroup(a, b) {
  const ga = mergeGeometries(a, false);
  const gb = mergeGeometries(b, false);
  const g = mergeGeometries([ga, gb], true);
  for (const p of a) p.dispose();
  for (const p of b) p.dispose();
  ga.dispose(); gb.dispose();
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
  // The barrel is the lid's own value, not the tier colour: at the tier tint it
  // was a 25,000px near-white mass and the brightest object in the frame, which
  // out-valued the subject it is supposed to sit under. The tier now lives on
  // the spine band and the interior glow, where it is an accent rather than the
  // whole silhouette.
  return twoGroup(
    [dome, box(1.44 * s, 0.10 * s, 1.06 * s, 0, -0.04 * s, 0)],      // rim under the barrel
    [box(0.20 * s, 0.16 * s, 1.08 * s, 0, 0.34 * s, 0)],             // spine band
  );
}

export class Chest extends Interactable {
  constructor(ctx, position, size, cost) {
    super(ctx, position);
    this.size = size;
    this.cost = cost;
    this.openT = -1;
    /** The item offer this chest is holding open, once its lid is bought. */
    this.offer = null;
    this.typeId = CHEST_TYPE[size] || TYPE_ID.chest;

    // A chest advertises the tier it pays out, so these are the tier colours
    // themselves rather than approximations of them — read from `TIERS`, not
    // copied out of it. They were copied once, and both copies were stale
    // within two palette rebuilds: a chest that keeps last season's red is
    // promising a rarity the drop no longer wears. The small chest is the one
    // literal here, because its steel is not a tier colour at all.
    const tint = size === 'legendary' ? TIERS.legendary.colour
      : size === 'large' ? TIERS.uncommon.colour : 0xc0c8d4;
    const scale = size === 'small' ? 1 : size === 'large' ? 1.35 : 1.5;

    const body = new THREE.Mesh(sharedGeo(`chestBody${size}`, () => chestBodyGeo(scale)),
      [IRON(), BRASS()]);
    body.castShadow = true;
    body.receiveShadow = true;

    // The item light lives inside the carcass and is only revealed as the lid
    // swings, so opening a chest is a light event and not just an animation.
    this.glow = new THREE.Mesh(
      sharedGeo(`chestGlow${size}`, () => box(1.10 * scale, 0.06 * scale, 0.78 * scale, 0, 0.83 * scale, 0)),
      glowMat(tint)
    );

    this.lid = new THREE.Mesh(sharedGeo(`chestLid${size}`, () => chestLidGeo(scale)),
      [IRON_POLISH(), trimMat(tint)]);
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

  /**
   * The informed-consent line, in three parts: the chest and its gold price,
   * the debt this open adds, and the threshold that debt walks toward.
   *
   * The debt is a range because it has two halves and only one of them is
   * known before the lid moves: the tithe (or, when the gold isn't there, the
   * void's much steeper credit) is exact, and the item that comes out feeds by
   * a tier rolled off the very table `interact` rolls on. Quoting the span of
   * that table is the honest reading — the floor is what the player is
   * certainly buying, the ceiling is what they might be.
   *
   * `gold` may be undefined on stub contexts — treat as broke, as before.
   */
  prompt() {
    const name = this.size === 'legendary' ? 'Legendary Chest' : this.size === 'large' ? 'Large Chest' : 'Chest';
    const gold = this.ctx.items?.gold ?? 0;
    const forced = !!this.ctx.corruption && gold < this.cost;
    const gain = forced ? `${name} — pay in corruption` : `${name} ($${this.cost})`;
    const table = forced ? SOURCES.voidCredit : SOURCES.chestTithe;
    const tithe = table[this.size] ?? table.small;
    const claim = claimOutcomeRange(TIER_BIAS[this.size], this.ctx);
    // The floor is what the lid alone costs, and it is now *exact*: the safe
    // claim feeds nothing, so a player who opens and takes normally pays the
    // tithe and not a point more. The ceiling is the corrupted claim, which is
    // the only thing in this press that can still surprise them.
    const line = pricedPrompt(this.ctx, gain, tithe + claim.safe, tithe + claim.corrupt.max);
    if (!this.ctx.corruption) return line;
    return `${line} | then take it clean, corrupt it, or salvage it for ${claim.salvage.min === claim.salvage.max
      ? claim.salvage.min : `${claim.salvage.min}-${claim.salvage.max}`} warded`;
  }

  interact(pawn = this.ctx.player) {
    // No item system, no chest — every open ends in `rollItem` below, so the
    // void-credit branch must not become a path that reaches it without one.
    // (Unreachable from `main.js`, where Items is always registered and
    // registered before Corruption, but the old code returned `false` here and
    // this keeps that true.)
    const items = Items.of(this.ctx, pawn);
    if (!items) return false;
    // A consecration already paid for in motes is not this lid's to forfeit
    // (integration review M3). The chest and the altar share one panel slot, so
    // opening here would repaint over the argent window and lapse it into card
    // 1 — the purse spent, the choice taken away. Refusal rather than a settle,
    // which is the asymmetry that decides it: the argent window is *bought* and
    // cannot be re-offered, while this lid is still shut and still pressable a
    // second later. Charged nothing, because nothing has been charged yet — the
    // guard stands in front of both currencies below. A wound window is the
    // same standing ground: 'argent' and 'wound' are both a player's own
    // decision, and neither may be stolen by a lid — refused outright, same as
    // each other. The anvil's 'temper' window (#208) joins them for the same
    // reason: nothing is charged until the card is chosen, so a lid must not
    // paint over parents the player is still deciding whether to spend.
    //
    // The blight toll is the third kind and gets neither treatment (issue
    // #207). It is involuntary, arrives on the void's clock rather than a
    // press, and blocking a chest behind it would shut the stage's loot for
    // six seconds every band crossing — so a press here is never *refused*
    // while a toll stands. But it must not be allowed to *steal* the toll
    // either, the way it used to: opening the lid immediately painted the
    // chest's offer straight over the toll's cards, and a window nobody can
    // click on lapses on its own clock into the void's own pick, exactly as
    // silence would. So the press is deferred rather than either refused or
    // honoured on the spot — queued on the one open slot the world tracks per
    // pawn (`Interactables._pendingChestOpen`) and drained once a frame, after
    // `Items.fixedUpdate` has already settled whatever the toll's own clock
    // did this tick. Draining after the fact, not off the close event itself,
    // is what keeps a second band crossing arriving in the same tick from
    // being painted over in turn: the drain sees the fresh window standing and
    // waits again rather than opening onto it, so a mutation never loses its
    // turn to the chest that is waiting behind it. Nothing is charged and the
    // lid stays shut until the drain actually opens it — at which point it is
    // exactly the ordinary open below, with a fresh, full-duration offer.
    const kind = items.choiceWindowKind?.();
    if (kind === 'argent' || kind === 'wound' || kind === 'temper') return false;
    if (kind === 'blight') {
      this.ctx.interactables?.queueChestOpen?.(this, pawn);
      return true;
    }
    return this._openNow(pawn, items);
  }

  /**
   * The ordinary open, split out of `interact` so a press that had to wait
   * behind a blight toll (above) runs exactly the same payment, mark and
   * offer as one that didn't.
   */
  _openNow(pawn, items) {
    const cor = this.ctx.corruption;
    // Which currency paid for the lid, for the alignment audit (#166).
    let paid = false;
    if (items.spendGold(this.cost)) {
      paid = true;
      // Paid open: gold as before, plus the tithe — and the mark. Every greed
      // act plants a seed (spec §1); paying in gold only makes it gentler.
      cor?.feed(pawn, SOURCES.chestTithe[this.size] ?? SOURCES.chestTithe.small, this.position);
      cor?.seed(this.position, 1);
    } else if (cor) {
      // Void credit: the most deliberate corruption choice in the game. Steep
      // lump, and a seed planted where it happened. The debt is the opener's:
      // a teammate's full purse must never pay, nor be billed for, a lid this
      // pawn chose to force.
      cor.feed(pawn, SOURCES.voidCredit[this.size] ?? SOURCES.voidCredit.small, this.position);
      cor.seed(this.position, this.size === 'legendary' ? 3 : this.size === 'large' ? 2 : 1);
    } else {
      return false;
    }
    this.used = true;
    this.openT = 0;
    this.ctx.events?.emit?.('itemOffer', {
      kind: 'chest', size: this.size, cost: this.cost,
      outcome: paid ? 'gold' : 'corrupt', owner: pawn,
    });
    const id = items.rollItem(null, TIER_BIAS[this.size]);
    // One open offer per pawn, enforced here rather than asserted in a comment
    // (integration review, Critical). Two chests sited around one landmark are
    // routinely both inside the 8 s window, and the panel paints the newest
    // while the world held two — so a press meant for the chest on screen could
    // settle the one behind it. Opening a second offer settles the first as a
    // SAFE claim, which is exactly what its own lapse would have done: the
    // player keeps the item, is charged nothing for it, and is never asked two
    // questions at once.
    this.ctx.interactables?.settleOpenOffers?.(pawn);
    // The lid is bought; the item is *offered*. Nothing is fed for
    // the item here and nothing is spawned here: `openItemOffer` owns the
    // claim, charges it exactly once, and delivers it as an orb from this
    // chest's own position when the player answers — or when the window lapses
    // into the safe claim, which is the old behaviour minus the old tax.
    this.offer = openItemOffer(this.ctx, {
      itemId: id, owner: pawn, position: this.position, arc: 1.2 * this._scale, kind: 'chest',
    });
    // No item transaction (an id the catalogue does not know) is not a reason to
    // eat the player's gold: fall back to the plain orb this used to spawn.
    if (!this.offer) this.ctx.interactables.spawnOrb(this.position, id, 1.2 * this._scale, pawn);
    this.ctx.audio?.play?.('chest', this.position);
    return true;
  }

  /**
   * The open offer this chest is holding, for the panel that paints it and the
   * seat that answers it. Null once it has resolved.
   */
  openOffer() { return this.offer && !this.offer.resolved ? this.offer : null; }

  /**
   * Answer the offer this chest is holding. Host-only in fact — `resolve` is —
   * so a client's press moves nothing here and the host's own clock still
   * lapses the window into the safe claim.
   */
  answer(outcome) {
    const offer = this.openOffer();
    const r = offer ? offer.resolve(outcome) : null;
    if (r) this._claimCue(r.outcome);
    return r;
  }

  /**
   * One cue per outcome, so the three claims do not sound alike (issue #175).
   * All three reuse voices the game already has — the corrupted claim borrows
   * the band sting's descent, the salvage the warding chime and its mote — for
   * the reason the audio pipeline is out of this ticket's scope: a new sample
   * is a content decision, and a claim that sounds like what it *is* costs
   * nothing.
   */
  _claimCue(outcome) {
    if (outcome === 'corrupt') {
      this.ctx.audio?.play?.('corruptClaim', this.position);
      this.ctx.vfx?.burst?.(this.position, 0x7a2fae);
    } else if (outcome === 'salvage') {
      this.ctx.audio?.play?.('warding', this.position, 0);
      this.ctx.vfx?.wardingMote?.(this.position, 0);
    } else if (outcome === 'safe') {
      // The safe claim keeps the chest's own voice: it is the outcome that
      // did not move the ledger, and a sting on it would price a free press.
      this.ctx.vfx?.burst?.(this.position, 0xc0c8d4);
    }
  }

  update(dt) {
    // The window is the chest's to drive: it opened the offer, it knows where
    // the cue belongs, and driving it from accumulated `dt` here is what makes
    // the lapse a wall-clock promise rather than a frame count.
    if (this.offer && !this.offer.resolved) {
      this.offer.update(dt);
      if (this.offer.resolved) this._claimCue(this.offer.outcome);
    }
    if (this.openT < 0) return;
    this.openT = Math.min(1, this.openT + dt * 2.2);
    // Overshoot then settle — the little bounce is what sells the pop.
    const t = this.openT;
    const eased = 1 - Math.pow(1 - t, 3);
    this.lidPivot.rotation.x = -eased * 2.0 + Math.sin(t * Math.PI) * 0.35;
  }
}

// ------------------------------------------------------------ equipment barrel

/**
 * Staved drum, two hoops, a lid ring — one merged buffer, two draw groups
 * (carcass under banding), exactly as the chest is built. It is deliberately
 * the plainest silhouette on the stage: no plinth, no columns, no animated
 * offering. A barrel is a thing found lying about, and the drama belongs to
 * what comes out of it rather than to the object.
 */
function equipmentBarrelGeo() {
  const carcass = [
    new THREE.CylinderGeometry(0.50, 0.44, 1.06, 12, 1, false).translate(0, 0.58, 0),
    box(1.02, 0.09, 1.02, 0, 0.045, 0),                                  // footing
  ];
  const band = [
    new THREE.CylinderGeometry(0.53, 0.53, 0.10, 12).translate(0, 0.32, 0),  // lower hoop
    new THREE.CylinderGeometry(0.53, 0.53, 0.10, 12).translate(0, 0.92, 0),  // upper hoop
    new THREE.CylinderGeometry(0.49, 0.49, 0.07, 12).translate(0, 1.14, 0),  // lid ring
  ];
  return twoGroup(carcass, band);
}

/**
 * The equipment barrel — the run's only in-run source of the Q slot.
 *
 * Free, single use, and it *replaces*: whatever is held is gone. That is the
 * whole design of the thing (issue #39). Equipment used to refill itself at
 * every stage start, which made the tier automatic and made a spent charge a
 * wait rather than a cost; a barrel makes taking one a place you walked to and
 * a commitment you made. The displaced equipment is discarded rather than
 * dropped — orbs carry inventory ids through `Items.give` and cannot hold an
 * equipment id, and a barrel that let you shuffle two equipments back and forth
 * would be the swap station this is deliberately not.
 *
 * The roll is the taker's, off the taker's own stream, like every other payout
 * here: `Items.of(ctx, pawn)`, never `ctx.player`.
 */
export class EquipmentBarrel extends Interactable {
  constructor(ctx, position) {
    super(ctx, position);
    this.typeId = TYPE_ID.equipmentBarrel;
    this.cost = 0;

    const body = new THREE.Mesh(sharedGeo('equipBarrel', equipmentBarrelGeo), [IRON(), BRASS()]);
    body.castShadow = true;
    body.receiveShadow = true;

    // The one lit part, and the only thing that says the barrel is still full:
    // a disc seated in the lid ring, in the equipment tier's amber. Hidden on
    // use rather than dimmed, because the material is shared across every
    // barrel on the stage and mutating it would empty all of them.
    this.glow = new THREE.Mesh(
      sharedGeo('equipBarrelGlow', () => new THREE.CylinderGeometry(0.36, 0.36, 0.04, 12).translate(0, 1.18, 0)),
      glowMat(0xff9a3c)
    );

    this.group.add(body, this.glow);
    this.radius = 2.2;
  }

  prompt() { return this.available() ? 'Equipment Barrel' : 'Equipment Barrel (empty)'; }

  interact(pawn = this.ctx.player) {
    const items = Items.of(this.ctx, pawn);
    if (!items) return false;
    const id = items.rollEquipment();
    // A client reaches this only through the host (`requestInteract` is gated
    // on authority), and `rollEquipment` returns null off-authority.
    if (!id) return false;
    items.grant(id);
    this.used = true;
    // Every greed act plants a seed (spec §1). The barrel costs no gold, so it
    // only seeds — it takes no corruption feed.
    this.markGreed(1);
    this.ctx.vfx?.burst?.(this.position, 0xff9a3c);
    this.ctx.audio?.play?.('chest', this.position);
    return true;
  }

  // Availability is the whole of the replicated state, and a client's copy
  // arrives by having `used` written on it (`NetViews.applyNetState`) — so the
  // lamp reads off `available()` here rather than being switched in `interact`,
  // which never runs on a client.
  update() { this.glow.visible = this.available(); }
}

// -------------------------------------------------------- multishop terminal

export class MultishopTerminal extends Interactable {
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

  // The one feeder that knows exactly what it is selling, so it quotes one
  // number rather than a span: the item was rolled in the constructor.
  //
  // Unless it does not know. `rollItem` is authority-gated, so a terminal built
  // through VIEW_BUILDERS on a client holds `itemId === null` — and an unknown
  // tier falls through `tierFeed` to 1, which is a *fabricated* number rather
  // than a stale one: the real item behind that screen could be a legendary at
  // 5. The `$0` and the generic name beside it are the pre-existing view gap
  // documented on VIEW_BUILDERS, and a wrong price is honest about being a
  // placeholder in a way that "+2 corruption" is not. Quote nothing instead:
  // `pricedPrompt` returns the bare gain line for a zero feed.
  // The terminal no longer feeds anything for the item itself (issue #176):
  // the claim is a transaction now, exactly the chest's, and the safe outcome
  // is free. What is left to quote is the corrupted claim's exact face price
  // — `fixedClaimFace`, not a range: the item is already rolled
  // (`this.itemId`, fixed at construction) and never re-rolled at claim
  // time, so neither corruption's blight share nor Caprice's shelf swap has
  // anything to apply to, and quoting either would advertise a re-roll
  // `resolve('corrupt')` can never actually produce (review A1).
  prompt() {
    const known = ITEM_BY_ID.get(this.itemId);
    if (!known) return `${'Item'} ($${this.cost})`;
    const face = fixedClaimFace(known.tier);
    return pricedPrompt(this.ctx, `${known.name} ($${this.cost})`, face, face);
  }

  /**
   * Re-draw what is behind the screen — the Seeded band's bargain (issue #36),
   * bought with a void mark rather than with gold. The draw goes through
   * `rollItem` with the same table the constructor used, so a rerolled terminal
   * is indistinguishable from one that rolled that item in the first place and
   * the two cannot drift.
   *
   * It therefore draws on the shared gameplay stream exactly as building a
   * terminal does. That is deliberate and safe for `gate:sp`: the bargain is not
   * placed below Seeded and nothing presses it in a pristine run, so the
   * baseline never reaches this line.
   */
  reroll() {
    if (this.used || !this.enabled) return false;
    const id = this.ctx.items?.rollItem?.(null, TIER_BIAS.small);
    if (!id) return false;
    this.itemId = id;
    const tint = TIERS[ITEM_BY_ID.get(id)?.tier || 'common'].colour;
    this.screen.material.color.setHex(0x0d1118);
    this.screen.material.emissive.setHex(tint);
    this.screen.material.emissiveIntensity = 0.9;
    return true;
  }

  interact(pawn = this.ctx.player) {
    if (!Items.of(this.ctx, pawn)?.spendGold(this.cost)) return false;
    this.used = true;
    this.markGreed();
    // Buying one terminal closes the others: the choice has to cost something.
    for (const t of this.shopGroup) {
      if (t === this) continue;
      t.used = true;
      t.enabled = false;
      t.screen.material.emissiveIntensity = 0;
      t.screen.material.color.setHex(0x0a0c10);
    }
    this.ctx.audio?.play?.('purchase', this.position);
    // Gold bought the terminal; the item behind the screen is now offered
    // exactly the chest's way (issue #176) — take it clean, corrupt it into
    // its blight counterpart, or salvage it for wards. One offer per pawn,
    // same as the chest.
    this.ctx.interactables?.settleOpenOffers?.(pawn);
    this.offer = openItemOffer(this.ctx, {
      itemId: this.itemId, owner: pawn, position: this.position, arc: 1.6, kind: 'multishop',
    });
    if (!this.offer) this.ctx.interactables.spawnOrb(this.position, this.itemId, 1.6, pawn);
    return true;
  }

  openOffer() { return this.offer && !this.offer.resolved ? this.offer : null; }
  answer(outcome) {
    const offer = this.openOffer();
    return offer ? offer.resolve(outcome) : null;
  }
  update(dt) {
    if (this.offer && !this.offer.resolved) this.offer.update(dt);
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

/**
 * The Auric Cairn — pay gold, one roll in four pays an item.
 *
 * Renamed from "Shrine of Chance", which is a Risk of Rain 2 proper noun
 * lifted verbatim. The mechanic is genre furniture and stays; the name is not
 * ours to use. `TYPE_ID.auricCairn` is still wire value 3.
 */
export class AuricCairn extends Interactable {
  constructor(ctx, position, cost) {
    super(ctx, position);
    this.cost = cost;
    this.uses = 0;
    this.maxUses = 3;
    this.spin = 0;
    this.typeId = TYPE_ID.auricCairn;

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
  // Three rolls in four pay nothing and cost nothing but the gold, so the debt
  // is quoted as conditional. A gamble priced as a certainty is its own lie.
  // Three rolls in four still pay nothing, but the fourth no longer taxes
  // itself: the claim it pays out is a transaction (issue #176), and its safe
  // outcome is free. The debt left to quote is the corrupted claim's premium,
  // conditional on both the roll landing and the player choosing to press it.
  prompt() {
    const claim = claimOutcomeRange(TIER_BIAS.small, this.ctx);
    return pricedPrompt(this.ctx, `Auric Cairn ($${this.cost})`,
      claim.corrupt.min, claim.corrupt.max, 'if it pays and you corrupt it');
  }

  interact(pawn = this.ctx.player) {
    // One purse pays and the same purse rolls: the gamble is the payer's, so
    // the luck applied to it is the payer's luck, off the payer's stream.
    const items = Items.of(this.ctx, pawn);
    if (!items?.spendGold(this.cost)) return false;
    this.uses++;
    this.markGreed();
    // 1-in-4 base; luck grants extra rolls exactly like a chance-on-hit item,
    // which is what makes Clover a shrine item as well as a combat item.
    const win = items.roll(0.25, 1);
    if (win) {
      const id = items.rollItem(null, TIER_BIAS.small);
      // The gold and the luck already paid for this win; the item itself is
      // now offered the chest's way — take it clean, corrupt it, or salvage.
      this.ctx.interactables?.settleOpenOffers?.(pawn);
      this.offer = openItemOffer(this.ctx, {
        itemId: id, owner: pawn, position: this.position, arc: 2.0, kind: 'auricCairn',
      });
      if (!this.offer) this.ctx.interactables.spawnOrb(this.position, id, 2.0, pawn);
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

  openOffer() { return this.offer && !this.offer.resolved ? this.offer : null; }
  answer(outcome) {
    const offer = this.openOffer();
    return offer ? offer.resolve(outcome) : null;
  }

  update(dt) {
    if (this.offer && !this.offer.resolved) this.offer.update(dt);
    this.spin += dt * (this.available() ? 1.6 : 0.2);
    this.crystal.rotation.y = this.spin;
    this.crystal.position.y = 1.5 + Math.sin(this.spin * 1.5) * 0.12;
  }
}

/**
 * The Ichor Font — pay 40% of your health, take gold.
 *
 * Renamed from "Shrine of Blood" for the same reason as the Cairn above: it is
 * on the branding ledger's do-not-ship list. Wire value 4 is unchanged.
 */
export class IchorFont extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.uses = 0;
    this.maxUses = 2;
    this.stageIndex = stageIndex;
    this.typeId = TYPE_ID.ichorFont;

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
  prompt() { return 'Ichor Font (pay 40% health)'; }

  interact(pawn = this.ctx.player) {
    // The blood and the gold come from the same survivor — the font is a
    // trade, and a trade with two different counterparties is a gift.
    const p = pawn;
    if (!p?.alive) return false;
    const max = p.stats?.maxHealth || p.maxHealth || 100;
    const cost = max * 0.4;
    // Never lethal — the shrine is a gamble on time-to-heal, not on dying.
    if (p.health <= cost + 1) return false;
    this.uses++;
    this.markGreed();
    this.ctx.combat?.applyDamage(p, cost, {
      source: null, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'shrine',
      position: this.position,
    });
    const payout = Math.round((cost * 1.2 + 25) * Math.pow(1.2, this.stageIndex));
    Items.of(this.ctx, p)?.addGold(payout);
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

// ------------------------------------------------------------- more shrines
//
// ## What the four below are for
//
// The stage shipped with two shrines and both were a purchase: the Cairn buys a
// lottery ticket with gold, the Font buys gold with health. Adding a third
// purchase would be a reskin, so each of these commits a *different* resource
// on a *different* timeline, and none of them is a coin flip:
//
// | shrine | you spend | you get | when the risk lands |
// |---|---|---|---|
// | Hollow Chime | nothing | 2 guaranteed drops | up front — the fight comes first |
// | Gilded Snare | nothing | 1 good drop, now | later — an elite follows you all stage |
// | Fallow Vault | your whole purse | 2.2x of it | next stage, and only if you reach it |
// | Marrow Kiln  | one item, permanently | a large purse | never — it is certain, and irreversible |
//
// The Chime and the Snare are deliberately the same trade in opposite order,
// because "clear it and collect" and "collect and then live with it" are two
// different decisions even though the ledger balances the same.
//
// ## Reading them at 60 metres
//
// A shrine you cannot identify before walking to it has failed, so silhouette
// carries the identification and hue only confirms it. Every one of the six is
// a different *shape class*: the Cairn is a spike cluster, the Font is a spike
// in an open basin, the Chime is the only one with a hole in its outline, the
// Kiln is the only solid unbroken mass, the Snare is the only sphere, and the
// Vault is the only one under waist height. Rendered flat black they are still
// six different objects — which is the test axis 4 keeps failing elsewhere.

/** How far off the shrine an ambush lands, and how much of the field it takes. */
const CHIME_RING = 8.5;

/**
 * A walkable-ish point on a ring around `origin`. Draws from `ctx.rng`, so
 * every caller must already be on a host-only path — all of them are, because
 * `Interactables.requestInteract` gates on `ctx.authority`.
 */
function ringPoint(ctx, origin, i, n, r) {
  const a = (i / n) * Math.PI * 2 + ctx.rng.range(-0.35, 0.35);
  const x = origin.x + Math.cos(a) * r;
  const z = origin.z + Math.sin(a) * r;
  return new THREE.Vector3(x, ctx.stage?.sampleHeight?.(x, z) ?? origin.y, z);
}

/**
 * Put `count` monsters on the field around `origin` and hand back handles to
 * them. Host only.
 *
 * `Enemy` instances are pooled and recycled, so a bare reference is not an
 * identity — a corpse can come back as something else and start reading
 * `alive` again. `Enemy.id` is stamped fresh from a monotonic counter on every
 * `spawn`, so the pair is the identity and `(!e.alive || e.id !== id)` is the
 * only honest way to ask "is the thing I summoned finished".
 */
function summonRing(ctx, origin, count, r, affix = null, colour = 0x9fd4ff) {
  const dir = ctx.director;
  if (!dir?.fillerCard || !dir.spawnOne) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dir.enemies.length >= dir.populationCap) break;
    // `fillerCard` is the director's own "something legal at this difficulty
    // with room on the field" selector. Reusing it means a shrine ambush can
    // never contain a monster the stage would not otherwise have produced.
    const card = dir.fillerCard(ctx, 1e9);
    if (!card) break;
    const at = ringPoint(ctx, origin, i, count, r);
    dir.spawnTelegraph?.(at.x, at.z, 2.0, 1.1, colour);
    const e = dir.spawnOne(ctx, card, at, affix);
    if (e) out.push({ e, id: e.id });
  }
  return out;
}

/** Have all the handles from `summonRing` finished? */
function ringCleared(list) {
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (h.e.alive && h.e.id === h.id) return false;
  }
  return true;
}

/**
 * The Hollow Chime — an arch, a lintel, and a cracked bell hanging in the gap.
 *
 * The only shrine whose silhouette has a hole in it, which is what makes it
 * identifiable at range against a ridge: every other prop on the stage is a
 * solid mass and this one frames sky.
 */
function chimeArchGeo() {
  const parts = [
    box(2.52, 0.22, 0.28, 0, 3.02, 0),        // lintel
    box(0.18, 0.28, 0.18, 0, 2.82, 0),        // hanger block
  ];
  for (const sx of [-1, 1]) {
    parts.push(new THREE.CylinderGeometry(0.13, 0.21, 2.94, 6).translate(sx * 1.06, 1.47, 0));
    // Corner brace. Without it the arch is two posts and a stick; the diagonal
    // is what makes the top corners read as joinery rather than as a gap.
    parts.push(box(0.10, 0.78, 0.10, 0, 0, 0)
      .rotateZ(sx * 0.78).translate(sx * 0.72, 2.60, 0));
    // Splayed foot, so the uprights sit *on* the plinth instead of ending at it.
    parts.push(new THREE.CylinderGeometry(0.24, 0.34, 0.20, 6).translate(sx * 1.06, 0.10, 0));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * The bell. A lathe, and smooth-shaded for exactly the reason `bloodSlickGeo`
 * is: a surface of revolution whose profile sweeps its normal elevation
 * continuously contains the half vector for any sun/camera pair, so the
 * highlight is a property of the material rather than a coincidence of which
 * facet happens to line up. On a hanging object that also swings, that is the
 * difference between a bell and a grey cone.
 */
function chimeBellGeo() {
  const profile = [
    [0.05, 1.04], [0.15, 0.99], [0.24, 0.88], [0.33, 0.71],
    [0.44, 0.48], [0.57, 0.23], [0.67, 0.05], [0.70, 0.0],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const parts = [
    new THREE.LatheGeometry(profile, 20),
    // Lip ring: the one hard bright break on an otherwise continuous form.
    new THREE.TorusGeometry(0.695, 0.055, 8, 28).rotateX(Math.PI / 2),
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

export class HollowChime extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.stageIndex = stageIndex || 0;
    this.uses = 0;
    this.maxUses = 2;
    this.state = 'ready';        // ready -> ringing -> ready | spent
    this.pending = [];
    this.swing = 0;
    this.radius = 2.6;
    this.typeId = TYPE_ID.hollowChime;

    const base = new THREE.Mesh(sharedGeo('chimeBase', () => plinthGeo(1.15, 8)), STONE());
    const arch = new THREE.Mesh(sharedGeo('chimeArch', chimeArchGeo), IRON_DARK());
    base.castShadow = arch.castShadow = true;
    base.receiveShadow = true;

    // Per-instance material: `interact` dims it when the shrine is spent, and a
    // shared one would dim every chime a client has ever built.
    this.bell = new THREE.Mesh(sharedGeo('chimeBell', chimeBellGeo),
      new THREE.MeshStandardMaterial({
        color: 0x6d7f92, emissive: 0x9fd4ff, emissiveIntensity: 0.30,
        roughness: 0.18, metalness: 0.55, envMapIntensity: 3.0,
      }));
    this.bell.castShadow = true;
    // Pivot at the hanger, not at the bell's own origin, so it swings from the
    // lintel rather than spinning about its waist.
    this.pivot = new THREE.Group();
    this.pivot.position.y = 2.82;
    this.bell.position.y = -1.04;
    this.pivot.add(this.bell);
    this.group.add(base, arch, this.pivot);
  }

  available() { return this.enabled && this.state === 'ready' && this.uses < this.maxUses; }
  // Free in both currencies now (issue #176): the ambush is the price, and the
  // two drops it owes are guaranteed, unconditional and delivered through the
  // safe claim, the same one a chest's default press lands on. Mid-fight it is
  // an instruction rather than an offer.
  prompt() {
    if (this.state === 'ringing') return 'Hollow Chime — answer it';
    return `Hollow Chime (free — ${this.maxUses - this.uses} left)`;
  }

  interact(pawn = this.ctx.player) {
    const ctx = this.ctx;
    const count = 4 + Math.min(5, this.stageIndex) + this.uses * 2;
    const summoned = summonRing(ctx, this.position, count, CHIME_RING, null, 0x9fd4ff);
    // No monsters means no fight, and a shrine that consumes a use and pays
    // nothing is indistinguishable from a broken one. Refuse instead.
    if (!summoned.length) return false;
    this.uses++;
    this.markGreed();
    this.pending = summoned;
    // The pawn that rang it is the pawn the two drops belong to — every other
    // adopted feeder threads its opener through to the grant the same way.
    this.pendingOwner = pawn;
    this.state = 'ringing';
    this.swing = 1.0;
    this.bell.material.emissiveIntensity = 1.5;
    ctx.vfx?.ring?.(this.position, CHIME_RING, 0x9fd4ff);
    ctx.audio?.play?.('shrineBlood', this.position);
    return true;
  }

  update(dt) {
    // The swing decays whatever the state, so the strike reads even on a client
    // that will never resolve the fight.
    this.swing *= Math.pow(0.28, dt);
    this.pivot.rotation.z = Math.sin(this.ctx.time * 7.5) * 0.30 * this.swing;

    if (this.state !== 'ringing') return;
    // Cosmetic on both roles; the payout below is host-only.
    this.bell.material.emissiveIntensity = 0.9 + Math.sin(this.ctx.time * 3.4) * 0.5;
    if (!this.ctx.authority) return;
    if (!ringCleared(this.pending)) return;

    this.pending.length = 0;
    // Two drops, off the large-chest ladder, and *not* a roll for whether you
    // get them. The whole trade is that the randomness moved out of the payout
    // and into the fight. Granted safe and explicit (issue #176): the ambush
    // already paid for both, and the offer contract holds only one open
    // transaction per pawn, so a second simultaneous choice window is not on
    // the table — these land the way a chest's own lapse would.
    for (let i = 0; i < 2; i++) {
      const id = this.ctx.items?.rollItem?.(null, TIER_BIAS.large);
      if (!id) continue;
      const offer = openItemOffer(this.ctx, {
        itemId: id, owner: this.pendingOwner, position: this.position, arc: 1.8 + i * 0.5, kind: 'hollowChime',
      });
      if (offer) offer.resolve('safe');
      else this.ctx.interactables.spawnOrb(this.position, id, 1.8 + i * 0.5, this.pendingOwner);
    }
    this.state = this.uses >= this.maxUses ? 'spent' : 'ready';
    this.bell.material.emissiveIntensity = this.state === 'spent' ? 0.04 : 0.30;
    this.swing = 0.8;
    this.ctx.vfx?.burst?.(this.position, 0x9fd4ff);
    this.ctx.audio?.play?.('shrineWin', this.position);
  }
}

/**
 * The Gilded Snare — a cage of thorn ribs closed over a suspended offering.
 *
 * The only sphere on the stage. It is also the only shrine that shows you the
 * reward before you take it: the orb is visible through the ribs from any
 * bearing, which is what makes the trade legible without a tooltip.
 */
function snareCageGeo() {
  const parts = [];
  const RIBS = 8;
  for (let i = 0; i < RIBS; i++) {
    const a = (i / RIBS) * Math.PI * 2;
    // Two segments per rib. One straight cone is a spike; two at different
    // leans is a curve, and the kink is where the key catches.
    // Positive Z rotation tips the part's +Y toward -X, and `rotateY(-a)` below
    // puts local +X radially outward — so a positive lean is the cage closing
    // over the offering rather than splaying away from it.
    const lower = new THREE.CylinderGeometry(0.055, 0.10, 1.05, 4)
      .translate(0, 0.52, 0).rotateZ(0.20);
    const upper = new THREE.CylinderGeometry(0.02, 0.055, 0.85, 4)
      .translate(0, 1.45, 0).rotateZ(0.62);
    for (const seg of [lower, upper]) {
      parts.push(seg.rotateY(-a).translate(Math.cos(a) * 0.78, 0, Math.sin(a) * 0.78));
    }
    // Barb halfway up each rib, pointing out. Turns the outline from a smooth
    // dome into something visibly hostile at 40m.
    parts.push(new THREE.ConeGeometry(0.055, 0.30, 4)
      .rotateZ(-2.1).rotateY(-a)
      .translate(Math.cos(a) * 1.02, 0.72, Math.sin(a) * 1.02));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * The Snare's own ladder — no commons, and a real legendary share. Hoisted out
 * of `interact` so the prompt prices the table the press actually rolls on:
 * two copies of a loot table is how a quote starts lying.
 */
const SNARE_BIAS = { common: 0, uncommon: 46, legendary: 16 };

export class GildedSnare extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.stageIndex = stageIndex || 0;
    this.uses = 0;
    this.maxUses = 2;
    this.spin = 0;
    this.radius = 2.3;
    this.typeId = TYPE_ID.gildedSnare;

    const base = new THREE.Mesh(sharedGeo('snareBase', () => plinthGeo(1.05, 12)), STONE());
    const cage = new THREE.Mesh(sharedGeo('snareCage', snareCageGeo), IRON());
    // Brass collar where the ribs meet the stone — the one warm rung, and the
    // band that separates the matte base from the glossy cage.
    const collar = new THREE.Mesh(
      sharedGeo('snareCollar', () => new THREE.TorusGeometry(0.80, 0.09, 10, 28)
        .rotateX(Math.PI / 2).translate(0, 0.66, 0)),
      BRASS()
    );
    base.castShadow = cage.castShadow = collar.castShadow = true;
    base.receiveShadow = true;
    cage.position.y = 0.62;

    this.orb = new THREE.Mesh(
      sharedGeo('snareOrb', () => new THREE.IcosahedronGeometry(0.42, 0)),
      new THREE.MeshStandardMaterial({
        color: 0xffb0d8, emissive: 0xff3fa0, emissiveIntensity: 0.75,
        roughness: 0.12, metalness: 0.0, envMapIntensity: 2.4, flatShading: true,
      })
    );
    this.orb.position.y = 1.32;
    this.group.add(base, cage, collar, this.orb);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  // The item is unconditional here — the hunter is the *other* cost — so the
  // debt is quoted flat, with no "if it pays".
  // The item is unconditional; the hunter is the real cost. What is left to
  // quote is the corrupted claim's premium, offered but never forced — the
  // safe claim of an unconditional item is free (issue #176).
  prompt() {
    const claim = claimOutcomeRange(SNARE_BIAS, this.ctx);
    return pricedPrompt(this.ctx, 'Gilded Snare (take it — something answers)',
      claim.corrupt.min, claim.corrupt.max, 'if you corrupt it');
  }

  interact(pawn = this.ctx.player) {
    const ctx = this.ctx;
    // The item is unconditional and it lands first. That ordering is the shrine:
    // the player is holding the reward before the cost arrives, which is a
    // different decision from earning it and a different one from gambling for
    // it, even though all three can pay the same item.
    const id = Items.of(ctx, pawn)?.rollItem?.(null, SNARE_BIAS);
    if (!id) return false;
    this.uses++;
    this.markGreed();
    // The hunter below is the cost; the item itself is offered the chest's
    // way — take it clean, corrupt it, or salvage.
    ctx.interactables?.settleOpenOffers?.(pawn);
    this.offer = openItemOffer(ctx, {
      itemId: id, owner: pawn, position: this.position, arc: 2.2, kind: 'gildedSnare',
    });
    if (!this.offer) ctx.interactables.spawnOrb(this.position, id, 2.2, pawn);

    // …and now the hunter. An elite, legal at the current difficulty, placed
    // close and pointed at the player rather than at the shrine — it follows
    // you off the site, which is what stops the Snare from being solved by
    // walking away.
    const affixes = eliteAffixesFor(ctx.director?.difficultyCoefficient ?? 1);
    const affix = affixes.length ? ctx.rng.pick(affixes) : null;
    const hunters = summonRing(ctx, this.position, this.uses, 5.5, affix, 0xff3fa0);
    // Pointed at whoever took the offering — the cost has to follow the pawn
    // that earned it off the site.
    const home = pawn?.position;
    if (home) for (const h of hunters) h.e.home?.copy?.(home);

    if (this.uses >= this.maxUses) this.orb.material.emissiveIntensity = 0.05;
    ctx.vfx?.burst?.(this.position, 0xff3fa0);
    ctx.audio?.play?.('shrineWin', this.position);
    return true;
  }

  openOffer() { return this.offer && !this.offer.resolved ? this.offer : null; }
  answer(outcome) {
    const offer = this.openOffer();
    return offer ? offer.resolve(outcome) : null;
  }

  update(dt) {
    if (this.offer && !this.offer.resolved) this.offer.update(dt);
    this.spin += dt * (this.available() ? 1.1 : 0.15);
    this.orb.rotation.y = this.spin;
    this.orb.rotation.x = this.spin * 0.6;
    this.orb.position.y = 1.32 + Math.sin(this.spin * 1.8) * 0.09;
  }
}

/**
 * The Fallow Vault — a sunken coffer with a coin slot and nothing above it.
 *
 * Commit the whole purse; it comes back at 2.2x when the next stage begins.
 * The cost is not the gold, which you get back with interest — it is that this
 * stage's chests go unopened, and that a run which ends here ends with the
 * money still in the ground.
 *
 * It is the only shrine under waist height and the only one with no lit
 * offering standing on it, so what identifies it at range is a *gap*: four
 * short marker posts around a low mass. Ground furniture, not an altar.
 */
const VAULT_MIN = 45;
// Beats the 1.25x-per-stage price inflation, because it has to: the player is
// giving up a whole stage of purchases and a whole stage of item compounding,
// and a return that only kept pace with prices would be a strictly worse
// version of doing nothing.
const VAULT_YIELD = 2.2;

function vaultGeo() {
  const shell = [
    new THREE.CylinderGeometry(1.22, 1.30, 0.82, 8).translate(0, 0.32, 0),   // drum, part-sunk
    new THREE.CylinderGeometry(1.06, 1.22, 0.16, 8).translate(0, 0.80, 0),   // shoulder
  ];
  const trim = [
    new THREE.CylinderGeometry(0.96, 0.96, 0.10, 8).translate(0, 0.92, 0),   // lid
    new THREE.TorusGeometry(1.10, 0.09, 8, 24).rotateX(Math.PI / 2).translate(0, 0.84, 0),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.78;
    // Marker post. The vault itself is 1.0m tall and would disappear into the
    // terrain at any distance; the posts are what put a readable vertical tick
    // on the horizon without pretending to be an altar.
    shell.push(new THREE.CylinderGeometry(0.09, 0.13, 1.15, 5)
      .translate(Math.cos(a) * 2.05, 0.57, Math.sin(a) * 2.05));
    trim.push(box(0.24, 0.09, 0.24, Math.cos(a) * 2.05, 1.18, Math.sin(a) * 2.05));
    // Buttress foot against the drum.
    shell.push(box(0.16, 0.52, 0.30, 0, 0, 0)
      .rotateY(-a).translate(Math.cos(a) * 1.16, 0.26, Math.sin(a) * 1.16));
  }
  return twoGroup(shell, trim);
}

export class FallowVault extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.stageIndex = stageIndex || 0;
    this.used = false;
    this.radius = 2.6;
    this.typeId = TYPE_ID.fallowVault;

    const body = new THREE.Mesh(sharedGeo('vaultBody', vaultGeo), [IRON_DARK(), BRASS()]);
    body.castShadow = true;
    body.receiveShadow = true;

    // The slot. A thin bright line across an otherwise closed lid is the whole
    // of this prop's emissive budget, and it is the only part of the shrine
    // that says "put something in".
    // Per-instance, not `glowMat` — that cache is shared across every prop on
    // the stage, and `interact` dims this one when the vault is sealed. The
    // same trap `IchorFont` calls out: a shared material would seal every
    // vault a client has ever built.
    this.slot = new THREE.Mesh(
      sharedGeo('vaultSlot', () => box(0.72, 0.03, 0.14, 0, 0.975, 0)),
      new THREE.MeshStandardMaterial({
        color: 0x0a0806, emissive: 0xb98a2e, emissiveIntensity: 1.6, roughness: 0.5,
      })
    );
    this.group.add(body, this.slot);
  }

  /** What the vault would take right now. Cheap and pure — the prompt uses it. */
  _stake() { return Math.max(0, Math.round(this.ctx.items?.gold ?? 0)); }

  available() { return this.enabled && !this.used; }
  // The prompt has to tell a joiner the truth `interact` is about to enforce.
  // Every press from a client resolves on the host against a pawn that is not
  // the host's viewer, so the refusal below is unconditional for a client — and
  // a prompt quoting the joiner's own purse, followed by an E that does nothing
  // and says nothing, reads as a broken shrine rather than as a rule.
  prompt() {
    if (!this.ctx.authority) return 'Fallow Vault (the host\'s alone this run)';
    const s = this._stake();
    return s >= VAULT_MIN
      ? `Fallow Vault (commit $${s} — returns $${Math.round(s * VAULT_YIELD)} next stage)`
      : `Fallow Vault (needs $${VAULT_MIN})`;
  }

  // NOT per-pawn, deliberately: the stake leaves via `commitToVault` and comes
  // back next stage out of Progression, which has no owner for the carry — a
  // remote pawn would pay in and watch the host get paid out. Rather than ship
  // that, a non-viewer press is refused outright, which is exactly the
  // reachability this shrine had before the roster scan existed. Lifting the
  // refusal needs a per-pawn carry on Progression, not a change here.
  interact(pawn = this.ctx.player) {
    if (pawn !== this.ctx.player) return false;
    const stake = this._stake();
    if (stake < VAULT_MIN) return false;
    if (!this.ctx.items?.spendGold(stake)) return false;
    // Progression owns the carry: interactables die with the stage and this
    // payout has to outlive one.
    this.ctx.progression?.commitToVault?.(Math.round(stake * VAULT_YIELD));
    this.used = true;
    this.markGreed();
    this.slot.material.emissiveIntensity = 0.15;
    this.ctx.vfx?.burst?.(this.position, 0xb98a2e);
    this.ctx.audio?.play?.('purchase', this.position);
    return true;
  }

  update(dt) {
    if (this.used) return;
    // A slow breathe, not a pulse. The vault is the calmest object in the set
    // and it should read as patient rather than as urgent.
    this.slot.material.emissiveIntensity = 1.6 + Math.sin(this.ctx.time * 1.1) * 0.6;
  }
}

/** Gold a burned item is worth, by tier, before the stage multiplier. */
const KILN_VALUE = { common: 60, uncommon: 165, legendary: 430, boss: 300, lunar: 200 };
const KILN_TIER_ORDER = ['common', 'uncommon', 'legendary', 'lunar', 'boss'];

/**
 * The Marrow Kiln — a stout chimney with a stoked mouth.
 *
 * Burn one item you hold, permanently, for a large purse. The only shrine with
 * no randomness anywhere in it: you are told exactly which item goes in and
 * exactly what comes out, and neither number moves.
 *
 * It always takes the *lowest tier you hold most of*, so the prompt can name
 * the item honestly before you press E. A shrine that consumes something the
 * player did not expect to lose is not a risk, it is a bug they cannot see.
 *
 * The only solid unbroken mass in the shrine set — no gap, no spikes, no
 * suspended part. Against the Chime's arch two hundred metres away that reads
 * instantly.
 */
function kilnGeo() {
  const shell = [
    new THREE.CylinderGeometry(0.78, 0.92, 0.34, 6).translate(0, 0.17, 0),   // footing
    new THREE.CylinderGeometry(0.50, 0.78, 1.72, 6).translate(0, 1.20, 0),   // stack
    new THREE.CylinderGeometry(0.70, 0.46, 0.42, 6).translate(0, 2.27, 0),   // ash cowl, flaring up
  ];
  const trim = [
    new THREE.TorusGeometry(0.70, 0.075, 8, 20).rotateX(Math.PI / 2).translate(0, 0.72, 0),
    new THREE.TorusGeometry(0.56, 0.065, 8, 20).rotateX(Math.PI / 2).translate(0, 1.68, 0),
    box(0.86, 0.11, 0.14, 0, 1.02, 0.62),                                     // mouth lintel
  ];
  for (const sx of [-1, 1]) {
    trim.push(box(0.12, 0.60, 0.13, sx * 0.37, 0.68, 0.60));                  // mouth jambs
  }
  return twoGroup(shell, trim);
}

export class MarrowKiln extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.stageIndex = stageIndex || 0;
    this.uses = 0;
    this.maxUses = 3;
    this.radius = 2.2;
    this.typeId = TYPE_ID.marrowKiln;

    const base = new THREE.Mesh(sharedGeo('kilnBase', () => plinthGeo(1.0, 6)), STONE());
    const body = new THREE.Mesh(sharedGeo('kilnBody', kilnGeo), [IRON_DARK(), BRASS()]);
    base.castShadow = body.castShadow = true;
    base.receiveShadow = true;
    body.position.y = 0.6;

    // The mouth: a recessed dark plate with the fire in front of it, so the
    // ember has something to sit against instead of floating on the shell.
    const throat = new THREE.Mesh(
      sharedGeo('kilnThroat', () => box(0.66, 0.56, 0.10, 0, 1.28, 0.52)),
      IRON_DARK()
    );
    // Per-instance for the same reason the vault's slot is.
    this.fire = new THREE.Mesh(
      sharedGeo('kilnFire', () => box(0.56, 0.46, 0.06, 0, 1.28, 0.58)),
      new THREE.MeshStandardMaterial({
        color: 0x120603, emissive: 0xff5a12, emissiveIntensity: 2.2, roughness: 0.5,
      })
    );
    this.group.add(base, body, throat, this.fire);
  }

  /**
   * The stack the kiln would take. Lowest tier first, then largest stack, then
   * id — a total order, so the prompt and the burn can never disagree and two
   * peers looking at the same inventory name the same item.
   */
  _fuel(pawn = this.ctx.player) {
    const inv = Items.of(this.ctx, pawn)?.inventory?.() || [];
    let best = null;
    for (const e of inv) {
      const rank = KILN_TIER_ORDER.indexOf(e.def.tier);
      if (rank < 0) continue;
      if (!best) { best = { ...e, rank }; continue; }
      if (rank < best.rank) { best = { ...e, rank }; continue; }
      if (rank > best.rank) continue;
      if (e.count > best.count || (e.count === best.count && e.id < best.id)) best = { ...e, rank };
    }
    return best;
  }

  _payout(def) {
    return Math.round((KILN_VALUE[def.tier] ?? 60) * Math.pow(1.25, this.stageIndex));
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() {
    const f = this._fuel();
    return f
      ? `Marrow Kiln (burn 1x ${f.def.name} for $${this._payout(f.def)})`
      : 'Marrow Kiln (nothing to burn)';
  }

  interact(pawn = this.ctx.player) {
    // The kiln burns what the presser is carrying and pays the presser: both
    // halves of the trade come off one inventory, so they resolve together.
    const items = Items.of(this.ctx, pawn);
    const f = this._fuel(pawn);
    if (!f || !items) return false;
    this.uses++;
    this.markGreed();
    items.take(f.id, 1);
    items.addGold(this._payout(f.def));
    this.ctx.vfx?.burst?.(this.position, 0xff5a12);
    this.ctx.audio?.play?.('shrineBlood', this.position);
    if (this.uses >= this.maxUses) this.fire.material.emissiveIntensity = 0.08;
    return true;
  }

  update(dt) {
    if (this.uses >= this.maxUses) return;
    // Two beats at incommensurable rates, so the fire never visibly loops.
    const t = this.ctx.time;
    this.fire.material.emissiveIntensity =
      2.2 + Math.sin(t * 5.1) * 0.45 + Math.sin(t * 11.7) * 0.22;
  }
}

/**
 * The Argent Font — pay gold, bleed the world. The counterplay valve given a
 * body (launch spec §1): the font undoes what greed did, at a price that climbs
 * per use *and* rides the debt being retired (`cleanseCost`), and it is NOT a
 * greed act — no seed, no tithe. Refuses a pristine world outright rather than
 * selling nothing.
 */
export class ArgentFont extends Interactable {
  constructor(ctx, position, stageIndex) {
    super(ctx, position);
    this.uses = 0;
    this.maxUses = CLEANSE.maxUses;
    this.stageIndex = stageIndex || 0;
    this.typeId = TYPE_ID.argentFont;
    // `cost` is live rather than stored, because both terms that set it move
    // under the font while the player stands at it — the per-use climb and the
    // world being retired — and a stored price would be stale the moment
    // anybody fed the gauge. Redefined over the base's plain field so every
    // existing reader (`prompt`, `spendGold`, the probes) keeps reading `.cost`
    // and gets the current number.
    Object.defineProperty(this, 'cost', { get: () => this.price(), enumerable: true });

    const base = new THREE.Mesh(sharedGeo('bloodBase', () => plinthGeo(1.0, 8)), STONE());
    // The Ichor Font's basin form in silver: the two fonts rhyme on purpose —
    // one takes, one gives back — and the palette is the whole difference.
    const rim = new THREE.Mesh(
      sharedGeo('bloodRim', () => new THREE.TorusGeometry(0.78, 0.075, 12, 32)
        .rotateX(Math.PI / 2).translate(0, 1.11, 0)),
      IRON_POLISH()
    );
    base.castShadow = rim.castShadow = true;
    base.receiveShadow = true;

    // Per-instance material: `interact` dims it when the font is spent.
    this.water = new THREE.Mesh(
      sharedGeo('argentWater', () => new THREE.CylinderGeometry(0.72, 0.72, 0.06, 20).translate(0, 1.05, 0)),
      new THREE.MeshStandardMaterial({
        color: 0xcfe8ff, emissive: 0x9fd4ff, emissiveIntensity: 0.8,
        roughness: 0.05, metalness: 0.2, envMapIntensity: 3.0,
      })
    );
    this.group.add(base, rim, this.water);
  }

  // A ruined run has no font. That is the irreversible half of Consumed's
  // bargain (issue #36, `VoidBargain`): the last-chance state is not a buff
  // with a drawback, it is the clean exit ceasing to exist — and this is where
  // that stops being a line of prompt text and starts being true.
  available() { return this.enabled && !this.ctx.corruption?.ruined && this.uses < this.maxUses; }

  /** What this use is worth *right now* — the bleed scales with the debt. */
  yield() { return cleanseAmount(this.ctx.corruption?.world ?? 0); }

  /** What this use costs right now — see the constructor for why it is live. */
  price() { return cleanseCost(this.stageIndex, this.uses, this.ctx.corruption?.world ?? 0); }

  // The live number is in the prompt on purpose: the font's whole re-pricing
  // is invisible otherwise, and a player deciding between this and a chest is
  // deciding about a quantity, not about the word "bleed".
  //
  // Co-op caveat, same shape as the `$0` cost gap noted on VIEW_BUILDERS:
  // `Corruption` is not replicated (nothing in src/net/ carries it) and `feed`
  // is authority-gated, so a client's `_world` never leaves 0 and its prompt
  // reads "bleed 30 corruption ($60)" — the floor bleed at the base price —
  // while the host may be selling 88 for $746. Both halves of the prompt now
  // read the world, so both are stale on a client, and by the same mechanism:
  // the press still resolves on the host at the host's numbers, so this is
  // stale display, not a stale transaction. Replicating the gauge is a
  // net-layer change and deliberately not made here. Issue #32 widens the
  // stale surface rather than changing its shape: every line below reads the
  // same `_world`, so on a client the whole ledger describes a pristine world.
  // The one clause that is *not* stale there is the freed stack — a client's
  // inventory mirror is real.
  /**
   * The whole projected transaction, before the player pays for it (issue #32).
   * Two of these six numbers were on the prompt; the four that were not are
   * exactly the ones that make cleansing an investment rather than a refund —
   * the band you land in, the war chest the void loses, the Director pressure
   * that comes off, the toll headroom you buy back, and the stack the press
   * hands you.
   *
   * Line 1 is the bill. Everything below it is the *projection* — what the
   * world looks like once the press resolves — which is why the band reads as
   * an arrow. Three lines is the budget: the prompt sits under the reticle in
   * the flow of play, and a fourth would be a document rather than a decision.
   *
   * All of it is recomputed per frame off the live world, for the reason
   * `cleanseCost` documents: a Voidtouched refund landing mid-approach
   * re-prices the font, and a disclosure frozen at prompt-open would then be
   * describing a transaction that no longer exists.
   */
  prompt() {
    const world = this.ctx.corruption?.world ?? 0;
    const amount = this.yield();
    const after = Math.max(0, world - amount);
    const removed = world - after;

    const from = BANDS[bandOf(world)].name;
    const to = BANDS[bandOf(after)].name;
    const bank = Math.round(voidBankCap(after) - voidBankCap(world));
    const pressure = -removed * PRESSURE.perWorld;
    // Each clause states a change or says plainly that there is none: a bleed
    // inside one band, or against a void bank already pinned at `maxBank`,
    // really does move nothing, and quoting "-0" for it would be the same kind
    // of half-truth this prompt exists to retire.
    const ledger = [
      from === to ? `${to} holds` : `${from} -> ${to}`,
      bank < 0 ? `void bank ${bank}` : 'void bank held',
      pressure <= -0.005 ? `pressure ${pressure.toFixed(2)}` : 'pressure held',
    ];

    // The toll clock. A paid threshold never re-arms, so what this press buys
    // is distance to the *next unpaid* one — and which band that is belongs to
    // `Items`, not to a second derivation here: a party that spiked into Overrun
    // and bled back down owes Consumed, not the Blighted mark it can see itself
    // sitting below. The world-side floor stays as the outer `max` because a
    // client's `_mutePeak` never advances, and a toll clock that reads behind
    // the live gauge would count down to a line already crossed.
    const items = Items.of(this.ctx, this.ctx.player);
    const tollBand = Math.max(bandOf(after) + 1, items?.nextTollBand?.() ?? MUTATION.minBand);
    const gain = [];
    if (items?.stabilisable?.().length) gain.push('frees 1 blight stack');
    gain.push(tollBand < BANDS.length
      ? `${Math.round(BANDS[tollBand].at - after)} to the next blight toll`
      : 'no further blight toll');

    return `Argent Font — bleed ${amount} corruption ($${this.cost})\n`
      + `${ledger.join(', ')}\n${gain.join(', ')}`;
  }

  interact(pawn = this.ctx.player) {
    const cor = this.ctx.corruption;
    // Nothing to bleed means nothing to sell; refuse before taking the gold.
    // Or nothing left that *can* be bled: a ruined run is
    // refused here and not only greyed out in `available`, because the press
    // path is what a probe and a co-op client actually reach.
    if (!cor || !(cor.world > 0) || cor.ruined) { this.ctx.audio?.play?.('deny'); return false; }
    // One evaluation of a live price for one transaction. `cost` is a getter
    // over `cleanseCost(stage, uses, world)` and both of its moving terms are
    // about to move underneath it, so the number charged and the number
    // reported have to be the same read or the record would quote a price
    // nobody paid.
    const cost = this.cost;
    const worldBefore = cor.world;
    const bandBefore = cor.band;
    if (!Items.of(this.ctx, pawn)?.spendGold(cost)) { this.ctx.audio?.play?.('deny'); return false; }
    const press = this.uses;
    this.uses++;
    // Whoever paid gets their own ledger cleared first — `bleed` spends the
    // buyer's own corruption before it spreads the remainder.
    const removed = cor.bleed(pawn, this.yield());
    // The investment half (issue #32): one corrupted stack comes back. After
    // the bleed, so the band listeners have settled before the inventory moves;
    // into the payer's own pack, because every economy action resolves through
    // `Items.of`. The salt is derived, never drawn — see `Items.stabilise` for
    // why one `ctx.rng` draw here would be an sp-equivalence break.
    Items.of(this.ctx, pawn)?.stabilise?.(this.stageIndex * CLEANSE.maxUses + press);
    this.ctx.vfx?.burst?.(this.position, 0x9fd4ff);
    this.ctx.audio?.play?.('shrineWin', this.position);
    if (this.uses >= this.maxUses) this.water.material.emissiveIntensity = 0.05;
    // The counterplay valve is the one corruption transaction with a price on
    // both sides, and issue #29 asks the record for all four numbers. Emitted
    // last, so it describes a press that actually completed — the two refusals
    // above return before reaching here — and after the bleed, so the band it
    // reports is the band the listeners have already settled on. Nothing in the
    // game subscribes; a bus event rather than a call into a recorder is what
    // keeps this class ignorant of whether anyone is listening.
    this.ctx.events.emit('fontUse', {
      stage: this.stageIndex, press, cost, removed,
      worldBefore, worldAfter: cor.world, bandBefore, bandAfter: cor.band,
    });
    return true;
  }

  update(dt) {
    this.water.material.emissiveIntensity = this.available()
      ? 0.8 + Math.sin(this.ctx.time * 2.2) * 0.25 : 0.05;
  }
}

/**
 * The Covenant Stone — the pact shrine (launch spec §2). A volunteer takes a
 * share of the most-corrupted teammate's ledger onto their own; world
 * corruption does not move. Solo runs are refused, not punished: the stone
 * only spawns for parties, and a party with clean teammates gets its use back.
 * The volunteer is whoever pressed E: the host scans the whole roster for the
 * interact bit and hands the acting pawn to `interact`, so a client really can
 * shoulder a share.
 *
 * REMAINING LIMIT: the donor is still auto-selected — the heaviest ledger that
 * is not the volunteer's own — rather than chosen. A negotiated pact needs a
 * selection UI and corruption replication (a client's gauge never leaves 0,
 * see the Argent Font note above), and both wait on a later round.
 */
export class CovenantStone extends Interactable {
  constructor(ctx, position) {
    super(ctx, position);
    this.uses = 0;
    this.maxUses = PACT.maxUses;
    this.typeId = TYPE_ID.covenantStone;

    const base = new THREE.Mesh(sharedGeo('shrineBase', () => plinthGeo(1.1, 10)), STONE());
    base.castShadow = true;
    base.receiveShadow = true;
    // Two leaning slabs meeting at the top: the silhouette is a handshake.
    this.stones = new THREE.Mesh(
      sharedGeo('covenantStones', () => {
        const parts = [
          box(0.5, 2.4, 0.4, -0.55, 1.35, 0).rotateZ(-0.2),
          box(0.5, 2.4, 0.4, 0.55, 1.35, 0).rotateZ(0.2),
        ];
        const g = mergeGeometries(parts, false);
        for (const p of parts) p.dispose();
        return g;
      }),
      IRON_DARK()
    );
    this.stones.castShadow = true;
    // Per-instance material: dimmed once the covenant is struck.
    this.bond = new THREE.Mesh(
      sharedGeo('covenantBond', () => new THREE.TorusGeometry(0.34, 0.07, 8, 24).translate(0, 2.35, 0)),
      new THREE.MeshStandardMaterial({
        color: 0x0a0c10, emissive: 0x9fd4ff, emissiveIntensity: 1.6, roughness: 0.3,
      })
    );
    this.group.add(base, this.stones, this.bond);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() { return 'Covenant Stone — shoulder a share of the party\'s corruption'; }

  interact(pawn = this.ctx.player) {
    const cor = this.ctx.corruption;
    const me = pawn;
    if (!cor || !me) { this.ctx.audio?.play?.('deny'); return false; }
    // The heaviest ledger that is not the volunteer's own.
    let donor = null, worst = 0;
    for (const p of this.ctx.roster?.all || []) {
      if (p === me) continue;
      const own = cor.corruptionOf(p);
      if (own > worst) { worst = own; donor = p; }
    }
    if (!donor || !(worst > 0)) { this.ctx.audio?.play?.('deny'); return false; }
    const moved = cor.transfer(donor, me, worst * PACT.share);
    if (!(moved > 0)) { this.ctx.audio?.play?.('deny'); return false; }
    this.uses++;
    this.bond.material.emissiveIntensity = 0.1;
    this.ctx.vfx?.burst?.(this.position, 0x9fd4ff);
    this.ctx.audio?.play?.('shrineWin', this.position);
    return true;
  }

  update(dt) {
    if (!this.available()) return;
    this.bond.material.emissiveIntensity = 1.6 + Math.sin(this.ctx.time * 3.0) * 0.4;
  }
}

// ---------------------------------------------------------------- teleporter

/**
 * The beacon shaft takes the *biome's* accent, not one fixed cyan.
 *
 * The plinth, charge ring and collar stay teal everywhere — that is the thing
 * the player presses E on and it has to be the same object on every stage — but
 * the 70m column is atmosphere, and a column sitting 150-180 degrees from the
 * dominant hue of the place it stands in is the single loudest cohesion break
 * in the build. Falls back to the fixed teal for a stage with no biome.
 */
function beaconTint(ctx) {
  const m = ctx.stage?.biome?.mats;
  return m?.beacon ?? m?.crystal ?? 0x2ad0ff;
}

/**
 * The Void Bargain — where corruption buys something back (issue #36).
 *
 * One altar, four offers, and which one it is making is decided entirely by the
 * band the world is in. That is the shape the issue asks for and the reason it
 * is one prop rather than four: a deeper band *replaces* the shallower offer
 * rather than adding to a menu, so descending is a series of trades and a
 * Consumed party genuinely cannot go back for the Seeded reroll.
 *
 *   Seeded    spend 1 mark, re-draw every terminal on the stage
 *   Blighted  spend 2 marks, buy the corrupted synergy the prompt names first
 *   Overrun   spend 3 marks and fresh debt, take a pact for twenty seconds
 *   Consumed  spend nothing, and lose the exit — see `RUIN`
 *
 * Everything above the last line is repeatable while marks last; the last line
 * happens once and spends the altar, because the whole point of a last chance
 * is that there is not another one.
 *
 * The prompt states the price, the effect and the consequence before the press,
 * on the `ArgentFont` principle: a bargain the player cannot read is a trap,
 * and a trap teaches the same lesson pure pressure did.
 *
 * Co-op caveat, the shared one: `Corruption` is not replicated, so a client
 * reads zero marks and a Pristine band and its prompt says the altar is
 * dormant. Stale display, not a stale transaction — `spendMarks`, `feed` and
 * `ruin` are all authority-gated and the press resolves on the host.
 */
// The maw's two voices, and the reason there are exactly two: a colour change
// is the only altar state a player can resolve at a distance where the prompt
// is unreadable. Violet is the void's own light and means the bargain is
// standing; the ember is a debt still being paid off, and it climbs.
const AFFORD_EMISSIVE = 0x7a2fae;
const SHORT_EMISSIVE = 0xa8412a;

export class VoidBargain extends Interactable {
  constructor(ctx, position, stageIndex = 0) {
    super(ctx, position);
    this.stageIndex = stageIndex || 0;
    this.typeId = TYPE_ID.voidBargain;
    this.radius = 2.2;
    this.spent = false;
    // Which pact this altar is offering, fixed for its life and derived from
    // (run seed, stage) rather than drawn: a pact the player can see coming is
    // a decision, and `ctx.rng` is not touched anywhere in this class.
    this.pact = PACTS[(((ctx.seed >>> 0) ^ (0x85ebca6b * (this.stageIndex + 1))) >>> 0) % PACTS.length];

    const base = new THREE.Mesh(sharedGeo('bargainBase', () => plinthGeo(0.9, 6)), STONE());
    // An inverted cone standing point-down in the plinth: the one shape on the
    // stage that reads as something being *taken* rather than offered, which is
    // the only honest silhouette for this prop.
    this.maw = new THREE.Mesh(
      sharedGeo('bargainMaw', () => new THREE.ConeGeometry(0.62, 1.1, 6).rotateX(Math.PI).translate(0, 1.35, 0)),
      new THREE.MeshStandardMaterial({
        color: 0x1a0f24, emissive: 0x7a2fae, emissiveIntensity: 0.7,
        roughness: 0.35, metalness: 0.1, envMapIntensity: 2.0,
      })
    );
    this._pulse = 0;
    base.castShadow = this.maw.castShadow = true;
    base.receiveShadow = true;
    this.group.add(base, this.maw);
  }

  available() { return this.enabled && !this.spent && !!this.offer(); }

  _band() { return this.ctx.corruption?.band ?? 0; }
  _marks() { return this.ctx.corruption?.marks ?? 0; }
  _motes() { return this.ctx.corruption?.motes ?? 0; }

  /**
   * What the altar is offering *right now*, or null when it is offering
   * nothing. Recomputed per read rather than stored, for `ArgentFont`'s reason:
   * both terms move under the player while they stand here — the band, and the
   * purse — and a stored offer would describe a bargain that no longer exists.
   *
   * A band whose price the player cannot meet returns null rather than falling
   * through to a shallower offer. Quoting the Seeded reroll to an Overrun party
   * that is one mark short of a pact would be the altar arguing them *down* a
   * band, which is precisely backwards.
   */
  offer() {
    if (this.spent) return null;
    const band = this._band();
    const marks = this._marks();
    const cor = this.ctx.corruption;
    if (band >= BOON.ruin.band) return cor?.ruined ? null : { kind: 'ruin', marks: 0 };
    if (band >= BOON.pact.band) {
      if (marks >= BOON.pact.marks) return { kind: 'pact', marks: BOON.pact.marks, pact: this.pact };
      return this._argent();
    }
    if (band >= BOON.synergy.band) {
      if (marks < BOON.synergy.marks) return this._argent();
      const items = Items.of(this.ctx, this.ctx.player);
      const plan = items && synergyPlan(items.blightHeld(), items.convertibleStacks());
      return plan ? { kind: 'synergy', marks: BOON.synergy.marks, plan } : this._argent();
    }
    if (band >= BOON.reroll.band && marks >= BOON.reroll.marks) {
      const shops = this._terminals();
      if (shops.length) return { kind: 'reroll', marks: BOON.reroll.marks, shops };
    }
    return this._argent();
  }

  /**
   * Purity's offer (issue #36, second pass), and the reason it stands on *this*
   * altar: at every band whose bargain the purse cannot meet, and at Pristine
   * where there was never a bargain at all, this prop was a rock — the one
   * thing on the stage with nothing to say to a player who had kept the world
   * clean.
   *
   * It is the fallback rather than a competing offer, so the rule the class
   * comment states is untouched: the void's own bargain is always checked
   * first, and a party that can afford the pact is never argued down to a
   * window. What changes is only the *null* case, which used to be silence.
   *
   * Not a shallower band's offer, either — the objection that made `offer()`
   * refuse to fall through does not apply. Sanctuary is priced in the other
   * currency entirely, so quoting it to an Overrun party one mark short is not
   * arguing them back up the gauge; it is telling them what the other economy
   * will still sell them.
   *
   * A ruined run is refused, like every other clean thing: `RUIN`'s whole
   * proposition is that the exits stop existing.
   */
  _argent() {
    const cor = this.ctx.corruption;
    if (cor?.ruined) return null;
    const motes = cor?.motes ?? 0;
    // The deeper rung replaces the shallower one — `offer()`'s own rule, in the
    // other currency. Banking past Sanctuary is the decision this is for, and
    // the two rungs eat the same purse, so every window taken is a card not
    // bought.
    // Stocked, not drawn. `offer()` is read from `update()` every frame the
    // altar is in the world, so anything this asks is asked at the frame rate;
    // drawing the card here put a `ctx.rng` pull on the render path and made
    // two runs on one seed diverge by how fast the machine was. The card is
    // named by the press, in `interact`.
    if (motes >= RELIQUARY.motes && this._reliquaryStocked()) {
      return { kind: 'consecrate', marks: 0, motes: RELIQUARY.motes };
    }
    if (motes >= MOTE.motes) return { kind: 'sanctuary', marks: 0, motes: MOTE.motes };
    return null;
  }

  /**
   * Whether the reliquary has anything to hand over — the question the offer
   * and the prompt are allowed to ask, because it draws nothing.
   *
   * Null-safe against `argentStocked` not existing, so this surface stays
   * inert on its own — with no pool in the tree the altar offers Sanctuary at
   * any purse, exactly as it did before.
   */
  _reliquaryStocked() {
    return Items.of(this.ctx, this.ctx.player)?.argentStocked?.() === true;
  }

  /**
   * The cards this altar is offering, as ids (issue #173).
   *
   * Derived, never drawn: `Items.previewArgent` runs a stream salted off the
   * run seed and this altar's own stage index, so the answer is a pure function
   * of (seed, stage) and re-reading it costs the gameplay stream nothing. That
   * is what lets `prompt()` name the cards at last — the reason it could not
   * before was that naming meant drawing, and drawing on the render path made
   * the run's random sequence a function of frame rate.
   *
   * `stageIndex` is the offer id: one altar per stage, so it identifies this
   * offer and only this offer, and a reload that rebuilds the altar rebuilds
   * the same three cards. Cached because the derivation is cheap but not free
   * and this is read every frame the player stands here; the cache is an
   * optimisation and never the source of truth.
   *
   * Back to ONE shared cache, not per pawn (issue #223 round 2 reverses round
   * 1's per-pawn `Map`): `previewArgent` is pure again — temper pity no
   * longer mutates anything inside it — so these base ids really are a pure
   * function of (seed, stage) and identical for every seat, exactly as the
   * paragraph above always claimed. Whatever a specific pawn's pity state
   * does to what they are SHOWN happens one layer up, in
   * `consecrationPreview` (a non-mutating peek) and in `interact`'s
   * consecrate branch (the one authoritative commit) — never here.
   */
  _consecrationIds() {
    if (this._conIds) return this._conIds;
    const items = Items.of(this.ctx, this.ctx.player);
    this._conIds = items?.previewArgent?.(RELIQUARY.choices, this.stageIndex ?? 0) ?? [];
    return this._conIds;
  }

  /**
   * The offer as the player reads it: name, the effect at the stack they would
   * actually end up holding, and what they already hold of it.
   *
   * The effect line is `description(held + 1)` rather than `description(1)`,
   * which is the whole of the synergy preview and needs no second table: an
   * argent card's own catalogue text already quotes its held-other multipliers
   * (the Pale Standard says what a Warden's Tally does to it), and evaluating
   * it one copy deeper is exactly the number the purchase would buy.
   */
  consecrationPreview(pawn = this.ctx.player) {
    // Whose pack the "you already hold N" line is about, AND (issue #223
    // round 2) whose pity state a non-mutating `peekArgentPity` reads to
    // decide whether THIS pawn's display should already be showing a forced
    // card. `_consecrationIds()` itself never varies by pawn any more — see
    // its own comment — so only the peek layered on top does, and a peek
    // costs pity nothing: this may be called every frame from a prompt on
    // any peer without ever moving `_pity.argentMisses`.
    const items = Items.of(this.ctx, pawn);
    const base = this._consecrationIds();
    const ids = items?.peekArgentPity?.(base) ?? base;
    return ids.map((id, i) => {
      const def = ITEM_BY_ID.get(id);
      const held = items?.count?.(id) ?? 0;
      const desc = typeof def?.description === 'function' ? def.description(held + 1) : '';
      return { index: i, id, name: def?.name || id, description: desc, held, selected: i === this.consecratePick() };
    });
  }

  /**
   * Which of the previewed cards the press will take. Clamped on read rather
   * than on write so a shorter pool (a card cut from the tier, a one-card test
   * fixture) can never leave the altar pointing at nothing. A peek never
   * changes the length of the base ids (it only ever substitutes a slot), so
   * this needs no pawn — the aim is a single index shared by the whole party,
   * exactly as it was before pity existed.
   */
  consecratePick() {
    const n = this._consecrationIds().length;
    if (n <= 0) return 0;
    return Math.min(Math.max(0, this._conPick | 0), n - 1);
  }

  /**
   * Hand over the card the choice settled on, and say so (issue #204).
   *
   * Everything the press used to do after `spendMotes`, moved behind the
   * window: the grant, the two effects and the two events all describe the
   * card that was actually named, so a run's logbook records the choice rather
   * than the aim. Charging is deliberately *not* here - it happened at the
   * press, and repeating it would let a lapse bill a purse twice.
   */
  _deliverConsecration(items, id, offered, offer, pawn) {
    // A window that ended without a card - lapsed, superseded, run over - is
    // still a purchase that was paid for, and it settles on the aim the player
    // left the altar pointing at. Untouched, that is card 1, which is exactly
    // what a press bought before the window existed.
    const chosen = id || offered[this.consecratePick()] || offered[0];
    if (!chosen) return false;
    // The aim follows the pick, so `consecratePick`/`consecrationPreview` and
    // the card actually taken can never disagree afterwards - this is the call
    // #204 opened for, and the panel's press is what makes it.
    const i = offered.indexOf(chosen);
    if (i >= 0) this.selectConsecration(i);
    items.grant(chosen);
    // The most expensive press on the purity route had no sound at all
    // (issue #154). The Sanctuary chord walked and an octave up, under a
    // rising column of motes: the deeper rung has to read as the deeper one.
    this.ctx.vfx?.consecration?.(this.position);
    this.ctx.audio?.consecrate?.(this.position);
    this.ctx.events.emit('voidBargain', { kind: 'consecrate', id: chosen, marks: 0, motes: offer.motes, owner: pawn });
    this.ctx.events.emit('argentConsecrate', {
      // Both halves of the decision. The id alone cannot answer the question
      // the ticket is for - whether players take the card they were shown or
      // the one they were shown *next to* it - so the table it was chosen
      // from rides along with the choice.
      id: chosen, offered, motes: offer.motes,
      world: this.ctx.corruption?.world ?? 0, band: this._band(), owner: pawn,
    });
    return true;
  }

  /** Aim the press at one of the previewed cards. Costs nothing and spends nothing. */
  selectConsecration(i) {
    const n = this._consecrationIds().length;
    if (!(i >= 0) || i >= n) return false;
    this._conPick = i | 0;
    return true;
  }

  /**
   * How much an argent card pays at the gauge's current reading: 1 at Pristine,
   * 0 at Overrun and below. The altar computes it rather than importing the
   * pool's own `grace`, for `_reliquaryId`'s reason — this lane must read
   * correctly with no pool in the tree.
   */
  _grace() {
    const world = this.ctx.corruption?.world ?? 0;
    return Math.max(0, Math.min(1, 1 - world / RELIQUARY.fadeAt));
  }

  /**
   * What this band's own bargain costs in marks, or null where the band prices
   * nothing in them: Pristine has no bargain, and Consumed's price is the run.
   * Derived from the same `BOON` table `offer()` reads, so the shortfall the
   * altar quotes and the shortfall it enforces cannot drift apart.
   */
  _price() {
    const band = this._band();
    if (band >= BOON.ruin.band || band < BOON.reroll.band) return null;
    if (band >= BOON.pact.band) return BOON.pact.marks;
    if (band >= BOON.synergy.band) return BOON.synergy.marks;
    return BOON.reroll.marks;
  }

  /**
   * The gap between the purse and this band's price, or null when there is no
   * gap (or no price). `toNext` is the corruption still owed on the *next*
   * mark, read off the peak because that is what mints one - the run has to go
   * deeper, and bleeding back at a font will not do it.
   */
  shortfall() {
    const want = this._price();
    if (want == null) return null;
    const held = this._marks();
    if (held >= want) return null;
    const peak = this.ctx.corruption?.peak ?? 0;
    return { want, held, toNext: BOON.markPer - (peak % BOON.markPer) };
  }

  /**
   * What the maw is saying from across the stage (issue #36, D3). The first
   * pass lerped one intensity between "afforded" and "rock", which answers
   * *whether* the bargain is reachable and says nothing about how near it is -
   * so a party twelve corruption from a pact read the same dead cone as a party
   * that had spent everything, and saving toward the altar looked like nothing
   * happening. `progress` is the missing term: whole marks held plus the
   * fraction of the next one the run has already dug, over the price.
   */
  signal() {
    if (this.spent) return { state: 'spent', want: 0, held: this._marks(), progress: 1 };
    const short = this.shortfall();
    const held = this._marks();
    // An offer priced in the other purse is affordable *now*, whatever the mark
    // shortfall says (issue #172). Reading the ember at a stage where the party
    // can walk over and spend motes told them the altar had nothing for them,
    // which is the at-range half of purity being unspendable.
    if (short) {
      const off = this.offer();
      if (off && (off.motes ?? 0) > 0) return { state: 'afford', want: short.want, held, progress: 1 };
    }
    if (!short) {
      // An offer that is standing - the band's own bargain, or Sanctuary in the
      // other currency - reads as afforded; anything else is a rock.
      return this.offer()
        ? { state: 'afford', want: this._price() ?? 0, held, progress: 1 }
        : { state: 'dormant', want: this._price() ?? 0, held, progress: 0 };
    }
    const peak = this.ctx.corruption?.peak ?? 0;
    const frac = (peak % BOON.markPer) / BOON.markPer;
    return {
      state: 'short',
      want: short.want,
      held: short.held,
      toNext: short.toNext,
      progress: Math.min(0.999, (short.held + frac) / short.want),
    };
  }

  /** Every terminal on the stage that is still selling something. */
  _terminals() {
    return (this.ctx.interactables?.list || [])
      .filter((i) => i instanceof MultishopTerminal && !i.used && i.enabled);
  }

  prompt() {
    const marks = this._marks();
    const purse = `${marks} mark${marks === 1 ? '' : 's'}`;
    const offer = this.offer();
    if (!offer) {
      if (this.ctx.corruption?.ruined) return 'Void Bargain - the bargain is struck; nothing is left to trade';
      const band = this._band();
      if (band < BOON.reroll.band) return `Void Bargain - dormant until Seeded (${purse})`;
      const short = this.shortfall();
      if (!short) return `Void Bargain - ${BANDS[band].name} has nothing to sell you (${purse})`;
      // The number is the whole sentence (issue #36, D3). "Wants more than you
      // hold" tells a party one mark short exactly what it already knew; what
      // it cannot see is the price, its own purse and - the clause that turns
      // the next chest into a purchase - how much more greed the mark costs.
      return `Void Bargain - ${BANDS[band].name} wants ${short.want} mark${short.want === 1 ? '' : 's'}; you hold ${short.held}
`
        + `${Math.ceil(short.toNext)} more corruption mints the next`;
    }
    const price = `${offer.marks} of ${purse}`;
    switch (offer.kind) {
      case 'sanctuary': {
        // Priced in the other currency, so the purse quoted is the other purse.
        // The greed clause is the whole decision: the window is worth exactly
        // twice as much after the teleporter, and a player who cannot see that
        // will spend it on the wrong chest.
        const motes = this._motes();
        return `Void Bargain - Sanctuary (${offer.motes} of ${motes} argent mote${motes === 1 ? '' : 's'})\n`
          + `for ${MOTE.sanctuarySeconds}s nothing you take feeds the void\n`
          + (this.ctx.corruption?.greed
            ? 'greed time is running - the window is worth double right now'
            : 'worth double once the teleporter is done');
      }
      case 'consecrate': {
        // The third clause is the decision, exactly as the greed clause is for
        // Sanctuary: it is the only place the game says out loud that a
        // purchase is worth less the dirtier the gauge is.
        const motes = this._motes();
        const band = this._band();
        const world = Math.round(this.ctx.corruption?.world ?? 0);
        // The cards are named now (issue #173). They can be, because they are
        // derived rather than drawn - see `_consecrationIds`. Each line quotes
        // the effect at the stack the purchase would actually leave the player
        // holding, so an offer of a card they already carry reads as the
        // upgrade it is rather than as a duplicate.
        const cards = this.consecrationPreview().map((c) => {
          const mark = c.selected ? '>' : ' ';
          const have = c.held > 0 ? ` (you hold ${c.held})` : '';
          return `${mark} ${c.index + 1}. ${c.name}${have} - ${c.description}`;
        }).join('\n');
        return `Void Bargain - Consecrate: one of ${this._consecrationIds().length} warded cards `
          + `(${offer.motes} of ${motes} argent mote${motes === 1 ? '' : 's'})\n`
          + `${cards}\n`
          + `the world stands at ${world} - ${BANDS[band].name} - paying ${Math.round(this._grace() * 100)}%`;
      }
      case 'reroll':
        return `Void Bargain - re-draw ${offer.shops.length} terminal${offer.shops.length === 1 ? '' : 's'} (${price})`;
      case 'synergy': {
        const { synergy, baseId } = offer.plan;
        const name = ITEM_BY_ID.get(baseId)?.name || baseId;
        return `Void Bargain - complete ${synergy.name} (${price})\n`
          + `corrupts your ${name}, permanently\n${synergy.blurb}`;
      }
      case 'pact':
        return `Void Bargain - ${offer.pact.name} (${price} and +${BOON.pact.debt} corruption)\n`
          + `${offer.pact.line} for ${BOON.pact.seconds}s`;
      case 'ruin':
        return 'Void Bargain - let it all the way in (free, and final)\n'
          + 'every skill, every swing, for the rest of the run\n'
          + 'the Argent Font goes silent - there is no cleansing after this';
      default:
        return 'Void Bargain';
    }
  }

  interact(pawn = this.ctx.player) {
    let offer = this.offer();
    if (!offer || this.spent) return false;
    const cor = this.ctx.corruption;
    if (!cor) return false;

    // Sanctuary is the one offer priced in motes and the one that never touches
    // an inventory, so it settles before the pack is even looked up — a purity
    // press must not be refused because the presser is carrying nothing.
    if (offer.kind === 'sanctuary') {
      if (!cor.spendMotes(offer.motes)) return false;
      cor.sanctuary();
      // Issue #154: a mote bought this, and it used to look and sound exactly
      // like a chest paying out. Lattice going up, restorative chord, at the
      // altar rather than at the presser — the shell is a property of the
      // ground, which is why `VFX` does not ride `voidSanctuary` for it.
      this.ctx.vfx?.sanctuaryOpen?.(this.position);
      this.ctx.audio?.sanctuary?.(this.position);
      this.ctx.events.emit('voidBargain', { kind: 'sanctuary', motes: offer.motes, marks: 0, owner: pawn });
      return true;
    }

    const items = Items.of(this.ctx, pawn);
    if (!items) return false;

    // Consecration is the reliquary's rung: paid in motes, delivered as a
    // permanent card. Paid first and delivered second like every other bargain,
    // and a press that could not pay leaves the offer standing — the card is
    // only forgotten when the press succeeded.
    if (offer.kind === 'consecrate') {
      // No draw at all any more (issue #173): the press takes the card the
      // player was aiming at out of a list they have been reading. Resolved
      // before the purse is touched, so an empty pool leaves the motes where
      // they were. `base` is the plain, pawn-invariant ids — used only to
      // check whether there is anything to offer at all and whether a window
      // is already standing, never shown or delivered as-is once pity can
      // apply (see `commitArgentPity` below).
      const base = this._consecrationIds();
      if (!base.length) return false;
      // A decision already standing for this pawn is not this press's to paint
      // over (issue #204). The altar is repeatable until it is spent, so
      // refusing costs the player a press; forfeiting the other window costs
      // them a stack or an item.
      //
      // *Both* windows, not just the pack's (integration review M3). The blight
      // toll and the chest's three-way claim live in different objects but in
      // one panel slot, and checking only `Items` let an altar press repaint a
      // live chest offer out of it — the panel gone, the claim never put, and
      // the offer lapsing safe on the host's clock while the player was looking
      // at three cards from somewhere else.
      if (base.length > 1
        && (items.hasChoiceWindow?.() || this.ctx.interactables?.openOfferFor?.(pawn))) return false;
      // The motes are spent by the *press*, not by the card. That is what makes
      // the window safe to lapse: the purchase is already made, so silence
      // hands over the aimed card rather than swallowing the purse, which is
      // exactly the behaviour a press had before the cards became selectable.
      if (!cor.spendMotes(offer.motes)) return false;
      this.spent = true;
      // THE one authoritative commit (issue #223 round 2): motes are
      // genuinely spent and this altar is genuinely `spent` the instant this
      // runs, so this is a real offer assembled exactly once — never from a
      // render/prompt path, never twice for the same press. Everything
      // downstream (the choice window's cards, the eventual grant) reads
      // `offered`, not a fresh peek, so what the player is shown here can
      // never drift from what pity actually decided.
      const offered = items.commitArgentPity ? items.commitArgentPity(base) : base;
      const deliver = (id) => this._deliverConsecration(items, id, offered, offer, pawn);
      // A field of one is no choice, so a single stocked card is handed over
      // outright rather than behind a window whose only button is the
      // inevitable - the same rule `_openMutationChoice` states for the toll.
      if (offered.length < 2) { deliver(offered[0]); return true; }
      const opened = items.openArgentChoice?.({
        seconds: RELIQUARY.choiceSeconds,
        cards: offered.map((id) => {
          const def = ITEM_BY_ID.get(id);
          const held = items?.count?.(id) ?? 0;
          const desc = typeof def?.description === 'function' ? def.description(held + 1) : '';
          // `baseId` is the wire's and the panel's name for "the token this
          // card answers with", shared with the blight kind so the client
          // mirror, `chooseMutation` and `MSG.MUTATE` need no second vocabulary.
          return { baseId: id, argentId: id, argentName: def?.name || id, argentDescription: desc, held };
        }),
        resolve: deliver,
      });
      // No window (a pack with none of this machinery, a race that filled the
      // slot between the two checks): the motes are already gone, so the aimed
      // card is handed over rather than lost.
      if (!opened) deliver(null);
      return true;
    }

    // Ruin is free of marks and charged in the run instead, so it is settled
    // before the purse is ever touched.
    if (offer.kind === 'ruin') {
      if (!cor.ruin()) return false;
      for (const b of RUIN.buffs) items.addBuff(b.buff, RUIN.seconds, b.maxStacks, b.magnitude);
      this.spent = true;
      this.maw.material.emissiveIntensity = 2.4;
      this.ctx.audio?.play?.('shrineBlood', this.position);
      // Ruin was the one altar branch that announced itself only through
      // `voidRuin` — `Corruption.ruin()` commits its own weight, so nothing
      // needed a bargain event and none was emitted. That silence was a hole:
      // #177's restraint vow watches `voidBargain`, so a run could press the
      // heaviest corrupt act in the table (24) and still close the Vow of the
      // Closed Hand kept. It is a bargain struck at the altar like the others
      // and now says so in the others' shape. Deliberately absent from
      // `Corruption`'s BARGAIN_COMMIT map, so this cannot double-bill `ruin`.
      this.ctx.events.emit('voidBargain', { kind: 'ruin', marks: 0, motes: 0, owner: pawn });
      return true;
    }
    // Everything else is paid first and delivered second: a bargain that could
    // fail after taking the marks would be the one dishonest thing here.
    if (!cor.spendMarks(offer.marks)) return false;

    if (offer.kind === 'reroll') {
      let n = 0;
      for (const t of offer.shops) if (t.reroll()) n++;
      this.ctx.events.emit('voidBargain', { kind: 'reroll', marks: offer.marks, count: n, owner: pawn });
    } else if (offer.kind === 'synergy') {
      const { synergy, baseId } = offer.plan;
      items.corruptStack(baseId);
      // Recorded, not applied: the synergy is permanent but its strength is a
      // function of live corruption, so `Items.stats` re-derives it every time
      // the gauge moves rather than freezing today's number into a buff slot.
      items.grantSynergy(synergy);
      this.ctx.events.emit('voidBargain', { kind: 'synergy', marks: offer.marks, id: synergy.id, baseId, owner: pawn });
    } else {
      const p = offer.pact;
      items.addBuff(p.buff, BOON.pact.seconds, 1, p.magnitude);
      // The debt is the second half of the price and goes through `feed`, so
      // greed time and the artifact economy apply to a pact exactly as they do
      // to a chest — and a pact taken at the wrong moment can carry the party
      // into Consumed, which is the decision the band exists to pose.
      cor.feed(pawn, BOON.pact.debt, this.position);
      this.markGreed();
      this.ctx.events.emit('voidBargain', { kind: 'pact', marks: offer.marks, id: p.id, owner: pawn });
    }
    this.ctx.audio?.play?.('shrineWin', this.position);
    return true;
  }

  update(dt) {
    // The maw brightens with the purse, and now it brightens *toward* it: an
    // altar you can afford burns violet and breathes, one you are saving for
    // glows a cold ember that climbs with every mark, and one with nothing to
    // sell is a rock. All three are legible from across the stage, which is the
    // point - the decision to walk over here is made before you arrive.
    const sig = this.signal();
    this._pulse = (this._pulse + dt) % 1000;
    let want = 0.35;
    // Dormant keeps the rock's own violet — the ember is a debt being paid off,
    // and a dormant altar holds no debt.
    let hue = AFFORD_EMISSIVE;
    if (sig.state === 'spent') { want = 2.4; }
    else if (sig.state === 'afford') {
      want = 1.6 + 0.2 * Math.sin(this._pulse * 3.4);
    } else if (sig.state === 'short') {
      want = 0.4 + 0.7 * sig.progress;
      hue = SHORT_EMISSIVE;
    }
    const m = this.maw.material;
    m.emissiveIntensity += (want - m.emissiveIntensity) * Math.min(1, dt * 3);
    if (m.emissive.getHex() !== hue) m.emissive.setHex(hue);
  }
}

// --------------------------------------------------------------- blight wound

/**
 * A Blight Wound (#178): a blight patch that can be argued with.
 *
 * Promoted from a seed the run itself planted, never sited — so a wound is
 * always standing on ground the party chose to spoil, and a run that never got
 * greedy never sees one. Placement is `Interactables._promoteWound`.
 *
 * ## Host authority
 *
 * Like every other interactable, the press is resolved on the host:
 * `Interactables.requestInteract` gates on `ctx.authority` and a guest's E only
 * sets the command bit. Guests build a view through `VIEW_BUILDERS` and see the
 * prop and its availability; they do NOT see the seal window's progress, which
 * is host-local state with no snapshot field — the same gap a client's cost
 * text already has, and noted rather than closed by this prototype.
 *
 * ## How the two outcomes are reached
 *
 * The press raises them as a two-card choice window — the machinery #204
 * generalised for the argent altar, with `kind: 'wound'` as its third caller.
 * There is still no alternate-interact binding in `core/Bindings.js` and none
 * is wanted: a wound is a decision, not a second verb.
 *
 * The first draft followed `VoidBargain.selectConsecration`'s precedent
 * instead — an aim method and one press. That precedent did not survive: #204
 * removed it from the altar for exactly the reason the integration review then
 * found here, that nothing in `src/` ever called the aim, so every wound sealed
 * and half the prompt advertised an outcome the player could not take.
 * `selectOutcome` remains as the aim for contexts with no window machinery at
 * all, which is the only place it now decides anything.
 */
export class Wound extends Interactable {
  constructor(ctx, position, strength = WOUND.minStrength) {
    super(ctx, position);
    this.typeId = TYPE_ID.wound;
    this.radius = WOUND.radius;
    this.strength = strength;
    this.state = 'open';          // open -> sealing -> sealed | fed
    this.outcome = 'seal';        // what the next press resolves
    this.hold = 0;                // seconds held inside `sealHold`
    this.sealer = null;           // the pawn holding it

    const base = new THREE.Mesh(sharedGeo('woundBase', () => plinthGeo(1.1, 7)), STONE());
    // A torn ring lying in the ground rather than a plinth standing on it: the
    // wound is the ground, and anything proud of it would read as another
    // shrine. The shard is the only vertical, and it leans.
    this.ring = new THREE.Mesh(
      sharedGeo('woundRing', () => new THREE.TorusGeometry(1.5, 0.13, 6, 18).rotateX(Math.PI / 2).translate(0, 0.12, 0)),
      glowMat(0xb64ad0)
    );
    this.shard = new THREE.Mesh(
      sharedGeo('woundShard', () => new THREE.ConeGeometry(0.3, 1.3, 5).rotateZ(0.22).translate(0, 0.85, 0)),
      glowMat(0x7a46c8)
    );
    base.receiveShadow = true;
    this.shard.castShadow = true;
    this.group.add(base, this.ring, this.shard);
  }

  available() { return this.enabled && this.state !== 'sealed' && this.state !== 'fed'; }

  /** Aim the press. Costs nothing, spends nothing, commits nothing. */
  selectOutcome(outcome) {
    if (outcome !== 'seal' && outcome !== 'feed') return false;
    if (!this.available()) return false;
    if (outcome !== this.outcome) this.hold = 0;
    this.outcome = outcome;
    this.state = 'open';
    this.sealer = null;
    return true;
  }

  /**
   * What a seal would actually hand back, live.
   *
   * `Corruption.bleed` clamps to the world, so quoting the flat `WOUND.sealWard`
   * told a party standing on a world of 3 that sealing would return 8 — the
   * integration review's m4. The commitment is unconditional and the ward is
   * not, so only this half moves.
   */
  _sealQuote() {
    const world = this.ctx?.corruption?.world;
    const n = Number.isFinite(world) ? Math.min(WOUND.sealWard, world) : WOUND.sealWard;
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  }

  /**
   * Both outcomes, always, with their numbers — the whole preview. A wound is
   * the one prop on the stage where the two economies are the same press, so
   * quoting only the aimed one would hide half the decision.
   *
   * The feed clause goes through `pricedPrompt` like every other corrupting
   * press in this file (`AuricCairn`, `GildedSnare`), and the reason is not
   * consistency for its own sake — it was the integration review's M1. Hand-
   * building the clause quoted face value, and greed time is the condition that
   * produces most wounds: `Corruption.seed` adds +1 strength while greed is on
   * and `WOUND.minStrength` is 2, so the common seeders only qualify while the
   * multiplier is on. A wound quoted +18 charged 36, and a 36-point charge off
   * a world of 25 clears Blighted in one press — a band crossing that queues an
   * item toll, with no line of text about it. `pricedPrompt` is the one
   * expression that quotes the multiplier, the mint forecast and the band edge,
   * so the quote and the charge cannot drift again.
   *
   * It goes LAST because it returns its own pipe-joined ledger lines, and a
   * clause appended after them would read as one of them.
   */
  prompt() {
    if (this.state === 'sealed') return 'Blight Wound - sealed; the ground is quiet';
    if (this.state === 'fed') return 'Blight Wound - fed; it is spreading';
    const seal = `Seal (hold ${WOUND.sealWindow}s, -${this._sealQuote()} corruption, pure commitment)`;
    const feed = pricedPrompt(this.ctx, 'Feed (the patch spreads, corrupt commitment)', WOUND.feedCorruption);
    if (this.state === 'sealing') {
      const left = Math.max(0, WOUND.sealWindow - this.hold);
      return `Blight Wound - sealing, ${left.toFixed(1)}s left (stay within ${WOUND.sealHold}m) - or - ${feed}`;
    }
    return `Blight Wound - ${seal} - or - ${feed}`;
  }

  /**
   * The press raises the wound's two outcomes as a choice window (#178,
   * integration M2) — the machinery #204 generalised for the argent altar,
   * with a third kind.
   *
   * Before this the prompt advertised a Feed nothing could reach:
   * `selectOutcome` had no production caller, `this.outcome` was born 'seal'
   * and never moved, so every wound in the build sealed while half the prompt
   * described an offer the player could not take.
   *
   * Host-side by construction and therefore no wire change: a guest's E only
   * sets the command bit and `requestInteract` gates on `ctx.authority`, so the
   * window is always opened on the machine that will resolve it. The addressed
   * `mutationChoiceOffered` still names the owner, so a host holding two seats
   * paints the panel on the right one.
   */
  interact(pawn = this.ctx.player) {
    if (!this.available() || !pawn) return false;
    if (this.state === 'sealing') return false;   // already holding; the window is the act
    // Lapse and an explicit seal are the same landing: the safe half. Sealing
    // still costs the hold — silence buys the *attempt*, not the seal, which is
    // the honest default because it is what walking up to a wound and doing
    // nothing in particular should mean.
    const answer = (id) => {
      if (id === WOUND_PICK.feed) this._feed(pawn);
      else this._beginSeal(pawn);
    };
    const items = Items.of(this.ctx, pawn);
    // The altar's rule (M3) applies here too: a live item offer is a standing
    // decision this press may not paint over — refuse before opening a window.
    if (this.ctx.interactables?.openOfferFor?.(pawn)) return false;
    const aimed = this.outcome === 'feed' ? WOUND_PICK.feed : WOUND_PICK.seal;
    // A pack with none of this machinery (stub contexts, the pre-#204 surface)
    // resolves the aimed outcome outright rather than losing the press.
    if (!items?.openWoundChoice) { answer(aimed); return true; }
    const opened = items.openWoundChoice({
      seconds: WOUND.choiceSeconds,
      cards: [
        {
          baseId: WOUND_PICK.seal,
          woundName: 'Seal the wound',
          woundDescription: `Hold this ground for ${WOUND.sealWindow}s. The patch closes, the void stops surfacing here, and the run commits to purity.`,
          note: `returns ${this._sealQuote()} corruption`,
        },
        {
          baseId: WOUND_PICK.feed,
          woundName: 'Feed the wound',
          woundDescription: 'The patch spreads and the ground round here gets worse. The corruption it charges mints against the descent.',
          note: pricedPrompt(this.ctx, 'toward void marks', WOUND.feedCorruption),
        },
      ],
      resolve: answer,
    });
    if (opened) return true;
    // A window already standing on this pack is somebody else's decision. The
    // wound is repeatable and free, so refusing the press costs a press;
    // painting over a blight toll would cost a stack.
    if (items.hasChoiceWindow?.()) return false;
    answer(aimed);
    return true;
  }

  _beginSeal(pawn) {
    if (!this.available() || !pawn) return;
    this.state = 'sealing';
    this.sealer = pawn;
    this.hold = 0;
  }

  update(dt) {
    if (this.state !== 'sealing') return;
    const pawn = this.sealer;
    // Straying — or bleeding out — resets rather than fails: the window is a
    // commitment of attention, and a wound you can never re-attempt is a
    // hazard with a punish attached, not a decision.
    if (!pawn?.alive || pawn.position.distanceTo(this.position) > WOUND.sealHold) {
      this.state = 'open';
      this.sealer = null;
      this.hold = 0;
      return;
    }
    this.hold += dt;
    if (this.hold >= WOUND.sealWindow) this._seal(pawn);
  }

  _seal(pawn) {
    this.state = 'sealed';
    this.used = true;
    this.hold = 0;
    this.sealer = null;
    this.ring.visible = this.shard.visible = false;
    this._resolve('seal', pawn);
  }

  _feed(pawn) {
    this.state = 'fed';
    this.used = true;
    this.ring.material = glowMat(0xc8379b);
    this._resolve('feed', pawn);
  }

  /**
   * One event, three listeners, no direct calls: `Corruption` bills the ledger
   * and moves the world, `Blight` closes or spreads the patch, `Director` drops
   * the sealed seed out of the void's spawn list. Routing it this way is what
   * lets `tests/alignment-ledger.test.mjs` drive the commitment off an event
   * like every other wired source, and keeps this class from knowing that
   * blight is drawn at all.
   */
  _resolve(outcome, pawn) {
    this.ctx.events?.emit?.('woundResolved', {
      outcome, owner: pawn ?? null,
      x: this.position.x, z: this.position.z,
      stage: this.ctx.progression?.stageIndex ?? null,
      radius: this.radius,
      ward: WOUND.sealWard,
      corruption: WOUND.feedCorruption,
      expand: WOUND.feedExpand,
    });
  }
}

// ------------------------------------------------------------ tempering anvil

/**
 * The Tempering Anvil (issue #208) — the world-side door onto `Items.temper()`
 * (#179), which existed for four rounds with no way to reach it in real play.
 *
 * Free to press: the parents are the price, exactly as `temper()`'s own doc
 * comment states (#179's review settled that no unquoted toll may ride a
 * temper), so unlike every other shrine here there is no `this.cost` and no
 * `markGreed` charge on the press itself — only on a successful forge, the
 * same rung a chest's paid open plants (issue #30's every-greed-act-plants-
 * a-seed rule, applied to the one genuinely greedy act this prop offers).
 *
 * Unlimited uses, unlike the Kiln's three or the Covenant Stone's capped run
 * — deliberately. Both of those cap an otherwise-free conversion because nothing
 * else bounds how often a player could take it; the anvil's bound is already
 * structural, since every press still needs a fresh, named argent-and-blight
 * pair in the pack, and there are at most three such pairs a run can ever
 * hold. Capping uses on top of that would be a toll on a decision the recipe
 * table already prices.
 *
 * The press itself is a real standing decision, guarded in both directions
 * exactly like the altar and the wound (issue #204/#207 house law): a chest
 * offer already open refuses this press outright, and this press's own window
 * refuses to open over anyone else's for the same reason.
 */
export class TemperingAnvil extends Interactable {
  constructor(ctx, position) {
    super(ctx, position);
    this.typeId = TYPE_ID.temperingAnvil;
    this.radius = 2.2;

    const base = new THREE.Mesh(sharedGeo('anvilBase', () => plinthGeo(1.0, 6)), STONE());
    base.castShadow = true;
    base.receiveShadow = true;
    // The classic anvil silhouette, low and horned, so it reads as "strike
    // here" from across a stage the way the Kiln's chimney reads as "burn".
    const body = new THREE.Mesh(
      sharedGeo('anvilBody', () => {
        const parts = [
          box(0.62, 0.20, 0.62, 0, 0.20, 0),                 // foot
          box(0.30, 0.40, 0.30, 0, 0.60, 0),                 // waist
          box(0.86, 0.24, 0.56, 0, 0.94, 0),                 // face
          box(0.30, 0.16, 0.30, -0.62, 0.90, 0),              // horn base
          box(0.20, 0.14, 0.20, -0.86, 0.88, 0),              // horn tip
        ];
        const g = mergeGeometries(parts, false);
        for (const p of parts) p.dispose();
        return g;
      }),
      IRON_DARK()
    );
    body.castShadow = true;
    // Per-instance: the ember in the face brightens while a forge decision is
    // standing open, the same "the prop tells you a window is live" language
    // the altar's maw and the wound's shard both speak.
    this.ember = new THREE.Mesh(
      sharedGeo('anvilEmber', () => box(0.50, 0.05, 0.30, 0, 1.065, 0)),
      new THREE.MeshStandardMaterial({
        color: 0x120603, emissive: 0xd9b34a, emissiveIntensity: 0.4, roughness: 0.4,
      })
    );
    this.group.add(base, body, this.ember);
  }

  /**
   * Every Tempered recipe `pawn` could actually forge right now — both named
   * parents held, in any amount. Sorted by id, the same total order the
   * Kiln's `_fuel` keeps, so the prompt, the window and a second peer looking
   * at the same pack can never disagree about which recipes are on the table.
   */
  _eligible(pawn = this.ctx.player) {
    const items = Items.of(this.ctx, pawn);
    if (!items) return [];
    const out = [];
    for (const t of TEMPERED_ITEMS) {
      const parents = TEMPER_BY_ID.get(t.id);
      if (items.count(parents.argent) > 0 && items.count(parents.blight) > 0) out.push(t.id);
    }
    out.sort();
    return out;
  }

  /**
   * Recipe states this pawn can see right now (issue #221): `temperRecipeStates`
   * filtered through `Profile.isDiscovered`, so a recipe nobody has ever met
   * never reaches the prompt. Absent a profile (a satellite pawn with none
   * wired, or a test) nothing is ever "known" — the safe default is silence,
   * never a spoiler.
   */
  _states(pawn = this.ctx.player) {
    const items = Items.of(this.ctx, pawn);
    if (!items) return [];
    const profile = this.ctx.profile;
    const isDiscovered = profile?.isDiscovered ? profile.isDiscovered.bind(profile) : () => false;
    return temperRecipeStates((id) => items.count(id), isDiscovered);
  }

  prompt() {
    const eligible = this._eligible();
    if (eligible.length) {
      const names = eligible.map((id) => ITEM_BY_ID.get(id)?.name || id).join(', ');
      return `Tempering Anvil — forge ${names}`;
    }
    // Nothing forgeable this instant. A recipe the player has already met —
    // either parent, or the tempered result itself — still reports its
    // progress here (known, not yet eligible); a recipe nobody has ever
    // encountered stays out of this line entirely, so standing at an empty
    // anvil never spoils a pairing the player hasn't found.
    const known = this._states().filter((r) => r.state === 'known');
    if (!known.length) {
      return 'Tempering Anvil — needs a warded card and the blight it names, held together';
    }
    const lines = known.map((r) => {
      const missing = [];
      if (!r.argent.owned) missing.push(r.argent.discovered ? r.argent.name : 'an unmet parent');
      if (!r.blight.owned) missing.push(r.blight.discovered ? r.blight.name : 'an unmet parent');
      return `${r.name} (needs ${missing.join(' + ')})`;
    });
    return `Tempering Anvil — ${lines.join('; ')}`;
  }

  interact(pawn = this.ctx.player) {
    const items = Items.of(this.ctx, pawn);
    if (!items || !pawn) return false;
    const eligible = this._eligible(pawn);
    // Nothing to forge: the press is a no-op, exactly what the prompt already
    // told the player standing here.
    if (!eligible.length) return false;
    // The altar's rule (#204/M3), the same direction the wound's press takes
    // it: a standing chest offer is not this press's to paint over.
    if (this.ctx.interactables?.openOfferFor?.(pawn)) return false;

    const forge = (id) => { if (TEMPER_BY_ID.has(id)) items.temper(id); };
    // Declining, by button or by silence, always leaves the pack untouched —
    // `forge` above is a no-op for anything that is not a real recipe id, so
    // the decline card below and a lapsed window resolve identically.
    const DECLINE = 'temper:decline';
    const cards = eligible.map((id) => {
      const { argent, blight } = TEMPER_BY_ID.get(id);
      const def = ITEM_BY_ID.get(id);
      const consumes = `consumes ${ITEM_BY_ID.get(argent)?.name || argent} + ${ITEM_BY_ID.get(blight)?.name || blight}`;
      return {
        baseId: id,
        woundName: `Forge ${def?.name || id}`,
        woundDescription: typeof def?.description === 'function' ? def.description(1) : (def?.description || ''),
        note: consumes,
      };
    });
    // A field of one is still a real decision here, unlike the altar's single-
    // card auto-deliver: forging is destructive and irreversible, so even one
    // recipe gets an explicit accept/decline rather than being handed over on
    // the press alone. The decline card is what buys that second door.
    cards.push({
      baseId: DECLINE,
      woundName: 'Leave the parents whole',
      woundDescription: 'Walk away. Nothing is spent, nothing is forged.',
      note: '',
    });

    const opened = items.openTemperChoice?.({ seconds: ANVIL.choiceSeconds, cards, resolve: forge });
    if (opened) return true;
    // A pack with none of this machinery, or a window already standing on it
    // (the two callers this file's overlap guard exists for): refuse rather
    // than steal, same as the wound.
    if (items.hasChoiceWindow?.()) return false;
    forge(eligible[0]);
    return true;
  }

  update(dt) {
    const live = this.ctx.items?.choiceWindowKind?.() === 'temper';
    const target = live ? 1.8 + Math.sin(this.ctx.time * 4.0) * 0.5 : 0.4;
    this.ember.material.emissiveIntensity = target;
  }
}

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
    //
    // It is a *spire*, not a bar. At a constant 0.55-0.9 radius and emissive
    // 2.4 the column measured up to 3.45x the frame mean, 530px tall, touching
    // 67-84% of every world frame's rows, and in the establishing shot it ran
    // straight down through the hero arch — one hard-edged element identical
    // across four biomes that are otherwise successfully distinct, which reads
    // as HUD chrome standing in the world. Tapering to 0.05 at the top means
    // the upper two thirds of the column is sub-pixel-to-a-few-pixels wide, so
    // it still says "the objective is over there" from anywhere on the stage
    // without owning a vertical third of the composition; the emissive comes
    // down to sit under the bloom knee at rest.
    //
    // The taper fixed the *width*; it did not fix the value. Tapered and tinted
    // the shaft still measured a 195-216 mean against frame means of 64-96, i.e.
    // 2.05-3.27x, because at emissive 1.15 the core sits well over the bloom
    // knee and blows to near-white — which throws away the tint at the same
    // time, since a blown pixel has no hue. 0.42 lands the core in the 120-150
    // band: still the most luminous vertical in the frame and still findable at
    // 200m, but now inside the value range of the picture instead of on top of
    // it, and saturated enough that the per-biome hue actually reads.
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.86, BEACON_HEIGHT, 8, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x0a2b3a, emissive: beaconTint(ctx), emissiveIntensity: BEACON_EMISSIVE, roughness: 0.4,
      })
    );
    this.beacon.position.y = BEACON_HEIGHT * 0.5 + 2.0;

    this.collar = new THREE.Mesh(
      new THREE.TorusGeometry(3.4, 0.22, 6, 28),
      new THREE.MeshStandardMaterial({
        color: 0x102a36, emissive: 0x2ad0ff, emissiveIntensity: COLLAR_EMISSIVE, roughness: 0.3,
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
      : 0.85 + breathe * 0.25;
    this.beacon.material.emissiveIntensity = BEACON_EMISSIVE * k;
    this.collar.material.emissiveIntensity = COLLAR_EMISSIVE * k;
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
    // No PointLight here either, for the reason spelled out on `ItemOrb`: a
    // portal is spawned mid-run, and a light appearing mid-run forks every
    // shader program in the scene. The frame's emissive pulse below carries the
    // same "it is alive" read through bloom.
    this.group.add(this.disc, this.frame);
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
    this.frame.material.emissiveIntensity = 2.2 + Math.sin(this.spin * 3) * 0.8;
  }
}

// ------------------------------------------------------------------ item orb

class ItemOrb {
  constructor(ctx, position, itemId, arc, ownerPawn = null) {
    this.ctx = ctx;
    this.itemId = itemId;
    this.ownerPawn = ownerPawn;
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
    // Emissive + bloom, no PointLight — the same trade the teleporter beacon
    // makes a few hundred lines up, and for the same reason.
    //
    // This orb was the game's first-chest freeze. Adding a PointLight to the
    // scene changes `numPointLights`, which is part of every material's program
    // cache key, so three has to recompile *every* program in the scene — a
    // multi-hundred-millisecond synchronous stall on the render thread. The
    // first chest of a run was the first time the count ever moved off its
    // boot-time value, which is why it always froze; later chests only froze
    // when two orbs happened to be alive at once and pushed the count to a
    // value that had not been compiled yet.
    //
    // `Prewarm` cannot cover this: it warms permutations at a fixed light
    // count, and its own header says a light appearing at runtime defeats it.
    // The rule the rest of the codebase follows is that runtime light changes
    // go through `VFX.LightPool`, which keeps a fixed set permanently in the
    // scene and only animates intensity. An orb wants a steady glow for its
    // whole life rather than a flash, so it takes the beacon's route instead:
    // emissive well above 1 and let bloom do the work for free.
    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 0),
      new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 2.6, roughness: 0.25 })
    );
    this.halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 10),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.26, depthWrite: false })
    );
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.halo);
    this.group.position.copy(this.position);
  }

  /**
   * The pawn this orb is currently homing to, and the pawn the collection
   * grant must pay — the same expression, called from both places, so the
   * two can never diverge again. An owner who is no longer a legal target
   * (bled out or downed mid-flight) falls back to the local viewer rather
   * than have the orb evaporate *or* pay a pawn that never touched it.
   * Owner-less orbs (and every SP orb, where `ownerPawn === ctx.player`)
   * resolve to exactly the pawn this always homed to and always paid.
   */
  recipient() {
    return (this.ownerPawn && Roster.targetable(this.ownerPawn))
      ? this.ownerPawn : this.ctx.player;
  }

  fixedUpdate(h) {
    this.age += h;
    const target = this.recipient();

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
      if (target?.alive && target.position.distanceToSquared(this.position) < ORB_SEEK_RANGE * ORB_SEEK_RANGE) this.state = 'seek';
    } else if (this.state === 'seek' && target) {
      // Accelerating homing so the pickup reads as being *pulled* in.
      const dir = TMP.copy(target.position).setY(target.position.y + 1).sub(this.position);
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
    // Wound promotion state, per stage. `_woundOrdinal` counts blight seeds as
    // they are planted, which is what the promotion predicate is a function of.
    this._woundStage = 0;
    this._woundOrdinal = 0;
    this._wounds = [];
    // A client's shadow of the one item offer the host has addressed to this
    // machine (issue #205). Wire-shaped and inert: it holds no transaction, it
    // resolves nothing, and the only thing it is ever asked for is its
    // identifier. `Items._muteOffer` is the same object for the other window,
    // and for the same reason - the host owns the decision, this owns the
    // panel. Null on a host, where the real offer lives on an interactable.
    this._remoteOffer = null;
    // A chest press that landed on a live blight toll (issue #207), waiting
    // for the toll to clear rather than either stealing it or being refused.
    // At most one queued chest per pawn -- a second press while one is already
    // waiting replaces it, the same "newest wins" rule `settleOpenOffers`
    // applies to two open offers, and just as cheaply: nothing has been
    // charged for a merely-queued chest, so displacing it costs nothing
    // either.
    this._pendingChestOpen = new Map();
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.interactables = this;
    ctx.scene.add(this.root);
    // Registered once, not per `populate`: a listener added per stage would
    // leak one subscription per teleport and promote each seed N times.
    ctx.events.on('blightSeed', (s) => this._promoteWound(s));

    // The role is read inside the handler rather than around the subscription,
    // for `Items`' reason: `ctx.authority` is true for every system at init and
    // a client only becomes one later, at the join.
    ctx.events.on('itemOfferOpened', (e) => {
      if (ctx.authority) return;
      // The host strips `owner` on an addressed send, so a tagged payload that
      // is not this machine's is a broadcast bug, not this seat's offer.
      if (e?.owner && e.owner !== ctx.player) return;
      this._remoteOffer = {
        offerId: e?.offerId >>> 0,
        itemId: e?.itemId || null,
        quote: e?.quote || null,
        // Display only. The host owns the deadline and the close it sends is
        // what ends this window however far this clock has run.
        remaining: e?.seconds ?? 0,
      };
    });
    ctx.events.on('itemOfferResolved', (e) => {
      if (ctx.authority) return;
      if (e?.owner && e.owner !== ctx.player) return;
      // Its own resolution only: a stale close must not tear down the window
      // the player is looking at, which is `hideChoice(id)`'s rule one layer
      // down.
      if (this._remoteOffer && this._remoteOffer.offerId !== (e?.offerId >>> 0)) return;
      this._remoteOffer = null;
    });
  }

  /**
   * Promote a freshly planted blight seed into a Wound, or don't.
   *
   * Placement is a *filter over what the run already did*, not a siting pass —
   * that is the whole design. Wounds cannot be placed in `populate` because at
   * populate time the stage has no seeds on it: seeds are planted by greed as
   * the stage is played, and the previous stage's are stale ground (`Blight`
   * and `Director` both wipe their copies at `stageStart`). So `populate`
   * resets the counters and this hook does the promoting.
   *
   * Four bounds, in order, and every one of them is asserted in
   * `tests/wounds.test.mjs`:
   *
   *   - `WOUND.max` wounds per stage, checked first so nothing else can be
   *     reached once the stage is full;
   *   - `WOUND.minStrength`, so a scuff is not a decision;
   *   - `WOUND.minSpacing` from every wound already standing;
   *   - `promoteWound`, the pure (seed, stage, ordinal) predicate — which is
   *     also why nothing here touches `ctx.rng`.
   */
  _promoteWound(seed) {
    const ctx = this.ctx;
    if (!ctx || !ctx.authority) return null;
    if (this._wounds.length >= WOUND.max) return null;
    const x = seed?.x, z = seed?.z, strength = seed?.strength;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(strength >= WOUND.minStrength)) return null;
    const ordinal = this._woundOrdinal++;
    if (!promoteWound(ctx.seed ?? 0, this._woundStage, ordinal)) return null;
    const min2 = WOUND.minSpacing * WOUND.minSpacing;
    for (const w of this._wounds) {
      const dx = w.position.x - x, dz = w.position.z - z;
      if (dx * dx + dz * dz < min2) return null;
    }
    const y = ctx.stage?.sampleHeight?.(x, z);
    const w = new Wound(ctx, new THREE.Vector3(x, Number.isFinite(y) ? y : 0, z), strength);
    this._wounds.push(w);
    this.add(w);
    ctx.events.emit('woundOffered', {
      stage: ctx.progression?.stageIndex ?? null, ordinal, x, z, strength,
    });
    return w;
  }

  /** Wipes the stage's interactables. Called on every stage transition. */
  clear() {
    for (const i of this.list) { this.root.remove(i.group); i.dispose(); }
    for (const o of this.orbs) { this.root.remove(o.group); o.dispose(); }
    this.list.length = 0;
    this.orbs.length = 0;
    this.teleporter = null;
    this.focus = null;
    // The altar's reserved spot belongs to the stage that was just torn down.
    this._bargainSite = null;
    // So does every wound: the ground they were torn in is gone.
    this._wounds.length = 0;
    // And so does a guest's shadow of an open offer: the chest holding it was
    // just torn down on the host, whose close may never arrive across a stage
    // transition (integration review m3). Left standing it would answer the
    // next stage's first press with a dead identifier the host refuses.
    this._remoteOffer = null;
    // And so does a chest queued behind a toll: the lid it was waiting to open
    // just left the stage with everything else.
    this._pendingChestOpen.clear();
  }

  add(obj) {
    this.list.push(obj);
    this.root.add(obj.group);
    return obj;
  }

  _point(minDistFrom, rng = this.ctx.rng) {
    return this.ctx.stage?.randomWalkablePoint?.(rng, { minDistFrom, minDist: 8 })
      || new THREE.Vector3(rng.range(-40, 40), 0, rng.range(-40, 40));
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
   * All of it draws from `ctx.rng` by default, so a co-op client that
   * regenerates the stage and replays the same stream lands on the same
   * chests. A caller may pass its own stream instead — the one caller that
   * does is the band-gated font guarantee, which must not touch the shared
   * sequence at all (see `_populateShrines`).
   */
  _nearLandmark(lm, r0, r1, rng = this.ctx.rng) {
    const st = this.ctx.stage;
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
  _sited(lm, r0, r1, fallbackFrom, rng = this.ctx.rng) {
    return this._nearLandmark(lm, r0, r1, rng) || this._point(fallbackFrom, rng);
  }

  /**
   * Whether any pack in the run could forge a Tempered card right now —
   * both named parents held, in any amount — the same test
   * `TemperingAnvil._eligible` runs per-press, but asked of every roster
   * pawn rather than one, and asked once at populate time rather than on
   * approach (issue #222). Solo runs and a roster of one both fall through
   * to `[ctx.player]`.
   */
  _temperEligibleAnywhere() {
    const ctx = this.ctx;
    const pawns = ctx.roster?.all?.length ? ctx.roster.all : (ctx.player ? [ctx.player] : []);
    for (const p of pawns) {
      const items = Items.of(ctx, p);
      if (!items || typeof items.count !== 'function') continue;
      for (const t of TEMPERED_ITEMS) {
        const { argent, blight } = TEMPER_BY_ID.get(t.id);
        if (items.count(argent) > 0 && items.count(blight) > 0) return true;
      }
    }
    return false;
  }

  /**
   * Fills a freshly built stage. Count and price both scale with stage index:
   * later stages have more to buy and charge more for it, which is what keeps
   * gold pressure constant while the player's income explodes.
   */
  populate(stageIndex) {
    this.clear();
    const ctx = this.ctx;
    // Wounds are promoted as this stage's greed plants seeds (`_promoteWound`),
    // so all `populate` owes them is a clean per-stage slate.
    this._woundStage = stageIndex | 0;
    this._woundOrdinal = 0;
    const scale = Math.pow(1.25, stageIndex);
    // Cloned: _bargainSite may resolve this long after populate(), and a live
    // reference would make late placement depend on where the player stands.
    const spawn = (ctx.player?.position || new THREE.Vector3()).clone();
    const marks = ctx.stage?.landmarks ?? [];
    // Round-robin rather than random, so all 2-3 landmarks get loot and the
    // player is never rewarded for visiting only the nearest one.
    const mark = (i) => (marks.length ? marks[i % marks.length] : null);

    // Sacrifice takes the shops away — everything purchasable, not just chests,
    // or the artifact's premise ("nothing is bought") survives as three
    // terminals in a field. Shrines stay: they cost health or risk, not gold,
    // and the teleporter is the run, not loot.
    const bought = !ctx.artifacts?.has('sacrifice');

    const chestCount = bought ? 14 + stageIndex * 4 : 0;
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

    const shopCount = bought ? 2 + stageIndex : 0;
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

    this._populateShrines(stageIndex, scale, mark, spawn);

    // Exactly one equipment barrel per stage. Against 14-plus chests it is the
    // sparsest thing on the map, which is the point: equipment is a run-long
    // commitment and finding the barrel should be an event, not a stop on a
    // circuit. One is also the floor — the Q slot's only in-run source cannot
    // be allowed to roll a zero, or a run that spends its starting equipment on
    // stage one has lost the tier for good.
    //
    // Sited off a private, seed-and-stage-derived stream, never `ctx.rng`, for
    // the reason `_populateShrines` documents at length: a single draw taken
    // from the shared sequence displaces every director spawn after it and
    // moves harness captures that have nothing to do with barrels.
    {
      const brng = new RNG(((ctx.seed >>> 0) ^ (0x2545f491 * (stageIndex + 1))) >>> 0 || 1);
      // Landmark 2 upward: 0 is the teleporter's backdrop and 1 is where the
      // first shrine goes, so the barrel is somewhere you have not already been
      // sent.
      const m = mark(2 + brng.int(0, 1));
      this.add(new EquipmentBarrel(ctx, this._sited(m, (m?.r ?? 0) + 4, (m?.r ?? 0) + 16, spawn, brng)));
    }

    this.teleporter = new Teleporter(ctx, this._teleporterSite(marks, spawn));
    this.add(this.teleporter);
    return this.teleporter;
  }

  /**
   * Shrine placement.
   *
   * Shrines get the landmarks the chests do not lead with, and sit close in — a
   * shrine is a destination and reads best with mass directly behind it.
   *
   * ## Which shrines, and why the choice is off the shared stream
   *
   * **Never twice.** Six types drawn independently would routinely give a stage
   * two Cairns and nothing else, and a stage whose only shrine is the one you
   * have already decided about is a stage with no shrine on it. Drawn without
   * replacement instead. **Never more than three**, however deep the run goes:
   * a field of six altars is a menu, not a place.
   *
   * The *type* choice draws from `_shrineRng`, a private stream seeded from
   * `(ctx.seed, stageIndex)`, and not from `ctx.rng`. That is the load-bearing
   * decision in this method and it is not a stylistic one.
   *
   * `ctx.rng` is one shared sequence: every draw taken here displaces every
   * draw taken after it, on this stage and every later one. An earlier version
   * of this method took one draw per shrine off `ctx.rng`, and that alone moved
   * the director's spawn points far enough to break **three** harness shots
   * that had nothing to do with shrines (`05-boss`, `06-loaded-hud`,
   * `10-inventory`), measured against `iso-base/manifest.json`. Keeping the
   * *type* choice off the shared stream is what stops the shrine table from
   * being able to do that again.
   *
   * The gate draws below do still come off `ctx.rng`, and the interactable
   * density raise — more chests, more shops, more gates here — moved all of
   * them. Every harness reference capture therefore needs regenerating against
   * this revision; the old manifests describe a stage layout that no longer
   * exists. That is a one-time cost of the density change, not a regression,
   * and it is the reason the type stream stayed private: had it not been, this
   * change would have re-rolled which shrines appear as well as where.
   *
   * Nothing is lost by taking the type off a private stream: `populate` runs on
   * the host only (a client's props are replicated, never regenerated — see
   * `Progression`'s `stageStart` handler), so this sequence has never been part
   * of anything two peers had to agree on.
   *
   * ## The gates
   *
   * These are what make each draw honest rather than decorative. The Kiln has
   * nothing to burn on the opening stage and the Vault has nothing to hold, so
   * neither is in the bag until there is a run to spend. The Snare leaves an
   * elite alive behind you, which is a different proposition in the first
   * ninety seconds of a run than at minute twenty.
   */
  _populateShrines(stageIndex, scale, mark, spawn) {
    const ctx = this.ctx;
    const rng = new RNG(((ctx.seed >>> 0) ^ (0x9e3779b9 * (stageIndex + 1))) >>> 0 || 1);
    const bag = [
      { w: 30, build: (p) => new AuricCairn(ctx, p, Math.round(35 * scale)) },
      { w: 26, build: (p) => new IchorFont(ctx, p, stageIndex) },
      { w: 24, build: (p) => new HollowChime(ctx, p, stageIndex) },
      { w: stageIndex >= 1 ? 20 : 0, build: (p) => new GildedSnare(ctx, p, stageIndex) },
      { w: stageIndex >= 1 ? 18 : 0, build: (p) => new MarrowKiln(ctx, p, stageIndex) },
      { w: stageIndex >= 1 ? 16 : 0, build: (p) => new FallowVault(ctx, p, stageIndex) },
      // The Tempering Anvil (#208): same gate as the Kiln and the Vault — a
      // stage 0 pack has never had time to hold a named argent-and-blight
      // pair, so there is nothing this shrine could ever forge before there
      // is a run to have earned one.
      { w: stageIndex >= 1 ? 16 : 0, build: (p) => new TemperingAnvil(ctx, p) },
      // Counterplay joins the bag once there is a run to have regrets about,
      // and gets heavier as the debt does: the deeper the red, the likelier
      // the bag itself offers the way out. At band 0 the weight is the
      // original 14, so a pristine run's shrine table is untouched.
      { w: stageIndex >= 1 ? 14 + (ctx.corruption?.band ?? 0) * 8 : 0, build: (p) => new ArgentFont(ctx, p, stageIndex) },
      // The pact is a party mechanic: solo runs never see the stone (spec §2).
      { w: (ctx.roster?.count ?? 1) > 1 ? 16 : 0, build: (p) => new CovenantStone(ctx, p) },
    ].filter((e) => e.w > 0);

    // A stage now always carries at least one shrine, very likely a second, and
    // often a third and fourth; a fifth opens up once a run is deep enough that
    // four decisions have stopped being enough. The old [0.7, 0.5] pair left
    // nearly a third of stages with no shrine at all, which — at the density
    // the rest of `populate` now runs at — read as the shrines having been
    // forgotten rather than as a dry stage.
    //
    // The bag caps this regardless of how many gates pass: shrine types are
    // drawn without replacement, and stage 0 only has three types unlocked, so
    // the opening stage still tops out at three however the dice land.
    const gates = [1, 0.9, 0.7, 0.5];
    if (stageIndex >= 3) gates.push(0.5);

    for (let n = 0; n < gates.length; n++) {
      if (!bag.length) break;
      if (ctx.rng.next() >= gates[n]) continue;
      const picked = bag.splice(bag.indexOf(rng.weighted(bag, (e) => e.w)), 1)[0];
      // Landmark 1 upward: landmark 0 is the teleporter's backdrop, and a
      // shrine parked in front of the run's set piece competes with it.
      const m = mark(1 + n);
      this.add(picked.build(this._sited(m, (m?.r ?? 0) + 3.5, (m?.r ?? 0) + 11, spawn)));
    }

    // The Tempering guarantee (issue #222): once any pack could actually
    // forge, the stage that populates next must carry an anvil to spend that
    // eligibility at — the bag above still decides *where* the anvil lands
    // among the landmarks, but it may no longer decide *whether* one exists.
    // Eligibility gained mid-stage takes effect at the next populate, which
    // is the same "checked once, at populate time" contract every other
    // guarantee in this method keeps.
    //
    // The cost survives untouched: this only ever places the shrine, never
    // grants the card — `Items.temper()` still consumes both parents on
    // press (#179). Sited off the same private `rng` stream the bag draw
    // above uses, never `ctx.rng`, for the reason documented at the top of
    // this method: a shared-stream draw here would move every director spawn
    // after it.
    if (stageIndex >= 1 && !this.list.some((i) => i instanceof TemperingAnvil) && this._temperEligibleAnywhere()) {
      const m = mark(1 + rng.int(0, 2));
      this.add(new TemperingAnvil(ctx, this._sited(m, (m?.r ?? 0) + 3.5, (m?.r ?? 0) + 11, spawn, rng)));
    }

    // The clean path has to be walkable, not merely priced (2026-08-08
    // direction): from Blighted up, a stage always carries a font, however the
    // bag landed. Deliberately placed *after* every existing draw and sited off
    // a corruption-salted local stream — `ctx.rng` is never touched here — so
    // the layout of any stage is byte-identical to what it was before this
    // block existed, and a pristine run reaches this line and draws nothing.
    const band = ctx.corruption?.band ?? 0;
    if (band >= CLEANSE.guaranteeBand && stageIndex >= 1
        && !this.list.some((i) => i instanceof ArgentFont)) {
      const grng = new RNG(saltedSeed(ctx.seed, stageIndex, 0x51f0ab8d) || 1);
      const m = mark(1 + grng.int(0, 2));
      this.add(new ArgentFont(ctx, this._sited(m, (m?.r ?? 0) + 3.5, (m?.r ?? 0) + 11, spawn, grng), stageIndex));
    }

    // And the other exit from the same bargain: from Seeded up, every stage
    // carries the altar that sells the band's upside (issue #36). Guaranteed
    // rather than bagged for the reason the upsides exist at all — an upside
    // the layout can forget to place is one the player never learns about, and
    // the whole problem was that corruption only ever took. Same construction
    // as the font block above and for the same reasons: after every `ctx.rng`
    // draw, off a salted local stream, so a pristine run reaches this line and
    // draws nothing and `gate:sp` cannot move.
    //
    // Motes join the band as a reason to place it (issue #172). A run that
    // entered the stage Pristine with a purse of banked motes used to find no
    // altar at all, which made the purity currency unspendable exactly when the
    // player had played purely — the one failure mode the second pass of #36
    // was supposed to close.
    this._bargainSite = { stageIndex, mark, spawn };
    if (band >= BOON.reroll.band || (ctx.corruption?.motes ?? 0) >= MOTE.motes) this._placeBargain();
  }

  /**
   * Put the altar down, once, wherever the seed says it goes.
   *
   * Placement is a pure function of (run seed, stage index) off the same salted
   * stream the guaranteed block always used, so an altar placed at population
   * and an altar surfaced forty seconds later stand in the same spot, and
   * `ctx.rng` is untouched either way — a mid-stage spawn cannot move a single
   * later chest.
   *
   * The dedup is the guard rather than the caller's discretion: motes cross
   * `MOTE.motes` once but the band can cross afterwards, and each crossing asks
   * for an altar.
   */
  _placeBargain() {
    const site = this._bargainSite;
    if (!site) return null;
    // Cleared either way: the stage gets one altar, and after that this stops
    // costing a list walk on every frame that a band or a purse qualifies.
    this._bargainSite = null;
    if (this.list.some((i) => i instanceof VoidBargain)) return null;
    const ctx = this.ctx;
    const { stageIndex, mark, spawn } = site;
    const brng = new RNG(saltedSeed(ctx.seed, stageIndex, 0x2545f491) || 1);
    const m = mark(1 + brng.int(0, 2));
    return this.add(new VoidBargain(ctx, this._sited(m, (m?.r ?? 0) + 3.5, (m?.r ?? 0) + 11, spawn, brng), stageIndex));
  }

  /**
   * The other half of #172: a purse that becomes spendable *during* a stage.
   *
   * Warding mints motes mid-stage and a band can be crossed mid-stage, so the
   * altar's absence is not a fact settled at population time. Host-only — a
   * client's props all arrive by replication, and a guest conjuring its own
   * altar would be a prop the host has never heard of.
   */
  _surfaceBargain() {
    if (!this._bargainSite || !this.ctx.authority) return;
    const cor = this.ctx.corruption;
    if ((cor?.band ?? 0) < BOON.reroll.band && (cor?.motes ?? 0) < MOTE.motes) return;
    this._placeBargain();
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

  spawnOrb(position, itemId, arc = 1.5, ownerPawn = null) {
    // A dud orb is worse than no orb: it plays the whole pop-and-fly animation
    // and then gives nothing, which reads exactly like "the chest ate my gold".
    // The only way to get here with a bad id is a roll that had no pool, so
    // fail visibly at the source instead.
    if (!itemId || !ITEM_BY_ID.has(itemId)) return null;
    const orb = new ItemOrb(this.ctx, position, itemId, arc, ownerPawn);
    this.orbs.push(orb);
    this.root.add(orb.group);
    return orb;
  }

  fixedUpdate(ctx, h) {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      orb.fixedUpdate(h);
      if (!orb.claimed) continue;
      // `recipient()` is the exact same call the homing logic just used to
      // decide where this orb flew — the grant always lands on the pawn the
      // pickup animation says it did, never on an owner who stopped being a
      // legal target mid-flight.
      Items.of(ctx, orb.recipient())?.give(orb.itemId, 1);
      ctx.vfx?.burst?.(orb.position, TIERS[orb.def?.tier || 'common'].colour);
      this.root.remove(orb.group);
      orb.dispose();
      this.orbs[i] = this.orbs[this.orbs.length - 1];
      this.orbs.pop();
    }

    // The client's copy of the offer clock, and nothing else: it counts the
    // panel's number down and stops at zero. It never resolves anything - a
    // client that lapsed its own offer would be a second authority over one
    // transaction - so the window stands, showing 0s, until the host's close.
    if (this._remoteOffer && this._remoteOffer.remaining > 0) {
      this._remoteOffer.remaining = Math.max(0, this._remoteOffer.remaining - h);
    }

    this._updateFocus(ctx);
    // Pressing E is a *request*: it rides the command stream as BTN.INTERACT
    // and only the host turns it into an opened chest. The host answers the
    // whole roster — a remote pawn's bit arrives through `applyCommand` and
    // lands on its own `interactPressed` — while a client keeps asking only
    // for itself (and `requestInteract` refuses it anyway). A solo host has a
    // roster of one, so this is the same single call it always was.
    // `reviving` is `Revive`'s flag, written earlier this tick: that pawn's E is
    // already spent holding a teammate up, and must not also open the chest it
    // happens to be standing next to.
    if (ctx.authority && ctx.roster) {
      for (const p of ctx.roster.all) if (p?.interactPressed && p.reviving !== true) this.requestInteract(p);
    } else if (ctx.player?.interactPressed) this.requestInteract(ctx.player);
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
    // The pawn goes with the request: every cost, debt and payout inside
    // `interact` is charged to the survivor who pressed, not to the one this
    // machine is rendering.
    return !!target.interact(pawn);
  }

  /**
   * The open item offer belonging to `pawn`, wherever on the stage it was
   * opened (issue #175). At most one: a chest's lid is bought once and the
   * window is short, and two open at once would be two panels over one seat.
   * The first found wins, which is the older of the two by list order.
   */
  openOfferFor(pawn) {
    // Same two fields the panel reads (`remaining`, `offerId`) whichever side
    // answers, so the HUD counts down off one accessor on both and has never
    // been told which one it is looking at.
    return this._offerHolder(pawn)?.openOffer?.() ?? this._remoteOffer ?? null;
  }

  /**
   * The interactable holding `pawn`'s open offer — the NEWEST one, by offer id,
   * not the first in list order (integration review, Critical). List order is
   * siting order and has nothing to do with which offer the player is looking
   * at; the panel always paints the most recently opened, so that is the one a
   * press must land on. `settleOpenOffers` should mean there is never more than
   * one, and this is what makes the disagreement harmless if there ever is.
   */
  _offerHolder(pawn) {
    let best = null;
    let bestId = -1;
    for (let i = 0; i < this.list.length; i++) {
      const offer = this.list[i].openOffer?.();
      if (!offer || offer.owner !== pawn) continue;
      const id = offer.offerId ?? 0;
      if (id < bestId) continue;
      best = this.list[i];
      bestId = id;
    }
    return best;
  }

  /**
   * Settle every offer `pawn` has open, as the safe claim. Called before a new
   * one opens, so one seat is never asked two questions at once: the settled
   * offer's item lands exactly as its own lapse would have delivered it, unfed
   * and uncommitted, and the panel that repaints is describing the only live
   * transaction there is.
   */
  settleOpenOffers(pawn) {
    let settled = 0;
    for (let i = 0; i < this.list.length; i++) {
      const it = this.list[i];
      if (it.openOffer?.()?.owner === pawn && it.answer?.('safe')) settled++;
    }
    return settled;
  }

  /**
   * Queue `chest` to open for `pawn` once the live choice window clears
   * (issue #207) — `Chest.interact`'s deferral, whose reasoning lives there.
   * One entry per pawn; a later press simply overwrites the earlier one, the
   * same "the newest press wins" the panel itself follows.
   *
   * Two pawns can queue the *same* chest — it is still sitting there,
   * unopened, `available()` and all, for both of them to press. Nothing is
   * reserved here: the map holds one winning press per *pawn*, not per
   * chest, so both entries survive side by side. `_drainChestQueue` is what
   * makes only one of them real — first-drained-wins, iteration order over
   * the map, i.e. whichever pawn's entry was queued first — and the other
   * simply finds the lid already shut and drops out, exactly as if it had
   * pressed a used chest for real (integration review C1).
   */
  queueChestOpen(chest, pawn) {
    this._pendingChestOpen.set(pawn, chest);
  }

  /**
   * Open whatever chest a pawn's press left waiting, the moment nothing is
   * standing in the one shared choice slot any more.
   *
   * Polled here rather than off `mutationChoiceClosed` itself, and that is
   * not incidental: `Items.fixedUpdate` can close one band's toll and open
   * the next one's in the same tick (its queue drains synchronously), so a
   * chest that opened the instant the first toll's close event fired would
   * just get painted over by the second — the exact forfeit this exists to
   * end, aimed at the chest instead of the toll. Checking here, once a frame
   * and strictly after `fixedUpdate` has finished draining that queue for the
   * tick, means the drain always sees the *true* state: a fresh toll still
   * standing, and the chest waits its own turn again rather than stealing
   * the new one's.
   *
   * Every entry is dropped, never opened, once it can no longer be honoured
   * cleanly — and dropping is free because a queued press has charged
   * nothing yet:
   *
   *  · the pawn's pack is gone (disconnect) or the chest left with a stage
   *    transition mid-wait;
   *  · `!chest.available()` — the lid was already opened, by another queued
   *    pawn's press draining first this same pass, or used up any other way
   *    in the meantime (integration review C1). Checked *every* iteration,
   *    not only at queue time, which is what makes two pawns racing the same
   *    chest resolve to exactly one charge and one offer instead of both
   *    draining onto the same lid;
   *  · the pawn is dead (integration review M1) — the same reason
   *    `Items.refuseMutation('death')` exists: a window nobody can still
   *    answer must never be opened, not "opened and then somehow closed". A
   *    death arriving *after* a chest has already opened is the ordinary,
   *    pre-existing case an open offer has always faced with no special
   *    handling of its own — its clock still lapses it safe — and this drain
   *    does not add any, deliberately, so the two paths stay identical.
   *
   * Host-only, like the chest opens it is deferring: a client's press never
   * reaches `Chest.interact` at all (`requestInteract` refuses it upstream),
   * so no queue is ever built to drain on that machine.
   */
  _drainChestQueue() {
    if (!this.ctx.authority || !this._pendingChestOpen.size) return;
    for (const [pawn, chest] of this._pendingChestOpen) {
      const items = Items.of(this.ctx, pawn);
      if (!items || !this.list.includes(chest) || !chest.available() || pawn?.alive === false) {
        this._pendingChestOpen.delete(pawn);
        continue;
      }
      if (items.hasChoiceWindow()) continue; // still waiting its turn
      this._pendingChestOpen.delete(pawn);
      chest._openNow(pawn, items);
    }
  }

  /**
   * Answer `pawn`'s open offer. The panel's whole reach into the world — it is
   * handed an outcome name, never a live transaction, for the reason the
   * mutation window answers through `Items.chooseMutation` rather than through
   * a handle on the bus.
   */
  chooseOffer(outcome, pawn = this.ctx.player) {
    // On a client this decides nothing: it echoes the host's identifier back
    // and the host is what settles a transaction, exactly as
    // `Items.chooseMutation` defers to `answerMutation`.
    if (this._remoteOffer) return this._answerRemoteOffer(outcome);
    return this._offerHolder(pawn)?.answer(outcome) ?? null;
  }

  /**
   * The client half of an item offer (issue #205): send the offer's own id and
   * the outcome named, and let the host decide.
   *
   * The offer is cleared on send, so one window produces at most one reply from
   * a well-behaved client; the host ignores a second one regardless, because
   * the offer it names is resolved by then.
   */
  _answerRemoteOffer(outcome) {
    const o = this._remoteOffer;
    if (!o || !outcome) return null;
    this._remoteOffer = null;
    this.ctx.events.emit('itemOfferAnswer', { offerId: o.offerId, outcome: String(outcome) });
    return null;
  }

  /**
   * A remote player's answer to their own item offer, arriving as bytes
   * (issue #205). Host-side, called only by `NetHost._onMutate` with the pawn
   * belonging to the peer the message arrived on.
   *
   * `pawn` is not a field of the message and cannot be: it is re-derived from
   * the connection, so "answer somebody else's offer" is not a check that could
   * be forgotten - `_offerHolder` has no other pawn to return. What is left for
   * this method is the identifier, and it is checked strictly: an offer nobody
   * minted, a zero from a truncated message, another seat's identifier, and an
   * identifier for a window that has already lapsed or been superseded all fail
   * on the one comparison. Fail-closed and silent - a rejected reply leaves the
   * offer exactly as it was, so a peer sending nonsense cannot even cancel its
   * own window, and it still lapses into the safe claim on the host's clock.
   */
  answerOffer(pawn, offerId, outcome) {
    if (!pawn || !(offerId > 0) || !outcome) return null;
    const offer = this._offerHolder(pawn)?.openOffer?.();
    if (!offer || offer.offerId !== offerId) return null;
    return this.chooseOffer(outcome, pawn);
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
    this._surfaceBargain();
    for (let i = 0; i < this.list.length; i++) this.list[i].update(dt);
    for (let i = 0; i < this.orbs.length; i++) this.orbs[i].update(dt);
    // After the tick's own `Items.fixedUpdate` has already run, so a chest
    // waiting on a toll sees this frame's true close/reopen state rather than
    // a moment frozen mid-drain (`_drainChestQueue`'s own doc).
    this._drainChestQueue();
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
  [TYPE_ID.auricCairn]: (ctx, p) => new AuricCairn(ctx, p, 0),
  [TYPE_ID.ichorFont]: (ctx, p) => new IchorFont(ctx, p, 0),
  [TYPE_ID.hollowChime]: (ctx, p) => new HollowChime(ctx, p, 0),
  [TYPE_ID.gildedSnare]: (ctx, p) => new GildedSnare(ctx, p, 0),
  [TYPE_ID.fallowVault]: (ctx, p) => new FallowVault(ctx, p, 0),
  [TYPE_ID.marrowKiln]: (ctx, p) => new MarrowKiln(ctx, p, 0),
  [TYPE_ID.argentFont]: (ctx, p) => new ArgentFont(ctx, p, 0),
  // The stone only exists in co-op, so a client with no view for it would be
  // the one player guaranteed to be looking for it.
  [TYPE_ID.covenantStone]: (ctx, p) => new CovenantStone(ctx, p),
  [TYPE_ID.voidBargain]: (ctx, p) => new VoidBargain(ctx, p, 0),
  [TYPE_ID.equipmentBarrel]: (ctx, p) => new EquipmentBarrel(ctx, p),
  [TYPE_ID.wound]: (ctx, p) => new Wound(ctx, p),
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
