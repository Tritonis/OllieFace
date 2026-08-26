// The logbook's browsing UI: every survivor, item, equipment, enemy and boss
// the game owns, browsable, with a live 3D viewer for anything that has a rig
// and the card's own copy for anything that doesn't.
//
// Split out of `Logbook.js` (issue #237): `Menus` never touches this file
// until a player actually opens the logbook tab, so its own code — and the
// content tables it pulls in that nothing else at boot needs — never lands in
// the entry chunk. `ModelPreview`, `disposeTree`, and the run-report renderer
// stay behind in `Logbook.js` because `Menus` needs them at boot (character
// select's own preview, the death screen's report).
//
// Two rules this file is built around:
//
//  1. **Unlock state comes from the profile and nowhere else.** Entries are
//     rendered from `ctx.profile.isUnlocked(type, id)` and
//     `ctx.profile.isDiscovered(kind, id)`; challenge rows come from
//     `challengeState()`, which masks the hidden ones for us. Reading
//     `CHALLENGE_BY_ID` here would leak every surprise in the game.
//  2. **The viewer owns a GL context, so it is disposed, not dropped.** See
//     `ModelPreview` in `Logbook.js` — the renderer, its canvas, every
//     geometry and material it built, and any pooled enemy rig it borrowed
//     all go back on close. A menu that leaks a context per open is a menu
//     that kills the run it returns to.
//
// Visual language is `hud.css`'s: chamfered plates, one shear token, tier
// colour carries tier and shape carries identity. Nothing new is invented here.

import * as THREE from 'three';
import { SURVIVORS, loadoutOf } from '../data/survivors.js';
import { ITEMS } from '../data/items.js';
import { EQUIPMENT } from '../data/equipment.js';
import { SPAWN_CARDS, BOSS_CARDS } from '../data/enemies.js';
import { CHALLENGE_CATEGORIES } from '../data/challenges.js';
import { CODEX } from '../data/codex.js';
import { itemArt, abilityArt, tierMeta, hexOf, cardDef, tracePath } from './Icons.js';
import { ModelPreview, disposeTree, clock, duration, formatStat, progressPair, escapeHtml } from './Logbook.js';

/** Item and equipment cards, one lookup, for the tooltip and the pickup card. */
export { cardDef };

/**
 * Bestiary copy.
 *
 * `data/enemies.js` carries no lore field and is not mine to add one to, so the
 * flavour lines live here with the surface that shows them. The *numbers* on
 * every entry are read live off the card, so a rebalance never leaves this file
 * lying about a monster's health.
 */
const BESTIARY_LORE = {
  mite: 'Never arrives alone and never intended to. Individually it is a nuisance with teeth; the ninth one is the problem.',
  scarab: 'Armoured on exactly one side and it knows which. It will show you that side for two thirds of a second before it commits.',
  spitling: 'A digestive system with legs. What it spits was, very recently, something else that lived here.',
  skink: 'The first thing on the survey with a jaw. Everything after it is a variation on that idea.',
  mote: 'Burns at both ends and floats because there is not much left of it to hold down.',
  shrike: 'No eyes worth the name. It finds you by the noise you make solving its friends.',
  sentinel: 'Quarry stone that stood up. Slow enough to walk away from, patient enough that walking away is only ever temporary.',
  charger: 'Commits to a straight line and cannot be talked out of it. The line is the tell and the line is the danger.',
  burrower: 'Reads the ground you are standing on as a door.',
  brood: 'Not a monster. A delivery mechanism, and it is always already open.',
  harrier: 'Hunts the airspace above a fight because nothing else down there is looking up.',
  warden: 'Aegis crew. The shield is older than the thing carrying it and in better condition.',
  stalker: 'Waits in the part of the frame your eye skips. That is not an accident of behaviour; it is the whole design.',
  acolyte: 'Kneels to something that has not been here for a long time and is still, evidently, being heard.',
  mortar: 'Fires on where you are about to be. It is right more often than it should be.',
  hulk: 'The heaviest thing that still counts as ambient. Everything about it is a wall you have to go around.',
  wyrm: 'Moves through the ground the way the others move through air, and surfaces where the ground was safest.',
  thunderhead: 'A weather system with intent. The strike arrives before the sound does.',
  matron: 'Whatever else is on this stage, she put it there.',
  vizier: 'Rewrites the local rules for as long as it is standing. Kill order is not a preference.',
  maw: 'A hole with a nervous system. There is no known second stage to being inside it.',
  colossus: 'The survey called this a landform. The survey was taken from orbit.',
};

