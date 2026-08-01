import * as THREE from 'three';

/**
 * GPU particle shader.
 *
 * Every particle is a single instanced quad whose entire trajectory is a closed
 * form of its spawn state, so the CPU writes 28 floats once at spawn and then
 * never touches the particle again. `uTime` is the only per-frame upload.
 *
 * Motion is the analytic solution of  dv/dt = -k*v + g  (linear drag plus
 * gravity), which is exact rather than an Euler approximation and costs two
 * exp() calls. Turbulence is a cheap sin field that grows with age, so
 * particles start coherent and fray as they die — that is what reads as smoke
 * rather than as "dots moving in straight lines".
 *
 * Soft particles fade against a half-res depth prepass. Without it every puff
 * shows a hard intersection line with the ground and the whole effect layer
 * reads as flat stickers pasted on the world.
 */

// Instance attribute layout, shared with ParticleSystem's typed arrays.
export const PARTICLE_ATTRIBUTES = [
  ['aSpawn', 3],  // world spawn position
  ['aVel', 3],    // initial velocity, m/s
  ['aTime', 2],   // spawnTime, lifetime
  ['aSize', 2],   // size at birth, size at death (world metres)
  ['aCol0', 4],   // rgb + alpha at birth
  ['aCol1', 4],   // rgb + alpha at death
  ['aParams', 4], // drag, gravityScale, turbulence, velocityStretch
  ['aMisc', 4],   // seed, atlasFrame, spinRate, softFadeDistance
  ['aCurve', 2],  // fadeIn fraction, alpha falloff power
];

export const PARTICLE_STRIDE = PARTICLE_ATTRIBUTES.reduce((n, a) => n + a[1], 0);

export const ParticleVertexShader = /* glsl */ `
precision highp float;

attribute vec3 aSpawn;
attribute vec3 aVel;
attribute vec2 aTime;
attribute vec2 aSize;
attribute vec4 aCol0;
attribute vec4 aCol1;
attribute vec4 aParams;
attribute vec4 aMisc;
attribute vec2 aCurve;

uniform float uTime;
uniform float uAtlasCols;
uniform vec3  uGravity;

varying vec4 vColor;
varying vec2 vUv;
varying float vSoft;
varying float vViewZ;

void main() {
  float t = uTime - aTime.x;
  float life = aTime.y;

  // Dead or not yet born: collapse behind the near plane. Cheaper than
  // re-uploading instanceCount every frame and keeps the ring buffer stable.
  if (t < 0.0 || t >= life || life <= 0.0) {
    vColor = vec4(0.0);
    vUv = vec2(0.0);
    vSoft = 0.0;
    vViewZ = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float u = t / life;
  float seed = aMisc.x;

  // --- analytic drag + gravity ---
  float k = max(aParams.x, 0.0001);
  vec3 g = uGravity * aParams.y;
  vec3 term = g / k;
  float e = exp(-k * t);
  vec3 p = aSpawn + term * t + (aVel - term) * ((1.0 - e) / k);

  // --- turbulence: three out-of-phase sines, amplitude ramps with age ---
  float turb = aParams.z;
  if (turb > 0.0) {
    float tf = t * 2.3;
    p += turb * t * vec3(
      sin(tf * 1.70 + seed * 6.2831),
      sin(tf * 1.31 + seed * 11.0) * 0.7,
      cos(tf * 2.13 + seed * 17.0)
    );
  }

  // --- colour / alpha over life ---
  vec4 c = mix(aCol0, aCol1, u);
  float fadeIn = max(aCurve.x, 0.0001);
  c.a *= smoothstep(0.0, fadeIn, u) * pow(max(1.0 - u, 0.0), max(aCurve.y, 0.001));
  vColor = c;

  // --- billboard in view space ---
  float size = mix(aSize.x, aSize.y, u);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 corner;

  if (aParams.w > 0.0) {
    // Velocity-stretched: sparks and debris need to read as streaks, not dots.
    //
    // Along the *instantaneous* velocity, not the spawn velocity. Stretching
    // along aVel gives every chunk a streak that points the same way and is
    // the same length for its whole life, which is a static billboard with a
    // long axis — it does not follow the arc, so a chunk at the top of its
    // trajectory still reads as travelling at launch speed and a chunk falling
    // back still points upward. Round 5 measured the debris field as "no motion
    // streaking" for exactly this reason.
    //
    // The closed-form trajectory above is differentiable and its derivative is
    // already in registers: d/dt [term*t + (aVel-term)*(1-e)/k] = term +
    // (aVel-term)*e. So the correct streak costs one madd. Drag shortens it as
    // the chunk slows, gravity swings it over as the arc turns, and the streak
    // is a tangent to the path the particle is actually on.
    vec3 vv = (modelViewMatrix * vec4(term + (aVel - term) * e, 0.0)).xyz;
    vec2 d = vv.xy;
    float dl = length(d);
    if (dl > 0.0001) {
      d /= dl;
      vec2 n = vec2(-d.y, d.x);
      float stretch = 1.0 + aParams.w * min(dl, 60.0) * 0.06;
      corner = d * (position.y * size * stretch) + n * (position.x * size);
    } else {
      corner = position.xy * size;
    }
  } else {
    float ang = aMisc.z * t + seed * 6.2831;
    float ca = cos(ang), sa = sin(ang);
    vec2 q = position.xy * size;
    corner = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);
  }

  mv.xy += corner;
  vViewZ = mv.z;
  vSoft = aMisc.w;

  // --- atlas frame ---
  // The atlas uploads with flipY = false, so texture t = 0 is the canvas's TOP
  // row while the quad's uv.y = 0 is its BOTTOM. Without the 1.0 - uv.y every
  // tile samples inverted in V; it only hides here because most sprites are
  // vertically symmetric. Keep this identical to NumberVert in VFX.js.
  float cols = uAtlasCols;
  float frame = floor(aMisc.y + 0.5);
  float fx = mod(frame, cols);
  float fy = floor(frame / cols);
  vUv = (vec2(uv.x, 1.0 - uv.y) + vec2(fx, fy)) / cols;

  gl_Position = projectionMatrix * mv;
}
`;

