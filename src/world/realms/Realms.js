import * as THREE from 'three';
import {
  REALM_BY_ID, GATEWAYS, FINALE_STAGE, ENDINGS, VOID_KILL_Y,
} from '../../data/realms.js';
import { SPAWN_CARDS, TIER_UNLOCK, ENEMY_BY_ID, eliteAffixesFor } from '../../data/enemies.js';
import { RealmStage, pullToFloor } from './RealmStage.js';
import { buildArena } from './RealmArena.js';
import {
  RealmGateway, RealmPortal, MarketStall, Refinery, Obelisk, TrialPlinth, VaultChest,
  rollMarketStock,
} from './RealmProps.js';
import { FinaleController } from './FinalBoss.js';

/**
 * Hidden realms, the finale, and the two ways a run can end.
 *
 * A realm is not another stage. It is a *detour with its own rules*: the market
 * has no director at all, the trial spawns its own waves in a room you cannot
 * leave sideways, the vault is one elite standing between you and a chest, and
 * the Fracture takes the floor away between phases. What they share is only the
 * plumbing, which is all this file is.
 *
 * ## How a realm is entered without ending the stage
 *
 * The whole trick is that realms are built at `REALM_ORIGIN_X` — four kilometres
 * away on +X — and the world stage is left *standing*. Entering swaps
 * `ctx.stage` for a `RealmStage` and moves the player; leaving swaps it back and
 * puts the player exactly where they were. Nothing is regenerated, no gameplay
 * RNG is consumed on the way in or out, and the chests you had not opened yet
 * are still shut. A realm that tore the stage down would have to rebuild it, and
 * rebuilding it would re-roll it.
 *
 * ## Authority
 *
 * Every decision here is the host's: which gateways exist, what the market
 * stocks, when a wave spawns, when the floor collapses, when the run ends.
 * Clients learn about it from the `realmEnter` / `realmExit` events (forwarded
 * by NetHost) and rebuild the same arena from the realm id — the arenas are
 * authored, so there is nothing seeded to agree about. Enemies and props inside
 * a realm arrive as ordinary snapshot views, exactly as they do on a stage.
 */

const _v = new THREE.Vector3();

export class Realms {
  constructor() {
    this.active = null;         // { def, stage, controller }
    this.armedRealm = null;     // realm id armed by a Tithe Altar this stage
    this.used = new Set();      // once-per-run gateways already taken
    this.gateways = [];
    this.props = [];            // realm interactables we pushed into Interactables
    this._saved = null;
    this._pendingEnter = null;
    this._voidT = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.realms = this;

    // A new stage clears anything realm-shaped that belonged to the old one.
    // The armed flag goes with it: an altar paid for on stage 3 opens a portal
    // on stage 3, and carrying it forward would be a free second visit.
    ctx.events.on('stageStart', () => {
      this.gateways.length = 0;
      this.armedRealm = null;
    });

    // A client follows the host in and out. It never decides either.
    ctx.events.on('realmEnter', (e) => {
      if (ctx.authority || !e?.id) return;
      this._enter(e.id, { replicated: true });
    });
    ctx.events.on('realmExit', () => {
      if (ctx.authority) return;
      this._exit({ replicated: true });
    });

    // Dying inside a realm ends the run like dying anywhere else; the realm
    // just has to stop driving waves at a corpse.
    ctx.events.on('playerDead', () => { this.active?.controller?.abort?.(); });
  }

  get inRealm() { return !!this.active; }
  get realmId() { return this.active?.def.id ?? null; }

  // ------------------------------------------------------------- gateways

