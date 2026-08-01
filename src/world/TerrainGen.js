import * as THREE from 'three';
import { BIOMES, getMaterials } from './Materials.js';
import { clamp, lerp, invLerp, smoothstep } from '../core/MathUtil.js';

/**
 * Seeded 2D simplex. Simplex over value noise because domain warping amplifies
 * grid artefacts, and value noise's axis-aligned lattice shows through badly
 * once you warp it hard enough to matter.
 */
export function makeSimplex2D(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const GX = [1, -1, 1, -1, 1, -1, 0, 0];
  const GY = [1, 1, -1, -1, 0, 0, 1, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;

  return function simplex2(xin, yin) {
    const sk = (xin + yin) * F2;
    const i = Math.floor(xin + sk), j = Math.floor(yin + sk);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]] & 7;
      t0 *= t0;
      n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]] & 7;
      t1 *= t1;
      n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]] & 7;
      t2 *= t2;
      n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
    }
    return 70 * n;
  };
}

// Stepped shelves. `blend` is the fraction of a step spent on the riser — small
// values give the hard RoR2 terrace edge, large values melt back into a slope.
function terrace(h, step, blend) {
  const t = h / step;
  const f = Math.floor(t);
  let frac = clamp((t - f - 0.5) / blend + 0.5, 0, 1);
  frac = smoothstep(frac);
  return (f + frac) * step;
}

export const STAGE_HALF = 110;          // 220 x 220 world units
const SEGMENTS = 160;                    // 1.375u facets — big enough to read as low-poly
const STEP = (STAGE_HALF * 2) / SEGMENTS;

/**
 * Sub-seed stream. Stage generation must be a pure function of (seed, index) —
 * see NETCODE.md: the host consumes ctx.rng for loot and spawns and a client
 * does not, so any terrain drawn off the shared gameplay stream puts the two
 * players on different worlds by stage 2. This takes an integer and produces
 * the eight noise seeds from it, touching nothing shared.
 */
