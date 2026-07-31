import * as THREE from 'three';

/**
 * Shared art direction + material library.
 *
 * Palette: "warm low sun, cold air". The colour script is built on a single
 * complementary axis — everything the sun touches is ochre/amber (hue 30-42°),
 * everything it doesn't is blue-violet (hue 200-280°). Distance is a *cooling*,
 * not a browning: the fog sits on the sky's blue, 180° from the terrain, so
 * near/mid/far separate by hue as well as by value.
 *
 * Value is deliberately spread wide so the three depth layers read even before
 * fog: sand 92% -> rock 71% -> moss 56% -> cliff 38%.
 *
 * Every world file imports PALETTE from here so the sky, the fog, the terrain
 * vertex colours and the props can never drift apart.
 *
 * Materials are module-level singletons. Props and terrain allocate thousands of
 * meshes between them; a per-mesh material would mean a per-mesh shader program
 * lookup and would blow the draw-call budget.
 */
export const PALETTE = {
  sky: {
    zenith: 0x2f7fb2,   // 203°  saturated, so the mix toward the horizon reads
    horizon: 0xf2a44f,  //  31°  as blue->amber and not as grey
    haze: 0xffd08a,     //  35°  hot band hugging the horizon line itself
    ground: 0x39344a,   // 254°  below the horizon goes cool, never brown
    sun: 0xffe0ad,
    cloud: 0xb9bed8,    // 231°  cloud bodies are cool; only their lit tops warm
  },
  // 214°, the sky's own blue, and deliberately *light* (V 78%). Aerial
  // perspective goes pale and cool, never dark: this is the value the far
  // massif resolves to, and it has to sit above the terrain's mid-tones so the
  // background separates upward while the foreground stays dark and warm.
  fog: 0x9fb0c6,
  terrain: {
    rock: 0xb58248,     //  32°
    cliff: 0x5a5060,    // 277°  vertical faces read as shadow-side by hue
    moss: 0x6f8f43,     //  85°
    sand: 0xead093,     //  42°
  },
  accent: {
    crystal: 0x39d6d2,
    crystalGlow: 0x1fa9b4,
    metal: 0x8d9199,    // cool metal so it catches the blue sky as specular
    wood: 0x33272f,
    wet: 0x43555f,
  },
  light: {
    key: 0xffd2a0,
    // The key is the only warm light. Everything filling the shadow side is
    // cool, so a shadow is a hue change and not just a darker version of the
    // lit colour — which is the whole point of the complementary split.
    hemiSky: 0x79aeeb,
    hemiGround: 0x6b4638, // a little warm bounce off the ground, kept dim
    rim: 0x9a86f0,
  },
};

// ---------------------------------------------------------------------------
// Tileable value noise. Period-wrapped so the generated textures repeat
// seamlessly — a visible tile seam is the fastest way to kill a stylized look.
// ---------------------------------------------------------------------------

function hash2(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2654435761)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(a, b) { return ((a % b) + b) % b; }

function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrap(xi, period), x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period), y1 = wrap(yi + 1, period);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

function fbm2(x, y, period, seed, octaves) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x * freq, y * freq, period * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const TEX_SIZE = 256;