  /**
   * Place this stage's gateways. Called by Progression once the stage exists
   * and has been populated, so a gateway is sited against the same landmarks
   * the chests are and never lands on top of the teleporter.
   *
   * Host only: every roll here is `ctx.rng`, and a client that rolled its own
   * would both desync the shared stream and invent a doorway the host has never
   * heard of. Clients receive the gateways as replicated interactables.
   */
  onStagePopulated(stageIndex) {
    const ctx = this.ctx;
    if (!ctx.authority || this.inRealm) return;
    const marks = ctx.stage?.landmarks ?? [];
    let i = 0;
    for (const gate of GATEWAYS) {
      if (stageIndex < gate.minStage) continue;
      if (gate.once && this.used.has(gate.realm)) continue;
      if (ctx.rng.next() > gate.chance) continue;
      const realm = REALM_BY_ID.get(gate.realm);
      if (!realm) continue;
      // Sited well away from the middle of the basin: a gateway is meant to be
      // *found*, and one standing next to the teleporter is not a detour.
      const m = marks.length ? marks[(i + 1) % marks.length] : null;
      const at = ctx.interactables._sited
        ? ctx.interactables._sited(m, (m?.r ?? 0) + 8, (m?.r ?? 0) + 26, ctx.player?.position)
        : ctx.stage.randomWalkablePoint(ctx.rng, { minDistFrom: ctx.player?.position, minDist: 24 });
      const g = new RealmGateway(ctx, at, gate, realm, gate.cost(stageIndex));
      ctx.interactables.add(g);
      this.gateways.push(g);
      i++;
    }
  }

  /** A Tithe Altar was paid for: open a way at the end of the stage. */
  armRealm(id) {
    if (!this.ctx.authority) return;
    this.armedRealm = id;
    this.used.add(id);
    this.ctx.hud?.setObjective?.('A way has opened — clear the stage to take it');
  }

  /**
   * The loot window has ended and Progression has just put the ordinary portal
   * down. Add whatever else this stage has earned beside it.
   *
   * Two portals side by side is the whole shape of the ending: the run never
   * *forces* you to finish, and taking the ordinary one loops exactly as it did
   * before, difficulty ramp untouched.
   */
  openPortals(at, stageIndex) {
    const ctx = this.ctx;
    if (!ctx.authority) return;

    if (this.armedRealm) {
      const realm = REALM_BY_ID.get(this.armedRealm);
      const id = this.armedRealm;
      this.armedRealm = null;
      const p = new RealmPortal(ctx, _v.copy(at).add(new THREE.Vector3(-8, 0, 0)).clone(), {
        label: `Enter ${realm.name}`, tint: 0x9b5cff,
        onEnter: () => this.requestEnter(id),
      });
      ctx.interactables.add(p);
    }

    if (stageIndex >= FINALE_STAGE) {
      const p = new RealmPortal(ctx, _v.copy(at).add(new THREE.Vector3(0, 0, -8)).clone(), {
        label: 'Enter The Fracture — this ends the run', tint: 0xff4ad0,
        onEnter: () => this.requestEnter('fracture'),
      });
      ctx.interactables.add(p);
      ctx.hud?.setObjective?.('Proceed — or take the Fracture and finish it');
    }
  }

  // ---------------------------------------------------------- enter / exit

  /** Host-side entry point. Everything below assumes authority. */
  requestEnter(id) {
    if (!this.ctx.authority || this.inRealm) return false;
    const def = REALM_BY_ID.get(id);
    if (!def) return false;
    this.used.add(id);
    // Deferred by one fixed step: `requestEnter` is reached from inside
    // `Interactables.fixedUpdate`, which is mid-iteration over the very list
    // the entry is about to rewrite.
    this._pendingEnter = id;
    return true;
  }

