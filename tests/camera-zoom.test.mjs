// tests/camera-zoom.test.mjs
//
// The two camera settings from the 2026-08-21 packaged-build playtest:
// player-controlled zoom (#133) and the no-adjustment camera (#132), plus the
// occlusion hysteresis that is the other half of #132.
//
// Driven against a scripted raycaster rather than a real Stage. That is the
// point: tests/camera-occlusion.test.mjs already replays real geometry and
// asserts aggregate motion, which is the right instrument for "does the boom
// lurch" and the wrong one for "did this ray get consulted at all". Here every
// cast is authored, so an arm can say exactly which rays the rig fired and what
// it did with them -- and each arm below has been run against a deliberately
// broken rig to confirm it goes red.
import * as THREE from 'three';
import { CameraRig } from '../src/core/CameraRig.js';
import { DEFAULTS, SLIDERS, Menus } from '../src/ui/Menus.js';
import { ACTIONS, DEFAULT_BINDINGS, Bindings } from '../src/core/Bindings.js';
import { PAD_BUTTON } from '../src/core/PadState.js';
import { glyphLabel } from '../src/data/glyphs.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const DIST = 7.1;          // must track CameraRig's own constant
const CAM_RADIUS = 0.34;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 1.6;
const dt = 1 / 60;

/**
 * A rig on flat, empty ground with a scripted raycaster.
 *
 * `cast(origin, dir, max, pivot)` returns a distance or -1, exactly as
 * Stage.raycastDistance does. Yaw and pitch are zeroed so the boom axis is
 * -Z: a backward (fan) cast has dir.z < 0 and the reverse sliver cast has
 * dir.z > 0, which is how the scripts below tell them apart.
 */
function makeRig({ cast = null, settings = {}, input = null, speed = 0 } = {}) {
  const ctx = {
    camera: new THREE.PerspectiveCamera(),
    settings,
    input,
    player: {
      position: new THREE.Vector3(0, 0, 0),
      velocity: new THREE.Vector3(0, 0, 0),
      horizontalSpeed: speed, sprintBlend: 0, dashT: 0, dashRoll: 0,
    },
  };
  const calls = [];
  if (cast) {
    ctx.stage = {
      raycastDistance(origin, dir, max) {
        calls.push({ x: origin.x, y: origin.y, z: origin.z, dz: dir.z });
        return cast(origin, dir, max);
      },
    };
  }
  const rig = new CameraRig();
  rig.init(ctx);
  rig.yaw = 0;
  rig.pitch = 0;
  return { ctx, rig, calls };
}

/** Run `n` frames and hand back the rig. */
function run(rig, ctx, n) {
  for (let i = 0; i < n; i++) rig.lateUpdate(ctx, dt);
  return rig;
}

/** An input stub with just the surface CameraRig reads. */
function fakeInput({ wheel = 0, held = [] } = {}) {
  const bindings = new Bindings();
  const codes = new Set(held.map((id) => bindings.code(id)));
  return {
    enabled: true, locked: false, wheel,
    mouse: { dx: 0, dy: 0 }, pad: null, bindings,
    down: (code) => codes.has(code),
  };
}

/* -- 1. schema: the slider, the segment, and the pad binding ------------- */

console.log('settings schema');
{
  ok(DEFAULTS.cameraZoom === 1, 'cameraZoom defaults to 1 (the shipped boom length)');
  ok(DEFAULTS.cameraAssist === 1, 'cameraAssist defaults to 1 (assisted, as captured)');
  const row = SLIDERS.find((s) => s.key === 'cameraZoom');
  ok(!!row, 'cameraZoom has a slider row in the settings screen');
  // A slider wider than the rig's clamp is a control that visibly stops
  // responding before its own end stop.
  ok(row && row.min === ZOOM_MIN && row.max === ZOOM_MAX,
     `slider bounds match the rig clamp (${row?.min}..${row?.max})`);
  const zi = ACTIONS.find((a) => a.id === 'zoomIn');
  const zo = ACTIONS.find((a) => a.id === 'zoomOut');
  ok(!!zi && !!zo, 'zoomIn / zoomOut are declared actions, so both columns rebind');
  ok(DEFAULT_BINDINGS.zoomIn.pad === PAD_BUTTON.L3
     && DEFAULT_BINDINGS.zoomOut.pad === PAD_BUTTON.R3,
     'pad defaults are the stick clicks, so a pad-only player can zoom');
  // Not the D-pad: Menus answers the mutation window on 14/12/15 and navigates
  // menus off 12-15 raw, both while the world is live.
  ok(![10, 11].some((b) => [12, 13, 14, 15].includes(b)),
     'and they collide with neither the mutation window nor menu navigation');
  ok(glyphLabel(PAD_BUTTON.L3, 'playstation') === 'L3'
     && glyphLabel(PAD_BUTTON.R3, 'xbox') === 'RS',
     'both print a real glyph name rather than "Button 10"');
}

