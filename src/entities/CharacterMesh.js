import * as THREE from 'three';
import { clamp, lerp } from '../core/MathUtil.js';

/**
 * Procedural survivor: a bone-like Group hierarchy built from primitives plus
 * an animator that drives it. No skinning, no external assets — every joint is
 * an Object3D pivot and every pose is written into `rotation`/`position`.
 *
 * Layout (model forward is +Z, feet at y=0):
 *   root > rig > pelvis > spine > chest > { neck>head, shoulderL/R > elbow > hand, coat }
 *                       > hipL/R > knee > foot
 *
 * The animator is a set of layers evaluated in order, each overwriting or
 * adding onto the previous:
 *   1. base pose      (rest angles)
 *   2. locomotion     (sine cycle, amplitude/frequency from horizontal speed)
 *   3. airborne       (tuck on rise, reach on fall)
 *   4. dash pose
 *   5. upper-body aim override (chest/arms decoupled from legs)
 *   6. additive recoil
 * State transitions run through damped springs so nothing ever hard-cuts.
 */

// Critically-damped-ish spring. `freq` is roughly the settle rate in rad/s;
// higher = snappier. Stepping is clamped so a long frame can't blow it up.
class Spring {
  constructor(value = 0, freq = 14, zeta = 1) {
    this.value = value; this.vel = 0; this.freq = freq; this.zeta = zeta;
  }
  step(target, dt) {
    const w = this.freq;
    let remaining = dt;
    while (remaining > 0) {
      const t = Math.min(remaining, 1 / 90);
      remaining -= t;
      this.vel += (w * w * (target - this.value) - 2 * this.zeta * w * this.vel) * t;
      this.value += this.vel * t;
    }
    return this.value;
  }
  set(v) { this.value = v; this.vel = 0; }
}

// The dark half of the value break is a *dark colour*, not a hole. Measured on
// `03-thirdperson`, the old shell (coat 0x22303f, cloth 0x121a24) rendered at
// luminance 20-64 against terrain measuring 12-63 — the character sat exactly
// inside the range of the cliff behind it and a border flood merged the two.
// The shell is lifted here far enough to clear the ground it stands on in every
// biome while staying unambiguously the dark half of the model.
const COL = {
  coat: 0x38536d,      // steel navy shell — the dark half of the value break
  coatDark: 0x23303f,  // cloth / underlayer, the deepest value on the rig
  // Cool steel, deliberately pushed away from Anvil's warm bone: the two rigs
  // used to average (124,94,98) and (129,99,84) on their plates, i.e. the same
  // warm mid-grey, so they did not separate on value OR hue with the trim out
  // of frame.
  plate: 0xd9dfe8,     // light armour — the light half. Carries the read.
  plateMid: 0x76808a,  // secondary plate, sits between the two
  // The cape is the largest surface the gameplay camera sees, so it must be the
  // MID value, not the light one — the helmet owns the light end. Pale cloth
  // next to a pale helm gave the character no head in the outline.
  cloak: 0x5a646c,
  accent: 0xff7a3d,
  skinDark: 0x39404b,
  metal: 0x8d97a3,
  // Not near-black: at 0.8 metalness with no env map this rendered at 1/255,
  // i.e. darker than the terrain behind it, and the slung weapon punched a hole
  // through the middle of the body instead of drawing a line across it.
  gunmetal: 0x3d4753,
  visor: 0x35e0ff,
  cell: 0x4de3ff,
};

/**
 * One palette per survivor, all with the same key set so the rig builders can
 * share helper code.
 *
 * Every palette keeps the Ranger's *value structure* — a near-black shell, one
 * light plate that carries the read, one mid tone between them and exactly one
 * saturated accent — because that structure is what makes any of them legible
 * against a stage the character does not control the lighting of. What changes
 * between them is hue and where the light plate sits on the body, which is what
 * makes them tell apart at a glance without ever becoming four recolours: the
 * silhouettes below are separately sculpted, and the colour only confirms what
 * the shape already said.
 */
const PALETTES = {
  ranger: COL,

  // Anvil: rust and bone, hot ember accent. Warm, heavy, low-chroma shell so
  // the ember gauntlet is the only saturated thing on the model.
  anvil: {
    coat: 0x573a28,
    coatDark: 0x2e2118,
    // Bone stopped down to a *bronzed* bone. Ranger's plate is 0xd9dfe8
    // (luma 222), this is luma 165 — the pair now separate by ~57 levels of
    // albedo before a single accent pixel is involved, which is what makes the
    // two readable side by side in a value-only crop.
    plate: 0xb8a179,
    plateMid: 0x7b6750,
    cloak: 0x5e4a38,
    accent: 0xff5a2a,
    skinDark: 0x2f2a2b,
    metal: 0x8a7c6a,
    gunmetal: 0x4a3f38,
    visor: 0xff8a3c,
    cell: 0xffae3c,
    coatLift: 0x3a2a1e,
    cloakLift: 0x3a2c22,
    cellBase: 0x1a1006,
    visorBase: 0x180c04,
    rim: 0xffc39a,
  },

  // Kestrel: indigo and porcelain, violet accent. The coldest and highest-key
  // of the four — a pale hood on a near-black body is the whole read.
  kestrel: {
    coat: 0x413c62,
    coatDark: 0x272338,
    plate: 0xd2d6e4,
    plateMid: 0x7c8296,
    cloak: 0x5a5570,
    accent: 0xc9a4ff,
    skinDark: 0x33313f,
    metal: 0x98a0b4,
    gunmetal: 0x33384a,
    visor: 0xe0c0ff,
    cell: 0xd6b4ff,
    coatLift: 0x2a2540,
    cloakLift: 0x2c2840,
    cellBase: 0x120e1c,
    visorBase: 0x0e0a16,
    rim: 0xbfc8ff,
  },

  // Rook: olive and canvas, acid-green accent. Matches the deployables in
  // Placeables.js on purpose — a field of turrets should read as this
  // survivor's work from across the arena.
  rook: {
    coat: 0x455a48,
    coatDark: 0x273327,
    plate: 0xc8c9b4,
    plateMid: 0x7d8672,
    cloak: 0x5c6b52,
    accent: 0x9dff5a,
    skinDark: 0x343a33,
    metal: 0x8f9a8c,
    gunmetal: 0x3b4740,
    visor: 0x9dff5a,
    cell: 0xbfff7a,
    coatLift: 0x28351f,
    cloakLift: 0x2a3526,
    cellBase: 0x0d1a0a,
    visorBase: 0x0a1408,
    rim: 0xcdeaa8,
    // Rook's green ran at the roster's full emissive gain over a wrap-around
    // visor band and a chest gauge, and the whole upper body bloomed into one
    // value: 3.42% of its silhouette measured above L=200 against Kestrel's
    // 0.75%, which is what turned it into a formless amoeba under threshold.
    // The lamps are small now (see `buildRook`) and they run at half gain, so
    // the plate values under them can read again.
    cellGain: 0.5,
  },

  // Cinder: soot and brass, white-hot accent. The one palette on the roster
  // where the *light plate is the saturated one* — every other rig keeps a
  // desaturated bright value (bone, porcelain, canvas) and hangs one saturated
  // accent off it. Doing it the other way round is what stops a warm survivor
  // beside Anvil reading as a recolour of him: Anvil is a warm shell carrying a
  // cool-ish bone plate, this is a neutral near-black shell carrying a warm
  // metal one, so the two disagree about which part of the body is coloured
  // before they disagree about hue at all.
  cinder: {
    coat: 0x2a2a30,
    coatDark: 0x151519,
    plate: 0xc89a44,
    plateMid: 0x7d6434,
    cloak: 0x4a4a52,
    // White-hot rather than orange. The burners are the hottest thing on the
    // model and they sit directly on brass; an orange lamp on a brass plate is
    // one value, and the whole point of the accent is to be the one thing the
    // plate cannot be mistaken for.
    accent: 0xfff0b0,
    skinDark: 0x2b2926,
    metal: 0x8d8b84,
    gunmetal: 0x3a3833,
    visor: 0xffc61a,
    cell: 0xffd76a,
    coatLift: 0x241f18,
    cloakLift: 0x2a2620,
    cellBase: 0x1a1206,
    visorBase: 0x140d02,
    rim: 0xffd9a0,
    // Same problem Rook had, for the opposite reason: the burner bank is six
    // lamps in a 0.4 m strip across the chest and shoulders, and at full gain
    // they merged into one blown patch that took the brass plate's value with
    // them. Two thirds keeps each lamp a discrete hot dot.
    cellGain: 0.66,
  },
};

/**
 * How hard the cloth layer of the animator drives each rig.
 *
 * The Ranger's coat and cape are loose fabric and want the full swing. Anvil's
 * rear plates and Rook's equipment rack are bolted to a body and would read as
 * broken if they flapped, so their gains are cut rather than their pivots being
 * removed — that keeps every rig animating through the same code path.
 */
const CLOTH_GAIN = {
  ranger: { coat: 1, cape: 1 },
  anvil: { coat: 0.45, cape: 0.3 },
  kestrel: { coat: 1.25, cape: 1.35 },
  rook: { coat: 0.35, cape: 0.12 },
  // Cinder wears no coat at all — the `coat` pivot carries a pair of hanging
  // hose loops — and the `cape` pivot is a bolted tank harness. The hoses want
  // to swing more than fabric does (they are heavy and they hang free), the
  // tanks want to swing less than fabric does (they are strapped to a spine).
  cinder: { coat: 1.4, cape: 0.18 },
};

/**
 * Per-rig REST POSE. The angles the animator settles on when the survivor is
 * standing still — which is the pose every roster shot, portrait and idle frame
 * in the game is taken in.
 *
 * This exists because the shared rest pose was actively destroying the
 * silhouettes it was supposed to show off. `armL.rotation.z = +0.16` swings a
 * down-hanging left arm toward +X, i.e. *into* the torso, and the right arm's
 * -0.16 does the same from the other side; `hipL.rotation.z = +0.04` converges
 * the legs. So every rig on the roster stood with both arms welded flat to the
 * body and both legs fused into one column, and a threshold of the result had
 * literally zero pixels of background inside the outline. The signs below are
 * therefore inverted from the originals — these are abduction magnitudes, and
 * the animator negates per side.
 *
 *  armZ    shoulder abduction of the free arm, radians. Has to clear the
 *          torso's own half-width by enough that the gap survives being
 *          resampled to gameplay size: ~4-6 px per side at 60 px of body.
 *  gunZ    the same, for the weapon arm, which is otherwise pinned by the
 *          aim override no matter what the rest pose says.
 *  stance  hip splay. The inner-leg gap has to be open below the coat hem or
 *          the character has one leg.
 *  lean    base spine pitch: Anvil is hunched over the gauntlet, Kestrel is
 *          bolt upright behind the scope.
 */
const POSE = {
  ranger: { armZ: 0.40, gunZ: 0.26, gunY: -0.12, elbow: -0.30, stance: 0.105, lean: 0.02 },
  anvil: { armZ: 0.58, gunZ: 0.46, gunY: -0.26, elbow: -0.46, stance: 0.115, lean: 0.17 },
  kestrel: { armZ: 0.16, gunZ: 0.02, gunY: -0.06, elbow: -0.55, stance: 0.075, lean: -0.05 },
  rook: { armZ: 0.32, gunZ: 0.30, gunY: -0.18, elbow: -0.38, stance: 0.20, lean: 0.06 },
  // Cinder is the inverse of Rook: the mass is at the top (twin tanks) and the
  // stance is narrow, so the rig tapers *downward*. `stance` is therefore the
  // tightest on the roster and `armZ` the second widest — the arms have to clear
  // a torso that is already wearing a harness, or the whole upper body closes
  // into one block and the tanks stop reading as separate objects.
  cinder: { armZ: 0.52, gunZ: 0.38, gunY: -0.22, elbow: -0.44, stance: 0.065, lean: 0.20 },
};

/**
 * MeshStandardMaterial + two cheap form terms folded in before lighting:
 *
 *  - a fresnel RIM in the emissive radiance. The character cannot rely on the
 *    stage key light (it changes per stage), so every edge lifts itself against
 *    whatever is behind it.
 *  - a HEMISPHERIC bias on the diffuse albedo. The stage key is a single
 *    low-contrast directional, so two facets of the same body 40 deg apart were
 *    measured at under 6/255 apart — `flatShading` had geometry to differentiate
 *    and no light to do it with. Tilting albedo by the facet's world-space
 *    up-ness gives every rig sky-over-bounce separation that is independent of
 *    the key direction, which is what makes a faceted body read as a solid.
 *
 * Implemented as a subclass rather than a bare `onBeforeCompile` assignment so
 * `clone()` — which VFX.hitFlash does to every mesh on the rig — keeps the patch
 * and the params.
 *
 * Exported because the monster rigs need exactly the same tricks: without them
 * an enemy standing on shadowed rock is one flat shape on another.
 */
