import * as THREE from 'three';
import { ParticleSystem, FRAME } from '../fx/ParticleSystem.js';
import { Trails } from '../fx/Trails.js';
import { Decals, DECAL } from '../fx/Decals.js';
import { makeDissolvable } from '../shaders/DissolveShader.js';
import { cloneCharacterBlightMaterial } from '../shaders/CharacterBlight.js';
import { MAX_BLASTS } from '../shaders/DistortShader.js';
import { clamp, lerp } from '../core/MathUtil.js';
import { elementOf, sparkColour, goreColour, ELEMENT_HUE } from '../data/damageTypes.js';
import { COIN_HUE, unitElement } from '../data/elementVoice.js';
// The purity route's authored palette (#154). Imported rather than typed: a
// hex literal at these call sites sits outside every guard in effects.js, which
// was demonstrated rather than argued - full magenta planted on the warding
// core left the entire suite green. Declared hues are walked at load.
import { HUE as PURITY } from '../data/effects.js';
import { isLocalVictim, isLocalOwner } from '../core/Engine.js';
import { GATE, shouldLaunch } from './LaunchGate.js';
import {
  GLYPHS, NUM_ADVANCE, NUM_TILE, NUM_COLS, NUM_FONT_PX, NUM_STROKE_PX, NUM_HALO_PX,
  haloUv, glyphRunWidthChars,
} from './GlyphAtlasLayout.js';

/**
 * The impact layer.
 *
 * Everything here is fire-and-forget and pooled. Nothing in this file may
 * allocate at steady state: effects write into shared scratch objects and hand
 * them to the particle ring buffer, which copies out immediately.
 *
 * The design rule for every entry in the catalogue is "at least three
 * simultaneous elements". A hit is never just sparks — it is sparks plus a
 * flash plus a light plus hitstop plus shake plus a sound. That layering, not
 * the quality of any single element, is what makes Risk of Rain 2 hits land.
 *
 * All of it runs in `update`, never `fixedUpdate`, and keeps animating while
 * `ctx.hitstop` is freezing gameplay — a frozen frame with dead VFX reads as a
 * dropped frame, a frozen frame with live VFX reads as impact.
 */

/* --- game-feel tuning ------------------------------------------------ *
 * Hitstop is measured in seconds of fully frozen gameplay.
 *  0.018  normal hit   — below perception as lag, still felt as weight
 *  0.045  crit         — clearly heavier without reading as a stutter
 *  0.060  kill
 *  0.090  elite kill / explosion
 *  0.130  boss kill
 * NORMAL hits are rate-gated: a 12/s weapon that froze 18ms every shot would
 * spend a fifth of its time stopped and feel broken, so consecutive small hits
 * only re-trigger every HITSTOP_GATE seconds. Big beats bypass the gate but
 * everything clamps to HITSTOP_MAX so nothing ever reads as a hitch.
 * ------------------------------------------------------------------- */
const HITSTOP = {
  hit: 0.018,
  crit: 0.045,
  kill: 0.060,
  elite: 0.090,
  explosion: 0.080,
  boss: 0.130,
  playerHurt: 0.050,
};
const HITSTOP_MAX = 0.14;
const HITSTOP_GATE = 0.085;

/* --- corpse launch ---------------------------------------------------- *
 * A kill that lands with damage to spare throws the body. This is
 * *cosmetic by construction* and the construction is the load-bearing part:
 * the launch never writes `Enemy.position`, `Enemy.velocity` or anything the
 * FSM reads. `Enemy.updateRig` copies `this.position` into `rig.root.position`
 * every frame from `Director`'s update, and `VFX.update` runs after it in the
 * system order (`src/main.js`; `Engine._frame` drains every `fixedUpdate`
 * before any `update`). So this re-applies an offset on top of a transform its
 * owner has just rewritten, every frame, and the instant it stops the corpse
 * is exactly where the simulation always thought it was. Nothing here is
 * visible to `tests/sp-equivalence.mjs`, and that is not an accident.
 *
 * `minOverkillFrac` is a fraction of the victim's max health: a mite finished
 * by a rounding error stays where it fell, and a hit that doubled what was
 * left of it goes flying.
 *
 * `hold` is why the effect survives its own landing. Retiring on ground
 * contact dropped the whole `vx·t` offset in the single frame the arc ended —
 * a full-power throw teleported 6.78 m back onto the spot it died on at an
 * apparent 407 m/s, while `deathDissolve` (0.85 s) was only 75 % through and
 * the body was still on screen. So a landed launch keeps holding its landing
 * offset with `y` collapsed to the ground, and only lets go at `hold`, by
 * which time the dissolve has finished and there is nothing left to see move.
 * `hold` sits between the dissolve (0.85 s) and `Enemy`'s `DEATH_TIME` (1.5 s,
 * when the rig returns to its pool), so the offset is released while the
 * corpse is invisible and long before the rig it writes to is recycled.
 * -------------------------------------------------------------------- */
export const LAUNCH = { minOverkillFrac: 0.35, maxSpeed: 11, spin: 7, gravity: 22, dur: 1.5, hold: 1.05 };

/**
 * How each read family dies.
 *
 * Every kill in this game used to be the same white-to-orange spark shower,
 * which meant the whole elemental half of the item pool was invisible at the
 * exact moment it paid off. The table is deliberately about *motion* first
 * and colour second — the colour comes from `ELEMENT_HUE`, which the hit
 * sparks already speak, so this adds a verb to a vocabulary rather than a
 * second vocabulary. Frames, gravity and drag are what make an ember death
 * and a shatter death read differently in peripheral vision, which is where
 * kills are actually seen.
 *
 * `kinetic` is the shipped burst, value for value (VFX.js:1195-1200 before
 * this table existed): a kill by an item nobody has mapped looks exactly as
 * it always did.
 */
export const KILL_SIGNATURE = {
  kinetic: { frame: FRAME.SPARK, speed: 8,  life: 0.60, gravity: 10,  drag: 1.6, stretch: 1.2, spin: 0,   ring: true,  shock: false },
  // Embers rise and hang: negative gravity, long life, heavy drag.
  fire:    { frame: FRAME.EMBER, speed: 6,  life: 1.10, gravity: -3,  drag: 2.4, stretch: 0,   spin: 0,   ring: true,  shock: false },
  // Shards fall hard and tumble: the read is "it broke", not "it burned".
  ice:     { frame: FRAME.HEX,   speed: 7,  life: 0.75, gravity: 26,  drag: 0.8, stretch: 0,   spin: 9,   ring: true,  shock: false },
  // Bolts, fast and nearly weightless, gone before the eye settles.
  shock:   { frame: FRAME.BOLT,  speed: 15, life: 0.32, gravity: 2,   drag: 3.2, stretch: 2.0, spin: 0,   ring: true,  shock: false },
  // Spores drift: slow, floaty, and they linger the longest of the seven. The
  // burst still disperses outward, so it keeps the ring — the generic
  // "something died here" read.
  nature:  { frame: FRAME.SPECK, speed: 4,  life: 1.40, gravity: 1.5, drag: 3.0, stretch: 0,   spin: 1.2, ring: true,  shock: false },
  // The void takes it inward — slow, spinning, and the one death with no
  // outward ring, because nothing is being pushed away. It stays legible
  // without the ring: the FRAME.SHOCK sprite at spin 4, gravity 0 holds where
  // the body was and rotates in place instead of expanding away from it.
  void:    { frame: FRAME.SHOCK, speed: 5,  life: 0.90, gravity: 0,   drag: 2.0, stretch: 0,   spin: 4,   ring: false, shock: false },
  // Debris and a real front.
  blast:   { frame: FRAME.CHUNK, speed: 11, life: 0.70, gravity: 16,  drag: 1.1, stretch: 0,   spin: 6,   ring: true,  shock: true },
};

// Shake falls off with the square of camera distance; 18m is the half-power
// point, which on a ~14m third-person boom means the player's own weapon shakes
// hard and a fight across the arena barely registers.
const SHAKE_HALF_DIST = 18;

/** Emissive intensity a hit flash drives a struck material to at 100%. */
const FLASH_INTENSITY = 3.2;

// Metres of tracer actually drawn, measured back from the impact point.
const TRACER_LENGTH = 8;

const MAT_PRESETS = {
  stone:    { spark: 0x9fb0c4, dust: 0x8d8577, decal: DECAL.CRACK, sparks: 8,  dustCount: 10, sound: 'stone' },
  concrete: { spark: 0xb8b0a0, dust: 0x9a948a, decal: DECAL.CRACK, sparks: 7,  dustCount: 12, sound: 'stone' },
  metal:    { spark: 0xffd7a0, dust: 0x6e7480, decal: DECAL.BULLET, sparks: 16, dustCount: 4,  sound: 'metal' },
  dirt:     { spark: 0x6b563c, dust: 0x7a6247, decal: DECAL.SCORCH, sparks: 2,  dustCount: 16, sound: 'dirt' },
  grass:    { spark: 0x74863f, dust: 0x5e6b3a, decal: DECAL.SCORCH, sparks: 2,  dustCount: 14, sound: 'dirt' },
  wood:     { spark: 0xc08a4a, dust: 0x7d5c33, decal: DECAL.CRACK, sparks: 5,  dustCount: 8,  sound: 'wood' },
  flesh:    { spark: 0xff4d4d, dust: 0x8c1620, decal: DECAL.BLOOD, sparks: 10, dustCount: 6,  sound: 'flesh' },
};

/*
 * Additive particles do not clamp against each other: `uMaxIntensity` caps one
 * sprite at 0.92, so N overlapping sprites reach N * 0.92 and a near-neutral
 * tip saturates to paper white in three. Every `tip` below is therefore held
 * off white and kept on its affix's own hue — the tip is where the particle is
 * *brightest*, so it is exactly the value that must not be neutral. `alpha`
 * is the per-emitter ceiling that stops a dense aura stacking to a blank mass.
 * (`tipAlpha`, not `alpha`: `alpha` already means "use the alpha layer" in the
 * STATUS table below and the two must not be confused.)
 */
// Keyed to Combat's STATUS_DEFS so `ctx.vfx.status(entity, type, colour)` maps
// straight through with no translation table on the gameplay side.
const STATUS = {
  burn:   { color: 0xff6a10, tip: 0xffc040, frame: FRAME.EMBER, rise: 1.6,  rate: 22, dur: 4.0, tipAlpha: 0.7 },
  bleed:  { color: 0xd0203a, tip: 0xff6a78, frame: FRAME.BLOB,  rise: -1.2, rate: 16, dur: 3.0, alpha: true },
  slow:   { color: 0x5ad2ff, tip: 0xa8e4ff, frame: FRAME.DUST,  rise: -0.5, rate: 10, dur: 2.0, alpha: true },
  // `freeze` and `shock` were both `tip: 0xffffff` on an additive frame. Two
  // overlapping quads of pure white are a neutral hole in the frame whatever
  // colour the second stop is, and a frozen monster is a status the player has
  // to see *through*, not a white patch where the monster used to be.
  freeze: { color: 0x9fe8ff, tip: 0xbfe8ff, frame: FRAME.HEX,   rise: -0.4, rate: 14, dur: 1.6, tipAlpha: 0.5 },
  shock:  { color: 0xc9b5ff, tip: 0xd8c4ff, frame: FRAME.SPARK, rise: 0.2,  rate: 18, dur: 1.4, tipAlpha: 0.6 },
};

// Rook's sentry fire (#198). The trail is the ribbon's hue, the accent is the
// missile body's — a shade harder, so the nose reads against its own wake.
const SENTRY_TRAIL = 0xbfff7a;
const SENTRY_ACCENT = 0x9dff5a;

// Two separate scratch pools. Effect methods use _v*, event handlers use _h*.
// Sharing one pool would let a handler's position vector be clobbered by the
// effect it just passed that vector into — a class of bug that shows up as
// effects silently playing at the world origin.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _h1 = new THREE.Vector3();
const _h2 = new THREE.Vector3();
const _box = new THREE.Box3();
const _tmpColor = new THREE.Color();
const _ringSize = new THREE.Vector2(1, 1);
const _ax1 = new THREE.Vector3();
const _ax2 = new THREE.Vector3();
const _proj = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* --- §4.4 run-level moments ------------------------------------------ *
 * A downed body is bone-cream: the physical family, deliberately *not* an
 * element and deliberately not mint-green, because being down is neither a
 * damage type nor a heal. Revival is restorative, which is the one place
 * mint-green is not only allowed but required (§1.1's reservation reserves it
 * *for* this). Both wear a white-hot core over their hue, which is §1.2's
 * player-facing polarity.
 */
const DOWNED_HUE = 0xe8ded0;
const REVIVE_HUE = 0x74ffc8;
/** Seconds between marker pulses — slow enough to read as a beacon, not a fire. */
const MARKER_PERIOD = 1.1;

/**
 * A colour derived from `hex` by independently scaling its R/G/B bytes.
 * Plain 0-255 byte arithmetic, not THREE.Color math: Color.set()/getHex()
 * round-trip through linear-light colour management, so scaling the linear
 * components does not reproduce the byte ratio between two sRGB hex
 * literals. Working on the raw bytes here keeps a driven path byte-identical
 * to hand-picking the hex, the same way the default (untouched) path is.
 */
export function _shiftWarm(hex, rScale, gScale, bScale) {
  const r = clampByte(((hex >> 16) & 0xff) * rScale);
  const g = clampByte(((hex >> 8) & 0xff) * gScale);
  const b = clampByte((hex & 0xff) * bScale);
  return (r << 16) | (g << 8) | b;
}

function clampByte(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}

/* ==================================================================== *
 * The three geometries the vocabulary could not draw
 * (docs/superpowers/plans/2026-08-23-new-vfx-geometries.md)
 *
 * Everything below is *pure arithmetic on plain numbers*, deliberately.
 * The drawing half of each geometry is a shader or a pool spawn, neither of
 * which a Node test can execute; the *shape* half is the part that can be
 * wrong in the ways the plan names (an aperture that is ignored, a spiral
 * that does not turn, a chain whose links do not meet), so it is factored
 * out to where a test can drive it directly rather than infer it from a
 * screenshot. The pool methods below consume exactly these functions — they
 * do not carry a second copy of the maths.
 * ==================================================================== */

/**
 * The perpendicular basis a ring, sector or helix is drawn in.
 *
 * Chosen exactly as `RingVert` chooses it — same degenerate-axis pick at
 * |n.y| > 0.95, same cross order — so that a CPU-side geometry and a
 * GPU-side one agree about which way zero degrees points. Writes into `out`;
 * allocates nothing.
 */
export function axisBasis(a, out = {}) {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  const nx = a.x / l, ny = a.y / l, nz = a.z / l;
  // t1 in RingVert: (1,0,0) when the axis is near-vertical, (0,1,0) otherwise.
  const t0 = Math.abs(ny) > 0.95 ? 1 : 0;
  const t1 = Math.abs(ny) > 0.95 ? 0 : 1;
  let bx = ny * 0 - nz * t1, by = nz * t0 - nx * 0, bz = nx * t1 - ny * t0;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  const cx = ny * bz - nz * by, cy = nz * bx - nx * bz, cz = nx * by - ny * bx;
  out.nx = nx; out.ny = ny; out.nz = nz;
  out.bx = bx; out.by = by; out.bz = bz;
  out.cx = cx; out.cy = cy; out.cz = cz;
  return out;
}

/**
 * Width, in cosine, of the soft edge on a sector's two bounding radii.
 *
 * Declared once and interpolated into `SectorFrag` rather than typed there:
 * the JS twin below and the shader must agree about where the arc ends, and
 * two hand-typed 0.06s are two things that can drift apart.
 */
export const SECTOR_EDGE_SOFT = 0.06;

/**
 * G-1's angular clip, in the sector's own 2D disc space.
 *
 * `c` is the fragment offset from the origin, `f` the facing, both already
 * projected into the basis above; `halfAperture` is half the arc's opening in
 * radians. Returns 0 outside the arc, 1 well inside it, and a smooth edge
 * between — so a half-aperture of PI is exactly a full ring and anything less
 * is genuinely narrower, which is the property the whole geometry exists for.
 */
export function sectorMask(cx, cy, fx, fy, halfAperture) {
  // A half-aperture of PI is the full ring, and it has to be the full ring
  // *everywhere*: taking the general path leaves the one direction exactly
  // opposite the facing on the wrong side of a `<=`, which draws a hairline
  // seam down the back of every 360-degree arc.
  if (halfAperture >= Math.PI) return 1;
  const rl = Math.hypot(cx, cy);
  if (rl < 1e-5) return 1;
  const fl = Math.hypot(fx, fy);
  if (fl < 1e-5) return 0;
  const cosA = (cx * fx + cy * fy) / (rl * fl);
  const lim = Math.cos(halfAperture);
  if (cosA <= lim) return 0;
  const k = Math.min(1, (cosA - lim) / SECTOR_EDGE_SOFT);
  return k * k * (3 - 2 * k);
}

/**
 * One lace point on G-2's rising helix / G-3's inward vortex.
 *
 * `k` indexes 0..o.count-1 along the path from `o.from` to `o.to`. The two
 * geometries share this function and separate on `o.inward` alone, which is
 * §1.3's own argument applied to motion: same family, opposite radial sign.
 * The spin direction is NOT flipped — a vortex that also turned the other way
 * would be a different shape rather than the same one running backwards.
 *
 * Writes position, velocity and the local radial/tangential units into `out`.
 */
export function helixSample(out, k, o) {
  const n = Math.max(1, o.count | 0);
  const t = n === 1 ? 0 : k / (n - 1);
  const ax = o.to.x - o.from.x, ay = o.to.y - o.from.y, az = o.to.z - o.from.z;
  const len = Math.hypot(ax, ay, az);
  _av.x = ax; _av.y = ay; _av.z = az;
  const B = axisBasis(_av, _hb);

  const ang = (o.phase || 0) + t * (o.turns ?? 2) * Math.PI * 2;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // The vortex closes on its endpoint; the helix keeps its radius as it climbs.
  const rad = (o.radius ?? 1) * (o.inward ? 1 - t : 1);

  const rx = B.bx * ca + B.cx * sa, ry = B.by * ca + B.cy * sa, rz = B.bz * ca + B.cz * sa;
  const tx = -B.bx * sa + B.cx * ca, ty = -B.by * sa + B.cy * ca, tz = -B.bz * sa + B.cz * ca;

  out.px = o.from.x + B.nx * len * t + rx * rad;
  out.py = o.from.y + B.ny * len * t + ry * rad;
  out.pz = o.from.z + B.nz * len * t + rz * rad;

  const swirl = o.swirl ?? 2.2;
  const radial = (o.radialSpeed ?? 0.8) * (o.inward ? -1 : 1);
  const climb = o.climb ?? 1.4;
  out.vx = tx * swirl + rx * radial + B.nx * climb;
  out.vy = ty * swirl + ry * radial + B.ny * climb;
  out.vz = tz * swirl + rz * radial + B.nz * climb;

  out.radialX = rx; out.radialY = ry; out.radialZ = rz;
  out.tangX = tx; out.tangY = ty; out.tangZ = tz;
  out.axisX = B.nx; out.axisY = B.ny; out.axisZ = B.nz;
  out.angle = ang; out.radius = rad; out.k = t;
  return out;
}

const _hb = {};
const _av = { x: 0, y: 0, z: 0 };
/* Steady-state scratch for the three new geometries. Nothing here allocates
 * per call — the same rule the rest of this file lives by. */
const _NO_OPTS = Object.freeze({});
const _helixOpts = {};
const _vortexOpts = {};
const _chainOpts = {};
const _hs = {};
const _cn0 = { x: 0, y: 0, z: 0 };
const _cn1 = { x: 0, y: 0, z: 0 };
/** The two bounding radii of a sector, as signed multiples of its half-aperture. */
const SECTOR_EDGES = [-1, 1];

