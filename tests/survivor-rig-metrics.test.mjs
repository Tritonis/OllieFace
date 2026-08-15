// tests/survivor-rig-metrics.test.mjs
//
// The gameplay surface of survivor geometry, pinned per survivor.
//
// Why this file exists. #20 made Anvil squat for silhouette separation — pelvis
// 0.80 -> 0.60 with the legs shortened by the same 0.20 m so the boots stay
// planted. Everything above the pelvis rode down with it, including the gun in
// the right hand and therefore `getMuzzle()`, which is the origin of every aim
// ray (`src/entities/Player.js:1243`, `fireRay`) and the anchor of roughly ten
// VFX spawns in `src/data/abilities.js`. Anvil's rest-pose muzzle went 0.860 ->
// 0.660 m and its crown 1.693 -> 1.493 m.
//
// Nothing caught it. `gate:sp`, `gate:mp1` and `gate:elite` all run the default
// survivor and reported "no fields moved" truthfully while being structurally
// blind to a per-survivor rig change; `tests/readability-gate.test.mjs` re-grades
// a *committed silhouette record* rather than live geometry, so a changed
// survivor leaves it green. **No gate selected a survivor.** That is the hole,
// and this file is the plug: it builds every rig in `SURVIVORS` live and pins
// the two numbers that reach gameplay.
//
// Read the pins as a contract, not as magic constants. Moving one is allowed —
// deliberately, in the same change, with the new value written here and the
// reason in the commit. What is not allowed is moving one by accident inside a
// change framed as art.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CharacterMesh } from '../src/entities/CharacterMesh.js';
import { SURVIVORS } from '../src/data/survivors.js';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const near = (got, want, tol, msg) =>
  ok(Math.abs(got - want) <= tol, `${msg} — ${got.toFixed(4)} (want ${want.toFixed(4)} +/- ${tol})`);

// `Player`'s capsule and its mesh-less aim origin. Both are module-private in
// `src/entities/Player.js`, so they are transcribed here and then re-read from
// source below — a pin that cites a constant it never checks is how the last
// stale citation happened.
const HEIGHT = 1.8;
const EYE = 1.6;

// Deterministic: `CharacterMesh` uses no RNG and no wall clock, and the
// animator's springs are stepped at a fixed dt. Verified by running the capture
// twice and diffing. Tolerance is 1e-3, ~200x smaller than the 0.20 m move this
// file was written to catch.
const TOL = 1e-3;

// Rest pose is the rig as built — pure construction arithmetic, no animator.
// Aim pose is 150 frames of the settled idle/aim the roster shot photographs,
// which is the pose the muzzle is actually fired from in play. Both are pinned
// because they answer different questions: rest catches a geometry edit, aim
// catches an animator edit that would move the origin without touching a mesh.
const EXPECT = {
  ranger:  { crown: 2.1300, muzzle: 0.8950, aimCrown: 2.1340, aimMuzzle: 1.8505 },
  anvil:   { crown: 1.4931, muzzle: 0.6600, aimCrown: 1.6316, aimMuzzle: 1.5770 },
  kestrel: { crown: 2.1989, muzzle: 0.9900, aimCrown: 2.7139, aimMuzzle: 2.7449 },
  rook:    { crown: 1.6175, muzzle: 0.7700, aimCrown: 1.6772, aimMuzzle: 1.6764 },
  cinder:  { crown: 1.8000, muzzle: 0.9200, aimCrown: 1.9288, aimMuzzle: 1.9126 },
};

const _v = new THREE.Vector3();

/** Build one rig and measure its bbox crown and world muzzle height. */
function measure(meshKey, aim) {
  const m = new CharacterMesh(meshKey);
  if (aim) {
    const state = {
      velocity: new THREE.Vector3(), grounded: true, aimYaw: 0.24, aimPitch: -0.04,
      dashT: 0, sprint: false, moveSpeed: 7, dead: false,
    };
    m.bodyYaw = 0.24;
    for (let i = 0; i < 150; i++) m.update(1 / 60, state);
  }
  // The contact decal is a ground plane, not body — it would drag the bbox out
  // sideways. `tools/silhouette.mjs` hides it for the same reason.
  m.blob.visible = false;
  m.group.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(m.group);
  m.getMuzzle(_v);
  return { crown: box.max.y, muzzle: _v.y };
}

