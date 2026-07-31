import * as THREE from 'three';
import { ParticleSystem, FRAME } from '../fx/ParticleSystem.js';
import { Trails } from '../fx/Trails.js';
import { Decals, DECAL } from '../fx/Decals.js';
import { makeDissolvable } from '../shaders/DissolveShader.js';
import { clamp, lerp } from '../core/MathUtil.js';

/**
 * The impact layer.
 *
 * Everything here is fire-and-forget and pooled. Nothing in this file may
 * allocate at steady state: effects write into shared scratch objects and hand
 * them to the particle ring buffer, which copies out immediately.
 *
 * The design rule for every entry in the catalogue is "at least three
 * simultaneous elements". A hit is never just sparks — it is sparks plus a
 * flash plus a light plus hitstop plus shake plus a sound. That layering, not
 * the quality of any single element, is what makes Risk of Rain 2 hits land.
 *
 * All of it runs in `update`, never `fixedUpdate`, and keeps animating while
 * `ctx.hitstop` is freezing gameplay — a frozen frame with dead VFX reads as a
 * dropped frame, a frozen frame with live VFX reads as impact.
 */

/* --- game-feel tuning ------------------------------------------------ *
 * Hitstop is measured in seconds of fully frozen gameplay.
 *  0.018  normal hit   — below perception as lag, still felt as weight
 *  0.045  crit         — clearly heavier without reading as a stutter
 *  0.060  kill
 *  0.090  elite kill / explosion
 *  0.130  boss kill
 * NORMAL hits are rate-gated: a 12/s weapon that froze 18ms every shot would
 * spend a fifth of its time stopped and feel broken, so consecutive small hits
 * only re-trigger every HITSTOP_GATE seconds. Big beats bypass the gate but
 * everything clamps to HITSTOP_MAX so nothing ever reads as a hitch.
 * ------------------------------------------------------------------- */
const HITSTOP = {
  hit: 0.018,
  crit: 0.045,
  kill: 0.060,
  elite: 0.090,
  explosion: 0.080,
  boss: 0.130,
  playerHurt: 0.050,
};
const HITSTOP_MAX = 0.14;
const HITSTOP_GATE = 0.085;

// Shake falls off with the square of camera distance; 18m is the half-power
// point, which on a ~14m third-person boom means the player's own weapon shakes
// hard and a fight across the arena barely registers.
const SHAKE_HALF_DIST = 18;

const MAT_PRESETS = {
  stone:    { spark: 0x9fb0c4, dust: 0x8d8577, decal: DECAL.CRACK, sparks: 8,  dustCount: 10, sound: 'stone' },
  concrete: { spark: 0xb8b0a0, dust: 0x9a948a, decal: DECAL.CRACK, sparks: 7,  dustCount: 12, sound: 'stone' },
  metal:    { spark: 0xffd7a0, dust: 0x6e7480, decal: DECAL.BULLET, sparks: 16, dustCount: 4,  sound: 'metal' },
  dirt:     { spark: 0x6b563c, dust: 0x7a6247, decal: DECAL.SCORCH, sparks: 2,  dustCount: 16, sound: 'dirt' },
  grass:    { spark: 0x74863f, dust: 0x5e6b3a, decal: DECAL.SCORCH, sparks: 2,  dustCount: 14, sound: 'dirt' },
  wood:     { spark: 0xc08a4a, dust: 0x7d5c33, decal: DECAL.CRACK, sparks: 5,  dustCount: 8,  sound: 'wood' },
  flesh:    { spark: 0xff4d4d, dust: 0x8c1620, decal: DECAL.BLOOD, sparks: 10, dustCount: 6,  sound: 'flesh' },
};

const ELITE = {
  blazing:     { color: 0xff5a10, tip: 0xffd070, frame: FRAME.EMBER, rate: 34, rise: 1.4 },
  overloading: { color: 0x3f7bff, tip: 0xd9ecff, frame: FRAME.SPARK, rate: 26, rise: 0.6 },
  glacial:     { color: 0x59d6ff, tip: 0xe6ffff, frame: FRAME.HEX,   rate: 22, rise: -0.6 },
};

// Keyed to Combat's STATUS_DEFS so `ctx.vfx.status(entity, type, colour)` maps
// straight through with no translation table on the gameplay side.
const STATUS = {
  burn:   { color: 0xff6a10, tip: 0xffc040, frame: FRAME.EMBER, rise: 1.6,  rate: 22, dur: 4.0 },
  bleed:  { color: 0xd0203a, tip: 0xff6a78, frame: FRAME.BLOB,  rise: -1.2, rate: 16, dur: 3.0, alpha: true },
  slow:   { color: 0x5ad2ff, tip: 0xc8f2ff, frame: FRAME.DUST,  rise: -0.5, rate: 10, dur: 2.0, alpha: true },
  freeze: { color: 0x9fe8ff, tip: 0xffffff, frame: FRAME.HEX,   rise: -0.4, rate: 14, dur: 1.6 },
  shock:  { color: 0xc9b5ff, tip: 0xffffff, frame: FRAME.SPARK, rise: 0.2,  rate: 18, dur: 1.4 },
};

