# Steam-layer smoke on one box: what the real Steam library costs

Arm B of [ADR 0002](../../docs/adr/0002-networking-coverage-after-webrtc.md). Issue #64.

Captured 2026-08-15 on `master`, against SDK **1.64**
(`steamworks_sdk/redistributable_bin/win64/steam_api64.dll`, 317 080 bytes) with a running,
logged-in Steam client, appid 480. This is the first and only automated measurement in this
repo taken **through the shipping Steam library rather than a substitute for it**.

## The headline

| | p50 | p95 | **p99** | max |
|---|---|---|---|---|
| `state` (unreliable, snapshots) | 0.147-0.151 ms | 0.195-0.199 ms | **0.23-0.24 ms** | 0.30-5.67 ms |
| `events` (reliable, ordered) | 0.154-0.156 ms | 0.193-0.196 ms | **0.21-0.28 ms** | 0.22-0.32 ms |

**Reliable delivery: 1080 of 1080 messages across three runs. Zero lost, zero duplicated,
zero out of order.** Unreliable delivery: 16 200 of 16 200 snapshots, zero lost. Ranges are
the spread across three independent runs.

Against the WebRTC baseline this is **not a cost, it is a saving**: p99 `state` 0.24 ms vs
2.0 ms, p99 `events` 0.26 ms vs 2.9-3.0 ms. Steam's `NetworkingSockets` over 127.0.0.1 is
roughly **8-14x cheaper on the core loop** than Chrome's SCTP data channels, FFI included.
The 2.5x allowance the criterion granted for "FFI and Steam-side overhead" was not needed.

### The criterion, and the verdict

The pass criterion agreed on #52 **before** any Steam run existed, applied unchanged:

| Check | Limit | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| reliable lost / duplicated / out of order | 0 | 0/0/0 | 0/0/0 | 0/0/0 |
| p99 `state` | <= 5.0 ms | 0.242 | 0.240 | 0.230 |
| p99 `events` | <= 7.5 ms | 0.262 | 0.277 | 0.214 |

Three green runs. The verdict is computed by `tools/netstats.mjs` and written into every
record as a `gate` block, so a record states its own pass/fail without reference to this
document.

## The files, and the command that produced them

```
npm run smoke:steam
```

which is exactly:

```
node tools/steamsmoke.mjs --peers 3 --hz 60 --entities 60 --run-s 30 --warmup-s 3 \
  --label steam-socketpair-3peer-60hz
```

- `steam-socketpair-3peer-60hz.json`
- `steam-socketpair-3peer-60hz-run2.json`
- `steam-socketpair-3peer-60hz-run3.json`

Runs 2 and 3 differ only in `--label`. Each record carries its own `capture.command`.

Conditions match the WebRTC baseline exactly, and by construction rather than by
coincidence: 3 peers, 60 Hz, 60 entities, 3 s warm-up discarded, 30 s measured, 1 s drain,
snapshot **1031 bytes** written through the shipped `writeEntity` from the same synthetic
roster, offered load **185 580 B/s**. The reduction is `tools/netstats.mjs`, pinned by
`tests/steam-smoke.test.mjs` to the same percentile algorithm `tools/netbaseline.mjs` runs
inside the browser page. Two numbers reduced by different statistics would not be
comparable, and comparing them is the entire point of this arm.

## Why the result is believable: three validity arms

A 0.15 ms figure invites the obvious suspicion — that `bUseNetworkLoopback = true` was
ignored and Steam short-circuited in memory, measuring almost nothing. Three arms answer it,
and all three are committed records rather than assertions.

