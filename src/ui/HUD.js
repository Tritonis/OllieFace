import * as THREE from 'three';
import { clamp, damp, invLerp } from '../core/MathUtil.js';
import { ITEM_BY_ID, grace, blightGrace } from '../data/items.js';
// The affix keys are internal ids (three are RoR2's elite prefixes verbatim);
// only the label may reach the screen. tests/branding-display.test.mjs pins it.
import { ELITE_STATS } from '../data/enemies.js';
// Tuning data, not the system: the band names and the top of the gauge come
// from the same table `Corruption` bands against. The value itself is read
// through `ctx.corruption`.
// `MUTATION` and `pressureAt` join them for the gauge's forecast line: what a
// crossing *does* has to be read off the same tuning the systems obey, or the
// gauge is a second copy of the rules that can drift from the first.
import { BANDS, MUTATION, pressureAt } from '../data/corruption.js';
// Downed & revive (mp-p3) tuning: the one table both `Revive` (host) and this
// file read, so the client-side revive-ring approximation below times itself
// off the same numbers the host's clock actually runs on.
import { REVIVE } from '../data/revive.js';
// The same routing table the finale portals are built from, read here only to
// name the door the current band is buying. The HUD spawns nothing.
import { routesFor } from '../data/realms.js';
// A constant, not the system: the key the equipment slot is bound to is decided
// in one place (`Items`) and printed in another, and hardcoding 'F' here is how
// a rebind ships a HUD that lies about its own controls. Nothing else about
// Items is imported — the slot itself is read through `ctx.items`.
import { EQUIPMENT_KEY_LABEL } from '../systems/Items.js';
// ...and the live map that says which key that actually is right now.
import { bindings, keyLabel } from '../core/Bindings.js';
import { glyphLabel, DEFAULT_GLYPH_SET } from '../data/glyphs.js';
// The eligibility question the revive prompt asks about its own viewer, and
// the button the hold is spelled with on the wire. Both are read here for the
// same reason `EQUIPMENT_KEY_LABEL` is: the rule lives in one place (`Revive`,
// through `Roster.targetable` and `BTN.INTERACT`) and is only *printed* here.
import { Roster } from '../systems/Roster.js';
import { BTN } from '../net/Protocol.js';
import { abilityIcon, abilityArt, equipmentArt, itemArt, hexOf, CONTENT_TIERS, tracePathFrom } from './Icons.js';
import { Tooltip, describeItem, prettify } from './Tooltip.js';
import { Announcer } from './Announcer.js';
import { Tutorial } from '../systems/Tutorial.js';
import { isLocalVictim, isLocalKill, isLocalOwner } from '../core/Engine.js';

/**
 * The HUD. DOM + CSS rather than canvas so text stays crisp at any DPI.
 *
 * Everything reads through `ctx.<system>?.` — other systems come up in their
 * own time and the HUD has to render sensible placeholders until they do.
 *
 * Per-frame cost is kept near zero by diffing every value against `this.c`
 * before touching the DOM, and by animating with transforms/opacity only.
 */

// How long the inventory strip's screen rect is re-measured for after anything
// disturbs it; see `updateStripRect`.
//
// Counted in seconds, not HUD frames. It used to be 60 frames, which reads as
// "the next second" only at exactly 60 fps — 2 s at 30, 0.42 s at 144. Too
// short and the window closes while the tiles are still animating in, leaving
// the numeral clip on a stale rect; too long and every frame of it costs a
// forced layout flush.
const STRIP_HOLD_SEC = 1.0;

const SLOTS = [
  { id: 'primary', key: 'M1', label: 'Primary' },
  { id: 'secondary', key: 'M2', label: 'Secondary' },
  // Q, not Shift — Shift is held-sprint, so the dash needs its own key.
  { id: 'utility', key: 'Q', label: 'Utility' },
  { id: 'special', key: 'R', label: 'Special' },
];

// The escalation ladder as the HUD shows it. `t` is the difficulty coefficient
// at which the tier begins; the meter fills across the span to the next one.
//
// Names match `Director.DIFFICULTY_NAMES`. The thresholds deliberately do not
// and never have — the HUD's are wider, so the meter spends longer filling each
// band than the Director spends in it. Renaming did not touch either set.
const DIFFICULTY = [
  { t: 0.0, name: 'Stable', color: '#7fd4ff' },
  { t: 1.6, name: 'Shifting', color: '#8ef08a' },
  { t: 2.6, name: 'Straining', color: '#e9e46b' },
  { t: 4.0, name: 'Fracturing', color: '#ffb44f' },
  { t: 6.0, name: 'Faulting', color: '#ff7a45' },
  { t: 9.0, name: 'Collapse', color: '#ff4634' },
  { t: 13.0, name: 'The Ground Remembers', color: '#ff3ac6' },
  { t: 18.0, name: 'It Is Opening', color: '#b44dff' },
  { t: 25.0, name: 'SWALLOWED', color: '#ff1414' },
];

const NOTCHES = 10;
const DIR_SLOTS = 6;

// Cooldowns shorter than this get no darkening sweep — see `updateAbilities`.
const SWEEP_MIN_CD = 0.75;
// ...and below this much remaining, neither the sweep nor the numeral shows.
// The two share one threshold so a swept slot can never lack its readout.
const TIMER_MIN = 0.2;
// A slot is 5.2em wide. Past five pips the row stops being countable, so the
// remainder becomes a "+N" rather than spilling across the neighbouring slots.
const PIP_CAP = 5;
// Tiles per inventory row. 12 * (2.6em tile + 0.28em gap) fits the 460px cap
// `.inventory` sets; see `onItemPickup` for why the rows are explicit.
const INV_ROW = 12;

/* The gauge's chart recorder. A run's corruption history is the one piece of
   state the HUD holds that the world itself does not — Corruption.js knows the
   number now, nobody knows the shape of how it got there. 48 samples at 1.5 s
   is 72 seconds of trailing history: long enough that a chest opening shows as
   a step, short enough that the pen keeps moving. */
const TRACE_SAMPLES = 48;
const TRACE_INTERVAL = 1.5;

/* How long the gauge's forecast line is held still after the first feed of a
   run. It is a reading hold, not a pause: the fill, the pen and the band label
   all keep running underneath it, and the number in the sentence stops chasing
   itself for exactly as long as it takes to read one line. Six seconds is two
   unhurried reads at the pace the rest of the HUD's toasts live at (5 s). */
export const CORRUPTION_PRIMER_S = 6;

// Downed & revive (mp-p3). The revive ring's SVG circumference (radius 42 in
// a 100x100 viewBox), matching `.tp-arc`'s own hardcoded-radius idiom.
const REVIVE_ARC_C = 2 * Math.PI * 42;
// A defensive margin against `Snapshot.sample`'s `healthFrac` lerp across the
// DOWNED<->ALIVE boundary (progress.md, Task 4->5 carry): `state` itself snaps
// to the newer record and never blends, so this has not been observed to
// flicker, but the brief asks for the ring to hold rather than to touch
// `Snapshot.sample` if it ever does. Two frames at 60Hz.
const REVIVE_HOLD_S = 0.09;
// How far a *client's* ring is allowed to travel on its own evidence. The
// fraction never crosses the wire, so the client integrates the local hold
// against its own mirror of the host's eligibility test — an approximation
// that may be wrong, and must therefore never render as a completed revive.
// The pawn standing up is the only authoritative "done", and it takes the
// whole prompt with it. See `reviveFraction`.
const CLIENT_RING_CAP = 0.95;

// Full-bleed screens own the frame outright. A pause or settings panel is a
// sheet over a live run and the HUD behind it is still that run's state, but
// the title, the survivor select, the logbook and the summary each fill the
// viewport — leaving the corners of the HUD poking out from behind one of them
// is two interfaces at once.
const FULL_SCREENS = new Set(['title', 'death', 'select', 'logbook', 'difficulty', 'artifacts']);

/**
 * One proxy per menus object, so the identity the HUD hands out is stable and
 * the `Proxy` is built once rather than on every `this.menus` read — the
 * update phase takes several a frame.
 */
const BILLED = new WeakMap();

/**
 * Wrap `menus` so every call the HUD makes into it is billed to `Menus` (#120).
 *
 * The HUD's event handlers run inside the *emitting* system's phase:
 * `showPickup` is reached from `Items.update`, `showDeath` from `Player`,
 * `showMutationChoice` from `Items` again. The Engine bills a throw to the
 * phase it escaped, so a menu defect on any of those paths was charged to a
 * CRITICAL system and halted the run — the exact outcome #118 removed for the
 * update path, surviving on the event path.
 *
 * The seam is here rather than on each handler because every route into the
 * menus from this file goes through `this.menus`: the three above, `close`,
 * `hideMutationChoice`, and whatever the next one is. Property reads are
 * untouched — `menus.screen` and `menus.root` are plain state.
 */
function billed(menus, ctx) {
  let proxy = BILLED.get(menus);
  if (proxy) return proxy;
  proxy = new Proxy(menus, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function billedCall(...args) {
        const engine = ctx?.engine;
        // No engine to bill (tests, boot) means no accounting to do — call it
        // straight, so a throw still surfaces rather than being swallowed by
        // a mechanism that exists to attribute it.
        if (!engine?.callInto) return Reflect.apply(value, target, args);
        return engine.callInto(target, String(prop), () => Reflect.apply(value, target, args));
      };
    },
  });
  BILLED.set(menus, proxy);
  return proxy;
}

export class HUD {
  // Reads state and draws it, and owns none of it. A blind player is a degraded
  // player, not a desynced one, and ending their run over a gauge would be the
  // worse trade.
  static critical = false;

  /**
   * The menus, read off `ctx` rather than held — so that when the Engine gives
   * up on `Menus` and `remove()` blanks `ctx.menus`, this goes null with it and
   * the HUD stops calling into a system nobody is running any more. Every use
   * below is `?.`-guarded for that window.
   *
   * The setter exists for tests that build a HUD off the prototype and hand it
   * a stub; a getter alone would make `hud.menus = stub` a TypeError in strict
   * mode. A stub set that way keeps winning only while there is no live
   * `ctx.menus` to prefer.
   */
  get menus() {
    const m = this.ctx?.menus ?? this._menus ?? null;
    return m ? billed(m, this.ctx) : null;
  }
  set menus(m) { this._menus = m; }

  init(ctx) {
    this.ctx = ctx;
    ctx.hud = this;

    this.root = document.getElementById('hud');
    this.root.innerHTML = TEMPLATE(SLOTS, NOTCHES, DIR_SLOTS);
    this.$ = (sel) => this.root.querySelector(sel);
    this.refs = collectRefs(this.root);

    this.tooltip = new Tooltip(ctx, this.root);
    // `Menus` is registered ahead of this system in `main.js` and is no longer
    // constructed here (#118): it is billed for its own throws now.
    // After `Menus`, which is what publishes `ctx.settings` — the announcer
    // reads `settings.captions` off it live.
    this.announcer = new Announcer(ctx, { live: this.refs.live, caption: this.refs.caption });
    // After `Menus` for the same reason: the prompts name the player's chosen
    // glyph set, which lives on `ctx.settings`. Published on `ctx` so the pause
    // screen's Skip has something to call.
    this.tutorial = new Tutorial(ctx, { line: this.refs.tutorial });
    ctx.tutorial = this.tutorial;

    // Cached DOM values — the diff target for every write below.
    this.c = {};
    this.ghost = 1;          // delayed-damage bar, drains toward the real value
    this.moneyShown = 0;     // rolling counter
    this.hurtFlash = 0;
    this.lowPulse = 0;
    this.abilityReady = SLOTS.map(() => true);
    this.equipReady = true;
    this.dirs = [];          // fallback damage-direction ledger
    this.toasts = [];
    this.inv = new Map();    // id -> { el, badge, count, tier }
    this.boss = null;
    this.tpProgress = -1;
    this.tpFound = false;    // stops the objective chevron once the event ends
    this.objective = '';
    this.stageName = '';
    this.stageIndex = 1;
    this.stats = { kills: 0, damage: 0 };
    this.hoverId = null;
    // Screen rect of the inventory strip, read by VFX's numeral clip.
    this.stripRect = null;
    this._stripHoldT = STRIP_HOLD_SEC;
    this.tmp = new THREE.Vector3();
    this.tmpF = new THREE.Vector3();

    // Downed & revive (mp-p3) presentation state.
    this._reviveHeld = null;      // last non-null revive target, held across REVIVE_HOLD_S
    this._reviveMissT = 0;
    this._reviveClientTarget = null;
    this._reviveClientT = 0;      // client-side approximation of the downed pawn's `revive` fraction

    this.buildSlots();
    this.syncEquipment();
    this.bind(ctx);
    this.setObjective('Find and activate the teleporter');
  }

