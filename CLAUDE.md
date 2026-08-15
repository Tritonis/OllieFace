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

- `npm test` — the full suite, ~1 minute. Currently **59/59 test files**.
- `npm run probe:coop` — two real browser pages forming a co-op session, several minutes. **Binds
  fixed ports 5214/5215**, so never run two at once. Required for any change to the signalling,
  formation, or connection-lifecycle path.
- `npm run gate:sp` / `gate:mp1` — single-player equivalence baselines, ~2 min each.
- Probe and gate runs must be **foreground** (timeout up to 600000 ms). An agent that backgrounds one
  and polls for it has zombied here before.
