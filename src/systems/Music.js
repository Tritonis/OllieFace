import { clamp, lerp } from '../core/MathUtil.js';

/**
 * The soundtrack: a ramping techno engine built entirely from oscillators,
 * noise and biquads, driven by a lookahead 16th-note sequencer.
 *
 * It lives apart from Audio.js because almost nothing is shared with the SFX
 * catalogue. The music has its own bus topology (a sidechain stage the SFX path
 * has no use for), its own voice budget deliberately exempt from the SFX cap,
 * its own note primitives whose envelopes are tuned for repetition at 140bpm
 * rather than for one-shot impact, and its own intensity model. Bolting all of
 * that onto Audio.js meant a thousand-line file where two unrelated state
 * machines shared a namespace and nothing else.
 *
 * Signal flow:
 *
 *     kick ─────────────────────────────────────┐
 *     sub/pad/bass/hats/clap/acid/lead ─ duck ───┴─ bus(music) ─ master
 *
 * The kick bypasses `duck` on purpose: `duck` is the sidechain compressor
 * stand-in, and a kick that ducked itself would swallow its own transient.
 * Every kick writes an explicit gain dip + release into `duck.gain`, which is
 * where the pumping comes from. That pump is not decoration — a four-on-the-
 * floor kit with a static bed under it reads as "drum loop", and the same kit
 * breathing on the kick reads as techno. Explicit automation rather than a
 * DynamicsCompressor fed by a sidechain: WebAudio has no sidechain input, so
 * the compressor version has to be keyed off an audible LFO hack whose depth
 * drifts with programme level. Automation is sample-exact and free.
 */

// A minor pentatonic, same tonality as the SFX layer so a pickup jingle can
// never clash with whatever the sequencer is doing underneath it.
const ROOT = 110; // A2

// Bar roots over an 8-bar loop, in semitones from ROOT. Techno lives on a
// static root; the movement at bars 5-8 exists only so a long fight does not
// feel like one chord held for four minutes.
const BAR_ROOTS = [0, 0, 0, 0, 10, 10, 3, 3];

/**
 * Layer table: [name, enter, band, maxGain].
 *
 * `enter` is where a layer starts fading in and `band` how much intensity it
 * takes to reach full. Overlapping bands rather than thresholds is what keeps
 * a layer from clicking in — but the fade is only half of it, see _onBar for
 * the bar-quantised part.
 *
 * `sub` and `pad` have a negative `enter` so they are already partly up at
 * intensity 0 — they are the bed, and a bed that fades to silence leaves the
 * calm parts of a run with no soundtrack at all.
 *
 * The order is the arrangement: at intensity 0 the track is a sub pulse and a
 * pad and nothing else, which is what the first minute of a run should sound
 * like. The kit assembles from the bottom up as the run heats.
 */
const LAYERS = [
  ['sub',    -0.06, 0.10, 0.85],
  ['pad',    -0.08, 0.14, 0.75],
  ['kick',    0.13, 0.12, 1.00],
  ['hat',     0.24, 0.14, 0.62],
  ['bass',    0.31, 0.14, 0.90],
  ['openhat', 0.45, 0.12, 0.50],
  ['clap',    0.52, 0.12, 0.62],
  ['perc',    0.64, 0.12, 0.42],
  ['acid',    0.70, 0.14, 0.55],
  ['lead',    0.86, 0.12, 0.45],
];

// Layers whose arrival is a structural event rather than a texture change.
// Only these get a riser and a downbeat impact; doing it for the hats too
// would mean a whoosh every few bars, which stops reading as a transition.
const MAJOR = new Set(['kick', 'bass', 'clap', 'acid', 'lead']);

// Offbeat-eighth bassline with movement in the back half of the bar. `null` is
// a rest; numbers are semitones from the bar root. A root-only pulse is what
// the previous engine had and it is the single biggest reason it read as
// "generic procedural" — a bassline has to go somewhere.
const BASS_PATTERN = [
  null, null, 0, null,
  null, null, 0, null,
  null, null, 0, null,
  null, 0, null, -5,
];

