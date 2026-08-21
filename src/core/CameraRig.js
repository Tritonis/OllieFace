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

// --- anticipation and the snap-in rate cap (#115) ---------------------------
//
// The works biome produces boom collapses of 6.8 m in a single frame — 32x the
// 0.213 m free-flight mean — and unlike #110 they are not misattributed
// slivers: a paired sweep with _sliver enabled and neutralised returns
// identical numbers. They are clamps the rule *correctly* leaves alone. The
// camera is where it belongs; it simply arrived there faster than anyone can
// read.
//
// The obvious fix — rate-limit the pull-in — is not available on its own, and
// the measurement says so plainly: at every one of those frames `distance`
// equals `allowedDistance` exactly. The fan's verdict is what teleports, so
// any lag between the boom and that verdict is a boom sitting past the
// obstruction, i.e. a camera inside rock. That is the #110 rejected fix
// wearing a different hat, and tests/camera-occlusion.test.mjs pins it.
//
// So the rate cap needs something to spend, and the only thing that can pay for
// it without clipping is *lead time*: a second, softer reach that is only ever
// shorter than the hard one. The boom is driven toward the soft reach under the
// cap and then clamped to the hard reach last, so the cap can delay a pull-in
// the fan has not demanded yet and never one it has. When the anticipation
// lands, the pull-in is already underway before the obstruction reaches the
// hard clamp. When it misses, the clamp still applies at full force: the
// smoothing is forfeited, the correctness is not.
//
// The lead signal is the fan's own discarded work, and finding that took one
// refuted attempt worth recording. The first version cast a second fan from the
// pivot extrapolated 0.22 s along the survivor's velocity. It bought nothing —
// worst frame 6.834 -> 6.830 — and cost a great deal: frames with the boom on
// its 0.7 m floor went 2433 -> 4461 at pitch 0.5, because leading uphill finds
// the slope early everywhere. Obstructions here do not arrive from ahead of the
// pivot; they rise behind it.
//
// What the fan already knows is better. At the frames that collapse, one ray
// has been closing smoothly for several frames — 1.46, 1.28, 1.11, 0.94 m — and
// `allowed` sits at its full 7.679 throughout, because _sliver is skipping that
// hit. The skip then stops applying and the whole accumulated pull-in arrives
// at once. The rig had three frames of monotone warning and threw every one of
// them away.
//
// So a skipped hit is no longer discarded silently: it is remembered as a
// *soft* reach. The boom eases toward the soft reach at the capped rate while
// the hard reach still clamps, and because a soft reach is only ever shorter
// than the hard one, moving toward it cannot put the camera inside anything.
// The skip keeps its #110 meaning exactly — the boom is not *clamped* to a
// sliver, so a Jersey barrier is still no reason to yank to the floor — it
// simply stops being invisible.

// Pull-ins at or under this are simply taken. A third of a metre is inside the
// noise of an ordinary frame's boom adjustment; rate-limiting it would add
// mush to the common case to buy nothing.
const SNAP_INSTANT = 0.35;

// Anything longer approaches at this constant speed instead. A *rate*, not the
// exponential the rest of this file smooths with, and the difference is not
// cosmetic. Warning is scarce here: a fan ray typically reports an obstruction
// three or four frames before the clamp lands, so the entire budget is that
// handful of frames and the cap has to spend it evenly. An exponential spends
// it backwards — it moves fastest while the gap is largest and slowest as it
// closes, so it covered 1.16, 0.93 and 0.75 m of a 6.4 m collapse on heading 0
// and left 3.48 m for the clamp. A flat rate over the same three frames leaves
// roughly a third of that.
//
// 100 m/s is 1.67 m per frame at 60 Hz, which is about eight times free flight
// — fast enough to consume three frames of warning almost completely, slow
// enough that the eye tracks the boom instead of being cut to its far end.
const SNAP_IN_RATE = 100;

