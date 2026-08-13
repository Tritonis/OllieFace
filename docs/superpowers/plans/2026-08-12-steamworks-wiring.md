# Steamworks Wiring (Desktop Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Electron shell speaks Steam: guarded steamworks.js init in the main process, a minimal renderer bridge, and Steam-lobby signalling so two Steam friends connect co-op with an invite instead of a room code — all inert in the web build and when Steam isn't running.

**Origin:** `docs/STEAM.md` §2's phased recommendation — **Phase 1: keep the WebRTC transport, replace signalling only with Steam lobbies** (`matchmaking.createLobby/joinLobby`, `Lobby.setData/getData` for SDP, `openInviteDialog`, `GameLobbyJoinRequested`); Phase 2 (Steam sockets transport) is post-launch and OUT of this plan. The desktop-shell plan (`2026-08-09-desktop-shell.md`) explicitly deferred this work to when the Steam process started; the user started it 2026-08-12. Until the real app id arrives, development runs against **app id 480 (Spacewar)**, Valve's public test id.

**Architecture:** All Steam API calls live in the Electron **main process** (steamworks.js is a native N-API module; the renderer never touches it). A new `desktop/steam.mjs` owns guarded init and exposes a narrow IPC surface; `desktop/preload.cjs` grows a `window.__STEAM__` bridge next to the existing `window.__DESKTOP__` (`desktop/preload.cjs:10-14`). On the renderer side, one new module `src/net/SteamLobby.js` implements host/join with the *same resolution shape* as `Lobby.hostViaRelay`/`joinViaRelay` (`src/net/Lobby.js:244/:292`), exchanging **non-trickle** SDP blobs through chunked lobby data — the manual-join path (`Lobby.joinManual`, :175) already proves whole-blob, no-trickle exchange works, so no ICE-candidate streaming is needed. In a browser or with Steam absent, `window.__STEAM__` is undefined/`available: false` and every Steam path is dead code.

**Tech Stack:** steamworks.js (exact-pinned devDep), Electron 43.3.0 (already pinned — any bump re-verifies the overlay per `desktop/README.md:187-190`), Playwright `_electron` (existing probe driver).

## Global Constraints

- **API names are verified, never assumed.** steamworks.js's surface moved between minor versions and its npm release (0.4.0) lags its repo. Task 1 installs it and reads the shipped `.d.ts`; **every later task's Steam call names are drafts to be reconciled against those typings.** If a named call doesn't exist, find its real name in the typings and record the mapping in the task report; if a *capability* is missing (no lobby data, no invite dialog), STOP the slice and report — do not polyfill.
- **The web build must not change behaviour**: no `src/` file may import Electron or steamworks; `src/net/SteamLobby.js` guards on `window.__STEAM__?.available` and is otherwise inert. Gates: `node tests/run.mjs` green, `npm run gate:sp` zero moved, `npm run build` succeeds.
- **Steam-absent desktop must degrade silently**: init failure (Steam not running, no appid) → `available: false`, the co-op screen shows its existing relay/manual paths, zero dialogs, zero throws. The shell's boot must not slow down (init on `app.whenReady`, non-blocking).
- **Renderer security posture holds** (desktop-shell plan): `contextIsolation: true`, `nodeIntegration: false`; the preload exposes only the functions this plan names; lobby data from other peers is **untrusted input** — length-cap and JSON-parse defensively in the main process before it crosses to the renderer.
- **`steam_appid.txt` is dev-only**: repo root, containing `480`, gitignored? No — commit it (it is not a secret and the desktop dev loop needs it), but the electron-builder config must EXCLUDE it from the packaged app (shipping builds get the appid from Steam itself; a stray appid file breaks release-build detection). Add the exclusion in the same task that creates the file.
- **Never run bare `npx`.** Install: `npm install --save-dev --save-exact steamworks.js@<version resolved via npm view>`. Note: the electron binary pin has an explicit postinstall (memory: electron-pin-has-no-postinstall) — after any install, verify `node_modules/electron` still carries its binary before running desktop scripts.
- **Bash tool is ASCII-only**; Unicode via Write/Edit. No report prose through heredocs.
- **Branch:** `slice/steamworks-wiring`. Commit style: single evocative sentence + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. **Line citations are signposts** — the live file wins.

---

### Task 1: Install, verify the surface, guarded init