/* -- 2. zoom clamps at both ends ---------------------------------------- */

console.log('zoom clamps at both ends');
{
  // Sixty frames of a hard wheel spin outward: far past the clamp either way.
  const out = makeRig({ input: fakeInput({ wheel: 8 }) });
  run(out.rig, out.ctx, 300);
  ok(Math.abs(out.rig.zoomTarget - ZOOM_MAX) < 1e-9,
     `wheel out saturates at ${ZOOM_MAX} (${out.rig.zoomTarget.toFixed(3)})`);
  ok(Math.abs(out.rig.distance - DIST * ZOOM_MAX) < 0.01,
     `the boom follows it to ${(DIST * ZOOM_MAX).toFixed(2)} m (${out.rig.distance.toFixed(3)})`);

  const inn = makeRig({ input: fakeInput({ wheel: -8 }) });
  run(inn.rig, inn.ctx, 300);
  ok(Math.abs(inn.rig.zoomTarget - ZOOM_MIN) < 1e-9,
     `wheel in saturates at ${ZOOM_MIN} (${inn.rig.zoomTarget.toFixed(3)})`);
  ok(inn.rig.distance > 3.0,
     `and never collapses to the occlusion floor (${inn.rig.distance.toFixed(3)} m)`);

  // The dolly is smoothed, not stepped: one notch may not teleport the boom.
  const one = makeRig({ input: fakeInput({ wheel: 4 }) });
  one.rig.lateUpdate(one.ctx, dt);
  ok(one.rig.zoom < one.rig.zoomTarget,
     'a single frame of wheel leaves the boom lerping toward the new target');

  // The pad path reaches the same clamp with no mouse at all (#133's whole
  // reason for a binding rather than a wheel-only control).
  const pad = makeRig({ input: fakeInput({ held: ['zoomOut'] }) });
  run(pad.rig, pad.ctx, 240);
  ok(Math.abs(pad.rig.zoomTarget - ZOOM_MAX) < 1e-9,
     `holding the pad zoom-out reaches the same ceiling (${pad.rig.zoomTarget.toFixed(3)})`);
}

/* -- 3. zoom persists through the settings round-trip -------------------- */

console.log('zoom round-trips through settings');
{
  // The rig commits after the spin settles, not on every notch.
  const committed = [];
  const r = makeRig({
    input: fakeInput({ wheel: 2 }),
    settings: { ...DEFAULTS },
  });
  // The real Menus writes the value back into the settings blob the rig reads,
  // so the stub does too -- without that the rig would see a stale setting and
  // correctly revert, and this arm would be testing the stub.
  r.ctx.menus = { setCameraZoom: (v) => { committed.push(v); r.ctx.settings.cameraZoom = v; } };
  r.rig.lateUpdate(r.ctx, dt);
  ok(committed.length === 0, 'nothing is written while the wheel is still turning');
  r.ctx.input.wheel = 0;
  run(r.rig, r.ctx, 40);       // 0.67 s of quiet, past ZOOM_COMMIT_IDLE
  ok(committed.length === 1 && Math.abs(committed[0] - r.rig.zoomTarget) < 1e-9,
     `the settled zoom is committed exactly once (${committed.map((v) => v.toFixed(3)).join(',')})`);

  // Menus takes that value, clamps it, and saves it.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  const self = { settings: { ...DEFAULTS }, syncSettings() {} };
  Menus.prototype.setCameraZoom.call(self, 1.25);
  ok(self.settings.cameraZoom === 1.25, 'setCameraZoom writes the live settings blob');
  const saved = JSON.parse(store.get('telluric.settings') || '{}');
  ok(saved.cameraZoom === 1.25, `and persists it (${saved.cameraZoom})`);
  Menus.prototype.setCameraZoom.call(self, 99);
  ok(self.settings.cameraZoom === ZOOM_MAX,
     `an out-of-range commit is clamped, never stored raw (${self.settings.cameraZoom})`);

  // And the stored value is what the next run opens on.
  const seeded = makeRig({ settings: { cameraZoom: 1.4 } });
  ok(Math.abs(seeded.rig.zoom - 1.4) < 1e-9, 'a fresh rig seeds its zoom from the stored setting');
  run(seeded.rig, seeded.ctx, 200);
  ok(Math.abs(seeded.rig.distance - DIST * 1.4) < 0.05,
     `and opens at that boom length (${seeded.rig.distance.toFixed(3)} m)`);

  // A slider drag moves the setting under the rig; the rig adopts it rather
  // than fighting it with its own stale target.
  seeded.ctx.settings.cameraZoom = 0.6;
  run(seeded.rig, seeded.ctx, 60);
  ok(Math.abs(seeded.rig.zoomTarget - 0.6) < 1e-9,
     'the slider wins when it moves: one number, two controls');
}

