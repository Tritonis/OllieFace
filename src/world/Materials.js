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
