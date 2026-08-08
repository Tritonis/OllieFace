import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM_BY_ID, ITEMS_BY_TIER, TIERS } from '../../data/items.js';
import { getTextureSets, withRepeat, attachWorldSurface } from '../Materials.js';

/**
 * Everything in a realm the player can press E on, plus the three gateways that
 * stand in ordinary stages and lead to one.
 *
 * These are deliberately *not* subclasses of `world/Interactables.js`'s base —
 * that class is not exported and the file is not ours — so each one duck-types
 * the same shape instead. That shape is a contract in three places and all
 * three are satisfied here:
 *
 *  - `Interactables._nearest` needs `position`, `radius`, `available()`.
 *  - `Interactables._updateFocus` needs `prompt()`, and feeds it to the HUD's
 *    existing prompt line — this file builds no UI of its own.
 *  - `NetHost`'s snapshot needs `typeId`, `yaw`, `health`, `maxHealth`,
 *    `netState`. The ids below are the *existing* wire constants, so a client
 *    that has never heard of a realm still renders a portal where a gateway is
 *    and a chest where the vault's prize is, rather than nothing at all.
 */

// Wire constants from world/Interactables.js. Values are protocol, not choice.
const TYPE = {
  chest: 1, multishop: 2, shrineChance: 3, shrineBlood: 4, teleporter: 5, portal: 6,
  chestLarge: 7, chestLegendary: 8,
};

const _tex = (name, repeat) => withRepeat(getTextureSets()[name], repeat);

// The two textured rungs go through `attachWorldSurface`: a gateway or a vault
// standing inside a blight patch has to corrupt with the ground under it. The
// emissive rungs below deliberately do not — a rift's own light is its identity,
// and the mask would tint the one part of the prop that is not a surface.
const stoneMat = (color, opts = {}) => attachWorldSurface(new THREE.MeshStandardMaterial({
  ..._tex('stone', 2.4), color, roughness: 0.78, metalness: 0.04,
  envMapIntensity: 1.1, flatShading: true, ...opts,
}));
const metalMat = (color, opts = {}) => attachWorldSurface(new THREE.MeshStandardMaterial({
  ..._tex('metal', 2.6), color, roughness: 0.21, metalness: 0.7,
  envMapIntensity: 2.6, flatShading: true, ...opts,
}));
const glowMat = (hex, i = 2.2) => new THREE.MeshStandardMaterial({
  color: 0x05070a, emissive: hex, emissiveIntensity: i, roughness: 0.4,
});

function merge(parts) {
  const list = [];
  for (const p of parts) {
    // Non-indexed on the way in, always. `mergeGeometries` refuses a list that
    // mixes indexed and non-indexed buffers, and the primitives here do mix:
    // Icosahedron/Octahedron are non-indexed, Box/Cylinder/Cone/Torus are not.
    const g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
    if (p.ry) g.rotateY(p.ry);
    if (p.rx) g.rotateX(p.rx);
    g.translate(p.x || 0, p.y || 0, p.z || 0);
    list.push(g);
  }
  const out = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  for (const p of parts) p.g.dispose?.();
  return out;
}

let nextId = 100000;   // clear of Interactables' own counter

/** The shared half of the duck-type. */
class RealmProp {
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
    this.typeId = TYPE.portal;
    this.yaw = 0;
    this.maxHealth = 1;
    this.netState = 0;
    this.isRealmProp = true;
  }
  get health() { return this.available() ? 1 : 0; }
  available() { return this.enabled && !this.used; }
  prompt() { return 'Use'; }
  interact() { return false; }
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

// ---------------------------------------------------------------------- gates

/**
 * A gateway standing in an ordinary stage.
 *
 * All three realms share one class and differ by `look`, because they are the
 * same *kind* of object from the player's side: a thing you find while doing
 * something else, that offers to take you somewhere. What separates them is
 * what pressing E does — `arm` schedules a portal for the end of the stage,
 * `enter` goes now — and that comes from the gateway table in data/realms.js.
 */
