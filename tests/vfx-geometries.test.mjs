/**
 * The four geometries added on 2026-08-23
 * (`docs/superpowers/plans/2026-08-23-new-vfx-geometries.md`), held to the
 * shapes they claim to be.
 *
 * Every assertion here is written against a *characteristic break* — the way
 * each geometry silently degrades into something the vocabulary could already
 * draw, which is the only failure mode that would survive a screenshot:
 *
 *   sector  — the aperture is ignored and a full ring is drawn
 *   helix   — nothing rotates about the path, or the radius does not climb
 *   vortex  — the radial velocity points the wrong way (i.e. it is a helix)
 *   chain   — the links do not meet, or the path misses its own endpoints
 *
 * Each of those is checked by a claim that goes false the moment the break is
 * introduced, and several are checked by *running the guard against a broken
 * input* as well, so no assertion here is one that has never been seen to fail.
 *
 * The other half is resource return, which is this repo's recurring defect
 * shape: every pool the geometries claim slots in must be back at its baseline
 * once the lifetimes expire, and the showcase must leave nothing live behind.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  VFX, SectorPool, BeamPool, axisBasis, sectorMask, helixSample, chainNode,
  SECTOR_EDGE_SOFT,
} from '../src/systems/VFX.js';
import { GEOMETRY_DEMOS, ELEMENTS } from '../src/data/effects.js';
import { FRAME_FAMILIES } from '../tools/bucket-effects.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`PASS  ${msg}`); } else { fail++; console.log(`FAIL  ${msg}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const scene = () => ({ scene: { add() {} } });

/* ============================================================ G-1 sector */

console.log('-- G-1 sector: the aperture is load-bearing');
{
  const half = Math.PI / 6;   // a 60-degree wedge
  // Dead ahead is inside; a right angle away and dead behind are outside.
  ok(sectorMask(0, 1, 0, 1, half) === 1, 'a point on the facing is fully inside the arc');
  ok(sectorMask(1, 0, 0, 1, half) === 0, 'a point 90 degrees off the facing is clipped');
  ok(sectorMask(0, -1, 0, 1, half) === 0, 'a point behind the facing is clipped');
  // Just inside and just outside the declared half-aperture, which is the edge
  // an "aperture ignored" implementation gets wrong in one direction only.
  const inAng = half * 0.8, outAng = half * 1.2;
  ok(sectorMask(Math.sin(inAng), Math.cos(inAng), 0, 1, half) > 0,
    'a point inside the half-aperture survives');
  ok(sectorMask(Math.sin(outAng), Math.cos(outAng), 0, 1, half) === 0,
    'a point outside the half-aperture does not');

  // THE break. A sector that ignores its aperture draws every direction, i.e.
  // it is a ring. That is exactly what a half-aperture of PI means, and the
  // narrow arc must NOT behave like it.
  const dirs = 24;
  let liveNarrow = 0, liveFull = 0;
  for (let i = 0; i < dirs; i++) {
    const a = (i / dirs) * Math.PI * 2;
    if (sectorMask(Math.sin(a), Math.cos(a), 0, 1, half) > 0) liveNarrow++;
    if (sectorMask(Math.sin(a), Math.cos(a), 0, 1, Math.PI) > 0) liveFull++;
  }
  ok(liveFull === dirs, 'a half-aperture of PI IS the full ring — the shape the language already had');
  ok(liveNarrow > 0 && liveNarrow < dirs / 3,
    `and a PI/6 arc lights ${liveNarrow}/${dirs} directions, not all of them (the "aperture ignored" mutation)`);

  // The soft edge is a fade, not a second hard cut: the mask has to be
  // strictly between 0 and 1 somewhere, or there is no antialiasing at all.
  const lim = Math.cos(half);
  const grazeCos = lim + SECTOR_EDGE_SOFT * 0.5;
  const g = Math.acos(Math.min(1, grazeCos));
  const m = sectorMask(Math.sin(g), Math.cos(g), 0, 1, half);
  ok(m > 0 && m < 1, `the arc's bounding radius is soft, not stepped (mask ${m.toFixed(3)})`);
}