  // -------------------------------------------------------------- wiring

  /**
   * Paint the four skill tiles for whichever survivor is live.
   *
   * The icons used to be four *slot* glyphs baked once at init, so M1 drew the
   * same three-round burst whether the button fired a carbine, a hammer, a
   * rifle or a rivet gun — the tile carried the thing the key chip under it
   * already said. Now each tile carries its ability's own emblem in the
   * survivor's accent, and this is called again on `survivorChanged`.
   */
  buildSlots() {
    const p = this.ctx.player;
    const accent = hexOf(p?.survivor?.accentColor, '#dfe9f7');
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i];
      const ref = this.refs.slots[i];
      if (!ref?.icon) continue;
      const ability = p?.slots?.[i]?.ability;
      ref.icon.src = ability ? abilityArt(ability.id, s.id, accent) : abilityIcon(s.id);
      if (ability?.name) {
        ref.name.textContent = shortName(ability.name);
        this.c[`aname${i}`] = shortName(ability.name);
      }
    }
    this.root.style.setProperty('--accent', accent);
  }

  bind(ctx) {
    const on = (name, fn) => ctx.events.on(name, fn);

    on('playerHurt', ({ amount }) => {
      this.hurtFlash = 1;
      this.pulse(this.refs.hpFlash, 'is-hit');
      if (amount > 0) this.pulse(this.refs.hpBar, 'is-shake');
    });

    on('damage', (e) => {
      const player = ctx.player;
      if (e?.target && player && e.target === player) {
        // Fallback direction ledger when VFX hasn't published one.
        const p = e.position || e.source?.position;
        if (p) this.dirs.push({ position: p.clone ? p.clone() : p, life: 1 });
        if (this.dirs.length > DIR_SLOTS) this.dirs.shift();
        return;
      }
      if (e?.source && (e.source === player || e.source?.isPlayer)) {
        this.stats.damage += e.amount || 0;
        this.pulse(this.refs.reticle, e.crit ? 'is-crit' : 'is-hit');
      }
    });

    on('kill', (e) => {
      // Three clauses, because the HUD needs a *narrower* rule than the run
      // summary and `isLocalKill` alone is wider than what was here before.
      //
      //  · `!e?.victim?.isPlayer` — the guard `Progression` already carries
      //    (Progression.js:126). A player dying is not a kill on anybody's
      //    counter, and without this a teammate's death flashed `is-kill` on
      //    your reticle.
      //  · the source test is HEAD `a43cc70`'s exact condition, restored. It
      //    excludes kills whose source is an *enemy* — a Galvanic death
      //    blast, an Emberclad aura, a stray mortar — which `isLocalKill`'s
      //    authority branch admits (it only excludes *other players*), because
      //    that branch was written for the run summary where an environmental
      //    kill should still count. Dropping it added +1 per enemy-on-enemy
      //    kill to the on-screen counter in **single-player**.
      //  · `isLocalKill` — L-4's rule, and the only one of the three that is
      //    about co-op: the number on your HUD is your kills, not the party's.
      //    On a client it is also the strictest of the three.
      const src = e?.source;
      const localSource = !src || src === ctx.player || src.isPlayer;
      if (!e?.victim?.isPlayer && localSource && isLocalKill(ctx, e)) {
        this.stats.kills++;
        this.pulse(this.refs.reticle, 'is-kill');
      }
      if (e?.isBoss && this.boss && e.victim === this.boss) this.clearBoss();
    });

    // The loadout changed under us — repaint the tiles rather than leaving four
    // icons describing a survivor who is no longer on the drop pod.
    on('survivorChanged', () => this.buildSlots());

    // The Q tile, the item strip and the blight toast all describe *this*
    // player's loadout. On a host every pawn's economy shares the bus, so each
    // one asks whose event it is first; in single-player they all pass.
    on('equipmentChanged', (e) => { if (isLocalOwner(ctx, e)) this.syncEquipment(); });
    on('equipmentUsed', () => {
      this.pulse(this.refs.equip.el, 'is-fire');
      this.equipReady = false;
    });

    on('itemPickup', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      this.onItemPickup(e.id, e.count, e.reason);
    });
    // The strip already repaints itself off the two `itemPickup` writes the
    // conversion rides, so this line exists only to say *why* the pack changed
    // — otherwise a stack silently vanishes and an unfamiliar one appears.
    on('itemMutated', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      const base = ITEM_BY_ID.get(e.baseId), blight = ITEM_BY_ID.get(e.blightId);
      if (!blight) return;
      // The mutation says what the pack *became*, not only what it lost: the
      // catalogue's own effect line rides on the event, so a chosen loss reads
      // as the trade the player made and an unchosen one still names its prize.
      const why = e.blightDescription ? ` — ${e.blightDescription}` : '';
      const verb = e.chosen ? 'you feed the blight' : 'festers';
      this.toast(`${base?.name || prettify(e.baseId)} ${verb} — ${e.count}x ${blight.name}${why}`, 'blight', e.blightId);
    });
    // The lever on that toll (issue #33). Host-seat only by construction —
    // `Items` opens a window for the local instance alone — but the owner test
    // is kept anyway so a future satellite offer cannot paint over this pack's.
    on('mutationChoiceOffered', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      // Two decisions share this window now (issue #204) and the kind is what
      // says which: the toll names a casualty, the Argent altar names a
      // purchase already paid for. Same slot, same clock, same answer path —
      // only the title and the faces on the cards differ.
      // A Blight Wound's seal/feed (#178) — the third kind, same slot, same
      // clock, same answer path. Its lapse is the seal, which `Wound.interact`
      // owns; nothing here has to know that.
      if (e.kind === 'wound') {
        this.menus?.showWoundChoice({
          id: `wound:${e.offerId}`,
          offers: e.offers,
          seconds: e.seconds,
          onPick: (id) => ctx.items?.chooseMutation?.(id),
        });
        return;
      }
      if (e.kind === 'argent') {
        this.menus?.showArgentChoice({
          id: `argent:${e.offerId}`,
          offers: e.offers,
          seconds: e.seconds,
          onPick: (id) => ctx.items?.chooseMutation?.(id),
        });
        return;
      }
      this.menus?.showMutationChoice({
        // Which decision this window is, so its close cannot tear down a chest
        // offer's window painted over it, nor be torn down by one. Per-band,
        // which is what a mutation window is.
        id: `mutation:${e.band}`,
        offers: e.offers,
        seconds: e.seconds,
        onPick: (id) => ctx.items?.chooseMutation?.(id),
        onRefuse: () => ctx.items?.refuseMutation?.(),
      });
    });
    on('mutationChoiceClosed', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      this.menus?.hideMutationChoice(
        e.kind === 'argent' ? `argent:${e.offerId}`
          : e.kind === 'wound' ? `wound:${e.offerId}`
            : `mutation:${e.band}`);
    });
    // The chest's three-way claim (issue #175), through the same one window the
    // blight toll uses. Owner-tested like every other addressed panel: a
    // teammate's chest is a teammate's decision, and it never reaches this
    // machine to be tested — the offer is a `_forwardOwned` send addressed to
    // the single peer holding the pawn (issue #205), so a guest raises this
    // panel over their own lid and nobody else's. The answer goes back the way
    // the blight toll's does: `chooseOffer` echoes the host's own identifier as
    // one `MSG.MUTATE`, and the host decides. A seat that never answers is
    // still lapsed safe by the host's clock — the item, unfed — which is what
    // every guest used to get, because until #205 the offer stayed home.
    //
    // The cards are built off the quote's own numbers so the panel cannot state
    // a price the transaction will not charge.
    on('itemOfferOpened', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      const q = e.quote;
      if (!q) return;
      const base = ITEM_BY_ID.get(q.itemId);
      const cards = q.outcomes.map((name) => {
        const o = q[name];
        const rewardId = o.reward?.itemId || q.itemId;
        const tier = ITEM_BY_ID.get(rewardId)?.tier || base?.tier || 'common';
        return {
          pick: name,
          art: name === 'salvage' ? '' : itemArt(rewardId, tier),
          name: name === 'safe' ? `Take ${base?.name || q.itemId}`
            : name === 'corrupt' ? (ITEM_BY_ID.get(rewardId)?.name || rewardId)
              : `Salvage ${base?.name || q.itemId}`,
          desc: name === 'corrupt' ? (o.reward?.description || '') : '',
          note: o.line || '',
        };
      });
      this.menus?.showChoice({
        id: `offer:${e.offerId}`,
        title: 'The chest offers a choice',
        cards,
        seconds: e.seconds,
        remaining: () => ctx.interactables?.openOfferFor?.(e.owner)?.remaining,
        onPick: (outcome) => ctx.interactables?.chooseOffer?.(outcome, e.owner),
      });
    });
    on('itemOfferResolved', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      // Only this offer's own window. A lapse arriving under a mutation window
      // that painted over it must not take that window down with it.
      this.menus?.hideChoice(`offer:${e.offerId}`);
    });
    // The same line, run backwards: the Argent Font's reward moves a stack out
    // of the blight tier and back into its own, and without this the strip just
    // silently reshuffles itself while the player is looking at the font.
    on('itemStabilised', (e) => {
      if (!isLocalOwner(ctx, e)) return;
      const base = ITEM_BY_ID.get(e.baseId), blight = ITEM_BY_ID.get(e.blightId);
      if (!base) return;
      this.toast(`${blight?.name || prettify(e.blightId)} settles — ${e.count}x ${base.name}`, base.tier, e.baseId);
    });
    // No owner test needed: the body is empty. The gold readout is polled off
    // `ctx.items` — the viewer's own instance — in `update`, so a teammate's
    // purse cannot reach it however loud this channel gets.
    // The purse (issue #36, D2). Marks and motes are minted and spent deep in
    // `Corruption`, and until now the only place either number appeared was the
    // altar prompt - a currency you cannot see is a currency you cannot save
    // toward. Both readouts are event-driven rather than polled in `update`:
    // the counts change a handful of times in a run, so a per-frame read would
    // be sixty diffs a second to catch one.
    //
    // No owner test, unlike the item events above: `Corruption` is a single
    // authority-side system and is not replicated, so there is exactly one
    // purse in the world and these two events are it. (A client therefore reads
    // zeroes until the gauge itself is replicated - the same standing caveat
    // `pricedPrompt` already carries.)
    //
    // The mint moment (D5). The purse is a readout, and a readout that ticks
    // during a fight is a thing nobody sees change - the causal link "I took
    // that risk, I got that" needs a line on the log at the instant it happens.
    // Only a *mint* toasts: `spent` is 0 on the mint path in `Corruption` and
    // the amount charged on both spend paths, so a purchase at the altar
    // repaints the purse and says nothing, which is right - spending is a
    // thing the player already knows they did.
    on('voidMarksChanged', (e) => {
      this.setPurse({ marks: e?.marks });
      if (isMint(e)) this.toast(`Void mark minted — ${e.marks} in hand`, 'blight');
    });
    on('argentMotesChanged', (e) => {
      this.setPurse({ motes: e?.motes });
      if (isMint(e)) this.toast(`Argent mote minted — ${e.motes} in hand`, 'lunar');
    });
    // Issue #154. The mote channel above speaks once every forty points; this
    // one speaks on every ward, which is what turns the purse from a thing that
    // surprises the player into a thing they can watch fill. Event-driven for
    // the same reason the counts are: warding moves on presses and kills, not
    // on frames.
    // Stage Vows (#177). The promise arrives as a toast because it is news, and
    // then lives on the pill because it is a standing obligation. Both verdicts
    // toast: a broken vow that vanished silently would be indistinguishable
    // from one the player had forgotten they made, and legible failure is the
    // whole reason the system can afford to cost nothing.
    on('vowOffered', (e) => {
      this.toast(`Vow — ${e?.text ?? ''}`, 'argent');
    });
    on('vowResolved', (e) => {
      if (e?.kept) this.toast(`${e.title} kept — the ward holds`, 'argent');
      else this.toast(`${e?.title ?? 'Vow'} broken`, 'common');
    });
    on('corruptionWarded', (e) => {
      this.setPurse({ warded: e?.warded, progress: e?.progress, motes: e?.motes });
    });
    // The window is a clock, and a clock the player bought. `update` counts it
    // down locally off the same seconds `Corruption` is counting, so the chip
    // does not need sixty events a second to move.
    on('voidSanctuary', (e) => {
      this._sanctuaryT = Math.max(0, e?.seconds ?? 0);
      this.setPurse({ sanctuary: this._sanctuaryT });
      this.toast(`Sanctuary — ${Math.round(this._sanctuaryT)}s of free ground`, 'argent');
    });
    on('voidSanctuaryEnd', () => {
      this._sanctuaryT = 0;
      this.setPurse({ sanctuary: 0 });
      this.toast('Sanctuary closes', 'argent');
    });
    on('argentConsecrate', (e) => {
      const item = ITEM_BY_ID.get(e?.id);
      this.toast(`Consecrated — ${item?.name || prettify(e?.id)}`, 'argent', e?.id);
    });

    on('goldChanged', () => { /* value polled in update; event kept for parity */ });
    on('abilityUsed', ({ slot }) => {
      const i = slotIndex(slot);
      if (i >= 0) this.abilityReady[i] = false;
    });

    on('teleporterCharging', ({ progress }) => {
      this.tpProgress = clamp(progress ?? 0, 0, 1);
      // The teleporter is only ever charging because the player found it and
      // stood in it. Keeping the range readout live past that point leaves a
      // stale "55M" under a boss bar.
      this.tpFound = true;
      // The radial already reads the charge; while a boss is up the objective
      // belongs to the boss.
      if (!this.boss) this.setObjective(`Charging teleporter: ${Math.round(this.tpProgress * 100)}%`);
    });
    on('teleporterComplete', () => {
      this.tpProgress = -1;
      this.tpFound = true;
      this.setObjective('Proceed to the next stage');
    });
    on('stageStart', ({ index, name }) => {
      this.stageIndex = (index ?? 0) + 1;
      this.stageName = name || '';
      this.tpProgress = -1;
      this.tpFound = false;
      this.clearBoss();
      this.setObjective('Find and activate the teleporter');
      this.toast(name ? `Stage ${this.stageIndex} — ${name}` : `Stage ${this.stageIndex}`, 'stage');
    });

    on('bossSpawn', ({ enemy }) => this.setBoss(enemy));
    on('bossDead', () => this.clearBoss());
    // The run-summary screen belongs to the survivor who died. Raising it for a
    // teammate's death left a co-op client alive and mobile behind a death
    // screen it could not dismiss.
    on('playerDead', (p) => { if (isLocalVictim(this.ctx, p)) this.onDeath(); });
    // The other half of `onDeath`: the stage-end amnesty brought this
    // machine's own pawn back, so the run summary it is still staring at is
    // stale. Only closes the screen it opened — a player who backed out to
    // the pause menu or settings on top of it is left alone.
    on('playerReturned', (p) => {
      if (isLocalVictim(this.ctx, { victim: p?.player }) && this.menus?.screen === 'death') this.onReturn();
    });

    // Hover tooltips only exist while the cursor is free — while pointer-locked
    // the HUD must not intercept anything.
    addEventListener('resize', () => this.markStripDirty());

    const inv = this.refs.inventory;
    inv.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.item');
      if (!el) return;
      this.hoverId = el.dataset.id;
      const entry = this.inv.get(this.hoverId);
      this.tooltip.show(el, this.hoverId, el.dataset.tier, entry?.count ?? 1);
    });
    inv.addEventListener('mouseout', (e) => {
      if (e.relatedTarget && e.relatedTarget.closest?.('.item')) return;
      this.hoverId = null;
      this.tooltip.hide();
    });
  }

  // ---------------------------------------------------------------- events

  onItemPickup(id, count, reason) {
    const def = ITEM_BY_ID.get(id) ?? null;
    const tier = def?.tier || 'common';
    let entry = this.inv.get(id);
    const total = count ?? (entry ? entry.count + 1 : 1);

    // A write that empties a stack retires its tile. `count` is absolute, so a
    // zero left the icon sitting there with a blank badge — which is exactly
    // how the strip draws a single copy, i.e. the emptied stack read as one
    // still held. `take` and the refinery reach this too; the corruption
    // transform is only the first routine driver of it.
    if (total <= 0) {
      if (!entry) return;
      const row = entry.el.parentElement, group = row?.parentElement;
      entry.el.remove();
      if (row && row.childElementCount === 0) row.remove();
      if (group && group.childElementCount === 0) group.classList.remove('has-items');
      this.inv.delete(id);
      this.markStripDirty();
      return;
    }

    if (!entry) {
      const group = this.refs.tierGroups[tier] || this.refs.tierGroups.common;
      const el = document.createElement('div');
      el.className = `item t-${tier}`;
      el.dataset.id = id;
      el.dataset.tier = tier;
      el.innerHTML = `<img src="${itemArt(id, tier)}" alt="" draggable="false" /><b class="item-stack"></b>`;
      // Explicit rows, not `flex-wrap`. The tier rule is meant to shrink-wrap
      // its icons, but `width: max-content` on a wrapping flex container
      // resolves to the *unwrapped* width of all the children and then clamps
      // to `max-width`, so any tier that wrapped drew its rule to the full
      // container width and overhung its last tile by ~40px. A column of
      // non-wrapping rows makes `max-content` the true content width.
      let row = group.lastElementChild;
      if (!row || row.childElementCount >= INV_ROW) {
        row = document.createElement('div');
        row.className = 'inv-row';
        group.appendChild(row);
      }
      row.appendChild(el);
      entry = { el, badge: el.querySelector('.item-stack'), count: 0, tier };
      this.inv.set(id, entry);
      group.classList.add('has-items');
      requestAnimationFrame(() => el.classList.add('is-in'));
    }

    this.markStripDirty();
    entry.count = total;
    entry.badge.textContent = total > 1 ? `x${total}` : '';
    entry.badge.classList.toggle('is-on', total > 1);
    this.pulse(entry.el, 'is-pop');

    // `'corrupt'` moves stacks between two ids; nothing was acquired. The strip
    // above still repaints both halves, but a pickup toast and card for each
    // would announce the conversion three times and call the emptied base a
    // gain. The mutation speaks once, through `itemMutated`.
    if (reason === 'corrupt') return;

    const name = def?.name || prettify(id);
    this.toast(name, tier, id);
    this.menus?.showPickup({
      id,
      tier,
      name,
      description: describeItem(def, total),
    });
  }

  /**
   * A boss bar has to name the thing that is killing you — "BOSS" is a template
   * that was never filled in. The spawn card carries the real name, and `Enemy`
   * keeps the card on `def`, so `def.name` is the reliable read; `name` and
   * `displayName` are honoured first for when the entity carries its own.
   */
  /**
   * Paint the void-mark / argent-mote purse on the gauge (issue #36, D2).
   *
   * Partial by design: each event carries only its own currency, so a field
   * that is not a finite number leaves the other half of the purse alone
   * rather than zeroing it. The row stays hidden while both are empty - a
   * gauge corner is expensive real estate and two zeroes teach nothing - and
   * lights the moment either currency exists, which is also the moment it
   * becomes something the player can spend.
   *
   * Issue #154 adds two more fields on the same row and the same partial rule.
   * `progress` is the mote being *earned*: forty points of warding used to
   * accumulate with no readout at all and then announce themselves as a toast
   * with nothing on screen leading up to it, which is the single largest reason
   * a playtester noticed none of this system. `sanctuary` is the open window's
   * remaining seconds — the one purchase whose whole value is a clock.
   */
  setPurse(next) {
    const p = this._purse
      || (this._purse = { marks: 0, motes: 0, progress: 0, warded: 0, sanctuary: 0 });
    if (Number.isFinite(next?.marks)) p.marks = Math.max(0, Math.round(next.marks));
    if (Number.isFinite(next?.motes)) p.motes = Math.max(0, Math.round(next.motes));
    if (Number.isFinite(next?.warded)) p.warded = Math.max(0, next.warded);
    if (Number.isFinite(next?.progress)) p.progress = Math.max(0, Math.min(1, next.progress));
    if (Number.isFinite(next?.sanctuary)) p.sanctuary = Math.max(0, next.sanctuary);
    const refs = this.refs;
    if (refs.purseMarks) refs.purseMarks.textContent = String(p.marks);
    if (refs.purseMotes) refs.purseMotes.textContent = String(p.motes);
    // The bar is the mote in progress, not the motes in hand: it fills and
    // resets, so the mint the toast announces is the moment it came full.
    if (refs.wardingFill) refs.wardingFill.style.width = `${Math.round(p.progress * 100)}%`;
    if (refs.sanctuaryTime) refs.sanctuaryTime.textContent = String(Math.ceil(p.sanctuary));
    const purse = refs.corruptionPurse;
    if (!purse) return;
    const warding = p.warded > 0;
    purse.classList.toggle('is-on', p.marks > 0 || p.motes > 0 || warding);
    purse.classList.toggle('has-marks', p.marks > 0);
    purse.classList.toggle('has-motes', p.motes > 0);
    // Warding shows from the first point taken back out, which is the whole
    // point — the row must be up *before* there is a mote to show in it.
    purse.classList.toggle('has-warding', warding);
    purse.classList.toggle('is-sanctified', p.sanctuary > 0);
    purse.setAttribute('aria-label',
      p.marks + ' void mark' + (p.marks === 1 ? '' : 's')
      + ', ' + p.motes + ' argent mote' + (p.motes === 1 ? '' : 's')
      + (warding ? `, ${Math.round(p.progress * 100)}% toward the next mote` : '')
      + (p.sanctuary > 0 ? `, sanctuary ${Math.ceil(p.sanctuary)}s` : ''));
  }

  /**
   * The argent tier's dead state (issue #154, deliverable 3).
   *
   * Every argent payoff is multiplied by `grace`, which is 1 at Pristine and
   * reaches 0 at Overrun — so on a corrupted run five cards sit in the pack
   * doing literally nothing, and until now the pack said nothing about it. The
   * group carries the live fraction as a custom property and a class at the
   * floor, so the strip fades as the world rots rather than only snapping off
   * at the end, and comes straight back the instant a font press or a
   * Voidtouched kill buys grace back.
   *
   * Polled rather than event-driven, unlike the purse: `grace` is a function of
   * *live* world corruption, which moves on every feed, and there is no single
   * event that means "the argent payoff changed". Through `this.set`, so a run
   * whose corruption is not moving costs zero DOM writes — the gauge's own rule.
   *
   * Nothing is latched here. That is the half of the deliverable worth having:
   * a dead state that could not be undone would be a different bug.
   */
  setArgentGrace(ctx) {
    const group = this.refs.tierGroups?.argent;
    if (!group) return;
    const g = Math.round(grace(ctx) * 100);
    this.set('argentGrace', g, (v) => {
      group.style.setProperty('--grace', String(v / 100));
      group.classList.toggle('is-graceless', v <= 0);
      group.setAttribute('title', v <= 0
        ? 'Argent: spent — the world is too corrupt for these to pay anything'
        : `Argent: paying ${v}% — falls to nothing at Overrun`);
    });
    // The other half of the same sentence. One poll, two groups: whatever the
    // gauge says, exactly one of these strips is bright, which is the whole
    // point of the pair of curves (#170).
    const blight = this.refs.tierGroups?.blight;
    if (!blight) return;
    const b = Math.round(blightGrace(ctx) * 100);
    this.set('blightGrace', b, (v) => {
      blight.style.setProperty('--blight', String(v / 100));
      blight.setAttribute('title',
        `Blight: paying ${v}% — full strength at Overrun. The drawbacks are charged in full at every band.`);
    });
  }

  setBoss(enemy) {
    if (!enemy) return;
    this.boss = enemy;
    const name = enemy.displayName || enemy.name || enemy.def?.name || 'Boss';
    this.refs.bossName.textContent = String(name).toUpperCase();
    // The sub-line said "Teleporter Boss" while the objective banner directly
    // beneath it said "find the teleporter". It now carries the affix, which is
    // the thing the player actually has to plan around.
    this.refs.bossSub.textContent = enemy.isElite
      ? `${ELITE_STATS[enemy.affix]?.label ?? 'Elite'} — Teleporter Boss`
      : 'Teleporter Boss';
    this.refs.bossBar.classList.add('is-on');
    this.c.bossHp = -1;
    // Two competing instructions in one glance region is worse than none: while
    // a boss is up, the objective *is* the boss.
    this.setObjective('Defeat the teleporter boss');
  }

  clearBoss() {
    const had = !!this.boss;
    this.boss = null;
    this.refs.bossBar.classList.remove('is-on');
    if (had) {
      this.setObjective(this.tpProgress >= 0
        ? `Charging teleporter: ${Math.round(this.tpProgress * 100)}%`
        : this.tpFound ? 'Proceed to the next stage' : 'Find and activate the teleporter');
    }
  }

  setObjective(text) {
    if (this.objective === text) return;
    this.objective = text;
    this.refs.objectiveText.textContent = text;
    this.pulse(this.refs.objective, 'is-change');
  }

  /**
   * Interaction prompt, e.g. "Chest ($25)". `Interactables` calls this every
   * time the focused object changes; null clears it.
   *
   * This method did not exist, and the call site is `ctx.hud?.setPrompt?.(...)`
   * — so nothing rendered and nothing errored. A player standing on a chest had
   * no indication that E did anything at all.
   */
  setPrompt(text) {
    if (this.promptText === text) return;
    this.promptText = text;
    const el = this.refs.prompt;
    if (!el) return;
    if (text) {
      this.refs.promptLabel.textContent = text;
      el.classList.add('is-on');
    } else {
      el.classList.remove('is-on');
    }
  }

  onDeath() {
    const items = [...this.inv.entries()].map(([id, e]) => ({ id, tier: e.tier, count: e.count }));
    const diff = this.difficultyOf(this.ctx.director?.difficultyCoefficient ?? 1);
    this.menus?.showDeath({
      time: formatTime(this.ctx.time ?? 0),
      stage: String(this.stageIndex),
      stageName: this.stageName,
      level: Math.max(1, Math.floor(this.ctx.player?.level ?? 1)),
      kills: this.stats.kills,
      damage: Math.round(this.stats.damage).toLocaleString(),
      itemCount: items.reduce((a, b) => a + b.count, 0),
      difficulty: diff.name,
      items,
    });
  }

  /** The amnesty's other half: close a death screen this machine's own pawn no longer earns. */
  onReturn() {
    this.menus?.close();
  }

  /**
   * Public hook so other systems can push a line into the log.
   *
   * `id` is optional; when it names an item the row leads with the same emblem
   * the inventory strip draws, so the player never has to learn two unrelated
   * representations of one object.
   */
  toast(text, tier = 'common', id = null) {
    const el = document.createElement('div');
    el.className = `toast t-${tier}`;
    const mark = id
      ? `<img class="toast-icon" src="${itemArt(id, tier)}" alt="" draggable="false" />`
      : '<i class="toast-mark"></i>';
    el.innerHTML = `${mark}<span>${escapeHtml(text)}</span>`;
    this.refs.log.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    this.toasts.push({ el, t: 5 });
    while (this.toasts.length > 6) {
      const dead = this.toasts.shift();
      dead.el.remove();
    }
    this.restackToasts();
  }

  /**
   * Six pickups at full opacity is six equally loud claims on the eye. Fade by
   * age so the newest line is the one that reads — `--age` rather than an
   * inline opacity, because the entry transition owns `opacity`.
   */
  restackToasts() {
    const n = this.toasts.length;
    for (let i = 0; i < n; i++) {
      const age = n - 1 - i;                       // 0 = newest
      const v = Math.max(0.34, 1 - age * 0.15);
      this.toasts[i].el.style.setProperty('--age', v.toFixed(2));
    }
  }

  /** Restart a CSS animation without leaving a stale class behind. */
  pulse(el, cls, alsoRemove) {
    if (!el) return;
    el.classList.remove(cls);
    if (alsoRemove) el.classList.remove(...alsoRemove);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------------------------------------------------------------- update

  update(ctx, dt) {
    // `Menus` pumps itself — it is a registered system since #118. Calling it
    // from here as well would update it twice a frame, and billing its throws
    // to `HUD.update` is the whole thing that ticket removed.
    // Ahead of the `hidden` early-return below: a caption must still expire
    // while a full-bleed screen is up, or it is waiting on screen when the
    // player comes back.
    this.announcer.update(dt);
    // Beside the announcer and ahead of the same early-return: a prompt naming
    // a rebound key has to catch up even while a menu is up.
    this.tutorial.update(dt);

    const cursor = !document.pointerLockElement;
    this.set('cursor', cursor, (v) => this.root.classList.toggle('has-cursor', v));
    if (!cursor && this.hoverId) { this.hoverId = null; this.tooltip.hide(); }

    const hidden = FULL_SCREENS.has(this.menus?.screen);
    this.set('hidden', hidden, (v) => this.root.classList.toggle('is-hidden', v));
    if (hidden) { this.stripRect = null; return; }

    // The labels come off the live binding map, so a rebound interact or
    // equipment key names the key the player actually holds. The memo key
    // carries the labels as well as the device, or a rebind made while the HUD
    // is up would not repaint. `EQUIPMENT_KEY_LABEL` remains the static markup's
    // default; this is the live one.
    const glyphSet = ctx.settings?.controllerGlyphs ?? DEFAULT_GLYPH_SET;
    const interactKey = keyLabel(bindings.keyOf('interact'));
    const interactPad = glyphLabel(bindings.padOf('interact'), glyphSet);
    const equipKey = keyLabel(bindings.keyOf('equipment'));
    const equipPad = glyphLabel(bindings.padOf('equipment'), glyphSet);
    const padOn = !!ctx.input?.padActive;
    this.set('padPrompt', `${padOn}|${interactKey}|${interactPad}|${equipKey}|${equipPad}`, () => {
      if (this.refs.promptKey) this.refs.promptKey.textContent = padOn ? interactPad : interactKey;
      // The equipment tile names its button the same way. Printing F to a pad
      // player is naming a key they do not have.
      if (this.refs.equip?.key) this.refs.equip.key.textContent = padOn ? equipPad : equipKey;
      if (this.refs.reviveKey) this.refs.reviveKey.textContent = padOn ? interactPad : interactKey;
    });

    // The standing vow, polled rather than evented: the timing vow's line is a
    // countdown, and pushing sixty events a second to move a clock is the shape
    // the purse deliberately avoided. `set` keeps it to one DOM write per change.
    const vowLine = ctx.vows?.line ?? '';
    this.set('vowLine', vowLine, (v) => {
      this.refs.vowText.textContent = v;
      this.refs.vow.classList.toggle('is-on', !!v);
    });

    this.updateHealth(ctx, dt);
    this.updateExperience(ctx);
    this.updateMoney(ctx, dt);
    this.updateClock(ctx);
    this.updateAbilities(ctx);
    this.updateEquipment(ctx);
    this.updateBoss(ctx);
    this.updateTeleporter(ctx);
    this.updateDowned(ctx);
    this.updateParty(ctx);
    this.updateRevive(ctx, dt);
    this.updateObjectivePing(ctx);
    this.updateDirections(ctx, dt);
    this.updateToasts(dt);
    this.updateStripRect(dt);

    if (this.hoverId) {
      const el = this.inv.get(this.hoverId)?.el;
      if (el) this.tooltip.place(el);
    }
  }

  /**
   * Publish the inventory strip's screen rect for the damage-numeral clip.
   *
   * The strip is an opaque DOM block over the 3D, composited after the scene,
   * so a world-space readout arcing behind it shipped as a band of digit-tops
   * peeking between two tier rows — photographed by the round-3 and round-4
   * critiques on `10-inventory`. `VFX.DamageNumbers` clips its layer out of
   * this rect rather than losing another round to z-order.
   *
   * Measured rather than assumed: the strip is `width: max-content` over a
   * variable haul, and the tiles animate in over ~0.34 s. So it is re-read for
   * a second after anything changes it, and not at all in between — a
   * `getBoundingClientRect` every frame would force a layout flush per frame
   * for a value that is constant almost all of the time.
   */
  updateStripRect(dt) {
    if (this._stripHoldT > 0) this._stripHoldT -= dt;
    else if (this.stripRect) return;
    const el = this.refs.inventory;
    if (!el) { this.stripRect = null; return; }
    const r = el.getBoundingClientRect();
    this.stripRect = r.width > 0 && r.height > 0
      ? { x: r.left, y: r.top, w: r.width, h: r.height }
      : null;
  }

  /** Re-measure the strip for the next second. */
  markStripDirty() { this._stripHoldT = STRIP_HOLD_SEC; }

  // No `lateUpdate`: the title orbit it used to run is `Menus.lateUpdate`'s
  // now, and it still lands after CameraRig because Menus is registered after
  // it.

  set(key, value, apply) {
    if (this.c[key] === value) return false;
    this.c[key] = value;
    apply(value);
    return true;
  }

  // -------------------------------------------------------------- sections

  updateHealth(ctx, dt) {
    const p = ctx.player;
    const hp = Math.max(0, p?.health ?? 0);
    const max = Math.max(1, p?.maxHealth ?? 100);
    const shield = Math.max(0, p?.shield ?? 0);
    // Shield extends the bar past max health, the way RoR2 stacks barrier on
    // top — so the whole track represents health + shield.
    const total = max + shield;
    const frac = clamp(hp / total, 0, 1);
    const shieldFrac = clamp(shield / total, 0, 1);

    // Ghost bar: snaps up on heal, drains down over ~0.5s on damage.
    this.ghost = frac > this.ghost ? frac : damp(this.ghost, frac, 0.999, dt);
    if (Math.abs(this.ghost - frac) < 0.002) this.ghost = frac;

    this.set('hpFrac', round3(frac), (v) => {
      this.refs.hpFill.style.transform = `scaleX(${v})`;
    });
    this.set('hpGhost', round3(this.ghost), (v) => {
      this.refs.hpGhost.style.transform = `scaleX(${v})`;
    });
    // Percentage translate resolves against the untransformed width, so this
    // parks the shield segment exactly at the end of the health fill.
    this.set('shield', `${round3(shieldFrac)}@${round3(frac)}`, () => {
      this.refs.hpShield.style.transform =
        `translateX(${(frac * 100).toFixed(2)}%) scaleX(${round3(shieldFrac)})`;
      this.refs.hpShield.classList.toggle('is-on', shieldFrac > 0.001);
    });
    this.set('hpText', `${Math.ceil(hp)}|${Math.round(max)}`, () => {
      this.refs.hpNow.textContent = Math.ceil(hp);
      this.refs.hpMax.textContent = Math.round(max);
    });
    this.set('shieldText', Math.ceil(shield), (v) => {
      this.refs.hpShieldNum.textContent = v > 0 ? `+${v}` : '';
      this.refs.hpShieldNum.classList.toggle('is-on', v > 0);
    });

    // Low-health state keys off real health, not the shield-extended track.
    const hpOnly = clamp(hp / max, 0, 1);
    const low = hpOnly > 0 && hpOnly < 0.25;
    this.set('low', low, (v) => this.root.classList.toggle('is-low', v));
    if (low) {
      this.lowPulse += dt * (1.4 + (1 - hpOnly / 0.25) * 1.6);
      const beat = Math.pow(Math.max(0, Math.sin(this.lowPulse * Math.PI)), 3);
      const amount = (0.35 + beat * 0.65) * (1 - hpOnly / 0.25);
      this.refs.lowEdge.style.opacity = amount.toFixed(3);
      this.refs.lowEdge.style.transform = `scale(${(1 + beat * 0.012).toFixed(4)})`;
    } else if (this.c.low === false && this.refs.lowEdge.style.opacity !== '0') {
      this.refs.lowEdge.style.opacity = '0';
    }

    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    }
  }

  /**
   * Level and XP are run state owned by Progression and surfaced on Player as
   * `level` / `xp` / `xpToNext` (see Player's getters). Reading them off the
   * player keeps this one read for both roles: the host advances them, and a
   * client's copy is set from the replicated `levelUp` event.
   */
  updateExperience(ctx) {
    const p = ctx.player;
    const level = Math.max(1, Math.floor(p?.level ?? 1));
    const xp = Math.max(0, p?.xp ?? 0);
    const next = Math.max(1, p?.xpToNext ?? 1);
    const frac = clamp(xp / next, 0, 1);

    this.set('xp', round3(frac), (v) => {
      this.refs.xpFill.style.transform = `scaleX(${v})`;
    });
    this.set('level', level, (v) => {
      this.refs.levelNum.textContent = v;
      if (this.c.levelSeen != null) {
        this.pulse(this.refs.levelBlock, 'is-up');
        this.pulse(this.refs.xpBar, 'is-up');
        this.toast(`Level ${v}`, 'boss');
      }
      this.c.levelSeen = v;
    });
  }

  updateMoney(ctx, dt) {
    // Gold lives on Items, and only on Items — Player has never carried a
    // `gold` field, so the old fallback through it was a read that could only
    // ever be undefined.
    const gold = Math.max(0, Math.floor(ctx.items?.gold ?? 0));
    if (this.moneyShown !== gold) {
      const step = Math.max(1, Math.abs(gold - this.moneyShown) * 6 * dt);
      this.moneyShown = this.moneyShown < gold
        ? Math.min(gold, this.moneyShown + step)
        : Math.max(gold, this.moneyShown - step);
      if (Math.abs(gold - this.moneyShown) < 1) this.moneyShown = gold;
    }
    const shown = Math.round(this.moneyShown);
    this.set('gold', shown, (v) => {
      this.refs.moneyVal.textContent = `$${v.toLocaleString()}`;
    });
    this.set('goldTarget', gold, () => this.pulse(this.refs.money, 'is-tick'));

    // Corruption gauge: world value + band, polled like gold and sitting under
    // it, because they are the two prices of the same transaction. Band 4's
    // `at` is the top of the bar; past it the bar just stays full.
    this.setArgentGrace(ctx);

    // The sanctuary clock, counted down against the same seconds `Corruption`
    // is counting. `voidSanctuaryEnd` is the authority on the window closing;
    // this only stops the digits before it arrives, and clamps at zero rather
    // than going negative if the event is late or never comes (a client).
    if (this._sanctuaryT > 0) {
      this._sanctuaryT = Math.max(0, this._sanctuaryT - dt);
      this.set('sanctuaryT', Math.ceil(this._sanctuaryT), () => {
        this.setPurse({ sanctuary: this._sanctuaryT });
      });
    }

    const cor = ctx.corruption;
    if (cor && this.refs.corruption) {
      const top = BANDS[BANDS.length - 1].at;
      const frac = Math.min(1, (cor.world ?? 0) / top);
      this.set('corruptionFrac', Math.round(frac * 100), (v) => {
        this.refs.corruptionFill.style.width = `${v}%`;
      });
      // The pen. It advances on wall-clock, not per frame, and the write goes
      // through the diff cache keyed on the quantised buffer — so a run whose
      // corruption is not moving costs exactly zero DOM writes, and a run that
      // is climbing costs one `setAttribute` every 1.5 s.
      this._trace ??= [];
      this._traceT = (this._traceT ?? TRACE_INTERVAL) + dt;
      if (this._traceT >= TRACE_INTERVAL) {
        this._traceT = 0;
        this._trace.push(frac);
        if (this._trace.length > TRACE_SAMPLES) this._trace.shift();
        this.set('corTrace', this._trace.map((v) => Math.round(v * 200)).join(','), () => {
          this.refs.corruptionTrace?.setAttribute('d', tracePathFrom(this._trace, { h: 10 }));
        });
      }
      // The first update of a session is not a crossing: the cache starts empty
      // and `undefined !== 0` fires the callback for band 0. The label and the
      // data-band still need to land; the flare — which now means "you just
      // crossed a line", alongside the screen lurch and the band sting — must
      // not fire for the line nobody crossed.
      const crossed = this.c.corruptionBand !== undefined;
      const wasBand = this.c.corruptionBand;
      const bandMoved = this.set('corruptionBand', cor.band ?? 0, (v) => {
        this.refs.corruption.dataset.band = String(v);
        this.refs.corruptionBand.textContent = BANDS[v].name;
        // Direction matters, and the other two channels already say so: Blight
        // withholds its vignette hit on a descent because a dark flash on the
        // frame a cleanse is bought reads as damage, and the sting resolves to
        // a fifth instead of a tritone. The gauge is the one thing the player
        // is actually looking at, so it must not fire the warning pink for the
        // $746 they just spent making things better.
        if (crossed) this.pulse(this.refs.corruption, v > wasBand ? 'is-tick' : 'is-tick-down', v > wasBand ? ['is-tick-down'] : ['is-tick']);
      });

      // The legend the instrument never had (#31): the gauge moved, and the
      // only way to learn where the lines were was to have already crossed one.
      // `nextThresholdLine` names the next band, the distance to it and its
      // price, all read off the same tuning the systems obey — including the
      // blight toll, which is `Items`' to answer and not the gauge's to
      // re-derive. `ctx.items` is the local pawn's own instance, and the
      // crossing listener advances `_mutePeak` on every instance, so any of
      // them gives the same world-level answer.
      //
      // Co-op caveat, the same one `ArgentFont.prompt` and `corruptionPrice`
      // already carry: `Corruption` is not replicated (nothing in src/net/
      // carries it) and `feed` is authority-gated, so a client's `_world` never
      // leaves 0 and this whole sentence describes a pristine world for the
      // entire run — "Next: Seeded in 20" while the host sits in Consumed.
      // `_mutePeak` does not replicate either, so the toll floor a client reads
      // is `MUTATION.minBand` rather than the truth. That is stale display, not
      // a stale transaction, and it is the widest of the three stale surfaces
      // because the gauge is on screen always rather than only at a prop.
      // Replicating the gauge is a net-layer change and deliberately not made
      // here. Two consequences worth knowing before anyone "fixes" it: the
      // primer below never fires on a client (it is gated on `world > 0`), so
      // the false sentence is never even highlighted; and greed time *does*
      // track correctly, because `teleporterComplete` and `stageStart` are both
      // broadcast and `Corruption.init` subscribes to both.
      //
      // The hold is the subtle half. On the *first* feed of a run — the moment
      // the player first sees the needle move and first wonders what it costs —
      // the sentence latches for `CORRUPTION_PRIMER_S` and lights up. Only the
      // sentence: the fill, the pen, the band label and the route line all keep
      // running underneath, nothing is paused, and there is no modal to
      // dismiss. Freezing it is what makes it readable — an unfrozen line
      // recomputes its own countdown under the eye that is reading it.
      //
      // A band crossing cancels the hold on the frame it happens, because a
      // sentence held about a line the party has already crossed is not a
      // steady explanation, it is a wrong one.
      this._corPrimerT = Math.max(0, (this._corPrimerT ?? 0) - dt);
      if (this._corFed === undefined && (cor.world ?? 0) > 0) {
        this._corFed = true;
        this._corPrimerT = CORRUPTION_PRIMER_S;
      }
      if (crossed && bandMoved) this._corPrimerT = 0;
      const holding = this._corPrimerT > 0 && this.c.corruptionNext !== undefined;
      this.set('corruptionNext', holding ? this.c.corruptionNext
        : nextThresholdLine(cor.world ?? 0, cor.band ?? 0, BANDS, ctx.items?.nextTollBand?.()), (v) => {
        this.refs.corruptionNext.textContent = v;
      });
      this.set('corruptionPrimer', this._corPrimerT > 0, (v) => {
        this.refs.corruption.classList.toggle('is-primer', v);
      });

      // Route preview, not surprise (launch spec §2): from stage 3 the party
      // can see which Fracture their band is buying, and argue about it.
      const stageIdx = ctx.progression?.stageIndex ?? 0;
      let route = '';
      if (stageIdx >= 2) {
        const open = routesFor(cor.band ?? 0);
        route = open.length > 1 ? 'Route: contested' : `Route: ${open[0]?.name ?? ''}`;
      }
      this.set('corruptionRoute', route, (v) => {
        this.refs.corruptionRoute.textContent = v;
        this.refs.corruptionRoute.classList.toggle('is-on', !!v);
        // The gauge is a flex column now, so the route line takes the row it
        // needs and nothing has to buy it back. The class stays as a hook for
        // anything that wants to know the gauge grew a second line.
        this.refs.corruption.classList.toggle('has-route', !!v);
      });
    }
  }

  difficultyOf(coef) {
    let i = 0;
    for (let k = 0; k < DIFFICULTY.length; k++) if (coef >= DIFFICULTY[k].t) i = k;
    const cur = DIFFICULTY[i];
    const next = DIFFICULTY[i + 1];
    const progress = next ? invLerp(cur.t, next.t, coef) : 1;
    return { ...cur, index: i, progress };
  }

  updateClock(ctx) {
    const t = ctx.time ?? 0;
    this.set('clock', Math.floor(t), () => {
      this.refs.clockTime.textContent = formatTime(t);
    });

    const coef = ctx.director?.difficultyCoefficient ?? 1;
    const d = this.difficultyOf(coef);
    // The coefficient can fall now that World Corruption feeds it and a font can
    // bleed the world back down, so "the difficulty name changed" is no longer
    // the same statement as "it got worse". The escalation flare is reserved for
    // the direction it describes; a step down just relabels. Names are unique in
    // DIFFICULTY, so the cached one identifies the tier it came from.
    const prevIdx = this.c.diffName === undefined
      ? -1 : DIFFICULTY.findIndex((x) => x.name === this.c.diffName);
    this.set('diffName', d.name, (v) => {
      this.refs.clockDiff.textContent = v;
      this.refs.clock.style.setProperty('--diff', d.color);
      if (d.index > prevIdx) this.pulse(this.refs.clock, 'is-escalate');
    });
    const filled = Math.round(d.progress * NOTCHES);
    this.set('diffFill', filled, (v) => {
      const notches = this.refs.notches;
      for (let i = 0; i < notches.length; i++) notches[i].classList.toggle('is-on', i < v);
    });
    this.set('diffCoef', coef.toFixed(1), (v) => {
      this.refs.clockCoef.textContent = `x${v}`;
    });
  }

  updateAbilities(ctx) {
    const src = ctx.player?.abilities;
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i];
      const raw = Array.isArray(src) ? src[i] : src?.[s.id];
      const a = readAbility(raw);
      const ref = this.refs.slots[i];

      // A sub-second cooldown gets no sweep at all. The primary's is ~0.2s, so
      // sweeping it meant the slot the player looks at most spent its life
      // under a near-opaque black panel with no numeral to compensate — it read
      // as broken rather than as firing. RoR2 never blacks out the primary.
      //
      // The invariant: **a darkened slot always carries a readout.** The sweep
      // used to be gated on the *total* cooldown and the numeral on the
      // *remaining* time, so any ability whose cooldown fell between 0.75s and
      // ~1.3s — exactly what a loaded run's stacked cooldown items produce —
      // was swept for its whole cooldown and never printed a number once. One
      // quantity now drives both, and under a second it prints a decimal.
      const sweeping = a.cd >= SWEEP_MIN_CD && a.rem > TIMER_MIN;
      const p = sweeping ? clamp(a.rem / a.cd, 0, 1) : 0;
      this.set(`cd${i}`, round3(p), (v) => {
        ref.sweep.style.transform = `scaleY(${v})`;
        ref.el.classList.toggle('is-cooling', v > 0.001);
      });
      const timer = !sweeping ? '' : a.rem >= 1 ? String(Math.ceil(a.rem)) : a.rem.toFixed(1);
      this.set(`cdt${i}`, timer, (v) => {
        ref.timer.textContent = v;
      });

      const ready = a.rem <= 0.001 && a.charges > 0;
      if (ready && !this.abilityReady[i]) this.pulse(ref.el, 'is-ready');
      this.abilityReady[i] = ready;
      this.set(`rdy${i}`, ready, (v) => ref.el.classList.toggle('is-ready-state', v));

      this.set(`pips${i}`, `${a.charges}/${a.maxCharges}`, () => {
        renderPips(ref.pips, a.charges, a.maxCharges);
      });
      if (a.name) {
        this.set(`aname${i}`, shortName(a.name), (v) => { ref.name.textContent = v; });
      }
    }
  }

  /**
   * The equipment slot.
   *
   * It is the fifth control in the bottom-right cluster and it only exists when
   * the player is holding something — an empty orange tile parked next to four
   * skills for the first ten minutes of a run is screen space nothing has
   * earned. Everything about the tile is read through `ctx.items`' snapshot;
   * the sweep specifically comes from `equipmentFraction()`, which handles the
   * banked-charge case that `cooldown / cooldownMax` cannot express.
   */
  syncEquipment() {
    const eq = this.ctx.items?.equipment ?? null;
    const ref = this.refs.equip;
    if (!ref?.el) return;
    this.set('eqId', eq?.id ?? '', (id) => {
      ref.el.classList.toggle('is-on', !!id);
      if (!id) return;
      ref.icon.src = equipmentArt(id);
      ref.name.textContent = shortName(eq.def?.name || prettify(id));
    });
  }

  updateEquipment(ctx) {
    const ref = this.refs.equip;
    if (!ref?.el) return;
    const items = ctx.items;
    const eq = items?.equipment ?? null;
    if (!eq) { this.set('eqOn', false, (v) => ref.el.classList.toggle('is-on', v)); return; }
    this.set('eqOn', true, (v) => ref.el.classList.toggle('is-on', v));

    // 1 means "banked, press it"; the sweep draws the *unfilled* remainder, so
    // a full slot has no sweep at all.
    const frac = clamp(items.equipmentFraction?.() ?? 1, 0, 1);
    const ready = eq.charges > 0;
    this.set('eqSweep', round3(1 - frac), (v) => {
      ref.sweep.style.transform = `scaleY(${v})`;
      ref.el.classList.toggle('is-cooling', v > 0.001);
    });
    const rem = ready ? 0 : Math.max(0, eq.cooldown ?? 0);
    this.set('eqTimer', rem >= 1 ? String(Math.ceil(rem)) : rem > TIMER_MIN ? rem.toFixed(1) : '', (v) => {
      ref.timer.textContent = v;
    });
    if (ready && !this.equipReady) this.pulse(ref.el, 'is-ready');
    this.equipReady = ready;
    this.set('eqReady', ready, (v) => ref.el.classList.toggle('is-ready-state', v));
    this.set('eqPips', `${eq.charges}/${eq.maxCharges}`, () => {
      renderPips(ref.pips, eq.charges, eq.maxCharges);
    });
  }

  updateBoss(ctx) {
    const b = this.boss;
    if (!b) { this.setBossPing(0, 0); return; }
    if (b.alive === false) { this.clearBoss(); return; }
    const frac = clamp((b.health ?? 0) / Math.max(1, b.maxHealth ?? 1), 0, 1);
    this.set('bossHp', round3(frac), (v) => {
      this.refs.bossFill.style.transform = `scaleX(${v})`;
      this.refs.bossPct.textContent = `${Math.ceil(v * 100)}%`;
    });
    this.updateBossPing(ctx, b);
  }

  /**
   * A health bar with no locatable body is just an assertion. Point at the
   * boss whenever it is outside the frame, using the same crosshair ring the
   * damage-direction arcs live on.
   */
  updateBossPing(ctx, boss) {
    this.ping('bossPing', this.refs.bossPing, ctx, boss.position);
  }

  setBossPing(deg, alpha) { this.setPing('bossPing', this.refs.bossPing, deg, alpha); }

  /**
   * Point the chevron `el` at a world position whenever that position is
   * outside the frame, and hide it when it isn't. Shared by the boss bar and
   * the teleporter objective so both read as the same piece of UI language.
   */
  ping(key, el, ctx, pos) {
    const cam = ctx.camera;
    const origin = ctx.player?.position;
    if (!cam || !pos || !origin) { this.setPing(key, el, 0, 0); return; }

    this.tmp.set(pos.x, pos.y, pos.z).project(cam);
    const onScreen = Math.abs(this.tmp.x) < 0.88 && Math.abs(this.tmp.y) < 0.88 && this.tmp.z < 1;
    if (onScreen) { this.setPing(key, el, 0, 0); return; }

    const f = cam.getWorldDirection(this.tmpF);
    this.tmp.set(pos.x - origin.x, 0, pos.z - origin.z);
    const fwd = this.tmp.x * f.x + this.tmp.z * f.z;
    const right = this.tmp.x * -f.z + this.tmp.z * f.x;
    this.setPing(key, el, (Math.atan2(right, fwd) * 180) / Math.PI, 1);
  }

  setPing(key, el, deg, alpha) {
    this.set(key, `${Math.round(deg)}|${alpha}`, () => {
      el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      el.style.opacity = String(alpha);
    });
  }

  /**
   * The objective is "go to the teleporter", so the HUD has to be able to
   * answer "which way, and how far". Distance is bucketed to 5m; without that
   * this is a DOM write on every frame the player is moving.
   */
  updateObjectivePing(ctx) {
    // A live boss also ends the range readout. `tpFound` only latches on the
    // charging/complete events, so a boss that came up any other way left a
    // stale "55m" printed after "DEFEAT THE TELEPORTER BOSS" — a distance to a
    // teleporter the player is already standing in.
    const pos = this.tpFound || this.boss ? null : ctx.progression?.teleporterPosition;
    const origin = ctx.player?.position;
    if (!pos || !origin) {
      this.setPing('tpPing', this.refs.tpPing, 0, 0);
      this.set('tpDist', '', (v) => { this.refs.objectiveDist.textContent = v; });
      return;
    }
    this.ping('tpPing', this.refs.tpPing, ctx, pos);

    const dx = pos.x - origin.x;
    const dz = pos.z - origin.z;
    const metres = Math.round(Math.sqrt(dx * dx + dz * dz) / 5) * 5;
    this.set('tpDist', metres, (v) => { this.refs.objectiveDist.textContent = `${v}m`; });
  }

  updateTeleporter(ctx) {
    const live = this.tpProgress >= 0;
    this.set('tpOn', live, (v) => this.refs.tp.classList.toggle('is-on', v));
    if (!live) return;
    const p = clamp(this.tpProgress, 0, 1);
    this.set('tp', Math.round(p * 200), () => {
      const c = 2 * Math.PI * 46;
      this.refs.tpArc.style.strokeDashoffset = String(c * (1 - p));
      this.refs.tpPct.textContent = `${Math.round(p * 100)}`;
    });
  }

  /**
   * Own-downed overlay: full-screen tint + a bleed-out bar draining over
   * `REVIVE.BLEEDOUT_S`, labelled "BLEEDING OUT".
   *
   * Bound to `ctx.player.downed`/`ctx.player.bleedout` — the local pawn's own
   * flags — rather than to the `playerDowned` event's payload. On a host that
   * payload always names the real pawn, but on a client it is `NetClient`'s
   * generic `_resolve`, which maps a netId back to `ctx.player` only when the
   * netId matches this machine's own; every other shape it might carry is a
   * teammate's. Reading `ctx.player` directly sidesteps that resolution
   * entirely — `NetClient._applyAuthoritativeHealth` already writes `downed`/
   * `bleedout` onto this exact object every snapshot, on both roles, so this
   * needs no event listener and cannot be fooled by a payload aimed at
   * someone else's downing.
   */
  updateDowned(ctx) {
    const p = ctx.player;
    const downed = p?.downed === true;
    this.set('downed', downed, (v) => this.root.classList.toggle('is-downed', v));
    if (!downed) return;
    const frac = clamp((p.bleedout ?? 0) / REVIVE.BLEEDOUT_S, 0, 1);
    this.set('bleedFrac', round3(frac), (v) => {
      this.refs.downedFill.style.transform = `scaleX(${v})`;
    });
    this.set('bleedTime', Math.ceil(p.bleedout ?? 0), (v) => {
      this.refs.downedTime.textContent = `${v}s`;
    });
  }

  /**
   * Every teammate but the viewer, and whether each one is down. Roster.js
   * documents this consumer as unbuilt ("there are no teammate bars in the
   * HUD"); this is that consumer, at the floor the brief sets — a pulsing
   * chip, not a new world-space projection.
   *
   * The two roles read from different places because `Roster.js` is
   * host-only state: a client's teammates are `NetClient`'s interpolated
   * `PlayerView`s (`ctx.net.views`), which never register with `ctx.roster`
   * (the net layer "never mentions this file" — same source comment).
   * `PlayerView.downed` is the same flag a host's own pawns carry.
   */
  partyMembers(ctx) {
    if (ctx.authority) {
      const list = ctx.roster?.all;
      if (!list) return [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p && p !== ctx.player) out.push({ id: p.peerId ?? i, downed: p.downed === true });
      }
      return out;
    }
    const views = ctx.net?.views;
    if (!views) return [];
    const out = [];
    for (const v of views.values()) {
      if (v.isPlayer) out.push({ id: v.netId, downed: v.downed === true });
    }
    return out;
  }

  updateParty(ctx) {
    const host = this.refs.party;
    if (!host) return;
    const mates = this.partyMembers(ctx);
    // Rebuilt only when membership itself changes (a join, a leave) — a
    // party's roster changes far less often than its downed state, and every
    // per-frame write below is a class toggle already guarded by `set`.
    const key = mates.map((m) => m.id).join(',');
    if (this.c.partyKey !== key) {
      this.c.partyKey = key;
      host.innerHTML = mates.map((m, i) => `<div class="party-chip"><b>P${i + 2}</b></div>`).join('');
    }
    host.classList.toggle('is-on', mates.length > 0);
    const chips = host.children;
    for (let i = 0; i < mates.length; i++) chips[i]?.classList.toggle('is-down', mates[i].downed);
  }

  /**
   * Nearest downed teammate within `REVIVE.REVIVE_RADIUS`, or null. Same
   * role split as `partyMembers`: a real `Player` off `ctx.roster` on a host,
   * a `PlayerView` off `ctx.net.views` on a client.
   */
  reviveTarget(ctx, player) {
    // The viewer has to be a legal reviver, not merely near a body. This is
    // the host's own rule — `Revive._reviverFor` filters candidate revivers
    // through `Roster.targetable` — and without it two downed teammates within
    // four metres each read "HOLD E - REVIVE" across their own bleeding-out
    // overlay while the host refuses both of them.
    if (!Roster.targetable(player)) return null;
    const radius = REVIVE.REVIVE_RADIUS;
    let best = null, bestD = Infinity;
    if (ctx.authority) {
      const list = ctx.roster?.all;
      if (!list) return null;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p || p === player || p.downed !== true) continue;
        const d = horizDist(p.position, player.position);
        if (d <= radius && d < bestD) { bestD = d; best = p; }
      }
      return best;
    }
    const views = ctx.net?.views;
    if (!views) return null;
    for (const v of views.values()) {
      if (!v.isPlayer || v.downed !== true) continue;
      const d = horizDist(v.position, player.position);
      if (d <= radius && d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  /**
   * The ring's fill fraction. Host-authoritative on a host — `pawn.revive` is
   * `Revive.js`'s own clock.
   *
   * On a client it is an *approximation, and deliberately an honest one*.
   * Revive progress does not cross the wire: the downed pawn's single health
   * fraction is spent on the bleed-out clock (`NetHost._downedRecord`), the
   * bleed-out does not stall while a revive accumulates (`Revive.js:110` — the
   * clock "runs no matter who is standing over the body"), and there is no
   * spare bit in the entity layout to carry a second one. The three ways to
   * make the ring authoritative are therefore a protocol change, a new event
   * channel, or a lie; this is none of them.
   *
   * So the client mirrors the host's *eligibility test* locally — `eligible`
   * is `reviveTarget`'s verdict, which is `Roster.targetable(viewer)` plus the
   * body's replicated position inside `REVIVE_RADIUS` — and integrates on
   * `Revive.js`'s exact timing, `REVIVE_S` up and twice as fast down, keyed to
   * the current target so switching bodies resets the ring. Two consequences
   * are the point of the shape: an ineligible hold *drains* rather than
   * filling, and the ring stops at `CLIENT_RING_CAP` instead of 100%, because
   * the only thing that can honestly report a completed revive is the pawn
   * standing up — which arrives as `downed` clearing on the wire and takes the
   * whole prompt down with it.
   */
  reviveFraction(ctx, target, dt, eligible) {
    if (ctx.authority) return target.revive ?? 0;
    if (this._reviveClientTarget !== target) {
      this._reviveClientTarget = target;
      this._reviveClientT = 0;
    }
    const holding = eligible && holdingInteract(ctx.player);
    this._reviveClientT = clamp(
      this._reviveClientT + (holding ? dt / REVIVE.REVIVE_S : -2 * dt / REVIVE.REVIVE_S),
      0, CLIENT_RING_CAP,
    );
    return this._reviveClientT;
  }

  /** "HOLD E — REVIVE" + a progress ring, matching `.tp`'s own markup/update idiom. */
  updateRevive(ctx, dt) {
    const ref = this.refs;
    if (!ref.revive) return;
    const player = ctx.player;
    const raw = player ? this.reviveTarget(ctx, player) : null;

    if (raw) this._reviveMissT = 0;
    else if (this._reviveHeld) this._reviveMissT += dt;
    const target = raw || (this._reviveMissT < REVIVE_HOLD_S ? this._reviveHeld : null);
    this._reviveHeld = target;

    const on = !!target;
    this.set('reviveOn', on, (v) => ref.revive.classList.toggle('is-on', v));
    if (!on) {
      this._reviveClientTarget = null;
      this._reviveClientT = 0;
      return;
    }

    // `raw`, not `target`: inside the `REVIVE_HOLD_S` anti-flicker window the
    // prompt is still drawn for a body the viewer has just stopped being a
    // legal reviver for, and the ring must be draining for all of it.
    const frac = clamp(this.reviveFraction(ctx, target, dt, raw === target), 0, 1);
    this.set('reviveFrac', round3(frac), (v) => {
      ref.reviveArc.style.strokeDashoffset = String(REVIVE_ARC_C * (1 - v));
    });
  }

  updateDirections(ctx, dt) {
    // Prefer whatever VFX publishes; fall back to our own damage ledger.
    const external = ctx.vfx?.damageDirections;
    const list = Array.isArray(external) && external.length ? external : this.dirs;

    if (list === this.dirs) {
      for (let i = this.dirs.length - 1; i >= 0; i--) {
        this.dirs[i].life -= dt * 0.8;
        if (this.dirs[i].life <= 0) this.dirs.splice(i, 1);
      }
    }

    const cam = ctx.camera;
    const origin = ctx.player?.position;
    let f = null;
    if (cam && origin) f = cam.getWorldDirection(this.tmpF);

    for (let i = 0; i < DIR_SLOTS; i++) {
      const el = this.refs.dirs[i];
      const e = list[i];
      let deg = 0, alpha = 0;
      if (e) {
        alpha = clamp(e.alpha ?? e.life ?? e.strength ?? 1, 0, 1);
        if (typeof e.angle === 'number') {
          deg = (e.angle * 180) / Math.PI;
        } else if (f && origin) {
          const p = e.position || e.source?.position || e;
          if (typeof p?.x === 'number') {
            this.tmp.set(p.x - origin.x, 0, p.z - origin.z);
            const fwd = this.tmp.x * f.x + this.tmp.z * f.z;
            const right = this.tmp.x * -f.z + this.tmp.z * f.x;
            deg = (Math.atan2(right, fwd) * 180) / Math.PI;
          }
        }
      }
      this.set(`dir${i}`, `${Math.round(deg)}|${alpha.toFixed(2)}`, () => {
        el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
        el.style.opacity = alpha.toFixed(2);
      });
    }
  }

  updateToasts(dt) {
    let dead = false;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t -= dt;
      if (t.t <= 0.6 && !t.fading) { t.fading = true; t.el.classList.add('is-out'); }
      if (t.t <= 0) { t.el.remove(); this.toasts.splice(i, 1); dead = true; }
    }
    if (dead) this.restackToasts();
  }
}

