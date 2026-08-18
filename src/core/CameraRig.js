import * as THREE from 'three';
import { clamp, lerp } from './MathUtil.js';

/**
 * Third-person orbit camera.
 *
 * Runs entirely in lateUpdate: it is pure presentation and must see the final
 * player transform for the frame. The one thing gameplay reads back from it is
 * the aim basis (`yaw`/`pitch`), which Player turns into `aimRay()`.
 *
 * Feel notes:
 *  - Yaw is applied to the pivot with *no* smoothing. Mouse look must be 1:1;
 *    smoothing it is the single fastest way to make a game feel broken.
 *  - The pivot position is smoothed on a short time constant so the camera
 *    trails slightly under acceleration, and the look-at target is smoothed on
 *    a longer one so the framing settles after the position does.
 *  - Occlusion pulls in instantly (never clip) and eases back out.
 *
 * Framing notes:
 *  - A long lens on a long boom, not a wide lens on a short one. Same subject
 *    size, far less wide-angle stretch, and real separation between the ground
 *    in the near frame, the survivor, and the fogged ridge behind him.
 *  - The shoulder offset is the *only* thing that moves the subject off centre.
 *    Biasing `lookAt` would do it too, but screen centre is the aim ray, so any
 *    such bias would silently decouple the crosshair from where shots go.
 *  - Look-ahead only ever translates the pivot. Nothing here rotates the camera
 *    on the player's behalf.
 */

// Exponential smoothing expressed as a time constant, which is easier to tune
// by feel than MathUtil's per-second rate.
const smooth = (a, b, tau, dt) => b + (a - b) * Math.exp(-dt / Math.max(tau, 1e-4));

const PITCH_MIN = -1.15;
const PITCH_MAX = 1.05;

// Composition. The old rig ran a 70° vertical lens on a 5.4 m boom, which is
// ~106° horizontal at 16:9 — a wide-angle that flattens the stage into one
// depth and drops the survivor into the dead centre of the frame.
//
// 58° vertical is ~89° horizontal. Pairing it with a longer boom keeps the
// survivor at very nearly the same on-screen size (5.4/tan35° vs 7.1/tan29°
// differ by ~2 %) and the same ground coverage at the player's own distance,
// so nothing about threat legibility changes — but the longer lens compresses
// the stage, so near rock, the survivor, and the far ridge stop sharing one
// apparent depth and the fog gradient has room to read across them.
const FOV_BASE = 58;
const FOV_SPRINT = 7;

// `ctx.settings.fov` is the player's dial, defaulting to this. It is remapped
// around FOV_BASE rather than used raw, so the preference still ranges over
// roughly the same span it always did (60→50, 70→58, 110→90).
const FOV_SETTING_DEFAULT = 70;
const FOV_SETTING_SCALE = 0.8;
const FOV_MIN = 46;
const FOV_MAX = 96;

const SENSITIVITY_BASE = 0.0022;   // scaled by `ctx.settings.sensitivity`

// Full right-stick deflection in rad/s, scaled by the player's pad dial.
// Yaw is faster than pitch on purpose — horizontal traversal is the common
// case; full-rate pitch makes aim floaty.
const PAD_YAW_RATE = 3.4;
const PAD_PITCH_RATE = 2.2;

const DIST = 7.1;
const DIST_SPEED = 0.9;     // boom extension at full speed — leads the run
const SHOULDER = 1.15;      // right-shoulder offset, keeps the crosshair clear
const LEAD_STRAFE = 0.055;  // lateral look-ahead per m/s of strafe
const LEAD_MAX = 0.5;
const PIVOT_HEIGHT = 1.68;  // aims at the head, so the body hangs below centre
const CAM_RADIUS = 0.34;    // approximated sphere-cast radius
const MIN_DIST = 0.7;       // the boom never pulls in past this

