import * as THREE from 'three';
import { SPAWN_CARDS, BOSS_CARDS, ELITE_AFFIXES } from '../data/enemies.js';
import { ITEMS } from '../data/items.js';

/**
 * Scenario driver for the screenshot harness (tools/capture.mjs).
 *
 * Installed only under `?harness=1`. Calls the systems' real APIs — an earlier
 * version guessed at method names and every scenario silently captured the
 * title screen instead, which is exactly the failure mode a harness must not
 * have. Prefer failing loudly here over producing a plausible-looking wrong
 * screenshot.
 *
 * Two rules this file exists to enforce, both learned from shipping shots that
 * did not contain their subject:
 *
 *  1. **Nothing is placed on a world axis.** Every spawn, blast and camera
 *     offset is derived from the camera's own forward vector and dropped onto
 *     `stage.sampleHeight`. A `+X/+Z` diagonal is only correct when the player
 *     happens to be facing north-east; the rest of the time it puts the subject
 *     behind the camera or inside a cliff.
 *  2. **The shutter is frame-locked, not time-lucky.** Each scenario owns its
 *     own settle, fires its effect a fixed number of *rendered frames* before
 *     the end, and then stops the engine loop. The last presented frame is
 *     therefore the frame the scenario chose, no matter what fps the machine
 *     manages. `08-explosion` previously let ~0.63 s elapse before the
 *     screenshot against a blast whose whole visible life is ~0.28 s, and
 *     photographed the smoke.
 *
 * Three clocks, and knowing which one a number is in is most of this file:
 *
 *  - **frames** — `frames(n)`, rendered frames. Deterministic once the capture
 *    clock is pinned (`pinClock`), which `tools/capture.mjs` does before the
 *    first scenario. This is the only clock a *shutter* is ever allowed to use.
 *  - **simulation seconds** — `ctx.time`, advanced inside `Engine`'s fixed step
 *    and *scaled by hitstop*. Cooldowns, spawn pops (0.45 s), the hit-flash
 *    (0.075 s) and the difficulty curve all live here. `waitSim`.
 *  - **presentation seconds** — the `dt` handed to `update()`. Every VFX
 *    lifetime lives here. `waitFx`.
 *
 * The last two are the same clock only when hitstop is zero, and an explosion
 * scenario is exactly where it is not: the blast's own kills raise hitstop,
 * which stretches simulation time against presentation time by up to 1/0.15.
 * `08-explosion` asked `waitSim` for 0.09 s and photographed the blast at
 * 0.207 s of its own life; `10-inventory` asked for 0.12 s and landed somewhere
 * different every run. Both now use `waitFx` and both record the age they
 * actually got in the manifest.
 *
 * Every scenario is `async` and resolves only when the frame is composed and
 * the engine is frozen; `tools/capture.mjs` just awaits it and shoots.
 */
