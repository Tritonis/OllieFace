# Round 7 — round-4 fixes: engine loop, cross-tab saves, time-unit readout

Scope owned: `src/core/Engine.js`, `src/systems/Profile.js`, `src/ui/Logbook.js`.
Nothing else touched. Branch `round7/content-and-polish`, from `b18a2b4`, not
committed.

Raw data, all written this round, all cited by name below:

| file | contents |
|---|---|
| `reviews/round7/r4fix-engine/probe.json` | engine loop census (fixed / frozen / pre-fix algorithm), single-page save race, two-real-tab race, the save clean list, the time-format readout |
| `reviews/round7/r4fix-engine/probe2.json` | ping-pong settle, reset-vs-stale-tab, visibilitychange flush, foreign `localStorage.clear()` — **run 2** |
| `reviews/round7/r4fix-engine/probe2-run1.json` | the same script, run 1. Kept because one field disagrees with run 2; see §2.4 |
| `reviews/round7/r4fix-engine/probe3-reset-diag.json` | step-by-step instrumented reset-vs-stale-tab |
| `reviews/round7/r4fix-engine/probe4-capture-scale.json` | loops at 0/1/5/10/20/21 cumulative freeze/thaw cycles under the pre-fix algorithm, **with the clock pinned the way `capture.mjs` pins it** |
| `reviews/round7/r4fix-engine/shots/` | full 21-shot capture + manifest |

Every probe: headed Chromium, launch args copied from `tools/capture.mjs`
(`--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization
--force_high_performance_gpu`, parked off-screen), its own vite server on its own
port (5481–5485), driven through `?harness=1`, `globalThis.__GAME__` /
`__HARNESS__`. Four throwaway drivers (`tools/_r4fix_engine_probe.mjs`,
`_r4fix_probe2.mjs`, `_r4fix_probe3.mjs`, `_r4fix_probe4.mjs`) were deleted after
the run; the JSON they wrote is the record. `ctx.frameErrors === 0` and zero
console/page errors in every probe.

---

## 1. `Engine.start` re-armed a loop it could not identify — FIXED

`src/core/Engine.js:160`. `stop()` clears `running` but cannot cancel the rAF the
live tick has *already* armed. `freeze()` then `thaw()` inside one frame — which
is what every harness scenario does — left that callback queued; it woke to
`running === true`, re-armed, and ran alongside the chain `thaw()`'s `start()`
had just created.

Fix: a generation counter. `start()` mints `++this._loopGen`; each tick checks
`gen !== this._loopGen` and retires if a later `start()` has superseded it. Two
lines plus the comment explaining why `running` alone cannot identify a loop.

### 1.1 Both ends of the range

The failure this fix could overshoot into is obvious and was measured for:
an engine that stops accumulating loops *by not running at all*.