export class RealmGateway extends RealmProp {
  constructor(ctx, position, gate, realm, cost) {
    super(ctx, position);
    this.kind = 'gateway';
    this.gate = gate;
    this.realm = realm;
    this.cost = cost;
    this.radius = 2.6;
    this.spin = 0;
    this.armed = false;

    const tint = realm.id === 'bazaar' ? 0x9b5cff : realm.id === 'crucible' ? 0xff5a18 : 0xffc850;
    const base = new THREE.Mesh(merge([
      { g: new THREE.CylinderGeometry(1.7, 2.1, 0.34, 10), y: 0.17 },
      { g: new THREE.CylinderGeometry(1.35, 1.6, 0.26, 10), y: 0.46 },
    ]), stoneMat(0x5c5766));
    base.castShadow = base.receiveShadow = true;

    // A leaning stele rather than a pillar: the silhouette has to be findable
    // in a field of boulders, and a tilted slab is the one shape the stage kit
    // does not already contain.
    const stele = new THREE.Mesh(merge([
      { g: new THREE.BoxGeometry(1.5, 4.2, 0.5), y: 2.4, rx: 0.09 },
      { g: new THREE.BoxGeometry(1.9, 0.4, 0.7), y: 4.4 },
      { g: new THREE.BoxGeometry(0.45, 1.5, 0.6), x: 1.0, y: 1.4, rx: 0.09 },
      { g: new THREE.BoxGeometry(0.45, 1.1, 0.6), x: -1.0, y: 1.2, rx: 0.09 },
    ]), stoneMat(0x4a4552, { roughness: 0.62 }));
    stele.castShadow = true;

    // The glyph is the only emissive on the prop and it is small on purpose:
    // the gateway has to read as *found*, not as a HUD marker planted in a field.
    this.glyph = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.11, 6, 24), glowMat(tint, 2.4));
    this.glyph.position.set(0, 2.6, 0.34);
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), glowMat(tint, 3.0));
    this.core.position.set(0, 2.6, 0.34);

    this.group.add(base, stele, this.glyph, this.core);
  }

  prompt() {
    if (this.armed) return `${this.gate.name} — portal opens when the stage is cleared`;
    const price = this.cost > 0 ? ` ($${this.cost})` : '';
    return this.gate.mode === 'arm'
      ? `${this.gate.name} — open a way to ${this.realm.name}${price}`
      : `${this.gate.name} — enter ${this.realm.name}${price}`;
  }

  available() { return this.enabled && !this.used; }

  interact() {
    if (this.cost > 0 && !this.ctx.items?.spendGold(this.cost)) return false;
    this.used = true;
    this.ctx.audio?.play?.('shrineWin', this.position);
    this.ctx.vfx?.burst?.(this.position, 0x9b5cff);
    if (this.gate.mode === 'arm') {
      this.armed = true;
      this.used = false;          // stays lit; it just cannot be paid for twice
      this.enabled = false;
      this.ctx.realms?.armRealm?.(this.realm.id);
    } else {
      this.ctx.realms?.requestEnter?.(this.realm.id);
    }
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.glyph.rotation.z = this.spin * 0.7;
    this.core.rotation.y = this.spin * 1.6;
    this.core.rotation.x = this.spin * 1.1;
    const k = this.armed ? 3.4 : this.available() ? 2.2 + Math.sin(this.spin * 2.2) * 0.7 : 0.2;
    this.glyph.material.emissiveIntensity = k;
    this.core.material.emissiveIntensity = k * 1.2;
  }
}

