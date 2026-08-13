# MP P3 — Downed & Revive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A killing blow in co-op downs a player instead of killing them: teammates can revive them under a bleed-out clock, the dead return at stage end with their build intact, and a party with nobody left standing wipes.

**Origin:** `docs/superpowers/specs/2026-08-04-multiplayer-roadmap-design.md` §1 (decisions: "Downed, revivable by a teammate, plus guaranteed return at stage end", bleed-out **yes**, both behaviours behind one state) and §3 P3. The roadmap wrote "PROTOCOL_VERSION → 5" when the version was 4; it is 5 today and P2 takes 6, so **this slice takes 7**.

**Prerequisite:** The P2 slice (`2026-08-12-mp-p2-per-player-economy.md`) is merged. This plan consumes `Items.of(ctx, pawn)`, `pawn.items` persistence, and `interact(pawn)` threading. If P2's execution deviated from its plan's Interfaces blocks, reconcile this plan against the merged code before dispatching Task 1 — do not execute against a stale assumption.

**Architecture:** One new system, `src/systems/Revive.js` (engine class: `init(ctx)` + `fixedUpdate`, per CONTRACTS.md), owns the downed lifecycle: bleed-out timers, revive-proximity accumulation, wipe detection, stage-end return. `Combat.applyDamage`'s kill decision (`src/systems/Combat.js:596`) forks: lethal damage to a player in a roster of 2+ enters downed instead of `_kill`. `Roster.targetable` (`src/systems/Roster.js:83`) already filters `downed !== true` — written for this slice, nothing else changes for enemy targeting. On the wire, `ESTATE` gains `DOWNED: 3` inside the existing state byte — no snapshot layout change, `PROTOCOL_VERSION` 6 → 7.

**Tech Stack:** Vanilla ES modules, `node tests/run.mjs`, `npm run gate:sp`, `tools/coopprobe.mjs` (P5 rig).

## Global Constraints

- **Single-player must stay bit-identical:** the downed fork is guarded by `ctx.roster?.count > 1` — solo lethal damage takes the *literal existing* `_kill` path, same call, same frame. `npm run gate:sp` zero fields moved after every task touching `Combat.js`, `Player.js`, or `Progression.js`. The `fingerprint.deadTarget.*` block exists precisely to catch drift in the dying path — watch it.
- **Downed state semantics (the one-state rule):** while downed, `alive` stays `true`, `downed` is `true`, the pawn is immobile and untargetable, and takes no damage except the bleed-out. `DEAD` happens only via bleed-out, wipe, or solo. Every consumer distinguishes with `Roster.targetable`, never with ad-hoc flag reads.
- **Host authority:** all downed/revive/wipe state changes happen only under `ctx.authority`; clients learn via snapshot state and events.
- **Numbers (tuning defaults, one place):** `BLEEDOUT_S = 40`, `REVIVE_S = 4`, `REVIVE_RADIUS = 4`, `REVIVE_HEALTH_FRAC = 0.4`, `RETURN_HEALTH_FRAC = 0.5`, revive progress decays at 2x speed when interrupted. These live in a `REVIVE` export in `src/data/` next to the corruption tuning table — find its file with `ls src/data/` and match its export idiom.
- **Never run bare `npx`.** Bash tool is ASCII-only; Unicode content via Write/Edit. No report prose through heredocs.
- **Probe ports:** this slice uses 5218/5219.
- **Branch:** `slice/mp-p3-downed-revive`. Commit style: single evocative sentence + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- **Line citations are signposts** — the live file wins; read before editing.

---

### Task 1: The downed state exists — fields, ESTATE, net identity

**Files:**
- Modify: `src/net/Protocol.js:147` (`ESTATE`), `src/net/Protocol.js:82` (version → 7)
- Modify: `src/entities/Player.js` (~:152 field init, ~:1270 netState getter, input application ~:536)
- Test: `tests/revive-system.test.mjs` (new)

**Interfaces:**
- Produces: `ESTATE.DOWNED = 3`.
- Produces: pawn fields — `downed: false`, `bleedout: 0` (seconds remaining, 0 when not downed), `revive: 0` (progress 0..1, host-side) — initialized in `Player.init`.
- Produces: `Player` netState rule: `downed → ESTATE.DOWNED`, else `alive ? ALIVE : DEAD` (site: `src/entities/Player.js:1270`).
- Produces: input gate — a downed pawn's movement/ability/jump inputs are ignored; `interactPressed` still ignored too (downed players cannot interact). Find the input-application site (`Player.js:536` neighbourhood) and gate the whole application on `!this.downed`, letting physics (knockback settle, gravity) continue.

