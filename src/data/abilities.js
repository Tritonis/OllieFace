import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';

/**
 * Every ability in the game, keyed by id. `data/survivors.js` names four of
 * these per survivor — one for each of the four loadout slots — and `Player`
 * resolves them at init.
 *
 * Each ability is data + a `fire(ctx, player)`. Cooldown accounting, charge
 * accounting and the `abilityUsed` event all live in Player — an ability only
 * describes what happens when it goes off.
 *
 * `shape` is the §1.3 shape family this ability actually draws, declared the
 * same way `data/equipment.js` declares `shape: 'beam'` rather than in a
 * parallel scheme. It is read by nothing in play; it exists so the co-op
 * collision fix (EFFECT-LANGUAGE.md §3.1, X1-X3) is *checkable*. In co-op two
 * classes' kit colours co-occur — Ranger amber beside Cinder orange — and the
 * language refuses to re-hue either, so the separation is §1.2 polarity plus
 * the shape the colour takes. `tests/coop-shape-signature.test.mjs` holds each
 * class's `shapeSignature` (survivors.js) to being unique on the roster and
 * present in at least half its own kit.
 *
 * The families beyond §1.3's six are two compounds the roster needed:
 * `charged-line` (Kestrel — a bead spool-up in front of a line, which is what
 * `chargeTell` draws) and `streak-cone` (Cinder — a spray of short streaks down
 * an axis, deliberately not `arcSlash`'s crescent, which is a swing).
 *
 * `cooldown` is in seconds *before* `stats.cooldownMult`.
 * `scalesWithAttackSpeed` makes the recovery divide by `stats.attackSpeed`
 * (primary only, matching how RoR2 treats basic attacks).
 * Damage numbers are coefficients of `stats.damage`.
 *
 * `replayFire(ctx, player)` is the optional *movement-only* half of `fire`.
 * A networked client replays every unacked command after a correction, and a
 * step that moved the player the first time has to move them the same way on
 * every replay or the prediction diverges permanently — while the projectiles,
 * VFX and audio of that same cast must fire exactly once. Any ability whose
 * effect includes displacing the caster splits along that line: `fire` does
 * everything, `replayFire` does only the part the simulation depends on.
 *
 * Every ability owes a VFX layer. The house style, set by the original four, is
 * flash + geometry (beam/ring/tracer) + particles + a light flick + a camera
 * response + audio. An ability that only changes numbers is invisible in a
 * fight, and an invisible ability is a bug.
 */

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _col = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);

/**
 * One hitscan bullet from the muzzle down the aim ray, with spread.
 * The stage hit and the combat hit are resolved separately so the tracer stops
 * at whichever came first even when one of the two systems isn't up yet.
 */
function hitscan(ctx, player, { damage, range = 240, spread = 0, pierce = 0, proc = 1, color = 0xffd9a0 }) {
  const ray = player.fireRay();
  _origin.copy(ray.origin);
  _dir.copy(ray.dir);

  if (spread > 0) {
    // Cone spread around the aim direction, biased to centre (sqrt) so most
    // shots stay on target and the outliers feel like the exception.
    _side.crossVectors(_dir, _up);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    _side.normalize();
    _tmp.crossVectors(_side, _dir).normalize();
    const a = ctx.rng.next() * Math.PI * 2;
    const r = Math.sqrt(ctx.rng.next()) * spread;
    _dir.addScaledVector(_side, Math.cos(a) * r).addScaledVector(_tmp, Math.sin(a) * r).normalize();
  }

  // Combat owns crit, armor and item multipliers — pass the raw coefficient and
  // let `applyDamage` be the single place a number is decided.
  const hits = ctx.combat?.hitscan?.(_origin, _dir, range, {
    damage, source: player, team: 'player', pierce, proc, type: 'hitscan',
  }) || null;

  // The round stops at whichever comes first: the world surface, or the body
  // that used up the last of the pierce budget. Combat already raycast the
  // stage, so reuse its result rather than paying for a second query.
  let dist = range;
  let worldHit = null;
  let stoppedOnBody = false;
  if (hits) {
    let bodies = 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.isWorld) { worldHit = hit; continue; }
      if (bodies++ === pierce && hit.distance < dist) { dist = hit.distance; stoppedOnBody = true; }
    }
  } else {
    worldHit = ctx.stage?.raycast?.(_origin, _dir, range) || null;
  }
  if (worldHit && worldHit.distance < dist) { dist = worldHit.distance; stoppedOnBody = false; }
  _end.copy(_origin).addScaledVector(_dir, dist);

  ctx.vfx?.tracer?.(_origin, _end, color);
  // Entity hits are drawn by VFX off the `damage` event, so only the world
  // needs an impact here or every kill would double up.
  if (worldHit && !stoppedOnBody) ctx.vfx?.impact?.(worldHit.point, worldHit.normal, 'stone');
  return hits;
}

function fireFlash(ctx, player, scale = 1) {
  const ray = player.fireRay();
  ctx.vfx?.muzzleFlash?.(ray.origin, ray.dir, scale);
}

/* -------------------------------------------------------------------------- */
/* Shared helpers for the non-hitscan archetypes                              */
/* -------------------------------------------------------------------------- */

// Snapshot buffer for group damage. `Combat.applyDamage` can re-enter Combat
// (item procs, chain lightning, death novas) and clobber its own `_overlap`
// buffer mid-iteration, so anything that damages a group copies the group out
// before it hits the first target — the same trap `Combat.explode` documents.
const _group = [];

// A second snapshot buffer, for the one caller that has to filter `_group` and
// then keep the result across a loop that re-enters Combat: Conflagration's
// burning set. Sharing `_group` for both would mean the filter and the source
// were the same array.
const _lit = [];

/**
 * Everything hostile inside a cone from `origin` along `dir`.
 *
 * Tested against each body's *centre* rather than its feet, matching
 * `sphereOverlap`: a swing aimed at a Sentinel's chest that missed because the
 * cone was measured to the ground under it is the melee equivalent of shooting
 * at the dirt.
 */
function gatherCone(ctx, origin, dir, range, halfAngle) {
  _group.length = 0;
  const c = ctx.combat;
  if (!c?.sphereOverlap) return _group;
  const n = c.sphereOverlap(origin, range, 'player');
  const limit = Math.cos(halfAngle);
  for (let i = 0; i < n; i++) {
    const e = c.overlapAt(i);
    _a.copy(e.position);
    _a.y += (e.height || 1.8) * 0.5;
    _a.sub(origin);
    const len = _a.length();
    // A body already inside the swing is hit regardless of bearing — otherwise
    // an enemy that has closed to contact is the one thing a melee survivor
    // cannot hit.
    if (len < 1e-3 || _a.divideScalar(len).dot(dir) >= limit) _group.push(e);
  }
  return _group;
}

/**
 * Draw the arc of a melee swing as geometry rather than as a puff.
 *
 * `n` beam segments strung between points on the sweep, widest in the middle so
 * the crescent has a leading edge and a tail. Two passes — a wide tinted one
 * and a thin white core — because a single-width beam is the "flat sticker"
 * failure the rubric calls out by name.
 */
function arcSlash(ctx, origin, dir, range, halfAngle, colour, { segments = 9, lift = 0 } = {}) {
  const vfx = ctx.vfx;
  if (!vfx?.beams) return;
  _col.set(colour);
  _side.crossVectors(dir, _up);
  if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
  _side.normalize();

  const pt = (t, out) => {
    const ang = (t - 0.5) * 2 * halfAngle;
    return out.copy(origin)
      .addScaledVector(dir, Math.cos(ang) * range)
      .addScaledVector(_side, Math.sin(ang) * range)
      .addScaledVector(_up, lift + Math.sin(t * Math.PI) * 0.22);
  };

  pt(0, _a);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    pt(t, _b);
    // Fat at the belly of the arc, thin at both tips.
    const w = 0.10 + Math.sin(t * Math.PI) * 0.20;
    vfx.beams.spawn(_a, _b, _col, w, w * 0.75, 0.16 + t * 0.06, 0.5, 0);
    vfx.beams.spawn(_a, _b, WHITE, w * 0.34, w * 0.26, 0.13, 2.6, 0);
    _a.copy(_b);
  }
  pt(0.5, _a);
  vfx.lights?.flick?.(_a, colour, 12, range * 2.2, 0.09);
}

