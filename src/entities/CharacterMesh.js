import * as THREE from 'three';
import { clamp, lerp } from '../core/MathUtil.js';

/**
 * Procedural survivor: a bone-like Group hierarchy built from primitives plus
 * an animator that drives it. No skinning, no external assets — every joint is
 * an Object3D pivot and every pose is written into `rotation`/`position`.
 *
 * Layout (model forward is +Z, feet at y=0):
 *   root > rig > pelvis > spine > chest > { neck>head, shoulderL/R > elbow > hand, coat }
 *                       > hipL/R > knee > foot
 *
 * The animator is a set of layers evaluated in order, each overwriting or
 * adding onto the previous:
 *   1. base pose      (rest angles)
 *   2. locomotion     (sine cycle, amplitude/frequency from horizontal speed)
 *   3. airborne       (tuck on rise, reach on fall)
 *   4. dash pose
 *   5. upper-body aim override (chest/arms decoupled from legs)
 *   6. additive recoil
 * State transitions run through damped springs so nothing ever hard-cuts.
 */

// Critically-damped-ish spring. `freq` is roughly the settle rate in rad/s;
// higher = snappier. Stepping is clamped so a long frame can't blow it up.
class Spring {
  constructor(value = 0, freq = 14, zeta = 1) {
    this.value = value; this.vel = 0; this.freq = freq; this.zeta = zeta;
  }
  step(target, dt) {
    const w = this.freq;
    let remaining = dt;
    while (remaining > 0) {
      const t = Math.min(remaining, 1 / 90);
      remaining -= t;
      this.vel += (w * w * (target - this.value) - 2 * this.zeta * w * this.vel) * t;
      this.value += this.vel * t;
    }
    return this.value;
  }
  set(v) { this.value = v; this.vel = 0; }
}

const COL = {
  coat: 0x22303f,      // navy shell — the dark half of the value break
  coatDark: 0x121a24,  // cloth / underlayer, near-black
  plate: 0xcbcec9,     // light armour — the light half. Carries the read.
  plateMid: 0x76808a,  // secondary plate, sits between the two
  // The cape is the largest surface the gameplay camera sees, so it must be the
  // MID value, not the light one — the helmet owns the light end. Pale cloth
  // next to a pale helm gave the character no head in the outline.
  cloak: 0x5a646c,
  accent: 0xff7a3d,
  skinDark: 0x39404b,
  metal: 0x8d97a3,
  // Not near-black: at 0.8 metalness with no env map this rendered at 1/255,
  // i.e. darker than the terrain behind it, and the slung weapon punched a hole
  // through the middle of the body instead of drawing a line across it.
  gunmetal: 0x3d4753,
  visor: 0x35e0ff,
  cell: 0x4de3ff,
};

/**
 * MeshStandardMaterial + two cheap form terms folded in before lighting:
 *
 *  - a fresnel RIM in the emissive radiance. The character cannot rely on the
 *    stage key light (it changes per stage), so every edge lifts itself against
 *    whatever is behind it.
 *  - a HEMISPHERIC bias on the diffuse albedo. The stage key is a single
 *    low-contrast directional, so two facets of the same body 40 deg apart were
 *    measured at under 6/255 apart — `flatShading` had geometry to differentiate
 *    and no light to do it with. Tilting albedo by the facet's world-space
 *    up-ness gives every rig sky-over-bounce separation that is independent of
 *    the key direction, which is what makes a faceted body read as a solid.
 *
 * Implemented as a subclass rather than a bare `onBeforeCompile` assignment so
 * `clone()` — which VFX.hitFlash does to every mesh on the rig — keeps the patch
 * and the params.
 *
 * Exported because the monster rigs need exactly the same tricks: without them
 * an enemy standing on shadowed rock is one flat shape on another.
 */
export class RimStandardMaterial extends THREE.MeshStandardMaterial {
  constructor({ rimColor = 0xa9d2ff, rimStrength = 0.55, rimPower = 2.6,
    hemiStrength = 0.22, ...rest } = {}) {
    super(rest);
    this.rimColor = new THREE.Color(rimColor);
    this.rimStrength = rimStrength;
    this.rimPower = rimPower;
    this.hemiStrength = hemiStrength;
  }

  copy(src) {
    super.copy(src);
    this.rimColor = src.rimColor.clone();
    this.rimStrength = src.rimStrength;
    this.rimPower = src.rimPower;
    this.hemiStrength = src.hemiStrength;
    return this;
  }

