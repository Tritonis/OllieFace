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
import { Coop } from '../src/net/Coop.js';

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
const pawnOf = (netId) => ({ alive: true, netId, position: { x: 0, y: 0, z: 0 } });

/**
 * Down a player, assert the marker is really held, then run `exit` and assert
 * every trace of it is gone: the handle, the charge, and the sources.
 */
function exitCase(name, exit, ctxFor = () => ({ events: makeBus(), player: { alive: true } })) {
  const ctx = ctxFor();
  const a = makeAudio(ctx);
  // The body on the floor is `downedPawn` where a case names one — a peer's
  // mixer watching somebody else go down — and the local player otherwise.
  a.playerDowned({ x: 2, y: 0, z: 3 }, ctx.downedPawn ?? ctx.player);
  const h = [...a._downedMarkers.values()][0]?.h;
  const before = held(a);
  ok(!!h && h.active === true && before > 0, `${name}: a body is down and holding a voice`);

  exit(a, ctx);
  a.ac.endAll();

  ok(a.downedMarkerCount === 0, `${name}: the handle is dropped`);
  ok(h.active === false, `${name}: the voice is released`);
  ok(held(a) === 0, `${name}: every unit of budget is back (held ${held(a)})`);
  // The strongest form: the graph nodes the marker started were actually told
  // to stop. A `release()` reduced to a bookkeeping decrement fails here.
  const running = a.ac.sources().filter((n) => n.starts.length && !n.stops.length);
  ok(running.length === 0, `${name}: no source is left running (${running.length} would be)`);
}

console.log('every exit from the downed state releases the held marker');
exitCase('revive', (a, ctx) => a.playerRevived({ x: 2, y: 0, z: 3 }, ctx.player));
exitCase('revive over the bus', (a, ctx) => ctx.events.emit('playerRevived', { player: ctx.player, position: { x: 2, y: 0, z: 3 } }));
exitCase('the downed player dies', (a, ctx) => {
  ctx.player.alive = false;
  ctx.events.emit('playerDead', { victim: ctx.player });
});
// The case that leaked once: the handler returns early for a body that is not
// the local survivor, so the release has to happen ahead of that guard. Here
// the *downed* player is the one who dies, and the mixer is a remote peer's
// (`ctx.player` is somebody else), so the early return is taken.
exitCase('a downed teammate dies on a peer’s mixer',
  (a, ctx) => ctx.events.emit('playerDead', { victim: ctx.downedPawn }),
  () => {
    const downedPawn = pawnOf(7);
    return { events: makeBus(), player: { alive: true, netId: 3 }, downedPawn };
  });
// The leak the run-end review found: a peer whose body is on the floor
// disconnects. `NetHost._onPeerLeave` reaches `Coop._despawnPawn` through
// `ctx.despawnRemotePlayer`, and that path used to unregister and dispose the
// pawn and nothing else — `netPlayerLeft` carries a transport peer id, which no
// listener can resolve back to a marker. The pawn reference is only in hand
// here, so this is where the release has to be. Driven through the real
// `Coop`, not a stand-in for it.
exitCase('a downed peer disconnects',
  (a, ctx) => ctx.despawnRemotePlayer(ctx.downedPawn),
  () => {
    const downedPawn = pawnOf(11);
    const ctx = {
      events: makeBus(), player: { alive: true, netId: 3 }, downedPawn,
      combat: { unregister() {} }, vfx: { clearDownedMarker() {} },
    };
    new Coop().init(ctx);
    ctx.coop.pawns.push(downedPawn);
    // `init` claims `ctx.audio` nowhere; the harness assigns it after the
    // mixer exists, exactly as the engine does.
    return ctx;
  });
exitCase('the stage changes', (a, ctx) => ctx.events.emit('stageStart', { index: 2 }));
exitCase('an explicit release', (a, ctx) => a.releaseDownedMarker(ctx.player));
exitCase('a blanket release', (a) => a.releaseDownedMarker());

