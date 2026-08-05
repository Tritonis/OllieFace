# Round 7 — round-4 (FINAL) critique: engine loop and the meta/UI layer

Reviewer: independent round-4 critic. Fresh eyes; not involved in building or
fixing any of this. Branch `round7/content-and-polish`, HEAD `a43cc70`. Bar:
shipped AAA quality. `RUBRIC.md` caps this project at four critic rounds, so
this is the last word on this domain.

Scope: `src/core/Engine.js`, `src/systems/Profile.js`, `src/ui/Logbook.js`,
`src/ui/Menus.js`, `src/data/challenges.js`, `src/systems/UnlockRegistry.js`.
Inputs treated as claims to re-derive, never as facts: round-3 critique
`reviews/round7/round3-critique-meta.md` (0 critical, 2 major), round-4 fix
report `reviews/round7/round4-fix-engine.md` (claiming 3 of 3).

**Headline: the engine fix is real and holds far past where it was tested. The
blast-radius characterisation the project was about to act on is wrong — in
mechanism and in scope — and I refute both of its load-bearing numbers with two
independent instruments. The correction makes the damage *smaller* and the rule
*simpler*, not larger.**

---

## Methodology

Everything below was measured live. Four throwaway Playwright drivers were
written into `tools/_r5crit_{engine,engine2,engine3,profile,saves,final}.mjs`,
run, and **deleted** (confirmed absent from `tools/` at time of writing; the
four `_r5*` files still there belong to other agents and were not touched). The
JSON they wrote is the record and every number below is quoted from it by name:

| file | contents |
|---|---|
| `reviews/round7/r5-engine/engine.json` | post-fix loop census to **51** cumulative cycles; freeze/thaw both ends; triple-`start()`; the pre-fix algorithm replayed on this build, with `ctx.paused` / hitstop / **substep histogram** recorded per `_frame` |
| `reviews/round7/r5-engine/engine2.json` | gap-cycle arm (freeze and thaw separated by rendered frames); the **controlled** pre-fix linearity arm — run held alive, hitstop suppressed — to 33 loops |
| `reviews/round7/r5-engine/engine3.json` | a real 21-shot capture with a byte-faithful **shadow** of the pre-fix loop-arming logic riding on the live `engine.start`/`engine.stop` calls |
| `reviews/round7/r5-engine/profile.json` | `_onDamage` accounting (shield arms, co-op filter, hostile payloads), time-unit readout, `massacre`, the meta clean list |
| `reviews/round7/r5-engine/saves.json` | two real browser tabs, ping-pong settle, the forced non-atomic-write race, import, foreign clear, `reset()` mid-run |
| `reviews/round7/r5-engine/final.json` | live challenge inventory, logbook DOM readout through the real renderer, clean-room `reset()`-vs-stale-tab in both branches ×4 |
| `reviews/round7/r5-engine/shots/` | the 21 PNGs from the shadow capture |

Every probe: headed Chromium with `tools/capture.mjs`'s own launch args
(`--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization
--force_high_performance_gpu`, parked off-screen), its own Vite server on its
own port (5491–5497, never 5199), driven through
`?seed=1337&quality=3&harness=1&pinclock=1` and `globalThis.__GAME__` /
`__HARNESS__`. `node node_modules/vite/bin/vite.js build` — **exit 0**,
`✓ built in 1.26s`, only the pre-existing chunk-size advisory. `git status
--porcelain -uno` is **empty**: no product code was modified.

### Sanity-checking my own instruments

Five instruments have been refuted on this project. Mine are checked as follows.

- **The loop census** wraps `Engine.prototype._frame` and divides `_frame` calls
  by presented rAF frames. Internal consistency check: at one loop it returns
  exactly `60` engine frames per `60` rAF and exactly `1.000` s of `ctx.time`,
  and the substep histogram is `{"1": 60}` — three independent quantities that
  all have to agree, and do, at every sample point.
- **Attribution, which the fixer's probe lacked**: the census also records, per
  `_frame` call, whether `ctx.paused` was set, whether hitstop was live, and how
  many fixed substeps that call actually ran. A shortfall against N× is
  therefore *attributable* instead of asserted. This is the whole difference
  between their §1.2 and this section.
- **The capture instrument is doubled.** The claim "a real capture accumulates
  loops" is tested twice by different means: (a) the real pre-fix `start()`
  installed on the live engine, cycling with a rendered frame in the gap
  (`engine2.json` → `gapCycles`), and (b) a shadow chain that emulates the
  pre-fix arming logic and counts, riding a real 21-shot capture
  (`engine3.json`). They agree.
- **Known limit of the shadow**: it does no work, so it cannot slow frames the
  way 22 real loops would. If loops *had* leaked, the extra load could in
  principle shift scenario timing. It does not matter here, because the
  separation that prevents the leak is structural (a `page.screenshot()` and a
  fresh `page.evaluate` between every `freeze()` and the next `thaw()`), not
  timing-dependent — and arm (a) confirms it with the real algorithm.
- **One instrument failure of my own, caught and reported**: my first
  flawless-stage arm reused one profile across sub-cases and produced a false
  positive (`untouchable`/`ironclad` reading `done` in an arm that should have
  failed), because challenges are lifetime-persistent and `Profile.reset()`
  does *not* clear the in-flight run. Exactly the trap round 3 documented in its
  own methodology. Re-run with `P.run = null` before each arm; the corrected
  numbers are the ones quoted (`saves.json` → `flawless`). The failed run is
  still on disk in `profile.json` → `flawless`, deliberately, and the mechanism
  behind it became Finding 5.

Not testable in this environment, unchanged from rounds 2–4: a physical or
OS-registered gamepad, a real mobile tab reclaim, touch input, a live co-op
second client, a hand-played end-to-end run, and two separate browser
*processes* (my two tabs are two pages in one context — same storage partition,
real `storage` events between them, which is the mechanism, but not two
independently launched windows).

