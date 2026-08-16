# Scoped re-review — commit 31901f0 (3aa8334..31901f0)

Fix wave addressing M1, m1, m4, m5, m6 (+m3 provenance) from
reviews/integ-0816/integration-review.md.

**SPEC: CONFIRMED** — every claimed fix verified against source and behavior.
**QUALITY: READY**

0 Critical, 0 Major, 0 Minor. Tests 77/77 files passed.

## Verification detail

1. **M1** — `tools/verify-trickle.mjs:139/147/154`: both optional chains
   (`?.freeze?.()`, `?.thaw?.()`) replaced with bare calls, each followed by
   `__GAME__.engine.running` assertion (`false` after freeze, `true` after
   each thaw) that `throw`s + `failed++` on mismatch. The throw is uncaught
   at module top level (only a `finally`, no `catch`), so Node's default
   uncaught-exception exit (code 1) fires — verified live by renaming the
   `freeze` key in the harness API object (Harness.js:6118) to `freezeRenamed`
   and re-running the probe: it threw `TypeError: globalThis.__HARNESS__.freeze
   is not a function`, real exit code 1 (confirmed via redirect, not
   pipe-to-tail, per the known masking pitfall). Reverted with `git checkout --
   src/core/Harness.js`; `git status --short` shows no tracked-file diff
   afterward. `package.json:21` adds `"probe:trickle": "node
   tools/verify-trickle.mjs"`. `tools/gates.mjs:208-214` adds a `trickle` arm,
   `tier: 'manual', manual: true`, `paths: ['tools/verify-trickle.mjs',
   'src/net', 'src/core/Harness.js']` — same exclusion mechanism as the
   `capture` arm (tier filter + `assertManual` throw), confirmed by reading
   `armsFor`'s tier partition (cheap/heavy only pick `tier==='cheap'/'heavy'`)
   and `assertManual` (tools/gates.mjs:131-140). `node tools/gates.mjs status`
   lists `OVERDUE trickle ... (manual — run by hand, then: gates.mjs status
   --record trickle)`.
2. **m1** — `tools/verify-trickle.mjs:211-215`: `if (ms != null && ms > 2000)`
   warns citing the docstring criterion verbatim. Live run (real join, no
   mutation): 6588 ms, WARNING fired, `trickleNegotiated: true`, exit 0 (a
   warning, not a failure — correct per the adjudication).
3. **m4** — Harness.js:1867-1873: `if (q === o || o.getObjectById(q.id))
   return;` excludes o's own subtree from counting as solid company.
   Reasoned through: veil V with solid child C — p (ancestor) traverses V+C;
   `o.getObjectById(C.id)` finds C inside V's own subtree, so C is skipped,
   no longer authorizes hiding V. Intended case (EnemyMeshes.js:747-749,
   `shell`/`edge` siblings under `ward`, `shell` childless) verified by
   reading source directly: `edge` is not in `shell`'s subtree, so
   `shell.getObjectById(edge.id)` is falsy, `edge` still counts as solid
   company. `_showVeils` now `for (const o of hidden ?? [])` — null-safe.
4. **m5** — `_hideVeils()` call moved from before `try {` to
   `veiled = _hideVeils();` as the first statement inside the try block
   (Harness.js ~2010); `let veiled = null;` declared above, so a throw inside
   `_hideVeils` now reaches the `finally`.
5. **m6/m3** — `tools/gates.mjs:113-118` and `CLAUDE.md`'s matching sentence
   both narrowed to "the only thing that exercises the separation/margin
   logic," with installHarness's other call sites (`gate:sp`/`mp1`/`elite`,
   `verify-trickle.mjs`) now named explicitly. `tools/capture.mjs:14-21`
   stamps `commit: COMMIT` via `execFileSync('git', ['rev-parse', 'HEAD'])` in
   a try/catch falling back to `null`; confirmed no other file imports
   `capture.mjs` (grepped `tools/*.mjs` + `package.json`), so this IIFE runs
   only when the script is invoked directly via `npm run shots` — effectively
   at capture-run start, not at some unrelated import. Not a concern.
6. **Live runs**: `npm test` — 77/77 test files passed. `node
   tools/verify-trickle.mjs --port 5599` — real run, freeze/thaw assertions
   passed silently, WARNING fired correctly at 6588 ms, exit 0. Red-proof
   (item 1) reproduced a loud, nonzero-exit failure as above.

## Clean

package.json wiring, gates.mjs tier partition, assertManual guard,
gates:status listing, wardMat sibling case, _showVeils null-safety,
_hideVeils try placement, capture.mjs git-absent fallback, CLAUDE.md/gates.mjs
comment consistency, test suite, working-tree cleanliness after red-proof.
