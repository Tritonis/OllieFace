// Boids-style local steering for enemies.
//
// Every function writes into a caller-supplied vector and uses module-level
// scratch, so the whole steering stack allocates nothing at runtime. An
// "agent" here is anything with { position, velocity, radius, height }.
//
// Separation is brute-force O(n^2) over the director's active list. With the
// population cap at ~64 that is <2k squared-distance tests per fixed step —
// cheaper than maintaining a spatial hash, and with zero bookkeeping.

import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _o = new THREE.Vector3();

const GRAVITY = 26;

// Matches Stage's own walkable-slope threshold (cos 50°). A feeler hit on a
// surface flatter than this is ground the agent can simply walk up.
const WALK_DOT = 0.643;

/** Full-speed straight at the target (planar). */
export function seek(out, agent, target, maxSpeed) {
  _v.set(target.x - agent.position.x, 0, target.z - agent.position.z);
  const d = _v.length();
  if (d < 1e-4) return out.set(0, 0, 0);
  return out.copy(_v).multiplyScalar(maxSpeed / d);
}

/**
 * Seek, but ease off inside `slowRadius` and hold station inside `stopRadius`.
 * This is what stops melee packs from bulldozing through the player and
 * oscillating — they settle at their attack range instead.
 */
export function arrive(out, agent, target, maxSpeed, slowRadius, stopRadius = 0) {
  _v.set(target.x - agent.position.x, 0, target.z - agent.position.z);
  const d = _v.length();
  if (d < 1e-4) return out.set(0, 0, 0);
  if (d <= stopRadius) return out.set(0, 0, 0);
  const t = slowRadius > 1e-4 ? clamp((d - stopRadius) / slowRadius, 0, 1) : 1;
  return out.copy(_v).multiplyScalar((maxSpeed * t) / d);
}

/**
 * Arrive, but along a curve instead of a straight line.
 *
 * The heading is the direct one rotated by `sign * curve`, faded out as the
 * agent closes to `standoff`. A constant angular offset traces a spiral, so the
 * run-in visibly bends, the last few metres straighten into the commit, and two
 * units carrying opposite signs split around the target instead of stacking on
 * the same approach vector. Closure rate drops by cos(offset), which is the
 * travel time that makes a charge readable.
 */
export function approachArc(out, agent, target, maxSpeed, standoff, sign, curve, slowRadius = 2.5, fade = 10) {
  _v.set(target.x - agent.position.x, 0, target.z - agent.position.z);
  const d = _v.length();
  if (d < 1e-4 || d <= standoff) return out.set(0, 0, 0);
  const t = slowRadius > 1e-4 ? clamp((d - standoff) / slowRadius, 0, 1) : 1;
  const ang = sign * curve * clamp((d - standoff) / fade, 0, 1);
  const c = Math.cos(ang), s = Math.sin(ang);
  const ux = _v.x / d, uz = _v.z / d;
  const speed = maxSpeed * t;
  return out.set((ux * c - uz * s) * speed, 0, (ux * s + uz * c) * speed);
}

/**
 * Hold a standoff band around the target.
 *
 * Inside `want - band` it backs straight out, outside `want + band` it closes,
 * and in between it strafes — so a kiter never stands still and never lets you
 * walk it down. `arrive` alone cannot express this: it has one stop radius and
 * no opinion about being *too close*, which is why the mortar used to let a
 * player jog into its minimum range and stay there.
 */
export function keepRange(out, agent, target, maxSpeed, want, band, sign) {
  _v.set(target.x - agent.position.x, 0, target.z - agent.position.z);
  const d = _v.length();
  if (d < 1e-4) return out.set(maxSpeed, 0, 0);
  const ux = _v.x / d, uz = _v.z / d;
  if (d < want - band) {
    // Back off along the sight line, but keep some tangential drift so a
    // retreating unit arcs rather than reversing in a straight line into a wall.
    const urgency = clamp((want - band - d) / Math.max(1e-3, want * 0.5), 0.35, 1);
    return out.set((-ux - uz * sign * 0.6) * maxSpeed * urgency, 0,
      (-uz + ux * sign * 0.6) * maxSpeed * urgency);
  }
  if (d > want + band) {
    const t = clamp((d - want - band) / 6, 0.4, 1);
    return out.set(ux * maxSpeed * t, 0, uz * maxSpeed * t);
  }
  return out.set(-uz * sign * maxSpeed * 0.7, 0, ux * sign * maxSpeed * 0.7);
}

/**
 * Seek where the target is *going*, not where it is.
 *
 * Lead time is capped so a fast unit chasing a fast player doesn't aim at a
 * point on the far side of the arena; `lead` is seconds of prediction.
 */
