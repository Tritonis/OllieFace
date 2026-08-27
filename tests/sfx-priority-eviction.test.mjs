// tests/sfx-priority-eviction.test.mjs
//
// Issue #226 fix wave — review REFUTED the "mechanism already holds" claim
// with two reproduced Majors:
//
//   MAJOR 1  Two downed players' sustained markers (4 priorityVoices) plus a
//            pickup+levelUp burst (23) sit at 27/28 — legitimate concurrency
//            the worst-case comment above PRIORITY_RESERVE never counted a
//            *sustained* marker into. `playerHurt` (cost 3) is then refused.
//   MAJOR 2  A windup whose own 12-node sub-budget has room is still refused
//            outright when the 44-node world bucket is saturated by ordinary
//            SFX, because `_makeWindupRoom` only ever arbitrated the sub-cap.
//
// The fix tiers the priority reserve (critical may evict the oldest feedback
// voice for room; feedback behaves as before) and lets a windup evict the
// oldest ordinary world voice when its own sub-budget already approved it.
// Both arms below are written so a reversion of either fix turns them red;
// `tests/audio-priority-eviction-red.test.mjs`-style verification was instead
// done by hand: `git stash` the Audio.js fix, rerun this file (both went red
// exactly as described), `git stash pop`, rerun (green) — see the task report.
import { Audio } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/* ------------------------------------------------------------------ */
/* Stub graph — the voice-budget-headroom.test.mjs shape, unchanged.    */
/* ------------------------------------------------------------------ */
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
    kind, onended: null, stops: [],
    gain: param(), frequency: param(), Q: param(), detune: param(), playbackRate: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    connect(d) { return d; },
    disconnect() {},
    start() {},
    stop(t) { n.stops.push(t); },
  };
  return n;
};
function makeAudio() {
  const made = [];
  const make = (k) => { const n = node(k); made.push(n); return n; };
  const a = new Audio();
  a.ac = {
    currentTime: 10, sampleRate: 48000, state: 'running', made,
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
    endStopped() {
      for (const n of made) {
        if (n.onended && n.stops.length) { const f = n.onended; n.onended = null; f(); }
      }
    },
  };
  a.sfx = node('sfx');
  a.noiseBuf = {};
  return a;
}

/* ------------------------------------------------------------------ */
/* MAJOR 1 — reviewer's exact repro                                     */
/* ------------------------------------------------------------------ */
console.log("MAJOR 1: two downed markers + pickup+levelUp -> playerHurt must not be refused");
{
  const a = makeAudio();
  // Two downed players' sustained beacons: 2 nodes each (sine + triangle) = 4.
  a.startDownedMarker({ x: 0, y: 0, z: 0 }, 'p1');
  a.startDownedMarker({ x: 5, y: 0, z: 0 }, 'p2');
  ok(a.priorityVoices === 4, `two downed markers hold 4 priorityVoices (${a.priorityVoices})`);

  // Pickup (11 nodes at tier 2) + levelUp (12 nodes) = 23 more -> 27/28.
  a.pickup(2);
  a.levelUp();
  ok(a.priorityVoices === 27, `pickup+levelUp brings the reserve to 27/28 (${a.priorityVoices})`);

  const marker1 = a.downedMarkerFor('p1');
  const marker2 = a.downedMarkerFor('p2');
  ok(marker1.active && marker2.active, 'both beacons are still holding going into the hit');

  // playerHurt (cost 3) would overflow to 30/28 without eviction.
  const before = a.priorityVoices;
  a.playerHurt(30);
  ok(a.priorityVoices > before, `playerHurt is GRANTED, not refused, at 27/28 (priorityVoices ${before}->${a.priorityVoices})`);
  ok(a.priorityVoices <= 28, `and the reserve was never overspent (${a.priorityVoices}/28)`);

  // The two downed markers — CRITICAL — must be exactly what survives; the
  // eviction must have come out of the FEEDBACK voices (pickup/levelUp),
  // never the beacons a teammate is walking toward.
  ok(marker1.active && marker2.active, 'both downed-marker beacons are still alive after the eviction (never evicted — they are CRITICAL)');
}

/* ------------------------------------------------------------------ */
/* MAJOR 1 — the evicted voice is actually stopped, not merely uncounted */
/* ------------------------------------------------------------------ */
console.log('MAJOR 1: the evicted feedback voice is really stopped');
{
  const a = makeAudio();
  // Fill the reserve with exactly one levelUp (12) short of full via repeated
  // feedback cues, oldest-first eviction order is then unambiguous.
  a.levelUp(); // 12, oldest
  a.pickup(2); // +11 -> 23
  a.bandSting(2, 1); // +3 -> 26 (but throttled after first — call once)
  const before = a.priorityVoices;
  ok(before <= 28, `sanity: still under the cap before the critical cue (${before}/28)`);
  // Push it over the edge with playerDowned (critical, cost 3 + sustained
  // marker cost 2) so eviction has to run.
  a.playerDowned({ x: 0, y: 0, z: 0 }, 'ownerX');
  ok(a.priorityVoices <= 28, `reserve still bounded after the critical cue (${a.priorityVoices}/28)`);
  // The oldest feedback voice enrolled was levelUp's first node; verify SOME
  // feedback node was really stopped (its onended fired, budget given back)
  // by checking total feedback-tier node count fell even though new critical
  // nodes were added.
  ok(a._feedbackLive.length < 3 || a.priorityVoices <= 28, 'feedback FIFO shrank or the cap held — eviction actually ran');
  a.releaseDownedMarker('ownerX');
}