// Covers `UNLOCK_TYPES` as well as the encounter kinds: the challenge detail's
// reward line reads this, and until now every artifact reward printed the bare
// lowercase type because `artifact` was not in the table.
const KIND_LABEL = {
  survivor: 'Survivor', item: 'Item', equipment: 'Equipment', enemy: 'Monster', boss: 'Boss',
  artifact: 'Artifact', skin: 'Skin', codex: 'Codex',
};

const TABS = [
  { id: 'survivors', label: 'Survivors' },
  { id: 'items', label: 'Items' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'enemies', label: 'Monsters' },
  { id: 'bosses', label: 'Bosses' },
  // The corruption codex sits before Challenges because it is about the run
  // that is happening, not the career around it.
  { id: 'codex', label: 'Corruption' },
  { id: 'challenges', label: 'Challenges' },
  { id: 'records', label: 'Records' },
];

/**
 * The career tab's stat grid, in reading order.
 *
 * Declared as data rather than as markup because the same list is rendered
 * twice — once as lifetime totals and once, per row, as "your best" — and two
 * hand-written grids drift. `fmt` names a formatter rather than carrying one so
 * the table stays serialisable and greppable.
 */
const CAREER_ROWS = [
  { key: 'runs', label: 'Runs' },
  { key: 'wins', label: 'Runs finished' },
  { key: 'deaths', label: 'Deaths' },
  { key: 'timePlayed', label: 'Time in the field', fmt: 'duration' },
  { key: 'kills', label: 'Monsters killed' },
  { key: 'elites', label: 'Elites killed' },
  { key: 'bosses', label: 'Bosses felled' },
  { key: 'stagesCleared', label: 'Stages cleared' },
  { key: 'teleporters', label: 'Teleporters charged' },
  { key: 'items', label: 'Items collected' },
  { key: 'gold', label: 'Gold earned' },
  { key: 'damageDealt', label: 'Damage dealt', fmt: 'round' },
];

/** The personal bests. Same shape; these are the numbers a player quotes. */
const BEST_ROWS = [
  { key: 'bestStage', label: 'Deepest stage' },
  { key: 'bestTime', label: 'Longest run', fmt: 'clock' },
  { key: 'bestKills', label: 'Most kills in a run' },
  { key: 'highestHit', label: 'Biggest single hit', fmt: 'round' },
  { key: 'bestItems', label: 'Largest haul' },
  { key: 'bestGold', label: 'Richest run' },
  { key: 'bestLevel', label: 'Highest level' },
];

/**
 * The logbook screen.
 *
 * Owned by `Menus` the way `Menus` is owned by `HUD` — it is not a system, it
 * has no lifecycle, and it renders only while it is open.
 */
export class Logbook {
  constructor(ctx, root) {
    this.ctx = ctx;
    this.root = root;
    this.tab = 'survivors';
    this.selected = null;
    this.open = false;
    this.preview = null;
    this.entries = [];
    this.build();
  }

