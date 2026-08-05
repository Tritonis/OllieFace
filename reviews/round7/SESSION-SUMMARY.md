# Session summary — co-op review and fix sequence

**Branch:** `round7/content-and-polish` · **Base:** HEAD `a43cc70` · **Session:** 2026-08-03 → 08-04

**Read this first if you are picking the work up cold.** It is written to stand alone;
you should not need the thirteen reports underneath it to act.

---

## 1. State of the tree

**Nothing is committed.** All work sits uncommitted on top of `a43cc70`:

- **18 modified files**, diffstat ~**1050 insertions / 64 deletions**
- Five co-op fix rounds, each independently re-derived by a critic that did not write it
- `node node_modules/vite/bin/vite.js build` → **exit 0**
- Single-player is **identical to HEAD** where HEAD was right, and **better** in two rows
  where HEAD counted your own death as a kill

Files touched: `src/core/Engine.js`, `src/net/{NetHost,NetClient,Protocol,Snapshot,Lobby}.js`,
`src/systems/{Combat,Audio,Items,Progression,Profile,Director,VFX}.js`,
`src/entities/{Player}.js`, `src/ui/{HUD,Menus}.js`, `src/data/items.js`,
`src/world/realms/Realms.js`.

---

## 2. The decision

> **Hide the Co-op menu entry. Ship the rest of the branch.**

Held unanimously by every critic from round 3 onward, and most firmly by the last one.

**The single-player half is shippable on its own.** `src/net/` executes only when
`ctx.lobby.mode !== 'single'`, so every co-op defect below is reachable *only* through
that menu entry — hiding it closes all of them for shipping purposes.

### ⚠ The hold has never actually been applied

Every round recommended hiding the button. **Nobody hid it.** It is still live at
`src/ui/Menus.js:187` (title screen) and `src/ui/Menus.js:292` (pause menu).
**This is a two-line change and it is the highest-value edit outstanding.** If the branch
ships as-is, players will find that button.

---

## 3. Why co-op is held — the one reason that matters

**N-1: no enemy has ever targeted a co-op pawn.** Pre-existing; untouched by all seven
rounds; found by source inspection in round 3 and proven by measurement in round 4.

`Enemy.js:36`, `:449`, `:499` route all targeting and all damage to `ctx.player`, which
on a host is the host's own survivor. Measured on a real two-page session: **78 directed
enemy hits on the host, 0 on a pawn standing 3 m away** over 30 s, with an enemy 6.3 m
from the pawn still holding the host's position as its target.

