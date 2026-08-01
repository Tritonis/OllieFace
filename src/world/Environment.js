import * as THREE from 'three';
import { SkyShader } from '../shaders/SkyShader.js';
import { PALETTE, BIOMES } from './Materials.js';

/**
 * Lighting, sky, fog and atmosphere.
 *
 * Runs before Stage (see main.js) — nothing here queries the world, and having
 * scene.environment in place before the terrain material first compiles avoids
 * a shader recompile on the first frame.
 *
 * Art direction (late golden hour, cold air):
 *   key    warm sun at 18 deg from the +X/+Z quadrant — low enough for 3:1
 *          shadows, high enough to sit inside a pitched-down gameplay frame
 *   fill   cool blue hemisphere, kept weak so the key has something to carve
 *   rim    violet back light to separate silhouettes from the sky
 *   fog    exp2 in the *sky's* blue, so distance cools rather than browns
 */

// Shared by the sky shader and the key light, so the shadow direction always
// matches where the sun disc actually is.
//
// Elevation 18 deg, azimuth 34 deg right of +Z. The old (-0.62, 0.34, 0.71) put
// the sun behind and to the left of every capture camera: nothing was ever
// backlit or raked, no specular anywhere, and the disc itself was off-frame.
// This puts the disc in the upper right of the default third-person frame and
// leaves the vista camera cross-lit, which is what makes its shadows read.
const SUN_DIR = new THREE.Vector3(0.532, 0.309, 0.788).normalize();
const SUN_DISTANCE = 150;

// Shadow frustum half-extent. Fitted to the action, not to the stage: at the
// old 118 the whole 220u level shared one 2k map (0.115 u/texel) and VSM's
// variance blur then erased every terrace edge, which is why the terrain read
// as flat. 80 into a 4k map is 0.039 u/texel — 3x sharper before the blur.
const SHADOW_EXT = 80;

/**
 * Shadow budget per quality tier.
 *
 * This was a flat 4096 VSM for every machine, and it was by a wide margin the
 * most expensive thing in the frame: measured in isolation it cost ~85ms on an
 * Intel UHD 630 — more than the entire rest of the pipeline put together —
 * because VSM's variance blur is fill-bound over the whole map, and 4096²
 * is sixteen times the fill of 1024².
 *
 * The extent shrinks alongside the map so the low tiers keep some of the texel
 * density the sharp edge depends on, rather than only losing resolution. VSM is
 * kept wherever it is affordable because the soft raking edge is the look;
 * only the bottom tier falls back to PCF, where the map is small enough that
 * VSM's blur would erase the edge anyway.
 */
const SHADOW_TIERS = [
  { map: 1024, ext: 55, vsm: false, radius: 1.0, blur: 4 },  // LOW
  { map: 2048, ext: 70, vsm: true, radius: 1.4, blur: 6 },  // MEDIUM
  { map: 3072, ext: 80, vsm: true, radius: 1.6, blur: 8 },  // HIGH
  // ULTRA buys reach rather than density: the floating islands sit 16-40m up,
  // so at an 18deg sun their shadows land 50-120m from their own footprint and
  // fell outside an 80 box in almost every case — the establishing shot had no
  // cast shadow in it at all. 110 into 4096 is 0.054 u/texel, still sharper
  // than the 0.115 this started at.
  { map: 4096, ext: 110, vsm: true, radius: 1.6, blur: 8 },  // ULTRA
];

