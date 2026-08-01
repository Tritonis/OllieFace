// Full-screen overlay screens: title, pause, settings, death, pickup banner.
//
// Owned and driven by HUD (main.js only registers the HUD system), so this
// class exposes plain methods rather than the system lifecycle.

import { itemArt, tierMeta } from './Icons.js';

const STORE_KEY = 'petrichor.settings';

const DEFAULTS = {
  quality: 2,
  fov: 70,
  sensitivity: 1.0,
  master: 0.8,
  sfx: 0.9,
  music: 0.6,
  shake: 1.0,
  spawnRate: 1.0,
};

const QUALITY_NAMES = ['Low', 'Medium', 'High', 'Ultra'];

const SLIDERS = [
  { key: 'fov', label: 'Field of view', min: 60, max: 110, step: 1, fmt: (v) => `${v | 0}°` },
  { key: 'sensitivity', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'master', label: 'Master volume', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'sfx', label: 'SFX volume', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'music', label: 'Music volume', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'shake', label: 'Screen shake', min: 0, max: 2, step: 0.05, fmt: pct },
  // Gameplay pacing rather than presentation, but it lives here because this is
  // the screen players look in for knobs. The Director reads it straight off
  // `ctx.settings`; 0% means no ambient spawns at all (the teleporter boss
  // still arrives, or the run could not be finished).
  { key: 'spawnRate', label: 'Enemy spawn rate', min: 0, max: 3, step: 0.05, fmt: pct },
];

function pct(v) { return `${Math.round(v * 100)}%`; }

export class Menus {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = document.getElementById('overlay');
    this.screen = null;
    this.returnTo = 'title';
    // Angle 0 puts the camera at `centre + (r, 16, 0)` looking straight down
    // the key light — the flattest bearing on the compass, and the first frame
    // the player ever sees. Start cross-lit instead.
    this.orbitAngle = 2.2;
    this.bannerTimer = 0;

    this.settings = load(ctx.pipeline?.quality);
    ctx.settings = this.settings;

    this.build();
    this.apply();
    this.open('title');

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
          <h1 class="title-word">PETRICHOR</h1>
          <div class="title-rule"></div>
          <div class="title-seed">SEED <span data-seed>—</span></div>
        </div>
        <nav class="menu-list">
          <!-- Four entries at identical weight is not a menu, it is a list: the
               first frame of the game has to say where to click. The default
               action is promoted (rule, wash, marker) and the destructive one
               demoted, and the subtitles give each plate's empty right-hand
               three quarters something to do. -->
          <button class="mbtn mbtn--go" data-act="play"><span>Play</span><em class="mbtn-sub">begin a run</em></button>
          <button class="mbtn" data-act="coop"><span>Co-op</span><em class="mbtn-sub">host or join</em></button>
          <button class="mbtn" data-act="settings"><span>Settings</span><em class="mbtn-sub">video &amp; input</em></button>
          <button class="mbtn mbtn--quiet" data-act="quit"><span>Quit</span><em class="mbtn-sub">exit</em></button>
        </nav>
      </section>

      <section class="screen screen--pause" data-screen="pause">
        <div class="panel">
          <header class="panel-head"><h2>Paused</h2><div class="panel-tag">Run suspended</div></header>
          <nav class="menu-list">
            <button class="mbtn mbtn--go" data-act="resume"><span>Resume</span></button>
            <button class="mbtn" data-act="coop"><span>Co-op</span></button>
            <button class="mbtn" data-act="settings"><span>Settings</span></button>
            <button class="mbtn" data-act="quit"><span>Quit to title</span></button>
          </nav>
        </div>
      </section>

      <section class="screen screen--settings" data-screen="settings">
        <div class="panel panel--wide">
          <header class="panel-head"><h2>Settings</h2><div class="panel-tag">Saved locally</div></header>
          <div class="settings-grid" data-settings></div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-act="reset"><span>Defaults</span></button>
            <button class="mbtn mbtn--go" data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <section class="screen screen--coop" data-screen="coop">
        <div class="panel panel--wide">
          <header class="panel-head">
            <h2>Co-op</h2>
            <div class="panel-tag" data-coop-role>Single player</div>
          </header>

          <div class="coop-status" data-coop-status>
            Up to 4 players. One player hosts and runs the game; everyone else joins them.
          </div>

