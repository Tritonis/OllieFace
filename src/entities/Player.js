import * as THREE from 'three';
import { clamp, damp } from '../core/MathUtil.js';
import { CharacterMesh } from './CharacterMesh.js';
import { ProjectilePool } from './Projectile.js';
import { ABILITIES, SLOT_ORDER, effectiveCooldown } from '../data/abilities.js';
import { BTN } from '../net/Protocol.js';

/**
 * The survivor: kinematic capsule + loadout + the damageable entity.
 *
 * All gameplay integrates in fixedUpdate at 60Hz through
 * `ctx.stage.capsuleResolve`. `update` is presentation only (mesh animation,
 * projectile mesh orientation).
 *
 * The 60Hz step lives in `applyCommand(cmd, dt)` and reads nothing but `cmd`,
 * `this` and world queries. `fixedUpdate` samples local input into a command
 * once and hands it over. That split is what makes the step replayable: a
 * networked client re-runs its unacked commands after every correction, and a
 * step that peeked at live input or a live camera would land somewhere other
 * than where it originally predicted — permanent jitter.
 *
 * Every number that an item could plausibly modify is read out of
 * `ctx.items.stats(BASE)` each step — nothing downstream reads BASE directly.
 */

const BASE = {
  maxHealth: 110,
  healthRegen: 1.0,
  moveSpeed: 7,
  attackSpeed: 1,
  damage: 12,
  critChance: 0.01, // fraction, not percent — Items clamps this to 1
  critMult: 2,
  armor: 0,
  cooldownMult: 1,
  jumpCount: 1,
};

const RADIUS = 0.45;
const HEIGHT = 1.8;
const EYE = 1.6;

const GRAVITY = 26;
// sqrt(2*g*h): 12.6 m/s clears ~3.05 m. Nominal airtime is ~0.97s, but the
// apex-hang multiplier below stretches the top of the arc so it *plays* at
// around 1.4s — long enough to aim from, short enough to feel deliberate.
const JUMP_SPEED = 12.6;
const AIR_JUMP_SPEED = 12.0;
const G_RISE = 1.0;
const G_RISE_RELEASED = 2.15;  // variable jump height: let go early, come down early
const G_APEX = 0.5;            // |vy| < APEX_BAND — the float that makes air control readable
const G_FALL = 1.12;           // fall faster than you rose, so landings have weight
const APEX_BAND = 3.4;
const TERMINAL = 55;

const GROUND_ACCEL = 68;   // ~0.10s to top speed — responsiveness wins over weight
const GROUND_DECEL = 86;
const AIR_CONTROL = 0.35;
const AIR_DECEL = 7;
const SPRINT_MULT = 1.45;

const COYOTE = 0.12;
const JUMP_BUFFER = 0.15;

const DASH_SPEED = 22;
const DASH_TIME = 0.24;
const DASH_IFRAMES = 0.32;
const FIRE_LOCK = 0.4;     // sprint stays disabled this long after a shot

const REGEN_DELAY = 1.2;

const MAX_SCHEDULED = 32;

// Stand-in when the host has no command to feed a starved pawn.
const IDLE_CMD = { tick: 0, moveX: 0, moveZ: 0, buttons: 0, yaw: 0, pitch: 0 };

let NEXT_ID = 1;