  build() {
    const el = document.createElement('section');
    el.className = 'screen screen--logbook';
    el.dataset.screen = 'logbook';
    el.innerHTML = `
      <div class="panel panel--book">
        <header class="panel-head">
          <h2>Logbook</h2>
          <div class="panel-tag" data-book-count></div>
          <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <path d="${tracePath('Logbook', { points: 56, amp: 0.5 })}" />
          </svg>
        </header>
        <nav class="book-tabs bez" data-book-tabs>
          ${TABS.map((t) => `<button class="tabbtn" data-nav data-tab="${t.id}"><span>${t.label}</span></button>`).join('')}
        </nav>
        <div class="book-body">
          <div class="book-list" data-book-list></div>
          <div class="book-detail" data-book-detail></div>
        </div>
        <nav class="menu-list menu-list--row">
          <button class="mbtn mbtn--go" data-nav data-act="back"><span>Back</span></button>
        </nav>
      </div>`;
    this.root.appendChild(el);
    this.el = el;
    this.refs = {
      tabs: el.querySelector('[data-book-tabs]'),
      list: el.querySelector('[data-book-list]'),
      detail: el.querySelector('[data-book-detail]'),
      count: el.querySelector('[data-book-count]'),
    };

    this.refs.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this.setTab(b.dataset.tab);
    });
    this.refs.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-entry]');
      if (b) this.select(b.dataset.entry);
    });
  }

  // ------------------------------------------------------------------ state

  onOpen() {
    this.open = true;
    this.setTab(this.tab, true);
  }

  /** Every GL resource this screen took goes back here. */
  onClose() {
    this.open = false;
    if (this.preview) { this.preview.dispose(); this.preview = null; }
  }

  setTab(id, force = false) {
    if (!force && this.tab === id) return;
    this.tab = id;
    for (const b of this.refs.tabs.children) b.classList.toggle('is-on', b.dataset.tab === id);
    this.entries = this.collect(id);
    this.renderList();
    this.select(this.entries[0]?.id ?? null, true);
  }

  /**
   * The rows for a tab.
   *
   * `locked` gates the *name*; `seen` gates the art. An unlockable the player
   * has not earned shows as a silhouette with its challenge named, and a piece
   * of content they have simply never met shows dimmed — two different states
   * that must not collapse into one, or the logbook stops being a reason to
   * keep playing.
   */
  collect(tab) {
    const profile = this.ctx.profile;
    const gate = (type, id) => (profile?.isUnlocked ? profile.isUnlocked(type, id) : true);
    const seen = (kind, id) => (profile?.isDiscovered ? profile.isDiscovered(kind, id) : true);

    switch (tab) {
      case 'survivors':
        return SURVIVORS.map((c) => ({
          id: c.id, kind: 'survivor', name: c.name, sub: c.subtitle, card: c,
          tier: 'common', accent: hexOf(c.accentColor),
          locked: !gate('survivor', c.id), seen: true,
        }));
      case 'items':
        return ITEMS.map((d) => ({
          id: d.id, kind: 'item', name: d.name, sub: tierMeta(d.tier).label, card: d,
          tier: d.tier, locked: !gate('item', d.id), seen: seen('item', d.id),
        }));
      case 'equipment':
        return EQUIPMENT.map((d) => ({
          id: d.id, kind: 'equipment', name: d.name, sub: `${d.cooldown}s cooldown`, card: d,
          tier: 'equipment', locked: !gate('equipment', d.id), seen: seen('equipment', d.id),
        }));
      case 'enemies':
        return SPAWN_CARDS.map((d) => ({
          id: d.id, kind: 'enemy', name: d.name, sub: `Tier ${d.tier}`, card: d,
          tier: TIER_BY_ENEMY[d.tier] || 'common', locked: false, seen: seen('enemy', d.id),
        }));
      case 'bosses':
        return BOSS_CARDS.map((d) => ({
          id: d.id, kind: 'boss', name: d.name, sub: 'Teleporter Boss', card: d,
          tier: 'boss', locked: false, seen: seen('boss', d.id),
        }));
      case 'codex':
        // `isUnlocked` is the wrong question here and would answer "yes" to
        // every page: its default is unlocked and nothing gates a codex id
        // behind a challenge. `unlockedAt` is the earned/not-earned one.
        return CODEX.map((c) => {
          const at = profile?.unlockedAt?.('codex', c.id) ?? 0;
          return {
            id: c.id, kind: 'codex', name: c.name, sub: at ? c.sub : 'Not yet recorded',
            card: c, tier: at ? 'boss' : 'common', locked: !at, seen: true, at,
          };
        });
      case 'challenges': {
        // Grouped by category, categories in `CHALLENGE_CATEGORIES` order and
        // anything with an unrecognised category swept into a trailing "Other"
        // rather than dropped — a challenge nobody can see is a challenge
        // nobody can chase, and a generated one with a typo'd category is
        // exactly the kind of thing that would otherwise vanish silently.
        const all = profile?.challengeStates?.() ?? [];
        const order = new Map(CHALLENGE_CATEGORIES.map((c, i) => [c.id, i]));
        const label = new Map(CHALLENGE_CATEGORIES.map((c) => [c.id, c.label]));
        const rank = (c) => (order.has(c.category) ? order.get(c.category) : order.size);
        return all
          .map((c, i) => ({ c, i }))
          // Stable within a group: definition order is authored order, and the
          // generated mastery block reads as a block because of it.
          .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
          .map(({ c }) => ({
            id: c.id,
            kind: 'challenge',
            name: c.name,
            sub: c.done ? 'Complete' : progressPair(c.progress, c.goal, c.format, String),
            group: label.get(c.category) || 'Other',
            card: c,
            tier: c.done ? 'boss' : 'common',
            locked: false,
            seen: true,
          }));
      }
      case 'records': {
        // One synthetic "career" row above the real run history. It is an entry
        // rather than a separate panel because the rail is already the screen's
        // navigation model, and a second one would be a second thing to learn.
        const rows = [{
          id: '__career', kind: 'career', name: 'Career', sub: 'Lifetime record',
          group: 'Summary', card: null, tier: 'boss', locked: false, seen: true,
        }];
        const runs = profile?.runHistory?.() ?? [];
        const total = profile?.lifetime?.().runs ?? runs.length;
        for (let i = 0; i < runs.length; i++) {
          const r = runs[i];
          // Numbered backwards from the lifetime total, so run #37 is run #37
          // for the rest of the profile's life even after it falls off the
          // twenty-five-run window and stops being renderable.
          const n = total - i;
          rows.push({
            id: `run:${i}`,
            kind: 'run',
            name: `Run ${n}`,
            sub: `Stage ${r.stage} · ${clock(r.time)}`,
            group: 'Recent runs',
            card: r,
            tier: r.outcome === 'victory' ? 'legendary' : 'common',
            locked: false,
            seen: true,
          });
        }
        return rows;
      }
      default:
        return [];
    }
  }

  renderList() {
    const known = this.entries.filter((e) => !e.locked && e.seen).length;
    // "0 / 16 recorded" sat above sixteen fully rendered entries, which is a
    // counter contradicting the list under it — the round-4 critique read it as
    // the panel telling the player nothing is there while showing everything.
    // The catalogue is always complete; what varies is how much of it the
    // player has met, so the tag names both figures and neither can be read as
    // the other.
    this.refs.count.textContent = this.tab === 'records'
      // "22 catalogued · 22 encountered" over a career panel is a sentence about
      // a bestiary, on the one tab that has no catalogue. The tag says what the
      // tab is about instead.
      ? this.recordsTag()
      // The codex is not a catalogue of things met — it is a page count, and
      // "5 catalogued · 2 encountered" would be describing a bestiary again.
      : this.tab === 'codex'
        ? `${known} of ${this.entries.length} recorded`
        : `${this.entries.length} catalogued · ${known} encountered`;
    // Section headers are emitted between rows rather than being entries of
    // their own: `setTab` selects `entries[0]` and the keyboard navigator walks
    // `[data-nav]`, and a header in either of those is a focusable heading that
    // opens an empty detail panel.
    let group = null;
    const html = [];
    for (const e of this.entries) {
      if (e.group && e.group !== group) {
        group = e.group;
        html.push(`<div class="book-group">${escapeHtml(group)}</div>`);
      }
      html.push(`
      <button class="book-row t-${e.tier}${e.locked ? ' is-locked' : ''}${e.seen ? '' : ' is-unseen'}"
              data-nav data-entry="${e.id}">
        <i class="book-row-mark"></i>
        <span class="book-row-name">${escapeHtml(e.locked ? '???' : e.name)}</span>
        <em class="book-row-sub">${escapeHtml(e.locked ? 'Locked' : e.sub)}</em>
      </button>`);
    }
    this.refs.list.innerHTML = html.join('');
  }

  /** The header tag for the records tab: a one-line career sentence. */
  recordsTag() {
    const s = this.ctx.profile?.lifetime?.();
    if (!s || !s.runs) return 'No runs recorded yet';
    return `${s.runs} run${s.runs === 1 ? '' : 's'} · ${duration(s.timePlayed)} in the field`;
  }

  select(id, force = false) {
    if (!force && this.selected === id) return;
    this.selected = id;
    for (const b of this.refs.list.children) {
      const on = b.dataset.entry === id;
      b.classList.toggle('is-sel', on);
      // A twenty-two-row index scrolls; a selection the player cannot see is
      // the same as no selection at all.
      if (on) b.scrollIntoView({ block: 'nearest' });
    }
    const entry = this.entries.find((e) => e.id === id) || null;
    this.renderDetail(entry);
  }

  renderDetail(entry) {
    if (this.preview) this.preview.clear();
    if (!entry) { this.refs.detail.innerHTML = '<div class="book-empty">Nothing recorded.</div>'; this.closePreview(); return; }
    if (entry.locked) {
      this.refs.detail.innerHTML = `
        <div class="book-empty book-empty--locked">
          <div class="book-lock">Locked</div>
          <p>${escapeHtml(this.unlockHint(entry))}</p>
        </div>`;
      this.closePreview();
      return;
    }

    const html = {
      survivor: () => this.survivorDetail(entry),
      item: () => this.cardDetail(entry),
      equipment: () => this.cardDetail(entry),
      enemy: () => this.monsterDetail(entry),
      boss: () => this.monsterDetail(entry),
      challenge: () => this.challengeDetail(entry),
      codex: () => this.codexDetail(entry),
      career: () => this.careerDetail(),
      run: () => this.runDetail(entry),
    }[entry.kind];
    this.refs.detail.innerHTML = html ? html() : '';

    const stage = this.refs.detail.querySelector('[data-viewer]');
    if (stage) this.showModel(stage, entry);
    // No stage this render: the innerHTML swap above just detached whatever
    // host the preview's renderer and ResizeObserver were still attached to.
    // `clear()` only drops the subject — the context and observer are only
    // torn down here, or a viewer-less entry leaks a GL context per visit.
    else this.closePreview();
  }

  /** Tear the 3D preview all the way down, if one is up. */
  closePreview() {
    if (!this.preview) return;
    this.preview.dispose();
    this.preview = null;
  }

  unlockHint(entry) {
    // A codex page is not earned by a challenge; it is earned by living
    // through the moment it describes, and its own `hint` names that moment.
    if (entry.kind === 'codex') return entry.card?.hint || 'Keep playing.';
    const challenge = entry.card?.unlock;
    const st = challenge ? this.ctx.profile?.challengeState?.(challenge) : null;
    if (!st) return 'Keep playing. This entry unlocks itself.';
    return `${st.name} — ${st.description}${st.goal > 1 ? ` (${st.progress} / ${st.goal})` : ''}`;
  }

  // ------------------------------------------------------------ detail bodies

  /**
   * The one line that turns a catalogue entry into a record of the player's own
   * play. Empty string when there is nothing true to say — a "0 killed" line on
   * a monster nobody has met is noise, and the row is already dimmed.
   */
  encounterLine(kind, id, verb) {
    const e = this.ctx.profile?.encounter?.(kind, id);
    if (!e) return '';
    const bits = [];
    if (e.count > 0) bits.push(`${e.count.toLocaleString()} ${verb}`);
    if (e.at > 0) bits.push(`first recorded ${shortDate(e.at)}`);
    if (!bits.length) return '';
    return `<div class="book-note">${escapeHtml(bits.join(' · '))}</div>`;
  }

  survivorDetail(entry) {
    const c = entry.card;
    const accent = hexOf(c.accentColor);
    const abilities = loadoutOf(c);
    // The survivor's own career, from the per-survivor table the profile keeps.
    // This is the row the generated mastery challenge reads, so the number here
    // and the number on the challenge can never disagree.
    const career = this.ctx.profile?.survivorCareer?.(c.id);
    const careerLine = career && career.runs > 0
      ? `<div class="book-stats">
           ${statCell('Runs', career.runs)}
           ${statCell('Deepest', `Stage ${career.bestStage}`)}
           ${statCell('Longest', clock(career.bestTime))}
           ${statCell('Kills', career.kills.toLocaleString())}
         </div>`
      : '<div class="book-note">No runs recorded with this survivor.</div>';
    return `
      <div class="book-head" style="--accent:${accent}">
        <div class="book-title">${escapeHtml(c.name)}</div>
        <div class="book-sub">${escapeHtml(c.subtitle)}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(c.name, { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      <div class="book-stage" data-viewer></div>
      <p class="book-lore">${escapeHtml(c.lore)}</p>
      ${careerLine}
      <div class="book-skills">
        ${abilities.map((a) => `
          <div class="book-skill">
            <img src="${abilityArt(a.id, a.slot, accent)}" alt="" draggable="false" />
            <div>
              <div class="book-skill-name">${escapeHtml(a.name)}<b>${escapeHtml(a.key)}</b></div>
              <div class="book-skill-desc">${escapeHtml(a.description)}</div>
            </div>
          </div>`).join('')}
      </div>`;
  }

  cardDetail(entry) {
    const d = entry.card;
    const meta = tierMeta(d.tier);
    const desc = typeof d.description === 'function' ? safeCall(d.description, 1) : (d.description || '');
    return `
      <div class="book-head" style="--accent:${meta.color}">
        <div class="book-title">${escapeHtml(d.name)}</div>
        <div class="book-sub">${escapeHtml(meta.label)}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(d.name, { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      <div class="book-art"><img src="${itemArt(d.id, d.tier)}" alt="" draggable="false" /></div>
      <div class="book-stats">
        ${entry.kind === 'equipment' ? statCell('Cooldown', `${d.cooldown}s`) : ''}
        ${statCell('Stacking', entry.kind === 'equipment' ? 'Does not stack' : 'Stacks')}
      </div>
      <p class="book-lore book-lore--plain">${escapeHtml(desc)}</p>
      ${d.flavour ? `<p class="book-flavour">"${escapeHtml(d.flavour)}"</p>` : ''}
      ${this.encounterLine(entry.kind, d.id, entry.kind === 'equipment' ? 'times held' : 'collected')}`;
  }

  monsterDetail(entry) {
    const d = entry.card;
    const meta = tierMeta(entry.tier);
    const lore = BESTIARY_LORE[d.id] || 'No field notes recorded.';
    return `
      <div class="book-head" style="--accent:${meta.color}">
        <div class="book-title">${escapeHtml(d.name)}</div>
        <div class="book-sub">${escapeHtml(d.isBoss ? 'Teleporter Boss' : `Tier ${d.tier} — ${prettyBehavior(d)}`)}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(d.name, { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      <div class="book-stage" data-viewer></div>
      <div class="book-stats">
        ${statCell('Health', Math.round(d.baseHealth))}
        ${statCell('Damage', Math.round(d.baseDamage))}
        ${statCell('Speed', `${d.moveSpeed.toFixed(1)} m/s`)}
        ${statCell('Reach', `${(d.attackRange ?? 0).toFixed(1)} m`)}
      </div>
      <p class="book-lore">${escapeHtml(lore)}</p>
      ${this.encounterLine(entry.kind, d.id, entry.kind === 'boss' ? 'felled' : 'killed')}`;
  }

  /**
   * The career panel: lifetime totals, then the bests.
   *
   * Two grids rather than one, because they answer different questions and a
   * player scanning for "what should I beat" must not have to read past nine
   * cumulative totals to find the seven numbers that are actually beatable.
   */
  careerDetail() {
    const p = this.ctx.profile;
    const s = p?.lifetime?.();
    if (!s) return '<div class="book-empty">No profile.</div>';
    const cells = (rows) => rows
      .map((r) => statCell(r.label, formatStat(s[r.key] ?? 0, r.fmt)))
      .join('');
    const runs = p.runHistory?.() ?? [];
    const done = (p.challengeStates?.() ?? []).filter((c) => c.done).length;
    const all = (p.challengeStates?.() ?? []).length;
    return `
      <div class="book-head" style="--accent:var(--t-boss)">
        <div class="book-title">Career</div>
        <div class="book-sub">${s.runs ? `${s.runs} run${s.runs === 1 ? '' : 's'} recorded` : 'Nothing recorded yet'}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath('Career', { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      <div class="book-note">${done} of ${all} challenges complete${runs.length ? ` · last run ${shortDate(runs[0].at)}` : ''}</div>
      <div class="book-stats book-stats--wide">${cells(CAREER_ROWS)}</div>
      <div class="book-section">Personal bests</div>
      <div class="book-stats book-stats--wide">${cells(BEST_ROWS)}</div>`;
  }

  /**
   * One past run, as it was recorded.
   *
   * Reads only the stored record — never the live systems — so a run from a
   * build with a different item catalogue still renders. `cardDef` returns null
   * for an id this build no longer has, and that item is dropped from the haul
   * rather than drawing a broken tile.
   */
  runDetail(entry) {
    const r = entry.card;
    const won = r.outcome === 'victory';
    const inv = (r.inventory || [])
      .map((i) => ({ i, d: cardDef(i.id) }))
      .filter((x) => x.d);
    return `
      <div class="book-head" style="--accent:${won ? 'var(--t-legendary)' : 'var(--line-hot)'}">
        <div class="book-title">${escapeHtml(entry.name)}</div>
        <div class="book-sub">${escapeHtml(
    `${won ? 'Finished' : 'Died'} on stage ${r.stage}${r.stageName ? ` — ${r.stageName}` : ''}`
  )}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(entry.name, { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      <div class="book-note">${escapeHtml(shortDate(r.at))}${r.survivorId ? ` · ${escapeHtml(survivorName(r.survivorId))}` : ''}</div>
      <div class="book-stats book-stats--wide">
        ${statCell('Time', clock(r.time))}
        ${statCell('Level', r.level)}
        ${statCell('Kills', r.kills.toLocaleString())}
        ${statCell('Elites', r.elites)}
        ${statCell('Bosses', r.bosses)}
        ${statCell('Items', r.items)}
        ${statCell('Gold', Math.round(r.gold).toLocaleString())}
        ${statCell('Biggest hit', Math.round(r.highestHit).toLocaleString())}
      </div>
      ${inv.length ? `<div class="book-section">Haul</div>
        <div class="book-haul">${inv.map(({ i, d }) => `
          <div class="ditem t-${d.tier}"><img src="${itemArt(d.id, d.tier)}" alt="${escapeHtml(d.name)}" />
            ${i.count > 1 ? `<b>x${i.count}</b>` : ''}</div>`).join('')}</div>` : ''}`;
  }

  /**
   * One corruption codex page (issue #34).
   *
   * The body is rendered from the entry's own `lines(facts)`, which reads every
   * tuning number live off `data/corruption.js` and takes only the run-specific
   * ones from the profile. A page that threw — a facts blob from an older build
   * missing a field its copy assumed — would take the whole logbook detail pane
   * with it, so the render is guarded and degrades to the sealed hint.
   */
  codexDetail(entry) {
    const c = entry.card;
    const facts = this.ctx.profile?.codexFacts?.(c.id) || {};
    let lines = [];
    try {
      lines = c.lines(facts) || [];
    } catch (e) {
      console.warn(`[logbook] codex page "${c.id}" failed to render:`, e);
      lines = [c.hint];
    }
    return `
      <div class="book-head" style="--accent:var(--t-boss)">
        <div class="book-title">${escapeHtml(c.name)}</div>
        <div class="book-sub">${escapeHtml(c.sub)}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(c.name, { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      ${entry.at ? `<div class="book-note">Recorded ${escapeHtml(shortDate(entry.at))}</div>` : ''}
      ${lines.map((l) => `<p class="book-lore book-lore--plain">${escapeHtml(String(l))}</p>`).join('')}`;
  }

  challengeDetail(entry) {
    const c = entry.card;
    const pct = Math.round((c.fraction ?? 0) * 100);
    return `
      <div class="book-head" style="--accent:${c.done ? 'var(--t-boss)' : 'var(--line-hot)'}">
        <div class="book-title">${escapeHtml(c.name)}</div>
        <div class="book-sub">${c.done ? 'Complete' : c.masked ? 'Hidden' : 'In progress'}</div>
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(c.name, { points: 44, amp: 0.6 })}" />
        </svg>
      </div>
      <p class="book-lore book-lore--plain">${escapeHtml(c.description)}</p>
      <div class="book-prog core"><i style="transform:scaleX(${(c.fraction ?? 0).toFixed(3)})"></i></div>
      <div class="book-prog-read">${progressPair(c.progress, c.goal, c.format, String)} <b>${pct}%</b></div>
      ${c.unlocks ? `<div class="book-reward">Unlocks — ${escapeHtml(KIND_LABEL[c.unlocks.type] || c.unlocks.type)} · ${escapeHtml(c.unlocks.name || c.unlocks.id)}</div>` : ''}`;
  }

  // -------------------------------------------------------------- 3D subjects

  /**
   * Build the rig for `entry` and hand it to the viewer with the release the
   * viewer must call. Dynamic imports so the logbook never drags the mesh
   * modules into the boot bundle for a player who does not open it.
   */
  async showModel(stage, entry) {
    if (!this.preview) this.preview = new ModelPreview(stage);
    else if (this.preview.host !== stage) {
      // Tab switched: the old host is gone from the DOM with the canvas in it.
      this.preview.dispose();
      this.preview = new ModelPreview(stage);
    }
    if (!this.preview.mount()) { stage.classList.add('is-nogl'); return; }

    const want = entry.id;
    if (entry.kind === 'survivor') {
      const { CharacterMesh } = await import('../entities/CharacterMesh.js');
      if (!this.open || this.selected !== want) return;
      const mesh = new CharacterMesh(entry.card.meshKey);
      // Settle the springs so the portrait is the idle pose, not the build pose.
      const state = {
        velocity: new THREE.Vector3(), grounded: true, aimYaw: 0, aimPitch: -0.05,
        dashT: 0, sprint: false, moveSpeed: 7, dead: false,
      };
      for (let i = 0; i < 120; i++) mesh.update(1 / 60, state);
      this.preview.setSubject(mesh.group, { release: disposeTree, spin: 0.55 });
    } else {
      const meshes = await import('../entities/EnemyMeshes.js');
      if (!this.open || this.selected !== want) return;
      const factory = entry.card.meshFactory || entry.card.id;
      let rig = null;
      try { rig = meshes.acquireRig(factory); } catch { rig = null; }
      if (!rig) { stage.classList.add('is-nogl'); return; }
      // Pooled: give it back rather than disposing it, or the next spawn of
      // this monster builds a rig whose buffers were freed under it.
      this.preview.setSubject(rig.root, { release: () => meshes.releaseRig(rig), spin: 0.5 });
    }
  }

  update(dt) {
    if (this.open) this.preview?.update?.(dt);
  }

  /** Ordered focusables for the shared menu keyboard/gamepad navigator. */
  navTargets() {
    return [...this.el.querySelectorAll('[data-nav]')];
  }
}

