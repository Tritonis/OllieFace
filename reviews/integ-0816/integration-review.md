# Integration review — b206a10..HEAD (3aa8334)

Three no-ff lane merges (B: probe harness readiness; C: Engine.add publication
recording; A: veil separation mask) plus one comment-only amendment.

**SPEC: CONFIRMED** — every cross-lane claim independently verified, no
reproducible failure found in the integrated tree.
**QUALITY: NOT READY** — 1 Major (an unguarded, unwired mechanism this batch
made load-bearing) and 6 Minor.

Counts: **0 Critical, 1 Major, 6 Minor**. Tests **77/77 files pass**; heavy
gates **3/3 pass** (run by me on the integrated tree — they had never run on
any commit in this range).

---

## Commands run (all on integrated HEAD = 3aa8334)

| Command | Result |
|---|---|
| `npm test` | exit 0 — **77/77 test files passed** |
| `node tools/verify-trickle.mjs --port 5599` | 1/1 join connected, trickle negotiated, both channels open, **6187 ms** |
| `npm run gates:heavy` | **PASSED (3/3)** — gate:sp, gate:mp1, gate:elite, all "no fields moved" |
| `node tests/probe-ports.test.mjs` | 9/9 checks passed |
| `node tools/gates.mjs status` | see Minor 3 |
| `git show --stat` on each merge; `git merge-base` on each pair | clean, see Q5 |

**Note on the brief's "should be 78 test files":** that expectation is wrong.
`tests/engine-criticality.test.mjs` already existed at b206a10 (created in
`8c78bb8`, pre-range) and was *extended* by `76d5dad` — the `133 ++` in
`git diff --stat` is a pure-addition modification, not a new file. Only
`tests/vfx-atlas-failure.test.mjs` is new. Tracked test files: 76 → 77.
Verified with `git ls-tree -r b206a10 tests/` vs `HEAD`, diffed: exactly one
added path. **77/77 is correct and complete.**

**Side effect I caused and reverted:** `verify-trickle.mjs:219` writes
`reviews/parked/verify-trickle.json`. My run overwrote the committed artifact;
I restored it with `git checkout --`. The pre-batch committed value is
recoverable via `git show HEAD:reviews/parked/verify-trickle.json` and is used
as the comparison baseline below.

---

## Cross-lane questions

### Q1 — Can lane B's freeze/thaw interact badly with lane A's veil hide/show?

**No. Structurally impossible, and verified for timing.**

*Interleaving:* `subjectReport`'s guarded span is `src/core/Harness.js:1994`
(`try {`) through `:2174` (`} finally { _showVeils(veiled); }`). I grepped that
exact range for `await`/`async`: **zero matches**. The whole span — mask render,
`readRenderTargetPixels`, per-object statistics — is synchronous. JavaScript is
single-threaded, so no `page.evaluate(() => __HARNESS__.freeze())` from
Playwright, and no rAF tick, can land between `_hideVeils()` and `_showVeils()`.
A veil can never be left hidden by a freeze arriving mid-measurement.

*Reentrancy* (checked even though it needs no await): if `subjectReport` were
re-entered, the inner `_hideVeils` would find every veil already
`visible === false` and be filtered out by its own `if (!o.visible …) return`
guard, so the inner `hidden` array is empty and the inner `finally` restores
nothing. Only the outer call restores. Safe by construction.

*Reachability:* `verify-trickle` never calls `subjectReport` at all — it calls
only `freeze`/`thaw`. The two mechanisms do not meet.

*installHarness cost on probe pages.* I enumerated every eager statement in
`installHarness` (grep for top-level non-`const` statements). There are exactly
four:

- `src/core/Harness.js:58` — `ctx.pipeline?.setAdaptive?.(false, 1)`
- `:74` — `ctx.events.on('stageStart', …)`
- `:1778` — `ctx.harness = { subjects }`
- `:6127` — `globalThis.__HARNESS__ = H`

Only `:58` is behaviourally significant: adaptive resolution scaling is now
disabled and scale pinned to 1 on `verify-trickle` pages, which it was not
before. `:2753` (`pinclock`) and `:2775` (`coophost`) are URL-gated and neither
flag is passed.

**Measured, not assumed:** integrated run join 1 (trickle) = **6187 ms**;
pre-batch committed artifact `reviews/parked/verify-trickle.json` join 1
(trickle) = **6540 ms**. Same mode, same measurement. No timing regression from
installHarness. (Both are single samples; the direction is favourable and the
magnitude is inside run noise either way.)

