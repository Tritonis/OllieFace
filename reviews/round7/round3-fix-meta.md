# Round 7 — round 3 fixes: meta progression (Profile, UnlockRegistry, challenges, run-summary UI)

Answering `reviews/round7/round2-meta.md` (critic C2) at HEAD `75f87d6`, branch
`round7/content-and-polish`. Seven findings, seven fixes, all seven verified
live. Files touched, all within the assigned ownership:
`src/systems/Profile.js`, `src/systems/UnlockRegistry.js`,
`src/data/challenges.js`, `src/ui/Logbook.js`, `src/ui/Menus.js`.
`src/ui/hud.css` and `src/core/Harness.js` were read and **not** changed — see
"Files I did not need to touch".

## Where every number below comes from

Two throwaway Playwright probes, written into `tools/_r3meta_probe.mjs` and
`tools/_r3meta_probe2.mjs`, run, and **deleted before finishing** (confirmed
absent from `tools/`). Their raw output is kept on disk and is the only source
of any number in this report:

- `reviews/round7/r3-meta/probe.json` — findings 1, 2, 3, 4, 5, 6.
- `reviews/round7/r3-meta/probe-regression.json` — the round-2 "checked and
  clean" list, re-run against the changed code.
- `reviews/round7/r3-meta/capture/` — the 21-shot capture and its
  `manifest.json`.

Both probes booted the real game from a real vite server at
`?seed=1337&quality=3&harness=1&pinclock=1` and drove it through
`globalThis.__GAME__.ctx` / `__HARNESS__`, the sanctioned harness surface.
They run **headed on the real adapter** with `capture.mjs`'s own GPU flags
rather than headless SwiftShader: under `--use-angle=swiftshader` the page
never reached a live stage inside a 300 s budget on this machine (two runs
timed out; `probe.json` was produced only after the switch, "stage live" at
49 s). This is the same effect `tools/capture.mjs:32-34` documents and the
same one that made round 2's screenshots time out.

"Before" numbers are quoted from `round2-meta.md`'s own reproductions rather
than re-derived, except where stated; every "after" number is from the files
above.

---

## 1. CRITICAL — `run.time` is never populated → `marathon` unwinnable, `blitz` free

**Fix:** `Profile._syncRunClock()` (`src/systems/Profile.js`), called at the
top of `_evaluate`, from `currentRun()`, and once in `commitRun` before the
live run object is released. It pulls `ctx.time` — the same clock the
persisted record's `time` is taken from — onto `this.run.time`, monotonically.

**Why pulled rather than pushed.** The critic's two suggestions were a timer
in `Profile` or a push from `Progression.fixedUpdate`. `Progression.js` is
owned by another agent this round and is off my list, so the push was not
available to me; a timer would be a second clock that can disagree with the
one `commitRun` writes into run history. `Profile` is not a registered system
and has no frame of its own, but every reader of `run.time` goes through
`_evaluate` or `currentRun`, so sampling at the read is exactly as fresh as a
per-frame copy and costs nothing between events. Using raw `ctx.time` (not an
elapsed-since-`beginRun` delta) is deliberate: it is the value
`Progression.stats.time` carries and therefore the value `record.time` is
built from, so a challenge and the run history can never disagree about how
long a run was. `ctx.time` only advances while unpaused (`Engine.js:208-213`),
so a run accrues nothing on the title screen or in a menu.

**Other readers of the same missing field.** Grepped `src/` for `r.time` /
`r?.time` / `currentRun()`: the only readers are `marathon`
(`challenges.js:186`), `blitz` (`:200`) and `Profile.currentRun()`, which has
no in-tree caller today but is a public API and is now covered by the same
sync. `Logbook.js:506` and `:756` read `r.time` off a **run history record**,
not the live run — that path was always correct. No third challenge or readout
was silently depending on it.

**Before** (`round2-meta.md` §1, its own probe): `runTimeAfterEvents: 0`,
`blitz {progress 1, done true}` at zero elapsed time, `marathon {progress 0,
goal 1800}` — and, by the same evidence, never able to advance on any run.

**After** (`probe.json` → `runTime`):

