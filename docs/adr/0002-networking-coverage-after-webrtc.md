# Networking coverage after the WebRTC Conversation is deleted

**Status:** accepted (2026-08-15)

Single-box automated testing of a Steam Conversation is **not achievable end to
end**, because every way either candidate Binding can open one is addressed by
Steam identity, and a machine holds one Steam identity. The evidence is
[`docs/STEAM.md` section 8](../STEAM.md). So the coverage `npm run probe:coop`
provides today splits into three arms, each proving a different thing, and the
WebRTC deletion (#56) is gated on the first of them being green **against the
WebRTC transport** — not merely written.

## What probe:coop actually proves, and how it divides

It proves two separable things at once, which is why one replacement cannot
exist. It proves that a **Conversation carries the game correctly** — snapshots,
reliable event ordering, peer arrival and departure, behaviour under lag and
loss. And it proves that an **Introduction ends in two peers meeting at all**.

The first is transport-independent. The second is nothing but transport, and it
is the half that no single box can run.

## Decision

**A. A transport conformance suite — in process, no Steam, no browser.**
One suite, run twice: once against the WebRTC transport and once against the
Steam one, driving real `NetHost` and `NetClient` through the seam **as
enumerated in `docs/STEAM.md` section 8.5** — which is not the seam
section 3 has claimed since it was written. Section 3 says three peer methods;
the real number is eight, and the two extra ones are the whole problem:
`pumpSim()`, which `NetHost.js:532` calls unconditionally every frame, and
`peer.events.readyState` / `.bufferedAmount`, which `NetHost.js:404-405` reads
straight off an `RTCDataChannel`. A Steam transport built to satisfy section 3's
sentence throws on its first frame with a connected client. Section 3 now carries
that correction; the enumeration, not the count, is the contract.

The Introduction (`createInvite` / `join`) is deliberately **outside** the
contract: it is the part that is genuinely different between the two transports,
and pretending otherwise is how a portable suite quietly stops being portable.
`broadcastState` is outside it too, for the opposite reason — it has no caller
anywhere in the tree.

This is the parachute. It is authored while WebRTC still exists and must pass
against WebRTC before anything is deleted.

**B. A Steam-layer smoke on one box, if we choose to pay for it.**
`CreateSocketPair(bUseNetworkLoopback = true)` puts two real Steam connections in
one process, with real packetisation, encryption and configurable fake lag and
loss. That recovers most of what `coopprobe` measured — throughput at 60 Hz,
reliable ordering, loss behaviour — automatically, on this box. It costs a
test-only Koffi module declaring four exported symbols the Binding does not bind,
and a running Steam client. It is optional, and it is the only arm that can watch
the shipping library carry the shipping protocol without a second machine.

**Paid, and built, 2026-08-15 (#64).** `npm run smoke:steam` —
`tools/steamsmoke.mjs` over `tools/steamnet.mjs`. Cheaper than the estimate: two
of the four entry points are bound (`CreateSocketPair`,
`SetGlobalConfigValueInt32`), the other two belong to the two-process arm and are
existence-checked only, and no package was patched. Three green runs at 3 peers / 60 Hz / 30 s:
1080 of 1080 reliable messages delivered exactly once in order, p99 0.21-0.28 ms
against a 5.0 ms limit — **8-14x cheaper than the WebRTC baseline**, not the 2.5x
more expensive the criterion allowed for. Impairment ported and verified biting:
25 ms of `FakePacketLag_Recv` lands as 25.9 ms, 5% of `FakePacketLoss_Recv` drops
5.2% of snapshots while reliable delivery survives it intact. Evidence:
`reviews/net-baseline/STEAM-SOCKETPAIR.md`.

**C. A scripted two-machine run** for what remains: identity, the Introduction,
SDR, NAT. Scripted so the human cost is *start it on both boxes and read the
record*, not *drive the menus*. This is issue #13, promoted from a manual
checkpoint to a scripted one.

## Considered options

- **Two Windows user sessions, two Steam accounts, one box.** Ownership is not
  the obstacle — Spacewar is free to every account. The obstacle is that the
  Steam client is a single-session interactive process needing a Steam Guard
  login that survives reboots, and #53's own standard is that a gate requiring a
  human login is not a gate.
- **Keep the WebRTC transport alongside the Steam one purely as a test double.**
  Rejected: it preserves the Relay problem ADR 0001 exists to delete, and a
  transport kept only for tests stops being the transport the tests are about.
- **Accept the gap and rely on `gate:mp1`.** Rejected on the plan's own terms.
  `gate:mp1` measures gameplay equivalence; it never opens a socket.

## Consequences

- **#56 acquires a precondition it did not have:** arm A green against WebRTC.
  A deletion commit that also introduces its own replacement coverage is the
  parachute and the altimeter in one commit, which is the failure #53 was filed
  to prevent.
- Arm A is written against a seam, so it is also the specification the Steam
  transport in #55 is implemented against. The suite comes first and the
  transport is written to pass it.
- **#55 acquires a prerequisite of its own:** `NetHost._closeWhenFlushed` reads
  `RTCDataChannel`'s `readyState` and `bufferedAmount` through the peer
  (`NetHost.js:404-405`). That is WebRTC vocabulary inside host logic, and the
  contract cannot be transport-neutral while it stands. It wants a `drained()`
  predicate on the peer, changed *before* the Steam transport exists rather than
  worked around inside it. `pumpSim` is the milder twin of the same problem: a
  Steam peer must implement it as a no-op purely because `NetHost.js:532` calls
  it unguarded.
- Arm B, if declined, is not a small loss: without it nothing automated ever
  exercises the real Steam library, and arm C becomes the *only* evidence that
  the shipping Conversation works. Declining it should be a decision, not a
  drift. **It was not declined — see above.**
- Impairment coverage moves libraries. `?netlag=` / `?netloss=`
  (`src/net/NetConfig.js`) belongs to the WebRTC transport and dies with it; the
  Steam equivalent is `k_ESteamNetworkingConfig_FakePacketLag_Recv`, reachable
  only through arm B's module. Same shape — receive-side, one-directional — so
  the arm is a port rather than a redesign. **Ported and verified biting**
  (`--lag-ms`, `--loss-pct` on `tools/steamsmoke.mjs`), so `NetConfig.js` can die
  with the transport it belongs to rather than outliving it as the only
  impairment rig we have.
- `tools/coopprobe.mjs` and `tools/signal-server.mjs` still go. Nothing here
  argues for keeping them; the point is only what must exist first.