*Relay safety of the freeze — the hazard nobody asked about.* `freeze()` is
`engine()?.stop?.()`, which clears `running` and stops the rAF chain
(`Engine.js:512-534`). The host page is therefore not ticking for the whole of
page B's boot. I checked whether anything the relay needs is frame-driven:
`src/net/Lobby.js:655-660` drives the relay keepalive from `setInterval`, not
from `update()`, and WebSocket/WebRTC negotiation is event-driven. **A frozen
host cannot lose its room.** This is why the mechanism is safe to have made
load-bearing.

**Verdict: clean.**

### Q2 — Can lane C's `remove()` revert null something Harness holds live?

**No. Proven from the ctx literal.**

`ctx.scene` and `ctx.camera` are constructed in the Engine constructor
(`src/core/Engine.js:107-109`), *before* any `add()` runs. `_snapshotCtx()`
therefore captures them in every `before` map, and `_recordPublications`
(`Engine.js:~470`) skips any key whose value is unchanged
(`if (before.has(k) && before.get(k) === v) continue`). So `scene` and `camera`
can never enter `_published`, and `remove()` can never null them. Lane A's
`_hideVeils` reads `ctx.scene.traverse` with no optional chaining — safe.

*`remove()` call sites, swept independently* (`grep -rn` across `src/ tools/
tests/`): exactly **`src/core/Engine.js:365`** (add's own failure rollback) and
**`src/net/Lobby.js:871`** (`this.engine.remove?.(this.net)`), plus test-only
calls in `engine-criticality` and `lobby-lifecycle`. The docstring's claim about
its own reachability is **verified true**, not taken on faith. No harness, no
probe, and no realm code calls `engine.remove`.

*Retention hazard I looked for and did not find.* `_published` holds a strong
`Map(key → value)` per system for the life of the engine. If a system's `init`
published a value that is later *replaced*, the old value would be retained
(a real leak shape for stage/world rebuilds). I traced every candidate:

- `src/world/Stage.js:150` — `ctx.stage = this` (identity; the Stage system is
  already in `this.systems`)
- `src/entities/Player.js:152` — `ctx.player = this` (identity)
- `src/entities/Player.js:292` — `ctx.setSurvivor = (id) => this.setSurvivor(id)`
  (closure over the live Player)

All three retain only objects that are alive anyway. `Realms.js:313/369`
reassign `ctx.stage` at runtime, but the *retained* value is the original Stage
system, not a discarded world. **No retention leak.**

*Probe interaction.* `installHarness` runs at `src/main.js:166-174`, after
`engine.start()` and after every `engine.add()`, so `ctx.harness` is written
outside any `add()` window and `_recordPublications` never sees it. Lane C's
recording is also positively exercised on the integrated tree: `gate:sp`,
`gate:mp1` and `gate:elite` all boot the real game under `?harness=1`
(`tests/sp-equivalence.mjs:386`) and all three pass with "no fields moved".

**Verdict: clean.**

### Q3 — What surface does no gate cover? (see Major 1 and Minors 1–3)

The honest whole-surface enumeration:

| Changed surface | Covered by |
|---|---|
| `src/core/Engine.js` (add/remove) | `npm test` (`engine-criticality`, `lobby-lifecycle`, `vfx-atlas-failure`), and all 3 heavy gates boot through it — **covered** |
| `src/core/Harness.js` — `_hideVeils`/`subjectReport` | **capture gate only, which is `manual: true` and has never been recorded in this checkout** (Minor 3) |
| `tools/coopprobe.mjs` | `probe:coop` (manual, not run here — its harness=1 was pre-existing, only the readiness wait changed) |
| `tools/verify-trickle.mjs` | **nothing — no npm script, no gate arm, no staleness tracking** (Major 1) |

`tools/gates.mjs:204` gives the capture arm
`paths: ['src/core/Harness.js', …]`, so lane A's change *does* correctly drive
that arm OVERDUE. Nothing gives `tools/verify-trickle.mjs` an arm at all.

### Q5 — Merge sanity

All three merges are structurally clean:

- `7443b45` (lane B, `Fixes #93`): parents `b206a10` + `59f575a`, merge-base `b206a10`
- `03cdeed` (lane C, `Refs #92`): parents `7443b45` + `76d5dad`, merge-base `b206a10`
- `9f172c4` (lane A, `Fixes #89`): parents `03cdeed` + `e557512`, merge-base `b206a10`

Every lane branched from `b206a10` **exactly** — zero staleness, so the
"agent worktree branched 15 commits stale" hazard did not occur. File surfaces
are fully disjoint (tools / Engine+tests / Harness+manifests): no lane touched a
file another lane touched, so no merge had anything to resolve. All three carry
an explicit `-m` in house style with a `Co-Authored-By` trailer and an issue
reference. Lane C uses `Refs #92` rather than `Fixes` — correct, since its
docstring states the post-init republish limitation is deliberately left open.
**No half-merges.**

---

## Findings

### MAJOR

**M1 — `tools/verify-trickle.mjs:139` — the freeze this batch made load-bearing
is itself guarded by nothing, and half of it still fails silently.**

Lane B's premise is correct and its fix works: before, `__HARNESS__` was
undefined on these pages, so `globalThis.__HARNESS__?.freeze?.()` evaluated to
`undefined` and froze nothing. Adding `&harness=1` (`:107`) and the
`__HARNESS__ != null` readiness wait (`:109`) makes it real. I confirmed the
mechanism fires end-to-end by running the probe.

The problem is what happens when it regresses.

- *The `harness=1` half is guarded.* Drop `&harness=1` from `:107` and the
  `waitForFunction` at `:109` times out after 120 s and fails loudly. Good.
- *The freeze half is not.* `:139` is still
  `globalThis.__HARNESS__?.freeze?.()` — the **second** optional chain survived
  the fix. If `freeze` is ever renamed or dropped from the harness API object
  (`src/core/Harness.js:6111`), this silently reverts to a no-op with
  `__HARNESS__` present, so the readiness wait passes and the probe reports
  success. Nothing asserts `__GAME__.engine.running === false` inside the
  window, and nothing asserts it is `true` again after `:141-142`.
- *Nothing runs it anyway.* `verify-trickle` has **no entry in
  `package.json` scripts** (unlike every other probe: `probe:coop`, `padprobe`,
  `baseline:net`, `smoke:steam`) and **no arm in `tools/gates.mjs`** — not even
  a `manual: true` arm like the capture gate. It is therefore invisible to
  `gates:status` and can never go OVERDUE. `tests/probe-ports.test.mjs` reads it
  statically for its port claim (5599) and nothing else.

This is precisely the repo's documented dominant defect shape: a guard that
reports green on the bug it was written to catch. The mechanism was fixed; the
thing that would notice it breaking again was not built.

*Minimal fix:* an assertion around `:139-142` — read
`__GAME__.engine.running` after the freeze and after each thaw and fail the run
if it is not `false` then `true` — plus a `"probe:trickle"` script and a
`manual: true` arm in `gates.mjs` with
`paths: ['tools/verify-trickle.mjs', 'src/net', 'src/core/Harness.js']`.

### MINOR

**m1 — `tools/verify-trickle.mjs:121-123` — the probe exits 0 on a result its
own docstring calls a non-reproduction.**
Header (`:12-14`): *"A run whose slowest join is still multi-second has NOT
reproduced the fix, whatever its average says."* My integrated run: **6187 ms**,
squarely inside the old bimodal slow mode (3.3–10.9 s). Exit code is 0. The
only warning the script emits is `:121-123`, on trickle *negotiation*, which was
`true`. Pre-existing, not caused by this batch — the pre-batch committed
artifact records 6540 ms for the same join — and the freeze mitigates page-B
*load* starvation rather than join time, so no improvement was expected here.
But the batch's stated value ("draws breath for the first time") is unfalsifiable
without a timing assertion. Worth folding into M1's fix.

**m2 — heavy gates had never run on any commit in this batch.**
`.gates/state.json` recorded `gate:sp`/`mp1`/`elite` last passing at `16337d6`
— a pre-range commit — and `gates:status` read OVERDUE for all three, despite
`src/core/Engine.js` and `src/core/Harness.js` having changed. CLAUDE.md's merge
protocol requires re-running the gates on the integrated result. **I ran
`npm run gates:heavy`: PASSED (3/3), all "no fields moved".** Closed, but the
step was skipped at merge time.

**m3 — the capture gate has never been recorded, so lane A's evidence is
invisible to `gates:status`.**
`node tools/gates.mjs status` reports
`OVERDUE capture — never run in this checkout`. Lane A did run it —
`reviews/veil-mask/after2/manifest.json` is genuinely green
(`subjectFailures: []`, `subjectsOk: true`, `partial: false`, 23 shots, only the
two documented `only-path-enforced` skips) against a red before-manifest whose
single failure is `11-bestiary` object 13 at `px 3329, sepP50 0.17`, matching the
docstring's "all 3,329 px" claim exactly. But `node tools/gates.mjs status
--record capture` was never run, so the record does not exist and the arm will
keep reading OVERDUE.

*Provenance caveat, resolved but only by inference.* The manifests carry no
commit stamp, only `capturedAt`. `after2` was captured at 22:01:21Z; lane A's
final commit `e557512` is timestamped 22:03:39Z — i.e. the capture **predates
the commit by 2m18s**. The same capture-then-commit rhythm holds for the other
two (`before` 21:44Z / `after` 21:46Z vs `fd28eda` at 21:51Z), so `after2` was
almost certainly taken against `e557512`'s working tree. I also checked it does
not matter: `e557512`'s only code changes are `VEIL_OPACITY 0.12 → 0.08` and
moving `_showVeils(veiled)` into a `finally`. The `finally` is behaviourally
identical on a non-throwing run, and no material in the 23 staged shots has live
opacity in `[0.08, 0.12)` — the warden shell is 0.05 (below both) and the ward
dome, the only thing in that band, is not staged in any shot. So `after2` is
green under either threshold. Recommend `manifest.commit` be stamped, per the
repo's own "name the baseline capture" rule.

Note the capture gate has also **not** been run on the *integrated* tree. Risk
is low: the only Harness.js change after `after2` is `3aa8334`, which I verified
is comment-only (filtering the diff to non-comment lines yields nothing), and
lane C's Engine.add path is exercised green by all three heavy gates under
`?harness=1`. But `npm run shots` + `--record capture` should be run before the
capture gate is treated as green.

**m4 — `src/core/Harness.js:1854-1866` — a veil's own solid descendant both
authorises hiding it and is then hidden with it.**
The solid-company walk goes *up* the ancestor chain and calls `p.traverse(…)`,
which covers p's **entire subtree — including `o`'s own children** (only `q === o`
is excluded). So for a veil mesh V with a solid child C: C satisfies
`solid = true`, V is hidden, and three.js visibility inheritance takes C out of
the render with it. That inverts the stated intent — "only a veil with visible
company is dropped" is supposed to mean company that *stays* visible — and it
would silently remove real subject geometry from the mask.

Not reachable today: I checked every veil the docstring names and all are leaf
meshes. `wardMat('fill')` at `src/entities/EnemyMeshes.js:697` is opacity 0.05
and its mesh `shell` (`:747`) has no children; its sibling `edge` at 0.85
(`:748`) is the intended solid company, one level up under the `ward` group
(`:749`) — well inside the 3-ancestor bound, so the intended case works exactly
as documented. The ward dome (`src/entities/Placeables.js:208-216`) is a leaf.
Latent, but it will bite the first time art nests a solid detail inside a wash.
*Fix:* skip `q` when `o.getObjectById(q.id)` — i.e. require the company to be
outside `o`'s own subtree.

**m5 — `src/core/Harness.js:1997` — `_hideVeils()` is called one line *outside*
the `try` it is protected by, and dereferences `ctx.scene` bare.**
`const veiled = _hideVeils();` sits at `:1997`; `try {` opens at `:1998`. If
`_hideVeils` itself threw, the `finally` would never run. Benign in practice —
`veiled` would be unassigned so nothing would be hidden to restore — and
unreachable anyway, since Q2 proves `ctx.scene` can never be nulled. Nit, noted
only because the `finally` comment reasons carefully about exactly this class of
leak and this one line is outside its scope.

**m6 — `tools/gates.mjs:115` — stale claim about the verification surface.**
The comment says nothing else exercises `installHarness` or the separation/margin
logic. The second half is still true; the first half is not, and this batch made
it more wrong: `tests/sp-equivalence.mjs:386` has always booted `?harness=1`
(so all three heavy gates call `installHarness`), and `tools/verify-trickle.mjs:107`
now does too. CLAUDE.md's Verification section carries the same claim. Since the
exclusion argument for keeping the capture gate out of the cheap/heavy tiers
rests on this sentence, it should be narrowed to "nothing else exercises the
separation/margin logic".

---

## Clean

subjectReport/freeze non-interaction, freeze relay-keepalive safety,
installHarness eager-side-effect enumeration, probe timing vs pre-batch
baseline, ctx.scene/ctx.camera immunity to remove(), remove() call-site sweep,
_published retention, coopprobe single page-creation path, veil docstring
citations (Placeables.js:407, Director.js:1225, Director.js:1348,
RealmArena.js:846, EnemyMeshes.js:697 — all verified accurate), parentless-mesh
exclusion, _showVeils restore correctness, _hideVeils reentrancy, merge
structure, merge-base staleness, lane file-surface disjointness, commit
trailers, test file count, npm test, gates:heavy, probe-ports.
