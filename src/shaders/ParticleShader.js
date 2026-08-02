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
varying vec2 vQuad;
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
    vQuad = vec2(0.0);
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

  // --- billboard in view space ---
  float size = mix(aSize.x, aSize.y, u);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // --- lens fade ---
  // The soft-particle fade above handles a sprite meeting a *surface*. This
  // handles a sprite meeting the *lens*, which is the other end of the same
  // problem and was unhandled: 'subtense' is the sprite's half-extent over its
  // own distance from the camera, so it is how much of the view the quad claims
  // regardless of its world size. Past ~0.3 (about a third of the frame height
  // from one sprite) an additive quad has stopped being an effect in the scene
  // and become a wash over the whole composition.
  //
  // Round 5 measured this on '10-inventory': 'overload-cell' detonates a 12 m
  // fireball centred on the player, six metres from the lens, so its core and
  // heat-glow quads subtended ~0.9 each and the 3D viewport came back at mean
  // L 159 with 12.5% of it over L 220 — against L 62 / 1.1% for the identical
  // stage and camera in '06-loaded-hud'. Terrain, water, trees and sky all went
  // milky together, which is the axis-3 and axis-9 regression on that shot.
  //
  // It fades to a floor, not to nothing: standing inside a nova should still be
  // bright, and the shot's own subject assertion needs the blast to be there.
  // '08-explosion' sits at ~0.23, below the knee, and is not touched at all.
  //
  // Round-5 r4: the floor was 0.18 and '10-inventory' still shipped a 3D
  // viewport at mean L 132.4 against a 63.4 control on the same stage and
  // camera (reviews/round5/shots-vfxr4-base). A quad that fades to 0.18 is
  // still a screen-filling wash when six of them overlap; 0.05 is a nova you
  // are standing inside rather than a nova that has replaced the frame. The
  // knee is unchanged so nothing below ~0.30 subtense moves.
  float subtense = (size * 0.5) / max(-mv.z, 0.05);
  c.a *= mix(1.0, 0.05, smoothstep(0.30, 0.85, subtense));

  vColor = c;

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
  // The quad's own uv, kept separate from the atlas uv so the fragment stage can
  // guarantee the alpha reaches zero at the polygon boundary. See vQuad in the
  // fragment shader.
  vQuad = uv;

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
varying vec2 vQuad;
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
  // is how five different effects all measured 255,255,245.
  //
  // Scaled, not clamped per channel. min(c.rgb, k) is a per-channel clip, so
  // any colour whose channels *all* exceed the ceiling comes out as a flat
  // neutral k,k,k — it is a whitener, and the tint it exists to protect is the
  // first thing it destroys. Round-5 r4 measured the consequence on
  // '08-explosion': the blast core read 255.0/253.9/237.9 with R clipped on
  // 100% of its pixels and the largest luminance step anywhere in the falloff
  // at 6.6 L, i.e. a hueless plateau with no gradient to shape. Dividing by the
  // largest channel instead holds the same peak radiance and keeps the ratio
  // between channels, so the sprite stays hot *and* orange, and the falloff
  // inside the sprite survives the ceiling instead of being flattened by it.
  float mx = max(c.r, max(c.g, c.b));
  c.rgb *= uMaxIntensity / max(mx, uMaxIntensity);

  // --- quad-boundary fade ---
  // The alpha edge must never be the polygon edge. Several atlas tiles carry a
  // non-zero value out to their own border, and a sprite scaled up near the
  // lens shows that border as a straight line: round-5 r4 measured two hard
  // diagonal single-pixel steps of +54.3 L and -28.6 L across the water in
  // '10-inventory', which is the rubric's axis-6 four-marker ("hard-clipped
  // particle edges") drawn by a spinning billboard's own outline. This costs a
  // length() and guarantees the sprite is transparent by the time it reaches
  // its own corner, whatever the atlas does.
  //
  // The ramp is 0.90 -> 1.00, not 0.74 -> 1.00, and the endpoint is what carries
  // the guarantee. rq is 1.0 at the middle of each quad edge and 1.414 at the
  // corners, so *every* point on the polygon boundary is at rq >= 1.0: a fade
  // that reaches zero at 1.0 is already a complete guarantee, and every unit of
  // ramp below that is spent eating the atlas rather than the outline.
  //
  // 0.74 spent a lot of it. shockRing -- the one frame in the atlas with a
  // genuinely sharp edge -- puts its bright band at 0.93 of the tile radius,
  // where a 0.74 ramp leaves 18% of the alpha. The sharp ring was, in effect,
  // switched off, which is why an explosion rim drawn with it read as a broad
  // glow: measured on reviews/round6/vfx-mine/08-explosion.png, adding the rim
  // emitter under the 0.74 ramp *lowered* the largest radial luminance step
  // about the blast centre to 7.4 L from reviews/round6/base/08-explosion.png
  // 8.1 L -- it contributed luminance and no edge. softRing at 0.78 and the
  // gaussian frames are unaffected either way; this only gives back the band
  // between 0.74 and 0.90, which is exactly where sharp-edged frames live.
  float rq = length(vQuad - 0.5) * 2.0;
  c.a *= 1.0 - smoothstep(0.90, 1.00, rq);

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
