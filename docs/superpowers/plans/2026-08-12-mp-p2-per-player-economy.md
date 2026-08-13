# MP P2 — Per-Player Items & Gold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pawn owns its own `Items` instance — inventory, gold, equipment — with host-authoritative simulation and *directed* (per-peer) replication, so co-op builds diverge while single-player stays bit-identical.

**Origin:** `docs/superpowers/specs/2026-08-04-multiplayer-roadmap-design.md` §3 sub-project P2 ("Per-player items & gold. `Items` singleton becomes instanced per pawn; chest/shrine/orb ownership; per-peer directed replication"). The roadmap's consequence rule binds this slice: *a player who returns at stage end must return with their build intact* — so instances live on pawns, not on peers' connections.

**Architecture:** The engine-added `Items` instance (`src/main.js:60`) remains `ctx.items` and becomes *the local viewer's* economy — every existing HUD/Menus/system read of `ctx.items` keeps meaning "the screen's player", untouched. On the host, each remote pawn gains its own `new Items(pawn)` created in `Coop._spawnPawn` and destroyed in `_despawnPawn`. A static resolver `Items.of(ctx, pawn)` maps pawn→instance everywhere the acting player is no longer assumed to be `ctx.player`. Economy events (`goldChanged`, `itemPickup`, `equipmentChanged`, `goldReward`, `itemMutated`) carry an `owner` pawn ref locally; `NetHost` forwards them *only* to the owning peer via the existing directed `_send(peer, name, payload)` path (`src/net/NetHost.js:599`, precedent `_forwardHurt` at :579). Clients keep their existing mirror listeners in `Items.js` almost unchanged — a client only ever receives its own economy events, so "the event is about me" stays true by construction.

**Tech Stack:** Vanilla ES modules, `node tests/run.mjs` headless suite, `npm run gate:sp` fingerprint gate, `tools/coopprobe.mjs` (built by the P5 plan — see Execution Order below).

## Execution Order (read first)

This plan assumes `tools/coopprobe.mjs` from `2026-08-12-mp-p5-verification.md` Task 1–2 exists. **Execute P5 Tasks 1–3 before this plan.** Rationale: the repo's standing lesson is that all merge gates are blind to connection formation — a net-touching slice needs a probe arm before *and* after (memory: net-changes-need-probe-arms). If the rig is absent, stop and say so rather than substituting a hand-wave.

## Global Constraints

- **Single-player must stay bit-identical** (roadmap process rule 10). A roster of one takes exactly the same code path count: one `Items` instance, one `rewardKill` call, one interact scan. Gate: `npm run gate:sp` with **zero fields moved** after every task that touches `Items.js`, `Interactables.js`, or `Combat.js`.
- **RNG streams are sacred:** remote pawns' equipment/item rolls must NOT consume `ctx.rng` draws that single-player consumes (sp-equivalence is a chaotic amplifier — 1 cm of drift rewrote thirteen entries). Remote instances roll on a per-pawn derived stream (Task 2), the same trick the shrine-type roll already uses.
- **Host authority:** every mutation stays gated exactly as today (`give`/`take`/`rewardKill` host-only; `Interactables.requestInteract` gates on `ctx.authority` at `src/world/Interactables.js:2068`). Clients mutate nothing.
- **`PROTOCOL_VERSION` 5 → 6** (`src/net/Protocol.js:82`): directed economy events change what a client may assume about broadcast events; old clients must be refused, not confused.
- **Never run bare `npx`** (it deletes the rolldown binding). Use `npm run` scripts or `node node_modules/.bin/...` / `node tools/<probe>.mjs` directly.
- **Bash tool is ASCII-only** on this box: file content with non-ASCII goes through Write/Edit, never heredoc/echo. No report prose through heredocs.
- **Probe ports:** this slice uses 5216 (host page) / 5217 (spare). Kill your own dev-server processes when done.
- **Branch:** `slice/mp-p2-per-player-economy` off master. **Commit style:** single evocative sentence describing the semantic change, ending with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- **Line citations are signposts** — the live file wins; read before editing.

