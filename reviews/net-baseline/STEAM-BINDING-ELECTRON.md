# The socket-pair gate re-measured through the Binding, under Electron

Issue #52, the requirement decided 2026-08-20: the 3-peer 60 Hz smoke that
[STEAM-SOCKETPAIR.md](./STEAM-SOCKETPAIR.md) discharged with `tools/steamnet.mjs` — this
repo's own test-only Koffi declarations, in bare node — must be re-run through
**`steamworks-ffi-node`'s send/receive path under Electron** before the gate can be
declared passed. That earlier run's own closing section said as much: *"Not the Binding."*

Captured 2026-08-20 on `master`, Binding **0.11.1**, SDK **1.64**, Electron **43.3.0**
(node 24.18.1, chrome 150), appid 480, Steam client running and logged in.

## What path the bytes actually took

`tools/steamnet-binding.mjs` provides the same surface `tools/steamnet.mjs` does, backed by
the Binding's own loader and the Binding's own Koffi declarations:

| Call | Whose declaration |
|---|---|
| `SteamAPI_InitSafe`, `SteamAPI_Shutdown`, `SteamAPI_RunCallbacks` | Binding |
| `SteamNetworkingSockets_SteamAPI_v012` (interface accessor) | Binding |
| **`SendMessageToConnection`** | **Binding** |
| **`ReceiveMessagesOnConnection`** | **Binding** |
| **`FlushMessagesOnConnection`** | **Binding** |
| **`SteamNetworkingMessage_t_Release`** | **Binding** |
| `ISteamNetworkingSockets_RunCallbacks`, `CloseConnection` | Binding |
| `CreateSocketPair` | **not declared by the Binding** |

`CreateSocketPair` is the one symbol no Binding binds, and without it no automated test on a
one-identity box can open a real Steam connection at all. It is resolved here with
`lib.func(...)` **on the library handle the Binding's own loader opened** — same
`koffi.load` result, same DLL image, same process — so there is no second FFI layer and the
connection handles the hot path uses were made by the Binding's own interface pointer.

**So: the socket pair's construction is not the Binding's code; every byte sent and received
afterwards is.** Each record carries this boundary in `steam.viaBinding` /
`steam.notViaBinding`. The one other deviation from `steamnet.mjs` is on the receive side:
the payload is copied out with `koffi.decode(..., koffi.array('uint8', n, 'Typed'))` rather
than `koffi.view()`. Same copy, same moment, one fewer N-API object — `koffi.view()`
registers an external ArrayBuffer per message, and under Electron a few thousand a second
**fatal the process** (`FATAL ERROR: Error::New napi_get_last_error_info`) about four
seconds into 60 Hz traffic. That crash is a real property of the `view()` idiom under
Electron and is worth remembering before any shipping code copies it.

**Errata (review, 2026-08-20):** the runs recorded below were made before two defects found
in review were fixed, so their JSON metadata misstates itself in two places: the top-level
`transport` field names `tools/steamnet.mjs` (the run actually went through
`tools/steamnet-binding.mjs` — the `steam.viaBinding` sub-object is the correct provenance),
and `bounded.recvDrainBatchesPerCall` reads 64 while the governing constant in the binding
module was actually 4 — an undisclosed second deviation from `steamnet.mjs`, since aligned
to 64. Delivery counts are unaffected. **Resolved same day:** both binding-arm records were
regenerated wholesale on the quiet box after the fixes (see the settled numbers below);
every JSON in this directory now carries correct top-level metadata.

## The numbers, and why they do not settle the gate

Criterion, unchanged from #52: 3 peers, 60 Hz, 30 s sustained; **zero** dropped/duplicated/
reordered reliable messages; p99 `state` <= 5.0 ms, p99 `events` <= 7.5 ms.

| Run | reliable lost/dup/ooo | state p50 / p99 | events p50 / p99 | maxSendGapMs |
|---|---|---|---|---|
| **Binding + Electron** (`steam-binding-electron-3peer-60hz.json`) | **0/0/0** (360/360) | 0.201 / **19.68** ms | 0.217 / **42.06** ms | 299 |
| Binding + bare node (`steam-binding-node-3peer-60hz.json`) | 0/0/0 (360/360) | 0.218 / 85.85 ms | 0.246 / 80.89 ms | — |
| **Control: `steamnet.mjs` + bare node, today** (`steam-socketpair-control-0820.json`) | 0/0/0 (360/360) | 0.210 / **98.53** ms | 0.228 / **88.58** ms | — |
| For reference: the same control, 2026-08-15 | 0/0/0 | 0.147 / 0.24 ms | 0.154 / 0.26 ms | 18.6 |

