// src/systems/Corruption.js
import { bandOf, isVoidtouched, SOURCES, VOIDTOUCHED } from '../data/corruption.js';
import { ITEM_BY_ID } from '../data/items.js';

/**
 * The run's second economy. Corruption rises only through choices — chest
 * tithes, void credit, item pickups, greed time — and never passively. This
 * system owns the numbers and the band events; what the world *does* about
 * them (blight visuals, Voidtouched spawns, route gates) belongs to the
 * systems that listen.
 *
 * Host-authoritative like every other state change: `feed` is a no-op off the
 * host, and clients will learn the world value from replication (later plan).
 * Deliberately consumes NO ctx.rng draws — there is nothing to roll here, and
 * staying off the shared stream is what keeps sp-equivalence green.
 */
const MAX_SEEDS = 64;

export class Corruption {
  constructor() {
    this._byPlayer = new Map();   // player entity -> corruption
    this._world = 0;
    this._band = 0;
    this._greed = false;
    this.seeds = [];              // { x, z, strength }, oldest first
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.corruption = this;
    // Greed time: looting after the teleporter has finished is the one
    // passive-looking source, and it is still a choice — leaving is free.
    ctx.events.on('teleporterComplete', () => { this._greed = true; });
    ctx.events.on('stageStart', () => { this._greed = false; });
    // Items feed by tier. Riding the event rather than patching Items keeps
    // the systems decoupled (CONTRACTS.md) and means blight transforms, chest
    // bursts and shop buys all pay without knowing corruption exists. `feed`
    // is authority-gated, so the same event firing on a client is inert.
    // `count` on the wire is the absolute new stack total (Items.js:_set), not
    // a pickup delta — feeding by it would double-count every restack and even
    // reward removals. `delta` carries the actual change; mirror the same
    // fix Audio.js already needed for this event. Fall back to treating
    // `count` as the delta only when a payload omits `delta` entirely (older
    // synthetic/CONTRACTS.md-shaped events).
    //
    // `reason: 'corrupt'` is the blight transform re-stacking copies the player
    // already owns, and it is not a pickup: taking the blight card emitted its
    // own 'give' at the blight tier — the full, highest price in the table —
    // and the base stacks were charged at their own tier when they arrived.
    // Feeding the re-stack too would bill a five-syringe stack a second time at
    // 8 each, an unprompted 40-point spike the player never chose. A later,
    // genuine pickup of another copy of the same blight card still arrives as
    // 'give' and still pays.
    //
    // Not owner-*filtered* — owner-*attributed*. Corruption is the world's
    // number and every hand that takes loot raises it, so a teammate's pickup
    // still feeds; what `owner` decides is whose ledger the greed is written
    // against (`corruptionOf`), the same rule the void-credit charge follows.
    // An untagged payload still means the local player, so single-player is the
    // call it always was.
    ctx.events.on('itemPickup', ({ id, count = 1, delta, reason, owner }) => {
      if (reason === 'corrupt') return;
      const change = delta === undefined ? count : delta;
      if (!(change > 0)) return;
      const tier = ITEM_BY_ID.get(id)?.tier;
      this.feed(owner || ctx.player, (SOURCES.itemFeed[tier] ?? 1) * change);
    });
    // Counterplay: a Voidtouched kill bleeds a fraction of the world's
    // corruption back to whoever landed it. Riding the kill event keeps
    // Combat ignorant of corruption — the same one-way rule as every feed.
    ctx.events.on('kill', ({ victim, source }) => {
      if (!isVoidtouched(victim)) return;
      const player = source && source.isPlayer ? source : ctx.player;
      const refund = this.ctx.artifacts?.corruptionMods?.().refund ?? 1;
      this.bleed(player, this._world * VOIDTOUCHED.refund * refund);
    });
  }

  get world() { return this._world; }
  get band() { return this._band; }
  corruptionOf(player) { return this._byPlayer.get(player) || 0; }

  /**
   * Add corruption, attributed to `player`. Returns the amount actually added
   * (after the greed multiplier), 0 when refused. `position` is advisory —
   * callers that mark a place also call `seed()`; feed itself plants nothing.
   */
  feed(player, amount, position = null) {
    if (!this.ctx?.authority) return 0;
    if (!player || !(amount > 0)) return 0;   // rejects 0, negatives and NaN in one test
    // The artifact economy question (data/artifacts.js: the Maw, Atonement).
    // Optional-chained: a fixture without an artifacts system pays face value.
    const mult = this.ctx.artifacts?.corruptionMods?.().feed ?? 1;
    const added = (this._greed ? amount * SOURCES.greedMult : amount) * mult;
    this._byPlayer.set(player, (this._byPlayer.get(player) || 0) + added);
    this._world += added;
    const prev = this._band;
    this._band = bandOf(this._world);
    this.ctx.events.emit('corruptionChanged', { world: this._world, band: this._band });
    if (this._band !== prev) this.ctx.events.emit('corruptionBand', { band: this._band, prev });
    return added;
  }

