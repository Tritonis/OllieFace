# Domain Docs

How the engineering skills consume this repo's domain documentation. Single-context repo.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary. It says what terms mean, never how anything is
  built.
- **`docs/adr/`** — architecture decision records. Read the ones touching the area you are about to
  work in.

Older design documents that predate the glossary and still carry weight: the root `CONTRACTS.md`,
`NETCODE.md`, `RUBRIC.md`, `ART-ASSETS.md` (its 2026-08-01 addendum overturns its top half — read
bottom-up), and the versioned plans under `docs/superpowers/plans/`. Where they disagree with
`CONTEXT.md` or an ADR, the newer document wins and the conflict is worth surfacing.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use
the term as defined in `CONTEXT.md` and avoid the synonyms it lists under _Avoid_. A concept the
glossary lacks is a signal: either you are inventing language the project does not use, or there is
a real gap to record via `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, say so explicitly rather than silently overriding:

> _Contradicts ADR-0001 (Steam transport over relay credential) — but worth reopening because…_
