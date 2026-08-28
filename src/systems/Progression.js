import * as THREE from 'three';
import { Interactables } from '../world/Interactables.js';
import { ITEMS_BY_TIER } from '../data/items.js';
import { BIOMES, stageNameFor } from '../world/Materials.js';
import { Profile } from './Profile.js';
import { isLocalVictim, isLocalKill, isLocalOwner } from '../core/Engine.js';
import { VOIDTOUCHED, isVoidtouched } from '../data/corruption.js';
import { muteInput } from '../core/InputMute.js';
import { ENDINGS_BY_ID } from '../data/realms.js';

/**
 * Progression drives the run: which stage we're on, how hard the game is
 * allowed to be, the teleporter event, and the numbers the death screen reads.
 *
 * It owns Interactables rather than main.js registering them, because the
 * interactables' lifetime is exactly one stage and this is the system that
 * knows when a stage ends.
 *
 * For the same reason it owns `Profile`: the profile's only lifecycle is "a run
 * started" / "a run ended", and this is the system that knows both. The profile
 * costs no frame time (every counter is an event handler, every write is on a
 * debounce timer), so giving it a slot in the engine's update loop would
 * advertise a cost it does not have.
 */

// How many stages you can play before a name repeats: four biomes, each with
// three named variants. The names themselves live with the biomes in
// Materials.js so a stage's name and its look can never drift apart.
const NAME_CYCLE = BIOMES.length * BIOMES[0].names.length;

/** The displayed stage name, loop suffix included. */
function fullStageName(index) {
  return stageNameFor(index) + (index >= NAME_CYCLE ? ` (Loop ${Math.floor(index / NAME_CYCLE) + 1})` : '');
}

const CHARGE_TIME = 45;      // the boss fight's timer: the boss spawns on charge start
const LOOT_WINDOW = 8;       // beat between "boss dead" and the portal opening
const CHARGE_EMIT_STEP = 0.01;

// The stage transition (#182).
//
// Taking a portal used to run the entire rebuild — heightfield, props,
// colliders, biome dressing and a six-face reflection bake — inside one call,
// which is one frame, which on a real GPU is several seconds of a game that has
// stopped answering. `Stage.buildSteps` cuts that into steps; these are the
// beats the driver below spends them over.
//
// Out is short and in is longer on purpose. Going to black wants to feel like a
// consequence of the thing you just did, so it is nearly a cut; coming back
// wants to feel like arriving somewhere, so it takes its time. The build sits
// between them at full black and runs as fast as it can, so the transition is
// as long as the machine needs and never shorter than these two.
/** This system's name on the input mute. See `src/core/InputMute.js`. */
const INPUT_MUTE = 'stageTransition';

const VEIL_OUT = 0.30;
const VEIL_IN = 0.55;

/**
 * Survivor level.
 *
 * The run levels the whole team, RoR2-style: one shared level, earned from
 * every kill, driving the player stat curve in `Player._levelBase`. It lives
 * here rather than on Player because it is run state, not entity state — a
 * co-op host has several Player instances and they must all read one number,
 * or the host's simulation of a remote pawn and that client's own prediction
 * of it would use different stats.
 *
 * Cost curve: `5 * level^1.35`. Level 20 lands a little past 2500 total XP,
 * which is roughly a 20-minute run at the tuned spawn rate.
 */
const XP_BASE = 5;
const XP_EXP = 1.35;
export function xpForLevel(level) {
  return Math.max(1, Math.round(XP_BASE * Math.pow(Math.max(1, level), XP_EXP)));
}
// Same shape the Director uses for monster levels, so a level of parity means
// parity. See Director.js:10-11.
const XP_PER_MONSTER_LEVEL = 0.2;

export class Progression {
  // Stage flow, the teleporter event, and the numbers the run record is written
  // from. A throw here can end a run that should have continued, or the reverse.
  static critical = true;