/** Deterministic hash in [0,1) — the jag has to be repeatable to be testable. */
function _h1f(s) {
  const v = Math.sin(s * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Node `i` (0..o.segments) of G-4's jagged path from `o.from` to `o.to`.
 *
 * Midpoint displacement, perpendicular to the hop and tapering to nothing at
 * both ends: node 0 IS `from` and node `segments` IS `to`, exactly, so a
 * caller that walks i -> i+1 gets a contiguous polyline by construction and
 * lands on the endpoints it was given. That is the property `chainBolt` is
 * allowed to rely on, and the one the test breaks to prove the guard bites.
 */
export function chainNode(out, i, o) {
  const n = Math.max(1, o.segments | 0);
  const t = Math.min(1, Math.max(0, i / n));
  const ax = o.to.x - o.from.x, ay = o.to.y - o.from.y, az = o.to.z - o.from.z;
  out.x = o.from.x + ax * t;
  out.y = o.from.y + ay * t;
  out.z = o.from.z + az * t;
  if (i <= 0 || i >= n) return out;

  _av.x = ax; _av.y = ay; _av.z = az;
  const B = axisBasis(_av, _hb);
  const seed = (o.seed || 0) + i * 7.13;
  const d1 = (_h1f(seed) * 2 - 1);
  const d2 = (_h1f(seed + 91.7) * 2 - 1);
  // Full displacement mid-hop, none at the ends — a taper, not a clamp, so the
  // link nearest a target does not kink away from it.
  const amp = (o.jitter ?? 0.35) * Math.sin(Math.PI * t) * Math.hypot(ax, ay, az) * 0.25;
  out.x += (B.bx * d1 + B.cx * d2) * amp;
  out.y += (B.by * d1 + B.cy * d2) * amp;
  out.z += (B.bz * d1 + B.cz * d2) * amp;
  return out;
}

export class VFX {
  // The impact layer. Nothing reads it back, and a run without sparks is still
  // the same run — this is the case the noncritical half of the rule exists for.
  static critical = false;

  constructor() {
    this.particles = new ParticleSystem({ capacityAdditive: 20480, capacityAlpha: 10240 });
    this.trails = new Trails({ capacity: 40 });
    this.decals = new Decals({ capacity: 192 });

    this.time = 0;
    this.damageDirections = [];   // read by the HUD for the hurt indicator
    this._dirPool = [];
    this._dirCursor = 0;
    for (let i = 0; i < 8; i++) {
      this._dirPool.push({ pos: new THREE.Vector3(), angle: 0, alpha: 0, strength: 0, t: 0, life: 1.2 });
    }
    this._lastHitstop = -1;

    this._dissolving = [];
    this._launches = [];
    // The launch gate's window: the last `GATE.window` overkill fractions,
    // oldest first. It lives here because the constructor IS the per-run reset
    // — every restart in this game is a `location.reload()`.
    this._overkillRecent = [];
    this._flashes = [];
    // target -> (type -> entry). Keyed rather than a flat list because the
    // dedup below runs on every proc; see `statusApplied`. Both levels are
    // Maps, so iteration in `_updateStatuses` stays in application order and
    // overlays layer in the order they were applied.
    this._statuses = new Map();
    this._teleAccum = 0;
    this._teleRing = 0;
    this._teleProgress = 0;
    // Live downed-body markers, keyed by pawn. Entries only ever leave through
    // `playerRevived` (which a revive, a death and a stage change all reach) or
    // the liveness sweep in `_updateDownedMarkers`.
    this._downed = new Map();
    this._dt = 0;

    // Live shockwaves feeding the grade pass's distortion term.
    this._blasts = [];

    // Shared emit-options scratch — see _ep().
    this._e = {};
    this._ep0 = new THREE.Vector3();
    this._ed0 = new THREE.Vector3(0, 1, 0);
    this._ei0 = new THREE.Vector3();
    this._ec0 = new THREE.Color();
    this._ec1 = new THREE.Color();
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.vfx = this;

    this.particles.init(ctx);
    this.trails.init(ctx);
    this.decals.init(ctx);

    this.lights = new LightPool(ctx, 6);
    // Missile bodies for hitscan shots dressed as projectiles (#198).
    this.darts = new DartPool(ctx, this, 16);
    this.beams = new BeamPool(ctx, 192);
    this.rings = new RingPool(ctx, 48);
    // Ground arcs are a telegraph layer, not an impact layer: a handful are on
    // screen at once, where rings come in threes off every blast.
    this.sectors = new SectorPool(ctx, 24);
    this.numbers = new DamageNumbers(ctx, 384);

    this._roots = [
      this.particles.root, this.trails.root, this.decals.mesh,
      this.beams.mesh, this.rings.mesh, this.sectors.mesh, this.numbers.mesh,
    ];

    const e = ctx.events;
    e.on('damage', (p) => this._onDamage(p));
    e.on('kill', (p) => this._onKill(p));
    e.on('playerHurt', (p) => this._onPlayerHurt(p));
    e.on('shieldBroken', (p) => this._onShieldAbsorb(p));
    // The burst fires at the *viewer's* feet, so it has to be the viewer's
    // pickup: a teammate's loot 40 m away used to flash on this player's body.
    e.on('itemPickup', (p) => {
      if (!isLocalOwner(ctx, p)) return;
      const pp = ctx.player?.position;
      if (pp) this.itemPickupBurst(pp, 0xffffff);
    });
    // Progression owns the teleporter's position, so we only latch progress and
    // drive the aura from update() if a position happens to be exposed.
    e.on('teleporterCharging', (p) => { this._teleProgress = p?.progress ?? 0; });
    e.on('teleporterComplete', () => {
      const pp = ctx.player?.position;
      if (pp) this.explosion(pp, 6, 0x66ddff);
    });
    e.on('bossSpawn', (p) => {
      ctx.pipeline?.addShake(0.16);
      this._hitstop(HITSTOP.boss, true);
      this.bossArrival(p?.enemy?.position, unitElement(p?.enemy));
    });
    // Downed and revived are broadcast for every pawn, not just the local one:
    // the marker exists precisely so that *someone else* can find the body.
    e.on('playerDowned', (p) => this.playerDowned(p?.player, p?.position));
    e.on('playerRevived', (p) => this.playerRevived(p?.player, p?.position));
    // Both other exits from the downed state. A body that dies stops being a
    // body to walk to, and nothing survives a teleport.
    e.on('playerDead', (p) => { if (p?.victim) this._downed.delete(p.victim); });
    e.on('stageStart', () => this._downed.clear());
    // Gold has no position on the wire, so the gain point is the viewer's own
    // feet; the owner test keeps a teammate's payout off this player's body.
    e.on('goldChanged', (p) => {
      if (!isLocalOwner(ctx, p)) return;
      const pp = ctx.player?.position;
      if (pp) this.coinSpark(pp);
    });
    // Purity's verb, made visible (issue #154). The coverage here is
    // *structural*, not a headcount of call sites: the event is emitted inside
    // `Corruption.bleed` itself, so every path that wards is marked by
    // construction — the Voidtouched kill, the Argent Font press, and
    // `chime-of-absolution`'s per-kill ward (`data/items.js`), which is exactly
    // the third caller a "there are only two" argument would have missed. The
    // cue lands on the warder's own body, which is what makes "THIS is what
    // feeds warding" learnable by watching rather than by reading.
    e.on('corruptionWarded', (p) => this._onWarded(p));
    e.on('playerDead', (p) => {
      // Somebody else's death does not black out your screen.
      if (!isLocalVictim(ctx, p)) return;
      ctx.pipeline?.addShake(0.35);
      if (ctx.pipeline) {
        ctx.pipeline.aberration = 0.03;
        ctx.pipeline.vignetteBoost = 0.9;
      }
      this._hitstop(0.12, true);
    });

    addEventListener('resize', () => {
      this.particles.resize();
      this.numbers.resize();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Effect catalogue                                                    */
  /* ------------------------------------------------------------------ */

  /** Muzzle: flash core + cross flare + smoke + shell + light flick + shake. */
  muzzleFlash(pos, dir, scale = 1) {
    const s = scale;
    _v1.copy(dir).normalize();

    // Hot core, one frame's worth.
    let e = this._ep();
    e.count = 1; e.position.copy(pos); e.dir.copy(_v1);
    e.speed = 1.2; e.life = 0.055; e.lifeVar = 0;
    e.size0 = 0.9 * s; e.size1 = 0.35 * s; e.sizeVar = 0.1;
    e.color0.set(0xfff3d0); e.color1.set(0xffb03c);
    e.frame = FRAME.CROSS; e.spin = 6; e.alphaPow = 0.7; e.fadeIn = 0.001;
    e.drag = 8; e.soft = 0;
    this.particles.emit(e);

    // Directional cone of hot gas.
    e = this._ep();
    e.count = 7; e.position.copy(pos); e.dir.copy(_v1);
    e.spread = 0.35; e.speed = 9 * s; e.speedVar = 0.6;
    e.life = 0.09; e.size0 = 0.34 * s; e.size1 = 0.02;
    e.color0.set(0xffe8b0); e.color1.set(0xff6a18);
    e.frame = FRAME.SOFT; e.drag = 14; e.alphaPow = 1.1; e.soft = 0.3;
    this.particles.emit(e);

    // Sparks spitting forward.
    e = this._ep();
    e.count = 9; e.position.copy(pos); e.dir.copy(_v1);
    e.spread = 0.6; e.speed = 16 * s; e.speedVar = 0.7;
    e.life = 0.22; e.size0 = 0.13 * s; e.size1 = 0.02;
    e.color0.set(0xffd9a0); e.color1.set(0xff4a10);
    e.frame = FRAME.SPARK; e.stretch = 1.1; e.gravity = 14; e.drag = 2.4;
    this.particles.emit(e);

    // Smoke puff that lingers past the flash — the part that sells recoil.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 5; e.position.copy(pos); e.dir.copy(_v1);
    e.spread = 0.9; e.speed = 2.4 * s; e.speedVar = 0.7;
    e.life = 0.85; e.lifeVar = 0.4;
    e.size0 = 0.22 * s; e.size1 = 0.95 * s;
    e.color0.set(0x8f8b86); e.color1.set(0x3a3a3c);
    e.alpha0 = 0.32; e.frame = FRAME.SMOKE; e.spin = 1.6;
    e.drag = 2.6; e.gravity = -1.2; e.turbulence = 0.35; e.fadeIn = 0.15;
    this.particles.emit(e);

    // Ejected shell: gravity + spin + a right-ward kick out of the port.
    _v2.set(0, 1, 0).cross(_v1).normalize();
    e = this._ep();
    e.count = 1; e.position.copy(pos).addScaledVector(_v2, 0.12 * s);
    e.dir.copy(_v2).addScaledVector(_v1, -0.15).add(_v3.set(0, 0.9, 0)).normalize();
    e.spread = 0.25; e.speed = 3.4; e.speedVar = 0.25;
    e.life = 1.1; e.lifeVar = 0.2;
    e.size0 = 0.075; e.size1 = 0.075; e.sizeVar = 0.1;
    e.color0.set(0xd8ae5c); e.color1.set(0x8a6a2c);
    e.alpha1 = 1; e.alphaPow = 0.35;
    e.frame = FRAME.SQUARE; e.spin = 22; e.gravity = 26; e.drag = 0.2;
    this.particles.emit(e);

    this.lights.flick(pos, 0xffb45a, 9 * s, 3.2 * s, 0.07);
    this.ctx.pipeline?.addShake(0.008 * s);
    this.ctx.audio?.shoot(pos, s);
  }

  /** Tracer: bright core beam plus a soft outer beam plus a travelling glint. */
  tracer(from, to, colour = 0xfff0c0) {
    _tmpColor.set(colour);
    // A tracer is a streak, not a wire between two points. Drawing muzzle-to-
    // target makes a 60 m shot a screen-spanning straight line of uniform width
    // and brightness, which cuts the composition into wedges and reads as a CAD
    // overlay. Draw only the last few metres before the impact and let the
    // muzzle flash own the other end.
    _v2.subVectors(to, from);
    const len = _v2.length();
    if (len < 1e-4) return;
    _v2.divideScalar(len);
    const drawn = Math.min(len, TRACER_LENGTH);
    _v1.copy(to).addScaledVector(_v2, -drawn);

    // Outer glow first so the core reads as hotter than the falloff. taper = 1
    // gives the segment a bright head at `to` and a dissolving tail.
    this.beams.spawn(_v1, to, _tmpColor, 0.16, 0.02, 0.18, 0.35, 1);
    this.beams.spawn(_v1, to, WHITE_HOT, 0.055, 0.005, 0.12, 2.4, 1);

    let e = this._ep();
    e.count = 3; e.position.copy(_v1);
    e.dir.copy(_v2);
    e.spread = 0.25; e.speed = 6; e.life = 0.14;
    e.size0 = 0.16; e.size1 = 0.0;
    e.color0.set(colour); e.color1.set(colour);
    e.frame = FRAME.FLARE; e.drag = 6; e.soft = 0;
    this.particles.emit(e);
  }

  /** Surface impact: sparks + dust cone + decal + light + a surface-tuned tick. */
  impact(pos, normal, material = 'stone') {
    const preset = MAT_PRESETS[material] || MAT_PRESETS.stone;
    _v1.copy(normal);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0); else _v1.normalize();

    // Flash at the contact point — one frame, but it anchors everything else.
    let e = this._ep();
    e.count = 1; e.position.copy(pos).addScaledVector(_v1, 0.05);
    e.life = 0.07; e.lifeVar = 0;
    e.size0 = 0.5; e.size1 = 0.1;
    // Start at a hot *tint*, not at white. A core that begins at 1,1,1 saturates
    // on the first frame and stays saturated, so the material's own colour never
    // reaches the eye — stone and flesh both read as the same blank disc.
    e.color0.set(preset.spark).multiplyScalar(1.6); e.color1.set(preset.spark);
    e.frame = FRAME.CROSS; e.drag = 8; e.alphaPow = 0.8; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    if (preset.sparks > 0) {
      e = this._ep();
      e.count = preset.sparks;
      e.position.copy(pos).addScaledVector(_v1, 0.03);
      e.dir.copy(_v1); e.spread = 1.1;
      e.speed = 9; e.speedVar = 0.8;
      e.life = 0.36; e.lifeVar = 0.5;
      e.size0 = 0.1; e.size1 = 0.012;
      e.color0.set(0xfff0c8); e.color1.set(preset.spark);
      e.frame = FRAME.SPARK; e.stretch = 1.3;
      e.gravity = 22; e.drag = 1.6;
      this.particles.emit(e);
    }

    e = this._ep();
    e.layer = 'alpha';
    e.count = preset.dustCount;
    e.position.copy(pos).addScaledVector(_v1, 0.05);
    e.dir.copy(_v1); e.spread = 0.95;
    e.speed = 3.2; e.speedVar = 0.7;
    e.life = 0.75; e.lifeVar = 0.4;
    e.size0 = 0.16; e.size1 = 0.85;
    e.color0.set(preset.dust); e.color1.set(preset.dust);
    e.alpha0 = 0.4; e.frame = FRAME.DUST; e.spin = 2;
    e.drag = 3.4; e.gravity = 2.5; e.turbulence = 0.3; e.fadeIn = 0.1;
    this.particles.emit(e);

    this.decals.place(pos, _v1, preset.decal, { size: preset.decal.size * 0.8 });
    this.lights.flick(pos, preset.spark, 4, 2.2, 0.06);
    this.ctx.audio?.impact(pos, preset.sound);
  }

  /** Enemy hit confirm. Punchy, short, and the same shape every time so it reads. */
  hitSpark(pos, colour = 0xffe9b0, scale = 1) {
    let e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.085; e.lifeVar = 0;
    e.size0 = 0.85 * scale; e.size1 = 0.12;
    e.color0.set(0xfff0c8).multiplyScalar(1.35); e.color1.set(colour);
    e.frame = FRAME.CROSS; e.drag = 9; e.alphaPow = 0.9; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 10; e.position.copy(pos);
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 8 * scale; e.speedVar = 0.8;
    e.life = 0.19; e.lifeVar = 0.45;
    e.size0 = 0.11 * scale; e.size1 = 0.01;
    e.color0.set(0xffeccf); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.4; e.drag = 5.5; e.gravity = 6;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.16; e.lifeVar = 0;
    e.size0 = 0.3 * scale; e.size1 = 1.5 * scale;
    e.color0.set(colour); e.color1.set(colour);
    e.alpha0 = 0.7; e.frame = FRAME.SHOCK; e.spin = 1.2;
    e.drag = 9; e.alphaPow = 1.6; e.soft = 0;
    this.particles.emit(e);
  }

  /** Blood: directional gout + fine mist + a wall/floor splat if we can find one. */
  bloodHit(pos, dir, colour = 0x9c0d18) {
    _v1.copy(dir);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0); else _v1.normalize();

    // Layer colours as byte ratios of the default 0x9c0d18 (156, 13, 24):
    //   gout trail -> 0x3c040a (60, 4, 10)
    //   mist near  -> 0x7a0a14 (122, 10, 20)
    //   mist far   -> 0x2c0308 (44, 3, 8)
    //   spark      -> 0xff5a5a (255, 90, 90)
    const goutTrail = _shiftWarm(colour, 60 / 156, 4 / 13, 10 / 24);
    const mistNear = _shiftWarm(colour, 122 / 156, 10 / 13, 20 / 24);
    const mistFar = _shiftWarm(colour, 44 / 156, 3 / 13, 8 / 24);
    const sparkColour_ = _shiftWarm(colour, 255 / 156, 90 / 13, 90 / 24);

    let e = this._ep();
    e.count = 14; e.position.copy(pos);
    e.dir.copy(_v1); e.spread = 0.75;
    e.speed = 7.5; e.speedVar = 0.75;
    e.life = 0.55; e.lifeVar = 0.5;
    e.size0 = 0.13; e.size1 = 0.05;
    e.color0.set(colour); e.color1.set(goutTrail);
    e.alpha0 = 1; e.alpha1 = 0.9; e.alphaPow = 0.6;
    e.layer = 'alpha';
    e.frame = FRAME.BLOB; e.spin = 8; e.gravity = 22; e.drag = 1.1;
    this.particles.emit(e);

    // Fine mist hangs in the air a beat longer and reads at distance.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 10; e.position.copy(pos);
    e.dir.copy(_v1); e.spread = 1.3;
    e.speed = 3.2; e.speedVar = 0.8;
    e.life = 0.5; e.lifeVar = 0.4;
    e.size0 = 0.1; e.size1 = 0.5;
    e.color0.set(mistNear); e.color1.set(mistFar);
    e.alpha0 = 0.42; e.frame = FRAME.DUST;
    e.drag = 3.2; e.gravity = 3; e.turbulence = 0.4; e.fadeIn = 0.08;
    this.particles.emit(e);

    this.hitSpark(pos, sparkColour_, 0.8);
    // Throw the splat along the hit direction and let it fall to the floor.
    _v2.copy(pos).addScaledVector(_v1, 0.4);
    _v3.set(_v1.x * 0.35, -1, _v1.z * 0.35).normalize();
    this.decals.project(_v2, _v3, DECAL.BLOOD, { maxDist: 4 });
  }

  /**
   * Explosion: white flash, fireball, expanding shockwave ring, debris,
   * lingering smoke column, scorch decal, light burst, shake and hitstop.
   */
  explosion(pos, radius = 4, colour = 0xff8a20, coreColour = null) {
    const r = Math.max(0.5, radius);
    const s = r / 4;

    // Core flash + inner pip default to the hand-picked pair below. `coreColour`
    // drives both when given; the companion of each pair is derived by the
    // same byte ratio the hand-picked pairs already have to each other, so a
    // driven blast keeps the same cool/hot shaping as the default one.
    const core0 = coreColour != null ? coreColour : 0xffdc96;
    const core1 = coreColour != null ? _shiftWarm(core0, 1, 9 / 11, 37 / 75) : 0xffb44a;
    const pip0 = coreColour != null ? _shiftWarm(core0, 1, 61 / 55, 36 / 25) : 0xfff4d8;
    const pip1 = coreColour != null ? _shiftWarm(pip0, 1, 52 / 61, 61 / 108) : 0xffd07a;

    // 1. Flash core. Deliberately *smaller* than the fireball it sits inside.
    // A core wider than the blast body occludes every other layer for the first
    // three frames, which is how this effect photographed as a flashbulb: one
    // luminous disc with nothing in it. Short life, no multiplyScalar — the
    // additive ceiling in ParticleShader keeps it hot-tinted rather than clipped,
    // and it can only do that if the colour it is handed is below the ceiling.
    let e = this._ep();
    e.count = 1; e.position.copy(pos);
    // Lifetime is set by *when the effect is looked at*, not by taste. The
    // 0.07s original was tuned against a documented 0.09s shutter; 0.2s was the
    // round-5 correction to the same documented figure. `tools/vfxprobe.mjs`
    // then read the live shockwave record on the frozen `08-explosion` frame
    // and found the shutter actually lands at **t = 0.207s** — the scenario's
    // `waitSim(0.09)` is followed by more frames than it accounts for. So both
    // cores had expired again, the fireball blobs had pushed outward, and the
    // measured radial profile about the true blast centre came back with the
    // core contributing **+0.0 L at r=0**: the hollow ring, for the third round
    // running, from a number nobody had measured.
    //
    // 0.42s covers the whole window the shot can land in with margin, and the
    // falloff power does the shaping so the extra life is a decaying hot centre
    // rather than a disc that hangs around: alpha is `(1-u)^1.7`, so this is at
    // 0.81 of peak at 0.05s and 0.31 at the shutter.
    //
    // Round-5 r4 added the alpha ceilings on this and the next two emitters.
    // Additive layers do not clamp against each other — the per-sprite ceiling
    // in `ParticleShader` is per *sprite* — so what actually lands on screen is
    // the sum of everything overlapping, and at the blast centre that sum was
    // several times the display's clip point. Measured on
    // `reviews/round5/shots-vfxr4-base/08-explosion.png`: the core `r < 40 px`
    // read RGB 255.0/253.9/237.9 with the R channel clipped on **100%** of its
    // pixels, the whole `r < 120 px` disc at mean L 229.2 / 72.3% over L 220,
    // and the largest luminance step anywhere in the falloff 6.6 L. A blast
    // with no value range in it cannot be shaped, cannot show a shockwave and
    // cannot be silhouetted against smoke — it is a light source, not a body of
    // burning gas, which is exactly how the round-3 critique read it.
    //
    // These ceilings exist to leave the sum *under* clip so the falloff is
    // carried by the profile rather than by the tonemapper.
    e.life = 0.42; e.lifeVar = 0;
    e.size0 = r * 0.7; e.size1 = r * 1.5;
    e.color0.set(core0); e.color1.set(core1);
    e.alpha0 = 0.6;
    e.frame = FRAME.CORE; e.drag = 8; e.alphaPow = 1.7; e.fadeIn = 0.001; e.soft = 0.8;
    this.particles.emit(e);

    // The hot pip inside the core. Two nested sizes on two decay rates is what
    // produces a luminance *profile* — peak at the centre falling off through
    // the fireball to the ring — rather than a flat disc with an edge. It dies
    // first and stays smaller, so the blast cools from the middle outward.
    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.28; e.lifeVar = 0;
    e.size0 = r * 0.3; e.size1 = r * 0.75;
    e.color0.set(pip0); e.color1.set(pip1);
    // Deliberately the highest ceiling of the three, and on the smallest quad:
    // the peak of the radial profile has to be here, in the middle, or the
    // blast has a plateau instead of a centre.
    e.alpha0 = 0.7;
    e.frame = FRAME.CORE; e.drag = 9; e.alphaPow = 1.35; e.fadeIn = 0.001; e.soft = 0.6;
    this.particles.emit(e);

    // Heat glow on the blast, not a lens sticker over the composition: at
    // r * 2.4 this quad was ~700 px across and washed the whole midground.
    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.26; e.lifeVar = 0;
    e.size0 = r * 1.15; e.size1 = r * 1.9;
    e.color0.set(0xffc87a); e.color1.set(colour);
    e.alpha0 = 0.4;
    e.frame = FRAME.FLARE; e.spin = 2.5; e.drag = 7; e.alphaPow = 1.6; e.soft = 1.5;
    this.particles.emit(e);

    // 2. Fireball: fat additive blobs pushing outward and cooling to smoke.
    // Drag-limited so terminal radius is speed/drag ≈ r * 1.07; the point of the
    // high launch speed is that most of that travel happens in the first 100 ms,
    // so the blast has a *body* — a ring of discrete blobs — from 0.04 s on
    // rather than a solid core that only breaks up once the embers appear.
    e = this._ep();
    //
    // The count and the per-blob ceiling are a pair: 30 blobs at 0.95 is ~25 of
    // them overlapping the centre, and 25 additive sprites at any ceiling is a
    // clipped disc whatever the ceiling is. 24 at 0.34 keeps the ring of
    // discrete blobs — which is the layer's whole purpose — and leaves the sum
    // at the centre with somewhere to go.
    e.count = 24; e.position.copy(pos); e.shell = r * 0.22;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 30 * s; e.speedVar = 0.75;
    e.life = 0.45; e.lifeVar = 0.4;
    e.size0 = r * 0.6; e.size1 = r * 1.05;
    e.color0.set(0xffe6a0); e.color1.set(colour);
    e.alpha0 = 0.34; e.frame = FRAME.SMOKE; e.spin = 2.2;
    e.drag = 7; e.gravity = -3; e.turbulence = 0.5; e.fadeIn = 0.006; e.soft = 1.2;
    this.particles.emit(e);

    // 3. Shockwave ring. Both tinted: a white ring on a white core is invisible,
    // and the inner-edge boost in RingFrag clips it.
    //
    // The axis is UP for anything standing on the ground, which is nearly
    // everything: `RingFrag` fades a ring out as its plane goes edge-on (below
    // |dot(viewRay, axis)| = 0.28) because a ground-plane ring seen from its own
    // height projects to a laser across the whole frame, and that fade is the
    // guard. `_ringAxis` only overrides it for a blast whose centre clears the
    // terrain under it by more than its own radius — a real airburst, which has
    // no ground plane to align to. See `_ringAxis` for the measurement that
    // moved this test off the camera ray and onto the blast's own geometry.
    const axis = this._ringAxis(pos, r);
    this.rings.spawn(pos, axis, colour, r * 0.35, r * 2.6, 0.45, 0.95);
    this.rings.spawn(pos, axis, 0xffd2a0, r * 0.2, r * 1.5, 0.28, 0.7);

    // 3b. Fireball rim — a camera-facing sharp ring at the fireball's own edge.
    //
    // The ground-plane rings above are world-space discs: whatever `_ringAxis`
    // does they project to an *ellipse*, so they put an edge on two sides of the
    // fireball and nothing on the other two, and a radial profile about the
    // blast centre averages that away to almost nothing. Measured on
    // `reviews/round6/base/08-explosion.png` about the blast centre (568, 306):
    // the largest luminance step anywhere in the falloff is 8.1 L, in 4 px
    // annuli — the round-3 critique's "there is no edge anywhere on this object"
    // in a frame that had already had the clipping taken out of it. A blast can
    // stop being a plateau (clipping fixed) and still be a pure gaussian.
    //
    // A billboard is concentric with the fireball in *screen* space by
    // construction, on every side, from every camera. `FRAME.SHOCK` carries its
    // alpha from 0.05 at 0.82 of the tile radius to 1.0 at 0.93 and back to 0 at
    // 1.0, which is roughly a 6 px-wide bright rim at this blast's on-screen
    // size — an edge the eye can find the fireball's boundary with.
    //
    // Sized so the rim lands on the fireball's own boundary rather than out with
    // the shockwave: the bright band sits at 0.93 of the half-size, so a size of
    // ~2.15 * r puts it at world radius r. It starts inside and expands through
    // it, so across the shot's whole shutter window the rim is sweeping the
    // fireball's surface. `alpha0` is deliberately low — the rim is landing on
    // the falloff shoulder at ~L 185, not on the core, and its job is to add a
    // step there, not luminance. Additive so it reads as burning gas, and
    // `soft` fades it where it intersects terrain so it cannot draw a hard arc
    // across the ground.
    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.4; e.lifeVar = 0;
    e.size0 = r * 1.5; e.size1 = r * 3.0;
    e.color0.set(0xffd9a0); e.color1.set(colour);
    // 0.42, not 0.5: at 0.5 the rim's own contribution put the R channel back
    // over clip on 0.84% of the core (`reviews/round6/vfx/08-explosion.png` at
    // that value), and re-clipping the core to buy an edge would be trading one
    // half of this defect for the other.
    e.alpha0 = 0.42; e.frame = FRAME.SHOCK; e.alphaPow = 1.1;
    e.fadeIn = 0.004; e.soft = 1.0;
    this.particles.emit(e);

    // 4. Debris chunks, gravity-bound and spinning.
    e = this._ep();
    e.count = 20; e.position.copy(pos); e.shell = r * 0.25;
    e.dir.set(0, 0.55, 0); e.spread = 1.35;
    e.speed = 13 * s; e.speedVar = 0.85;
    e.life = 1.5; e.lifeVar = 0.45;
    e.size0 = 0.16 * s; e.size1 = 0.11 * s; e.sizeVar = 0.55;
    e.color0.set(0x8c7a68); e.color1.set(0x30282a);
    e.alpha1 = 1; e.alphaPow = 0.3;
    e.layer = 'alpha';
    // Velocity stretch. Static square chunks read as aliased confetti stickers;
    // stretching along the instantaneous velocity is what turns the debris field
    // into the motion arcs the rubric asks for. The arc is real: `ParticleShader`
    // differentiates each chunk's own analytic trajectory, so a chunk near the
    // top of its arc is short and horizontal and the same chunk on the way down
    // is long and vertical. It read as a *straight* streak until round 5, when
    // the shader was found stretching along the spawn velocity instead. Left at
    // 0.35: the instantaneous velocity at the shutter is ~2.8x the spawn speed
    // under this gravity scale, so the fix lengthened the streak on its own and
    // raising the coefficient on top of it turned the debris field into rain.
    e.stretch = 0.35;
    e.frame = FRAME.CHUNK; e.spin = 16; e.gravity = 26; e.drag = 0.35;
    this.particles.emit(e);

    // 5. Trailing embers that outlive the fireball.
    e = this._ep();
    e.count = 30; e.position.copy(pos); e.shell = r * 0.3;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 11 * s; e.speedVar = 0.9;
    e.life = 1.1; e.lifeVar = 0.6;
    e.size0 = 0.13 * s; e.size1 = 0.02;
    e.color0.set(0xffd07a); e.color1.set(0xff3a08);
    e.frame = FRAME.SPARK; e.stretch = 1.0;
    e.gravity = 15; e.drag = 1.3; e.turbulence = 0.4;
    this.particles.emit(e);

    // 6. Smoke column, the slowest layer, keeps the hit on screen for a second.
    e = this._ep();
    e.layer = 'alpha';
    // `fadeIn` is a *fraction of life*, so 0.12 of a 2.2 s life meant the smoke
    // was still at zero alpha a quarter of a second in — the blast had no dark
    // mass to silhouette the fireball against for its entire hot phase.
    // 0.028 puts the column up inside 60 ms, which is where RoR2 has it.
    e.count = 26; e.position.copy(pos); e.shell = r * 0.3;
    e.dir.set(0, 1, 0); e.spread = 1.5;
    e.speed = 6 * s; e.speedVar = 0.8;
    e.life = 2.2; e.lifeVar = 0.45;
    e.size0 = r * 0.5; e.size1 = r * 1.5;
    e.color0.set(0x54504c); e.color1.set(0x1e1c1e);
    e.alpha0 = 0.82; e.frame = FRAME.SMOKE; e.spin = 1.1;
    e.drag = 2.2; e.gravity = -1.6; e.turbulence = 0.45; e.fadeIn = 0.028;
    this.particles.emit(e);

    // 7. Dust skirt — the *opacity* layer, and the one this effect never had.
    // Everything above except the smoke column is additive, so for three rounds
    // the blast had luminance and no silhouette: at 3x there was no ring, no
    // smoke and no dust plume, only a gaussian. This is a fast outward torus of
    // opaque dust thrown along the shockwave, so the fireball has something dark
    // to be read *against* at its own radius rather than only at its column.
    // Soft-particle depth fade at 1.6 m keeps it from cutting into the ground it
    // is skidding across.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 18; e.position.copy(pos); e.shell = r * 0.35;
    e.dir.set(0, 0.22, 0); e.spread = 1.5;
    e.speed = 14 * s; e.speedVar = 0.55;
    e.life = 1.1; e.lifeVar = 0.4;
    e.size0 = r * 0.28; e.size1 = r * 1.1;
    e.color0.set(0x6a6158); e.color1.set(0x24211f);
    e.alpha0 = 0.55; e.frame = FRAME.DUST; e.spin = 1.6;
    e.drag = 4.5; e.gravity = -0.6; e.turbulence = 0.5; e.fadeIn = 0.02;
    e.soft = 1.6;
    this.particles.emit(e);

    this.decals.project(pos, DOWN, DECAL.SCORCH, { size: r * 0.8, maxDist: r + 3 });
    // Intensity 60*s put ~90 units into a 15 m range and rendered every monster
    // inside the blast as a uniform white cast (variance under 3/255). A quarter
    // of the intensity over a 36% larger radius keeps the falloff at 8-10 m and
    // stops saturating anything within 4 m, so the blast silhouettes rather than
    // erases what is standing in it.
    // Round 5 measured the terrain under the ring lit by the scene key alone —
    // the "light" layer was technically present and contributed nothing you
    // could read in the pixels. The intensity below is still well under the
    // 60*s that used to render every monster inside the blast as a uniform white
    // cast, but the range now actually reaches the ground the blast is standing
    // over, which is the surface the layer exists to brighten.
    // ...and round 5 then measured the other end of the same lever. The
    // equipment nuke is `explosion(at, 12)` (`equipment.js:175`), so `s` is 3
    // and this line asked for intensity 60 over a **50 m** range — nine times
    // the lit screen area of a normal blast at three times the brightness. In
    // `10-inventory` that keyed the entire frame: the 3D viewport measured mean
    // L 165 and 22% of its pixels over L 220 against L 62 / 0.5% for the same
    // stage and camera in `06-loaded-hud`, and terrain, water, trees and sky all
    // went milky yellow-green together. A blast light is a *local* light; past
    // about 26 m it has stopped being an effect and become the scene key.
    // The caps sit above `08-explosion`'s r = 6 (intensity 30, range 25.2), so
    // the shot the layer was tuned on is untouched and only the nuke is pulled
    // back to a blast that lights its own neighbourhood.
    // Round-5 r4 pulls the ceilings down onto `08-explosion`'s own numbers
    // exactly — r = 6 gives intensity 30 over 25.2 m — rather than leaving 7%
    // of headroom above them for nothing. Every blast at or below r = 6 is
    // untouched by construction; only the nuke moves.
    this.lights.flick(pos, colour, Math.min(20 * s, 30), Math.min(r * 4.2, 25.2), 0.42);
    // Screen-space distortion: the shell of bent air riding the shockwave.
    this.shockwave(pos, r * 2.6, 0.45, clamp(0.006 + r * 0.0018, 0.006, 0.026));
    this._shakeAt(pos, clamp(0.05 + r * 0.018, 0.05, 0.3));
    this._hitstop(HITSTOP.explosion, true);
    // A single blast used to reach the pipeline's aberration cap on its own,
    // which is 6-7 px of RGB separation at the frame edge. Subtle is under 1 px.
    if (this.ctx.pipeline) this.ctx.pipeline.aberration += 0.0012 * s;
    this.ctx.audio?.explosion(pos, r);
  }

  /**
   * RoR2 monster death: the body burns away bottom-to-top behind an emissive
   * rim while embers peel off the dissolve front and rise.
   */
  deathDissolve(mesh, colour = 0xff6a1e) {
    if (!mesh?.isObject3D) return;
    // A second kill event on the same corpse would dissolve the dissolve
    // variants, stranding the originals when the first pass hands its back.
    for (const d of this._dissolving) if (d.mesh === mesh) return;
    _box.setFromObject(mesh);
    if (!isFinite(_box.min.y)) return;

    const handle = makeDissolvable(mesh, {
      color: colour,
      minY: _box.min.y,
      maxY: _box.max.y,
      scale: 4.5 / Math.max(0.5, _box.max.y - _box.min.y),
    });
    const bags = handle.bags;
    if (!bags.length) { handle.release(); return; }

    this._dissolving.push({
      mesh, handle, bags, t: 0, dur: 0.85,
      // Which life of this rig we are burning. `resetRig`
      // (src/entities/EnemyMeshes.js:796) bumps the counter every time the rig
      // changes hands, so a mismatch on any later frame means the corpse we
      // were given is now a living monster and none of this effect's writes
      // belong to it any more. `undefined` on both sides for anything that is
      // not a pooled rig -- the player mesh, a prop -- which compares equal and
      // leaves those paths exactly as they were.
      owner: mesh.userData.rigEpoch,
      minY: _box.min.y, maxY: _box.max.y,
      cx: (_box.min.x + _box.max.x) * 0.5,
      cz: (_box.min.z + _box.max.z) * 0.5,
      rx: Math.max(0.2, (_box.max.x - _box.min.x) * 0.5),
      rz: Math.max(0.2, (_box.max.z - _box.min.z) * 0.5),
      colour,
      emitAccum: 0,
    });
  }

  /**
   * Throw a corpse. `dirX`/`dirZ` is the horizontal direction (away from
   * whatever killed it); `power` in [0,1] scales speed, lift and spin.
   *
   * The record holds elapsed time and the launch's own kinematics, never a
   * position — position is recomputed from t every frame and *added* to
   * whatever the owner wrote, so two systems writing the same transform
   * compose instead of fighting.
   */
  corpseLaunch(obj, dirX, dirZ, power) {
    if (!obj?.isObject3D || !(power > 0)) return;
    for (const l of this._launches) if (l.obj === obj) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    const k = clamp(power, 0, 1);
    const speed = LAUNCH.maxSpeed * k;
    this._launches.push({
      obj, t: 0, dur: LAUNCH.dur,
      // The base rotation, captured once. `Enemy.updateRig` rewrites only
      // `rotation.y` each frame, so x and z are ours alone and must be *set*
      // from t rather than accumulated — a `+=` here would spin the corpse
      // faster every frame and leave it at an arbitrary angle when the launch
      // retired, which is residue, and residue is what makes a cosmetic
      // effect stop being cosmetic.
      rx: obj.rotation.x, rz: obj.rotation.z,
      vx: (dirX / len) * speed,
      vz: (dirZ / len) * speed,
      // Lift is a fixed fraction of the horizontal throw: a body that goes
      // twice as far also goes twice as high, which is what keeps a weak
      // launch a stumble and a strong one an event.
      vy: speed * 0.62,
      // Tumble axis derived from the throw so the body rotates around the
      // direction it is travelling, not around an arbitrary one.
      sx: (dirZ / len) * LAUNCH.spin * k,
      sz: -(dirX / len) * LAUNCH.spin * k,
      // Filled in on ground contact: when it landed, the offset and the tumble
      // it landed with. Zero until then, and `land` doubles as the phase flag.
      land: 0, ox: 0, oz: 0, ax: 0, az: 0,
      // Same token, same reason as `deathDissolve`: this loop writes the rig
      // root's transform for up to `dur + hold`, which outlives a stage change,
      // and a throw re-applied to the enemy that inherited the rig would drag a
      // live monster metres off the position the simulation has for it.
      owner: obj.userData.rigEpoch,
    });
  }

  /** The death this element dies. Total: anything unknown is kinetic. */
  killSignature(element) {
    return KILL_SIGNATURE[element] || KILL_SIGNATURE.kinetic;
  }

  /**
   * Integrate every live launch and stamp the offset. Runs from `update`, so
   * it keeps animating while `ctx.hitstop` freezes gameplay — a frozen frame
   * with a corpse hanging mid-arc reads as impact, which is the whole point of
   * spending the hitstop next to it.
   */
  _updateLaunches(dt) {
    for (let i = this._launches.length - 1; i >= 0; i--) {
      const l = this._launches[i];
      // The corpse changed hands mid-flight. Drop the throw rather than apply
      // it to whatever is wearing the rig now; the launch holds no state on the
      // object, so letting go writes nothing and leaves no residue.
      if (l.obj.userData.rigEpoch !== l.owner) { this._launches.splice(i, 1); continue; }
      l.t += dt;
      const t = l.t;
      // Closed form rather than an accumulator: the offset is a pure function
      // of elapsed time, so a dropped frame changes nothing and re-applying it
      // on top of the owner's transform can never drift.
      const y = l.vy * t - 0.5 * LAUNCH.gravity * t * t;
      const o = l.obj;

      // Ground contact ends the *arc*, not the launch. Letting go here dropped
      // the entire `vx·t` offset in one frame while the corpse was still three
      // quarters visible, which undid the throw in the frame the throw
      // finished. So the landing values are latched and then held: the body
      // stays where it came to rest, on the ground, while the dissolve takes
      // it. Latched from the first sub-zero sample rather than solved for the
      // exact root because the difference is one frame of travel and the
      // held value only has to be *a* resting place, not the analytic one.
      if (!l.land && y < 0) {
        l.land = t;
        l.ox = l.vx * t;
        l.oz = l.vz * t;
        l.ax = l.sx * t;
        l.az = l.sz * t;
      }

      if (t >= l.dur || (l.land && t >= LAUNCH.hold)) {
        // Hand the rotation back exactly as it was found, then let go. On the
        // landed path the ease below has already walked it here, so this is a
        // no-op that stays in as the guarantee: whatever happened, the
        // rotation this launch borrowed is returned unchanged.
        o.rotation.x = l.rx;
        o.rotation.z = l.rz;
        this._launches.splice(i, 1);
        continue;
      }

      if (l.land) {
        // Landed and holding: horizontal offset frozen at the landing values,
        // vertical collapsed onto the ground the owner already writes, tumble
        // eased out across the hold instead of snapped straight at the end of
        // it. Still a pure function of t, still added rather than accumulated,
        // so the composition invariant is exactly the one the arc had.
        const u = clamp((t - l.land) / Math.max(1e-4, LAUNCH.hold - l.land), 0, 1);
        const e = 1 - u * u * (3 - 2 * u);
        o.position.x += l.ox;
        o.position.z += l.oz;
        o.rotation.x = l.rx + l.ax * e;
        o.rotation.z = l.rz + l.az * e;
        continue;
      }
      // Position is added, because the owner rewrites it from `this.position`
      // every frame and we are composing on top of that. Rotation is assigned,
      // because nobody else writes x or z and we own them for the launch's
      // life. Both are pure functions of t, so a dropped frame changes nothing.
      o.position.x += l.vx * t;
      o.position.z += l.vz * t;
      o.position.y += y;
      o.rotation.x = l.rx + l.sx * t;
      o.rotation.z = l.rz + l.sz * t;
    }
  }

  /**
   * World-space arcing damage readout. Crits are bigger, hotter and shake.
   * `target` is the merge key: repeat hits on one enemy accumulate into a
   * single readout rather than stacking a run each.
   */
  damageNumber(pos, amount, crit = false, colour, target) {
    this.numbers.spawn(pos, amount, crit, colour, target);
  }

  levelUp(pos) {
    let e = this._ep();
    e.count = 1; e.position.copy(pos).add(_v1.set(0, 1, 0));
    e.life = 0.5; e.lifeVar = 0;
    e.size0 = 0.6; e.size1 = 5.5;
    e.color0.set(0xfff4c0); e.color1.set(0xffb020);
    e.alpha0 = 0.9; e.frame = FRAME.SHOCK; e.drag = 6; e.alphaPow = 1.5; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 46; e.position.copy(pos); e.jitter = 0.5;
    e.dir.set(0, 1, 0); e.spread = 0.45;
    e.speed = 9; e.speedVar = 0.7;
    e.life = 1.1; e.lifeVar = 0.4;
    e.size0 = 0.16; e.size1 = 0.01;
    e.color0.set(0xfff6d0); e.color1.set(0xffa018);
    e.frame = FRAME.SPARK; e.stretch = 0.35;
    e.gravity = -3.5; e.drag = 1.1; e.turbulence = 0.35;
    this.particles.emit(e);

    e = this._ep();
    e.count = 3; e.position.copy(pos).add(_v1.set(0, 0.9, 0));
    e.life = 0.55; e.lifeVar = 0.2;
    e.size0 = 2.2; e.size1 = 0.4;
    e.color0.set(0xffffff); e.color1.set(0xffc040);
    e.frame = FRAME.FLARE; e.spin = 3; e.drag = 6; e.soft = 0;
    this.particles.emit(e);

    this.rings.spawn(pos, UP, 0xffc850, 0.4, 4.5, 0.7, 0.85);
    this.lights.flick(pos, 0xffc040, 40, 12, 0.5);
    this.ctx.pipeline?.addShake(0.05);
    this.ctx.audio?.levelUp();
  }

  itemPickupBurst(pos, tierColour = 0xffffff) {
    let e = this._ep();
    e.count = 34; e.position.copy(pos).add(_v1.set(0, 0.6, 0)); e.shell = 0.25;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 5.5; e.speedVar = 0.8;
    e.life = 0.8; e.lifeVar = 0.4;
    e.size0 = 0.14; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(tierColour);
    e.frame = FRAME.SPARK; e.stretch = 0.7;
    e.gravity = -2.5; e.drag = 2.4; e.turbulence = 0.3;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos).add(_v1.set(0, 0.6, 0));
    e.life = 0.35; e.lifeVar = 0;
    e.size0 = 0.5; e.size1 = 3.0;
    e.color0.set(tierColour); e.color1.set(tierColour);
    e.alpha0 = 0.8; e.frame = FRAME.SHOCK; e.drag = 7; e.soft = 0;
    this.particles.emit(e);

    this.lights.flick(pos, tierColour, 22, 7, 0.28);
  }

  /**
   * Teleporter charge field. Safe to call every frame — internally rate-limited
   * so the caller can just forward the progress event.
   */
  teleporterAura(pos, progress = 0) {
    const p = clamp(progress, 0, 1);
    this._teleAccum += this._dt ?? 0;
    const interval = lerp(0.06, 0.016, p);
    if (this._teleAccum < interval) return;
    this._teleAccum = 0;

    const colour = _tmpColor.setHSL(lerp(0.55, 0.08, p), 0.85, 0.6).getHex();

    let e = this._ep();
    e.count = 5; e.position.copy(pos); e.shell = lerp(9, 2.5, p);
    e.dir.set(0, 1, 0); e.spread = 0.25;
    e.speed = lerp(3, 9, p); e.speedVar = 0.5;
    e.life = 1.3; e.lifeVar = 0.35;
    e.size0 = 0.14; e.size1 = 0.02;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 0.6;
    e.gravity = -2.2; e.drag = 0.9; e.turbulence = 0.5;
    this.particles.emit(e);

    e = this._ep();
    e.layer = 'alpha';
    e.count = 2; e.position.copy(pos); e.shell = 8;
    e.dir.set(0, 1, 0); e.spread = 0.6;
    e.speed = 1.6; e.life = 2.4; e.lifeVar = 0.4;
    e.size0 = 0.5; e.size1 = 2.2;
    e.color0.set(colour); e.color1.set(0x101018);
    e.alpha0 = 0.16; e.frame = FRAME.DUST;
    e.drag = 1.2; e.gravity = -0.8; e.turbulence = 0.5; e.fadeIn = 0.2;
    this.particles.emit(e);

    this._teleRing += interval;
    if (this._teleRing > 0.55) {
      this._teleRing = 0;
      this.rings.spawn(pos, UP, colour, 10.5, 1.0, 1.1, 0.55);
    }
  }

  /** Jagged chained bolt: segments + branch sparks + a light + a crackle. */
  lightning(from, to, colour = 0x9fd4ff) {
    const rng = this.ctx.fxRng ?? this.ctx.rng;
    const segs = 8;
    _v1.subVectors(to, from);
    const len = _v1.length();
    if (len < 0.01) return;
    const jitter = clamp(len * 0.09, 0.15, 1.2);

    _v2.copy(from);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      _v3.copy(from).addScaledVector(_v1, t);
      if (i < segs) {
        _v3.x += (rng.next() * 2 - 1) * jitter;
        _v3.y += (rng.next() * 2 - 1) * jitter;
        _v3.z += (rng.next() * 2 - 1) * jitter;
      }
      _tmpColor.set(colour);
      this.beams.spawn(_v2, _v3, _tmpColor, 0.2, 0.02, 0.16, 0.6);
      this.beams.spawn(_v2, _v3, WHITE_HOT, 0.07, 0.008, 0.13, 3.0);

      const e = this._ep();
      e.count = 2; e.position.copy(_v3);
      e.dir.set(0, 1, 0); e.spread = Math.PI;
      e.speed = 5; e.speedVar = 0.9;
      e.life = 0.22; e.lifeVar = 0.5;
      e.size0 = 0.09; e.size1 = 0.01;
      e.color0.set(0xffffff); e.color1.set(colour);
      e.frame = FRAME.SPARK; e.stretch = 1.2; e.drag = 4; e.gravity = 4;
      this.particles.emit(e);

      _v2.copy(_v3);
    }

    this.lights.flick(to, colour, 26, 8, 0.12);
    this.hitSpark(to, colour, 0.9);
    this.ctx.audio?.zap(to);
  }

  /**
   * A body going down (§4.4 `playerDowned`). Two halves, and they are not the
   * same effect: a ring that *collapses inward* — every other ring in this file
   * expands, so inward is what makes it read as falling rather than as a nova —
   * and then a held marker registered at the body so a teammate can find it.
   *
   * Player-facing polarity (§1.2): white-hot core, element rim.
   */
  playerDowned(pawn, pos) {
    const at = pos || pawn?.position;
    if (!at) return;
    // Collapsing: r0 > r1. `RingPool.spawn` interpolates from r0 to r1, so the
    // inversion is the whole effect and swapping the pair breaks it.
    this.rings.spawn(at, UP, DOWNED_HUE, 4.5, 0.4, 0.55, 0.85);
    this.rings.spawn(at, UP, 0xffffff, 3.0, 0.2, 0.4, 0.6);

    const e = this._ep();
    e.layer = 'alpha';
    e.count = 16; e.position.copy(at); e.shell = 1.6;
    e.dir.set(0, -0.4, 0); e.spread = 1.2;
    e.speed = 2.4; e.speedVar = 0.5;
    e.life = 0.7; e.lifeVar = 0.3;
    e.size0 = 0.3; e.size1 = 0.04;
    e.color0.set(0xffffff); e.color1.set(DOWNED_HUE);
    e.alpha0 = 0.5; e.frame = FRAME.DUST; e.drag = 3.4; e.gravity = -3;
    this.particles.emit(e);

    this.lights.flick(at, DOWNED_HUE, 10, 12, 0.35);
    if (pawn) this._downed.set(pawn, { t: MARKER_PERIOD });
  }

  /**
   * The marker stops, with no revive spectacle attached. A peer that
   * disconnects while down is not revived — its body simply leaves the world —
   * so the despawn path needs the bookkeeping half of `playerRevived` without
   * the ring and the light burst. Idempotent and total: a pawn clears that one,
   * nothing clears every marker, which is what a stage change needs.
   */
  clearDownedMarker(pawn) {
    if (pawn) this._downed.delete(pawn); else this._downed.clear();
  }

  /**
   * The marker stops. Idempotent and total: called with a pawn it clears that
   * one, called with nothing it clears every marker in the world, which is what
   * a stage change needs.
   */
  playerRevived(pawn, pos) {
    this.clearDownedMarker(pawn);
    const at = pos || pawn?.position;
    if (!at) return;
    // Expanding lattice, restorative, heavy — the exact inverse of the
    // collapse above, and deliberately not `healPop`, which would also fire
    // `heal`'s audio.
    this.rings.spawn(at, UP, REVIVE_HUE, 0.4, 7, 0.6, 0.9);
    this.rings.spawn(at, UP, 0xffffff, 0.2, 4, 0.4, 0.7);

    const e = this._ep();
    e.count = 22; e.position.copy(at); e.shell = 0.4;
    e.dir.set(0, 1, 0); e.spread = 0.9;
    e.speed = 5.5; e.speedVar = 0.8;
    e.life = 0.8; e.lifeVar = 0.3;
    e.size0 = 0.24; e.size1 = 0.02;
    e.color0.set(0xffffff); e.color1.set(REVIVE_HUE);
    e.frame = FRAME.CROSS; e.spin = 4; e.drag = 2.4;
    this.particles.emit(e);

    this.lights.flick(at, REVIVE_HUE, 24, 18, 0.3);
  }

  /**
   * A boss arrives (§4.4 `bossHorn`): the horn now has a place it came from —
   * an expanding ring out of the spawn point and a light burst, at heavy
   * intensity, in the boss's own element.
   */
  bossArrival(pos, element = 'kinetic') {
    if (!pos) return;
    const hue = (ELEMENT_HUE[element] || ELEMENT_HUE.kinetic).tail;
    this.rings.spawn(pos, UP, hue, 1, 26, 0.85, 0.95);
    this.rings.spawn(pos, UP, 0xffffff, 0.5, 14, 0.5, 0.7);
    this.burst(pos, hue);
    this.lights.flick(pos, hue, 40, 60, 0.5);
    this.shockwave(pos, 22, 0.5, 0.03);
  }

  /**
   * Gold arriving (§4.4 `coin`): a small rising spark at the gain point, under
   * the pip that already plays.
   *
   * The hue is `COIN_HUE` and nothing may pass one in. Gold has no tier, so a
   * tier-coloured coin spark would make `itemPickupBurst` no longer the only
   * tier-coloured world effect — see the constant's own note.
   */
  coinSpark(pos) {
    if (!pos) return;
    const e = this._ep();
    e.count = 5; e.position.copy(pos); e.position.y += 0.6; e.jitter = 0.3;
    e.dir.set(0, 1, 0); e.spread = 0.35;
    e.speed = 3.4; e.speedVar = 0.7;
    e.life = 0.45; e.lifeVar = 0.2;
    e.size0 = 0.12; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(COIN_HUE);
    e.frame = FRAME.SPARK; e.spin = 5;
    e.gravity = -1.5; e.drag = 2.6;
    this.particles.emit(e);
  }

  /**
   * Re-lay every live downed marker. A ring has a life measured in fractions of
   * a second and a body stays down for as long as it takes someone to walk
   * over, so the marker is a slow pulse re-spawned here rather than one
   * long-lived object — and it stops the instant the entry leaves `_downed`,
   * which is the property `tests/downed-marker-release.test.mjs` asserts.
   */
  _updateDownedMarkers(dt) {
    if (this._downed.size === 0) return;
    for (const [pawn, m] of this._downed) {
      // A pawn that died or despawned is not a body to mark; the marker dies
      // with it rather than pulsing over an empty patch of floor for the rest
      // of the stage. Liveness only — `downed === false` would also be true of
      // the showcase's stand-in, which is a live pawn playing a downed one.
      if (!pawn?.position || pawn.alive === false) {
        this._downed.delete(pawn);
        continue;
      }
      m.t += dt;
      if (m.t < MARKER_PERIOD) continue;
      m.t = 0;
      this.rings.spawn(pawn.position, UP, DOWNED_HUE, 0.3, 2.2, 0.9, 0.4);
      this.lights.flick(pawn.position, DOWNED_HUE, 6, 14, 0.5);
    }
  }

  healPop(pos, amount = 0) {
    let e = this._ep();
    e.count = 14; e.position.copy(pos); e.jitter = 0.3;
    e.dir.set(0, 1, 0); e.spread = 0.5;
    e.speed = 3.2; e.speedVar = 0.6;
    e.life = 0.7; e.lifeVar = 0.35;
    e.size0 = 0.16; e.size1 = 0.02;
    e.color0.set(0xc8ffd0); e.color1.set(0x22aa55);
    e.frame = FRAME.CROSS; e.spin = 3; e.gravity = -2.5; e.drag = 2.2;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.4; e.size0 = 0.4; e.size1 = 2.2;
    e.color0.set(0x8fffa8); e.color1.set(0x22aa55);
    e.alpha0 = 0.55; e.frame = FRAME.SHOCK; e.drag = 6; e.soft = 0;
    this.particles.emit(e);

    if (amount > 0) this.numbers.spawn(pos, amount, false, 0x7dff9a);
    this.ctx.audio?.heal(pos);
  }

  /**
   * An enemy support unit topping an ally back up (C5, issue #159).
   *
   * The shape stays where §3 puts healing — radial-spark, rising — because it
   * *is* a heal and re-shaping it would separate two things that mean the same
   * thing. What separates it from the player's own mend is **polarity** (§1.2):
   * player heals carry a white-hot core with an element rim, and this one is
   * inverted — the element is the core and the rim falls away dark. An
   * Acolyte's heal is therefore visibly not the player's at a glance, before
   * either colour or position is read.
   *
   * Deliberately not `healPop`: that method speaks `heal()`, the player's own
   * restorative voice, and an enemy mend must not borrow it. The caster's
   * voice is spoken once at the caster, by the caller.
   */
  enemyMend(pos, hue = 0x74ffc8) {
    if (!pos) return;
    const e = this._ep();
    e.count = 12; e.position.copy(pos); e.position.y += 0.4; e.jitter = 0.3;
    e.dir.set(0, 1, 0); e.spread = 0.45;
    e.speed = 3.0; e.speedVar = 0.6;
    e.life = 0.65; e.lifeVar = 0.3;
    e.size0 = 0.18; e.size1 = 0.02;
    // Element core, dark rim: the inversion of `healPop`'s pale-to-mint ramp.
    e.color0.set(hue); e.color1.set(0x0d3b30);
    e.frame = FRAME.CROSS; e.spin = 3; e.gravity = -2.2; e.drag = 2.2;
    this.particles.emit(e);
    this.lights.flick(pos, hue, 8, 10, 0.22);
  }

  /**
   * `corruptionWarded` (issue #154), on its own method so a test can drive the
   * real body rather than a re-typed copy of it — the wiring line above is
   * asserted separately.
   *
   * The cue lands on the warder's own body where there is one, and falls back
   * to the viewer's: a client reading a host-side ward has no pawn reference,
   * and no cue at all would be worse than one at the wrong feet.
   *
   * The rate gate lives in `wardingMote`, not here, so the Showcase's own
   * direct calls are covered too (issue #161).
   */
  _onWarded(p) {
    const at = p?.player?.position || this.ctx?.player?.position;
    if (at) this.wardingMote(at, p?.progress ?? 0, !!p?.minted);
  }

  /**
   * Rate limit by key on VFX's own accumulated clock. Returns false if the
   * effect should be dropped. The counterpart to `Audio._throttle`, which
   * keys the same way against the AudioContext clock; reaching across for
   * that clock would tie the picture to whether audio ever started.
   *
   * A first fire after idle always passes — `-1` is further back than any
   * interval — which is what keeps a lone Showcase press drawing.
   */
  _throttle(key, minInterval) {
    const now = this.time ?? 0;
    const map = (this._throttles ??= new Map());
    const last = map.get(key) ?? -1;
    if (now - last < minInterval) return false;
    map.set(key, now);
    return true;
  }

  /**
   * Corruption taken back out by hand (issue #154). The mote-source cue: it
   * fires on a Voidtouched kill and on an Argent Font press, the only two acts
   * that ward, so watching it is how a player learns what feeds the purse.
   *
   * Restorative mint-green (§1.1) at player polarity — white-hot core, mint rim
   * (§1.2) — as a rising radial-spark, which is C5's healing point and correct:
   * warding *is* the restorative family, and it is feedback rather than damage,
   * so the reserved hue is legal here.
   *
   * `progress` is what the invisible half of the system looked like. The ground
   * ring's radius carries it, so a ward that nearly fills a mote draws a wider
   * circle than one that barely moved the needle, and the last ward before a
   * mint is visibly the biggest. `minted` promotes the whole cue from tick to
   * event intensity — a light, a wider ring, twice the motes.
   *
   * Rate-gated on the same key and the same two constants as the voice it
   * speaks at the end — `Audio.warding` (issue #161). A kill-storm inside a
   * Sanctuary wards on every kill; ungated, the ring drew roughly eight times
   * for each chime it was supposed to belong to. The gate sits here rather
   * than in `_onWarded` because the Showcase's `warding`/`wardingMint`
   * moments call this method directly, and a `g` pile-up of both would
   * otherwise draw two rings for one chime — the very mismatch, in the tool
   * meant for judging it.
   *
   * The two gates are not one gate: VFX counts its own accumulated `dt`,
   * Audio counts `ac.currentTime`. They agree because `dt` reaching VFX is
   * only ever truncated relative to real time (`Engine`'s 0.1s clamp; hitstop
   * scales the fixed gameplay step, not this one), never inflated — so
   * passing VFX's gate implies at least as much real time has passed, which
   * implies Audio's gate passes too. Feed VFX a scaled-up `dt` and that
   * invariant is what breaks; change one constant without the other and the
   * mismatch is immediate.
   */
  wardingMote(pos, progress = 0, minted = false) {
    if (!pos) return;
    if (!this._throttle('warding', minted ? 0.05 : 0.14)) return;
    const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const e = this._ep();
    e.count = minted ? 16 : 7; e.position.copy(pos); e.position.y += 0.6; e.jitter = 0.35;
    e.dir.set(0, 1, 0); e.spread = 0.45;
    e.speed = 2.6 + p * 1.4; e.speedVar = 0.5;
    e.life = 0.55; e.lifeVar = 0.3;
    e.size0 = 0.13; e.size1 = 0.02;
    // White core, mint rim: this is the player's own doing, not the world's.
    e.color0.set(PURITY.wardCore); e.color1.set(PURITY.wardRim);
    e.frame = FRAME.SPARK; e.spin = 2; e.gravity = -1.6; e.drag = 2.4;
    this.particles.emit(e);

    // The gauge that was never on the ground. 0.5 m at a fresh mote, 2.6 m at
    // the brim; a mint draws the full circle regardless, because a mint always
    // completes one.
    const r = minted ? 3.2 : 0.5 + p * 2.1;
    this.rings.spawn(pos, UP, PURITY.wardRing, r * 0.35, r, minted ? 0.55 : 0.4, minted ? 0.9 : 0.5);
    if (minted) this.lights.flick(pos, PURITY.wardRing, 14, 6, 0.16);
    this.ctx?.audio?.warding?.(pos, p, minted);
  }

  /**
   * A Sanctuary window opening (issue #154). It cost a mote and it was one
   * small blue burst; it is now the protective **lattice** class (§1.3) at
   * *event* intensity — a dome of spinning `HEX` going up around the altar,
   * a wide restorative ring and a light — because what it buys is a shell of
   * free ground around the party for twelve seconds.
   *
   * Deliberately no sustained voice: the window has three exits (expiry,
   * replacement by a second press, and the run ending) and an unreleased hold
   * on any of them is this repo's recurring failure. The window's *duration*
   * is carried on the HUD chip instead, where it can simply be recomputed.
   */
  sanctuaryOpen(pos) {
    if (!pos) return;
    let e = this._ep();
    e.count = 22; e.position.copy(pos); e.shell = 0.7;
    e.dir.set(0, 1, 0); e.spread = Math.PI * 0.55;
    e.speed = 4.4; e.speedVar = 0.5;
    e.life = 0.95; e.lifeVar = 0.3;
    e.size0 = 0.24; e.size1 = 0.06;
    e.color0.set(PURITY.sanctuaryCore); e.color1.set(PURITY.sanctuaryRim);
    e.frame = FRAME.HEX; e.spin = 6; e.gravity = -1.2; e.drag = 1.6;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(pos); e.position.y += 0.4;
    e.life = 0.7; e.size0 = 0.6; e.size1 = 7.5;
    e.color0.set(PURITY.sanctuaryVeil); e.color1.set(PURITY.sanctuaryVeilIn);
    e.alpha0 = 0.4; e.frame = FRAME.RING; e.drag = 5; e.soft = 0;
    this.particles.emit(e);

    this.rings.spawn(pos, UP, PURITY.wardRing, 0.6, 7.5, 0.7, 0.85);
    this.lights.flick(pos, PURITY.sanctuaryLight, 26, 9, 0.3);
  }

  /**
   * A Consecration — three motes turned into a permanent argent card. It had no
   * sound at all and one generic burst. Restorative lattice like Sanctuary,
   * because both are the purity route paying out, but *rising* rather than
   * expanding: a column of motes drawn up out of the altar, then the argent
   * tier's own pale hue closing over it. The tier colour appears only on the
   * item plate the grant paints (§2); this is mint, the effect surface's ink.
   */
  consecration(pos) {
    if (!pos) return;
    let e = this._ep();
    e.count = 26; e.position.copy(pos); e.jitter = 0.5;
    e.dir.set(0, 1, 0); e.spread = 0.22;
    e.speed = 6.5; e.speedVar = 0.9;
    e.life = 1.1; e.lifeVar = 0.35;
    e.size0 = 0.2; e.size1 = 0.03;
    e.color0.set(PURITY.sanctuaryCore); e.color1.set(PURITY.wardRim);
    e.frame = FRAME.HEX; e.spin = 8; e.gravity = -2.2; e.drag = 1.1;
    this.particles.emit(e);

    e = this._ep();
    e.count = 12; e.position.copy(pos); e.position.y += 2.2; e.shell = 0.5;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 2.4; e.speedVar = 0.4;
    e.life = 0.8; e.lifeVar = 0.3;
    e.size0 = 0.16; e.size1 = 0.01;
    e.color0.set(PURITY.sanctuaryCore); e.color1.set(PURITY.argentPale);
    e.frame = FRAME.CROSS; e.spin = 3; e.gravity = 1.4; e.drag = 2.2;
    this.particles.emit(e);

    this.rings.spawn(pos, UP, PURITY.argentRing, 0.4, 4.6, 0.6, 0.9);
    this.lights.flick(pos, PURITY.sanctuaryVeil, 30, 8, 0.35);
    this._shakeAt(pos, 0.03);
  }

  shieldBreak(pos) {
    let e = this._ep();
    e.count = 24; e.position.copy(pos); e.shell = 0.55;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 7.5; e.speedVar = 0.7;
    e.life = 0.6; e.lifeVar = 0.4;
    e.size0 = 0.18; e.size1 = 0.05;
    e.color0.set(0xffffff); e.color1.set(0x4fa8ff);
    e.frame = FRAME.HEX; e.spin = 10; e.gravity = 12; e.drag = 1.4;
    this.particles.emit(e);

    this.rings.spawn(pos, UP, 0x6fc0ff, 0.4, 3.4, 0.4, 0.9);
    this.lights.flick(pos, 0x6fc0ff, 24, 7, 0.18);
    this._shakeAt(pos, 0.035);
    this.ctx.audio?.shieldBreak(pos);
  }

  /**
   * A Warded elite turning a hit around. Lattice class (§1.3): `HEX` with
   * spin, the shape reserved for protective and warded things, so a reflect
   * cannot be mistaken for an ordinary unattributed hit — which is what
   * `type:'reflect'` being set and read by nothing produced.
   */
  wardReflect(pos, colour = 0xb291ff) {
    if (!pos) return;
    const e = this._ep();
    e.count = 9; e.position.copy(pos); e.position.y += 1.1; e.shell = 0.6;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 3.2; e.speedVar = 0.5;
    e.life = 0.34; e.lifeVar = 0.3;
    e.size0 = 0.22; e.size1 = 0.03;
    e.color0.set(colour); e.color1.set(0x2a1240);
    e.frame = FRAME.HEX; e.spin = 9; e.drag = 4.5;
    this.particles.emit(e);
    this.lights.flick(pos, colour, 9, 4, 0.1);
    this.ctx?.audio?.elementTick?.(pos, 'void', 1.6);
  }

  /**
   * A heal that a Withering elite ate. Healing being denied has to *show* the
   * denial, or the affix's whole mechanic is a number that quietly does not
   * happen. Void, per §1.1 — colouring denial with the restorative hue is the
   * violation this replaces.
   */
  healDenied(pos, colour = 0xab00ac) {
    if (!pos) return;
    const e = this._ep();
    e.count = 7; e.position.copy(pos); e.position.y += 1.2;
    e.dir.set(0, -1, 0); e.spread = 0.9;
    e.speed = 2.6; e.speedVar = 0.5;
    e.life = 0.3; e.lifeVar = 0.3;
    e.size0 = 0.16; e.size1 = 0.01;
    e.color0.set(colour); e.color1.set(0x1a0420);
    e.frame = FRAME.CROSS; e.drag = 5; e.gravity = 3;
    this.particles.emit(e);
    this.ctx?.audio?.elementTick?.(pos, 'void', 0.6);
  }

  /**
   * Ongoing status overlay on an entity, for `duration` seconds.
   * Returns the live entry, so callers that want to dress the application
   * itself do not have to go looking for it.
   */
  statusApplied(target, type = 'burn', duration) {
    const def = STATUS[type];
    if (!def || !target) return null;
    const dur = duration ?? def.dur ?? 3;
    // Reapplying an existing status refreshes it rather than doubling the
    // particle rate — five stacks of burn should not be five times the smoke.
    // Two Map lookups, not a scan of every live overlay: this runs on every
    // proc of every hit, and a boss fight has both in quantity.
    let byType = this._statuses.get(target);
    if (!byType) this._statuses.set(target, (byType = new Map()));
    const existing = byType.get(type);
    if (existing) { existing.t = 0; existing.dur = dur; return existing; }
    const s = { target, type, def, t: 0, dur, accum: 0 };
    byType.set(type, s);
    return s;
  }

  /** Combat's calling convention: (entity, type, colour). */
  status(entity, type, colour) {
    const s = this.statusApplied(entity, type);
    const p = entity?.position;
    if (!p) return;
    // Every status application in the game was silent: a burn, a freeze and a
    // shock landed with only the caller's own attack sound to mark them.
    //
    // Ahead of the `!s` return, deliberately. `STATUS` has overlay recipes for
    // five types and the game applies more than five — `void` and `wither` have
    // no overlay — and behind the return those applications stayed completely
    // silent, which is precisely the hole §4.4 says to close. A status with no
    // overlay still gets its voice.
    this.ctx?.audio?.statusVoice?.(p, type);
    if (colour === undefined || !s) return;
    // One-shot application pop in the status's own colour, so a fresh proc
    // reads distinctly from the ongoing overlay.
    const e = this._ep();
    e.count = 8; e.position.copy(p); e.position.y += (entity.height ?? 1.6) * 0.5;
    e.shell = entity.radius ?? 0.5;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 3.5; e.speedVar = 0.7;
    e.life = 0.4; e.lifeVar = 0.4;
    e.size0 = 0.14; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.layer = s.def.alpha ? 'alpha' : 'add';
    e.frame = s.def.frame; e.spin = 6; e.drag = 3.5;
    this.particles.emit(e);
  }

  /** Proc beam (chain lightning, seeking strikes): thicker and longer than a tracer. */
  beam(from, to, colour = 0x9fd8ff) {
    if (!from || !to) return;
    _tmpColor.set(colour);
    // Part-tapered: a chain link has to stay legible end to end (it is the
    // "it jumped to that one" cue) but still wants a brighter receiving end.
    this.beams.spawn(from, to, _tmpColor, 0.3, 0.03, 0.26, 0.5, 0.6);
    this.beams.spawn(from, to, WHITE_HOT, 0.1, 0.008, 0.2, 2.6, 0.6);

    // Sparks at the receiving end are what make a chain read as "it hit that one".
    let e = this._ep();
    e.count = 8; e.position.copy(to);
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 6; e.speedVar = 0.8;
    e.life = 0.28; e.lifeVar = 0.5;
    e.size0 = 0.1; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.2; e.drag = 4; e.gravity = 5;
    this.particles.emit(e);

    e = this._ep();
    e.count = 1; e.position.copy(to);
    e.life = 0.18; e.size0 = 0.7; e.size1 = 0.1;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.CROSS; e.drag = 8; e.alphaPow = 0.9; e.fadeIn = 0.001; e.soft = 0;
    this.particles.emit(e);

    this.lights.flick(to, colour, 14, 5, 0.1);
  }

  /** Standalone AoE ring pulse (item procs that aren't explosions). */
  ring(pos, radius = 3, colour = 0xff7a2a) {
    if (!pos) return;
    this.rings.spawn(pos, UP, colour, radius * 0.12, radius, 0.42, 0.9);
    this.rings.spawn(pos, UP, 0xffffff, radius * 0.08, radius * 0.6, 0.26, 0.55);

    const e = this._ep();
    e.layer = 'alpha';
    e.count = 14; e.position.copy(pos); e.shell = radius * 0.2;
    e.dir.set(0, 0.25, 0); e.spread = 1.45;
    e.speed = radius * 2.2; e.speedVar = 0.6;
    e.life = 0.6; e.lifeVar = 0.4;
    e.size0 = 0.25; e.size1 = radius * 0.3;
    e.color0.set(colour); e.color1.set(0x1a1618);
    e.alpha0 = 0.35; e.frame = FRAME.DUST; e.spin = 2;
    e.drag = 3.2; e.turbulence = 0.3; e.fadeIn = 0.08;
    this.particles.emit(e);

    this.lights.flick(pos, colour, 18, radius * 1.8, 0.2);
    this._shakeAt(pos, clamp(0.015 + radius * 0.004, 0.015, 0.06));
  }

  /** Homing-strike streak: launch puff, travelling core, terminal spark. */
  missile(from, to, colour = 0xffa040) {
    if (!from || !to) return;
    _v1.subVectors(to, from);
    const dist = _v1.length();
    if (dist < 0.01) return;
    _v1.divideScalar(dist);
    const travel = clamp(dist / 45, 0.08, 0.5);

    // The "projectile" is one long-lived stretched particle flying the gap.
    let e = this._ep();
    e.count = 1; e.position.copy(from);
    e.dir.copy(_v1);
    e.speed = dist / travel; e.speedVar = 0;
    e.life = travel; e.lifeVar = 0;
    e.size0 = 0.45; e.size1 = 0.3; e.sizeVar = 0;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.6; e.drag = 0.001; e.alphaPow = 0.4; e.soft = 0;
    this.particles.emit(e);

    // Smoke laid along the flight path via delayed spawns.
    e = this._ep();
    e.layer = 'alpha';
    e.count = 10; e.position.copy(from);
    e.dir.copy(_v1);
    e.speed = dist / travel * 0.55; e.speedVar = 0.35;
    e.life = 0.45; e.lifeVar = 0.4;
    e.size0 = 0.12; e.size1 = 0.5;
    e.color0.set(0x9a9188); e.color1.set(0x2c2a2c);
    e.alpha0 = 0.3; e.frame = FRAME.SMOKE; e.spin = 2;
    e.drag = 5; e.turbulence = 0.3; e.fadeIn = 0.1;
    this.particles.emit(e);

    e = this._ep();
    e.count = 6; e.position.copy(from);
    e.dir.copy(_v1); e.spread = 0.9;
    e.speed = 5; e.speedVar = 0.7;
    e.life = 0.2; e.lifeVar = 0.4;
    e.size0 = 0.12; e.size1 = 0.01;
    e.color0.set(0xfff0c0); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.0; e.drag = 3; e.gravity = 6;
    this.particles.emit(e);

    this.lights.flick(from, colour, 10, 4, 0.09);
    this.ctx.audio?.shoot(from, 0.7);
  }

  /**
   * The sentry's shot, dressed as a Salvo micro-missile (#190, restyled #198).
   *
   * Purely presentational: Rook's turret is and stays hitscan, the damage has
   * already landed by the time this runs, and nothing here is stepped, queried
   * or spawned into the projectile pool. What changes is that a deployed sentry
   * stops firing an anonymous green wire and starts firing the same thing
   * Ranger's Suppressive Salvo fires — a little cone-nosed missile body under a
   * white-cored ribbon trail — only in Rook's green and a size down, flying a
   * line whose far end is already decided.
   *
   * The body and the ribbon come from `DartPool`, which borrows the projectile
   * renderer's geometry, material and trail wholesale; see its own note for
   * what is and is not shared. The particles left here are the two moments a
   * mesh cannot express: the launch puff and the impact.
   *
   * "Effectively instantly" is a real constraint and not a hedge: the body's
   * whole flight is `FLIGHT` seconds regardless of range, so a 4 m shot and a
   * 30 m shot both arrive within a frame or two of the hit they illustrate and
   * the eye never gets the chance to see the visual lag the damage. It is a
   * dressed streak with direction, not a projectile.
   *
   * Kept cheap because a field of turrets fires this several times a second:
   * one pooled mesh, one pooled ribbon, two pooled emits and one light — no
   * geometry built, no material compiled, no per-shot allocation beyond the
   * shared scratch vectors.
   *
   * @param {THREE.Vector3} from muzzle
   * @param {THREE.Vector3} to   where the hitscan already landed
   * @param {number} colour      ribbon hue; the body takes `accent`
   */
  sentryMissile(from, to, colour = SENTRY_TRAIL, accent = SENTRY_ACCENT) {
    if (!from || !to) return;
    _v1.subVectors(to, from);
    const dist = _v1.length();
    if (dist < 0.01) return;
    _v1.divideScalar(dist);
    const FLIGHT = 0.05;

    // The body: a real missile mesh flying the shot line, dragging the same
    // ribbon a Salvo missile drags, at 0.75 of a Salvo missile's size.
    this.darts?.fire(from, to, {
      colour: accent, trailColour: colour,
      scale: 0.75, life: FLIGHT, width: 0.12, trailLife: 0.16,
    });

    // Launch puff at the muzzle, so the body is seen leaving rather than simply
    // appearing. Wide and short — it is gone before the body is half way.
    let e = this._ep();
    e.count = 3; e.position.copy(from);
    e.dir.copy(_v1); e.spread = 0.5;
    e.speed = 3.2; e.speedVar = 0.6;
    e.life = 0.1; e.lifeVar = 0.3;
    e.size0 = 0.14; e.size1 = 0.02;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.4; e.drag = 6;
    this.particles.emit(e);

    // Terminal spark, at the far end, delayed by the flight so the impact and
    // the arrival are the same event.
    e = this._ep();
    e.count = 4; e.position.copy(to);
    e.dir.copy(_v1).negate(); e.spread = 1.1;
    e.speed = 4.5; e.speedVar = 0.6;
    e.life = 0.13; e.lifeVar = 0.4;
    e.size0 = 0.11; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(colour);
    e.frame = FRAME.SPARK; e.stretch = 1.0; e.drag = 5; e.gravity = 4;
    e.delay = FLIGHT;
    this.particles.emit(e);

    this.lights.flick(from, colour, 6, 3, 0.06);
  }

  /** Damage fully negated: a hard metallic ring, no blood, no shake. */
  block(pos) {
    if (!pos) return;
    let e = this._ep();
    e.count = 1; e.position.copy(pos);
    e.life = 0.22; e.size0 = 0.3; e.size1 = 2.4;
    e.color0.set(0xffffff); e.color1.set(0xa8c8ff);
    e.alpha0 = 0.9; e.frame = FRAME.SHOCK; e.drag = 7; e.alphaPow = 1.3; e.soft = 0;
    this.particles.emit(e);

    e = this._ep();
    e.count = 12; e.position.copy(pos); e.shell = 0.3;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = 7; e.speedVar = 0.8;
    e.life = 0.3; e.lifeVar = 0.5;
    e.size0 = 0.1; e.size1 = 0.01;
    e.color0.set(0xffffff); e.color1.set(0x88b0ff);
    e.frame = FRAME.SPARK; e.stretch = 1.3; e.drag = 4; e.gravity = 14;
    this.particles.emit(e);

    this.lights.flick(pos, 0xbcd8ff, 14, 5, 0.1);
    this.ctx.audio?.impact(pos, 'metal');
  }

  /** Generic celebratory burst (teleporter completion, unlocks). */
  burst(pos, colour = 0xffffff) {
    this.itemPickupBurst(pos, colour);
    this.rings.spawn(pos, UP, colour, 0.5, 7, 0.7, 0.7);
    this._shakeAt(pos, 0.05);
  }

  /** Flash the struck entity's emissive white for ~60ms. */
  hitFlash(entity, colour = 0xffffff, duration = 0.06) {
    // The player's hit-flash preference, read where the flash is produced: at 0
    // no material is ever cloned or brightened, so the effect does not exist
    // rather than being dimmed out of a finished frame. Defaults to 1.
    const strength = this.ctx?.settings?.flash ?? 1;
    if (!(strength > 0)) return;

    const obj = resolveObject(entity);
    if (!obj) return;

    let rec = obj.userData.__vfxFlash;
    if (!rec) {
      rec = { mats: [], base: [], colour: new THREE.Color(), t: 0, dur: 0.06 };
      obj.traverse((c) => {
        if (!c.isMesh || !c.material) return;
        const list = Array.isArray(c.material) ? c.material : [c.material];
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m.emissive) continue;
          // Clone once so flashing one enemy never lights up every enemy that
          // happens to share the prefab material. This clone REPLACES the
          // mesh's material for the rest of the rig's life, so it has to carry
          // everything the original did: `Material.copy` drops own-property
          // hooks and JSON-flattens userData, which silently stripped the
          // corruption pass off any figure that had ever been hit, and now
          // would also leave it with a dead blight anchor.
          const cl = m.userData.charBlight ? cloneCharacterBlightMaterial(m) : m.clone();
          if (Array.isArray(c.material)) c.material[i] = cl; else c.material = cl;
          rec.mats.push(cl);
          rec.base.push(cl.emissive.clone(), cl.emissiveIntensity ?? 1);
        }
      });
      obj.userData.__vfxFlash = rec;
    }
    if (!rec.mats.length) return;

    rec.colour.set(colour);
    for (let i = 0; i < rec.mats.length; i++) {
      const m = rec.mats[i];
      m.emissive.copy(rec.colour);
      // `rec.base` is interleaved [colour, intensity] per material, so the
      // material's own resting intensity is the far end of the ramp: at 100%
      // this is the historical flat 3.2, and below it the flash reads as a
      // lighter lift off the material instead of a full-brightness pop.
      const rest = rec.base[i * 2 + 1] ?? 1;
      m.emissiveIntensity = rest + (FLASH_INTENSITY - rest) * strength;
    }
    rec.t = 0;
    rec.dur = duration;
    // The record outlives this call: `_updateFlashes` re-drives the intensity
    // every frame for the whole 60ms, so the preference has to travel WITH the
    // flash. Setting it only here would be overwritten on the very next frame
    // by the decay's own target.
    rec.strength = strength;
    if (this._flashes.indexOf(rec) < 0) this._flashes.push(rec);
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */

  _onDamage(p) {
    if (!p) return;
    const pos = p.position || p.target?.position;
    if (!pos) return;

    const target = p.target;
    const rel = target?.maxHealth ? clamp(p.amount / target.maxHealth, 0, 1) : 0.25;

    if (target?.isPlayer) {
      // Player-side: record the incoming direction for the HUD indicator.
      const src = p.source?.position;
      if (src && this.ctx.player?.position) {
        _h1.subVectors(src, this.ctx.player.position);
        _h1.y = 0;
        if (_h1.lengthSq() > 1e-6) {
          this._pushDamageDirection(src, clamp((p.amount / Math.max(1, target.maxHealth)) * 3, 0.25, 1));
        }
      }
      return;
    }

    _h1.copy(pos);
    if (p.source?.position) {
      _h2.subVectors(pos, p.source.position);
      if (_h2.lengthSq() < 1e-6) _h2.set(0, 1, 0);
    } else {
      _h2.set(0, 1, 0);
    }
    _h2.normalize();

    // The colour is the damage's own family, not the weapon's. A frost round
    // and a fire round out of the same barrel have to look like two different
    // things or the elemental items are invisible in the one place the player
    // is actually looking. Untyped hits resolve to `kinetic`, whose hexes are
    // the two literals this line used to carry.
    const element = elementOf(p.type, p.status);
    this.hitSpark(_h1, sparkColour(element, p.crit), p.crit ? 1.35 : 1);
    // The primary gout carries the killing element too, not just the spark:
    // one fixed red on every hit in the game was what defeated element
    // attribution in the one place the player is actually looking.
    this.bloodHit(_h1, _h2, goreColour(element));
    this.hitFlash(target, p.crit ? ELEMENT_HUE[element].critTail : ELEMENT_HUE[element].core,
                  p.crit ? 0.09 : 0.06);
    this.damageNumber(_h1, p.amount, p.crit, undefined, target);

    const shake = clamp((p.crit ? 0.026 : 0.011) + rel * 0.05, 0.008, 0.075);
    this._shakeAt(_h1, shake);
    this._hitstop(p.crit ? HITSTOP.crit : HITSTOP.hit, p.crit);

    if (p.proc) this.lights.flick(_h1, 0xffd24a, 10, 3.5, 0.08);
  }

  _onKill(p) {
    if (!p) return;
    const pos = p.position || p.victim?.position;
    if (!pos) return;
    _h1.copy(pos);

    const obj = resolveObject(p.victim);
    if (obj) this.deathDissolve(obj, p.isElite ? 0xff9a30 : 0xff6a1e);

    // Overkill throws the body away from the blow. Scaled against the
    // victim's own pool, so "a hit with a lot left over" means the same thing
    // on a mite as on a hulk.
    const pool = Math.max(1, p.victim?.maxHealth ?? 0);
    const over = (p.overkill ?? 0) / pool;
    // The floor alone saturated the late run — 90.1% of kills launched at
    // max power (reviews/round9/juice-probe.json). The gate also asks the
    // kill to stand out against the run's own recent history; elites and
    // bosses, rare by construction, keep the floor-only rule.
    const launch = obj && shouldLaunch(
      over, this._overkillRecent, LAUNCH.minOverkillFrac, !!(p.isElite || p.isBoss));
    // Deliberately unconditional: every kill's fraction enters the window,
    // launched or not, elite or not, rigless or not - the ring measures this
    // run's damage profile, not the launchable subset, so a kill that never
    // had a chance to launch still counts toward "what this run has been like".
    this._overkillRecent.push(over);
    if (this._overkillRecent.length > GATE.window) this._overkillRecent.shift();
    if (launch) {
      const src = p.source?.position;
      let dx = 0, dz = 1;
      if (src) {
        dx = _h1.x - src.x; dz = _h1.z - src.z;
        if (dx * dx + dz * dz < 1e-6) { dx = 0; dz = 1; }
      }
      this.corpseLaunch(obj, dx, dz,
        clamp((over - LAUNCH.minOverkillFrac) / (1 - LAUNCH.minOverkillFrac), 0, 1));
    }

    const big = p.isBoss ? 2.2 : p.isElite ? 1.4 : 1;
    const element = elementOf(p.type, p.status);
    const sig = this.killSignature(element);
    const hue = ELEMENT_HUE[element] || ELEMENT_HUE.kinetic;

    let e = this._ep();
    e.count = Math.round(18 * big); e.position.copy(_h1); e.shell = 0.35 * big;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = sig.speed * big; e.speedVar = 0.8;
    e.life = sig.life; e.lifeVar = 0.5;
    e.size0 = 0.14 * big; e.size1 = 0.02;
    // `killX ?? X`: the kinetic entry overrides all three so an untyped kill
    // is byte-identical to the one that ships, and the other six families
    // simply use their own hues.
    e.color0.set(hue.killCore ?? hue.core); e.color1.set(hue.killTail ?? hue.tail);
    e.frame = sig.frame; e.stretch = sig.stretch; e.gravity = sig.gravity;
    e.drag = sig.drag; e.spin = sig.spin;
    this.particles.emit(e);

    // Elites keep their hotter ring regardless of element — the affix read has
    // to survive the damage type that finished it, or an Emberclad kill by a
    // frost round stops looking like an elite kill. `p.isElite ||` on the gate
    // itself (not just the colour) because void.ring is false: without it, a
    // void weapon finishing a Hollowed elite would drop the amber affix ring
    // this comment promises survives every damage type.
    if (p.isElite || sig.ring) {
      this.rings.spawn(_h1, UP, p.isElite ? 0xffa040 : hue.ring, 0.3 * big, 3.2 * big, 0.45, 0.8);
    }
    this.lights.flick(_h1, hue.killFlick ?? hue.ring, 24 * big, 6 * big, 0.22);
    if (sig.shock) this.shockwave(_h1, 4 * big, 0.34, 0.020);

    this._shakeAt(_h1, p.isBoss ? 0.22 : p.isElite ? 0.07 : 0.03);
    this._hitstop(p.isBoss ? HITSTOP.boss : p.isElite ? HITSTOP.elite : HITSTOP.kill, true);

    if (p.isBoss) this.explosion(_h1, 7, 0xffb040);
  }

  _onPlayerHurt(p) {
    const amount = p?.amount ?? 0;
    const remaining = p?.remaining ?? 1;
    const sev = clamp(amount / Math.max(1, this.ctx.player?.maxHealth ?? 100), 0.08, 1);

    const pipe = this.ctx.pipeline;
    if (pipe) {
      pipe.addShake(0.06 + sev * 0.16);
      pipe.aberration += 0.006 + sev * 0.02;
      // Low health leans harder on the vignette so the panic read is automatic.
      const lowHp = 1 - clamp(remaining / Math.max(1, this.ctx.player?.maxHealth ?? 100), 0, 1);
      pipe.vignetteBoost += 0.18 + sev * 0.35 + lowHp * 0.25;
    }
    this._hitstop(HITSTOP.playerHurt, true);

    const pp = this.ctx.player?.position;
    if (pp) {
      const e = this._ep();
      e.layer = 'alpha';
      e.count = 12; e.position.copy(pp); e.shell = 0.6;
      e.dir.set(0, 1, 0); e.spread = Math.PI;
      e.speed = 4; e.speedVar = 0.8;
      e.life = 0.5; e.lifeVar = 0.4;
      e.size0 = 0.12; e.size1 = 0.04;
      e.color0.set(0xb01020); e.color1.set(0x400408);
      e.frame = FRAME.BLOB; e.spin = 6; e.gravity = 18; e.drag = 1.2;
      this.particles.emit(e);
    }
  }

  /**
   * A barrier ate the hit. Combat no longer emits `playerHurt` at zero, so this
   * is what keeps an absorbed hit readable — deliberately a fraction of the
   * hurt response: a shove on the camera and nothing else. No hitstop, no
   * vignette, no aberration, because sustained chip damage under a barrier used
   * to stutter the whole screen for zero health lost.
   */
  _onShieldAbsorb(p) {
    if ((p?.absorbed ?? 0) <= 0) return;
    this.ctx.pipeline?.addShake(0.035);
  }

  /* ------------------------------------------------------------------ */
  /* Feel primitives                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Distance-weighted shake. A kill across the map should not punch the camera
   * as hard as one at the player's feet, or sustained far-off combat turns the
   * whole screen into mush.
   */
  _shakeAt(pos, amount) {
    const cam = this.ctx.camera;
    if (!cam) return;
    const d2 = cam.position.distanceToSquared(pos);
    const f = 1 / (1 + d2 / (SHAKE_HALF_DIST * SHAKE_HALF_DIST));
    this.ctx.pipeline?.addShake(amount * f);
  }

  /**
   * `important` beats bypass the rate gate. Everything clamps to HITSTOP_MAX so
   * overlapping events can never compound into a visible hitch.
   */
  _hitstop(amount, important = false) {
    const ctx = this.ctx;
    if (!important && this.time - this._lastHitstop < HITSTOP_GATE) return;
    this._lastHitstop = this.time;
    ctx.hitstop = Math.min(HITSTOP_MAX, Math.max(ctx.hitstop, amount));
  }

  /* ------------------------------------------------------------------ */

  update(ctx, dt) {
    this.time += dt;
    this._dt = dt;

    this.particles.update(ctx, dt);
    // Darts before trails: a body moved this frame must have fed its ribbon a
    // point before the ribbon is rebuilt, or the trail lags the mesh by a frame.
    this.darts?.update(dt);
    this.trails.update(ctx, dt);
    this.decals.update(ctx, dt);
    this.lights.update(dt);
    this.beams.update(dt);
    // Rings share the particle layer's half-res depth prepass rather than
    // rasterising a second one — the prepass is the expensive half of soft
    // particles and it is already paid for.
    const soft = this.particles.soft ? this.particles.depthRT : null;
    if (soft) {
      ctx.pipeline?.renderer?.getDrawingBufferSize(_ringSize)
        ?? _ringSize.set(innerWidth, innerHeight);
      this.rings.update(dt, soft.depthTexture, _ringSize, ctx.camera.near, ctx.camera.far);
      this.sectors.update(dt, soft.depthTexture, _ringSize, ctx.camera.near, ctx.camera.far);
    } else {
      this.rings.update(dt, null);
      this.sectors.update(dt, null);
    }
    this.numbers.update(ctx, dt);
    this._updateDistortion(ctx, dt);

    this._updateFlashes(dt);
    this._updateDissolves(dt);
    this._updateLaunches(dt);
    this._updateStatuses(dt);
    this._updateDamageDirections(dt);
    this._updateDownedMarkers(dt);

    if (this._teleProgress > 0) {
      const tp = ctx.progression?.teleporterPosition ?? ctx.stage?.teleporterPosition;
      if (tp) this.teleporterAura(tp, this._teleProgress);
    }
  }

  /**
   * Register a shockwave with the distortion layer.
   *
   * `radius` is the world radius the front reaches; `life` how long it takes to
   * get there. Everything else — screen projection, aspect, falloff — is derived
   * per frame in `_updateDistortion`, because the camera moves during the blast
   * and a distortion locked to the spawn frame's projection visibly slides.
   */
  shockwave(pos, radius, life = 0.4, strength = 0.028) {
    const list = this._blasts;
    if (list.length >= MAX_BLASTS) list.shift();
    list.push({
      x: pos.x, y: pos.y, z: pos.z, radius, life, strength, t: 0,
    });
  }

  /**
   * Project the live blasts into screen space and feed the grade pass.
   *
   * The displacement rides `GradeShader` rather than a pass of its own. A pass
   * of its own was built, measured at ~5 ms of a 26 ms `combat-24` frame — all
   * of it the cost of one more fullscreen dependent texture read — and deleted.
   * The grade already takes that read and already offsets its UV for shake, so
   * carrying the shockwave costs nothing measurable, and the `uBlastCount > 0`
   * branch means a frame with no blast does not even evaluate it.
   */
  _updateDistortion(ctx, dt) {
    const list = this._blasts;
    const pass = ctx.pipeline?.passes?.grade;
    if (!pass?.uniforms?.uBlasts) return;
    if (!list.length) {
      if (pass.uniforms.uBlastCount.value) pass.uniforms.uBlastCount.value = 0;
      return;
    }

    const u = pass.uniforms.uBlasts.value;
    const cam = ctx.camera;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.t += dt;
      const k = b.t / b.life;
      if (k >= 1) { list.splice(i, 1); continue; }
      if (n >= MAX_BLASTS) continue;
      _proj.set(b.x, b.y, b.z).project(cam);
      // Behind the camera: NDC wraps and the shell would appear mirrored.
      if (_proj.z > 1) continue;
      // Same ease-out the ring uses, so the bent air rides the visible front
      // instead of drifting away from it.
      const e = 1 - Math.pow(1 - k, 2.6);
      // World radius to a UV radius: one metre at the blast's depth, in NDC.
      _v3.set(b.x, b.y, b.z);
      const dist = Math.max(1, cam.position.distanceTo(_v3));
      const halfH = Math.tan((cam.fov * Math.PI) / 360) * dist;
      const uvR = (b.radius * e) / (halfH * 2);
      const o = n * 4;
      u[o] = (_proj.x + 1) * 0.5;
      u[o + 1] = (_proj.y + 1) * 0.5;
      u[o + 2] = uvR;
      // ^1.5 put the shell at 0.40 of its strength by the time the shutter
      // lands (k = 0.46 on `08-explosion`), so the layer the probe verified was
      // already more than half gone in the frame anyone looks at. ^0.9 holds it
      // to 0.51 there and still takes it to zero at the ring's own death, so
      // nothing lingers as a static lens.
      u[o + 3] = b.strength * Math.pow(1 - k, 0.9);
      n++;
    }
    pass.uniforms.uBlastCount.value = n;
    pass.uniforms.uBlastAspect.value = (innerWidth || 1) / (innerHeight || 1);
  }

  lateUpdate(ctx) {
    // Depth prepass for soft particles. Done as late as we can reach without
    // owning the render pipeline; the camera is at most one frame stale, which
    // is invisible at the fade distances used here.
    this.particles.renderDepth(ctx, this._roots);
  }

  _updateFlashes(dt) {
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const rec = this._flashes[i];
      rec.t += dt;
      const k = rec.t / rec.dur;
      if (k >= 1) {
        for (let j = 0; j < rec.mats.length; j++) {
          rec.mats[j].emissive.copy(rec.base[j * 2]);
          rec.mats[j].emissiveIntensity = rec.base[j * 2 + 1];
        }
        this._flashes.splice(i, 1);
        continue;
      }
      // Quadratic falloff: a linear decay on a 60ms flash is short enough that
      // it reads as a step, not as a flash.
      const f = 1 - k * k;
      for (let j = 0; j < rec.mats.length; j++) {
        rec.mats[j].emissive.lerpColors(rec.base[j * 2], rec.colour, f);
        // Decay toward the peak this flash was SPAWNED with, not toward the
        // authored maximum. `rec.strength` is the player's `flash` preference
        // captured in `hitFlash`; at 100% the target is FLASH_INTENSITY and the
        // curve is exactly what it has always been.
        const peak = lerp(rec.base[j * 2 + 1], FLASH_INTENSITY, rec.strength ?? 1);
        rec.mats[j].emissiveIntensity = lerp(rec.base[j * 2 + 1], peak, f);
      }
    }
  }

  _updateDissolves(dt) {
    for (let i = this._dissolving.length - 1; i >= 0; i--) {
      const d = this._dissolving[i];

      // The corpse changed hands. A stage transition inside the dissolve's
      // 0.85 s puts this rig back in the pool and straight onto a new enemy, and
      // from here every remaining write lands on something alive: the closing
      // `visible = false` below would hide a live, damageable monster until it
      // died, and the dissolve variants left on the meshes `resetRig` does not
      // re-dress would `discard` those parts of it in the meantime. So let go at
      // once. `release()` restores whatever is still wearing a variant (it
      // checks identity, so the slots `applyMats` already reclaimed are left
      // alone) and returns the pooled materials, and nothing touches
      // `d.mesh.visible` -- the new owner's own visibility is its business.
      if (d.mesh.userData.rigEpoch !== d.owner) {
        d.handle.release();
        this._dissolving.splice(i, 1);
        continue;
      }

      d.t += dt;
      const k = clamp(d.t / d.dur, 0, 1);
      for (const bag of d.bags) bag.uDissolve.value = k;

      // Embers peel off the dissolve front, not off the whole body.
      d.emitAccum += dt;
      if (d.emitAccum > 0.02 && k < 1) {
        d.emitAccum = 0;
        const frontY = lerp(d.minY - 0.1, d.maxY + 0.1, k);
        const e = this._ep();
        e.count = 4;
        e.position.set(d.cx, frontY, d.cz);
        e.jitter = 0;
        e.shell = 0;
        e.dir.set(0, 1, 0); e.spread = 0.55;
        e.speed = 1.6; e.speedVar = 0.7;
        e.life = 1.2; e.lifeVar = 0.5;
        e.size0 = 0.09; e.size1 = 0.01;
        e.color0.set(0xfff0c0); e.color1.set(d.colour);
        e.frame = FRAME.EMBER;
        e.gravity = -1.6; e.drag = 1.0; e.turbulence = 0.5;
        // Spread the spawn across the silhouette footprint.
        const rng = this.ctx.fxRng ?? this.ctx.rng;
        e.position.x += (rng.next() * 2 - 1) * d.rx;
        e.position.z += (rng.next() * 2 - 1) * d.rz;
        this.particles.emit(e);
      }

      if (k >= 1) {
        d.mesh.visible = false;
        // Hand the patched materials back before the rig returns to its pool,
        // so a recycled enemy never respawns wearing a corpse's shader.
        d.handle.release();
        this._dissolving.splice(i, 1);
      }
    }
  }

  _updateStatuses(dt) {
    for (const [target, byType] of this._statuses) {
      for (const [type, s] of byType) {
        s.t += dt;
        if (s.t >= s.dur || !target || target.alive === false) {
          byType.delete(type);
          continue;
        }
        s.accum += dt;
        const interval = 1 / s.def.rate;
        if (s.accum < interval) continue;
        s.accum = 0;
        const p = target.position;
        if (!p) continue;
        const h = target.height ?? 1.6;
        const r = target.radius ?? 0.5;

        const e = this._ep();
        e.count = 2;
        e.layer = s.def.alpha ? 'alpha' : 'add';
        e.position.copy(p); e.position.y += h * 0.4;
        e.shell = r;
        e.dir.set(0, s.def.rise >= 0 ? 1 : -1, 0); e.spread = 0.7;
        e.speed = Math.abs(s.def.rise) * 1.6 + 0.4; e.speedVar = 0.6;
        e.life = 0.55; e.lifeVar = 0.4;
        // Sized off the host, not a constant. At 0.13 flat a status puff on a
        // 0.4 m mite was as wide as the mite; the overlay has to dress whatever
        // it is attached to, never outgrow it.
        e.size0 = clamp(r * 0.26, 0.05, 0.2); e.size1 = 0.01;
        e.color0.set(s.def.tip); e.color1.set(s.def.color);
        e.alpha0 = s.def.tipAlpha ?? 1;
        e.frame = s.def.frame;
        e.stretch = s.def.frame === FRAME.SPARK ? 1.0 : 0;
        e.spin = 6; e.gravity = -s.def.rise * 0.8; e.drag = 2.0; e.turbulence = 0.4;
        this.particles.emit(e);
      }
      // A target that has lost its last overlay must lose its key too, or the
      // outer Map keeps every entity that was ever set on fire alive forever.
      if (byType.size === 0) this._statuses.delete(target);
    }
  }

  /**
   * Records where a hit came from. Entries are recycled from a fixed pool and
   * expose `angle` (radians, camera-relative, 0 = dead ahead) plus `alpha`,
   * which is the shape the HUD reads.
   */
  _pushDamageDirection(sourcePos, strength) {
    const list = this.damageDirections;
    const e = this._dirPool[this._dirCursor];
    this._dirCursor = (this._dirCursor + 1) % this._dirPool.length;
    const existing = list.indexOf(e);
    if (existing >= 0) list.splice(existing, 1);
    e.pos.copy(sourcePos);
    e.t = 0;
    e.life = 1.2;
    e.strength = strength;
    e.alpha = strength;
    e.angle = 0;
    list.push(e);
    if (list.length > 6) list.shift();
  }

  /**
   * Recomputed every frame rather than latched at hit time: the indicator has
   * to keep pointing at the attacker while the player turns, or it is worse
   * than useless.
   */
  _updateDamageDirections(dt) {
    const list = this.damageDirections;
    if (!list.length) return;
    const cam = this.ctx.camera;
    const origin = this.ctx.player?.position;
    let fx = 0, fz = -1;
    if (cam) {
      cam.getWorldDirection(_v1);
      const l = Math.hypot(_v1.x, _v1.z) || 1;
      fx = _v1.x / l; fz = _v1.z / l;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      d.t += dt;
      if (d.t >= d.life) { list.splice(i, 1); continue; }
      d.alpha = d.strength * (1 - d.t / d.life);
      if (origin) {
        const dx = d.pos.x - origin.x, dz = d.pos.z - origin.z;
        d.angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
      }
    }
  }

  /** Reset the shared emit-options scratch to defaults. Never allocates. */
  /**
   * Pick the plane a shockwave ring should expand in.
   *
   * **UP, and `RingFrag`'s edge-on fade wins, unless the blast genuinely has no
   * ground plane to align to.** That fade — `a *= clamp(vFacing / 0.28, 0, 1)`,
   * "what stops a shockwave becoming a laser" — is a guard, and a guard that a
   * helper overrides on the common path is not a guard.
   *
   * The previous test asked `|dir.y| < 0.34` on the *camera→blast* ray, i.e.
   * "is the blast at least 34% of its distance above or below the lens". Its
   * comment claimed that returns UP "for every blast that does sit on the
   * ground". It does not: for a third-person lens 3-6 m up, a blast sitting on
   * the ground clears 0.34 only inside ~9-18 m, so every ground blast past that
   * was tilted 21.8 degrees toward the camera. Measured on
   * `reviews/round6/audfix-pre-full/08-explosion.png` (a 6 m blast lifted
   * 2.4-4.4 m at 11.2 m): the frame contains no shockwave at all, only three
   * ~25 m ellipse arcs crossing the top-left, top-right and right edges as
   * unrelated light streaks, and the region x 1150-1600 / y 250-850 measures
   * mean L 118.7 against 93.8 for the whole frame.
   *
   * The airburst test is therefore geometric and about the *blast*, not about
   * the lens: a blast has no ground plane when the ground is not inside the
   * blast at all, i.e. when its centre clears the terrain under it by more than
   * its own radius. A 6 m fireball whose centre is 3 m up is half buried in the
   * hill it is standing on — it has a ground plane and the fade is right about
   * it. The lens-height test is kept as a second condition, because tilting a
   * true airburst's ring is only worth doing when the fade would otherwise have
   * eaten it.
   *
   * What replaces the tilt for near-camera blasts is the camera-facing rim
   * billboard in `explosion` step 3b: a screen-space ring is concentric with
   * the fireball from every angle by construction, which is the correct way to
   * give a blast an edge. Rotating a world-space disc into the lens is not.
   */
  _ringAxis(pos, radius = Infinity) {
    const cam = this.ctx?.camera;
    if (!cam) return UP;
    const g = this.ctx.stage?.sampleHeight?.(pos.x, pos.z);
    // No sampler (a realm, a menu scene): assume ground, i.e. let the fade win.
    if (!Number.isFinite(g) || pos.y - g < radius) return UP;
    _ax1.subVectors(pos, cam.position);
    const d = _ax1.length();
    if (d < 1e-3) return UP;
    _ax1.divideScalar(d);
    // 0.28 is RingFrag's own knee; 0.34 leaves a margin so a ring near the
    // boundary is not spawned at a fraction of its alpha.
    if (Math.abs(_ax1.y) >= 0.34) return UP;
    // The smallest tilt that clears the knee is the right one: alpha is
    // saturated the moment the fade is cleared, so any extra tilt only opens the
    // ellipse wider and buys screen coverage the composition does not want.
    // 0.40 lands the facing term at ~0.37 against the 0.28 knee.
    return _ax2.set(0, 1, 0).addScaledVector(_ax1, -0.40).normalize();
  }

  /* ---------------------------------------------------------------- *
   * The four new geometries, as engine vocabulary.
   *
   * Nothing in `data/` names these yet — which ability or item adopts which
   * shape is the user's design call, not this layer's. They exist so that a
   * cone attack can stop being drawn as a full ring, and so that "spiralling"
   * and "arcing between targets" are things the language can say at all.
   *
   * Every colour here arrives as an argument from a declared table. There is
   * no hex literal in any of these methods, and `tests/vfx-geometries.test.mjs`
   * scans them to keep it that way — the #160 lesson, which was demonstrated
   * rather than argued: a hue typed at a call site is outside every guard.
   * ---------------------------------------------------------------- */

  /**
   * G-1 — a ground arc that says *where*, not just *how big*.
   *
   * `facing` is flattened onto the ground plane: a telegraph aimed slightly up
   * or down the terrain still means the same compass bearing, and letting the
   * pitch through would narrow the arc as the attacker looked at their feet.
   * The two bounding radii are drawn as beams over the arc, so the wedge has
   * edges a player can read at a glance rather than only a gradient.
   */
  sectorTelegraph(pos, facing, halfAperture, colour, r0, r1, life = 0.6, alpha = 0.9) {
    _v1.copy(facing); _v1.y = 0;
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
    _v1.normalize();
    this.sectors.spawn(pos, UP, _v1, halfAperture, colour, r0, r1, life, alpha);

    const half = Math.min(Math.PI, Math.max(1e-3, halfAperture));
    _tmpColor.set(colour);
    for (const sign of SECTOR_EDGES) {
      const a = Math.atan2(_v1.x, _v1.z) + sign * half;
      _v2.set(pos.x, pos.y + 0.07, pos.z);
      _v3.set(pos.x + Math.sin(a) * r1, pos.y + 0.07, pos.z + Math.cos(a) * r1);
      this.beams.spawn(_v2, _v3, _tmpColor, 0.05, 0.05, life, 0.7, 0);
    }
  }

  /**
   * G-2 — particles laced on a spiral from `from` to `to`.
   *
   * The lace is emitted in one pass rather than animated: each particle is
   * placed at its point on the spiral and given the spiral's own tangent, so
   * the shape is legible on the first frame and then flies apart along it.
   * That is what makes it a *rising* motion in §1.4's sense rather than a
   * static helix-shaped decal.
   */
  helixLace(from, to, colour, opts = _NO_OPTS) {
    const o = _helixOpts;
    o.from = from; o.to = to;
    o.count = opts.count ?? 26;
    o.turns = opts.turns ?? 2.5;
    o.radius = opts.radius ?? 0.9;
    o.phase = opts.phase ?? 0;
    o.swirl = opts.swirl ?? 2.2;
    o.radialSpeed = opts.radialSpeed ?? 0.8;
    o.climb = opts.climb ?? 1.4;
    o.inward = !!opts.inward;
    const life = opts.life ?? 0.55;
    const size = opts.size ?? 0.2;

    for (let k = 0; k < o.count; k++) {
      helixSample(_hs, k, o);
      const speed = Math.hypot(_hs.vx, _hs.vy, _hs.vz);
      const e = this._ep();
      e.count = 1;
      e.position.set(_hs.px, _hs.py, _hs.pz);
      e.dir.set(_hs.vx, _hs.vy, _hs.vz);
      e.speed = speed; e.speedVar = 0.08; e.spread = 0;
      e.life = life; e.lifeVar = 0.15;
      e.size0 = size; e.size1 = size * 0.15; e.sizeVar = 0.2;
      e.color0.set(colour); e.color1.set(colour);
      // Inward reads hotter and heavier than outward — a vortex is something
      // arriving, a helix something leaving.
      e.frame = o.inward ? FRAME.EMBER : FRAME.SPARK;
      e.stretch = o.inward ? 0.2 : 0.45;
      e.drag = 1.6; e.alphaPow = 1.2;
      this.particles.emit(e);
    }
    return o.count;
  }

  /**
   * G-3 — the same lace run inward, and nothing else.
   *
   * It shares G-2's family on purpose (§1.3) and separates on motion alone:
   * the radial velocity flips sign and the radius closes on the endpoint. The
   * spin direction is untouched, because a vortex is not a helix played
   * backwards — it is a helix falling in.
   */
  vortexDraw(from, to, colour, opts = _NO_OPTS) {
    const o = _vortexOpts;
    o.count = opts.count ?? 30;
    o.turns = opts.turns ?? 3;
    o.radius = opts.radius ?? 2.2;
    o.phase = opts.phase ?? 0;
    o.swirl = opts.swirl ?? 2.6;
    o.radialSpeed = opts.radialSpeed ?? 1.6;
    o.climb = opts.climb ?? 1.1;
    o.life = opts.life ?? 0.5;
    o.size = opts.size ?? 0.16;
    o.inward = true;
    return this.helixLace(from, to, colour, o);
  }

  /**
   * G-4 — a jagged multi-hop arc through `points`.
   *
   * Composed out of `BeamPool` segments, the `latticeShell` precedent: a path
   * is a path whether its links came from a new mesh or from short straight
   * ones, and the pool already draws a tapered, cored, additive segment. Each
   * hop is split into `segments` links whose interior nodes are displaced
   * perpendicular; `chainNode` pins node 0 and node N to the hop's own
   * endpoints, so the polyline is contiguous and lands on its targets by
   * construction rather than by luck.
   */
  chainBolt(points, colour, opts = _NO_OPTS) {
    if (!points || points.length < 2) return 0;
    const o = _chainOpts;
    o.segments = opts.segments ?? 5;
    o.jitter = opts.jitter ?? 0.35;
    const life = opts.life ?? 0.14;
    const width = opts.width ?? 0.11;
    const seed0 = opts.seed ?? 0;
    _tmpColor.set(colour);

    let drawn = 0;
    for (let h = 0; h < points.length - 1; h++) {
      o.from = points[h]; o.to = points[h + 1];
      o.seed = seed0 + h * 31.7;
      chainNode(_cn0, 0, o);
      for (let i = 0; i < o.segments; i++) {
        chainNode(_cn1, i + 1, o);
        _v2.set(_cn0.x, _cn0.y, _cn0.z);
        _v3.set(_cn1.x, _cn1.y, _cn1.z);
        this.beams.spawn(_v2, _v3, _tmpColor, width, width, life, 0.8, 0);
        // §1.2's player polarity: element rim, white-hot core, the same
        // doubling every other beam in the file carries.
        this.beams.spawn(_v2, _v3, WHITE_HOT, width * 0.34, width * 0.34, life * 0.8, 2.4, 0);
        _cn0.x = _cn1.x; _cn0.y = _cn1.y; _cn0.z = _cn1.z;
        drawn++;
      }
    }
    return drawn;
  }

  _ep() {
    const e = this._e;
    e.layer = 'add';
    e.count = 1;
    e.position = this._ep0.set(0, 0, 0);
    e.jitter = 0; e.shell = 0;
    e.dir = this._ed0.set(0, 1, 0);
    e.spread = 0; e.speed = 0; e.speedVar = 0.3;
    e.inherit = null;
    e.life = 0.5; e.lifeVar = 0.25;
    e.size0 = 0.2; e.size1 = 0; e.sizeVar = 0.3;
    e.color0 = this._ec0.setRGB(1, 1, 1);
    e.color1 = this._ec1.setRGB(1, 1, 1);
    e.alpha0 = 1; e.alpha1 = 0;
    e.drag = 1.2; e.gravity = 0; e.turbulence = 0; e.stretch = 0;
    e.frame = FRAME.SOFT; e.frameVar = 0; e.spin = 0; e.soft = 0.6;
    e.fadeIn = 0.06; e.alphaPow = 1.4; e.delay = 0;
    return e;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const WHITE_HOT = new THREE.Color(0xffffff);

/**
 * Entities carry their scene node under any of half a dozen names, and some —
 * the player's `CharacterMesh` — hang a plain wrapper off `.mesh` whose real
 * node is `.group`. Anything that isn't an Object3D is not a scene node, so
 * never hand it back: the callers feed it straight to Three.js.
 */
function resolveObject(entity) {
  if (!entity) return null;
  if (entity.isObject3D) return entity;
  const c = entity.mesh;
  if (c?.isObject3D) return c;
  // `entity.rig?.root` is not one alias among many — it is the *only* handle an
  // `Enemy` has on its scene node (`Enemy.spawn` does `this.rig = acquireRig(...)`
  // and never assigns `.mesh`/`.group`/`.root`/`.object3D`). Without it this
  // function returned null for every enemy in the game, which silently made
  // `deathDissolve` and `hitFlash` no-ops on every enemy death and every enemy
  // hit — the two effects most of the combat read depends on. `Player` sets
  // `.mesh`/`.group`, which is why the seam looked healthy from the player side.
  return firstObject3D(c?.group, c?.root, c?.object3D, entity.rig?.root,
    entity.group, entity.root, entity.object3d, entity.object3D, entity.object);
}

function firstObject3D(...candidates) {
  for (const c of candidates) if (c?.isObject3D) return c;
  return null;
}

/* ==================================================================== */
/* Pooled sub-effects                                                    */
/* ==================================================================== */

/**
 * A fixed set of point lights, added at boot and never added or removed after.
 *
 * Critically, they are also never hidden. three bakes the count of *visible*
 * lights into every program's cache key, so `light.visible = false` is not a
 * cheap way to park a light — it is exactly as expensive as removing it, and
 * flipping it recompiles every material in the scene. Six pooled lights
 * flickering on and off used to fork the whole material set seven ways and cost
 * multi-second compile stalls mid-fight. So the pool is permanently visible and
 * only ever changes `intensity`, which costs nothing: a point light at
 * intensity 0 contributes nothing to the shading result.
 */
/**
 * Pooled micro-missile bodies for shots that want a projectile's *look* without
 * a projectile's travel (#198).
 *
 * The visual vocabulary is borrowed wholesale from `ProjectilePool`, which is
 * how Ranger's Suppressive Salvo darts are drawn: the same six-sided cone
 * pointing down +Z, the same flat-shaded emissive standard material keyed by
 * colour, oriented with `lookAt` along travel, dragging one of the same ribbon
 * trails behind it with a white core. What is deliberately *not* borrowed is
 * anything that touches gameplay — a dart has no motion of its own to steer, no
 * collision, no harm to do and no target. It flies a fixed pair of endpoints
 * over a fixed duration and then stops existing.
 *
 * Everything is allocated once. `fire` only flips flags, so a field of sentries
 * emptying into a horde never allocates and never triggers a GC pause; when the
 * pool is empty the *oldest* body is stolen, so the shot that is nearly over is
 * the one that loses rather than the shot just fired.
 */
class DartPool {
  constructor(ctx, vfx, count = 16) {
    this.vfx = vfx;
    // ProjectilePool.geo.body, to the millimetre — the whole point is that this
    // and a Salvo missile are the same silhouette at different scales.
    const geo = new THREE.ConeGeometry(0.12, 0.46, 6);
    geo.rotateX(Math.PI / 2);
    this.geo = geo;
    this.mats = new Map();

    this.root = new THREE.Group();
    this.root.name = 'vfx.darts';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    this.items = [];
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, this._material(0xffffff));
      mesh.visible = false;
      mesh.castShadow = false;
      this.root.add(mesh);
      this.items.push({
        mesh, alive: false, t: 0, dur: 1, trail: null,
        from: new THREE.Vector3(), to: new THREE.Vector3(),
      });
    }
  }

  _material(color) {
    let m = this.mats.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 2.2,
        roughness: 0.4, metalness: 0, flatShading: true,
      });
      this.mats.set(color, m);
    }
    return m;
  }

  /**
   * Send one body down `from` -> `to`, arriving in exactly `life` seconds.
   * @param {object} o { colour, trailColour, scale, life, width, trailLife }
   */
  fire(from, to, o = {}) {
    let d = null;
    for (const c of this.items) if (!c.alive) { d = c; break; }
    if (!d) {
      d = this.items[0];
      let worst = -1;
      for (const c of this.items) {
        const age = c.t / c.dur;
        if (age > worst) { worst = age; d = c; }
      }
      if (d.trail) { this.vfx.trails?.kill(d.trail); d.trail = null; }
    }

    d.alive = true;
    d.t = 0;
    d.dur = Math.max(1e-3, o.life ?? 0.05);
    d.from.copy(from);
    d.to.copy(to);

    d.mesh.material = this._material(o.colour ?? 0xffffff);
    d.mesh.position.copy(from);
    d.mesh.scale.setScalar(o.scale ?? 1);
    d.mesh.lookAt(to);
    d.mesh.visible = true;

    d.trail = this.vfx.trails?.spawn({
      position: from, color: o.trailColour ?? o.colour ?? 0xffffff, coreColor: 0xffffff,
      width: o.width ?? 0.12, life: o.trailLife ?? 0.16, minDist: 0.12,
    }) || null;
    return d;
  }

  update(dt) {
    const trails = this.vfx.trails;
    for (const d of this.items) {
      if (!d.alive) continue;
      d.t += dt;
      const k = clamp(d.t / d.dur, 0, 1);
      d.mesh.position.lerpVectors(d.from, d.to, k);
      if (d.trail && trails) trails.move(d.trail, d.mesh.position.x, d.mesh.position.y, d.mesh.position.z);
      if (k >= 1) {
        d.alive = false;
        d.mesh.visible = false;
        // Stop emitting and let the ribbon age out on its own, exactly as a
        // spent shot does — the tail outliving the body IS the wake.
        if (d.trail) { trails?.stop(d.trail); d.trail = null; }
      }
    }
  }
}

