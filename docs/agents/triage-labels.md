# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's issue tracker.

This repo already had a label vocabulary before the skills arrived, so three of the five roles map
onto existing labels rather than creating duplicates.

| Label in mattpocock/skills | Label in our tracker | Meaning                                                     |
| -------------------------- | -------------------- | ----------------------------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue                      |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information                     |
| `ready-for-agent`          | `ready`              | Agent-actionable without a human decision                    |
| `ready-for-human`          | `blocked:user`       | Needs a human: a decision, a second machine, or credentials  |
| `wontfix`                  | `wontfix`            | Will not be actioned                                         |

`needs-triage` and `needs-info` do **not** exist in the repo yet — they will be created on first
use. `ready`, `blocked:user`, and `wontfix` already exist; use them as-is and do not create
same-meaning duplicates.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from the right-hand column.

## Other labels in this repo

Not triage roles, but part of the same vocabulary — apply them alongside:

`deploy-blocker`, `carry-forward:p4`, `follow-up`, `security`, `tracking`, `asset-search`, and the
`area:*` family (`area:relay`, `area:steam`, `area:art`, `area:design`, `area:eng`, `area:ux`).

Edit the right-hand column to match whatever vocabulary you actually use.