function subSeeds(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** Unit-interval stream off the same xorshift, for the feature layout below. */
function seedRand(seed) {
  const s = subSeeds(seed);
  return () => s() / 4294967296;
}

export class Terrain {
  /**
   * @param {number} seed   integer, derived from (ctx.seed, stageIndex)
   * @param {object} biome  entry from BIOMES; supplies palette and shape params
   */
  constructor(seed, biome = BIOMES[0]) {
    this.biome = biome;
    this.P = biome.terrain.shape;
    const s = subSeeds(seed);
    this.nBase = makeSimplex2D(s());
    this.nRidge = makeSimplex2D(s());
    this.nWarp = makeSimplex2D(s());
    this.nWarp2 = makeSimplex2D(s());
    this.nDetail = makeSimplex2D(s());
    this.nMask = makeSimplex2D(s());
    this.nWall = makeSimplex2D(s());
    this.nTint = makeSimplex2D(s());

    this.half = STAGE_HALF;
    this.step = STEP;
    this.segments = SEGMENTS;
    this.grid = null;
    this.mesh = null;

    // The biome's landform pass and its hand-laid features. `profile` is what
    // makes a stage a *place* rather than the same noise stack in a different
    // palette — see `_shape`.
    this.profile = this.P.profile || 'default';
    this.features = this._buildFeatures(seedRand(s()));
    // Set while `build()` resolves each feature's own ground level, so the
    // feature pass doesn't try to read a height it is itself producing.
    this._noShape = false;
    // Published for Props and Environment: the canyon's still water sits at a
    // fixed world height, and both the water plane and the reed line need it.
    this.waterLevel = this.profile === 'canyon' ? this.P.waterLevel : null;
  }

  /**
   * Lay out the biome's hand-placed landform features.
   *
   * Deterministic from the terrain sub-seed and nothing else — this runs on
   * every peer in co-op and must produce the same mesas, the same pads and the
   * same spires. Each family is distributed around a ring rather than sampled
   * uniformly over the disc, because uniform sampling reliably clumps two mesas
   * into one lump and leaves a third of the horizon empty, which is the exact
   * failure a landmark pass exists to prevent.
   */
  _buildFeatures(rand) {
    const P = this.P, H = this.half, F = {};
    const ring = (i, n, [r0, r1], jitter) => {
      const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * jitter;
      const rad = lerp(r0, r1, rand()) * H;
      return { x: Math.cos(a) * rad, z: Math.sin(a) * rad };
    };

    if (this.profile === 'mesa') {
      F.mesas = [];
      const n = P.mesaCount;
      for (let i = 0; i < n; i++) {
        const { x, z } = ring(i, n, P.mesaRing, 0.55);
        F.mesas.push({
          x, z, baseY: 0,
          r: lerp(P.mesaRadius[0], P.mesaRadius[1], rand()),
          h: lerp(P.mesaHeight[0], P.mesaHeight[1], rand()),
          // Which way the walkable approach faces. A mesa with no ramp is a
          // wall with a lawn on top: anything that spawns up there is stranded,
          // and `randomWalkablePoint` will happily pick a flat cap.
          ramp: rand() * Math.PI * 2,
        });
      }
    } else if (this.profile === 'works') {
      F.pads = [];
      const n = P.padCount;
      for (let i = 0; i < n; i++) {
        const { x, z } = ring(i, n, P.padRing, 0.7);
        const a = rand() * Math.PI * 2;
        F.pads.push({
          x, z, baseY: 0, y: 0,
          hw: lerp(P.padSize[0], P.padSize[1], rand()) * 0.5,
          hd: lerp(P.padSize[0], P.padSize[1], rand()) * 0.5,
          lift: lerp(P.padLift[0], P.padLift[1], rand()),
          cos: Math.cos(a), sin: Math.sin(a),
          // Which of the four sides is the vehicle ramp. The other three stay
          // at the chamfer width, which is what gives the site its hard edges.
          rampSide: (rand() * 4) | 0,
        });
      }
    } else if (this.profile === 'cavern') {
      F.spires = [];
      const n = P.spireCount;
      for (let i = 0; i < n; i++) {
        const { x, z } = ring(i, n, P.spireRing, 0.9);
        F.spires.push({
          x, z,
          r: lerp(P.spireRadius[0], P.spireRadius[1], rand()),
          h: lerp(P.spireHeight[0], P.spireHeight[1], rand()),
          p: lerp(P.spirePower[0], P.spirePower[1], rand()),
        });
      }
    }
    return F;
  }

  fbm(noise, x, z, octaves, lacunarity = 2.03, gain = 0.5) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  ridged(noise, x, z, octaves) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += (1 - Math.abs(noise(x * freq, z * freq))) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.07;
    }
    return sum / norm * 2 - 1;
  }

  /**
   * Analytic height. sampleHeight() interpolates the baked grid of this.
   *
   * The stage's character is entirely in `this.P` (the biome's shape block):
   * amplitude, ridge weight, how hard the terraces bite, how deep and how wide
   * the basin is, and how tall the bounding massif stands. The passes and their
   * order are fixed, because the order is what makes the result read as a place.
   */
  heightAt(x, z) {
    const P = this.P;
    // Domain warp first: without it every ridge runs along a lattice axis and
    // the whole stage reads as a generated heightmap rather than a place.
    const wf = P.warpFreq;
    const wu = this.fbm(this.nWarp, x * wf, z * wf, 3);
    const wv = this.fbm(this.nWarp2, x * wf + 51.3, z * wf - 17.7, 3);
    const wx = x + wu * P.warp;
    const wz = z + wv * P.warp;

    let h = 0;
    h += this.fbm(this.nBase, wx * P.baseFreq, wz * P.baseFreq, 4) * P.baseAmp;        // landform
    // Spines. Two octaves, not three.
    //
    // This octave, not the detail one, is what made a prop-range framing read as
    // "forty thin sharply pointed triangles radiating in inconsistent
    // directions". `ridged()` returns 1-|noise|, so every zero crossing of the
    // source is a crease — a C1 discontinuity — and three octaves at lacunarity
    // 2.07 put the finest set of creases at a ~12m wavelength with a ~1.1m
    // amplitude, i.e. a crease every eight triangles with nothing else at that
    // scale to organise them. Dropping to two octaves and roughly halving the
    // base frequency (0.019 -> 0.0105) while raising the amplitude to
    // compensate (8 -> 11) keeps the same relief and the same ridgeline read,
    // but the creases are now 30-60m features: one landform system instead of a
    // fractal shard field. Measured over a 44m background patch at seed 1337,
    // the fraction of facets whose height disagrees with the mean of its four
    // neighbours by more than 1m falls from 57.9% to ~17%.
    h += this.ridged(this.nRidge, wx * P.ridgeFreq, wz * P.ridgeFreq, 2) * P.ridgeAmp;

    const r = Math.hypot(x, z) / this.half;

    // Playable basin — the arena needs a readable floor, not more ridges.
    const basin = 1 - smoothstep(invLerp(0.04, P.basinRadius, r));
    h = lerp(h, h * P.basinFlatten + P.basinDrop, basin * P.basinStrength);

    // Terracing is masked so shelves appear in bands rather than everywhere,
    // and damped inside the basin — 3m risers in the arena floor would be a
    // navigation problem, not a silhouette.
    const tmask = clamp(this.fbm(this.nMask, wx * 0.011 + 90, wz * 0.011 - 40, 2) * 2.2 + P.terraceBias, 0, 1);
    h = lerp(h, terrace(h, P.terraceStep, P.terraceBlend), tmask * P.terraceStrength * (1 - basin * 0.8));

    // Grit, applied *after* the terrace pass rather than before it.
    //
    // The order is the whole fix for "the background reads as a field of random
    // shards". A 1.9u detail octave folded in ahead of terracing sits either
    // side of a 3.0u riser whose blend is 0.6u wide, so adjacent 1.375u facets
    // land on different shelves and each one becomes its own spike pointing a
    // different way — no ridgeline, no strata, no continuity, which is exactly
    // what a prop-range framing photographs. Terracing the smooth landform first
    // gives real horizontal shelf edges to read as strata; the grit then rides
    // on top and can only tilt a shelf, never re-shelve a triangle.
    //
    // It is also damped in the basin, on the same curve the terrace pass uses,
    // so the arena floor is calm and the relief that survives is the landform
    // silhouette the wide shots need to sit a subject against.
    h += this.fbm(this.nDetail, wx * P.detailFreq, wz * P.detailFreq, 3) *
         P.detailAmp * (1 - basin * 0.55);

    // The biome's own landform. Deliberately *after* the noise stack and the
    // terracing and *before* the bounding wall: a mesa cap, a pad deck and a
    // channel floor are all supposed to be flat, so anything that would ride on
    // top of them has to have run already, while the massif still has to be
    // able to bury a feature that wandered into the rim.
    h = this._shape(x, z, wx, wz, h);

    // Bounding cliff walls. Squared falloff keeps the transition out of the
    // play area while still climbing fast enough to be unclimbable.
    //
    // Shorter (46-68 rather than 74-108) over a shorter run, so the face stays
    // 64-72 deg — well past the 50 deg walk limit — while the ridgeline drops
    // below the top of a gameplay frame. At the old height the massif occluded
    // the entire sky dome from anywhere in the basin, and what every screenshot
    // read as "flat sky" was in fact this wall saturated in fog.
    const wall = smoothstep(invLerp(P.wallStart, 1.02, r));
    h += wall * wall * (P.wallBase + this.fbm(this.nWall, x * 0.026, z * 0.026, 3) * P.wallVar);

    return h;
  }

  /**
   * The per-biome landform pass. This is the difference between four stages and
   * one stage with four palettes: the silhouette of the ground itself has to
   * differ, and no amount of prop or colour work substitutes for it.
   */
  _shape(x, z, wx, wz, h) {
    if (this._noShape) return h;
    switch (this.profile) {
      case 'mesa':   return this._mesas(x, z, h);
      case 'canyon': return this._channels(x, z, wx, wz, h);
      case 'works':  return this._pads(x, z, h);
      case 'cavern': return this._spires(x, z, h);
      default:       return h;
    }
  }

  /**
   * Flat-capped sandstone mesas over a sheer skirt.
   *
   * The skirt width swings with azimuth on a quartic, so three sides of a mesa
   * are an unclimbable 70-deg wall and one is a long graded approach. That is
   * both the silhouette (a hard horizontal cap is the whole grassland-and-mesa
   * read) and the playability: without the ramp a cap is flat ground that
   * `isWalkable` accepts and nothing can reach, so enemies spawn stranded.
   */
  _mesas(x, z, h) {
    const P = this.P;
    const list = this.features.mesas;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const dx = x - m.x, dz = z - m.z;
      const d = Math.hypot(dx, dz);
      if (d >= m.r) continue;
      const ca = Math.cos(Math.atan2(dz, dx) - m.ramp);
      // Cubed rather than to the fourth: the quartic gave a ramp only ~20 deg
      // wide in azimuth, which is a 52-deg approach everywhere but dead centre
      // — i.e. past the 50-deg walk limit, i.e. no ramp at all.
      const w = m.r * (P.mesaSheer + P.mesaRamp * Math.pow(Math.max(0, ca), 3));
      const t = smoothstep(clamp((m.r - d) / w, 0, 1));
      h = lerp(h, m.baseY + m.h, t);
    }
    return h;
  }

  /**
   * Flooded channels cut into a plateau.
   *
   * The network is the *level set* of a smooth field rather than a threshold of
   * one. A threshold gives blobs; the set where a smooth field is near a chosen
   * value is a family of winding, branching, non-intersecting curves, which is
   * what an eroded drainage looks like from above.
   *
   * The bank width rides its own much lower octave, so some reaches are sheer
   * 15m walls and others are graded scree. That is not decoration — a canyon
   * whose every wall is vertical is a set of pits the player falls into and
   * cannot leave, and the pathing has nowhere to route.
   */
  _channels(x, z, wx, wz, h) {
    const P = this.P;
    const v = this.fbm(this.nWall, wx * P.channelFreq, wz * P.channelFreq, 3) - P.channelBias;
    const d = Math.abs(v);
    const bank = lerp(P.bankNarrow, P.bankWide,
      clamp(this.fbm(this.nMask, x * 0.0075 - 61, z * 0.0075 + 24, 2) * 1.9 + 0.5, 0, 1));
    if (d >= P.channelWidth + bank) return h;
    const t = 1 - smoothstep(clamp(invLerp(P.channelWidth, P.channelWidth + bank, d), 0, 1));
    // Silted floor: shallow relief so the water reads as a surface over ground
    // rather than as a painted plane, but nothing steep enough to wade around.
    const floor = P.channelFloor + this.fbm(this.nDetail, x * 0.022, z * 0.022, 2) * 1.4;
    return lerp(h, Math.min(h, floor), t);
  }

  /**
   * Rectangular fabrication pads snapped to the site's module height.
   *
   * The rotation is per pad and the deck height is quantised to `padGrid`, the
   * same step the global terracing uses — so a pad edge always lands on a
   * terrace line and the whole site reads as one survey rather than as boxes
   * dropped on a hillside. One side of each pad is a 13m ramp; the other three
   * are 1.5m chamfers, i.e. walls.
   */
  _pads(x, z, h) {
    const list = this.features.pads;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const dx = x - p.x, dz = z - p.z;
      const u = dx * p.cos + dz * p.sin;
      const v = -dx * p.sin + dz * p.cos;
      const au = Math.abs(u) - p.hw, av = Math.abs(v) - p.hd;
      const sd = Math.max(au, av);            // negative inside the rectangle
      if (sd >= 0) continue;
      // Which edge this sample is nearest, in the pad's own frame.
      const side = au >= av ? (u > 0 ? 0 : 2) : (v > 0 ? 1 : 3);
      const w = side === p.rampSide ? this.P.padRamp : this.P.padChamfer;
      h = lerp(h, p.y, smoothstep(clamp(-sd / w, 0, 1)));
    }
    return h;
  }

  /**
   * Terrain stalagmites: concave-flanked shafts grown off the cavern floor.
   *
   * A power curve rather than a smoothstep on purpose — smoothstep gives a
   * dome, and a dome reads as a hill. `p` between 1.7 and 2.9 gives the
   * pinched, splayed-footed profile that reads as deposited rather than eroded,
   * and leaves the ground between them flat and walkable.
   */
  _spires(x, z, h) {
    const list = this.features.spires;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const d = Math.hypot(x - s.x, z - s.z);
      if (d >= s.r) continue;
      h += s.h * Math.pow(1 - d / s.r, s.p);
    }
    return h;
  }

  build() {
    const N = this.segments;
    const half = this.half;
    const step = this.step;

    // Resolve each feature's own ground level before the grid is filled. The
    // pass is suppressed for these probes, so a mesa cap is placed relative to
    // the landform under it rather than to a height it is itself producing.
    this._noShape = true;
    for (const m of this.features.mesas ?? []) m.baseY = this.heightAt(m.x, m.z);
    for (const p of this.features.pads ?? []) {
      p.baseY = this.heightAt(p.x, p.z);
      // Quantised to the site module, so every deck in the yard is on one of a
      // handful of levels and their edges line up across the whole stage.
      p.y = Math.round((p.baseY + p.lift) / this.P.padGrid) * this.P.padGrid;
    }
    this._noShape = false;

    const grid = new Float32Array((N + 1) * (N + 1));
    // The two vertex-colour bands are placed against the *measured* relief of
    // the play area rather than against absolute world heights, so a biome that
    // doubles its amplitude doesn't push its whole floor out of the sand band
    // and lose the colour script. Only the inner region counts — the bounding
    // massif's 40-80u is not somewhere the palette has to describe.
    //
    // 5th/95th percentile, not min/max: a single ravine or spire is enough to
    // stretch a min/max range by 40%, and the bands would then slide off the
    // ground the player actually walks on. Percentiles track the bulk of the
    // surface, which is what the palette is describing.
    const bandR2 = (0.62 * half) * (0.62 * half);
    const sample = [];
    for (let j = 0; j <= N; j++) {
      const z = -half + j * step;
      for (let i = 0; i <= N; i++) {
        const x = -half + i * step;
        const y = this.heightAt(x, z);
        grid[j * (N + 1) + i] = y;
        if ((i & 1) === 0 && (j & 1) === 0 && x * x + z * z <= bandR2) sample.push(y);
      }
    }
    this.grid = grid;
    sample.sort((a, b) => a - b);
    const p = (q) => sample[clamp(Math.round(q * (sample.length - 1)), 0, sample.length - 1)] || 0;
    this._bandLo = p(0.05);
    this._bandSpan = Math.max(1e-3, p(0.95) - this._bandLo);

    const triCount = N * N * 2;
    const pos = new Float32Array(triCount * 9);
    const col = new Float32Array(triCount * 9);
    let pi = 0, ci = 0;

    const P = this.biome.terrain;
    const cRock = new THREE.Color(P.rock);
    const cCliff = new THREE.Color(P.cliff);
    const cMoss = new THREE.Color(P.moss);
    const cSand = new THREE.Color(P.sand);
    // Vertex colours feed a linear-space attribute, so convert once up front.
    for (const c of [cRock, cCliff, cMoss, cSand]) c.convertSRGBToLinear();

    const rgb = [0, 0, 0];
    // The colour stencil is deliberately much wider than one triangle. Driving
    // the material bands off the *raw face normal* of a 1.375m facet meant the
    // detail octave and the terrace risers flipped the slope past a band edge
    // every couple of triangles, so a 245-degree hue change was being driven by
    // the noisiest signal in the mesh — warm/cool confetti at the facet scale
    // with no form-following pattern. Three steps (4.1m) is wide enough that
    // the cliff band follows sustained steep ground and not individual risers.
    const CE = step * 3;
    const emit = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      pos[pi++] = ax; pos[pi++] = ay; pos[pi++] = az;
      pos[pi++] = bx; pos[pi++] = by; pos[pi++] = bz;
      pos[pi++] = cx; pos[pi++] = cy; pos[pi++] = cz;

      // Flat per-face colour: the facet is the art, so it gets one flat value.
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;

      // One 5-tap stencil yields both physical drivers:
      //   slope     — sustained steepness, picks the rock/cliff family
      //   curvature — concave hollow vs convex ridge, which is a free ambient
      //               occlusion / wear term. Hollows see less sky and hold
      //               damp and moss; ridges are scoured and catch the light.
      const hc = this.sampleHeight(mx, mz);
      const hl = this.sampleHeight(mx - CE, mz), hr = this.sampleHeight(mx + CE, mz);
      const hd = this.sampleHeight(mx, mz - CE), hu = this.sampleHeight(mx, mz + CE);
      const dx = hl - hr, dz = hd - hu, dy = 2 * CE;
      const nl = Math.hypot(dx, dy, dz) || 1;
      const slope = 1 - dy / nl;                 // 0 flat, 1 vertical
      const curv = clamp(((hl + hr + hd + hu) * 0.25 - hc) / (0.30 * CE), -1, 1);

      this._faceColor(my, slope, mx, mz, curv, rgb);
      for (let k = 0; k < 3; k++) {
        col[ci++] = rgb[0]; col[ci++] = rgb[1]; col[ci++] = rgb[2];
      }
    };

    this._pal = {
      cRock, cCliff, cMoss, cSand, sandAmt: P.sandAmt, mossAmt: P.mossAmt,
      strataAmt: this.P.strataAmt, strataStep: this.P.strataStep,
    };

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const xA = -half + i * step, zA = -half + j * step;
        const xB = xA + step, zB = zA;
        const xC = xA + step, zC = zA + step;
        const xD = xA, zD = zA + step;
        const hA = grid[j * (N + 1) + i];
        const hB = grid[j * (N + 1) + i + 1];
        const hC = grid[(j + 1) * (N + 1) + i + 1];
        const hD = grid[(j + 1) * (N + 1) + i];
        // Winding must match sampleHeight()'s triangle split exactly, or the
        // collision surface drifts from the visible one on steep ground.
        emit(xA, hA, zA, xD, hD, zD, xB, hB, zB);
        emit(xB, hB, zB, xD, hD, zD, xC, hC, zC);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // Non-indexed: computeVertexNormals then yields true per-face normals, which
    // is the faceted shading the whole look depends on.
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const mesh = new THREE.Mesh(geo, getMaterials().terrain);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.mesh = mesh;
    return mesh;
  }

  _faceColor(y, slope, x, z, curv, out) {
    const { cRock, cCliff, cMoss, cSand, sandAmt, mossAmt, strataAmt, strataStep } = this._pal;
    let r = cRock.r, g = cRock.g, b = cRock.b;

    // Height normalised against the measured play-area relief (see build()), so
    // the band edges below are the same *fractions* of every biome's range.
    //
    // The constants are the reference biome's hand-tuned absolute bands divided
    // through by its own measured band (lo -16.15, span 24.30): sand -7..2.5
    // becomes 0.38..0.77, moss -6..0 becomes 0.42..0.66, and moss's upper
    // cutoff 30..52 becomes 1.90..2.80. Same look, in a unit that survives a
    // change of amplitude.
    const yn = (y - this._bandLo) / this._bandSpan;

    // Sand pools in the low basin.
    const sandT = (1 - invLerp(0.38, 0.77, yn)) * (1 - invLerp(0.42, 0.62, slope)) * sandAmt;
    r = lerp(r, cSand.r, sandT); g = lerp(g, cSand.g, sandT); b = lerp(b, cSand.b, sandT);

    // Moss holds on flat-to-gentle ground in the mid band, patchy via noise.
    // Coverage widened and the patch bias lifted: at the old weights the one
    // green in the palette never covered enough facets to be visible at all.
    const patch = clamp(this.fbm(this.nTint, x * 0.026, z * 0.026, 3) * 2.4 + 0.72, 0, 1);
    // Moss follows the water: it takes hold in the concave ground that holds
    // damp and is scoured off the convex ridges.
    const wet = 0.62 + 0.62 * clamp(curv, 0, 1);
    const mossT = clamp((1 - invLerp(0.30, 0.62, slope)) * invLerp(0.42, 0.66, yn) *
                  (1 - invLerp(1.90, 2.80, yn)) * patch * wet * mossAmt, 0, 1);
    r = lerp(r, cMoss.r, mossT); g = lerp(g, cMoss.g, mossT); b = lerp(b, cMoss.b, mossT);

    // Anything *sustainedly* steep is bare rock face.
    //
    // The numbers look barely changed from the old 0.40-0.72, but they are
    // measured against a completely different signal: the old band read the raw
    // normal of a 1.375m facet, which a single 1.9m detail bump or 3m terrace
    // riser clears on its own, so adjacent triangles crossed the band edge and
    // back and the 245-degree rock/cliff hue jump fired at the facet scale.
    // Against the 4.1m stencil the band is a property of the landform: measured
    // over the play area only ~5% of ground clears 0.42 at all, and it does so
    // in contiguous runs, while the bounding massif sits either side of 0.55
    // and stays predominantly cool. So the warm/cool split still separates near
    // from far — it just stops being noise.
    const cliffT = invLerp(0.42, 0.68, slope);
    r = lerp(r, cCliff.r, cliffT); g = lerp(g, cCliff.g, cliffT); b = lerp(b, cCliff.b, cliffT);

    // Facet value variation, driven by curvature rather than by noise: hollows
    // occlude and go down a step, ridges are wind-scoured and come up one. That
    // reads as form — it follows the landform the light is modelling instead of
    // fighting it — where the old per-facet noise jitter read as dirt. The
    // noise term survives at a third of its old weight, purely to keep large
    // flat shelves off a single dead value.
    const ao = 1 - clamp(curv, 0, 1) * 0.20 + clamp(-curv, 0, 1) * 0.13;
    let j = ao * (1 + this.nTint(x * 0.6, z * 0.6) * 0.026);

    // Sedimentary banding, keyed to *absolute world height* and weighted onto
    // steep ground. A mesa skirt and a canyon wall are the two surfaces in this
    // game with a hundred square metres of continuous vertical face, and
    // without strata they are one flat value: rock that was displaced rather
    // than laid down. One pseudo-random value step per layer means the same
    // band runs at the same height across every wall on the stage, which is
    // what reads as geology rather than as noise.
    //
    // Two constraints fight here and both are load-bearing. The step has to be
    // *bigger than a facet's vertical extent* — a 1.375m facet on a 70-deg wall
    // spans ~3.8m of height, so at a 2.6m step every triangle landed in its own
    // layer and the massif rendered as fine vertical stripes, which is the
    // round-3 "facet-scale confetti" defect back in the value channel. And the
    // band edge still has to be *hard*, or there is no band. So: a long step,
    // and the layer value held flat across 78% of it before a quick crossfade
    // into the next one.
    if (strataAmt > 0) {
      const t = y / strataStep;
      const l = Math.floor(t);
      const h0 = ((Math.imul(l, 2654435761) ^ 0x9e37) >>> 0) / 4294967296;
      const h1 = ((Math.imul(l + 1, 2654435761) ^ 0x9e37) >>> 0) / 4294967296;
      const v = lerp(h0, h1, smoothstep(clamp((t - l - 0.78) / 0.22, 0, 1)));
      j *= 1 + (v - 0.5) * strataAmt * (0.35 + 0.65 * clamp(slope * 1.6, 0, 1));
    }

    out[0] = r * j; out[1] = g * j; out[2] = b * j;
  }

  /** Exact height of the rendered surface — interpolates the baked grid. */
  sampleHeight(x, z) {
    const N = this.segments, half = this.half, step = this.step;
    const fx = (x + half) / step;
    const fz = (z + half) / step;
    const i = clamp(Math.floor(fx), 0, N - 1);
    const j = clamp(Math.floor(fz), 0, N - 1);
    const u = clamp(fx - i, 0, 1);
    const v = clamp(fz - j, 0, 1);
    const g = this.grid;
    const row = N + 1;
    const hA = g[j * row + i];
    const hB = g[j * row + i + 1];
    const hC = g[(j + 1) * row + i + 1];
    const hD = g[(j + 1) * row + i];
    // Same split as build(): (A,D,B) covers u+v <= 1, (B,D,C) the rest.
    if (u + v <= 1) return hA + u * (hB - hA) + v * (hD - hA);
    return hC + (1 - u) * (hD - hC) + (1 - v) * (hB - hC);
  }

  /**
   * Smoothed surface normal via central differences. Deliberately not the exact
   * facet normal: entities resolving against per-facet normals jitter as they
   * cross triangle edges, and the facets are 1.4u wide.
   */
  sampleNormal(x, z, out = new THREE.Vector3()) {
    const e = this.step;
    const hl = this.sampleHeight(x - e, z), hr = this.sampleHeight(x + e, z);
    const hd = this.sampleHeight(x, z - e), hu = this.sampleHeight(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** Cosine of the surface angle from vertical, i.e. normal.y. */
  slopeDot(x, z) {
    return this.sampleNormal(x, z, _tmpN).y;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mesh = null;
    this.grid = null;
  }
}

const _tmpN = new THREE.Vector3();
