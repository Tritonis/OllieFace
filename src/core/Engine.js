import * as THREE from 'three';
import { RNG } from './MathUtil.js';

/**
 * The Engine owns the frame loop and the shared context every system reads.
 *
 * Systems are plain objects with any of:
 *   fixedUpdate(ctx, h)  — called at a fixed 60Hz step, 0..MAX_SUBSTEPS times/frame
 *   update(ctx, dt)      — called once per frame with the real delta
 *   lateUpdate(ctx, dt)  — after update, for cameras and anything that follows
 *
 * Gameplay (physics, AI, projectiles) belongs in fixedUpdate so behaviour is
 * framerate-independent. Presentation (cameras, VFX lerps, HUD) belongs in
 * update/lateUpdate so it stays smooth on high-refresh displays.
 */
const FIXED = 1 / 60;
const MAX_SUBSTEPS = 5;

// How fast gameplay runs during an impact frame. Low enough to read as a hit,
// far enough above zero that input keeps being sampled.
const HITSTOP_SCALE = 0.15;
// Fraction of wall time hitstop is allowed to consume, and how much credit can
// bank before the ceiling engages.
const HITSTOP_DUTY = 0.15;
const HITSTOP_BUDGET_MAX = 0.12;

export class Engine {
  constructor({ canvas, seed = Date.now() }) {
    this.canvas = canvas;
    this.systems = [];
    this.accumulator = 0;
    this.clock = new THREE.Clock();
    this.running = false;
    this.frame = 0;

    this.ctx = {
      engine: this,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(70, 1, 0.1, 2000),
      // Gameplay randomness. Consumed only where `authority` is true, so a
      // networked client never advances the stream and desyncs future rolls.
      rng: new RNG(seed),
      // Cosmetic randomness — particle jitter, audio variation, animation
      // noise. Kept separate for exactly the reason above.
      fxRng: new RNG(seed ^ 0x9e3779b9),
      seed,
      // True in single-player and on the host; false on a networked client.
      // Anything that mutates game state must check this.
      authority: true,
      netRole: 'single',
      // Wall-clock seconds of gameplay, excluding pauses. Drives the
      // difficulty coefficient, so it must never advance while paused.
      time: 0,
      // Set to >0 to freeze gameplay for impact frames; presentation keeps running.
      hitstop: 0,
      paused: false,
      // Which survivor the next `Player.init` will boot. The UI writes this
      // before the run starts; `Player` publishes `ctx.setSurvivor(id)` for
      // changing it afterwards. A literal rather than an import from
      // `data/survivors.js` — the Engine owns no game content, and Player
      // resolves an unknown id back to the default anyway.
      survivorId: 'ranger',
      // Filled in by the systems that own them.
      player: null,
      stage: null,
      director: null,
      vfx: null,
      combat: null,
      audio: null,
      hud: null,
      // Global event bus — decouples systems that shouldn't import each other.
      events: new EventBus(),
      // Frame-error telemetry. A throwing system is degraded, not fatal, so the
      // only way anyone (harness included) learns about it is this counter.
      frameErrors: 0,
      lastFrameError: null,
    };
    // Keyed by "System.phase" so a system that throws every frame logs once.
    this._reported = new Set();
    // Rolling credit for the hitstop duty-cycle ceiling.
    this._stopBudget = 0;
  }

  /**
   * One system throwing must degrade that system, never the frame. Log the
   * first occurrence per system+phase with the offender named, then stay quiet
   * so a per-frame throw can't drown the console.
   */
  _onFrameError(err, system, phase) {
    const who = system ? `${system.constructor?.name || 'system'}.${phase}` : 'frame';
    this.ctx.frameErrors++;
    this.ctx.lastFrameError = { who, message: String(err && err.message || err), frame: this.frame };
    if (this._reported.has(who)) return;
    this._reported.add(who);
    console.error(`[engine] error in ${who} (frame ${this.frame}) — continuing:`, err);
  }

  _call(system, phase, ctx, dt) {
    if (this.profiling) {
      const t = performance.now();
      try { system[phase](ctx, dt); } catch (e) { this._onFrameError(e, system, phase); }
      const key = `${system.constructor?.name || 'system'}.${phase}`;
      this.profile[key] = (this.profile[key] || 0) + (performance.now() - t);
      return;
    }
    try {
      system[phase](ctx, dt);
    } catch (e) {
      this._onFrameError(e, system, phase);
    }
  }

