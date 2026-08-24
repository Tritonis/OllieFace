import { ITEMS, ITEM_BY_ID, ITEMS_BY_TIER, TIERS, BLIGHT_BY_BASE, hyperbolic, blightGrace } from '../data/items.js';
import { SYNERGY_BY_ID } from '../data/bandBoons.js';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment.js';
import { MUTATION, VOIDTOUCHED, isVoidtouched } from '../data/corruption.js';
import { saltedSeed } from '../data/rngSalt.js';
import { RNG } from '../core/MathUtil.js';

/**
 * A blight card's own effect text at a given stack size, for the toll's choice
 * card and its announcement (issue #33): the loss has to read as a
 * transformation into something with a use, and only the catalogue knows what
 * that use is. Catalogue descriptions are functions of stack size and are
 * authored data, so a throwing one degrades to silence rather than taking the
 * fixed step down with it — the same contract `ui/Tooltip.js` keeps.
 */
export function describeBlight(def, count) {
  if (typeof def?.description !== 'function') return typeof def?.description === 'string' ? def.description : '';
  try { return String(def.description(Math.max(1, count | 0))); } catch { return ''; }
}

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
  // Small chest / wager shrine: the default ladder.
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
  // The corruption pool on its own, for anything that wants to hand one out
  // deliberately rather than wait for the share below to land.
  blight: { blight: 1 },
};

/**
 * Blight's cut of every ordinary drop.
 *
 * Expressed as a *share of the finished roll* rather than as a weight in
 * `TIER_WEIGHTS`, and that is the whole design of this line. The world's chest
 * tables arrive here as bias objects that **multiply** the ladder
 * (`{common: 80, uncommon: 20, legendary: 1}` against 80/20/1 is really
 * 6400/400/1), so any fixed weight would mean one number for a small chest and
 * a completely different one for the legendary chest whose table totals 1 —
 * where a weight tuned for the first would make blight the *only* thing the
 * second ever paid. A share is scale-free: whatever the table sums to, blight
 * takes 4% of the result and the ordinary tiers keep their relative shape.
 *
 * 4% of drops, against roughly 40-60 rolled drops in a full run, is two or three
 * corrupted cards a run — often enough that the tier is part of the game and
 * rare enough that meeting one is still an event. It is applied in `rollTier`,
 * inside the single `rng.weighted` draw that was already happening, so adding
 * the tier consumes **no extra numbers from the gameplay stream** and every
 * later roll in the run lands on the same draw it did before.
 */
const BLIGHT_SHARE = 0.04;
// The tiers whose presence in a table means the table is an ordinary world drop
// and may therefore pay a corruption instead. A boss or lunar pool names its one
// tier and gets nothing added: a teleporter boss must always pay a boss item.
// Exported so the prompt price tags (world/corruptionPrice.js) can mirror
// `rollTier`'s blight share off the same list rather than a second copy of it.
export const ORDINARY_TIERS = ['common', 'uncommon', 'legendary'];

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
 * magnitude more than a scarab (420 credits vs 6) for free, and elites pay
 * their 4.5-5x affix surcharge back for the same reason.
 *
 * "difficulty" above is `Director.rewardCoefficient` — the time-and-stage curve
 * only. The economy is closed against the *clean* director on purpose; see
 * `killReward`.
 */
const GOLD_PER_COST = 1.0;
// Bosses also drop a guaranteed boss item, so their gold is discounted rather
// than letting one teleporter kill fund an entire stage of chests.
const BOSS_GOLD_MULT = 0.6;
// Anything that dies without a spawn card behind it (scripted kills, summons)
// still pays something rather than nothing.
const DEFAULT_KILL_COST = 8;

// Mutation-offer identifiers (issue #168). One counter for the whole process,
// so two pawns' simultaneous windows can never collide; u32 on the wire, and it
// starts at 1 because 0 is what a truncated reply reads as and must never name
// a real offer. See `_openMutationChoice`.
let OFFER_SEQ = 0;
const nextOfferId = () => (OFFER_SEQ = (OFFER_SEQ % 0xffffffff) + 1);

export class Items {
  // The inventory and the stat pipeline. Every number in the run is computed
  // off the block this system rebuilds, so a throw mid-rebuild is a run played
  // on stats nobody chose.
  static critical = true;

  /**
   * `owner === null` is the engine singleton — it adopts `ctx.player` and
   * registers as `ctx.items`, exactly as before this class became
   * instantiable. `owner !== null` is a satellite instance for a remote
   * pawn (`Coop._spawnPawn`): it lives only on the host, mirrors nothing,
   * and must never touch `ctx.items`.
   */
  constructor(owner = null) {
    this.owner = owner;
    this.counts = new Map();
    this.gold = 0;
    this.permanentHealth = 0;
    this.buffs = new Map();
    this.cooldowns = new Map();

    this._dirty = true;
    this._cache = null;
    this._base = {};
    // Corrupted synergies bought off a Void Bargain, by id. Permanent for the
    // run, but their strength is re-read from the gauge every time the block is
    // rebuilt — see `stats` and the `_blightGrace` watch in `fixedUpdate`.
    this._synergies = new Set();
    this._blightGrace = -1;
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
    // one at a time rather than all together, so Dry Cell reads as "another
    // press banked" instead of "the whole bank comes back at once".
    this.equipmentId = null;
    this.equipCharges = 0;
    this.equipTimer = 0;
    // Latched by the first `stageStart` (see `init`). The run's opening seed is
    // a one-off; after it, only a barrel fills this slot.
    this._equipmentSeeded = false;

    // Counters for `tally` (every-Nth-hit items) and the Hunter's Tag marks.
    this._tallies = new Map();
    this._marks = new Map();
    this._markSweep = 0;
    // Timed, self-ticking effects owned by equipment (drones, meteor storms).
    this._effects = [];
    // Lingering ground hazards owned by items (Spore Sac).
    this._clouds = [];
    this._lastHurt = -999;

    // Highest band that has already taken a stack this run. Bleeding the gauge
    // down and reclimbing must not pay a second time — the threshold is a
    // one-way door, like the blight scar that never shrinks.
    this._mutePeak = 0;
    // Bands whose toll has been claimed but not yet collected. See the
    // `corruptionBand` listener for why the collection is deferred.
    this._muteQueue = [];
    // The open choice window, or null: `{ band, offers, remaining }`. The lever
    // (issue #33) — see `_openMutationChoice`.
    this._muteChoice = null;
    // The client's mirror of one: `{ offerId, band, offers, remaining }`, built
    // from the host's addressed `mutationChoiceOffered` and answerable exactly
    // once (issue #168). Never set on a host or in single-player, where
    // `_muteChoice` is the real thing.
    this._muteOffer = null;
  }

