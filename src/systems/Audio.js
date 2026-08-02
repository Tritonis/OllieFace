import * as THREE from 'three';
import { clamp } from '../core/MathUtil.js';
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
 *   voices -> sfx / music / ambient buses -> master -> limiter -> destination
 *
 * The limiter is not optional: forty simultaneous explosion sub-thumps will
 * clip a raw sum into digital distortion. The voice cap exists for the same
 * reason one layer up — past ~28 concurrent voices nothing is audible anyway,
 * so new hits steal from the oldest rather than piling on.
 *
 * The soundtrack lives in Music.js and owns everything downstream of the
 * `music` bus, including its own voice accounting: the sequencer is
 * deliberately outside MAX_VOICES, because a cap that works by refusing new
 * sounds must never be allowed to refuse the downbeat. See MusicEngine._count.
 */

const MAX_VOICES = 28;

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
    this.intensity = 0;

    this._throttles = new Map();
    this._variants = new Map();
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
    // "feels" to the soundtrack — a swing at a lone beetle should not lift the
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
    e.on('itemPickup', (p) => this.pickup(p?.tier ?? 0));
    e.on('goldChanged', () => this.coin());
    e.on('abilityUsed', (p) => this.ability(p?.slot ?? 0));
    e.on('levelUp', () => this.musicEngine?.bump(0.22));
    e.on('stageStart', () => {
      this.stageSting();
      // A new stage starts empty. Carrying the last fight's heat across the
      // teleport left the track at full tilt over an empty arena.
      this.musicEngine?.cool();
    });
    e.on('bossSpawn', () => { this.bossHorn(); this.musicEngine?.bump(0.7); });
    e.on('teleporterComplete', () => this.stageSting());
    e.on('playerDead', () => this.playerDead());
  }

  /* ------------------------------------------------------------------ */
  /* Graph setup                                                         */
  /* ------------------------------------------------------------------ */

  _ensure() {
    if (this.ac) {
      if (this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    const ac = new AC({ latencyHint: 'interactive' });
    this.ac = ac;

    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 2;
    limiter.ratio.value = 18;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    limiter.connect(ac.destination);
    this.limiter = limiter;

    const master = ac.createGain();
    master.gain.value = this.muted ? 0 : this.masterVolume;
    master.connect(limiter);
    this.master = master;

    this.sfx = ac.createGain();
    this.sfx.gain.value = this.sfxVolume * 0.9;
    this.sfx.connect(master);

    this.music = ac.createGain();
    this.music.gain.value = this.musicVolume * 0.32;
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
   * Voice cap check. Counting happens per source node in _release, not here —
   * one "sound" is three or four nodes, and charging it as one would let fifty
   * simultaneous explosions through the gate.
   */
  _take() {
    return this.voices < MAX_VOICES;
  }

  _release(node) {
    this.voices++;
    node.onended = () => { this.voices = Math.max(0, this.voices - 1); };
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
    if (!ac || !this._take()) return;
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
    if (!this._take()) return;
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
    if (!this._take()) return;
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
    if (!ac || !this._take()) return;
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
    if (!this._throttle('zap', 0.05) || !this._take()) return;
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
    if (!this._throttle('vocal', 0.12) || !this._take()) return;
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
    if (!this._take()) return;
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
    if (!this._throttle('step', 0.12) || !this._take()) return;
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
    if (!ac || !this._take()) return;
    const t = ac.currentTime;
    const sev = clamp(amount / 40, 0.3, 1.4);
    this._noise(t, 0.22, { type: 'lowpass', freq: 1400, freqEnd: 240, q: 0.8, gain: 0.5 * sev, attack: 0.002 });
    this._tone(t, 0.3, { type: 'sine', f0: 140, f1: 42, gain: 0.55 * sev, attack: 0.003 });
    this._tone(t, 0.18, { type: 'square', f0: 320, f1: 90, gain: 0.13 * sev });
    // Duck the music briefly so the hit reads even in a loud fight.
    if (this.music) {
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setValueAtTime(this.music.gain.value, t);
      this.music.gain.linearRampToValueAtTime(this.musicVolume * 0.1, t + 0.03);
      this.music.gain.linearRampToValueAtTime(this.musicVolume * 0.32, t + 0.7);
    }
  }

  playerDead() {
    const ac = this._ensure();
    if (!ac) return;
    const t = ac.currentTime;
    this._musicOff = true;
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

  heal(pos) {
    const ac = this._ensure();
    if (!ac || !this._take()) return;
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
    if (!ac || !this._take()) return;
    const t = ac.currentTime;
    const out = this._out(pos, 8);
    this._noise(t, 0.35, { type: 'highpass', freq: 3200, gain: 0.4, out, attack: 0.001 });
    this._tone(t, 0.25, { type: 'triangle', f0: 1200, f1: 300, gain: 0.22, out });
    this._tone(t, 0.4, { type: 'sine', f0: 90, f1: 40, gain: 0.35, out });
  }

  /** Rising arpeggio; higher tiers start higher and add a shimmer tail. */
  pickup(tier = 0) {
    const ac = this._ensure();
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac || !this._take()) return;
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
    if (!ac) return;
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
    if (!ac) return;
    const t = ac.currentTime;
    for (let i = 0; i < 4; i++) {
      this._tone(t + i * 0.09, 0.7, {
        type: 'triangle', f0: ROOT * 2 * Math.pow(2, SCALE[i * 2] / 12), gain: 0.14, attack: 0.01,
      });
    }
    this._tone(t, 1.2, { type: 'sine', f0: ROOT * 0.5, gain: 0.3, attack: 0.05 });
  }

  uiClick(kind = 0) {
    const ac = this._ensure();
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac) return;
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
    if (!ac) return;
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
      case 'pickup': case 'itemPickup': return this.pickup(arg ?? 0);
      case 'coin': case 'gold': return this.coin();
      case 'levelUp': return this.levelUp();
      case 'ability': return this.ability(arg ?? 0);
      case 'boss': case 'bossSpawn': return this.bossHorn();
      case 'stageStart': case 'teleporterComplete': return this.stageSting();
      case 'playerHurt': return this.playerHurt(arg ?? 0);
      case 'playerDead': return this.playerDead();
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
    if (this.music) this.music.gain.setTargetAtTime(this.musicVolume * 0.32, this.ac.currentTime, 0.05);
    if (this.ambient) this.ambient.gain.setTargetAtTime(this.musicVolume * 0.4, this.ac.currentTime, 0.05);
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.ac.currentTime, 0.03);
    }
    return this.muted;
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
