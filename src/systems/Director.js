// The combat director — Risk of Rain 2's pressure curve, faithfully.
//
// Three numbers drive the entire game's escalation:
//
//   difficultyCoefficient = (playerFactor + timeFactor) * stageFactor
//     playerFactor = 0.7 + 0.3 * playerCount            (1.0 solo)
//     timeFactor   = minutes * 0.0506 * playerCount^0.2 * DIFFICULTY_SCALE
//     stageFactor  = 1.15 ^ stagesCompleted             (compounds per stage)
//
//   monster level  = 1 + floor((difficulty - playerFactor) / 0.33)
//     health x (1 + 0.30 * (level - 1)),  damage x (1 + 0.20 * (level - 1))
//
//   credits/second = 0.75 * difficulty * (1 + 0.4 * (playerCount - 1)) * modeMult
//
// The director banks credits, re-rolls a monster card on an interval, and
// spends the bank on the most expensive card it can afford — so early waves are
// scarabs and, twenty minutes in, the same bank buys sentinels by the pair.
//
// It also owns the enemy pool and every enemy-side effect pool (projectiles,
// shockwaves, beam trails) so nothing allocates once the fight is running.

import * as THREE from 'three';
import { Enemy } from '../entities/Enemy.js';
import {
  SPAWN_CARDS, BOSS_CARDS, ENEMY_BY_ID, TIER_UNLOCK, ELITE_STATS, eliteAffixesFor,
} from '../data/enemies.js';
import { prewarm, makeProjectile, makeShockwave, makeTelegraph } from '../entities/EnemyMeshes.js';
import { clamp, lerp, RNG } from '../core/MathUtil.js';
import { VOIDTOUCHED, voidCreditRate, voidBankCap, PRESSURE } from '../data/corruption.js';
import { TIERS } from '../data/items.js';
import { Roster } from './Roster.js';
import { isLocalVictim } from '../core/Engine.js';

const DIFFICULTY_SCALE = 2.0;   // Rainstorm
const CREDIT_BASE = 0.95;
const CREDIT_SEED = 10;         // opening bank, so first contact lands in the first ~15s
const HARD_POP_CAP = 64;
// Ceiling on the player's spawn-rate setting. 3x the tuned curve is already
// well past what the pop cap will let onto the stage at most difficulties.
const SPAWN_RATE_MAX = 3;
// Exported so `tests/heal-denial.test.mjs` can assert the acceptance window
// against the real numbers rather than pinning literals that would silently
// stop testing the boundary the moment either is retuned.
export const MIN_SPAWN_DIST = 34;      // far enough that the run-in is audible and visible
export const MAX_SPAWN_DIST = 90;
const FAR_SPAWN_DIST = 52;      // beyond this, an on-screen spawn reads as "distant", not "popped in"
const EDGE_SPAWN_CHANCE = 0.3;
const BOSS_SPAWN_DIST = 22;   // just outside the teleporter's charge radius

// The escalation ladder. Geologic rather than the generic Easy/Hard/Insane run
// it used to carry, whose tail ("I SEE YOU", "HAHAHAHA") was Risk of Rain's
// verbatim. The register still turns from description to address at the top —
// that turn is the joke, and it survives the rename.
//
// `HUD.DIFFICULTY` carries the same list for display and must be kept in step.
const DIFFICULTY_NAMES = [
  [0.0, 'Stable'],
  [1.4, 'Shifting'],
  [2.2, 'Straining'],
  [3.2, 'Fracturing'],
  [4.5, 'Faulting'],
  [6.0, 'Collapse'],
  [8.0, 'THE GROUND REMEMBERS'],
  [10.5, 'IT IS OPENING'],
  [13.5, 'SWALLOWED'],
];

/** Enemy-side damage always goes through Combat's single path when it exists. */
function damagePlayer(ctx, target, amount, source, position, type) {
  const info = { source, position, procCoefficient: 0, type };
  const c = ctx.combat;
  if (c && c.applyDamage) c.applyDamage(target, amount, info);
  else if (target.takeDamage) target.takeDamage(amount, info);
}

