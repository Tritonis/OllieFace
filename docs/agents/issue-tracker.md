# Issue tracker: GitHub

Issues and specs live as GitHub issues on `Tritonis/OllieFace` (private). Same rule as *Where work
is tracked* in the root `CLAUDE.md`: **issues are the queue and the state, files are the content.**

## Invoking `gh`

`gh` is off PATH in non-interactive shells: `& "C:\Program Files\GitHub CLI\gh.exe"`. The repo is
inferred from `git remote -v`.

**Only the controller calls `gh`.** Subagents return findings as text; the controller distils them
into issue comments, labels and closes. This keeps agents offline and issue quality under one editor.

## Entry point and the queue wrapper

Issue **#16** (*Programme state*) is the entry point: its body is the current map (milestones, what
each gates, the next human action); its comments are the append-only log of batch closes.

For routine bookkeeping prefer `npm run queue -- triage | view <n> | park <n> | close-batch`
(`tools/gh-queue.mjs`, #240) — one compact call each, no `jq`. Raw `gh` is for everything else:

- Create: `gh issue create --title "..." --body "..." [--milestone "..."] [--label ...]`
  (heredoc for multi-line bodies; no backticks inside a bash heredoc).
- Read: `gh issue view <n> --json title,body,labels,milestone,comments`.
- Comment / label: `gh issue comment <n> --body "..."`; `gh issue edit <n> --add-label / --remove-label`.
- Close: from a commit trailer (`Fixes #n`) by preference; `gh issue close <n> --comment "..."`
  otherwise. A research issue's close comment names its output path (#105).

## Labels

Triage roles map to labels in `triage-labels.md`. The blocked convention: every blocked issue carries
**`blocked:user` plus exactly one of `blocked:user:keyboard` / `blocked:user:decision`**. Milestones
are listed in `CLAUDE.md`; a `[RELEASE BLOCKER]` milestone's issues are numbered `[NN]` in the
title to fix their order.

## Milestones

Milestones are **gates, not folders**: an empty milestone is the precondition for the thing it gates.
Count with `gh issue list --milestone "<name>"`, never the `open_issues` counter. Two gates are
currently *disarmed* by decision and say so in #16: *Public Launch* (seed it before arming) and the
two closed relay-era milestones.

## Skills

"Publish to the issue tracker" = create an issue. "Fetch the relevant ticket" =
`gh issue view <n> --comments`. PRs are not a triage surface in this repo.
