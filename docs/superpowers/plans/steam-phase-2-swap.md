# Steam Phase 2 swap: from WebRTC to Steam networking, ahead of the Private Beta

**Decided 2026-08-15.** Supersedes the critical path recorded in issue #16, which this
plan contradicts at three points: #15 is no longer first, #14 is no longer independent
of the transport work, and #12 closes as superseded rather than being resolved.

Vocabulary used throughout is defined in [`CONTEXT.md`](../../../CONTEXT.md) —
Introduction, Conversation, Relay, Relay Credential, Binding, Private Beta, Public
Launch, Ship Blocker, STOP Condition. The central decision is recorded in
[ADR 0001](../../adr/0001-steam-transport-over-relay-credential.md).

## What we are shipping

A **Private Beta**: a `win-unpacked` zip handed directly to named testers, running
against Spacewar (appid 480) while Valve processes the partner application. This is
not a Steam distribution — testers receive the build itself. **Public Launch** is a
separate, later gate.

Valve's partner processing is therefore *off* the critical path. So is Steam Direct's
30-day release clock, the appid swap, and SteamPipe.

## The decision in one paragraph

Phase 1 (WebRTC Conversation + Steam lobby Introduction) is built and merged, but it
requires a Relay, and a desktop binary can only carry a static Relay Credential or
call out to a minting service we would have to build and operate. Rather than build
that service and delete it later, bring Phase 2 forward now: replace the Binding
wholesale (`steamworks.js` -> `steamworks-ffi-node`), move the Conversation to modern
`NetworkingSockets`, and delete the Relay entirely.

## Sequence

Ordering here is load-bearing. Two principles drive it:

1. **Test the architecture you ship.** Verifying Steam behaviour under `electron .`
   when testers receive a packed artifact verifies a build architecture no player
   runs. This is why #15 exists at all.
2. **Do the packaging fix once.** Because the Binding is being replaced, packaging
   work done first would be packaging for a library about to be removed.

### 0. Capture the WebRTC baseline, while WebRTC still exists

The pass criterion in step 1 is expressed relative to what `gate:mp1` records for
WebRTC today. That number must exist on disk, in a named file, before anything is
swapped. If it turns out not to be capturable, the criterion changes *before* the
spike, not after.

### 1. Spike, timeboxed, one session

Four checks, any of which can stop the plan before porting work begins:

- **Overlay.** `steamworks-ffi-node` loads under Electron; Shift+Tab visibly paints
  the Steam overlay over the running game, and the friend-picker dialog opens. This
  is #14's sentence asked of the new Binding.
- **Throughput.** At 60 Hz with 3 peers, over a sustained run: **zero dropped
  reliable messages**, and **p99 added latency within the envelope `gate:mp1`
  records for WebRTC**.
- **Peer visibility.** Two peers can be made to see each other at all, and we learn
  what hardware that requires. Steam identity is per-account and an account is
  online in one place at a time, so two instances on one box likely cannot appear
  to each other as two peers.
- **Lobby space.** Confirm the invite flow on appid 480 is invite-only and does not
  expose or enumerate other developers' Spacewar lobbies.

### 2. Gate

- **Pass** -> proceed to step 3.
- **Fail** -> fall back to legacy `ISteamNetworking`, which is already bound and
  already carries the joiner's answer packet in shipping code. Still deletes the
  Relay; costs a deprecation follow-up in the Public Launch milestone.
- **Both Steam interfaces miss** -> WebRTC + TURN returns, #12 reopens as a Public
  Launch blocker, the credential-minting service gets built, and the beta slips.

The fallback is written down here, and in the ADR, deliberately in advance: a gate
with an undefined failure branch gets argued down by whoever just spent a week on
the work.

### 3. Coverage, before anything is deleted

Deleting the WebRTC Conversation also deletes `npm run probe:coop` — two browser
pages forming a co-op session — which is the project's *only* automated
connection-formation coverage. `gate:mp1` measures gameplay equivalence, not two
peers meeting.

