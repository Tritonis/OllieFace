import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';

/**
 * The survivor's four loadout slots, in RoR2's shape.
 *
 * Each ability is data + a `fire(ctx, player)`. Cooldown accounting, charge
 * accounting and the `abilityUsed` event all live in Player — an ability only
 * describes what happens when it goes off.
 *
 * `cooldown` is in seconds *before* `stats.cooldownMult`.
 * `scalesWithAttackSpeed` makes the recovery divide by `stats.attackSpeed`
 * (primary only, matching how RoR2 treats basic attacks).
 * Damage numbers are coefficients of `stats.damage`.
 */

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

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

export const ABILITIES = {
  primary: {
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

  secondary: {
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

  utility: {
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
  },

  special: {
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
};

export const SLOT_ORDER = ['primary', 'secondary', 'utility', 'special'];

/** Effective cooldown after items and (for basic attacks) attack speed. */
export function effectiveCooldown(ability, stats) {
  let cd = ability.cooldown * clamp(stats.cooldownMult ?? 1, 0.05, 4);
  if (ability.scalesWithAttackSpeed) cd /= Math.max(0.1, stats.attackSpeed ?? 1);
  return cd;
}