// How long a soft reach is remembered once the ray that raised it stops
// reporting. This is the expensive dial, and it is expensive in the one
// currency the rig cannot print: boom length. A remembered warning holds the
// boom shorter, so smoothing here is bought directly out of framing, and the
// exchange rate is steep. Measured over the same 14,400-frame works sweep
// (reviews/camera-115/sweep-tau*.json), worst single-frame camera translation
// against mean boom length at pitch -0.17:
//
//   tau    worst @ -0.17 / 0.5 / 1.05      mean boom @ -0.17
//   off        6.834 / 5.994 / 6.158           5.206     sweep-before.json
//   0.30       6.417 / 4.109 / 4.273           4.484     sweep-hold030.json
//   0.55       6.012 / 2.930 / 3.092           4.089     sweep-after.json
//   1.10       4.948 / 1.773 / 1.930           3.511     sweep-hold110.json
//
// That table is stage 3, which is where the ticket lives and where the knee was
// found. The cost is not confined to stage 3, and an independent A/B at the
// default pitch over the same 16x900 sweep on every stage says so plainly --
// worst single-frame translation, frames translating over a metre, mean boom:
//
//   stage   worst            >1 m         mean boom
//     0     6.840 -> 4.632   106 -> 115   6.517 -> 5.903   (-9.4 %)
//     1     6.951 -> 6.860   283 -> 267   5.459 -> 4.436   (-18.7 %)
//     2     3.954 -> 3.426    36 ->  48   5.403 -> 4.531   (-16.1 %)
//     3     6.834 -> 6.012    53 ->  76   5.206 -> 4.089   (-21.4 %)
//     4     6.832 -> 6.820   104 ->  89   5.742 -> 5.026   (-12.5 %)
//
// Stage 1 pays 18.7 % of its boom for 90 mm of worst frame; stage 4 pays 12.5 %
// for 12 mm. Both are nearly all unwarned graze events, which memory cannot
// help, so on those stages the tuning is close to pure cost. This was measured
// and accepted rather than overlooked: 0.55 is a deliberate choice to spend
// boom length everywhere to buy legibility where the warning exists.
//
// The >1 m column is the other half of the honesty and rises on stages 0, 2 and
// 3 (53 -> 76 on stage 3, +43 %). That is the rate cap working as designed
// rather than a regression: it converts one unbounded teleport into several
// bounded steps, and SNAP_IN_RATE fixes the ceiling of a step at 1.67 m per
// frame. More frames cross a metre; none of them cross 1.67 m unless the hard
// clamp put them there.
//
// 0.55 is the knee. It halves the worst frame at the two pitches where the
// warning exists to be remembered, for a fifth of the boom; going on to 1.10
// buys another third of a metre of worst-case at the cost of another tenth of
// the frame, which is the wrong side of the trade for a camera whose whole
// framing argument is a long lens on a long boom.
//
// It does almost nothing at pitch -0.17, and that is not a tuning failure. The
// residual collapses there have no warning to remember: heading 5 frame 253
// reports -1 on every one of the five rays for the five preceding frames and
// then 1.33 m, because the boom is trailing back and *down* into a slope the
// survivor is descending and the cast is near-tangent to it. A ray at grazing
// incidence has a genuinely discontinuous intersection distance, and no amount
// of memory anticipates a discontinuity. Smoothing those would mean holding the
// boom out past the fan's verdict, which is a camera inside the hill.
//
// Lowering this to buy the boom back was tried against the capture gate on
// 2026-08-19 and does not work; the sweep is `tools/camera-tau-sweep.mjs` and
// the manifests are in reviews/115-retune/. Two things close the door. First
// the legal window has a floor: the whole-surface stage-3 ceiling in
// tests/camera-occlusion.test.mjs reads 6.492 m at tau 0.20 and 6.510 m at
// 0.15, so anything below ~0.18 fails a shipped guard rather than merely
// costing quality. Second, inside [0.20, 0.55] the gate the shots fail on is
// not monotone in boom length at all. `worstGatedSep` is a minimum over a set
// whose *membership* moves with framing -- a longer boom makes subjects
// smaller, so fewer clear the pixel gate, so the min is taken over fewer
// objects. Three full runs, 10-inventory's worst gated separation against the
// 0.27 it needs: 0.27 at tau off (exactly the threshold, zero headroom), 0.19
// at 0.25, 0.17 at 0.40, 0.19 at 0.55. It does not trend. tau 0.25 also broke
// 06-loaded-hud, which neither the baseline nor 0.55 breaks. Restoring those
// shots is a framing or a threshold question, not a tuning one.
const SOFT_HOLD_TAU = 0.55;

const POS_TAU = 0.055;      // camera position follow — short, stays responsive
const LOOK_TAU = 0.105;     // look-at target — longer, so framing lags the body
const OCCLUDE_OUT_TAU = 0.30;