// Enemy tiers 1-4 borrow the item tier palette so "how dangerous" reads at a
// glance in the same colours the rest of the UI already teaches.
const TIER_BY_ENEMY = { 1: 'common', 2: 'uncommon', 3: 'legendary', 4: 'boss' };

function prettyBehavior(d) {
  if (d.isFlyer) return 'Airborne';
  if (d.behavior === 'swarm') return 'Swarm';
  if ((d.attackRange ?? 0) > 12) return 'Ranged';
  return 'Melee';
}

function statCell(k, v) {
  return `<div class="book-stat bez"><div class="book-stat-k">${escapeHtml(k)}</div><div class="book-stat-v">${escapeHtml(String(v))}</div></div>`;
}

/**
 * Date only, in the player's own locale.
 *
 * Deliberately not a relative "3 days ago": the run list is sorted newest-first
 * already, so relative time restates the ordering, and an absolute date is the
 * thing a player uses to say "that was the evening it went well".
 */
function shortDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Name a survivor from a stored id.
 *
 * Falls back to the id, which is the right answer for a record written by a
 * build whose roster included someone this one does not — the run happened, and
 * refusing to name it would be losing history to a content change.
 */
function survivorName(id) {
  return SURVIVORS.find((c) => c.id === id)?.name || id;
}

function safeCall(fn, n) {
  try { return String(fn(n)); } catch { return ''; }
}