// Obstruction thickness, measured along the boom, at or under which the camera
// may simply sit behind the thing rather than pull in. Chosen from the measured
// distribution over 16 sprints across stage 2: every spire responsible for a
// boom collapse came in between 0.01 and 0.22 m, and the next thing up in the
// same sample was 0.83 m. See _sliver().
//
// The works biome was checked against this number too, because it is the one
// place where a *whole* prop lands on the threshold rather than an edge of one:
// `barrierGeo` is 0.44 m deep and instanced at 0.90-1.60, so a head-on crossing
// measures 0.397-0.703 m and the lower half of that range reads as a sliver.
// Three things make that the right answer rather than a hole:
//  - Only the shallow half of the range is skipped, and the deep half is what
//    the guard pins. Sprinting past barriers does not reach the rule at all —
//    43,200 frames of it produce identical tracks with the rule on and off,
//    but that is because the boom is grazing downslope terrain rather than
//    meeting a barrier, so it is not evidence of anything. Standing a metre off
//    one and facing it does reach the rule, which is how the arm below tests it.
//  - A skip cannot put the camera inside anything. The reverse cast only
//    reports a thickness when it found a *front* face from the boom end, which
//    means the boom end is outside the solid.
//  - A barrier tops out 1.07 m above its own ground against a 1.68 m pivot, so
//    a skip leaves a knee-high slab in the lower frame. Be clear about the size
//    of that: with two overlapping thin hits and no other ray constraining the
//    boom, the skip is not a smaller pull-in but *no* pull-in — the boom holds
//    its full 7.1 m. That is still the right trade against yanking it to 0.7 m,
//    which would be the #110 pathology in a new biome, but it is the whole boom
//    riding on this number.
// Which is why the number is guarded rather than merely reasoned about: the
// works arm of tests/camera-occlusion.test.mjs parks the survivor facing six
// specific barrier instances 0.58-0.70 m deep, and every one of them goes from
// a clamped boom to the full 7.1 m the moment this constant reaches 0.8.
const SLIVER_MAX = 0.5;

// How far the boom may be pulled in by one frame's cast before that cast is
// asked to justify itself. Free flight moves the camera ~0.2 m per frame at
// full speed, so anything past a metre already reads as a lurch.
const SNAP_MAX = 1.0;

// The same metre, used a second time: a pull-in at or under SNAP_MAX lands in
// one frame exactly as it always has, because that is the size at which the
// camera is genuinely about to clip and nobody can see the step anyway. Past
// it, the *excess* is paid down exponentially on this time constant rather
// than all at once — a 6.4 m clamp becomes a 1.8 m first frame and settles
// inside a fifth of a second instead of expressing as a teleport.
//
// A flat per-frame cap was considered and rejected (#110's lane, stage 2): it
// compresses legitimate two- and three-metre clamps just as hard as the
// pathological ones, so the rig stops feeling responsive everywhere in order
// to fix the place it lurched. Making the allowance grow with the distance
// leaves every clamp that already looked right untouched.
//
// Only the pull-*in* is rated. Easing back out already has OCCLUDE_OUT_TAU.
const SNAP_IN_TAU = 0.10;

const POS_TAU = 0.055;      // camera position follow — short, stays responsive
const LOOK_TAU = 0.105;     // look-at target — longer, so framing lags the body
const OCCLUDE_OUT_TAU = 0.30;

export class CameraRig {
  // Pure presentation. The one thing gameplay reads back is the aim basis, and
  // a rig that stopped updating makes aim stale rather than wrong — the player
  // can see that happen and stop shooting.
  static critical = false;

  init(ctx) {
    ctx.cameraRig = this;
    this.ctx = ctx;

    this.sensitivity = SENSITIVITY_BASE;
    this.yaw = 0;
    // Start looking slightly down the boom: a shallow declination puts a band
    // of near ground in the bottom of the frame as foreground, with the ridge
    // line and fog still above the survivor's head.
    this.pitch = -0.17;
    // Cleared by the screenshot harness (and cinematics) to hand the camera
    // over. Without it, anything that positions the camera externally is
    // silently overwritten here every frame.
    this.enabled = true;

    this.pivot = new THREE.Vector3(0, PIVOT_HEIGHT, 0);
    this.lookAt = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.distance = DIST;
    this.targetDistance = DIST;

    this.fov = FOV_BASE;
    this.fovPunch = 0;
    this.fovPunchVel = 0;
    this.roll = 0;
    this.dip = 0;
    this.dipVel = 0;
    this.shakeYaw = 0;

    this._desired = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._far = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();

    this._initialised = false;
  }

  /** FOV kick. Positive widens (recoil), negative narrows (dash wind-up). */
  punch(amount) {
    this.fovPunchVel += amount * 26;
  }

  /** Called by Player on landing; `impact` is downward speed in m/s. */
  land(impact) {
    this.dipVel -= clamp(impact / 18, 0, 1) * 3.2;
  }