// Two separate scratch pools. Effect methods use _v*, event handlers use _h*.
// Sharing one pool would let a handler's position vector be clobbered by the
// effect it just passed that vector into — a class of bug that shows up as
// effects silently playing at the world origin.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _h1 = new THREE.Vector3();
const _h2 = new THREE.Vector3();
const _box = new THREE.Box3();
const _tmpColor = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class VFX {
  constructor() {
    this.particles = new ParticleSystem({ capacityAdditive: 20480, capacityAlpha: 10240 });
    this.trails = new Trails({ capacity: 40 });
    this.decals = new Decals({ capacity: 192 });

    this.time = 0;
    this.damageDirections = [];   // read by the HUD for the hurt indicator
    this._dirPool = [];
    this._dirCursor = 0;
    for (let i = 0; i < 8; i++) {
      this._dirPool.push({ pos: new THREE.Vector3(), angle: 0, alpha: 0, strength: 0, t: 0, life: 1.2 });
    }
    this._lastHitstop = -1;

    this._dissolving = [];
    this._flashes = [];
    this._auras = [];
    this._statuses = [];
    this._teleAccum = 0;
    this._teleRing = 0;
    this._teleProgress = 0;
    this._dt = 0;

    // Shared emit-options scratch — see _ep().
    this._e = {};
    this._ep0 = new THREE.Vector3();
    this._ed0 = new THREE.Vector3(0, 1, 0);
    this._ei0 = new THREE.Vector3();
    this._ec0 = new THREE.Color();
    this._ec1 = new THREE.Color();
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.vfx = this;

    this.particles.init(ctx);
    this.trails.init(ctx);
    this.decals.init(ctx);

    this.lights = new LightPool(ctx, 6);
    this.beams = new BeamPool(ctx, 192);
    this.rings = new RingPool(ctx, 48);
    this.numbers = new DamageNumbers(ctx, 384);

    this._roots = [
      this.particles.root, this.trails.root, this.decals.mesh,
      this.beams.mesh, this.rings.mesh, this.numbers.mesh,
    ];

    const e = ctx.events;
    e.on('damage', (p) => this._onDamage(p));
    e.on('kill', (p) => this._onKill(p));
    e.on('playerHurt', (p) => this._onPlayerHurt(p));
    e.on('itemPickup', () => {
      const pp = ctx.player?.position;
      if (pp) this.itemPickupBurst(pp, 0xffffff);
    });
    // Progression owns the teleporter's position, so we only latch progress and
    // drive the aura from update() if a position happens to be exposed.
    e.on('teleporterCharging', (p) => { this._teleProgress = p?.progress ?? 0; });
    e.on('teleporterComplete', () => {
      const pp = ctx.player?.position;
      if (pp) this.explosion(pp, 6, 0x66ddff);
    });
    e.on('bossSpawn', () => {
      ctx.pipeline?.addShake(0.16);
      this._hitstop(HITSTOP.boss, true);
    });
    e.on('playerDead', () => {
      ctx.pipeline?.addShake(0.35);
      if (ctx.pipeline) {
        ctx.pipeline.aberration = 0.03;
        ctx.pipeline.vignetteBoost = 0.9;
      }
      this._hitstop(0.12, true);
    });

    addEventListener('resize', () => {
      this.particles.resize();
      this.numbers.resize();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Effect catalogue                                                    */
  /* ------------------------------------------------------------------ */

  /** Muzzle: flash core + cross flare + smoke + shell + light flick + shake. */
  muzzleFlash(pos, dir, scale = 1) {
    const s = scale;
    _v1.copy(dir).normalize();

    // Hot core, one frame's worth.
    let e = this._ep();
    e.count = 1; e.position.copy(pos); e.dir.copy(_v1);
    e.speed = 1.2; e.life = 0.055; e.lifeVar = 0;
    e.size0 = 0.9 * s; e.size1 = 0.35 * s; e.sizeVar = 0.1;
    e.color0.set(0xfff3d0); e.color1.set(0xffb03c);
    e.frame = FRAME.CROSS; e.spin = 6; e.alphaPow = 0.7; e.fadeIn = 0.001;
    e.drag = 8; e.soft = 0;
    this.particles.emit(e);

    // Directional cone of hot gas.
    e = this._ep();
    e.count = 7; e.position.copy(pos); e.dir.copy(_v1);
    e.spread = 0.35; e.speed = 9 * s; e.speedVar = 0.6;
    e.life = 0.09; e.size0 = 0.34 * s; e.size1 = 0.02;
    e.color0.set(0xffe8b0); e.color1.set(0xff6a18);
    e.frame = FRAME.SOFT; e.drag = 14; e.alphaPow = 1.1; e.soft = 0.3;
    this.particles.emit(e);

    // Sparks spitting forward.
    e = this._ep();
    e.count = 9; e.position.copy(pos); e.dir.copy(_v1);
    e.spread = 0.6; e.speed = 16 * s; e.speedVar = 0.7;
    e.life = 0.22; e.size0 = 0.13 * s; e.size1 = 0.02;
    e.color0.set(0xffd9a0); e.color1.set(0xff4a10);
    e.frame = FRAME.SPARK; e.stretch = 1.1; e.gravity = 14; e.drag = 2.4;
    this.particles.emit(e);

    // Smoke puff that lingers past the flash — the part that sells recoil.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 5; e.position.copy(pos); e.dir.copy(_v1);
    e.spread = 0.9; e.speed = 2.4 * s; e.speedVar = 0.7;
    e.life = 0.85; e.lifeVar = 0.4;
    e.size0 = 0.22 * s; e.size1 = 0.95 * s;
    e.color0.set(0x8f8b86); e.color1.set(0x3a3a3c);
    e.alpha0 = 0.32; e.frame = FRAME.SMOKE; e.spin = 1.6;
    e.drag = 2.6; e.gravity = -1.2; e.turbulence = 0.35; e.fadeIn = 0.15;
    this.particles.emit(e);

    // Ejected shell: gravity + spin + a right-ward kick out of the port.
    _v2.set(0, 1, 0).cross(_v1).normalize();
    e = this._ep();
    e.count = 1; e.position.copy(pos).addScaledVector(_v2, 0.12 * s);
    e.dir.copy(_v2).addScaledVector(_v1, -0.15).add(_v3.set(0, 0.9, 0)).normalize();
    e.spread = 0.25; e.speed = 3.4; e.speedVar = 0.25;
    e.life = 1.1; e.lifeVar = 0.2;
    e.size0 = 0.075; e.size1 = 0.075; e.sizeVar = 0.1;
    e.color0.set(0xd8ae5c); e.color1.set(0x8a6a2c);
    e.alpha1 = 1; e.alphaPow = 0.35;
    e.frame = FRAME.SQUARE; e.spin = 22; e.gravity = 26; e.drag = 0.2;
    this.particles.emit(e);

    this.lights.flick(pos, 0xffb45a, 9 * s, 3.2 * s, 0.07);
    this.ctx.pipeline?.addShake(0.008 * s);
    this.ctx.audio?.shoot(pos, s);
  }

  /** Tracer: bright core beam plus a soft outer beam plus a travelling glint. */
  tracer(from, to, colour = 0xfff0c0) {
    _tmpColor.set(colour);
    // Outer glow first so the core reads as hotter than the falloff.
    this.beams.spawn(from, to, _tmpColor, 0.16, 0.02, 0.18, 0.35);
    this.beams.spawn(from, to, WHITE_HOT, 0.055, 0.005, 0.12, 2.4);

    let e = this._ep();
    e.count = 3; e.position.copy(from);
    e.dir.subVectors(to, from).normalize();
    e.spread = 0.25; e.speed = 6; e.life = 0.14;
    e.size0 = 0.16; e.size1 = 0.0;
    e.color0.set(colour); e.color1.set(colour);
    e.frame = FRAME.FLARE; e.drag = 6; e.soft = 0;
    this.particles.emit(e);
  }

  /** Surface impact: sparks + dust cone + decal + light + a surface-tuned tick. */
  impact(pos, normal, material = 'stone') {
    const preset = MAT_PRESETS[material] || MAT_PRESETS.stone;
    _v1.copy(normal);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0); else _v1.normalize();

    // Flash at the contact point — one frame, but it anchors everything else.
    let e = this._ep();
    e.count = 1; e.position.copy(pos).addScaledVector(_v1, 0.05);
    e.life = 0.07; e.lifeVar = 0;
    e.size0 = 0.5; e.size1 = 0.1;
    e.color0.set(0xffffff); e.color1.set(preset.spark);
    e.frame = FRAME.CROSS; e.drag = 8; e.alphaPow = 0.8; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    if (preset.sparks > 0) {
      e = this._ep();
      e.count = preset.sparks;
      e.position.copy(pos).addScaledVector(_v1, 0.03);
      e.dir.copy(_v1); e.spread = 1.1;
      e.speed = 9; e.speedVar = 0.8;
      e.life = 0.36; e.lifeVar = 0.5;
      e.size0 = 0.1; e.size1 = 0.012;
      e.color0.set(0xfff0c8); e.color1.set(preset.spark);
      e.frame = FRAME.SPARK; e.stretch = 1.3;
      e.gravity = 22; e.drag = 1.6;
      this.particles.emit(e);
    }

    e = this._ep();
    e.layer = 'alpha';
    e.count = preset.dustCount;
    e.position.copy(pos).addScaledVector(_v1, 0.05);
    e.dir.copy(_v1); e.spread = 0.95;
    e.speed = 3.2; e.speedVar = 0.7;
    e.life = 0.75; e.lifeVar = 0.4;
    e.size0 = 0.16; e.size1 = 0.85;
    e.color0.set(preset.dust); e.color1.set(preset.dust);
    e.alpha0 = 0.4; e.frame = FRAME.DUST; e.spin = 2;
    e.drag = 3.4; e.gravity = 2.5; e.turbulence = 0.3; e.fadeIn = 0.1;
    this.particles.emit(e);

    this.decals.place(pos, _v1, preset.decal, { size: preset.decal.size * 0.8 });
    this.lights.flick(pos, preset.spark, 4, 2.2, 0.06);
    this.ctx.audio?.impact(pos, preset.sound);
  }

  /** Enemy hit confirm. Punchy, short, and the same shape every time so it reads. */
  hitSpark(pos, colour = 0xffe9b0, scale = 1) {
    let e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.085; e.lifeVar = 0;
    e.size0 = 0.85 * scale; e.size1 = 0.12;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.CROSS; e.drag = 9; e.alphaPow = 0.9; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 10; e.position.copy(pos);
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 8 * scale; e.speedVar = 0.8;
    e.life = 0.19; e.lifeVar = 0.45;
    e.size0 = 0.11 * scale; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.4; e.drag = 5.5; e.gravity = 6;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.16; e.lifeVar = 0;
    e.size0 = 0.3 * scale; e.size1 = 1.5 * scale;
    e.color0.set(colour); e.color1.set(colour);
    e.alpha0 = 0.7; e.frame = FRAME.SHOCK; e.spin = 1.2;
    e.drag = 9; e.alphaPow = 1.6; e.soft = 0;
    this.particles.emit(e);
  }

  /** Blood: directional gout + fine mist + a wall/floor splat if we can find one. */
  bloodHit(pos, dir, colour = 0x9c0d18) {
    _v1.copy(dir);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0); else _v1.normalize();

    let e = this._ep();
    e.count = 14; e.position.copy(pos);
    e.dir.copy(_v1); e.spread = 0.75;
    e.speed = 7.5; e.speedVar = 0.75;
    e.life = 0.55; e.lifeVar = 0.5;
    e.size0 = 0.13; e.size1 = 0.05;
    e.color0.set(colour); e.color1.set(0x3c040a);
    e.alpha0 = 1; e.alpha1 = 0.9; e.alphaPow = 0.6;
    e.layer = 'alpha';
    e.frame = FRAME.BLOB; e.spin = 8; e.gravity = 22; e.drag = 1.1;
    this.particles.emit(e);

    // Fine mist hangs in the air a beat longer and reads at distance.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 10; e.position.copy(pos);
    e.dir.copy(_v1); e.spread = 1.3;
    e.speed = 3.2; e.speedVar = 0.8;
    e.life = 0.5; e.lifeVar = 0.4;
    e.size0 = 0.1; e.size1 = 0.5;
    e.color0.set(0x7a0a14); e.color1.set(0x2c0308);
    e.alpha0 = 0.42; e.frame = FRAME.DUST;
    e.drag = 3.2; e.gravity = 3; e.turbulence = 0.4; e.fadeIn = 0.08;
    this.particles.emit(e);

    this.hitSpark(pos, 0xff5a5a, 0.8);
    // Throw the splat along the hit direction and let it fall to the floor.
    _v2.copy(pos).addScaledVector(_v1, 0.4);
    _v3.set(_v1.x * 0.35, -1, _v1.z * 0.35).normalize();
    this.decals.project(_v2, _v3, DECAL.BLOOD, { maxDist: 4 });
  }

  /**
   * Explosion: white flash, fireball, expanding shockwave ring, debris,
   * lingering smoke column, scorch decal, light burst, shake and hitstop.
   */
  explosion(pos, radius = 4, colour = 0xff8a20) {
    const r = Math.max(0.5, radius);
    const s = r / 4;

    // 1. Instant white core — the frame that hides the transition.
    let e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.09; e.lifeVar = 0;
    e.size0 = r * 1.7; e.size1 = r * 0.5;
    e.color0.set(0xffffff); e.color1.set(0xffe08a);
    e.frame = FRAME.CORE; e.drag = 8; e.alphaPow = 0.8; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.22; e.lifeVar = 0;
    e.size0 = r * 2.4; e.size1 = r * 0.8;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.FLARE; e.spin = 2.5; e.drag = 7; e.alphaPow = 1.1; e.soft = 0;
    this.particles.emit(e);

    // 2. Fireball: fat additive blobs pushing outward and cooling to smoke.
    e = this._ep();
    e.count = 26; e.position.copy(pos); e.shell = r * 0.18;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 9 * s; e.speedVar = 0.7;
    e.life = 0.42; e.lifeVar = 0.45;
    e.size0 = r * 0.55; e.size1 = r * 0.95;
    e.color0.set(0xfff0b0); e.color1.set(colour);
    e.alpha0 = 0.95; e.frame = FRAME.SMOKE; e.spin = 2.2;
    e.drag = 4.2; e.gravity = -3; e.turbulence = 0.5; e.fadeIn = 0.02; e.soft = 1.2;
    this.particles.emit(e);

    // 3. Shockwave ring, ground-plane aligned.
    this.rings.spawn(pos, UP, colour, r * 0.35, r * 2.6, 0.45, 0.95);
    this.rings.spawn(pos, UP, 0xffffff, r * 0.2, r * 1.5, 0.28, 0.7);

    // 4. Debris chunks, gravity-bound and spinning.
    e = this._ep();
    e.count = 20; e.position.copy(pos); e.shell = r * 0.25;
    e.dir.set(0, 0.55, 0); e.spread = 1.35;
    e.speed = 13 * s; e.speedVar = 0.85;
    e.life = 1.5; e.lifeVar = 0.45;
    e.size0 = 0.16 * s; e.size1 = 0.11 * s; e.sizeVar = 0.55;
    e.color0.set(0x8c7a68); e.color1.set(0x30282a);
    e.alpha1 = 1; e.alphaPow = 0.3;
    e.layer = 'alpha';
    e.frame = FRAME.CHUNK; e.spin = 16; e.gravity = 26; e.drag = 0.35;
    this.particles.emit(e);

    // 5. Trailing embers that outlive the fireball.
    e = this._ep();
    e.count = 30; e.position.copy(pos); e.shell = r * 0.3;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 11 * s; e.speedVar = 0.9;
    e.life = 1.1; e.lifeVar = 0.6;
    e.size0 = 0.13 * s; e.size1 = 0.02;
    e.color0.set(0xffd07a); e.color1.set(0xff3a08);
    e.frame = FRAME.SPARK; e.stretch = 1.0;
    e.gravity = 15; e.drag = 1.3; e.turbulence = 0.4;
    this.particles.emit(e);

    // 6. Smoke column, the slowest layer, keeps the hit on screen for a second.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 20; e.position.copy(pos); e.shell = r * 0.3;
    e.dir.set(0, 1, 0); e.spread = 1.5;
    e.speed = 3.4 * s; e.speedVar = 0.8;
    e.life = 2.2; e.lifeVar = 0.45;
    e.size0 = r * 0.45; e.size1 = r * 1.5;
    e.color0.set(0x54504c); e.color1.set(0x1e1c1e);
    e.alpha0 = 0.5; e.frame = FRAME.SMOKE; e.spin = 1.1;
    e.drag = 1.6; e.gravity = -1.6; e.turbulence = 0.45; e.fadeIn = 0.12;
    this.particles.emit(e);

    this.decals.project(pos, DOWN, DECAL.SCORCH, { size: r * 0.8, maxDist: r + 3 });
    this.lights.flick(pos, colour, 60 * s, r * 2.5, 0.32);
    this._shakeAt(pos, clamp(0.05 + r * 0.018, 0.05, 0.3));
    this._hitstop(HITSTOP.explosion, true);
    if (this.ctx.pipeline) this.ctx.pipeline.aberration += 0.004 * s;
    this.ctx.audio?.explosion(pos, r);
  }

  /**
   * RoR2 monster death: the body burns away bottom-to-top behind an emissive
   * rim while embers peel off the dissolve front and rise.
   */
  deathDissolve(mesh, colour = 0xff6a1e) {
    if (!mesh?.isObject3D) return;
    _box.setFromObject(mesh);
    if (!isFinite(_box.min.y)) return;

    const bags = makeDissolvable(mesh, {
      color: colour,
      minY: _box.min.y,
      maxY: _box.max.y,
      scale: 4.5 / Math.max(0.5, _box.max.y - _box.min.y),
    });
    if (!bags.length) return;

    this._dissolving.push({
      mesh, bags, t: 0, dur: 0.85,
      minY: _box.min.y, maxY: _box.max.y,
      cx: (_box.min.x + _box.max.x) * 0.5,
      cz: (_box.min.z + _box.max.z) * 0.5,
      rx: Math.max(0.2, (_box.max.x - _box.min.x) * 0.5),
      rz: Math.max(0.2, (_box.max.z - _box.min.z) * 0.5),
      colour,
      emitAccum: 0,
    });
  }

  /** World-space arcing damage readout. Crits are bigger, hotter and shake. */
  damageNumber(pos, amount, crit = false) {
    this.numbers.spawn(pos, amount, crit);
  }

  levelUp(pos) {
    let e = this._ep();
    e.count = 1; e.position.copy(pos).add(_v1.set(0, 1, 0));
    e.life = 0.5; e.lifeVar = 0;
    e.size0 = 0.6; e.size1 = 5.5;
    e.color0.set(0xfff4c0); e.color1.set(0xffb020);
    e.alpha0 = 0.9; e.frame = FRAME.SHOCK; e.drag = 6; e.alphaPow = 1.5; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 46; e.position.copy(pos); e.jitter = 0.5;
    e.dir.set(0, 1, 0); e.spread = 0.45;
    e.speed = 9; e.speedVar = 0.7;
    e.life = 1.1; e.lifeVar = 0.4;
    e.size0 = 0.16; e.size1 = 0.01;
    e.color0.set(0xfff6d0); e.color1.set(0xffa018);
    e.frame = FRAME.SPARK; e.stretch = 0.8;
    e.gravity = -3.5; e.drag = 1.1; e.turbulence = 0.35;
    this.particles.emit(e);

    e = this._ep();
    e.count = 3; e.position.copy(pos).add(_v1.set(0, 0.9, 0));
    e.life = 0.55; e.lifeVar = 0.2;
    e.size0 = 2.2; e.size1 = 0.4;
    e.color0.set(0xffffff); e.color1.set(0xffc040);
    e.frame = FRAME.FLARE; e.spin = 3; e.drag = 6; e.soft = 0;
    this.particles.emit(e);

    this.rings.spawn(pos, UP, 0xffc850, 0.4, 4.5, 0.7, 0.85);
    this.lights.flick(pos, 0xffc040, 40, 12, 0.5);
    this.ctx.pipeline?.addShake(0.05);
    this.ctx.audio?.levelUp();
  }

  itemPickupBurst(pos, tierColour = 0xffffff) {
    let e = this._ep();
    e.count = 34; e.position.copy(pos).add(_v1.set(0, 0.6, 0)); e.shell = 0.25;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 5.5; e.speedVar = 0.8;
    e.life = 0.8; e.lifeVar = 0.4;
    e.size0 = 0.14; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(tierColour);
    e.frame = FRAME.SPARK; e.stretch = 0.7;
    e.gravity = -2.5; e.drag = 2.4; e.turbulence = 0.3;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos).add(_v1.set(0, 0.6, 0));
    e.life = 0.35; e.lifeVar = 0;
    e.size0 = 0.5; e.size1 = 3.0;
    e.color0.set(tierColour); e.color1.set(tierColour);
    e.alpha0 = 0.8; e.frame = FRAME.SHOCK; e.drag = 7; e.soft = 0;
    this.particles.emit(e);

    this.lights.flick(pos, tierColour, 22, 7, 0.28);
  }

  /**
   * Teleporter charge field. Safe to call every frame — internally rate-limited
   * so the caller can just forward the progress event.
   */
  teleporterAura(pos, progress = 0) {
    const p = clamp(progress, 0, 1);
    this._teleAccum += this._dt ?? 0;
    const interval = lerp(0.06, 0.016, p);
    if (this._teleAccum < interval) return;
    this._teleAccum = 0;

    const colour = _tmpColor.setHSL(lerp(0.55, 0.08, p), 0.85, 0.6).getHex();

    let e = this._ep();
    e.count = 5; e.position.copy(pos); e.shell = lerp(9, 2.5, p);
    e.dir.set(0, 1, 0); e.spread = 0.25;
    e.speed = lerp(3, 9, p); e.speedVar = 0.5;
    e.life = 1.3; e.lifeVar = 0.35;
    e.size0 = 0.14; e.size1 = 0.02;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 0.6;
    e.gravity = -2.2; e.drag = 0.9; e.turbulence = 0.5;
    this.particles.emit(e);

    e = this._ep();
    e.layer = 'alpha';
    e.count = 2; e.position.copy(pos); e.shell = 8;
    e.dir.set(0, 1, 0); e.spread = 0.6;
    e.speed = 1.6; e.life = 2.4; e.lifeVar = 0.4;
    e.size0 = 0.5; e.size1 = 2.2;
    e.color0.set(colour); e.color1.set(0x101018);
    e.alpha0 = 0.16; e.frame = FRAME.DUST;
    e.drag = 1.2; e.gravity = -0.8; e.turbulence = 0.5; e.fadeIn = 0.2;
    this.particles.emit(e);

    this._teleRing += interval;
    if (this._teleRing > 0.55) {
      this._teleRing = 0;
      this.rings.spawn(pos, UP, colour, 10.5, 1.0, 1.1, 0.55);
    }
  }

  /** Persistent elite shell. Returns a handle with .stop(). */
  eliteAura(mesh, type = 'blazing') {
    if (!mesh) return null;
    const def = ELITE[type] || ELITE.blazing;
    const h = { mesh, def, accum: 0, alive: true, stop() { this.alive = false; } };
    this._auras.push(h);
    return h;
  }

  /** Jagged chained bolt: segments + branch sparks + a light + a crackle. */
  lightning(from, to, colour = 0x9fd4ff) {
    const rng = this.ctx.rng;
    const segs = 8;
    _v1.subVectors(to, from);
    const len = _v1.length();
    if (len < 0.01) return;
    const jitter = clamp(len * 0.09, 0.15, 1.2);

    _v2.copy(from);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      _v3.copy(from).addScaledVector(_v1, t);
      if (i < segs) {
        _v3.x += (rng.next() * 2 - 1) * jitter;
        _v3.y += (rng.next() * 2 - 1) * jitter;
        _v3.z += (rng.next() * 2 - 1) * jitter;
      }
      _tmpColor.set(colour);
      this.beams.spawn(_v2, _v3, _tmpColor, 0.2, 0.02, 0.16, 0.6);
      this.beams.spawn(_v2, _v3, WHITE_HOT, 0.07, 0.008, 0.13, 3.0);

      const e = this._ep();
      e.count = 2; e.position.copy(_v3);
      e.dir.set(0, 1, 0); e.spread = Math.PI;
      e.speed = 5; e.speedVar = 0.9;
      e.life = 0.22; e.lifeVar = 0.5;
      e.size0 = 0.09; e.size1 = 0.01;
      e.color0.set(0xffffff); e.color1.set(colour);
      e.frame = FRAME.SPARK; e.stretch = 1.2; e.drag = 4; e.gravity = 4;
      this.particles.emit(e);

      _v2.copy(_v3);
    }

    this.lights.flick(to, colour, 26, 8, 0.12);
    this.hitSpark(to, colour, 0.9);
    this.ctx.audio?.zap(to);
  }

  healPop(pos, amount = 0) {
    let e = this._ep();
    e.count = 14; e.position.copy(pos); e.jitter = 0.3;
    e.dir.set(0, 1, 0); e.spread = 0.5;
    e.speed = 3.2; e.speedVar = 0.6;
    e.life = 0.7; e.lifeVar = 0.35;
    e.size0 = 0.16; e.size1 = 0.02;
    e.color0.set(0xc8ffd0); e.color1.set(0x22aa55);
    e.frame = FRAME.CROSS; e.spin = 3; e.gravity = -2.5; e.drag = 2.2;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.4; e.size0 = 0.4; e.size1 = 2.2;
    e.color0.set(0x8fffa8); e.color1.set(0x22aa55);
    e.alpha0 = 0.55; e.frame = FRAME.SHOCK; e.drag = 6; e.soft = 0;
    this.particles.emit(e);

    if (amount > 0) this.numbers.spawn(pos, amount, false, 0x7dff9a);
    this.ctx.audio?.heal(pos);
  }

  shieldBreak(pos) {
    let e = this._ep();
    e.count = 24; e.position.copy(pos); e.shell = 0.55;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 7.5; e.speedVar = 0.7;
    e.life = 0.6; e.lifeVar = 0.4;
    e.size0 = 0.18; e.size1 = 0.05;
    e.color0.set(0xffffff); e.color1.set(0x4fa8ff);
    e.frame = FRAME.HEX; e.spin = 10; e.gravity = 12; e.drag = 1.4;
    this.particles.emit(e);

    this.rings.spawn(pos, UP, 0x6fc0ff, 0.4, 3.4, 0.4, 0.9);
    this.lights.flick(pos, 0x6fc0ff, 24, 7, 0.18);
    this._shakeAt(pos, 0.035);
    this.ctx.audio?.shieldBreak(pos);
  }

  /** Ongoing status overlay on an entity, for `duration` seconds. */
  statusApplied(target, type = 'burn', duration) {
    const def = STATUS[type];
    if (!def || !target) return;
    const dur = duration ?? def.dur ?? 3;
    // Reapplying an existing status refreshes it rather than doubling the
    // particle rate — five stacks of burn should not be five times the smoke.
    for (const s of this._statuses) {
      if (s.target === target && s.type === type) { s.t = 0; s.dur = dur; return; }
    }
    this._statuses.push({ target, type, def, t: 0, dur, accum: 0 });
  }

  /** Combat's calling convention: (entity, type, colour). */
  status(entity, type, colour) {
    this.statusApplied(entity, type);
    if (colour === undefined) return;
    const s = this._statuses[this._statuses.length - 1];
    if (s && s.target === entity && s.type === type && s.t === 0) {
      // One-shot application pop in the status's own colour, so a fresh proc
      // reads distinctly from the ongoing overlay.
      const p = entity.position;
      if (!p) return;
      const e = this._ep();
      e.count = 8; e.position.copy(p); e.position.y += (entity.height ?? 1.6) * 0.5;
      e.shell = entity.radius ?? 0.5;
      e.dir.set(0, 1, 0); e.spread = Math.PI;
      e.speed = 3.5; e.speedVar = 0.7;
      e.life = 0.4; e.lifeVar = 0.4;
      e.size0 = 0.14; e.size1 = 0.01;
      e.color0.set(0xffffff); e.color1.set(colour);
      e.layer = s.def.alpha ? 'alpha' : 'add';
      e.frame = s.def.frame; e.spin = 6; e.drag = 3.5;
      this.particles.emit(e);
    }
  }

  /** Proc beam (chain lightning, seeking strikes): thicker and longer than a tracer. */
  beam(from, to, colour = 0x9fd8ff) {
    if (!from || !to) return;
    _tmpColor.set(colour);
    this.beams.spawn(from, to, _tmpColor, 0.3, 0.03, 0.26, 0.5);
    this.beams.spawn(from, to, WHITE_HOT, 0.1, 0.008, 0.2, 2.6);

    // Sparks at the receiving end are what make a chain read as "it hit that one".
    let e = this._ep();
    e.count = 8; e.position.copy(to);
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 6; e.speedVar = 0.8;
    e.life = 0.28; e.lifeVar = 0.5;
    e.size0 = 0.1; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.2; e.drag = 4; e.gravity = 5;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(to);
    e.life = 0.18; e.size0 = 0.7; e.size1 = 0.1;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.CROSS; e.drag = 8; e.alphaPow = 0.9; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    this.lights.flick(to, colour, 14, 5, 0.1);
  }

  /** Standalone AoE ring pulse (item procs that aren't explosions). */
  ring(pos, radius = 3, colour = 0xff7a2a) {
    if (!pos) return;
    this.rings.spawn(pos, UP, colour, radius * 0.12, radius, 0.42, 0.9);
    this.rings.spawn(pos, UP, 0xffffff, radius * 0.08, radius * 0.6, 0.26, 0.55);

    const e = this._ep();
    e.layer = 'alpha';
    e.count = 14; e.position.copy(pos); e.shell = radius * 0.2;
    e.dir.set(0, 0.25, 0); e.spread = 1.45;
    e.speed = radius * 2.2; e.speedVar = 0.6;
    e.life = 0.6; e.lifeVar = 0.4;
    e.size0 = 0.25; e.size1 = radius * 0.3;
    e.color0.set(colour); e.color1.set(0x1a1618);
    e.alpha0 = 0.35; e.frame = FRAME.DUST; e.spin = 2;
    e.drag = 3.2; e.turbulence = 0.3; e.fadeIn = 0.08;
    this.particles.emit(e);

    this.lights.flick(pos, colour, 18, radius * 1.8, 0.2);
    this._shakeAt(pos, clamp(0.015 + radius * 0.004, 0.015, 0.06));
  }

  /** Homing-strike streak: launch puff, travelling core, terminal spark. */
  missile(from, to, colour = 0xffa040) {
    if (!from || !to) return;
    _v1.subVectors(to, from);
    const dist = _v1.length();
    if (dist < 0.01) return;
    _v1.divideScalar(dist);
    const travel = clamp(dist / 45, 0.08, 0.5);

    // The "projectile" is one long-lived stretched particle flying the gap.
    let e = this._ep();
    e.count = 1; e.position.copy(from);
    e.dir.copy(_v1);
    e.speed = dist / travel; e.speedVar = 0;
    e.life = travel; e.lifeVar = 0;
    e.size0 = 0.45; e.size1 = 0.3; e.sizeVar = 0;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.6; e.drag = 0.001; e.alphaPow = 0.4; e.soft = 0;
    this.particles.emit(e);

    // Smoke laid along the flight path via delayed spawns.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 10; e.position.copy(from);
    e.dir.copy(_v1);
    e.speed = dist / travel * 0.55; e.speedVar = 0.35;
    e.life = 0.45; e.lifeVar = 0.4;
    e.size0 = 0.12; e.size1 = 0.5;
    e.color0.set(0x9a9188); e.color1.set(0x2c2a2c);
    e.alpha0 = 0.3; e.frame = FRAME.SMOKE; e.spin = 2;
    e.drag = 5; e.turbulence = 0.3; e.fadeIn = 0.1;
    this.particles.emit(e);

    e = this._ep();
    e.count = 6; e.position.copy(from);
    e.dir.copy(_v1); e.spread = 0.9;
    e.speed = 5; e.speedVar = 0.7;
    e.life = 0.2; e.lifeVar = 0.4;
    e.size0 = 0.12; e.size1 = 0.01;
    e.color0.set(0xfff0c0); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.0; e.drag = 3; e.gravity = 6;
    this.particles.emit(e);

    this.lights.flick(from, colour, 10, 4, 0.09);
    this.ctx.audio?.shoot(from, 0.7);
  }

  /** Damage fully negated: a hard metallic ring, no blood, no shake. */
  block(pos) {
    if (!pos) return;
    let e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.22; e.size0 = 0.3; e.size1 = 2.4;
    e.color0.set(0xffffff); e.color1.set(0xa8c8ff);
    e.alpha0 = 0.9; e.frame = FRAME.SHOCK; e.drag = 7; e.alphaPow = 1.3; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 12; e.position.copy(pos); e.shell = 0.3;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 7; e.speedVar = 0.8;
    e.life = 0.3; e.lifeVar = 0.5;
    e.size0 = 0.1; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(0x88b0ff);
    e.frame = FRAME.SPARK; e.stretch = 1.3; e.drag = 4; e.gravity = 14;
    this.particles.emit(e);

    this.lights.flick(pos, 0xbcd8ff, 14, 5, 0.1);
    this.ctx.audio?.impact(pos, 'metal');
  }

  /** Generic celebratory burst (teleporter completion, unlocks). */
  burst(pos, colour = 0xffffff) {
    this.itemPickupBurst(pos, colour);
    this.rings.spawn(pos, UP, colour, 0.5, 7, 0.7, 0.7);
    this._shakeAt(pos, 0.05);
  }

  /** Flash the struck entity's emissive white for ~60ms. */
  hitFlash(entity, colour = 0xffffff, duration = 0.06) {
    const obj = resolveObject(entity);
    if (!obj) return;

    let rec = obj.userData.__vfxFlash;
    if (!rec) {
      rec = { mats: [], base: [], colour: new THREE.Color(), t: 0, dur: 0.06 };
      obj.traverse((c) => {
        if (!c.isMesh || !c.material) return;
        const list = Array.isArray(c.material) ? c.material : [c.material];
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m.emissive) continue;
          // Clone once so flashing one enemy never lights up every enemy that
          // happens to share the prefab material.
          const cl = m.clone();
          if (Array.isArray(c.material)) c.material[i] = cl; else c.material = cl;
          rec.mats.push(cl);
          rec.base.push(cl.emissive.clone(), cl.emissiveIntensity ?? 1);
        }
      });
      obj.userData.__vfxFlash = rec;
    }
    if (!rec.mats.length) return;

    rec.colour.set(colour);
    for (let i = 0; i < rec.mats.length; i++) {
      const m = rec.mats[i];
      m.emissive.copy(rec.colour);
      m.emissiveIntensity = 3.2;
    }
    rec.t = 0;
    rec.dur = duration;
    if (this._flashes.indexOf(rec) < 0) this._flashes.push(rec);
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */

  _onDamage(p) {
    if (!p) return;
    const pos = p.position || p.target?.position;
    if (!pos) return;

    const target = p.target;
    const rel = target?.maxHealth ? clamp(p.amount / target.maxHealth, 0, 1) : 0.25;

    if (target?.isPlayer) {
      // Player-side: record the incoming direction for the HUD indicator.
      const src = p.source?.position;
      if (src && this.ctx.player?.position) {
        _h1.subVectors(src, this.ctx.player.position);
        _h1.y = 0;
        if (_h1.lengthSq() > 1e-6) {
          this._pushDamageDirection(src, clamp((p.amount / Math.max(1, target.maxHealth)) * 3, 0.25, 1));
        }
      }
      return;
    }

    _h1.copy(pos);
    if (p.source?.position) {
      _h2.subVectors(pos, p.source.position);
      if (_h2.lengthSq() < 1e-6) _h2.set(0, 1, 0);
    } else {
      _h2.set(0, 1, 0);
    }
    _h2.normalize();

    this.hitSpark(_h1, p.crit ? 0xffd24a : 0xffe9b0, p.crit ? 1.35 : 1);
    this.bloodHit(_h1, _h2, 0x9c0d18);
    this.hitFlash(target, p.crit ? 0xffe0a0 : 0xffffff, p.crit ? 0.09 : 0.06);
    this.damageNumber(_h1, p.amount, p.crit);

    const shake = clamp((p.crit ? 0.026 : 0.011) + rel * 0.05, 0.008, 0.075);
    this._shakeAt(_h1, shake);
    this._hitstop(p.crit ? HITSTOP.crit : HITSTOP.hit, p.crit);

    if (p.proc) this.lights.flick(_h1, 0xffd24a, 10, 3.5, 0.08);
  }

  _onKill(p) {
    if (!p) return;
    const pos = p.position || p.victim?.position;
    if (!pos) return;
    _h1.copy(pos);

    const obj = resolveObject(p.victim);
    if (obj) this.deathDissolve(obj, p.isElite ? 0xff9a30 : 0xff6a1e);

    const big = p.isBoss ? 2.2 : p.isElite ? 1.4 : 1;

    let e = this._ep();
    e.count = Math.round(18 * big); e.position.copy(_h1); e.shell = 0.35 * big;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 8 * big; e.speedVar = 0.8;
    e.life = 0.6; e.lifeVar = 0.5;
    e.size0 = 0.14 * big; e.size1 = 0.02;
    e.color0.set(0xffffff); e.color1.set(0xff5a20);
    e.frame = FRAME.SPARK; e.stretch = 1.2; e.gravity = 10; e.drag = 1.6;
    this.particles.emit(e);

    this.rings.spawn(_h1, UP, p.isElite ? 0xffa040 : 0xff7030, 0.3 * big, 3.2 * big, 0.45, 0.8);
    this.lights.flick(_h1, 0xff8030, 24 * big, 6 * big, 0.22);

    this._shakeAt(_h1, p.isBoss ? 0.22 : p.isElite ? 0.07 : 0.03);
    this._hitstop(p.isBoss ? HITSTOP.boss : p.isElite ? HITSTOP.elite : HITSTOP.kill, true);

    if (p.isBoss) this.explosion(_h1, 7, 0xffb040);
  }

  _onPlayerHurt(p) {
    const amount = p?.amount ?? 0;
    const remaining = p?.remaining ?? 1;
    const sev = clamp(amount / Math.max(1, this.ctx.player?.maxHealth ?? 100), 0.08, 1);

    const pipe = this.ctx.pipeline;
    if (pipe) {
      pipe.addShake(0.06 + sev * 0.16);
      pipe.aberration += 0.006 + sev * 0.02;
      // Low health leans harder on the vignette so the panic read is automatic.
      const lowHp = 1 - clamp(remaining / Math.max(1, this.ctx.player?.maxHealth ?? 100), 0, 1);
      pipe.vignetteBoost += 0.18 + sev * 0.35 + lowHp * 0.25;
    }
    this._hitstop(HITSTOP.playerHurt, true);

    const pp = this.ctx.player?.position;
    if (pp) {
      const e = this._ep();
      e.layer = 'alpha';
      e.count = 12; e.position.copy(pp); e.shell = 0.6;
      e.dir.set(0, 1, 0); e.spread = Math.PI;
      e.speed = 4; e.speedVar = 0.8;
      e.life = 0.5; e.lifeVar = 0.4;
      e.size0 = 0.12; e.size1 = 0.04;
      e.color0.set(0xb01020); e.color1.set(0x400408);
      e.frame = FRAME.BLOB; e.spin = 6; e.gravity = 18; e.drag = 1.2;
      this.particles.emit(e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feel primitives                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Distance-weighted shake. A kill across the map should not punch the camera
   * as hard as one at the player's feet, or sustained far-off combat turns the
   * whole screen into mush.
   */
  _shakeAt(pos, amount) {
    const cam = this.ctx.camera;
    if (!cam) return;
    const d2 = cam.position.distanceToSquared(pos);
    const f = 1 / (1 + d2 / (SHAKE_HALF_DIST * SHAKE_HALF_DIST));
    this.ctx.pipeline?.addShake(amount * f);
  }

  /**
   * `important` beats bypass the rate gate. Everything clamps to HITSTOP_MAX so
   * overlapping events can never compound into a visible hitch.
   */
  _hitstop(amount, important = false) {
    const ctx = this.ctx;
    if (!important && this.time - this._lastHitstop < HITSTOP_GATE) return;
    this._lastHitstop = this.time;
    ctx.hitstop = Math.min(HITSTOP_MAX, Math.max(ctx.hitstop, amount));
  }

  /* ------------------------------------------------------------------ */

  update(ctx, dt) {
    this.time += dt;
    this._dt = dt;

    this.particles.update(ctx, dt);
    this.trails.update(ctx, dt);
    this.decals.update(ctx, dt);
    this.lights.update(dt);
    this.beams.update(dt);
    this.rings.update(dt);
    this.numbers.update(ctx, dt);

    this._updateFlashes(dt);
    this._updateDissolves(dt);
    this._updateAuras(dt);
    this._updateStatuses(dt);
    this._updateDamageDirections(dt);

    if (this._teleProgress > 0) {
      const tp = ctx.progression?.teleporterPosition ?? ctx.stage?.teleporterPosition;
      if (tp) this.teleporterAura(tp, this._teleProgress);
    }
  }

  lateUpdate(ctx) {
    // Depth prepass for soft particles. Done as late as we can reach without
    // owning the render pipeline; the camera is at most one frame stale, which
    // is invisible at the fade distances used here.
    this.particles.renderDepth(ctx, this._roots);
  }

  _updateFlashes(dt) {
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const rec = this._flashes[i];
      rec.t += dt;
      const k = rec.t / rec.dur;
      if (k >= 1) {
        for (let j = 0; j < rec.mats.length; j++) {
          rec.mats[j].emissive.copy(rec.base[j * 2]);
          rec.mats[j].emissiveIntensity = rec.base[j * 2 + 1];
        }
        this._flashes.splice(i, 1);
        continue;
      }
      // Quadratic falloff: a linear decay on a 60ms flash is short enough that
      // it reads as a step, not as a flash.
      const f = 1 - k * k;
      for (let j = 0; j < rec.mats.length; j++) {
        rec.mats[j].emissive.lerpColors(rec.base[j * 2], rec.colour, f);
        rec.mats[j].emissiveIntensity = lerp(rec.base[j * 2 + 1], 3.2, f);
      }
    }
  }

  _updateDissolves(dt) {
    for (let i = this._dissolving.length - 1; i >= 0; i--) {
      const d = this._dissolving[i];
      d.t += dt;
      const k = clamp(d.t / d.dur, 0, 1);
      for (const bag of d.bags) bag.uDissolve.value = k;

      // Embers peel off the dissolve front, not off the whole body.
      d.emitAccum += dt;
      if (d.emitAccum > 0.02 && k < 1) {
        d.emitAccum = 0;
        const frontY = lerp(d.minY - 0.1, d.maxY + 0.1, k);
        const e = this._ep();
        e.count = 4;
        e.position.set(d.cx, frontY, d.cz);
        e.jitter = 0;
        e.shell = 0;
        e.dir.set(0, 1, 0); e.spread = 0.55;
        e.speed = 1.6; e.speedVar = 0.7;
        e.life = 1.2; e.lifeVar = 0.5;
        e.size0 = 0.09; e.size1 = 0.01;
        e.color0.set(0xfff0c0); e.color1.set(d.colour);
        e.frame = FRAME.EMBER;
        e.gravity = -1.6; e.drag = 1.0; e.turbulence = 0.5;
        // Spread the spawn across the silhouette footprint.
        e.position.x += (this.ctx.rng.next() * 2 - 1) * d.rx;
        e.position.z += (this.ctx.rng.next() * 2 - 1) * d.rz;
        this.particles.emit(e);
      }

      if (k >= 1) {
        d.mesh.visible = false;
        for (const bag of d.bags) bag.uDissolve.value = 1;
        this._dissolving.splice(i, 1);
      }
    }
  }

  _updateAuras(dt) {
    for (let i = this._auras.length - 1; i >= 0; i--) {
      const a = this._auras[i];
      const m = a.mesh;
      if (!a.alive || !m || !m.parent || m.visible === false) {
        this._auras.splice(i, 1);
        continue;
      }
      a.accum += dt;
      const interval = 1 / a.def.rate;
      if (a.accum < interval) continue;
      const bursts = Math.min(4, Math.floor(a.accum / interval));
      a.accum -= bursts * interval;

      m.getWorldPosition(_v1);
      const e = this._ep();
      e.count = bursts * 2;
      e.position.copy(_v1); e.shell = 0.55;
      e.dir.set(0, a.def.rise >= 0 ? 1 : -1, 0); e.spread = 1.1;
      e.speed = Math.abs(a.def.rise) * 2.2 + 0.6; e.speedVar = 0.7;
      e.life = 0.8; e.lifeVar = 0.5;
      e.size0 = 0.15; e.size1 = 0.02;
      e.color0.set(a.def.tip); e.color1.set(a.def.color);
      e.frame = a.def.frame;
      e.stretch = a.def.frame === FRAME.SPARK ? 1.1 : 0;
      e.spin = 5;
      e.gravity = -a.def.rise * 0.6; e.drag = 1.5; e.turbulence = 0.45;
      this.particles.emit(e);
    }
  }

  _updateStatuses(dt) {
    for (let i = this._statuses.length - 1; i >= 0; i--) {
      const s = this._statuses[i];
      s.t += dt;
      const target = s.target;
      if (s.t >= s.dur || !target || target.alive === false) {
        this._statuses.splice(i, 1);
        continue;
      }
      s.accum += dt;
      const interval = 1 / s.def.rate;
      if (s.accum < interval) continue;
      s.accum = 0;
      const p = target.position;
      if (!p) continue;
      const h = target.height ?? 1.6;
      const r = target.radius ?? 0.5;

      const e = this._ep();
      e.count = 2;
      e.layer = s.def.alpha ? 'alpha' : 'add';
      e.position.copy(p); e.position.y += h * 0.4;
      e.shell = r;
      e.dir.set(0, s.def.rise >= 0 ? 1 : -1, 0); e.spread = 0.7;
      e.speed = Math.abs(s.def.rise) * 1.6 + 0.4; e.speedVar = 0.6;
      e.life = 0.55; e.lifeVar = 0.4;
      e.size0 = 0.13; e.size1 = 0.01;
      e.color0.set(s.def.tip); e.color1.set(s.def.color);
      e.frame = s.def.frame;
      e.stretch = s.def.frame === FRAME.SPARK ? 1.0 : 0;
      e.spin = 6; e.gravity = -s.def.rise * 0.8; e.drag = 2.0; e.turbulence = 0.4;
      this.particles.emit(e);
    }
  }

  /**
   * Records where a hit came from. Entries are recycled from a fixed pool and
   * expose `angle` (radians, camera-relative, 0 = dead ahead) plus `alpha`,
   * which is the shape the HUD reads.
   */
  _pushDamageDirection(sourcePos, strength) {
    const list = this.damageDirections;
    const e = this._dirPool[this._dirCursor];
    this._dirCursor = (this._dirCursor + 1) % this._dirPool.length;
    const existing = list.indexOf(e);
    if (existing >= 0) list.splice(existing, 1);
    e.pos.copy(sourcePos);
    e.t = 0;
    e.life = 1.2;
    e.strength = strength;
    e.alpha = strength;
    e.angle = 0;
    list.push(e);
    if (list.length > 6) list.shift();
  }

  /**
   * Recomputed every frame rather than latched at hit time: the indicator has
   * to keep pointing at the attacker while the player turns, or it is worse
   * than useless.
   */
  _updateDamageDirections(dt) {
    const list = this.damageDirections;
    if (!list.length) return;
    const cam = this.ctx.camera;
    const origin = this.ctx.player?.position;
    let fx = 0, fz = -1;
    if (cam) {
      cam.getWorldDirection(_v1);
      const l = Math.hypot(_v1.x, _v1.z) || 1;
      fx = _v1.x / l; fz = _v1.z / l;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      d.t += dt;
      if (d.t >= d.life) { list.splice(i, 1); continue; }
      d.alpha = d.strength * (1 - d.t / d.life);
      if (origin) {
        const dx = d.pos.x - origin.x, dz = d.pos.z - origin.z;
        d.angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
      }
    }
  }

  /** Reset the shared emit-options scratch to defaults. Never allocates. */
  _ep() {
    const e = this._e;
    e.layer = 'add';
    e.count = 1;
    e.position = this._ep0.set(0, 0, 0);
    e.jitter = 0; e.shell = 0;
    e.dir = this._ed0.set(0, 1, 0);
    e.spread = 0; e.speed = 0; e.speedVar = 0.3;
    e.inherit = null;
    e.life = 0.5; e.lifeVar = 0.25;
    e.size0 = 0.2; e.size1 = 0; e.sizeVar = 0.3;
    e.color0 = this._ec0.setRGB(1, 1, 1);
    e.color1 = this._ec1.setRGB(1, 1, 1);
    e.alpha0 = 1; e.alpha1 = 0;
    e.drag = 1.2; e.gravity = 0; e.turbulence = 0; e.stretch = 0;
    e.frame = FRAME.SOFT; e.frameVar = 0; e.spin = 0; e.soft = 0.6;
    e.fadeIn = 0.06; e.alphaPow = 1.4; e.delay = 0;
    return e;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const WHITE_HOT = new THREE.Color(0xffffff);

/**
 * Entities carry their scene node under any of half a dozen names, and some —
 * the player's `CharacterMesh` — hang a plain wrapper off `.mesh` whose real
 * node is `.group`. Anything that isn't an Object3D is not a scene node, so
 * never hand it back: the callers feed it straight to Three.js.
 */
function resolveObject(entity) {
  if (!entity) return null;
  if (entity.isObject3D) return entity;
  const c = entity.mesh;
  if (c?.isObject3D) return c;
  return firstObject3D(c?.group, c?.root, c?.object3D, entity.group, entity.root,
    entity.object3d, entity.object3D, entity.object);
}

function firstObject3D(...candidates) {
  for (const c of candidates) if (c?.isObject3D) return c;
  return null;
}

/* ==================================================================== */
/* Pooled sub-effects                                                    */
/* ==================================================================== */

/**
 * A fixed set of point lights, added at boot and never added or removed after.
 * Adding a light at runtime recompiles every material in the scene, so the pool
 * lives at intensity 0 and is simply repositioned.
 */
class LightPool {
  constructor(ctx, count) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.castShadow = false;
      l.visible = false;
      ctx.scene.add(l);
      this.lights.push({ light: l, t: 0, dur: 0, peak: 0 });
    }
    this.cursor = 0;
  }

  flick(pos, colour, intensity, distance, duration) {
    // Round-robin; a stolen light is always the oldest one.
    let best = this.lights[this.cursor];
    for (const e of this.lights) {
      if (e.t >= e.dur) { best = e; break; }
    }
    this.cursor = (this.cursor + 1) % this.lights.length;
    best.light.position.copy(pos);
    best.light.color.set(colour);
    best.light.distance = distance;
    best.light.visible = true;
    best.peak = intensity;
    best.t = 0;
    best.dur = duration;
    best.light.intensity = intensity;
  }

  update(dt) {
    for (const e of this.lights) {
      if (e.t >= e.dur) continue;
      e.t += dt;
      const k = clamp(e.t / e.dur, 0, 1);
      // Sharp attack, exponential-ish decay — a linear fade reads as a lamp
      // being turned down rather than as a flash.
      const f = (1 - k) * (1 - k) * (1 - k);
      e.light.intensity = e.peak * f;
      if (k >= 1) { e.light.intensity = 0; e.light.visible = false; }
    }
  }
}

const BeamVert = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec2 aTime;
attribute vec4 aColor;
attribute vec4 aShape;  // width0, width1, core, unused
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying float vCore;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0); vCore = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  vec3 p = mix(aFrom, aTo, uv.y);
  vec3 axis = aTo - aFrom;
  float len = length(axis);
  axis = len > 0.00001 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 toCam = cameraPosition - p;
  vec3 side = cross(axis, toCam);
  float sl = length(side);
  side = sl > 0.00001 ? side / sl : vec3(1.0, 0.0, 0.0);
  float w = mix(aShape.x, aShape.y, k);
  p += side * (uv.x - 0.5) * w;
  vUv = uv;
  vColor = aColor;
  vColor.a *= pow(1.0 - k, 1.7);
  vCore = aShape.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const BeamFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
