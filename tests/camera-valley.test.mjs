// tests/camera-valley.test.mjs
//
// The camera in a narrow valley (#185): two walls, both within the boom's
// reach, for hundreds of consecutive frames.
//
// The rig's occlusion path was tuned against *transient* obstruction -- a spire
// crossing the fan (#110), a slope grazing it (#115), a survivor walking past
// (#132). All three are events: a warning arrives, the boom answers it, the
// warning ends. A canyon is not an event. The warning never ends, and one of
// the two walls is in reach on every frame of the traversal, which puts the
// soft-reach memory in a regime it was never measured in.
//
// The geometry here is synthetic on purpose. Stage 2's channels reproduce the
// complaint but not deterministically enough to assert on: the boom's answer
// depends on where the weave happens to put the survivor relative to a
// procedurally placed rock. Two analytic planes isolate the mechanism -- there
// is nothing in this corridor to hit *except* the two walls, so any chatter in
// the boom is the correction loop's own and not the terrain's.
import * as THREE from 'three';
import { CameraRig } from '../src/core/CameraRig.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// A little over 4 m across: wide enough that the survivor is never touching a
// wall, narrow enough that a boom swung 20 degrees off the corridor axis puts
// its far end into one.
const HALF_WIDTH = 2.1;

/**
 * A corridor running along Z, walled at x = +/-HALF_WIDTH. The walls are
 * unbounded in Y and Z, so the boom's pitch never lets it escape over the top
 * -- which is the point: this is a canyon, not a doorway.
 *
 * Signature and contract match Stage.raycastDistance: distance to the first
 * surface along `dir` within `maxDist`, or -1 for a clean ray.
 */
function corridor(origin, dir, maxDist) {
  let best = -1;
  for (const wall of [-HALF_WIDTH, HALF_WIDTH]) {
    if (Math.abs(dir.x) < 1e-9) continue;
    const t = (wall - origin.x) / dir.x;
    if (t <= 0 || t > maxDist) continue;
    if (best < 0 || t < best) best = t;
  }
  return best;
}

function makeCtx() {
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    settings: {},
    input: null,
    stage: { raycastDistance: corridor },
  };
}

/**
 * Walk the survivor down the corridor for `frames` at `speed`, sweeping the
 * look angle so the boom crosses from one wall to the other and back.
 *
 * The sweep is the repro, not decoration. A survivor holding a dead-straight
 * heading down the middle never troubles the fan; a player walking a canyon
 * looks around, and it is the boom swinging between the two walls -- each one
 * taking over the shortest-reach role from the other -- that the correction
 * loop has to stay calm through.
 */
function walk({ frames = 600, speed = 6, sweep = 0.42, period = 1.5 } = {}) {
  const ctx = makeCtx();
  const rig = new CameraRig();
  rig.init(ctx);
  const player = {
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, speed),
    horizontalSpeed: speed, sprintBlend: 0, dashT: 0, dashRoll: 0,
  };
  ctx.player = player;

  const dt = 1 / 60;
  const booms = [];
  const allowed = [];
  const deltas = [];
  let worstPen = 0;
  let prev = null;
  for (let f = 0; f < frames; f++) {
    // Facing down the corridor, looking left and right as a player does.
    rig.yaw = Math.PI + Math.sin((f * dt / period) * Math.PI * 2) * sweep;
    player.position.z += speed * dt;
    rig.lateUpdate(ctx, dt);
    // The clamp-ordering probe from tests/camera-occlusion.test.mjs. It cannot
    // catch a wrong reach, only a boom that disobeys the reach it computed --
    // which is exactly what a smoothing change is most likely to break.
    worstPen = Math.max(worstPen, rig.distance - rig.allowedDistance);
    booms.push(rig.distance);
    allowed.push(rig.allowedDistance);
    if (prev) deltas.push(rig.camPos.distanceTo(prev));
    prev = rig.camPos.clone();
  }
  return { booms, allowed, deltas, worstPen, frames };
}

/**
 * The longest run of consecutive frames on which the boom is held short of a
 * reach the fan is granting, and is not recovering toward it.
 *
 * This, and not a raw excursion count, is the assertion — and the distinction
 * took one refuted metric to find, so it is worth stating. The first version of
 * this file counted direction reversals of the boom. In a corridor that number
 * turns out to be one per half-cycle of the survivor's own look sweep: the
 * camera was answering the player's input, phase-locked, which is the rig
 * working. A metric that cannot separate "the camera moved" from "the camera
 * moved on its own" is measuring the test's driving function.
 *
 * A pin is unambiguous. The fan has said there is room, the boom is not taking
 * it, and nothing the player is doing accounts for that — the rig is simply
 * holding a stale grievance. It is also exactly what the #185 trace shows: 20
 * straight frames at 1.769 m with `allowedDistance` climbing through 5.760,
 * because the soft memory had latched on a graze thirty frames earlier and
 * only a fully clear frame could release it.
 */