  init(ctx) {
    this.ctx = ctx;
    // A satellite's own draw stream, seeded off the run seed and a per-pawn
    // salt so two remote pawns never see the same sequence and neither one
    // ever touches the shared gameplay stream the singleton (and every other
    // client's mirror of it) depends on staying bit-identical. Same LCG shape
    // as `_mutateAt`'s per-band stream and Director's per-stage void stream:
    // `(seed ^ salt) >>> 0 || 1`. See `_rng()`.
    if (this.owner) {
      const salt = (this.owner.peerId * 2654435761) >>> 0;
      this._ownRng = new RNG(((ctx.seed >>> 0) ^ salt) >>> 0 || 1);
    }
    // The engine singleton (`owner === null`) is the one canonical viewer
    // instance and registers as `ctx.items`, exactly as before this class
    // became instantiable. A satellite (owned by a remote pawn) must never
    // steal that slot — `Items.of` is how callers find it instead.
    if (!this.owner) ctx.items = this;

    // `on()` returns its own unsubscribe closure (`src/core/Engine.js`); kept
    // here so `dispose()` can tear a satellite's subscriptions back down
    // when its pawn despawns, without the singleton path changing at all.
    this._unsub = [];

    this._api = {
      ctx, items: this, combat: null, player: null, rng: this._rng(),
      count: 0, procDepth: 0,
      roll: (p) => this.roll(p, this._api.procCoefficient),
      procCoefficient: 1,
    };

    // Player-driven hooks come off the bus; the proc-bearing hooks (onHit,
    // onKill, onDamaged) are called directly by Combat so they can carry
    // proc coefficient and chain depth.
    //
    // Satellites (remote pawns' own `Items`) live only on the host and
    // mirror nothing, so the client-mirror listeners below (itemPickup /
    // goldChanged / equipmentChanged) would be pure dead weight — worse,
    // subscribing them on the same shared bus the singleton listens on would
    // make one instance's mutation bleed into another's through its own
    // mirror branch. The simulation-driving listeners are shared, and every
    // one of them passes the event's identity through `_mine` first: one bus
    // now carries every pawn's jumps and casts, and an unfiltered hook would
    // pay the viewer's inventory for a teammate's button press.
    this._unsub.push(ctx.events.on('jump', (e) => { if (this._mine(e?.player)) this.onJump(e); }));
    this._unsub.push(ctx.events.on('stageStart', () => {
      this.cooldowns.clear();
      this._marks.clear();
      this._clouds.length = 0;
      this._effects.length = 0;
      // The Q slot is seeded exactly ONCE per run, at its first stage — never
      // again. The in-run source of equipment is the barrel
      // (`EquipmentBarrel` in `world/Interactables.js`), which is a place you
      // walk to and a commitment you make; a slot that quietly refilled itself
      // at every stage transition made the whole tier automatic and turned a
      // spent equipment into a two-minute wait rather than a decision.
      //
      // What this seeding still owes is the *pre-run* pick: `startEquipmentId`
      // is what `Menus.launch` writes from the equipment screen, and it has to
      // apply before the player can reach any barrel, so it applies here and
      // this is the only place that reads it. Absent — the Random card, or a
      // run started before the picker existed — the slot rolls off the shared
      // rng as before.
      //
      // Every pawn seeds, satellites included: `equipmentChanged` names its
      // owner, so the jingle, the logbook and the HUD all pass it through
      // `isLocalOwner` and a satellite's roll is silent here and replicated to
      // exactly the peer holding that pawn. `startEquipmentId` is the *local*
      // viewer's pre-run pick and belongs to nobody else, so a satellite rolls
      // instead — on its own derived stream (see `_rng`), which is why seeding
      // a joiner cannot move the shared sequence.
      //
      // The latch is per-`Items`, which is not quite per-run: `Coop` builds a
      // fresh `Items` per pawn (`new Items(pawn)`), so a satellite reconnecting
      // mid-session gets a new instance and a new latch. That is still correct,
      // because each instance seeds once over its own lifetime and a satellite
      // takes the `owner` branch — it rolls, and never reads the local viewer's
      // `startEquipmentId`. The host's own `Items` *is* one per run: every
      // restart here is a `location.reload()` (see `Menus`).
      if (!this._equipmentSeeded) {
        this._equipmentSeeded = true;
        if (!this.equipmentId) {
          this.setEquipment(this.owner ? this.rollEquipment()
            : (this.ctx.startEquipmentId || this.rollEquipment()));
        }
      }
    }));

    // Lunar cooldown items charge the player for casting, so they need to
    // know a cast happened. Player already announces every one of them on
    // the bus — adding a second, item-specific channel for the same fact
    // is how two systems end up disagreeing about what a "use" is. The cast
    // carries the caster (`Player._fire`), so a satellite pays only for its
    // own pawn's presses and the viewer pays for none of a teammate's.
    this._unsub.push(ctx.events.on('abilityUsed', (e) => {
      if (this._mine(e?.player)) this.onAbility(e || {});
    }));

    if (this.owner) {
      // "How long since I was last hit" backs three items (Field Dressing,
      // Siege Battery, Mineral Lick).
      //
      // KNOWN GAP, and this subscription is inert until it closes: nothing
      // emits `playerHurt` for a remote pawn. `Combat.js:565` gates the emit on
      // `target === ctx.player` — deliberately, and with the reasoning written
      // out there: it is the round-5 fix that stopped a teammate 40 m away
      // resetting this player's hurt timer, ducking their music and flashing
      // their HUD. `NetHost._forwardHurt` reconstructs a pawn's hit from
      // `damage` and sends it over the wire; it never re-emits on the host bus.
      // So a remote pawn's `_lastHurt` never moves and those three cards stay
      // inert for a joiner.
      //
      // Closing it means giving a pawn's hit a channel of its own rather than
      // widening the `=== ctx.player` gate, which is out of this slice's scope
      // and belongs with P3's per-pawn combat feedback. The filter is kept here
      // so that whatever channel arrives is already owner-correct on day one.
      //
      // `onDamaged` is not the only combat hook parked on that work, and it is
      // the only one parked *safely*. `onHit`, `onKill` and `modifyOutgoing`
      // are dispatched today for any `source.isPlayer` — remote pawns included
      // — and all three go to `ctx.items` (`Combat._dispatch`, `:653`;
      // `modifyOutgoing`, `:474`), so a joiner's procs never fire and the
      // host's fire off the joiner's bullets. Routing them per source needs a
      // decision about the shared proc budget; both gaps are written up in
      // `docs/MULTIPLAYER.md` under "Known co-op gaps after P2".
      this._unsub.push(ctx.events.on('playerHurt', (e) => {
        if (e?.target === this.owner) this._lastHurt = ctx.time;
      }));
    }

    // Everything below is the viewer's instance alone: the client-mirror
    // listeners are skipped outright on satellites — a satellite has no client
    // of its own to mirror for, and sharing a bus with the singleton means
    // subscribing here would let one instance's mutation bleed into another's.
    if (!this.owner) {
      this._unsub.push(ctx.events.on('playerHurt', (e) => {
        // Whose blood this is, on both roles. On a host the event is only ever
        // emitted for `ctx.player` — but a satellite's re-emission (above) and
        // any synthetic payload share this bus, and a teammate's hit must not
        // reset the viewer's hurt timer. On a client the forwarded event's
        // `target` resolves back to `ctx.player` (`NetClient._resolve`), so the
        // one hit a client ever hears about still passes.
        if (e?.target && e.target !== ctx.player) return;
        this._lastHurt = ctx.time;
        // On a client the hit was resolved on the host, so `Combat`'s local
        // `onDamaged` dispatch (Combat.js:493) never ran here — this forwarded
        // event is the only signal that arrives, and without dispatching from it
        // every `onDamaged` card is dead in co-op. The hooks that deal damage
        // no-op on a non-authority exactly as the rest of a client's combat does;
        // the ones that grant barriers, buffs and heals are the point.
        if (!ctx.authority) {
          this.onDamaged({
            target: ctx.player, source: e?.source ?? null, amount: e?.amount ?? 0,
            position: ctx.player?.position, procDepth: 1,
          });
        }
      }));

      // The blight toll's three cards, addressed to this machine (issue #168).
      // A client resolves no toll of its own — the mutation arrives as an
      // `itemMutated` mirror like every other inventory write — so all this
      // holds is the question, for `Menus` to paint and `chooseMutation` to
      // answer. The same `owner` armour as the mirrors below: the host strips
      // the tag on an addressed send, so anything else here means the routing
      // lied and this pack is not the one being asked.
      //
      // The role is read *inside* the handler, never around the subscription.
      // `ctx.authority` is true (single-player) when every system inits, and a
      // client only becomes one later, when `NetClient.init` runs at the join —
      // so a subscription gated at init time is a subscription a client never
      // has. Measured, and it is exactly the shape of this defect: the offer
      // crossed the wire, the three cards painted, and the button did nothing
      // for the whole six seconds until the void took a stack the player had
      // just been told they could choose (`coopprobe remote-mutation-round-trip`).
      // On a host this returns immediately: `_muteChoice` is the real window
      // there, and a second wire-shaped copy of it would let the local seat
      // answer its own offer by sending a message to nobody.
      {
        this._unsub.push(ctx.events.on('mutationChoiceOffered', (e) => {
          if (ctx.authority) return;
          if (e?.owner && e.owner !== ctx.player) return;
          this._muteOffer = {
            offerId: e?.offerId >>> 0,
            // Which decision this is (issue #204). The client never resolves
            // either kind — it echoes an id back — so this exists purely so the
            // panel can title and paint the right cards.
            kind: e?.kind || 'blight',
            band: e?.band ?? 0,
            offers: (e?.offers || []).map((o) => o?.baseId).filter(Boolean),
            // The panel's countdown, ticked locally in `fixedUpdate`. It is a
            // display clock only: the host owns the deadline, and the close it
            // sends is what ends the window here however far this one has run.
            remaining: e?.seconds ?? 0,
          };
        }));
        this._unsub.push(ctx.events.on('mutationChoiceClosed', (e) => {
          if (ctx.authority) return;
          if (e?.owner && e.owner !== ctx.player) return;
          this._muteOffer = null;
        }));
      }

      // A client never rolls loot; it mirrors the host's inventory off the
      // replicated `itemPickup`, whose `count` is the new total and so is safe
      // to apply out of order or twice. Without this the HUD and the whole
      // stat block would sit at zero items for the entire run.
      // The three mirrors below carry one line of armour each: `owner`, when
      // present, must be this machine's own player. The host strips the tag on
      // the way out (`NetHost._forwardOwned`) precisely because a client only
      // ever receives events about itself, so a foreign identity arriving here
      // means the routing lied — and a mirror that believed it would hand this
      // client a teammate's purse and pack.
      this._unsub.push(ctx.events.on('itemPickup', (e) => {
        if (ctx.authority || !e || !ITEM_BY_ID.has(e.id)) return;
        if (e.owner && e.owner !== ctx.player) return;
        // A count of zero is a real message on this channel — it is how the host
        // reports a stack the corruption tier (or the refinery) took away — and
        // storing it would leave a zero-count entry that `inventory()` and the
        // stat loop would then have to defend against.
        if (e.count > 0) this.counts.set(e.id, e.count); else this.counts.delete(e.id);
        this._dirty = true;
        this._rebuildHooks();
        // No `play('pickup')` here. `Audio` subscribes to this same event and
        // resolves the tier and the direction from the payload; a second direct
        // call played a bit-identical tier-0 jingle a few milliseconds later and
        // comb-filtered the pair. See `_set`.
      }));

      // Same story for the purse. Gold is host-authoritative and appears in no
      // snapshot field, so a client mirrors the host's total off the forwarded
      // `goldChanged`. The payload is an absolute value, not a delta, so a
      // dropped or duplicated event self-corrects on the next one.
      this._unsub.push(ctx.events.on('goldChanged', (e) => {
        if (ctx.authority || !e || typeof e.gold !== 'number') return;
        if (e.owner && e.owner !== ctx.player) return;
        this.gold = e.gold;
      }));

      // Equipment mirrors the same pattern: the host decides what is in the slot,
      // the client adopts it so its HUD and its F key describe the truth. The
      // press itself resolves on the host, off `BTN.EQUIP` (see `useEquipment`)
      // — this is display state, not permission.
      this._unsub.push(ctx.events.on('equipmentChanged', (e) => {
        if (ctx.authority || !e) return;
        if (e.owner && e.owner !== ctx.player) return;
        this.equipmentId = e.id && EQUIPMENT_BY_ID.has(e.id) ? e.id : null;
        this.equipCharges = e.charges ?? 0;
        this.equipTimer = e.cooldown ?? 0;
      }));
    }

    // The gauge reaching into the inventory (launch spec §1, expression 3).
    // Upward crossings only, one stack per threshold, never the same band
    // twice. The writes ride the 'corrupt' reason, so Corruption does not
    // re-charge and a client mirrors them like any other inventory change.
    //
    // The crossing only *claims* its bands here; `fixedUpdate` collects them
    // (a satellite's is pumped by `Coop.fixedUpdate`). Mutating inline would run
    // the whole transform inside whatever emission caused the crossing, and item
    // pickups are a primary corruption source — so a pickup big enough to tip
    // the gauge dispatched its own `itemPickup`, and the mutation's `'corrupt'`
    // writes reached listeners *before* the outer `'give'` did. The HUD then
    // retired a tile it had not created yet and created it a moment later from
    // the stale outer payload: a permanent ghost tile for an item the player
    // holds none of, a pickup card for it, and the toasts in reverse causal
    // order. `_mutePeak` still advances at claim time, so the
    // one-mutation-per-band rule holds even if two crossings land in the same
    // frame.
    //
    // Unfiltered on purpose, and shared by every instance: the band is a world
    // fact, not one pawn's, and every pack in the party festers when the world
    // does. Each instance claims the crossing into its own queue and mutates
    // its own inventory, and the resulting `itemMutated` names its owner.
    this._unsub.push(ctx.events.on('corruptionBand', ({ band, prev }) => {
      if (!ctx.authority || band <= prev) return;
      for (let b = Math.max(prev + 1, this.nextTollBand()); b <= band; b++) {
        this._mutePeak = b;
        this._muteQueue.push(b);
      }
    }));

    // A window nobody can still answer is a refusal. The run ending or this
    // instance's own pawn dying both leave the offer unanswerable, and an
    // unresolved offer would strand its band's toll in the queue forever —
    // `_mutePeak` has already advanced, so the crossing would never be
    // reclaimed. Both resolve down the ordinary refusal path, so the void
    // takes what it always would have.
    this._unsub.push(ctx.events.on('runEnd', () => this.refuseMutation('runEnd')));
    this._unsub.push(ctx.events.on('playerDead', (e) => {
      if (!e?.victim || e.victim === this._owner()) this.refuseMutation('death');
    }));

    this._rebuildHooks();
  }

