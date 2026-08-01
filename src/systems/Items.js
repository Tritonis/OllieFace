import { ITEMS, ITEM_BY_ID, ITEMS_BY_TIER, TIERS, hyperbolic } from '../data/items.js';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment.js';

/**
 * Items owns the inventory, the stat pipeline, the item hook dispatch, the
 * equipment slot and the drop tables.
 *
 * `stats(base)` is called every frame by the player, so the whole modified
 * block is cached and only rebuilt when something that feeds it changes:
 * inventory, buffs, permanent health. Everything else in gameplay code reads
 * the block instead of counting items, which keeps every stacking rule here.
 *
 * ## Stacking rules, in one place
 *
 * Three shapes, and every item in `data/items.js` declares which one it is:
 *
 *  - **linear** `per * count` — flat adds (health, armor, damage, jumps). The
 *    run keeps getting better forever, which is the whole appeal of the genre.
 *  - **hyperbolic** `1 - 1/(1 + k*count)` — anything that is a *chance*. Twenty
 *    stacks approach certainty without reaching it, so a chance item is always
 *    worth another copy and never trivialises the game.
 *  - **flat / non-stacking** — Equipment. You hold exactly one; what scales is
 *    its cooldown (`equipCooldownMult`) and its charge count (`extraCharges`),
 *    both of which come off *other* items.
 *
 * All three are applied here and nowhere else. Gameplay code that wants to know
 * how strong an effect is asks the stat block; gameplay code that wants to know
 * how likely one is calls `roll()`.
 *
 * ## Equipment API (rendered by the HUD; see `ui/HUD.js`)
 *
 * ```js
 * ctx.items.equipment            // { id, def, ready, charges, maxCharges,
 *                                //   cooldown, cooldownMax } | null
 * ctx.items.equipmentFraction()  // 0..1, 1 = ready to fire (drives the sweep)
 * ctx.items.useEquipment()       // fire it; true if it actually went off
 * ctx.items.setEquipment(id)     // equip/swap; returns the id that was dropped
 * ```
 * plus the `equipmentChanged` / `equipmentUsed` bus events. The slot is fully
 * playable from the keyboard (Q) with no HUD at all — the HUD is a readout of
 * this state, never the thing that owns it.
 */

/**
 * Drop tables.
 *
 * `TIER_WEIGHTS` is the generic pull; the named tables below are what the world
 * actually rolls against, and they exist so that "what can come out of a large
 * chest" is one line of data rather than a bias object assembled at each call
 * site. Boss, lunar and equipment never appear in a chest table — each has its
 * own source, which is the point of having tiers at all.
 *
 * The weights are RoR2-shaped rather than uniform: white is the floor the run
 * is built on, green is the shape of the build, red is the moment the run
 * changes. 80/20/1 puts a legendary at roughly one chest in a hundred, which is
 * rare enough to be an event and common enough to happen inside a long run.
 */
const TIER_WEIGHTS = { common: 80, uncommon: 20, legendary: 1 };

export const DROP_TABLES = {
  // Small chest / shrine of chance: the default ladder.
  small: { common: 80, uncommon: 20, legendary: 1 },
  // Large chest: no whites at all, and a legendary is eight times likelier.
  large: { common: 0, uncommon: 80, legendary: 8 },
  // Legendary chest: exactly what it says on the lid.
  legendary: { common: 0, uncommon: 0, legendary: 1 },
  // Teleporter boss.
  boss: { boss: 1 },
  // Lunar pool. Reached only by something that explicitly asks for it, because
  // every card in it carries a drawback the player has to opt into.
  lunar: { lunar: 1 },
};

/**
 * Kill gold. The economy is deliberately *closed* against the director: a
 * monster refunds `GOLD_PER_COST x (the credits the director paid for it) x
 * difficulty`. The director banks `0.95 x difficulty` credits/second, so a
 * player who clears what spawns earns `0.95 x GOLD_PER_COST x difficulty^2`
 * gold/second — 57/min at difficulty 1, which buys the first $25 chest inside
 * half a minute and keeps pace with the 1.25^stage price ladder because the
 * squared difficulty term outruns it.
 *
 * Scaling by the card's credit cost is what makes a boss pay orders of
 * magnitude more than a beetle (420 credits vs 6) for free, and elites pay
 * their 4.5-5x affix surcharge back for the same reason.
 */
const GOLD_PER_COST = 1.0;
// Bosses also drop a guaranteed boss item, so their gold is discounted rather
// than letting one teleporter kill fund an entire stage of chests.
const BOSS_GOLD_MULT = 0.6;
// Anything that dies without a spawn card behind it (scripted kills, summons)
// still pays something rather than nothing.
const DEFAULT_KILL_COST = 8;

