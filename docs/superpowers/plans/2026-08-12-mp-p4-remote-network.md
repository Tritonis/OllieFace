# MP P4 — Remote-Network Reality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A friend on another network can actually connect: managed TURN credentials wired in, the signal server deployed behind `wss://` on a small PaaS, and an ICE diagnostics readout so a failed connection finally says *why*.

**Origin:** `docs/superpowers/specs/2026-08-04-multiplayer-roadmap-design.md` §4 — the three named gaps: (1) no TURN provisioned, STUN-only fails silently behind symmetric NAT; (2) signalling defaults to `ws://127.0.0.1:8787` and an HTTPS page needs `wss://`; (3) unmeasured RTT behaviour (§the `?netlag=` rig exists — P0 delivered it; the *arms* are P5's job). User decision 2026-08-12: **managed TURN (Open Relay / Metered free tier) + signal server on Fly.io** — no self-hosted VPS.

**Architecture:** Almost all plumbing already exists: `NetConfig.iceServers()` (`src/net/NetConfig.js:118`) appends TURN from `VITE_TURN_URLS`/`VITE_TURN_USERNAME`/`VITE_TURN_CREDENTIAL`; `?signal=`/`?turn=`/`?ice=` query params override and persist (`NetConfig.js:75-81`); `tools/signal-server.mjs` speaks plain WS behind a TLS-terminating edge by design (its own comment, lines 44-48) and already serves `/healthz`. This slice adds only: a deploy recipe (Dockerfile + fly.toml), production env wiring, and an ICE diagnostics collector + panel. Two steps need a human (accounts/billing) and are marked **USER CHECKPOINT** — the plan pauses there, per-task work around them is fully executable.

**Tech Stack:** Fly.io (`flyctl`), Open Relay Project (Metered) free TURN tier, `RTCPeerConnection.getStats()`, vanilla ES modules.

## Global Constraints

- **This slice does not touch the game simulation.** No file in `src/systems/`, `src/entities/`, `src/world/` changes. `npm run gate:sp` must trivially pass; run it once at the end as proof of non-interference.
- **Secrets never enter the repo.** TURN credentials and the deployed signal URL live in `.env.production.local` (gitignored — verify `.gitignore` covers `*.local`; add it if not) and in the session notes, never in a committed file. The committed `.env.production` carries only non-secret defaults and comments pointing at the local file.
- **The manual join path must survive untouched** (`Lobby.joinManual`, `src/net/Lobby.js:175`) — it is the zero-infrastructure fallback and the roadmap values it precisely because it cannot rot on a server.
- **Never run bare `npx`** — includes `flyctl` usage: flyctl is a standalone binary, install per Task 3, never via npx.
- **Bash tool is ASCII-only**; Unicode via Write/Edit. No report prose through heredocs.
- **Probe ports:** 5220/5221. **Branch:** `slice/mp-p4-remote-network`. Commit style: single evocative sentence + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- **Line citations are signposts** — the live file wins.

---

### Task 1: ICE diagnostics — the connection can explain itself

**Files:**
- Create: `src/net/IceDiag.js`
- Modify: `src/net/Transport.js` (`Peer` class ~:110 — expose the `RTCPeerConnection` if not already reachable)
- Modify: the co-op/lobby screen in `src/ui/Menus.js` (find it: `grep -n "coop\|Co-op\|lobby" src/ui/Menus.js`, read the screen builder before editing)
- Test: `tests/icediag.test.mjs` (new)

**Interfaces:**
- Produces: `summarizeStats(statsIterable)` — pure function, exported for tests: takes the iterable from `pc.getStats()` and returns

```javascript
{
  gathering: 'new'|'gathering'|'complete',   // caller supplies pc.iceGatheringState
  localTypes: ['host','srflx','relay'],       // distinct local candidate types seen
  remoteTypes: [...],
  selected: { local: 'srflx', remote: 'host', rttMs: 47 } | null,  // the succeeded/selected pair
  turnConfigured: true|false                  // from iceServers() containing a turn: url
}
```

  Built from stats entries of type `local-candidate`, `remote-candidate`, and the `candidate-pair` with `state === 'succeeded'` (or `nominated === true`); `rttMs` = `currentRoundTripTime * 1000` when present.
- Produces: `attachIceDiag(peer, onUpdate)` — polls `getStats()` every 2 s while the connection lives, calls `onUpdate(summary)`; returns a detach function. Lives in `IceDiag.js`, imported only by the lobby UI — zero cost when no lobby screen is open.
- Produces: the lobby panel — a monospace status block on the co-op screen rendering the summary: gathering state, candidate types as tags, selected pair + RTT, and two *actionable* verdict lines the roadmap's silent-failure complaint demands:
  - no `relay` in `localTypes` and `turnConfigured === false` → "No TURN configured - connections across strict NATs will fail. Set turn settings or ?turn=."
  - `gathering === 'complete'`, no selected pair after 15 s → "No route found between peers. If both sides are behind strict NAT, TURN is required."

- [ ] **Step 1: Write the failing test** for `summarizeStats` only (the poller and DOM are probe-verified, not unit-tested). Repo idiom (`ok(cond,msg)`, exit = failures). Feed it hand-built stats arrays: (a) host+srflx locals, succeeded pair srflx/host, rtt 0.047 → expect types, selected, `rttMs: 47`; (b) empty stats → `selected: null`, empty types; (c) relay-only both sides → `localTypes: ['relay']`.

- [ ] **Step 2: Run to verify it fails** (`node tests/icediag.test.mjs`).

- [ ] **Step 3: Implement** `IceDiag.js`; wire the panel into the co-op screen using the screen's existing row/label markup idiom (this repo's UI reads as instrument panels — match the diegetic treatment the menus already carry, no new styling system).