---

### Task 1: `Items` becomes instantiable per pawn, and `Items.of()` resolves owner→instance

**Files:**
- Modify: `src/systems/Items.js` (constructor ~line 130, `init` ~line 178)
- Modify: `src/net/Coop.js` (`_spawnPawn` ~line 39, `_despawnPawn` ~line 61)
- Test: `tests/items-per-pawn.test.mjs` (new)

**Interfaces:**
- Produces: `new Items(owner = null)` — `owner === null` means "the engine singleton; adopt `ctx.player` as owner and register as `ctx.items`". `owner !== null` means "a satellite instance for a remote pawn; do NOT register on ctx, do NOT subscribe UI-facing listeners".
- Produces: `Items.of(ctx, pawn)` (static) → the `Items` instance owning `pawn`: `ctx.items` when `pawn === ctx.player || pawn == null`, else `pawn.items ?? null`. Every later task resolves economies through this and only this.
- Produces: `pawn.items` — set by `Coop._spawnPawn` on the host, disposed in `_despawnPawn`.

- [ ] **Step 1: Write the failing test**

Create `tests/items-per-pawn.test.mjs` using the repo's assertion idiom (`tests/blight-system.test.mjs:4-5` — local `ok(cond, msg)` counter, exit code = failures). Fixture: minimal `ctx` with an events bus (copy the `makeCtx` shape from `tests/blight-system.test.mjs:16-27`), a fake local pawn `{ isPlayer: true }` assigned to `ctx.player`, and a fake remote pawn `{ isPlayer: true, peerId: 2 }`.

```javascript
import { Items } from '../src/systems/Items.js';

// 1. Singleton path: owner-less instance adopts ctx.player and registers.
const local = new Items();
local.init(ctx);
ok(ctx.items === local, 'owner-less Items registers as ctx.items');
ok(Items.of(ctx, ctx.player) === local, 'Items.of resolves local pawn to ctx.items');
ok(Items.of(ctx, null) === local, 'Items.of(null) falls back to viewer instance');

// 2. Satellite path: owned instance does not steal ctx.items.
const remote = new Items(remotePawn);
remote.init(ctx);
remotePawn.items = remote;
ok(ctx.items === local, 'satellite Items must not replace ctx.items');
ok(Items.of(ctx, remotePawn) === remote, 'Items.of resolves remote pawn to its own instance');

// 3. Isolation: gold and stacks do not bleed between instances.
local.gold = 0; remote.gold = 0;
remote.addGold(25);
ok(local.gold === 0 && remote.gold === 25, 'gold mutations stay on the owning instance');
```

