// tests/run-moment-voices.test.mjs
//
// The five run-level moments of EFFECT-LANGUAGE.md §4.4 — `statusApplied`,
// `playerDowned`, `playerRevived`, `coin` and `bossHorn`. Each one is asserted
// on the property that separates it from what shipped before it, so a revert
// to the old behaviour reds this file rather than passing quietly:
//
//   * statusApplied — `freeze` and `slow` were the same element at the same
//     rate, i.e. literally the same sound. Distinctness of the rates across the
//     five named statuses is the claim, not "a sound played".
//   * playerDowned — was `playerDead`'s single tone at a lower gain. A
//     *descending figure* means strictly falling pitch across more than one
//     step, and that is what is read off the stub graph.
//   * playerRevived — reused `heal`'s three-note ladder verbatim. The two are
//     asserted to differ on the graph they build, not on the source they came
//     from.
//   * coin — the hue is a constant and `coinSpark` takes no colour parameter,
//     so there is nothing a tier could be passed into.
//   * bossHorn — was camera-local and element-blind; it now carries a position
//     and an element, derived from the boss the event names.
//
// Falsification, run by hand before this file was committed: restoring the old
// `statusVoice` element/rate ladder reds the freeze/slow case; deleting the
// `elementTransient` line from `bossHorn` reds the boss cases; pointing
// `playerRevived` back at `heal` reds the revive cases. Output quoted in the
// commit message.
import { Audio } from '../src/systems/Audio.js';
import { VFX } from '../src/systems/VFX.js';
import { STATUS_VOICE, statusVoiceOf, COIN_HUE, unitElement } from '../src/data/elementVoice.js';
import { FRAME } from '../src/fx/ParticleSystem.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/* ---------------------------------------------------- stub Web Audio graph */

const param = (v = 0) => ({
  value: v,
  setValueAtTime(x) { this.value = x; },
  cancelScheduledValues() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  setTargetAtTime() {},
});
const node = (kind) => {
  const n = {
    kind, out: [], onended: null,
    gain: param(), frequency: param(), Q: param(), detune: param(), playbackRate: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    starts: [], stops: [],
    connect(d) { n.out.push(d); return d; },
    disconnect() {},
    start(t) { n.starts.push(t); },
    stop(t) { n.stops.push(t); },
  };
  return n;
};
function makeAc() {
  const made = [];
  const make = (kind) => { const n = node(kind); made.push(n); return n; };
  return {
    currentTime: 10, sampleRate: 48000, made, state: 'running',
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
    oscs: () => made.filter((n) => n.kind === 'osc'),
    srcs: () => made.filter((n) => n.kind === 'src'),
  };
}
function makeAudio() {
  const a = new Audio();
  a.ac = makeAc();
  a.master = node('master');
  a.sfx = node('sfx');
  a.noiseBuf = {};
  return a;
}

/** A minimal event bus with the multi-listener behaviour the real one has. */
function makeBus() {
  const m = new Map();
  return {
    on(k, f) { (m.get(k) || m.set(k, []).get(k)).push(f); },
    emit(k, p) { for (const f of m.get(k) || []) f(p); },
    has(k) { return (m.get(k) || []).length > 0; },
  };
}

/* -------------------------------------------------- §4.4 statusApplied */

console.log('a status landing is pitched by status type');
{
  for (const s of ['burn', 'freeze', 'shock', 'slow', 'void']) {
    ok(!!STATUS_VOICE[s], `${s} has a voice`);
  }
  const rates = Object.values(STATUS_VOICE).map((v) => v.rate);
  ok(new Set(rates).size === rates.length,
    `every status in the table sits on its own rate (${rates.join(', ')})`);
  // The specific pair that used to collide: same recipe, and before this change
  // the same rate, which made them the same sound.
  ok(statusVoiceOf('freeze').element === statusVoiceOf('slow').element,
    'freeze and slow share ice, as the language says they should');
  ok(statusVoiceOf('freeze').rate !== statusVoiceOf('slow').rate,
    'and are still told apart by pitch');
  ok(statusVoiceOf('nonesuch').element === 'kinetic', 'an unnamed status falls back to kinetic');
}

