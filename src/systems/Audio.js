import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';
import { isLocalOwner } from '../core/Engine.js';
import { MusicEngine } from './Music.js';

/**
 * Fully procedural WebAudio. No files, no network, no decode step.
 *
 * Everything is built from three primitives — a shared white-noise buffer, raw
 * oscillators, and biquad filters — glued together with envelopes. A gunshot is
 * a noise burst through a downward-sweeping bandpass, plus a pitched body
 * sweeping 320Hz to 55Hz, plus a 4ms square click for the transient. Layering
 * those three is what makes it read as a weapon instead of as a beep; it is the
 * same rule as the VFX layer.
 *
 * Signal flow:
 *   voices -> sfx -> sfxLimiter ─┐
 *             music / ambient ──┴─> master -> limiter -> destination
 *
 * There are two limiters, and the split matters. `sfx` gets its own before the
 * master, because a single limiter on the sum meant an explosion pulled the
 * soundtrack down with it — measured at 3-14 dB of gain reduction continuously
 * through combat, against a music engine whose entire dynamic range from sparse
 * opening to full tilt is under 8 dB. The master limiter is now a safety net
 * for the sum rather than the thing shaping the mix.
 *
 * The soundtrack lives in Music.js and owns everything downstream of the
 * `music` bus, including its own voice accounting: the sequencer is
 * deliberately outside MAX_VOICES, because a cap that works by refusing new
 * sounds must never be allowed to refuse the downbeat. See MusicEngine._count.
 */

/**
 * Voice budget.
 *
 * Two things were wrong with a single flat cap. The counter is incremented per
 * *node* while the gate was checked per *sound*, and one sound is four to
 * eleven nodes — so it routinely overshot its own ceiling (measured peak 35
 * against a cap of 28) and then refused everything until it drained. And it
 * applied to the player's own damage cue: measured over three minutes of heavy
 * combat the gate refused 1720 times, ~9.6 a second, and `playerHurt` bailing
 * took the music duck with it. The "I am taking damage" sound is the player's
 * primary off-screen threat signal and it was being deleted selectively in
 * exactly the fights it exists for.
 *
 * So `_take` is charged the node count the sound is about to spend, and world
 * SFX may not take the graph above WORLD_VOICES. The difference is a standing
 * reservation that only player-feedback sounds can spend.
 *
 * The ceiling moved 28 -> 40 with the accounting, and that is a correction
 * rather than a loosening: the old gate let the *measured* count run to 35
 * because it charged one per sound and counted one per node, so 28 was never
 * the number the graph actually ran at. Charging honestly at 28 would have cut
 * the real world-SFX budget from ~35 concurrent nodes to 20 and thinned a
 * firefight — measured, refusals went from 658 to 2739 over 150 s of the same
 * combat. 40/10 kept the density the game was tuned against and was supposed to
 * hold ten nodes in reserve that no amount of world noise could take.
 *
 * Two further things were wrong with THAT, and both are measured.
 *
 * Fourteen catalogue entries — `pickup`, `levelUp`, `chest`, `shrineWin`,
 * `teleporterStart`, `coin` and the rest — emitted nodes through `_release`,
 * which charges the counter, without ever calling `_take`, which reads it. So
 * they pushed the counter arbitrarily far past its own ceiling: measured, six
 * calls in sequence reached 58 against a cap of 40, at which point BOTH
 * `_take(5)` and `_take(3, true)` returned false. The reserve was fiction, and
 * `playerHurt` — the sound the whole scheme exists to protect — was refused at
 * any `voices >= 38` whatever its priority flag said.
 *
 * The fix is structural rather than a fourteenth exception: the two classes get
 * two counters, and each gate reads ONLY the counter its own class can fill.
 * World SFX are gated on `worldVoices` against WORLD_VOICES; player-feedback
 * sounds are gated on `priorityVoices` against PRIORITY_RESERVE. Neither can
 * refuse the other, at any load, by construction rather than by arithmetic that
 * happens to work out. The bucket is chosen by `_take` and spent by `_release`,
 * so the gate and the charge cannot drift apart the way they did.
 *
 * A shared total does NOT give that property, and this is measured rather than
 * argued: with world gated on its own counter but priority still gated on the
 * sum, 60 s of ordinary combat refused 158 three-node player-feedback sounds,
 * because the graph legitimately reached 58 live nodes and the priority gate
 * read all of them. A reserve that a full graph can consume is not a reserve.
 *
 * The sizes. WORLD_VOICES 44 is what the game was in fact tuned against: the
 * old cap was 30 world nodes, but fourteen sounds spent outside it and the
 * graph ran to a measured 58 in ordinary play with zero clipped samples and the
 * master limiter pulling 0.5 dB at its worst. Refusals over 60 s of combat go
 * 48.8/s (54.6% of everything the mix asked for) to 14.0/s (29.5%), and the
 * price of that is on the SFX limiter, which goes from -2.82 dB of mean gain
 * reduction to -4.26 dB. That is the trade, stated: more of the fight survives,
 * and the bus that catches it works harder. PRIORITY_RESERVE 28 is the worst
 * realistic concurrency of the sounds allowed into it — a `pickup` (11) and a
 * `levelUp` (12) overlapping while the player takes a hit (3) is 26.
 *
 * MAX_VOICES is then just the sum, and is a diagnostic ceiling rather than a
 * gate: nothing is measured against it.
 */
const WORLD_VOICES = 44;
const PRIORITY_RESERVE = 28;
const MAX_VOICES = WORLD_VOICES + PRIORITY_RESERVE;

/**
 * Music bus coefficient, against an SFX bus of 0.9. Named because three places
 * write it — graph setup, `setMusicVolume`, and the `playerHurt` duck's restore
 * target — and a duplicated literal across those is a silent way for the duck
 * to restore the bus to the wrong level.
 */
const MUSIC_BUS = 0.80;

/**
 * Item tiers as a pitch ladder for `pickup()`. The tier never reached the sound
 * at all before — the emitter sent `{id, count}` and the direct `play('pickup')`
 * calls beside it passed no argument — so all six tiers played the identical
 * tier-0 jingle and `pickup`'s tier-scaled pitch, its extra note and its
 * shimmer tail were unreachable. `itemPickup` now carries the tier name and
 * this maps it to a rung; `play('pickup', null, 'equipment')` takes the same
 * road.
 */
const PICKUP_TIER = {
  common: 0, uncommon: 1, legendary: 2, boss: 3, lunar: 4, equipment: 1,
  // A blight card is a corruption, not a reward; it takes the plainest voice
  // until it gets a cue of its own.
  blight: 0,
};

const SURFACES = {
  stone:    { freq: 2600, q: 1.2, decay: 0.09, gain: 0.5 },
  concrete: { freq: 2200, q: 1.1, decay: 0.10, gain: 0.5 },
  metal:    { freq: 4200, q: 6.0, decay: 0.26, gain: 0.45, ring: 1 },
  dirt:     { freq: 900,  q: 0.8, decay: 0.13, gain: 0.55 },
  grass:    { freq: 1400, q: 0.7, decay: 0.11, gain: 0.4 },
  wood:     { freq: 1700, q: 2.4, decay: 0.14, gain: 0.5 },
  flesh:    { freq: 500,  q: 1.0, decay: 0.12, gain: 0.7 },
};

// A minor pentatonic. Every layer draws from one scale so the procedural music
// can never produce a wrong note, however the layers happen to overlap.
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
const ROOT = 110; // A2

/**
 * The world-state audio layer (launch design §1, world state): gain per
 * corruption band on the void shimmer bed. Zero through band 1 for the same
 * reason BAND_GRADE's early entries are zero — an atmosphere that sickens
 * before the world does spends the effect before it means anything.
 *
 * Priced against `master`, not the ambient bus — the layer is routed there so
 * the Music slider cannot silence it.
 *
 * Re-priced after the 2026-08-08 playtest, where nobody heard the layer at all.
 * The old numbers were the ambient-bus figures folded through that bus's own
 * 0.4, which made the reroute loudness-neutral and left the result well under
 * the combat mix floor. These are chosen against that floor instead; the
 * tone-routing fix below is the other half of the same repair.
 */
export const VOID_LAYER = [0, 0, 0.05, 0.10, 0.16];

/**
 * How long the band sting holds the floor after it fires, in seconds.
 *
 * Longer than the sting itself (0.9 s) on purpose: the guard exists so a
 * threshold the world is sitting on cannot machine-gun the ears, and a guard
 * that expires mid-sting would let the second one talk over the first.
 *
 * Two things this window is NOT, both easy to assume and both wrong:
 *
 *   * It is not `SNAP.window` (Blight.js), which happens to be 1.6 as well.
 *     Nothing derives one from the other; retuning the screen lurch must not
 *     silently retune the ears.
 *   * It is not per-crossing. A genuinely different crossing landing inside the
 *     window (2->3 arriving 0.3 s after 1->2) is suppressed too, so a fast
 *     double crossing announces twice on screen and on the gauge and once in
 *     the ears. That is deliberate — two stings in a third of a second read as
 *     a glitch, not as two events — and this is where it is written down.
 */
