import * as THREE from 'three';

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
    uVignette: { value: 0.42 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },  // ACES already carries the S-curve; this is trim
    uLift: { value: new THREE.Vector3(0.006, 0.010, 0.022) },  // cool shadows
    uGain: { value: new THREE.Vector3(1.02, 1.00, 0.965) },     // warm highlights
    uGrain: { value: 0.010 },
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
    uniform vec3  uLift, uGain;
    varying vec2 vUv;

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

      // --- contrast around 0.5 pivot, then saturation ---
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // --- vignette ---
      float vig = smoothstep(0.95, 0.22, length(c) * (1.0 + uVignette));
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
