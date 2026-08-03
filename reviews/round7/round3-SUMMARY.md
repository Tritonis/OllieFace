# Round 7 — critique round 3, consolidated

Four independent critics against HEAD `b18a2b4` (round-3 fixes: `ac85d85` +
`b18a2b4`). Each re-measured round 3's claims rather than accepting them.

| Critic | Verdict | Confirmed | Refuted | Report |
|---|---|---|---|---|
| audio | FAIL — 2 crit, 5 maj, 4 mod, 4 min | 9 | 6 | `round3-critique-audio.md` |
| content | FAIL — 2 crit, 8 maj, 5 min | 15 | 4 | `round3-critique-content.md` |
| meta | NOT READY — 0 crit, 2 maj | 7 | 0 | `round3-critique-meta.md` |
| bugs | FAIL — 0 crit, 4 maj, 4 min | 10 | 1 | `round3-critique-bugs.md` |

Build exit 0. Capture 21/21, 0 console/page errors. `06-loaded-hud` still the
one failing check, unchanged in kind from `E-framing.md` §5.

## What round 3 actually achieved

Round 2's blocking list is genuinely closed and independently re-measured: the
enemy-shield regression, `slow` on the player, `pull` moving a grounded player,
`run.time`, the save flush, gamepad scroll, Conflagration's order-dependence,
Aegis, Redoubt, Whetstone, the co-op leak, the survivor-swap leak. **The
external-velocity physics change holds** — the bugs critic could not push the
player through geometry, out of bounds, under the floor, or off the map.

The meta domain is the first to come back with no blocking finding, with all
seven of its round-3 claims confirmed — including the gamepad fix, which round 3
had only verified against a stubbed `readPad` and the critic re-proved through a
faithful `navigator.getGamepads()` mock.

## The round's lesson

Round 2's lesson was *a fix verified against one arm leaves the other arm live*.
Round 3 obeyed it — every fixer named its untested arms — and the critics went
straight to those arms and found the defects there. That worked. The new lesson
is one layer down:

> **A fix aimed at a number can overshoot into the opposite failure, and a gate
> that has never been failed on purpose is not a gate.** Round 2 said intensity
> never rises; round 3 retuned `arc` and it now pins to 1.0 in an empty arena.
> Round 3 added an audio gate and proved it catches a *throwing* scheduler; it
> reports `audioOk: true` on a build with every oscillator no-op'd.

Corollary for round 4: every fix states the failure at *both* ends of its range,
and every gate is proven by making the thing it guards actually fail.

## Blocking — ranked

1. **`Engine.start` re-arms its tick before `_frame`** (content MAJOR-1), so
   every `freeze()`/`thaw()` adds a concurrent engine loop — 1/2/3/4 after
   0/1/2/3 cycles, 5 after `gameplay()`. `capture.mjs` freezes/thaws 21 times,
   and round 3's own probes ran at 2×. **This is infrastructure: it corrupts
   measurement and inflates cost, and it must be fixed and re-verified first,
   because an unknown number of this round's numbers were taken through it.**
2. **The capture gate measures nothing** (audio C2). `audioOk: true` with every
   `Oscillator`/`BufferSource.start` no-op'd; `stepsEmittedDuringGateWindow: 0`
   on the real 21-shot run, because `16-run-summary`'s death already stopped the
   engine. The project's only automated gate is decorative.
3. **Music intensity pins to 1.0 in an empty arena** (audio C1) from difficulty
   3.5 — round 3's `/5`→`/2.5` retune overshot round 2's flatline into the
   opposite failure. `cool()` is a no-op.
4. **Waxed Wing's impulse is annihilated** by `Stage.capsuleResolve`'s
   single-destination `_climbable` test (content CRITICAL-1): 20.15/30.15/40.15
   at 1–3 stacks, then 5.55/8.33/10.15/10.15 at 4/5/8/10 — velocity hits exactly
   0 mid-flight, sooner the bigger the launch, on flat ground. Note the bugs
   critic confirmed the impulse channel "linear" at 1–3 stacks; both are right,
   and the disagreement is the range each tested.
5. **The Bramble Lasher still does not work** — third round running. 1.37 dps at
   every standoff 8–22 m, against the 9-credit Spitling's 5.44. `pull: 26` was
   tuned from 10 m but the card stands at 18 m, where it steals 2.4 m and can
   never reach its own 6 m blast: **6 reels fired, 0 damage, in every arm.**
6. **Co-op is broken in three distinct ways** (bugs 2/3/4), and one is new in
   `b18a2b4`: a peer's jump spends the *host's* item hooks (host barrier 0→30,
   host's quake at the host's feet, peer launched by the host's Waxed Wing).
   Plus a teammate's damage resetting the local `timeSinceHurt`, and a
   teammate's reflect landing on the local survivor.
7. **Barrier-absorbed damage counts as damage taken** (bugs 1), making
   `Untouchable` and `Ironclad` unachievable for any player holding a barrier
   item. Round 3's combat fixer escalated this; `b18a2b4` did not land it.

## Instrument discipline this round — worth keeping

Three critics disqualified their own evidence rather than shipping it: the bugs
critic declared the frozen-enemy claim **unverifiable** after its instrument
failed a sanity check (a slowed enemy travelled *further* than a clean one), and
refuted two of its own hypotheses; the audio critic marked an offline
limiter-bypass comparison inconclusive over an unattributable +1.3 dB. The
content critic also closed round 3's open lead: the 18 m reel is **line of
sight**, not a `pickAttack` gap — the integration fixer's four runs all sat at a
stand where terrain occludes past ~13 m.

## One conflict, adjudicated

The bugs critic lists "audio gate works"; the audio critic proved it passes on
total silence. The audio critic's test is strictly stronger — it checked whether
the gate can *fail*. **The gate is not trustworthy.**
