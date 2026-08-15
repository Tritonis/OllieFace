# What shipping this on Steam would take

Research notes, current as of August 2026. Claims that come from a source carry
a link; claims that are inference from this codebase say so. Anything genuinely
uncertain is marked **[uncertain]** rather than smoothed over.

---

## The shape of it

Steam does not run browser games. You ship a desktop executable, which means
wrapping the existing `dist/` in a Chromium-based shell.

**Recommended stack:** Electron + [`steamworks.js`](https://github.com/ceifa/steamworks.js),
Windows-only depot, Steam lobbies replacing the signalling relay, the existing
WebRTC transport retained, saves moved out of `localStorage`.

**Realistic timeline: 8–12 weeks** from decision to purchasable — and the
calendar floor is set by Valve's waiting periods, not by the engineering.

---

## 1. The wrapper: Electron

| | Electron | NW.js | Tauri 2 |
|---|---|---|---|
| Renderer | Bundled Chromium | Bundled Chromium | OS webview |
| Size | ~150–200 MB installer | Similar | ~5–15 MB |
| WebGL parity with dev browser | Yes | Yes | **No** |
| **WebRTC DataChannels** | Yes | Yes | **Linux: effectively no** |

**Tauri is disqualified for this game**, on two independent grounds. WebKitGTK
ships without WebRTC in stock distro builds — the community only got it working
by compiling WebKitGTK from source under Nix
([tauri#8426](https://github.com/orgs/tauri-apps/discussions/8426)), and
`"The current browser does not support WebRTC"` reports were still landing in
2025 ([tauri#13143](https://github.com/tauri-apps/tauri/issues/13143)).
Separately, WebGL2 contexts can silently fall back to software rasterisation,
and WebKitGTK masks `WEBGL_debug_renderer_info` so you cannot even detect it
([Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/)).
Multiplayer and Three.js are the whole game; neither is negotiable.

NW.js is a live runner-up (v0.114.0, July 2026, Chromium 151) and equally valid
technically. Electron wins on ecosystem depth for the Steam-specific problems
below.

The ~180 MB bundle is essentially all Chromium, since this game has no disk
assets. That is commercially irrelevant — Vampire Survivors shipped Electron
and sold over a million copies.

### The one genuinely unresolved risk: laptop GPUs

Electron/Chromium **does not reliably request the discrete GPU** on hybrid-GPU
laptops ([electron#9842](https://github.com/electron/electron/issues/9842)),
and the obvious fix does not work — `--force_high_performance_gpu`
*"doesn't do anything on Windows"*
([electron#31355](https://github.com/electron/electron/issues/31355)).
Native games export `NvOptimusEnablement` from the executable; you cannot do
that in a prebuilt Electron binary without patching it.

In practice NVIDIA/AMD driver profiles usually handle *browsers* correctly —
but `Petrichor.exe` is not a browser they have a profile for, so it inherits
the default.

**Mitigation:** test on an Optimus laptop before committing to a date; log
`WEBGL_debug_renderer_info` at startup and warn in-game if an integrated
adapter is detected; request a driver profile from NVIDIA/AMD post-launch.
**[uncertain]** — no 2024–2026 source declares this solved. Budget for
"detect and warn" rather than "fix".

Worth noting this project already has GPU-tier detection (`src/core/GpuTier.js`)
and a notice UI (`src/ui/GpuNotice.js`), so the warning path largely exists.

---

## 2. Steamworks from JavaScript

| Library | Status (Aug 2026) | Verdict |
|---|---|---|
| `greenworks` | Original abandoned; fork is "best-effort, active development is not a priority" | Avoid |
| **`steamworks.js`** | Last commit Sep 2025, npm 0.4.0 Aug 2024. Prebuilt binaries, TS types, MIT | **The safe pick** |
| `node-steamworks` | Fork of greenworks | Avoid |
| `steamworks-ffi-node` | First published Oct 2024, ~71 stars, SDK v1.64, Koffi FFI | Interesting, unproven |
| `steamworks-rs` | 0.13.1, July 2026 — most actively maintained binding anywhere | Tauri only |

`steamworks.js` is in low-activity maintenance rather than active development,
which is tolerable because the Steamworks C API it wraps is extremely stable.
It covers achievements, stats, **Steam Cloud (Remote Storage)**, overlay, rich
presence, **full lobby matchmaking**, Steam Input, and Steam Deck detection.

It does **not** cover modern networking — see below.

---

## 3. Networking: the big win

Steam Datagram Relay does NAT traversal *and* relaying as part of the platform,
free for games shipping on Steam. It also hides player IPs and often *improves*
ping by routing over Valve's backbone
([SDR docs](https://partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay)).

Valve's own description makes the relationship clear: Steam provides
*"signaling, STUN, and a custom relay service called Steam Datagram Relay"* —
i.e. exactly the three things `docs/MULTIPLAYER.md` tells you to deploy
yourself ([README_P2P.md](https://github.com/ValveSoftware/GameNetworkingSockets/blob/master/README_P2P.md)).

`ISteamNetworkingMessages` maps onto this game's requirements almost exactly:
per-message reliability flags (`_Unreliable` / `_Reliable` / `_NoDelay`) and
channels that share one underlying connection. Channel 0 unreliable for
snapshots, channel 1 reliable for events — which is precisely what
`Transport.js` builds out of two DataChannels today.

**The catch:** `steamworks.js` exposes only the *deprecated* legacy
`ISteamNetworking`. PRs for the modern interface have been opened and abandoned
(#142, #179 closed; #178 still open since Feb 2025). `steamworks-ffi-node`
claims full `NetworkingSockets` support, but no shipped title is known to use
it and there is no benchmark of Koffi FFI overhead at 60 Hz × 3 peers
**[uncertain — real risk for the core loop]**.

### Recommended sequencing

**Phase 1 — ship this.** Keep the WebRTC transport untouched. Replace only the
*signalling*: Steam lobbies (`matchmaking.createLobby/joinLobby`,
`Lobby.setData/getData` to carry the SDP blobs, `openInviteDialog`, and the
`GameLobbyJoinRequested` callback for "join friend's game"). This deletes
`tools/signal-server.mjs` and the copy-paste flow entirely and gives players the
native Steam invite they expect. Still needs TURN — see below.

> **Superseded in one detail — see section 7.** Phase 1 is now built, and
> `Lobby.setData/getData` could not carry the SDP blobs in *both* directions:
> `SetLobbyData` is owner-only and `steamworks.js@0.4.0` binds no member-data
> and no lobby-chat API at all. The offer goes host to joiner over lobby data
> as described; the answer comes back as a Steam P2P packet. Section 7 records
> what was actually wired.

**Phase 2 — post-launch, optional.** Swap the transport for Steam sockets, then
delete TURN and STUN too.

**The good news for Phase 2:** this codebase is already sitting on the right
seam. `NetHost` and `NetClient` touch a peer through exactly three methods —
`sendState`, `sendEvent`, `onMessage` — plus `onPeer`/`onPeerLeave`/`close` on
the transport. A Steam-backed transport implementing that same shape drops in
without touching a line of gameplay code. The refactor the research recommends
doing first has, in effect, already been done.

> **Corrected — see section 8.5.** "Exactly three methods" is wrong, and it was
> wrong when written. The real peer surface is eight members, one of which
> (`peer.events.readyState` / `.bufferedAmount`) is a raw `RTCDataChannel` read
> from inside `NetHost`. The paragraph's conclusion survives — the seam is still
> narrow and no gameplay code is touched — but a Steam transport built to satisfy
> the sentence above would throw on its first frame. Section 8.5 enumerates the
> surface instead of counting it.

### Do you still need TURN?

- **Full Steam networking** → no TURN, no STUN, no signalling server. Ever.
- **WebRTC + Steam lobbies for signalling** → **yes, still.** Roughly
  [22% of WebRTC connections need TURN](https://webrtchacks.com/usage-stats/).
  With 4 players there are up to 3 host↔peer paths, so the odds that *at least
  one* player in a lobby fails are considerably worse than the per-connection
  rate.
- **Non-Steam builds (itch.io, web)** → yes, keep the whole WebRTC path.

---

## 4. Steam Direct

**$100 per app**, not refundable but **recoupable** — credited back once the app
reaches $1,000 adjusted gross revenue
([appfee](https://partner.steamgames.com/doc/gettingstarted/appfee)).

**The calendar gates, which you cannot compress:**

- **30 days** from fee payment before you may release
- **14 days** minimum with a public Coming Soon page
- Store review **3–5 business days**; submit ≥7 business days ahead
- Tax interview processing: **2–7 business days**

**Pay the $100 and do the tax interview on day one.** Those clocks run in
parallel with all the engineering, and they are the only part you cannot speed
up. Realistic fee-to-launch minimum is ~30 days; budget 6–8 weeks.

**Valve reviews** the store page, and the build's ability to launch on **every
OS you claim to support** — a good reason to claim fewer
([review process](https://partner.steamgames.com/doc/store/review_process)).

**Store assets** — note Valve moved to larger uploads in **August 2024**, so
pre-2024 tutorials quote display sizes, not upload sizes
([standard](https://partner.steamgames.com/doc/store/assets/standard),
[library](https://partner.steamgames.com/doc/store/assets/libraryassets)):

| Asset | Size |
|---|---|
| Header capsule | 920 × 430 |
| Small capsule | 462 × 174 (must read at 120×45) |
| Main capsule | 1232 × 706 |
| Vertical capsule | 748 × 896 |
| Library capsule | 600 × 900 |
| Library hero | 3840 × 1240, no text |
| Screenshots | ≥1920×1080, min 5, **gameplay only** |

A trailer is mandatory. Capsules may not contain review scores, awards or sale
text (banned since Sept 2022).

**Age rating: no paid certification needed.** Valve's Content Survey
synthesizes regional ratings. Germany has legally required ratings since
15 Nov 2024, but **Valve's self-rating satisfies it** — you do not need to pay
USK ([Germany](https://partner.steamgames.com/doc/gettingstarted/contentsurvey/germany)).
The AI-content disclosure was updated to a two-tier model in January 2026;
read the live form text **[secondary source only]**.

**Builds** go up via SteamPipe/`steamcmd` with VDF scripts. Use the `Preview`
dry-run flag. Watch that `Recursive` on the wrong root will happily ship
`node_modules` and your source maps.

---

## 5. Port gotchas, worst first

### Controller support is actively broken

**Gamepads stop working in Electron when Steam Input is enabled** — a regression
from Electron 27 onward, reproduced through Electron 35, **closed as "not
planned"**, root cause never identified
([electron#45732](https://github.com/electron/electron/issues/45732)).

So `navigator.getGamepads()` is unsafe on Steam. The robust path is Steam Input
via `steamworks.js`'s `input` namespace, which also gets you correct Deck
glyphs — but it touches every menu, and it is the single most likely item to
blow its estimate.

### `localStorage` cannot be synced by Steam Cloud

Chromium keeps it in a LevelDB directory; syncing a live LevelDB across
machines produces corruption, not saves. Move the profile to a **single JSON
file** under `app.getPath('userData')` with a one-time migration, then either
configure Auto-Cloud to that path or use `cloud.readFile/writeFile`. Relevant
here because `src/systems/Profile.js` is the persistence layer that would move.

### Steam Overlay

Chromium skips repainting unchanged regions, which stops the overlay
compositing. `steamworks.js` ships `electronEnableSteamOverlay()` to handle the
switches. A continuously-rendering 3D game is much less exposed to this than a
static UI app, so this project is well placed.

But overlay behaviour is **not stable across Electron majors** — Electron 35
broke it on SteamOS, closed as "not planned"
([electron#47662](https://github.com/electron/electron/issues/47662)).
**Pin the Electron version and re-test the overlay after every bump.**

### Module loading

`file://` breaks ES module resolution. Register a custom `app://` scheme as
`standard` + `secure` and serve `dist/` through `protocol.handle`. Use
`electron-vite` v2+, which is built for the ESM/CJS main-process problem.

### Don't ship a native Linux build

Valve tests your Linux build if one exists and otherwise tests Windows under
Proton, then publishes whichever result is better. Given the SteamOS overlay
regression, **ship Windows-only and let Proton cover the Deck.** It also removes
a whole class of build-review failures, since Valve verifies every OS you claim.

### Code signing: skip it for a Steam-only launch

Valve: *"because Valve runs the game when a user presses Play, both codesigning
and notarization are not strictly necessary."* If you also distribute directly,
note 2026 changed things — all code-signing keys (OV as well as EV) now require
FIPS 140-2 Level 2 hardware, max cert validity dropped to ~15 months, and EV
stopped instantly clearing SmartScreen back in March 2024.

### Frame pacing

Chromium caps WebGL to vsync; 144 Hz players will notice. More importantly:
on window blur, throttle rendering but **do not stall the simulation** — this is
host-authoritative netcode, and a host that pauses on alt-tab desyncs everyone.
Chromium throttles `requestAnimationFrame` in background windows, so the tick
needs a `setInterval`/worker path or `backgroundThrottling: false`.

---

## 6. Effort

Solo dev, finished web build, Electron + `steamworks.js`, Windows-only.

| Work | Days | Risk |
|---|---|---|
| Electron shell, `app://` protocol, packaging | 2–3 | Low |
| Saves → JSON + Steam Cloud | 1–2 | Low |
| `steamworks.js` wiring, achievements, overlay | 1–2 | Low |
| **Signalling → Steam lobbies** | 3–5 | Medium |
| TURN provisioning + failure UX | 1 | Low |
| **Steam Input + D-pad UI navigation** | 4–7 | **High** |
| DPI / render-scale settings | 1–2 | Low |
| Overlay verification | 1 | Medium |
| **Discrete-GPU testing + warning UX** | 1–3 | **High** |
| Multi-machine QA, Proton pass | 3–5 | Medium |
| SteamPipe depot + first upload | 1–2 | Low |
| **Engineering** | **~19–34 days** | |

Non-engineering runs in parallel and is what actually slips: store capsules and
library art (3–6 days, or $300–800 for an artist), trailer (2–5 days), store
copy and surveys (2–3 days).

**Where this estimate most likely breaks:** controller support if Deck Verified
matters; the laptop GPU problem if it turns out to be open-ended rather than
bounded; and capsule art, which is the most common cause of a delayed indie
launch.

---

## 7. What is wired today

Everything above from section 2 onward was research. This section is the
as-built record of the *Steamworks wiring* slice (branch
`slice/steamworks-wiring`, plan
`docs/superpowers/plans/2026-08-12-steamworks-wiring.md`, August 2026) and it
takes precedence over the research above wherever the two disagree.

Read the status column literally. "Wired" means the code exists and is proven
by tests and by an instrumented run on one machine. It does **not** mean two
humans have played a game through it, because none have.

| Piece | Status | What that means, precisely |
|---|---|---|
| **Init** | **Wired** | `desktop/steam.mjs` `initSteam()` runs at module scope in `desktop/main.mjs`, before `app.whenReady()`. Every failure — Steam not running, missing native binary, missing `steam_appid.txt` — collapses to `{ available: false, reason }`. It throws nothing and blocks on nothing; Steam-absent init measures 26 ms. |
| **Bridge** | **Wired** | `window.__STEAM__`, fourteen named functions over named IPC channels, `contextIsolation: true`. No client object, no generic pass-through. The exact key set is pinned by `tools/desktopprobe.mjs`, which goes red if anything is *added*. All Steam ids cross as decimal strings (they are `bigint` natively and `JSON.stringify` throws on those). |
| **Lobby signalling** | **Wired, never run between two machines** | `src/net/SteamLobby.js`. Host and join paths are complete and covered by 105 assertions against a fake bridge; the host half additionally ran against live Steam through the real UI. The joiner half **has never met a real host.** See "the warm path" below. |
| **Overlay** | **PROVISIONAL — pending human confirmation** | `electronEnableSteamOverlay()` is called pre-ready, only when `available: true`. `gameoverlayrenderer64.dll` is resident in the Electron 43.3.0 renderer, so the hook injects and nothing detected a capability failure. **Injection is not painting.** The determinative check is still open — see "the overlay" below. Do not record this row as done. |
| **Appid swap** | **Pending Valve** | `steam_appid.txt` is `480` (Spacewar) and `DEV_APP_ID` in `desktop/steam.mjs` is `480`. The real id does not exist yet. Procedure below. |
| **Packaged build carries Steam** | **NOT wired** | The packed deliverable contains no `steamworks.js` at all, so a packaged launch always reports `available: false`. See "the packaged build" below. This is a gap, not a decision. |

### The signalling design as built (not as originally planned)

The plan called for the SDP blobs to travel both ways through lobby data. They
cannot. `steamworks.js@0.4.0` was read against its own shipped native binary,
not just its typings, and it binds **no `setLobbyMemberData`/`getLobbyMemberData`,
no lobby chat messages, no ownership transfer, and no programmatic invite**;
Valve's own documentation confirms `SetLobbyData` is settable **only by the
lobby owner**. So the joiner has no way to write anything into lobby data.

What ships instead is asymmetric, and deliberately so:

- **Host to joiner (the offer):** unchanged from the plan. The host owns the
  lobby, so it chunks the WebRTC offer blob across `sdp.offer.*` keys and writes
  them in one `mergeFullData` batch. The joiner polls `getFullData` once a
  second, bounded at 60 seconds, and reassembles.

  **How much a lobby holds.** Steam's lobby metadata is ONE budget of about 8192
  bytes for the whole lobby — every key and every value added together — not a
  per-key limit. Measured against the live client on appid 480: a single value of
  8174 chars under an 11-byte key is stored and 8175 is refused, while fifteen
  separate 500-char values are stored and the sixteenth is refused at a raw total
  of 8182; key text is charged exactly as value text is, plus a few bytes of
  framing per entry. The build therefore spends at most `MAX_LOBBY_TOTAL_BYTES`
  (7680, i.e. 8192 less a 512-byte reserve) and **measures the record before it
  writes it** — a `mergeFullData` Steam refuses does not refuse cleanly, it
  stores entries until it hits the wall, which would leave `sdp.offer.n` counting
  chunks that are not there and a joiner burning its full 60 s poll on them.
  Real offer blobs measure 915 chars with no ICE servers and 1098 with the
  default STUN pair, so the budget currently runs about 7x over what the offer
  needs; that margin is the thing to re-measure when Phase 4's TURN credentials
  land and every interface starts contributing a relay candidate.
- **Joiner to host (the answer):** one reliable
  `networking.sendP2PPacket(ownerSteamId, Reliable, blob)`. Steam's own Reliable
  ceiling is 1 MB, but this build does not use anywhere near it: the bridge caps
  the packet at `MAX_SIGNAL_PAYLOAD_BYTES`, **32 KB**, well under Steam's limit
  and well over what is ever sent — a real SDP answer measures ~918 chars, about
  0.4% of the 32 KB the bridge actually allows. So the answer leg needs no
  chunking at all, and 32 KB, not 1 MB, is the number to check against if this
  leg is ever asked to carry more. The host learns the sender's identity for
  free from `readP2PPacket().steamId`, which is *better* collision behaviour
  than the per-joiner key namespacing it replaces.

The host's main process accepts a P2P session **only** from a current member of
its own lobby, length-caps the packet, and JSON-parses it defensively before
anything crosses back to the renderer. The joiner deliberately stays in the
Steam lobby after sending, because leaving would race the packet against that
membership check.

**Accepted debt, carried openly:** the answer leg rides `ISteamNetworking`,
which **Valve has deprecated** in favour of `ISteamNetworkingMessages` /
`NetworkingSockets`. It is nonetheless what `steamworks.js@0.4.0` binds, it is
live infrastructure that Valve's own Spacewar sample exercises, and section 3's
Phase 2 (swap the transport for Steam sockets) replaces it wholesale. The debt
is bounded by a change already on the roadmap.

### The warm path is UNVERIFIED-BY-HUMAN

The full warm path — **invite, join, co-op forms** — has never been observed.
No two-machine test has been run. Nobody has accepted a Steam invite from
another account and watched a game start.

What *has* been observed, on one machine: a real Steam lobby opening against
live Steam, the chunked offer being written into it, the signal listener
starting, and `openInviteDialog()` returning without throwing. What has **not**
been observed: a second Steam account receiving that invite, joining, reading
the offer, sending an answer back, and the WebRTC connection forming.

Everything in between is proven only against a fake bridge in tests. That is
real coverage of the logic and it is not evidence that co-op works. Until two
seats have played, this feature is code that has never done its job.

### The overlay: what is still open

**PROVISIONAL — no capability failure detected; the determinative check is
still open.** The evidence gathered so far is positive and none of it argues
for an Electron bump, but none of it can falsify the failure it matters most to
rule out: a fully non-compositing overlay would load the same DLL and return
success from the same API calls.

To close it, somebody with eyes on the machine must observe both halves in one
sitting of `npm run desktop`:

> Pressing **Shift+Tab** visibly draws the Steam overlay over the running game,
> and **Host via Steam -> Invite friend** on the co-op screen visibly opens
> Steam's friend-picker dialog on top of the game.

**If either does not appear, that is the STOP condition** in the plan's Global
Constraints: do not ship a dead invite button, and the Electron-bump decision
goes to the user. The overlay is not optional politeness here — this binding
has no programmatic invite call, so the overlay dialog is the *only* invite
path that exists.

### The Optimus trade-off, at its true severity

Enabling the overlay appends `in-process-gpu`, and that has exactly one cost.
Two mitigations for the hybrid-GPU problem in section 1 are easy to confuse;
only one of them is affected.

- **The player-facing detect-and-warn path is UNAFFECTED.** Section 1's
  mitigation — "log `WEBGL_debug_renderer_info` at startup and warn in-game" —
  is `src/core/GpuTier.js` `probeRenderer()` feeding `src/ui/GpuNotice.js`. It
  reads `UNMASKED_RENDERER_WEBGL` off the **live renderer WebGL context**, which
  `in-process-gpu` does not touch. Measured with the overlay **on**, it still
  reports the correct discrete adapter. A Steam player on an Optimus laptop
  keeps the correct detection and the same in-game warning as anybody else.
- **The secondary `gpu-info.json` support dump is DEGRADED.** With the overlay
  on, `app.getGPUInfo('complete')` collapses from 7049 bytes to 1248: the NVIDIA
  adapter entry is gone entirely, `glImplementationParts` reads
  `(gl=none,angle=none)`, `inProcessGpu` is true. `getGPUInfo` cannot report on
  a GPU that is no longer in its own process. Rendering itself is unaffected.

The real cost, stated plainly: **a support engineer triaging a Steam player's
GPU report gets a near-empty file** and must lean on the in-game notice and the
player's own description. That is a smaller cost than "Steam players lose
Optimus protection", which is not true. Captures on disk:
`reviews/round8/overlay/gpu-info-before.json` and `gpu-info-after.json`, same
tree, same box, minutes apart, differing only in that switch.

`TELLURIC_NO_OVERLAY=1` skips the overlay call and exists so that pair of
captures stays re-derivable from this tree. It is a **developer tool and
explicitly not a field-recovery mechanism** — nobody sets an environment
variable before double-clicking a game in their Steam library, so it must never
be offered to a customer as a way to produce a usable `gpu-info.json`.

### The packaged build does not carry Steam yet

`npm run desktop:pack` produces `dist-desktop/win-unpacked/`, and that folder is
the deliverable SteamPipe will be pointed at. It was probed and boots correctly:
thirteen of thirteen checks, `app://` serving the game, the renderer isolated,
the bridge surface exact. Its `__STEAM__.status()` answers

```
{"available":false,"appId":null,"personaName":null,
 "reason":"Cannot find module 'steamworks.js' ..."}
```

which is the degradation contract working exactly as designed — but it means
**every packaged launch is a Steam-absent launch.** `build.files` carries
`!node_modules/**` (deliberately, to keep `three`'s source tree out) and
`steamworks.js` is a `devDependency`, so the native module is excluded twice
over. Nothing in the packaged app can reach Steam.

Consequences, all of them:

- The two-seat checkpoint must be run with `npm run desktop`, not against the
  packed exe. The packed exe cannot host or join.
- The packaged build is **not shippable to Steam as-is**, whatever the appid
  says.
- Fixing it means promoting `steamworks.js` to a runtime `dependency` and
  admitting exactly `node_modules/steamworks.js/**` back into `build.files`
  (its prebuilt `.node` binary for `win32-x64` and nothing else) — narrowly, so
  the `!node_modules/**` exclusion keeps doing the job it was written for. That
  is a packaging change against a documented exclusion and it is not part of
  this slice.

### Swapping in the real appid

`480` is Spacewar, Valve's public test app. Invites and FriendsOnly lobbies do
behave on it, which is why it is a usable stand-in. When Valve issues the real
appid, change **both** numbers **in one commit**:

1. `steam_appid.txt` at the repo root — the dev-loop id. Steam reads this file
   when the game is launched outside the Steam client.
2. `DEV_APP_ID` in `desktop/steam.mjs` — the default `initSteam()` inits
   against.

They must not drift apart. `initSteam()` reads the running appid back from
`utils.getAppId()` rather than trusting what it passed in, so a mismatch shows
up in the status record instead of hiding, but a mismatch is still a bug.

`steam_appid.txt` must **stay excluded from packaged builds** — `build.files`
carries `!steam_appid.txt`, and the exclusion is verified after every pack. A
stray appid file inside a shipped build overrides what Steam tells the process
and breaks release-build detection. It is absent from the current packed output;
keep it that way.

**Then re-run this task**: the packaged smoke, and the two-seat checkpoint with
the real appid. The Spacewar result does not transfer — appid is what Steam
matches lobbies and invites on.

---

## 8. Can one box test the Conversation automatically?

Investigated 2026-08-15 for issue #53, because deleting the WebRTC Conversation
deletes `npm run probe:coop` — the project's only automated proof that two peers
ever meet. The decision this produced is
[ADR 0002](adr/0002-networking-coverage-after-webrtc.md). This section is the
evidence behind it.

The question splits into three, and they have three different answers.

### 8.1 Two Steam identities on one box: no

A Steam identity is an account, one Steam client runs per machine, and one
account plays one session at a time. Two peers on one box therefore means a
second Windows user session, a second Steam install, a second account and a
second interactive Steam Guard login that has to survive reboots. That is the
"human login for every gate" #53 rules out, and it would put Valve's backend on
the critical path of a test run.

Ownership is *not* the obstacle — Spacewar (appid 480) is free to every account.
The obstacle is that the Steam client is a single-session, interactive,
foreground process.

**[uncertain]** Whether two processes under *one* account can `ConnectP2P` to
each other at all is untested here. It does not change the answer: `ConnectP2P`
"uses the default rendezvous service ... on Steam, it goes through the steam
backend"
([isteamnetworkingsockets.h:116-127](https://github.com/ValveSoftware/GameNetworkingSockets/blob/e707b3a6b638f4de31ee3e13a64284bd9abfa98e/include/steam/isteamnetworkingsockets.h)),
so even a positive result buys a gate that needs a live login and a reachable
Valve backend.

### 8.2 Two real Steam connections inside one process: yes in the SDK

`ISteamNetworkingSockets::CreateSocketPair` exists precisely for this — Valve's
own words are *"very useful for testing, or so that our client/server code can be
compiled in a single process"*. Two connection handles, immediately connected,
closing either one posts the peer callback on the other *"exactly as if they were
communicating over the network"*. Passing `bUseNetworkLoopback = true` sends the
packets through 127.0.0.1 on ephemeral ports, which restores packetisation,
encryption **and fake lag and loss** — the default in-memory mode has none of
those
([isteamnetworkingsockets.h:392-417](https://github.com/ValveSoftware/GameNetworkingSockets/blob/e707b3a6b638f4de31ee3e13a64284bd9abfa98e/include/steam/isteamnetworkingsockets.h)).

Fake impairment is configured through `k_ESteamNetworkingConfig_FakePacketLag_Recv`
and friends
([steamnetworkingtypes.h:1419-1478](https://github.com/ValveSoftware/GameNetworkingSockets/blob/e707b3a6b638f4de31ee3e13a64284bd9abfa98e/include/steam/steamnetworkingtypes.h)),
which are receive-side and one-directional — the same shape as this repo's own
`?netlag=` rig, so `coopprobe`'s impaired arm is reproducible in principle.

`CreateListenSocketIP` / `ConnectByIPAddress` are the two-*process* version of the
same idea: ordinary UDP, no Steam identity in the path, so two Node processes on
one box can hold a real connection. Both still need `SteamAPI_Init`, hence a
running Steam client.

### 8.3 ...and no, not through either candidate Binding

This is the finding that decides it. Read against the published packages, not
their prose — `steamworks-ffi-node` is not installed in this tree, so its rows
come from the npm tarball
([`steamworks-ffi-node@0.10.4`](https://www.npmjs.com/package/steamworks-ffi-node/v/0.10.4),
downloaded and unpacked 2026-08-15; `package/dist/internal/SteamLibraryLoader.js`
is where every Koffi declaration lives, and it agrees with
[`src/internal/SteamLibraryLoader.ts`](https://github.com/ArtyProf/steamworks-ffi-node/blob/main/src/internal/SteamLibraryLoader.ts)
at that version):

| Binding | Conversation surface it actually exposes |
|---|---|
| `steamworks.js@0.4.0` (installed) | Four functions, all legacy `ISteamNetworking`: `sendP2PPacket`, `isP2PPacketAvailable`, `readP2PPacket`, `acceptP2PSession` — every one addressed by SteamID64. `node_modules/steamworks.js/client.d.ts`. |
| `steamworks-ffi-node@0.10.4` (the candidate) | 24 `NetworkingSockets` entry points. The only two that create anything are `CreateListenSocketP2P` and `ConnectP2P` — both identity-addressed. |

Neither package contains the string `CreateSocketPair`, `CreateListenSocketIP`,
`ConnectByIPAddress` or `SetGlobalConfigValue` anywhere. So on both the Phase 2
path and its `ISteamNetworking` fallback, **every way of opening a Conversation
is addressed by Steam identity**, and 8.1 applies to all of them. The loopback
facility that would make a single-box gate possible exists in Valve's library and
is not reachable from JavaScript today.

### 8.4 What it would take to reach it

Less than it sounds, and this is why the socket-pair arm is worth costing rather
than dismissing. `steamworks-ffi-node` is Koffi FFI over the flat C API in
`steam_api64.dll` — declarations are data, not C++, so there is no compiler and no
fork of native code involved. It obtains its interface pointers from
`SteamAPI_SteamNetworkingSockets_SteamAPI_v012()` and
`SteamAPI_SteamNetworkingUtils_SteamAPI_v004()`, both of which a test-only module
of ours can call the same way.

Four exported symbols, all present in Valve's flat header
([steamnetworkingsockets_flat.h:25-26, 44, 84](https://github.com/ValveSoftware/GameNetworkingSockets/blob/e707b3a6b638f4de31ee3e13a64284bd9abfa98e/include/steam/steamnetworkingsockets_flat.h)):

- `SteamAPI_ISteamNetworkingSockets_CreateSocketPair`
- `SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32` (fake lag / loss)
- `SteamAPI_ISteamNetworkingSockets_CreateListenSocketIP` (only if two processes
  are wanted as well)
- `SteamAPI_ISteamNetworkingSockets_ConnectByIPAddress` (likewise)

Cost: a small Koffi module under `tools/`, plus a running Steam client on the box.
It is a test-only surface and must never be reachable from shipping code.

**Built 2026-08-15 (#64): `tools/steamnet.mjs`, and the estimate held.** No
compiler, no patched package, no fork. Of the four entry points listed above,
**two are bound** — `CreateSocketPair` and `SetGlobalConfigValueInt32` — plus ten
support symbols it takes to carry a message. The other two are the two-process
arm, which this list already marks conditional and which nobody has asked for:
they are checked to exist in the DLL and deliberately not bound, so an SDK swap
that dropped one is still caught on the day of the swap. Section 8.7 has what it
measured. The test-only constraint is asserted
rather than remembered: `tests/steam-smoke.test.mjs` fails if anything under
`src/` or `desktop/` reaches for `koffi` or for that module, if `koffi` stops
being a devDependency, or if `build.files` starts packing `tools/`.

### 8.5 The seam, enumerated

Arm A is only as good as this list, so it is enumerated from what `NetHost`,
`NetClient` and `Lobby` actually reach for, not from what section 3 claims. Every
row is a member a Steam-backed transport must provide.

**The list is now machine-checked.** `tests/transport-contract.mjs` carries it as
data and ends with an assertion that it is *sufficient*: a peer **generated from**
the list — never hand-written alongside it, or the two drift — is driven through
the real host loop behind a `Proxy` that records any read outside it. The `events`
row gets a nested `Proxy` of its own against `CONTRACT.eventsChannel`, because
that is the one member the host reaches *through*, and an unguarded object handed
back by the outer trap would leave the riskiest row checked in name only. The
refusal path is driven too, so those reads actually happen.

Verified to bite rather than merely to pass. Three mutations, each caught:

| Mutation | Caught as |
|---|---|
| `NetHost` reaches for a fourth channel member (`peer.events.label`) | `saw events.label` |
| `pumpSim` dropped from the list alone | throw, **and** `saw pumpSim` |
| `bufferedAmount` dropped from the channel list | `saw events.bufferedAmount` |

So if `NetHost` grows a reach this table does not have — at either level — that
test fails, and this table is what gets fixed.

**On a peer:**

| Member | Where it is required | Note |
|---|---|---|
| `id` | `NetHost.js:152` and throughout | Stable, and the key of `HostTransport.peers`. |
| `sendState(bytes)` | `NetHost.js:590`, `NetClient.js:270` | Unreliable channel. |
| `sendEvent(bytes)` | `NetHost.js:181`, `NetClient.js:125` | Reliable channel. |
| `onMessage = (data, label, peer)` | `NetHost.js:146`, `NetClient.js:103` | `label` is `'state'` or `'events'`. |
| `onClose = () => {}` | `NetHost.js:147`, `NetClient.js:104` | Per-peer, and *distinct* from the transport's `onPeerLeave`. |
| `pumpSim()` | **`NetHost.js:532`** | Called unconditionally, every frame, with no optional chaining. A transport that omits it makes `NetHost.update` throw on the first frame with a connected client. `NetClient.js:456` guards it; the host does not. |
| `close()` | `NetHost.js:406`, `NetClient.js:236` | |
| `events.readyState` / `events.bufferedAmount` | **`NetHost.js:404-405`** | The one genuine leak. `_closeWhenFlushed` reads the raw `RTCDataChannel` to decide whether a refusal has drained before it hangs up. |

The last two rows are why "no gameplay code is touched" needs qualifying.
`pumpSim` exists only for the WebRTC `?netlag=` rig and is meaningless on a Steam
connection, yet it is on the contract because `NetHost` calls it — so a Steam peer
either implements it as a no-op or `NetHost.js:532` changes. The `events` read is
worse: it is `RTCDataChannel`'s vocabulary, in `NetHost`, and it needs a
transport-neutral replacement (a `drained()` predicate on the peer is the obvious
one) before #55 rather than after.

**On the host transport:** `onPeer`, `onPeerLeave`, `peers` (a `Map`, whose size
`Lobby` bounds), `broadcastEvent(bytes, except)`, `close()`.
`createInvite` / `cancelInvite` are rendezvous and therefore out of the portable
contract. Note `broadcastState` **has no caller anywhere in the tree** — `NetHost`
sends snapshots per peer at `NetHost.js:590` — so it is dead code today and does
not belong on the contract.

**On the client transport:** `join(inviteBlob)` (rendezvous), `onConnected`,
`onDisconnected`, `peer`.

**Where a transport is handed in.** `NetHost` and `NetClient` used to construct
their own (`new HostTransport()` / `new ClientTransport()` in the constructor),
which made "run the same assertions against both transports" impossible without
editing them. Both now take `{ transport }`, defaulted, so no existing caller
changed. `NetClient.attach(peer)` is the other half: the four statements that run
the instant a transport says "you are through" — adopt the peer, mark connected,
send HELLO, wire `onMessage`/`onClose` — split out of `join`, which is otherwise
pure Introduction. #55 implements against these two seams.

**Dying with WebRTC, not portable:** `trickle`, `onIceCandidate`,
`addIceCandidate` on both transports. `Lobby` uses all three
(`Lobby.js:338-339, 497, 694, 722`) and they have no Steam analogue — Steam does
its own route-finding.

### 8.6 A prerequisite discovered on the way, wider than #53

`steamworks-ffi-node` **does not bundle the Steamworks redistributable.** Its
loader looks for `steamworks_sdk/redistributable_bin/win64/steam_api64.dll`
relative to the project root and fails with a setup message if it is absent
(`package/dist/internal/SteamLibraryLoader.js:135` in the 0.10.4 tarball); its
postinstall says outright that *"due to Valve's licensing terms, the Steamworks
SDK redistributables cannot be bundled with this package and must be downloaded
separately"* from partner.steamgames.com (`package/postinstall.js`). The tarball
ships `prebuilds/{win32-x64,linux-x64,darwin-x64,darwin-arm64}/steam-overlay.node`
and no `steam_api64.dll` at all. `steamworks.js` ships a prebuilt binary
and needs no such step, so this is a new obligation that arrives with the Binding
swap: acquire the DLL, vendor it, and admit it to `build.files` alongside the
Binding in step 7. Tracked separately, because it blocks the swap (#54) rather
than the coverage question.

**Acquired and settled 2026-08-15.** SDK **1.64** is vendored, at
`steamworks_sdk/redistributable_bin/win64/steam_api64.dll`, with provenance, hash
and the licence position in `steamworks_sdk/README.md`. 1.65 was downloaded first
and rejected — see below. The zips are gitignored: 269 of 1.65's 270 entries are
headers, samples and build tooling, and six of them are stray `steam_appid.txt`
files that must never reach a packed build.

**The partner-account question is settled, and favourably: no partner approval was
required.** A Steam login is — `https://partner.steamgames.com/downloads/steamworks_sdk_165.zip`
answers `302` to a sign-in page for an unauthenticated client — but approval as a
partner is not, so the SDK is *not* on the Valve clock and the plan's decision to
put partner processing off the critical path survives this.

`npm run steamsdk` adopts an SDK zip and verifies what is vendored;
`node tools/steamsdk.mjs --zip <path>` swaps the DLL for a different SDK version.

#### And the SDK immediately falsified an assumption

`steamworks-ffi-node@0.10.4` targets SDK **1.64**, and 1.65 was what got
downloaded first. Every symbol the Binding declares in
`dist/internal/SteamLibraryLoader.js` was diffed against the 1.65 DLL's exports.
373 of 377 resolve. **Four do not:**

| Declared by the Binding | Present in SDK 1.65 | Cost if unfixed |
|---|---|---|
| `SteamAPI_SteamNetworkingSockets_SteamAPI_v012` | only `..._v013` | **The entire Conversation.** This is the accessor every `NetworkingSockets` call goes through. |
| `SteamAPI_SteamUtils_v010` | only `..._v011` | `utils.*` — including `getAppId()`, which `desktop/steam.mjs` reads back to detect an appid mismatch. |
| `SteamAPI_SteamInput_v006` | only `..._v007` | Steam Input, i.e. section 5's highest-risk item. |
| `SteamAPI_ISteamUtils_IsSteamRunningOnSteamDeck` | absent entirely | Deck detection. |

**And it fails late, not loudly.** The loader binds lazily by design — its own
comment says so, deferring `koffi.func()` symbol lookup to first call to save
"hundreds of ms" across ~200 functions. So a missing export does not fail at
`init()`. `initSteam()` reports `available: true`, the Introduction works, and the
first attempt to open a Conversation is where it dies. That is the worst available
failure shape and it is worth knowing before #52's spike, not during it.

**Decided and verified 2026-08-15: pair the Binding with SDK 1.64**, which is what
it targets. The alternative — patching the four version strings to v013 / v011 /
v007 — was rejected: it is a four-string change, but it assumes the flat functions
kept their signatures across an interface bump, and nothing available here can
check that assumption. Getting the matching SDK cost one more download.

**377 of 377 symbols resolve against 1.64**, measured by `npm run steamsdk` with
the Binding's loader in place. The accessor versions line up exactly —
`SteamNetworkingSockets_SteamAPI_v012`, `SteamNetworkingUtils_SteamAPI_v004`,
`SteamUtils_v010`, `SteamInput_v006` — and `IsSteamRunningOnSteamDeck` is present.
This is no longer an expectation.

**Re-run that check on every SDK bump.** It is the only thing standing between a
version bump and a Conversation that dies on first use, and it is one command.

None of this touches arm B: **all four symbols #64 wants —
`CreateSocketPair`, `SetGlobalConfigValueInt32`, `CreateListenSocketIP`,
`ConnectByIPAddress` — are exported by both 1.64 and 1.65**, confirmed by the same
scan. The socket-pair arm is reachable against the SDK now sitting in the tree,
and it was never the part at risk here.

### 8.7 Arm B, built: what the real Steam library actually costs

`npm run smoke:steam` (`tools/steamsmoke.mjs`). Captured 2026-08-15 against SDK
1.64 with a running Steam client on appid 480. Full write-up, including the
validity arms, in `reviews/net-baseline/STEAM-SOCKETPAIR.md`.

| | p50 | p95 | **p99** | max |
|---|---|---|---|---|
| `state` (unreliable, snapshots) | 0.147-0.151 ms | 0.195-0.199 ms | **0.23-0.24 ms** | 0.30-5.67 ms |
| `events` (reliable, ordered) | 0.154-0.156 ms | 0.193-0.196 ms | **0.21-0.28 ms** | 0.22-0.32 ms |

Three runs, 3 peers at 60 Hz for 30 s each, 1031-byte snapshots through the
shipped `writeEntity`. **1080 of 1080 reliable messages delivered exactly once,
in order; 16 200 of 16 200 snapshots delivered.**

**The FFI is not the cost anyone expected it to be.** The criterion agreed on #52
allowed 2.5x over WebRTC for "FFI and Steam-side overhead" — p99 5.0 ms for
`state`, 7.5 ms for `events`. The measurement came in 8-14x *below* the WebRTC
baseline rather than above it (p99 0.24 ms vs 2.0 ms; 0.26 ms vs 2.9-3.0 ms).
Chrome's SCTP data channels are the expensive part, not Koffi.

That is a fact about the *core loop*, not about Steam as a whole: a socket pair
has no Introduction, no identity, no SDR and no internet in it. It bounds what
the transport swap can cost per message; it says nothing about what forming a
session costs, which is arm C's question.

**Three things this arm proves that no other gate in this repo can:**

1. **The library carries this protocol.** Not a mock of it — the shipped
   `Protocol.js` byte layout through the shipped `steam_api64.dll`.
2. **Reliable means reliable, under loss.** With
   `k_ESteamNetworkingConfig_FakePacketLoss_Recv` at 5%, 5.2% of snapshots were
   dropped on the unreliable channel and every reliable message still arrived
   exactly once, in order, at a p99 of 61.2 ms as Steam retransmitted. That
   retransmission is the behaviour the whole arm was bought to watch.
3. **Loopback is genuinely on.** `--no-loopback` (the in-memory socket pair) is a
   further 4x faster at 0.037 ms p50, so the gate figure really is paying for
   packetisation, encryption and 127.0.0.1 — the thing section 8.2 says
   `bUseNetworkLoopback` buys.

**And the version discipline of 8.6 is built into the module rather than
documented next to it.** `tools/steamnet.mjs` discovers the interface accessor
from the DLL's exports (`SteamAPI_SteamNetworkingSockets_SteamAPI_v012` on 1.64,
`_v013` on 1.65) instead of naming a version, checks every symbol it declares
before `koffi.load`, and asks the library for each `ESteamNetworkingConfigValue`'s
real name before using its number. An SDK bump does not edit that file, and the
failure shape 8.6 warns about — lazy binding turning a missing export into a
first-call crash — cannot happen here.

**Still not a CI gate (#47).** `SteamAPI_Init` needs a running, logged-in Steam
client. That is the one part of the cost estimate no amount of care removes.