  constructor() {
    this.stageIndex = 0;
    this.stageName = stageNameFor(0);
    this.difficulty = 1;
    this.state = 'idle'; // idle | charging | complete | portal

    this.charge = 0;
    this._lastEmitted = -1;
    this.bossAlive = false;
    this.bossCleared = false;
    this.lootTimer = 0;

    // Survivor level — read by the HUD through `ctx.player.level` and by
    // `Player._levelBase` for the stat curve. Run-scoped, so a stage change
    // deliberately leaves it alone.
    this.level = 1;
    this.xp = 0;
    this.xpToNext = xpForLevel(1);

    // Where this stage's teleporter is, or null before one exists. This is the
    // one field the objective HUD and VFX.teleporterAura both drive off, so it
    // has to be published the moment the stage is populated.
    this.teleporterPosition = null;

    this.interactables = new Interactables();
    // Meta-progression. Per-client and local in co-op — never synced, and
    // deliberately not gated on `ctx.authority`, or only the host would ever
    // earn an unlock. See Profile.js for the witness rules that replace it.
    this.profile = new Profile();
    this.stats = {
      time: 0, kills: 0, elites: 0, bosses: 0,
      damageDealt: 0, damageTaken: 0, highestHit: 0,
      items: 0, goldEarned: 0, stagesCleared: 0,
    };

    // The Fallow Vault's stake, waiting to mature. Run state rather than stage
    // state on purpose: the whole shrine is a bet that you will reach the next
    // stage, so the one thing it must not do is live on the stage it was made
    // on. Null when nothing is committed.
    this.vault = null;

    // The worst the world ever got this run, not the band it ended in. Run
    // scoped like `level` above (every restart path is a reload), and it exists
    // because the Vigil is awarded for restraint: a band read at the ending can
    // be bought at the last font, a high-water mark cannot. Maintained by the
    // `corruptionBand` listener in `init`.
    this.corruptionPeakBand = 0;

    // Set by `finishRun` when the run ends on purpose rather than on a corpse.
    this.ending = null;

    this._started = false;
    this._tmp = new THREE.Vector3();

    /**
     * The stage change in flight, or null. `{ index, host, phase, t, steps }`.
     * Public because it is the one honest answer to "is the world currently
     * being replaced" — `_tickTeleporter` reads it, and so should anything else
     * that must not act during the swap.
     */
    this.transition = null;
    /** Last published veil opacity, so `stageVeil` only fires on a change. */
    this._veil = 0;

    /**
     * Whether a stage change is spread over frames. Left undefined so the
     * answer is derived (below) from whether there is a renderer with a frame
     * to protect; set it explicitly to drive the incremental path from a
     * headless test, or to force the old all-at-once build.
     */
    this.stretchTransitions = undefined;
  }

