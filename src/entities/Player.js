import * as THREE from 'three';
import { clamp, damp } from '../core/MathUtil.js';
import { CharacterMesh } from './CharacterMesh.js';
import { ProjectilePool } from './Projectile.js';
import { PlaceablePool } from './Placeables.js';
import { SLOT_ORDER, effectiveCooldown } from '../data/abilities.js';
import { getSurvivor, loadoutOf, DEFAULT_SURVIVOR } from '../data/survivors.js';
import { BTN, ESTATE } from '../net/Protocol.js';
import { Items } from '../systems/Items.js';

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
 * `Items.of(ctx, this).stats(base)` each step — this pawn's own inventory, not
 * the viewer's, because a host steps every pawn in the party — and nothing
 * downstream reads the base block directly.
 *
 * ## Survivors
 *
 * The loadout is data. `data/survivors.js` supplies the base stat block, the
 * four ability ids and the mesh key; this class contains no per-survivor
 * branch, and adding a fifth survivor touches no code in here at all.
 *
 * Which survivor a run boots with is decided, in order:
 *   1. `new Player({ survivor: 'kestrel' })`  — explicit, used by tools
 *   2. `ctx.survivorId`                        — set by the UI before boot
 *   3. `DEFAULT_SURVIVOR`                      — the Ranger
 *
 * so the zero-configuration path (`engine.add(new Player())`, no UI anywhere)
 * still boots exactly the character it always did.
 */

// Survivor level scaling, matching the ramp the Director gives monsters
// (Director.js:10-11) so a level of parity really is parity. The level itself
// is run state and lives on Progression — see `_levelBase`.
const LEVEL_HEALTH = 0.30;
const LEVEL_DAMAGE = 0.20;
const LEVEL_REGEN = 0.20;

const RADIUS = 0.45;
const HEIGHT = 1.8;
const EYE = 1.6;

// How far the aim ray looks for something to converge on. Past this there is
// nothing to hit, so the residual muzzle/camera parallax costs nothing.
const AIM_RANGE = 300;

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
// How long velocity written by something other than the controller survives.
// Sized against both ends of the channel: a 9-12 m/s knockback reads as a shove
// of roughly two metres, and a sustained pull settles at `accel * TAU`, which
// puts the strongest one in the game (30 m/s^2 at contact) at ~4.6 m/s against
// a 10.15 m/s sprint. See `_harvestExternal`.
const EXTERNAL_TAU = 0.25;
const AIR_CONTROL = 0.35;
const AIR_DECEL = 7;
const SPRINT_MULT = 1.45;

const COYOTE = 0.12;
const JUMP_BUFFER = 0.15;

// How far back a command tick may be and still be treated as a re-simulation of
// something already run. `NetClient.INPUT_HISTORY` is 128, so a genuine replay
// is never deeper than that; anything older is a new tick origin (a join or a
// reconnect re-bases the counter at 0), not a replay. See `applyCommand`.
const REPLAY_WINDOW = 256;

// Defaults for `beginDash`. A survivor's utility skill may override any of the
// three per cast — Anvil's Breach Charge is longer, faster and aim-directed —
// and the live values are mirrored onto the pawn so they survive a snapshot.
const DASH_SPEED = 22;
const DASH_TIME = 0.24;
const DASH_IFRAMES = 0.32;
const FIRE_LOCK = 0.4;     // sprint stays disabled this long after a shot

const REGEN_DELAY = 1.2;

const MAX_SCHEDULED = 32;

// Stand-in when the host has no command to feed a starved pawn.
const IDLE_CMD = { tick: 0, moveX: 0, moveZ: 0, buttons: 0, yaw: 0, pitch: 0 };

/**
 * Detach a subtree from the scene and give its GPU buffers back.
 *
 * Everything this is pointed at — the character rig, the projectile pool root,
 * the placeable pool root — builds its own geometries and materials in its own
 * constructor, so there is nothing here another live object is still reading.
 * `VFX.hitFlash` swaps in per-object material clones, which live on these same
 * meshes and go with them.
 */
function releaseSubtree(root) {
  if (!root) return;
  root.removeFromParent?.();
  root.traverse?.((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) for (const mm of m) mm?.dispose?.();
    else m?.dispose?.();
  });
}

let NEXT_ID = 1;

