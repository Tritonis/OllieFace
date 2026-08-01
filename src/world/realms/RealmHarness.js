import * as THREE from 'three';
import { GATEWAYS, REALM_BY_ID, ENDINGS } from '../../data/realms.js';
import { RealmGateway } from './RealmProps.js';

/**
 * Screenshot scenarios for the realms and the finale.
 *
 * Driven by `tools/capture-realms.mjs` and installed onto the same
 * `globalThis.__HARNESS__` object `core/Harness.js` builds, reusing its
 * `mustContain` / `frames` / `freeze` / `thaw` exports rather than duplicating
 * them. They live here rather than in Harness.js so that file stays owned by
 * whoever owns the twenty existing shots.
 *
 * The rule the round-5 handoff paid for applies in full: **every scenario
 * declares what has to be in its frame and the claim is settled against
 * rendered pixels.** A realm that is never photographed with its subject
 * measured is a realm nobody can grade — and a `ready: true, errorCount: 0`
 * manifest has already once been cited as proof of work that did not exist.
 */

const _v = new THREE.Vector3();

export function installRealmHarness(ctx) {
  const H = globalThis.__HARNESS__;
  if (!H) return null;
  const { frames, freeze, thaw, dismiss, mustContain } = H;
  const camera = ctx.camera;

  // --- shared plumbing -------------------------------------------------------

  /** Dismiss the menu, wait for a real stage, and empty it. */
  const begin = async () => {
    thaw();
    dismiss();
    for (let i = 0; i < 300 && !ctx.interactables?.teleporter; i++) await frames(1);
    ctx.director?.clear?.(ctx);
    if (ctx.director) ctx.director.eventActive = false;
    if (ctx.cameraRig) ctx.cameraRig.enabled = false;
    if (ctx.input) ctx.input.mouse.left = false;
  };

  /** Park the lens. Every realm is an authored room, so framing is explicit. */
  const look = (px, py, pz, tx, ty, tz) => {
    camera.position.set(px, py, pz);
    camera.lookAt(tx, ty, tz);
    camera.updateMatrixWorld(true);
  };

  /**
   * A camera on the arena's own polar grid: `az` radians round the middle,
   * `dist` metres out, `y` up, aimed at a point `aimY` above the centre.
   * Everything below frames off this so a shot cannot drift onto a world axis.
   */
  const arenaCam = (az, dist, y, aimY = 2.2, aimAz = null, aimDist = 0) => {
    const o = ctx.stage.origin;
    const ax = aimAz == null ? 0 : Math.cos(aimAz) * aimDist;
    const az2 = aimAz == null ? 0 : Math.sin(aimAz) * aimDist;
    look(o.x + Math.cos(az) * dist, y, o.z + Math.sin(az) * dist,
         o.x + ax, aimY, o.z + az2);
  };

  /** Stand the survivor somewhere deliberate, on the realm floor. */
  const placePlayer = (az, dist, faceAz = null) => {
    const o = ctx.stage.origin;
    _v.set(o.x + Math.cos(az) * dist, 0.05, o.z + Math.sin(az) * dist);
    const p = ctx.player;
    if (!p) return _v.clone();
    if (p.respawnAt) p.respawnAt(_v); else { p.position.copy(_v); p.velocity?.set(0, 0, 0); }
    if (faceAz != null) p.yaw = Math.atan2(Math.cos(faceAz), Math.sin(faceAz));
    return _v.clone();
  };

  /**
   * Keep the survivor on its feet.
   *
   * The finale hits for 38 base at a level the harness never earned, and the
   * first pass at these scenarios had the player dead inside phase 2 - which
   * ended the run, paused the sim mid-collapse, and produced a phase-2 frame
   * with a 34 m floor and a death screen behind it. The i-frame stamp is the
   * same field Combat.applyDamage already tests, so nothing about the damage
   * path is special-cased; the top-up covers the DoT statuses that bypass it.
   */
  const keepAlive = () => {
    const p = ctx.player;
    if (!p) return;
    p._iframeUntil = 1e12;
    p.alive = true;
    p.health = p.stats?.maxHealth || p.maxHealth || 100;
  };

  /** As frames(), with the survivor kept alive across the wait. */
  const wait = async (n) => {
    for (let i = 0; i < n; i += 5) { keepAlive(); await frames(Math.min(5, n - i)); }
    keepAlive();
  };

  /** Rig roots for a list of live entities, skipping anything despawned. */
  const rigs = (list) => (list ?? [])
    .filter((e) => e && e.rig && e.rig.root && e.rig.root.parent)
    .map((e) => e.rig.root);

  /** Enter a realm and let its controller place everything. */
  const enterRealm = async (id) => {
    ctx.realms.forceEnter(id);
    await wait(12);
    return ctx.realms.active;
  };

  /**
   * Drive the Herald down to `frac` of its health and trip the phase gates.
   *
   * Straight through `Enemy.takeDamage`, which is where the gate loop lives, so
   * the phase break the shot photographs is the same one a player produces —
   * blast, shake, cleared cooldowns and all.
   */
  const pushBossTo = async (frac, settle = 200) => {
    const b = ctx.realms.active?.controller?.boss;
    if (!b) return null;
    b.health = b.maxHealth * frac + 1;
    b.takeDamage(1, { position: b.position.clone() });
    await wait(settle);
    return b;
  };

  // --- scenarios -------------------------------------------------------------

  const S = {
    /**
     * The three gateways as they stand in an ordinary stage. Placed by hand
     * rather than rolled: the roll is 26-42% per stage per gateway, so waiting
     * for all three to appear naturally is not a scenario, it is a lottery.
     */
    async realmGateways({ settleFrames = 40 } = {}) {
      await begin();
      const p = ctx.player.position.clone();
      camera.getWorldDirection(_v);
      _v.y = 0; _v.normalize();
      const made = [];
      for (let i = 0; i < GATEWAYS.length; i++) {
        const gate = GATEWAYS[i];
        const realm = REALM_BY_ID.get(gate.realm);
        // Fanned across the camera's forward, not across +X: the survivor is
        // not facing north-east and a world-axis offset would put two of the
        // three behind the lens.
        const side = (i - 1) * 4.6;
        const x = p.x + _v.x * 13 - _v.z * side;
        const z = p.z + _v.z * 13 + _v.x * side;
        const y = ctx.stage.sampleHeight(x, z);
        const g = new RealmGateway(ctx, new THREE.Vector3(x, y, z), gate, realm, gate.cost(2));
        ctx.interactables.add(g);
        ctx.realms.props.push(g);
        made.push(g);
      }
      // Low and aimed up: the steles are dark stone on dark ground, and a
      // high lens puts terrain behind all three. From here the top two thirds
      // of each one is against sky, which is where the separation comes from.
      const mid = made[1].position;
      look(p.x - _v.x * 7.5, p.y + 2.2, p.z - _v.z * 7.5,
           mid.x, mid.y + 3.8, mid.z);
      await wait(settleFrames);
      freeze();
      mustContain('21-realm-gateways', [
        {
          subject: 'all three realm gateways',
          objects: () => made.map((g) => g.group),
          perObject: true, minPixels: 1200, minObjects: 3,
        },
        { subject: 'the survivor', objects: () => [ctx.player?.group].filter(Boolean), minPixels: 400 },
      ]);
      return { gateways: made.length };
    },

    /** The market: three stalls, the refinery, the obelisk, no combat. */
    async realmBazaar({ settleFrames = 60 } = {}) {
      await begin();
      await enterRealm('bazaar');
      placePlayer(0.62, 15, 3.8);
      // On the *stalls' own side* of the room, so they are the near third of
      // the frame rather than thirty metres across it, with the obelisk on the
      // centre line and the arcade and its lanterns behind that. The first pass
      // put the lens at the opposite azimuth and measured 86 px per stall.
      arenaCam(0.62, 25, 8.0, 3.4);
      await wait(settleFrames);
      freeze();
      const stalls = ctx.realms.props.filter((p) => p.kind === 'stall');
      const obelisk = ctx.realms.props.find((p) => p.kind === 'obelisk');
      mustContain('22-realm-bazaar', [
        { subject: 'the market stalls', objects: () => stalls.map((s) => s.group), perObject: true, minPixels: 900, minObjects: 2 },
        { subject: 'the Obelisk of Departure', objects: () => (obelisk ? [obelisk.group] : []), minPixels: 700 },
        { subject: 'no monsters in the hub', dom: () => (ctx.director?.enemies?.length ?? 0) === 0, detail: () => ctx.director?.enemies?.length ?? 0 },
        { subject: 'the survivor', objects: () => [ctx.player?.group].filter(Boolean), minPixels: 250 },
      ]);
      return { stalls: stalls.length, obelisk: !!obelisk };
    },

    /** The trial, mid-wave, with the survivor firing into it. */
    async realmCrucible({ settleFrames = 30 } = {}) {
      await begin();
      await enterRealm('crucible');
      ctx.realms.beginTrial();
      const c = ctx.realms.active.controller;
      // Wave 1 is four mites at half a metre tall and photographs as nothing,
      // and waiting for wave 2 to arrive naturally means waiting for a survivor
      // that is not shooting yet to clear wave 1. Ask the controller for a
      // late-wave budget directly — same code path, same spawn sites.
      for (let i = 0; i < 240 && c.state === 'idle'; i++) { keepAlive(); await frames(1); }
      c.wave = 4;
      c._spawnWave(ctx);
      c.state = 'fighting';
      for (let i = 0; i < 300 && c.live.length < 5; i++) { keepAlive(); await frames(1); }
      placePlayer(0, 7);
      // Behind the survivor, looking into the arena: the wave steers at the
      // player, so this is the one framing that puts monsters at 5-15 m rather
      // than scattered across a 25 m room.
      arenaCam(0, 17, 4.8, 1.8);
      if (ctx.input) ctx.input.mouse.left = true;
      await wait(settleFrames);
      if (ctx.input) ctx.input.mouse.left = false;
      await frames(4);
      freeze();
      mustContain('23-realm-crucible', [
        { subject: 'the trial wave', objects: () => rigs(c.live), perObject: true, minPixels: 500, minObjects: 3 },
        { subject: 'the arena wall', dom: () => ctx.stage.wallRadius === ctx.stage.floorRadius, detail: () => ctx.stage.floorRadius },
        { subject: 'the survivor', objects: () => [ctx.player?.group].filter(Boolean), minPixels: 300 },
      ]);
      return { wave: c.wave, live: c.live.length };
    },

    /** The vault: the chest, its warden, and the gold. */
    async realmVault({ settleFrames = 45 } = {}) {
      await begin();
      await enterRealm('vault');
      const c = ctx.realms.active.controller;
      await wait(40);
      const o2 = ctx.stage.origin;
      placePlayer(-Math.PI / 2, 19);
      look(o2.x + 3.5, 5.0, o2.z - 25, o2.x, 3.4, o2.z);
      await wait(settleFrames);
      freeze();
      mustContain('24-realm-vault', [
        { subject: 'the vault chest', objects: () => (c.chest ? [c.chest.group] : []), minPixels: 1400 },
        { subject: 'the vault warden', objects: () => rigs([c.guard]), minPixels: 700 },
        { subject: 'the chest is sealed', dom: () => c.chest?.sealed === true },
        { subject: 'the survivor', objects: () => [ctx.player?.group].filter(Boolean), minPixels: 250 },
      ]);
      return { sealed: c.chest?.sealed, guard: !!c.guard };
    },

    /** Phase 1: the Herald on the full arena. */
    async finalePhase1({ settleFrames = 60 } = {}) {
      await begin();
      await enterRealm('fracture');
      await wait(50);
      const b = ctx.realms.active.controller.boss;
      // Framed off the *boss*, not off the arena: the first pass aimed from the
      // rim and put the Herald 45 m away at 899 px. The survivor stands between
      // the lens and it, which is also what gives the frame its scale cue.
      const bp = b.position;
      placePlayer(Math.atan2(bp.z + 11 - ctx.stage.origin.z, bp.x + 2 - ctx.stage.origin.x),
                  Math.hypot(bp.x + 2 - ctx.stage.origin.x, bp.z + 11 - ctx.stage.origin.z));
      look(bp.x + 5.5, 3.4, bp.z + 20, bp.x, bp.y + 2.6, bp.z);
      await wait(settleFrames);
      freeze();
      mustContain('25-finale-phase1', [
        { subject: 'the Herald', objects: () => rigs([b]), minPixels: 2000 },
        { subject: 'phase 1 arena', dom: () => Math.round(ctx.stage.floorRadius) === 34, detail: () => ctx.stage.floorRadius },
        { subject: 'the boss bar', dom: () => !!ctx.hud?.boss, detail: () => ctx.hud?.boss?.name ?? null },
        { subject: 'the survivor', objects: () => [ctx.player?.group].filter(Boolean), minPixels: 220 },
      ]);
      return { phase: b.phase, floor: ctx.stage.floorRadius };
    },

    /** Phase 2: the rim is gone and three anchors hold the ward up. */
    async finalePhase2({ settleFrames = 50 } = {}) {
      const c = ctx.realms.active?.controller;
      if (!c) return null;
      thaw();
      const b = await pushBossTo(0.66, 220);
      placePlayer(0.6, 12, 3.6);
      const o = ctx.stage.origin;
      // High and wide: the subject of this frame is the *arena*, specifically
      // the twelve metres of it that just fell away, so the rim has to be in
      // shot along with the anchors standing on what is left.
      look(o.x + 19, 12, o.z + 19, o.x, 2.2, o.z);
      await wait(settleFrames);
      freeze();
      mustContain('26-finale-phase2', [
        { subject: 'the rift anchors', objects: () => rigs(c.anchors), perObject: true, minPixels: 600, minObjects: 2 },
        { subject: 'the collapsed floor', dom: () => ctx.stage.floorRadius <= 23, detail: () => +ctx.stage.floorRadius.toFixed(1) },
        { subject: 'the Herald is warded', dom: () => c.warded === true && c.boss.baseArmor > 1000, detail: () => c.boss?.baseArmor },
        { subject: 'the Herald', objects: () => rigs([b]), minPixels: 600 },
      ]);
      return { phase: b?.phase, floor: ctx.stage.floorRadius, anchors: c.anchors.length };
    },

    /** Phase 3: a core disc, three islands, and no healing. */
    async finalePhase3({ settleFrames = 50 } = {}) {
      const c = ctx.realms.active?.controller;
      if (!c) return null;
      thaw();
      // Break the ward the way a player does — the anchors have to die before
      // phase 3 means anything.
      const kill = { source: null, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'harness', isDot: true };
      for (const a of c.anchors.slice()) {
        for (let i = 0; i < 12 && a.alive; i++) {
          a._iframeUntil = 0;
          ctx.combat?.applyDamage?.(a, a.health + a.shield + 1e5, kill);
          await frames(1);
        }
      }
      await wait(30);
      const b = await pushBossTo(0.36, 240);
      placePlayer(2.6, 8, 5.7);
      const o = ctx.stage.origin;
      look(o.x + 21, 15, o.z + 21, o.x, 2.0, o.z);
      await wait(settleFrames);
      freeze();
      mustContain('27-finale-phase3', [
        { subject: 'the Herald', objects: () => rigs([b]), minPixels: 600 },
        { subject: 'the reduced floor', dom: () => ctx.stage.floorRadius <= 15, detail: () => +ctx.stage.floorRadius.toFixed(1) },
        { subject: 'the three islands', dom: () => ctx.stage.platforms.length === 3, detail: () => ctx.stage.platforms.length },
        { subject: 'the ward is broken', dom: () => c.warded === false },
        { subject: 'healing suppressed', dom: () => ctx.director?.healingDenied === true },
      ]);
      return { phase: b?.phase, floor: ctx.stage.floorRadius, platforms: ctx.stage.platforms.length };
    },

    /**
     * The victory ending, end to end: kill the Herald, let the outro run, and
     * check that a *victory* record reached the profile and the existing
     * run-summary screen came up.
     */
    async finaleVictory({ settleFrames = 40 } = {}) {
      const c = ctx.realms.active?.controller;
      if (!c) return null;
      thaw();
      const b = c.boss;
      const kill = { source: ctx.player, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'harness', isDot: true };
      for (let i = 0; i < 40 && b.alive; i++) {
        b._iframeUntil = 0;
        ctx.combat?.applyDamage?.(b, b.maxHealth, kill);
        await frames(1);
      }
      // The outro hold, then the summary. Six seconds of frames rather than a
      // wall-clock wait, so a slow machine sees the same sequence.
      for (let i = 0; i < 900 && ctx.hud?.menus?.screen !== 'death'; i++) await frames(1);
      await wait(settleFrames);
      freeze();
      const record = ctx.profile?.runHistory?.()[0] ?? null;
      mustContain('28-finale-victory', [
        { subject: 'the run-summary screen', dom: () => ctx.hud?.menus?.screen === 'death', detail: () => ctx.hud?.menus?.screen },
        { subject: 'a victory record in the profile', dom: () => record?.outcome === 'victory', detail: () => record && { outcome: record.outcome, stage: record.stage, time: Math.round(record.time) } },
        { subject: 'the ending is named', dom: () => ctx.progression?.ending?.id === ENDINGS.victory.id, detail: () => ctx.progression?.ending?.id ?? null },
      ]);
      return { record, ending: ctx.progression?.ending?.id ?? null };
    },

    /**
     * The other ending. Runs before the finale sequence and resets the run
     * afterwards — one page is one run, and both endings latch
     * `Progression._ended`, so the alternative has to be photographed first and
     * then explicitly cleared.
     */
    async endingObliterate({ settleFrames = 40 } = {}) {
      await begin();
      await enterRealm('bazaar');
      const ob = ctx.realms.props.find((p) => p.kind === 'obelisk');
      placePlayer(1.9, 8, 5.05);
      const o = ctx.stage.origin;
      look(o.x + 13, 6.5, o.z + 13, o.x, 4.0, o.z);
      // Both presses, as a player makes them: the first arms it, the second
      // commits. A single call would not exercise the confirmation at all.
      ob?.interact();
      await frames(6);
      ob?.interact();
      for (let i = 0; i < 600 && ctx.hud?.menus?.screen !== 'death'; i++) await frames(1);
      await wait(settleFrames);
      freeze();
      const record = ctx.profile?.runHistory?.()[0] ?? null;
      mustContain('29-ending-obliterate', [
        { subject: 'the run-summary screen', dom: () => ctx.hud?.menus?.screen === 'death', detail: () => ctx.hud?.menus?.screen },
        { subject: 'an obliterated record in the profile', dom: () => record?.outcome === 'victory', detail: () => record && { outcome: record.outcome, stage: record.stage } },
        { subject: 'the ending is named', dom: () => ctx.progression?.ending?.id === ENDINGS.obliterated.id, detail: () => ctx.progression?.ending?.id ?? null },
      ]);
      return { record, ending: ctx.progression?.ending?.id ?? null };
    },

    /**
     * Harness-only: put a finished run back on its feet so the second ending
     * can be photographed in the same page. Nothing in the game calls this.
     */
    resetRun() {
      thaw();
      const pr = ctx.progression;
      if (pr) { pr._ended = false; pr.ending = null; }
      ctx.profile?.beginRun?.();
      const p = ctx.player;
      if (p) {
        p.alive = true;
        p.health = p.stats?.maxHealth || p.maxHealth || 100;
      }
      if (ctx.director) ctx.director.enabled = true;
      if (ctx.realms?.inRealm) ctx.realms._exit();
      ctx.hud?.menus?.close?.();
      ctx.paused = false;
      return { ended: ctx.progression?._ended ?? null };
    },
  };

  Object.assign(H, S);
  return S;
}
