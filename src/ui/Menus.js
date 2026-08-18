// Full-screen overlay screens: title, survivor select, difficulty, artifacts,
// logbook, pause, settings, co-op, run summary, pickup banner.
//
// Owned and driven by HUD (main.js only registers the HUD system), so this
// class exposes plain methods rather than the system lifecycle.

import * as THREE from 'three';
import { itemArt, equipmentArt, unknownIcon, tierMeta, abilityArt, hexOf, markIcon, TIER_ORDER, tracePath, tracePathFrom } from './Icons.js';
import { ITEMS_BY_TIER } from '../data/items.js';
import { EQUIPMENT } from '../data/equipment.js';
import { Tooltip } from './Tooltip.js';
import { SURVIVORS, getSurvivor, loadoutOf } from '../data/survivors.js';
import { Logbook, ModelPreview, disposeTree, renderRunReport } from './Logbook.js';
import { describeNet } from '../net/NetConfig.js';
import { formatRoomCode, normalizeRoomCode, tidyRoomCode } from '../net/Lobby.js';
import {
  steamAvailable, hostViaSteam, joinViaSteam, onSteamInvite, openSteamInvite,
  steamInviteNeedsConfirm, steamInviteBlocked,
} from '../net/SteamLobby.js';
import { shouldArmTutorial } from '../systems/Tutorial.js';
import { showSteamInviteNotice } from './SteamInviteNotice.js';
import { REFUSE } from '../net/Protocol.js';
import { adoptLegacyKey } from '../core/LegacyStorage.js';
import { PAD_BUTTON } from '../core/PadState.js';
import { ACTIONS, bindings, isReserved, keyLabel } from '../core/Bindings.js';
import { GLYPH_SETS, DEFAULT_GLYPH_SET, isGlyphSet, glyphLabel } from '../data/glyphs.js';

/**
 * The pad buttons that answer the mutation window's three offers, in card
 * order: D-pad LEFT, UP, RIGHT (#98). Three directions for three offers, so
 * there is no chord to teach and nothing to rebind. These indices are not in
 * `PAD_BUTTON` because the D-pad binds no gameplay action anywhere -- it is
 * hardcoded menu navigation and now, here, hardcoded offer selection.
 */
const MUTATE_PAD = [14, 12, 15];
import { telemetryEnabled, setTelemetryEnabled, readRuns, downloadRuns, clearRuns } from '../systems/Telemetry.js';
import { markDialog, focusablesIn, installFocusTrap } from './Dialogs.js';

/**
 * A refused join, in the language of the person it happened to.
 *
 * Both sides of every refusal get a line: the one who was turned away, and the
 * one who turned them away. The alternative — dropping the channel and letting
 * the generic "Disconnected from the host" stand — is what makes a deliberate,
 * correct refusal indistinguishable from a broken network, and this build
 * refuses precisely in the cases where continuing would silently mis-simulate
 * somebody.
 */
function refusalText(detail, asHost) {
  const why = detail?.reason;
  const extra = detail?.detail ? ` (${detail.detail})` : '';
  if (why === REFUSE.VERSION) {
    return asHost
      ? `Turned a player away: they are running a different version of the game${extra}. Both of you need the same build.`
      : `That host is running a different version of the game${extra}. Both of you need the same build.`;
  }
  if (why === REFUSE.SURVIVOR) {
    return asHost
      ? `Turned a player away: they picked a survivor this build does not have${extra}.`
      : 'The host does not have the survivor you picked. Choose one from their build and join again.';
  }
  return asHost
    ? `Turned a player away: their join did not make sense${extra}.`
    : 'The host refused the join. Try joining again.';
}

const STORE_KEY = 'telluric.settings';

/** The pre-rename key, adopted once in `load`. See `core/LegacyStorage.js`. */
const LEGACY_STORE_KEY = 'petrichor.settings';

/**
 * Every accessibility knob defaults to 1 — "the effect exactly as authored" —
 * so a player who never opens this screen sees the build the rubric was scored
 * against. Only `motion` is ever seeded differently, and only from an explicit
 * OS-level reduced-motion preference. See `load`.
 */
export const DEFAULTS = {
  quality: 2,
  fov: 70,
  sensitivity: 1.0,
  master: 0.8,
  sfx: 0.9,
  music: 0.6,
  shake: 1.0,
  flash: 1.0,
  aberration: 1.0,
  bloom: 1.0,
  motion: 1.0,
  spawnRate: 1.0,
  padSensitivity: 1.0,
  renderScale: 1.0,
  // 1 = Auto (adaptive controller live), 0 = Off (pinned at renderScale).
  // A number, not a boolean: `load()` only adopts finite numbers.
  dynamicRes: 1,
  // On-screen captions for the critical audio cues (#46). 1 = on, 0 = off, a
  // number for the same reason `dynamicRes` is one: `load()` only adopts
  // finite numbers off the stored blob.
  //
  // Default OFF, and — unlike `motion` — never seeded from an OS preference.
  // Reduced motion is a real platform-level flag that a player has already
  // set somewhere else and should not have to set again; there is no
  // equivalent "I want captions" signal, so inventing one from a related flag
  // would be guessing. Captions are opt-in by convention in games, and this is
  // a documented, findable setting rather than a hidden one.
  captions: 0,
  // Which pad-button names on-screen prompts print (#42). A string, not a
  // number, so it rides its own branch in `load` the way `bindings` does —
  // the generic DEFAULTS loop there only adopts finite numbers.
  controllerGlyphs: DEFAULT_GLYPH_SET,
  // Has this install ever launched a run (#41)? 0 until the first `launch`,
  // and the only reason it exists: the first-run scenario is armed for a
  // player who has never played and never again unless they ask for it from
  // the title. A number and normalised like `captions`, for the same reason --
  // `load` only adopts finite numbers, and a corrupted store must fail toward
  // the harmless side, which here is "you have played before" rather than
  // ambushing a veteran with a tutorial.
  firstRunSeen: 0,
};

const QUALITY_NAMES = ['Low', 'Medium', 'High', 'Ultra'];

/**
 * The empty room-code display: the grouped shape of a real code, in dashes.
 *
 * One constant for both the markup and the reset on leave, because the two
 * drifting apart is invisible until a player leaves a room and the box quietly
 * shrinks to a shape no code will ever fill.
 */
const CODE_PLACEHOLDER = '---------';

// Tiles per row inside one tier block on the run summary. Narrow on purpose:
// the blocks wrap as units, so 8 lets two small tiers share a line instead of
// each taking one of its own. At 16 the grouped grid was two rows taller than
// the ungrouped one and pushed the headline and both buttons off the card.
const DEATH_ROW = 8;

export const SLIDERS = [
  { key: 'renderScale', label: 'Render scale', min: 0.5, max: 1, step: 0.05, fmt: pct },
  { key: 'fov', label: 'Field of view', min: 60, max: 110, step: 1, fmt: (v) => `${v | 0}°` },
  { key: 'sensitivity', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'padSensitivity', label: 'Gamepad look', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'master', label: 'Master volume', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'sfx', label: 'SFX volume', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'music', label: 'Music volume', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'shake', label: 'Screen shake', min: 0, max: 2, step: 0.05, fmt: pct },
  // The four accessibility knobs below follow `shake` exactly: a plain number
  // on `ctx.settings`, read by the system that PRODUCES the effect rather than
  // filtered out of the finished frame. `flash` is read by `VFX.hitFlash`;
  // `aberration`, `bloom` and `motion` by `RenderPipeline.update` (and `motion`
  // again by `addShake`). At 0% each effect is genuinely not produced.
  { key: 'flash', label: 'Hit flash', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'aberration', label: 'Chromatic aberration', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'bloom', label: 'Bloom', min: 0, max: 1, step: 0.05, fmt: pct },
  // Reduces the *reactive* camera motion — shake, the aberration kick and the
  // vignette pulse — without touching the resting look. Re-seeded from the OS
  // reduced-motion preference on every load until the stored blob carries a
  // `motion` of its own, matching the CSS in index.html.
  { key: 'motion', label: 'Screen motion', min: 0, max: 1, step: 0.05, fmt: pct },
  // Gameplay pacing rather than presentation, but it lives here because this is
  // the screen players look in for knobs. The Director reads it straight off
  // `ctx.settings`; 0% means no ambient spawns at all (the teleporter boss
  // still arrives, or the run could not be finished).
  { key: 'spawnRate', label: 'Enemy spawn rate', min: 0, max: 3, step: 0.05, fmt: pct },
];

/**
 * Fallback difficulty ladder, used only while `ctx.difficulty` (agent B2) does
 * not exist.
 *
 * It is not decoration. `spawnRate` is a real `ctx.settings` key that Director
 * already reads every frame, and `Menus` owns that object — so choosing a
 * difficulty here genuinely changes the run today, and `ctx.difficultyId` is
 * the field B1's run record is already looking for. The moment B2's system
 * lands, `ctx.difficulty.list()` wins and this table stops being consulted.
 */
const FALLBACK_DIFFICULTIES = [
  { id: 'settling', name: 'Settling', description: 'Fewer monsters, a gentler clock. For learning a survivor.', spawnRate: 0.65 },
  { id: 'fracture', name: 'Fracture', description: 'The tuned curve. This is the game as it is balanced.', spawnRate: 1.0 },
  { id: 'cataclysm', name: 'Cataclysm', description: 'More of everything, sooner. Mistakes stop being survivable.', spawnRate: 1.6 },
];

/**
 * The five stats the select screen bars, each with an explicit design range it
 * is drawn against.
 *
 * These were roster-relative — `value / max(across the roster)` — which pegs
 * whichever survivor tops a stat at a full bar by construction. Kestrel tops
 * three of the five, so three of the five bars rendered at exactly 184/184 px
 * and a sniper appeared to have maximum damage AND maximum speed AND maximum
 * crit. A bar that is always full for someone carries no information at all,
 * and the compression is just as bad at the other end: base speed spans
 * 6.3-7.4, so against a roster max every survivor drew a bar within 12% of
 * every other. A fixed range wide enough to hold future survivors gives each
 * one a distinct profile and guarantees no bar ever tops out.
 */
const STAT_BARS = [
  { key: 'maxHealth', label: 'Health', range: [50, 220] },
  { key: 'damage', label: 'Damage', range: [6, 24] },
  { key: 'moveSpeed', label: 'Speed', range: [5.2, 8.8] },
  { key: 'armor', label: 'Armor', range: [0, 22] },
  { key: 'critChance', label: 'Crit', range: [0, 0.14], fmt: (v) => `${Math.round(v * 100)}%` },
];

function pct(v) { return `${Math.round(v * 100)}%`; }

export class Menus {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = document.getElementById('overlay');
    this.screen = null;
    // A stack, not a single `returnTo`. Settings opened from the difficulty
    // screen opened from select used to overwrite the one slot and leave Back
    // pointing at the screen it had just come from — three levels deep, Back
    // was a loop.
    this.stack = [];
    // Angle 0 puts the camera at `centre + (r, 16, 0)` looking straight down
    // the key light — the flattest bearing on the compass, and the first frame
    // the player ever sees. Start cross-lit instead.
    this.orbitAngle = 2.2;
    this.bannerTimer = 0;
    // The open blight-toll offer, or null. See `showMutationChoice`.
    this.mutate = null;

    this.settings = load(ctx.pipeline?.quality);
    ctx.settings = this.settings;

    // Pre-run selections. `survivorId` is the ctx field A1's Player boots from;
    // difficulty and artifacts are held here until B2's systems exist to own
    // them, and mirrored onto ctx so B1's run record can read them either way.
    this.survivorId = ctx.survivorId || SURVIVORS[0].id;
    this.difficultyId = null;
    this.artifactIds = new Set();
    // Pre-run equipment pick; null means the Random card — the stage rolls one
    // off the shared rng exactly as it did before the picker existed.
    this.equipmentId = null;

    this.edictTier = 'common';   // which tier the Edict screen is showing
    this.preview = null;         // survivor-select 3D portrait
    this.navIndex = 0;
    this.navRepeat = 0;
    this.pad = { axis: 0, buttons: new Set() };
    this.newChallenges = [];     // completed during the run in flight
    this.steamLobbyId = null;    // the open Steam lobby, if this session hosts one

    this.build();
    this.apply();
    this.bindProgress(ctx);
    this.open('title');
    // Not awaited and not conditional on the co-op screen ever being opened: a
    // friend can accept a Steam invite while this player is on the title
    // screen, and the handler has to already be there when they do.
    this.bindSteam();

    // Tab must not walk out of an open panel into the game behind it. The
    // painted ring never could, because it is a class; real focus always
    // could, and did.
    installFocusTrap(this, document);