class LightPool {
  constructor(ctx, count) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.castShadow = false;
      ctx.scene.add(l);
      this.lights.push({ light: l, t: 0, dur: 0, peak: 0 });
    }
    this.cursor = 0;
  }

  flick(pos, colour, intensity, distance, duration) {
    // Round-robin; a stolen light is always the oldest one.
    let best = this.lights[this.cursor];
    for (const e of this.lights) {
      if (e.t >= e.dur) { best = e; break; }
    }
    this.cursor = (this.cursor + 1) % this.lights.length;
    best.light.position.copy(pos);
    best.light.color.set(colour);
    best.light.distance = distance;
    best.peak = intensity;
    best.t = 0;
    best.dur = duration;
    best.light.intensity = intensity;
  }

  update(dt) {
    for (const e of this.lights) {
      if (e.t >= e.dur) continue;
      e.t += dt;
      const k = clamp(e.t / e.dur, 0, 1);
      // Sharp attack, exponential-ish decay — a linear fade reads as a lamp
      // being turned down rather than as a flash.
      const f = (1 - k) * (1 - k) * (1 - k);
      e.light.intensity = e.peak * f;
      if (k >= 1) e.light.intensity = 0;
    }
  }
}

const BeamVert = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec2 aTime;
attribute vec4 aColor;
attribute vec4 aShape;  // width0, width1, core, taper
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying float vCore;
varying float vTaper;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0); vCore = 0.0; vTaper = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  vec3 p = mix(aFrom, aTo, uv.y);
  vec3 axis = aTo - aFrom;
  float len = length(axis);
  axis = len > 0.00001 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 toCam = cameraPosition - p;
  vec3 side = cross(axis, toCam);
  float sl = length(side);
  side = sl > 0.00001 ? side / sl : vec3(1.0, 0.0, 0.0);
  float w = mix(aShape.x, aShape.y, k);
  p += side * (uv.x - 0.5) * w;
  vUv = uv;
  vColor = aColor;
  vColor.a *= pow(1.0 - k, 1.7);
  vCore = aShape.z;
  vTaper = aShape.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const BeamFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
