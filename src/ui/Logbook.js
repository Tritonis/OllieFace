// The logbook: every survivor, item, equipment, enemy and boss the game owns,
// browsable, with a live 3D viewer for anything that has a rig and the card's
// own copy for anything that doesn't.
//
// Two rules this file is built around:
//
//  1. **Unlock state comes from the profile and nowhere else.** Entries are
//     rendered from `ctx.profile.isUnlocked(type, id)` and
//     `ctx.profile.isDiscovered(kind, id)`; challenge rows come from
//     `challengeState()`, which masks the hidden ones for us. Reading
//     `CHALLENGE_BY_ID` here would leak every surprise in the game.
//  2. **The viewer owns a GL context, so it is disposed, not dropped.** See
//     `ModelPreview` below — the renderer, its canvas, every geometry and
//     material this file built, and any pooled enemy rig it borrowed all go
//     back on close. A menu that leaks a context per open is a menu that
//     kills the run it returns to.
//
// Visual language is `hud.css`'s: chamfered plates, one shear token, tier
// colour carries tier and shape carries identity. Nothing new is invented here.

import * as THREE from 'three';
import { SURVIVORS, loadoutOf } from '../data/survivors.js';
import { ITEMS } from '../data/items.js';
import { EQUIPMENT } from '../data/equipment.js';
import { SPAWN_CARDS, BOSS_CARDS } from '../data/enemies.js';
import { CHALLENGE_CATEGORIES } from '../data/challenges.js';
import { itemArt, abilityArt, tierMeta, hexOf, cardDef, tracePath } from './Icons.js';

// ---------------------------------------------------------------- 3D preview

/** Fraction of the panel the subject fills. Above ~1.25 a Colossus's horns clip. */
const FILL = 1.15;

/**
 * A small self-contained model viewer.
 *
 * Deliberately its own `WebGLRenderer` rather than a scissored corner of the
 * main one: the game's frame goes through a five-pass composer with bloom,
 * GTAO and SMAA, and a menu portrait has no business threading itself into
 * that. One extra context, created on first open, destroyed on close.
 *
 * The subject is supplied by the caller along with the callback that releases
 * it — enemy rigs come from `EnemyMeshes`' pool and must be *returned*, not
 * disposed, while a `CharacterMesh` this file built is ours to destroy.
 */
export class ModelPreview {
  constructor(host) {
    this.host = host;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.subject = null;
    this.release = null;
    this.spin = 0.6;      // radians/second
    this.angle = 0.6;
    this.owned = [];      // geometries/materials this class created itself
  }

  /** Lazily bring the context up. Returns false if WebGL is unavailable. */
  mount() {
    if (this.renderer) return true;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      return false;    // software fallback, no second context — degrade to art only
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    // Matched to RenderPipeline so a survivor's palette reads the same in the
    // portrait as it does in the field.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'mv-canvas';
    this.host.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    // One committed key from the upper front-left, a cold fill from behind and
    // a warm bounce off the floor — the same three-term setup the stage runs,
    // so a rig photographed here is lit the way it is lit in play.
    const key = new THREE.DirectionalLight(0xffe7cf, 3.1);
    key.position.set(-3.2, 4.6, 3.4);
    const rim = new THREE.DirectionalLight(0x8fc6ff, 1.9);
    rim.position.set(2.8, 2.2, -3.6);
    const bounce = new THREE.HemisphereLight(0x6f86a8, 0x2a1c16, 0.85);
    scene.add(key, rim, bounce);
    this.lights = [key, rim, bounce];

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    this.scene = scene;
    this.pivot = new THREE.Group();
    scene.add(this.pivot);
    this.resize();
    return true;
  }

  resize() {
    if (!this.renderer) return;
    const w = Math.max(1, this.host.clientWidth | 0);
    const h = Math.max(1, this.host.clientHeight | 0);
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Re-solve the standoff: the framing is derived from the aspect, so a
    // panel that reflows would otherwise leave the subject cropped or adrift.
    this.frame();
  }