// ------------------------------------------------------------------ helpers

function slotIndex(slot) {
  if (typeof slot === 'number') return slot;
  return SLOTS.findIndex((s) => s.id === slot || s.key === String(slot).toUpperCase());
}

/** Abilities are owned by Player; normalise the field names we might get. */
function readAbility(a) {
  if (!a) return { cd: 0, rem: 0, charges: 1, maxCharges: 1, name: '' };
  const cd = a.cooldown ?? a.cooldownTime ?? a.baseCooldown ?? 0;
  const rem = a.cooldownRemaining ?? a.remaining ?? a.timer ?? a.cd ?? 0;
  const maxCharges = a.maxCharges ?? a.maxStock ?? a.stockMax ?? 1;
  const charges = a.charges ?? a.stock ?? (rem > 0 ? 0 : 1);
  return {
    cd: Math.max(0, cd),
    rem: Math.max(0, rem),
    charges: clamp(charges, 0, maxCharges),
    maxCharges: Math.max(1, maxCharges),
    name: a.name || a.displayName || '',
  };
}

/**
 * A slot is 5.2em wide and the ability names are not. Abbreviate the leading
 * word ("Tactical Dive" -> "Tact. Dive") so the label fits whole rather than
 * being clipped mid-word; the tooltip still carries the full name.
 */