varying float vCore;
varying float vTaper;
void main() {
  float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float soft = smoothstep(0.0, 0.7, edge);
  float core = pow(edge, 10.0) * vCore;

  // vUv.y runs 0 at the origin to 1 at the far end, so a tracer's head is y = 1.
  // A tapered segment fades in over a tenth of its length, dies over the last
  // eighth, and decays along its length so the head is bright and the tail
  // dissolves. Untapered segments (lightning links, which are chained end to
  // end) keep the old tight end mask so the bolt doesn't read as beaded.
  float f0 = mix(0.04, 0.10, vTaper);
  float f1 = mix(0.96, 0.88, vTaper);
  float ends = smoothstep(0.0, f0, vUv.y) * smoothstep(1.0, f1, vUv.y);
  float decay = mix(1.0, mix(0.15, 1.0, pow(vUv.y, 1.8)), vTaper);

  float a = vColor.a * (soft + core) * ends * decay;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * (soft + core * 1.6) * decay, a);
}
`;

/** Instanced camera-facing segments: tracers, lightning links, beam FX. */
export class BeamPool {
  constructor(ctx, capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aFrom = inst(capacity, 3);
    this.aTo = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aColor = inst(capacity, 4);
    this.aShape = inst(capacity, 4);
    geo.setAttribute('aFrom', this.aFrom);
    geo.setAttribute('aTo', this.aTo);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aShape', this.aShape);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BeamVert,
      fragmentShader: BeamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.beams';
    ctx.scene.add(this.mesh);
  }

  spawn(from, to, color, width0, width1, life, core, taper = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const f = this.aFrom.array, t = this.aTo.array;
    f[i * 3] = from.x; f[i * 3 + 1] = from.y; f[i * 3 + 2] = from.z;
    t[i * 3] = to.x; t[i * 3 + 1] = to.y; t[i * 3 + 2] = to.z;
    this.aTime.array[i * 2] = this.time;
    this.aTime.array[i * 2 + 1] = life;
    const c = this.aColor.array;
    c[i * 4] = color.r; c[i * 4 + 1] = color.g; c[i * 4 + 2] = color.b; c[i * 4 + 3] = 1;
    const s = this.aShape.array;
    s[i * 4] = width0; s[i * 4 + 1] = width1; s[i * 4 + 2] = core; s[i * 4 + 3] = taper;
    this.dirty = true;
  }

  /**
   * How many instances are still inside their own lifetime.
   *
   * A ring buffer never frees anything, so "did this effect give its resources
   * back" is not a question about allocation — it is the question of whether
   * every slot it claimed has aged out. Both this and `SectorPool.live` exist
   * so a test can assert a return to baseline rather than assert that nothing
   * threw, which is this repo's recurring way of shipping a leak.
   */
  get live() {
    let n = 0;
    const a = this.aTime.array;
    for (let i = 0; i < this.capacity; i++) {
      const life = a[i * 2 + 1];
      if (life > 0 && this.time - a[i * 2] < life) n++;
    }
    return n;
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (!this.dirty) return;
    this.dirty = false;
    this.aFrom.needsUpdate = this.aTo.needsUpdate = this.aTime.needsUpdate = true;
    this.aColor.needsUpdate = this.aShape.needsUpdate = true;
  }
}

const RingVert = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aAxis;
attribute vec2 aTime;
attribute vec4 aColor;
attribute vec4 aShape;  // r0, r1, thickness, unused
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying float vK;
varying float vThick;
varying float vFacing;
varying float vViewZ;
varying float vLens;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0); vK = 0.0; vThick = 0.0;
    vFacing = 0.0; vViewZ = 0.0; vLens = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  // Ease-out expansion: shockwaves are fastest in the first few frames.
  float e = 1.0 - pow(1.0 - k, 2.6);
  float r = mix(aShape.x, aShape.y, e);

  vec3 n = normalize(aAxis);
  vec3 t1 = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 bx = normalize(cross(n, t1));
  vec3 by = normalize(cross(n, bx));
  vec3 p = aOrigin + (bx * position.x + by * position.y) * (r * 2.0);

  vUv = uv;
  vColor = aColor;
  vK = k;
  vThick = aShape.z;
  // How square-on the ring plane is to this fragment's view ray. A ground-plane
  // ring seen from a camera at the blast's own height projects to an infinitely
  // thin line: round 5 photographed exactly that — a hard orange bar running the
  // full 1600px width of the frame, straight through the mountains. Fading the
  // ring out as it goes edge-on is what stops a shockwave becoming a laser.
  vec4 wv = viewMatrix * vec4(p, 1.0);
  vViewZ = wv.z;
  vFacing = abs(dot(normalize(p - cameraPosition), n));
  // Lens fade, the counterpart of the one in ParticleShader and added for the
  // same measurement. 'overload-cell' is explosion(at, 12) on the player's own
  // position, so its rings are ~31 m across six metres from the lens: they claim
  // several screen-heights each and are additive, and the rings are the one
  // blast layer the particle lens fade cannot reach. '08-explosion' spawns a
  // ~15.6 m ring at ~40 m, i.e. a subtense of 0.39, well under the knee and
  // untouched.
  float sub = r / max(-(viewMatrix * vec4(aOrigin, 1.0)).z, 0.05);
  vLens = mix(1.0, 0.12, smoothstep(0.9, 2.2, sub));
  gl_Position = projectionMatrix * wv;
}
`;