console.log('two bodies on the floor are two beacons, and they end separately');
{
  // The Critical this file was extended for: with a single handle field, B
  // going down silently killed A's beacon, and reviving A released whichever
  // marker was in the field rather than A's own.
  const ctx = { events: makeBus(), player: { alive: true, netId: 1 } };
  const a = makeAudio(ctx);
  const A = pawnOf(1), B = pawnOf(2);

  ctx.events.emit('playerDowned', { player: A, position: { x: 1, y: 0, z: 0 } });
  const hA = a.downedMarkerFor(A);
  ctx.events.emit('playerDowned', { player: B, position: { x: 9, y: 0, z: 0 } });
  const hB = a.downedMarkerFor(B);

  ok(a.downedMarkerCount === 2, 'both bodies hold a marker at once');
  ok(hA.active === true, 'B going down does not kill A’s beacon');
  ok(hB && hB !== hA && hB.active === true, 'and B has a beacon of its own');

  ctx.events.emit('playerRevived', { player: A, position: { x: 1, y: 0, z: 0 } });
  ok(hA.active === false, 'reviving A releases A’s marker');
  ok(hB.active === true, 'and leaves B’s sounding — B is still on the floor');
  ok(a.downedMarkerCount === 1, 'exactly one beacon left');

  ctx.events.emit('playerDead', { victim: B });
  a.ac.endAll();
  ok(hB.active === false, 'B’s own exit is what ends B’s marker');
  ok(a.downedMarkerCount === 0 && held(a) === 0, 'and the budget is whole again');
}

console.log('re-downing the same body replaces only that body’s marker');
{
  const a = makeAudio();
  const A = pawnOf(1), B = pawnOf(2);
  a.playerDowned({ x: 0, y: 0, z: 0 }, A);
  const first = a.downedMarkerFor(A);
  a.playerDowned({ x: 0, y: 0, z: 0 }, B);
  a.playerDowned({ x: 0, y: 0, z: 0 }, A);
  ok(first.active === false, 'the same owner’s previous handle is released');
  ok(a.downedMarkerFor(B).active === true, 'the other body is untouched');
  ok(a.downedMarkerCount === 2, 'and no handle was stranded');
}

console.log('a netId assigned after the body went down still finds its marker');
{
  // The reviewer's host-side leak, exactly. `NetHost._netId` hands out ids
  // lazily — the first time a snapshot needs one, i.e. the first tick after a
  // client joins — so a pawn downed in the seconds before that has no netId
  // when its marker is filed and has one by the time the release comes. A key
  // re-derived from `owner.netId` at every call missed, and the beacon sounded
  // for the rest of the stage.
  const a = makeAudio();
  const pawn = { alive: true, position: { x: 0, y: 0, z: 0 } }; // netId unset
  a.playerDowned({ x: 1, y: 0, z: 2 }, pawn);
  const h = a.downedMarkerFor(pawn);
  ok(!!h && h.active === true && a.downedMarkerCount === 1, 'the body is down with no netId yet');

  pawn.netId = 7; // NetHost assigns, mid-down

  ok(a.downedMarkerFor(pawn) === h, 'the marker is still findable by the pawn it belongs to');
  a.releaseDownedMarker(pawn);
  a.ac.endAll();
  ok(a.downedMarkerCount === 0, 'releasing by pawn reference succeeds across the assignment');
  ok(h.active === false && held(a) === 0, 'and the voice and its budget come back');
}

console.log('and a wire payload carrying only a netId finds it too');
{
  // `sanitise` names a victim by netId alone, so the release that arrives over
  // the wire has no pawn reference to offer — and the marker was filed before
  // the pawn had a number at all.
  const a = makeAudio();
  const pawn = { alive: true, position: { x: 0, y: 0, z: 0 } };
  a.playerDowned({ x: 1, y: 0, z: 2 }, pawn);
  const h = a.downedMarkerFor(pawn);
  pawn.netId = 7;

  ok(a.downedMarkerFor({ netId: 7 }) === h, 'the wire identity resolves to the same marker');
  a.releaseDownedMarker({ netId: 7 });
  a.ac.endAll();
  ok(a.downedMarkerCount === 0 && h.active === false, 'releasing by netId alone succeeds');
  ok(held(a) === 0, 'and the budget is whole');
}