  /** Unsubscribes every bus listener this instance holds. Satellite instances
   * are created per remote pawn (`Coop._spawnPawn`) and torn down with it
   * (`_despawnPawn`) — without this their `stageStart` (and, for the
   * singleton, every other) subscription would outlive the pawn and leak.
   */
  /**
   * A satellite's pawn has despawned — the peer left (`Coop._despawnPawn`).
   *
   * An open offer dies with it, and it dies *paying*: the toll was owed the
   * moment the band was crossed, and leaving it unresolved would be the one
   * way a player could dodge a threshold — by pulling their cable. `disconnect`
   * lands in `refuseMutation` like every other non-choice, so the stack the
   * void takes is the same one a silence would have given it, and the run
   * record says which of the two it was.
   */
  dispose() {
    this.refuseMutation('disconnect');
    for (const off of this._unsub || []) off();
    this._unsub = [];
  }

  /**
   * Every draw in this class goes through here: `ctx.rng` — the shared
   * gameplay stream — for the singleton, exactly as every call site read it
   * before this indirection existed, so the singleton's sequence is
   * unchanged and single-player stays bit-identical. A satellite draws off
   * `_ownRng` instead (seeded in `init`), so a remote pawn's rolls never
   * advance the stream the singleton and every other satellite depend on.
   */
  _rng() {
    return this.owner ? this._ownRng : this.ctx.rng;
  }

  /**
   * The pawn this instance belongs to — the subject of every event it emits
   * *and the body every hook it fires acts on*. A satellite says its own pawn;
   * the viewer's instance says `ctx.player` rather than `null`, so "whose is
   * this" is one comparison at every consumer instead of two, and so `NetHost`
   * can route on the field alone. Host-side only — the reference is stripped
   * before an event goes on the wire (`NetHost._forwardOwned`).
   *
   * Every `ctx.player` read on the hook-execution path goes through here. That
   * is not tidiness: an item hook is arbitrary code from `data/items.js` that
   * reads `api.player` and then damages, heals, launches or schedules against
   * it. Bound to `ctx.player` on a satellite, a *client's* inventory would act
   * on the *host's* survivor — `gale-reliquary` billing the host's health for a
   * remote cast, `temporal-echo` making the host's body fire a client's
   * ability. In single-player `owner` is null and every one of these reads is
   * `ctx.player`, exactly as it was.
   */
  _owner() {
    return this.owner || this.ctx.player;
  }

  /**
   * Does an event naming `pawn` belong to this instance? The mirror image of
   * `_owner`, for the simulation listeners: a satellite wants its own pawn's
   * signal and nothing else, and the viewer's instance wants the local
   * player's — including every payload that names nobody, which is what
   * single-player and the harness emit, so nothing there changes.
   */
  _mine(pawn) {
    return this.owner ? pawn === this.owner : (!pawn || pawn === this.ctx.player);
  }

  /**
   * The `Items` instance that owns `pawn` — the local viewer's `ctx.items`
   * for `ctx.player` (and for `null`/absent, which is the "no specific pawn"
   * shorthand every pre-co-op call site already uses), or a remote pawn's own
   * satellite instance. Every economy action resolves through this and only
   * this, so a client mirror and a host satellite can never be confused for
   * each other.
   */
  static of(ctx, pawn) {
    if (!pawn || pawn === ctx.player) return ctx.items ?? null;
    return pawn.items ?? null;
  }

  /**
   * Pay a kill out to the whole party. **Every registered pawn receives the
   * full reward** — no split, no last-hit bonus. A shared purse would make
   * co-op a poorer run than solo, and a split (or a last-hit rule) would make
   * kill-stealing the optimal play against your own teammates; paying everyone
   * in full keeps the only competition the one with the monsters.
   *
   * A roster of one takes the `else` branch, which is the literal call this
   * replaced — single-player draws and emits exactly what it always did.
   */
  static rewardKillAll(ctx, victim, source = null) {
    // Sacrifice's corpse-drop is a property of the *kill*, not of each payee, so
    // it is rolled here — once — and not inside `rewardKill`, which this branch
    // turned into a per-pawn loop body. Left there, an N-player roster rolled
    // the world's drop chance N times off N independent streams and the
    // effective drop rate scaled with party size, which is exactly the kind of
    // unplanned economy scaling the plan deferred chest pricing to avoid.
    //
    // On the singleton (`ctx.items`), so the draw comes off `ctx.rng` — the same
    // shared stream, at the same point in the sequence, as before this branch
    // existed. A satellite would draw off its own derived stream and make the
    // world's loot depend on roster iteration order.
    ctx.items?.rollSacrifice?.(victim, source?.isPlayer ? source : null);

    const roster = ctx.roster;
    if (roster && roster.count > 1) {
      for (const p of roster.all) Items.of(ctx, p)?.rewardKill(victim);
    } else {
      ctx.items?.rewardKill?.(victim);
    }
  }

  // -------------------------------------------------------------- inventory

  /**
   * `opts.safe` marks a grant whose corruption has already been settled by the
   * transaction that produced it (issue #174, `world/itemTransaction.js`), or
   * that is deliberately free. It rides the `itemPickup` payload rather than
   * `reason`, because every other listener — the HUD strip, the audio cue, the
   * wire mirror — cares only that an item was acquired, and only `Corruption`
   * has any business knowing that this one was already paid for. Legacy paths
   * pass nothing and feed exactly as they always did.
   */
  give(id, count = 1, opts = null) {
    // Host only. Clients receive the result as `itemPickup` and apply it above.
    if (!this.ctx.authority) return this.count(id);
    if (!ITEM_BY_ID.has(id)) return 0;

    // Corruption intercepts the pickup *before* the stack lands when the player
    // is already holding the blight card that eats this id. Routing it straight
    // through means the ordinary item never enters the inventory, never emits a
    // pickup for a stack that is about to be deleted, and never leaves a tile in
    // the HUD strip for an item the player does not own — see `_settleBlight`.
    const waiting = BLIGHT_BY_BASE.get(id);
    if (waiting && this.count(waiting.id) > 0) {
      return this._set(waiting.id, this.count(waiting.id) + count, 'give', opts);
    }

    const next = this._set(id, (this.counts.get(id) || 0) + count, 'give', opts);
    // The other direction: a blight card arriving on top of an inventory that
    // already holds its base.
    return this._settleBlight(id) ?? next;
  }

  /**
   * Write one absolute stack count and announce it. The single mutation point
   * for the inventory — `give`, `take` and the corruption transform all go
   * through it, so the invariants (no zero-count entries left in the Map, hooks
   * rebuilt, stat cache dirtied, an absolute `itemPickup` on the wire) are
   * stated once instead of three times.
   *
   * The payload carries `tier` and `delta` alongside the absolute `count`.
   * `count` stays absolute because that is what makes the client mirror safe to
   * apply out of order or twice; `delta` rides along because a *listener*
   * cannot derive direction from an absolute total without keeping its own
   * shadow copy of the inventory, and `Audio` was reduced to doing exactly
   * that. `tier` likewise: without it every consumer has to import the item
   * catalogue to learn what it was just handed.
   *
   * `reason` says *why* the write happened — 'give' (the player acquired this),
   * 'take' (something consumed it), 'corrupt' (the blight transform moved
   * stacks the player already owns from one id to another). The sign alone
   * cannot tell those apart, and listeners that price or announce acquisition
   * need to: `Corruption` must not charge again for stacks already paid for at
   * their own tier, and `Audio` (see its `_flushItemCue` note) wants the same
   * distinction to stop guessing direction.
   */
  _set(id, count, reason = 'give', opts = null) {
    const next = Math.max(0, count | 0);
    const prev = this.counts.get(id) || 0;
    if (next === 0) this.counts.delete(id); else this.counts.set(id, next);
    this._dirty = true;
    this._rebuildHooks();
    const payload = {
      id, count: next, tier: ITEM_BY_ID.get(id)?.tier, delta: next - prev, reason,
      owner: this._owner(),
    };
    // Added only when true, so no existing payload — on the wire or in a
    // fixture — grows a field it never had.
    if (opts?.safe) payload.safe = true;
    this.ctx.events.emit('itemPickup', payload);
    return next;
  }

  /**
   * The corruption transform: every copy of `def.corrupts` the player holds
   * becomes another copy of the blight card `id`.
   *
   * Returns the blight card's new total, or `null` if `id` is not a blight card
   * (so `give` can fall back to its own count).
   *
   * ## Idempotent and order-independent, by construction
   *
   * There is only one direction of work here — *pull the base's stacks in* — and
   * it is guarded by the base's own count. A second copy of the same blight card
   * finds the base already at zero and does nothing beyond adding its stack; a
   * base picked up *after* the blight card never reaches this function at all,
   * because `give` intercepts it above and routes it into the blight card
   * directly. So the two orders converge on the same inventory, and running the
   * transform any number of times changes nothing after the first.
   *
   * ## The HUD, and why the interception in `give` still exists
   *
   * `ui/HUD.js`'s item strip used to be append-only, so an id driven to zero
   * kept its tile with a blank stack badge. `onItemPickup` now retires a tile
   * on any write with `total <= 0`, so a base emptied here (or by `take()`, or
   * by the Hollow Market's refinery) leaves nothing behind. The interception in
   * `give` is kept regardless: routing a base straight into a blight card the
   * player already holds means the ordinary item never lands, never toasts and
   * never cards, which is a quieter truth than creating a tile and retiring it
   * in the same breath.
   */
  _settleBlight(id) {
    const def = ITEM_BY_ID.get(id);
    if (def?.tier !== 'blight' || !def.corrupts) return null;
    const held = this.count(def.corrupts);
    if (held <= 0) return this.count(id);
    // Absolute writes in both directions: `itemPickup` carries a total, not a
    // delta, so a client that drops or duplicates one of these self-corrects on
    // the next one instead of drifting a stack apart from the host forever.
    //
    // Both are tagged 'corrupt': nothing was acquired here. The blight card's
    // own pickup already emitted its 'give' — that is the whole price of taking
    // a corruption card — and the base stacks were paid for at their own tier
    // when the player picked them up. Charging the re-stack too would bill the
    // same items twice, at the highest tier in the game.
    this._set(def.corrupts, 0, 'corrupt');
    return this._set(id, this.count(id) + held, 'corrupt');
  }