// 303-ish line: `n` semitones from root, `a` accent (opens the filter and adds
// gain), `s` slide (glides from the previous note instead of restriking).
const ACID_PATTERN = [
  { n: 0, a: 1, s: 0 }, { n: 0, a: 0, s: 0 }, { n: 12, a: 0, s: 0 }, { n: 0, a: 0, s: 1 },
  { n: 3, a: 1, s: 0 }, { n: 0, a: 0, s: 0 }, { n: 10, a: 0, s: 0 }, { n: 0, a: 0, s: 1 },
  { n: 0, a: 1, s: 0 }, { n: 7, a: 0, s: 0 }, { n: 0, a: 0, s: 1 }, { n: 12, a: 0, s: 0 },
  { n: 3, a: 1, s: 0 }, { n: 0, a: 0, s: 0 }, { n: 5, a: 0, s: 0 }, { n: 10, a: 1, s: 0 },
];

// Closed-hat velocity per 16th. The accent on the "&" (steps 2/6/10/14) is the
// groove; a flat 16th roll is a metronome.
const HAT_VEL = [
  0.34, 0.14, 0.58, 0.16,
  0.34, 0.14, 0.58, 0.20,
  0.34, 0.14, 0.58, 0.16,
  0.38, 0.18, 0.62, 0.30,
];

const LOOKAHEAD = 0.25;

export class MusicEngine {
  /**
   * @param {AudioContext} ac
   * @param {GainNode} bus  the shared music bus (volume + the playerHurt duck)
   * @param {AudioBuffer} noiseBuf shared 2s white-noise buffer
   */
  constructor(ac, bus, noiseBuf) {
    this.ac = ac;
    this.bus = bus;
    this.noiseBuf = noiseBuf;
    this.stopped = false;

    // --- intensity model ---------------------------------------------------
    // Two inputs, deliberately different time constants. `arc` is the run's
    // slow build off the director's difficulty coefficient — minutes. `heat`
    // and the proximity/objective terms are combat pressure — seconds. A run
    // that only had `arc` climbed monotonically and never reacted to anything
    // the player did, which made the music feel like a timer rather than a
    // score.
    this.arc = 0;
    this.pressure = 0;
    this._heat = 0;
    this._sustain = 0;
    this._scanT = 0;
    this._runT = 0;
    this.intensity = 0;
    this.bpm = 118;

    // --- diagnostics (read by tools/_musicprobe) ---------------------------
    this.stepsEmitted = 0;
    this.voices = 0;

    // --- sequencer ---------------------------------------------------------
    this._musicTime = ac.currentTime + 0.15;
    this._step = 0;
    this._bar = 0;
    this._acidPrev = ROOT;
    // Layer levels are committed one bar at a time. `_pending` holds a
    // commitment deferred by a bar so a riser has somewhere to live.
    this._pending = null;

    this._build();
  }

  _build() {
    const ac = this.ac;

    // Sidechain stage. Sits at 1 and gets stamped down by every kick.
    this.duck = ac.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.bus);

    this.layers = new Map();
    for (const [name, enter, band, max] of LAYERS) {
      const g = ac.createGain();
      g.gain.value = 0;
      // The kick is the sidechain key, so it must not pass through the node it
      // is modulating. Everything else does.
      g.connect(name === 'kick' ? this.bus : this.duck);
      this.layers.set(name, { name, enter, band, max, g, cur: 0, target: 0 });
    }