export const BAND_STING_WINDOW = 1.6;

export function voidLayerGain(band) {
  const b = Number.isFinite(band) ? Math.floor(band) : 0;
  return VOID_LAYER[Math.max(0, Math.min(b, VOID_LAYER.length - 1))];
}

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _mat = new THREE.Matrix4();

export class Audio {
  constructor() {
    this.ac = null;
    this.ready = false;
    this.muted = false;
    this.masterVolume = 0.85;
    // Settings may be applied before the first gesture builds the graph, so
    // volumes live here and _ensure() picks them up when the buses exist.
    this.sfxVolume = 1;
    this.musicVolume = 1;
    this.voices = 0;
    // Nodes owned by world SFX only. World sounds are gated on this rather than
    // on the total, so a burst of player-feedback sounds can never refuse a
    // gunshot and — the failure this exists for — a wall of world noise can
    // never refuse the player's own damage cue.
    this.worldVoices = 0;
    // Nodes owned by player-feedback sounds only, gated against a reserve
    // nothing else may spend. Its whole job is to still have room in it during
    // the loudest fight in the game.
    this.priorityVoices = 0;
    this._priorityCharge = false;
    // Gate diagnostics. Read by the audio probes; nothing makes decisions on
    // them. They are here because "how often is the mix being deleted" was
    // reported from a one-off instrumented build twice and disagreed with
    // itself by 5x both times.
    this._takes = 0;
    this._refusals = 0;
    this.intensity = 0;

    this._throttles = new Map();
    this._variants = new Map();
    // Context time before which no band sting may fire. See `bandSting`.
    this._stingReady = 0;
    // Last announced stack count per item id. `itemPickup` carries an absolute
    // total, not a delta, so this is what tells a pickup from a removal.
    this._itemCounts = new Map();
    this._shotIndex = 0;
    this._footIndex = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.audio = this;

    // Autoplay policy: nothing may be created until a real gesture happens.
    const unlock = () => {
      this._ensure();
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
      removeEventListener('touchstart', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    addEventListener('touchstart', unlock);

    // Most of these hooks do two things: play the sound, and feed the music's
    // fast intensity term. The impulse weights are what decide how a fight
    // "feels" to the soundtrack — a swing at a lone scarab should not lift the
    // track, twenty seconds of sustained trading should.
    const e = ctx.events;
    e.on('damage', (p) => {
      if (!p) return;
      if (p.target?.isPlayer) return;
      this.hit(p.position || p.target?.position, p.crit);
      this.musicEngine?.bump(p.crit ? 0.045 : 0.028);
    });
    e.on('kill', (p) => {
      this.death(p?.position || p?.victim?.position, p?.isElite, p?.isBoss);
      this.musicEngine?.bump(p?.isBoss ? 0.5 : p?.isElite ? 0.14 : 0.05);
    });
    e.on('playerHurt', (p) => this.playerHurt(p?.amount ?? 0));
    // Downed & revive (mp-p3). Broadcast events, like `playerDead` forwarded
    // to every client — every peer needs to hear a teammate go down or get
    // back up, not just the pawn it happened to. Positional (`pos`), unlike
    // `playerHurt`/`playerDead` which are always about the local survivor.
    e.on('playerDowned', (p) => this.playerDowned(p?.position));
    e.on('playerRevived', (p) => this.playerRevived(p?.position));
    // Both cues speak for the person holding the headphones. On a host the bus
    // carries every pawn's economy, so without the owner test a four-player
    // party gave the viewer a jingle for every teammate's pickup and a coin for
    // every teammate's kill. In single-player every event is the viewer's and
    // both fire exactly as before.
    e.on('itemPickup', (p) => { if (isLocalOwner(ctx, p)) this.itemChanged(p); });
    e.on('goldChanged', (p) => { if (isLocalOwner(ctx, p)) this.coin(); });
    e.on('abilityUsed', (p) => this.ability(p?.slot ?? 0));
    e.on('levelUp', () => this.musicEngine?.bump(0.22));
    e.on('stageStart', (p) => {
      this.stageSting();
      // A new stage starts empty. Carrying the last fight's heat across the
      // teleport left the track at full tilt over an empty arena.
      this.musicEngine?.cool();
      // Stage 1 is the start of the run, and the run is what the opening
      // ceiling measures — not the age of the AudioContext, which begins at
      // the first gesture anywhere on the page.
      if ((p?.index ?? 0) === 0) this.beginRun();
    });
    e.on('corruptionBand', (p) => this.bandSting(p?.band ?? 0, p?.prev ?? 0));
    e.on('bossSpawn', () => { this.bossHorn(); this.musicEngine?.bump(0.7); });
    e.on('teleporterComplete', () => this.stageSting());
    // Only the local survivor's death silences the local soundtrack. `NetHost`
    // broadcasts this event to every client, where `NetClient` re-emits it, so
    // on a client a *teammate* dying must not stop the sequencer and latch the
    // ambient bed down for a player still alive and still fighting.
    //
    // The test used to be "is the local player still alive", on the premise
    // that `alive` is cleared before every emit. That is true on a host and
    // false on a client: `Combat.applyDamage` returns at the authority check
    // before it can reach `_kill`, `Player`'s self-kill fallback needs there to
    // be no `Combat` at all, and no snapshot field writes the local player's
    // health. So on a client `alive` was *never* false and the guard returned on
    // the client's own death too — full soundtrack over the death screen, no
    // sting, no darkening. Measured on a real two-page session.
    //
    // So: identity when the wire gives it (`Combat` names the victim and
    // `sanitise` carries it as a netId), the liveness test as the fallback for
    // single-player and for any emit that carries no victim.
    e.on('playerDead', (p) => {
      const me = this.ctx?.player;
      const myNetId = this.ctx?.authority === false ? (this.ctx.net?.myNetId ?? 0) : 0;
      const victimNetId = p?.victim?.netId;
      if (myNetId > 0 && victimNetId != null) {
        if (victimNetId !== myNetId) return;
      } else if (me && me.alive !== false) return;
      this.playerDead();
    });
  }

  /**
   * A run is starting. The counterpart of `playerDead`, and the only thing that
   * undoes it.
   *
   * `stop()` latches the sequencer off and `_musicOff` latches the ambient bed
   * down, and until now nothing cleared either: `reset()` demonstrably ran (the
   * run clock went back to zero) while the sequencer stayed dead and the music
   * bus sat wide open at 0.8. A second run in the same page session was silence.
   * Single-player got away with it only because the menu's restart does a
   * `location.reload()`.
   *
   * Public because it is also what the capture harness drives to put the audio
   * system into a state where "is it making a sound?" is a question with a
   * meaningful answer.
   */
  beginRun() {
    const ac = this._ensure();
    if (!ac) return;
    this._musicOff = false;
    this._itemCounts.clear();
    this.musicEngine?.reset();
    if (this.music) {
      // `playerDead` ran the bus to zero with a `setTargetAtTime`, which never
      // actually arrives — so a bare `setTargetAtTime` back up would be racing
      // an automation that is still scheduled. Cancel first, then climb.
      const t = ac.currentTime;
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setValueAtTime(this.music.gain.value, t);
      this.music.gain.setTargetAtTime(this.musicVolume * MUSIC_BUS, t, 0.15);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Graph setup                                                         */
  /* ------------------------------------------------------------------ */

  _ensure() {
    if (this.ac) {
      // `resume()` on an OfflineAudioContext throws InvalidStateError, and an
      // offline context is exactly what any sample-exact verification rig has
      // to use. `startRendering` is the thing that tells the two apart.
      if (this.ac.state === 'suspended' && !this.ac.startRendering) this.ac.resume();
      return this.ac;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    const ac = new AC({ latencyHint: 'interactive' });
    this.ac = ac;

    // Master limiter: a safety net on the sum, not the mix bus. It used to sit
    // at -8 dB / 18:1 with the SFX peaks 10 dB over it, which meant it was
    // pulling continuously during combat — and it pulls everything, so the
    // soundtrack was being compressed out by the explosions.
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 2;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    limiter.connect(ac.destination);
    this.limiter = limiter;

    const master = ac.createGain();
    master.gain.value = this.muted ? 0 : this.masterVolume;
    master.connect(limiter);
    this.master = master;

    // SFX gets the tight limiter instead, so explosions are tamed where they
    // are made rather than by dragging the rest of the mix down with them.
    // -7/14:1 was chosen against no measurement at all. Measured afterwards, it
    // pulled -2.82 dB of gain reduction on average and -8.86 dB at its worst,
    // continuously, through combat — i.e. it was not a limiter, it was the
    // thing shaping the SFX mix, which is the exact criticism that moved the
    // compression off the master in the first place. Widening the voice budget
    // (see MAX_VOICES) pushed it further, to -5.21 dB mean / -11.96 worst.
    // -5/10:1 hands that headroom back: it catches the explosion peaks and lets
    // the body of a firefight through, with the master limiter — which is
    // pulling 0.04 dB on average — as the actual safety net for the sum.
    const sfxLimiter = ac.createDynamicsCompressor();
    sfxLimiter.threshold.value = -5;
    sfxLimiter.knee.value = 2;
    sfxLimiter.ratio.value = 10;
    sfxLimiter.attack.value = 0.002;
    sfxLimiter.release.value = 0.15;
    sfxLimiter.connect(master);
    this.sfxLimiter = sfxLimiter;

    this.sfx = ac.createGain();
    this.sfx.gain.value = this.sfxVolume * 0.9;
    this.sfx.connect(sfxLimiter);

    // 0.32 against an SFX bus of 0.9 was a 9 dB structural deficit: rendered at
    // the shipped defaults the music sat 10 dB under a firefight in RMS and 19
    // under it in the sparse opening. MUSIC_BUS is the one place that number
    // lives; `setMusicVolume` and the `playerHurt` duck both read it.
    this.music = ac.createGain();
    this.music.gain.value = this.musicVolume * MUSIC_BUS;
    this.music.connect(master);

    this.ambient = ac.createGain();
    this.ambient.gain.value = this.musicVolume * 0.4;
    this.ambient.connect(master);

    // 2s of white noise covers every burst length we need without ever
    // repeating audibly, and costs one allocation for the whole run.
    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.shaper = ac.createWaveShaper();
    this.shaper.curve = makeDistortionCurve(60);

    this._buildAmbient();
    // The soundtrack owns everything downstream of `this.music`. It is built
    // last because it needs the bus and the shared noise buffer.
    this.musicEngine = new MusicEngine(ac, this.music, this.noiseBuf);
    this._syncMusicSilence();
    this.ready = true;
    return ac;
  }

  _buildAmbient() {
    const ac = this.ac;

    // --- drone: three detuned saws through a slow lowpass ---
    const droneGain = ac.createGain();
    droneGain.gain.value = 0.0;
    const droneFilter = ac.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 320;
    droneFilter.Q.value = 0.6;
    droneFilter.connect(droneGain);
    droneGain.connect(this.ambient);

    for (const detune of [-9, 0, 7]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = ROOT * 0.5;
      o.detune.value = detune;
      const g = ac.createGain();
      g.gain.value = 0.2;
      o.connect(g).connect(droneFilter);
      o.start();
    }
    // Slow filter LFO keeps the bed from sitting still and turning to mush.
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(droneFilter.frequency);
    lfo.start();
    this.droneGain = droneGain;

    // --- void layer: the corruption band as sound. A glassy tritone pair over
    // band-passed noise — an interval that never resolves, breathing through a
    // slow filter LFO.
    //
    // Straight to `master`, deliberately bypassing `ambient`: it is world
    // state, not music, and `setMusicVolume` scales the whole ambient bus, so a
    // player at Music 0 would otherwise hear a perfectly healthy world. Master
    // is still under `setMuted` and `masterVolume`, which is the behaviour we
    // do want — mute means silence. VOID_LAYER is priced against master, i.e.
    // the ambient bus's own 0.4 already folded in, so perceived loudness at the
    // default Music setting is unchanged by the reroute.
    const voidGain = ac.createGain();
    voidGain.gain.value = 0.0;
    const voidFilter = ac.createBiquadFilter();
    voidFilter.type = 'bandpass';
    voidFilter.frequency.value = 2400;
    voidFilter.Q.value = 1.4;
    voidFilter.connect(voidGain);
    voidGain.connect(this.master);

    const vnoise = ac.createBufferSource();
    vnoise.buffer = this.noiseBuf;
    vnoise.loop = true;
    const vng = ac.createGain();
    vng.gain.value = 0.5;
    vnoise.connect(vng).connect(voidFilter);
    // Same shared buffer as the wind, started three quarters of the way in:
    // one allocation for the run, and the offset keeps the two loops from
    // running in phase and combing each other.
    vnoise.start(0, 1.5);

    // Straight to `voidGain`, around the bandpass. The filter shapes the *noise*
    // and only the noise: it sits at 2400 Hz Q1.4, and these tones are 523 and
    // 740 Hz — about -25 dB through it. The tritone pair is the audible identity
    // of the layer, and it was being deleted by the layer's own filter, which is
    // why the 2026-08-08 playtest heard nothing at any band. Nothing may route
    // the pair through `voidFilter` again. Gains trimmed to suit the bypass.
    for (const [freq, det, g0] of [[523.25, -14, 0.20], [739.99, 11, 0.15]]) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.detune.value = det;
      const g = ac.createGain();
      g.gain.value = g0;
      o.connect(g).connect(voidGain);
      o.start();
    }

    const vlfo = ac.createOscillator();
    vlfo.frequency.value = 0.11;
    const vlfoGain = ac.createGain();
    vlfoGain.gain.value = 500;
    vlfo.connect(vlfoGain).connect(voidFilter.frequency);
    vlfo.start();
    this.voidGain = voidGain;

    // --- wind: looping noise through a wandering bandpass ---
    const wind = ac.createBufferSource();
    wind.buffer = this.noiseBuf;
    wind.loop = true;
    const windFilter = ac.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 620;
    windFilter.Q.value = 0.9;
    const windGain = ac.createGain();
    windGain.gain.value = 0.09;
    wind.connect(windFilter).connect(windGain).connect(this.ambient);
    wind.start();

    const wlfo = ac.createOscillator();
    wlfo.frequency.value = 0.09;
    const wlfoGain = ac.createGain();
    wlfoGain.gain.value = 380;
    wlfo.connect(wlfoGain).connect(windFilter.frequency);
    wlfo.start();

    const wlfo2 = ac.createOscillator();
    wlfo2.frequency.value = 0.037;
    const wlfo2Gain = ac.createGain();
    wlfo2Gain.gain.value = 0.055;
    wlfo2.connect(wlfo2Gain).connect(windGain.gain);
    wlfo2.start();

    droneGain.gain.setTargetAtTime(0.18, ac.currentTime, 2.5);
  }

  /* ------------------------------------------------------------------ */
  /* Voice plumbing                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Voice cap check, charged the number of source nodes the sound is about to
   * spend. `cost` is the sound's worst case, counted from its own body — the
   * gate has to be in the same units as `_release`'s counter or the cap is
   * unpredictable.
   *
   * `priority` is for sounds the player needs in order to play correctly: their
   * own damage, their death, a shield breaking, a heal, an ability firing.
   * Those may spend the whole budget; world SFX may not take it past
   * WORLD_VOICES, so the difference is always there when one of them arrives.
   */
  _take(cost = 1, priority = false) {
    const ok = priority
      ? this.priorityVoices + cost <= PRIORITY_RESERVE
      : this.worldVoices + cost <= WORLD_VOICES;
    this._takes++;
    if (!ok) { this._refusals++; return false; }
    // Remember which budget the sound just approved will be charged to. Sound
    // bodies are synchronous and non-overlapping — every one of them calls
    // `_take` and then emits — so this is a straight handover to `_release`
    // rather than shared state. Making the gate and the charge two halves of
    // one decision is what stops them drifting, which is how the counter ended
    // up 18 nodes above a ceiling it was still being asked about.
    this._priorityCharge = priority;
    return true;
  }

  /**
   * Charge the following sound to a budget without gating it, for the two
   * sounds that may never be refused for any reason. Still an explicit call, so
   * "this sound is exempt" is visible at the call site rather than being the
   * silent default it used to be for fourteen of them.
   */
  _always(priority = true) {
    this._priorityCharge = priority;
    return true;
  }

  _release(node) {
    this.voices++;
    // Captured, not re-read: `onended` fires seconds later, long after
    // `_priorityCharge` belongs to some other sound.
    const world = !this._priorityCharge;
    if (world) this.worldVoices++; else this.priorityVoices++;
    node.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
      if (world) this.worldVoices = Math.max(0, this.worldVoices - 1);
      else this.priorityVoices = Math.max(0, this.priorityVoices - 1);
    };
  }

  /**
   * Variant picker for sounds that fire in bursts.
   *
   * Not `Math.random() * n`: uniform picking repeats the same variant back to
   * back roughly 1/n of the time, and a back-to-back identical burst is
   * precisely the machine-gun artefact variants exist to remove. Advancing by
   * 1 or occasionally 2 walks the whole set, never repeats consecutively, and
   * still never sounds like a fixed rotation.
   */
  _variant(key, n) {
    const i = ((this._variants.get(key) ?? 0) + (Math.random() < 0.3 ? 2 : 1)) % n;
    this._variants.set(key, i);
    return i;
  }

  /** Rate limit by key. Returns false if the sound should be dropped. */
  _throttle(key, minInterval) {
    const now = this.ac.currentTime;
    const last = this._throttles.get(key) ?? -1;
    if (now - last < minInterval) return false;
    this._throttles.set(key, now);
    return true;
  }

  /**
   * Destination for a positional voice. Everything at or near the camera skips
   * the panner entirely — HRTF on UI sounds just smears them.
   */
  _out(pos, refDistance = 6, maxDistance = 140) {
    if (!pos) return this.sfx;
    // A `PannerNode`'s position params reject non-finite values by throwing, and
    // a throw out of a listener used to take the rest of that event's dispatch
    // with it. Anything we cannot place, we play unpanned rather than not at
    // all — the belt to the wire-format braces in `NetHost.sanitise`.
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return this.sfx;
    const ac = this.ac;
    const p = ac.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    p.rolloffFactor = 1.1;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.sfx);
    return p;
  }

  _noise(t0, dur, { type = 'bandpass', freq = 1200, freqEnd, q = 1, gain = 0.5, out, attack = 0.002 }) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    // Random offset so repeated bursts never phase-lock into a tone. Looping
    // means a long tail can outrun the 2s buffer without cutting out; white
    // noise has no audible seam at the wrap.
    src.loop = true;
    const offset = Math.random() * 1.5;

    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t0 + dur);
    f.Q.value = q;

    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(f).connect(g).connect(out || this.sfx);
    src.start(t0, offset);
    src.stop(t0 + dur + 0.05);
    this._release(src);
    return { src, filter: f, gain: g };
  }