  fixedUpdate(ctx, h) {
    if (this._pendingEnter && ctx.authority) {
      const id = this._pendingEnter;
      this._pendingEnter = null;
      this._enter(id);
    }
    if (!this.active) return;

    // Void recovery. The Fracture is the only arena with a hole in it, and
    // falling has to cost something real without being an instant run-ender —
    // a two-hour run lost to a mis-timed dodge is not a lesson.
    const p = ctx.player;
    if (ctx.authority && p?.alive && p.position.y < VOID_KILL_Y) {
      const max = p.stats?.maxHealth || p.maxHealth || 100;
      ctx.combat?.applyDamage?.(p, max * 0.34, {
        source: null, ignoreArmor: true, procCoefficient: 0, procDepth: 99, type: 'void',
        position: p.position.clone(),
      });
      pullToFloor(this.active.stage, p.position);
      p.velocity?.set(0, 0, 0);
      ctx.pipeline?.addShake?.(0.3);
    }

    this.active.controller?.fixedUpdate?.(ctx, h);
  }

  update(ctx, dt) { this.active?.controller?.update?.(ctx, dt); }

  _enter(id, { replicated = false } = {}) {
    const ctx = this.ctx;
    if (this.active) return;
    const def = REALM_BY_ID.get(id);
    if (!def) return;

    const world = ctx.stage;
    this._saved = {
      stage: world,
      position: ctx.player?.position.clone() ?? new THREE.Vector3(),
      biome: world?.biome ?? null,
      terrainVisible: world?.terrainMesh?.visible ?? true,
      propsVisible: world?.propsGroup?.visible ?? true,
      directorEnabled: ctx.director?.enabled ?? true,
      teleporterPosition: ctx.progression?.teleporterPosition ?? null,
    };

    // The world stays standing, and stops being drawn. Hiding rather than
    // disposing is the whole reason a return trip is free.
    if (world?.terrainMesh) world.terrainMesh.visible = false;
    if (world?.propsGroup) world.propsGroup.visible = false;

    const stage = new RealmStage(ctx, def);
    buildArena(stage);
    ctx.stage = stage;

    // The director keeps ticking (its enemies still move, still die, still get
    // reaped) but stops *buying*: every monster in a realm is placed by name.
    if (ctx.director) {
      ctx.director.clear(ctx);
      ctx.director.enabled = false;
      ctx.director.eventActive = false;
    }
    // Nothing on the old stage is an objective any more.
    if (ctx.progression) ctx.progression.teleporterPosition = null;
    ctx.hud?.setPrompt?.(null);

    ctx.environment?.applyBiome?.(def.air);

    const spawn = stage.spawnPoint();
    const p = ctx.player;
    if (p) {
      if (p.respawnAt) p.respawnAt(spawn);
      else { p.position.copy(spawn); p.velocity?.set(0, 0, 0); }
    }

    this.active = { def, stage, controller: null };
    this.active.controller = makeController(this, def);
    if (ctx.authority || replicated) this.active.controller?.enter?.(ctx, stage);

    ctx.hud?.setObjective?.(def.objective);
    ctx.hud?.toast?.(def.toast, 'stage');
    ctx.audio?.play?.('teleporterComplete');
    if (ctx.authority) ctx.events.emit('realmEnter', { id: def.id });
  }

  /** Leave the active realm. `advance` moves the run on rather than back. */
  _exit({ replicated = false } = {}) {
    const ctx = this.ctx;
    const a = this.active;
    if (!a) return;
    const advance = a.def.exit === 'advance';

    a.controller?.exit?.(ctx);
    this._clearProps();
    this.active = null;

    // Order matters: `ctx.stage` has to be the world again before anything
    // asks Progression to build the next one, or `advanceStage` would call
    // `build()` on a realm.
    const s = this._saved;
    ctx.stage = s.stage;
    if (s.stage?.terrainMesh) s.stage.terrainMesh.visible = s.terrainVisible;
    if (s.stage?.propsGroup) s.stage.propsGroup.visible = s.propsVisible;
    if (ctx.director) {
      ctx.director.clear(ctx);
      ctx.director.enabled = s.directorEnabled;
    }
    ctx.environment?.applyBiome?.(s.biome ?? undefined);
    a.stage.dispose();

    if (advance) {
      if (ctx.authority) ctx.progression?.advanceStage?.();
    } else {
      const p = ctx.player;
      if (p) {
        if (p.respawnAt) p.respawnAt(s.position);
        else { p.position.copy(s.position); p.velocity?.set(0, 0, 0); }
      }
      if (ctx.progression) ctx.progression.teleporterPosition = s.teleporterPosition;
      ctx.hud?.setObjective?.(ctx.progression?.state === 'idle'
        ? 'Find and activate the teleporter' : 'Proceed to the next stage');
    }
    this._saved = null;
    ctx.hud?.setPrompt?.(null);
    if (ctx.authority && !replicated) ctx.events.emit('realmExit', {});
  }

