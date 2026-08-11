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
    // Identity of the live frame loop. See `start()`.
    this._loopGen = 0;
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

  /**
   * Deregister a system. `add` had no counterpart, so nothing that ends a
   * session could take its system back out: `Lobby.leave()` closed the `NetHost`
   * and dropped its own reference, but the closed instance stayed in `systems`
   * and kept being ticked, and hosting again registered a *second* one beside it.
   *
   * Removing a system that was never added is a no-op rather than an error —
   * teardown paths run on both the "we registered it" and "we failed before we
   * did" branches, and neither should have to know which one it is on.
   */
  remove(system) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
    return system;
  }

  get(name) {
    return this.systems.find((s) => s.constructor.name === name);
  }

  /**
   * Start the frame loop.
   *
   * `running` alone cannot identify a loop, and that is the whole reason for
   * `_loopGen`. `stop()` only clears the flag — it cannot cancel the rAF that
   * the live tick has *already* armed for the next frame. So a `stop()` /
   * `start()` pair that happens inside one frame (which is exactly what
   * `Harness.freeze()` then `thaw()` does, both from inside a rAF-driven async
   * chain) leaves the old callback queued, and it wakes up to `running === true`
   * again, re-arms, and runs alongside the chain `start()` just created. Two
   * loops, then three, then four — `_frame` per presented frame, and with it
   * `ctx.time`, every fixed step and every `update()` delta, multiplied by the
   * number of freeze/thaw cycles the page has seen.
   *
   * A generation counter fixes it without needing to cancel anything: each
   * `start()` mints an id, each tick checks it still holds the current one, and
   * a superseded chain retires on its next wake.
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const gen = ++this._loopGen;
    const tick = () => {
      // A stopped engine, or a chain a later `start()` has already replaced.
      if (!this.running || gen !== this._loopGen) return;
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

    // Before the fixed loop samples commands, and outside the pause gate — a
    // paused game still needs Start/B to leave the menu. Through `_call` like
    // every system phase: this is the first statement in the frame, and an
    // unguarded throw here (a provider returning a non-iterable, a Gamepad
    // without `buttons`) would abort the whole frame — no steps, no render —
    // for as long as the condition lasts.
    if (this.ctx.input?.pollPad) this._call(this.ctx.input, 'pollPad', ctx, dt);

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
        // Iterated over a copy for the same reason `EventBus.emit` is: a system
        // whose tick ends the session calls `remove()`, and splicing the live
        // array under `for...of` silently skips whichever system followed it
        // for that phase.
        for (const s of [...this.systems]) if (s.fixedUpdate) this._call(s, 'fixedUpdate', ctx, FIXED);
      }
      // Bleed off unpayable debt rather than spiralling.
      if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    }

    for (const s of [...this.systems]) if (s.update) this._call(s, 'update', ctx, dt);
    for (const s of [...this.systems]) if (s.lateUpdate) this._call(s, 'lateUpdate', ctx, dt);

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
  /**
   * Deliver to every subscriber, even if one of them throws.
   *
   * Without the try/catch a single bad listener aborts the whole dispatch and
   * silently starves everything registered after it — measured in co-op, where
   * a `NaN` position from the wire made `Audio`'s `kill` listener throw and the
   * HUD's kill counter (registered after it) never ran once in a session, 0 of
   * 4 kills. Registration order is an accident of `main.js`, so "which
   * listeners survive an exception" was an accident too.
   *
   * The error is re-surfaced on the console rather than swallowed: a listener
   * that throws is still a bug, and this must not be the reason nobody finds
   * it. The subscriber set is copied first so an `off()` from inside a handler
   * cannot mutate the set mid-iteration.
   *
   * The copy is not one-directional, and both of its other edges are real:
   *  · A listener *removed* during a dispatch still receives that dispatch.
   *    `for (const fn of set)` would have skipped it.
   *  · A listener *added* during a dispatch of the same event does NOT receive
   *    it. Iterating a `Set` directly visits entries appended mid-iteration;
   *    iterating a copy cannot.
   * Neither is reachable today — there is not one `.off()` call site in `src/`
   * outside this class, and nothing subscribes from inside a handler — so this
   * is a note for whoever writes the first one, not a known defect. If you need
   * "removed means removed", check membership per call (`if (!set.has(fn))
   * continue;`) rather than dropping the copy: dropping it reintroduces the
   * mid-iteration mutation hazard the copy exists for.
   */
  emit(name, payload) {
    const set = this.map.get(name);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[events] listener threw for event: ' + name, err);
      }
    }
  }
}