  onBeforeCompile(shader) {
    shader.uniforms.uRimColor = { value: this.rimColor };
    shader.uniforms.uRimStrength = { value: this.rimStrength };
    shader.uniforms.uRimPower = { value: this.rimPower };
    shader.uniforms.uHemi = { value: this.hemiStrength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uRimColor;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform float uHemi;
      `)
      // After emissivemap_fragment `normal`, `diffuseColor` and
      // `totalEmissiveRadiance` all exist and none of them has been consumed
      // yet — `lights_physical_fragment` is the next chunk. Lighting downstream
      // is left completely untouched.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          vec3 nrm = normalize(normal);
          float rimF = 1.0 - clamp(dot(nrm, normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance += uRimColor * (pow(rimF, uRimPower) * uRimStrength);
          // World up expressed in view space, so the term is view-independent.
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float hemi = dot(nrm, upV) * 0.5 + 0.5;
          diffuseColor.rgb *= mix(1.0 - uHemi, 1.0 + uHemi, hemi);
        }
      `);
  }
}

function mat(color, { rough = 0.72, metal = 0.05, emissive = 0, emissiveIntensity = 1,
  rimColor, rimStrength, rimPower, hemiStrength, side } = {}) {
  return new RimStandardMaterial({
    color, roughness: rough, metalness: metal, flatShading: true,
    emissive, emissiveIntensity, rimColor, rimStrength, rimPower, hemiStrength,
    ...(side ? { side } : null),
  });
}