The control is the point. **The unchanged, previously-green `steamnet.mjs` path re-run on
this box tonight fails the same criterion by 20x** — 98.5 ms p99 where it recorded 0.24 ms
five days ago. The box is not quiet: `maxSendGapMs` of 299 ms and 5.6 M loop iterations
(against 9.6 M in the green run) say the measuring loop was being starved, and a starved
poll loop times its own delay in as latency.

So tonight's numbers separate cleanly into two claims:

- **Delivery: pass, and unambiguous.** 360/360 reliable messages through the Binding under
  Electron — zero lost, zero duplicated, zero out of order — and 5400/5400 unreliable
  snapshots, at the full offered load of 185 580 B/s for 30 s. Nothing about a loaded box
  makes that result generous.
- **Latency: not measurable tonight, and therefore not adjudicated.** Every arm including
  the control is red, so the reds say something about the box, not about the Binding. The
  one thing that *is* comparable is the within-session ordering: the Binding under Electron
  was the **fastest** of the three arms measured tonight, better than the reference
  implementation in the runtime that reference was tuned for. Per-run p50 (0.20-0.22 ms
  across all three arms, and 0.147 ms on the quiet box) says the FFI hot path itself is
  unchanged; the tails are the loop.

**Verdict at the time of the loaded-box runs: delivery discharged, latency deferred to a
quiet box.** That re-run happened the same evening; the section below settles it.

## The quiet-box re-run (2026-08-20, later the same evening): latency PASS

Same criterion, same commands, box idle (all batch agents finished), fixed harness
(drain bound 64, correct metadata). Same-session control per the evidence regime.

| Run | reliable lost/dup/ooo | state p50 / p99 | events p50 / p99 |
|---|---|---|---|
| **Binding + Electron** (`steam-binding-electron-3peer-60hz.json`, regenerated) | **0/0/0** (360/360) | 0.177 / **0.28** ms | 0.193 / **0.296** ms |
| Binding + bare node (`steam-binding-node-3peer-60hz.json`, regenerated) | 0/0/0 (360/360) | 0.168 / 0.40 ms | 0.17 / 0.486 ms |
| Control: `steamnet.mjs` + bare node, same session (`steam-socketpair-control-0820-quiet.json`) | 0/0/0 (360/360) | 0.168 / 0.405 ms | 0.17 / 0.497 ms |

Against the WebRTC envelope: state p99 0.28 ms vs 2 ms (0.14x), events p99 0.296 ms vs
3 ms (0.10x). The control is green in the same session, so the numbers are the Binding's,
not the box's — and the Binding under Electron was again the fastest arm measured.

**Verdict: the gate's throughput criterion — delivery and latency both — is discharged
through `steamworks-ffi-node`'s own declarations under Electron.** What remains of #52 is
exactly its three keyboard-blocked checks: overlay eyes-on, peer visibility, lobby space.
(The tracked `steam-socketpair-3peer-60hz.json` remains the 2026-08-15 #64 baseline; the
same-session control was saved under its own dated name instead of overwriting it.)

## Re-running

```
npm run steamsdk            # DLL exports: 381/381, incl. all 377 the Binding declares
npm run steamsdk:electron   # koffi resolves all 377 under Electron; InitSafe -> true
npm run smoke:steam:binding # this measurement
npm run smoke:steam         # the same-session control it must be read against
```

`steamsdk:electron`'s record is `steam-electron-init.json`. Both smoke arms need a running,
logged-in Steam client, and the Steam library's settings are global — never two at once.
Impairment (`--lag-ms`, `--loss-pct`) is unavailable on `--via binding`: the Binding does not
declare `SetGlobalConfigValueInt32`, and asking for it throws rather than silently running
unimpaired. Those validity arms stay with `tools/steamnet.mjs`, whose job is the library.