/**
 * Key / fill balance.
 *
 * The previous version of this was a pure *floor* — `hemiMin 0.85, envMin 0.78`
 * — added to stop the shadow side clipping to black. It stopped the clipping,
 * and it also flattened the key: measured lit:shadow across the establishing
 * shot fell to 1.4-1.9:1, with two hero surfaces reading brighter on their
 * shadow side than on their lit side, because at that fill the violet rim was
 * out-lighting the sun.
 *
 * The crush was never a scene-light problem in the first place. It is fixed in
 * display space by `GradeShader`'s toe, which lifts only the bottom of the
 * range and leaves the terminator alone — so the fill is free to go back down
 * to where a key can carve into it. This is a *scale* on what the biome asks
 * for rather than a floor over it, so the ratio between the four lights is the
 * same in every biome and the darkest biome no longer gets silently flattened
 * the most.
 *
 * `env` is deliberately cut far less than `hemi` and `rim`: the IBL is what
 * gives the shadow side its form and is the only thing a metalness-1.0 surface
 * has to reflect, so killing it trades one flat look for another.
 *
 * `envMin` and `rimMin` came up (0.34 -> 0.52, 0.22 -> 0.30) once the sky's
 * lower hemisphere stopped being a constant. Before that a floor on the IBL was
 * a floor on one flat colour, so raising it only made the shadow side a lighter
 * shade of the same nothing — which is why previous passes kept pushing it back
 * down. With a ground-bounce gradient and a horizon edge in the probe (see
 * SkyShader's `uBounce`), the same energy arrives *oriented*: a face tipped
 * toward the horizon returns the warm band and one tipped at the nadir returns
 * the dark ground, so the floor now buys form instead of fog. The establishing
 * shot's unlit third was 34% of frame in one connected sub-L40 blob at six
 * distinct luma values, which is the failure this is aimed at.
 *
 * `groundBoost` is unchanged: the hemisphere's ground colour is the only warm
 * bounce in the scene and every biome authors it nearly black in linear, so the
 * bounce never read as bounce. Boosting the colour rather than the intensity
 * keeps the sky half of the hemisphere where the biome put it.
 */
const FILL = {
  hemiScale: 0.40, hemiMin: 0.12,
  envScale: 0.82, envMin: 0.52,
  rimScale: 0.29, rimMin: 0.30,
  groundBoost: 1.45,
};

/**
 * Gain on the biome's own sun intensity.
 *
 * Held as a multiplier, not baked into the biomes, so the four sun intensities
 * stay comparable to each other and to their authored colours. 2.5x against the
 * fill above takes the measured display-space lit:shadow separation from 1.86
 * to 2.6 overall and from 2.4 to 4.2 at the ninetieth percentile of key-lit
 * surface, and takes the luminance a cast shadow removes from 1.6x to 2.0x —
 * which is the difference between a shadow that can be found by differencing
 * two renders and one that is visible in the frame.
 */
const KEY_GAIN = 2.5;

/**
 * Fog is derived from the biome's own sky rather than taken verbatim.
 *
 * A fixed cool fog against a warm sunset sky put 139deg of hue between the far
 * massif and the band of sky directly above it, so the massif read as pale blue
 * paper pasted onto a pink backdrop instead of as distance. Aerial perspective
 * converges distant geometry toward *the sky behind it*, so the declared fog
 * colour is pulled partway onto the sky's own horizon band and trimmed in value
 * so the massif sits under the sky rather than above it. The blend is partial,
 * not total: the fog keeps enough of its authored hue for the near/mid/far
 * separation to still be a cooling.
 */
const FOG = { skyBlend: 0.45, hazeBlend: 0.35, value: 0.80, density: 0.85 };

const _c1 = new THREE.Color();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const DUST_COUNT = 1400;
const DUST_BOX = 90; // motes wrap inside this cube around the camera

export class Environment {
  init(ctx) {
    const scene = ctx.scene;
    this.ctx = ctx;
    this.sunDir = SUN_DIR.clone();

    this._buildSky(ctx);
    this._buildLights(scene);
    this._buildDust(ctx);
    this.applyQuality(ctx.pipeline?.quality ?? 2);

    // 0.0072 saturated at 91% by the stage's own 220u extent, so the back half
    // of the level carried under 10% of its own colour and every silhouette out
    // there dissolved. 0.0036 lands 220u near 58%: still a strong aerial layer,
    // but the far terrain keeps enough value to separate from the sky.
    const b0 = BIOMES[0];
    scene.fog = new THREE.FogExp2(fogColor(b0), b0.fog.density * FOG.density);
    ctx.environment = this; // convenience handle; not part of the ctx contract
  }