  /**
   * Solve the camera distance from the subject's own bounds.
   *
   * Both terms matter. Height alone frames a survivor; a Colossus is four times
   * wider than it is tall relative to the viewport, and dividing the width term
   * by the aspect is what stops it hanging out of both sides of a portrait
   * panel. The first version of this multiplied where it should have divided
   * and framed every rig at about a tenth of the panel height.
   */
  frame() {
    const f = this._framing;
    if (!f || !this.camera) return;
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const aspect = this.camera.aspect || 1;
    const dist = Math.max(
      (f.height * 0.5 * FILL) / Math.tan(vHalf),
      (f.radius * FILL) / (Math.tan(vHalf) * aspect)
    ) + f.radius;
    // Aimed a little below the subject's centre so the feet land on the floor
    // rule the panel draws rather than floating above it.
    this.camera.position.set(0, f.height * 0.05 + f.lift, dist);
    this.camera.lookAt(0, -f.height * 0.05 + f.lift, 0);
  }

  /**
   * Show `object3d`, framed from its own bounds.
   *
   * `release` is called when the subject is swapped or the viewer closes and is
   * the *only* place a subject is torn down — the caller knows whether it owns
   * the thing it handed over.
   */
  setSubject(object3d, { release = null, lift = 0, spin = 0.6 } = {}) {
    if (!this.mount()) return;
    this.clear();
    if (!object3d) return;
    this.subject = object3d;
    this.release = release;
    this.spin = spin;
    this.angle = 0.6;

    object3d.position.set(0, 0, 0);
    object3d.rotation.set(0, 0, 0);
    this.pivot.add(object3d);

    // Frame from the real bounds rather than a guessed distance: the roster
    // spans a 1.6 m engineer and a 2.0 m sniper with a metre of rifle over the
    // head, and one fixed standoff cannot hold both.
    const box = visibleBounds(object3d);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const height = Math.max(0.6, size.y);
    const radius = Math.max(0.4, Math.hypot(size.x, size.z) * 0.5);
    this.pivot.position.set(0, -centre.y + lift, 0);
    this._framing = { height, radius, lift };
    this.frame();
  }

  update(dt) {
    if (!this.renderer || !this.subject) return;
    this.resize();
    this.angle += dt * this.spin;
    this.pivot.rotation.y = this.angle;
    this.renderer.render(this.scene, this.camera);
  }

  /** Drop the current subject without tearing the context down. */
  clear() {
    if (this.subject) {
      this.pivot.remove(this.subject);
      if (this.release) this.release(this.subject);
      else disposeTree(this.subject);
    }
    this.subject = null;
    this.release = null;
  }

  /**
   * Give everything back: subject, lights, scene, the canvas and the context.
   *
   * `forceContextLoss` is not optional — a dropped `WebGLRenderer` keeps its
   * context alive until GC gets round to it, and browsers cap live contexts at
   * ~16. Open the logbook seventeen times without this and the *game's* context
   * is the one that gets evicted.
   */
  dispose() {
    this.clear();
    for (const o of this.owned) o?.dispose?.();
    this.owned.length = 0;
    if (this.lights) for (const l of this.lights) l.dispose?.();
    this.lights = null;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      this.renderer.domElement.remove();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.pivot = null;
    this._w = this._h = 0;
  }
}

/**
 * Bounds of the parts that are actually drawn.
 *
 * `Box3.setFromObject` measures every child regardless of `visible`, and an
 * enemy rig carries its telegraph decals, beam segments and shockwave discs
 * parked in the tree with `visible = false`. Measuring those framed the Basalt
 * Sentinel at a little over half the panel it was supposed to fill, because the
 * box it was solved against was mostly the reach of an attack it was not
 * making.
 */
function visibleBounds(root) {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverseVisible((o) => {
    if (!o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(_b);
  });
  if (box.isEmpty()) box.setFromObject(root);
  return box;
}
const _b = new THREE.Box3();

/** Depth-first geometry/material release for a tree this UI built itself. */
export function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) for (const mm of m) mm?.dispose?.();
    else m?.dispose?.();
  });
}

// ------------------------------------------------------------------- content

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
  beetle: 'Armoured on exactly one side and it knows which. It will show you that side for two thirds of a second before it commits.',
  spitling: 'A digestive system with legs. What it spits was, very recently, something else that lived here.',
  lemurian: 'The first thing on the survey with a jaw. Everything after it is a variation on that idea.',
  wisp: 'Burns at both ends and floats because there is not much left of it to hold down.',
  pest: 'No eyes worth the name. It finds you by the noise you make solving its friends.',
  golem: 'Quarry stone that stood up. Slow enough to walk away from, patient enough that walking away is only ever temporary.',
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
  titan: 'The survey called this a landform. The survey was taken from orbit.',
};