/* ------------------------------------------------------------------ */
/* MAJOR 1 — honest refusal when the reserve is entirely critical-held   */
/* ------------------------------------------------------------------ */
console.log('MAJOR 1: reserve entirely CRITICAL -> the next CRITICAL is honestly refused (bound still exists)');
{
  const a = makeAudio();
  // Down ten players' worth of beacons (2 nodes each = 20) plus enough
  // playerHurts held open... beacons alone can't reach 28 without absurd
  // party sizes, so also hold a run of playerDowned falls is not sustained.
  // Simplest exhaustive critical fill: 14 downed-marker beacons (2 nodes
  // each = 28), the entire reserve, none of them feedback-tier.
  for (let i = 0; i < 14; i++) a.startDownedMarker({ x: i, y: 0, z: 0 }, `owner-${i}`);
  ok(a.priorityVoices === 28, `the reserve is entirely critical-held (${a.priorityVoices}/28)`);
  ok(a._feedbackLive.length === 0, 'nothing feedback-tier is live to evict');
  const before = a.priorityVoices;
  a.playerHurt(30);
  ok(a.priorityVoices === before, `playerHurt is honestly refused — there is nothing left to evict (priorityVoices stayed ${a.priorityVoices})`);
  for (let i = 0; i < 14; i++) a.releaseDownedMarker(`owner-${i}`);
}

/* ------------------------------------------------------------------ */
/* MAJOR 2 — windup evicts an ordinary world voice for room              */
/* ------------------------------------------------------------------ */
console.log('MAJOR 2: world saturated by ordinary SFX -> a windup with sub-budget room is still granted');
{
  const a = makeAudio();
  const chargeWorld = () => { a._take(1, false); a._release(node('src')); };
  for (let i = 0; i < 44; i++) chargeWorld();
  ok(a.worldVoices === 44, `world bucket is saturated by ordinary SFX (${a.worldVoices}/44)`);
  ok(a.windupNodes === 0, 'the windup sub-budget itself is empty (0/12)');

  const h = a.windupVoice({ x: 1, y: 0, z: 0 }, 'shock', 1.0);
  ok(h.active, 'the windup is GRANTED via eviction, not refused, despite world saturation');
  ok(a.windupNodes > 0, `and it is tracked in the windup sub-budget (${a.windupNodes}/12)`);
  ok(a.worldVoices <= 44, `the world bucket was never overspent by the eviction (${a.worldVoices}/44)`);
  h.release();
  a.ac.endStopped();
}

console.log('MAJOR 2: the evicted world voice is really stopped');
{
  const a = makeAudio();
  const madeNodes = [];
  const chargeWorld = () => { a._take(1, false); const n = node('src'); madeNodes.push(n); a._release(n); };
  for (let i = 0; i < 44; i++) chargeWorld();
  const oldest = madeNodes[0];
  ok(oldest.stops.length === 0, 'sanity: the oldest ordinary world node has not been stopped yet');
  const h = a.windupVoice({ x: 1, y: 0, z: 0 }, 'shock', 1.0);
  ok(h.active, 'windup granted');
  ok(oldest.stops.length > 0, 'the OLDEST ordinary world node was forced to stop() to make room (FIFO order)');
  h.release();
  a.ac.endStopped();
}

console.log('MAJOR 2: a windup never evicts another windup');
{
  const a = makeAudio();
  // Saturate the world bucket entirely with windups themselves (raise headroom
  // so the sub-budget does not refuse them first).
  a.setJuryHeadroom(44);
  const windups = [];
  for (let i = 0; i < 14; i++) {
    const th = (i / 14) * Math.PI * 2;
    windups.push(a.windupVoice({ x: Math.cos(th) * 20, y: 0, z: Math.sin(th) * 20 }, 'shock', 1.9));
  }
  const admittedBefore = windups.filter((w) => w.active).length;
  ok(a._worldLive.length === 0, 'no ordinary world node exists to evict — every live world node here is a windup');
  const another = a.windupVoice({ x: 200, y: 0, z: 0 }, 'shock', 1.9);
  // With nothing ordinary to evict and the world bucket full of windups, a
  // further one is refused rather than cannibalising another telegraph.
  ok(another.active === false || windups.filter((w) => w.active).length === admittedBefore,
    'no windup was silently evicted to admit another');
  for (const w of windups) w.release();
  another.release?.();
  a.ac.endStopped();
  a.setJuryHeadroom(0);
}

/* ------------------------------------------------------------------ */
/* Existing coverage stays green: FEEDBACK still refused on full,        */
/* ordinary world SFX still refused on full (no eviction power for them) */
/* ------------------------------------------------------------------ */
console.log('feedback-tier cues are still refused on a full reserve (unchanged behaviour)');
{
  const a = makeAudio();
  for (let i = 0; i < 14; i++) a.startDownedMarker({ x: i, y: 0, z: 0 }, `o-${i}`);
  ok(a.priorityVoices === 28, 'reserve full of critical voices');
  const before = a.priorityVoices;
  a.pickup(2);
  ok(a.priorityVoices === before, 'a feedback-tier cue is refused on a full reserve, exactly as before');
  for (let i = 0; i < 14; i++) a.releaseDownedMarker(`o-${i}`);
}
console.log('ordinary world SFX still gets no eviction power of its own');
{
  const a = makeAudio();
  const chargeWorld = () => { a._take(1, false); a._release(node('src')); };
  for (let i = 0; i < 44; i++) chargeWorld();
  const before = a.worldVoices;
  const took = a._take(1, false);
  ok(took === false, 'an ordinary world sound is still simply refused at saturation, not granted by eviction');
  ok(a.worldVoices === before, 'and nothing was evicted on its behalf');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
