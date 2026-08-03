# Round 7 — critique round 2, consolidated

Four independent critics, dispatched in parallel against HEAD `75f87d6`, each
capturing its own evidence. No shared verification run — the redundancy is the
control, and it paid: two critics independently reproduced the same
absorbed-hit defect from different directions.

| Critic | Domain | Verdict | Report |
|---|---|---|---|
| A2 | `Music.js` / `Audio.js` | FAIL — 1 crit, 6 maj, 2 mod, 4 min | `round2-audio.md` |
| B2 | items / CINDER / new enemies | FAIL — 3 blocking, 8 maj, 6 min | `round2-content.md` |
| C2 | UnlockRegistry / Profile / UI | FAIL — 2 crit, 2 maj, 3 min | `round2-meta.md` |
| D2 | cross-cutting bugs / integration | FAIL — 1 crit, 2 maj, 2 min | `round2-bugs.md` |

Build passes. Full 21-shot capture: 21/21, zero console and page errors, one
failing check (`06-loaded-hud`), byte-identical to what `E-framing.md` §5
records and declines to fix — this round did not make it worse.

## The round's lesson

**Round 1's fixes were real but partial, and one of them regressed.** Round 6's
lesson was "an aggregate hiding an absence, assume it recurs". Round 7's is
narrower and sharper:

> A fix verified against the one case that was reported closes that case and
> nothing else. Each of round 1's three landed fixes was tested against exactly
> the arm it was found in — enemy shields but not player shields, mouse but not
> gamepad, the bus listener but not the scene root — and each left the other
> arm live.

The corollary for round 3: when a fix lands, the verification must name the
arms it did *not* test, and one of them must be tried.

## Blocking — ship-stoppers, ranked

1. **Enemy-shield damage now reports as zero** (`Combat.js:440-458`, D2 #1).
   Round 1's own fix `4a1a098` moved `dealt` after the shield block. The
   `warded` affix is dead, three items are blanked, every damage counter lies.
   `overloading` is tier-1 `unlock: 0`, so this is live from stage 1. **This is
   a regression this round introduced.**
2. **`slow` is inert on the player** (B2 #1). `Combat.speedMultiplier` has zero
   callers in `src/`. Sprint speed is identical to 3 s.f. at 0, 1 and 5 stacks
   and under a held freeze. The Gloomshriver's whole identity does nothing.
3. **No `pull` can move a grounded player** (B2 #2). Max pull accel 30 m/s²
   against the controller's 68/86 m/s² correction; net closure 0.000–0.081 m
   over six measurements and five 40 s fights.
4. **Bramble Lasher deals 0 damage to a stationary player for 45 s** at its own
   preferred range (B2 #3) — `volley: 4` is even, so no round is on the aim line.
5. **`Profile.run.time` is never populated** (C2 #1). `marathon` is permanently
   unachievable; `blitz` auto-completes at zero elapsed time.
6. **`playerHurt` fires at zero on fully-absorbed hits** and three of its four
   listeners don't check the amount (D2 #2, corroborated independently as
   B2 #10 at `timeSinceHurt` 7.42 → 0.00). This is the half of round 1's #2
   that the landed fix did not close.

## Corroborated across critics

- Absorbed-hit handling: D2 #2 and B2 #10, reached from opposite directions.
- Round 1's #3 (Scrapfly Hive redundancy) **upheld and sharpened** — the
  claimed differentiator does not exist in code; it is `seekingStrike` from
  `player.position`, the identical call Hive Gland makes, at a lower rate.
- Round 1's #2 (lasher pull vs the horde) **refuted, and worse than feared** —
  not "needs stress-testing" but "both halves of the CC chain are inert".

## Process findings worth acting on regardless

- **`tools/capture.mjs` never issues a user gesture**, so no line of the audio
  system executes under it. That is the hole round 1's every-frame
  `ReferenceError` walked through to reach a human. A `page.mouse.click()` plus
  a `stepsEmitted > 0` assertion in the capture boot closes it. (A2)
- **There is no test runner in this repo** — no `test` script in
  `package.json`, no runnable suite. The capture suite is the entire automated
  gate, and it is a pixel gate. Every behavioural defect in this round was
  found by hand-written throwaway probes that were then deleted. (D2)
- Two B2 hypotheses and two D2 hypotheses were **refuted by probing** and are
  recorded in the reports so nobody re-runs them. B2's probe F is explicitly
  retracted — it looked like a Stoke defect and was the probe's own camera
  parallax, disproven by probe G at 20/20.

## Raw evidence

`reviews/round7/r2-audio/`, `r2-content/probe[A-G].json`, `r2-meta/`,
`r2-bugs/capture/`. No product code was modified by any critic; all throwaway
scripts deleted.
