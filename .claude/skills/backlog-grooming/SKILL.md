---
name: backlog-grooming
description: Use when asked to groom, triage, clean up, or prune the issue backlog — closing stale tickets or labeling agent-actionable ones ready.
---

# Backlog Grooming

Sweep the open queue: close tickets whose premise no longer holds, label `ready` the ones an agent could work today, leave the rest with their state written down.

**Core principle: a disposition is a claim about the code, not about the ticket.** The ticket body describes the world at filing time; only master describes it now. No CLOSE and no READY without fresh evidence from the current tree — a grooming pass that never opens a file is grading fiction.

## Process

1. **Pull the queue.** `gh issue list --state open` with full bodies (`gh` at `C:\Program Files\GitHub CLI\gh.exe` off PATH). Count issues yourself; never trust milestone counters. Subagents never call `gh` — you read bodies and pass them verbatim in briefs.
2. **Short-circuit the untouchables.** These are LEAVE before any verification is spent:
   - `blocked:user` (either subtype) — waiting on a human; never closed, never `ready`. If the written-out decision is missing from the body, add it.
   - `tracking` tickets and known-limitation records — they document, they don't queue work. A record is stale only when the limitation itself is gone from master.
   - Anything gated on Steam, a keyboard sitting, or human eyes/ears — actionable by definition only when the human is.
3. **Verify every remaining ticket against master.** One scout per ticket (batch them in parallel): "is this premise still true on the current tree, and what is the file surface?" — issue body passed verbatim, `file:line` evidence required back. A ticket's own repro claim is a claim, not evidence.
4. **Disposition from the evidence.** Staleness is a property of the premise, never of the date — an old, quiet, vague ticket that describes a still-real defect stays open (label it needs-repro territory, don't bury it):
   - CLOSE: premise refuted on master (cite `file:line`), already fixed (cite the commit), superseded by a shipped decision (name it, and first check nothing cites the ticket as its record), or duplicate (name the survivor).
   - READY: premise verified true + no design decision owed + no human gate + a scoutable file surface. All four, or it isn't `ready`.
   - PARK: real work that owes a call → `blocked:user:decision` with the exact question and evidence written into the body.
5. **Act and report.** Every close carries an evidence comment; a research ticket's close comment must name its output path (#105). Then a table: ticket, disposition, one-line evidence.

## Rationalizations

| Excuse | Reality |
|---|---|
| "The body is detailed enough to judge from" | The body dates from filing. The 0-tool-call groomer marked a fixed bug `ready`. |
| "It's months old with no traction — stale" | Age is neglect, not staleness. The defect may be alive and patient. |
| "CLAUDE.md answers this, close it" | A decision may have *made the ticket its record*. Check inbound references first. |
| "Verifying every ticket is overkill" | Scouts are the cheapest seat in the fleet. A wrong close loses the only written copy of a known bug. |

## Red flags — stop, you're about to mis-groom

- A CLOSE or READY with no scout evidence behind it
- "stale" justified by a date
- Closing anything labeled `blocked:user` or `tracking`
- `ready` on a ticket that contains an unanswered "decide whether…"