function dataTexture(data, srgb) {
  const t = new THREE.DataTexture(data, TEX_SIZE, TEX_SIZE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * One noise field drives albedo mottling, roughness breakup and a derived
 * normal map, so the three channels always agree about where the crevices are.
 */
function makeTextureSet({ seed, period = 8, octaves = 5, normalStrength = 3.0,
                          rough = [0.58, 0.98], albedo = [0.66, 1.0], warpAmt = 0 }) {
  const N = TEX_SIZE;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let u = (x / N) * period, v = (y / N) * period;
      if (warpAmt > 0) {
        // Warping breaks the soap-bubble look plain fbm has at close range.
        const wu = fbm2(u, v, period, seed + 555, 3) - 0.5;
        const wv = fbm2(u + 3.7, v - 1.9, period, seed + 777, 3) - 0.5;
        u += wu * warpAmt; v += wv * warpAmt;
      }
      h[y * N + x] = fbm2(u, v, period, seed, octaves);
    }
  }

  const alb = new Uint8ClampedArray(N * N * 4);
  const rgh = new Uint8ClampedArray(N * N * 4);
  const nrm = new Uint8ClampedArray(N * N * 4);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x, o = i * 4;
      const n = h[i];

      const a = (albedo[0] + (albedo[1] - albedo[0]) * n) * 255;
      alb[o] = a; alb[o + 1] = a; alb[o + 2] = a; alb[o + 3] = 255;

      // Roughness inverted against albedo: crevices hold grit and read rougher.
      const r = (rough[1] - (rough[1] - rough[0]) * n) * 255;
      rgh[o] = r; rgh[o + 1] = r; rgh[o + 2] = r; rgh[o + 3] = 255;

      const l = h[y * N + wrap(x - 1, N)], rr = h[y * N + wrap(x + 1, N)];
      const d = h[wrap(y - 1, N) * N + x], up = h[wrap(y + 1, N) * N + x];
      let nx = (l - rr) * normalStrength;
      let ny = (d - up) * normalStrength;
      const len = Math.hypot(nx, ny, 1);
      nrm[o] = (nx / len * 0.5 + 0.5) * 255;
      nrm[o + 1] = (ny / len * 0.5 + 0.5) * 255;
      nrm[o + 2] = (1 / len * 0.5 + 0.5) * 255;
      nrm[o + 3] = 255;
    }
  }

  return {
    map: dataTexture(alb, true),
    roughnessMap: dataTexture(rgh, false),
    normalMap: dataTexture(nrm, false),
  };
}

// Textures are shared across materials, but repeat is per-material, so each
// consumer gets a clone (clones share the same GPU upload).
function withRepeat(set, repeat) {
  const out = {};
  for (const k of Object.keys(set)) {
    const t = set[k].clone();
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
    out[k] = t;
  }
  return out;
}

let _sets = null;
let _mats = null;

function buildSets() {
  return {
    // Coarse, warped, high-contrast — reads as weathered sedimentary stone.
    stone: makeTextureSet({ seed: 11, period: 8, octaves: 5, normalStrength: 3.4,
                            rough: [0.55, 0.99], albedo: [0.62, 1.0], warpAmt: 0.9 }),
    // Fine and busy — foliage clumping.
    organic: makeTextureSet({ seed: 29, period: 12, octaves: 5, normalStrength: 2.2,
                              rough: [0.7, 1.0], albedo: [0.55, 1.0], warpAmt: 0.4 }),
    // Smooth low-frequency dunes.
    grain: makeTextureSet({ seed: 47, period: 6, octaves: 4, normalStrength: 1.3,
                            rough: [0.85, 1.0], albedo: [0.82, 1.0] }),
    // Streaky corrosion for the ruin metal.
    metal: makeTextureSet({ seed: 63, period: 10, octaves: 5, normalStrength: 1.8,
                            rough: [0.28, 0.82], albedo: [0.5, 1.0], warpAmt: 1.6 }),
  };
}

