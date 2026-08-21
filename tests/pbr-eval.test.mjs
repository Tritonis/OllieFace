// tests/pbr-eval.test.mjs
//
// The photographed-asset evaluation set (#109 step 3) is a feature whose whole
// contract is about what happens when it is OFF: no fetch, no shader change,
// no cache-key change, no audio node. That contract is invisible to every gate
// in the repo -- a full `gates:cheap` pass says nothing about it, because the
// flag is off in all of them and "nothing happened" is exactly what a passing
// run looks like either way.
//
// So this file guards the absence rather than the presence. Each assertion is
// paired: the off state is asserted alongside the on state that proves the
// off state was a decision and not a broken switch. An assertion that can only
// ever read "nothing changed" is the guard-that-passes-while-blind shape this
// repo keeps rediscovering, and a pair cannot take that shape -- if the flag
// stops working, the ON half fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  MASK_UNIFORMS, OVERLAY_UNIFORMS, attachBlightMask, maskApply,
  overlayEnabled, setOverlayMaps,
} from '../src/shaders/BlightMask.js';
import { SETS, ASSIGNMENT, isPbrOn } from '../src/world/PbrEval.js';
import { Audio } from '../src/systems/Audio.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const OV_REF = /uOv(Nor|Rough|Ao)/;

console.log('the overlay chunk is emitted only when the overlay is on');
{
  // Structural, not a snapshot: asserting the whole shader string would rot on
  // the next comment edit and teach the next person to regenerate it blind.
  const off = maskApply(false);
  const on = maskApply(true);
  ok(!OV_REF.test(off), 'flag-off fragment text references no overlay sampler');
  ok(!off.includes('ovFade'), 'flag-off fragment text carries no overlay body');
  ok(OV_REF.test(on), 'flag-on fragment text does reference the overlay samplers');
  ok(on.includes('ovFade'), 'flag-on fragment text carries the overlay body');
  ok(on.includes('uOvRough') && on.includes('uOvAo') && on.includes('uOvNor'),
     'all three overlay maps are read');
  // The rule the style guide owns: the tint owns the colour of a blighted
  // fragment, so the overlay must never bring an albedo of its own.
  ok(!/uOv(Albedo|Map|Diff)/.test(on), 'the overlay reads no albedo map');
  // Whatever else changes, the two must differ -- a maskApply that ignored its
  // argument would satisfy every "off" assertion above.
  ok(off !== on, 'the argument actually switches the emitted text');
}

console.log('an unbound overlay is a no-op, and the base uniform set is untouched by it');
{
  ok(overlayEnabled() === false, 'the overlay starts unbound');
  ok(isPbrOn() === false, 'the swap starts off -- importing this module fetches nothing');
  ok(!('uOvNor' in MASK_UNIFORMS), 'the overlay samplers are not keys in the shared base uniform set');
  ok(OVERLAY_UNIFORMS.uOvNor.value === null, 'the overlay uniforms start null');

  setOverlayMaps(null);
  ok(overlayEnabled() === false, 'clearing an already-clear overlay stays clear');
}

