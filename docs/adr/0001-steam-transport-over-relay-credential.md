# Steam transport over a Relay Credential

**Status:** accepted (2026-08-15)

Steam Phase 1 ships the WebRTC transport with Steam lobbies for signalling, which
still requires TURN — and in a desktop binary the only options are a static
credential baked into every copy or a credential-minting service we run and
operate. For the Private Beta we instead bring Phase 2 forward: replace the Steam
binding (`steamworks.js` -> `steamworks-ffi-node`) and move the Conversation to
modern `NetworkingSockets`, which deletes STUN, TURN and the credential problem
together. We accept an unproven FFI on the core loop in exchange.

## Considered options

- **Static TURN credential for the beta, minted credentials before Public Launch.**
  This is what issue #12 recommends. Rejected because the minting service is a
  server we would build, deploy, operate and then delete once Phase 2 lands —
  and Phase 2 was already the intended destination.
- **Legacy `ISteamNetworking`.** Already bound in `steamworks.js@0.4.0` and
  already carrying the joiner's answer packet in shipping code today. Rejected as
  the *default* because it is deprecated by Valve and we do not want to build new
  work on it — but retained as the first fallback.

## Consequences

- The binding replacement invalidates every previously verified Steam behaviour
  at once: lobbies, the invite dialog, `GameLobbyJoinRequested`, and the overlay
  all move library. `docs/STEAM.md` section 7's *Wired* column reverts to
  unverified, and #14's STOP condition must be re-run against the new binding.
- A measurement gate runs **before** the swap is committed to. If it fails, fall
  back to legacy `ISteamNetworking`; only if both Steam interfaces miss does
  WebRTC + TURN return, reopening #12 as a Public Launch blocker. This fallback
  is a planned branch, not a failure of the plan.
- Deleting the WebRTC Conversation also deletes `tools/signal-server.mjs` and
  `npm run probe:coop`, the project's only automated connection-formation
  coverage. Replacement coverage is a precondition of the deletion, not a
  follow-up.