**Resolved 2026-08-15 (#53).** It is not achievable end to end: every way either
candidate Binding can open a Conversation is addressed by Steam identity, and a
machine holds one Steam identity. Evidence in `docs/STEAM.md` section 8, decision
in [ADR 0002](../../adr/0002-networking-coverage-after-webrtc.md). The coverage
splits three ways:

- **A. A transport conformance suite**, in process, no Steam and no browser,
  against the seam **as enumerated in `docs/STEAM.md` section 8.5** — one suite
  that both transports pass. The Introduction is outside the contract. Note the
  enumeration corrects section 3's long-standing "exactly three methods": the
  peer surface is eight members, including `pumpSim()` and a raw
  `RTCDataChannel` read inside `NetHost`, and step 5 below inherits that as work.
- **B. Optional: a Steam-layer smoke on one box** via `CreateSocketPair` with
  network loopback, which costs a test-only Koffi module for four symbols the
  Binding does not bind, plus a running Steam client.
- **C. A scripted two-machine run** (#13, promoted from manual) for identity,
  rendezvous and SDR — the half no single box can run.

**This changes step 6's entry condition.** The deletion may not proceed until
arm A is green *against the WebRTC transport*. Written-but-unrun does not
qualify.

### 4. Replace the Binding

`steamworks.js` -> `steamworks-ffi-node` across the Introduction: lobby create/join,
`openInviteDialog`, the `GameLobbyJoinRequested` callback, and the overlay. Everything
`docs/STEAM.md` section 7 marks *Wired* reverts to unverified at this step.

**A prerequisite found during #53:** unlike `steamworks.js`, `steamworks-ffi-node`
ships no Steam redistributable — it loads `steam_api64.dll` from a
`steamworks_sdk/` tree we must acquire from partner.steamgames.com and vendor
ourselves, and carry into step 7's packaging. See `docs/STEAM.md` section 8.6;
**[uncertain]** whether that download needs an approved partner account, which
would put it back on Valve's clock.

One thing to watch for as an improvement rather than a risk: `steamworks.js@0.4.0`'s
owner-only `SetLobbyData` is what forced the joiner's answer through a P2P packet
(`docs/STEAM.md:129-134`). A fuller binding may remove that workaround.

### 5. Swap the Conversation

WebRTC -> `NetworkingSockets`, implemented against the existing seam, enumerated
in `docs/STEAM.md` section 8.5. The claim this step used to rest on — three peer
methods plus three transport hooks, so **no gameplay code is touched** — was
checked during #53 and is wrong in two places that cost work here:

- `NetHost.js:532` calls `peer.pumpSim()` unconditionally every frame. A Steam
  peer must implement it, if only as a no-op.
- `NetHost.js:404-405` reads `peer.events.readyState` and `.bufferedAmount` —
  raw `RTCDataChannel` — to decide whether a refusal has drained. Replace with a
  transport-neutral `drained()` on the peer **before** the Steam transport
  arrives, not around it.

Everything else about the claim holds: gameplay code proper is untouched, and the
two repairs above are both inside `NetHost`.

### 6. Delete the WebRTC era

**Entry condition, from step 3:** the transport conformance suite passes against
the WebRTC transport. Not before.

Code and docs both, cleanly — not marked superseded in place. This repo already
carries the cost of documents whose later halves overturn their earlier ones, and
the working agreements open by recording that two stale `.md` claims cost real
reasoning.

- Delete: the WebRTC transport, STUN/TURN configuration, `tools/signal-server.mjs`,
  `npm run signal`, `npm run probe:coop` / `tools/coopprobe.mjs`,
  `docs/MULTIPLAYER.md`.
- Rewrite: `docs/STEAM.md` section 7 to describe the Binding that exists.
- Close #12 as **superseded, not fixed**, with the reason on it, so that a later gate
  failure means reopening rather than re-deriving.
- Re-check #10 (`leave()` racing `createInvite`) — it is a page-side Lobby defect and
  may be deleted along with the code it describes.

### 7. Package once (#15)

Promote the final Binding to a runtime dependency and admit exactly its
`node_modules` subtree, preserving the `!node_modules/**` exclusion that keeps
`three`'s src out. Note `asar: false` is already set, so asar packing of native
modules — listed among #15's hazards — is moot as configured. `steamworks-ffi-node`
builds a native overlay module at install time when prebuilds are absent, which is
the hazard that replaces it.

`desktop/README.md:76-79` still applies: no `steam_appid.txt` anywhere in the packed
folder.

### 8. Re-verify the overlay (#14), on the packed artifact

Both halves, one sitting, eyes on the screen. If either does not appear, the invite
path is dead and no dead invite button ships.

### 9. Two-seat invite test (#13), two machines, scripted

Against the packed artifact, on the shipping architecture. The joiner half has never
met a real host.

### 10. Zip to testers

## Running in parallel, blocked by none of this

**Solo playtesting is completely unaffected.** `npm run dev` is bare vite — browser,
no Electron, no Binding, no Steam in the path. `gate:sp` and `gate:elite` likewise.
The entire design backlog (#30-#40, the corruption legibility and mastery cluster)
stays playable and testable throughout, and it is the largest body of unvalidated
work in the project.

## The accepted cost

There is no co-op playtest until all of the above lands, and the riskiest engineering
in the project's history sits between here and first real player contact. This was
chosen deliberately: a co-op playtest over a Conversation we are deleting tests
nothing we are shipping.
