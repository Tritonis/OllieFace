# The ICE quiet-period exit — tried, refuted by measurement, reverted

**Date:** 2026-08-07 · **Files:** `src/net/Transport.js` (`waitForIce`),
`tests/ice-quiescence.test.mjs` · **Verdict: the 4 s cap stays.**

## The hypothesis, and why it was plausible

Every join crosses `waitForIce` twice (invite and answer), and gathering only
reads `complete` when every STUN query settles. Across 12 real four-player
joins (4 probe runs, all successful) join time was bimodal: 0.6–1.2 s in half,
3.3–10.9 s in the other half — consistent with zero, one, or both sides eating
the 4 s cap. Hypothesis: resolve early once candidates go quiet (600 ms with no
new candidate), keeping the cap as backstop. Implemented behind
`waitForIce(pc, {capMs, quiesceMs})`, unit-tested 10/10.

## The measurement that killed it

Two four-player probe arms (`--players 4 --netlag 60`) on the changed tree:

| | Before (cap-only) | After (quiet-exit) |
|---|---|---|
| Arms passing | **4 / 4** | **0 / 2** |
| Join times | 0.57–10.9 s | 10.2–14.4 s, then a 45 s timeout |
| Failure | none | `host never spawned a pawn for this peer`, both arms |

Captures: `after-ice-1.FAILED.json`, `after-ice-2.FAILED.json` (this directory).

## Why it failed — the mechanism

Chromium publishes host candidates as anonymized mDNS `.local` names. A peer
that cannot resolve them needs the server-reflexive (STUN) candidate — which
arrives 1–3 s in, and is effectively the *last* thing gathering produces. A
600 ms quiet window after the first host-candidate burst ships a blob whose
only usable route hasn't been gathered yet. The connection then fails and the
join path churns retries: the third joiner in the first failed arm carries
`myNetId: 33` — roughly thirty peer objects burned before the arm timed out.
So the "optimization" made the common case *slower* (10–14 s vs 0.6–1.2 s) and
the failure case *certain* (2 of 2).

The cap is not slack to be clawed back; it is the floor at which a non-trickle
blob can be trusted. A comment at the site now says so and points here, and the
test file's REGRESSION GATE case fails if a quiet-period exit is reintroduced.

## What the failed captures bought anyway

`after-ice-1.FAILED.json` is the first capture of the historical silent join
failure with full host/client state (the round-8 probe fix added it; the old
FAILED capture had none). Two real findings for whoever next works this area:

1. **A join that grinds long enough kills the host.** The game runs while
   invites are negotiated; in the failed arm the unattended host's survivor
   died (`menuScreen: "death"`, `paused: true`, `playerAlive: false`,
   8 enemies alive at `ctxTime` 39 s). A joiner arriving at a host that is on
   its death screen never gets a pawn — the exact terminal state the probe
   reports. Slow joins and the death screen compound: the fix for one hides in
   the other's shadow.
2. **The probe's per-join success predicate has a gap.** Player 2's join
   resolved as complete at 10.2 s with `hostPawnCount` still 1 — it was
   counted joined while pawnless, and later read `disconnected` while the
   probe attributed the failure to player 3 (whose peer, id 3, was in fact
   connected with a pawn and open channels). Join-stage waits should key on
   the specific peer's pawn, not a global count.

## Status of the underlying complaint

The bimodal 0.6–10.9 s join spread is real, still open, and now has a named
cause candidate (STUN settle time under non-trickle gathering) plus two fresh
findings above. The honest next step is not another heuristic on this wait —
it is either trickle ICE over the room-code signalling path (Path B in
`docs/MULTIPLAYER.md`, where a relay exists to carry late candidates), or
accepting the cap for the copy-paste path, which a human is staring at anyway.