---

## Verification table — round 4's claims

| # | Round 4's claim | This round's number | Verdict |
|---|---|---|---|
| 1 | `_loopGen` stops loop accumulation; 1.00 at 0/1/2/3 cycles + `gameplay()`, and at 21 | 1.000 at **0, 1, 2, 3, 5, 10, 20, 21, 31 and 51** cumulative same-turn freeze/thaw cycles; `_loopGen` reached **53** and `_frame` per presented frame never left 1.000; `ctx.time` advanced exactly 1.000 s per 60 rAF at every point. `engine.json` → `fixed` | **CONFIRMED**, and pushed to 2.4× the tested depth |
| 2 | Freeze still freezes | **0** engine frames per 30 rAF, and **0** per 120 rAF, after 51 cycles. `engine.json` → `fixedFreezeThaw.frozen`, `longFrozen` | **CONFIRMED** |
| 3 | Thaw still thaws | 1.000 loops and 1.000 s of `ctx.time` per 60 rAF immediately after a thaw, at cycle 52. `engine.json` → `fixedFreezeThaw.thawed` | **CONFIRMED** |
| 3b | (not claimed) does a redundant `start()` double the loop? | `start()` three times with no `stop()` → **1.000** loops, `_loopGen` unchanged at 54. The `if (this.running) return` guard holds. `engine.json` → `doubleStart` | **CONFIRMED** (new arm) |
| 4 | Pre-fix slope is +1.00 loop per freeze/thaw cycle | Reproduced with the byte-faithful pre-fix `start()`: 2/3/7/12/22/23 loops at handover/+1/+5/+10/+20/+21, and 33 at +32. `engine.json` → `old`, `engine2.json` → `controlled` | **CONFIRMED** |
| 5 | **"sim-seconds per 60 rAF are exactly N× up to ~10 loops, then non-linear (11.817 at 12, 10.517 at 22, 0.000 at 23) as `MAX_SUBSTEPS` saturates and the accumulator bleeds"** | **REFUTED.** With the run held alive and hitstop suppressed the pre-fix rate is **exactly N× at every loop count**: 2.000 / 3.000 / 7.000 / **12.000** / **22.000** / **23.000** / **33.000** sim-seconds per 60 rAF. `saturatedFrames` is **0** and the substep histogram is `{"1": N×60}` at *every* sample in *both* arms — `steps === MAX_SUBSTEPS` never fired once, so the accumulator-bleed branch (`Engine.js:239`) never executed. `engine2.json` → `controlled` | **REFUTED** — see Finding 1 |
| 6 | **"a clean 21-scenario capture ends at ~22 loops per presented frame"** | **REFUTED.** A real 21-shot capture with the pre-fix arming logic shadowed on the live `start`/`stop` calls: `sMaxAlive` **1**, `maxTicksPerFrame` **1**, `startStopPairsInSameFrame` **0** across 20 `start()` and 21 `stop()` calls. The pre-fix algorithm would have run **exactly one** loop for the entire capture. `engine3.json` | **REFUTED** — see Finding 1 |
| 7 | Cross-tab: the critic's 12-kill loss is now 28 with `lostKills 0` across two real tabs | Independently reproduced in two real tabs: `bLoadedKills 10`, `storageAfterA2 25`, disk **28**, `lostKills 0`, both unlocks (`aTab`, `bTab`) on disk, **both** tabs' memories converged to 28. `saves.json` → `twoRealTabs` | **CONFIRMED** |
| 8 | "settles in one write each, no ping-pong" | Settles — disk 14, both memories 14 — but in **1 write by A and 2 by B**, not one each. Termination (the property that matters) holds; the exact count does not reproduce. `saves.json` → `settle` | **CONFIRMED in substance, not in figure** |
| 9 | The residual: a foreign write between `_reconcile()` and `setItem` "can still lose one delta" | **Reproduced deterministically, and it is worse than "one delta"**: the entire foreign write is lost — 984 kills *and* an unlock — and `_baseRaw` then matches the disk, so nothing ever recovers it. `saves.json` → `casWindow`, `casRecovery`. See Finding 4 | **CONFIRMED and sharpened** |
| 10 | `reset()` is still a wipe against a concurrent tab (`100 → 0`, next write `1` not `101`) | **REFUTED in two of four clean-room arms and for unlocks in all four.** Whether the wipe holds depends entirely on whether the second tab had already flushed. `saves.json` → `resetVsStale` (5/5 gave 101), `final.json` → `resetVsStale_*`. See Finding 2 | **REFUTED** |
| 11 | `importProfile()` replaces rather than merges (7, not 507) | `afterImport: 7`. `saves.json` → `importAndClear` | **CONFIRMED** (single tab only — see Finding 2) |
| 12 | A foreign `localStorage.clear()` leaves this tab's profile intact and restored on next write | Memory kept 42, next write restored 43. `saves.json` → `importAndClear` | **CONFIRMED** |
| 13 | `marathon` reads `17:54 / 30:00`, `clockedIn` `17m / 10h 0m`, non-time rows unchanged | All three surfaces, through the real renderers. Death-screen "Closing in": `["4 / 5", "4 / 5", "17:54 / 30:00"]`. Logbook list rows: `Marathon 17:54 / 30:00`, `Clocked In 17m / 10h 0m`, `Veteran 1 / 25`, `Centurion 1 / 100`, `The Long Haul 1 / 5`. Detail panel: `17:54 / 30:00`, `17m / 10h 0m`, `1 / 25`. `challengeState.format`: `marathon: time`, `clockedIn: time`, `veteran: number`. `_buildReport`'s `advanced` rows carry `format`. `profile.json` → `timeFormat`, `final.json` → `logbookDom` | **CONFIRMED** — but one progress-pair surface was missed, Finding 3 |
| 14 | The meta clean list re-run against the changed write path | Independently re-run; see "Checked and clean". `profile.json` → `cleanList` | **CONFIRMED** |

