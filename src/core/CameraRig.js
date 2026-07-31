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
 */

// Exponential smoothing expressed as a time constant, which is easier to tune
// by feel than MathUtil's per-second rate.
const smooth = (a, b, tau, dt) => b + (a - b) * Math.exp(-dt / Math.max(tau, 1e-4));

const PITCH_MIN = -1.15;
const PITCH_MAX = 1.05;

const FOV_BASE = 70;
const FOV_SPRINT = 8;

const DIST = 5.4;
const SHOULDER = 0.65;      // right-shoulder offset, keeps the crosshair clear
const PIVOT_HEIGHT = 1.55;
const CAM_RADIUS = 0.34;    // approximated sphere-cast radius

const POS_TAU = 0.055;      // camera position follow — short, stays responsive
const LOOK_TAU = 0.105;     // look-at target — longer, so framing lags the body
const OCCLUDE_OUT_TAU = 0.30;

export class CameraRig {
  init(ctx) {
    ctx.cameraRig = this;
    this.ctx = ctx;

    this.sensitivity = 0.0022;
    this.yaw = 0;
    this.pitch = -0.12;
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
    if (input && input.locked && input.enabled !== false) {
      this.yaw -= input.mouse.dx * this.sensitivity;
      this.pitch -= input.mouse.dy * this.sensitivity;
      this.pitch = clamp(this.pitch, PITCH_MIN, PITCH_MAX);
    }
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

    const crouch = player.dashT > 0 ? player.dashT * 0.35 : 0;
    this._tmp.copy(player.position);
    this._tmp.y += PIVOT_HEIGHT + this.dip - crouch;
    this._tmp.addScaledVector(this._right, SHOULDER);

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
    this._desired.copy(this.pivot).addScaledVector(this._dir, -DIST);
    let allowed = DIST;
    if (ctx.stage?.raycastDistance) {
      const back = this._tmp.copy(this._dir).negate();
      for (let i = 0; i < 5; i++) {
        this._origin.copy(this.pivot);
        if (i > 0) {
          const a = (i - 1) * (Math.PI / 2);
          this._origin.addScaledVector(this._right, Math.cos(a) * CAM_RADIUS);
          this._origin.y += Math.sin(a) * CAM_RADIUS;
        }
        const d = ctx.stage.raycastDistance(this._origin, back, DIST + CAM_RADIUS);
        if (d >= 0) allowed = Math.min(allowed, Math.max(0.7, d - CAM_RADIUS));
      }
    }
    // Snap in, ease out — clipping through geometry for even one frame is far
    // more offensive than a slightly slow recovery.
    this.targetDistance = allowed < this.distance
      ? allowed
      : smooth(this.distance, allowed, OCCLUDE_OUT_TAU, dt);
    this.distance = this.targetDistance;

    this.camPos.copy(this.pivot).addScaledVector(this._dir, -this.distance);

    // --- fov ----------------------------------------------------------------
    const sprintT = player.sprintBlend || 0;
    const speedT = clamp((player.horizontalSpeed || 0) / 14, 0, 1);
    this.fovPunchVel += (-140 * this.fovPunch - 17 * this.fovPunchVel) * Math.min(dt, 1 / 60);
    this.fovPunch += this.fovPunchVel * Math.min(dt, 1 / 60);
    this.fovPunch = clamp(this.fovPunch, -8, 12);

    const targetFov = FOV_BASE + sprintT * FOV_SPRINT + speedT * 2.5;
    this.fov = smooth(this.fov, targetFov, 0.12, dt) + 0;
    ctx.camera.fov = this.fov + this.fovPunch;
    ctx.camera.updateProjectionMatrix();

    // --- roll ---------------------------------------------------------------
    // Signed strafe velocity in camera space -> a couple of degrees of bank.
    const v = player.velocity;
    const strafe = v ? (v.x * this._right.x + v.z * this._right.z) : 0;
    const targetRoll = clamp(-strafe / 10, -1, 1) * 0.045 + player.dashRoll * 0.10;
    this.roll = smooth(this.roll, targetRoll, 0.13, dt);

    // --- commit -------------------------------------------------------------
    ctx.camera.position.copy(this.camPos);
    this._m.lookAt(this.camPos, this.lookAt, this._up);
    this._q.setFromRotationMatrix(this._m);
    ctx.camera.quaternion.copy(this._q);
    ctx.camera.rotateZ(this.roll);
  }

  /** Aim basis for gameplay: camera forward through screen centre. */
  aimDirection(out) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();
  }
}