console.log('a patched material forks its program only while the overlay is on');
{
  const mat = new THREE.MeshStandardMaterial();
  attachBlightMask(mat);
  const compile = () => {
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <emissivemap_fragment>\n}',
    };
    mat.onBeforeCompile(shader, null);
    return shader;
  };

  const keyOff = mat.customProgramCacheKey();
  const shaderOff = compile();
  // Suffix, not equality: three's own default key is the source text of
  // `onBeforeCompile`, so the full string moves whenever this hook is edited at
  // all. The suffix is the part #109 is answerable for.
  ok(keyOff.endsWith('|blightmask'), 'flag-off cache key still ends where it did before #109');
  ok(!OV_REF.test(shaderOff.fragmentShader), 'flag-off program declares no overlay sampler');
  ok(!('uOvNor' in shaderOff.uniforms), 'flag-off program is handed no overlay uniform');

  const tex = () => new THREE.Texture();
  // `needsUpdate` is a write-only setter on a three material; `version` is the
  // counter it bumps, and the only readable evidence a recompile was asked for.
  const versionBefore = mat.version;
  setOverlayMaps({ normalMap: tex(), roughnessMap: tex(), aoMap: tex() });
  ok(overlayEnabled() === true, 'binding a set enables the overlay');
  ok(mat.version > versionBefore, 'every patched material is marked for the recompile the fork needs');

  const keyOn = mat.customProgramCacheKey();
  const shaderOn = compile();
  ok(keyOn !== keyOff, 'flag-on cache key differs, so the two programs cannot share a cache slot');
  ok(keyOn === keyOff + '|ov', 'and it differs by the overlay suffix specifically');
  ok(shaderOn.fragmentShader.includes('uniform sampler2D uOvNor;'), 'flag-on program declares the samplers');
  ok(shaderOn.uniforms.uOvNor === OVERLAY_UNIFORMS.uOvNor, 'flag-on program shares the singleton overlay uniforms');
  ok(shaderOn.fragmentShader.indexOf('uniform sampler2D uOvNor;')
     < shaderOn.fragmentShader.indexOf('texture2D(uOvNor'), 'declaration precedes use');

  // And back: the off state has to be reachable in one session or the runtime
  // A/B the capture evidence rests on is a one-way door.
  setOverlayMaps(null);
  ok(overlayEnabled() === false, 'clearing unbinds again');
  ok(mat.customProgramCacheKey() === keyOff, 'and the cache key returns to its flag-off value');
  ok(!OV_REF.test(compile().fragmentShader), 'and the recompiled program is clean again');
}

console.log('the asset assignment carries no albedo on the overlay and no displacement anywhere');
{
  ok(!('map' in SETS.overlay.maps), 'the overlay set declares no albedo slot');
  ok('map' in SETS.rock.maps && 'map' in SETS.metal.maps, 'rock and metal do carry albedo');
  const slots = Object.values(SETS).flatMap((s) => Object.keys(s.maps));
  ok(!slots.includes('displacementMap'), 'displacement is bound nowhere -- see the header, it is step 4');
  ok(ASSIGNMENT.metalRuin === 'metal', 'the ruin plate takes the corrugated iron');
  ok(['terrain', 'rock', 'cliff'].every((k) => ASSIGNMENT[k] === 'rock'), 'the stone classes take the quarry rock');
  ok(!('crystal' in ASSIGNMENT), 'the emissive accent is left alone');
}

console.log('flag-off can never fetch: the module is imported inside the flag branch');
{
  // A drift guard in the style of the glyph-atlas mirror test. The claim
  // "flag-off fetches nothing" rests entirely on the import being dynamic and
  // guarded; a later refactor hoisting it to the top of main.js would keep
  // every other assertion in this file green while shipping a 122 MiB fetch to
  // every player.
  const main = read('src/main.js');
  ok(!/^import[^\n]*PbrEval/m.test(main), 'main.js never statically imports PbrEval');

  const guard = "if (params.get('pbr') === '1') {";
  const at = main.indexOf(guard);
  ok(at >= 0, 'the boot flag is still spelled ?pbr=1');
  // Walk the braces from the guard to find its block, so the assertion is
  // about containment rather than about line numbers.
  let depth = 0, end = -1;
  for (let i = at + guard.length - 1; i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) { end = i; break; }
  }
  const block = end > 0 ? main.slice(at, end) : '';
  ok(block.includes("import('./world/PbrEval.js')"), 'the dynamic import lives inside the flag branch');
  ok(block.includes('catch'), 'and a missing asset set is caught rather than abandoning module evaluation');

  const harness = main.indexOf("if (params.has('harness'))");
  ok(harness > 0 && main.slice(harness).includes('installPbrHarness'),
     'the harness hook is installed from the harness branch, which registers but never calls');
}