/**
 * A ribbon that flies the arc over the next few fixed steps.
 *
 * The beams above are the shape; this is the *motion*. Scheduled rather than
 * emitted all at once because `Trails` interpolates between the positions it is
 * given, so feeding it the whole arc on one frame produces a static ribbon and
 * feeding it one point per step produces a swing.
 */
function arcRibbon(ctx, player, origin, dir, range, halfAngle, colour, steps = 5) {
  const trails = ctx.vfx?.trails;
  if (!trails) return;
  _side.crossVectors(dir, _up);
  if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
  _side.normalize();
  // Captured as scalars: the scheduled callbacks run on later fixed steps, by
  // which point every shared scratch vector in this module has moved on.
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;
  const sx = _side.x, sy = _side.y, sz = _side.z;
  const at = (t, out) => {
    const ang = (t - 0.5) * 2 * halfAngle;
    const c = Math.cos(ang) * range, s = Math.sin(ang) * range;
    return out.set(ox + dx * c + sx * s, oy + dy * c + sy * s + Math.sin(t * Math.PI) * 0.25, oz + dz * c + sz * s);
  };

  const handle = trails.spawn({
    position: at(0, _a), color: colour, coreColor: 0xffffff,
    width: 0.34, life: 0.24, minDist: 0.05,
  });
  if (!handle) return;
  for (let i = 1; i <= steps; i++) {
    player.schedule(i * (1 / 60), () => {
      at(i / steps, _b);
      trails.move(handle, _b.x, _b.y, _b.z);
      if (i === steps) trails.stop(handle);
    });
  }
}

/** Apply one coefficient of damage to a gathered group. Never allocates. */
function damageGroup(ctx, player, group, damage, { proc = 1, status = null, type = 'blast' } = {}) {
  const c = ctx.combat;
  for (let i = 0; i < group.length; i++) {
    const e = group[i];
    if (!e?.alive) continue;
    if (c?.applyDamage) {
      // `status` travels on the info for presentation only; `applyStatus`
      // below is still what applies it.
      c.applyDamage(e, damage, { source: player, procCoefficient: proc, position: e.position, type, status });
      if (status) c.applyStatus?.(e, status, player, 1);
    } else {
      e.takeDamage?.(damage, { source: player, position: e.position });
    }
  }
}

/**
 * Where the crosshair is pointing, dropped onto the ground.
 *
 * Deployables need a *surface*, not a ray: the aim point is clamped to a
 * maximum range so a shot at the sky puts the turret at the player's feet
 * rather than 300 m into the fog, and it is re-sampled against the height
 * field so it sits on the terrain instead of hovering over a slope.
 */
function groundAim(ctx, player, maxDist, out) {
  const ray = player.fireRay();
  const hit = ctx.stage?.raycast?.(ray.origin, ray.dir, maxDist);
  if (hit?.point) out.copy(hit.point);
  else out.copy(ray.origin).addScaledVector(ray.dir, maxDist);
  // Never below the height field: a ray that clipped the inside of a boulder
  // would otherwise bury the construct in the terrain.
  const g = ctx.stage?.sampleHeight?.(out.x, out.z);
  if (Number.isFinite(g) && out.y < g) out.y = g;
  return out;
}

/** Charge tell: a ring of beads collapsing onto the muzzle over `duration`. */
function chargeTell(ctx, player, duration, colour, beads = 5) {
  for (let i = 0; i < beads; i++) {
    player.schedule(duration * (i / beads), () => {
      const t = i / beads;
      const m = player.muzzlePosition();
      const r = 1.5 * (1 - t) + 0.18;
      // Cosmetic jitter only, so it rides `fxRng` — a client advancing the
      // gameplay stream to place a spark desyncs every loot roll after it.
      const ang = (ctx.fxRng?.next?.() ?? Math.random()) * Math.PI * 2;
      _a.copy(m).add(_tmp.set(Math.cos(ang) * r, Math.sin(ang * 1.7) * r * 0.5, Math.sin(ang) * r));
      _col.set(colour);
      ctx.vfx?.beams?.spawn?.(_a, m, _col, 0.10 * (1 - t) + 0.02, 0.005, 0.16, 1.6 + t * 2, 1);
      ctx.vfx?.lights?.flick?.(m, colour, 5 + t * 14, 3 + t * 4, 0.09);
      player.mesh?.addRecoil?.(-0.12);
    });
  }
}

/**
 * Rook's shape signature: a hex cage struck up around a placed structure.
 *
 * §1.3 names **lattice** as the protective/warded family and calls out that it
 * must not be the same shape as a nova going off — which is exactly what Ward
 * and Sentry used to be, a beam and two expanding rings, indistinguishable at a
 * glance from Anvil's Slam in a different colour. That is X1-X3's whole
 * complaint, and it is answered here rather than by re-huing lime.
 *
 * Drawn out of `beams.spawn` alone: six uprights plus a top and bottom chord
 * between them is a hexagonal prism, and a cage is a cage whether its edges
 * came from a HEX sprite or from line segments. The one thing this cannot do is
 * §1.3's non-zero *spin* — the beam pool draws static segments — so the lattice
 * reads as a structure that snapped up and stayed, which is the right reading
 * for a placeable and leaves spin available to whatever needs to move.
 *
 * Every edge is doubled with a white core, so the cage carries §1.2 player
 * polarity (white-hot core, element rim) the same way the deploy beam does.
 */
function latticeShell(ctx, at, radius, height, colour, life = 0.55) {
  const beams = ctx.vfx?.beams;
  if (!beams?.spawn) return;
  _col.set(colour);
  const SIDES = 6;
  for (let i = 0; i < SIDES; i++) {
    const a0 = (i / SIDES) * Math.PI * 2;
    const a1 = ((i + 1) / SIDES) * Math.PI * 2;
    const x0 = at.x + Math.cos(a0) * radius, z0 = at.z + Math.sin(a0) * radius;
    const x1 = at.x + Math.cos(a1) * radius, z1 = at.z + Math.sin(a1) * radius;

    // Upright.
    _a.set(x0, at.y, z0);
    _b.set(x0, at.y + height, z0);
    beams.spawn(_a, _b, _col, 0.09, 0.03, life, 0.9, 0);
    beams.spawn(_a, _b, WHITE, 0.03, 0.01, life * 0.8, 2.2, 0);

    // Bottom and top chords — the two that make it a cage rather than a fence.
    _a.set(x0, at.y + 0.05, z0);
    _b.set(x1, at.y + 0.05, z1);
    beams.spawn(_a, _b, _col, 0.07, 0.07, life, 0.8, 0);
    _a.set(x0, at.y + height, z0);
    _b.set(x1, at.y + height, z1);
    beams.spawn(_a, _b, _col, 0.06, 0.06, life, 0.8, 0);
    beams.spawn(_a, _b, WHITE, 0.02, 0.02, life * 0.8, 2.0, 0);
  }
}