  /**
   * One threshold's toll: convert a random held base stack into its blight
   * card. The pick comes off a derived stream seeded per (run seed, band) —
   * one draw on ctx.rng here would displace every later shared roll relative
   * to a run whose inventory happened to differ, which is the sp-equivalence
   * hazard the shrine-type roll already documents. Eligible ids are sorted so
   * the pick cannot depend on Map insertion order.
   */
  _mutateAt(band, chosenId = null) {
    const eligible = this._eligibleBases();
    if (!eligible.length) return false;
    const rng = new RNG(((this.ctx.seed >>> 0) ^ (0x6b2f8d43 * (band + 1))) >>> 0 || 1);
    // A chosen stack skips the draw entirely rather than drawing and
    // discarding: the stream is per-band and derived, so nothing downstream
    // depends on how many times it was pulled, and skipping keeps the void's
    // pick identical whether or not a window was ever opened.
    const baseId = chosenId && eligible.includes(chosenId) ? chosenId : rng.pick(eligible);
    const blight = BLIGHT_BY_BASE.get(baseId);
    const held = this.count(baseId);
    this._set(baseId, 0, 'corrupt');
    this._set(blight.id, this.count(blight.id) + held, 'corrupt');
    this.ctx.events.emit('itemMutated', {
      // `eligible` is the field of stacks the toll could have taken, and it is
      // carried for the run record (issue #29) rather than for any listener in
      // the game: what a mutation cost is only legible against what it might
      // have cost. It rides the wire like the rest of this payload — a handful
      // of short ids, at most once per band crossing, which is a few times a run.
      baseId, blightId: blight.id, count: held, band, owner: this._owner(), eligible,
      // Whether the player owned this loss or the void did. Additive: every
      // existing listener (Codex, Telemetry, HUD, the wire) reads the fields
      // above and is untouched by it.
      chosen: baseId === chosenId,
      // What the pack gained, in the catalogue's own words. The toast that
      // reads it is the only place a mutation gets to say why the new stack is
      // worth holding rather than only what the old one cost.
      blightDescription: describeBlight(blight, held),
    });
    return true;
  }

  /** Held stacks with a blight counterpart, sorted — the toll's whole field. */
  _eligibleBases() {
    const out = [];
    for (const [id, count] of this.counts) {
      if (count > 0 && BLIGHT_BY_BASE.has(id)) out.push(id);
    }
    out.sort();
    return out;
  }

  /**
   * The lever on the toll (issue #33): at a threshold, name two or three of
   * the stacks the void is reaching for and give the player a short window to
   * decide which one goes. The scar is preserved exactly — something festers
   * either way, and refusing or ignoring the window falls through to the same
   * random pick the toll always made.
   *
   * **Every seat, since issue #168.** A satellite (`this.owner` — an `Items`
   * instance for a remote pawn, host-side) opens a window of its own now: the
   * offer is addressed to the peer holding that pawn (`NetHost._forwardOwned`),
   * the panel it raises over there is this one, and the answer comes back as
   * one bounded `MSG.MUTATE` reply that this class validates in
   * `answerMutation`. A window belonging to a peer that never answers — or that
   * left, or that is running a build with no reply in it — lapses on this
   * machine's clock and pays exactly the void's own pick, which is the toll a
   * remote pawn always paid before the lever reached it. Nothing about the
   * outcome of silence changed; only that silence is now a choice.
   *
   * A client's singleton never reaches here at all: the `corruptionBand`
   * listener queues nothing without authority, and the offer it paints comes
   * off the wire (see `_muteOffer`).
   *
   * A field of one is no choice, so a single eligible stack mutates outright
   * rather than opening a window whose only button is the inevitable.
   *
   * The offers come off a stream derived from (run seed, band) — never
   * `ctx.rng`, for the reason `_mutateAt` documents at length — under a salt
   * of its own, so which stacks are *offered* cannot perturb which stack the
   * void takes when the window lapses.
   */
  _openMutationChoice(band) {
    const eligible = this._eligibleBases();
    if (eligible.length < 2) return false;
    const rng = new RNG(((this.ctx.seed >>> 0) ^ (0x27d4eb2f * (band + 1))) >>> 0 || 1);
    const pool = eligible.slice();
    const offers = [];
    const want = Math.min(MUTATION.choiceOffers, pool.length);
    while (offers.length < want) offers.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
    offers.sort();
    return this._openChoice({
      kind: 'blight',
      band,
      offers,
      seconds: MUTATION.choiceSeconds,
      // The card has to say what the transformation *is*, not only what it
      // costs, so each offer carries the counterpart's own catalogue entry.
      cards: offers.map((id) => {
        const blight = BLIGHT_BY_BASE.get(id);
        const count = this.count(id);
        return {
          baseId: id,
          baseName: ITEM_BY_ID.get(id)?.name || id,
          blightId: blight.id,
          blightName: blight.name || blight.id,
          // `description` in the catalogue is a function of stack size, so the
          // card quotes the effect the player would actually get for the
          // copies they actually hold, not a generic line.
          blightDescription: describeBlight(blight, count),
          count,
        };
      }),
      // The toll, and the only reason the blight kind exists: whichever way
      // this window ends — a card pressed, the clock run out, a deeper band
      // arriving on top of it — a stack festers. `_mutateAt(band, null)` is the
      // void's own pick, which is exactly what silence bought before the lever.
      resolve: (baseId) => this._mutateAt(band, baseId),
    });
  }

  /**
   * The one choice window, for whatever decision owns it this second.
   *
   * Two kinds share it now (issue #204), and the discriminator is not
   * decoration — it is the whole difference between the two resolutions:
   *
   *  · `blight` — the toll. Every ending pays `_mutateAt`, including silence.
   *  · `argent` — the Void Bargain's consecration. The motes were already
   *    spent by the press that opened this; the window only names *which*
   *    warded card they bought, and silence takes the first one. Nothing
   *    festers on this path, and nothing may: routing an argent lapse through
   *    the toll would charge a purity run a blight for shopping.
   *
   * Everything else is shared deliberately — the nonce, the addressed offer
   * event, the owner-filtered panel and the one bounded `MSG.MUTATE` reply that
   * answers it — because a second copy of that machinery is a second place for
   * "whose window is this" to be got wrong.
   *
   * `resolve(pickedId, reason)` runs on the host, inside the close, after the
   * window is already null: it may open another one.
   */
  _openChoice({ kind, band = 0, offers, cards, seconds, resolve }) {
    // The nonce that makes this window answerable from another machine. It is
    // minted here, on the host, and it is the only thing a reply has to get
    // right: it identifies the pawn (each satellite holds at most one), the
    // window and the moment (it dies with the window), so wrong-owner, stale
    // and after-the-fact replies all fail on one comparison rather than three.
    // Monotone rather than random because it is not a secret — a peer can only
    // ever reach its own satellite — and it takes no draw from any stream, so
    // opening a window still cannot perturb which stack the void takes when it
    // lapses.
    this._muteChoice = { kind, band, offers, remaining: seconds, offerId: nextOfferId(), resolve };
    this.ctx.events.emit('mutationChoiceOffered', {
      kind, band, seconds, owner: this._owner(),
      offerId: this._muteChoice.offerId,
      offers: cards,
    });
    return true;
  }

  /**
   * Open an argent choice over `cards` (issue #204). The caller has already
   * charged for the purchase and supplies `resolve`, which is handed the id of
   * the card the player named — or `null` when the window ended without one,
   * which the caller answers with its own default rather than this class
   * guessing. A lapse must still deliver *something*: the purse was emptied by
   * the press, and nothing at all would be theft.
   *
   * Refused outright while another window stands rather than painting over it:
   * the older decision is not this system's to forfeit, and the altar's press
   * is repeatable while a band crossing is not.
   */
  openArgentChoice({ cards, seconds, resolve }) {
    if (this._muteChoice || !(cards?.length > 1)) return false;
    return this._openChoice({
      kind: 'argent',
      offers: cards.map((c) => c.baseId),
      cards,
      seconds,
      resolve: (id) => resolve(id || null),
    });
  }

  /**
   * Open a Blight Wound's two outcomes (#178), through the same one window.
   *
   * The third kind, and the only one whose lapse is a *decision the player
   * would have made anyway*: nothing has been charged by the press that opened
   * it — unlike the argent kind, where the motes are already gone — and nothing
   * festers if it ends in silence, unlike the toll. So `resolve(null)` means
   * "seal", the safe half, and the caller says so rather than this class
   * guessing which of its two tokens is the harmless one.
   *
   * Refused while another window stands, for `openArgentChoice`'s reason: the
   * older decision is not this press's to paint over, and a wound is standing
   * ground the party can walk back to.
   */
  openWoundChoice({ cards, seconds, resolve }) {
    if (this._muteChoice || !(cards?.length > 1)) return false;
    return this._openChoice({
      kind: 'wound',
      offers: cards.map((c) => c.baseId),
      cards,
      seconds,
      resolve: (id) => resolve(id || null),
    });
  }

  /** Whether a choice window of any kind is standing on this pack. */
  hasChoiceWindow() { return !!this._muteChoice; }

  /**
   * The open offer, for the UI that paints it. Null when no window is open.
   *
   * On a client that is the offer the host addressed to this machine
   * (`_muteOffer`) — same shape in the two fields the panel reads, `offers` and
   * `remaining`, so `Menus` counts down off one accessor on both sides and has
   * never been told which one it is looking at.
   */
  mutationChoice() {
    return this._muteChoice || this._muteOffer || null;
  }

  /**
   * The player's answer. Converts the named stack and only it; anything not on
   * the table is refused outright rather than quietly re-rolled.
   *
   * On a client this decides nothing: it sends the answer (`_answerRemote`) and
   * the host is what converts a stack, if it agrees.
   */
  chooseMutation(baseId) {
    if (this._muteOffer) return this._answerRemote(baseId);
    const c = this._muteChoice;
    if (!c || !c.offers.includes(baseId)) return false;
    // Only the blight kind requires the stack to still be there: its cards name
    // things the player *holds*, and a pack that lost the stack between the
    // offer and the answer has nothing to convert. An argent card names
    // something they are buying, and demanding they already own it would refuse
    // every consecration that is not a duplicate.
    if (c.kind === 'blight' && !(this.count(baseId) > 0)) return false;
    this._closeMutationChoice(c, 'chosen', baseId);
    return true;
  }