| arm | run.time | challenge |
|---|---|---|
| stage 5 at t=0 | `0` | `blitz` done — correct, an arrival at zero *is* within ten minutes |
| clock to 12 min | `720` | `marathon 720/1800`, not done |
| clock to 31 min | `1860` | `marathon 1800/1800`, **done** |
| `currentRun().time` at 31 min | `1860` | — |
| clock rewound to 5 s | `1860` | monotonic, as designed |
| **stage 5 at t=8 min, fresh profile** | `480` | `blitz` **done** |
| **stage 5 at t=14 min, fresh profile** | `840` | `blitz {progress 0, done false}` |
| `commitRun` at t=20 min | — | `record.time 1200`, `marathon 1200/1800` |

The discriminating pair is the last two blitz rows: before the fix a stage-5
arrival completed `blitz` at *any* elapsed time, because `r.time` was
permanently `0`. It now refuses at fourteen minutes and accepts at eight.
`marathon` reaching `1800/1800` is the first time that challenge has ever
been completable.

## 2. CRITICAL — the hidden-tab flush listened on `window`, where `visibilitychange` never fires

**Fix:** `src/systems/Profile.js` — `pagehide` stays on the bare (window)
`addEventListener`, which is where that event actually fires; the
`visibilitychange` handler moved to `document.addEventListener`, with its own
`typeof document` guard so a non-DOM host still boots. Comment rewritten to
say why the two are registered on different targets, so the next reader does
not "tidy" them back together.

**Verified against the failure mode, not the mechanism.** The test is whether
progress made inside the 1500 ms write debounce reaches storage when the tab
goes away — not whether a listener is attached.

**After** (`probe.json` → `saveDurability`, `saveSurvivesQuit`):

- `whereTheEventLands: {sawOnWindow: false, sawOnDocument: true}` — the
  platform behaviour the bug turned on, re-confirmed on this build.
- `hiddenTab`: 7 kills emitted, `pending {dirty: true, timerArmed: true}`,
  `midDebounce: 0` in `localStorage`, then a `document`-targeted
  `visibilitychange` with `visibilityState: 'hidden'` → `afterHide: 7`.
  **Before the fix this arm read `wroteViaDocumentDispatch: false`**
  (`round2-meta.md` §2) — the same dispatch changed nothing.
- `pagehide`: 3 further kills, `beforePagehide: 7` → `after: 10`. The arm that
  already worked still works.
- **Abrupt quit, end to end** (`saveSurvivesQuit`): 11 kills, tab hidden the
  browser's way, then `page.goto` straight back to the app with no flush, no
  `commitRun` and no graceful teardown → `killsAfterColdBoot: 11`. Nothing
  lost across a real page death.

## 3. MAJOR — no keyboard or gamepad path into the run-report scroller

**Fix:** `Menus.scrollRegion()` + `Menus.navScroll(dir)`, and one line in
`navigate()`: a vertical step is offered to the scroller first and falls
through to `navMove` when the scroller is at that end of its travel or does
not overflow. Horizontal always moves the ring, which costs nothing because
the summary's two buttons are a row. Step is 60% of the visible height, floor
64 px — a stick repeats at 140 ms and the keyboard does not repeat at all, so
a line-sized step would make a long report a chore.

**Why this shape rather than a synthetic `[data-nav]` inside the report.**
Focusing a container does not scroll *inside* it — `paintFocus` calls
`scrollIntoView({block:'nearest'})`, which would scroll the container into
view in its parent and leave its own content exactly where it was. A focusable
proxy would also put a visible focus ring on a non-interactive region. The
fallback the critic listed second is the one that actually moves the pixels.

**Arms tested — all three input paths, seven viewports.** `probe.json` →
`scroll`. Six `navMove(1)`/`navigate()` steps per arm on a maximal report
(8 unlocks, 15 completed, 3 advanced, 4 records, 3 discovery lines — the same
worst case round 2 built), measured as `.run-report.scrollTop` before/after:

| viewport | scrollable | `navMove` only | keyboard ↓ | keyboard S | keyboard ↑ | gamepad ↓ |
|---|---|---|---|---|---|---|
| 1600×900 | yes | 0→0 | 0→145 | 0→145 | 145→0 | 0→145 |
| 1280×720 | yes | 0→0 | 0→179 | 0→179 | 179→0 | 0→179 |
| 1024×600 | yes | 0→0 | moved | moved | moved | moved |
| 2560×1080 ultrawide | yes | 0→0 | moved | moved | moved | moved |
| 900×1600 portrait | **no** | 0→0 | 0→0 | 0→0 | 0→0 | 0→0 |
| 800×500 short | yes | 0→0 | moved | moved | moved | moved |
| 1366×768 | yes | 0→0 | moved | moved | moved | moved |

