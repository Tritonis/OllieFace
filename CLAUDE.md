# Telluric Void — working agreements

## Where work is tracked

**GitHub Issues are the queue and the state. Files are the content.** Adopted 2026-08-14 after a
session in which two stale `.md` claims cost real reasoning — the obsolete "never push" rule, and a
handoff line asserting the co-op probe redacts credentials when that redactor exists only on the
parked P4 branch. A wrong issue gets closed; a wrong paragraph just sits there.

Repo is `Tritonis/OllieFace` (private, issues enabled). **`gh` may not be on PATH in non-interactive
shells** — if `gh` is not found, invoke it as `& "C:\Program Files\GitHub CLI\gh.exe"`.

### Start here, not in a handoff file

- `gh issue list` — the queue. Issue **#16** (*Programme state*) is the entry point and supersedes
  `.superpowers/sdd/SESSION-HANDOFF-2026-08-13.md`.
- `gh issue list --label blocked:user` — what is waiting on the user. Never guess at this.
- `gh issue list --label ready` — agent-actionable without a human decision.

### What goes where

| Content | Home | Why |
|---|---|---|
| Anything with an open/closed lifecycle | **Issue** | Carry-forwards, deferred fixes, user checkpoints, deploy prerequisites. |
| Implementation plans | `docs/superpowers/plans/` **in git** | Versioned with the code they describe; in an issue they drift silently. |
| Briefs, task reports, review reports | `.superpowers/sdd/<slice>/` (gitignored) | Evidence and working material. Agents read files deterministically and offline. |
| A slice's live ledger | `.superpowers/sdd/<slice>/progress.md` | Edited dozens of times per slice — cheap on a file, noisy on an issue. **Demote it at merge**: mark it closed, point it at the issues, keep it as the evidence trail. |

Long-form content stays in files for a practical reason: a file can be `Grep`ed and range-`Read`;
an issue body is all-or-nothing, so a 40 KB review in an issue costs context for one paragraph.

### Rules

- **Subagents never call `gh`.** They write report files; the controller distils those into issues at
  task boundaries. This keeps agents offline and deterministic, and keeps issue quality under one editor.
- **Milestones are gates, not folders.** *Public relay exposure* being empty is the precondition for
  exposing the relay — a checkable claim rather than a remembered one.
- Close issues from commit messages (`Fixes #9`) rather than by hand.
- Labels: `blocked:user`, `ready`, `deploy-blocker`, `carry-forward:p4`, `follow-up`, `security`,
  `area:relay`, `area:steam`, `tracking`.

## Git

`master` and `origin/master` are in sync and master is pushed normally. The old "never `git push`,
never `git pull`" rule is **dead** — it dated from a period when master was ~91 commits ahead.

Commit style: a single evocative sentence describing what changed in the world, plus a
`Co-Authored-By:` trailer. Branch per slice (`slice/<name>`), merged locally with `--no-ff`.

## Verification