  init(ctx) {
    this.ctx = ctx;
    this.interactables.init(ctx);
    // Before our own listeners: the profile's `playerDead` handler records the
    // outcome, and `_endRun` (registered below) is what commits it. Registering
    // in this order means the commit already sees the flag.
    this.profile.init(ctx);
    ctx.progression = this;

    // The high-water mark. `corruptionBand` fires once per real crossing, in
    // both directions, so watching it is the only way to know a world was ever
    // Consumed after a font has walked it back down to Seeded.
    ctx.events.on('corruptionBand', (e) => {
      const b = e?.band;
      if (Number.isInteger(b) && b > this.corruptionPeakBand) this.corruptionPeakBand = b;
    });

    ctx.events.on('bossSpawn', () => { this.bossAlive = true; });
    ctx.events.on('bossDead', (e) => {
      this.bossAlive = false;
      this.bossCleared = true;
      this.stats.bosses++;
      this._dropBossItem(e?.enemy?.position || this.interactables.teleporter?.position);
    });

    ctx.events.on('kill', (e) => {
      if (e.victim?.isPlayer) return;
      // Your run's kills, not the party's. `damageDealt` below has carried this
      // rule since round 1's F-9; `kill` never did, and a client's summary read
      // four kills and zero damage for a fight the host had.
      if (!isLocalKill(ctx, e)) return;
      this.stats.kills++;
      if (e.isElite) this.stats.elites++;
      // XP is game state, so only the host awards it. Clients learn the result
      // from the `levelUp` event below, which NetHost already forwards.
      if (ctx.authority) this._awardKillXp(e);
    });

    // Client side of the same fact. The wire strips object references, so this
    // payload carries only the three numbers the HUD and the stat curve need.
    ctx.events.on('levelUp', (e) => {
      if (!ctx.authority && e) {
        this.level = e.level ?? this.level;
        this.xp = e.xp ?? 0;
        this.xpToNext = e.xpToNext ?? xpForLevel(this.level);
      }
      // Cosmetic, so both roles run it.
      if (ctx.player) ctx.vfx?.levelUp?.(ctx.player.position);
    });
    ctx.events.on('damage', (e) => {
      // Both branches carry the same guard for the same reason: `isPlayer` is
      // true of every remote pawn, so without it a teammate's hits land in this
      // run's `damageDealt` and a teammate's biggest hit becomes this run's
      // `highestHit`.
      if (e.source?.isPlayer && (!ctx.player || e.source === ctx.player)) {
        this.stats.damageDealt += e.amount;
        if (e.amount > this.stats.highestHit) this.stats.highestHit = e.amount;
      } else if (e.target?.isPlayer) {
        // `amount` is what arrived; `toHealth` is what got through. A barrier
        // exists precisely so that the hit costs nothing, and counting it as
        // damage taken is what makes the run summary disagree with the health
        // bar. Guarded on the local survivor too — a remote pawn is `isPlayer`,
        // and a teammate's blood is not this run's.
        if (!ctx.player || e.target === ctx.player) {
          this.stats.damageTaken += e.toHealth ?? e.amount;
        }
      }
    });
    // A client resolves no damage, so the `damage` event above never fires for
    // it and its run summary reported 0 damage taken for the whole run. The
    // host's per-owner `playerHurt` forward is the only record that arrives, and
    // its `amount` is already what got through a barrier - the same quantity the
    // `damage` branch books as `toHealth`.
    ctx.events.on('playerHurt', (e) => {
      if (ctx.authority) return;
      this.stats.damageTaken += e?.amount ?? 0;
    });
    // `reason: 'corrupt'` is the blight transform moving stacks the player
    // already owns between two ids — the emptied base and the arriving card are
    // one event, not two acquisitions. Counting them inflated the run summary
    // by two items every time the corruption gauge crossed a band.
    //
    // Owner-filtered, both of them. These two are the *local* survivor's run
    // summary — the one `_endRun` files when this machine's player dies — and
    // on a host the bus now carries every pawn's economy. `goldEarned` is the
    // sharper of the two: it is a delta against `_lastGold`, so two purses
    // interleaving on one channel do not merely inflate the number, they
    // produce a figure that belongs to no one.
    ctx.events.on('itemPickup', (e) => {
      if (e?.reason === 'corrupt' || !isLocalOwner(ctx, e)) return;
      // A write that did not grow the stack is not an acquisition either.
      // `take()`'s removals and `temper()`'s parent-zeroing (issue #179) both
      // land here too, each stamped with the item's new absolute — possibly
      // zero — count, and counting every one of them the same as a genuine
      // pickup inflated the run summary by 2 per temper (its two zeroing
      // writes), on top of the pre-existing 2-per-band-crossing defect the
      // `corrupt` filter above already fixed. `delta` is the signed change;
      // the fallback to `count` fires only for legacy/synthetic payloads that
      // omit `delta` entirely, the same rule `Profile`'s `itemPickup`
      // listener resolves the identical ambiguity with.
      const change = e?.delta === undefined ? (typeof e?.count === 'number' ? e.count : 1) : e.delta;
      if (!(change > 0)) return;
      this.stats.items++;
    });
    ctx.events.on('goldChanged', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      const delta = e.gold - (this._lastGold || 0);
      if (delta > 0) this.stats.goldEarned += delta;
      this._lastGold = e.gold;
    });
    // Only *your* death ends *your* run. `_endRun` commits the permanent run
    // record and is idempotent on `_ended`, so an unguarded teammate's death in
    // co-op filed the record taken at the moment your friend died and made your
    // own death, later, a no-op.
    ctx.events.on('playerDead', (p) => { if (isLocalVictim(ctx, p)) this._endRun(false); });

    // The host's resolved ending, replicated (issue #220): `victory()` and
    // `obliterate()` (Realms.js) run authority-gated and never reach a
    // guest's own `finishRun` any other way. `finishRun` is idempotent on
    // `_ended` and only the host ever emits this (see its own guard), so this
    // is a no-op there — it exists for the guest, which resolves the SAME
    // ending object the host did rather than deriving one of its own, so the
    // summary screen and the committed profile record can never disagree.
    ctx.events.on('runEnding', (e) => {
      if (ctx.authority) return;
      const ending = ENDINGS_BY_ID[e?.endingId];
      if (ending) this.finishRun(ending);
    });

    // The stage-end amnesty (`Revive._returnParty`) can hand this machine's
    // own pawn back its legs after `_endRun` already committed the run as
    // over. `_ended` is what makes `_endRun` idempotent against a second real
    // death, so it has to come back down, not just the pawn's `alive` flag —
    // otherwise a player who dies again after being returned would silently
    // never end their (new) run a second time.
    ctx.events.on('playerReturned', (e) => {
      if (!this._ended || !isLocalVictim(ctx, { victim: e.player })) return;
      this._ended = false;
      this.ending = null;
    });

