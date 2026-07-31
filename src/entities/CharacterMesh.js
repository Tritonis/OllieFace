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
  cloak: 0xb6bcbc,     // pale cloth — the big back-facing light mass
  accent: 0xff7a3d,
  skinDark: 0x39404b,
  metal: 0x8d97a3,
  gunmetal: 0x232a33,
  visor: 0x35e0ff,
  cell: 0x4de3ff,
};

/**
 * MeshStandardMaterial + a fresnel rim term folded into the emissive radiance.
 * The character cannot rely on the stage key light (it changes per stage), so
 * every edge lifts itself against whatever is behind it. Implemented as a
 * subclass rather than a bare `onBeforeCompile` assignment so `clone()` — which
 * VFX.hitFlash does to every mesh on the rig — keeps the patch and the params.
 */
class RimStandardMaterial extends THREE.MeshStandardMaterial {
  constructor({ rimColor = 0xa9d2ff, rimStrength = 0.55, rimPower = 2.6, ...rest } = {}) {
    super(rest);
    this.rimColor = new THREE.Color(rimColor);
    this.rimStrength = rimStrength;
    this.rimPower = rimPower;
  }

  copy(src) {
    super.copy(src);
    this.rimColor = src.rimColor.clone();
    this.rimStrength = src.rimStrength;
    this.rimPower = src.rimPower;
    return this;
  }

  onBeforeCompile(shader) {
    shader.uniforms.uRimColor = { value: this.rimColor };
    shader.uniforms.uRimStrength = { value: this.rimStrength };
    shader.uniforms.uRimPower = { value: this.rimPower };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uRimColor;
        uniform float uRimStrength;
        uniform float uRimPower;
      `)
      // After emissivemap_fragment `normal` and `totalEmissiveRadiance` both
      // exist, and lighting downstream is left completely untouched.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          float rimF = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance += uRimColor * (pow(rimF, uRimPower) * uRimStrength);
        }
      `);
  }
}

