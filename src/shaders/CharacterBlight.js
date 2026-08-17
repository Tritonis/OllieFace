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
 * COVERAGE — *how much* of the figure is claimed — still comes from the world:
 * it is `blightMask()` evaluated per vertex at the world position, computed in
 * the vertex shader and interpolated. Two consequences worth stating, because
 * both were deliberate:
 *   - `blightMask` reads only `wp.xz`, so the gradient over one figure is
 *     bounded by that figure's horizontal footprint. **Measured, not assumed:**
 *     the five survivor rigs span 0.82 m to 1.49 m in XZ (asserted by
 *     tests/character-blight.test.mjs so this number cannot drift), while the
 *     coverage transition band at the smallest patch — `RADIUS.base = 2.0` in
 *     src/systems/Blight.js, feathered from `edge` to `edge * 0.72` — is only
 *     about 0.56 m wide. **The band can therefore be narrower than the figure**,
 *     and a survivor standing on a small patch's rim can show a partial-coverage
 *     split across their own body rather than taking the claim as one creature.
 *     That is a real defect, not a rounding error, and issue #101 tracks the
 *     fix. It is accepted here rather than solved because the alternative
 *     available at this seam is worse: enemy materials are cached per
 *     species+affix and shared across the whole horde, so a per-material
 *     uniform could not have been per-rig at all.
 *   - it is evaluated per vertex rather than per draw call, because a rig is
 *     many meshes: a per-draw scalar would pop limb by limb as a figure crossed
 *     a patch edge, where an interpolated one creeps continuously up the body.
 *
 * NOTHING HERE ADDS GEOMETRY, GLOW-AROUND-THE-EDGE, OR AN OUTLINE. The pass
 * only rewrites `diffuseColor` and adds a vein emissive strictly inside the
 * existing surface, so a black-thresholded silhouette is bit-identical to what
 * it was — the readability work of #20 and style-guide rule 5 is untouched.
 */
import { MASK_UNIFORMS, MASK_FIELD } from './BlightMask.js';

/** Declarations shared by both stages, plus this pass's own interpolators. */
const CB_VARYING = /* glsl */ `
varying vec3 vCbObj;
varying float vCbCover;`;

const CB_VERT_DECL = /* glsl */ `#include <common>
${CB_VARYING}
${MASK_FIELD}`;

// `transformed` is the object-space vertex after begin_vertex/morph/skinning,
// which is what makes the pattern follow a deforming rig instead of sliding
// over it. Coverage needs the world position, so it is rebuilt here for that
// one purpose only.
const CB_VERT = /* glsl */ `#include <project_vertex>
{
  vCbObj = transformed;
  vec4 cbw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    cbw = instanceMatrix * cbw;
  #endif
  vCbCover = blightMask((modelMatrix * cbw).xyz);
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
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, MASK_UNIFORMS);
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