export class Player {
  /**
   * `local: false` builds a pawn for a remote co-op player. It is the same
   * class doing the same simulation — the only differences are that it never
   * claims `ctx.player` (the camera, HUD and input all follow that one) and
   * that nothing steps it from the engine: NetHost feeds it `applyCommand`
   * straight off the wire.
   */
  constructor({ local = true, survivor = null } = {}) {
    this.local = local;
    // Held rather than resolved: `ctx` does not exist yet, and `ctx.survivorId`
    // is what a survivor-select screen will have written by the time init runs.
    this.requestedSurvivor = survivor;
  }

  init(ctx) {
    if (this.local) ctx.player = this;
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
    // Horizontal velocity this pawn did not put there itself. `_harvestExternal`
    // owns both of these; `_extVX/_extVZ` is the velocity as this pawn last left
    // it, and anything that differs when the next step begins came from outside.
    this._external = new THREE.Vector3();
    this._extVX = 0;
    this._extVZ = 0;

    // Timed stat buffs (Anvil's Bulwark and anything like it). Folded into the
    // *base* block rather than onto the result of `ctx.items.stats()`, because
    // that result is a shared cache Items hands back by reference — writing to
    // it would compound the buff every frame and never expire.
    this._buffs = [];
    this._buffTotal = { armor: 0, damageMult: 1 };
    this._buffBase = {};

    // Survivor card + everything derived from it: base stats, the four slots,
    // and the rig. Everything below this line is survivor-agnostic.
    this._applyCard(getSurvivor(this.requestedSurvivor ?? ctx.survivorId ?? DEFAULT_SURVIVOR));

    this.stats = { ...this.base };
    // `shield` is the decaying barrier Items grants and ticks down; Player only
    // reports the cap so the HUD has something to draw against.
    this.shield = 0;
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
    this.dashSpeed = DASH_SPEED;
    this.dashMaxTime = DASH_TIME;
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
    // Tick of the command currently being applied, and what each jump on it
    // consumed from `Items`. A rollback re-runs several unacknowledged commands
    // in order and each of their jumps may have consumed a different amount
    // (Updraft Vents is conditional, Tectonic Heart pays on every third), so one
    // cached value is not enough — the impulse has to be keyed by tick.
    this._cmdTick = 0;
    this._jumpImpulses = new Map();
    this.interactPressed = false;
    this.equipPressed = false;
    this._renderOffset = new THREE.Vector3();

    // Fixed-size deferred-call ring: multi-shot abilities need sub-step timing
    // without allocating a closure array every trigger.
    this._sched = new Array(MAX_SCHEDULED);
    for (let i = 0; i < MAX_SCHEDULED; i++) this._sched[i] = { t: 0, fn: null };

    this.projectiles = new ProjectilePool(ctx);
    // Deployed constructs (Rook's mines, wards and sentries). Same ownership
    // model as the projectile pool: stepped from here, not a system.
    this.placeables = new PlaceablePool(ctx);
    // Nothing a survivor left on the ground survives a stage transition — the
    // stage it was standing on no longer exists.
    //
    // The unsubscribe is kept because `Player` is not always a singleton: co-op
    // spawns one per remote peer, and `Coop._despawnPawn` used to drop the pawn
    // while this closure stayed on the bus, pinning the whole Player — mesh,
    // pools and all — for the rest of the session. Every join/leave cycle added
    // another. `dispose()` is what releases it.
    this._offStageStart = ctx.events?.on?.('stageStart', () => this.placeables.clear());

    this.mesh = new CharacterMesh(this.survivor.meshKey);
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
      dashT: 0, sprint: false, moveSpeed: this.base.moveSpeed,
    };

    // The survivor-select API. `ctx.player` is the one pawn the camera, HUD and
    // input follow, so only it publishes the hook — a co-op host simulating
    // three remote pawns must not have them fighting over it.
    if (this.local) {
      ctx.survivorId = this.survivor.id;
      ctx.setSurvivor = (id) => this.setSurvivor(id);
    }

    ctx.combat?.register?.(this);

    // Combat decides what can be hit; the roster decides who can be *chosen*.
    // Both registrations are unconditional — a remote pawn is as much a player
    // as the local one, and the whole of N-1 was that nothing ever asked which.
    ctx.roster?.add?.(this);