/** The way out of a realm (and, in a normal stage, the way into one). */
export class RealmPortal extends RealmProp {
  constructor(ctx, position, { label, tint = 0x9b5cff, onEnter }) {
    super(ctx, position);
    this.kind = 'portal';
    this.label = label;
    this.onEnter = onEnter;
    this.radius = 2.6;
    this.spin = 0;
    this.typeId = TYPE.portal;

    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 28),
      new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.55,
                                    side: THREE.DoubleSide, depthWrite: false }));
    this.disc.position.y = 2.1;
    this.frame = new THREE.Mesh(
      new THREE.TorusGeometry(1.96, 0.13, 8, 32),
      new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.7, roughness: 0.2 }));
    this.frame.position.y = 2.1;
    this.light = new THREE.PointLight(tint, 4, 18);
    this.light.position.y = 2.1;
    this.group.add(this.disc, this.frame, this.light);
  }

  prompt() { return this.label; }

  interact() {
    this.used = true;
    // A door may refuse. The finale portals are the only ones that do: the band
    // that opened one can move on before the party walks over to it, and a door
    // the band no longer allows must not be enterable. Refusal is *reversible*
    // — the portal stays standing and goes back to available — because a party
    // that bleeds back down should find it working again, and because removing
    // a replicated interactable does not reach clients while spawning one does.
    if (this.onEnter?.() === false) {
      this.used = false;
      this.ctx.audio?.play?.('deny');
      return false;
    }
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.frame.rotation.z = this.spin * 0.8;
    this.disc.quaternion.copy(this.ctx.camera.quaternion);
    this.light.intensity = 4 + Math.sin(this.spin * 3) * 1.5;
  }
}

// -------------------------------------------------------------- market stalls

/**
 * A market stall.
 *
 * The deliberate difference from the stage's multishop is that *nothing here is
 * a gamble*. The item is named in the prompt before you pay, buying one does not
 * close the others, and the stock does not change while you stand there. The
 * market's whole job is to be the one place in the run where you convert gold
 * into a decision instead of into a roll.
 */
export class MarketStall extends RealmProp {
  constructor(ctx, position, itemId, cost, index) {
    super(ctx, position);
    this.kind = 'stall';
    this.itemId = itemId;
    this.cost = cost;
    this.radius = 2.0;
    this.typeId = TYPE.multishop;

    const def = ITEM_BY_ID.get(itemId);
    const tint = TIERS[def?.tier || 'common'].colour;

    const frame = new THREE.Mesh(merge([
      { g: new THREE.CylinderGeometry(0.5, 0.66, 0.16, 8), y: 0.08 },
      { g: new THREE.CylinderGeometry(0.18, 0.24, 1.5, 8), y: 0.9 },
      { g: new THREE.BoxGeometry(1.3, 0.16, 0.36), y: 1.4, z: 0.02 },
      { g: new THREE.BoxGeometry(0.16, 1.2, 0.3), x: -0.58, y: 2.0 },
      { g: new THREE.BoxGeometry(0.16, 1.2, 0.3), x: 0.58, y: 2.0 },
      { g: new THREE.BoxGeometry(1.32, 0.18, 0.5), y: 2.55, z: 0.11 },
      { g: new THREE.BoxGeometry(1.18, 1.05, 0.09), y: 2.0, z: -0.11 },
      { g: new THREE.BoxGeometry(1.4, 0.06, 0.08), y: 2.44, z: 0.35 },
    ]), metalMat(0x6a6152));
    frame.castShadow = frame.receiveShadow = true;

    this.screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, 0.98, 0.10),
      new THREE.MeshStandardMaterial({ color: 0x0d1118, emissive: tint,
                                       emissiveIntensity: 1.0, roughness: 0.16 }));
    this.screen.position.set(0, 2.0, 0.02);
    // The goods, floating over the counter: a tier-coloured solid the player
    // can read across the room, so the room has a shape before the prompt does.
    this.token = new THREE.Mesh(new THREE.IcosahedronGeometry(0.30, 0),
      new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.5, roughness: 0.25 }));
    this.token.position.set(0, 1.72, 0.42);
    this.group.add(frame, this.screen, this.token);
    this.group.rotation.y = (index / 3) * Math.PI * 2 + Math.PI;
    this.spin = 0;
  }

  prompt() {
    const def = ITEM_BY_ID.get(this.itemId);
    return `${def?.name || 'Item'} — ${def?.tier || 'common'} ($${this.cost})`;
  }

  interact() {
    if (!this.ctx.items?.spendGold(this.cost)) return false;
    this.used = true;
    this.ctx.interactables.spawnOrb(this.position, this.itemId, 1.6);
    this.screen.material.emissiveIntensity = 0.05;
    this.token.visible = false;
    this.ctx.audio?.play?.('purchase', this.position);
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.token.rotation.y = this.spin * 1.4;
    this.token.position.y = 1.72 + Math.sin(this.spin * 2) * 0.06;
  }
}

