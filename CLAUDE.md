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

- `npm test` — the full suite, ~1 minute. Currently **67/67 test files**.
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
