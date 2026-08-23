// tests/voice-budget-headroom.test.mjs
//
// The two ways the new held voices could shut the mixer, both reproduced from
// the integration review's own measurements rather than from a guess:
//
//   M4  fourteen concurrent enemy windups took 42 of the 44 world nodes and
//       every zap after them was refused. A windup is *held* for its whole
//       telegraph window (1.9 s for a Colossus), so this is not a burst that
//       clears — it is the bucket closed for two seconds.
//   M5  a held aegis dome sat in the priority reserve, and `_runSchedule` — the
//       only thing that would ever release it — is frozen while the player is
//       downed. Dome plus snare refused `playerHurt` outright.
//
// Written so they CAN fail. Every assertion here is an admission after a load,
// not a "did not throw": raise WINDUP_VOICES past the world budget, delete the
// distance cull, drop the `priority: false` at the equipment call sites, or
// remove the downed edge in `applyCommand`, and a named line below goes red.
import { Audio } from '../src/systems/Audio.js';
import { voice } from '../src/data/effects.js';
import { EQUIPMENT_BY_ID } from '../src/data/equipment.js';
import { Player } from '../src/entities/Player.js';
import * as THREE from 'three';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/* ------------------------------------------------------------------ */
/* Stub graph — the `audio-sustained.test.mjs` shape, unchanged.        */
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
    // Everything stopped is ended: the point of these scenarios is what is
    // *still held*, so a source nobody stopped keeps its nodes, as in the game.
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
/* M4 — a horde of windups may not close the world bucket              */
/* ------------------------------------------------------------------ */

console.log("the review's horde: 14 shock windups + 20 item cues");
{
  const a = makeAudio();
  // Fourteen attackers ringed around the listener, all inside earshot. Shock is
  // the three-node recipe the review measured at 42/44.
  const held = [];
  for (let i = 0; i < 14; i++) {
    const th = (i / 14) * Math.PI * 2;
    held.push(a.windupVoice({ x: Math.cos(th) * 20, y: 0, z: Math.sin(th) * 20 }, 'shock', 1.9));
  }
  const admitted = held.filter((h) => h.active).length;
  ok(admitted > 0, `some of the horde is audible (${admitted}/14)`);
  ok(admitted < 14, 'and the sub-budget refused the rest rather than spending the bucket');
  ok(a.windupNodes <= 12, `windups hold at most their own sub-budget (held ${a.windupNodes})`);
  // Eviction is a release, not a cut: the evicted voices give their nodes back
  // when their fade ends, which is what this settles.
  a.ac.endStopped();
  ok(a.worldVoices <= 12, `the world bucket is not spent on telegraphs alone (${a.worldVoices}/44)`);
  ok(44 - a.windupNodes >= 32, `at least 32 world nodes stand free of telegraphs (${44 - a.windupNodes})`);

  // The sounds the telegraph is warning *about* must still get in, with the
  // whole horde still holding.
  ok(a._take(7) === true, `a zap (cost 7) is admitted over the held horde (world ${a.worldVoices}/44)`);
  ok(a._take(3, true) === true, 'and a playerHurt out of the reserve');

  // Twenty item proc cues on top — lane A's floor, one positioned voice each.
  // They are bursts, so this counts how many the horde left room for; the
  // review measured 6 of 20 admitted with the windups uncapped.
  // A burst releases itself on the way out, so `active` is false by the time it
  // is returned; the refusal counter is what says whether it was ever admitted.
  const refusedBefore = a._refusals;
  for (let i = 0; i < 20; i++) voice(a, 'shock', 'chord', { x: i, y: 0, z: 0 }, 'event');
  const cues = 20 - (a._refusals - refusedBefore);
  // Nothing in this stub ever ends on its own, so twenty overlapping bursts are
  // strictly worse than twenty cues in play; the bar is the review's 6.
  ok(cues >= 10, `far more of the item floor survives the horde than the review's 6 (${cues}/20)`);

  for (const h of held) h.release();
  a.ac.endStopped();
  ok(a.windupNodes === 0, 'every windup gave its sub-budget back');
}

console.log('a windup out of earshot is refused before it is charged');
{
  const a = makeAudio();
  const near = a.windupVoice({ x: 5, y: 0, z: 0 }, 'void', 1.2);
  ok(near.active, 'a windup at 5 m plays');
  const spent = a.worldVoices;
  const far = a.windupVoice({ x: 400, y: 0, z: 0 }, 'void', 1.2);
  ok(!far.active, 'a windup 400 m away is refused');
  ok(a.worldVoices === spent, 'and charged nothing on its way out');
  let threw = false;
  try { far.release(); far.move({ x: 1, y: 1, z: 1 }); } catch { threw = true; }
  ok(!threw, 'the refused handle is inert and safe to drive');
}