  /**
   * Per-system timing. Off by default — `performance.now()` twice per system
   * per phase is itself measurable at 60Hz, so profiling must never be the
   * thing that makes the game slow.
   */
  startProfile() {
    this.profile = {};
    this.frameTimes = [];
    this.substepCounts = [];
    this.hitstopFrames = 0;
    this.profileFrames = 0;
    this.profiling = true;
  }

  stopProfile() {
    this.profiling = false;
    const n = Math.max(1, this.profileFrames);
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
    const perSystem = Object.entries(this.profile)
      .map(([k, ms]) => [k, +(ms / n).toFixed(3)])
      .sort((a, b) => b[1] - a[1]);
    return {
      frames: n,
      avgFrameMs: +(this.frameTimes.reduce((a, b) => a + b, 0) / n).toFixed(2),
      medianFrameMs: +pct(0.5).toFixed(2),
      p95FrameMs: +pct(0.95).toFixed(2),
      worstFrameMs: +(sorted[sorted.length - 1] || 0).toFixed(2),
      // A frame that ran MAX_SUBSTEPS is one that could not keep up; a run of
      // them is what the player feels as a freeze.
      maxSubsteps: Math.max(0, ...this.substepCounts),
      saturatedFrames: this.substepCounts.filter((s) => s >= MAX_SUBSTEPS).length,
      hitstopFrames: this.hitstopFrames,
      perSystemMs: Object.fromEntries(perSystem),
    };
  }

  add(system) {
    this.systems.push(system);
    if (system.init) system.init(this.ctx);
    return system;
  }

  get(name) {
    return this.systems.find((s) => s.constructor.name === name);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = () => {
      if (!this.running) return;
      // Re-arm first: a throw anywhere below must never be able to kill the loop.
      requestAnimationFrame(tick);
      try {
        this._frame();
      } catch (e) {
        this._onFrameError(e);
      }
    };
    requestAnimationFrame(tick);
  }

  stop() { this.running = false; }

  _frame() {
    const ctx = this.ctx;
    const t0 = this.profiling ? performance.now() : 0;
    // Clamp so a backgrounded tab doesn't fire hundreds of catch-up steps.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.frame++;

    let steps = 0;
    // Hitstop is a heavy slowdown, NOT a freeze.
    //
    // Freezing the fixed step also freezes input sampling, so a run of impact
    // frames reads as unresponsive controls rather than as weight. Profiling a
    // 24-enemy fight found the game hard-stopped 27% of the time — which is
    // precisely what "jittery and unplayable" feels like from the outside.
    // Scaling time instead keeps the punch and keeps the player in control.
    let scale = 1;
    if (ctx.hitstop > 0) {
      ctx.hitstop = Math.max(0, ctx.hitstop - dt);
      scale = HITSTOP_SCALE;
      this._stopBudget += dt;
      if (this.profiling) this.hitstopFrames++;
    }
    // Duty-cycle ceiling: however many sources ask for hitstop, no more than
    // HITSTOP_DUTY of wall time may be slowed. In a horde, kills overlap and
    // the effect would otherwise be permanently on, which normalises it into
    // just feeling broken.
    this._stopBudget = Math.max(0, this._stopBudget - dt * HITSTOP_DUTY);
    if (this._stopBudget > HITSTOP_BUDGET_MAX) { ctx.hitstop = 0; scale = 1; }

    if (!ctx.paused) {
      this.accumulator += dt * scale;
      while (this.accumulator >= FIXED && steps < MAX_SUBSTEPS) {
        this.accumulator -= FIXED;
        steps++;
        ctx.time += FIXED;
        for (const s of this.systems) if (s.fixedUpdate) this._call(s, 'fixedUpdate', ctx, FIXED);
      }
      // Bleed off unpayable debt rather than spiralling.
      if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    }

    for (const s of this.systems) if (s.update) this._call(s, 'update', ctx, dt);
    for (const s of this.systems) if (s.lateUpdate) this._call(s, 'lateUpdate', ctx, dt);

    if (this.profiling) {
      this.profileFrames++;
      this.frameTimes.push(performance.now() - t0);
      this.substepCounts.push(steps);
    }
  }
}

class EventBus {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) { this.map.get(name)?.delete(fn); }
  emit(name, payload) {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}
