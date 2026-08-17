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
 *
 * Every system also declares whether it is critical — see `isCriticalSystem`.
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

/**
 * Is this system one whose failure the run cannot be trusted to survive?
 *
 * A system declares it with `static critical = true` or `static critical =
 * false` on its class (a plain-object system — the renderer in `main.js` is the
 * only one today — carries the same flag as an own property). Two answers, and the
 * distinction is not "how visible is it" but "does the game still mean what it
 * says afterwards":
 *
 *  · **noncritical** — presentation. VFX, audio, blight, the camera, the HUD,
 *    the renderer. A dead one of these makes the run uglier or harder to read,
 *    and continuing is strictly better than stopping: nobody wants their run
 *    ended by a shader.
 *  · **critical** — anything the run's truth is made of: damage, items, the
 *    world's collision, spawning, progression, the corruption economy, net
 *    authority. A system that throws halfway through its update has left
 *    partial state behind, and in co-op that partial state is then snapshotted
 *    to peers as truth. Playing on is not resilience, it is a quiet lie.
 *
 * **The default is critical**, and that is the whole point of the default: a
 * system nobody has thought about is a system nobody has argued is safe to lose.
 * Omission therefore fails loudly rather than silently, and `add()` warns on the
 * console for anything that does not declare a boolean, so its author finds out
 * which answer they were given without having to read this file.
 *
 * Called for a bare frame-level throw too (no system), where `system` is
 * undefined and the default applies: a throw in the Engine's own frame code is
 * as authoritative as a failure gets.
 */
export function isCriticalSystem(system) {
  const declared = system?.constructor?.critical ?? system?.critical;
  return declared !== false;
}

/**
 * Thrown to unwind the remainder of a frame after a critical failure.
 *
 * Stopping the loop is not enough on its own: the throw happened inside one
 * system's phase, and every loop in `_frame` would otherwise carry on calling
 * the systems that follow it — a whole frame of them running against the
 * half-written state the failure just left. `_frame` catches this and returns.
 */
export class FrameHalt extends Error {
  constructor(who) {
    super(`engine halted after a critical failure in ${who}`);
    this.name = 'FrameHalt';
  }
}