console.log('when the sub-budget is full the nearest windup wins');
{
  const a = makeAudio();
  // Four far three-node windups fill the 12-node sub-budget.
  const far = [];
  for (let i = 0; i < 4; i++) far.push(a.windupVoice({ x: 100 + i, y: 0, z: 0 }, 'shock', 1.5));
  ok(far.every((h) => h.active), 'the four distant windups all started');
  ok(a.windupNodes === 12, 'the sub-budget is full');

  const close = a.windupVoice({ x: 2, y: 0, z: 0 }, 'shock', 1.5);
  ok(close.active, 'the windup at the player got in anyway');
  ok(far.filter((h) => h.active).length === 3, 'exactly one distant windup was evicted for it');
  ok(a.windupNodes === 12, 'and the sub-budget is still exactly full, not overspent');

  // The other direction: a further one does not evict a nearer one.
  const further = a.windupVoice({ x: 110, y: 0, z: 0 }, 'shock', 1.5);
  ok(!further.active, 'a windup further than everything held is simply refused');
  ok(close.active, 'the nearest windup was not taken for it');
}

/* ------------------------------------------------------------------ */
/* M5 — a held player voice is released on every exit from playing      */
/* ------------------------------------------------------------------ */

// The real aegis card, driven through its real `use`, against a real Player
// prototype. `Object.create` on the prototype is the revive-system.test.mjs
// idiom: the branch under test (`applyCommand`'s downed edge, `holdVoice`,
// `releaseVoices`) is Player's own, and only the world-touching helpers are
// stubbed.
function makeDownablePlayer(audio) {
  const p = Object.create(Player.prototype);
  Object.assign(p, {
    ctx: { audio },
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    alive: true, downed: false, _wasDowned: false, _heldVoices: [],
    _prevButtons: 0, _lastCmdTick: 0, _replaying: false, _cmdTick: 0,
    _sched: Array.from({ length: 32 }, () => ({ t: 0, fn: null })),
    _refreshStats() {}, _harvestExternal() {}, _tickTimers() {}, _tickCooldowns() {},
    _resolve() {}, _land() {}, _commit() {}, _aim() {}, _abilities() {}, _move() {},
    _external: new THREE.Vector3(0, 0, 0), _extVX: 0, _extVZ: 0, _buffs: [],
    projectiles: { fixedUpdate() {}, clear() {} }, placeables: { fixedUpdate() {}, clear() {} },
  });
  return p;
}
function useAegis(audio, player) {
  const card = EQUIPMENT_BY_ID.get('aegis-emitter');
  card.use({
    player, ctx: { audio, vfx: null }, items: { addEffect() {}, addBuff() {} },
    combat: { applyStatus() {} },
  });
}

console.log("the dome's voice does not outlive the player who dropped it");
{
  const a = makeAudio();
  const p = makeDownablePlayer(a);
  useAegis(a, p);
  ok(p._heldVoices.length === 1, 'the dome voice is registered with the pawn that owns it');
  const dome = p._heldVoices[0];
  ok(dome.active, 'and it is holding');
  ok(a.priorityVoices === 0, 'held equipment ambience is not in the player-feedback reserve');
  ok(a.worldVoices > 0, 'it is charged to the world bucket like any other standing sound');

  // Down the pawn. `_runSchedule` freezes here, so the scheduled release will
  // never run — the guarantee has to come from the edge itself.
  p.downed = true;
  p.applyCommand({ tick: 1, buttons: 0 }, 1 / 60);
  ok(!dome.active, 'going down released the dome voice');

  a.ac.endStopped();
  ok(a.worldVoices === 0, 'and its nodes came back');
}

console.log('a dome and a snare together still leave room for playerHurt');
{
  const a = makeAudio();
  const p = makeDownablePlayer(a);
  // Three standing ambiences — the co-op / leaked-handle row of the review's
  // table, where a dome and a snare together already refused `playerHurt`.
  useAegis(a, p);
  useAegis(a, p);
  useAegis(a, p);
  ok(a.priorityVoices === 0, 'none of them is in the reserve');
  // The reserve's documented worst case, on top: a pickup (11) and a levelUp
  // (12) overlapping.
  ok(a._take(11, true) === true, 'a pickup is admitted');
  ok(a._take(12, true) === true, 'a levelUp over it is admitted');
  ok(a._take(3, true) === true, 'and playerHurt is still HEARD, not refused');

  // Death is the other frozen exit: `onDeath` runs no schedule either.
  p.onDeath();
  ok(p._heldVoices.length === 0, 'death released everything the pawn was holding');
}

