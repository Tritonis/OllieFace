import {
  ARTIFACTS, ARTIFACT_BY_ID, CAPRICE_TIERS,
  DIFFICULTIES, DIFFICULTY_BY_ID, DEFAULT_DIFFICULTY,
} from '../data/artifacts.js';
import { CHALLENGE_BY_ID, UNLOCK_BINDINGS } from '../data/challenges.js';

/**
 * Artifacts and difficulty — the run's rules.
 *
 * ## The one architectural rule
 *
 * **This system answers questions. It never reaches into another system.**
 *
 * There is no `ctx.director.populationCap *= 2` anywhere below, and there must
 * never be one. `Director` asks `ctx.artifacts.has('swarms')`; `Items` asks
 * `runMods()`; `Interactables` asks `has('sacrifice')`. Every consultation point
 * is listed in the table at the top of `data/artifacts.js`.
 *
 * The reason is not tidiness. Seven artifacts that each poke three systems is
 * twenty-one places where an effect can be left switched on after a run ends,
 * and the bug that produces — "my second run had Glass on and I never picked
 * it" — is invisible until someone plays two runs in a row. A query API cannot
 * have that bug: turn the flag off and every consultation point agrees on the
 * same frame, because none of them ever stored anything.
 *
 * It is also what makes the whole feature free when it is off. Nothing here has
 * `fixedUpdate` or `update`; the system owns no frame time at all. With no
 * artifact active every consultation point is one `Set.has` against an empty
 * set, and `tools/perf.mjs` shows no `Artifacts.*` entry in `perSystemMs`.
 *
 * ## Co-op
 *
 * The artifact set and the difficulty are the *host's*. A client adopts both out
 * of `WELCOME` (`Coop._onWelcome` -> `adoptHost`) and its own pre-run selection
 * is discarded for the session — running Glass on a host that did not pick it
 * would mean a client whose stat block disagrees with the host's simulation of
 * the same pawn.
 *
 * Nothing here draws from `ctx.rng` except on paths a host-only caller already
 * gated (`Items.rollItem`, `Items.rewardKill`), for the reason in NETCODE.md: a
 * client that advanced the gameplay stream would desync every later loot roll.
 *
 * ## Pre-run only
 *
 * `setActive` and `difficulty.set` are ignored once the run is live, which is
 * the first `stageStart`. A run whose rules change halfway through is not a run
 * anyone can reason about, and `Items.stats` caches the block that `runMods`
 * feeds — a mid-run flip would apply to some numbers and not others.
 */

const STORE_KEY = 'petrichor.run.v1';

// Glass. Five times damage, a tenth of the health — the RoR2 trade, and the
// only artifact whose numbers are a straight multiplier on the finished stat
// block rather than an input to something else.
const GLASS_DAMAGE = 5.0;
const GLASS_HEALTH = 0.1;

// Evolution. RoR2 hands monsters your actual items; the honest description of
// what happens here is a stat scale derived from how many you hold, because the
// enemy stat block has no inventory to put them in. Tuned so a 30-item run
// (the `hoarder` challenge, i.e. a good run) is a little over double health,
// which is roughly what a shared inventory would be worth.
const EVOLUTION_HEALTH_PER_ITEM = 0.038;
const EVOLUTION_DAMAGE_PER_ITEM = 0.020;
const EVOLUTION_HEALTH_CAP = 4.0;
const EVOLUTION_DAMAGE_CAP = 2.5;

// Swarms. Twice the bodies, half the health each.
const SWARM_HEALTH = 0.5;

// Honour. Every unit carries an affix, so the affix multiplier is doing the
// heavy lifting already; without a cut the field is four times tougher on the
// first stage. Half health is what puts an elite-only minute one somewhere
// near a normal minute one.
const HONOUR_HEALTH = 0.5;
// What an affix costs the director under Honour. Elites are 4.5-7.2x normally;
// at full price an elite-only run buys one monster a minute.
// Not exported: the Director asks `eliteCostMult()` rather than importing this,
// because a system importing another system is the thing CONTRACTS.md forbids.
const HONOUR_ELITE_COST = 0.35;

// Sacrifice. Chance a dead monster pays an item, scaled by what it cost the
// director to put there — a 4-credit mite is a lottery ticket, a 46-credit hulk
// is most of a chest. Bosses are handled by `Progression._dropBossItem` and are
// deliberately excluded here so they do not pay twice.
const SACRIFICE_BASE = 0.055;
const SACRIFICE_PER_COST = 0.0042;
const SACRIFICE_MAX = 0.34;