export function pursue(out, agent, target, targetVel, maxSpeed, lead = 0.35) {
  const dx = target.x - agent.position.x, dz = target.z - agent.position.z;
  const t = targetVel ? Math.min(lead, Math.hypot(dx, dz) / Math.max(1, maxSpeed)) : 0;
  _w.set(target.x + (targetVel ? targetVel.x * t : 0), 0, target.z + (targetVel ? targetVel.z * t : 0));
  return seek(out, agent, _w, maxSpeed);
}

/** Away from the target — used to back off when a melee unit is inside range. */
export function flee(out, agent, target, maxSpeed) {
  seek(out, agent, target, maxSpeed);
  return out.multiplyScalar(-1);
}

/**
 * Push out of neighbours so a pack spreads into a crescent instead of
 * collapsing to a point. Weighted by overlap depth, and by 1/count so dense
 * clumps don't produce explosive corrections.
 *
 * `spread` widens the personal-space radius — melee units use a wider one while
 * closing so an approaching pack fans across a front rather than funnelling
 * down one line to the same point on the player.
 */
export function separate(out, agent, agents, strength = 1, verticalRange = 0, spread = 1) {
  out.set(0, 0, 0);
  const px = agent.position.x, py = agent.position.y, pz = agent.position.z;
  let n = 0;
  for (let i = 0; i < agents.length; i++) {
    const o = agents[i];
    if (o === agent || !o.alive) continue;
    const dx = px - o.position.x, dz = pz - o.position.z;
    const want = (agent.radius + o.radius) * 1.35 * spread;
    const d2 = dx * dx + dz * dz;
    if (d2 > want * want || d2 < 1e-6) continue;
    // Flyers and walkers ignore each other unless they share airspace.
    if (verticalRange > 0 && Math.abs(py - o.position.y) > verticalRange) continue;
    const d = Math.sqrt(d2);
    const push = (want - d) / want;
    out.x += (dx / d) * push;
    out.z += (dz / d) * push;
    n++;
  }
  if (n > 0) out.multiplyScalar(strength / n);
  return out;
}

/**
 * Feeler raycast against the stage. Returns a lateral slide vector (0..1
 * magnitude) that grows as the obstacle gets closer. Callers should cache this
 * across a few fixed steps — the raycast is the expensive part.
 *
 * The result is deliberately dominated by the wall tangent. A large push along
 * the surface normal reads as "back away", and once that push is combined with
 * a seek of comparable strength the agent parks in front of the obstacle for
 * good instead of walking around it — which is exactly how packs used to stall
 * ten metres short of the player and then trickle in one at a time.
 */
export function avoidObstacles(out, agent, ctx, dir, lookahead, feelerY = 0.9) {
  out.set(0, 0, 0);
  if (!ctx.stage || !ctx.stage.raycast) return out;
  _d.set(dir.x, 0, dir.z);
  const len = _d.length();
  if (len < 1e-4) return out;
  _d.multiplyScalar(1 / len);
  _o.copy(agent.position);
  _o.y += feelerY;
  const hit = ctx.stage.raycast(_o, _d, lookahead);
  if (!hit) return out;
  // A horizontal feeler half a metre off the ground hits the terrain on every
  // gentle rise. Treating those as obstacles meant units on rolling ground were
  // permanently steering away from the hillside in front of them and crawled to
  // the player at a fraction of their move speed. Only surfaces too steep to
  // walk up are obstacles; the capsule solver handles the rest.
  if (hit.normal && hit.normal.y > WALK_DOT) return out;
  const w = 1 - clamp(hit.distance / lookahead, 0, 1);
  // Slide along the wall, picking whichever tangent we're already leaning into.
  _w.set(-_d.z, 0, _d.x);
  const n = hit.normal;
  let s = 1;
  if (n) s = _w.x * n.x + _w.z * n.z >= 0 ? 1 : -1;
  out.set(_w.x * s, 0, _w.z * s).multiplyScalar(w);
  if (n) {
    out.x += n.x * w * 0.3;
    out.z += n.z * w * 0.3;
  }
  return out;
}

const _approach = (a, b, m) => (b > a ? Math.min(a + m, b) : Math.max(a - m, b));

/**
 * Integrate a grounded agent: accelerate the planar velocity toward `desired`,
 * apply gravity, then resolve through the stage capsule sweep. Falls back to a
 * height-sample clamp if the stage isn't up yet.
 */
