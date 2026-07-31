import * as THREE from 'three';
import { clamp, damp, invLerp } from '../core/MathUtil.js';
import { ITEM_BY_ID } from '../data/items.js';
import { abilityIcon, itemArt, TIER_ORDER } from './Icons.js';
import { Tooltip, describeItem, prettify } from './Tooltip.js';
import { Menus } from './Menus.js';

/**
 * The HUD. DOM + CSS rather than canvas so text stays crisp at any DPI.
 *
 * Everything reads through `ctx.<system>?.` — other systems come up in their
 * own time and the HUD has to render sensible placeholders until they do.
 *
 * Per-frame cost is kept near zero by diffing every value against `this.c`
 * before touching the DOM, and by animating with transforms/opacity only.
 */

const SLOTS = [
  { id: 'primary', key: 'M1', label: 'Primary' },
  { id: 'secondary', key: 'M2', label: 'Secondary' },
  // Q, not Shift — Shift is held-sprint, so the dash needs its own key.
  { id: 'utility', key: 'Q', label: 'Utility' },
  { id: 'special', key: 'R', label: 'Special' },
];

// RoR2's escalation ladder. `t` is the difficulty coefficient at which the
// tier begins; the meter fills across the span to the next one.
const DIFFICULTY = [
  { t: 0.0, name: 'Easy', color: '#7fd4ff' },
  { t: 1.6, name: 'Normal', color: '#8ef08a' },
  { t: 2.6, name: 'Hard', color: '#e9e46b' },
  { t: 4.0, name: 'Very Hard', color: '#ffb44f' },
  { t: 6.0, name: 'Insane', color: '#ff7a45' },
  { t: 9.0, name: 'Impossible', color: '#ff4634' },
  { t: 13.0, name: 'I See You', color: '#ff3ac6' },
  { t: 18.0, name: "I'm Coming For You", color: '#b44dff' },
  { t: 25.0, name: 'HAHAHAHA', color: '#ff1414' },
];

