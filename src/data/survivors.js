import { ABILITIES, SLOT_ORDER } from './abilities.js';

/**
 * The playable roster.
 *
 * A survivor card is pure data: stats, four ability ids, a mesh key and the
 * strings the UI shows. `Player` resolves the card at init and reads nothing
 * else — there is no per-survivor branch anywhere in the simulation, which is
 * the property that keeps adding the fifth one a data change.
 *
 * `baseStats` is the base block from CONTRACTS.md "Stat pipeline" and is the
 * *only* place a survivor's numbers live. It is handed to `ctx.items.stats()`
 * every step (after `Player` raises it by level), so every item in the game
 * stacks onto every survivor without knowing any of them exist.
 *
 * Balance shape of the four:
 *
 *   ranger   110 hp / 12 dmg / 7.0 m/s   the reference. Nothing is its worst.
 *   anvil   170 hp / 15 dmg / 6.5 m/s   +armour, melee range, no ranged answer
 *   kestrel   90 hp / 17 dmg / 7.4 m/s   glass; every button is a windup
 *   rook     135 hp / 11 dmg / 6.3 m/s   weakest personally, strongest in a
 *                                        prepared position
 *
 * `unlock` is `null` for anything available from the first run. Anything else
 * is a challenge id for `systems/Profile.js` (agent B1) to evaluate — the field
 * is declared here so the roster is complete the day that system lands, and
 * `isUnlocked()` below deliberately answers `true` for an unknown profile so a
 * missing Profile system can never lock the player out of their own game.
 */

export const SURVIVORS = [
  {
    id: 'ranger',
    name: 'RANGER',
    subtitle: 'Line Infantry',
    lore:
      'Dropped with a carbine, a coat and eleven days of rations. Nine of those days '
      + 'are gone. Nothing in the loadout is the best tool for anything on this planet, '
      + 'and all of it is good enough — which, so far, is the same thing.',
    meshKey: 'ranger',
    accentColor: 0xff7a3d,
    // The dash ribbon is the one colour that is deliberately *not* the accent:
    // the Ranger's roll has always been cold cyan against his warm kit, and
    // that contrast is what makes the i-frame window readable at a glance.
    trailColor: 0x8fd8ff,
    unlock: null,
    baseStats: {
      maxHealth: 110,
      healthRegen: 1.0,
      moveSpeed: 7,
      attackSpeed: 1,
      damage: 12,
      critChance: 0.01, // fraction, not percent — Items clamps this to 1
      critMult: 2,
      armor: 0,
      cooldownMult: 1,
      jumpCount: 1,
    },
    abilities: {
      primary: 'rangerDoubleTap',
      secondary: 'rangerPhaseRound',
      utility: 'rangerTacticalDive',
      special: 'rangerSalvo',
    },
  },

  {
    id: 'anvil',
    name: 'ANVIL',
    subtitle: 'Breach Crew',
    lore:
      'Ship-boarding hardware, worn by someone who was never issued it. The gauntlet '
      + 'weighs as much as the rest of the suit and is the reason the suit exists. '
      + 'There is no ranged option. There was never meant to be one.',
    meshKey: 'anvil',
    accentColor: 0xff5a2a,
    trailColor: 0xff8a3d,
    unlock: null,
    baseStats: {
      maxHealth: 170,
      healthRegen: 1.7,
      moveSpeed: 6.5,
      attackSpeed: 1,
      damage: 15,
      critChance: 0.01,
      critMult: 2,
      // The only survivor with base armour. 8 is ~7% off incoming damage at
      // the Combat curve — small, but it stacks with Bulwark's +25 into a real
      // window, which is the point of a defensive cooldown having a floor.
      armor: 8,
      cooldownMult: 1,
      jumpCount: 1,
    },
    abilities: {
      primary: 'anvilSweep',
      secondary: 'anvilSlam',
      utility: 'anvilBreach',
      special: 'anvilBulwark',
    },
  },

  {
    id: 'kestrel',
    name: 'KESTREL',
    subtitle: 'Long Watch',
    lore:
      'Orbital survey, forty months alone, trained to hold a target for six hours '
      + 'and take one shot. The training holds. The six hours do not — down here '
      + 'things close, and everything about the rifle is built for them not to.',
    meshKey: 'kestrel',
    accentColor: 0xc9a4ff,
    trailColor: 0xd6b4ff,
    unlock: null,
    baseStats: {
      maxHealth: 90,
      healthRegen: 0.9,
      moveSpeed: 7.4,
      attackSpeed: 1,
      damage: 17,
      // Five times the roster's base crit. Kestrel is the survivor crit items
      // are worth buying on, so the base has to be high enough that the first
      // one is felt.
      critChance: 0.05,
      critMult: 2,
      armor: 0,
      cooldownMult: 1,
      // Two jumps as standard: the only compensation for 90 health is never
      // being where the swing lands.
      jumpCount: 2,
    },
    abilities: {
      primary: 'kestrelMark',
      secondary: 'kestrelLance',
      utility: 'kestrelVault',
      special: 'kestrelEclipse',
    },
  },

  {
    id: 'rook',
    name: 'ROOK',
    subtitle: 'Field Engineer',
    lore:
      'Signed on to service the drop pods. Serviced them into a mine layer, a ward '
      + 'and two sentry guns inside a week. Holds ground better than anything else '
      + 'that walked off the ship, and cannot take any.',
    meshKey: 'rook',
    accentColor: 0x9dff5a,
    trailColor: 0xbfff7a,
    unlock: null,
    baseStats: {
      maxHealth: 135,
      healthRegen: 1.3,
      moveSpeed: 6.3,
      attackSpeed: 1,
      // Lowest personal damage on the roster on purpose: the turrets and the
      // ward scale off this number too, so Rook's damage stat is spent three
      // or four times over and cannot be priced like a survivor who spends it
      // once.
      damage: 11,
      critChance: 0.01,
      critMult: 2,
      armor: 4,
      cooldownMult: 1,
      jumpCount: 1,
    },
    abilities: {
      primary: 'rookRivet',
      secondary: 'rookMines',
      utility: 'rookWard',
      special: 'rookTurret',
    },
  },
];

