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
    name: 'Plated Scarab',
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
      // The scarab is the first thing anyone meets, so its tell is the longest
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
    name: 'Emberjaw Skink',
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
    name: 'Guttering Mote',
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
    name: 'Blind Shrike',
    tier: 1,
    cost: 16,
    baseHealth: 100,
    baseDamage: 16,
    // Cruise speed is a *readability* budget, not a threat budget. At 8.5 the
    // Shrike crossed its own 15m attack range in under two seconds while
    // jinking on `erratic: 1`, which put it inside the player's reaction window
    // before the target had finished being acquired — it read as unkillable
    // rather than as fast, and a suicide diver you cannot shoot down first is
    // just unavoidable damage. 5.8 keeps it clearly the quicker half of the
    // tier-1 flyers (the Mote cruises 4.2) while leaving roughly a second of
    // tracking time on the approach.
    moveSpeed: 5.8,
    turnRate: 4.2,
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
      // The dive keeps its bite — a longer `windup` is what buys the reaction,
      // not a weaker hit. The telegraph now runs 0.85s before the commit, and
      // the commit itself is slower, so the dive is a thing you dodge or shoot
      // out of the air rather than a thing that has already landed.
      {
        id: 'dive', kind: 'dive', range: 15, windup: 0.85, active: 1.1, recover: 0.2, cooldown: 3.0,
        damage: 1.9, blast: 4.6, diveSpeed: 17, suicide: true, color: 0xff3566,
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

  {
    id: 'shriver',
    maxAlive: 3,
    selectionWeight: 0.5,
    name: 'Gloomshriver',
    tier: 1,
    cost: 15,
    // Deliberately the least dangerous unit in the tier by raw output — 8 base
    // damage against the Shrike's 16 — because what it takes from the player is
    // not health. Every shot it lands is a slow, and a slowed player in a horde
    // is a player who cannot leave. The threat is what the *rest* of the field
    // does to you while it holds you still, which is why it is priced above the
    // Skink despite hitting for half as much.
    //
    // The Bile Spitling is the tier's other slow-applier at 9 credits, so the
    // 15 has to be paid for on axes the Spitling does not have, not merely
    // asserted. It is: two homing shells per attack against one lobbed arc (two
    // chances to land the slow, and they *steer*), a 24 m envelope against 20,
    // 6.4 m of hover that puts it outside every ground AoE and most melee, and —
    // the number that was wrong — more health than the Spitling rather than
    // less, because a flyer the player must stop and shoot down is the cost the
    // rest of the card is charging for. `maxAlive` 3 against 6 and `packMax` 2
    // against 4 keep the field share honest at that price.
    baseHealth: 130,
    baseDamage: 8,
    moveSpeed: 5.2,
    turnRate: 3.6,
    attackRange: 24,
    radius: 0.5,
    height: 1.2,
    hoverHeight: 6.4,
    mass: 0.5,
    xp: 2,
    isFlyer: true,
    eliteEligible: true,
    // Holds range hard, like the Spitling, but *high* — the one flyer that
    // parks above the fight rather than in it. A player who answers the pack by
    // backing off is walking further into its envelope, which is the whole
    // reason it works as a pressure unit rather than as another shooter.
    behavior: 'kiter',
    preferredRange: 18,
    packMin: 1,
    packMax: 2,
    meshFactory: 'shriver',
    attacks: [
      // A slow, fat, unmistakable orb. It is easy to sidestep on its own and
      // nearly impossible to sidestep while three mites are on your heels,
      // which is the interaction the card exists for. `burst: 2` means the
      // dodge has to be held rather than flicked.
      {
        id: 'knell', kind: 'projectile', range: 24, minRange: 5, windup: 0.8, active: 0.06, recover: 0.55,
        cooldown: 3.0, damage: 1.0, speed: 11, gravity: 0, homing: 1.2, radius: 0.45, blast: 2.0, life: 6,
        color: 0x6f8cff, muzzleY: 0, muzzleZ: 0.4, burst: 2, burstGap: 0.34, status: 'slow',
      },
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
    name: 'Basalt Sentinel',
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
        cooldown: 5.2, damage: 2.3, beamRadius: 0.9, color: 0x22d3ff,
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

  {
    id: 'lasher',
    maxAlive: 3,
    selectionWeight: 0.45,
    name: 'Bramble Lasher',
    tier: 2,
    cost: 29,
    baseHealth: 340,
    baseDamage: 21,
    moveSpeed: 4.6,
    turnRate: 2.6,
    attackRange: 26,
    radius: 0.7,
    height: 2.6,
    mass: 5,
    xp: 6,
    isFlyer: false,
    eliteEligible: true,
    behavior: 'ranged',
    preferredRange: 18,
    packMin: 1,
    packMax: 2,
    meshFactory: 'lasher',
    attacks: [
      // The unit that changes how a fight is *fought*.
      //
      // Every answer this game teaches for a horde is positional: kite, break
      // line of sight, hold a ledge, back off the melee and shoot. The Lasher
      // deletes all four for two seconds at a time, and it is the only ordinary
      // spawn card that can — `pull` was previously boss-only (the Maw's draw,
      // the Herald's collapse), which meant the "you cannot simply walk away"
      // lesson only ever appeared at the teleporter.
      //
      // The suction falls off with distance and never beats a player at full
      // sprint (see `Enemy.pullPlayer`), so it steals ground rather than taking
      // control. The counterplay is therefore real and threefold: sprint out of
      // the cone, break the reel by killing it, or *let it pull you* and spend
      // the free approach on whatever is standing next to it. That last one is
      // the reason its own melee is weak — the unit must not be able to punish
      // the player for accepting its offer.
      {
        id: 'reel', kind: 'pull', range: 26, minRange: 4, windup: 1.15, active: 1.5, recover: 1.0,
        cooldown: 8.0, damage: 0.45, pull: 19, blast: 6, color: 0xff6a7a, weight: 3,
      },
      // Thorn spray: the reason standing at mid range and ignoring it is not
      // free either. Low damage, wide, and it applies nothing — it exists so
      // the unit has an output while the reel is on cooldown.
      //
      // `volley` MUST be odd. `Enemy.launchProjectile` fans a volley as
      // `t = (i/(n-1) - 0.5) * 2`, which is symmetric about zero — an even count
      // straddles the aim line and puts *nothing* on it, so a stationary target
      // at `preferredRange` is never hit. With 5 the middle round flies true and
      // the other four are the spread. Every other non-boss volley in this file
      // is already odd (Acolyte 5, Herald 7) or compensates with `scatter`
      // (Matron); this one was the exception and it made the unit harmless.
      {
        id: 'thorns', kind: 'projectile', range: 22, minRange: 5, windup: 0.75, active: 0.2, recover: 0.6,
        cooldown: 4.5, damage: 0.55, speed: 22, gravity: 6, radius: 0.3, blast: 1.8, life: 3.5,
        color: 0xff6a7a, muzzleY: 2.0, muzzleZ: 0.8, volley: 5, volleySpread: 0.34, weight: 2,
      },
      { id: 'flail', kind: 'melee', range: 4.2, windup: 0.6, active: 0.14, recover: 0.5, cooldown: 2.4, damage: 0.9, arc: 1.2, lunge: 5, weight: 1 },
    ],
  },
  {
    id: 'redoubt',
    maxAlive: 2,
    selectionWeight: 0.35,
    name: 'Ferrite Redoubt',
    tier: 2,
    cost: 36,
    baseHealth: 620,
    baseDamage: 23,
    // Barely mobile, and — the load-bearing number — it *turns* at 0.6 rad/s,
    // the slowest on the roster. The Aegis Warden also has to be walked around,
    // but it is a melee unit that closes on you, so the flank is a moment. This
    // one holds ground and its whole fight is the player circling faster than it
    // can traverse: the counterplay is a skill (keep moving laterally, arrive
    // behind it) rather than a reaction (dodge the tell).
    //
    // `turnRate` and `preferredRange` are one number, not two, and they were
    // previously set so that the fight the card describes could not happen. A
    // player circling at radius r sweeps `sprintSpeed / r` rad/s, so out-turning
    // the unit requires r < 10.15 / turnRate. At the old 1.1 rad/s that meant
    // r < 9.2 m while the unit held 20 m — the exposed back was unreachable and
    // circling only ever made the beam miss. At 0.6 rad/s the ceiling is 16.9 m,
    // so the 13 m stand-off below sits inside it with room for a real circle
    // rather than a perfect one. The `backblast` nova (6 m) is the inner wall,
    // which leaves a 6-13 m band where the stated counterplay is the play.
    moveSpeed: 2.6,
    turnRate: 0.6,
    attackRange: 38,
    radius: 1.0,
    height: 2.9,
    mass: 9,
    xp: 8,
    isFlyer: false,
    eliteEligible: true,
    // Harder and wider than the Warden's shield (0.82 over 1.15 rad): the
    // Warden's front arc is a suggestion you can trade through if you have to,
    // and this one genuinely cannot be answered from the front. It is affordable
    // because the unit has no way to close the distance and punish you for
    // taking the long way round.
    frontArc: 1.3,
    frontArmor: 0.88,
    behavior: 'ranged',
    preferredRange: 13,
    packMin: 1,
    packMax: 1,
    meshFactory: 'redoubt',
    attacks: [
      // A long, slow beam whose aim is the body's own facing — `Enemy.fireBeam`
      // takes x/z straight from `yaw` and only corrects `dir.y`. That is the
      // shape the unit is for and it is why the traverse rate above is the whole
      // fight: a player who keeps circling arrives at the open back, and a
      // player who strafes in place is exactly where the beam is going.
      //
      // No `trackDuring` here. Nothing in `src/` reads that field — it named a
      // separate beam-tracking rate that does not exist, and leaving it in the
      // card documented a mechanic the engine has never had.
      {
        id: 'enfilade', kind: 'beam', range: 38, minRange: 0, windup: 1.7, active: 0.32, recover: 1.1,
        cooldown: 5.6, damage: 2.1, beamRadius: 0.85, color: 0xffd8a0, weight: 3,
      },
      // The answer to hugging it. Short, radial, and it does not care which way
      // the shield is pointing — so "walk around it" is the right answer and
      // "stand on top of it" is not.
      {
        id: 'backblast', kind: 'nova', range: 6, windup: 1.0, active: 0.2, recover: 0.8, cooldown: 7.5,
        damage: 1.5, blast: 9, waveSpeed: 24, color: 0xffd8a0, weight: 2,
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
    name: 'Basalt Colossus',
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

// ---------------------------------------------------------------------------
// SPECIAL — placed by name, never bought. `special: true` keeps these out of
// SPAWN_CARDS and out of the boss bag, so the director can neither afford them
// nor roll them: the only thing that puts one on the field is the realm or the
// finale that owns it.
// ---------------------------------------------------------------------------
ENEMIES.push(
  {
    id: 'anchor',
    name: 'Rift Anchor',
    tier: 3,
    special: true,
    cost: 0,
    baseHealth: 700,
    baseDamage: 22,
    moveSpeed: 0,
    turnRate: 1.0,
    attackRange: 26,
    radius: 1.2,
    height: 2.6,
    mass: 20,
    xp: 10,
    isFlyer: false,
    // Elite-eligible only so the finale can force `warded` on it: the affix
    // repaints the whole silhouette violet and hangs a barrier shell on it, so
    // an anchor reads as a piece of the Herald rather than as a brood sac that
    // wandered in. The director can never roll one — `special` keeps it out of
    // SPAWN_CARDS entirely.
    eliteEligible: true,
    behavior: 'stationary',
    packMin: 1,
    packMax: 1,
    meshFactory: 'brood',
    attacks: [
      // It exists to be shot, so it needs exactly enough teeth that standing on
      // top of one while you do it is a mistake — and no reach at all past that.
      {
        id: 'pulse', kind: 'nova', range: 9, windup: 1.3, active: 0.22, recover: 0.9,
        cooldown: 5.5, damage: 1.4, blast: 10, waveSpeed: 22, color: 0xd050ff,
      },
    ],
  },
  {
    id: 'warden_vault',
    name: 'Vault Warden',
    tier: 3,
    special: true,
    cost: 0,
    baseHealth: 2200,
    baseDamage: 30,
    moveSpeed: 5.0,
    turnRate: 2.6,
    attackRange: 34,
    radius: 1.1,
    height: 3.0,
    mass: 9,
    xp: 30,
    isFlyer: false,
    eliteEligible: true,
    // The vault's guard is a *single elite encounter*, so it is built like one:
    // a shielded front that has to be walked around, one committed dash that
    // punishes standing still, and a quake for anyone who answers by hugging it.
    frontArc: 1.05,
    frontArmor: 0.7,
    behavior: 'charger',
    preferredRange: 11,
    packMin: 1,
    packMax: 1,
    meshFactory: 'warden',
    attacks: [
      {
        id: 'lunge', kind: 'charge', range: 26, minRange: 5, windup: 0.9, active: 1.1, recover: 0.85,
        cooldown: 5.5, damage: 2.2, chargeSpeed: 30, hitRadius: 1.8, color: 0xffc850, knock: 11, weight: 3,
      },
      { id: 'bash', kind: 'melee', range: 3.6, windup: 0.6, active: 0.15, recover: 0.5, cooldown: 1.9, damage: 1.3, arc: 0.9, lunge: 8, weight: 2 },
      { id: 'quake', kind: 'nova', range: 8, windup: 0.95, active: 0.18, recover: 0.75, cooldown: 7.0, damage: 1.8, blast: 11, waveSpeed: 26, color: 0xffc850, weight: 2 },
    ],
  },
  {
    // ------------------------------------------------------------------------
    // THE HERALD OF THE RIFT — the run's last fight.
    //
    // Its attack table is not what makes it different from the other six; the
    // *arena* is. `data/realms.js:FINALE_PHASES` takes the floor away under it
    // twice, wards it behind three anchors for the whole of phase 2, and turns
    // healing off for phase 3 — so each break changes what the player is
    // allowed to do, not just what they are being hit with. Read this table
    // alongside that one.
    // ------------------------------------------------------------------------
    id: 'herald',
    name: 'Herald of the Rift',
    tier: 4,
    special: true,
    cost: 0,
    baseHealth: 5400,
    baseDamage: 38,
    moveSpeed: 5.4,
    turnRate: 2.1,
    attackRange: 60,
    radius: 2.7,
    height: 6.8,
    hoverHeight: 6.0,
    mass: 26,
    xp: 90,
    isFlyer: true,
    isBoss: true,
    // No affix: the fight has three rule changes of its own and an elite roll
    // on top of them would be a fourth nobody asked for.
    eliteEligible: false,
    behavior: 'ranged',
    preferredRange: 20,
    packMin: 1,
    packMax: 1,
    phaseAt: [0.70, 0.40],
    phase2At: 0.70,
    // Comes down to head height for the last phase, once there is barely any
    // floor left to stand on and the fight has to be close.
    descendAt: 3,
    meshFactory: 'herald',
    attacks: [
      {
        id: 'lance', kind: 'beam', range: 60, minRange: 0, windup: 1.6, active: 0.32, recover: 0.9,
        cooldown: 5.0, damage: 2.2, beamRadius: 1.0, color: 0xd050ff, weight: 3,
      },
      {
        // Arena denial: eight shells with ground rings, scattered wide. On the
        // full floor it is a nuisance; on the phase-3 disc it owns most of it.
        id: 'shardfall', kind: 'projectile', range: 58, minRange: 8, windup: 1.3, active: 0.4, recover: 0.8,
        cooldown: 6.5, damage: 1.0, speed: 24, gravity: 16, radius: 0.42, blast: 4.4, life: 6,
        color: 0xb060ff, muzzleY: 2.6, muzzleZ: 1.4, volley: 8, volleySpread: 0.6,
        telegraph: 4.4, scatter: 6.0, weight: 3,
      },
      {
        id: 'riftlings', kind: 'summon', range: 60, windup: 1.5, active: 0.3, recover: 0.8,
        cooldown: 13.0, damage: 0, summon: 'wisp', count: 3, spread: 6.0, color: 0xd050ff,
        phase: 2, weight: 3,
      },
      {
        // The phase-3 signature, and the reason the floor collapse is not just
        // scenery: it drags you toward the middle of an arena that is mostly
        // hole, so the counterplay is where you were standing before it started.
        id: 'collapse', kind: 'pull', range: 40, minRange: 0, windup: 1.2, active: 1.7, recover: 0.9,
        cooldown: 9.0, damage: 0.6, pull: 30, blast: 10, color: 0xff4ad0, phase: 3, weight: 5,
      },
      {
        id: 'unmake', kind: 'nova', range: 18, windup: 1.35, active: 0.25, recover: 0.9, cooldown: 8.0,
        damage: 2.4, blast: 19, waveSpeed: 30, color: 0xff4ad0, status: 'shock', phase: 3, weight: 4,
      },
    ],
  },
);

export const ENEMY_BY_ID = new Map(ENEMIES.map((e) => [e.id, e]));

// Snapshots carry a one-byte `typeId` instead of the string id — it is what a
// client resolves back into a mesh factory and a max-health scale. 0 is left
// free as "unknown", so the table is 1-based.
ENEMIES.forEach((e, i) => { e.typeId = i + 1; });

export const ENEMY_BY_TYPE = new Map(ENEMIES.map((e) => [e.typeId, e]));

/**
 * Everything the director may buy with credits during normal play.
 *
 * `special` cards are excluded as firmly as bosses are. They are placed by name
 * by whichever realm owns them, have no meaningful `cost`, and a director that
 * could roll a Rift Anchor onto an ordinary stage would be spawning a piece of
 * the finale's scenery into a field.
 */
export const SPAWN_CARDS = ENEMIES.filter((e) => !e.isBoss && !e.special);

/** Bosses are only ever placed by the teleporter event. */
export const BOSS_CARDS = ENEMIES.filter((e) => e.isBoss && !e.special);

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