console.log('the late-netId resolution does not release the wrong body');
{
  const a = makeAudio();
  const A = { alive: true, position: { x: 0, y: 0, z: 0 } };
  const B = { alive: true, position: { x: 0, y: 0, z: 0 } };
  a.playerDowned({ x: 0, y: 0, z: 0 }, A);
  a.playerDowned({ x: 5, y: 0, z: 0 }, B);
  const hA = a.downedMarkerFor(A), hB = a.downedMarkerFor(B);
  A.netId = 3; B.netId = 4;
  a.releaseDownedMarker({ netId: 4 });
  ok(hB.active === false, 'the named body is released');
  ok(hA.active === true && a.downedMarkerCount === 1, 'and the other one is not');
  // An id nobody holds releases nothing at all.
  a.releaseDownedMarker({ netId: 99 });
  ok(hA.active === true && a.downedMarkerCount === 1, 'an unknown netId is a miss, not a scattershot');
}

console.log('releasing is idempotent and safe to call with nothing down');
{
  const a = makeAudio();
  a.releaseDownedMarker();
  ok(held(a) === 0, 'releasing an absent marker costs nothing');
  a.playerDowned({ x: 0, y: 0, z: 0 });
  ok(a.downedMarkerCount === 1, 'an owner-less down still gets exactly one marker');
  a.playerDowned({ x: 0, y: 0, z: 0 });
  ok(a.downedMarkerCount === 1, 'and a second one does not pile up an anonymous second');
  a.releaseDownedMarker();
  a.ac.endAll();
  const after = held(a);
  a.releaseDownedMarker();
  a.releaseDownedMarker(null);
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

console.log('a disconnecting peer takes its world marker with it');
{
  const v = fakeVFX(), p = pawn();
  v.playerDowned(p, p.position);
  const ctx = { events: makeBus(), combat: { unregister() {} }, vfx: v };
  new Coop().init(ctx);
  ctx.coop.pawns.push(p);
  v.pulses.length = 0;
  ctx.despawnRemotePlayer(p);
  ok(!v._downed.has(p), 'the despawn unregisters the body');
  // Clearing is the bookkeeping half of a revive and nothing more: a peer who
  // dropped is not revived, so no restorative ring is spawned for them.
  ok(v.pulses.length === 0, 'with no revive spectacle attached');
  v._updateDownedMarkers(2.0);
  ok(v.pulses.length === 0, 'and nothing beats over the empty ground it left');
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

/* ------------------------------------------- the showcase is an exit too */

console.log('the showcase gives the marker back through both of its doors');
{
  // Reproduces the reviewer's leak: fire the `playerDowned` moment, then
  // `dispose()` the instrument. `dispose` retired the demonstrators and left
  // the marker sounding over a game with no showcase on screen — the marker is
  // the one held voice the showcase can start *without* a demonstrator to
  // retire, so retiring them all was not enough.
  const el = () => {
    const n = {
      style: { cssText: '' }, textContent: '', innerHTML: '', id: '', children: [],
      append: (...k) => n.children.push(...k),
      appendChild: (k) => { n.children.push(k); return k; },
      scrollIntoView() {}, remove() {},
    };
    return n;
  };
  globalThis.document = { createElement: el, body: el() };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const { installShowcase } = await import('../src/core/Showcase.js');

  const showcaseCtx = (a) => ({
    audio: a,
    camera: { position: { x: 0, y: 2, z: 0 }, getWorldDirection: (v) => v.set(0, 0, -1) },
    stage: { sampleHeight: () => 0 },
  });

  for (const [door, run] of [['dispose', (api) => api.dispose()], ['close', (api) => api.close()]]) {
    const a = makeAudio();
    const api = installShowcase(showcaseCtx(a));
    ok(api.fire('playerDowned'), `${door}: the downed moment fired`);
    const h = [...a._downedMarkers.values()][0]?.h;
    ok(!!h && h.active === true && held(a) > 0, `${door}: it left a marker holding a voice`);

    run(api);
    a.ac.endAll();
    ok(a.downedMarkerCount === 0, `${door}: the marker is dropped`);
    ok(h.active === false, `${door}: and its voice is released`);
    ok(held(a) === 0, `${door}: every unit of budget is back (held ${held(a)})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
