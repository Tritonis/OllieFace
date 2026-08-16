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
import { Player } from '../src/entities/Player.js';

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

console.log('every survivor is hittable exactly where it is drawn');
{
  // This block used to assert the opposite — a 0.45 m *band* around a shared
  // 1.8 m hurtbox, with a comment explaining that no rig matched it and that
  // asserting a match "would just be red on arrival". That was true, and it was
  // the defect: Kestrel and Ranger carried a third of a metre of head and
  // shoulders above the capsule, visible and aimed at and unhittable, and this
  // test documented that rather than forbidding it (#70).
  //
  // Now the hurtbox is the rig. Each card's `hurtHeight` must equal the crown
  // measured off the rig this same file builds, at the same 1e-3 as the other
  // pins — so the claim is not "these five numbers are still these five
  // numbers" but "the number the game shoots at is the number the artist
  // authored". A re-rig that moves a crown now fails here until the hurtbox
  // follows it, which is the property the old band could never have had.
  //
  // Rest pose, not aim: the aim pose lifts Kestrel's weapon to 2.7139, and a
  // hurtbox bound there would measure the animation rather than the body.
  for (const s of SURVIVORS) {
    const rest = measure(s.meshKey, false);
    ok(typeof s.hurtHeight === 'number', `${s.meshKey} card declares a hurtHeight`);
    near(s.hurtHeight, rest.crown, TOL, `${s.meshKey} hurtHeight tracks its measured crown`);
  }
}

console.log('and the number actually reaches a pawn');
{
  // The card carrying the right number proves nothing on its own — the card is
  // only correct if `_applyCard` copies it onto the pawn that `Projectile.hits`
  // and the splash queries in `data/abilities.js` read `height` from. Asserting
  // the data and assuming the wiring is how a change becomes a no-op that reads
  // as a pass; this repo has been fooled that way before.
  //
  // Constructed the way the other Player tests do it (`revive-system.test.mjs`):
  // a real `Player` needs a live THREE/ctx world, so the prototype method is
  // called against a bare object. That is the real `_applyCard`, not a copy.
  for (const s of SURVIVORS) {
    const pawn = Object.create(Player.prototype);
    Player.prototype._applyCard.call(pawn, s);
    near(pawn.height, s.hurtHeight, 1e-9,
      `a ${s.meshKey} pawn carries its own hurtbox`);
  }
  // And the roster is not accidentally uniform — if every card had ended up the
  // same value, every assertion above would still pass while the feature did
  // nothing at all.
  const distinct = new Set(SURVIVORS.map((s) => s.hurtHeight));
  ok(distinct.size >= 4, `the roster carries ${distinct.size} distinct hurtboxes, not one shared value`);
}

console.log('the shared capsule is still the shared capsule');
{
  // #70 split one constant into two ideas, and the split is the whole point:
  // the hurtbox became per-survivor, the *movement* capsule did not. If a later
  // change quietly points `_resolve` at `this.height`, every survivor starts
  // traversing the world differently and every single-player baseline is in
  // play — a much wider blast radius, and one no fingerprint would attribute to
  // this. Pinned as source text because it is a claim about which value is
  // passed, which no runtime assertion on a built rig can see.
  const src = readFileSync(join(here, '..', 'src', 'entities', 'Player.js'), 'utf8');
  ok(/capsuleResolve\?\.\(this\.position, RADIUS, HEIGHT,/.test(src),
    '_resolve still passes the shared HEIGHT, not the per-survivor hurtbox');
  ok(/setY\(this\.position\.y \+ this\.height \* 0\.5\)/.test(src),
    'center() uses the per-survivor capsule, not the shared HEIGHT');
}

console.log('the transcribed Player constants still match source');
{
  const src = readFileSync(join(here, '..', 'src', 'entities', 'Player.js'), 'utf8');
  ok(new RegExp(`const HEIGHT = ${HEIGHT}\\s*;`).test(src), `Player.js still declares HEIGHT = ${HEIGHT}`);
  ok(new RegExp(`const EYE = ${EYE}\\s*;`).test(src), `Player.js still declares EYE = ${EYE}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
