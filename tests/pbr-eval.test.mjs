// tests/pbr-eval.test.mjs
//
// The photographed surface set (#109), guarded after adoption.
//
// While it was an experiment this file pinned the OFF state: no fetch, no
// shader change, no audio node unless the flag asked. Adoption inverts most of
// that. The set is the game's surface now, so what needs guarding is that no
// route back to optional survives, that the maps sit where vite serves them in
// dev AND ships them in a build, and that the desktop shell has been left
// knowing nothing about any of it.
//
// Two habits carry over unchanged, because they are what makes these
// assertions worth running:
//
//  - **Paired, never single-sided.** Every "X is absent" sits beside the "X is
//    present" that proves the absence was a decision rather than a broken
//    switch. An assertion that can only ever read "nothing changed" is the
//    guard-that-passes-while-blind shape this repo keeps rediscovering.
//  - **Mutation-checked.** Each keystone assertion here has been watched to
//    fail against a deliberate break of the thing it claims. A guard nobody
//    has seen fail is a guard nobody knows the polarity of.
//
// The `maskApply(false)` branch and `setPbr(false)` are still exercised below:
// they are no longer a shipping flag, they are the procedural arm of the A/B
// that `tools/capture-arteval.mjs` takes its evidence with.
import { existsSync, readFileSync } from 'node:fs';
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

console.log('every boot binds the photographed set, and no flag can decline it');
{
  // The inverse of what this section guarded before adoption. It used to pin
  // that a flag-off boot could not possibly fetch; the set is the game's
  // surface now, so what needs pinning is that no route back to optional
  // exists — a reintroduced query-string branch would make the shipping
  // surface depend on how the app happened to be launched, which is exactly
  // the state #109 step 6 closed.
  const main = read('src/main.js');
  ok(/^import \{[^\n]*setPbr[^\n]*\} from '\.\/world\/PbrEval\.js';$/m.test(main),
     'main.js imports the surface set statically — it is boot work, not an option');
  ok(!/params[^\n]*['"]pbr['"]/.test(main), 'no query parameter decides the surface any more');
  ok(main.includes('setPbr(true)'), 'and the boot path binds it');

  // Unconditional means unconditional: the call must not sit inside any `if`.
  // Checked by brace depth from the top of the module, which no rewording of
  // a guard can slip past.
  const at = main.indexOf('setPbr(true)');
  let depth = 0;
  for (let i = 0; i < at; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}') depth--;
  }
  ok(depth === 0, 'the bind sits at module top level, inside no branch at all');

  const tail = main.slice(at, at + 400);
  ok(tail.includes('.catch('), 'a failed load is caught, so the procedural library remains the fallback');
  ok(tail.includes('setPbrRumble'), 'and the recorded rumble rides the same unconditional path');

  // The shell must know nothing about any of it: no switch, no asset root, no
  // second serving branch. `dist/` carries the maps and app:// already serves
  // `dist/`, which is the whole reason `public/game-assets/` was the home.
  const shell = read('desktop/main.mjs');
  ok(!/pbr|PBR|assets-staging/.test(shell), 'the desktop shell carries no surface knowledge at all');
  ok(shell.includes("win.loadURL('app://game/index.html')"), 'and loads the game with no query string');

  const harness = main.indexOf("if (params.has('harness'))");
  ok(harness > 0 && main.slice(harness).includes('installPbrHarness'),
     'the A/B hook stays harness-only, so nothing a player runs can turn the surface off');
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

console.log('the maps live where vite serves them in dev and ships them in a build');
{
  // The home is load-bearing and nothing else in the repo would notice it
  // moving. `public/` is vite's static root: served at the site root by the dev
  // server and copied wholesale into `dist/` by a build. The desktop shell
  // already serves the whole of `dist/` over app://, so one relative URL is
  // correct in all three worlds and the shell needs no branch — which is what
  // let the packaging seam be deleted at adoption. A move to any other
  // directory silently breaks the packaged build only, the one place no unit
  // test looks.
  const evalSrc = read('src/world/PbrEval.js');
  ok(evalSrc.includes("const ROOT = 'game-assets'"), 'the renderer holds one relative root');
  ok(!/resourcesPath|isPackaged|file:\/\/|assets-staging/.test(evalSrc),
     'and no packaging knowledge, and no memory of the staging directory');

  const files = [];
  for (const spec of Object.values(SETS)) {
    for (const kind of Object.values(spec.maps)) files.push(`${spec.dir}/${spec.stem}_${kind}_4k.jpg`);
  }
  // Derived from SETS rather than listed by hand: a renamed map has to fail
  // here rather than at runtime in a packed build.
  const missing = files.filter((f) => !existsSync(join(here, '..', 'public', f)));
  ok(missing.length === 0, `every map SETS names is on disk under public/${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  ok(files.length === 11, `all eleven bound maps are accounted for (found ${files.length})`);
  ok(existsSync(join(here, '..', 'public', 'game-assets', 'audio',
                     '735011__vladislavzh__trembling-low-frequency-rumble.wav')),
     'and the rumble recording, under the filename that carries its attribution');

  // The packaging seam is gone, and must not come back: the default pack now
  // carries the maps through dist/, so a second route would be a second answer.
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts['desktop:pack:pbr'] === undefined, 'the evaluation pack script is gone');
  ok(pkg.build.extraResources === undefined, 'and no extraResources route survives it');
  ok(!JSON.stringify(pkg.build.files).includes('assets-staging'), 'and build.files names no staging directory');
}


console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