export class Artifacts {
  constructor() {
    this.set = new Set();
    this.difficultyId = DEFAULT_DIFFICULTY;
    // True from the first `stageStart`. Selection is pre-run only.
    this.live = false;

    // Installed by the UI to make Command a real picker. Signature:
    // `(tier, ids) -> id`. Without one, `_defaultPick` runs — see below.
    this._chooser = null;

    // Reused output objects. `monsterScale` is called once per spawned unit and
    // `runMods` once per stat-block rebuild; neither should allocate.
    this._mods = { damage: 1, health: 1, regen: 1, gold: 1 };
    this._scale = { health: 1, damage: 1 };
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.artifacts = this;

    // `ctx.difficulty` used to be the number Progression published, read in
    // exactly one place (`Items.killReward`, as a fallback behind the
    // director's own coefficient) and by nothing else. It is now the selection
    // API B3 builds against; Progression keeps the number as
    // `progression.difficulty`, which is what its own callers already used.
    ctx.difficulty = {
      current: () => this.difficultyCard(),
      set: (id) => this.setDifficulty(id),
      list: () => DIFFICULTIES.slice(),
    };
    // Read by `Profile.commitRun` for the run record. It documented this field
    // as "arrives when B2/B3 land"; this is it landing.
    ctx.difficultyId = this.difficultyId;

    this._load();
    this._auditUnlocks();

    // The run is live from the first stage. Both roles: a client's own stage 0
    // arrives as the host's replicated `stageStart` and its rules were already
    // fixed by `adoptHost`.
    //
    // The unlock sweep happens here rather than in `_load` because this system
    // is registered before `Progression`, which is what constructs `Profile` —
    // so at load time there is nothing to ask. Deliberate ordering: `Director`
    // wants `ctx.difficulty` to exist during its own `init`. The restored
    // selection is therefore re-checked at the last possible moment, which is
    // also the moment it would first have an effect.
    ctx.events.on('stageStart', () => {
      if (!this.live) this._enforceUnlocks();
      this.live = true;
    });
  }

  // ------------------------------------------------------------------- query
  // The public API. Everything below this line is read-only from the caller's
  // point of view; nothing here mutates another system.

  /** Is this artifact active for the run in progress? */
  has(id) { return this.set.has(id); }

  /** Active artifact ids. A copy — the caller must not be able to edit the set. */
  active() { return [...this.set]; }

  /** Every artifact card, for the select grid. */
  list() { return ARTIFACTS.slice(); }

  /** The card for one id, or null. */
  card(id) { return ARTIFACT_BY_ID.get(id) || null; }

  /**
   * Set the active artifacts. Pre-run only; ignored once a run is live.
   *
   * Locked ids are dropped rather than rejecting the whole call: the UI already
   * greys them, so an id arriving here that the profile has not unlocked is a
   * stale selection from before a profile reset, and silently honouring the
   * rest of the list is the behaviour that does not lose the player's other
   * six choices.
   */
  setActive(ids) {
    if (this.live) return;
    this.set.clear();
    for (const id of ids || []) {
      if (!ARTIFACT_BY_ID.has(id)) continue;
      if (!this.isUnlocked(id)) continue;
      this.set.add(id);
    }
    this._save();
    this.ctx?.events?.emit('artifactsChanged', { active: this.active() });
  }

  /** Convenience for a toggle row. Same pre-run rule. Returns the new state. */
  toggle(id, on = !this.set.has(id)) {
    if (this.live || !ARTIFACT_BY_ID.has(id)) return this.set.has(id);
    const next = this.active().filter((x) => x !== id);
    if (on) next.push(id);
    this.setActive(next);
    return this.set.has(id);
  }

  /** Whether the profile has earned this artifact. Unlocked by default. */
  isUnlocked(id) {
    const p = this.ctx?.profile;
    return p ? p.isUnlocked('artifact', id) !== false : true;
  }

  // ----------------------------------------------------------- difficulty API

  /** The active difficulty card. Shared and treated as read-only by callers. */
  difficultyCard() {
    return DIFFICULTY_BY_ID.get(this.difficultyId) || DIFFICULTY_BY_ID.get(DEFAULT_DIFFICULTY);
  }

  /** Pre-run only, like `setActive`. */
  setDifficulty(id) {
    if (this.live || !DIFFICULTY_BY_ID.has(id)) return;
    this.difficultyId = id;
    if (this.ctx) this.ctx.difficultyId = id;
    this._save();
    this.ctx?.events?.emit('difficultyChanged', { id, card: this.difficultyCard() });
  }

  // ------------------------------------------------------- gameplay questions
  // Each of these is the answer to one system's question. The caller owns the
  // arithmetic that uses it; none of them touch the caller.

