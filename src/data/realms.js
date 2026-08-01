// Hidden realms and the finale, as data.
//
// A run used to be an unbounded sequence of one stage shape. This table is the
// other half of the structure: three optional places that are *not* another
// combat stage, and one final place that ends the run. Everything the realm
// system needs to build an arena, dress its sky, gate its entrance and pay it
// out lives here, so adding a fourth realm is a table entry plus a controller
// branch rather than a new subsystem.
//
// Two rules the shapes below encode:
//
//  1. **A realm is entered by choice and costs something.** Gold, a health
//     gamble, or the risk of walking into a fight you cannot leave. A free
//     detour is not a decision.
//  2. **A realm returns you to where you were.** Only the hub and the finale
//     move the run forward; the trial and the vault put the player back on the
//     stage they left, because the stage still has a teleporter on it.
//
// Arena geometry is authored, not generated: `floorRadius` is the ground you
// can stand on and `wallRadius` is where the world stops. When they are equal
// the arena is walled and you cannot fall; when `wallRadius` is larger the gap
// between them is void, which is what lets the finale take the floor away.

/** Realms are built 4096 m out on +X, clear of any stage's 220 m basin. */
export const REALM_ORIGIN_X = 4096;

/** Below this the player is in the void and gets pushed back to the middle. */
export const VOID_Y = -60;
export const VOID_KILL_Y = -18;

const DEG = Math.PI / 180;

/**
 * Sky/light dressing for a realm.
 *
 * Shaped exactly like a `BIOMES` entry's atmosphere half (Environment.applyBiome
 * reads `sun`, `sky`, `fog`, `light`, `dust` and nothing else), so a realm can
 * be handed straight to the existing environment system. The terrain and prop
 * halves are absent on purpose — a realm builds its own geometry and never goes
 * through TerrainGen.
 */
function air({ zenith, horizon, haze, ground, sun, cloud, cloudAmount = 0.2, hazePow = 8,
               ceiling = 0x000000, ceilingAmount = 0, fogColor, fogDensity,
               sunEl, sunAz, sunColor, sunIntensity, hemiSky, hemiGround, hemiIntensity,
               rim, rimIntensity, envIntensity, dustColor, dustOpacity }) {
  return {
    sky: { zenith, horizon, haze, ground, sun, cloud, cloudAmount, hazePow, ceiling, ceilingAmount },
    fog: { color: fogColor, density: fogDensity },
    sun: { elevation: sunEl * DEG, azimuth: sunAz * DEG, color: sunColor, intensity: sunIntensity },
    light: { hemiSky, hemiGround, hemiIntensity, rim, rimIntensity, envIntensity },
    dust: { color: dustColor, opacity: dustOpacity },
  };
}