Round 2's measurement was `scrollMovedByNav: false` at all six of its
viewports. Every viewport that overflows now scrolls under keyboard **and**
under gamepad; the portrait frame, which does not overflow, moves nothing —
which is the point of the fall-through.

The three arms that must **not** regress, at every one of the seven viewports:

- `horizontalMovesRing` — `navIndex 0→1` everywhere, so Logbook/Restart are
  reachable at any scroll position.
- `downAtBottomMovesRing` — at the bottom of the travel, down moves the ring
  (`1→0`), so nothing is ever trapped behind the scroller.
- `buttonsFullyVisible` — both buttons fully inside the viewport at all seven
  sizes, and `deathMarkTopClipped: false` at all seven. Round 2's "checked and
  clean" mouse/touch result is intact, and holds at a seventh size it did not
  test. `directScrollWorks` (a plain `scrollTop` write, what a wheel or a
  touch drag does) is `true` wherever the report overflows.

The seventh viewport (1366×768) was added deliberately: round 2 tested six and
round 1 tested one, and the round's lesson is about untested arms.

`navMove` on its own still does not scroll, by design — it is the ring walker
and has no axis information. A future probe that calls `navMove(1)` directly,
as round 2's did, will still measure zero; the input path a player actually
has is `navigate()`, and that is what was fixed and what was measured. Called
out here so it is not mistaken for the same defect surviving.

## 4. MAJOR — survey challenges counted finale "special" monsters in the numerator only

**Fix:** one definition of "content", applied to both halves, and it is the
catalogue's. `UnlockRegistry` now records the *membership* of each catalogue
alongside its size and exports `catalogueHas(kind, id)`; `Profile._onKill` and
`Profile._onBossDead` route monster sightings through a new
`Profile._discoverMonster`, which drops ids no catalogue holds.

**Why filter the numerator rather than grow the denominator.** Growing it
would make "Record every monster in the bestiary" require killing the Anchor,
the Vault Warden and the Herald — i.e. a full clear — which is not what the
challenge says and would make a discovery challenge a completion challenge.
The catalogues are also exactly what the logbook lists
(`Logbook.js:450,455`), so anything excluded here was never displayable as a
bestiary entry in the first place. Filtering also leaves the shipped goals at
the counts they already have (19 and 6). `catalogueHas` answers `true` for a
kind with no catalogue at all, so a future encounter kind cannot be silently
dropped by a recorder.

**Before** (`round2-meta.md` §4): one `anchor` kill and one `herald` kill moved
`distinct {enemy 1→2, boss 0→1}` while `catalogue {enemy 19, boss 6}` stood
still — `apexSurvey` could read 6/6 with one of the six real bosses never
fought.

**After** (`probe.json` → `survey`):

- Three specials killed (`anchor`, `warden_vault`, `herald`) via **both**
  paths — a `kill` event each and a `bossDead` event each:
  `distinct` before `{enemy 0, boss 0}` → after `{enemy 0, boss 0}`.
  `specialsRecorded: []`.
- Then every real card driven through the path it actually arrives on — all
  19 `SPAWN_CARDS` as `kill`, all 6 `BOSS_CARDS` as `bossDead`:
  `distinct {enemy 19, boss 6}`, `catalogue {enemy 19, boss 6}`,
  `missing {enemy: [], boss: []}`. `fieldGuide 19/19 done`,
  `apexSurvey 6/6 done` — and now only when all 19 and all 6 were genuinely
  met.
- `specialsInSpawnCards: []`, `specialsInBossCards: []` re-confirms the
  partition the fix leans on. `SPAWN_CARDS` (19) ∪ `BOSS_CARDS` (6) is every
  non-special monster, and the director only ever flags a `BOSS_CARDS` pick as
  `isBoss` (`Director.pickBossCard` draws from `BOSS_CARDS` only), so no
  legitimate id can be dropped by arriving under the wrong `kind`.

## 5. MINOR — `registerUnlockBinding` did not guard the reverse collision

