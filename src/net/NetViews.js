/**
 * Client-side views for replicated entities.
 *
 * A view is the *rendered* half of something the host simulates. It owns no
 * gameplay state and never decides anything: it takes an interpolated snapshot
 * record (position, yaw, health fraction, lifecycle state) and drives a mesh
 * with it.
 *
 * Views deliberately reuse the same pooled rigs the host's own entities use, so
 * a client pays exactly the same mesh and shadow budget as a host with the same
 * number of units on screen — including the distance LOD that skips the IK work
 * once a unit is only a silhouette.
 *
 * They also expose enough of the entity contract (`position`, `group`,
 * `radius`, `height`, `maxHealth`, `alive`) for the cosmetic systems to treat
 * them like any other entity: `VFX` resolves a `damage` event's target straight
 * to one of these and flashes it.
 */

import * as THREE from 'three';
import { EKIND, ESTATE } from './Protocol.js';
import { ENEMY_BY_TYPE, AFFIX_IDS } from '../data/enemies.js';
import { acquireRig, releaseRig, configureShadows, makeAnim } from '../entities/EnemyMeshes.js';
import { CharacterMesh } from '../entities/CharacterMesh.js';
import { survivorByIndex } from '../data/survivors.js';
import { createInteractableView } from '../world/Interactables.js';

// Matches Enemy's own LOD cut (57m²·, i.e. ~56 units out).
const LOD_DIST2 = 3200;
// Death animations are driven by the host's clock on the host; a view only
// learns "this is dead" and plays it out locally over the same window.
const DEATH_TIME = 1.1;

// The downed pose (mp-p3). A teammate on the floor has to read as down from
// across the arena, and this build has no player death animation to hold at
// its first frames — `dead` is documented on CharacterMesh's state block
// (CharacterMesh.js:1942) and read nowhere in it, so `PlayerView.onDeath` is
// already only a flag. Rather than build animation machinery for a state
// Task 5 is about to dress properly, the pose *is* the transform: pitch the
// whole rig forward onto its face and sink it toward the ground. Two writes a
// frame, no new rig state, and `CharacterMesh.update` owns only `rotation.y`
// on this group so nothing fights over the axis.
// Exported so the host's own remote-pawn presentation (`Player.update`) can
// reuse the exact same pose rather than forking a second copy of these two
// numbers — a downed body must read identically whether it is being watched
// through a client's `PlayerView` or through the host's own `CharacterMesh`.
export const DOWNED_PITCH = 1.25;
export const DOWNED_SINK = 0.55;

/** Shared: estimate planar speed from successive interpolated positions. */
function trackVelocity(view, x, y, z, dt) {
  const v = view.velocity;
  if (dt > 0) {
    v.set((x - view.position.x) / dt, (y - view.position.y) / dt, (z - view.position.z) / dt);
  }
  view.position.set(x, y, z);
}

// ------------------------------------------------------------------- enemies

class EnemyView {
  constructor(rec, ctx) {
    this._ctx = ctx;
    this.def = ENEMY_BY_TYPE.get(rec.typeId);
    this.rig = acquireRig(this.def.meshFactory);
    configureShadows(this.rig);
    // Affix presentation replicates from the host (issue #228): a guest never
    // derives it locally, only reads the wire's affixId/corrupted, the same
    // way `Enemy.js` decides them once at spawn on the host. `_affixKey` is
    // reset so the first `_syncAffix` call below always applies, even for
    // "no affix".
    this._affixKey = null;
    this.anim = makeAnim();

    this.position = new THREE.Vector3(rec.x, rec.y, rec.z);
    this.velocity = new THREE.Vector3();
    this.yaw = rec.yaw;
    this.group = this.rig.root;       // what VFX flashes and dissolves

    // Entity-contract fields the cosmetic systems read. `maxHealth` is the base
    // value, not the host's level-scaled one — a client is never told the
    // scaling, and this only affects how big a damage number looks.
    this.isPlayer = false;
    this.team = 'monster';
    this.alive = true;
    this.maxHealth = this.def.baseHealth;
    this.health = this.def.baseHealth;
    this.radius = this.def.radius;
    this.height = this.def.height;
    this.isBoss = !!this.def.isBoss;
    // Mirrors Enemy.js — without it a client's boss bar falls back to the
    // literal placeholder "BOSS" while the host's reads the real card name.
    this.name = this.def.name;

    this.dying = false;
    this.deathT = 0;
    this.spawnT = 0;

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    ctx.scene.add(this.rig.root);
    this._syncAffix(rec.affixId, rec.corrupted);
  }