console.log('every status renders to audio nothing else in the table renders to');
{
  // The claim under test is about *rendered* parameters, not about the numbers
  // in the table, and it covers all seven statuses rather than a chosen five.
  // The first version of this asserted on a stubbed `elementTransient` and so
  // could not see that `void` (0.30) and `wither` (0.24) were being passed as a
  // gain, hit the 0.35 clamp floor, and rendered byte-identical audio. Nothing
  // is stubbed here: `statusVoice` runs down the real path onto the stub graph
  // and the fingerprint is read back off the nodes it actually built.
  const all = Object.keys(STATUS_VOICE);
  ok(all.length === 7, `the table names seven statuses (${all.join(', ')})`);

  /** Every parameter the graph actually received, as a comparable string. */
  const render = (status) => {
    const a = makeAudio();
    a.statusVoice({ x: 0, y: 0, z: 0 }, status);
    const parts = a.ac.made
      .filter((n) => n.kind === 'osc' || n.kind === 'filter' || n.kind === 'src')
      .map((n) => [
        n.kind,
        n.frequency.value,
        n.Q.value,
        n.detune.value,
        n.starts[0] ?? '',
        n.stops[0] ?? '',
      ].join(':'));
    ok(parts.length > 0, `${status} builds a real voice`);
    const osc = a.ac.made.find((n) => n.kind === 'osc');
    return {
      print: parts.join('|'),
      f: osc ? osc.frequency.value : 0,
      dur: osc ? (osc.stops[0] - osc.starts[0]) : 0,
    };
  };

  const r = new Map(all.map((s) => [s, render(s)]));
  for (const [i, s] of all.entries()) {
    for (const t of all.slice(i + 1)) {
      ok(r.get(s).print !== r.get(t).print, `${s} and ${t} are not the same sound`);
    }
  }
  ok(new Set([...r.values()].map((v) => v.print)).size === 7, 'seven statuses, seven renderings');

  // And the distinctness is in the pitch and the length, not the loudness — a
  // status landing is never louder than another status landing. Compared
  // within an element, which is where two statuses can actually collide:
  // void/wither share the void recipe and freeze/slow share ice.
  ok(r.get('wither').f < r.get('void').f,
    `wither sits below void (${r.get('wither').f.toFixed(1)} < ${r.get('void').f.toFixed(1)} Hz)`);
  ok(r.get('slow').f < r.get('freeze').f,
    `slow sits below freeze (${r.get('slow').f.toFixed(1)} < ${r.get('freeze').f.toFixed(1)} Hz)`);
  ok(r.get('wither').dur > r.get('void').dur, 'and the lower voice is the longer one');
}

console.log('statusVoice sends each status down its own element');
{
  const a = makeAudio();
  const seen = [];
  a.elementTransient = (pos, el, gain, rate) => seen.push({ el, gain, rate });
  const named = Object.keys(STATUS_VOICE);
  for (const s of named) a.statusVoice({ x: 0, y: 0, z: 0 }, s);
  ok(seen.length === named.length, 'all of them landed (the throttle is per-status, not global)');
  ok(seen.every((v, i) => v.el === statusVoiceOf(named[i]).element), 'each in its own element');
  ok(new Set(seen.map((v) => v.gain)).size === 1, 'at one shared tick loudness');
  ok(new Set(seen.map((v) => v.rate)).size === named.length, 'and its own transposition');
}

console.log('a status with no overlay recipe still gets its voice');
{
  // `void` and `wither` have no entry in VFX's STATUS table, and behind the
  // old `!s` return their applications were completely silent.
  const self = Object.create(VFX.prototype);
  self._statuses = new Map();
  const heard = [];
  self.ctx = { audio: { statusVoice: (p, t) => heard.push(t) } };
  self._ep = () => ({ position: { copy() {} }, dir: { set() {} }, color0: { set() {} }, color1: { set() {} } });
  self.particles = { emit() {} };
  const t = { alive: true, position: { x: 0, y: 0, z: 0 }, height: 1.6, radius: 0.5 };
  self.status(t, 'void', 0xff5fd0);
  ok(heard.includes('void'), 'a void application is voiced despite having no overlay');
  self.status(t, 'burn', 0xff6a10);
  ok(heard.includes('burn'), 'and an overlaid status is still voiced');
}

/* --------------------------------------------------- §4.4 playerDowned */

console.log('downing a player is a descending figure, not one fading tone');
{
  const a = makeAudio();
  a.playerDowned({ x: 0, y: 0, z: 0 });
  const f = a.ac.oscs().map((o) => o.frequency.value);
  // The marker's own two tones are in here as well, so the claim is about the
  // fall: at least three steps, each strictly below the one before it.
  const fall = f.slice(0, 3);
  ok(fall.length === 3, 'the figure is three steps, not one');
  ok(fall[0] > fall[1] && fall[1] > fall[2],
    `and every step is below the last (${fall.map((x) => x.toFixed(1)).join(' > ')})`);
}

console.log('the held body marker is a real sustained voice');
{
  const a = makeAudio();
  const owner = { alive: true, netId: 1 };
  ok(a.downedMarkerCount === 0, 'idle mixer holds no marker');
  a.playerDowned({ x: 3, y: 0, z: 4 }, owner);
  const first = a._downedMarkers.get(1);
  ok(!!first && first.active === true, 'downing starts one');
  ok(a.priorityVoices > 0, 'and it is charged against the budget while it is held');
  // Re-downing the same owner replaces that owner's handle rather than
  // stranding it. (Two *different* owners keeping two markers is
  // `tests/downed-marker-release.test.mjs`.)
  a.playerDowned({ x: 9, y: 0, z: 9 }, owner);
  ok(a._downedMarkers.get(1) !== first, 'a second down replaces the handle');
  ok(first.active === false, 'and releases the first rather than stranding it');
}