  /**
   * A remote player's answer, arriving as bytes (issue #168).
   *
   * Called only by `NetHost._onMutate`, on the satellite belonging to the peer
   * the message arrived on — which is why there is no owner field to check
   * here: ownership is structural, and the one thing this method is asked to
   * believe is the identifier. Everything a reply could lie about fails on it:
   *
   *  · an offer nobody minted, or a zero from a truncated message;
   *  · another peer's identifier, which cannot match this satellite's;
   *  · an identifier for a window that has already lapsed, been superseded, or
   *    been answered — `_muteChoice` is null the moment a window closes, so the
   *    second copy of a duplicated reply and a reply that lost a race to the
   *    timeout are the same rejection;
   *  · a card that offer never carried, or one the pawn no longer holds, both
   *    of which `chooseMutation` was already refusing for the local seat.
   *
   * Fail-closed and silent: a rejected reply leaves the window exactly as it
   * was, so a peer sending nonsense cannot even cancel its own offer, and the
   * toll it owes still resolves on the host's clock.
   */
  answerMutation(offerId, baseId) {
    const c = this._muteChoice;
    if (!c || !(offerId > 0) || c.offerId !== offerId) return false;
    // '' is the panel's decline button, told out loud. `null`/`undefined` never
    // reaches here — `NetHost._onMutate` drops a malformed body — but treating
    // it as a refusal would be spending somebody's stack on a broken message.
    if (baseId === '') return this.refuseMutation('refused');
    if (typeof baseId !== 'string' || !baseId) return false;
    return this.chooseMutation(baseId);
  }

  /**
   * The client half: echo the host's identifier back and let it decide.
   *
   * The offer list is consulted before sending purely to keep a press that
   * could never be honoured off the wire — the host checks the same thing again
   * and is the only check that matters. The offer is cleared on send, so one
   * window produces at most one reply from a well-behaved client; the host
   * ignores a second one regardless.
   */
  _answerRemote(baseId) {
    const o = this._muteOffer;
    if (baseId && !o.offers.includes(baseId)) return false;
    this._muteOffer = null;
    this.ctx.events.emit('mutationAnswer', { offerId: o.offerId, baseId: baseId || '' });
    return true;
  }

  /**
   * Declining, by button or by silence. Every non-choice resolution lands here
   * — the lapsed window, a fresh threshold arriving on top of this one, the run
   * ending, the player dying — and every one of them is exactly the toll the
   * game collected before the lever existed.
   */
  refuseMutation(reason = 'refused') {
    if (this._muteOffer) return this._answerRemote(null);
    const c = this._muteChoice;
    if (!c) return false;
    this._closeMutationChoice(c, reason, null);
    return true;
  }

  _closeMutationChoice(c, reason, baseId) {
    this._muteChoice = null;
    this.ctx.events.emit('mutationChoiceClosed', {
      kind: c.kind, band: c.band, offerId: c.offerId, reason, baseId, owner: this._owner(),
    });
    // The kind's own ending, and the only branch either kind ever takes: the
    // toll for one, the consecration's delivery for the other. Cleared before
    // it runs, so a resolution that opens the next window can.
    c.resolve(baseId, reason);
  }

  /**
   * The lowest band whose blight toll is still owed — the mutation floor until
   * a crossing has been paid, and one above the deepest band paid after that.
   * Can exceed the last band, which is how a caller learns nothing is left to
   * pay; the crossing listener simply runs no iterations in that case.
   *
   * The `corruptionBand` listener reads this for its loop bound and the Argent
   * Font's disclosure reads it for its toll clock, for the same reason
   * `stabilisable` is shared: the line that promises a threat and the code that
   * collects it must agree. The disclosure derived its own answer from world
   * corruption alone once, and told a party that had already spiked into a band
   * and bled back down that the toll it had paid was still coming.
   *
   * `_mutePeak` only advances on the host, so a client reads the floor rather
   * than the truth; the caller there is a prompt, and it also floors the answer
   * at the band above the live world so the number it prints stays forward.
   */
  nextTollBand() {
    return Math.max(MUTATION.minBand, this._mutePeak + 1);
  }

  /**
   * The blight ids currently held, as a set — what a corrupted synergy is
   * checked against (data/bandBoons.js). A query; it moves nothing.
   */
  blightHeld() {
    const out = new Set();
    for (const [id, count] of this.counts) {
      if (count > 0 && ITEM_BY_ID.get(id)?.tier === 'blight') out.add(id);
    }
    return out;
  }

  /**
   * Held base stack -> the blight id it would become, sorted by base id. The
   * field a *bought* conversion can draw from, and the same `BLIGHT_BY_BASE`
   * pairing the toll uses — one table, so the bargain cannot offer a conversion
   * the toll would not make.
   */
  convertibleStacks() {
    const out = new Map();
    for (const id of this._eligibleBases()) out.set(id, BLIGHT_BY_BASE.get(id).id);
    return out;
  }

  /**
   * Convert one held stack on purpose — the Blighted band's bargain (issue
   * #36), where the player buys the conversion the toll would otherwise have
   * taken at random. Same transform as `_mutateAt`, and deliberately *not* the
   * same event: `itemMutated` means "the void took one", and a Codex entry or a
   * telemetry row that read a purchase as a toll would misreport the run.
   *
   * `reason: 'corrupt'` on both `_set` calls is load-bearing, for the reason
   * `Corruption.init` documents at length: the re-stack is not a pickup, and
   * billing it would charge the player corruption for spending corruption.
   */
  corruptStack(baseId) {
    const blight = BLIGHT_BY_BASE.get(baseId);
    const held = this.count(baseId);
    if (!blight || !(held > 0)) return false;
    this._set(baseId, 0, 'corrupt');
    this._set(blight.id, this.count(blight.id) + held, 'corrupt');
    this.ctx.events.emit('itemCorrupted', {
      baseId, blightId: blight.id, count: held, owner: this._owner(),
    });
    return true;
  }

