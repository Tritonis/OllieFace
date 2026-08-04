# Multiplayer roadmap — finishing co-op

**Date:** 2026-08-04 · **Branch:** `round7/content-and-polish` · **Base:** `a43cc70`

This document records the decisions that scope the co-op work and the order the
work happens in. It supersedes the recommendation in
`reviews/round7/SESSION-SUMMARY.md` §2 ("hide the Co-op menu entry"): we are
finishing co-op rather than shipping around it.

Each sub-project below gets its own brainstorm → spec → plan → implementation
cycle. Only P0/P1 is specified today
(`2026-08-04-coop-roster-targeting-design.md`); P2–P5 are specified when
reached, informed by what P1 teaches.

---

## 1. Decisions

| Question | Decision |
|---|---|
| Scope | **Finish the current architecture.** Host-authoritative pawns + snapshots stay. No netcode redesign — seven rounds of evidence say the netcode is not where the failures are. |
| Aggro model | **Sticky nearest-target with hysteresis.** Each enemy holds a `targetPlayer`, re-evaluated on a stagger, switching only past a margin. |
| Death rules | **Downed, revivable by a teammate, plus guaranteed return at stage end.** Two routes back: a fast one the team earns, a slow one nobody can lose. |
| Bleed-out | **Yes** — a downed player dies for real if not revived, and then waits for stage end. Creates the "drop everything and go get them" moment. Both behaviours live behind one state, so this is cheap to reverse. |
| Economy | **Per-player inventory and gold.** Each pawn owns its own item set. Builds diverge; that is most of co-op's replay value. |
| Verification | **Automated harness *and* a mandatory hand-played gate.** Scripted probes for regression numbers; a hand-played full co-op run is a required gate before any of this is called done. |
| Remote play | **In scope.** TURN provisioning, `wss://` signalling and a latency rig are part of the work, not an afterthought. |

### Consequences worth stating

- **A player who returns at stage end must return with their build intact.**
  Per-player inventory (P2) must survive pawn death rather than being torn down
  with it. This is why P2 precedes P3.
- **Downed players are not valid enemy targets.** P1's roster query filters
  them, which means P1 must define the downed state even though P3 implements
  the behaviour around it.
- The Co-op menu entry stays live, relabelled **"Co-op (beta)"**. It reverts to
  a plain label when P5's hand-play gate passes.

---

## 2. The diagnosis this roadmap is built on

`ctx.player` is one name doing three different jobs across 153 sites. Treating
those as one problem is why seven rounds of co-op fixes did not converge.

| Meaning | Sites | Verdict |
|---|---|---|
| "the player this screen belongs to" | `HUD` (10), `VFX` (8), `Menus` (4), `Combat` (3), `CameraRig` (1), `Music` (1) | **Correct.** Genuinely means the local viewer. Do not touch. |
| "the one player the authority simulates" | `Enemy` (21), `Director` (9), `Realms` (8), `Interactables` (6) | **Wrong.** Needs a roster and a spatial query. This is N-1. |
| "the owner of this gameplay state" | `Items` (16), `Progression` (6), `Profile` (2) | **Wrong.** Needs per-pawn ownership. This is the economy work. |

Three problems, three different fixes, three different risk profiles.

`Combat`'s three sit in the first row deliberately. Round 5 changed them from
`isPlayer` to `=== ctx.player` precisely so that a teammate 40 m away losing
health stops resetting *this* player's hurt timer, flashing their HUD and
ducking their music. They are already right; touching them would undo that fix.

The middle row is split across sub-projects rather than done at once, so that no
subsystem's reads go unclaimed: `Enemy` + `Director` → **P1**;
`Interactables` → **P2**, where proximity and ownership are the same question;
`Realms` + `FinalBoss` → **P3**, because authored arenas have scripted targeting
that needs a design pass rather than a mechanical substitution, and specifying
them before revive exists would mean specifying them twice. The one exception is
`FinalBoss`'s `denyHealing` call, which P1 fixes alongside `Director`'s.

---

## 3. Sub-projects