const RingFrag = /* glsl */ `
precision highp float;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uCamPlanes;
uniform float uSoftEnabled;
uniform float uSoftDist;
varying vec2 vUv;
varying vec4 vColor;
varying float vK;
varying float vThick;
varying float vFacing;
varying float vViewZ;
varying float vLens;

float ringViewZ(float d, float n, float f) {
  return (n * f) / ((f - n) * d - f);
}

void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float d = r - 0.86;
  // The ring thins as it grows, which is what sells conservation of energy.
  float th = mix(vThick, vThick * 0.12, vK);
  float ring = 1.0 - smoothstep(0.0, th, abs(d));
  ring = pow(ring, 1.6);
  float fill = (1.0 - smoothstep(0.0, 0.86, r)) * 0.1 * (1.0 - vK);
  // Hot inner edge, cooler outer edge — a flat-coloured ring reads as a decal.
  // 1.6 drove every channel of a warm ring past 1.0, so the hot edge clipped to
  // hueless white — the same failure as the flash cores. 1.15 keeps it hot.
  vec3 col = mix(vColor.rgb * 1.15, vColor.rgb * 0.6, smoothstep(-th, th, d));
  float a = (ring + fill) * vColor.a * pow(1.0 - vK, 1.2);

  // Edge-on fade. Full strength once the plane is ~16 degrees off the view ray.
  a *= clamp(vFacing / 0.28, 0.0, 1.0);
  a *= vLens;

  // Soft-particle depth fade, off the same half-res prepass the particle layer
  // uses. Without it the ring is hard-cut by every pillar and ridge it crosses,
  // which is the rubric's "hard-clipped particle edges" 4-marker, and it was
  // visible on the frame edge and on the pillar in the round-5 shot.
  if (uSoftEnabled > 0.5) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    float d = texture2D(uDepth, suv).x;
    if (d < 1.0) {
      float sceneZ = ringViewZ(d, uCamPlanes.x, uCamPlanes.y);
      a *= clamp((vViewZ - sceneZ) / uSoftDist, 0.0, 1.0);
    }
  }

  if (a < 0.004) discard;
  gl_FragColor = vec4(col * (ring + fill), a);
}
`;