---

## Findings, most severe first

### 1. MAJOR — the blast-radius characterisation is wrong in both mechanism and scope, and the project is one step from discarding measurements that were never affected

**Where:** `reviews/round7/round4-fix-engine.md` §1.2, and the derived
instruction "no round-3 figure taken through that preamble should be quoted
without re-measuring it". Not a code defect — a **finding defect**, in the one
paragraph the round is using to decide what history to throw away.

**What the report says.** (a) Past ~7–10 concurrent loops the pre-fix simulation
rate "stops being a clean multiple and becomes non-linear and unpredictable" —
`11.817` sim-seconds per 60 rAF at 12 loops, `10.517` at 22, `0.000` at 23 —
"because `MAX_SUBSTEPS = 5` saturates, `Engine._frame` bleeds the accumulator to
zero (`Engine.js:217`)". (b) "A clean 21-scenario capture ends at **~22 loops
per presented frame**." Both are load-bearing: (a) is why the numbers are called
unpredictable rather than correctable, and (b) is why *captures* are in scope at
all.

**(a) is refuted, and the stated mechanism cannot occur.** Under a pinned clock
each `_frame` call takes exactly one `getDelta()` of `1/60`, so the accumulator
gains exactly one `FIXED` and runs exactly one substep. `steps` is 1, never 5,
so the branch the report names — `if (steps === MAX_SUBSTEPS) this.accumulator =
0` at **`src/core/Engine.js:239`** (the report cites `:217`, which is the
hitstop test) — is unreachable. Measured, not argued: `saturatedFrames` is **0**
and the substep histogram is `{"1": N×60}` at every sample point in **both**
arms, uncontrolled and controlled (`engine.json` → `old`, `engine2.json` →
`controlled`).

With the run held alive and hitstop suppressed, the pre-fix rate is exactly
linear all the way out:

| loops | 1 | 2 | 3 | 7 | 12 | 22 | 23 | 33 |
|---|---|---|---|---|---|---|---|---|
| sim-seconds per 60 rAF (`engine2.json` → `controlled`) | 1.000 | 2.000 | 3.000 | 7.000 | **12.000** | **22.000** | **23.000** | **33.000** |
| the report's figure | 1.000 | 2.000 | 3.000 | 7.000 | 11.817 | 10.517 | 0.000 | — |
| `saturatedFrames` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**What actually produced their shortfall — reproduced, then attributed.** Run
uncontrolled (their conditions) I reproduce their shape almost exactly, and the
extra instrumentation names the cause (`engine.json` → `old`):

| loops | sim/60 rAF | `pausedFrames` | `hitstopFrames` | `menuScreen` | `playerAlive` |
|---|---|---|---|---|---|
| 7 | 6.767 | 0 | 16 | null | true (hp 72) |
| 12 | 7.117 | **265 / 720** | 40 | **death** | **false** |
| 22 | 0.000 | **1320 / 1320** | 0 | **death** | false |
| 23 | 0.000 | **1380 / 1380** | 0 | **death** | false |

The simulation is running at exactly N×, so the survivor takes N× the incoming
damage per presented frame and **dies inside the measurement window**. The death
screen calls `Menus.open()`, which sets `this.ctx.paused = true`
(**`src/ui/Menus.js:953`**), and `Engine._frame`'s `if (!ctx.paused)` guard
(**`src/core/Engine.js:230`**) then skips every fixed step — so `ctx.time`
advances by exactly zero. The residual 1.5% shortfall at 7 loops is hitstop
(16 frames at `HITSTOP_SCALE`), the only real sub-N term, and it is bounded by
the 15% duty ceiling. Their instrument was not broken; the interpretation was —
they measured a shortfall without measuring `steps`, and attributed it to a
branch that never ran.

**(b) is refuted — no capture ever leaked a single loop.** The leak condition is
narrow and structural: `stop()` clears `running`, and the already-armed tick
fires on the **next** rendered frame, sees `running === false`, and returns
*without re-arming* — the chain is dead. A loop only survives if `start()` runs
**before that next frame**, i.e. in the same JS turn as the `stop()`. Two
independent instruments:

- Real pre-fix `start()`, cycling with a rendered frame in the gap: after 1, 4,
  5 and 10 cumulative cycles at gaps of 1, 3 and 10 frames, loops stayed
  **1.000** and sim stayed **1.000** — zero accumulation (`engine2.json` →
  `gapCycles`).
- A byte-faithful shadow of the pre-fix arming logic riding the live
  `engine.start`/`engine.stop` calls through a **real 21-shot capture**
  (screenshots and all): `sMaxAlive` **1**, `maxTicksPerFrame` **1**,
  `startStopPairsInSameFrame` **0** over 20 `start()` and 21 `stop()` calls
  (`engine3.json`).

`tools/capture.mjs` puts a `page.screenshot()` and a fresh `page.evaluate`
between every scenario's `freeze()` and the next scenario's `thaw()` — hundreds
of rendered frames. **The "~22 loops" figure was never measured on a capture**;
it was extrapolated from `cycle(n)` calls, which are same-turn by construction.
The extrapolation is what is wrong, not the cycle measurement.

**Why this matters:** the report's §1.2 puts *screenshots, manifests and every
round-3 probe* under suspicion and calls the damage "non-linear and
unpredictable" — which is an argument for discarding rather than correcting. The
truth is narrower and repairable: captures are untouched, and the probes that
*were* touched were touched by an exact integer. The rule is in its own section
below.

**Fix:** replace §1.2 with the measured position — the leak requires a same-turn
freeze/thaw, no capture produces one, and where it does occur the rate is
exactly N×. Correct the `Engine.js:217` citation to `:239`. Withdraw the "~22
loops per presented frame" figure and the "non-linear" characterisation.