// A tapered faceted box — the workhorse limb shape. Low segment counts keep
// the silhouette readable and the shading hard-edged.
function limb(len, top, bottom, material, sides = 5) {
  const g = new THREE.CylinderGeometry(top, bottom, len, sides, 1);
  g.translate(0, -len / 2, 0); // pivot at the joint, body hangs down -Y
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

function boxMesh(w, h, d, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = true;
  return m;
}

// Contact-shadow blob. This is a MULTIPLY decal, not a composite: the previous
// version tried to solve "a subtractive blob is invisible on luma-6 ground" by
// *adding* a grey ring, and on the lit grade that ships now that ring measured
// 77-165 against a floor of 24 — the brightest object on the ground plane and
// the exact inverse of a shadow.
//
// The rule this shader holds instead: a contact decal may only ever attenuate
// what is under it. `gl_FragColor.rgb` is premultiplied by `a`, so with
// (DstColor, OneMinusSrcAlpha) blending the result is
//   dst * (SHADE * a) + dst * (1 - a)  ==  dst * (1 - a * (1 - SHADE))
// which is <= dst for every channel at every alpha. Visibility on near-black
// ground comes from the *hue* rather than the value: red is attenuated hardest
// and blue least, so deepening contact goes cool instead of grey, and the
// ground's own texture survives instead of being flattened by a constant.
//
// Deliberately duplicated from the monsters' instanced version in
// EnemyMeshes.js rather than shared — that module imports this one, and a
// cycle between the two entity modules is not worth six lines of GLSL.
const BLOB_FRAG = /* glsl */`
uniform float uFade;
varying vec2 vBlobUv;
varying float vGraze;
void main() {
  float r = length(vBlobUv - 0.5) * 2.0;
  float core = smoothstep(1.00, 0.14, r);
  float ring = smoothstep(0.48, 0.80, r) * smoothstep(1.02, 0.82, r);
  // A ground disc seen edge-on projects to a bar a few pixels tall — all
  // annulus, no disc — which reads as a rendering glitch rather than contact.
  float a = (core * 0.62 + ring * 0.16) * uFade * smoothstep(0.05, 0.22, vGraze);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vec3(0.06, 0.09, 0.16) * a, a);
}`;

const BLOB_VERT = /* glsl */`
varying vec2 vBlobUv;
varying float vGraze;
void main() {
  vBlobUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vGraze = abs(normalize(cameraPosition - wp.xyz).y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

function pivot(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/**
 * The character's material set. Split out of the constructor so the boot-time
 * shader prewarm can warm these permutations (notably the dissolve-patched
 * doubled-sided cloth) without assembling a whole throwaway rig.
 */
export function makeCharacterMats() {
  return {
    // The dark half of the value break still has to be *readable* dark, not a
    // hole in the frame: a sliver of self-emissive keeps the navy shell off the
    // crushed-black floor when the survivor walks into terrain shadow.
    coat: mat(COL.coat, { rough: 0.78, rimStrength: 0.85, emissive: COL.coat, emissiveIntensity: 0.16 }),
    coatDark: mat(COL.coatDark, { rough: 0.85, rimStrength: 0.95, emissive: 0x1d2a38, emissiveIntensity: 0.2 }),
    // Cloth is the only double-sided material — the open-ended coat and cape
    // shells need it and nothing else does.
    cloth: mat(COL.coatDark, { rough: 0.9, rimStrength: 1.0, side: THREE.DoubleSide }),
    cloak: mat(COL.cloak, {
      rough: 0.88, rimStrength: 0.55, emissive: 0x2a3540, emissiveIntensity: 0.22,
      side: THREE.DoubleSide,
    }),
    // Light armour. A touch of self-emissive keeps the plates off pure black
    // when the character walks into a shadow the stage lighting never fills.
    // Low rim on the light plate: it is already the bright value, and a
    // strong fresnel on top just tints it toward the rim hue.
    plate: mat(COL.plate, {
      rough: 0.42, metal: 0.28, emissive: COL.plate, emissiveIntensity: 0.09, rimStrength: 0.18,
    }),
    plateMid: mat(COL.plateMid, { rough: 0.5, metal: 0.3, rimStrength: 0.5 }),
    accent: mat(COL.accent, {
      rough: 0.55, emissive: COL.accent, emissiveIntensity: 0.9, rimColor: 0xffc08a, rimStrength: 0.5,
    }),
    cell: mat(0x0a1a20, { rough: 0.3, emissive: COL.cell, emissiveIntensity: 1.6, rimStrength: 0.3 }),
    body: mat(COL.skinDark, { rough: 0.6, metal: 0.2, rimStrength: 0.8 }),
    metal: mat(COL.metal, { rough: 0.4, metal: 0.7, rimStrength: 0.45 }),
    gun: mat(COL.gunmetal, {
      rough: 0.42, metal: 0.45, emissive: 0x141b24, emissiveIntensity: 0.5, rimStrength: 0.7,
    }),
    visor: mat(0x061418, { rough: 0.2, metal: 0.1, emissive: COL.visor, emissiveIntensity: 2.4 }),
  };
}

export class CharacterMesh {
  constructor() {
    this.mats = makeCharacterMats();
    this.build();
    this.initState();
  }

  build() {
    const M = this.mats;
    const root = new THREE.Group();
    this.group = root;

    // `rig` carries whole-body offsets (bob, lean, dash tilt) so the root stays
    // exactly at the capsule's feet for gameplay code to trust.
    const rig = pivot(root, 0, 0, 0);
    this.rig = rig;

    const pelvis = pivot(rig, 0, 0.92, 0);
    this.pelvis = pelvis;
    const hipBlock = boxMesh(0.34, 0.22, 0.24, M.coatDark);
    hipBlock.position.y = -0.04;
    pelvis.add(hipBlock);

    const spine = pivot(pelvis, 0, 0.10, 0);
    this.spine = spine;
    const chest = pivot(spine, 0, 0.20, 0);
    this.chest = chest;

    const torso = limb(0.36, 0.24, 0.19, M.coat, 6);
    torso.position.y = 0.06;
    torso.scale.z = 0.82;
    chest.add(torso);

    // --- value structure ---------------------------------------------------
    // Light armour (M.plate) laid over the dark navy shell. The torso is never
    // one mass: a bright yoke and chest plate against a near-black coat is
    // what makes the form legible at 5.4 units with no help from the stage
    // key light.
    // Runs the full shoulder width — clavicle to clavicle — so the light plate
    // is one continuous bar from the torso out into both deltoids. A yoke that
    // stops short of the shoulder pivots leaves the arms as separate objects
    // sharing a row.
    const yoke = boxMesh(0.44, 0.09, 0.26, M.plate);
    yoke.position.set(0, 0.20, 0);
    chest.add(yoke);

    const plate = boxMesh(0.29, 0.21, 0.10, M.plate);
    plate.position.set(0, -0.02, 0.13);
    chest.add(plate);
    const stripe = boxMesh(0.05, 0.17, 0.03, M.accent);
    stripe.position.set(0, -0.02, 0.19);
    chest.add(stripe);

    // The gameplay camera sits behind the head, so the back is the surface
    // that actually gets looked at. A pale cloak owns it — anything plated
    // onto the torso itself would just be occluded by the cloth. Everything
    // that has to read from behind therefore hangs off the cloak pivot, on
    // the outside of the shell.
    // The cape is built as two shells, not one: a bright plate yoke across the
    // shoulders over a mid-value lower cape. That light-over-dark break is the
    // whole value structure of the character from behind, where the camera
    // actually is — the plated chest is occluded 100% of the time. It is also
    // short (0.38 rather than 0.52) and narrow at the hem (0.24 rather than
    // 0.33) so it stops at the ribs instead of swallowing the arms and merging
    // with the coat into one continuous cone.
    const capePivot = pivot(chest, -0.02, 0.19, -0.02);
    this.cape = capePivot;

    const yokeGeo = new THREE.CylinderGeometry(0.205, 0.245, 0.14, 5, 1, true, Math.PI * 0.66, Math.PI * 0.84);
    yokeGeo.translate(0, -0.07, 0);
    const capeYoke = new THREE.Mesh(yokeGeo, M.plate);
    capeYoke.castShadow = true;
    capePivot.add(capeYoke);

    const capeGeo = new THREE.CylinderGeometry(0.245, 0.24, 0.24, 5, 1, true, Math.PI * 0.66, Math.PI * 0.84);
    capeGeo.translate(0, -0.26, 0);
    const cape = new THREE.Mesh(capeGeo, M.cloak);
    cape.castShadow = true;
    capePivot.add(cape);

    // Accent runs the full centre seam, tying the two shells together and
    // giving the back one saturated vertical line.
    const spineTrim = boxMesh(0.055, 0.36, 0.03, M.accent);
    spineTrim.position.set(0.02, -0.19, -0.255);
    capePivot.add(spineTrim);

    // The back canister and its cyan cell used to live at x +0.155, i.e. inside
    // the same 30 px of shoulder as the sling stock, the pauldron and the spine
    // trim: that patch measured SD 50.7 against a mean of 66.4 — six competing
    // shapes in a strip narrower than the helmet. They are gone. The sling and
    // the accent seam are the two things that shoulder is allowed to say.

    // Slung carbine across the cloak. Reads from behind no matter where the
    // held weapon is pointing, it is the strongest single line in the
    // silhouette, and dark hardware on pale cloth is the biggest value
    // contrast on the model.
    // Slung carbine. Canted hard enough that the muzzle and the stock both
    // break the cape outline — a weapon that stays inside the cloth footprint
    // contributes nothing to the silhouette no matter what value it is. The
    // light receiver plate is what actually draws the line across the back.
    const sling = new THREE.Group();
    sling.position.set(-0.03, -0.17, -0.255);
    sling.rotation.set(0.14, 0, -0.92);
    capePivot.add(sling);
    const slingBody = boxMesh(0.09, 0.46, 0.13, M.gun);
    sling.add(slingBody);
    // Stock: a stepped wedge, so the top end is not a bare rectangle.
    const slingStock = boxMesh(0.115, 0.17, 0.15, M.plateMid);
    slingStock.position.y = 0.28;
    sling.add(slingStock);
    const slingComb = boxMesh(0.07, 0.09, 0.10, M.gun);
    slingComb.position.set(0, 0.40, -0.02);
    sling.add(slingComb);
    // Barrel + muzzle step, tapering out past the hem.
    const slingBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.028, 0.30, 6), M.metal);
    slingBarrel.position.y = -0.36;
    slingBarrel.castShadow = true;
    sling.add(slingBarrel);
    const slingMuzzle = boxMesh(0.055, 0.07, 0.055, M.plateMid);
    slingMuzzle.position.y = -0.53;
    sling.add(slingMuzzle);
    const slingCell = boxMesh(0.03, 0.24, 0.03, M.cell);
    slingCell.position.set(0, -0.06, 0.075);
    sling.add(slingCell);

    // Coat: open-ended taper hung from the pelvis. The accent hem draws a
    // bright line across the bottom of the dark mass.
    const coatGeo = new THREE.CylinderGeometry(0.24, 0.30, 0.58, 7, 1, true);
    coatGeo.translate(0, -0.29, 0);
    const coat = new THREE.Mesh(coatGeo, M.cloth);
    coat.castShadow = true;
    const coatPivot = pivot(pelvis, 0, 0.16, 0);
    coatPivot.add(coat);
    const hemGeo = new THREE.CylinderGeometry(0.305, 0.31, 0.05, 7, 1, true);
    hemGeo.translate(0, -0.56, 0);
    const hem = new THREE.Mesh(hemGeo, M.accent);
    coatPivot.add(hem);
    this.coat = coatPivot;

    // Head — light crown, dark jaw, hot visor. The top of the silhouette is
    // the brightest thing on the model.
    const neck = pivot(chest, 0, 0.28, 0);
    this.neck = neck;
    // Bigger and lifted clear of the shoulder line: at 0.32 wide sitting level
    // with a 0.66-wide cape there was no head/neck notch in the outline at all.
    const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.19, 0), M.plate);
    helmet.scale.set(1, 1.05, 1.08);
    helmet.rotation.y = 0.4;
    helmet.position.y = 0.16;
    helmet.castShadow = true;
    neck.add(helmet);
    const jaw = boxMesh(0.17, 0.09, 0.18, M.coatDark);
    jaw.position.set(0, 0.02, 0.02);
    neck.add(jaw);
    // Dark nape guard: without it the pale helm reads as one round blob from
    // the gameplay camera, which sits directly behind the head.
    const nape = boxMesh(0.19, 0.115, 0.07, M.coat);
    nape.position.set(0, 0.06, -0.12);
    neck.add(nape);
    // The visor is on the face and the camera is behind the head, so the head
    // would otherwise never own the brightest pixel on the model. This strip is
    // the visor's read from the only angle the player has.
    const napeLamp = boxMesh(0.11, 0.028, 0.02, M.cell);
    napeLamp.position.set(0, 0.085, -0.155);
    neck.add(napeLamp);
    const visor = boxMesh(0.20, 0.075, 0.09, M.visor);
    visor.position.set(0, 0.11, 0.11);
    neck.add(visor);
    this.visor = visor;
    // Crest runs front-to-back over the crown so the accent is visible from
    // behind too, which is where the camera actually is.
    const crest = boxMesh(0.035, 0.09, 0.30, M.accent);
    crest.position.set(0, 0.30, -0.04);
    crest.rotation.x = -0.12;
    neck.add(crest);
    // Off-centre antenna: a single asymmetric spike out of the head profile.
    const antenna = boxMesh(0.022, 0.30, 0.022, M.metal);
    antenna.position.set(-0.115, 0.33, -0.05);
    antenna.rotation.set(-0.28, 0, 0.34);
    neck.add(antenna);
    const beacon = boxMesh(0.04, 0.04, 0.04, M.cell);
    beacon.position.set(-0.16, 0.47, -0.09);
    neck.add(beacon);

    // Arms
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      // The arm has to do two contradictory things: clear the cape hem (0.245)
      // so it is IN the outline, and overlap the torso (edge ~0.21) so it is
      // ATTACHED to it. At a pivot of 0.26 with a 0.065 upper arm it did
      // neither — there were 4 px of pure terrain between torso and arm, and in
      // a black-key test the arm was a floating lozenge. Pulling the pivot in
      // to 0.215 and fattening the deltoid to 0.105 makes the arm span
      // 0.11 -> 0.32: a ~0.03 unit (~4 px) overlap onto the torso at the
      // shoulder, and still 0.075 clear of the cape at the outside. The arm now
      // separates from the body by VALUE (dark limb under a light yoke), which
      // is what it should have been doing all along.
      const shoulder = pivot(chest, 0.215 * side, 0.20, 0);
      const pad = new THREE.Mesh(new THREE.IcosahedronGeometry(0.115, 0), M.coat);
      pad.scale.set(1.15, 0.9, 1.0);
      pad.castShadow = true;
      shoulder.add(pad);
      if (side < 0) {
        // One pauldron plane, not two. The second plate was a 0.19 slab sitting
        // 0.06 below the first at a different angle, and at gameplay distance
        // the pair read as noise rather than as layered armour.
        const p1 = boxMesh(0.23, 0.11, 0.25, M.plate);
        p1.position.set(-0.04, 0.045, 0);
        p1.rotation.z = 0.32;
        shoulder.add(p1);
      } else {
        const cap = boxMesh(0.16, 0.075, 0.17, M.plateMid);
        cap.position.set(0.015, 0.055, 0);
        shoulder.add(cap);
      }
      // Fat at the deltoid, thin at the elbow: the taper is what reads as an
      // arm at 240 px tall, and the fat end is what welds it to the torso.
      const upper = limb(0.28, 0.105, 0.058, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.28, 0);
      const fore = limb(0.25, 0.058, 0.048, M.coatDark);
      elbow.add(fore);
      const bracer = boxMesh(0.085, 0.11, 0.09, side < 0 ? M.plateMid : M.plate);
      bracer.position.y = -0.15;
      elbow.add(bracer);
      const hand = pivot(elbow, 0, -0.25, 0);
      const fist = boxMesh(0.085, 0.09, 0.095, M.body);
      hand.add(fist);
      this.arms[key] = { shoulder, elbow, hand };
    }

    // Weapon: chunky sidearm in the right hand, muzzle exposed for VFX. The
    // light receiver and the lit muzzle ring keep it separate from the dark
    // forearm behind it.
    const gun = new THREE.Group();
    gun.position.set(0, -0.02, 0.03);
    this.arms.R.hand.add(gun);
    const body = boxMesh(0.075, 0.11, 0.30, M.gun);
    body.position.set(0, 0.02, 0.08);
    gun.add(body);
    const receiver = boxMesh(0.085, 0.055, 0.20, M.plate);
    receiver.position.set(0, 0.085, 0.06);
    gun.add(receiver);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.26, 6), M.metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.045, 0.26);
    barrel.castShadow = true;
    gun.add(barrel);
    const grip = boxMesh(0.065, 0.16, 0.08, M.coatDark);
    grip.position.set(0, -0.09, -0.01);
    grip.rotation.x = -0.22;
    gun.add(grip);
    const sight = boxMesh(0.03, 0.03, 0.05, M.accent);
    sight.position.set(0, 0.13, 0.10);
    gun.add(sight);
    const glow = boxMesh(0.055, 0.02, 0.14, M.cell);
    glow.position.set(0, 0.05, 0.34);
    gun.add(glow);
    this.gun = gun;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.045, 0.40);
    gun.add(this.muzzle);

    // Legs: dark thigh under the coat, light shin below the hem. That flip
    // is what makes the walk cycle legible at gameplay distance — the bright
    // shins scissor against the dark ground.
    this.legs = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const hip = pivot(pelvis, 0.115 * side, -0.10, 0);
      const thigh = limb(0.42, 0.085, 0.068, M.coatDark);
      hip.add(thigh);
      const knee = pivot(hip, 0, -0.42, 0);
      const shin = limb(0.40, 0.075, 0.055, M.plate);
      knee.add(shin);
      const ankle = pivot(knee, 0, -0.40, 0);
      const boot = boxMesh(0.12, 0.10, 0.26, M.coatDark);
      boot.position.set(0, -0.03, 0.04);
      ankle.add(boot);
      const toe = boxMesh(0.11, 0.05, 0.06, M.accent);
      toe.position.set(0, -0.055, 0.15);
      ankle.add(toe);
      this.legs[key] = { hip, knee, ankle };
    }

    root.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });

    // Contact shadow. The stage's shadow map is one cascade over a big stage,
    // so the survivor's own cast shadow is soft to the point of absence right
    // under the feet — which is exactly where the eye looks for the ground
    // plane. This blob is what tells you the character is standing on the rock
    // rather than floating in front of it. One draw call, no shadow-map cost.
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    this.blobMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0.9 } },
      vertexShader: BLOB_VERT,
      fragmentShader: BLOB_FRAG,
      transparent: true,
      depthWrite: false,
      // Multiply, so the decal can only darken the floor it lands on.
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    const blob = new THREE.Mesh(blobGeo, this.blobMat);
    // Tight to the stance. At 1.15 the disc projected ~100 px against a 37 px
    // foot span and ran off the lip of whatever rock the survivor was standing
    // on, so the terrain clipped its uphill half and the remainder read as an
    // offset smear. A footprint that stays under the boots cannot do that.
    blob.scale.setScalar(0.8);
    blob.position.y = 0.04;
    blob.renderOrder = -1;
    blob.castShadow = false;
    blob.receiveShadow = false;
    root.add(blob);
    this.blob = blob;
  }

  initState() {
    this.phase = 0;
    this.bodyYaw = 0;
    this.time = 0;

    // Springs: every cross-state blend goes through one of these.
    this.sSpeed = new Spring(0, 11);       // 0..1 locomotion intensity
    this.sAir = new Spring(0, 13);         // 0..1 airborne blend
    this.sRise = new Spring(0, 9);         // -1 falling .. +1 rising
    this.sDash = new Spring(0, 20);        // 0..1 dash pose
    this.sAimYaw = new Spring(0, 22);      // upper-body twist (rad)
    this.sAimPitch = new Spring(0, 20);
    this.sLean = new Spring(0, 8);         // forward lean from accel
    this.sStrafe = new Spring(0, 9);
    this.sRecoil = new Spring(0, 34, 0.55); // underdamped: snaps back with a kick
    this.sSprint = new Spring(0, 8);

  }

  /** World-space muzzle position, for tracers and flashes. */
  getMuzzle(out) {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  /** Additive kick, 1.0 = full primary shot. */
  addRecoil(amount = 1) {
    this.sRecoil.vel -= amount * 26;
  }

  /**
   * @param {number} dt seconds (presentation time)
   * @param {object} s  { velocity, grounded, aimYaw, aimPitch, dashT, sprint, dead }
   */
  update(dt, s) {
    this.time += dt;
    const vel = s.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    const moveSpeedRef = s.moveSpeed || 7;
    const norm = clamp(speed / moveSpeedRef, 0, 1.6);

    const grounded = s.grounded;
    this.sSpeed.step(grounded ? norm : norm * 0.35, dt);
    this.sAir.step(grounded ? 0 : 1, dt);
    this.sRise.step(grounded ? 0 : clamp(vel.y / 7, -1, 1), dt);
    this.sDash.step(s.dashT || 0, dt);
    this.sSprint.step(s.sprint ? 1 : 0, dt);
    const recoil = this.sRecoil.step(0, dt);

    // --- body facing -------------------------------------------------------
    // Face the movement direction while moving, the aim direction when not.
    // The upper body then twists back toward the aim — that decoupling is most
    // of what makes the character read while strafing.
    let desiredYaw = s.aimYaw;
    if (speed > 0.8) {
      const moveYaw = Math.atan2(vel.x, vel.z);
      // Blend toward aim so backpedalling doesn't spin the model around.
      let d = wrapPi(moveYaw - s.aimYaw);
      d = clamp(d, -1.15, 1.15);
      desiredYaw = s.aimYaw + d;
    }
    const turnRate = 1 - Math.exp(-dt / 0.075);
    this.bodyYaw += wrapPi(desiredYaw - this.bodyYaw) * turnRate;
    this.group.rotation.y = this.bodyYaw;

    const aimYawLocal = clamp(wrapPi(s.aimYaw - this.bodyYaw), -1.3, 1.3);
    this.sAimYaw.step(aimYawLocal, dt);
    this.sAimPitch.step(clamp(s.aimPitch, -1.1, 1.1), dt);

    // Lean: project velocity into body space, lean into acceleration.
    const cos = Math.cos(-this.bodyYaw), sin = Math.sin(-this.bodyYaw);
    const localZ = vel.z * cos - vel.x * sin;
    const localX = vel.x * cos + vel.z * sin;
    this.sLean.step(clamp(localZ / moveSpeedRef, -1, 1), dt);
    this.sStrafe.step(clamp(localX / moveSpeedRef, -1, 1), dt);

    const S = this.sSpeed.value;
    const air = this.sAir.value;
    const rise = this.sRise.value;
    const dash = this.sDash.value;
    const ground = 1 - air;

    // --- 1/2. locomotion ---------------------------------------------------
    // Frequency and amplitude both ride on speed: a slow walk is long and low,
    // a sprint is fast and tall. 2*PI*(0.75 + speed*0.42) lands at ~2.1Hz at
    // walk (7 m/s) and ~2.9Hz sprinting, which is where the footfalls stop
    // looking like skating.
    const stepFreq = 0.75 + norm * 1.35;
    this.phase += dt * stepFreq * Math.PI * 2 * (grounded ? 1 : 0.25);
    const p = this.phase;
    const amp = S;

    const swing = Math.sin(p);
    const swing2 = Math.sin(p + Math.PI);

    const legs = this.legs;
    // Thigh swing; knee only ever bends backwards (max(0,...)) so it never
    // hyperextends, and the bend peaks just after the leg passes under the hip.
    legs.L.hip.rotation.x = swing * 0.72 * amp;
    legs.R.hip.rotation.x = swing2 * 0.72 * amp;
    legs.L.knee.rotation.x = -Math.max(0, -Math.sin(p - 0.7)) * 1.15 * amp - 0.06;
    legs.R.knee.rotation.x = -Math.max(0, -Math.sin(p - 0.7 + Math.PI)) * 1.15 * amp - 0.06;
    // Foot planting: ankle counter-rotates so the sole stays flat through the
    // contact half of the cycle, then toes off.
    legs.L.ankle.rotation.x = (-swing * 0.35 + Math.max(0, swing) * 0.30) * amp;
    legs.R.ankle.rotation.x = (-swing2 * 0.35 + Math.max(0, swing2) * 0.30) * amp;
    legs.L.hip.rotation.z = 0.04 + swing * 0.05 * amp;
    legs.R.hip.rotation.z = -0.04 - swing2 * 0.05 * amp;

    // Hip counter-rotation + chest counter-counter-rotation.
    this.pelvis.rotation.y = -swing * 0.20 * amp;
    this.pelvis.rotation.z = swing * 0.05 * amp;
    // Double-frequency vertical bob (two footfalls per cycle) + lateral sway.
    const bob = -Math.abs(Math.cos(p)) * 0.055 * amp;
    this.rig.position.y = bob + this.sDash.value * -0.14;
    this.rig.position.x = Math.sin(p) * 0.018 * amp;

    // --- 3. airborne -------------------------------------------------------
    // Rising = tuck (knees up, arms in), falling = reach (legs trail, arms out).
    if (air > 0.001) {
      const tuck = clamp(rise, 0, 1);
      const fall = clamp(-rise, 0, 1);
      const hipAir = lerp(0.35, -0.30, fall) + tuck * 0.55;
      const kneeAir = -(0.15 + tuck * 1.25 + fall * 0.35);
      legs.L.hip.rotation.x = lerp(legs.L.hip.rotation.x, hipAir + 0.18, air);
      legs.R.hip.rotation.x = lerp(legs.R.hip.rotation.x, hipAir - 0.22, air);
      legs.L.knee.rotation.x = lerp(legs.L.knee.rotation.x, kneeAir, air);
      legs.R.knee.rotation.x = lerp(legs.R.knee.rotation.x, kneeAir * 0.7, air);
      legs.L.ankle.rotation.x = lerp(legs.L.ankle.rotation.x, 0.35 - fall * 0.5, air);
      legs.R.ankle.rotation.x = lerp(legs.R.ankle.rotation.x, 0.35 - fall * 0.5, air);
      this.pelvis.rotation.x = lerp(this.pelvis.rotation.x, tuck * 0.22 - fall * 0.12, air);
    } else {
      this.pelvis.rotation.x = 0;
    }

    // --- 4. dash -----------------------------------------------------------
    if (dash > 0.001) {
      legs.L.hip.rotation.x = lerp(legs.L.hip.rotation.x, 0.95, dash);
      legs.R.hip.rotation.x = lerp(legs.R.hip.rotation.x, -0.35, dash);
      legs.L.knee.rotation.x = lerp(legs.L.knee.rotation.x, -1.5, dash);
      legs.R.knee.rotation.x = lerp(legs.R.knee.rotation.x, -0.9, dash);
      this.pelvis.rotation.x = lerp(this.pelvis.rotation.x, 0.30, dash);
    }

    // --- torso: lean, sprint crouch, dash tilt -----------------------------
    const lean = this.sLean.value;
    const sprint = this.sSprint.value;
    this.spine.rotation.x = ground * (lean * 0.16 + sprint * 0.14 * S) + dash * 0.30 + air * 0.05;
    this.spine.rotation.z = -this.sStrafe.value * 0.10;

    // --- 5. upper-body aim override ----------------------------------------
    // Chest takes most of the twist, neck takes the remainder, so the head
    // always ends up on the aim direction regardless of what the legs do.
    const ay = this.sAimYaw.value;
    const ap = this.sAimPitch.value;
    this.chest.rotation.y = ay * 0.62 + swing * 0.16 * amp; // arm swing counter-rot
    this.chest.rotation.x = -ap * 0.32 - recoil * 0.10;
    this.chest.rotation.z = this.sStrafe.value * 0.06;
    this.neck.rotation.y = ay * 0.38;
    this.neck.rotation.x = -ap * 0.55 - this.spine.rotation.x * 0.6 + recoil * 0.14;

    const armL = this.arms.L, armR = this.arms.R;
    // Idle/run arm swing (opposite the legs).
    const swingArm = -swing * 0.62 * amp;
    armL.shoulder.rotation.x = swingArm * -1;
    armR.shoulder.rotation.x = swingArm;
    armL.shoulder.rotation.z = 0.16 + amp * 0.05;
    armR.shoulder.rotation.z = -0.16 - amp * 0.05;
    armL.elbow.rotation.x = -0.35 - amp * 0.45;
    armR.elbow.rotation.x = -0.35 - amp * 0.45;

    if (air > 0.001) {
      const fall = clamp(-rise, 0, 1);
      armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, -0.9 - fall * 0.5, air * 0.8);
      armL.shoulder.rotation.z = lerp(armL.shoulder.rotation.z, 0.45 + fall * 0.35, air);
      armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, -1.3 + fall * 0.6, air);
    }

    // The weapon arm ignores all of the above and points down the aim ray.
    // -PI/2 about X swings the down-hanging arm to model-forward (+Z); the
    // residual aim pitch/yaw is what the chest didn't already absorb.
    const resYaw = ay - this.chest.rotation.y;
    const resPitch = -ap - this.chest.rotation.x;
    const aimWeight = 1 - dash * 0.75;
    armR.shoulder.rotation.x = lerp(armR.shoulder.rotation.x, -Math.PI / 2 + resPitch + recoil * 0.55, aimWeight);
    armR.shoulder.rotation.y = lerp(armR.shoulder.rotation.y, resYaw * 0.9 - 0.12, aimWeight);
    armR.shoulder.rotation.z = lerp(armR.shoulder.rotation.z, 0.06, aimWeight);
    armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, -0.20 + recoil * 0.35, aimWeight);
    // Support hand drifts toward the weapon while firing.
    const support = clamp(-recoil * 2.5, 0, 1);
    armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, -Math.PI / 2 + resPitch * 0.9, support * 0.7);
    armL.shoulder.rotation.y = lerp(armL.shoulder.rotation.y, resYaw * 0.8 + 0.30, support * 0.7);
    armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, -0.7, support * 0.7);

    // --- 6. cloth ----------------------------------------------------------
    // Coat trails the motion: driven by local velocity, not by the animation
    // phase, so it also reacts to dashes and knockback.
    const flutter = Math.sin(this.time * 9 + p) * 0.03 * (0.3 + norm);
    this.coat.rotation.x = -this.sLean.value * 0.30 - air * 0.10 + flutter;
    this.coat.rotation.z = this.sStrafe.value * 0.24;
    this.cape.rotation.x = -0.06 - this.sLean.value * 0.55 - dash * 0.5 + flutter * 1.6;
    this.cape.rotation.z = this.sStrafe.value * 0.35;

    // Contact shadow: full strength on the ground, gone by the top of a jump.
    // The blob rides the root, which does not know the terrain height, so
    // fading it out is what keeps it from following the character into the air.
    const grounded01 = (1 - air) * (1 - air);
    this.blobMat.uniforms.uFade.value = 0.9 * grounded01;
    this.blob.visible = grounded01 > 0.02;
    this.blob.scale.setScalar(0.8 + air * 0.25);

    // Visor pulses hot on fire — cheap but it sells the shot from behind.
    this.mats.visor.emissiveIntensity = 2.4 + clamp(-recoil, 0, 1) * 3.5;
  }

  setVisible(v) { this.group.visible = v; }
}

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
