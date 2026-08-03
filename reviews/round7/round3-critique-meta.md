# Round 7 — round 3 critique: meta progression (Profile, UnlockRegistry, challenges, run-summary UI)

Reviewer: independent round-3 critic, fresh eyes, not involved in building or
fixing this work. Bar: shipped AAA quality (RoR2-tier). Default answer is
FAIL; every defect below is reproduced live or explicitly marked otherwise.

Scope: `src/systems/Profile.js`, `src/systems/UnlockRegistry.js`,
`src/data/challenges.js`, `src/ui/Logbook.js`, `src/ui/Menus.js`,
`src/ui/hud.css`, `src/core/Harness.js`. Branch `round7/content-and-polish`,
HEAD `b18a2b4`. Round 2's critique is `reviews/round7/round2-meta.md` (2
critical, 2 major, 3 minor, all reproduced live). Round 3's fix report is
`reviews/round7/round3-fix-meta.md`, claiming 7/7 fixed. Both were treated as
claims to re-derive, not facts — per the standing lesson on this project that
the instruments fail about as often as the code they measure.

---

## Methodology

Read every file in scope via `codegraph_explore` against the current on-disk
source (not round 3's diff, not either report's quoted snippets), cross-checked
call sites (`Engine._frame`, `Progression.fixedUpdate`, `Menus.navigate`) to
confirm the mechanisms round 3 describes actually exist where it says they do.

Everything checkable live was checked live, against a real Vite dev server and
headed Chromium (`--use-angle=d3d11 --ignore-gpu-blocklist
--enable-gpu-rasterization --force_high_performance_gpu`, off-screen —
`tools/capture.mjs`'s own non-software launch config; headless SwiftShader was
not attempted given round 3's own note that it never reached a live stage
inside a 300 s budget on this machine), driven through
`globalThis.__GAME__.ctx` / `globalThis.__HARNESS__`, the sanctioned harness
surface. Six throwaway Playwright probes were written into
`tools/_r4meta_probe{1..6}.mjs` (numbered 1–6 by content; the actual filenames
were `_r4meta_probe.mjs`, `_probe2.mjs` … `_probe6.mjs`), run, and **deleted
before finishing this review** (confirmed absent from `tools/` at time of
writing). Every number below is quoted from the raw JSON each probe wrote to
this review's own capture directory, `reviews/round7/r4-meta/probe{,2,3,4,5,6}.json`
— never from memory or from either prior report's tables. No screenshots were
attempted this round (round 2 already established `page.screenshot()` times
out under this machine's software path; this round's evidence is DOM/state
assertions, which are unaffected by that).

One methodology correction made mid-review and left in this report as a
warning to the next critic: my first pass at re-testing the blitz/marathon
discriminating pair reused a single profile across sub-cases and got a false
positive (`blitz` reading `done: true` in a case it should have failed) —
because challenges are lifetime-persistent state (`if (st?.done) continue`)
and my second sub-case inherited the first sub-case's completion. Fixed by
calling `ctx.profile.reset()` between sub-cases, matching what round 3's own
"fresh profile" framing implies it did. Flagging this because it is exactly
the shape of instrument failure this project's standing lesson warns about,
and it very nearly went into this report as a regression.

**Not independently tested this round, and not claimed as evidence**: a real
OS-level mobile tab reclaim (no browser API triggers this on demand); a
physical or OS-registered virtual gamepad (Chromium/Playwright has no API to
inject one — see finding-by-finding table below for how far the gamepad arm
*was* pushed instead); a live second co-op client; touch input; a
hand-played end-to-end run. All four are the same arms round 2 and round 3
both left untested; nothing in this environment closes that gap for good.

---

## Verification table — round 3's seven claims