**Fix:** `src/data/challenges.js` keeps a `REWARD_OWNER` map of
`${type}:${id}` → challenge id, seeded from any hand-written `UNLOCK_BINDINGS`,
and rejects a second *different* challenge claiming a reward already owned,
with the same warn-and-refuse posture as every other malformed case. Checked
after the existing forward guard, so re-registering the identical pair is
still a silent no-op rather than a warning.

**Before** (`round2-meta.md` §5): both bindings took, silently.

**After** (`probe.json` → `bindings`, `consoleWarnings`):

```
firstClaim: true,  secondChallengeSameReward: false
bindingsAfter: { firstBlood: {item, r3-shared-id} }   // warmingUp absent
warn: [challenges] item:r3-shared-id is claimed by both "firstBlood" and
       "warmingUp" — the second to complete would grant nothing
```

The neighbouring guards, re-run in the same pass so this change did not
weaken them: `idempotentRebind: false` (identical pair, no warning),
`twoRewardsOneChallenge: false` + its warning, `malformedType: false`,
`emptyId: false`, `unknownChallenge: false` + its warning,
`freshPairStillBinds: true`. Console errors: none.

## 6. MINOR — "finish a run" meant two things four lines apart

**Fix:** `wholeRoster`'s description is now *"Play a run with every
survivor."* `finisher` keeps "Finish a run at the Fracture instead of dying in
it," so "finish" now means "win" consistently, and the challenge tracked by
`survivorsPlayed` says "play". A comment on the card records the trap so the
next author does not walk back into it. `veteran`/`centurion` were left as
"Finish 25 runs" — they are career counters in the same family as
`survivorsPlayed` and share the looser sense, and rewording four cards to fix
two was not obviously an improvement. Flagging it rather than hiding it.

**After** (`probe.json` → `bindings`): `wholeRosterDesc: "Play a run with
every survivor."`, `finisherDesc: "Finish a run at the Fracture instead of
dying in it."`, `veteranDesc: "Finish 25 runs."`

## 7. MINOR — `renderRunReport`'s `''` / `:empty` contract was unreachable

**Fix:** dropped the claim, kept the branch. `renderRunReport(null)` genuinely
returns `''` — a death screen raised without a committed run, which the
harness and a mid-load quit both produce — and the `:empty` rule
(`hud.css:2590`) still collapses the container there. The doc comment in
`src/ui/Logbook.js` now says that, and says explicitly why the "run that
changed nothing" state is unreachable (the unconditional career line, plus
`veteran`/`centurion`/`clockedIn` ticking on every run) and why that is the
better behaviour. No code path was removed: the `!report` guard is live and
load-bearing.

Chose *not* to make the empty state reachable by excluding the three
lifetime-only challenges from `advanced` and suppressing the career line: that
would trade a correct, informative footer on a bad run for a bare "You Died",
which is worse UX and a behaviour change nobody asked for. The defect was the
comment, and the comment is what changed.

---

## Re-verified: the things round 2 called clean

`probe-regression.json`, run against the changed `Profile`/`challenges`/
`UnlockRegistry`. Every one still holds:

- **v1 → v2 migration**: `version 2`, `gold 42`, `discovered` dropped for
  `encounters` with first-seen stamps carried verbatim and `count: 0`
  (`grunt {at:111, count:0}`, `ember {at:333, count:0}`), per-survivor career
  rebuilt from run history (`ranger {runs:1, wins:1, kills:50, bestStage:6}`,
  `anvil {runs:1, deaths:1, kills:20, bestStage:3}`), completed challenge and
  its `doneAt: 7` preserved, unlock timestamp `9` preserved.
- **Hostile/corrupt payloads fail closed**: truncated JSON, an array, a bare
  string, `null`, an all-wrong-types payload, and a JSON-literal `__proto__`
  key all load without throwing into a type-correct profile
  (`runsType: "number"`, `runsIsArray: true`, `unlocksIsObj: true`), and
  `({}).pwned` is still `undefined` in every case.
- **Future version downgrades safely**: a v99 payload loads, stamped down to
  `version 2`, `runs: 3` preserved, no throw.
- **Unlock idempotency**: `[true, false]`, one timestamp written.
- **`massacre`'s sliding window**: 25 back-to-back kills →
  `{progress: 25, done: true, killTimesLen: 25, bestKillBurst: 25}`.