function buildMaterials(sets) {
  const P = PALETTE;

  // repeat 26 across a 220u stage put one noise cycle below a pixel at vista
  // range, so every surface averaged out to flat matte. 11 keeps the cycle
  // several pixels wide in the midground where the form actually reads.
  const terrain = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.stone, 11),
    vertexColors: true,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.85, 0.85),
    dithering: true,
  });

  const rock = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.stone, 1.6),
    color: P.terrain.rock,
    roughness: 0.94,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.0, 1.0),
    flatShading: true,
  });

  const cliff = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.stone, 0.9),
    color: P.terrain.cliff,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.3, 1.3),
    flatShading: true,
  });

  const moss = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.organic, 2.4),
    color: P.terrain.moss,
    roughness: 0.98,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.8, 0.8),
    flatShading: true,
  });

  // Damp rock: low roughness so the key light throws a specular streak that
  // separates it from the matte terrain behind it.
  const wetStone = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.stone, 1.2),
    color: P.accent.wet,
    roughness: 0.28,
    metalness: 0.1,
    normalScale: new THREE.Vector2(1.1, 1.1),
    flatShading: true,
  });

  const metalRuin = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.metal, 1.1),
    color: P.accent.metal,
    roughness: 0.52,
    metalness: 0.85,
    normalScale: new THREE.Vector2(0.9, 0.9),
    flatShading: true,
  });

  const sand = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.grain, 3.2),
    color: P.terrain.sand,
    roughness: 0.99,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });

  const wood = new THREE.MeshStandardMaterial({
    ...withRepeat(sets.organic, 1.0),
    color: P.accent.wood,
    roughness: 0.95,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.2, 1.2),
    flatShading: true,
  });

  // Deliberately NOT using `transmission`: it forces a separate opaque
  // pre-pass per frame, which is far too expensive for instanced clusters.
  // Emissive + clearcoat + bloom sells the same read for free.
  const crystal = new THREE.MeshPhysicalMaterial({
    color: P.accent.crystal,
    emissive: P.accent.crystalGlow,
    emissiveIntensity: 1.9,
    roughness: 0.08,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.88,
    flatShading: true,
    depthWrite: true,
  });

  return { terrain, rock, cliff, moss, wetStone, metalRuin, sand, wood, crystal };
}

export function getMaterials() {
  if (!_mats) {
    _sets = buildSets();
    _mats = buildMaterials(_sets);
  }
  return _mats;
}

// ---------------------------------------------------------------------------
// Biomes
//
// A biome is a *retune* of the library above, never an addition to it. Every
// biome drives the same nine materials, the same sky shader and the same three
// lights; all it changes are uniforms — colours, fog density, sun angle, and
// the numbers TerrainGen and Props read. Nothing here can fork a shader
// program, which is the whole reason stage transitions are free.
//
// `terrain.shape` is the analytic heightfield's parameter block. `sandAmt` and
// `mossAmt` scale the two vertex-colour bands, which are computed against the
// basin's own measured height range so an amplitude change doesn't wash the
// colour script out.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

// The reference stage: identical to the pre-biome world, so stage 1 of a run
// still looks exactly like the art direction the palette above describes.
const SHAPE_DEFAULT = {
  warp: 34, warpFreq: 0.0072,
  baseFreq: 0.0068, baseAmp: 26,
  ridgeFreq: 0.019, ridgeAmp: 8,
  detailFreq: 0.075, detailAmp: 1.9,
  basinRadius: 0.5, basinFlatten: 0.28, basinDrop: -3.0, basinStrength: 0.82,
  terraceStep: 3.0, terraceBlend: 0.2, terraceStrength: 0.85, terraceBias: 0.45,
  wallStart: 0.82, wallBase: 46, wallVar: 22,
};

const PROPS_DEFAULT = {
  boulders: 260, boulderScale: [0.45, 2.4],
  pillars: 74, pillarHeight: [2.2, 7.5],
  arches: 16, archScale: [2.2, 4.6],
  trees: 110, treeScale: [0.8, 1.9],
  crystalClusters: 6, crystalPer: [6, 10], crystalScale: [0.8, 3.0],
  islands: 15, islandScale: [3.5, 9.5], islandLow: [6, 11], islandHigh: [16, 40],
  monolithHeight: 27, archHeroScale: 17,
};