  _tone(t0, dur, { type = 'sine', f0 = 220, f1, gain = 0.4, out, attack = 0.004, detune = 0, curve = 'exp' }) {
    const ac = this.ac;
    const o = ac.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== undefined) {
      if (curve === 'lin') o.frequency.linearRampToValueAtTime(Math.max(1, f1), t0 + dur);
      else o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    }
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out || this.sfx);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    this._release(o);
    return { osc: o, gain: g };
  }

  /* ------------------------------------------------------------------ */
  /* SFX catalogue                                                       */
  /* ------------------------------------------------------------------ */

  /** Weapon fire: transient click + noise body + pitched thump. */
  shoot(pos, scale = 1) {
    const ac = this._ensure();
    if (!ac) return;
    // Same graceful refusal as `explosion`, and for the same reason: shots are
    // the largest single class of refused sound in a firefight (1074 of 1912
    // refusals over 60 s), and the player's own weapon falling silent is the
    // worst possible thing for the voice cap to choose. Under pressure a shot
    // keeps its transient and its body and loses the pitched thump and the
    // mechanical tail — thinner, not absent.
    const full = this._take(5);
    if (!full && !this._take(2)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 8);

    // Per-shot variation. Cycling a small irrational-ish offset avoids the
    // "identical sample retriggered" machine-gun artefact without sounding
    // random enough to lose the weapon's identity.
    this._shotIndex++;
    const vary = 1 + Math.sin(this._shotIndex * 2.399) * 0.055 + (Math.random() - 0.5) * 0.05;

    // Pitch alone was not enough at sustained fire rates: three shots a second
    // all with the same envelope shape still fuse into a buzz. Rotating the
    // body's *timbre* — bandwidth and how far the sweep falls — makes each
    // shot a distinguishable event even at 10rps.
    const v = this._variant('shoot', 3);
    const bodyQ = [0.9, 1.5, 0.6][v];
    const bodyEnd = [420, 300, 560][v];

    this._noise(t, 0.006, { type: 'highpass', freq: 4000 * vary, gain: 0.5 * scale, out, attack: 0.0008 });
    this._noise(t, 0.13 * scale, {
      type: 'bandpass', freq: 2600 * vary, freqEnd: bodyEnd, q: bodyQ, gain: 0.55 * scale, out,
    });
    if (!full) return;
    this._tone(t, 0.11 * scale, {
      type: 'triangle', f0: 320 * vary, f1: 55, gain: 0.42 * scale, out, attack: 0.001,
    });
    this._tone(t, 0.19 * scale, {
      type: 'sine', f0: 120 * vary, f1: 40, gain: 0.3 * scale, out, attack: 0.002,
    });
    // Mechanical tail on every third shot: the action cycling. Only sometimes,
    // because a gun that clatters on every round sounds broken.
    if (v === 1) {
      this._noise(t + 0.045, 0.05, {
        type: 'bandpass', freq: 3000 * vary, freqEnd: 1500, q: 4, gain: 0.14 * scale, out, attack: 0.002,
      });
    }
  }

  /** Surface impact tick, tuned per material. */
  impact(pos, material = 'stone') {
    const ac = this._ensure();
    if (!ac) return;
    if (!this._throttle('impact', 0.03)) return;
    if (!this._take(4)) return;
    const s = SURFACES[material] || SURFACES.stone;
    const t = ac.currentTime;
    const out = this._out(pos, 5);
    const vary = 0.9 + Math.random() * 0.25;
    // Impacts fire in dense volleys, so they get length variation as well as
    // pitch — a shorter tick and a longer scatter read as different surfaces
    // being struck rather than as one sound retriggering.
    const v = this._variant('impact', 3);
    const len = [1, 0.7, 1.35][v];

    this._noise(t, s.decay * len, {
      type: 'bandpass', freq: s.freq * vary, freqEnd: s.freq * 0.35, q: s.q * (v === 1 ? 1.8 : 1),
      gain: s.gain, out, attack: 0.001,
    });
    this._tone(t, s.decay * 0.8, {
      type: 'triangle', f0: 180 * vary, f1: 60, gain: 0.22, out, attack: 0.001,
    });
    if (s.ring) {
      // Metal rings at a different partial each strike; a fixed 2400Hz ping on
      // every hit turned a firefight against armour into a single held tone.
      this._tone(t, 0.5, { type: 'sine', f0: [2400, 3150, 1870][v] * vary, gain: 0.1, out, attack: 0.002 });
    }
    if (v === 2) {
      // Occasional grit scatter after the strike: chips coming off.
      this._noise(t + s.decay * 0.6, 0.09, {
        type: 'highpass', freq: 5200, gain: 0.09, out, attack: 0.006,
      });
    }
  }

  /** Enemy hit confirm. Short, bright, and pitched up on crits. */
  hit(pos, crit = false) {
    const ac = this._ensure();
    if (!ac) return;
    if (!this._throttle(crit ? 'crit' : 'hit', crit ? 0.04 : 0.055)) return;
    if (!this._take(4)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 7);
    const vary = 0.92 + Math.random() * 0.18;
    // Hit confirms are the most-repeated sound in the game by a wide margin —
    // a sustained beam can trigger this twenty times a second — so the four
    // variants shift the mid body between wet, dry and clicky.
    const v = this._variant('hit', 4);
    const bodyQ = [1.4, 3.0, 0.7, 2.0][v];

    this._noise(t, (crit ? 0.13 : 0.07) * [1, 0.75, 1.25, 0.9][v], {
      type: 'bandpass', freq: (crit ? 3400 : 2100) * vary, freqEnd: 500,
      q: bodyQ, gain: crit ? 0.55 : 0.36, out, attack: 0.001,
    });
    this._tone(t, crit ? 0.16 : 0.09, {
      type: ['square', 'sawtooth', 'square', 'triangle'][v],
      f0: (crit ? 640 : 420) * vary, f1: 90,
      gain: crit ? 0.28 : 0.17, out, attack: 0.001,
    });
    this._tone(t, 0.12, {
      type: 'sine', f0: 150 * vary, f1: 48, gain: 0.22, out, attack: 0.002,
    });
    if (crit) {
      // A high ping an octave up is the crit's signature — it has to cut
      // through a wall of ordinary hits.
      this._tone(t + 0.01, 0.22, { type: 'sine', f0: 1760 * vary, f1: 1200, gain: 0.16, out });
    }
  }

  /** Explosion: crack, filtered noise body, sub thump, and a tail. */
  explosion(pos, radius = 4) {
    const ac = this._ensure();
    if (!ac) return;
    // An explosion is the loudest event in the game and it honestly costs nine
    // nodes, which made it the first thing a busy fight deleted — measured, 1768
    // of them dropped in 60 s of ordinary combat, more than half of every
    // refusal in the mix. Refusal is now graceful rather than total: if the full
    // voice cannot be afforded, the crack, the body and the sub thump still
    // play and the tail and the debris scatter do not. A firefight where distant
    // explosions get thinner is a mix; one where they vanish is a bug.
    const full = this._take(9);
    if (!full && !this._take(3)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 12, 220);
    const s = clamp(radius / 4, 0.5, 3);
    const v = this._variant('boom', 3);
    const vary = 0.88 + Math.random() * 0.24;

    this._noise(t, 0.02, { type: 'highpass', freq: 3000 * vary, gain: 0.6, out, attack: 0.0008 });
    this._noise(t, 0.55 * s, {
      type: 'lowpass', freq: 2400 * vary, freqEnd: 180, q: 0.7, gain: 0.85, out, attack: 0.004,
    });
    this._tone(t, 0.45 * s, {
      type: 'sine', f0: 90 * vary, f1: 24, gain: 0.9, out, attack: 0.006, curve: 'exp',
    });
    if (!full) return;
    this._tone(t, 0.3 * s, {
      type: 'triangle', f0: 220 * vary, f1: 45, gain: 0.35, out, attack: 0.003,
    });
    // Debris tail arriving slightly late reads as distance and scale.
    this._noise(t + 0.09, 0.9 * s, {
      type: 'bandpass', freq: 1400 * vary, freqEnd: 300, q: 0.5, gain: 0.16, out, attack: 0.05,
    });
    // Scattered debris ticks on two of three variants. Randomised count and
    // timing, because a fixed number of ticks at fixed offsets becomes a
    // rhythm the ear locks onto once it has heard three explosions.
    if (v > 0) {
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        this._noise(t + 0.12 + Math.random() * 0.4 * s, 0.05, {
          type: 'bandpass', freq: 900 + Math.random() * 2600, q: 3, gain: 0.1, out, attack: 0.003,
        });
      }
    }
  }

  zap(pos) {
    const ac = this._ensure();
    if (!ac) return;
    if (!this._throttle('zap', 0.05) || !this._take(7)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 8);
    const vary = 0.85 + Math.random() * 0.3;
    this._noise(t, 0.14, {
      type: 'bandpass', freq: 5200 * vary, freqEnd: 1400, q: 3.5, gain: 0.42, out, attack: 0.001,
    });
    this._tone(t, 0.1, { type: 'sawtooth', f0: 1400 * vary, f1: 260, gain: 0.18, out });
    this._tone(t, 0.16, { type: 'square', f0: 90, f1: 55, gain: 0.2, out });
    // Arc crackle. Electricity is not a single sweep — the irregular retriggers
    // are what separate "lightning" from "laser", and they are what the old
    // version was missing.
    const n = 2 + this._variant('zapN', 3);
    for (let i = 0; i < n; i++) {
      this._noise(t + 0.015 + Math.random() * 0.12, 0.02, {
        type: 'bandpass', freq: 3000 + Math.random() * 5000, q: 8, gain: 0.2, out, attack: 0.0008,
      });
    }
  }

  /** Monster vocalisation: detuned saws through a formant band, distorted. */
  enemyVocal(pos, kind = 'small') {
    const ac = this._ensure();
    if (!ac) return;
    if (!this._throttle('vocal', 0.12) || !this._take(4)) return;
    const t = ac.currentTime;

    const base = kind === 'boss' ? 62 : kind === 'big' ? 95 : kind === 'elite' ? 130 : 180;
    const dur = kind === 'boss' ? 1.1 : kind === 'big' ? 0.7 : 0.42;
    const out = this._out(pos, kind === 'boss' ? 18 : 9, 200);

    const formant = ac.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(base * 5, t);
    formant.frequency.exponentialRampToValueAtTime(base * 2.2, t + dur);
    formant.Q.value = 3.2;
    formant.connect(this.shaper).connect(out);

    const vary = 0.85 + Math.random() * 0.3;
    this._tone(t, dur, { type: 'sawtooth', f0: base * 1.4 * vary, f1: base * 0.7, gain: 0.4, out: formant, attack: 0.03 });
    this._tone(t, dur, { type: 'sawtooth', f0: base * 1.4 * vary * 1.01, f1: base * 0.68, gain: 0.3, out: formant, attack: 0.05, detune: 14 });
    this._noise(t, dur * 0.8, { type: 'bandpass', freq: base * 8, freqEnd: base * 3, q: 1.2, gain: 0.12, out, attack: 0.04 });

    if (kind === 'boss' || kind === 'big') {
      this._tone(t, dur * 1.2, { type: 'sine', f0: base * 0.5, f1: base * 0.3, gain: 0.5, out, attack: 0.05 });
    }
  }

  death(pos, isElite = false, isBoss = false) {
    const ac = this._ensure();
    if (!ac) return;
    this.enemyVocal(pos, isBoss ? 'boss' : isElite ? 'elite' : 'small');
    if (!this._take(2)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 8);
    // Descending noise sweep = the dissolve, audibly.
    this._noise(t + 0.02, isBoss ? 1.4 : 0.5, {
      type: 'bandpass', freq: 3200, freqEnd: 260, q: 1.1, gain: isBoss ? 0.5 : 0.26, out, attack: 0.02,
    });
    if (isBoss) this.explosion(pos, 8);
  }

  footstep(pos, surface = 'dirt') {
    const ac = this._ensure();
    if (!ac) return;
    if (!this._throttle('step', 0.12) || !this._take(3)) return;
    const s = SURFACES[surface] || SURFACES.dirt;
    const t = ac.currentTime;
    const out = this._out(pos, 4, 40);
    const vary = 0.85 + Math.random() * 0.3;
    // Left/right alternation. Real footsteps are two slightly different sounds
    // trading off; a single sound repeating at a fixed interval is the most
    // recognisably synthetic thing in a game's mix, and it was the state of
    // this one. The offset is small — this is a limp, not two people.
    this._footIndex++;
    const foot = this._footIndex % 2 ? 1.09 : 0.94;
    this._noise(t, 0.07, {
      type: 'bandpass', freq: s.freq * 0.6 * vary * foot, freqEnd: s.freq * 0.22, q: 1.1, gain: 0.22, out,
      attack: 0.001,
    });
    this._tone(t, 0.06, { type: 'sine', f0: 110 * vary * foot, f1: 55, gain: 0.16, out, attack: 0.001 });
    // Occasional scuff: the toe dragging. One step in four or so.
    if (this._variant('scuff', 4) === 0) {
      this._noise(t + 0.02, 0.11, {
        type: 'highpass', freq: s.freq * 1.6, gain: 0.07, out, attack: 0.02,
      });
    }
  }

  playerHurt(amount = 0) {
    const ac = this._ensure();
    if (!ac) return;
    const t = ac.currentTime;
    // Duck first, and unconditionally. The duck is the reason the hit reads in
    // a loud fight, it costs no voices, and it has no business being gated on
    // the voice budget the fight has just filled.
    if (this.music) {
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setValueAtTime(this.music.gain.value, t);
      this.music.gain.linearRampToValueAtTime(this.musicVolume * MUSIC_BUS * 0.31, t + 0.03);
      this.music.gain.linearRampToValueAtTime(this.musicVolume * MUSIC_BUS, t + 0.7);
    }
    if (!this._take(3, true)) return;
    const sev = clamp(amount / 40, 0.3, 1.4);
    this._noise(t, 0.22, { type: 'lowpass', freq: 1400, freqEnd: 240, q: 0.8, gain: 0.5 * sev, attack: 0.002 });
    this._tone(t, 0.3, { type: 'sine', f0: 140, f1: 42, gain: 0.55 * sev, attack: 0.003 });
    this._tone(t, 0.18, { type: 'square', f0: 320, f1: 90, gain: 0.13 * sev });
  }

  playerDead() {
    const ac = this._ensure();
    if (!ac) return;
    const t = ac.currentTime;
    this._musicOff = true;
    // Charged, never gated. The run ending is not a moment to save three nodes,
    // and every world voice in the graph is about to expire anyway.
    this._always();
    // Fade the layers rather than the bus: the bus is also what `playerHurt`
    // and `setMusicVolume` write to, and a bus parked at 0 would silently eat
    // the next run's music if anything ever revived this instance.
    this.musicEngine?.stop(t);
    if (this.music) {
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setTargetAtTime(0, t, 0.5);
    }
    if (this.droneGain) this.droneGain.gain.setTargetAtTime(0.05, t, 1.2);
    this._tone(t, 2.2, { type: 'sine', f0: ROOT, f1: ROOT * 0.5, gain: 0.4, attack: 0.02 });
    this._tone(t, 2.4, { type: 'sawtooth', f0: ROOT * 1.5, f1: ROOT * 0.74, gain: 0.14, attack: 0.05 });
    this._noise(t, 1.6, { type: 'lowpass', freq: 900, freqEnd: 120, q: 0.7, gain: 0.2, attack: 0.05 });
  }

  /**
   * Downed (mp-p3), placeholder pending the audio pass proper (memory: the
   * audio graph carries a known flaw ticket, so this deliberately adds no new
   * graph nodes — `_out`'s PannerNode is the same per-call, non-persistent
   * node every positional sound already creates). The floor the brief sets:
   * `playerDead`'s own descending tone, reused at a fraction of its gain, with
   * none of `playerDead`'s choreography — no `_musicOff`, no bus fade,
   * because a downed body has not ended anyone's run and the soundtrack has
   * no business stopping for it.
   */
  playerDowned(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(3, true)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 10);
    this._tone(t, 1.4, { type: 'sine', f0: ROOT, f1: ROOT * 0.55, gain: 0.12, out, attack: 0.02 });
    this._noise(t, 0.9, { type: 'lowpass', freq: 800, freqEnd: 140, q: 0.6, gain: 0.06, out, attack: 0.04 });
  }

  /** Revived (mp-p3), same placeholder status as `playerDowned` — reuses `heal`'s rising arpeggio. */
  playerRevived(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(3, true)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 10);
    for (let i = 0; i < 3; i++) {
      this._tone(t + i * 0.05, 0.3, {
        type: 'sine', f0: ROOT * 4 * Math.pow(2, SCALE[i + 2] / 12), gain: 0.16, out, attack: 0.01,
      });
    }
  }

  heal(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(3, true)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 6);
    for (let i = 0; i < 3; i++) {
      this._tone(t + i * 0.05, 0.3, {
        type: 'sine', f0: ROOT * 4 * Math.pow(2, SCALE[i + 2] / 12), gain: 0.14, out, attack: 0.01,
      });
    }
  }

  shieldBreak(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(3, true)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 8);
    this._noise(t, 0.35, { type: 'highpass', freq: 3200, gain: 0.4, out, attack: 0.001 });
    this._tone(t, 0.25, { type: 'triangle', f0: 1200, f1: 300, gain: 0.22, out });
    this._tone(t, 0.4, { type: 'sine', f0: 90, f1: 40, gain: 0.35, out });
  }

  /**
   * Inventory changed. The payload carries `delta` and `tier` alongside the
   * absolute `count` (`Items._set`), so the direction and the voice are both
   * read straight off the wire: a total that went up is a pickup, one that went
   * down is a removal, and a removal used to play the reward jingle — `take()`
   * and the blight corruption transform both go through the same event as
   * `give()`.
   *
   * The shadow count is the fallback for a payload without a delta, which is
   * the shape a replicated event from an older host would have.
   */
  itemChanged(p) {
    const id = p?.id;
    if (!id) return;
    const total = p.count ?? 0;
    const prev = this._itemCounts.get(id) ?? 0;
    this._itemCounts.set(id, total);
    const delta = p.delta ?? (total - prev);
    if (delta === 0) return;
    if (delta > 0) {
      const tier = PICKUP_TIER[p.tier] ?? 0;
      this._cueTier = Math.max(this._cueTier ?? -1, tier);
    } else {
      this._cueRemoval = true;
    }
    if (!this._cuePending) {
      this._cuePending = true;
      queueMicrotask(() => this._flushItemCue());
    }
  }

  /**
   * One cue per inventory *transaction*, not per write.
   *
   * A blight card is a corruption: `Items._settleBlight` zeroes the stack it
   * eats and then writes the blight's own total, so `_set` fires a negative
   * delta in the middle of a pickup and the player heard the reward jingle
   * followed by the rejection buzzer — `deny()` is the UI "that did not work"
   * sound — for successfully picking an item up. Every write in one grant is
   * synchronous, so a microtask sees the whole transaction and can answer it
   * once: anything gained plays `pickup` at the best tier involved, and only a
   * transaction that is *purely* a loss plays `deny`.
   *
   * Two different items granted in the same frame therefore also collapse to a
   * single cue, which is what the deleted 40 ms throttle was silencing.
   *
   * What this cannot fix is a removal that is the consequence of a successful
   * action with no gain beside it — the Marrow Kiln burning an item for gold
   * (`Interactables.js`), the Hollow Market refinery trading a stack up
   * (`RealmProps.js`). Both play their own success cue and then this buzzer.
   * That needs `Items._set` to carry a reason ('give' | 'take' | 'corrupt' |
   * 'refine') so the direction stops being guessed from the sign; it is filed
   * for the item system's owner and is not fixable from here.
   */
  _flushItemCue() {
    this._cuePending = false;
    const tier = this._cueTier;
    const removed = this._cueRemoval;
    this._cueTier = null;
    this._cueRemoval = false;
    if (tier != null) this.pickup(tier);
    else if (removed) this.deny();
  }

  /** Rising arpeggio; higher tiers start higher and add a shimmer tail. */
  pickup(tier = 0) {
    const ac = this._ensure();
    // Priority: the reward cue for the game's central verb does not queue
    // behind gunfire. Eleven nodes is its worst case (five rungs plus the
    // legendary shimmer).
    //
    // The 40 ms throttle that used to sit here is gone. It existed to collapse
    // the duplicate jingle the blight transform produced; that duplicate is now
    // collapsed at its source in `itemChanged`, where the whole transaction is
    // visible, and all the throttle still did was delete the second of two
    // *different* items granted in the same frame — a chest burst, a Void
    // field's multi-grant — because `_throttle` keys on `ac.currentTime`, which
    // is identical for two synchronous calls.
    if (!ac || !this._take(11, true)) return;
    const t = ac.currentTime;
    const n = 3 + Math.min(2, tier);
    const base = ROOT * 4 * Math.pow(2, tier / 6);
    for (let i = 0; i < n; i++) {
      const f = base * Math.pow(2, SCALE[i] / 12);
      this._tone(t + i * 0.055, 0.28, {
        type: 'triangle', f0: f, gain: 0.16, attack: 0.005,
      });
      this._tone(t + i * 0.055, 0.2, {
        type: 'sine', f0: f * 2, gain: 0.06, attack: 0.005,
      });
    }
    if (tier >= 2) {
      this._noise(t + n * 0.055, 0.5, { type: 'highpass', freq: 6000, gain: 0.1, attack: 0.05 });
    }
  }

  coin() {
    const ac = this._ensure();
    if (!ac) return;
    if (!this._throttle('coin', 0.06)) return;
    // Gold cascades reach this up to 16 times a second and it was spending
    // three uncharged nodes every time, i.e. up to 50 a second off-budget.
    if (!this._take(3)) return;
    const t = ac.currentTime;
    // Gold arrives in streams, so the pair walks up a pentatonic ladder rather
    // than replaying the same two pitches. Four rungs is enough that a long
    // payout sounds like a cascade instead of a stuck bleep.
    const v = this._variant('coin', 4);
    const m = Math.pow(2, SCALE[v] / 12);
    this._tone(t, 0.09, { type: 'square', f0: 1760 * m, gain: 0.06, attack: 0.002 });
    this._tone(t + 0.03, 0.12, { type: 'square', f0: 2637 * m, gain: 0.05, attack: 0.002 });
    this._noise(t, 0.04, { type: 'highpass', freq: 8000, gain: 0.05, attack: 0.001 });
  }

  levelUp() {
    const ac = this._ensure();
    // Priority: a level-up is progression feedback, not scenery, and twelve
    // nodes is too many to fit the world budget during the fight that earned it.
    if (!ac || !this._take(12, true)) return;
    const t = ac.currentTime;
    // Major-ish rising sting over a sub swell.
    const steps = [0, 4, 7, 12, 16];
    for (let i = 0; i < steps.length; i++) {
      const f = ROOT * 2 * Math.pow(2, steps[i] / 12);
      this._tone(t + i * 0.06, 0.55, { type: 'triangle', f0: f, gain: 0.16, attack: 0.006 });
      this._tone(t + i * 0.06, 0.4, { type: 'sawtooth', f0: f * 2, gain: 0.05, attack: 0.01 });
    }
    this._tone(t, 0.9, { type: 'sine', f0: ROOT, f1: ROOT * 2, gain: 0.3, attack: 0.02 });
    this._noise(t, 0.7, { type: 'highpass', freq: 5000, gain: 0.12, attack: 0.02 });
  }

  ability(slot = 0) {
    const ac = this._ensure();
    if (!ac || !this._take(3, true)) return;
    const t = ac.currentTime;
    // `abilityUsed` carries the slot as a string id, not an index — multiplying
    // that produces NaN and WebAudio throws on a non-finite frequency.
    const idx = typeof slot === 'number'
      ? slot
      : Math.max(0, ['primary', 'secondary', 'utility', 'special'].indexOf(slot));
    const f = 700 + idx * 220;
    this._noise(t, 0.22, { type: 'bandpass', freq: f * 3, freqEnd: f, q: 1.6, gain: 0.3, attack: 0.006 });
    this._tone(t, 0.2, { type: 'sawtooth', f0: f, f1: f * 0.4, gain: 0.16 });
    this._tone(t, 0.28, { type: 'sine', f0: 140, f1: 60, gain: 0.24 });
  }

  bossHorn() {
    const ac = this._ensure();
    if (!ac || !this._take(5)) return;
    const t = ac.currentTime;
    for (const d of [0, 7, 12]) {
      this._tone(t, 2.4, {
        type: 'sawtooth', f0: ROOT * 0.5 * Math.pow(2, d / 12), gain: 0.18, attack: 0.25,
      });
    }
    this._tone(t, 2.8, { type: 'sine', f0: 41, gain: 0.5, attack: 0.3 });
    this._noise(t, 2.0, { type: 'lowpass', freq: 600, freqEnd: 140, q: 0.6, gain: 0.16, attack: 0.4 });
  }

  stageSting() {
    const ac = this._ensure();
    if (!ac || !this._take(5)) return;
    const t = ac.currentTime;
    for (let i = 0; i < 4; i++) {
      this._tone(t + i * 0.09, 0.7, {
        type: 'triangle', f0: ROOT * 2 * Math.pow(2, SCALE[i * 2] / 12), gain: 0.14, attack: 0.01,
      });
    }
    this._tone(t, 1.2, { type: 'sine', f0: ROOT * 0.5, gain: 0.3, attack: 0.05 });
  }

  /**
   * A band crossing is a moment, not a drift (2026-08-08 playtest: the world
   * state changed under the player and nothing announced it). Ascending: a
   * low boom under a tritone pair — the void layer's own interval, so the
   * sting teaches the drone's meaning. Descending: the pair resolves to a
   * fifth, the one consonance in the corruption voice.
   *
   * `_stingReady` rather than `_throttle`: a threshold the world is sitting on
   * can be crossed twice in a frame (a font bleed and a Maw feed either side of
   * it), and the guard has to outlast the sting itself, not merely thin a
   * repeat. Band 0<->1 crossings sting too — the sting is the announcement the
   * gauge alone was not.
   */
  bandSting(band, prev) {
    const ac = this._ensure();
    if (!ac || ac.currentTime < this._stingReady || !this._take(4, true)) return;
    this._stingReady = ac.currentTime + BAND_STING_WINDOW;
    const t = ac.currentTime;
    const up = band > prev;
    if (up) {
      this._tone(t, 0.9, { type: 'sine', f0: 55 + band * 8, gain: 0.5, attack: 0.005 });
      this._tone(t + 0.06, 0.8, { type: 'triangle', f0: 523.25, gain: 0.16, attack: 0.01 });
      this._tone(t + 0.06, 0.8, { type: 'triangle', f0: 739.99, gain: 0.13, attack: 0.01 });
    } else {
      this._tone(t, 0.6, { type: 'sine', f0: 523.25, gain: 0.12, attack: 0.01 });
      this._tone(t + 0.10, 0.7, { type: 'sine', f0: 784.0, gain: 0.12, attack: 0.01 });
    }
  }

  uiClick(kind = 0) {
    const ac = this._ensure();
    if (!ac || !this._take(2)) return;
    const t = ac.currentTime;
    this._tone(t, 0.05, { type: 'square', f0: kind ? 1200 : 880, gain: 0.07, attack: 0.001 });
    this._noise(t, 0.03, { type: 'highpass', freq: 5000, gain: 0.08, attack: 0.001 });
  }

  /* ------------------------------------------------------------------ */
  /* World interaction sounds                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Chest opening. Names like this one used to fall through the dispatcher's
   * default case and emit a UI blip, so a chest — one of the loudest moments
   * in a run's economy — sounded exactly like clicking a menu button.
   */
  chest(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(9)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 6, 90);
    // Latch, then lid, then the reward shimmer. The 90ms gap between the first
    // two is the mechanism; without it the whole thing is one wooden thud.
    this._noise(t, 0.05, { type: 'bandpass', freq: 3400, freqEnd: 1200, q: 5, gain: 0.4, out, attack: 0.0008 });
    this._tone(t, 0.09, { type: 'square', f0: 900, f1: 420, gain: 0.1, out, attack: 0.001 });
    this._noise(t + 0.09, 0.3, { type: 'bandpass', freq: 1500, freqEnd: 380, q: 1.6, gain: 0.34, out, attack: 0.004 });
    this._tone(t + 0.09, 0.26, { type: 'triangle', f0: 150, f1: 70, gain: 0.24, out, attack: 0.003 });
    for (let i = 0; i < 4; i++) {
      this._tone(t + 0.16 + i * 0.05, 0.4, {
        type: 'sine', f0: ROOT * 8 * Math.pow(2, SCALE[i + 2] / 12), gain: 0.075, out, attack: 0.006,
      });
    }
    this._noise(t + 0.2, 0.6, { type: 'highpass', freq: 7000, gain: 0.09, out, attack: 0.08 });
  }

  /** Shop / vault purchase: register clunk, then a rising two-note confirm. */
  purchase(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(5)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 5, 60);
    this._tone(t, 0.06, { type: 'square', f0: 260, f1: 150, gain: 0.16, out, attack: 0.001 });
    this._noise(t, 0.07, { type: 'bandpass', freq: 2000, freqEnd: 700, q: 2.4, gain: 0.28, out, attack: 0.001 });
    // The confirm sits on the same interval the pickup jingle opens on, so a
    // purchase and the item it buys read as one family of event.
    this._tone(t + 0.07, 0.22, { type: 'triangle', f0: ROOT * 6, gain: 0.13, out, attack: 0.004 });
    this._tone(t + 0.13, 0.3, { type: 'triangle', f0: ROOT * 8, gain: 0.13, out, attack: 0.004 });
    this._tone(t + 0.13, 0.22, { type: 'sine', f0: ROOT * 16, gain: 0.05, out, attack: 0.004 });
  }

  /** Shrine paid off: a bright bell chord over a sub swell. */
  shrineWin(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(10)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 9, 120);
    const IVS = [0, 7, 12, 19];
    for (let i = 0; i < IVS.length; i++) {
      const f = ROOT * 4 * Math.pow(2, IVS[i] / 12);
      // The inharmonic partial at 2.76x is what makes a stack of sines read as
      // a bell instead of as an organ. Harmonic multiples do not do it.
      this._tone(t + i * 0.04, 1.5, { type: 'sine', f0: f, gain: 0.12, out, attack: 0.006 });
      this._tone(t + i * 0.04, 0.7, { type: 'sine', f0: f * 2.76, gain: 0.035, out, attack: 0.004 });
    }
    this._tone(t, 1.4, { type: 'sine', f0: ROOT * 0.5, f1: ROOT, gain: 0.34, out, attack: 0.06 });
    this._noise(t, 1.0, { type: 'highpass', freq: 6000, gain: 0.1, out, attack: 0.12 });
  }

  /** Shrine refused: the same gesture inverted — falling, detuned, dull. */
  shrineFail(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(8)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 9, 120);
    for (let i = 0; i < 3; i++) {
      const f = ROOT * 3 * Math.pow(2, -(i * 3) / 12);
      this._tone(t + i * 0.1, 0.5, { type: 'triangle', f0: f, gain: 0.13, out, attack: 0.006 });
      // A second voice 30 cents flat is the entire "that did not work" signal;
      // the falling contour alone still sounds like a deliberate cadence.
      this._tone(t + i * 0.1, 0.5, { type: 'triangle', f0: f, gain: 0.1, out, attack: 0.008, detune: -30 });
    }
    this._tone(t, 0.7, { type: 'sine', f0: 120, f1: 44, gain: 0.34, out, attack: 0.01 });
    this._noise(t + 0.28, 0.5, { type: 'lowpass', freq: 1400, freqEnd: 220, q: 0.7, gain: 0.2, out, attack: 0.02 });
  }

  /** Blood shrine: a wet squelch over a heartbeat. */
  shrineBlood(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(5)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 7, 90);
    // High Q on the downward sweep is what turns a noise glide from "wind"
    // into something fleshy — the resonance tracks like a closing throat.
    this._noise(t, 0.34, { type: 'bandpass', freq: 1800, freqEnd: 220, q: 7, gain: 0.42, out, attack: 0.008 });
    this._noise(t + 0.05, 0.3, { type: 'lowpass', freq: 900, freqEnd: 160, q: 1.2, gain: 0.3, out, attack: 0.02 });
    // Two thumps 240ms apart: a resting lub-dub, which is what makes the price
    // of this shrine land in the body rather than in the UI.
    for (const d of [0, 0.24]) {
      this._tone(t + d, 0.3, { type: 'sine', f0: 76, f1: 34, gain: 0.5, out, attack: 0.006 });
    }
    this._tone(t, 0.9, { type: 'sawtooth', f0: ROOT * 0.5, f1: ROOT * 0.47, gain: 0.07, out, attack: 0.2 });
  }

  /** Teleporter engaging: a long rising charge that lands on a boom. */
  teleporterStart(pos) {
    const ac = this._ensure();
    if (!ac || !this._take(11)) return;
    const t = ac.currentTime;
    const out = this._out(pos, 14, 200);
    const RISE = 1.9;
    // Linear sweep, not exponential: an exponential glide spends most of its
    // length loitering near the start pitch and only "arrives" in the last
    // 200ms, which reads as a glitch rather than as a machine spinning up.
    const IVS = [0, 7, 12];
    for (let i = 0; i < IVS.length; i++) {
      const f = ROOT * Math.pow(2, IVS[i] / 12);
      this._tone(t, RISE, {
        type: 'sawtooth', f0: f, f1: f * 4, gain: 0.11, out, attack: RISE * 0.75,
        curve: 'lin', detune: i * 7 - 7,
      });
    }
    this._noise(t, RISE, { type: 'bandpass', freq: 500, freqEnd: 6500, q: 1.6, gain: 0.24, out, attack: RISE * 0.8 });
    // Electrical crackle scattered across the charge so the rise is not a
    // single clean tone for two whole seconds.
    for (let i = 0; i < 5; i++) {
      this._noise(t + 0.3 + i * 0.3 + Math.random() * 0.1, 0.05, {
        type: 'highpass', freq: 4000 + Math.random() * 3000, gain: 0.16, out, attack: 0.001,
      });
    }
    this._tone(t + RISE, 1.3, { type: 'sine', f0: 86, f1: 30, gain: 0.6, out, attack: 0.004 });
    this._noise(t + RISE, 0.9, { type: 'lowpass', freq: 2600, freqEnd: 300, q: 0.7, gain: 0.36, out, attack: 0.003 });
  }

  /** Rejected input: short, low, and unmistakably not a confirm. */
  deny() {
    const ac = this._ensure();
    // Priority for the same reason `pickup` is: it is the answer to something
    // the player just did, and an answer that sometimes does not arrive is
    // worse than no answer at all.
    if (!ac || !this._take(2, true)) return;
    const t = ac.currentTime;
    this._tone(t, 0.08, { type: 'square', f0: 200, gain: 0.09, attack: 0.001 });
    this._tone(t + 0.08, 0.12, { type: 'square', f0: 150, gain: 0.09, attack: 0.001 });
  }

  /* ------------------------------------------------------------------ */

  update(ctx, dt) {
    if (!this.ready) return;
    const ac = this.ac;

    // Listener follows the camera, not the player — the mix must match what is
    // on screen or positional cues fight the visuals.
    const cam = ctx.camera;
    if (cam) {
      cam.getWorldPosition(_camPos);
      _mat.extractRotation(cam.matrixWorld);
      _camDir.set(0, 0, -1).applyMatrix4(_mat);
      _camUp.set(0, 1, 0).applyMatrix4(_mat);
      const L = ac.listener;
      if (L.positionX) {
        const t = ac.currentTime;
        L.positionX.setTargetAtTime(_camPos.x, t, 0.02);
        L.positionY.setTargetAtTime(_camPos.y, t, 0.02);
        L.positionZ.setTargetAtTime(_camPos.z, t, 0.02);
        L.forwardX.setTargetAtTime(_camDir.x, t, 0.02);
        L.forwardY.setTargetAtTime(_camDir.y, t, 0.02);
        L.forwardZ.setTargetAtTime(_camDir.z, t, 0.02);
        L.upX.setTargetAtTime(_camUp.x, t, 0.02);
        L.upY.setTargetAtTime(_camUp.y, t, 0.02);
        L.upZ.setTargetAtTime(_camUp.z, t, 0.02);
      } else if (L.setPosition) {
        L.setPosition(_camPos.x, _camPos.y, _camPos.z);
        L.setOrientation(_camDir.x, _camDir.y, _camDir.z, _camUp.x, _camUp.y, _camUp.z);
      }
    }

    // The soundtrack runs while paused too — `update` is called every frame
    // regardless, and a sequencer that stopped advancing across a menu would
    // hand the resync guard a multi-second gap on resume.
    this.musicEngine.update(ctx, dt);
    this.intensity = this.musicEngine.intensity;

    // Ambient bed leans darker and louder as the run heats up. It tracks the
    // blended intensity, so the drone swells during a fight and not only as
    // the difficulty coefficient grinds upward.
    if (this.droneGain && !this._musicOff) {
      this.droneGain.gain.setTargetAtTime(0.14 + this.intensity * 0.14, ac.currentTime, 1.5);
    }

    // The void layer is world state, not music, so it is deliberately not
    // gated on `_musicOff` — and it hangs off `master` rather than the ambient
    // bus, so turning the Music slider to 0 does not mute the fact that the
    // world is sick either. See the routing note in `_build`.
    if (this.voidGain) {
      // 2.0s time constant lands in the same felt window as the visual
      // GRADE_BLEND — the world sickens in one motion, not two.
      this.voidGain.gain.setTargetAtTime(voidLayerGain(ctx.corruption?.band), ac.currentTime, 2.0);
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Name-based dispatcher for callers that would rather not know the catalogue.
   * Unknown names fall through to a neutral UI blip instead of throwing, so a
   * typo in gameplay code is a wrong sound, never a crash mid-fight.
   */
  play(name, pos, arg) {
    switch (name) {
      case 'shoot': return this.shoot(pos, arg ?? 1);
      case 'impact': return this.impact(pos, arg ?? 'stone');
      case 'hit': return this.hit(pos, !!arg);
      case 'explosion': return this.explosion(pos, arg ?? 4);
      case 'zap': case 'lightning': return this.zap(pos);
      case 'death': return this.death(pos, !!arg);
      case 'vocal': case 'enemyVocal': return this.enemyVocal(pos, arg ?? 'small');
      case 'footstep': return this.footstep(pos, arg ?? 'dirt');
      case 'heal': return this.heal(pos);
      case 'shieldBreak': return this.shieldBreak(pos);
      // A named tier ('legendary', 'equipment') routes through the same ladder
      // `itemPickup` uses; a number is still accepted as a raw rung.
      case 'pickup': case 'itemPickup':
        return this.pickup(typeof arg === 'string' ? (PICKUP_TIER[arg] ?? 0) : (arg ?? 0));
      case 'coin': case 'gold': return this.coin();
      case 'levelUp': return this.levelUp();
      case 'ability': return this.ability(arg ?? 0);
      case 'boss': case 'bossSpawn': return this.bossHorn();
      case 'stageStart': case 'teleporterComplete': return this.stageSting();
      case 'playerHurt': return this.playerHurt(arg ?? 0);
      case 'playerDead': return this.playerDead();
      case 'playerDowned': return this.playerDowned(pos);
      case 'playerRevived': return this.playerRevived(pos);
      // World interaction. Every name below was already being passed by
      // Interactables/RealmProps and was landing on the default case, i.e. a
      // chest, a purchase and a shrine payout all played the same UI blip.
      case 'chest': return this.chest(pos);
      case 'purchase': case 'vaultPaid': return this.purchase(pos);
      case 'shrineWin': return this.shrineWin(pos);
      case 'shrineFail': return this.shrineFail(pos);
      case 'deny': return this.deny();
      case 'shrineBlood': return this.shrineBlood(pos);
      case 'teleporterStart': return this.teleporterStart(pos);
      case 'ui': case 'uiClick': return this.uiClick(arg ?? 0);
      default: return this.uiClick(0);
    }
  }

  setSfxVolume(v) {
    this.sfxVolume = clamp(v, 0, 1);
    if (this.sfx) this.sfx.gain.setTargetAtTime(this.sfxVolume * 0.9, this.ac.currentTime, 0.05);
  }

  setMusicVolume(v) {
    this.musicVolume = clamp(v, 0, 1);
    if (this.music) this.music.gain.setTargetAtTime(this.musicVolume * MUSIC_BUS, this.ac.currentTime, 0.05);
    if (this.ambient) this.ambient.gain.setTargetAtTime(this.musicVolume * 0.4, this.ac.currentTime, 0.05);
    this._syncMusicSilence();
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.ac.currentTime, 0.03);
    }
    this._syncMusicSilence();
    return this.muted;
  }

  /**
   * Tell the sequencer whether anything can hear it. Muted or music volume 0,
   * it was still synthesising ~270 nodes a second into a gain of zero. The
   * intensity model keeps running either way, so the arrangement is in the
   * right place the moment the sound comes back.
   */
  _syncMusicSilence() {
    if (this.musicEngine) this.musicEngine.silent = this.muted || this.musicVolume <= 0;
  }

  toggleMute() { return this.setMuted(!this.muted); }

  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master && !this.muted) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.ac.currentTime, 0.05);
    }
  }
}

function makeDistortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