| # | Round 3's claim | This round's number | Verdict |
|---|---|---|---|
| 1 | `run.time` now live via `_syncRunClock`; blitz done at 8 min, refused at 14 min; marathon reaches 1800/1800 | Reproduced independently: `stage5at8min` → `runTime 480, blitz done:true`; `stage5at14min` → `runTime 840, blitz done:false`; boundary case `stage5atExactly10min` (not in round 3's table) → `runTime 600, blitz done:true` (`<=` is correctly inclusive); `marathonAt31min` → `runTime 1860, marathon 1800/1800 done:true`; `marathonAt2959` (29:59) → `1799/1800, done:false`. `probe.json` | **CONFIRMED** |
| 2a | `visibilitychange` moved to `document.addEventListener`; fires on the real target | Independently dispatched `visibilitychange` at `document` after 5 kills sat mid-debounce (`midDebounceStorage: 0`) → `afterHiddenDispatch: 5`. `probe2.json` → `visibilityFlush` | **CONFIRMED** |
| 2b | Abrupt quit end-to-end (their number: 11 kills survive a hide-then-navigate-away) | Not re-run as their exact sequence; the underlying mechanism (2a) was independently reproduced, which is what their sequence depends on. A *different*, harder sequence — hard-kill with no hide event at all — was also run; see Finding 1 below (a residual gap outside their claim's scope, not a refutation of it) | **CONFIRMED** (mechanism); see Finding 1 for a related gap they did not claim to cover |
| 3 | Keyboard and (their words) "gamepad" scroll the run-report via `navScroll`/`scrollRegion`, falling through to `navMove` at either end | Keyboard: independently reproduced via `ctx.input.pressed.add('ArrowDown')` (the real edge-triggered path, not calling `navScroll` directly) → `scrollTop 0→71` on a maximal report at 1600×900. Gamepad: round 3 admits their own test replaced `Menus.readPad` with a stub `{dy:1}` — bypassing axis math, the 0.55 deadzone, and the 380/140 ms repeat gate entirely. This round instead mocked `navigator.getGamepads()` with a Standard-Gamepad-shaped fake object and let the **real, unmodified `readPad()`** run: a held left-stick past the deadzone (`axes=[0,1.0]`) scrolled `0→71` (1600×900) and `0→224` (1024×600) through the genuine repeat timer, correctly did *not* move anything at the non-overflowing 900×1600 portrait frame, and an isolated D-pad-down button press (`buttons[13]`, the other half of `readPad`'s input surface) also independently scrolled `0→71`. `probe4.json`, `probe5.json` | **CONFIRMED**, and materially strengthened past round 3's own admitted gap (still not a physical device — see Methodology) |
| 4 | Survey challenges (`fieldGuide`, `apexSurvey`) no longer count `special` monsters; catalogue-filtered via `catalogueHas` | Independently reproduced with real event shapes on real ids: killing `anchor`/`warden_vault`/`herald` via both `kill` and `bossDead` moved `distinct.enemy`/`distinct.boss` by **zero** (`afterSpecialsDistinct: {enemy:0, boss:0}`); killing all 19 real `SPAWN_CARDS` ids and all 6 real `BOSS_CARDS` ids then produced `fieldGuide 19/19 done`, `apexSurvey 6/6 done` — only once every real card was actually met. `probe4.json` → `survey` | **CONFIRMED** |
| 5 | `registerUnlockBinding` now rejects a second challenge claiming an already-owned reward | Code-verified against current source (`challenges.js:537-599`: `REWARD_OWNER` map, `owner !== undefined && owner !== challengeId` guard, warn-and-refuse). Not independently re-executed live this round (time budget went to the higher-yield arms above) | **CONFIRMED** (code-verified only) |
| 6 | `wholeRoster`'s description changed to "Play a run with every survivor" | Verbatim current source, `challenges.js:423`: `description: 'Play a run with every survivor.'` | **CONFIRMED** |
| 7 | `renderRunReport`'s `''`/`:empty` doc comment corrected rather than the behaviour changed | Verbatim current source, `Logbook.js:943-956` (comment) and `:958` (`if (!report) return '';` guard intact) | **CONFIRMED** |

All seven of round 3's specific, numbered claims independently verified true.
**None of them are why this build fails the bar below** — the two findings
that follow are fresh, on ground neither round 2 nor round 3 tested.

---

## Findings, most severe first

### 1. MAJOR — two tabs of the same game silently discard each other's saved progress; nothing in `Profile` detects or merges a concurrent write

**Where:** `src/systems/Profile.js` — the whole save layer (`flush()` at
:507-519, `_load()` at :325-355, `_touch()` at :493-497). There is no
`addEventListener('storage', …)` anywhere in `src/` (grepped the tree), no
version/ETag/timestamp check before a write, and no merge of any kind: each
`Profile` instance holds one in-memory `this.data` object, loaded once at
`init()`, and `flush()` unconditionally `JSON.stringify`s *that* object over
whatever is currently in `localStorage`, including another tab's newer write.

**What's wrong:** the browser gives every tab of the same origin the same
`localStorage`, and this game is a single page with no session lock, no
"already open elsewhere" warning, and no cross-tab reconciliation. Two tabs
of the game — opened deliberately (a player checking a build in a second
window), accidentally (a duplicated tab, a restored browser session that
reopens two copies of the same URL), or via any other completely ordinary
browser action — each hold their own independent snapshot from the moment
they loaded, and the one that flushes *last* wins in full, silently
overwriting whatever the other tab had already saved, no matter how much
newer or larger that data was.

**Reproduced live** (`tools/_r4meta_probe2.mjs`, deleted; raw data
`reviews/round7/r4-meta/probe2.json` → `twoTabRace`):

```json
"twoTabRace": {
  "bLoadedKills": 10,
  "storageAfterA2": 25,
  "storageAfterB": 13,
  "aTotalKillsLostIfClobbered": 12
}
```

Sequence: Tab A racks up 10 kills and flushes (`localStorage` now: 10). Tab B
opens and loads that snapshot (`bLoadedKills: 10`, confirmed). Tab A racks up
15 *more* kills and flushes again (`localStorage` now: 25, `storageAfterA2:
25`, confirmed — Tab A's own view is internally consistent). Tab B, still
holding its stale 10-kill snapshot from before Tab A's second write, racks up
3 kills of its own and flushes: `storageAfterB: 13`. **Tab A's real,
already-saved total of 25 kills is gone, replaced by Tab B's 13, with no
error, no warning, and no way for either tab to know it happened.** The same
mechanism applies to every field `Profile` persists — unlocks, challenge
completions, run history, gold — not just the kill counter used to make the
race legible in one number.

**Why this matters:** this is exactly the shape of defect the round's
dispatch asked to be hunted for ("interleaved writes from two tabs") and it
was not in round 2's or round 3's scope — round 2 explicitly did not test
multi-client persistence beyond a documented-but-unexercised co-op witness
filter, and round 3's changes to `Profile.js` this round (`_syncRunClock`,
`_discoverMonster`) never touched the write path, so this is not a regression
either round introduced — it is a pre-existing gap neither round's testing
ever reached. A player who earns a hard-won unlock or a challenge completion
in one tab and then, entirely by accident, has an old duplicate tab flush
over it loses that unlock permanently and is never told.

**Fix:** the minimal version is a `storage` event listener that re-reads
`localStorage` and merges (or at minimum warns / refuses to write if the
on-disk value has moved since this tab's last load) before flushing; a more
complete fix adds a monotonic write counter or `updatedAt` compare-and-swap
in `flush()` so a stale in-memory `this.data` cannot silently clobber a newer
on-disk one.

---

### 2. MAJOR — the "Closing in" progress readout shows raw seconds with no unit for time-scoped challenges, now that `run.time` is genuinely live

**Where:** `src/ui/Logbook.js:983-993` (`renderRunReport`'s "Closing in"
section, specifically line 990: `${fmtCount(a.to)} / ${fmtCount(a.goal)}`,
where `fmtCount` — `Logbook.js:1016-1020` — always renders a plain
`toLocaleString()` integer, never a duration); `Logbook.js:478` and `:781`
(the Logbook's own "challenges" tab list and detail panel, same raw
`${c.progress} / ${c.goal}` with no formatting). Root cause traced to
`src/systems/Profile.js:942-944`: `_buildReport`'s `advanced.push({ id, name,
from, to, goal })` carries no `format` field, unlike its sibling `records`
five lines later — `Profile.js:958-967`'s `best('bestTime', 'Longest run',
s.bestTime, 'time')` explicitly tags the personal-best "longest run" entry as
`format: 'time'`, and `Logbook.js:976-978` correctly consumes that tag
(`formatStat(r.value, r.format === 'time' ? 'clock' : r.format)`) to render
it as `mm:ss`. The convention already exists in this exact file, for this
exact unit, and was simply never extended to `advanced`.

**What's wrong:** `marathon` ("Survive for 30 minutes", goal `1800` seconds)
is the one non-binary, currently-progressing challenge whose unit is seconds
(`blitz` is binary and never appears mid-progress; `clockedIn`'s
36,000-second goal only appears once it has advanced far enough to place in
the capped top-3 "Closing in" list, and shows the identical defect whenever
it does). Before round 3's fix this was **latent** — `run.time` was
permanently `0`, so `marathon` could never advance and never appeared in
`advanced` at all. Now that the clock is real (round 3's own headline fix),
a player partway through a long run will see this on the death screen and in
the Logbook.

**Reproduced live** (`tools/_r4meta_probe3.mjs`, deleted; raw data
`reviews/round7/r4-meta/probe3.json`): ran a fresh profile to `run.time =
1074` (17:54) and killed the player, letting `commitRun`/`_buildReport` build
a real report the ordinary way and rendering it through the real
`menus.showDeath()`:

```
"closingInRawSnippet": "1,074 / 1,800"
```

and, independently, the Logbook's own challenges tab, read from the live
rendered DOM:

```
"logbookRow": { "subText": "1074 / 1800" }
```

Neither panel says these are seconds, minutes, or a clock at all. A player
reading "1,074 / 1,800" has no way to tell this apart from a resource count,
and has to do "1800 − 1074 = 726, ÷60 ≈ 12 minutes left" in their head to get
the number the rest of the game already knows how to print (`Logbook.js:976`
does exactly this formatting one field over).

**Why this matters:** the dispatch asked, given a real clock, whether "the
'closing in' readout tell[s] the truth." It is not lying — the numbers are
correct — but on the one readout built specifically to answer "how close am
I", it is unreadable for the one challenge that most needs the reader to
understand its unit at a glance.

**Fix:** carry a `format` field through `advanced.push` the same way
`records.push` already does (`goalOf`/`def` already know a challenge's shape;
the simplest version is tagging `marathon`, and any future time-goal
challenge, with `format: 'time'` in its definition and threading that into
`_buildReport`), and have `renderRunReport`'s "Closing in" row and
`Logbook.collect()`'s challenge-list `sub` both call the same `clock()`
helper `Logbook.js:852` already exports when the format says to.

---

## Checked and clean

- **Blitz/marathon discriminating pair**, independently re-derived with a
  fresh profile per sub-case (see Methodology for the false-positive this
  caught in my own first pass): 8 min completes blitz, 14 min refuses it,
  exactly 10:00 still completes it (inclusive boundary, correct), marathon
  completes at 1800/1800 and not at 1799/1800. `probe.json`.
- **Pause correctly freezes `run.time`.** `Engine._frame` only advances
  `ctx.time` while `!ctx.paused` (`Engine.js:208-213`), confirmed live:
  30 frames paused at `run.time=60` produced `beforePause: 60,
  afterPauseFrames: 60` (zero drift across 60 further paused frames),
  `afterUnpause: 60.17` once unpaused. `probe.json` → `pausedClock`.
- **Hostile `ctx.time` cannot corrupt `run.time`.** `_syncRunClock`'s `num()`
  guard (`Profile.js:1248`) turns `NaN`/non-number into `0` before the
  monotonic compare, so a `NaN` or negative `ctx.time` (simulating a
  corrupted co-op sync) leaves `run.time` unchanged rather than going
  negative or `NaN`. `probe.json` → `hostileClock: {nanSync: 0, negSync: 0}`.
- **A normal restart cannot inherit a stale clock.** Both `act('restart')`
  and `act('quit')` from the pause screen call `location.reload()`
  (`Menus.js:1035,1039`) unconditionally for both win and loss, which resets
  `ctx.time` to `0` on the fresh page load — ruling out the otherwise-live
  hazard that `_syncRunClock`'s monotonic-max design would create if a
  second run's `beginRun()` (`run.time=0`) could ever run against a
  `ctx.time` left over from a previous run in the same page session. Verified
  by reading the only two call sites of `beginRun()` in the whole tree
  (`Profile.js:1021` inside `_onStageStart`, gated by `if (this.run) return`,
  and `RealmHarness.js`, dev-only) and confirming neither is reachable without
  either a fresh `stageStart` after a reload or an explicit test harness call.
- **Save layer's round-2 clean list, independently re-run against the
  round-3-changed `Profile.js`** rather than trusted from either prior
  report's numbers: v1→v2 migration (`version 2`, `encounters.enemy.grunt
  {at:111, count:0}` correctly carried over from the old `discovered` shape,
  challenge `doneAt` preserved); every hostile payload (truncated JSON, an
  array, a bare string, `null`, an all-wrong-typed object, a
  `__proto__`-literal payload, a future `version:99` payload) loaded without
  throwing into a type-correct profile with no prototype pollution
  (`({}).polluted` stayed `undefined` in every case); a forced
  `QuotaExceededError` on `localStorage.setItem` was swallowed by `flush()`
  without throwing, set `_storageBlocked`, and the engine kept running.
  `probe6.json`.
- **A write armed by `_touch()` and then abandoned by `profile.reset()`
  before its debounce fires is not a race.** `reset()` flushes synchronously
  and clears `_dirty`; the original, now-stale `setTimeout` still fires
  ~1.5 s later but is a no-op against the `if (!this._dirty) return;` guard,
  confirmed by reading `localStorage` before and after the original timer's
  deadline (`storageAfterReset: 0`, `storageAfterOldTimer: 0`, unchanged).
  `probe2.json` → `abandonedDebounce`.
- **`visibilitychange` correctly fires on `document`, confirmed independently**
  by dispatching it the way a real browser does (`document.dispatchEvent`,
  `visibilityState` forced to `'hidden'`) against 5 kills sitting mid-debounce
  — `localStorage` moved from `0` to `5` kills on the dispatch alone.
  `probe2.json` → `visibilityFlush`.
- **The gamepad scroll path holds under the real, unstubbed `readPad()`**,
  for both input shapes it accepts (analog stick past the 0.55 deadzone, and
  the D-pad-down button at index 13), at three viewports including a
  non-overflowing portrait frame that correctly moved nothing. See the
  verification table, claim 3.
- **Survey challenges (`fieldGuide`, `apexSurvey`) are catalogue-clean under
  real ids**, not just the two specific ids round 2 exercised: all three
  `special` monsters (`anchor`, `warden_vault`, `herald`) via both `kill` and
  `bossDead` moved nothing, and completion required every one of the 19 real
  `SPAWN_CARDS` and 6 real `BOSS_CARDS` ids. `probe4.json` → `survey`.
- **`registerUnlockBinding`'s reverse-collision guard, `wholeRoster`'s
  reworded description, and `renderRunReport`'s corrected doc comment** all
  match round 3's claims on direct reading of the current source (see
  verification table).

---

## Arms this round still could not close (named per the round's own lesson)

- **A physical or OS-registered virtual gamepad.** This round replaced round
  3's `readPad()` stub with a faithful `navigator.getGamepads()` mock and
  exercised the real deadzone/repeat/button logic end-to-end — a meaningfully
  smaller gap than round 3 left — but Chromium/Playwright still has no API to
  attach an actual hardware or OS-level virtual pad, so the very last hop (the
  browser's own HID→Gamepad-API translation) remains unverified in this
  environment.
- **A real OS-level mobile tab reclaim.** Still cannot be produced outside a
  real mobile OS. This round's `visibilitychange`-dispatch test reconfirms
  the *mechanism* fires correctly on the right target; it cannot confirm the
  OS actually calls it before reclaiming a tab.
- **Held-key repeat feel, touch input, a live co-op second client, a
  hand-played run.** Unchanged from round 2 and round 3 — no new capability
  in this environment closes any of these this round either.

---

## Verdict

**SPEC: CONFIRMED.** Every one of round 3's seven numbered claims holds up
under independent re-derivation, including the two hardest ones to fake
(the blitz/marathon boundary and the visibilitychange target fix), and the
gamepad claim was pushed further than round 3's own test reached.

**QUALITY: NOT READY**, against the AAA/RoR2-quality bar this round asked
for. Round 3's fixes are real and none of them regressed. But the round's own
brief said to attack the save layer harder than round 2 did and to hunt fresh
once `run.time` was live, and both of those produced a confirmed, live
defect: a two-tab session can silently and permanently discard already-saved
progress with zero indication to the player (Finding 1), and the exact
readout the dispatch asked about by name — "does the 'closing in' readout
tell the truth" — is unreadable for the one challenge whose unit is seconds,
which round 3's own fix is what makes reachable for the first time (Finding
2). Neither is exotic: the first requires nothing more than a second tab of
a normal browser, and the second requires nothing more than dying partway
through any run long enough for `marathon` to be the closest challenge. A
cert pass would bounce this build on either one.
