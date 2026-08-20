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
| Briefs, task reports, review reports | `.superpowers/sdd/<slice>/` (gitignored) | Evidence and working material. The controller writes them (subagent returns are text-only); agents read files deterministically and offline. |
| A slice's live ledger | `.superpowers/sdd/<slice>/progress.md` | Edited dozens of times per slice — cheap on a file, noisy on an issue. **Demote it at merge**: mark it closed, point it at the issues, keep it as the evidence trail. |

Long-form content stays in files for a practical reason: a file can be `Grep`ed and range-`Read`;
an issue body is all-or-nothing, so a 40 KB review in an issue costs context for one paragraph.

### Rules

- **Subagents never call `gh`.** They return findings as text (the Agent tool refuses subagent-written
  report files); the controller persists what must outlive the turn and distils it into issues at
  task boundaries. This keeps agents offline and deterministic, and keeps issue quality under one editor.
- **Milestones are gates, not folders.** *Public relay exposure* being empty is the precondition for
  exposing the relay — a checkable claim rather than a remembered one.
- **Closing a research issue requires a comment naming its output path.** A search or research
  ticket's deliverable is a file, and the issue is the only index anyone searches. #105 closed with
  no comment and its shortlist in a non-conventional directory, and the file was unfindable until
  someone asked for it by hand — the file was never lost, the pointer was never written. An audit of
  the sibling `asset-search` issues (#21-#25, #66) found every other one correct, so this is a rule
  against a known lapse rather than a pattern.
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
- `--quiet` (alias `--summary`) on either tier: a **passing** run prints only the arm verdicts and
  their timings — six lines instead of several thousand, since the vite chunk manifest and `npm
  test`'s per-file lines say nothing when the verdict is PASS. A **failing** run is untouched: the
  failing arm's stdout and stderr are replayed in full under the same header, above the same
  `FAILING ARM` block. `npm test -- --quiet` does the same for the suite on its own.
- `node tools/gates.mjs advise [--since <range>]` — reads the working-tree diff (or a commit range)
  and says which arms its inputs are in, **and which it is skipping with the reason**. It recommends
  and never runs. A skip prints its reason because a silent skip reads as coverage.
- `--lane A|B|C` on `tools/gates.mjs` and `tests/sp-equivalence.mjs` derives the whole port block
  from one flag (the table below), so a brief says "you are lane B" once instead of restating three
  numbers per command. `--lane` and `--port-base`/`SP_PORT` are **mutually exclusive** and error
  rather than letting flag order silently pick — the heavy-tier lock is keyed by port base, so two
  runs that both believe they are lane B must land on the same base or the lock stops locking.
- `npm run gates:status` — the staleness record alone, runs nothing. Says which gates have not run
  since the last commit that touched their inputs. State lives in the gitignored `.gates/`.
- The **capture gate** (`npm run shots`, `tools/capture.mjs`) is a **manual arm**: tracked in
  `gates:status` — it can read OVERDUE like any other arm — but never invoked by either tier. It is
  the only thing that exercises the separation/margin logic in `src/core/Harness.js` (other things
  call `installHarness` itself — `gate:sp`/`gate:mp1`/`gate:elite` boot with `?harness=1`, and so does
  `tools/verify-trickle.mjs` — but none of them measure separation/margin), and it is a slow, headed
  GPU run, so `gates:cheap`/`gates:heavy` must never
  run it by accident. This is a different exclusion shape than `smoke:steam`'s (below): `smoke:steam`
  names no arm at all and so is invisible to the staleness report by design, while the capture gate
  is a full arm marked `manual: true` so it CAN go OVERDUE. Record a hand-run with
  `node tools/gates.mjs status --record capture`.

  **Decided 2026-08-20: the capture gate is advisory only.** It reports; it never blocks a commit, a
  merge or a deploy. A day was spent making it gate work, and the only substantive thing it ever
  caught by doing so was an enemy model obscured by a spell effect — inspected by eye, its
  subject/separation/margin findings read as effects obscuring models, not defects, and a gate is not
  worth the friction of blocking on a claim that inspection this often overturns. `tools/capture.mjs`
  now draws an explicit line (see `tools/lib/capture-verdict.mjs`, the module that owns it): a
  legibility, separation, margin or stage-placement judgement — `subjectFailures`, the harness's own
  `[harness]`-prefixed diagnostics, a failed `audioOk` — is reported prominently but never sets a
  non-zero exit code. **Infrastructure failures still fail the run**: a boot that never reaches
  `ready`, a scenario that throws (navigation or shot timeout, a page crash), or a genuine
  (non-`[harness]`) console or page error. A black or missing screenshot falls under that last
  bucket — `page.screenshot()` throws on a hung page rather than silently writing nothing — so it is
  still never mistaken for an art problem. `gates:status` renders a recorded capture `fail` as
  `ADVISORY` rather than `RED` for the same reason; recording still requires a stated `pass|fail`
  verdict (`--verdict`), because honest recording still matters even though nothing blocks on it.
- `npm test` — the full suite, ~1 minute.
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

## Install health

**Never hand-write a `node_modules/.bin` shim** — npm's are ~14 lines with a `find_dp0` preamble; a
two-line forgery hides the real fault. When a local binary "isn't found", `.bin` is nearly empty, or
`npm install` aborts (koffi/CMake, EBUSY on a zombie Electron), use the **`install-repair` skill**.

## Parallel lanes

Default working mode is **three work items at once**, one git worktree each, with the controller
merging. Two writers in one tree nearly collided on master once; isolation is not optional.

Isolation comes from the Agent tool's `isolation: "worktree"`, which provisions a worktree per
dispatch and removes it if unchanged. Do **not** hand-create or hand-name lane worktrees; the lane is
an accounting unit for *ports*, not a directory you manage.

**Worktree hygiene.** The Agent tool's auto-cleanup only removes a worktree that ended up *unchanged*
— any lane that actually wrote something persists after its agent exits, so `.claude/worktrees/`
accumulates across a session unless something sweeps it. 28 stale worktrees once did exactly this and
made vite serve a single CSS file in 79.9s, which blew `npm run shots`'s goto timeout 3/3 (issue #90).
**The controller sweeps merged worktrees at batch close** rather than leaving that to auto-cleanup.
A worktree given a junction into the main install's `node_modules` (per-lane setup a brief may
specify) must have that junction **unlinked before the worktree itself is removed** — `rmdir` the
junction path only, and never tear down the worktree while the junction is still live.

