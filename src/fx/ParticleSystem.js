import * as THREE from 'three';
import {
  PARTICLE_ATTRIBUTES,
  createParticleMaterial,
} from '../shaders/ParticleShader.js';

/**
 * Pooled GPU particle system.
 *
 * Two draw calls total (one additive layer, one alpha layer). Each layer is a
 * fixed-capacity ring buffer of instanced quads; spawning writes attributes and
 * nothing else, and the shader derives the whole trajectory from those. That
 * means 20k live particles cost one uniform upload per frame plus whatever was
 * spawned this frame, not 20k CPU integrations.
 *
 * Death is implicit: a particle whose age exceeds its lifetime collapses itself
 * off-screen in the vertex shader. There is no free list to maintain and no
 * compaction pass — the ring simply overwrites the oldest slot, which for
 * combat VFX is exactly the right eviction policy.
 */

export const FRAME = {
  SOFT: 0,   // gaussian blob — smoke, dust, glow
  CORE: 1,   // tight hot dot — flash cores, muzzle
  SPARK: 2,  // vertical streak, use with stretch
  SMOKE: 3,  // noisy puff
  RING: 4,   // soft ring
  FLARE: 5,  // four-point star
  BLOB: 6,   // irregular droplet — blood
  CHUNK: 7,  // angular debris silhouette
  EMBER: 8,  // hot dot + halo
  SHOCK: 9,  // thin sharp ring
  BOLT: 10,  // jagged vertical line
  DUST: 11,  // wispy cloud
  CROSS: 12, // plus / impact flash
  HEX: 13,   // hexagon shard
  SQUARE: 14,// soft square
  SPECK: 15, // sparse speckle
};

const ATLAS_COLS = 4;
const ATLAS_TILE = 128;

const _v = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _size = new THREE.Vector2();

export class ParticleSystem {
  constructor({ capacityAdditive = 16384, capacityAlpha = 8192 } = {}) {
    this.time = 0;
    this.soft = false;
    this.layers = {};
    this._caps = { add: capacityAdditive, alpha: capacityAlpha };
    this.depthRT = null;
    this._depthMat = null;
    this._rng = null;
    this._hidden = [];
  }

  init(ctx) {
    this.ctx = ctx;
    this._rng = ctx.rng;

    const map = makeParticleAtlas();
    this.atlas = map;

    this.root = new THREE.Group();
    this.root.name = 'vfx.particles';
    this.root.frustumCulled = false;
    ctx.scene.add(this.root);

    this._makeLayer('add', this._caps.add, true, 1.35);
    this._makeLayer('alpha', this._caps.alpha, false, 1.0);

    this._depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this._depthMat.name = 'vfx.depthPrepass';

    // Soft particles are the single biggest "does this look painted on or does
    // it look like it is in the world" lever, but they cost a depth prepass.
    this.soft = (ctx.pipeline?.quality ?? 2) >= 1;
    if (this.soft) this._ensureDepthTarget();
  }

  /**
   * Toggle the depth fade, releasing the prepass target when it goes off.
   *
   * Worth a method rather than a bare flag because the prepass is a *whole
   * extra rasterisation of the scene* — measured at ~28ms of a 159ms frame on
   * an Intel UHD 630 — so the low tier turning it off has to actually stop
   * paying for it, target included.
   */
  setSoft(on) {
    if (on === this.soft) return;
    this.soft = on;
    if (on) {
      this._ensureDepthTarget();
    } else {
      this.depthRT?.dispose();
      this.depthRT = null;
    }
  }

  _makeLayer(name, capacity, additive, intensity) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = capacity;