export class RimStandardMaterial extends THREE.MeshStandardMaterial {
  constructor({ rimColor = 0xa9d2ff, rimStrength = 0.55, rimPower = 2.6,
    hemiStrength = 0.22, ...rest } = {}) {
    super(rest);
    this.rimColor = new THREE.Color(rimColor);
    this.rimStrength = rimStrength;
    this.rimPower = rimPower;
    this.hemiStrength = hemiStrength;
  }

  copy(src) {
    super.copy(src);
    this.rimColor = src.rimColor.clone();
    this.rimStrength = src.rimStrength;
    this.rimPower = src.rimPower;
    this.hemiStrength = src.hemiStrength;
    return this;
  }

  onBeforeCompile(shader) {
    shader.uniforms.uRimColor = { value: this.rimColor };
    shader.uniforms.uRimStrength = { value: this.rimStrength };
    shader.uniforms.uRimPower = { value: this.rimPower };
    shader.uniforms.uHemi = { value: this.hemiStrength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uRimColor;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform float uHemi;
      `)
      // After emissivemap_fragment `normal`, `diffuseColor` and
      // `totalEmissiveRadiance` all exist and none of them has been consumed
      // yet — `lights_physical_fragment` is the next chunk. Lighting downstream
      // is left completely untouched.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          vec3 nrm = normalize(normal);
          float rimF = 1.0 - clamp(dot(nrm, normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance += uRimColor * (pow(rimF, uRimPower) * uRimStrength);
          // World up expressed in view space, so the term is view-independent.
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float hemi = dot(nrm, upV) * 0.5 + 0.5;
          diffuseColor.rgb *= mix(1.0 - uHemi, 1.0 + uHemi, hemi);
        }
      `);
  }
}

function mat(color, { rough = 0.72, metal = 0.05, emissive = 0, emissiveIntensity = 1,
  rimColor, rimStrength, rimPower, hemiStrength, side } = {}) {
  return new RimStandardMaterial({
    color, roughness: rough, metalness: metal, flatShading: true,
    emissive, emissiveIntensity, rimColor, rimStrength, rimPower, hemiStrength,
    ...(side ? { side } : null),
  });
}

