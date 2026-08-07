# Probe join predicate: per-peer pawn, not a global count

**File changed:** `reviews/round8/probe-targeting.mjs` (only). Not committed.

## The defect

`reviews/audit-fixes/after-ice-1.FAILED.json`, analysed in
`reviews/audit-fixes/ice-quiescence-refuted.md` §"What the failed captures
bought anyway" (finding 2):

- The join-stage wait was
  `(n) => (ctx.coop?.pawns?.length ?? 0) >= n` with `n = k`, the loop index.
- Player 2's join therefore resolved as complete at 10.2 s while
  `hostPawnCount` was still 1 — the one pawn the count saw belonged to peer 1,
  and player 2's own peer id was absent from the host's client table entirely.
- The arm then attributed the eventual failure to player 3, whose peer (id 3)
  was in fact connected, pawned, `helloSeen`, with both channels `open`.

Both halves of that report were wrong, and a global count cannot be right about
this by construction: it is one number standing in for N independent joins, and
it is satisfiable by somebody else's pawn.

## What the predicate keys on now

This peer's own entry in the host's client table:

```js
for (const c of net?.clients?.values?.() ?? []) {
  if ((c.peer?.id ?? null) === want) return !!c.pawn;
}
return false;
```

`want` is the joining peer's net id, and it is discovered from the join itself,
not assumed: `Lobby.createInvite()` already returns the invite's `id`, which is
the `Peer` object's own id (`HostTransport.createInvite`,
`src/net/Transport.js:273-275`), and `invite.accept` rejects any answer blob
whose `id` is not that one — so the peer that completes *this* exchange is that
id and no other. The probe previously discarded it (`return inv.blob`) and now
carries it (`return { id: inv.id, blob: inv.blob }`).

Ids are explicitly not derived from the loop index. `_nextId` increments once
per invite and a connect retry burns one each time; the refuted-fix session
burned ~30 ids, and keying on `k` would have aimed the wait at a stranger.

`hasPawn` is read as the same `!!c.pawn` on the same host-side record the
failure path already collects, so the predicate and the evidence that explains
a predicate failure cannot disagree about what was true.

## The "joined" line and failure attribution

- The success line only prints after a **re-read** of that peer's host entry
  taken after *both* waits (host pawn, then client `connected`). The client
  wait runs in between, so a pawn that vanished during it would otherwise have
  been announced as joined on a stale check. If the re-read finds no entry, or
  an entry whose pawn is gone, it goes through `joinFailure` instead:
  `peer id N holds no pawn on the host after both join waits returned`.
- The line now reads
  `[probe] player K (peer id N) joined with a pawn on the host in M ms`.
- `joins[]` records `netId`, `peerHasPawn`, `peerSurvivorId`, `peerHelloSeen`.
  `hostPawnCount` is kept alongside them — no longer standing in for them —
  because a global count that disagrees with the roster is still worth seeing.
- Failure attribution names the peer, not the loop position: the arm-failure
  headline is now
  `the join for player K (peer id N) failed at: <stage>`, the pawn stage reads
  `host never spawned a pawn for peer id N`, and `netId` is a field on the
  failure detail.

## What was deliberately left alone

The failure-capture path is byte-for-byte unchanged: `snapshotOf` on every page,
the host peer table (`id/hasPawn/helloSeen/survivorId/lastTick/inputBacklog/
joinTick/peerClosed/stateChannel/eventsChannel/simQueued`), `pageErrors`,
`consoleLines`. It just proved its worth — it is the only reason the defect
above is diagnosable at all. The only addition anywhere near it is the `netId`
field on the outer detail object.

## Verification

One live arm, the cheapest, as authorised:

```
node reviews/round8/probe-targeting.mjs --players 2 --netlag 0 \
  --out reviews/parked/probe-predicate-check.json
```

Exit 0. `N-1 gate: 5 checks passed`.

Join record from the capture
(`reviews/parked/probe-predicate-check.json`, `raw.diagnostics.joins`):

```json
{ "player": 1, "netId": 1, "ms": 4482, "inviteBytes": 1094, "answerBytes": 914,
  "peerHasPawn": true, "peerSurvivorId": "ranger", "peerHelloSeen": true,
  "hostPawnCount": 1 }
```

Derived block is sane — directed hits on **both** players, not the historical
all-on-host split:

- `host` 51 directed hits, `pawn1` 44 (`directedShare` 0.537 / 0.463)
- `totalDirectedHits` 95, `targetIsNearestFraction` 0.976
- `rosterCount` 2, `pawnCount` 1, `peerSim` `[{id: 1, sim: null, rtt: 0}]`
  (`--netlag 0`, so `_sim` null is correct)

No other arm was run; the main session owns the rest of live verification.

**`n1-gate.mjs` cannot be affected.** It is imported for `checkCapture(out,
path)` and reads only `arm`, `derived` and `raw` fields produced by the in-page
measure evaluate — none of which this change touches. Every edit here is in the
node-side join loop, and its output lands in `raw.diagnostics.joins`, a path the
gate never reads (grep for `joins`/`diagnostics`/`hostPawnCount` in
`n1-gate.mjs` returns one comment line and no field access). Running
`node reviews/round8/n1-gate.mjs` over committed captures is unaffected: it
reads captures from disk, not the probe.
