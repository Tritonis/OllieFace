/**
 * The corruption's claim on a *figure*.
 *
 * The world pass (src/shaders/BlightMask.js) builds its field from the WORLD
 * position of the fragment, which is correct for ground, rock and props: they
 * do not move, so a world-fixed field is welded to them. Attach that same pass
 * to a survivor or a monster and the figure swims through a stationary pattern
 * — the corruption reads as a projector shining on the arena rather than as
 * something that has taken the creature. Style-guide rule 2 ("the ochre object
 * with the void's claim over it") fails by that route just as surely as it
 * fails by a palette shift.
 *
 * So this pass keeps the world pass's field, its noise family and its palette,
 * and changes exactly one thing: the pattern is sampled in OBJECT space, from
 * `transformed` before `modelMatrix` ever touches it. The claim is authored on
 * the rig, walks with the rig, and turns when the rig turns.
 *
 * COVERAGE — *how much* of the figure is claimed — still comes from the world,
 * but from ONE world point per figure: `uCbAnchor`, the rig root, evaluated
 * once through `blightMask()`. A creature is claimed as a creature.
 *
 * It used to be evaluated per vertex at each vertex's own world position, and
 * that was a real defect (#101). `blightMask` reads only `wp.xz`, so the
 * gradient over one figure was bounded by that figure's horizontal footprint —
 * the five survivor rigs span 0.82 m to 1.49 m in XZ (asserted by
 * tests/character-blight.test.mjs so the number cannot drift) — while the
 * coverage transition band at the smallest patch (`RADIUS.base = 2.0` in
 * src/systems/Blight.js, feathered from `edge` to `edge * 0.72`) is only about
 * 0.56 m wide. The band was narrower than *every* rig, so a figure on a patch
 * rim split across its own body.
 *
 * A single anchor is only possible because the anchor uniform is genuinely
 * per-rig. Three uploads `onBeforeCompile` uniforms only under `refreshMaterial`
 * (three.module.js:18701-18745), which fires on a material-id change
 * (:18530-18536), and both `onBeforeRender` hooks run before `setProgram`
 * (:18120, :18125) — so pushing an anchor onto a material SHARED across the
 * horde would render the whole horde with whichever rig wrote last. The fix is
 * therefore per-rig material *instances*: `EnemyMeshes.matsFor` is a template
 * and each rig clones its four materials once (bounded by the rig pool, not by
 * spawn count); survivors already build their own set per CharacterMesh.
 * `cloneCharacterBlightMaterial` and `bindCharacterBlightAnchor` below are the
 * two halves of that. An identical `customProgramCacheKey` keeps one compiled
 * program shared across every clone.
 *
 * Anchoring per rig also removes the limb-popping the per-vertex form was
 * chosen to avoid: every limb of a rig reads the same anchor, so nothing pops
 * limb by limb, and the anchor itself moves continuously as the figure walks.
 *
 * NOTHING HERE ADDS GEOMETRY, GLOW-AROUND-THE-EDGE, OR AN OUTLINE. The pass
 * only rewrites `diffuseColor` and adds a vein emissive strictly inside the
 * existing surface, so a black-thresholded silhouette is bit-identical to what
 * it was — the readability work of #20 and style-guide rule 5 is untouched.
 */
import * as THREE from 'three';
import { MASK_UNIFORMS, MASK_FIELD } from './BlightMask.js';

/** material -> its private rig-anchor uniform. See `attachCharacterBlight`. */
const ANCHORS = new WeakMap();

/** Declarations shared by both stages, plus this pass's own interpolators. */
const CB_VARYING = /* glsl */ `
varying vec3 vCbObj;
varying float vCbCover;`;

const CB_VERT_DECL = /* glsl */ `#include <common>
${CB_VARYING}
uniform vec3 uCbAnchor;
${MASK_FIELD}`;

// `transformed` is the object-space vertex after begin_vertex/morph/skinning,
// which is what makes the pattern follow a deforming rig instead of sliding
// over it. Coverage is read at the rig's own anchor instead — one world point
// for the whole figure — so it stays constant across the interpolation and the
// creature is claimed as one thing.
const CB_VERT = /* glsl */ `#include <project_vertex>
{
  vCbObj = transformed;
  vCbCover = blightMask(uCbAnchor);
}`;

const CB_FRAG_DECL = /* glsl */ `#include <common>
${CB_VARYING}
${MASK_FIELD}`;

/** Applied at `<emissivemap_fragment>` — the same anchor RimStandardMaterial
 *  uses, and it chains under that hook rather than replacing it. */