const NAME_FIT = 11;
function shortName(name) {
  if (name.length <= NAME_FIT) return name;
  const sp = name.indexOf(' ');
  if (sp < 0) return name;
  const short = `${name.slice(0, Math.min(sp, 4))}. ${name.slice(sp + 1)}`;
  return short.length < name.length ? short : name;
}

function renderPips(host, charges, max) {
  if (max <= 1) { host.innerHTML = ''; host.dataset.k = ''; return; }
  const shown = Math.min(max, PIP_CAP);
  const extra = max - shown;
  const key = `${shown}+${extra}`;
  if (host.dataset.k !== key) {
    host.dataset.k = key;
    host.innerHTML = Array.from({ length: shown }, () => '<i></i>').join('')
      + (extra > 0 ? `<b class="pip-more">+${extra}</b>` : '');
  }
  const pips = host.querySelectorAll('i');
  const lit = Math.min(charges, shown);
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('is-on', i < lit);
}

/**
 * Is the local pawn asking to pick someone up? `Revive.holdingInteract`'s
 * question, asked of the same source: the command stream, not the keyboard.
 *
 * `ctx.input.down('KeyE')` would answer it for a keyboard *and* for a pad
 * (`Input.PAD_KEYS` maps X onto `KeyE`), but it would answer it with a second
 * copy of a binding that already exists twice — in `Player._sampleInput` and
 * in `NetClient._sampleInput`, both of which fold it into `BTN.INTERACT`.
 * Reading the bit those produce is what keeps the ring, the prompt's own
 * pad/keyboard label and the host's revive scan describing one gesture.
 */