  /**
   * The blight stacks a cleansing could hand back, sorted. A query, not a side
   * effect, because the Argent Font's prompt has to be able to promise the
   * reward *before* the player pays for it (issue #32) — and the caller that
   * promises it and the caller that pays it must agree, which is why they read
   * the same list rather than two filters that could drift.
   */
  stabilisable() {
    const out = [];
    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      if (count > 0 && def?.tier === 'blight' && def.corrupts) out.push(id);
    }
    out.sort();
    return out;
  }

  /**
   * `_mutateAt` run backwards: one held blight stack becomes its base again.
   * The Argent Font's reward — cleansing gives something back rather than only
   * taking something away, which is what makes it an investment instead of a
   * refund.
   *
   * Everything hazardous about `_mutateAt` is hazardous here, for the same
   * reasons and with the same answers:
   *
   * - The pick comes off a derived stream seeded per (run seed, `salt`), never
   *   off `ctx.rng`. One shared draw here would displace every later roll
   *   relative to a run whose inventory happened to differ — the sp-equivalence
   *   hazard, and `gate:sp` is what finds out. The salt is the font's stage and
   *   press index (`ArgentFont.interact`), so successive presses at one font
   *   pick different stacks without anything being rolled. That pair is unique
   *   across the whole run, and not because presses are rare: `_populateShrines`
   *   draws shrine types out of its bag without replacement and gates the
   *   guaranteed font on the stage not already holding one, so a stage carries
   *   at most one Argent Font, ever. Two fonts sharing a salt is not an
   *   improbable collision to be tolerated — it is a state the placement code
   *   cannot produce.
   * - Eligible ids are sorted, so the pick cannot depend on Map insertion order.
   * - Host only. A client adopts the two `'corrupt'` writes off the wire like
   *   any other inventory change.
   *
   * The *whole* stack moves, exactly as the toll took the whole stack. It also
   * avoids a state the rest of this class does not otherwise produce: a base
   * and its blight card held at once, which the next blight-card pickup would
   * silently re-absorb through `_settleBlight`.
   */
  stabilise(salt = 0) {
    if (!this.ctx.authority) return null;
    const eligible = this.stabilisable();
    if (!eligible.length) return null;
    const rng = new RNG(saltedSeed(this.ctx.seed, salt, 0x27d4eb2f) || 1);
    const blightId = rng.pick(eligible);
    const baseId = ITEM_BY_ID.get(blightId).corrupts;
    const held = this.count(blightId);
    // Zero the card first, then land the base — the same order `_mutateAt`
    // writes in, so the HUD strip retires a tile before it creates one and the
    // toasts stay in causal order.
    this._set(blightId, 0, 'corrupt');
    this._set(baseId, this.count(baseId) + held, 'corrupt');
    this.ctx.events.emit('itemStabilised', {
      blightId, baseId, count: held, owner: this._owner(),
    });
    return { blightId, baseId, count: held };
  }

  /**
   * Remove stacks. Host only, and the mirror of `give` in every respect —
   * including the `itemPickup` event, which carries an absolute count rather
   * than a delta precisely so a removal is representable on it and a client's
   * inventory mirror self-corrects.
   *
   * Added for the Hollow Market's refinery, which trades stacks up a tier. It
   * is deliberately the only consumer: the run's loot must never quietly go
   * away, so taking an item is something the player asks for by name.
   */
  take(id, count = 1) {
    if (!this.ctx.authority) return this.count(id);
    const have = this.counts.get(id) || 0;
    if (have <= 0) return 0;
    return this._set(id, have - count, 'take');
  }

  count(id) { return this.counts.get(id) || 0; }

  /** [{ id, count, def }] sorted by tier then name — HUD renders this directly. */
  inventory() {
    const out = [];
    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      if (def && count > 0) out.push({ id, count, def });
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
    this.ctx.events.emit('goldChanged', { gold: this.gold, owner: this._owner() });
    return this.gold;
  }

  /** Gold one monster death is worth. Pure — safe to call for a preview. */
  killReward(victim) {
    if (!victim || victim.isPlayer) return 0;
    const cost = victim.def?.cost ?? DEFAULT_KILL_COST;
    const eliteMult = victim.elite?.cost ?? 1;
    const bossMult = victim.isBoss ? BOSS_GOLD_MULT : 1;
    // The void does not tip its executioners: killing a Voidtouched pays a
    // quarter, and the refund it bleeds off World Corruption is the reward.
    const voidMult = isVoidtouched(victim) ? VOIDTOUCHED.rewardMult : 1;
    // The director's own coefficient, not Progression's, so the payout is the
    // exact inverse of the credits that bought this monster. (`ctx.difficulty`
    // used to be the fallback here; it is now the difficulty *selection* API,
    // and the director's coefficient — which is never absent — is the honest
    // single source anyway.)
    //
    // `rewardCoefficient`, not `difficultyCoefficient`: the two differ only by
    // the World Corruption pressure term, and gold is quadratic in this number
    // while enemy stats are linear, so paying against the corrupted curve made
    // greed the higher-EV line. The fallback keeps any tool holding an older
    // Director-shaped stub alive, and at world 0 the two are the same float.
    const d = Math.max(1, this.ctx.director?.rewardCoefficient
      ?? this.ctx.director?.difficultyCoefficient ?? 1);
    const gold = this.ctx.artifacts?.runMods?.().gold ?? 1;
    return Math.max(1, Math.round(cost * GOLD_PER_COST * eliteMult * bossMult * voidMult * d * gold));
  }

  /**
   * Pay out a kill. Host only — gold is game state, and a client's purse comes
   * from its own host-authored events, never from a locally observed death.
   */
  /**
   * Sacrifice: the loot the stage no longer carries comes off the corpses.
   *
   * The roll and the orb are both here rather than in Artifacts — Items owns the
   * gameplay RNG draw and the drop table, and Artifacts only answers what the
   * odds are. Called once per death by `rewardKillAll`, never from `rewardKill`,
   * which is per-payee; see the note there.
   *
   * `killer` is the pawn that landed the blow, or null when nothing did (a burn
   * finishing, an elite death nova). A named killer owns the orb, so a joiner's
   * kill drops for the joiner instead of homing to whoever this machine happens
   * to render; an unowned kill keeps the pre-branch free-for-all, which is the
   * only honest answer when there is nobody to credit.
   */
  rollSacrifice(victim, killer = null) {
    if (!this.ctx.authority) return null;
    const chance = this.ctx.artifacts?.sacrificeChance?.(victim) ?? 0;
    if (!(chance > 0) || this._rng().next() >= chance) return null;
    const id = this.rollItem(null, 'small');
    if (id) this.ctx.interactables?.spawnOrb?.(victim.position, id, 1.4, killer);
    return id;
  }

  rewardKill(victim) {
    if (!this.ctx.authority) return 0;
    const amount = this.killReward(victim);
    if (amount <= 0) return 0;
    this.addGold(amount);
    // One kill now pays every pawn in the party (`rewardKillAll`), so this
    // channel carries N events per death on a host. The owner is what collapses
    // that back to one popup per machine: the viewer's.
    this.ctx.events.emit('goldReward', {
      amount, victim, position: victim.position, owner: this._owner(),
    });
    return amount;
  }

  spendGold(amount) {
    if (this.gold < amount) return false;
    this.gold -= amount;
    this.ctx.events.emit('goldChanged', { gold: this.gold, owner: this._owner() });
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
    // Equipment recharge scale — Dry Cell and friends write here as well as to
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
    // Blight drawback flag, same shape as `noDefensive`: Gristle Sickle and
    // Charnel Bloom trade passive regeneration away. Zeroing `healthRegen` inside
    // the loop would keep whatever an item inserted later into the Map added.
    s.noRegen = false;
    // Multiplicative accumulators, for the same order-independence reason. Item
    // `stat` functions add into `damage`/`maxHealth` and multiply into these.
    s.damageMult = 1;
    s.healthMult = 1;
    // The *cost* side of movement speed, kept apart from `moveSpeed` itself
    // for a reason the other accumulators do not have: `moveSpeed` is curved
    // above the knee (see `softenMove`), and anything folded into it before
    // that is compressed by the curve. A drawback compressed by the curve is a
    // drawback the surrounding stack pays off. Sub-1.0 move-speed
    // contributions therefore go here — Slag Ingot's is the only one today —
    // and land on the finished number at full strength.
    s.moveSpeedPenalty = 1;
    // Scales the *bonus* half of the crit multiplier (Clouded Eye). Kept apart
    // from `critMult` itself so a crit can never be reduced below a normal hit
    // however many stacks are held, and so the reduction does not depend on
    // which items happened to contribute crit damage before it.
    s.critEdge = 1;

    s.maxHealth += this.permanentHealth;

    for (const [id, count] of this.counts) {
      const def = ITEM_BY_ID.get(id);
      // `ctx` is the third argument for one tier only: blight `stat` functions
      // scale their payoff by `blightGrace`, which reads live world corruption.
      // Every other item ignores it. The cache that memoises this block is
      // invalidated from `update` when that curve moves — see `_blightGrace`.
      if (def?.stat && count > 0) def.stat(count, s, this.ctx);
    }
    // Permanent blight synergy buffs are re-derived here rather than stored as
    // a fixed magnitude, for exactly the reason the cards are: a synergy bought
    // at Overrun and then cleansed away must relinquish its payoff along with
    // the cards that earned it. They have their own accumulators rather than
    // sharing the `frenzy`/`aegis`/`preyfoot` buff slots, because those slots
    // also carry argent and common items and a shared name would let one
    // clobber the other (`addBuff`'s rule).
    if (this._synergies.size) {
      const bg = blightGrace(this.ctx);
      for (const id of this._synergies) {
        const g = SYNERGY_BY_ID.get(id)?.grant;
        if (!g) continue;
        // `maxStacks` is a *ceiling* on a repeatable grant, not a multiplier: a
        // synergy is bought once and `synergyPlan` stops offering it the moment
        // both its cards are held, so the buff it used to write could only ever
        // reach one stack. Folding the ceiling in here paid Rotting Chorus 0.44
        // where the old path paid 0.22.
        const m = g.magnitude * bg;
        if (g.buff === 'frenzy') s.attackSpeed += m;
        else if (g.buff === 'aegis') s.armor += m;
        else if (g.buff === 'preyfoot') s.moveSpeed *= 1 + m;
      }
    }

    s.damage *= s.damageMult;
    s.maxHealth *= s.healthMult;
    if (s.critEdge !== 1) s.critMult = 1 + (s.critMult - 1) * s.critEdge;

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
    // Prey Instinct. Its own slot, multiplied *alongside* `quickfoot` rather
    // than sharing it: the two are different items with different durations and
    // different magnitudes, and writing one name made picking up the second one
    // a downgrade — a 15 s +20% window collapsing to a 0.5 s +18% one.
    const preyfoot = this.buffs.get('preyfoot');
    if (preyfoot) s.moveSpeed *= 1 + preyfoot.magnitude;
    // Aegis Emitter's dome. Armour lives here rather than on `Player.grantBuff`
    // because that call only ever *pushes* — it has no refresh semantics, so a
    // 0.7 s grant re-issued on a 0.5 s tick always had two live entries and paid
    // double the number on the card. `addBuff` refreshes in place, so the dome
    // grants exactly what it advertises and still lapses on its own once the
    // survivor steps out and the ticks stop arriving.
    const aegis = this.buffs.get('aegis');
    if (aegis) s.armor += aegis.magnitude;
    // Scrap Bandolier — a short, hard cooldown cut on a kill.
    const quickhands = this.buffs.get('quickhands');
    if (quickhands) s.cooldownMult *= quickhands.magnitude;
    // Chronal Governor — a stacking cut that decays if the killing stops.
    const overclock = this.buffs.get('overclock');
    if (overclock) s.cooldownMult *= Math.max(0.15, 1 - overclock.stacks * overclock.magnitude);
    if (this.buffs.has('nocooldown')) s.cooldownMult = 0;

    // Every move-speed contribution has now landed — item `stat` functions and
    // the three buff slots above — so this is the one place the *aggregate*
    // sustained multiplier exists. Soften it here rather than per item: a
    // per-item curve would make pickup order matter and would punish a single
    // Mercury Anklet as hard as the eighth Cloven Hoof. See `softenMove`.
    //
    // The curve takes the *gains* only; costs are multiplied onto the result
    // afterwards, at full proportional strength. Both halves are products, so
    // the separation costs nothing in order-independence.
    s.moveSpeed = softenMove(base.moveSpeed, s.moveSpeed) * s.moveSpeedPenalty;

    if (s.noDefensive) { s.blockChance = 0; s.flatReduction = 0; }
    if (s.noRegen) s.healthRegen = 0;

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

  baseDamage() { return this._owner()?.stats?.damage || 12; }

  addPermanentHealth(amount, cap) {
    if (this.permanentHealth >= cap) return;
    this.permanentHealth = Math.min(cap, this.permanentHealth + amount);
    this._dirty = true;
  }

  // ------------------------------------------------------------------ buffs

  /**
   * Apply or refresh a named buff.
   *
   * Re-application overwrites `magnitude` and `remaining` rather than merging
   * them, which is what makes the buff *name* a shared slot: two items writing
   * the same name will clobber each other, and the second one is not
   * necessarily the better one. Callers own that — pick a name nobody else
   * uses. (Taking `Math.max` of both fields here looks like the general fix and
   * is not: it would let a large short buff inherit a small long one's timer,
   * which is a bigger lie than the collision it repairs.)
   *
   * `remaining` is not an input to `stats`, so a refresh that changes only the
   * timer does not dirty the cache. That matters: Prey Instinct re-applies
   * every fixed step while the player is below 40% health, and dirtying
   * unconditionally rebuilt the whole stat block 60 times a second (+82% of the
   * per-step item cost, measured) to produce the identical answer.
   */
  addBuff(name, duration, maxStacks = 1, magnitude = 1) {
    let b = this.buffs.get(name);
    if (!b) { b = { stacks: 0, remaining: 0, magnitude }; this.buffs.set(name, b); }
    const stacks = Math.min(maxStacks, b.stacks + 1);
    if (stacks !== b.stacks || magnitude !== b.magnitude) this._dirty = true;
    b.stacks = stacks;
    b.remaining = duration;
    b.magnitude = magnitude;
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

  /**
   * A lingering ground hazard. Spore Sac leaves one on every kill.
   *
   * This is the one shared hazard primitive in the game, and it used to be
   * *only* Spore Sac's: hardcoded `type: 'spore'`, a hardcoded green ring, and
   * no way to apply a status. Every later caller inherited that — CINDER's Pyre
   * Flask left a "burning" pyre that neither burned nor looked like fire, and
   * Emberwake's cinder patch drew as spore green. The options bag fixes both
   * without each caller re-implementing the bounded overlap accounting:
   *
   *   status  a Combat status applied to anything standing in it
   *   colour  the ring drawn each tick
   *   type    the damage type, which is what item hooks and VFX read
   */
  addCloud(position, radius, duration, dps, opts = null) {
    if (!this.ctx.authority || !position) return;
    // Bounded, because a horde death can leave dozens in a second and each one
    // is an overlap query per fixed step.
    if (this._clouds.length >= MAX_CLOUDS) this._clouds.shift();
    // A real Vector3 clone, not a {x,y,z} literal: VFX and Combat both take
    // this straight into `copy`/`distanceTo`, and a bare object works for some
    // of those calls and not others.
    this._clouds.push({
      at: position.clone(),
      radius,
      remaining: duration,
      dps,
      t: 0,
      status: opts?.status || null,
      colour: opts?.colour ?? CLOUD_COLOUR,
      type: opts?.type || 'spore',
    });
  }

  addBarrier(amount) {
    const p = this._owner();
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

  /** Frenzy-style windowed kill counting. True once the threshold is met. */
  tallyKillWindow(threshold, window) {
    const now = this.ctx.time;
    this._killWindow.push(now);
    while (this._killWindow.length && now - this._killWindow[0] > window) this._killWindow.shift();
    if (this._killWindow.length >= threshold) { this._killWindow.length = 0; return true; }
    return false;
  }

  /**
   * Horizontal launch speed banked for the jump that is being resolved.
   *
   * This sums. It used to be `Math.max`, which made the channel
   * winner-takes-all: `linear(10, n) > linear(5, n)` for every n, so a single
   * Waxed Wing silently deleted Updraft Vents' entire movement clause (20.15
   * m/s held together, exactly the 20.15 of the Wing alone) and Tectonic
   * Heart's 6 m/s throw with it. Three cards write here and two of them could
   * never be read; one of those two has only the one clause.
   *
   * Summed rather than summed-and-capped on purpose. A cap has to be a number,
   * and any number low enough to matter clips Waxed Wing's own printed
   * linearity before it clips a combination — the card's contract is +10 m/s a
   * stack with no ceiling, and the largest single contributor was already
   * unbounded under `Math.max`. Summing therefore adds no new order of
   * magnitude, it only lets the smaller cards reach the number at all.
   */
  applyImpulse(speed) { this._pendingImpulse += speed; }
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
   * recharge for one charge, already scaled by Dry Cell. Draw the sweep from
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
    const mult = this._owner()?.stats?.equipCooldownMult ?? 1;
    // Floored well above zero: an equipment that comes back instantly is a
    // fifth ability, and the tier's identity is that it is a decision.
    return Math.max(2, def.cooldown * mult);
  }

  equipmentMaxCharges() {
    if (!this.equipmentId) return 0;
    return 1 + Math.max(0, Math.round(this._owner()?.stats?.equipCharges || 0));
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
      id: next, previous, charges: this.equipCharges, cooldown: 0, owner: this._owner(),
    });
    // The tier goes over as its *name*, not as a raw ladder index: `2` used to
    // be written here, which is the legendary rung, and it bypassed the tier
    // map that every other pickup goes through.
    //
    // A satellite is silent: the cue belongs to the machine whose slot filled,
    // and this host is not it. (Nothing plays it on the owning peer either —
    // `Audio` subscribes to `itemPickup`, not to `equipmentChanged`, and a
    // client's own `setEquipment` returns at the authority gate above. That gap
    // predates per-pawn economy and is left where it is rather than widened
    // into a cue this host plays on a teammate's behalf.)
    if (next && !this.owner) this.ctx.audio?.play?.('pickup', null, 'equipment');
    return previous;
  }

  /**
   * Fire the held equipment.
   *
   * Host only: an equipment use spends a charge, deals damage and rolls procs,
   * all of which are game state. A client pressing F therefore does nothing
   * locally and does not desync; the press reaches the host as `BTN.EQUIP` on
   * the command stream and is spent there, against this pawn's own instance,
   * by `Coop.fixedUpdate` — the same request-not-action shape as `BTN.INTERACT`.
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
    api.player = this._owner();
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
    const bonus = 1 + (this._owner()?.stats?.procBonus || 0);
    const p = Math.min(1, chance * (procCoefficient ?? 1) * bonus);
    if (p <= 0) return false;
    const luck = Math.max(0, Math.floor(this._owner()?.stats?.luck || 0));
    const rng = this._rng();
    for (let i = 0; i <= luck; i++) if (rng.next() < p) return true;
    return false;
  }

  // ------------------------------------------------------------ hook dispatch

  _fire(hook, payload, procCoefficient, procDepth) {
    const list = this._hooks[hook];
    if (!list.length) return;
    const api = this._api;
    api.combat = this.ctx.combat;
    api.player = this._owner();
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

  /**
   * Conditional damage multipliers. Called from Combat before mitigation.
   *
   * Fully multiplicative, deliberately and with the ceiling measured rather
   * than assumed. Eleven items carry an `outgoing` hook; ten stacks of each
   * multiply to x172.8 on a healthy player against a clean target, and to
   * x5443.2 at 20% health against a target that is burning, bleeding and
   * slowed — before crit, before proc chains, before Shrapnel Heart. That is
   * the genre's shape and it is the reason a minute-25 inventory feels like a
   * different game than a minute-5 one, so it is kept.
   *
   * What is worth knowing if a ceiling is ever wanted: the tail is short. Two
   * cards — Chipped Whetstone at 8x and Entropy Ledger at 9x — are x72 of the
   * x172.8 on their own, so a cap belongs on the individual conditional
   * multipliers, not on this product.
   */
  modifyOutgoing(amount, target, info, combat) {
    const list = this._hooks.outgoing;
    if (!list.length) return amount;
    const api = this._api;
    api.combat = combat;
    api.player = this._owner();
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

    // Corruption's share, folded into the same draw. Computed off the table's
    // own total so it is 4% whatever scale the caller's weights are on, and
    // offered only to tables that can pay an ordinary tier — a boss or lunar
    // pool names one tier and keeps it.
    if (entries.some((e) => ORDINARY_TIERS.includes(e.tier)) && ITEMS_BY_TIER.blight?.length) {
      let total = 0;
      for (const e of entries) total += e.weight;
      // share = w / (total + w)  =>  w = total * share / (1 - share)
      entries.push({ tier: 'blight', weight: total * BLIGHT_SHARE / (1 - BLIGHT_SHARE) });
    }
    return this._rng().weighted(entries).tier;
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
    // A corruption that has already been rolled survives Caprice. Letting
    // Caprice overwrite it would mean the artifact silently deletes the whole
    // tier from the run, which is not what "the shelf is re-rolled" promises.
    if (art?.has('caprice') && t !== 'blight') t = art.capriceTier();
    const pool = ITEMS_BY_TIER[t] || ITEMS_BY_TIER.common;
    if (!pool.length) return null;
    // Command: this is the single funnel every random item id in the game comes
    // out of, which is why the choice is installed here and not in the six
    // callers that would otherwise each need to know about it.
    if (art?.has('command')) return art.commandPick(t, pool);
    return this._rng().pick(pool).id;
  }

  /**
   * The argent cards a Consecration is offering — the whole door into the tier
   * (issue #173).
   *
   * The rung used to draw one blind card at the press. It could not do anything
   * else: the only stream available was `ctx.rng`, `prompt()` runs off the
   * render loop, and a card named before the press therefore made the run's
   * random sequence a function of frame rate. So purity's most expensive
   * purchase was the one thing in the game you bought without being told what
   * it was, while corruption previews every outcome it charges for.
   *
   * The answer is a stream of its own, in the salted `(seed ^ salt) >>> 0 || 1`
   * shape the altar's placement and the per-band mutation windows already use.
   * Nothing here touches `ctx.rng`, so the sp-equivalence claim the tier was
   * built on gets *stronger* rather than weaker: an argent offer previewed
   * every frame for ten minutes moves the gameplay stream exactly as far as a
   * run that never banks a mote — nowhere.
   *
   * Consequences worth stating, because they are the feature:
   *  · pure in `key` — the same altar re-derives the same cards after a save,
   *    a HUD rebuild, or a hundred re-renders;
   *  · no authority gate, unlike a draw. There is nothing to arbitrate: a
   *    client computes the same three ids off the same seed, so a guest's
   *    prompt and the host's agree without a byte on the wire;
   *  · sampled without replacement, so an offer never quotes one card twice.
   */
  previewArgent(count = 3, key = 0) {
    const pool = ITEMS_BY_TIER.argent;
    if (!pool?.length) return [];
    const rng = new RNG(saltedSeed(this.ctx.seed, key, 0x85ebca6b) || 1);
    const bag = pool.slice();
    const out = [];
    const n = Math.min(Math.max(1, count | 0), bag.length);
    for (let i = 0; i < n; i++) out.push(bag.splice(rng.int(0, bag.length - 1), 1)[0].id);
    return out;
  }

  /**
   * Is there an argent card to be had at all? The cheap question the offer asks
   * before it bothers deriving a preview. A prompt may ask this every frame
   * forever and `ctx.rng` never moves.
   */
  argentStocked() {
    return !!ITEMS_BY_TIER.argent?.length;
  }

  /** One equipment id off the equipment pool — what a barrel hands out. */
  rollEquipment() {
    if (!this.ctx.authority) return null;
    return this._rng().pick(EQUIPMENT).id;
  }

  /**
   * Convenience for the world: roll a drop and put it straight in the slot or
   * the inventory, whichever the id belongs to. This is what an equipment
   * barrel calls, and it is here rather than in the barrel so that "equipment
   * replaces, items accumulate" is stated once.
   */
  /**
   * Record a corrupted synergy bought at a Void Bargain.
   *
   * Deliberately not an `addBuff` with the grant's magnitude baked in, which is
   * what this used to be: a buff is a frozen number, and a frozen number is the
   * exact shape of the laundering the tier now forbids — buy the synergy deep,
   * scrub the gauge clean, keep every point of it. The id is what is permanent;
   * the strength is re-read off the live gauge in `stats`.
   */
  grantSynergy(synergy) {
    if (!synergy?.id) return false;
    this._synergies.add(synergy.id);
    this._dirty = true;
    return true;
  }

  /** Ids of the corrupted synergies this pack has bought. */
  synergies() { return [...this._synergies]; }

  grant(id) {
    if (!this.ctx.authority || !id) return null;
    if (EQUIPMENT_BY_ID.has(id)) return this.setEquipment(id);
    return this.give(id, 1);
  }

  // ------------------------------------------------------------------ update

  fixedUpdate(ctx, h) {
    // Collect the tolls the gauge claimed since the last step, in threshold
    // order, outside any event dispatch. Host-only by construction — the
    // `corruptionBand` listener never queues on a client — and deterministic:
    // the queue is FIFO and each band's pick comes off its own derived stream.
    // `_mutateAt`'s writes are all `'corrupt'`, which Corruption ignores, so
    // nothing can re-enter this queue while it drains.
    //
    // The lever (issue #33) sits in front of that drain: a threshold with a
    // field worth choosing from opens a window instead of paying immediately,
    // and the queue stalls behind it — one open offer at a time, so a two-band
    // jump asks twice rather than stacking two cards. The window resolves on
    // its own clock (real seconds off the fixed step, the same clock the
    // pickup banner runs on) and a fresh threshold arriving on top of an open
    // one closes it as a refusal, which pays the older band exactly as the
    // void would have.
    if (this._muteChoice) {
      this._muteChoice.remaining -= h;
      if (this._muteChoice.remaining <= 0) this.refuseMutation('timeout');
      else if (this._muteQueue.length) this.refuseMutation('superseded');
    }
    // The client's copy of that clock, and nothing else: it counts the panel's
    // number down and stops at zero. It never resolves anything — a client that
    // paid its own toll on its own clock would be a second, lagged authority
    // over the one inventory the host is about to correct — so the window
    // simply stands, showing 0s, until the host's close arrives.
    if (this._muteOffer && this._muteOffer.remaining > 0) {
      this._muteOffer.remaining = Math.max(0, this._muteOffer.remaining - h);
    }
    while (!this._muteChoice && this._muteQueue.length) {
      const band = this._muteQueue.shift();
      if (!this._openMutationChoice(band)) this._mutateAt(band);
    }

    for (const [name, b] of this.buffs) {
      b.remaining -= h;
      if (b.remaining <= 0) { this.buffs.delete(name); this._dirty = true; }
    }

    // The blight activation curve is the one input to `stats` that moves
    // without anybody touching the inventory, so it is the one input the
    // `_dirty` flag cannot learn about on its own. Watching it here is what
    // keeps a cleansed pack from reading its Overrun stat block for the rest of
    // the run. Quantised to a thousandth: the comparison has to be cheap and a
    // sub-0.1% move in a payoff is not worth rebuilding the block for.
    const bg = Math.round(blightGrace(this.ctx) * 1000);
    if (bg !== this._blightGrace) { this._blightGrace = bg; this._dirty = true; }

    // Barrier decays so it reads as a temporary reward, not a second health bar.
    // The owner's barrier: a satellite grants onto its own pawn (`addBarrier`),
    // so it must decay the same shield rather than shaving the viewer's.
    const p = this._owner();
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
   * parallel timer, Dry Cell would refill the whole bank in one cooldown and
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
    // The viewer's own recharge only. `Coop.fixedUpdate` pumps this for every
    // satellite, and a teammate's slot coming back is not a cue this machine's
    // speakers owe anyone — the same guard `setEquipment` already carries.
    if (!this.owner) this.ctx.audio?.play?.('coin');
  }

  /** Timed equipment effects (drone, meteor storm, crown). */
  _tickEffects(ctx, h) {
    if (!this._effects.length) return;
    const api = this._api;
    api.combat = ctx.combat;
    api.player = this._owner();
    api.count = 1;
    api.procCoefficient = 1;
    api.procDepth = 1;
    for (let i = this._effects.length - 1; i >= 0; i--) {
      const e = this._effects[i];
      e.remaining -= h;
      e.t -= h;
      if (e.t <= 0 && api.player?.alive) {
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
    // Whose cloud this is. `source` decides who the kill is credited to and who
    // a retaliation hook answers, so a satellite's flask must name its own pawn.
    const owner = this._owner();
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
            source: owner, position: t.position, type: c.type,
            procCoefficient: 0, procDepth: 2, isDot: true,
          });
          // Two overlapping clouds do each pay their own damage tick, so a body
          // standing in two Pyre Flasks takes twice the printed dps. Measured
          // and kept. Every other overlapping AoE in the game pays per source,
          // the flask has two charges precisely so that overlapping them is a
          // decision worth making, and halving the second cloud would make the
          // second charge worth nothing. What must not stack is the *status* —
          // that is the next line, and it is verified: peak 1 burn stack with 2
          // clouds alive.
          //
          // Topped up rather than stacked: a body standing in an 8 s pyre would
          // otherwise collect sixteen independent burn stacks and turn a setup
          // tool into the biggest DoT in the game. "Everything in the fire is
          // burning" is the contract the ability describes and the one
          // Conflagration and Afflictor's Index need — one live stack does it.
          if (c.status && t.alive && !combat.hasStatus(t, c.status)) {
            combat.applyStatus(t, c.status, owner, 1);
          }
        }
        // Purely cosmetic — never draws off `ctx.rng`, so it cannot desync.
        ctx.vfx?.ring?.(c.at, c.radius, c.colour);
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
   *
   * The *local viewer's* press only. `ctx.input` is this machine's keyboard, so
   * a satellite must never be pumped through here — that would let the host's F
   * fire every teammate's slot. A remote pawn's press arrives as `BTN.EQUIP` and
   * is resolved by `Coop.fixedUpdate`.
   */
  update(ctx) {
    if (ctx.paused) return;
    if (ctx.input?.hit?.(EQUIP_KEY)) this.useEquipment();
  }
}