varying float vCore;
void main() {
  float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float soft = smoothstep(0.0, 0.7, edge);
  float core = pow(edge, 10.0) * vCore;
  float ends = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y);
  float a = vColor.a * (soft + core) * ends;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * (soft + core * 1.6), a);
}
`;

/** Instanced camera-facing segments: tracers, lightning links, beam FX. */
class BeamPool {
  constructor(ctx, capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aFrom = inst(capacity, 3);
    this.aTo = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aColor = inst(capacity, 4);
    this.aShape = inst(capacity, 4);
    geo.setAttribute('aFrom', this.aFrom);
    geo.setAttribute('aTo', this.aTo);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aShape', this.aShape);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BeamVert,
      fragmentShader: BeamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.beams';
    ctx.scene.add(this.mesh);
  }

  spawn(from, to, color, width0, width1, life, core) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const f = this.aFrom.array, t = this.aTo.array;
    f[i * 3] = from.x; f[i * 3 + 1] = from.y; f[i * 3 + 2] = from.z;
    t[i * 3] = to.x; t[i * 3 + 1] = to.y; t[i * 3 + 2] = to.z;
    this.aTime.array[i * 2] = this.time;
    this.aTime.array[i * 2 + 1] = life;
    const c = this.aColor.array;
    c[i * 4] = color.r; c[i * 4 + 1] = color.g; c[i * 4 + 2] = color.b; c[i * 4 + 3] = 1;
    const s = this.aShape.array;
    s[i * 4] = width0; s[i * 4 + 1] = width1; s[i * 4 + 2] = core; s[i * 4 + 3] = 0;
    this.dirty = true;
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (!this.dirty) return;
    this.dirty = false;
    this.aFrom.needsUpdate = this.aTo.needsUpdate = this.aTime.needsUpdate = true;
    this.aColor.needsUpdate = this.aShape.needsUpdate = true;
  }
}

const RingVert = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aAxis;
attribute vec2 aTime;
attribute vec4 aColor;
attribute vec4 aShape;  // r0, r1, thickness, unused
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying float vK;
varying float vThick;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0); vK = 0.0; vThick = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  // Ease-out expansion: shockwaves are fastest in the first few frames.
  float e = 1.0 - pow(1.0 - k, 2.6);
  float r = mix(aShape.x, aShape.y, e);

  vec3 n = normalize(aAxis);
  vec3 t1 = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 bx = normalize(cross(n, t1));
  vec3 by = normalize(cross(n, bx));
  vec3 p = aOrigin + (bx * position.x + by * position.y) * (r * 2.0);

  vUv = uv;
  vColor = aColor;
  vK = k;
  vThick = aShape.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const RingFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
varying float vK;
varying float vThick;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float d = r - 0.86;
  // The ring thins as it grows, which is what sells conservation of energy.
  float th = mix(vThick, vThick * 0.12, vK);
  float ring = 1.0 - smoothstep(0.0, th, abs(d));
  ring = pow(ring, 1.6);
  float fill = (1.0 - smoothstep(0.0, 0.86, r)) * 0.1 * (1.0 - vK);
  // Hot inner edge, cooler outer edge — a flat-coloured ring reads as a decal.
  vec3 col = mix(vColor.rgb * 1.6, vColor.rgb * 0.6, smoothstep(-th, th, d));
  float a = (ring + fill) * vColor.a * pow(1.0 - vK, 1.2);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col * (ring + fill), a);
}
`;