function holdingInteract(p) {
  return p?.interactPressed === true || ((p?.lastCommand?.buttons | 0) & BTN.INTERACT) !== 0;
}

/**
 * Did this purse event *mint*, as opposed to spend? `Corruption` emits both
 * currencies' changes on one channel each, with `spent: 0` on the mint path and
 * the charge on the spend paths. The count test is the second half: a mint the
 * player cannot bank (a malformed payload, or a zero) has nothing to announce.
 */
export function isMint(e) {
  return !(e?.spent > 0) && (e?.marks > 0 || e?.motes > 0);
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/** Horizontal distance, `Roster.horizDist`'s formula — see that file's note on why `hypot`. */
function horizDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Where each corruption band's threshold sits on the gauge, as a percentage of
 * the top of the scale. The gauge is an instrument reading the planet, so its
 * gradations are the planet's real numbers: re-tune `BANDS` in
 * `src/data/corruption.js` and the engraving moves with it. Pristine is the
 * origin and gets no mark.
 */
export function gaugeGradations(bands = BANDS) {
  const top = bands[bands.length - 1].at || 1;
  return bands.slice(1).map((b) => ({
    id: b.id,
    name: b.name,
    pct: Math.round((b.at / top) * 10000) / 100,
  }));
}

/**
 * The gauge's forecast line: which band is next, how many points of world
 * corruption away it is, and — in one clause — what crossing it does.
 *
 * Every part is derived. The name and the distance come from `BANDS`; the
 * consequence is the live blight toll and `pressureAt` read straight, so a
 * re-tune of either moves the sentence with the rule instead of leaving the
 * gauge quoting last month's economy. That is the whole reason this is a
 * function over the tuning tables rather than a table of strings beside them.
 *
 * Only two consequences are quoted, and deliberately: item mutation, which is
 * the one thing a crossing *takes* from you, and where no mutation is owed the
 * Director pressure the world is buying anyway. The finale route a band opens
 * is real too, but it is on its own line two rows down from stage 3 — one line
 * means one clause, and the clause is the one with a price.
 *
 * The distance clause and the effect clause answer different questions, and
 * this is the whole of the bug they were written to close. *How far* to the
 * next line is honestly `band + 1` — that line is where it is. *What it costs*
 * is not: a paid threshold never re-arms, so a party that spiked into Blighted
 * and bled back to Seeded is looking up at a mark whose blight toll it already
 * paid. `tollBand` is the lowest band that still owes one, and it belongs to
 * `Items.nextTollBand()` — the same number the crossing listener uses for its
 * loop bound and the Argent Font for its toll clock. Three readers, one
 * authority: the line that promises a threat and the code that collects it
 * cannot disagree. Absent it (a stub context, a caller with no item system) the
 * floor is `MUTATION.minBand`, which is exactly the pre-`_mutePeak` answer.
 *
 * The last band has nothing above it. Rather than invent a threshold it names
 * the band the party is in and says the truth about the top of the scale: the
 * gauge stops having lines to cross, the pressure does not stop climbing.
 *
 * Every argument degrades rather than throws: a missing or non-finite `world`,
 * `band` or `tollBand` reads as its floor. This is exported as a pure function,
 * so its contract is owed to callers that are not the gauge, and a `NaN` band
 * used to index off the end of `bands` and crash rather than say something
 * honest.
 */
export function nextThresholdLine(world, band, bands = BANDS, tollBand = MUTATION.minBand) {
  const w = Number.isFinite(world) ? Math.max(0, world) : 0;
  const i = Math.min(bands.length - 1, Math.max(0, Number.isFinite(band) ? Math.floor(band) : 0));
  const next = bands[i + 1];
  if (!next) return `${bands[i].name} - last band, feeds still scale enemies`;
  // At least 1: `band` is the system's own reading and can sit a frame behind a
  // world that has already passed the mark, and "in 0" or "in -3" is worse than
  // rounding the last point up.
  const gap = Math.max(1, Math.ceil(next.at - w));
  const toll = Number.isFinite(tollBand) ? tollBand : MUTATION.minBand;
  const effect = i + 1 >= toll
    ? 'one held item blights'
    : `enemy scale +${pressureAt(next.at).toFixed(2)}`;
  return `Next: ${next.name} in ${gap} - ${effect}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function collectRefs(root) {
  const q = (s) => root.querySelector(s);
  return {
    reticle: q('.reticle'),
    dirs: [...root.querySelectorAll('.dir')],
    lowEdge: q('.low-edge'),

    money: q('.money'),
    moneyVal: q('.money-val'),
    corruption: q('.corruption'),
    corruptionFill: q('.corruption-fill'),
    corruptionTrack: q('.corruption-track'),
    corruptionTrace: q('.corruption-trace path'),
    corruptionBand: q('.corruption-band'),
    corruptionNext: q('.corruption-next'),
    corruptionRoute: q('.corruption-route'),
    corruptionPurse: q('.corruption-purse'),
    purseMarks: q('.purse-marks'),
    purseMotes: q('.purse-motes'),
    wardingFill: q('.warding-fill'),
    sanctuaryTime: q('.sanctuary-time'),
    inventory: q('.inventory'),
    tierGroups: Object.fromEntries(
      CONTENT_TIERS.map((t) => [t, root.querySelector(`.inv-group[data-tier="${t}"]`)])
    ),

    objective: q('.objective'),
    objectiveText: q('.objective-text'),
    objectiveDist: q('.objective-dist'),

    vow: q('.vow'),
    vowText: q('.vow-text'),

    prompt: q('.prompt'),
    promptLabel: q('.prompt-label'),
    promptKey: q('.prompt-key'),

    downedOverlay: q('.downed-overlay'),
    downedFill: q('.downed-fill'),
    downedTime: q('.downed-time'),

    revive: q('.revive'),
    reviveArc: q('.revive-arc'),
    reviveKey: q('.revive-key'),

    party: q('.party'),

    bossBar: q('.bossbar'),
    bossName: q('.boss-name'),
    bossSub: q('.boss-sub'),
    bossFill: q('.boss-fill'),
    bossPct: q('.boss-pct'),
    bossPing: q('.boss-ping'),
    tpPing: q('.tp-ping'),

    tp: q('.tp'),
    tpArc: q('.tp-arc'),
    tpPct: q('.tp-pct'),

    clock: q('.clock'),
    clockTime: q('.clock-time'),
    clockDiff: q('.clock-diff'),
    clockCoef: q('.clock-coef'),
    notches: [...root.querySelectorAll('.notch')],

    hpBar: q('.hpbar'),
    hpFill: q('.hp-fill'),
    hpGhost: q('.hp-ghost'),
    hpShield: q('.hp-shield'),
    hpFlash: q('.hp-flash'),
    hpNow: q('.hp-now'),
    hpMax: q('.hp-max'),
    hpShieldNum: q('.hp-shieldnum'),

    xpBar: q('.xpbar'),
    xpFill: q('.xp-fill'),
    levelBlock: q('.level'),
    levelNum: q('.level-num'),

    log: q('.log'),

    live: q('.a11y-live'),
    caption: q('.caption'),
    tutorial: q('.tutorial-line'),

    slots: SLOTS.map((s) => slotRefs(root.querySelector(`[data-slot="${s.id}"]`))),
    equip: slotRefs(q('.slot--equip')),
  };
}

function slotRefs(el) {
  if (!el) return { el: null };
  return {
    el,
    icon: el.querySelector('.slot-icon'),
    sweep: el.querySelector('.slot-sweep'),
    timer: el.querySelector('.slot-timer'),
    pips: el.querySelector('.slot-pips'),
    name: el.querySelector('.slot-name'),
    key: el.querySelector('.slot-key'),
  };
}

// -------------------------------------------------------------------- markup

const TEMPLATE = (slots, notches, dirSlots) => `
<div class="low-edge"></div>

<!-- The two sinks of the announcer (#45, #46). The live region is visually
     hidden and always written; the caption line is visible only while the
     player has turned captions on, so it costs a sighted, hearing player
     nothing. -->
<div class="a11y-live a11y-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div class="caption" aria-hidden="true"></div>

<!-- The first-run scenario's one line (#41). Same sink shape as the caption
     above and deliberately a second element, not a share of one: a caption and
     a coaching prompt can be live in the same second and neither may overwrite
     the other. -->
<div class="tutorial-line" role="status" aria-live="polite"></div>

<div class="downed-overlay">
  <div class="downed-panel">
    <div class="downed-label">Bleeding Out</div>
    <div class="downed-bar core"><div class="downed-fill"></div></div>
    <div class="downed-time">0s</div>
  </div>
</div>

<div class="reticle">
  <i class="ret-dot"></i>
  <i class="ret-arm ret-n"></i><i class="ret-arm ret-e"></i>
  <i class="ret-arm ret-s"></i><i class="ret-arm ret-w"></i>
  <i class="ret-tick"></i>
  <i class="ret-kill"></i>
  <i class="boss-ping"></i>
  <i class="tp-ping"></i>
  <div class="dir-ring">
    ${Array.from({ length: dirSlots }, () => '<i class="dir"></i>').join('')}
  </div>
</div>

<div class="prompt">
  <b class="prompt-key">E</b>
  <span class="prompt-label"></span>
</div>

<div class="revive">
  <svg viewBox="0 0 100 100" class="revive-svg" aria-hidden="true">
    <circle class="revive-track" cx="50" cy="50" r="42" />
    <circle class="revive-arc" cx="50" cy="50" r="42" />
  </svg>
  <div class="revive-inner">
    <b class="revive-key">E</b>
    <span class="revive-label">Hold<br>Revive</span>
  </div>
</div>

<div class="zone zone--tl">
  <div class="money">
    <i class="money-chip"></i>
    <span class="money-val">$0</span>
  </div>
  <div class="corruption" data-band="0">
    <div class="corruption-track core core--bands">
      <div class="corruption-fill"></div>
      <i class="corruption-redline"></i>
      ${gaugeGradations().map((g) => `<i class="corruption-grad" style="left:${g.pct}%" data-band="${g.id}"></i>`).join('')}
    </div>
    <svg class="trace corruption-trace" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
      <path d="M 0.00 5.00 L 100.00 5.00" />
    </svg>
    <b class="corruption-band">Pristine</b>
    <div class="corruption-purse" aria-label="0 void marks, 0 argent motes">
      <span class="purse purse--marks"><b class="purse-marks">0</b><span class="purse-label">marks</span></span>
      <span class="purse purse--motes"><b class="purse-motes">0</b><span class="purse-label">motes</span></span>
      <span class="purse purse--warding"><i class="warding-track"><i class="warding-fill"></i></i><span class="purse-label">warding</span></span>
      <span class="purse purse--sanctuary"><b class="sanctuary-time">0</b><span class="purse-label">sanctuary</span></span>
    </div>
    <i class="corruption-next"></i>
    <i class="corruption-route"></i>
  </div>
  <div class="inventory">
    ${CONTENT_TIERS.map((t) => `<div class="inv-group t-${t}" data-tier="${t}"></div>`).join('')}
  </div>
</div>

<div class="zone zone--tc">
  <div class="bossbar">
    <div class="boss-head">
      <span class="boss-name">Boss</span>
      <span class="boss-pct">100%</span>
    </div>
    <div class="boss-track core">
      <div class="boss-fill"></div>
      <div class="boss-segs"></div>
    </div>
    <div class="boss-sub">Teleporter Boss</div>
  </div>

  <div class="objective">
    <i class="objective-mark"></i>
    <span class="objective-text"></span>
    <b class="objective-dist"></b>
  </div>

  <!-- The standing Vow (#177). Deliberately its own pill under the objective
       and NOT inside the corruption purse: a vow is a promise about the coming
       stage, and hanging it off the purse would read as a second currency. -->
  <div class="vow"><span class="vow-text"></span></div>

  <div class="tp">
    <svg viewBox="0 0 100 100" class="tp-svg" aria-hidden="true">
      <circle class="tp-track" cx="50" cy="50" r="46" />
      <circle class="tp-arc" cx="50" cy="50" r="46" />
    </svg>
    <div class="tp-inner">
      <span class="tp-pct">0</span><span class="tp-unit">%</span>
      <div class="tp-label">Charge</div>
    </div>
  </div>
</div>

<div class="zone zone--tr">
  <div class="clock">
    <div class="clock-time">00:00</div>
    <div class="clock-row">
      <span class="clock-diff">Easy</span>
      <span class="clock-coef">x1.0</span>
    </div>
    <div class="diffmeter">
      ${Array.from({ length: notches }, () => '<i class="notch"></i>').join('')}
    </div>
  </div>
  <div class="party"></div>
</div>

<div class="zone zone--bl">
  <div class="hpblock">
    <div class="hpbar core">
      <div class="hp-ghost"></div>
      <div class="hp-fill"></div>
      <div class="hp-shield"></div>
      <div class="hp-ticks"></div>
      <div class="hp-flash"></div>
    </div>
    <div class="hp-read">
      <span class="hp-now">0</span><i class="hp-slash">/</i><span class="hp-max">0</span>
      <span class="hp-shieldnum"></span>
    </div>
    <div class="xprow">
      <div class="level"><span class="level-tag">LVL</span><span class="level-num">1</span></div>
      <div class="xpbar core"><div class="xp-fill"></div><div class="xp-ticks"></div></div>
    </div>
  </div>
</div>

<div class="zone zone--br">
  <div class="log"></div>
  <div class="abilities">
    <!-- The equipment tile leads the cluster and is styled apart from the four
         skills (orange plate, notched frame): it is a different kind of thing
         on a different key, and a fifth identical tile would read as a fifth
         skill. Hidden entirely until something is held — see HUD.syncEquipment. -->
    <div class="slot slot--equip">
      <div class="slot-frame">
        <img class="slot-icon" alt="" draggable="false" />
        <div class="slot-sweep"></div>
        <div class="slot-timer"></div>
        <div class="slot-glow"></div>
      </div>
      <div class="slot-key">${EQUIPMENT_KEY_LABEL}</div>
      <div class="slot-name">Equipment</div>
      <div class="slot-pips"></div>
    </div>
    ${slots.map((s) => `
      <div class="slot" data-slot="${s.id}">
        <div class="slot-frame">
          <img class="slot-icon" alt="" draggable="false" />
          <div class="slot-sweep"></div>
          <div class="slot-timer"></div>
          <div class="slot-glow"></div>
        </div>
        <div class="slot-key">${s.key}</div>
        <div class="slot-name">${s.label}</div>
        <div class="slot-pips"></div>
      </div>`).join('')}
  </div>
</div>
`;