| | Sub-project | Depends on | Size |
|---|---|---|---|
| **P0** | **Lifecycle sweep + latency rig.** C-2, C-7→C-1, C-10, C-4, and the `?netlag=` injection point. | — | Hours |
| **P1** | **Roster + enemy targeting.** The `Roster` system, sticky nearest-target, per-player heal denial, spawn distance, balance pass. Where co-op starts existing. | P0 | ~1 week |
| **P2** | **Per-player items & gold.** `Items` singleton becomes instanced per pawn; chest/shrine/orb ownership; per-peer directed replication. Largest piece. | P1 | ~1–2 weeks |
| **P3** | **Downed & revive.** Downed state, bleed-out, revive interaction, stage-end return, wipe condition, snapshot fields, `PROTOCOL_VERSION` → 5. | P1, P2 | ~1 week |
| **P4** | **Remote-network reality.** Provision TURN, deploy `wss://` signalling, ICE diagnostics panel. Runs parallel to P1–P3. | — | ~3 days |
| **P5** | **Verification.** Headless deterministic sim tests, N-peer probe rigs, the hand-played gate. | continuous | continuous |

**P0 is first** because doing surgery on a branch that still bricks a survivor
on *Leave co-op* wastes every measurement taken on it. The latency rig is pulled
forward into P0 from its natural home in P4 for the same reason: every
measurement from P1 onward should run at both 0 ms and a realistic RTT.
All seven prior rounds measured against a zero-latency fiction.

**P4 is parallel** because it is pure infrastructure with no code overlap with
P1–P3 — and because until TURN exists, remote play cannot honestly be tested.

---

## 4. Remote play — where it actually stands

The transport is WebRTC `RTCPeerConnection` with two `DataChannel`s (`state`,
unreliable/unordered, for input and snapshots; `events`, reliable/ordered, for
one-shot facts). That is the right shape and it is peer-to-peer over the public
internet. Two connection paths exist: manual base64 SDP blobs (`Lobby.joinManual`,
no server at all) and room codes via `tools/signal-server.mjs`.

Three gaps between "supports it" and "your friend can play":

1. **No TURN is provisioned.** `NetConfig.iceServers()` ships two public STUN
   entries; TURN appears only if `VITE_TURN_URLS` is supplied. STUN-only means
   any pair behind symmetric NAT never connects, and it fails *silently* — an
   ICE candidate list that never pairs. `NetConfig.js`'s own header says this.
   Largest remote-play risk. → **P4**
2. **Signalling defaults to `ws://127.0.0.1:8787`.** A deployed build needs
   `VITE_SIGNAL_URL` or `?signal=`, and an HTTPS page requires `wss://`. The
   manual path sidesteps this entirely. → **P4**
3. **No session has ever run under real latency.** The client predicts and
   reconciles its own movement over a 256-tick replay window and interpolates
   everything else, so the shape is right, but every RTT-dependent behaviour is
   unmeasured. → **P0** (rig) and **P5** (arms)

---

## 5. Process rules carried forward

From `SESSION-SUMMARY.md` §6, learned the expensive way. These bind every
sub-project:

1. State the failure at **both ends** of every range — a fix aimed at a number
   can overshoot into the opposite failure.
2. **A gate never failed on purpose is not a gate.** Fail gates one fix at a
   time; a blanket revert hides which fix a gate is sensitive to.
3. Every quoted number names its **on-disk raw capture**. Correct wrong numbers
   in place, with the file key that settles each.
4. **Re-verify every prior fix you could plausibly disturb, and name what you
   skipped.**
5. Verify against **HEAD's literal condition**, not an approximation and not the
   current tree.
6. Gate every co-op arm on the game **actually running** — `paused false` and
   `_localTick > 60` on every page before installing any instrument.
7. A reviewer's prescription can be wrong. Verify prescriptions; ship what is
   right and say why.
8. **Point a rig at what nobody has pointed one at.**
9. **Check that a recommendation was acted on.** Thirteen reports said "hide the
   Co-op entry"; none checked; it was still there.

Two additions from this session:

10. **Single-player must stay bit-identical.** A roster of one is the invariant
    that makes the whole migration verifiable. Any sub-project that moves a
    single-player number must say so and justify it.
11. **Nobody has played a full run by hand, and nobody has listened to the
    audio.** Both are gates, not chores.