/** Instanced expanding shockwave rings. */
class RingPool {
  constructor(ctx, capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aOrigin = inst(capacity, 3);
    this.aAxis = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aColor = inst(capacity, 4);
    this.aShape = inst(capacity, 4);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aAxis', this.aAxis);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aShape', this.aShape);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: RingVert,
      fragmentShader: RingFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.rings';
    ctx.scene.add(this.mesh);
  }

  spawn(origin, axis, colour, r0, r1, life, alpha = 1) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const o = this.aOrigin.array, a = this.aAxis.array;
    o[i * 3] = origin.x; o[i * 3 + 1] = origin.y + 0.06; o[i * 3 + 2] = origin.z;
    a[i * 3] = axis.x; a[i * 3 + 1] = axis.y; a[i * 3 + 2] = axis.z;
    this.aTime.array[i * 2] = this.time;
    this.aTime.array[i * 2 + 1] = life;
    _tmpColor.set(colour);
    const c = this.aColor.array;
    c[i * 4] = _tmpColor.r; c[i * 4 + 1] = _tmpColor.g;
    c[i * 4 + 2] = _tmpColor.b; c[i * 4 + 3] = alpha;
    const s = this.aShape.array;
    s[i * 4] = r0; s[i * 4 + 1] = r1; s[i * 4 + 2] = 0.22; s[i * 4 + 3] = 0;
    this.dirty = true;
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (!this.dirty) return;
    this.dirty = false;
    this.aOrigin.needsUpdate = this.aAxis.needsUpdate = this.aTime.needsUpdate = true;
    this.aColor.needsUpdate = this.aShape.needsUpdate = true;
  }
}