function mat(color, { rough = 0.72, metal = 0.05, emissive = 0, emissiveIntensity = 1,
  rimColor, rimStrength, rimPower, side } = {}) {
  return new RimStandardMaterial({
    color, roughness: rough, metalness: metal, flatShading: true,
    emissive, emissiveIntensity, rimColor, rimStrength, rimPower,
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

function pivot(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

export class CharacterMesh {
  constructor() {
    this.mats = {
      coat: mat(COL.coat, { rough: 0.78, rimStrength: 0.85 }),
      coatDark: mat(COL.coatDark, { rough: 0.85, rimStrength: 0.95 }),
      // Cloth is the only double-sided material — the open-ended coat and cape
      // shells need it and nothing else does.
      cloth: mat(COL.coatDark, { rough: 0.9, rimStrength: 1.0, side: THREE.DoubleSide }),
      cloak: mat(COL.cloak, { rough: 0.88, rimStrength: 0.22, side: THREE.DoubleSide }),
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
      gun: mat(COL.gunmetal, { rough: 0.35, metal: 0.8, rimStrength: 0.45 }),
      visor: mat(0x061418, { rough: 0.2, metal: 0.1, emissive: COL.visor, emissiveIntensity: 2.4 }),
    };
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
    const yoke = boxMesh(0.32, 0.09, 0.26, M.plate);
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
    const capeGeo = new THREE.CylinderGeometry(0.22, 0.33, 0.52, 5, 1, true, Math.PI * 0.66, Math.PI * 0.84);
    capeGeo.translate(0, -0.26, 0);
    const cape = new THREE.Mesh(capeGeo, M.cloak);
    cape.castShadow = true;
    const capePivot = pivot(chest, -0.02, 0.19, -0.02);
    capePivot.add(cape);
    this.cape = capePivot;

    const spineTrim = boxMesh(0.05, 0.34, 0.03, M.accent);
    spineTrim.position.set(0.03, -0.14, -0.275);
    capePivot.add(spineTrim);

    const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.28, 6), M.gun);
    canister.position.set(0.16, -0.12, -0.255);
    canister.castShadow = true;
    capePivot.add(canister);
    const cell = boxMesh(0.05, 0.13, 0.03, M.cell);
    cell.position.set(0.16, -0.10, -0.320);
    capePivot.add(cell);

    // Slung carbine across the cloak. Reads from behind no matter where the
    // held weapon is pointing, it is the strongest single line in the
    // silhouette, and dark hardware on pale cloth is the biggest value
    // contrast on the model.
    const sling = new THREE.Group();
    sling.position.set(-0.02, -0.14, -0.275);
    sling.rotation.set(0.16, 0, -0.55);
    capePivot.add(sling);
    const slingBody = boxMesh(0.10, 0.62, 0.14, M.gun);
    sling.add(slingBody);
    const slingPlate = boxMesh(0.11, 0.20, 0.15, M.plateMid);
    slingPlate.position.y = 0.16;
    sling.add(slingPlate);
    const slingCell = boxMesh(0.03, 0.26, 0.03, M.cell);
    slingCell.position.set(0, -0.08, 0.08);
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
    const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), M.plate);
    helmet.scale.set(1, 1.05, 1.08);
    helmet.rotation.y = 0.4;
    helmet.position.y = 0.10;
    helmet.castShadow = true;
    neck.add(helmet);
    const jaw = boxMesh(0.17, 0.09, 0.18, M.coatDark);
    jaw.position.set(0, 0.02, 0.02);
    neck.add(jaw);
    // Dark nape guard: without it the pale helm reads as one round blob from
    // the gameplay camera, which sits directly behind the head.
    const nape = boxMesh(0.19, 0.115, 0.07, M.coat);
    nape.position.set(0, 0.045, -0.11);
    neck.add(nape);
    const visor = boxMesh(0.20, 0.075, 0.09, M.visor);
    visor.position.set(0, 0.11, 0.11);
    neck.add(visor);
    this.visor = visor;
    // Crest runs front-to-back over the crown so the accent is visible from
    // behind too, which is where the camera actually is.
    const crest = boxMesh(0.035, 0.09, 0.30, M.accent);
    crest.position.set(0, 0.215, -0.04);
    crest.rotation.x = -0.12;
    neck.add(crest);
    // Off-centre antenna: a single asymmetric spike out of the head profile.
    const antenna = boxMesh(0.022, 0.30, 0.022, M.metal);
    antenna.position.set(-0.10, 0.26, -0.05);
    antenna.rotation.set(-0.28, 0, 0.34);
    neck.add(antenna);
    const beacon = boxMesh(0.04, 0.04, 0.04, M.cell);
    beacon.position.set(-0.145, 0.40, -0.09);
    neck.add(beacon);

    // Arms
    this.arms = {};
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const shoulder = pivot(chest, 0.20 * side, 0.20, 0);
      const pad = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), M.coat);
      pad.scale.set(1.1, 0.9, 1.0);
      pad.castShadow = true;
      shoulder.add(pad);
      if (side < 0) {
        // Heavy layered pauldron, left only.
        const p1 = boxMesh(0.21, 0.10, 0.24, M.plate);
        p1.position.set(-0.05, 0.05, 0);
        p1.rotation.z = 0.30;
        shoulder.add(p1);
        const p2 = boxMesh(0.19, 0.09, 0.21, M.plateMid);
        p2.position.set(-0.10, -0.06, 0);
        p2.rotation.z = 0.48;
        shoulder.add(p2);
      } else {
        const cap = boxMesh(0.14, 0.07, 0.16, M.plateMid);
        cap.position.set(0.02, 0.06, 0);
        shoulder.add(cap);
      }
      const upper = limb(0.27, 0.065, 0.055, M.body);
      shoulder.add(upper);
      const elbow = pivot(shoulder, 0, -0.27, 0);
      const fore = limb(0.25, 0.055, 0.048, M.coatDark);
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
