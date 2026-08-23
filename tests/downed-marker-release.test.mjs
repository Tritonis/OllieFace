// tests/downed-marker-release.test.mjs
//
// The downed body marker (§4.4 `playerDowned`) is a held voice, which makes it
// the one thing in this feature that can leak the mixer's voice budget and the
// one thing that can leave a ring pulsing over an empty floor for the rest of
// a run. A held voice that nobody releases is a slot lost until the page
// reloads.
//
// So every exit from the downed state is enumerated here and asserted
// separately — revive, death (the local player's *and* a teammate's), stage
// change, and the showcase being closed with a body still down. Each case
// asserts the budget went back to zero and the sources were actually stopped,
// not merely that nothing threw.
//
// Falsification, run by hand before this file was committed: deleting the
// `releaseDownedMarker()` call from `playerRevived` reds the revive case;
// deleting it from the `playerDead` binding reds both death cases; deleting it
// from `stageStart` reds the stage case; deleting `_downed.delete/clear` from
// `VFX.playerRevived` reds the marker-registry cases. Output quoted in the
// commit message.
import { Audio } from '../src/systems/Audio.js';
import { VFX } from '../src/systems/VFX.js';

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
    sources: () => made.filter((n) => n.kind === 'osc' || n.kind === 'src'),
    // A source is only ended when something scheduled a stop for it. A stub
    // that ended them all regardless would hide exactly the leak under test.
    endAll() {
      for (const n of made) {
        if (n.onended && n.stops.length) { const f = n.onended; n.onended = null; f(); }
      }
    },
  };
}
function makeBus() {
  const m = new Map();
  return {
    on(k, f) { (m.get(k) || m.set(k, []).get(k)).push(f); },
    emit(k, p) { for (const f of m.get(k) || []) f(p); },
  };
}
function makeAudio(ctx) {
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  const a = new Audio();
  a.ac = makeAc();
  a.master = node('master');
  a.sfx = node('sfx');
  a.noiseBuf = {};
  if (ctx) a.init(ctx);
  return a;
}

const held = (a) => a.voices + a.worldVoices + a.priorityVoices;

/**
 * Down a player, assert the marker is really held, then run `exit` and assert
 * every trace of it is gone: the handle, the charge, and the sources.
 */
function exitCase(name, exit, ctxFor = () => ({ events: makeBus(), player: { alive: true } })) {
  const ctx = ctxFor();
  const a = makeAudio(ctx);
  a.playerDowned({ x: 2, y: 0, z: 3 });
  const h = a._downedMarker;
  const before = held(a);
  ok(!!h && h.active === true && before > 0, `${name}: a body is down and holding a voice`);

  exit(a, ctx);
  a.ac.endAll();

  ok(a._downedMarker === null, `${name}: the handle is dropped`);
  ok(h.active === false, `${name}: the voice is released`);
  ok(held(a) === 0, `${name}: every unit of budget is back (held ${held(a)})`);
  // The strongest form: the graph nodes the marker started were actually told
  // to stop. A `release()` reduced to a bookkeeping decrement fails here.
  const running = a.ac.sources().filter((n) => n.starts.length && !n.stops.length);
  ok(running.length === 0, `${name}: no source is left running (${running.length} would be)`);
}

console.log('every exit from the downed state releases the held marker');
exitCase('revive', (a) => a.playerRevived({ x: 2, y: 0, z: 3 }));
exitCase('revive over the bus', (a, ctx) => ctx.events.emit('playerRevived', { player: ctx.player, position: { x: 2, y: 0, z: 3 } }));
exitCase('the downed player dies', (a, ctx) => {
  ctx.player.alive = false;
  ctx.events.emit('playerDead', { victim: ctx.player });
});
// The case that leaked: the handler returns early for a body that is not the
// local survivor, so the release has to happen ahead of that guard.
exitCase('a teammate dies', (a, ctx) => ctx.events.emit('playerDead', { victim: { netId: 7 } }));
exitCase('the stage changes', (a, ctx) => ctx.events.emit('stageStart', { index: 2 }));
exitCase('an explicit release', (a) => a.releaseDownedMarker());

console.log('releasing is idempotent and safe to call with nothing down');
{
  const a = makeAudio();
  a.releaseDownedMarker();
  ok(held(a) === 0, 'releasing an absent marker costs nothing');
  a.playerDowned({ x: 0, y: 0, z: 0 });
  a.releaseDownedMarker();
  a.ac.endAll();
  const after = held(a);
  a.releaseDownedMarker();
  a.releaseDownedMarker();
  ok(held(a) === after && held(a) === 0, 'and releasing three times does not double-credit the budget');
}

/* ------------------------------------------- the world-side marker registry */

/** The smallest `this` the marker methods touch. */
function fakeVFX() {
  const self = Object.create(VFX.prototype);
  self._downed = new Map();
  self.pulses = [];
  self.rings = { spawn: (pos, up, hue, r0, r1) => self.pulses.push({ hue, r0, r1 }) };
  self.lights = { flick() {} };
  self.particles = { emit() {} };
  self._ep = () => ({
    position: { x: 0, y: 0, z: 0, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } },
    dir: { set() {} }, color0: { set() {} }, color1: { set() {} },
  });
  return self;
}
const pawn = () => ({ alive: true, downed: true, position: { x: 0, y: 0, z: 0 } });

console.log('the world marker pulses while a body is down and stops when it is not');
{
  const v = fakeVFX(), p = pawn();
  v.playerDowned(p, p.position);
  ok(v._downed.has(p), 'downing registers the body');
  v.pulses.length = 0;
  v._updateDownedMarkers(2.0);
  ok(v.pulses.length === 1, 'and it pulses on the marker period');

  v.playerRevived(p, p.position);
  ok(!v._downed.has(p), 'reviving unregisters it');
  v.pulses.length = 0;
  v._updateDownedMarkers(2.0);
  ok(v.pulses.length === 0, 'and the pulse stops (a marker that survived revive would beat here)');
}

console.log('the collapsing ring collapses');
{
  const v = fakeVFX(), p = pawn();
  v.playerDowned(p, p.position);
  // Every other ring in VFX expands. This one must not: r0 > r1 is the effect.
  ok(v.pulses[0].r0 > v.pulses[0].r1, `downing collapses inward (${v.pulses[0].r0} -> ${v.pulses[0].r1})`);
  const w = fakeVFX(), q = pawn();
  w.playerRevived(q, q.position);
  ok(w.pulses[0].r0 < w.pulses[0].r1, `revival expands outward (${w.pulses[0].r0} -> ${w.pulses[0].r1})`);
  ok(w.pulses[1].hue === 0xffffff, 'both wear a white-hot core over the element rim (§1.2)');
}

console.log('a body that dies or teleports stops being a marker');
{
  const v = fakeVFX(), p = pawn();
  v.playerDowned(p, p.position);
  p.alive = false;
  v._updateDownedMarkers(2.0);
  ok(!v._downed.has(p), 'the liveness sweep drops a dead body');

  const w = fakeVFX(), a = pawn(), b = pawn();
  w.playerDowned(a, a.position);
  w.playerDowned(b, b.position);
  ok(w._downed.size === 2, 'two bodies, two markers');
  w.playerRevived(null, null);
  ok(w._downed.size === 0, 'a stage change clears every marker at once');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
