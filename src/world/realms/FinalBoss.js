import * as THREE from 'three';
import { FINALE_PHASES } from '../../data/realms.js';
import { ENEMY_BY_ID } from '../../data/enemies.js';
import { raiseIslands, spawnCollapseDebris } from './RealmArena.js';
import { pullToFloor } from './RealmStage.js';
import { lerp, clamp, RNG } from '../../core/MathUtil.js';
import { ITEMS_BY_TIER } from '../../data/items.js';

/**
 * The Fracture — the finale, and the only fight in the game where the arena is
 * a participant.
 *
 * The six teleporter bosses all escalate the same way: a phase break clears
 * their cooldowns and unlocks another row of the attack table. That is a fine
 * shape and this fight does it too, but it is not what makes it the last one.
 * What makes it the last one is that each break changes **what the player is
 * allowed to do**:
 *
 *  - **Phase 2** takes twelve metres of floor away — ground the player has
 *    spent the whole of phase 1 using — and *wards the boss completely* until
 *    three Rift Anchors are down. For that stretch the correct answer is not
 *    "shoot the boss", which is the only answer the other six ever have.
 *  - **Phase 3** cuts the floor again, to a disc barely wider than the boss's
 *    own nova, raises three islands as the only other ground, and suppresses
 *    healing for the rest of the fight. Every regen item in the inventory stops
 *    meaning anything at the exact moment the arena stops having room in it.
 *
 * The collapse is animated rather than snapped, because a floor that vanished
 * between frames would read as a bug; `COLLAPSE_TIME` is long enough to run
 * off, short enough to be frightening.
 */

const COLLAPSE_TIME = 2.2;
const VICTORY_HOLD = 6.0;     // beat between the last hit and the summary screen
const ANCHOR_HEALTH_FRAC = 0.10;

/**
 * The Herald's own hue, and the single source of it for everything that belongs
 * to the boss: the anchors, their tethers, and the regalia that orbits it.
 *
 * The critique measured the first pass's anchors at hue 245.9 against a floor
 * at 249.3 and the Herald at 294.3 — they colour-matched the ground they stood
 * on, 48 degrees away from the thing they were warding, and read as a debug
 * gizmo. Everything below is emitted at exactly this value instead.
 */
