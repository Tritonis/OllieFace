import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GradeShader } from '../shaders/GradeShader.js';
import { prewarmShaders } from '../fx/Prewarm.js';
import { clamp, damp } from './MathUtil.js';

export const QUALITY = { LOW: 0, MEDIUM: 1, HIGH: 2, ULTRA: 3 };

/**
 * Bloom is authored against genuinely HDR input: the composer target is
 * HalfFloat and nothing tonemaps before `output`, so a threshold above 1.0 is
 * what "only emissives" actually means. `clamp` caps the bright-pass input so a
 * single runaway additive quad cannot carry the whole screen.
 */
const BLOOM = { strength: 0.34, radius: 0.40, threshold: 1.25, clamp: 8.0 };

/** Ceiling on drawing-buffer pixels. See `_applyPixelRatio`. */
const PIXEL_BUDGET = 5.0e6;

/**
 * Cap the bright-pass input of an UnrealBloomPass. Without this, one additive
 * VFX quad at 60.0 smears across the whole halo and clips it to featureless
 * white; with it, bloom widens a highlight instead of replacing it.
 */
function clampBloomInput(bloom, k) {
  const mat = bloom.materialHighPassFilter;
  const src = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!mat.fragmentShader.includes(src)) return; // three changed the shader
  mat.fragmentShader = mat.fragmentShader.replace(
    src, `vec4 texel = min( texture2D( tDiffuse, vUv ), vec4( ${k.toFixed(1)} ) );`
  );
  mat.needsUpdate = true;
}

/**
 * Owns the WebGLRenderer and the full post chain.
 *
 * Chain: scene -> GTAO -> bloom -> output(ACES + sRGB) -> grade -> SMAA
 *
 * Everything up to and including `bloom` runs in linear HDR. `output` is the
 * only tonemapper; everything downstream of it runs in LDR, which is what the
 * grade's 0.5-pivot contrast, luma-weighted grain and aberration are written
 * for. SMAA stays last so it antialiases the final graded image.
 */
export class RenderPipeline {
  constructor(canvas, quality = QUALITY.HIGH) {
    this.quality = quality;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA handles this; MSAA doesn't survive the composer
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer = renderer;
    this._applyPixelRatio();
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap; // soft, no acne on stylized geo
    // OutputPass reads these off the renderer (it ignores its own fields), and
    // WebGLRenderer only applies tonemapping when drawing straight to the
    // screen — so scene passes into the composer stay linear HDR.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.composer = null;
    this.passes = {};
    // Screen-effect state driven by gameplay (hits, explosions, sprint).
    this.shake = 0;
    this.shakeTime = 0;
    this.aberration = 0;
    this.vignetteBoost = 0;
    // User-facing screen-shake multiplier; `addShake` folds this in so the UI
    // never has to wrap the method.
    this.shakeScale = 1;
    this.ctx = null;
    this._warmed = false;
  }