export class Player {
  init(ctx) {
    ctx.player = this;
    this.ctx = ctx;

    // --- entity contract ---
    this.id = `player-${NEXT_ID++}`;
    this.isPlayer = true;
    this.team = 'player';
    this.alive = true;
    this.radius = RADIUS;
    this.height = HEIGHT;
    this.position = new THREE.Vector3(0, 2, 0);
    this.velocity = new THREE.Vector3();

    this.stats = { ...BASE };
    this.maxHealth = BASE.maxHealth;
    this.health = BASE.maxHealth;
    // `shield` is the decaying barrier Items grants and ticks down; Player only
    // reports the cap so the HUD has something to draw against.
    this.shield = 0;
    this.maxShield = BASE.maxHealth * 0.5;
    this.sinceDamage = 99;
    // Read by Combat.applyDamage: a mercy window so one blast can't multi-hit.
    this.iframeDuration = 0.1;
    this._iframeUntil = 0;

    // --- movement state ---
    this.grounded = false;
    this.wasGrounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpsUsed = 0;
    this.horizontalSpeed = 0;
    this.moving = false;
    this.sprinting = false;
    this.sprintBlend = 0;
    this.fireLock = 0;

    this.dashTime = 0;
    this.dashT = 0;
    this.dashRoll = 0;
    this.dashDirection = new THREE.Vector3(0, 0, 1);
    this.iframes = 0;

    this.recoilPending = 0;
    this.recoilAccum = 0;
    this._dashTrail = null;

    // --- network interface state ---
    // Reused so the local path allocates nothing; only the wire path (which
    // builds its own commands) ever retains one.
    this._cmd = { tick: 0, moveX: 0, moveZ: 0, buttons: 0, yaw: 0, pitch: 0 };
    this.lastCommand = null;      // NetHost repeats this when a client starves
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.yaw = 0;                 // snapshot field
    this._localTick = 0;
    this._lastCmdTick = 0;
    this._prevButtons = 0;
    this._replaying = false;
    this.interactPressed = false;
    this._renderOffset = new THREE.Vector3();

    // --- loadout ---
    // Field names here are the HUD's read contract: `cooldown` is the full
    // duration, `cd` the remainder, plus charges/maxCharges/name.
    this.slots = SLOT_ORDER.map((slot) => {
      const a = ABILITIES[slot];
      return {
        slot, ability: a, name: a.name, description: a.description, key: a.key,
        charges: a.charges, maxCharges: a.charges,
        cd: 0, cdMax: a.cooldown, cooldown: a.cooldown,
      };
    });
    this.abilities = this.slots;
    this.slotBySlot = {};
    for (const s of this.slots) this.slotBySlot[s.slot] = s;

    // Fixed-size deferred-call ring: multi-shot abilities need sub-step timing
    // without allocating a closure array every trigger.
    this._sched = new Array(MAX_SCHEDULED);
    for (let i = 0; i < MAX_SCHEDULED; i++) this._sched[i] = { t: 0, fn: null };

    this.projectiles = new ProjectilePool(ctx);

    this.mesh = new CharacterMesh();
    // `mesh` is the rig wrapper, not a scene node. Anything generic that wants
    // the player's Object3D (VFX hit flashes, death dissolve) reads `group`.
    this.group = this.mesh.group;
    ctx.scene.add(this.group);

    // Scratch — nothing in the hot path allocates.
    this._wish = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._horiz = new THREE.Vector3();
    this._diff = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this._camDir = new THREE.Vector3(0, 0, 1);
    this._aimRay = { origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), point: new THREE.Vector3() };
    this._fireRay = { origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1) };
    this._meshState = {
      velocity: this.velocity, grounded: false, aimYaw: 0, aimPitch: 0,
      dashT: 0, sprint: false, moveSpeed: BASE.moveSpeed,
    };

    ctx.combat?.register?.(this);

    // Drop onto the stage if it can tell us where the floor is.
    const y = ctx.stage?.sampleHeight?.(0, 0);
    if (typeof y === 'number' && isFinite(y)) this.position.set(0, y + 0.2, 0);
  }

  // ---------------------------------------------------------------- gameplay

  fixedUpdate(ctx, h) {
    // On a client, NetClient owns this pawn's stepping — it has to tag each
    // command with its own tick and keep it for replay. Stepping here as well
    // would run the simulation at double rate.
    if (ctx.netRole !== 'client') this.applyCommand(this._sampleCommand(ctx), h);
    // Recoil moves the camera rig, never the simulation, so it sits outside the
    // replayable step — otherwise a correction would kick the view again for
    // every shot it re-ran.
    this._applyRecoil(ctx, h);
  }

  /** Collapse this frame's live input and camera into one command. */
  _sampleCommand(ctx) {
    const cmd = this._cmd;
    const input = ctx.input;
    const usable = !!input && input.enabled !== false;

    if (usable) {
      const axis = input.moveAxis();
      cmd.moveX = axis.x;
      cmd.moveZ = axis.z;
      let b = 0;
      if (input.down('Space')) b |= BTN.JUMP;
      if (input.down('ShiftLeft')) b |= BTN.SPRINT;
      if (input.mouse.left) b |= BTN.FIRE;
      if (input.mouse.right) b |= BTN.SECONDARY;
      if (input.down('KeyQ')) b |= BTN.UTILITY;
      if (input.down('KeyR')) b |= BTN.SPECIAL;
      if (input.down('KeyE')) b |= BTN.INTERACT;
      cmd.buttons = b;
    } else {
      cmd.moveX = 0;
      cmd.moveZ = 0;
      cmd.buttons = 0;
    }

    const rig = ctx.cameraRig;
    if (rig) {
      cmd.yaw = rig.yaw;
      cmd.pitch = rig.pitch;
    } else {
      ctx.camera.getWorldDirection(this._camDir);
      cmd.yaw = Math.atan2(this._camDir.x, this._camDir.z);
      cmd.pitch = Math.asin(clamp(this._camDir.y, -1, 1));
    }
    cmd.tick = ++this._localTick;
    return cmd;
  }

  /**
   * One 60Hz movement + ability step, driven purely by `cmd`, `this` and world
   * queries. This is the method `NetClient` replays and `NetHost` feeds from
   * the wire, so nothing in here may read live input or a live camera.
   */
  applyCommand(cmd, dt) {
    const ctx = this.ctx;
    const c = cmd || this.lastCommand || IDLE_CMD;

    // A tick we have already simulated means either a client replaying after a
    // correction or the host repeating a starved command. Movement must re-run
    // identically; one-shot effects (projectiles, scheduled volleys, VFX) must
    // not fire twice.
    const replay = c.tick > 0 && c.tick <= this._lastCmdTick;
    this._replaying = replay;

    this.stats = ctx.items?.stats?.(BASE) || { ...BASE };
    this.maxHealth = this.stats.maxHealth;
    this.maxShield = this.maxHealth * 0.5;
    if (this.health > this.maxHealth) this.health = this.maxHealth;

    if (!replay) this._runSchedule(dt);
    this._tickTimers(dt);
    this._tickCooldowns(dt);

    const buttons = c.buttons | 0;
    const pressed = buttons & ~this._prevButtons;

    if (!this.alive) {
      this.velocity.y -= GRAVITY * dt;
      this._resolve(ctx, dt);
      this._commit(c, buttons, 0);
      return;
    }

    this._aim(c);
    this._abilities(ctx, buttons, pressed);
    this._move(ctx, dt, c, buttons, pressed);
    this._resolve(ctx, dt);
    this._land(ctx);
    this._regen(ctx, dt);

    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!replay) this.projectiles.fixedUpdate(ctx, dt);

    this._commit(c, buttons, pressed);
  }

  _commit(cmd, buttons, pressed) {
    // The interact bit is a request, not an action — Interactables resolves it,
    // and only where authority allows.
    this.interactPressed = (pressed & BTN.INTERACT) !== 0;
    this._prevButtons = buttons;
    if (cmd.tick > this._lastCmdTick) this._lastCmdTick = cmd.tick;
    this.lastCommand = cmd;
    this._replaying = false;
  }

  _tickTimers(h) {
    this.sinceDamage += h;
    if (this.iframes > 0) this.iframes -= h;
    if (this.fireLock > 0) this.fireLock -= h;
    if (this.jumpBuffer > 0) this.jumpBuffer -= h;
    if (this.grounded) this.coyote = COYOTE; else if (this.coyote > 0) this.coyote -= h;

    if (this.dashTime > 0) {
      this.dashTime -= h;
      if (this.dashTime <= 0) {
        this.dashTime = 0;
        // Exit at a controllable speed rather than dumping all momentum —
        // dash-into-run should keep flowing.
        const s = Math.hypot(this.velocity.x, this.velocity.z);
        const keep = Math.min(s, this.stats.moveSpeed * 1.25);
        if (s > 1e-4) { this.velocity.x *= keep / s; this.velocity.z *= keep / s; }
      }
    }
    this.dashT = this.dashTime > 0 ? clamp(this.dashTime / DASH_TIME, 0, 1) : 0;
  }

  /** Aim basis, rebuilt from the command's angles rather than the live rig. */
  _aim(cmd) {
    this.aimYaw = cmd.yaw;
    this.aimPitch = cmd.pitch;
    this.yaw = cmd.yaw;
    const cp = Math.cos(cmd.pitch);
    this._camDir.set(Math.sin(cmd.yaw) * cp, Math.sin(cmd.pitch), Math.cos(cmd.yaw) * cp);
    // Movement basis: camera yaw flattened to the ground plane.
    // Right is `forward x up`. With forward = (sin y, 0, cos y) and up = +Y
    // that is (-cos y, 0, sin y) — the opposite of the (fwd.z, 0, -fwd.x) this
    // used to compute, which strafed left on D. CameraRig derives its own right
    // vector the correct way, which is why the shoulder offset looked fine
    // while movement did not.
    this._fwd.set(Math.sin(cmd.yaw), 0, Math.cos(cmd.yaw));
    this._right.set(-this._fwd.z, 0, this._fwd.x);
  }

  _move(ctx, h, cmd, buttons, pressed) {
    const stats = this.stats;
    this._wish.set(0, 0, 0)
      .addScaledVector(this._fwd, cmd.moveZ)
      .addScaledVector(this._right, cmd.moveX);
    const wishLen = this._wish.length();
    if (wishLen > 1e-4) this._wish.divideScalar(wishLen);
    this.moving = wishLen > 0.01;

    // Sprint: forward-ish input, held Shift, and not recently firing.
    const wantsSprint = (buttons & BTN.SPRINT) !== 0 && cmd.moveZ > 0.3 && this.moving;
    this.sprinting = wantsSprint && this.fireLock <= 0;
    this.sprintBlend = damp(this.sprintBlend, this.sprinting ? 1 : 0, 0.995, h);

    const speed = stats.moveSpeed * (this.sprinting ? SPRINT_MULT : 1);

    // Dash overrides horizontal control entirely — committing to the dash is
    // what makes the i-frames a real decision.
    if (this.dashTime > 0) {
      this.velocity.x = this.dashDirection.x * DASH_SPEED;
      this.velocity.z = this.dashDirection.z * DASH_SPEED;
      if (this.velocity.y < 0) this.velocity.y *= 0.35; // brief float, no slam
      this.dashRoll = damp(this.dashRoll, this._dashLateral(), 0.99, h);
    } else {
      this.dashRoll = damp(this.dashRoll, 0, 0.99, h);
      this._accelerate(h, speed, wishLen > 0.01);
    }

    this._gravity(h, (buttons & BTN.JUMP) !== 0);
    this._jump(ctx, h, (pressed & BTN.JUMP) !== 0);
  }

  _accelerate(h, speed, hasInput) {
    const grounded = this.grounded;
    this._horiz.set(this.velocity.x, 0, this.velocity.z);

    let rate;
    if (hasInput) rate = grounded ? GROUND_ACCEL : GROUND_ACCEL * AIR_CONTROL;
    else rate = grounded ? GROUND_DECEL : AIR_DECEL;

    // Steer toward the target velocity at a capped rate. Doing it as a single
    // clamped step (rather than a lerp) keeps the response identical whether
    // you're turning or accelerating, which is what makes strafing feel tight.
    this._diff.set(this._wish.x * speed, 0, this._wish.z * speed).sub(this._horiz);
    const need = this._diff.length();
    if (need > 1e-5) {
      const step = Math.min(need, rate * h);
      this._diff.multiplyScalar(step / need);
      this.velocity.x += this._diff.x;
      this.velocity.z += this._diff.z;
    }
  }

  _gravity(h, held) {
    if (this.dashTime > 0) { this.velocity.y -= GRAVITY * 0.25 * h; return; }
    const vy = this.velocity.y;
    let mult;
    if (Math.abs(vy) < APEX_BAND && !this.grounded) mult = G_APEX;
    else if (vy > 0) mult = held ? G_RISE : G_RISE_RELEASED;
    else mult = G_FALL;
    this.velocity.y = Math.max(vy - GRAVITY * mult * h, -TERMINAL);
  }

  _jump(ctx, h, jumpEdge) {
    if (jumpEdge) this.jumpBuffer = JUMP_BUFFER;
    if (this.jumpBuffer <= 0) return;

    const canGround = this.grounded || this.coyote > 0;
    const maxJumps = Math.max(1, Math.round(this.stats.jumpCount || 1));
    if (canGround) {
      this.jumpsUsed = 1;
    } else if (this.jumpsUsed < maxJumps) {
      // Air jump: flatten downward momentum and redirect toward the input, so a
      // double jump always saves you rather than fighting the fall.
      this.jumpsUsed++;
      const speed = this.stats.moveSpeed;
      if (this.moving) {
        this.velocity.x = damp(this.velocity.x, this._wish.x * speed, 0.9, 1);
        this.velocity.z = damp(this.velocity.z, this._wish.z * speed, 0.9, 1);
      }
      if (!this._replaying) ctx.vfx?.impact?.(this.position, this.groundNormal, 'dirt');
    } else {
      return;
    }

    this.velocity.y = canGround ? JUMP_SPEED : AIR_JUMP_SPEED;
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.grounded = false;
    if (!this._replaying) ctx.audio?.footstep?.(this.position, 'dirt');
  }

  _resolve(ctx, h) {
    const res = ctx.stage?.capsuleResolve?.(this.position, RADIUS, HEIGHT, this.velocity, h);
    if (res && res.position) {
      this.position.copy(res.position);
      if (res.velocity) this.velocity.copy(res.velocity);
      this.grounded = !!res.grounded;
      if (res.normal) this.groundNormal.copy(res.normal);
    } else {
      // Stage not up yet (or returned null): integrate freely and stand on the
      // height field if there is one, so the player never falls out of the world.
      this.position.addScaledVector(this.velocity, h);
      const y = ctx.stage?.sampleHeight?.(this.position.x, this.position.z);
      const floor = typeof y === 'number' && isFinite(y) ? y : 0;
      if (this.position.y <= floor) {
        this.position.y = floor;
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.grounded = true;
        this.groundNormal.set(0, 1, 0);
      } else {
        this.grounded = false;
      }
    }
  }

  _land(ctx) {
    if (this.grounded) {
      if (!this.wasGrounded) {
        const impact = Math.abs(this._fallSpeed || 0);
        this.jumpsUsed = 0;
        if (!this._replaying) {
          ctx.cameraRig?.land(impact);
          if (impact > 6) {
            ctx.vfx?.impact?.(this.position, this.groundNormal, 'dirt');
            ctx.audio?.footstep?.(this.position, 'dirt');
          }
          if (impact > 14) ctx.pipeline?.addShake?.(0.03);
        }
      }
      this._fallSpeed = 0;
    } else {
      this._fallSpeed = Math.min(this._fallSpeed || 0, this.velocity.y);
    }
    this.wasGrounded = this.grounded;
  }

  _regen(ctx, h) {
    if (!this.alive) return;
    if (this.sinceDamage > REGEN_DELAY && this.health < this.maxHealth) {
      // RoR2 regen is flat HP/s from the stat block; items scale the stat.
      this.health = Math.min(this.maxHealth, this.health + this.stats.healthRegen * h);
    }
  }

  _applyRecoil(ctx, h) {
    const rig = ctx.cameraRig;
    if (!rig) { this.recoilPending = 0; return; }
    if (this.recoilPending !== 0) {
      rig.pitch = clamp(rig.pitch + this.recoilPending, -1.15, 1.05);
      this.recoilAccum += this.recoilPending;
      this.recoilPending = 0;
    }
    // Recover most of the kick, but not all — leftover drift is what makes
    // sustained fire require re-aiming.
    if (this.recoilAccum > 0) {
      const back = Math.min(this.recoilAccum, 1.9 * h);
      rig.pitch = clamp(rig.pitch - back * 0.8, -1.15, 1.05);
      this.recoilAccum -= back;
    }
  }

  // --------------------------------------------------------------- abilities

  _abilities(ctx, buttons, pressed) {
    if (buttons & BTN.FIRE) this._tryFire(ctx, 'primary');
    if (pressed & BTN.SECONDARY) this._tryFire(ctx, 'secondary');
    if (pressed & BTN.UTILITY) this._tryFire(ctx, 'utility');
    if (pressed & BTN.SPECIAL) this._tryFire(ctx, 'special');
  }

  _tryFire(ctx, slot) {
    const s = this.slotBySlot[slot];
    if (!s || s.charges <= 0) return false;
    if (slot === 'utility' && this.dashTime > 0) return false;

    s.charges--;
    if (s.cd <= 0) {
      s.cdMax = s.cooldown = effectiveCooldown(s.ability, this.stats);
      s.cd = s.cdMax;
    }
    // Charge and cooldown accounting is simulation and always re-runs. The
    // effect is not: a replayed volley would spawn a second set of projectiles.
    // The dash is the exception — its effect *is* movement, so replay needs it.
    if (this._replaying) {
      if (slot === 'utility') this.beginDash();
    } else {
      s.ability.fire(ctx, this);
    }
    if (slot === 'primary' || slot === 'secondary') this.fireLock = FIRE_LOCK;
    if (!this._replaying) ctx.events.emit('abilityUsed', { slot, ability: s.ability });
    return true;
  }

  _tickCooldowns(h) {
    // Charge-granting items (Hardlight Afterburner and friends) only ever apply
    // to the cooldown-bearing slots, never to the basic attack.
    const extra = this.stats.extraCharges || 0;
    for (const s of this.slots) {
      const max = s.ability.charges + (s.slot === 'primary' ? 0 : extra);
      if (max !== s.maxCharges) {
        s.maxCharges = max;
        if (s.charges > max) s.charges = max;
      }
    }

    for (const s of this.slots) {
      if (s.charges >= s.maxCharges) { s.cd = 0; continue; }
      s.cd -= h;
      if (s.cd <= 0) {
        s.charges++;
        s.cdMax = s.cooldown = effectiveCooldown(s.ability, this.stats);
        s.cd = s.charges < s.maxCharges ? s.cdMax : 0;
      }
    }
  }

  /** Run `fn` after `delay` seconds of gameplay time. Never allocates. */
  schedule(delay, fn) {
    for (let i = 0; i < MAX_SCHEDULED; i++) {
      const e = this._sched[i];
      if (!e.fn) { e.t = delay; e.fn = fn; return; }
    }
  }

  _runSchedule(h) {
    for (let i = 0; i < MAX_SCHEDULED; i++) {
      const e = this._sched[i];
      if (!e.fn) continue;
      e.t -= h;
      if (e.t <= 0) { const fn = e.fn; e.fn = null; fn(); }
    }
  }

  beginDash() {
    // Dash the way you're holding, not the way you're looking — a backwards
    // disengage has to be possible.
    if (this.moving) this.dashDirection.copy(this._wish);
    else this.dashDirection.set(this._fwd.x, 0, this._fwd.z);
    this.dashDirection.y = 0;
    if (this.dashDirection.lengthSq() < 1e-6) this.dashDirection.set(0, 0, 1);
    this.dashDirection.normalize();
    this.dashTime = DASH_TIME;
    this.dashT = 1;
    if (!this._replaying) {
      this._dashTrail = this.ctx.vfx?.trails?.spawn({
        position: this.center(this._center),
        color: 0x8fd8ff, coreColor: 0xffffff, width: 0.5, life: 0.3, minDist: 0.15,
      }) || null;
    }
    this.iframes = Math.max(this.iframes, DASH_IFRAMES);
    // Combat gates on this itself, so the dash is invulnerable even to damage
    // paths that never reach our takeDamage.
    this._iframeUntil = Math.max(this._iframeUntil, this.ctx.time + DASH_IFRAMES);
    this.jumpBuffer = 0;
  }

  _dashLateral() {
    return clamp(this.dashDirection.x * this._right.x + this.dashDirection.z * this._right.z, -1, 1);
  }

  applySelfKnockback(amount) {
    this.velocity.addScaledVector(this._camDir, amount);
  }

  addAimPunch(amount) {
    this.recoilPending += amount * 0.0055;
  }

  // -------------------------------------------------------------------- aim

  /** Screen-centre ray: camera position + true camera forward. */
  aimRay() {
    const ctx = this.ctx;
    const r = this._aimRay;
    ctx.camera.getWorldDirection(r.dir);
    r.origin.setFromMatrixPosition(ctx.camera.matrixWorld);
    const hit = ctx.stage?.raycast?.(r.origin, r.dir, 300);
    if (hit && hit.point) r.point.copy(hit.point);
    else r.point.copy(r.origin).addScaledVector(r.dir, 300);
    return r;
  }

  /**
   * Firing ray: starts at the muzzle but converges on the point the crosshair
   * is over, so shots land where the reticle is despite the shoulder offset.
   */
  fireRay() {
    const aim = this.aimRay();
    const r = this._fireRay;
    r.origin.copy(this.muzzlePosition());
    r.dir.copy(aim.point).sub(r.origin);
    if (r.dir.lengthSq() < 1e-6) r.dir.copy(aim.dir);
    r.dir.normalize();
    return r;
  }

  muzzlePosition() {
    if (this.mesh) {
      this.mesh.getMuzzle(this._muzzle);
      if (isFinite(this._muzzle.x)) return this._muzzle;
    }
    return this._muzzle.copy(this.position).setY(this.position.y + EYE);
  }

  /** Centre of mass — what enemies and splash should aim at. */
  center(out) {
    return out.copy(this.position).setY(this.position.y + HEIGHT * 0.5);
  }

  // -------------------------------------------------------------- networking

  /**
   * Snapshot of everything reconciliation compares or rewinds.
   *
   * A fresh object rather than a reused one: `NetClient` keeps the result in
   * its command history and diffs a later state against it, which a shared
   * instance would silently reduce to comparing an object with itself.
   */
  getNetState() {
    return {
      x: this.position.x, y: this.position.y, z: this.position.z,
      vx: this.velocity.x, vy: this.velocity.y, vz: this.velocity.z,
      yaw: this.aimYaw, pitch: this.aimPitch,
      health: this.health,
      alive: this.alive,
      // The rest of what the step reads. Position alone is not enough to rewind
      // to: whether you were grounded, mid-dash or inside the coyote window all
      // change where the very next command takes you.
      grounded: this.grounded,
      dashTime: this.dashTime,
      coyote: this.coyote,
      jumpBuffer: this.jumpBuffer,
      jumpsUsed: this.jumpsUsed,
      fireLock: this.fireLock,
      buttons: this._prevButtons,
      // Charges and cooldowns are movement state by proxy: firing sets
      // `fireLock`, which suppresses sprint, which changes top speed. Replay a
      // window without them and the run drifts by a fraction of a metre.
      slots: [
        this.slots[0].charges, this.slots[0].cd, this.slots[1].charges, this.slots[1].cd,
        this.slots[2].charges, this.slots[2].cd, this.slots[3].charges, this.slots[3].cd,
      ],
      tick: this._lastCmdTick,
    };
  }

  /** Hard-set from the host. Absent fields are left alone. */
  setNetState(s) {
    if (!s) return;
    if (s.x !== undefined) this.position.set(s.x, s.y, s.z);
    if (s.vx !== undefined) this.velocity.set(s.vx, s.vy, s.vz);
    if (s.health !== undefined) this.health = s.health;
    if (s.grounded !== undefined) this.grounded = !!s.grounded;
    if (s.dashTime !== undefined) this.dashTime = s.dashTime;
    if (s.coyote !== undefined) this.coyote = s.coyote;
    if (s.jumpBuffer !== undefined) this.jumpBuffer = s.jumpBuffer;
    if (s.jumpsUsed !== undefined) this.jumpsUsed = s.jumpsUsed;
    if (s.fireLock !== undefined) this.fireLock = s.fireLock;
    if (s.buttons !== undefined) this._prevButtons = s.buttons;
    if (s.slots) {
      for (let i = 0; i < this.slots.length; i++) {
        this.slots[i].charges = s.slots[i * 2];
        this.slots[i].cd = s.slots[i * 2 + 1];
      }
    }
    // Replay re-runs ticks that were already simulated once, so the step has to
    // recognise them as such and skip the one-shot effects.
    if (s.tick !== undefined) this._lastCmdTick = s.tick;
  }

  /** Visual-only nudge that hides small corrections. Never touches `position`. */
  setRenderOffset(x, y, z) {
    this._renderOffset.set(x, y, z);
  }

  // ------------------------------------------------------------------ damage

  /**
   * Combat.applyDamage is the one damage path: armor, crit, block and shields
   * are already resolved by the time this runs, so this only books the result.
   * The i-frame check is a second gate for anything that calls in directly.
   */
  takeDamage(amount, info = {}) {
    if (!this.alive || this.iframes > 0) return 0;
    const dealt = Math.max(0, amount);
    this.health -= dealt;
    this.sinceDamage = 0;

    // VFX draws the hurt feedback off the `playerHurt` event Combat emits.
    this.ctx.pipeline?.addShake?.(clamp(dealt / this.maxHealth, 0.01, 0.12));

    // Combat._kill runs immediately after this returns and drives onDeath plus
    // the playerDead event; only self-kill when there is no Combat to do it.
    if (this.health <= 0) {
      this.health = 0;
      if (!this.ctx.combat) { this.onDeath(); this.ctx.events.emit('playerDead', {}); }
    }
    return dealt;
  }

  heal(amount) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Invoked by Combat._kill, which emits `playerDead` itself. */
  onDeath() {
    this.alive = false;
    this.velocity.set(0, 0, 0);
    this.projectiles.clear();
  }

  // ------------------------------------------------------------ presentation

  update(ctx, dt) {
    const s = this._meshState;
    s.velocity = this.velocity;
    s.grounded = this.grounded;
    s.aimYaw = this.aimYaw ?? 0;
    s.aimPitch = this.aimPitch ?? 0;
    s.dashT = this.dashT;
    s.sprint = this.sprinting;
    s.moveSpeed = this.stats.moveSpeed;
    s.dead = !this.alive;

    // Render offset is presentation only — the capsule the simulation resolves
    // against is still `position`.
    this.mesh.group.position.copy(this.position).add(this._renderOffset);
    this.mesh.update(dt, s);

    if (this._dashTrail) {
      const c = this.center(this._center);
      if (this.dashTime > 0) ctx.vfx?.trails?.move(this._dashTrail, c.x, c.y, c.z);
      else { ctx.vfx?.trails?.stop(this._dashTrail); this._dashTrail = null; }
    }

    this.projectiles.update(ctx, dt);
  }
}
