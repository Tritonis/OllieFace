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

`tools/signal-server.mjs` is ~60 lines. It sees no game traffic; once peers
connect it is irrelevant. It can idle on a free tier forever.

It reads `PORT` from the environment and answers `GET /healthz`, so it works
as-is on Render, Railway, Fly.io, Cloud Run or Heroku.

**On Render (free tier), as an example:**

1. Push this repo to GitHub.
2. New → Web Service → point at the repo.
3. Build command: `npm install`
4. Start command: `node tools/signal-server.mjs`
5. Deploy. You get `https://your-thing.onrender.com`.
6. Your signalling URL is that with the scheme swapped: `wss://your-thing.onrender.com`

Check it: `curl https://your-thing.onrender.com/healthz` → `{"ok":true,"rooms":0}`

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
wins, and persists.

| `.env` | Query | Purpose |
|---|---|---|
| `VITE_SIGNAL_URL` | `?signal=` | Signalling relay WebSocket URL |
| `VITE_TURN_URLS` | `?turn=` | Comma-separated TURN URLs |
| `VITE_TURN_USERNAME` | `?turnuser=` | TURN username |
| `VITE_TURN_CREDENTIAL` | `?turnpass=` | TURN credential |
| `VITE_ICE_POLICY` | `?ice=relay` | Force relay-only (TURN test) |

Pass an empty query value (`?turn=`) to clear a persisted override.

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
