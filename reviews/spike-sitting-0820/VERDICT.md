# #52 keyboard sitting — 2026-08-20/21 evening

Machine: the dev box. Steam client running, logged in ("Communism"), overlay enabled in
client settings (confirmed). Binding `steamworks-ffi-node@0.11.1`, Electron 43.3.0,
SDK 1.64 vendored. Raw instrument log: `sitting-log.jsonl` in this directory.

## Check 2 — overlay eyes-on: **FAIL, three arms**

Shift+Tab painted nothing in any arrangement; `ActivateGameOverlay('Friends')` fell back
to the desktop Steam client each time (the no-overlay-hooked signature). The invite
dialog (`ActivateGameOverlayInviteDialog`) showed nothing.

| Arm | Arrangement | Instruments | Eyes |
|---|---|---|---|
| native | Binding's `addElectronSteamOverlay` (GL mirror window) | `attachReturned: true`; module loaded (OpenGL); window created+shown; **zero `Frame N` debug lines — `beginFrameSubscription` never delivered one frame** | no paint |
| switches | `in-process-gpu` + `disable-direct-composition` (steamworks.js recipe, reimplemented) | `gameoverlayrenderer64.dll` **resident** (probe); process registered as Spacewar (Steam shutdown said "waiting on Spacewar to close") | no paint |
| switches+gl | above + `--use-angle=gl` | app rendered normally | no paint |

Injection and game registration are real; painting is not. The native arm's failure is
localized: Electron 43's compositor never fires `beginFrameSubscription` for a non-OSR
window, so the Binding's Windows mirror strategy starves. The switches arms fail
downstream of injection for reasons not yet localized (Electron-major instability is the
standing suspect — docs/STEAM.md already warns overlay behaviour is not stable across
Electron majors).

**Correction to the record:** docs/STEAM.md section 7's overlay row ("PROVISIONAL —
injection confirmed, painting unconfirmed" under steamworks.js) is now empirically
resolved in the negative direction for this box + Electron 43.3.0: the overlay has never
painted on this project under any binding or arrangement.

## Consequence found, load-bearing: the invite path does not die with the overlay

Unlike steamworks.js@0.4.0, this Binding declares:

- `steam.matchmaking.inviteUserToLobby(lobbyId, steamId)` (flat `InviteUserToLobby`) — send side, programmatic;
- `steam.friends.getAllFriends()` — enough for an in-game friend picker.

Joiner side: the invite arrives as a normal Steam client notification (no overlay
involved); acceptance reaches the app via Steam launch arguments (`+connect_lobby`) or
manual lobby-id entry. The Binding's callback table does NOT include
`GameLobbyJoinRequested` (333), so a *running* joiner app cannot hear an acceptance
without a small poller extension — a bounded #54 work item, not a wall.

#14's STOP condition as written ("no dead invite button ships") was authored when the
overlay dialog was the only invite path. That premise is dead: an overlay-less invite
path is code we control.

## Check 4 — lobby space: **provisional PASS (our direction)**

Unfiltered worldwide `requestLobbyList()` on appid 480 returned 50 foreign lobbies —
the Spacewar lobby space is shared and enumerable. Our FriendsOnly lobby did **not**
appear in the public scan (`oursListedInOwnScan: false`), so our invite flow does not
expose us. Consequence for #54/#55: any lobby *search* we ever ship must filter on a
game-specific data key, or it will enumerate strangers' Spacewar lobbies.

## Check 3 — peer visibility: **NOT RUN**

Needs machine B with the harness (`--joiner <lobbyId>`); deferred when the overlay
investigation consumed the sitting.

## Open decision (user's): overlay direction

(a) build the overlay-less invite path and demote the overlay to polish; (b) spend a
timeboxed experiment on an older Electron major to test "43 broke it"; (c) both — (a) as
the plan of record, (b) as evidence for whether the overlay row stays failed; (d) escalate
to the Binding upstream (the dead frame subscription is a reportable bug).