export const BIOMES = [
  {
    id: 'ochre',
    names: ['Ochre Hollow', 'Cindergrass Flats', 'Emberfall Basin'],
    sky: { ...PALETTE.sky, cloudAmount: 0.74 },
    fog: { color: PALETTE.fog, density: 0.0036 },
    sun: { elevation: 18 * DEG, azimuth: 34 * DEG, color: PALETTE.light.key, intensity: 4.2 },
    light: {
      hemiSky: PALETTE.light.hemiSky, hemiGround: PALETTE.light.hemiGround, hemiIntensity: 0.50,
      rim: PALETTE.light.rim, rimIntensity: 1.45, envIntensity: 0.55,
    },
    dust: { color: 0xffe6b8, opacity: 0.55 },
    terrain: { ...PALETTE.terrain, sandAmt: 0.9, mossAmt: 1.0, shape: SHAPE_DEFAULT },
    mats: {
      rock: PALETTE.terrain.rock, cliff: PALETTE.terrain.cliff, moss: PALETTE.terrain.moss,
      sand: PALETTE.terrain.sand, wood: PALETTE.accent.wood, wetStone: PALETTE.accent.wet,
      metal: PALETTE.accent.metal, crystal: PALETTE.accent.crystal,
      crystalGlow: PALETTE.accent.crystalGlow,
    },
    props: PROPS_DEFAULT,
  },

  {
    // Wet, overcast, gently rolling. High sun and a dense pale mist collapse
    // the value range, so form has to come from silhouette — hence the tree
    // count and the melted terraces.
    id: 'verdant',
    names: ['Verdant Shelf', 'Mistbound Terraces', 'Greenspire Rise'],
    sky: {
      zenith: 0x5d87a0, horizon: 0xd8dcb0, haze: 0xeef0cf, ground: 0x2e3a33,
      sun: 0xf4f6dc, cloud: 0xc7d2cf, cloudAmount: 0.92,
    },
    // Fog at 0.0058 and a 46-deg sun flattened the whole stage to one olive
    // value: no modelling, no depth, and the green never read. Pulled back to
    // 0.0044, raked to 38 deg, and the cliff moved to a cool slate so the
    // warm/cool split the art direction depends on survives the overcast.
    fog: { color: 0xb8c9bd, density: 0.0044 },
    sun: { elevation: 38 * DEG, azimuth: 118 * DEG, color: 0xf6f4dc, intensity: 3.9 },
    light: {
      hemiSky: 0xa8c8d8, hemiGround: 0x50603a, hemiIntensity: 0.62,
      rim: 0x86c0a0, rimIntensity: 1.1, envIntensity: 0.68,
    },
    dust: { color: 0xd8f0d0, opacity: 0.34 },
    terrain: {
      rock: 0x84915f, cliff: 0x3f5158, moss: 0x568437, sand: 0xc4cb96,
      sandAmt: 0.45, mossAmt: 1.35,
      shape: {
        ...SHAPE_DEFAULT,
        warp: 46, warpFreq: 0.0060,
        baseAmp: 19, baseFreq: 0.0058,
        ridgeAmp: 4, ridgeFreq: 0.015,
        detailAmp: 2.4,
        basinRadius: 0.58, basinFlatten: 0.34, basinDrop: -2.2, basinStrength: 0.74,
        terraceStep: 2.2, terraceBlend: 0.55, terraceStrength: 0.55, terraceBias: 0.30,
        wallStart: 0.80, wallBase: 40, wallVar: 16,
      },
    },
    mats: {
      rock: 0x7e8b60, cliff: 0x3f5158, moss: 0x568437, sand: 0xc4cb96,
      wood: 0x2a3326, wetStone: 0x466055, metal: 0x8a9490,
      crystal: 0x8ef0b4, crystalGlow: 0x2fae72,
    },
    props: {
      ...PROPS_DEFAULT,
      boulders: 210, boulderScale: [0.4, 1.9],
      pillars: 34, pillarHeight: [1.8, 5.0],
      arches: 10,
      trees: 190, treeScale: [1.0, 2.6],
      crystalClusters: 3, crystalPer: [4, 7], crystalScale: [0.7, 2.2],
      islands: 11, islandScale: [4.0, 8.5], islandLow: [5, 9], islandHigh: [14, 30],
      monolithHeight: 21, archHeroScale: 14,
    },
  },

  {
    // Clear thin air, low magenta sun, hard shelves and real verticality. Fog
    // is deliberately the lightest of the four so the massif reads as distance
    // rather than as a wall, and the crystal accent is promoted to the motif.
    id: 'amethyst',
    names: ['Amethyst Waste', 'Glasswind Expanse', 'Pale Shatterfield'],
    sky: {
      zenith: 0x3a3070, horizon: 0xe07ab0, haze: 0xffc8e8, ground: 0x241c33,
      sun: 0xffd9f0, cloud: 0x9a8ec4, cloudAmount: 0.38,
    },
    // An 11-deg sun over a 0.42 hemisphere and 0.50 IBL put the entire stage in
    // its own shadow — the terrain rendered as near-black under a bright
    // magenta sky, which is unreadable rather than moody. The sun is up at
    // 24 deg, the fill is roughly doubled and the palette is a full value step
    // lighter; the low-key drama now comes from the hue, not from underexposure.
    fog: { color: 0xb9a8cf, density: 0.0032 },
    sun: { elevation: 24 * DEG, azimuth: -62 * DEG, color: 0xffd0e6, intensity: 4.4 },
    light: {
      hemiSky: 0x9f90e8, hemiGround: 0x6a4a70, hemiIntensity: 0.85,
      rim: 0x59e2ff, rimIntensity: 1.5, envIntensity: 0.85,
    },
    dust: { color: 0xf0c8ff, opacity: 0.62 },
    terrain: {
      rock: 0xb69ccc, cliff: 0x574370, moss: 0x9a7ac4, sand: 0xecd8f0,
      sandAmt: 0.8, mossAmt: 0.65,
      shape: {
        ...SHAPE_DEFAULT,
        warp: 22, warpFreq: 0.0085,
        // The verticality that makes this biome read belongs in the silhouette
        // — the terraces, the spires and the island field — not in the arena
        // floor. At baseAmp 33 / ridgeAmp 14 / terraceStep 4.2 only 40% of the
        // arena was walkable against the reference biome's 66%, and a 4.2m
        // riser is four times the capsule's step-up: the stage looked dramatic
        // and was unplayable. These numbers keep the hard shelf read while
        // landing the walkable fraction back alongside the reference.
        baseAmp: 27, baseFreq: 0.0074,
        ridgeAmp: 9, ridgeFreq: 0.024,
        detailAmp: 1.5,
        basinRadius: 0.54, basinFlatten: 0.26, basinDrop: -4.0, basinStrength: 0.90,
        terraceStep: 3.4, terraceBlend: 0.10, terraceStrength: 0.90, terraceBias: 0.62,
        // Verticality on this biome belongs *inside* the arena (baseAmp/ridge),
        // not in the bounding massif: at 56+26 the ridgeline reached y=105 and
        // ate the entire sky dome, which is the exact failure the reference
        // biome's wall was shortened to fix.
        wallStart: 0.84, wallBase: 38, wallVar: 16,
      },
    },
    mats: {
      rock: 0xa98fc0, cliff: 0x4e3d66, moss: 0x9a7ac4, sand: 0xecd8f0,
      wood: 0x2b2030, wetStone: 0x6a5885, metal: 0x9a90a8,
      crystal: 0xff6fd0, crystalGlow: 0xc02898,
    },
    props: {
      ...PROPS_DEFAULT,
      boulders: 230, boulderScale: [0.4, 2.0],
      pillars: 118, pillarHeight: [3.0, 10.5],
      arches: 20,
      trees: 26, treeScale: [0.7, 1.4],
      crystalClusters: 13, crystalPer: [7, 12], crystalScale: [0.9, 3.6],
      islands: 22, islandScale: [3.0, 8.0], islandLow: [7, 12], islandHigh: [20, 52],
      monolithHeight: 33, archHeroScale: 19,
    },
  },

  {
    // Low, silted and rusted. The flattest shape of the four, with the heaviest
    // haze and the dimmest key — the read comes from the metal ruin family and
    // the arches, which is why their counts go up as the verticality goes down.
    id: 'ferrous',
    names: ['Rustmire Sink', 'Ironsilt Reach', 'The Sunken Ferrous'],
    sky: {
      zenith: 0x27455c, horizon: 0xb06a4a, haze: 0xd99a6a, ground: 0x1e2226,
      sun: 0xffcfa0, cloud: 0x7d8894, cloudAmount: 0.88,
    },
    fog: { color: 0x8c9aa4, density: 0.0062 },
    sun: { elevation: 8 * DEG, azimuth: 152 * DEG, color: 0xffbf8c, intensity: 3.2 },
    light: {
      hemiSky: 0x5f7f9a, hemiGround: 0x3a2e28, hemiIntensity: 0.58,
      rim: 0x6fa8c8, rimIntensity: 1.2, envIntensity: 0.45,
    },
    dust: { color: 0xc8c0b0, opacity: 0.46 },
    terrain: {
      rock: 0x8a6a4c, cliff: 0x3f4348, moss: 0x59684a, sand: 0xa8a08c,
      sandAmt: 1.1, mossAmt: 0.55,
      shape: {
        ...SHAPE_DEFAULT,
        warp: 38, warpFreq: 0.0050,
        baseAmp: 15, baseFreq: 0.0090,
        ridgeAmp: 9, ridgeFreq: 0.0125,
        detailAmp: 1.1,
        basinRadius: 0.62, basinFlatten: 0.30, basinDrop: -5.0, basinStrength: 0.90,
        terraceStep: 1.6, terraceBlend: 0.34, terraceStrength: 0.62, terraceBias: 0.55,
        wallStart: 0.80, wallBase: 42, wallVar: 14,
      },
    },
    mats: {
      rock: 0x7d6550, cliff: 0x3e4349, moss: 0x59684a, sand: 0xa8a08c,
      wood: 0x2a2422, wetStone: 0x3d4c54, metal: 0xa8562e,
      crystal: 0x4fd8c0, crystalGlow: 0x1f9aa8,
    },
    props: {
      ...PROPS_DEFAULT,
      boulders: 285, boulderScale: [0.5, 2.6],
      pillars: 48, pillarHeight: [1.8, 4.8],
      arches: 30, archScale: [2.6, 5.6],
      trees: 62, treeScale: [0.7, 1.5],
      crystalClusters: 2, crystalPer: [4, 6], crystalScale: [0.7, 2.0],
      islands: 8, islandScale: [4.5, 10.0], islandLow: [5, 8], islandHigh: [12, 24],
      monolithHeight: 24, archHeroScale: 20,
    },
  },
];

