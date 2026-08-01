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
 *     screenshot against a 0.22 s fireball, and photographed the smoke.
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

  /** Dismiss the menu, wait for the stage to exist, and empty the arena. */
  const begin = async () => {
    dismiss();
    // Every scenario shares one page, one rig and one input object, and the
    // scenarios below now write `yaw`, `pitch` and the trigger directly. A shot
    // that inherits the previous one's aim is not the shot it documents:
    // `08-explosion` photographed a mountain horizon with the blast sliding off
    // the bottom of frame because `05-boss` had left the lens pitched up at a
    // Titan's chest, and `02-vista` ran with the trigger still held from
    // `04-combat`. Reset both before anything is placed — every scenario
    // derives its spawns from camera forward, so a stale pitch moves the
    // subject as well as the frame.
    if (ctx.cameraRig) ctx.cameraRig.pitch = -0.12;
    if (ctx.input) ctx.input.mouse.left = false;
    for (let i = 0; i < 180 && !stageStarted; i++) await frames(1);
    // Every scenario shares one page, so without this each one inherits the
    // previous one's horde. `05-boss` was photographing twenty-four leftover
    // golems from `04-combat` standing in front of the Titan, which is how a
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
  const thaw = () => { const e = engine(); if (e && !e.running) e.start(); };

  /**
   * Resolve after `n` rendered frames. Wall-clock capped so a stalled GPU
   * cannot hang `page.evaluate`, which has no timeout of its own.
   */
  const frames = (n, maxMs = 20000) => new Promise((res) => {
    let i = 0;
    const deadline = performance.now() + maxMs;
    const step = () => (++i >= n || performance.now() > deadline ? res() : requestAnimationFrame(step));
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
    backdrop = 14, strict = false, probes = [0.25, 1.0, 1.8], blockers = null,
    fov = 0, maxForeground = 1,
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
        // Test the whole height of the subject, not just its middle. Checking
        // one point passes happily when the camera is over a ridge that hides
        // the prop's base — which reads in the frame as the subject sunk into
        // the ground behind a wedge of terrain.
        if (!probes.every((dy) => seesTarget(pos, _cc.set(base.x, base.y + dy, base.z)))) continue;
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
        if (maxForeground < 1 && fov > 0) {
          const near = Math.hypot(pos.x - base.x, pos.y - base.y, pos.z - base.z) * 0.35;
          if (foregroundLoad(pos, _cc.set(base.x, base.y + 1.3, base.z),
                             fov, camera.aspect || (16 / 9), near) > maxForeground) {
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
      // objective banner own roughly the first 12% of frame height, and a Titan
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
  const spawnRing = (count, cards, radiusBase = 13, eliteEvery = 0) => {
    const p = playerPos();
    const base = Math.atan2(forward().x, forward().z);
    for (let i = 0; i < count; i++) {
      const def = cards[i % cards.length];
      // ±46° of the view direction. Wider than the ~50° horizontal half-FOV is
      // pointless: those spawns are off frame by construction.
      const a0 = base + ((i / Math.max(1, count - 1)) - 0.5) * 1.6;
      let best = null;
      for (let t = 0; t < 8; t++) {
        // Re-roll pushes outward and alternates sideways, so a rejected spawn
        // moves away from the lens rather than sliding along the same arc.
        const a = a0 + (t % 2 ? t : -t) * 0.05;
        const r = radiusBase + (i % 4) * 4 + t * 2.5;
        const x = p.x + Math.sin(a) * r;
        const z = p.z + Math.cos(a) * r;
        const y = groundY(x, z, p.y);
        if (!best) best = new THREE.Vector3(x, y + 0.5, z);
        if (onScreen(x, y + 0.3, z) && onScreen(x, y + (def.height ?? 2), z)) {
          best.set(x, y + 0.5, z);
          break;
        }
      }
      const affix = eliteEvery && i % eliteEvery === 0
        ? ELITE_AFFIXES[(i / eliteEvery | 0) % ELITE_AFFIXES.length]
        : null;
      ctx.director?.spawnOne?.(ctx, def, best, affix);
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
   * so a pest fused with the survivor's shoulder at 6 m is the same pest fused
   * with his shoulder at 12 m — which is what shipped, reading as an orange
   * growth on his arm rather than as a monster. Anything still sitting on the
   * player's silhouette is therefore also swung off the bearing.
   */
  const declutter = (minDist = 12) => {
    const list = ctx.director?.enemies ?? [];
    const cam = camera.position;
    camera.updateMatrixWorld(true);
    const pp = playerPos();
    const ps = screenOf(pp.x, pp.y + 1.0, pp.z);
    let side = 0;
    for (const e of list) {
      if (!e?.alive || !e.position) continue;
      const dx = e.position.x - cam.x, dz = e.position.z - cam.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) continue;

      let az = Math.atan2(dx, dz);
      let r = d, move = false;
      if (d < minDist) { r = minDist; move = true; }

      const es = screenOf(e.position.x, e.position.y + 1.0, e.position.z);
      // 0.09 of the viewport is roughly the survivor's own half-width plus a
      // margin at gameplay range; inside that the two silhouettes merge.
      if (es.front > 0 && Math.hypot(es.x - ps.x, es.y - ps.y) < 0.09) {
        az += (side++ % 2 ? 1 : -1) * 0.30;   // ~17% of frame width at FOV 70
        move = true;
      }
      if (!move) continue;

      const x = cam.x + Math.sin(az) * r;
      const z = cam.z + Math.cos(az) * r;
      const y = groundY(x, z, e.position.y);
      e.position.set(x, e.def?.isFlyer ? y + (e.def.hoverHeight ?? 2) : y, z);
      e.home?.set?.(x, y, z);
      e.velocity?.set?.(0, 0, 0);
    }
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
    let first = null;
    for (let i = 0; i < n && i < list.length; i++) {
      const e = list[i];
      const d = 19 + i * 4;
      const off = (i - (n - 1) / 2) * 2.4;
      const x = p.x + Math.sin(yaw) * d + Math.cos(yaw) * off;
      const z = p.z + Math.cos(yaw) * d - Math.sin(yaw) * off;
      const y = groundY(x, z, p.y);
      e.position.set(x, e.def?.isFlyer ? y + (e.def.hoverHeight ?? 2) : y, z);
      e.home?.set?.(x, y, z);
      e.velocity?.set?.(0, 0, 0);
      first = first ?? e;
    }
    return first;
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
   * Wait `s` seconds of *simulation* time.
   *
   * `frames(n)` counts rendered frames, and the render loop is free-running:
   * the explosion scenario burns ~150 rAF per second against a 60 Hz fixed
   * step, so a 4-frame wait is 0.026 s, not the 0.067 s it reads as. That is
   * how the shutter landed on the 0.09 s white core with the fireball, both
   * shockwave rings and the smoke column still inside it — a flashbulb. The
   * shutter stays frame-locked (the loop is stopped on a chosen frame, never
   * on a wall clock); only the budget is now expressed in the same units the
   * effect's own lifetimes are.
   */
  const waitSim = async (s, maxFrames = 900) => {
    const t0 = ctx.time ?? 0;
    for (let i = 0; i < maxFrames && (ctx.time ?? 0) - t0 < s; i++) await frames(1);
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
  const foregroundLoad = (pos, target, fovDeg, aspect, near) => {
    _fgD.subVectors(target, pos);
    if (_fgD.lengthSq() < 1e-6) return 0;
    _fgD.normalize();
    _fgR.crossVectors(_fgD, _fgUp);
    if (_fgR.lengthSq() < 1e-6) return 0;
    _fgR.normalize();
    _fgU.crossVectors(_fgR, _fgD).normalize();
    const ty = Math.tan(fovDeg * 0.5 * Math.PI / 180), tx = ty * aspect;
    let hit = 0, n = 0;
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 4; ix++) {
        const sy = -(0.30 + iy * 0.30), sx = -0.85 + ix * 0.5667;
        _fgRay.copy(_fgD).addScaledVector(_fgR, sx * tx).addScaledVector(_fgU, sy * ty).normalize();
        const d = ctx.stage?.raycastDistance?.(pos, _fgRay, near);
        n++;
        if (typeof d === 'number' && d >= 0) hit++;
      }
    }
    return hit / n;
  };

  const H = {
    ctx,

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
      const cx = p.x - 46, cz = p.z + 34;
      const camY = Math.max(groundY(cx, cz, p.y) + 6, p.y + 9);
      camera.position.set(cx, camY, cz);
      camera.lookAt(p.x, camY + 4.5, p.z);
      camera.fov = 58;
      camera.updateProjectionMatrix();
      await frames(settleFrames);
      freeze();
    },

    async gameplay({ settleFrames = 90 } = {}) {
      await begin();
      attach();
      await frames(settleFrames);
      freeze();
    },

    async combat({ enemies = 24, settleFrames = 60 } = {}) {
      await begin();
      attach();
      invulnerable();
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
      freeze();
    },

    /**
     * Teleporter boss.
     *
     * Three separate ways this shot used to end up without a Titan in it:
     *
     *  - it spawned the boss on a fixed world `+X/+Z` diagonal with no terrain
     *    sample, so on any slope it landed buried or off a ledge;
     *  - it called `beginTeleporterEvent` (which spawns the *tracked* boss at
     *    `findSpawnPoint`, deliberately outside the frustum) and then spawned a
     *    second untracked Titan, so the HUD bar and the visible monster were
     *    different entities and only the invisible one had a health bar;
     *  - it inherited two dozen golems from `04-combat`, which stood between the
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
      // survivor and the 7.6 m Titan are both in frame. Scale is the whole
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
      const STANDOFF = 24, SWING = 0.55;
      const camAt = (spot) => {
        let dx = p.x - spot.x, dz = p.z - spot.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        // Swung off the boss→player axis rather than sitting on it. Directly
        // behind the survivor the lens, the survivor and the Titan are
        // collinear, so he lands on its chest and the two silhouettes fuse —
        // and sliding the camera sideways cannot fix that, because it moves
        // both subjects through nearly the same angle. Swinging the standoff
        // 32° puts ~5 m of real lateral offset between them at the lens.
        const s = Math.sin(SWING), c = Math.cos(SWING);
        const ax = dx * c - dz * s, az2 = dx * s + dz * c;
        const cx = p.x + ax * STANDOFF, cz = p.z + az2 * STANDOFF;
        // High enough to shoot over the crest the survivor is standing behind:
        // at 4 m the Titan's legs were cut off by near terrain and a 7.6 m
        // colossus photographed as a 145 px torso.
        return new THREE.Vector3(cx, Math.max(groundY(cx, cz, p.y), p.y) + 6.5, cz);
      };

      // Search for a boss position the lens can actually see. An earlier pass
      // put the Titan on a correct camera-forward bearing and it still came out
      // behind a rock spire: "in front of the camera" and "visible" are not the
      // same test.
      let spot = null, cam = null, lenient = null, lenientCam = null;
      for (let ring = 0; ring < 3 && !spot; ring++) {
        const r = 9 + ring * 2;
        for (let i = 0; i < 11; i++) {
          const az = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.16;
          const x = p.x + Math.sin(az) * r, z = p.z + Math.cos(az) * r;
          const y = groundY(x, z, p.y);
          if (Math.abs(y - p.y) > 7) continue;   // down a ravine or up a cliff
          const cand = new THREE.Vector3(x, y, z);
          const c = camAt(cand);
          // Feet as well as chest and head. Testing only the upper body passes
          // happily when a crest between the lens and the boss eats its legs,
          // which reads in the frame as a torso floating on a dark slope.
          if (!seesTarget(c, _probe.set(x, y + 0.6, z), 1.2)
              || !seesTarget(c, _probe.set(x, y + bh * 0.5, z), 1.2)
              || !seesTarget(c, _probe.set(x, y + bh * 0.9, z), 1.2)) continue;
          // Shoulders too. A dead tree that misses the centre line still cuts
          // the silhouette in half, and silhouette is the axis this shot exists
          // to be judged on.
          const ux = -(z - c.z), uz = (x - c.x);
          const ul = Math.hypot(ux, uz) || 1;
          const sx = (ux / ul) * 2.6, sz = (uz / ul) * 2.6;
          if (!seesTarget(c, _probe.set(x + sx, y + bh * 0.55, z + sz), 1.2)
              || !seesTarget(c, _probe.set(x - sx, y + bh * 0.55, z - sz), 1.2)
              || !seesTarget(c, _probe.set(x + sx, y + bh * 0.25, z + sz), 1.2)
              || !seesTarget(c, _probe.set(x - sx, y + bh * 0.25, z - sz), 1.2)) continue;
          if (!lenient) { lenient = cand; lenientCam = c; }
          // The Titan is a grey stone figure; parked against a cliff face it is
          // indistinguishable from the cliff. Insist on open distance behind its
          // head so the silhouette has something to read against. 30 m rather
          // than 45: with the boss now 9 m ahead of the player instead of 20-28,
          // a 45 m demand fails out to the lenient branch on most terrain.
          if (backdropDepth(c, _probe.set(x, y + bh * 0.85, z)) < 30) continue;
          spot = cand; cam = c; break;
        }
      }
      if (!spot) { spot = lenient ?? ahead(23); cam = lenientCam; }
      if (!cam) cam = camAt(spot);

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
      // Titan is pinned to `spot` for the duration so its readouts spawn where
      // the framing below expects it to be standing.
      if (boss) {
        await fireBurst(0.5, { pin: boss, at: spot });
        // Then let the trigger go. `Enemy.setFlash` is a boolean full-white
        // override held for 0.075 s after every hit, so shooting right up to
        // the shutter photographs the Titan as a flat white cast — the exact
        // silhouette this frame exists to judge, with the silhouette removed.
        // Damage numbers live about a second and survive the gap.
        await fireBurst(0.14, { pin: boss, at: spot, fire: false });
      }

      // Face the camera. Nothing here ever set a yaw: the Titan kept whatever
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
      // the Titan's rig hung 1.25 m of each leg below the world and only ~0.7
      // of its 7.6 m capsule was ever drawn. The rig now fills 7.58 m of it, so
      // the fudge would crop the head it was invented to keep in frame.
      aimBetween(spot, bh, p);
      // Re-space the horde against the *final* lens rather than the gameplay
      // one: 30 m puts it just past the survivor at 24 m and short of the boss
      // at 33 m, and the screen-overlap pass in `declutter` can only do its job
      // once the camera it measures against is the one being photographed.
      declutter(30);
      if (boss) { boss.position.copy(spot); boss.velocity?.set?.(0, 0, 0); }
      await frames(3);
      freeze();
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
      spawnRing(10, SPAWN_CARDS, 14, 3);
      await frames(settleFrames);
      declutter(12);
      await frames(3);
      freeze();
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
      let t = null, cam = null;
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
          });
          if (!c) continue;
          t = o.position; cam = c; break;
        }
        if (cam) break;
      }
      if (!cam) {
        t = ranked[0]?.o.position ?? ahead(6, 0);
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
    },

    /**
     * Peak VFX moment.
     *
     * The blast is fired, then the engine is stopped on the first rendered
     * frame at or past `blastSeconds` of *simulation* time — still frame-locked
     * (the loop stops on a chosen frame, never on a wall clock) but budgeted in
     * the units the effect's own lifetimes are written in.
     *
     * Both previous attempts missed, in opposite directions. A fixed 12-frame
     * settle let 0.63 s elapse and photographed the ember tail. Counting four
     * rendered frames instead looked like 0.067 s but was 0.026 s: the render
     * loop free-runs at ~150 fps against a 60 Hz fixed step, so the shutter
     * landed on the 0.09 s white core with the fireball, both shockwave rings
     * and the smoke column all still inside it — a flashbulb.
     *
     * 0.11 s is where the blast has a shape. Measured at radius 6: the core is
     * dead, the fireball has broken into discrete lobes ~3.2 m out, the two
     * rings are at 8.6 m and 6.6 m, and the smoke has risen over a ~6 m mass.
     */
    async explosion({ blastSeconds = 0.09, settleFrames = 60 } = {}) {
      await begin();
      attach();
      invulnerable();
      spawnRing(12, SPAWN_CARDS, 13);
      if (ctx.input) ctx.input.mouse.left = true;
      await frames(settleFrames);
      declutter(12);

      // Centre of frame, on the ground the camera is actually looking at, and
      // high enough off it that the hill crest between the player and the blast
      // does not eat the bottom half of a six-metre fireball.
      // Closer and higher than it used to be. At 15 m out and 3 m up the blast
      // sat on the ridge line: its lower half was behind the crest, the rings
      // were 250 px of thin arc, and a six-metre fireball read as a smudge on
      // the horizon. Pulled in to 12 m the same blast is a foreground event, and
      // 4.5 m of clearance keeps the whole sphere above the terrain the shot is
      // standing on.
      let at = null;
      for (const d of [12, 14, 10, 16, 18]) {
        const c = ahead(d, 4.5);
        if (seesTarget(camera.position, c, 0.2)) { at = c; break; }
      }
      at = at ?? ahead(12, 4.5);

      // Put monsters inside the blast. An explosion over empty ground is a
      // light source, not impact feedback — the shot is documented as
      // "explosion + damage numbers + shake" and the numbers only exist if
      // something is standing in it.
      const victims = (ctx.director?.enemies ?? []).filter((e) => e.alive).slice(0, 7);
      victims.forEach((e, i) => {
        const a = (i / Math.max(1, victims.length)) * Math.PI * 2;
        const x = at.x + Math.cos(a) * 5.5, z = at.z + Math.sin(a) * 5.5;
        const y = groundY(x, z, at.y);
        e.position.set(x, e.def?.isFlyer ? y + (e.def.hoverHeight ?? 2) : y, z);
        e.velocity?.set?.(0, 0, 0);
      });
      await frames(2);

      ctx.vfx?.explosion?.(at, 6);
      ctx.combat?.explode?.(at, 8, 300, null, {});
      ctx.pipeline?.addShake?.(0.5);
      await waitSim(blastSeconds);
      freeze();
    },

    // Escape hatches for ad-hoc inspection during the critic loop.
    dismiss,
    freeze,
    thaw,
    frames,
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
