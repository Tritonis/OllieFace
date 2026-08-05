# Round 7 — critique round 4, consolidated

Four independent critics against HEAD `a43cc70` (round-4 fixes). Each
re-measured round 4's claims rather than accepting them. `RUBRIC.md` caps this
project at four critic rounds, so **this is the last word**: there is no round 5
to catch anything left out here, and this document is the ship decision.

| Critic | Verdict | Confirmed | Refuted | Report |
|---|---|---|---|---|
| engine/meta | NOT READY — 0 crit, 2 maj, 6 min | 12 | 3 | `round4-critique-engine.md` |
| physics/co-op | 1 crit, 6 maj, 4 min | 19 (+9/9 co-op) | 2 | `round4-critique-physics.md` |
| audio | FAIL — 0 crit, 3 maj, 3 mod, 4 min | 20 | 3 | `round4-critique-audio.md` |
| content | NOT READY — 1 crit, 2 maj, 3 mod, 3 min | 21 | 5 (+4 unverifiable) | `round4-critique-content.md` |

Build exit 0 on all four. Capture 21/21 scenarios, `06-loaded-hud` still the one
failing check — unchanged in kind from `E-framing.md` §5 through four rounds, and
the reason `capture.mjs` exits 1. The physics report doubles as the whole-branch
merge review.

## What round 4 actually achieved

Round 3's blocking list is closed, and closed by instruments the fixers did not
have. The engine double-loop is fixed and holds at **51** cumulative freeze/thaw
cycles — 2.4× the depth it was tested to — and three critics independently
measured `1.000` `_frame` per presented frame on this tree, so every number in
this round is clean of it. The Bramble Lasher, broken for three rounds running,
is fixed: two independent instruments agree to three decimal places, and the
agency arm the fixer honestly declined to claim was closed by the critic. The
intensity model is repaired at both ends (0.792 of range at difficulty 1, 0.277
at the cap, `cool()` moving 0.30 where round 3 moved 0.000) and the capture gate
genuinely stopped certifying silence. Containment is not merely measured but
**structurally guaranteed** — 0 steps below the floor and 0 outside the bound
across 240,000 jump-spam steps and a sweep to 800 m/s, with `Stage.js:635-636`
and `Stage.js:591-592` making it unfailable. Barrier-absorbed damage no longer
counts as damage taken, so `Untouchable` and `Ironclad` are achievable and the
round-3 escalation is closed. The cross-tab merge holds across two real tabs with
`lostKills 0`. All nine co-op claims reproduce exactly.

Round 3's lesson was obeyed. Every fixer stated the failure at *both* ends of its
range, and both nominated overshoot sites — the Scrapfly at ten stacks, the
impulse trails — came back clean on the item's own terms. The gate was failed on
purpose in three domains: the audio critic built a byte-faithful sabotaged
`capture.mjs` with four new arms, the content critic's muted-pull control reads
exactly zero on every channel, and the engine critic shadowed the pre-fix
algorithm on a real 21-shot capture.

## The round's lesson

Round 2: *a fix verified against one arm leaves the other arm live.* Round 3: *a
fix aimed at a number can overshoot, and a gate never failed on purpose is not a
gate.* Round 4's is one layer deeper again, and all four critics found it
independently:

> **A number taken through a contaminated fixture does not stay in the report it
> was taken in.** Three of the four domains wrote a measurement into the record
> as fact, and all three are wrong: engine's "~22 loops per capture" and its
> non-linearity table, physics' "terrain-attributed zeroings 181 → 0", and —
> worst, because it is in shipped source rather than a review file —
> Conflagration's card comment asserting a measured "plateaus near 4x" ceiling,
> used as the justification for declining the retune that would have created one.

The corollary has no round to be handed to, so it belongs to whoever ships: a
wrong number in a report is this round's problem; a wrong number in a card
comment, presented as measured, is the next person's — and there is no next
round.

The other half of the lesson is cheaper to state. **Both fixers who nominated
untested arms were right about which arms were risky, and the arms failed
anyway.** Content named ten; the two most consequential (blazing, Conflagration
formations) both fail. Naming the arm is now proven necessary and proven
insufficient — someone has to actually go run it.

## Blocking — ranked

### Single-player