export function installHarness(ctx) {
  const { camera } = ctx;

  // Captures and perf runs must control their own resolution. Adaptive scaling
  // would otherwise quietly change the drawing buffer mid-measurement, which
  // makes a screenshot non-reproducible and a benchmark meaningless.
  ctx.pipeline?.setAdaptive?.(false, 1);

  // Same principle for the #43 sliders: a capture can never inherit a saved
  // reduced setting from localStorage, so pin the live object (not persisted)
  // to full intensity for flash/aberration/bloom/motion.
  if (ctx.settings) {
    ctx.settings.flash = 1;
    ctx.settings.aberration = 1;
    ctx.settings.bloom = 1;
    ctx.settings.motion = 1;
  }

  // Menus live inside HUD rather than on ctx, and every gameplay scenario needs
  // the title screen gone first — it pauses the sim and blurs the whole frame.
  const dismiss = () => {
    thaw();
    ctx.hud?.menus?.close?.();
    ctx.paused = false;
  };

  // Progression emits `stageStart` shortly after the title screen goes away,
  // and Director's handler for it calls `clear()` — every enemy despawned.
  // Anything spawned before that point is silently deleted a few frames later,
  // so the first gameplay scenario of a run would photograph an empty arena and
  // report no error about it.
  let stageStarted = false;
  ctx.events?.on?.('stageStart', () => { stageStarted = true; });

  // The biome series rebuilds the world four times and puts it back on stage 1
  // *after* its last shutter, deliberately without relabelling — emitting there
  // would stamp "Stage 1" over the frame of biome 4 that is already on the
  // canvas waiting to be photographed. The cost was that every shot after it
  // carried the *previous* label: `04-combat` shipped a stage-1 world captioned
  // `STAGE 4 — FERROUS MUSTER`. So the relabel is deferred to the next
  // scenario's `begin()`, which runs before anything is composed.
  let pendingRelabel = null;

  /** Dismiss the menu, wait for the stage to exist, and empty the arena. */
  const begin = async () => {
    dismiss();
    // Every scenario shares one page, one rig and one input object, and the
    // scenarios below now write `yaw`, `pitch` and the trigger directly. A shot
    // that inherits the previous one's aim is not the shot it documents:
    // `08-explosion` photographed a mountain horizon with the blast sliding off
    // the bottom of frame because `05-boss` had left the lens pitched up at a
    // Colossus's chest, and `02-vista` ran with the trigger still held from
    // `04-combat`. Reset both before anything is placed — every scenario
    // derives its spawns from camera forward, so a stale pitch moves the
    // subject as well as the frame.
    if (ctx.cameraRig) ctx.cameraRig.pitch = -0.12;
    if (ctx.input) ctx.input.mouse.left = false;
    for (let i = 0; i < 180 && !stageStarted; i++) await frames(1);
    if (pendingRelabel != null) {
      const n = pendingRelabel;
      pendingRelabel = null;
      ctx.events?.emit?.('stageStart', { index: n, name: ctx.stage?.stageName ?? '' });
      const toasts = ctx.hud?.toasts;
      if (toasts) {
        while (toasts.length > 1) toasts.shift().el?.remove();
        ctx.hud.restackToasts?.();
      }
    }
    // Every scenario shares one page, so without this each one inherits the
    // previous one's horde. `05-boss` was photographing twenty-four leftover
    // sentinels from `04-combat` standing in front of the Colossus, which is how a
    // shot ends up containing everything except its subject.
    if (ctx.director) {
      ctx.director.clear?.(ctx);
      ctx.director.eventActive = false;
    }
  };

  /**
   * Bring the survivor level to exactly `level`, plus `frac` of the way into
   * the next one, using Progression's own `addExperience` — so the XP bar, the
   * `LEVEL n` toast and Player's level-scaled health all derive from it the way
   * they do in a real run. Written as a top-up rather than a flat award because
   * every scenario shares one page and the preceding captures earn incidental
   * XP; a fixed 2600 would land on a different level depending on shot order.
   */
  const seedLevel = (level, frac = 0) => {
    const p = ctx.progression;
    if (!p?.addExperience) return;
    for (let i = 0; i < 128 && p.level < level; i++) p.addExperience(p.xpToNext - p.xp);
    p.addExperience(p.xpToNext * frac - p.xp);
  };

  const detach = () => { if (ctx.cameraRig) ctx.cameraRig.enabled = false; };
  const attach = () => { if (ctx.cameraRig) ctx.cameraRig.enabled = true; };
  const playerPos = () => ctx.player?.position ?? new THREE.Vector3();

  // --- shutter control -------------------------------------------------------

  const engine = () => globalThis.__GAME__?.engine ?? null;

  /**
   * Stop the render loop so the composited frame cannot advance while
   * Playwright takes the screenshot.
   *
   * `Engine.stop()` only clears the `running` flag; the already-armed rAF
   * returns immediately and the canvas keeps presenting the last frame it drew.
   * Note this does *not* stop `requestAnimationFrame` itself, so any helper
   * still waiting on frames resolves normally instead of hanging.
   */
  const freeze = () => engine()?.stop?.();

  /* Undo queued for *after* the shutter, not for after the assertion.
   *
   * A scenario that changes global state for its own shot has to put it back,
   * and the obvious place to do that — the line after `mustContain` — is inside
   * the frame that is about to be photographed. `capture.mjs` screenshots when
   * the scenario's promise resolves, so anything the scenario does after
   * asserting is in the PNG and not in the manifest. `18-difficulty` restored
   * the previous rung there and shipped an assertion reading `deluge` over a
   * photograph of `downpour`: the check passed, the shot was wrong. It is the
   * same shape as the biome caption that stamped `STAGE 4` on a stage-1 world,
   * and it takes the same answer — defer the undo into the next scenario.
   *
   * Drained from `thaw()`, which is the first thing every scenario does (either
   * directly or through `begin()` -> `dismiss()`), and which nothing calls again
   * later in a scenario, so a restore can never run early.
   */
  const pendingRestores = [];
  const restoreAfterShutter = (fn) => { pendingRestores.push(fn); };
  const thaw = () => {
    while (pendingRestores.length) {
      try { pendingRestores.shift()(); } catch (e) { console.error(`[harness] restore failed: ${e?.message ?? e}`); }
    }
    const e = engine();
    if (e && !e.running) e.start();
  };

  /* --- the capture clock ------------------------------------------------
   *
   * `Engine._frame` takes its delta from a `THREE.Clock`, i.e. from the wall
   * clock, and hands that delta to every `update()` — which is where all
   * presentation lives: VFX particle ages, ring radii, damage-number arcs,
   * camera springs. `ctx.time`, by contrast, only advances inside the fixed
   * step, and the fixed step is *scaled by hitstop* (`Engine.js:196-208`,
   * `HITSTOP_SCALE = 0.15`).
   *
   * So the two clocks a scenario can wait on run at different, load-dependent
   * rates. `waitSim(0.12)` in `10-inventory` waits for 0.12 s of **simulation**
   * time; the nova it is photographing ages on **wall** time; and the nova's
   * own kills raise hitstop, which stretches the wall interval needed to buy
   * those 0.12 s by up to 1/0.15. How many monsters the nova kills before the
   * shutter varies with frame pacing, so the effect's age at the shutter varied
   * with frame pacing. That is the whole of the run-to-run instability: the
   * same seed produced a 294 px blast on one run and a passing one on the next
   * with no code change.
   *
   * The fix is to make the delta a constant instead of a measurement. With the
   * clock pinned, one rendered frame is exactly `dt` of presentation time and
   * `dt * scale` of simulation time, both derived from a frame count that is
   * identical on every machine — so a shot is a function of its seed and its
   * frame budget and of nothing else. Nothing is silently slowed: the engine
   * still renders as fast as the GPU allows, it just no longer *asks* how long
   * that took.
   *
   * Off by default, because `tools/perf.mjs` measures how the game behaves on
   * the real clock and pinning it would make that measurement fiction.
   * `tools/capture.mjs` turns it on before the first scenario.
   */
  let _pinnedDt = 0;
  let _realClock = null;
  const pinClock = (dt = 1 / 60) => {
    const e = engine();
    if (!e) return false;
    _realClock = _realClock ?? e.clock;
    _pinnedDt = dt;
    // Engine only ever calls `start()` and `getDelta()`; the rest is here so a
    // future caller of the Clock API does not get a surprise `undefined`.
    let elapsed = 0;
    e.clock = {
      running: true,
      start() {}, stop() {},
      getDelta: () => { elapsed += dt; return dt; },
      getElapsedTime: () => elapsed,
    };
    return true;
  };
  const unpinClock = () => {
    const e = engine();
    if (e && _realClock) { e.clock = _realClock; _realClock.getDelta(); }
    _pinnedDt = 0;
  };
  /** Seconds of presentation time one rendered frame buys. */
  const frameDt = () => _pinnedDt || (1 / 60);

  /**
   * Resolve after `n` rendered frames.
   *
   * The wall-clock cap is a hang guard, not a wait: `page.evaluate` has no
   * timeout of its own, so a stalled GPU would otherwise take the whole capture
   * down with it. It is also the one place a shot can silently become
   * non-deterministic, so every time it fires is counted and the count is
   * published in the manifest — a truncated settle now shows up as evidence
   * rather than as a mystery.
   */
  let frameTimeouts = 0;
  const frames = (n, maxMs = 20000) => new Promise((res) => {
    let i = 0;
    const deadline = performance.now() + maxMs;
    const step = () => {
      if (++i >= n) return res();
      if (performance.now() > deadline) { frameTimeouts++; return res(); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  // --- placement helpers -----------------------------------------------------

  const _fwd = new THREE.Vector3();
  const _proj = new THREE.Vector3();
  const _probe = new THREE.Vector3();

  /** Camera forward flattened to the ground plane. Everything is placed off this. */
  const forward = () => {
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    return _fwd.normalize();
  };

  const groundY = (x, z, fallback = 0) => {
    const g = ctx.stage?.sampleHeight?.(x, z);
    return Number.isFinite(g) ? g : fallback;
  };

  /** A point `dist` metres in front of the player, sitting on the terrain. */
  const ahead = (dist, lift = 0) => {
    const p = playerPos();
    const f = forward();
    const x = p.x + f.x * dist, z = p.z + f.z * dist;
    return new THREE.Vector3(x, groundY(x, z, p.y) + lift, z);
  };

  /**
   * Is the straight line from `from` to `to` clear of terrain and props?
   *
   * `stage.raycastDistance` returns -1 for a miss and covers both the
   * heightfield and the prop instances, which is exactly the pair that has been
   * parking the lens inside a boulder.
   */
  const _los = new THREE.Vector3();
  const _rayHit = (from, to, slack) => {
    _los.subVectors(to, from);
    const dist = _los.length();
    if (dist < 1e-3) return true;
    _los.divideScalar(dist);
    const hit = ctx.stage?.raycastDistance?.(from, _los, dist - slack);
    return typeof hit === 'number' && hit >= 0;
  };
  const seesTarget = (from, to, slack = 0.4) =>
    // Cast both ways. Three's raycaster ignores back faces, so a ray that
    // *starts inside* a boulder exits it without reporting a hit — which is
    // precisely the case we are trying to detect, and why the one-directional
    // version of this test still handed back a camera buried in rock.
    !_rayHit(from, to, slack) && !_rayHit(to, from, slack);

  /** Metres of open space behind `target` along the camera's look axis. */
  const backdropDepth = (from, to) => {
    _los.subVectors(to, from);
    const dist = _los.length();
    if (dist < 1e-3) return 0;
    _los.divideScalar(dist);
    const hit = ctx.stage?.raycastDistance?.(from, _los, 200);
    return typeof hit === 'number' && hit >= 0 ? hit - dist : 200;
  };

  /**
   * Sun azimuth, so a subject can be cross-lit rather than flatly front- or
   * back-lit. Falls back to the camera bearing if Environment has not published
   * itself (it is a convenience handle, not part of the ctx contract).
   */
  const sunAzimuth = () => {
    const s = ctx.environment?.sunDir;
    return s ? Math.atan2(s.x, s.z) : Math.atan2(forward().x, forward().z);
  };

  /**
   * A camera position that can actually see `target`.
   *
   * Sweeps azimuths outward from `prefer`, growing the radius if every bearing
   * at the first ring is blocked. This is the guard that `07-interactables` was
   * missing: a hardcoded `+X/+Z` standoff is inside a rock whenever the subject
   * happens to have one on that diagonal, and the shot then photographs the
   * inside of the prop with no error anywhere to show for it.
   */
  /** Does the segment a→b pass within `r` of point c? */
  const segmentHitsSphere = (a, b, c, r) => {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-6) return false;
    const t = Math.max(0, Math.min(1, (acx * abx + acy * aby + acz * abz) / ab2));
    const dx = acx - abx * t, dy = acy - aby * t, dz = acz - abz * t;
    return dx * dx + dy * dy + dz * dz < r * r;
  };

  const _cc = new THREE.Vector3();
  const clearCam = (base, {
    radius = 5.5, lift = 2.4, prefer = 0, rings = 4, step = 1.6,
    backdrop = 14, strict = false, blockers = null,
    fov = 0, maxForeground = 1,
    // The subject's box, which is what the occlusion test now samples.
    subjectHeight = 2.2, subjectRadius = 1.0, minVisible = 0.85,
    // Anything closer than `occluderNear` x the standoff, anywhere in frame.
    maxOccluders = 1,
  } = {}) => {
    const spokes = 16;
    let lenient = null;
    for (let ring = 0; ring < rings; ring++) {
      const r = radius + ring * step;
      for (let i = 0; i < spokes; i++) {
        // Alternate either side of the preferred bearing so the accepted shot
        // is the one closest to the lighting we asked for.
        const az = prefer + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI * 2 / spokes);
        const cx = base.x + Math.sin(az) * r;
        const cz = base.z + Math.cos(az) * r;
        const cy = Math.max(groundY(cx, cz, base.y), base.y) + lift;
        const pos = new THREE.Vector3(cx, cy, cz);
        // Sample the subject's whole projected box, not its centre line. A ray
        // at the middle of a sixteen-strong rank says nothing about the trunk
        // standing over slots four to seven, which is exactly the frame
        // `11-bestiary` shipped.
        if (visibleFraction(pos, base, { height: subjectHeight, radius: subjectRadius }) < minVisible) continue;
        // Objects the stage raycast cannot see. Interactables live in their own
        // group rather than in `stage.propTargets`, so a chest standing behind
        // a multishop terminal passes every terrain and prop test and is still
        // completely hidden in the frame.
        if (blockers && blockers.some((b) => segmentHitsSphere(pos, _cc.set(base.x, base.y + 1.0, base.z), b.position, b.radius ?? 1.6))) continue;
        // Visible is not the same as photographable: a subject with a cliff
        // face half a metre behind it has no midground or background at all,
        // which is the axis-2 "everything at one depth" failure.
        if (backdropDepth(pos, _cc.set(base.x, base.y + 1.0, base.z)) < backdrop) {
          lenient = lenient ?? pos;
          continue;
        }
        // What the *near* half of the frustum contains is a composition
        // decision too, and nothing here used to test it: a low lens on a
        // slope spent a quarter of `07-interactables` on one featureless
        // wedge of foreground terrain, which the long lens made worse rather
        // than better (it narrowed the field; the slope simply filled more of
        // it). Reject the bearing rather than the subject.
        const standoff = Math.hypot(pos.x - base.x, pos.y - base.y, pos.z - base.z);
        if (maxForeground < 1 && fov > 0) {
          if (foregroundLoad(pos, _cc.set(base.x, base.y + 1.3, base.z),
                             fov, camera.aspect || (16 / 9), standoff * 0.35) > maxForeground) {
            lenient = lenient ?? pos;
            continue;
          }
        }
        // And a foreground prop anywhere in the frame, not only under the
        // subject: a trunk that misses the subject entirely still owns a third
        // of the composition.
        if (maxOccluders < 1 && fov > 0) {
          if (frameOccluders(pos, _cc.set(base.x, base.y + subjectHeight * 0.5, base.z),
                             fov, camera.aspect || (16 / 9), standoff * 0.8) > maxOccluders) {
            lenient = lenient ?? pos;
            continue;
          }
        }
        return pos;
      }
    }
    // `strict` callers would rather move to a different subject than shoot this
    // one against a rock face half a metre behind it.
    return strict ? null : lenient;
  };

  /**
   * The best camera on the sweep, scored rather than filtered.
   *
   * `clearCam` answers "is there a bearing that satisfies all of these
   * constraints at once", and hands back null when there is not. Every caller
   * that got a null then dropped through to a hand-written fallback with no
   * visibility test of any kind — and that fallback branch is the one `05-boss`
   * and `12-boss-phases` both shipped from. Tightening the constraints made it
   * *more* likely to be taken, which is the wrong direction for a guard.
   *
   * So this one always returns the best thing it found, and reports how good it
   * was. The good path and the fallback path are the same code, and the shot's
   * subject assertion is what decides whether the result is usable.
   */
  const bestCam = (base, {
    radius = 20, lift = 6, rings = 4, step = 2.5, prefer = 0, spokes = 16,
    subjectHeight = 4, subjectRadius = 2, fov = 42, backdrop = 26, wantSun = false,
  } = {}) => {
    let best = null;
    const aspect = camera.aspect || (16 / 9);
    for (let ring = 0; ring < rings; ring++) {
      const r = radius + ring * step;
      for (let i = 0; i < spokes; i++) {
        const az = prefer + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI * 2 / spokes);
        const cx = base.x + Math.sin(az) * r, cz = base.z + Math.cos(az) * r;
        const cy = Math.max(groundY(cx, cz, base.y), base.y) + lift;
        const pos = new THREE.Vector3(cx, cy, cz);
        const mid = _cc.set(base.x, base.y + subjectHeight * 0.5, base.z);
        const vis = visibleFraction(pos, base, {
          height: subjectHeight, radius: subjectRadius, cols: 5, rows: 5, slack: 0.8,
        });
        const back = Math.min(backdropDepth(pos, mid), 60);
        const occ = frameOccluders(pos, mid, fov, aspect, r * 0.75);
        const score = vis * 10
          - occ * 6
          + Math.min(back, backdrop) * (2 / Math.max(1, backdrop))
          + (wantSun && sunlit(base, 2.0) ? 0.8 : 0);
        if (!best || score > best.score) {
          best = { pos, vis: +vis.toFixed(3), occ: +occ.toFixed(3), back: +back.toFixed(1), score };
        }
      }
    }
    return best;
  };

  /**
   * Frame height in CSS pixels, so a screen-space measurement can be reported
   * in the units a reviewer measures the PNG in.
   */
  const framePx = () => ctx.pipeline?.renderer?.domElement?.clientHeight || 900;

  /** Normalised screen position of a world point, y measured from the top. */
  const _ndc = new THREE.Vector3();
  const screenOf = (x, y, z) => {
    _ndc.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const front = -_ndc.z;
    _ndc.applyMatrix4(camera.projectionMatrix);
    return { x: _ndc.x * 0.5 + 0.5, y: 0.5 - _ndc.y * 0.5, front };
  };

  /**
   * Pitch the camera so a tall subject and a second, much smaller reference
   * object are both in frame, with the horizon off the vertical midpoint.
   *
   * Solved by search rather than by trigonometry because the ground under the
   * two is rarely the same height: a closed-form pitch that is right on flat
   * terrain drops the player out of the bottom of frame on a slope, which is
   * exactly what the first attempt at the boss framing did (player feet at
   * y = 957 of 900).
   */
  const aimBetween = (subject, height, reference) => {
    let bestY = height * 0.34, bestScore = -Infinity;
    for (let ly = -2; ly <= height + 3; ly += 0.4) {
      camera.lookAt(subject.x, subject.y + ly, subject.z);
      camera.updateMatrixWorld(true);
      const head = screenOf(subject.x, subject.y + height, subject.z);
      const feet = screenOf(subject.x, subject.y, subject.z);
      const ref = screenOf(reference.x, reference.y, reference.z);
      if (head.front <= 0 || ref.front <= 0) continue;
      // Subject's head just under the HUD's top strip (the boss bar and the
      // objective banner own roughly the first 12% of frame height, and a Colossus
      // whose head is behind the bar reads as a cropped subject), its feet clear
      // of the bottom, and the reference inside the lower safe area rather than
      // under the frame.
      let s = -Math.abs(head.y - 0.21) * 3;
      s -= Math.max(0, feet.y - 0.80) * 6;
      s -= Math.max(0, ref.y - 0.92) * 25;
      s -= Math.max(0, 0.52 - ref.y) * 4;
      if (s > bestScore) { bestScore = s; bestY = ly; }
    }
    camera.lookAt(subject.x, subject.y + bestY, subject.z);
    camera.updateMatrixWorld(true);
    return bestY;
  };

  /**
   * Is this world point inside the safe area of the frame?
   *
   * `pad` is the fraction of the viewport treated as unusable margin — a spawn
   * that projects outside it is the "unidentifiable mass cropped by the bottom
   * edge" defect, so we re-roll rather than ship it.
   */
  const onScreen = (x, y, z, pad = 0.06) => {
    camera.updateMatrixWorld();
    _proj.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    if (-_proj.z < 1) return false;              // behind or on top of the lens
    _proj.applyMatrix4(camera.projectionMatrix); // applyMatrix4 does the w divide
    const sx = _proj.x * 0.5 + 0.5;
    const sy = 0.5 - _proj.y * 0.5;
    return sx > pad && sx < 1 - pad && sy > pad && sy < 1 - pad;
  };

  /**
   * Fan enemies across the camera's forward arc and drop each onto the terrain.
   *
   * A naive ring at the player's own height buries half the group inside the
   * cliff the player is standing against and drops the other half off the ledge
   * — which is why the first capture pass showed an empty battlefield.
   *
   * `radiusBase` is measured from the *player*, but the shot is taken from the
   * camera, which sits ~5.4 m further back on the boom. At the old base of 8 m
   * the nearest rank was closer to the lens than the player was, so it filled
   * the lower third with a cropped blur. Each spawn is now also projected and
   * re-rolled outward until it lands inside the frame's safe area.
   */
  /**
   * A deterministic set of ground points, laid out in *screen* space.
   *
   * Columns are a jittered fan across the frame's safe area, skipping any cell
   * that lands on the survivor's own silhouette. Every point comes back from
   * `groundAtScreen`, so each one is on screen and unoccluded by construction.
   *
   * Rows are **solved for a distance**, not read off a fixed screen height, and
   * that is the whole of this function's history. The five rows used to sit at
   * `sy = 0.40 + row * 0.085` — a band chosen against a camera standing well
   * above its terrain. On the flat arena `04-combat` now shoots on, the lens is
   * 1.8 m above the ground plane and the horizon lands at `sy ≈ 0.38`: row 0 saw
   * only ground past 46 m, rows 2-4 saw ground inside 10 m, and *one* of the
   * five rows fell inside a 13-46 m band. Nine slots for a twenty-four strong
   * horde. Everything downstream then looked like its own bug — `spawnRing`
   * dropped fifteen monsters onto its blind fallback arc, one of which came back
   * at world y 2.4 against a survivor at 19.5 (measured,
   * `reviews/round6/diag-combat7.json`, object 23 at 0 px), and `declutter` had
   * nothing to re-seat with, so it left the hulk out at 32.4 m with sepP50 0.21
   * after being asked for 30.
   *
   * So each column solves for the two screen heights that bracket the wanted
   * depth band — `sy` at `maxDist` and `sy` at `minDist` — and its rows are
   * spread evenly between them. The grid then covers the whole of the usable
   * band and nothing else, at whatever camera height, and the supply is the
   * grid's size rather than an accident of pitch. Targeting fixed *distances*
   * instead was tried and is worse for the same reason the fixed heights were:
   * from a low lens, 46 m and 15 m are four hundredths of frame height apart,
   * so geometric depth targets pile four of the five rows into one band and the
   * de-dup below throws them away — seventeen slots survived of a possible
   * sixty-five.
   */
  const _slotRow = (sx, target, hardMax) => {
    // Lower in frame is nearer, monotonically, for any lens looking downhill —
    // so bisect. A ray that hits nothing (sky, or past the world) reads as
    // "further than anything", which is the same branch as too far.
    let lo = 0.30, hi = 0.97, got = null;
    for (let i = 0; i < 13; i++) {
      const sy = (lo + hi) * 0.5;
      const g = groundAtScreen(sx, sy, { minDist: 1, maxDist: hardMax });
      if (!g) { lo = sy; continue; }
      const d = Math.hypot(g.x - camera.position.x, g.z - camera.position.z);
      if (!got || Math.abs(d - target) < Math.abs(got.d - target)) got = { g, d, sy };
      if (d > target) lo = sy; else hi = sy;
    }
    return got;
  };

  /* Screen distance with the frame's aspect divided out, so "0.05 apart" means
   * the same number of metres whether two things are side by side or one above
   * the other. Comparing raw (x, y) fractions on a 16:9 frame counts a vertical
   * gap as nearly twice the horizontal one it actually is. */
  const _aspect = () => camera.aspect || (16 / 9);
  const screenGap = (ax, ay, bx, by) => Math.hypot(ax - bx, (ay - by) / _aspect());
  /* Half the width a body of world radius `r` covers at distance `d`, as a
   * fraction of frame width. The frame is `2 d tan(hHalf)` metres wide there. */
  const screenHalf = (r, d) => {
    const tanH = Math.tan(camera.fov * Math.PI / 360) * _aspect();
    return (r + 0.3) / Math.max(1e-3, 2 * Math.max(1, d) * tanH);
  };

  /* The nearest horde member standing between a subject and the lens.
   *
   * Every `vis` in this file comes from `visibleFraction`, which casts through
   * `seesTarget` -> `_rayHit` -> `ctx.stage.raycastDistance` — *stage geometry
   * only*. The director's enemies are not in `ctx.stage`, so `vis` is
   * structurally blind to the horde occluding itself, and it is published beside
   * a pixel count with nothing saying so. That reads as a contradiction rather
   * than as a gap in the instrument: `04-combat` object 2 came back `vis: 1,
   * px: 1` — nominally unoccluded and yet invisible — while a mortar 11.3 m
   * nearer the lens sat 0.011 frame-widths away
   * (`reviews/round7/captures/diag-combat-bestiary/manifest.json`, `DIAG horde`).
   * The reader who found that spent the single largest step of the diagnosis on
   * it, and this project's recurring failure mode is an instrument that is wrong
   * in the same direction as the bug.
   *
   * So `vis` now travels with the number it cannot see. `declutter` already
   * computes exactly this pair at its third question; this is the same
   * arithmetic over positions that have already been sampled — no raycast, no
   * `ctx.rng`, no `fxRng`, no frame advanced. It is published in `detail` only
   * and cannot move a verdict.
   *
   * Returns null when nothing is nearer, which is itself the useful answer.
   */
  const nearestNearer = (sx, sy, d, list, skip = null) => {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e === skip || !e.position) continue;
      const ed = Math.hypot(e.position.x - camera.position.x, e.position.z - camera.position.z);
      if (ed >= d) continue;
      const h = e.def?.height ?? 2;
      const es = screenOf(e.position.x, e.position.y + h * 0.5, e.position.z);
      if (!(es.front > 0)) continue;
      const gap = screenGap(sx, sy, es.x, es.y);
      if (!best || gap < best.gap) best = { i, id: e.def?.id ?? '?', d: +ed.toFixed(1), gap: +gap.toFixed(3) };
    }
    return best;
  };

  let _lastSlots = null;
  const screenSlots = (count, { minDist = 11, maxDist = 46, avoidPlayer = 0.075, avoid = [] } = {}) => {
    camera.updateMatrixWorld(true);
    const pp = playerPos();
    const ps = screenOf(pp.x, pp.y + 1.0, pp.z);
    const out = [];
    const used = [];
    /* Thirteen columns, not nine, and the reason is the same low lens that made
     * the rows need solving. On flat ground with the eye 1.8 m up, a rank at
     * 46 m and a rank at 15 m are four hundredths of frame height apart — every
     * row lands in the same narrow band under the horizon, and the de-dup below
     * (correctly) throws the collisions away. Measured with the five solved rows
     * and nine columns: fifteen slots survived for a twenty-four strong horde,
     * and the nine monsters left over went to `spawnRing`'s blind arc.
     *
     * Depth cannot buy screen separation from a low lens; width can. The fan is
     * widened rather than the de-dup relaxed, because relaxing it is just the
     * crowding bug again with a different constant. */
    const COLS = 13, ROWS = 4;
    const hardMax = maxDist * 4 + 40;
    // Per column, because the band's screen height depends on what the ground
    // under that column does — a column looking up a rise reaches `maxDist`
    // much lower in frame than one looking across the flat.
    const band = [];
    for (let c = 0; c < COLS; c++) {
      const k = c % 2 ? (COLS - 1) / 2 + Math.ceil(c / 2) : (COLS - 1) / 2 - Math.ceil(c / 2);
      const sx = 0.07 + (k / (COLS - 1)) * 0.86;
      const far = _slotRow(sx, maxDist, hardMax);
      const near = _slotRow(sx, minDist, hardMax);
      if (far && near && near.sy > far.sy + 0.01) band.push({ sx, far: far.sy, near: near.sy });
    }
    /* Back rank (further away, higher in frame) first so the nearest bodies are
     * the last to be placed and the first to be dropped when the grid runs out.
     *
     * **This fills row 0 — the `maxDist` rank — before it touches row 1**, so a
     * caller asking for thirteen or fewer bodies gets every one of them at the
     * far edge of its own depth band. That is real and it is measured: with
     * `spawnRing(10, ..., 14)` asking for a 14-47 m band, `06-loaded-hud`'s ten
     * monsters stood at 20.1, 25.7, 29.4, 30.8, 32.8, 33.7, 34.8, 38.1, 40.1 and
     * 44.0 m, with the three smallest cards in the deck on the three longest
     * ranges (`reviews/round6/hdiag3/manifest.json`, `DIAG horde`).
     *
     * **Sampling the whole grid at an even stride instead was tried, measured,
     * and is REFUTED — do not re-apply it without reading this.** Building all
     * `ROWS x COLS` slots and taking `count` of them at an even far-to-near
     * stride did spread the depth (`reviews/round6/hdiag4/manifest.json`,
     * `06-loaded-hud` -> `DIAG horde`: 14.6-40.9 m), and it made the capture
     * worse in three places at once: `06-loaded-hud` went from one failing
     * object to **two at literally 0 px** (`perPx [6,22,27,...]` ->
     * `[0,0,26,199,...]`), and `08-explosion` -> `damage numbers` and
     * `10-inventory` -> `monsters standing in it` both **started failing**, for
     * five failing shots against a documented four. `04-combat` did not move at
     * all — byte-identical `perPx` — because on that frame the grid yields fewer
     * than the twenty-four it asks for, so the stride never engages.
     *
     * The lesson is that this function's supply is not the lever it looks like:
     * the callers that need a nearer rank can say so, and `declutter`'s
     * `maxDist` already exists for exactly that. See `lateRun`.
     */
    /* Why a request for N cells came back with fewer, by reason. `slots.length`
     * alone says the grid ran out and cannot say which of the four filters
     * emptied it, and they have four different answers. A zero inside this is a
     * reason that rejected nothing; `cells` is the number of (row, column) pairs
     * considered, so `cells - noGround - player - avoid - dup` is exactly `got`
     * and a counter that stops being incremented shows up as an arithmetic
     * mismatch rather than as a plausible-looking small number. */
    const why = { cells: 0, band: band.length, noGround: 0, player: 0, avoid: 0, dup: 0, got: 0 };
    _lastSlots = why;
    for (let row = 0; row < ROWS && out.length < count; row++) {
      const t = ROWS === 1 ? 0.5 : row / (ROWS - 1);
      for (let ci = 0; ci < band.length && out.length < count; ci++) {
        const col = band[ci];
        const sx = col.sx + ((row % 2) ? 0.033 : 0);
        const sy = col.far + (col.near - col.far) * t;
        why.cells++;
        const g = groundAtScreen(sx, sy, { minDist, maxDist });
        if (!g) { why.noGround++; continue; }
        const r = { g, sy, d: Math.hypot(g.x - camera.position.x, g.z - camera.position.z) };
        if (ps.front > 0 && Math.hypot(sx - ps.x, r.sy - ps.y) < avoidPlayer) { why.player++; continue; }
        // Cells already spoken for by a body the caller is *not* moving. Without
        // this the grid happily re-seats a monster on top of one that was left
        // alone, and the mask pass then measures the one behind at a couple of
        // pixels — see the crowding pass in `declutter`.
        if (avoid.some((a) => screenGap(sx, r.sy, a.x, a.y) < a.r)) { why.avoid++; continue; }
        // Two rows whose requested distances the terrain cannot tell apart
        // bisect to the same `sy`, and two bodies on one point is the crowding
        // this grid exists to prevent. Emitted slots stand off each other by
        // construction; the row is simply short when the ground cannot hold it.
        if (used.some((u) => screenGap(sx, r.sy, u.x, u.y) < 0.05)) { why.dup++; continue; }
        used.push({ x: sx, y: r.sy });
        out.push(r.g);
        why.got++;
      }
    }
    return out;
  };

  /**
   * Fan enemies across the frame and drop each onto ground the lens can see.
   *
   * Placed through `screenSlots`, not off a world bearing. The world-space
   * version checked only that a spawn *projected* inside the frame, which is a
   * frustum test and not a visibility test — see the note on `groundAtScreen`
   * for the 24-of-24 failure that produced. `radiusBase` is kept as the near
   * clamp so callers keep their tuned standoff.
   */
  const spawnRing = (count, cards, radiusBase = 13, eliteEvery = 0) => {
    const slots = screenSlots(count, { minDist: radiusBase, maxDist: radiusBase + 33 });
    const p = playerPos();
    const base = Math.atan2(forward().x, forward().z);
    for (let i = 0; i < count; i++) {
      const def = cards[i % cards.length];
      let at = slots[i];
      if (!at) {
        /* Nothing in the frame could hold this one — a lens over water, a wall
         * of rock, or simply more monsters than the grid has cells. Fall back to
         * a world-space arc so the scenario still has bodies to work with; the
         * subject assertion below is what decides whether the shot is usable.
         *
         * The arc used to be one `sampleHeight` call and nothing else, which is
         * how `04-combat` shipped a charger standing at world y 2.4 with the
         * survivor at 19.5 — seventeen metres down the slope off the edge of the
         * arena, at screen y 1.07, contributing 0 px (measured,
         * `reviews/round6/diag-combat8.json`, object 23). A fallback is allowed
         * to be worse than the search; it is not allowed to be off a cliff. So
         * the radius is walked in and out until the ground under it is ground the
         * survivor is standing on the same shelf as, and the last resort is the
         * survivor's own footing rather than wherever the first sample landed.
         */
        const a = base + ((i / Math.max(1, count - 1)) - 0.5) * 1.6;
        const r0 = radiusBase + (i % 4) * 4;
        for (const r of [r0, r0 - 3, r0 + 3, r0 - 6, r0 + 6, r0 - 9]) {
          if (r < 4) continue;
          const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
          const y = groundY(x, z, p.y);
          if (Math.abs(y - p.y) > 3) continue;
          if (ctx.stage?.isWalkable && !ctx.stage.isWalkable(x, z)) continue;
          at = new THREE.Vector3(x, y, z);
          break;
        }
        if (!at) at = new THREE.Vector3(p.x + Math.sin(a) * 6, p.y, p.z + Math.cos(a) * 6);
      }
      const affix = eliteEvery && i % eliteEvery === 0
        ? ELITE_AFFIXES[(i / eliteEvery | 0) % ELITE_AFFIXES.length]
        : null;
      ctx.director?.spawnOne?.(ctx, def, at, affix);
    }
  };

  /**
   * Push anything that has closed inside `minDist` of the lens back out.
   *
   * Enemies charge the player during the settle, so a ring placed correctly at
   * t=0 is a wall of cropped torsos by the time the shutter opens. Run this in
   * the last couple of frames: it is the difference between "horde advancing on
   * the player" and "orange smear over the bottom edge".
   *
   * Two separate pushes, because distance and framing are separate problems.
   * The radial one fixes depth. It cannot fix overlap: pushing an enemy out
   * along its own bearing from the lens preserves its screen position exactly,
   * so a shrike fused with the survivor's shoulder at 6 m is the same shrike fused
   * with his shoulder at 12 m — which is what shipped, reading as an orange
   * growth on his arm rather than as a monster. Anything still sitting on the
   * player's silhouette is therefore also swung off the bearing.
   */
  const _seat = (e, at) => {
    e.position.set(at.x, e.def?.isFlyer ? at.y + (e.def.hoverHeight ?? 2) : at.y, at.z);
    e.home?.set?.(at.x, at.y, at.z);
    e.velocity?.set?.(0, 0, 0);
  };

  /* Run to convergence, not once, and never move the same body twice.
   *
   * One pass re-seats everything that failed, but a pass can only fit as many
   * bodies as the grid has cells left, so leftovers stay where they are. A
   * second pass has the rest of the grid to use — but it must not reconsider the
   * bodies the first pass just placed, or two passes fight over the same cells
   * and the frame comes back worse than one pass left it (measured: five failing
   * objects against one, on `04-combat`). So every body this has already seated
   * is carried forward as an *obstacle*: excluded from the candidates, included
   * in the crowding list. Each pass therefore strictly reduces the number of
   * unplaced bodies, and terminates when a pass moves none. */
  /* What the last `declutter` actually had to work with, per pass. `moved` alone
   * cannot tell "nothing needed moving" from "everything needed moving and there
   * was nowhere to put it", and those have opposite fixes. Read by `DIAG
   * declutter`. A zero inside it is an empty array: no pass ran at all. */
  let _lastDeclutter = [];
  const lastDeclutter = () => _lastDeclutter;

  const declutter = (minDist = 12, opts = {}) => {
    const seated = new Set();
    let moved = 0;
    _lastDeclutter = [];
    for (let i = 0; i < (opts.passes ?? 2); i++) {
      const n = _declutterPass(minDist, { ...opts, seated });
      moved += n;
      if (!n) break;
    }
    return moved;
  };

  const _declutterPass = (minDist = 12, {
    keep = null, maxDist = null, seated = null,
    /* Both default to what every caller had before and are opt-in per call
     * site, deliberately. The last attempt to improve slot supply for one
     * scenario by changing `screenSlots` for all of them cost two shots that
     * were passing (see the refutation recorded in `screenSlots`), so a lever
     * that only one scenario has evidence for is a lever only that scenario
     * pulls.
     *
     * `supply` asks the grid for more cells than there are bodies to place, so
     * the re-seat is choosing rather than taking what is left. `nearFirst`
     * hands them out from the near end of the band: a body in this list is one
     * that failed to be photographed where it stood, and the far rank is where
     * it failed. */
    supply = 0, nearFirst = false,
    /* Size the grid's keep-out discs to the body that is actually going to be
     * placed, instead of assuming it is the same size as the body it must clear.
     * Off by default for the same reason as the two above. */
    avoidFit = false,
    /* Spend a short grid on the bodies that need it most rather than on the
     * nearest ones. Off by default, and see the note at the seat loop for why
     * this is a different lever from the refuted `nearFirst`. */
    worstFirst = false,
  } = {}) => {
    const list = (ctx.director?.enemies ?? [])
      .filter((e) => e?.alive && e.position && e !== keep && !seated?.has(e));
    const cam = camera.position;
    camera.updateMatrixWorld(true);
    const pp = playerPos();
    const ps = screenOf(pp.x, pp.y + 1.0, pp.z);
    const far = maxDist ?? (minDist + 34);

    /* `keep` is exempt from being *moved*, not from being *stood in front of*.
     *
     * It was filtered out of the list above and therefore out of everything
     * below, so nothing knew it was there and the grid was free to re-seat a
     * monster on the exact screen position of the one body the caller had pinned.
     * `04-combat` pins its damage-number target and photographed it at 7 px of a
     * required 113 for exactly this reason (measured,
     * `reviews/round6/diag-combat11.json`, object 16). It seeds the crowding
     * list instead: first, so it wins every pair it is in. */
    const kept0 = [];
    const asObstacle = (e) => {
      if (!e?.position) return;
      const kd = Math.hypot(e.position.x - cam.x, e.position.z - cam.z);
      const ks = screenOf(e.position.x, e.position.y + (e.def?.height ?? 2) * 0.5, e.position.z);
      if (ks.front > 0) kept0.push({ x: ks.x, y: ks.y, half: screenHalf(e.def?.radius ?? 0.5, kd) });
    };
    asObstacle(keep);
    // Bodies an earlier pass already seated. Same treatment as `keep`, and for
    // the same reason: this pass may not move them, so it has to see them.
    if (seated) for (const e of seated) asObstacle(e);

    // Which ones are actually photographable where they stand. Distance and
    // screen overlap were the only two questions this used to ask, and a body
    // that satisfied both from behind a ridge still contributed nothing — 23 of
    // `04-combat`'s 24 monsters were in that state.
    //
    // Nearest first, because the third question below is about pairs and the
    // near body is the one that wins the pixels.
    const ranked = list.map((e) => {
      const dx = e.position.x - cam.x, dz = e.position.z - cam.z;
      return { e, d: Math.hypot(dx, dz) };
    }).sort((a, b) => a.d - b.d);

    const bad = [];
    /* How well each `bad` body is doing *where it stands*, 0 (contributing
     * nothing) to 1 (fully in view). Read only by `worstFirst` below. */
    const need = new Map();
    const kept = kept0;
    for (const { e, d } of ranked) {
      const h = e.def?.height ?? 2;
      const es = screenOf(e.position.x, e.position.y + h * 0.5, e.position.z);
      const merged = es.front > 0 && Math.hypot(es.x - ps.x, es.y - ps.y) < 0.09;
      const framed = es.front > 0 && es.x > 0.03 && es.x < 0.97 && es.y > 0.03 && es.y < 0.97;
      const vis = framed ? visibleFraction(
        cam, _cc.set(e.position.x, e.position.y, e.position.z),
        { height: h, radius: (e.def?.radius ?? 0.5) + 0.2, cols: 3, rows: 3, slack: 0.3 },
      ) : 0;
      const seen = framed && vis >= 0.6;
      /* And the third question, which nothing was asking: is anything else
       * already standing there.
       *
       * Terrain is not the only thing that can occlude a monster — the horde
       * occludes itself, and the per-object mask measures *marginal*
       * contribution, so a body directly behind another body renders the pixels
       * of neither. Measured on `reviews/round6/harness/04-combat.png` after the
       * arena fix landed: every one of the twenty-five was on flat ground, in
       * frame, unoccluded by terrain and individually `visible`, and four of
       * them still came back at 1, 2, 8 and 9 px — three of the four sitting
       * within 0.02 of frame width of a larger monster in front of them.
       *
       * The bar is the pair's own projected width rather than a constant: two
       * mites at 25 m need a tenth of the gap a hulk at 12 m does, and a
       * constant big enough for the hulk empties the frame of everything else.
       */
      const half = screenHalf(e.def?.radius ?? 0.5, d);
      const crowded = framed && kept.some(
        (k) => screenGap(es.x, es.y, k.x, k.y) < (half + k.half) * 1.15);
      if (d >= minDist && d <= far && !merged && seen && !crowded) {
        kept.push({ x: es.x, y: es.y, half });
        continue;
      }
      /* How many pixels this body is going to contribute where it stands —
       * *not* how wrong it looks there. The two are different questions and
       * conflating them is measured: scoring `d < minDist` as 0 alongside
       * `!framed` put seven bodies on the same key, and V8's stable sort then
       * handed the slots back to the nearest ones in the original order, for a
       * partition byte-identical to not sorting at all
       * (`reviews/round6/cfit2/manifest.json` — same eight `unplaced`, merely
       * reordered). A body inside the near clamp is *over*-photographed: it is
       * a composition defect, and it is the one kind of `bad` that never fails
       * a pixel gate. It scores what it shows, which ranks it last.
       *
       * Off frame scores 0 — it contributes literally nothing and cannot
       * improve by being left alone. Fused with the survivor scores just above
       * that: a few pixels, and they read as a growth on his arm. */
      need.set(e, !framed ? 0 : merged ? 0.05 : vis);
      bad.push(e);
    }
    if (!bad.length) return 0;

    // Everything that failed is re-seated on ground the lens has raycast to,
    // laid out in screen space, and away from the bodies that were left where
    // they stood. Rejected slots are simply not returned, so a body that cannot
    // be placed anywhere visible stays where it is and the subject assertion
    // reports the shortfall rather than the frame hiding it.
    /* The keep-out radius around a body the grid must not re-seat on top of.
     *
     * The default is `k.half * 2.3` — the obstacle's own projected half-width,
     * doubled for the incoming body and given the same 1.15 slack the crowding
     * test above uses. That is only right when the two bodies are the same size,
     * and here they systematically are not: the obstacles are the bodies that
     * were photographed well (near, large) and the candidates are the ones that
     * were not (far, small). Measured on
     * `reviews/round6/lastdiag3/manifest.json`, `04-combat` -> `DIAG declutter`:
     * of 52 grid cells, **20 were rejected by `avoid` on the first pass and 36 on
     * the second**, which left 6 slots for 15 homeless bodies and then 0 for 10.
     * `avoid` is the filter that empties this grid — not the depth band
     * (`noGround` 14) and not the row de-dup (`dup` 10).
     *
     * `avoidFit` replaces the second `k.half` with the projected half-width of
     * the body that is actually going to stand there: the median radius of the
     * `bad` list, at the middle of the band it will be placed in. It is a
     * correction to an estimate, not a relaxation of a rule — the crowding test
     * it mirrors (`(half + k.half) * 1.15`) is unchanged, and a pass that seats a
     * body too close to another still shows up as a per-object zero in the gate.
     */
    let avoidR = (k) => Math.max(0.05, k.half * 2.3);
    if (avoidFit) {
      const radii = bad.map((e) => e.def?.radius ?? 0.5).sort((a, b) => a - b);
      const rMed = radii[radii.length >> 1] ?? 0.5;
      const hIn = screenHalf(rMed, (minDist + far) * 0.5);
      avoidR = (k) => Math.max(0.05, (k.half + hIn) * 1.15);
    }
    const slots = screenSlots(Math.max(bad.length + 4, supply), {
      minDist, maxDist: far, avoidPlayer: 0.085,
      avoid: kept.map((k) => ({ x: k.x, y: k.y, r: avoidR(k) })),
    });
    const order = nearFirst ? slots.slice().reverse() : slots;
    /* Who gets the slots when there are not enough to go round.
     *
     * `bad` is ordered nearest-first, and that order is *required* by the
     * crowding test above — pairs are resolved in favour of the near body, so
     * it has to be considered first. It was then reused verbatim as the
     * priority for a scarce grid, and there is no reason those two orders
     * should be the same one. Measured on `reviews/round6/cfit1/manifest.json`,
     * `04-combat` -> `DIAG declutter`: pass 1 had 15 homeless bodies and 7
     * slots, and the 7 that got them were simply the 7 nearest. The 8 left over
     * were the far ones — and every one of the shot's four remaining zero-pixel
     * objects was in that leftover list, while bodies that were already
     * rendering hundreds of pixels were re-seated ahead of them.
     *
     * `worstFirst` hands the scarce slots to the bodies contributing least
     * where they stand. It is not the refuted `nearFirst`
     * (`reviews/round6/hdiag6/`), which reversed the *slots* and left this
     * order alone; nothing had previously reordered the candidates.
     *
     * **It is REFUTED anyway — do not re-apply it. It cost three passing
     * shots.** Both scorings were built and captured full:
     *
     *  - Scoring off-frame, `merged` and `d < minDist` all at 0
     *    (`reviews/round6/cfit2/manifest.json`) is a **no-op**: seven bodies
     *    tie on one key, V8's sort is stable, and the partition comes back
     *    byte-identical to not sorting — the same eight `unplaced`, merely
     *    reordered. `04-combat` did not move a pixel.
     *  - Scoring by contribution instead — off-frame 0, `merged` 0.05, else the
     *    visible fraction, so an over-photographed near body ranks last
     *    (`reviews/round6/cfit3/manifest.json`) — **does** work locally and is
     *    not worth it. `04-combat` went 4 failing objects to 3 (object 7, the
     *    charger that has been off frame all round, finally landed at 40 px)
     *    and the capture went from **one failing shot to four**:
     *    `08-explosion` -> `damage numbers`, `10-inventory` -> `monsters
     *    standing in it` (object 3, `sepP50` 0.45 -> 0.21) and `11-bestiary`
     *    -> `the whole spawn roster` (object 12, `sepP50` 0.61 -> 0.19) all
     *    began failing.
     *
     * The displacement is the shared-RNG hazard, and this is the cleanest
     * measurement of it in the repo: `10-inventory`'s equipment blast moved
     * **19,488 -> 57,049 px** on a change that touches only which of
     * `04-combat`'s monsters get re-seated. Re-seating a *different* body
     * changes what the horde does over the following frames, and the enemy AI
     * draws from the same stream every later scenario draws from. `avoidFit`
     * above is safe for exactly the reason this is not: it changes where bodies
     * are placed without changing the set of bodies that move, and its capture
     * moved no other shot by more than one pixel.
     *
     * Kept, off, as `supply` and `nearFirst` are: the lever is sound and the
     * evidence against it is about this scenario's position in the run order,
     * not about the idea.
     */
    const take = worstFirst
      ? bad.slice().sort((a, b) => (need.get(a) ?? 1) - (need.get(b) ?? 1))
      : bad;
    let moved = 0;
    for (let i = 0; i < take.length && i < order.length; i++) {
      _seat(take[i], order[i]);
      seated?.add(take[i]);
      moved++;
    }
    _lastDeclutter.push({
      bad: bad.length, kept: kept.length, asked: Math.max(bad.length + 4, supply),
      slots: slots.length, moved, why: _lastSlots,
      unplaced: take.slice(moved).map((e) => e.def?.id ?? '?'),
    });
    // What was *moved*, not what was found wanting. A pass that reported its
    // whole bad list would keep the loop alive forever on bodies it has no slot
    // for, and would report progress it did not make.
    return moved;
  };

  /**
   * Turn the survivor until the ground in front of him is ground the lens can
   * actually see.
   *
   * `04-combat` had no notion of this and it is most of why the shot was empty.
   * The stage-4 spawn point sits on a plateau; the player's inherited heading
   * faced the drop, the terrain fell 15-28 m within 13 m of him, and every
   * monster the scenario placed was below the lip. Nothing in the scenario asked
   * whether the arena it was about to fill was visible — it only asked whether
   * the spawns projected inside the frustum, which they all did.
   *
   * Frame-locked, not clock-locked: each candidate bearing is committed to the
   * rig and given two rendered frames so the measurement is made against the
   * camera that will actually be used, not against an analytic guess at where
   * the boom would end up.
   */
  /* The bearing search's own acceptance bar — the score at which it stops
   * looking — and the visibility floor every `point()` subject is held to.
   * Named because they are now gates as well as search targets. */
  const OPEN_GROUND_NEED = 0.85;
  const MIN_VISIBLE = 0.6;

  /**
   * Move the survivor onto ground that can hold an arena at all.
   *
   * `faceOpenGround` can only *turn*, and turning cannot fix the place. The
   * stage-1 spawn point this capture lands on is the lip of a rocky knoll:
   * measured on `reviews/round6/base/04-combat.png`, the best of twelve bearings
   * scored 0.44 against the 0.85 the search itself asks for, the near half of
   * the frame is one terrain wedge, and two of the twenty-four monsters
   * `spawnRing` placed came back at world y 1.4 and y -8.2 against a survivor
   * standing at y 16 — 15 and 24 metres down the slope, off the bottom of frame
   * at screen y 1.88 and 1.82, contributing zero pixels each. Every one of the
   * three separate failures that shot carries — the openness gate, the survivor
   * at 0.583 visible behind the near wedge, and the zero-pixel members of the
   * horde — is downstream of standing in the wrong place.
   *
   * So the survivor is walked to a patch of ground that can hold one, before any
   * bearing is chosen. In two stages, because the quantity that is gated can
   * only be measured against a committed camera:
   *
   *  1. `arenaFlatness` ranks candidate stand points off the heightfield alone
   *     — height similarity over a disc, plus `Stage.isWalkable`, which is the
   *     stage's own answer to "slope you can stand on, clear of prop volumes".
   *     Cheap, so it can afford ninety-odd candidates. It is only a shortlist:
   *     on the stage this runs on the best patch it can find scores 0.55 by its
   *     own measure and 0.90 by the one that counts, so treating this number as
   *     the answer would have thrown the right patch away.
   *  2. the shortlist is *tried*: each is committed to the player, given real
   *     frames, and scored by `faceOpenGround` itself — the same function, the
   *     same 0.85 bar, the same camera that gets photographed. The winner is the
   *     one the gate would score highest, not the one a proxy likes.
   *
   * Neither stage can soften the assertion: `openness` is still whatever
   * `faceOpenGround` returned for the spot actually used, and the `open arena`
   * check still fails the shot below 0.85. A stage with no arena on it fails
   * exactly as loudly as before, having tried harder.
   *
   * Stage 1 is a pure heightfield query and draws no `ctx.rng`, so the
   * scenarios after this one see the same random stream they did before.
   */
  const arenaFlatness = ({ probeRings = [9, 15, 21, 27], spokes = 16, flat = 2.5 } = {}) => {
    const stage = ctx.stage;
    if (!stage?.isWalkable) return null;
    const p = playerPos();
    return (x, z) => {
      if (!stage.isWalkable(x, z)) return -1;
      const y0 = groundY(x, z, p.y);
      if (!Number.isFinite(y0)) return -1;
      let ok = 0, n = 0;
      for (const r of probeRings) {
        for (let k = 0; k < spokes; k++) {
          const a = (k / spokes) * Math.PI * 2;
          const gx = x + Math.sin(a) * r, gz = z + Math.cos(a) * r;
          n++;
          // Within a couple of metres of the survivor's own footing, and not
          // inside a boulder. Both together are what "no lip between him and
          // the monster" means on a heightfield.
          if (Math.abs(groundY(gx, gz, y0) - y0) > flat) continue;
          if (!stage.isWalkable(gx, gz)) continue;
          ok++;
        }
      }
      return n ? ok / n : 0;
    };
  };

  /**
   * Members of the horde whose rig is hidden *right now*.
   *
   * Not a statistic — the list itself. `04-combat` photographed a Rift Stalker
   * mid-blink (`Enemy.js:1397` sets `rig.root.visible = false` for the 0.35 s
   * dash and `exit` puts it back), which is the game working and a monster
   * absent from the photograph all the same: measured at 0 px on
   * `reviews/round6/base/04-combat.png`, object 11 of 24.
   *
   * A zero *inside* this would be an empty array, which is the pass condition
   * and the thing the caller waits for; the failure is a non-empty one. There
   * is nothing to average and nothing to hide behind, and any member listed
   * here also fails the per-object pixel gate on the same frame — so this
   * cannot certify while concealing one.
   */
  const hiddenRigs = () => (ctx.director?.enemies ?? [])
    .filter((e) => e?.alive && e.rig?.root?.parent && e.rig.root.visible === false)
    .map((e) => e.def?.id ?? '?');

  /**
   * Hold the shutter until nothing in the horde is invisible.
   *
   * Deliberately a *wait*, not a repair. Forcing `rig.root.visible = true` from
   * here would photograph the frame the scenario wanted and paper over any
   * other way a rig can go invisible — which is exactly the live defect
   * `reviews/round5/DIAG-invisible-enemies.md` §5 describes in `VFX.js`. Waiting
   * cannot: every state that hides a rig on purpose has a timer on it, and an
   * invisibility that has none runs the budget out and still fails the gate.
   *
   * The budget is set by the longest of those timers, not by taste. A Rift
   * Stalker's blink dash is `active: 0.35` s (`enemies.js`), and a burrower is
   * under for `submerge: 2.4` s — 144 frames of simulation at the pinned step,
   * so 90 frames was short enough to time out on a burrower on a live run and
   * fail the shot for it.
   */
  const awaitVisibleHorde = async (maxFrames = 240) => {
    for (let i = 0; i < maxFrames && hiddenRigs().length; i++) await frames(1);
    return hiddenRigs();
  };

  const faceOpenGround = async ({ dists = [13, 20, 27], spread = 0.55, need = OPEN_GROUND_NEED, bearings = 12 } = {}) => {
    const rig = ctx.cameraRig;
    if (!rig) return 1;
    const start = rig.yaw;
    let best = { yaw: start, score: -1 };
    for (let i = 0; i < bearings; i++) {
      // Sweep outward from where the survivor is already facing, so an already
      // good heading is kept and the composition stays the one the shot asked
      // for.
      const yaw = start + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI * 2 / bearings);
      rig.yaw = yaw;
      rig.pitch = -0.12;
      await frames(2);
      camera.updateMatrixWorld(true);
      const p = playerPos();
      let seen = 0, n = 0;
      for (const d of dists) {
        for (const s of [-spread, 0, spread]) {
          const a = yaw + s;
          const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
          const y = groundY(x, z, p.y);
          n++;
          if (Math.abs(y - p.y) > 6) continue;              // over a cliff or up a wall
          if (!onScreen(x, y + 1.0, z, 0.03)) continue;
          if (!seesTarget(camera.position, _cc.set(x, y + 1.0, z), 0.4)) continue;
          seen++;
        }
      }
      const score = seen / n;
      if (score > best.score) best = { yaw, score };
      if (score >= need) break;
    }
    rig.yaw = best.yaw;
    rig.pitch = -0.12;
    await frames(4);
    return best.score;
  };

  /**
   * Stage 2 of the arena search: try the shortlist for real. See
   * `arenaFlatness` above for why there are two stages.
   *
   * Returns the openness the chosen spot actually scored, which is the number
   * the `open arena` assertion reads. Nothing here is allowed to invent one.
   */
  const placeForOpenArena = async ({
    need = OPEN_GROUND_NEED, hops = [0, 14, 24, 34, 46, 60], bearings = 16, tries = 6,
  } = {}) => {
    const flat = arenaFlatness();
    const start = playerPos().clone();
    if (!flat || !ctx.player) return { openness: await faceOpenGround(), moved: false, tried: 0 };

    const seat = (x, z) => {
      const y = groundY(x, z, start.y);
      ctx.player.position.set(x, y, z);
      ctx.player.velocity?.set?.(0, 0, 0);
      if (ctx.player.group) ctx.player.group.position.set(x, y, z);
    };

    // Shortlist. The survivor's own spot is always candidate zero, so an
    // already-good spawn wins on the first try and nothing moves.
    const cand = [{ x: start.x, z: start.z, f: flat(start.x, start.z), d: 0 }];
    for (const r of hops) {
      if (r === 0) continue;
      for (let i = 0; i < bearings; i++) {
        const a = (i / bearings) * Math.PI * 2;
        const x = start.x + Math.sin(a) * r, z = start.z + Math.cos(a) * r;
        const f = flat(x, z);
        if (f >= 0) cand.push({ x, z, f, d: r });
      }
    }
    // The basin centre is flat by construction — `Stage.randomWalkablePoint`'s
    // own fallback says so — so it is always in the pool, or a stage whose every
    // ring sample is a slope would have nowhere to go.
    const cf = flat(0, 0);
    if (cf >= 0) cand.push({ x: 0, z: 0, f: cf, d: Math.hypot(start.x, start.z) });
    // Flattest first, distance as a tie-break only: 0.006 of a point per 10 m
    // keeps the survivor near the stage's own spawn between equals and never
    // outbids a genuinely better patch.
    const shortlist = [cand[0]].concat(
      cand.slice(1).sort((a, b) => (b.f - b.d * 0.0006) - (a.f - a.d * 0.0006)).slice(0, tries - 1));

    let best = null;
    for (const c of shortlist) {
      seat(c.x, c.z);
      await frames(3);
      const score = await faceOpenGround({ need });
      if (!best || score > best.score) best = { ...c, score, yaw: ctx.cameraRig?.yaw ?? 0 };
      if (score >= need) break;
    }
    seat(best.x, best.z);
    if (ctx.cameraRig) { ctx.cameraRig.yaw = best.yaw; ctx.cameraRig.pitch = -0.12; }
    await frames(6);
    return {
      openness: best.score,
      moved: best.d > 0,
      dist: +best.d.toFixed(1),
      flatness: +best.f.toFixed(3),
      tried: shortlist.length,
    };
  };

  /**
   * Turn the boom until the lens can see the survivor himself.
   *
   * `faceOpenGround` asks whether the *arena* is visible, and `04-combat` then
   * spends half a second re-aiming the rig every frame inside `fireBurst` — so
   * the camera that gets photographed is not the camera any of that was
   * measured against. Measured on the frame that failed: the survivor came back
   * at 311 rendered pixels against a floor of 400, behind the near terrain
   * wedge that fills the bottom of the frame, in the shot that exists to judge
   * whether the player is findable under load.
   *
   * Frame-locked like every other search in this file: each candidate is
   * committed to the rig and given two rendered frames, because the boom is a
   * spring and its position is not a closed form of its yaw.
   */
  const clearSurvivorFromLens = async (need = 0.85) => {
    const rig = ctx.cameraRig;
    if (!rig) return 1;
    const y0 = rig.yaw, p0 = rig.pitch;
    const measure = () => {
      camera.updateMatrixWorld(true);
      return visibleFraction(camera.position, playerPos(), {
        height: 1.9, radius: 0.6, cols: 3, rows: 4, slack: 0.3, y0: 0.05, y1: 0.95,
      });
    };
    // A bearing that clears the survivor by jamming the boom into a rock is not
    // a fix. `CameraRig` sphere-casts down its own 7.1 m boom and pulls the
    // lens in when it hits something, so a yaw that buries the camera comes
    // back with a *perfect* visibility score and a survivor filling the left
    // third of the frame at 9,839 px — measured, on the first cut of this
    // search. A shortened boom is therefore a hard reject, not a scoring term.
    const BOOM_MIN = 6.0;                                // of a nominal 7.1
    await frames(1);
    const boom = () => rig.distance ?? BOOM_MIN;
    let best = { yaw: y0, pitch: p0, vis: measure(), boom: boom() };
    let fallback = best;
    const consider = () => {
      const v = measure(), b = boom();
      if (b < BOOM_MIN) {
        if (v > fallback.vis && fallback.boom < BOOM_MIN) fallback = { yaw: rig.yaw, pitch: rig.pitch, vis: v, boom: b };
        return false;
      }
      if (v > best.vis || best.boom < BOOM_MIN) best = { yaw: rig.yaw, pitch: rig.pitch, vis: v, boom: b };
      return best.vis >= need;
    };
    if (best.boom < BOOM_MIN) { fallback = best; best = { ...best, vis: -1 }; }
    let done = best.vis >= need;
    for (const dp of [0, -0.12, 0.12, -0.26]) {
      for (const dy of [0, 0.18, -0.18, 0.36, -0.36, 0.62, -0.62]) {
        if (done) break;
        if (dp === 0 && dy === 0) continue;              // already measured
        rig.yaw = y0 + dy;
        rig.pitch = p0 + dp;
        await frames(2);
        done = consider();
      }
      if (done) break;
    }
    const pick = best.vis >= 0 ? best : fallback;
    rig.yaw = pick.yaw;
    rig.pitch = pick.pitch;
    await frames(3);
    return { vis: +measure().toFixed(3), boom: +boom().toFixed(2) };
  };

  /**
   * Make the player unkillable for the duration of a capture.
   *
   * Combat scenarios drop two dozen enemies at close range, which kills a
   * level-1 survivor in about seven seconds — and a death scrim over the frame
   * makes the shot useless for judging VFX or readability. We want the fight,
   * not the loss, so pin health and hold i-frames open. Combat gates on
   * `_iframeUntil` directly.
   */
  const invulnerable = () => {
    const p = ctx.player;
    if (!p) return;
    p.maxHealth = 1e6;
    p.health = 1e6;
    p._iframeUntil = Infinity;
  };

  /**
   * Stop a menu's 3D portrait on a chosen bearing.
   *
   * The viewers turn continuously off real elapsed time, so a frame-locked
   * shutter still lands on whatever angle this machine's frame rate reached —
   * which on the first capture of `14` was near side-on, the one view that
   * flattens a survivor's shoulder mass. Freezing the spin and setting the
   * angle by hand makes the composition the same on every machine.
   */
  const pinPreview = (preview, angle) => {
    if (!preview) return;
    preview.spin = 0;
    preview.angle = angle;
  };

  // --- aiming ----------------------------------------------------------------

  const SHOULDER = 0.65;   // must match CameraRig.SHOULDER
  const EYE = 1.55;        // must match CameraRig.PIVOT_HEIGHT

  /**
   * Point the orbit rig at a world point.
   *
   * Holding `input.mouse.left` is not enough to put impact feedback in a frame.
   * `Player.fireRay` converges on whatever the crosshair is over, and the rig's
   * resting pitch of -0.12 rad drives that ray into the dirt about 7 m in front
   * of the survivor — so `04-combat` and `05-boss` shipped a held trigger, live
   * tracers, twenty-four monsters, and not one round connecting: no damage
   * number, no hit flash, no impact spark in either of the two shots that exist
   * to judge combat readability.
   *
   * Solved from the boom's pivot rather than from the player's centre: the rig
   * carries a 0.65 m right-shoulder offset, which at 13 m is a man's width of
   * miss. The pivot itself rotates with yaw, so the yaw is refined a few times
   * against its own closed form instead of waiting frames for it to settle.
   */
  const aimRigAt = (t) => {
    const rig = ctx.cameraRig;
    if (!rig) return;
    const p = playerPos();
    let yaw = Math.atan2(t.x - p.x, t.z - p.z);
    let ox = p.x, oz = p.z;
    for (let i = 0; i < 4; i++) {
      ox = p.x + Math.cos(yaw) * SHOULDER;
      oz = p.z - Math.sin(yaw) * SHOULDER;
      yaw = Math.atan2(t.x - ox, t.z - oz);
    }
    rig.yaw = yaw;
    rig.pitch = Math.max(-1.15, Math.min(1.05,
      Math.atan2(t.y - (p.y + EYE), Math.max(1e-3, Math.hypot(t.x - ox, t.z - oz)))));
  };

  /** Centre of mass of an enemy — where a shot should land to read as a hit. */
  const _aimAt = new THREE.Vector3();
  const bodyPoint = (e) => _aimAt.set(
    e.position.x, e.position.y + (e.def?.height ?? 2) * 0.5, e.position.z,
  );

  /**
   * The live enemy closest to where the crosshair already is.
   *
   * Deliberately not "nearest to the player": swinging the lens onto a monster
   * six metres away to make a hit land would rebuild the composition around the
   * wrong subject. Picking the body already near frame centre buys hit feedback
   * for a couple of degrees of camera movement.
   */
  const centreTarget = () => {
    camera.updateMatrixWorld(true);
    let best = null, bestD = Infinity;
    for (const e of ctx.director?.enemies ?? []) {
      if (!e?.alive || !e.position) continue;
      const s = screenOf(e.position.x, e.position.y + 1.0, e.position.z);
      // Under ~16 m from the lens a body is within a few degrees of the
      // survivor's own screen position, so shooting it puts the hit spark and
      // its readout on top of him instead of out in the frame.
      if (s.front < 16 || s.front > 34) continue;
      // Horizontal offset is weighted 3x because it costs *yaw*, and yaw is
      // what rebuilds the composition. A body a little high or low in frame is
      // a couple of degrees of pitch and the shot is unchanged.
      const d = Math.hypot((s.x - 0.5) * 3, s.y - 0.45);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  };

  /**
   * Move a few enemies onto the bearing the crosshair is already on, and hand
   * back the nearest of them.
   *
   * Swinging the lens onto whichever body is nearest the reticle is the other
   * way to make a held trigger connect, and it rebuilds the composition around
   * an accident: with a 24-strong horde fanned across ±46° of a ~100° frame,
   * a 40° swing empties half the shot, and the run that tried it photographed
   * an empty valley. Moving three bodies into the line the shot is already
   * framed on costs nothing, changes no bearing, and puts the impact feedback
   * in the middle of the frame — which is where a shot judging readability
   * under load wants it anyway.
   */
  const stageTargets = (n = 3) => {
    const p = playerPos();
    const yaw = ctx.cameraRig ? ctx.cameraRig.yaw : Math.atan2(forward().x, forward().z);
    const list = (ctx.director?.enemies ?? []).filter((e) => e?.alive && e.position);
    // Nearest first: pulling the back rank forward would leave a hole where the
    // depth of the horde used to be.
    list.sort((a, b) => a.position.distanceToSquared(p) - b.position.distanceToSquared(p));
    // Screen-space again, and for the same reason: a world-space offset from the
    // player lands wherever the terrain happens to be, and the terrain in front
    // of the survivor is as often a drop as a floor.
    camera.updateMatrixWorld(true);
    const marks = [];
    for (let i = 0; i < n; i++) {
      const sx = 0.5 + (i - (n - 1) / 2) * 0.07;
      let g = null;
      for (const sy of [0.50, 0.46, 0.54, 0.42, 0.58]) {
        g = groundAtScreen(sx, sy, { minDist: 15, maxDist: 34 });
        if (g) break;
      }
      marks.push(g);
    }
    let first = null;
    for (let i = 0; i < n && i < list.length; i++) {
      const e = list[i];
      const g = marks[i];
      if (!g) continue;
      _seat(e, g);
      first = first ?? e;
    }
    if (first) return first;
    // Nothing on the centre line could hold a body. Take whatever is already
    // closest to the crosshair rather than teleporting one somewhere invisible.
    void yaw;
    return centreTarget() ?? list[0] ?? null;
  };

  /**
   * Hold the trigger on a body for `seconds` of simulation time, re-acquiring
   * each frame so a kill (or the recoil climb) does not leave the rest of the
   * burst in the sky. Resolves with the frame still live; the caller freezes.
   *
   * `fire: false` keeps the aim and the pin but releases the trigger — the tail
   * a shot needs when its subject must not be photographed mid hit-flash.
   */
  const fireBurst = async (seconds, { pin = null, at = null, fire = true } = {}) => {
    if (ctx.input) ctx.input.mouse.left = fire;
    const t0 = ctx.time ?? 0;
    for (let i = 0; i < 900 && (ctx.time ?? 0) - t0 < seconds; i++) {
      if (pin && at) {
        pin.position.copy(at);
        pin.velocity?.set?.(0, 0, 0);
      }
      const t = pin ?? centreTarget();
      if (t?.alive) aimRigAt(bodyPoint(t));
      await frames(1);
    }
  };

  /**
   * Wait `s` seconds of *simulation* time — the clock gameplay runs on.
   *
   * Correct for anything gated on `ctx.time` (cooldowns, spawn pops, the
   * difficulty curve) and **wrong for anything visual**, which is what it was
   * being used for. See `waitFx`.
   */
  const waitSim = async (s, maxFrames = 900) => {
    const t0 = ctx.time ?? 0;
    for (let i = 0; i < maxFrames && (ctx.time ?? 0) - t0 < s; i++) await frames(1);
    return (ctx.time ?? 0) - t0;
  };

  /**
   * Wait `s` seconds of *presentation* time and report exactly how much was
   * bought — the clock every VFX lifetime is written against.
   *
   * This is the unit `08-explosion` and `10-inventory` always meant and never
   * had. Both budgeted their shutter in simulation seconds while the effect
   * they were photographing aged in wall seconds, and hitstop — which the
   * blast's own kills raise — drives a load-dependent wedge between the two.
   * Measured on the shipped build: `08-explosion` asked for 0.09 s and
   * photographed the blast at 0.207 s of its own life, and `10-inventory`'s
   * asked-for 0.12 s landed somewhere different on every run, which is why its
   * blast check failed at 294 px once and passed the next time.
   *
   * With the capture clock pinned this is exact: one rendered frame is one
   * `frameDt()`, so the age is a frame count and a constant. Unpinned it falls
   * back to counting frames at the nominal rate, which is approximate — and
   * says so in the number it returns.
   */
  const waitFx = async (s) => {
    const dt = frameDt();
    const n = Math.max(1, Math.round(s / dt));
    const t0 = ctx.time ?? 0;
    /* Hitstop is held off for the duration of the shutter window, and this is
     * the one place in the file that reaches into a gameplay value to get a
     * shot.
     *
     * The justification is that hitstop is a *feel* mechanic that a still frame
     * cannot show and can only be damaged by. It scales the fixed step to 0.15
     * for up to 0.12 s of banked credit, which does three measurable things to
     * a photograph of a blast, all of them wrong:
     *
     *  1. it re-opens the gap between simulation and presentation time that
     *     `waitFx` exists to close, so the sim-timed parts of the effect
     *     (spawn pops, scheduled detonations) land at a different frame of the
     *     window depending on how many monsters the blast happened to kill;
     *  2. it stretches `Enemy`'s 0.075 s hit-flash — which is *simulation*
     *     time, `Enemy.js:441` decrements it in `fixedUpdate` — to as much as
     *     0.5 s of wall time, so every monster in the blast photographs as a
     *     flat white cutout with no silhouette. Measured directly: at a 0.14 s
     *     effect age with hitstop live, all seven victims photograph as flat
     *     white cutouts;
     *  3. and it is the residual that kept `10-inventory`'s blast measurement
     *     swinging between runs after the clock was pinned.
     *
     * Everything else about the frame is untouched: the same damage, the same
     * kills, the same particles, at the same ages. Only the rate at which
     * gameplay time is allowed to run during the ~7-12 frames of the shutter.
     */
    for (let i = 0; i < n; i++) {
      ctx.hitstop = 0;
      await frames(1);
    }
    ctx.hitstop = 0;
    return {
      age: +(n * dt).toFixed(4),
      frames: n,
      exact: _pinnedDt > 0,
      // Published so the two clocks can be seen agreeing. If these ever drift
      // apart again, something is scaling the fixed step.
      sim: +((ctx.time ?? 0) - t0).toFixed(4),
    };
  };

  /** Does the sun actually reach this point, or is the subject sitting in a pit? */
  const sunlit = (pos, lift = 1.2) => {
    const s = ctx.environment?.sunDir;
    if (!s) return true;
    _probe.set(pos.x, pos.y + lift, pos.z).addScaledVector(s, 0.5);
    const hit = ctx.stage?.raycastDistance?.(_probe, s, 200);
    return !(typeof hit === 'number' && hit >= 0);
  };

  /**
   * Fraction of the frame's lower half that a candidate camera would spend on
   * terrain closer than `near` metres.
   *
   * `clearCam` only ever asked whether the *subject* was visible and whether it
   * had depth behind it. Nothing tested what the near half of the frustum
   * contained, so a low lens on a slope shipped a quarter of `07` as one
   * featureless purple wedge — and narrowing the lens to crop it only made the
   * slope fill more of the narrower field.
   */
  const _fgR = new THREE.Vector3();
  const _fgU = new THREE.Vector3();
  const _fgD = new THREE.Vector3();
  const _fgRay = new THREE.Vector3();
  const _fgUp = new THREE.Vector3(0, 1, 0);
  const foregroundLoad = (pos, target, fovDeg, aspect, near, {
    cols = 4, rows = 3, x0 = -0.85, x1 = 0.85, y0 = -0.30, y1 = -0.90,
  } = {}) => {
    _fgD.subVectors(target, pos);
    if (_fgD.lengthSq() < 1e-6) return 0;
    _fgD.normalize();
    _fgR.crossVectors(_fgD, _fgUp);
    if (_fgR.lengthSq() < 1e-6) return 0;
    _fgR.normalize();
    _fgU.crossVectors(_fgR, _fgD).normalize();
    const ty = Math.tan(fovDeg * 0.5 * Math.PI / 180), tx = ty * aspect;
    let hit = 0, n = 0;
    for (let iy = 0; iy < rows; iy++) {
      const sy = rows === 1 ? y0 : y0 + (y1 - y0) * (iy / (rows - 1));
      for (let ix = 0; ix < cols; ix++) {
        const sx = cols === 1 ? 0 : x0 + (x1 - x0) * (ix / (cols - 1));
        _fgRay.copy(_fgD).addScaledVector(_fgR, sx * tx).addScaledVector(_fgU, sy * ty).normalize();
        const d = ctx.stage?.raycastDistance?.(pos, _fgRay, near);
        n++;
        if (typeof d === 'number' && d >= 0) hit++;
      }
    }
    return hit / n;
  };

  /**
   * Fraction of the *whole* frame filled by something closer than `near`.
   *
   * `foregroundLoad` only ever sampled the lower half, because the defect it was
   * written for was a wedge of near slope under the subject. The defect that
   * followed it was a tree trunk: `11-bestiary` shipped with a ~350 px black
   * column through the middle of the roster it exists to photograph and
   * `12-boss-phases` came back 53% near-black, and a lower-half probe cannot see
   * either of them because a trunk runs the full height of the frame.
   */
  const frameOccluders = (pos, target, fovDeg, aspect, near) =>
    foregroundLoad(pos, target, fovDeg, aspect, near,
                   { cols: 7, rows: 5, x0: -0.9, x1: 0.9, y0: 0.85, y1: -0.85 });

  /**
   * Fraction of a subject's projected bounding box the lens can actually see.
   *
   * The predecessor of this cast one ray at the subject's centre point (or, at
   * best, three up its centre line), which is how `11-bestiary` and
   * `12-boss-phases` passed their occlusion check with a tree trunk over a third
   * of the composition: the trunk missed the middle. A subject is a *box*, so
   * the test samples the box — `cols` lateral offsets across its width at `rows`
   * heights up it, all in the plane perpendicular to the view direction — and
   * the caller asks for a minimum fraction rather than for one lucky ray.
   */
  const _vfR = new THREE.Vector3();
  const _vfP = new THREE.Vector3();
  const visibleFraction = (from, base, {
    height = 2.2, radius = 1.0, cols = 5, rows = 4, slack = 0.4,
    // The band of the subject's height that is sampled. The default skips the
    // ankles and the crown, which is right for "is this monster in shot" and
    // wrong for anything being judged on ground contact — a boulder across a
    // survivor's shins scores 1.00 under the default. `09-survivors` asks for
    // the whole figure.
    y0 = 0.08, y1 = 0.92,
  } = {}) => {
    _vfR.set(base.x - from.x, 0, base.z - from.z);
    if (_vfR.lengthSq() < 1e-6) return 0;
    _vfR.normalize().cross(_fgUp).normalize();
    let seen = 0, n = 0;
    for (let r = 0; r < rows; r++) {
      const fy = rows === 1 ? (y0 + y1) * 0.5 : y0 + (r / (rows - 1)) * (y1 - y0);
      for (let c = 0; c < cols; c++) {
        const fx = cols === 1 ? 0 : -1 + (c / (cols - 1)) * 2;
        _vfP.set(base.x + _vfR.x * fx * radius, base.y + fy * height, base.z + _vfR.z * fx * radius);
        n++;
        if (seesTarget(from, _vfP, slack)) seen++;
      }
    }
    return n ? seen / n : 0;
  };

  /**
   * The world point where the ray through screen position (sx, sy) first meets
   * the ground.
   *
   * This is the primitive `04-combat` needed and did not have. `spawnRing` chose
   * spawns in *world* space — a bearing off camera forward at a chosen radius,
   * dropped onto `sampleHeight` — and then checked only that the result
   * projected inside the frame. On the stage-4 spawn plateau the ground falls
   * 15-28 m within 13 m of the player, so all twenty-four monsters landed at the
   * bottom of a cliff: correctly inside the frustum, and every one of them
   * behind the terrain lip 5-7 m from the lens. Measured on the shipped frame,
   * 23 of the 24 contributed exactly zero pixels.
   *
   * Marching out along a screen ray inverts the problem. The returned point is
   * the *first* thing that ray hits, so anything stood on it is on screen and
   * unoccluded by terrain or props by construction, with no test needed.
   *
   * Returns null for sky, for a hit outside [minDist, maxDist], and for a hit
   * that is not the heightfield — landing a monster on a branch is its own kind
   * of wrong screenshot, and the prop hit is detected by comparing the hit's
   * height against the terrain underneath it.
   */
  const _gsDir = new THREE.Vector3();
  const _gsP = new THREE.Vector3();
  const groundAtScreen = (sx, sy, { minDist = 6, maxDist = 90, propSlack = 1.5 } = {}) => {
    camera.updateMatrixWorld(true);
    _gsP.set(sx * 2 - 1, 1 - sy * 2, 0.5).unproject(camera);
    _gsDir.subVectors(_gsP, camera.position);
    if (_gsDir.lengthSq() < 1e-9) return null;
    _gsDir.normalize();
    const d = ctx.stage?.raycastDistance?.(camera.position, _gsDir, maxDist);
    if (typeof d !== 'number' || d < minDist) return null;
    _gsP.copy(camera.position).addScaledVector(_gsDir, d);
    const g = ctx.stage?.sampleHeight?.(_gsP.x, _gsP.z);
    if (!Number.isFinite(g) || Math.abs(g - _gsP.y) > propSlack) return null;  // hit a prop, not the floor
    return new THREE.Vector3(_gsP.x, g, _gsP.z);
  };

  /* ---------------------------------------------------------------------
   * Subject presence.
   *
   * The reason this file exists is in its header: "prefer failing loudly here
   * over producing a plausible-looking wrong screenshot". It did not fail
   * loudly. `04-combat` shipped with all twenty-four of its monsters behind a
   * terrain lip and `05-boss` shipped a full STONE TITAN health bar over an
   * empty forest, and the manifest reported `ready: true`, `errorCount: 0`,
   * `frameErrors: 0` for both — which five separate agents then cited as proof
   * their work had been verified.
   *
   * So every scenario now declares what has to be in its frame, and the claim
   * is settled against the *rendered pixels*, not against `director.enemies
   * .length`. An entity count would have passed all twenty-four of those
   * monsters: they were spawned, alive, in the scene, `visible`, positioned,
   * and projected inside the frustum. Only the pixels disagreed.
   * ------------------------------------------------------------------- */

  const subjects = {};
  ctx.harness = { subjects };

  // Small on purpose. A quarter-size mask is two extra scene renders per shot
  // and still resolves a 2 m monster at 30 m to ~16 px of height; the numbers
  // below are thresholds on a 480x270 buffer, not on the 1600x900 PNG.
  const MASK_W = 480, MASK_H = 270, MASK_PX = MASK_W * MASK_H;
  let _maskRT = null, _maskA = null, _maskB = null;

  /**
   * Pixels in the composed frame that `objects` are responsible for.
   *
   * Render the scene, hide the subject, render again, diff. What survives the
   * diff is exactly the subject's contribution *after* occlusion, depth,
   * culling, materials and fog — every way a subject can be present in the
   * simulation and absent from the photograph.
   *
   * Two details that matter:
   *  - the shadow map is pinned for the pair, or a subject removed from the
   *    frame takes its own shadow with it and the shadow is counted as subject;
   *  - both passes go to an offscreen target, so the canvas keeps presenting
   *    the frame the scenario composed and the screenshot is unaffected.
   */
  const maskPass = (r, hide) => {
    const was = hide ? hide.map((o) => o.visible) : null;
    if (hide) for (const o of hide) o.visible = false;
    r.render(ctx.scene, camera);
    if (hide) hide.forEach((o, i) => { o.visible = was[i]; });
  };

  /**
   * Near-transparent overlays are not subject material.
   *
   * The mask counts a pixel as the subject's when the two renders differ by more
   * than 6 levels of summed channel distance, and that test is opacity-blind. A
   * deliberately near-invisible wash passes it everywhere it is drawn: the
   * warden's barrier (`wardMat`, opacity 0.05, additive) moves every pixel it
   * covers by d ~= 31, so all 3,329 px of it enter the mask — and each one
   * carries a separation bounded by its own alpha (~0.08 over its own backdrop,
   * ~0.23 over near-black). The wash therefore outvotes the monster inside it and
   * drags `11-bestiary` object 13 to `sepP50 0.17` while the monster reads
   * `legible 0.515`. No art change can lift it, because the number it produces is
   * a property of the opacity the art deliberately chose.
   *
   * So the mask stops asking "did this pixel move" and starts asking "did
   * anything a viewer can see put it there". A mesh whose material is transparent
   * below `VEIL_OPACITY` is a veil: hidden in *both* renders of the pair, so it
   * neither contributes pixels of its own nor tints the backdrop the subject is
   * measured against. Hiding it on only one side would be worse than counting it.
   *
   * The threshold is set against **live** opacity ranges, not against authored
   * literals, because that is what `_isVeil` reads. An audit of construction
   * sites alone would have missed the ward dome, which is built at 0.14
   * (`src/entities/Placeables.js:211`) and then animated every frame to
   * `0.10 + (1 - phase) * 0.10` (`Placeables.js:407`) — so it breathes across
   * 0.10-0.20 and spends part of every pulse below any ceiling of 0.12. The dome
   * is a gameplay-readable shape with solid siblings on its rig, so a 0.12
   * threshold would not merely have counted it, it would have *hidden* it,
   * flickering in and out of the mask on the pulse. No current shot stages it,
   * which is precisely why the number has to be argued rather than measured.
   *
   * So: 0.08, with a clear gap on both sides of every *steady* live range — the
   * warden's wash sits at a constant 0.05 below it, the dome's animated minimum
   * at 0.10 above it, and the wireframe that actually says "barrier" at 0.85.
   * Three transient fades do pass through (0.05, 0.08) live — shockwave rings
   * (`Director.js:1225`) and trails (`Director.js:1348`), both parentless in the
   * scene so the solid-company rule below refuses to hide them, and the arena
   * dust plane (`RealmArena.js:846`), a monotonic fade-to-invisible, which is
   * the intended case: a material genuinely fading out leaves the mask exactly
   * when it stops being visible. The bug class this ceiling guards against is
   * *periodic oscillation* through the threshold, like the dome's pulse; raising
   * it means re-auditing what animates opacity, not what declares it.
   *
   * Refused for a veil that is the whole of what it hangs on: an object with no
   * other material is *made* of its veil, and blanking it would report the
   * subject missing rather than the subject faint. Only a veil with visible
   * company is dropped.
   */
  const VEIL_OPACITY = 0.08;
  const _isVeil = (m) => m && m.transparent === true && m.opacity < VEIL_OPACITY;
  const _matsOf = (o) => (Array.isArray(o.material) ? o.material : [o.material]);
  const _hideVeils = () => {
    const hidden = [];
    ctx.scene.traverse((o) => {
      if (!o.visible || !o.material) return;
      if (!_matsOf(o).every(_isVeil)) return;
      // Does anything else on the same rig still draw? Walk up a bounded number
      // of ancestors — never as far as the scene, where "something else draws"
      // is true of every frame and would mean nothing.
      let solid = false;
      let p = o.parent;
      for (let up = 0; up < 3 && p && p !== ctx.scene && !solid; up++, p = p.parent) {
        p.traverse((q) => {
          if (solid || !q.visible || !q.material) return;
          // Company must be outside o's own subtree: a solid child of the veil
          // both authorizes hiding it and would be hidden along with it, which
          // is exactly the case this walk exists to refuse.
          if (q === o || o.getObjectById(q.id)) return;
          if (!_matsOf(q).every(_isVeil)) solid = true;
        });
      }
      if (!solid) return;
      o.visible = false;
      hidden.push(o);
    });
    return hidden;
  };
  const _showVeils = (hidden) => { for (const o of hidden ?? []) o.visible = true; };

  /**
   * Retarget every soft-particle depth lookup at the buffer we are about to
   * render into. **This is what made `08-explosion`'s blast gate stop observing
   * the blast**, and it would have done the same to any future effect subject.
   *
   * The soft-particle fade in `ParticleShader` and in VFX's `RingFrag` reads the
   * scene depth at `gl_FragCoord.xy / uResolution`, and `uResolution` is set —
   * correctly, for the real frame — to the *drawing buffer* size, 1600x900.
   * These mask renders go to a 480x270 offscreen target, so every fragment's
   * `gl_FragCoord` lands in the bottom-left 30% x 30% of that division: the
   * whole effect is faded against the depth of the bottom-left corner of the
   * frame instead of against what is behind it. Where that corner holds near
   * foreground — which is most third-person framings — `(vViewZ - sceneZ)`
   * goes negative, alpha clamps to 0 and the fragment is `discard`ed.
   *
   * Measured on `reviews/round6/hdiag/manifest.json`, the frozen `08-explosion`
   * frame with a 6 m fireball 11.2 m from the lens and nothing between them
   * (`DIAG blast` -> `occluders: []`): `vfx.particles` 619 px and `vfx.rings`
   * **0 px**, against 19,323 and 23,977 for the same code and the same effect on
   * a frame whose bottom-left corner is sky
   * (`reviews/round6/hdiag-only/manifest.json`). The gate was reading the depth
   * of a corner of the frame, which is why it sat bit-identical at 640 px across
   * five captures spanning a `screenSlots` rewrite, a 45-name rename and a set
   * of VFX fixes: none of those change that corner.
   *
   * The correction is exact rather than an approximation. `uDepth` is a
   * *full-frame* depth texture (half canvas resolution, same camera, same
   * frustum) and the shader's division is only there to turn `gl_FragCoord` into
   * a [0,1] frame UV. Setting `uResolution` to the target being rendered
   * restores that identity, so the fade fades against the same surfaces it does
   * in the photograph. Nothing is disabled and no threshold moves.
   *
   * Collected by traversing the scene for materials that declare *both*
   * uniforms, rather than by naming `ctx.vfx.particles` and `ctx.vfx.rings`: a
   * pool added later inherits the fix instead of silently inheriting the bug.
   */
  const _pinSoftResolution = (w, h) => {
    const saved = [];
    const take = (m) => {
      const u = m?.uniforms;
      if (!u || !u.uDepth || !u.uResolution?.value?.isVector2) return;
      saved.push([u.uResolution, u.uResolution.value.x, u.uResolution.value.y]);
      u.uResolution.value.set(w, h);
    };
    ctx.scene.traverse((o) => {
      if (!o.material) return;
      if (Array.isArray(o.material)) o.material.forEach(take); else take(o.material);
    });
    return saved;
  };
  const _restoreSoftResolution = (saved) => {
    for (const [u, x, y] of saved) u.value.set(x, y);
  };

  /**
   * `region`, and why a pixel count needs one.
   *
   * A subject named by *shared buffers* — the VFX pools — is not a subject. The
   * pools carry every effect alive in the frame: muzzle flashes, tracer trails,
   * hit sparks, another monster's death embers. Counting their whole
   * contribution and calling it "the blast" measures the frame's VFX budget, not
   * the event the shot exists to photograph, and the two move independently.
   *
   * A region is a disc in screen space, in frame-width fractions with the aspect
   * divided out (the same metric `screenGap` uses), and only pixels inside it are
   * counted. Given to a subject whose *world position and size are known* — which
   * is exactly the blast's case — it turns "some VFX somewhere" into "this
   * effect, here". It is strictly subtractive: no pixel that failed to be counted
   * before can start being counted because of it.
   */
  const _inRegion = (region, i) => {
    if (!region) return true;
    const x = (i % MASK_W + 0.5) / MASK_W;
    // `readRenderTargetPixels` hands back rows bottom-up; `screenOf` is top-down.
    const y = 1 - (((i / MASK_W) | 0) + 0.5) / MASK_H;
    const a = camera.aspect || (16 / 9);
    return Math.hypot(x - region.x, (y - region.y) / a) <= region.r;
  };

  /* Per-object statistics from the most recent `perObject` report, for a
   * scenario that wants to publish *why* one of its objects failed. Cleared at
   * the top of every report, so a `detail()` that reads it after a check which
   * was not per-object gets `null` rather than the previous subject's numbers. */
  let _lastPerObject = null;
  const lastPerObject = () => _lastPerObject;

  const subjectReport = (objects, { perObject = false, aggregate = false, region = null } = {}) => {
    const r = ctx.pipeline?.renderer;
    const objs = (objects ?? []).filter((o) => o && o.parent);
    // A subject made of more than one object is measured per object whether or
    // not it remembered to ask. Forgetting the flag was itself a way to hide a
    // missing object inside a sum, and the flag costs one extra mask render per
    // object — cheaper than the class of bug it was concealing. The only
    // exception is a subject that has declared itself aggregate (see
    // `minCarriedPx`), where the individual meshes are shared VFX buffers and
    // not things a viewer can name.
    if (!aggregate && objs.length > 1) perObject = true;
    if (!r || !objs.length) {
      return {
        px: 0, frac: 0, lum: 0, bgLum: 0, contrast: 0,
        sep: 0, sepP25: 0, sepP50: 0, legible: 0,
        objects: objs.length, visibleObjects: 0,
      };
    }
    if (!_maskRT) {
      _maskRT = new THREE.WebGLRenderTarget(MASK_W, MASK_H);
      _maskA = new Uint8Array(MASK_PX * 4);
      _maskB = new Uint8Array(MASK_PX * 4);
    }
    const prevRT = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(_maskRT);
    camera.updateMatrixWorld(true);
    const softSaved = _pinSoftResolution(MASK_W, MASK_H);
    /* Restored through `finally`, unlike the two saves above it, because this
     * one leaks *into the photograph*. A throw mid-measurement leaves the render
     * target and the shadow flag wrong for the next report, which the next report
     * sets again; it would leave the veils `visible = false` for the rest of the
     * page load, so every later shot would be composed with the warden's barrier
     * simply gone. `_hideVeils()` itself now runs inside this same try, since a
     * throw during hiding would otherwise skip the finally that undoes it. The
     * body below keeps its original indentation on purpose — the `try` guards
     * the block, and re-indenting 140 lines to announce that would bury the
     * change it is guarding.
     */
    let veiled = null;
    try {

    veiled = _hideVeils();
    maskPass(r, null);
    r.readRenderTargetPixels(_maskRT, 0, 0, MASK_W, MASK_H, _maskA);

    /* Separation: how far each of the subject's own pixels stands off the
     * pixel that would be there without it.
     *
     * The aggregate `contrast` below is a *signed mean* — `|Σls − Σlb| / Σ(ls
     * + lb)` — and that is the defect this exists to close. A subject that is
     * bright down one side and dark down the other cancels itself to nearly
     * zero, and a subject whose mean simply happens to match its background
     * reads as zero however sharply each individual pixel differs. Both come
     * back as "no contrast" whether the subject is invisible or merely
     * balanced, and neither was ever gated: the only gate on a pixel check was
     * `minPx`, so `04-combat` recorded the survivor at `contrast: 0.053` —
     * darker than his own background, the dimmest object in his own combat
     * frame — and wrote `ok: true`.
     *
     * Per-pixel Michelson cannot cancel. `+8` is a black floor so two pixels
     * six levels apart in near-darkness do not read as full contrast; it is
     * the same guard the 0-255 space needs anywhere a ratio is taken.
     */
    const SEP_BINS = 50;
    const SEP_MIN = 0.15;      // a pixel that carries its own edge
    const hist = new Int32Array(SEP_BINS);
    // Exact 8-bit luminance histograms of subject and background over the same
    // mask, so a median can be taken beside the mean. `lum`/`bgLum` are means and
    // a mean cannot tell a uniformly dim subject from a dark one carrying a small
    // blown core — which is the difference between "restage it" and "relight it".
    const lumH = new Int32Array(256), bgH = new Int32Array(256);
    const count = (buf, stats = false) => {
      let n = 0, ls = 0, lb = 0, sep = 0, carried = 0;
      // Where the counted pixels are, in frame fractions. A count alone cannot
      // tell "the effect rendered small" from "the effect did not render and
      // something else in the same buffer did"; a centroid and a box can.
      let sx = 0, sy = 0, x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      if (stats) { hist.fill(0); lumH.fill(0); bgH.fill(0); }
      for (let i = 0; i < MASK_PX; i++) {
        const j = i * 4;
        const d = Math.abs(_maskA[j] - buf[j])
          + Math.abs(_maskA[j + 1] - buf[j + 1])
          + Math.abs(_maskA[j + 2] - buf[j + 2]);
        if (d <= 6) continue;
        if (!_inRegion(region, i)) continue;
        n++;
        const a = 0.2126 * _maskA[j] + 0.7152 * _maskA[j + 1] + 0.0722 * _maskA[j + 2];
        const b = 0.2126 * buf[j] + 0.7152 * buf[j + 1] + 0.0722 * buf[j + 2];
        ls += a;
        lb += b;
        if (!stats) continue;
        const fx = (i % MASK_W + 0.5) / MASK_W;
        const fy = 1 - (((i / MASK_W) | 0) + 0.5) / MASK_H;
        sx += fx; sy += fy;
        if (fx < x0) x0 = fx; if (fx > x1) x1 = fx;
        if (fy < y0) y0 = fy; if (fy > y1) y1 = fy;
        const c = Math.abs(a - b) / (a + b + 8);
        sep += c;
        if (c >= SEP_MIN) carried++;
        hist[Math.min(SEP_BINS - 1, (c * SEP_BINS) | 0)]++;
        lumH[Math.min(255, a | 0)]++;
        bgH[Math.min(255, b | 0)]++;
      }
      if (!stats) return { n, ls, lb };
      // Percentiles off the histogram rather than a sorted array: this runs
      // over 129,600 pixels per subject per shot and must not allocate.
      const at = (p) => {
        let want = n * p, acc = 0;
        for (let i = 0; i < SEP_BINS; i++) {
          acc += hist[i];
          if (acc >= want) return +((i + 0.5) / SEP_BINS).toFixed(3);
        }
        return 1;
      };
      const med = (h) => {
        let acc = 0;
        for (let i = 0; i < 256; i++) { acc += h[i]; if (acc * 2 >= n) return i; }
        return 255;
      };
      return {
        n, ls, lb,
        lumP50: n ? med(lumH) : 0, bgLumP50: n ? med(bgH) : 0,
        sep: n ? +(sep / n).toFixed(3) : 0,
        sepP25: n ? at(0.25) : 0,
        sepP50: n ? at(0.50) : 0,
        legible: n ? +(carried / n).toFixed(3) : 0,
        at: n ? [+(sx / n).toFixed(3), +(sy / n).toFixed(3)] : null,
        box: n ? [+x0.toFixed(3), +y0.toFixed(3), +x1.toFixed(3), +y1.toFixed(3)] : null,
      };
    };

    maskPass(r, objs);
    r.readRenderTargetPixels(_maskRT, 0, 0, MASK_W, MASK_H, _maskB);
    const all = count(_maskB, true);

    /* Per object, and with the same statistics as the union.
     *
     * The union numbers above cannot answer the question the gate has to ask.
     * `23-realm-crucible` certified a three-monster wave at `perPx: [141, 0,
     * 299]` — one member of the wave contributing *literally nothing* to the
     * photograph — because 440 px of sum cleared a 420 px floor and the median
     * separation was taken over the two monsters that did render. An absent
     * object inside a subject is the same defect as an absent subject inside a
     * shot, one level down, and it needs the same answer: measure each one.
     */
    let visibleObjects = objs.length;
    let perPx = null, perSep = null;
    _lastPerObject = null;
    if (perObject) {
      perPx = [];
      perSep = [];
      const full = [];
      visibleObjects = 0;
      for (const o of objs) {
        maskPass(r, [o]);
        r.readRenderTargetPixels(_maskRT, 0, 0, MASK_W, MASK_H, _maskB);
        const c = count(_maskB, true);
        perPx.push(c.n);
        perSep.push(c.n ? c.sepP50 : 0);
        /* The whole statistic set per object, not just the two the gate reads.
         *
         * `perPx`/`perSep` say *that* an object failed; they cannot say why, and
         * the two questions have opposite fixes — an object at 0 px is somewhere
         * else, an object at 1,287 px and `sepP50 0.15` is exactly where it
         * should be and the same value as what is behind it. Stashed rather than
         * published on every check because a 24-object horde would add 24 objects
         * of noise to every manifest; a scenario that wants it says so with a
         * `detail: () => lastPerObject()` spec. See `04-combat`'s `DIAG horde`.
         */
        full.push(c.n ? {
          px: c.n, sep: c.sep, sepP25: c.sepP25, sepP50: c.sepP50, legible: c.legible,
          lum: +(c.ls / c.n).toFixed(1), bgLum: +(c.lb / c.n).toFixed(1),
          lumP50: c.lumP50, bgLumP50: c.bgLumP50,
          at: c.at, box: c.box,
        } : { px: 0 });
        if (c.n >= 12) visibleObjects++;  // ~4x3 px: smaller than that is noise
      }
      _lastPerObject = full;
    }

    _restoreSoftResolution(softSaved);
    r.setRenderTarget(prevRT);
    r.shadowMap.autoUpdate = prevShadow;

    return {
      px: all.n,
      frac: +(all.n / MASK_PX).toFixed(5),
      // Linear-space means; the mask renders bypass the composer's tonemap, so
      // these are for contrast ratios, not for grading against the PNG.
      lum: all.n ? +(all.ls / all.n).toFixed(1) : 0,
      bgLum: all.n ? +(all.lb / all.n).toFixed(1) : 0,
      contrast: all.n ? +(Math.abs(all.ls - all.lb) / Math.max(1, all.ls + all.lb)).toFixed(3) : 0,
      // Legibility, per pixel and uncancellable. `sepP50` is what the
      // `minSeparation` gate reads; the rest is there so a reviewer can see the
      // shape of the distribution rather than one number.
      sep: all.sep, sepP25: all.sepP25, sepP50: all.sepP50, legible: all.legible,
      // Where the mask landed, so a reader can see whether the pixels counted
      // are where the subject is.
      at: all.at, box: all.box,
      region: region ? [region.x, region.y, +region.r.toFixed(4)] : undefined,
      objects: objs.length,
      visibleObjects,
      // Published, not just gated on. A reviewer reading the manifest has to be
      // able to see the zero for himself.
      perPx: perPx && perPx.length <= 64 ? perPx : undefined,
      perSep: perSep && perSep.length <= 64 ? perSep : undefined,
    };

    } finally { _showVeils(veiled); }
  };

  /**
   * Fraction of the frame that is open sky.
   *
   * `02-vista` and the four biome frames are documented as judging "terrain,
   * lighting, fog, sky", and a lens buried in a hillside satisfies every
   * subject test in this file while containing none of those four.
   */
  const _skyT = new THREE.Vector3();
  const skyFraction = (opts = {}) => {
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(_skyT);
    _skyT.multiplyScalar(30).add(camera.position);
    return 1 - foregroundLoad(camera.position, _skyT, camera.fov, camera.aspect || (16 / 9), 500,
                              { cols: 7, rows: 4, x0: -0.9, x1: 0.9, y0: 0.95, y1: 0.15, ...opts });
  };

  /**
   * Fraction of the *whole* frame that is either sky or something further away
   * than `near`.
   *
   * The sky test is the wrong question for half the biomes: stage 3 is a
   * flooded canyon and stage 4 is a cavern, and both are meant to have little
   * or no sky in them — asking for it failed two correctly-framed establishing
   * shots. What every establishing frame does need is *depth*: a long sight
   * line somewhere in it, rather than a lens pressed against a wall.
   */
  const openDepth = (near = 60) => {
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(_skyT);
    _skyT.multiplyScalar(30).add(camera.position);
    return 1 - foregroundLoad(camera.position, _skyT, camera.fov, camera.aspect || (16 / 9), near,
                              { cols: 7, rows: 5, x0: -0.9, x1: 0.9, y0: 0.9, y1: -0.9 });
  };

  /**
   * The VFX systems' persistent scene meshes, by name.
   *
   * `08-explosion` has no entity to hide — the fireball is a handful of
   * long-lived particle/ring/trail buffers that every effect in the game draws
   * into. Hiding them for the mask pass is still exact: at the shutter the only
   * thing in those buffers is the blast the scenario just fired.
   */
  const vfxObjects = (re) => ctx.scene.children.filter((o) => o.name && re.test(o.name));

  /** Rig roots for a list of entities, skipping anything already despawned. */
  const rigsOf = (list) => (list ?? [])
    .filter((e) => e && e.rig && e.rig.root && e.rig.root.parent)
    .map((e) => e.rig.root);

  /**
   * Declare and check what a shot must contain, and fail loudly when it does
   * not.
   *
   * A failure raises `ctx.frameErrors` and writes a `console.error`, which is
   * exactly what a thrown system does — so it lands in the manifest's per-shot
   * `engine.frameErrors` *and* in `newErrors`/`errorCount`, and every existing
   * reader of that file sees it without being taught anything new.
   *
   * Spec kinds:
   *  - `objects()`   the subject is 3D: measured in rendered pixels, and — when
   *                  it names more than one object — measured once per object,
   *                  because a sum can be carried entirely by one of them.
   *  - `point()`     the subject has no rig to hide (a landmark, a stage
   *                  feature): measured as projected screen-space bounds plus
   *                  a raycast over that box.
   *  - `dom()`       the subject is a DOM screen: measured by asking the screen.
   */
  /**
   * The legibility floor every `objects()` subject is held to.
   *
   * Set from measurement, not from taste. Across the twenty shots the median
   * per-pixel separation of a subject a human can find in the frame runs
   * 0.30–0.75 (`03-thirdperson` survivor 0.63, `05-boss` Colossus 0.70,
   * `11-bestiary` roster 0.79, `09-survivors` 0.55). The one subject the round-2
   * critic independently measured as illegible — the `04-combat` survivor, whose
   * bbox median luminance is the *lowest of every named object in its own frame*
   * — sits at 0.11. 0.25 is placed in the empty band between those two
   * populations, nearer the failure than the pass so it cannot be cleared by
   * noise.
   *
   * A subject may raise its floor. Nothing may lower it below this without a
   * measurement showing the criterion is wrong for that subject; the whole
   * point of the gate is that it is not negotiable by whoever is trying to ship.
   */
  const MIN_SEPARATION = 0.25;

  /**
   * The margin a gated subject must hold *above* its separation floor.
   *
   * Ratified 2026-08-16. A subject sitting exactly on its floor is a gate that
   * has stopped being an instrument: it cannot detect a regression in one
   * direction, and it fails on any change in the other. Issue #69 is the live
   * proof — `22-realm-market` -> `the survivor` was passing at exactly
   * `sepP50 0.25` against a 0.25 floor, and any correct lighting change was
   * going to tip it.
   *
   * **0.02 is not a taste number: it is exactly one bin of the instrument.**
   * `sepP50` is read off a 50-bin histogram (`SEP_BINS`, ~line 1944) and
   * reported at bin centres, so the only values it can ever produce are the odd
   * hundredths — 0.23, 0.25, 0.27. There is no representable value between
   * "on the floor" and "one step clear of it". A subject reading 0.25 is
   * therefore not measured at 0.25; it is measured as *somewhere in [0.24,
   * 0.26)*, which straddles the floor it is being gated on. Requiring the next
   * bin up is the smallest demand that puts the whole measurement interval on
   * the passing side, and it is why this number cannot be tuned down: 0.01 of
   * margin is unrepresentable and 0 is the defect.
   *
   * The floor itself does not move. `MIN_SEPARATION` stays where measurement
   * put it; this rides on top of it, and an exemption below can only ever pull
   * the bar back down *to* the floor, never under it.
   */
  const SEP_MARGIN = 0.02;

  /**
   * The ratchet, in the shape `tools/silhouette-metrics.mjs` uses (see the
   * `exemptions` list there, and `gradeRoster` below it).
   *
   * Each entry is a gated check that cannot meet `SEP_MARGIN` *as the game
   * currently renders*, with the value measured at the moment it was admitted
   * and the run that measured it. An exempted check passes only while it is no
   * worse than the recorded value: a new margin failure is red immediately, and
   * an exempted one that degrades is red. So the climb to full margin stays
   * tracked work instead of a standing red, and nothing in the list is silent —
   * every entry carries a written `note`, and every entry is republished into
   * the manifest on the check it exempts.
   *
   * `id` is `<shot>::<subject>` and `kind` is one of:
   *
   *  - `sepP50` — the subject-level median over the union mask.
   *  - `perSep` — the *weakest gated object*'s median. Deliberately keyed on the
   *    subject rather than on an object index: the gated set of a `crowd` is
   *    ranked by pixel count and reorders between runs, so an exemption keyed
   *    `horde#5` would be keyed on a name that does not stay put. "The worst of
   *    the ones we look at must not get worse" is the same ratchet and it is
   *    index-free.
   *
   * **No exemption may lower a bar below `MIN_SEPARATION`.** The exemption
   * mechanism exists to hold ground that is already held, not to open a door
   * under the floor.
   *
   * There is no slack term here, and `silhouette-metrics.mjs` needs one only
   * because its metrics are continuous. `sepP50` is quantised at 0.02, so any
   * tolerance smaller than a bin can never change a verdict, and a tolerance of
   * one bin would be the entire margin this rule is about. The recorded value
   * is used as it stands.
   *
   * Both values below were measured by
   * `node tools/capture.mjs --out reviews/gate-margin/baseline --port 5251`
   * under d3d11 and are copied from
   * `reviews/gate-margin/baseline/manifest.json`.
   */
  const SEP_MARGIN_EXEMPTIONS = [
    // `08-explosion::damage numbers` was here at 0.25 — the floor exactly, which
    // is to say no margin at all. Retired by #85: the plate that carries that
    // readout's separation is specified in atlas texels and was 3 px wide at the
    // glyph's floor, i.e. under one pixel of the 480x270 mask these numbers are
    // measured on, so ink and plate averaged back to the background inside a
    // single sample. Doubling the plate (`NUM_HALO_PX`, `src/systems/VFX.js`)
    // took the subject to 0.33 without changing the type's on-screen size. The
    // entry is deleted rather than raised: an exemption around a subject that
    // now clears its own margin is a silence, not a record.

    // The 30 m arena's horde gates its best 8 of 24, and the weakest of those 8
    // lands on the floor exactly. This is a framing/lighting property of the far
    // half of that arena rather than of any one monster — the same slot is a
    // different creature run to run — so it is fixed by lifting the arena's fill
    // or tightening the shot, not by anything a subject can declare.
    //
    // It is also the one entry here that is *boundary-flaky* rather than
    // steadily short, which is the strongest argument for it existing: the two
    // runs recorded above read `worstGatedSep` 0.25 (`baseline`) and 0.29
    // (`rule-on`) on an unchanged tree. Without the exemption the horde would
    // have gone red on roughly every other run, which is how a gate gets
    // switched off. The recorded value is the worse of the two.
    { id: '04-combat::horde', kind: 'perSep', value: 0.25,
      note: 'weakest of the 8 gated horde members straddles the floor (0.25 / 0.29 on two unchanged runs); wants arena fill or framing, not a per-subject change' },

    // The market's second stall is the horde's shape in the realm roster: an
    // entry admitted for boundary-flake, not for steady shortfall. It was
    // added once for the wrong reason ("sits on the bar exactly" — but a value
    // AT the bar passes the strict-< comparison, so that entry loosened the
    // gate for nothing) and deleted on that argument. Then cross-BOOT runs on
    // unchanged trees read its perSep at 0.25, 0.27 and 0.31
    // (`reviews/crucible-absence/red|fix1|final` at 0.25;
    // `reviews/survivor-sep/integrated` at 0.27; `survivor-sep/post-exemption`
    // at 0.31), which is the horde's straddle exactly: byte-deterministic
    // within a boot, +/-0.03 across boots. Without the entry the shot goes red
    // on roughly every other boot, which is how a gate gets switched off. The
    // recorded value is the worst observed; the 0.25 floor still binds through
    // `marginBar`'s Math.max. Retire it the way #85 retired the damage
    // numbers: by art that clears 0.27 on its bad boots, not by deletion on a
    // good one.
    { id: '22-realm-market::the market stalls', kind: 'perSep', value: 0.25,
      note: 'second stall straddles the margin bar across boots (0.25 / 0.27 / 0.31 on unchanged trees); boundary-flake like the horde, wants art with real headroom, not deletion on a lucky boot' },

  ];

  const marginExemption = (shot, subject, kind) => SEP_MARGIN_EXEMPTIONS.find(
    (e) => e.id === `${shot}::${subject}` && e.kind === kind) ?? null;

  /**
   * The bar a check is actually held to: floor + margin, pulled back to the
   * exempted value where one is recorded, and never below the floor itself.
   */
  const marginBar = (minSep, exempt) => +(exempt
    ? Math.max(minSep, Math.min(minSep + SEP_MARGIN, exempt.value))
    : minSep + SEP_MARGIN).toFixed(4);

  const mustContain = (shot, specs) => {
    const checks = [];
    for (const s of specs) {
      const c = { subject: s.subject, kind: 'dom', ok: false };
      try {
        if (s.info) {
          // Recorded, never gated. A proxy measurement is worth having in the
          // manifest and is not worth failing a shot whose pixels are fine.
          c.kind = 'info';
          c.ok = true;
          c.detail = s.detail ? s.detail() : null;
        } else if (s.dom) {
          c.ok = !!s.dom();
          c.detail = s.detail ? s.detail() : null;
        } else if (s.objects) {
          c.kind = 'pixels';
          const rep = subjectReport(s.objects(), {
            perObject: !!s.perObject, aggregate: !!s.minCarriedPx,
            region: s.region ? s.region() : null,
          });
          Object.assign(c, rep);
          c.minPx = s.minPixels ?? 250;
          c.minObjects = s.minObjects ?? 0;
          // Default true so the `minCarriedPx` aggregates — gated on carried
          // area rather than on separation, and so having no floor for a margin
          // to sit above — are unaffected rather than accidentally red.
          c.marginOk = true;
          // Two independent questions, and until now only the first was asked:
          // is the subject *there*, and can it be *told apart from what is
          // behind it*. A subject that is present and indistinguishable is a
          // failed shot — that is the whole finding of round 2.
          c.present = rep.px >= c.minPx && (!c.minObjects || rep.visibleObjects >= c.minObjects);
          // A pixel subject may publish detail too. `perPx` is an array of
          // anonymous numbers; for a subject whose objects are shared buffers
          // that is not readable, and "which of them is the zero" is exactly the
          // question a reader has.
          if (s.detail) c.detail = s.detail();
          // Pixels that carry their own edge, as opposed to pixels the subject
          // merely touched.
          c.carriedPx = Math.round(rep.px * rep.legible);
          if (s.minCarriedPx) {
            /* The median is the right statistic for a solid subject, where
             * every masked pixel *is* the subject, and the wrong one for an
             * effect, where a large share of the mask is the effect's own light
             * falling on the world. Measured on `08-explosion`: the blast's
             * mask is 11,143 px of which 6,140 carry >= 0.15 separation and the
             * remaining 5,000 are the light layer washing across terrain at
             * p25 = 0.07 — which is that layer working, not failing. A median
             * over that mask reports 0.17 for an explosion a human cannot miss.
             *
             * So an effect is gated on the *area that carries an edge* instead,
             * against the same floor its pixel count used. That is strictly
             * tighter than what shipped, not looser: the old check counted the
             * whole halo toward `minPixels`, this one counts none of it.
             */
            c.minCarried = s.minCarriedPx;
            c.legibleOk = c.carriedPx >= c.minCarried;
            c.aggregate = s.aggregateWhy
              ?? 'VFX buffers: the meshes are shared particle/ring/trail pools, not nameable objects';
          } else {
            c.minSep = s.minSeparation ?? MIN_SEPARATION;
            /* Two bars, published separately on purpose. `legibleOk` is still
             * "is this subject over the legibility floor", unchanged and
             * unweakened; `marginOk` is "does it clear that floor by enough for
             * the gate to be able to see a regression". A reader who finds a red
             * shot needs to know which of the two it is, because they are
             * different work: the first is a subject a human cannot find, the
             * second is a subject a human can find and an instrument cannot
             * vouch for. Both fail the shot (see `c.ok`).
             */
            c.legibleOk = rep.sepP50 >= c.minSep;
            const sepEx = marginExemption(shot, s.subject, 'sepP50');
            c.marginSep = marginBar(c.minSep, sepEx);
            c.marginOk = rep.sepP50 >= c.marginSep;
            if (sepEx) c.marginExempt = { kind: 'sepP50', value: sepEx.value, note: sepEx.note };
          }
          /* Per object, because an aggregate hides an absence.
           *
           * `sepP50` is a median over the *union* mask and `minPixels` is tested
           * against the *sum*, so a subject can certify while one of the objects
           * it declares is not in the photograph at all — `23-realm-crucible`
           * shipped `perPx: [141, 0, 299]` against `minPixels: 420` and wrote
           * `ok: true`. This is the same class of defect as the `errorCount: 0`
           * that once hid two subjectless shots, one level down.
           *
           * The floor is derived from what the subject already claims rather
           * than from taste: a subject asking for P pixels across N objects is
           * claiming each of them contributes, and the weakest claim consistent
           * with that total is the even share P/N. The per-object floors
           * therefore sum to exactly `minPixels`, which makes this check
           * strictly stronger than the aggregate it sits beside and never
           * weaker — no shot can pass under it that failed before.
           *
           * `crowd` is the one opt-out and it is not aggregate treatment: a
           * director horde is a population, not a cast list, and a monster
           * behind a terrain lip at 30 m is the scene working. A crowd names how
           * many of its members must individually stand up (`crowd`) and why
           * (`crowdWhy`); those N are then gated one at a time against P/N, and
           * the remainder are published but not required. A subject that says
           * nothing is gated on every object it declares.
           */
          if (rep.perPx && !s.minCarriedPx) {
            const n = rep.perPx.length;
            const need = s.crowd ? Math.min(s.crowd, n) : n;
            if (s.crowd) c.crowd = { need, why: s.crowdWhy ?? 'undocumented' };
            c.minPerPx = Math.max(1, Math.round(c.minPx / need));
            const rank = rep.perPx.map((_, i) => i)
              .sort((a, b) => rep.perPx[b] - rep.perPx[a]).slice(0, need);
            const gated = new Set(rank);
            /* An object that renders nothing is not a member of the subject.
             * This is where `04-combat` was hiding six zeros in twenty-four, one
             * of them the `rimebound` elite whose whole affix claim was then
             * measured on a subject that contributes no pixels at all, and where
             * `23-realm-crucible` certified `perPx: [141, 0, 299]`.
             *
             * **The absence floor applies to the gated set**, and the gated set
             * is what the subject declared it to be:
             *
             *  - A subject that says nothing about `crowd` gates *every object it
             *    declares* — `need === n`, so `rank` is all of them and `gated`
             *    is the whole cast. Every zero it carries is inside the gated set
             *    and fails the shot. `09-survivors` (4), `11-bestiary` (16) and
             *    every un-annotated pixel subject are in this case, and nothing
             *    below can excuse one of their zeros: there is no `crowd` branch
             *    for the rule to take.
             *  - A `crowd: N` subject declares a *population*, and the contract
             *    it signs is "N of these are individually in the photograph". So
             *    the gate holds its best N to every floor including this one, and
             *    an absence outside those N is the scene working as `crowdWhy`
             *    says it works — a body knocked out of frame by the blast that is
             *    the subject of `08-explosion`, a monster behind a terrain lip at
             *    the far edge of `04-combat`'s 30 m arena. Those are published in
             *    `absentObjects` and again, named, in `crowd.absentBeyondCrowd`;
             *    they are not gated.
             *
             * The old rule failed *any* declared object under the floor, ranked
             * or not, which read on a crowd as "all 24 must be individually
             * photographed" — the exact opposite of the contract the same subject
             * declares two lines up in its own scenario. The two could not both
             * be right and this is the reconciliation: absence is fatal wherever
             * the gate is looking, and `crowd` says where that is. It is not a
             * relaxation for anyone else, and it is strictly *stricter* than what
             * shipped for the gated set — `ABSENT_PX` is now tested on ranked
             * objects too, which matters where `minPerPx` falls below it.
             *
             * **What a zero inside this check looks like.** A gated object at
             * `px: 0` is an entry in `objectFailures` and in `absentObjects`, and
             * it sets `perObjectOk: false`, so the shot is red — that is true for
             * a fixed cast always and for a crowd's best N always. A non-gated
             * object at `px: 0` on a `crowd` subject is an entry in
             * `absentObjects`, an entry in `crowd.absentBeyondCrowd`, sets
             * `crowd.carriesAbsence: true`, is named in `notGated`, and is
             * hoisted to `manifest.toleratedAbsences` by `tools/capture.mjs`
             * beside `subjectFailures`. It is never absent from the manifest and
             * it is never silent: a green shot that carried a zero says so in
             * four places. Publish, don't just gate.
             */
            const ABSENT_PX = 12;
            c.absentObjects = rep.perPx
              .map((px, i) => (px < ABSENT_PX ? { i, px, sepP50: rep.perSep[i] } : null)).filter(Boolean);
            c.objectFailures = rank
              .filter((i) => rep.perPx[i] < ABSENT_PX
                || rep.perPx[i] < c.minPerPx || rep.perSep[i] < c.minSep)
              .map((i) => ({ i, px: rep.perPx[i], sepP50: rep.perSep[i] }));
            if (c.crowd) {
              c.crowd.absentBeyondCrowd = c.absentObjects.filter((o) => !gated.has(o.i));
              c.crowd.carriesAbsence = c.crowd.absentBeyondCrowd.length > 0;
            }
            // The absences this check declined to read, in one field with one
            // name, so a reader and `tools/capture.mjs` find them the same way
            // whatever kind of subject produced them. Empty for a fixed cast by
            // construction: everything it declares is gated.
            c.ungatedAbsences = c.crowd ? c.crowd.absentBeyondCrowd : [];
            c.perObjectOk = c.objectFailures.length === 0;
            /* The same margin, over the same gated set the line above gates.
             * A crowd's ranked N and a fixed cast's whole roster are both "what
             * this gate is looking at", and a gated object resting on the floor
             * is as blind as a subject resting on it. Keyed on the subject, not
             * on the object index — see `SEP_MARGIN_EXEMPTIONS`. The recorded
             * quantity is the *weakest* gated object, so "no worse than when we
             * admitted it" means the floor of the gated set has not sunk.
             */
            const perEx = marginExemption(shot, s.subject, 'perSep');
            c.marginPerSep = marginBar(c.minSep, perEx);
            c.worstGatedSep = rank.length
              ? Math.min(...rank.map((i) => rep.perSep[i])) : null;
            c.marginObjectFailures = rank
              .filter((i) => rep.perSep[i] < c.marginPerSep)
              .map((i) => ({ i, px: rep.perPx[i], sepP50: rep.perSep[i] }));
            if (perEx) c.marginExemptPerSep = { kind: 'perSep', value: perEx.value, note: perEx.note };
            if (c.marginObjectFailures.length) c.marginOk = false;
          } else {
            /* The aggregate opt-out published nothing at all, and that is the
             * sixth instance of this round's defect class.
             *
             * `minCarriedPx` subjects are gated on `carriedPx` alone — the
             * meshes are shared particle/ring/trail pools, so "object 2" is a
             * buffer and not a nameable thing, and an explosion that legitimately
             * never used its beams pool should not fail for it. That rationale is
             * defensible. What was not defensible is that the per-object block
             * was skipped *entirely*, so `absentObjects` came out `undefined`:
             * not ungated, but uncomputed and unpublished. A subject certifying
             * on a sum while carrying a zero **in silence** is exactly the shape
             * of `23-realm-crucible`'s `perPx: [141, 0, 299]`, sitting inside the
             * one subject that opted out of the gate built to catch it.
             *
             * So the absence list is computed and published here too, and named
             * in `notGated`, warned about, and hoisted to
             * `manifest.toleratedAbsences`. **No verdict moves**: nothing below
             * reads it, `perObjectOk` is still unconditionally true, and
             * `carriedPx >= minCarried` remains the whole gate. Publish, don't
             * just gate — including where the decision not to gate was correct.
             *
             * **What it was carrying when this was made visible**, so the next
             * reader can judge it with evidence instead of rediscovering it:
             * `reviews/round6/reconcile/manifest.json`, `08-explosion` -> `the
             * blast`, `ok: true`, `px: 22332`, `carriedPx: 12372`, and
             * `perPx: [22330, 0, 23, 0]`. Two of the four pools render nothing
             * and a third renders 23 px. The open question that number exists to
             * settle: are those the beams and trails pools this explosion
             * legitimately never used, or two emitters that silently stopped
             * emitting? Whoever answers it should say so here. Until then the
             * shot passes on 22,332 px of fireball, which is a real fireball —
             * this is a publication fix, not a verdict.
             */
            const ABSENT_PX = 12;
            if (rep.perPx) {
              c.absentObjects = rep.perPx
                .map((px, i) => (px < ABSENT_PX
                  ? { i, px, sepP50: rep.perSep?.[i] ?? null } : null)).filter(Boolean);
              c.ungatedAbsences = c.absentObjects;
            }
            c.perObjectOk = true;
          }
          // One flag for both kinds of tolerated absence, read by the warn below
          // and by `tools/capture.mjs`'s hoist.
          c.carriesAbsence = (c.ungatedAbsences?.length ?? 0) > 0;
          /* Which of the numbers beside it actually decided `ok`.
           *
           * This check publishes seven statistics and reads three of them. The
           * other four — `contrast`, `sep`, `sepP25`, `legible` — are computed,
           * recorded, and never looked at, and a reader has no way to tell which
           * is which. That is the round-6 defect class one more time: not an
           * aggregate hiding an absence this time, but *evidence sitting in the
           * manifest that nothing reads*, which is worse, because it looks like
           * a measurement that was taken into account. The round-2 critic
           * quoted `contrast: 0.053` as a finding against a shot the harness had
           * already certified; the round-4 critic quoted `contrast 0.442 ->
           * 0.088` the same way. Both were reading a number no gate had ever
           * consulted.
           *
           * `gatedOn` is that list, per check, in the manifest.
           *
           * **Why `contrast` is not on it, measured rather than asserted.** It is
           * `|Σls − Σlb| / Σ(ls + lb)`: a *signed mean*, so it cancels, and this
           * file already documents that at the definition. The on-disk captures
           * say how badly, and they say it on subjects that are plainly legible:
           *
           *  - `reviews/round6/realms/manifest.json`, `24-realm-vault` -> `the
           *    vault chest`: `contrast 0.052` with `sepP50 0.51` over 1,852 px.
           *    Half that chest's pixels differ from what is behind them by more
           *    than 50% Michelson and the mean reports it as invisible.
           *  - the same file, `22-realm-bazaar` -> `the survivor`:
           *    `contrast 0.101`, `sepP50 0.29`.
           *  - `reviews/round6/hdiag5/manifest.json`, `04-combat` -> `survivor`:
           *    `contrast 0.094`, `sepP50 0.41`, `lum 48.8` against `bgLum 59.0`.
           *    He has not stopped standing off his background; he has stopped
           *    being a *different average value* from it, which is a composition
           *    observation and not a legibility one.
           *
           * A floor at 0.15 — the empty band between 0.101 and 0.264 in the 502
           * pixel-checks on disk, placed by the same method as
           * `MIN_SEPARATION` — would therefore fail three subjects a viewer can
           * see in order to catch one, and two of the three sit in shots that
           * currently pass. That is why `sepP50` exists and why it, not this,
           * carries the floor. **The field stays published, because the
           * composition observation is worth having; it is now declared as
           * something no gate read.**
           *
           * **What a zero inside `gatedOn` looks like.** It is a list of names,
           * not a count and not a boolean: an empty array would mean a `pixels`
           * check that gated on nothing at all, which is visible on sight. Every
           * name in it is a field present on the same object, so a reader can
           * check the verdict against the number without being told what it was.
           */
          c.gatedOn = ['px >= minPx']
            .concat(c.minObjects ? ['visibleObjects >= minObjects'] : [])
            .concat(s.minCarriedPx ? ['carriedPx >= minCarried']
              : ['sepP50 >= minSep',
                `sepP50 >= marginSep (${c.marginSep})${c.marginExempt ? ' [exempt]' : ''}`])
            .concat(rep.perPx && !s.minCarriedPx
              ? [c.crowd
                ? `perPx/perSep/absence over the ${c.crowd.need} gated of ${rep.perPx.length}`
                : 'perPx/perSep/absence over every declared object',
              `perSep >= marginPerSep (${c.marginPerSep}) over the gated set`
                + `${c.marginExemptPerSep ? ' [exempt]' : ''}`]
              : []);
          c.notGated = ['contrast', 'sep', 'sepP25']
            .concat(s.minCarriedPx ? [] : ['legible'])
            // Named on every crowd and every aggregate, not only when one is
            // carrying an absence, so that a reader learns the rule from a green
            // check as well as a red one. On an aggregate `perPx` itself is
            // ungated, and saying so is the point: this check reads a sum.
            .concat(c.crowd ? ['crowd.absentBeyondCrowd'] : [])
            .concat(s.minCarriedPx && rep.perPx ? ['perPx', 'perSep', 'absentObjects'] : []);
          c.ok = c.present && c.legibleOk && c.perObjectOk && c.marginOk;
        } else if (s.point) {
          c.kind = 'bounds';
          const p = s.point();
          if (!p) { c.ok = false; c.detail = 'no subject point'; }
          else {
            const from = camera.position;
            c.vis = +visibleFraction(from, p, {
              height: p.height ?? 4, radius: p.radius ?? 2, cols: 5, rows: 4, slack: p.slack ?? 0.6,
            }).toFixed(3);
            camera.updateMatrixWorld(true);
            const sc = screenOf(p.x, p.y + (p.height ?? 4) * 0.5, p.z);
            c.screen = [+sc.x.toFixed(3), +sc.y.toFixed(3), +sc.front.toFixed(1)];
            c.onScreen = sc.front > 0 && sc.x > 0.02 && sc.x < 0.98 && sc.y > 0.02 && sc.y < 0.98;
            c.minVis = s.minVisible ?? MIN_VISIBLE;
            c.ok = c.onScreen && c.vis >= c.minVis;
          }
        }
      } catch (e) {
        c.ok = false;
        c.detail = `threw: ${e && e.message ? e.message : e}`;
      }
      checks.push(c);
    }
    const failed = checks.filter((c) => !c.ok);
    subjects[shot] = { ok: failed.length === 0, checks };
    // Published, not gated, and said out loud. Two checks can go green while an
    // object they declare rendered nothing — a `crowd` beyond its N, and an
    // aggregate gated on a sum — and those are the only two shapes of zero this
    // gate deliberately does not fail on. Precisely because they are tolerated,
    // they must not be the shapes a reader has to go looking for.
    // `manifest.toleratedAbsences` carries the same list beside
    // `subjectFailures`.
    const tolerated = checks.filter((c) => c.carriesAbsence);
    if (tolerated.length) {
      console.warn(`[harness] ${shot}: tolerated absences (published, not gated) — `
        + tolerated.map((c) => `${c.subject} [${c.crowd
          ? `crowd ${c.crowd.need}/${c.perPx.length}: ${c.crowd.why}`
          : `aggregate on carriedPx: ${c.aggregate}`}] `
          + `absent: ${JSON.stringify(c.ungatedAbsences)}`).join('; '));
    }
    if (failed.length) {
      const msg = `[harness] ${shot}: subject missing or illegible — `
        + failed.map((c) => `${c.subject} (${c.kind}: ${JSON.stringify(
          c.kind === 'pixels' ? {
            // `no margin` is called out ahead of the older reasons because it is
            // the one a reader will not otherwise recognise: the subject is over
            // its floor and the shot is still red, which reads as a bug until
            // you know the rule. Say the rule, in the message, every time.
            why: !c.present ? 'absent'
              : !c.legibleOk ? 'illegible'
                : !c.perObjectOk ? 'object absent or illegible'
                  : 'no margin: over the floor but not clear of it by SEP_MARGIN',
            px: c.px, need: c.minPx, objs: `${c.visibleObjects}/${c.objects}`, need2: c.minObjects,
            sepP50: c.sepP50, needSep: c.minSep,
            needSepWithMargin: c.marginSep, marginExempt: c.marginExempt,
            needPerSepWithMargin: c.marginPerSep, marginExemptPerSep: c.marginExemptPerSep,
            worstGatedSep: c.worstGatedSep, thinObjects: c.marginObjectFailures,
            carriedPx: c.carriedPx, needCarried: c.minCarried,
            perPx: c.perPx, perSep: c.perSep,
            needPerPx: c.minPerPx, badObjects: c.objectFailures,
            lum: c.lum, bgLum: c.bgLum,
          }
            : c.kind === 'bounds' ? { vis: c.vis, need: c.minVis, onScreen: c.onScreen, screen: c.screen }
              : { detail: c.detail })})`).join('; ');
      ctx.frameErrors = (ctx.frameErrors ?? 0) + failed.length;
      ctx.lastFrameError = { who: `harness:${shot}`, message: msg, frame: -1 };
      console.error(msg);
    }
    return subjects[shot];
  };

  // Pinned at install rather than by the first caller, when asked for by URL.
  //
  // `tools/capture.mjs` cannot pin earlier than the moment the stage exists,
  // and the engine has been running on the wall clock for every frame before
  // that — a variable number of them, advancing the sim by a variable amount.
  // Measured: pinning only from stage-ready left the twenty shots agreeing to
  // within ~1-2% instead of exactly. Pinning here moves it ahead of the
  // engine's first frame, so no frame in the session is ever timed by the wall
  // clock.
  if (globalThis.location && new URLSearchParams(location.search).has('pinclock')) pinClock(1 / 60);

  // Hosting with nobody connected, asked for by URL — `?harness=1&coophost=1`.
  //
  // `tests/sp-equivalence.mjs --coop-host` (`npm run gate:mp1`) boots this to
  // make roadmap rule 10 executable: a host whose roster is one must simulate
  // exactly as single-player does, down to the `ctx.rng` draw. Installed here
  // rather than by the probe, and next to `pinclock` for the same reason it is
  // — this runs before the engine's first frame, so the host path is live for
  // every simulation step the page ever takes rather than for all but the first
  // few.
  //
  // `Lobby.startHost` is the layer directly beneath the co-op screen's host
  // button: `Menus.coopAction('coop-invite')` calls `Lobby.createInvite`, whose
  // own first line is `if (this.mode !== 'host') this.startHost()`. Stopping
  // there is deliberate. `createInvite` goes on to open an RTCPeerConnection and
  // gather ICE — network I/O a local gate must not depend on, and which adds no
  // host-side simulation state, because a minted invite nobody accepts leaves
  // `NetHost.clients` empty exactly as this does. `startHost` itself touches no
  // network at all: it adds a `NetHost` system, and `HostTransport`'s
  // constructor is three empty collections. So `ctx.authority`, `ctx.netRole`
  // and the snapshot writer are all real here with no relay anywhere.
  if (globalThis.location && new URLSearchParams(location.search).has('coophost')) {
    // Loud rather than optional: this param exists so a gate can assert the
    // host path was live, and a silent no-op would turn that gate into a
    // single-player run wearing a multiplayer name.
    if (!ctx.lobby) throw new Error('coophost: ctx.lobby does not exist in this build');
    ctx.lobby.startHost();
  }

  const H = {
    ctx,
    subjects,
    mustContain,
    subjectReport,

    /**
     * The title screen, and the only scenario that composes nothing.
     *
     * It exists so the shot has an assertion at all: `01-title` was driven by a
     * bare `settle(page, 90)` from `tools/capture.mjs`, which cannot tell a
     * title screen from a black canvas.
     */
    async title({ settleFrames = 90 } = {}) {
      thaw();
      await frames(settleFrames);
      freeze();
      const menus = ctx.hud?.menus;
      mustContain('01-title', [
        { subject: 'title screen', dom: () => menus?.screen === 'title', detail: () => menus?.screen ?? null },
        {
          subject: 'the menu itself',
          dom: () => (menus?.root?.querySelector('[data-screen="title"]')?.offsetHeight ?? 0) > 40,
          detail: () => menus?.root?.querySelector('[data-screen="title"]')?.offsetHeight ?? 0,
        },
        { subject: 'a live stage behind it', dom: () => !!ctx.stage },
      ]);
      return { screen: menus?.screen ?? null };
    },

    async vista({ settleFrames = 90 } = {}) {
      await begin();
      detach();
      const p = playerPos();
      // Sit lower and aim slightly above the player. The old framing pitched
      // ~20° down at FOV 55, which put the top of frame at ~7° elevation — the
      // sun sits at 18°, so the disc and the whole upper gradient could never
      // appear in the shot that exists to judge sky and atmosphere.
      //
      // The offset is a fixed world diagonal on purpose here (the shot is of the
      // stage, not of anything the player is facing) but the height is clamped
      // above the terrain under the lens, or the "wide establishing shot" is a
      // shot of the inside of a hill.
      //
      // Bearing and pitch are composed rather than centred: the old framing put
      // the horizon at 52% of frame height with the crosshair in empty sky and
      // three equal-weight horizontal bands, and the correction overshot — a
      // 15 m lift aimed 9 m down at 57 m pitched ~9° below level and left the
      // skyline at 11% of frame height, i.e. one ninth of the shot for the sky
      // in the shot documented as judging "terrain, lighting, fog, sky".
      //
      // Pitch is therefore derived from the camera height rather than from a
      // fixed world point, so it is the same pitch whatever the terrain under
      // the lens happens to be — aiming at a fixed `p.y + 6` could not do that,
      // and on a rise it re-pitched the whole frame into the ground. Aiming
      // 4.5 m above the lens over the 57 m standoff is ~4.5° up, which puts the
      // true horizon below the vertical midpoint and the ridge line at ~0.34.
      //
      // The offset is now a *preferred* bearing rather than a fixed one. It was
      // chosen when every biome shared one gentle heightfield; against
      // per-biome landforms — mesa skirts, canyon walls, cavern spires — a
      // fixed world diagonal drops the lens hard against a vertical face, and
      // this shot came back with half the frame filled by one flat unlit
      // triangle of mesa. Sweep off the diagonal until the lens can see the
      // subject, and keep the height clamped so it cannot climb the face it was
      // supposed to be standing away from.
      const R = Math.hypot(46, 34);
      const base = Math.atan2(-46, 34);
      let cx = p.x - 46, cz = p.z + 34;
      let camY = Math.max(groundY(cx, cz, p.y) + 6, p.y + 9);
      for (let i = 0; i < 12; i++) {
        const az = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.42;
        const tx = p.x + Math.sin(az) * R, tz = p.z + Math.cos(az) * R;
        const ty = Math.min(Math.max(groundY(tx, tz, p.y) + 6, p.y + 9), p.y + 22);
        const pos = _probe.set(tx, ty, tz);
        if (!seesTarget(pos, _cc.set(p.x, p.y + 2.0, p.z), 1.0)) continue;
        cx = tx; cz = tz; camY = ty;
        break;
      }
      camera.position.set(cx, camY, cz);
      camera.lookAt(p.x, camY + 4.5, p.z);
      camera.fov = 58;
      camera.updateProjectionMatrix();
      await frames(settleFrames);
      freeze();
      mustContain('02-vista', [
        {
          subject: 'the stage the survivor is standing on',
          point: () => Object.assign(playerPos().clone(), { height: 2.0, radius: 0.8, slack: 0.5 }),
          minVisible: 0.4,
        },
        { subject: 'sky', dom: () => skyFraction() > 0.10, detail: () => +skyFraction().toFixed(3) },
      ]);
    },

    async gameplay({ settleFrames = 90 } = {}) {
      await begin();
      attach();
      await frames(settleFrames);
      freeze();
      mustContain('03-thirdperson', [
        { subject: 'survivor', objects: () => [ctx.player?.group], minPixels: 600 },
      ]);
    },

    async combat({ enemies = 24, settleFrames = 60 } = {}) {
      await begin();
      attach();
      invulnerable();
      // The rig has to have the camera back before anything is placed. Every
      // spawn here is derived from camera forward, and at this point `camera`
      // still holds the previous scenario's hand-set transform — for
      // `04-combat`, the 70 m biome-vista lens aimed at a landmark, i.e. a
      // bearing with no relationship at all to where the survivor is looking.
      await frames(6);
      /* The cast is the twenty-four this scenario is about to place, and nobody
       * else.
       *
       * `Director.fixedUpdate` keeps banking credits and spawning through every
       * frame this scenario spends composing, and it spawns at `findSpawnPoint`
       * — deliberately off camera. Measured in
       * `reviews/round6/diag-combat4.json`: two of its reinforcements ended up
       * inside the horde subject, a spitling 72 m from the lens at world y 3.8
       * and a charger at y 2.4 against a survivor standing at y 19.5, both at
       * the bottom of the slope off the arena, both contributing 0 px and both
       * failing a gate they had no way of passing. They are not the scene
       * working — they are another system's bodies inside this shot's declared
       * subject, and the arena search below spends real frames, so there is a
       * window for more of them the longer the search takes.
       *
       * Off before the search, not after it, and the arena is swept again once
       * the survivor has finished moving. This makes the assertion strictly
       * harder: all twenty-four are members that have to be photographed, with
       * no unplaceable extras diluting the population `crowd: 8` draws from.
       * `enabled` gates only credit accrual and spawning (`Director.js:290`);
       * the horde keeps chasing, attacking and dying exactly as before.
       */
      if (ctx.director) {
        ctx.director.enabled = false;
        restoreAfterShutter(() => { ctx.director.enabled = true; });
      }
      // Then put him somewhere an arena fits, and turn him there. Turning is the
      // second half of the fix and it shipped without the first: `faceOpenGround`
      // sweeps twelve bearings on the knoll the stage spawns him on and the best
      // of them scores 0.44. This is the fix for the empty battlefield — see
      // `arenaFlatness` and `placeForOpenArena`.
      const arena = await placeForOpenArena();
      const openness = arena.openness;
      // Anything the director banked before it was switched off, and anything
      // left standing where the survivor used to be, goes now: the walk has
      // moved him and those bodies are no longer in the arena being framed.
      ctx.director?.clear?.(ctx);
      spawnRing(enemies, SPAWN_CARDS, 13, 6);
      // Hold the trigger so the frame contains muzzle flash and tracers.
      if (ctx.input) ctx.input.mouse.left = true;
      await frames(settleFrames);
      declutter(12);
      // Then put the crosshair on a body and keep it there. Tracers alone are
      // not impact feedback: this shot is documented as judging VFX layering
      // and HUD under load, and until the rounds arrived somewhere it contained
      // no damage number, no hit flash and no impact spark at all.
      //
      // The burst is long enough for two or three volleys to land and their
      // readouts to start their arc, and the crowd is re-spaced inside it so
      // the last few frames of charging do not undo the declutter.
      const mark = stageTargets(3);
      const markAt = mark?.position.clone() ?? null;
      await fireBurst(0.45, { pin: mark, at: markAt });
      // `fireBurst` re-aims the rig every frame, so the camera the declutter
      // above measured against is not the camera being photographed. Put the
      // survivor back in clear view of the final lens first, then re-seat the
      // crowd against it, with the pinned target left alone so its damage
      // readouts stay where they spawned.
      const pvis = await clearSurvivorFromLens();
      // Nothing in frame may be mid-blink when the shutter opens: a Rift
      // Stalker's dash hides its own rig, and the horde gate measures rendered
      // pixels. Waited out before the re-space, because these frames let the
      // crowd charge back in and undo it.
      const hidden = await awaitVisibleHorde();
      // 25 m rather than the default 46, and 25 rather than the 30 this shipped
      // with. Issue #86: at 30 the weakest of the eight gated members straddled
      // the 0.25 floor — 0.25 and 0.29 on two unchanged trees, 0.37 on the
      // baseline boot measured in `reviews/issue86/base1` — because the objects
      // sitting on the top-8 pixel cut are the back rank, and the back rank is
      // where the fog is. Pulling the band in to 25 lifts `worstGatedSep` to
      // **0.49**, reproduced on three consecutive boots
      // (`reviews/issue86/d25a|d25b|d25c`), with subject `px` up 9492 -> 10679
      // and aggregate `sepP50` flat at 0.63 vs 0.65. `visibleObjects` goes 22 ->
      // 21 against a floor of 8, and no object failure appears in any run.
      // Past about 30 m on this stage the fog
      // has taken enough of a monster that it stops standing off what is behind
      // it: measured in `reviews/round6/diag-combat4.json`, the hulk — the
      // largest card in the deck — came back at 32.6 m with sepP50 0.23 against
      // the 0.25 floor, while every body inside 25 m cleared it. Pulling the
      // back rank in is a framing change; the floor is untouched.
      /* Why the four zeros here are not a slot-supply problem, measured.
       *
       * On `reviews/round6/hdiag5/manifest.json` four of the twenty-four come
       * back at 0, 0, 1 and 0 px, and that file's `DIAG horde` dump says where
       * each of them is: object 0 is a mite at 27.1 m at screen (0.52, 0.63),
       * which is where the skink 15 m in front of it is standing; object 14
       * is a mortar at 29.7 m; and objects 7 and 23 are chargers at screen x
       * **-2.61** and **-1.38** — outside the frame altogether. That reads as
       * this pass running out of cells: it asks for `bad.length + 4` slots and
       * `screenSlots` hands its far rank out first.
       *
       * **REFUTED — do not re-apply.** Giving this call the whole grid and
       * taking from the near end (`{ supply: 26, nearFirst: true }`, the options
       * still in `_declutterPass` for a future caller with better evidence) was
       * applied and captured to `reviews/round6/hdiag6/manifest.json`. The two
       * off-frame chargers did not move — still 0 px — object 14 stayed at 1 px,
       * and objects 0, 1 and 2 *fell* from 0/17/17 to 2/8/6 as the re-seat pulled
       * the near rank across them: six failing objects became **seven**. It also
       * cost `08-explosion` its `damage numbers` check, which passes in
       * `hdiag5` — this scenario's layout feeds the next one's, so a change here
       * is never local. Reverted to the state `hdiag5` measures.
       */
      /* `worstFirst: true` belongs here on the local evidence — it is the one
       * lever that has ever moved object 7 off the frame edge — and it is
       * REFUTED: it took the capture to four failing shots.
       * `reviews/round6/cfit3/manifest.json`, and see the seat loop. */
      declutter(12, { keep: mark, maxDist: 25, avoidFit: true });
      if (mark && markAt) mark.position.copy(markAt);
      await frames(2);
      freeze();
      mustContain('04-combat', [
        {
          subject: 'horde',
          objects: () => rigsOf(ctx.director?.enemies ?? []),
          perObject: true, minPixels: 900, minObjects: 8,
          // A live director population, not a cast list. Members behind a
          // terrain lip or at the far edge of a 30 m arena are the scene
          // working; what has to be true is that eight of them are individually
          // in the photograph and individually stand off it.
          crowd: 8, crowdWhy: 'director horde: an unbounded population, not a fixed cast',
        },
        // DIAG. Read-only, `info`, and immediately after the check whose
        // per-object numbers it explains — `subjectReport` clears the stash at
        // the top of every report, so a spec between the two would blank it.
        { subject: 'DIAG declutter', info: true, detail: () => lastDeclutter() },
        {
          subject: 'DIAG horde', info: true,
          detail: () => {
            const per = lastPerObject() ?? [];
            camera.updateMatrixWorld(true);
            const list = (ctx.director?.enemies ?? [])
              .filter((e) => e && e.rig && e.rig.root && e.rig.root.parent);
            return list.map((e, i) => {
              const h = e.def?.height ?? 2;
              const s = screenOf(e.position.x, e.position.y + h * 0.5, e.position.z);
              const d = Math.hypot(e.position.x - camera.position.x, e.position.z - camera.position.z);
              return {
                i, id: e.def?.id, d: +d.toFixed(1),
                sx: +s.x.toFixed(3), sy: +s.y.toFixed(3), front: +s.front.toFixed(1),
                wy: +e.position.y.toFixed(1),
                // Stage-geometry occlusion only — see `nearestNearer`. `vis: 1`
                // is not "unoccluded", it is "unoccluded by terrain and props",
                // and `nearer` is the half of the question it cannot ask.
                vis: +visibleFraction(camera.position, _cc.set(e.position.x, e.position.y, e.position.z),
                                      { height: h, radius: (e.def?.radius ?? 0.5) + 0.2, cols: 3, rows: 3, slack: 0.3 }).toFixed(2),
                visWhat: 'ctx.stage only; blind to the horde',
                nearer: nearestNearer(s.x, s.y, d, list, e),
                visRig: e.rig.root.visible !== false,
                ...(per[i] ?? {}),
              };
            });
          },
        },
        // The survivor has to be findable in his own combat frame, which is
        // two claims and not one: enough of him drawn, and enough of him
        // standing off what is behind him. The round-2 critic measured him as
        // the dimmest object in this frame at `contrast: 0.053` while the
        // manifest wrote `ok: true`, because `minPx` was the only gate.
        { subject: 'survivor', objects: () => [ctx.player?.group], minPixels: 400 },
        /* These two were `info: true` — recorded, never able to fail — and they
         * were carrying failure-grade numbers while the shot certified:
         * `openness 0.44` against `faceOpenGround`'s own acceptance bar of
         * 0.85, and the survivor 42% occluded at `vis 0.583` against the 0.6
         * floor this file already gates every `point()` subject on. A check
         * that cannot fail should not be sitting in the same list as ones that
         * can; if the number is worth measuring it is worth a floor, and both
         * floors here are numbers already written in this file rather than new
         * taste. Gated now, and both currently fail — which is the finding, not
         * a reason to move the bar.
         */
        {
          subject: 'open arena',
          dom: () => openness >= OPEN_GROUND_NEED,
          detail: () => ({ openness: +openness.toFixed(2), need: OPEN_GROUND_NEED, arena }),
        },
        /* The list, not a count. An empty `hidden` is the pass; a non-empty one
         * names every monster whose rig was invisible when the shutter opened,
         * and each of those also lands as a zero in `perPx` above — so this
         * cannot report clear while one is missing, and cannot report a failure
         * the pixel gate disagrees with. */
        {
          subject: 'no monster hidden by its own attack',
          dom: () => hidden.length === 0,
          detail: () => hidden,
        },
        /* Same structural blindness as `DIAG horde`'s `vis`, and worth saying
         * where it is *gated* rather than only where it is reported: `pvis`
         * comes from `visibleFraction` too, so it certifies the survivor clear
         * of terrain and props and cannot see a monster parked in front of him.
         * Not a live failure — it reads 1 — but a reader is entitled to know
         * which half of "unoccluded" this number bought. `nearer` is info; the
         * floor is untouched and the verdict is the one it always was. */
        {
          subject: 'survivor unoccluded by the final lens',
          dom: () => (pvis?.vis ?? 0) >= MIN_VISIBLE,
          detail: () => {
            const p = playerPos();
            camera.updateMatrixWorld(true);
            const s = screenOf(p.x, p.y + 0.95, p.z);
            const d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
            return {
              ...pvis, need: MIN_VISIBLE,
              visWhat: 'ctx.stage only; blind to the horde',
              nearer: nearestNearer(s.x, s.y, d,
                (ctx.director?.enemies ?? []).filter((e) => e?.rig?.root?.parent)),
            };
          },
        },
      ]);
    },

    /**
     * Teleporter boss.
     *
     * Three separate ways this shot used to end up without a Colossus in it:
     *
     *  - it spawned the boss on a fixed world `+X/+Z` diagonal with no terrain
     *    sample, so on any slope it landed buried or off a ledge;
     *  - it called `beginTeleporterEvent` (which spawns the *tracked* boss at
     *    `findSpawnPoint`, deliberately outside the frustum) and then spawned a
     *    second untracked Colossus, so the HUD bar and the visible monster were
     *    different entities and only the invisible one had a health bar;
     *  - it inherited two dozen sentinels from `04-combat`, which stood between the
     *    lens and the boss.
     *
     * So the boss is spawned here, registered as `director.boss` before
     * `beginTeleporterEvent` can spawn its own, and re-placed on a bearing the
     * camera has actually raycast to just before the shutter — it walks 3.2 m/s
     * and will not still be where it started.
     */
    async boss({ settleFrames = 90 } = {}) {
      await begin();
      attach();
      invulnerable();
      // Same reason as `04-combat`: `ahead()` and `forward()` read the live
      // camera, and until the rig has committed a frame that camera is still the
      // previous scenario's hand-set transform.
      await frames(6);
      await faceOpenGround({ dists: [10, 18, 26] });

      const card = BOSS_CARDS[0];
      const bh = card?.height ?? 7.6;
      const seed = ahead(27);
      let boss = card ? ctx.director?.spawnOne?.(ctx, card, seed, null) ?? null : null;
      if (boss && ctx.director) {
        // Claim the boss slot first: `beginTeleporterEvent` early-outs when one
        // is already set, which is how we get the event's credits, objective
        // and HUD bar without its off-camera spawn.
        boss.isBoss = true;
        ctx.director.boss = boss;
        ctx.events?.emit?.('bossSpawn', { enemy: boss });
      }
      ctx.director?.beginTeleporterEvent?.(ctx);
      spawnRing(8, SPAWN_CARDS, 18);
      await frames(settleFrames);

      const p = playerPos();
      const f = forward().clone();
      const base = Math.atan2(f.x, f.z);

      // Stand off behind the player, on the player→boss line, so the 1.8 m
      // survivor and the 7.6 m Colossus are both in frame. Scale is the whole
      // point of this shot and scale only exists as a comparison — and a
      // comparison is destroyed by putting the two subjects at different
      // depths. Apparent height goes as height/distance, so the on-screen
      // ratio is 4.2 × (d_player / d_boss): with the lens 16 m behind the
      // player and the boss 20-28 m beyond him, 4.2 × 16/40 = 1.7, and the
      // colossus photographed at 1.33× the survivor. Perspective was cancelling
      // exactly the thing the shot exists to show.
      //
      // So: boss close behind the player, lens far back, and the narrow 36°
      // lens does the magnifying. 24 m and 9 m give 4.2 × 24/33 ≈ 3.1×.
      const SWING = 0.55;
      const camAt = (spot, STANDOFF = 24, LIFT = 6.5, swing = SWING) => {
        let dx = p.x - spot.x, dz = p.z - spot.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        // Swung off the boss→player axis rather than sitting on it. Directly
        // behind the survivor the lens, the survivor and the Colossus are
        // collinear, so he lands on its chest and the two silhouettes fuse —
        // and sliding the camera sideways cannot fix that, because it moves
        // both subjects through nearly the same angle. Swinging the standoff
        // 32° puts ~5 m of real lateral offset between them at the lens.
        const s = Math.sin(swing), c = Math.cos(swing);
        const ax = dx * c - dz * s, az2 = dx * s + dz * c;
        const cx = p.x + ax * STANDOFF, cz = p.z + az2 * STANDOFF;
        // High enough to shoot over the crest the survivor is standing behind:
        // at 4 m the Colossus's legs were cut off by near terrain and a 7.6 m
        // colossus photographed as a 145 px torso.
        return new THREE.Vector3(cx, Math.max(groundY(cx, cz, p.y), p.y) + LIFT, cz);
      };

      // Search for a (boss position, lens position) pair the lens can actually
      // see the boss from.
      //
      // Scored, not first-past-the-post, and with no blind fallback. The
      // previous version took the first candidate that cleared ten hand-placed
      // rays and, when every candidate failed — which is what a forest stage
      // does to ten rays — dropped through to `spot = ahead(23)` with the camera
      // derived from it and no visibility test of any kind. That is the branch
      // `05-boss` shipped from: the Colossus ended up 24 m past the survivor,
      // behind a hillside, contributing exactly 0 of 360,000 pixels, under a
      // full STONE TITAN health bar.
      //
      // The camera is now searched too. Standoff, lift and swing are all
      // composition preferences rather than constraints, and a forest that
      // blocks one of them rarely blocks all nine.
      let best = null;
      for (let ring = 0; ring < 4; ring++) {
        const r = 9 + ring * 2.5;
        for (let i = 0; i < 13; i++) {
          const az = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.16;
          const x = p.x + Math.sin(az) * r, z = p.z + Math.cos(az) * r;
          const y = groundY(x, z, p.y);
          if (Math.abs(y - p.y) > 7) continue;   // down a ravine or up a cliff
          const cand = new THREE.Vector3(x, y, z);
          for (const standoff of [24, 20, 28]) {
            for (const [lift, swing] of [[6.5, SWING], [10, SWING], [6.5, -SWING]]) {
              const c = camAt(cand, standoff, lift, swing);
              // The whole capsule, sampled across its width as well as up its
              // height — feet, shoulders and head. A dead tree that misses the
              // centre line still cuts the silhouette in half, and silhouette is
              // the axis this shot exists to be judged on.
              const vis = visibleFraction(c, cand, { height: bh, radius: 2.6, cols: 5, rows: 5, slack: 1.2 });
              // The survivor has to be in it too: this shot is a scale
              // comparison and a comparison needs both terms.
              const pvis = visibleFraction(c, p, { height: 1.9, radius: 0.6, cols: 3, rows: 3, slack: 0.6 });
              // The Colossus is a grey stone figure; parked against a cliff face it
              // is indistinguishable from the cliff. Open distance behind its
              // head gives the silhouette something to read against.
              const back = Math.min(backdropDepth(c, _probe.set(x, y + bh * 0.85, z)), 60);
              const score = vis * 10 + pvis * 3 + back * 0.03;
              if (!best || score > best.score) best = { spot: cand, cam: c, vis, pvis, score };
            }
          }
        }
      }
      if (!best) best = { spot: ahead(23), cam: null, vis: 0, pvis: 0, score: -1 };
      let spot = best.spot;
      let cam = best.cam ?? camAt(spot);

      if (boss && !boss.alive) boss = null;
      if (!boss && card) {
        boss = ctx.director?.spawnOne?.(ctx, card, spot, null) ?? null;
        if (boss && ctx.director) { boss.isBoss = true; ctx.director.boss = boss; }
      }
      if (boss) {
        boss.position.copy(spot);
        boss.home?.copy?.(spot);
        boss.velocity?.set?.(0, 0, 0);
      }
      declutter(15);

      // Shoot the boss. The frame is documented as judging the boss silhouette
      // and the boss HUD, and it shipped with a full health bar, a held trigger
      // and not one round connecting — no damage number, no hit flash. The
      // Colossus is pinned to `spot` for the duration so its readouts spawn where
      // the framing below expects it to be standing.
      if (boss) {
        await fireBurst(0.5, { pin: boss, at: spot });
        // Then let the trigger go. `Enemy.setFlash` is a boolean full-white
        // override held for 0.075 s after every hit, so shooting right up to
        // the shutter photographs the Colossus as a flat white cast — the exact
        // silhouette this frame exists to judge, with the silhouette removed.
        // Damage numbers live about a second and survive the gap.
        await fireBurst(0.14, { pin: boss, at: spot, fire: false });
      }

      // Face the camera. Nothing here ever set a yaw: the Colossus kept whatever
      // heading it had before it was teleported onto `spot`, which photographed
      // it ~80° off axis with its face, its core and both fists hidden. Three
      // quarters rather than dead-on — a flat front view loses the depth of the
      // shoulder mass.
      if (boss) {
        boss.yaw = Math.atan2(cam.x - spot.x, cam.z - spot.z) + 0.42;
        if (boss.rig?.root) boss.rig.root.rotation.y = boss.yaw;
      }

      detach();
      camera.position.copy(cam);
      camera.fov = 36;
      camera.updateProjectionMatrix();
      // Frame against the full capsule. This used to aim at `bh * 0.7` because
      // the Colossus's rig hung 1.25 m of each leg below the world and only ~0.7
      // of its 7.6 m capsule was ever drawn. The rig now fills 7.58 m of it, so
      // the fudge would crop the head it was invented to keep in frame.
      aimBetween(spot, bh, p);
      // Re-space the horde against the *final* lens rather than the gameplay
      // one: 30 m puts it just past the survivor at 24 m and short of the boss
      // at 33 m, and the screen-overlap pass in `declutter` can only do its job
      // once the camera it measures against is the one being photographed.
      declutter(30);
      // The survivor is half of this shot. It is documented as judging *scale*,
      // and scale is a comparison — a Colossus photographed alone at an unknown
      // distance carries no scale information at all. The first run under the
      // new assertion measured him at 0 px: the framing search had put a crest
      // between the final lens and where he happened to be standing.
      //
      // So if he is not in it, he is moved into it, on ground the lens has
      // raycast to, beside the boss's feet and a little nearer the camera.
      if (ctx.player) {
        camera.updateMatrixWorld(true);
        const bsn = screenOf(spot.x, spot.y + bh * 0.15, spot.z);
        if (visibleFraction(camera.position, playerPos(), { height: 1.9, radius: 0.6, cols: 3, rows: 3, slack: 0.5 }) < 0.4) {
          for (const [dx, dy] of [[0.19, 0.09], [-0.19, 0.09], [0.24, 0.14], [-0.24, 0.14], [0.19, 0.02]]) {
            const g = groundAtScreen(bsn.x + dx, bsn.y + dy, { minDist: 10, maxDist: 60 });
            if (!g) continue;
            ctx.player.position.copy(g);
            ctx.player.velocity?.set?.(0, 0, 0);
            if (ctx.player.group) ctx.player.group.position.copy(g);
            break;
          }
        }
      }
      if (boss) {
        boss.position.copy(spot);
        boss.velocity?.set?.(0, 0, 0);
        if (boss.rig?.root) boss.rig.root.position.copy(spot);
      }
      await frames(3);
      freeze();
      mustContain('05-boss', [
        { subject: 'the Basalt Colossus', objects: () => rigsOf([boss]), minPixels: 2000 },
        { subject: 'survivor (for scale)', objects: () => [ctx.player?.group], minPixels: 150 },
        {
          subject: 'boss health bar',
          dom: () => !!ctx.director?.boss?.alive && ctx.director.boss === boss,
          detail: () => ({ vis: +best.vis.toFixed(2), pvis: +best.pvis.toFixed(2) }),
        },
      ]);
    },

    async lateRun({ settleFrames = 60 } = {}) {
      await begin();
      attach();
      invulnerable();
      ctx.time = 22 * 60;
      for (let i = 0; i < ITEMS.length; i++) {
        ctx.items?.give?.(ITEMS[i].id, 1 + ((i * 7) % 12));
      }
      ctx.items?.addGold?.(4200);
      // The clock, the gold and the 37 items all said "late run"; the level did
      // not, because nothing here ever awarded XP and the shot inherited
      // whatever the preceding captures happened to kill. Drive it through the
      // real API so the bar, the level tag and the survivor's health all agree,
      // and land mid-level rather than on a boundary so the bar reads as live.
      seedLevel(20, 0.42);
      await frames(6);
      /* Known open regression. `placeForOpenArena()` was the proposed fix and it
       * is REFUTED — do not try it again without reading this.
       *
       * This scenario inherits wherever the previous one left the survivor and
       * only ever turns him on the spot, and its horde was already marginal:
       * measured on `reviews/round6/base/manifest.json`, `monsters under load`
       * passed with perPx [20, 35, 111, ...], its weakest member eight pixels
       * above the noise floor the gate calls absent. The `screenSlots` rewrite
       * above moved it the wrong side of that line —
       * `reviews/round6/harness/manifest.json` has [6, 22, 27, ...] and object 0
       * failing.
       *
       * The agent that found it proposed `await placeForOpenArena()` here, "the
       * same fix `04-combat` needed", and correctly left it unapplied because
       * `node_modules` had been destroyed and it could not measure. Applied and
       * measured once the toolchain was restored: perPx came back
       * [6, 22, 27, 251, 56, 72] — **byte-identical to the failing state**.
       * `reviews/round6/merged/manifest.json` (with `faceOpenGround`) and
       * `reviews/round6/merged2/manifest.json` (with `placeForOpenArena`) are
       * the two on-disk captures; the call changes nothing here. Reverted, so
       * the shipped code is the measured code.
       *
       * So the weak members are not mis-framed — they are small or occluded for
       * some other reason, and the real cause is still open. Whoever takes this
       * next: `spawnRing(10, ...)` and the `screenSlots` slot count above are
       * the places to look, not the camera. See `reviews/round6/FIX-harness.md`.
       */
      await faceOpenGround();
      /* The horde has to survive its own settle, and since `cf7e63e` it does
       * not. This is the same pin `invulnerable()` puts on the survivor, on the
       * other side of the fight, and it is here for the same reason: this shot
       * is graded on the HUD, and the loadout it needs to fill that HUD is one
       * no player ever holds.
       *
       * Measured, at `1911d79`, on a full run: the ten spawn at full health,
       * stand for fifty frames, and are then deleted in a single frame by one
       * chain-lightning proc — 46.2 damage of card text arriving as **86,648.9**
       * after the outgoing multipliers of the haul above (the loop covers all
       * 108 `ITEMS` at up to 12 stacks each; 97 of them land as held cards, the
       * count `a full inventory strip` reports below)
       * (`reviews/round7/captures/fix-loaded-hud/diag7-head/manifest.json`,
       * `DIAG kill`: that 86,648.9 is what eight of the ten took, and the
       * burrower's own line is `hp0 14280 -> hp1 0` on a `ret` of 37,673.5 —
       * still two and a half times its whole health bar).
       *
       * What that costs the photograph is not "the monsters are dead" — corpses
       * still draw. It is that `declutter` filters on `e.alive`, so with the
       * whole cast dead it finds nothing to move, runs **zero** passes, and the
       * caller's `maxDist: 28` below silently stops applying:
       *
       *   at `ddb1246` (alive)  before 21.6-46.5 m -> after 14.1-26.4 m, 8 moved, 2624 px, green
       *   at `1911d79` (dead)   before 29.9-41.9 m -> after 29.9-41.9 m, 0 moved,  815 px, red
       *
       * (`fix-loaded-hud/diag4-ddb1246` and `fix-loaded-hud/diag4-head`,
       * `DIAG declutter`.) So the subject is not mis-framed and it is not
       * mis-lit: it is ten corpses photographed at the far edge of a band the
       * composition pass was never given the chance to close.
       *
       * Health rather than `invuln`, because `invuln` is the burrower's — its
       * SUBMERGED state owns that flag and clears it on exit
       * (`src/entities/Enemy.js:1638,1666`) — and because pinning health is
       * blind to which damage path arrives, which is the whole problem here.
       * Restored at the shutter so nothing downstream inherits an unkillable
       * horde; the 86,648 is left alone, because a proc multiplier three orders
       * of magnitude over its card text is a balance question and this is a
       * camera.
       */
      const pinned = new Set(ctx.director?.enemies ?? []);
      spawnRing(10, SPAWN_CARDS, 14, 3);
      const hordePins = [];
      for (const e of ctx.director?.enemies ?? []) {
        if (pinned.has(e)) continue;
        hordePins.push({ e, health: e.health, maxHealth: e.maxHealth });
        e.maxHealth = 1e9;
        e.health = 1e9;
      }
      await frames(settleFrames);
      /* 28 m, not the default 46, and this is the fix for the regression above.
       *
       * `screenSlots` hands its far rank out first (see the note there), so ten
       * bodies in a 14-47 m band all landed in the back of it — measured at
       * 20.1 to 44.0 m, with the three smallest cards in the deck at 38.1, 40.1
       * and 44.0 (`reviews/round6/hdiag3/manifest.json`, `DIAG horde`). A mite at
       * 40 m is 6 px. Every lever inside `screenSlots` was tried first and made
       * the capture worse; the caller narrowing its own band is what works,
       * and it is the same mechanism and very nearly the same number `04-combat`
       * already uses for the same reason ("past about 30 m on this stage the fog
       * has taken enough of a monster that it stops standing off what is behind
       * it").
       *
       * The shot is documented as judging UI density under load, so the horde is
       * scenery: pulling it in costs nothing this frame is graded on. No
       * threshold moved — `minPixels` is still 300 across ten objects.
       */
      declutter(12, { maxDist: 28 });
      await frames(3);
      freeze();
      mustContain('06-loaded-hud', [
        { subject: 'survivor', objects: () => [ctx.player?.group], minPixels: 400 },
        {
          subject: 'monsters under load',
          objects: () => rigsOf(ctx.director?.enemies ?? []),
          perObject: true, minPixels: 300, minObjects: 3,
          crowd: 3, crowdWhy: 'director horde: an unbounded population, not a fixed cast',
        },
        {
          subject: 'a full inventory strip',
          dom: () => (ctx.hud?.inv?.size ?? 0) > 20,
          detail: () => ctx.hud?.inv?.size ?? 0,
        },
      ]);
      /* Then hand the horde the death its own frame had already earned it.
       *
       * After the shutter, because `mustContain` re-renders the scene to build
       * its per-object masks. And at all, because a horde this scenario spawned
       * and did not spend is a run the shots below were not composed against —
       * which is a claim about the shared RNG stream and the survivor's ledger,
       * NOT about bodies left standing. Bodies cannot leak from here: the next
       * scenario's `begin()` calls `ctx.director.clear(ctx)` (line 114), which
       * despawns every enemy alive or dead before anything is placed, and no
       * frame renders between this `freeze()` and that call. Do not re-derive
       * the old story from the numbers below.
       *
       * The numbers, three endings each captured full:
       *
       *  - release the pin and walk away
       *    (`reviews/round7/captures/fix-loaded-hud/after-alive/manifest.json`)
       *  - retire the bodies into the director's pools instead
       *    (`reviews/round7/captures/fix-loaded-hud/after-despawn/manifest.json`)
       *
       *    **byte-identical to each other** — `10-inventory` -> `monsters
       *    standing in it` 623 px, `perPx [37,25,14,104,130,123,60,130]`,
       *    `perSep [0.81,0.47,0.01,0.33,0.09,0.25,0.53,0.79]`, object 4 red at
       *    `sepP50` 0.09. Despawning ten bodies moved nothing, which is the
       *    measurement that kills the bodies-crowd-the-next-shot reading.
       *
       *  - kill them here (`.../after/manifest.json`): 565 px, green.
       *
       * What the kill actually spends, measured with `ctx.rng.next` counted
       * across this block: **644 RNG draws**, 19,011 gold and 15.8 XP of
       * on-kill procs. That is the difference — ten kills that happen against
       * ten that never do — and it is coarse rather than knife-edged: the crit
       * rolls below are worth 10 of those 644 and provably move nothing.
       *
       * `crit: false` for that reason, adopted on evidence rather than on
       * principle. `Combat.applyDamage` only skips its crit roll when
       * `info.crit` is defined (`src/systems/Combat.js:464-468`), and this
       * survivor's `critChance` is 0.902, so leaving it unset rolled ten dice
       * whose count depends on which items happen to grant crit. Pinned false,
       * and captured twice to prove the pinning is free:
       * `.../after-critfalse/manifest.json` and
       * `.../after-critfalse-repeat/manifest.json` are identical to `after` on
       * all three affected shots (2093 / 565 / 9).
       *
       * `procCoefficient: 0` because this is bookkeeping and must not start a
       * proc chain the frame never had. It does not gate `modifyOutgoing`
       * (`Combat.js:472`), which is where most of the 644 live; that is
       * deliberate — those are the survivor's own kills being paid for.
       */
      for (const p of hordePins) {
        p.e.maxHealth = p.maxHealth;
        p.e.health = Math.min(p.health, p.maxHealth);
        if (!p.e.alive) continue;
        ctx.combat?.applyDamage?.(p.e, p.maxHealth * 2, {
          source: ctx.player, position: p.e.position, type: 'lightning',
          procCoefficient: 0, procDepth: 1, crit: false,
        });
      }
    },

    /**
     * Prop close-up, on a bearing that can see the prop.
     *
     * The old version took the interactable nearest the player and parked the
     * lens at a hardcoded `t + (4.5, 2.6, 4.5)`. With a boulder on that
     * diagonal — which is most of them, since interactables are tucked against
     * cover — the shot is the inside of the boulder, and the frame that is the
     * only evidence for prop modelling and pickup VFX contains no prop.
     *
     * So: prefer the biggest, most interesting subject rather than the closest
     * one, then sweep bearings until the raycast says the prop is unoccluded.
     */
    async interactables({ settleFrames = 90 } = {}) {
      await begin();
      detach();
      const list = ctx.interactables?.list ?? [];
      const p = playerPos();
      // typeId ranking. Chests of every size outrank the shrines and the
      // multishop trio: the shot is documented as a chest close-up, and a
      // multishop terminal seen from behind is a black slab with no read.
      const RANK = { 8: 7, 7: 6, 1: 5, 3: 4, 4: 4, 2: 3 };
      const ranked = list
        .filter((o) => o?.position && !o.used && RANK[o.typeId])
        // Rank dominates; distance only breaks ties, so we do not travel the
        // whole map for a marginally better chest.
        .map((o) => ({ o, score: RANK[o.typeId] * 100 - Math.sqrt(o.position.distanceToSquared(p)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      // Cross-light: 70° off the sun bearing puts the key across the prop's
      // form instead of flattening it head-on or silhouetting it.
      const prefer = sunAzimuth() + 1.22;
      let t = null, cam = null, subject = null;
      // Three passes over the same ranking, each dropping one requirement.
      // Rejecting a subject outright is cheap — the stage carries twenty-odd
      // interactables — and a walled-in one is what produced two rounds of
      // "07-interactables contains no interactable".
      //
      // The sun test is the first thing asked for and the first thing dropped.
      // The placement search had no notion of light at all, so it happily chose
      // a shrine sitting in a pit: foreground, midground and background all
      // landed inside an 11-luma band, 48.8% of the frame in one histogram
      // bucket, nothing key-lit anywhere. That is not a grade problem and no
      // amount of fog will fix it — it is a shot of a subject the sun does not
      // reach.
      for (const [backdrop, needSun, maxForeground] of [[14, true, 0.25], [14, false, 0.25], [0, false, 1]]) {
        for (const { o } of ranked) {
          if (needSun && !sunlit(o.position)) continue;
          const blockers = list.filter((x) => x !== o && x?.position);
          const c = clearCam(o.position, {
            radius: 5.8, lift: 3.0, step: 1.3, rings: 5, prefer, backdrop, strict: true, blockers,
            fov: 32, maxForeground,
            subjectHeight: 2.2, subjectRadius: 1.1, minVisible: 0.85,
            maxOccluders: maxForeground < 1 ? 0.12 : 1,
          });
          if (!c) continue;
          t = o.position; cam = c; subject = o; break;
        }
        if (cam) break;
      }
      if (!cam) {
        subject = ranked[0]?.o ?? null;
        t = subject?.position ?? ahead(6, 0);
        cam = _probe.set(t.x + 4.5, t.y + 2.6, t.z + 4.5).clone();
      }

      camera.position.copy(cam);
      // Aim above the prop's centre so it sits on the lower third with the
      // terrain behind it carrying the upper frame, rather than dead centre.
      camera.lookAt(t.x, t.y + 1.3, t.z);
      // Long lens rather than a short standoff. The prop is the subject and it
      // has to fill the frame, but the clear-bearing search often cannot get
      // closer than 8-9 m without a rock in the way; narrowing the lens gets the
      // same magnification and crops the dead foreground wedge that a low, close
      // camera on sloping ground always picks up.
      camera.fov = 32;
      camera.updateProjectionMatrix();
      await frames(settleFrames);
      freeze();
      mustContain('07-interactables', [
        { subject: 'the interactable', objects: () => [subject?.group], minPixels: 2000 },
      ]);
    },

    /**
     * Peak VFX moment.
     *
     * **The shutter.** `blastSeconds` is the age of the *effect* at the frame
     * that gets photographed, in presentation seconds — the clock every VFX
     * lifetime in the game is written against. It used to be spent through
     * `waitSim`, i.e. in simulation seconds, and the two are not the same
     * clock: the blast's own kills raise hitstop, hitstop scales the fixed step
     * by 0.15, and the effect goes on ageing on the wall clock throughout. So
     * the parameter said 0.09 s and the shutter landed at **0.207 s** of the
     * blast's life — a factor of 2.3, load-dependent, and two rounds of VFX
     * tuning were done against it without anyone knowing the number.
     *
     * It is now measured and it is now exact (`waitFx` + the pinned capture
     * clock), and the measured age is written into the manifest as
     * `shutter (effect seconds)` so it can never silently drift again.
     *
     * **Why 0.12.** Measured, by photographing the same blast at five ages and
     * counting the pixels that carry their own edge (the light wash excluded —
     * see `minCarriedPx`):
     *
     * | effect age | carrying px | what is in the frame |
     * |---|---|---|
     * | 0.05 | 4,925 | core still a flashbulb |
     * | 0.09 | 4,925 | hot core, debris streaks starting |
     * | **0.12** | **10,726** | hot core, full debris fan, ring on the terrain |
     * | 0.16 | 8,227 | core falling off |
     * | 0.20 | 6,212 | warm haze; the round-2 critic's "large soft warm haze, |
     * |      |       | not a hot core with a defined edge" |
     * | 0.28 | 423 | over — the guard fires, `why: absent` |
     *
     * The round-5 VFX retune (core life 0.20 → 0.42 s, pip 0.16 → 0.28 s) was
     * made against the *accidental* 0.207 s shutter this file used to have. It
     * is not invalidated by moving earlier — a longer-lived core is more alive
     * at 0.12 s than at 0.20 s, and the measurement above is of the retuned
     * build. What it does invalidate is treating 0.207 as a target: it was
     * never chosen, and it sits past the peak of the effect it photographs.
     */
    async explosion({ blastSeconds = 0.12, settleFrames = 60 } = {}) {
      await begin();
      attach();
      invulnerable();
      // A peak-VFX shot of a level-1 survivor at 00:11 with $6 is a peak moment
      // in a run that has not started. The clock, the level and the purse are
      // seeded to a real mid-run state — but deliberately *not* the item strip,
      // which is permanent and would put an inventory panel over the corner of
      // `11-bestiary` and `12-boss-phases`, both of which are shot after this
      // one and neither of which documents an inventory.
      ctx.time = 12 * 60 + 38;
      seedLevel(11, 0.55);
      ctx.items?.addGold?.(1840);
      await frames(6);
      // Turn away from the sun before choosing the arena.
      //
      // The blast is additive: it reads against what is behind it, and what was
      // behind it was an 18° sunset disc. Measured on the frame that shipped
      // before this line existed — blast sited 16 m out, straight down the sun
      // bearing — the fireball's core came back at 1,816 mask pixels against a
      // sky already at L 200, and read as a lens flare. Starting the
      // open-ground sweep 180° off the sun costs nothing (the sweep still
      // rejects any bearing whose ground the lens cannot see) and gives the
      // effect a dark backdrop to be an explosion against.
      if (ctx.cameraRig) {
        ctx.cameraRig.yaw = sunAzimuth() + Math.PI;
        ctx.cameraRig.pitch = -0.12;
        await frames(3);
      }
      await faceOpenGround();
      spawnRing(12, SPAWN_CARDS, 13);
      // Same reason as `04-combat`: the victim list is the first seven of
      // `director.enemies`, and the director goes on spawning at `findSpawnPoint`
      // — off camera, by design — through every frame this scenario spends
      // composing. A reinforcement that lands in that slice is a declared victim
      // standing nowhere near the blast.
      if (ctx.director) {
        ctx.director.enabled = false;
        restoreAfterShutter(() => { ctx.director.enabled = true; });
      }
      if (ctx.input) ctx.input.mouse.left = true;
      await frames(settleFrames);
      // Nothing underground or mid-blink before the victims are placed: a
      // burrower is under for 2.4 s and a stalker's dash hides its rig for
      // 0.35 s, and either photographs as a victim that contributed no pixels to
      // its own explosion. Waited out *here* rather than next to the shutter,
      // because the wait costs frames and those frames would undo the ring
      // the victims are about to be laid out on.
      await awaitVisibleHorde();
      declutter(12);

      // Where the blast goes.
      //
      // Sited in screen space, like everything else this file places. `ahead(d,
      // 4.5)` is a world offset off camera forward with a single centre-ray
      // check, and it put the fireball behind the ridge the survivor was
      // standing on: the shot came back with a shake, one damage number and no
      // blast in it at all, measured at 540 mask pixels.
      //
      // The version after that fixed presence and not composition, and the
      // round-2 critic measured the result: the blast sat "in empty sky at
      // y=236 with its lower half behind a foreground rock" — screen y 0.26,
      // i.e. the top quarter of the frame. Two consequences, both fatal to the
      // axis this shot exists to be judged on. The shockwave ring and the
      // distortion layer had nothing behind them to act *on* (both are read
      // against geometry, and there was none — only sky), and the fireball's
      // lower half, where the light contribution lands on the ground, was
      // behind a rock.
      //
      // So the ground point and the lift are searched together against what the
      // *fireball's centre* projects to, not against what the ground point
      // does, and the whole sphere is sampled rather than one ray:
      //
      //  - the centre wants to sit in the middle band of the frame (0.42-0.60),
      //    where it has terrain behind it and the ground beneath it in shot;
      //  - the sphere's extremes — top, bottom and both flanks at the blast
      //    radius — must be unoccluded, which is what a foreground rock over
      //    the lower half fails;
      //  - and it must clear the terrain it stands over, or the bottom of a
      //    six-metre fireball is inside the hill.
      const BLAST_R = 6;
      camera.updateMatrixWorld(true);
      // Where the survivor is, so the blast is not sited behind him. He stands
      // near the middle of a third-person frame, the blast is drawn additively,
      // and at 13 m the fireball is smaller on screen than he is — put them on
      // the same bearing and the shot is a survivor with a halo. Measured at a
      // 0.09 s age with the blast at screen (0.439, 0.420) and the survivor at
      // (0.43, 0.55): the core is bisected by his own silhouette.
      const pp0 = playerPos();
      const ps0 = screenOf(pp0.x, pp0.y + 1.0, pp0.z);
      const camRight = new THREE.Vector3();
      camera.getWorldDirection(camRight);
      camRight.set(-camRight.z, 0, camRight.x).normalize();
      //
      // Depth is a hard constraint, not a preference. The first cut of this
      // search scored only on where the centre landed in frame and picked a
      // ground point 25 m out, because a distant blast can satisfy any
      // screen-position test you like — and a six-metre fireball at 25 m is a
      // 200 px smudge under a mountain. The shot is documented as the peak VFX
      // moment: the blast has to be a *foreground* event, so the ground point
      // is restricted to 10-18 m and the score pulls toward 13.
      //
      // Three passes, each dropping one requirement, the same shape
      // `07-interactables` needed after two rounds of shipping shots that did
      // not contain their subject. A single strict pass is not a guard: on the
      // stage this scenario actually runs on it found nothing at all and fell
      // through to a blind `ahead(12, 3.4)`, which put the blast 40 m out
      // beside the sun and contributed 293 px. `pass` and `distM` are published
      // so a fallback can never again look like a search result.
      let at = null, atScore = -Infinity, atDist = 0, atPass = -1;
      const PASSES = [
        { near: 9, far: 15, clear: 0.22, seen: 4, top: 0.34, bot: 0.66 },
        { near: 9, far: 24, clear: 0.15, seen: 3, top: 0.30, bot: 0.70 },
        { near: 8, far: 30, clear: 0.10, seen: 2, top: 0.22, bot: 0.78 },
      ];
      for (let pi = 0; pi < PASSES.length && !at; pi++) {
        const P = PASSES[pi];
        for (const sy of [0.66, 0.72, 0.60, 0.78, 0.54]) {
          for (const sx of [0.56, 0.50, 0.62, 0.68, 0.44, 0.36]) {
            const g = groundAtScreen(sx, sy, { minDist: P.near, maxDist: P.far });
            if (!g) continue;
            const dist = Math.hypot(g.x - camera.position.x, g.z - camera.position.z);
            for (const lift of [3.0, 3.6, 2.4, 4.4]) {
              const c = new THREE.Vector3(g.x, g.y + lift, g.z);
              if (!seesTarget(camera.position, c, 0.2)) continue;
              const cs = screenOf(c.x, c.y, c.z);
              if (cs.front <= 0 || cs.y < P.top || cs.y > P.bot) continue;
              if (!onScreen(c.x, c.y, c.z, 0.10)) continue;
              // Screen distance from the survivor's own silhouette. 0.22 of
              // frame is about one survivor-width plus the fireball's near
              // radius at this standoff — below that the core is behind him.
              const clear = ps0.front > 0 ? Math.hypot(cs.x - ps0.x, cs.y - ps0.y) : 1;
              if (clear < P.clear) continue;
              // Five points on the fireball, not one at its centre.
              let seen = 0;
              for (const [dx, dy] of [[0, 0.8], [0, -0.7], [1, 0], [-1, 0], [0.7, 0.5]]) {
                const px = c.x + camRight.x * dx * BLAST_R * 0.8;
                const pz = c.z + camRight.z * dx * BLAST_R * 0.8;
                const py = c.y + dy * BLAST_R * 0.8;
                if (seesTarget(camera.position, _cc.set(px, py, pz), 0.2)) seen++;
              }
              if (seen < P.seen) continue;
              // Prefer the centre near 0.50 of frame height, the sphere fully
              // clear over merely mostly clear, and 13 m over the extremes of
              // the allowed depth band.
              const score = seen * 4
                - Math.abs(cs.y - 0.50) * 12
                - Math.abs(cs.x - 0.52) * 4
                - Math.abs(dist - 11) * 1.2
                + Math.min(clear, 0.34) * 14;
              if (score > atScore) { atScore = score; at = c; atDist = dist; atPass = pi; }
            }
          }
        }
      }
      if (!at) console.error('[harness] 08-explosion: no sited blast on any pass; using the blind fallback');
      at = at ?? ahead(12, 3.4);

      // Put monsters inside the blast. An explosion over empty ground is a
      // light source, not impact feedback — the shot is documented as
      // "explosion + damage numbers + shake" and the numbers only exist if
      // something is standing in it.
      // Ringed in *screen* space around the blast. The world-space ring dropped
      // each victim on `sampleHeight` with no visibility test — the same
      // construction that put all twenty-four of `04-combat`'s monsters at the
      // bottom of a cliff.
      camera.updateMatrixWorld(true);
      const bs = screenOf(at.x, at.y, at.z);
      const victims = (ctx.director?.enemies ?? []).filter((e) => e.alive).slice(0, 7);
      /* The ring is 0.16 of frame width, not 0.105, and that is a legibility fix
       * rather than a placement one.
       *
       * A damage number spawns at the victim it belongs to. At 0.105 every one of
       * the seven stood inside the fireball's own footprint, so every readout was
       * drawn over the brightest thing in the frame: measured on
       * `reviews/round6/base/08-explosion.png`, the numbers came back at 191 px
       * with lum 54.8 against bgLum 40.8 and sepP50 0.23 — under the 0.25 floor,
       * in the shot documented as judging impact feedback. Standing the victims
       * a frame-width further out puts their readouts against terrain instead of
       * against the core, and takes them out of the peak of the knockback
       * impulse as well: 0.16 of frame at this standoff is ~4 m from the centre
       * of an 8 m blast, so they are still standing in it.
       */
      victims.forEach((e, i) => {
        const a = (i / Math.max(1, victims.length)) * Math.PI * 2;
        /* Where the damage numbers are read against, and why moving the victims
         * is REFUTED as the lever — do not spend another capture on it.
         *
         * Once the mask stopped being measured through a broken depth lookup
         * (see `_pinSoftResolution`) this subject came back at `sepP50 0.23`
         * against the 0.25 floor, with a mask centroid at screen
         * **(0.629, 0.246)** and `lum 63.9` against `bgLum 63.0` — white glyphs
         * over a sunset sky of exactly their own value
         * (`reviews/round6/hfix/manifest.json`). The obvious reading is that the
         * readouts follow their victims, so standing the ring lower in frame
         * would put them over terrain.
         *
         * Applied and captured to `reviews/round6/hfix2/manifest.json` as
         * `sin(a) * 0.10 + 0.07`: the victims demonstrably moved — `monsters
         * standing in it` went `perPx [134,97,55,1228,...]` -> `[32,313,270,250,...]`
         * — and the damage-number mask **did not**, staying at (0.629, 0.244)
         * with `sepP50 0.23` and `lum 63.9 / bgLum 63.8`. The centroid sits on
         * the blast's own screen position (0.622), not on the victims: what this
         * subject is measuring is one readout drawn at the blast, and no victim
         * placement reaches it. Reverted.
         */
        const g = groundAtScreen(bs.x + Math.cos(a) * 0.16, bs.y + Math.sin(a) * 0.075,
                                 { minDist: 7, maxDist: 40 });
        if (g) { _seat(e, g); return; }
        const x = at.x + Math.cos(a) * 5.5, z = at.z + Math.sin(a) * 5.5;
        _seat(e, _cc.set(x, groundY(x, z, at.y), z));
      });
      await frames(2);

      ctx.vfx?.explosion?.(at, BLAST_R);
      ctx.combat?.explode?.(at, 8, 300, null, {});
      ctx.pipeline?.addShake?.(0.5);
      const shutter = await waitFx(blastSeconds);
      freeze();
      camera.updateMatrixWorld(true);
      const blastScreen = screenOf(at.x, at.y, at.z);
      mustContain('08-explosion', [
        {
          subject: 'the blast',
          objects: () => vfxObjects(/^vfx\.(particles|rings|trails|beams)$/),
          // 1200 px of fireball, ring and debris that each stand off what is
          // behind them — the light wash the blast throws across the terrain no
          // longer counts toward it.
          minPixels: 1200, minCarriedPx: 1200,
          /* Counted inside the fireball's own footprint, and published per pool.
           *
           * Two separate holes were letting this check certify without observing
           * the blast, and they compounded.
           *
           * 1. **It was not measuring the blast.** The four objects it names are
           *    the engine's shared VFX buffers — every muzzle flash, tracer,
           *    hit spark and death ember alive anywhere in the frame draws into
           *    the same pools. Their whole contribution is the frame's VFX
           *    budget, not this event. The region is a disc of twice the blast
           *    radius about the blast's own projected centre, so what is counted
           *    is the effect this scenario fired, at the place it fired it. It is
           *    strictly subtractive — every pixel it removes was being counted
           *    before, so no shot can pass under it that failed before.
           *
           * 2. **`minCarriedPx` bought an exemption from per-object reporting**,
           *    on the grounds that shared pools are not nameable objects. They
           *    are not nameable *to a viewer*; they are perfectly nameable in the
           *    manifest, and the exemption is how `vfx.rings` contributing
           *    **exactly zero** stayed invisible inside a union sum for five
           *    captures. `perObject` and `pools` are on, so every pool's own
           *    pixel count is on the record whether or not it is gated.
           *
           * **What a zero inside this check looks like.** The union `px` and
           * `carriedPx` are the gate and are unchanged at 1200 each. Beside them
           * `perPx` now carries one entry per pool and `detail.pools` names them
           * in the same order, so an empty pool reads as `vfx.rings: 0` rather
           * than as a sum that happens to clear. It is deliberately *not* gated
           * per pool: on this frame `vfx.rings` is legitimately 0, because
           * `RingFrag` fades a ground-plane ring out as it goes edge-on and this
           * lens sits 7.6 deg above a blast 11 m away — the guard working, not a
           * missing ring (`reviews/round6/hdiag2/manifest.json`). A per-pool
           * floor would fail the shot for a ring that is correctly absent. The
           * zero is published so a reader decides that, instead of a sum
           * deciding it for them.
           *
           * `at` and `box` on the check are where the counted pixels actually
           * landed, in frame fractions. A blast measured at the far corner of
           * the frame is not this blast, and that is now visible.
           */
          perObject: true,
          region: () => ({
            x: blastScreen.x, y: blastScreen.y,
            r: screenHalf(BLAST_R * 2, camera.position.distanceTo(at)),
          }),
          detail: () => ({
            pools: vfxObjects(/^vfx\.(particles|rings|trails|beams)$/).map((o) => o.name),
            distM: +camera.position.distanceTo(at).toFixed(1),
          }),
        },
        {
          subject: 'monsters standing in it',
          objects: () => rigsOf(victims),
          perObject: true, minPixels: 200, minObjects: 2,
          // Monsters thrown by a blast: some leave the frame, some end up
          // behind the fireball. Two have to be individually visible standing
          // in it; requiring all of them would be requiring the blast not to
          // move them.
          crowd: 2, crowdWhy: 'blast victims: knockback removes members from frame by design',
        },
        { subject: 'damage numbers', objects: () => vfxObjects(/^vfx\.damageNumbers$/), minPixels: 60 },
        // Composition, recorded on every run so a regression to "blast in empty
        // sky at screen y 0.26" is visible in the manifest without a critic.
        {
          subject: 'blast framed in the middle band',
          dom: () => blastScreen.y > 0.34 && blastScreen.y < 0.66,
          detail: () => ({
            x: +blastScreen.x.toFixed(3), y: +blastScreen.y.toFixed(3),
            distM: +atDist.toFixed(1), pass: atPass,
          }),
        },
        { subject: 'shutter (effect seconds)', dom: () => shutter?.exact === true, detail: () => shutter },
      ]);
    },

    /**
     * A heavy monster killed with damage to spare, photographed with the corpse
     * mid-launch and its element's kill burst live.
     *
     * The shot the readability-juice slice exists to make possible, and the one
     * question it is graded on: **does a kill read as an event.** Everything
     * else this slice shipped is a colour lookup or a table; this is the frame
     * where a player would notice.
     *
     * It is built off `explosion`, which is the closest existing analogue — a
     * VFX-peak frame with a declared subject — and keeps its idiom throughout:
     * `begin()` / `attach()` / `invulnerable()`, the sun turned away from
     * before the arena is chosen, the director disabled across the composition
     * and restored after the shutter, and a `mustContain` whose subjects are
     * measured in pixels rather than asserted in prose.
     *
     * ## Where the six frames come from
     *
     * `VFX.corpseLaunch` throws the body at `LAUNCH.maxSpeed * k` with
     * `vy = speed * 0.62` against `LAUNCH.gravity`, so a full-power launch
     * (`k = 1`, which a five-pool overkill buys outright) has `vy = 6.82 m/s`
     * and apexes at `vy / gravity = 0.31 s`. Photographing the apex would be a
     * picture of a body *floating*: zero vertical velocity, level with the
     * lens, indistinguishable from a hover. Six frames at the pinned 1/60 is
     * 0.1 s — a third of the way up, `y = vy*t - g*t^2/2 = 0.57 m` off the
     * ground it died on and still rising hard, which is the part of the arc
     * that reads as *thrown*.
     *
     * The value is a parameter and the frame it produced is on disk
     * (`reviews/round9/money-shot/`), with the measured height published in the
     * manifest under `the corpse is off the ground it died on` — so the next
     * person to retune it is arguing against a number rather than against a
     * memory.
     *
     * ## Why the killing blow is `applyDamage` and not the trigger
     *
     * The shutter has to open a fixed number of frames after *the killing
     * blow*, and a held trigger cannot say when that was: the survivor's own
     * fire rate, the scarabs wandering into his line and the hulk's own
     * approach all move it. `ctx.combat.applyDamage` is the same call the
     * player's weapon makes — same event, same `overkill`, same `type` on the
     * payload, `ctx.player` as the source so the body is thrown away from him —
     * and it is the same idiom `08-explosion` already uses when it drives
     * `ctx.combat.explode` directly. What is *not* faked is any part of the
     * effect: `VFX._onKill` runs off the real `kill` event and nothing here
     * calls `corpseLaunch` or `particles.emit` by hand.
     *
     * `fire` is the declared element, and it is declared rather than inherited
     * so the shot is of a *chosen* signature: `KILL_SIGNATURE.fire` is the one
     * whose embers rise and hang (`gravity: -3`, `life: 1.10`), which is still
     * live and climbing at 0.1 s where `shock`'s 0.32 s bolts would already be
     * halfway gone.
     */
    async overkill({ launchFrames = 12, settleFrames = 45, element = 'fire', overkillPools = 5,
                     lensMetres = 12 } = {}) {
      await begin();
      attach();
      invulnerable();
      // A real mid-run state, for the same reason `08-explosion` seeds one: a
      // peak moment in a run that has not started is not a peak moment.
      ctx.time = 14 * 60 + 20;
      seedLevel(14, 0.4);
      ctx.items?.addGold?.(2100);
      await frames(6);
      // Same reason as `08-explosion`: the burst is additive and reads against
      // what is behind it, and an 18-degree sunset disc is not a backdrop.
      if (ctx.cameraRig) {
        ctx.cameraRig.yaw = sunAzimuth() + Math.PI;
        ctx.cameraRig.pitch = -0.10;
        await frames(3);
      }
      await faceOpenGround();
      // The cast is fixed and hand-placed, so a reinforcement landing mid-
      // composition is a body standing somewhere nobody chose — the same
      // failure `04-combat` and `08-explosion` both turn the director off for.
      if (ctx.director) {
        ctx.director.enabled = false;
        restoreAfterShutter(() => { ctx.director.enabled = true; });
      }

      const hulkDef = SPAWN_CARDS.find((c) => c.id === 'hulk');
      const scarabDef = SPAWN_CARDS.find((c) => c.id === 'scarab');
      const spawnAt = (def, at) => ctx.director?.spawnOne?.(ctx, def, at, null) ?? null;

      // Sited in screen space, like everything else this file places. ~9 m puts
      // a 4.2 m hulk large enough in frame that the launch is a visible
      // displacement rather than a two-pixel hop, and leaves the four scarabs
      // room to flank without stacking on him.
      camera.updateMatrixWorld(true);
      const site = groundAtScreen(0.52, 0.62, { minDist: 8, maxDist: 11 })
        ?? groundAtScreen(0.52, 0.58, { minDist: 7, maxDist: 14 })
        ?? ahead(9, 0);
      const hulk = spawnAt(hulkDef, site);
      const scarabs = [];
      for (let i = 0; i < 4; i++) {
        const a = (i - 1.5) * 0.42;
        const g = groundAtScreen(0.52 + Math.sin(a) * 0.20, 0.64 + (i % 2) * 0.05,
                                 { minDist: 7, maxDist: 15 });
        const at = g ?? _cc.set(site.x + Math.cos(a) * 4.5,
                                groundY(site.x + Math.cos(a) * 4.5, site.z + Math.sin(a) * 4.5, site.y),
                                site.z + Math.sin(a) * 4.5);
        const b = spawnAt(scarabDef, at);
        if (b) scarabs.push(b);
      }
      if (!hulk) console.error('[harness] 19-overkill: the hulk refused to spawn');
      await frames(settleFrames);
      // Past the 0.45 s spawn pop and out of any burrow/blink state, then
      // re-seat: the cast walks at the survivor across the settle, and a hulk
      // that has closed to 3 m is a cropped torso rather than a body with room
      // to be thrown into.
      await awaitVisibleHorde();
      camera.updateMatrixWorld(true);
      const reseat = groundAtScreen(0.52, 0.62, { minDist: 8, maxDist: 11 });
      if (hulk && reseat) _seat(hulk, reseat);
      scarabs.forEach((b, i) => {
        const a = (i - 1.5) * 0.42;
        const g = groundAtScreen(0.52 + Math.sin(a) * 0.20, 0.64 + (i % 2) * 0.05,
                                 { minDist: 7, maxDist: 15 });
        if (g) _seat(b, g);
      });
      await frames(2);

      /* The lens, chosen rather than inherited — and this is the one place this
       * scenario departs from `08-explosion`'s idiom, on measurement.
       *
       * Shot from the third-person boom the survivor carries, the death point
       * sits **14.6 m from the lens**, and from there the kill burst is not in
       * the photograph: eighteen sprites 0.14 m across, emitted at the victim's
       * position inside a 0.35 m shell — i.e. *inside the body* of a 4.2 m hulk
       * with a 1.25 m radius. Measured from the boom, the burst contributed
       * **1 px at 6 frames and 43 at 10**.
       *
       * A detached lens stood off the death point fixes it, and the standoff
       * and the shutter were chosen together off a 3x4 grid run on a **fresh
       * page per cell** (the sweep table is in the task report). Fresh matters:
       * an earlier sweep that reused one page read the burst at 400-2600 px and
       * every one of those numbers was a lie — the particle and ring pools are
       * shared, the previous arm's corpses were seated on nearly the same spot,
       * and the region was counting *their* deaths.
       *
       * What the honest grid says: the burst is small everywhere. Carried px
       * ran **148-220 across all twelve cells**, best at 11-12 m of standoff
       * (216-220) and worst close in (148-174), because a corpse thrown toward
       * a near lens eclipses the effect it came from. The corpse runs the other
       * way — it is dissolving and receding, so it falls from 3805 carried px
       * at 12 frames to 459 at 20. The chosen cell is the one where all three
       * subjects are clear at once: standoff ~11 m, twelve frames.
       *
       * The floors below are set from that grid rather than from taste, which
       * is the same rule `MIN_SEPARATION` is set by. A frame with no burst in
       * it reads 1 px; the grid's worst legitimate cell reads 78 carried and
       * its best 220. 120 sits in the empty band between those populations,
       * nearer the failure than the pass so it cannot be cleared by noise.
       *
       * The bearing is searched rather than fixed, for the same reason
       * `02-vista`'s is: a fixed world diagonal finds a canyon wall on some
       * stages.
       */
      // Where the burst will be, captured before the blow. `VFX._onKill` emits
      // at the victim's position at the moment of death and the burst then
      // stays there while the *corpse* leaves — so a region centred on the
      // corpse at the shutter drifts off the effect it is counting, by
      // `LAUNCH.maxSpeed * t` per second. This is the same construction
      // `08-explosion` uses (the blast's own sited centre, not a victim's).
      const deathAt = hulk ? hulk.position.clone() : null;
      const lensAt = deathAt ?? playerPos();
      // Published in the manifest so a reader can tell a searched lens from
      // the boom fallback without re-deriving it from the camera matrix.
      let lensPick = null;
      {
        const p = playerPos();
        const axis = Math.atan2(lensAt.x - p.x, lensAt.z - p.z);
        detach();
        const home = camera.position.clone();
        let best = null, bestScore = -Infinity;
        /* Set-and-test rather than score-then-set, because the survivor is a
         * declared subject and "the lens can see him" is not the same question
         * as "he is in the photograph". A first cut scored on `seesTarget`
         * alone — an occlusion ray, which is blind to the frustum — picked a
         * bearing that cleared every obstacle, and the survivor came back at
         * **0 px on all five delays of the shutter sweep**: off the edge of
         * frame, unoccluded the whole time. So each candidate is actually
         * mounted and its subjects projected through the real camera.
         */
        /* The bearing set reaches past a profile to `swing ~ pi` — the lens on
         * the far side of the corpse, looking back down the throw with the
         * survivor beyond it — and that is the half of the sweep that actually
         * works. The geometry is over-constrained otherwise: the corpse and the
         * survivor stand ~9 m apart, so a lens 6.5 m off the corpse at a 54 deg
         * swing puts the survivor ~80 deg off centre against a ~44 deg
         * half-frame, and every near candidate fails `onScreen` on him. The
         * search then settled on its widest standoff (10 m, published in the
         * manifest as `lens.standoffM`) and the burst came back at 253 carried
         * px against a 300 floor. Shooting back along the throw resolves it in
         * the direction the shot wants anyway: both subjects are on one line so
         * both are in frame at any standoff, and the corpse is thrown *toward*
         * the lens rather than away from it.
         */
        for (const dist of [lensMetres, lensMetres + 1.8, lensMetres - 1.0, lensMetres + 3.5]) {
          for (const swing of [2.9, -2.9, 2.5, -2.5, 2.1, -2.1,
                               0.95, -0.95, 1.25, -1.25, 1.6, -1.6, 0.65, -0.65]) {
            const az = axis + Math.PI + swing;
            const cx = lensAt.x + Math.sin(az) * dist;
            const cz = lensAt.z + Math.cos(az) * dist;
            const cy = Math.max(groundY(cx, cz, lensAt.y) + 1.6, lensAt.y + 2.2);
            const pos = _probe.set(cx, cy, cz);
            if (!seesTarget(pos, _cc.set(lensAt.x, lensAt.y + 1.6, lensAt.z), 0.4)) continue;
            if (!seesTarget(pos, _cc.set(p.x, p.y + 1.0, p.z), 0.4)) continue;
            camera.position.set(cx, cy, cz);
            camera.lookAt(lensAt.x, lensAt.y + 1.5, lensAt.z);
            camera.updateMatrixWorld(true);
            if (!onScreen(lensAt.x, lensAt.y + 1.6, lensAt.z, 0.10)) continue;
            if (!onScreen(p.x, p.y + 1.0, p.z, 0.04)) continue;
            const ps = screenOf(p.x, p.y + 1.0, p.z);
            // Prefer the survivor off the corpse's own screen position (he is
            // scenery here, and a survivor fused with the subject is the same
            // defect `08-explosion` sites its blast to avoid), prefer the swing
            // that reads as a three-quarter view rather than a profile, and
            // prefer the nearest standoff that satisfies both — every metre
            // costs the burst pixels quadratically.
            const cs = screenOf(lensAt.x, lensAt.y + 1.5, lensAt.z);
            const sep = Math.hypot(ps.x - cs.x, ps.y - cs.y);
            // Near beats far, hard: every metre of standoff costs the burst
            // pixels quadratically, and it is the burst that is scarce here.
            // Separation is preferred up to a cap so the survivor is not fused
            // with the subject; beyond that cap it buys nothing.
            const score = Math.min(sep, 0.30) * 10 - (dist - lensMetres) * 0.9;
            if (score > bestScore) { bestScore = score; best = { cx, cy, cz, dist, swing }; }
          }
        }
        if (!best) {
          console.error('[harness] 19-overkill: no lens bearing framed both subjects; using the boom');
          camera.position.copy(home);
          attach();
        } else {
          camera.position.set(best.cx, best.cy, best.cz);
          camera.lookAt(lensAt.x, lensAt.y + 1.5, lensAt.z);
          camera.updateMatrixWorld(true);
          lensPick = { standoffM: +best.dist.toFixed(2), swingRad: best.swing };
        }
      }

      // Where it died, and how far off that ground it has to be at the shutter.
      // Sampled *before* the blow, because `_updateLaunches` writes into the
      // rig root's position and reading the ground off the corpse afterwards
      // would be reading the launch out of its own reference.
      const deathGround = hulk ? groundY(hulk.position.x, hulk.position.z, hulk.position.y) : 0;
      const pool = hulk?.maxHealth ?? 0;

      // The killing blow. Five pools of damage into a full-health hulk leaves
      // `overkill / maxHealth` at ~5, far past `LAUNCH.minOverkillFrac` (0.35),
      // so `k` clamps to 1 and the throw is at full `LAUNCH.maxSpeed` — this
      // shot documents the top of the effect, not a median one.
      if (hulk) {
        ctx.combat?.applyDamage?.(hulk, pool * overkillPools, {
          source: ctx.player, position: hulk.position.clone(), type: element,
        });
      }
      await frames(launchFrames);
      freeze();
      camera.updateMatrixWorld(true);

      const root = hulk?.rig?.root ?? null;
      const rootWorld = root ? root.getWorldPosition(new THREE.Vector3()) : null;
      const liftM = rootWorld ? rootWorld.y - deathGround : 0;
      const burstScreen = deathAt ? screenOf(deathAt.x, deathAt.y + 1.4, deathAt.z) : null;
      const burstDist = deathAt ? camera.position.distanceTo(deathAt) : 0;
      mustContain('19-overkill', [
        {
          // The rig root itself, not the entity: `resolveObject` learning to
          // see a rig is what made the launch reach anything at all (see
          // `VFX.resolveObject`), so the object this check names is precisely
          // the one the feature moves.
          subject: 'the launched corpse',
          objects: () => rigsOf([hulk]),
          minPixels: 900, perObject: true,
          detail: () => ({
            id: hulk?.def?.id ?? null,
            liftMetres: +liftM.toFixed(3),
            launchFrames,
            overkillFrac: pool ? +((pool * overkillPools - pool) / pool).toFixed(2) : null,
            lens: lensPick,
          }),
        },
        {
          /* The kill burst, aggregated — and the reason, stated rather than
           * inherited.
           *
           * `aggregateWhy` is the `toleratedAbsences` contract: a subject that
           * opts out of per-object gating owes the manifest a sentence saying
           * why its objects are not individually nameable. These are the
           * engine's shared particle and ring pools — the same four buffers
           * `08-explosion` names — so "the burst" is not a mesh anywhere in the
           * scene graph, it is a region of two pools. `perObject` stays on so
           * every pool's own count is still published beside the sum: an
           * absence is visible even where it is not gated.
           *
           * Counted inside a disc about the corpse's own projected position,
           * exactly as `08-explosion` counts its blast, so what is measured is
           * this kill rather than the frame's whole VFX budget.
           */
          subject: 'the kill burst',
          objects: () => vfxObjects(/^vfx\.(particles|rings|trails|beams)$/),
          minPixels: 150, minCarriedPx: 120, perObject: true,
          aggregateWhy: 'VFX buffers: the kill burst and its ring are the engine\'s shared particle/ring pools, not nameable objects',
          region: () => (burstScreen
            ? { x: burstScreen.x, y: burstScreen.y, r: screenHalf(4.5, burstDist) }
            : null),
          detail: () => ({
            element,
            signature: ctx.vfx?.killSignature?.(element) ?? null,
            pools: vfxObjects(/^vfx\.(particles|rings|trails|beams)$/).map((o) => o.name),
            distM: +burstDist.toFixed(1),
            regionAt: burstScreen ? [+burstScreen.x.toFixed(3), +burstScreen.y.toFixed(3)] : null,
          }),
        },
        { subject: 'the survivor', objects: () => [ctx.player?.group], minPixels: 400 },
        // The arc, gated. A corpse standing exactly where it died is this
        // shot's specific failure — the frame would look plausible and document
        // nothing — so the height is an assertion and not a caption.
        {
          subject: 'the corpse is off the ground it died on',
          dom: () => liftM > 0.25,
          detail: () => ({
            liftMetres: +liftM.toFixed(3),
            deathGroundY: +deathGround.toFixed(3),
            rootY: rootWorld ? +rootWorld.y.toFixed(3) : null,
            launchFrames,
          }),
        },
      ]);
      return { liftMetres: +liftM.toFixed(3), element, launchFrames };
    },

    /**
     * Dense late-run inventory plus a live equipment activation.
     *
     * This shot exists to be graded on two things the other nine cannot show:
     * the *craft of the item icons* (axes 7 and 10 — 80-odd emblems that have
     * to read as one authored set at 33px, inside a tier where the plate colour
     * is identical for every card) and the *quality of an equipment effect*.
     *
     * So it is deliberately not `lateRun` with more items. Three differences:
     *
     *  1. **Every tier is represented, in bulk.** `lateRun` gives one of each
     *     item; a strip with one white and one red in it does not test whether
     *     twenty-eight whites are distinguishable from each other, which is the
     *     actual risk with a procedurally drawn icon set.
     *  2. **The equipment is fired on the shutter.** The activation is the last
     *     thing that happens before the loop stops, budgeted in *simulation*
     *     seconds like `08-explosion` — a nuke photographed 0.6s late is a
     *     picture of smoke.
     *  3. **There are monsters standing in it.** An equipment blast over empty
     *     ground is a light source, not an effect; the damage numbers and the
     *     bodies are what make it gradeable.
     */
    async inventory({ settleFrames = 60, blastSeconds = 0.12, equipment = 'overload-cell' } = {}) {
      await begin();
      attach();
      invulnerable();
      ctx.time = 26 * 60;

      // Fill the strip. Counts are staggered rather than uniform so the stack
      // badges vary — a wall of identical "x4" tells the critic nothing about
      // how the badge behaves against a one-digit, two-digit and absent count.
      for (let i = 0; i < ITEMS.length; i++) {
        const def = ITEMS[i];
        // Lunar stacks are kept to one. Two Shattered Covenants is a survivor
        // at a third of his health, and the shot would be documenting a death
        // scrim instead of an inventory.
        const n = def.tier === 'lunar' ? 1 : 1 + ((i * 5) % 9);
        ctx.items?.give?.(def.id, n);
      }
      ctx.items?.addGold?.(6400);
      seedLevel(24, 0.6);
      ctx.items?.setEquipment?.(equipment);

      await frames(6);
      await faceOpenGround();
      spawnRing(12, SPAWN_CARDS, 13, 4);
      if (ctx.input) ctx.input.mouse.left = true;
      await frames(settleFrames);
      // Let the trigger go before counting bodies. A survivor holding one of
      // every item in the game clears twelve monsters inside the settle — the
      // first run under the subject assertion found *zero* alive at the shutter,
      // so the nova went off over empty ground and the shot documented a light
      // source instead of an effect.
      if (ctx.input) ctx.input.mouse.left = false;
      declutter(11);

      // Then spawn a fresh pack and hold it alive.
      //
      // Releasing the trigger was not enough and neither was topping the crowd
      // up: with one of every item in the game the on-kill procs chain straight
      // through a replacement pack inside half a second, and the second run
      // still measured zero alive at the shutter. So the pack is pinned at full
      // health across the settle. It still takes the nova — the damage numbers
      // this frame needs are the *nova's* — it just stops dying to the inventory
      // before the nova arrives.
      spawnRing(8, SPAWN_CARDS, 12);
      const victims = (ctx.director?.enemies ?? []).slice(-8);
      // Refilling the bar once a frame was never a pin, and this shot spent
      // three merges finding that out the expensive way.
      //
      // `hold` runs at the top of the frame and skips anything already dead. A
      // survivor holding one of every item in the game deals more than a
      // monster's whole health bar *inside* one frame, so the pack died under
      // the refill and every later `hold` passed over the corpses. It was never
      // photographed as a failure because the death dissolve was running on the
      // crumble debris instead of on the body (`4734ffd`): a corpse held full
      // opacity for its whole 1.5 s, so a monster that died early was
      // pixel-for-pixel a monster that never died. The subject was measuring
      // "eight bodies are on screen", not "eight monsters are alive in the
      // blast", and those had been different things for a long time.
      //
      // With the dissolve landing on the silhouette the corpse's age became the
      // measurement, and the age is a function of *upstream RNG draw count* —
      // which merge last touched the item roster or the bookkeeping kill. Three
      // on-disk points, one mechanism, no game-code change between the last two:
      //
      //   base            death age at shutter   burn k   subject
      //   825c4ce         0.583 s                (none)   1077 px  pass
      //   ba17c90         0.583 s                0.686     90 px   fail
      //   82508a7         0.783 s                0.922      0 px   fail
      //
      // (`reviews/round7/captures/fix-inventory/bisect-825c4ce`,
      // `.../diag-victims`, `.../diag-master-nopin` — the last two publish the
      // per-victim `deathT` the `DIAG victims` check below now carries in every
      // manifest.) Chasing the commit that last moved that number is chasing the
      // wrong thing: any draw-count change slides it again.
      //
      // So pin the composition instead of the pixels. Raise the ceiling the way
      // `invulnerable` (Harness.js:1341) raises the player's, and keep refilling
      // under it right up to the frame the equipment fires. Nothing the
      // inventory does can then take the pack off the board early: the earliest
      // any of them can die is the trigger, so the burn at the shutter is
      // bounded by the shutter instead of by the draw count. Measured across the
      // pack in `reviews/round7/captures/fix-inventory/master-after3`: `k` 0.137
      // for five and 0.294 for three, against the 0.686 and 0.922 above. The
      // pack still takes the nova, still dies to it, still throws the damage
      // numbers this frame is graded on — it just cannot be a heap of ash by the
      // time the shutter opens. No RNG is drawn either way.
      //
      // 1e6 and not `Infinity` on purpose: the nova is still allowed to finish
      // them, which is the picture this shot is documented as taking. Pinned at
      // 1e12 they survive it, and the frame measured *worse* — live monsters are
      // knocked out of the composition by the blast they are supposed to be
      // standing in (`.../master-after2`: five of eight visible, 2,256 px,
      // against 4,257 px and eight of eight here).
      for (const e of victims) e.maxHealth = 1e6;
      const hold = () => {
        for (const e of victims) {
          if (!e.alive) continue;
          e.health = e.maxHealth;
          e.shield = e.maxShield;
        }
      };
      // Past the 0.45 s spawn pop in simulation time, so none is caught at 0.2
      // scale, topping the pack up on every frame inside it.
      const tHold = ctx.time ?? 0;
      for (let i = 0; i < 300 && (ctx.time ?? 0) - tHold < 0.55; i++) { hold(); await frames(1); }
      hold();
      declutter(11);

      // Put bodies where the nova will be, then fire it. `useEquipment` is the
      // real API — driving the effect function directly would photograph a
      // frame the player can never produce, which is the failure mode this
      // whole file exists to prevent.
      //
      // The seat and the two frames after it are inside the pin, not outside it:
      // a pin that ends before the trigger is a pin with a hole in it, so the
      // refill runs once more on the frame the equipment fires.
      //
      // The ring is 0.26 x 0.11 of frame and was 0.16 x 0.07. That was drawn
      // when the blast measured 17,954 px of particles and one pixel of
      // everything else; it now carries a 52,129 px beam pool as well
      // (`.../master-before` -> `the equipment blast`, perPx), and the old ring
      // seated the pack inside the core of it. The bodies were *there* —
      // 577 px on the second-largest — and unreadable against it, `sepP50` 0.15
      // under a 0.25 floor, which fails as a separation defect and not as an
      // absence (`.../master-after`). Widened, the same eight read at
      // `sepP50` 0.33 with no object failing. Still inside the nova: its own
      // radius grew with the effect.
      const p = playerPos();
      camera.updateMatrixWorld(true);
      const ps = screenOf(p.x, p.y + 1.0, p.z);
      victims.forEach((e, i) => {
        const a = (i / Math.max(1, victims.length)) * Math.PI * 2;
        const g = groundAtScreen(ps.x + Math.cos(a) * 0.26, ps.y + Math.sin(a) * 0.11,
                                 { minDist: 6, maxDist: 30 });
        if (g) { _seat(e, g); return; }
        const x = p.x + Math.cos(a) * 9, z = p.z + Math.sin(a) * 9;
        _seat(e, _cc.set(x, groundY(x, z, p.y), z));
      });
      await frames(2);
      hold();

      const fired = ctx.items?.useEquipment?.();
      if (!fired) console.warn('[harness] 10-inventory: equipment refused to fire');
      // In effect seconds, not simulation seconds — see `waitFx`. This is the
      // check that failed at 294 px on one run and passed on the next with no
      // code change: the nova's own kills raise hitstop, hitstop scales the
      // fixed step by 0.15, and the `waitSim` budget was therefore buying a
      // wall interval that depended on how many monsters happened to die
      // first. The nova ages on the wall clock, so it was photographed at a
      // different point in its life every run.
      const shutter = await waitFx(blastSeconds);
      freeze();
      mustContain('10-inventory', [
        /* The strip is checked against the inventory the survivor *holds*, not
         * against the catalogue, and it carries its own floor.
         *
         * `ITEMS.length` stopped being a reachable target when the corruption
         * tier landed: a corrupted item consumes the ordinary item it pairs
         * with, so nine of the catalogue's entries can never co-exist with their
         * bases and the comparison is unsatisfiable by construction rather than
         * failing on a defect. Measured across three on-disk manifests —
         * `reviews/round6/base/manifest.json` `{shown: 83, items: 83}` (pass),
         * `reviews/round6/items/manifest.json` `{shown: 83, items: 92}` (fail),
         * and `reviews/round6/items-control/manifest.json`, which is the same
         * build with the corruption settle stubbed out, `{shown: 92, items: 92}`
         * (pass). The strip renders the same 83 tiles in all three; only the
         * target moved. See `reviews/round6/C2-corruption-tier.md` §6.
         *
         * `held` alone would be self-referential: an empty inventory rendering
         * an empty strip is `0 >= 0` and certifies, which is the
         * aggregate-hiding-an-absence shape this round has already hit three
         * times. So a zero inside this check is not reachable — the shot is
         * documented as a *dense late-run* inventory, `lateRun` hands the player
         * every item in the game, and the floor below says so in the assertion
         * rather than in a comment. An empty strip fails on `>= 60`; a strip
         * that has dropped tiles fails on `>= held`; and both numbers are
         * published in `detail`, so a reader can see which of the two moved.
         */
        {
          subject: 'every tier in the inventory strip',
          dom: () => {
            const shown = ctx.hud?.inv?.size ?? 0;
            const held = ctx.items?.inventory?.().length ?? 0;
            return shown >= held && shown >= 60;
          },
          detail: () => ({
            shown: ctx.hud?.inv?.size ?? 0,
            held: ctx.items?.inventory?.().length ?? 0,
            floor: 60,
            catalogue: ITEMS.length,
          }),
        },
        { subject: 'the equipment effect', dom: () => !!fired },
        {
          subject: 'the equipment blast',
          objects: () => vfxObjects(/^vfx\.(particles|rings|trails|beams)$/),
          // `perObject` is on so the four pools are *measured*, not so they are
          // gated: `minCarriedPx` still makes this an aggregate and
          // `perObjectOk` stays unconditionally true. Without it `perPx` was
          // never computed, so this check was silent for a different reason
          // than its sibling in `08-explosion` — that one declined to gate a
          // published zero, this one had no zero to publish.
          //
          // Sibling `08-explosion` -> `the blast` reads perPx [22330, 0, 23, 0]
          // through the identical regex, so expect absences here too, and the
          // same open question: beams/trails legitimately unused by this
          // effect, or emitters that stopped emitting? Now it is answerable
          // from the manifest instead of by rediscovery.
          perObject: true,
          minPixels: 800, minCarriedPx: 800,
        },
        {
          subject: 'monsters standing in it',
          objects: () => rigsOf(victims),
          perObject: true, minPixels: 200, minObjects: 2,
          // Monsters thrown by a blast: some leave the frame, some end up
          // behind the fireball. Two have to be individually visible standing
          // in it; requiring all of them would be requiring the blast not to
          // move them.
          crowd: 2, crowdWhy: 'blast victims: knockback removes members from frame by design',
        },
        { subject: 'shutter (effect seconds)', dom: () => shutter?.exact === true, detail: () => shutter },
        /* How old each body in the subject is, and how far its dissolve has
         * burned, at the instant the shutter opened.
         *
         * `info`, not a gate — the gate is the check above. This exists because
         * a pixel count could not tell the two states apart that this shot has
         * now been wrong about twice: eight monsters alive in a blast, and eight
         * corpses that died before it and are most of the way through a 0.85 s
         * burn. Both are "eight rigs on screen"; only one of them is the
         * photograph. `alive: true` (or a `k` inside the shutter's own 0.14) is
         * the shot doing what it says; anything larger means the pin leaked
         * again and says so in the manifest, without a bisect. */
        {
          subject: 'DIAG victims (age at shutter)',
          info: true,
          detail: () => victims.map((e) => {
            const root = e.rig?.root ?? null;
            const d = (ctx.vfx?._dissolving ?? []).find((x) => x.mesh === root);
            return {
              alive: !!e.alive,
              deathT: e.alive || e.deathT == null ? null : +e.deathT.toFixed(3),
              k: d ? +Math.min(1, d.t / d.dur).toFixed(3) : null,
            };
          }),
        },
      ]);
    },

    /**
     * The whole roster, side by side, for judging silhouette read (axis 4).
     *
     * Built from four standalone `CharacterMesh` rigs rather than by swapping
     * `ctx.player` four times: only one of them could ever be the player, and a
     * shot containing one survivor and three empty patches of ground cannot be
     * used to compare four silhouettes. The rigs are the *same class* the
     * player uses, built from the same survivor cards, so what is photographed
     * is exactly what is played.
     *
     * Three things this shot has to get right, all learned the same way every
     * other note in this file was — by shipping the frame that got them wrong:
     *
     *  1. **The ground under the row must be flat.** A 2.3 m spacing across a
     *     slope puts the row at as many different heights as it has members, and
     *     "are these
     *     the same size?" is most of what axis 4 is being asked. The search
     *     below scores flatness above everything else and sweeps bearings as
     *     well as distances, because one bearing on rolling terrain is a
     *     coin flip.
     *  2. **The lens must be at the row's height, not at its own ground's.**
     *     Clamping the camera to `groundY(camera) + 1.5` put it on a ridge
     *     eight metres above the row and photographed the whole thing as a
     *     top-down. The lift is measured off the *subjects* and only raised
     *     enough to clear the terrain the lens is standing in.
     *  3. **The rigs must not survive the shutter.** They are permanent scene
     *     additions with no owner, so any later scenario would have the whole
     *     roster standing in its background. `freeze()` stops the loop and
     *     the canvas keeps presenting the frame it last drew — so removing them
     *     *after* the freeze takes them out of the world without taking them
     *     out of the photograph, which is what lets this run early, against a
     *     clean HUD, instead of last against a full inventory panel.
     */
    async survivors({ settleFrames = 45 } = {}) {
      await begin();
      attach();
      invulnerable();
      await frames(settleFrames);

      const [{ CharacterMesh }, { SURVIVORS }] = await Promise.all([
        import('../entities/CharacterMesh.js'),
        import('../data/survivors.js'),
      ]);

      const p = playerPos();
      /* The row's *width* is the framing constant, not the gap between its
       * members — because the lens is solved from that width, and a fixed gap
       * makes the width grow with the cast.
       *
       * The arithmetic, because the effect is not small and it is not linear.
       * `halfW` below is `(span * 0.5 + 1.3) / fill`, i.e. the frame is exactly
       * as many metres wide as the row demands; a survivor's on-screen width is
       * his own metres over that, so `px ∝ 1 / halfW` and his *area* goes as
       * `1 / halfW²`. With `SPACING` held constant, `halfW` is linear in the
       * cast size, so every survivor already in the shot loses area as the
       * square of the roster:
       *
       *   4 at 2.35 m: span 7.05, halfW 6.03 — perPx [897, 1199, 992, 986]
       *   5 at 2.35 m: span 9.40, halfW 7.50 — perPx [785, 1208, 892, 876, 953]
       *
       * `(6.03 / 7.50)² = 0.647`, and the 0.80-fill note below predicted ~1240
       * for the weakest of four: `1240 x 0.647 = 802` against the 785 measured
       * on `reviews/round7/E-baseline/manifest.json` once the fifth arrived. The model
       * is the entire explanation. Adding a survivor did not make this shot
       * busier — it made every survivor already in it 35% smaller, which is a
       * roster showcase that punishes the roster for growing.
       *
       * So the cast's growth is spent on the gap rather than on the frame.
       * `ROW_SPAN / (N - 1)` returns the tuned 2.35 exactly at the four this was
       * measured on, so this is the shipped constant generalised, not a new one.
       *
       * `MIN_GAP` is where that has to stop, and it is a real limit rather than
       * a formality: two rigs sampled at `radius: 0.75` and turned 0.24 rad
       * off-axis need about a metre of air between their silhouettes, or the
       * row stops being a lineup and the per-object masks start occluding one
       * another — which would fail this subject in a way no amount of frame
       * would fix. Past the clamp the row widens again and members shrink
       * again. That is deliberately loud: the floor below is stated per member
       * and does *not* move to meet it, so the shot goes red rather than
       * quietly documenting a sixth survivor at the expense of the other five.
       */
      const ROW_SPAN = 7.05;
      const MIN_GAP = 1.55;
      const SPACING = Math.max(MIN_GAP, ROW_SPAN / Math.max(1, SURVIVORS.length - 1));
      const span = SPACING * (SURVIVORS.length - 1);
      // Standoff is derived before the search because the visibility and
      // flatness tests have to run against the camera position that will
      // actually be used, not a nominal one.
      const standoff = span * 1.7 + 6;
      const LIFT = 1.35;

      // What "identically staged" has to mean, and what the shipped frame did
      // instead.
      //
      // The search this replaces asked two questions per survivor — can the
      // lens see a point 0.3 m up, and a point 1.9 m up — and accepted the row
      // if both rays cleared. Two rays up the centre line cannot see a rock
      // across a survivor's shins, and ROOK shipped buried to the thigh: no
      // boot, no foot, no ground contact anywhere in the frame, its bbox
      // footline at y 534 against 558 / 569 / 559 for the other three. A leg
      // fix measured at 2.00 leg-runs on the offline rig read 1.03 in the only
      // shot that photographs the roster. One quarter of the sample was being
      // graded through scenery.
      //
      // So: the whole figure is sampled from the ankles up (`y0: 0.02`), every
      // survivor must clear 0.97, the row is placed on **one** ground height
      // rather than four, and the height spread the candidate row would have
      // had is a hard reject rather than a scoring term — a 0.35 m spread is
      // 35 px of footline at this standoff, which is the defect, not a
      // tie-break. The result is asserted in pixels at the bottom of the
      // scenario, so a row that drifts fails the shot instead of shipping.
      const FLAT_MAX = 0.10;        // metres of height spread across the row
      const base = Math.atan2(forward().x, forward().z);
      const cam = new THREE.Vector3();
      let best = null;
      let bestScore = -Infinity;
      const rowOffsets = SURVIVORS.map((_, k) => (k - (SURVIVORS.length - 1) / 2) * SPACING);
      for (const d of [20, 24, 17, 28, 14, 32, 11]) {
        for (let i = 0; i < 11; i++) {
          // Alternate either side of the bearing the player is already facing,
          // so the accepted spot is the closest one to the shot we asked for.
          const az = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.26;
          const fx = Math.sin(az), fz = Math.cos(az);
          const rx = -fz, rz = fx;
          const bx = p.x + fx * d, bz = p.z + fz * d;
          const by = groundY(bx, bz, p.y);
          const camX = bx - fx * standoff, camZ = bz - fz * standoff;
          // Only ever raised above the row's own plane far enough to clear the
          // terrain the lens is standing in, and never by more than a metre.
          const camY = Math.min(Math.max(groundY(camX, camZ, by) + 0.6, by + LIFT), by + LIFT + 1.0);
          cam.set(camX, camY, camZ);

          // Flatness first, because it is cheap and it is the hard gate.
          let lo = Infinity, hi = -Infinity;
          for (const off of rowOffsets) {
            const y = groundY(bx + rx * off, by, bz + rz * off);
            lo = Math.min(lo, y); hi = Math.max(hi, y);
          }
          if (hi - lo > FLAT_MAX) continue;

          // Then the full-body visibility of every slot, from the camera that
          // will actually be used, against the single row height that will
          // actually be used.
          const rowY = hi;
          let worst = 1;
          for (const off of rowOffsets) {
            const v = visibleFraction(cam, _probe.set(bx + rx * off, rowY, bz + rz * off), {
              height: 2.0, radius: 0.75, cols: 3, rows: 5, slack: 0.3, y0: 0.02, y1: 0.98,
            });
            worst = Math.min(worst, v);
            if (worst < 0.97) break;
          }
          if (worst < 0.97) continue;

          // Open depth behind the row and real sunlight on it are the
          // tie-breakers. Four dark silhouettes against a cliff face two metres
          // behind them is the axis-2 "everything at one depth" failure with
          // extra steps.
          const at = _probe.set(bx, rowY + 1.2, bz);
          const score = -(hi - lo) * 20
            + Math.min(backdropDepth(cam, at), 45) * 0.06
            + (sunlit(_cc.set(bx, rowY, bz)) ? 3 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = { x: bx, y: rowY, z: bz, fx, fz, rx, rz, camX, camY, camZ, spread: hi - lo, vis: worst };
          }
        }
      }
      if (!best) {
        // Nothing on the sweep could hold the row on one plane in clear
        // view. Shoot it anyway and let the assertions report it — a fallback
        // that silently ships is the failure mode this whole file exists to
        // prevent — but say so in the console as well.
        console.error('[harness] 09-survivors: no flat, unoccluded row on any bearing; '
          + 'falling back to the raw forward bearing');
        const f0 = forward();
        const bx = p.x + f0.x * 20, bz = p.z + f0.z * 20;
        const by = groundY(bx, bz, p.y);
        best = {
          x: bx, y: by, z: bz, fx: f0.x, fz: f0.z, rx: -f0.z, rz: f0.x,
          camX: bx - f0.x * standoff, camY: by + LIFT, camZ: bz - f0.z * standoff,
          spread: NaN, vis: 0,
        };
      }

      const rigs = [];
      const spots = [];
      SURVIVORS.forEach((card, i) => {
        const x = best.x + best.rx * rowOffsets[i];
        const z = best.z + best.rz * rowOffsets[i];
        // One ground plane for the whole row, not `groundY` per slot. The row is
        // only accepted when the terrain under it is flat to `FLAT_MAX`, so
        // this floats a rig by at most 10 cm — against the 35 cm of *staging*
        // difference that put ROOK on a different footline from its three
        // peers in a shot whose entire job is comparing them like for like.
        const mesh = new CharacterMesh(card.meshKey);
        mesh.group.position.set(x, best.y, z);
        ctx.scene.add(mesh.group);
        rigs.push(mesh);
        spots.push([x, best.y, z]);
      });

      // Face the lens, turned a little off-axis. A dead-on front view flattens
      // every shoulder mass on the rig, and how the volume sits on the shoulders
      // is half of what axis 4 is grading.
      const lookYaw = Math.atan2(-best.fx, -best.fz) + 0.24;
      const state = {
        velocity: new THREE.Vector3(0, 0, 0), grounded: true,
        aimYaw: lookYaw, aimPitch: -0.04, dashT: 0, sprint: false, moveSpeed: 7, dead: false,
      };
      // 150 fixed steps is well past the settle time of the slowest spring on
      // the rig (`sLean`, 8 rad/s), so every one of them is photographed in its
      // real idle pose rather than in the raw build pose.
      for (const mesh of rigs) {
        mesh.bodyYaw = lookYaw;
        for (let i = 0; i < 150; i++) mesh.update(1 / 60, state);
      }

      detach();
      camera.position.set(best.camX, best.camY, best.camZ);
      // Aim at chest height rather than at the centre of the row's bounding
      // box: it puts the feet on the lower third and leaves the upper frame to
      // the terrain, which is what a row of dark silhouettes is read against.
      camera.lookAt(best.x, best.y + 0.95, best.z);
      // Lens solved from the row rather than picked: the roster has to *fill*
      // the frame or this is a landscape photograph with some characters in it.
      // At the 44 deg default and an 18 m standoff each survivor was 110 px of
      // a 900 px frame — a third of the shot was foreground rock and another
      // third was sky, and no silhouette judgement is possible at that size.
      //
      // Solve for the row occupying ~80% of frame width, then convert that
      // horizontal half-angle to the vertical FOV three.js actually takes.
      //
      // 0.68 was the first number that stopped the row reading as scenery, and
      // it was still too small to clear the per-object floor this subject sets
      // for itself: measured on `reviews/round6/base/09-survivors.png`, the four
      // came back at perPx [897, 1199, 992, 986] against `minPixels: 4000` over
      // four objects, i.e. a floor of 1000 each, and three of the four missed it
      // — by 11%, 1% and 2%. A fill of 0.80 is 1.176x linear and 1.38x in area,
      // which puts the weakest of them at ~1240 rather than at 1001; the point
      // is to clear the floor by a quarter, not by a pixel.
      //
      // Nothing else in the frame is spent to buy it. At 0.80 the row's outer
      // edges sit 10% of frame width in from each side, and vertically the
      // solved FOV still leaves the 1.9 m figures occupying ~56% of frame
      // height against a 6.8 m tall frame at this standoff — the footline and
      // occlusion checks below both measured 0 px of spread and 1.00 visibility
      // at 0.68 and are unaffected by a change of focal length on a row the
      // search has already accepted as flat.
      const halfW = (span * 0.5 + 1.3) / 0.80;
      const hHalf = Math.atan(halfW / standoff);
      const aspect = camera.aspect || (16 / 9);
      camera.fov = Math.max(12, Math.min(50,
        2 * Math.atan(Math.tan(hHalf) / aspect) * 180 / Math.PI));
      camera.updateProjectionMatrix();

      // Park the player behind the lens. As far as the frame is concerned he is
      // one more survivor than the roster has, and this shot compares the
      // roster.
      if (ctx.player) {
        const bx = best.camX - best.fx * 9, bz = best.camZ - best.fz * 9;
        ctx.player.position.set(bx, groundY(bx, bz, best.camY), bz);
        ctx.player.velocity.set(0, 0, 0);
      }
      declutter(60);

      await frames(6);
      freeze();
      // Checked *before* the rigs are taken out of the world, or the mask pass
      // would be hiding objects that are already gone and every survivor would
      // measure zero.
      // Footlines, in the pixels rather than in the placement code. Each
      // survivor's feet are projected onto the frame and the spread is
      // measured: this is the number the critic measured by hand (534 vs
      // 558 / 569 / 559) and it is now measured on every run. The tolerance is
      // 12 px of 900 — enough for the perspective difference between the
      // middle of a 7 m row and its ends at this standoff, and a quarter of
      // the 35 px spread that shipped.
      camera.updateMatrixWorld(true);
      const px = framePx();
      const footY = spots.map(([x, y, z]) => screenOf(x, y, z).y * px);
      const footSpread = Math.max(...footY) - Math.min(...footY);
      const footVis = spots.map(([x, y, z]) => +visibleFraction(
        camera.position, _probe.set(x, y, z),
        { height: 2.0, radius: 0.75, cols: 3, rows: 5, slack: 0.3, y0: 0.02, y1: 0.98 },
      ).toFixed(3));
      /* The floor is authored per survivor and the aggregate is derived from
       * it, which is the reverse of how this subject used to read.
       *
       * `minPixels: 4000` was written when the cast was four, and the fill note
       * above says what it meant by it in so many words: "a floor of 1000
       * each". The gate turns an aggregate into per-object floors by even share
       * (`minPixels / need`), and that derivation is right — it is what makes
       * the per-object check strictly stronger than the aggregate beside it,
       * and nothing here touches it. What was wrong is which end of it this
       * subject authored. A fixed aggregate over a growing cast moves each
       * member's floor from 1000 to 800 the moment a fifth survivor is added:
       * the gate relaxed by 20% in the same shutter that made every member 35%
       * smaller. A gate that yields to content growth in the same direction the
       * render does is measuring the wrong thing, however sound its arithmetic
       * — the whole point of the note above is that a floor is "not negotiable
       * by whoever is trying to ship", and a roster edit was negotiating it.
       *
       * So the claim is stated in the unit this shot actually cares about. Each
       * survivor must be individually legible; N of them claim N x 1000; and
       * `minPixels / need` hands back 1000 whatever N is. The per-object floors
       * still sum to exactly `minPixels`, so the check is still strictly
       * stronger than its aggregate.
       *
       * **This is a raise, not a relaxation.** It is identical at four
       * (4000 / 4 = 1000) and stricter at every size above it — at five the
       * aggregate goes 4000 -> 5000 and the per-member floor 800 -> 1000. The
       * framing change above is what pays for it; the floor is not what moved
       * to meet the framing.
       */
      const PER_SURVIVOR_PX = 1000;
      mustContain('09-survivors', [
        {
          subject: 'every survivor in the roster',
          objects: () => rigs.map((m) => m.group),
          perObject: true,
          minPixels: PER_SURVIVOR_PX * SURVIVORS.length,
          minObjects: SURVIVORS.length,
        },
        {
          subject: 'the whole roster on one footline',
          dom: () => footSpread <= 12,
          detail: () => ({ spreadPx: +footSpread.toFixed(1), footY: footY.map((v) => +v.toFixed(0)) }),
        },
        {
          subject: 'no survivor occluded, ankles included',
          dom: () => Math.min(...footVis) >= 0.97,
          detail: () => ({ perSurvivor: footVis, groundSpreadM: +(best.spread ?? NaN).toFixed(3) }),
        },
      ]);
      // See note 3 above: the loop is stopped, so nothing will render again and
      // the presented frame still contains every one of them.
      for (const mesh of rigs) ctx.scene.remove(mesh.group);
      return { survivors: SURVIVORS.map((s) => s.id), spots };
    },

    /**
     * Smoke test, not a shot: fire every ability of every survivor and report
     * what threw.
     *
     * Sixteen `fire()` bodies is sixteen chances to reference a method that no
     * longer exists, and the Engine deliberately swallows a throwing system
     * into `ctx.frameErrors` — so without this an ability can be completely
     * dead in the build while every screenshot comes back clean.
     */
    async abilityAudit() {
      await begin();
      attach();
      invulnerable();
      const { SURVIVORS } = await import('../data/survivors.js');
      const out = [];
      const before = ctx.frameErrors ?? 0;
      for (const card of SURVIVORS) {
        ctx.setSurvivor?.(card.id);
        await frames(4);
        for (const slot of ctx.player.slots) {
          try {
            slot.ability.fire(ctx, ctx.player);
            out.push({ survivor: card.id, slot: slot.slot, id: slot.ability.id, ok: true });
          } catch (e) {
            out.push({ survivor: card.id, slot: slot.slot, id: slot.ability.id, ok: false, error: String(e) });
          }
          // Long enough for every scheduled follow-up (the longest is Warden's
          // airborne slam poll at 0.7 s) to have run inside the fixed step.
          await waitSim(0.9);
        }
      }
      ctx.setSurvivor?.('ranger');
      await waitSim(0.5);
      return {
        results: out,
        failed: out.filter((r) => !r.ok),
        frameErrorsAdded: (ctx.frameErrors ?? 0) - before,
        lastFrameError: ctx.lastFrameError ?? null,
      };
    },

    /**
     * Establishing shot of one specific biome.
     *
     * The four stages are supposed to be four *places*, and the only way that
     * claim can be graded is a frame from each of them side by side — a single
     * `02-vista` on stage 1 photographs one biome and says nothing about the
     * other three. So this rebuilds the stage at `index`, re-seats the player
     * and the interactables on it, and then frames the kit's primary landmark
     * rather than an arbitrary bearing: a stage whose identity is carried by
     * its landmarks has to be shot with one of them in the frame.
     *
     * Cross-lit at ~70 deg off the sun bearing so the landmark is raked rather
     * than flatly front- or back-lit, sweeping bearings until the raycast says
     * it is actually unoccluded — the same guard `interactables` needed after
     * two rounds of shipping shots that did not contain their subject.
     */
    async biomeVista({ index = 0, settleFrames = 90, restore = false } = {}) {
      await begin();
      detach();

      /** Generate stage `n`, re-seat the player and its props on it, relabel. */
      const goTo = (n, label = true) => {
        ctx.stage?.build?.(n);
        const spawn = ctx.stage?.spawnPoint?.();
        if (spawn && ctx.player) {
          ctx.player.position.copy(spawn);
          ctx.player.velocity?.set?.(0, 0, 0);
        }
        ctx.interactables?.populate?.(n);
        ctx.director?.clear?.(ctx);
        // The restore pass deliberately does not relabel. It runs after the
        // shutter but the HUD is DOM, not canvas — it updates the moment it is
        // told to, so emitting there would stamp "Stage 1" over the frame of
        // biome 4 that is already sitting on the canvas waiting to be shot.
        if (!label) return;
        ctx.events?.emit?.('stageStart', { index: n, name: ctx.stage?.stageName ?? '' });
        // One stage banner, not four. The HUD's toasts live five seconds and
        // these four scenarios run ~3 s apart, so without this the last frame
        // carries several biome names stacked in its corner — a shot that
        // contradicts itself in a different way from the one the emit fixes.
        const toasts = ctx.hud?.toasts;
        if (toasts) {
          while (toasts.length > 1) toasts.shift().el?.remove();
          ctx.hud.restackToasts?.();
        }
      };

      goTo(index);
      // The HUD's stage banner is fed by `stageStart`, and Progression only
      // emits it on a real transition — so without this every biome frame is
      // labelled with stage 1's name and the shot contradicts itself.
      // Environment publishes the biome's sky, fog and sun inside stage.build,
      // but the shadow frustum and the dust field follow the camera, so give
      // both a few frames before anything is measured against them.
      await frames(6);

      const lm = ctx.stage?.landmarks?.[0];
      const t = lm
        ? new THREE.Vector3(lm.x, lm.y, lm.z)
        : (ctx.stage?.center?.clone() ?? playerPos().clone());
      // 15m of lift, not 24. At 24 over a 70m standoff the lens is pitched ~19
      // deg down, which photographs the stage as a map: the horizon leaves the
      // frame, the sky goes with it, and the landform's silhouette — the thing
      // these four shots exist to compare — is never seen against anything.
      const R = 70, LIFT = 15;
      const prefer = sunAzimuth() + 1.22;
      // Radial, not per-axis. A square bound lets the corners of the stage
      // through, and the corners are where the bounding massif is 60m tall: the
      // sweep parked the lens on top of the wall at y 58 shooting down-sun, and
      // photographed a blown-out white slope with no subject in it.
      const bound = (ctx.stage?.half ?? 110) * 0.74;
      const beacon = ctx.interactables?.teleporter?.position ?? null;
      let cam = null, lenient = null;
      // Restricted to +/-90 deg of the cross-lit bearing. Past that the lens is
      // looking down the sun's own azimuth, which is not a lighting choice, it
      // is a lens flare with a stage behind it.
      for (let i = 0; i < 9 && !cam; i++) {
        const az = prefer + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.39;
        const cx = t.x + Math.sin(az) * R, cz = t.z + Math.cos(az) * R;
        if (Math.hypot(cx, cz) > bound) continue;
        // Clamped as well as lifted: on rising ground the raw `ground + 15`
        // pitches the whole frame into the dirt.
        const cy = Math.min(Math.max(groundY(cx, cz, t.y), t.y) + LIFT, t.y + LIFT + 14);
        const pos = new THREE.Vector3(cx, cy, cz);
        // The landmark's base as well as its crown: seeing only the top of a
        // structure over a ridge is the "subject sunk into the ground" read.
        if (!seesTarget(pos, _cc.set(t.x, t.y + 2, t.z), 1.5)
            || !seesTarget(pos, _cc.set(t.x, t.y + 12, t.z), 1.5)) continue;
        lenient = lenient ?? pos;
        // Reject any bearing that puts the teleporter beam near the frame's
        // centre line. It is a 70m emissive column: on the composition axis it
        // is not a light source in the shot, it is a white bar dividing the
        // shot in two, and it cost three of the first four biome frames their
        // whole midground.
        if (beacon) {
          const dl = Math.atan2(t.x - cx, t.z - cz);
          const db = Math.atan2(beacon.x - cx, beacon.z - cz);
          if (Math.abs(((db - dl + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.30) continue;
        }
        cam = pos;
      }
      if (!cam && !lenient) {
        // Nothing on the arc could see the landmark. Fall back to a bearing
        // that is at least inside the stage: the old world-diagonal fallback
        // put the lens 121m from the origin, i.e. on top of the bounding wall.
        const fx = t.x - Math.sin(prefer) * R, fz = t.z - Math.cos(prefer) * R;
        const k = Math.min(1, bound / Math.max(1e-3, Math.hypot(fx, fz)));
        lenient = new THREE.Vector3(fx * k, Math.max(groundY(fx * k, fz * k, t.y), t.y) + LIFT, fz * k);
      }
      cam = cam ?? lenient;

      camera.position.copy(cam);
      // Aimed above the landmark's foot, which puts the skyline around a third
      // of the way down the frame and leaves the sky its own band — the same
      // composition `vista` was tuned to.
      camera.lookAt(t.x, t.y + 9, t.z);
      camera.fov = 56;
      camera.updateProjectionMatrix();
      await frames(settleFrames);
      freeze();
      // The landmark has no rig to hide, so this is the projected-bounds form of
      // the check: a box the size of the landform, sampled by raycast.
      mustContain(`13-biomes-${index + 1}`, [
        {
          subject: `biome ${index + 1} landmark`,
          point: () => Object.assign(t.clone(), { height: 16, radius: 9, slack: 1.5 }),
          minVisible: 0.5,
        },
        // Depth, not sky: two of the four biomes are a canyon and a cavern and
        // are supposed to have very little sky in them.
        { subject: 'open depth', dom: () => openDepth() > 0.12, detail: () => +openDepth().toFixed(3) },
        { subject: 'sky', info: true, detail: () => +skyFraction().toFixed(3) },
      ]);

      // Put the world back on stage 1 *after* the shutter, so these four can sit
      // early in the run order and get a clean HUD instead of inheriting
      // `lateRun`'s inventory panel over a quarter of every frame. The loop is
      // already stopped, so nothing is drawn between here and the screenshot —
      // the canvas keeps presenting the frame composed above.
      if (restore) { goTo(0, false); pendingRelabel = 0; }
    },

    /**
     * The whole bestiary in two ranks, for silhouette grading.
     *
     * Three things this shot has to get right, all of which the first attempt
     * got wrong and photographed a hillside for its trouble:
     *
     *  1. **The ground has to be flat.** A 24 m rank dropped on `sampleHeight`
     *     across a slope buries its lower half and stacks its upper half, and
     *     no camera can recover that. Candidate centres are scored on the
     *     height spread measured along the rank axis and rejected outright past
     *     2.5 m.
     *  2. **The camera has to be chosen before the rank is laid out.** The rank
     *     must be perpendicular to the view direction, so the vantage comes
     *     first (via `clearCam`, which is the only thing here that actually
     *     raycasts) and the axis is derived from it.
     *  3. **Big at the back.** Sorted by height with the tall half on the far
     *     rank, or the hulk stands in front of the mite and the shot documents
     *     one of the sixteen.
     */
    async bestiary({ settleFrames = 40, spacing = 2.4, rows = null, standoff = 16, rankGap = null, fill = 0.86, flyerHover = 1.5 } = {}) {
      await begin();
      invulnerable();
      detach();
      if (ctx.director) ctx.director.enabled = false;

      /* Three ranks, not two, and the frame solved from the rank rather than
       * left at a fixed 40°. Both are forced by the same arithmetic.
       *
       * The per-object floor this subject sets for itself is `minPixels / N` =
       * 3500 / 16 = 219 px, and measured on `reviews/round6/base/11-bestiary.png`
       * six of the sixteen missed it or missed the separation floor, the worst
       * being the mite at 63 px. Uniform zoom cannot close that: the pixels a
       * unit gets scale as `d_c / (d_c - fz) / halfExtent`, so the levers are the
       * rank's *width* and how far in front of the camera's aim point the front
       * rank stands — not focal length, which cancels against the rank having to
       * fit the frame.
       *
       * Two ranks of eight at 2.7 m gives 27/23/12.3 = 0.095. Three ranks of six
       * at 2.4 m, with the camera at 18 m and the ranks at -7/0/+7, gives
       * 18/11/8.7 = 0.188 — 1.97x linear, 3.9x in area, which puts the mite at
       * ~245 px against a floor of 219 instead of at 63. The tall half loses a
       * little (the back rank moves from 32.5 m to 25 m but the frame tightens
       * faster), and it has three to eight times the floor in hand.
       *
       * Rank depth is checked, not assumed: with the lens 5.5 m up at 18 m, the
       * front rank's tallest member subtends less elevation than the middle
       * rank's feet, so the near rank cannot stand in front of the far one — the
       * failure mode "big at the back" was invented to prevent, one rank deeper.
       */
      const cards = [...SPAWN_CARDS].sort((a, b) => a.height - b.height);
      /* Ranks are counted from the roster, and the block's *depth* is what is
       * held constant while they are.
       *
       * With `rows` fixed at 3, a roster edit lands entirely on the rank width:
       * sixteen cards made ranks of six, nineteen make ranks of seven, and
       * `halfW` went 6.0 -> 7.2 m while the lens stayed where it was. Measured
       * on `reviews/round7/E-baseline/manifest.json`, `11-bestiary` -> `DIAG roster`,
       * that is not a near miss — the front rank is *clipped at both frame
       * edges*: the mite's mask box starts at x 0.024 and the harrier's ends at
       * x 0.999, and the whole roster's box spans 0.024-0.999. Three cards
       * arrived and the shot quietly started cropping the two on the ends.
       *
       * Nothing gated caught it, and nothing gated could: clipping removes some
       * of a member's pixels, not all of them, so `perPx` still cleared a floor
       * that had itself dropped from 219 to 184 for the same reason. A roster
       * shot missing the edges of its roster is the `11-bestiary` failure this
       * scenario's own doc comment was written about, arrived at from the other
       * direction.
       *
       * `ceil(N / PER_RANK_MAX)` returns 3 at sixteen — the shipped value — and
       * 4 at nineteen, and it also fixes a distribution the fixed count made
       * worse: `ceil(19 / 3) = 7` puts seven in the front rank and leaves five
       * in the back, so the near rank (which projects widest) took the overflow
       * and the far rank used a third of the frame. Four ranks of five is
       * 5/5/5/4.
       *
       * `rankGap` is then derived so the block occupies the same depth however
       * many ranks divide it. That is not tidiness, it is the specific
       * mitigation for the failure a bare `rows: 4` was already known to cause:
       * at the shipped 6 m gap a fourth rank puts the back rank at 25 m, and the
       * note below records that 25 m is where members come back fog-washed at
       * sepP50 0.15 and 0.23 against the 0.25 floor. Holding `BLOCK_DEPTH` at 12
       * keeps `rankZ` spanning -6..+6 exactly as it does at three ranks, so the
       * near rank stays at 10 m and the far rank at 22 m, the separation
       * measurements below still describe this frame, and the vertical solve
       * (which reads `dNear` and `dFar`) is untouched by the change.
       */
      const PER_RANK_MAX = 6;
      const BLOCK_DEPTH = 12;
      rows = rows ?? Math.max(1, Math.ceil(cards.length / PER_RANK_MAX));
      rankGap = rankGap ?? BLOCK_DEPTH / Math.max(1, rows - 1);
      /* Every rank on its own lateral phase, not two phases shared out.
       *
       * `row % 2 ? spacing * 0.5 : 0` is exactly right for two ranks and
       * degenerates the moment there are more: at three it puts ranks 0 and 2
       * back in line, and at four it makes two aligned *pairs* (0 with 2, 1
       * with 3). That is the same "a back slot stands exactly behind a front
       * one and photographs as nothing at all" failure the placement comment
       * below was written about, reintroduced by rank count rather than by
       * stagger.
       *
       * It bites harder at four ranks than at three for a second reason: the
       * block's depth is held at 12 m, so four ranks sit 4 m apart instead of
       * 6 m, and a member has much less depth in which to clear the one behind
       * it. Measured on `reviews/round7/E-step-slots/manifest.json`, the
       * four-rank run before this change: the warden — row 2, in line with row
       * 0 and with row 3 four metres behind it — came back at `bgLumP50` 36
       * against 10 on the three-rank `E-baseline`, and `sepP50` 0.17 against
       * 0.41. It stopped being photographed against ground and started being
       * photographed against the back rank's bodies, and lost pixels to the
       * rank in front on the way (3674 px -> 2980 in a frame 1.7x tighter).
       * With every rank on its own phase it reads 0.29 in `E-after`.
       *
       * `r / rows` spreads the ranks evenly across one slot instead. At two
       * ranks it returns 0 and `spacing * 0.5` — the shipped rule exactly, at
       * the size the shipped rule was right for — and at three and four it
       * gives every rank a phase of its own.
       */
      const stagger = (r) => (r / rows) * spacing;
      const perRow = Math.ceil(cards.length / rows);
      const halfW = (perRow - 1) * 0.5 * spacing;
      // Along the view direction, back rank last. Evenly spread so no two ranks
      // share a depth and the stagger below has something to work against.
      //
      // 16 m and 6 m rather than 18 and 7. The block's pixel arithmetic is
      // almost unchanged (16/10/8.7 = 0.184 against 18/11/8.7 = 0.188) and the
      // back rank moves from 25 m to 22 m, which is where the remaining failures
      // were: measured on `reviews/round6/diag-b2.json`, every one of the sixteen
      // cleared the 219 px floor but the two furthest came back at sepP50 0.15
      // and 0.23 against 0.25 — fog-washed against terrain that is fog-washed to
      // the same value. Contrast against the backdrop is a function of range, so
      // the answer is range.
      const rankZ = [];
      for (let r = 0; r < rows; r++) rankZ.push((r - (rows - 1) / 2) * rankGap);
      const p = playerPos();

      // Candidate centres: straight ahead at a few ranges, plus walkable points
      // the stage offers. Scored on how flat the rank would be.
      const centres = [ahead(20), ahead(26), ahead(16)];
      // A deterministic ring of candidates as well as the stage's random ones.
      // The pool used to be three bearings plus whatever twenty-four `ctx.rng`
      // draws happened to land on, and the scenario that runs before this one now
      // relocates the survivor — so the three `ahead` centres move with him and
      // the random ones are the only breadth there is. These cost no `rng` draws,
      // which matters: the scenarios after this one are seeded off the same
      // stream and must not shift because this one looked harder for a floor.
      for (const r of [18, 26, 34]) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
          centres.push(new THREE.Vector3(x, groundY(x, z, p.y), z));
        }
      }
      for (let i = 0; i < 24; i++) {
        const q = ctx.stage?.randomWalkablePoint?.(ctx.rng, { minDistFrom: p, minDist: 16 });
        if (q) centres.push(q.clone());
      }

      /* Level ground over the whole block, as a first-class term.
       *
       * With two ranks the block was 9.5 m deep and the height spread along the
       * rank axis was enough to describe it. Three ranks make it 14 m deep and
       * 12 m wide, and a centre that is flat across the rank but sits on a shelf
       * front-to-back drops the far rank over the edge — measured on a run of
       * this scenario where the four tallest cards all came back at 0 px while
       * the near rank rendered, which is a roster shot of twelve captioned as
       * sixteen. `arenaFlatness` is the same disc measure `04-combat` uses to
       * choose where to stand, at the block's own radius. */
      const flatAt = arenaFlatness({ probeRings: [6, 11, 16], spokes: 12, flat: 1.8 });

      let best = null;
      for (const c of centres) {
        // The subject is a 24 m rank, not a point. Scoring it as a box wide
        // enough to cover both ranks is what makes the trunk visible to the
        // search: the shipped `11-bestiary` had a ~350 px black column through
        // the middle of the roster and passed, because the three rays it cast
        // all went up the rank's centre line and the trunk stood beside it.
        const camPick = bestCam(c, {
          radius: standoff, lift: 5.5, rings: 3, step: 2.5, spokes: 16,
          // 26 m of clear depth behind the rank rather than 16. Three of the six
          // failures on the baseline frame were separation, not size — the
          // roster standing against ground two metres behind it, at sepP50 0.11,
          // 0.19 and 0.23 against a 0.25 floor — and depth behind the subject is
          // the framing lever for that.
          subjectHeight: 5.0, subjectRadius: halfW + 1.5, fov: 40, backdrop: 26,
        });
        const cam = camPick?.pos;
        if (!cam) continue;
        // Rank axis: perpendicular to the view, in the ground plane.
        let dx = c.x - cam.x, dz = c.z - cam.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const ax = -dz, az = dx;
        // Flatness along every rank, sampled at every slot.
        let lo = Infinity, hi = -Infinity, seen = 0, slots = 0;
        for (let row = 0; row < rows; row++) {
          const fz = rankZ[row];
          for (let i = 0; i < perRow; i++) {
            if (row * perRow + i >= cards.length) break;
            const off = i * spacing - halfW + stagger(row);
            const x = c.x + ax * off + dx * fz, z = c.z + az * off + dz * fz;
            const y = groundY(x, z, c.y);
            lo = Math.min(lo, y); hi = Math.max(hi, y);
            slots++;
            // Every slot, over the height of the unit that stands in it — a slot
            // whose feet are visible under a canopy is not a visible monster.
            if (visibleFraction(cam, _cc.set(x, y, z), { height: 2.4, radius: 0.9, cols: 3, rows: 3, slack: 0.4 }) >= 0.9) seen++;
          }
        }
        // Every slot has to be clear, not most of them. A rank on a gentle slope
        // is still gradable; a rank with four of its sixteen behind a trunk is
        // a shot of twelve monsters captioned as sixteen.
        const flat = flatAt ? flatAt(c.x, c.z) : 1;
        if (flat < 0) continue;                 // inside a prop, or off the map
        const score = seen * 100 + flat * 240 - (hi - lo) * 8 - camPick.occ * 40;
        if (!best || score > best.score) {
          best = { c, cam, dx, dz, ax, az, spread: hi - lo, score, seen, flat };
        }
        if (hi - lo < 1.8 && seen === slots && flat >= 0.9) break;
      }
      if (!best) {
        const c = ahead(26);
        best = { c, cam: null, dx: forward().x, dz: forward().z, ax: -forward().z, az: forward().x, spread: 0, seen: 0 };
      }

      const { c, ax, az, dx, dz } = best;

      /* Within a rank, the end slots go to cards that stand on the ground.
       *
       * The rank a card lands in is its height order and that is the shot's
       * documented composition ("big at the back"). Its slot *inside* that rank
       * was previously just the same index again, which is an arbitrary choice
       * being made about the one variable that decides what a member is
       * photographed against — and it is not a free one, because the two ends
       * of a rank are the two worst backdrops in the block. Everything else has
       * a rank standing behind it; an end slot has open ground running to fog.
       *
       * That compounds with the flyer problem the note below already documents
       * and already spent a staging decision on: a hovering card's ray clears
       * the ranks behind it at *every* lateral position. Hovering **and** on
       * the end is both at once, and it is measurable. Re-dividing 19 cards
       * into four ranks of five moved the mote — a near-black shell — from the
       * interior of a rank of seven to the outer slot of a rank of five, and it
       * came back at `sepP50` 0.13 against the 0.25 floor —
       * `reviews/round7/E-step-ranks/manifest.json` — while the same card sat
       * at 0.59 on `reviews/round7/E-baseline/manifest.json` one rank layout
       * earlier. Putting it back inside its rank restores it exactly: 0.59
       * again on `reviews/round7/E-after/manifest.json`. Nothing about the card
       * or the lighting changed; only which slot it stood in.
       *
       * So the scarce resource (a slot with a rank behind it) is spent on the
       * cards that need it. Ground units are dealt to the outermost slots
       * first, working inward, and the hovering cards take what is left, which
       * is the middle. What this costs is honest and it is small: the
       * left-to-right order *within* a rank is no longer height order. Across
       * ranks it still is, and a rank spans a narrow height band anyway — the
       * front rank here runs 0.5 m to 1.1 m. The shot's "small to large" reads
       * front to back, which is the axis it was ever true on.
       */
      const slotCards = [];
      for (let r = 0; r < rows; r++) {
        const group = cards.slice(r * perRow, Math.min((r + 1) * perRow, cards.length));
        const n = group.length;
        const ground = group.filter((k) => !k.isFlyer);
        const flyers = group.filter((k) => k.isFlyer);
        // Slot indices most-distant-from-centre first, so the ends are dealt
        // before the middle.
        const outermost = [...group.keys()]
          .sort((a, b) => Math.abs(b - (n - 1) / 2) - Math.abs(a - (n - 1) / 2));
        const row = new Array(n);
        let g = 0, f = 0;
        for (const s of outermost) row[s] = g < ground.length ? ground[g++] : flyers[f++];
        slotCards.push(...row);
      }

      const placed = [];
      for (let i = 0; i < slotCards.length; i++) {
        const row = Math.floor(i / perRow);       // taller cards go to the back
        const idx = i - row * perRow;
        // Alternate ranks staggered half a slot across. Aligned, a back slot
        // stands exactly behind a front one and photographs as nothing at all —
        // measured at 0 of the 8231 pixels the rank contributed, which is a
        // roster shot missing one of the sixteen species it exists to compare.
        const off = idx * spacing - halfW + stagger(row);
        const fz = rankZ[row];
        const x = c.x + ax * off + dx * fz, z = c.z + az * off + dz * fz;
        const y = groundY(x, z, c.y);
        // Two tier-2 elites, on cards big enough for the aura to read.
        const affix = slotCards[i].id === 'sentinel' ? 'withering'
          : (slotCards[i].id === 'warden' ? 'warded' : null);
        const e = ctx.director?.spawnOne?.(ctx, slotCards[i], new THREE.Vector3(x, y, z), affix);
        if (e) placed.push({ e, x, y, z });
      }

      const yaw = Math.atan2(-dx, -dz) + 0.45;
      /* Flyers are photographed at `flyerHover`, not at their combat hover.
       *
       * This is a staging decision and it is stated as one. Three of the sixteen
       * cards hover — shrike, mote and harrier at 3-4.2 m — and in the *near* rank
       * that puts them 4-5 m above a lens solved for a block whose declared top
       * is the tallest card's 4.2 m crown at the *far* rank. Two things follow,
       * both measured on `reviews/round6/lastdiag2/manifest.json`, `11-bestiary`
       * -> `DIAG roster`:
       *
       *  - they are the only three members whose backdrop is not the ground the
       *    other thirteen stand on. Their `bgLumP50` reads **19, 17 and 28**
       *    against **1-8** for every member on the ground, because at that
       *    elevation the ray behind them clears the far rank and runs to
       *    fog-lifted distance. Object 4 (the mote) is a near-black shell at
       *    `lumP50 19` in front of a backdrop at 17 — `sepP50 0.15` against the
       *    0.25 floor, the shot's one remaining failure.
       *  - the harrier is photographed at screen y **-0.022** with its mask box
       *    starting at y 0.002: it is already running off the top of the frame.
       *
       * Repainting the mote brighter was tried first, because it is the more
       * obvious fix and it is a defect on its own terms; it is **refuted** with
       * two named regressions at `EnemyMeshes.js` `buildMote`. The frame is what
       * is wrong here, not the rig.
       *
       * What this does *not* do: it does not hide that these three fly (at 1.5 m
       * the mote's tendril tips still clear the ground by 0.7 m), it does not
       * touch any rig, and it does not move a floor. What it does cost is honest:
       * the roster no longer shows their combat altitude. This shot is a specimen
       * board — positions, yaw, velocity and animation are all pinned already,
       * and its own `doc` asks for "one rank, small to large", which a body four
       * metres above the line is not. */
      const pin = () => {
        for (const s of placed) {
          const hover = Math.min(s.e.def?.hoverHeight ?? 2, flyerHover);
          s.e.position.set(s.x, s.e.def?.isFlyer ? s.y + hover : s.y, s.z);
          s.e.velocity?.set?.(0, 0, 0);
          s.e.yaw = yaw;                       // three-quarter view, not dead on
          if (s.e.rig?.root) {
            s.e.rig.root.position.copy(s.e.position);
            s.e.rig.root.rotation.y = yaw;
          }
        }
      };
      // Let the 0.45 s spawn pop finish so nothing is caught mid-scale.
      for (let i = 0; i < settleFrames; i++) { pin(); await frames(1); }
      pin();

      const tallest = cards[cards.length - 1].height;
      const cam = best.cam ?? new THREE.Vector3(
        c.x - dx * standoff, groundY(c.x - dx * standoff, c.z - dz * standoff, c.y) + 5.5, c.z - dz * standoff);
      camera.position.copy(cam);

      /* The lens is solved from the rank, not set to a constant.
       *
       * A fixed 40° spent 62% of frame width on the roster and the rest on
       * foreground dirt and sky (measured off `reviews/round6/base/11-bestiary.png`
       * — the sixteen span x 450-1450 of 1600), which is a third of the frame's
       * area thrown away in the one shot whose whole job is comparing sixteen
       * silhouettes. `fill` is the share of frame width the rank is asked to
       * occupy; the horizontal half-angle that produces is then converted to the
       * vertical FOV three.js actually takes.
       *
       * Then the *vertical* extent is checked rather than hoped for. The block is
       * 14 m deep now, so its lowest point (the near rank's feet) and its highest
       * (the far rank's crown) sit at very different elevations from a 5.5 m
       * lens; the aim is put at the midpoint of those two angles and the FOV is
       * widened if it cannot hold both. Solving width alone and aiming at
       * `tallest * 0.4` would crop the front rank's feet the moment the ranks
       * spread in depth.
       */
      const gy = groundY(c.x, c.z, c.y);
      const dNear = Math.max(2, standoff + rankZ[0]);
      const dFar = standoff + rankZ[rows - 1];
      const aLow = Math.atan2(gy - cam.y, dNear);
      const aHigh = Math.atan2(gy + tallest - cam.y, dFar);
      const aMid = (aLow + aHigh) * 0.5;
      const aspect = camera.aspect || (16 / 9);
      /* Two different questions, and the shipped solve only asked one.
       *
       * `fill` is a *composition* preference — the share of frame width the
       * roster should occupy so the shot is not a landscape with monsters in
       * it. Not cropping the roster is a *correctness* requirement. Those are
       * not the same claim and they do not have the same remedy, so they are
       * computed separately here and the wider of the two wins.
       *
       * The composition term is exactly what shipped, unchanged, measured at
       * the block's centre distance. The correctness term is what was missing,
       * and its absence is the same defect the paragraph above fixed on the
       * *vertical* axis ("the vertical extent is checked rather than hoped
       * for") left unfixed on the horizontal: a 12 m-deep block does not
       * project its width at its middle depth. The front rank stands 6 m
       * nearer and subtends more than the answer, and the old form is exact
       * only for a flat rank — which this stopped being when it went to three.
       *
       * How far out, on the shipped frame: `9.9 / (16 x 0.86)` gives
       * `tan(hHalf) = 0.719`, a half-frame 7.19 m wide at the front rank's
       * 10 m, against the 7.2 m that rank's outermost slot needs. Predicted
       * screen x 1.001; `reviews/round7/E-baseline` measured 0.999. The error grows
       * with the block's depth and with the rank's width, both of which grow
       * with the roster, so this gets worse every time a card is added.
       *
       * **Why the card's own `radius` and not a flat margin.** The composition
       * term's `+1.5` is a taste margin and is far too generous to reuse at
       * 10 m, where a metre is 1.5x the angle it is at the centre: applying it
       * (and `fill`) at the near rank widened the frame 34% and cost every
       * member a third of its area — measured, rejected. What the correctness
       * term needs is the real lateral reach of the widest card standing in
       * that rank, which the card already declares. That `radius` is a safe
       * upper bound rather than an estimate: on the baseline frame the harrier
       * (`radius` 0.55) projected a half-width of 0.42 m at 12.3 m, so the
       * collision radius over-states the silhouette. The 1.25 is headroom for
       * the cards that lean or swing wider than they collide.
       *
       * The stagger is counted in, because a rank displaced half a slot
       * sideways is half a slot wider on one side.
       */
      const halfExtent = halfW + spacing * 0.5 + 1.5;
      const compTan = halfExtent / Math.max(1, standoff * fill);
      let cropTan = 0;
      for (let r = 0; r < rows; r++) {
        let maxR = 0;
        for (let i = r * perRow; i < Math.min((r + 1) * perRow, cards.length); i++) {
          maxR = Math.max(maxR, cards[i].radius ?? 0.5);
        }
        const lateral = halfW + stagger(r) + maxR * 1.25;
        cropTan = Math.max(cropTan, lateral / Math.max(1, standoff + rankZ[r]));
      }
      const hHalf = Math.atan(Math.max(compTan, cropTan));
      const vNeed = Math.max(Math.abs(aLow - aMid), Math.abs(aHigh - aMid)) * 1.12;
      const vHalf = Math.max(Math.atan(Math.tan(hHalf) / aspect), vNeed);
      camera.fov = Math.max(14, Math.min(55, vHalf * 2 * 180 / Math.PI));
      camera.updateProjectionMatrix();
      camera.lookAt(c.x, cam.y + Math.tan(aMid) * standoff, c.z);
      camera.updateMatrixWorld(true);
      await frames(2);
      pin();
      await frames(1);
      freeze();
      /* Per card, with the aggregate derived — for the reason set out at
       * `09-survivors`' floor, which this subject demonstrates just as well.
       *
       * `minPixels: 3500` was authored against sixteen cards, and the block
       * above states what it meant by it: "The per-object floor this subject
       * sets for itself is `minPixels / N` = 3500 / 16 = 219 px", tuned until
       * the mite cleared it at ~245. Three cards later the same constant means
       * 184, so the roster edit that made every member smaller also lowered the
       * bar each member had to clear, by 16%. The gate moved in the content's
       * favour without anyone deciding it should.
       *
       * 220 is that same tuned number, authored in the unit it was reasoned in.
       * The even-share derivation in `mustContain` is unchanged and still hands
       * back exactly this figure at any roster size, and the per-object floors
       * still sum to `minPixels`. **A raise, not a relaxation**: identical at
       * sixteen (3500 / 16 = 219) and stricter at every size above it — at
       * nineteen the aggregate goes 3500 -> 4180 and the per-card floor
       * 184 -> 220. The rank and lens changes above are what pay for it.
       */
      const PER_CARD_PX = 220;
      mustContain('11-bestiary', [
        {
          subject: 'the whole spawn roster',
          objects: () => rigsOf(placed.map((s) => s.e)),
          perObject: true,
          minPixels: PER_CARD_PX * cards.length,
          minObjects: cards.length,
        },
        // DIAG. See the note on `04-combat`'s: `info`, read-only, and it must sit
        // immediately after the check it explains.
        {
          subject: 'DIAG roster', info: true,
          detail: () => {
            const per = lastPerObject() ?? [];
            camera.updateMatrixWorld(true);
            return placed.filter((s) => s.e?.rig?.root?.parent).map((s, i) => {
              const h = s.e.def?.height ?? 2;
              const sc = screenOf(s.e.position.x, s.e.position.y + h * 0.5, s.e.position.z);
              const d = Math.hypot(s.e.position.x - camera.position.x, s.e.position.z - camera.position.z);
              return {
                i, id: s.e.def?.id, row: Math.floor(i / perRow), d: +d.toFixed(1),
                sx: +sc.x.toFixed(3), sy: +sc.y.toFixed(3),
                wy: +s.e.position.y.toFixed(1),
                ...(per[i] ?? {}),
              };
            });
          },
        },
      ]);
    },

    /**
     * A boss caught mid-telegraph, in its last phase.
     *
     * Frozen deliberately at ~85% of the wind-up: that is the frame the whole
     * "telegraphed attacks with real wind-up VFX" claim lives or dies on — the
     * ground ring is at its brightest, the charge geometry is at full scale and
     * the pose is at maximum anticipation, one beat before anything can hurt
     * you. Shooting the *release* instead would just be another explosion shot.
     *
     * The standoff is searched rather than assumed, for the same reason
     * `05-boss` searches its own: "in front of the camera" and "visible" are
     * different tests, and the first version of this shot photographed the
     * inside of a cliff with a full boss health bar over it.
     */
    async bossPhases({ boss = 'vizier', settleFrames = 30 } = {}) {
      await begin();
      attach();
      invulnerable();
      if (ctx.director) ctx.director.enabled = false;

      const card = BOSS_CARDS.find((c) => c.id === boss) ?? BOSS_CARDS[0];
      const bh = card.height;

      // Find somewhere the boss can stand that the lens can actually see all
      // of — feet, chest and head.
      await frames(6);
      // Where the boss stands and where it is shot from, both scored.
      //
      // The predecessor filtered on a stack of hard constraints and, when none
      // of the candidates cleared them, fell through to `ahead(24)` with a null
      // camera — meaning the camera was never moved at all and the "late-phase
      // boss" shot was taken on the gameplay lens with a 5.2 m survivor filling
      // the frame and the Vizier 24 m away behind a trunk at 810 px. A search
      // that gets *stricter* and therefore fails to a worse branch is not a
      // guard; `bestCam` removes the branch.
      const stands = [];
      for (const d of [24, 28, 20, 32, 17, 36]) stands.push(ahead(d));
      for (let i = 0; i < 14; i++) {
        const q = ctx.stage?.randomWalkablePoint?.(ctx.rng, { minDistFrom: playerPos(), minDist: 18 });
        if (q) stands.push(q.clone());
      }
      let pick = null;
      for (const cand of stands) {
        const c = bestCam(cand, {
          radius: 21, lift: 7, rings: 4, step: 2.5, prefer: sunAzimuth() + 2.2,
          // Its whole silhouette, across the shoulders as well as up the spine —
          // and `frameOccluders` inside `bestCam` costs a bearing its score for
          // a trunk anywhere in frame, not only one over the centre line.
          subjectHeight: bh, subjectRadius: 2.6, fov: 42, backdrop: 26, wantSun: true,
        });
        if (!c) continue;
        if (!pick || c.score > pick.c.score) pick = { cand, c };
        if (c.vis >= 0.95 && c.occ <= 0.05) break;
      }
      const spot = pick?.cand ?? ahead(24);
      const cam = pick?.c.pos ?? bestCam(spot, { radius: 21, lift: 7, subjectHeight: bh, subjectRadius: 2.6 })?.pos ?? null;

      const e = ctx.director?.spawnOne?.(ctx, card, spot, null) ?? null;
      if (!e) {
        await frames(settleFrames);
        freeze();
        mustContain('12-boss-phases', [{ subject: `${card.id} boss`, objects: () => [], minPixels: 1 }]);
        return;
      }
      e.isBoss = true;
      if (ctx.director) ctx.director.boss = e;
      ctx.events?.emit?.('bossSpawn', { enemy: e });

      // Drive it into its last phase through the real damage path, so the phase
      // gates, the cooldown reset and the phase-break blast all happen exactly
      // as they do in a fight.
      // `ignoreArmor` is not optional here: the Vizier's phase-1 tower shield is
      // 85% frontal damage reduction expressed as armour, so a single unmodified
      // hit for 80% of its health took 11% off it and left the boss in phase 1
      // with a full bar and its shield still up — a shot captioned "late phase"
      // that documented the opening one. Stepped rather than one-shot so every
      // gate fires its own phase-break blast, the way a real fight does.
      const gates = e.phaseAt || [];
      for (let i = 0; i < gates.length; i++) {
        const want = e.maxHealth * (gates[i] - 0.03);
        if (e.health > want) {
          ctx.combat?.applyDamage?.(e, e.health - want, { source: ctx.player, ignoreArmor: true, crit: false });
        }
        await frames(2);
      }

      const p = playerPos();
      const pin = () => {
        e.position.copy(spot);
        e.velocity.set(0, 0, 0);
        if (cam) e.yaw = Math.atan2(cam.x - spot.x, cam.z - spot.z) + 0.42;
        if (e.rig?.root) { e.rig.root.position.copy(spot); e.rig.root.rotation.y = e.yaw; }
      };
      for (let i = 0; i < settleFrames; i++) { pin(); await frames(1); }

      // Pick the highest-phase attack it owns — that is the one the phase break
      // unlocked, and the one worth photographing.
      let idx = 0;
      for (let i = 0; i < card.attacks.length; i++) {
        if ((card.attacks[i].phase || 1) >= (card.attacks[idx].phase || 1)) idx = i;
      }
      e.gcd = 0;
      e.cd.fill(0);
      e.beginAttack(ctx, idx);

      // Hold at 85% of the wind-up. Frame-locked, not clock-locked: the loop
      // free-runs and a wall-clock wait lands somewhere different per machine.
      for (let i = 0; i < 600 && e.anim.windup < 0.85 && e.fsm.state === 'windup'; i++) {
        pin();
        await frames(1);
      }
      pin();

      detach();
      if (cam) camera.position.copy(cam);
      camera.fov = 42;
      camera.updateProjectionMatrix();
      aimBetween(spot, bh, p);
      await frames(2);
      pin();
      await frames(1);
      freeze();
      mustContain('12-boss-phases', [
        { subject: `${card.id} boss`, objects: () => rigsOf([e]), minPixels: 2000 },
        { subject: 'late phase', dom: () => e.phase >= 1 + (e.phaseAt?.length ?? 0), detail: () => e.phase },
        { subject: 'mid wind-up', dom: () => e.anim.windup > 0.4, detail: () => +e.anim.windup.toFixed(2) },
        { subject: 'framing', info: true, detail: () => pick?.c ?? null },
      ]);
    },

    /* ---------------------------------------------------------------------
     * UI screens.
     *
     * These three photograph DOM, not the 3D scene, so they break one of this
     * file's two rules on purpose: there is no subject to place and no effect
     * to time. What they still have to get right is that the screen is
     * *populated* — a menu shot of an empty panel grades nothing — and that
     * anything asynchronous behind it has landed before the shutter. The
     * survivor portrait and the logbook's model viewer both import their mesh
     * module dynamically and both render through their own WebGL context, so
     * each of these settles well past the first frame the screen appears on.
     * ------------------------------------------------------------------- */

    /** Survivor select, with the roster, the rotating portrait and a loadout. */
    async survivorSelect({ survivor = 'kestrel', settleFrames = 90 } = {}) {
      await begin();
      attach();
      invulnerable();
      // A live stage behind the panel rather than a black void: the select
      // screen inherits the title's slow orbit and the scrim is deliberately
      // translucent, so what is behind it is part of the composition.
      await frames(20);

      const menus = ctx.hud?.menus;
      if (!menus) throw new Error('[harness] 14-survivor-select: no menus');
      menus.open('title');
      menus.act('play');
      // Not the default: the shot has to prove the roster is a *choice*, and
      // the tallest silhouette is the one that tests the portrait framing.
      menus.pickSurvivor(survivor);
      // The portrait is behind a dynamic import plus a context creation plus a
      // 140-step spring settle. 90 frames is comfortably past all three.
      await frames(settleFrames);
      // The portrait turns continuously, so the shutter otherwise lands on
      // whatever bearing the machine's frame rate happened to reach — on the
      // first capture that was near side-on, which is the one view that hides
      // a survivor's shoulder mass. Pin a three-quarter and render again.
      pinPreview(menus.preview, 0.62);
      await frames(2);
      freeze();
      mustContain('14-survivor-select', [
        { subject: 'select screen', dom: () => menus.screen === 'select' },
        {
          subject: 'the roster',
          dom: () => menus.root.querySelectorAll('[data-survivor]').length >= 4,
          detail: () => menus.root.querySelectorAll('[data-survivor]').length,
        },
        { subject: 'the 3D portrait', dom: () => !!menus.preview?.subject && !!menus.preview?.renderer },
        { subject: `${survivor} selected`, dom: () => menus.survivorId === survivor, detail: () => menus.survivorId },
      ]);
      return { survivor: menus.survivorId, screen: menus.screen };
    },

    /**
     * Logbook, on a tab whose entries carry a 3D rig.
     *
     * `enemies`, not `survivors`: the roster is four rows in a thirty-two-em
     * index, so the survivors tab photographs three quarters of an empty
     * column, and the survivor loadout is already the subject of
     * `14-survivor-select`. The bestiary fills the index, carries a stat block
     * and a lore line, and is the tab the screen has to prove it can hold.
     */
    async logbook({ tab = 'enemies', entry = 'sentinel', settleFrames = 90 } = {}) {
      await begin();
      attach();
      invulnerable();
      await frames(20);

      const menus = ctx.hud?.menus;
      const book = menus?.logbook;
      if (!book) throw new Error('[harness] 15-logbook: no logbook');
      menus.open('title');
      menus.act('logbook');
      book.setTab(tab, true);
      if (entry) book.select(entry, true);
      await frames(settleFrames);
      pinPreview(book.preview, 0.62);
      await frames(2);
      freeze();
      mustContain('15-logbook', [
        { subject: 'logbook screen', dom: () => menus.screen === 'logbook' },
        { subject: `${tab} index`, dom: () => book.tab === tab && book.entries.length >= 8, detail: () => book.entries.length },
        { subject: 'a selected entry', dom: () => !!book.selected, detail: () => book.selected },
        { subject: 'the 3D model viewer', dom: () => !!book.preview?.subject && !!book.preview?.renderer },
      ]);
      return { tab: book.tab, entry: book.selected, recorded: book.entries.length };
    },

    /**
     * Difficulty select.
     *
     * Added because it did not exist. The screen has shipped unphotographed for
     * every round of review so far, which is the same defect as a shot that does
     * not contain its subject, one step earlier: nothing in the harness had ever
     * looked at it, so nothing could report on it. It was carrying emoji-
     * presentation codepoints (U+2602/U+2601/U+26C8) that Windows renders in
     * full colour against a monochrome UI, and no capture could have caught it.
     *
     * Scheduled next to `17-artifacts` and for the same reason — both are
     * pre-run screens — and it puts the difficulty back where it found it after
     * the shutter, so no later scenario inherits a changed spawn curve.
     */
    async difficulty({ settleFrames = 30, pick = null } = {}) {
      thaw();
      const menus = ctx.hud?.menus;
      if (!menus) throw new Error('[harness] 18-difficulty: no menus');
      const before = menus.currentDifficulty?.()?.id ?? menus.difficultyId ?? null;
      menus.open('title');
      menus.act('play');
      menus.act('difficulty');
      const list = menus.difficultyList();
      // The hardest rung rather than the default: the shot has to carry the
      // selected state *and* the unselected ones, and a selection at the end of
      // the ladder puts every other card in the frame beside it.
      const id = pick ?? list[list.length - 1]?.id ?? null;
      if (id) menus.setDifficulty(id);
      await frames(settleFrames);
      freeze();
      mustContain('18-difficulty', [
        { subject: 'difficulty screen', dom: () => menus.screen === 'difficulty' },
        {
          subject: 'the ladder',
          dom: () => menus.root.querySelectorAll('[data-difficulty]').length >= 3,
          detail: () => menus.root.querySelectorAll('[data-difficulty]').length,
        },
        {
          subject: 'a selected rung',
          dom: () => !!menus.root.querySelector('[data-difficulty].is-on'),
          detail: () => menus.difficultyId,
        },
      ]);
      // Put it back after the shutter — literally after it, not after the
      // assertion. `menus.setDifficulty` repaints the card grid, and this line
      // used to run inline: the manifest asserted `cataclysm` and the PNG showed
      // `fracture` selected, because the screenshot is taken when this function
      // returns. Deferred to the next scenario's `thaw()`.
      if (before) restoreAfterShutter(() => menus.setDifficulty(before));
      return { screen: menus.screen, difficulty: id, options: list.length };
    },

    /**
     * The two pre-run rule screens.
     *
     * Shot on the artifact grid rather than the difficulty list: the grid is
     * the denser of the two, it carries the locked/earned states the profile
     * drives, and the difficulty selection is legible on the chip in `14`.
     *
     * It deliberately does **not** call `begin()`, and it is scheduled
     * immediately after `01-title` for that reason: `Artifacts.setActive` is
     * pre-run only and latches shut on the first `stageStart`, and
     * `Progression` builds stage 0 in `fixedUpdate`, which the Engine skips
     * while `ctx.paused`. So the only moment in a capture at which artifacts
     * can actually be chosen is before any scenario has dismissed the title —
     * which is also the only moment a *player* can choose them. Running this
     * after `begin()` photographed seven cards and `0 ACTIVE`, correctly and
     * uselessly.
     */
    async artifacts({ settleFrames = 30 } = {}) {
      thaw();
      const menus = ctx.hud?.menus;
      if (!menus) throw new Error('[harness] 17-artifacts: no menus');
      menus.open('title');
      menus.act('play');
      menus.act('artifacts');
      // A capture runs on a fresh profile, so every artifact is behind a
      // challenge and the grid photographed as seven identical locked cards —
      // which documents one state twice and the other never. Grant the first
      // three the way the profile grants them, then switch two on: the shot
      // now carries active, earned-but-off, and locked-with-its-condition.
      const cards = menus.artifactList();
      for (let i = 0; i < 3 && i < cards.length; i++) {
        ctx.profile?.unlock?.('artifact', cards[i].id, { silent: true });
      }
      menus.renderArtifacts();
      for (let i = 0; i < 2 && i < cards.length; i++) menus.toggleArtifact(cards[i].id);
      await frames(settleFrames);
      freeze();
      mustContain('17-artifacts', [
        { subject: 'artifact screen', dom: () => menus.screen === 'artifacts' },
        {
          subject: 'the card grid',
          dom: () => menus.root.querySelectorAll('[data-artifact]').length >= 5,
          detail: () => menus.root.querySelectorAll('[data-artifact]').length,
        },
        {
          subject: 'active and locked states both present',
          dom: () => menus.activeArtifacts().length >= 1
            && menus.activeArtifacts().length < menus.artifactList().length,
          detail: () => ({ active: menus.activeArtifacts().length, total: menus.artifactList().length }),
        },
      ]);
      const active = menus.activeArtifacts();
      // Left on, the Tithe would delete every chest in the stage and
      // `07-interactables` would photograph a prop shot with no props. But
      // `setActive` emits `artifactsChanged`, which the artifact grid this shot
      // is photographing listens to — freezing the engine protects the canvas,
      // not the DOM. Deferred past the shutter for the same reason
      // `18-difficulty`'s restore is.
      restoreAfterShutter(() => ctx.artifacts?.setActive?.([]));
      return { screen: menus.screen, active };
    },

    /**
     * Run summary, reached the way a player reaches it: by dying.
     *
     * Deliberately not `menus.showDeath(...)` with invented numbers. The whole
     * point of this screen is that it reports a real run — the profile has to
     * have committed a record, the challenge pass has to have run, and the
     * inventory strip has to be the one the player actually built. So the
     * scenario plays a compressed run and then takes a lethal hit.
     */
    async runSummary({ settleFrames = 50 } = {}) {
      await begin();
      attach();
      ctx.time = 17 * 60 + 42;
      seedLevel(14, 0.35);

      // A believable mid-run inventory rather than one of everything: the
      // summary's item strip is graded on whether a real haul reads, and a
      // player at seventeen minutes has thirty-odd items across three tiers,
      // not eighty-three across five.
      const haul = ITEMS.filter((d) => d.tier === 'common' || d.tier === 'uncommon' || d.tier === 'legendary');
      for (let i = 0; i < haul.length && i < 22; i++) {
        ctx.items?.give?.(haul[i * 2 % haul.length].id, 1 + ((i * 3) % 5));
      }
      ctx.items?.addGold?.(2870);
      // Kills and damage are HUD counters fed off the bus, so they only exist
      // if something actually died. Fight for a moment.
      spawnRing(10, SPAWN_CARDS, 12, 3);
      if (ctx.input) ctx.input.mouse.left = true;
      await frames(120);
      if (ctx.input) ctx.input.mouse.left = false;

      // Killing the survivor is considerably harder than it sounds, and two
      // attempts got it wrong before this one.
      //
      // First: one ordinary hit. A loaded inventory carries near-total block
      // chance and hundreds of armour, and it was simply negated — the shot
      // came back as gameplay with a full health bar. `isDot` skips both the
      // i-frame gate and the Dented Buckler roll and `ignoreArmor` skips the
      // curve, which fixes that.
      //
      // Second: it still would not die when this ran after `10-inventory`.
      // Measured, not guessed (`ctx.combat.applyDamage` returned `dealt:
      // 1000000` while `player.health` stayed at 307.2 and `player.shield`
      // *rose* to its cap): `applyDamage` dispatches the `onDamaged` item hooks
      // before it tests `health <= 0`, and with one of every item in the game
      // held at once something in that set restores the player inside the same
      // call. That is correct behaviour for the game and unbeatable by damage.
      //
      // So: the real path first, and if a full inventory refuses it, end the
      // run through the same two bus events `Combat._kill` emits for a player.
      // The summary is still reporting a real run either way — the profile
      // record, the challenge pass and the inventory strip are all unchanged.
      const p = ctx.player;
      for (let i = 0; i < 30 && p?.alive; i++) {
        p._iframeUntil = 0;
        ctx.combat?.applyDamage?.(p, 1e6, { type: 'harness', isDot: true, ignoreArmor: true });
        await frames(1);
      }
      if (p?.alive) {
        p.health = 0;
        p.alive = false;
        p.onDeath?.();
        ctx.events.emit('kill', { victim: p, source: null, position: p.position, isElite: false, isBoss: false });
        ctx.events.emit('playerDead', {});
      }
      await frames(settleFrames);
      freeze();
      const record = ctx.profile?.runHistory?.()[0] ?? null;
      mustContain('16-run-summary', [
        { subject: 'the summary screen', dom: () => ctx.hud?.menus?.screen === 'death', detail: () => ctx.hud?.menus?.screen },
        { subject: 'a committed run record', dom: () => !!record, detail: () => record && { time: record.time, stage: record.stage } },
        { subject: 'the run\'s item haul', dom: () => (ctx.hud?.inv?.size ?? 0) >= 10, detail: () => ctx.hud?.inv?.size ?? 0 },
      ]);
      return { screen: ctx.hud?.menus?.screen ?? null, record };
    },

    /**
     * The trailer thesis (launch design section 3.4): the party fighting at a
     * blight edge as it spreads toward camera. Composed from public seams only:
     * corruption is driven through feed(), the patch through seed() + the growth
     * Blight.update already runs, the fight through spawnRing. The camera sits
     * low on the far side of the patch edge, shooting across it at the fight,
     * so the crawling edge advances toward the lens.
     */
    async blightEdge({ world = 150, seedStrength = 3, settleFrames = 150, closeFrames = 45 } = {}) {
      thaw();
      await begin();
      await frames(2);
      // The loaded late-run STATE, minus the inventory. `lateRun`'s state half
      // (Harness.js:2996-3005) is a clock, an item haul and a level; this shot
      // takes the clock and the level and deliberately drops the haul. Measured
      // both ways: with the 37-item grant the HUD paints its inventory grid over
      // the left quarter of the landscape (exactly the reason `06-loaded-hud`
      // and `10-inventory` were moved to the end of the run), and the passive
      // item damage that comes with it wiped the ring down to one survivor
      // before the shutter -- `a live fight` failed at 1 of 8. The difficulty
      // meter, the band and the survivor's level are what "late run" has to read
      // as here, and all three come from the clock and `seedLevel`.
      attach();
      invulnerable();
      ctx.time = 22 * 60;
      seedLevel(20, 0.42);
      // This scenario shoots across open ground from 30 m out, which is the one
      // composition a canyon spawn cannot survive: the first capture put the
      // lens inside a rock face with the whole frame purple. `placeForOpenArena`
      // is `lateRun`'s and `04-combat`'s answer to the same problem -- move the
      // survivor to flat ground and turn him toward the open part of it -- and
      // it must run BEFORE the bearing below is taken, since it sets the yaw
      // everything here is placed off.
      await placeForOpenArena();
      // Plant the seed FIRST, while the world is still near zero. Blight builds
      // a patch at full formula radius for the CURRENT world (Blight.js:502),
      // so seeding after the feed would spawn the rim pre-grown at ~12.5 m and
      // the spec's "spreads toward camera" motion would never happen on camera.
      // Seeded now, the patch builds at radiusOf(3, ~0) = 6.5 m and GROWS at
      // 1.2 m/s (Blight.js:19) as the feeds below raise the world -- the growth
      // itself is the thesis, and Task 2 films this same arm.
      const p = playerPos();
      // Cloned, not held: `forward()` hands back one shared vector that every
      // later `forward()` caller (spawnRing, among others) overwrites in place,
      // and this bearing has to survive the settle to aim the lens.
      const f = forward().clone();
      const seedAt = new THREE.Vector3(p.x + f.x * 12, p.y, p.z + f.z * 12);
      ctx.corruption.seed(seedAt, seedStrength);
      // Drive the world to the target band through the two real levers.
      const delta = world - (ctx.corruption?.world ?? 0);
      if (delta > 0) ctx.corruption.feed(ctx.player, delta);
      else if (delta < 0) ctx.corruption.bleed(ctx.player, -delta);
      // The patch grows on its own first, with nothing else in the arena. The
      // spread is the subject, and it is 1.2 m/s (Blight.js:19) from 6.5 m to
      // the 12.5 m this world buys -- five seconds of crawl that the monsters
      // have no reason to be standing around for.
      await frames(settleFrames);
      // The fight is spawned LATE, for the reason the item grant is gone: bodies
      // put down at t=0 do not all survive to the shutter. `closeFrames` is the
      // whole life of the fight on camera -- long enough for the ring to break
      // formation and close on the survivor, short enough that it is still eight
      // of them when the lens turns around.
      // Chosen by silhouette, not by roster order. `SPAWN_CARDS.slice(0, 4)` is
      // the small end of the deck -- mite, scarab, spitling -- and the lens for
      // this shot stands ~26 m off, where a mite is a few pixels of orange on a
      // purple field. These four are the largest bodies that neither submerge
      // (burrower) nor blink out (stalker) mid-shutter.
      const cards = ['charger', 'shriver', 'warden', 'sentinel']
        .map((id) => SPAWN_CARDS.find((c) => c.id === id)).filter(Boolean);
      const standing = new Set(ctx.director?.enemies ?? []);
      spawnRing(8, cards.length ? cards : SPAWN_CARDS, 9, 4);
      /* And pin the ring, for the reason the comment above says the haul was
       * dropped — except that the haul is not dropped and never was. `begin()`
       * does not empty the inventory, so the survivor arrives here holding the
       * 97 items `06-loaded-hud` and `10-inventory` gave him
       * (`reviews/round7/captures/fix-loaded-hud/diag-blight-fixed/manifest.json`,
       * `DIAG blight`: `items 97`, and all eight of the ring dead at the
       * shutter). What that comment describes as a defence is a hope, and the
       * shot has been passing on the timing of a proc rather than on anything
       * it does: eight bodies at 442-3536 health against a chain that arrives
       * at tens of thousands.
       *
       * Same pin `10-inventory` puts on its own pack for the same reason
       * (`Harness.js`, "the pack is pinned at full health across the settle"),
       * released at the shutter. Nothing runs after this scenario, so the
       * release has nothing to hand on to.
       */
      const ringPins = [];
      for (const e of ctx.director?.enemies ?? []) {
        if (standing.has(e)) continue;
        ringPins.push({ e, health: e.health, maxHealth: e.maxHealth });
        e.maxHealth = 1e9;
        e.health = 1e9;
      }
      // The ring's own band reaches 42 m in front of the survivor, which on this
      // bearing is behind the lens that is about to be planted at 26 m. Pull the
      // fight into a band that is entirely on the near side of it, and onto the
      // patch, which is where "fighting at a blight edge" has to happen.
      declutter(9, { maxDist: 20 });
      await frames(closeFrames);
      // Low camera on the far side of the seed, shooting back across the edge
      // toward the player: patch in the foreground, fight behind its rim. The
      // standoff is read off the LIVE patch uniform, not recomputed arithmetic,
      // so the lens sits relative to what actually rendered.
      const patch = ctx.blight?.patches?.at?.(-1) ?? null;
      const liveR = patch?.mesh?.material?.uniforms?.uRadius?.value ?? 0;
      // 4 m off the rim, measured against 2 m: the tighter lens photographs
      // bigger monsters and loses the survivor behind a Warden's shield, which
      // is the one body in frame the pitch cannot do without.
      const camX = seedAt.x + f.x * (liveR + 4), camZ = seedAt.z + f.z * (liveR + 4);
      // Off the terrain under the lens, not off the survivor's own footing:
      // 2.2 m above a player standing in a basin is underground on the ridge
      // 30 m away, and the first capture proved it -- the frame came back as
      // the inside of a rock.
      H.freeCam(camX, groundY(camX, camZ, p.y) + 2.6, camZ, p.x, p.y + 1.4, p.z);
      // Declutter AFTER the lens is planted, not before, and this is the one
      // ordering decision in the shot that is worth a paragraph. `declutter`
      // measures against the live `camera`, so run from the third-person rig it
      // clears the survivor's silhouette as the RIG sees it -- and the shot that
      // produced was eight monsters neatly stacked between the trailer lens and
      // the survivor, who is the thing the pitch is about and was not in his own
      // photograph. Run here, the swing-off-the-bearing pass (see `declutter`)
      // is working in the frame that actually ships.
      declutter(12, { maxDist: 26 });
      await frames(12);
      freeze();
      const enemiesAlive = (ctx.director?.enemies ?? []).filter((e) => e.alive).length;
      for (const p of ringPins) {
        p.e.maxHealth = p.maxHealth;
        p.e.health = Math.min(p.health, p.maxHealth);
      }
      const camDistToEdge = Math.hypot(camera.position.x - seedAt.x, camera.position.z - seedAt.z) - liveR;
      const record = {
        world: +(ctx.corruption?.world ?? 0).toFixed(1),
        band: ctx.corruption?.band ?? 0,
        patchRadius: +liveR.toFixed(2),
        enemiesAlive,
        cameraDistToEdge: +camDistToEdge.toFixed(2),
      };
      mustContain('20-blight-edge', [
        { subject: 'a deep-band world', dom: () => (ctx.corruption?.band ?? 0) >= 3, detail: () => record.band },
        { subject: 'a blight patch in the world', dom: () => (ctx.blight?.patches?.length ?? 0) >= 1, detail: () => ctx.blight?.patches?.length ?? 0 },
        { subject: 'a grown patch rim, measured off the live uniform', dom: () => liveR >= 6, detail: () => record.patchRadius },
        { subject: 'a live fight', dom: () => enemiesAlive >= 4, detail: () => enemiesAlive },
      ]);
      return record;
    },

    // Determinism controls. `tools/capture.mjs` pins the clock before the
    // first scenario; `tools/perf.mjs` deliberately does not, because it is
    // measuring the real one.
    pinClock,
    unpinClock,
    /** Everything a caller needs to tell a deterministic run from a lucky one. */
    determinism: () => ({ clockPinned: _pinnedDt > 0, frameDt: frameDt(), frameTimeouts }),

    // Escape hatches for ad-hoc inspection during the critic loop.
    dismiss,
    freeze,
    thaw,
    frames,
    waitFx,
    setQuality: (q) => ctx.pipeline?.setQuality?.(q),
    setAdaptive: (on, scale) => ctx.pipeline?.setAdaptive?.(on, scale),
    resScale: () => ctx.pipeline?._resScale ?? 1,
    gpu: () => ctx.gpu,
    setTime: (t) => { ctx.time = t; },
    freeCam: (x, y, z, tx, ty, tz) => {
      detach();
      camera.position.set(x, y, z);
      camera.lookAt(tx, ty, tz);
    },
  };

  globalThis.__HARNESS__ = H;
  return H;
}
