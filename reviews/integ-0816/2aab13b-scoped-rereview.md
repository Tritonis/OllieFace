# Scoped re-review — commit 2aab13b (diff 7c90744..2aab13b)

Files: `tests/audio-gate-window.test.mjs`, `tests/a11y-announce.test.mjs`, `src/ui/Announcer.js`.
Verifying three adjudicated fixes from `reviews/integ-0816/batch4-integration-review.md`.

## Verdict

**SPEC: CONFIRMED** — items 1 and 3 independently reproduced exactly as claimed. Item 2 (the
`sampled >= 80` truncation arm) does not do what its framing implies: it exercises an invented
local formula, not one derived from `tools/capture.mjs`'s actual sampling mechanism.

**QUALITY: READY** — no Critical/Major. One Minor (residual, carried over from the prior review's
m3, not newly introduced).

**COUNTS: 0 Critical, 0 Major, 1 Minor.**

---

## 1. Settle guard reads capture.mjs's own combining expression — CONFIRMED

`tests/audio-gate-window.test.mjs:87-107` extracts `GATE_SETTLE_S`'s RHS text via regex
(`readCaptureSettleExpr`) and evaluates it with `new Function` against the four independently
`captureNum()`-extracted constants (`tests/audio-gate-window.test.mjs:98-106`).

Reproduced myself in an isolated git worktree + scratch copy (repo untouched throughout):

- **Baseline**: 17/17, exit 0.
- **Drop `1 +`** (`GATE_BAR_S * (1 + RAMP_BARS) + SETTLE_MARGIN_S` → `GATE_BAR_S * RAMP_BARS + SETTLE_MARGIN_S`):
  15/17, exit 1. `FAIL settle 1.167s (capture.mjs's own expression) >= worst-case silence 3.051s` —
  names the exact shortfall, not a generic failure.
- **Rename the anchor** (`GATE_SETTLE_S` → `GATE_SETTLE`, regex loses its match): `settleExprText`
  comes back `null`, and the script throws `TypeError: Cannot read properties of null (reading
  'toFixed')` at line 119, exit 1. Fails closed and loudly — not a silent pass.
- **Syntax-broken RHS** (regex still matches, but the captured text is not valid JS —
  `RAMP_BARS +/ SETTLE_MARGIN_S`): `new Function` throws `SyntaxError: Invalid regular expression:
  missing /` at construction, exit 1. Confirms `new Function` cannot mask a syntax-broken RHS as a
  pass — it throws rather than silently returning `NaN` or similar.

All four cases behave as claimed. This closes the batch4 MAJOR.

## 2. `sampled >= 80` truncation arm — RESIDUAL, not a genuine derivation

`tests/audio-gate-window.test.mjs:150-171` adds a synthetic block, but it does not read the
predicate or its inputs from `tools/capture.mjs` text:

- `GATE_MAX_FRAMES = 3000` (line 158) is a **hand-typed literal**, not extracted via `captureNum()`
  — even though `tools/capture.mjs:731` happens to declare the same value today, nothing ties them.
- The `80` threshold (line 166, 169-170) is likewise hand-typed. It cannot be extracted the way the
  settle constants are, because `tools/capture.mjs:878` writes it inline (`sampled: A.samples >=
  80`) rather than as a named constant — but the test doesn't attempt to read that line's text
  either; it just restates the number.
- The `samplesFromGateFrames(gateFrames, settleFrames)` formula (line 162-163,
  `Math.max(0, Math.min(gateFrames, GATE_MAX_FRAMES) - settleFrames)`) does not correspond to how
  `tools/capture.mjs` actually derives `A.samples`. In the real code (`tools/capture.mjs:788-799`),
  `samples` is an audio-clock-gated `setInterval` tick counter (`ac.currentTime >=
  state.settleUntil`), not a frame-count subtraction. There is no `settleFrames` variable anywhere
  in `tools/capture.mjs`.

So this block proves only that its own invented arithmetic can produce a value under 80 — it is
internally self-consistent, not a demonstration that capture.mjs's real truncation path can fail.
This is the same gap the original review's **m3** flagged ("asserted in comment only... unproven"),
restated as a passing test rather than actually closed. Judged **Minor**, same severity class as
the finding it was meant to resolve — it does not introduce a new false-negative risk in the real
gate, but the fix's own file-header framing ("the second half feeds the same comparison... a
synthetic Music.js" — describing only the settle drift block) does not claim to have fixed this
arm, so this is not a broken promise, just an unclosed gap worth naming.