          <div class="coop-cols">
            <div class="coop-col">
              <h3 class="coop-h">Host a game</h3>
              <p class="coop-hint">Create an invite code and send it to a friend. When they
                send a reply code back, paste it below to connect them. No server needed.</p>
              <nav class="menu-list menu-list--row">
                <button class="mbtn mbtn--go" data-act="coop-invite"><span>Create invite</span></button>
                <button class="mbtn" data-act="coop-copy"><span>Copy</span></button>
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
                <button class="mbtn mbtn--go" data-act="coop-accept"><span>Connect them</span></button>
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
                <button class="mbtn mbtn--go" data-act="coop-join"><span>Join</span></button>
                <button class="mbtn" data-act="coop-copy-reply"><span>Copy reply</span></button>
              </nav>
              <label class="coop-field">
                <span>Your reply code — send this back</span>
                <textarea data-coop-reply readonly placeholder="Appears once you press “Join”"></textarea>
              </label>
            </div>
          </div>

          <div class="coop-players" data-coop-players></div>

          <nav class="menu-list menu-list--row">
            <button class="mbtn" data-act="coop-leave"><span>Leave co-op</span></button>
            <button class="mbtn mbtn--go" data-act="back"><span>Back</span></button>
          </nav>
        </div>
      </section>

      <section class="screen screen--death" data-screen="death">
        <div class="death-mark">
          <h2 class="death-word">You Died</h2>
          <div class="death-rule"></div>
          <div class="death-sub" data-death-sub></div>
        </div>
        <div class="panel panel--wide">
          <div class="stat-grid" data-stats></div>
          <div class="stat-items">
            <div class="stat-items-label">Items Collected</div>
            <div class="stat-items-row" data-death-items></div>
          </div>
          <nav class="menu-list menu-list--row">
            <button class="mbtn mbtn--go" data-act="restart"><span>Restart run</span></button>
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
      </div>`;

    this.screens = {};
    for (const el of this.root.querySelectorAll('[data-screen]')) {
      this.screens[el.dataset.screen] = el;
    }
    this.banner = this.root.querySelector('[data-banner]');
    this.bannerRefs = {
      img: this.banner.querySelector('img'),
      tier: this.banner.querySelector('.pickup-tier'),
      name: this.banner.querySelector('.pickup-name'),
      desc: this.banner.querySelector('.pickup-desc'),
    };
    const seed = this.root.querySelector('[data-seed]');
    if (seed) seed.textContent = String(this.ctx.seed ?? '—');

    this.buildSettings();

    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) this.act(btn.dataset.act);
    });
  }

  buildSettings() {
    const host = this.root.querySelector('[data-settings]');
    const row = (label, control) =>
      `<div class="srow"><div class="slabel">${label}</div>${control}</div>`;

    let html = row('Quality preset',
      `<div class="sseg" data-seg="quality">${QUALITY_NAMES
        .map((n, i) => `<button class="segbtn" data-val="${i}">${n}</button>`)
        .join('')}</div>`);

    for (const s of SLIDERS) {
      html += row(s.label,
        `<div class="sslider">
           <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
           <output data-out="${s.key}"></output>
         </div>`);
    }
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
      this.settings.quality = Number(seg.dataset.val);
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
      if (out) out.textContent = s.fmt(this.settings[s.key]);
    }
    for (const b of this.root.querySelectorAll('[data-seg="quality"] .segbtn')) {
      b.classList.toggle('is-on', Number(b.dataset.val) === this.settings.quality);
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

    const a = ctx.audio;
    if (a) {
      setAudio(a, ['setMasterVolume', 'setMaster', 'setVolume'], 'masterVolume', settings.master);
      setAudio(a, ['setSfxVolume', 'setSfx'], 'sfxVolume', settings.sfx);
      setAudio(a, ['setMusicVolume', 'setMusic'], 'musicVolume', settings.music);
    }
  }

  // ----------------------------------------------------------------- screens

  open(name) {
    this.screen = name;
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
  }

  close() {
    this.open(null);
  }

  act(action) {
    switch (action) {
      case 'play':
      case 'resume':
        this.close();
        this.ctx.input?.canvas?.requestPointerLock?.();
        break;
      case 'settings':
        this.returnTo = this.screen === 'settings' ? this.returnTo : this.screen;
        this.open('settings');
        break;
      case 'back':
        this.open(this.returnTo || 'title');
        break;
      case 'reset':
        Object.assign(this.settings, DEFAULTS);
        save(this.settings);
        this.apply();
        break;
      case 'quit':
        if (this.screen === 'pause') { location.reload(); }
        else { this.open('title'); }
        break;
      case 'restart':
        location.reload();
        break;
      case 'coop':
        this.returnTo = this.screen === 'coop' ? this.returnTo : this.screen;
        this.openCoop();
        break;
      case 'coop-invite':
      case 'coop-accept':
      case 'coop-join':
      case 'coop-copy':
      case 'coop-copy-reply':
      case 'coop-leave':
        this.coopAction(action);
        break;
    }
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
    this.open('coop');
    this.coopStatus(lobby?.status || 'idle');
  }

  /** All the co-op buttons. Every path here can fail, and every failure is
   *  something the player has to be told about in words. */
  async coopAction(action) {
    const lobby = this.ctx.lobby;
    if (!lobby) return this.coopSay('Networking is unavailable in this build.');
    const field = (name) => this.root.querySelector(`[data-coop-${name}]`);

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
        case 'coop-copy':
          this.coopCopy(field('invite'));
          break;
        case 'coop-copy-reply':
          this.coopCopy(field('reply'));
          break;
        case 'coop-leave':
          lobby.leave();
          for (const n of ['invite', 'answer', 'offer', 'reply']) field(n).value = '';
          break;
      }
    } catch (err) {
      this.coopSay(err?.message || 'That did not work.');
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
      peerJoined: `A player joined. ${detail?.count ?? '?'} in the game.`,
      peerLeft: `A player left. ${detail?.count ?? '?'} in the game.`,
      joining: 'Answering the invite…',
      answerReady: 'Send your reply code back to the host.',
      connected: 'Connected. Rebuilding the host\'s world…',
      disconnected: 'Disconnected from the host.',
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

  showDeath(stats) {
    const sub = this.root.querySelector('[data-death-sub]');
    sub.textContent = stats.stageName ? `Stage ${stats.stage} — ${stats.stageName}` : '';

    const host = this.root.querySelector('[data-stats]');
    const rows = [
      ['Time survived', stats.time],
      ['Stage reached', stats.stage],
      ['Level reached', stats.level ?? 1],
      ['Difficulty', stats.difficulty],
      ['Enemies killed', stats.kills],
      ['Damage dealt', stats.damage],
      ['Items collected', stats.itemCount],
    ];
    host.innerHTML = rows
      .map(([k, v]) => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}</div></div>`)
      .join('');

    const grid = this.root.querySelector('[data-death-items]');
    grid.innerHTML = stats.items?.length
      ? stats.items
          .map((it) => `<div class="ditem t-${it.tier}"><img src="${itemArt(it.id, it.tier)}" alt="" />
             ${it.count > 1 ? `<b>x${it.count}</b>` : ''}</div>`)
          .join('')
      : '<div class="ditem-empty">None</div>';

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

  update(ctx, dt) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('is-on');
    }
    if (ctx.input?.hit?.('Escape')) {
      if (!this.screen) this.open('pause');
      else if (this.screen === 'settings' || this.screen === 'coop') this.open(this.returnTo || 'title');
      else if (this.screen === 'pause') this.act('resume');
    }
  }

  /** Slow orbit over the generated stage behind the title screen. Runs in
   *  lateUpdate so it wins over CameraRig, which has already had its turn. */
  orbit(ctx, dt) {
    if (this.screen !== 'title' || !ctx.camera) return;
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

function setAudio(audio, methods, prop, value) {
  for (const m of methods) {
    if (typeof audio[m] === 'function') { audio[m](value); return; }
  }
  if (prop in audio) audio[prop] = value;
  else audio[prop] = value;
}

/**
 * `fallbackQuality` is what the GPU probe recommended. It is used only when the
 * player has never touched the quality control: a stored value is an explicit
 * choice and detection must not overrule it, but shipping a hardcoded "High"
 * default to an integrated GPU is how a machine ends up at 5fps on first run.
 */
function load(fallbackQuality) {
  const base = { ...DEFAULTS };
  if (Number.isFinite(fallbackQuality)) base.quality = fallbackQuality;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    const out = base;
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof parsed[k] === 'number' && Number.isFinite(parsed[k])) out[k] = parsed[k];
    }
    return out;
  } catch {
    return base;
  }
}

function save(settings) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