- [ ] **Step 1: Write the failing test.** `tests/revive-system.test.mjs`, repo idiom (`ok(cond,msg)` counter, exit code = failures; fixture per `tests/blight-system.test.mjs:16-27`). First block: construct a real `Player` if it initializes headless (read its `init` for THREE dependencies; if the mesh path resists headless construction, use `Object.create(Player.prototype)` with hand-set fields — the exact pattern `tests/render-scale.test.mjs` uses on `RenderPipeline.prototype`). Assert: fresh pawn has `downed === false, bleedout === 0`; setting `downed = true` flips the netState getter to `ESTATE.DOWNED` (value 3); `ESTATE.DOWNED === 3` exported.

- [ ] **Step 2: Run to verify it fails** (`node tests/revive-system.test.mjs`).

- [ ] **Step 3: Implement.** Bump `PROTOCOL_VERSION` to 7 with a comment naming the slice. While here, audit `src/net/NetHost.js:547` — `if (!e.alive && e.netState !== ESTATE.DEAD) continue;` — downed pawns keep `alive === true` so they replicate normally; add a one-line comment there stating that invariant so the next reader doesn't "fix" it.

- [ ] **Step 4: Test green; `npm run gate:sp` zero moved** (no SP behaviour touched — fields exist, nothing sets them).

- [ ] **Step 5: Commit.**

---

### Task 2: Combat forks — lethal in co-op downs; downed pawns are damage-proof; `finishDowned` kills for real

**Files:**
- Modify: `src/systems/Combat.js` (`applyDamage` ~:443, kill decision ~:596, `_kill` ~:603)
- Test: `tests/revive-system.test.mjs` (append)

**Interfaces:**
- Consumes: pawn fields from Task 1.
- Produces: `Combat.prototype.enterDowned(pawn, source)` — host-only: sets `downed = true`, `bleedout = REVIVE.BLEEDOUT_S`, `revive = 0`, `health = 0`, emits `playerDowned` `{ player: pawn, position, source }`. Does NOT touch `alive`.
- Produces: `Combat.prototype.finishDowned(pawn)` — host-only: clears `downed`, then runs the existing `_kill` on the pawn so death VFX/events/`playerDead` fire exactly as today.
- Produces: damage rule — `applyDamage` early-returns for a pawn with `downed === true` (bleed-out is a timer, not damage; enemies already ignore downed pawns via `Roster.targetable`, this guard covers stray AoE).
- Produces: the fork at the kill decision (:596):

```javascript
if (target.health <= 0 && target.alive) {
  if (target.isPlayer && !target.downed && this.ctx.roster?.count > 1) {
    this.enterDowned(target, source);
  } else {
    this._kill(target, source, position, depth, info, overkill);
  }
}
```

(Match the live argument list at the site — the signature above comes from recon of `_kill(victim, source, position, depth, info, overkill)`; the live line wins.)

- [ ] **Step 1: Failing tests** — with a 2-pawn fake roster (`count: 2`): lethal damage sets `downed === true`, `alive === true`, emits `playerDowned`, and does NOT emit `playerDead`; further `applyDamage` on the downed pawn changes nothing; `finishDowned` emits `playerDead` and sets `alive === false`. With `count: 1`: lethal damage emits `playerDead` directly and `downed` stays `false`. Build the Combat fixture the way existing Combat tests do — `grep -ln "Combat" tests/*.test.mjs` and copy the closest fixture, don't invent one.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Suite green; `npm run gate:sp` zero moved** — the solo branch is the untouched literal path; `fingerprint.deadTarget.*` must not move.

- [ ] **Step 5: Commit.**

---

### Task 3: `Revive.js` — bleed-out, revive proximity, wipe, stage-end return

