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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
/** Every file under a directory, recursively — for the tree-wide sweeps below,
 *  which exist because a per-file allowlist is what let a stale path ship. */
const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

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

console.log('the per-frame retry cannot stampede, and a missing file stops it for good');
{
  // The defect this section exists for. `setPbrRumble` only sets
  // `pbrRumbleGain` after an awaited fetch AND decode, and the frame loop
  // retries whenever that gain is absent -- so without an in-flight guard every
  // frame from the first attempt until it lands starts another 25 MB fetch and
  // ~49 MB decode. At 60 Hz over a multi-second load that is gigabytes in
  // transit for a single file, and the call is un-awaited, so a 404 is also an
  // unhandled rejection once per frame forever (which Playwright reports as a
  // page error, taking every capture run down as infrastructure).
  //
  // Both halves are asserted by COUNTING, not by inspecting flags: a guard
  // checked through the private field it sets is a guard checked against
  // itself.
  const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {} });
  const node = (kind) => {
    const n = { kind, out: [], gain: param(), frequency: param(), Q: param(),
                connect(d) { n.out.push(d); return d; }, disconnect() {}, start() {}, stop() {} };
    return n;
  };
  const makeAudio = () => {
    const a = new Audio();
    a.ac = {
      currentTime: 0, listener: {}, createGain: () => node('gain'),
      createBiquadFilter: () => node('filter'), createBufferSource: () => node('src'),
      decodeAudioData: async () => ({ duration: 1 }),
    };
    a.ready = true;
    a.master = node('master');
    a.voidGain = node('voidGain');
    a.musicEngine = { update() {} };
    return a;
  };
  const frames = async (a, n) => {
    for (let i = 0; i < n; i++) {
      a.update({ corruption: { band: 4 } }, 1 / 60);
      await Promise.resolve();      // let any .catch settle between frames
    }
  };

  // --- a slow load: many frames, exactly one fetch -------------------------
  const realFetch = globalThis.fetch;
  let fetches = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  globalThis.fetch = async () => { fetches++; await gate; return { arrayBuffer: async () => new ArrayBuffer(8) }; };

  const slow = makeAudio();
  slow.setPbrRumble(true);
  await frames(slow, 30);
  ok(fetches === 1, `thirty frames over one in-flight load fetch the file once (fetched ${fetches})`);
  ok(!slow.pbrRumbleGain, 'and nothing is wired until the decode actually lands');
  release();
  // Several awaits separate the released fetch from a built gain (body, decode,
  // then the builder); a macrotask turn drains all of them without guessing a count.
  await new Promise((r) => setTimeout(r, 0));
  await frames(slow, 2);
  ok(fetches === 1, 'and the landing does not trigger one more');
  ok(!!slow.pbrRumbleGain, 'the layer is built exactly once the buffer exists');
  await frames(slow, 5);
  ok(fetches === 1, 'nor does any later frame, now that the gain exists');

  // --- a 404: one attempt, then silence ------------------------------------
  fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('404'); };
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a[0]);
  const rejections = [];
  const onRejection = (e) => { rejections.push(e); e.preventDefault?.(); };
  process.on('unhandledRejection', onRejection);

  const broken = makeAudio();
  // Exactly the production sequence, and the reason it is written this way: at
  // boot main.js asks for the rumble BEFORE a user gesture has created the
  // AudioContext, so that call records the intent and returns without loading.
  // The load is therefore started by the frame loop, un-awaited - the one path
  // whose rejection has nobody to catch it.
  broken._pbrRumbleOn = true;
  await frames(broken, 40);
  // The load rejects, so the retry must stop: a file that is not in the build
  // will not appear later, and ambience is not worth 60 attempts a second.
  ok(fetches === 1, `a rejecting load is attempted once, not once per frame (attempted ${fetches})`);
  ok(warns.some((w) => typeof w === 'string' && w.includes('rumble')),
     'and the player-visible log says once what was lost');
  await new Promise((r) => setTimeout(r, 0));
  ok(rejections.length === 0, 'no unhandled rejection escapes the frame loop');
  ok(!broken.pbrRumbleGain, 'and no half-built layer is left behind');

  process.off('unhandledRejection', onRejection);
  console.warn = realWarn;
  if (realFetch) globalThis.fetch = realFetch; else delete globalThis.fetch;
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
  ok(!/resourcesPath|isPackaged|file:\/\//.test(evalSrc), 'and no packaging knowledge');

  // The whole tree, not the four files this section used to name. `PbrEval.js`
  // was checked for a stale `assets-staging` reference and passed while
  // `Audio.js` fetched the rumble from that exact directory: the map path and
  // the audio path were migrated by different edits and only one of them was
  // under a guard. A directory that no longer exists cannot be referenced from
  // ANYWHERE in shipped code, so the sweep is the tree.
  //
  // It survived review because it fails only where no unit test looks: the
  // staging directory still sat untracked on the developer's disk, so the dev
  // server served it and the fetch worked locally. In a fresh clone the same
  // line 404s, `decodeAudioData` rejects, and the rumble is silently absent
  // from a build whose visuals loaded perfectly.
  const stale = [];
  for (const dir of ['src', 'tools', 'desktop']) {
    for (const f of walk(join(here, '..', dir))) {
      if (!/\.(m?js|cjs)$/.test(f)) continue;
      if (readFileSync(f, 'utf8').includes('assets-staging')) {
        stale.push(relative(join(here, '..'), f).replace(/\\/g, '/'));
      }
    }
  }
  ok(stale.length === 0,
     `no file under src/, tools/ or desktop/ names the retired staging directory${stale.length ? ` — found in: ${stale.join(', ')}` : ''}`);

  // Same sweep, same reason, for the other half of the migration: every asset
  // URL in shipped code has to point at the one tracked home.
  const audio = read('src/systems/Audio.js');
  ok(audio.includes("'game-assets/audio/"), 'the rumble is fetched from the tracked home');

  // And the same sweep for the retired query parameter. `tools/perf.mjs` kept a
  // `--pbr` switch that appended `&pbr=1` to its boot URL for a whole review
  // cycle after `main.js` stopped reading the parameter: the arm ran, the flag
  // did nothing, and the numbers were labelled as though it had. A benchmark
  // that lies about which surface it measured is worse than one arm fewer.
  const liars = [];
  for (const dir of ['src', 'tools']) {
    for (const f of walk(join(here, '..', dir))) {
      if (!/\.(m?js|cjs)$/.test(f)) continue;
      const body = readFileSync(f, 'utf8');
      // A comment may discuss the retired flag — several explain why it went.
      // Only a live `pbr=1` inside a URL or a string is a claim on behaviour.
      const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/pbr=1/.test(code)) liars.push(relative(join(here, '..'), f).replace(/\\/g, '/'));
    }
  }
  ok(liars.length === 0,
     `no tool still passes the retired ?pbr=1 parameter${liars.length ? ` — found in: ${liars.join(', ')}` : ''}`);

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
