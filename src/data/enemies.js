// Data-driven monster definitions.
//
// `cost` is the director's credit price and is the only thing that decides
// what shows up when — exactly like a RoR2 spawn card. Everything else here is
// the *base* stat block; the Enemy multiplies it by the director's difficulty
// scaling at spawn time.
//
// Attack shape:
//   kind     'melee' | 'projectile' | 'beam' | 'dive' | 'slam' | 'barrage' | 'stomp'
//   windup   seconds of telegraphed anticipation before anything can hurt you
//   active   seconds the hitbox / beam is live
//   recover  seconds of committed follow-through afterwards
//   cooldown seconds before this attack is offered again
//   damage   multiplier on the unit's scaled damage

export const TEAM = 'monster';

export const ENEMIES = [
  {
    id: 'beetle',
    name: 'Beetle',
    tier: 1,
    cost: 6,
    baseHealth: 90,
    baseDamage: 10,
    moveSpeed: 5.4,
    turnRate: 6.0,
    attackRange: 2.4,
    radius: 0.55,
    height: 0.95,
    mass: 1,
    xp: 1,
    isFlyer: false,
    eliteEligible: true,
    packMin: 3,
    packMax: 6,
    meshFactory: 'beetle',
    attacks: [
      // The beetle is the first thing anyone meets, so its tell is the longest
      // relative to its reach: it rears back for two thirds of a second before
      // anything can hurt you.
      { id: 'headbutt', kind: 'melee', range: 2.4, windup: 0.66, active: 0.14, recover: 0.46, cooldown: 1.6, damage: 1, arc: 1.1, lunge: 8 },
    ],
  },
  {
    id: 'lemurian',
    name: 'Lemurian',
    tier: 1,
    cost: 11,
    baseHealth: 150,
    baseDamage: 14,
    moveSpeed: 6.2,
    turnRate: 5.0,
    attackRange: 3.0,
    radius: 0.5,
    height: 1.7,
    mass: 1.2,
    xp: 2,
    isFlyer: false,
    eliteEligible: true,
    packMin: 2,
    packMax: 4,
    meshFactory: 'lemurian',
    attacks: [
      { id: 'bite', kind: 'melee', range: 3.0, windup: 0.56, active: 0.12, recover: 0.5, cooldown: 1.4, damage: 1, arc: 0.9, lunge: 6 },
      {
        id: 'fireball', kind: 'projectile', range: 24, minRange: 5, windup: 0.9, active: 0.06, recover: 0.65,
        cooldown: 5.0, damage: 1.5, speed: 20, gravity: 3.5, radius: 0.4, blast: 2.2, life: 3.5, color: 0xff6a12,
        muzzleY: 1.55, muzzleZ: 0.9,
      },
    ],
  },
  {
    id: 'wisp',
    name: 'Wisp',
    tier: 1,
    cost: 13,
    baseHealth: 110,
    baseDamage: 12,
    moveSpeed: 4.2,
    turnRate: 4.0,
    attackRange: 26,
    radius: 0.5,
    height: 1.1,
    hoverHeight: 4.2,
    mass: 0.6,
    xp: 2,
    isFlyer: true,
    eliteEligible: true,
    packMin: 1,
    packMax: 3,
    preferredRange: 16,
    meshFactory: 'wisp',
    attacks: [
      {
        id: 'bolt', kind: 'projectile', range: 26, minRange: 0, windup: 0.72, active: 0.06, recover: 0.5,
        cooldown: 2.2, damage: 1, speed: 13, gravity: 0, homing: 2.6, radius: 0.35, blast: 0, life: 5, color: 0xff7a1e,
        muzzleY: 0, muzzleZ: 0.4, burst: 2, burstGap: 0.22,
      },
    ],
  },
  {
    id: 'pest',
    name: 'Blind Pest',
    tier: 1,
    cost: 16,
    baseHealth: 100,
    baseDamage: 16,
    moveSpeed: 8.5,
    turnRate: 5.5,
    attackRange: 15,
    radius: 0.5,
    height: 1.0,
    hoverHeight: 3.4,
    mass: 0.5,
    xp: 2,
    isFlyer: true,
    eliteEligible: true,
    packMin: 2,
    packMax: 4,
    erratic: 1,
    meshFactory: 'pest',
    attacks: [
      {
        id: 'dive', kind: 'dive', range: 15, windup: 0.62, active: 1.1, recover: 0.2, cooldown: 3.0,
        damage: 1.9, blast: 4.6, diveSpeed: 22, suicide: true, color: 0xff3566,
      },
    ],
  },
  {
    id: 'golem',
    name: 'Stone Golem',
    tier: 2,
    cost: 32,
    baseHealth: 520,
    baseDamage: 20,
    moveSpeed: 3.6,
    turnRate: 2.2,
    attackRange: 42,
    radius: 1.0,
    height: 3.6,
    mass: 4,
    xp: 6,
    isFlyer: false,
    eliteEligible: true,
    packMin: 1,
    packMax: 2,
    preferredRange: 22,
    meshFactory: 'golem',
    attacks: [
      {
        id: 'laser', kind: 'beam', range: 42, minRange: 0, windup: 1.55, active: 0.28, recover: 0.95,
        cooldown: 5.2, damage: 2.3, beamRadius: 0.9, trackDuring: 0.75, color: 0x22d3ff,
      },
    ],
  },
  {
    id: 'titan',
    name: 'Stone Titan',
    tier: 3,
    cost: 420,
    baseHealth: 3200,
    baseDamage: 34,
    moveSpeed: 3.2,
    turnRate: 1.5,
    attackRange: 55,
    radius: 2.2,
    height: 7.6,
    mass: 20,
    xp: 40,
    isFlyer: false,
    isBoss: true,
    eliteEligible: true,
    packMin: 1,
    packMax: 1,
    preferredRange: 14,
    phase2At: 0.5,
    meshFactory: 'titan',
    attacks: [
      {
        id: 'slam', kind: 'slam', range: 15, windup: 1.25, active: 0.2, recover: 0.9, cooldown: 6.0,
        damage: 2.6, blast: 15, waveSpeed: 22, color: 0xffa514, weight: 3,
      },
      {
        id: 'barrage', kind: 'barrage', range: 55, minRange: 8, windup: 1.9, active: 2.4, recover: 1.1,
        cooldown: 11.0, damage: 0.55, beamRadius: 1.5, sweep: 1.5, tick: 0.2, color: 0xffa514, weight: 2,
      },
      {
        id: 'stomp', kind: 'stomp', range: 9, windup: 0.8, active: 0.16, recover: 0.7, cooldown: 4.0,
        damage: 2.2, blast: 10, waveSpeed: 30, color: 0xffa514, weight: 3,
      },
    ],
  },
];

