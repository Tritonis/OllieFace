# Getting friends on other networks into a game

The game is a static site plus peer-to-peer WebRTC. Nothing about the gameplay
runs on a server — but getting two browsers to *find* each other needs a little
infrastructure, and getting them to connect through hostile networks needs a
little more.

There are three pieces, and they are independent:

| Piece | What it does | Needed? |
|---|---|---|
| **The site** | Serves the game to players | Always |
| **Signalling relay** | Swaps connection details so peers can find each other | For room codes (skip it if you copy/paste blobs) |
| **TURN server** | Carries traffic when peers can't reach each other directly | For ~10-20% of players; you can't predict which |

Skip to [Path A](#path-a-fastest-no-infrastructure) if you just want three
friends playing in the next ten minutes.

---

## Path A: fastest, no infrastructure

The manual copy/paste path is already built and needs **nothing deployed**.

1. `npm run build`
2. Put `dist/` on any static host. Drag-and-drop options that take about a
   minute: [Netlify Drop](https://app.netlify.com/drop),
   [Cloudflare Pages](https://pages.cloudflare.com/), or GitHub Pages.
3. Everyone opens the URL.
4. **Host:** Co-op → *Create invite* → *Copy* → paste the blob to your friend
   (Discord, whatever).
5. **Friend:** Co-op → paste it into *Their invite code* → *Join* → copy the
   reply code back to the host.
6. **Host:** paste that into *Their reply code* → *Connect them*.
7. Repeat 4-6 for each additional player (up to 4 total).

Ugly, and it's two round-trips of pasting per player, but it works across
networks today with zero servers. Note it still uses STUN only, so a player
behind strict NAT will fail — see [TURN](#step-3-turn-the-part-people-skip-and-regret).

---

## Path B: the real setup (room codes)

### Step 1 — deploy the signalling relay

`tools/signal-server.mjs` is one file and depends on nothing but `ws`. It sees
no game traffic; once peers connect it is irrelevant. It can idle on a free tier
forever.

It reads `PORT` from the environment (or `--port`, and `--port 0` takes whatever
the OS offers) and answers `GET /healthz`, so it works as-is on Render, Railway,
Fly.io, Cloud Run or Heroku.

Its defaults are sized for a laptop. A relay anyone on the internet can reach
needs two environment variables set knowingly, and neither has a safe default —
read [operating the relay](#reference-operating-the-relay) before you leave one
running in public.

**On Render (free tier), as an example:**

1. Push this repo to GitHub.
2. New → Web Service → point at the repo.
3. Build command: `npm install`
4. Start command: `node tools/signal-server.mjs`
5. Deploy. You get `https://your-thing.onrender.com`.
6. Your signalling URL is that with the scheme swapped: `wss://your-thing.onrender.com`

Check it: `curl https://your-thing.onrender.com/healthz` →

```json
{"ok":true,"rooms":0,"conns":0,"roomsTotal":0,"connsTotal":0,"rejectedTotal":0,"refusedTotal":0,"expiredTotal":0,"errorsTotal":0,"uptimeMs":1216}
```

An unsuffixed name is how many there are **right now**; a `Total` name is how
many there have been **since startup**. `rejectedTotal` counts messages refused
after a socket was accepted (malformed, oversized, or over the rate limit);
`refusedTotal` counts handshakes refused before any message (a disallowed
Origin, or too many connections from one address). A busy hour and an attack
look different here, which is the point of it.

This endpoint is unauthenticated and cannot be otherwise — a platform health
check carries no credential — so it is counts and flags only. It never names a
room, an address, a client id or an origin.

> **Redeploy the relay when you update the game.** The relay now also carries
> ICE candidates, which lets both sides skip a gathering wait of up to four
> seconds *each* — the difference between a room-code join and a copy-paste
> one. It advertises that ability as a version number when a host opens a room,
> and a page that does not see it falls back to the slower join rather than
> failing. So an old relay in front of a new build still works; it is just as
> slow as it was. Nothing else about the pairing breaks in either direction —
> an old page against a new relay is equally fine.

> **The scheme matters.** A page served over `https://` may only open a
> `wss://` socket. A `ws://` URL is blocked as mixed content before it reaches
> the network. `NetConfig.js` auto-upgrades `ws://`→`wss://` on an https page,
> but only deploy behind TLS and this never comes up. Every platform above
> terminates TLS for you.

> Free tiers sleep. Render spins a free service down after ~15 minutes idle and
> takes ~30s to wake, so the *first* room code of the evening may time out. Hit
> `/healthz` once before you start playing.

### Step 2 — build the site pointed at it

```bash
cp .env.example .env
# edit .env: set VITE_SIGNAL_URL=wss://your-thing.onrender.com
npm run build
```

Deploy `dist/` as in Path A.

You do **not** have to rebuild to change this. Any deployed build can be
redirected at run time:

```
https://your-game.example.com/?signal=wss://some-other-relay
```

That persists to `localStorage`, so testers follow the link once and every
later plain visit keeps it. This is the quickest way to move a group onto a
different relay mid-session.

### Step 3 — TURN, the part people skip and regret

STUN only tells a peer what its own public address looks like. When both ends
are behind a NAT that rewrites the port per destination — **symmetric NAT**,
which is normal on corporate networks, university networks, and a lot of mobile
carriers — neither side can predict the other's mapping and the connection
simply never forms. No error. The candidate list just never pairs and it looks
like the game is broken.

TURN is the fallback: a relay both peers can reach outbound, which forwards
between them. It costs bandwidth, which is why it isn't the default path — ICE
only falls back to it when nothing direct works.

**Options:**

- **[Open Relay](https://www.metered.ca/tools/openrelay/)** — free, no signup,
  fine for playtesting with friends. Least effort by a distance.
- **[Twilio Network Traversal](https://www.twilio.com/docs/stun-turn)** —
  paid per GB, credentials are short-lived and must be minted server-side.
- **Self-hosted [coturn](https://github.com/coturn/coturn)** — a small VPS is
  plenty. Cheapest at volume, most setup.

Put whichever you choose in `.env`:

```bash
VITE_TURN_URLS=turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turns:openrelay.metered.ca:443?transport=tcp
VITE_TURN_USERNAME=openrelayproject
VITE_TURN_CREDENTIAL=openrelayproject
```

Offer UDP, TCP **and** TLS-on-443. The last one is what survives a firewall
that only permits outbound HTTPS, which is exactly the network you were trying
to rescue.

### Step 4 — prove TURN actually works

This is the step everyone skips, and it's why TURN bugs are only ever found by
the one friend who can't join.

On a normal home network a completely broken TURN config still connects — ICE
finds a direct path and never touches the relay. So you have to forbid the
direct path:

```
https://your-game.example.com/?ice=relay
```

`iceTransportPolicy: 'relay'` drops all direct and server-reflexive candidates.
**Two players who can connect with `?ice=relay` on the URL have proved the TURN
server works.** If it fails, TURN is misconfigured — and you've learned that
from your sofa instead of from a friend at 11pm.

Then drop the parameter (`?ice=` clears it) and play normally.

### Step 5 — play

1. Host: Co-op → **Create room** → an eight-character code appears, grouped as `ABCD-2345`.
2. Read it out. The alphabet has no O, 0, I or 1 in it, so nothing in it can be misheard for something else.
3. Everyone else: Co-op → type it into the code box → **Join room**. The dash is optional.

The co-op screen prints what the build is wired to underneath. If it says
*"local only"* or *"TURN relay: none"* in amber, that's the bug, before anyone
has tried to connect.

---

## Reference: every setting

Each can be a build-time `.env` variable or a run-time query parameter. Query
wins, and persists to `localStorage` — **except the two credentials, which never
persist at all.**

| `.env` | Query | Persists? | Purpose |
|---|---|---|---|
| `VITE_SIGNAL_URL` | `?signal=` | yes | Signalling relay WebSocket URL |
| `VITE_TURN_URLS` | `?turn=` | yes | Comma-separated TURN URLs |
| `VITE_TURN_USERNAME` | `?turnuser=` | **no — this session only** | TURN username |
| `VITE_TURN_CREDENTIAL` | `?turnpass=` | **no — this session only** | TURN credential |
| `VITE_ICE_POLICY` | `?ice=relay` | yes | Force relay-only (TURN test) |
| `VITE_NET_LAG` | `?netlag=` | yes | Simulated one-way delay, `60` or `40-90` ms |
| `VITE_NET_LOSS` | `?netloss=` | yes | Simulated loss, percent, unreliable channel only |

Pass an empty query value (`?turn=`) to clear a persisted override.

### Why the two credentials are different

A TURN username and credential are bearer secrets for a relay somebody pays for.
`localStorage` is the wrong place for one in three separate ways: it outlives the
session that needed it, every other script on the origin can read it, and it
survives into screenshots and support dumps taken long afterwards. So they are
read from the URL of the session that is using them and from nowhere else, and
any copy an older build wrote is **deleted when the page loads** rather than
merely ignored — including under the pre-rename `petrichor.net.` prefix.

Two consequences worth knowing before you hit them:

- A tester carrying TURN credentials carries the **whole link** every time.
  `?signal=` alone will not do on the second visit.
- A plain visit with no credentials in the URL falls back to whatever
  `VITE_TURN_*` was built into the bundle, which is usually nothing. TURN is
  then unconfigured — an honest failure — rather than half-configured with a
  stale username and no password.

The credential is still in the URL, so it is still in browser history, in the
address bar, and in any screenshot of it. That part this cannot fix; treat a
credential link like a password.

---

## Reference: operating the relay

Everything here is read from the environment by `tools/signal-server.mjs` at
startup. `npm run signal` on a laptop needs none of it. A relay anyone on the
internet can reach needs the first two considered deliberately, because neither
has a default that is right everywhere and the code cannot choose for you.

### `SIGNAL_ALLOWED_ORIGINS` — unset by default, and unset means *any*

A comma-separated list of web origins permitted to open the relay
(`https://your-game.example.com,https://staging.example.com`). While it is
unset, a page on **any** site can open rooms on your relay and spend its budget.
**A public deployment must set it.** The relay says so on every boot where it is
unset, as JSON so an aggregator keeps it:

```json
{"at":"…","event":"config-warning","setting":"SIGNAL_ALLOWED_ORIGINS","detail":"unset — any web origin may open this relay. That is right for a laptop and wrong for a public deployment."}
```

> **An allowlist names *browser* origins, and only browsers are bound by it.** A
> client that sends no `Origin` header is not a browser and is still admitted —
> refusing it would break the probes and every non-browser client while costing
> an attacker nothing, since anything that is not a browser puts whatever it
> likes in that header. This is an anti-abuse measure against other people's web
> pages. It is not authentication.
>
> **The desktop build is Chromium too**, and its page sends an Origin of its own
> — `file://` or `null` — which appears in nobody's allowlist. A deployment that
> sets this variable and also serves desktop players must name that value
> explicitly, or every desktop player is refused at the handshake with no
> in-game error worth reading.
>
> **That parenthetical is unverified.** No test and no agent has confirmed what
> the shell actually sends; it is what Chromium is documented to do, not what
> this build was observed to do. Find out instead of assuming: start the relay
> with the allowlist set, connect a desktop build, and read the line it writes.
>
> ```json
> {"at":"…","event":"refused","reason":"origin","origin":"<the value you must add>"}
> ```
>
> Whatever is in `origin` there is what belongs in the allowlist. If no
> `refused` line appears while a desktop client is failing to connect, the
> Origin check is not what is refusing it — look at `conns-per-ip` next. Note
> that `refused` lines are sampled at five per ten seconds, so on a relay under
> load you may be reading somebody else's refusal; test on a quiet one.

### `SIGNAL_TRUST_PROXY` — off by default, and wrong in both directions

Whether the left-most entry of `x-forwarded-for` is believed when deciding which
client a connection belongs to. Off unless set to `1`, `true`, `yes` or `on`.
Every per-address decision the relay makes — `SIGNAL_MAX_CONNS_PER_IP`, and the
address in its logs — depends on this being right.

- **Left off behind a proxy.** Fly, Render, Railway and Cloud Run all terminate
  TLS at an edge and forward inward, so `socket.remoteAddress` is the edge and
  not the player. Every player then shares one bucket, and the relay refuses the
  **13th connection to the whole service** while `SIGNAL_MAX_CONNS_PER_IP` still
  reads like a per-player cap. Three friends reconnecting after a crash can do
  it.
- **Turned on where the relay is also reachable directly.** A bare VM, a
  container with a published port, or `npm run signal` all let a client talk to
  the relay without passing through anything that rewrites the header — and the
  header is written by whoever is talking. A fresh value on each connection buys
  a fresh allowance, so the per-IP cap costs an attacker one header and stops
  nobody.

Turn it on only when **every** path to the relay goes through a proxy you
control that overwrites the header. The relay echoes the choice at startup so it
can be checked rather than assumed:

```json
{"at":"…","event":"listening","port":8787,"allowedOrigins":[],"trustProxy":false}
```

> **IPv6 caveat.** The per-IP cap keys an IPv6 address to the /64 it sits in,
> not the exact address — a residential allocation is a /64 or larger, and
> counting the exact address would let one subscriber open 2^64 "different"
> connections for free. But a shared /64 — a datacentre or NAT64 subnet rather
> than a residential allocation — puts every legitimate player behind it into
> the *same* bucket, the same way an unconfigured `SIGNAL_TRUST_PROXY` does.
> IPv4 addresses, including IPv4-mapped ones (`::ffff:a.b.c.d`), are always
> keyed whole.

### The ceilings

Each takes a positive number; anything else is ignored and the default stands.
Every one of these is read fresh from `tools/signal-server.mjs` — grep
`envNum(` in that file if this table and the code ever disagree; the code
wins.

| Variable | Default | What it protects |
|---|---|---|
| `SIGNAL_MAX_CLIENTS_PER_ROOM` | `8` | One room's size. Four players is the designed party; the slack absorbs a joiner whose socket has not been swept yet, so a legitimate rejoin is never the one refused. Over it, the joiner is told `Room is full`. |
| `SIGNAL_MAX_ROOMS` | `500` | The relay's total memory. Over it, a new host is told `Relay is full` rather than the process growing without bound. |
| `SIGNAL_MAX_CONNS_PER_IP` | `12` | One address opening sockets in a loop. Over it the upgrade is refused before any message is read. Read `SIGNAL_TRUST_PROXY` above first — behind an unconfigured proxy this cap applies to everyone at once. |
| `SIGNAL_MAX_SOCKETS` | `768` (`SIGNAL_MAX_CONNS_PER_IP × 64`) | Every socket the process holds at all, upgraded or not — raw TCP connections and half-finished HTTP requests included, counted from accept rather than from a completed handshake. Read together with `SIGNAL_MAX_BUFFERED_BYTES` below: the two multiply. |
| `SIGNAL_MAX_BUFFERED_BYTES` | `1048576` (1 MiB) | What the relay will hold in its own memory for **one socket that has stopped reading**. Over it, that socket is closed with 1008 (`not reading`), given a 1 s grace to drain, then terminated — because a peer that never reads turns this process's heap into its own receive buffer, unboundedly, while every other declared limit stays satisfied throughout. **Worst case across the whole process is `SIGNAL_MAX_SOCKETS × SIGNAL_MAX_BUFFERED_BYTES` — 768 MiB at the shipped defaults.** That is bounded and survivable on a machine with memory to spare, but over the head of a 512 MB container; such a deployment must lower one or the other, not just note "1 MiB per socket" and assume that is the whole story. |
| `SIGNAL_HEADERS_TIMEOUT_MS` | `5000` | How long an unfinished HTTP request — a health check, a WebSocket upgrade that never completes — may hold a socket open before Node reaps it. |
| `SIGNAL_REQUEST_TIMEOUT_MS` | `10000` | Same, for a request whose headers arrived but whose body never finished. Neither timeout applies once a socket has upgraded to WebSocket, so a signalling connection that goes quiet for a whole game — every connection here, once its peers are up — is unaffected. |
| `SIGNAL_MAX_MSGS_PER_SEC` | `40` | Sustained message rate per socket, as a token bucket (`SIGNAL_MSG_BURST` below is the bucket size). A well-formed message arriving over this rate is **dropped and counted, not treated as abuse** — see the row below for what that means and what it does not spend. |
| `SIGNAL_MSG_BURST` | `120` | The allowance in hand for the bucket above. Much larger than the sustained rate on purpose: trickle ICE is bursty, and a host gathering against several interfaces emits a dozen candidates in milliseconds. Raise this, not the rate, if real gathering is being clipped. |
| `SIGNAL_MAX_RATE_DROPS` | `600` | **The two-bucket design an earlier version of this table did not describe.** A message dropped for arriving over `SIGNAL_MAX_MSGS_PER_SEC` is back-pressure, not garbage — the sender is a real player whose machine is gathering candidates faster than the relay wants, and the frame is already dropped on the wire — so it does **not** spend the same fixed, 20-strong, never-refilling budget that a malformed frame does. It spends this budget instead, which is its own, much larger allowance. Only once *this* budget runs out does the relay close the socket, with 1008 (`sustained flood`) rather than `1008 (too many invalid messages)`. Lowering `SIGNAL_MAX_MSGS_PER_SEC` to "get faster disconnects on floods" does not touch this row — raise it, or `SIGNAL_RATE_DROPS_FORGIVEN_PER_SEC` down, instead. |
| `SIGNAL_RATE_DROPS_FORGIVEN_PER_SEC` | `20` | The refill rate for the budget directly above — unlike the malformed-frame budget, this one earns tokens back on the clock, so a finite burst is throttled and forgiven while only a genuinely sustained flood exhausts it. |
| `SIGNAL_MAX_JOINS_PER_SEC` | `1` | A second, far tighter bucket for the one message a stranger can send that spends someone *else's* resources: each `join` asks the host's page to build a whole `RTCPeerConnection`. Over it, the `join` is dropped and counted the same way an over-rate general message is — see the two rows above. |
| `SIGNAL_JOIN_BURST` | `5` | The allowance in hand for the bucket above. A real page sends exactly one `join` per socket, so a burst of five is five times any client that exists. |
| `SIGNAL_ROOM_TTL_MS` | `1800000` (30 min) | A room nobody came back for. On expiry its clients **and its host** are told `Room expired` and the code returns to circulation. **Has a floor at twice the page's keepalive interval — currently 300000 ms, so 600000 ms.** Any value below that silently expires a room a live session is still using: the TTL is measured from last *activity*, and once every peer is connected the host's `keepalive` beat is the only thing that counts as activity at all. Below the floor, the relay logs a `config-warning` for `SIGNAL_ROOM_TTL_MS` at startup — see below. |
| `SIGNAL_HEARTBEAT_MS` | `30000` (30 s) | A socket that stopped answering. Each interval the relay pings every client and terminates the ones that did not pong, so a dead host does not hold a room open. The same timer runs the room sweep, at whichever is smaller of this and half the TTL. |

```json
{"at":"…","event":"config-warning","setting":"SIGNAL_ROOM_TTL_MS","roomTtlMs":60000,"floorMs":600000,"detail":"a live session keeps its room with a keepalive every 300000 ms; under the floor a room expires under a live game."}
```

The message-*shape* ceilings — a 64 KiB frame limit (enforced by `ws` before a
byte is ever buffered), a 32 KiB SDP blob, a 1 KiB ICE candidate, and the
8-character room code length — are **not** tunable from the environment,
deliberately. Changing one is a code change, so it arrives with a reason
attached, in `tools/signal-server.mjs`'s `LIMITS` object.

### Two deployment traps that are easy to miss

- **`/healthz?probe=1` returns 404, not 200.** The health-check route match is
  exact — `/healthz` or `/`, nothing else — so a platform that appends a query
  string to the URL it polls will see every check fail and mark the service
  unhealthy. Point the health check at bare `/healthz`.
- **The 768 MiB worst case above is real, not theoretical**, and it is a
  *product* of two variables that live in different rows of this table
  (`SIGNAL_MAX_SOCKETS` and `SIGNAL_MAX_BUFFERED_BYTES`) — recompute it
  yourself if you change either one rather than trusting a number from here.

### The logs contain addresses

The relay redacts room codes, SDP blobs and candidates from every line it writes
— a room code is a bearer token for the life of the room, and logging one
discloses it to whoever reads the logs, for ever. It does **not** redact client
IP addresses: `refused` and `socket-error` lines carry the address, because an
abuse log that cannot name the abuser is not one.

That makes **log retention a PII retention decision**, not an ops preference. If
your platform ships these logs to an aggregator, whatever retention window it
applies is how long you are keeping players' IP addresses. Decide it on purpose.

---

## When it doesn't work

**"Could not reach the signalling server"** — the message names the URL and the
likely cause. Localhost URL in a deployed build means `VITE_SIGNAL_URL` wasn't
set at build time. On a free tier, the service may be asleep; hit `/healthz`.

**Room code accepted, then nothing happens** — signalling worked and the peer
connection didn't. This is the NAT case. Confirm with `?ice=relay`: if that
fails too, TURN is wrong or absent.

**Works for some friends, not others** — almost always symmetric NAT on the
failing player's network. It is not something they can fix; it is what TURN is
for.

**Everything works on your LAN, nothing works remotely** — you are probably
still on the localhost relay. The co-op screen says so in amber.

**Host quits and the game ends** — expected. This is host-authoritative netcode
with no host migration; the host runs the simulation. See `NETCODE.md`.

---

## Known co-op gaps after P2

P2 gave every pawn its own `Items` — inventory, gold, equipment and stat block
all resolve through `Items.of(ctx, pawn)`. Two consumers were never in that
slice's file list and still resolve through the *viewer's* singleton. Both are
reachable in any live co-op game today. They are written down here rather than
discovered in a playtest, and both belong to P3.

**1. Combat hooks and outgoing-damage modifiers dispatch to `ctx.items`.**
`Combat._dispatch` (`src/systems/Combat.js:653`) sends every `onHit` and
`onKill` to `this.ctx.items`, and `modifyOutgoing` (`src/systems/Combat.js:474`)
applies `ctx.items`' conditional multipliers to any `source.isPlayer` — remote
pawns included. So on a host:

- a joiner's on-hit / on-kill items **never fire**; their whole proc build is
  dead weight;
- the **host's** items proc off the joiner's bullets, and since `api.player` is
  bound to `_owner()` (`src/systems/Items.js:1182`) the singleton's owner is
  `ctx.player` — the host takes the barrier, the heal, the launched projectile
  from a teammate's kill across the map;
- "vs full health / airborne / stunned" multipliers apply the host's item set to
  the joiner's damage.

This is not a one-line routing swap: `_dispatch` pays into one shared proc
budget (`Combat.js:654-655`), so per-source routing needs a budget decision, and it
sits alongside the deliberately parked `onDamaged` (gated on `target ===
ctx.player` at `src/systems/Combat.js:565`, correct as written). The parking
note now covers all four: `onDamaged`, `onHit`, `onKill`, `modifyOutgoing`.

**2. Shared-objective payouts pay the host alone.** None of these are
pawn-driven interacts, so the per-pawn ownership work never reached them:

- realm trial completion — three owner-less orbs plus a direct
  `ctx.items.addGold` (`src/world/realms/Realms.js:588-593`);
- bell shrine ring-clear — two owner-less orbs
  (`src/world/Interactables.js:989-992`);
- the sealed cache (`src/world/realms/RealmProps.js:555`) and the final boss
  void-loot ring (`src/world/realms/FinalBoss.js:212`), same owner-less
  `spawnOrb` shape.

An owner-less orb homes to `ItemOrb.recipient()`'s fallback, `ctx.player`
(`src/world/Interactables.js:1759-1761`), i.e. the host. A joiner who fights the
whole trial or clears the whole bell ring receives nothing from it. The gold at
`Realms.js:593` is the sharper half: an orb could at least be made a race, but
gold has no orb to race for and must be paid out per pawn.

Neither gap is a regression — pre-P2 there was one shared purse mirrored to
every client, so neither was visible. Both are consequences of splitting the
purse, and P2's headline rule ("a kill pays every pawn in full, no
kill-stealing") is contradicted by the largest single payouts in the game until
they are closed.

---

## Verification

Automated: `node tests/run.mjs`, `npm run gate:sp`, `npm run gate:mp1`,
`node tools/coopprobe.mjs`. None of it substitutes for playing the game.

Before the Co-op menu label drops "(beta)", a human runs the hand-played
gate: [`HANDPLAY-GATE.md`](superpowers/specs/HANDPLAY-GATE.md). It is
USER-ONLY — an agent never checks its boxes.

---

## What this costs

Playtesting with friends: **nothing.** Static hosting free, relay on a free
tier, Open Relay's TURN free.

If it ever gets real traffic, TURN bandwidth is the only line item that scales,
and only for the fraction of sessions that can't connect directly.

> If you ship on Steam, most of this goes away — Steam Datagram Relay does NAT
> traversal and relaying as part of the platform, and replaces both the
> signalling server and TURN. See the Steam notes for what that swap involves.