const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export class Director {
  // Spawning and the escalation curve. A throw mid-spawn leaves an enemy half
  // registered, and a throw anywhere quietly flattens the pressure the run is
  // supposed to be applying.
  static critical = true;

  constructor() {
    this.enemies = [];
    this.pool = new Map();

    this.difficultyCoefficient = 1;
    // The same curve with the corruption term left out — what a kill is *paid*
    // against. See `updateDifficulty`.
    this.rewardCoefficient = 1;
    this.difficultyName = 'Easy';
    this.difficultyIndex = 0;
    this.level = 1;
    this.playerCount = 1;
    this.stagesCompleted = 0;

    this.credits = CREDIT_SEED;
    this.creditRate = 0;
    this.card = null;
    this.rerollT = 0;
    this.spawnT = 2.0;
    this.eventActive = false;
    this.boss = null;
    this.enabled = true;

    // The void's own economy — see VOIDTOUCHED in data/corruption.js. Seeds
    // are tracked here (not read from ctx.corruption.seeds) because that list
    // is run-scoped and this one must die with the stage.
    this.voidCredits = 0;
    this.voidSpawnT = 0;
    this._voidSeeds = [];
    this._voidPending = [];
    this._voidRng = new RNG(1);

    this.projectiles = new Projectiles();
    this.waves = new Waves();
    this.trails = new Trails();
    this.telegraphs = new Telegraphs();

    // Bosses are drawn without replacement so a run does not show the same one
    // three stages running.
    this._bossBag = [];
    // Reused damage-info for the warded reflect, so a barrier under sustained
    // fire allocates nothing.
    //
    // This is module-scratch handed to a call that CAN synchronously re-enter
    // the writer, which is the shape that produced the `fireBeam` bug. The path
    // is real, and it is not the one you would guess: the reflect's own hit
    // cannot re-trigger the `damage` handler below (its source is the elite, and
    // the handler wants `isPlayer`), but `Combat.applyDamage` on the player
    // dispatches `onDamaged`, and Iron Thornplate and Barb Snare retaliate from
    // inside that dispatch with `source: api.player`. If that retaliation lands
    // on a *second* warded elite, the handler fires again and overwrites the
    // fields of this very object while the outer `applyDamage` is still on the
    // stack.
    //
    // It is safe, and structurally rather than by luck: `applyDamage` reads
    // `info.source` and `info.position` into locals *before* it dispatches
    // anything (`Combat.js`, `const source = info.source` and `const pos =
    // info.position || target.position`), and the only fields it reads *after*
    // the dispatch are `procCoefficient`, `procDepth` and `type` — which on this
    // object are a literal 0, never set at all, and a constant string. A nested
    // write therefore cannot change any value the outer call has yet to read.
    //
    // What that costs: this holds only while those two reads stay ahead of the
    // dispatch and while every mutable field here is read early. Adding a field
    // that Combat reads late, or moving a read below the hook dispatch, breaks
    // it silently — a reflect would then pay the wrong player or draw its
    // numbers at the wrong elite's feet. Allocate per hit instead of extending
    // this object.
    this._reflect = { source: null, position: null, procCoefficient: 0, type: 'reflect' };

    this._frustum = new THREE.Frustum();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 7);
    this._point = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
  }

  init(ctx) {
    ctx.director = this;
    this.ctx = ctx;

    // Warm the mesh pools so the first contact doesn't hitch on geometry work.
    // Weighted by how many of each the director can actually have standing at
    // once, not by how interesting they are: warming one of every card would
    // cost the boot frame far more than it saves, and the heavies arrive one at
    // a time minutes later with plenty of frames to build in.
    // Every spawn card gets at least a couple of rigs: geometry is cached
    // globally so the second rig of a species is only an Object3D tree, and the
    // alternative is paying for it on the frame the unit walks into the fight.
    for (const c of SPAWN_CARDS) prewarm(c.meshFactory, c.tier === 1 ? 4 : 2);
    prewarm('mite', 14);
    prewarm('scarab', 12);
    prewarm('skink', 8);
    prewarm('spitling', 6);
    prewarm('mote', 5);
    prewarm('shrike', 5);
    prewarm('sentinel', 3);

    this.projectiles.init(ctx);
    this.waves.init(ctx);
    this.trails.init(ctx);
    this.telegraphs.init(ctx);

    ctx.events.on('teleporterCharging', () => {
      if (!this.eventActive) this.beginTeleporterEvent(ctx);
    });
    ctx.events.on('teleporterComplete', () => this.endTeleporterEvent(ctx));
    ctx.events.on('stageStart', (p) => {
      this.stagesCompleted = p && typeof p.index === 'number' ? p.index : this.stagesCompleted + 1;
      this.credits = CREDIT_SEED;
      this.eventActive = false;
      this.boss = null;
      this.clear(ctx);
      // The void's slate is per-stage: seeds, queued surfacings and the bank
      // all die with the ground they referred to. The stream is re-derived
      // from (run seed, stage) — the shrine-roll shape — so a corrupted run
      // is deterministic per stage without ever touching ctx.rng.
      this._voidSeeds.length = 0;
      this._voidPending.length = 0;
      this.voidCredits = 0;
      this.voidSpawnT = 0;
      this._voidRng = new RNG(((ctx.seed >>> 0) ^ (0x7f4a7c15 * (this.stagesCompleted + 1))) >>> 0 || 1);
    });
    // Where greed happened. Capped mirror of the event stream, oldest first.
    ctx.events.on('blightSeed', (s) => {
      this._voidSeeds.push({ x: s.x, z: s.z, strength: s.strength });
      if (this._voidSeeds.length > 32) this._voidSeeds.shift();
    });
    // On a host a remote pawn's death is not the end of the run - stopping the
    // spawner then would empty the arena for everyone still alive.
    ctx.events.on('playerDead', (p) => { if (isLocalVictim(ctx, p)) this.enabled = false; });

    // Warded elites pay damage back out of their barrier.
    //
    // This has to hang off the `damage` event rather than off `Enemy.takeDamage`
    // because Combat drains the shield pool first and only calls `takeDamage`
    // with whatever is left over — so while the barrier is up (which is the
    // entire window the reflect is supposed to exist in) `takeDamage` is never
    // reached. The event carries the full post-armour figure, which is the
    // number the player just saw on screen, so the reflect is proportional to
    // the hit they actually landed.
    ctx.events.on('damage', (e) => {
      if (!ctx.authority || !e || !e.source?.isPlayer) return;
      const t = e.target;
      const em = t?.elite;
      if (!em || !em.reflect || !t.alive || t.shield <= 0) return;
      // The reflect pays back the player who *landed* the hit. `ctx.player` is
      // whoever this client is playing, which on a host is not the peer whose
      // shot arrived — a teammate shooting a warded elite used to bleed the
      // host. `e.source` is already known to be a player from the guard above.
      const p = e.source;
      if (!p || !p.alive) return;
      this._reflect.source = t;
      this._reflect.position = t.position;
      this.ctx.combat?.applyDamage?.(p, e.amount * em.reflect, this._reflect);
      // `type:'reflect'` has been set here since the affix shipped and read by
      // nothing, so a barrier turning your own shot around read as an ordinary
      // unattributed hit. The lattice is the ward's own class.
      this.ctx.vfx?.wardReflect?.(t.position);
    });

    this.updateDifficulty(ctx);
    this.card = SPAWN_CARDS[0];
    this._voidRng = new RNG(((ctx.seed >>> 0) ^ (0x7f4a7c15 * (this.stagesCompleted + 1))) >>> 0 || 1);
  }

  // -------------------------------------------------------------------------
  // difficulty
  // -------------------------------------------------------------------------

  get playerFactor() { return 0.7 + 0.3 * this.playerCount; }

  /**
   * Player-facing pacing knob (Settings → Enemy spawn rate). 1 is the tuned
   * curve; 0 stops ambient spawning entirely.
   *
   * It scales the credit *rate* and the population cap together. Scaling income
   * alone does almost nothing at the top end — the bank just fills against an
   * unchanged cap and then dumps the moment something dies — and scaling the cap
   * alone does nothing at the bottom, because credits still arrive at the same
   * speed. The hard cap still applies over the top of it, so no setting here can
   * put more than HARD_POP_CAP units on screen.
   *
   * Read on the host only: `fixedUpdate` early-returns without authority, so in
   * co-op the host's setting is the one that counts for everybody.
   */
  get spawnRateMult() {
    const v = this.ctx?.settings?.spawnRate;
    return Number.isFinite(v) ? clamp(v, 0, SPAWN_RATE_MAX) : 1;
  }

  updateDifficulty(ctx) {
    const pf = this.playerFactor;
    // Drizzle/Rainstorm/Monsoon multiply the *time* term and nothing else, so
    // the per-player and per-stage factors keep their tuned meaning and
    // Rainstorm (1.0) is bit-for-bit the curve this file was measured on.
    const scale = DIFFICULTY_SCALE * (ctx.difficulty?.current?.().coeff ?? 1);
    const timeFactor = (ctx.time / 60) * 0.0506 * Math.pow(this.playerCount, 0.2) * scale;
    const stageFactor = Math.pow(1.15, this.stagesCompleted);
    // The second ledger, read straight: a rotten world raises everything against
    // you, and it compounds with the stage the same way time does. World 0 makes
    // this term exactly 0, so a pristine run keeps the pre-corruption curve.
    const corFactor = (ctx.corruption?.world ?? 0) * PRESSURE.perWorld;
    this.difficultyCoefficient = (pf + timeFactor + corFactor) * stageFactor;
    // The same curve *without* the corruption term, and the one `Items.killReward`
    // pays against. Corruption must never raise gold: the director banks credits
    // at `0.95 x coefficient` and a corpse refunds `cost x coefficient`, so income
    // is quadratic in whatever goes in here while enemy HP and damage are only
    // linear in `level`. Feeding `corFactor` into both ends made rotting the world
    // the higher-EV line (2.34x gold against 1.55x HP at world 400 / 20 min /
    // stage 5) — the exact inversion of what the pressure term is for. The
    // pressure stays in `difficultyCoefficient`, where it buys threat; it is the
    // payout that has to stay blind to it. At world 0 the two are byte-identical.
    this.rewardCoefficient = (pf + timeFactor) * stageFactor;

    this.level = 1 + Math.floor(Math.max(0, this.difficultyCoefficient - pf) / 0.33);
    this.healthMult = 1 + 0.30 * (this.level - 1);
    this.damageMult = 1 + 0.20 * (this.level - 1);

    let idx = 0;
    for (let i = 0; i < DIFFICULTY_NAMES.length; i++) {
      if (this.difficultyCoefficient >= DIFFICULTY_NAMES[i][0]) idx = i;
    }
    this.difficultyIndex = idx;
    this.difficultyName = DIFFICULTY_NAMES[idx][1];
  }

  get populationCap() {
    // Swarms doubles the ceiling as well as the pack size: doubling the packs
    // against an unchanged cap just fills the same field twice as fast and then
    // stops, which is not what "twice as many monsters" means. HARD_POP_CAP
    // still wins, as it does over the spawn-rate setting.
    const swarm = this.ctx?.artifacts?.has('swarms') ? 2 : 1;
    const base = (12 + this.difficultyCoefficient * 6) * this.spawnRateMult * swarm;
    return Math.min(HARD_POP_CAP, Math.round(base * (this.eventActive ? 1.5 : 1)));
  }

  /** Alias used by tools/spawnprobe.mjs. */
  get popCap() { return this.populationCap; }

  get eliteChance() {
    if (this.difficultyCoefficient < 1.25) return 0;
    return clamp(0.02 + (this.difficultyCoefficient - 1.25) * 0.05, 0, 0.38) * (this.eventActive ? 1.35 : 1);
  }

  /**
   * Seconds between spend attempts — tightens as the run heats up.
   *
   * Short on purpose: the bank is spent on whatever it can afford (see
   * `spendCredits`), so a frequent, small spend is what produces a continuous
   * trickle early instead of a 30-second lull followed by a six-scarab dump.
   */
  get spawnInterval() {
    const base = lerp(2.6, 1.0, clamp((this.difficultyCoefficient - 1) / 6, 0, 1));
    return this.eventActive ? base * 0.5 : base;
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  fixedUpdate(ctx, h) {
    // The director is the host's alone — spawning, credits and the difficulty
    // curve all feed off the shared gameplay RNG. A client's enemies arrive as
    // snapshot views and never live in `this.enemies`.
    if (!ctx.authority) return;

    this.updateDifficulty(ctx);

    const list = this.enemies;
    for (let i = 0; i < list.length; i++) list[i].fixedUpdate(ctx, h);

    // Reap finished corpses back into the pool.
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.finished) continue;
      if (e === this.boss) {
        this.boss = null;
        ctx.events.emit('bossDead', { enemy: e });
      }
      const id = e.def ? e.def.id : null;
      e.despawn(ctx);
      list.splice(i, 1);
      if (id) {
        const p = this.pool.get(id);
        if (p) p.push(e); else this.pool.set(id, [e]);
      }
    }

    this.projectiles.fixedUpdate(ctx, h);
    this.waves.fixedUpdate(ctx, h);
    this.enforceHealDenial(ctx);

    if (!this.enabled || !ctx.player) return;

    this.creditRate = CREDIT_BASE * this.difficultyCoefficient
      * (1 + 0.4 * (this.playerCount - 1)) * (this.eventActive ? 2.4 : 1)
      * this.spawnRateMult;
    this.credits += this.creditRate * h;

    this.rerollT -= h;
    if (this.rerollT <= 0) {
      this.rerollT = this.eventActive ? 4 : 8;
      this.card = this.rollCard(ctx);
    }

    this.spawnT -= h;
    if (this.spawnT <= 0) {
      this.spawnT = this.spawnInterval;
      this.spendCredits(ctx);
    }

    // The void's bank. A separate stream and a separate budget: rate is a
    // function of World Corruption alone, spends happen only where a blight
    // seed exists this stage, and none of it draws on ctx.rng — which is the
    // whole sp-equivalence argument: at world 0 this block is two reads.
    const world = ctx.corruption?.world || 0;
    if (world > 0 && this._voidSeeds.length) {
      // The bank deepens with the world too, so a Consumed stage can hold a
      // wave rather than only ever the next single unit. `voidBankCap(0)` is
      // the old flat 90, and this branch never runs at world 0 anyway.
      //
      // The clamp is deliberately two-way: when the world FALLS — a Hollowed
      // refund, an Argent Font cleanse — the savings the void built at the
      // deeper world are confiscated down to the new cap on the very next
      // tick. That is the counterplay loop, not an accident: cleansing is
      // supposed to cost the void its war chest, otherwise a banked 240 would
      // keep paying for waves the cleansed world no longer earns.
      this.voidCredits = Math.min(voidBankCap(world), this.voidCredits + voidCreditRate(world) * h);
      this.voidSpawnT -= h;
      if (this.voidSpawnT <= 0) {
        this.voidSpawnT = VOIDTOUCHED.interval;
        this.spendVoidCredits(ctx);
      }
    }
    // Queued surfacings ripen on their own clock so the telegraph is honest.
    for (let i = this._voidPending.length - 1; i >= 0; i--) {
      const p = this._voidPending[i];
      p.t -= h;
      if (p.t > 0) continue;
      this._voidPending.splice(i, 1);
      if (this.enemies.length >= this.populationCap) continue;
      this._scratch.set(p.x, p.y, p.z);
      this.spawnOne(ctx, p.card, this._scratch, VOIDTOUCHED.affix);
      ctx.events.emit('voidtouchedSpawn', { x: p.x, z: p.z, id: p.card.id });
    }
  }

  update(ctx, dt) {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) list[i].update(ctx, dt);
    this.projectiles.update(ctx, dt);
    this.waves.update(ctx, dt);
    this.trails.update(ctx, dt);
    this.telegraphs.update(ctx, dt);
  }

  // -------------------------------------------------------------------------
  // healing denial (Withering elites)
  // -------------------------------------------------------------------------

  /**
   * Lock one player's healing for `seconds`. Called by any withering elite that
   * currently has line of sight, so overlapping elites just keep it topped up.
   *
   * The victim is required and there is deliberately no fallback. This used to
   * write a single `healDenyUntil` on the Director, so one withering elite
   * denied healing to every player on the map — including ones it had no line
   * of sight to, which is precisely the counterplay the LOS test in
   * `Enemy.js` exists to preserve. A call that cannot name a victim should do
   * nothing rather than quietly do it to everyone.
   */
  denyHealing(seconds, victim) {
    if (!victim) return;
    const t = (this.ctx?.time ?? 0) + (seconds || 2);
    if (t > (victim._healDenyUntil ?? -1)) victim._healDenyUntil = t;
  }

  /** Is this player's healing locked? Cosmetic reads are safe on clients too. */
  healingDeniedFor(player) {
    if (!player) return false;
    return (this.ctx?.time ?? 0) < (player._healDenyUntil ?? -1);
  }

  /**
   * Back-compat for the single-player read (`RealmHarness`'s finale check):
   * the local player's answer.
   */
  get healingDenied() { return this.healingDeniedFor(this.ctx?.roster?.local ?? this.ctx?.player); }

  /**
   * Enforce the lock.
   *
   * Combat.heal is the single heal path and it has no notion of a debuff, so
   * rather than reaching into it this holds a running ceiling on each denied
   * player's health: damage lowers the ceiling, healing cannot raise it. Net
   * effect is exactly RoR2's Malachite — every heal source in the game is
   * nullified at once, including ones written after this code.
   *
   * The ceiling lives on the player rather than on the Director because two
   * players can be denied by two different elites at two different times, and
   * one scalar cannot hold both.
   *
   * The sweep walks `roster.all` and does its own targetable test rather than
   * calling `forEachTargetable`, for two reasons. A plain loop takes no
   * callback, so this allocates nothing on a path that runs every fixed step
   * for the whole run. And a player who is dead or downed has to be *reached*
   * in order to have their ceiling dropped: a ceiling held across a death
   * would be re-applied the instant they were revived, slamming a player
   * brought back at full health down to whatever they died on. Clearing it
   * here means the first sweep after they stand up re-seeds the ceiling from
   * the health they were revived with, while the denial deadline — which is
   * about the elite, not about them — keeps running.
   */
  enforceHealDenial(ctx) {
    const roster = ctx.roster;
    if (!roster) return;
    const now = ctx.time ?? 0;
    const list = roster.all;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!Roster.targetable(p) || now >= (p._healDenyUntil ?? -1)) { p._healCap = null; continue; }
      if (p._healCap == null || p.health < p._healCap) p._healCap = p.health;
      else if (p.health > p._healCap) p.health = p._healCap;
    }
  }

  // -------------------------------------------------------------------------
  // spawn selection
  // -------------------------------------------------------------------------

  /**
   * Re-roll the wave's monster.
   *
   * Biased toward expensive cards, but nowhere near as hard as it used to be.
   * With five spawn cards, "70% of the time, buy the priciest thing you can
   * afford" produced a readable escalation. With sixteen it produced a run
   * where every wave past eighteen minutes was Slag Hulks and nothing else —
   * measured at 53% of all rolls — because the top card wins every roll the
   * moment the bank clears its price.
   *
   * So: the top-card shortcut is a minority case, the fallback is weighted by
   * sqrt(cost) rather than cost (which halves the spread between a 4-credit
   * mite and a 46-credit hulk), and every card carries a `selectionWeight`
   * rarity so the units that are meant to be an event stay an event. Chaff
   * therefore keeps arriving at minute twenty-five, which is exactly what RoR2
   * does and what stops the late game being six identical heavies.
   */
  rollCard(ctx) {
    const d = this.difficultyCoefficient;
    let best = null;
    const pool = [];
    for (const c of SPAWN_CARDS) {
      if (d < (TIER_UNLOCK[c.tier] || 0)) continue;
      if (this.countAlive(c) >= (c.maxAlive || 99)) continue;
      pool.push(c);
      if (c.cost <= this.credits && (!best || c.cost > best.cost)) best = c;
    }
    if (!pool.length) return this.card || SPAWN_CARDS[0];
    if (best && ctx.rng.next() < 0.3) return best;
    // The pool is NOT filtered to what the bank can afford, and that is the
    // whole point. `spendCredits` empties the bank on a 1-2.6 s timer, so a
    // director that only ever considered affordable cards had a bank that never
    // exceeded a few credits and could not reach a 34-credit bombard, let alone
    // a 46-credit hulk — measured over a 45 s window at minute 22, the entire
    // field was mites and scarabs. Selecting something it cannot yet afford is
    // how it saves: the spend is skipped and the bank grows until the card lands.
    //
    // `reach` keeps that from becoming a stall. A card at four times the bank is
    // still reachable but a quarter as likely, so the director saves toward the
    // heavies without ever parking on one for half a minute.
    return ctx.rng.weighted(pool, (c) => {
      const reach = clamp(this.credits / c.cost, 0, 1);
      return (c.selectionWeight ?? 1) * Math.sqrt(c.cost) * (0.22 + 0.78 * reach);
    });
  }

  /** How many of this card are currently standing. */
  countAlive(card) {
    let n = 0;
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      if (list[i].alive && list[i].def === card) n++;
    }
    return n;
  }

  /**
   * A random affordable card with room on the field, or null.
   *
   * A card the bank can cover right now, used as filler while it saves toward
   * something expensive: a director that goes silent for fifteen seconds every
   * time it selects a hulk reads as broken, however correct the saving is.
   */
  fillerCard(ctx, budget) {
    const d = this.difficultyCoefficient;
    const pool = [];
    for (const c of SPAWN_CARDS) {
      if (d < (TIER_UNLOCK[c.tier] || 0)) continue;
      if (c.cost > budget) continue;
      if (this.countAlive(c) >= (c.maxAlive || 99)) continue;
      pool.push(c);
    }
    if (!pool.length) return null;
    // Weighted, not cheapest. Always taking the cheapest option turned the
    // filler into a second mite tap that ran on every single interval, which is
    // the exact monoculture the saving behaviour exists to break.
    return ctx.rng.weighted(pool, (c) => (c.selectionWeight ?? 1) * Math.sqrt(c.cost));
  }

  /** Buy and place one group. */
  spendCredits(ctx) {
    let card = this.card;
    if (!card) return;
    const cap = this.populationCap;
    if (this.enemies.length >= cap) return;
    // Swarms: twice the bodies at half the price and half the health (the
    // health half is `Artifacts.monsterScale`). Every bound on a pack — the
    // per-card ceiling, the unit price, the pack roll — has to double together,
    // or whichever one binds first quietly eats the other two.
    const swarm = ctx.artifacts?.has('swarms') ? 2 : 1;
    // Per-card ceiling. Without it the cheapest card wins every spend until the
    // population cap is full of it, and the other fifteen cards never appear no
    // matter what the roll says.
    const roomFor = (c) => (c.maxAlive || 99) * swarm - this.countAlive(c);
    let room = roomFor(card);
    if (room <= 0) { this.card = card = this.rollCard(ctx); room = roomFor(card); }

    // Saving toward a card the bank cannot cover yet. Rather than spending
    // nothing, put HALF the bank into the cheapest thing available and keep
    // saving with the rest: the arena stays populated on the way up to the
    // heavy, and the heavy still arrives.
    let budget = this.credits;
    if (card.cost > this.credits || room <= 0) {
      // Only some of the intervals spent saving buy filler at all — otherwise
      // the filler tap runs continuously and out-produces the card the director
      // is actually saving for.
      if (ctx.rng.next() > 0.45) return;
      const filler = this.fillerCard(ctx, this.credits * 0.5);
      if (!filler) return;
      card = filler;
      room = roomFor(card);
      if (room <= 0) return;
      budget = this.credits * 0.5;
    }

    // Elites cost 4-7x, so they arrive as small, expensive groups. If the bank
    // can't cover one, quietly downgrade to a normal pack rather than stalling.
    // The affix pool widens with the run: tier-2 affixes simply do not exist
    // until the difficulty coefficient says the run has earned them.
    // Honour forces the affix rather than rolling for it, and asks what an
    // affix is allowed to cost while it does — at the normal 4.5-7.2x an
    // elite-only run buys about one monster a minute.
    const forceElite = !!ctx.artifacts?.has('honour') && card.eliteEligible;
    let eliteAffix = (forceElite || ctx.rng.next() < this.eliteChance) && card.eliteEligible
      ? ctx.rng.pick(eliteAffixesFor(this.difficultyCoefficient))
      : null;
    const eliteCost = eliteAffix
      ? ELITE_STATS[eliteAffix].cost * (ctx.artifacts?.eliteCostMult?.() ?? 1) : 1;
    let unit = card.cost * eliteCost / swarm;
    if (budget < unit) {
      // Under Honour there is no plain pack to downgrade to — the bank saves
      // for another interval instead, which is the same thing it does for any
      // card it cannot yet afford.
      if (!eliteAffix || forceElite) return;
      eliteAffix = null;
      unit = card.cost / swarm;
      if (budget < unit) return;
    }

    // Partial packs are deliberate. Holding the bank until a whole pack was
    // affordable meant 18-36 credits at 0.77/s — half a minute of nothing, then
    // six scarabs at once behind the player. Buying whatever the bank covers on
    // a short interval gives a thin, continuous trickle in the opening minute,
    // and once the credit rate outgrows the card the same code buys whole packs
    // on its own, so the escalation shape is unchanged.
    const affordable = Math.floor(budget / unit);
    const want = Math.min(affordable, room, swarm * (eliteAffix
      ? ctx.rng.int(1, Math.max(1, Math.ceil(card.packMax * 0.5)))
      : ctx.rng.int(card.packMin, card.packMax)));
    const anchor = this.findSpawnPoint(ctx);
    if (!anchor) return;

    let placed = 0;
    for (let i = 0; i < want; i++) {
      if (this.credits < unit || this.enemies.length >= cap) break;
      this.credits -= unit;
      // Fan the group out around the anchor so they don't stack on spawn.
      const ang = ctx.rng.range(0, Math.PI * 2);
      const rad = ctx.rng.range(0, 1.4 + card.radius * want * 0.6);
      this._scratch.set(anchor.x + Math.cos(ang) * rad, anchor.y, anchor.z + Math.sin(ang) * rad);
      this.spawnOne(ctx, card, this._scratch, eliteAffix);
      placed++;
    }
    return placed;
  }

  /**
   * Buy one Voidtouched unit at a blight seed. Every roll here comes from
   * `_voidRng` — the per-(run seed, stage) derived stream — because this path
   * only exists when corruption does, and a single draw on ctx.rng would shift
   * every later shared roll relative to a corruption-free run of the same
   * seed, which is exactly what the sp-equivalence gate forbids.
   */
  spendVoidCredits(ctx) {
    if (!this._voidSeeds.length || this.enemies.length >= this.populationCap) return;
    const stats = ELITE_STATS[VOIDTOUCHED.affix];
    // Ground-walking, elite-eligible, tier-unlocked, under its own cap: the
    // void corrupts the stage's fauna, it does not import new species.
    const d = this.difficultyCoefficient;
    const pool = [];
    for (const c of SPAWN_CARDS) {
      if (!c.eliteEligible || c.isFlyer) continue;
      if (d < (TIER_UNLOCK[c.tier] ?? Infinity)) continue;
      if (this.countAlive(c) >= (c.maxAlive || 99)) continue;
      pool.push(c);
    }
    if (!pool.length) return;
    const card = this._voidRng.weighted(pool, (c) => (c.selectionWeight ?? 1));
    const unit = card.cost * stats.cost;
    if (this.voidCredits < unit) return;
    const seed = this._voidRng.pick(this._voidSeeds);
    const at = this.findVoidPoint(ctx, seed);
    if (!at) return;
    this.voidCredits -= unit;
    // Read, not copied. The warning on the ground and the drop it heralds are
    // one colour by construction, so a palette change moves both at once —
    // which a literal here would not do. It shipped as one, and #140's re-cut
    // of the tier table left the ground painting last season's magenta.
    this.spawnTelegraph(at.x, at.z, 2.2, VOIDTOUCHED.telegraph, TIERS.blight.colour);
    this._voidPending.push({ t: VOIDTOUCHED.telegraph, x: at.x, y: at.y, z: at.z, card });
  }

  /** A surfacing point on the ring around a seed, clear of every player. */
  findVoidPoint(ctx, seed) {
    const min2 = VOIDTOUCHED.minPlayerDist * VOIDTOUCHED.minPlayerDist;
    for (let i = 0; i < 8; i++) {
      const a = this._voidRng.range(0, Math.PI * 2);
      const r = this._voidRng.range(VOIDTOUCHED.spawnRing.min, VOIDTOUCHED.spawnRing.max);
      const x = seed.x + Math.cos(a) * r;
      const z = seed.z + Math.sin(a) * r;
      let tooClose = false;
      const check = (p) => {
        const dx = p.position.x - x, dz = p.position.z - z;
        if (dx * dx + dz * dz < min2) tooClose = true;
      };
      if (ctx.roster) ctx.roster.forEachTargetable(check);
      else if (ctx.player) check(ctx.player);
      if (tooClose) continue;
      const y = ctx.stage?.sampleHeight?.(x, z);
      return { x, y: Number.isFinite(y) ? y : 0, z };
    }
    return null;
  }

  spawnOne(ctx, def, at, affix) {
    let list = this.pool.get(def.id);
    if (!list) { list = []; this.pool.set(def.id, list); }
    const e = list.length ? list.pop() : new Enemy();
    // Difficulty and the stat-side artifacts (Swarms, Honour, Evolution) fold
    // into the multipliers the Director already passes, so a monster's stats
    // are still decided in exactly one place. Baked in at spawn: an Evolution
    // monster is as strong as your inventory was when it arrived.
    const mod = ctx.artifacts?.monsterScale?.();
    e.spawn(ctx, def, at, {
      affix: def.eliteEligible ? affix : null,
      level: this.level,
      healthMult: this.healthMult * (mod?.health ?? 1),
      damageMult: this.damageMult * (mod?.damage ?? 1),
    });
    this.enemies.push(e);
    return e;
  }

  /**
   * Spawn one add on behalf of a monster (brood sacs, the matron's clutch).
   *
   * Summons are free — the summoner already paid for itself — but they are
   * still counted against the population cap, so an un-answered brood sac
   * crowds the field with mites instead of adding an unbounded second horde on
   * top of the director's own budget. Returns false once the cap is reached,
   * which is the caller's signal to stop hatching.
   */
  summon(ctx, id, at, source) {
    if (!ctx.authority) return false;
    const def = ENEMY_BY_ID.get(id);
    if (!def || this.enemies.length >= this.populationCap) return false;
    const e = this.spawnOne(ctx, def, at, null);
    // Summons inherit their parent's affix nothing and their parent's level
    // everything: a mite hatched at minute 25 has to be a minute-25 mite.
    if (source) e.home.copy(source.position);
    return true;
  }

  /** Ground ring that marks where something is about to land. */
  spawnTelegraph(x, z, radius, life, color) {
    this.telegraphs.spawn(x, z, radius, life, color);
  }

  /**
   * A walkable point at least MIN_SPAWN_DIST from *every* player, no more than
   * MAX_SPAWN_DIST from the anchor, and outside the camera frustum. Falls back
   * to the furthest candidate rather than failing — a spawn behind a rock in
   * view beats no pressure at all.
   *
   * The off-screen rule is what stops monsters materialising in front of you,
   * but applied strictly it also means every monster is always behind you, and
   * a pack that only ever arrives from your blind side reads as an ambush. So a
   * candidate far enough away is allowed on screen some of the time: watching a
   * scarab crest a ridge 55m out is a telegraph, not a pop-in.
   */
  findSpawnPoint(ctx) {
    const cam = ctx.camera;
    if (cam) {
      cam.updateMatrixWorld();
      _m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(_m4);
    }
    // One anchor, not one per player: `randomWalkablePoint` takes a single
    // `minDistFrom`, and re-rolling the sample per player would change how many
    // draws the shared RNG makes per iteration — which single-player
    // equivalence is measured against. Only the acceptance test below is
    // roster-aware.
    //
    // The anchor prefers a *living* player. `roster.local` is `ctx.player`
    // regardless of liveness by design (`Roster.js`, `get local`), so anchoring
    // on it alone put the two distance tests below on different subjects the
    // moment a co-op host died: `MAX_SPAWN_DIST` and the sampling distribution
    // measured from the corpse, while the `MIN_SPAWN_DIST` floor measured from
    // the nearest living player. The pack then kept spawning in the 34-90 m
    // annulus around a body and 100+ m from the one survivor, who spent the
    // rest of the stage watching monsters walk towards them. That only became
    // reachable when dead players stopped being targetable — before that,
    // enemies chased the corpse anyway, so where they spawned did not matter.
    //
    // Single-player is unchanged, and structurally rather than empirically:
    // with one living player `nearest` returns that player (distance 0), and
    // with a dead solo player nothing is targetable so `nearest` returns null
    // and this falls through to `ctx.player` exactly as before. `nearest` draws
    // no RNG, so the per-iteration draw count the equivalence harness measures
    // is untouched.
    const local = ctx.roster?.local ?? ctx.player;
    const anchor = (local ? ctx.roster?.nearest?.(local.position) : null) ?? local;
    const player = anchor ? anchor.position : _v.set(0, 0, 0);
    let fallback = null;
    let fallbackD = -1;

    for (let i = 0; i < 16; i++) {
      const p = this.samplePoint(ctx, player);
      if (!p) continue;
      // Distance from the anchor decides how far out this spawn reads; distance
      // from the *nearest* player decides whether it is legal. A guest who has
      // wandered away from the host must not have monsters materialise on top
      // of them just because they are far from whoever the anchor is.
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      const dNearest = ctx.roster ? Math.min(d, ctx.roster.distanceToNearest(p)) : d;
      if (dNearest < MIN_SPAWN_DIST || d > MAX_SPAWN_DIST) continue;
      this._sphere.center.set(p.x, p.y + 2, p.z);
      const visible = cam ? this._frustum.intersectsSphere(this._sphere) : false;
      if (!visible) return this._point.copy(p);
      if (d >= FAR_SPAWN_DIST && ctx.rng.next() < EDGE_SPAWN_CHANCE) return this._point.copy(p);
      if (d > fallbackD) { fallbackD = d; fallback = this._point.copy(p); }
    }
    return fallback;
  }

  samplePoint(ctx, player) {
    const stage = ctx.stage;
    if (stage && stage.randomWalkablePoint) {
      const p = stage.randomWalkablePoint(ctx.rng, { minDistFrom: player, minDist: MIN_SPAWN_DIST });
      if (p) return p;
    }
    // No stage yet — ring around the player, clamped to terrain.
    const ang = ctx.rng.range(0, Math.PI * 2);
    const rad = ctx.rng.range(MIN_SPAWN_DIST + 4, 55);
    _v2.set(player.x + Math.cos(ang) * rad, 0, player.z + Math.sin(ang) * rad);
    _v2.y = stage && stage.sampleHeight ? stage.sampleHeight(_v2.x, _v2.z) : 0;
    return _v2;
  }

  // -------------------------------------------------------------------------
  // teleporter event
  // -------------------------------------------------------------------------

  /**
   * Place the teleporter boss. Progression calls this the moment the ring
   * starts charging, so the boss is the event and the charge is only its timer.
   *
   * `difficulty` is Progression's own curve; the director already tracks the
   * same escalation in `difficultyCoefficient`, which is what the elite roll
   * and the level scaling read, so it is accepted for the call signature and
   * not re-derived from here.
   */
  /**
   * Which boss this event gets.
   *
   * Drawn from a shuffled bag rather than indexed by stage: with six cards, a
   * straight `stageIndex % length` means every run meets them in the same order
   * and a five-stage run never sees the last one at all. The bag guarantees no
   * repeat until every boss has been used, which is the property that actually
   * matters — meeting the same boss twice in a row reads as a bug.
   */
  pickBossCard(ctx) {
    if (!this._bossBag.length) {
      this._bossBag = BOSS_CARDS.slice();
      for (let i = this._bossBag.length - 1; i > 0; i--) {
        const j = ctx.rng.int(0, i);
        const t = this._bossBag[i]; this._bossBag[i] = this._bossBag[j]; this._bossBag[j] = t;
      }
    }
    return this._bossBag.pop();
  }

  spawnBoss(stageIndex = 0, difficulty = this.difficultyCoefficient, position = null) {
    const ctx = this.ctx;
    if (!ctx || !ctx.authority || this.boss) return null;
    const card = this.pickBossCard(ctx);
    if (!card) return null;

    // Ring the teleporter rather than landing on it: the boss has to be walked
    // to, and spawning inside the charge radius drops it on the player's head.
    const at = this._scratch.copy(position || ctx.player?.position || _v.set(0, 0, 0));
    const ang = ctx.rng.range(0, Math.PI * 2);
    at.x += Math.cos(ang) * BOSS_SPAWN_DIST;
    at.z += Math.sin(ang) * BOSS_SPAWN_DIST;
    const ground = ctx.stage?.sampleHeight?.(at.x, at.z);
    if (typeof ground === 'number' && isFinite(ground)) at.y = ground;

    const affix = ctx.rng.next() < clamp(this.eliteChance * 1.5, 0, 0.6)
      ? ctx.rng.pick(eliteAffixesFor(this.difficultyCoefficient)) : null;
    const boss = this.spawnOne(ctx, card, at, affix);
    boss.isBoss = true;
    this.boss = boss;
    ctx.pipeline?.addShake?.(0.5);
    // `bossDead` is emitted by the reaper in fixedUpdate when this corpse is
    // recycled, so both ends of the fight are on the bus.
    ctx.events.emit('bossSpawn', { enemy: boss });
    return boss;
  }

  beginTeleporterEvent(ctx) {
    this.eventActive = true;
    this.rerollT = 0;
    this.spawnT = 0.5;
    // The event pays for itself: an instant bank so pressure lands immediately.
    this.credits += 40 * this.difficultyCoefficient;

    if (this.boss) return;
    const card = this.pickBossCard(ctx);
    if (!card) return;
    // The fallback is 18 m from the local player — inside MIN_SPAWN_DIST and
    // roster-blind, so in co-op it can drop the boss on a guest. Pre-existing,
    // and left alone here because moving a boss is a balance change rather than
    // a targeting fix; noted because the roster-aware acceptance test in
    // `findSpawnPoint` makes the null return that reaches this line more
    // likely with players spread across the arena.
    const at = this.findSpawnPoint(ctx) || this._scratch.set(
      (ctx.player?.position.x || 0) + 18, 0, (ctx.player?.position.z || 0) + 18);
    const affix = ctx.rng.next() < clamp(this.eliteChance * 1.5, 0, 0.6)
      ? ctx.rng.pick(eliteAffixesFor(this.difficultyCoefficient)) : null;
    const boss = this.spawnOne(ctx, card, at, affix);
    boss.isBoss = true;
    this.boss = boss;
    ctx.pipeline?.addShake?.(0.5);
    ctx.events.emit('bossSpawn', { enemy: boss });
  }

  endTeleporterEvent(ctx) {
    this.eventActive = false;
    this.spawnT = Math.max(this.spawnT, 3);
  }

  // -------------------------------------------------------------------------
  // effect entry points used by Enemy
  // -------------------------------------------------------------------------

  spawnWave(position, radius, speed, damage, source, color) {
    this.waves.spawn(position, radius, speed, damage, source, color);
  }

  spawnBeamTrail(origin, dir, length, color) {
    this.trails.spawn(origin, dir, length, color);
  }

  /**
   * Despawn everything the director owns and put it back in the pools.
   *
   * The enemies go back into `this.pool` keyed by card id rather than being
   * dropped: `despawn()` releases the rig to the mesh pool but the Enemy object
   * itself is the expensive thing to rebuild, and a run that cleared five
   * stages by dropping them would have allocated five stages' worth. Note the
   * id must be read *before* despawn(), which nulls `def`.
   */
  clear(ctx) {
    for (const e of this.enemies) {
      const id = e.def ? e.def.id : null;
      e.despawn(ctx);
      if (!id) continue;
      const p = this.pool.get(id);
      if (p) p.push(e); else this.pool.set(id, [e]);
    }
    this.enemies.length = 0;
    this.projectiles.clear();
    this.waves.clear();
    this.trails.clear();
    this.telegraphs.clear();
    // Nothing withering is alive any more, so every player's heal lock goes
    // with them. Cleared through `all` rather than `forEachTargetable` because
    // a dead or downed player must not carry a stale ceiling into the next
    // stage, where the revive that puts them back up would be capped by it.
    if (ctx?.roster) for (const p of ctx.roster.all) { p._healDenyUntil = -1; p._healCap = null; }
    this.boss = null;
  }

  /**
   * Stage transition. Progression calls this once the new world exists but
   * before it is populated, so nothing from the previous stage is left standing
   * on terrain that no longer matches it — a sentinel left alive across a rebuild
   * would be pathing over a heightfield that had been replaced underneath it.
   *
   * Everything that carries stage-local state is reset: the live enemies, the
   * projectile / shockwave / beam-trail lists, the credit bank and its timers,
   * the teleporter event flag and the boss handle.
   */
  reset(stageIndex = this.stagesCompleted) {
    const ctx = this.ctx;
    if (ctx) this.clear(ctx);

    this.stagesCompleted = stageIndex;
    this.credits = CREDIT_SEED;
    this.creditRate = 0;
    this.card = SPAWN_CARDS[0];
    this.rerollT = 0;
    this.spawnT = 2.0;
    this.eventActive = false;
    this.boss = null;
    // A new stage means the run is still going; only `playerDead` turns the
    // director off for good.
    this.enabled = true;
    // The void's per-stage slate, same as the `stageStart` handler: the seeds
    // referred to ground that no longer exists, and the stream re-derives from
    // (run seed, stage) so the new stage is deterministic without ctx.rng.
    this._voidSeeds.length = 0;
    this._voidPending.length = 0;
    this.voidCredits = 0;
    this.voidSpawnT = 0;
    if (ctx) this._voidRng = new RNG(((ctx.seed >>> 0) ^ (0x7f4a7c15 * (stageIndex + 1))) >>> 0 || 1);
    if (ctx) this.updateDifficulty(ctx);
  }

  /** HUD helper: 0..1 across the current difficulty band. */
  get difficultyProgress() {
    const i = this.difficultyIndex;
    const lo = DIFFICULTY_NAMES[i][0];
    const hi = i + 1 < DIFFICULTY_NAMES.length ? DIFFICULTY_NAMES[i + 1][0] : lo + 4;
    return clamp((this.difficultyCoefficient - lo) / (hi - lo), 0, 1);
  }
}

