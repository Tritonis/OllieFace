# bundle-seam — the Logbook lazy split (#237)

`before.txt` / `after.txt` are raw `npm run build` output, captured on this tree before and
after splitting `src/ui/Logbook.js` into the always-loaded `Logbook.js` (the 3D preview widget
`select` also uses, plus the run-report renderer) and the lazily-loaded `LogbookScreen.js` (the
actual browsing UI — every survivor/item/enemy/challenge/run-history tab).

## The honest numbers

| chunk | before | after |
|---|---|---|
| entry (`index-*.js`) | 1,267.14 kB / gzip 395.97 kB | 849.21 kB / gzip 288.83 kB |
| `Logbook-*.js` (eager — statically imported by `Menus.js` for `ModelPreview`) | — | 400.68 kB / gzip 102.93 kB |
| `LogbookScreen-*.js` (**lazy** — only fetched on first logbook-tab open) | — | 19.38 kB / gzip 6.68 kB |

The entry chunk's own file shrank by 418 kB, but 400.68 kB of that reappeared in a second file
that is *still* eager: `ModelPreview` (the 3D viewer) is statically imported by `Menus.js`
because the character-select screen needs it before any run starts, and `Menus.js` importing
`Logbook.js` for that reason pulls `Logbook.js`'s own module — including the slice of THREE's
`WebGLRenderer`/shader-chunk internals `ModelPreview.mount()` reaches — into the same
reachability class as the dynamically-imported `LogbookScreen.js`. Rolldown's default chunking
then extracts that shared material into its own file rather than leaving it duplicated inside
both the entry and the async chunk. Confirmed not to be new duplication: the shader-chunk GLSL
strings that dominate `Logbook-*.js` (e.g. `alphahash_pars_fragment`) do not also appear in
`three.core-*.js`, and grep shows none of `LogbookScreen.js`'s own markup (`book-tabs`, etc.)
leaked into either eager chunk.

**The real, provable win is `LogbookScreen.js`'s 19.38 kB (gzip 6.68 kB)** — the browsing UI's
own code (tab rendering, detail-panel builders, bestiary copy, `TABS`/`CAREER_ROWS`/`BEST_ROWS`
tables) — which a player who never opens the Logbook tab now never downloads or parses. That is
smaller than the ticket's scout note implied (GLTFLoader/EffectComposer are not actually imported
by the logbook path — see `tests/logbook-lazy-seam.test.mjs`'s header and the PR description for
why), but it is a real seam, not a cosmetic file split: the entry+eager-Logbook total (1,249.89 kB)
is 17.25 kB lighter than the old single entry (1,267.14 kB), matching `LogbookScreen.js`'s size
within chunking noise, and `tests/logbook-lazy-seam.test.mjs` proves the browsing UI's markup is
provably absent from both eager chunks.

## Reproducing it

```
npm run build   # writes dist/assets/*.js with content hashes; sizes match the table above
node tests/logbook-lazy-seam.test.mjs
```