    // Losing pointer lock mid-run means the player hit Esc — pause for them.
    document.addEventListener('pointerlockchange', () => {
      // Player exposes `alive`, never `dead`. `!== false` keeps the original
      // behaviour for the window before Player has published itself.
      if (!document.pointerLockElement && !this.screen && ctx.player?.alive !== false) {
        this.open('pause');
      }
    });
  }

  // ------------------------------------------------------------------ build

  build() {
    this.root.innerHTML = `
      <div class="scrim"></div>

      <section class="screen screen--title" data-screen="title">
        <div class="title-mark">
          <div class="title-kicker">The smell of rain on dead ground</div>
          <h1 class="title-word">TELLURIC VOID</h1>
          <svg class="trace title-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <path d="${tracePath(this.ctx.seed ?? 'telluric-void', { points: 40, amp: 0.72 })}" />
          </svg>
          <div class="title-seed">SEED <span data-seed>—</span></div>
        </div>
        <nav class="menu-list">
          <!-- Four entries at identical weight is not a menu, it is a list: the
               first frame of the game has to say where to click. The default
               action is promoted (rule, wash, marker) and the destructive one
               demoted, and the subtitles give each plate's empty right-hand
               three quarters something to do. -->
          <button class="mbtn mbtn--go" data-nav data-act="play"><span>Play</span><em class="mbtn-sub">choose a survivor</em></button>
          <!-- The first-run scenario (#41). Always present, not just on a
               first run: it is armed automatically the first time and this is
               the only way back to it afterwards. -->
          <button class="mbtn" data-nav data-act="tutorial"><span>How to play</span><em class="mbtn-sub">a short guided run</em></button>
          <button class="mbtn" data-nav data-act="logbook"><span>Logbook</span><em class="mbtn-sub">roster &amp; bestiary</em></button>
          <!-- "(beta)" is load-bearing, not decoration: co-op has never been
               played end to end by two people on a real remote network, only
               by automated probes on one machine, and four-peer joins are a
               known open item. It stays until that hand-played session
               happens. See the plan's final gate under
               .superpowers/sdd/2026-08-04-coop-roster-targeting/. -->
          <button class="mbtn" data-nav data-act="coop"><span>Co-op (beta)</span><em class="mbtn-sub">host or join</em></button>
          <button class="mbtn" data-nav data-act="settings"><span>Settings</span><em class="mbtn-sub">video &amp; input</em></button>
          <button class="mbtn mbtn--quiet" data-nav data-act="quit"><span>Quit</span><em class="mbtn-sub">exit</em></button>
        </nav>
      </section>

      <section class="screen screen--select" data-screen="select">
        <div class="sel">
          <header class="panel-head">
            <h2>Select Survivor</h2>
            <div class="panel-tag" data-sel-tag></div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Select Survivor', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="sel-body">
            <nav class="sel-roster" data-sel-roster></nav>
            <div class="sel-stage">
              <div class="sel-view" data-sel-view></div>
              <div class="sel-plate bez">
                <div class="sel-name" data-sel-name></div>
                <div class="sel-sub" data-sel-sub></div>
              </div>
              <p class="sel-lore" data-sel-lore></p>
            </div>
            <aside class="sel-info">
              <div class="sel-h">Loadout</div>
              <div class="sel-skills" data-sel-skills></div>
              <div class="sel-h">Base stats</div>
              <div class="sel-stats" data-sel-stats></div>
            </aside>
          </div>
          <footer class="sel-foot">
            <button class="chip bez" data-nav data-act="difficulty">
              <em>Difficulty</em><span data-chip-diff>—</span>
            </button>
            <button class="chip bez" data-nav data-act="artifacts">
              <em>Artifacts</em><span data-chip-arts>None</span>
            </button>
            <button class="chip bez" data-nav data-act="equipment">
              <em>Equipment</em><span data-chip-equip>Random</span>
            </button>
            <div class="sel-spacer"></div>
            <button class="mbtn mbtn--quiet" data-nav data-act="back"><span>Back</span></button>
            <button class="mbtn mbtn--go" data-nav data-act="launch"><span>Begin run</span><em class="mbtn-sub">drop</em></button>
          </footer>
        </div>
      </section>

      <section class="screen screen--difficulty" data-screen="difficulty">
        <div class="panel panel--wide">
          <header class="panel-head"><h2>Difficulty</h2><div class="panel-tag" data-diff-src></div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Difficulty', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="opt-list" data-diff-list></div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn mbtn--go" data-nav data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <section class="screen screen--artifacts" data-screen="artifacts">
        <div class="panel panel--rules">
          <header class="panel-head"><h2>Artifacts</h2><div class="panel-tag" data-art-src></div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Artifacts', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="art-note" data-art-note></div>
          <div class="art-grid" data-art-grid></div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-nav data-act="art-clear"><span>Clear all</span></button>
            <button class="mbtn" data-nav data-act="edict" data-edict-entry hidden disabled><span>The Edict</span><em class="mbtn-sub">choose your drops</em></button>
            <button class="mbtn mbtn--go" data-nav data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <!-- ============================================================ EDICT
           Artifact of the Edict's picker. The player files a standing order —
           one item per tier — and every drop funnel in the game resolves to it
           instantly. See Artifacts.commandPick for why it is a standing order
           and not a modal on each chest.

           Structurally the logbook's shape, not a new one: a vertical rail of
           tiers on the left, a dense grid on the right, one header rule across
           the top. That is deliberate — this is the fourth panel in the build
           that has to present "a list of categories, then a lot of small
           tiles", and it must read as the same product as the other three. -->
      <section class="screen screen--edict" data-screen="edict">
        <div class="panel panel--rules panel--edict">
          <header class="panel-head">
            <h2>The Edict</h2>
            <div class="panel-tag" data-edict-tag></div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('The Edict', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="art-note" data-edict-note></div>
          <div class="edict-body">
            <nav class="edict-rail" data-edict-rail></nav>
            <div class="edict-pane">
              <div class="edict-standing" data-edict-standing></div>
              <div class="edict-grid" data-edict-grid></div>
            </div>
          </div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-nav data-act="edict-clear"><span>Revoke all</span></button>
            <button class="mbtn mbtn--go" data-nav data-act="edict-back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <!-- ======================================================== EQUIPMENT
           Pre-run equipment pick. Same grid grammar as the artifacts screen —
           a rail of cards that toggle — because this is the fifth "choose from
           tiles" panel in the build and it must read as the same product. The
           Random card keeps the old roll for anyone who clicks straight past. -->
      <section class="screen screen--equipment" data-screen="equipment">
        <div class="panel panel--rules">
          <header class="panel-head"><h2>Equipment</h2><div class="panel-tag" data-equip-src>Random</div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Equipment', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="art-note is-on">The tool in your Q slot when you drop. Barrels can still swap it mid-run.</div>
          <div class="art-grid" data-equip-grid></div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn mbtn--go" data-nav data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <section class="screen screen--pause" data-screen="pause">
        <div class="panel panel--pause">
          <header class="panel-head"><h2>Paused</h2><div class="panel-tag">Run suspended</div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Paused', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="pause-body">
            <nav class="menu-list">
              <button class="mbtn mbtn--go" data-nav data-act="resume"><span>Resume</span></button>
              <button class="mbtn" data-nav data-act="edict" data-edict-entry hidden disabled><span>The Edict</span><em class="mbtn-sub">standing order — C</em></button>
              <!-- Shown only while the scenario is running -- see renderPause.
                   The pause screen is where the skip lives rather than a key of
                   its own: it is reachable from pad, mouse and keyboard already,
                   and it costs the run no binding. -->
              <button class="mbtn" data-nav data-act="tutorial-skip" data-tut-skip hidden disabled><span>Skip the tutorial</span></button>
              <button class="mbtn" data-nav data-act="logbook"><span>Logbook</span></button>
              <!-- Same caveat as the title-screen entry above; both say it. -->
              <button class="mbtn" data-nav data-act="coop"><span>Co-op (beta)</span></button>
              <button class="mbtn" data-nav data-act="settings"><span>Settings</span></button>
              <button class="mbtn mbtn--quiet" data-nav data-act="quit"><span>Quit to title</span></button>
            </nav>
            <!-- Run summary: effective stats out of the Items pipeline and the
                 haul so far, with the standard hover card on every tile. Built
                 on open, never per-frame — see renderPause. -->
            <aside class="pause-sum">
              <div class="sel-h">Stats</div>
              <div class="stat-grid pause-stats" data-pause-stats></div>
              <div class="sel-h">Carrying</div>
              <div class="pause-inv" data-pause-inv></div>
            </aside>
          </div>
        </div>
      </section>

      <section class="screen screen--settings" data-screen="settings">
        <div class="panel panel--wide">
          <header class="panel-head"><h2>Settings</h2><div class="panel-tag">Saved locally</div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Settings', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>
          <div class="settings-grid" data-settings></div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-nav data-act="reset"><span>Defaults</span></button>
            <button class="mbtn mbtn--go" data-nav data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <section class="screen screen--coop" data-screen="coop">
        <div class="panel panel--wide">
          <header class="panel-head">
            <h2>Co-op (beta)</h2>
            <div class="panel-tag" data-coop-role>Single player</div>
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Co-op (beta)', { points: 56, amp: 0.5 })}" />
            </svg>
          </header>

          <div class="coop-status" data-coop-status>
            Up to 4 players. One player hosts and runs the game; everyone else joins them.
          </div>

          <div class="coop-room" data-coop-steam hidden>
            <h3 class="coop-h">Steam</h3>
            <p class="coop-hint">The easiest way, if you and your friend are both on Steam. Host,
              then invite them from the Steam overlay — they join with one click, no codes.</p>
            <nav class="menu-list menu-list--row">
              <button class="mbtn mbtn--go" data-nav data-act="coop-steam-host"><span>Host via Steam</span></button>
              <button class="mbtn" data-nav data-act="coop-steam-invite"><span>Invite friend</span></button>
            </nav>
          </div>

          <div class="coop-room">
            <h3 class="coop-h">Room code</h3>
            <p class="coop-hint">The easy way, if a signalling server is configured. The host
              creates a room and reads out the code; everyone else types it in. The dash is
              only there to read by — typing it is optional.</p>
            <nav class="menu-list menu-list--row">
              <button class="mbtn mbtn--go" data-nav data-act="coop-room-host"><span>Create room</span></button>
              <output class="coop-code" data-coop-code>${CODE_PLACEHOLDER}</output>
              <input class="coop-input" data-coop-roomcode maxlength="9" placeholder="CODE" aria-label="Room code" />
              <button class="mbtn mbtn--go" data-nav data-act="coop-room-join"><span>Join room</span></button>
            </nav>
            <p class="coop-hint coop-wiring" data-coop-wiring></p>
          </div>

          <div class="coop-cols">
            <div class="coop-col">
              <h3 class="coop-h">Host a game</h3>
              <p class="coop-hint">Create an invite code and send it to a friend. When they
                send a reply code back, paste it below to connect them. No server needed.</p>
              <nav class="menu-list menu-list--row">
                <button class="mbtn mbtn--go" data-nav data-act="coop-invite"><span>Create invite</span></button>
                <button class="mbtn" data-nav data-act="coop-copy"><span>Copy</span></button>
              </nav>
              <label class="coop-field">
                <span>Invite code — send this to your friend</span>
                <textarea data-coop-invite readonly placeholder="Press “Create invite”"></textarea>
              </label>
              <label class="coop-field">
                <span>Their reply code — paste it here</span>
                <textarea data-coop-answer placeholder="Paste the code they send back"></textarea>
              </label>
              <nav class="menu-list menu-list--row">
                <button class="mbtn mbtn--go" data-nav data-act="coop-accept"><span>Connect them</span></button>
              </nav>
            </div>

            <div class="coop-col">
              <h3 class="coop-h">Join a game</h3>
              <p class="coop-hint">Paste your friend's invite code, then send them the reply
                code this produces. Joining ends your current run.</p>
              <label class="coop-field">
                <span>Their invite code — paste it here</span>
                <textarea data-coop-offer placeholder="Paste the invite they sent you"></textarea>
              </label>
              <nav class="menu-list menu-list--row">
                <button class="mbtn mbtn--go" data-nav data-act="coop-join"><span>Join</span></button>
                <button class="mbtn" data-nav data-act="coop-copy-reply"><span>Copy reply</span></button>
              </nav>
              <label class="coop-field">
                <span>Your reply code — send this back</span>
                <textarea data-coop-reply readonly placeholder="Appears once you press “Join”"></textarea>
              </label>
            </div>
          </div>

          <div class="coop-players" data-coop-players></div>

          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-nav data-act="coop-leave"><span>Leave co-op</span></button>
            <button class="mbtn mbtn--go" data-nav data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <!-- One screen, three outcomes. The data-ending attribute is the only
           switch: death, victory, obliterated. It is set in showDeath and every
           difference
           between the three — headline colour, rule, seal, glow, panel edge,
           button verb — hangs off it in CSS, because the critique's finding was
           that a victory was being announced in the death screen's exact red
           (249.3, 57.8, 39.5 against 249.5, 58.0, 39.4) with the same type, the
           same rule, the same panel and the same two buttons. -->
      <section class="screen screen--death" data-screen="death" data-ending="death">
        <div class="death-mark">
          <!-- Victory-only, and the death screen has no equivalent: a struck
               seal above the headline naming what ended the run. -->
          <div class="ending-seal" data-ending-seal>
            <span class="ending-seal-mark"></span>
            <span class="ending-seal-text" data-ending-seal-text></span>
          </div>
          <h2 class="death-word" data-death-word>You Died</h2>
          <div class="death-rule"></div>
          <div class="death-sub" data-death-sub></div>
        </div>
        <div class="panel panel--wide">
          <!-- The run's identity — who, on what, under which rules — leads the
               summary. Time and kills without it describe a run nobody can
               place next to their last one. -->
          <!-- The report scrolls; the buttons do not. Everything above the nav
               is authored by the *run* rather than by the layout — a long run
               collects most of a 108-item pool, earns a dozen challenges and
               beats a shelf of records — so without a bounded scroller the
               panel grew until Logbook and Restart left the viewport and the
               player was stranded with no way forward but a reload. Keeping the
               nav outside this wrapper is what guarantees it is always on
               screen, and is why this is a wrapper rather than a sticky footer:
               a sticky nav still lets content scroll through the panel's own
               bottom padding, which reads as clipping.

               Nothing inside the report is focusable, which is what made the
               scroller mouse-and-touch-only: the navigator only ever scrolls
               through paintFocus's scrollIntoView, and it had nothing in here
               to land on. Menus.navScroll is the other half — up and down
               drive this container directly while the ring sits on the nav
               below. -->
          <div class="run-report">
            <div class="run-id" data-run-id></div>
            <div class="stat-grid" data-stats></div>
            <div class="stat-items">
              <div class="stat-items-label" data-items-label>Items Collected</div>
              <div class="stat-items-row" data-death-items></div>
            </div>
            <div class="run-unlocks" data-run-unlocks></div>
          </div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-nav data-act="logbook"><span>Logbook</span></button>
            <button class="mbtn mbtn--go" data-nav data-act="restart"><span data-restart-label>Restart run</span></button>
          </nav>
        </div>
      </section>

      <div class="pickup-banner" data-banner>
        <div class="pickup-icon"><img alt="" /></div>
        <div class="pickup-copy">
          <div class="pickup-tier"></div>
          <div class="pickup-name"></div>
          <div class="pickup-desc"></div>
        </div>
      </div>

      <!-- The blight toll's choice window (issue #33). Deliberately *not* a
           [data-screen]: the run keeps running behind it, so this is the
           pickup card's grammar — a corner panel with its own clock — rather
           than a dialog that stops the world to ask a question. -->
      <div class="mutate-choice" data-mutate-choice>
        <div class="mutate-head">
          <span>The blight chooses a stack</span>
          <span class="mutate-clock" data-mutate-clock></span>
        </div>
        <div class="mutate-offers" data-mutate-offers></div>
        <button class="mbtn mutate-refuse" data-mutate-refuse><span>Let the void choose</span></button>
      </div>`;

    injectEdictStyles();

    // The logbook builds its own screen into the overlay, so it is never in the
    // markup above and cannot be edited into an inconsistent state from here.
    this.logbook = new Logbook(this.ctx, this.root);

    this.screens = {};
    for (const el of this.root.querySelectorAll('[data-screen]')) {
      this.screens[el.dataset.screen] = el;
      // Every one of these panels is modal in fact — it pauses the run and the
      // game behind it takes no input — and said so to nobody. `markDialog`
      // makes that fact legible to a screen reader; it is inert to sighted
      // play, which is why it can be applied unconditionally here rather than
      // toggled as screens open.
      markDialog(el);
    }
    this.banner = this.root.querySelector('[data-banner]');
    this.mutateEl = this.root.querySelector('[data-mutate-choice]');
    this.mutateRefs = {
      offers: this.mutateEl.querySelector('[data-mutate-offers]'),
      clock: this.mutateEl.querySelector('[data-mutate-clock]'),
    };
    // Its own listener rather than the overlay's `data-act` router: these
    // buttons are built and thrown away per offer, and routing them through
    // the router would put a gameplay decision in the same switch as "resume".
    this.mutateEl.addEventListener('click', (e) => {
      const pick = e.target.closest?.('[data-mutate-pick]');
      if (pick) { this.mutate?.onPick?.(pick.dataset.mutatePick); return; }
      if (e.target.closest?.('[data-mutate-refuse]')) this.mutate?.onRefuse?.();
    });
    this.bannerRefs = {
      img: this.banner.querySelector('img'),
      tier: this.banner.querySelector('.pickup-tier'),
      name: this.banner.querySelector('.pickup-name'),
      desc: this.banner.querySelector('.pickup-desc'),
    };
    const seed = this.root.querySelector('[data-seed]');
    if (seed) seed.textContent = String(this.ctx.seed ?? '—');

    this.buildSettings();
    this.buildSelect();

    this.root.addEventListener('click', (e) => {
      // The overlay is not the canvas and the pointer is not locked here, so
      // Input's own mouse listeners never see this. Without it a player who
      // paused with Start and then clicked Resume with the mouse would stay
      // flagged pad-active: `act('resume')` skips requestPointerLock and mouse
      // look is dead until they click the canvas again.
      // Only a real click counts: navConfirm() commits a pad-driven selection
      // with el.click(), which bubbles here untrusted. Without this guard every
      // pad-confirmed menu action would hand device authority to the mouse.
      if (e.isTrusted) this.ctx.input?.deviceUsed?.('mouse');
      const btn = e.target.closest('[data-act]');
      if (btn) { this.act(btn.dataset.act); return; }
      const diff = e.target.closest('[data-difficulty]');
      if (diff) { this.setDifficulty(diff.dataset.difficulty); return; }
      const art = e.target.closest('[data-artifact]');
      if (art) { this.toggleArtifact(art.dataset.artifact); return; }
      const equip = e.target.closest('[data-equip-id]');
      if (equip) { this.pickEquipment(equip.dataset.equipId || null); return; }
      const tierTab = e.target.closest('[data-edict-tier]');
      if (tierTab) { this.edictTier = tierTab.dataset.edictTier; this.renderEdict(); return; }
      const order = e.target.closest('[data-edict-item]');
      if (order) this.fileEdict(order.dataset.edictItem);
    });
    // The room-code field, held to what a room code is actually read as while
    // the player is still typing it. `maxlength` counts every character in the
    // box, so `ABCD - 2345` reached the join handler as `ABCD - 2` — five real
    // characters — and was refused for being too short by a message that was
    // right about a code the field had already eaten. `tidyRoomCode` keeps the
    // letters, the digits and the one dash, which always fits.
    this.root.addEventListener('input', (e) => {
      const el = e.target.closest?.('[data-coop-roomcode]');
      if (el) el.value = tidyRoomCode(el.value);
    });
    // Paste needs its own handler and not just the `input` above: the field
    // truncates a pasted string to `maxlength` before any listener sees it, so
    // the characters are gone by then. A pasted code replaces rather than
    // inserts — nobody assembles one room code out of two pastes.
    this.root.addEventListener('paste', (e) => {
      const el = e.target.closest?.('[data-coop-roomcode]');
      const text = e.clipboardData?.getData('text');
      if (!el || text == null) return;
      e.preventDefault();
      el.value = tidyRoomCode(text);
    });
    // The pause summary's hover card. Its own instance rather than the HUD's:
    // the HUD's tooltip lives inside #hud, which is hidden behind the overlay
    // whenever a menu screen is up.
    this.tooltip = new Tooltip(this.ctx, this.root);
    this.root.addEventListener('mouseover', (e) => {
      const t = e.target.closest?.('[data-tip-id]');
      if (t) this.tooltip.show(t, t.dataset.tipId, t.dataset.tipTier, Number(t.dataset.tipCount) || 1);
    });
    this.root.addEventListener('mouseout', (e) => {
      if (e.target.closest?.('[data-tip-id]')) this.tooltip.hide();
    });

    // Hovering a control makes it the focus target, so the keyboard ring and
    // the mouse never disagree about what "confirm" would press.
    this.root.addEventListener('mousemove', (e) => {
      const el = e.target.closest('[data-nav]');
      if (!el) return;
      const list = this.navTargets();
      const i = list.indexOf(el);
      if (i >= 0 && i !== this.navIndex) { this.navIndex = i; this.paintFocus(list); }
    });
  }

  buildSettings() {
    const host = this.root.querySelector('[data-settings]');
    const row = (label, control) =>
      `<div class="srow"><div class="slabel">${label}</div>${control}</div>`;

    let html = row('Quality preset',
      `<div class="sseg" data-seg="quality">${QUALITY_NAMES
        .map((n, i) => `<button class="segbtn" data-nav data-val="${i}">${n}</button>`)
        .join('')}</div>`);

    html += row('Dynamic resolution',
      `<div class="sseg" data-seg="dynamicRes">
         <button class="segbtn" data-nav data-val="1">Auto</button>
         <button class="segbtn" data-nav data-val="0">Off</button>
       </div>`);

    // Captions (#46). A `data-seg` row, so the click handler below writes it
    // into the settings blob and `save`s it exactly like `dynamicRes` — it is
    // read live by `Announcer.captionsOn` off `ctx.settings`, which is this
    // same object.
    html += row('Audio captions',
      `<div class="sseg" data-seg="captions">
         <button class="segbtn" data-nav data-val="1">On</button>
         <button class="segbtn" data-nav data-val="0">Off</button>
       </div>`);

    // Controller layout glyphs (#42): which pad-button names the HUD prompts
    // and the gamepad rebind column print. `data-strseg` rather than
    // `data-seg` — the ids are strings ('xbox', not a segment index), and the
    // generic `data-seg` handlers below compare `Number(dataset.val)`.
    html += row('Controller glyphs',
      `<div class="sseg" data-strseg="controllerGlyphs">${GLYPH_SETS
        .map((g) => `<button class="segbtn" data-nav data-val="${g.id}">${g.label}</button>`)
        .join('')}</div>`);

    for (const s of SLIDERS) {
      html += row(s.label,
        `<div class="sslider">
           <input type="range" data-nav data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
           <output data-out="${s.key}"></output>
         </div>`);
    }
    // The run record (issue #29). It lives in Settings rather than behind a
    // launch flag because opt-in has to be a thing a player can find, read and
    // undo — and because the one thing that would make it not worth having is a
    // player who does not know it is on. The buttons carry `data-act` rather
    // than `data-seg`: the segment handler below writes into the numeric
    // settings blob, and this flag is deliberately not part of it — it is read
    // at boot by `Telemetry.installTelemetry`, long before `Menus` exists.
    html += row('Run telemetry',
      `<div class="sseg" data-tseg>
         <button class="segbtn" data-nav data-act="telemetry-on">On</button>
         <button class="segbtn" data-nav data-act="telemetry-off">Off</button>
       </div>`);
    html += row('Recorded runs',
      `<div class="sseg">
         <button class="segbtn" data-nav data-act="telemetry-export" data-telemetry-count>Export</button>
         <button class="segbtn" data-nav data-act="telemetry-clear">Clear</button>
       </div>`);

    // ------------------------------------------------------------- rebinding
    // Two columns, one per device. Each cell is a button that opens the capture
    // dialog; the label it carries is the live binding, repainted by
    // `syncBindings`.
    html += `<div class="srow srow--binds"><div class="slabel">Controls</div>
        <div class="sbind sbind-head"><span>Keyboard / mouse</span><span>Gamepad</span></div>
      </div>`;
    for (const a of ACTIONS) {
      html += `<div class="srow" data-bindrow="${a.id}">
          <div class="slabel">${escapeHtml(a.label)}</div>
          <div class="sbind">
            <button class="segbtn" data-nav data-bind="key" data-action="${a.id}"></button>
            <button class="segbtn" data-nav data-bind="pad" data-action="${a.id}"></button>
          </div>
        </div>`;
    }
    html += row('Restore controls',
      `<div class="sseg">
         <button class="segbtn" data-nav data-act="binds-reset">Reset to defaults</button>
       </div>`);
    html += `<p class="sbind-note" data-bind-note role="status" aria-live="polite"></p>`;

    host.innerHTML = html;

    host.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      this.settings[key] = Number(e.target.value);
      this.apply();
      save(this.settings);
    });
    host.addEventListener('click', (e) => {
      const seg = e.target.closest('.segbtn');
      if (!seg) return;
      if (seg.dataset.bind) { this.beginCapture(seg.dataset.action, seg.dataset.bind); return; }
      const strKey = seg.closest('[data-strseg]')?.dataset.strseg;
      if (strKey) {
        this.settings[strKey] = seg.dataset.val;
        this.apply();
        save(this.settings);
        return;
      }
      const key = seg.closest('[data-seg]')?.dataset.seg;
      if (!key) return;
      this.settings[key] = Number(seg.dataset.val);
      this.apply();
      save(this.settings);
    });

    this.syncSettings();
  }

  syncSettings() {
    for (const s of SLIDERS) {
      const input = this.root.querySelector(`input[data-key="${s.key}"]`);
      const out = this.root.querySelector(`output[data-out="${s.key}"]`);
      if (input) input.value = String(this.settings[s.key]);
      if (out) {
        const v = s.fmt(this.settings[s.key]);
        // The slider is a hard ceiling, not the live scale: under Auto the
        // adaptive controller renders anywhere below it (a struggling GPU at
        // "50%" may be at 27%). Say so, rather than presenting the ceiling
        // as the value (final-review B7).
        out.textContent = (s.key === 'renderScale' && this.settings.dynamicRes !== 0)
          ? `up to ${v}` : v;
      }
    }
    for (const wrap of this.root.querySelectorAll('[data-seg]')) {
      const key = wrap.dataset.seg;
      for (const b of wrap.querySelectorAll('.segbtn')) {
        b.classList.toggle('is-on', Number(b.dataset.val) === this.settings[key]);
      }
    }
    for (const wrap of this.root.querySelectorAll('[data-strseg]')) {
      const key = wrap.dataset.strseg;
      for (const b of wrap.querySelectorAll('.segbtn')) {
        b.classList.toggle('is-on', b.dataset.val === this.settings[key]);
      }
    }
    this.syncTelemetry();
    this.syncBindings();
  }

  /**
   * Paint the telemetry row off the flag and the buffer, both of which live
   * outside `this.settings`. The count is on the button because "Export"
   * against an empty buffer is the one thing here that could look broken.
   */
  syncTelemetry() {
    const on = telemetryEnabled();
    for (const b of this.root.querySelectorAll('[data-tseg] .segbtn')) {
      b.classList.toggle('is-on', (b.dataset.act === 'telemetry-on') === on);
    }
    const btn = this.root.querySelector('[data-telemetry-count]');
    if (btn) {
      const n = readRuns().length;
      // Left enabled at zero rather than disabled: `navTargets` walks
      // `[data-nav]`, and a disabled button in that list is a dead stop for the
      // gamepad. `downloadRuns` refuses an empty buffer on its own.
      btn.textContent = n ? `Export (${n})` : 'Export';
    }
  }

  /** Paint every bind cell off the live map. */
  syncBindings() {
    for (const a of ACTIONS) {
      const rowEl = this.root.querySelector(`[data-bindrow="${a.id}"]`);
      if (!rowEl) continue;
      const kb = rowEl.querySelector('[data-bind="key"]');
      const pd = rowEl.querySelector('[data-bind="pad"]');
      if (kb) {
        kb.textContent = keyLabel(bindings.keyOf(a.id));
        kb.setAttribute('aria-label', `${a.label}, keyboard: ${keyLabel(bindings.keyOf(a.id))}. Activate to rebind.`);
      }
      if (pd) {
        const label = glyphLabel(bindings.padOf(a.id), this.settings.controllerGlyphs);
        pd.textContent = label;
        pd.setAttribute('aria-label', `${a.label}, gamepad: ${label}. Activate to rebind.`);
      }
    }
  }

  bindNote(text) {
    const el = this.root.querySelector('[data-bind-note]');
    if (el) el.textContent = text;
  }

  // --------------------------------------------------------------- rebinding
  //
  // CONFLICT RULE: swap. Assigning a key another action already holds hands
  // that action the key being displaced, and the status line says so. Blocking
  // is simpler but can strand a player mid-layout with an action they cannot
  // reach; a swap always leaves every action bound to something.

  /** Open the capture dialog for one action on one device. */
  beginCapture(actionId, device) {
    if (this.capture) return;
    const action = ACTIONS.find((a) => a.id === actionId);
    if (!action) return;

    const el = document.createElement('div');
    el.className = 'bind-capture';
    el.innerHTML = `<div class="panel bind-capture-panel">
        <h2>${escapeHtml(action.label)}</h2>
        <p>${device === 'pad'
          ? 'Press a gamepad button. Escape or B cancels.'
          : 'Press a key or mouse button. Escape cancels.'}</p>
      </div>`;
    const panel = el.firstElementChild;
    markDialog(panel);
    panel.setAttribute('aria-live', 'assertive');
    panel.setAttribute('tabindex', '-1');
    this.root.appendChild(el);
    panel.focus?.();

    // Capture phase, so the game's own window-level keydown never sees the
    // press that is being captured — Escape must not also close the screen.
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { this.endCapture('Rebinding cancelled.'); return; }
      if (device === 'pad') return;   // a key cannot fill a pad slot
      // The menu reads a handful of codes raw (see `navigate`). Binding an
      // action onto one would take menu movement, confirm, back or the Edict
      // away with no way left to reach this screen and undo it.
      if (isReserved(e.code)) {
        this.endCapture(`${keyLabel(e.code)} is reserved for menu navigation. Nothing was changed.`);
        return;
      }
      this.applyBind(actionId, 'key', e.code);
    };
    const onMouse = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (device === 'pad') return;
      this.applyBind(actionId, 'key', `Mouse${e.button}`);
    };
    addEventListener('keydown', onKey, true);
    addEventListener('mousedown', onMouse, true);
    this.capture = { actionId, device, el, onKey, onMouse };
  }

  /** Close the dialog and say what happened — to the screen reader too. */
  endCapture(note) {
    const c = this.capture;
    if (!c) return;
    this.capture = null;
    removeEventListener('keydown', c.onKey, true);
    removeEventListener('mousedown', c.onMouse, true);
    c.el.remove();
    this.syncBindings();
    if (note) this.bindNote(note);
  }

  applyBind(actionId, device, value) {
    const label = ACTIONS.find((a) => a.id === actionId)?.label ?? actionId;
    const swapped = device === 'pad'
      ? bindings.bindPad(actionId, value)
      : bindings.bindKey(actionId, value);
    const shown = device === 'pad' ? glyphLabel(value, this.settings.controllerGlyphs) : keyLabel(value);
    const other = swapped && ACTIONS.find((a) => a.id === swapped);
    save(this.settings);
    this.endCapture(other
      ? `${label} is now ${shown}. ${other.label} took the binding it displaced.`
      : `${label} is now ${shown}.`);
  }

  /** While the dialog is open, a pad press is read off the live pad edges. */
  pollCapture(ctx) {
    const c = this.capture;
    if (!c || c.device !== 'pad') return;
    const edges = ctx.input?.pad?.edges;
    if (!edges?.size) return;
    for (const btn of edges) {
      ctx.input.clearPadEdges?.();
      if (btn === PAD_BUTTON.B) this.endCapture('Rebinding cancelled.');
      else this.applyBind(c.actionId, 'pad', btn);
      return;
    }
  }

  // ---------------------------------------------------------- survivor select

  buildSelect() {
    const roster = this.root.querySelector('[data-sel-roster]');
    roster.innerHTML = SURVIVORS.map((c) => `
      <button class="sur bez" data-nav data-survivor="${c.id}" style="--accent:${hexOf(c.accentColor)}">
        <i class="sur-rule"></i>
        <span class="sur-name">${escapeHtml(c.name)}</span>
        <em class="sur-sub">${escapeHtml(c.subtitle)}</em>
        <b class="sur-lock">Locked</b>
      </button>`).join('');
    roster.addEventListener('click', (e) => {
      const b = e.target.closest('[data-survivor]');
      if (b) this.pickSurvivor(b.dataset.survivor);
    });
    this.renderSelect();
  }

  /** Is this survivor playable? Profile first, card default second. */
  survivorUnlocked(card) {
    const p = this.ctx.profile;
    if (!card.unlock) return true;
    return p?.isUnlocked ? p.isUnlocked('survivor', card.id) : true;
  }

  pickSurvivor(id) {
    const card = getSurvivor(id);
    if (!this.survivorUnlocked(card)) return;
    this.survivorId = card.id;
    this.renderSelect();
    if (this.screen === 'select') this.mountPreview();
  }

  renderSelect() {
    const card = getSurvivor(this.survivorId);
    const accent = hexOf(card.accentColor);
    const q = (s) => this.root.querySelector(s);

    let available = 0;
    for (const b of this.root.querySelectorAll('[data-survivor]')) {
      const c = getSurvivor(b.dataset.survivor);
      const ok = this.survivorUnlocked(c);
      if (ok) available++;
      b.classList.toggle('is-on', c.id === card.id);
      b.classList.toggle('is-locked', !ok);
    }
    q('[data-sel-tag]').textContent = `${available} of ${SURVIVORS.length} available`;

    q('[data-sel-name]').textContent = card.name;
    q('[data-sel-sub]').textContent = card.subtitle;
    q('[data-sel-lore]').textContent = card.lore;
    this.screens.select.style.setProperty('--accent', accent);

    q('[data-sel-skills]').innerHTML = loadoutOf(card).map((a) => `
      <div class="sk">
        <img class="sk-icon" src="${abilityArt(a.id, a.slot, accent)}" alt="" draggable="false" />
        <div class="sk-copy">
          <div class="sk-name">${escapeHtml(a.name)}<b class="sk-key">${escapeHtml(a.key)}</b></div>
          <div class="sk-desc">${escapeHtml(a.description)}</div>
        </div>
        <div class="sk-cd">${a.cooldown >= 1 ? `${a.cooldown}s` : ''}</div>
      </div>`).join('');

    const fracs = [];
    const rows = STAT_BARS.map((s) => {
      const v = card.baseStats[s.key] ?? 0;
      const [lo, hi] = s.range;
      // Floored at 0.03 rather than 0: a genuinely zero stat still has to draw
      // a stub, or an empty track reads as a bar that failed to render instead
      // of as a survivor with no armour.
      const frac = Math.max(0.03, Math.min(0.96, (v - lo) / (hi - lo)));
      const text = s.fmt ? s.fmt(v) : String(round1(v));
      fracs.push(frac);
      return `<div class="sbar">
          <div class="sbar-k">${s.label}</div>
          <div class="sbar-track core"><i style="transform:scaleX(${frac.toFixed(3)})"></i></div>
          <div class="sbar-v">${text}</div>
        </div>`;
    }).join('');
    q('[data-sel-stats]').innerHTML =
      `<svg class="trace sel-trace" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
         <path d="${tracePathFrom(fracs, { amp: 0.9 })}" />
       </svg>${rows}`;

    this.syncChips();
  }

  syncChips() {
    const d = this.currentDifficulty();
    const diff = this.root.querySelector('[data-chip-diff]');
    if (diff) diff.textContent = d ? d.name : '—';
    const arts = this.root.querySelector('[data-chip-arts]');
    if (arts) {
      const n = this.activeArtifacts().length;
      arts.textContent = n ? `${n} active` : 'None';
    }
    const equip = this.root.querySelector('[data-chip-equip]');
    if (equip) equip.textContent = this.equipmentName();
  }

  /** Display name of the current pre-run equipment pick. */
  equipmentName() {
    if (!this.equipmentId) return 'Random';
    return EQUIPMENT.find((e) => e.id === this.equipmentId)?.name ?? this.equipmentId;
  }

  /**
   * The portrait.
   *
   * Built fresh on every open and destroyed on close — see `ModelPreview`. Four
   * survivors is four `CharacterMesh` builds; caching them would hold four rigs
   * and their materials alive for the whole session so a menu could open six
   * milliseconds faster.
   */
  mountPreview() {
    const host = this.root.querySelector('[data-sel-view]');
    if (!host) return;
    if (!this.preview) this.preview = new ModelPreview(host);
    if (!this.preview.mount()) return;
    const card = getSurvivor(this.survivorId);
    const want = card.id;
    import('../entities/CharacterMesh.js').then(({ CharacterMesh }) => {
      // The player can click a second survivor while this import resolves.
      if (this.screen !== 'select' || this.survivorId !== want || !this.preview) return;
      const mesh = new CharacterMesh(card.meshKey);
      const state = {
        velocity: new THREE.Vector3(), grounded: true, aimYaw: 0, aimPitch: -0.05,
        dashT: 0, sprint: false, moveSpeed: 7, dead: false,
      };
      // Past the settle time of the slowest spring on the rig, so the portrait
      // is the idle pose rather than the raw build pose.
      for (let i = 0; i < 140; i++) mesh.update(1 / 60, state);
      this.preview.setSubject(mesh.group, { release: disposeTree, spin: 0.5 });
    }).catch(() => { /* no portrait rather than no menu */ });
  }

  unmountPreview() {
    if (!this.preview) return;
    this.preview.dispose();
    this.preview = null;
  }

  // ------------------------------------------------------- difficulty / artifacts

  /** B2's system if it is up, our own table if it is not. */
  difficultyList() {
    const list = this.ctx.difficulty?.list?.();
    return Array.isArray(list) && list.length ? list : FALLBACK_DIFFICULTIES;
  }

  currentDifficulty() {
    const list = this.difficultyList();
    const id = this.ctx.difficulty?.current?.()?.id ?? this.difficultyId ?? list[1]?.id ?? list[0]?.id;
    return list.find((d) => d.id === id) || list[0] || null;
  }

  setDifficulty(id) {
    const d = this.difficultyList().find((x) => x.id === id);
    if (!d) return;
    this.difficultyId = d.id;
    // B2's system owns the real value when it exists; ctx.difficultyId is the
    // field B1's run record reads and is set either way.
    this.ctx.difficulty?.set?.(d.id);
    this.ctx.difficultyId = d.id;
    if (!this.ctx.difficulty && Number.isFinite(d.spawnRate)) {
      // Our own fallback still has to *do* something. `spawnRate` is a live
      // Director read and this class owns the settings object it lives on.
      this.settings.spawnRate = d.spawnRate;
      this.apply();
      save(this.settings);
    }
    this.renderDifficulty();
    this.syncChips();
  }

  renderDifficulty() {
    const host = this.root.querySelector('[data-diff-list]');
    if (!host) return;
    const cur = this.currentDifficulty();
    const live = !!this.ctx.difficulty;
    this.root.querySelector('[data-diff-src]').textContent =
      live ? 'Run rules' : 'Run rules — spawn pacing';
    host.innerHTML = this.difficultyList().map((d) => `
      <button class="opt${d.id === cur?.id ? ' is-on' : ''}" data-nav data-difficulty="${escapeHtml(d.id)}"
              style="--accent:${escapeHtml(d.color || '#5fd9f7')}">
        <div class="opt-name"><i class="opt-glyph">${markImg(d.mark, d.color || '#5fd9f7')}</i>${escapeHtml(d.name)}</div>
        <div class="opt-desc">${escapeHtml(d.description || '')}</div>
        <i class="opt-tick"></i>
      </button>`).join('');
  }

  artifactList() {
    const list = this.ctx.artifacts?.list?.();
    return Array.isArray(list) ? list : [];
  }

  activeArtifacts() {
    const live = this.ctx.artifacts?.active?.();
    if (Array.isArray(live)) return live;
    return [...this.artifactIds];
  }

  artifactLocked(a) {
    if (!a?.unlock) return false;
    const p = this.ctx.profile;
    return p?.isUnlocked ? !p.isUnlocked('artifact', a.id) : false;
  }

  toggleArtifact(id) {
    const live = this.ctx.artifacts;
    // An unearned artifact is a preview of a reward, not a switch.
    if (this.artifactLocked(this.artifactList().find((a) => a.id === id))) return;
    // Read the live set back before editing it: `Artifacts` restores a stored
    // selection at boot, so a local mirror that started empty would silently
    // clear whatever the player last chose the first time they toggled one.
    const cur = new Set(this.activeArtifacts());
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    this.artifactIds = cur;
    const ids = [...cur];
    live?.setActive?.(ids);
    // Did it take? A pre-run-only system that ignores the call is the one case
    // where the UI must not just re-render its own optimistic state.
    if (live) {
      const now = new Set(live.active?.() ?? []);
      this._artifactWriteRefused = now.size !== cur.size || [...cur].some((x) => !now.has(x));
      if (this._artifactWriteRefused) this.artifactIds = now;
    }
    this.ctx.artifactIds = ids;
    this.renderArtifacts();
    this.syncChips();
  }

  renderArtifacts() {
    const grid = this.root.querySelector('[data-art-grid]');
    const note = this.root.querySelector('[data-art-note]');
    const src = this.root.querySelector('[data-art-src]');
    if (!grid) return;
    const list = this.artifactList();
    const active = new Set(this.activeArtifacts());
    src.textContent = `${active.size} active`;
    // Toggling Command on is what makes the Edict reachable, and this is the
    // screen it gets toggled on. Without this the button only appears after
    // leaving and re-entering, which reads as the build having forgotten.
    this.syncEdictEntries();

    if (!list.length) {
      // Honest empty state. A grid of invented cards that toggle nothing would
      // photograph better and lie to the player about what the build contains.
      note.textContent = 'No artifacts are present in this build. When the artifact system lands, every one it registers appears here.';
      note.classList.add('is-on');
      grid.innerHTML = '';
      return;
    }
    // `Artifacts.setActive` is pre-run only and refuses silently once a stage
    // has started, which from inside a pause menu is indistinguishable from a
    // broken button. Say it instead.
    const locked = !!this.ctx.artifacts && this._artifactWriteRefused;
    note.textContent = locked
      ? 'The rules are set when you drop. These take effect on your next run — choose them from the title screen.'
      : '';
    note.classList.toggle('is-on', locked);
    grid.innerHTML = list.map((a) => {
      const locked = this.artifactLocked(a);
      // A locked artifact still shows its name and its condition — it is a
      // reason to keep playing, not a hole in the grid. Only the effect is
      // withheld, and only because knowing it is the reward.
      const hint = locked ? this.ctx.profile?.challengeState?.(a.unlock) : null;
      return `<button class="art${active.has(a.id) ? ' is-on' : ''}${locked ? ' is-locked' : ''}"
                data-nav data-artifact="${escapeHtml(a.id)}"
                style="--accent:${escapeHtml(a.color || '#ffd44f')}">
          <div class="art-mark">${markImg(a.mark, a.color || '#ffd44f')}</div>
          <div class="art-name">${escapeHtml(a.name || a.id)}</div>
          <div class="art-desc">${escapeHtml(locked
            ? (hint ? `Locked — ${hint.name}: ${hint.description}` : 'Locked')
            : (a.description || ''))}</div>
        </button>`;
    }).join('');
  }

  // -------------------------------------------------------------- equipment

  pickEquipment(id) {
    this.equipmentId = id || null;
    this.renderEquipment();
    this.syncChips();
  }

  renderEquipment() {
    const grid = this.root.querySelector('[data-equip-grid]');
    if (!grid) return;
    const src = this.root.querySelector('[data-equip-src]');
    if (src) src.textContent = this.equipmentName();
    const sel = this.equipmentId;
    // `description` is authored as a zero-arg function on every equipment card;
    // the guard keeps a future data-shape change from taking the screen down.
    const desc = (d) => {
      try { return typeof d.description === 'function' ? String(d.description()) : String(d.description || ''); }
      catch { return ''; }
    };
    const accent = tierMeta('equipment').color;
    const card = (id, mark, name, text) =>
      `<button class="art${(sel ?? '') === (id ?? '') ? ' is-on' : ''}" data-nav data-equip-id="${escapeHtml(id ?? '')}"
          style="--accent:${escapeHtml(accent)}">
        <div class="art-mark">${mark}</div>
        <div class="art-name">${escapeHtml(name)}</div>
        <div class="art-desc">${escapeHtml(text)}</div>
      </button>`;
    grid.innerHTML = [
      card(null, `<img class="equip-icon" src="${unknownIcon('equipment')}" alt="" draggable="false" />`, 'Random', 'Whatever the drop rolls. The old behaviour.'),
      ...EQUIPMENT.map((e) => card(
        e.id,
        `<img class="equip-icon" src="${equipmentArt(e.id)}" alt="" draggable="false" />`,
        e.name,
        `${desc(e)} Cooldown ${e.cooldown}s.`,
      )),
    ].join('');
  }

  // ------------------------------------------------------------------- pause

  /**
   * The run so far: effective stats out of the Items pipeline (so items, buffs
   * and artifacts are all included) and the haul, each tile carrying the same
   * hover card the HUD strip uses. Rebuilt when the screen opens, never
   * per-frame.
   */
  renderPause() {
    const skip = this.root.querySelector('[data-tut-skip]');
    if (skip) {
      const on = !!this.ctx.tutorial?.active;
      skip.hidden = !on;
      skip.disabled = !on;
    }
    const host = this.root.querySelector('[data-pause-stats]');
    const inv = this.root.querySelector('[data-pause-inv]');
    if (!host || !inv) return;
    const p = this.ctx.player;
    const s = p?.stats;
    if (!s) {
      host.innerHTML = '';
      inv.innerHTML = '<div class="ditem-empty">None</div>';
      return;
    }
    const rows = [
      ['Health', `${Math.ceil(Math.max(0, p.health))} / ${Math.round(s.maxHealth)}`],
      ['Regen', `${round1(s.healthRegen)}/s`],
      ['Damage', String(round1(s.damage))],
      ['Attack speed', `${s.attackSpeed.toFixed(2)}x`],
      ['Crit', `${Math.round(s.critChance * 100)}% · ${round1(s.critMult)}x`],
      ['Armor', String(Math.round(s.armor))],
      ['Speed', `${round1(s.moveSpeed)} m/s`],
      ['Cooldowns', `${s.cooldownMult.toFixed(2)}x`],
    ];
    host.innerHTML = rows
      .map(([k, v]) => `<div class="stat bez"><div class="stat-k">${k}</div><div class="stat-v">${v}</div></div>`)
      .join('');

    const tile = (id, tier, count) =>
      `<div class="ditem t-${escapeHtml(tier)}" data-tip-id="${escapeHtml(id)}" data-tip-tier="${escapeHtml(tier)}" data-tip-count="${count}">
        <img src="${itemArt(id, tier)}" alt="" draggable="false" />${count > 1 ? `<b>x${count}</b>` : ''}
      </div>`;
    const eq = this.ctx.items?.equipment ?? null;
    const held = this.ctx.items?.inventory?.() ?? [];
    const tiles = (eq ? tile(eq.id, 'equipment', 1) : '')
      + held.map((it) => tile(it.id, it.def.tier, it.count)).join('');
    inv.innerHTML = tiles || '<div class="ditem-empty">None yet</div>';
  }

  // ------------------------------------------------------------------- edict

  /** Is Command running? The Edict has no meaning without it. */
  commandActive() { return !!this.ctx.artifacts?.has?.('command'); }

  /** Tiers Command can actually resolve a drop into, in ladder order. */
  edictTiers() { return TIER_ORDER.filter((t) => ITEMS_BY_TIER[t]?.length); }

  /**
   * File or revoke one order.
   *
   * Clicking the item already ordered revokes it, so the same tile is both the
   * on and the off switch — there is no separate clear-this-tier control to
   * find, and the toggle matches how `.art` cards already behave one screen
   * over.
   */
  fileEdict(id) {
    const art = this.ctx.artifacts;
    if (!art?.setEdict) return;
    const tier = this.edictTier;
    art.setEdict(tier, art.edictFor(tier) === id ? null : id);
    this.renderEdict();
  }

  renderEdict() {
    const art = this.ctx.artifacts;
    const grid = this.root.querySelector('[data-edict-grid]');
    if (!grid) return;
    const rail = this.root.querySelector('[data-edict-rail]');
    const tiers = this.edictTiers();
    if (!tiers.includes(this.edictTier)) this.edictTier = tiers[0];
    const orders = art?.edictAll?.() ?? {};
    const filed = tiers.filter((t) => orders[t]).length;

    this.root.querySelector('[data-edict-tag]').textContent =
      `${filed} of ${tiers.length} tiers ordered`;

    // Three things can make this screen a lie, and each gets said in words
    // rather than left for the player to infer from drops that ignore them.
    const note = this.root.querySelector('[data-edict-note]');
    const isClient = this.ctx.netRole === 'client';
    note.textContent = !this.commandActive()
      ? 'The Edict is inert — Artifact of the Edict is not active for this run. Orders filed here keep, and take effect the next time you run it.'
      : isClient
        ? 'You are a guest. The host\'s edict decides what the whole party finds; yours is kept but not consulted this session.'
        : '';
    note.classList.toggle('is-on', !!note.textContent);

    rail.innerHTML = tiers.map((t) => {
      const meta = tierMeta(t);
      const id = orders[t];
      return `<button class="etab${t === this.edictTier ? ' is-on' : ''}" data-nav data-edict-tier="${escapeHtml(t)}"
                style="--accent:${escapeHtml(meta.color)}">
          <i class="etab-rule"></i>
          <span class="etab-name">${escapeHtml(meta.label)}</span>
          <em class="etab-sub">${ITEMS_BY_TIER[t].length} items</em>
          ${id ? `<img class="etab-seal" src="${itemArt(id, t)}" alt="" />` : '<b class="etab-open">—</b>'}
        </button>`;
    }).join('');

    const tier = this.edictTier;
    const meta = tierMeta(tier);
    const orderedId = orders[tier] || null;
    const orderedDef = orderedId ? ITEMS_BY_TIER[tier].find((i) => i.id === orderedId) : null;
    // The standing line is the screen's one piece of large type. It answers the
    // only question the player brought here — "what do I get out of a <tier>
    // drop right now" — and it answers it for the un-ordered case too, naming
    // the fallback policy instead of leaving a blank.
    this.root.querySelector('[data-edict-standing]').innerHTML = `
      <div class="estand bez" style="--accent:${escapeHtml(meta.color)}">
        <div class="estand-k">Every ${escapeHtml(meta.label.toLowerCase())} drop resolves to</div>
        <div class="estand-v">${orderedDef
          ? escapeHtml(orderedDef.name)
          : '<em>whatever you hold most of</em>'}</div>
      </div>`;

    grid.innerHTML = ITEMS_BY_TIER[tier].map((def) => {
      const held = this.ctx.items?.count?.(def.id) ?? 0;
      return `<button class="eitem bez${def.id === orderedId ? ' is-on' : ''}" data-nav
                data-edict-item="${escapeHtml(def.id)}" style="--accent:${escapeHtml(meta.color)}">
          <img class="eitem-icon" src="${itemArt(def.id, tier)}" alt="" draggable="false" />
          <span class="eitem-name">${escapeHtml(def.name)}</span>
          <em class="eitem-desc">${escapeHtml(describeItem(def, held))}</em>
          ${held ? `<b class="eitem-held">x${held}</b>` : ''}
        </button>`;
    }).join('');
  }

  /**
   * Open every menu route into the Edict.
   *
   * These used to be hidden and disabled unless Command was active, which was
   * half of why the entry appeared to be dead: `.mbtn`'s `display: flex` beat
   * the UA's `[hidden] { display: none }`, so the button drew anyway while
   * still carrying `disabled` — and a disabled button never receives a click.
   * The CSS half is fixed in `hud.css`; this is the other half.
   *
   * Gating it at all was the wrong call regardless. `renderEdict` already
   * writes a note for exactly this case — orders filed while Command is inert
   * are kept and applied the next run that carries the artifact — so the screen
   * is built to be useful before Command is running, and pre-filing from the
   * artifacts screen is the natural way to set a run up.
   *
   * The `C` hotkey stays gated: that one binds a key in the world, and keeping
   * it free in runs that cannot use it is deliberate.
   */
  syncEdictEntries() {
    for (const el of this.root.querySelectorAll('[data-edict-entry]')) {
      el.hidden = false;
      el.disabled = false;
    }
  }

  // ------------------------------------------------------------------ apply

  /** Push settings into the live systems. Every read is guarded — the other
   *  systems may not have initialised yet. */
  apply() {
    const { ctx, settings } = this;
    this.syncSettings();

    // The single hook the rest of the engine reads: RenderPipeline scales its
    // own shake off `ctx.settings.shake`. If it does not, shake is simply
    // unscaled — nothing here reaches into another system's source.
    ctx.settings = settings;

    if (ctx.camera && ctx.camera.fov !== settings.fov) {
      ctx.camera.fov = settings.fov;
      ctx.camera.updateProjectionMatrix();
    }

    // One call, not a scattering of pokes. This used to set the pixel ratio and
    // two pass flags by hand, which left the two most expensive things in the
    // frame — the shadow map and the soft-particle depth prepass — completely
    // unresponsive to the quality setting, and bypassed the pipeline's own
    // pixel budget on top.
    ctx.pipeline?.setQuality?.(settings.quality);

    // Same single-hook rule as quality: one guarded call, the pipeline owns
    // the clamp order and the capture pin. `dynamicRes` is numeric on disk.
    ctx.pipeline?.setRenderScale?.(settings.renderScale, settings.dynamicRes !== 0);

    const a = ctx.audio;
    if (a) {
      setAudio(a, ['setMasterVolume', 'setMaster', 'setVolume'], 'masterVolume', settings.master);
      setAudio(a, ['setSfxVolume', 'setSfx'], 'sfxVolume', settings.sfx);
      setAudio(a, ['setMusicVolume', 'setMusic'], 'musicVolume', settings.music);
    }
  }

  /** Challenges completed during the run in flight, for the summary screen. */
  bindProgress(ctx) {
    ctx.events?.on?.('challengeComplete', (e) => {
      if (e?.name) this.newChallenges.push({ kind: 'challenge', name: e.name });
    });
    ctx.events?.on?.('stageStart', ({ index }) => {
      if ((index ?? 0) === 0) this.newChallenges.length = 0;
    });
  }

  // ----------------------------------------------------------------- screens

  open(name) {
    const prev = this.screen;
    this.screen = name;
    // Root screens are where a journey starts, so they end the one before it.
    if (!name || name === 'title' || name === 'death' || name === 'pause') this.stack.length = 0;
    for (const [key, el] of Object.entries(this.screens)) {
      el.classList.toggle('is-open', key === name);
    }
    this.root.classList.toggle('is-open', !!name);
    // Lets the scrim lighten for the title, where the stage behind it is the
    // point, without weakening it under the pause/settings/death panels.
    this.root.dataset.screen = name || '';
    document.body.classList.toggle('menu-open', !!name);
    this.ctx.paused = !!name;
    if (name && document.pointerLockElement) document.exitPointerLock();

    // Every screen that owns a GL context releases it on the way out. This is
    // the single place that happens, so no exit path can miss it.
    if (prev === 'select' && name !== 'select') this.unmountPreview();
    if (prev === 'logbook' && name !== 'logbook') this.logbook.onClose();

    this.tooltip?.hide();
    this.syncEdictEntries();
    if (name === 'select') { this.renderSelect(); this.mountPreview(); }
    if (name === 'difficulty') this.renderDifficulty();
    if (name === 'artifacts') this.renderArtifacts();
    if (name === 'equipment') this.renderEquipment();
    if (name === 'edict') this.renderEdict();
    if (name === 'pause') this.renderPause();
    if (name === 'logbook') this.logbook.onOpen();

    this.navIndex = 0;
    this.paintFocus();
    this.moveFocus(prev, name);
  }

  /**
   * Real DOM focus follows the open panel (#45).
   *
   * The painted ring `paintFocus` draws is a class, invisible to assistive
   * technology and unrelated to `document.activeElement` — so opening the pause
   * menu left the browser's focus wherever it was, usually the canvas, and a
   * screen-reader user was told nothing had happened. The element focused on
   * the way in is the panel's first control; the element restored on the way
   * out is whatever held focus when the first panel of the journey opened,
   * which for a run in flight is the canvas.
   */
  moveFocus(prev, name) {
    const doc = globalThis.document;
    if (!doc) return;
    if (name) {
      if (!prev) this._focusReturn = doc.activeElement || null;
      focusablesIn(this.screens[name])[0]?.focus?.();
      return;
    }
    const back = this._focusReturn;
    this._focusReturn = null;
    (back || doc.getElementById?.('viewport'))?.focus?.();
  }

  close() {
    this.open(null);
  }

  /** Open `name` as a sub-screen of the current one, so Back returns here. */
  push(name) {
    if (this.screen === name) return;
    if (this.screen) this.stack.push(this.screen);
    this.open(name);
  }

  back() {
    this.open(this.stack.pop() || 'title');
  }

  act(action) {
    switch (action) {
      case 'play':
        // Clears an arming left behind by a How to play the player backed out
        // of: `tutorialNext` is otherwise only cleared in `launch`, so that
        // journey would put a coach on a run nobody asked to be coached on.
        this.tutorialNext = false;
        this.push('select');
        break;
      // Same road as Play -- survivor select, then a normal run. The scenario
      // is not a mode; it is a coach riding along with an ordinary stage 0.
      case 'tutorial':
        this.tutorialNext = true;
        this.push('select');
        break;
      case 'tutorial-skip':
        this.ctx.tutorial?.skip();
        this.renderPause();
        this.act('resume');
        break;
      case 'launch':
        this.launch();
        break;
      case 'resume':
        this.close();
        if (!this.ctx.input?.padActive) {
          try { this.ctx.input?.canvas?.requestPointerLock?.()?.catch?.(() => {}); } catch { /* no lock, no problem */ }
        }
        break;
      case 'settings':
      case 'logbook':
      case 'difficulty':
      case 'artifacts':
      case 'equipment':
        this.push(action);
        break;
      case 'edict':
        this.push('edict');
        break;
      case 'edict-back':
        // Reached either from the pause/artifacts stack or straight off a
        // keypress in the world. Only the first has somewhere to go back to;
        // the second has to hand the player back to the run.
        if (this.stack.length) this.back();
        else this.act('resume');
        break;
      case 'edict-clear':
        this.ctx.artifacts?.clearEdict?.();
        this.renderEdict();
        break;
      case 'art-clear':
        this.artifactIds = new Set();
        this.ctx.artifacts?.setActive?.([]);
        this.ctx.artifactIds = [];
        this.renderArtifacts();
        this.syncChips();
        break;
      case 'back':
        this.back();
        break;
      case 'reset':
        // `firstRunSeen` survives Defaults deliberately: it is a record of
        // something that happened, not a knob. Restoring the video and audio
        // sliders must not re-arm a tutorial at a player who has already
        // played, the same reason telemetry consent sits outside this case.
        Object.assign(this.settings, DEFAULTS, { firstRunSeen: this.settings.firstRunSeen });
        save(this.settings);
        this.apply();
        break;
      // Controls have their own Defaults, next to the list they restore: a
      // player fixing one bad binding should not have to lose their volumes.
      case 'binds-reset':
        bindings.reset();
        save(this.settings);
        this.syncBindings();
        this.bindNote('Controls restored to defaults.');
        break;
      // Deliberately outside `reset`: Defaults restores the video and audio
      // knobs, and silently revoking a consent the player gave — or worse,
      // silently granting one — is not a default anybody asked for.
      case 'telemetry-on':
      case 'telemetry-off':
        setTelemetryEnabled(action === 'telemetry-on');
        this.syncTelemetry();
        break;
      case 'telemetry-export':
        downloadRuns();
        break;
      case 'telemetry-clear':
        clearRuns();
        this.syncTelemetry();
        break;
      case 'quit':
        if (this.screen === 'pause') { location.reload(); }
        else { this.open('title'); }
        break;
      case 'restart':
        location.reload();
        break;
      case 'coop':
        this.openCoop();
        break;
      case 'coop-invite':
      case 'coop-accept':
      case 'coop-join':
      case 'coop-copy':
      case 'coop-copy-reply':
      case 'coop-leave':
      case 'coop-room-host':
      case 'coop-room-join':
      case 'coop-steam-host':
      case 'coop-steam-invite':
        this.coopAction(action);
        break;
    }
  }

  /**
   * Commit the pre-run selections and drop.
   *
   * `ctx.setSurvivor` is Player's live-swap and only exists once Player has
   * published itself; `ctx.survivorId` is what a not-yet-booted Player reads at
   * init. Writing both means the selection holds whichever side of boot the
   * player is on.
   */
  launch() {
    const card = getSurvivor(this.survivorId);
    this.ctx.survivorId = card.id;
    this.ctx.setSurvivor?.(card.id);
    // Items' stage-start seeding reads this; null keeps the random roll.
    this.ctx.startEquipmentId = this.equipmentId;
    if (!this.ctx.difficultyId) this.setDifficulty(this.currentDifficulty()?.id);
    this.newChallenges.length = 0;
    // Armed either because they asked from the title or because this install
    // has never launched a run at all. Read by `systems/Tutorial.js` on the
    // stage-0 `stageStart` and cleared by it when the scenario ends.
    this.ctx.tutorialArmed = shouldArmTutorial(this.settings, this.tutorialNext);
    this.tutorialNext = false;
    if (this.settings.firstRunSeen !== 1) { this.settings.firstRunSeen = 1; save(this.settings); }
    this.close();
    this.ctx.input?.canvas?.requestPointerLock?.();
  }

  // -------------------------------------------------------------------- co-op

  openCoop() {
    const lobby = this.ctx.lobby;
    // One subscription for the life of the lobby — `onStatus` is a single slot,
    // so re-registering on every open would be harmless but pointless.
    if (lobby && !this._coopBound) {
      this._coopBound = true;
      lobby.onStatus = (status, detail) => this.coopStatus(status, detail);
    }
    this.push('coop');
    // `statusDetail` and not just `status`: a refusal says nothing useful
    // without its reason, and the player who was turned away is exactly the one
    // most likely to open this screen *after* it happened rather than during.
    this.coopStatus(lobby?.status || 'idle', lobby?.statusDetail);
    this.coopWiring();
  }

  /**
   * Say out loud what this build is actually wired to.
   *
   * Both ways a distributed game fails are invisible from the co-op screen
   * otherwise: a build still pointed at a localhost relay (room codes cannot
   * work for anyone but you) and a build with no TURN (direct connections work
   * on friendly networks and silently never form on strict ones). Naming them
   * here turns "it just doesn't connect" into something a tester can report.
   */
  coopWiring() {
    const el = this.root.querySelector('[data-coop-wiring]');
    if (!el) return;
    const net = describeNet();
    const bits = [];
    bits.push(net.signalIsLocal
      ? `Signalling: ${net.signal} — local only, room codes will not work for remote players.`
      : `Signalling: ${net.signal}`);
    bits.push(net.hasTurn
      ? 'TURN relay: configured.'
      : 'TURN relay: none — players behind strict NAT may fail to connect.');
    if (net.relayOnly) bits.push('Forcing relay-only (TURN test mode).');
    // HTML collapses runs of whitespace, so the separator has to be a glyph.
    el.textContent = bits.join(' · ');
    el.classList.toggle('is-warn', net.signalIsLocal || !net.hasTurn);
  }

  /**
   * Reveal the Steam path, but only where there is one.
   *
   * `src/net/SteamLobby.js` reaches for `window.__STEAM__` and finds nothing in
   * a browser, and `available: false` in a desktop shell whose Steam never
   * answered — so both of those leave the block hidden and every other co-op
   * path exactly as it was. Nothing here throws in either case, which is why it
   * is safe to fire off the constructor unawaited.
   */
  async bindSteam() {
    try {
      if (!(await steamAvailable())) return;
      const block = this.root.querySelector('[data-coop-steam]');
      if (block) block.hidden = false;
      // The join side needs no buttons at all: accepting an invite in the Steam
      // friends list is the whole gesture — PROVIDED nothing is already in
      // flight (Important 4). Idle at a menu, that gesture is trusted outright,
      // same as before. Mid-run, it must not tear the run down without the
      // player saying so. Already networked, joining could never succeed
      // (fix round 2 — `joinViaSteam` itself refuses that case now), so the
      // blocked check runs FIRST and never offers an Accept that cannot work.
      onSteamInvite((lobbyId) => {
        const lobby = this.ctx.lobby;
        if (!lobby) return;
        const join = async () => {
          this.openCoop();
          this.coopSay('Joining your friend through Steam…');
          try { await joinViaSteam(lobby, lobbyId); }
          catch (err) { this.coopSay(err?.message || 'That Steam invite did not work.'); }
        };
        if (steamInviteBlocked({ lobbyMode: lobby.mode })) {
          showSteamInviteNotice({
            body: lobby.mode === 'host'
              ? "A friend's Steam invite arrived, but you're already hosting a game. Leave it first, then accept an invite."
              : "A friend's Steam invite arrived, but you're already in a game. Leave it first, then accept another invite.",
            actionable: false,
          });
          return;
        }
        if (!steamInviteNeedsConfirm({ hasActiveRun: !!this.ctx.player, lobbyMode: lobby.mode })) { join(); return; }
        showSteamInviteNotice({ onAccept: join });
      });
    } catch { /* the whole point of this path is that its absence is silent */ }
  }

  /** All the co-op buttons. Every path here can fail, and every failure is
   *  something the player has to be told about in words. */
  async coopAction(action) {
    const lobby = this.ctx.lobby;
    if (!lobby) return this.coopSay('Networking is unavailable in this build.');
    const field = (name) => this.root.querySelector(`[data-coop-${name}]`);

    // Hosting through Steam opens the Steam lobby first and only then waits out
    // ICE gathering (up to 4 s), so for that whole window the button was live and
    // the only feedback was "Opening a Steam lobby...". A second press there is an
    // ordinary impatient gesture, and it used to open a second Steam lobby the
    // player could never leave. The button goes dark for the duration, and the
    // flag catches the routes that reach here without going through the button.
    this._coopBusy ??= new Set();
    if (this._coopBusy.has(action)) return;
    this._coopBusy.add(action);
    const button = this.root.querySelector(`[data-act="${action}"]`);
    if (button) button.disabled = true;

    try {
      switch (action) {
        case 'coop-invite': {
          this.coopSay('Gathering connection candidates…');
          const invite = await lobby.createInvite();
          field('invite').value = invite.blob;
          field('invite').select?.();
          this.coopSay('Invite ready. Send that code to your friend, then paste their reply below.');
          break;
        }
        case 'coop-accept': {
          const blob = field('answer').value.trim();
          if (!blob) return this.coopSay('Paste the reply code your friend sent you first.');
          await lobby.acceptAnswer(blob);
          field('answer').value = '';
          this.coopSay('Connecting them…');
          break;
        }
        case 'coop-join': {
          const blob = field('offer').value.trim();
          if (!blob) return this.coopSay('Paste the invite code your friend sent you first.');
          this.coopSay('Answering the invite…');
          const reply = await lobby.joinManual(blob);
          field('reply').value = reply;
          field('reply').select?.();
          this.coopSay('Send that reply code back to the host. The game starts when they accept it.');
          break;
        }
        case 'coop-steam-host': {
          this.coopSay('Opening a Steam lobby…');
          const { lobbyId } = await hostViaSteam(lobby);
          this.steamLobbyId = lobbyId;
          this.coopSay('Steam lobby open. Press “Invite friend” and pick who joins you.');
          break;
        }
        case 'coop-steam-invite': {
          if (!this.steamLobbyId) return this.coopSay('Press “Host via Steam” first — the invite needs a lobby to point at.');
          await openSteamInvite(this.steamLobbyId);
          this.coopSay('Pick your friend in the Steam overlay. They join as soon as they accept.');
          break;
        }
        case 'coop-room-host': {
          this.coopSay('Opening a room…');
          const code = await lobby.hostViaRelay();
          // One grouping, shown and said. Grouped at all for the half of this
          // feature that happens out loud — the input strips the separator again
          // and the relay never sees it either way — and grouped ONCE because a
          // box reading XXXX-XXXX beside a sentence reading XXXXXXXX is two
          // hosts telling one friend two different things.
          const shown = formatRoomCode(code);
          this.root.querySelector('[data-coop-code]').textContent = shown;
          this.coopSay(`Room ${shown} is open. Give that code to your friends — they join with it.`);
          break;
        }
        case 'coop-room-join': {
          // Trimmed before the emptiness check, so a field holding nothing but
          // spaces gets the answer that helps ("type the code") rather than the
          // one that is technically true ("that is not a room code"). What a code
          // *is* stays `Lobby.normalizeRoomCode`'s decision alone — this only
          // asks whether the player has typed anything at all.
          const code = field('roomcode').value.trim();
          if (!code) return this.coopSay('Type the room code the host gave you first.');
          // Said in the one spelling every other surface uses — the box, the
          // host's own sentence — rather than in whatever the player typed, so
          // `abcd 2345` is not read back at them as a third version of a code
          // there is only one of. A code too broken to group is said verbatim,
          // because a player comparing it to the paper needs to see what they
          // actually typed.
          this.coopSay(`Joining room ${formatRoomCode(normalizeRoomCode(code)) || code}…`);
          await lobby.joinViaRelay(code);
          this.coopSay('Connecting to the host…');
          break;
        }
        case 'coop-copy':
          this.coopCopy(field('invite'));
          break;
        case 'coop-copy-reply':
          this.coopCopy(field('reply'));
          break;
        case 'coop-leave':
          // `leave()` runs the Steam teardown that `hostViaSteam`/`joinViaSteam`
          // parked on the lobby, so the id here is stale the moment it returns.
          lobby.leave();
          this.steamLobbyId = null;
          for (const n of ['invite', 'answer', 'offer', 'reply', 'roomcode']) field(n).value = '';
          this.root.querySelector('[data-coop-code]').textContent = CODE_PLACEHOLDER;
          break;
      }
    } catch (err) {
      this.coopSay(err?.message || 'That did not work.');
    } finally {
      // `finally`, not the end of `try`: every early `return this.coopSay(...)`
      // above leaves through here too, and a button left dark by a validation
      // message the player has already fixed is a dead co-op screen.
      this._coopBusy.delete(action);
      if (button) button.disabled = false;
    }
  }

  coopCopy(el) {
    if (!el?.value) return this.coopSay('Nothing to copy yet.');
    el.select();
    navigator.clipboard?.writeText(el.value)
      .then(() => this.coopSay('Copied to the clipboard.'))
      // Clipboard access is refused outside a secure context, which a LAN test
      // over plain http is. The text is selected either way, so say so.
      .catch(() => this.coopSay('Could not reach the clipboard — the code is selected, copy it with Ctrl+C.'));
  }

  /** Lobby status callback: one line of plain language per state. */
  coopStatus(status, detail) {
    const lobby = this.ctx.lobby;
    const role = this.root.querySelector('[data-coop-role]');
    if (role) {
      role.textContent = lobby?.mode === 'host' ? 'Hosting'
        : lobby?.mode === 'client' ? 'Joined a game'
        : 'Single player';
    }

    const said = {
      hosting: 'Hosting. Create an invite for each friend you want to bring in.',
      inviteReady: 'Invite ready. Send that code to your friend.',
      peerConnecting: 'Reply accepted — connecting…',
      peerFailed: detail?.detail || 'That player never finished connecting.',
      peerJoined: `A player joined. ${detail?.count ?? '?'} in the game.`,
      peerLeft: `A player left. ${detail?.count ?? '?'} in the game.`,
      joining: 'Answering the invite…',
      answerReady: 'Send your reply code back to the host.',
      connected: 'Connected. Rebuilding the host\'s world…',
      disconnected: 'Disconnected from the host.',
      // The relay speaking after the room opened, which in practice is
      // 'Room expired'. Players already in the game are unaffected — they are
      // connected peer-to-peer and the relay is irrelevant to them — so the loss
      // is precisely that the code no longer admits anybody, and that is what
      // this says rather than announcing a disconnection that has not happened.
      relayError: `${detail?.error ?? 'The relay dropped this room'} — that code no longer lets anyone in. `
        + 'Players already with you are unaffected; create a room again for a new code.',
      refused: refusalText(detail, false),
      peerRefused: refusalText(detail, true),
      idle: 'Up to 4 players. One player hosts and runs the game; everyone else joins them.',
    }[status];
    if (said) this.coopSay(said);

    const list = this.root.querySelector('[data-coop-players]');
    if (!list) return;
    const players = lobby?.players || [];
    list.innerHTML = lobby && lobby.mode !== 'single'
      ? players.map((p) => `<div class="coop-player${p.local ? ' is-you' : ''}">${p.name}</div>`).join('')
      : '';
  }

  coopSay(text) {
    const el = this.root.querySelector('[data-coop-status]');
    if (el) el.textContent = text;
  }

  /**
   * The run summary.
   *
   * `stats` is what HUD assembles from its own counters; the run's *identity*
   * (survivor, difficulty, artifacts) and anything newly earned come from the
   * profile, which `Progression` has already committed by the time `playerDead`
   * reaches us.
   */
  showDeath(stats) {
    // --- which of the three outcomes is this? -------------------------------
    //
    // `Progression.finishRun` sets `progression.ending` *before* it calls the
    // HUD, and leaves it null for an ordinary death, so the screen can read the
    // outcome rather than be told it afterwards by two text writes. Everything
    // below branches on `id` exactly once.
    const ending = this.ctx.progression?.ending ?? null;
    const id = ending?.id && ending.id !== 'death' ? ending.id : 'death';
    const won = id !== 'death';
    const screen = this.screens.death;
    if (screen) screen.dataset.ending = id;

    const word = this.root.querySelector('[data-death-word]');
    if (word) word.textContent = ending?.title ?? 'You Died';

    const seal = this.root.querySelector('[data-ending-seal]');
    const sealText = this.root.querySelector('[data-ending-seal-text]');
    if (sealText) {
      sealText.textContent = id === 'victory' ? 'The run is finished'
        : id === 'obliterated' ? 'Ended on your terms' : '';
    }
    if (seal) seal.hidden = !won;

    const restart = this.root.querySelector('[data-restart-label]');
    if (restart) restart.textContent = won ? 'New run' : 'Restart run';

    const sub = this.root.querySelector('[data-death-sub]');
    sub.textContent = ending?.line
      || (stats.stageName ? `Stage ${stats.stage} — ${stats.stageName}` : '');

    const card = getSurvivor(this.ctx.player?.survivorId ?? this.survivorId);
    const diff = this.currentDifficulty();
    // Ids are storage keys, not copy — name them.
    const byId = new Map(this.artifactList().map((a) => [a.id, a.name || a.id]));
    const arts = this.activeArtifacts().map((id) => byId.get(id) || id);
    this.root.querySelector('[data-run-id]').innerHTML = `
      <div class="run-id-cell bez" style="--accent:${hexOf(card.accentColor)}">
        <div class="run-id-k">Survivor</div><div class="run-id-v">${escapeHtml(card.name)}</div>
      </div>
      <div class="run-id-cell bez">
        <div class="run-id-k">Difficulty</div><div class="run-id-v">${escapeHtml(diff?.name || '—')}</div>
      </div>
      <div class="run-id-cell bez">
        <div class="run-id-k">Artifacts</div>
        <div class="run-id-v">${arts.length ? escapeHtml(arts.join(', ')) : 'None'}</div>
      </div>`;

    const host = this.root.querySelector('[data-stats]');
    // Six tiles, one number each, and every number appears exactly once on the
    // panel. The won branch used to read `['Time to the Fracture', stats.time]`,
    // which was `Time survived` printed a second time under a second name — and
    // under a name naming a place the *losing* screen's player never reached, on
    // the one screen where the two could be compared side by side. There is no
    // separate fracture clock to show, so the sixth tile is the item count on
    // both outcomes and the list below carries its plain heading again.
    const rows = [
      ['Time survived', stats.time],
      ['Stages cleared', stats.stage],
      ['Level reached', stats.level ?? 1],
      ['Enemies killed', stats.kills],
      ['Damage dealt', stats.damage],
      // Not "Items collected": that is the heading of the grid below, and the
      // two carry different numbers (1087 stacks against 83 distinct items).
      // One screen using one phrase for two figures is worse than either.
      ['Item pickups', stats.itemCount ?? 0],
    ];
    host.innerHTML = rows
      .map(([k, v]) => `<div class="stat bez"><div class="stat-k">${k}</div><div class="stat-v">${v}</div></div>`)
      .join('');

    const itemsLabel = this.root.querySelector('[data-items-label]');
    if (itemsLabel) itemsLabel.textContent = 'Items Collected';

    // One shrink-wrapped block per tier, in `TIER_ORDER`.
    //
    // The grid used to be a single wrapping row of `stats.items` in pickup
    // order, so tier boundaries fell wherever the wrap happened to put them:
    // the round-4 critique read the shipped card's tier map at 16 columns and
    // found **five** of six boundaries mid-row, against round 2/3's four. It
    // also ordered the haul magenta-first here while `10-inventory`'s HUD strip
    // ordered the identical 83-item haul magenta-last — two screens, one haul,
    // opposite tier order. Grouping here off the same `TIER_ORDER` the strip
    // uses fixes both at once.
    //
    // Rows inside a block are explicit rather than `flex-wrap`, for the reason
    // `HUD.onItemPickup` documents: `width: max-content` on a wrapping flex
    // container resolves to the *unwrapped* width of all its children, so a
    // wrapped tier drew its rule across the whole container and overhung its
    // last tile.
    const grid = this.root.querySelector('[data-death-items]');
    const byTier = new Map();
    for (const it of stats.items ?? []) {
      if (!byTier.has(it.tier)) byTier.set(it.tier, []);
      byTier.get(it.tier).push(it);
    }
    const tile = (it) => `<div class="ditem t-${it.tier}"><img src="${itemArt(it.id, it.tier)}" alt="" />
             ${it.count > 1 ? `<b>x${it.count}</b>` : ''}</div>`;
    const tiers = TIER_ORDER.filter((t) => byTier.get(t)?.length);
    grid.innerHTML = tiers.length
      ? tiers.map((t) => {
        const list = byTier.get(t);
        let rows = '';
        for (let i = 0; i < list.length; i += DEATH_ROW) {
          rows += `<div class="dtier-row">${list.slice(i, i + DEATH_ROW).map(tile).join('')}</div>`;
        }
        return `<div class="dtier t-${t}">${rows}</div>`;
      }).join('')
      : '<div class="ditem-empty">None</div>';

    // The progression readout. `Progression._endRun` commits the run to the
    // profile *before* it emits `runEnd`, so the report is already built by the
    // time this screen is raised — see `Profile._buildReport`.
    //
    // The report supersedes the old two-source chip row (this screen's own
    // `newChallenges` plus `drainPendingUnlocks`), which could only ever say
    // "earned": it had no before-state to diff against and so could not report a
    // beaten record or a challenge that merely got closer. Both old sources are
    // still drained here so nothing accumulates across runs, and the chip row is
    // rebuilt from the report's own `completed`/`unlocks` arrays, which are
    // run-scoped by construction.
    const report = this.ctx.profile?.report?.() ?? null;
    this.ctx.profile?.drainPendingUnlocks?.();
    this.newChallenges.length = 0;
    const un = this.root.querySelector('[data-run-unlocks]');
    un.innerHTML = renderRunReport(report);

    this.open('death');
  }

  /** Big centre-screen pickup card. */
  showPickup({ id, tier, name, description }) {
    const meta = tierMeta(tier);
    this.bannerRefs.img.src = itemArt(id, tier);
    this.bannerRefs.tier.textContent = meta.label;
    this.bannerRefs.name.textContent = name;
    this.bannerRefs.desc.textContent = description || '';
    this.banner.style.setProperty('--tier', meta.color);
    this.banner.classList.remove('is-on');
    // Force a reflow so the entry animation replays on a rapid second pickup.
    void this.banner.offsetWidth;
    this.banner.classList.add('is-on');
    this.bannerTimer = 4.2;
  }

  /**
   * The blight toll's choice window (issue #33). Non-blocking by construction:
   * nothing here pauses, nothing here grabs focus, and the run continues
   * behind it — the panel simply offers the stacks and counts down.
   *
   * Each card leads with what the stack *becomes*, not with what is lost: the
   * blight counterpart's own catalogue description rides in the payload, so
   * the player is choosing between two transformations rather than picking a
   * casualty.
   */
  showMutationChoice({ offers, seconds, onPick, onRefuse }) {
    if (!offers?.length) return;
    this.mutate = { onPick, onRefuse, remaining: seconds };
    this.mutateRefs.offers.innerHTML = offers.map((o, i) => `
      <button class="mutate-card" data-mutate-pick="${escapeHtml(o.baseId)}">
        <i class="mutate-art"><img alt="" src="${escapeHtml(itemArt(o.blightId, 'blight'))}"></i>
        <span class="mutate-key" data-mutate-key="${i}">${escapeHtml(this.mutateKeyLabel(i, false))}</span>
        <span class="mutate-body">
          <span class="mutate-name">${escapeHtml(o.blightName)}</span>
          <em class="mutate-desc">${escapeHtml(o.blightDescription || '')}</em>
          <span class="mutate-from">from ${escapeHtml(o.count > 1 ? `${o.count}x ` : '')}${escapeHtml(o.baseName)}</span>
        </span>
      </button>`).join('');
    this.mutateRefs.clock.textContent = `${Math.ceil(seconds)}s`;
    this.mutateEl.classList.add('is-on');
  }

  /**
   * The label the nth offer's card prints: the keyboard digit, or the pad
   * glyph for the D-pad direction that answers it, through `glyphLabel` -- the
   * same #42 path the bindings screen prints, so a PlayStation player reads
   * "Left" and an Xbox player "D-Pad Left" without a second table existing.
   */
  mutateKeyLabel(i, padActive) {
    if (!padActive) return String(i + 1);
    return glyphLabel(MUTATE_PAD[i], this.settings.controllerGlyphs);
  }

  /** Repaint the cards' prompts for whichever device the player is holding. */
  syncMutateKeys(padActive) {
    if (!this.mutate) return;
    const keys = this.mutateRefs.offers.querySelectorAll('[data-mutate-key]');
    for (const el of keys) el.textContent = this.mutateKeyLabel(Number(el.dataset.mutateKey), !!padActive);
  }

  /** Closed by the system that owns the decision, never by this panel. */
  hideMutationChoice() {
    this.mutate = null;
    this.mutateEl.classList.remove('is-on');
  }

  // ------------------------------------------------------- keyboard / gamepad

  /** Every focusable control on the open screen, in DOM order. */
  navTargets() {
    if (this.screen === 'logbook') return this.logbook.navTargets();
    const el = this.screens[this.screen];
    if (!el) return [];
    return [...el.querySelectorAll('[data-nav]')].filter((n) => !n.disabled);
  }

  paintFocus(list = this.navTargets()) {
    for (let i = 0; i < list.length; i++) list[i].classList.toggle('is-focus', i === this.navIndex);
    list[this.navIndex]?.scrollIntoView?.({ block: 'nearest' });
  }

  navMove(delta) {
    const list = this.navTargets();
    if (!list.length) return;
    this.navIndex = (this.navIndex + delta + list.length) % list.length;
    this.paintFocus(list);
  }

  /**
   * The open screen's scrollable region, when the navigator cannot reach into
   * it, and only while it actually overflows.
   *
   * The run summary is the one screen whose content is authored by the *run*:
   * a long run fills the report with chips, bars, records and an item grid,
   * none of which is focusable, and the two `[data-nav]` buttons sit outside
   * the scroller by design so they can never be pushed off frame. That design
   * is right for the buttons and left the content unreadable without a mouse —
   * `paintFocus`'s `scrollIntoView` is the only thing in this file that ever
   * scrolls anything, and it has nothing inside `.run-report` to land on.
   */
  scrollRegion() {
    if (this.screen !== 'death') return null;
    const el = this.screens.death?.querySelector('.run-report');
    if (!el || el.querySelector('[data-nav]')) return null;
    return el.scrollHeight - el.clientHeight > 1 ? el : null;
  }

  /**
   * Vertical input on a screen with an unreachable scroller: scroll it.
   *
   * Returns true when the press was spent here. At either end of the travel it
   * returns false and the press falls through to `navMove`, so the ring is
   * never trapped behind the scroller and a report with nothing to scroll
   * behaves exactly as it did before. Left/right always move the ring — the
   * summary's buttons are a row, so that costs nothing and gives a controller
   * a way past the report at any scroll position.
   *
   * A page at a time rather than a line: a stick repeats at 140 ms and the
   * keyboard does not repeat at all, so a line-sized step would make a long
   * report a chore rather than a read.
   */
  navScroll(dir) {
    const el = this.scrollRegion();
    if (!el) return false;
    const max = el.scrollHeight - el.clientHeight;
    const at = el.scrollTop;
    if (dir > 0 ? at >= max - 1 : at <= 1) return false;
    const step = Math.max(64, el.clientHeight * 0.6);
    el.scrollTop = Math.max(0, Math.min(max, at + dir * step));
    return true;
  }

  navConfirm() {
    const el = this.navTargets()[this.navIndex];
    if (!el) return;
    // A range input confirms nothing; left/right already adjust it.
    if (el.tagName === 'INPUT') return;
    el.click();
  }

  /**
   * Keyboard and gamepad for every screen.
   *
   * The menus were mouse-only. Arrows / WASD / D-pad move the ring, Enter,
   * Space and A confirm, Escape and B go back — and the ring is the same object
   * the mouse hovers, so the two input paths can never disagree about what is
   * selected. Typing into the co-op code fields is excluded, or a paste would
   * navigate away mid-word.
   */
  navigate(ctx) {
    if (!this.screen) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    const input = ctx.input;
    const hit = (c) => input?.hit?.(c);

    // COUPLING: the arrows, Enter, NumpadEnter, Backspace and Escape below are
    // read as RAW physical codes — they are not in the binding map — so
    // `Bindings.RESERVED_KEYS` refuses them at the capture dialog. The
    // `.mutate-choice` window below (Digit1-3) is the same party to this
    // invariant. WASD and Space are the opposite case: those are virtual codes
    // the map produces, so rebinding movement or jump moves the menu control
    // with it. Adding a raw code here means adding it to RESERVED_KEYS.
    let dy = 0, dx = 0, confirm = false, back = false;
    if (hit('ArrowDown') || hit('KeyS')) dy++;
    if (hit('ArrowUp') || hit('KeyW')) dy--;
    if (hit('ArrowRight') || hit('KeyD')) dx++;
    if (hit('ArrowLeft') || hit('KeyA')) dx--;
    if (hit('Enter') || hit('Space') || hit('NumpadEnter')) confirm = true;
    if (hit('Escape') || hit('Backspace')) back = true;

    const pad = this.readPad();
    dy += pad.dy; dx += pad.dx;
    confirm = confirm || pad.confirm;
    back = back || pad.back;

    // Horizontal is only distinct from vertical where a row of controls needs
    // it; everywhere else both walk the same list, which is what makes one
    // navigator work on a grid, a column and a tab rail alike.
    const step = dy || dx;
    // Vertical is offered to the screen's scroller first; `navScroll` hands it
    // straight back at either end of the travel, and always on a screen with
    // nothing to scroll.
    const el = this.navTargets()[this.navIndex];
    if (dx && el?.tagName === 'INPUT' && el.type === 'range') {
      // Left/right adjust the focused slider — this is what navConfirm's
      // "left/right already adjust it" comment always promised. stepUp/stepDown
      // honor the input's min/max/step; the synthetic 'input' event runs the
      // buildSettings listener, which applies and saves.
      if (dx > 0) el.stepUp(); else el.stepDown();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (step && !(dy && this.navScroll(dy > 0 ? 1 : -1))) {
      this.navMove(step > 0 ? 1 : -1);
    }
    if (confirm) this.navConfirm();
    if (back) this.escape();
  }

  /** Escape / B: one level out, never straight to the desktop. */
  escape() {
    switch (this.screen) {
      case null:
      case undefined:
        this.open('pause');
        break;
      case 'pause':
        this.act('resume');
        break;
      case 'title':
      case 'death':
        break;
      case 'edict':
        this.act('edict-back');
        break;
      default:
        this.back();
    }
  }

  /**
   * First connected pad, edge-triggered.
   *
   * Polled rather than event-driven because the Gamepad API has no press
   * events, and rate-limited by hand: a held stick at 60 Hz walks a nine-entry
   * menu eight times before a human notices it moved.
   */
  readPad() {
    const out = { dx: 0, dy: 0, confirm: false, back: false };
    const pads = navigator.getGamepads?.();
    if (!pads) return out;
    let gp = null;
    for (const p of pads) if (p?.connected) { gp = p; break; }
    if (!gp) return out;

    const ax = (gp.axes[0] || 0) + (gp.buttons[15]?.pressed ? 1 : 0) - (gp.buttons[14]?.pressed ? 1 : 0);
    const ay = (gp.axes[1] || 0) + (gp.buttons[13]?.pressed ? 1 : 0) - (gp.buttons[12]?.pressed ? 1 : 0);
    const now = performance.now();
    const live = Math.abs(ax) > 0.55 || Math.abs(ay) > 0.55;
    if (live && now >= (this._padNext ?? 0)) {
      // 380 ms to first repeat, 140 ms after — the same shape every console
      // menu uses, and the reason a stick is usable at all here.
      this._padNext = now + (this._padHeld ? 140 : 380);
      this._padHeld = true;
      if (Math.abs(ay) > Math.abs(ax)) out.dy = ay > 0 ? 1 : -1;
      else out.dx = ax > 0 ? 1 : -1;
    } else if (!live) {
      this._padHeld = false;
      this._padNext = 0;
    }

    const edge = (i) => {
      const down = !!gp.buttons[i]?.pressed;
      const was = this.pad.buttons.has(i);
      if (down) this.pad.buttons.add(i); else this.pad.buttons.delete(i);
      return down && !was;
    };
    out.confirm = edge(0);
    out.back = edge(1);
    return out;
  }

  update(ctx, dt) {
    // A capture dialog owns every input while it is up: navigate() must not
    // read the press being bound as a menu move.
    if (this.capture) { this.pollCapture(ctx); return; }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('is-on');
    }
    // The offer's clock is display only — `Items` owns the real one and will
    // close this panel through `hideMutationChoice` when it lapses, so the two
    // can never disagree about whether the window is still open. Read the
    // remaining seconds straight off `Items`' own state (`mutationChoice()`)
    // rather than ticking a second clock here: that state is written in
    // `fixedUpdate`, which does not run while `ctx.paused`, so a paused game
    // shows a frozen, truthful number instead of a display that keeps
    // counting down on its own. Keys 1-3 are read through `ctx.input` like the
    // Edict's C, so the choice is answerable without letting go of the world.
    if (this.mutate) {
      const remaining = ctx.items?.mutationChoice?.()?.remaining ?? this.mutate.remaining;
      this.mutateRefs.clock.textContent = `${Math.max(0, Math.ceil(remaining))}s`;
      this.syncMutateKeys(ctx.input?.padActive);
      // `!this.screen` is what keeps the D-pad from being an offer answer and
      // a menu cursor in the same frame, and it needs nothing added to it:
      // `navigate` returns before it reaches `readPad` unless a screen is
      // open, and this branch is off exactly when one is. The two handlers are
      // mutually exclusive by state, not by a suppression flag -- an earlier
      // draft added one inside `readPad` and it was unreachable.
      if (!this.screen) {
        for (let i = 0; i < 3; i++) {
          // D-pad left / up / right answer the three offers (#98). A pad
          // player had no lever at all before this: pointer lock swallows the
          // click and a pad has no Digit1. Read off `input.pad.edges` -- raw
          // button indices, the same surface the Start-opens-pause check
          // below uses -- because the D-pad binds no action and so produces
          // no virtual key code to `hit()`.
          const picked = ctx.input?.hit?.(`Digit${i + 1}`)
            || ctx.input?.pad?.edges?.has?.(MUTATE_PAD[i]);
          if (!picked) continue;
          const el = this.mutateRefs.offers.children[i];
          if (el) this.mutate.onPick?.(el.dataset.mutatePick);
          // The press is spent -- this one press, and nothing else. Without
          // it the same edge survives into the frame's remaining consumers
          // (Start's pad read, and a screen opened later this frame). The
          // blanket `clearPadEdges` would also do that, and would additionally
          // eat every other pad-bound action's edge for the frame, which is
          // not this window's to take.
          ctx.input?.consumePadEdge?.(MUTATE_PAD[i]);
          break;
        }
      }
    }
    // C opens the Edict straight from the world. Command's whole interface is
    // this screen, and three clicks through a pause menu to re-aim a drop you
    // are about to earn is the difference between an artifact that gets used
    // and one that gets set once and forgotten. Only bound while the artifact
    // is running, so the key is free in every other run.
    if (!this.screen && ctx.player?.alive !== false && this.commandActive()
        && ctx.input?.hit?.('KeyC')) {
      this.open('edict');
    }
    // Start on a pad is Escape: opens the pause screen from the world. With a
    // screen open, navigate()'s B-button back already covers it.
    if (!this.screen && ctx.player?.alive !== false
        && ctx.input?.pad?.edges?.has?.(PAD_BUTTON.START)) {
      // readPad's edge memory (this.pad.buttons) goes stale during gameplay.
      // Seed it from the live pad before opening, or a held A/B (jump/sprint)
      // reads as a fresh edge on the first menu frame and instant-closes the
      // pause (pre-flight review I3).
      for (const i of [PAD_BUTTON.A, PAD_BUTTON.B]) {
        if (ctx.input.pad.held.has(i)) this.pad.buttons.add(i);
        else this.pad.buttons.delete(i);
      }
      // Seeding closes the readPad door; this closes the other one. pollPad
      // pushes pad edges into input.pressed as virtual key codes, and
      // navigate()'s confirm reads hit('Space') — so A and Start landing in the
      // same 16 ms poll would open the pause and click Resume in this very
      // call. The frame's pad edges are consumed by the screen opening.
      ctx.input.clearPadEdges?.();
      this.open('pause');
    }
    this.navigate(ctx);
    // Only the open screen's viewer is stepped; the other is disposed, not idle.
    if (this.screen === 'select') this.preview?.update?.(dt);
    else if (this.screen === 'logbook') this.logbook.update(dt);
  }

  /** Slow orbit over the generated stage behind the title screen. Runs in
   *  lateUpdate so it wins over CameraRig, which has already had its turn. */
  orbit(ctx, dt) {
    // The select screen sits over the same live stage the title does, and a
    // frozen camera behind a menu reads as a still image rather than a world.
    if ((this.screen !== 'title' && this.screen !== 'select') || !ctx.camera) return;
    this.orbitAngle += dt * 0.06;
    const c = ctx.stage?.center ?? ctx.player?.position ?? { x: 0, y: 0, z: 0 };
    const r = 34;
    ctx.camera.position.set(
      c.x + Math.cos(this.orbitAngle) * r,
      (c.y ?? 0) + 16,
      c.z + Math.sin(this.orbitAngle) * r
    );
    ctx.camera.lookAt(c.x, (c.y ?? 0) + 3, c.z);
  }
}