/**
 * The refinery: gold for a guaranteed tier step.
 *
 * The market's second deterministic transaction, and the answer to a purse full
 * of money and an inventory full of commons. Three uses, price climbing each
 * time, so it converts a surplus rather than replacing the loot game.
 */
export class Refinery extends RealmProp {
  constructor(ctx, position, cost) {
    super(ctx, position);
    this.kind = 'refinery';
    this.cost = cost;
    this.uses = 0;
    this.maxUses = 3;
    this.radius = 2.4;
    this.typeId = TYPE.shrineChance;
    this.spin = 0;

    const base = new THREE.Mesh(merge([
      { g: new THREE.CylinderGeometry(1.5, 1.8, 0.3, 12), y: 0.15 },
      { g: new THREE.CylinderGeometry(1.1, 1.35, 0.9, 12), y: 0.75 },
      { g: new THREE.CylinderGeometry(1.25, 1.1, 0.2, 12), y: 1.3 },
    ]), stoneMat(0x4e4a56));
    base.castShadow = base.receiveShadow = true;
    const bowl = new THREE.Mesh(
      new THREE.TorusGeometry(1.0, 0.13, 10, 28), metalMat(0xb8863c));
    bowl.rotation.x = Math.PI / 2;
    bowl.position.y = 1.42;
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.3, 7), glowMat(0x74d0ff, 2.6));
    this.flame.position.y = 2.05;
    this.group.add(base, bowl, this.flame);
  }

  available() { return this.enabled && this.uses < this.maxUses; }
  prompt() { return `Refinery — upgrade one item a tier ($${this.cost})`; }

  interact() {
    const inv = this.ctx.items?.inventory?.() || [];
    // Only ever consumes something it can actually improve, and says so by
    // simply refusing rather than by taking the gold and doing nothing.
    const pool = inv.filter((e) => {
      const d = ITEM_BY_ID.get(e.id);
      return d && (d.tier === 'common' || d.tier === 'uncommon');
    });
    if (!pool.length) return false;
    if (!this.ctx.items.spendGold(this.cost)) return false;
    this.uses++;
    const from = this.ctx.rng.pick(pool);
    const fromDef = ITEM_BY_ID.get(from.id);
    const toTier = fromDef.tier === 'common' ? 'uncommon' : 'legendary';
    const id = this.ctx.items.rollItem(toTier);
    this.ctx.items.take?.(from.id, 1);
    this.ctx.interactables.spawnOrb(this.position, id, 1.8);
    this.ctx.vfx?.burst?.(this.position, 0x74d0ff);
    this.ctx.audio?.play?.('shrineWin', this.position);
    this.cost = Math.round(this.cost * 1.5);
    if (this.uses >= this.maxUses) this.flame.material.emissiveIntensity = 0.1;
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.flame.rotation.y = this.spin * 2.2;
    this.flame.scale.setScalar(this.available() ? 1 + Math.sin(this.spin * 5) * 0.08 : 0.4);
  }
}

/**
 * The Obelisk of Departure — the run's other ending.
 *
 * Two presses, on purpose. The first one is the warning and the second is the
 * decision; an irreversible run-ender behind a single E press next to three
 * shops is a way to lose a two-hour run to a mis-click.
 */
