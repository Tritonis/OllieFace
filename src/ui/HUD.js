import * as THREE from 'three';
import { clamp, damp, invLerp } from '../core/MathUtil.js';
import { ITEM_BY_ID } from '../data/items.js';
// The affix keys are internal ids (three are RoR2's elite prefixes verbatim);
// only the label may reach the screen. tests/branding-display.test.mjs pins it.
import { ELITE_STATS } from '../data/enemies.js';
// Tuning data, not the system: the band names and the top of the gauge come
// from the same table `Corruption` bands against. The value itself is read
// through `ctx.corruption`.
import { BANDS } from '../data/corruption.js';
// The same routing table the finale portals are built from, read here only to
// name the door the current band is buying. The HUD spawns nothing.
import { routesFor } from '../data/realms.js';
// A constant, not the system: the key the equipment slot is bound to is decided
// in one place (`Items`) and printed in another, and hardcoding 'F' here is how
// a rebind ships a HUD that lies about its own controls. Nothing else about
// Items is imported — the slot itself is read through `ctx.items`.
import { EQUIPMENT_KEY_LABEL } from '../systems/Items.js';
import { abilityIcon, abilityArt, equipmentArt, itemArt, hexOf, TIER_ORDER, tracePathFrom } from './Icons.js';
import { Tooltip, describeItem, prettify } from './Tooltip.js';
import { Menus } from './Menus.js';
import { isLocalVictim, isLocalKill } from '../core/Engine.js';

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

// Full-bleed screens own the frame outright. A pause or settings panel is a
// sheet over a live run and the HUD behind it is still that run's state, but
// the title, the survivor select, the logbook and the summary each fill the
// viewport — leaving the corners of the HUD poking out from behind one of them
// is two interfaces at once.
const FULL_SCREENS = new Set(['title', 'death', 'select', 'logbook', 'difficulty', 'artifacts']);

export class HUD {
  init(ctx) {
    this.ctx = ctx;
    ctx.hud = this;

    this.root = document.getElementById('hud');
    this.root.innerHTML = TEMPLATE(SLOTS, NOTCHES, DIR_SLOTS);
    this.$ = (sel) => this.root.querySelector(sel);
    this.refs = collectRefs(this.root);

    this.tooltip = new Tooltip(ctx, this.root);
    this.menus = new Menus(ctx);

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
      //    excludes kills whose source is an *enemy* — an Overloading death
      //    blast, a Blazing aura, a stray mortar — which `isLocalKill`'s
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

    on('equipmentChanged', () => this.syncEquipment());
    on('equipmentUsed', () => {
      this.pulse(this.refs.equip.el, 'is-fire');
      this.equipReady = false;
    });

    on('itemPickup', ({ id, count, reason }) => this.onItemPickup(id, count, reason));
    // The strip already repaints itself off the two `itemPickup` writes the
    // conversion rides, so this line exists only to say *why* the pack changed
    // — otherwise a stack silently vanishes and an unfamiliar one appears.
    on('itemMutated', ({ baseId, blightId, count }) => {
      const base = ITEM_BY_ID.get(baseId), blight = ITEM_BY_ID.get(blightId);
      if (!blight) return;
      this.toast(`${base?.name || prettify(baseId)} festers — ${count}x ${blight.name}`, 'blight', blightId);
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
    this.menus.showPickup({
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
    this.menus.showDeath({
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
    this.menus.update(ctx, dt);

    const cursor = !document.pointerLockElement;
    this.set('cursor', cursor, (v) => this.root.classList.toggle('has-cursor', v));
    if (!cursor && this.hoverId) { this.hoverId = null; this.tooltip.hide(); }

    const hidden = FULL_SCREENS.has(this.menus.screen);
    this.set('hidden', hidden, (v) => this.root.classList.toggle('is-hidden', v));
    if (hidden) { this.stripRect = null; return; }

    this.set('padPrompt', !!ctx.input?.padActive, (pad) => {
      if (this.refs.promptKey) this.refs.promptKey.textContent = pad ? 'X' : 'E';
    });

    this.updateHealth(ctx, dt);
    this.updateExperience(ctx);
    this.updateMoney(ctx, dt);
    this.updateClock(ctx);
    this.updateAbilities(ctx);
    this.updateEquipment(ctx);
    this.updateBoss(ctx);
    this.updateTeleporter(ctx);
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

  lateUpdate(ctx, dt) {
    // Runs after CameraRig, so the title orbit is what actually ships to the
    // renderer while the menu is up.
    this.menus.orbit(ctx, dt);
  }

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
      this.set('corruptionBand', cor.band ?? 0, (v) => {
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

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

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
    corruptionRoute: q('.corruption-route'),
    inventory: q('.inventory'),
    tierGroups: Object.fromEntries(
      TIER_ORDER.map((t) => [t, root.querySelector(`.inv-group[data-tier="${t}"]`)])
    ),

    objective: q('.objective'),
    objectiveText: q('.objective-text'),
    objectiveDist: q('.objective-dist'),

    prompt: q('.prompt'),
    promptLabel: q('.prompt-label'),
    promptKey: q('.prompt-key'),

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
  };
}

// -------------------------------------------------------------------- markup

const TEMPLATE = (slots, notches, dirSlots) => `
<div class="low-edge"></div>

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
    <i class="corruption-route"></i>
  </div>
  <div class="inventory">
    ${TIER_ORDER.map((t) => `<div class="inv-group t-${t}" data-tier="${t}"></div>`).join('')}
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
