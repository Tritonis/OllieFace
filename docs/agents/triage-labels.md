# Triage Labels

The skills speak in terms of five canonical triage roles; this maps them onto the repo's labels.
Three roles map onto labels that existed before the skills arrived — use those, never same-meaning
duplicates.

| Role in mattpocock/skills | Label here | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue (created on first use) |
| `needs-info` | `needs-info` | Waiting on reporter for more information (created on first use) |
| `ready-for-agent` | `ready` | Agent-actionable without a human decision |
| `ready-for-human` | `blocked:user` **+** `blocked:user:keyboard` or `blocked:user:decision` | Needs a human: at a machine (scheduling) vs owing a call (stuck) |
| `wontfix` | `wontfix` | Will not be actioned |

`blocked:user` is always paired with exactly one sub-label; the parent is what generic tooling
matches, the sub-label is what the human reads. Only `:decision` is genuinely stuck.

## Other labels

`deploy-blocker`, `follow-up`, `security`, `tracking`, `carry-forward:p4`, `asset-search`, and the
`area:*` family (`relay`, `steam`, `art`, `design`, `eng`, `ux`). GitHub's defaults (`bug`,
`enhancement`, `duplicate`, …) are used as-is where they fit.