export function moveGrounded(agent, ctx, desired, h, accel = 26) {
  const v = agent.velocity;
  const a = accel * h;
  v.x = _approach(v.x, desired.x, a);
  v.z = _approach(v.z, desired.z, a);
  v.y -= GRAVITY * h;

  const res = ctx.stage && ctx.stage.capsuleResolve
    ? ctx.stage.capsuleResolve(agent.position, agent.radius, agent.height, v, h)
    : null;

  if (res) {
    agent.position.copy(res.position);
    v.copy(res.velocity);
    agent.grounded = !!res.grounded;
  } else {
    agent.position.addScaledVector(v, h);
    const g = groundAt(ctx, agent.position.x, agent.position.z);
    if (agent.position.y <= g) {
      agent.position.y = g;
      if (v.y < 0) v.y = 0;
      agent.grounded = true;
    } else {
      agent.grounded = false;
    }
  }
  return agent.grounded;
}

/**
 * Flyers ignore the capsule solver entirely and hold an altitude band above
 * the terrain. `desired` is the planar wish-velocity; vertical motion is a
 * critically-ish damped spring toward ground + hoverHeight, plus whatever
 * bob/dive the caller injected into velocity.y.
 */
export function moveFlying(agent, ctx, desired, h, accel = 14, hoverHeight = 2.4, verticalGain = 5.5) {
  const v = agent.velocity;
  const a = accel * h;
  v.x = _approach(v.x, desired.x, a);
  v.z = _approach(v.z, desired.z, a);

  const target = groundAt(ctx, agent.position.x, agent.position.z) + hoverHeight;
  const err = target - agent.position.y;
  v.y += clamp(err * verticalGain, -14, 14) * h * 6;
  v.y *= Math.pow(0.02, h); // heavy vertical damping keeps hover from ringing
  agent.position.addScaledVector(v, h);
  agent.grounded = false;
  return agent.position.y;
}

/** Snap a grounded agent to the terrain (used on spawn and after teleports). */
export function groundClamp(agent, ctx) {
  agent.position.y = groundAt(ctx, agent.position.x, agent.position.z);
  return agent.position.y;
}

export function groundAt(ctx, x, z) {
  const g = ctx.stage && ctx.stage.sampleHeight ? ctx.stage.sampleHeight(x, z) : 0;
  return Number.isFinite(g) ? g : 0;
}

/**
 * A standable point on the anchor's own level, on a ring around it.
 *
 * This is the "where is it safe to put a unit down" question the spawner asks,
 * asked without the spawner's RNG: `randomWalkablePoint` draws from `ctx.rng`,
 * and single-player equivalence is measured against the exact draw sequence, so
 * a recovery that fired mid-run would shift every subsequent roll. A fixed ring
 * scan is deterministic, allocation-free, and answers the same question.
 *
 * `stage.isWalkable` is the spawner's own predicate (slope plus prop clearance).
 * The level test is the part that matters for a crevasse: a channel floor is
 * perfectly flat and therefore perfectly "walkable", so a point is only accepted
 * if it also stands within `levelTol` of the anchor's ground height — otherwise
 * the recovery drops the unit back into the hole it just left.
 *
 * Returns null when nothing on either ring qualifies; the caller decides what a
 * failed search means.
 */
const RING_STEPS = 12;
export function walkableNear(out, ctx, anchor, radius, phase = 0, levelTol = 2.5) {
  const stage = ctx.stage;
  const base = groundAt(ctx, anchor.x, anchor.z);
  for (let r = 0; r < 2; r++) {
    const rad = radius * (1 + r * 0.6);
    for (let i = 0; i < RING_STEPS; i++) {
      const a = phase + (i / RING_STEPS) * Math.PI * 2;
      const x = anchor.x + Math.cos(a) * rad;
      const z = anchor.z + Math.sin(a) * rad;
      if (stage && stage.isWalkable && !stage.isWalkable(x, z)) continue;
      const y = groundAt(ctx, x, z);
      if (Math.abs(y - base) > levelTol) continue;
      return out.set(x, y, z);
    }
  }
  return null;
}

/**
 * Pick a strafing offset around a target — used by `reposition` so ranged
 * units circle instead of standing in the open, and so packs fan out.
 */
export function orbitPoint(out, agent, target, radius, sign, lead = 0.9) {
  _v.set(agent.position.x - target.x, 0, agent.position.z - target.z);
  if (_v.lengthSq() < 1e-6) _v.set(1, 0, 0);
  const ang = Math.atan2(_v.z, _v.x) + sign * lead;
  out.set(target.x + Math.cos(ang) * radius, target.y, target.z + Math.sin(ang) * radius);
  return out;
}

/** Shortest signed delta between two yaw angles. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Turn `yaw` toward `target` at most `rate` radians/second. */
export function turnToward(yaw, target, rate, h) {
  const d = angleDelta(yaw, target);
  const m = rate * h;
  return yaw + clamp(d, -m, m);
}
