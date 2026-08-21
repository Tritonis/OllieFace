/**
 * The logbook's preview camera re-solves its standoff from real bounds — and
 * must not solve it from a layout that has not actually happened yet.
 *
 *   node tests/model-preview-framing.test.mjs
 *
 * Issue #131: a packaged-build playtest found the Select Survivor preview
 * sometimes half off the top of the panel after switching survivors. Two
 * failure shapes, both in `ModelPreview.resize()`/`frame()` (src/ui/Logbook.js):
 *
 *  1. a genuine aspect change must re-solve the camera distance — a `resize()`
 *     that early-returns on a cached size, or a `frame()` that ignores the new
 *     aspect, ships a subject framed for the wrong panel;
 *  2. a panel caught mid-reflow (a tab still animating in, `display:none`)
 *     can report zero on either axis. The old code clamped that to 1px,
 *     computed a nonsense aspect, and — because it wrote that nonsense size
 *     into `_w`/`_h` — poisoned the cache so the *next real* resize saw no
 *     change and skipped re-framing too. The fix must skip the frame outright
 *     on a zero-size read, not paper over it with a 1px floor.
 *
 * No WebGL context here (`mount()` never runs) — `resize()`/`frame()` are
 * exercised directly against a hand-set camera and framing, the same
 * headless-real-THREE idiom `tests/camera-occlusion.test.mjs` uses.
 */
import * as THREE from 'three';
import { ModelPreview } from '../src/ui/Logbook.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A ModelPreview with a fake host and a fake renderer, bypassing mount(). */
function rigged(w, h) {
  const host = { clientWidth: w, clientHeight: h, appendChild() {} };
  const mp = new ModelPreview(host);
  mp.renderer = { setSize() {} };
  mp.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  // A wide-relative-to-tall subject (radius term dominates) so a narrowed
  // aspect visibly moves the solved distance — the Colossus shape frame()'s
  // own comment calls out.
  mp._framing = { height: 0.6, radius: 1.6, lift: 0 };
  return mp;
}

// --- claim 1: an aspect change re-solves the camera --------------------
{
  const mp = rigged(300, 300);
  mp.resize();
  const distSquare = mp.camera.position.z;
  const aspectSquare = mp.camera.aspect;

  mp.host.clientWidth = 900; // same height, much wider panel
  mp.resize();
  const distWide = mp.camera.position.z;
  const aspectWide = mp.camera.aspect;

  ok(aspectWide !== aspectSquare, 'resize() picks up the new aspect ratio');
  ok(distWide !== distSquare, 'frame() re-solves the standoff for the new aspect');
  ok(Number.isFinite(distWide) && distWide > 0, 'the re-solved distance is a sane finite number');
}

// --- claim 2: a zero-size reflow neither poisons state nor produces NaN --
{
  const mp = rigged(400, 250);
  mp.resize();
  const goodPos = mp.camera.position.clone();
  const goodAspect = mp.camera.aspect;

  mp.host.clientHeight = 0; // mid-reflow: display:none or a collapsing flex box
  mp.resize();

  ok(mp.camera.aspect === goodAspect, 'a zero-height read leaves the last-good aspect alone');
  ok(
    Number.isFinite(mp.camera.position.x) &&
      Number.isFinite(mp.camera.position.y) &&
      Number.isFinite(mp.camera.position.z),
    'a zero-height read never pushes NaN/Infinity into the camera transform'
  );
  ok(mp.camera.position.equals(goodPos), 'the camera does not move on a rejected zero-size read');

  // Layout recovers to a real, different size — this must NOT be swallowed by
  // a cache the zero-size read poisoned.
  mp.host.clientHeight = 300;
  mp.resize();
  ok(mp.camera.aspect !== goodAspect, 'the next real resize after a zero-size read still re-frames');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