const NumberVert = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec2 aTime;
attribute vec4 aGlyph;   // char index, column offset, half-width in chars, scale
attribute vec4 aColor;
uniform float uTime;
uniform float uAtlasCols;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  // Ballistic arc, then a slow drift as it fades.
  vec3 wp = aOrigin + aVel * age + vec3(0.0, -4.5, 0.0) * age * age * 0.5;
  vec4 mv = viewMatrix * vec4(wp, 1.0);

  // Overshoot pop on the first ~12% of life, then settle.
  float pop = 1.0 + 0.55 * exp(-k * 26.0) - 0.25 * smoothstep(0.0, 0.12, k);
  float scale = aGlyph.w * pop;
  float cw = 0.62;
  vec2 corner = vec2(
    (position.x + (aGlyph.y - aGlyph.z) * cw) * scale,
    position.y * scale
  );
  mv.xy += corner;

  vUv = (uv + vec2(mod(aGlyph.x, uAtlasCols), floor(aGlyph.x / uAtlasCols))) / uAtlasCols;
  vColor = aColor;
  vColor.a *= smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.55, 1.0, k));
  gl_Position = projectionMatrix * mv;
}
`;

const NumberFrag = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  // The atlas stores the glyph in .r and its outline in .g, so one texture
  // gives coloured text with a dark keyline that survives any background.
  vec3 col = mix(vec3(0.02), vColor.rgb, t.r);
  gl_FragColor = vec4(col, a);
}
`;