export const REALMS = [
  {
    id: 'bazaar',
    name: 'The Hollow Market',
    kind: 'hub',
    // No director, no credits, no clock pressure. The whole point of the room
    // is that it is the only place in the run where nothing is chasing you.
    combat: false,
    // Ends the stage: you came here through the teleporter's portal, so leaving
    // puts you on the next stage rather than back on the cleared one.
    exit: 'advance',
    floorRadius: 30,
    wallRadius: 30,
    objective: 'Spend what you have, then take the portal',
    toast: 'The Hollow Market',
    air: air({
      // A vaulted interior lit by its own lanterns: violet dark above, amber
      // pooled light below. The one place in the game with no sun in it.
      zenith: 0x160f26, horizon: 0x3a2338, haze: 0x6b3f44, ground: 0x0d0a14,
      sun: 0xffbe7a, cloud: 0x2a1f38, cloudAmount: 0.9, hazePow: 5.0,
      ceiling: 0x1a1224, ceilingAmount: 0.85,
      fogColor: 0x2a1c30, fogDensity: 0.016,
      sunEl: 8, sunAz: 210, sunColor: 0xffc98e, sunIntensity: 2.2,
      hemiSky: 0x5a3f78, hemiGround: 0x2a1a12, hemiIntensity: 0.85,
      rim: 0xff9a5a, rimIntensity: 1.9, envIntensity: 0.45,
      dustColor: 0xffd8a0, dustOpacity: 0.55,
    }),
  },

  {
    id: 'crucible',
    name: 'The Crucible',
    kind: 'trial',
    combat: true,
    exit: 'return',
    // Deliberately small. The trial's entire proposition is that there is
    // nowhere to kite to, so the arena is barely four times the player's
    // engagement range and the wall is right at the floor's edge.
    floorRadius: 25,
    wallRadius: 25,
    waves: 5,
    // Seconds of breathing room between waves; the last one gets none.
    waveBreak: 4.5,
    objective: 'Survive the trial',
    toast: 'The Crucible',
    air: air({
      zenith: 0x2a0f10, horizon: 0x8c3a16, haze: 0xd4661e, ground: 0x160808,
      sun: 0xffb060, cloud: 0x3a1810, cloudAmount: 0.95, hazePow: 6.0,
      ceiling: 0x200c0c, ceilingAmount: 0.7,
      fogColor: 0x4a1c14, fogDensity: 0.013,
      sunEl: 26, sunAz: 300, sunColor: 0xffa050, sunIntensity: 3.4,
      hemiSky: 0x7a3020, hemiGround: 0x3a1408, hemiIntensity: 0.7,
      rim: 0xff5a20, rimIntensity: 2.2, envIntensity: 0.5,
      dustColor: 0xffb070, dustOpacity: 0.7,
    }),
  },

  {
    id: 'vault',
    name: 'The Gilded Vault',
    kind: 'treasure',
    combat: true,
    exit: 'return',
    floorRadius: 27,
    wallRadius: 27,
    objective: 'Break the Vault Warden',
    toast: 'The Gilded Vault',
    air: air({
      zenith: 0x1a1608, horizon: 0xa8791e, haze: 0xffd07a, ground: 0x120e06,
      sun: 0xfff0c0, cloud: 0x2e2410, cloudAmount: 0.8, hazePow: 7.0,
      ceiling: 0x181206, ceilingAmount: 0.6,
      fogColor: 0x3a2e12, fogDensity: 0.011,
      sunEl: 34, sunAz: 60, sunColor: 0xffe4a8, sunIntensity: 3.8,
      hemiSky: 0x6a5420, hemiGround: 0x2a1e08, hemiIntensity: 0.75,
      rim: 0xffc850, rimIntensity: 1.6, envIntensity: 0.9,
      dustColor: 0xffe0a0, dustOpacity: 0.62,
    }),
  },

  {
    id: 'fracture',
    name: 'The Fracture',
    kind: 'finale',
    combat: true,
    // Neither: the run ends here one way or the other.
    exit: 'end',
    // Phase 1 floor. `FINALE_PHASES` takes it away from under you.
    floorRadius: 34,
    wallRadius: 62,
    objective: 'Destroy the Herald',
    toast: 'The Fracture',
    air: air({
      zenith: 0x0a0618, horizon: 0x3d1a5e, haze: 0x8a3fd0, ground: 0x060410,
      sun: 0xd9b0ff, cloud: 0x18102a, cloudAmount: 0.55, hazePow: 4.0,
      ceiling: 0x0c0820, ceilingAmount: 0.4,
      fogColor: 0x1a1030, fogDensity: 0.0075,
      sunEl: 12, sunAz: 145, sunColor: 0xc9a8ff, sunIntensity: 2.6,
      hemiSky: 0x4a2f8a, hemiGround: 0x140a24, hemiIntensity: 0.8,
      rim: 0xff4ad0, rimIntensity: 2.4, envIntensity: 0.55,
      dustColor: 0xd0a8ff, dustOpacity: 0.85,
    }),
  },
];