## 3. Announcer.update clears a standing caption on toggle-alone — CONFIRMED

`src/ui/Announcer.js:114-123` (new): `update(dt)` now checks `!this.captionsOn` before the hold
countdown and clears immediately if so. `tests/a11y-announce.test.mjs:264-269` toggles
`ctx.settings.captions = 0` with **no further event emitted**, calls `on.a.update(0.016)` directly,
and asserts the caption is cleared.

Reproduced in an isolated git worktree (junctioned `node_modules` from the main repo, main repo
never touched):

- Baseline: `node tests/a11y-announce.test.mjs` → 44 passed, 0 failed.
- Mutated `src/ui/Announcer.js:114-123` to delete the new `if (!this.captionsOn) {...}` block
  (leaving the old countdown-only behaviour) → 43 passed, **1 failed**:
  `FAIL turning captions off alone clears a standing caption on the next update tick`. Every other
  assertion in the 44-check file stayed green — the mutation is caught precisely by the assertion
  meant to catch it, not by collateral breakage elsewhere.
- Worktree destroyed (`git worktree remove --force`); `git status --porcelain` on the main repo
  shows only pre-existing untracked dirs (`.claude/`, `.superpowers/`, `reviews/...`) — no
  modification to any tracked file. `git diff --stat` on the main tree is empty.

## `npm test` at HEAD — inconclusive, environmental, not a diff defect

Both target files individually pass at HEAD, run directly against the real repo tree earlier in
this session, before any worktree/scratch activity: `audio-gate-window.test.mjs` 17/17 exit 0;
`a11y-announce.test.mjs` 44/44 exit 0 (see the isolated-worktree baseline above too, which matches).
`git diff 7c90744..2aab13b --stat` confirms the diff touches exactly the three named files (10/+,
7/+2-, 64/+2- lines) — nothing else.

A full `npm test` run attempted afterward failed 54/82 files with `ERR_MODULE_NOT_FOUND: Cannot
find package 'three'` — `node_modules` was found completely empty (0 entries) at that point, with 5
concurrent `node.exe` processes running and 3 other active `.claude/worktrees/agent-*` branches
present (`git worktree list`), consistent with a concurrent lane in this shared session mid-reinstall
of `node_modules`, not with anything introduced by this diff or by this review's reproductions (all
of which ran in isolated worktrees/scratch copies with only a read-only junction to the shared
`node_modules`). Could not re-confirm 82/82 as a result — flagging per instructions rather than
skipping, but this is an infrastructure/timing issue orthogonal to the three files under review, not
a finding against the diff.

---

## Commands run

```
git log --oneline -5 ; git show --stat 2aab13b
node tests/audio-gate-window.test.mjs            # 17/17, exit 0 (real repo, pre-contention)
node tests/a11y-announce.test.mjs                # 44/44, exit 0 (real repo, pre-contention)
git diff 7c90744..2aab13b -- tests/a11y-announce.test.mjs
sed -n '700,730p;870,885p' tools/capture.mjs
grep -n "GATE_MAX_FRAMES|gateFrames|A\.samples|samples\+\+|settleFrames" tools/capture.mjs
# settle-guard sabotage, isolated scratch copy (tests/, src/systems/, tools/ only):
#   baseline 17/17 -> drop "1 +": 15/17 exit 1, names shortfall
#   -> rename GATE_SETTLE_S anchor: TypeError, exit 1 (fail-closed)
#   -> syntax-broken RHS: SyntaxError from new Function, exit 1 (fail-closed)
git worktree add --detach <scratch>/wt-verify HEAD
# junction node_modules -> real repo node_modules (read-only reuse, not a copy)
node <wt-verify>/tests/a11y-announce.test.mjs    # 44/44 baseline in isolated worktree
# mutate Announcer.js:114-123 (delete the new toggle-alone clearing block) in the worktree only
node <wt-verify>/tests/a11y-announce.test.mjs    # 43/44, FAIL on the expected assertion
git worktree remove --force <scratch>/wt-verify
git status --porcelain ; git diff --stat          # clean, main repo untouched
npm test                                          # 28/82 files passed; 54 x ERR_MODULE_NOT_FOUND
                                                   #   'three' — node_modules found empty (0 entries),
                                                   #   5 concurrent node.exe, 3 other active worktree
                                                   #   agents present — environmental, not diff-caused
```

No `gh` calls, no push, no GPU. No repository file was left modified; all mutation testing ran in a
disposable git worktree destroyed before this review was written.