export const ENEMY_BY_ID = new Map(ENEMIES.map((e) => [e.id, e]));

/** Everything the director may buy with credits during normal play. */
export const SPAWN_CARDS = ENEMIES.filter((e) => !e.isBoss);

/** Bosses are only ever placed by the teleporter event. */
export const BOSS_CARDS = ENEMIES.filter((e) => e.isBoss);

/** Tier unlock thresholds on the difficulty coefficient. */
export const TIER_UNLOCK = { 1: 0, 2: 1.55, 3: Infinity };

export const ELITE_AFFIXES = ['blazing', 'overloading', 'glacial'];

/** RoR2 tier-1 elite multipliers, plus the affix-specific on-hit behaviour. */
export const ELITE_STATS = {
  blazing:     { health: 4.0, damage: 2.0, cost: 4.5, speed: 1.0,  burn: 0.35, auraRadius: 3.2, auraDps: 0.35 },
  overloading: { health: 3.2, damage: 2.0, cost: 5.0, speed: 1.15, shield: 0.5, deathBlast: 3.0, blastRadius: 7 },
  glacial:     { health: 4.0, damage: 2.0, cost: 4.5, speed: 0.92, slow: 0.5, slowTime: 2.0, novaRadius: 8, novaDamage: 1.5 },
};