- **38 challenges, no duplicate ids**: `challengeCount: 38`, `dupIds: 0`, and
  `registry {generated: 5, bound: 7}` with sizes
  `{survivor 5, item 108, equipment 14, enemy 19, boss 6}` — unchanged by the
  membership tracking added for finding 4.
- Console errors across both probes: **none**.

## Build and capture

- `node node_modules/vite/bin/vite.js build` — clean, `✓ built in 2.28s`, only
  the pre-existing chunk-size advisory. (An intermediate edit broke the build
  by putting backticks inside the death-screen HTML template literal; caught by
  the probe, fixed, rebuilt.)
- 21-shot capture into `reviews/round7/r3-meta/capture/` (own `--out`, own
  `--port 5251`; `shots/` untouched). `capture/manifest.json`:
  `ready: true`, `clockPinned: true`, `partial: false`, 21/21 shots written,
  `audioOk: true` (`state: "running"`, `stepsEmitted: 422`).
  **`errors` has exactly one entry and `subjectFailures` exactly one shot** —
  `06-loaded-hud` / "monsters under load", `badObjects: [{i: 6, px: 145,
  sepP50: 0.17}]` against `needSep: 0.25`. That is object index 6 failing on
  *separation*, not size — the identical shape `E-framing.md` §5 records
  (`object 6`, `sepP50: 0.17` vs `0.25`) and declines to fix. No other console
  error and no page error in the run. This change did not make it worse and
  did not add a new one.
- `16-run-summary` — the one shot that exercises the touched surface — is in
  the 21 and carries no failing check.

## Arms I did **not** test

Named deliberately, per the round's lesson:

- **A real gamepad.** The pad arm was driven by replacing `Menus.readPad` with
  a stub returning `{dy: 1}` — the single surface through which every pad
  input reaches `navigate`. Its own axis/deadzone/repeat logic
  (`Menus.js:1526-1570`) is unchanged by this work and was not exercised
  against a physical or virtual `navigator.getGamepads()` device.
- **A real hidden tab.** The visibility arm dispatches a `visibilitychange`
  at `document` with `visibilityState` forced to `'hidden'` — the shape a
  browser produces — and separately a real navigation-away. An OS-level mobile
  tab reclaim (the scenario the listener exists for) cannot be produced here.
- **Held-key repeat.** `Input.hit` is edge-triggered, so scrolling costs one
  press per page. Whether that *feels* right on a long report is a judgement I
  could not make headless; the pad's 140 ms repeat makes the stick smooth, the
  keyboard needs discrete presses.
- **Touch.** No touch arm was simulated. The report scroller's touch path is
  native `overflow-y: auto` and is untouched by this change;
  `directScrollWorks` covers the same mechanism programmatically.
- **Co-op / second client.** `Profile._isLocalSource` was not exercised
  against a live second client — same limitation round 2 recorded. The
  discovery filter added in finding 4 sits *before* the witness filter in
  `_onKill`, exactly where the old `discover` call sat, so the co-op semantics
  ("a client that watched a Titan die has seen a Titan") are unchanged.
- **A run played end-to-end by hand.** All run-lifecycle evidence is
  harness-driven. `16-run-summary` in the capture is the one shot that plays a
  compressed real run.
- **The other three fixers' files.** `Combat.js`, `Player.js`, `Items.js`,
  `Audio.js`, `Music.js`, `Coop.js` and the content data files were changing
  underneath these runs; the capture below reflects the whole tree, not my
  changes alone.

## Files I did not need to touch

- **`src/ui/hud.css`** — the scroller's CSS (`.screen--death .run-report`,
  `hud.css:1470-1475`) was already correct; the defect was that no input path
  reached it. A scroll affordance (a bottom fade hinting at more content)
  would be a real polish improvement but is a new feature, not a fix for a
  reported defect, so it is not in this change.
- **`src/core/Harness.js`** — the dispatch suggested populating `run.time`
  here "at the source". The source is `ctx.time`, which `Profile` can read
  directly; putting the write in the *test harness* would fix the probe and
  not the game. No harness change was needed to reproduce or verify any of the
  seven findings.

## Nothing deferred

All seven findings are fixed. Nothing was found that needed a file outside my
ownership.