const GLYPHS = '0123456789!+-x%';

/**
 * World-space damage readout. Text is a 4x4 canvas atlas of glyphs and each
 * digit is one instance, so a number costs a handful of float writes and the
 * whole arc/pop/fade animation runs on the GPU.
 */
class DamageNumbers {
  constructor(ctx, capacity) {
    this.ctx = ctx;
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;
    this._buf = new Array(8);

    const map = makeGlyphAtlas();
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aOrigin = inst(capacity, 3);
    this.aVel = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aGlyph = inst(capacity, 4);
    this.aColor = inst(capacity, 4);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aGlyph', this.aGlyph);
    geo.setAttribute('aColor', this.aColor);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uTime: { value: 0 },
        uAtlasCols: { value: 4 },
      },
      vertexShader: NumberVert,
      fragmentShader: NumberFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.damageNumbers';
    ctx.scene.add(this.mesh);
  }

  spawn(pos, amount, crit, colour) {
    const n = Math.max(1, Math.round(amount));
    const chars = this._buf;
    let len = 0;
    let v = n;
    // Digits back-to-front into the scratch buffer; no string allocation.
    while (v > 0 && len < 7) { chars[len++] = v % 10; v = (v / 10) | 0; }
    if (len === 0) chars[len++] = 0;
    // Reverse in place.
    for (let i = 0; i < len >> 1; i++) {
      const t = chars[i]; chars[i] = chars[len - 1 - i]; chars[len - 1 - i] = t;
    }
    if (crit) chars[len++] = 10; // '!'

    const rng = this.ctx.rng;
    const half = len * 0.5 - 0.5;
    const scale = crit ? 0.62 : 0.38;
    _tmpColor.set(colour ?? (crit ? 0xffc23a : 0xfff2d8));

    const vx = (rng.next() * 2 - 1) * 1.1;
    const vy = crit ? 3.6 : 2.9;
    const vz = (rng.next() * 2 - 1) * 1.1;
    const life = crit ? 1.25 : 1.0;

    for (let i = 0; i < len; i++) {
      const idx = this.head;
      this.head = (this.head + 1) % this.capacity;
      const o = this.aOrigin.array, vv = this.aVel.array;
      o[idx * 3] = pos.x; o[idx * 3 + 1] = pos.y + 0.6; o[idx * 3 + 2] = pos.z;
      vv[idx * 3] = vx; vv[idx * 3 + 1] = vy; vv[idx * 3 + 2] = vz;
      this.aTime.array[idx * 2] = this.time;
      this.aTime.array[idx * 2 + 1] = life;
      const g = this.aGlyph.array;
      g[idx * 4] = chars[i];
      g[idx * 4 + 1] = i;
      g[idx * 4 + 2] = half;
      g[idx * 4 + 3] = scale;
      const c = this.aColor.array;
      c[idx * 4] = _tmpColor.r; c[idx * 4 + 1] = _tmpColor.g;
      c[idx * 4 + 2] = _tmpColor.b; c[idx * 4 + 3] = 1;
    }
    this.dirty = true;
  }

  update(ctx, dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (!this.dirty) return;
    this.dirty = false;
    this.aOrigin.needsUpdate = this.aVel.needsUpdate = this.aTime.needsUpdate = true;
    this.aGlyph.needsUpdate = this.aColor.needsUpdate = true;
  }

  resize() { /* atlas is resolution-independent; nothing to do */ }
}

function inst(capacity, size) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

function makeGlyphAtlas() {
  const tile = 128;
  const cols = 4;
  const cv = document.createElement('canvas');
  cv.width = cv.height = tile * cols;
  const g = cv.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (let i = 0; i < GLYPHS.length; i++) {
    const ch = GLYPHS[i];
    const x = (i % cols) * tile + tile * 0.5;
    const y = Math.floor(i / cols) * tile + tile * 0.5;
    g.font = 'bold 96px "Arial Black", Impact, sans-serif';
    // Alpha carries the silhouette (glyph + outline); red carries the fill mask
    // so the shader can tint the body and keep the keyline black.
    g.lineJoin = 'round';
    g.lineWidth = 16;
    g.strokeStyle = 'rgba(0,0,0,1)';
    g.strokeText(ch, x, y);
    g.fillStyle = 'rgba(255,0,0,1)';
    g.fillText(ch, x, y);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
