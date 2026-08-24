// src/systems/Corruption.js
import { bandOf, isVoidtouched, SOURCES, VOIDTOUCHED } from '../data/corruption.js';
import { MOTE, marksMinted, motesMinted, wardedProgress } from '../data/bandBoons.js';
import { ITEM_BY_ID } from '../data/items.js';

/**
 * The run's second economy. Corruption rises only through choices — chest
 * tithes, void credit, item pickups, greed time — and never passively. This
 * system owns the numbers and the band events; what the world *does* about
 * them (blight visuals, Voidtouched spawns, route gates) belongs to the
 * systems that listen.
 *
 * Host-authoritative like every other state change: `feed` is a no-op off the
 * host, and a client learns the whole world economy through `applyNetState`
 * (issue #167) — which is the one writer off the host, and refuses to run on
 * one.
 * Deliberately consumes NO ctx.rng draws — there is nothing to roll here, and
 * staying off the shared stream is what keeps sp-equivalence green.
 */
const MAX_SEEDS = 64;

export class Corruption {
  // The run's second economy, host-authoritative. A throw mid-`feed` leaves the
  // world value and the band it is supposed to have crossed disagreeing.
  static critical = true;

  constructor() {
    this._byPlayer = new Map();   // player entity -> corruption
    this._world = 0;
    this._band = 0;
    this._greed = false;
    this.seeds = [];              // { x, z, strength }, oldest first
    // The band upsides' currency (issue #36). `_peak` is the deepest this run
    // has *ever* been, and it only climbs: marks are minted by having gone
    // there, so a font can buy the gauge back down without refunding what the
    // descent already paid for. `_spent` is the other half of that honesty —
    // bleeding cannot un-spend a mark either.
    this._peak = 0;
    this._spent = 0;
    // Consumed's one-way door (data/bandBoons.js RUIN). Set by `ruin()`, never
    // cleared, and read by the Argent Font: once the void has been let all the
    // way in, cleansing is not expensive, it is over.
    this.ruined = false;
    // Purity's side of the same economy (data/bandBoons.js MOTE). `_warded` is
    // every point of corruption a player's own hand has taken back out — which
    // is every point `bleed` has ever removed, because nothing decays: there is
    // no passive path in, only acts (a Voidtouched kill, an Argent Font press,
    // `chime-of-absolution`'s per-kill ward inside a Sanctuary). The identity is
    // "whatever `bleed` took", not a list of callers, which is why the count
    // this comment used to give went stale the moment a third one appeared.
    // Monotonic like `_peak`, and for the same reason: a mote is minted by
    // having done the work, and feeding the void again does not un-do it.
    this._warded = 0;
    this._motesSpent = 0;
    // The open sanctuary window, in seconds. Zero for every run that never
    // wards, which is what keeps `update` and `priceOf` inert by default.
    this._sanctuaryT = 0;
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
  /** Is looting currently on greed time? Read by the prompt price tags. */
  get greed() { return this._greed; }
  corruptionOf(player) { return this._byPlayer.get(player) || 0; }

  /** The deepest this run has been. Monotonic — the mint reads it, not `world`. */
  get peak() { return this._peak; }

  /** Void marks in hand: what the descent minted, less what has been spent. */
  get marks() { return Math.max(0, marksMinted(this._peak) - this._spent); }

  /** Corruption this run's players have taken back out by hand. Monotonic. */
  get warded() { return this._warded; }

  /** Argent motes in hand: what the warding minted, less what has been spent. */
  get motes() { return Math.max(0, motesMinted(this._warded) - this._motesSpent); }

  /** Is a sanctuary window open? Read by `priceOf` and by anything that renders it. */
  get sanctified() { return this._sanctuaryT > 0; }

  /**
   * Spend `n` motes, all or nothing — `spendMarks` in the other currency, with
   * the same authority gate and the same reason for it.
   */
  spendMotes(n) {
    if (!this.ctx?.authority || !(n > 0) || this.motes < n) return false;
    this._motesSpent += n;
    this.ctx.events.emit('argentMotesChanged', { motes: this.motes, spent: n });
    return true;
  }

  /**
   * Open the sanctuary window — purity's bargain. The mote is spent by the
   * caller (the altar), because the price is a property of the offer and the
   * window is a property of the world, the same split `ruin()` uses.
   *
   * Re-opening while a window is already up *replaces* rather than extends it,
   * so two motes spent back to back are two windows and not twenty-four
   * seconds of one. That is deliberate: the decision this is meant to create is
   * about *when*, and a stacking window would turn it into "spend everything".
   */
  sanctuary(seconds = MOTE.sanctuarySeconds) {
    if (!this.ctx?.authority || !(seconds > 0)) return false;
    this._sanctuaryT = seconds;
    this.ctx.events.emit('voidSanctuary', { seconds, world: this._world, greed: this._greed });
    return true;
  }

  /**
   * The sanctuary clock. The only reason this class has an `update` at all, and
   * it is a no-op — not a cheap branch, an actual early return — for every run
   * that has never warded, which is what keeps a pristine run byte-identical to
   * the run it was before this existed. No `ctx.rng` draw is taken here or
   * anywhere else in this file.
   */
  update(ctx, dt) {
    if (this._sanctuaryT <= 0) return;
    this._sanctuaryT -= dt;
    if (this._sanctuaryT <= 0) {
      this._sanctuaryT = 0;
      this.ctx.events.emit('voidSanctuaryEnd', { world: this._world });
    }
  }

  /**
   * Spend `n` marks, all or nothing. Authority-gated like every other state
   * change here, so a client's press resolves on the host at the host's purse
   * rather than half-charging two ledgers.
   */
  spendMarks(n) {
    if (!this.ctx?.authority || !(n > 0) || this.marks < n) return false;
    this._spent += n;
    this.ctx.events.emit('voidMarksChanged', { marks: this.marks, spent: n });
    return true;
  }

  /**
   * Let the void all the way in — Consumed's last-chance state, and the only
   * irreversible thing in this system. The band gate lives in the caller
   * (`VoidBargain`), because the band is a property of the world and the door
   * is a property of the run.
   */
  ruin() {
    if (!this.ctx?.authority || this.ruined) return false;
    this.ruined = true;
    this.ctx.events.emit('voidRuin', { world: this._world, band: this._band });
    return true;
  }

  /**
   * What `feed` would add for a face-value `amount` right now — greed time and
   * the artifact economy folded in. Pure: it moves nothing.
   *
   * It exists so a prompt can quote the price it is about to charge (issue
   * #30) without restating the formula. `feed` runs through the same
   * expression, so the number on the screen and the number in the ledger
   * cannot drift apart the way two copies of an arithmetic would.
   */
  priceOf(amount) {
    if (!(amount > 0)) return 0;
    // Sanctuary (data/bandBoons.js MOTE): inside the window the void takes
    // nothing. It lives here rather than in `feed` precisely so the prompts
    // quote it too — `pricedPrompt` reads this same expression, so a player
    // standing in a sanctuary sees every chest re-price itself to +0 before
    // they press, which is the entire point of having bought the window.
    if (this._sanctuaryT > 0) return 0;
    const mult = this.ctx?.artifacts?.corruptionMods?.().feed ?? 1;
    return (this._greed ? amount * SOURCES.greedMult : amount) * mult;
  }

  /**
   * Add corruption, attributed to `player`. Returns the amount actually added
   * (after the greed multiplier), 0 when refused. `position` is advisory —
   * callers that mark a place also call `seed()`; feed itself plants nothing.
   */
  feed(player, amount, position = null) {
    if (!this.ctx?.authority) return 0;
    if (!player || !(amount > 0)) return 0;   // rejects 0, negatives and NaN in one test
    // The artifact economy question (data/artifacts.js: the Maw, Atonement)
    // and greed time both live in `priceOf`, which is also what the prompts
    // quote — one expression, so the quote and the charge agree by construction.
    const added = this.priceOf(amount);
    this._byPlayer.set(player, (this._byPlayer.get(player) || 0) + added);
    this._world += added;
    // The mark mint (issue #36) rides the same line the debt does, so a feed
    // and the currency it earns cannot disagree — and it is a high-water mark,
    // which is the whole reason the upsides survive a cleansing.
    if (this._world > this._peak) {
      const before = this.marks;
      this._peak = this._world;
      if (this.marks !== before) this.ctx.events.emit('voidMarksChanged', { marks: this.marks, spent: 0 });
    }
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
    // Warding rides `taken`, never the amount asked for: a bleed clamps to what
    // exists, and minting off the request would pay a mote for scrubbing a
    // world that was already clean.
    const motesBefore = this.motes;
    this._warded += taken;
    const minted = this.motes !== motesBefore;
    if (minted) {
      this.ctx.events.emit('argentMotesChanged', { motes: this.motes, spent: 0 });
    }
    // Purity's verb, announced at the instant it happens (issue #154). The mote
    // channel above only speaks once every forty points, which is why a player
    // could ward all run and see nothing until a toast arrived unattached to any
    // act. This fires on *every* bleed, carries the partial progress, and names
    // who did it — so the world cue lands on the hand that earned it and the
    // gauge can fill toward a mote instead of jumping to one.
    //
    // Emitted here rather than at the call sites on purpose: coverage is then a
    // property of `bleed` and not of a caller list that can grow behind it —
    // `chime-of-absolution` is already a third caller past the two named above.
    this.ctx.events.emit('corruptionWarded', {
      player, amount: taken, warded: this._warded,
      progress: wardedProgress(this._warded), motes: this.motes, minted,
    });
    const prev = this._band;
    this._band = bandOf(this._world);
    this.ctx.events.emit('corruptionChanged', { world: this._world, band: this._band });
    if (this._band !== prev) this.ctx.events.emit('corruptionBand', { band: this._band, prev });
    return taken;
  }

  /**
   * The world-level economy as the wire carries it (issue #167). Host-side
   * read; `Protocol.writeWorld` is the only caller.
   *
   * The mints cross, not the derived purses: `marks` and `motes` are computed
   * from `_peak`/`_warded` at both ends by the same functions, so the two
   * machines cannot hold different arithmetic about the same descent.
   */
  netState() {
    return {
      world: this._world, band: this._band, peak: this._peak, spent: this._spent,
      warded: this._warded, motesSpent: this._motesSpent,
      sanctuaryT: this._sanctuaryT, ruined: this.ruined, greed: this._greed,
    };
  }

  /**
   * Adopt the host's world economy (issue #167). The *only* path that writes
   * this state off the host, and it is the mirror image of every other mutator
   * here: `feed`, `bleed`, `spendMarks`, `spendMotes`, `sanctuary`, `ruin` and
   * `seed` all refuse without `ctx.authority`, and this one refuses *with* it.
   * There is therefore no build in which a machine both simulates this economy
   * and accepts somebody's word for it — a client is a replica, a host is not
   * writable from the wire, and a hostile peer has nothing to send.
   *
   * The client's instance stays the same object every consumer already reads:
   * the HUD gauge, the prompt prices through `priceOf`, the Argent grace in
   * `items.js`, the Codex gates and the route forecast all keep their single
   * accessor and are correct on both sides by construction rather than by each
   * of them learning a second read path.
   *
   * Emits only on genuine change, and emits the same events the authoritative
   * mutators do, so a joiner's HUD, toasts and `Progression.corruptionPeakBand`
   * build themselves from the replica exactly as they would from a live run.
   */
  applyNetState(s) {
    if (this.ctx?.authority || !s) return false;
    const prevBand = this._band;
    const prevMarks = this.marks;
    const prevMotes = this.motes;
    const prevWorld = this._world;
    const prevSanct = this._sanctuaryT > 0;
    const prevRuined = this.ruined;
    const prevWarded = this._warded;

    this._world = s.world;
    this._peak = s.peak;
    this._spent = s.spent;
    this._warded = s.warded;
    this._motesSpent = s.motesSpent;
    this._sanctuaryT = s.sanctuaryT;
    this._greed = s.greed;
    // One-way, exactly as on the host: a message that somehow arrived with the
    // door shut cannot re-open it.
    if (s.ruined) this.ruined = true;
    this._band = s.band;

    const ev = this.ctx?.events;
    if (!ev) return true;
    if (this._warded !== prevWarded) {
      ev.emit('corruptionWarded', {
        player: null, amount: this._warded - prevWarded, warded: this._warded,
        progress: wardedProgress(this._warded), motes: this.motes,
        minted: this.motes !== prevMotes,
      });
    }
    if (this.marks !== prevMarks) ev.emit('voidMarksChanged', { marks: this.marks, spent: 0 });
    if (this.motes !== prevMotes) ev.emit('argentMotesChanged', { motes: this.motes, spent: 0 });
    if (this.sanctified && !prevSanct) {
      ev.emit('voidSanctuary', { seconds: this._sanctuaryT, world: this._world, greed: this._greed });
    } else if (!this.sanctified && prevSanct) {
      ev.emit('voidSanctuaryEnd', { world: this._world });
    }
    if (this.ruined && !prevRuined) ev.emit('voidRuin', { world: this._world, band: this._band });
    if (this._world !== prevWorld || this._band !== prevBand) {
      ev.emit('corruptionChanged', { world: this._world, band: this._band });
    }
    if (this._band !== prevBand) ev.emit('corruptionBand', { band: this._band, prev: prevBand });
    return true;
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