  /**
   * Applies the host's affix/corrupted state to the rig, but only on an
   * actual change — `setAffix` rebuilds materials and aura geometry, and this
   * runs once per entity per snapshot otherwise. Covers removal (a wire
   * transition back to `affixId: 0`) the same way it covers a new affix:
   * both are just a different key than last time.
   */
  _syncAffix(affixId, corrupted) {
    const key = `${affixId || 0}:${corrupted ? 1 : 0}`;
    if (key === this._affixKey) return;
    this._affixKey = key;
    const affix = affixId ? (AFFIX_IDS[affixId - 1] || null) : null;
    this.rig.setAffix(affix, !!corrupted);
  }

  applyNetState(s, dt) {
    trackVelocity(this, s.x, s.y, s.z, dt);
    this.yaw = s.yaw;
    this.health = this.maxHealth * s.healthFrac;
    this.alive = s.state !== ESTATE.DEAD;
    this._syncAffix(s.affixId, s.corrupted);

    const rig = this.rig;
    const a = this.anim;
    const ctx = this._ctx;
    a.t += dt;

    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    a.speed += (Math.min(planar / Math.max(0.5, this.def.moveSpeed), 1.4) - a.speed) * Math.min(1, dt * 10);
    a.stride += dt * (1.6 + a.speed * (9 / Math.max(1, this.def.height)));
    a.lean = 0;

    if (this.dying) {
      this.deathT += dt;
      a.death = Math.min(this.deathT / DEATH_TIME, 1);
    }

    // Same LOD rule the host applies, so a client's frame cost tracks it.
    const cam = ctx?.camera;
    const d2 = cam ? cam.position.distanceToSquared(this.position) : 0;
    a.lod = d2 > LOD_DIST2 ? 1 : 0;

    rig.root.position.copy(this.position);
    rig.root.rotation.y = this.yaw;

    // Spawn pop, mirroring Enemy's — units grow in rather than blink in.
    if (s.state === ESTATE.SPAWNING) {
      this.spawnT += dt;
      const k = Math.min(this.spawnT / 0.45, 1);
      rig.root.scale.setScalar(0.2 + 0.8 * (k * k * (3 - 2 * k)));
    } else if (a.death > 0.75) {
      rig.root.scale.setScalar(Math.max(0, 1 - (a.death - 0.75) / 0.25));
    } else {
      rig.root.scale.setScalar(1);
    }

    rig.animate(rig, a, dt);
  }

  onDeath(ctx) {
    this._ctx = ctx;
    this.dying = true;
    this.alive = false;
    this.anim.fallX = 1;
    this.anim.fallZ = 0;
  }

  dispose() {
    releaseRig(this.rig);
    this.rig = null;
  }
}

// ------------------------------------------------------------------- players

class PlayerView {
  constructor(rec, ctx) {
    // The peer's own card, off the wire (protocol 8). `typeId` is a survivor's
    // index in `SURVIVORS` for a PLAYER record exactly as it is an enemy's
    // index in `ENEMIES` for an ENEMY one, and `survivorByIndex` falls back to
    // the default for an index this build has no card for, so a newer host's
    // sixth survivor draws as a Ranger instead of throwing every snapshot.
    this.card = survivorByIndex(rec.typeId);
    this.survivorId = this.card.id;
    // What the class is *for*, here: colour alone cannot separate two amber
    // players, so a teammate's effects carry their class's shape signature
    // (EFFECT-LANGUAGE.md §3.1). Held on the view so anything reading a party
    // member — the HUD strip, a future effect replayed client-side — asks the
    // same question of a remote player as of a local one.
    this.shapeSignature = this.card.shapeSignature;
    this.accentColor = this.card.accentColor;

    this.mesh = new CharacterMesh(this.card.meshKey);
    this.group = this.mesh.group;

    this.position = new THREE.Vector3(rec.x, rec.y, rec.z);
    this.velocity = new THREE.Vector3();
    this.yaw = rec.yaw;

    this.isPlayer = true;
    this.team = 'player';
    this.alive = true;
    // Downed & revive (mp-p3). `downed` is the same flag the host's pawns
    // carry, so anything reading a party member's state off a view — the HUD's
    // teammate strip, the revive prompt — asks the same question of a remote
    // player as of a local one. `bleedoutFrac` is the clock the wire carries in
    // `healthFrac` while downed (see NetHost._downedRecord); it is 0..1 and
    // not seconds, because the fraction is all that crossed.
    this.downed = false;
    this.bleedoutFrac = 0;
    this.maxHealth = 100;
    this.health = 100;
    this.radius = 0.45;
    // Matched to the rig this view actually draws, not to the old shared 1.8
    // (#70) and no longer to the default survivor's: it is the same card the
    // mesh key came from, so "what you see is what is hittable" holds for a
    // teammate whichever class they picked. Anvil and Kestrel differ by 0.7 m
    // here, which is the whole of the gap this used to carry.
    this.height = this.card.hurtHeight;

    // The state block CharacterMesh animates from. Reused — a remote player
    // must not allocate one of these every frame.
    this._s = {
      velocity: this.velocity, grounded: true, aimYaw: rec.yaw, aimPitch: 0,
      dashT: 0, sprint: false, moveSpeed: 7, dead: false,
    };

    this.group.position.copy(this.position);
    ctx.scene.add(this.group);
  }