    // Drop onto the stage if it can tell us where the floor is.
    const y = ctx.stage?.sampleHeight?.(0, 0);
    if (typeof y === 'number' && isFinite(y)) this.position.set(0, y + 0.2, 0);
  }

  // --------------------------------------------------------------- survivor

  /**
   * Adopt a survivor card: stats, loadout and everything derived from them.
   *
   * Deliberately does *not* touch the rig — `init` builds it once and
   * `setSurvivor` rebuilds it — so this stays the one place the numbers come
   * from and can be called before the scene exists.
   */
  _applyCard(card) {
    this.survivor = card;
    this.survivorId = card.id;
    // Copied, never referenced: `_levelBase` writes into its block every time
    // the level changes, and the card is shared module data.
    this.base = { ...card.baseStats };
    this._lvlBase = { ...card.baseStats };
    this._lvlN = -1;
    this.maxHealth = this.base.maxHealth;
    this.health = this.base.maxHealth;
    this.maxShield = this.base.maxHealth * 0.5;
    this.dashTrailColour = card.trailColor ?? card.accentColor;

    // Field names here are the HUD's read contract: `cooldown` is the full
    // duration, `cd` the remainder, plus charges/maxCharges/name.
    this.slots = loadoutOf(card).map((a) => ({
      slot: a.slot, ability: a, name: a.name, description: a.description, key: a.key,
      charges: a.charges, maxCharges: a.charges,
      cd: 0, cdMax: a.cooldown, cooldown: a.cooldown,
    }));
    this.abilities = this.slots;
    this.slotBySlot = {};
    for (const s of this.slots) this.slotBySlot[s.slot] = s;
  }

  /**
   * Swap survivor at runtime. This is the whole API a survivor-select screen
   * needs: `ctx.setSurvivor('kestrel')`.
   *
   * Intended for the lobby, not for mid-fight — it discards deployables, resets
   * cooldowns and refills health, all of which are the right thing between runs
   * and cheating during one. Callers gate on being in a menu; enforcing it here
   * would make the harness unable to photograph the roster.
   */
  setSurvivor(id) {
    const ctx = this.ctx;
    const card = getSurvivor(id);
    if (!ctx || card === this.survivor) return card;

    this._applyCard(card);
    this._buffs.length = 0;
    this.placeables.clear();
    this.projectiles.clear();

    // Rebuild the rig, and free the old one. It used to be detached and dropped
    // on the grounds that rigs share materials and that `VFX.hitFlash` might
    // hold a clone of the geometry; neither is so. `CharacterMesh` builds every
    // geometry and material per instance, and `hitFlash` clones *materials* onto
    // the meshes it is flashing, which are these ones. Detaching alone leaked
    // ~53 geometries a swap — 462 to 1260 over fifteen.
    releaseSubtree(this.group);
    this.mesh = new CharacterMesh(card.meshKey);
    this.group = this.mesh.group;
    this.group.position.copy(this.position);
    ctx.scene.add(this.group);

    if (this.local) ctx.survivorId = card.id;
    // Additive to the event table in CONTRACTS.md: the HUD needs to rebuild its
    // skill icons and the menu needs to re-render the card.
    ctx.events?.emit?.('survivorChanged', { survivor: card, player: this });
    return card;
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
      if (input.down('KeyF')) b |= BTN.EQUIP;
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
    // The bound is what makes this safe across a change of tick origin. A join
    // (or a reconnect) re-bases the wire's counter at 0 while `_lastCmdTick`
    // still holds however far single-player got, so without it every command
    // for the next `_lastCmdTick` ticks looks like a replay and the client
    // spends its first seconds with dead projectiles, dead placeables, no
    // scheduled volleys and no jump impulse. `resetCommandEpoch` clears the
    // counter at the join itself; this bound catches any other origin change,
    // and it cannot swallow a real replay because the client only ever replays
    // unacknowledged commands and its history is capped at 128.
    const replay = c.tick > 0 && c.tick <= this._lastCmdTick
                && this._lastCmdTick - c.tick < REPLAY_WINDOW;
    this._replaying = replay;
    this._cmdTick = c.tick | 0;

    this._refreshStats();

    this._harvestExternal(dt);

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
    if (!replay) {
      this.projectiles.fixedUpdate(ctx, dt);
      this.placeables.fixedUpdate(ctx, dt);
    }

    this._commit(c, buttons, pressed);
  }

  /**
   * This pawn's stat block, off *this pawn's own* inventory, plus the two pools
   * derived from it.
   *
   * `Items.of(ctx, this)`, never `ctx.items`. `applyCommand` is the single 60 Hz
   * step every pawn in the party takes, and on a host `NetHost.fixedUpdate`
   * drives it for the joiners' pawns too — so reading the viewer's singleton
   * here simulated a joiner's body with the *host's* build, while that joiner's
   * own client predicted the same body with its own inventory. Six Cloven Hoof
   * on the host put authority at 12.88 m/s against a prediction of 7.00:
   * permanent rubber-banding, plus a joiner whose entire build was inert on the
   * only machine that decides anything.
   *
   * `Items.of` returns `ctx.items` for the local player on both roles, so
   * single-player and a client's prediction of its own pawn are the exact call
   * this replaced; only the host's remote-pawn path changes.
   *
   * A method rather than four lines inline because it is the seam the co-op
   * stat test drives directly — `applyCommand` needs a whole world around it.
   */
  _refreshStats() {
    const base = this._effectiveBase();
    this.stats = Items.of(this.ctx, this)?.stats?.(base) || { ...base };
    this.maxHealth = this.stats.maxHealth;
    this.maxShield = this.maxHealth * 0.5;
    if (this.health > this.maxHealth) this.health = this.maxHealth;
  }

  /**
   * Fold in whatever moved this pawn from outside, and age what is already held.
   *
   * An enemy's knockback and the suction of a `pull` attack both write straight
   * onto `velocity` between steps, and `_accelerate` then steered the horizontal
   * velocity back toward `wish * speed` at up to 68 m/s^2 — larger than any
   * injection in the game. The strongest pull is 30 m/s^2 at contact, so the
   * correction cancelled it *exactly*, every step, and the injected component
   * never reached the position integrator: a full 1.5s reel closed 0.000-0.081 m.
   * Knockback survived only because 9-12 m/s takes a few steps to grind off.
   *
   * So the two are kept apart. What arrived from outside is stripped off before
   * the correction runs and added back after it, which means it reaches
   * `_resolve` intact — through the capsule solver, so a wall still stops a pull
   * — while the player keeps full authority over their own velocity throughout.
   * It is drift laid on top of control, never instead of it: a reeled player can
   * still turn, still sprint, and still out-run the pull.
   *
   * It ages out on a time constant rather than being fought off, which is the
   * only reason a sustained pull can build at all — a constant injection settles
   * at `accel * EXTERNAL_TAU` instead of at zero.
   *
   * An exactly-zero horizontal velocity is the signature of a hard reset (stage
   * respawn, a harness placement) rather than of anything this channel models,
   * and drops the accumulator: without that, zeroing a sprinting player's
   * velocity would read as a 10 m/s shove backwards.
   */
  _harvestExternal(h) {
    const ext = this._external;
    if (!this.alive || (this.velocity.x === 0 && this.velocity.z === 0)) {
      ext.set(0, 0, 0);
      this._extVX = this.velocity.x;
      this._extVZ = this.velocity.z;
      return;
    }

    ext.x += this.velocity.x - this._extVX;
    ext.z += this.velocity.z - this._extVZ;

    const drop = 1 - Math.exp(-h / EXTERNAL_TAU);
    const dx = ext.x * drop;
    const dz = ext.z * drop;
    ext.x -= dx; ext.z -= dz;
    this.velocity.x -= dx; this.velocity.z -= dz;
    if (Math.abs(ext.x) < 1e-4) ext.x = 0;
    if (Math.abs(ext.z) < 1e-4) ext.z = 0;
  }

  _commit(cmd, buttons, pressed) {
    // `velocity` as this pawn is leaving it. Everything that differs by the time
    // the next step reads it was written by something else — see `_harvestExternal`.
    this._extVX = this.velocity.x;
    this._extVZ = this.velocity.z;

    // The interact bit is a request, not an action — Interactables resolves it,
    // and only where authority allows. The equipment bit is the same shape,
    // resolved by `Coop.fixedUpdate` against this pawn's own `Items`.
    //
    // Both are edges, not levels, and both are computed from `pressed` — which
    // a starved command repeat sets to 0 (`NetHost.fixedUpdate`) — so a held key
    // fires once and a dropped packet cannot re-fire anything.
    this.interactPressed = (pressed & BTN.INTERACT) !== 0;
    this.equipPressed = (pressed & BTN.EQUIP) !== 0;
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
    this.dashT = this.dashTime > 0 ? clamp(this.dashTime / this.dashMaxTime, 0, 1) : 0;
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

    // Slow and freeze reach the player here. `Combat.speedMultiplier` computed
    // the right answer for both and nothing asked it, so every `slow` in the
    // game — the Gloomshriver's whole identity, Grapnel Tether, the Aegis
    // Emitter's dome, Frost Lattice — changed the player's speed by nothing.
    const status = ctx.combat?.speedMultiplier?.(this) ?? 1;
    const speed = stats.moveSpeed * (this.sprinting ? SPRINT_MULT : 1) * status;

    // Dash overrides horizontal control entirely — committing to the dash is
    // what makes the i-frames a real decision, and that includes shrugging off
    // whatever the external channel is holding.
    if (this.dashTime > 0) {
      this.velocity.x = this.dashDirection.x * this.dashSpeed;
      this.velocity.z = this.dashDirection.z * this.dashSpeed;
      if (this.velocity.y < 0) this.velocity.y *= 0.35; // brief float, no slam
      this.dashRoll = damp(this.dashRoll, this._dashLateral(), 0.99, h);
      this._external.set(0, 0, 0);
    } else {
      this.dashRoll = damp(this.dashRoll, 0, 0.99, h);
      // The correction is allowed to steer only the velocity this pawn owns.
      const ext = this._external;
      this.velocity.x -= ext.x; this.velocity.z -= ext.z;
      this._accelerate(h, speed, wishLen > 0.01);
      this.velocity.x += ext.x; this.velocity.z += ext.z;
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

    /*
     * The jump channel, both ends of it.
     *
     * `Items` has listened for a `jump` event since it was written and nothing
     * in the project ever emitted one, so `onJump` never ran; and `onJump` is
     * the only thing that calls `applyImpulse`, whose `consumeImpulse` had no
     * caller either. Three shipped cards sat on the far side of that gap doing
     * literally nothing — Waxed Wing, Updraft Vents, and Tectonic Heart, whose
     * every-third-jump quake never counted a jump.
     *
     * The emit and the consume are the same statement on purpose: the hooks run
     * synchronously inside `emit`, so whatever they push lands before the read
     * on the next line and there is no one-frame ordering question to get wrong.
     *
     * The impulse goes onto the player's *own* velocity rather than through the
     * external channel. It is self-caused — the player pressed jump — so they
     * should keep authority over it: air control steers it and bleeds it off,
     * which is what makes a 10 m/s launch a movement tool instead of a two-metre
     * shove they watch happen. The external channel is for velocity the world
     * writes onto the player, and it decays on a fixed 0.25 s timer that would
     * throw all of this away before the apex.
     */
    /*
     * Two gates, and they are not the same gate — and neither of them is
     * `this.local` around the whole block, which is what the previous revision
     * had. That version removed the launch from the host's copy of a remote
     * pawn, and the host is the authority: the client predicted 30 m/s, the host
     * simulated 0, and reconciliation dragged the client back down to the host's
     * trajectory over about five snapshots. Waxed Wing, Updraft Vents and
     * Tectonic Heart were inert for every non-host player.
     *
     * `local` on the *hooks*, not on the impulse. This was written when there
     * was one `Items` per client whose hook API hard-bound the local survivor,
     * so a remote pawn's jump had to be kept away from the local player's Rubber
     * Soles barrier, Tectonic Heart tally and quake. Both halves of that have
     * since moved: each pawn owns an `Items` (`Items.of`), the `jump` event names
     * its jumper and is filtered per owner (`Items._mine`), and the hook API
     * binds the owner rather than the viewer (`Items._owner`). The two cards
     * still read `e.local` — belt and braces, and the field still means what it
     * says — but it is no longer the thing standing between a teammate's jump
     * and this player's body. The launch itself
     * is movement belonging to the jumper, and a client's inventory is a mirror
     * of the host's (`Items.js:251-252`, `Items.js:211-215`), so both ends
     * compute the same number from the same stacks and agree without a protocol
     * change.
     *
     * `_replaying` — one-shot *effects* must not fire twice, but the impulse is
     * not an effect, it is movement, and a replayed command has to reproduce the
     * trajectory it produced live or the client mispredicts by the whole launch
     * on every corrected jump. The live pass records what it consumed against
     * the tick that consumed it; the replay re-applies that same number.
     */
    let impulse = 0;
    if (this._replaying) {
      impulse = this._jumpImpulses.get(this._cmdTick) || 0;
    } else {
      ctx.events?.emit?.('jump', {
        player: this, local: this.local, air: !canGround, jumps: this.jumpsUsed,
      });
      // Out of *this* pawn's bank. The `jump` above is what fills it, and it is
      // filtered per owner (`Items._mine`), so a remote pawn's Waxed Wing banks
      // its launch on that pawn's own instance — reading `ctx.items` here left
      // it there forever and asked the viewer's bank for a launch nobody paid
      // into. `Items.of` returns `ctx.items` for the local player, which is the
      // call this replaced.
      impulse = Items.of(ctx, this)?.consumeImpulse?.() || 0;
      this._recordJumpImpulse(this._cmdTick, impulse);
    }
    if (impulse > 0) {
      // Forward is where the player is going if they are going anywhere, and
      // where they are looking if they are not — a launch that fires
      // backwards because the stick was neutral is a bug the player feels.
      const dx = this.moving ? this._wish.x : this._fwd.x;
      const dz = this.moving ? this._wish.z : this._fwd.z;
      this.velocity.x += dx * impulse;
      this.velocity.z += dz * impulse;
    }
  }

  /**
   * Remember what a jump consumed, so the replay of that tick reproduces it.
   * Only unacknowledged ticks can ever be replayed, so the window is bounded by
   * the correction depth; a couple of seconds of ticks is far more than enough
   * and keeps this from growing over a run.
   */
  _recordJumpImpulse(tick, impulse) {
    const m = this._jumpImpulses;
    m.set(tick, impulse);
    if (m.size > 128) {
      const cutoff = tick - 128;
      for (const t of m.keys()) if (t <= cutoff) m.delete(t);
    }
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

  // ------------------------------------------------------------------- level

  /**
   * The survivor level lives on Progression, not here: it is shared run state,
   * and a co-op host simulates one Player per connected client. All of them
   * have to read the same number or the host's copy of a remote pawn and that
   * client's own prediction of it would run different stats.
   *
   * These three are the HUD's read contract (`HUD.updateExperience`).
   */
  get level() { return this.ctx?.progression?.level ?? 1; }
  get xp() { return this.ctx?.progression?.xp ?? 0; }
  get xpToNext() { return this.ctx?.progression?.xpToNext ?? 1; }

  /**
   * The base block the stat pipeline is actually handed: level scaling, then
   * any live timed buffs.
   *
   * With no buffs running this returns `_levelBase()`'s block untouched — the
   * same object, field for field — so `Items.stats` keeps its cache hot and the
   * common path costs exactly what it did before buffs existed.
   */
  _effectiveBase() {
    const b = this._levelBase();
    const buff = this._buffTotals();
    if (!buff) return b;
    const o = this._buffBase;
    for (const k in b) o[k] = b[k];
    o.armor = b.armor + buff.armor;
    o.damage = b.damage * buff.damageMult;
    return o;
  }

  /**
   * Sum the live buffs and drop the expired ones, in one pass, without
   * allocating. Returns null when there is nothing to apply.
   */
  _buffTotals() {
    const list = this._buffs;
    if (!list.length) return null;
    const now = this.ctx.time;
    let armor = 0, damageMult = 1, live = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.until <= now) continue;
      list[live++] = b;
      armor += b.armor;
      damageMult *= b.damageMult;
    }
    list.length = live;
    if (!live) return null;
    this._buffTotal.armor = armor;
    this._buffTotal.damageMult = damageMult;
    return this._buffTotal;
  }

  /**
   * Grant a timed stat buff. Expiry is an absolute gameplay time rather than a
   * countdown so a client replaying a window of commands cannot tick it down
   * once per replay.
   */
  grantBuff({ armor = 0, damageMult = 1 } = {}, duration = 1) {
    this._buffs.push({ armor, damageMult, until: this.ctx.time + duration });
  }

  /** Decaying overshield, capped the same way `Items.addBarrier` caps it. */
  grantBarrier(amount) {
    const cap = (this.stats?.maxHealth || this.maxHealth || 100) * 0.5;
    this.shield = Math.min(cap, (this.shield || 0) + amount);
  }

  /** Open the mercy window. Both gates, for the same reason `beginDash` sets both. */
  grantIFrames(seconds) {
    this.iframes = Math.max(this.iframes, seconds);
    this._iframeUntil = Math.max(this._iframeUntil, this.ctx.time + seconds);
  }

  /** The base block raised by the current level. Rebuilt only when it changes. */
  _levelBase() {
    const n = Math.max(0, this.level - 1);
    const b = this._lvlBase;
    if (n === this._lvlN) return b;
    const prevMax = b.maxHealth;
    this._lvlN = n;
    b.maxHealth = this.base.maxHealth * (1 + LEVEL_HEALTH * n);
    b.damage = this.base.damage * (1 + LEVEL_DAMAGE * n);
    b.healthRegen = this.base.healthRegen * (1 + LEVEL_REGEN * n);
    // Grant the health the level adds instead of only widening the bar —
    // otherwise every level-up would visibly *drop* your health fraction.
    // Health is replicated, so only the host books it.
    if (b.maxHealth > prevMax && this.alive && this.ctx.authority) {
      this.health += b.maxHealth - prevMax;
    }
    return b;
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
      // Replay re-runs only the part of the cast the simulation depends on.
      // See the `replayFire` note at the top of data/abilities.js.
      s.ability.replayFire?.(ctx, this);
    } else {
      s.ability.fire(ctx, this);
    }
    if (slot === 'primary' || slot === 'secondary') this.fireLock = FIRE_LOCK;
    // `player` names the caster, exactly as `jump` already does. On a host the
    // bus carries every pawn's casts, and the Lunar cooldown items that listen
    // (`Items.onAbility`) must charge the caster's own inventory and nobody
    // else's — without an identity on the payload a teammate's press paid out
    // of the viewer's pack.
    if (!this._replaying) ctx.events.emit('abilityUsed', { slot, ability: s.ability, player: this });
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

  /**
   * @param {object} [o] { direction, speed, time, iframes } — a survivor's
   *   utility skill overriding the defaults. Omit it entirely and this is the
   *   Ranger's roll, unchanged.
   */
  beginDash(o = null) {
    // Dash the way you're holding, not the way you're looking — a backwards
    // disengage has to be possible. An explicit `direction` overrides that:
    // a gap-closer has to go at the thing being aimed at.
    if (o?.direction) this.dashDirection.copy(o.direction);
    else if (this.moving) this.dashDirection.copy(this._wish);
    else this.dashDirection.set(this._fwd.x, 0, this._fwd.z);
    this.dashDirection.y = 0;
    if (this.dashDirection.lengthSq() < 1e-6) this.dashDirection.set(0, 0, 1);
    this.dashDirection.normalize();
    this.dashSpeed = o?.speed ?? DASH_SPEED;
    this.dashMaxTime = o?.time ?? DASH_TIME;
    const iframes = o?.iframes ?? DASH_IFRAMES;
    this.dashTime = this.dashMaxTime;
    this.dashT = 1;
    if (!this._replaying) {
      this._dashTrail = this.ctx.vfx?.trails?.spawn({
        position: this.center(this._center),
        color: this.dashTrailColour, coreColor: 0xffffff, width: 0.5, life: 0.3, minDist: 0.15,
      }) || null;
    }
    this.iframes = Math.max(this.iframes, iframes);
    // Combat gates on this itself, so the dash is invulnerable even to damage
    // paths that never reach our takeDamage.
    this._iframeUntil = Math.max(this._iframeUntil, this.ctx.time + iframes);
    this.jumpBuffer = 0;
  }

  /** Aim direction flattened to the ground plane. */
  aimForward(out) {
    out.set(this._camDir.x, 0, this._camDir.z);
    if (out.lengthSq() < 1e-6) out.set(this._fwd.x, 0, this._fwd.z);
    return out.normalize();
  }

  /**
   * The movement direction this step is being asked for, as a unit vector.
   *
   * Abilities run before `_move`, so this is last step's input — which is the
   * same window `beginDash` has always read, and is what makes "dash the way
   * you're holding" work at all.
   */
  wishDirection() { return this._wish; }

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

  /**
   * Screen-centre ray: camera position + true camera forward.
   *
   * `point` is the convergence target `fireRay` aims the muzzle at, and it has
   * to be the thing the crosshair is actually over — including a body. It used
   * to be resolved against `stage.raycast` alone, which sees terrain and props
   * and nothing else, so any shot at an enemy converged on whatever was *behind*
   * it: distant terrain, or the 300m fallback when the target was against sky.
   *
   * That is what made shots miss the reticle. Convergence only puts the muzzle
   * ray and the camera ray in the same place at the convergence distance; the
   * camera sits ~7m behind and ~1.15m right of the muzzle, so converging at
   * 300m leaves the two rays nearly a full metre apart at the 10-20m where the
   * fight actually happens. Aiming at a body two feet to the left of the
   * crosshair is exactly that error, and it is worst against the sky, where the
   * old code always took the 300m fallback.
   *
   * Resolving bodies too collapses the error to zero at the target.
   */
  aimRay() {
    const ctx = this.ctx;
    const r = this._aimRay;
    ctx.camera.getWorldDirection(r.dir);
    r.origin.setFromMatrixPosition(ctx.camera.matrixWorld);

    const hit = ctx.stage?.raycast?.(r.origin, r.dir, AIM_RANGE);
    let dist = hit && hit.point ? hit.distance : AIM_RANGE;

    // Bodies cap it further. Nearest wins: the crosshair is over whichever of
    // the two the player can see, and that is always the closer one.
    const body = ctx.combat?.probeDistance?.(r.origin, r.dir, dist, this.team, this);
    if (body >= 0 && body < dist) dist = body;

    if (hit && hit.point && dist === hit.distance) r.point.copy(hit.point);
    else r.point.copy(r.origin).addScaledVector(r.dir, dist);
    return r;
  }

  /**
   * Release everything this pawn holds on the rest of the engine.
   *
   * Only co-op calls this — the local player lives as long as the page does.
   * A remote pawn does not: it is created on join and dropped on leave, and
   * until now "dropped" meant removed from a list and detached from the scene,
   * which left its `stageStart` subscription live on the bus. A bus entry is a
   * strong reference, so the Player, its rig, its projectile pool and its
   * placeable pool all stayed resident for the session, once per join.
   *
   * Releasing the pools means their *roots*, not just their contents. `clear()`
   * deactivates live entries and nothing more; both pools add their root to the
   * scene at construction and populate it to full capacity there (96 projectile
   * meshes, 24 placeable groups), so a joined-and-left pawn left 122 nodes for
   * three to walk in `updateMatrixWorld` and `projectObject` every frame, for
   * the life of the tab, while `coop.pawns.length` read zero.
   *
   * Geometry and materials go too. The comment that used to sit here said the
   * character rigs share material instances and that disposing one would blank
   * anyone wearing the same survivor. That is not true: `makeCharacterMats` is
   * called from the `CharacterMesh` constructor and builds a fresh set per
   * instance, as does every geometry in that file, and each pool likewise owns
   * its own. Nothing here is shared with a pawn that is still standing.
   */
  dispose() {
    this.ctx?.roster?.remove?.(this);
    this._offStageStart?.();
    this._offStageStart = null;
    this.placeables?.clear?.();
    this.projectiles?.clear?.();
    releaseSubtree(this.placeables?.root);
    releaseSubtree(this.projectiles?.root);
    releaseSubtree(this.group);
    this.alive = false;
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
      // The dash *shape*, not just its remaining time: a survivor whose utility
      // is a 30 m/s charge rewinds to a completely different position than one
      // whose is a 22 m/s roll, and only the pawn knows which is in flight.
      dashSpeed: this.dashSpeed,
      dashMaxTime: this.dashMaxTime,
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

  /**
   * The tick origin changed — this pawn is about to be driven by a counter that
   * starts again at 0. Joining a game does exactly that: `NetClient.tick` opens
   * at 0 while `_lastCmdTick` still holds wherever single-player (or the title
   * screen, which also steps) got to, and every command below that mark would
   * otherwise be classified as a replay. The recorded impulses go with it —
   * they are keyed by ticks from the old epoch and would collide with the new
   * one's.
   */
  resetCommandEpoch() {
    this._lastCmdTick = 0;
    this._localTick = 0;
    this._cmdTick = 0;
    this._replaying = false;
    this._jumpImpulses.clear();
  }

  /** Hard-set from the host. Absent fields are left alone. */
  setNetState(s) {
    if (!s) return;
    if (s.x !== undefined) this.position.set(s.x, s.y, s.z);
    if (s.vx !== undefined) {
      this.velocity.set(s.vx, s.vy, s.vz);
      // A hard set from the host is not an outside shove — the host's velocity
      // already has whatever pull or knockback it resolved folded into it.
      this._external.set(0, 0, 0);
      this._extVX = s.vx;
      this._extVZ = s.vz;
    }
    if (s.health !== undefined) this.health = s.health;
    if (s.grounded !== undefined) this.grounded = !!s.grounded;
    if (s.dashTime !== undefined) this.dashTime = s.dashTime;
    if (s.dashSpeed !== undefined) this.dashSpeed = s.dashSpeed;
    if (s.dashMaxTime !== undefined) this.dashMaxTime = s.dashMaxTime;
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

  /** Snapshot lifecycle flag — see the matching getter on Enemy. */
  get netState() {
    return this.alive ? ESTATE.ALIVE : ESTATE.DEAD;
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
      if (!this.ctx.combat) { this.onDeath(); this.ctx.events.emit('playerDead', { victim: this }); }
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
    this._external.set(0, 0, 0);
    this._extVX = 0;
    this._extVZ = 0;
    this.projectiles.clear();
    this.placeables.clear();
    this._buffs.length = 0;
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
    this.placeables.update(ctx, dt);
  }
}