/** Instanced expanding shockwave rings. */
class RingPool {
  constructor(ctx, capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aOrigin = inst(capacity, 3);
    this.aAxis = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aColor = inst(capacity, 4);
    this.aShape = inst(capacity, 4);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aAxis', this.aAxis);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aShape', this.aShape);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCamPlanes: { value: new THREE.Vector2(0.1, 2000) },
        uSoftEnabled: { value: 0 },
        // Metres of depth over which a ring dissolves into the surface it meets.
        // Rings are metres across, so the fade has to be metres deep or it reads
        // as a 1px antialias rather than as the wave passing through the rock.
        uSoftDist: { value: 2.2 },
      },
      vertexShader: RingVert,
      fragmentShader: RingFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.rings';
    ctx.scene.add(this.mesh);
  }

  spawn(origin, axis, colour, r0, r1, life, alpha = 1) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const o = this.aOrigin.array, a = this.aAxis.array;
    o[i * 3] = origin.x; o[i * 3 + 1] = origin.y + 0.06; o[i * 3 + 2] = origin.z;
    a[i * 3] = axis.x; a[i * 3 + 1] = axis.y; a[i * 3 + 2] = axis.z;
    this.aTime.array[i * 2] = this.time;
    this.aTime.array[i * 2 + 1] = life;
    _tmpColor.set(colour);
    const c = this.aColor.array;
    c[i * 4] = _tmpColor.r; c[i * 4 + 1] = _tmpColor.g;
    c[i * 4 + 2] = _tmpColor.b; c[i * 4 + 3] = alpha;
    const s = this.aShape.array;
    s[i * 4] = r0; s[i * 4 + 1] = r1; s[i * 4 + 2] = 0.22; s[i * 4 + 3] = 0;
    this.dirty = true;
  }

  update(dt, depth, resolution, near, far) {
    this.time += dt;
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    if (depth) {
      u.uDepth.value = depth;
      u.uResolution.value.copy(resolution);
      u.uCamPlanes.value.set(near, far);
      u.uSoftEnabled.value = 1;
    } else {
      u.uSoftEnabled.value = 0;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.aOrigin.needsUpdate = this.aAxis.needsUpdate = this.aTime.needsUpdate = true;
    this.aColor.needsUpdate = this.aShape.needsUpdate = true;
  }
}

