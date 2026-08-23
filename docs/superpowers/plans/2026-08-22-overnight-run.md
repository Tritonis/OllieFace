# Overnight run plan — 2026-08-22

Approved by the user this evening (pre-flight answers are also on the issues).
Launch prompt: `/loop /parallel-lanes work this run plan (docs/superpowers/plans/2026-08-22-overnight-run.md)`.

## Preconditions (verify before batch 1)

- The #155/#157 lane (jury headroom + thermal-lance flavour) has merged and pushed;
  if it is still open, land it first — it touches Showcase.js/Audio.js, which batch 1
  lane A/B surfaces neighbour.
- `gates:heavy` green on master (run this evening; if any arm failed, that fix IS
  batch 0 and everything below waits).
- Ready queue at launch: #152, #154, #130 (+#155/#157 if not yet landed).

## Batch 1 — #152 Wave 2 (three lanes, approved split)

- **Lane A (ports 5240-5249):** run-level moments, EFFECT-LANGUAGE §4.4 — statusApplied
  per-status element voices, playerDowned (descending figure + collapsing ring + held
  body marker), playerRevived (own voice, not heal()'s ladder), coin (fixed amber coin
  hue, NOT tier-coloured), bossHorn (world event, heavy, from spawn point).
- **Lane B (ports 5250-5259):** the 13 named-promise bespoke items, §4.2 second bullet +
  C5/healPop resolutions. The seven G1 entries must separate from neighbours on a
  non-timbre dimension (Degraded Point; real samples landed in #148).
- **Lane C (ports 5260-5269):** co-op X1-X3 per-class shape signatures, §3.1 + §1.2
  polarity. `npm run probe:coop` required (net-adjacent). Lands implementation + probe
  evidence; the co-op EYE check is parked `blocked:user:keyboard` on #152's back.

House rules from batch 1 of 2026-08-22 (they earned their keep): per-lane sonnet
verifiers attacking the premise; ONE scoped re-review per fix wave across all lanes
(label `re-review batch-N wave-M`, check for an existing label first); ONE opus
integration review on the merged result; bucketing re-run (`tools/bucket-effects.mjs
--check`) and the reserved-hue assert are load-bearing; red-then-green mandatory;
sustained voices via startSustained with release proven on ALL exits (death, despawn,
downed, close) — this failed twice today, brief it explicitly.

## Batch 2 — two small lanes

- **#154 (executor):** argent/purity legibility — warded-progress feedback (world VFX
  and/or a NEW HUD element, both approved), mote-source telegraphy (Voidtouched kills,
  Argent Font), visible dead-state for grace-zeroed items, Sanctuary/Consecrate
  presentation. Mint-green restorative family (legal: feedback, not damage).
- **#130 (mech-executor):** item 1 = document shipping desktop/net-bridge-renderer.cjs
  in desktop/README.md (decided — do NOT exclude); item 2 = per-hook telemetry
  isolation off the global `broken` latch; item 3 = Menus-throw test at the
  Engine.remove() path.

## Serialization / constraints

- No Steam-touching work anywhere (no smoke:steam, nothing driving the client).
- probe:coop per-lane on the lane's own port block only.
- No headed GPU capture runs.
- Worktree hygiene: junction main node_modules; unlink the junction (rmdir the
  junction path only) before any worktree remove; controller sweeps at batch close.

## End conditions

Stop when: both batches are exhausted, or two consecutive batches end fully parked.
On stop: push everything merged, sweep worktrees, post the return summary to #16.
Park-don't-ask throughout: Critical/Major needing adjudication or a design fork →
`blocked:user` with the decision written out, branch left unmerged, next ticket.
