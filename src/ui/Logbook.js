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
import { itemArt, abilityArt, tierMeta, hexOf, cardDef } from './Icons.js';

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

const KIND_LABEL = {
  survivor: 'Survivor', item: 'Item', equipment: 'Equipment', enemy: 'Monster', boss: 'Boss',
};

const TABS = [
  { id: 'survivors', label: 'Survivors' },
  { id: 'items', label: 'Items' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'enemies', label: 'Monsters' },
  { id: 'bosses', label: 'Bosses' },
  { id: 'challenges', label: 'Challenges' },
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
        </header>
        <nav class="book-tabs" data-book-tabs>
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
      case 'challenges':
        return (profile?.challengeStates?.() ?? []).map((c) => ({
          id: c.id, kind: 'challenge', name: c.name, sub: c.done ? 'Complete' : `${c.progress} / ${c.goal}`,
          card: c, tier: c.done ? 'boss' : 'common', locked: false, seen: true,
        }));
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
    this.refs.count.textContent = `${this.entries.length} catalogued · ${known} encountered`;
    this.refs.list.innerHTML = this.entries.map((e) => `
      <button class="book-row t-${e.tier}${e.locked ? ' is-locked' : ''}${e.seen ? '' : ' is-unseen'}"
              data-nav data-entry="${e.id}">
        <i class="book-row-mark"></i>
        <span class="book-row-name">${escapeHtml(e.locked ? '???' : e.name)}</span>
        <em class="book-row-sub">${escapeHtml(e.locked ? 'Locked' : e.sub)}</em>
      </button>`).join('');
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

  survivorDetail(entry) {
    const c = entry.card;
    const accent = hexOf(c.accentColor);
    const abilities = loadoutOf(c);
    return `
      <div class="book-head" style="--accent:${accent}">
        <div class="book-title">${escapeHtml(c.name)}</div>
        <div class="book-sub">${escapeHtml(c.subtitle)}</div>
      </div>
      <div class="book-stage" data-viewer></div>
      <p class="book-lore">${escapeHtml(c.lore)}</p>
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
      </div>
      <div class="book-art"><img src="${itemArt(d.id, d.tier)}" alt="" draggable="false" /></div>
      <div class="book-stats">
        ${entry.kind === 'equipment' ? statCell('Cooldown', `${d.cooldown}s`) : ''}
        ${statCell('Stacking', entry.kind === 'equipment' ? 'Does not stack' : 'Stacks')}
      </div>
      <p class="book-lore book-lore--plain">${escapeHtml(desc)}</p>
      ${d.flavour ? `<p class="book-flavour">"${escapeHtml(d.flavour)}"</p>` : ''}`;
  }

  monsterDetail(entry) {
    const d = entry.card;
    const meta = tierMeta(entry.tier);
    const lore = BESTIARY_LORE[d.id] || 'No field notes recorded.';
    return `
      <div class="book-head" style="--accent:${meta.color}">
        <div class="book-title">${escapeHtml(d.name)}</div>
        <div class="book-sub">${escapeHtml(d.isBoss ? 'Teleporter Boss' : `Tier ${d.tier} — ${prettyBehavior(d)}`)}</div>
      </div>
      <div class="book-stage" data-viewer></div>
      <div class="book-stats">
        ${statCell('Health', Math.round(d.baseHealth))}
        ${statCell('Damage', Math.round(d.baseDamage))}
        ${statCell('Speed', `${d.moveSpeed.toFixed(1)} m/s`)}
        ${statCell('Reach', `${(d.attackRange ?? 0).toFixed(1)} m`)}
      </div>
      <p class="book-lore">${escapeHtml(lore)}</p>`;
  }

  challengeDetail(entry) {
    const c = entry.card;
    const pct = Math.round((c.fraction ?? 0) * 100);
    return `
      <div class="book-head" style="--accent:${c.done ? 'var(--t-boss)' : 'var(--line-hot)'}">
        <div class="book-title">${escapeHtml(c.name)}</div>
        <div class="book-sub">${c.done ? 'Complete' : c.masked ? 'Hidden' : 'In progress'}</div>
      </div>
      <p class="book-lore book-lore--plain">${escapeHtml(c.description)}</p>
      <div class="book-prog"><i style="transform:scaleX(${(c.fraction ?? 0).toFixed(3)})"></i></div>
      <div class="book-prog-read">${c.progress} / ${c.goal} <b>${pct}%</b></div>
      ${c.unlocks ? `<div class="book-reward">Unlocks — ${escapeHtml(KIND_LABEL[c.unlocks.type] || c.unlocks.type)} · ${escapeHtml(c.unlocks.id)}</div>` : ''}`;
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
  return `<div class="book-stat"><div class="book-stat-k">${escapeHtml(k)}</div><div class="book-stat-v">${escapeHtml(String(v))}</div></div>`;
}

function safeCall(fn, n) {
  try { return String(fn(n)); } catch { return ''; }
}

/** Item and equipment cards, one lookup, for the tooltip and the pickup card. */
export { cardDef };

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
