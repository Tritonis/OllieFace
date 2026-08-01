// Data-driven monster definitions.
//
// `cost` is the director's credit price and is the only thing that decides
// what shows up when — exactly like a RoR2 spawn card. Everything else here is
// the *base* stat block; the Enemy multiplies it by the director's difficulty
// scaling at spawn time.
//
// Attack shape:
//   kind     'melee' | 'projectile' | 'beam' | 'dive' | 'slam' | 'barrage' | 'stomp'
//            | 'charge' | 'nova' | 'summon' | 'burrow' | 'pull' | 'mend'
//   windup   seconds of telegraphed anticipation before anything can hurt you
//   active   seconds the hitbox / beam is live
//   recover  seconds of committed follow-through afterwards
//   cooldown seconds before this attack is offered again
//   damage   multiplier on the unit's scaled damage
//   phase    minimum boss phase this attack is offered in (default 1)
//
// `selectionWeight` is spawn-card rarity and `maxAlive` is how many of this
// card may stand on the field at once. The second one is load-bearing: without
// it the cheapest card in the table fills the population cap on its own and
// nothing else in the roster can ever be bought — measured at minute 12, a
// field of 24 monsters was 24 mites and nothing else.
//
// `behavior` is the movement personality the Enemy's steering reads. It is
// deliberately separate from the attack list: two units can share the mortar
// attack and still occupy the fight completely differently depending on whether
// they hold ground or run from you.
//
//   'melee'      close, prowl at the edge of reach, commit in sequence
//   'ranged'     hold `preferredRange`, reposition when blocked
//   'kiter'      hold range *hard* — backs off the moment you close
//   'swarm'      no prowl, no patience: straight in, in numbers
//   'charger'    close to charge range, then commit to a straight-line dash
//   'support'    ignores the player, orbits the nearest ally it can buff
//   'stationary' never leaves its anchor; the arena moves, it does not
//   'burrower'   submerges out of reach and resurfaces underneath you

export const TEAM = 'monster';