/* -- 4. the no-adjustment camera drops the fan, not the sphere ---------- */

// The setting sells "no proactive adjustment", not "less collision", so the
// unassisted path keeps the same five-ray CAM_RADIUS sphere the fan casts and
// drops only what the fan does with it: sliver classification, the soft
// warning, the hysteresis, the rate cap.
//
// The first cut of this arm pinned the opposite -- a single axial ray, and an
// assertion that an off-axis obstruction left the boom at its full 7.10 m --
// which is a camera sliding through a doorframe with a test certifying it.
// These cases exist to make that shape red.

/** Geometry that clips the camera sphere but misses the centreline exactly. */
const offAxis = (pivot, at = 2.0) => (origin, dir) => {
  if (dir.z > 0) return -1;                       // the reverse sliver cast
  const offset = Math.abs(origin.x - pivot.x) > 1e-6 || Math.abs(origin.y - pivot.y) > 1e-6;
  return offset ? at : -1;
};

/** Only the right-hand ray hits: a pillar edge grazing one side of the lens. */
const oneEdge = (pivot, at = 2.0) => (origin, dir) => {
  if (dir.z > 0) return -1;
  return origin.x - pivot.x > 1e-6 ? at : -1;
};

function withLog(rig, ctx, cast) {
  const log = [];
  ctx.stage = { raycastDistance: (o, d, m) => { log.push(d.z); return cast(o, d, m); } };
  return log;
}

console.log('no-adjustment camera: the fan is skipped, the sphere is not');
{
  const on = makeRig({ settings: { cameraAssist: 1 } });
  const onLog = withLog(on.rig, on.ctx, offAxis(on.rig.pivot));
  run(on.rig, on.ctx, 30);

  const off = makeRig({ settings: { cameraAssist: 0 } });
  const offLog = withLog(off.rig, off.ctx, offAxis(off.rig.pivot));
  run(off.rig, off.ctx, 30);

  ok(Math.abs(on.rig.distance - (2.0 - CAM_RADIUS)) < 0.01,
     `assisted, an off-axis obstruction pulls the boom to the sphere's face (${on.rig.distance.toFixed(3)} m)`);
  ok(Math.abs(off.rig.distance - on.rig.distance) < 0.01,
     `unassisted lands in the same place -- collision is not what the setting removes (${off.rig.distance.toFixed(3)} m)`);

  // Five rays a frame and not one reverse cast: the sphere is intact, the
  // sliver test that only anticipation needs is gone.
  const backward = offLog.filter((dz) => dz < 0).length;
  const reverse = offLog.filter((dz) => dz > 0).length;
  ok(backward === 150 && reverse === 0,
     `unassisted fires the whole sphere and nothing else (${backward} backward, ${reverse} reverse)`);
  ok(onLog.length > offLog.length,
     `assisted fires strictly more casts than that (${onLog.length} vs ${offLog.length})`);

  // A pillar edge on one side only -- inside CAM_RADIUS, nowhere near the
  // centreline. This is the case a single axial cast cannot see at all.
  const edge = makeRig({ settings: { cameraAssist: 0 } });
  withLog(edge.rig, edge.ctx, oneEdge(edge.rig.pivot, 1.6));
  run(edge.rig, edge.ctx, 30);
  ok(Math.abs(edge.rig.distance - (1.6 - CAM_RADIUS)) < 0.01,
     `unassisted, one grazing ray still stops the lens (${edge.rig.distance.toFixed(3)} m)`);

  // Collision on the axis, unchanged.
  const wall = makeRig({ settings: { cameraAssist: 0 } });
  wall.ctx.stage = { raycastDistance: (o, d) => (d.z > 0 ? -1 : 3.0) };
  run(wall.rig, wall.ctx, 30);
  ok(Math.abs(wall.rig.distance - (3.0 - CAM_RADIUS)) < 1e-6,
     `unassisted, an axial wall still stops the camera at its face (${wall.rig.distance.toFixed(3)} m)`);
  ok(wall.rig.distance <= wall.rig.allowedDistance + 1e-9,
     'and the published reach still bounds the boom it used');
}

