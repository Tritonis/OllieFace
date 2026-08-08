// src/shaders/BlightShimmer.js
/**
 * Blight rim shimmer — the "refraction" of the crawling edge, priced the way
 * DistortShader prices the blast shockwave: as a snippet composed into
 * GradeShader, which already taps the frame, so the layer costs zero extra
 * fullscreen reads. Records are (screenU, screenV, uvRadius, strength),
 * written per frame by Blight from the patches nearest the camera.
 *
 * Unlike the blast shell this is a standing effect, so the displacement
 * oscillates along the ring instead of pushing one way — heat-haze over a
 * wound in the ground, not a lens.
 */
export const MAX_RIMS = 4;

/** Fresh objects per call — three.js mutates uniform values in place and two
 *  materials must never share one (same contract as distortUniforms). */
export function shimmerUniforms() {
  return {
    uRimCount: { value: 0 },
    uRims: { value: Array.from({ length: MAX_RIMS }, () => [0, 0, 0, 0]).flat() },
    uRimAspect: { value: 1 },
  };
}

/** Declarations — goes above `void main()`. Uses the host's uTime. */
export const SHIMMER_DECL = /* glsl */ `
uniform int uRimCount;
uniform vec4 uRims[${MAX_RIMS}];
uniform float uRimAspect;

vec2 rimShimmer(vec2 p, float t) {
  vec2 off = vec2(0.0);
  for (int i = 0; i < ${MAX_RIMS}; i++) {
    if (i >= uRimCount) break;
    vec4 b = uRims[i];
    vec2 d = vec2((p.x - b.x) * uRimAspect, p.y - b.y);
    float dist = length(d);
    if (dist < 1e-5) continue;
    // Gaussian band sitting on the projected rim, wider than the blast shell:
    // a standing shimmer needs area to read at all.
    float w = max(b.z * 0.30, 0.010);
    float e = (dist - b.z) / w;
    float shell = exp(-e * e);
    // Two incommensurate spatial frequencies along the ring, drifting against
    // each other, so the wobble never reads as a loop.
    float wob = sin(dist * 90.0 + t * 5.1) * 0.6 + sin(dist * 53.0 - t * 3.7) * 0.4;
    off += (d / dist) * shell * b.w * wob;
  }
  off.x /= uRimAspect;
  return off;
}
`;

/** The one line that applies it, given `uv` and `uTime` in scope. */
export const SHIMMER_APPLY = /* glsl */ `
  if (uRimCount > 0) uv = clamp(uv + rimShimmer(uv, uTime), vec2(0.001), vec2(0.999));
`;