  build(scene, camera) {
    const { renderer, quality } = this;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    const composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        colorSpace: THREE.LinearSRGBColorSpace,
        samples: 0,
      })
    );
    composer.setPixelRatio(renderer.getPixelRatio());

    const render = new RenderPass(scene, camera);
    composer.addPass(render);
    this.passes.render = render;

    if (quality >= QUALITY.MEDIUM) {
      const gtao = new GTAOPass(scene, camera, size.x, size.y);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({
        // The stage is ~220 units across; sub-metre radii produce no visible
        // contact darkening at all on terrain this size.
        radius: 2.6,
        distanceExponent: 1.6,
        thickness: 1.0,
        scale: 1.1,
        samples: quality >= QUALITY.ULTRA ? 24 : 16,
        distanceFallOff: 1.0,
        screenSpaceRadius: false,
      });
      gtao.blendIntensity = 0.85;
      composer.addPass(gtao);
      this.passes.gtao = gtao;
    }

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold
    );
    clampBloomInput(bloom, BLOOM.clamp);
    // The settings screen re-pushes a strength on every apply(), using numbers
    // dialled in for the old pre-tonemap chain. Treat any external write as a
    // ceiling request so a stale value cannot blow the frame out again.
    let strength = BLOOM.strength;
    Object.defineProperty(bloom, 'strength', {
      get: () => strength,
      set: (v) => { strength = Math.min(v, BLOOM.strength); },
      configurable: true,
    });
    composer.addPass(bloom);
    this.passes.bloom = bloom;

    // Tonemap + sRGB encode. Everything after this point is LDR.
    const output = new OutputPass();
    composer.addPass(output);
    this.passes.output = output;

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    this.passes.grade = grade;

    if (quality >= QUALITY.MEDIUM) {
      const smaa = new SMAAPass();
      composer.addPass(smaa);
      this.passes.smaa = smaa;
    }

    this.composer = composer;
    this.resize();
    return composer;
  }

  /**
   * Pick the drawing-buffer scale.
   *
   * The ratio cap alone is not a cost cap: at `min(devicePixelRatio, 2)` a
   * maximised window on a 4K panel at 200% scaling draws 3840x2160 — 8.3M
   * pixels, 5.8x the 1600x900 the game was tuned at — and every one of them
   * pays for 24-sample GTAO, the bloom pyramid and SMAA. So the ratio is
   * additionally clamped by a total-pixel budget.
   *
   * The budget is deliberately loose: it is a no-op at 1x on anything up to a
   * 5K desktop, and a no-op for a high-DPI laptop rendering a small window at
   * 2x. It only bites where the naive ratio would multiply the per-pixel cost
   * several times over, and there it lands on ~3000x1700 — still well above
   * 1080p native, and SMAA resolves the upscale cleanly.
   */
  _applyPixelRatio() {
    const max = this.quality >= QUALITY.HIGH ? 2 : 1.5;
    const w = innerWidth, h = innerHeight;
    let ratio = Math.min(devicePixelRatio, max);
    if (w > 0 && h > 0) {
      const budget = Math.sqrt(PIXEL_BUDGET / (w * h));
      ratio = Math.min(ratio, Math.max(1, budget));
    }
    this.renderer.setPixelRatio(ratio);
  }

  /** The live settings object, if the game context has been published yet. */
  get settings() {
    return this.ctx?.settings ?? globalThis.__GAME__?.ctx?.settings ?? null;
  }

  /** Kick the camera. `amount` is roughly "screen fraction", 0.02 is a light hit.
   *  Scaled by the player's screen-shake preference, so the UI can set the
   *  setting and leave this method alone. */
  addShake(amount) {
    const scale = this.shakeScale * (this.settings?.shake ?? 1);
    this.shake = clamp(this.shake + amount * scale, 0, 1);
  }

  update(dt) {
    this.shakeTime += dt;
    this.shake = damp(this.shake, 0, 0.995, dt);
    // Explosions add aberration with no ceiling of their own; cap it here so
    // stacked hits can never separate the channels into visible colour.
    this.aberration = clamp(damp(this.aberration, 0, 0.99, dt), 0, 0.004);
    this.vignetteBoost = damp(this.vignetteBoost, 0, 0.98, dt);

    const g = this.passes.grade;
    if (g) {
      const u = g.uniforms;
      u.uTime.value = this.shakeTime;
      u.uShake.value = this.shake;
      u.uAberration.value = 0.0016 + Math.min(this.aberration + this.shake * 0.004, 0.004);
      u.uVignette.value = 0.42 + this.vignetteBoost;
    }
  }

  render(scene, camera, dt) {
    // Compile every material permutation the game can produce before the first
    // frame is presented. It has to happen here rather than in `build()`: the
    // cache key bakes in the scene's light counts, and the world's lights are
    // only in place once the systems have run their first update. The cost is
    // folded into the frame the player already spends waiting for the stage.
    if (!this._warmed) {
      this._warmed = true;
      // The cache key also bakes in the *bound* target's colour space and
      // tonemapping. Scene geometry is only ever drawn into the composer's
      // linear-HDR target, so compiling against the default framebuffer
      // (sRGB + ACES) would warm a program set gameplay never uses.
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.composer.renderTarget1);
      prewarmShaders(this.renderer, scene, camera);
      this.renderer.setRenderTarget(prev);
    }
    this.update(dt);
    this.composer.render(dt);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    // Re-evaluated per resize: the budget depends on the window, so dragging
    // onto a 4K panel has to be able to pull the ratio back down.
    this._applyPixelRatio();
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    const px = this.renderer.getPixelRatio();
    const g = this.passes.grade;
    if (g) g.uniforms.uResolution.value.set(w * px, h * px);
  }
}