// ---------------------------------------------------------------------------
// enemy projectiles
// ---------------------------------------------------------------------------

export class Projectiles {
  constructor() {
    this.list = [];
    this.pool = [];
    this.meshPool = new Map();
  }

  init(ctx) { this.ctx = ctx; }

  take(color) {
    let mp = this.meshPool.get(color);
    if (!mp) { mp = []; this.meshPool.set(color, mp); }
    return mp.length ? mp.pop() : makeProjectile(color);
  }

  give(color, mesh) {
    const mp = this.meshPool.get(color);
    if (mp) mp.push(mesh); else this.meshPool.set(color, [mesh]);
  }

  fire(owner, def, position, velocity) {
    const p = this.pool.length ? this.pool.pop() : {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), mesh: null,
      def: null, owner: null, life: 0, color: 0, spin: 0,
    };
    p.pos.copy(position);
    p.vel.copy(velocity);
    p.def = def;
    p.owner = owner;
    p.life = def.life || 4;
    p.color = def.color || 0xff7a1e;
    p.spin = 0;
    p.mesh = this.take(p.color);
    p.mesh.position.copy(p.pos);
    p.mesh.scale.setScalar(def.radius ? def.radius / 0.3 : 1);
    this.ctx.scene.add(p.mesh);
    this.list.push(p);
    return p;
  }

  fixedUpdate(ctx, h) {
    const player = ctx.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const d = p.def;
      p.life -= h;

      if (d.homing && player) {
        // Gentle homing — dodgeable, but it punishes standing still.
        _v.subVectors(player.position, p.pos);
        _v.y += 1.0;
        const len = _v.length();
        if (len > 0.01) {
          _v.multiplyScalar(1 / len);
          const s = p.vel.length();
          p.vel.x = lerp(p.vel.x, _v.x * s, clamp(d.homing * h, 0, 1));
          p.vel.y = lerp(p.vel.y, _v.y * s, clamp(d.homing * h, 0, 1));
          p.vel.z = lerp(p.vel.z, _v.z * s, clamp(d.homing * h, 0, 1));
        }
      }
      if (d.gravity) p.vel.y -= d.gravity * h;
      p.pos.addScaledVector(p.vel, h);

      let hit = false;
      if (player && player.position) {
        const r = (d.radius || 0.3) + (player.radius || 0.45);
        const dx = p.pos.x - player.position.x;
        const dy = p.pos.y - (player.position.y + 0.9);
        const dz = p.pos.z - player.position.z;
        if (dx * dx + dy * dy + dz * dz < r * r) hit = true;
      }
      const ground = ctx.stage && ctx.stage.sampleHeight ? ctx.stage.sampleHeight(p.pos.x, p.pos.z) : 0;
      if (!hit && p.pos.y <= ground + 0.1) hit = true;

      if (hit || p.life <= 0) {
        if (hit) this.detonate(ctx, p);
        this.recycle(i);
      }
    }
  }

  detonate(ctx, p) {
    const d = p.def;
    const owner = p.owner;
    const dmg = owner ? owner.damage * d.damage : d.damage * 10;
    const player = ctx.player;
    if (player) {
      const reach = (d.blast || 0) + (player.radius || 0.45) + (d.radius || 0.3);
      const dx = p.pos.x - player.position.x;
      const dz = p.pos.z - player.position.z;
      const dy = p.pos.y - (player.position.y + 0.9);
      if (dx * dx + dy * dy + dz * dz < reach * reach && owner) {
        // Asked before the hit: afterwards the mercy window has been re-armed
        // by this very shell and the answer is always no.
        const rides = ctx.combat?.wouldHit?.(player) !== false;
        damagePlayer(ctx, player, dmg, owner, p.pos, 'projectile');
        // Riders travel with the shell, not with the shooter — bile slows, a
        // pyre burns, and the player learns which shell is which by colour.
        // They ride the *hit*, though: a shell the i-frames refused leaves no
        // slow behind, or a wall of fire chains into a stun-lock (#135).
        if (d.status && rides) ctx.combat?.applyStatus?.(player, d.status, owner, 1);
        ctx.pipeline?.addShake?.(0.05);
      }
    }
    if (d.blast) ctx.director?.spawnWave(p.pos, d.blast, 40, 0, null, p.color);
    if (ctx.vfx && ctx.vfx.explosion) ctx.vfx.explosion(p.pos, d.blast || 0.6, p.color);
  }

  recycle(i) {
    const p = this.list[i];
    this.ctx.scene.remove(p.mesh);
    this.give(p.color, p.mesh);
    p.mesh = null;
    p.owner = null;
    p.def = null;
    this.list.splice(i, 1);
    this.pool.push(p);
  }

  update(ctx, dt) {
    for (const p of this.list) {
      p.spin += dt;
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.y = p.spin * 3.2;
      p.mesh.rotation.x = p.spin * 2.1;
      const husk = p.mesh.userData.husk;
      husk.rotation.y = -p.spin * 5;
      husk.scale.setScalar(1 + Math.sin(p.spin * 22) * 0.12);
    }
  }

  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this.recycle(i);
  }
}