/**
 * Does a `playerDead` payload name *this machine's own survivor*?
 *
 * `playerDead` is emitted for every player: on a host when a remote pawn dies,
 * and on a client for every peer, because `NetHost` broadcasts it. Almost every
 * listener means "the run is over" by it, which is only true of the local
 * survivor — unguarded, a teammate's death ends your run, commits your record,
 * raises your summary screen and disables the director for everyone.
 *
 * `Combat._kill` names the victim and `NetClient._resolve` maps a client's own
 * netId back to `ctx.player`, so identity comparison works on both roles. An
 * emit that carries no victim (the harness's, and any older caller) is treated
 * as local, which is what it always meant in single-player.
 *
 * ...except on a client, where it is treated as *not* local. Every `playerDead`
 * a client sees arrives over the wire, so a missing victim there is a failure to
 * name one, not an old-style local emit — and answering "yes" to it silently
 * reverts all six guards at once plus round 1's audio identity test. That is not
 * hypothetical: `NetHost.sanitise` serialises a victim with no `netId` as `null`
 * (K-10), and `{victimIsNull: true}` is exactly the payload that reproduced the
 * whole pre-K-2 failure on the `preVictim` arm. A predicate asked "is this mine"
 * answers no when it cannot tell, on the role where it cannot tell.
 *
 * The host keeps the permissive default deliberately: single-player and the
 * harness both emit through it, and on a host a victimless payload cannot have
 * come off the wire.
 */
/**
 * Was *this machine's own survivor* the source of a `kill`?
 *
 * The counterpart to `isLocalVictim`, and the rule round 1's F-9 already applies
 * to `damageDealt`: a teammate's kill is not your run's kill. `kill` never got
 * it, so a co-op client's run summary read `kills 4, damageDealt 0` for a fight
 * it did not take part in — internally contradictory, and it inflates any
 * run-scoped kill goal. (`Profile._onKill` was already witness-gated, so the
 * lifetime stats were right and only the run summary was wrong.)
 *
 * The two roles need opposite defaults, which is why this is not one comparison:
 *  · On an authority, `source` is a real entity. Excluding another player's
 *    kills is enough, and everything else — an environmental kill, a kill by a
 *    deployed mine or sentry, a burn tick whose source has despawned — keeps
 *    counting exactly as it did in single-player.
 *  · On a client, `source` came off the wire. Its own kills resolve to
 *    `ctx.player` (`NetClient._resolve` maps its own netId back), and every
 *    other kill in the session resolves to an interpolated *view*, which is not
 *    `isPlayer` and would sail through the authority test. So a client counts
 *    only what it can positively identify as its own.
 *
 * The client rule under-reports where the authority rule over-reported: a
 * client's mine or turret kill resolves to that projectile's view, not to the
 * client, and is not counted. That is the same wire-identity gap as K-4's and it
 * is named as held rather than closed.
 */
export function isLocalKill(ctx, payload) {
  const source = payload?.source;
  if (ctx?.netRole === 'client') return !!ctx.player && source === ctx.player;
  return !(source?.isPlayer && ctx?.player && source !== ctx.player);
}

export function isLocalVictim(ctx, payload) {
  const victim = payload?.victim;
  if (!victim) return ctx?.netRole !== 'client';
  return !ctx?.player || victim === ctx.player;
}