  lateUpdate(ctx, dt) {
    const player = ctx.player;
    const input = ctx.input;
    if (!player || !this.enabled) return;

    // --- look ---------------------------------------------------------------
    // Pulled per-frame rather than pushed, per CONTRACTS.md: the settings object
    // is replaced wholesale by Menus.apply().
    const settings = ctx.settings;
    this.sensitivity = SENSITIVITY_BASE * clamp(settings?.sensitivity ?? 1, 0.05, 8);
    if (input && input.locked && input.enabled !== false) {
      this.yaw -= input.mouse.dx * this.sensitivity;
      this.pitch -= input.mouse.dy * this.sensitivity;
    }
    const pad = input?.pad;
    // The mouse branch above stops when a menu opens because the browser drops
    // pointer lock. The pad has no such accident, so it needs the gate spelled
    // out: a thumb resting on the right stick behind the pause or death screen
    // must not rotate the world the player comes back to. `ctx.paused` is not
    // the question — the co-op host deliberately keeps the world unpaused while
    // its own menu is up (NetHost._holdSession) — the open screen is.
    const menuOpen = !!ctx.hud?.menus?.screen;
    if (pad?.active && input.enabled !== false && !menuOpen) {
      const padSens = clamp(settings?.padSensitivity ?? 1, 0.05, 8);
      this.yaw -= pad.lookX * PAD_YAW_RATE * padSens * dt;
      this.pitch -= pad.lookY * PAD_PITCH_RATE * padSens * dt;
    }
    this.pitch = clamp(this.pitch, PITCH_MIN, PITCH_MAX);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    // --- pivot --------------------------------------------------------------
    const cp = Math.cos(this.pitch);
    this._dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();
    this._right.crossVectors(this._dir, this._up).normalize();

    // Landing dip is a spring on the pivot height, not on the FOV — it reads as
    // the body absorbing the impact rather than as a lens effect.
    this.dipVel += (-90 * this.dip - 13 * this.dipVel) * Math.min(dt, 1 / 60);
    this.dip += this.dipVel * Math.min(dt, 1 / 60);
    this.dip = clamp(this.dip, -0.6, 0.2);

    // Look-ahead is a *translation* of the boom pivot, never a rotation: it
    // shifts the framing toward where the survivor is travelling without ever
    // moving the aim axis, so it cannot fight mouse input or swim under it.
    // Only the lateral component leads — a forward lead would push the camera
    // in toward the player's back instead of opening the space ahead. Forward
    // speed is handled by the boom extension below.
    const v = player.velocity;
    const strafe = v ? (v.x * this._right.x + v.z * this._right.z) : 0;
    const lead = clamp(strafe * LEAD_STRAFE, -LEAD_MAX, LEAD_MAX);

    const crouch = player.dashT > 0 ? player.dashT * 0.35 : 0;
    this._tmp.copy(player.position);
    this._tmp.y += PIVOT_HEIGHT + this.dip - crouch;
    this._tmp.addScaledVector(this._right, SHOULDER + lead);

    if (!this._initialised) {
      this.pivot.copy(this._tmp);
      this.lookAt.copy(this._tmp);
      this._initialised = true;
    }
    this.pivot.x = smooth(this.pivot.x, this._tmp.x, POS_TAU, dt);
    this.pivot.y = smooth(this.pivot.y, this._tmp.y, POS_TAU * 1.5, dt); // vertical lags more: stairs/jumps stay calm
    this.pivot.z = smooth(this.pivot.z, this._tmp.z, POS_TAU, dt);

    this.lookAt.x = smooth(this.lookAt.x, this._tmp.x, LOOK_TAU, dt);
    this.lookAt.y = smooth(this.lookAt.y, this._tmp.y, LOOK_TAU, dt);
    this.lookAt.z = smooth(this.lookAt.z, this._tmp.z, LOOK_TAU, dt);

    // --- occlusion ----------------------------------------------------------
    // Sphere-cast approximation: a 5-ray fan offset around the boom axis. The
    // shortest unobstructed length wins.
    // Boom length leads forward motion: at speed the camera falls back so the
    // ground ahead of the survivor opens up. Smoothed by the same snap-in /
    // ease-out the occlusion path uses, so it never lurches.
    const sprintT = player.sprintBlend || 0;
    const speedT = clamp((player.horizontalSpeed || 0) / 14, 0, 1);
    const boom = DIST + speedT * DIST_SPEED;

    this._desired.copy(this.pivot).addScaledVector(this._dir, -boom);
    let allowed = boom;
    if (ctx.stage?.raycastDistance) {
      const back = this._tmp.copy(this._dir).negate();
      for (let i = 0; i < 5; i++) {
        this._origin.copy(this.pivot);
        if (i > 0) {
          const a = (i - 1) * (Math.PI / 2);
          this._origin.addScaledVector(this._right, Math.cos(a) * CAM_RADIUS);
          this._origin.y += Math.sin(a) * CAM_RADIUS;
        }
        const reach = boom + CAM_RADIUS;
        const d = ctx.stage.raycastDistance(this._origin, back, reach);
        if (d < 0) continue;
        const pull = Math.max(MIN_DIST, d - CAM_RADIUS);
        // Only hits that would yank the boom in by more than SNAP_MAX in a
        // single frame are worth a second question. Asking it of *every* hit
        // was measured worse, not better: ignoring far slivers lets the boom
        // stay long for a frame or two and then snap when the sliver widens,
        // which trades one lurch for several.
        if (pull < this.distance - SNAP_MAX && this._sliver(ctx, this._origin, back, reach, d)) continue;
        allowed = Math.min(allowed, pull);
      }
    }
    // Snap in, ease out — clipping through geometry for even one frame is far
    // more offensive than a slightly slow recovery.
    this.targetDistance = allowed < this.distance
      ? this.distance - this._rateLimitedPull(this.distance - allowed, dt)
      : smooth(this.distance, allowed, OCCLUDE_OUT_TAU, dt);
    this.distance = this.targetDistance;

    this.camPos.copy(this.pivot).addScaledVector(this._dir, -this.distance);

    // --- fov ----------------------------------------------------------------
    this.fovPunchVel += (-140 * this.fovPunch - 17 * this.fovPunchVel) * Math.min(dt, 1 / 60);
    this.fovPunch += this.fovPunchVel * Math.min(dt, 1 / 60);
    this.fovPunch = clamp(this.fovPunch, -8, 12);

    // The player's dial, remapped around the new base. Menus.apply() also pokes
    // `camera.fov` directly, but that only survives while this rig is detached
    // (menus, cinematics, the screenshot harness) — in gameplay the setting has
    // to arrive here or it does nothing at all.
    const baseFov = clamp(
      FOV_BASE + ((settings?.fov ?? FOV_SETTING_DEFAULT) - FOV_SETTING_DEFAULT) * FOV_SETTING_SCALE,
      FOV_MIN, FOV_MAX,
    );
    const targetFov = baseFov + sprintT * FOV_SPRINT + speedT * 2.5;
    this.fov = smooth(this.fov, targetFov, 0.12, dt) + 0;
    ctx.camera.fov = this.fov + this.fovPunch;
    ctx.camera.updateProjectionMatrix();

    // --- roll ---------------------------------------------------------------
    // Signed strafe velocity in camera space (computed with the look-ahead,
    // above) -> a couple of degrees of bank.
    const targetRoll = clamp(-strafe / 10, -1, 1) * 0.045 + player.dashRoll * 0.10;
    this.roll = smooth(this.roll, targetRoll, 0.13, dt);

    // --- commit -------------------------------------------------------------
    ctx.camera.position.copy(this.camPos);
    this._m.lookAt(this.camPos, this.lookAt, this._up);
    this._q.setFromRotationMatrix(this._m);
    ctx.camera.quaternion.copy(this._q);
    ctx.camera.rotateZ(this.roll);
  }

