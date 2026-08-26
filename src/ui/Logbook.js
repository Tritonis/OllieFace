// The always-loaded half of the logbook feature: the 3D preview widget
// (`ModelPreview`, shared with the character-select screen), its GL cleanup
// helper, and the post-run report renderer — all reachable at boot through
// `Menus`, unlike the browsing UI itself.
//
// The catalogue browser — every survivor, item, equipment, enemy and boss the
// game owns, browsable, with its own copy of the format helpers below — lives
// in `LogbookScreen.js` and is loaded on demand (issue #237): nobody who
// never opens the logbook tab should pay for its markup and content tables.
//
// `ModelPreview` owns a GL context, so it is disposed, not dropped: the
// renderer, its canvas, every geometry and material this file built, and any
// pooled enemy rig it borrowed all go back on close. A menu that leaks a
// context per open is a menu that kills the run it returns to.

import * as THREE from 'three';

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
    this._watch();
    return true;
  }

  /**
   * Wire a ResizeObserver on the host so a layout change re-frames even
   * between ticks. Split out of `mount()` so it can be exercised on its own —
   * `mount()` itself needs a real GL context this repo's tests don't have.
   *
   * The tick loop only reaches `resize()` while the logbook is open and a
   * frame is being drawn; a panel reflow that lands between ticks (a CSS
   * transition finishing, a tab's flex box settling right after the DOM swap
   * in `showModel`) would otherwise sit unframed until the next spin update
   * happens to notice. ResizeObserver catches the box the instant layout
   * actually changes, DOM-lag or not.
   */
  _watch() {
    if (typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.host);
  }

  resize() {
    if (!this.renderer) return;
    const w = this.host.clientWidth | 0;
    const h = this.host.clientHeight | 0;
    // A panel mid-reflow (display:none, a tab still animating in) can report
    // zero on either axis. Clamping that to 1 used to hand the camera a
    // wildly wrong aspect that then stuck — because it matched _w/_h and
    // suppressed the next real resize's re-frame — until something else
    // happened to jog the box. Skip the frame instead; the ResizeObserver
    // retries the moment the box is real.
    if (w <= 0 || h <= 0) return;
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
    // A survivor switch can land after the panel reflowed without a resize
    // event ever firing (the observer above debounces to layout ticks, not
    // this call) — recheck the box now so the very first frame of the new
    // subject uses a live aspect rather than whatever the last subject saw.
    this.resize();
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
    this._ro?.disconnect();
    this._ro = null;
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

// ---------------------------------------------------------------- formatting
//
// Shared by this file's `renderRunReport` and `LogbookScreen.js`'s browsing
// UI, so both read a run's numbers the same way.

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

export function formatStat(v, fmt) {
  if (fmt === 'duration') return duration(v);
  if (fmt === 'clock') return clock(v);
  if (fmt === 'round') return Math.round(v).toLocaleString();
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
