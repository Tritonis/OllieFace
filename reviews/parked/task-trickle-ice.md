# Trickle ICE on the room-code path

**Date:** 2026-08-07 · **Branch:** master (uncommitted) · **Tests:** 47 new, 17/17
files green, `vite build` clean.

## Verdict

Implemented as specified. The room-code path now exchanges SDP immediately and
relays candidates over the existing WebSocket; the manual copy-paste path is
untouched and `tests/ice-quiescence.test.mjs` passes unmodified. Whether the
0.6-10.9 s join spread actually collapses is **not** established here — that is
a live measurement, and `tools/verify-trickle.mjs` is written for the main
session to run.

## The change, in one paragraph

`waitForIce` is crossed twice per join (offer side and answer side), each up to
its 4 s cap, because a blob a human pastes must be complete. On the relay path
nothing is waiting on a human: a live socket already carries the offer and the
answer. So `HostTransport.createInvite` and `ClientTransport.join` gained a
`trickle` option that skips the gathering wait entirely, ships the SDP the
moment `setLocalDescription` resolves, and exposes the candidate exchange as
`onIceCandidate(cb)` / `addIceCandidate(candidate)`. `Lobby`'s relay path wires
those to two new `ice` messages, and `tools/signal-server.mjs` forwards them.

## Protocol change

Three message shapes, all additive:

| message | before | after |
|---|---|---|
| `hosting` (relay → host) | `{type,code}` | `{type,code,v:2}` |
| `offer` (host → relay → joiner) | `{type,clientId,blob}` | `{type,clientId,blob,trickle}` |
| `ice` (either direction) | — | host sends `{type:'ice',clientId,candidate}`; joiner sends `{type:'ice',candidate}` and the relay stamps `clientId` on the way to the host |

The relay treats `candidate` as opaque — it never parses it, exactly as it never
parses `blob`. Routing for `ice` is copied verbatim from `offer`/`answer`: the
host names a joiner, a joiner is identified by its own socket. A candidate whose
`clientId` matches no live client in the room finds no target and is dropped
without a reply, which is the ordinary end of a join.

The SDP blob format (`{v:1, role, id, sdp}`) is **unchanged**. Trickle is a
property of the transport session, not of the blob, so a blob remains
copy-pasteable and a manual invite is byte-identical to what it was.

## How an old server degrades

The degrade is by *omission*, in both directions, and both directions are
gated by a test (the two `DEGRADE GATE` cases in `tests/trickle-ice.test.mjs`).

**New page, old relay.** The old relay's `hosting` carries no `v`. The page's
test is `Number(msg.v) >= RELAY_TRICKLE_VERSION` (2), which `undefined` fails,
so `transport.trickle` stays `false`: every invite waits for gathering as it
does today and the page never sends an `ice` message the old relay would drop.
On the joiner's side the same fact arrives differently — an old relay
reconstructs the offer as `{type:'offer', blob}` and drops every field it does
not know, so `msg.trickle` is `undefined` and the joiner does not trickle
either. Neither end needs to know the other's version; each reads the relay's
own behaviour.

**Old page, new relay.** An old host never sets `trickle`, so the flag the new
relay forwards is `false` and the joiner does not trickle. The new `v` field on
`hosting` is ignored by an old page, and the new `ice` case is never reached
because nothing sends one.

**Mixed pages on a new relay.** Each join negotiates independently — the flag
travels per-offer, per-joiner — so a new host can trickle with a new joiner and
not with an old one in the same room.

The version test is a floor (`>= 2`), not an equality, so the relay can raise
its version for some later feature without stranding a page that only needs ICE
relaying. The number lives in `tools/signal-server.mjs` (`PROTOCOL_VERSION`,
the authority) and in `src/net/Lobby.js` (`RELAY_TRICKLE_VERSION`, the floor);
these are not two copies of one value — one is "what I am", the other is "what I
need", and they are allowed to diverge upward.

## Design notes worth knowing

**Why a `trickle` field on the transport as well as a per-call option.** `Lobby`
does not call the transports directly on the host side — it goes through
`NetHost.createInvite()`, which owns the lobby-full check and forwards no
arguments, and `NetHost.js`/`NetClient.js` were out of scope for this task
(other agents own them). A relay session is trickle-or-not for its whole life,
so the transport instance is the right grain for the switch; the per-call option
exists for tests and direct callers and takes precedence when passed.

**`TrickleIce` holds two buffers, and neither is defensive padding.** Outbound:
`setLocalDescription` starts gathering immediately, but the sink that relays
candidates does not exist until the invite has been created and matched to a
joiner. Candidates gathered in that gap are held and replayed to the first sink
registered. Inbound: the entire point of trickling is that the SDP ships before
gathering finishes, so the peer's candidates are in flight while the *answer*
still is — and `addIceCandidate` before a remote description is an error in
every browser. Both buffers cap at 64 entries (a healthy connection gathers well
under twenty per side) because both hold remote input off a relay we do not
control.

**The null sentinel is dropped, not relayed.** `onicecandidate` fires once with
`candidate: null` to mean "gathering finished". Relaying it would have the far
end call `addIceCandidate(null)`, which in WebRTC means *no more candidates* —
ending the remote's checking early, possibly before the reflexive candidate that
`ice-quiescence-refuted.md` identifies as the only usable route on an mDNS host.
That is the same failure the quiet-period exit caused, arriving by a different
door.

**`_apply` swallows rejections.** A stale, duplicate or malformed candidate is
ordinary traffic on a relay and the browser rejects the promise for it. Nothing
awaits it, so an unreported rejection would surface as an unhandled rejection on
a machine that has done nothing wrong, and reporting it would say nothing useful
because the connection carries on with the candidates that did parse. Gated by a
test.