  // ------------------------------------------------------------ prop helper

  /**
   * Put a realm prop on the stage.
   *
   * They go into the *existing* `Interactables` list rather than into a list of
   * our own, which is what buys the prompt line, the E handling, the focus
   * logic and snapshot replication for free — this file owns no UI and no
   * netcode of its own.
   */
  addProp(obj) {
    this.ctx.interactables.add(obj);
    this.props.push(obj);
    return obj;
  }

  _clearProps() {
    const list = this.ctx.interactables?.list;
    for (const o of this.props) {
      if (list) {
        const i = list.indexOf(o);
        if (i >= 0) list.splice(i, 1);
      }
      this.ctx.interactables?.root?.remove?.(o.group);
      o.dispose();
    }
    this.props.length = 0;
  }

  /** Exit portal, placed by every realm's controller when it is time to go. */
  spawnExit(label = 'Leave', tint = 0x66ddff, offset = new THREE.Vector3(0, 0, 9)) {
    const stage = this.active.stage;
    const at = stage.origin.clone().add(offset);
    return this.addProp(new RealmPortal(this.ctx, at, {
      label, tint, onEnter: () => this._exit(),
    }));
  }

  /** The Crucible's plinth was pressed. */
  beginTrial() {
    if (!this.ctx.authority) return;
    this.active?.controller?.begin?.();
  }

  // ---------------------------------------------------------------- endings

  /** The Obelisk of Departure. A deliberate, non-lethal end to the run. */
  obliterate() {
    const ctx = this.ctx;
    if (!ctx.authority) return;
    ctx.vfx?.explosion?.(ctx.player?.position ?? this.active.stage.origin, 14, 0xb060ff);
    ctx.pipeline?.addShake?.(0.7);
    ctx.progression?.finishRun?.(ENDINGS.obliterated);
  }

  /** Called by the finale controller once the Herald is down. */
  victory() {
    this.ctx.progression?.finishRun?.(ENDINGS.victory);
  }

  // --------------------------------------------------------------- harness

  /**
   * Drop straight into a realm. Used by the realm harness scenarios, which have
   * no way to walk a player to a gateway and no reason to.
   */
  forceEnter(id) {
    if (this.inRealm) this._exit();
    this._pendingEnter = null;
    this._enter(id);
    return this.active;
  }
}

// ---------------------------------------------------------------------------
// controllers — one per realm kind
// ---------------------------------------------------------------------------

function makeController(realms, def) {
  if (def.kind === 'hub') return new MarketController(realms, def);
  if (def.kind === 'trial') return new TrialController(realms, def);
  if (def.kind === 'treasure') return new VaultController(realms, def);
  if (def.kind === 'finale') return new FinaleController(realms, def);
  return null;
}

/** Highest-tier card the run has actually unlocked, for realm-placed monsters. */
function cardsFor(ctx) {
  const d = ctx.director?.difficultyCoefficient ?? 1;
  const pool = SPAWN_CARDS.filter((c) => d >= (TIER_UNLOCK[c.tier] || 0));
  return pool.length ? pool : SPAWN_CARDS.slice(0, 3);
}

// --------------------------------------------------------------- the market

class MarketController {
  constructor(realms, def) { this.realms = realms; this.def = def; }