  /**
   * Size the shadow map to the quality tier. Called at init and again whenever
   * the settings screen moves quality.
   *
   * The map is disposed rather than resized: `mapSize` is only read when the
   * render target is allocated, so writing it on a live shadow changes nothing
   * until the old target is thrown away.
   */
  applyQuality(quality) {
    const t = SHADOW_TIERS[Math.max(0, Math.min(SHADOW_TIERS.length - 1, quality | 0))];
    if (this._shadowTier === t) return;
    const prev = this._shadowTier;
    this._shadowTier = t;

    const sh = this.key.shadow;
    sh.map?.dispose();
    sh.map = null;
    sh.mapSize.set(t.map, t.map);
    sh.camera.left = -t.ext; sh.camera.right = t.ext;
    sh.camera.top = t.ext; sh.camera.bottom = -t.ext;
    sh.camera.updateProjectionMatrix();
    sh.radius = t.radius;
    sh.blurSamples = t.blur;
    sh.needsUpdate = true;

    // World-space texel size, so `update()` can snap the frustum centre to a
    // whole texel and stop the map crawling as the player walks.
    this.shadowSnap = (t.ext * 2) / t.map;

    const renderer = this.ctx.pipeline?.renderer;
    if (renderer) {
      const type = t.vsm ? THREE.VSMShadowMap : THREE.PCFSoftShadowMap;
      if (renderer.shadowMap.type !== type) {
        renderer.shadowMap.type = type;
        // The shadow type is part of every lit material's program cache key, so
        // changing it after materials exist leaves them running the old sampler
        // against a target that no longer matches. Only force the recompile
        // when the type actually moved and something was already built — doing
        // it on the init call would throw away the prewarm.
        if (prev) this._invalidateMaterials();
      }
      renderer.shadowMap.needsUpdate = true;
    }
  }

