import * as THREE from 'three';
import { clamp, lerp } from '../core/MathUtil.js';

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
    this._musicTime = 0;
    this._step = 0;
    this._bar = 0;
    this._shotIndex = 0;
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

    const e = ctx.events;
    e.on('damage', (p) => {
      if (!p) return;
      if (p.target?.isPlayer) return;
      this.hit(p.position || p.target?.position, p.crit);
    });
    e.on('kill', (p) => this.death(p?.position || p?.victim?.position, p?.isElite, p?.isBoss));
    e.on('playerHurt', (p) => this.playerHurt(p?.amount ?? 0));
    e.on('itemPickup', (p) => this.pickup(p?.tier ?? 0));
    e.on('goldChanged', () => this.coin());
    e.on('abilityUsed', (p) => this.ability(p?.slot ?? 0));
    e.on('stageStart', () => this.stageSting());
    e.on('bossSpawn', () => this.bossHorn());
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
    this._musicTime = ac.currentTime + 0.15;
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

    this._noise(t, 0.006, { type: 'highpass', freq: 4000 * vary, gain: 0.5 * scale, out, attack: 0.0008 });
    this._noise(t, 0.13 * scale, {
      type: 'bandpass', freq: 2600 * vary, freqEnd: 420, q: 0.9, gain: 0.55 * scale, out,
    });
    this._tone(t, 0.11 * scale, {
      type: 'triangle', f0: 320 * vary, f1: 55, gain: 0.42 * scale, out, attack: 0.001,
    });
    this._tone(t, 0.19 * scale, {
      type: 'sine', f0: 120 * vary, f1: 40, gain: 0.3 * scale, out, attack: 0.002,
    });
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

    this._noise(t, s.decay, {
      type: 'bandpass', freq: s.freq * vary, freqEnd: s.freq * 0.35, q: s.q, gain: s.gain, out,
      attack: 0.001,
    });
    this._tone(t, s.decay * 0.8, {
      type: 'triangle', f0: 180 * vary, f1: 60, gain: 0.22, out, attack: 0.001,
    });
    if (s.ring) {
      this._tone(t, 0.5, { type: 'sine', f0: 2400 * vary, gain: 0.1, out, attack: 0.002 });
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

    this._noise(t, crit ? 0.13 : 0.07, {
      type: 'bandpass', freq: (crit ? 3400 : 2100) * vary, freqEnd: 500,
      q: 1.4, gain: crit ? 0.55 : 0.36, out, attack: 0.001,
    });
    this._tone(t, crit ? 0.16 : 0.09, {
      type: 'square', f0: (crit ? 640 : 420) * vary, f1: 90,
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

    this._noise(t, 0.02, { type: 'highpass', freq: 3000, gain: 0.6, out, attack: 0.0008 });
    this._noise(t, 0.55 * s, {
      type: 'lowpass', freq: 2400, freqEnd: 180, q: 0.7, gain: 0.85, out, attack: 0.004,
    });
    this._tone(t, 0.45 * s, {
      type: 'sine', f0: 90, f1: 24, gain: 0.9, out, attack: 0.006, curve: 'exp',
    });
    this._tone(t, 0.3 * s, {
      type: 'triangle', f0: 220, f1: 45, gain: 0.35, out, attack: 0.003,
    });
    // Debris tail arriving slightly late reads as distance and scale.
    this._noise(t + 0.09, 0.9 * s, {
      type: 'bandpass', freq: 1400, freqEnd: 300, q: 0.5, gain: 0.16, out, attack: 0.05,
    });
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
    this._noise(t, 0.07, {
      type: 'bandpass', freq: s.freq * 0.6 * vary, freqEnd: s.freq * 0.22, q: 1.1, gain: 0.22, out,
      attack: 0.001,
    });
    this._tone(t, 0.06, { type: 'sine', f0: 110 * vary, f1: 55, gain: 0.16, out, attack: 0.001 });
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
    this._tone(t, 0.09, { type: 'square', f0: 1760, gain: 0.06, attack: 0.002 });
    this._tone(t + 0.03, 0.12, { type: 'square', f0: 2637, gain: 0.05, attack: 0.002 });
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
  /* Music: a lookahead step sequencer whose layers gate on difficulty    */
  /* ------------------------------------------------------------------ */

  _scheduleMusic() {
    const ac = this.ac;
    if (this._musicOff) return;
    const lookahead = 0.25;
    const d = this.ctx.director?.difficultyCoefficient ?? 1;
    this.intensity = clamp((d - 1) / 5, 0, 1);
    const bpm = lerp(88, 132, this.intensity);
    const stepDur = 60 / bpm / 4; // 16th notes

    // Resync guard.
    //
    // `_musicTime` is a wall-clock cursor advanced once per frame, so anything
    // that stops frames advancing — a shader-compile stall, a backgrounded tab
    // (where rAF stops entirely), a long GC — leaves it behind `currentTime` by
    // however long the gap was. Without this, the loop below then emits the
    // whole backlog at timestamps already in the past, and WebAudio fires every
    // one of them *immediately*: a second of missed sequencer steps arrives as
    // a single garbled cluster, which then blows the voice cap and drops the
    // notes that follow. That burst-then-stumble is what "the music slips"
    // sounds like, and a tab switch alone is enough to cause it.
    //
    // Missed steps are simply gone rather than replayed — a bar the player
    // never heard is not owed to them, and the pulse matters more than the
    // phase. Snapping to the next step boundary keeps the grid aligned.
    if (this._musicTime < ac.currentTime) {
      this._musicTime = ac.currentTime + 0.02;
      this._step = 0;
      this._bar = 0;
    }

    while (this._musicTime < ac.currentTime + lookahead) {
      this._emitStep(this._musicTime, stepDur);
      this._musicTime += stepDur;
      this._step++;
      if (this._step % 16 === 0) this._bar++;
    }
  }

  _emitStep(t, stepDur) {
    const s = this._step % 16;
    const I = this.intensity;
    const out = this.music;
    const bar = this._bar;
    // Chord root walks a 4-bar loop so the bed has somewhere to go.
    const rootStep = SCALE[[0, 0, 3, 2][bar % 4]];
    const root = ROOT * Math.pow(2, rootStep / 12);

    // --- bass pulse: always present, it is the run's heartbeat ---
    if (s === 0 || s === 6 || s === 10) {
      this._tone(t, 0.28, { type: 'triangle', f0: root * 0.5, gain: 0.22, out, attack: 0.006 });
      this._tone(t, 0.4, { type: 'sine', f0: root * 0.25, gain: 0.3, out, attack: 0.01 });
    }

    // --- kick: enters as the director starts pushing ---
    if (I > 0.08 && (s === 0 || s === 8 || (I > 0.5 && s === 11))) {
      this._tone(t, 0.16, { type: 'sine', f0: 130, f1: 42, gain: 0.55, out, attack: 0.001 });
      this._noise(t, 0.02, { type: 'lowpass', freq: 2000, gain: 0.2, out, attack: 0.001 });
    }

    // --- hats ---
    if (I > 0.2 && s % 2 === 1) {
      this._noise(t, I > 0.6 ? 0.045 : 0.03, {
        type: 'highpass', freq: 7800, gain: 0.06 + I * 0.05, out, attack: 0.001,
      });
    }

    // --- pad: sustained chord once a bar ---
    if (I > 0.25 && s === 0) {
      for (const iv of [0, 3, 7]) {
        this._tone(t, 1.6, {
          type: 'sawtooth', f0: root * Math.pow(2, iv / 12), gain: 0.05 + I * 0.04,
          out, attack: 0.35,
        });
      }
    }

    // --- arp: the "it is getting bad" layer ---
    if (I > 0.42 && s % 2 === 0) {
      const n = SCALE[(this._step * 3 + bar) % SCALE.length];
      this._tone(t, 0.16, {
        type: 'square', f0: root * 2 * Math.pow(2, n / 12), gain: 0.05 + I * 0.05,
        out, attack: 0.003,
      });
    }

    // --- snare / claps ---
    if (I > 0.6 && (s === 4 || s === 12)) {
      this._noise(t, 0.13, { type: 'highpass', freq: 1800, gain: 0.22, out, attack: 0.001 });
      this._tone(t, 0.09, { type: 'triangle', f0: 220, f1: 140, gain: 0.14, out, attack: 0.001 });
    }

    // --- lead stabs at full tilt ---
    if (I > 0.82 && s === 14) {
      const n = SCALE[(bar * 2) % SCALE.length];
      this._tone(t, 0.4, {
        type: 'sawtooth', f0: root * 4 * Math.pow(2, n / 12), gain: 0.07, out, attack: 0.004,
      });
    }
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

    this._scheduleMusic();

    // Ambient bed leans darker and louder as the run heats up.
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