const HERALD_HUE = 0xd050ff;
const HERALD_HOT = 0xff4ad0;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class FinaleController {
  constructor(realms, def) {
    this.realms = realms;
    this.def = def;
    this.boss = null;
    this.phase = 1;
    this.anchors = [];
    this.warded = false;
    this.islandsUp = false;
    this.targetRadius = def.floorRadius;
    this.collapseT = 0;
    this.fromRadius = def.floorRadius;
    this.victoryT = -1;
    this.done = false;
    /** `{ anchor, group, beam }` — the drawn half of the ward. */
    this.wardArt = [];
    /** Falling-slab/dust effects in flight, from `spawnCollapseDebris`. */
    this.debris = [];
    /** The boss's orbiting regalia, and the two lights that model it. */
    this.regalia = null;
    this._t = 0;
  }

  // ------------------------------------------------------------- boss dressing

  /**
   * Two lights and a broken ring, both hung on the boss in world space.
   *
   * The critique of the Herald was that it is the least-resolved character in
   * the game: one flat pink value with no shading separating shell, mantle and
   * crown, and a silhouette whose aspect ran 0.97 -> 0.85 -> 0.64 across the
   * three phases — "three different reads of one unstable mass".
   *
   * The rig itself is `src/entities/EnemyMeshes.js`, which this task does not
   * own. What *is* ownable from here is the light on it and what orbits it, and
   * both address the measurement directly: a hot key above-front and a deep
   * cool fill behind give the body a lit half and a dark half where before the
   * arena's magenta rim was flattening every surface to one value; and the
   * broken ring is a single asymmetric element, wider than the boss and tilted
   * out of its plane, that is in the silhouette from every angle and at every
   * phase. It is deliberately *not* parented to the rig — rigs are pooled, and
   * anything added to `rig.pivot` would ride the pool into the next run.
   */
  _dressBoss(ctx, stage) {
    const root = stage.root;
    const g = new THREE.Group();

    // A broken ring: three quarters of a torus, so it has two visible ends.
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x1a1030, emissive: HERALD_HUE, emissiveIntensity: 1.1,
      roughness: 0.35, metalness: 0.4,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.16, 6, 48, Math.PI * 1.5), ringMat);
    ring.rotation.x = Math.PI * 0.5 - 0.34;
    ring.rotation.z = 0.22;
    g.add(ring);

    // The trailing spar. Long, off-axis and only on one side: it is what makes
    // the mass read the same way at 0.97 aspect and at 0.64.
    const sparMat = new THREE.MeshStandardMaterial({
      color: 0x140c26, emissive: HERALD_HOT, emissiveIntensity: 0.45,
      roughness: 0.5, metalness: 0.3,
    });
    const spar = new THREE.Mesh(new THREE.ConeGeometry(0.42, 9.5, 5), sparMat);
    spar.position.set(-3.2, -3.4, -1.1);
    spar.rotation.set(0.42, 0, 0.78);
    g.add(spar);

    root.add(g);

    // Modelling light. The key is hot and high on the camera side; the fill is
    // a deep violet from behind and below, so the shell separates from the
    // mantle instead of both being one pink.
    const key = new THREE.PointLight(0xffd8ff, 26, 26, 1.6);
    const fill = new THREE.PointLight(0x6a30c0, 14, 22, 1.8);
    root.add(key); root.add(fill);

    this.regalia = { g, ring, spar, key, fill, mats: [ringMat, sparMat] };
  }

  _updateBossArt(dt) {
    const r = this.regalia, boss = this.boss;
    if (!r) return;
    this._t += dt;
    if (!boss || !boss.alive) { r.g.visible = false; r.key.intensity = 0; r.fill.intensity = 0; return; }
    r.g.position.copy(boss.position);
    r.g.position.y += 3.4;
    r.g.rotation.y = this._t * 0.45;
    r.ring.rotation.z = 0.22 + Math.sin(this._t * 0.7) * 0.12;
    r.key.position.set(boss.position.x + 4.0, boss.position.y + 9.5, boss.position.z + 5.5);
    r.fill.position.set(boss.position.x - 4.5, boss.position.y + 1.0, boss.position.z - 6.0);
  }

  // -------------------------------------------------------------------------

  /**
   * `Realms.enterRealm` calls this on a co-op client too (`Realms.js:254`,
   * `ctx.authority || replicated`), so the authority gate here decides what a
   * guest sees. NETCODE.md's one rule: *"If it changes game state, gate it on
   * `ctx.authority`. If it only changes what you see or hear, never gate it."*
   *
   * The gate used to be the first line of the method, which put the boss's
   * modelling lights, its ring and spar, the objective line and the finale's
   * own boss sub-line behind it — none of which writes gameplay state, and the
   * lights in particular are the entire fix for the Herald photographing as one
   * flat pink value. So the cosmetic half runs first and unconditionally, and
   * the gate now covers only what it should: spawning the entity, taking
   * ownership of `director.boss`, and the `bossSpawn` event.
   *
   * **Not verified, and cannot be from here:** no two-peer session has ever been
   * run under `PROTOCOL_VERSION` 2, and the capture harness is single-player, so
   * every statement in this comment about client behaviour is read off the call
   * graph rather than off a running client. See `_raiseAnchors` for the part of
   * this defect that is *not* fixed.
   */
  enter(ctx, stage) {
    const card = ENEMY_BY_ID.get('herald');
    if (!card) return;

    this._dressBoss(ctx, stage);
    // The HUD's boss sub-line is authored for the teleporter event. This is not
    // that, and the finale's own frame should not say it is.
    if (ctx.hud?.refs?.bossSub) ctx.hud.refs.bossSub.textContent = 'THE FRACTURE — FINAL';
    ctx.pipeline?.addShake?.(0.8);
    ctx.hud?.setObjective?.('Destroy the Herald');

    if (!ctx.authority) return;

    // Placed across the arena rather than on top of the player: the first thing
    // the finale has to do is let you look at it.
    const at = stage.origin.clone().add(_v.set(0, 0, -stage.floorRadius * 0.55).clone());
    const boss = ctx.director?.spawnOne?.(ctx, card, at, null);
    if (!boss) return;
    boss.isBoss = true;
    this.boss = boss;
    // Registered as *the* director boss so its death goes through the same
    // reaper and emits `bossDead` — the HUD bar, the boss item drop and the
    // profile's boss counter all hang off that one fact.
    ctx.director.boss = boss;
    ctx.events.emit('bossSpawn', { enemy: boss });

    // The void route's teeth and its pay (launch spec §2). Both are def-driven
    // so the clean Fracture — with neither field — is byte-identical to before.
    const scale = this.def.bossScale;
    if (scale) {
      boss.maxHealth = Math.round(boss.maxHealth * (scale.health ?? 1));
      boss.health = boss.maxHealth;
      boss.damage = (boss.damage ?? 0) * (scale.damage ?? 1);
    }
    if (this.def.voidLoot > 0) {
      // The richest corrupted loot in the game, paid on arrival. The pick
      // rides a derived stream — a ctx.rng draw here would displace the
      // fight's own rolls relative to a run that took the clean door.
      const rng = new RNG(((ctx.seed >>> 0) ^ 0x51f0c3a1) >>> 0 || 1);
      const pool = ITEMS_BY_TIER.blight || [];
      for (let i = 0; i < this.def.voidLoot && pool.length; i++) {
        const a = (i / this.def.voidLoot) * Math.PI * 2;
        const p = stage.origin.clone().add(
          new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(stage.floorRadius * 0.7));
        ctx.interactables.spawnOrb(p, rng.pick(pool).id, 1.4);
      }
    }
  }

  // -------------------------------------------------------------------------

  fixedUpdate(ctx, h) {
    const stage = this.realms.active?.stage;
    if (!stage) return;
    this._animateCollapse(stage, h);
    this._updateBossArt(h);
    this._updateWardArt();
    for (let i = this.debris.length - 1; i >= 0; i--) {
      if (!this.debris[i].update(h)) { this.debris[i].dispose(); this.debris.splice(i, 1); }
    }
    if (!ctx.authority || this.done) return;

    // Phase 3's rule: nothing heals. Topped up every step rather than set once,
    // because the director's lock is a deadline and any withering elite in the
    // run tops up the same one.
    //
    // The lock is per-player and now needs a named victim. This controller is
    // not an `Enemy` and has no `targetPlayer` of its own, so the victim is the
    // local player — which is behaviour-preserving rather than a narrowing: the
    // old lock's flag was global but its *enforcement* only ever capped
    // `ctx.player`, so no guest was ever denied here. Widening this to the whole
    // roster would be new co-op behaviour (which the per-player ceiling now
    // makes possible for the first time), and that is a balance decision rather
    // than part of this fix.
    if (this.phase >= 3) ctx.director?.denyHealing?.(0.5, ctx.roster?.local ?? ctx.player);

    const boss = this.boss;
    if (boss && !boss.alive && this.victoryT < 0) {
      this.victoryT = VICTORY_HOLD;
      this._onKilled(ctx, stage);
    }
    if (this.victoryT >= 0) {
      this.victoryT -= h;
      if (this.victoryT <= 0) {
        this.done = true;
        this.realms.victory();
      }
      return;
    }
    if (!boss || !boss.alive) return;

    if (boss.phase !== this.phase) this._enterPhase(ctx, stage, boss.phase);
    if (this.warded) this._tickWard(ctx, stage, boss);

    // A boss that flew out over the void while the floor was shrinking has to
    // come back: the Herald hovers, so nothing else would ever bring it in.
    const r = Math.hypot(boss.position.x - stage.origin.x, boss.position.z - stage.origin.z);
    if (r > stage.floorRadius - 3) {
      const k = (stage.floorRadius - 3) / r;
      boss.position.x = stage.origin.x + (boss.position.x - stage.origin.x) * k;
      boss.position.z = stage.origin.z + (boss.position.z - stage.origin.z) * k;
    }
  }

  // -------------------------------------------------------------- phase break

  _enterPhase(ctx, stage, phase) {
    this.phase = phase;
    const spec = FINALE_PHASES[Math.min(phase, FINALE_PHASES.length) - 1];
    if (!spec) return;

    // The collapse. Announced hard — this is the fight's loudest moment and the
    // player has `COLLAPSE_TIME` to be somewhere that will still be there.
    if (spec.floorRadius < stage.floorRadius) {
      this.fromRadius = stage.floorRadius;
      this.targetRadius = spec.floorRadius;
      this.collapseT = COLLAPSE_TIME;
      ctx.pipeline?.addShake?.(0.9);
      ctx.audio?.play?.('explosion', stage.origin);
      // The collapse, drawn: a torn ring of slabs between the old radius and
      // the new one, falling, with a dust plane settling after them. Without
      // this the phase break was a line of HUD text over a machined rim.
      this.debris.push(spawnCollapseDebris(stage, this.fromRadius, this.targetRadius));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        _v.set(stage.origin.x + Math.cos(a) * stage.floorRadius, 0.5,
               stage.origin.z + Math.sin(a) * stage.floorRadius);
        ctx.vfx?.explosion?.(_v, 5, 0xd050ff);
      }
      ctx.director?.spawnWave?.(stage.origin, stage.floorRadius, 46, 0, null, 0xd050ff);
    }

    if (spec.anchors > 0) this._raiseAnchors(ctx, stage, spec.anchors);

    if (spec.platforms && !this.islandsUp) {
      this.islandsUp = true;
      raiseIslands(stage, {
        count: spec.platforms, radius: spec.platformRadius,
        dist: spec.platformDist, height: spec.platformHeight,
      });
    }

    if (!this.warded) {
      ctx.hud?.setObjective?.(phase >= 3 ? 'No quarter — end it' : 'Destroy the Herald');
    }
  }

  /**
   * Phase 2's gate.
   *
   * The anchors carry a fixed fraction of the Herald's own health rather than
   * their card's, so the gate is the same length of fight whether the finale is
   * reached at minute eighteen or at minute fifty. The `warded` affix's reflect
   * makes standing in front of one while you break its barrier a decision
   * rather than a formality.
   *
   * The *look* is now built here rather than assumed from the affix. The first
   * pass claimed the affix "repaints them violet so they read as pieces of the
   * boss" and the pixels refuted it: anchors at hue 245.9 on a floor at 249.3,
   * with the Herald 48 degrees away at 294.3 — they matched the ground, not the
   * boss, and rendered as dark polyhedra with white wireframe edges that looked
   * like a debug gizmo. Each anchor now gets a crown of the boss's own emissive
   * at `HERALD_HUE` *and a drawn tether to the Herald*, so the ward is a visible
   * relationship rather than an assertion in the objective line: three beams
   * feeding one boss, and breaking a beam is obviously what unwards it.
   *
   * **Known and unfixed: on a co-op client the tethers do not exist.** This is
   * reached only from `_enterPhase`, which is reached only from the
   * `ctx.authority` early-return in `fixedUpdate`, so a guest sees an
   * unkillable Herald, a yellow objective line and three unexplained polyhedra.
   * That is a NETCODE.md violation and it is *not* closed here, because the art
   * is built from the `Enemy` instances this method spawns and a client has no
   * local equivalent: its anchors arrive as snapshot views through
   * `src/net/NetViews.js`, and nothing in this file is told about them. Closing
   * it needs a client-side hook in `src/net/` / `Realms.js`, which this change
   * does not own — and it cannot be tested either way, because no two-peer
   * session has ever been run under `PROTOCOL_VERSION` 2. Writing speculative
   * discovery code against an untestable path would be worse than recording the
   * gap. `_updateWardArt` and `_updateBossArt` already run ungated, so they will
   * drive whatever art a future hook builds without further change.
   */
  _raiseAnchors(ctx, stage, count) {
    const card = ENEMY_BY_ID.get('anchor');
    const sites = stage.anchorSites ?? [];
    const hp = Math.max(200, Math.round((this.boss?.maxHealth ?? 4000) * ANCHOR_HEALTH_FRAC));
    for (let i = 0; i < count; i++) {
      const at = sites[i % Math.max(1, sites.length)]?.clone()
        ?? stage.origin.clone().add(_v.set(Math.cos(i) * 16, 0, Math.sin(i) * 16).clone());
      const e = ctx.director?.spawnOne?.(ctx, card, at, 'warded');
      if (!e) continue;
      e.maxHealth = hp;
      e.health = hp;
      e.maxShield = hp * 0.35;
      e.shield = e.maxShield;
      this.anchors.push(e);
      this.wardArt.push(this._buildWardArt(stage, e));
      ctx.vfx?.burst?.(at, HERALD_HUE);
    }
    if (!this.anchors.length) return;

    this.warded = true;
    // Not `invuln`: a hit that reports nothing at all reads as a broken hitbox.
    // Absurd armour puts a visible `1` on the screen instead, which is the
    // universal "this is immune" read and keeps the hit feedback honest.
    this._savedArmor = this.boss.baseArmor;
    this.boss.baseArmor = 1e6;
    ctx.hud?.setObjective?.('The Herald is warded — destroy the three anchors');
    ctx.pipeline?.addShake?.(0.5);
  }

  /**
   * One anchor's drawn half: a crown of boss-coloured shards, a shell, and a
   * tether.
   *
   * **The crown hangs off the anchor's own rig, not off the stage.** Two things
   * follow from that, and both are the point. The subject the harness measures
   * for `26-finale-phase2` is `anchor.rig.root`, so art parented to the stage is
   * art that is not part of the anchor as far as any measurement — or any
   * player's eye — is concerned: the round-6 baseline photographed the three
   * anchors at hue 258.5 / 279.8 / 255.0 against a floor at 251.6, i.e. two of
   * the three still colour-matched the ground rather than the Herald at 277,
   * because the only Herald-coloured thing near them was a separate group. And
   * the third measured 284 px at `sepP50` 0.13 — a dark polyhedron on a dark
   * floor, below the per-object gate. Parenting also deletes the per-frame
   * position copy and makes the crown inherit the spawn-scale ramp, so an
   * anchor that is still rising does not wear a full-size crown.
   */
  _buildWardArt(stage, anchor) {
    const hot = new THREE.MeshStandardMaterial({
      color: 0x1c0e30, emissive: HERALD_HUE, emissiveIntensity: 2.4,
      roughness: 0.3, metalness: 0.2,
    });
    const g = new THREE.Group();
    // A collar of five shards leaning outward — the crown shape the Herald
    // wears, at a quarter of the scale. Same silhouette family, same emissive.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.32, 2.6 + (i % 2) * 0.9, 4), hot);
      m.position.set(Math.cos(a) * 1.35, 1.7, Math.sin(a) * 1.35);
      m.rotation.set(Math.sin(a) * 0.34, -a, -Math.cos(a) * 0.34);
      g.add(m);
    }
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.15, 0), hot);
    core.position.y = 2.9;
    g.add(core);

    // The shell. The anchor's body is an ordinary `warded` elite and wears that
    // affix's tint (0xa37eff, hue 257) — which is the ground's hue, not the
    // boss's. This is a faceted additive cage at the Herald's own hue drawn
    // over that body, so the pixels the anchor occupies carry the boss's colour
    // instead of the floor's without repainting the shared elite materials that
    // every other warded monster in the game draws with.
    const shellMat = new THREE.MeshBasicMaterial({
      color: HERALD_HOT, wireframe: true, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0, 0), shellMat);
    shell.position.y = 1.6;
    g.add(shell);
    (anchor.rig?.root ?? stage.root).add(g);

    // The tether. A unit-length cylinder along +Y, re-aimed and re-scaled every
    // step, additive so it reads as light rather than as a pipe.
    const beamMat = new THREE.MeshBasicMaterial({
      color: HERALD_HOT, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const bg = new THREE.CylinderGeometry(0.16, 0.16, 1, 6, 1, true);
    bg.translate(0, 0.5, 0);
    const beam = new THREE.Mesh(bg, beamMat);
    beam.frustumCulled = false;
    stage.root.add(beam);

    return { anchor, group: g, core, shell, beam, mats: [hot, beamMat, shellMat] };
  }

  /** Follow the anchors, re-aim the tethers, drop the art when one dies. */
  _updateWardArt() {
    const boss = this.boss;
    for (let i = this.wardArt.length - 1; i >= 0; i--) {
      const w = this.wardArt[i];
      if (!w.anchor.alive || !this.warded) { this._disposeWardArt(w); this.wardArt.splice(i, 1); continue; }
      // The group rides the rig, so only the spin and the bob are driven here.
      w.group.rotation.y = this._t * 0.9;
      w.core.position.y = 2.9 + Math.sin(this._t * 2.2 + i) * 0.18;
      w.shell.rotation.set(this._t * 0.25, -this._t * 0.4, 0);
      if (!boss || !boss.alive) { w.beam.visible = false; continue; }
      w.beam.visible = true;
      _v.copy(w.anchor.position); _v.y += 2.6;
      _v2.copy(boss.position); _v2.y += 2.2;
      w.beam.position.copy(_v);
      _v2.sub(_v);
      const len = _v2.length() || 1;
      w.beam.quaternion.setFromUnitVectors(_up, _v2.normalize());
      w.beam.scale.set(1, len, 1);
    }
  }

  _disposeWardArt(w) {
    w.group.parent?.remove(w.group);
    w.beam.parent?.remove(w.beam);
    for (const c of w.group.children) c.geometry.dispose();
    w.beam.geometry.dispose();
    for (const m of w.mats) m.dispose();
  }

  _tickWard(ctx, stage, boss) {
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      if (!this.anchors[i].alive) this.anchors.splice(i, 1);
    }
    if (this.anchors.length) return;
    this.warded = false;
    boss.baseArmor = this._savedArmor ?? 0;
    // The ward breaking is the phase's payoff and has to be as loud as the
    // collapse that opened it.
    ctx.vfx?.explosion?.(boss.position, 12, 0xff4ad0);
    ctx.director?.spawnWave?.(boss.position, 26, 40, 0, null, 0xff4ad0);
    ctx.pipeline?.addShake?.(0.7);
    ctx.audio?.play?.('explosion', boss.position);
    ctx.hud?.setObjective?.('The ward is down — destroy the Herald');
  }

  // ------------------------------------------------------------- the collapse

  _animateCollapse(stage, h) {
    if (this.collapseT <= 0) return;
    this.collapseT = Math.max(0, this.collapseT - h);
    const k = 1 - clamp(this.collapseT / COLLAPSE_TIME, 0, 1);
    // Ease-in: the rim creeps for the first half-second and then goes, which is
    // what makes "get to the middle" the reaction rather than "walk inward".
    stage.setFloorRadius(lerp(this.fromRadius, this.targetRadius, k * k));
  }

  // ------------------------------------------------------------------ the end

  _onKilled(ctx, stage) {
    ctx.pipeline?.addShake?.(1.0);
    ctx.hitstop = 0.12;
    ctx.vfx?.explosion?.(this.boss.position, 18, 0xff4ad0);
    ctx.hud?.setObjective?.('The Herald falls');
    // Anything still standing goes with it — the run is over and a stray mote
    // killing the player during the outro would flip a victory into a death.
    // Through Combat rather than by zeroing health, so each one plays its own
    // death and is reaped normally instead of standing there at 0 hp.
    const kill = { source: null, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'finale' };
    for (const e of (ctx.director?.enemies ?? []).slice()) {
      if (e !== this.boss && e.alive) ctx.combat?.applyDamage?.(e, e.health + e.shield + 1, kill);
    }
    // Put the player back on solid ground for the outro, whatever the last
    // exchange did to them.
    const p = ctx.player;
    if (p && p.alive && p.position.y < 0) pullToFloor(stage, p.position);
  }

  abort() { this.done = true; }

  exit(ctx) {
    ctx.hud?.clearBoss?.();
    if (ctx.director) ctx.director.boss = null;
    // Everything this controller allocated is its own to release. `RealmStage`
    // disposes what is under `stage.root`, but these materials are shared by
    // several meshes each and would be disposed more than once through the
    // traverse, so they go back here explicitly.
    for (const w of this.wardArt) this._disposeWardArt(w);
    this.wardArt.length = 0;
    for (const d of this.debris) d.dispose();
    this.debris.length = 0;
    const r = this.regalia;
    if (r) {
      r.g.parent?.remove(r.g);
      r.key.parent?.remove(r.key);
      r.fill.parent?.remove(r.fill);
      r.ring.geometry.dispose();
      r.spar.geometry.dispose();
      for (const m of r.mats) m.dispose();
      this.regalia = null;
    }
  }
}