    // The acid voice is one persistent filter rather than one per note: a Q of
    // 14 rung by 16 fresh filters a bar produces a different resonant tail on
    // every note, which is exactly the smear a 303 does not have. One filter
    // with a per-note envelope is the real topology.
    this.acidFilter = ac.createBiquadFilter();
    this.acidFilter.type = 'lowpass';
    this.acidFilter.frequency.value = 400;
    this.acidFilter.Q.value = 13;
    this.acidFilter.connect(this.layers.get('acid').g);
  }

  /* ------------------------------------------------------------------ */
  /* Intensity                                                           */
  /* ------------------------------------------------------------------ */

  /** Impulse from a gameplay event. Decays; see `update`. */
  bump(amount) {
    this._heat = clamp(this._heat + amount, 0, 1.4);
  }

  /**
   * Dump the fast term. A stage change teleports the player into an empty
   * arena, and carrying the last fight's heat across left the track at full
   * tilt over nothing for the ~15s the release curve takes to bleed off.
   */
  cool() {
    this._heat = 0;
    this._sustain = 0;
    this.pressure *= 0.3;
  }

  update(ctx, dt) {
    if (this.stopped) return;
    // `dt` is real frame time and this runs while paused too, so a long pause
    // must not integrate a huge decay step in one go.
    const d = Math.min(dt, 0.1);
    this._runT += d;

    this.arc = clamp(((ctx.director?.difficultyCoefficient ?? 1) - 1) / 5, 0, 1);

    // Sustained pressure: things that are true right now rather than things
    // that just happened. Rescanned at 4Hz — the enemy list can be sixty deep
    // and this is a distance check per entry that nothing else needs.
    this._scanT -= d;
    if (this._scanT <= 0) {
      this._scanT = 0.25;
      this._sustain = this._scanSustain(ctx);
    }

    this._heat = Math.max(0, this._heat - this._heat * (1 - Math.exp(-d / 3.5)));
    const target = clamp(this._sustain + this._heat, 0, 1);
    // Fast attack, slow release: a fight should lift the track within about a
    // bar, and a lull should take several seconds to drop it back. Symmetric
    // smoothing made the music flutter every time an enemy died.
    const tau = target > this.pressure ? 0.45 : 5.0;
    this.pressure += (target - this.pressure) * (1 - Math.exp(-d / tau));

    // Blend, not max. Pressure lifts into whatever headroom `arc` has left, so
    // a fight early in a run is a big change and the same fight at difficulty
    // "HAHAHA" barely moves the needle — which is correct, it is already loud.
    let I = this.arc + (1 - this.arc) * this.pressure * 0.7;

    // Opening ceiling. The director's coefficient does climb from 1 on its
    // own, but not fast enough to stop a busy first thirty seconds from
    // assembling most of the kit. The brief is explicit that the run should
    // open sparse, so the first minute gets a ceiling that relaxes with time
    // rather than with difficulty.
    I = Math.min(I, 0.10 + this._runT / 60 * 0.70);

    this.intensity = clamp(I, 0, 1);
    this.bpm = lerp(118, 142, this.intensity);

    this._schedule();
  }

  _scanSustain(ctx) {
    const p = ctx.player?.position;
    const dir = ctx.director;
    let s = 0;
    if (p && dir?.enemies) {
      let near = 0;
      for (const e of dir.enemies) {
        if (!e.alive || !e.position) continue;
        const dx = e.position.x - p.x, dz = e.position.z - p.z;
        if (dx * dx + dz * dz < 2025) near++; // 45u radius
      }
      s = Math.min(near / 7, 1) * 0.58;
    }
    // A boss or a charging teleporter is a floor, not an addend: those are
    // set-pieces and the track should sit high for their whole duration even
    // if the arena momentarily empties out.
    if (dir?.boss?.alive) s = Math.max(s, 0.72);
    if (ctx.progression?.state === 'charging') s = Math.max(s, 0.76);
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Sequencer                                                           */
  /* ------------------------------------------------------------------ */

  _schedule() {
    const ac = this.ac;
    const stepDur = 60 / this.bpm / 4; // 16th notes

    // Resync guard.
    //
    // `_musicTime` is a wall-clock cursor advanced once per frame, so anything
    // that stops frames advancing — a shader-compile stall, a backgrounded tab
    // (where rAF stops entirely), a long GC — leaves it behind `currentTime` by
    // however long the gap was. Without this, the loop below then emits the
    // whole backlog at timestamps already in the past, and WebAudio fires every
    // one of them *immediately*: a second of missed sequencer steps arrives as
    // a single garbled cluster, which then blows the voice budget and drops the
    // notes that follow. That burst-then-stumble is what "the music slips"
    // sounds like, and a tab switch alone is enough to cause it.
    //
    // Missed steps are simply gone rather than replayed — a bar the player
    // never heard is not owed to them, and the pulse matters more than the
    // phase. Restarting on a bar boundary keeps layer commits aligned.
    if (this._musicTime < ac.currentTime) {
      this._musicTime = ac.currentTime + 0.02;
      this._step = 0;
      this._bar = 0;
    }

    while (this._musicTime < ac.currentTime + LOOKAHEAD) {
      const t = this._musicTime;
      if (this._step % 16 === 0) this._onBar(t, stepDur);
      this._emit(t, stepDur);
      this.stepsEmitted++;
      this._musicTime += stepDur;
      this._step++;
      if (this._step % 16 === 0) this._bar++;
    }
  }

  /**
   * Bar boundary: the only place layer levels change.
   *
   * Ramping alone is not enough to make an entry sound intentional — a hat
   * fading in over the middle of a bar arrives on a random 16th and sounds
   * like a fault. Quantising every commit to the downbeat, and ramping across
   * half a bar from there, is what makes the build read as an arrangement.
   */
  _onBar(t, stepDur) {
    const bar = 16 * stepDur;

    // A deferred commit from last bar (we spent that bar on a riser).
    if (this._pending) {
      this._apply(this._pending, t, bar * 0.5);
      this._impact(t);
      this._pending = null;
      return;
    }

    const next = new Map();
    let entering = null;
    let leaving = false;
    for (const L of this.layers.values()) {
      const v = clamp((this.intensity - L.enter) / L.band, 0, 1) * L.max;
      next.set(L.name, v);
      if (MAJOR.has(L.name)) {
        if (v > 0 && L.target === 0) entering = L.name;
        else if (v === 0 && L.target > 0) leaving = true;
      }
    }

    if (entering) {
      // Spend this bar on a riser and land the new layer on the next downbeat.
      this._riser(t, bar);
      this._pending = next;
      return;
    }
    if (leaving) this._downlifter(t, bar);
    this._apply(next, t, bar * 0.5);
  }

  _apply(levels, t, ramp) {
    for (const L of this.layers.values()) {
      const v = levels.get(L.name);
      if (v === L.target) continue;
      L.g.gain.setValueAtTime(L.cur, t);
      L.g.gain.linearRampToValueAtTime(v, t + ramp);
      L.target = v;
      L.cur = v;
    }
  }

  /** True while a layer is audible, including its fade-out tail. */
  _on(name) {
    const L = this.layers.get(name);
    return L.target > 0 || L.cur > 0;
  }

  _emit(t, stepDur) {
    const s = this._step % 16;
    const bar = this._bar;
    const I = this.intensity;
    const root = ROOT * Math.pow(2, BAR_ROOTS[bar % 8] / 12);

    // --- kick: four on the floor, and the sidechain key -------------------
    if (this._on('kick') && s % 4 === 0) {
      this._kick(t, stepDur);
    } else if (!this._on('kick') && this._on('sub') && (s === 0 || s === 8)) {
      // Before the kick exists the sub pulse is the only pulse, and it is half
      // time. This is the "low and slow" opening: two soft thumps a bar.
      const g = this.layers.get('sub').g;
      this._osc(t, 0.5, { type: 'sine', f0: root * 0.5, gain: 0.5, out: g, attack: 0.02 });
      this._osc(t, 0.34, { type: 'triangle', f0: root * 0.25, gain: 0.34, out: g, attack: 0.03 });
    } else if (this._on('kick') && this._on('sub') && s === 14 && bar % 2 === 1) {
      // Once the kick is in, `sub` becomes a pickup note into the next bar.
      const g = this.layers.get('sub').g;
      this._osc(t, 0.16, { type: 'sine', f0: root * 0.5, f1: root * 0.25, gain: 0.4, out: g });
    }

    // --- pad: one sustained chord a bar -----------------------------------
    if (this._on('pad') && s === 0) {
      const g = this.layers.get('pad').g;
      const dur = 16 * stepDur * 0.95;
      for (const iv of [0, 3, 7, 12]) {
        this._osc(t, dur, {
          type: 'sawtooth', f0: root * Math.pow(2, iv / 12), gain: 0.075,
          out: g, attack: dur * 0.3, detune: (iv % 5) * 6 - 6,
        });
      }
    }

    // --- closed hats -------------------------------------------------------
    // 8ths until the track can carry a 16th roll; the roll is most of what
    // makes the tempo feel like it doubled without the BPM moving.
    if (this._on('hat') && (I > 0.55 ? true : s % 2 === 0)) {
      this._noise(t, 0.028 + HAT_VEL[s] * 0.02, {
        type: 'highpass', freq: 8200, q: 0.8,
        gain: HAT_VEL[s], out: this.layers.get('hat').g, attack: 0.0006,
      });
    }

    // --- open hat on the offbeat ------------------------------------------
    if (this._on('openhat') && s % 4 === 2) {
      this._noise(t, 0.16, {
        type: 'bandpass', freq: 9000, freqEnd: 6200, q: 0.7,
        gain: 0.5, out: this.layers.get('openhat').g, attack: 0.001,
      });
    }

    // --- clap on 2 and 4 ---------------------------------------------------
    if (this._on('clap') && (s === 4 || s === 12)) {
      this._clap(t);
    }

    // --- bass --------------------------------------------------------------
    if (this._on('bass')) {
      const n = BASS_PATTERN[s];
      if (n !== null) {
        const g = this.layers.get('bass').g;
        const f = root * 0.5 * Math.pow(2, n / 12);
        // Saw for the bite plus a sine an octave down for the weight. The saw
        // alone disappears the moment the kick lands; the sine alone is mud.
        this._osc(t, 0.2, { type: 'sawtooth', f0: f, gain: 0.28, out: g, attack: 0.004 });
        this._osc(t, 0.26, { type: 'sine', f0: f * 0.5, gain: 0.45, out: g, attack: 0.006 });
      }
    }

    // --- perc: a dry metallic tick that gives the 4th 16th somewhere to sit -
    if (this._on('perc') && (s === 7 || (s === 15 && bar % 2 === 0))) {
      const g = this.layers.get('perc').g;
      this._noise(t, 0.07, {
        type: 'bandpass', freq: 3200 + (bar % 3) * 700, q: 6, gain: 0.5, out: g, attack: 0.001,
      });
      this._osc(t, 0.05, { type: 'square', f0: 1450, f1: 900, gain: 0.1, out: g, attack: 0.001 });
    }

    // --- acid --------------------------------------------------------------
    if (this._on('acid')) {
      this._acid(t, stepDur, ACID_PATTERN[s], root, I);
    }

    // --- lead stabs --------------------------------------------------------
    if (this._on('lead') && (s === 0 || s === 10) && bar % 2 === 1) {
      const g = this.layers.get('lead').g;
      for (const iv of [0, 7, 12]) {
        this._osc(t, 0.26, {
          type: 'sawtooth', f0: root * 2 * Math.pow(2, iv / 12),
          gain: 0.12, out: g, attack: 0.004, detune: iv === 7 ? 9 : -7,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Voices                                                              */
  /* ------------------------------------------------------------------ */

  _kick(t, stepDur) {
    const g = this.layers.get('kick').g;
    // Pitch drop 165 -> 46 in 60ms is the whole character: any slower and it
    // is a tom, any faster and the attack has no pitch at all.
    this._osc(t, 0.36, { type: 'sine', f0: 165, f1: 46, gain: 0.95, out: g, attack: 0.001 });
    this._osc(t, 0.06, { type: 'triangle', f0: 320, f1: 90, gain: 0.28, out: g, attack: 0.0006 });
    this._noise(t, 0.012, { type: 'highpass', freq: 2400, gain: 0.22, out: g, attack: 0.0005 });

    // Sidechain. Depth grows with intensity so the pump arrives with the rest
    // of the kit instead of being a fixed effect on a two-layer intro.
    const depth = 0.22 + 0.44 * this.intensity;
    // Release is capped below one beat: overlapping ducks would fight, and the
    // gain would never make it back to unity between kicks. That cap is why no
    // cancelScheduledValues is needed here — the automation curves never touch.
    const rel = Math.min(4 * stepDur * 0.86, 0.32);
    const p = this.duck.gain;
    p.setValueAtTime(1 - depth, t);
    p.exponentialRampToValueAtTime(1, t + rel);
  }

  _clap(t) {
    const g = this.layers.get('clap').g;
    // Three taps 9ms apart then the body. A single burst is a snare; the
    // stutter is what makes ears hear "hands".
    for (let i = 0; i < 3; i++) {
      this._noise(t + i * 0.009, 0.02, {
        type: 'bandpass', freq: 1500, q: 1.1, gain: 0.35, out: g, attack: 0.0005,
      });
    }
    this._noise(t + 0.027, 0.17, {
      type: 'bandpass', freq: 1900, freqEnd: 1100, q: 0.9, gain: 0.5, out: g, attack: 0.001,
    });
  }

  _acid(t, stepDur, note, root, I) {
    const g = this.layers.get('acid').g;
    const f = root * 2 * Math.pow(2, note.n / 12);
    const dur = stepDur * (note.s ? 1.9 : 0.92);

    const o = this.ac.createOscillator();
    o.type = 'sawtooth';
    if (note.s) {
      // Slide: portamento from wherever the last note was. The 303's glide is
      // a fixed ~60ms regardless of interval.
      o.frequency.setValueAtTime(this._acidPrev, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    } else {
      o.frequency.setValueAtTime(f, t);
    }
    this._acidPrev = f;

    const amp = this.ac.createGain();
    const peak = note.a ? 0.34 : 0.2;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(amp).connect(this.acidFilter);
    o.start(t);
    o.stop(t + dur + 0.02);
    this._count(o);

    // Filter envelope on the shared filter. Cutoff floor rises with intensity
    // so the line opens up across the run rather than being one static timbre.
    const base = 280 + I * 900;
    const top = Math.min(base * (note.a ? 7 : 3.6), 7000);
    const fp = this.acidFilter.frequency;
    fp.setValueAtTime(top, t);
    fp.exponentialRampToValueAtTime(base, t + Math.max(0.05, dur * 0.8));
  }

  /**
   * Rising noise + saw sweep across one bar, landing on the next downbeat.
   * Scheduled a bar early because we only learn a layer is entering at a bar
   * boundary; see `_onBar`.
   */
  _riser(t, bar) {
    const out = this.duck;
    const n = this.ac.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    const f = this.ac.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + bar);
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + bar * 0.96);
    g.gain.exponentialRampToValueAtTime(0.0001, t + bar * 1.02);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random());
    n.stop(t + bar * 1.05);
    this._count(n);

    this._osc(t, bar, {
      type: 'sawtooth', f0: ROOT, f1: ROOT * 4, gain: 0.11, out, attack: bar * 0.7, curve: 'lin',
    });
  }

  /** Downward sweep when a major layer drops out, so the space is intentional. */
  _downlifter(t, bar) {
    this._noise(t, bar * 0.6, {
      type: 'bandpass', freq: 6000, freqEnd: 300, q: 1.4, gain: 0.2,
      out: this.duck, attack: 0.02,
    });
  }

  /** Downbeat impact under a landing layer. */
  _impact(t) {
    this._osc(t, 1.1, { type: 'sine', f0: 70, f1: 28, gain: 0.7, out: this.bus, attack: 0.004 });
    this._noise(t, 0.9, {
      type: 'highpass', freq: 5000, gain: 0.22, out: this.duck, attack: 0.002,
    });
  }

  /* ------------------------------------------------------------------ */

  /**
   * Music voices are counted here and NOT through Audio's `_take`/`_release`
   * pair — the music bus is explicitly exempt from MAX_VOICES.
   *
   * The cap exists to stop forty simultaneous explosion sub-thumps clipping the
   * master, and it works by refusing new sounds. Applying it to the sequencer
   * would mean a busy fight silently deletes the downbeat, which is the one
   * voice in the mix that must never be missing. The music's concurrency is
   * bounded by construction instead: the arrangement emits a known, fixed set
   * of voices per 16th, so it cannot run away the way SFX can. Measured peak
   * is 30 concurrent sources with every layer up at 142bpm, against 10 in the
   * sparse opening — a ceiling the sequencer reaches and then stays at, which
   * is the property the SFX cap exists to enforce and this does not need to.
   * `voices` here is a diagnostic only; nothing reads it to make decisions.
   */
  _count(node) {
    this.voices++;
    node.onended = () => { this.voices = Math.max(0, this.voices - 1); };
  }

  _osc(t0, dur, { type = 'sine', f0, f1, gain = 0.3, out, attack = 0.004, detune = 0, curve = 'exp' }) {
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
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    this._count(o);
    return o;
  }

  _noise(t0, dur, { type = 'bandpass', freq, freqEnd, q = 1, gain = 0.3, out, attack = 0.002 }) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t0 + dur);
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(out);
    // Random read offset so repeated hats never phase-lock into a pitch.
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.03);
    this._count(src);
    return src;
  }

  /** Levels of every layer, for diagnostics and tests. */
  levels() {
    const o = {};
    for (const L of this.layers.values()) o[L.name] = L.target;
    return o;
  }

  stop(t) {
    this.stopped = true;
    for (const L of this.layers.values()) {
      L.g.gain.cancelScheduledValues(t);
      L.g.gain.setTargetAtTime(0, t, 0.5);
      L.cur = 0;
      L.target = 0;
    }
  }
}