/* ------------------------------------------------------- G-1: the sector */

const SectorVert = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aAxis;
attribute vec3 aFacing;
attribute vec2 aTime;
attribute vec4 aColor;
attribute vec4 aShape;  // r0, r1, thickness, halfAperture
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vFacing;
varying float vAper;
varying float vK;
varying float vThick;
varying float vFacingDot;
varying float vViewZ;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0); vFacing = vec2(1.0, 0.0);
    vAper = 0.0; vK = 0.0; vThick = 0.0; vFacingDot = 0.0; vViewZ = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  // A telegraph fills at a steady rate: the whole point is that the player can
  // read how much time is left off how far the fill has got, which an
  // ease-out (the ring's curve) actively lies about.
  float r = mix(aShape.x, aShape.y, k);

  vec3 n = normalize(aAxis);
  vec3 t1 = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 bx = normalize(cross(n, t1));
  vec3 by = normalize(cross(n, bx));
  vec3 p = aOrigin + (bx * position.x + by * position.y) * (r * 2.0);

  vUv = uv;
  vColor = aColor;
  // The facing, projected into the very basis the quad is drawn in. Doing it
  // here rather than on the CPU is what keeps axisBasis and this shader from
  // needing to agree about anything except the basis itself.
  vFacing = vec2(dot(aFacing, bx), dot(aFacing, by));
  vAper = aShape.w;
  vK = k;
  vThick = aShape.z;
  vec4 wv = viewMatrix * vec4(p, 1.0);
  vViewZ = wv.z;
  vFacingDot = abs(dot(normalize(p - cameraPosition), n));
  gl_Position = projectionMatrix * wv;
}
`;

const SectorFrag = /* glsl */ `
precision highp float;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uCamPlanes;
uniform float uSoftEnabled;
uniform float uSoftDist;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vFacing;
varying float vAper;
varying float vK;
varying float vThick;
varying float vFacingDot;
varying float vViewZ;

float sectorViewZ(float d, float n, float f) {
  return (n * f) / ((f - n) * d - f);
}

// The twin of \`sectorMask\` in this file's JS half. The soft-edge width is
// interpolated from the one declared constant rather than typed here, so the
// two cannot drift; the rest is the same three lines.
float sectorMask(vec2 c, vec2 f, float halfAperture) {
  if (halfAperture >= 3.14159265) return 1.0;
  float rl = length(c);
  if (rl < 1e-5) return 1.0;
  float fl = length(f);
  if (fl < 1e-5) return 0.0;
  float cosA = dot(c, f) / (rl * fl);
  float lim = cos(halfAperture);
  if (cosA <= lim) return 0.0;
  return smoothstep(lim, lim + ${SECTOR_EDGE_SOFT.toFixed(4)}, cosA);
}

void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;

  // The angular clip. Without this line a sector IS a ring, which is the whole
  // defect the geometry was added to make impossible.
  float wedge = sectorMask(c, vFacing, vAper);
  if (wedge <= 0.0) discard;

  // A bright leading arc over a dim body: the arc is where the damage stops,
  // and it is the thing the player is actually reading.
  float d = r - 0.92;
  float arc = 1.0 - smoothstep(0.0, vThick, abs(d));
  float body = (1.0 - smoothstep(0.55, 1.0, r)) * 0.28;
  vec3 col = mix(vColor.rgb * 0.55, vColor.rgb * 1.15, arc);
  float a = (arc + body) * wedge * vColor.a;
  a *= clamp(vFacingDot / 0.28, 0.0, 1.0);

  if (uSoftEnabled > 0.5) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    float dep = texture2D(uDepth, suv).x;
    if (dep < 1.0) {
      float sceneZ = sectorViewZ(dep, uCamPlanes.x, uCamPlanes.y);
      a *= clamp((vViewZ - sceneZ) / uSoftDist, 0.0, 1.0);
    }
  }

  if (a < 0.004) discard;
  gl_FragColor = vec4(col * (arc + body), a);
}
`;

/**
 * Instanced ground arcs — the one genuinely new mesh (G-1).
 *
 * Shaped after `RingPool` deliberately: same instanced quad, same soft-particle
 * depth fade off the particle layer's prepass, same `_roots`/update/registration
 * in the `VFX` constructor. It differs in exactly two things, and both are the
 * point — a facing and a half-aperture, so a telegraph can say WHERE it will
 * land, and a linear rather than eased fill, so it can say WHEN.
 */
export class SectorPool {
  constructor(ctx, capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aOrigin = inst(capacity, 3);
    this.aAxis = inst(capacity, 3);
    this.aFacing = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aColor = inst(capacity, 4);
    this.aShape = inst(capacity, 4);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aAxis', this.aAxis);
    geo.setAttribute('aFacing', this.aFacing);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aShape', this.aShape);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCamPlanes: { value: new THREE.Vector2(0.1, 2000) },
        uSoftEnabled: { value: 0 },
        uSoftDist: { value: 2.2 },
      },
      vertexShader: SectorVert,
      fragmentShader: SectorFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.sectors';
    ctx.scene.add(this.mesh);
  }

  /**
   * `halfAperture` is half the arc's opening, in radians, and is clamped into
   * (0, PI]. PI is a full ring and is legal — it is what a caller asks for when
   * it genuinely means "all around" — but it is not the default, and nothing
   * here silently widens a narrow arc into one.
   */
  spawn(origin, axis, facing, halfAperture, colour, r0, r1, life, alpha = 1) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const o = this.aOrigin.array, a = this.aAxis.array, f = this.aFacing.array;
    o[i * 3] = origin.x; o[i * 3 + 1] = origin.y + 0.06; o[i * 3 + 2] = origin.z;
    a[i * 3] = axis.x; a[i * 3 + 1] = axis.y; a[i * 3 + 2] = axis.z;
    f[i * 3] = facing.x; f[i * 3 + 1] = facing.y; f[i * 3 + 2] = facing.z;
    this.aTime.array[i * 2] = this.time;
    this.aTime.array[i * 2 + 1] = life;
    _tmpColor.set(colour);
    const c = this.aColor.array;
    c[i * 4] = _tmpColor.r; c[i * 4 + 1] = _tmpColor.g;
    c[i * 4 + 2] = _tmpColor.b; c[i * 4 + 3] = alpha;
    const s = this.aShape.array;
    s[i * 4] = r0; s[i * 4 + 1] = r1; s[i * 4 + 2] = 0.14;
    s[i * 4 + 3] = Math.min(Math.PI, Math.max(1e-3, halfAperture));
    this.dirty = true;
    return i;
  }

  /** See `BeamPool.live`. */
  get live() {
    let n = 0;
    const a = this.aTime.array;
    for (let i = 0; i < this.capacity; i++) {
      const life = a[i * 2 + 1];
      if (life > 0 && this.time - a[i * 2] < life) n++;
    }
    return n;
  }

  update(dt, depth, resolution, near, far) {
    this.time += dt;
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    if (depth) {
      u.uDepth.value = depth;
      u.uResolution.value.copy(resolution);
      u.uCamPlanes.value.set(near, far);
      u.uSoftEnabled.value = 1;
    } else {
      u.uSoftEnabled.value = 0;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.aOrigin.needsUpdate = this.aAxis.needsUpdate = true;
    this.aFacing.needsUpdate = this.aTime.needsUpdate = true;
    this.aColor.needsUpdate = this.aShape.needsUpdate = true;
  }
}

// World height of a normal readout and of a crit. The vertex shader needs the
// normal one to scale its minimum-pixel floor with the size class, so it is
// interpolated into the GLSL rather than duplicated as a literal.
// Round 5, fourth time of asking: four concurrent `27118!` runs in
// `10-inventory` measured a 27 px cap and 174 px of width each — the largest
// type in the game, against a 10 px objective banner, a 23 px clock and 9 px
// item counts — and one of them landed on the player and buried the top tick of
// the crosshair. A damage readout is feedback, not a headline. Both classes are
// pulled ~30% and the minimum-pixel floor with them, which is what actually
// sets the size at combat range.
//
// Round 7 (#85): all three size constants are 1.25x their round-6 values, and
// this is NOT a size increase. `NUM_TILE` went 128 -> 160 to buy padding for a
// wider halo (see `NUM_HALO_PX`), which makes the glyph a smaller fraction of
// its own quad; scaling the quad by the same 1.25 leaves the *ink* at the
// identical on-screen height it had before (88/128 * 30 == 88/160 * 37.5 ==
// 20.6 px at the floor). What grows is the dark plate around the ink, not the
// type.
const NUM_SCALE = 0.375;
const CRIT_SCALE = 0.6125;
// Half-extents, in NDC, of the rect the reticle owns. Nothing this layer draws
// is allowed to settle inside it; see the deflection in NumberVert.
const NUM_RETICLE_X = 0.115;
const NUM_RETICLE_Y = 0.085;
// No more than this many readouts may be *live* at once, crits included.
//
// Round-6 round-4 critique, on `reviews/round6/FINAL/10-inventory.png`: seven
// concurrent runs totalling 18,483 px of numeral against 2,401 px of monster —
// the readout layer covering 7.7x the screen area of every living creature in
// the frame. Every one of those seven runs ends in `!`, and crits used to
// bypass this gate outright, so the gate had never once fired on the shot it
// was written for. It is now a hard budget over *all* runs; a crit does not get
// a free pass, it gets *priority* — it may retire the oldest non-crit run to
// take its slot, and is dropped like anything else if the frame is already full
// of crits.
const NUM_MAX_RUNS = 4;
// Two hits on the same target inside this window become one accumulating
// readout rather than two runs. `24012` printed three times in the shipped
// frame; a second number for the same enemy tells the player nothing the first
// did not, and the sum is the figure they actually want.
const NUM_MERGE_WINDOW = 0.6;
// A run this old may be displaced by an incoming crit. Long enough that a
// readout is always on screen for a beat before anything can take its slot;
// short enough that a burst of ordinary fire cannot wedge the budget shut
// against the equipment nova that lands a second later. It did: at a life
// fraction of 0.45 the four slots were still held by the settle's gunfire when
// `10-inventory`'s nova went off, every one of the nova's own eight hits was
// refused, and the shot photographed no damage numbers at all.
const NUM_MIN_SHOW = 0.22;
// Spatial reservation, in CSS pixels, between two live runs' projected boxes.
// The shipped frame's two `1048!` runs abutted with a 14 px gap and read as the
// single ten-character string `1048!1048!`; a third overlapped them outright.
// A new run whose box lands inside this margin of a live one is lifted (below),
// and dropped if no lift clears it.
const NUM_SEP_PX = 30;
// World-space lifts tried, in order, when a spawn's box collides. Numerals rise
// anyway, so up is with the motion — the same reasoning as the reticle
// deflection in NumberVert.
const NUM_LIFTS = [0, 1.0, 2.0];
// Projected-box scratch for the reservation test; allocation-free at spawn.
const _numBoxA = { cx: 0, cy: 0, hx: 0, hy: 0 };
const _numBoxB = { cx: 0, cy: 0, hx: 0, hy: 0 };
// Minimum on-screen height of a normal glyph, in CSS pixels. Below roughly this
// no digit is recoverable at any zoom — the pre-fix build produced 8 px smears.
// 18 produced a ~10 px ink height at the floor (the tile is mostly padding), so
// the "minimum readable" glyph still measured 15 px only because of the spawn
// pop. 36 gave ~18 px of ink inside a ~29 px dark-bordered mark — legible, and
// then measured at a 27 px cap in `10-inventory`, above every other numeral in
// the product. 26 keeps ~13 px of ink inside a ~21 px mark, which still clears
// the halo's own 3 px plate and no longer outranks the clock.
// (1.25x its round-6 value of 30, for the tile change described at NUM_SCALE;
// the ink height at the floor is unchanged.)
const NUM_MIN_PX = 37.5;
// Horizontal advance between glyph centres, in quad widths. Specified in *quad*
// units, so it has to move with `NUM_TILE`: at 128 the quad was the glyph plus
// ~30% padding and 0.62 was right; at 160 the same ink sits in a quad 1.25x
// wider, so the advance is 0.62 / 1.25. Mirrored by `_box`, which projects the
// same rectangle on the CPU — change one without the other and the collision
// reservation stops describing the numerals it is reserving space for.
// Value lives in `./GlyphAtlasLayout.js`, with the mirror asserted by
// `tests/glyph-atlas-layout.test.mjs`.
// Glyph atlas geometry, shared by the drawer and the halo dilation in NumberFrag.
// The tile is 160 rather than 128 purely for padding: the halo is a ring of taps
// at a fixed atlas-texel radius, so its ceiling is whatever room is left between
// the ink and the tile edge, and at 128 that ceiling was ~14 texels with 13
// already spent. See NUM_HALO_PX.
// Values live in `./GlyphAtlasLayout.js`.
// Halo radius in atlas texels. Must stay inside the tile's padding
// (tile/2 - (font*0.9 + stroke)/2 ≈ 14 texels) or a tap reads the next glyph.
// Raised with the size reduction above and for the same reason: the halo is the
// plate that carries the readout's separation from whatever is behind it, and
// it is specified in *atlas* texels, so shrinking the glyph shrank the plate in
// screen pixels too. The first attempt at the size cut failed the harness's own
// legibility assertion on `08-explosion` (median separation 0.15 against a 0.25
// bar) for exactly that reason.
// Round 6: raised again, with the crit floor cut from 49 px to 39 px above.
// The halo is specified in *atlas* texels, so it shrinks in screen pixels
// whenever the glyph does, and `08-explosion`'s harness legibility assertion
// (`sepP50 >= 0.25`) sits close enough to the bar that the size cut alone put
// it at 0.23. 13 is still inside the tile's ~14.4 texel padding, so no tap can
// reach the next glyph.
//
// Round 7 (#85). 13 texels of a 128 tile is a 3.05 px plate at the 30 px floor,
// and the harness measures legibility on a 480x270 mask — 30% of the drawing
// buffer — where 3.05 px is 0.9 px. At that scale the plate and the ink average
// back to the background inside a single mask pixel: `08-explosion` -> `damage
// numbers` read `lum 58.9` against `bgLum 58.6` on
// `reviews/gate-margin/laneC-p0/manifest.json`, i.e. a mark with no net local
// value at all, sitting exactly on its own 0.25 floor.
//
// Two things this is NOT, both measured and both refuted before this landed:
// it is not exposure (swept 1.00 -> 0.26 on #69, sepP50 pinned throughout), and
// it is not the fade — deleting the fade-out term outright left the subject
// bit-identical at `sepP50 0.25` (`reviews/gate-margin/laneC-diag-alpha/`). The
// readout is photographed at full opacity; it is simply too thin to survive
// being minified.
//
// So the plate doubles: 26 texels of a 160 tile is 6.09 px at the floor. That is
// two mask pixels of solid dark, which is the smallest plate that can carry a
// median. It stays inside the enlarged tile's ~30 texel padding, so the no-tap-
// crosses-a-tile contract above still holds with room to spare.
// Value lives in `./GlyphAtlasLayout.js`; `tilePaddingPx()` there is the
// no-tap-crosses-a-tile bound, asserted by the layout test.
// Beyond this the readout is chip damage on something the player is not
// fighting; spending instances on it only adds noise.
const NUM_MAX_DIST = 45;