    // A client never advances the run; it learns a stage happened and rebuilds
    // the same world from the host's seed. What sits *on* that world is
    // replicated rather than re-rolled, so it never populates.
    ctx.events.on('stageStart', (p) => {
      if (ctx.authority) return;
      // Cleared here rather than at the swap. A client's interactables are
      // replicated, not rolled, and the host's new stage is already standing by
      // the time this event lands — so anything that arrives during the
      // transition belongs to the stage we are travelling *to*, and a clear at
      // the far end would throw it away. What goes now is the old stage's
      // furniture, which is about to lose the ground it stands on anyway.
      this.interactables.clear();
      this._startTransition(typeof p?.index === 'number' ? p.index : 0, false);
    });
  }

  // --------------------------------------------------------------- stage flow

  fixedUpdate(ctx, h) {
    // First stage is built on the first step so every other system has run its
    // init and the player exists to be repositioned.
    if (!this._started && ctx.authority) { this._started = true; this._beginStage(0, true); }

    this.stats.time = ctx.time;
    // Difficulty climbs with wall clock and jumps per stage — the clock is what
    // makes looting slowly a real cost.
    this.difficulty = (1 + 0.4 * (ctx.time / 60)) * Math.pow(1.15, this.stageIndex);
    // `ctx.difficulty` used to mirror this number. It is now the difficulty
    // *selection* API owned by `systems/Artifacts.js` (Overcast/Downpour/
    // Deluge), and this value keeps the one name it was ever read under —
    // `progression.difficulty`, which `_tickTeleporter` and `runStats` already
    // use. Its single external reader (`Items.killReward`, as a fallback behind
    // the director's coefficient) now reads the director directly.

    // Teleporter charge, boss gating and stage transitions are host decisions;
    // clients see the outcome as events.
    if (ctx.authority) this._tickTeleporter(ctx, h);
    this.interactables.fixedUpdate(ctx, h);
  }

  update(ctx, dt) {
    this.interactables.update(ctx, dt);
    // Driven from `update`, not `fixedUpdate`, and deliberately not gated on
    // `ctx.paused`: a transition is a piece of machinery halfway through
    // replacing the world, and a player who opens the menu mid-fade must not be
    // able to leave it there. Real frame time for the same reason — the veil is
    // a wall-clock animation, and the fixed step is exactly the thing that will
    // not be running smoothly while a stage is being built.
    if (this.transition) this._stepTransition(dt);
  }

  /**
   * Take the Fallow Vault's stake. Called by the shrine, host-only by
   * construction (`Interactables.requestInteract` gates on `ctx.authority`).
   *
   * Adds rather than replaces, so two vaults across two stages both pay. The
   * shrine has already taken the gold; this only owes it back.
   */
  commitToVault(payout) {
    if (!(payout > 0)) return;
    this.vault = { payout: Math.round((this.vault?.payout || 0) + payout), dueStage: this.stageIndex + 1 };
  }

  /**
   * Pay a matured vault. Host-only — `addGold` is game state and reaches
   * clients as `goldChanged`, which NetHost already forwards.
   *
   * A run that ends before the next stage begins never reaches here, and that
   * is the shrine's entire risk: the gold is in the ground, not in the purse.
   */
  _settleVault(index) {
    const v = this.vault;
    if (!v || index < v.dueStage) return;
    this.vault = null;
    this.ctx.items?.addGold?.(v.payout);
    this.ctx.events.emit('vaultPaid', { amount: v.payout });
  }

  /** Host-side stage entry: build it, fill it, announce it. */
  _beginStage(index, first = false) {
    // Stage 0 is already standing — `Stage.init` built it before any of this
    // existed, so there is nothing to fade over and nothing to generate. It
    // goes straight to the far side of the transition.
    if (first) {
      this._nameStage(index);
      this._openStage(index);
      return;
    }
    this._startTransition(index, true);
  }

  /**
   * The half both roles run: name the stage and clear the run flags it owns.
   *
   * Split out of the old `_applyStage` because it is now the *first* thing a
   * transition does rather than something that happens alongside the rebuild.
   * Zeroing the teleporter state at the top of the fade is what stops the
   * charge ring, the boss gate and the loot window from continuing to tick
   * against a stage that is on its way out; `_tickTeleporter` carries a second,
   * explicit guard on the same fact, because "the flags happen to be idle" is a
   * weaker statement than "there is a transition in flight".
   */
  _nameStage(index) {
    this.stageIndex = index;
    this.stageName = fullStageName(index);
    this.state = 'idle';
    this.charge = 0;
    this._lastEmitted = -1;
    this.bossAlive = false;
    this.bossCleared = false;
    this.lootTimer = 0;
    // The old stage's teleporter is gone; the new one is published by
    // `_openStage` once the stage is populated. A client leaves this null until
    // the host replicates the interactable.
    this.teleporterPosition = null;
  }

  /**
   * Put the player on the new ground. Runs in the same frame as the stage swap,
   * never before it — a spawn point sampled off the old heightfield would drop
   * the player through the new one.
   */
  _seatPlayer() {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    const spawn = ctx.stage?.spawnPoint?.() || this._tmp.set(0, 2, 0);
    if (p.respawnAt) p.respawnAt(spawn);
    else {
      p.position.copy(spawn);
      p.velocity?.set(0, 0, 0);
    }
  }

  /** Host-side: fill the standing stage and announce it. */
  _openStage(index) {
    // Before the stage is populated, so the purse the player arrives with is
    // the one the chest prices are about to be measured against.
    this._settleVault(index);
    const tp = this.interactables.populate(index);
    // Publish before `stageStart` so anything that reacts to the new stage
    // already has an objective to point at.
    this.teleporterPosition = tp?.position?.clone() || null;
    // Hidden-realm gateways go down after the stage's own loot, so they are
    // sited against the landmarks the chests already used and can never land on
    // the teleporter. Host-only inside; see Realms.onStagePopulated.
    this.ctx.realms?.onStagePopulated?.(index);
    this.ctx.events.emit('stageStart', { index, name: this.stageName });
    this.ctx.audio?.play?.('stageStart');
  }

  // -------------------------------------------------------------- transitions

  /**
   * Is a stage change allowed to take several frames?
   *
   * Only where there is a rendered frame whose smoothness is the entire point.
   * Every headless caller — the tests, `coopprobe`, the review probes — asks
   * for a stage and expects to have one when the call returns, and giving them
   * a transition that needs an `update` pump they do not run would hang them.
   * `stretchTransitions` overrides both ways so the incremental path is
   * reachable from a test rather than only from a machine with a GPU.
   */
  _canStretch() {
    if (typeof this.stretchTransitions === 'boolean') return this.stretchTransitions;
    return !!this.ctx?.pipeline?.renderer;
  }

  /**
   * Begin replacing the world with stage `index`.
   *
   * `host` says whether this side rolls the stage's contents or waits to be
   * told them; everything else about the sequence is identical on both, which
   * is deliberate — a client used to eat the same multi-second freeze the host
   * did, from the same `Stage.build` call, and fixing it on one side only would
   * have left co-op with the bug.
   */
  _startTransition(index, host) {
    // A second transition while one is running can only mean the world already
    // owes us a stage we have not finished arriving at — a client handed two
    // `stageStart`s in quick succession. Land the first one before leaving for
    // the second; skipping it would leak the old stage's geometry.
    if (this.transition) this._drainTransition();

    const t = { index, host, phase: 'out', t: 0, steps: null, veil: 0 };
    this.transition = t;
    this._nameStage(index);

    // Stop the world, not the frame. Combat, the Director, enemy AI, the
    // projectiles already in the air and every damage-over-time clock come off
    // the fixed step for the length of the transition — see
    // `runsDuringStageChange` in Engine.js for the whole argument. The short
    // version: the player has no controls for the next second and it is not
    // acceptable to be killed during it. The old synchronous build gave this
    // for free by blocking the loop; it is deliberate now.
    if (this.ctx) this.ctx.stageChanging = true;

    // The outgoing stage's furniture dies *here*, not at `stageStart`.
    // `stageStart` is emitted from `_openStage`, one statement after
    // `Realms.onStagePopulated` has already offered the *new* stage's gateways,
    // so a listener that tears realm state down on `stageStart` destroys the
    // records it was meant to protect (integration review 2026-08-23, MAJOR-1:
    // no gateway was ever warmed). Anything keyed to the stage being left
    // listens to this instead, and gets the whole build to work in.
    this.ctx?.events?.emit?.('stageChanging', { index, host });

    // The player is a passenger for the length of the fade — but only one of
    // three parts of the build that can be saying so at once. `input.enabled`
    // has three writers (this one, `NetHost._holdSession` and
    // `FallbackPause.setFallbackPause`) and no boolean can hold three claims,
    // so none of them writes it: they claim and release a named mute and the
    // boolean is derived (`src/core/InputMute.js`, #197).
    //
    // This used to be a save-and-restore, which was the same idea aimed at only
    // one of the other two — and it got the answer wrong whenever a menu went
    // up *during* the fade, because the value it restored was saved before that
    // menu existed. The far side of the transition then handed the stick back
    // under an open pause overlay, with nothing left that would ever take it
    // away again. See `tests/input-ownership.test.mjs`.
    muteInput(this.ctx?.input, INPUT_MUTE, true);

    if (!this._canStretch()) this._drainTransition();
  }

  /** One frame of the transition. See VEIL_OUT / VEIL_IN. */
  _stepTransition(dt) {
    const t = this.transition;
    if (t.phase === 'out') {
      t.t += dt;
      t.veil = Math.min(1, t.t / VEIL_OUT);
      if (t.veil >= 1) {
        t.phase = 'build';
        t.steps = this.ctx.stage?.buildSteps?.(t.index) ?? null;
        // Nothing to build (a stage-less test ctx) is not a failure; the
        // transition still has to reach its far side and give input back.
        if (!t.steps) { this._commit(t); this._settle(t); t.phase = 'in'; t.t = 0; }
      }
    } else if (t.phase === 'build') {
      // One generator step per frame. The screen is full black by now, so the
      // only thing this rate trades against is how long the black lasts — and
      // a step per frame is what keeps any single one of them from being long
      // enough to notice.
      const step = t.steps.next();
      if (step.done) { this._settle(t); t.phase = 'in'; t.t = 0; }
      else if (step.value === 'commit') this._commit(t);
    } else {
      t.t += dt;
      t.veil = Math.max(0, 1 - t.t / VEIL_IN);
      if (t.veil <= 0) return this._endTransition();
    }
    this._paintVeil(t.veil);
  }

  /**
   * Publish the veil's opacity. An event rather than a call into `src/ui/`:
   * a system may not import the UI layer (`tests/import-boundaries.test.mjs`
   * rule 1), and the indirection earns its keep anyway — every headless driver
   * runs this same transition and none of them has a screen to darken.
   */
  _paintVeil(alpha) {
    if (alpha === this._veil) return;
    this._veil = alpha;
    this.ctx?.events?.emit?.('stageVeil', { alpha });
  }

  /**
   * The new stage has just replaced the old one. Only the player moves here,
   * and it moves *now* rather than with the rest of the arrival below: it is
   * standing on a heightfield that no longer exists, and one fixed step of that
   * is one fixed step of falling through the world.
   */
  _commit(t) {
    this._seatPlayer();
    t.committed = true;
  }

  /**
   * Everything that used to follow `Stage.build()` in `_beginStage`, in the
   * order it followed it: the stage is complete, its probe is baked, and only
   * then does anything get put on it.
   */
  _settle(t) {
    if (t.settled) return;
    t.settled = true;
    // `director.reset` used to run *before* the player was reseated; it now
    // runs one to two steps after, because seating cannot wait — the player is
    // standing on a heightfield that has just stopped existing. That leaves a
    // window in which the outgoing stage's enemy pool is still allocated while
    // the player stands on the new ground, and the window is harmless for a
    // reason worth stating rather than assuming: the Director does not tick
    // during a transition at all. It has no `runsDuringStageChange`, so the
    // Engine skips its fixed step for the whole window, and an enemy that never
    // gets a step cannot chase, spawn or hit anything. See the assertion in
    // `tests/stage-transition.test.mjs`.
    this.ctx.director?.reset?.(t.index);
    if (t.host) this._openStage(t.index);
  }

  /** Run whatever is left of the transition right now, all in this frame. */
  _drainTransition() {
    const t = this.transition;
    if (!t) return;
    if (!t.steps && t.phase !== 'in') t.steps = this.ctx.stage?.buildSteps?.(t.index) ?? null;
    if (t.steps) {
      for (const step of t.steps) if (step === 'commit') this._commit(t);
    }
    if (!t.committed) this._commit(t);
    this._settle(t);
    this._endTransition();
  }

  /**
   * Hand the world back.
   *
   * Unconditional, and reached from both ends — the in-fade finishing and
   * `_drainTransition` — because the two things released here are the two
   * things that must never be left switched on. A run that ended during the
   * transition (an enemy's last damage-over-time tick landing in the frame
   * before it began, `playerDead` -> `_endRun` firing under the veil) still
   * comes through here: the death screen is a `ctx.paused` matter and has
   * nothing to say about whether the simulation is frozen, so leaving
   * `stageChanging` up would freeze the fixed step for the rest of the session.
   */
  _endTransition() {
    this.transition = null;
    if (this.ctx) this.ctx.stageChanging = false;
    // Releases this claim only. If a menu or a co-op hold is also claiming, the
    // controls stay gone until *that* owner releases them.
    muteInput(this.ctx?.input, INPUT_MUTE, false);
    this._paintVeil(0);
  }

  advanceStage() {
    // The portal is a prop the player can stand on and press twice, and the
    // second press used to start a second rebuild on top of the first.
    if (this.transition) return;
    this.stats.stagesCleared++;
    this._beginStage(this.stageIndex + 1);
  }

  /**
   * Adopt the host's stage on joining a co-op game.
   *
   * Deliberately routed through the same `stageStart` event a mid-run stage
   * transition uses, rather than rebuilding directly: that event is also what
   * tells the Director to drop the enemies this client was simulating a moment
   * ago as a single-player host, and what resets the HUD. Marking the run as
   * started stops `fixedUpdate` from ever building stage 0 locally if authority
   * is later handed back.
   */
  syncStage(index) {
    this._started = true;
    this.ctx.events.emit('stageStart', { index, name: fullStageName(index) });
  }

  // -------------------------------------------------------------- teleporter

  _tickTeleporter(ctx, h) {
    // Not while the world is being replaced. `_nameStage` has already zeroed
    // every flag this reads, so on today's code paths this guard changes
    // nothing — but "the state happens to be idle" is an accident of ordering
    // and "there is a transition in flight" is the actual reason, and the
    // teleporter still standing on the outgoing stage is exactly the object
    // this must not spawn a boss around.
    if (this.transition) return;
    const tp = this.interactables.teleporter;
    if (!tp) return;

    if (this.state === 'idle') {
      if (tp.state === 'charging') {
        this.state = 'charging';
        // The boss is the event; the charge is just the timer on it.
        ctx.director?.spawnBoss?.(this.stageIndex, this.difficulty, tp.position);
        ctx.events.emit('teleporterCharging', { progress: 0 });
      }
      return;
    }

    if (this.state === 'charging') {
      const p = ctx.player;
      const inRing = p?.alive && p.position.distanceToSquared(tp.position) < tp.chargeRadius * tp.chargeRadius;
      if (inRing && this.charge < 1) {
        this.charge = Math.min(1, this.charge + h / CHARGE_TIME);
        tp.setProgress(this.charge);
        if (this.charge - this._lastEmitted >= CHARGE_EMIT_STEP || this.charge >= 1) {
          this._lastEmitted = this.charge;
          ctx.events.emit('teleporterCharging', { progress: this.charge });
        }
      }
      // Both conditions, in either order: the ring can finish while the boss is
      // still up, and the boss can die while the ring is empty.
      if (this.charge >= 1 && this.bossCleared && !this.bossAlive) {
        this.state = 'complete';
        tp.state = 'complete';
        this.lootTimer = LOOT_WINDOW;
        ctx.events.emit('teleporterComplete', {});
        ctx.audio?.play?.('teleporterComplete', tp.position);
        ctx.vfx?.burst?.(tp.position, 0x2ad0ff);
      }
      return;
    }

    if (this.state === 'complete') {
      this.lootTimer -= h;
      ctx.events.emit('lootWindow', { remaining: Math.max(0, this.lootTimer) });
      if (this.lootTimer <= 0) {
        this.state = 'portal';
        const at = tp.position.clone().add(this._tmp.set(4, 0, 0));
        this.interactables.spawnPortal(at, () => this.advanceStage());
        // And whatever else this stage has earned beside it: a way into the
        // market if a Tithe Altar was paid for, and — from FINALE_STAGE on — the
        // rift that ends the run. The ordinary portal is always there, so
        // reaching the finale never takes the loop away.
        ctx.realms?.openPortals?.(at, this.stageIndex);
      }
    }
  }

  // ----------------------------------------------------------------- levelling

  /**
   * Host-only. A monster is worth its card's `xp`, scaled by the level the
   * Director spawned it at (the same 0.2/level ramp its health and damage use)
   * and doubled for elites, so the reward tracks the effort.
   *
   * A Voidtouched victim is the one exception, and it is not the Director that
   * bought it: the void spawns it off World Corruption, so it pays the same
   * quarter share `Items.killReward` pays. XP and gold are separate funnels —
   * this multiplier has to be applied in both places or the two disagree.
   */
  _awardKillXp(e) {
    const v = e.victim;
    if (!v) return;
    const base = v.def?.xp ?? v.xp ?? 1;
    const lvl = Math.max(1, v.level || 1);
    let amount = base * (1 + XP_PER_MONSTER_LEVEL * (lvl - 1));
    if (e.isElite) amount *= 2;
    if (isVoidtouched(v)) amount *= VOIDTOUCHED.rewardMult;
    this.addExperience(amount);
  }

  /**
   * Host-only entry point. Announces every level gained as one `levelUp` event
   * carrying the whole state, which is what keeps a client's bar honest without
   * adding a snapshot field.
   */
  addExperience(amount) {
    if (!this.ctx.authority || !(amount > 0)) return;
    this.xp += amount;
    let levelled = false;
    // A boss can be worth several levels at once; drain the whole surplus.
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = xpForLevel(this.level);
      levelled = true;
    }
    if (levelled) {
      this.ctx.events.emit('levelUp', {
        level: this.level,
        xp: Math.round(this.xp),
        xpToNext: this.xpToNext,
      });
    }
  }

  _dropBossItem(position) {
    // `bossDead` is replicated, so a client reaches here too — and picking from
    // the boss pool would advance the gameplay stream it must not touch.
    if (!this.ctx.authority || !position) return;
    const pool = ITEMS_BY_TIER.boss;
    if (!pool?.length) return;
    const id = this.ctx.rng.pick(pool).id;
    // Boss items come from the boss, not the teleporter, so the drop lands
    // where the kill happened and the player has to go get it.
    this.interactables.spawnOrb(position, id, 2.2);
  }

  // ------------------------------------------------------------------ run end

  /**
   * End the run deliberately, with a named ending.
   *
   * Both of the run's two real conclusions come through here — killing the
   * Herald and stepping into the Obelisk of Departure — and both commit a
   * record through `ctx.profile` and raise the same `runEnd` the death screen
   * already listens to. The only thing that distinguishes them downstream is
   * `stats.ending`, which is additive: every existing reader of `runStats()`
   * sees exactly what it saw before.
   */
  finishRun(ending) {
    if (this._ended) return;
    this.ending = ending || null;
    // Tell any guest which ending this was (issue #220). `Realms.victory()`
    // and `obliterate()` run authority-gated and call this only on the host,
    // so without this a guest's own run simply never resolved on a win — no
    // summary screen, no committed record — while the host's did. Guarded on
    // `authority` so the listener below (which re-enters this same method on
    // a guest) does not re-broadcast what it was just told.
    if (this.ctx.authority && this.ending) {
      this.ctx.events.emit('runEnding', { endingId: this.ending.id });
    }
    this._endRun(ending ? !!ending.won : true);
    // The run-summary screen is raised by the HUD's `playerDead` handler, which
    // is the only way it has ever been reached. A deliberate ending emits no
    // such event — the survivor is standing up — so it calls the same public
    // entry point directly rather than faking a death on the bus, which would
    // also fire the death VFX, the death sound and every `playerDead` listener
    // in the build.
    this.ctx.hud?.onDeath?.();
    // …and then say what actually happened. The summary's headline is authored
    // markup that reads "You Died", which is correct for the only ending the
    // game had until now and wrong for both of the ones it has gained. Two
    // guarded text writes rather than a new screen: everything else on that
    // panel — the run identity, the stat grid, the item haul, the unlock
    // ribbons — is already exactly what a finished run wants to show.
    const root = this.ctx.menus?.root;
    const word = root?.querySelector('.screen--death .death-word');
    const sub = root?.querySelector('.screen--death [data-death-sub]');
    if (word && this.ending) word.textContent = this.ending.title;
    if (sub && this.ending?.line) sub.textContent = this.ending.line;
  }

  _endRun(won) {
    if (this._ended) return;
    this._ended = true;
    const stats = this.runStats();
    // Commit to the persistent profile *before* the event, so anything that
    // renders off `runEnd` (the death screen, and B3's unlock toast) already
    // sees the committed record, the updated lifetime totals and any unlock the
    // final challenge pass just granted. `runEnd`'s payload is unchanged.
    this.profile.commitRun(won, stats);
    this.ctx.events.emit('runEnd', { won, stats });
  }

  /** Snapshot for the death screen. */
  runStats() {
    const items = this.ctx.items?.inventory?.() || [];
    return {
      ...this.stats,
      stage: this.stageIndex + 1,
      stageName: this.stageName,
      difficulty: this.difficulty,
      gold: this.ctx.items?.gold || 0,
      // The run's corruption record: how deep, and which band it ended in.
      // Endings key off band plus route (launch spec §2); the summary screen
      // and the logbook read these if they know about them and ignore them
      // if they do not.
      corruption: Math.round(this.ctx.corruption?.world ?? 0),
      corruptionBand: this.ctx.corruption?.band ?? 0,
      // And the worst it ever got. The listener is the mechanism; the live band
      // is folded in here only as a floor, for the case where a gauge existed
      // before this system's listener did — it can never lower the mark.
      corruptionPeakBand: Math.max(this.corruptionPeakBand, this.ctx.corruption?.band ?? 0),
      // The alignment commitment summary (issue #169) — history rather than
      // final state, so the logbook records what a run *did* and not only where
      // it happened to be standing when it ended.
      //
      // Authority-gated, and that gate is the whole correctness of the field.
      // `_endRun` runs on every machine, but the ledger is host-local, so a
      // guest asking its own `Corruption` for a verdict gets an empty one and
      // would file a deeply corrupted co-op run as 'neutral' — permanently, and
      // in disagreement with the host's record of the same run. Off the host
      // the fields are simply absent, and `Profile` writes ALIGNMENT_UNKNOWN.
      // Spread rather than assigned so a context with no `Corruption` at all
      // (the tests' bare worlds) lands in the same honest place.
      ...(this.ctx.authority ? (this.ctx.corruption?.ledgerSummary?.() ?? {}) : {}),
      inventory: items,
      timeText: formatTime(this.stats.time),
      // Which ending this was, or null for the ordinary one (death). Read by
      // the summary screen if it knows about it and ignored if it does not.
      ending: this.ending?.id ?? null,
      endingTitle: this.ending?.title ?? null,
      endingLine: this.ending?.line ?? null,
    };
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