// Covers `UNLOCK_TYPES` as well as the encounter kinds: the challenge detail's
// reward line reads this, and until now every artifact reward printed the bare
// lowercase type because `artifact` was not in the table.
const KIND_LABEL = {
  survivor: 'Survivor', item: 'Item', equipment: 'Equipment', enemy: 'Monster', boss: 'Boss',
  artifact: 'Artifact', skin: 'Skin',
};

const TABS = [
  { id: 'survivors', label: 'Survivors' },
  { id: 'items', label: 'Items' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'enemies', label: 'Monsters' },
  { id: 'bosses', label: 'Bosses' },
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
    if (!entry) { this.refs.detail.innerHTML = '<div class="book-empty">Nothing recorded.</div>'; return; }
    if (entry.locked) {
      this.refs.detail.innerHTML = `
        <div class="book-empty book-empty--locked">
          <div class="book-lock">Locked</div>
          <p>${escapeHtml(this.unlockHint(entry))}</p>
        </div>`;
      return;
    }

    const html = {
      survivor: () => this.survivorDetail(entry),
      item: () => this.cardDetail(entry),
      equipment: () => this.cardDetail(entry),
      enemy: () => this.monsterDetail(entry),
      boss: () => this.monsterDetail(entry),
      challenge: () => this.challengeDetail(entry),
      career: () => this.careerDetail(),
      run: () => this.runDetail(entry),
    }[entry.kind];
    this.refs.detail.innerHTML = html ? html() : '';

    const stage = this.refs.detail.querySelector('[data-viewer]');
    if (stage) this.showModel(stage, entry);
  }

  unlockHint(entry) {
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

/** `m:ss` — the run clock, matching the HUD's and the summary's. */
export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A career-scale duration. `2:14` is a run; a lifetime is hours, and printing
 * `1274:31` for it is a number nobody can read at a glance.
 */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

function formatStat(v, fmt) {
  if (fmt === 'duration') return duration(v);
  if (fmt === 'clock') return clock(v);
  if (fmt === 'round') return Math.round(v).toLocaleString();
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
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

/** Item and equipment cards, one lookup, for the tooltip and the pickup card. */
export { cardDef };

// ------------------------------------------------------------- run report

const DISCOVERY_NOUN = {
  enemy: ['monster', 'monsters'],
  boss: ['boss', 'bosses'],
  item: ['item', 'items'],
  equipment: ['equipment', 'equipment'],
  survivor: ['survivor', 'survivors'],
};

/**
 * The post-run progression readout.
 *
 * This is the single most load-bearing surface in meta progression, and it is
 * not the stat grid above it. A player deciding whether to press restart is
 * answering "did that get me anywhere", and a run that ended on stage 4 with
 * nothing said about it answers no. So four things are said, in this order:
 *
 *  1. **What you earned.** Unlocks and completions, as chips — the loudest row,
 *     and empty on most runs, which is what makes it mean something when it
 *     is not.
 *  2. **What you beat.** Personal bests, phrased against the number they
 *     replaced. "Deepest stage 8 — was 6" is a sentence about the player;
 *     "Deepest stage 8" is a sentence about the run.
 *  3. **What is close.** The challenges this run advanced, nearest-first, with
 *     their bars. This is the row that sells the next run and it is the reason
 *     `Profile` snapshots progress at `beginRun` rather than reporting totals.
 *  4. **What you met.** New catalogue entries, one line.
 *
 * Rendered as a string rather than as nodes because its only caller drops it
 * into an `innerHTML` that is rebuilt on every death anyway, and a node tree
 * built here would be one more thing for that screen to own and dispose.
 *
 * Returns `''` only when there is no report at all — a death screen opened
 * without a committed run, which the harness and a mid-load quit both produce.
 * The container's `:empty` rule collapses it there rather than leaving a
 * heading over a void.
 *
 * It used to claim `''` for "a run that genuinely changed nothing", and that
 * state is not reachable: the career line below is unconditional whenever the
 * report carries lifetime numbers, which `_buildReport` populates for every
 * committed run, and `veteran`/`centurion`/`clockedIn` tick on every run until
 * each caps out, so `advanced` is non-empty too. That is the better behaviour —
 * a bad run still gets a sentence about itself rather than a bare "You Died" —
 * but it is not what the comment said, and a floor nobody can fall through is
 * not a fallback.
 */
export function renderRunReport(report) {
  if (!report) return '';
  const out = [];

  const earned = [
    ...(report.completed || []).map((c) => ({ kind: 'challenge', name: c.name })),
    ...(report.unlocks || []).map((u) => ({ kind: 'unlock', name: u.name || `${u.type}: ${u.id}` })),
  ];
  if (earned.length) {
    out.push(`<div class="stat-items-label">Earned this run</div>
      <div class="run-unlock-row">${earned
    .map((e) => `<span class="run-unlock ${e.kind}">${escapeHtml(e.name)}</span>`).join('')}</div>`);
  }

  if (report.records?.length) {
    out.push(`<div class="stat-items-label">New personal bests</div>
      <div class="run-bests">${report.records.map((r) => `
        <div class="run-best bez">
          <span class="run-best-k">${escapeHtml(r.label)}</span>
          <span class="run-best-v">${escapeHtml(formatStat(r.value, r.format === 'time' ? 'clock' : r.format))}</span>
          ${r.previous > 0
    ? `<span class="run-best-was">was ${escapeHtml(formatStat(r.previous, r.format === 'time' ? 'clock' : r.format))}</span>`
    : '<span class="run-best-was">first</span>'}
        </div>`).join('')}</div>`);
  }

  if (report.advanced?.length) {
    out.push(`<div class="stat-items-label">Closing in</div>
      <div class="run-prog-list">${report.advanced.map((a) => {
    const f = Math.max(0, Math.min(1, a.goal > 0 ? a.to / a.goal : 0));
    return `<div class="run-prog bez">
          <div class="run-prog-k">${escapeHtml(a.name)}</div>
          <div class="book-prog core"><i style="transform:scaleX(${f.toFixed(3)})"></i></div>
          <div class="run-prog-v">${progressPair(a.to, a.goal, a.format)}</div>
        </div>`;
  }).join('')}</div>`);
  }

  const disc = (report.discoveries || [])
    .map((d) => `${d.count} new ${DISCOVERY_NOUN[d.kind]?.[d.count === 1 ? 0 : 1] || d.kind}`)
    .join(' · ');
  const life = report.lifetime;
  const career = life
    ? `Run ${report.runNumber} · ${life.kills.toLocaleString()} lifetime kill${life.kills === 1 ? '' : 's'} · ${duration(life.timePlayed)} in the field`
    : '';
  if (disc || career) {
    out.push(`<div class="run-career">${escapeHtml([disc, career].filter(Boolean).join('  —  '))}</div>`);
  }

  return out.join('');
}

/**
 * Counts inside a progress readout, abbreviated past four digits.
 *
 * `1000 / 100000` in a 12-em column wraps and breaks the row; the challenge
 * goals genuinely run to six figures (lifetime gold, seconds played), and the
 * exact number is on the logbook row that this one is a pointer to.
 */
function fmtCount(n) {
  const v = Math.round(n || 0);
  if (v >= 100000) return `${Math.round(v / 1000)}k`;
  return v.toLocaleString();
}

/**
 * A challenge's `progress / goal` pair, in the unit the challenge counts in.
 *
 * `Profile` tags a time-scoped challenge `format: 'time'`; everything else is a
 * count and renders exactly as it did. Which duration helper depends on the
 * goal, not on the progress: `marathon` is thirty minutes and reads as a run
 * clock (`17:54 / 30:00`), while `clockedIn` is ten hours and would read as
 * `1074:00 / 600:00` on the same helper, so it takes the career-scale one
 * (`17m / 10h`). The switch is at an hour because that is where `clock()` stops
 * being a number anybody parses at a glance.
 *
 * `plain` is how a non-time pair is drawn, because the two call sites disagree
 * on purpose: the run report abbreviates past four digits to keep its 12-em
 * column from wrapping, and the logbook — which that column is a pointer to —
 * shows the exact number.
 */
export function progressPair(progress, goal, format, plain = fmtCount) {
  if (format === 'time') {
    const f = goal >= 3600 ? duration : clock;
    return `${f(progress)} / ${f(goal)}`;
  }
  return `${plain(progress)} / ${plain(goal)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
