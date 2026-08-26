// tests/logbook-lazy-seam.test.mjs
//
// Issue #237: the logbook's browsing UI (`src/ui/LogbookScreen.js`) is loaded
// only when a player opens the logbook tab — `Menus` reaches for it with a
// dynamic `import()` inside `openLogbook()`, not a static `import ... from`
// at the top of the file, so a player who never opens the tab never pays for
// its module or the content tables it pulls in.
//
// The failure this file is written against is the module quietly going back
// to a static import — everything still *works* (the browsing UI still
// renders, `npm test` and the game both stay green), it just ships in the
// entry chunk again with nobody noticing. `npm test` never builds, so the
// static-source check below is the one that always runs and always catches
// it; the second arm reads an actual `dist/` when one is on disk (the same
// skip-loudly shape `tests/asset-budget.test.mjs` uses) as corroborating
// evidence that the split really does sever the bundle, not just the source.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const skip = (msg) => { skipped++; console.log('  SKIP ', msg); };

/** Block comments and whole-line `//`, the same strip `import-boundaries.test.mjs` uses. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

console.log('-- source: LogbookScreen.js is reached only through a dynamic import()');
{
  const menusSrc = stripComments(readFileSync(join(root, 'src/ui/Menus.js'), 'utf8'));
  const mainSrc = stripComments(readFileSync(join(root, 'src/main.js'), 'utf8'));

  // A static import — `import ... from './LogbookScreen.js'` or a bare
  // re-export — pulls the module into the entry's module graph regardless of
  // whether anything ever calls into it. This is the shape that must be
  // absent; making it present is the red half of this test's own claim (see
  // the header comment on `openLogbook()` in Menus.js for the fix this
  // guards).
  const staticImportRe = /(?:^|[\s;}])(?:import|export)\s[^'";]*?from\s*['"]\.\/LogbookScreen\.js['"]/;
  const dynamicImportRe = /\bimport\(\s*['"`]\.\/LogbookScreen\.js['"`]\s*\)/;

  ok(!staticImportRe.test(menusSrc),
    'src/ui/Menus.js has no static import of ./LogbookScreen.js');
  ok(dynamicImportRe.test(menusSrc),
    'src/ui/Menus.js reaches LogbookScreen.js through a dynamic import()');
  ok(!mainSrc.includes('LogbookScreen'),
    'src/main.js never names LogbookScreen.js at all — the seam is inside Menus, not the boot path');

  // `ModelPreview`/`disposeTree`/`renderRunReport` stay eager on purpose
  // (character select and the death screen need them at boot) — the split is
  // only supposed to defer the browsing UI itself.
  ok(/import\s*\{[^}]*\bModelPreview\b[^}]*\}\s*from\s*['"]\.\/Logbook\.js['"]/.test(menusSrc),
    'ModelPreview is still statically imported from ./Logbook.js (the always-loaded half)');
}

console.log('\n-- source: Menus never touches `this.logbook` before it can exist');
{
  const menusSrc = readFileSync(join(root, 'src/ui/Menus.js'), 'utf8');
  // The constructor no longer builds a Logbook eagerly.
  ok(!/this\.logbook\s*=\s*new\s+Logbook\(/.test(menusSrc),
    'the constructor does not eagerly construct a Logbook');
  ok(/this\.logbook\s*=\s*null/.test(menusSrc),
    'the constructor starts `this.logbook` as null instead');
}

console.log('\n-- build: the entry chunk does not carry the logbook browsing UI');
{
  const distAssets = join(root, 'dist', 'assets');
  if (!existsSync(distAssets)) {
    skip('no dist/ on disk — run `npm run build` to exercise this arm');
  } else {
    const files = readdirSync(distAssets);
    const entryChunk = files.find((f) => /^index-.*\.js$/.test(f));
    const logbookScreenChunk = files.find((f) => /^LogbookScreen-.*\.js$/.test(f));
    ok(!!entryChunk, `found an entry chunk (${entryChunk ?? 'none'})`);
    ok(!!logbookScreenChunk, `LogbookScreen.js has its own chunk (${logbookScreenChunk ?? 'none'})`);
    if (entryChunk) {
      const entrySrc = readFileSync(join(distAssets, entryChunk), 'utf8');
      // `book-tabs` is a literal class name only `LogbookScreen.js`'s markup
      // writes; a bundler that folded the browsing UI back into the entry
      // would leave this string sitting right there in plain text even after
      // minification, since CSS class names in a template literal survive
      // minification unchanged.
      ok(!entrySrc.includes('book-tabs'),
        'the entry chunk contains none of the logbook browsing UI\'s markup');
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