    const attrs = {};
    for (const [attrName, size] of PARTICLE_ATTRIBUTES) {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * size), size
      );
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(attrName, a);
      attrs[attrName] = a;
    }

    const mat = createParticleMaterial({
      map: this.atlas, additive, atlasCols: ATLAS_COLS, intensity,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = additive ? 12 : 10;
    mesh.matrixAutoUpdate = false;
    this.root.add(mesh);

    this.layers[name] = {
      capacity, head: 0, live: 0, mesh, geo, mat, attrs,
      dirtyMin: Infinity, dirtyMax: -Infinity, wrapped: false,
    };
  }

  _ensureDepthTarget() {
    const w = Math.max(2, Math.floor(innerWidth * 0.5));
    const h = Math.max(2, Math.floor(innerHeight * 0.5));
    if (this.depthRT) {
      if (this.depthRT.width === w && this.depthRT.height === h) return;
      this.depthRT.dispose();
    }
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.depthRT = new THREE.WebGLRenderTarget(w, h, {
      depthTexture: depth,
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
  }

  /**
   * Spawn `count` particles in one call. Every field is optional; the defaults
   * are a slow neutral puff. All vector/colour inputs are read, never retained.
   */
  emit(o) {
    const L = this.layers[o.layer === 'alpha' ? 'alpha' : 'add'];
    if (!L) return;
    const rng = this._rng;
    const n = o.count | 0 || 1;

    const pos = o.position;
    const px = pos ? pos.x : 0, py = pos ? pos.y : 0, pz = pos ? pos.z : 0;
    const jitter = o.jitter || 0;
    const shell = o.shell || 0;

    let dx = 0, dy = 1, dz = 0;
    if (o.dir) {
      _v.copy(o.dir);
      if (_v.lengthSq() > 1e-8) { _v.normalize(); dx = _v.x; dy = _v.y; dz = _v.z; }
    }
    // Orthonormal basis around the emission axis, built once per burst.
    _u.set(dx, dy, dz);
    _w.set(0, 1, 0);
    if (Math.abs(dy) > 0.95) _w.set(1, 0, 0);
    _v.crossVectors(_u, _w).normalize();      // tangent A
    _w.crossVectors(_u, _v).normalize();      // tangent B

    const spread = o.spread ?? 0;
    const speed = o.speed ?? 0;
    const speedVar = o.speedVar ?? 0;
    const inheritX = o.inherit ? o.inherit.x : 0;
    const inheritY = o.inherit ? o.inherit.y : 0;
    const inheritZ = o.inherit ? o.inherit.z : 0;

    const life = o.life ?? 0.6;
    const lifeVar = o.lifeVar ?? 0.25;
    const size0 = o.size0 ?? 0.25;
    const size1 = o.size1 ?? 0.0;
    const sizeVar = o.sizeVar ?? 0.3;

    if (o.color0) _c0.set(o.color0); else _c0.setRGB(1, 1, 1);
    if (o.color1) _c1.set(o.color1); else _c1.copy(_c0);
    const a0 = o.alpha0 ?? 1, a1 = o.alpha1 ?? 0;

    const drag = o.drag ?? 1.2;
    const gravity = o.gravity ?? 0;
    const turbulence = o.turbulence ?? 0;
    const stretch = o.stretch ?? 0;
    const frame = o.frame ?? FRAME.SOFT;
    const frameVar = o.frameVar ?? 0;
    const spin = o.spin ?? 0;
    const soft = o.soft ?? (o.layer === 'alpha' ? 1.2 : 0.6);
    const fadeIn = o.fadeIn ?? 0.06;
    const alphaPow = o.alphaPow ?? 1.4;

    const t0 = this.time + (o.delay ?? 0);

    const A = L.attrs;
    const spawn = A.aSpawn.array, vel = A.aVel.array, tim = A.aTime.array;
    const siz = A.aSize.array, cA = A.aCol0.array, cB = A.aCol1.array;
    const par = A.aParams.array, mis = A.aMisc.array, cur = A.aCurve.array;

    for (let i = 0; i < n; i++) {
      const idx = L.head;
      L.head = (L.head + 1) % L.capacity;
      if (L.head === 0) L.wrapped = true;
      if (idx < L.dirtyMin) L.dirtyMin = idx;
      if (idx > L.dirtyMax) L.dirtyMax = idx;

      // --- position ---
      let sx = px, sy = py, sz = pz;
      if (jitter > 0) {
        sx += (rng.next() * 2 - 1) * jitter;
        sy += (rng.next() * 2 - 1) * jitter;
        sz += (rng.next() * 2 - 1) * jitter;
      }
      if (shell > 0) {
        const z = rng.next() * 2 - 1;
        const th = rng.next() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        sx += Math.cos(th) * r * shell;
        sy += z * shell;
        sz += Math.sin(th) * r * shell;
      }

      // --- direction inside the cone ---
      const ang = spread * Math.sqrt(rng.next());
      const roll = rng.next() * Math.PI * 2;
      const sa = Math.sin(ang), ca = Math.cos(ang);
      const ta = Math.cos(roll) * sa, tb = Math.sin(roll) * sa;
      const ddx = dx * ca + _v.x * ta + _w.x * tb;
      const ddy = dy * ca + _v.y * ta + _w.y * tb;
      const ddz = dz * ca + _v.z * ta + _w.z * tb;

      const sp = speed * (1 + (rng.next() * 2 - 1) * speedVar);
      const o3 = idx * 3, o2 = idx * 2, o4 = idx * 4;

      spawn[o3] = sx; spawn[o3 + 1] = sy; spawn[o3 + 2] = sz;
      vel[o3] = ddx * sp + inheritX;
      vel[o3 + 1] = ddy * sp + inheritY;
      vel[o3 + 2] = ddz * sp + inheritZ;

      tim[o2] = t0;
      tim[o2 + 1] = Math.max(0.02, life * (1 + (rng.next() * 2 - 1) * lifeVar));

      const sv = 1 + (rng.next() * 2 - 1) * sizeVar;
      siz[o2] = size0 * sv;
      siz[o2 + 1] = size1 * sv;

      cA[o4] = _c0.r; cA[o4 + 1] = _c0.g; cA[o4 + 2] = _c0.b; cA[o4 + 3] = a0;
      cB[o4] = _c1.r; cB[o4 + 1] = _c1.g; cB[o4 + 2] = _c1.b; cB[o4 + 3] = a1;

      par[o4] = drag; par[o4 + 1] = gravity;
      par[o4 + 2] = turbulence; par[o4 + 3] = stretch;

      mis[o4] = rng.next();
      mis[o4 + 1] = frameVar > 0 ? frame + rng.int(0, frameVar) : frame;
      mis[o4 + 2] = spin * (rng.next() * 2 - 1);
      mis[o4 + 3] = soft;

      cur[o2] = fadeIn; cur[o2 + 1] = alphaPow;
    }
  }

  /** Presentation-rate update. Keeps running during hitstop by design. */
  update(ctx, dt) {
    this.time += dt;

    // gl_FragCoord is in the *main* framebuffer's pixels, so the screen UV used
    // to sample the depth texture must be divided by the drawing buffer size,
    // not by the half-res depth target's size.
    const renderer = ctx.pipeline?.renderer;
    if (renderer) renderer.getDrawingBufferSize(_size);
    else _size.set(innerWidth, innerHeight);

    for (const key in this.layers) {
      const L = this.layers[key];
      this._flush(L);
      const u = L.mat.uniforms;
      u.uTime.value = this.time;
      u.uCamPlanes.value.set(ctx.camera.near, ctx.camera.far);
      if (this.soft && this.depthRT) {
        u.uDepth.value = this.depthRT.depthTexture;
        u.uResolution.value.copy(_size);
        u.uSoftEnabled.value = 1;
      } else {
        u.uSoftEnabled.value = 0;
      }
    }
  }

  _flush(L) {
    if (L.dirtyMax < L.dirtyMin) return;
    // A burst that wrapped the ring touched both ends; a full re-upload is
    // cheaper than reasoning about two disjoint ranges.
    const wrapped = L.wrapped;
    for (const name in L.attrs) {
      const a = L.attrs[name];
      if (!wrapped && a.addUpdateRange) {
        a.clearUpdateRanges?.();
        a.addUpdateRange(L.dirtyMin * a.itemSize, (L.dirtyMax - L.dirtyMin + 1) * a.itemSize);
      }
      a.needsUpdate = true;
    }
    L.dirtyMin = Infinity;
    L.dirtyMax = -Infinity;
    L.wrapped = false;
  }

  /**
   * Half-res depth-only pass used for soft particles. Called from VFX's
   * lateUpdate so it is as close to the real render as we can get without
   * owning the pipeline.
   */
  renderDepth(ctx, hiddenRoots) {
    if (!this.soft) return;
    const renderer = ctx.pipeline?.renderer;
    if (!renderer) return;
    this._ensureDepthTarget();

    const scene = ctx.scene;
    const prev = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;

    for (let i = 0; i < hiddenRoots.length; i++) {
      const r = hiddenRoots[i];
      if (!r) continue;
      this._hidden[i] = r.visible;
      r.visible = false;
    }

    scene.overrideMaterial = this._depthMat;
    renderer.setRenderTarget(this.depthRT);
    renderer.render(scene, ctx.camera);
    renderer.setRenderTarget(prev);
    scene.overrideMaterial = prevOverride;

    for (let i = 0; i < hiddenRoots.length; i++) {
      const r = hiddenRoots[i];
      if (r) r.visible = this._hidden[i];
    }
  }

  resize() {
    if (this.soft) this._ensureDepthTarget();
  }
}

/* ------------------------------------------------------------------ */
/* Atlas generation — everything is drawn on a canvas at boot so the    */
/* build ships no binary assets.                                        */
/* ------------------------------------------------------------------ */

function makeParticleAtlas() {
  const size = ATLAS_COLS * ATLAS_TILE;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);

  const drawers = [
    softDot, coreDot, sparkStreak, smokePuff,
    softRing, flareStar, bloodBlob, debrisChunk,
    emberDot, shockRing, boltLine, dustWisp,
    crossFlash, hexShard, softSquare, speckle,
  ];

  for (let i = 0; i < 16; i++) {
    const cx = (i % ATLAS_COLS) * ATLAS_TILE;
    const cy = Math.floor(i / ATLAS_COLS) * ATLAS_TILE;
    g.save();
    g.translate(cx, cy);
    g.beginPath();
    g.rect(0, 0, ATLAS_TILE, ATLAS_TILE);
    g.clip();
    drawers[i](g, ATLAS_TILE);
    g.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false; // row 0 of the canvas is frame row 0 — matches the shader
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}

function radial(g, s, stops) {
  const r = s * 0.5;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [p, c] of stops) grad.addColorStop(p, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}

function softDot(g, s) {
  radial(g, s, [
    [0, 'rgba(255,255,255,1)'],
    [0.28, 'rgba(255,255,255,0.62)'],
    [0.62, 'rgba(255,255,255,0.16)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
}

function coreDot(g, s) {
  radial(g, s, [
    [0, 'rgba(255,255,255,1)'],
    [0.14, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,0.45)'],
    [0.7, 'rgba(255,255,255,0.08)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
}

function sparkStreak(g, s) {
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  // Taper the streak horizontally so it reads as a tracer, not a bar.
  for (let y = 0; y < s; y++) {
    const t = Math.abs(y / s - 0.5) * 2;
    const w = (1 - t * t) * s * 0.22;
    g.globalAlpha = 1;
    g.fillRect(s * 0.5 - w * 0.5, y, w, 1);
  }
  g.globalAlpha = 1;
}

function noiseField(s, cells, seed) {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  let h = seed;
  for (let i = 0; i < grid.length; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    grid[i] = h / 4294967296;
  }
  return (x, y) => {
    const fx = x * cells, fy = y * cells;
    const ix = Math.min(cells - 1, Math.floor(fx)), iy = Math.min(cells - 1, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const i00 = grid[iy * (cells + 1) + ix], i10 = grid[iy * (cells + 1) + ix + 1];
    const i01 = grid[(iy + 1) * (cells + 1) + ix], i11 = grid[(iy + 1) * (cells + 1) + ix + 1];
    return (i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy;
  };
}

function cloud(g, s, seed, contrast, cells) {
  const n1 = noiseField(s, cells, seed);
  const n2 = noiseField(s, cells * 2, seed * 7 + 13);
  const n3 = noiseField(s, cells * 4, seed * 31 + 7);
  const img = g.createImageData(s, s);
  const d = img.data;
  const r = s * 0.5;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = x / s, v = y / s;
      let n = n1(u, v) * 0.55 + n2(u, v) * 0.3 + n3(u, v) * 0.15;
      const dx = x - r, dy = y - r;
      const dist = Math.sqrt(dx * dx + dy * dy) / r;
      const falloff = Math.max(0, 1 - dist);
      let a = Math.pow(falloff, 1.4) * (n * contrast + (1 - contrast * 0.5));
      a = Math.max(0, Math.min(1, a));
      const i = (y * s + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
}

function smokePuff(g, s) { cloud(g, s, 1337, 1.1, 4); }
function dustWisp(g, s) { cloud(g, s, 90210, 1.5, 6); }

function softRing(g, s) {
  const r = s * 0.5;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0)');
  grad.addColorStop(0.78, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}

function shockRing(g, s) {
  const r = s * 0.5;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.82, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.93, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}

function flareStar(g, s) {
  const r = s * 0.5;
  radial(g, s, [
    [0, 'rgba(255,255,255,1)'],
    [0.12, 'rgba(255,255,255,0.7)'],
    [0.35, 'rgba(255,255,255,0.1)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 4; k++) {
    g.save();
    g.translate(r, r);
    g.rotate((Math.PI / 2) * k + Math.PI / 4 * (k % 2 ? 1 : 0));
    const grad = g.createLinearGradient(0, 0, 0, -r);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-s * 0.035, 0);
    g.lineTo(0, -r);
    g.lineTo(s * 0.035, 0);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
}

function bloodBlob(g, s) {
  const r = s * 0.5;
  g.save();
  g.translate(r, r);
  g.beginPath();
  const pts = 9;
  let h = 424242;
  for (let i = 0; i <= pts; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const jitter = 0.68 + (h / 4294967296) * 0.32;
    const a = (i / pts) * Math.PI * 2;
    const rr = r * 0.82 * jitter;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0.35)');
  g.fillStyle = grad;
  g.fill();
  g.restore();
}

function debrisChunk(g, s) {
  const r = s * 0.5;
  g.save();
  g.translate(r, r);
  g.beginPath();
  const pts = 6;
  let h = 99991;
  for (let i = 0; i <= pts; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const jitter = 0.5 + (h / 4294967296) * 0.5;
    const a = (i / pts) * Math.PI * 2;
    const rr = r * 0.8 * jitter;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = 'rgba(255,255,255,1)';
  g.fill();
  g.restore();
}

function emberDot(g, s) {
  radial(g, s, [
    [0, 'rgba(255,255,255,1)'],
    [0.1, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,255,255,0.5)'],
    [0.45, 'rgba(255,255,255,0.12)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
}

function boltLine(g, s) {
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = s * 0.09;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  let h = 31337;
  g.moveTo(s * 0.5, 0);
  const steps = 7;
  for (let i = 1; i <= steps; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = (h / 4294967296 - 0.5) * s * 0.42;
    g.lineTo(s * 0.5 + (i === steps ? 0 : j), (i / steps) * s);
  }
  g.stroke();
}

function crossFlash(g, s) {
  const r = s * 0.5;
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 2; k++) {
    const grad = k === 0
      ? g.createLinearGradient(0, 0, s, 0)
      : g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    if (k === 0) g.fillRect(0, r - s * 0.05, s, s * 0.1);
    else g.fillRect(r - s * 0.05, 0, s * 0.1, s);
  }
  radial(g, s, [
    [0, 'rgba(255,255,255,1)'],
    [0.18, 'rgba(255,255,255,0.35)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  g.globalCompositeOperation = 'source-over';
}

function hexShard(g, s) {
  const r = s * 0.45;
  g.save();
  g.translate(s * 0.5, s * 0.5);
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad;
  g.fill();
  g.restore();
}

function softSquare(g, s) {
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0.5)');
  g.fillStyle = grad;
  const p = s * 0.18;
  g.fillRect(p, p, s - p * 2, s - p * 2);
}

function speckle(g, s) {
  let h = 5150;
  for (let i = 0; i < 22; i++) {
    h = (h * 1664525 + 1013904223) >>> 0; const x = (h / 4294967296) * s;
    h = (h * 1664525 + 1013904223) >>> 0; const y = (h / 4294967296) * s;
    h = (h * 1664525 + 1013904223) >>> 0; const r = 1 + (h / 4294967296) * s * 0.045;
    const d = Math.hypot(x - s * 0.5, y - s * 0.5) / (s * 0.5);
    if (d > 1) continue;
    g.fillStyle = `rgba(255,255,255,${(1 - d).toFixed(3)})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}