**`CONNECT_TIMEOUT_MS` semantics are unchanged.** The window still opens at
`accept` (i.e. at `setRemoteDescription`) and still runs 20 s. Trickle moves
work *before* that window, not inside it.

**`Lobby.leave()` clears `_invitesByClient` and `_earlyIce`** for the reason the
existing comment gives for `_refusedPeers`: both are keyed by ids a fresh
session reissues from the start, so anything left behind would answer for the
next joiner.

## Files changed

- `src/net/Transport.js` — `TrickleIce` (new, module-private),
  `MAX_BUFFERED_CANDIDATES`, `HostTransport.trickle` +
  `createInvite({trickle})` + `onIceCandidate`/`addIceCandidate` on the returned
  invite, `ClientTransport.trickle` + `join(blob,{trickle})` +
  `onIceCandidate`/`addIceCandidate` on the transport. `waitForIce` itself is
  **unmodified**; only its two call sites became conditional, and both
  conditions are false on the manual path.
- `src/net/Lobby.js` — `RELAY_TRICKLE_VERSION`, `_invitesByClient`,
  `_earlyIce`, `joinManual(blob, {trickle, onIceCandidate})` (second parameter
  optional; the one existing caller in `src/ui/Menus.js` is unaffected), version
  negotiation and candidate relay in `hostViaRelay`/`joinViaRelay`, cleanup in
  `leave()`.
- `tools/signal-server.mjs` — `PROTOCOL_VERSION`, `v` on `hosting`, `trickle`
  preserved on `offer`, new `ice` case, and `--port 0` now reports the port the
  OS actually assigned (needed by both the test and the driver so neither
  collides with a relay already running on 8787). `/healthz` behaviour is
  unchanged.
- `tests/trickle-ice.test.mjs` — new, 47 assertions.
- `tools/verify-trickle.mjs` — new live driver, **not run**.
- `docs/MULTIPLAYER.md` — a note under Path B step 1 that the relay must be
  redeployed to get the speedup, and that an old one degrades rather than
  breaks.

Not touched: `src/net/NetHost.js`, `src/net/NetClient.js`,
`reviews/round8/probe-targeting.mjs`, `tests/ice-quiescence.test.mjs`.

## Verification run

```
node tests/trickle-ice.test.mjs      → 47 passed, 0 failed
node tests/run.mjs                   → 17/17 test files passed
node node_modules/vite/bin/vite.js build → built in 757ms, no errors
```

`tests/ice-quiescence.test.mjs` is inside that 17 and was not edited; it is what
pins that the manual path's 4 s non-trickle wait, and the refusal of a
quiet-period exit, both still stand.

Test coverage by claim:

| claim | case |
|---|---|
| trickle does not wait for gathering (host) | T1, against a fake pc whose gathering never completes; asserts `< 150 ms` and `iceGatheringState === 'gathering'` |
| trickle does not wait for gathering (joiner) | T1 |
| the manual path still waits | T1, both sides, by racing the call against a 200 ms timer |
| null sentinel skipped | T2 |
| candidates gathered before a sink exists are replayed | T2 |
| a non-trickle invite's handles are inert, not absent | T2 |
| candidate buffered before remote description, then applied in order | T3 (host) and T3 (joiner, buffered before `join` had a pc at all) |
| a rejected `addIceCandidate` is not an unhandled rejection | T3 |
| v2 relay → trickle on, offer flagged, candidates addressed by clientId | T4 |
| **degrade**: no `v` on `hosting` → today's join, no `ice` ever sent | T4 |
| **degrade**: no `trickle` on the offer → today's join | T4 |
| a candidate for an unknown/spent invite is dropped, not thrown | T4 |
| the relay really forwards `ice` both ways and survives junk | T5, which spawns the actual `signal-server.mjs` process on an ephemeral port and drives it with two real `ws` clients |

## What is NOT verified, and what would verify it

No browser has run this. Everything above is a fake `RTCPeerConnection` plus one
real relay process, which can show the wiring is right and cannot show that a
join is faster — the thing being removed is time spent waiting for the network,
and only a real network can be observed not waiting.

`node tools/verify-trickle.mjs [--joins N] [--headed]` is written for that. It
spawns a real relay on an ephemeral port and a real vite server, opens two
Chromium pages at `?signal=ws://localhost:PORT`, hosts a room, joins by code,
and stops the clock when the joiner reports `connected` with a netId *and* both
data channels read `open` on both ends. It prints every join individually and
exits non-zero unless every join connected, every join negotiated trickle, and
both channels opened.

The prediction to test it against is specific: the manual-path spread was
bimodal — 0.6-1.2 s when neither side ate the cap, 3.3-10.9 s when one or both
did. Trickle removes both crossings of that wait, so the *upper mode should not
exist*. A run whose slowest join is still multi-second has not reproduced the
fix, whatever its mean says; the spread collapsing is the result, not the
average improving. The driver's summary prints `minMs`/`maxMs` and the manual
baseline alongside them for exactly that comparison.

One thing the driver cannot settle either: this is one machine, localhost STUN
behaviour, and both peers on the same host. The mechanism
`ice-quiescence-refuted.md` identified — mDNS host candidates that a remote peer
cannot resolve, making the reflexive candidate the only usable route — is a
*two-machine* phenomenon. Trickle should help it more than it helps a loopback
join, not less, since the late reflexive candidate now arrives instead of being
waited for. But that is an argument, not a measurement, and the four-player
probe on the relay path is what would close it.