---

### 2. MAJOR (latent — no shipped call site) — `Profile.reset()` is not a wipe when a second tab is open: an unlock survives it every time, and lifetime totals survive it whenever the other tab has un-flushed progress

**Where:** `src/systems/Profile.js:983-997` (`reset()`), `:289-378`
(`mergeProfiles`), `:467-474` (the `storage` listener). The doc comment reads
"Wipe everything. Used by the settings screen; there is no undo."

**What's wrong.** `reset()` sets `_authoritative` so *its own* write skips the
merge — correct. But the other tab's `storage` handler then runs `_reconcile()`
against the wiped disk, and `mergeProfiles` has no delta semantics for
set-valued fields: unlocks, challenge `done` flags and first-seen stamps are a
**union keyed on the earliest stamp** (`:305-311`, `:313-325`), so nothing on
that side can ever be removed by a wipe. Lifetime sums use
`sum(b, r, m) = max(0, r + (m − b))` (`:297`), which returns the other tab's
un-flushed delta straight back.

**Reproduced live**, clean room (storage cleared and *both* tabs reloaded before
each arm), 4 arms — `final.json` → `resetVsStale_*`, corroborated by 5/5 runs of
a looser arm in `saves.json` → `resetVsStale`:

| arm | disk before wipe | disk after wipe | tab B memory after wipe | disk after B's next write |
|---|---|---|---|---|
| B had flushed its 100 | 100 kills, `hardWon` | **0 kills, `hardWon` still there** | 0 | 1, `hardWon` |
| B had **not** flushed | 1 kill, `hardWon` | **99 kills, `hardWon`** | **99** | **100**, `hardWon` |
| B had not flushed (repeat) | 100 | 0, `hardWon` | 0 | 1, `hardWon` |
| B had not flushed (repeat) | 1 | **99**, `hardWon` | **99** | **100**, `hardWon` |