- [ ] **Step 4: Test green.** Panel verified live in Task 5's probe run.

- [ ] **Step 5: Commit.**

---

### Task 2: Deploy recipe — the signal server becomes an app

**Files:**
- Create: `deploy/signal/Dockerfile`
- Create: `deploy/signal/fly.toml`
- Create: `deploy/signal/README.md`
- Modify: `package.json` — script `"signal:docker": "docker build -f deploy/signal/Dockerfile -t telluric-signal ."` (build-check convenience; running Docker locally is optional)

**Interfaces:**
- Consumes: `tools/signal-server.mjs` as-is — it reads `PORT` from env, serves `/healthz`, and expects TLS termination upstream (its design comment, lines 44-48). **No changes to the server file.**
- Produces: a deployable unit any Fly app name can host.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund ws
COPY tools/signal-server.mjs tools/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "tools/signal-server.mjs"]
```

(`ws` is the server's only dependency per its header; installing just `ws` keeps the image free of the game's toolchain. If `npm install ws` against the repo package.json drags the world in, use a minimal `deploy/signal/package.json` containing only `{"dependencies":{"ws":"<the version pinned in the root package.json>"}}` and copy that instead — check the root pin first.)

- [ ] **Step 2: Write fly.toml**

```toml
app = "telluric-signal"
primary_region = "ord"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    method = "GET"
    path = "/healthz"
```

(`min_machines_running = 0` keeps this in free-allowance territory; cold start adds ~1 s to the first room-code exchange, acceptable for a lobby. Region is a default — the README tells the user to change it to their side of the planet.)

- [ ] **Step 3: Write `deploy/signal/README.md`** — the exact command sequence (install flyctl from https://fly.io/docs/flyctl/install/, `flyctl auth login`, `flyctl launch --no-deploy --copy-config` from `deploy/signal/`, `flyctl deploy`), the resulting URL shape (`wss://<app>.fly.dev`), and the smoke check: `curl https://<app>.fly.dev/healthz` → 200.

- [ ] **Step 4: Verify what can be verified headless:** `docker build` if Docker exists on the box, else `node --check tools/signal-server.mjs` plus a local boot on `PORT=5220` with a `curl 127.0.0.1:5220/healthz` → 200, to prove the CMD line is honest.

- [ ] **Step 5: Commit.**

> **USER CHECKPOINT A:** Deploy needs a Fly.io account: run the README's four commands, then report the app URL back. The slice continues with Task 3 meanwhile; Task 5 blocks on this URL.

---

### Task 3: Production env wiring — TURN and signal URL reach the build

**Files:**
- Create: `.env.production` (committed, non-secret comments + empty defaults)
- Modify: `.gitignore` (ensure `.env*.local` is covered)
- Modify: `docs/MULTIPLAYER.md` — a new "Going remote" section

**Interfaces:**
- Consumes: the existing Vite env reads — `VITE_SIGNAL_URL` (`src/net/NetConfig.js:95`), `VITE_TURN_URLS`/`VITE_TURN_USERNAME`/`VITE_TURN_CREDENTIAL` (:124-127), `VITE_ICE_POLICY` (:146). **No code change** — this task is files + docs.
- Produces: `.env.production`:

```bash
# Remote-play endpoints. Real values live in .env.production.local (gitignored).
# Signal relay - deployed per deploy/signal/README.md:
VITE_SIGNAL_URL=
# TURN - Open Relay Project (Metered) free tier, see docs/MULTIPLAYER.md "Going remote":
VITE_TURN_URLS=
VITE_TURN_USERNAME=
VITE_TURN_CREDENTIAL=
```

- Produces: the docs section — how to get Open Relay credentials (create a free account at https://www.metered.ca/tools/openrelay/, copy the static credential set they issue: urls `turn:standard.relay.metered.ca:80`, `:443`, and `turns:...:443?transport=tcp` variants plus username/credential), where each value goes, the `?turn=`/`?signal=` query overrides for testing a deployed build without rebuilding, and the forced-relay smoke (`?ice=relay`) that proves TURN actually relays. State the quota honestly: the free tier is metered monthly bandwidth; a playtest fits, a launch does not — note that launch-scale TURN is a later, paid decision.

- [ ] **Step 1: Write the three files.** (Verify Open Relay's current signup URL and credential shape with a web search at execution time — copy reality, not this plan, if they differ.)
- [ ] **Step 2:** `node node_modules/vite/bin/vite.js build` — confirm the empty-string env vars don't break `iceServers()` (empty `VITE_TURN_URLS` must behave as unset; read the guard at `NetConfig.js:124` and test the built bundle boots: `npm run preview` on 5221, page loads, console clean).
- [ ] **Step 3: Commit.**

> **USER CHECKPOINT B:** Create the Metered/Open Relay account, paste the four values into `.env.production.local`. Task 5 blocks on this.

---

### Task 4: The relay smoke — prove a forced-relay connection forms locally

**Files:**
- Modify: `tools/coopprobe.mjs` (P5 rig — prerequisite) — add `--ice <policy>` and `--turn <urls>` flags that append the corresponding query params to both pages
- Test: probe run, recorded JSON

- [ ] **Step 1:** Add the flags (the rig's flag idiom is padprobe's — `--port`, `--seed`, `--record`; copy it). `--ice relay` appends `?ice=relay`; `--turn`/`--turnuser`/`--turnpass` append their params (they persist to localStorage per `NetConfig.js:75-81` — the probe must launch with a fresh browser profile per run so persisted overrides can't leak between arms; check how the rig creates its context and use an incognito/fresh `browserContext`).
- [ ] **Step 2:** Baseline arm without TURN: `node tools/coopprobe.mjs --port 5220 --ice relay` → **must FAIL to form a connection** (relay-only with no TURN = no route). This is the gate-failed-on-purpose run (roadmap rule 2): record it in the JSON as the negative control.
- [ ] **Step 3: Commit** the flag support with the negative-control record at `reviews/round9/mp-p4-relay-negative.json`.

---

### Task 5: End-to-end over the real internet — the gate

Blocks on **USER CHECKPOINT A + B**.

- [ ] **Step 1:** Local pages, deployed infrastructure: `node tools/coopprobe.mjs --port 5220 --signal wss://<app>.fly.dev` (add `--signal` the same way as Task 4's flags if the rig lacks it) → room-code host/join through the deployed relay, connection forms, gates green (`paused false`, `_localTick > 60`, roster 2).
- [ ] **Step 2:** Relay-positive arm: same, plus `--ice relay --turn <the metered urls> --turnuser ... --turnpass ...` → connection forms **through TURN**; the diagnostics summary in the record shows `selected.local === 'relay'`. Compare with Task 4's negative control: same config minus TURN failed; with TURN succeeds — the pair of records is the evidence (memory: name the baseline capture — both JSONs land in `reviews/round9/`, exact filenames in the report).
- [ ] **Step 3:** Latency arm: relay + `--netlag 40-90` → still forms, still ticks.
- [ ] **Step 4:** `npm run gate:sp` — zero moved (non-interference proof).
- [ ] **Step 5:** Update `docs/MULTIPLAYER.md` status: the three §4 gaps from the roadmap each get a "closed by" line naming the record file. Commit; merge per superpowers:finishing-a-development-branch; review file `reviews/round9/mp-p4-review.md`.

## Explicitly out of scope

- Launch-scale TURN capacity (paid decision, revisit at the Steam demo gate).
- Replacing WebSocket signalling with Steam lobbies — that is the steamworks slice (`2026-08-12-steamworks-wiring.md`), and the two coexist: web build uses the relay, Steam build prefers lobbies.
- A human playing from a genuinely remote network — that evidence belongs to P5's hand-played gate, which this slice's infrastructure finally makes possible.