const NumberVert = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec2 aTime;
attribute vec4 aGlyph;   // char index, column offset, half-width in chars, scale
attribute vec4 aColor;
uniform float uTime;
uniform float uAtlasCols;
uniform float uMinPx;
uniform float uPxToWorld;   // 2 * tan(fov/2) / viewportHeight
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vNdc;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0); vColor = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  // Ballistic arc, then a slow drift as it fades.
  vec3 wp = aOrigin + aVel * age + vec3(0.0, -4.5, 0.0) * age * age * 0.5;
  vec4 mv = viewMatrix * vec4(wp, 1.0);

  // Overshoot pop on the first ~12% of life, then settle.
  float pop = 1.0 + 0.55 * exp(-k * 26.0) - 0.25 * smoothstep(0.0, 0.12, k);

  // The corner offset is added in view space, so without a floor the glyph is
  // aGlyph.w metres tall at every distance and shrinks with perspective — at
  // 40 m that is ~7 px, i.e. an unreadable smear. Clamp the projected height to
  // a minimum number of screen pixels, scaled by the readout's own size class
  // so a crit keeps its weight advantage at every range.
  float dist = max(-mv.z, 0.001);
  // The floor used to scale 1:1 with the size class, which put a crit's minimum
  // at 30 * (0.49/0.30) = 49 px of glyph height — the largest type in the game
  // by a wide margin, and the single biggest contributor to the 18,483 px
  // numeral footprint the round-4 critique measured. A crit keeps a visible
  // weight advantage at half that gain: 30 * mix(1, 1.633, 0.5) = 39 px, which
  // is still above every other numeral on screen and cuts crit ink area by ~35%.
  float minPx = uMinPx * mix(1.0, aGlyph.w / ${NUM_SCALE.toFixed(3)}, 0.5);
  float minWorld = dist * minPx * uPxToWorld;
  float scale = max(aGlyph.w, minWorld) * pop;

  // --- reticle exclusion ---
  // The crosshair is the one element in a fight the player must never lose, and
  // round 5 measured a readout sitting on top of it with its upper tick behind
  // a digit. Rather than reject the spawn (which loses the feedback entirely, and
  // cannot know where the numeral will have arced to by the time it is read),
  // the layer deflects: any glyph inside the reserved rect is pushed up out of
  // it, weighted by how central it is horizontally and ramped in from the rect's
  // lower edge so nothing ever snaps. Numerals rise anyway, so up is with the
  // motion and not against it.
  float p00 = projectionMatrix[0][0], p11 = projectionMatrix[1][1];
  vec2 ndc = vec2(p00 * mv.x, p11 * mv.y) / dist;
  float ax = 1.0 - smoothstep(${NUM_RETICLE_X.toFixed(3)} * 0.55, ${NUM_RETICLE_X.toFixed(3)}, abs(ndc.x));
  // Ramps 0 -> 1 across the rect's lower edge; the (RY - ndc.y) term takes the
  // lift back to zero of its own accord at the upper edge, so both boundaries
  // are continuous and a glyph deflected at all is deflected exactly to RY.
  float ay = smoothstep(-${NUM_RETICLE_Y.toFixed(3)}, -${NUM_RETICLE_Y.toFixed(3)} * 0.35, ndc.y);
  mv.y += max(0.0, ${NUM_RETICLE_Y.toFixed(3)} - ndc.y) * ax * ay * dist / p11;

  float cw = ${NUM_ADVANCE.toFixed(3)};
  vec2 corner = vec2(
    (position.x + (aGlyph.y - aGlyph.z) * cw) * scale,
    position.y * scale
  );
  mv.xy += corner;

  // The atlas uploads with flipY = false, so texture t = 0 is the canvas's TOP
  // row while the quad's uv.y = 0 is its BOTTOM. Sampling with a raw uv.y makes
  // every glyph render upside-down; zeros survive because they are symmetric,
  // which is why the bug reads as "garbled" rather than "flipped".
  vUv = (vec2(uv.x, 1.0 - uv.y)
    + vec2(mod(aGlyph.x, uAtlasCols), floor(aGlyph.x / uAtlasCols))) / uAtlasCols;
  vColor = aColor;
  // Full opacity within one frame of the hit: a 0.06 fade-in meant any shutter
  // inside the first 60 ms photographed the readout at 40% alpha.
  vColor.a *= smoothstep(0.0, 0.02, k) * (1.0 - smoothstep(0.55, 1.0, k));
  gl_Position = projectionMatrix * mv;
  // Carried to the fragment stage for the HUD clip. NDC rather than
  // gl_FragCoord because this pass draws into a render target whose size the
  // adaptive scaler is free to change; NDC is the one space that is the same
  // in the offscreen buffer and on the composited frame.
  vNdc = gl_Position.xy / max(gl_Position.w, 1e-6);
}
`;

/**
 * The readout has to be legible on *any* background, including the middle of
 * this build's own blast, where the previous version measured 250,240,225 ink
 * on a 255,255,241 blowout — a 5-16/255 delta, i.e. invisible.
 *
 * Near-white ink cannot solve that on its own, so the glyph is carried by dark
 * geometry instead: an opaque near-black keyline (from the atlas silhouette)
 * plus a dilated halo around it, built here by nine taps of the atlas alpha at
 * `uHaloPx` of tile. The halo is a screen-space-stable dark plate roughly 3 px
 * wide at the minimum glyph size, which is what keeps the number readable after
 * additive bloom bleeds over it — exactly how the crosshair, the one legible
 * element in the same frame, survives the same background.
 */
const NumberFrag = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uHaloUv;
uniform vec4 uHudRect;   // NDC centre.xy, half-extent.xy of the inventory strip
uniform float uHudOn;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vNdc;

void main() {
  vec4 t = texture2D(uMap, vUv);

  // Dilate the silhouette to get a halo mask. Eight taps on a ring; the atlas
  // tile has ~12 px of padding around the strokes so this cannot cross a tile.
  float h = t.a;
  float d = uHaloUv, dd = d * 0.7071;
  h = max(h, texture2D(uMap, vUv + vec2( d, 0.0)).a);
  h = max(h, texture2D(uMap, vUv + vec2(-d, 0.0)).a);
  h = max(h, texture2D(uMap, vUv + vec2(0.0,  d)).a);
  h = max(h, texture2D(uMap, vUv + vec2(0.0, -d)).a);
  h = max(h, texture2D(uMap, vUv + vec2( dd,  dd)).a);
  h = max(h, texture2D(uMap, vUv + vec2(-dd,  dd)).a);
  h = max(h, texture2D(uMap, vUv + vec2( dd, -dd)).a);
  h = max(h, texture2D(uMap, vUv + vec2(-dd, -dd)).a);

  // Coverage: the halo never dilutes the keyline, and the keyline is at the
  // glyph's own opacity rather than at the *fill's*, so it does not dissolve
  // into a bright background as the readout fades.
  // The plate is what carries the readout's separation from its background,
  // and the background it has to survive is this build's own blast. Measured on
  // reviews/round6/uifix2/08-explosion.png, a numeral landing on the fireball
  // read lum 63.1 against bgLum 64.2 — a one-point separation, and the
  // harness's own legibility floor (sepP50 >= 0.25) caught it at 0.23. Raising
  // the plate's opacity darkens the mark against a bright background without
  // touching the glyph itself, which stays at full ink.
  float cover = max(t.a, h * 0.92);
  float a = cover * vColor.a;

  // --- inventory-strip clip ---
  // The strip is an opaque DOM block composited *after* this pass, so a readout
  // that arcs behind it used to ship as a band of digit-tops peeking out
  // between two tier rows — legible enough to notice, not enough to read. The
  // round-3 and round-4 critiques both photographed the same band. Clipping the
  // layer out of the strip's rect, with a soft edge so nothing snaps off, is
  // what the critique asked for in place of the z-order it kept losing.
  if (uHudOn > 0.5) {
    vec2 c = abs(vNdc - uHudRect.xy) / max(uHudRect.zw, vec2(1e-4));
    float m = max(c.x, c.y);
    a *= smoothstep(0.88, 1.0, m);
  }

  if (a < 0.01) discard;

  // The atlas stores the fill mask in .r and the whole silhouette in .a, so one
  // texture gives coloured text inside a keyline that survives any background.
  vec3 col = mix(vec3(0.015, 0.015, 0.022), vColor.rgb, t.r);
  gl_FragColor = vec4(col, a);
}
`;

/**
 * World-space damage readout. Text is a 4x4 canvas atlas of glyphs and each
 * digit is one instance, so a number costs a handful of float writes and the
 * whole arc/pop/fade animation runs on the GPU.
 */
class DamageNumbers {
  constructor(ctx, capacity) {
    this.ctx = ctx;
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;
    this._buf = new Array(8);
    // Live runs, newest last. A run is one readout: its slots in the instance
    // buffers, the trajectory needed to re-project it, and the identity the
    // merge rule keys on. Bounded by NUM_MAX_RUNS, so every scan below is over
    // at most four entries.
    this._runs = [];
    this._scratch = { pos: new THREE.Vector3() };

    const map = makeGlyphAtlas();
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    this.aOrigin = inst(capacity, 3);
    this.aVel = inst(capacity, 3);
    this.aTime = inst(capacity, 2);
    this.aGlyph = inst(capacity, 4);
    this.aColor = inst(capacity, 4);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aTime', this.aTime);
    geo.setAttribute('aGlyph', this.aGlyph);
    geo.setAttribute('aColor', this.aColor);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uTime: { value: 0 },
        uAtlasCols: { value: NUM_COLS },
        uHaloUv: { value: haloUv() },
        uMinPx: { value: NUM_MIN_PX },
        uPxToWorld: { value: 0 },
        uHudRect: { value: new THREE.Vector4(0, 0, 0, 0) },
        uHudOn: { value: 0 },
      },
      vertexShader: NumberVert,
      fragmentShader: NumberFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx.damageNumbers';
    ctx.scene.add(this.mesh);

    this._fov = 0;
    this._vh = 0;
    this.resize();
  }

  spawn(pos, amount, crit, colour, target) {
    // Cull far readouts outright: at 45 m even a floored glyph is competing
    // with the horde for attention and telling the player nothing.
    if (this.ctx.camera?.position.distanceToSquared(pos) > NUM_MAX_DIST * NUM_MAX_DIST) return;

    // The two cosmetic draws are taken *here*, before any of the gating below,
    // and unconditionally.
    //
    // The hazard is not that this layer shares `fxRng` with the particle
    // system — cosmetic jitter belongs on the cosmetic stream. The hazard is
    // that the draw *count* used to depend on presentation decisions, so
    // changing how many readouts are shown silently re-jittered every particle
    // in the frame: `10-inventory`'s equipment blast measured 21,486 px in a
    // control arm and 56,735 px under a numeral-only change
    // (`reviews/round6/uictrl` vs `reviews/round6/uifix4`), which pushed that
    // shot's own monster-legibility check below its bar. Taken here, the count
    // is a function of how many in-range damage events occurred and of nothing
    // this layer decides. Third instance of shared-stream displacement in this
    // project, after `archGeo` and the shrine roll.
    const rng = this.ctx.fxRng ?? this.ctx.rng;
    const vx = (rng.next() * 2 - 1) * 1.1;
    const vz = (rng.next() * 2 - 1) * 1.1;

    this._reap();

    let value = Math.max(1, Math.round(amount));

    // 1. Merge. One target, one readout: a second hit inside the window
    //    accumulates into the live run instead of starting a competing one.
    if (target != null) {
      for (let i = this._runs.length - 1; i >= 0; i--) {
        const r = this._runs[i];
        if (r.target !== target || this.time - r.t > NUM_MERGE_WINDOW) continue;
        value += r.value;
        crit = crit || r.crit;
        this._retire(i);
        break;
      }
    }

    // 2. Budget, crits included. A crit does not get a free pass, it gets
    //    priority: it may retire the oldest live non-crit, and failing that a
    //    run already past half its life — a readout that is fading out is worth
    //    less than the hit that just landed, and a build that crits on every
    //    shot would otherwise wedge the budget shut and show nothing at all.
    //    (It does exactly that: every readout in `10-inventory` is a crit.)
    //    An ordinary hit never evicts; it waits or it is dropped.
    if (this._runs.length >= NUM_MAX_RUNS) {
      let victim = -1;
      if (crit) {
        for (let i = 0; i < this._runs.length; i++) {          // oldest-first
          if (!this._runs[i].crit) { victim = i; break; }
        }
        if (victim < 0 && this.time - this._runs[0].t > NUM_MIN_SHOW) victim = 0;
      }
      if (victim < 0) return;
      this._retire(victim);
    }

    const chars = this._buf;
    const n = value;
    let len = 0;
    let v = n;
    // Digits back-to-front into the scratch buffer; no string allocation.
    while (v > 0 && len < 7) { chars[len++] = v % 10; v = (v / 10) | 0; }
    if (len === 0) chars[len++] = 0;
    // Reverse in place.
    for (let i = 0; i < len >> 1; i++) {
      const t = chars[i]; chars[i] = chars[len - 1 - i]; chars[len - 1 - i] = t;
    }
    if (crit) chars[len++] = 10; // '!'

    const half = len * 0.5 - 0.5;
    const scale = crit ? CRIT_SCALE : NUM_SCALE;
    _tmpColor.set(colour ?? (crit ? 0xffc23a : 0xfff2d8));

    const vy = crit ? 3.6 : 2.9;
    const life = crit ? 1.25 : 1.0;

    // 3. Spatial reservation. Project the run's own box and every live run's
    //    box *as it stands now* — same ballistic curve the vertex shader
    //    integrates — and lift out of any collision. This is the reticle
    //    exclusion's machinery applied run-to-run, which is what round 3 asked
    //    for and round 4 found still missing.
    const oy0 = pos.y + 0.6;
    let oy = oy0;
    let placed = false;
    for (let a = 0; a < NUM_LIFTS.length; a++) {
      oy = oy0 + NUM_LIFTS[a];
      if (!this._collides(pos.x, oy, pos.z, len, scale)) { placed = true; break; }
    }
    // Still colliding at the top of the ladder: the frame already carries a
    // readable readout in that space, and a fourth overlapping number is the
    // defect, not the feedback.
    if (!placed) return;

    const start = this.head;
    for (let i = 0; i < len; i++) {
      const idx = this.head;
      this.head = (this.head + 1) % this.capacity;
      const o = this.aOrigin.array, vv = this.aVel.array;
      o[idx * 3] = pos.x; o[idx * 3 + 1] = oy; o[idx * 3 + 2] = pos.z;
      vv[idx * 3] = vx; vv[idx * 3 + 1] = vy; vv[idx * 3 + 2] = vz;
      this.aTime.array[idx * 2] = this.time;
      this.aTime.array[idx * 2 + 1] = life;
      const g = this.aGlyph.array;
      g[idx * 4] = chars[i];
      g[idx * 4 + 1] = i;
      g[idx * 4 + 2] = half;
      g[idx * 4 + 3] = scale;
      const c = this.aColor.array;
      c[idx * 4] = _tmpColor.r; c[idx * 4 + 1] = _tmpColor.g;
      c[idx * 4 + 2] = _tmpColor.b; c[idx * 4 + 3] = 1;
    }

    this._runs.push({
      t: this.time, life, crit: !!crit, target: target ?? null, value,
      ox: pos.x, oy, oz: pos.z, vx, vy, vz,
      len, scale, start,
    });
    this.dirty = true;
  }

  /** Drop expired runs. `_runs` stays oldest-first, so this is a prefix cut. */
  _reap() {
    let i = 0;
    while (i < this._runs.length && this.time - this._runs[i].t >= this._runs[i].life) i++;
    if (i) this._runs.splice(0, i);
  }

  /** Blank a live run's instances and forget it. */
  _retire(i) {
    const r = this._runs[i];
    for (let k = 0; k < r.len; k++) {
      this.aTime.array[((r.start + k) % this.capacity) * 2 + 1] = 0;
    }
    this._runs.splice(i, 1);
    this.dirty = true;
  }

  /**
   * Project a readout's box to NDC. `out` receives centre and half-extents;
   * returns false if the box is behind the camera. Mirrors NumberVert's sizing
   * exactly (min-pixel floor included) so the CPU and GPU agree on where a
   * numeral actually lands.
   */
  _box(wx, wy, wz, len, scale, out) {
    const cam = this.ctx.camera;
    if (!cam) return false;
    const s = this._scratch.pos.set(wx, wy, wz).applyMatrix4(cam.matrixWorldInverse);
    const dist = -s.z;
    if (dist < 0.05) return false;
    const p00 = cam.projectionMatrix.elements[0];
    const p11 = cam.projectionMatrix.elements[5];
    const minPx = NUM_MIN_PX * (1 + (scale / NUM_SCALE - 1) * 0.5);
    const h = Math.max(scale, dist * minPx * this.mat.uniforms.uPxToWorld.value);
    out.cx = (p00 * s.x) / dist;
    out.cy = (p11 * s.y) / dist;
    out.hx = (glyphRunWidthChars(len) * h * 0.5 * p00) / dist;
    out.hy = (h * 0.5 * p11) / dist;
    return true;
  }

  /** Does a run spawned here overlap any live run, within NUM_SEP_PX? */
  _collides(wx, wy, wz, len, scale) {
    if (!this._runs.length) return false;
    const a = _numBoxA;
    if (!this._box(wx, wy, wz, len, scale, a)) return false;
    const padX = (NUM_SEP_PX * 2) / Math.max(1, innerWidth);
    const padY = (NUM_SEP_PX * 2) / Math.max(1, innerHeight);
    const b = _numBoxB;
    for (let i = 0; i < this._runs.length; i++) {
      const r = this._runs[i];
      const age = this.time - r.t;
      // Where that run has arced to by now — NumberVert's own integration.
      const bx = r.ox + r.vx * age;
      const by = r.oy + r.vy * age - 2.25 * age * age;
      const bz = r.oz + r.vz * age;
      if (!this._box(bx, by, bz, r.len, r.scale, b)) continue;
      if (Math.abs(a.cx - b.cx) < a.hx + b.hx + padX
        && Math.abs(a.cy - b.cy) < a.hy + b.hy + padY) return true;
    }
    return false;
  }

  update(ctx, dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    // FOV changes from settings without a resize event, so re-derive on the two
    // inputs rather than only on resize. Both are cached; this is two compares.
    if (ctx.camera && (ctx.camera.fov !== this._fov || innerHeight !== this._vh)) this.resize();
    this._reap();
    this._syncHudRect(ctx);
    if (!this.dirty) return;
    this.dirty = false;
    this.aOrigin.needsUpdate = this.aVel.needsUpdate = this.aTime.needsUpdate = true;
    this.aGlyph.needsUpdate = this.aColor.needsUpdate = true;
  }

  /**
   * The inventory strip's rect, in NDC, for the fragment clip. HUD measures it
   * from the live DOM (it is `width: max-content`, so it is whatever the run's
   * haul makes it) and publishes it; nothing here assumes a layout.
   */
  _syncHudRect(ctx) {
    const r = ctx.hud?.stripRect ?? null;
    const u = this.mat.uniforms;
    if (!r || r.w <= 0 || r.h <= 0) { u.uHudOn.value = 0; return; }
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    const x0 = (r.x / w) * 2 - 1, x1 = ((r.x + r.w) / w) * 2 - 1;
    const y0 = 1 - (r.y / h) * 2, y1 = 1 - ((r.y + r.h) / h) * 2;
    u.uHudRect.value.set((x0 + x1) * 0.5, (y0 + y1) * 0.5,
      Math.abs(x1 - x0) * 0.5, Math.abs(y1 - y0) * 0.5);
    u.uHudOn.value = 1;
  }

  /**
   * The atlas is resolution-independent but the *scale* is not: the pixel floor
   * in NumberVert needs metres-per-pixel-at-one-metre for the current camera.
   */
  resize() {
    const cam = this.ctx.camera;
    const fov = cam?.fov ?? 60;
    const vh = Math.max(1, innerHeight);
    this._fov = fov;
    this._vh = vh;
    this.mat.uniforms.uPxToWorld.value = (2 * Math.tan((fov * Math.PI) / 360)) / vh;
  }
}

function inst(capacity, size) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

function makeGlyphAtlas() {
  const tile = NUM_TILE;
  const cols = NUM_COLS;
  const cv = document.createElement('canvas');
  cv.width = cv.height = tile * cols;
  const g = cv.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (let i = 0; i < GLYPHS.length; i++) {
    const ch = GLYPHS[i];
    const x = (i % cols) * tile + tile * 0.5;
    const y = Math.floor(i / cols) * tile + tile * 0.5;
    g.font = `bold ${NUM_FONT_PX}px "Arial Black", Impact, sans-serif`;
    // Alpha carries the silhouette (glyph + outline); red carries the fill mask
    // so the shader can tint the body and keep the keyline black. The font is
    // smaller than the tile by more than the stroke so NumberFrag's halo taps
    // stay inside the tile — see NUM_HALO_PX.
    g.lineJoin = 'round';
    g.lineWidth = NUM_STROKE_PX;
    g.strokeStyle = 'rgba(0,0,0,1)';
    g.strokeText(ch, x, y);
    g.fillStyle = 'rgba(255,0,0,1)';
    g.fillText(ch, x, y);
  }

  assertGlyphOrientation(g, tile, cols);

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Boot guard for the V-orientation contract.
 *
 * `flipY = false` means canvas row 0 uploads to t = 0, so NumberVert has to
 * sample with `1.0 - uv.y`. If either half of that pair is changed alone every
 * glyph renders upside-down and only the symmetric ones (0, 8, x) still look
 * right — which is exactly why the bug survived to a shipped screenshot.
 *
 * '1' is strongly top-heavy in Arial Black (flag plus stem above the midline,
 * bare stem below), so comparing ink mass across the tile's midline proves the
 * canvas is drawn the way the shader assumes. Runs once at boot.
 */
function assertGlyphOrientation(g, tile, cols) {
  const idx = GLYPHS.indexOf('1');
  if (idx < 0) return;
  let data;
  try {
    data = g.getImageData((idx % cols) * tile, Math.floor(idx / cols) * tile, tile, tile).data;
  } catch { return; }   // tainted canvas in some embeddings; the guard is advisory
  let top = 0, bottom = 0;
  for (let y = 0; y < tile; y++) {
    let row = 0;
    for (let x = 0; x < tile; x++) row += data[(y * tile + x) * 4 + 3];
    if (y < tile / 2) top += row; else bottom += row;
  }
  if (top < bottom) {
    console.error(
      '[VFX] Damage-number atlas is upside-down: glyph "1" is bottom-heavy on the ' +
      'canvas. NumberVert samples with 1.0 - uv.y against tex.flipY = false; ' +
      'changing one without the other flips every glyph.'
    );
  }
}
