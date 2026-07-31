import * as THREE from 'three';

/**
 * Ribbon trails.
 *
 * Each trail is a strip of quads rewritten every frame from a ring buffer of
 * recent world positions. The strip is billboarded per-vertex (side vector =
 * segment direction x view direction) so a trail is readable from any angle
 * without ever being edge-on, and it tapers to nothing at the tail so it reads
 * as motion rather than as a ribbon of tape.
 *
 * Geometry is allocated once at pool build; running a trail only writes floats.
 */

const MAX_POINTS = 48;

const TrailVert = /* glsl */ `
attribute vec2 aParam;   // x = 0 at tail .. 1 at head, y = -1..1 across width
attribute float aAlpha;
varying vec2 vParam;
varying float vAlpha;
void main() {
  vParam = aParam;
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TrailFrag = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uOpacity;
uniform float uCore;
varying vec2 vParam;
varying float vAlpha;
void main() {
  float edge = 1.0 - abs(vParam.y);
  float soft = smoothstep(0.0, 0.55, edge);
  // A tight power curve on top of the soft body gives the bright inner line
  // that makes a trail read as energy instead of as a smear.
  float core = pow(edge, 8.0) * uCore;
  vec3 col = uColor * soft + uCoreColor * core;
  float a = vAlpha * uOpacity * (soft + core * 0.5);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}
`;

class Trail {
  constructor(maxPoints) {
    this.max = maxPoints;
    this.px = new Float32Array(maxPoints);
    this.py = new Float32Array(maxPoints);
    this.pz = new Float32Array(maxPoints);
    this.pt = new Float32Array(maxPoints);
    this.head = 0;
    this.count = 0;

    const verts = maxPoints * 2;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.param = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
    this.alpha = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.param.setUsage(THREE.DynamicDrawUsage);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aParam', this.param);
    geo.setAttribute('aAlpha', this.alpha);

    const idx = new Uint16Array((maxPoints - 1) * 6);
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xffffff) },
        uCoreColor: { value: new THREE.Color(0xffffff) },
        uOpacity: { value: 1 },
        uCore: { value: 1.4 },
      },
      vertexShader: TrailVert,
      fragmentShader: TrailFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;

    this.active = false;
    this.emitting = false;
    this.follow = null;
    this.width = 0.2;
    this.life = 0.25;
    this.minDist = 0.06;
    this.lastX = 0; this.lastY = 0; this.lastZ = 0;
    this.hasLast = false;
  }

  reset(o) {
    this.head = 0;
    this.count = 0;
    this.hasLast = false;
    this.active = true;
    this.emitting = true;
    this.follow = o.follow || null;
    this.width = o.width ?? 0.2;
    this.life = o.life ?? 0.25;
    this.minDist = o.minDist ?? 0.06;
    this.mat.uniforms.uColor.value.set(o.color ?? 0xffffff);
    this.mat.uniforms.uCoreColor.value.set(o.coreColor ?? 0xffffff);
    this.mat.uniforms.uCore.value = o.core ?? 1.4;
    this.mat.uniforms.uOpacity.value = o.opacity ?? 1;
    this.mat.blending = o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.mesh.visible = true;
    this.mesh.renderOrder = o.renderOrder ?? 11;
  }

  push(x, y, z, now) {
    if (this.hasLast) {
      const dx = x - this.lastX, dy = y - this.lastY, dz = z - this.lastZ;
      if (dx * dx + dy * dy + dz * dz < this.minDist * this.minDist) {
        // Still refresh the head so a stationary emitter holds its trail tip.
        const h = (this.head - 1 + this.max) % this.max;
        if (this.count > 0) {
          this.px[h] = x; this.py[h] = y; this.pz[h] = z;
        }
        return;
      }
    }
    const i = this.head;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.pt[i] = now;
    this.head = (this.head + 1) % this.max;
    if (this.count < this.max) this.count++;
    this.lastX = x; this.lastY = y; this.lastZ = z;
    this.hasLast = true;
  }
}

const _p = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _next = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _side = new THREE.Vector3();

export class Trails {
  constructor({ capacity = 32 } = {}) {
    this.capacity = capacity;
    this.pool = [];
    this.time = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'vfx.trails';
    ctx.scene.add(this.root);
    for (let i = 0; i < this.capacity; i++) {
      const t = new Trail(MAX_POINTS);
      this.root.add(t.mesh);
      this.pool.push(t);
    }
  }