export const ParticleFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec2  uResolution;
uniform vec2  uCamPlanes;
uniform float uSoftEnabled;
uniform float uIntensity;
uniform float uMaxIntensity;

varying vec4 vColor;
varying vec2 vUv;
varying float vSoft;
varying float vViewZ;

float depthToViewZ(float d, float n, float f) {
  return (n * f) / ((f - n) * d - f);
}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  vec4 c = tex * vColor;
  c.rgb *= uIntensity;
  // Ceiling on a *single* sprite. Additive blending plus bloom means anything
  // that reaches white on its own stays white for its whole visible life, which
  // is how five different effects all measured 255,255,245. Capping here keeps
  // one sprite hot-but-tinted and lets only overlapping sprites clip to white —
  // that is what reads as heat rather than as a blank disc.
  c.rgb = min(c.rgb, vec3(uMaxIntensity));

  if (uSoftEnabled > 0.5 && vSoft > 0.0) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    float d = texture2D(uDepth, suv).x;
    if (d < 1.0) {
      float sceneZ = depthToViewZ(d, uCamPlanes.x, uCamPlanes.y);
      // Both are negative in front of the camera; scene further => more
      // negative, so a positive difference means the particle is in front.
      c.a *= clamp((vViewZ - sceneZ) / vSoft, 0.0, 1.0);
    }
  }

  if (c.a < 0.004) discard;
  gl_FragColor = c;
}
`;

/** Builds the ShaderMaterial for one blend layer. */
export function createParticleMaterial({
  map, additive, atlasCols = 4, intensity = 1, maxIntensity = 0.92,
}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uDepth: { value: null },
      uTime: { value: 0 },
      uAtlasCols: { value: atlasCols },
      uGravity: { value: new THREE.Vector3(0, -1, 0) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamPlanes: { value: new THREE.Vector2(0.1, 2000) },
      uSoftEnabled: { value: 0 },
      uIntensity: { value: intensity },
      uMaxIntensity: { value: maxIntensity },
    },
    vertexShader: ParticleVertexShader,
    fragmentShader: ParticleFragmentShader,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