// Inventory sort order. Lunar sits after Boss because it is the tier the player
// chose to take a downside for, and it should read last rather than be buried
// among the whites.
// Blight sits after Lunar for the same reason Lunar sits after Boss: it is the
// tier the player took a risk on, and it reads as an answer to the run rather
// than as part of the ladder. It must also be the last *item* tier, because the
// cards above it in the strip are the ones it ate out of.
// Argent sits after Blight and before Equipment, matching `CONTENT_TIERS` in
// `src/ui/Icons.js`: it is the answer to the run that Blight is the risk on,
// and equipment is hardware rather than a card. An unlisted tier here is not a
// cosmetic fault — the comparator subtracts undefined, the NaN makes every
// comparison false, and the whole strip falls back to a name sort.
const TIER_ORDER = { common: 0, uncommon: 1, legendary: 2, boss: 3, lunar: 4, blight: 5, argent: 6, equipment: 7 };
const BASE_KEYS = ['maxHealth', 'healthRegen', 'moveSpeed', 'attackSpeed', 'damage',
  'critChance', 'critMult', 'armor', 'cooldownMult', 'jumpCount'];

/**
 * Where sustained movement speed stops being free (#188).
 *
 * A stacked movement build did not become *strong*, it became unsteerable: at
 * eight Cloven Hoof the survivor covers a whole arena between two of the
 * player's decisions, and the camera, the dodge distances and the enemy lead
 * times are all tuned around something near base. The knee is the point past
 * which extra speed is bought at a rising price.
 *
 * 1.45 is chosen against the *commons*, deliberately: three Cloven Hoof is
 * +42%, three Runner's Chalk is +15%, and neither the normal mid-run build nor
 * any mix of three movement commons reaches the knee. A player who took the
 * movement commons on offer feels literally nothing — the curve is identity,
 * not merely gentle. One Mercury Anklet lands at 1.50, a hair over, and keeps
 * essentially all of its +50%: the item that is *meant* to be a shock still is.
 */
