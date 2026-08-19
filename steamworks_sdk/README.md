# Vendored Steamworks redistributable

One file, deliberately. `steamworks-ffi-node` is Koffi FFI over Valve's flat C API
and ships no redistributable of its own — its loader searches for
`steamworks_sdk/redistributable_bin/win64/steam_api64.dll` relative to the project
root and fails if it is absent. This directory is that path. See
[`docs/STEAM.md`](../docs/STEAM.md) section 8.6.

| | |
|---|---|
| Source | `steamworks_sdk_164.zip`, downloaded 2026-08-15 from partner.steamgames.com |
| SDK version | **1.64** — chosen to match `steamworks-ffi-node@0.10.4`, not because it is newest |
| File | `redistributable_bin/win64/steam_api64.dll`, 317 080 bytes |
| SHA-256 | `EB17909A76668CF9AE0B92A618A34A50F6C73D3A6787CB4DD8CE36A8B10BFB75` |

## Why only this file

The zip holds 270 entries; 269 of them are headers, the `steamworksexample`
sample, and content-builder tooling that nothing here compiles or runs. Unpacking
it wholesale would also import six stray `steam_appid.txt` files under
`sdk/steamworksexample/`, and this repo has a standing rule that no
`steam_appid.txt` may reach a packed build (`desktop/README.md:76-79`,
`docs/STEAM.md` section 7). The zip itself is gitignored.

`steam_api64.lib` is not vendored: it is an import library for C++ linking, and
Koffi loads the DLL at runtime instead.

## Licence

The Steamworks SDK is governed by the Steamworks SDK Access Agreement accepted on
the partner site; it is not shipped as a file inside the zip. Redistributing
`steam_api64.dll` *as part of a game* is what the file is for. Redistributing the
SDK itself is not. **This repository is private, and that is load-bearing for this
directory** — if it is ever made public, this file needs a decision rather than a
default.

## Why not the newest SDK

Because newest is the wrong axis. SDK **1.65** was downloaded first and does not
pair with the Binding: four of the 377 symbols `steamworks-ffi-node@0.10.4`
declares are absent from its DLL, including
`SteamAPI_SteamNetworkingSockets_SteamAPI_v012` — the accessor every
`NetworkingSockets` call goes through. 1.65 exports `_v013` and nothing older.
`SteamUtils_v010` → `_v011` and `SteamInput_v006` → `_v007` moved the same way,
and `IsSteamRunningOnSteamDeck` is gone entirely.

1.64 carries exactly the versions the Binding names, verified rather than assumed:

```
SteamNetworkingSockets_SteamAPI -> v012      SteamUtils -> v010
SteamNetworkingUtils_SteamAPI   -> v004      SteamInput -> v006
```

**Re-check this on every SDK bump — it is one command:**

```
npm run steamsdk                          # verify what is vendored
node tools/steamsdk.mjs --zip <sdk.zip>   # adopt a different SDK, then verify
```

## Two checks, not one

`npm run steamsdk` reads names out of the DLL's bytes in plain node. It is fast, it
needs no Steam client, and it is the check that catches an SDK bump like 1.65. It
cannot tell you whether koffi can actually resolve those names *inside the runtime
that ships*, which is Electron and not node.

`npm run steamsdk:electron` (`tools/steam-electron-init.mjs`) answers that. It boots
under Electron, opens the DLL through the Binding's own loader, forces every one of
the 377 lazily-bound lookups immediately, then calls `SteamAPI_InitSafe`. Run it on
an SDK bump, an Electron bump, or a `steamworks-ffi-node` bump. A false
`SteamAPI_InitSafe` there means no logged-in Steam client and is reported separately
from the symbol verdict — the symbol question is answerable without one.

Verified against SDK 1.64 + `steamworks-ffi-node@0.11.1` + Electron 43.3.0:
377/377 resolved, `InitSafe` true. Records in `reviews/steam-binding/`.

It exits non-zero if any symbol the installed Binding declares is absent from the
DLL, naming the version the DLL carries instead. Against 1.64 with the Binding
present: **377 of 377 present**. Against 1.65: four missing.

That check earns its keep because the Binding resolves symbols **lazily** — a
missing export does not fail at `init()`, it fails the first time a Conversation
is opened. Whenever this file changes, update the table above with the new hash
and version.