  /**
   * Starts a trail. Returns the handle; call `stop(handle)` when the emitter
   * dies and the tail keeps flying out on its own.
   */
  spawn(o = {}) {
    // Positional-argument callers get a Vector3 here, which silently resets a
    // pooled trail to white with zero points and burns a slot every call.
    // Warn once and refuse rather than throw — this runs inside an attack.
    if (o.isVector3 || arguments.length > 1) {
      if (!this._warnedSig) {
        this._warnedSig = true;
        console.warn('Trails.spawn takes a single options object: { position, life, width, color }');
      }
      return null;
    }
    let t = null;
    for (const c of this.pool) if (!c.active) { t = c; break; }
    // Pool exhausted: steal the shortest trail rather than dropping the effect.
    if (!t) {
      t = this.pool[0];
      for (const c of this.pool) if (c.count < t.count) t = c;
    }
    t.reset(o);
    if (o.position) t.push(o.position.x, o.position.y, o.position.z, this.time);
    return t;
  }

  /** Feed a manual position (projectiles that don't own an Object3D). */
  move(t, x, y, z) {
    if (t && t.active && t.emitting) t.push(x, y, z, this.time);
  }

  /** Stop emitting; the existing points age out and the trail recycles itself. */
  stop(t) {
    if (t) t.emitting = false;
  }

  /** Kill immediately. */
  kill(t) {
    if (!t) return;
    t.active = false;
    t.emitting = false;
    t.count = 0;
    t.mesh.visible = false;
  }

  update(ctx, dt) {
    this.time += dt;
    const now = this.time;
    const cam = ctx.camera;

    for (const t of this.pool) {
      if (!t.active) continue;

      if (t.emitting && t.follow) {
        t.follow.getWorldPosition(_p);
        t.push(_p.x, _p.y, _p.z, now);
      }

      // Retire points older than the trail's life.
      while (t.count > 0) {
        const tail = (t.head - t.count + t.max) % t.max;
        if (now - t.pt[tail] > t.life) t.count--;
        else break;
      }

      if (t.count < 2) {
        t.mesh.visible = false;
        if (!t.emitting) { t.active = false; t.count = 0; }
        continue;
      }

      t.mesh.visible = true;
      this._build(t, cam, now);
    }
  }

  _build(t, cam, now) {
    const n = t.count;
    const pos = t.pos.array, par = t.param.array, alp = t.alpha.array;
    const tail = (t.head - n + t.max) % t.max;

    for (let k = 0; k < n; k++) {
      const i = (tail + k) % t.max;
      _p.set(t.px[i], t.py[i], t.pz[i]);

      const ip = (tail + Math.max(0, k - 1)) % t.max;
      const inx = (tail + Math.min(n - 1, k + 1)) % t.max;
      _prev.set(t.px[ip], t.py[ip], t.pz[ip]);
      _next.set(t.px[inx], t.py[inx], t.pz[inx]);
      _dir.subVectors(_next, _prev);
      if (_dir.lengthSq() < 1e-10) _dir.set(0, 1, 0);
      _dir.normalize();

      _toCam.subVectors(cam.position, _p);
      _side.crossVectors(_dir, _toCam);
      if (_side.lengthSq() < 1e-10) _side.set(1, 0, 0);
      _side.normalize();

      const along = n > 1 ? k / (n - 1) : 1;
      const ageA = Math.max(0, 1 - (now - t.pt[i]) / t.life);
      // Taper: width follows the head, so the trail is a wedge not a strip.
      const w = t.width * along * (0.35 + ageA * 0.65) * 0.5;

      const v0 = k * 6, v1 = v0 + 3;
      pos[v0] = _p.x + _side.x * w; pos[v0 + 1] = _p.y + _side.y * w; pos[v0 + 2] = _p.z + _side.z * w;
      pos[v1] = _p.x - _side.x * w; pos[v1 + 1] = _p.y - _side.y * w; pos[v1 + 2] = _p.z - _side.z * w;

      const q0 = k * 4;
      par[q0] = along; par[q0 + 1] = 1;
      par[q0 + 2] = along; par[q0 + 3] = -1;

      const a = ageA * ageA * (0.25 + along * 0.75);
      alp[k * 2] = a; alp[k * 2 + 1] = a;
    }

    t.pos.needsUpdate = true;
    t.param.needsUpdate = true;
    t.alpha.needsUpdate = true;
    t.mesh.geometry.setDrawRange(0, (n - 1) * 6);
  }
}