console.log('the recorded rumble stays out of the graph until it is asked for');
{
  const made = [];
  const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {},
                         cancelScheduledValues() {}, linearRampToValueAtTime() {} });
  const node = (kind) => {
    const n = { kind, out: [], gain: param(), frequency: param(), Q: param(),
                connect(d) { n.out.push(d); return d; }, disconnect() {}, start() {}, stop() {} };
    made.push(n);
    return n;
  };
  const ac = { currentTime: 0, listener: {}, createGain: () => node('gain'),
               createBiquadFilter: () => node('filter'), createBufferSource: () => node('src') };

  const a = new Audio();
  a.ac = ac;
  a.ready = true;
  a.master = node('master');
  a.voidGain = node('voidGain');
  // The one collaborator `update` reaches for above the block under test.
  a.musicEngine = { update() {} };
  const before = made.length;

  // The whole frame path, not just the new block: this is the writer that
  // overwrites anything set once at load, which is why the rumble level is
  // driven from inside it in the first place.
  a.update({ corruption: { band: 4 } }, 1 / 60);
  ok(made.length === before, 'an untouched flag builds no node on a live frame');
  ok(a.pbrRumbleGain === undefined, 'and no rumble gain exists');
  ok(a._pbrRumbleOn === undefined, 'and the frame writer did not invent the intent');

  // Turning it off is not a way of turning it on, either -- the fetch is only
  // reachable from `true`.
  a.setPbrRumble(false);
  a.update({ corruption: { band: 4 } }, 1 / 60);
  ok(made.length === before, 'setPbrRumble(false) still builds nothing');
  ok(a._pbrRumbleOn === false, 'but the intent is now recorded, so a later true can act on it');
}

console.log('the packaging seam ships the staged set into the artifact and not into the default one');
{
  // The evaluation set has to reach the packed build (the #109 playtest is on
  // the artifact, not the dev server) WITHOUT becoming part of the default
  // artifact, because nothing binary is accepted until #26 closes. Those are
  // two claims and each needs its own assertion, or "it packs" and "it packs
  // for everyone" become the same green.
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files.map(String);
  ok(!files.some((f) => f.includes('assets-staging')),
     'build.files never admits the staged set, so the ordinary pack stays binary-free');
  ok(pkg.build.extraResources === undefined,
     'and no standing extraResources entry carries it either');
  ok(!pkg.scripts['desktop:pack'].includes('assets-staging'),
     'the ordinary pack script is untouched by the evaluation');
  ok(pkg.scripts['desktop:pack:pbr']?.includes('-c.extraResources=assets-staging'),
     'the evaluation pack adds it as a one-flag override rather than a second config file');

  // The shell is the only place the dev-server URL and the packaged URL are
  // allowed to differ. If this moves back into src/, the renderer starts
  // carrying knowledge of how it was packaged.
  const shell = read('desktop/main.mjs');
  ok(shell.includes("process.argv.includes('--pbr')"), 'the shell reads the flag off its command line');
  ok(shell.includes("TELLURIC_PBR"), 'and off an environment variable, for a shortcut-less launch');
  ok(/loadURL\(`app:\/\/game\/index\.html\$\{PBR_EVAL \? '\?pbr=1' : ''\}`\)/.test(shell),
     'and maps it onto the query string the renderer already reads');
  ok(shell.includes('app.isPackaged ? process.resourcesPath'),
     'the packaged asset root is resources/, the unpacked one the repo root');
  ok(shell.includes("rel.startsWith(EVAL_PREFIX)"), 'the app:// handler serves the staged set');
  ok(/asset\.startsWith\(path\.join\(base, 'assets-staging'\) \+ path\.sep\)/.test(shell),
     'and the new root carries its own traversal containment check');

  // One resolution point, as the brief requires: src/ knows a relative path
  // and nothing else about where the files live.
  const evalSrc = read('src/world/PbrEval.js');
  ok(evalSrc.includes("const ROOT = 'assets-staging'"), 'the renderer holds one relative root');
  ok(!/resourcesPath|isPackaged|file:\/\//.test(evalSrc), 'and no packaging knowledge at all');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