Note: `addGold` is host-gated — the fixture ctx needs `authority: true` (read the live guard in `Items.js:476` and satisfy it exactly).

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/run.mjs` (or the single file: `node tests/items-per-pawn.test.mjs`)
Expected: FAIL — constructor takes no owner today and `Items.of` does not exist.

- [ ] **Step 3: Implement**

In `Items.js`:
- Constructor: `constructor(owner = null) { this.owner = owner; ...existing field init... }`.
- `init(ctx)`: keep everything for the owner-less path, but wrap the two registration behaviours: `if (!this.owner) { ctx.items = this; }` and skip subscribing the *client mirror* listeners (`itemPickup`/`goldChanged`/`equipmentChanged` client branches, ~lines 242-275) on satellite instances — satellites live only on the host and mirror nothing. Event subscriptions that drive simulation (`stageStart`, `corruptionBand`, `jump`, `abilityUsed`, `playerHurt`) must be filtered per-owner in Task 5; for now satellites subscribe to `stageStart` only.
- Add the static:

```javascript
static of(ctx, pawn) {
  if (!pawn || pawn === ctx.player) return ctx.items ?? null;
  return pawn.items ?? null;
}
```

In `Coop.js` `_spawnPawn`: after the pawn is registered with Combat, `pawn.items = new Items(pawn); pawn.items.init(ctx);`. In `_despawnPawn`: `pawn.items?.dispose?.();` before `pawn.dispose()` — add a `dispose()` to `Items` that unsubscribes its listeners (match how other systems unsubscribe; if the events bus has no `off`, record the unsub functions `on()` returns, per the live bus contract in `src/main.js`).

- [ ] **Step 4: Run tests + the SP gate**

Run: `node tests/run.mjs` then `npm run gate:sp`
Expected: suite green; gate reports zero fields moved (the singleton path is untouched: same construction site, same init order).

- [ ] **Step 5: Commit**

---

### Task 2: Satellite RNG — remote rolls come from a derived stream

**Files:**
- Modify: `src/systems/Items.js` (`rollItem`, `rollEquipment`, and any other `ctx.rng` draw)
- Test: `tests/items-per-pawn.test.mjs` (append)

**Interfaces:**
- Produces: `Items.prototype._rng()` → the stream every roll in this class draws from: `this.owner ? this._ownRng : this.ctx.rng`, where `_ownRng` is an LCG seeded in `init` from `ctx.seed` (or the run seed the live code exposes — find it where `Corruption` derives its stream) XOR a stable per-pawn salt (`this.owner.peerId * 2654435761 >>> 0`).

- [ ] **Step 1: Write the failing test** — append: with two satellite instances for peerId 2 and 3, `rollItem()` sequences differ from each other and from the singleton's; and constructing/rolling on satellites does not advance the singleton's next roll (capture singleton's next value before and after satellite rolls; must be equal).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — find every `this.ctx.rng` (and `ctx.rng`) draw inside `Items.js` (`grep -n "rng" src/systems/Items.js`), route each through `this._rng()`. The derived-stream precedent is the shrine-type roll (see `docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md:87-89` and its implementation in `Interactables.js`) — copy its LCG shape, do not invent a new one.

- [ ] **Step 4: `node tests/run.mjs` green, `npm run gate:sp` zero moved** (singleton path must compile to the same draw sequence).

- [ ] **Step 5: Commit.**

---

### Task 3: Kill gold pays every pawn; interacts charge the acting pawn

**Files:**
- Modify: the `rewardKill` call site (find with `grep -rn "rewardKill" src/` — expect one host-side caller; read it before editing)
- Modify: `src/world/Interactables.js` — `fixedUpdate` (~:2059), `requestInteract` (~:2067), and every `interact()` implementation that touches economy or corruption: `Chest` (:342), `MultishopTerminal` (:433), `AuricCairn` (:632), `IchorFont` (:735), `ArgentFont` (:1381), `CovenantStone` (:1457)
- Test: `tests/economy-ownership.test.mjs` (new)

**Interfaces:**
- Consumes: `Items.of(ctx, pawn)` from Task 1.
- Produces: `interact(pawn)` — every interactable's `interact` gains the acting pawn as its first parameter; `requestInteract(pawn)` passes it through. `prompt()` signatures unchanged (prompts are viewer-side UI and correctly read `ctx.items`).
- Produces: kill-payout rule — **every registered pawn receives the full `killReward`** (no split, no kill-steal incentive; a roster of one degenerates to today's exact single call). This is a design decision this plan makes; record it in the commit message.

- [ ] **Step 1: Write failing tests** in `tests/economy-ownership.test.mjs` (same fixture idiom; fake roster exposing `all` as an array of the two pawns):
  - Kill payout: invoke the (extracted) payout loop with a 2-pawn roster → both instances' gold rises by the same full amount.
  - Interact charge: a fake chest-like charge path via `Items.of(ctx, remotePawn).spendGold(cost)` → remote pays, local unchanged.
  - Void-credit attribution: `Chest.interact(remotePawn)` with insufficient remote gold routes `cor.feed(remotePawn, ...)` — assert the fake corruption records the *remote* pawn, not `ctx.player` (this is the bug class the whole task exists to kill).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement:**
  - Kill site: replace the single `ctx.items.rewardKill(victim)` with:

```javascript
const roster = ctx.roster;
if (roster && roster.count > 1) {
  for (const p of roster.all) Items.of(ctx, p)?.rewardKill(victim);
} else {
  ctx.items?.rewardKill(victim);
}
```

  (The `count > 1` branch keeps the SP path literally identical, not just equivalent. Check the live roster surface — the scout map lists `count`, `local`, `alive` getters plus `nearest`/`forEachTargetable`; if `all` is not public, add a getter returning the raw array, mirroring `alive`.)
  - `Interactables.fixedUpdate`: replace the `ctx.player?.interactPressed` check with a roster scan on the host — `ctx.roster` of one keeps this a single iteration:

```javascript
if (ctx.authority && ctx.roster) {
  for (const p of ctx.roster.all) if (p?.interactPressed) this.requestInteract(p);
} else if (ctx.player?.interactPressed) this.requestInteract(ctx.player);
```

  (Remote pawns already receive the INTERACT bit — clients send it at `src/net/NetClient.js:282` and `Player.js:536` unpacks it. Verify NetHost applies packed client input to the remote pawn before relying on this; if it doesn't, that application is a prerequisite fix inside this task — cite the site in your report.)
  - `requestInteract(pawn)` → `_nearest(pawn)` unchanged, then `it.interact(pawn)` — thread the parameter into every `interact()` implementation. Inside each, replace `this.ctx.player` with the `pawn` parameter **where it means "the acting player"**: `Chest.interact` corruption feeds (:353, :355-362 void-credit), `IchorFont` health-payer (:736), `ArgentFont` bleed target (:1387), `CovenantStone` volunteer (:1459), `AuricCairn`/`MultishopTerminal` gold spends → `Items.of(this.ctx, pawn)`. Leave `ItemOrb.fixedUpdate`'s `ctx.player` read alone — Task 4 owns orbs.

- [ ] **Step 4: `node tests/run.mjs` green; `npm run gate:sp` zero moved.**

- [ ] **Step 5: Commit.**

---

### Task 4: Orb ownership — the opener's loot homes to the opener

**Files:**
- Modify: `src/world/Interactables.js` — `spawnOrb` (find with `grep -n "spawnOrb" src/world/Interactables.js`), `ItemOrb.fixedUpdate` (~:1714), the orb-collection grant (~:2048)
- Test: `tests/economy-ownership.test.mjs` (append)

**Interfaces:**
- Consumes: `interact(pawn)` from Task 3.
- Produces: `spawnOrb(position, itemId, scale, ownerPawn = null)` — a trailing owner param; every call site inside an `interact(pawn)` passes `pawn`. Orbs home toward `this.ownerPawn` when it is targetable (`Roster.targetable`, `src/systems/Roster.js:83`), else fall back to the current nearest-player behaviour. Collection grants via `Items.of(ctx, this.ownerPawn ?? collector)`.

- [ ] **Step 1: Failing test** — an orb with `ownerPawn = remotePawn` grants to the remote instance even when the fixture "collects" it at the local pawn's position; an owner-less orb behaves exactly as today (grant to `ctx.items`).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Homing target selection:

```javascript
const target = (this.ownerPawn && Roster.targetable(this.ownerPawn))
  ? this.ownerPawn : this.ctx.player;