  /**
   * How much of a requested `drop` in boom length this frame may actually
   * spend. Distance-dependent by construction: the first SNAP_MAX of it is
   * free, and only the excess above that is rated, so the clamps that protect
   * against clipping — which are small, because the camera is nearly touching
   * the thing — are still instant, while the ones large enough to read as a
   * cut are spread over a few frames.
   *
   * Frame-rate independent: the excess decays on SNAP_IN_TAU, so a run at 30
   * or 144 fps resolves the same clamp over the same wall-clock interval
   * rather than the same number of frames.
   */
  _rateLimitedPull(drop, dt) {
    if (drop <= SNAP_MAX) return drop;
    const excess = drop - SNAP_MAX;
    return SNAP_MAX + excess * (1 - Math.exp(-dt / SNAP_IN_TAU));
  }

  /**
   * Is the obstruction `d` metres back along this ray thin enough that the
   * camera can just sit behind it?
   *
   * The near hit alone cannot tell a stalagmite the survivor is standing inside
   * from a wall he is pressed against — both report a tiny `d`. What separates
   * them is what lies *beyond*: a second cast, fired from the far end of the
   * boom back toward the pivot, finds the obstruction's other face and so
   * measures its thickness along the boom axis.
   *
   * That reverse cast is the load-bearing part, and it is safe precisely
   * because the stage raycaster is front-face only:
   *  - Thin spire: the boom end stands in open air behind it, the reverse cast
   *    hits its far face, and the thickness comes back a handful of
   *    centimetres. Ignoring the ray leaves a sliver of rock crossing the
   *    frame for a few frames, which is nothing next to a 7 m lurch.
   *  - Wall or cliff: the boom end is *inside* the rock, so the reverse cast
   *    sees only back faces and reports nothing at all. Thickness is infinite,
   *    the ray is honoured, and the boom clamps exactly as it always has. This
   *    is the case a bare `d > CAM_RADIUS` guard throws away, and why that
   *    guard clips through walls where this does not.
   *  - Anything else in the way of the reverse cast only shortens it, which
   *    reads as thicker, which keeps the clamp. The failure direction is the
   *    conservative one.
   */
  _sliver(ctx, origin, back, reach, d) {
    this._far.copy(origin).addScaledVector(back, reach);
    this._fwd.copy(back).negate();
    const e = ctx.stage.raycastDistance(this._far, this._fwd, reach - d);
    if (e < 0) return false;
    return reach - e - d <= SLIVER_MAX;
  }

  /** Aim basis for gameplay: camera forward through screen centre. */
  aimDirection(out) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();
  }
}