| arm | source | number |
|---|---|---|
| pre-fix, 0/1/2/3 cycles then `gameplay()`+thaw | `r4-content/probe5-final.json` → `results.engineLoops` (the content critic's own capture, on-disk) | **1 / 2 / 3 / 4 / 5** loops |
| post-fix, same five points | `r4fix-engine/probe.json` → `engineLoops.fixed` | **1.00 / 1.00 / 1.00 / 1.00 / 1.00** (60 `_frame` per 60 rAF at every point) |
| post-fix, after 21 further cycles | same, last row | **1.00** |
| post-fix, *while frozen* — does freeze still freeze? | `probe.json` → `engineLoops.frozen` | **0 engine frames per 30 rAF**, after each of 3 freezes |
| post-fix, does the engine still run after a thaw? | `probe.json` → `engineLoops.fixed`, `ctxTimeAdvance` | `1.00` loops and **0.600 s of `ctx.time` per 60 rAF** after `gameplay()`+thaw; `0.617` after 21 more cycles |

So: no accumulation at either 3 or 21 cycles, freeze still stops the engine dead,
and thaw still starts it — including 21 cycles later.

The pre-fix algorithm was also replayed **on this same build**, by replacing
`start` on the live engine instance with a byte-faithful copy of the code that
shipped at `b18a2b4` (`probe.json` → `engineLoops.oldAlgorithm`). It gives
2 / 3 / 4 / 5 loops at 0/1/2/3 cycles — the same **+1.00 loop per freeze/thaw
cycle** slope the critic measured, offset by one because the handover left the
pre-shim chain alive. That offset is an artefact of the shim, not of either
algorithm; the absolute pre-fix figures are the critic's, cited above.

### 1.2 Blast radius — asked for honestly, answered honestly

**How many loops does a full capture run accumulate?** Measured directly, with
the clock pinned the way `capture.mjs` pins it, under the pre-fix algorithm
(`probe4-capture-scale.json` → `pinnedOld`):

| cumulative freeze/thaw cycles | 0 | 1 | 5 | 10 | 20 | 21 |
|---|---|---|---|---|---|---|
| engine loops per presented frame | 2 | 3 | 7 | 12 | 22 | **23** |

(again +1 per cycle, +1 shim offset — so a clean 21-scenario capture ends at
**~22 loops per presented frame**, which matches the content critic's "roughly
twenty times" estimate).

**What did that do to time?** With the clock pinned, exactly what it looks like
— until it doesn't. `ctx.time` advanced per 60 rAF (`probe4`, `ctxTimeAdvance`):

| loops | 1 (fixed) | 2 | 3 | 7 | 12 | 22 | 23 |
|---|---|---|---|---|---|---|---|
| sim-seconds per 60 rAF | **1.000** | 2.000 | 3.000 | 7.000 | 11.817 | 10.517 | **0.000** |

Up to ~7 loops the simulation runs at exactly N× real. Past that it stops being
a clean multiple and becomes *non-linear and unpredictable*: `MAX_SUBSTEPS = 5`
saturates, `Engine._frame` bleeds the accumulator to zero
(`Engine.js:217`), and the last measurement advanced no simulation time at all.
So the late capture shots were not simply running 20× fast — they were running at
a saturated rate that is a function of frame pacing, which is the one input a
pinned clock exists to remove. That is a plausible mechanism for the
`06-loaded-hud` separation check three reports describe as flapping run to run,
though this round did not prove that link (see §5).

**Does fixing it change any previously-recorded number?** Yes, and here is the
uncomfortable part stated plainly:

- **Every round-3 probe that used the `H.gameplay(); H.thaw()` preamble ran the
  world at 2× per presented frame.** Anything those probes expressed in
  sim-seconds or as a rate is suspect. This is now measured rather than argued:
  at 2 loops the pinned engine advances exactly 2.000 sim-seconds per 60 rAF
  against the fixed engine's 1.000. A probe that waited on `ctx.time` got the
  simulation seconds it asked for but bought them in half the wall time and half
  the *rendered frames*; a probe that waited on frames got twice the simulation.
  Which of round 3's numbers move depends on which clock each waited on, and
  re-deriving them is not this fixer's scope — but no round-3 figure taken
  through that preamble should be quoted without re-measuring it.
- **The `06-loaded-hud` check's own numbers moved.** `sepP50` was **0.39** in two
  independent pre-fix captures (`r3-content/shots/manifest.json` and
  `r3-audio/shots-final/manifest.json`, both `subjectFailures[0].detail[0]`) and
  is **0.69** in mine (`r4fix-engine/shots/manifest.json`); `px` 763 → 759,
  `visibleObjects` 8 in all three. **I cannot attribute that delta to this fix.**
  Three other fixers' edits to `Combat`, `Director`, `Stage`, `items`, `enemies`,
  `Player`, `Progression`, `Audio`, `Music` and `tools/capture.mjs` were live in
  the working tree when my capture ran (`git status` recorded in §5), and any of
  them could move a monster-separation metric. Naming it as evidence for my fix
  would be exactly the kind of unattributable number this round's lesson is about.
- **Not a shipped-gameplay defect.** `engine.start()`/`stop()` have two callers,
  `main.js` and `Harness.js`; the pause menu uses `ctx.paused`. A player never
  freezes and thaws. This is a measurement and capture defect, and the cost of
  it was measurement.

---

## 2. Two tabs clobbering each other's saves — FIXED

`src/systems/Profile.js`. The write path was `setItem(JSON.stringify(this.data))`
over whatever was there, from a snapshot taken at `init()`.

### 2.1 The scheme

A **compare-and-merge write**, plus a `storage` listener for live convergence.

- `_load()` and `flush()` remember the exact bytes last seen on disk
  (`_baseRaw`) and a parsed copy of them (`_baseData`).
- `flush()` calls `_reconcile()` first. If the disk still holds `_baseRaw`,
  nobody else has written and the write is unconditional — the ordinary
  single-tab path costs one `getItem` and a string compare.
- If the disk has moved, `mergeProfiles(base, remote, mine)` does a **three-way
  merge against the common ancestor**, and the merge is what gets written.
- A `storage` event runs the same reconcile, so both tabs converge immediately
  rather than at the next flush; it writes back **only if the merge kept
  something the disk did not already have**, which is what stops two tabs
  answering each other forever.

### 2.2 What it does when two tabs genuinely conflict — explicitly

Nothing is discarded. Each field has a join chosen from what it means:

| field | join | why |
|---|---|---|
| lifetime sums (kills, time played, gold, per-survivor runs/kills, encounter counts) | `remote + (mine − base)` | each tab's own contribution, counted once. This is the reason the ancestor is kept: without it the only safe join is `max`, which throws away the smaller tab's play entirely |
| personal bests, challenge `progress`, challenge `goal` | maximum | |
| unlocks, challenge `done`, first-seen stamps | union, keeping the **earliest** timestamp | "when did I first earn this" is a fact about the player; the later write is not a re-earning |
| run history | union by the `at` stamp, re-sorted, re-capped at `MAX_RUNS` | **a completed run can now only be dropped by being older than 25 other runs** — the same rule one tab already plays by |
| `reset()` / `importProfile()` | **overwrite, not merge** | the player asked the profile to *become* something; merging a wipe against the copy it is wiping would undo it |

The one lossy arm, named: if two tabs together commit more than `MAX_RUNS = 25`
runs between reconciles, the oldest fall off the list — identically to a single
tab. Nothing else is capped.

### 2.3 Before / after

Before, the meta critic's live reproduction, on disk at
`reviews/round7/r4-meta/probe2.json` → `twoTabRace`:
`bLoadedKills 10, storageAfterA2 25, storageAfterB 13` — **12 kills lost.**

After, the identical sequence:

| arm | source | result |
|---|---|---|
| same sequence, two `Profile` instances in one page (no `storage` events — the flush-time reconcile alone) | `probe.json` → `singlePageRace.twoTabRace` | `bLoadedKills 10, storageAfterA2 25, storageAfterB` **28** — `lostKills: 0` |
| same sequence, **two real browser tabs** | `probe.json` → `twoRealTabs` | disk **28**; both tabs' in-memory profiles converged to `kills 28`, `runs [5002, 5001]`, `unlocks [aTab, bTab]` |
| three writers, one of them holding a snapshot older than both others | `probe.json` → `singlePageRace.threeWayFlush` | both completed runs on disk (`at` 1000 and 2000), all three unlocks (`survivor.cinder`, `item.medkit`, `artifact.glass`), `statsRuns 2` |
| do the two tabs settle, or ping-pong? | `probe2.json` → `settles` | **1 write by each tab**, disk 14, both memories 14 |
| `reset()` still a wipe, against a concurrent tab | `probe.json` → `reset`; `probe3-reset-diag.json` | `afterResetRuns 0`; the stale tab's memory went 100 → **0** on the reset's storage event, and its next write produced **1**, not 101 |
| `importProfile()` replaces rather than merges | `probe.json` → `import.afterImport` | **7** (the imported value), not 507 |
| another tab calls `localStorage.clear()` | `probe2.json` → `foreignClear` | this tab keeps its profile in memory (`kills 42`) and restores it on its next write, rather than adopting the wipe |

### 2.4 Residual, and one instrument disagreement I could not close

`localStorage` has **no atomic compare-and-swap**. `_reconcile()` reads and
`flush()` writes as two separate operations, so a foreign write landing between
them can still lose one delta. Run 1 of `probe2` recorded
`resetVsStaleTab.afterStaleTabWrites: 0` where run 2 and the fully-instrumented
`probe3-reset-diag.json` (which shows the disk at 1 immediately after the write
and at every step after) both record **1**. Both raw files are kept
(`probe2-run1.json`, `probe2.json`); the 2-of-3 answer is 1 and the mechanism is
instrumented, but I am not claiming run 1 was an instrument artefact, because a
non-atomic read/write window is exactly the shape that would produce it
intermittently.

**Declined:** closing that window with `navigator.locks.request()`. It is async,
and `flush()` is synchronous *by requirement* — it is called from `pagehide` and
from a hidden `visibilitychange`, where an async continuation is not guaranteed
to run. Making the last line of defence against a killed tab asynchronous to
close a same-millisecond two-tab race is the wrong trade, and it is a design
decision rather than a fix, so it is escalated rather than taken.

### 2.5 The meta clean list, re-run against the changed write path

All from `probe.json` → `cleanList`, plus `probe2.json`:

- **v1→v2 migration**: `version 2`, `encounters.enemy.grunt {at: 111, count: 0}`,
  challenge `doneAt 42` preserved, `survivors.ranger` reconstructed from the run
  list (`runs 1, deaths 1, kills 4, time 60, bestStage 3`).
- **Corrupt / hostile / future payloads**: truncated JSON, an array, a bare
  string, `null`, an all-wrong-typed object, a `__proto__` literal, `version: 99`
  — none threw, all produced a type-correct profile (`killsIsNumber: true` in
  every case), `({}).polluted` stayed `undefined` in every case, and the two
  legible ones kept their data (`protoLiteral` kills 1, `future` kills 3).
  Note `_parse` now returns `null` instead of a fresh profile on garbage, so the
  reconcile can tell "unreadable" from "empty"; `_load` supplies the fresh
  profile at the same point it always did.
- **Quota exceeded**: forced `QuotaExceededError` on `setItem` — `flush()`
  swallowed it, set `_storageBlocked`, engine still running.
- **Unlock idempotency**: first `true`, second `false`, stamp stable.
- **Abandoned-debounce race**: `_touch()`, then `reset()` before the timer fires
  — disk 0 at the reset and still 0 after the original timer's deadline.
- **`visibilitychange` flush** (re-run because I edited that listener block):
  5 kills sitting mid-debounce, `document.dispatchEvent(new Event(...))` with
  `visibilityState` forced hidden → disk went **1 → 5** on the dispatch alone.

---

## 3. `marathon` printed as raw seconds — FIXED

`Profile._buildReport` now tags each `advanced` row with a `format`, exactly the
way its sibling `records` list already did five lines below, and
`challengeState()` carries the same tag so the logbook's list row and detail
panel get it too. `Logbook.progressPair()` consumes it.

`src/data/challenges.js` belongs to the content fixer this round, so the
seconds-scoped ids (`marathon`, `clockedIn`) are named in `Profile.js` rather
than as a `format` field on the definition, where they belong. The set is
checked against the real definitions at module scope, so a rename warns instead
of silently reverting to raw seconds. That is the one piece of this fix that
should move to `challenges.js` when that file is free.

Which helper is picked depends on the **goal**, not the progress: `clock()`
below an hour, `duration()` at or above it — because `clockedIn`'s ten-hour goal
would otherwise read `600:00`.

| readout | before (`r4-meta/probe3.json`) | after (`r4fix-engine/probe.json` → `timeFormat`) |
|---|---|---|
| death screen "Closing in", `marathon` at `run.time = 1074` | `1,074 / 1,800` | **`17:54 / 30:00`** |
| logbook challenges list row, `marathon` | `1074 / 1800` (`logbookRow.subText`) | **`17:54 / 30:00`** |
| logbook challenges list row, `clockedIn` | (same defect, 36000-second goal) | **`17m / 10h 0m`** |
| logbook detail panel, `marathon` | `1074 / 1800` | **`17:54 / 30:00`** |

Both ends of this one too: the **non-time** rows are unchanged. `veteran` still
reads `1 / 25` in the list and detail, and the "Closing in" panel's other two
rows still read `1 / 5` (`timeFormat.closingInRows`) — the run report keeps its
four-digit abbreviation and the logbook keeps its exact number, because
`progressPair` takes the plain formatter as an argument rather than picking one.
`challengeStateFormat` confirms the tag itself: `marathon: 'time'`,
`clockedIn: 'time'`, `veteran: 'number'`.

---

## 4. Build and capture

- `node node_modules/vite/bin/vite.js build` — **exit 0**, `✓ built in 1.28s`,
  only the pre-existing chunk-size advisory.
- `node tools/capture.mjs --out reviews/round7/r4fix-engine/shots --port 5484` —
  **21/21 shots**, `ready: true`, `partial: false`, `clockPinned: true`,
  `frameDt 1/60`, `frameTimeouts 0`, **0 console/page errors**.
- **`06-loaded-hud` is the single failing check, unchanged in kind**: the same
  `subject missing or illegible — monsters under load`, same
  `visibleObjects 8/10`. Not chased, per the brief. Its `sepP50` moved 0.39 →
  0.69 and `px` 763 → 759 against the two pre-fix captures on disk; §1.2 explains
  why I am not attributing that to this fix.

---

## 5. Arms I did not test — named

- **Attribution isolation for the capture.** My capture ran with three other
  fixers' edits live in the tree (`git status --porcelain -uno` at capture time:
  `Engine.js, abilities.js, enemies.js, items.js, Player.js, Audio.js,
  Combat.js, Director.js, Items.js, Music.js, Profile.js, Progression.js,
  Logbook.js, Stage.js, capture.mjs`). No manifest number from that run is
  attributable to my three changes alone. The engine numbers in §1 are, because
  they come from the A/B inside one page.
- **Whether the engine fix actually stabilises `06-loaded-hud`.** The mechanism
  is now plausible and measured (§1.2), but I did not run the repeat captures
  that would show the flapping stop, and I could not have attributed the result
  if I had.
- **`tools/perf.mjs`.** It deliberately runs on the unpinned clock and does not
  freeze/thaw, so it should be untouched — but I did not run it.
- **A physical or OS-registered gamepad, a real mobile tab reclaim, touch input,
  a live co-op second client, a hand-played end-to-end run.** Unchanged from
  rounds 2 and 3; nothing in this environment closes them.
- **Two separate browser *processes* / windows.** My two-tab test used two pages
  in one Playwright context — same origin, same storage partition, and the
  `storage` event delivered by the browser between them, which is the real
  mechanism. It is not two independently launched browser windows, and it is not
  three or more tabs.
- **A merge under a disk that is at quota.** Quota was tested on the plain write
  path only; a merge that then fails to write leaves `_storageBlocked` set and
  the merged copy in memory, which is the same outcome, but it was not exercised.
- **A profile large enough for the merge to be measurable.** The merge is
  `Object.keys` over maps whose size is the content catalogue plus a 25-run
  array, on a debounced write. Not profiled.
- **The `storage` listener under a genuinely hostile foreign write** (another
  origin's script cannot reach this key, but a hand-edited `localStorage` from
  devtools in a second tab can). The payload goes through the same `_parse`
  migrate/coerce path as a stored one, and §2.5 covers those payloads at load
  time — but not delivered through a live `storage` event.