  enter(ctx, stage) {
    if (!ctx.authority) return;
    const y = stage.daisY ?? 0;
    const stock = rollMarketStock(ctx, ctx.progression?.stageIndex ?? 0);
    // Three stalls on an arc facing the middle of the room, so all three are in
    // one frame from the dais and the choice is made by looking rather than by
    // walking a circle reading prompts.
    stock.forEach((s, i) => {
      const a = -0.9 + i * 0.9;
      const at = stage.origin.clone().add(
        new THREE.Vector3(Math.cos(a) * 13, 0, Math.sin(a) * 13));
      this.realms.addProp(new MarketStall(ctx, at, s.id, s.cost, i));
    });

    const ref = stage.origin.clone().add(new THREE.Vector3(-12, 0, -9));
    this.realms.addProp(new Refinery(ctx, ref, Math.round(90 * Math.pow(1.25, ctx.progression?.stageIndex ?? 0))));

    this.realms.addProp(new Obelisk(ctx, stage.origin.clone().setY(y)));
    this.realms.spawnExit('Leave — on to the next stage', 0x66ddff, new THREE.Vector3(0, 0, 22));
  }
}

// ---------------------------------------------------------------- the trial

/**
 * Five waves in a room with no cover to speak of, for one large payout.
 *
 * The exit portal exists from the moment you arrive, deliberately: a realm you
 * cannot leave without winning is a trap rather than a gamble, and the trial's
 * risk is supposed to be "this fight might kill me", not "I am locked in".
 */
class TrialController {
  constructor(realms, def) {
    this.realms = realms;
    this.def = def;
    this.wave = 0;
    this.state = 'idle';   // idle | fighting | break | done
    this.timer = 0;
    this.live = [];
  }

  enter(ctx, stage) {
    if (!ctx.authority) return;
    // Off the middle: dead centre it stands between the lens and every monster
    // in the room, which is what the first capture of this arena showed.
    this.plinth = this.realms.addProp(new TrialPlinth(
      ctx, stage.origin.clone().add(new THREE.Vector3(-9, 0, -9))));
    this.realms.spawnExit('Leave the Crucible', 0xff8a3c, new THREE.Vector3(0, 0, stage.floorRadius - 3.5));
  }

  begin() {
    if (this.state !== 'idle') return;
    this.state = 'break';
    this.timer = 1.5;
    this.wave = 0;
    this.ctxHud('Wave 1 incoming');
  }

  ctxHud(text) { this.realms.ctx.hud?.setObjective?.(text); }

  fixedUpdate(ctx, h) {
    if (!ctx.authority || this.state === 'idle' || this.state === 'done') return;

    if (this.state === 'break') {
      this.timer -= h;
      if (this.timer > 0) return;
      this.wave++;
      this._spawnWave(ctx);
      this.state = 'fighting';
      this.ctxHud(`Wave ${this.wave} of ${this.def.waves}`);
      return;
    }

    // Wave clear is measured off the units this controller placed, not off the
    // director's list: the player's own deployables and anything a summon
    // hatched are in that list too and would keep the wave open forever.
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (!this.live[i].alive) this.live.splice(i, 1);
    }
    if (this.live.length) return;