**Files:**
- Create: `src/systems/Revive.js`
- Create/modify: the `REVIVE` tuning export in `src/data/` (per Global Constraints)
- Modify: `src/main.js` (~:71) — `engine.add(new Revive())` immediately after `new Roster()`; confirm engine iteration order is add-order (read the engine's update loop once and cite it in your report) so Revive runs before `Interactables.fixedUpdate` consumes `interactPressed`
- Modify: `src/world/Interactables.js` — the Task-3-of-P2 roster interact scan skips pawns flagged `reviving` this tick
- Test: `tests/revive-system.test.mjs` (append)

**Interfaces:**
- Consumes: `enterDowned`/`finishDowned` from Task 2; `Roster.targetable`, `roster.all`; `stageStart` event (`src/systems/Progression.js:353`).
- Produces: the system, host-only in `fixedUpdate` (`if (!ctx.authority) return;`), per tick `h` seconds:
  - **Bleed-out:** each downed pawn's `bleedout -= h`; at `<= 0` → `finishDowned(pawn)`, emit `playerBledOut { player }`.
  - **Revive scan:** for each downed pawn D, find any targetable pawn R with `interactPressed` within `REVIVE_RADIUS` (2D distance, match `Roster.nearest`'s distance idiom). While one exists: `D.revive += h / REVIVE_S`, set `R.reviving = true` (cleared for all pawns at scan start). No reviver → `D.revive = max(0, D.revive - 2 * h / REVIVE_S)`. At `revive >= 1`: `downed = false`, `bleedout = 0`, `revive = 0`, `health = REVIVE_HEALTH_FRAC * maxHealth`, emit `playerRevived { player: D, by: R }`. (Director's heal-denial comment at `src/systems/Director.js:487-489` already assumes exactly this shape: "a revived player keeps the health they were revived with, while the denial deadline keeps running".)
  - **Wipe:** if the roster has 2+ pawns, at least one is downed, and none is targetable → `finishDowned` every downed pawn (deaths cascade into the existing all-dead run-end). First locate the existing run-end condition: `grep -rn "playerDead" src/ | grep -v net/` and read its consumers; name the site in your report. If no all-dead run-end exists for co-op (solo game-over may key on `ctx.player` alone), extending it to "no roster pawn alive" is in-scope for this task and must be its own commit.
  - **Stage-end return:** on `stageStart`, every pawn with `alive === false || downed === true` returns: `alive = true`, `downed = false`, `bleedout = 0`, `revive = 0`, `health = RETURN_HEALTH_FRAC * maxHealth`, position ← the local player's stage-start position (`Coop._spawnPawn` already parks new pawns at the local player — copy that placement call). Build intact is automatic: `pawn.items` was never torn down (P2 guarantee, roadmap consequence rule).
- Produces: events `playerDowned`, `playerRevived`, `playerBledOut` (broadcast — every peer sees a teammate go down; Task 4 wires forwarding).

- [ ] **Step 1: Failing tests** — drive `Revive` with a fake ctx (`authority: true`, events bus, fake roster of plain pawn objects, `h = 1/60` stepped in a loop):
  - downed pawn with no reviver bleeds out in exactly `BLEEDOUT_S / h` steps → `playerBledOut` then `playerDead` ordering;
  - reviver inside radius with `interactPressed` completes in `REVIVE_S / h` steps → revived at 40% max health;
  - reviver leaving at 50% progress decays to 0 at double speed, pawn still downed;
  - two downed + zero targetable → both die same tick (wipe);
  - `stageStart` with one dead + one downed → both alive at 50%, `downed === false`, and (P2 seam) their `items` references are the same objects as before death.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `Revive.js` with the header-comment style the other systems carry (one paragraph: what it owns, what it never touches). Zero-allocation scan in the hot path (`forEachTargetable` idiom, `src/systems/Roster.js:159`).

- [ ] **Step 4: Suite green; `npm run gate:sp` zero moved** (Revive's fixedUpdate on a roster of one with nobody downed is a no-op scan; if the gate moves anything, the scan is doing work in SP — fix that, don't rebaseline).

- [ ] **Step 5: Commit** (two commits if the run-end condition needed extension).

---

### Task 4: The wire knows — snapshot DOWNED, event forwarding, client presentation state

**Files:**
- Modify: `src/net/NetViews.js` (state handling ~:86-173), `src/net/NetClient.js` (~:409, :454 dead-state branches)
- Modify: `src/net/NetHost.js` (event forwarding table — add the three revive events as broadcasts via `_forward`, :607)
- Modify: `src/entities/Player.js` — remote-pawn snapshot application (where a remote `Player` ingests `ESTATE`; recon says views handle it — read `PlayerView` in NetViews.js first)
- Test: `tests/revive-net.test.mjs` (new)

**Interfaces:**
- Consumes: `ESTATE.DOWNED` from Task 1; events from Task 3.
- Produces: client rule — a view/pawn receiving `state === ESTATE.DOWNED` sets `downed = true` (and `alive = true`); receiving `ALIVE` after `DOWNED` clears it; `DEAD` behaves as today. While downed, `healthFrac` on the wire carries `bleedout / BLEEDOUT_S` so remote HUDs can draw the clock — host writes it at the snapshot-build site (`NetHost._broadcastSnapshot`, :532-568; the entity writer packs `healthFrac` from health — special-case downed pawns there, with a comment).
- Produces: host forwards `playerDowned` / `playerRevived` / `playerBledOut` to all peers via `_forward` (payloads carry `netId`, not object refs — resolve pawn→netId the way the snapshot writer does; strip live refs exactly as P2's Task 5 strips `owner`).

- [ ] **Step 1: Failing tests** — round-trip: `writeEntity`/`readEntity` (`src/net/Protocol.js:258-289`) preserves `state = 3`; a fake view fed `state: 3` reports `downed === true, alive === true`; fed `state: 0` afterwards reports revived. Use the `Peer`/`chan()` fixtures from `tests/netlag.test.mjs:14-28` for any channel-level assertion.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `NetClient.js:409/:454`, the DEAD branches must not swallow DOWNED — read both sites and keep dying-animation logic keyed strictly to `ESTATE.DEAD`.

- [ ] **Step 4: Suite green; `npm run gate:sp` zero moved.**

- [ ] **Step 5: Commit.**

---

### Task 5: The player can tell — HUD, prompt, audio

**Files:**
- Modify: `src/ui/HUD.js` — own-downed overlay (bleed-out bar + "hold E to be revived"? No: downed players wait; the *reviver* gets the prompt), teammate-down marker, revive-progress ring
- Modify: `src/systems/Audio.js` (~:1457 route table) — add `playerDowned`, `playerRevived` routes next to `playerDead`
- Test: visual verification in the running app (below) — no headless UI test

**Interfaces:**
- Consumes: events from Task 3/4; downed fields on pawns.
- Produces: three HUD affordances, all built from existing HUD idioms (match the teleporter-charge readout's markup/update pattern — find it via the `teleporterCharging` listener in HUD.js):
  1. Local player downed → full-screen tint + centered bleed-out bar draining over `BLEEDOUT_S`, label "BLEEDING OUT".
  2. A teammate downed → edge-of-screen marker toward them (copy whatever off-screen indicator idiom exists; if none exists, a pulsing name label in the party readout is the floor — do not invent a new world-space projection system for this slice).
  3. Local player within `REVIVE_RADIUS` of a downed teammate → prompt "HOLD E — REVIVE" with a progress ring bound to the downed pawn's `revive` (host) / replicated fraction (client).
- Produces: audio — reuse existing palette-adjacent cues; if the audio route table needs a new sample, the floor is routing `playerDowned` to the existing `playerDead` sound at lower gain, with a comment marking it a placeholder for the audio pass (memory: the audio graph has a known flaw ticket; do not compound it with new graph nodes).

- [ ] **Step 1: Implement** (UI/audio task — TDD does not apply; the verification is the probe + eyeballs).
- [ ] **Step 2: Verify in the running app** — dev server on port 5218, two tabs via room-code join (`npm run signal` locally), `?netlag=40-90` on the client tab. Down the client's pawn (console: lethal `applyDamage` via the harness hooks if a debug path exists — `grep -n "harness" src/core/Harness.js` for the exposed handles), observe all three affordances from both seats.
- [ ] **Step 3: Screenshot each affordance into the review directory** (`reviews/round9/mp-p3-hud-*.png`) via the probe's screenshot idiom, not `shots/`.
- [ ] **Step 4: Commit.**

---

### Task 6: Slice gate

- [ ] **Step 1:** `node tests/run.mjs` green; `npm run gate:sp` zero moved — outputs pasted in the report.
- [ ] **Step 2:** Coopprobe arms (P5 rig) at 0 ms and `--netlag 40-90`: connection formation green, then the P3 assertions — client pawn downed on host → client HUD shows downed within 1 s; revive completes; bleed-out produces `playerDead` on both pages; stage-end returns the dead with inventory object identity preserved.
- [ ] **Step 3:** Re-verify prior fixes plausibly disturbed (roadmap rule 4), and name what you skipped: the P1 targeting slice's 40 m acquisition captures (downed pawns must vanish from enemy target sets — the `targetable` filter claims it; probe it, don't trust it), and P2's economy isolation (a revived pawn's directed events still route to the right peer).
- [ ] **Step 4:** Merge per superpowers:finishing-a-development-branch; review file `reviews/round9/mp-p3-review.md`.

## Explicitly out of scope

- Downed crawl/movement (immobile is the shipped floor; crawl is tuning-driven polish).
- Execution mechanics (enemies finishing downed players) — rejected for now: bleed-out is the only clock, keeps the "go get them" read clean.
- `Realms`/`FinalBoss` scripted-arena targeting redesign — the roadmap parks it in P3's *era* but it is a design pass, not this slice; it happens against hand-play evidence.
- Revive items/artifacts (post-EA content).