export class Engine {
  constructor({ canvas, seed = Date.now() }) {
    this.canvas = canvas;
    this.systems = [];
    this.accumulator = 0;
    this.clock = new THREE.Clock();
    this.running = false;
    this.frame = 0;

    /**
     * What each system's `init` wrote onto `ctx`, as `system -> Map(key ->
     * value it left there)`. Recorded by `add()` and spent by `remove()`.
     *
     * The direct sweep in `remove()` — null every key whose value *is* the
     * system — only ever reached self-publication (`ctx.vfx = this`). Most
     * publications are derived: `Menus` writes `ctx.settings`, `Player` writes
     * `ctx.setSurvivor`, `Artifacts` writes `ctx.difficulty`, and none of those
     * values is the system, so a half-built system's furniture outlived it and
     * consumers went on calling into it.
     *
     * A diff of `ctx` across `init` is an exact record rather than a heuristic:
     * it is literally the set of keys that system's own `init` changed. Removal
     * only reverts a key whose value is *still* the one `init` left, so a later
     * owner that overwrote it keeps what it wrote.
     */
    this._published = new Map();
    /** Frames of the `add()` stack, innermost last — see `_snapshotCtx`. */
    this._addStack = [];

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
      // Set once, by the first critical failure, and never cleared. Anything
      // that wants to know why the world stopped reads it here; the UI hears
      // about it through the `fatalError` event at the same moment.
      fatalError: null,
    };
    // Keyed by "System.phase" so a system that throws every frame logs once.
    this._reported = new Set();
    // The failure that stopped this engine, or null. Mirrors ctx.fatalError.
    this.fatal = null;
    // Rolling credit for the hitstop duty-cycle ceiling.
    this._stopBudget = 0;
    // Identity of the live frame loop. See `start()`.
    this._loopGen = 0;
  }

  /**
   * A noncritical system throwing must degrade that system, never the frame.
   * Log the first occurrence per system+phase with the offender named, then
   * stay quiet so a per-frame throw can't drown the console.
   *
   * A critical one ends the run instead — see `_halt`. Both paths keep the
   * `frameErrors` / `lastFrameError` telemetry the harness reads: criticality
   * is a severity dimension added beside that counter, not a replacement for it.
   */
  _onFrameError(err, system, phase) {
    const who = system ? `${system.constructor?.name || 'system'}.${phase}` : 'frame';
    this.fail(who, err, isCriticalSystem(system));
  }

  /**
   * Report a failure that is not a frame phase, and so has no system object to
   * read a criticality off — today that is `ctx.pipeline.build()` in `main.js`,
   * the one piece of boot work that runs through neither `_call` nor `add`.
   *
   * It exists so such a caller does not have to reach for `_halt` and silently
   * skip the telemetry beside it. Criticality is the caller's to state,
   * defaulting to the same strict answer `isCriticalSystem` gives an omission.
   */
  fail(who, err, critical = true) {
    this.ctx.frameErrors++;
    this.ctx.lastFrameError = { who, message: String(err && err.message || err), frame: this.frame };
    if (critical) { this._halt(who, err); return; }
    if (this._reported.has(who)) return;
    this._reported.add(who);
    console.error(`[engine] error in ${who} (frame ${this.frame}) — continuing:`, err);
  }

  /**
   * End the run, once, and say why.
   *
   * Four things happen together, and each of them is load-bearing:
   *  · the loop stops, and `start()` will not restart it — a critical system
   *    that threw once throws again on the state it left behind;
   *  · `ctx.authority` goes false, because nothing may keep speaking for a
   *    simulation that has stopped simulating. What that buys is narrow and
   *    worth stating exactly: every system that gates a state change on it —
   *    `Combat`, `Corruption`, `Director`, `Progression` — refuses for as long
   *    as the flag stays false, and frame-phase emitters go quiet because the
   *    loop no longer runs them. The flag is still not
   *    latched in this method, so what makes the surrender hold is that the
   *    writers who used to undo it now refuse: `Lobby._restoreSolo` is the one
   *    door all three of its teardowns go through, and it declines to hand
   *    authority back while `ctx.fatalError` is set. The sends that are not
   *    frame phases at all - `Lobby`'s relay offers, `NetHost`'s `WELCOME` and
   *    `PONG` - are gated on that same latch rather than on the loop, and the
   *    `fatalError` event below is what tells `Lobby` to stop its keepalive and
   *    close the room. A halted host holds no room and says nothing — issue #75 tracks closing that;
   *  · the console gets the whole error, unconditionally — this fires once by
   *    construction, so the once-per-system throttle above does not apply;
   *  · `fatalError` is emitted so the page can put something in front of the
   *    player. A frozen canvas with no explanation is not an improvement on
   *    playing a broken run, and the overlay is what makes stopping the better
   *    of the two. The Engine owns no DOM, so it says what happened and lets
   *    `ui/FatalOverlay.js` decide how it looks.
   */
  _halt(who, err) {
    if (this.fatal) return;
    const entry = { who, message: String(err && err.message || err), frame: this.frame };
    this.fatal = entry;
    this.ctx.fatalError = entry;
    this.stop();
    this.ctx.authority = false;
    console.error(`[engine] critical failure in ${who} (frame ${this.frame}) — stopping the run:`, err);
    this.ctx.events.emit('fatalError', entry);
  }

  _call(system, phase, ctx, dt) {
    if (this.profiling) {
      const t = performance.now();
      try { system[phase](ctx, dt); } catch (e) { this._onFrameError(e, system, phase); }
      const key = `${system.constructor?.name || 'system'}.${phase}`;
      this.profile[key] = (this.profile[key] || 0) + (performance.now() - t);
      if (this.fatal) throw new FrameHalt(this.fatal.who);
      return;
    }
    try {
      system[phase](ctx, dt);
    } catch (e) {
      this._onFrameError(e, system, phase);
    }
    // Outside the catch, and deliberately: "a halted engine calls no more
    // systems" has to hold for *every* call, not only for the one that threw.
    // Inside the catch it held only on the failing call, so a frame driven
    // directly on an already-halted engine would go on ticking healthy systems
    // — unreachable through `start()`, which stops the loop, but the rule this
    // enforces is stated absolutely and so it must be enforced absolutely.
    if (this.fatal) throw new FrameHalt(this.fatal.who);
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

  /**
   * Register a system and run its `init`.
   *
   * `init` is the second place a system's own code runs, and unlike the first
   * it runs at boot — before `start()`, before the first frame, before anything
   * the frame loop guards. It used to run unguarded, so a throw propagated out
   * of `add()` and, in `main.js`, out of module evaluation: `engine.start()`
   * never ran and the fatal overlay was never reached. The failure class the
   * criticality split exists to surface was the one class it could not surface,
   * and the player got a blank page instead of an explanation.
   *
   * So an `init` throw goes through the same two answers a frame throw gets:
   *  · **critical** — halt, exactly as a throw on frame 900 would. A system
   *    that cannot even construct itself is not less serious than one that
   *    fails later, and the halt is what raises the overlay.
   *  · **noncritical** — report it and drop the system. Boot carries on without
   *    it, which is the same trade the frame path makes for presentation.
   *
   * Dropping is not cosmetic: a system whose `init` threw is half-built, and
   * ticking half of it every frame is strictly worse than not having it. It
   * goes out through `remove()` rather than a bare `splice` precisely so the
   * context is cleared with it — a system that published `ctx.vfx = this`
   * before failing would otherwise still be reachable by every consumer, and
   * a critical one calling into it halts the run minutes later naming the
   * wrong system. See `remove()`.
   *
   * What this still cannot undo is anything else `init` wrote before it threw:
   * a listener it subscribed, a mesh it added to the scene. Those need a
   * transactional context nothing here wants, so they are named as held.
   */
  add(system) {
    // A halted engine registers nobody. Boot is a straight line of `add()`
    // calls, so the first critical failure is followed by a dozen more
    // registrations whose `init`s would run against the half-built context that
    // failure left — each throwing into a `_halt` that has already fired. Same
    // rule `_call` states for frame phases, applied to the only other place a
    // system's code runs.
    if (this.fatal) return system;

    // Say out loud which answer an undeclared system was given. The default is
    // deliberately the strict one, so a system that never states its case is a
    // system whose first throw ends the run — that must not be discovered for
    // the first time by a player.
    //
    // The test is "not a boolean" rather than "undefined", so it agrees with
    // `isCriticalSystem` on every input it can be handed. That predicate treats
    // anything but `false` as critical, which means a `static critical = 0`, a
    // string, or a mistyped property name all silently land on the strict side
    // — the same place omission lands, and deserving of the same warning.
    if (typeof (system?.constructor?.critical ?? system?.critical) !== 'boolean') {
      console.warn(`[engine] ${system?.constructor?.name || 'system'} declares no boolean \`static critical\` — treating it as critical.`);
    }
    // Pushed before `init` runs, deliberately: a system that looks itself up
    // through `engine.get()` from inside its own `init` — or that registers a
    // second system which does — has to find it there.
    this.systems.push(system);
    if (system.init) {
      // Attributed to the innermost registration: a system whose `init`
      // registers another must not be credited with what the inner one
      // published, or removing the outer would take the inner's context with it.
      const before = this._snapshotCtx();
      const frame = { claimed: new Set() };
      this._addStack.push(frame);
      let failure = null;
      try {
        system.init(this.ctx);
      } catch (e) {
        failure = e;
      } finally {
        this._addStack.pop();
        // Recorded even when `init` threw — especially then. A half-built
        // system's publications are exactly the ones that must not outlive it.
        this._recordPublications(system, before, frame.claimed);
      }
      if (failure) {
        // Taken back out before the failure is reported, so anything listening
        // for `fatalError` sees a `systems` list that no longer claims it.
        this.remove(system);
        this._onFrameError(failure, system, 'init');
      }
    }
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
   *
   * **The context is cleared too, and that is not tidiness.** Systems publish
   * themselves onto `ctx` from inside `init` — `ctx.vfx`, `ctx.player`,
   * `ctx.director`, `ctx.coop`, `ctx.net` — and their consumers guard on
   * nothing more than "is it there": `Director` calls `ctx.vfx.explosion(...)`
   * behind `if (ctx.vfx && ctx.vfx.explosion)`. `explosion` is a prototype
   * method, so that guard is satisfied by an instance whose `init` published
   * itself and *then* threw, and the call dies on the fields `init` never
   * reached. Since `add()` now drops such a system rather than aborting boot,
   * a reference left on `ctx` is a critical consumer halting the run several
   * minutes later, naming the consumer instead of the system that failed.
   *
   * Generic rather than a `ready` flag per publisher, because the rule is
   * "removed means gone" and every future system that publishes itself gets it
   * without knowing this exists. `Object.keys` on every removal is affordable:
   * removals are rare (a co-op session ending, a failed `init`) and `ctx` holds
   * a couple of dozen keys.
   *
   * **Derived publications go too.** Identity alone only ever caught
   * `ctx.vfx = this`; the commoner shape is a system publishing something it
   * *owns* — `Menus` writes `ctx.settings`, `Player` writes `ctx.setSurvivor`,
   * `Artifacts` writes a `ctx.difficulty` facade of closures over itself. None
   * of those values is the system, so all three survived removal and went on
   * answering calls on behalf of a system that is gone. `add()` therefore
   * records what each `init` changed on `ctx` (see `_recordPublications`) and
   * removal reverts those keys as well — but only where the value is still the
   * one that `init` left, so a key a later system took over stays with it.
   *
   * **Known limitation, deliberately not closed: a post-`init` republish is
   * invisible here.** The record is a diff taken across `init` and nothing
   * else, so a system that writes `ctx.stage` again from a method mid-run
   * leaves a value the map never saw; the identity check below then matches
   * nothing and that value survives removal — the very shape this whole
   * mechanism exists to prevent, reached by a different door. The pattern
   * exists in this codebase (`world/realms/Realms.js:313`/`:369` reassign
   * `ctx.stage`; `systems/Artifacts.js:251`/`:490`/`:530` reassign
   * `ctx.difficultyId`) but is unreachable as a bug today: the only two callers
   * of `remove()` are `add()`'s own failure rollback — which runs before any
   * runtime write could have happened — and `Lobby`'s teardown of `NetHost`,
   * which self-publishes and is covered by the identity sweep regardless.
   * Closing it means tracking every `ctx` write a system makes, which is a
   * proxy on the context and a cost on a hot object, paid for a hazard nothing
   * can currently reach. `tests/engine-criticality.test.mjs` pins the boundary
   * so that anyone who adds a `remove()` call site — or extends this mechanism
   * — trips over the decision rather than rediscovering the hole.
   *
   * `null`, not `delete`: the `ctx` literal declares these keys as `null` up
   * front ("filled in by the systems that own them"), so nulling restores
   * exactly the value they held before `init` ran, and `Lobby._release` already
   * hand-wrote `this.ctx.net = null` on this same path. `delete` would instead
   * take a documented key out of the context's shape.
   */
  remove(system) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
    // Guarded on `system` so a null/undefined argument cannot match — and blank
    // — every context key that happens to be null already.
    if (system) {
      for (const k of Object.keys(this.ctx)) if (this.ctx[k] === system) this.ctx[k] = null;
      const owned = this._published.get(system);
      if (owned) {
        for (const [k, v] of owned) {
          // Only what this system left and nothing has replaced since. A later
          // owner of the same key wrote a value that is still good; blanking it
          // would break a live system to tidy up after a dead one.
          if (this.ctx[k] === v) this.ctx[k] = null;
        }
        this._published.delete(system);
      }
    }
    return system;
  }

  /** `ctx` as `key -> value`, for diffing across an `init`. */
  _snapshotCtx() {
    const snap = new Map();
    for (const k of Object.keys(this.ctx)) snap.set(k, this.ctx[k]);
    return snap;
  }

  /**
   * Record every `ctx` key `system.init` created or changed, minus the ones an
   * inner `add()` already claimed. Credits the key to the enclosing
   * registration too, so an outer `init` cannot re-claim it on the way out.
   *
   * **`init` is the only window this watches.** A system that republishes the
   * same key later — at runtime, from a method rather than from `init` — writes
   * a value this map has never seen, and `remove()`'s identity check therefore
   * never matches it. See the limitation stated on `remove()`.
   */
  _recordPublications(system, before, claimedByInner) {
    const owned = new Map();
    for (const k of Object.keys(this.ctx)) {
      const v = this.ctx[k];
      if (claimedByInner.has(k)) continue;
      if (before.has(k) && before.get(k) === v) continue;
      // The engine's own furniture is never a system's to publish or to take
      // away; `ctx.engine` is the whole of it and it never changes anyway.
      if (k === 'engine') continue;
      owned.set(k, v);
    }
    if (owned.size) this._published.set(system, owned);
    const outer = this._addStack[this._addStack.length - 1];
    if (outer) {
      for (const k of owned.keys()) outer.claimed.add(k);
      for (const k of claimedByInner) outer.claimed.add(k);
    }
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
    // A halted engine stays halted. Restarting one only re-runs the critical
    // system that failed, against the state its failure left behind.
    if (this.fatal) return;
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

  /**
   * One frame, with the critical-failure unwind absorbed here.
   *
   * `_halt` has already stopped the loop and told the page by the time the
   * `FrameHalt` arrives, so there is nothing left to do but abandon the rest of
   * the frame quietly. It is caught here rather than in the rAF chain so that
   * the sentinel never escapes the Engine at all: `_frame` is also called
   * directly — `tests/lobby-lifecycle.test.mjs` and
   * `tests/engine-criticality.test.mjs` both drive frames by hand, and anything
   * that wants a single deterministic step in future will do the same — and
   * `_frame` throwing a private exception type at those callers would make the
   * unwind their problem rather than ours.
   */
  _frame() {
    try {
      this._runFrame();
    } catch (e) {
      if (!(e instanceof FrameHalt)) throw e;
    }
  }

  _runFrame() {
    // A halted engine runs no frames, including hand-driven ones. The rAF chain
    // already cannot get here — `_halt` stopped it — but "stopped" has to mean
    // the same thing to a caller holding the Engine directly, or the guarantee
    // is only a property of one call path.
    if (this.fatal) return;

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

/**
 * Is this economy event *this machine's own*?
 *
 * Every economy event (`itemPickup`, `goldChanged`, `equipmentChanged`,
 * `goldReward`, `itemMutated`) is tagged at its emit site with the pawn whose
 * purse or pack moved (`Items._owner()`). On a host that bus carries every
 * pawn's transactions, the viewer's and every satellite's alike, so a consumer
 * that speaks for the viewer — a jingle, a toast, the logbook, a popup — has to
 * ask whose event it is before it acts.
 *
 * `owner` absent means "the viewer's", which is what a client always sees (the
 * host strips the tag on the way out, because a client only ever receives
 * events about itself) and what every pre-co-op emitter and synthetic payload
 * produces. So in single-player this is `true` for everything, unchanged.
 */
export function isLocalOwner(ctx, payload) {
  const owner = payload?.owner;
  return !owner || owner === ctx?.player;
}

export function isLocalVictim(ctx, payload) {
  const victim = payload?.victim;
  if (!victim) return ctx?.netRole !== 'client';
  return !ctx?.player || victim === ctx.player;
}
