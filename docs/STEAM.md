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

**Phase 2 — post-launch, optional.** Swap the transport for Steam sockets, then
delete TURN and STUN too.

**The good news for Phase 2:** this codebase is already sitting on the right
seam. `NetHost` and `NetClient` touch a peer through exactly three methods —
`sendState`, `sendEvent`, `onMessage` — plus `onPeer`/`onPeerLeave`/`close` on
the transport. A Steam-backed transport implementing that same shape drops in
without touching a line of gameplay code. The refactor the research recommends
doing first has, in effect, already been done.

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