export const CB_APPLY = /* glsl */ `
if (uBlightCount > 0) {
  // Derivatives are taken above the coverage test on purpose: vCbCover is an
  // interpolated value, so a branch on it is non-uniform control flow and a
  // derivative inside it is undefined by the GLSL spec.
  vec3 cbDX = dFdx(vCbObj), cbDY = dFdy(vCbObj);
  float cbFW = max(length(cbDX), length(cbDY));
  vec3 cbX = cross(cbDX, cbDY);
  vec3 cbN = length(cbX) > 1e-12 ? normalize(cbX) : vec3(0.0, 1.0, 0.0);
  if (vCbCover > 0.001) {
    // The world pass's palette, unchanged: as sRGB, fill #3a2349, vein #6d48bc.
    const vec3 CB_TINT = vec3(0.0419, 0.0166, 0.0665);
    const vec3 CB_VEIN = vec3(0.1522, 0.0640, 0.5040);
    // Object-space warp. A figure is ~1.8 m tall against a stage tens of metres
    // across, so the field runs about three times finer than the ground's: the
    // finest octave's period is 1 / (1.4 * 4.11) = 0.174 m, which puts several
    // vein widths across a torso instead of one wash. The warp animates, so the
    // claim writhes on the body rather than being a decal painted on it.
    vec2 cbP = vCbObj.xz;
    vec2 cbW = vec2(bmFbm(cbP * 0.9 + vec2(0.0, uBlightTime * 0.045)),
                    bmFbm(cbP * 0.9 + vec2(4.7, -uBlightTime * 0.035)));
    float cbK = 1.0 - smoothstep(0.20, 0.55, cbFW / 0.174);
    float cbF = bmTri(vCbObj, cbN, (cbW - 0.5) * 2.2, 1.4, cbK);
    float cbVein = smoothstep(0.040, 0.006, abs(cbF - 0.5)) * vCbCover;
    // One field, two reads, as on the ground: the ridge is filament, the body
    // is the claim. The band is centred a little below the world pass's 0.80
    // and stops well short of 1.0 — a figure must stay its own colour under the
    // corruption or the cast stops being told apart by hue at all, and rule 2's
    // "ochre object with a claim over it" becomes a violet object.
    float cbClaim = smoothstep(0.30, 0.70, cbF);
    diffuseColor.rgb = mix(diffuseColor.rgb, CB_TINT, vCbCover * mix(0.46, 0.82, cbClaim));
    totalEmissiveRadiance += CB_VEIN * cbVein * (0.26 + 0.08 * uBlightBand);
  }
}
`;

/**
 * Patch one character/enemy material. Chains any hook already installed —
 * RimStandardMaterial's rim and hemi terms inject at the same anchor, and
 * clobbering them would strip every survivor and monster of the two view-space
 * terms that keep them off the terrain's value range.
 */
export function attachCharacterBlight(material) {
  // Idempotent: a second attach would redeclare the varyings (a GLSL error,
  // i.e. a black cast) and double the cache-key suffix.
  // The two passes declare the same field helpers, so a material carrying both
  // would fail to compile on the redeclaration. World surfaces take the world
  // pass; figures take this one.
  if (!material || material.userData.charBlight || material.userData.blightMask) return material;
  material.userData.charBlight = true;
  // The one uniform that must NOT be shared: this material instance's rig
  // anchor. Held in a WeakMap and deliberately NOT on `userData`, because
  // `Material.copy` round-trips userData through JSON — a bare `clone()` would
  // otherwise hand the binder a Vector3 flattened to a plain {x,y,z} and throw
  // on the first frame. Off the material, a clone that lost the hook loses the
  // anchor with it, which is the only consistent pair.
  const anchor = { value: new THREE.Vector3() };
  ANCHORS.set(material, anchor);
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, MASK_UNIFORMS);
    shader.uniforms.uCbAnchor = anchor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', CB_VERT_DECL)
      .replace('#include <project_vertex>', CB_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', CB_FRAG_DECL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + CB_APPLY);
  };
  const prevKey = typeof material.customProgramCacheKey === 'function'
    ? material.customProgramCacheKey.bind(material) : null;
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|charblight';
  return material;
}

/**
 * A private copy of a blighted material, for one rig.
 *
 * `Material.copy` deep-copies `userData` through JSON (Material.js:1172) and
 * copies neither `onBeforeCompile` nor `customProgramCacheKey`, so a bare
 * `clone()` arrives carrying a dead `charBlight: true` flag, a Vector3 flattened
 * to `{x,y,z}`, and no hook at all. Both stale entries are dropped and the pass
 * is re-attached, which also mints this copy its own anchor. Any hook living on
 * the material's *prototype* (RimStandardMaterial's rim/hemi terms) is untouched
 * by the clone and gets chained under again.
 *
 * The cache key is identical to the template's, so every clone shares one
 * compiled program — this costs material objects, not shader compiles.
 */
export function cloneCharacterBlightMaterial(material) {
  const copy = material.clone();
  delete copy.userData.charBlight;
  return attachCharacterBlight(copy);
}

/** This material's anchor uniform, or undefined if it does not carry the pass. */
export function characterBlightAnchor(material) {
  return material ? ANCHORS.get(material) : undefined;
}

/**
 * Point one mesh's coverage at the rig it belongs to.
 *
 * The write happens in `onBeforeRender`, which is legal here for exactly one
 * reason: the material is the rig's own. Three refreshes a material's custom
 * uniforms when `material.id` changes, so each rig's clone gets its own upload
 * carrying its own anchor. On a SHARED material the same hook would be a bug —
 * every rig would write the one uniform and the horde would render with
 * whichever wrote last (see the file header).
 *
 * The material is read at call time rather than captured, so a reference swap
 * (the hit FLASH, an affix change) is followed. A material with no anchor —
 * FLASH, auras, wards — is simply skipped.
 */
export function bindCharacterBlightAnchor(mesh, root) {
  mesh.onBeforeRender = function () {
    const u = ANCHORS.get(this.material);
    if (u) u.value.setFromMatrixPosition(root.matrixWorld);
  };
  return mesh;
}
