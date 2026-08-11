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
// Realm suns sit high (60-70 deg) rather than at the stages' raking 15-40.
// A walled room with a low sun is a room with a mirror streak across its floor
// and a sun disc sitting in the doorway, which is exactly what the first
// capture of all three of them showed. High is also what an interior wants:
// the key reads as a light in the ceiling and the arena's own emissives get to
// carry the colour.
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
    id: 'market',
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
      // **Safe is a light level, not a caption.**
      //
      // The first pass dressed this room amber-on-amber and it measured 52.5
      // mean luma against the Crucible's 52.4 — the hub and the kill-pit were
      // photometrically the same place, and the only thing saying "safe" was a
      // HUD string. Safety in a shooter reads as *high key, low contrast, cool
      // fill, warm pools*: a bright hall you can see the whole of, with nothing
      // in shadow that could be holding something.
      //
      // So: a pale limestone vault under a cool ivory-teal fill, roughly twice
      // the light level of anywhere else in the run, and the lanterns are the
      // only warm thing in it. Amber against cool reads as hearth; amber
      // against amber reads as fire.
      zenith: 0x2e4650, horizon: 0x55707a, haze: 0x7d989c, ground: 0x223036,
      sun: 0xdcecf0, cloud: 0x47606a, cloudAmount: 0.55, hazePow: 4.0,
      ceiling: 0x46606a, ceilingAmount: 0.92,
      fogColor: 0x3d545c, fogDensity: 0.011,
      sunEl: 74, sunAz: 210, sunColor: 0xe8f6fa, sunIntensity: 3.2,
      hemiSky: 0x86a8b6, hemiGround: 0x4a575c, hemiIntensity: 1.55,
      // The one warm channel, and it comes from behind: lantern bounce.
      rim: 0xffb070, rimIntensity: 1.2, envIntensity: 1.3,
      dustColor: 0xffd8a0, dustOpacity: 0.28,
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
      // **Cold iron with the fire underneath it.**
      //
      // The first pass lit the whole pit orange, which put it 8.6 dE from an
      // ordinary biome and 11 dE from the safe hub. The heat is now confined to
      // the floor seam and the braziers: everything the light *touches* is cold
      // blue-grey steel, so the only chroma in frame comes from below and the
      // room reads as a furnace you are standing on top of rather than one you
      // are inside. Half the hub's light level, and a third of its p90 — the
      // pit is the darkest walled room in the game.
      zenith: 0x070a10, horizon: 0x1b2634, haze: 0x2e4258, ground: 0x04060a,
      sun: 0xb8cee0, cloud: 0x121a26, cloudAmount: 0.9, hazePow: 6.0,
      ceiling: 0x0b1018, ceilingAmount: 0.88,
      fogColor: 0x101823, fogDensity: 0.022,
      sunEl: 74, sunAz: 300, sunColor: 0x9fbcd6, sunIntensity: 1.5,
      hemiSky: 0x2c3e52, hemiGround: 0x0d1016, hemiIntensity: 0.55,
      // The pit's own glow, bounced back up the walls. Kept low so it tints
      // rather than repaints.
      rim: 0xff5218, rimIntensity: 0.9, envIntensity: 0.30,
      dustColor: 0xff8a3a, dustOpacity: 0.34,
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
      // **Gold, and nothing else, on true black.**
      //
      // The first pass washed the whole room amber, so the gold had nothing to
      // read against and the frame sat 10.4 dE from an ordinary biome. The
      // walls now go to near-black and the ambient carries almost no light at
      // all: every lit thing in frame is either metal or the prize, and the
      // key is a single hard downlight over the dais. It is also pushed off
      // amber towards true yellow-gold (b* up, a* down), which is the axis the
      // base game's warm biomes do not own.
      zenith: 0x070604, horizon: 0x241a06, haze: 0x4e3806, ground: 0x030202,
      sun: 0xffeaa0, cloud: 0x141005, cloudAmount: 0.85, hazePow: 7.5,
      ceiling: 0x090704, ceilingAmount: 0.92,
      fogColor: 0x0e0b04, fogDensity: 0.019,
      sunEl: 70, sunAz: 60, sunColor: 0xffe08a, sunIntensity: 2.6,
      hemiSky: 0x3c3110, hemiGround: 0x090704, hemiIntensity: 0.30,
      rim: 0xffc63c, rimIntensity: 0.8, envIntensity: 1.7,
      dustColor: 0xffd257, dustOpacity: 0.44,
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
      // The rim came down hard (2.4 -> 1.0) and the key went up. At 2.4 the
      // magenta back light was winning the fresnel term on every rounded
      // surface in frame, which is why the Herald photographed as one flat pink
      // mass with no shading between shell, mantle and crown: it had no shadow
      // side left to have. A stronger raking key and a quieter rim gives the
      // boss a lit half and a dark half.
      // Azimuth moved 145 -> 35 as well. At 145 the sun sat in front of the
      // finale's own camera line and put a blown disc in the right third of
      // `25`; from 35 it rakes in over the camera's shoulder, which is where a
      // key belongs when the subject is a single object in a lot of sky.
      sunEl: 22, sunAz: 35, sunColor: 0xd8c0ff, sunIntensity: 4.2,
      hemiSky: 0x3f2878, hemiGround: 0x100818, hemiIntensity: 0.55,
      rim: 0xff4ad0, rimIntensity: 1.0, envIntensity: 0.55,
      dustColor: 0xd0a8ff, dustOpacity: 0.85,
    }),
  },

  {
    id: 'fracture-void',
    name: 'The Hungering Fracture',
    kind: 'finale',
    combat: true,
    exit: 'end',
    floorRadius: 34,
    wallRadius: 62,
    objective: 'Destroy the Herald',
    toast: 'The Hungering Fracture',
    // The void route's teeth and its pay. The Herald here is the same fight
    // with less forgiveness; the loot is the richest corrupted haul in the
    // game, paid on arrival — you already paid for it all run.
    bossScale: { health: 1.5, damage: 1.35 },
    voidLoot: 4,
    air: air({
      // The Fracture's palette dragged all the way into the blight ramp
      // (hud.css: #7a4fd0 -> #ff2fb0): denser dust, magenta haze, and the rim
      // light is the blight edge colour itself. Same sun geometry as the
      // clean finale — the room reads as the same place, further gone.
      zenith: 0x120420, horizon: 0x521a4e, haze: 0xc72fd6, ground: 0x0a0410,
      sun: 0xff9ae0, cloud: 0x241030, cloudAmount: 0.7, hazePow: 3.4,
      ceiling: 0x120826, ceilingAmount: 0.5,
      fogColor: 0x2a1038, fogDensity: 0.011,
      sunEl: 18, sunAz: 35, sunColor: 0xff70d8, sunIntensity: 4.6,
      hemiSky: 0x58286a, hemiGround: 0x140818, hemiIntensity: 0.6,
      rim: 0xff2fb0, rimIntensity: 1.4, envIntensity: 0.5,
      dustColor: 0xff8ae0, dustOpacity: 1.0,
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
    realm: 'market',
    id: 'altar',
    name: 'Tithe Altar',
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

/**
 * Corruption is the router (launch spec §2). At the finale-gate stage the
 * party's corruption band decides which Fracture opens: Pristine/Seeded see
 * the clean route, Overrun/Consumed see the void-saturated one, and Blighted
 * — the middle band — sees both and must commit. Every band matches at least
 * one route: corruption changes which game you are playing, never whether
 * you finish (tests/corruption-routing.test.mjs asserts the coverage).
 *
 * `name` is stamped from the realm's own name at module init rather than
 * authored twice: the portal prompt and the HUD's route line must never be
 * able to drift from the realm they name.
 */
export const FINALE_ROUTES = [
  {
    realm: 'fracture',
    label: 'Enter The Fracture — this ends the run',
    tint: 0xff4ad0,
    bands: { min: 0, max: 2 },
  },
  {
    realm: 'fracture-void',
    label: 'Enter The Hungering Fracture — this ends the run',
    tint: 0xc72fd6,
    bands: { min: 2, max: 4 },
  },
].map((r) => ({ ...r, name: REALM_BY_ID.get(r.realm).name }));

/** The routes a party at this corruption band may take. Never empty. */
export function routesFor(band) {
  return FINALE_ROUTES.filter((r) => band >= r.bands.min && band <= r.bands.max);
}

/** Run-ending ids. Both commit a record; only the cause differs. */
export const ENDINGS = {
  victory: {
    id: 'victory',
    won: true,
    title: 'The Herald Falls',
    line: 'You broke the thing at the end of the run.',
  },
  victoryVoid: {
    id: 'victory-void',
    won: true,
    title: 'The Herald Drowns',
    line: 'You fed the world to the void, and broke the thing it sent to thank you.',
  },
  obliterated: {
    id: 'obliterated',
    won: true,
    title: 'Unmade',
    line: 'You stepped into the obelisk and unmade yourself. The run ends on your terms.',
  },
  death: { id: 'death', won: false, title: 'Dead', line: '' },
};
