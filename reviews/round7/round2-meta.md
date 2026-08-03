# Round 7 — round 2 critique: meta progression (UnlockRegistry, Profile v2, challenges, run-summary UI)

Reviewer: independent round-2 critic, fresh eyes, no involvement in building this
work. Bar: would this ship in a AAA roguelike (RoR2 quality). Default answer is
FAIL; every defect below is either reproduced live or explicitly marked as
reasoned-only.

Scope: `src/systems/UnlockRegistry.js`, `src/systems/Profile.js`,
`src/data/challenges.js`, `src/ui/Logbook.js`, `src/ui/Menus.js`,
`src/ui/hud.css`. Branch `round7/content-and-polish`, HEAD `75f87d6`.
Round 1's report is `reviews/round7/F-critique-content.md`; the author's
writeup is `reviews/round7/C-meta.md`. Both were treated as claims to verify,
not facts.

---

## Methodology

Static reading of every file in scope, cross-referenced with `codegraph`-style
grep for call sites (no `.codegraph/` index present in this repo, so plain
`Grep`/`Read` were used instead). Where a claim was checkable live, it was
checked live: the game was booted headless (`--use-gl=angle
--use-angle=swiftshader --enable-unsafe-swiftshader --enable-webgl`, matching
`tools/capture.mjs`'s software-rendering flags) via `?harness=1&pinclock=1`,
and driven directly through `globalThis.__GAME__.ctx` /
`globalThis.__HARNESS__`, exactly the sanctioned harness surface (the
project's own `Harness.js:5083` constructs synthetic `kill` events the same
way this review's probes do). Six throwaway Playwright scripts were written
into `tools/_r2meta_probe{1..6}.mjs`, run, and **deleted before finishing this
review** (confirmed absent from `tools/` at time of writing). Evidence that
isn't a screenshot (bounding-box measurements, JSON dumps of profile/report
state) was written to this review's own capture directory,
`reviews/round7/r2-meta/viewport-report.json`.

Two things were attempted and came back **inconclusive** — not cited as
evidence either way:

- **Screenshots of the run-summary panel** at the six test viewports
  (`reviews/round7/r2-meta/`). `page.screenshot()` timed out (10s) at every
  viewport under headless SwiftShader, the same slow-software-rasteriser
  effect `capture.mjs`'s own comments describe (`tools/capture.mjs:32-34`).
  The DOM bounding-box measurements taken immediately before each failed
  screenshot are not affected by this — they come from
  `getBoundingClientRect()`, not from the renderer — so the layout findings
  below are evidence-backed, just not visually illustrated.
- **Live co-op witness filtering.** `Profile._isLocalSource` and the
  `equipmentChanged` listener were read carefully and match their doc
  comments (single-client-only credit, no witness filter on this client's own
  slot changes), but no multiplayer harness was exercised — there is no
  second-client capture rig in this repo reachable in the time available.
  Marked PLAUSIBLE, not CONFIRMED.

---

## Findings, most severe first

### 1. CRITICAL — `run.time` is never populated on the live run object: `marathon` cannot ever complete, `blitz` completes with zero regard for time

**Where:** `src/systems/Profile.js:759-799` (`beginRun`, initialises
`this.run.time = 0` and never assigns to it again anywhere in the class or
anywhere else in the codebase); `src/data/challenges.js:179-188` (`marathon`,
`track: (p, r) => Math.min(30 * MINUTE, r?.time ?? 0)`);
`src/data/challenges.js:189-202` (`blitz`, `track: (p, r) =>
((r?.maxStageIndex ?? 0) >= 4 && (r?.time ?? 0) <= 10 * MINUTE ? 1 : 0)`).

**What's wrong:** every `track` function for a "run-scoped" challenge is
called with `this.run` (the live run object) as its second argument — see
`_evaluate(runStats, force)` calls at `Profile.js:1004`, `:1033`, `:1058`,
`:1070`, `:1081`, `:1092`, `:1101`, `:1117`, `:871`. `this.run.time` is set to
`0` once, in `beginRun` (`Profile.js:769`), and is **never written again**.
`Progression.js:177` does update its own `this.stats.time = ctx.time` every
frame, and that value is correctly threaded into the *persisted run record*
(`Profile.js:817`, `time: num(stats.time, run.time)`) — but nothing ever
copies it back into `this.run.time`, the field every `track` function reads
as `r.time`. Grepped the entire `src/` tree for any assignment to
`run.time`/`this.run.time` outside the one initialisation; there is none.

**Reproduced live** (`tools/_r2meta_probe.mjs`, deleted): booted the harness,
called `ctx.profile.beginRun()`, fired five `kill` events and one
`stageStart` event to index 4 (stage 5) with **zero real elapsed time**, then
called `profile._evaluate(profile.run, true)`:

```json
"timeBug": {
  "runTimeAtStart": 0,
  "runTimeAfterEvents": 0,
  "blitz":    { "progress": 1,  "goal": 1,    "done": true  },
  "marathon": { "progress": 0,  "goal": 1800, "done": false }
}
```

`blitz` ("Ahead of the Curve — reach stage 5 within 10 minutes") completed
**instantly**, having spent no real time at all — because `r.time` is always
`0`, the `<= 10*MINUTE` half of its condition is unconditionally true, and
the challenge collapses to "reach stage 5," identical to `theLongHaul` but
strips the entire point of the challenge (arriving early against the
difficulty clock, per the challenge's own doc comment at
`challenges.js:190-195`). `marathon` ("Survive for 30 minutes") stayed at
progress `0` — and by the same evidence (nothing anywhere ever writes
`run.time`), it **can never advance**, on any run, of any length. This is not
a slow-to-trigger challenge; it is dead. A player chasing the 38-challenge
list will find one that the game itself cannot ever award.

**Fix:** either add a periodic timer in `Profile` that copies `ctx.time` (or
tracks its own elapsed-since-`beginRun` clock) into `this.run.time`, or have
`Progression` push its own `stats.time` into `ctx.profile.run.time` on the
same per-frame update that already maintains `this.stats.time`
(`Progression.js:177`). Either fix is a few lines; the bug is that nothing
does either.

---

### 2. CRITICAL — the "flush on hidden tab" safety net is dead code: it listens on the wrong `EventTarget`

**Where:** `src/systems/Profile.js:294-299`:

```js
if (typeof addEventListener === 'function') {
  this._onHide = () => this.flush();
  addEventListener('pagehide', this._onHide);
  addEventListener('visibilitychange', () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.flush();
  });
}
```

**What's wrong:** the bare, unqualified `addEventListener` call at module
scope resolves to `window.addEventListener` (browsers make `window` the
global object; a bare identifier at top level in non-strict-adjacent module
code resolves through it). The browser's native `visibilitychange` event,
however, **fires on `document`**, not on `window`, and does not propagate to
`window` — this is a well-known platform gotcha, not a project-specific
oddity. The result: this listener is registered on a target that the real
event never reaches. It has never fired in a real browser session.

**Reproduced live** (`tools/_r2meta_probe2.mjs`, deleted): registered a probe
listener on `window` and one on `document`, then dispatched
`visibilitychange` the way the browser actually does — targeted at
`document`:

```json
"isolated": { "sawOnWindow": false, "sawOnDocument": true, "addEventListenerIsWindow": true },
"realFlush":         { "wroteViaDocumentDispatch": false },
"realFlushViaWindow": { "wroteViaWindowDispatch": true },
"pagehideWorks":      { "wrote": true }
```

Dispatching the event the way a real browser does (`document.dispatchEvent`)
never triggers `Profile`'s flush; dispatching it the way no real browser does
(`window.dispatchEvent`) does. `pagehide` — correctly registered on `window`,
which is where that event actually fires — works.

**Why this matters:** the code's own comment
(`Profile.js:290-293`) states the exact intent this defeats: *"pagehide and a
hidden visibilitychange are the two that actually fire on mobile and on a
killed tab."* With the `visibilitychange` half dead, the only real protection
left is `pagehide`, which does not reliably fire for the scenario
`visibilitychange` exists to cover — a backgrounded mobile tab that gets
suspended or reclaimed by the OS without a navigation event. In that
scenario, up to `WRITE_DEBOUNCE_MS` (1500 ms) of progress — a kill count, a
challenge completion, a boss discovery — silently never reaches
`localStorage`, exactly the failure mode this listener was written to close.

**Fix:** `document.addEventListener('visibilitychange', ...)`, not the bare
(window-scoped) call. One-word fix, but it is currently entirely inert.

---

### 3. MAJOR — keyboard/gamepad cannot scroll the run-summary report; only a mouse or touch can read content that overflows it

**Where:** `src/ui/Menus.js:1379-1396` (`navTargets`, `paintFocus`,
`navMove`) and `src/ui/Menus.js:375-402` (death-screen markup: the two
`[data-nav]` buttons, `logbook` and `restart`, are the only focusable
elements on the whole screen, and both sit **outside** `.run-report`);
`src/ui/hud.css:1470-1475` (`.screen--death .run-report { overflow-y: auto;
}`).

**What's wrong:** the game's entire keyboard/gamepad navigator is built
around `[data-nav]` elements: `navMove` walks that list, and `paintFocus`
calls `scrollIntoView({ block: 'nearest' })` on whichever one currently has
focus — that is the *only* mechanism in the codebase that ever scrolls a
container into view for a non-mouse user. The run-summary's scrollable
report region (`.run-report` — the exact element `75f87d6` added to fix
round 1's "buttons pushed off-frame" finding) contains **zero** `[data-nav]`
elements: it is chips, progress bars and stat rows, all plain markup. Since
there is nothing inside it for the navigator to focus, `scrollIntoView` never
fires for it, and the game has no other input path (no `PageDown`, no analog
stick-to-scroll, no wheel emulation) that reaches a non-focusable scroll
container.

**Reproduced live** (`tools/_r2meta_probe3.mjs`, deleted): ran the harness's
own `runSummary()` scenario, then replaced `ctx.profile.lastReport` with a
maximal report (8 unlocks, 15 completed challenges, 3 advanced, 4 records, 3
discovery lines — `_buildReport`'s own caps at their limits, plus the
uncapped `unlocks`/`completed` arrays stuffed past what any real run
produces) and re-rendered it through the real `renderRunReport`, at six
viewports/aspect ratios (1600×900, 1280×720, 1024×600, 2560×1080 ultrawide,
900×1600 portrait, 800×500 short). Then simulated exactly what a controller
does — six calls to `menus.navMove(1)`, the same function `navigate()` calls
on `ArrowDown`/D-pad-down — and read `.run-report`'s `scrollTop` before and
after:

```
1600x900:            reportIsScrollable: true,  navTargetCount: 2, scrollMovedByNav: false
1280x720:             reportIsScrollable: true,  navTargetCount: 2, scrollMovedByNav: false
1024x600:              reportIsScrollable: true,  navTargetCount: 2, scrollMovedByNav: false
2560x1080-ultrawide:   reportIsScrollable: true,  navTargetCount: 2, scrollMovedByNav: false
900x1600-portrait:     reportIsScrollable: false, navTargetCount: 2, scrollMovedByNav: false
800x500-short:         reportIsScrollable: true,  navTargetCount: 2, scrollMovedByNav: false
```

(Full data: `reviews/round7/r2-meta/viewport-report.json`.) At every
viewport where the report actually overflows (five of six — only the tall
900×1600 portrait frame happened to have enough headroom), six simulated
keyboard/gamepad "down" presses moved the scroll position **zero pixels**.
`reportHasAnyDataNav` was `0` at every viewport, confirming why: there is
nothing in that region the navigator can ever land on.

**Why this matters:** this is precisely the surface the dispatch asked to be
re-verified ("the scroller is actually reachable by keyboard/gamepad as well
as mouse") and precisely the surface `75f87d6` was written to fix. The fix
holds for a mouse or a touchscreen. It does not hold for a controller, and
this project explicitly supports one (`Menus.js:1415-1442`, "the menus were
mouse-only… Arrows / WASD / D-pad move the ring"). A controller-only player
on a big run — the exact run that makes the report worth reading — cannot
read the "Closing in" bars, the beaten records, the earned-chip row, or the
item grid whenever any of it overflows the panel. This is a genre where
console/controller play is a first-class audience, not an edge case.

**Fix:** either add a synthetic, always-present `[data-nav]` "scroll" target
inside `.run-report` when its content overflows (so `navMove` can reach it
and `scrollIntoView` does the rest), or give `navigate()` a fallback: when
the currently open screen has a scrollable region and no in-region nav
targets exist, translate `dy` directly into `reportEl.scrollTop +=` while
focus sits on the death screen.

---

### 4. MAJOR — survey challenges (`fieldGuide`, `apexSurvey`) can complete without recording every catalogued monster/boss, because "special" (finale-only) monster kills inflate the discovery count without being counted in the catalogue size the goal is sized against

**Where:** `src/data/enemies.js:1000-1005` (`special: true` on `anchor`,
`warden_vault`, `herald` — "keeps these out of SPAWN_CARDS and out of the
boss bag"); `src/data/enemies.js:1169-1172` (`SPAWN_CARDS`/`BOSS_CARDS`
filter `!e.special`, which is also what `UnlockRegistry.js:66-76`'s
`CATALOGUES` sizes off); `src/systems/Profile.js:1008-1034` (`_onKill`,
records `discover(e.isBoss ? 'boss' : 'enemy', vid)` for **every** kill,
special or not); `src/systems/Profile.js:1084-1094` (`_onBossDead`, same for
bosses); `src/data/challenges.js:356-367` (`fieldGuide`, goal =
`catalogue('enemy')`, track = uncapped `distinct('enemy')`);
`src/data/challenges.js:368-377` (`apexSurvey`, same shape for `'boss'`).

**What's wrong:** `special` monsters are deliberately excluded from
`SPAWN_CARDS`/`BOSS_CARDS` — and therefore from the catalogue sizes the
survey goals are computed against — because they are "placed by name, never
bought" finale content, not part of the director's regular roll. That
exclusion is reasonable on its own. But `Combat._kill`
(`src/systems/Combat.js:492-501`) fires the `kill` event, and
`Director.fixedUpdate` fires `bossDead` (`src/systems/Director.js:279-281`),
identically for every enemy regardless of `special`, and `Profile`'s
handlers record whatever id the victim carries with no catalogue-membership
check. So a special monster's death still moves `distinct.enemy` /
`distinct.boss` — the numerator — while never contributing to
`catalogue.enemy` / `catalogue.boss` — the denominator the goal is
`Math.max(1, catalogue(...))`-derived from. The two counts, which are
supposed to move in lockstep for "record every X" to mean what it says,
diverge.

**Reproduced live** (`tools/_r2meta_probe.mjs`, deleted): read
`ctx.profile.facts()` before and after emitting one synthetic `anchor` kill
(`isBoss: false`, matching `anchor`'s real card — it has no `isBoss` field)
and one synthetic `herald` kill (`isBoss: true`, matching `herald`'s real
card):

```json
"catalogueMembership": { "spawnHasAnchor": false, "bossHasHerald": false, "spawnCount": 19, "bossCount": 6 },
"catalogueMismatch": {
  "catalogueBefore": { "enemy": 19, "boss": 6 },
  "catalogueAfter":  { "enemy": 19, "boss": 6 },
  "distinctBefore":  { "enemy": 1,  "boss": 0 },
  "distinctAfter":   { "enemy": 2,  "boss": 1 }
}
```

`distinct.enemy`/`distinct.boss` moved; `catalogue.enemy`/`catalogue.boss`
did not (confirmed independently against the live module: `SPAWN_CARDS` has
19 entries and does not include `anchor`; `BOSS_CARDS` has 6 and does not
include `herald`). `fieldGuide` and `apexSurvey`'s `track` functions read
`distinct(f, kind)` uncapped, so this excess carries straight into their
progress: a player who has recorded five of the six real `BOSS_CARDS` bosses
over a career, and has also reached and killed the Herald once (a normal
outcome of winning the game), will see `apexSurvey` show `6/6` — "Defeat
every kind of teleporter boss," done — while one of the six actual teleporter
bosses was never fought. The same shape applies to `fieldGuide` via `anchor`
and `warden_vault`.

**Fix:** either filter `discover('enemy'/'boss', id)` to ids present in
`SPAWN_CARDS`/`BOSS_CARDS` (skip specials, matching what the catalogue
already excludes), or fold specials into the catalogue count the goal is
sized against so numerator and denominator agree either way. The bug is the
asymmetry, not either exclusion policy on its own.

---

### 5. MINOR — `registerUnlockBinding` guards against one challenge naming two rewards, not against two challenges naming the same reward

**Where:** `src/data/challenges.js:540-567`.

**What's wrong:** the function's own doc comment
(`challenges.js:530-539`) frames its job as preventing exactly the failure
mode of "two content cards naming the same challenge… the first one silently
winning is how it stays invisible" — and it does guard that direction
(`prev = UNLOCK_BINDINGS[challengeId]`, keyed by challenge id). It does not
check the reverse: two *different* challenges each declaring the same
`{type, id}` reward. Nothing currently in `SURVIVORS`/`ITEMS`/`EQUIPMENT`/
`ARTIFACTS` triggers this (no duplicate ids exist in the current catalogues —
verified separately, see "Checked and clean" below), so this is not live
today, but it is unguarded.

**Reproduced live** (`tools/_r2meta_probe4.mjs`, deleted), by calling the
extension point directly the way a content card's discovery would:

```json
"sameRewardTwoChallenges": {
  "firstBloodBound": true, "warmingUpBound": true,
  "bindings": { "firstBlood": {"type":"item","id":"shared-id"}, "warmingUp": {"type":"item","id":"shared-id"} }
}
```

Both bindings succeed silently — no warning, unlike every other malformed
case the same file tests (unknown challenge id, duplicate binding on one
challenge, malformed type, malformed id all correctly warn-and-reject; the
throwing/NaN/negative/zero/string dynamic-goal cases all correctly fall back
to `1`; a malformed generated challenge is correctly refused — all
independently confirmed in the same run). `Profile.unlock`'s idempotency
guard (`Profile.js:543-559`, `if (this.data.unlocks[type][id]) return
false;`) means this never double-grants or corrupts state — but whichever of
the two challenges completes *second* silently produces no unlock and no
"earned this run" chip, even though it legitimately completed, because
there's nothing left to grant.

**Fix:** track claimed reward keys (`${type}:${id}`) alongside claimed
challenge ids in `registerUnlockBinding` and warn on collision the same way.

---

### 6. MINOR — "finish a run" means two different things four lines apart

**Where:** `src/data/challenges.js:203-212` (`finisher`: *"Finish a run at
the Fracture instead of dying in it,"* tracked by `p.wins` — "finish"
explicitly excludes death); `src/data/challenges.js:415-424` (`wholeRoster`:
*"Finish a run with every survivor,"* tracked by
`f.survivorsPlayed`); `src/systems/Profile.js:851-866` (`commitRun`
increments each survivor's `runs` counter, and therefore
`survivorsPlayed`, on **every** committed run — win or death, per the
unconditional `row.runs++` before the `if (won)` branch that only gates
`wins`/`deaths`).

**What's wrong:** `finisher`'s own description goes out of its way to
contrast "finish" against "dying" — establishing "finish" as meaning "win"
in this file's vocabulary. Four challenges later, `wholeRoster` reuses
"finish a run" to mean "complete a run session, any outcome," which is also
what `veteran`/`centurion` mean by the same phrase. A player reading
`wholeRoster` right after `finisher` (they're both visible in the same
Logbook list) has a reasonable basis to think they need to *win* with every
survivor, when dying on stage 1 with a survivor who has never been played
before is enough.

**Fix:** reword `wholeRoster`'s description to "Play a run with every
survivor" or similar, distinct from `finisher`'s "finish."

---

### 7. MINOR — the "returns `''` when nothing changed" contract on `renderRunReport` is true in principle and essentially unreachable in practice

**Where:** `src/ui/Logbook.js:943-945` (doc comment: *"Returns `''` when a
run genuinely changed nothing, so the container's `:empty` rule collapses
it"*); `src/ui/Logbook.js:987-993` (the always-present career line);
`src/data/challenges.js:427-436` (`veteran`, `centurion`), `:447-456`
(`clockedIn`) — all three track raw lifetime counters (`p.runs`,
`p.timePlayed`) that move on every single committed run until each is
individually maxed out (25 runs, 100 runs, 10 hours).

**What's wrong:** dispatched two runs live on a fresh profile
(`tools/_r2meta_probe6.mjs`, deleted) — the second run identical to the
first in every stat (stage 1, 4 seconds, zero kills, nothing new). The
report was not empty:

```json
"report2": {
  "unlocks": [], "completed": [], "records": [], "discoveries": [],
  "advanced": [
    { "id": "veteran", "from": 1, "to": 2, "goal": 25 },
    { "id": "centurion", "from": 1, "to": 2, "goal": 100 },
    { "id": "clockedIn", "from": 4, "to": 8, "goal": 36000 }
  ]
}
```

`html2` was `"...Closing in...Veteran 2/25...Centurion 2/100...Clocked In
8/36,000...<div class="run-career">Run 2 · 0 lifetime kills · 0m in the
field</div>"` — not empty. Two independent reasons the `''`/`:empty` path is
effectively dead: the career line (`Logbook.js:987-993`) is unconditional
whenever `report.lifetime` exists, which `_buildReport` always populates for
any committed run; and `veteran`/`centurion`/`clockedIn` tick on literally
every run until each individually caps out, so "advanced" is essentially
never empty either. This isn't a functional defect — always showing a
one-line career footer, and letting the always-progressing meta-challenges
show up, is arguably better UX than a bare "You Died" — but it means the
doc comment's specific claim doesn't hold, and the dispatch's request to
verify "with an empty run (no items, no challenges)" surfaces the gap
between the two.

**Fix:** none required functionally; either drop the `''`/`:empty` claim
from the comment (it isn't the mechanism actually keeping the summary from
looking broken on a bad run — that's the career line + the trickle of
lifetime-counter progress), or, if a genuinely bare state is wanted, exclude
the three lifetime-only challenges from `advanced` and the career line from
a report with nothing else in it.

---

## Checked and clean

- **The 75f87d6 fix genuinely holds for mouse/touch, across viewport size and
  aspect ratio, under a maximal (not just realistic) report.** Live
  bounding-box measurements at six viewports (1600×900, 1280×720, 1024×600,
  2560×1080 ultrawide, 900×1600 portrait, 800×500 short), each with a
  synthetic report at 8 unlocks / 15 completed challenges / capped
  advanced+records, showed `logbookFullyVisible: true` and
  `restartFullyVisible: true` at every single viewport, and the death-mark
  header was never clipped above the fold (`deathMarkTopClipped: false`
  everywhere). Round 1's specific finding — Logbook/Restart pushed off a
  1600×900 frame — does not reproduce post-fix, and does not reproduce at
  five other sizes either. Full data in
  `reviews/round7/r2-meta/viewport-report.json`. (The keyboard/gamepad gap
  in finding #3 is a distinct defect from this — the buttons are always
  reachable; the *content above them* is not always readable without a
  mouse.)
- **Profile v1 → v2 migration**, exercised live against a hand-built v1
  payload (two runs, a completed challenge, five discovered ids, one earned
  unlock, a full stats block): version correctly bumped to 2, `discovered`
  correctly dropped in favour of `encounters` with every first-seen stamp
  carried verbatim and `count: 0` (never fabricated), per-survivor career
  correctly reconstructed from run history (`ranger: {runs:1, wins:1,
  kills:50, bestStage:6}`, `anvil: {runs:1, deaths:1, kills:20,
  bestStage:3}`), the completed challenge and its `doneAt` preserved, gold
  and unlock timestamps preserved.
- **Hostile/corrupt payloads all fail closed.** Truncated JSON, an array
  payload, a bare string, `null`, a payload with every field wrong-typed
  (`stats.runs: 'five'`, `unlocks: 'not-an-object'`, `challenges: [1,2,3]`,
  `runs: 'not-an-array'`, etc.), and a payload carrying a JSON-literal
  `__proto__` key all load cleanly into a valid, type-correct `freshProfile`
  shape with no thrown exception and no leaked garbage into arithmetic.
  `_load()`'s outer try/catch and `_coerce`'s per-field `isObj`/`Array.isArray`
  gates do what they claim.
- **A save from a newer, unknown schema version downgrades safely.** A v99
  payload with an unrecognised extra field loaded without throwing, version
  stamped down to what this build understands (2), matching the documented
  intent (no attempt to migrate backwards, no crash).
- **Unlock granting is idempotent; no double-grant reproduced.** Calling
  `profile.unlock('artifact', id)` twice returns `true` then `false`, and the
  unlock timestamp is written exactly once.
- **`massacre`'s sliding ten-second kill-burst window is correctly
  implemented**, not a tumbling-window undercount as round 1 raised as an
  open question about the neighbouring `lasher`/`shriver` combo (different
  finding, not retested here): 25 kills fired back-to-back live produced
  `progress: 25, done: true, killTimesLen: 25`, matching the array-of-
  timestamps-with-shift design in `Profile._onKill`.
- **UnlockRegistry's other defensive paths hold under direct, live
  exercise**: an `unlock` field naming an unknown challenge id is rejected
  with a console warning and leaves the content unlocked (the safe
  direction) rather than gating on nothing; a second reward bound to an
  already-bound challenge is rejected with a warning; malformed reward
  `type`/empty `id` are both rejected; a dynamic `goal` function that throws,
  or returns `NaN`, a negative number, `0`, or a non-number, all correctly
  fall back to `1` rather than to a goal of `0` (which would auto-complete on
  first evaluation); a malformed generated-challenge definition (missing
  `id`/`track`) is refused without disturbing a valid one registered in the
  same call.
- **No duplicate top-level content ids** in the current `SURVIVORS` (5),
  `ITEMS` (108), `EQUIPMENT` (14), `ARTIFACTS` (10) or the 28 top-level
  `ENEMIES` entries (verified with a targeted regex pass scoped to
  top-of-card `id:` lines, not the nested per-attack `id:` fields that a
  naive whole-file scan initially and incorrectly flagged as duplicates —
  `brood`/`bash`/`quake`/`lash` are attack ids reused across different
  monsters' `attacks` arrays, not monster ids). Given this, `catalogueSize()`
  is not inflated by id collisions today.
- **A gated (unlock-bound) content card that's later removed, or a stored
  unlock referencing an id no longer in a catalogue, degrades safely by
  inspection**: `isUnlocked` only ever reads `this.data.unlocks[type][id]`,
  a plain boolean-ish check with no dependency on the id still existing in a
  catalogue array; every UI lookup found (`Logbook.js:574`, `:900`,
  `Menus.js:648`, `:652`, `:706`, `:838`) uses `.find(...) || fallback`, never
  an unguarded index. Not independently reproduced live (would require
  editing a content file and is a low-value repro given the code is uniform
  and simple), but the pattern is consistent everywhere it's used, so this
  is PLAUSIBLE at high confidence rather than CONFIRMED.
- **Co-op witness filtering** (`Profile._isLocalSource`,
  `Profile.js:960-975`) reads correctly by inspection: single-player always
  local; co-op gates kill/damage credit on `src === me || src.owner === me`;
  shared facts (stage clear, teleporter, boss) are intentionally credited to
  everyone present. Not exercised against a live second client — PLAUSIBLE,
  not CONFIRMED, and called out as such rather than being cited as
  evidence.
- **The 33 authored + 5 generated = 38 challenge count is accurate** (counted
  directly from `CHALLENGES` array entries plus `UnlockRegistry.generateMastery`'s
  one-per-survivor output, confirmed live: `"registry: one generated mastery
  per survivor" → 5 generated / 5 roster`, `"challenge set size" → 38`).
  No duplicate `id`s among the 38.

---

## Verdict

**REFUTED against a AAA/RoR2-quality bar**, on both axes the dispatch asked
about.

The round-1 finding — the run-summary panel's buttons pushed off a
1600×900 frame — is genuinely fixed, and fixed more robustly than a narrow
reading of the commit message suggested: the CSS bounds the whole report
wrapper rather than each section individually, so it holds under a
synthetic worst-case report and across six viewports and aspect ratios, not
just the one frame size the original bug was found at. That part of the
brief is real, verified work.

But two of the four things this round-2 dispatch asked to attack hardest
turned up confirmed, live-reproduced breakage: the save layer's documented
"flush on hidden tab" protection has never actually fired in a real browser
(finding #2), and two of the thirty-eight challenges do not do what their
description says — one is unwinnable, one requires no actual speed despite
being named for it (finding #1). A third confirmed defect sits exactly on
the seam the dispatch called out by name — "the scroller is actually
reachable by keyboard/gamepad as well as mouse" — and it is not (finding
#3). A fourth shows the catalogue-scaling promise ("challenge goals that
scale with content are actually correct at the current content counts")
has a real crack in it for the two challenges that most directly embody
that promise (finding #4).

None of these are exotic to trigger. `blitz` mis-fires on the very first
stage-5 arrival of any run. The `visibilitychange` gap is a one-line typo
class of bug that fires (or rather, doesn't) on completely ordinary mobile
use. The keyboard/gamepad gap requires nothing more than a controller and a
run good enough to have something worth reading on the summary screen —
which is the entire reason that screen exists. A cert pass would bounce
this build on any one of the four.