console.log('the pinned set is the live roster — a new survivor cannot arrive unpinned');
{
  const keys = SURVIVORS.map((s) => s.meshKey);
  for (const k of keys) ok(!!EXPECT[k], `${k} has a pinned row`);
  for (const k of Object.keys(EXPECT)) ok(keys.includes(k), `pinned row ${k} is still on the roster`);
}

console.log('per-survivor crown and muzzle height, rest pose and aim pose');
for (const s of SURVIVORS) {
  const w = EXPECT[s.meshKey];
  if (!w) continue;
  const rest = measure(s.meshKey, false);
  const aim = measure(s.meshKey, true);
  near(rest.crown, w.crown, TOL, `${s.meshKey} rest crown`);
  near(rest.muzzle, w.muzzle, TOL, `${s.meshKey} rest muzzle`);
  near(aim.crown, w.aimCrown, TOL, `${s.meshKey} aim crown`);
  near(aim.muzzle, w.aimMuzzle, TOL, `${s.meshKey} aim muzzle`);
}

// The pins above catch *any* movement, which is what makes them a tripwire. The
// checks below say what movement would be wrong, so that a future change with a
// legitimate reason to repin still cannot repin its way past the gameplay floor.
console.log('the aim origin stays near the engine\'s own mesh-less fallback');
{
  // `Player.muzzlePosition()` falls back to `position.y + EYE` when there is no
  // mesh (`src/entities/Player.js:1249-1254`), so EYE is the engine's canonical
  // aim origin for any survivor. A rig may sit above it — a tall survivor holds
  // its gun higher — but a rig whose muzzle sinks well below it is firing from
  // the shins, and the fallback would be a better origin than the rig.
  const FLOOR = EYE - 0.15;
  for (const s of SURVIVORS) {
    const aim = measure(s.meshKey, true);
    ok(aim.muzzle >= FLOOR,
      `${s.meshKey} aim muzzle ${aim.muzzle.toFixed(4)} >= ${FLOOR.toFixed(2)} (EYE ${EYE} - 0.15)`);
  }
}

console.log('no rig strays too far from the shared hurtbox it is drawn around');
{
  // All survivors share one capsule (`Player.js:54`, `HEIGHT = 1.8`), and none
  // of them matches it: the authored rest crowns run 1.4931 (Anvil) to 2.1989
  // (Kestrel). This is pre-existing and roster-wide, not something #20 created —
  // the *default* survivor, Ranger at 2.1300, overshoots the capsule by 0.330 m,
  // more than Anvil now undershoots it by 0.307 m. So "inside the hurtbox" is
  // not an invariant this roster has ever held and asserting it would just be
  // red on arrival.
  //
  // What is worth holding is the band. A rig is drawn around that capsule even
  // if it does not fill it, and one that walked far outside would be shooting
  // and being shot at visibly wrong places. The bound below fits all five with
  // Anvil the tightest at 0.143 m of margin, so a second 0.20 m squat on Anvil
  // trips it. Rest pose only: the aim pose lifts Kestrel's weapon to 2.7139 and
  // a crown bound there measures the animation, not the body.
  const BAND = 0.45;
  for (const s of SURVIVORS) {
    const rest = measure(s.meshKey, false);
    ok(Math.abs(rest.crown - HEIGHT) <= BAND,
      `${s.meshKey} rest crown ${rest.crown.toFixed(4)} within ${BAND} m of HEIGHT ${HEIGHT} ` +
      `(off by ${(rest.crown - HEIGHT).toFixed(4)})`);
  }
}

console.log('the transcribed Player constants still match source');
{
  const src = readFileSync(join(here, '..', 'src', 'entities', 'Player.js'), 'utf8');
  ok(new RegExp(`const HEIGHT = ${HEIGHT}\\s*;`).test(src), `Player.js still declares HEIGHT = ${HEIGHT}`);
  ok(new RegExp(`const EYE = ${EYE}\\s*;`).test(src), `Player.js still declares EYE = ${EYE}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
