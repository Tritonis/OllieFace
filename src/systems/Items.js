import { ITEMS, ITEM_BY_ID, ITEMS_BY_TIER, TIERS, hyperbolic } from '../data/items.js';

/**
 * Items owns the inventory, the stat pipeline and the item hook dispatch.
 *
 * `stats(base)` is called every frame by the player, so the whole modified
 * block is cached and only rebuilt when something that feeds it changes:
 * inventory, buffs, permanent health. Everything else in gameplay code reads
 * the block instead of counting items, which keeps every stacking rule here.
 */

const TIER_WEIGHTS = { common: 80, uncommon: 20, legendary: 1 };

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
    this._hooks = { onHit: [], onKill: [], onDamaged: [], onJump: [], onInterval: [], outgoing: [] };
    this._api = null;

    this._killWindow = [];
    this._intervalPayload = { dt: 0 };
    this._pendingImpulse = 0;
    this._barrier = 0;
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
    ctx.events.on('stageStart', () => { this.cooldowns.clear(); });

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

    s.maxHealth += this.permanentHealth;

    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      if (def?.stat && count > 0) def.stat(count, s);
    }

    // Buffs sit on top of items so a frenzy always feels like a burst rather
    // than being diluted by a big inventory.
    const frenzy = this.buffs.get('frenzy');
    if (frenzy) s.attackSpeed += frenzy.stacks * frenzy.magnitude;
    const berzerk = this.buffs.get('berzerk');
    if (berzerk) { s.attackSpeed += berzerk.magnitude; s.moveSpeed *= 1 + berzerk.magnitude; }
    if (this.buffs.has('nocooldown')) s.cooldownMult = 0;

    s.critChance = Math.min(s.critChance, 1);
    s.blockChance = Math.min(s.blockChance, 0.95);
    s.cooldownMult = Math.max(s.cooldownMult, 0.05);

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
    const p = Math.min(1, chance * (procCoefficient ?? 1));
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
   * Weighted tier roll. `bias` scales a tier's weight (chests pay for luck).
   * Host only, like every other draw off the gameplay stream — a client that
   * asked gets the floor tier and never touches `ctx.rng`.
   */
  rollTier(bias = null) {
    if (!this.ctx.authority) return 'common';
    const entries = [];
    for (const tier in TIER_WEIGHTS) {
      const w = TIER_WEIGHTS[tier] * (bias?.[tier] ?? 1);
      if (w > 0) entries.push({ tier, weight: w });
    }
    return this.ctx.rng.weighted(entries).tier;
  }

  /** Rolls a concrete item id. Pass a tier to skip the tier roll. */
  rollItem(tier = null, bias = null) {
    if (!this.ctx.authority) return null;
    const t = tier || this.rollTier(bias);
    const pool = ITEMS_BY_TIER[t] || ITEMS_BY_TIER.common;
    return this.ctx.rng.pick(pool).id;
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
  }
}

const TIER_ORDER = { common: 0, uncommon: 1, legendary: 2, boss: 3 };
const BASE_KEYS = ['maxHealth', 'healthRegen', 'moveSpeed', 'attackSpeed', 'damage',
  'critChance', 'critMult', 'armor', 'cooldownMult', 'jumpCount'];

export { ITEMS, ITEM_BY_ID, TIERS, hyperbolic };