// ---------------------------------------------------------------------------
// expanding shockwave rings (slams, stomps, elite death novas, blasts)
// ---------------------------------------------------------------------------

class Waves {
  constructor() { this.list = []; this.pool = []; this.meshPool = new Map(); }
  init(ctx) { this.ctx = ctx; }

  spawn(position, maxRadius, speed, damage, source, color) {
    const w = this.pool.length ? this.pool.pop() : { pos: new THREE.Vector3(), r: 0, max: 0, speed: 0, damage: 0, source: null, mesh: null, color: 0, hit: false };
    w.pos.copy(position);
    w.r = 0.6;
    w.max = maxRadius;
    w.speed = speed;
    w.damage = damage;
    w.source = source;
    w.hit = false;
    w.color = color || 0xffa514;
    let mp = this.meshPool.get(w.color);
    if (!mp) { mp = []; this.meshPool.set(w.color, mp); }
    w.mesh = mp.length ? mp.pop() : makeShockwave(w.color);
    w.mesh.position.set(position.x, position.y + 0.15, position.z);
    w.mesh.scale.setScalar(w.r);
    w.mesh.material.opacity = 0.9;
    this.ctx.scene.add(w.mesh);
    this.list.push(w);
    return w;
  }

  fixedUpdate(ctx, h) {
    const player = ctx.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i];
      const prev = w.r;
      w.r += w.speed * h;
      // Damage lands exactly when the visible ring crosses you.
      if (w.damage > 0 && !w.hit && player) {
        const d = Math.hypot(player.position.x - w.pos.x, player.position.z - w.pos.z);
        const pr = player.radius || 0.45;
        if (d >= prev - pr && d <= w.r + pr && Math.abs(player.position.y - w.pos.y) < 4) {
          w.hit = true;
          damagePlayer(ctx, player, w.damage, w.source, w.pos, 'shockwave');
        }
      }
      if (w.r >= w.max) this.recycle(i);
    }
  }

  update(ctx, dt) {
    for (const w of this.list) {
      w.mesh.scale.set(w.r, w.r, 1);
      w.mesh.material.opacity = clamp(0.9 * (1 - w.r / w.max), 0, 0.9);
    }
  }

  recycle(i) {
    const w = this.list[i];
    this.ctx.scene.remove(w.mesh);
    const mp = this.meshPool.get(w.color);
    if (mp) mp.push(w.mesh);
    w.mesh = null;
    w.source = null;
    this.list.splice(i, 1);
    this.pool.push(w);
  }

  clear() { for (let i = this.list.length - 1; i >= 0; i--) this.recycle(i); }
}