// A tapered faceted box — the workhorse limb shape. Low segment counts keep
// the silhouette readable and the shading hard-edged.
function limb(len, top, bottom, material, sides = 5) {
  const g = new THREE.CylinderGeometry(top, bottom, len, sides, 1);
  g.translate(0, -len / 2, 0); // pivot at the joint, body hangs down -Y
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

function boxMesh(w, h, d, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = true;
  return m;
}

// Contact-shadow blob. This is a MULTIPLY decal, not a composite: the previous
// version tried to solve "a subtractive blob is invisible on luma-6 ground" by
// *adding* a grey ring, and on the lit grade that ships now that ring measured
// 77-165 against a floor of 24 — the brightest object on the ground plane and
// the exact inverse of a shadow.
//
// The rule this shader holds instead: a contact decal may only ever attenuate
// what is under it. `gl_FragColor.rgb` is premultiplied by `a`, so with
// (DstColor, OneMinusSrcAlpha) blending the result is
//   dst * (SHADE * a) + dst * (1 - a)  ==  dst * (1 - a * (1 - SHADE))
// which is <= dst for every channel at every alpha. Visibility on near-black
// ground comes from the *hue* rather than the value: red is attenuated hardest
// and blue least, so deepening contact goes cool instead of grey, and the
// ground's own texture survives instead of being flattened by a constant.
//
// STRENGTH. The multiply lands in the linear HDR buffer, *before* the tonemap
// and the grade, so the display-referred dip is the linear one raised to ~1/2.2.
// At `core 0.62` / `SHADE (0.06,0.09,0.16)` the linear factor is 0.48, which is
// a 29% dip in sRGB — measured at 24% under the survivor, i.e. below the noise
// of the terrain's own faceting and unreadable as contact. The numbers below
// put the linear factor at 0.27, which is a ~45% sRGB dip: luma 60 ground goes
// to ~33 under the disc. That is tuned against the grade that ships now
// (sub-luma-24 ~1-3%, lit:shadow ~4.8:1) and must be re-checked if the ground
// exposure moves again — this cue has been re-tuned three times for exactly
// that reason.
//
// `a` is clamped below 1 so that the >= 0 side of the proof holds too: with a
// per-rig fade that carries the rig's scale, a big boss could otherwise drive
// `a * (1 - SHADE)` past 1 and clamp the disc to flat black.
//
// Deliberately duplicated from the monsters' instanced version in
// EnemyMeshes.js rather than shared — that module imports this one, and a
// cycle between the two entity modules is not worth six lines of GLSL.
const BLOB_FRAG = /* glsl */`
uniform float uFade;
varying vec2 vBlobUv;
varying float vGraze;
void main() {
  float r = length(vBlobUv - 0.5) * 2.0;
  float core = smoothstep(1.00, 0.14, r);
  float ring = smoothstep(0.48, 0.80, r) * smoothstep(1.02, 0.82, r);
  // A ground disc seen edge-on projects to a bar a few pixels tall — all
  // annulus, no disc — which reads as a rendering glitch rather than contact.
  // The knee sits lower than it did: the artefact it was written to kill was a
  // *bright* ring that this shader can no longer produce, so it only has to
  // cover the genuinely edge-on case (under ~1.7 deg) rather than tax every
  // low third-person camera in the game.
  float a = (core * 0.86 + ring * 0.18) * uFade * smoothstep(0.03, 0.14, vGraze);
  a = min(a, 0.92);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vec3(0.03, 0.05, 0.11) * a, a);
}`;

const BLOB_VERT = /* glsl */`
varying vec2 vBlobUv;
varying float vGraze;
void main() {
  vBlobUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vGraze = abs(normalize(cameraPosition - wp.xyz).y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

function pivot(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/**
 * The character's material set. Split out of the constructor so the boot-time
 * shader prewarm can warm these permutations (notably the dissolve-patched
 * doubled-sided cloth) without assembling a whole throwaway rig.
 */
export function makeCharacterMats(COL = PALETTES.ranger) {
  const set = {
    // The dark half of the value break still has to be *readable* dark, not a
    // hole in the frame: a sliver of self-emissive keeps the navy shell off the
    // crushed-black floor when the survivor walks into terrain shadow.
    //
    // RIM AND HEMI ON THE DARK SHELL. Measured on `03-thirdperson`, the coat
    // ran at luminance 20-64 against terrain at 12-63 — the survivor was
    // *darker* than the cliff behind it and the two ranges overlapped
    // completely. The stage key cannot be relied on to fix that (it changes per
    // biome and the character can always stand in its shadow), so the
    // separation is bought from the two view-space terms this material owns
    // instead: a wider, stronger fresnel band (power 2.6 -> 2.2 so it reaches
    // further in off the outline) and a much harder hemispheric tilt, which
    // lifts every up-facing facet toward the sky and drops every down-facing
    // one. That is a value *structure* on the body rather than a flat brighten,
    // so nothing clips and the fix travels to all four biomes.
    coat: mat(COL.coat, {
      rough: 0.78, rimStrength: 1.6, rimPower: 2.0, hemiStrength: 0.40,
      emissive: COL.coat, emissiveIntensity: 0.30,
    }),
    // `coatLift` / `cloakLift` / `cellBase` / `visorBase` are the near-blacks
    // the Ranger hard-coded. They are palette *hues*, not neutral darks — a
    // blue lift under Anvil's rust cloak reads as a different material — so
    // each palette may override them and the Ranger's originals are the
    // defaults, which is what keeps that rig byte-identical.
    coatDark: mat(COL.coatDark, {
      rough: 0.85, rimStrength: 1.75, rimPower: 2.0, hemiStrength: 0.40,
      emissive: COL.coatLift ?? 0x243444, emissiveIntensity: 0.34,
    }),
    // Cloth is the near-black underlayer: tails, wraps, anything that should
    // read as the deepest value on the rig.
    cloth: mat(COL.coatDark, { rough: 0.9, rimStrength: 1.8, rimPower: 2.0, hemiStrength: 0.40, side: THREE.DoubleSide }),
    // `shell` is `coat` for open-ended geometry. A jacket built out of `cloth`
    // put the rig's *darkest* value on its largest surface, which is most of
    // how the survivor ended up sitting inside the terrain's value range.
    shell: mat(COL.coat, {
      rough: 0.82, rimStrength: 1.6, rimPower: 2.0, hemiStrength: 0.40,
      emissive: COL.coat, emissiveIntensity: 0.30, side: THREE.DoubleSide,
    }),
    cloak: mat(COL.cloak, {
      rough: 0.88, rimStrength: 0.9, rimPower: 2.3, hemiStrength: 0.30,
      emissive: COL.cloakLift ?? 0x2a3540, emissiveIntensity: 0.22,
      side: THREE.DoubleSide,
    }),
    // Light armour. A touch of self-emissive keeps the plates off pure black
    // when the character walks into a shadow the stage lighting never fills.
    // Low rim on the light plate: it is already the bright value, and a
    // strong fresnel on top just tints it toward the rim hue.
    plate: mat(COL.plate, {
      rough: 0.42, metal: 0.28, emissive: COL.plate, emissiveIntensity: 0.17, rimStrength: 0.40, hemiStrength: 0.30,
    }),
    plateMid: mat(COL.plateMid, { rough: 0.5, metal: 0.3, rimStrength: 0.85, hemiStrength: 0.30 }),
    accent: mat(COL.accent, {
      rough: 0.55, emissive: COL.accent, emissiveIntensity: 0.9, rimColor: 0xffc08a, rimStrength: 0.5,
    }),
    // `cellGain` lets a palette stop its own emissive down without touching the
    // other three: one survivor's accent hue can bloom at a gain the rest read
    // fine at, and the fix belongs next to the colour that misbehaves.
    cell: mat(COL.cellBase ?? 0x0a1a20, {
      rough: 0.3, emissive: COL.cell, emissiveIntensity: 1.6 * (COL.cellGain ?? 1), rimStrength: 0.3,
    }),
    body: mat(COL.skinDark, { rough: 0.6, metal: 0.2, rimStrength: 1.55, rimPower: 2.0, hemiStrength: 0.36 }),
    metal: mat(COL.metal, { rough: 0.4, metal: 0.7, rimStrength: 0.45 }),
    gun: mat(COL.gunmetal, {
      rough: 0.42, metal: 0.45, emissive: 0x141b24, emissiveIntensity: 0.5,
      rimStrength: 1.05, rimPower: 2.3, hemiStrength: 0.30,
    }),
    visor: mat(COL.visorBase ?? 0x061418, { rough: 0.2, metal: 0.1, emissive: COL.visor, emissiveIntensity: 2.4 }),
  };

  // Palette-scoped fresnel. The rim is what lifts every edge off whatever is
  // behind it, and a cool-blue rim on Anvil's rust or Rook's olive reads as
  // wet plastic rather than as light. The Ranger leaves `rim` undefined and so
  // keeps RimStandardMaterial's original 0xa9d2ff default untouched. The accent
  // is skipped: it already carries its own hand-picked rim hue.
  if (COL.rim) {
    for (const k in set) if (k !== 'accent') set[k].rimColor.set(COL.rim);
  }
  return set;
}

export class CharacterMesh {
  /**
   * @param {string} meshKey a survivor card's `meshKey`. Unknown keys fall back
   *   to the Ranger rather than throwing: a bad key in a saved profile must
   *   still produce a playable character, and `new CharacterMesh()` with no
   *   argument is still the Ranger, which is what `net/NetViews.js` builds.
   */
  constructor(meshKey = 'ranger') {
    this.key = PALETTES[meshKey] ? meshKey : 'ranger';
    this.mats = makeCharacterMats(PALETTES[this.key]);
    this.cloth = CLOTH_GAIN[this.key] || CLOTH_GAIN.ranger;
    this.pose = POSE[this.key] || POSE.ranger;
    // Per-rig presentation constants the animator reads. The body kits override
    // them; these are the Ranger's, so that rig comes out unchanged.
    this.blobScale = 1.0;
    this.visorBase = 1.9;
    this.build();
    this.initState();
  }

  /**
   * Dispatch to a body kit.
   *
   * The four rigs are written out separately rather than driven from one
   * parameterised builder. They share a skeleton *contract* — the animator
   * below needs `rig`, `pelvis`, `spine`, `chest`, `neck`, `coat`, `cape`,
   * `arms.L/R.{shoulder,elbow,hand}`, `legs.L/R.{hip,knee,ankle}` and `muzzle`
   * on every one of them — but nothing beyond it. A shared builder with four
   * sets of proportions produces four rigs carrying the same masses at
   * different sizes, which is exactly the "everything the same shape" failure
   * axis 4 exists to catch: what separates these four at 110 px tall is where
   * the volume is, not how much of it there is.
   */
  build() {
    if (this.key === 'anvil') this.buildAnvil();
    else if (this.key === 'kestrel') this.buildKestrel();
    else if (this.key === 'rook') this.buildRook();
    else if (this.key === 'cinder') this.buildCinder();
    else this.buildRanger();
    this._finish();
  }

  buildRanger() {
    const M = this.mats;
    const root = new THREE.Group();
    this.group = root;

    // `rig` carries whole-body offsets (bob, lean, dash tilt) so the root stays
    // exactly at the capsule's feet for gameplay code to trust.
    const rig = pivot(root, 0, 0, 0);
    this.rig = rig;

    // Raised, and the legs lengthened to match: this is the tall rig, and the
    // extra 6 cm all goes into leg the shortened jacket now leaves on show.
    const pelvis = pivot(rig, 0, 0.98, 0);
    this.pelvis = pelvis;
    const hipBlock = boxMesh(0.36, 0.22, 0.24, M.coatDark);
    hipBlock.position.y = -0.04;
    pelvis.add(hipBlock);

    const spine = pivot(pelvis, 0, 0.10, 0);
    this.spine = spine;
    const chest = pivot(spine, 0, 0.20, 0);
    this.chest = chest;

    const torso = limb(0.36, 0.24, 0.19, M.coat, 6);
    torso.position.y = 0.06;
    torso.scale.z = 0.82;
    chest.add(torso);

    // --- value structure ---------------------------------------------------
    // Light armour (M.plate) laid over the dark navy shell. The torso is never
    // one mass: a bright yoke and chest plate against a near-black coat is
    // what makes the form legible at 5.4 units with no help from the stage
    // key light.
    // Runs the full shoulder width — clavicle to clavicle — so the light plate
    // is one continuous bar from the torso out into both deltoids. A yoke that
    // stops short of the shoulder pivots leaves the arms as separate objects
    // sharing a row.
    //
    // Dropped from 0.20 to 0.12 along with the shoulder pivots below. The
    // shoulder line has to sit low enough that the helmet's underside clears it
    // — that clearance IS the head/neck notch, and without one this rig and
    // Anvil thresholded to the same headless lump.
    const yoke = boxMesh(0.42, 0.085, 0.25, M.plate);
    yoke.position.set(0, 0.12, 0);
    chest.add(yoke);

    const plate = boxMesh(0.29, 0.21, 0.10, M.plate);
    plate.position.set(0, -0.02, 0.13);
    chest.add(plate);
    const stripe = boxMesh(0.05, 0.17, 0.03, M.accent);
    stripe.position.set(0, -0.02, 0.19);
    chest.add(stripe);

    // The gameplay camera sits behind the head, so the back is the surface
    // that actually gets looked at. A pale cloak owns it — anything plated
    // onto the torso itself would just be occluded by the cloth. Everything
    // that has to read from behind therefore hangs off the cloak pivot, on
    // the outside of the shell.
    // The cape is built as two shells, not one: a bright plate yoke across the
    // shoulders over a mid-value lower cape. That light-over-dark break is the
    // whole value structure of the character from behind, where the camera
    // actually is — the plated chest is occluded 100% of the time. It is also
    // short (0.38 rather than 0.52) and narrow at the hem (0.24 rather than
    // 0.33) so it stops at the ribs instead of swallowing the arms and merging
    // with the coat into one continuous cone.
    const capePivot = pivot(chest, -0.02, 0.12, -0.02);
    this.cape = capePivot;

    const yokeGeo = new THREE.CylinderGeometry(0.205, 0.245, 0.14, 5, 1, true, Math.PI * 0.66, Math.PI * 0.84);
    yokeGeo.translate(0, -0.07, 0);
    const capeYoke = new THREE.Mesh(yokeGeo, M.plate);
    capeYoke.castShadow = true;
    capePivot.add(capeYoke);

    const capeGeo = new THREE.CylinderGeometry(0.245, 0.24, 0.24, 5, 1, true, Math.PI * 0.66, Math.PI * 0.84);
    capeGeo.translate(0, -0.26, 0);
    const cape = new THREE.Mesh(capeGeo, M.cloak);
    cape.castShadow = true;
    capePivot.add(cape);

    // Accent runs the full centre seam, tying the two shells together and
    // giving the back one saturated vertical line.
    const spineTrim = boxMesh(0.055, 0.36, 0.03, M.accent);
    spineTrim.position.set(0.02, -0.19, -0.255);
    capePivot.add(spineTrim);

    // The back canister and its cyan cell used to live at x +0.155, i.e. inside
    // the same 30 px of shoulder as the sling stock, the pauldron and the spine
    // trim: that patch measured SD 50.7 against a mean of 66.4 — six competing
    // shapes in a strip narrower than the helmet. They are gone. The sling and
    // the accent seam are the two things that shoulder is allowed to say.

    // Slung carbine across the cloak. Reads from behind no matter where the
    // held weapon is pointing, it is the strongest single line in the
    // silhouette, and dark hardware on pale cloth is the biggest value
    // contrast on the model.
    // Slung carbine. Canted hard enough that the muzzle and the stock both
    // break the cape outline — a weapon that stays inside the cloth footprint
    // contributes nothing to the silhouette no matter what value it is. The
    // light receiver plate is what actually draws the line across the back.
    const sling = new THREE.Group();
    sling.position.set(-0.03, -0.17, -0.255);
    // Canted more upright than it was (53 deg -> 41 deg) so the stock clears the
    // shoulder line on the left instead of stopping level with it. That spike
    // out of the top-left of the outline is this rig's asymmetric signature —
    // the one element that says which way round the character is standing at a
    // size where nothing else resolves.
    sling.rotation.set(0.14, 0, -0.72);
    capePivot.add(sling);
    const slingBody = boxMesh(0.09, 0.46, 0.13, M.gun);
    sling.add(slingBody);
    // Stock: a stepped wedge, so the top end is not a bare rectangle.
    const slingStock = boxMesh(0.115, 0.17, 0.15, M.plateMid);
    slingStock.position.y = 0.28;
    sling.add(slingStock);
    const slingComb = boxMesh(0.07, 0.09, 0.10, M.gun);
    slingComb.position.set(0, 0.40, -0.02);
    sling.add(slingComb);
    // Barrel + muzzle step, tapering out past the hem.
    const slingBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.028, 0.30, 6), M.metal);
    slingBarrel.position.y = -0.36;
    slingBarrel.castShadow = true;
    sling.add(slingBarrel);
    const slingMuzzle = boxMesh(0.055, 0.07, 0.055, M.plateMid);
    slingMuzzle.position.y = -0.53;
    sling.add(slingMuzzle);
    const slingCell = boxMesh(0.03, 0.24, 0.03, M.cell);
    slingCell.position.set(0, -0.06, 0.075);
    sling.add(slingCell);

    // Coat: a hip-length combat jacket, not a robe. It was 0.58 long flaring
    // out to a 0.30 hem — the widest point on the whole character and a
    // continuous skirt from the ribs to below the knee, which is why the rig
    // read as an acolyte rather than as line infantry and why its legs fused
    // into one column under threshold. At 0.34 long and barely flared it stops
    // above the knee, so a third of this survivor's height is two separate
    // legs with daylight between them. `M.coat` rather than `M.cloth`: the
    // jacket is the largest surface the gameplay camera sees and it was
    // carrying the near-black underlayer colour into the middle of the frame.
    const coatGeo = new THREE.CylinderGeometry(0.235, 0.245, 0.34, 7, 1, true);
    coatGeo.translate(0, -0.17, 0);
    const coat = new THREE.Mesh(coatGeo, M.shell);
    coat.castShadow = true;
    const coatPivot = pivot(pelvis, 0, 0.14, 0);
    coatPivot.add(coat);
    const hemGeo = new THREE.CylinderGeometry(0.25, 0.255, 0.05, 7, 1, true);
    hemGeo.translate(0, -0.325, 0);
    const hem = new THREE.Mesh(hemGeo, M.accent);
    coatPivot.add(hem);
    this.coat = coatPivot;

    // Head — light crown, dark jaw, hot visor. The top of the silhouette is
    // the brightest thing on the model.
    const neck = pivot(chest, 0, 0.24, 0);
    this.neck = neck;
    // A TALL NARROW BOX, and the primitive is the point. Anvil's head is a wide
    // flat wedge and Rook's is a small dome; when the three were all rounded
    // lumps of similar size the only thing separating them in black was overall
    // width. This one is 0.185 wide by 0.30 tall — the tallest, narrowest head
    // on the roster — and its underside sits 0.13 above the shoulder plane
    // (yoke 0.12 + pad 0.09 = 0.21; helm base 0.24 + 0.20 - 0.15 = 0.29), so
    // the outline has a real neck notch instead of a lump on a brick.
    const helmet = boxMesh(0.185, 0.30, 0.215, M.plate);
    helmet.position.y = 0.20;
    helmet.castShadow = true;
    neck.add(helmet);
    // The thin column under it. Without a drawn neck the helm floats.
    const throat = boxMesh(0.10, 0.12, 0.11, M.coatDark);
    throat.position.set(0, 0.03, 0);
    neck.add(throat);
    const jaw = boxMesh(0.155, 0.07, 0.09, M.coatDark);
    jaw.position.set(0, 0.09, 0.09);
    neck.add(jaw);
    // Dark nape guard: without it the pale helm reads as one flat slab from
    // the gameplay camera, which sits directly behind the head.
    const nape = boxMesh(0.175, 0.13, 0.06, M.coat);
    nape.position.set(0, 0.14, -0.13);
    neck.add(nape);
    // The visor is on the face and the camera is behind the head, so the head
    // would otherwise never own the brightest pixel on the model. This strip is
    // the visor's read from the only angle the player has.
    const napeLamp = boxMesh(0.10, 0.026, 0.02, M.cell);
    napeLamp.position.set(0, 0.18, -0.165);
    neck.add(napeLamp);
    // A slit in a dark face, not a lamp bolted to the front of the helm. At
    // 0.19 x 0.07 standing 0.04 proud of the shell at emissive 2.4 the visor
    // was the single brightest object on the roster and the helmet read as a
    // light fitting; the face panel behind it gives the glow something to be
    // recessed into.
    const face = boxMesh(0.155, 0.15, 0.03, M.coatDark);
    face.position.set(0, 0.20, 0.10);
    neck.add(face);
    const visor = boxMesh(0.125, 0.045, 0.03, M.visor);
    visor.position.set(0, 0.21, 0.105);
    neck.add(visor);
    this.visor = visor;
    // Crest runs front-to-back over the crown so the accent is visible from
    // behind too, which is where the camera actually is.
    const crest = boxMesh(0.035, 0.085, 0.28, M.accent);
    crest.position.set(0, 0.38, -0.03);
    crest.rotation.x = -0.12;
    neck.add(crest);
    // Off-centre antenna: a single asymmetric spike out of the head profile.
    const antenna = boxMesh(0.022, 0.32, 0.022, M.metal);
    antenna.position.set(-0.105, 0.44, -0.05);
    antenna.rotation.set(-0.28, 0, 0.30);
    neck.add(antenna);
    const beacon = boxMesh(0.04, 0.04, 0.04, M.cell);
    beacon.position.set(-0.155, 0.59, -0.09);
    neck.add(beacon);

    // Arms
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      // The arm has to do two contradictory things: clear the cape hem (0.245)
      // so it is IN the outline, and overlap the torso (edge ~0.21) so it is
      // ATTACHED to it. At a pivot of 0.26 with a 0.065 upper arm it did
      // neither — there were 4 px of pure terrain between torso and arm, and in
      // a black-key test the arm was a floating lozenge. Pulling the pivot in
      // to 0.215 and fattening the deltoid to 0.105 makes the arm span
      // 0.11 -> 0.32: a ~0.03 unit (~4 px) overlap onto the torso at the
      // shoulder, and still 0.075 clear of the cape at the outside. The arm now
      // separates from the body by VALUE (dark limb under a light yoke), which
      // is what it should have been doing all along.
      // Dropped to 0.12 and slimmed to a 0.09 pad. The shoulder line is now the
      // narrowest and lowest on the roster, which is what leaves room for the
      // tall helm above it and for the arms — abducted 0.40 rad by POSE.ranger
      // — to open ~0.07 of daylight either side of the ribs.
      const shoulder = pivot(chest, 0.205 * side, 0.12, 0);
      const pad = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), M.coat);
      pad.scale.set(1.15, 0.9, 1.0);
      pad.castShadow = true;
      shoulder.add(pad);
      if (side < 0) {
        // One pauldron plane, not two. The second plate was a 0.19 slab sitting
        // 0.06 below the first at a different angle, and at gameplay distance
        // the pair read as noise rather than as layered armour.
        const p1 = boxMesh(0.20, 0.095, 0.22, M.plate);
        p1.position.set(-0.035, 0.04, 0);
        p1.rotation.z = 0.32;
        shoulder.add(p1);
      } else {
        const cap = boxMesh(0.145, 0.07, 0.155, M.plateMid);
        cap.position.set(0.015, 0.05, 0);
        shoulder.add(cap);
      }
      // Fat at the deltoid, thin at the elbow: the taper is what reads as an
      // arm at 240 px tall, and the fat end is what welds it to the torso.
      const upper = limb(0.28, 0.105, 0.058, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.28, 0);
      const fore = limb(0.25, 0.058, 0.048, M.coatDark);
      elbow.add(fore);
      const bracer = boxMesh(0.085, 0.11, 0.09, side < 0 ? M.plateMid : M.plate);
      bracer.position.y = -0.15;
      elbow.add(bracer);
      const hand = pivot(elbow, 0, -0.25, 0);
      const fist = boxMesh(0.085, 0.09, 0.095, M.body);
      hand.add(fist);
      this.arms[key] = { shoulder, elbow, hand };
    }

    // Weapon: chunky sidearm in the right hand, muzzle exposed for VFX. The
    // light receiver and the lit muzzle ring keep it separate from the dark
    // forearm behind it.
    const gun = new THREE.Group();
    gun.position.set(0, -0.02, 0.03);
    this.arms.R.hand.add(gun);
    const body = boxMesh(0.075, 0.11, 0.30, M.gun);
    body.position.set(0, 0.02, 0.08);
    gun.add(body);
    const receiver = boxMesh(0.085, 0.055, 0.20, M.plate);
    receiver.position.set(0, 0.085, 0.06);
    gun.add(receiver);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.26, 6), M.metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.045, 0.26);
    barrel.castShadow = true;
    gun.add(barrel);
    const grip = boxMesh(0.065, 0.16, 0.08, M.coatDark);
    grip.position.set(0, -0.09, -0.01);
    grip.rotation.x = -0.22;
    gun.add(grip);
    const sight = boxMesh(0.03, 0.03, 0.05, M.accent);
    sight.position.set(0, 0.13, 0.10);
    gun.add(sight);
    const glow = boxMesh(0.055, 0.02, 0.14, M.cell);
    glow.position.set(0, 0.05, 0.34);
    gun.add(glow);
    this.gun = gun;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.045, 0.40);
    gun.add(this.muzzle);

    // Legs: dark thigh under the coat, light shin below the hem. That flip
    // is what makes the walk cycle legible at gameplay distance — the bright
    // shins scissor against the dark ground.
    this.legs = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const hip = pivot(pelvis, 0.135 * side, -0.10, 0);
      // Shell rather than underlayer. The thighs are ~9% of the survivor's
      // pixels in the gameplay frame and they were the deepest value on it,
      // which is what pulled the whole body mean down into the terrain's range.
      const thigh = limb(0.46, 0.085, 0.068, M.coat);
      hip.add(thigh);
      const knee = pivot(hip, 0, -0.46, 0);
      const shin = limb(0.42, 0.075, 0.055, M.plate);
      knee.add(shin);
      const ankle = pivot(knee, 0, -0.42, 0);
      const boot = boxMesh(0.12, 0.10, 0.26, M.coatDark);
      boot.position.set(0, -0.03, 0.04);
      ankle.add(boot);
      const toe = boxMesh(0.11, 0.05, 0.06, M.accent);
      toe.position.set(0, -0.055, 0.15);
      ankle.add(toe);
      this.legs[key] = { hip, knee, ankle };
    }

  }

  /* ---------------------------------------------------------------------- */
  /* ANVIL — the bruiser.                                                   */
  /*                                                                         */
  /* Read: SHORT AND WIDE, with the mass on one side. ~1.6 m tall against a   */
  /* 1.05 m shoulder span, where the Ranger is 1.9 m against 0.66. That ratio */
  /* alone separates the two as pure black shapes at any distance, before any */
  /* detail is resolved. The top of the outline is a flat cowl sunk between   */
  /* two very different shoulders — a slab pauldron on the left, a raised     */
  /* gauntlet on the right — so it is also asymmetric, which is what makes it */
  /* readable when the two are standing side by side.                         */
  /* ---------------------------------------------------------------------- */

  buildAnvil() {
    const M = this.mats;
    const root = new THREE.Group();
    this.group = root;
    this.blobScale = 1.3;
    this.visorBase = 2.0;

    const rig = pivot(root, 0, 0, 0);
    this.rig = rig;

    // Low pelvis: the legs are a third of this character rather than half of
    // one. Everything above it is torso and armour.
    const pelvis = pivot(rig, 0, 0.80, 0);
    this.pelvis = pelvis;
    const hipBlock = boxMesh(0.46, 0.24, 0.30, M.coatDark);
    hipBlock.position.y = -0.04;
    pelvis.add(hipBlock);
    const beltPlate = boxMesh(0.40, 0.10, 0.14, M.plateMid);
    beltPlate.position.set(0, 0.03, 0.16);
    pelvis.add(beltPlate);

    const spine = pivot(pelvis, 0, 0.09, 0);
    this.spine = spine;
    const chest = pivot(spine, 0, 0.18, 0);
    this.chest = chest;

    // Barrel torso, hunched forward. Wider at the shoulders than at the waist
    // — an inverted taper is the classic heavy read and the opposite of the
    // Ranger's.
    const torso = limb(0.54, 0.36, 0.24, M.coat, 6);
    torso.position.y = 0.36;
    torso.scale.z = 0.78;
    chest.add(torso);

    // Bone-coloured breastplate: one big light mass low on a dark body, where
    // the Ranger's light mass is a thin yoke high on it.
    const bib = boxMesh(0.40, 0.26, 0.14, M.plate);
    bib.position.set(0, 0.02, 0.17);
    bib.rotation.x = 0.10;
    chest.add(bib);
    const ribL = boxMesh(0.07, 0.22, 0.05, M.plateMid);
    ribL.position.set(-0.24, 0.02, 0.15);
    chest.add(ribL);
    const ribR = ribL.clone();
    ribR.position.x = 0.24;
    chest.add(ribR);
    const furnace = boxMesh(0.13, 0.13, 0.05, M.cell);
    furnace.position.set(0, 0.06, 0.235);
    chest.add(furnace);

    // Rear: a bolted reactor block, not cloth. Hung off the cape pivot so the
    // animator still drives it, at the heavily reduced CLOTH_GAIN.
    const capePivot = pivot(chest, 0, 0.16, -0.02);
    this.cape = capePivot;
    const core = boxMesh(0.40, 0.34, 0.20, M.coatDark);
    core.position.set(0, -0.14, -0.22);
    capePivot.add(core);
    const corePlate = boxMesh(0.22, 0.20, 0.06, M.plateMid);
    corePlate.position.set(0, -0.11, -0.34);
    capePivot.add(corePlate);
    const coreCell = boxMesh(0.10, 0.14, 0.04, M.cell);
    coreCell.position.set(0, -0.11, -0.375);
    capePivot.add(coreCell);
    // Two stacks kicked back off the shoulders — the only thing on this rig
    // that leaves the block, so they carry the whole upper outline.
    for (const side of [-1, 1]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.34, 5), M.metal);
      stack.castShadow = true;
      stack.position.set(0.16 * side, 0.22, -0.24);
      stack.rotation.set(-0.42, 0, 0.16 * side);
      capePivot.add(stack);
      const cap = boxMesh(0.09, 0.05, 0.09, M.accent);
      cap.position.set(0.20 * side, 0.37, -0.32);
      capePivot.add(cap);
    }

    // Tassets rather than a coat: four short armour plates on the pelvis.
    const coatPivot = pivot(pelvis, 0, 0.02, 0);
    this.coat = coatPivot;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const tass = boxMesh(0.19, 0.24, 0.09, i % 2 ? M.plateMid : M.coatDark);
      tass.position.set(Math.sin(a) * 0.22, -0.18, Math.cos(a) * 0.19);
      tass.rotation.y = a;
      tass.rotation.x = -Math.cos(a) * 0.16;
      coatPivot.add(tass);
    }
    // Two hem bars rather than one. A single 0.34-wide plate across the bottom
    // of the tassets welded the crotch shut and took the inner-leg gap with it,
    // which is half of why this rig and the Ranger thresholded to the same
    // fused column.
    for (const side of [-1, 1]) {
      const hem = boxMesh(0.15, 0.05, 0.28, M.accent);
      hem.position.set(0.16 * side, -0.30, 0);
      coatPivot.add(hem);
    }

    // Head: no neck. A wide low cowl with a horizontal amber bar, sunk far
    // enough between the shoulders that the outline has no head/neck notch at
    // all — which is the *opposite* of the note on the Ranger's helmet, and is
    // deliberate: absence of a neck is this character's read.
    const neck = pivot(chest, 0, 0.20, 0);
    this.neck = neck;
    const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.23, 0.20, 6), M.plate);
    cowl.castShadow = true;
    cowl.position.y = 0.09;
    cowl.rotation.y = 0.5;
    neck.add(cowl);
    const brow = boxMesh(0.34, 0.07, 0.20, M.coatDark);
    brow.position.set(0, 0.16, 0.02);
    neck.add(brow);
    const visor = boxMesh(0.30, 0.055, 0.06, M.visor);
    visor.position.set(0, 0.06, 0.16);
    neck.add(visor);
    this.visor = visor;
    // Two short horns raked backwards. They break the flat top without ever
    // making the head *tall*, which would cost the squat read.
    for (const side of [-1, 1]) {
      const horn = boxMesh(0.05, 0.17, 0.05, M.metal);
      horn.position.set(0.15 * side, 0.19, -0.05);
      horn.rotation.set(-0.55, 0, 0.35 * side);
      neck.add(horn);
    }
    const nape = boxMesh(0.26, 0.13, 0.08, M.accent);
    nape.position.set(0, 0.10, -0.16);
    neck.add(nape);

    // Arms. The whole point of this rig: they are not a pair.
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      // Raised from 0.22 to 0.33, which puts both pauldrons ABOVE the cowl.
      // That is the read: the widest band of this silhouette is its topmost
      // band, and the head is a notch cut down into it — the exact inverse of
      // the Ranger's narrow shoulders under a tall helm. Two rigs cannot
      // threshold to the same shape when one is a triangle standing on its
      // point and the other on its base.
      const shoulder = pivot(chest, 0.30 * side, 0.33, 0);
      const pad = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), M.coat);
      pad.scale.set(1.2, 0.95, 1.05);
      pad.castShadow = true;
      shoulder.add(pad);

      if (side < 0) {
        // Left: a single huge slab pauldron canted outward. It is the widest
        // point of the whole character.
        const slab = boxMesh(0.40, 0.17, 0.38, M.plate);
        slab.position.set(-0.12, 0.12, 0);
        slab.rotation.z = 0.52;
        shoulder.add(slab);
        const lip = boxMesh(0.38, 0.055, 0.11, M.accent);
        lip.position.set(-0.16, 0.02, 0.15);
        lip.rotation.z = 0.52;
        shoulder.add(lip);
      } else {
        const cap = boxMesh(0.26, 0.12, 0.28, M.plateMid);
        cap.position.set(0.05, 0.11, 0);
        cap.rotation.z = -0.30;
        shoulder.add(cap);
        const rivet = boxMesh(0.24, 0.05, 0.10, M.accent);
        rivet.position.set(0.07, 0.04, 0.15);
        rivet.rotation.z = -0.30;
        shoulder.add(rivet);
      }

      const upper = limb(0.28, 0.135, 0.10, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.28, 0);
      // The right forearm is the weapon: it is nearly twice the left.
      const fore = limb(0.26, side < 0 ? 0.10 : 0.15, side < 0 ? 0.085 : 0.17, M.coatDark);
      elbow.add(fore);
      const hand = pivot(elbow, 0, -0.26, 0);
      const fist = boxMesh(side < 0 ? 0.13 : 0.20, side < 0 ? 0.13 : 0.19, side < 0 ? 0.14 : 0.21, M.body);
      hand.add(fist);
      this.arms[key] = { shoulder, elbow, hand };
    }

    // The gauntlet. `gun` and `muzzle` keep their names because that is the
    // animator's and Player's contract — this survivor's "muzzle" is simply
    // the front of a fist, which is where its VFX should originate.
    const gun = new THREE.Group();
    gun.position.set(0, -0.04, 0.04);
    this.arms.R.hand.add(gun);
    const cuff = boxMesh(0.30, 0.28, 0.24, M.gun);
    cuff.position.set(0, 0.06, 0.02);
    gun.add(cuff);
    const knuckle = boxMesh(0.30, 0.16, 0.14, M.plate);
    knuckle.position.set(0, 0.02, 0.18);
    gun.add(knuckle);
    for (let i = -1; i <= 1; i++) {
      const spike = boxMesh(0.055, 0.09, 0.16, M.metal);
      spike.position.set(i * 0.095, 0.06, 0.29);
      spike.rotation.x = -0.12;
      gun.add(spike);
    }
    const vent = boxMesh(0.06, 0.24, 0.20, M.cell);
    vent.position.set(0.16, 0.06, 0.02);
    gun.add(vent);
    const vent2 = vent.clone();
    vent2.position.x = -0.16;
    gun.add(vent2);
    this.gun = gun;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.04, 0.36);
    gun.add(this.muzzle);

    // Legs: short, thick and splayed. The stance is wider than the hips.
    this.legs = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      // Narrower than Rook's on purpose. Anvil is a triangle standing on its
      // point: the mass belongs at the pauldrons and the feet have to be the
      // narrow end for that to read.
      const hip = pivot(pelvis, 0.145 * side, -0.08, 0);
      const thigh = limb(0.36, 0.135, 0.11, M.coatDark);
      hip.add(thigh);
      const knee = pivot(hip, 0, -0.36, 0);
      const shin = limb(0.34, 0.12, 0.10, M.plate);
      knee.add(shin);
      const greave = boxMesh(0.17, 0.16, 0.13, M.plateMid);
      greave.position.set(0, -0.10, 0.03);
      knee.add(greave);
      const ankle = pivot(knee, 0, -0.34, 0);
      const boot = boxMesh(0.20, 0.13, 0.34, M.coatDark);
      boot.position.set(0, -0.04, 0.05);
      ankle.add(boot);
      const toe = boxMesh(0.19, 0.06, 0.09, M.accent);
      toe.position.set(0, -0.075, 0.20);
      ankle.add(toe);
      this.legs[key] = { hip, knee, ankle };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* KESTREL — the precision survivor.                                       */
  /*                                                                         */
  /* Read: TALL, THIN AND POINTED. ~2.0 m over a 0.40 m shoulder span, topped */
  /* by a hood that comes to a point — the only vertical apex on the roster,  */
  /* against Anvil's flat cowl and Rook's dome. The rifle is a metre of      */
  /* straight line held across the body, which is the second thing the eye    */
  /* resolves, and the split coat tails put two moving ribbons below the      */
  /* knees where nobody else has anything at all.                             */
  /* ---------------------------------------------------------------------- */

  buildKestrel() {
    const M = this.mats;
    const root = new THREE.Group();
    this.group = root;
    this.blobScale = 0.82;
    this.visorBase = 2.8;

    const rig = pivot(root, 0, 0, 0);
    this.rig = rig;

    const pelvis = pivot(rig, 0, 1.05, 0);
    this.pelvis = pelvis;
    const hipBlock = boxMesh(0.24, 0.18, 0.18, M.coatDark);
    hipBlock.position.y = -0.03;
    pelvis.add(hipBlock);

    const spine = pivot(pelvis, 0, 0.12, 0);
    this.spine = spine;
    const chest = pivot(spine, 0, 0.22, 0);
    this.chest = chest;

    // Narrow chest that tapers *up* to the shoulders rather than out.
    const torso = limb(0.36, 0.17, 0.13, M.coat, 6);
    torso.position.y = 0.08;
    torso.scale.z = 0.72;
    chest.add(torso);

    // The light plate is a narrow sternum column, not a yoke: on a body this
    // thin a horizontal light bar would make it read as broad.
    const sternum = boxMesh(0.11, 0.30, 0.08, M.plate);
    sternum.position.set(0, 0.02, 0.11);
    chest.add(sternum);
    const collar = boxMesh(0.30, 0.055, 0.18, M.plateMid);
    collar.position.set(0, 0.21, 0.01);
    chest.add(collar);
    const cellStrip = boxMesh(0.045, 0.20, 0.03, M.cell);
    cellStrip.position.set(0.09, 0.02, 0.14);
    chest.add(cellStrip);

    // Cape: a long mantle that splits into two tails. Loose enough that the
    // 1.35 cloth gain makes them swing visibly at a walk.
    const capePivot = pivot(chest, 0, 0.20, -0.02);
    this.cape = capePivot;
    const mantleGeo = new THREE.CylinderGeometry(0.20, 0.26, 0.30, 5, 1, true, Math.PI * 0.62, Math.PI * 0.92);
    mantleGeo.translate(0, -0.15, 0);
    const mantle = new THREE.Mesh(mantleGeo, M.cloak);
    mantle.castShadow = true;
    capePivot.add(mantle);
    for (const side of [-1, 1]) {
      const tail = boxMesh(0.16, 0.86, 0.035, M.cloth);
      tail.position.set(0.09 * side, -0.72, -0.20);
      tail.rotation.set(0.08, 0, -0.06 * side);
      tail.castShadow = true;
      capePivot.add(tail);
      const tip = boxMesh(0.16, 0.06, 0.035, M.accent);
      tip.position.set(0.09 * side, -1.14, -0.21);
      capePivot.add(tip);
    }
    // A single tall vane off the left shoulder blade — the asymmetric spike
    // that keeps the back from being a plain rectangle.
    const vane = boxMesh(0.035, 0.62, 0.13, M.metal);
    vane.position.set(-0.12, 0.22, -0.20);
    vane.rotation.set(-0.30, 0, 0.16);
    vane.castShadow = true;
    capePivot.add(vane);
    const vaneTip = boxMesh(0.05, 0.09, 0.05, M.cell);
    vaneTip.position.set(-0.20, 0.52, -0.31);
    capePivot.add(vaneTip);

    // Thigh wrap rather than a coat: two narrow panels that keep the legs
    // reading as one column from the front.
    const coatPivot = pivot(pelvis, 0, 0.04, 0);
    this.coat = coatPivot;
    for (const side of [-1, 1]) {
      const panel = boxMesh(0.14, 0.52, 0.05, M.cloth);
      panel.position.set(0.13 * side, -0.30, 0.05);
      panel.rotation.z = -0.05 * side;
      panel.castShadow = true;
      coatPivot.add(panel);
    }

    // The hood. A five-sided cone pitched forward over a dark inner face, with
    // the visor buried in the shadow of it — the apex of the whole silhouette.
    const neck = pivot(chest, 0, 0.30, 0);
    this.neck = neck;
    const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(0.135, 0), M.coatDark);
    skull.position.y = 0.13;
    skull.castShadow = true;
    neck.add(skull);
    const hoodGeo = new THREE.ConeGeometry(0.20, 0.42, 5);
    const hood = new THREE.Mesh(hoodGeo, M.plate);
    hood.position.set(0, 0.24, -0.03);
    hood.rotation.set(0.28, Math.PI / 5, 0);
    hood.castShadow = true;
    neck.add(hood);
    const brim = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.16, 5), M.plateMid);
    brim.position.set(0, 0.13, 0.03);
    brim.rotation.set(-0.5, Math.PI / 5, 0);
    neck.add(brim);
    const visor = boxMesh(0.15, 0.045, 0.05, M.visor);
    visor.position.set(0, 0.10, 0.12);
    neck.add(visor);
    this.visor = visor;
    // Long braid/cable out of the back of the hood, so the head is not a bare
    // cone from the camera's own angle.
    const braid = boxMesh(0.055, 0.40, 0.055, M.cloak);
    braid.position.set(0.04, 0.02, -0.16);
    braid.rotation.set(0.22, 0, -0.10);
    neck.add(braid);
    const bead = boxMesh(0.05, 0.05, 0.05, M.accent);
    bead.position.set(0.07, -0.17, -0.24);
    neck.add(bead);

    // Arms: long and wire-thin, with the only bulk at the elbow.
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const shoulder = pivot(chest, 0.185 * side, 0.20, 0);
      const pad = new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 0), M.coat);
      pad.scale.set(1.1, 0.85, 1.0);
      pad.castShadow = true;
      shoulder.add(pad);
      const capPlate = boxMesh(0.14, 0.055, 0.15, side < 0 ? M.plateMid : M.plate);
      capPlate.position.set(0.01 * side, 0.05, 0);
      capPlate.rotation.z = 0.2 * side;
      shoulder.add(capPlate);

      const upper = limb(0.32, 0.075, 0.045, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.32, 0);
      const fore = limb(0.30, 0.048, 0.038, M.coatDark);
      elbow.add(fore);
      const bracer = boxMesh(0.075, 0.16, 0.08, side < 0 ? M.plate : M.plateMid);
      bracer.position.y = -0.16;
      elbow.add(bracer);
      const hand = pivot(elbow, 0, -0.30, 0);
      const fist = boxMesh(0.07, 0.08, 0.085, M.body);
      hand.add(fist);
      this.arms[key] = { shoulder, elbow, hand };
    }

    // The rifle: one long straight line, deliberately over a metre so it
    // breaks the body outline at both ends.
    const gun = new THREE.Group();
    gun.position.set(0, -0.02, 0.02);
    this.arms.R.hand.add(gun);
    const receiver = boxMesh(0.065, 0.10, 0.46, M.gun);
    receiver.position.set(0, 0.02, 0.12);
    gun.add(receiver);
    const stock = boxMesh(0.06, 0.13, 0.22, M.coatDark);
    stock.position.set(0, -0.01, -0.20);
    gun.add(stock);
    const rail = boxMesh(0.05, 0.035, 0.34, M.plate);
    rail.position.set(0, 0.09, 0.10);
    gun.add(rail);
    // Scope: a chunky block with a lit objective — the identifying feature at
    // any distance where the barrel is still one pixel wide.
    const scope = boxMesh(0.075, 0.09, 0.24, M.plateMid);
    scope.position.set(0, 0.16, 0.08);
    gun.add(scope);
    const lens = boxMesh(0.055, 0.055, 0.03, M.cell);
    lens.position.set(0, 0.16, 0.21);
    gun.add(lens);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.62, 6), M.metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.04, 0.66);
    barrel.castShadow = true;
    gun.add(barrel);
    const brake = boxMesh(0.06, 0.06, 0.12, M.accent);
    brake.position.set(0, 0.04, 1.00);
    gun.add(brake);
    const grip = boxMesh(0.05, 0.15, 0.07, M.coatDark);
    grip.position.set(0, -0.09, -0.02);
    grip.rotation.x = -0.20;
    gun.add(grip);
    const bipod = boxMesh(0.14, 0.03, 0.10, M.metal);
    bipod.position.set(0, -0.03, 0.42);
    gun.add(bipod);
    this.gun = gun;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.04, 1.10);
    gun.add(this.muzzle);

    // Legs: long, thin, and light from the knee down so the stride reads.
    this.legs = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const hip = pivot(pelvis, 0.095 * side, -0.10, 0);
      const thigh = limb(0.48, 0.075, 0.055, M.coatDark);
      hip.add(thigh);
      const knee = pivot(hip, 0, -0.48, 0);
      const shin = limb(0.46, 0.06, 0.042, M.plate);
      knee.add(shin);
      const ankle = pivot(knee, 0, -0.46, 0);
      const boot = boxMesh(0.10, 0.09, 0.26, M.coatDark);
      boot.position.set(0, -0.03, 0.04);
      ankle.add(boot);
      const heel = boxMesh(0.09, 0.10, 0.06, M.plateMid);
      heel.position.set(0, -0.01, -0.10);
      ankle.add(heel);
      const toe = boxMesh(0.09, 0.04, 0.06, M.accent);
      toe.position.set(0, -0.055, 0.16);
      ankle.add(toe);
      this.legs[key] = { hip, knee, ankle };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* ROOK — the engineer.                                                    */
  /*                                                                         */
  /* Read: BOTTOM-HEAVY. A wide planted base under narrow shoulders and a     */
  /* small dome, with one thin mast out of the rack — the inverse of Anvil's  */
  /* top-heavy triangle, which is the pair that used to threshold at 0.80 IoU */
  /* to each other. Widest band is the boots, not the shoulders; the width    */
  /* profile therefore *grows* downward where every other rig on the roster   */
  /* shrinks, and that curve is what tells the two apart in pure black even   */
  /* though both are short and both are square.                               */
  /* ---------------------------------------------------------------------- */

  buildRook() {
    const M = this.mats;
    const root = new THREE.Group();
    this.group = root;
    this.blobScale = 1.25;
    // Stopped down with `cellGain`: the old 2.2 over a wrap-around visor band
    // put 3.4% of this rig above L=200 and flattened the whole head and chest
    // into one bright value.
    this.visorBase = 1.35;

    const rig = pivot(root, 0, 0, 0);
    this.rig = rig;

    const pelvis = pivot(rig, 0, 0.74, 0);
    this.pelvis = pelvis;
    // Wide hip block — this is where the mass lives on this rig.
    const hipBlock = boxMesh(0.46, 0.24, 0.30, M.coatDark);
    hipBlock.position.y = -0.04;
    pelvis.add(hipBlock);
    // Tool belt: four small pouches around the waist. Cheap, and it is the
    // detail that says "carries things" at close range.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.7;
      const pouch = boxMesh(0.12, 0.15, 0.10, i % 2 ? M.plateMid : M.coat);
      pouch.position.set(Math.sin(a) * 0.24, -0.06, Math.cos(a) * 0.18);
      pouch.rotation.y = a;
      pelvis.add(pouch);
    }

    const spine = pivot(pelvis, 0, 0.08, 0);
    this.spine = spine;
    const chest = pivot(spine, 0, 0.16, 0);
    this.chest = chest;

    // A rectangular torso — literally a box, where every other rig uses a
    // tapered cylinder. Flat-sided masses catch the key light in flat planes,
    // which is what makes this one read as hardware.
    // Narrowed from 0.46 to 0.36: the shoulders have to be the *narrow* end of
    // this rig for the base to read as the wide one.
    const torso = boxMesh(0.36, 0.40, 0.26, M.coat);
    torso.position.y = 0.16;
    chest.add(torso);
    const apron = boxMesh(0.33, 0.24, 0.09, M.plate);
    apron.position.set(0, 0.10, 0.16);
    chest.add(apron);
    // Was a 0.10 square panel of full-gain emissive; now a small lamp at half
    // gain, which is the difference between a light on a chest and a chest that
    // is a light.
    const gauge = boxMesh(0.055, 0.055, 0.03, M.cell);
    gauge.position.set(-0.11, 0.22, 0.21);
    chest.add(gauge);
    const hazard = boxMesh(0.24, 0.05, 0.03, M.accent);
    hazard.position.set(0.02, 0.02, 0.215);
    chest.add(hazard);

    // The rack. This is the character.
    const capePivot = pivot(chest, 0, 0.18, -0.02);
    this.cape = capePivot;
    const pack = boxMesh(0.34, 0.34, 0.22, M.coatDark);
    pack.position.set(0, -0.12, -0.23);
    capePivot.add(pack);
    const packFace = boxMesh(0.26, 0.14, 0.06, M.plateMid);
    packFace.position.set(0, -0.04, -0.35);
    capePivot.add(packFace);
    const packCell = boxMesh(0.16, 0.045, 0.04, M.cell);
    packCell.position.set(0, -0.20, -0.375);
    capePivot.add(packCell);
    // ONE tall mast, off-centre, plus one short stack on the other side. The
    // symmetric pair of raked stacks that used to be here read as a second set
    // of shoulders; a single thin vertical out of the top of the rack is a
    // shape nothing else on the roster has, and its off-centre placement is
    // what makes the crown of this silhouette asymmetric.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.045, 0.38, 5), M.metal);
    mast.castShadow = true;
    mast.position.set(-0.15, 0.22, -0.24);
    mast.rotation.set(-0.10, 0, 0.10);
    capePivot.add(mast);
    const mastLamp = boxMesh(0.055, 0.055, 0.055, M.cell);
    mastLamp.position.set(-0.18, 0.43, -0.21);
    capePivot.add(mastLamp);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.24, 5), M.metal);
    stack.castShadow = true;
    stack.position.set(0.17, 0.10, -0.26);
    stack.rotation.set(-0.24, 0, -0.30);
    capePivot.add(stack);
    const cowl = boxMesh(0.10, 0.07, 0.10, M.accent);
    cowl.position.set(0.23, 0.21, -0.29);
    capePivot.add(cowl);
    // Folded crane arm over the right shoulder: two segments at a hard angle,
    // reaching forward past the head. It is the asymmetry. Dropped 0.14 so it
    // folds at shoulder height instead of over the crown — the top band of this
    // silhouette has to be narrow (a small dome and one thin mast) for the base
    // to read as the wide end, and a claw up there made the crown as broad as
    // Anvil's pauldrons.
    const craneA = boxMesh(0.075, 0.34, 0.075, M.gun);
    craneA.position.set(0.20, 0.02, -0.16);
    craneA.rotation.set(0.5, 0, -0.18);
    craneA.castShadow = true;
    capePivot.add(craneA);
    const craneB = boxMesh(0.065, 0.30, 0.065, M.plateMid);
    craneB.position.set(0.23, 0.22, 0.05);
    craneB.rotation.set(1.25, 0, -0.18);
    craneB.castShadow = true;
    capePivot.add(craneB);
    const claw = boxMesh(0.09, 0.08, 0.14, M.accent);
    claw.position.set(0.25, 0.28, 0.22);
    capePivot.add(claw);

    // Short, wide work apron at the hips. It flares hard and stops high — the
    // flare is what makes the lower half of this rig the wide half, and
    // stopping at 0.22 is what leaves the legs visible below it. The hem is
    // two side bars for the same reason Anvil's is: a full-width plate closes
    // the inner-leg gap this rig is being graded on.
    const coatPivot = pivot(pelvis, 0, 0.02, 0);
    this.coat = coatPivot;
    const skirtGeo = new THREE.CylinderGeometry(0.26, 0.39, 0.24, 6, 1, true);
    skirtGeo.translate(0, -0.16, 0);
    const skirt = new THREE.Mesh(skirtGeo, M.shell);
    skirt.castShadow = true;
    coatPivot.add(skirt);
    for (const side of [-1, 1]) {
      const skirtHem = boxMesh(0.19, 0.06, 0.32, M.plateMid);
      skirtHem.position.set(0.24 * side, -0.28, 0);
      coatPivot.add(skirtHem);
    }

    // Head: a small dome, no crest, one wide green band. Small on purpose —
    // it is what makes the rack read as bigger than the person wearing it.
    const neck = pivot(chest, 0, 0.34, 0);
    this.neck = neck;
    const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(0.155, 0), M.plate);
    dome.scale.set(1.05, 0.9, 1.0);
    dome.position.y = 0.10;
    dome.castShadow = true;
    neck.add(dome);
    const collar = boxMesh(0.24, 0.09, 0.20, M.coatDark);
    collar.position.set(0, -0.02, 0);
    neck.add(collar);
    // A face strip and a rear pip, not a band around the whole skull. The wrap
    // version was 0.24 x 0.24 of emissive on a 0.155 head — the head *was* the
    // lamp, and the dome's own value never had a chance to read.
    const visor = boxMesh(0.14, 0.045, 0.05, M.visor);
    visor.position.set(0, 0.09, 0.11);
    neck.add(visor);
    this.visor = visor;
    const tail = boxMesh(0.06, 0.03, 0.03, M.cell);
    tail.position.set(0, 0.12, -0.13);
    neck.add(tail);
    const lamp = boxMesh(0.06, 0.05, 0.05, M.cell);
    lamp.position.set(-0.13, 0.15, 0.04);
    lamp.rotation.z = 0.4;
    neck.add(lamp);

    // Arms: short, thick, wrapped in tool bracers.
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const shoulder = pivot(chest, 0.20 * side, 0.24, 0);
      const pad = boxMesh(0.15, 0.14, 0.20, M.coat);
      pad.position.set(0.01 * side, 0.01, 0);
      pad.castShadow = true;
      shoulder.add(pad);
      const cap = boxMesh(0.17, 0.055, 0.22, side < 0 ? M.plate : M.plateMid);
      cap.position.set(0, 0.075, 0);
      shoulder.add(cap);

      const upper = limb(0.24, 0.10, 0.075, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.24, 0);
      const fore = limb(0.22, 0.085, 0.07, M.coatDark);
      elbow.add(fore);
      // Boxy bracer with a lit strip — reads as a wrist terminal.
      const bracer = boxMesh(0.13, 0.14, 0.13, M.plateMid);
      bracer.position.y = -0.13;
      elbow.add(bracer);
      const strip = boxMesh(0.09, 0.03, 0.02, M.cell);
      strip.position.set(0, -0.13, 0.07);
      elbow.add(strip);
      const hand = pivot(elbow, 0, -0.22, 0);
      const fist = boxMesh(0.10, 0.10, 0.11, M.body);
      hand.add(fist);
      this.arms[key] = { shoulder, elbow, hand };
    }

    // Rivet gun: short, fat and drum-fed. The opposite proportion to Kestrel's
    // rifle on purpose — the weapon silhouettes have to disagree too.
    const gun = new THREE.Group();
    gun.position.set(0, -0.02, 0.03);
    this.arms.R.hand.add(gun);
    const body = boxMesh(0.11, 0.15, 0.26, M.gun);
    body.position.set(0, 0.02, 0.07);
    gun.add(body);
    const shroud = boxMesh(0.14, 0.10, 0.16, M.plate);
    shroud.position.set(0, 0.09, 0.10);
    gun.add(shroud);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 6), M.plateMid);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, -0.05, 0.03);
    drum.castShadow = true;
    gun.add(drum);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.20, 6), M.metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.03, 0.28);
    barrel.castShadow = true;
    gun.add(barrel);
    const port = boxMesh(0.06, 0.03, 0.10, M.accent);
    port.position.set(0.06, 0.08, 0.14);
    gun.add(port);
    const glow = boxMesh(0.07, 0.025, 0.10, M.cell);
    glow.position.set(0, 0.02, 0.36);
    gun.add(glow);
    const grip = boxMesh(0.07, 0.16, 0.09, M.coatDark);
    grip.position.set(0, -0.10, -0.03);
    grip.rotation.x = -0.24;
    gun.add(grip);
    this.gun = gun;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.03, 0.42);
    gun.add(this.muzzle);

    // Legs: short and boxy, in heavy work boots.
    this.legs = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      // Planted wide: hips at 0.165 splayed a further 0.165 rad by POSE.rook
      // put the boots out past everything above them, which is the whole
      // bottom-heavy read.
      const hip = pivot(pelvis, 0.185 * side, -0.08, 0);
      const thigh = limb(0.32, 0.115, 0.095, M.coatDark);
      hip.add(thigh);
      const knee = pivot(hip, 0, -0.32, 0);
      const shin = limb(0.30, 0.105, 0.09, M.plate);
      knee.add(shin);
      const pad = boxMesh(0.16, 0.11, 0.12, M.plateMid);
      pad.position.set(0, -0.05, 0.05);
      knee.add(pad);
      const ankle = pivot(knee, 0, -0.30, 0);
      const boot = boxMesh(0.25, 0.15, 0.32, M.coatDark);
      boot.position.set(0, -0.055, 0.04);
      ankle.add(boot);
      const toe = boxMesh(0.24, 0.05, 0.09, M.accent);
      toe.position.set(0, -0.10, 0.18);
      ankle.add(toe);
      this.legs[key] = { hip, knee, ankle };
    }
  }

  /**
   * CINDER — the ash foreman.
   *
   * The roster's silhouettes are separated by *where the volume sits*, and the
   * four that already exist cover: even (Ranger), forward-hunched and
   * shoulder-heavy (Anvil), thin and tall (Kestrel), bottom-heavy with a rack
   * (Rook). The shape none of them makes is a hard **inverted triangle** — a
   * wide, high mass tapering into a narrow stance — so that is what this rig is.
   *
   * Three decisions carry it, and every one of them is a decision *not* to reuse
   * something the other four already own:
   *
   *  1. **Twin tanks worn high and wide.** They sit on the `cape` pivot, above
   *     the shoulder line and outboard of it, which puts the widest part of the
   *     rig at the very top. Rook's rack is the other back-mounted mass on the
   *     roster and it deliberately hangs *low and central*; these are the only
   *     two objects on the roster wider than the shoulders they are attached to.
   *  2. **No coat, no cape, no skirt.** The three other non-Ranger rigs each
   *     solve the hip region with cloth. This one leaves it bare and narrow so
   *     the taper actually reaches the ground — a skirt here would restore the
   *     wide base the whole shape exists to refuse. The `coat` pivot instead
   *     carries two heavy hose loops, which read as swinging weight rather than
   *     as fabric.
   *  3. **A forward, low head with a full respirator.** Ranger and Anvil have
   *     helmets, Kestrel a hood, Rook a small dome. A snouted mask thrust
   *     forward of the chest is a fifth head shape, and pushing it forward is
   *     what keeps a neck notch visible under tanks that would otherwise close
   *     over it — the exact failure the POSE table's shoulder-line note records.
   */
  buildCinder() {
    const M = this.mats;
    const root = new THREE.Group();
    this.group = root;
    // Narrow stance, narrow footprint. Rook's 1.25 disc under this rig's 0.13
    // hip splay would be a puddle the character stands in the middle of.
    this.blobScale = 0.92;
    // The mask lens is small (0.11 x 0.05) and sits under a brow, so it can
    // afford to run hotter than Rook's wrap band without taking the head's
    // value with it — this is the rig's one saturated face feature.
    this.visorBase = 1.7;

    const rig = pivot(root, 0, 0, 0);
    this.rig = rig;

    const pelvis = pivot(rig, 0, 0.92, 0);
    this.pelvis = pelvis;
    // Deliberately the narrowest hip block on the roster (Rook's is 0.46 wide).
    // The taper is only a taper if the bottom is actually small.
    const hipBlock = boxMesh(0.28, 0.20, 0.22, M.coatDark);
    hipBlock.position.y = -0.04;
    pelvis.add(hipBlock);
    // A single canted fuel bottle on one hip. One object, off-centre: the rig is
    // asymmetric at the top (see the pilot burner below) and repeating that at
    // the waist on the *same* side would read as a lean, so it goes on the other.
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.22, 6), M.plateMid);
    bottle.castShadow = true;
    bottle.position.set(-0.19, -0.02, -0.02);
    bottle.rotation.z = 0.34;
    pelvis.add(bottle);

    const spine = pivot(pelvis, 0, 0.09, 0);
    this.spine = spine;
    const chest = pivot(spine, 0, 0.19, 0);
    this.chest = chest;

    // Torso: a tapered barrel that is WIDER AT THE TOP. `limb` builds top-radius
    // to bottom-radius, so 0.25 over 0.15 is the inverse of every other rig's
    // torso in the file and is where the inverted triangle actually begins.
    const torso = limb(0.38, 0.25, 0.15, M.coat, 6);
    torso.position.y = 0.08;
    torso.scale.z = 0.86;
    chest.add(torso);

    // The brass breastplate. This rig's light value is a saturated metal, so it
    // is kept to one large flat panel rather than being scattered — a saturated
    // plate broken into pieces stops being a value and becomes noise.
    const breast = boxMesh(0.30, 0.24, 0.10, M.plate);
    breast.position.set(0, 0.02, 0.15);
    chest.add(breast);
    const collarPlate = boxMesh(0.44, 0.075, 0.24, M.plateMid);
    collarPlate.position.set(0, 0.20, 0.01);
    chest.add(collarPlate);
    // Burner bank: three small lamps in a row across the chest. Small and
    // separated on purpose — see the `cellGain` note in the palette.
    for (let i = -1; i <= 1; i++) {
      const lamp = boxMesh(0.045, 0.045, 0.03, M.cell);
      lamp.position.set(i * 0.09, -0.06, 0.205);
      chest.add(lamp);
    }

    // --- the tanks -------------------------------------------------------
    // Rides the `cape` pivot so the animator's cloth swing drives it (heavily
    // damped by CLOTH_GAIN — these are strapped down, not hanging).
    const harness = pivot(chest, 0, 0.20, -0.02);
    this.cape = harness;
    const yoke = boxMesh(0.50, 0.10, 0.14, M.coatDark);
    yoke.position.set(0, 0.02, -0.10);
    harness.add(yoke);
    for (const side of [-1, 1]) {
      // Outboard of the shoulder pivots (0.19) and above the shoulder line —
      // this pair is the widest and highest thing on the rig, which is the
      // entire silhouette claim.
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.115, 0.46, 7), M.plate);
      tank.castShadow = true;
      tank.position.set(0.26 * side, 0.06, -0.19);
      tank.rotation.set(0.16, 0, -0.13 * side);
      harness.add(tank);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.10, 0.07, 7), M.metal);
      cap.castShadow = true;
      cap.position.set(0.29 * side, 0.30, -0.22);
      cap.rotation.z = -0.13 * side;
      harness.add(cap);
      // Dark strap across each tank: without it the two brass cylinders and the
      // brass breastplate are one continuous light mass from the side.
      const strap = boxMesh(0.24, 0.05, 0.20, M.coatDark);
      strap.position.set(0.26 * side, 0.02, -0.19);
      harness.add(strap);
    }
    // Pilot light on one cap only. The single asymmetry in the crown, and the
    // cue that says which end of the harness is live.
    const pilot = boxMesh(0.05, 0.06, 0.05, M.cell);
    pilot.position.set(-0.29, 0.37, -0.22);
    harness.add(pilot);
    // Manifold bridging the two tanks, low and central, so the pair reads as one
    // piece of equipment rather than as two objects that happen to be adjacent.
    const manifold = boxMesh(0.40, 0.07, 0.09, M.gun);
    manifold.position.set(0, -0.14, -0.20);
    harness.add(manifold);

    // --- hoses -----------------------------------------------------------
    // The `coat` pivot. Two heavy loops off the manifold down to the hips: the
    // one piece of this rig that is allowed to swing hard, and the reason the
    // waist is not simply empty where every other survivor has fabric.
    const hoses = pivot(pelvis, 0, 0.16, 0);
    this.coat = hoses;
    for (const side of [-1, 1]) {
      const geo = new THREE.TorusGeometry(0.12, 0.032, 4, 8, Math.PI * 1.2);
      const hose = new THREE.Mesh(geo, M.cloth);
      hose.castShadow = true;
      hose.position.set(0.16 * side, -0.02, -0.14);
      hose.rotation.set(0.5, 0.35 * side, 0.3 * side);
      hoses.add(hose);
    }

    // --- head ------------------------------------------------------------
    const neck = pivot(chest, 0, 0.34, 0);
    this.neck = neck;
    // Pushed forward (+z) rather than sat on top: the tanks close over anything
    // directly above the collar, and a head that vanishes into the crown is the
    // headless-lump failure the Ranger's yoke comment records.
    const skull = boxMesh(0.20, 0.18, 0.19, M.coatDark);
    skull.position.set(0, 0.10, 0.035);
    skull.castShadow = true;
    neck.add(skull);
    const brow = boxMesh(0.22, 0.05, 0.15, M.plateMid);
    brow.position.set(0, 0.185, 0.05);
    neck.add(brow);
    // The snout. A short cone thrown forward of the face — the fifth head shape
    // on the roster and the only one with anything sticking out of it.
    const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.085, 0.16, 6), M.metal);
    snout.castShadow = true;
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, 0.055, 0.17);
    neck.add(snout);
    const filter = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 6), M.plate);
    filter.rotation.x = Math.PI / 2;
    filter.position.set(0, 0.055, 0.245);
    neck.add(filter);
    const visor = boxMesh(0.11, 0.05, 0.04, M.visor);
    visor.position.set(0, 0.135, 0.135);
    neck.add(visor);
    this.visor = visor;

    // --- arms ------------------------------------------------------------
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const shoulder = pivot(chest, 0.19 * side, 0.22, 0);
      // No pauldron. Anvil owns the big shoulder plate, and the tanks are
      // already the wide thing up here — a pad as well would weld the whole
      // upper body into one bar.
      const guard = boxMesh(0.115, 0.10, 0.16, M.coatDark);
      guard.position.set(0.01 * side, 0.02, 0);
      guard.castShadow = true;
      shoulder.add(guard);

      const upper = limb(0.26, 0.075, 0.06, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.26, 0);
      const fore = limb(0.24, 0.07, 0.055, M.coatDark);
      elbow.add(fore);
      // Long brass cuff down the forearm rather than a boxy bracer: it repeats
      // the tanks' vertical cylinder at limb scale, which ties the two ends of
      // the rig together without adding a new shape.
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.055, 0.16, 6), M.plateMid);
      cuff.castShadow = true;
      cuff.position.y = -0.16;
      elbow.add(cuff);
      const hand = pivot(elbow, 0, -0.24, 0);
      const fist = boxMesh(0.085, 0.09, 0.10, M.body);
      hand.add(fist);
      this.arms[key] = { shoulder, elbow, hand };
    }

    // --- the igniter -----------------------------------------------------
    // A long thin wand, not a gun body. Ranger's carbine, Kestrel's rifle and
    // Rook's drum-fed rivet gun are all breeched weapons with a receiver; this
    // has none — it is a pipe with a flared bell and a pilot flame, so the
    // weapon silhouette disagrees with the roster too.
    const gun = new THREE.Group();
    gun.position.set(0, -0.02, 0.03);
    this.arms.R.hand.add(gun);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.038, 0.46, 6), M.gun);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(0, 0.02, 0.20);
    pipe.castShadow = true;
    gun.add(pipe);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.042, 0.13, 7, 1, true), M.plate);
    bell.rotation.x = -Math.PI / 2;
    bell.position.set(0, 0.02, 0.44);
    bell.castShadow = true;
    gun.add(bell);
    const pilotRing = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 4, 10), M.cell);
    pilotRing.position.set(0, 0.02, 0.40);
    gun.add(pilotRing);
    const feed = boxMesh(0.05, 0.06, 0.16, M.plateMid);
    feed.position.set(0, -0.03, 0.06);
    gun.add(feed);
    const grip = boxMesh(0.06, 0.15, 0.08, M.coatDark);
    grip.position.set(0, -0.10, -0.01);
    grip.rotation.x = -0.2;
    gun.add(grip);
    this.gun = gun;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.02, 0.52);
    gun.add(this.muzzle);

    // --- legs ------------------------------------------------------------
    // Long, thin, close together, in low boots. Everything about them is the
    // opposite of Rook's, because the taper has to survive all the way down.
    this.legs = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const hip = pivot(pelvis, 0.115 * side, -0.08, 0);
      const thigh = limb(0.36, 0.095, 0.07, M.coatDark);
      hip.add(thigh);
      const knee = pivot(hip, 0, -0.36, 0);
      const shin = limb(0.34, 0.075, 0.06, M.coat);
      knee.add(shin);
      // One brass shin guard per leg. The lower body needs a single bright mark
      // or the whole bottom third of the rig sits in the terrain's value range —
      // the failure the `coat` material's rim/hemi comment was written for.
      const guard = boxMesh(0.10, 0.20, 0.07, M.plateMid);
      guard.position.set(0, -0.16, 0.055);
      knee.add(guard);
      const ankle = pivot(knee, 0, -0.34, 0);
      const boot = boxMesh(0.155, 0.11, 0.26, M.coatDark);
      boot.position.set(0, -0.045, 0.03);
      ankle.add(boot);
      this.legs[key] = { hip, knee, ankle };
    }
  }

  /**
   * Shared rig tail: receive-shadow flags and the contact decal. Every body kit
   * ends here, so a new survivor cannot ship without a ground contact cue.
   */
  _finish() {
    const root = this.group;
    root.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });

    // Contact shadow. The stage's shadow map is one cascade over a big stage,
    // so the survivor's own cast shadow is soft to the point of absence right
    // under the feet — which is exactly where the eye looks for the ground
    // plane. This blob is what tells you the character is standing on the rock
    // rather than floating in front of it. One draw call, no shadow-map cost.
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    this.blobMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0.9 } },
      vertexShader: BLOB_VERT,
      fragmentShader: BLOB_FRAG,
      transparent: true,
      depthWrite: false,
      // Multiply, so the decal can only darken the floor it lands on.
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    const blob = new THREE.Mesh(blobGeo, this.blobMat);
    // Tight to the stance. At 1.15 the disc projected ~100 px against a 37 px
    // foot span and ran off the lip of whatever rock the survivor was standing
    // on, so the terrain clipped its uphill half and the remainder read as an
    // offset smear. 1.0 is the compromise: ~60 px under a 110 px survivor, wide
    // enough to read as a footprint now that the alpha carries, still inside the
    // stance so a sloped facet cannot eat half of it.
    // Footprint follows the stance: Anvil plants far wider than Kestrel, and
    // one shared disc would be an offset smear under one of them.
    blob.scale.setScalar(this.blobScale);
    blob.position.y = 0.05;
    blob.renderOrder = -1;
    blob.castShadow = false;
    blob.receiveShadow = false;
    root.add(blob);
    this.blob = blob;
  }

  initState() {
    this.phase = 0;
    this.bodyYaw = 0;
    this.time = 0;

    // Springs: every cross-state blend goes through one of these.
    this.sSpeed = new Spring(0, 11);       // 0..1 locomotion intensity
    this.sAir = new Spring(0, 13);         // 0..1 airborne blend
    this.sRise = new Spring(0, 9);         // -1 falling .. +1 rising
    this.sDash = new Spring(0, 20);        // 0..1 dash pose
    this.sAimYaw = new Spring(0, 22);      // upper-body twist (rad)
    this.sAimPitch = new Spring(0, 20);
    this.sLean = new Spring(0, 8);         // forward lean from accel
    this.sStrafe = new Spring(0, 9);
    this.sRecoil = new Spring(0, 34, 0.55); // underdamped: snaps back with a kick
    this.sSprint = new Spring(0, 8);

  }

  /** World-space muzzle position, for tracers and flashes. */
  getMuzzle(out) {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  /** Additive kick, 1.0 = full primary shot. */
  addRecoil(amount = 1) {
    this.sRecoil.vel -= amount * 26;
  }

  /**
   * @param {number} dt seconds (presentation time)
   * @param {object} s  { velocity, grounded, aimYaw, aimPitch, dashT, sprint, dead }
   */
  update(dt, s) {
    this.time += dt;
    const vel = s.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    const moveSpeedRef = s.moveSpeed || 7;
    const norm = clamp(speed / moveSpeedRef, 0, 1.6);

    const grounded = s.grounded;
    this.sSpeed.step(grounded ? norm : norm * 0.35, dt);
    this.sAir.step(grounded ? 0 : 1, dt);
    this.sRise.step(grounded ? 0 : clamp(vel.y / 7, -1, 1), dt);
    this.sDash.step(s.dashT || 0, dt);
    this.sSprint.step(s.sprint ? 1 : 0, dt);
    const recoil = this.sRecoil.step(0, dt);

    // --- body facing -------------------------------------------------------
    // Face the movement direction while moving, the aim direction when not.
    // The upper body then twists back toward the aim — that decoupling is most
    // of what makes the character read while strafing.
    let desiredYaw = s.aimYaw;
    if (speed > 0.8) {
      const moveYaw = Math.atan2(vel.x, vel.z);
      // Blend toward aim so backpedalling doesn't spin the model around.
      let d = wrapPi(moveYaw - s.aimYaw);
      d = clamp(d, -1.15, 1.15);
      desiredYaw = s.aimYaw + d;
    }
    const turnRate = 1 - Math.exp(-dt / 0.075);
    this.bodyYaw += wrapPi(desiredYaw - this.bodyYaw) * turnRate;
    this.group.rotation.y = this.bodyYaw;

    const aimYawLocal = clamp(wrapPi(s.aimYaw - this.bodyYaw), -1.3, 1.3);
    this.sAimYaw.step(aimYawLocal, dt);
    this.sAimPitch.step(clamp(s.aimPitch, -1.1, 1.1), dt);

    // Lean: project velocity into body space, lean into acceleration.
    const cos = Math.cos(-this.bodyYaw), sin = Math.sin(-this.bodyYaw);
    const localZ = vel.z * cos - vel.x * sin;
    const localX = vel.x * cos + vel.z * sin;
    this.sLean.step(clamp(localZ / moveSpeedRef, -1, 1), dt);
    this.sStrafe.step(clamp(localX / moveSpeedRef, -1, 1), dt);

    const S = this.sSpeed.value;
    const air = this.sAir.value;
    const rise = this.sRise.value;
    const dash = this.sDash.value;
    const ground = 1 - air;

    // --- 1/2. locomotion ---------------------------------------------------
    // Frequency and amplitude both ride on speed: a slow walk is long and low,
    // a sprint is fast and tall. 2*PI*(0.75 + speed*0.42) lands at ~2.1Hz at
    // walk (7 m/s) and ~2.9Hz sprinting, which is where the footfalls stop
    // looking like skating.
    const stepFreq = 0.75 + norm * 1.35;
    this.phase += dt * stepFreq * Math.PI * 2 * (grounded ? 1 : 0.25);
    const p = this.phase;
    const amp = S;

    const swing = Math.sin(p);
    const swing2 = Math.sin(p + Math.PI);

    const legs = this.legs;
    // Thigh swing; knee only ever bends backwards (max(0,...)) so it never
    // hyperextends, and the bend peaks just after the leg passes under the hip.
    legs.L.hip.rotation.x = swing * 0.72 * amp;
    legs.R.hip.rotation.x = swing2 * 0.72 * amp;
    legs.L.knee.rotation.x = -Math.max(0, -Math.sin(p - 0.7)) * 1.15 * amp - 0.06;
    legs.R.knee.rotation.x = -Math.max(0, -Math.sin(p - 0.7 + Math.PI)) * 1.15 * amp - 0.06;
    // Foot planting: ankle counter-rotates so the sole stays flat through the
    // contact half of the cycle, then toes off.
    legs.L.ankle.rotation.x = (-swing * 0.35 + Math.max(0, swing) * 0.30) * amp;
    legs.R.ankle.rotation.x = (-swing2 * 0.35 + Math.max(0, swing2) * 0.30) * amp;
    // Stance. Negative on the left / positive on the right splays the legs
    // apart; the old +0.04/-0.04 pair did the exact opposite and closed the
    // inner-leg gap. The ankle counter-rotates by the same angle so a wide
    // stance still plants both soles flat on the ground.
    const P = this.pose;
    legs.L.hip.rotation.z = -P.stance + swing * 0.05 * amp;
    legs.R.hip.rotation.z = P.stance - swing2 * 0.05 * amp;
    legs.L.ankle.rotation.z = P.stance;
    legs.R.ankle.rotation.z = -P.stance;

    // Hip counter-rotation + chest counter-counter-rotation.
    this.pelvis.rotation.y = -swing * 0.20 * amp;
    this.pelvis.rotation.z = swing * 0.05 * amp;
    // Double-frequency vertical bob (two footfalls per cycle) + lateral sway.
    const bob = -Math.abs(Math.cos(p)) * 0.055 * amp;
    this.rig.position.y = bob + this.sDash.value * -0.14;
    this.rig.position.x = Math.sin(p) * 0.018 * amp;

    // --- 3. airborne -------------------------------------------------------
    // Rising = tuck (knees up, arms in), falling = reach (legs trail, arms out).
    if (air > 0.001) {
      const tuck = clamp(rise, 0, 1);
      const fall = clamp(-rise, 0, 1);
      const hipAir = lerp(0.35, -0.30, fall) + tuck * 0.55;
      const kneeAir = -(0.15 + tuck * 1.25 + fall * 0.35);
      legs.L.hip.rotation.x = lerp(legs.L.hip.rotation.x, hipAir + 0.18, air);
      legs.R.hip.rotation.x = lerp(legs.R.hip.rotation.x, hipAir - 0.22, air);
      legs.L.knee.rotation.x = lerp(legs.L.knee.rotation.x, kneeAir, air);
      legs.R.knee.rotation.x = lerp(legs.R.knee.rotation.x, kneeAir * 0.7, air);
      legs.L.ankle.rotation.x = lerp(legs.L.ankle.rotation.x, 0.35 - fall * 0.5, air);
      legs.R.ankle.rotation.x = lerp(legs.R.ankle.rotation.x, 0.35 - fall * 0.5, air);
      this.pelvis.rotation.x = lerp(this.pelvis.rotation.x, tuck * 0.22 - fall * 0.12, air);
    } else {
      this.pelvis.rotation.x = 0;
    }

    // --- 4. dash -----------------------------------------------------------
    if (dash > 0.001) {
      legs.L.hip.rotation.x = lerp(legs.L.hip.rotation.x, 0.95, dash);
      legs.R.hip.rotation.x = lerp(legs.R.hip.rotation.x, -0.35, dash);
      legs.L.knee.rotation.x = lerp(legs.L.knee.rotation.x, -1.5, dash);
      legs.R.knee.rotation.x = lerp(legs.R.knee.rotation.x, -0.9, dash);
      this.pelvis.rotation.x = lerp(this.pelvis.rotation.x, 0.30, dash);
    }

    // --- torso: lean, sprint crouch, dash tilt -----------------------------
    const lean = this.sLean.value;
    const sprint = this.sSprint.value;
    this.spine.rotation.x = P.lean + ground * (lean * 0.16 + sprint * 0.14 * S) + dash * 0.30 + air * 0.05;
    this.spine.rotation.z = -this.sStrafe.value * 0.10;

    // --- 5. upper-body aim override ----------------------------------------
    // Chest takes most of the twist, neck takes the remainder, so the head
    // always ends up on the aim direction regardless of what the legs do.
    const ay = this.sAimYaw.value;
    const ap = this.sAimPitch.value;
    this.chest.rotation.y = ay * 0.62 + swing * 0.16 * amp; // arm swing counter-rot
    this.chest.rotation.x = -ap * 0.32 - recoil * 0.10;
    this.chest.rotation.z = this.sStrafe.value * 0.06;
    this.neck.rotation.y = ay * 0.38;
    this.neck.rotation.x = -ap * 0.55 - this.spine.rotation.x * 0.6 + recoil * 0.14;

    const armL = this.arms.L, armR = this.arms.R;
    // Idle/run arm swing (opposite the legs).
    const swingArm = -swing * 0.62 * amp;
    armL.shoulder.rotation.x = swingArm * -1;
    armR.shoulder.rotation.x = swingArm;
    armL.shoulder.rotation.z = -P.armZ - amp * 0.05;
    armR.shoulder.rotation.z = P.armZ + amp * 0.05;
    armL.elbow.rotation.x = P.elbow - amp * 0.45;
    armR.elbow.rotation.x = P.elbow - amp * 0.45;

    if (air > 0.001) {
      const fall = clamp(-rise, 0, 1);
      armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, -0.9 - fall * 0.5, air * 0.8);
      armL.shoulder.rotation.z = lerp(armL.shoulder.rotation.z, -0.45 - fall * 0.35, air);
      armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, -1.3 + fall * 0.6, air);
    }

    // The weapon arm ignores all of the above and points down the aim ray.
    // -PI/2 about X swings the down-hanging arm to model-forward (+Z); the
    // residual aim pitch/yaw is what the chest didn't already absorb.
    const resYaw = ay - this.chest.rotation.y;
    const resPitch = -ap - this.chest.rotation.x;
    const aimWeight = 1 - dash * 0.75;
    armR.shoulder.rotation.x = lerp(armR.shoulder.rotation.x, -Math.PI / 2 + resPitch + recoil * 0.55, aimWeight);
    armR.shoulder.rotation.y = lerp(armR.shoulder.rotation.y, resYaw * 0.9 + P.gunY, aimWeight);
    // Held out from the ribs rather than against them. The weapon arm is the
    // one the aim override owns outright, so if the daylight either side of the
    // torso is going to survive it has to be put back here — a flat 0.06 tucked
    // the gun arm into the coat on every rig regardless of what it was holding.
    armR.shoulder.rotation.z = lerp(armR.shoulder.rotation.z, P.gunZ, aimWeight);
    armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, -0.20 + recoil * 0.35, aimWeight);
    // Support hand drifts toward the weapon while firing.
    const support = clamp(-recoil * 2.5, 0, 1);
    armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, -Math.PI / 2 + resPitch * 0.9, support * 0.7);
    armL.shoulder.rotation.y = lerp(armL.shoulder.rotation.y, resYaw * 0.8 + 0.30, support * 0.7);
    armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, -0.7, support * 0.7);

    // --- 6. cloth ----------------------------------------------------------
    // Coat trails the motion: driven by local velocity, not by the animation
    // phase, so it also reacts to dashes and knockback.
    const flutter = Math.sin(this.time * 9 + p) * 0.03 * (0.3 + norm);
    const gCoat = this.cloth.coat, gCape = this.cloth.cape;
    this.coat.rotation.x = (-this.sLean.value * 0.30 - air * 0.10 + flutter) * gCoat;
    this.coat.rotation.z = this.sStrafe.value * 0.24 * gCoat;
    this.cape.rotation.x = (-0.06 - this.sLean.value * 0.55 - dash * 0.5 + flutter * 1.6) * gCape;
    this.cape.rotation.z = this.sStrafe.value * 0.35 * gCape;

    // Contact shadow: full strength on the ground, gone by the top of a jump.
    // The blob rides the root, which does not know the terrain height, so
    // fading it out is what keeps it from following the character into the air.
    const grounded01 = (1 - air) * (1 - air);
    this.blobMat.uniforms.uFade.value = 0.9 * grounded01;
    this.blob.visible = grounded01 > 0.02;
    this.blob.scale.setScalar(this.blobScale + air * 0.3);

    // Visor pulses hot on fire — cheap but it sells the shot from behind.
    this.mats.visor.emissiveIntensity = this.visorBase + clamp(-recoil, 0, 1) * 3.5;
  }

  setVisible(v) { this.group.visible = v; }
}

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