// How many consecutive frames a *skipped* hit must keep warning before its
// reach is allowed to pull the boom in (#132).
//
// The soft-hold memory added in #115 is deliberately hair-triggered: one frame
// of warning and the boom starts easing in, because a warning that resolves
// into a real clamp two frames later is worth acting on early. The playtest
// cost of that is the other half of the same coin -- a single grazing frame
// off a passing survivor, a corpse, or a slope crossing the fan for one
// sixtieth of a second dollies the camera in and then eases it back out over
// SOFT_HOLD_TAU, which is the "erratic" the packaged build was reported for.
// Two frames is the smallest hysteresis that separates the two: a genuine
// approach warns monotonically for three or four frames (#115's own repro
// measures 1.46, 1.28, 1.11, 0.94) and loses one frame of anticipation, while
// a one-frame graze now costs nothing at all.
//
// This gates only the SOFT path. The hard reach `_fan` returns still clamps on
// the frame it appears -- hysteresis there would be a camera holding station
// inside rock, which is the one thing this rig may never do.
const SOFT_HOLD_FRAMES = 2;

// How far an unconfirmed (single-frame) warning may pull the boom in, and the
// speed below which that cap applies at all.
//
// The cap is speed-gated because the two failures it sits between are: at a
// dead run, geometry that crosses the fan for one frame is almost always a
// real approach -- the survivor is closing on it at 9 m/s -- and the boom has
// to start easing on the first hint or the hard clamp lands as a teleport
// (#115, and the sweep below: capping unconfirmed pulls at sprint re-inflates
// heading 0 from 1.52 m to 3.37 m, straight through that issue's 2 m ceiling).
// Standing or walking, the same one-frame reach change is a survivor walking
// past, a corpse settling, or a slope at grazing incidence, and acting on it
// is exactly the erratic dolly-in-and-back the packaged build was reported for
// (#132). Nothing the player did moved the camera, so nothing should have.
const UNCONFIRMED_PULL = 0.25;
const HYSTERESIS_SPEED = 4.0;