export const REALM_BY_ID = new Map(REALMS.map((r) => [r.id, r]));

/**
 * The gateways: what stands in a normal stage, what it costs, and when it may
 * appear at all.
 *
 * `chance` is rolled once per stage off `ctx.rng` on the host. `once` means one
 * per run — the hub and the vault are meant to be found, not farmed, and a
 * player who could open a market on every stage would never carry gold into a
 * fight again.
 */
export const GATEWAYS = [
  {
    realm: 'bazaar',
    id: 'altar',
    name: 'Newt Altar',
    // Armed rather than entered: pressing E here opens a second portal beside
    // the teleporter's when the stage is cleared. That gap between paying and
    // travelling is what makes it a decision made *early* in the stage.
    mode: 'arm',
    minStage: 1,
    chance: 0.42,
    once: true,
    // Scales with the stage so it stays a real purchase at minute twenty.
    cost: (stage) => Math.round(50 * Math.pow(1.3, stage)),
  },
  {
    realm: 'crucible',
    id: 'obelisk',
    name: 'Trial Obelisk',
    // Direct: no gold, no confirmation beyond the press. The price is the fight.
    mode: 'enter',
    minStage: 1,
    chance: 0.34,
    once: false,
    cost: () => 0,
  },
  {
    realm: 'vault',
    id: 'beacon',
    name: 'Gilded Beacon',
    mode: 'enter',
    minStage: 2,
    chance: 0.26,
    once: true,
    cost: (stage) => Math.round(120 * Math.pow(1.32, stage)),
  },
];

/**
 * The stage index from which the run may be finished.
 *
 * Five ordinary stages is roughly a twenty-minute run at the tuned curve, which
 * is where RoR2 puts its own celestial portal. Reaching it does not force the
 * ending: the loot window opens *two* portals, and taking the ordinary one
 * loops the run exactly as before with the difficulty ramp untouched.
 */
export const FINALE_STAGE = 5;

/**
 * The Herald's three phases.
 *
 * Each entry is what changes about the *arena and the rules* when the boss's
 * health crosses the matching gate in `herald.phaseAt` — the attack table
 * changes too, but that is what the other six bosses already do and is not what
 * makes this fight different.
 */
export const FINALE_PHASES = [
  {
    phase: 1,
    floorRadius: 34,
    // Ordinary rules: a big arena and a boss that walks it.
    anchors: 0,
    healDenied: false,
    note: 'full arena',
  },
  {
    phase: 2,
    // The rim falls away. Twelve metres of ground the player was using a moment
    // ago is now the drop, and the fight has half the room it started with.
    floorRadius: 22,
    // And the boss cannot be hurt at all until three anchors are down, so the
    // phase is a target-priority problem rather than a damage-race.
    anchors: 3,
    healDenied: false,
    note: 'rim collapses; boss warded until the anchors fall',
  },
  {
    phase: 3,
    // Down to a disc barely wider than a nova, with three satellite platforms
    // as the only other ground. Standing still is now a choice with a cost.
    floorRadius: 14,
    platforms: 3,
    platformRadius: 4.6,
    platformDist: 24,
    platformHeight: 3.2,
    anchors: 0,
    // No healing for the last stretch: every item that says "regen" stops
    // meaning anything and the fight has to be won on the ground you have.
    healDenied: true,
    note: 'floor reduced to a core plus three islands; healing suppressed',
  },
];

/** Run-ending ids. Both commit a record; only the cause differs. */
export const ENDINGS = {
  victory: {
    id: 'victory',
    won: true,
    title: 'The Herald Falls',
    line: 'You broke the thing at the end of the run.',
  },
  obliterated: {
    id: 'obliterated',
    won: true,
    title: 'Obliterated',
    line: 'You stepped into the obelisk and unmade yourself. The run ends on your terms.',
  },
  death: { id: 'death', won: false, title: 'Dead', line: '' },
};
