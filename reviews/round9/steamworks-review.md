# Round 9 — Steamworks wiring: the slice's own record

Branch `slice/steamworks-wiring`, off `master @ 4aff655`. Plan:
`docs/superpowers/plans/2026-08-12-steamworks-wiring.md`. Ledger:
`.superpowers/sdd/2026-08-12-steamworks-wiring/progress.md`.

This is the record the slice merges on. It exists to state what was built, what
was proven, and — at greater length, because it is the part that matters — what
was **not**.

---

## 1. The headline, stated first

**The warm path — invite, join, co-op forms — is UNVERIFIED-BY-HUMAN.**

No two-machine test has been run. No second Steam account has ever received an
invite from this build, joined its lobby, read its offer, answered it, or
connected. The joiner half of `src/net/SteamLobby.js` has never met a real host.

It is not claimed to work. It is code with good coverage that has never done its
job. Two checkpoints below are the conditions under which that changes, and
neither has been met.

## 2. What was built

| Task | Commit | What landed |
|---|---|---|
| 1 | `b88889f` | `steamworks.js@0.4.0` pinned exact; guarded `initSteam()` in `desktop/steam.mjs`; the shipped API surface reconciled line-by-line against the real `.d.ts` and against the native binary's own exports |
| 2 | `e395c28` | `window.__STEAM__` — fourteen named functions over named IPC channels under `contextIsolation: true`; input validation main-side; overlay enabled conditionally pre-ready |
| 3 | `3f4a8e8`, `ced0855` | `src/net/SteamLobby.js` — chunk codec, `hostViaSteam`, `joinViaSteam`, invite handling; `Lobby.leave()` teardown; the co-op screen's Steam block |
| 4 | this round | Packaged smoke against the built exe; `docs/STEAM.md` section 7 and `desktop/README.md` brought to as-built |

Three plan drafts were corrected against reality in Task 1 (`LobbyType` nests
under `matchmaking`; all Steam ids are `bigint` and `JSON.stringify` throws on
those, so every id crosses the preload as a decimal string; the
`GameLobbyJoinRequested` payload is snake_case). A fourth correction was large
enough to need adjudication — section 3.

## 3. The design changed under the plan, and the change is load-bearing

The plan had the SDP blobs travelling both ways through lobby data. They cannot.
`steamworks.js@0.4.0`, read against its own native binary rather than its
typings, binds no `setLobbyMemberData`/`getLobbyMemberData`, no lobby chat, no
ownership transfer, no programmatic invite; and Valve documents `SetLobbyData`
as owner-only. The joiner has no way to write into lobby data at all.

Adjudicated (`adjudication-lobby-data.md`): **continue with redesign**, because
the *capability* — a joiner-to-host channel — exists under a different bound
name, and the plan's STOP clause keys on a missing capability, not a missing
mechanism.

As built: the offer goes host to joiner over chunked lobby data exactly as
planned; the answer returns as **one reliable `sendP2PPacket` to the lobby
owner**. The host accepts a P2P session only from a current member of its own
lobby, length-caps the packet, and parses it defensively in the main process.

**Accepted debt:** that answer leg rides `ISteamNetworking`, which Valve has
deprecated in favour of `NetworkingMessages`/sockets. It is what `0.4.0` binds
and what Valve's own Spacewar sample exercises, and `docs/STEAM.md` section 3's
Phase 2 replaces the transport wholesale. Bounded, and pointed at its successor.

## 4. Open checkpoint A — the two-seat Steam test (USER)

**Status: NOT RUN. Cannot be run unattended.** It needs two Steam accounts on
two machines.

The gesture: Host via Steam, invite a friend through the overlay, the joiner's
client auto-joins on `onJoinRequested`, co-op forms, five minutes of play.

Two constraints on whoever runs it:

- **Run it with `npm run desktop`, not the packed exe.** The packed build
  carries no `steamworks.js` (section 6) and cannot host or join.
- **The Spacewar result does not transfer to the real appid.** When Valve issues
  the real id, this checkpoint runs again — appid is what Steam matches lobbies
  and invites on.

Until it runs, section 1 stands unchanged.

## 5. Open checkpoint B — the overlay's visual confirmation (USER)

**Verdict: PROVISIONAL — no capability failure detected; the determinative
check is still open.**

Positive evidence, gathered and on disk: `gameoverlayrenderer64.dll` is resident
in the Electron 43.3.0 renderer process with Steam running, so the hook injects
and Electron does not block it. WebGL still reaches the discrete GPU with the
overlay's switches appended, so the `electronEnableSteamOverlay(true)` fallback
was not needed. The real UI path ran end to end against live Steam and
`openInviteDialog()` returned success.

**None of that can falsify the failure it matters to rule out.** A fully
non-compositing overlay would load the same DLL and return success from the same
call; `overlayStatus.ok` records only that `electronEnableSteamOverlay()` did not
throw. Injection is not painting. Read the evidence as "nothing is wrong yet",
not as "the overlay works".

The sentence that closes it, both halves, one sitting, eyes on the screen:

> Pressing **Shift+Tab** visibly draws the Steam overlay over the running game,
> and **Host via Steam -> Invite friend** on the co-op screen visibly opens
> Steam's friend-picker dialog on top of the game.

**If either does not appear, that is the STOP condition** in the plan's Global
Constraints. Do not ship a dead invite button; the Electron-bump decision goes to
the user. This is not a nicety — the binding ships no programmatic invite, so the
overlay dialog is the only invite path in existence.

Checkpoint A performs this gesture anyway, so it costs no extra sitting.

## 6. The gap Task 4 found: the packed build carries no Steam

`npm run desktop:pack` produces a folder that boots correctly — 13/13 probe
checks, `app://` serving the game, renderer isolated, bridge surface exact — and
whose `__STEAM__.status()` answers:

```
{"available":false,"appId":null,"personaName":null,
 "reason":"Cannot find module 'steamworks.js' ..."}
```

That is the degradation contract working precisely as designed, and the probe
passes on it. It also means **every packaged launch is a Steam-absent launch**.
`build.files` carries `!node_modules/**` (deliberately, to keep `three`'s source
tree out) and `steamworks.js` is a `devDependency`, so the native module is
excluded twice over.

The packed folder is the deliverable SteamPipe will be pointed at. **It is not
shippable to Steam as-is**, whatever the appid says. Recorded in
`docs/STEAM.md` section 7 and `desktop/README.md`; the fix (promote to a runtime
`dependency`, admit exactly `node_modules/steamworks.js/**`) is a packaging
change against a documented exclusion and was not made inside this slice.

`steam_appid.txt` is correctly **absent** from the packed output — verified by
searching the whole `win-unpacked` tree, not just `resources/app/`. A stray appid
file would override what Steam tells the process and break release-build
detection.

## 7. The Optimus trade-off, at its true severity

Enabling the overlay appends `in-process-gpu`. Exactly one thing degrades.

- **The player-facing path is UNAFFECTED.** `src/core/GpuTier.js`
  `probeRenderer()` reads `UNMASKED_RENDERER_WEBGL` off the live renderer
  context — measured with the overlay **on**, it still names the correct
  discrete adapter. The in-game warning a player sees is unchanged.
- **The secondary `gpu-info.json` support dump is DEGRADED**, 7049 bytes to
  1248, NVIDIA adapter entry gone. A support engineer gets a near-empty file.

Not "Steam players lose Optimus protection" — they do not. Baselines:
`reviews/round8/overlay/gpu-info-{before,after}.json`, same tree, same box,
minutes apart, differing only in `TELLURIC_NO_OVERLAY`. That variable is a
**developer tool and explicitly not a field-recovery mechanism**: nobody sets an
environment variable before double-clicking a game in their Steam library.

## 8. Binding constraints, held

- **No `src/` file imports Electron or steamworks.**
  `grep -rn "from ['\"].*\(electron\|steamworks\)" src/` -> no matches.
  `src/net/SteamLobby.js` names `window.__STEAM__` and nothing else, behind a
  `typeof window === 'undefined'` guard.
- **The web build does not change behaviour.** `npm run gate:sp` reports no
  fields moved, and it runs the real `dist/` in headless Chromium behind a
  `pageerror` gate — so the Steam-aware `Menus` constructor booting silently in
  a browser is gated, not asserted.
- **Renderer isolation is pinned, not trusted.** `tools/desktopprobe.mjs` asserts
  the `__STEAM__` key set as an exact list, so something *arriving* on the bridge
  goes red.

## 9. Verification (Task 4 run, 2026-08-13)

```
57/57 test files passed
single-player unchanged vs reviews/round7/baseline-00f8900.json — no fields moved
✓ built in 802ms
node tools/desktopprobe.mjs                 -> 13 passed, 0 failed   (dev, available:true)
node tools/desktopprobe.mjs --exe "..."     -> 13 passed, 0 failed   (packed, available:false)
packed tree: 0 *.map, 0 node_modules/, 0 steam_appid.txt
```

## 10. Still open at merge

1. **Checkpoint A** — the two-seat Steam test. Section 4. USER.
2. **Checkpoint B** — the overlay's visual confirmation. Section 5. USER, and a
   STOP condition if it fails.
3. **The packed build carries no Steam.** Section 6. Blocks any real SteamPipe
   upload; does not block merge.
4. **Appid `480`.** Both numbers change in one commit when Valve issues the real
   id, then checkpoints A and B re-run. Procedure in `docs/STEAM.md` section 7.
5. **Two seats only.** One answer ends the host's listen; a third player needs
   the offer re-minted and re-written.
6. **The joiner does not hear `P2PSessionConnectFail`** — main registers that
   callback only inside `startSignalListen`, which only the host calls. The
   joiner learns of failure from `sendSignal` erroring, the 60 s bound, and
   `Lobby`'s own `netDisconnected`. Flagged, not silently dropped.
7. **`setJoinable(false)` after connect** — optional, not exposed on the bridge,
   not done. Two seats are enforced by `hostLobby(2)`.