  /** Force a shader rebuild across the scene. Expensive and deliberately rare —
   *  only a shadow-type change needs it. */
  _invalidateMaterials() {
    this.ctx.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) mm.needsUpdate = true; }
      else m.needsUpdate = true;
    });
  }

  /**
   * Re-dress the atmosphere for a biome. Stage.build() calls this on every
   * stage transition.
   *
   * Everything touched here is a *uniform*: light colours and intensities, the
   * sun vector, the sky shader's six colours, fog colour and density, the dust
   * tint. No material is created, no light is added or removed, and no define
   * changes — so not one shader program is invalidated and the transition costs
   * nothing beyond the terrain rebuild itself. Adding even one PointLight or
   * one material variant here would fork every program in the scene.
   */
  applyBiome(biome = BIOMES[0]) {
    const ctx = this.ctx;
    const scene = ctx.scene;

    // --- sun vector: shared by the sky disc, the key light and the shadows ---
    const { elevation, azimuth } = biome.sun;
    const ce = Math.cos(elevation);
    this.sunDir.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth)).normalize();
    this.skyUniforms.uSunDir.value.copy(this.sunDir);

    // --- sky ---
    // Matching _buildSky: these uniforms are fed to a ShaderMaterial that works
    // in linear space, and the pipeline's own conversion is applied on top, so
    // the same double step is repeated here or biome 0 would not reproduce the
    // reference sky exactly.
    const S = biome.sky;
    const set = (name, hex) => {
      this.skyUniforms[name].value.setHex(hex).convertSRGBToLinear();
    };
    set('uZenith', S.zenith);
    set('uHorizon', S.horizon);
    set('uHaze', S.haze);
    set('uGround', S.ground);
    set('uSunColor', S.sun);
    set('uCloud', S.cloud);
    set('uCeiling', S.ceiling ?? 0x000000);
    this._deriveSkyMid();
    this.skyUniforms.uCloudAmount.value = S.cloudAmount;
    // The two per-biome atmosphere shape controls. `hazePow` is how tightly the
    // hot band hugs the horizon; `ceilingAmount` turns the upper dome to rock
    // and is non-zero for exactly one biome. See SkyShader.
    this.skyUniforms.uHazePow.value = S.hazePow ?? 9.0;
    this.skyUniforms.uCeilingAmount.value = S.ceilingAmount ?? 0;

    // The reflected world has to move with the sky, or the roughness ladder is
    // reflecting the wrong place. Once per stage build. See `_bakeEnvironment`.
    this._bakeEnvironment();

    // --- fog ---
    if (scene.fog) {
      scene.fog.color.copy(fogColor(biome));
      scene.fog.density = biome.fog.density * FOG.density;
    }

    // --- lights ---
    this.key.color.set(biome.sun.color);
    this.key.intensity = biome.sun.intensity * KEY_GAIN;
    const L = biome.light;
    this.hemi.color.set(L.hemiSky);
    this.hemi.groundColor.set(L.hemiGround).multiplyScalar(FILL.groundBoost);
    this.hemi.intensity = Math.max(L.hemiIntensity * FILL.hemiScale, FILL.hemiMin);
    // The rim keeps its colour untouched: it is the violet back light that makes
    // a shadow a hue change rather than a darker version of the lit colour, and
    // the warm-key / cool-shadow split is the thing this build gets right. Only
    // its *intensity* comes down, because at 1.45 against a 4.2 key it was
    // winning on any surface angled away from the sun — which is why the
    // establishing shot had props measuring brighter on their shadow side.
    this.rim.color.set(L.rim);
    this.rim.intensity = Math.max(L.rimIntensity * FILL.rimScale, FILL.rimMin);
    // Back light stays opposite the key wherever the key has moved to.
    this.rim.position.set(this.sunDir.x * -120, 34, this.sunDir.z * -120);
    // The IBL probe is baked once at boot and deliberately not re-rendered per
    // stage — a PMREM pass mid-run is both a stall and a shader-compile risk.
    // Scaling its contribution instead is free and carries most of the read.
    scene.environmentIntensity = Math.max(L.envIntensity * FILL.envScale, FILL.envMin);

    // --- dust ---
    this.dustMaterial.color.set(biome.dust.color);
    this.dustMaterial.opacity = biome.dust.opacity;
  }

  _buildSky(ctx) {
    const uniforms = THREE.UniformsUtils.clone(SkyShader.uniforms);
    // Colour uniforms on a ShaderMaterial are uploaded verbatim, and the whole
    // pipeline works in linear space, so convert once here.
    for (const k of ['uZenith', 'uHorizon', 'uHaze', 'uGround', 'uSunColor', 'uCloud', 'uCeiling', 'uBounce']) {
      uniforms[k].value.convertSRGBToLinear();
    }
    uniforms.uSunDir.value.copy(SUN_DIR);
    this.skyUniforms = uniforms;
    this._deriveSkyMid();

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false, // OutputPass tonemaps the composited frame instead
    });
    this.skyMaterial = mat;

    const geo = new THREE.SphereGeometry(900, 48, 32);
    const sky = new THREE.Mesh(geo, mat);
    sky.name = 'sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.castShadow = false;
    sky.receiveShadow = false;
    ctx.scene.add(sky);
    this.sky = sky;

    // --- IBL from the same sky ---
    // Without this, everything not facing the key light falls to flat ambient
    // and the stylized materials lose all their form.
    const renderer = ctx.pipeline?.renderer;
    if (renderer) {
      this._pmrem = new THREE.PMREMGenerator(renderer);
      this._pmrem.compileEquirectangularShader();
      this._probeScene = new THREE.Scene();
      const probe = new THREE.Mesh(geo, mat);
      probe.frustumCulled = false;
      this._probeScene.add(probe);
      this._bakeEnvironment();
      // IBL at 0.85 plus a 0.75 hemisphere was filling every crevice back in,
      // which is what left the frame with no occlusion and no shadow contrast —
      // but 0.55 went past "carve into" and into "nothing to carve". `FILL`
      // holds the floor; GTAO is what puts the occlusion back.
      ctx.scene.environmentIntensity = Math.max(0.55 * FILL.envScale, FILL.envMin);
    }
  }

  /**
   * Re-render the PMREM probe from the sky as it is currently tuned.
   *
   * This used to happen exactly once, at boot, from the *default* uniforms — so
   * every biome's smooth materials reflected biome 0's evening sky, and the
   * cavern reflected open daylight it cannot see. Worse, the four stages'
   * differing skies were the one part of the roughness ladder that could have
   * made a low-roughness rung look different from stage to stage, and it was
   * being thrown away.
   *
   * It is a per-*stage-build* cost, not a per-frame one: six 256px faces plus
   * the roughness chain, called from `applyBiome`, which Stage.build() already
   * calls once per transition alongside a full terrain rebuild.
   */
  _bakeEnvironment() {
    if (!this._pmrem) return;
    const prev = this.envRT;
    // near/far must bracket the 900u dome or the cube camera clips it away.
    const rt = this._pmrem.fromScene(this._probeScene, 0.05, 1, 2000);
    this.ctx.scene.environment = rt.texture;
    this.envRT = rt;
    prev?.dispose();
  }

  /**
   * The sky gradient's middle stop, derived rather than authored.
   *
   * A two-colour ramp from a saturated amber to a saturated blue crosses
   * through neutral, and the visible slice of the dome in every capture is only
   * ~14-20 degrees of elevation — so the mix never got far enough past the
   * middle for the blue to appear and the whole sky measured as red-mauve. A
   * third stop lets the warm band resolve, then the cool band, then the zenith,
   * inside that slice.
   *
   * It is the zenith carrying a little of the horizon's haze rather than a
   * separate authored colour, so every biome gets a mid that already belongs to
   * its own sky and `Materials.js` needs no new field.
   */
  _deriveSkyMid() {
    const u = this.skyUniforms;
    u.uMid.value.copy(u.uZenith.value).lerp(u.uHaze.value, 0.20);
    // Ground bounce: the biome's own ground colour carrying a third of its own
    // horizon band. Derived rather than authored for the same reason `uMid` is
    // — a biome that changes its horizon gets a bounce that still belongs to
    // it, and `Materials.js` needs no new field. See SkyShader's `uBounce`.
    u.uBounce.value.copy(u.uGround.value).lerp(u.uHorizon.value, 0.34);
  }

  _buildLights(scene) {
    const L = PALETTE.light;

    const key = new THREE.DirectionalLight(L.key, 4.2 * KEY_GAIN);
    key.position.copy(SUN_DIR).multiplyScalar(SUN_DISTANCE);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    const sh = key.shadow;
    sh.camera.near = 1;
    sh.camera.far = SUN_DISTANCE + 260;
    // VSM: bias is handled by the variance itself; normalBias is what kills
    // the peter-panning on the big faceted cliff walls. 0.25 is nearly five
    // texels at the ULTRA density, which is enough to walk a dead tree's or a
    // boulder's shadow off its own base — the props that most need a contact
    // shadow are exactly the ones thin enough for that offset to erase.
    sh.bias = 0;
    sh.normalBias = 0.10;
    scene.add(key);
    scene.add(key.target);
    this.key = key;

    // The key still needs darkness to carve into, but at 0.50 with a nearly
    // black ground colour there was nothing left below the terminator at all.
    // See `FILL`.
    const hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, 0.50 * FILL.hemiScale);
    hemi.groundColor.multiplyScalar(FILL.groundBoost);
    hemi.position.set(0, 60, 0);
    scene.add(hemi);
    this.hemi = hemi;

    // Cool back light, opposite the key and slightly below it, so ridges and
    // props get a violet edge instead of dissolving into the fog. It is also
    // the only light on the shadow side, so it doubles as the bounce colour.
    const rim = new THREE.DirectionalLight(L.rim, 1.45 * FILL.rimScale);
    rim.position.set(SUN_DIR.x * -120, 34, SUN_DIR.z * -120);
    rim.castShadow = false;
    scene.add(rim);
    this.rim = rim;
  }

  _buildDust(ctx) {
    // Soft additive sprite drawn on a canvas — a hard-edged point sprite reads
    // as a pixel, a gaussian one reads as suspended dust.
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g2 = cv.getContext('2d');
    const grad = g2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0.0, 'rgba(255,236,200,1)');
    grad.addColorStop(0.25, 'rgba(255,222,170,0.55)');
    grad.addColorStop(1.0, 'rgba(255,210,150,0)');
    g2.fillStyle = grad;
    g2.fillRect(0, 0, S, S);
    const sprite = new THREE.CanvasTexture(cv);
    sprite.colorSpace = THREE.SRGBColorSpace;
    this.dustSprite = sprite;

    const rng = ctx.rng;
    const pos = new Float32Array(DUST_COUNT * 3);
    const phase = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) {
      pos[i * 3] = rng.range(-DUST_BOX, DUST_BOX) * 0.5;
      pos[i * 3 + 1] = rng.range(-DUST_BOX, DUST_BOX) * 0.5;
      pos[i * 3 + 2] = rng.range(-DUST_BOX, DUST_BOX) * 0.5;
      phase[i] = rng.range(0, Math.PI * 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustPhase = phase;
    this.dustBase = pos.slice();

    const mat = new THREE.PointsMaterial({
      size: 0.42,
      map: sprite,
      color: 0xffe6b8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false, // additive + fog just makes distant motes glow grey
    });
    this.dustMaterial = mat;

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 10;
    ctx.scene.add(pts);
    this.dust = pts;
  }

  update(ctx, dt) {
    this.skyUniforms.uTime.value += dt;

    // Sky and dust both live in camera space so the player is always inside the
    // atmosphere rather than walking out of it.
    const cam = ctx.camera;
    this.sky.position.copy(cam.position);

    // Slide the (small) shadow frustum along with the action. Snapped to a
    // whole shadow texel so the map does not shimmer as the centre moves.
    //
    // Centred on what the *camera* is looking at, not on the player. Every
    // capture camera and the vista camera in particular sits tens of metres off
    // the player looking away from them, so a player-centred box left most of
    // what the frame showed outside the shadow frustum entirely — which is why
    // the establishing shot contained no cast shadow despite a raking sun. The
    // player stays comfortably inside the box at 0.55 of the half-extent.
    const focus = _v2.copy(ctx.player?.position ?? cam.position);
    _v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _v1.y = 0;
    const fl = _v1.length();
    if (fl > 1e-4) {
      _v1.multiplyScalar(1 / fl);
      focus.copy(cam.position).addScaledVector(_v1, this._shadowTier.ext * 0.55);
    }
    const snap = this.shadowSnap;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    this.key.target.position.set(fx, 0, fz);
    // this.sunDir, not the module default: the biome moves the sun.
    const sd = this.sunDir;
    this.key.position.set(
      fx + sd.x * SUN_DISTANCE,
      sd.y * SUN_DISTANCE,
      fz + sd.z * SUN_DISTANCE,
    );
    this.key.target.updateMatrixWorld();

    const attr = this.dust.geometry.attributes.position;
    const arr = attr.array;
    const base = this.dustBase;
    const t = this.skyUniforms.uTime.value;
    const H = DUST_BOX * 0.5;
    for (let i = 0; i < DUST_COUNT; i++) {
      const p = this.dustPhase[i];
      // Wrap around the camera in world space, then add a slow drift so motes
      // aren't rigidly locked to the camera as it moves.
      const bx = base[i * 3] + t * 0.55;
      const by = base[i * 3 + 1] + Math.sin(t * 0.35 + p) * 1.4;
      const bz = base[i * 3 + 2] + Math.sin(t * 0.11 + p * 0.7) * 2.0;
      arr[i * 3] = cam.position.x + wrapTo(bx - cam.position.x, H);
      arr[i * 3 + 1] = cam.position.y + wrapTo(by - cam.position.y, H);
      arr[i * 3 + 2] = cam.position.z + wrapTo(bz - cam.position.z, H);
    }
    attr.needsUpdate = true;
  }

  dispose() {
    this.sky?.geometry.dispose();
    this.skyMaterial?.dispose();
    this.envRT?.dispose();
    this._pmrem?.dispose();
    this.dust?.geometry.dispose();
    this.dustMaterial?.dispose();
    this.dustSprite?.dispose();
  }
}

/**
 * The fog colour for a biome: its declared fog pulled partway onto its own sky.
 * See `FOG`. Mixing happens in the renderer's linear working space, which is
 * where the sky shader mixes the same colours, so the two agree.
 */
function fogColor(biome, out = new THREE.Color()) {
  const S = biome.sky;
  // The band the far terrain actually sits against: horizon amber carrying some
  // of the hot haze that hugs the horizon line.
  out.set(S.horizon).lerp(_c1.set(S.haze), FOG.hazeBlend);
  // The blend is per biome where the biome asks for it: a roofed stage has no
  // horizon band for its distance to converge toward, so it keeps its own hue.
  out.lerp(_c1.set(biome.fog.color), 1 - (biome.fog.skyBlend ?? FOG.skyBlend));
  return out.multiplyScalar(FOG.value);
}

function wrapTo(v, h) {
  const s = h * 2;
  return ((((v + h) % s) + s) % s) - h;
}
