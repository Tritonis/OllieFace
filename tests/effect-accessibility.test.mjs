/**
 * The four per-effect accessibility knobs (#43): hit flash, chromatic
 * aberration, bloom and general screen motion.
 *
 * A settings row that saves a value nothing consumes is the failure this file
 * exists to make impossible, so every key is checked twice: once for its
 * schema (present, defaulted to 1, clamped by a real slider row) and once for
 * CONSUMPTION — the producing system is driven with the setting at 1 and again
 * at 0, and the numbers it produces must differ. Each consumption check also
 * asserts the value at 1 equals the historical constant, so a knob cannot buy
 * its "it changes something" evidence by moving the default.
 */
import * as THREE from 'three';
import { DEFAULTS, SLIDERS } from '../src/ui/Menus.js';
import { RenderPipeline } from '../src/core/RenderPipeline.js';
import { VFX } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const close = (a, b) => Math.abs(a - b) < 1e-9;

const KEYS = ['flash', 'aberration', 'bloom', 'motion'];

/* -- 1. schema ------------------------------------------------------- */

for (const k of KEYS) {
  ok(DEFAULTS[k] === 1, `${k} defaults to 1 (current behaviour preserved)`);
  const row = SLIDERS.find((s) => s.key === k);
  ok(!!row, `${k} has a slider row in the settings screen`);
  if (row) ok(row.min === 0 && row.max >= 1, `${k} slider spans 0..${row.max}`);
}

// `shake` is the idiom being replicated; if it ever stops being a plain number
// on the settings blob the four new keys are following a dead pattern.
ok(typeof DEFAULTS.shake === 'number', 'shake is still a plain numeric settings key');

/* -- 2. consumption: flash, read by VFX.hitFlash ---------------------- */

function flashIntensityAt(strength) {
  const mat = new THREE.MeshStandardMaterial({ emissiveIntensity: 1 });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  const self = { ctx: { settings: { flash: strength } }, _flashes: [] };
  VFX.prototype.hitFlash.call(self, mesh, 0xffffff, 0.06);
  // hitFlash clones the material onto the mesh; read back off the mesh, not
  // off the prefab material we handed in.
  return { intensity: mesh.material.emissiveIntensity, cloned: mesh.material !== mat };
}

const flashFull = flashIntensityAt(1);
const flashHalf = flashIntensityAt(0.5);
const flashOff = flashIntensityAt(0);
ok(close(flashFull.intensity, 3.2), `flash 100% still drives emissive to 3.2 (${flashFull.intensity})`);
ok(flashHalf.intensity < flashFull.intensity && flashHalf.intensity > 1,
  `flash 50% lands between rest and full (${flashHalf.intensity})`);
ok(flashOff.intensity === 1 && !flashOff.cloned,
  'flash 0% produces no flash at all (no material clone, resting intensity)');

/* -- 3. consumption: aberration, bloom, motion, read by RenderPipeline - */

const BLOOM_STRENGTH = 0.34;   // RenderPipeline's authored BLOOM.strength

function pipelineFrame(settings) {
  const u = {
    uTime: { value: 0 }, uShake: { value: 0 },
    uAberration: { value: 0 }, uVignette: { value: 0 },
  };
  const self = {
    settings,
    shake: 0, shakeTime: 0, shakeScale: 1,
    aberration: 0.004, vignetteBoost: 0.4,
    passes: { grade: { uniforms: u }, bloom: { strength: BLOOM_STRENGTH } },
    _adapt() {},
  };
  // A real gameplay kick first, so the shake term is live rather than resting.
  RenderPipeline.prototype.addShake.call(self, 0.5);
  const shakeAfterKick = self.shake;
  RenderPipeline.prototype.update.call(self, 1 / 60);
  return { u, bloom: self.passes.bloom.strength, shakeAfterKick };
}

const all1 = { shake: 1, flash: 1, aberration: 1, bloom: 1, motion: 1 };
const baseline = pipelineFrame(all1);
const noSettings = pipelineFrame(null);

ok(close(baseline.u.uAberration.value, noSettings.u.uAberration.value)
  && close(baseline.u.uVignette.value, noSettings.u.uVignette.value)
  && close(baseline.bloom, noSettings.bloom)
  && close(baseline.shakeAfterKick, noSettings.shakeAfterKick),
  'all knobs at 1 reproduce the no-settings frame exactly');
ok(close(baseline.bloom, BLOOM_STRENGTH), `bloom 100% leaves strength at ${BLOOM_STRENGTH}`);

const abOff = pipelineFrame({ ...all1, aberration: 0 });
ok(abOff.u.uAberration.value === 0 && baseline.u.uAberration.value > 0,
  `aberration 0% zeroes uAberration (was ${baseline.u.uAberration.value})`);
const abHalf = pipelineFrame({ ...all1, aberration: 0.5 });
ok(close(abHalf.u.uAberration.value, baseline.u.uAberration.value * 0.5),
  'aberration 50% halves uAberration');

const bloomOff = pipelineFrame({ ...all1, bloom: 0 });
ok(bloomOff.bloom === 0, 'bloom 0% drives the bloom pass strength to 0');
const bloomHalf = pipelineFrame({ ...all1, bloom: 0.5 });
ok(close(bloomHalf.bloom, BLOOM_STRENGTH * 0.5), 'bloom 50% halves the pass strength');

const motionOff = pipelineFrame({ ...all1, motion: 0 });
ok(motionOff.shakeAfterKick === 0 && baseline.shakeAfterKick > 0,
  `motion 0% suppresses camera shake entirely (was ${baseline.shakeAfterKick})`);
ok(motionOff.u.uAberration.value < baseline.u.uAberration.value,
  'motion 0% drops the reactive aberration kick');
ok(motionOff.u.uVignette.value < baseline.u.uVignette.value,
  'motion 0% drops the reactive vignette pulse');
ok(motionOff.u.uAberration.value > 0,
  'motion 0% leaves the resting aberration — it reduces motion, not the look');
const motionHalf = pipelineFrame({ ...all1, motion: 0.5 });
ok(close(motionHalf.shakeAfterKick, baseline.shakeAfterKick * 0.5),
  'motion 50% halves the shake a kick produces');

// The guard must be able to fail: if `motion` were ignored by addShake, this
// is the comparison that would go red. Prove the probe reads the real path by
// showing `shake` (a key known to be consumed there) moves it the same way.
const shakeOff = pipelineFrame({ ...all1, shake: 0 });
ok(shakeOff.shakeAfterKick === 0, 'control: the pre-existing shake key still reaches addShake');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