const NOTCHES = 10;
const DIR_SLOTS = 6;

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
    this.dirs = [];          // fallback damage-direction ledger
    this.toasts = [];
    this.inv = new Map();    // id -> { el, badge, count, tier }
    this.boss = null;
    this.tpProgress = -1;
    this.objective = '';
    this.stageName = '';
    this.stageIndex = 1;
    this.stats = { kills: 0, damage: 0 };
    this.hoverId = null;
    this.tmp = new THREE.Vector3();
    this.tmpF = new THREE.Vector3();

    this.buildSlots();
    this.bind(ctx);
    this.setObjective('Find and activate the teleporter');
  }

  // -------------------------------------------------------------- wiring

  buildSlots() {
    for (const s of SLOTS) {
      const img = this.root.querySelector(`[data-slot="${s.id}"] .slot-icon`);
      if (img) img.src = abilityIcon(s.id);
    }
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
      if (!e?.source || e.source === ctx.player || e.source?.isPlayer) {
        this.stats.kills++;
        this.pulse(this.refs.reticle, 'is-kill');
      }
      if (e?.isBoss && this.boss && e.victim === this.boss) this.clearBoss();
    });

    on('itemPickup', ({ id, count }) => this.onItemPickup(id, count));
    on('goldChanged', () => { /* value polled in update; event kept for parity */ });
    on('abilityUsed', ({ slot }) => {
      const i = slotIndex(slot);
      if (i >= 0) this.abilityReady[i] = false;
    });

    on('teleporterCharging', ({ progress }) => {
      this.tpProgress = clamp(progress ?? 0, 0, 1);
      this.setObjective(`Charging teleporter: ${Math.round(this.tpProgress * 100)}%`);
    });
    on('teleporterComplete', () => {
      this.tpProgress = -1;
      this.setObjective('Proceed to the next stage');
    });
    on('stageStart', ({ index, name }) => {
      this.stageIndex = (index ?? 0) + 1;
      this.stageName = name || '';
      this.tpProgress = -1;
      this.clearBoss();
      this.setObjective('Find and activate the teleporter');
      this.toast(name ? `Stage ${this.stageIndex} — ${name}` : `Stage ${this.stageIndex}`, 'stage');
    });

    on('bossSpawn', ({ enemy }) => this.setBoss(enemy));
    on('bossDead', () => this.clearBoss());
    on('playerDead', () => this.onDeath());

    // Hover tooltips only exist while the cursor is free — while pointer-locked
    // the HUD must not intercept anything.
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

  onItemPickup(id, count) {
    const def = ITEM_BY_ID.get(id) ?? null;
    const tier = def?.tier || 'common';
    let entry = this.inv.get(id);
    const total = count ?? (entry ? entry.count + 1 : 1);

    if (!entry) {
      const group = this.refs.tierGroups[tier] || this.refs.tierGroups.common;
      const el = document.createElement('div');
      el.className = `item t-${tier}`;
      el.dataset.id = id;
      el.dataset.tier = tier;
      el.innerHTML = `<img src="${itemArt(id, tier)}" alt="" draggable="false" /><b class="item-stack"></b>`;
      group.appendChild(el);
      entry = { el, badge: el.querySelector('.item-stack'), count: 0, tier };
      this.inv.set(id, entry);
      group.classList.add('has-items');
      requestAnimationFrame(() => el.classList.add('is-in'));
    }

    entry.count = total;
    entry.badge.textContent = total > 1 ? `x${total}` : '';
    entry.badge.classList.toggle('is-on', total > 1);
    this.pulse(entry.el, 'is-pop');

    const name = def?.name || prettify(id);
    this.toast(name, tier);
    this.menus.showPickup({
      id,
      tier,
      name,
      description: describeItem(def, total),
    });
  }

  setBoss(enemy) {
    if (!enemy) return;
    this.boss = enemy;
    this.refs.bossName.textContent = (enemy.displayName || enemy.name || 'Boss').toUpperCase();
    this.refs.bossSub.textContent = enemy.isElite ? 'Elite' : 'Teleporter Boss';
    this.refs.bossBar.classList.add('is-on');
    this.c.bossHp = -1;
  }

  clearBoss() {
    this.boss = null;
    this.refs.bossBar.classList.remove('is-on');
  }

  setObjective(text) {
    if (this.objective === text) return;
    this.objective = text;
    this.refs.objectiveText.textContent = text;
    this.pulse(this.refs.objective, 'is-change');
  }

  onDeath() {
    const items = [...this.inv.entries()].map(([id, e]) => ({ id, tier: e.tier, count: e.count }));
    const diff = this.difficultyOf(this.ctx.director?.difficultyCoefficient ?? 1);
    this.menus.showDeath({
      time: formatTime(this.ctx.time ?? 0),
      stage: String(this.stageIndex),
      stageName: this.stageName,
      kills: this.stats.kills,
      damage: Math.round(this.stats.damage).toLocaleString(),
      itemCount: items.reduce((a, b) => a + b.count, 0),
      difficulty: diff.name,
      items,
    });
  }

  /** Public hook so other systems can push a line into the log. */
  toast(text, tier = 'common') {
    const el = document.createElement('div');
    el.className = `toast t-${tier}`;
    el.innerHTML = `<i class="toast-mark"></i><span>${escapeHtml(text)}</span>`;
    this.refs.log.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    this.toasts.push({ el, t: 5 });
    while (this.toasts.length > 6) {
      const dead = this.toasts.shift();
      dead.el.remove();
    }
  }

  /** Restart a CSS animation without leaving a stale class behind. */
  pulse(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------------------------------------------------------------- update

  update(ctx, dt) {
    this.menus.update(ctx, dt);

    const cursor = !document.pointerLockElement;
    this.set('cursor', cursor, (v) => this.root.classList.toggle('has-cursor', v));
    if (!cursor && this.hoverId) { this.hoverId = null; this.tooltip.hide(); }

    const hidden = this.menus.screen === 'title' || this.menus.screen === 'death';
    this.set('hidden', hidden, (v) => this.root.classList.toggle('is-hidden', v));
    if (hidden) return;

    this.updateHealth(ctx, dt);
    this.updateExperience(ctx);
    this.updateMoney(ctx, dt);
    this.updateClock(ctx);
    this.updateAbilities(ctx);
    this.updateBoss(ctx);
    this.updateTeleporter(ctx);
    this.updateDirections(ctx, dt);
    this.updateToasts(dt);

    if (this.hoverId) {
      const el = this.inv.get(this.hoverId)?.el;
      if (el) this.tooltip.place(el);
    }
  }

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

  updateExperience(ctx) {
    const p = ctx.player;
    const level = Math.max(1, Math.floor(p?.level ?? 1));
    const xp = Math.max(0, p?.xp ?? p?.experience ?? 0);
    const next = Math.max(1, p?.xpToNext ?? p?.xpNext ?? p?.experienceToNext ?? 100);
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
    const gold = Math.max(0, Math.floor(ctx.items?.gold ?? ctx.player?.gold ?? 0));
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
    this.set('diffName', d.name, (v) => {
      this.refs.clockDiff.textContent = v;
      this.refs.clock.style.setProperty('--diff', d.color);
      this.pulse(this.refs.clock, 'is-escalate');
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

      const p = a.cd > 0 ? clamp(a.rem / a.cd, 0, 1) : 0;
      this.set(`cd${i}`, round3(p), (v) => {
        ref.sweep.style.transform = `scaleY(${v})`;
        ref.el.classList.toggle('is-cooling', v > 0.001);
      });
      // The sweep already reads a sub-second cooldown; printing "0.1" over the
      // icon only costs the player the ability to identify the slot.
      this.set(`cdt${i}`, a.rem >= 1 ? String(Math.ceil(a.rem)) : '', (v) => {
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
    const cam = ctx.camera;
    const pos = boss.position;
    const origin = ctx.player?.position;
    if (!cam || !pos || !origin) { this.setBossPing(0, 0); return; }

    this.tmp.set(pos.x, pos.y, pos.z).project(cam);
    const onScreen = Math.abs(this.tmp.x) < 0.88 && Math.abs(this.tmp.y) < 0.88 && this.tmp.z < 1;
    if (onScreen) { this.setBossPing(0, 0); return; }

    const f = cam.getWorldDirection(this.tmpF);
    this.tmp.set(pos.x - origin.x, 0, pos.z - origin.z);
    const fwd = this.tmp.x * f.x + this.tmp.z * f.z;
    const right = this.tmp.x * -f.z + this.tmp.z * f.x;
    this.setBossPing((Math.atan2(right, fwd) * 180) / Math.PI, 1);
  }

  setBossPing(deg, alpha) {
    this.set('bossPing', `${Math.round(deg)}|${alpha}`, () => {
      const el = this.refs.bossPing;
      el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      el.style.opacity = String(alpha);
    });
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
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t -= dt;
      if (t.t <= 0.6 && !t.fading) { t.fading = true; t.el.classList.add('is-out'); }
      if (t.t <= 0) { t.el.remove(); this.toasts.splice(i, 1); }
    }
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
  if (max <= 1) { host.innerHTML = ''; return; }
  if (host.childElementCount !== max) {
    host.innerHTML = Array.from({ length: max }, () => '<i></i>').join('');
  }
  const pips = host.children;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('is-on', i < charges);
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

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
    inventory: q('.inventory'),
    tierGroups: Object.fromEntries(
      TIER_ORDER.map((t) => [t, root.querySelector(`.inv-group[data-tier="${t}"]`)])
    ),

    objective: q('.objective'),
    objectiveText: q('.objective-text'),

    bossBar: q('.bossbar'),
    bossName: q('.boss-name'),
    bossSub: q('.boss-sub'),
    bossFill: q('.boss-fill'),
    bossPct: q('.boss-pct'),
    bossPing: q('.boss-ping'),

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

    slots: SLOTS.map((s) => {
      const el = root.querySelector(`[data-slot="${s.id}"]`);
      return {
        el,
        sweep: el.querySelector('.slot-sweep'),
        timer: el.querySelector('.slot-timer'),
        pips: el.querySelector('.slot-pips'),
        name: el.querySelector('.slot-name'),
      };
    }),
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
  <div class="dir-ring">
    ${Array.from({ length: dirSlots }, () => '<i class="dir"></i>').join('')}
  </div>
</div>

<div class="zone zone--tl">
  <div class="money">
    <i class="money-chip"></i>
    <span class="money-val">$0</span>
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
    <div class="boss-track">
      <div class="boss-fill"></div>
      <div class="boss-segs"></div>
    </div>
    <div class="boss-sub">Teleporter Boss</div>
  </div>

  <div class="objective">
    <i class="objective-mark"></i>
    <span class="objective-text"></span>
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
    <div class="hpbar">
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
      <div class="xpbar"><div class="xp-fill"></div><div class="xp-ticks"></div></div>
    </div>
  </div>
</div>

<div class="zone zone--br">
  <div class="log"></div>
  <div class="abilities">
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