  /**
   * Remove corruption, attributed to `player` — the counterplay valve
   * (Voidtouched kills, the Argent Font). Clamped to what exists; band events
   * fire on the way down exactly as they do on the way up, which is what lets
   * the HUD gauge, the grade pass and the route gate all walk back without
   * knowing why.
   *
   * The ledgers stay reconciled with the world: `Σ _byPlayer === world` after
   * any bleed. The payer's own row pays first — cleaning up after yourself
   * clears your name before anyone else's — and whatever is left over is
   * spread across the other rows pro-rata to what they still hold. That is the
   * founding identity of the design spec ("world corruption is the sum of
   * per-player corruption"), and without it a low-attribution payer at a font
   * could buy the gauge down while the sinner's row stayed full, leaving the
   * pact shrine and any future per-player HUD trading on stale numbers.
   *
   * This deliberately changes Voidtouched-refund attribution too: a refund is
   * a fraction of the *world*, so it now genuinely relieves the whole party's
   * ledgers rather than only the killer's. Intended — the killer already banks
   * the whole world-side drop; the ledger side follows the same world.
   */
  bleed(player, amount) {
    if (!this.ctx?.authority || !(amount > 0)) return 0;
    const taken = Math.min(this._world, amount);
    if (!(taken > 0)) return 0;
    let rest = taken;
    if (player) {
      const own = this._byPlayer.get(player) || 0;
      const paid = Math.min(own, taken);
      this._byPlayer.set(player, own - paid);
      rest -= paid;
    }
    if (rest > 0) this._spread(player, rest);
    this._world -= taken;
    const prev = this._band;
    this._band = bandOf(this._world);
    this.ctx.events.emit('corruptionChanged', { world: this._world, band: this._band });
    if (this._band !== prev) this.ctx.events.emit('corruptionBand', { band: this._band, prev });
    return taken;
  }

  /**
   * Debit `rest` from every ledger except `payer`, pro-rata to what each still
   * holds. Largest row first, and it absorbs the float residual, so the sum of
   * the cuts is exactly `rest` and no row can be driven negative.
   */
  _spread(payer, rest) {
    const rows = [];
    let pool = 0;
    for (const [p, v] of this._byPlayer) {
      if (p === payer || !(v > 0)) continue;
      rows.push([p, v]);
      pool += v;
    }
    if (!(pool > 0)) return;
    rows.sort((a, b) => b[1] - a[1]);
    const total = Math.min(rest, pool);
    let cut = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const [p, v] = rows[i];
      // The largest row (i === 0) takes whatever the divisions left behind.
      const c = i === 0 ? Math.min(v, total - cut) : Math.min(v, (total * v) / pool);
      this._byPlayer.set(p, v - c);
      cut += c;
    }
  }

  /**
   * Move attribution from one player's ledger to another's — the pact shrine's
   * mechanism. World corruption and the band are deliberately untouched: a
   * pact re-attributes blame ahead of a route lock, it does not absolve the
   * party. Returns the amount actually moved, 0 when refused.
   */
  transfer(from, to, amount) {
    if (!this.ctx?.authority) return 0;
    // Both parties must be players: a ledger row belongs to a survivor, and an
    // enemy or a prop holding corruption would never be read back by anything.
    if (!from?.isPlayer || !to?.isPlayer || from === to || !(amount > 0)) return 0;
    const own = this._byPlayer.get(from) || 0;
    const moved = Math.min(own, amount);
    if (!(moved > 0)) return 0;
    this._byPlayer.set(from, own - moved);
    this._byPlayer.set(to, (this._byPlayer.get(to) || 0) + moved);
    this.ctx.events.emit('corruptionPact', { from, to, amount: moved });
    return moved;
  }

  /**
   * Record where greed happened. The blight-visuals plan grows fields from
   * these, and the Director surfaces Voidtouched from them. Greed time cuts
   * deeper: the same act after the teleporter has finished leaves a stronger
   * mark, mirroring what `feed` already does to the price.
   */
  seed(position, strength = 1) {
    if (!this.ctx?.authority || !position) return;
    const s = { x: position.x, z: position.z, strength: strength + (this._greed ? 1 : 0) };
    this.seeds.push(s);
    if (this.seeds.length > MAX_SEEDS) this.seeds.shift();
    this.ctx.events.emit('blightSeed', s);
  }
}