/**
 * The Edict screen's stylesheet.
 *
 * It lives here rather than in `ui/hud.css` for one reason: this screen landed
 * in a wave where `hud.css` is not this agent's file to edit, and a screen that
 * ships without its own rules renders as unstyled UA boxes. Every value below
 * is drawn from the tokens `hud.css` already declares on `:root` — `--u`,
 * `--ink`, `--line`, `--panel-hard`, the tier colours — so there is exactly one
 * type ramp and one palette in the product, and folding this block into
 * `hud.css` verbatim is a cut-and-paste with no rewriting.
 *
 * Idempotent, so a second `Menus` (the harness builds one per scenario) does
 * not accumulate stylesheets.
 */
const EDICT_STYLE_ID = 'telluric-edict-style';
function injectEdictStyles() {
  if (document.getElementById(EDICT_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = EDICT_STYLE_ID;
  el.textContent = `
/* The Edict sits over live gameplay, so it takes the heavy pause-screen scrim
   rather than the title's directional wash: the panel is dense and the frame
   behind it is a fight. */
/* Two classes deep on purpose: this sheet is appended at runtime and may land
   either side of hud.css in the cascade, so it must not tie with
   .panel--rules on specificity. */
.panel.panel--edict { width: min(80em, 95vw); }

.edict-body {
  display: grid;
  grid-template-columns: minmax(11em, 15em) 1fr;
  gap: 1.1em;
  margin-bottom: 1.3em;
  min-height: 0;
}

/* ---- tier rail: the survivor roster's vertical-tab language, one rung down */
.edict-rail { display: flex; flex-direction: column; gap: 0.3em; }
.etab {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 0 0.6em;
  padding: 0.55em 0.7em 0.55em 0.9em;
  font: inherit;
  text-align: left;
  text-transform: uppercase;
  color: var(--ink-dim);
  background: rgba(255, 255, 255, 0.022);
  border: 0;
  border-left: 3px solid rgba(148, 182, 214, 0.22);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}
.etab-rule { display: none; }
.etab-name { grid-column: 1; font-size: 0.95em; font-weight: 700; letter-spacing: 0.2em; }
.etab-sub {
  grid-column: 1;
  font-size: var(--fs-micro);
  font-style: normal;
  letter-spacing: 0.22em;
  color: var(--ink-faint);
}
/* The filed order's own icon, on the tab. The rail then answers "which tiers
   have I decided?" without opening any of them — which is the question the
   player has on the way in. */
.etab-seal {
  grid-column: 2;
  grid-row: 1 / span 2;
  width: 1.9em;
  height: 1.9em;
  display: block;
}
.etab-open {
  grid-column: 2;
  grid-row: 1 / span 2;
  width: 1.9em;
  text-align: center;
  font-size: 1.1em;
  font-weight: var(--fw-body);
  color: var(--ink-faint);
}
.etab:hover, .etab.is-focus { color: var(--ink); background: rgba(255, 255, 255, 0.05); }
.etab.is-focus { border-left-color: var(--t-lunar); }
.etab.is-on {
  color: #fff;
  border-left-color: var(--accent);
  background: linear-gradient(100deg, color-mix(in srgb, var(--accent) 20%, transparent), transparent 76%);
}

/* ---- right pane */
.edict-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }

/* The one piece of large type on the screen, and the only sentence. */
.estand {
  padding: 0.7em 1em 0.8em;
  margin-bottom: 0.7em;
  background: var(--bezel);
  border-left: 3px solid var(--accent);
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 0.9em), calc(100% - 0.9em) 100%, 0 100%);
}
.estand-k { font-size: var(--fs-micro); letter-spacing: 0.24em; color: var(--ink-faint); margin-bottom: 0.35em; }
.estand-v {
  font-size: 1.7em;
  font-weight: 800;
  letter-spacing: 0.12em;
  line-height: 1.05;
  color: var(--accent);
}
.estand-v em { font-style: normal; font-weight: var(--fw-label); letter-spacing: 0.16em; color: var(--ink-dim); }

.edict-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15em, 1fr));
  gap: 0.35em;
  overflow-y: auto;
  max-height: min(46vh, 30em);
  padding-right: 0.5em;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 182, 214, 0.5) rgba(255, 255, 255, 0.05);
}
/* Explicit, because the one browser default left in this product — the
   logbook's bare UA thumb on an invisible track — has been a ranked defect in
   three consecutive critiques. */
.edict-grid::-webkit-scrollbar { width: 10px; }
.edict-grid::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.05); }
.edict-grid::-webkit-scrollbar-thumb {
  background: rgba(148, 182, 214, 0.5);
  border: 2px solid transparent;
  background-clip: content-box;
}
.edict-grid::-webkit-scrollbar-thumb:hover { background: var(--line-hot); background-clip: content-box; }

.eitem {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  align-items: start;
  gap: 0.1em 0.6em;
  padding: 0.5em 0.6em 0.55em;
  font: inherit;
  text-align: left;
  color: var(--ink-dim);
  background: var(--bezel);
  border: 1px solid var(--bezel-line);
  border-left: 3px solid rgba(148, 182, 214, 0.2);
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 0.7em), calc(100% - 0.7em) 100%, 0 100%);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}
/* Fixed pixel box for the same reason .art-mark has one: nothing about the
   glyph may be allowed to move the title's baseline. */
.eitem-icon { grid-row: 1 / span 2; width: 34px; height: 34px; display: block; opacity: 0.85; }
.eitem-name { font-size: 0.86em; font-weight: 700; letter-spacing: 0.14em; }
.eitem-desc {
  font-size: var(--fs-micro);
  font-style: normal;
  line-height: 1.4;
  text-transform: none;
  letter-spacing: 0.01em;
  color: var(--ink-faint);
}
.eitem-held {
  position: absolute;
  right: 0.5em; top: 0.45em;
  padding: 0.05em 0.4em;
  font-size: var(--fs-micro);
  font-weight: 700;
  letter-spacing: 0.14em;
  color: #05070a;
  background: var(--ink-faint);
}
.eitem:hover { color: var(--ink); background: rgba(255, 255, 255, 0.05); }
.eitem.is-focus { border-left-color: var(--t-lunar); color: var(--ink); }
.eitem.is-on {
  color: #fff;
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  border-left-color: var(--accent);
  background: linear-gradient(115deg, color-mix(in srgb, var(--accent) 22%, transparent), transparent 72%);
}
.eitem.is-on .eitem-icon { opacity: 1; filter: drop-shadow(0 0 7px var(--accent)); }
.eitem.is-on .eitem-held { color: #05070a; background: var(--accent); }
/* The corner chip idiom the artifact grid already uses for LOCKED, inverted:
   there it marks what you cannot have, here what you have claimed. */
.eitem.is-on::after {
  content: 'ORDERED';
  position: absolute;
  right: 0; bottom: 0;
  padding: 0.05em 0.45em 0.05em 0.7em;
  font-size: var(--fs-micro);
  letter-spacing: 0.2em;
  color: #05070a;
  background: var(--accent);
  clip-path: polygon(0.7em 0, 100% 0, 100% 100%, 0 100%);
}
.eitem.is-on .eitem-held { display: none; }
`;
  document.head.appendChild(el);
}

function setAudio(audio, methods, prop, value) {
  for (const m of methods) {
    if (typeof audio[m] === 'function') { audio[m](value); return; }
  }
  if (prop in audio) audio[prop] = value;
  else audio[prop] = value;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * An item card's effect line at the stack the player actually holds.
 *
 * `description` is a function of the stack count for most items and a plain
 * string for a few, and it is authored to be read at a real count — so the
 * Edict shows it at `held` where the player owns some and at one where they do
 * not, which is the number that answers "what would taking this be worth".
 */
function describeItem(def, held) {
  const d = def?.description;
  if (typeof d === 'function') {
    try { return d(Math.max(1, held)); } catch { return ''; }
  }
  return d || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * An artifact or difficulty mark, as an authored vector.
 *
 * These used to be raw Unicode codepoints — `⌘ † ⁂ ◈ ❖ ♛ ⟁ ☂ ☁ ⛈`, six Unicode
 * blocks, none present in the UI's font stack — so the artifact grid rendered
 * from the OS symbol font at that font's metrics, which pushed four sibling card
 * titles in one grid row onto three baselines spanning 15px, and the three
 * weather codepoints came back in full emoji colour on Windows. An `<img>` of a
 * fixed pixel box cannot do either: no fallback font, and the title's offset no
 * longer depends on the glyph.
 */
function markImg(key, color) {
  const url = markIcon(key, color);
  if (!url) return '';
  return `<img class="mark-img" src="${url}" alt="" aria-hidden="true">`;
}

/**
 * `fallbackQuality` is what the GPU probe recommended. It is used only when the
 * player has never touched the quality control: a stored value is an explicit
 * choice and detection must not overrule it, but shipping a hardcoded "High"
 * default to an integrated GPU is how a machine ends up at 5fps on first run.
 */
/**
 * The OS-level `prefers-reduced-motion` flag, the same one `index.html` already
 * honours in CSS. Guarded because this module is imported by node tests that
 * have no `matchMedia` at all.
 */
function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; }
  catch { return false; }
}

function load(fallbackQuality) {
  const base = { ...DEFAULTS };
  if (Number.isFinite(fallbackQuality)) base.quality = fallbackQuality;
  // A stored value is an explicit choice and wins below, exactly as it does for
  // `quality`. Absent one the OS preference is re-read on every load, not just
  // the first: the store only gains a `motion` once the player saves settings,
  // and until then the accessibility flag should keep being honoured.
  if (prefersReducedMotion()) base.motion = 0;
  try {
    const raw = adoptLegacyKey(STORE_KEY, LEGACY_STORE_KEY, localStorage);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    const out = base;
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof parsed[k] === 'number' && Number.isFinite(parsed[k])) out[k] = parsed[k];
    }
    // Adopting any finite number lets a hand-edited or corrupted store desync
    // the UI: a renderScale of 7 draws the thumb at the clamp while the
    // readout prints 700%, and a dynamicRes of 5 lights neither segment.
    // Clamp every value into its own control's range (final-review B4).
    for (const s of SLIDERS) {
      out[s.key] = Math.min(s.max, Math.max(s.min, out[s.key]));
    }
    out.quality = Math.min(3, Math.max(0, Math.round(out.quality)));
    out.dynamicRes = out.dynamicRes === 0 ? 0 : 1;
    // Same defensive posture as everything above: an unrecognised or missing
    // id leaves the default already sitting on `out` from the DEFAULTS spread
    // rather than adopting garbage.
    if (isGlyphSet(parsed.controllerGlyphs)) out.controllerGlyphs = parsed.controllerGlyphs;
    // Same normalisation, opposite bias: anything that is not an explicit 1 is
    // off, so a corrupted store cannot switch captions on for somebody.
    out.captions = out.captions === 1 ? 1 : 0;
    // NOT the `=== 1 ? 1 : 0` shape its neighbours use, and the asymmetry is
    // the whole point: every settings blob written before #41 existed carries
    // no `firstRunSeen` at all, so adopting the DEFAULTS 0 would tell this
    // module that every existing player has never played and ambush all of
    // them with a tutorial on upgrade. Reaching this line at all means a store
    // EXISTS -- the no-store case returned `base` above, and that one really
    // is a first run. So a missing key reads as 1, and only an explicit
    // stored 0 means never played.
    out.firstRunSeen = parsed.firstRunSeen === 0 ? 0 : 1;
    // The binding map is not a number and so is deliberately outside the loop
    // above and outside `this.settings`: it lives on the live `bindings`
    // object every consumer already reads. `adopt` is defensive in the same
    // spirit as the clamps — anything malformed leaves that action at its
    // shipped default rather than unbinding it.
    bindings.reset();
    bindings.adopt(parsed.bindings);
    return out;
  } catch {
    bindings.reset();
    return base;
  }
}

function save(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...settings, bindings: bindings.toJSON() }));
  } catch { /* private mode */ }
}

// The settings store's two ends, named for the tests that exercise the
// round-trip. Nothing in `src` imports these — `Menus` calls them directly.
export { load as loadSettings, save as saveSettings };