// ---------------------------------------------------------------------------
// ground telegraphs — "this circle is about to be a hole"
// ---------------------------------------------------------------------------
//
// Every attack that cannot be dodged by aim (mortar shells, novas, the
// burrower's surfacing point) puts one of these down for exactly as long as the
// player has to leave it. They are drawn on the ground rather than in the air
// deliberately: the decision the ring is asking for is "where do I stand", and
// that decision is made by looking at the floor.
//
// Pooled by colour the same way waves are, so a bombard walking six shells
// across the arena allocates nothing.

class Telegraphs {
  constructor() { this.list = []; this.pool = []; this.meshPool = new Map(); }
  init(ctx) { this.ctx = ctx; }

  spawn(x, z, radius, life, color) {
    if (radius <= 0 || life <= 0) return;
    const ctx = this.ctx;
    const t = this.pool.length ? this.pool.pop()
      : { x: 0, z: 0, r: 0, life: 0, max: 0, mesh: null, color: 0 };
    t.x = x; t.z = z; t.r = radius;
    t.life = life; t.max = life;
    t.color = color || 0xffa514;
    let mp = this.meshPool.get(t.color);
    if (!mp) { mp = []; this.meshPool.set(t.color, mp); }
    t.mesh = mp.length ? mp.pop() : makeTelegraph(t.color);
    const y = ctx.stage?.sampleHeight?.(x, z);
    t.mesh.position.set(x, (Number.isFinite(y) ? y : 0) + 0.08, z);
    t.mesh.scale.setScalar(radius);
    t.mesh.material.opacity = 0.85;
    ctx.scene.add(t.mesh);
    this.list.push(t);
  }