/* --------------------------------------------------- §4.4 playerRevived */

console.log('revival has its own voice, not heal’s ladder');
{
  const heal = makeAudio(); heal.heal({ x: 0, y: 0, z: 0 });
  const rev = makeAudio(); rev.playerRevived({ x: 0, y: 0, z: 0 });

  const healOsc = heal.ac.oscs(), revOsc = rev.ac.oscs();
  ok(healOsc.length === 3, 'heal is three rungs');
  ok(revOsc.length > healOsc.length, `revive is a wider chord (${revOsc.length} voices)`);

  // Lattice, not ladder: heal walks its notes 50 ms apart, revive strikes its
  // chord as one event.
  const healStarts = new Set(healOsc.map((o) => o.starts[0]));
  const chord = revOsc.slice(0, 4).map((o) => o.starts[0]);
  ok(healStarts.size === 3, 'heal staggers every rung');
  ok(new Set(chord).size === 1, 'revive strikes its lattice together');

  // Expanding: heal has no noise bed at all, revive opens one upward.
  ok(heal.ac.srcs().length === 0, 'heal has no bed');
  ok(rev.ac.srcs().length > 0, 'revive has one');
}

/* ----------------------------------------------------------- §4.4 coin */

console.log('the coin colour is fixed, with nothing to pass a tier into');
{
  ok(COIN_HUE === 0xffc46a, 'COIN_HUE is the amber-warm constant');
  ok(VFX.prototype.coinSpark.length === 1, 'coinSpark takes a position and no colour');

  const self = Object.create(VFX.prototype);
  const emitted = [];
  self._ep = () => ({
    position: { x: 0, y: 0, z: 0, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } },
    dir: { set() {} },
    color0: { set(v) { this.v = v; } },
    color1: { set(v) { this.v = v; } },
  });
  self.particles = { emit: (e) => emitted.push(e) };
  self.coinSpark({ x: 1, y: 0, z: 2 });
  ok(emitted.length === 1, 'one spark');
  ok(emitted[0].color1.v === COIN_HUE, 'in the fixed coin hue');
  ok(emitted[0].color0.v === 0xffffff, 'over a white-hot core (§1.2 player polarity)');
  ok(emitted[0].dir && emitted[0].speed > 0 && emitted[0].frame === FRAME.SPARK, 'and it rises');
  // Nothing derived from a tier reaches this effect: the only inputs are the
  // position and the module constant.
  self.coinSpark({ x: 1, y: 0, z: 2 }, 0x00ff00);
  ok(emitted[1].color1.v === COIN_HUE, 'a colour argument, if anyone invents one, is ignored');
}

/* ------------------------------------------------------- §4.4 bossHorn */

console.log('a boss arrival comes from somewhere, in its own element');
{
  const a = makeAudio();
  const seen = [];
  a.elementTransient = (pos, el, rate) => seen.push({ pos, el, rate });
  a.bossHorn({ x: 20, y: 0, z: 5 }, 'void');
  ok(seen.length === 1, 'the horn carries an elemental onset');
  ok(seen[0].el === 'void' && seen[0].pos.x === 20, 'in the boss element, at the spawn point');
  ok(seen[0].rate < 1, `at heavy intensity (rate ${seen[0].rate})`);

  const b = makeAudio();
  const none = [];
  b.elementTransient = (...v) => none.push(v);
  b.bossHorn();
  ok(none.length === 0, 'a placeless horn adds nothing to the world');
}

console.log('the element the horn and the ring name is the same element');
{
  const boss = { position: { x: 1, y: 0, z: 2 }, def: { attacks: [{ element: 'fire' }] } };
  ok(unitElement(boss) === 'fire', 'a unit takes the element of the attack it opens with');
  ok(unitElement({ def: { attacks: [], color: 0xff5fd0 } }) === 'void',
    'a unit with no attacks falls back to its own colour');
  ok(unitElement(null) === 'kinetic', 'and nothing at all is kinetic');

  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  const a = makeAudio();
  const seen = [];
  a.elementTransient = (pos, el) => seen.push({ pos, el });
  a.init({ events: makeBus(), player: null });
  a.ctx.events.emit('bossSpawn', { enemy: boss });
  ok(seen.length === 1 && seen[0].el === 'fire' && seen[0].pos.x === 1,
    'the bossSpawn binding derives both from the enemy it names');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
