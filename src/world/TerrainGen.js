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
    h += this.ridged(this.nRidge, wx * P.ridgeFreq, wz * P.ridgeFreq, 3) * P.ridgeAmp; // spines
    h += this.fbm(this.nDetail, wx * P.detailFreq, wz * P.detailFreq, 3) * P.detailAmp;// grit

    const r = Math.hypot(x, z) / this.half;

    // Playable basin — the arena needs a readable floor, not more ridges.
    const basin = 1 - smoothstep(invLerp(0.04, P.basinRadius, r));
    h = lerp(h, h * P.basinFlatten + P.basinDrop, basin * P.basinStrength);

    // Terracing is masked so shelves appear in bands rather than everywhere,
    // and damped inside the basin — 3m risers in the arena floor would be a
    // navigation problem, not a silhouette.
    const tmask = clamp(this.fbm(this.nMask, wx * 0.011 + 90, wz * 0.011 - 40, 2) * 2.2 + P.terraceBias, 0, 1);
    h = lerp(h, terrace(h, P.terraceStep, P.terraceBlend), tmask * P.terraceStrength * (1 - basin * 0.8));

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

  build() {
    const N = this.segments;
    const half = this.half;
    const step = this.step;

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
    const emit = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      pos[pi++] = ax; pos[pi++] = ay; pos[pi++] = az;
      pos[pi++] = bx; pos[pi++] = by; pos[pi++] = bz;
      pos[pi++] = cx; pos[pi++] = cy; pos[pi++] = cz;

      // Flat per-face colour: the facet is the art, so it gets one flat value.
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      ny /= nl;
      const slope = 1 - Math.abs(ny);          // 0 flat, 1 vertical
      this._faceColor(my, slope, mx, mz, rgb);
      for (let k = 0; k < 3; k++) {
        col[ci++] = rgb[0]; col[ci++] = rgb[1]; col[ci++] = rgb[2];
      }
    };

    this._pal = { cRock, cCliff, cMoss, cSand, sandAmt: P.sandAmt, mossAmt: P.mossAmt };

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

  _faceColor(y, slope, x, z, out) {
    const { cRock, cCliff, cMoss, cSand, sandAmt, mossAmt } = this._pal;
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
    const mossT = clamp((1 - invLerp(0.30, 0.62, slope)) * invLerp(0.42, 0.66, yn) *
                  (1 - invLerp(1.90, 2.80, yn)) * patch * mossAmt, 0, 1);
    r = lerp(r, cMoss.r, mossT); g = lerp(g, cMoss.g, mossT); b = lerp(b, cMoss.b, mossT);

    // Anything steep is bare rock face — and `cliff` is now the cool violet,
    // so slope alone splits the terrain into a warm and a cool family.
    const cliffT = invLerp(0.40, 0.72, slope);
    r = lerp(r, cCliff.r, cliffT); g = lerp(g, cCliff.g, cliffT); b = lerp(b, cCliff.b, cliffT);

    // Per-facet value jitter — stops large flat shelves reading as dead colour.
    const j = 1 + (this.nTint(x * 0.6, z * 0.6)) * 0.075;
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
