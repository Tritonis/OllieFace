/**
 * The logbook's preview camera re-solves its standoff from real bounds — and
 * must not solve it from a layout that has not actually happened yet, or from
 * a cache a rejected read was allowed to corrupt.
 *
 *   node tests/model-preview-framing.test.mjs
 *
 * Issue #131: a packaged-build playtest found the Select Survivor preview
 * sometimes half off the top of the panel after switching survivors. Failure
 * shapes, all in `ModelPreview` (src/ui/Logbook.js):
 *
 *  1. a genuine aspect change must re-solve the camera distance;
 *  2. a panel caught mid-reflow (a tab still animating in, `display:none`)
 *     can report zero on either axis. The old code clamped that to 1px and
 *     wrote the clamped size into `_w`/`_h`, poisoning the cache so the next
 *     *real* resize matched it and was skipped too. The fix rejects the read
 *     outright, which the cache itself must prove — not just the visible
 *     symptom, since a differently-poisoned cache can still happen to leave
 *     the symptom looking fine (round 1 of this file's own review);
 *  3. `setSubject()` (survivor switch) must re-solve against live layout, not
 *     whatever aspect the last resize/tick happened to leave cached;
 *  4. `_watch()` — the ResizeObserver wiring `mount()` calls — must actually
 *     observe the host and re-frame when the observer fires, and `dispose()`
 *     must disconnect it so a late callback is inert.
 *
 * No WebGL context here (`mount()` never runs — it needs real GL this repo's
 * tests don't have) — `resize()`/`frame()`/`_watch()` are exercised directly
 * against a hand-set camera/renderer/pivot, the same headless-real-THREE
 * idiom `tests/camera-occlusion.test.mjs` uses. `_watch()` is the exact code
 * `mount()` runs to wire the observer, split out for this reason.
 *
 * One more claim, riding the same fix: `renderDetail()` used to leak a GL
 * context per visit to a viewer-less entry (item/challenge/codex/career/run)
 * reached right after a viewer entry — its `innerHTML` swap detaches the old
 * stage without ever calling `preview.dispose()`, and the new ResizeObserver
 * would have kept that detached host alive forever. `Logbook.closePreview()`
 * is the fix's unit; it is exercised directly below rather than through the
 * full `Logbook` (which needs a real `document` this repo's tests don't set
 * up).
 */
import * as THREE from 'three';
import { ModelPreview, Logbook } from '../src/ui/Logbook.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A hand-built ResizeObserver stub — there is no jsdom in this repo. */
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; }
  observe(target) { this.targets.push(target); }
  disconnect() { this.disconnected = true; }
}

/** A ModelPreview with a fake host and a fake renderer, bypassing mount(). */
function rigged(w, h) {
  const host = { clientWidth: w, clientHeight: h, appendChild() {} };
  const mp = new ModelPreview(host);
  mp.renderer = { setSize() {}, dispose() {}, forceContextLoss() {}, domElement: { remove() {} } };
  mp.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  mp.pivot = new THREE.Group();
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

// --- claim 2: a rejected zero-size read must not touch the cache -------
// This is the actual mechanism, not the symptom: the old code's bug was that
// a rejected read still wrote `_w`/`_h`, which is what let a later real
// resize match the poisoned cache and get skipped. Asserting the cache
// itself discriminates in a way the visible symptom alone does not.
{
  const mp = rigged(400, 250);
  mp.resize();
  const goodW = mp._w, goodH = mp._h;
  const goodPos = mp.camera.position.clone();
  const goodAspect = mp.camera.aspect;

  mp.host.clientHeight = 0; // mid-reflow: display:none or a collapsing flex box
  mp.resize();

  ok(mp._w === goodW && mp._h === goodH, 'a rejected zero-size read leaves _w/_h untouched');
  ok(mp.camera.aspect === goodAspect, 'a rejected zero-size read leaves the last-good aspect alone');
  ok(
    Number.isFinite(mp.camera.position.x) &&
      Number.isFinite(mp.camera.position.y) &&
      Number.isFinite(mp.camera.position.z),
    'a zero-height read never pushes NaN/Infinity into the camera transform'
  );
  ok(mp.camera.position.equals(goodPos), 'the camera does not move on a rejected zero-size read');

  // Layout recovers to a real size — must not be swallowed by a poisoned cache.
  mp.host.clientHeight = 300;
  mp.resize();
  ok(mp.camera.aspect !== goodAspect, 'the next real resize after a zero-size read still re-frames');
}

// --- claim 3: setSubject() re-solves against live layout, not a stale cache
{
  const mp = rigged(300, 300);
  mp.resize(); // caches the 1:1 aspect

  mp.host.clientWidth = 600; // panel reflowed to 2:1 without a resize() call in between
  mp.host.clientHeight = 300;

  const subject = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mp.setSubject(subject, {});

  ok(mp._w === 600 && mp._h === 300, 'setSubject() re-checks the live host size');
  ok(Math.abs(mp.camera.aspect - 2) < 1e-9, 'setSubject() frames against the live aspect, not the stale one');
}

// --- claim 4: _watch() wires the observer, and dispose() disconnects it --
{
  const realRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  try {
    const mp = rigged(300, 300);
    mp.resize();
    mp._watch();

    ok(mp._ro instanceof FakeResizeObserver, '_watch() creates a ResizeObserver');
    ok(mp._ro.targets.includes(mp.host), '_watch() observes the preview host');

    mp.host.clientWidth = 900; // a box change the observer would report
    mp._ro.cb();
    ok(Math.abs(mp.camera.aspect - 3) < 1e-9, 'firing the observed callback re-frames from the new box');

    const ro = mp._ro;
    mp.dispose();
    ok(ro.disconnected, 'dispose() disconnects the ResizeObserver');
  } finally {
    globalThis.ResizeObserver = realRO;
  }
}

// --- claim 5: closePreview() tears the context down, not just the subject
{
  let disposed = false;
  const fakeThis = { preview: { dispose: () => { disposed = true; } } };
  Logbook.prototype.closePreview.call(fakeThis);
  ok(disposed && fakeThis.preview === null, 'closePreview() disposes the preview and drops the reference');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