function longestPin(booms, allowed, { slack = 1.0, moving = 1e-3 } = {}) {
  let worst = 0, run = 0, at = -1;
  for (let i = 1; i < booms.length; i++) {
    const stuck = allowed[i] - booms[i] > slack && booms[i] - booms[i - 1] < moving;
    run = stuck ? run + 1 : 0;
    if (run > worst) { worst = run; at = i; }
  }
  return { frames: worst, at };
}

const span = (a) => Math.max(...a) - Math.min(...a);

console.log('#185: a walk down a narrow canyon');
{
  const { booms, allowed, deltas, worstPen, frames } = walk();
  const mean = booms.reduce((s, x) => s + x, 0) / booms.length;
  const worstStep = Math.max(...deltas);
  const pin = longestPin(booms, allowed);
  console.log(`    boom mean=${mean.toFixed(3)} span=${span(booms).toFixed(3)} worstStep=${worstStep.toFixed(3)}`);
  console.log(`    longest pin: ${pin.frames} frames (ending ${pin.at}) in ${frames}`);
  console.log(`    clamp-order violation: worst=${worstPen.toExponential(2)} m`);

  // The #185 assertion. Before the fix this reads 6 frames at this slack, and
  // that number understates what it is catching: the pin it clips the end off
  // is 21 frames long, but for the first fifteen of them the fan has granted
  // less than the 1 m of slack the metric insists on before it will call a
  // boom stuck. The conservative threshold is deliberate -- it is what keeps
  // the arm from firing on the ordinary ease-out -- and 6 is plenty of signal.
  ok(pin.frames <= 3, `the boom is never held short of a reach the fan is granting (${pin.frames} frames)`);

  // Nothing teleports. SNAP_IN_RATE fixes a step at 1.667 m per 60 Hz frame, so
  // this bound says the rate cap governs every pull-in the canyon demands --
  // unfixed by the cap it is the whole 5.7 m excursion in one frame.
  ok(worstStep <= 1.67, `no frame outruns the snap-in rate cap (${worstStep.toFixed(3)} m)`);

  // The floor is the other disorientation: a boom at MIN_DIST is a lens inside
  // the survivor's shoulders with no view of the canyon at all.
  const floored = booms.filter((b) => b < 1.5).length;
  ok(floored === 0, `the boom never collapses toward its floor (${floored} frames under 1.5 m)`);

  // A canyon costs boom -- two walls in reach genuinely shorten the lens -- but
  // it may not cost all of it. The pre-fix latch mean is 2.850 m against a
  // 7.486 m request, because a latched memory spends the whole crossing at the
  // tightest instant of it.
  //
  // Read this as a regression floor and nothing more. It is explicitly *not* a
  // second guard on the latch, and the mutation check says so: restore the
  // latch on top of the rest of the fix and the mean goes to 4.019, i.e.
  // *better* than shipping. That is not a paradox, it is the trade -- a memory
  // that springs back to full length the instant one frame reads clear
  // averages a longer boom than one that eases, and buys it with the
  // discontinuity this issue is about. Mean boom cannot see a cliff. Only
  // `longestPin` above adjudicates the latch.
  ok(mean > 3.2, `the canyon still affords a usable boom (mean ${mean.toFixed(3)} m)`);

  // And none of the above may be bought by letting the camera into the rock.
  ok(worstPen <= 1e-9, `boom obeys the reach the fan computed (worst ${worstPen.toExponential(2)} m)`);
}

// --- the guard can fail ----------------------------------------------------
//
// A calm-camera assertion that cannot go red is worthless. `longestPin` reads
// zero on a rig that never enters the corridor at all, on one whose fan is
// disconnected, and on one whose boom is simply always short -- three ways to
// pass the arm above having measured nothing. So the instrument is made to
// demonstrate it can see a pin, by being handed one: the same walk with the
// boom held artificially long against a fan that is granting far less.
console.log('the pin metric is live');
{
  const { booms, allowed } = walk();
  // The pre-fix shape, replayed directly: freeze the boom at the tightest reach
  // of the crossing while the recorded fan verdict opens back up around it.
  const tightest = Math.min(...booms);
  const latched = booms.map((b, i) => (i >= 95 && i < 145 ? tightest : b));
  const seen = longestPin(latched, allowed);
  console.log(`    synthetic latch: ${seen.frames} frames`);
  ok(seen.frames >= 15, `longestPin detects a latched boom when there is one (${seen.frames} frames)`);
  // And it is looking at a corridor that genuinely constrains the camera --
  // otherwise there would be no reach to be held short of in the first place.
  ok(Math.min(...allowed) < 2.5, `the corridor really does clamp the fan (min reach ${Math.min(...allowed).toFixed(3)} m)`);
  ok(span(booms) > 1.0, `and the boom really does move in it (span ${span(booms).toFixed(3)} m)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