export const MOVE_KNEE = 1.45;

/**
 * Headroom above the knee. The curve approaches `MOVE_KNEE + MOVE_SPAN` and
 * never reaches it, so 2.95x base is an asymptote rather than a cap: every
 * further stack is still worth something, which is the whole point of not
 * clamping. At 12 Cloven Hoof a thirteenth is still +0.29 m/s on a 7.0 base.
 */
export const MOVE_SPAN = 1.5;

/**
 * Soften the aggregate sustained move-speed *gain* multiplier.
 *
 * Gains only. Costs — anything that multiplies movement speed by less than
 * one, which today is Slag Ingot alone — accumulate in `moveSpeedPenalty` and
 * are applied to this function's result by the caller, never to its input.
 * That split is not cosmetic: the curve compresses everything above the knee
 * toward the asymptote, so a cost folded in with the gains shrinks as the
 * stack around it deepens. Measured on the first cut of this curve, a Slag
 * Ingot kept 57% of its bite at eight Cloven Hoof and 18% at twenty — the
 * deeper the build, the cheaper its drawbacks, which is precisely backwards.
 * Applied afterwards, a cost always removes the exact fraction it advertises.
 *
 * Below the knee this is the identity function — bit-for-bit, not
 * approximately, so no existing build's number moves. Above it the excess is
 * passed through `e -> e / (1 + e / SPAN)`, whose derivative
 * `1 / (1 + e/SPAN)^2` is positive everywhere and strictly falling: monotone
 * increasing (more items are never worse) with diminishing returns (each one
 * is worth less than the last), and no dead pickups at any stack count.
 *
 * The *aggregate* is the input, so this is order-independent in the same sense
 * as `damageMult` and `critEdge` above.
 *
 * Burst movement — dashes, vaults, jump stats — never reaches here. Those are
 * skill-side and stay linear (#188 scope). The two short buffs that *are* pure
 * move-speed multipliers, Bloodied Spurs' `quickfoot` and Prey Instinct's
 * `preyfoot`, do enter the aggregate: they multiply the same steering problem
 * the knee exists to bound, and they land on top of exactly the stacked build
 * that is already past it. A 3 s window on a base build is still fully linear
 * (1.20 is under the knee); only the window stacked on eight Hoof is trimmed.
 */
export function softenMove(baseSpeed, speed) {
  if (!(baseSpeed > 0) || !(speed > baseSpeed * MOVE_KNEE)) return speed;
  const excess = speed / baseSpeed - MOVE_KNEE;
  return baseSpeed * (MOVE_KNEE + excess / (1 + excess / MOVE_SPAN));
}

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
// The default ring colour, i.e. Spore Sac green. Callers that are not spores
// pass their own through `addCloud`'s options bag.
const CLOUD_COLOUR = 0x9fdc6a;

export { ITEMS, ITEM_BY_ID, TIERS, hyperbolic, EQUIPMENT, EQUIPMENT_BY_ID };