// --- player zoom (#133) -----------------------------------------------------
// A scalar on the boom rather than an absolute distance, so it composes with
// the speed extension instead of fighting it: at 1.6 a sprinting camera still
// leads further than a standing one.
const ZOOM_MIN = 0.45;      // 3.2 m -- over the shoulder, still third person
const ZOOM_MAX = 1.6;       // 11.4 m
const ZOOM_WHEEL_STEP = 0.08;   // per wheel notch
const ZOOM_PAD_RATE = 0.6;      // per second held on the d-pad / zoom keys
const ZOOM_TAU = 0.09;          // the dolly is smoothed, never stepped
// Quiet time before a wheel-driven zoom is written to the settings blob. The
// slider path saves on every input event because a drag is a handful of them;
// a wheel spin is dozens, and localStorage is not free.
const ZOOM_COMMIT_IDLE = 0.4;

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

    // The player's dolly (#133). `zoomTarget` is what input moves; `zoom` is
    // the smoothed value the boom actually uses. Seeded from the stored
    // setting so a run opens at the distance the last one ended on.
    this._zoomSetting = clamp(ctx.settings?.cameraZoom ?? 1, ZOOM_MIN, ZOOM_MAX);
    this.zoomTarget = this._zoomSetting;
    this.zoom = this._zoomSetting;
    // False until the first `_zoomInput`: see the snap-vs-ease note there.
    this._zoomAdopted = false;
    this._zoomIdle = 0;
    this._zoomDirty = false;
    // The occlusion fan's verdict for the frame: the longest boom that stays
    // clear of geometry. `distance` is derived from this and must never exceed
    // it — a boom sitting longer than `allowedDistance` is a camera inside
    // rock. It is published beside the two values it constrains rather than
    // handed out through a debug hook, because it is the same kind of thing
    // they are: a per-frame output of lateUpdate, meaningful to anything that
    // reads `distance` at all. Nothing in the rig reads it back, so it cannot
    // change behaviour.
    this.allowedDistance = DIST;
    // The lead fan's verdict, always <= allowedDistance. Published for the same
    // reason: it is what the boom is aiming at, and a test that wants to know
    // whether the rate cap had anything to spend has to be able to see it.
    this.anticipatedDistance = DIST;

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
    this._back = new THREE.Vector3();
    // Per-frame scratch: the shortest reach any ray asked for, skipped or not.
    this._soft = DIST;
    // The same, held across frames so a flickering graze is not forgotten.
    this._softHold = DIST;
    // Consecutive frames the soft reach has been warning for. See SOFT_HOLD_FRAMES.
    this._softStreak = 0;
    // Deepest reach seen during the current streak.
    this._softMin = Infinity;
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
    //
    // Asked of `ctx.menus`, never of `ctx.hud.menus`. Menus became a system of
    // its own in #118, so "the HUD is gone" and "the menus are gone" are now
    // separate facts: six HUD throws blank `ctx.hud` while Menus keeps running
    // its own update, and routing through the dead one answered "no menu open"
    // with the pause screen up and taking input. Reading the owner directly is
    // also strictly stronger — `HUD.menus` is `ctx.menus` behind a liveness
    // test it has no business applying to somebody else's system.
    const menuOpen = !!ctx.menus?.screen;
    if (pad?.active && input.enabled !== false && !menuOpen) {
      const padSens = clamp(settings?.padSensitivity ?? 1, 0.05, 8);
      this.yaw -= pad.lookX * PAD_YAW_RATE * padSens * dt;
      this.pitch -= pad.lookY * PAD_PITCH_RATE * padSens * dt;
    }
    this._zoomInput(ctx, input, settings, menuOpen, dt);

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
    const boom = (DIST + speedT * DIST_SPEED) * this.zoom;

    this._desired.copy(this.pivot).addScaledVector(this._dir, -boom);

    // The no-adjustment camera (#132). Occlusion *avoidance* -- the five-ray
    // fan, the sliver test, the soft memory, the snap-in rate -- is the whole
    // of what a player experiences as the camera moving on its own, and for
    // some players that is worse than an obstructed view they can turn out of
    // themselves. Off, the boom keeps exactly the length the player asked for
    // and a single axial cast stops it entering a surface.
    //
    // Collision is deliberately kept. A camera that clips through the world is
    // not "no adjustment", it is a bug with a settings entry: the horizon pops
    // through the wall, the depth buffer fills with backfaces, and on a slope
    // the view is simply underground. What the setting removes is the rig
    // making framing decisions; what it keeps is the rig staying in the world.
    if ((settings?.cameraAssist ?? 1) === 0) {
      const hard = this._collide(ctx, this.pivot, boom);
      this._soft = hard;
      this._softHold = hard;
      this._softStreak = 0;
      this._softMin = Infinity;
      this.allowedDistance = hard;
      this.anticipatedDistance = hard;
      this.targetDistance = hard;
      this.distance = hard;
      this._commit(ctx, dt, player, sprintT, speedT, strafe, settings);
      return;
    }

    this._soft = boom;
    const allowed = this._fan(ctx, this.pivot, boom);
    this.allowedDistance = allowed;

    // The soft reach is held rather than re-read, because the warning it is
    // built from flickers. At grazing incidence — the boom trailing back and
    // down into a slope the survivor is descending, which is what the works
    // biome is full of — a fan ray crosses the surface on some frames and
    // misses on the next: heading 14 reports 0.10 m on frame 226, nothing at
    // all on 227-230, 0.94 m on 231, and then the clamp lands on 232. Read
    // fresh each frame, the boom eases in on 226 and spends the next four
    // frames easing back out again, so it arrives at the clamp having made no
    // progress at all.
    //
    // So the shortest reach any ray asked for is taken instantly and released
    // on the same time constant the boom's own recovery uses. Memory of a
    // warning costs a slightly shorter boom for a few tenths of a second after
    // a graze; forgetting it costs the teleport.
    // Hysteresis, per SOFT_HOLD_FRAMES: a warning has to survive a second frame
    // before the boom is allowed to act on it. Deferred, not discarded --
    // `_softMin` keeps the deepest reach seen anywhere in the streak, so the
    // frame the gate opens acts on the whole warning rather than on whatever
    // the latest ray happened to say.
    if (this._soft < boom - 1e-6) {
      this._softStreak++;
      this._softMin = Math.min(this._softMin, this._soft);
    } else {
      this._softStreak = 0;
      this._softMin = Infinity;
    }
    // An unconfirmed warning is worth something -- it is how #115's collapses
    // get anticipated at all -- but below walking pace it may pull the camera
    // in by at most UNCONFIRMED_PULL, so a single grazing frame costs a nudge
    // instead of a metres-long dolly in and back out again. A warning that
    // repeats spends its full depth from the next frame on either way.
    const settled = (player.horizontalSpeed || 0) < HYSTERESIS_SPEED;
    const softReach = (this._softStreak >= SOFT_HOLD_FRAMES || !settled)
      ? this._softMin
      : Math.max(this._softMin, this.distance - UNCONFIRMED_PULL);
    this._softHold = Math.min(softReach, smooth(this._softHold, boom, SOFT_HOLD_TAU, dt));
    // The rate cap's entire budget.
    const anticipated = Math.min(allowed, this._softHold);
    this.anticipatedDistance = anticipated;

    // Snap in, ease out. The asymmetry is unchanged and deliberate — clipping
    // through geometry for even one frame is far more offensive than a slow
    // recovery — but "instant" and "correct" are now separated. The pull-in
    // aims at the *anticipated* reach on a rate cap, and is then clamped to the
    // reach the present frame actually permits. Since that clamp is applied
    // last and only ever shortens, no amount of rate limiting can leave the
    // boom past the obstruction: the cap can delay a pull-in the fan has not
    // demanded yet, never one it has.
    let target;
    if (anticipated < this.distance) {
      const pull = this.distance - anticipated;
      const step = Math.max(SNAP_INSTANT, SNAP_IN_RATE * dt);
      target = pull <= step ? anticipated : this.distance - step;
    } else {
      target = smooth(this.distance, anticipated, OCCLUDE_OUT_TAU, dt);
    }
    this.targetDistance = Math.min(target, allowed);
    this.distance = this.targetDistance;

    this._commit(ctx, dt, player, sprintT, speedT, strafe, settings);
  }

  /**
   * Everything downstream of the boom length: camera position, FOV, roll and
   * the transform. Its own method because the no-adjustment path above resolves
   * the boom differently and then needs all of this, verbatim -- a second copy
   * is how the two branches would drift.
   */
  _commit(ctx, dt, player, sprintT, speedT, strafe, settings) {
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
   * The player's dolly (#133): wheel notches, plus the two bound zoom actions
   * for the pad and the keyboard, into a clamped scalar on the boom.
   *
   * Gated exactly as the look path is -- pointer lock for the wheel (Input only
   * accumulates while locked), `input.enabled` and "no screen open" for the
   * buttons -- so a thumb on the d-pad behind the pause menu does not quietly
   * re-frame the world the player comes back to.
   *
   * The committed value round-trips through `ctx.settings`, which Menus owns
   * and replaces wholesale, so the setting is re-read every frame and adopted
   * whenever it moves under us: the settings slider and the wheel are two views
   * of one number rather than two numbers that drift.
   */
  _zoomInput(ctx, input, settings, menuOpen, dt) {
    const stored = clamp(settings?.cameraZoom ?? 1, ZOOM_MIN, ZOOM_MAX);
    if (stored !== this._zoomSetting) {
      this._zoomSetting = stored;
      this.zoomTarget = stored;
      this._zoomDirty = false;
      // The FIRST adoption is a snap, every later one an ease, and the split is
      // about who moved the number. The constructor seeds `zoom` from
      // `ctx.settings`, but Menus publishes the stored settings blob after the
      // rig is added, so the real value always arrives on a later frame than
      // the default did — and easing to it meant every boot opened at the
      // default distance and glided ~0.3 s to the player's chosen one. A camera
      // drifting on its own the moment a run starts reads as a bug, not a
      // preference being honoured. Once the player is in the world, though, a
      // settings change under the same code path is a change they are watching
      // for, and there the ease is the right answer.
      if (!this._zoomAdopted) this.zoom = stored;
    }
    this._zoomAdopted = true;

    const live = input && input.enabled !== false && !menuOpen;
    let delta = 0;
    if (live) {
      if (input.wheel) delta += input.wheel * ZOOM_WHEEL_STEP;
      const b = input.bindings;
      if (b) {
        if (input.down(b.code('zoomOut'))) delta += ZOOM_PAD_RATE * dt;
        if (input.down(b.code('zoomIn'))) delta -= ZOOM_PAD_RATE * dt;
      }
    }
    if (delta) {
      const next = clamp(this.zoomTarget + delta, ZOOM_MIN, ZOOM_MAX);
      if (next !== this.zoomTarget) { this.zoomTarget = next; this._zoomDirty = true; }
      this._zoomIdle = 0;
    } else if (this._zoomDirty) {
      this._zoomIdle += dt;
      if (this._zoomIdle >= ZOOM_COMMIT_IDLE) {
        this._zoomDirty = false;
        this._zoomSetting = this.zoomTarget;
        ctx.menus?.setCameraZoom?.(this.zoomTarget);
      }
    }

    this.zoom = smooth(this.zoom, this.zoomTarget, ZOOM_TAU, dt);
  }

  /**
   * One ray of the sphere-cast approximation: the centre of the cast for
   * `i === 0`, and the four cardinal points of the CAM_RADIUS circle around
   * the boom axis for 1-4. Writes `_origin` and returns it.
   *
   * Shared by `_fan` and `_collide` rather than copied into each. The five
   * offsets ARE the sphere: drop them and the "camera" being kept out of the
   * world is a dimensionless point, which is a lens that slides through
   * anything whose surface misses one exact line.
   */
  _ray(from, i) {
    this._origin.copy(from);
    if (i > 0) {
      const a = (i - 1) * (Math.PI / 2);
      this._origin.addScaledVector(this._right, Math.cos(a) * CAM_RADIUS);
      this._origin.y += Math.sin(a) * CAM_RADIUS;
    }
    return this._origin;
  }

  /**
   * Collision only: the same five-ray sphere as the fan, and nothing else the
   * fan does. Every hard hit counts, at face value -- no sliver classification,
   * no soft memory, no hysteresis, no anticipation, no rate cap. Returns the
   * longest boom whose sphere is clear of geometry.
   *
   * The line the no-adjustment setting draws is between the rig making framing
   * decisions and the rig staying in the world, and the sphere is on the
   * staying-in-the-world side of it. A single axial cast would put it on the
   * wrong side: geometry that clips the camera's own radius while missing the
   * centreline -- a pillar edge, a doorframe, the lip of a ramp -- is exactly
   * what a 0.34 m sphere is approximating, and ignoring it ships a lens inside
   * the level. What the setting removes is proactive adjustment, not collision.
   */
  _collide(ctx, from, boom) {
    if (!ctx.stage?.raycastDistance) return boom;
    const back = this._back.copy(this._dir).negate();
    const reach = boom + CAM_RADIUS;
    let allowed = boom;
    for (let i = 0; i < 5; i++) {
      const d = ctx.stage.raycastDistance(this._ray(from, i), back, reach);
      if (d < 0) continue;
      allowed = Math.min(allowed, Math.max(MIN_DIST, d - CAM_RADIUS));
    }
    return allowed;
  }

  /**
   * The occlusion fan: a 5-ray sphere-cast approximation offset around the boom
   * axis, fired backward from `from`. Returns the longest boom that stays clear
   * of geometry, which is `boom` itself when nothing is in the way.
   *
   * It also leaves `_soft` holding the shortest reach *any* ray asked for,
   * including hits _sliver waved through, which is what the #115 rate cap
   * eases toward. `_soft` is the caller's to reset each frame.
   */
  _fan(ctx, from, boom) {
    let allowed = boom;
    if (!ctx.stage?.raycastDistance) return allowed;
    const back = this._back.copy(this._dir).negate();
    const reach = boom + CAM_RADIUS;
    for (let i = 0; i < 5; i++) {
      const d = ctx.stage.raycastDistance(this._ray(from, i), back, reach);
      if (d < 0) continue;
      const pull = Math.max(MIN_DIST, d - CAM_RADIUS);
      // Only hits that would yank the boom in by more than SNAP_MAX in a
      // single frame are worth a second question. Asking it of *every* hit
      // was measured worse, not better: ignoring far slivers lets the boom
      // stay long for a frame or two and then snap when the sliver widens,
      // which trades one lurch for several.
      if (pull < this.distance - SNAP_MAX && this._sliver(ctx, this._origin, back, reach, d)) {
        // Skipped, not forgotten. See the SNAP_IN_RATE commentary above.
        if (pull < this._soft) this._soft = pull;
        continue;
      }
      allowed = Math.min(allowed, pull);
      if (pull < this._soft) this._soft = pull;
    }
    return allowed;
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