  applyNetState(s, dt) {
    trackVelocity(this, s.x, s.y, s.z, dt);
    this.yaw = s.yaw;
    this.alive = s.state !== ESTATE.DEAD;

    // While downed the wire's `healthFrac` is the bleed-out clock, not health
    // — the host writes it that way (`NetHost._downedRecord`) because a downed
    // pawn's health is 0 for the whole state. Reading it as health would draw
    // a teammate's bar refilling while they bleed out.
    this.downed = s.state === ESTATE.DOWNED;
    if (this.downed) {
      this.bleedoutFrac = s.healthFrac;
      this.health = 0;
    } else {
      this.bleedoutFrac = 0;
      this.health = this.maxHealth * s.healthFrac;
    }

    const st = this._s;
    st.aimYaw = s.yaw;
    // Neither of these is on the wire. Grounded is inferred from vertical
    // motion and sprint from ground speed: both are animation-only tells, and
    // spending snapshot bytes on them would cost more than getting them
    // slightly wrong ever shows.
    st.grounded = Math.abs(this.velocity.y) < 1.2;
    st.sprint = Math.hypot(this.velocity.x, this.velocity.z) > 8.5;
    st.dead = !this.alive;

    this.group.position.copy(this.position);
    // The pose, after the position and before the animator: `mesh.update`
    // writes `rotation.y` from its own body yaw and leaves x alone, so the
    // pitch survives it and the sink is applied to the copy just made.
    if (this.downed) {
      this.group.rotation.x = DOWNED_PITCH;
      this.group.position.y -= DOWNED_SINK;
    } else if (this.group.rotation.x !== 0) {
      this.group.rotation.x = 0;
    }
    this.mesh.update(dt, st);
  }

  onDeath() {
    this.alive = false;
    this._s.dead = true;
  }

  dispose(ctx) {
    ctx.scene.remove(this.group);
    this.mesh.dispose?.();
  }
}

// ------------------------------------------------------------- interactables

class InteractableView {
  constructor(rec, ctx) {
    this.obj = createInteractableView(ctx, rec.typeId, new THREE.Vector3(rec.x, rec.y, rec.z));
    if (!this.obj) return;
    this.obj.yaw = rec.yaw;
    this.obj.group.rotation.y = rec.yaw;
    // Registering with the manager is what gives a client the proximity prompt.
    // Pressing E there only sets the INTERACT command bit; the host resolves it.
    ctx.interactables?.add(this.obj);
    this.position = this.obj.position;
    this.group = this.obj.group;
  }

  applyNetState(s, dt) {
    const o = this.obj;
    if (!o) return;
    // `health` is availability: the host sends 1 while a chest is unopened and
    // 0 once it is, which is the whole of an interactable's replicated state.
    const available = s.healthFrac > 0.5;
    if (o.used === available) o.used = !available;
    o.update?.(dt);
  }

  dispose(ctx) {
    if (!this.obj) return;
    // `Interactables.clear()` on the next stage disposes whatever is still in
    // its list, so leaving a released view behind would double-dispose it.
    const list = ctx.interactables?.list;
    const i = list ? list.indexOf(this.obj) : -1;
    if (i >= 0) list.splice(i, 1);
    if (ctx.interactables?.teleporter === this.obj) ctx.interactables.teleporter = null;
    this.obj.group.removeFromParent();
    this.obj.dispose();
    this.obj = null;
  }
}

// ----------------------------------------------------------------- factories

/**
 * Teach a NetClient how to render each replicated kind. Returning null for a
 * record makes NetClient skip it, which is how unknown enemy types and
 * projectiles (never replicated — clients spawn those from events) fall away
 * harmlessly instead of throwing every snapshot.
 */
export function installViewFactories(client, ctx) {
  client.registerViewFactory(EKIND.ENEMY, (rec) => {
    if (!ENEMY_BY_TYPE.has(rec.typeId)) return null;
    return new EnemyView(rec, ctx);
  });

  client.registerViewFactory(EKIND.PLAYER, (rec) => new PlayerView(rec, ctx));

  client.registerViewFactory(EKIND.INTERACTABLE, (rec) => {
    const v = new InteractableView(rec, ctx);
    return v.obj ? v : null;
  });
}