The guest is *not* fully invulnerable — pawns are on team `player`, so area effects reach
them (an Overloading elite's death blast took 87 points). That accident is why seven
rounds missed it, and it is also load-bearing evidence: because that damage travelled the
whole real path (`Enemy` → `combat.explode` → `_forwardHurt` → client `playerHurt` →
`Items`/`Progression`), **K-1, K-5, F-10, L-3 and M1 all survive N-1**. N-1 invalidates
*frequency* claims, not *mechanism* claims.

**A co-op session today is one player fighting the whole run alone and one player being
ignored by every enemy in it.** That is not a bug in co-op; it is why co-op is not
finished. Fixing it is a feature round: per-enemy targeting, a nearest-player query,
routing `hurtPlayer`/`statusPlayer` through it, aggro stickiness that does not oscillate
between two players standing together — in the AI hot path, and it moves encounter
balance, because spawn budget already scales with `playerCount`.

---

## 4. Remaining work, in priority order

| # | Item | Cost |
|---|---|---|
| 1 | **Hide the Co-op menu entry** (`Menus.js:187`, `:292`). Everything below stops being urgent the moment this lands. | **2 lines** |
| 2 | **C-2 — `Lobby.leave()` does not reset `ctx.netRole`.** Press *Leave co-op* and your survivor **never moves again**: 2.103 units before joining, 1.908 while joined, **0.000** after leaving. No error; only a page reload recovers. Hosts unaffected. The only defect here that permanently disables a character. | **2 lines** |
| 3 | **C-1 — the fifth HELLO door.** A peer that connects and **never sends a HELLO at all** is simulated as the host's survivor for the whole session: host `ranger` **70.17/110** vs joiner `anvil` **108.44/170**, `helloSeen: false`, both lobbies reading "connected", **0 console errors, 0 page errors, 0 `[net]` warnings**. Fix in `NetHost.fixedUpdate` reusing `joinTick` / `HELLO_MAX_PAWN_AGE` / `_refuse`. **Do C-7 first** or it inherits a 15 s timeout. | **~4 lines** + C-7 |
| 4 | **N-1 — enemies must target pawns.** The difference between "co-op exists" and "co-op is worth shipping". | **Days**; own round + own verification pass |
| 5 | **C-4 — input un-mute behind a menu.** For up to 1.5 s after the last peer dies, pause-menu keystrokes also drive your survivor. | **1 line** |
| 6 | **C-3 — a client that dies without dying.** A client whose pawn dies while the host has a menu open can be left alive at full health with no death screen, in a world frozen until the host closes the menu. Intermittent; incidence rises as host frame rate falls. Count the hold grace in **snapshots sent**, not wall clock. | Touches `_holdSession`, which carries L-1 + N-8 + the grace together — **the riskiest method in `src/net/`**. Do after 4, with arms at a throttled frame rate. |
| 7 | **C-10** — order `acceptAnswer`'s status set before `netPlayerJoined`, so a host's panel stops reading "Reply accepted — connecting…" forever after a successful join. | **1 line** |
| 8 | **C-5, C-6** — `Engine.remove` (two `NetHost`s and a dangling `ctx.net` leak after leave-and-rehost) and the invite/lobby cap. Housekeeping, but where the next lifecycle change will go wrong. | Half a day |
| 9 | **Drive what nobody has driven**: four peers, a mid-session stage transition, one session under real network latency, and *listening* to the game. | Unknown — that is the point |

---

## 5. What the five rounds actually bought

Co-op went from incoherent to **coherent**. Each item was verified at both ends of its
range with a gate failed on purpose, by someone who did not write the fix:

- You play **the survivor you picked** (previously you silently played the host's).
- **One death ends exactly one run** — yours — in every direction, with three players.
- Your **health and death** are the authority's (previously a client's own health never
  updated and could *rise* while the host took it down).
- Your **kill counter**, **barrier**, and **run summary** are yours, not a teammate's.
- A **teammate's death** no longer silences your music or ends your run.
- A **host's death** no longer freezes the world for everyone still in it.
- A **refused join** is explained in plain English on **both** machines.
- **Three peers behave exactly as two.**
- `EventBus.emit` **isolates listeners**: previously one throwing subscriber silenced
  every listener registered after it (4 of 4 kills reached 0 of 4 downstream listeners,
  and the exception unwound into `Combat.applyDamage` and aborted the kill).
- `PROTOCOL_VERSION` → **4** (three builds had called themselves "3" with three different
  accept-behaviours).

---

## 6. Process lessons — these are what made the rounds productive

Each was learned the expensive way. Apply them to the next round.

1. **State the failure at both ends of every range.** A fix aimed at a number can
   overshoot into the opposite failure (round 3 retuned intensity out of a flatline and
   into pinning at 1.0).
2. **A gate never failed on purpose is not a gate.** Three gates in this sequence
   *failed to fail* — `prior-eb` (headless has no live audio graph), P-2's 60 KB arm
   (delivers either way), and round 5's own P-8 arm — every one caught and disclosed by
   its author. Fail gates **one fix at a time**; a blanket revert hides which fix a gate
   is sensitive to.
3. **A number taken through a contaminated fixture escapes into the record.** Round 4 put
   three wrong numbers in reports and one in a shipped card comment. Correct wrong numbers
   *in place* with the raw-file key that settles each.
4. **Re-verify every prior fix you could plausibly disturb, and name what you skipped.**
   Every round that skipped a re-verification had something waiting in it.
5. **Verify against HEAD's literal condition**, not an approximation and not the current
   tree. The single-player kill-counter regression survived a round precisely because
   "single-player didn't move" was asserted, not measured against HEAD.
6. **Gate every co-op arm on the game actually running** — `paused false` and
   `_localTick > 60` on **both** pages before installing any instrument. Multiple
   instruments produced clean-looking numbers while both pages sat on survivor-select.
7. **A reviewer's prescription can be wrong.** Round 4 refuted two and round 5 refuted two
   more, each with measurement, and all four refusals were upheld. Verify prescriptions;
   ship what is right and say why.
8. **Point a rig at what nobody has pointed one at.** Four of seven findings in the final
   report came from exactly that.
9. **Check that a recommendation was acted on.** Thirteen reports said "hide the Co-op
   entry"; none checked. It is still there.

---

## 7. Where everything lives

| Path | What |
|---|---|
| `reviews/round7/round4-SUMMARY.md` | Whole-branch verdict from the four-critic review that scoped all co-op work |
| `reviews/round7/round4-critique-{engine,physics,audio,content}.md` | The four final branch critiques |
| `reviews/round7/coop/round{1..5}-fix-coop.md` | The five co-op fix rounds |
| `reviews/round7/coop/round{1..5}-critique-coop.md` | The five independent critiques |
| `reviews/round7/coop/r{1..5}/`, `r{1..5}-critique/` | Raw JSON for every arm quoted anywhere |

Finding IDs by round: **K-** = round-1 critique · **L-** = round-2 · **N-** = round-3 ·
**P-** = round-4 · **C-** = round-5 (final). Drivers were deleted after each round; their
output was not. Substitution tables are in each critique's appendix.

---

## 8. Two things nobody has done in seven rounds

- **Nobody has listened to the audio.** Every number in four audio reports is rendered or
  introspected. The clap retune, the `sfxLimiter` retune, `ARC_AUTHORITY` and the 2-node
  shot fallback are choices only ears can settle. `reviews/round7/r5-audio/p2-render.mjs`
  renders the real engine sample-exactly into an `OfflineAudioContext`; ~20 lines would
  write a WAV.
- **Nobody has played a full run by hand.** Every figure in this sequence is a
  pinned-clock probe against a scripted survivor. That is the last gate and no document
  substitutes for it.
