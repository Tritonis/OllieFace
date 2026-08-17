/**
 * One event surface for the four cues a player must not miss (#45, #46).
 *
 * Downed, revived, a corruption threshold crossing and the teleporter are the
 * moments the game currently announces with a sound and a colour, and both of
 * those are unavailable to somebody who cannot hear or cannot see. Rather than
 * grow two parallel pipelines — a live region for screen readers and a caption
 * line for players with sound off — this subscribes once to the events the
 * gameplay systems ALREADY emit and drives both sinks from the same line of
 * text. Nothing in `src/systems/` is re-emitted or changed for this; a cue that
 * is not on the bus is not announced.
 *
 *   live    — always written, always visually hidden (`aria-live="polite"`).
 *             Inert to sighted play, so it needs no setting.
 *   caption — written only when `settings.captions` is 1. Off by default, the
 *             opt-in convention for game captions, and unlike `motion` it is
 *             NOT seeded from an OS preference: there is no OS-level "I want
 *             captions" flag that would be honest to read here.
 */
import { BANDS } from '../data/corruption.js';

/** How long one caption stays on screen. Long enough to read a short line. */
export const CAPTION_HOLD_S = 4;

/** Charge milestones worth interrupting for. Every frame would be a barrage. */
const TP_STEPS = [0.25, 0.5, 0.75];

function who(ctx, player) {
  if (!player || player === ctx?.player) return 'You';
  return player.survivor?.name || player.name || 'A teammate';
}

export class Announcer {
  /**
   * `refs` are the two element-likes: `{ live, caption }`. They are passed in
   * rather than created here so the HUD's markup stays in one file and the
   * tests can hand over stubs.
   */
  constructor(ctx, refs, events = ctx?.events) {
    this.ctx = ctx;
    this.live = refs?.live || null;
    this.caption = refs?.caption || null;
    this.captionT = 0;
    this._flip = false;
    this._tpStep = -1;
    if (events?.on) this.bind(events);
  }

  bind(events) {
    const on = (name, fn) => events.on(name, fn);

    on('playerDowned', (e) => this.announce(
      e?.player === this.ctx?.player || !e?.player
        ? 'You are down — bleeding out'
        : `${who(this.ctx, e.player)} is down`));
    on('playerBledOut', (e) => this.announce(`${who(this.ctx, e?.player)} bled out`));
    on('playerRevived', (e) => {
      const name = who(this.ctx, e?.player);
      this.announce(name === 'You' ? 'You are revived and back up' : `${name} was revived`);
    });

    // A band change IS the threshold crossing — `Corruption` only emits this
    // when `_band` actually moves, so there is nothing to debounce here.
    on('corruptionBand', (e) => {
      const band = BANDS[e?.band ?? 0];
      const rising = (e?.band ?? 0) > (e?.prev ?? 0);
      this.announce(`Corruption ${rising ? 'rising' : 'falling'} — ${band?.name || 'unknown'}`);
    });

    on('teleporterCharging', (e) => {
      const p = e?.progress ?? 0;
      if (p <= 0.001) { this._tpStep = -1; this.announce('Teleporter charging'); return; }
      let step = -1;
      for (let i = 0; i < TP_STEPS.length; i++) if (p >= TP_STEPS[i]) step = i;
      if (step > this._tpStep) {
        this._tpStep = step;
        this.announce(`Teleporter charging — ${Math.round(TP_STEPS[step] * 100)}%`);
      }
    });
    on('teleporterComplete', () => {
      this._tpStep = -1;
      this.announce('Teleporter charged — proceed to the next stage');
    });
  }

  /** True while the player has asked for captions. Read live, never cached. */
  get captionsOn() { return this.ctx?.settings?.captions === 1; }

  announce(text) {
    if (!text) return;
    if (this.live) {
      // A live region does not re-announce text identical to what it already
      // holds, and "You are down" twice in a run is not a rare case. The
      // alternating trailing space makes every write a new string.
      this._flip = !this._flip;
      this.live.textContent = this._flip ? text : `${text} `;
    }
    if (!this.caption) return;
    if (!this.captionsOn) {
      // Not merely skipped: a caption left standing from before the player
      // turned the setting off would outlive the setting.
      this.caption.textContent = '';
      this.caption.classList?.toggle('is-on', false);
      this.captionT = 0;
      return;
    }
    this.caption.textContent = text;
    this.caption.classList?.toggle('is-on', true);
    this.captionT = CAPTION_HOLD_S;
  }

  update(dt) {
    if (this.captionT <= 0) return;
    this.captionT -= dt;
    if (this.captionT > 0) return;
    this.captionT = 0;
    if (this.caption) {
      this.caption.textContent = '';
      this.caption.classList?.toggle('is-on', false);
    }
  }
}