export class Items {
  constructor() {
    this.counts = new Map();
    this.gold = 0;
    this.permanentHealth = 0;
    this.buffs = new Map();
    this.cooldowns = new Map();

    this._dirty = true;
    this._cache = null;
    this._base = {};
    // Hook lists rebuilt on inventory change so the per-hit path never scans
    // the full item table.
    this._hooks = { onHit: [], onKill: [], onDamaged: [], onJump: [], onInterval: [], onAbility: [], outgoing: [] };
    this._api = null;

    this._killWindow = [];
    this._intervalPayload = { dt: 0 };
    this._pendingImpulse = 0;
    this._barrier = 0;

    // --- equipment slot ---------------------------------------------------
    // One held equipment, N charges, one shared recharge timer. Charges refill
    // one at a time rather than all together, so Fuel Cell reads as "another
    // press banked" instead of "the whole bank comes back at once".
    this.equipmentId = null;
    this.equipCharges = 0;
    this.equipTimer = 0;

    // Counters for `tally` (every-Nth-hit items) and the Hunter's Tag marks.
    this._tallies = new Map();
    this._marks = new Map();
    this._markSweep = 0;
    // Timed, self-ticking effects owned by equipment (drones, meteor storms).
    this._effects = [];
    // Lingering ground hazards owned by items (Spore Sac).
    this._clouds = [];
    this._lastHurt = -999;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.items = this;

    this._api = {
      ctx, items: this, combat: null, player: null, rng: ctx.rng,
      count: 0, procDepth: 0,
      roll: (p) => this.roll(p, this._api.procCoefficient),
      procCoefficient: 1,
    };

    // Player-driven hooks come off the bus; the proc-bearing hooks (onHit,
    // onKill, onDamaged) are called directly by Combat so they can carry
    // proc coefficient and chain depth.
    ctx.events.on('jump', (e) => this.onJump(e));
    ctx.events.on('stageStart', () => {
      this.cooldowns.clear();
      this._marks.clear();
      this._clouds.length = 0;
      this._effects.length = 0;
      // Interim source for the Q slot.
      //
      // Equipment is meant to come out of an equipment barrel, and the barrel
      // lives in `world/Interactables.js` — a file another agent owns this
      // round, so it cannot be added from here. Without *some* source the whole
      // tier is unreachable in a real run and the twelve cards below are dead
      // code, so a stage that starts with an empty slot seeds one. Delete this
      // block the moment the barrel exists; `setEquipment` is the same call it
      // will make.
      if (!this.equipmentId) this.setEquipment(this.rollEquipment());
    });

    // Lunar cooldown items charge the player for casting, so they need to know
    // a cast happened. Player already announces every one of them on the bus —
    // adding a second, item-specific channel for the same fact is how two
    // systems end up disagreeing about what a "use" is.
    ctx.events.on('abilityUsed', (e) => this.onAbility(e || {}));

    // "How long since I was last hit" backs three items (Field Dressing, Siege
    // Battery, Mineral Lick). Tracked once here rather than each of them
    // keeping its own timer and each of them being subtly wrong about DoTs.
    ctx.events.on('playerHurt', () => { this._lastHurt = ctx.time; });

    // A client never rolls loot; it mirrors the host's inventory off the
    // replicated `itemPickup`, whose `count` is the new total and so is safe to
    // apply out of order or twice. Without this the HUD and the whole stat
    // block would sit at zero items for the entire run.
    ctx.events.on('itemPickup', (e) => {
      if (ctx.authority || !e || !ITEM_BY_ID.has(e.id)) return;
      this.counts.set(e.id, e.count);
      this._dirty = true;
      this._rebuildHooks();
      ctx.audio?.play?.('pickup');
    });

    // Same story for the purse. Gold is host-authoritative and appears in no
    // snapshot field, so a client mirrors the host's total off the forwarded
    // `goldChanged`. The payload is an absolute value, not a delta, so a
    // dropped or duplicated event self-corrects on the next one.
    ctx.events.on('goldChanged', (e) => {
      if (ctx.authority || !e || typeof e.gold !== 'number') return;
      this.gold = e.gold;
    });

    // Equipment mirrors the same pattern: the host decides what is in the slot,
    // the client adopts it so its HUD and its Q key describe the truth. The
    // client's own press still resolves nowhere (see `useEquipment`) — this is
    // display state, not permission.
    ctx.events.on('equipmentChanged', (e) => {
      if (ctx.authority || !e) return;
      this.equipmentId = e.id && EQUIPMENT_BY_ID.has(e.id) ? e.id : null;
      this.equipCharges = e.charges ?? 0;
      this.equipTimer = e.cooldown ?? 0;
    });

    this._rebuildHooks();
  }

  // -------------------------------------------------------------- inventory

  give(id, count = 1) {
    // Host only. Clients receive the result as `itemPickup` and apply it above.
    if (!this.ctx.authority) return this.count(id);
    if (!ITEM_BY_ID.has(id)) return 0;
    const next = (this.counts.get(id) || 0) + count;
    this.counts.set(id, next);
    this._dirty = true;
    this._rebuildHooks();
    this.ctx.events.emit('itemPickup', { id, count: next });
    this.ctx.audio?.play?.('pickup');
    return next;
  }

