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
    try {
      system[phase](ctx, dt);
    } catch (e) {
      this._onFrameError(e, system, phase);
    }
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
    // Clamp so a backgrounded tab doesn't fire hundreds of catch-up steps.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.frame++;

    if (ctx.hitstop > 0) {
      ctx.hitstop = Math.max(0, ctx.hitstop - dt);
    } else if (!ctx.paused) {
      this.accumulator += dt;
      let steps = 0;
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