/** The loadout a run boots with when nothing has chosen one. */
export const DEFAULT_SURVIVOR = 'ranger';

export const SURVIVOR_BY_ID = Object.create(null);
for (const s of SURVIVORS) SURVIVOR_BY_ID[s.id] = s;

/**
 * Resolve a survivor id to its card, falling back to the default.
 *
 * Never throws and never returns null: a bad id in a URL, a stale localStorage
 * profile or a UI that has not been wired yet must all still produce a playable
 * run. Silently booting the Ranger is a far better failure than a black screen.
 */
export function getSurvivor(id) {
  return SURVIVOR_BY_ID[id] || SURVIVOR_BY_ID[DEFAULT_SURVIVOR];
}

/**
 * The four ability *objects* for a survivor, in slot order.
 *
 * Fails loudly on a card that names an ability that does not exist — that is a
 * data typo, it is caught the moment the roster is touched, and a survivor with
 * a missing slot would otherwise crash deep inside the fixed step instead.
 */
export function loadoutOf(card) {
  return SLOT_ORDER.map((slot) => {
    const a = ABILITIES[card.abilities[slot]];
    if (!a) throw new Error(`survivor '${card.id}' names unknown ${slot} ability '${card.abilities[slot]}'`);
    return a;
  });
}

/**
 * Is this survivor available to play?
 *
 * `profile` is `ctx.profile` (agent B1's `systems/Profile.js`) when it exists.
 * Everything with `unlock: null` is always available, and an absent profile
 * unlocks everything rather than nothing.
 */
export function isUnlocked(card, profile) {
  if (!card?.id) return true;
  if (!profile?.isUnlocked) return true;
  // Ask about the survivor *id*, not the card's `unlock` field. Profile's model
  // is that content is unlocked by default and only becomes gated when some
  // challenge names it as a reward (see `UNLOCK_BINDINGS` in data/challenges.js),
  // so the id is the key and `unlock` is only documentation for the UI.
  return profile.isUnlocked('survivor', card.id);
}