  update(ctx, dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.life -= dt;
      if (t.life <= 0) { this.recycle(i); continue; }
      // Fills in as the deadline approaches and pulses harder in the last
      // third — the urgency has to be visible without reading a number.
      const k = 1 - clamp(t.life / t.max, 0, 1);
      const flash = k > 0.66 ? 0.5 + 0.5 * Math.sin(t.life * 42) : 0;
      t.mesh.scale.setScalar(t.r * (0.55 + 0.45 * k));
      // Ceiling well under 1: these are additive and they go through bloom, and
      // a full-alpha ring at boss scale is a white bar, not a warning.
      t.mesh.material.opacity = clamp(0.2 + k * 0.3 + flash * 0.16, 0, 0.62);
    }
  }

  recycle(i) {
    const t = this.list[i];
    this.ctx.scene.remove(t.mesh);
    const mp = this.meshPool.get(t.color);
    if (mp) mp.push(t.mesh); else this.meshPool.set(t.color, [t.mesh]);
    t.mesh = null;
    this.list.splice(i, 1);
    this.pool.push(t);
  }

  clear() { for (let i = this.list.length - 1; i >= 0; i--) this.recycle(i); }
}

// ---------------------------------------------------------------------------
// fading beam trails left by sentinel / colossus lasers
// ---------------------------------------------------------------------------