**The dangerous actor is `git`, not your recursive delete** — corrected 2026-08-17 against the
earlier claim here, by direct experiment recorded in #67. With a junction inside a *registered*
worktree, `git worktree remove --force` and `git clean -xfd` both **walk the junction and empty the
main tree's packages**; PowerShell `-Recurse`, `rm -rf` and `fs.rmSync` all refuse to walk it and
leave the target intact. The junction's top directory survives while its contents do not, which is
exactly the observed signature — `node_modules` at zero directories with `node_modules` itself still
present. So the rule is not "avoid recursive deletes", it is **check for a live reparse point before
any `git worktree remove` or `git clean`**, which is what the controller's sweep now does. Best
explanation on record for #67 and #83; a specific historical incident has not been tied to a specific
invocation, since no shell history is retained.
**Decision (adjudicated):** junctions into the main install are permitted for a lane's lifetime; they
must be unlinked before the worktree is removed; `tests/worktree-hygiene.test.mjs` (part of
`gates:cheap`) makes an orphaned one — a junction left behind in a directory that is no longer a
registered git worktree — loudly visible instead of silently accumulating.

Every lane gets its own port block, assigned in the brief rather than discovered at runtime. The
shipped defaults sit at 5233 and below, plus `gates.mjs`'s heavy tier on 5234-5236 and
`tools/verify-trickle.mjs` on 5599, which leaves 5240-5269 free for lanes:

| Lane | Port block | Pass as |
|---|---|---|
| A | 5240-5249 | `SP_PORT=5240`, `--port 5241`, `--signal-port 5242` |
| B | 5250-5259 | `SP_PORT=5250`, `--port 5251`, `--signal-port 5252` |
| C | 5260-5269 | `SP_PORT=5260`, `--port 5261`, `--signal-port 5262` |

The table is also *data*, in `tools/lib/lanes.mjs`, which `tools/gates.mjs`, `tests/sp-equivalence.mjs`
and `tests/probe-ports.test.mjs` all import rather than restating the numbers.

**What the test actually enforces**, stated exactly, because a looser summary of it stood here for a
while and was believed:

- No two scanned scripts claim the same default port.
- No scanned script's default port falls **inside a lane block** (5240-5269).

It does **not** enforce "nothing claims above 5236" — that sentence used to appear here and was never
true (`verify-trickle` is on 5599, in the same breath that named it). A probe on 5300 passes, and
should: it collides with nothing. The scan covers every `.mjs` under `tools/` recursively, plus
`tests/sp-equivalence.mjs`, and it counts a port wherever an identifier or object key **named** port
is bound to a literal — `const PORT = N`, `{ port: N }`, `Number(x ?? N)`, `Number(x || N)`,
`num('port', N)`. `lanes.mjs` itself contributes nothing because its keys are lane names, not port
names; a genuine bind written there would still be caught.

Do not treat the free range as free by assertion — it is free because the test can go red, and it
has: `tools/panel-ground.mjs` sat on 5251 inside lane B when this check was first written, and moved
to 5227.

A brief must state its lane's ports explicitly, or pass `--lane`. An agent that defaults to 5209 has silently joined
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

**Autonomous unattended runs** (overnight or any window away) follow the `parallel-lanes` skill's
*Autonomous Mode*:
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