export class Obelisk extends RealmProp {
  constructor(ctx, position) {
    super(ctx, position);
    this.kind = 'obelisk';
    this.radius = 3.0;
    this.armed = false;
    this.spin = 0;
    this.typeId = TYPE.shrineBlood;

    const base = new THREE.Mesh(merge([
      { g: new THREE.CylinderGeometry(2.3, 2.8, 0.4, 8), y: 0.2 },
      { g: new THREE.CylinderGeometry(1.8, 2.1, 0.35, 8), y: 0.55 },
    ]), stoneMat(0x39343f));
    base.receiveShadow = true;

    // A single tall shard leaning nowhere: it is the only vertical in the room
    // that is not a column, and it stands in the middle of the dais, so the
    // composition of the whole market points at it.
    this.shard = new THREE.Mesh(merge([
      { g: new THREE.ConeGeometry(0.9, 6.4, 6), y: 3.9 },
      { g: new THREE.ConeGeometry(1.05, 1.6, 6), y: 1.3, rx: Math.PI },
    ]), new THREE.MeshStandardMaterial({
      color: 0x241a3a, emissive: 0x6a30c0, emissiveIntensity: 0.35,
      roughness: 0.22, metalness: 0.1, envMapIntensity: 2.6, flatShading: true,
    }));
    this.shard.castShadow = true;

    this.halo = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.08, 6, 40), glowMat(0xb060ff, 2.0));
    this.halo.rotation.x = Math.PI / 2;
    this.halo.position.y = 4.6;
    this.group.add(base, this.shard, this.halo);
  }

  prompt() {
    return this.armed
      ? 'Obelisk of Departure — PRESS AGAIN TO END THE RUN'
      : 'Obelisk of Departure — end the run here';
  }

  interact() {
    if (!this.armed) {
      this.armed = true;
      this.ctx.audio?.play?.('shrineBlood', this.position);
      this.ctx.vfx?.burst?.(this.position, 0xb060ff);
      // Force the prompt to re-read: Interactables only pushes to the HUD when
      // the *text* changes, and it changed.
      this.ctx.hud?.setPrompt?.(this.prompt());
      return true;
    }
    this.used = true;
    this.ctx.realms?.obliterate?.();
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.halo.rotation.z = this.spin * 0.5;
    this.halo.position.y = 4.6 + Math.sin(this.spin) * 0.2;
    const k = this.armed ? 2.4 + Math.sin(this.spin * 9) * 1.6 : 1.6;
    this.halo.material.emissiveIntensity = k;
    this.shard.material.emissiveIntensity = this.armed ? 0.9 : 0.35;
  }
}

// ------------------------------------------------------------ trial and vault

/** The plinth that starts the Crucible's waves. Nothing happens until you do. */
export class TrialPlinth extends RealmProp {
  constructor(ctx, position) {
    super(ctx, position);
    this.kind = 'plinth';
    this.radius = 2.6;
    this.typeId = TYPE.shrineChance;
    this.spin = 0;

    const base = new THREE.Mesh(merge([
      { g: new THREE.CylinderGeometry(1.9, 2.3, 0.4, 8), y: 0.2 },
      { g: new THREE.BoxGeometry(1.5, 2.4, 1.5), y: 1.6 },
      { g: new THREE.BoxGeometry(2.0, 0.3, 2.0), y: 2.95 },
    ]), metalMat(0x565b66, { roughness: 0.36, metalness: 0.5 }));
    base.castShadow = base.receiveShadow = true;
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 0), glowMat(0xff5a18, 2.8));
    this.core.position.y = 3.7;
    this.group.add(base, this.core);
  }

  prompt() { return 'Begin the trial'; }

  interact() {
    this.used = true;
    this.core.material.emissiveIntensity = 1.0;
    this.ctx.realms?.beginTrial?.();
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.core.rotation.y = this.spin * 1.2;
    this.core.position.y = 3.7 + Math.sin(this.spin * 1.8) * 0.12;
  }
}

/**
 * The vault's prize. Sealed until its warden is dead, which is the only reason
 * the warden is a fight rather than an obstacle you can run past.
 */