Two of these are now bundled, so the cheap set is one command rather than a remembered list
(`tools/gates.mjs`, issue #82). There is deliberately **no CI**: the repo is private and the gates
that matter are Windows/GPU/Steam-bound, so a hosted Linux runner could run almost none of them.

- `npm run gates:cheap` — the per-commit tier, fail-fast: `npm test`, a production build,
  `npm audit`. ~1 min. Names the failing arm rather than leaving you with the last tool's stderr.
  The audit arm fails on **high and critical** only, minus dated entries in
  `gates.audit-allow.json` — and an entry whose `reviewBy` has passed is itself a failure.
- `npm run gates:heavy` — `gate:sp`, `gate:mp1`, `gate:elite`, strictly serial, each on its own
  explicit port (5234-5236 by default; `--port-base 5260` for a lane). Two runs sharing a port base
  refuse rather than collide. `smoke:steam` is excluded by construction — it needs a live client
  and sets library-global impairment — so run it by hand.
- `npm run gates:status` — the staleness record alone, runs nothing. Says which gates have not run
  since the last commit that touched their inputs. State lives in the gitignored `.gates/`.
- The **capture gate** (`npm run shots`, `tools/capture.mjs`) is a **manual arm**: tracked in
  `gates:status` — it can read OVERDUE like any other arm — but never invoked by either tier. It is
  the only thing that calls `installHarness` and exercises the separation/margin logic in
  `src/core/Harness.js`, and it is a slow, headed GPU run, so `gates:cheap`/`gates:heavy` must never
  run it by accident. This is a different exclusion shape than `smoke:steam`'s (below): `smoke:steam`
  names no arm at all and so is invisible to the staleness report by design, while the capture gate
  is a full arm marked `manual: true` so it CAN go OVERDUE. Record a hand-run with
  `node tools/gates.mjs status --record capture`.
- `npm test` — the full suite, ~1 minute. Currently **74/74 test files**.
- `npm run smoke:steam` — the Steam socket-pair gate (ADR 0002 arm B), ~35 s. Needs a **running,
  logged-in Steam client**, so it is a local gate and never a CI one. Writes
  `reviews/net-baseline/steam-socketpair-3peer-60hz.json`; the write-up beside it is
  `STEAM-SOCKETPAIR.md`. Its impairment settings are global to the Steam library, so never run
  two at once.
- `npm run probe:coop` — two real browser pages forming a co-op session, several minutes. Defaults to
  ports 5214/5215, overridable with `--port` / `--signal-port`. Required for any change to the
  signalling, formation, or connection-lifecycle path.
- `npm run gate:sp` / `gate:mp1` / `gate:elite` — single-player equivalence baselines, ~2 min each.
  All three run through `tests/sp-equivalence.mjs`, which defaults to port 5209. **To run two at
  once — including from two different worktrees — give each its own port:**
  `npm run gate:sp -- --port 5249`, or `SP_PORT=5249 npm run gate:sp`. The port is internal to the
  gate's own dev server and is not part of any baseline fingerprint, so moving it cannot change a
  result.
- **Probe and gate ports are unique by test, not by convention.** `tests/probe-ports.test.mjs` scans
  every script in `tools/` plus `sp-equivalence.mjs` and fails if two claim the same default. It was
  added after a day on which six separate collisions existed at once and two agents each burned a
  diagnosis cycle reading one as a bug in their own branch. If you add a probe, pick a free port and
  the test will tell you if you did not. A held port now fails at bind with a message naming it,
  rather than surfacing later as `ERR_CONNECTION_REFUSED`.
- Probe and gate runs must be **foreground** (timeout up to 600000 ms). An agent that backgrounds one
  and polls for it has zombied here before.

## Parallel lanes

Default working mode is **three work items at once**, one git worktree each, with the controller
merging. Two writers in one tree nearly collided on master once; isolation is not optional.

Isolation comes from the Agent tool's `isolation: "worktree"`, which provisions a worktree per
dispatch and removes it if unchanged. Do **not** hand-create or hand-name lane worktrees; the lane is
an accounting unit for *ports*, not a directory you manage.

Every lane gets its own port block, assigned in the brief rather than discovered at runtime. Nothing
in `tools/` or `tests/` claims above 5233 (plus `verify-trickle` on 5599), and
`tests/probe-ports.test.mjs` enforces that, so the 5240+ range is free by construction:

| Lane | Port block | Pass as |
|---|---|---|
| A | 5240-5249 | `SP_PORT=5240`, `--port 5241`, `--signal-port 5242` |
| B | 5250-5259 | `SP_PORT=5250`, `--port 5251`, `--signal-port 5252` |
| C | 5260-5269 | `SP_PORT=5260`, `--port 5261`, `--signal-port 5262` |

A brief must state its lane's ports explicitly. An agent that defaults to 5209 has silently joined
whichever other lane is already there.

**Never laned — these serialise across the whole machine:**

- `npm run smoke:steam` — its impairment settings are global to the Steam library, so a second run
  corrupts the first regardless of ports or worktrees.
- Anything driving the Steam client (one logged-in client exists).
- Heavy GPU capture runs are not *forbidden* in parallel, but three headed chromiums contend; stagger
  them rather than starting three at once.

**Gates are now parallel-safe** and were not before `d58366d`: all three run through
`tests/sp-equivalence.mjs`, which takes `--port` / `SP_PORT` and binds strictly. Without a per-lane
port they still collide on 5209, and the loser fails in a way that reads as a bug in its own branch —
that cost two agents a diagnosis cycle each on 2026-08-15 (#68).

**Overnight autonomous runs** follow the `parallel-lanes` skill's *Autonomous Overnight Mode*:
park-don't-ask (label `blocked:user` with the decision written out, leave the branch unmerged, pull
the next ticket), mandatory iteration budgets in every brief, serialization constraints stated in the
run plan, and state persisted to issue #16 at every batch close. Launch only against a queue triaged
and batch-approved the same evening.

**Merging:** check merge-base before merging (an agent worktree has branched 15 commits stale),
`--no-ff`, then re-run the gates on the *integrated* result. Three green branches are not a green
master. One opus review runs across the merged result, not per lane.

**Always merge a lane with an explicit `-m`**, carrying the house commit style and the `Fixes #N`
trailer. A bare `git merge --no-ff` takes git's default subject, which both breaks the style and
silently fails to close the issue — and a pushed merge is not worth rewriting to add a trailer, so
the issue then has to be closed by hand. Happened on 2026-08-15 with #50.

**Watch the shell's working directory when merging.** A `Push-Location` into a worktree that outlives
its block leaves `git merge` running with HEAD on the lane's own branch, where it reports "Already up
to date" and does nothing. Confirm `git rev-parse --abbrev-ref HEAD` is `master` before merging.

## Agent skills

Per-repo configuration for the `mattpocock-skills` engineering skills.

### Issue tracker

GitHub Issues on `Tritonis/OllieFace`, via `gh` — consistent with *Where work is tracked* above.
See `docs/agents/issue-tracker.md`.

### Triage labels

Mapped onto this repo's existing vocabulary (`ready`, `blocked:user`, `wontfix`) rather than
duplicating it. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, both created lazily.
See `docs/agents/domain.md`.
