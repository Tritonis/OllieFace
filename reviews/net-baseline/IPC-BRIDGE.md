# What the renderer/main boundary costs the Conversation

Issue #128, shape **(a)**: batch per frame over one IPC channel. The issue mandated that (a)
be measured before anything else was designed, and this is that measurement.

Captured 2026-08-21 with `tools/ipcprobe.mjs` under Electron 43.3.0, three peers at 60 Hz,
1031 B snapshots built by the shipped `writeEntity` at 60 entities, 3 s warm-up discarded and
30 s measured — the same conditions as `webrtc-3peer-60hz.json` and
`steam-socketpair-3peer-60hz.json`, so the three records compare by construction.

## The headline

| added latency (renderer -> main -> renderer) | p50 | p95 | **p99** | max |
|---|---|---|---|---|
| `state` (unreliable, snapshots) | 0.3-0.4 ms | 0.5-0.7 ms | **0.8-1.0 ms** | 1.3-3.5 ms |
| `events` (reliable) | 0.4 ms | 0.5-0.7 ms | **0.8-1.0 ms** | 1.1-1.3 ms |

Composed with the Steam leg already measured in `STEAM-SOCKETPAIR.md` (worst of its three
runs, so the composition is the pessimistic one):

| | composed p99 | envelope | verdict |
|---|---|---|---|
| `state` | 1.042 / 1.142 / 1.242 ms | <= 2.0 ms | **pass, 3/3** |
| `events` | 1.077 / 1.077 / 1.277 ms | <= 3.0 ms | **pass, 3/3** |

Delivery: 16 884 of 16 884 snapshots and 1 125 of 1 125 events, zero lost, across three runs.

**Shape (a) makes the envelope with roughly 0.9 ms of headroom on `state`.** The decision gate
in #128 is therefore discharged in favour of (a); the SharedArrayBuffer ring and the
move-the-Conversation-into-main options are not needed and were not built.

## What "added" means, and the figure that is not it

The real path is sender renderer -> sender main -> Steam -> receiver main -> receiver renderer.
The rig runs one renderer and one main and loops the batch back, which is exactly the two IPC
hops with Steam's leg standing aside — hence *added*, and hence the composition above.

A sample is stamped when the game hands the byte to the bridge and read **when the IPC event
reaches the renderer process**. That is the same event the WebRTC baseline and the Steam smoke
both timed, and it is the only figure comparable with theirs.

The records also carry `toFrameHookMs`, the same samples read where the game's frame tick
actually drains them: **p99 17.2 ms, all three runs.** That is one frame, and it is not a
regression — a message that lands 0.2 ms after `pumpSim` ran waits for the next `pumpSim`
whatever transport carried it, and WebRTC pays the identical frame. It is recorded because it
is what the player experiences, and gated on nothing, because gating on it would be comparing
a figure the 2 ms envelope never contained.

## What the design had to get right for these numbers

One thing, and it was measured wrong first: **the main process must forward on receipt, not on
a pump of its own.** A first arrangement gave main its own 60 Hz batching timer, phase-random
against the renderer's, and measured p50 17.1 ms / p99 47.8 ms added — a whole extra frame for
nothing. The renderer batches per frame because that is when the game produces bytes; main has
bytes the instant the IPC lands. `desktop/net-bridge-main.mjs` still polls Steam's pull
accessors on a 60 Hz timer, which is a different thing: that is how often Steam is *asked*.

### And one thing the numbers could never have told us

The first version of the renderer half lived in its own file and `preload.cjs` required it.
Every suite in this repo passed, because every suite wires the two halves together in plain
Node. Electron's *sandboxed* preload -- the default under `contextIsolation: true` with no
`sandbox: false`, which is what this shell deliberately builds -- resolves only a short
allowlist of built-in modules, so that relative require threw, the factory was undefined, and
the call to it killed the rest of `preload.cjs`: no `__DESKTOP__`, no `__STEAM__`, on every
boot where Steam was actually available. Only `tools/desktopprobe.mjs`, run on a box with
Steam logged in, could see it, and it went red with two empty key lists.

The bridge is now inline in `preload.cjs`, which requires nothing project-local and never may.
`desktop/net-bridge-renderer.cjs` no longer holds a copy of it -- it reads the block back out
of `preload.cjs` and compiles it, so `tests/transport-steam-bridged.mjs` asserts against the
exact characters the shell runs (mutate the block in `preload.cjs` and the contract goes
122/10). And the probe now names the condition instead of inferring it: *with Steam up, `net`
is a live sockets surface; without it, exactly null.*

## The files, and the command that produced them

```
electron tools/ipcprobe.mjs --peers 3 --hz 60 --entities 60 --run-s 30 --warmup-s 3 \
  --label ipc-bridge-3peer-60hz
```

- `ipc-bridge-3peer-60hz.json`
- `ipc-bridge-3peer-60hz-run2.json`
- `ipc-bridge-3peer-60hz-run3.json`

Runs 2 and 3 differ only in `--label`. Each record carries its own `command`, `sha` and
`electron`, and computes its own `checks`/`ok` against the envelope, so it states its verdict
without reference to this document.

## What this does not claim

That a live Steam connection behaves as the socket-pair smoke says — that is
`STEAM-SOCKETPAIR.md`'s ground, and neither of them has met two machines. And that the bridge
is *correct* is not a latency question at all: it is
`tests/transport-steam-bridged.mjs`, which runs the whole of `tests/transport-contract.mjs`
through both halves of the bridge with not one assertion softened.
