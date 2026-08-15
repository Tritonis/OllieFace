# Vendored Steamworks redistributable

One file, deliberately. `steamworks-ffi-node` is Koffi FFI over Valve's flat C API
and ships no redistributable of its own — its loader searches for
`steamworks_sdk/redistributable_bin/win64/steam_api64.dll` relative to the project
root and fails if it is absent. This directory is that path. See
[`docs/STEAM.md`](../docs/STEAM.md) section 8.6.

| | |
|---|---|
| Source | `steamworks_sdk_165.zip`, downloaded 2026-08-15 from partner.steamgames.com |
| SDK version | **1.65** |
| File | `redistributable_bin/win64/steam_api64.dll`, 319 128 bytes |
| SHA-256 | `E6D9BAFB9A41E42FBA7B21553DB49F8719027AF3F0DEB23FF86CFC44D60E776D` |

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

## Version warning

SDK 1.65 does **not** match what `steamworks-ffi-node@0.10.4` targets, and four of
its declared symbols do not exist in this DLL — including
`SteamAPI_SteamNetworkingSockets_SteamAPI_v012`, the accessor every
`NetworkingSockets` call goes through. **The decision is to replace this file with
SDK 1.64's**, which is what the Binding targets; 1.65 is what was to hand.

Do not take that on trust:

```
npm run steamsdk                          # verify what is vendored
node tools/steamsdk.mjs --zip <sdk.zip>   # adopt a different SDK, then verify
```

It exits non-zero if any symbol the installed Binding declares is absent from the
DLL. That check matters because the Binding resolves symbols **lazily** — a
missing export does not fail at `init()`, it fails the first time a Conversation
is opened. Then update the table above with the new hash and version.