**Files:**
- Modify: `package.json` (devDep + any electron-builder `files` exclusion for `steam_appid.txt`)
- Create: `steam_appid.txt` (content: `480`)
- Create: `desktop/steam.mjs`
- Modify: `desktop/main.mjs` (init call on ready; any command-line switches steamworks.js's Electron guide requires)
- Test: `desktop/steam.test.mjs`? No — `tests/run.mjs` globs `tests/*.test.mjs`; put it at `tests/desktop-steam.test.mjs` and have it import `desktop/steam.mjs`'s pure parts only

**Interfaces:**
- Produces: `desktop/steam.mjs` exporting:

```javascript
// initSteam(appIdOverride) -> { available: boolean, appId: number|null, personaName: string|null, reason: string|null }
// getClient() -> the steamworks client object or null   (main-process internal; never crosses IPC)
```

  `initSteam` wraps `require('steamworks.js').init(appId)` in try/catch; every failure path returns `available: false` with `reason` (string, log-only). It also starts the callback pump if the typings expose one (steamworks.js historically needs `runCallbacks` on an interval or handles it internally — **the typings/README decide**; whatever they prescribe for Electron, do exactly that, including any `app.commandLine.appendSwitch` lines their Electron section requires — read `node_modules/steamworks.js/README.md`).
- Produces: the reconciliation record — the task report lists every API name this plan drafts (`init`, `matchmaking.createLobby`, `LobbyType.Private`/`FriendsOnly`, `lobby.setData/getData/join/leave`, `lobby.id`, `overlay.activateInviteDialog` or `openInviteDialog`, the `GameLobbyJoinRequested`-equivalent callback, `localplayer.getName`) against the real name found in the shipped `.d.ts`, one line each. Later tasks read this table.

- [ ] **Step 1:** `npm view steamworks.js version` → install exact. Read `node_modules/steamworks.js/*.d.ts` and `README.md`. Write the reconciliation table FIRST — it steers everything after.
- [ ] **Step 2: Write the failing test** (`tests/desktop-steam.test.mjs`): imports `initSteam`, calls it in the plain-node test process where the native module either loads without Steam or throws → assert it returns `{ available: false, reason: <non-empty string> }` and does not throw. (This is the guarded-degradation contract; it is testable precisely because the harness box has no Steam running under tests.)
- [ ] **Step 3:** Implement `steam.mjs` + create `steam_appid.txt` + the electron-builder exclusion (`desktop-shell` plan put the builder config in `package.json` or `electron-builder.yml` — find it, add `"!steam_appid.txt"` to its `files` idiom). Wire `initSteam()` into `desktop/main.mjs` on ready, storing the status object module-level.
- [ ] **Step 4:** `node tests/run.mjs` green. Then the live check: `npm run desktop` **with Steam running** on this box — main-process log shows `available: true, appId: 480, personaName: <the user's>`, and Spacewar shows as "playing" in the Steam client. If Steam is not running/installed on this box, run the negative arm only, mark the positive arm as a **USER CHECKPOINT**, and say so plainly in the report.
- [ ] **Step 5: Commit.**

---

### Task 2: The renderer bridge — `window.__STEAM__`

**Files:**
- Modify: `desktop/main.mjs` (ipcMain handlers), `desktop/preload.cjs`
- Test: extend `tests/desktop-steam.test.mjs` for any pure helpers; bridge behaviour is probe-verified in Task 4

**Interfaces:**
- Produces, on `window.__STEAM__` (all via `ipcRenderer.invoke` → `ipcMain.handle`, async; names exact):

```javascript
status()                      // -> { available, appId, personaName }
hostLobby(maxMembers)         // -> { lobbyId: string } | { error: string }   (FriendsOnly lobby)
setLobbyData(lobbyId, key, value)   // -> { ok } ; main enforces: key matches /^sdp\./, value.length <= 7000
getLobbyData(lobbyId, key)    // -> { value: string|null }
joinLobby(lobbyId)            // -> { ok } | { error }
leaveLobby(lobbyId)           // -> { ok }
openInviteDialog(lobbyId)     // -> { ok }
onJoinRequested(cb)           // main pushes the GameLobbyJoinRequested lobbyId via ipcRenderer.on('steam:join-requested')
```

  LobbyIds cross the bridge as **strings** (they are 64-bit SteamIDs; JS numbers corrupt them — the typings will confirm whether the lib hands out BigInt/string/object; normalise to string at the bridge, both directions).
- Produces: main-side validation — every handler checks `available` first and returns `{ error: 'steam-unavailable' }` cold; `setLobbyData` enforces the key-prefix and length caps (untrusted-input constraint).

- [ ] **Step 1:** Implement handlers in `main.mjs` against the Task-1 reconciliation table; extend `preload.cjs` following its existing two-function idiom exactly (`desktop/preload.cjs:1-15` — same contextBridge call, nothing else exposed).
- [ ] **Step 2:** Smoke via Electron: `npm run desktop`, devtools console: `await window.__STEAM__.status()` → the Task-1 status; `hostLobby(4)` → a lobbyId string (Steam running required — otherwise assert the cold `{ error }` shape and mark the warm arm for Task 4's checkpoint).
- [ ] **Step 3: Commit.**

---

### Task 3: `SteamLobby.js` — signalling over lobby data

**Files:**
- Create: `src/net/SteamLobby.js`
- Modify: `src/ui/Menus.js` co-op screen — a "Steam" path shown only when `window.__STEAM__` resolves `available: true`: host side gets **"Host via Steam"** + **"Invite Friend"** buttons; join side is automatic via `onJoinRequested`
- Modify: `src/net/Coop.js` or wherever the engine registers lobby lifecycles — mirror however `hostViaRelay`'s result is consumed (read the call site of `hostViaRelay` first: `grep -rn "hostViaRelay\|joinViaRelay" src/`)
- Test: `tests/steamlobby.test.mjs` (new — chunking/assembly logic only, pure)

**Interfaces:**
- Consumes: `window.__STEAM__` (Task 2); `Lobby`'s manual, non-trickle blob flow — host: `createInvite()` produces the offer blob (`src/net/Transport.js:379`); join: `joinManual(inviteBlob)` returns the answer blob (`src/net/Lobby.js:175`); host `accept(answerBlob)` completes. Read all three live before writing a line.
- Produces: chunk codec, exported pure for tests:

```javascript
chunkBlob(prefix, blob)      // -> [[`${prefix}.n`, String(count)], [`${prefix}.0`, part], ...]  parts <= 6000 chars
assembleBlob(getter, prefix) // -> string|null  (null until all `${prefix}.n` chunks present)
```

- Produces: the signalling dance over lobby data (keys: `sdp.offer.*` host→joiner, `sdp.answer.<joinerSteamId>.*` joiner→host — per-joiner namespacing so a second joiner never collides), with 1 s polling via `getLobbyData` and a 60 s bounded wait each direction. Only the **lobby owner** can write lobby data in Steam's model — **verify in the typings** whether members can set data; if not (likely), the joiner's answer travels via the member-data variant (`setLobbyMemberData`/`getLobbyMemberData` — check the reconciliation table; this asymmetry is the one real API risk in this slice, resolve it in Step 1 before writing the dance).
- Produces: `hostViaSteam()` → `{ lobbyId }`, resolving when the peer connection opens — same downstream consumption as `hostViaRelay`; `joinViaSteam(lobbyId)` → resolves like `joinViaRelay`. Both clean up (leaveLobby) on failure and on `Lobby`'s existing teardown path (find `Lobby`'s dispose/leave handling and hook it — leaked Steam lobbies outlive tabs).

- [ ] **Step 1:** Resolve the member-data question from the typings; record it. **Write the failing chunk-codec test**: round-trip a 20 kB random-ish string through `chunkBlob`/`assembleBlob` (fake getter over a Map), assert reassembly identity, `null` while one chunk withheld, and every part under the cap.
- [ ] **Step 2:** Run to verify failure, implement the codec, green.
- [ ] **Step 3:** Implement the dance + UI path. The co-op screen buttons follow the existing screen's chip/button idiom; no new styling.
- [ ] **Step 4:** `node tests/run.mjs` green; `npm run gate:sp` zero moved; `npm run build` (web) succeeds and `grep -rn "steamworks\|electron" src/` shows no new imports (inertness proof — `SteamLobby.js` may name `window.__STEAM__` only).
- [ ] **Step 5: Commit.**

---

### Task 4: End-to-end and the packaged build

- [ ] **Step 1:** Packaged smoke: `npm run desktop:pack`, launch the packed exe via the desktop-shell plan's Playwright `_electron` probe (its location/idiom: see the probe the desktop-shell slice landed — `grep -rn "_electron" tools/ tests/`), assert boot + `__STEAM__.status()` shape (either arm).
- [ ] **Step 2 — USER CHECKPOINT (two-seat Steam test):** needs two Steam accounts on two machines (or one machine + Steam Family second box): Host via Steam → Invite Friend → overlay invite → joiner's client auto-joins via `onJoinRequested` → co-op forms → 5 minutes of play. Overlay verification rides along (shift+tab both seats; `desktop/README.md:187-190` caveat). Until this checkpoint runs, the slice merges with the warm path marked UNVERIFIED-BY-HUMAN in the review file — never claimed as working.
- [ ] **Step 3:** Docs: `docs/STEAM.md` gains a "wired" status table (init ✓, bridge ✓, lobby signalling ✓ / overlay pending / appid swap pending) and the **appid swap step**: when Valve issues the real id, change `steam_appid.txt` + the `initSteam` default in one commit and re-run this task. `desktop/README.md` gains the steamworks version + the same Electron-bump re-verify warning it already carries for the overlay.
- [ ] **Step 4:** Merge per superpowers:finishing-a-development-branch; review file `reviews/round9/steamworks-review.md`.

## Explicitly out of scope

- Steam sockets transport (STEAM.md Phase 2, post-launch; TURN stays the WebRTC fallback and the web build keeps the relay).
- Achievements, stats, rich presence, Steam Input, Deck detection — each needs partner-site config against the real appid; separate slices once the id exists.
- Steam Cloud — nothing to code (saves are already one JSON under `userData`; Cloud is auto-cloud partner-site configuration, a user task recorded in STEAM.md).
- SteamPipe upload / depot layout — needs the real appid and a human.