console.log('\n-- G-1 sector: the shader carries the clip, and the ring does not');
{
  const src = readFileSync(new URL('../src/systems/VFX.js', import.meta.url), 'utf8');
  const frag = src.slice(src.indexOf('const SectorFrag'), src.indexOf('Instanced ground arcs'));
  const ringFrag = src.slice(src.indexOf('const RingFrag'), src.indexOf('/** Instanced expanding shockwave rings'));

  ok(/float\s+sectorMask\s*\(/.test(frag) && /wedge\s*<=\s*0\.0\)\s*discard/.test(frag),
    'SectorFrag clips its fragments on the aperture');
  // The negative control: the same scan over the fragment shader that draws
  // the shape a broken sector degrades into. If this ever matched, the scan
  // above would be proving nothing.
  ok(!/sectorMask/.test(ringFrag),
    'and the same scan finds no clip in RingFrag — the guard can tell them apart');
  // One declared soft-edge width, interpolated, so the GLSL and its JS twin
  // cannot drift into disagreeing about where the arc ends.
  ok(/\$\{SECTOR_EDGE_SOFT\.toFixed\(/.test(frag),
    `SectorFrag interpolates the declared edge width (${SECTOR_EDGE_SOFT}) rather than typing a second one`);
  ok((frag.match(/0\.06/g) || []).length === 0,
    'and carries no hand-typed copy of it that could drift');
}

console.log('\n-- G-1 sector: the pool takes slots and gives them back');
{
  const p = new SectorPool(scene(), 8);
  ok(p.live === 0, 'a fresh pool has nothing live');
  p.spawn(V(0, 0, 0), V(0, 1, 0), V(0, 0, 1), Math.PI / 6, 0xff7a2a, 0.5, 6, 0.4, 1);
  p.spawn(V(3, 0, 0), V(0, 1, 0), V(1, 0, 0), Math.PI / 3, 0xff7a2a, 0.5, 6, 0.4, 1);
  ok(p.live === 2, 'two arcs claim two slots');

  // The half-aperture is what the instance actually records — an implementation
  // that dropped it on the floor would still pass every "did not throw" test.
  ok(near(p.aShape.array[3], Math.PI / 6, 1e-5) && near(p.aShape.array[7], Math.PI / 3, 1e-5),
    'each instance records its own aperture');
  ok(near(p.aFacing.array[2], 1) && near(p.aFacing.array[3], 1),
    'and its own facing');

  // A caller cannot widen an arc to a full ring by accident, nor collapse one
  // to nothing: the clamp is (0, PI].
  p.spawn(V(0, 0, 0), V(0, 1, 0), V(0, 0, 1), 9, 0xff7a2a, 0.5, 6, 0.4, 1);
  p.spawn(V(0, 0, 0), V(0, 1, 0), V(0, 0, 1), -1, 0xff7a2a, 0.5, 6, 0.4, 1);
  ok(near(p.aShape.array[11], Math.PI, 1e-6), 'an over-wide aperture clamps to PI, the full ring');
  ok(p.aShape.array[15] > 0, 'and a negative one clamps above zero rather than vanishing');

  for (let i = 0; i < 30; i++) p.update(1 / 60, null);
  ok(p.live === 0, 'and every slot is back at baseline once the lifetimes expire');
}

/* ==================================================== G-2 / G-3 the lace */

console.log('\n-- G-2 helix: it rotates about the path');
{
  const o = { from: V(0, 0, 0), to: V(0, 6, 0), count: 25, turns: 2, radius: 1.2, inward: false };
  const s = {};
  let sweep = 0, lastAng = null, minR = Infinity, maxR = -Infinity;
  let monotone = true, allSameAngle = true;
  for (let k = 0; k < o.count; k++) {
    helixSample(s, k, o);
    if (lastAng !== null) {
      const d = s.angle - lastAng;
      if (d <= 0) monotone = false;
      if (Math.abs(d) > 1e-9) allSameAngle = false;
      sweep += d;
    }
    lastAng = s.angle;
    const r = Math.hypot(s.px, s.pz);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
  }
  ok(!allSameAngle, 'successive lace points are at different angles about the path');
  ok(monotone, 'and the angle advances one way the whole length — a spiral, not a wobble');
  ok(near(sweep, o.turns * Math.PI * 2, 1e-9),
    `the lace sweeps exactly ${o.turns} turns (${sweep.toFixed(4)} rad)`);
  ok(near(minR, o.radius, 1e-9) && near(maxR, o.radius, 1e-9),
    'a helix holds its radius the whole way up — it is a spiral, not a cone');

  // The velocity turns with the path. A lace whose particles all flew straight
  // out would draw a helix for one frame and a starburst thereafter, which is
  // the "no rotation about the path" break stated in motion rather than shape.
  let minTang = Infinity;
  for (let k = 0; k < o.count; k++) {
    helixSample(s, k, o);
    minTang = Math.min(minTang, s.vx * s.tangX + s.vy * s.tangY + s.vz * s.tangZ);
  }
  ok(minTang > 0, `every lace particle carries a tangential component (min ${minTang.toFixed(3)})`);

  // And it climbs. Rising is half of what §1.4 reads off this shape.
  helixSample(s, 0, o);
  const y0 = s.py;
  helixSample(s, o.count - 1, o);
  ok(s.py - y0 > 5, `the lace spans the path it was given (${(s.py - y0).toFixed(2)} m of 6)`);
}

console.log('\n-- G-3 vortex: the same lace, with the radial sign inverted');
{
  const base = { from: V(0, 5, 0), to: V(0, 0, 0), count: 20, turns: 3, radius: 2.5 };
  const out = { ...base, inward: false };
  const inn = { ...base, inward: true };
  const a = {}, b = {};

  let outRadial = Infinity, innRadial = -Infinity;
  for (let k = 0; k < base.count; k++) {
    helixSample(a, k, out);
    helixSample(b, k, inn);
    outRadial = Math.min(outRadial, a.vx * a.radialX + a.vy * a.radialY + a.vz * a.radialZ);
    innRadial = Math.max(innRadial, b.vx * b.radialX + b.vy * b.radialY + b.vz * b.radialZ);
  }
  ok(outRadial > 0, `the helix pushes outward everywhere (min ${outRadial.toFixed(3)})`);
  ok(innRadial < 0, `the vortex pulls inward everywhere (max ${innRadial.toFixed(3)})`);
  // Stated as the mutation: swap `inward` and these two claims swap with it.
  ok(outRadial > 0 && innRadial < 0 && Math.sign(outRadial) !== Math.sign(innRadial),
    'the two geometries differ in radial SIGN — the "wrong radial direction" break');

  // The vortex closes on its endpoint; the helix does not. This is the shape
  // half of the same difference.
  helixSample(b, base.count - 1, inn);
  ok(near(b.radius, 0, 1e-9), 'the vortex arrives at its endpoint with zero radius');
  helixSample(a, base.count - 1, out);
  ok(near(a.radius, base.radius, 1e-9), 'while the helix arrives still at full radius');

  // Spin is NOT flipped: a vortex is a helix falling in, not one played
  // backwards. Same angle sequence, opposite radial velocity.
  let sameSpin = true;
  for (let k = 0; k < base.count; k++) {
    helixSample(a, k, out); helixSample(b, k, inn);
    if (!near(a.angle, b.angle, 1e-12)) sameSpin = false;
  }
  ok(sameSpin, 'and both run the same way round — they separate on motion, not on handedness');
}

console.log('\n-- G-2/G-3: the emitter hands every point to the particle pool, and keeps nothing');
{
  const seen = [];
  const vfx = Object.create(VFX.prototype);
  vfx._e = {};
  vfx._ep0 = new THREE.Vector3();
  vfx._ed0 = new THREE.Vector3(0, 1, 0);
  vfx._ei0 = new THREE.Vector3();
  vfx._ec0 = new THREE.Color();
  vfx._ec1 = new THREE.Color();
  vfx.particles = {
    emit(o) {
      seen.push({ o, x: o.position.x, y: o.position.y, z: o.position.z, frame: o.frame });
    },
  };

  const n = vfx.helixLace(V(0, 0, 0), V(0, 4, 0), ELEMENTS.restorative.hue, { count: 12 });
  ok(n === 12 && seen.length === 12, 'the lace emits exactly one particle per sample point');
  ok(seen.every((s) => s.o === seen[0].o),
    'through the one shared options scratch — the emitter allocates nothing per particle');
  // Positions are the sample positions, not a puff at the origin.
  const s0 = {};
  helixSample(s0, 0, { from: V(0, 0, 0), to: V(0, 4, 0), count: 12, turns: 2.5, radius: 0.9 });
  ok(near(seen[0].x, s0.px, 1e-9) && near(seen[0].z, s0.pz, 1e-9),
    'and each lands on the point `helixSample` computed for it');

  seen.length = 0;
  vfx.vortexDraw(V(0, 4, 0), V(0, 0, 0), ELEMENTS.gravity.hue, { count: 9 });
  ok(seen.length === 9, 'the vortex runs the same emitter');
  ok(seen[0].frame !== undefined && seen.every((s) => s.frame === seen[0].frame),
    'on a single frame family, as §1.3 requires of one family');

  // Nothing is retained. A geometry that stashed its samples would grow a leak
  // one lace at a time, and the pool it feeds is a ring buffer that would never
  // report it.
  const before = Object.keys(vfx).length;
  for (let i = 0; i < 20; i++) vfx.helixLace(V(0, 0, 0), V(0, 4, 0), ELEMENTS.restorative.hue);
  ok(Object.keys(vfx).length === before, 'twenty more laces add no state to the VFX layer');
}

/* ============================================================= G-4 chain */

console.log('\n-- G-4 chain: the links meet, and the path lands on its endpoints');
{
  const o = { from: V(-4, 1, 0), to: V(4, 1, 3), segments: 6, jitter: 0.5, seed: 3 };
  const nodes = [];
  for (let i = 0; i <= o.segments; i++) {
    const n = {};
    chainNode(n, i, o);
    nodes.push(n);
  }
  ok(near(nodes[0].x, o.from.x) && near(nodes[0].y, o.from.y) && near(nodes[0].z, o.from.z),
    'node 0 IS the hop origin, exactly');
  const last = nodes[o.segments];
  ok(near(last.x, o.to.x) && near(last.y, o.to.y) && near(last.z, o.to.z),
    'and the last node IS the hop target, exactly — the "endpoints wrong" break');

  // It is jagged. A path whose interior nodes sit on the straight line is a
  // BeamPool segment with extra steps.
  let maxOff = 0;
  for (let i = 1; i < o.segments; i++) {
    const t = i / o.segments;
    const bx = o.from.x + (o.to.x - o.from.x) * t;
    const by = o.from.y + (o.to.y - o.from.y) * t;
    const bz = o.from.z + (o.to.z - o.from.z) * t;
    maxOff = Math.max(maxOff, Math.hypot(nodes[i].x - bx, nodes[i].y - by, nodes[i].z - bz));
  }
  ok(maxOff > 0.1, `the interior nodes leave the straight line (max ${maxOff.toFixed(2)} m)`);

  // Deterministic, so the same bolt drawn twice is the same bolt — and so this
  // test is testing the geometry rather than a random number.
  const again = {};
  chainNode(again, 3, o);
  ok(near(again.x, nodes[3].x) && near(again.z, nodes[3].z), 'and the jag is deterministic in its seed');
  chainNode(again, 3, { ...o, seed: 99 });
  ok(!near(again.x, nodes[3].x) || !near(again.z, nodes[3].z), 'while a different seed draws a different bolt');
}

console.log('\n-- G-4 chain: the drawn segments are contiguous through every hop');
{
  const spawns = [];
  const beams = { spawn: (a, b) => spawns.push({ a: a.clone(), b: b.clone() }) };
  const vfx = Object.create(VFX.prototype);
  vfx.beams = beams;

  const hops = [V(-5, 1.2, 0), V(0, 1.6, 2.5), V(5, 1.2, 0)];
  const drawn = vfx.chainBolt(hops, ELEMENTS.shock.hue, { segments: 4, jitter: 0.4, seed: 3 });
  ok(drawn === 8, `two hops of four links draw ${drawn} links`);
  ok(spawns.length === 16, 'each doubled with a white core, the way every other beam here is');

  // Every rim segment's end is the next one's start. THE break: a chain that
  // recomputed its nodes per-segment, or jittered both ends independently,
  // draws a dashed line of disconnected sparks and looks nearly right in a
  // still frame.
  const rim = spawns.filter((_, i) => i % 2 === 0);
  let contiguous = true, worst = 0;
  for (let i = 0; i < rim.length - 1; i++) {
    // The seam between the two hops is the one place a break would hide: the
    // last link of hop 0 must meet the first link of hop 1.
    const gap = rim[i].b.distanceTo(rim[i + 1].a);
    worst = Math.max(worst, gap);
    if (gap > 1e-9) contiguous = false;
  }
  ok(contiguous, `every link starts where the last one ended (worst gap ${worst.toExponential(1)} m)`);
  ok(rim[0].a.distanceTo(hops[0]) < 1e-9, 'the first link starts at the first waypoint');
  ok(rim[rim.length - 1].b.distanceTo(hops[2]) < 1e-9, 'and the last link ends at the last');
  // The seam specifically, named rather than merely covered by the loop above.
  ok(rim[3].b.distanceTo(hops[1]) < 1e-9 && rim[4].a.distanceTo(hops[1]) < 1e-9,
    'and both sides of the hop seam meet at the waypoint itself');

  // And a degenerate call draws nothing rather than throwing or drawing a
  // zero-length beam.
  ok(vfx.chainBolt([V(0, 0, 0)], ELEMENTS.shock.hue) === 0, 'a single waypoint draws nothing');
  ok(vfx.chainBolt(null, ELEMENTS.shock.hue) === 0, 'and neither does no path at all');
}

console.log('\n-- G-4 chain: the beam pool it borrows returns to baseline');
{
  const p = new BeamPool(scene(), 64);
  const vfx = Object.create(VFX.prototype);
  vfx.beams = p;
  ok(p.live === 0, 'a fresh beam pool has nothing live');
  vfx.chainBolt([V(-5, 1, 0), V(0, 1, 2), V(5, 1, 0)], ELEMENTS.shock.hue,
    { segments: 4, life: 0.14 });
  ok(p.live === 16, `the bolt claims ${p.live} slots`);
  for (let i = 0; i < 20; i++) p.update(1 / 60);
  ok(p.live === 0, 'and every one is back at baseline once the lifetimes expire');
}

/* =============================================== colour purity, #160 again */

console.log('\n-- the new methods draw only declared hues');
{
  // The mutation this is written against was demonstrated, not theorised (see
  // `tests/argent-legibility.test.mjs`): a hue typed at a VFX call site is
  // outside `assertLanguage`'s walk and outside every bucketing check, and
  // planting full magenta on one left the whole suite green. So the four new
  // methods must carry no colour literal of their own — every hue arrives as
  // an argument, from `ELEMENTS`.
  // `enemyMend` (#163) joins this scan rather than the purity one: it carries
  // neither a `PURITY_STEMS` word in its name nor a `PURITY.` read, so it was
  // outside `argent-legibility.test.mjs`'s two derivations by construction —
  // the exact class that file's own comment names as this issue's business.
  const METHODS = ['sectorTelegraph', 'helixLace', 'vortexDraw', 'chainBolt', 'enemyMend'];
  for (const name of METHODS) {
    const body = VFX.prototype[name].toString();
    const literals = body.match(/0x[0-9a-fA-F]{6}/g) || [];
    ok(literals.length === 0,
      `${name} carries no raw colour literal (found: ${literals.join(', ') || 'none'})`);
  }
  // The scan can fail. This is the same regex run over a body that genuinely
  // has one, so "no literals found" is a measurement rather than an assumption
  // about the regex.
  const planted = 'function f() { this.rings.spawn(pos, UP, 0xff00ff, 1, 2, 0.5); }';
  ok((planted.match(/0x[0-9a-fA-F]{6}/g) || []).length === 1,
    'and the scan catches a planted literal — it is a guard that can fail');

  // The other half of the seam: the showcase's demo hues come off the declared
  // table, so there is nothing for the scan to miss at the call site either.
  const showcase = readFileSync(new URL('../src/core/Showcase.js', import.meta.url), 'utf8');
  const draw = showcase.slice(showcase.indexOf('const GEOMETRY_DRAW'), showcase.indexOf('/* ------------------------------------------------------------- presets'));
  ok((draw.match(/0x[0-9a-fA-F]{6}/g) || []).length === 0,
    'the showcase demos carry no hex either');
  ok(/ELEMENTS\[def\.element\]\.hue/.test(showcase),
    'they read their hue off `ELEMENTS`, the table `assertLanguage` walks');
}

/* ====================================================== the language knows */

console.log('\n-- the three new frame families are registered, not improvised');
{
  for (const f of ['sector', 'helix', 'chain']) {
    ok(f in FRAME_FAMILIES, `'${f}' is declared in bucket-effects' frame map`);
  }
  const doc = readFileSync(new URL('../docs/art/EFFECT-LANGUAGE.md', import.meta.url), 'utf8');
  const s13 = doc.slice(doc.indexOf('### 1.3'), doc.indexOf('### 1.4'));
  for (const f of ['sector', 'helix', 'chain']) {
    ok(s13.includes(`**${f}**`), `and §1.3 names '${f}' as a shape family`);
  }
  // Every family the doc's table names must be in the map and vice versa —
  // the registration is only worth anything if the two halves cannot drift.
  for (const id of Object.keys(GEOMETRY_DEMOS)) {
    ok(GEOMETRY_DEMOS[id].frame in FRAME_FAMILIES,
      `the ${id} demo names a declared family`);
  }
  // And no gameplay table has adopted one yet — this wave is vocabulary only,
  // which is a promise worth holding rather than remembering.
  const items = readFileSync(new URL('../src/data/items.js', import.meta.url), 'utf8');
  const equip = readFileSync(new URL('../src/data/equipment.js', import.meta.url), 'utf8');
  const eff = readFileSync(new URL('../src/data/effects.js', import.meta.url), 'utf8');
  const adopted = [/frame:\s*'sector'/, /frame:\s*'helix'/, /frame:\s*'chain'/]
    .filter((re) => re.test(items) || re.test(equip)
      || re.test(eff.slice(eff.indexOf('export const ITEM_EFFECTS'))));
  ok(adopted.length === 0, 'no gameplay row adopts a new geometry yet — vocabulary only, as scoped');
}

/* ============================== the showcase leaves nothing behind ======= */

console.log('\n-- firing all four demos and closing the instrument returns everything');
{
  // The thinnest DOM the overlay can be built against, same shape as
  // `tests/showcase-surface.test.mjs` uses.
  const el = () => {
    const node = {
      style: { cssText: '' }, textContent: '', innerHTML: '', id: '', children: [],
      append: (...k) => node.children.push(...k),
      appendChild: (k) => { node.children.push(k); return k; },
      scrollIntoView() {}, remove() { node.removed = true; },
    };
    return node;
  };
  globalThis.document = { createElement: el, body: el() };
  const listeners = [];
  globalThis.window = {
    addEventListener: (t, fn, cap) => listeners.push({ t, fn, cap }),
    removeEventListener: (t, fn, cap) => {
      const i = listeners.findIndex((l) => l.t === t && l.fn === fn && l.cap === cap);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  const sectors = new SectorPool(scene(), 8);
  const beams = new BeamPool(scene(), 128);
  let emitted = 0;
  const vfx = Object.create(VFX.prototype);
  vfx._e = {};
  vfx._ep0 = new THREE.Vector3();
  vfx._ed0 = new THREE.Vector3(0, 1, 0);
  vfx._ec0 = new THREE.Color();
  vfx._ec1 = new THREE.Color();
  vfx.sectors = sectors;
  vfx.beams = beams;
  // `releaseHeld` walks the downed-marker map on the way out, so the partial
  // VFX has to carry the real one — the point of this block is the teardown.
  vfx._downed = new Map();
  vfx.particles = { emit: () => { emitted++; } };

  const { installShowcase } = await import('../src/core/Showcase.js');
  const api = installShowcase({
    camera: { position: { x: 0, y: 2, z: 0 }, getWorldDirection: (v) => v.set(0, 0, -1) },
    stage: { sampleHeight: () => 0 },
    vfx,
  });

  for (const id of Object.keys(GEOMETRY_DEMOS)) {
    ok(api.fire(`geometry:${id}`) === true, `the ${id} demo fires down the real VFX method`);
  }
  ok(sectors.live > 0 && beams.live > 0 && emitted > 0,
    `the four demos claim real resources (${sectors.live} arcs, ${beams.live} beams, ${emitted} particles)`);

  // The geometry demos are one-shots with sub-second lifetimes: the pools age
  // back to baseline on their own, with or without close()/dispose() (those
  // sweep tracked demonstrators and held voices, which these entries never
  // create). The two `live` assertions below therefore prove self-cleaning by
  // lifetime, not a close/dispose-dependent sweep; only the listener assertion
  // exercises dispose().
  api.close();
  api.dispose();
  for (let i = 0; i < 90; i++) { sectors.update(1 / 60, null); beams.update(1 / 60); }
  ok(sectors.live === 0, 'the sector pool self-cleans back to baseline by lifetime');
  ok(beams.live === 0, 'and so does the beam pool');
  ok(!listeners.some((l) => l.t === 'keydown'),
    'and the key handler is gone — the instrument holds no listener either');
}

/* ------------------------------------------------------------- the basis */

console.log('\n-- the CPU basis is the one the shaders use');
{
  const b = {};
  axisBasis({ x: 0, y: 1, z: 0 }, b);
  ok(near(Math.hypot(b.bx, b.by, b.bz), 1) && near(Math.hypot(b.cx, b.cy, b.cz), 1),
    'the basis is orthonormal on a vertical axis');
  ok(near(b.bx * b.cx + b.by * b.cy + b.bz * b.cz, 0, 1e-12), 'and its two tangents are perpendicular');
  ok(near(b.bx * b.nx + b.by * b.ny + b.bz * b.nz, 0, 1e-12), 'and both perpendicular to the axis');
  // The degenerate pick is at |n.y| > 0.95, exactly as `RingVert` writes it;
  // an axis either side of that must still produce a usable basis.
  for (const a of [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0.3, y: 0.94, z: 0 }]) {
    axisBasis(a, b);
    ok(Number.isFinite(b.bx) && near(Math.hypot(b.bx, b.by, b.bz), 1, 1e-9),
      `a basis survives an axis at (${a.x}, ${a.y}, ${a.z})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