export const ABILITIES = {

  /* ======================================================================== */
  /* RANGER — the balanced all-rounder. Unchanged from the original loadout.  */
  /* ======================================================================== */

  rangerDoubleTap: {
    id: 'rangerDoubleTap',
    shape: 'line',
    name: 'Double Tap',
    slot: 'primary',
    key: 'M1',
    cooldown: 0.26,
    scalesWithAttackSpeed: true,
    charges: 1,
    holdToFire: true,
    description: 'Fire two rounds for 2x110% damage.',
    fire(ctx, player) {
      const dmg = player.stats.damage * 1.1;
      const shoot = () => {
        hitscan(ctx, player, { damage: dmg, spread: player.moving ? 0.022 : 0.008 });
        fireFlash(ctx, player, 0.7);
        player.mesh.addRecoil(0.55);
        player.addAimPunch(0.9);
        ctx.audio?.shoot?.(player.position, 0.8);
      };
      shoot();
      // Second round lands on the next-but-one fixed step: fast enough to read
      // as one burst, slow enough that both muzzle flashes are visible.
      player.schedule(0.055, shoot);
      ctx.cameraRig?.punch(0.4);
    },
  },

  rangerPhaseRound: {
    id: 'rangerPhaseRound',
    shape: 'line',
    name: 'Phase Round',
    slot: 'secondary',
    key: 'M2',
    cooldown: 3.0,
    charges: 1,
    description: 'Fire a piercing round for 320% damage that passes through all enemies.',
    fire(ctx, player) {
      hitscan(ctx, player, {
        damage: player.stats.damage * 3.2,
        spread: 0,
        pierce: 99,
        proc: 1,
        color: 0x7fd2ff,
      });
      fireFlash(ctx, player, 1.8);
      player.mesh.addRecoil(1.6);
      player.addAimPunch(2.6);
      player.applySelfKnockback(-4.5);
      ctx.cameraRig?.punch(2.2);
      ctx.pipeline?.addShake?.(0.05);
      ctx.audio?.shoot?.(player.position, 1.9);
    },
  },

  rangerTacticalDive: {
    id: 'rangerTacticalDive',
    shape: 'line',
    name: 'Tactical Dive',
    slot: 'utility',
    // Shift is held for sprint, so the dash lives on Q (and RMB-free).
    key: 'Q',
    cooldown: 3.4,
    charges: 1,
    description: 'Roll a short distance, becoming briefly invulnerable.',
    fire(ctx, player) {
      player.beginDash();
      // Dust kick off the back foot; the ribbon trail is driven by Player for
      // the duration of the roll.
      _tmp.copy(player.position);
      ctx.vfx?.impact?.(_tmp, _up, 'dirt');
      ctx.cameraRig?.punch(-1.6); // pull FOV in, then it springs back wide
      ctx.audio?.footstep?.(player.position, 'dirt');
    },
    replayFire(ctx, player) { player.beginDash(); },
  },

  rangerSalvo: {
    id: 'rangerSalvo',
    shape: 'streak',
    name: 'Suppressive Salvo',
    slot: 'special',
    key: 'R',
    cooldown: 9.0,
    charges: 2,
    description: 'Launch 6 homing micro-missiles for 6x180% damage.',
    fire(ctx, player) {
      const dmg = player.stats.damage * 1.8;
      // Capture the launch direction as scalars: the scheduled callbacks run on
      // later fixed steps, by which point the shared ray scratch has moved on.
      const ray = player.fireRay();
      const dx = ray.dir.x, dy = ray.dir.y, dz = ray.dir.z;
      for (let i = 0; i < 6; i++) {
        // Stagger the launches and fan them out sideways so the volley spreads
        // before the homing pulls it back in — that S-curve is the whole look.
        player.schedule(i * 0.06, () => {
          const dir = _dir.set(dx, dy, dz);
          _side.crossVectors(dir, _up);
          if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
          _side.normalize();
          const lateral = ((i % 2 === 0) ? 1 : -1) * (0.45 + Math.floor(i / 2) * 0.28);
          _tmp.copy(dir).addScaledVector(_side, lateral).addScaledVector(_up, 0.55).normalize();
          _end.copy(_tmp).multiplyScalar(26);
          player.projectiles.spawn({
            position: player.muzzlePosition(),
            velocity: _end,
            kind: 'homing',
            damage: dmg,
            radius: 0.3,
            splash: 3.2,
            life: 4,
            seekRange: 70,
            turnRate: 3.4,
            armTime: 0.08,
            color: 0xff8a3d,
            owner: player,
            proc: 1,
          });
          ctx.vfx?.muzzleFlash?.(player.muzzlePosition(), _tmp, 0.5);
        });
      }
      player.mesh.addRecoil(0.9);
      player.addAimPunch(1.4);
      ctx.cameraRig?.punch(3.0);
      ctx.pipeline?.addShake?.(0.06);
      ctx.audio?.shoot?.(player.position, 1.4);
    },
  },

  /* ======================================================================== */
  /* ANVIL — close-range bruiser. Gap-closer + defensive cooldown.           */
  /* ======================================================================== */

  anvilSweep: {
    id: 'anvilSweep',
    shape: 'ring',
    name: 'Riving Sweep',
    slot: 'primary',
    key: 'M1',
    cooldown: 0.44,
    scalesWithAttackSpeed: true,
    charges: 1,
    holdToFire: true,
    description: 'Sweep the gauntlet for 210% damage in a wide arc.',
    fire(ctx, player) {
      const range = 4.2;
      const half = 1.15;              // ~132° of arc
      const ray = player.fireRay();
      // The swing pivots on the chest, not on the muzzle: an arc drawn from the
      // gauntlet is 0.6 m off the body's centre and reads as a slash beside the
      // survivor rather than one he is making.
      _origin.copy(player.position).setY(player.position.y + 1.15);
      _dir.copy(ray.dir);
      _dir.y *= 0.4;                  // flatten: a melee swing is a ground arc
      _dir.normalize();

      // Alternate handedness so held attacks look like a combo rather than one
      // animation retriggering. `swingSide` lives on the player and survives
      // between casts.
      player.swingSide = -(player.swingSide || 1);
      const side = player.swingSide;

      const group = gatherCone(ctx, _origin, _dir, range, half);
      damageGroup(ctx, player, group, player.stats.damage * 2.1, { proc: 1, type: 'melee' });
      const connected = group.length;

      arcSlash(ctx, _origin, _dir, range * 0.82, half * side, 0xff5a2a, { segments: 9 });
      arcRibbon(ctx, player, _origin, _dir, range * 0.9, half * side, 0xff8a3d, 5);
      for (let i = 0; i < group.length; i++) {
        _a.copy(group[i].position).setY(group[i].position.y + (group[i].height || 1.8) * 0.5);
        ctx.vfx?.hitSpark?.(_a, 0xffb060, 1.15);
      }

      // The world gets an impact only when nothing was hit, so a whiff still
      // has a contact cue and a connect does not double the sparks the `damage`
      // event already draws.
      if (!connected) {
        const world = ctx.stage?.raycast?.(_origin, _dir, range * 0.9);
        if (world?.point) ctx.vfx?.impact?.(world.point, world.normal, 'stone');
      } else {
        ctx.hitstop = Math.max(ctx.hitstop || 0, 0.035);
        ctx.pipeline?.addShake?.(0.02);
      }

      player.mesh.addRecoil(0.8 * side);
      player.addAimPunch(0.5);
      ctx.cameraRig?.punch(0.7);
      ctx.audio?.hit?.(player.position, false);
      ctx.audio?.shoot?.(player.position, 0.5);
    },
  },

  anvilSlam: {
    id: 'anvilSlam',
    shape: 'ring',
    name: 'Seismic Slam',
    slot: 'secondary',
    key: 'M2',
    cooldown: 4.5,
    charges: 1,
    description: 'Drive the gauntlet into the ground for 480% damage in 7m, slowing everything caught.',
    fire(ctx, player) {
      // Slam from wherever the survivor is. Airborne, the impact point is still
      // the ground under him and he is thrown down onto it — a mid-air slam
      // that detonates at chest height has no ground to shake.
      const g = ctx.stage?.sampleHeight?.(player.position.x, player.position.z);
      _origin.copy(player.position);
      if (Number.isFinite(g)) _origin.y = Math.min(_origin.y, g);
      const airborne = !player.grounded;
      if (airborne) player.velocity.y = Math.min(player.velocity.y, -22);

      const radius = 7;
      const detonate = () => {
        const at = _a.copy(player.position);
        const gy = ctx.stage?.sampleHeight?.(at.x, at.z);
        if (Number.isFinite(gy)) at.y = gy;

        const c = ctx.combat;
        if (c?.sphereOverlap) {
          const n = c.sphereOverlap(at, radius, 'player');
          _group.length = 0;
          for (let i = 0; i < n; i++) _group.push(c.overlapAt(i));
          damageGroup(ctx, player, _group, player.stats.damage * 4.8, { proc: 1, status: 'slow' });
          _group.length = 0;
        }

        // Layered ground event: a wide dust ring, a hot inner ring, a shockwave
        // of debris from `impact`, a light burst and the shake. `explosion` is
        // deliberately not used — this is stone, not fire.
        ctx.vfx?.ring?.(at, radius, 0xff6a2a);
        ctx.vfx?.rings?.spawn?.(at, _up, 0xffd2a0, radius * 0.12, radius * 0.62, 0.3, 0.9);
        ctx.vfx?.rings?.spawn?.(at, _up, 0x9a6a4a, radius * 0.5, radius * 1.35, 0.55, 0.45);
        ctx.vfx?.impact?.(at, _up, 'stone');
        ctx.vfx?.impact?.(_b.copy(at).addScaledVector(_up, 0.3), _up, 'dirt');
        ctx.vfx?.lights?.flick?.(at, 0xff8a3d, 26, radius * 2.4, 0.22);
        ctx.pipeline?.addShake?.(0.16);
        ctx.cameraRig?.punch(3.4);
        ctx.hitstop = Math.max(ctx.hitstop || 0, 0.06);
        ctx.audio?.explosion?.(at, radius);
        player.mesh.addRecoil(2.2);
      };

      // Grounded: the slam lands on the next step, which reads as instant.
      // Airborne: it lands when he does, up to a third of a second later, which
      // is what makes the dive-slam a real commitment.
      if (airborne) {
        // One live schedule slot at a time, re-armed until contact. The ring is
        // 32 entries wide and shared with every other ability the survivor is
        // mid-cast on, so a 20-entry polling burst is a budget nobody can
        // afford in a fight.
        let waited = 0;
        const poll = () => {
          waited += 1 / 30;
          if (player.grounded || waited >= 0.7) detonate();
          else player.schedule(1 / 30, poll);
        };
        player.schedule(1 / 30, poll);
      } else {
        player.schedule(0.03, detonate);
      }
      ctx.audio?.shoot?.(player.position, 1.2);
      player.addAimPunch(1.2);
    },
  },

  anvilBreach: {
    id: 'anvilBreach',
    shape: 'line',
    name: 'Breach Charge',
    slot: 'utility',
    key: 'Q',
    cooldown: 5.0,
    charges: 1,
    description: 'Charge forward, dealing 260% damage to everything you run through.',
    fire(ctx, player) {
      this.replayFire(ctx, player);

      const dmg = player.stats.damage * 2.6;
      // One hit per body per charge. A cooldown ability is allowed the one
      // allocation; the hot loop is the four scheduled sweeps, and those reuse
      // the shared group buffer.
      const struck = new Set();
      for (let i = 0; i < 6; i++) {
        player.schedule(i * 0.055, () => {
          _origin.copy(player.position).setY(player.position.y + 0.9);
          _dir.copy(player.dashDirection);
          if (_dir.lengthSq() < 1e-6) return;
          const group = gatherCone(ctx, _origin, _dir, 2.6, 1.4);
          for (let k = 0; k < group.length; k++) {
            const e = group[k];
            if (struck.has(e)) continue;
            struck.add(e);
            ctx.combat?.applyDamage?.(e, dmg, {
              source: player, procCoefficient: 1, position: e.position, type: 'melee',
            });
            _a.copy(e.position).setY(e.position.y + (e.height || 1.8) * 0.5);
            ctx.vfx?.hitSpark?.(_a, 0xffb060, 1.4);
            ctx.pipeline?.addShake?.(0.03);
          }
          // Ground scrape: a dust plume off the leading foot every other step,
          // which is what turns a teleport-looking dash into a charge.
          if (i % 2 === 0) ctx.vfx?.impact?.(player.position, _up, 'dirt');
        });
      }

      // Two flanking beams thrown forward along the charge line, so the shove
      // has a direction in the frame even before it connects.
      _origin.copy(player.position).setY(player.position.y + 1.0);
      _end.copy(_origin).addScaledVector(player.dashDirection, 6.5);
      _col.set(0xff5a2a);
      ctx.vfx?.beams?.spawn?.(_origin, _end, _col, 0.55, 0.05, 0.24, 0.7, 1);
      ctx.vfx?.beams?.spawn?.(_origin, _end, WHITE, 0.16, 0.01, 0.18, 2.4, 1);
      ctx.vfx?.lights?.flick?.(_origin, 0xff6a2a, 18, 10, 0.16);
      ctx.cameraRig?.punch(-2.6);
      ctx.pipeline?.addShake?.(0.05);
      ctx.audio?.shoot?.(player.position, 1.1);
      ctx.audio?.footstep?.(player.position, 'stone');
    },
    /**
     * The movement half. Longer, faster and *aim-directed* rather than
     * input-directed — a gap-closer that goes where you are holding rather than
     * where you are looking closes a gap you did not pick.
     */
    replayFire(ctx, player) {
      player.beginDash({ direction: player.aimForward(_tmp), speed: 30, time: 0.32, iframes: 0.18 });
    },
  },

  anvilBulwark: {
    id: 'anvilBulwark',
    shape: 'ring',
    name: 'Bulwark',
    slot: 'special',
    key: 'R',
    cooldown: 12.0,
    charges: 1,
    description: 'Brace: gain a barrier worth 45% of max health and +25 armor for 6s.',
    fire(ctx, player) {
      const dur = 6;
      // Barrier and armor are game state, so the host books them and a client
      // learns its real health through the snapshot. The tell below is not
      // gated — a defensive cooldown you cannot see is one you cannot play
      // around, on either machine.
      if (ctx.authority) {
        player.grantBarrier(player.stats.maxHealth * 0.45);
        player.grantBuff({ armor: 25 }, dur);
      }

      _origin.copy(player.position).setY(player.position.y + 0.9);

      // Six ribs snapping up into a dome, then a ground ring: the shape says
      // "shell", and it lasts long enough to still be on screen when the hit
      // it was popped for arrives.
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        _a.copy(_origin).add(_tmp.set(Math.sin(ang) * 1.25, -0.85, Math.cos(ang) * 1.25));
        _b.copy(_origin).add(_tmp.set(Math.sin(ang) * 0.35, 1.15, Math.cos(ang) * 0.35));
        _col.set(0xffb03c);
        ctx.vfx?.beams?.spawn?.(_a, _b, _col, 0.16, 0.05, 0.55, 0.8, 0);
        ctx.vfx?.beams?.spawn?.(_a, _b, WHITE, 0.05, 0.015, 0.4, 2.2, 0);
      }
      ctx.vfx?.rings?.spawn?.(player.position, _up, 0xffb03c, 0.4, 2.6, 0.5, 0.9);
      ctx.vfx?.rings?.spawn?.(player.position, _up, 0xff6a2a, 1.6, 3.6, 0.75, 0.4);
      ctx.vfx?.block?.(_origin);
      ctx.vfx?.lights?.flick?.(_origin, 0xffb03c, 22, 12, 0.35);
      ctx.cameraRig?.punch(1.4);
      ctx.pipeline?.addShake?.(0.04);
      ctx.audio?.shieldBreak?.(player.position);
      ctx.audio?.ability?.(3);

      // Pulse the shell twice more over the duration so the buff has a running
      // presence rather than one frame at the start.
      for (let i = 1; i <= 2; i++) {
        player.schedule(dur * (i / 3), () => {
          ctx.vfx?.rings?.spawn?.(player.position, _up, 0xffb03c, 0.6, 2.2, 0.4, 0.5);
          ctx.vfx?.lights?.flick?.(player.position, 0xffb03c, 8, 7, 0.2);
        });
      }
    },
  },

  /* ======================================================================== */
  /* KESTREL — ranged precision. Charge-up burst + a repositioning vault.     */
  /* ======================================================================== */

  kestrelMark: {
    id: 'kestrelMark',
    shape: 'line',
    name: 'Mark',
    slot: 'primary',
    key: 'M1',
    cooldown: 0.62,
    scalesWithAttackSpeed: true,
    charges: 1,
    holdToFire: true,
    description: 'A single precise round for 250% damage that pierces one target.',
    fire(ctx, player) {
      // Standing still is the whole identity: the spread penalty for moving is
      // four times the Ranger's, so the precision survivor has to plant.
      hitscan(ctx, player, {
        damage: player.stats.damage * 2.5,
        spread: player.moving ? 0.05 : 0.001,
        pierce: 1,
        color: 0xc9a4ff,
      });
      fireFlash(ctx, player, 1.15);
      // The report reads as a rifle rather than a carbine: a second, quieter
      // flash a frame later is the smoke leaving a long barrel.
      player.schedule(0.033, () => {
        const ray = player.fireRay();
        ctx.vfx?.muzzleFlash?.(ray.origin, ray.dir, 0.35);
      });
      player.mesh.addRecoil(1.15);
      player.addAimPunch(2.0);
      ctx.cameraRig?.punch(1.0);
      ctx.pipeline?.addShake?.(0.02);
      ctx.audio?.shoot?.(player.position, 1.35);
    },
  },

  kestrelLance: {
    id: 'kestrelLance',
    shape: 'charged-line',
    name: 'Focus Lance',
    slot: 'secondary',
    key: 'M2',
    cooldown: 6.0,
    charges: 1,
    description: 'Spool up for 0.5s, then fire a piercing lance for 700% damage.',
    fire(ctx, player) {
      const CHARGE = 0.5;
      chargeTell(ctx, player, CHARGE, 0xc9a4ff, 6);
      ctx.audio?.ability?.(1);

      // The shot is aimed when it *releases*, not when the key was pressed —
      // tracking a target through the spool-up is the skill the charge exists
      // to ask for.
      player.schedule(CHARGE, () => {
        const hits = hitscan(ctx, player, {
          damage: player.stats.damage * 7.0,
          spread: 0,
          pierce: 99,
          proc: 1,
          color: 0xd6b4ff,
        });
        // The lance itself: a fat violet beam over the full flight path plus a
        // white core, drawn separately from the tracer so it survives the
        // tracer's deliberately short draw length.
        const ray = player.fireRay();
        _origin.copy(ray.origin);
        let dist = 200;
        const world = ctx.stage?.raycast?.(_origin, ray.dir, 240);
        if (world) dist = world.distance;
        _end.copy(_origin).addScaledVector(ray.dir, dist);
        _col.set(0xa070ff);
        ctx.vfx?.beams?.spawn?.(_origin, _end, _col, 0.42, 0.16, 0.24, 0.6, 0);
        ctx.vfx?.beams?.spawn?.(_origin, _end, WHITE, 0.12, 0.04, 0.18, 3.0, 0);
        ctx.vfx?.muzzleFlash?.(_origin, ray.dir, 2.2);
        ctx.vfx?.lights?.flick?.(_origin, 0xc9a4ff, 30, 16, 0.14);
        if (hits) {
          for (let i = 0; i < hits.length; i++) {
            if (!hits[i].isWorld && hits[i].point) ctx.vfx?.hitSpark?.(hits[i].point, 0xd6b4ff, 1.3);
          }
        }
        player.mesh.addRecoil(2.4);
        player.addAimPunch(4.2);
        player.applySelfKnockback(-3.0);
        ctx.cameraRig?.punch(3.2);
        ctx.pipeline?.addShake?.(0.09);
        ctx.hitstop = Math.max(ctx.hitstop || 0, 0.05);
        ctx.audio?.shoot?.(player.position, 2.0);
      });
    },
  },

  kestrelVault: {
    id: 'kestrelVault',
    shape: 'line',
    name: 'Vault',
    slot: 'utility',
    key: 'Q',
    cooldown: 4.0,
    charges: 2,
    description: 'Kick off backwards and up, refreshing your jumps.',
    fire(ctx, player) {
      this.replayFire(ctx, player);

      // Kick-off plume under the feet plus a rising ring: the tell has to sell
      // *height*, and a ground-plane ring the player leaves behind them is the
      // cheapest way to read vertical motion from a chase camera.
      ctx.vfx?.impact?.(player.position, _up, 'dirt');
      ctx.vfx?.rings?.spawn?.(player.position, _up, 0xc9a4ff, 0.3, 2.4, 0.4, 0.85);
      _origin.copy(player.position).setY(player.position.y + 0.15);
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + 0.4;
        _a.copy(_origin).add(_tmp.set(Math.sin(ang) * 0.5, 0, Math.cos(ang) * 0.5));
        _b.copy(_a).addScaledVector(_up, 1.5 + i * 0.2);
        _col.set(0xc9a4ff);
        ctx.vfx?.beams?.spawn?.(_a, _b, _col, 0.10, 0.01, 0.3, 1.1, 1);
      }
      ctx.vfx?.lights?.flick?.(_origin, 0xc9a4ff, 14, 8, 0.16);
      ctx.cameraRig?.punch(-1.2);
      ctx.audio?.footstep?.(player.position, 'stone');
      ctx.audio?.ability?.(2);
    },
    /**
     * Vault is a *velocity* change rather than a dash, which is why it has its
     * own replay half instead of reusing `beginDash`: it has to compose with
     * gravity and air control, and it refreshes the air-jump budget so the
     * vault-into-double-jump is the reposition rather than a stunt.
     */
    replayFire(ctx, player) {
      player.aimForward(_tmp);
      // Away from the aim, so the vault disengages from whatever is being
      // aimed at. Holding a direction overrides it — an escape tool that can
      // only go one way is not a reposition.
      if (player.moving) _tmp.copy(player.wishDirection()).multiplyScalar(-1);
      player.velocity.x = -_tmp.x * 13;
      player.velocity.z = -_tmp.z * 13;
      player.velocity.y = 11.5;
      player.grounded = false;
      player.jumpsUsed = 0;
      player.jumpBuffer = 0;
      player.grantIFrames(0.2);
    },
  },

  kestrelEclipse: {
    id: 'kestrelEclipse',
    shape: 'charged-line',
    name: 'Eclipse Round',
    slot: 'special',
    key: 'R',
    cooldown: 11.0,
    charges: 1,
    description: 'Seat a heavy round: 1100% piercing damage that detonates for 400% where it lands.',
    fire(ctx, player) {
      const CHARGE = 0.35;
      chargeTell(ctx, player, CHARGE, 0xffe0a0, 7);
      ctx.audio?.ability?.(3);

      player.schedule(CHARGE, () => {
        const ray = player.fireRay();
        _origin.copy(ray.origin);
        _dir.copy(ray.dir);
        hitscan(ctx, player, {
          damage: player.stats.damage * 11,
          spread: 0,
          pierce: 99,
          proc: 1,
          color: 0xffe0a0,
        });

        // Terminal blast wherever the round stopped, so the shot has a *place*
        // as well as a line. Recomputed rather than read off the hitscan: the
        // helper's `_end` is shared scratch and this runs after it returns.
        const world = ctx.stage?.raycast?.(_origin, _dir, 240);
        _end.copy(_origin).addScaledVector(_dir, world ? world.distance : 90);
        ctx.combat?.explode?.(_end, 6, player.stats.damage * 4, player, { proc: 0.7, type: 'blast' });

        _col.set(0xffc46a);
        ctx.vfx?.beams?.spawn?.(_origin, _end, _col, 0.75, 0.3, 0.34, 0.55, 0);
        ctx.vfx?.beams?.spawn?.(_origin, _end, WHITE, 0.22, 0.07, 0.26, 3.2, 0);
        ctx.vfx?.muzzleFlash?.(_origin, _dir, 3.2);
        ctx.vfx?.rings?.spawn?.(_end, _up, 0xffc46a, 1.0, 9, 0.6, 0.85);
        ctx.vfx?.lights?.flick?.(_origin, 0xffe0a0, 40, 22, 0.18);

        player.mesh.addRecoil(3.4);
        player.addAimPunch(6.5);
        player.applySelfKnockback(-7.0);
        ctx.cameraRig?.punch(5.0);
        ctx.pipeline?.addShake?.(0.18);
        ctx.hitstop = Math.max(ctx.hitstop || 0, 0.08);
        ctx.audio?.shoot?.(player.position, 2.4);
        ctx.audio?.explosion?.(_end, 6);
      });
    },
  },

  /* ======================================================================== */
  /* ROOK — field engineer. Everything it fires leaves something behind.      */
  /* ======================================================================== */

  rookRivet: {
    id: 'rookRivet',
    shape: 'line',
    name: 'Rivet Gun',
    slot: 'primary',
    key: 'M1',
    cooldown: 0.17,
    scalesWithAttackSpeed: true,
    charges: 1,
    holdToFire: true,
    description: 'A rapid stream of rivets for 85% damage each.',
    fire(ctx, player) {
      hitscan(ctx, player, {
        damage: player.stats.damage * 0.85,
        spread: player.moving ? 0.055 : 0.03,
        proc: 0.75,          // a fast stream procs less per hit, as RoR2 does it
        color: 0xbfff7a,
      });
      fireFlash(ctx, player, 0.5);
      player.mesh.addRecoil(0.3);
      player.addAimPunch(0.45);
      ctx.audio?.shoot?.(player.position, 0.55);
    },
  },

  rookMines: {
    id: 'rookMines',
    shape: 'streak',
    name: 'Scatter Charges',
    slot: 'secondary',
    key: 'M2',
    cooldown: 5.5,
    charges: 2,
    description: 'Lob 3 proximity charges. Each detonates for 320% damage.',
    fire(ctx, player) {
      const dmg = player.stats.damage * 3.2;
      const ray = player.fireRay();
      // Scalars again: these land on later fixed steps.
      const dx = ray.dir.x, dy = ray.dir.y, dz = ray.dir.z;
      const mx = ray.origin.x, my = ray.origin.y, mz = ray.origin.z;

      for (let i = 0; i < 3; i++) {
        player.schedule(i * 0.07, () => {
          _dir.set(dx, dy, dz);
          _side.crossVectors(_dir, _up);
          if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
          _side.normalize();
          // Fan of three: centre, left, right. Deterministic rather than
          // random, because where your charges land is information the player
          // is supposed to be able to use.
          const lateral = (i - 1) * 0.26;
          _tmp.copy(_dir).addScaledVector(_side, lateral).addScaledVector(_up, 0.30).normalize();
          _a.set(mx, my, mz);
          player.placeables.spawn({
            kind: 'mine',
            position: _a,
            velocity: _b.copy(_tmp).multiplyScalar(17),
            damage: dmg,
            radius: 2.2,
            life: 26,
            armTime: 0.55,
            owner: player,
            proc: 1,
          });
          ctx.vfx?.muzzleFlash?.(_a, _tmp, 0.45);
          ctx.vfx?.lights?.flick?.(_a, 0x9dff5a, 8, 5, 0.08);
        });
      }
      player.mesh.addRecoil(0.9);
      player.addAimPunch(1.1);
      ctx.cameraRig?.punch(1.2);
      ctx.audio?.shoot?.(player.position, 1.0);
      ctx.audio?.ability?.(1);
    },
  },

  rookWard: {
    id: 'rookWard',
    shape: 'lattice',
    name: 'Harmonic Ward',
    slot: 'utility',
    key: 'Q',
    cooldown: 9.0,
    charges: 1,
    description: 'Plant a 6m ward for 12s: slows and grinds down enemies inside, mends you while you stand in it.',
    fire(ctx, player) {
      groundAim(ctx, player, 26, _origin);
      player.placeables.spawn({
        kind: 'ward',
        position: _origin,
        damage: player.stats.damage * 0.55,
        radius: 6,
        life: 12,
        period: 0.55,
        owner: player,
        proc: 0.4,
      });

      // Deploy: a beam thrown from the muzzle to the site so the ward is
      // visibly *placed* rather than teleported there, then the site lights up.
      _a.copy(player.muzzlePosition());
      _col.set(0x9dff5a);
      ctx.vfx?.beams?.spawn?.(_a, _origin, _col, 0.22, 0.05, 0.22, 0.9, 1);
      ctx.vfx?.beams?.spawn?.(_a, _origin, WHITE, 0.07, 0.015, 0.18, 2.2, 1);
      ctx.vfx?.ring?.(_origin, 6, 0x9dff5a);
      // Rook's signature, and the reason this cannot be read as a nova: the
      // ward's boundary is a standing cage, not an expanding front.
      latticeShell(ctx, _origin, 6, 2.4, 0x9dff5a, 0.7);
      ctx.vfx?.rings?.spawn?.(_origin, _up, 0xdcffb0, 0.3, 3.0, 0.35, 0.9);
      ctx.vfx?.impact?.(_origin, _up, 'dirt');
      ctx.vfx?.lights?.flick?.(_origin, 0x9dff5a, 24, 14, 0.3);
      ctx.cameraRig?.punch(0.8);
      ctx.audio?.ability?.(2);
      ctx.audio?.heal?.(_origin);
    },
  },

  rookTurret: {
    id: 'rookTurret',
    shape: 'lattice',
    name: 'Sentry',
    slot: 'special',
    key: 'R',
    cooldown: 14.0,
    charges: 2,
    description: 'Bolt down a sentry for 24s. It fires at 120% damage, twice a second.',
    fire(ctx, player) {
      groundAim(ctx, player, 22, _origin);
      player.placeables.spawn({
        kind: 'turret',
        position: _origin,
        damage: player.stats.damage * 1.2,
        radius: 0.6,
        range: 34,
        life: 24,
        period: 0.5,
        owner: player,
        proc: 0.6,
        // Face the way the deployer was looking, so the first target
        // acquisition is a small traverse rather than a 180.
        yaw: player.aimYaw,
      });

      _a.copy(player.muzzlePosition());
      _col.set(0x9dff5a);
      ctx.vfx?.beams?.spawn?.(_a, _origin, _col, 0.3, 0.06, 0.26, 0.9, 1);
      ctx.vfx?.beams?.spawn?.(_a, _origin, WHITE, 0.09, 0.02, 0.2, 2.4, 1);
      // Four anchor bolts driven into the ground around the footprint — the
      // deploy needs weight, and four small impacts read heavier than one big
      // one for the same particle budget.
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + 0.6;
        player.schedule(0.04 + i * 0.03, () => {
          _b.copy(_origin).add(_tmp.set(Math.sin(ang) * 0.42, 0.05, Math.cos(ang) * 0.42));
          ctx.vfx?.impact?.(_b, _up, 'metal');
        });
      }
      // The same cage as the Ward, tight around the sentry: both of Rook's
      // placeables are bolted-down structures and both say so in one shape.
      latticeShell(ctx, _origin, 1.3, 1.8, 0x9dff5a, 0.5);
      ctx.vfx?.rings?.spawn?.(_origin, _up, 0x9dff5a, 0.3, 3.2, 0.42, 0.9);
      ctx.vfx?.burst?.(_origin, 0xbfff7a);
      ctx.vfx?.lights?.flick?.(_origin, 0x9dff5a, 28, 15, 0.28);
      ctx.cameraRig?.punch(1.6);
      ctx.pipeline?.addShake?.(0.04);
      ctx.audio?.ability?.(3);
      ctx.audio?.impact?.(_origin, 'metal');
    },
  },
  /* ======================================================================== */
  /* CINDER — the ash foreman. The roster's first *attrition* survivor.        */
  /*                                                                          */
  /* Every other kit resolves a fight the moment it connects: the Ranger's     */
  /* rounds, Anvil's swing, Kestrel's lance and Rook's turret all deal their   */
  /* damage on contact. Cinder deals almost none. Her whole output is deferred */
  /* into `burn` stacks and lingering ground, and her Special is the button    */
  /* that calls it all in at once — so the loop is *apply, spread, detonate*   */
  /* rather than aim-and-hit, and the skill it asks for is target management   */
  /* across a horde instead of accuracy against one body.                      */
  /*                                                                          */
  /* That also makes her the survivor the status half of the item pool was     */
  /* waiting for: Afflictor's Index, Warlock Ember, Leaking Jerrycan and Warm  */
  /* Coals are all conditional on ailments this kit guarantees.                */
  /* ======================================================================== */

  cinderStoke: {
    id: 'cinderStoke',
    shape: 'streak-cone',
    name: 'Stoke',
    slot: 'primary',
    key: 'M1',
    cooldown: 0.30,
    scalesWithAttackSpeed: true,
    charges: 1,
    holdToFire: true,
    description: 'Wash a short cone of flame for 95% damage, igniting everything caught.',
    fire(ctx, player) {
      // Deliberately the weakest primary on the roster by direct damage — 95%
      // against the Ranger's 2x110% — because it is the only one that applies a
      // status on every single hit. Four seconds of burn at 25% of the damage
      // stat per half-second tick is roughly another 200% per target, and it
      // lands on *everything in the cone* rather than on one body.
      const range = 7.0;
      const half = 0.42;              // ~48°, much tighter than Anvil's sweep
      const ray = player.fireRay();
      // From the bell of the igniter, not the chest: this is a projected stream
      // and it has to visibly leave the weapon.
      _origin.copy(player.muzzlePosition());
      _dir.copy(ray.dir);

      const group = gatherCone(ctx, _origin, _dir, range, half);
      damageGroup(ctx, player, group, player.stats.damage * 0.95, {
        proc: 0.6, status: 'burn', type: 'fire',
      });

      // A cone of flame is drawn as a spray of short beams down the axis rather
      // than as one arc: `arcSlash` draws a crescent, which is a *swing*, and
      // this is a continuous emission. Six lances of decreasing width fanned
      // inside the cone give it depth along the aim ray instead of across it.
      _side.crossVectors(_dir, _up);
      if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
      _side.normalize();
      _tmp.crossVectors(_side, _dir).normalize();
      for (let i = 0; i < 6; i++) {
        const t = (i + 1) / 6;
        const ang = (i - 2.5) * (half / 3);
        _a.copy(_origin).addScaledVector(_dir, 0.4);
        _b.copy(_origin)
          .addScaledVector(_dir, Math.cos(ang) * range * (0.55 + t * 0.45))
          .addScaledVector(_side, Math.sin(ang) * range * 0.8)
          .addScaledVector(_tmp, (i % 2 ? 0.35 : -0.2));
        _col.set(0xff8a20);
        ctx.vfx?.beams?.spawn?.(_a, _b, _col, 0.05, 0.34, 0.18 + t * 0.06, 0.8, 1);
      }
      _a.copy(_origin).addScaledVector(_dir, 0.4);
      _col.set(0xffd76a);
      ctx.vfx?.beams?.spawn?.(_a, _b.copy(_origin).addScaledVector(_dir, range * 0.7), _col, 0.06, 0.14, 0.13, 2.6, 1);
      ctx.vfx?.muzzleFlash?.(_origin, _dir, 0.55);
      ctx.vfx?.lights?.flick?.(_a, 0xff8a20, 14, 9, 0.1);
      for (let i = 0; i < group.length; i++) {
        _a.copy(group[i].position).setY(group[i].position.y + (group[i].height || 1.8) * 0.5);
        ctx.vfx?.hitSpark?.(_a, 0xffb040, 0.9);
      }

      player.mesh.addRecoil(0.22);
      player.addAimPunch(0.3);
      ctx.audio?.shoot?.(player.position, 0.6);
    },
  },

  cinderPyreFlask: {
    id: 'cinderPyreFlask',
    shape: 'streak',
    name: 'Pyre Flask',
    slot: 'secondary',
    key: 'M2',
    cooldown: 6.0,
    charges: 2,
    description: 'Lob a flask that bursts for 260% damage and leaves a 6m pyre burning for 8s.',
    fire(ctx, player) {
      const dmg = player.stats.damage * 2.6;
      const ray = player.fireRay();
      // Scalars: the impact resolves on a later fixed step, by which point every
      // shared scratch vector in this module has moved on.
      const dx = ray.dir.x, dy = ray.dir.y, dz = ray.dir.z;
      _tmp.set(dx, dy, dz).addScaledVector(_up, 0.16).normalize();
      _end.copy(_tmp).multiplyScalar(24);

      // No `status` field here on purpose: `Projectile.spawn` does not carry one
      // and silently drops unknown keys, so writing `status: 'burn'` would be a
      // comment claiming an effect that never happens. The ignition comes from
      // the pyre the flask leaves, which is the part of the ability that matters
      // anyway.
      player.projectiles.spawn({
        position: player.muzzlePosition(),
        velocity: _end,
        kind: 'arc',
        damage: dmg,
        radius: 0.32,
        splash: 6,
        life: 4,
        gravity: 14,
        color: 0xff8a20,
        owner: player,
        proc: 0.8,
      });

      // The pyre. Sited with `groundAim` at *cast* time rather than being
      // derived from the flask's flight: the projectile system owns its impact
      // and hands out no callback, and re-deriving a landing point from the
      // launch vector would disagree with the arc the moment the ground is not
      // flat. Placing the zone where the player was pointing is also the more
      // honest contract — the area is the ability, and it should land where it
      // was aimed even when the flask clips a rock on the way.
      //
      // `Items.addCloud` is host-only and bounded to MAX_CLOUDS, so a survivor
      // spamming both charges cannot grow the per-step overlap cost.
      //
      // The options bag is what makes this a *pyre* rather than a green Spore
      // Sac puddle with a fire ring drawn over it. The whole kit is organised
      // around `burn` — the Special pays per burning body — and the only ranged
      // setup tool in it used to contribute nothing to that count, because the
      // shared cloud primitive had no status channel at all until it was given
      // one. `type: 'fire'` matters too: Afflictor's Index and the ailment
      // commons read the damage type.
      groundAim(ctx, player, 26, _a);
      const px = _a.x, py = _a.y, pz = _a.z;
      player.schedule(0.55, () => {
        _origin.set(px, py, pz);
        ctx.items?.addCloud?.(_origin, 6, 8, 0.9, { status: 'burn', colour: 0xff7a2a, type: 'fire' });
        ctx.vfx?.ring?.(_origin, 6, 0xff7a2a);
        ctx.vfx?.rings?.spawn?.(_origin, _up, 0xffd76a, 0.4, 6, 0.5, 0.85);
        ctx.vfx?.lights?.flick?.(_origin, 0xff8a20, 22, 14, 0.28);
        ctx.audio?.explosion?.(_origin, 6);
      });

      ctx.vfx?.muzzleFlash?.(player.muzzlePosition(), _tmp, 1.0);
      player.mesh.addRecoil(0.8);
      player.addAimPunch(1.0);
      ctx.cameraRig?.punch(1.0);
      ctx.audio?.shoot?.(player.position, 1.0);
      ctx.audio?.ability?.(1);
    },
  },

  cinderBackdraft: {
    id: 'cinderBackdraft',
    shape: 'streak-cone',
    name: 'Backdraft',
    slot: 'utility',
    key: 'Q',
    cooldown: 6.0,
    charges: 1,
    description: 'Vent the tanks: 200% damage in 6m, ignite everything, and be thrown clear.',
    fire(ctx, player) {
      this.replayFire(ctx, player);

      // The roster's other three escapes buy distance and nothing else: the
      // Ranger's roll trades i-frames for position, Anvil's charge trades
      // position for damage in a *line*, Kestrel's vault trades position for
      // height. This one is the only escape that damages what it is escaping
      // from, in every direction, which is what an attrition kit needs — the
      // pack that closed on you is now the pack that is on fire.
      const at = _origin.copy(player.position).setY(player.position.y + 0.8);
      ctx.combat?.explode?.(at, 6, player.stats.damage * 2.0, player, {
        proc: 0.6, type: 'fire', status: 'burn',
      });

      // Six exhaust jets thrown outward and down, plus the two ground rings:
      // the shape has to say "the pressure left through the sides", so the
      // geometry radiates rather than pointing anywhere.
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + 0.3;
        _a.copy(at).add(_tmp.set(Math.sin(ang) * 0.35, 0.1, Math.cos(ang) * 0.35));
        _b.copy(at).add(_tmp.set(Math.sin(ang) * 3.4, -0.7, Math.cos(ang) * 3.4));
        _col.set(0xff8a20);
        ctx.vfx?.beams?.spawn?.(_a, _b, _col, 0.16, 0.42, 0.26, 0.9, 1);
        ctx.vfx?.beams?.spawn?.(_a, _b, WHITE, 0.05, 0.12, 0.18, 2.4, 1);
      }
      ctx.vfx?.rings?.spawn?.(player.position, _up, 0xffd76a, 0.3, 4.0, 0.4, 0.9);
      ctx.vfx?.rings?.spawn?.(player.position, _up, 0xff5a12, 2.0, 6.4, 0.6, 0.45);
      ctx.vfx?.impact?.(player.position, _up, 'dirt');
      ctx.vfx?.lights?.flick?.(at, 0xff8a20, 26, 15, 0.2);
      ctx.cameraRig?.punch(-2.0);
      ctx.pipeline?.addShake?.(0.07);
      ctx.hitstop = Math.max(ctx.hitstop || 0, 0.04);
      ctx.audio?.explosion?.(player.position, 6);
      ctx.audio?.ability?.(2);
    },
    /**
     * The movement half, and it is a *velocity* change rather than a dash for
     * the same reason Kestrel's Vault is: the survivor is being blown off her
     * feet, so it has to compose with gravity and air control instead of
     * overriding them. Backwards from the aim by default — this is a
     * disengage — but a held direction wins, so it can also be used to cross a
     * gap forwards at the cost of eating your own blast radius on the way out.
     */
    replayFire(ctx, player) {
      player.aimForward(_tmp);
      if (player.moving) _tmp.copy(player.wishDirection()).multiplyScalar(-1);
      player.velocity.x = -_tmp.x * 15;
      player.velocity.z = -_tmp.z * 15;
      player.velocity.y = 9.5;
      player.grounded = false;
      player.jumpsUsed = 0;
      player.jumpBuffer = 0;
      // Shorter than the Ranger's roll: this is not a dodge, and giving it real
      // invulnerability would make the highest-damage escape on the roster also
      // the safest one.
      player.grantIFrames(0.12);
    },
  },

  cinderConflagration: {
    id: 'cinderConflagration',
    shape: 'ring',
    name: 'Conflagration',
    slot: 'special',
    key: 'R',
    cooldown: 13.0,
    charges: 1,
    description: 'Detonate every burning enemy within 34m: each one bursts for 600% damage in 5.5m. The bursts overlap, so a tight pack pays several times over.',
    fire(ctx, player) {
      const CHARGE = 0.4;
      chargeTell(ctx, player, CHARGE, 0xff8a20, 6);
      ctx.audio?.ability?.(3);

      player.schedule(CHARGE, () => {
        const c = ctx.combat;
        // Snapshotted before anything is damaged: each detonation below is an
        // `explode`, which can proc items that overlap again and rewrite
        // Combat's shared buffer under the loop. The same trap `nearbyHostiles`
        // and `damageGroup` are written around.
        _group.length = 0;
        if (c?.sphereOverlap) {
          const n = c.sphereOverlap(player.position, 34, 'player');
          for (let i = 0; i < n; i++) _group.push(c.overlapAt(i));
        }

        // The burning set is resolved *before* the first detonation, and this is
        // load-bearing rather than tidy.
        //
        // Each detonation re-applies `burn` inside its own 5.5 m radius. Testing
        // `hasStatus` inside the loop therefore meant a body that was not
        // burning at cast time could be lit by an earlier blast and then pass
        // the test when the loop reached it — a cascade nobody documented, which
        // could only propagate *forwards* through `_group`, whose order is the
        // spatial hash's. Identical formations paid different amounts depending
        // on iteration order, which is the part that is unacceptable at any
        // magnitude: the player cannot see the hash.
        //
        // Measured, one lit body among eight at 3 m spacing detonated two of
        // them for 332 against a stated 78.
        _lit.length = 0;
        for (let i = 0; i < _group.length; i++) {
          const e = _group[i];
          if (e?.alive && c.hasStatus(e, 'burn')) _lit.push(e);
        }
        _group.length = 0;

        // The payoff, and the reason the primary is allowed to be weak: this
        // pays *per burning body*, so its value is entirely a function of how
        // well the last ten seconds were spent spreading the fire. Against one
        // target it is a mediocre 600%; against a horde the Stoke cone has been
        // washed over it is the biggest single number on the roster.
        //
        // `falloff` is left on (the default). With it off, overlapping 5.5 m
        // blasts each paid full damage to every body in range, so a tight
        // cluster multiplied the printed number by however many of its members
        // happened to be alight — the second half of the 4-6x overpay. Falloff
        // bottoms out at 0.35, so a cluster still pays more than a lone target,
        // which is the intended shape; it just no longer pays linearly in the
        // square of the pack size.
        //
        // The ceiling, measured rather than argued, because "bounded" is not a
        // number: a body inside K overlapping blasts pays at worst 1 + 0.35(K-1)
        // of the printed 600%, so the whole cast plateaus near 4x printed and
        // does not grow past it. Measured: a lone body pays exactly 72.0 on a
        // printed 72 (1.00x) and nothing at all with 0 lit; 8 bodies at 3 m
        // with 1 lit pay 1.45x; 3 lit pay 1.76x; 8 at 1.2 m all lit pay 4.00x
        // (2302.9 against 576); 12 at 1.5 m all lit pay 2.79x (2410.2 against
        // 864) — the ratio falls, not rises, once the pack is wider than one
        // blast. 4x on a pile the Stoke cone had to build is the
        // card working; it is stated in the description because a payout the
        // player cannot predict is the same defect as one they cannot see.
        const litCount = _lit.length;
        for (let i = 0; i < _lit.length; i++) {
          const e = _lit[i];
          if (!e.alive) continue;
          // The blast is centred on the body, not on the raised point the VFX
          // is drawn at. With falloff live those are no longer the same thing:
          // an epicentre lifted 0.4 of the target's height put the detonating
          // body itself a metre off its own explosion and paid it 93% of the
          // printed 600%. The fire draws from the chest; the damage comes from
          // where the monster is.
          // Copied, not aliased: `explode` holds `point` across a loop that can
          // proc items which move bodies, and `e.position` is live.
          _a.copy(e.position);
          _b.copy(e.position).setY(e.position.y + (e.height || 1.8) * 0.4);
          // No `status: 'burn'` rider. Snapshotting `_lit` closed the cascade
          // *within* one cast; the rider re-opened it *across* casts, because
          // every detonation left a much larger burning set behind it and
          // Temporal Echo fires the identical ability again 0.9 s later.
          // Measured, ten bodies at 2.2 m with exactly one lit: 140.4 alone
          // against 673.2 with the echo — 9.35x the printed 72, with the "free"
          // second cast worth 4.79x the first because it inherited a set the
          // first one made. This ability is the payout; the Pyre Flask and the
          // Stoke cone are the setup, and a payout that re-arms itself is not a
          // payout. Bodies the player lit stay lit — `explode` still cannot put
          // one out — so the echo pays for the setup that was actually spent.
          c.explode(_a, 5.5, player.stats.damage * 6.0, player, {
            proc: 0.5, type: 'fire',
          });
          ctx.vfx?.explosion?.(_b, 4.5, 0xff9a3c);
          ctx.vfx?.beam?.(player.muzzlePosition(), _b, 0xffd76a);
        }
        _lit.length = 0;

        // The cast is *never* silent, even when nothing was burning: an ability
        // whose feedback depends on whether it found targets teaches the player
        // that the button is unreliable rather than that their setup was.
        ctx.vfx?.rings?.spawn?.(player.position, _up, 0xff8a20, 1.0, 34, 0.55, 0.7);
        ctx.vfx?.lights?.flick?.(player.position, 0xffd76a, 30 + litCount * 4, 20, 0.22);
        player.mesh.addRecoil(1.6);
        player.addAimPunch(2.2);
        ctx.cameraRig?.punch(3.2);
        ctx.pipeline?.addShake?.(0.10 + Math.min(0.2, litCount * 0.03));
        if (litCount) ctx.hitstop = Math.max(ctx.hitstop || 0, 0.07);
        ctx.audio?.explosion?.(player.position, 10);
      });
    },
  },
};

export const SLOT_ORDER = ['primary', 'secondary', 'utility', 'special'];

/** Effective cooldown after items and (for basic attacks) attack speed. */
export function effectiveCooldown(ability, stats) {
  let cd = ability.cooldown * clamp(stats.cooldownMult ?? 1, 0.05, 4);
  if (ability.scalesWithAttackSpeed) cd /= Math.max(0.1, stats.attackSpeed ?? 1);
  return cd;
}