/* ------------------------------------------------------------------ */
/* #155 — jury headroom: the panel the sub-budget was muting            */
/* ------------------------------------------------------------------ */
//
// The showcase's enemy-attack entries drive the real `beginAttack`, so the
// largest jury preset asks for sixteen or seventeen *held* windups at once and
// the shipped 12-node sub-budget admitted about seven of them: the instrument
// staging the absence of exactly what the panel was convened to hear. While
// the showcase is open the sub-budget alone is raised to fit that panel, and on
// close it is the shipped value again.
//
// Written so it CAN fail: drop the `setJuryHeadroom` call from `setOpen`, or
// drop the restore on the way out, and a named line below goes red.

// The thinnest DOM the overlay builds against — `showcase-surface.test.mjs`'s.
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
const { sustainNodeCost } = await import('../src/data/elementVoice.js');

console.log('\nthe jury panel the showcase was muting');
{
  const a = makeAudio();
  const show = installShowcase({
    audio: a,
    camera: { position: { x: 0, y: 2, z: 0 }, getWorldDirection: (v) => v.set(0, 0, -1) },
    stage: { sampleHeight: () => 0 },
  });

  // The greediest panel, re-derived here off the entries rather than read back
  // off the module's own arithmetic.
  const byId = new Map(show.entries.map((e) => [e.id, e]));
  const windups = (p) => p.ids.map((id) => byId.get(id))
    .filter((e) => e && (e.group === 'telegraph' || e.group === 'windup'));
  const panel = show.presets.reduce((best, p) =>
    (windups(p).reduce((s, e) => s + sustainNodeCost(e.meta.element), 0)
      > windups(best).reduce((s, e) => s + sustainNodeCost(e.meta.element), 0) ? p : best));
  const members = windups(panel);
  const want = members.reduce((s, e) => s + sustainNodeCost(e.meta.element), 0);
  ok(members.length >= 14, `the largest panel is a real pile-up (${panel.name}, ${members.length} windups)`);
  ok(want > 12, `and it asks for more than the shipped sub-budget (${want} nodes)`);
  ok(show.juryWindupNodes === want, `the showcase sized its headroom off the same tables (${show.juryWindupNodes})`);

  // Fire the panel: every member at a different bearing, all inside earshot.
  const firePanel = () => {
    const held = members.map((e, i) => {
      const th = (i / members.length) * Math.PI * 2;
      return a.windupVoice({ x: Math.cos(th) * 20, y: 0, z: Math.sin(th) * 20 }, e.meta.element, 1.2);
    });
    return held;
  };

  // 1. Closed: the panel is half-heard, which is the bug.
  let held = firePanel();
  ok(held.filter((h) => h.active).length < members.length,
    `with the instrument closed the panel is part-muted (${held.filter((h) => h.active).length}/${members.length})`);
  ok(a.windupNodes <= 12, `and the shipped sub-budget held (${a.windupNodes})`);
  for (const h of held) h.release();
  a.ac.endStopped();

  // 2. Open: every member of the panel is audible.
  show.open();
  held = firePanel();
  ok(held.every((h) => h.active),
    `with the showcase open every panel member is heard (${held.filter((h) => h.active).length}/${members.length})`);
  ok(a.windupNodes === want, `and the sub-budget holds exactly the panel (${a.windupNodes}/${want})`);
  ok(a.worldVoices <= 44, `still inside the world bucket it always spent (${a.worldVoices}/44)`);
  for (const h of held) h.release();
  a.ac.endStopped();

  // 3. Closed again: the shipped cap is back, twice over, and idempotently.
  show.close();
  show.close();
  held = firePanel();
  ok(a.windupNodes <= 12, `closing put the sub-budget back at 12 (${a.windupNodes})`);
  for (const h of held) h.release();
  a.ac.endStopped();

  // And the shipped scenario the cap exists for still holds under it.
  const horde = [];
  for (let i = 0; i < 14; i++) {
    const th = (i / 14) * Math.PI * 2;
    horde.push(a.windupVoice({ x: Math.cos(th) * 20, y: 0, z: Math.sin(th) * 20 }, 'shock', 1.9));
  }
  ok(a.windupNodes <= 12, `the review's horde is capped again (${a.windupNodes})`);
  ok(a._take(7) === true, 'and a zap is admitted over it, as it was before the showcase opened');

  // Dispose is the other exit, and it restores too.
  show.open();
  show.dispose();
  const after = a.windupVoice({ x: 1, y: 0, z: 0 }, 'shock', 1.0);
  ok(a._windupCap === 12, 'disposing the instrument left no raised cap behind');
  after.release();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