So: **the unlock survives the wipe in 4 of 4 arms**, and the lifetime kill
counter survives in every arm where tab B's progress had not yet reached disk —
which is the ordinary case, since the write is debounced by
`WRITE_DEBOUNCE_MS = 1500` (`:92`). The round-4 report's §2.3 states this arm as
clean (`afterResetRuns 0`; "the stale tab's memory went 100 → 0 … and its next
write produced 1, not 101"); that is true only in the already-flushed branch and
false for unlocks in both. My looser arm produced **101, five times out of
five** — a third value alongside their run-1 `0` and run-2 `1`, and the
divergence is fully explained by the ancestor each tab happened to hold, not by
flakiness.

**Severity, honestly.** `Profile.reset()`, `importProfile()` and
`exportProfile()` have **no call site anywhere in `src/`** (grepped the tree;
the only hits are Profile's own comments). There is no settings screen that
wipes — the `case 'settings'` arm in `src/ui/Menus.js:999` falls through to
`'logbook'`. So this cannot be reached by a player today, and the doc comment's
"Used by the settings screen" is false. It is graded MAJOR rather than MINOR
because the round-4 report asserts it as a *verified guarantee* of the new merge
scheme, and because the moment a wipe button is wired up — which is a one-line
change someone will make for a Steam build (`docs/STEAM.md` is cited in
`exportProfile`'s own comment) — a player clearing a shared machine gets their
unlocks and possibly their whole career handed back by a second tab.

**Fix:** make a wipe a *tombstone*, not an empty profile: give `reset()` a
`wipedAt` stamp written into the payload, and have `mergeProfiles` drop any
`remote`/`mine` field whose stamp predates the newest `wipedAt` it can see.
Cheaper interim: have `reset()` also set a `_wipeGeneration` counter in the
stored blob and make `_reconcile` treat a remote whose generation is *older*
than the local one as authoritative-loss rather than as a merge partner. Either
way, also fix the doc comment at `:982` and wire or delete the dead
`reset`/`importProfile` surface before shipping.

---

### 3. MINOR (latent) — one challenge progress-pair surface still prints raw seconds: `Logbook.unlockHint`

**Where:** `src/ui/Logbook.js:610`.

```js
return `${st.name} — ${st.description}${st.goal > 1 ? ` (${st.progress} / ${st.goal})` : ''}`;
```

`challengeState` hands it `st.format` and this line never reads it. It is the
text drawn in the locked-entry detail panel (`renderDetail`, `Logbook.js:581-587`)
for a survivor/item/equipment card gated behind a challenge — the fourth
progress-pair surface in the file, and the one the round-4 fix did not reach.

**Reproduced live** (`final.json` → `logbookDom.unlockHint`), through the real
renderer on the real profile:

```
"Marathon — Survive for 30 minutes in a single run. (1074 / 1800)"
```

which is precisely the defect round 3 raised, on a surface round 4 did not
audit. **Latent today**: the only content cards declaring an `unlock` are the
seven artifacts in `src/data/artifacts.js` (`:59,69,79,89,99,110,120`), none of
which name `marathon` or `clockedIn`. It goes live the day any content is gated
on a time-scoped challenge.

**Fix:** `progressPair(st.progress, st.goal, st.format, String)`, the same call
the other three sites already make (`Logbook.js:478`, `:781`, `:990`).

---

### 4. MINOR (narrow window, unbounded and unrecoverable consequence) — the non-atomic reconcile-then-write loses the *whole* foreign write, and the `navigator.locks` refusal rests on a false all-or-nothing

**Where:** `src/systems/Profile.js:712-731` (`_reconcile`) and `:733-755`
(`flush`). The report names this residual in §2.4 as "can still lose one delta"
and could not explain why one of three runs disagreed.

**Reproduced deterministically** (`saves.json` → `casWindow`): disk at 10, this
tab earns 5, and a foreign write carrying **999 kills and a `ghostTab` unlock**
is landed between `_reconcile()`'s `getItem` and `flush()`'s `setItem`. Result:

```json
{ "diskKills": 15, "diskHasGhostUnlock": false, "memKills": 15, "lostForeignKills": 984 }
```

Not "one delta" — the *entire* foreign write, counters and unlocks alike. And it
is **unrecoverable**: `casRecovery` shows `baseRawMatchesDisk: true`, so this tab
now treats 15 as the agreed ancestor; the other tab's `_baseRaw` is the bytes it
wrote, so on its next flush `sum(base=999, remote=15, mine=999)` returns 15 and
it adopts the loss too. Nothing in the design ever notices.

This also explains the report's own unexplained disagreement between
`probe2-run1.json` and `probe2.json` better than "intermittent": the two runs
differ in *which ancestor each tab held*, which is deterministic once you
control the flush order (Finding 2 shows the same thing producing three
different answers reproducibly).

**On the declined `navigator.locks`.** The stated reason is sound as far as it
goes — `flush()` is called from `pagehide` and from a hidden
`visibilitychange` (`Profile.js:456-481`), where an async continuation is not
guaranteed to run, and making the last line of defence asynchronous would be a
bad trade. But it is presented as all-or-nothing, and it is not: the lock is
needed on the *debounced* path, which is >99% of writes and has no synchrony
requirement, and the unlocked synchronous write can be kept for the two
last-gasp handlers only. A one-line split (`flush({ sync = false })`, taking the
lock when `!sync`) closes the window for every ordinary write while leaving the
killed-tab path exactly as it is. Recommending it as a design escalation was
right; framing it as impossible was not.

**Severity.** Genuinely narrow — same-origin tabs frequently share a renderer
process, in which case the two operations are serialised and cannot interleave
at all. Kept MINOR on that basis, but the consequence when it does fire is
unbounded and silent, which is why the fix above is worth the line.

---

### 5. MINOR (latent) — `reset()` does not clear the in-flight run, so a wipe mid-run commits pre-wipe play into the fresh profile

**Where:** `src/systems/Profile.js:983-997`. `reset()` replaces `this.data` and
clears `_pendingUnlocks`, `_earnedThisRun`, `_completedThisRun`,
`_beforeChallenges`, `_beforeStats`, `lastReport` and `_facts` — but not
`this.run`.

**Reproduced live** (`saves.json` → `resetMidRun`): a run holding 77 kills, 999
damage taken and 600 s survives `reset()` untouched (`runStillThere: true`,
`runAfter` identical), and the subsequent `commitRun` writes a history record of
`{kills: 77, damageTaken: 999, time: 600}` into the freshly wiped profile. A
profile the player asked to erase has a pre-erasure run in its history.

Latent for the same reason as Finding 2 — nothing in `src/` calls `reset()`. It
is reported because it is what produced the false positive in my own first
probe pass, and it will produce the same false positive in the next person's.

**Fix:** `this.run = null;` in `reset()`, next to `this.lastReport = null`.

---

### 6. MINOR — `flawlessStages` never credits the last stage of a run

**Where:** `src/systems/Profile.js:1290` is the only site that increments
`flawlessStages`, and it fires on the *next* `stageStart`. `commitRun`
(`:1087-1174`) does not perform the equivalent check, so a run's final stage —
whether it ends in a win or a death — is never assessed. A player who clears a
final stage untouched is given nothing for it. It does not block either
challenge (`untouchable` needs 1 clean transition, `ironclad` needs 3; both
completed cleanly in my arms), so this is a fairness/consistency defect rather
than a reachability one.

**Fix:** in `commitRun`, before releasing `this.run`, credit
`if (won && run.damageTakenThisStage <= 0) run.flawlessStages++` and re-run the
challenge pass — the pass already runs there for exactly this reason.

---

### 7. MINOR — `massacre`'s ten-second window is wall-clock, against a description that reads as game time

**Where:** `src/systems/Profile.js:104` (`BURST_WINDOW_MS = 10000`) and
`:1341-1345`, which windows `Date.now()` samples. `src/data/challenges.js:286`
describes it as "Kill 25 monsters within ten seconds."

Kills are produced inside `Engine._frame`'s fixed step, which is scaled by
`HITSTOP_SCALE = 0.15` whenever `ctx.hitstop > 0` (`Engine.js:217-222`). In
exactly the kill-dense fight this challenge targets, hitstop makes wall time run
*ahead* of simulated combat time, so a wall-clock ten seconds contains fewer
than ten game-seconds of killing — the challenge is harder than its own
description. The divergence is bounded by the 15% duty ceiling
(`Engine.js:24-25, 227-228`) and I confirmed the challenge still completes
(`profile.json` → `massacre`: 25 kills → `bestKillBurst 25`, `done: true`), so
this is a description/implementation mismatch, not a blocker. The code comment
at `:1059-1062` argues for wall time deliberately (so a paused game produces no
samples), which is a defensible choice — but then the description should say
"ten seconds" of what, or the window should be `ctx.time`-based with an explicit
pause guard.

---

### 8. MINOR — `_onDamage` silently drops a hit whose `toHealth` is present but not a number

**Where:** `src/systems/Profile.js:1365`, `const taken = num(e?.toHealth ?? e?.amount, 0);`

`??` only falls through on `null`/`undefined`. A `damage` event carrying
`toHealth: '7'` (or any non-number) yields `num('7', 0) === 0`, the `taken <= 0`
guard returns, and the hit is billed as zero — the `amount` fallback is never
consulted. Reproduced: `profile.json` → `damage.hostileToHealth` gives
`{nan: 0, negative: 0, string: 0}` against `amount: 10` in all three cases.

**Not currently reachable.** `Combat.js:472-475` is the only emitter of `damage`
in the tree and it always sends a number. Reported for completeness because the
same line is what a co-op/replay path would deserialise into. If the intent is
"fall back to `amount` when `toHealth` is unusable", the expression wants to be
`const taken = Number.isFinite(e?.toHealth) ? e.toHealth : num(e?.amount, 0);`.

---

## The rule: which historical numbers survive the engine bug

This is the deliverable the round actually needs, and it is much narrower than
§1.2 of the fix report implies. Everything in it is measured, not inferred.

**Step 1 — was the number even exposed?** The bug leaks a loop **if and only if**
`engine.stop()` and `engine.start()` (i.e. `H.freeze()` and `H.thaw()`) ran in
the **same JS turn**, with no rendered frame between them. One rendered frame is
enough to kill the stale chain permanently.

- **Every `tools/capture.mjs` run: not exposed. Zero loops, ever.** Measured on a
  real 21-shot capture (`engine3.json`: `sMaxAlive 1`, `startStopPairsInSameFrame
  0`). A `page.screenshot()` and a fresh `page.evaluate` sit between every
  `freeze()` and the next `thaw()`. **Every screenshot, every manifest number,
  every `subjectFailures` detail, every `sepP50`/`px`/`visibleObjects` figure in
  every capture directory on this branch is unaffected. Do not re-measure them
  for this reason.**
- **`tools/perf.mjs`: not exposed.** It never freezes or thaws, and it runs
  unpinned (where the leak is nearly invisible anyway — see step 3).
- **Ad-hoc critic probes: exposed if and only if the thaw was in the same
  `page.evaluate` as the freeze.** The `await H.gameplay(); H.thaw();` preamble
  inside one `evaluate` is exposed (the `await` continuation is a microtask in
  the same task as `gameplay()`'s closing `freeze()`). Two separate
  `page.evaluate` round-trips are **not** exposed. The exposure count is
  `N = 1 + (number of same-turn freeze/thaw pairs the page had seen)`.

**Step 2 — if exposed, the correction is exactly linear.** Not "unpredictable".
With N loops under a pinned clock the simulation advanced **exactly N×** per
presented frame — verified to four decimal places at N = 1, 2, 3, 7, 12, 22, 23
and 33 (`engine2.json` → `controlled`). `MAX_SUBSTEPS` never saturates under a
pinned clock, so the accumulator never bleeds.

**Step 3 — apply the correction by what the number was measured against.**

| kind of number | affected? | correction |
|---|---|---|
| **Directional / boolean** — "did nothing", "dealt zero", "never appeared", "threw", "stayed `undefined`", "`polluted` unset", pass/fail of a gate | **No.** Multiplying the clock by an integer cannot turn zero into non-zero or absence into presence | none |
| **Identity and set-valued** — which ids were seen, unlock sets, challenge `done` flags, distinct counts, DOM text, `format` tags | **No** | none |
| **A rate, or anything per *presented frame*** — VFX age at the shutter, "px at frame k", damage per rendered frame, "n frames to settle" | **Yes** | the simulation was **N× further along** than the frame count implies |
| **Anything that waited on `ctx.time`** (`waitSim`, "run to `ctx.time = X`") | **Yes, in the other direction** | it got the sim-seconds it asked for, but bought them in **1/N** the wall time and **1/N** the rendered frames — so any *presentation* quantity sampled there is 1/N as far along |
| **Wall-clock windows crossed with sim events** — e.g. `massacre`'s `Date.now()` burst window | **Yes** | N× the kills fit in one wall-clock window |
| **Anything from a long live fight at N ≥ 7** | **Yes, and not repairable by arithmetic** | the survivor takes N× damage per presented frame and can **die inside the measurement**; from that instant `ctx.paused` is true and the sim clock is stopped dead (`Menus.js:953` → `Engine.js:230`). Such a probe may have been measuring a death screen. **Re-run these; do not scale them.** |

**The one-line version for the ledger:**

> Captures are clean — no capture ever leaked a loop, so nothing in `shots/` or
> any `manifest.json` needs re-measuring. Ad-hoc probes that thawed in the same
> `page.evaluate` as the freeze ran the world at exactly N× (N = 1 + same-turn
> cycles): their pass/fail verdicts, id sets and counts all stand; their rates,
> durations and frame-indexed quantities scale by N; and any of them that ran a
> live fight for more than a few seconds at N ≥ 7 must be re-run, because the
> run may have died mid-measurement.

---

## Checked and clean

- **The engine fix itself, both ends and past its tested depth.** 1.000 loops
  and 1.000 sim-seconds per 60 rAF at 0, 1, 2, 3, 5, 10, 20, 21, 31 and **51**
  cumulative same-turn cycles (`_loopGen` 53); 0 engine frames across 30 *and*
  120 rAF while frozen; a clean 1.000 immediately after the next thaw; and
  `start()` called three times with no `stop()` still yields one loop with
  `_loopGen` unmoved. Zero console/page errors in every arm. `engine.json`.
- **The `_onDamage` edit, all four arms.** No shield: `toHealth 50` → billed 50.
  Fully absorbed (shield 1000): `toHealth 0`, `absorbed 50` → **billed 0**, run,
  stage and lifetime counters all unmoved. Partially absorbed (shield 20):
  `toHealth 30` → billed exactly 30. Small hit: 7 → 7. Ordinary
  `damageTaken` reporting is therefore intact for every hit a barrier did not
  eat. `profile.json` → `damage`.
- **The attacking branch was not touched by the edit** — it still bills
  `amount` (post-crit, post-armour `incoming`), which is what `Combat.js:439-444`
  argues for by name, and `highestHit` still reads `amount`. Verified by reading
  `Profile.js:1370-1375` against `Combat.js:453-511`; the live arm reported
  `no enemy available` (`profile.json` → `damage.attacking`) because the
  director's list was empty at that point in the scenario, so this one is
  **code-verified, not executed** — named rather than claimed.
- **The co-op witness filter survived the edit.** With `netRole = 'client'`, a
  `damage` event against a foreign `isPlayer` pawn billed **0**; the same event
  against `ctx.player` billed **40**. The filter sits before the new `taken`
  computation and is unchanged. `profile.json` → `damage.coop`.
- **The `toHealth` fallback works for an emitter that has no such field**: a
  `damage` event with `amount: 13` and no `toHealth` billed 13, not 0.
- **`untouchable` and `ironclad` are genuinely unblocked, and the negative cases
  still fail.** Four corrected arms with a fresh run each (`saves.json` →
  `flawless`): every hit eaten by a barrier → `flawlessStages 3`,
  `damageTaken 0`, both challenges done; **real** damage on every stage →
  `flawlessStages 0`, `damageTaken 60`, **neither** done; one stage hurt out of
  three → `flawlessStages 2`, `untouchable` done, `ironclad` 2/3 **not** done;
  no damage at all → same as the barrier arm. The fix does what it claims and
  does not overshoot into marking a hurt run flawless.
- **All 38 challenges exist, are well-formed and are reachable.** Live inventory
  (`final.json` → `inventory`): `CHALLENGES.length 38`, `CHALLENGE_BY_ID` 38,
  `challengeStates()` 38, of which 5 are the generated `mastery.{ranger, anvil,
  kestrel, rook, cinder}` from `UnlockRegistry.js:150-173` (the only
  `registerChallenges` caller in the tree). **No state is null and no goal is
  ≤ 0.** Exactly two carry `format: 'time'` — `marathon` and `clockedIn`. Every
  tracked field has a live writer; the survey denominators (`SPAWN_CARDS`,
  `BOSS_CARDS`, `ITEMS`, `EQUIPMENT`, `SURVIVORS`) are the same arrays their
  numerators are filtered against. Two caveats stand as Findings 6 and 7, and
  end-to-end reachability of all 108 items / 14 equipment pieces through real
  drops was not played out.
- **The time-unit readout, on all three surfaces and both sides of the
  helper switch.** `progressPair` called directly: `marathon` `17:54 / 30:00`,
  `clockedIn` `17m / 10h 0m`, `veteran` `1 / 25`, at goal `30:00 / 30:00` and
  `10h 0m / 10h 0m`, and the switch lands correctly either side of an hour
  (`goal 3599` → `1:40 / 59:59`, `goal 3600` → `1m / 1h 0m`) — so `clockedIn`
  cannot render as `600:00`. `final.json` → `readout.direct`.
- **`_buildReport` tags `advanced`**: `marathon` `format: 'time'`,
  `theLongHaul` and `mastery.ranger` `format: 'number'`; the rendered death
  screen shows `["4 / 5", "4 / 5", "17:54 / 30:00"]` — the non-time rows are
  byte-identical to before. `profile.json` → `timeFormat`.
- **Cross-tab merge, two real tabs.** The critic's exact 25→13 sequence now ends
  at **28** with `lostKills 0`, both tabs' unlocks on disk, and both in-memory
  profiles converged to 28. Two tabs each adding 7 settle at 14 with three
  writes total and then go quiet — no ping-pong. `saves.json` → `twoRealTabs`,
  `settle`.
- **v1→v2 migration**: `version 2`, `encounters.enemy.grunt {at: 111, count: 0}`
  reconstructed from the old `discovered` shape, challenge `doneAt 42`
  preserved, `survivors.ranger` rebuilt from the run list. `profile.json` →
  `cleanList.migration`.
- **Hostile / corrupt / future payloads**: truncated JSON, an array, a bare
  string, `null`, an all-wrong-typed object, a `__proto__` literal and
  `version: 99` — **none threw**, all produced a type-correct profile
  (`killsIsNumber: true` in every case), `({}).polluted` stayed `undefined` in
  every case, and the two legible ones kept their data. `_parse` returning
  `null` rather than a fresh profile is what lets `_reconcile` tell "unreadable"
  from "empty", and `_load` supplies the fresh profile at the same point it
  always did. `profile.json` → `cleanList.payloads`.
- **Quota exceeded, on the plain path *and* on the merge path** — the latter
  being an arm the fix report named as untested. Both swallowed the
  `QuotaExceededError` without throwing, set `_storageBlocked`, and left the
  merged copy intact in memory. `profile.json` → `cleanList.quotaPlain`,
  `quotaDuringMerge`.
- **A hostile payload delivered through a live `storage` event** — the other arm
  the report named as untested. It goes through the same `_parse`
  migrate/coerce path: nothing threw, `stats.kills` stayed a number, and
  `({}).pwn` stayed `undefined`. `profile.json` → `cleanList.hostileStorageEvent`.
- **Unlock idempotency**: first `true`, second `false`, stamp stable.
  **Abandoned debounce**: `_touch()` then `reset()` left disk at 0 and it was
  still 0 after the original timer's deadline. `profile.json` → `cleanList`.
- **`importProfile` replaces rather than merges** (7, not 507), and a foreign
  `localStorage.clear()` leaves this tab's profile in memory (42) and restored
  on its next write (43). `saves.json` → `importAndClear`. Both single-tab;
  `importProfile` against a concurrent tab was **not** tested and would be
  subject to Finding 2's merge-back.
- **`massacre`**: 25 kills in one burst → `bestKillBurst 25`, `25/25 done`.
- **`registerUnlockBinding`'s reverse-collision guard is reachable** from the
  registry's real call path (`UnlockRegistry.js:125` → `challenges.js`'s
  `REWARD_OWNER` check), and **no shipped content trips either guard** — the
  seven `unlock:` declarations in `src/data/artifacts.js` are unique in both
  directions and `UNLOCK_BINDINGS` is empty, so nothing warns at boot.
- **A real 21-shot capture on the fixed engine** produced 21 PNGs, zero page
  errors, and exactly one failing subject check — `06-loaded-hud`, unchanged in
  kind (`objs 8/10`, `px 759`, `sepP50 0.69`), identical across two independent
  runs of mine. Worth recording: the fix report could not attribute the
  `sepP50` 0.39 → 0.69 move and declined to claim it. **It is now provable that
  the engine fix is not the cause** — the pre-fix algorithm accumulated zero
  loops in a capture, so captures ran identically before and after. That delta
  belongs to one of the other three fixers' edits. `engine3.json`,
  `reviews/round7/r5-engine/shots/`.

---

## Arms this round could not close

- A physical or OS-registered gamepad, a real mobile tab reclaim, touch input, a
  live co-op second client, a hand-played end-to-end run. Unchanged from rounds
  2–4; nothing in this environment closes them.
- **Two separate browser *processes*.** My two tabs are two pages in one
  Playwright context — same storage partition, real `storage` events delivered
  by the browser, which is the mechanism. Notably, this is also the
  configuration *least* likely to expose Finding 4, since same-process tabs
  serialise their `localStorage` access; a two-process test would exercise that
  window for real. Not attempted.
- **The attacking branch of `_onDamage` was code-verified, not executed** (no
  enemy was alive at that point in the scenario). Named rather than claimed.
- **`importProfile` against a concurrent tab.** Untested; Finding 2's mechanism
  says it will suffer the same merge-back as `reset()`.
- **Whether the engine fix stabilises `06-loaded-hud`.** It cannot — captures
  never leaked a loop, so the fix changes nothing there. The flapping that three
  reports describe has some other cause, still unidentified.
- **A profile large enough for the merge to be measurable.** Not profiled.

---

## FINAL POSITION

Per `RUBRIC.md`'s stopping condition — four rounds, no round five — here is the
honest split.

### Still broken (would fail a cert pass on the claim, not necessarily on the ship)

1. **The blast-radius characterisation (Finding 1).** Two of its numbers are
   refuted by two independent instruments each, and its stated mechanism cannot
   physically occur. The code is fine; the *finding* is not, and it is the
   finding the project is about to act on. Nothing else in this report matters
   as much: acting on §1.2 as written means discarding a body of capture data
   that was never affected, while under-correcting the probe data that was. The
   replacement rule is in this report and is a strict simplification. **Fix the
   report before anyone acts on it.**
2. **`Profile.reset()` is not a wipe with a second tab open (Finding 2).**
   Reproduced 4/4 for unlocks and 2/4 for lifetime totals in a clean room. It is
   *latent* — no shipped UI calls it — so it does not block a ship today. It
   does block the claim in `round4-fix-engine.md` §2.2/§2.3, and it becomes live
   the day someone wires a wipe button, which the code's own comments say is the
   plan.

### Fixed but unverifiable here

- **The attacking branch of `_onDamage`** — the edit does not touch it and the
  code reads correctly against `Combat.js`'s own contract, but no live arm
  exercised it. Everything around it (defending branch, co-op filter, both
  challenges) is measured.
- **Anything requiring a real device or a real second client**: gamepad, mobile
  reclaim, touch, co-op witness filtering against an actual remote pawn (the
  filter was exercised with a synthetic one), and a hand-played run.
- **Finding 4's race in the wild.** Reproduced deterministically by forcing the
  interleave, which proves the consequence; whether a real two-process browser
  ever lands a write in that window was not measured and cannot be from one
  storage partition.

### Acceptable to ship

- **The engine fix.** `_loopGen` is minimal, correct, and holds at 51 cycles —
  2.4× the depth it was tested to — with freeze still freezing dead across 120
  rAF, thaw still thawing, and a redundant `start()` still a no-op. Zero errors.
  It is also, on the evidence in this report, a **smaller** defect than the
  round believed: no shipped code path and no capture ever produced the leak,
  and `engine.start`/`stop` have exactly two callers, neither of which a player
  can reach. This is correct code fixing a real but measurement-only defect.
- **The `_onDamage` edit**, which was the change I was asked to treat with the
  most suspicion. It is right. `toHealth` genuinely means "what reached health
  after the barrier" (`Combat.js:463,473`), the ordering puts the co-op filter
  before the new computation, ordinary hits still bill the full amount, partial
  absorption bills exactly the remainder, the attacking branch still bills
  `incoming` as `Combat.js:439-444` requires, and `untouchable`/`ironclad` now
  complete on a barrier run and still correctly refuse a hurt one. The only
  blemishes are cosmetic (Finding 8) and pre-existing (Finding 6). Shipping it
  without a live probe was a risk that happened to land; the probe now exists.
- **The cross-tab merge.** The round-3 MAJOR is genuinely closed: the 12-kill
  loss is 0, two real tabs converge, unlocks union, run history unions by
  timestamp, and the whole hostile-payload and quota clean list survives the new
  write path — including the two arms the fix report honestly named as
  untested, both of which I ran and both of which pass. The residual (Finding 4)
  is real, narrow, and now characterised rather than mysterious.
- **The time-unit readout.** Confirmed on all three surfaces through the real
  renderers, on both sides of the hour switch, with the non-time rows unchanged.
  The one missed surface (Finding 3) is a one-line change to a currently
  unreachable string.
- **The 38 challenges.** All present, all well-formed, all with a live writer
  behind their tracked field, and the two that most needed the clock and the
  damage accounting to be real — `marathon`, and `untouchable`/`ironclad` — are
  now measured as achievable.

**SPEC: REFUTED** — two of round 4's numbered claims (§1.2's non-linearity and
its "~22 loops per capture", plus §2.3's `reset()` guarantee) fail independent
re-derivation, each with a reproducible counter-measurement.

**QUALITY: NOT READY** — but narrowly, and not for the reasons the round
expected. No player-reachable defect was found in this domain; both MAJORs are a
wrong finding and a latent one. What is not ready is the *record*: this build
would ship, and the report that describes it would mislead the next person who
reads it. On a four-round cap, that is the thing worth spending the last round
saying.
