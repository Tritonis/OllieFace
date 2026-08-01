import * as THREE from 'three';

/**
 * Procedural sky dome. Rendered as a BackSide sphere that follows the camera.
 *
 * It has to do double duty: it's the visible backdrop AND the source for the
 * PMREM environment map, so the gradient/sun energy here is what lands on every
 * PBR surface in the stage. Values are linear HDR — the sun disc goes well
 * above 1.0 on purpose so bloom and IBL both have something to work with.
 */
export const SkyShader = {
  uniforms: {
    uSunDir: { value: new THREE.Vector3(0.532, 0.309, 0.788).normalize() },
    uZenith: { value: new THREE.Color(0x2f7fb2) },
    // Middle stop of the vertical ramp. Overwritten per biome by
    // `Environment._deriveSkyMid` — the value here only has to be sane for the
    // one frame before the first biome is applied.
    uMid: { value: new THREE.Color(0x6a8fa8) },
    uHorizon: { value: new THREE.Color(0xf2a44f) },
    uHaze: { value: new THREE.Color(0xffd08a) },
    uGround: { value: new THREE.Color(0x39344a) },
    uSunColor: { value: new THREE.Color(0xffe0ad) },
    uCloud: { value: new THREE.Color(0xb9bed8) },
    uTime: { value: 0 },
    uCloudAmount: { value: 0.74 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform vec3  uSunDir, uZenith, uMid, uHorizon, uHaze, uGround, uSunColor, uCloud;
    uniform float uTime, uCloudAmount;
    varying vec3 vDir;

    float hash(vec2 p) {
      p = fract(p * vec2(127.1, 311.7));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) {
        s += vnoise(p) * a;
        p = p * 2.03 + vec2(13.7, -7.3);
        a *= 0.5;
      }
      return s;
    }

    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;

      float hh = clamp(h, 0.0, 1.0);

      // --- base gradient ---------------------------------------------------
      // Three *colours*, not one cross-fade with three named endpoints. The
      // previous pass still ended in a single mix(warm, uZenith, ...) and only
      // moved its window, which changes nothing: a straight linear cross of an
      // 0.87-linear amber against an 0.03-linear blue is red-dominant until the
      // blue's weight is past ~0.8, so every framing that only reaches a
      // half-mix measured as desaturated red-mauve. The sky band measured 0.00%
      // in the 180-240 degree hue bucket twice running.
      //
      // The real constraint is how little of the dome is ever on screen. The
      // establishing camera sits pitched down with a ridge line high in frame,
      // so the *visible* sky is a band of roughly 13-21 degrees of elevation —
      // hh 0.23 to 0.36. Anything that has not resolved by hh 0.24 is not in
      // the picture. So the warm band is resolved first, the cool band is fully
      // reached inside the bottom of that slice, and the zenith takes over
      // across it, which puts the colour event where a frame can see it while
      // still leaving a warm strip hugging the horizon for the far terrain to
      // sit against.
      float haze = exp(-hh * 9.0);
      vec3 warm = mix(uHorizon, uHaze, haze * 0.62);

      // The zenith weight is capped short of 1.0 on purpose. uZenith is a
      // saturated blue with almost no red in it (0.027 linear), so resolving to
      // it *exactly* drove 2.1% of the frame's red channel to hard zero once
      // the grade's saturation ran, and left the top of frame darker than the
      // terrain under it. Stopping at 0.62 keeps a trace of the warm band in
      // the blue, which is both what an evening sky does and what stops the
      // channel clipping.
      vec3 col = mix(warm, uMid, smoothstep(0.025, 0.150, hh));
      col = mix(col, uZenith, 0.62 * smoothstep(0.120, 0.320, hh));

      col = mix(uGround, col, smoothstep(-0.18, 0.012, h));

      // --- sun disc + three-lobe glow (tight core, halo, broad scatter) -----
      float sd = dot(d, uSunDir);
      float disc = smoothstep(0.9976, 0.9990, sd);
      float glow = pow(max(sd, 0.0), 300.0) * 1.6
                 + pow(max(sd, 0.0), 14.0) * 0.50
                 + pow(max(sd, 0.0), 3.0) * 0.13;
      col += uSunColor * (disc * 15.0 + glow);

      // --- horizon glow ----------------------------------------------------
      // A floor term keeps the horizon line luminous all the way around, so a
      // camera aimed away from the sun still gets a lit edge to separate the
      // far terrain from the sky, plus a stronger lobe toward the sun azimuth.
      vec2 fd = normalize(vec2(d.x, d.z) + 1e-5);
      vec2 fs = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
      // Tightened from 7.0: at 7.0 this term still carried 19% of its strength
      // at 14 degrees of elevation, i.e. across the whole visible sky band, and
      // warm additive light spread over the band is precisely what kept the
      // zenith blue from ever measuring as blue. It now hugs the horizon line
      // it exists for.
      float band = exp(-abs(h) * 11.0);
      col += uSunColor * band * (0.14 + 0.55 * pow(max(dot(fd, fs), 0.0), 2.0));

      // --- drifting cloud bands ---
      // Project onto a plane above the viewer; the 1/y term stretches the noise
      // toward the horizon the way real cloud decks foreshorten.
      float y = max(h, 0.045);
      vec2 pp = d.xz / y * 0.9 + vec2(uTime * 0.006, uTime * 0.0025);
      float n = fbm(pp * 0.55);
      n = fbm(pp * 0.55 + vec2(n * 1.4, -n * 0.9)); // one warp pass = wispier edges
      float cloud = smoothstep(0.44, 0.72, n) * uCloudAmount;
      // Reach much closer to the horizon than before — 0.16 started the deck
      // above the top of every in-game frame, which is why no cloud ever showed.
      cloud *= smoothstep(0.006, 0.055, h) * (1.0 - smoothstep(0.55, 0.95, h));

      // The deck needs internal value contrast or it dissolves into the sky it
      // is mixed over — at 0.70 the cloud colour sat within a few percent of the
      // band behind it, which is why a 0.74 cloud amount produced one visible
      // wisp. Wisps take the full body value and sit *above* the sky; the dense
      // cores fall toward the cool zenith so the deck has a shaded underside;
      // the sun-facing side still burns out warm.
      float dens = smoothstep(0.44, 0.86, n);
      vec3 cloudCol = mix(uCloud * 1.05, uZenith * 0.6, dens * 0.65);
      float lit = pow(max(dot(d, uSunDir), 0.0), 3.0);
      cloudCol = mix(cloudCol, uSunColor * 1.55, lit);
      col = mix(col, cloudCol, cloud);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
