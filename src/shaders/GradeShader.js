import * as THREE from 'three';
import { distortUniforms, DISTORT_DECL, DISTORT_APPLY } from './DistortShader.js';
import { shimmerUniforms, SHIMMER_DECL, SHIMMER_APPLY } from './BlightShimmer.js';

/**
 * Final-look pass: screen shake offset, chromatic aberration, filmic grade,
 * vignette and grain. Runs after OutputPass, i.e. on the tonemapped, sRGB-encoded
 * LDR image — the 0.5-pivot contrast, the luma-weighted grain and the aberration
 * offset are all only meaningful on 0..1 display values.
 *
 * The shake is applied as a UV offset rather than by moving the camera, so it
 * never desyncs aiming from what's on screen — a real problem with camera-space
 * shake in a shooter.
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uShake: { value: 0 },
    uAberration: { value: 0.0016 },
    uVignette: { value: 0.16 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },  // ACES already carries the S-curve; this is trim
    uLift: { value: new THREE.Vector3(0.016, 0.020, 0.048) },  // cool shadows
    uGain: { value: new THREE.Vector3(1.02, 1.00, 0.965) },     // warm highlights
    // Shadow toe. `uLift` alone is a flat pedestal across the whole range; the
    // toe is the part that only touches the bottom, so the shadow side gains
    // bounce colour without the mid-tones going milky and without eating into
    // the contrast the warm key carves. Sits on the sky's own blue-violet, so
    // the darkest thing in frame is still the *cool* end of the complementary
    // split rather than a neutral grey.
    // Raised alongside the key/fill rebalance in `Environment.js`: the scene
    // fill came down so the sun could carve a real terminator, and the shadow
    // detail that used to be paid for by ambient light is paid for here
    // instead. This is the cheaper place to pay for it — the toe only touches
    // the bottom of the range, so it costs nothing at the terminator, whereas
    // the ambient floor it replaces was flattening the whole frame.
    // Raised again for the establishing shot's unlit third: 34% of that frame
    // was one connected sub-L40 region carrying six distinct luma values, i.e.
    // a hole rather than a shadow. The toe is the right place to pay for it —
    // the same lift bought with ambient light costs the terminator, and the
    // terminator ratios (2.9-4.4:1 on the same-surface probes) are what the
    // last two rounds finally got right.
    // DO NOT raise this again to chase the establishing shot's dead third. It
    // was tried three ways and every one of them is a worse trade than the
    // defect it closes:
    //   0.140/0.146/0.226 @ 0.40 takes that shot's largest connected sub-L40
    //     region from 28.0% of frame to 0.1% — and takes the texture-free
    //     single-surface fraction, which is axis 5's whole measurement and the
    //     top-ranked defect in the build, from 65.7/52.9/62.4/56.8% up to
    //     73.4/81.9/69.5/75.9% on the four biomes. The toe is a compression at
    //     the bottom of the range, so it flattens shadow-side surface detail by
    //     construction. Buying composition with material is the wrong direction.
    //   0.200/0.208/0.300 @ 0.30 (steeper, narrower, meant to spare the mids)
    //     pinned the bottom decile of every world band to L47 — one flat floor,
    //     the milky failure — and cost more contrast, not less: 4.98 -> 3.18.
    //   holding the toe and steepening uContrast to 1.10 to claw the separation
    //     back does not work either; contrast runs first and pushes the same
    //     pixels straight back under the toe (blob 0.1% -> 24.6%).
    // The dead third is a camera problem. See reviews/round5/FIX-stages.md.
    uToe: { value: new THREE.Vector3(0.108, 0.113, 0.198) },
    uToeRange: { value: 0.40 },
    uGrain: { value: 0.010 },
    // Blast distortion rides this pass rather than owning one: see DistortShader.
    // A pass of its own measured ~5ms of a 26ms frame purely for its own
    // fullscreen tap, and this shader already takes that tap.
    ...distortUniforms(),
    // The blight rim shimmer rides the same tap for the same reason.
    ...shimmerUniforms(),
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime, uShake, uAberration, uVignette, uSaturation, uContrast, uGrain;
    uniform float uToeRange;
    uniform vec3  uLift, uGain, uToe;
    varying vec2 vUv;
${DISTORT_DECL}
${SHIMMER_DECL}
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;

      // --- shake: two out-of-phase sines so it never reads as a loop ---
      if (uShake > 0.0001) {
        float s = uShake * uShake; // ease out, big hits feel disproportionate
        uv += vec2(
          sin(uTime * 47.0) * 0.5 + sin(uTime * 31.3) * 0.5,
          cos(uTime * 41.0) * 0.5 + cos(uTime * 26.7) * 0.5
        ) * s * 0.018;
      }

      // --- blast shockwave displacement -----------------------------------
      // Before the aberration, so the fringe follows the bent geometry instead
      // of separating a straight edge that is no longer there.
${DISTORT_APPLY}

      // --- blight rim shimmer: same free ride on this pass's one tap --------
${SHIMMER_APPLY}

      // --- chromatic aberration, scaled by distance from centre ---
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * uAberration * (0.35 + r2 * 2.2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;

      // --- lift / gain grade ---
      col = col * uGain + uLift * (1.0 - col);

      // --- contrast around 0.5 pivot ---
      col = (col - 0.5) * uContrast + 0.5;

      // --- shadow toe -------------------------------------------------------
      // Applied after the contrast pivot (which pulls the bottom of the range
      // further down) and before saturation, so the bounce colour gets the same
      // treatment as everything else. Quadratic falloff to zero by uToeRange:
      // nothing above the low mid-tones moves at all, so the key side and the
      // sky keep the value separation they had.
      float sl = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float toe = 1.0 - smoothstep(0.0, uToeRange, sl);
      col += uToe * toe * toe;

      // --- saturation ---
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // --- vignette ---
      // The falloff starts outside the action-safe area rather than at 40% of
      // the radius: a vignette that reaches the middle of the frame reads as a
      // lens artefact. At 0.26 / smoothstep(1.02, 0.40) the corners still
      // measured -21% against a flat field, so the stops move out again and the
      // depth comes down: 0.16 / smoothstep(1.14, 0.52) puts the corner
      // multiplier at 0.92 (-7.6%) and the mid-height frame edge at -2%. The
      // per-hit vignette boost still drives it hard, and because uVignette also
      // scales the sample radius a boost still tightens the falloff as well as
      // deepening it.
      float vig = smoothstep(1.14, 0.52, length(c) * (1.0 + uVignette));
      col *= mix(1.0, vig, uVignette);

      // --- animated grain, strongest in shadows where banding shows ---
      // Hash on a 1080p-normalised grid so grain stays the same apparent size
      // at any output resolution instead of turning into per-pixel speckle.
      vec2 gp = floor(gl_FragCoord.xy * (1080.0 / max(uResolution.y, 1.0)));
      float g = hash(gp + fract(uTime) * 137.0) - 0.5;
      col += g * uGrain * (1.0 - clamp(luma, 0.0, 1.0) * 0.7);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};