export const ENEMIES = [
  // -------------------------------------------------------------------------
  // TIER 1 — the opening pressure. Cheap, legible, and every one of them is a
  // different *shape* of threat so the first two minutes still have texture.
  // -------------------------------------------------------------------------
  {
    id: 'mite',
    maxAlive: 12,
    selectionWeight: 1.0,
    name: 'Chitter Mite',
    tier: 1,
    cost: 4,
    baseHealth: 46,
    baseDamage: 6,
    moveSpeed: 8.4,
    turnRate: 9.0,
    attackRange: 1.9,
    radius: 0.34,
    height: 0.5,
    mass: 0.4,
    xp: 1,
    isFlyer: false,
    eliteEligible: false,
    behavior: 'swarm',
    packMin: 5,
    packMax: 9,
    meshFactory: 'mite',
    attacks: [
      // Almost no tell, almost no damage. The mite is a *quantity* threat: one
      // is free, nine of them arriving from three bearings is a real problem,
      // and the answer is AoE rather than aim.
      { id: 'nip', kind: 'melee', range: 1.9, windup: 0.2, active: 0.1, recover: 0.22, cooldown: 0.9, damage: 1, arc: 1.4, lunge: 7 },
    ],
  },
  {
    id: 'beetle',
    maxAlive: 10,
    selectionWeight: 1.0,
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
    id: 'spitling',
    maxAlive: 6,
    selectionWeight: 0.9,
    name: 'Bile Spitling',
    tier: 1,
    cost: 9,
    baseHealth: 105,
    baseDamage: 11,
    moveSpeed: 5.0,
    turnRate: 4.2,
    attackRange: 20,
    radius: 0.48,
    height: 1.0,
    mass: 0.9,
    xp: 2,
    isFlyer: false,
    eliteEligible: true,
    behavior: 'kiter',
    preferredRange: 13,
    packMin: 2,
    packMax: 4,
    meshFactory: 'spitling',
    attacks: [
      // A lobbed arc, not a flat shot — it clears the cover you are hiding
      // behind, which is what makes a pack of them a reason to keep walking.
      {
        id: 'spit', kind: 'projectile', range: 20, minRange: 4, windup: 0.62, active: 0.06, recover: 0.42,
        cooldown: 2.6, damage: 1.1, speed: 15, gravity: 11, radius: 0.34, blast: 2.6, life: 3.5, color: 0x9be035,
        muzzleY: 0.85, muzzleZ: 0.5, telegraph: 2.6, status: 'slow',
      },
    ],
  },
  {
    id: 'lemurian',
    maxAlive: 6,
    selectionWeight: 0.9,
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
    maxAlive: 5,
    selectionWeight: 0.8,
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
    maxAlive: 5,
    selectionWeight: 0.7,
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
    id: 'harrier',
    maxAlive: 4,
    selectionWeight: 0.6,
    name: 'Cinder Harrier',
    tier: 1,
    cost: 18,
    baseHealth: 145,
    baseDamage: 13,
    moveSpeed: 9.6,
    turnRate: 3.4,
    attackRange: 22,
    radius: 0.55,
    height: 1.3,
    hoverHeight: 5.6,
    mass: 0.7,
    xp: 3,
    isFlyer: true,
    eliteEligible: true,
    behavior: 'kiter',
    preferredRange: 15,
    packMin: 1,
    packMax: 3,
    meshFactory: 'harrier',
    attacks: [
      // A strafing run: the beam is short but it *sweeps*, so standing still
      // under a harrier is the one thing that guarantees the whole burst lands.
      {
        id: 'strafe', kind: 'barrage', range: 22, minRange: 4, windup: 0.85, active: 0.9, recover: 0.55,
        cooldown: 6.0, damage: 0.5, beamRadius: 0.55, sweep: 0.9, tick: 0.14, color: 0xffb648,
      },
    ],
  },
  {
    id: 'charger',
    maxAlive: 4,
    selectionWeight: 0.55,
    name: 'Ridgeback Charger',
    tier: 1,
    cost: 22,
    baseHealth: 260,
    baseDamage: 20,
    moveSpeed: 5.6,
    turnRate: 3.0,
    attackRange: 18,
    radius: 0.75,
    height: 1.6,
    mass: 3,
    xp: 4,
    isFlyer: false,
    eliteEligible: true,
    behavior: 'charger',
    preferredRange: 12,
    packMin: 1,
    packMax: 3,
    meshFactory: 'charger',
    attacks: [
      // The whole unit is one attack. It plants, paws the ground for most of a
      // second with its head down, and then commits to a straight line it
      // cannot correct — sidestep and it eats the terrain behind you.
      {
        id: 'gore', kind: 'charge', range: 18, minRange: 5, windup: 0.95, active: 1.15, recover: 0.85,
        cooldown: 6.5, damage: 2.2, chargeSpeed: 26, hitRadius: 1.5, color: 0xffd166, knock: 9,
      },
      { id: 'buck', kind: 'melee', range: 2.8, windup: 0.45, active: 0.12, recover: 0.4, cooldown: 2.2, damage: 1, arc: 1.2, lunge: 5, weight: 0.6 },
    ],
  },

  // -------------------------------------------------------------------------
  // TIER 2 — the mid-run roster. These are the units that stop the fight being
  // solvable by standing on one rock and holding the trigger.
  // -------------------------------------------------------------------------
  {
    id: 'burrower',
    maxAlive: 4,
    selectionWeight: 0.6,
    name: 'Silt Burrower',
    tier: 2,
    cost: 20,
    baseHealth: 210,
    baseDamage: 18,
    moveSpeed: 5.2,
    burrowSpeed: 11.5,
    turnRate: 4.0,
    attackRange: 30,
    radius: 0.7,
    height: 1.4,
    mass: 2,
    xp: 4,
    isFlyer: false,
    eliteEligible: true,
    behavior: 'burrower',
    packMin: 1,
    packMax: 3,
    meshFactory: 'burrower',
    attacks: [
      // Untouchable while under, and it closes faster down there than it walks
      // up here. The tell is the spoil-mound racing toward your feet plus the
      // ground ring at the surfacing point — this is the unit that punishes
      // standing on the same rock twice.
      {
        id: 'erupt', kind: 'burrow', range: 30, minRange: 0, windup: 0.7, submerge: 2.4, active: 0.45, recover: 1.0,
        cooldown: 8.0, damage: 2.0, blast: 5.5, waveSpeed: 20, color: 0xd8a860,
      },
      { id: 'rake', kind: 'melee', range: 2.6, windup: 0.5, active: 0.12, recover: 0.42, cooldown: 1.8, damage: 1, arc: 1.0, lunge: 6, weight: 0.8 },
    ],
  },
  {
    id: 'brood',
    maxAlive: 2,
    selectionWeight: 0.4,
    name: 'Brood Sac',
    tier: 2,
    cost: 24,
    baseHealth: 420,
    baseDamage: 10,
    moveSpeed: 0,
    turnRate: 1.2,
    attackRange: 60,
    radius: 1.1,
    height: 2.4,
    mass: 8,
    xp: 5,
    isFlyer: false,
    eliteEligible: false,
    behavior: 'stationary',
    packMin: 1,
    packMax: 1,
    meshFactory: 'brood',
    attacks: [
      // It cannot chase and it barely fights. It is a *timer*: every eight
      // seconds the arena gets four more mites until somebody walks over and
      // deals with it, which is the pressure a horde shooter needs to stop the
      // player camping a corner.
      { id: 'hatch', kind: 'summon', range: 60, windup: 1.4, active: 0.3, recover: 0.8, cooldown: 8.0, damage: 0, summon: 'mite', count: 4, spread: 3.2, color: 0x8ee06a },
      { id: 'burst', kind: 'nova', range: 7, windup: 0.9, active: 0.2, recover: 0.7, cooldown: 6.0, damage: 1.2, blast: 7, waveSpeed: 18, color: 0x8ee06a, weight: 0.7 },
    ],
  },
  {
    id: 'warden',
    maxAlive: 4,
    selectionWeight: 0.5,
    name: 'Aegis Warden',
    tier: 2,
    cost: 26,
    baseHealth: 480,
    baseDamage: 22,
    moveSpeed: 4.2,
    turnRate: 2.0,
    attackRange: 3.4,
    radius: 0.85,
    height: 2.5,
    mass: 6,
    xp: 6,
    isFlyer: false,
    eliteEligible: true,
    // Damage arriving inside this cone of its facing is cut by `frontArmor`.
    // Shooting it in the face is the wrong answer; walking around it is the
    // right one, and that is the entire design of the unit.
    frontArc: 1.15,
    frontArmor: 0.82,
    packMin: 1,
    packMax: 2,
    meshFactory: 'warden',
    attacks: [
      { id: 'bash', kind: 'melee', range: 3.4, windup: 0.72, active: 0.16, recover: 0.6, cooldown: 2.2, damage: 1.2, arc: 0.8, lunge: 7 },
      // Shield-slam: short, wide, and it shoves. Standing behind cover in front
      // of a warden is not cover.
      { id: 'quake', kind: 'nova', range: 6, windup: 1.0, active: 0.18, recover: 0.8, cooldown: 7.0, damage: 1.6, blast: 8, waveSpeed: 22, color: 0x7fd4ff, weight: 0.8 },
    ],
  },
  {
    id: 'stalker',
    maxAlive: 4,
    selectionWeight: 0.5,
    name: 'Rift Stalker',
    tier: 2,
    cost: 28,
    baseHealth: 300,
    baseDamage: 26,
    moveSpeed: 7.4,
    turnRate: 7.0,
    attackRange: 3.2,
    radius: 0.5,
    height: 1.9,
    mass: 1.4,
    xp: 6,
    isFlyer: false,
    eliteEligible: true,
    packMin: 1,
    packMax: 3,
    meshFactory: 'stalker',
    attacks: [
      // Blink-lunge: it vanishes for a quarter-second and arrives inside your
      // guard. The tell is the collapse of its own rift shell, which is bright
      // and lasts long enough to roll away from.
      {
        id: 'blink', kind: 'charge', range: 16, minRange: 4, windup: 0.55, active: 0.35, recover: 0.7,
        cooldown: 5.0, damage: 1.8, chargeSpeed: 42, hitRadius: 1.2, blink: true, color: 0xb98cff,
      },
      { id: 'slash', kind: 'melee', range: 3.2, windup: 0.4, active: 0.1, recover: 0.36, cooldown: 1.5, damage: 1, arc: 1.0, lunge: 8 },
    ],
  },
  {
    id: 'acolyte',
    maxAlive: 2,
    selectionWeight: 0.35,
    name: 'Grave Acolyte',
    tier: 2,
    cost: 30,
    baseHealth: 240,
    baseDamage: 12,
    moveSpeed: 5.8,
    turnRate: 4.0,
    attackRange: 18,
    radius: 0.5,
    height: 2.0,
    mass: 1,
    xp: 7,
    isFlyer: false,
    eliteEligible: false,
    behavior: 'support',
    preferredRange: 26,
    packMin: 1,
    packMax: 2,
    meshFactory: 'acolyte',
    attacks: [
      // It never attacks you. It hangs at the back of the pack knitting its
      // neighbours back together, which makes it the correct thing to shoot
      // first — the whole point of a support unit is teaching target priority.
      { id: 'mend', kind: 'mend', range: 18, windup: 0.8, active: 0.5, recover: 0.6, cooldown: 5.0, damage: 0, healFrac: 0.16, shieldFrac: 0.25, targets: 4, color: 0x74ffc8 },
    ],
  },
  {
    id: 'golem',
    maxAlive: 4,
    selectionWeight: 0.7,
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
    id: 'mortar',
    maxAlive: 3,
    selectionWeight: 0.45,
    name: 'Siege Bombard',
    tier: 2,
    cost: 34,
    baseHealth: 460,
    baseDamage: 24,
    moveSpeed: 3.0,
    turnRate: 1.8,
    attackRange: 58,
    radius: 0.95,
    height: 2.8,
    mass: 7,
    xp: 8,
    isFlyer: false,
    eliteEligible: true,
    behavior: 'kiter',
    preferredRange: 34,
    packMin: 1,
    packMax: 2,
    meshFactory: 'mortar',
    attacks: [
      // Three shells on a high arc, each with its own ground ring, walked out
      // across where you are standing. Cover does nothing; only moving does.
      {
        id: 'shell', kind: 'projectile', range: 58, minRange: 12, windup: 1.35, active: 0.1, recover: 0.9,
        cooldown: 7.0, damage: 1.5, speed: 24, gravity: 22, radius: 0.42, blast: 5.0, life: 6, color: 0xff8a3c,
        muzzleY: 2.2, muzzleZ: 0.6, burst: 3, burstGap: 0.42, telegraph: 5.0, scatter: 2.4,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // TIER 3 — late-run heavies. One of these is a wave on its own.
  // -------------------------------------------------------------------------
  {
    id: 'hulk',
    maxAlive: 2,
    selectionWeight: 0.25,
    name: 'Slag Hulk',
    tier: 3,
    cost: 46,
    baseHealth: 900,
    baseDamage: 30,
    moveSpeed: 3.4,
    turnRate: 1.6,
    attackRange: 40,
    radius: 1.25,
    height: 4.2,
    mass: 12,
    xp: 12,
    isFlyer: false,
    eliteEligible: true,
    armor: 12,
    packMin: 1,
    packMax: 1,
    preferredRange: 8,
    meshFactory: 'hulk',
    attacks: [
      { id: 'crush', kind: 'slam', range: 8, windup: 1.15, active: 0.2, recover: 0.85, cooldown: 6.0, damage: 2.2, blast: 11, waveSpeed: 20, color: 0xff7a2a, weight: 2 },
      // Molten spray: a wide, slow shotgun that owns the ground in front of it.
      {
        id: 'spray', kind: 'projectile', range: 26, minRange: 6, windup: 0.95, active: 0.3, recover: 0.7,
        cooldown: 5.5, damage: 0.8, speed: 19, gravity: 8, radius: 0.34, blast: 2.4, life: 3, color: 0xff5a12,
        muzzleY: 2.6, muzzleZ: 1.1, volley: 5, volleySpread: 0.28, weight: 2,
      },
      { id: 'vent', kind: 'nova', range: 7, windup: 0.8, active: 0.2, recover: 0.6, cooldown: 9.0, damage: 1.6, blast: 9, waveSpeed: 26, color: 0xff9a3c, status: 'burn', weight: 1 },
    ],
  },

  // -------------------------------------------------------------------------
  // BOSSES — teleporter-event only. Every one of them is multi-phase, and every
  // phase changes what the player has to *do*, not just how hard it hits.
  // -------------------------------------------------------------------------
  {
    id: 'titan',
    name: 'Stone Titan',
    tier: 4,
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
    // P1 stone. P2 (65%) the core cracks open and it speeds up. P3 (28%) it
    // burns from the inside and vents a nova between every other attack.
    phaseAt: [0.65, 0.28],
    phase2At: 0.65,
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
      {
        id: 'meltdown', kind: 'nova', range: 16, windup: 1.5, active: 0.25, recover: 1.0, cooldown: 9.0,
        damage: 2.4, blast: 18, waveSpeed: 26, color: 0xff5a12, status: 'burn', phase: 3, weight: 4,
      },
    ],
  },
  {
    id: 'wyrm',
    name: 'Ossuary Wyrm',
    tier: 4,
    cost: 440,
    baseHealth: 3000,
    baseDamage: 32,
    moveSpeed: 6.4,
    burrowSpeed: 15,
    turnRate: 2.4,
    attackRange: 46,
    radius: 2.0,
    height: 5.4,
    mass: 18,
    xp: 40,
    isFlyer: false,
    isBoss: true,
    eliteEligible: true,
    packMin: 1,
    packMax: 1,
    preferredRange: 10,
    // P1 it fights on the surface. P2 (62%) it lives underground and only
    // surfaces to erupt, so the fight becomes about reading spoil-mounds.
    // P3 (26%) it does both and salts the arena with bone shards.
    phaseAt: [0.62, 0.26],
    phase2At: 0.62,
    meshFactory: 'wyrm',
    attacks: [
      {
        id: 'sweep', kind: 'melee', range: 6.5, windup: 0.85, active: 0.22, recover: 0.7, cooldown: 3.4,
        damage: 1.9, arc: 1.5, lunge: 14, weight: 3,
      },
      {
        id: 'surface', kind: 'burrow', range: 46, minRange: 0, windup: 0.75, submerge: 2.1, active: 0.5, recover: 1.1,
        cooldown: 8.0, damage: 2.4, blast: 9, waveSpeed: 24, color: 0xe8d6a8, phase: 2, weight: 5,
      },
      {
        id: 'shards', kind: 'projectile', range: 40, minRange: 6, windup: 1.1, active: 0.3, recover: 0.8,
        cooldown: 6.0, damage: 0.9, speed: 26, gravity: 9, radius: 0.36, blast: 2.6, life: 4, color: 0xe8d6a8,
        muzzleY: 3.2, muzzleZ: 1.4, volley: 7, volleySpread: 0.42, phase: 3, weight: 3,
      },
    ],
  },
  {
    id: 'thunderhead',
    name: 'Thunderhead',
    tier: 4,
    cost: 460,
    baseHealth: 2700,
    baseDamage: 30,
    moveSpeed: 5.0,
    turnRate: 2.2,
    attackRange: 50,
    radius: 2.4,
    height: 5.0,
    hoverHeight: 11,
    mass: 10,
    xp: 42,
    isFlyer: true,
    isBoss: true,
    eliteEligible: true,
    behavior: 'ranged',
    packMin: 1,
    packMax: 1,
    preferredRange: 24,
    // P1 it stays high and rains homing bolts. P2 (60%) it drops to head height
    // and rules the ground with a sweeping arc. P3 (25%) both, plus a nova that
    // clears whatever you were sheltering behind.
    phaseAt: [0.60, 0.25],
    phase2At: 0.60,
    descendAt: 2,
    meshFactory: 'thunderhead',
    attacks: [
      {
        id: 'bolts', kind: 'projectile', range: 50, minRange: 0, windup: 1.15, active: 0.5, recover: 0.7,
        cooldown: 4.5, damage: 0.8, speed: 17, gravity: 0, homing: 2.2, radius: 0.4, blast: 2.2, life: 6,
        color: 0x9fd0ff, muzzleY: 0, muzzleZ: 1.2, volley: 4, volleySpread: 0.5, burst: 2, burstGap: 0.3, weight: 3,
      },
      {
        id: 'arc', kind: 'barrage', range: 44, minRange: 5, windup: 1.7, active: 2.0, recover: 1.0,
        cooldown: 10.0, damage: 0.6, beamRadius: 1.2, sweep: 1.7, tick: 0.18, color: 0x9fd0ff, phase: 2, weight: 4,
      },
      {
        id: 'discharge', kind: 'nova', range: 18, windup: 1.3, active: 0.22, recover: 0.9, cooldown: 8.0,
        damage: 2.2, blast: 20, waveSpeed: 32, color: 0xc9b5ff, status: 'shock', phase: 3, weight: 4,
      },
    ],
  },
  {
    id: 'matron',
    name: 'Pyre Matron',
    tier: 4,
    cost: 470,
    baseHealth: 3400,
    baseDamage: 33,
    moveSpeed: 4.4,
    turnRate: 1.9,
    attackRange: 52,
    radius: 2.6,
    height: 5.8,
    mass: 16,
    xp: 44,
    isFlyer: false,
    isBoss: true,
    eliteEligible: true,
    behavior: 'ranged',
    packMin: 1,
    packMax: 1,
    preferredRange: 22,
    // P1 artillery at range. P2 (66%) she starts hatching her brood, so the
    // arena fills and the fight stops being one-on-one. P3 (30%) she closes and
    // the flame nova comes out.
    phaseAt: [0.66, 0.30],
    phase2At: 0.66,
    meshFactory: 'matron',
    attacks: [
      {
        id: 'pyre', kind: 'projectile', range: 52, minRange: 10, windup: 1.4, active: 0.12, recover: 0.9,
        cooldown: 6.0, damage: 1.4, speed: 25, gravity: 20, radius: 0.46, blast: 5.5, life: 6, color: 0xff6a12,
        muzzleY: 3.4, muzzleZ: 1.6, burst: 3, burstGap: 0.38, telegraph: 5.5, scatter: 3.0, status: 'burn', weight: 3,
      },
      {
        id: 'brood', kind: 'summon', range: 52, windup: 1.6, active: 0.35, recover: 0.9, cooldown: 12.0,
        damage: 0, summon: 'mite', count: 6, spread: 4.5, color: 0xff9a3c, phase: 2, weight: 4,
      },
      {
        id: 'cinders', kind: 'nova', range: 14, windup: 1.2, active: 0.22, recover: 0.85, cooldown: 7.0,
        damage: 2.0, blast: 15, waveSpeed: 24, color: 0xff5a12, status: 'burn', phase: 3, weight: 4,
      },
      { id: 'lash', kind: 'melee', range: 5.5, windup: 0.7, active: 0.16, recover: 0.55, cooldown: 3.0, damage: 1.6, arc: 1.2, lunge: 10, weight: 1 },
    ],
  },
  {
    id: 'vizier',
    name: 'Iron Vizier',
    tier: 4,
    cost: 500,
    baseHealth: 3600,
    baseDamage: 36,
    moveSpeed: 4.0,
    turnRate: 2.0,
    attackRange: 44,
    radius: 2.0,
    height: 6.4,
    mass: 22,
    xp: 46,
    isFlyer: false,
    isBoss: true,
    eliteEligible: true,
    // The tower shield is up for the whole of phase 1 and shatters on the phase
    // break, so "flank it" and "burn it down" are two different fights against
    // the same boss.
    frontArc: 1.0,
    frontArmor: 0.85,
    frontArmorPhase: 1,
    packMin: 1,
    packMax: 1,
    preferredRange: 12,
    phaseAt: [0.62, 0.24],
    phase2At: 0.62,
    meshFactory: 'vizier',
    attacks: [
      {
        id: 'advance', kind: 'charge', range: 30, minRange: 6, windup: 1.2, active: 1.3, recover: 1.0,
        cooldown: 7.0, damage: 2.4, chargeSpeed: 24, hitRadius: 2.2, color: 0xbfe4ff, knock: 12, weight: 3,
      },
      { id: 'sunder', kind: 'stomp', range: 10, windup: 1.0, active: 0.18, recover: 0.8, cooldown: 5.0, damage: 2.0, blast: 12, waveSpeed: 28, color: 0xbfe4ff, weight: 3 },
      {
        id: 'edict', kind: 'barrage', range: 44, minRange: 6, windup: 1.8, active: 2.2, recover: 1.1,
        cooldown: 10.0, damage: 0.62, beamRadius: 1.3, sweep: 1.6, tick: 0.18, color: 0x9fe8ff, phase: 2, weight: 4,
      },
      {
        id: 'verdict', kind: 'nova', range: 16, windup: 1.35, active: 0.24, recover: 0.9, cooldown: 8.0,
        damage: 2.3, blast: 17, waveSpeed: 30, color: 0x9fe8ff, status: 'slow', phase: 3, weight: 4,
      },
    ],
  },
  {
    id: 'maw',
    name: 'Verdant Maw',
    tier: 4,
    cost: 480,
    baseHealth: 3800,
    baseDamage: 31,
    moveSpeed: 0,
    turnRate: 1.4,
    attackRange: 60,
    radius: 3.0,
    height: 5.2,
    mass: 40,
    xp: 44,
    isFlyer: false,
    isBoss: true,
    eliteEligible: true,
    behavior: 'stationary',
    packMin: 1,
    packMax: 1,
    // It cannot follow you anywhere, so every phase has to reach further
    // instead: tendril waves, then a pull that drags you back into range, then
    // an arena-wide spore barrage with nowhere neutral to stand.
    phaseAt: [0.64, 0.28],
    phase2At: 0.64,
    meshFactory: 'maw',
    attacks: [
      { id: 'lash', kind: 'slam', range: 14, windup: 1.05, active: 0.2, recover: 0.8, cooldown: 4.5, damage: 1.9, blast: 16, waveSpeed: 20, color: 0x9be035, weight: 3 },
      {
        id: 'spores', kind: 'projectile', range: 60, minRange: 6, windup: 1.2, active: 0.4, recover: 0.8,
        cooldown: 5.5, damage: 0.85, speed: 20, gravity: 12, radius: 0.4, blast: 3.4, life: 6, color: 0x9be035,
        muzzleY: 3.0, muzzleZ: 1.2, volley: 6, volleySpread: 0.55, telegraph: 3.4, scatter: 5.0, weight: 3,
      },
      // The reason a stationary boss works: it takes the ground away from you.
      {
        id: 'draw', kind: 'pull', range: 34, minRange: 0, windup: 1.3, active: 1.6, recover: 0.9,
        cooldown: 9.0, damage: 0.5, pull: 26, blast: 8, color: 0xd8ff7a, phase: 2, weight: 4,
      },
      {
        id: 'bloom', kind: 'nova', range: 20, windup: 1.4, active: 0.25, recover: 0.9, cooldown: 7.5,
        damage: 2.1, blast: 22, waveSpeed: 26, color: 0xd8ff7a, status: 'slow', phase: 3, weight: 4,
      },
    ],
  },
];

export const ENEMY_BY_ID = new Map(ENEMIES.map((e) => [e.id, e]));

// Snapshots carry a one-byte `typeId` instead of the string id — it is what a
// client resolves back into a mesh factory and a max-health scale. 0 is left
// free as "unknown", so the table is 1-based.
ENEMIES.forEach((e, i) => { e.typeId = i + 1; });

export const ENEMY_BY_TYPE = new Map(ENEMIES.map((e) => [e.typeId, e]));

/** Everything the director may buy with credits during normal play. */
export const SPAWN_CARDS = ENEMIES.filter((e) => !e.isBoss);

/** Bosses are only ever placed by the teleporter event. */
export const BOSS_CARDS = ENEMIES.filter((e) => e.isBoss);

/**
 * Tier unlock thresholds on the difficulty coefficient.
 *
 * Tier 1 is the whole opening. Tier 2 arrives around the four-minute mark of a
 * solo run and is what turns "a horde" into "an encounter". Tier 3 is a single
 * card — the hulk — and it is deliberately late enough that meeting one is an
 * event. Tier 4 is boss-only and never affordable from the ambient bank.
 */
export const TIER_UNLOCK = { 1: 0, 2: 1.55, 3: 2.6, 4: Infinity };

/**
 * Elite affixes in unlock tiers, RoR2's Malachite/Celestine shape: the tier-1
 * set is available as soon as elites are, and the tier-2 set only exists once
 * the run has actually gone long. `unlock` is a difficulty coefficient, which
 * is the director's own clock (time + stages), so it gates on run *progress*
 * rather than on wall time alone.
 */
export const ELITE_TIERS = [
  { tier: 1, unlock: 0, affixes: ['blazing', 'overloading', 'glacial'] },
  { tier: 2, unlock: 3.2, affixes: ['withering', 'warded'] },
];

export const ELITE_AFFIXES = ELITE_TIERS.flatMap((t) => t.affixes);

/** Every affix legal at this difficulty. Never empty — tier 1 has unlock 0. */
export function eliteAffixesFor(difficulty) {
  const out = [];
  for (const t of ELITE_TIERS) if (difficulty >= t.unlock) out.push(...t.affixes);
  return out;
}

/**
 * RoR2 tier-1 elite multipliers, plus the affix-specific on-hit behaviour.
 *
 * Tier-2 affixes cost half again as much as tier-1 and are correspondingly
 * nastier, because they do not just deal more damage — they take one of the
 * player's answers away. Withering removes healing; Warded removes the ability
 * to trade damage with it from the front.
 */
export const ELITE_STATS = {
  blazing:     { health: 4.0, damage: 2.0, cost: 4.5, speed: 1.0,  burn: 0.35, auraRadius: 3.2, auraDps: 0.35 },
  overloading: { health: 3.2, damage: 2.0, cost: 5.0, speed: 1.15, shield: 0.5, deathBlast: 3.0, blastRadius: 7 },
  glacial:     { health: 4.0, damage: 2.0, cost: 4.5, speed: 0.92, slow: 0.5, slowTime: 2.0, novaRadius: 8, novaDamage: 1.5 },
  // Malachite's role: while one of these has line of sight on you inside
  // `denyRadius`, healing does nothing. Every source — regen, item procs,
  // shrine drops — is nullified, so the answer is to kill it or break contact.
  withering:   { health: 5.0, damage: 2.2, cost: 6.8, speed: 1.0, tier: 2, denyRadius: 16, denyTime: 3.0, thornDps: 0.2, auraRadius: 4.0 },
  // Celestine's role, inverted into an offensive problem: a reflective barrier
  // that must be broken before the unit takes real damage, and that pays a
  // quarter of everything you put into it straight back at you.
  warded:      { health: 3.4, damage: 2.2, cost: 7.2, speed: 0.95, tier: 2, shield: 1.1, reflect: 0.22, wardArmor: 0.55, novaRadius: 6, novaDamage: 1.2 },
};