| Arm | Record | `state` p50 | What it proves |
|---|---|---|---|
| in-memory (`--no-loopback`) | `steam-socketpair-validity-inmemory.json` | **0.037 ms** | Loopback is really on in the gate run: the in-memory mode is a further **4x** faster, so the gate's 0.147 ms is paying for packetisation, encryption and 127.0.0.1. |
| 25 ms fake lag (`--lag-ms 25`) | `steam-socketpair-validity-lag25.json` | **25.945 ms** | `k_ESteamNetworkingConfig_FakePacketLag_Recv` bites, exactly as configured. The `?netlag=` port is real, not theoretical. |
| 5% fake loss (`--loss-pct 5`) | `steam-socketpair-validity-loss5.json` | 0.151 ms, **94/1800 snapshots lost (5.2%)** | Loss bites on the unreliable channel — and **reliable delivery survived it 120/120, in order**. That retransmission is what this arm was bought to watch. |

**Both impaired records are red on purpose** (`ok: false`, and their `gate` block says which
check failed). The lag arm sits at 27 ms on both channels because it was told to; the loss
arm's reliable p99 rises to 61.2 ms as Steam retransmits. Each fails a gate whose limits
describe an *unimpaired* run, which is the gate working rather than the transport failing.
Do not "fix" them by widening the limits — the impaired arms are evidence, not gate runs,
and only `steam-socketpair-3peer-60hz*.json` are the latter.

## What the number is, and is not

Both ends of every connection live in this one process and share one `performance.now()`,
so there is **no clock-sync error** in these figures and **no internet flight time**.

What is measured is **transport and binding cost over loopback** — encode, the Koffi FFI
call, Steam's packetisation and encryption, 127.0.0.1, decode. That is the same meaning the
WebRTC baseline carries, which is what makes the two comparable. **It is not a
player-facing latency number and must not be quoted as one.** A real Steam session adds
identity, SDR routing and the internet, none of which a socket pair contains.

## What this arm cannot see

Everything the [ADR](../../docs/adr/0002-networking-coverage-after-webrtc.md) assigns
elsewhere, and it is worth being blunt about it:

- **No Introduction.** A socket pair is connected the instant it is created. Nothing here
  exercises lobbies, invites, `ConnectP2P`, identity or NAT — that is arm C (#13), and it
  needs two machines.
- **No `NetHost`/`NetClient`.** This measures the wire, not the game on top of it. The
  game-level contract is arm A, `tests/transport-conformance.test.mjs`.
- **No SDR.** Loopback traffic never leaves the box, so Valve's relay network is not in
  the path.
- **Not the Binding.** `tools/steamnet.mjs` declares its own Koffi entry points, because
  no candidate Binding exposes `CreateSocketPair` at all. A green run here says the *Steam
  library* is healthy; it does not say `steamworks-ffi-node` is. That is #52's job.

## Pacing, and the one run that wobbled

Sends and receives share a single `setImmediate` loop rather than a timer, so an arrival is
timestamped as close to delivery as this process can see it; a 1 ms poll interval would
have quantised a 0.15 ms answer beyond usefulness. The loop spun 8.5-9.9 million times per
30 s run.

`sendLoop.maxSendGapMs` was 18.6 / 16.8 / 16.8 ms against a nominal 16.667 ms step — the
cadence held. Pacing does not enter the latency figures anyway, which use each packet's
actual send timestamp rather than its scheduled one.

**Judge this on p99 across repeats, never on a single `max`.** Run 2 recorded a 5.67 ms
`state` max while its p99 sat at 0.24 ms, and run 3's max was 0.296 ms on the same tree —
one outlier in 5400 messages, from one process driving both ends of three connections in a
hot loop. A gate written against `max` would fail on that noise; the p99s across the three
runs span 0.012 ms.

## Re-running it

`npm run smoke:steam`. It needs a running, logged-in **Steam client** — that is a property
of `SteamAPI_Init`, not a choice — so it is a local gate and can never run in CI (#47). It
binds no fixed port (the socket pair takes ephemeral ones), so unlike `probe:coop` it does
not collide with anything; still, do not run two at once, because the impairment settings it
writes are global to the Steam library.

The record is invalidated before the run starts, so a crash cannot leave a stale green file
looking like it describes this tree.
