/**
 * The vendored Steamworks redistributable must reach the packed artifact, and
 * `steam_appid.txt` must not (issue #65; `desktop/README.md:76-79`).
 *
 * `steamworks-ffi-node` is Koffi FFI over Valve's flat C API and ships no
 * redistributable of its own: its loader searches for
 * `steamworks_sdk/redistributable_bin/win64/steam_api64.dll` **relative to the
 * project root** and fails with a setup message if it is absent. With
 * `asar: false` and electron-builder's `--dir` target, the project root inside
 * the artifact is `resources/app/`, so the DLL has to be admitted by
 * `build.files` under exactly that relative path or the packed shell reports
 * Steam unavailable for a reason no log line explains.
 *
 * This file is a *packaging-inputs* guard, not a pack. It answers the two
 * questions a pack would answer, without the two minutes electron-builder
 * costs: is the file on disk where the loader looks, and does `build.files`
 * decide to ship it?
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES } from '../src/data/samples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`PASS  ${msg}`); } else { fail++; console.log(`FAIL  ${msg}`); } };

const SDK_DLL = 'steamworks_sdk/redistributable_bin/win64/steam_api64.dll';

/**
 * electron-builder's `files` is an ordered list of globs where a later match
 * overrides an earlier one and a `!` prefix excludes. Reimplemented here rather
 * than imported, because the question is what the *config* decides and pulling
 * in the packer to ask it would make this test cost what a pack costs.
 */
const toRegExp = (glob) => {
  let out = '';
  // `**/` spans zero or more directories, so `**/x` matches a bare `x` too; a
  // trailing `**` spans the rest of the path; a lone `*` never crosses a `/`.
  for (const tok of glob.match(/\*\*\/|\*\*|\*|[^*]+/g) ?? []) {
    out += tok === '**/' ? '(?:.*/)?'
      : tok === '**' ? '.*'
      : tok === '*' ? '[^/]*'
      : tok.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

const packs = (files, rel) => {
  let verdict = false;
  for (const entry of files) {
    const negated = String(entry).startsWith('!');
    const glob = negated ? String(entry).slice(1) : String(entry);
    // A bare directory pattern (`desktop/**`) also matches everything under it;
    // `toRegExp` already handles that. A pattern naming a directory with no
    // wildcard would match the directory itself, which is not a case this
    // config uses.
    if (toRegExp(glob).test(rel)) verdict = !negated;
  }
  return verdict;
};

console.log('-- the glob evaluator itself can tell yes from no');
{
  ok(packs(['desktop/**'], 'desktop/steam.mjs'), 'a `**` pattern packs a file beneath it');
  ok(!packs(['desktop/**'], 'src/main.js'), 'a `**` pattern does not pack a sibling tree');
  ok(!packs(['dist/**', '!dist/**/*.map'], 'dist/assets/index.js.map'), 'a later negation overrides an earlier match');
  ok(packs(['dist/**', '!dist/**/*.map'], 'dist/assets/index.js'), 'the negation is not overbroad');
  ok(!packs(['package.json'], 'desktop/package.json'), 'an unanchored name does not match a nested path');
}

console.log('\n-- the redistributable is on disk where the Binding\'s loader looks');
{
  let st = null;
  try { st = statSync(join(root, SDK_DLL)); } catch { /* reported below */ }
  ok(st !== null, `${SDK_DLL} exists (vendored in git; see steamworks_sdk/README.md)`);
  if (st) {
    ok(st.size > 100_000, `it is a real binary, not a placeholder or an LFS pointer (${st.size} bytes)`);
    ok(readFileSync(join(root, SDK_DLL)).subarray(0, 2).toString('latin1') === 'MZ',
      'it carries a PE header, so koffi has something it can actually open');
  }
}

console.log('\n-- build.files ships it, and still refuses steam_appid.txt');
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = pkg.build?.files ?? [];
  ok(files.length > 0, 'package.json declares build.files');

  ok(packs(files, SDK_DLL),
    `build.files packs ${SDK_DLL} — without it the packed shell fails Steam init with the Binding's setup message`);

  // The whole SDK is not vendored and must not become so by a widening glob:
  // the zip carries six stray steam_appid.txt files under steamworksexample/.
  ok(!packs(files, 'steamworks_sdk/redistributable_bin/win64/steam_api64.lib'),
    'the import library is not packed (koffi loads the DLL at runtime; nothing here links C++)');
  ok(!packs(files, 'steamworks_sdk/README.md'), 'the vendoring note is not packed');

  // desktop/README.md:76-79 — a stray appid file inside a packaged build
  // overrides what Steam tells the process and breaks release-build detection.
  ok(!packs(files, 'steam_appid.txt'), 'steam_appid.txt is excluded from the packed folder');
  ok(!packs(files, 'desktop/steam_appid.txt'), 'and nowhere else in it either');

  // desktop/net-bridge-renderer.cjs is test-only scaffolding: at test time it
  // reads the inlined block back out of preload.cjs; nothing requires it at
  // runtime, so the packed artifact must not carry it (#130 minor 1).
  ok(!packs(files, 'desktop/net-bridge-renderer.cjs'),
    'the test-only net-bridge extractor is not packed');

  // The effects showcase (#144) is an evaluation instrument, not a feature: it
  // is lazy-imported by a keybind and vite emits it as its own chunk at a
  // pinned, unhashed name precisely so `build.files` can refuse it by that
  // name. A player build must not carry it; an evaluation build gets it back
  // with `node tools/showcase-install.mjs`.
  ok(!packs(files, 'dist/assets/showcase.js'),
    'the effects showcase chunk is not packed');
  ok(!packs(files, 'dist/assets/showcase.js.map'),
    'nor its sourcemap');
  ok(packs(files, 'dist/assets/index.js'),
    'and refusing it did not cost the bundle its own chunks');

  // The sampled voices (#148) are the opposite case: they are the sound
  // itself, and a build that shipped without them would be silent for seven
  // effects with nothing in the logs until a player heard the hole. Every
  // registry entry is asserted individually, so an entry pointing outside the
  // copied asset tree fails here rather than in the field.
  for (const def of SAMPLES) {
    ok(packs(files, `dist/${def.url}`), `the sampled voice ${def.id} IS packed`);
  }
}

/**
 * The exclusion above names one exact path, so it is only worth anything while
 * vite is actually pinned to emit that path. Left to its default the showcase
 * chunk would ship as `showcase-a1b2c3d4.js` and walk straight past the `!`
 * line with every test here still green — the characteristic guard that
 * reports pass because it is blind. So ask the real config what it would name
 * the chunk.
 */
console.log('\n-- vite pins the showcase chunk to the name build.files refuses');
{
  const cfg = (await import('../vite.config.js')).default;
  const naming = cfg?.build?.rollupOptions?.output?.chunkFileNames;
  ok(typeof naming === 'function', 'the build declares a chunkFileNames rule');
  if (typeof naming === 'function') {
    ok(naming({ name: 'Showcase' }) === 'dist/assets/showcase.js'.slice(5),
      'a chunk named Showcase is emitted at assets/showcase.js, unhashed');
    ok(/\[hash\]/.test(String(naming({ name: 'Harness' }))),
      'every other chunk keeps its content hash');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