  count(id) { return this.counts.get(id) || 0; }

  /** [{ id, count, def }] sorted by tier then name — HUD renders this directly. */
  inventory() {
    const out = [];
    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      if (def) out.push({ id, count, def });
    }
    out.sort((a, b) => TIER_ORDER[a.def.tier] - TIER_ORDER[b.def.tier] || a.def.name.localeCompare(b.def.name));
    return out;
  }

  _rebuildHooks() {
    for (const k in this._hooks) this._hooks[k].length = 0;
    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      if (!def?.hooks || count <= 0) continue;
      for (const k in this._hooks) {
        if (def.hooks[k]) this._hooks[k].push({ def, count, fn: def.hooks[k] });
      }
    }
  }

  // ------------------------------------------------------------------- gold

  addGold(amount) {
    if (amount <= 0) return this.gold;
    this.gold += Math.round(amount);
    this.ctx.events.emit('goldChanged', { gold: this.gold });
    return this.gold;
  }

  /** Gold one monster death is worth. Pure — safe to call for a preview. */
  killReward(victim) {
    if (!victim || victim.isPlayer) return 0;
    const cost = victim.def?.cost ?? DEFAULT_KILL_COST;
    const eliteMult = victim.elite?.cost ?? 1;
    const bossMult = victim.isBoss ? BOSS_GOLD_MULT : 1;
    // The director's own coefficient, not Progression's, so the payout is the
    // exact inverse of the credits that bought this monster. (`ctx.difficulty`
    // used to be the fallback here; it is now the difficulty *selection* API,
    // and the director's coefficient — which is never absent — is the honest
    // single source anyway.)
    const d = Math.max(1, this.ctx.director?.difficultyCoefficient ?? 1);
    const gold = this.ctx.artifacts?.runMods?.().gold ?? 1;
    return Math.max(1, Math.round(cost * GOLD_PER_COST * eliteMult * bossMult * d * gold));
  }

  /**
   * Pay out a kill. Host only — gold is game state, and a client's purse comes
   * from its own host-authored events, never from a locally observed death.
   */
  rewardKill(victim) {
    if (!this.ctx.authority) return 0;
    // Sacrifice: the loot the stage no longer carries comes off the corpses.
    // The roll and the orb are both done here rather than in Artifacts —
    // Items owns the gameplay RNG draw and the drop table, and Artifacts only
    // answers what the odds are.
    const sacChance = this.ctx.artifacts?.sacrificeChance?.(victim) ?? 0;
    if (sacChance > 0 && this.ctx.rng.next() < sacChance) {
      const id = this.rollItem(null, 'small');
      if (id) this.ctx.interactables?.spawnOrb?.(victim.position, id, 1.4);
    }

    const amount = this.killReward(victim);
    if (amount <= 0) return 0;
    this.addGold(amount);
    this.ctx.events.emit('goldReward', { amount, victim, position: victim.position });
    return amount;
  }

  spendGold(amount) {
    if (this.gold < amount) return false;
    this.gold -= amount;
    this.ctx.events.emit('goldChanged', { gold: this.gold });
    return true;
  }

  // ------------------------------------------------------------------ stats

  /**
   * Returns the fully modified block. The returned object is owned by Items
   * and reused — treat it as read-only.
   */
  stats(base) {
    // Called every frame, so the guard has to be allocation-free: compare the
    // base block field by field rather than hashing it into a string.
    if (!this._dirty && this._cache && this._baseMatches(base)) return this._cache;

    const s = this._cache || (this._cache = {});
    this._rememberBase(base);
    s.maxHealth = base.maxHealth;
    s.healthRegen = base.healthRegen;
    s.moveSpeed = base.moveSpeed;
    s.attackSpeed = base.attackSpeed;
    s.damage = base.damage;
    s.critChance = base.critChance;
    s.critMult = base.critMult;
    s.armor = base.armor;
    s.cooldownMult = base.cooldownMult;
    s.jumpCount = base.jumpCount;
    // Extensions beyond the contract block; consumers treat missing as 0.
    s.blockChance = 0;
    s.flatReduction = 0;
    s.extraCharges = 0;
    s.luck = 0;
    // Star Chart. Folded into `roll()` rather than into each chance item, since
    // `roll` is the one gate all of them pass through.
    s.procBonus = 0;
    // Equipment recharge scale — Fuel Cell and friends write here as well as to
    // `cooldownMult`, so skill cooldowns and equipment cooldowns can be tuned
    // apart from each other.
    s.equipCooldownMult = 1;
    // Extra *equipment* presses banked, kept apart from `extraCharges` (which
    // is the survivor's skill charges) so one item cannot silently pay for both.
    s.equipCharges = 0;
    // Lunar drawback flag: Hollow Vow trades the whole defensive layer away.
    // Applied *after* every item has contributed, or the result would depend on
    // the order the inventory Map happens to iterate in.
    s.noDefensive = false;
    // Multiplicative accumulators, for the same order-independence reason. Item
    // `stat` functions add into `damage`/`maxHealth` and multiply into these.
    s.damageMult = 1;
    s.healthMult = 1;

    s.maxHealth += this.permanentHealth;

    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      if (def?.stat && count > 0) def.stat(count, s);
    }

    s.damage *= s.damageMult;
    s.maxHealth *= s.healthMult;

    // The run's own rules go on last, over the top of every item: Glass is a
    // multiplier on the finished number, and the difficulty's regen scale is
    // not something an item should be able to argue with. Before the clamps
    // below on purpose — the 20 HP floor is exactly what stops Glass reducing
    // an early survivor to a rounding error.
    const mods = this.ctx.artifacts?.runMods?.();
    if (mods) {
      s.damage *= mods.damage;
      s.maxHealth *= mods.health;
      s.healthRegen *= mods.regen;
    }

    // Buffs sit on top of items so a frenzy always feels like a burst rather
    // than being diluted by a big inventory.
    const frenzy = this.buffs.get('frenzy');
    if (frenzy) s.attackSpeed += frenzy.stacks * frenzy.magnitude;
    const berzerk = this.buffs.get('berzerk');
    if (berzerk) { s.attackSpeed += berzerk.magnitude; s.moveSpeed *= 1 + berzerk.magnitude; }
    // Bloodied Spurs — movement only, so it reads differently from a frenzy.
    const quickfoot = this.buffs.get('quickfoot');
    if (quickfoot) s.moveSpeed *= 1 + quickfoot.magnitude;
    // Scrap Bandolier — a short, hard cooldown cut on a kill.
    const quickhands = this.buffs.get('quickhands');
    if (quickhands) s.cooldownMult *= quickhands.magnitude;
    // Chronal Governor — a stacking cut that decays if the killing stops.
    const overclock = this.buffs.get('overclock');
    if (overclock) s.cooldownMult *= Math.max(0.15, 1 - overclock.stacks * overclock.magnitude);
    if (this.buffs.has('nocooldown')) s.cooldownMult = 0;

    if (s.noDefensive) { s.blockChance = 0; s.flatReduction = 0; }

    s.critChance = Math.min(s.critChance, 1);
    s.blockChance = Math.min(s.blockChance, 0.95);
    s.cooldownMult = Math.max(s.cooldownMult, 0.05);
    // A Lunar stack must never be able to reduce the survivor to a rounding
    // error: 1 HP with no regeneration is a crash, not a trade.
    s.maxHealth = Math.max(20, s.maxHealth);
    s.damage = Math.max(1, s.damage);
    s.equipCooldownMult = Math.max(0.15, s.equipCooldownMult);

    this._dirty = false;
    return s;
  }

  _baseMatches(base) {
    const p = this._base;
    for (let i = 0; i < BASE_KEYS.length; i++) {
      if (p[BASE_KEYS[i]] !== base[BASE_KEYS[i]]) return false;
    }
    return true;
  }

  _rememberBase(base) {
    for (let i = 0; i < BASE_KEYS.length; i++) this._base[BASE_KEYS[i]] = base[BASE_KEYS[i]];
  }

  baseDamage() { return this.ctx.player?.stats?.damage || 12; }

  addPermanentHealth(amount, cap) {
    if (this.permanentHealth >= cap) return;
    this.permanentHealth = Math.min(cap, this.permanentHealth + amount);
    this._dirty = true;
  }

  // ------------------------------------------------------------------ buffs

  addBuff(name, duration, maxStacks = 1, magnitude = 1) {
    let b = this.buffs.get(name);
    if (!b) { b = { stacks: 0, remaining: 0, magnitude }; this.buffs.set(name, b); }
    b.stacks = Math.min(maxStacks, b.stacks + 1);
    b.remaining = duration;
    b.magnitude = magnitude;
    this._dirty = true;
  }

  buffStacks(name) { return this.buffs.get(name)?.stacks || 0; }
  buffMagnitude(name) { return this.buffs.get(name)?.magnitude || 0; }

  /** Drop a buff outright. Siege Battery spends its whole bank on one hit. */
  clearBuff(name) {
    if (!this.buffs.delete(name)) return;
    this._dirty = true;
  }

  /** Seconds since the player last lost health. -1 never happened this run. */
  timeSinceHurt() { return this.ctx.time - this._lastHurt; }

  /**
   * Every-Nth counter, for items that fire on a beat rather than on a chance.
   * A separate mechanism from `roll` on purpose: a deterministic 8th hit is a
   * rhythm the player can feel and play around, which a 12.5% chance is not.
   */
  tally(key, every) {
    if (!this.ctx.authority) return false;
    const n = (this._tallies.get(key) || 0) + 1;
    if (n < every) { this._tallies.set(key, n); return false; }
    this._tallies.set(key, 0);
    return true;
  }

  /**
   * Hunter's Tag marks. Deliberately not a Combat status: the status table is
   * for things that tick and draw, and a pure outgoing-damage multiplier would
   * be paying a status slot plus its VFX for a number nobody sees.
   */
  mark(entity, seconds) {
    if (!entity || !this.ctx.authority) return;
    this._marks.set(entity, this.ctx.time + seconds);
  }

  isMarked(entity) {
    const until = this._marks.get(entity);
    return until !== undefined && until > this.ctx.time;
  }

  /**
   * A self-ticking timed effect — the shape every duration-based equipment
   * (drone, meteor storm, tesla crown) is built out of.
   *
   * Re-using the same key restarts it rather than running two copies, so
   * mashing a second charge of Sentry Drone extends the drone instead of
   * quietly doubling its DPS.
   */
  addEffect(key, duration, interval, fn) {
    const existing = this._effects.find((e) => e.key === key);
    if (existing) { existing.remaining = duration; existing.fn = fn; return existing; }
    const e = { key, remaining: duration, interval, t: 0, fn };
    this._effects.push(e);
    return e;
  }

  /** A lingering ground hazard. Spore Sac leaves one on every kill. */
  addCloud(position, radius, duration, dps) {
    if (!this.ctx.authority || !position) return;
    // Bounded, because a horde death can leave dozens in a second and each one
    // is an overlap query per fixed step.
    if (this._clouds.length >= MAX_CLOUDS) this._clouds.shift();
    // A real Vector3 clone, not a {x,y,z} literal: VFX and Combat both take
    // this straight into `copy`/`distanceTo`, and a bare object works for some
    // of those calls and not others.
    this._clouds.push({ at: position.clone(), radius, remaining: duration, dps, t: 0 });
  }

  addBarrier(amount) {
    const p = this.ctx.player;
    if (!p) return;
    // Barrier is a decaying overshield, capped so on-kill stacking can't turn
    // into permanent invulnerability during a horde.
    const cap = (p.stats?.maxHealth || 100) * 0.5;
    p.shield = Math.min(cap, (p.shield || 0) + amount);
  }

  cooldownReady(key, seconds) {
    const now = this.ctx.time;
    const until = this.cooldowns.get(key) || 0;
    if (now < until) return false;
    this.cooldowns.set(key, now + seconds);
    return true;
  }

  /** Berzerker-style windowed kill counting. True once the threshold is met. */
  tallyKillWindow(threshold, window) {
    const now = this.ctx.time;
    this._killWindow.push(now);
    while (this._killWindow.length && now - this._killWindow[0] > window) this._killWindow.shift();
    if (this._killWindow.length >= threshold) { this._killWindow.length = 0; return true; }
    return false;
  }

  applyImpulse(speed) { this._pendingImpulse = Math.max(this._pendingImpulse, speed); }
  consumeImpulse() { const v = this._pendingImpulse; this._pendingImpulse = 0; return v; }

  // -------------------------------------------------------------- equipment

  /**
   * The whole slot, as one read-only object. This is what the HUD renders and
   * it is deliberately a plain snapshot rather than a handle onto internals —
   * the UI must not be able to put the slot into a state gameplay disagrees
   * with. Returns `null` when nothing is equipped.
   *
   *   { id, def, ready, charges, maxCharges, cooldown, cooldownMax }
   *
   * `cooldown` counts *down* to the next charge; `cooldownMax` is the full
   * recharge for one charge, already scaled by Fuel Cell. Draw the sweep from
   * `equipmentFraction()` rather than dividing these yourself — it handles the
   * banked-charge case, where there is no meaningful fraction at all.
   */
  get equipment() {
    const def = EQUIPMENT_BY_ID.get(this.equipmentId);
    if (!def) return null;
    const max = this.equipmentMaxCharges();
    return {
      id: def.id,
      def,
      ready: this.equipCharges > 0,
      charges: this.equipCharges,
      maxCharges: max,
      cooldown: this.equipTimer,
      cooldownMax: this.equipmentCooldownMax(),
    };
  }

  /** Full recharge time for one charge, in seconds. */
  equipmentCooldownMax() {
    const def = EQUIPMENT_BY_ID.get(this.equipmentId);
    if (!def) return 0;
    const mult = this.ctx.player?.stats?.equipCooldownMult ?? 1;
    // Floored well above zero: an equipment that comes back instantly is a
    // fifth ability, and the tier's identity is that it is a decision.
    return Math.max(2, def.cooldown * mult);
  }

  equipmentMaxCharges() {
    if (!this.equipmentId) return 0;
    return 1 + Math.max(0, Math.round(this.ctx.player?.stats?.equipCharges || 0));
  }

  /**
   * 0..1 readiness, which is the only number a cooldown sweep needs. 1 means
   * "there is a charge banked, press it"; anything less is the fraction of the
   * next charge that has accrued.
   */
  equipmentFraction() {
    if (!this.equipmentId) return 0;
    if (this.equipCharges > 0) return 1;
    const max = this.equipmentCooldownMax();
    if (max <= 0) return 1;
    return Math.max(0, Math.min(1, 1 - this.equipTimer / max));
  }

  /**
   * Equip `id`, returning whatever was displaced so the caller can drop it back
   * into the world. Passing `null` clears the slot.
   *
   * Host only, like every other inventory mutation — clients adopt the result
   * off `equipmentChanged`. A fresh equipment arrives *charged*: making the
   * player wait a minute before the thing they just picked up does anything is
   * a punishment for engaging with the system.
   */
  setEquipment(id) {
    if (!this.ctx.authority) return this.equipmentId;
    const next = id && EQUIPMENT_BY_ID.has(id) ? id : null;
    const previous = this.equipmentId;
    if (next === previous) return null;
    this.equipmentId = next;
    this.equipCharges = next ? 1 : 0;
    this.equipTimer = 0;
    this.ctx.events.emit('equipmentChanged', {
      id: next, previous, charges: this.equipCharges, cooldown: 0,
    });
    if (next) this.ctx.audio?.play?.('pickup', null, 2);
    return previous;
  }

  /**
   * Fire the held equipment.
   *
   * Host only: an equipment use spends a charge, deals damage and rolls procs,
   * all of which are game state. A client pressing Q therefore does nothing
   * locally and does not desync — the honest gap is that, absent a protocol bit
   * for it, a client's press does not reach the host either. That is the same
   * shape as the interact path before it got `BTN.INTERACT`, and it is recorded
   * as a known limitation rather than papered over with a client-side effect
   * that would have to be retracted.
   *
   * A `use` that returns `false` (nothing in range, nowhere to blink) refunds
   * the charge. Burning a 60s cooldown on a mis-press with no feedback is the
   * single worst thing an active can do to a player.
   */
  useEquipment() {
    if (!this.ctx.authority) return false;
    const def = EQUIPMENT_BY_ID.get(this.equipmentId);
    if (!def || this.equipCharges <= 0) return false;

    const api = this._api;
    api.combat = this.ctx.combat;
    api.player = this.ctx.player;
    api.count = 1;
    api.procCoefficient = 1;
    api.procDepth = 1;
    if (!api.player?.alive) return false;

    let fired = false;
    try {
      fired = def.use(api) !== false;
    } catch (err) {
      // An equipment that throws must not take the frame with it, and must not
      // silently eat its cooldown either.
      console.error(`[items] equipment ${def.id} threw:`, err);
      return false;
    }
    if (!fired) return false;

    this.equipCharges--;
    // Only start the timer if it was not already running: charges recharge
    // sequentially, so spending two back to back must not reset the first one's
    // accumulated progress.
    if (this.equipTimer <= 0) this.equipTimer = this.equipmentCooldownMax();
    this.ctx.events.emit('equipmentUsed', { id: def.id, charges: this.equipCharges });
    return true;
  }

  // ------------------------------------------------------------------- luck
  /**
   * The single random gate for every chance-on-hit item. Proc coefficient
   * scales the chance linearly; luck (Clover) grants extra rolls, so a 25%
   * effect with 1 luck lands 43.75% of the time — favourable rerolls, never
   * a guarantee.
   */
  roll(chance, procCoefficient = 1) {
    // Every chance-on-hit decision is the host's; a client drawing here would
    // advance the shared gameplay stream and desync every later loot roll.
    if (!this.ctx.authority) return false;
    // Star Chart lifts every chance in the game at once, which is why it is
    // folded in here rather than into thirty separate `hyperbolic` calls.
    const bonus = 1 + (this.ctx.player?.stats?.procBonus || 0);
    const p = Math.min(1, chance * (procCoefficient ?? 1) * bonus);
    if (p <= 0) return false;
    const luck = Math.max(0, Math.floor(this.ctx.player?.stats?.luck || 0));
    for (let i = 0; i <= luck; i++) if (this.ctx.rng.next() < p) return true;
    return false;
  }

  // ------------------------------------------------------------ hook dispatch

  _fire(hook, payload, procCoefficient, procDepth) {
    const list = this._hooks[hook];
    if (!list.length) return;
    const api = this._api;
    api.combat = this.ctx.combat;
    api.player = this.ctx.player;
    api.procCoefficient = procCoefficient;
    api.procDepth = procDepth;
    for (let i = 0; i < list.length; i++) {
      api.count = list[i].count;
      list[i].fn(payload, api);
    }
  }

  onHit(e) { this._fire('onHit', e, e.procCoefficient ?? 1, e.procDepth ?? 1); }
  onKill(e) { this._fire('onKill', e, 1, e.procDepth ?? 1); }
  onDamaged(e) { this._fire('onDamaged', e, 1, e.procDepth ?? 1); }
  onJump(e) { this._fire('onJump', e || {}, 1, 1); }
  onAbility(e) { if (this.ctx.authority) this._fire('onAbility', e || {}, 1, 1); }

  /** Conditional damage multipliers. Called from Combat before mitigation. */
  modifyOutgoing(amount, target, info, combat) {
    const list = this._hooks.outgoing;
    if (!list.length) return amount;
    const api = this._api;
    api.combat = combat;
    api.player = this.ctx.player;
    api.procDepth = info.procDepth || 0;
    for (let i = 0; i < list.length; i++) {
      api.count = list[i].count;
      amount = list[i].fn(amount, target, info, api);
    }
    return amount;
  }

  // ------------------------------------------------------------- drop tables

  /**
   * Weighted tier roll.
   *
   * `bias` is a per-tier multiplier over `TIER_WEIGHTS`, which is the shape the
   * world already calls this with (`Interactables` passes its chest tables
   * through here). Naming a table from `DROP_TABLES` by string is the newer and
   * clearer form — `rollTier('large')` — and the two coexist because the world
   * files belong to another agent this round and must keep working untouched.
   *
   * Host only, like every other draw off the gameplay stream: a client that
   * asked gets the floor tier and never touches `ctx.rng`.
   */
  rollTier(bias = null) {
    if (!this.ctx.authority) return 'common';
    const table = typeof bias === 'string' ? DROP_TABLES[bias] : bias;
    // A named table *replaces* the ladder; an object multiplies it.
    const weights = typeof bias === 'string'
      ? (table || DROP_TABLES.small)
      : null;

    const entries = [];
    if (weights) {
      for (const tier in weights) {
        if (weights[tier] > 0) entries.push({ tier, weight: weights[tier] });
      }
    } else {
      for (const tier in TIER_WEIGHTS) {
        const w = TIER_WEIGHTS[tier] * (table?.[tier] ?? 1);
        if (w > 0) entries.push({ tier, weight: w });
      }
    }
    if (!entries.length) return 'common';
    return this.ctx.rng.weighted(entries).tier;
  }

  /**
   * Rolls a concrete item id. Pass a tier to skip the tier roll, or a
   * `DROP_TABLES` name as `bias` to roll inside one named pool.
   */
  rollItem(tier = null, bias = null) {
    if (!this.ctx.authority) return null;
    const art = this.ctx.artifacts;
    let t = tier || this.rollTier(bias);
    // Caprice replaces the *tier* first, so a small chest can pay a legendary.
    // It composes with Command rather than competing with it: Caprice decides
    // which shelf the drop comes off, Command decides what is taken from it.
    if (art?.has('caprice')) t = art.capriceTier();
    const pool = ITEMS_BY_TIER[t] || ITEMS_BY_TIER.common;
    if (!pool.length) return null;
    // Command: this is the single funnel every random item id in the game comes
    // out of, which is why the choice is installed here and not in the six
    // callers that would otherwise each need to know about it.
    if (art?.has('command')) return art.commandPick(t, pool);
    return this.ctx.rng.pick(pool).id;
  }

  /** One equipment id off the equipment pool — what a barrel hands out. */
  rollEquipment() {
    if (!this.ctx.authority) return null;
    return this.ctx.rng.pick(EQUIPMENT).id;
  }

  /**
   * Convenience for the world: roll a drop and put it straight in the slot or
   * the inventory, whichever the id belongs to. This is what an equipment
   * barrel calls, and it is here rather than in the barrel so that "equipment
   * replaces, items accumulate" is stated once.
   */
  grant(id) {
    if (!this.ctx.authority || !id) return null;
    if (EQUIPMENT_BY_ID.has(id)) return this.setEquipment(id);
    return this.give(id, 1);
  }

  // ------------------------------------------------------------------ update

  fixedUpdate(ctx, h) {
    for (const [name, b] of this.buffs) {
      b.remaining -= h;
      if (b.remaining <= 0) { this.buffs.delete(name); this._dirty = true; }
    }

    // Barrier decays so it reads as a temporary reward, not a second health bar.
    const p = ctx.player;
    if (p && p.shield > 0) {
      p.shield = Math.max(0, p.shield - (p.stats?.maxHealth || 100) * 0.05 * h);
    }

    if (this._hooks.onInterval.length) {
      this._intervalPayload.dt = h;
      this._fire('onInterval', this._intervalPayload, 1, 1);
    }

    this._tickEquipment(h);
    this._tickEffects(ctx, h);
    this._tickClouds(ctx, h);
    this._sweepMarks(ctx, h);
  }

  /**
   * Recharge one equipment charge at a time.
   *
   * Sequential rather than parallel on purpose: with three charges banked and a
   * parallel timer, Fuel Cell would refill the whole bank in one cooldown and
   * the slot would stop being a resource at all.
   */
  _tickEquipment(h) {
    if (!this.equipmentId) return;
    if (this.equipCharges >= this.equipmentMaxCharges()) { this.equipTimer = 0; return; }
    if (this.equipTimer <= 0) this.equipTimer = this.equipmentCooldownMax();
    this.equipTimer -= h;
    if (this.equipTimer > 0) return;
    this.equipCharges++;
    this.equipTimer = this.equipCharges < this.equipmentMaxCharges()
      ? this.equipmentCooldownMax() : 0;
    this.ctx.audio?.play?.('coin');
  }

  /** Timed equipment effects (drone, meteor storm, crown). */
  _tickEffects(ctx, h) {
    if (!this._effects.length) return;
    const api = this._api;
    api.combat = ctx.combat;
    api.player = ctx.player;
    api.count = 1;
    api.procCoefficient = 1;
    api.procDepth = 1;
    for (let i = this._effects.length - 1; i >= 0; i--) {
      const e = this._effects[i];
      e.remaining -= h;
      e.t -= h;
      if (e.t <= 0 && ctx.player?.alive) {
        e.t = e.interval;
        try { e.fn(api); } catch (err) { console.error(`[items] effect ${e.key} threw:`, err); e.remaining = 0; }
      }
      if (e.remaining > 0) continue;
      this._effects[i] = this._effects[this._effects.length - 1];
      this._effects.pop();
    }
  }

  /** Lingering hazards (Spore Sac). */
  _tickClouds(ctx, h) {
    if (!this._clouds.length) return;
    const combat = ctx.combat;
    for (let i = this._clouds.length - 1; i >= 0; i--) {
      const c = this._clouds[i];
      c.remaining -= h;
      c.t -= h;
      if (c.t <= 0) {
        c.t = CLOUD_TICK;
        const n = combat.sphereOverlap(c.at, c.radius, 'player');
        // Copy before damaging: applyDamage can proc something that overlaps
        // again and rewrites the buffer under us.
        const targets = [];
        for (let k = 0; k < n; k++) targets.push(combat.overlapAt(k));
        for (const t of targets) {
          combat.applyDamage(t, this.baseDamage() * c.dps * CLOUD_TICK, {
            source: ctx.player, position: t.position, type: 'spore',
            procCoefficient: 0, procDepth: 2, isDot: true,
          });
        }
        // Purely cosmetic — never draws off `ctx.rng`, so it cannot desync.
        ctx.vfx?.ring?.(c.at, c.radius, 0x9fdc6a);
      }
      if (c.remaining > 0) continue;
      this._clouds[i] = this._clouds[this._clouds.length - 1];
      this._clouds.pop();
    }
  }

  /**
   * Drop expired marks. Swept on a timer rather than per-hit because the Map is
   * keyed by entity and a dead monster would otherwise be retained by it for
   * the rest of the run — a leak measured in hordes, not in bytes.
   */
  _sweepMarks(ctx, h) {
    if (!this._marks.size) return;
    this._markSweep -= h;
    if (this._markSweep > 0) return;
    this._markSweep = 2;
    for (const [entity, until] of this._marks) {
      if (until <= ctx.time || !entity.alive) this._marks.delete(entity);
    }
  }

  /**
   * Equipment activation.
   *
   * Read here rather than in Player because the slot is Items' state: routing
   * it through the survivor would mean two systems owning one press, and the
   * survivor is being replaced this round anyway. `update` rather than
   * `fixedUpdate` so a press is never swallowed by a frame that ran zero fixed
   * steps.
   */
  update(ctx) {
    if (ctx.paused) return;
    if (ctx.input?.hit?.(EQUIP_KEY)) this.useEquipment();
  }
}