  /**
   * Multipliers on the *player's* finished stat block and income.
   * `Items.stats` applies damage/health/regen; `Items.killReward` applies gold.
   */
  runMods() {
    const d = this.difficultyCard();
    const m = this._mods;
    m.damage = this.set.has('glass') ? GLASS_DAMAGE : 1;
    m.health = this.set.has('glass') ? GLASS_HEALTH : 1;
    m.regen = d.regen;
    m.gold = d.gold;
    return m;
  }

  /**
   * Multipliers on a monster's health and damage at the moment it spawns, over
   * and above the Director's own level scaling. `Director.spawnOne` folds these
   * into the `healthMult` / `damageMult` it already passes to `Enemy.spawn`.
   *
   * Baked in at spawn on purpose: an Evolution monster is as strong as your
   * inventory was when it arrived, not as strong as your inventory is now.
   * Re-deriving it every frame would mean a chest opened mid-fight retroactively
   * healed everything on the field.
   */
  monsterScale() {
    const d = this.difficultyCard();
    const s = this._scale;
    s.health = d.enemyHealth;
    s.damage = d.enemyDamage;
    if (this.set.has('swarms')) s.health *= SWARM_HEALTH;
    if (this.set.has('honour')) s.health *= HONOUR_HEALTH;
    if (this.set.has('evolution')) {
      const n = this._itemsHeld();
      s.health *= Math.min(EVOLUTION_HEALTH_CAP, 1 + EVOLUTION_HEALTH_PER_ITEM * n);
      s.damage *= Math.min(EVOLUTION_DAMAGE_CAP, 1 + EVOLUTION_DAMAGE_PER_ITEM * n);
    }
    return s;
  }

  /**
   * What an elite affix costs the Director, as a multiplier on the affix's own
   * price. Only Honour moves it, and it has to: at the tuned 4.5-7.2x an
   * elite-only run cannot afford a second monster.
   */
  eliteCostMult() { return this.set.has('honour') ? HONOUR_ELITE_COST : 1; }

  /**
   * Chance in 0..1 that this corpse pays an item under Sacrifice, or 0.
   * `Items.rewardKill` does the roll and the drop — it owns both the RNG stream
   * and the orb, and this system owns neither.
   */
  sacrificeChance(victim) {
    if (!this.set.has('sacrifice') || !victim || victim.isBoss) return 0;
    const cost = victim.def?.cost ?? 8;
    return Math.min(SACRIFICE_MAX, SACRIFICE_BASE + SACRIFICE_PER_COST * cost);
  }

  /**
   * A tier for Caprice. Host-only callers only — this draws from `ctx.rng`.
   */
  capriceTier() {
    return this.ctx.rng.weighted(CAPRICE_TIERS).tier;
  }

  /**
   * Command's pick. `pool` is the tier's item list, exactly as `Items.rollItem`
   * already had it; the return is one id from it.
   *
   * ### Why there is a default, and why it is not random
   *
   * Command is a *choice*, and a choice needs a screen. The screen belongs to
   * whoever owns `ui/`, so this ships with the mechanism and a policy: pick the
   * item you already hold most of in that tier, falling back to the first card
   * in the tier. That is not a placeholder — it is what a Command player does
   * with the picker anyway, it makes the artifact's effect obvious and provable
   * without a single click, and it is deterministic, which is the property that
   * distinguishes it from having no artifact at all.
   *
   * `setCommandChooser` replaces it with a real picker without touching this.
   */
  commandPick(tier, pool) {
    if (!pool || !pool.length) return null;
    if (this._chooser) {
      const picked = this._chooser(tier, pool.map((p) => p.id));
      if (picked && pool.some((p) => p.id === picked)) return picked;
      // A chooser that returns nothing usable falls through to the policy
      // rather than to a roll: a mis-wired UI must not silently turn Command
      // back into vanilla loot.
    }
    return this._defaultPick(pool);
  }

  /** Install a real Command picker. `(tier, ids) -> id`. Pass null to remove. */
  setCommandChooser(fn) { this._chooser = typeof fn === 'function' ? fn : null; }

  _defaultPick(pool) {
    const items = this.ctx?.items;
    let best = pool[0];
    let bestN = -1;
    for (let i = 0; i < pool.length; i++) {
      const n = items?.count?.(pool[i].id) ?? 0;
      if (n > bestN) { bestN = n; best = pool[i]; }
    }
    return best.id;
  }

  _itemsHeld() {
    const inv = this.ctx?.items?.counts;
    if (!inv) return 0;
    let n = 0;
    for (const c of inv.values()) n += c;
    return n;
  }

  // -------------------------------------------------------------------- co-op

