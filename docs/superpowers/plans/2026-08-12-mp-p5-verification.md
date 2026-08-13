# MP P5 — Verification Rig Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The co-op program gets its instruments: a headless deterministic loopback test for the snapshot/event pipeline, a two-page connection-formation probe (`tools/coopprobe.mjs`) with pluggable per-slice checks and latency/loss/relay arms, a roster-of-one equivalence gate, and the hand-played gate written down as a real checklist.

**Origin:** `docs/superpowers/specs/2026-08-04-multiplayer-roadmap-design.md` §3 P5 ("Headless deterministic sim tests, N-peer probe rigs, the hand-played gate") and process rules 6, 8, 11. The roadmap files P5 as "continuous"; **this plan executes FIRST** among the 2026-08-12 plan set — P2 and P3 gate on the rig existing (memory: all five merge gates are blind to connection formation; probe arms are mandatory for net-touching slices).

**Architecture:** Three instruments, no game-code changes except one additive harness hook. (1) `tests/net-loopback.test.mjs` pairs two `Peer` objects over in-process channels — the `chan()`/`fakePc()` fixtures `tests/netlag.test.mjs:14-28` already established — and proves the snapshot writer→`SnapshotBuffer` ingest→sample path and the reliable-event path are deterministic and lag-tolerant. (2) `tools/coopprobe.mjs` follows the padprobe pattern (Playwright, d3d11, `checks` array in a JSON record, exit 1 on failure) but drives **two pages** through a locally-spawned `tools/signal-server.mjs`, room-code join, then runs a registry of named checks that later slices extend. (3) `gate:mp1` re-runs the sp-equivalence fingerprint with hosting active and zero peers — the roadmap's rule-10 invariant ("a roster of one is the invariant that makes the whole migration verifiable") becomes a command instead of a promise.

**Tech Stack:** Node test harness (`tests/run.mjs` discovery: `*.test.mjs`), Playwright (pinned, already a devDep), `tools/signal-server.mjs`, d3d11 (headed capture works unattended on this box; canary-first, same-renderer rule).

## Global Constraints

- **The rig must be able to fail on purpose** (roadmap rule 2): every check lands with a demonstrated failure mode — either a negative-control arm or a deliberately broken assertion run once and reverted. A gate never failed on purpose is not a gate. Record the on-purpose failures in the task reports.
- **Game-running gate before any instrument** (roadmap rule 6): every probe page must show `paused === false` and `_localTick > 60` before a single check runs. Locate the live handles first — `grep -n "_localTick\|paused" src/core/Harness.js src/main.js` — and cite them; if `_localTick` is named differently today, the live name wins.
- **Determinism rules of this codebase:** gameplay on `ctx.rng`, cosmetics on `ctx.fxRng`, and the harness is not bit-exact across boots (sub-percent pixel deltas are run noise; the shutter phase drifts) — pixel comparisons are OUT for this rig; state comparisons (positions, counts, ticks, gold) are IN.
- **Never run bare `npx`.** Playwright runs via `node tools/<probe>.mjs`; vite via `node node_modules/vite/bin/vite.js`.
- **Bash tool is ASCII-only**; Unicode via Write/Edit. No report prose through heredocs.
- **Probe ports:** coopprobe defaults: vite 5214, signal 5215 (flags `--port` / `--signal-port`). Own `--out` dirs, never `shots/`.
- **Branch:** `slice/mp-p5-verification`. Commit style: single evocative sentence + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- **Line citations are signposts** — the live file wins.

---

### Task 1: Headless loopback — the wire proves itself without a browser

**Files:**
- Create: `tests/net-loopback.test.mjs`

**Interfaces:**
- Consumes: `Peer`, `MAX_SIM_QUEUE` from `src/net/Transport.js`; `writeEntity`, `readEntity`, `writeEvent`-equivalents, `MSG`, `PROTOCOL_VERSION`, `EKIND`, `ESTATE` from `src/net/Protocol.js`; `SnapshotBuffer` from `src/net/Snapshot.js`; fixtures copied from `tests/netlag.test.mjs:14-28`.
- Produces: a paired-channel harness other tests can copy:

```javascript
function pair() {
  // Two chan()s whose send() delivers into the other side's onmessage,
  // synchronously by default; with installSim, on the simulated clock.
  const a = chan(), b = chan();
  a.send = (bytes) => b.onmessage?.({ data: bytes });
  b.send = (bytes) => a.onmessage?.({ data: bytes });
  return [a, b];
}
```

  (Read the live `Peer` receive path first — if `Peer` wires `channel.onmessage` itself, attach the pair before construction or via the same seam `installSim` uses. The point is: bytes written by host-side code are ingested by client-side code in one process, no WebRTC.)