// Inventory sort order. Lunar sits after Boss because it is the tier the player
// chose to take a downside for, and it should read last rather than be buried
// among the whites.
const TIER_ORDER = { common: 0, uncommon: 1, legendary: 2, boss: 3, lunar: 4, equipment: 5 };
const BASE_KEYS = ['maxHealth', 'healthRegen', 'moveSpeed', 'attackSpeed', 'damage',
  'critChance', 'critMult', 'armor', 'cooldownMult', 'jumpCount'];

/**
 * Equipment keybind. One constant so the HUD can print the same letter the
 * system listens for.
 *
 * **Not Q**, which is what the genre trained everyone to expect: this game
 * already binds Q to the utility skill (`Player.js` — `input.down('KeyQ')`
 * sets `BTN.UTILITY`) and Shift to sprint, so the RoR2 layout is not available.
 * F is the next unclaimed key that is still under the movement hand.
 */
const EQUIP_KEY = 'KeyF';
export const EQUIPMENT_KEY_LABEL = 'F';

// Spore Sac clouds: how often one resolves, and how many may exist at once.
// Each tick is a sphere overlap, so an unbounded list is a horde-wipe turning
// into a frame spike.
const CLOUD_TICK = 0.5;
const MAX_CLOUDS = 12;

export { ITEMS, ITEM_BY_ID, TIERS, hyperbolic, EQUIPMENT, EQUIPMENT_BY_ID };