1. **A blazing Bramble Lasher deals 73.95 dps against a 110-HP survivor**
   (content C1, the round's only single-player CRITICAL) — 5.3× the equal-cost
   `glacial` affix on the same card, 11.4× the plain card. Player burn stacks are
   **uncapped** in `Combat.applyStatus`, the aura applies one every 0.5 s inside
   3.2 m, and this round's `preferredRange 18→11` fix is exactly what parks the
   player at a mean 4.35 m. A first-stage, cheapest-in-tier elite on the one card
   the round just redesigned to hold the player still. One line in
   `Combat.applyStatus`, or drop the `statusPlayer` call at `Enemy.js:473`.
2. **A shipping tier-1 flyer ignores `freeze` outright** for the whole of its
   suicide dive (physics F-3), making five defensive items silently useless
   against it. One line, `Enemy.js:782`. Highest value per character on the list.
3. **Conflagration's card asserts a ceiling that does not exist** (content M1):
   "plateaus near 4x printed and does not grow past it" against a measured
   **5.59× / 6.72× / 10.19×** as the pack tightens, and **20.39×** with crit. The
   `1 + 0.35(K-1)` bound applies the falloff *minimum* as if it were the average.
   Needs either a real bound or an honest description; today it is a wrong number
   in shipped source doing load-bearing work.
4. **Waxed Wing sells stacks it cannot deliver** (content M2): peak launch scales
   unbounded to 99.88 m/s at ×10, but delivered displacement saturates at ~26 m
   from ×4 onward. See the adjudication below — this survives the physics fix.

### Co-op — every remaining blocker is here

5. **Joining freezes a client for as long as it played single-player**
   (physics F-6, CRITICAL). Dead projectiles, dead placeables, no scheduled
   volleys; 5.2 s measured from a 5 s menu idle, and it scales with session
   length. Pre-existing, but this branch widened it by putting jump movement
   behind the same `_replaying` flag. One-line mitigation in physics §7.
6. **The jump impulse was gated on the host** (physics F-7) — **the branch's one
   true regression**. `this.local` was applied to both halves of the jump channel
   when only the emit needed it, so Waxed Wing, Updraft Vents and Tectonic Heart
   are inert for every non-host player; divergence went 0.0000 m → 0.500 m
   (6.013 m with real lag). Ungate the impulse, keep the emit gated. No protocol
   change.
7. **A multiplayer client's own death is silent** (audio M1) — also a regression
   this round introduced, confirmed on a real two-page session over a real wire.
   The death screen appears at full soundtrack level with no cue. One line.
8. **A co-op client never receives `playerHurt`/`shieldBroken`** (physics F-10),
   so `timeSinceHurt` is stuck at its sentinel and every `onDamaged` item is dead
   for it. Pre-existing, never looked for until this round. See the adjudication
   below — this is bigger than it reads.
9. **A teammate's damage is credited to your run** (physics F-9): `Progression`'s
   `damageDealt` branch is unguarded, so a teammate's 777 hit becomes your
   `highestHit`. One line.

### The record

10. **Three numbers must be struck before anyone acts on them**: `round4-fix-engine.md`
    §1.2's non-linearity table and its "~22 loops per capture" (the real pre-fix
    algorithm would have run **exactly one** loop across a whole capture, measured
    two independent ways); `round4-fix-physics.md`'s "181 → 0", which is a
    tautology and whose correct figure is **83 → 10**; and the Siege Bombard
    roster ordering (content D3: 9.81/9.82/9.80 dps at three stands, *above* the
    reworked Lasher, not below it). Acting on the engine figure as written means
    discarding a body of capture data that was never affected.
11. **The capture gate still greens three classes of audibly-broken build**
    (audio M2/M3) — better than round 3's gate, which greened total silence, but
    `audioOk: true` today survives eight of ten layers being deleted. Nothing a
    player hears; everything a reviewer relies on.
12. **`Profile.reset()` is not a wipe with a second tab open** (engine Finding 2):
    unlocks survive 4/4, lifetime totals 2/4. Latent — no shipped UI calls it —
    and it becomes live the day someone wires the wipe button the code's own
    comments say is planned.

## Conflicts, adjudicated

