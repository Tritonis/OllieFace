# Telluric Void — working agreements

## Where work is tracked

**GitHub Issues are the queue and the state. Files are the content.** Repo `Tritonis/OllieFace`.
If `gh` is off PATH (non-interactive shells), invoke `& "C:\Program Files\GitHub CLI\gh.exe"`.

Start at issue **#16** (*Programme state*): its body is the current map (milestones, what each
gates, next human action), its comments are the append-only log of batch closes — post there at
every batch close, rewrite the body only when the map changes. `npm run queue -- triage` prints the
body plus the ready and blocked buckets in one call (`tools/gh-queue.mjs`, #240); the raw
equivalents are `gh issue list --label ready` (agent-actionable) and `--label blocked:user`
(waiting on the user — read it, never guess). A blocked issue always carries `blocked:user` **plus
one** sub-label: `blocked:user:keyboard` (needs a human at a machine) or `blocked:user:decision`
(owes a call); only the second is genuinely stuck.

| Content | Home |
|---|---|
| Anything with an open/closed lifecycle | Issue |
| Implementation plans | `docs/superpowers/plans/` (in git) |
| Briefs, task reports, reviews | `.superpowers/sdd/<slice>/` (gitignored; the controller writes them) |
| A slice's live ledger | `.superpowers/sdd/<slice>/progress.md` — demote at merge, point it at the issues |

- Subagents never call `gh`; they return text, the controller persists it and distils into issues.
- Milestones are gates: empty = the gated action may proceed, unless #16 says the gate is
  disarmed (*Public Launch* is, until the beta zip has shipped). Check by counting issues
  (`gh issue list --milestone "<name>"`), never the milestone's `open_issues` counter — it drifts
  (the closed relay milestone reads open:1 with zero actually open). `[RELEASE BLOCKER]`
  milestones number their issues `[NN]` in the title to fix the order.
- Closing a research issue requires a comment naming its output path (#105).
- Close issues from commit trailers (`Fixes #9`), not by hand.
- Labels: `ready`, `blocked:user` (+`:keyboard`/`:decision`), `deploy-blocker`, `follow-up`,
  `security`, `tracking`, `wontfix`, `carry-forward:p4`, `area:*`.

## Git

Master is pushed normally. Commit style: a single evocative sentence describing what changed in
the world. No `Co-Authored-By:` or generated-with trailers. Branch per slice (`slice/<name>`).

**Merging a lane:** confirm `git rev-parse --abbrev-ref HEAD` is `master` first (a leftover
`Push-Location` turns the merge into a no-op on the lane's own branch); check merge-base (agent
worktrees branch stale); merge `--no-ff -m "<house style> ... Fixes #N"` — a bare `--no-ff`
takes git's default subject and silently fails to close the issue (#50); then re-run gates on
the *integrated* result. Three green branches are not a green master.

## Verification

No CI, deliberately: the gates that matter are Windows/GPU/Steam-bound (#82). Discover what a
diff needs with `node tools/gates.mjs advise [--since <range>]` (recommends, never runs, names
its skips); `npm run gates:status` reports staleness; `--quiet` on any tier prints only verdict
lines on a pass and replays the failing arm in full on a fail.

- `npm run gates:cheap` — per-commit tier: `npm test` + build + audit, ~1 min. The audit arm
  fails on high/critical minus dated `gates.audit-allow.json` entries; an expired `reviewBy` is
  itself a failure.
- `npm run gates:heavy` — `gate:sp` / `gate:mp1` / `gate:elite`, strictly serial, own ports.
- Parallelism: pass `--lane A|B|C` (`gates.mjs`, `sp-equivalence.mjs`); mutually exclusive with
  `--port-base`/`SP_PORT` by design. `tests/probe-ports.test.mjs` enforces unique default ports
  and keeps the lane blocks clear — pick any free port for a new probe and the test objects if
  you chose wrong.
- `npm run probe:coop` — required for any signalling, formation, or connection-lifecycle change.
- `npm run smoke:steam` — needs a running, logged-in Steam client; its impairment settings are
  library-global, so never two at once, never in a lane, excluded from every tier.
- Probe and gate runs are foreground (timeout up to 600000 ms); backgrounding one has zombied.

### Effects showcase — judging by eye and ear (#144)

`src/core/Showcase.js` fires every player-facing effect on demand: all survivor abilities,
all 14 equipment, every item `onHit`/`onKill`/`onDamaged`/`onInterval` hook, every telegraphed
enemy attack, every un-telegraphed attack window (#149), all six elite
modifiers, a pickup per tier, the seven sampled voices (#148) and
the run-level moments, and the four unadopted geometry demos — 212
entries, all derived from the data tables, none typed by hand (`tests/showcase-surface.test.mjs` re-derives the totals and
objects if the list falls behind). Effects fire down their real paths, so audio arrives through
the real `Audio` bus and spends the real voice budget; there is no mixer bypass to find.

Open with **Shift+F9** in dev (`npm run dev`). In a packed build the chunk is deliberately
absent — `build.files` refuses `dist/assets/showcase.js` and `tests/steam-sdk-packaging.test.mjs`
proves it, the same shape as the net-bridge exclusion. To evaluate against the packed artifact:

```
npm run build && npm run desktop:pack && npm run showcase:install
```

Keys: arrows move, Enter fires, Space marks, `g` fires everything marked together at adjacent
offsets, `1`-`9` then `0`, `-`, `=` are curated pile-ups (every `onHit` proc at once, all six
elites side by side, and the four set-level ones #149 added: every nova at one point, all beam
users charging together, the full-horde release, all sixteen attack windows), letters filter. Enemy-attack entries stand a
real unit up and drive it through the real `beginAttack` state machine — ring, held element voice,
per-kind tell and element-cored release — with the evaluator inside a mercy window;
`tests/showcase-enemy-attack.test.mjs` holds that path open. An elite's aura tick is forced through `forceAuraTick`, which
`tests/showcase-elite-tick.test.mjs` holds to landing real damage rather than merely not throwing.

### Capture gate — advisory only (decided 2026-08-20)

`npm run shots` is a manual arm: tracked by `gates:status` (it can go OVERDUE), never invoked by
a tier. It reports subject/separation/margin/audio findings but **never blocks** — only
infrastructure failures (boot never `ready`, a scenario throw, a genuine non-`[harness]`
console/page error, a screenshot that throws) set a non-zero exit. `tools/lib/capture-verdict.mjs`
owns the line; the rationale: eye inspection kept overturning its subject claims.

**Evidence regime:** the gated statistic is non-monotone in framing and unstable across boots
(#122, #114) — determinism is within-session only. A single run's subject numbers never open,
close, or adjudicate an issue; a framing claim needs a within-session A/B at minimum. Record
hand-runs with `node tools/gates.mjs status --record capture --verdict pass|fail` (a recorded
fail renders ADVISORY, not RED).

## Install health

When a local binary "isn't found", `.bin` is nearly empty, or `npm install` aborts, use the
**`install-repair` skill**. Repair the install rather than hand-writing a `.bin` shim — a forged
shim hides the real fault (#83).

## Parallel lanes

Three work items at once, one worktree each via the Agent tool's `isolation: "worktree"`, the
controller merges. The lane is an accounting unit for *ports*, not a directory you manage — the
tool provisions and names worktrees.

| Lane | Port block | Pass as |
|---|---|---|
| A | 5240-5249 | `--lane A`, or `SP_PORT=5240`, `--port 5241`, `--signal-port 5242` |
| B | 5250-5259 | `--lane B`, or `SP_PORT=5250`, `--port 5251`, `--signal-port 5252` |
| C | 5260-5269 | `--lane C`, or `SP_PORT=5260`, `--port 5261`, `--signal-port 5262` |

(Source of truth: `tools/lib/lanes.mjs`.) A brief states its lane; an agent that defaults to
5209 has silently joined whichever lane is already there (#68).

**Worktree hygiene.** Written-to worktrees persist after their agent exits; the controller
sweeps merged worktrees at batch close (28 stale ones once broke vite for everyone — #90). A
lane may junction the main install's `node_modules` for its lifetime, but the junction must be
unlinked (`rmdir` the junction path only) **before** any `git worktree remove` or `git clean` —
git walks a live junction and empties the main install, while plain recursive deletes refuse
(#67, adjudicated). `tests/worktree-hygiene.test.mjs` (in `gates:cheap`) surfaces orphans.

**Never laned:** `smoke:steam` and anything driving the Steam client (one client, library-global
state). Stagger headed GPU capture runs rather than starting three at once.

**Autonomous unattended runs** follow the `parallel-lanes` skill's *Autonomous Mode*:
park-don't-ask (`blocked:user` with the decision written out, branch unmerged, pull the next
ticket), iteration budgets in every brief, serialization constraints in the run plan, state to
issue #16 at every batch close. Launch only against a queue triaged and batch-approved the same
evening.

## Agent skills

`mattpocock-skills` per-repo config: the issue tracker and triage labels map onto the vocabulary
above (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`); domain docs are
`CONTEXT.md` + `docs/adr/` (`docs/agents/domain.md`).
