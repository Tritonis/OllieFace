import * as THREE from 'three';
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
const TYPE_ID = {
  chest: 1, multishop: 2, shrineChance: 3, shrineBlood: 4, teleporter: 5, portal: 6,
};

const TIER_BIAS = {
  small: { common: 80, uncommon: 20, legendary: 1 },
  large: { common: 0, uncommon: 80, legendary: 8 },
  legendary: { common: 0, uncommon: 0, legendary: 1 },
};

let nextId = 1;

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
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    });
  }
}

// -------------------------------------------------------------------- chests

class Chest extends Interactable {
  constructor(ctx, position, size, cost) {
    super(ctx, position);
    this.size = size;
    this.cost = cost;
    this.openT = -1;
    this.typeId = TYPE_ID.chest;

    const tint = size === 'legendary' ? 0xf0453f : size === 'large' ? 0x49d67a : 0xc0c8d4;
    const scale = size === 'small' ? 1 : size === 'large' ? 1.35 : 1.5;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4 * scale, 0.9 * scale, 1.0 * scale),
      new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.7, metalness: 0.3 })
    );
    body.position.y = 0.45 * scale;
    body.castShadow = true;

    this.lid = new THREE.Mesh(
      new THREE.BoxGeometry(1.45 * scale, 0.35 * scale, 1.05 * scale),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.4, metalness: 0.5, emissive: tint, emissiveIntensity: 0.25 })
    );
    // Pivot at the back edge so the lid hinges instead of floating.
    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(0, 0.9 * scale, -0.5 * scale);
    this.lid.position.set(0, 0.17 * scale, 0.5 * scale);
    this.lidPivot.add(this.lid);

    this.group.add(body, this.lidPivot);
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
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.24, 1.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x2b313b, roughness: 0.6 })
    );
    post.position.y = 0.7;
    this.screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x11151c, emissive: tint, emissiveIntensity: 0.7, roughness: 0.3 })
    );
    this.screen.position.y = 1.7;
    this.group.add(post, this.screen);
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

class ShrineOfChance extends Interactable {
  constructor(ctx, position, cost) {
    super(ctx, position);
    this.cost = cost;
    this.uses = 0;
    this.maxUses = 3;
    this.spin = 0;
    this.typeId = TYPE_ID.shrineChance;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.3, 0.4, 10),
      new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.8 })
    );
    base.position.y = 0.2;
    this.crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffa000, emissiveIntensity: 0.8, roughness: 0.2 })
    );
    this.crystal.position.y = 1.5;
    this.group.add(base, this.crystal);
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

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.0, 1.25, 0.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a2a2e, roughness: 0.85 })
    );
    base.position.y = 0.2;
    this.spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.4, 1.6, 6),
      new THREE.MeshStandardMaterial({ color: 0x8a1f2c, emissive: 0xd0203a, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    this.spike.position.y = 1.2;
    this.group.add(base, this.spike);
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
    if (this.uses >= this.maxUses) this.spike.material.emissiveIntensity = 0.05;
    return true;
  }

  update(dt) { this.spike.rotation.y += dt * 0.6; }
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
   * Fills a freshly built stage. Count and price both scale with stage index:
   * later stages have more to buy and charge more for it, which is what keeps
   * gold pressure constant while the player's income explodes.
   */
  populate(stageIndex) {
    this.clear();
    const ctx = this.ctx;
    const scale = Math.pow(1.25, stageIndex);
    const spawn = ctx.player?.position || new THREE.Vector3();

    const chestCount = 6 + stageIndex * 2;
    for (let i = 0; i < chestCount; i++) {
      const roll = ctx.rng.next();
      const size = roll > 0.94 ? 'legendary' : roll > 0.75 ? 'large' : 'small';
      const base = size === 'legendary' ? 400 : size === 'large' ? 125 : 25;
      this.add(new Chest(ctx, this._point(spawn), size, Math.round(base * scale)));
    }

    const shopCount = 1 + Math.floor(stageIndex / 2);
    for (let s = 0; s < shopCount; s++) {
      const centre = this._point(spawn);
      const group = [];
      for (let i = 0; i < 3; i++) {
        const offset = new THREE.Vector3(Math.cos((i / 3) * Math.PI * 2) * 2.4, 0, Math.sin((i / 3) * Math.PI * 2) * 2.4);
        const t = new MultishopTerminal(ctx, centre.clone().add(offset), Math.round(50 * scale), group, i);
        group.push(t);
        this.add(t);
      }
    }

    if (ctx.rng.next() < 0.7) this.add(new ShrineOfChance(ctx, this._point(spawn), Math.round(35 * scale)));
    if (ctx.rng.next() < 0.5) this.add(new ShrineOfBlood(ctx, this._point(spawn), stageIndex));

    this.teleporter = new Teleporter(ctx, this._point(spawn));
    this.add(this.teleporter);
    return this.teleporter;
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