    if (this.wave >= this.def.waves) {
      this.state = 'done';
      this._payout(ctx);
      return;
    }
    this.state = 'break';
    this.timer = this.def.waveBreak;
    this.ctxHud(`Wave ${this.wave} cleared — ${this.def.waves - this.wave} to go`);
  }

  _spawnWave(ctx) {
    const stage = this.realms.active.stage;
    const pool = cardsFor(ctx);
    // Budget, not a fixed roster: the trial has to be worth the same amount of
    // trouble at minute four and at minute twenty-four, so it scales off the
    // director's own coefficient the way an ordinary wave does.
    const budget = (18 + this.wave * 14) * Math.max(1, ctx.director?.difficultyCoefficient ?? 1);
    let spent = 0;
    let guard = 0;
    while (spent < budget && guard++ < 24) {
      const card = ctx.rng.weighted(pool, (c) => (c.selectionWeight ?? 1) * Math.sqrt(c.cost));
      const at = stage.randomWalkablePoint(ctx.rng, { minDistFrom: ctx.player?.position, minDist: 12 });
      // The last wave is the one that gets the elites, so the trial escalates
      // into something rather than just adding bodies.
      const affix = this.wave >= this.def.waves - 1 && card.eliteEligible && ctx.rng.next() < 0.45
        ? ctx.rng.pick(eliteAffixesFor(ctx.director?.difficultyCoefficient ?? 1)) : null;
      const e = ctx.director?.spawnOne?.(ctx, card, at, affix);
      if (e) this.live.push(e);
      spent += card.cost * (affix ? 4 : 1);
    }
    ctx.pipeline?.addShake?.(0.2);
    ctx.audio?.play?.('teleporterStart');
  }

  _payout(ctx) {
    const stage = this.realms.active.stage;
    const at = stage.origin.clone();
    const ids = [
      ctx.items.rollItem('legendary'),
      ctx.items.rollItem('uncommon'),
      ctx.items.rollItem('uncommon'),
    ].filter(Boolean);
    for (const id of ids) ctx.interactables.spawnOrb(at, id, 2.8);
    ctx.items?.addGold?.(Math.round(220 * Math.pow(1.3, ctx.progression?.stageIndex ?? 0)));
    ctx.vfx?.explosion?.(at, 8, 0xffb060);
    ctx.pipeline?.addShake?.(0.4);
    this.ctxHud('Trial complete — take the portal');
  }

  abort() { this.state = 'done'; }
}

// ---------------------------------------------------------------- the vault

/** One elite, one chest. The chest is sealed until the elite is not standing. */
class VaultController {
  constructor(realms, def) { this.realms = realms; this.def = def; }

  enter(ctx, stage) {
    if (!ctx.authority) return;
    const drops = [
      ctx.items.rollItem('legendary'),
      ctx.items.rollItem('legendary'),
      ctx.items.rollItem('uncommon'),
    ].filter(Boolean);
    this.chest = this.realms.addProp(
      new VaultChest(ctx, stage.origin.clone().setY(stage.daisY ?? 0), drops));
    this.realms.spawnExit('Leave the Vault', 0xffc850, new THREE.Vector3(0, 0, stage.floorRadius - 4));

    const card = ENEMY_BY_ID.get('warden_vault');
    const at = stage.origin.clone().add(new THREE.Vector3(0, 0, -12));
    const affix = ctx.rng.pick(eliteAffixesFor(ctx.director?.difficultyCoefficient ?? 1));
    this.guard = ctx.director?.spawnOne?.(ctx, card, at, affix);
    if (this.guard) {
      // Scaled off the run rather than off the card, so a vault found on stage
      // 2 and one found on stage 8 are both a real fight.
      const k = Math.max(1, (ctx.director?.difficultyCoefficient ?? 1) * 0.55);
      this.guard.maxHealth = Math.round(this.guard.maxHealth * k);
      this.guard.health = this.guard.maxHealth;
      ctx.hud?.setBoss?.(this.guard);
      if (ctx.hud?.refs?.bossSub) ctx.hud.refs.bossSub.textContent = 'VAULT WARDEN';
      ctx.pipeline?.addShake?.(0.4);
    }
  }

  fixedUpdate(ctx) {
    if (!ctx.authority || !this.guard || this.chest?.sealed === false) return;
    if (this.guard.alive) return;
    this.chest?.unseal();
    ctx.hud?.clearBoss?.();
    ctx.hud?.setObjective?.('The vault is open');
    ctx.vfx?.burst?.(this.chest?.position ?? this.realms.active.stage.origin, 0xffc850);
  }

  exit(ctx) { ctx.hud?.clearBoss?.(); }
}