```

Owner who bled out mid-flight → loot falls to the fallback rather than evaporating. Import `Roster` the way `Director.js:498` already does.

- [ ] **Step 4: Suite green; `npm run gate:sp` zero moved** (SP: `ownerPawn === ctx.player`, same target, same frames).

- [ ] **Step 5: Commit.**

---

### Task 5: Owner-filtered simulation events, and directed replication

**Files:**
- Modify: `src/systems/Items.js` — event subscriptions in `init` (~:193-302), event emissions in `_set` (:350), `addGold` (:476), `spendGold` (:532), `rewardKill` (:513), `setEquipment` (:917), `_mutateAt`
- Modify: `src/net/NetHost.js` — the event-forwarding table (find where `goldChanged`/`itemPickup` are forwarded; pattern anchor `_forwardHurt` :579, `_send` :599, `_forward` :607)
- Modify: `src/net/Protocol.js:82` — `PROTOCOL_VERSION = 6`
- Test: `tests/economy-ownership.test.mjs` (append)

**Interfaces:**
- Produces: every economy event payload gains `owner: <pawn>` (the live object, host-side only — it never serializes; NetHost uses it for routing then strips it).
- Produces: NetHost routing rule — `goldChanged`, `itemPickup`, `equipmentChanged`, `goldReward`, `itemMutated` forward via `_send(peerOf(owner), ...)` only; owner = host's player → no send at all. `peerOf` resolution: `Coop` pairs peerId↔pawn at `_spawnPawn`; expose the lookup the way `_forwardHurt` already finds the hurt pawn's peer — copy that resolution, do not invent a parallel one.
- Produces: per-owner listener filtering — satellite instances' gameplay listeners (`playerHurt`, `abilityUsed`, `jump`) act only when `e.player === this.owner` (or the event's equivalent identity field — read each payload at its emit site first); the singleton keeps filtering exactly as today.

- [ ] **Step 1: Failing tests** — (a) emitting a satellite's `addGold` puts `owner: remotePawn` on the event; (b) a fake NetHost forwarding table sends it to peer 2 only (fixture: two fake peers with `sent` arrays, `chan()` idiom from `tests/netlag.test.mjs:14-28`); (c) the local player's `addGold` triggers no directed send; (d) a satellite ignores a `playerHurt` for the other pawn.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Client side needs **no listener rewrite**: a client only ever receives events about its own pawn, so the existing mirrors (`Items.js:242-275`) stay semantically correct — add one guard dropping any event that still carries a foreign identity, as armour. Strip `owner` before JSON sanitisation in `_send` (live sanitiser location: `NetHost.js:599`). Bump `PROTOCOL_VERSION` to 6 with a one-line comment naming this slice.

- [ ] **Step 4: Suite green; `npm run gate:sp` zero moved.**

- [ ] **Step 5: Commit.**

---

### Task 6: Slice gate — probe arms and the merged result

- [ ] **Step 1:** `node tests/run.mjs` — entire suite green.
- [ ] **Step 2:** `npm run gate:sp` — zero fields moved, full output pasted into the task report.
- [ ] **Step 3:** Connection-formation probe arm (requires P5's rig): `node tools/coopprobe.mjs --port 5216` at 0 ms, then with `--netlag 40-90`. Both must reach `roster count 2 on both pages, paused false, _localTick > 60`. Then the P2-specific assertions: host chest opened by the client charges only the client's gold; a kill pays both. If the rig lacks those assertions yet, extend it (it is designed for extension — see P5 Task 2's `checks` array contract).
- [ ] **Step 4:** One capture smoke: `node tools/capture.mjs --out shots-p2 --port 5217 --only 01-title` → `subjectsOk: true`, then delete the directory. Never capture into `shots/`.
- [ ] **Step 5:** Merge per superpowers:finishing-a-development-branch. The review dispatch writes to `reviews/round9/mp-p2-review.md` (findings cite exact `file:line`).

## Explicitly out of scope

- Progression XP split / per-player levels (`Progression.js` ctx.player sites are viewer-attribution; roadmap assigns any redesign to P3's authored-arena pass or later).
- Chest price scaling with player count (Director economy tuning — separate slice after hand-play evidence).
- Teammate-inventory UI (HUD shows the viewer; a spectate/teammate panel is post-P3 polish).
- Client-side prediction of gold (display lags one RTT; acceptable, matches `playerHurt` handling).