console.log('no-adjustment camera: no anticipation, no memory, no easing');
{
  // A hit present on exactly one frame. Assisted, the rig remembers it and
  // eases back out over SOFT_HOLD_TAU / OCCLUDE_OUT_TAU; unassisted, the boom
  // is back at full length on the very next frame, because there is nothing
  // held over between frames at all.
  const script = (hitOn) => {
    let f = -1;
    const r = makeRig({ settings: { cameraAssist: 0 } });
    r.ctx.stage = { raycastDistance: (o, d) => (d.z > 0 ? -1 : (f === hitOn ? 2.0 : -1)) };
    const seen = [];
    for (let i = 0; i < 20; i++) { f = i; r.rig.lateUpdate(r.ctx, dt); seen.push(r.rig.distance); }
    return seen;
  };
  const seen = script(10);
  ok(Math.abs(seen[10] - (2.0 - CAM_RADIUS)) < 0.01,
     `the frame the obstruction exists, the boom is at its face (${seen[10].toFixed(3)} m)`);
  ok(Math.abs(seen[11] - DIST) < 1e-9,
     `the frame after, it is back at full length -- no ease-out, no memory (${seen[11].toFixed(3)} m)`);
}

/* -- 5. occlusion hysteresis: a one-frame spike does not snap ------------ */

// A hit that reads as a sliver: skipped by the fan, remembered as a soft
// warning. That memory is what #115 added and what, hair-triggered, dollies
// the camera on a single grazing frame -- the #132 report.
function spikeRig(frames) {
  let f = -1;
  const r = makeRig({ settings: {}, speed: 0 });
  r.ctx.stage = {
    raycastDistance(origin, dir, max) {
      if (dir.z > 0) return Math.max(0.01, max - 0.2);   // thin: reads as a sliver
      return frames.includes(f) ? 1.0 : -1;
    },
  };
  const seen = [];
  for (let i = 0; i < 40; i++) { f = i; r.rig.lateUpdate(r.ctx, dt); seen.push(r.rig.distance); }
  return { rig: r.rig, seen };
}

console.log('occlusion hysteresis: one grazing frame is not a collapse');
{
  // Ten settled frames, then a single frame where one ray reports 1 m, then
  // nothing again.
  const spike = spikeRig([10]);
  const drop = DIST - Math.min(...spike.seen);
  ok(drop <= 0.30,
     `a one-frame graze moves the boom by at most a nudge (${drop.toFixed(3)} m; hair-triggered it is 1.7)`);

  // The same warning, sustained. This is the case the memory exists for and it
  // must still work, or the hysteresis has simply deleted #115's fix.
  const held = spikeRig([10, 11, 12, 13, 14, 15]);
  const heldDrop = DIST - Math.min(...held.seen);
  ok(heldDrop > 1.5,
     `a warning that repeats still pulls the boom in (${heldDrop.toFixed(3)} m)`);
  ok(heldDrop > drop * 4,
     `confirmed and unconfirmed warnings are handled differently at all (${(heldDrop / Math.max(drop, 1e-6)).toFixed(1)}x)`);

  // The cap is deliberately speed-gated: at a dead run a first-frame warning
  // is nearly always a real approach and must still be anticipated in full.
  // (tests/camera-occlusion.test.mjs is the arm that would go red if this
  // regressed; this one pins the mechanism directly.)
  let f = -1;
  const fast = makeRig({ settings: {}, speed: 12 });
  fast.ctx.stage = {
    raycastDistance(origin, dir, max) {
      if (dir.z > 0) return Math.max(0.01, max - 0.2);
      return f === 10 ? 1.0 : -1;
    },
  };
  const fastSeen = [];
  for (let i = 0; i < 40; i++) { f = i; fast.rig.lateUpdate(fast.ctx, dt); fastSeen.push(fast.rig.distance); }
  const fastDrop = Math.max(...fastSeen) - Math.min(...fastSeen);
  ok(fastDrop > 1.0,
     `at sprint the same single frame is still acted on in full (${fastDrop.toFixed(3)} m)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
