# WebRTC net baseline, captured before anything is swapped

Step 0 of `docs/superpowers/plans/steam-phase-2-swap.md`. Issue #51.

Captured 2026-08-15, on `master`, while the WebRTC Conversation still exists. After the
swap this number is unrecoverable, which is the whole reason step 0 comes first.

## The headline

| | p50 | p95 | **p99** | max |
|---|---|---|---|---|
| `state` (unreliable, snapshots) | 0.5-0.6 ms | 1.5-1.6 ms | **2.0 ms** | 3.3-5.4 ms |
| `events` (reliable, ordered) | 0.6-0.7 ms | 1.8-2.3 ms | **2.9-3.0 ms** | 3.3-3.4 ms |

**Reliable delivery: 1080 of 1080 messages, across three runs. Zero lost, zero duplicated,
zero out of order.** Unreliable delivery: 16 200 of 16 200 snapshots, zero lost.

Ranges are the spread across three independent runs, not error bars within one.

## The files, and the command that produced them

Three runs, same tree, same settings:

- `reviews/net-baseline/webrtc-3peer-60hz.json`
- `reviews/net-baseline/webrtc-3peer-60hz-run2.json`
- `reviews/net-baseline/webrtc-3peer-60hz-run3.json`

```
node tools/netbaseline.mjs --peers 3 --hz 60 --entities 60 --run-s 30 --warmup-s 3 \
  --label webrtc-3peer-60hz
```

Runs 2 and 3 differ only in `--label` (`-run2`, `-run3`). Each record carries its own
`capture.command` field, so the file states how it was made without reference to this
document.

Conditions: 3 peers, 60 Hz, 60 entities per snapshot, 3 s warm-up discarded, 30 s
measured, 1 s drain. Snapshot size **1031 bytes** — the shipped byte layout
(`SNAPSHOT_HEADER` 11 B + 60 x `ENTITY_SIZE` 17 B), written through the shipped
`writeEntity`, not a size this tool invented. Offered load **185 580 B/s**.

## Three runs, because one is a point and the criterion needs an envelope

`p99` is the stable statistic: **2.0 ms on all three runs** for `state`, 2.9-3.0 ms for
`events`. `max` is the unstable one — 3.3, 5.4, 3.6 ms — so a criterion written against
`max` would fail on noise. Write the gate against p99.

Send-loop pacing was 17.6-18.0 ms against a nominal 16.667 ms step. That is `setInterval`
jitter and it does not enter the latency figures: latency is `recv - send` using each
packet's actual send timestamp, never its scheduled one.

## What this number is, and what it is not

Both endpoints live in one page, so both timestamps come off one `performance.now()`.
There is **no clock-sync error** in these figures and **no network flight time** either.

What is measured is **transport and binding cost over loopback** — encode, channel, SCTP,
dispatch, decode. That is the fair comparison for the spike, whose question is what an
unproven FFI adds on the core loop, not what the internet adds.

**This is not a player-facing latency number and must not be quoted as one.** Impairment
(`?netlag=`, `?netloss=`) is deliberately not armed: the rig would add a number we already
know and hide the one we are looking for.

## Measured at the seam, so it survives the swap

The measurement sits at `Peer` (`src/net/Transport.js:114`) — `sendState`/`sendEvent` out,
`onMessage` in, over the two channels created with the exact flags `HostTransport` uses
(`state`: `{ ordered: false, maxRetransmits: 0 }`; `events`: `{ ordered: true }`,
`src/net/Transport.js:435-439`).

That seam is the reason the number is comparable later. Whatever binds Steam
`NetworkingSockets` has to present the same two-channel contract to `NetHost`/`NetClient`,
so the same benchmark can be re-pointed at it and the two records read side by side.

A baseline taken through `probe:coop` could not have been re-measured at all: plan step 3
records that deleting the WebRTC Conversation deletes that probe, which would have left a
WebRTC number with nothing on the other side to compare it against.

## Why this tool had to be written: the criterion named a number that did not exist

Plan step 1 gates the spike on "p99 added latency within the envelope `gate:mp1` records
for WebRTC". No such envelope was ever recorded. Checked, all three:

- **`gate:mp1`** is `node tests/sp-equivalence.mjs --coop-host --compare ...`. It runs one
  process, opens no socket and forms no peer connection. It asserts a single-player
  equivalence fingerprint and the roster-of-one invariant
  (`tests/sp-equivalence.mjs:479`, `:930`) and records **no wire timing of any kind**.
- **`probe:coop`** forms a real two-page connection, but its record carries `formationMs`,
  per-phase timings and behavioural pass/fail checks. Every one of its checks is
  behavioural — roster, ticks, downed/revive, economy. There is **no per-message latency
  distribution and no reliable-delivery counter**.
- **`ClockSync`** (`src/net/Snapshot.js:138-158`) does compute an RTT, but as the
  **minimum over a 40-sample window**, deliberately chosen to be robust against spikes.
  It is structurally the opposite of a p99 and cannot be made to yield one.

Nothing counts sent-versus-received on the reliable channel either: the impairment rig
never drops reliable packets by charter (`Transport.js` `_simEvict`), so "zero dropped
reliable messages" had no counter behind it.

Issue #51 anticipated this: *"If the envelope turns out not to be capturable as a number,
the spike pass criterion must be changed BEFORE the spike runs, not after."* It was not
capturable from the named gate. It is capturable, and now captured, from a new one.

## Proposed criterion revision — requires ratification before #52 runs

Not applied to the plan. This is the proposal; the decision is the user's.

Replace step 1's throughput check with:

> **Throughput.** At 60 Hz with 3 peers over a sustained 30 s run, measured by
> `tools/netbaseline.mjs` at the `Peer` seam: **zero lost, duplicated or out-of-order
> reliable messages**, and **p99 `state` latency at or under 5.0 ms** (WebRTC baseline
> 2.0 ms, allowing 2.5x for FFI and Steam-side overhead), **p99 `events` latency at or
> under 7.5 ms** (baseline 2.9-3.0 ms). Compared against
> `reviews/net-baseline/webrtc-3peer-60hz.json`. Judge on p99, never on `max`.

Two things about this proposal that need a decision rather than a default:

1. **The 2.5x allowance is a judgement, not a measurement.** Nothing in the baseline
   implies it. It is set where it is because sub-5 ms transport cost is inaudible against
   a 16.7 ms frame, so it is an allowance the game can actually absorb. Move it if you
   disagree — but move it now, before the spike, which is the entire point of step 0.

2. **The Steam side may not be measurable on one box, and that is not this tool's
   problem to solve.** Plan step 1 already flags it: Steam identity is per-account and an
   account is online in one place at a time, so two instances on one machine likely cannot
   see each other as two peers. If that holds, the comparison run needs two machines, or
   #53 finds a way. **The comparability of this baseline is therefore gated on #53**
   (*Investigate single-box automated networking testing on Steam*), and #53 should be
   resolved before, or alongside, #52 rather than after it.

## Re-running it

The tool is bounded everywhere, invalidates its record before it starts, and exits
non-zero if the reliable channel violates its contract. It binds **port 5216** by default,
deliberately clear of `probe:coop`'s fixed 5214/5215, so it does not collide with the
co-op probe — though as with every probe in this repo, do not run two at once.
