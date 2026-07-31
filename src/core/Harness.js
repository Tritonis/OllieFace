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
    ctx.hud?.menus?.close?.();
    ctx.paused = false;
  };

  const detach = () => { if (ctx.cameraRig) ctx.cameraRig.enabled = false; };
  const attach = () => { if (ctx.cameraRig) ctx.cameraRig.enabled = true; };
  const playerPos = () => ctx.player?.position ?? new THREE.Vector3();

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
   * Fan enemies across the camera's forward arc and drop each onto the terrain.
   *
   * A naive ring at the player's own height buries half the group inside the
   * cliff the player is standing against and drops the other half off the ledge
   * — which is why the first capture pass showed an empty battlefield.
   */
  const spawnRing = (count, cards, radiusBase = 8, eliteEvery = 0) => {
    const p = playerPos();
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const base = Math.atan2(fwd.x, fwd.z);
    for (let i = 0; i < count; i++) {
      // ±70° of the view direction, so every spawn is potentially on screen.
      const a = base + ((i / Math.max(1, count - 1)) - 0.5) * 2.44;
      const r = radiusBase + (i % 4) * 4;
      const x = p.x + Math.sin(a) * r;
      const z = p.z + Math.cos(a) * r;
      const ground = ctx.stage?.sampleHeight?.(x, z);
      const at = new THREE.Vector3(x, (Number.isFinite(ground) ? ground : p.y) + 0.5, z);
      const def = cards[i % cards.length];
      const affix = eliteEvery && i % eliteEvery === 0
        ? ELITE_AFFIXES[(i / eliteEvery | 0) % ELITE_AFFIXES.length]
        : null;
      ctx.director?.spawnOne?.(ctx, def, at, affix);
    }
  };

  const H = {
    ctx,

    vista() {
      dismiss();
      detach();
      const p = playerPos();
      // Sit lower and aim slightly above the player. The old framing pitched
      // ~20° down at FOV 55, which put the top of frame at ~7° elevation — the
      // sun sits at 18°, so the disc and the whole upper gradient could never
      // appear in the shot that exists to judge sky and atmosphere.
      camera.position.set(p.x - 38, p.y + 13, p.z + 46);
      camera.lookAt(p.x, p.y + 12, p.z);
      camera.fov = 58;
      camera.updateProjectionMatrix();
    },

    gameplay() {
      dismiss();
      attach();
    },

    combat({ enemies = 24 } = {}) {
      dismiss();
      attach();
      invulnerable();
      spawnRing(enemies, SPAWN_CARDS, 8, 6);
      // Hold the trigger so the frame contains muzzle flash and tracers.
      if (ctx.input) ctx.input.mouse.left = true;
    },

    boss() {
      dismiss();
      attach();
      const p = playerPos();
      ctx.director?.beginTeleporterEvent?.(ctx);
      // Director exposes no spawnBoss(); Progression's call to it is
      // optional-chained and silently no-ops, so drive spawnOne directly.
      const at = new THREE.Vector3(p.x + 14, p.y + 2, p.z + 14);
      if (BOSS_CARDS.length) ctx.director?.spawnOne?.(ctx, BOSS_CARDS[0], at, null);
      spawnRing(8, SPAWN_CARDS, 12);
    },

    lateRun() {
      dismiss();
      attach();
      ctx.time = 22 * 60;
      for (let i = 0; i < ITEMS.length; i++) {
        ctx.items?.give?.(ITEMS[i].id, 1 + ((i * 7) % 12));
      }
      ctx.items?.addGold?.(4200);
      spawnRing(10, SPAWN_CARDS, 10, 3);
    },

    interactables() {
      dismiss();
      detach();
      const list = ctx.interactables?.list ?? [];
      const p = playerPos();
      let best = null, bestD = Infinity;
      for (const o of list) {
        const d = o.position?.distanceToSquared?.(p) ?? Infinity;
        if (d < bestD) { bestD = d; best = o; }
      }
      const t = best?.position;
      if (t) {
        camera.position.set(t.x + 4.5, t.y + 2.6, t.z + 4.5);
        camera.lookAt(t.x, t.y + 0.8, t.z);
      } else {
        camera.position.set(p.x + 6, p.y + 3, p.z + 6);
        camera.lookAt(p);
      }
      camera.fov = 45;
      camera.updateProjectionMatrix();
    },

    explosion() {
      dismiss();
      attach();
      const p = playerPos();
      const at = new THREE.Vector3(p.x + 6, p.y + 1.5, p.z + 6);
      spawnRing(12, SPAWN_CARDS, 7);
      ctx.vfx?.explosion?.(at, 6);
      ctx.combat?.explode?.(at, 8, 300, null, {});
      ctx.pipeline?.addShake?.(0.5);
    },

    // Escape hatches for ad-hoc inspection during the critic loop.
    dismiss,
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