  /**
   * Pack the run's rules for `WELCOME`: `{ mask, difficulty }`.
   *
   * A bitmask over `ARTIFACTS` order rather than a list of strings, because
   * `WELCOME` is a fixed-layout binary message and seven booleans do not
   * deserve a length-prefixed array. Both ends are the same build, so index
   * order is a shared constant — the same argument `typeId` already makes for
   * enemies in NETCODE.md.
   */
  netPack() {
    let mask = 0;
    for (let i = 0; i < ARTIFACTS.length; i++) if (this.set.has(ARTIFACTS[i].id)) mask |= 1 << i;
    return { mask, difficulty: this.difficultyCard().index };
  }

  /**
   * Adopt the host's rules. Bypasses the pre-run lock by design: a client's run
   * is already live by the time `WELCOME` lands, and the alternative is a
   * client simulating its own artifact set against the host's world.
   *
   * Also skips the unlock gate. A client is entitled to play the host's Glass
   * run without having earned Glass — the same way a guest in RoR2 does — and
   * an unlock check here would mean the host's rules silently differ from the
   * client's, which is a desync, not a fairness measure.
   */
  adoptHost(mask, difficultyIndex) {
    this.set.clear();
    for (let i = 0; i < ARTIFACTS.length; i++) {
      if ((mask >>> i) & 1) this.set.add(ARTIFACTS[i].id);
    }
    const d = DIFFICULTIES[difficultyIndex] || DIFFICULTY_BY_ID.get(DEFAULT_DIFFICULTY);
    this.difficultyId = d.id;
    if (this.ctx) this.ctx.difficultyId = d.id;
    this.live = true;
    // Not persisted: the host's rules are the host's, and writing them over the
    // player's own selection would mean joining one Glass game changed what
    // their next solo run boots with.
    this.ctx?.events?.emit('artifactsChanged', { active: this.active() });
    this.ctx?.events?.emit('difficultyChanged', { id: d.id, card: d });
  }

  // ------------------------------------------------------------- persistence

  /**
   * The selection survives a reload, because "start a run" is a page load in
   * this game (`Menus` restarts with `location.reload()`). Without this every
   * artifact would be un-selected by the time the run it was selected for
   * actually began.
   *
   * Own key, own owner: `Profile` owns `petrichor.profile.v1` for meta state
   * and `Menus` owns the settings blob. This is neither — it is what the *next*
   * run is configured as — so it gets its own and overlaps nothing.
   *
   * Storage that throws (private mode, quota, a partition that went away) costs
   * the memory of the selection and nothing else. Taking the page down over a
   * remembered checkbox would be absurd.
   */
  _load() {
    let raw = null;
    try { raw = globalThis.localStorage?.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    let data = null;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (typeof data.difficulty === 'string' && DIFFICULTY_BY_ID.has(data.difficulty)) {
      this.difficultyId = data.difficulty;
      if (this.ctx) this.ctx.difficultyId = data.difficulty;
    }
    if (Array.isArray(data.artifacts)) {
      for (const id of data.artifacts) {
        if (typeof id === 'string' && ARTIFACT_BY_ID.has(id) && this.isUnlocked(id)) this.set.add(id);
      }
    }
  }

  _save() {
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify({
        artifacts: this.active(),
        difficulty: this.difficultyId,
      }));
    } catch { /* see _load */ }
  }

  /** Drop anything the profile has not actually unlocked. See the `init` note. */
  _enforceUnlocks() {
    for (const id of [...this.set]) {
      if (this.isUnlocked(id)) continue;
      this.set.delete(id);
      console.warn(`[artifacts] "${id}" is not unlocked — dropped from the run`);
    }
  }

  /**
   * Every card names the challenge that unlocks it; `UNLOCK_BINDINGS` names the
   * artifact each challenge rewards. They are two halves of one fact written in
   * two files, and if they ever disagree an artifact is either permanently
   * locked or advertises a condition that unlocks something else. Neither is
   * visible from a screenshot, so it is checked at boot instead.
   */
  _auditUnlocks() {
    for (const a of ARTIFACTS) {
      if (!a.unlock) continue;
      if (!CHALLENGE_BY_ID[a.unlock]) {
        console.warn(`[artifacts] "${a.id}" names unknown challenge "${a.unlock}"`);
        continue;
      }
      const bound = UNLOCK_BINDINGS[a.unlock];
      if (!bound || bound.type !== 'artifact' || bound.id !== a.id) {
        console.warn(`[artifacts] "${a.id}" claims challenge "${a.unlock}" but UNLOCK_BINDINGS does not bind them`);
      }
    }
  }
}