/** The biome a given stage index lands on. Pure function of the index. */
export function biomeFor(stageIndex) {
  return BIOMES[((stageIndex % BIOMES.length) + BIOMES.length) % BIOMES.length];
}

/**
 * Human-readable name for a stage. Each biome carries several so the first
 * twelve stages of a run are all distinct places rather than four repeats.
 */
export function stageNameFor(stageIndex) {
  const b = biomeFor(stageIndex);
  const cycle = Math.floor(stageIndex / BIOMES.length);
  return b.names[cycle % b.names.length];
}

/**
 * Retint the shared material library for a biome.
 *
 * Only uniform-level properties are touched — colour and emissive. The maps,
 * the flags and the material *identity* are untouched, so no program is
 * invalidated and every biome renders through exactly the same shader set.
 */
export function applyBiomeMaterials(biome) {
  const M = getMaterials();
  const c = biome.mats;
  M.rock.color.set(c.rock);
  M.cliff.color.set(c.cliff);
  M.moss.color.set(c.moss);
  M.sand.color.set(c.sand);
  M.wood.color.set(c.wood);
  M.wetStone.color.set(c.wetStone);
  M.metalRuin.color.set(c.metal);
  M.crystal.color.set(c.crystal);
  M.crystal.emissive.set(c.crystalGlow);
  return M;
}

export function disposeMaterials() {
  if (!_mats) return;
  for (const m of Object.values(_mats)) {
    for (const k of ['map', 'roughnessMap', 'normalMap']) m[k]?.dispose();
    m.dispose();
  }
  for (const set of Object.values(_sets)) for (const t of Object.values(set)) t.dispose();
  _mats = null;
  _sets = null;
}