export class VaultChest extends RealmProp {
  constructor(ctx, position, drops) {
    super(ctx, position);
    this.kind = 'vaultChest';
    this.radius = 3.2;
    this.sealed = true;
    this.drops = drops;
    this.openT = -1;
    this.typeId = TYPE.chestLegendary;

    const body = new THREE.Mesh(merge([
      { g: new THREE.BoxGeometry(4.2, 0.4, 3.0), y: 0.2 },
      { g: new THREE.BoxGeometry(3.8, 2.0, 2.7), y: 1.4 },
      { g: new THREE.BoxGeometry(0.34, 2.3, 0.34), x: 1.8, y: 1.4, z: 1.28 },
      { g: new THREE.BoxGeometry(0.34, 2.3, 0.34), x: -1.8, y: 1.4, z: 1.28 },
      { g: new THREE.BoxGeometry(0.34, 2.3, 0.34), x: 1.8, y: 1.4, z: -1.28 },
      { g: new THREE.BoxGeometry(0.34, 2.3, 0.34), x: -1.8, y: 1.4, z: -1.28 },
    ]), stoneMat(0x3a3128, { roughness: 0.55 }));
    body.castShadow = body.receiveShadow = true;

    const bands = new THREE.Mesh(merge([
      { g: new THREE.BoxGeometry(4.0, 0.22, 2.9), y: 0.9 },
      { g: new THREE.BoxGeometry(4.0, 0.22, 2.9), y: 1.95 },
      { g: new THREE.BoxGeometry(0.8, 0.9, 0.24), y: 1.5, z: 1.42 },
    ]), metalMat(0xd0a03c, { roughness: 0.15, metalness: 0.88 }));

    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(0, 2.4, -1.35);
    const lid = new THREE.Mesh((() => {
      const g = new THREE.CylinderGeometry(1.4, 1.4, 3.9, 18, 1, false, 0, Math.PI);
      g.rotateZ(Math.PI / 2);
      return g;
    })(), metalMat(0xb8903c, { roughness: 0.18, metalness: 0.8 }));
    lid.position.set(0, 0.05, 1.35);
    lid.castShadow = true;
    this.lidPivot.add(lid);

    this.seal = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.14, 6, 30), glowMat(0xffc850, 2.4));
    this.seal.rotation.x = Math.PI / 2;
    this.seal.position.y = 3.4;

    this.group.add(body, bands, this.lidPivot, this.seal);
    this.spin = 0;
  }

  available() { return this.enabled && !this.used; }
  prompt() { return this.sealed ? 'Sealed — the warden holds the key' : 'Open the vault'; }

  unseal() {
    this.sealed = false;
    this.seal.material.emissiveIntensity = 4.0;
  }

  interact() {
    if (this.sealed) return false;
    this.used = true;
    this.openT = 0;
    for (const id of this.drops) this.ctx.interactables.spawnOrb(this.position, id, 2.6);
    this.ctx.vfx?.burst?.(this.position, 0xffc850);
    this.ctx.audio?.play?.('chest', this.position);
    return true;
  }

  update(dt) {
    this.spin += dt;
    this.seal.rotation.z = this.spin * (this.sealed ? 0.4 : 2.0);
    this.seal.position.y = 3.4 + Math.sin(this.spin * 1.4) * 0.1;
    if (this.openT < 0) return;
    this.openT = Math.min(1, this.openT + dt * 1.6);
    const e = 1 - Math.pow(1 - this.openT, 3);
    this.lidPivot.rotation.x = -e * 2.0 + Math.sin(this.openT * Math.PI) * 0.3;
    this.seal.material.emissiveIntensity = 4.0 * (1 - e);
  }
}

/** Deterministic market stock: one item per tier band, rolled once on entry. */
export function rollMarketStock(ctx, stageIndex) {
  const pick = (tier) => {
    const pool = ITEMS_BY_TIER[tier];
    return pool && pool.length ? ctx.rng.pick(pool).id : null;
  };
  const scale = Math.pow(1.28, stageIndex);
  return [
    { id: pick('common'), cost: Math.round(40 * scale) },
    { id: pick('uncommon'), cost: Math.round(110 * scale) },
    { id: pick('legendary'), cost: Math.round(320 * scale) },
  ].filter((s) => s.id);
}