**Waxed Wing: physics 1a/1d vs content M2.** Physics measured launch-tick
clipping over a random-stand population (12-stack mid-air annihilation 17.9% →
3.0%; only 75.0% of launches deliver the printed number) and calls the fix real.
Content measured *delivered displacement* from a flat spot at high stacks and
finds saturation at ~26 m from ×4 on, with the ×8 and ×10 launches ending in a
single-step velocity zero (75.03→0, 95.5→0) **on the physics-fixed build**. Both
are right and they measure different quantities. Physics settles the *frequency*
of clipping and genuinely improved it; content settles whether the *printed
promise* is realisable and it is not, past ~4 stacks. The player-facing defect
survives the physics fix. Keep both; act on content M2.

**Co-op audio: audio's flag is upgraded by physics F-10.** The audio critic
flagged — explicitly "not claimed" — that the intensity model may not function at
all on a client, reasoning from `Director.js:272`'s authority gate, `NetViews`
never registering replicated enemies, and `damage`/`playerHurt` being absent from
`NetHost`'s forward list, with one leg standing up: **0** `playerHurt` cues on
the client across a whole session. Physics F-10 independently measured the same
missing forwards from the gameplay side and confirms them. Two critics, two
instruments, opposite directions, same hole. **Treat this as confirmed, not
flagged**: on a co-op client the soundtrack does not react to the fight, and
every `onDamaged` item is dead. That is the subject of rounds 3 and 4 not
functioning in multiplayer.

**The engine blast radius: engine Finding 1 vs round 4's own fix report.** The
engine critic refutes both load-bearing numbers with two independent instruments
each, and the mechanism it refutes (`MAX_SUBSTEPS` saturation and accumulator
bleed) provably never executed — `saturatedFrames: 0`, substep histogram `{"1": N×60}`
at every sample in both arms. Content and physics independently measured
`engineLoops 1.00` on this tree. The correction makes the damage **smaller** and
the rule **simpler**: no shipped code path and no capture ever leaked a loop; the
defect was measurement-only, and `engine.start`/`stop` have two callers, neither
player-reachable. The code fix is still correct and worth keeping.

## Instrument discipline this round

Every critic disqualified evidence of its own rather than shipping it. The engine
critic caught a false positive in its own flawless-stage arm (a reused profile,
since challenges are lifetime-persistent and `reset()` does not clear the
in-flight run), re-ran it, and left the failed run on disk deliberately — the
mechanism behind it became its Finding 5. The audio critic kept two sweeps that
never reached a fight, with their empty outputs, because a claim rests on them,
and marked the refusal-rate number **unknown** rather than confirmed or refuted.
The content critic marked four claims unverifiable and, where it wanted a new
probe for M2, found the existing data already discriminated the hypothesis and
said so. The physics critic refuted one of its own hypotheses outright.

Three of the four fixers earned the same note: content disqualified two of its
own agency attempts, retracted a Scrapfly conclusion in public, and named the arm
most likely to be wrong — which was then the arm that was wrong.

## The ship decision

**Single-player ships after one line.** Content C1 is the only player-reachable
critical, and `Combat.applyStatus` closes it. Fix F-3 in the same pass (one line,
five items restored) and strike the three wrong numbers in §10. Everything else
in single-player is either good, latent, or a record defect.

**Co-op does not ship as it stands.** Five of the nine ranked blockers are
co-op-only, two of them are regressions this branch introduced, and — per the
adjudication above — the reactive soundtrack and every `onDamaged` item are dead
on a client. None of it is expensive (F-7 and F-9 are one line each, audio M1 is
one line, F-6 has a one-line mitigation), but until it is done the honest options
are to fix it or to hide the Co-op menu entry. Shipping it silently means a
player's first multiplayer session has a silent death, three inert items, no
damage feedback, a flat soundtrack, and a several-second freeze on join.

**Two things nobody has done in four rounds, and neither can be done from here.**
No one has *listened* to the audio — every number in four audio reports is
rendered or introspected, and the clap retune, the `sfxLimiter` retune,
`ARC_AUTHORITY` and the 2-node shot fallback are all choices only ears can
settle; twenty lines on `p2-render.mjs` would write a WAV. And nobody has played
a hand-played end-to-end run: every figure in this round is a pinned-clock probe
against a scripted survivor. Those are the two highest-value things left undone,
and they are undone in a way no further critic round would have fixed.