class Trails {
  constructor() { this.list = []; this.pool = []; this.meshes = []; }
  init(ctx) { this.ctx = ctx; }

  spawn(origin, dir, length, color) {
    if (length < 0.5) return;
    let mesh;
    if (this.meshes.length) {
      mesh = this.meshes.pop();
      mesh.material.color.setHex(color || 0x22d3ff);
    } else {
      const geo = new THREE.CylinderGeometry(0.14, 0.14, 1, 6);
      const mat = new THREE.MeshBasicMaterial({
        color: color || 0x22d3ff, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
    }
    _q.setFromUnitVectors(_up, _v.copy(dir).normalize());
    mesh.quaternion.copy(_q);
    mesh.position.copy(origin).addScaledVector(_v, length * 0.5);
    mesh.scale.set(1, length, 1);
    mesh.material.opacity = 0.85;
    this.ctx.scene.add(mesh);
    const t = this.pool.length ? this.pool.pop() : { mesh: null, life: 0 };
    t.mesh = mesh;
    t.life = 0.16;
    this.list.push(t);
  }

  update(ctx, dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.life -= dt;
      const k = clamp(t.life / 0.16, 0, 1);
      t.mesh.material.opacity = 0.85 * k;
      t.mesh.scale.x = t.mesh.scale.z = 0.4 + k * 0.6;
      if (t.life <= 0) this.recycle(i);
    }
  }

  recycle(i) {
    const t = this.list[i];
    this.ctx.scene.remove(t.mesh);
    this.meshes.push(t.mesh);
    t.mesh = null;
    this.list.splice(i, 1);
    this.pool.push(t);
  }

  /** Pool every live trail. Meshes are reused, never dropped. */
  clear() { for (let i = this.list.length - 1; i >= 0; i--) this.recycle(i); }
}