- [ ] **Step 1: Write the failing test** — three blocks, repo idiom:
  1. **Entity round-trip:** build 8 entities covering every `EKIND` and every `ESTATE` (including boundary values: position at `packPos` extremes, `healthFrac` 0 and 1) → `writeEntity` → `readEntity` → field-by-field equality within pack precision. Derive expected precision from `packPos`'s comment/mask, don't guess.
  2. **Snapshot pipeline determinism:** hand-build a 3-entity "host state", write two consecutive snapshots (tick N, N+1) with entity positions advanced by a fixed delta, ingest both into a `SnapshotBuffer`, `sample()` at the midpoint render time → interpolated position equals the analytic midpoint. Run the whole block twice from scratch → byte-identical outputs (determinism), and once through a `pair()` with `installSim({ lag: 50 })` stepping a fake clock → same final sampled state, later (lag-tolerance).
  3. **Reliable-event ordering under sim:** 20 events through the sim-lagged reliable channel with jittered lag → received exactly once, in send order (this extends `tests/netlag.test.mjs`'s pump-order proof from channel level to protocol level).

- [ ] **Step 2: Run to verify it fails** (`node tests/net-loopback.test.mjs`) — fails at import/fixture stage first; iterate until the failures are the assertions.

- [ ] **Step 3: Implement the fixtures** until green. No `src/` changes are expected; if a symbol you need is not exported, exporting it (export-only diff) is in-scope, anything more is not — stop and report.

- [ ] **Step 4: Fail it on purpose** — flip one expected position, watch it fail, revert. Note the run in the report.

- [ ] **Step 5:** `node tests/run.mjs` green (the new file is auto-discovered by the `*.test.mjs` glob). Commit.

---

### Task 2: `tools/coopprobe.mjs` — two pages, one room, pluggable checks

**Files:**
- Create: `tools/coopprobe.mjs`
- Modify: `package.json` — script `"probe:coop": "node tools/coopprobe.mjs"`

**Interfaces:**
- Consumes: padprobe's skeleton (`tools/padprobe.mjs` — Playwright launch flags, d3d11, `--port`/`--seed`/`--record` flag idiom, `checks` array record shape, exit 1 on any failed check); `tools/signal-server.mjs` (spawned as a child on `--signal-port`, killed on exit — including on throw: wrap in try/finally); the co-op screen's room-code UI flow (read the live Menus co-op screen and `Lobby.hostViaRelay`/`joinViaRelay`, `src/net/Lobby.js:244/:292`, to script the real UI path — the probe drives menus like a player, not internal APIs, because connection *formation through the UI* is exactly what no gate covers today).
- Produces: the CLI contract later slices depend on:

```
node tools/coopprobe.mjs
  --port 5214          # vite dev server port (spawned by the probe)
  --signal-port 5215   # local signal server port
  --seed 1337
  --netlag 40-90       # optional: appended as ?netlag= to the CLIENT page only
  --netloss 2          # optional: ?netloss= on the client page
  --run-s 60           # scripted play window after formation
  --record reviews/round9/coopprobe-<label>.json
  --checks base        # comma-separated check-set names; default 'base'
```

- Produces: the check registry — the extension seam P2/P3 use:

```javascript
// Each check: { name, set, run(pages) -> { pass, detail } }
// pages = { host, client } Playwright pages; helpers exposed:
//   evalBoth(fn)  -> [hostResult, clientResult]
//   gameState(page) -> { paused, tick, rosterCount } via page.evaluate on the harness handles
const CHECKS = [
  { name: 'host-running',   set: 'base', run: ... },  // paused false, tick > 60
  { name: 'client-running', set: 'base', run: ... },
  { name: 'roster-2-both',  set: 'base', run: ... },  // both pages report roster count 2
  { name: 'ticks-advance',  set: 'base', run: ... },  // both ticks strictly increase across 5 s
  { name: 'shared-world',   set: 'base', run: ... },  // an entity visible on host is visible on client (netId intersection non-empty)
];
```

  A named check-set that doesn't exist → hard error listing known sets (no silent caps). Fresh `browserContext` per run (no persisted localStorage overrides leaking between arms). The record JSON carries: flags used, per-check `{ name, pass, detail }`, both pages' console errors, and wall-clock timings.
- Produces: the run sequence — spawn signal server → spawn vite → open host page → drive UI to host a room → read the room code off the DOM → open client page (with netlag/netloss params) → drive UI to join by code → wait for formation (bounded 30 s, fail loudly with the ICE/console evidence) → run-window → checks → teardown.

- [ ] **Step 1: Write the probe skeleton** (spawn, two pages, teardown-on-throw) and run it with `--checks base` against master. Expect: it reaches the co-op screen and fails at whatever UI selector is wrong — iterate selectors against the live DOM (padprobe's technique) until formation succeeds at 0 ms.
- [ ] **Step 2: Latency arm:** `--netlag 40-90 --netloss 2` → all base checks still pass. This is the roadmap's "point a rig at what nobody has pointed one at" — the first-ever measured co-op session at nonzero RTT. Save both records under `reviews/round9/` with the arm in the filename.
- [ ] **Step 3: Negative control:** run with `--signal-port` pointing at a dead port → the probe must fail cleanly at formation with an evidence-bearing record, not hang (bounded waits everywhere).
- [ ] **Step 4: Commit** probe + both positive records + the negative-control record.

---

### Task 3: `gate:mp1` — the roster-of-one invariant becomes a command

**Files:**
- Modify: `tests/sp-equivalence.mjs` — add a `--coop-host` flag
- Modify: `package.json` — script `"gate:mp1": "node tests/sp-equivalence.mjs --coop-host --compare <the same baseline file gate:sp names — copy it verbatim from the gate:sp line at execution time>"`
- Possibly modify: `src/core/Harness.js` — an additive query-param hook (below)

**Interfaces:**
- Consumes: the sp-equivalence determinism contract (its 60-line preamble — read it in full before touching the file) and the harness boot path (`?harness=1`).
- Produces: `--coop-host` appends a query param (e.g. `&coophost=1`) that makes the harness boot *hosting a room with zero peers* before the measured window: the host code path active — `ctx.authority` via NetHost, snapshot writer running, roster constructed — but nobody connected. Wire the param in `Harness.js` next to the existing harness param reads, calling the same entry `Menus`/`Lobby` use to start hosting (find it from the co-op screen's host button handler; call the layer *below* the UI). If hosting requires the signal server, use the manual-host path that doesn't (`Lobby` creates the invite without a relay — `createInvite` at `Transport.js:379` — hosting locally must not need a network; if the live code disagrees, report the coupling instead of hacking around it).
- Produces: the gate's meaning — **fingerprint moves zero fields vs the same baseline `gate:sp` uses.** Hosting-with-nobody must not displace a single `ctx.rng` draw or move one damage number. This is roadmap rule 10 as an executable.

- [ ] **Step 1:** Add the flag + harness hook. Run `npm run gate:sp` first (clean baseline sanity on this checkout), then the new `npm run gate:mp1`.
- [ ] **Step 2:** If `gate:mp1` moves fields — **that is a real P1-era finding, not a rig bug**: diagnose which draw the hosting path displaced (superpowers:systematic-debugging), fix it in the smallest possible diff, and re-run both gates. Do not rebaseline; the sp baseline is the truth (memory: sp-equivalence baseline conventions — `npm run gate:sp` is the convention; vs older files, exactly two lemurian→skink renames are expected, a third field is real).
- [ ] **Step 3: Fail it on purpose:** with a scratch edit that adds a spurious `ctx.rng` draw under `coophost`, confirm the gate reports moved fields; revert.
- [ ] **Step 4: Commit.**

---

### Task 4: The hand-played gate — written down, assignable, unfakeable

**Files:**
- Create: `docs/superpowers/specs/HANDPLAY-GATE.md`
- Modify: `docs/MULTIPLAYER.md` — link it from the verification section

**Interfaces:**
- Produces: the checklist a human runs (this task writes the document; executing it is **USER-ONLY** — an agent must never mark these boxes). Contents, derived from roadmap rules 6/11 and the beta-label decision:
  - Setup rows: build + deployed signal + TURN (P4 outputs), two machines on different networks, one session at Steam-shipped settings.
  - Play rows: one full run start→ending with 2 players; every interactable type touched by the *non-host* at least once; one death→revive; one bleed-out→stage-end return; one deliberate wipe; audio listened to on both machines the entire run (rule 11 — audio is a gate, not a chore), with any artifact noted against the known audio-graph flaw ticket.
  - Evidence rows: each box names what to write down (run seed, duration, stage count, defects seen) — a checked box with no evidence line is unchecked (memory: name the baseline capture; claims need on-disk sources).
  - The payoff row: when this gate passes, the Co-op menu label drops "(beta)" (roadmap §1) — cite the label's source line, found via `grep -rn "beta" src/ui/Menus.js`.

- [ ] **Step 1:** Write both files.
- [ ] **Step 2:** Commit.

---

### Task 5: Slice gate

- [ ] **Step 1:** `node tests/run.mjs` green (loopback test included); `npm run gate:sp` AND `npm run gate:mp1` zero moved — paste outputs.
- [ ] **Step 2:** The four record JSONs exist under `reviews/round9/` (0 ms, latency arm, negative control, and — if Task 3 Step 3's on-purpose failure was captured — its scratch record referenced in the report).
- [ ] **Step 3:** Merge per superpowers:finishing-a-development-branch; review file `reviews/round9/mp-p5-review.md`. Reviews tally findings by layer.

## Explicitly out of scope

- 3- and 4-peer probe arms — the rig's two-page core is built for extension (`pages` becomes an array when needed); N>2 arms land with the slice that first needs them, not speculatively (YAGNI).
- Pixel/screenshot comparison between peers (harness is not bit-exact; state comparisons only).
- CI wiring — this box runs probes headed/unattended fine; scheduling is a separate decision.
- Executing the hand-played gate (human-only, by design).
