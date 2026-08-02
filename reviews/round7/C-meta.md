# Round 7 — C: meta progression

Branch `round7/content-and-polish`. Agent C, the meta-progression spine.

## What the layer looked like before

Not thin. `Profile.js` already had a versioned store, a debounced write, the
co-op witness filter, run history and lifetime stats; `challenges.js` had
fifteen conditions and a working evaluator. The gaps were in *depth* and in one
architectural direction:

1. Rewards were an **authored table** in `challenges.js` naming seven artifact
   ids by hand — the exact shape the brief forbids, and a second copy of a fact
   already written on each artifact card. `Artifacts._auditUnlocks` existed
   solely to warn when the two copies drifted.
2. Nothing scaled with content. Every goal was a literal; a challenge set
   written against a 16-monster bestiary said nothing about the 17th.
3. The logbook knew what the *game* contained and nothing about what the
   *player* had done — no kill counts, no career, no run history surface,
   despite the profile persisting all three.
4. The post-run screen could say "earned" and nothing else. It had no
   before-state to diff against, so it could not report a beaten record or a
   challenge that merely got closer — the two things that actually sell the
   next run.

## What was built

### 1. Runtime unlock discovery — `src/systems/UnlockRegistry.js` (new)

The reward direction is inverted. A content card declares its own condition
(`{ id: 'engineer', unlock: 'bossSlayer' }`) and this module discovers it,
writing the resolved binding into `UNLOCK_BINDINGS` via a new
`registerUnlockBinding()` in `challenges.js`. Nothing hardcodes a content id
anywhere in the progression layer any more.

- Scans `SURVIVORS`, `ITEMS`, `EQUIPMENT`, `ARTIFACTS`, `SPAWN_CARDS`,
  `BOSS_CARDS` generically over card shape. A catalogue that grows, shrinks or
  does not exist yet costs nothing.
- Warns (and leaves the content *unlocked*, the safe direction) on an unknown
  challenge id; refuses a second claim on an already-bound challenge rather
  than letting the first one silently win.
- Publishes live catalogue sizes, which is what the survey challenges size
  their goals against.
- Resolves display names, so no surface prints a storage key. The summary's
  unlock chip now reads "Artifact of the Filament", not `glass`.
- Runs at **module evaluation**, not from an `init`. `main.js` registers
  `Artifacts` *before* `Progression`, so an init hook could not be ordered
  ahead of `Artifacts._auditUnlocks`; ES module evaluation finishes before any
  system is constructed, so this always has. `Profile.js` imports it for that
  reason.

The seven hand-written artifact bindings were **removed** from `challenges.js`
and are now discovered. `Artifacts._auditUnlocks` still passes untouched
(verified: zero console warnings at boot), which is the proof the two paths
agree.

### 2. Challenges — 15 authored → 33 authored + 5 generated = 38

Added `category` (7 groups, presentation only) and **dynamic goals**: `goal`
may be `(facts) => number`. That is what makes "record every monster",
"collect every item", "hold every piece of equipment", "defeat every kind of
boss" and "finish a run with every survivor" real rather than a literal that
another agent's content silently invalidates. Resolved goals are persisted per
challenge, so a completed challenge keeps the goal it was completed against.

`track` gained a third argument, `facts` — the derived career view (distinct
counts met, live catalogue sizes, per-survivor record). Additive: every
existing `track` ignores it.

New conditions of note:

- `massacre` — 25 kills inside a **sliding** ten-second window, measured in
  `Profile._onKill` from an array of timestamps. A tumbling window undercounts
  every burst that straddles a boundary, which is most of them.
- `blitz` — stage 5 within ten minutes, the challenge that teaches that the
  difficulty coefficient is a clock.
- `ironclad`, `overkill`, `packMule`, `deepLoop`, `mintCondition`, `clockedIn`,
  `finisher`, `firstBoss`, `centurion`.

**Per-survivor mastery is generated, not authored.** One challenge per roster
entry, built in the registry from `SURVIVORS`, id-namespaced `mastery.<id>`.
Writing four by hand would mean the fifth survivor ships without one and
nothing notices. Deliberately unbound to a reward: RoR2 pays mastery in skins,
there is no skin catalogue, and a mastery challenge that unlocks the survivor
it is about is a circular gate.

### 3. Profile schema v1 → v2, with a real migration

`PROFILE_VERSION = 2`. Storage key deliberately **unchanged** (`petrichor.profile.v1`)
— one key, one JSON blob, per `docs/STEAM.md`; the key names the storage
contract, not the shape inside it.

New shape:

- `encounters: kind -> id -> { at, count }`, replacing v1's `discovered: kind -> id -> ts`.
  Counts are what turn a catalogue into *your* record ("412 killed").
- `survivors: id -> { runs, wins, deaths, kills, time, bestStage, bestTime }` —
  the per-survivor career the generated mastery challenges read.
- `stats.bestLevel / bestGold / bestItems`.
- `challenges[id].goal` — the resolved dynamic goal.

Migration `1 -> 2` carries every first-seen stamp verbatim (count starts at
zero and is honest about it — inventing a count from a timestamp is fabricating
play history) and **reconstructs the per-survivor career from the stored run
history**, so a returning player does not see every mastery challenge at zero
next to twenty-five recorded runs. `_coerce` also tolerates the v1 bare-timestamp
encounter shape, so a blob that reaches it without the migration still loads.

Also added: `exportProfile()` / `importProfile()` — the single-blob seam
`docs/STEAM.md` asks for, with the import going through the same migrate +
coerce path and changing nothing if the blob is unusable.

Equipment was the one catalogue nothing could ever mark as met (a slot has no
`itemPickup`); `equipmentChanged` is now listened to, with the same replication
story `itemPickup` has and therefore the same absence of a witness filter.

### 4. The run report — `Profile._buildReport`

`commitRun` now returns and stores a report, computed by diffing against
snapshots taken at `beginRun` (the only point where the before-state still
exists): unlocks earned, challenges completed, challenges **advanced**
(nearest-to-done first), personal bests beaten *with the number they replaced*,
new catalogue entries met, and the career line.

### 5. The post-run readout — `renderRunReport` in `Logbook.js`

Rendered into the summary screen's existing `[data-run-unlocks]` container.
Four sections in the order a player cares: what you earned (chips), what you
beat (record rows with "was N"), what is close (progress bars, nearest first),
what you met. Returns `''` when a run genuinely changed nothing, so the
container's existing `:empty` rule collapses it.

**One defect found and fixed by looking at the capture rather than the code.**
The first version reported all six beaten bests and four advanced challenges,
which is exactly what a *first* run produces — and the resulting readout pushed
the summary panel's own Logbook/Restart buttons off the bottom of a 1600x900
frame. The caps (4 records, 3 advanced) now live in `_buildReport`, not in the
renderer, because they are a statement about attention rather than about
layout: three near-misses is a shortlist a player reads, eight is a table they
skip. Row padding and section margins were tightened alongside. Re-captured and
verified.

### 6. Logbook depth

- New **Records** tab: a Career panel (12 lifetime totals + 7 personal bests,
  two grids because "what have I done" and "what can I beat" are different
  questions) and the run history, one entry per stored run with its own stat
  block and item haul. Runs are numbered backwards from the lifetime total, so
  run #37 stays run #37 after it falls off the 25-run window.
- Challenges are **grouped by category** with section headers. Headers are
  emitted between rows rather than being entries, because `setTab` selects
  `entries[0]` and the keyboard navigator walks `[data-nav]`.
- Every catalogue entry now carries the player's own record: "412 killed ·
  first recorded 2 Aug 2026" on monsters and bosses, "collected" on items,
  "times held" on equipment.
- Survivor entries carry their career row — the same table the mastery
  challenge reads, so the two numbers cannot disagree.

## Constraint compliance

- **Persistence** — one versioned schema, one key, one blob, migration chain
  intact and exercised against a real v1 payload (below).
- **Netcode** — nothing new gates on `ctx.authority`; the profile stays
  per-client and local, and the `_isLocalSource` witness filter is untouched.
  The new `equipmentChanged` listener follows the `itemPickup` precedent
  exactly (this client's own slot, replicated as its own fact, no witness
  filter) and is documented as such at the call site.
- **`ctx.rng`** — this layer draws no randomness at all. Nothing added touches
  the shared sequence, so harness reference captures are unmoved.
- **No runtime lights** — no scene object of any kind is created. The only
  visual additions are DOM and CSS.

## Files touched

| file | change |
|---|---|
| `src/systems/UnlockRegistry.js` | **new** — discovery, generated mastery, catalogue sizes, name resolution |
| `src/systems/Profile.js` | v2 schema, migration, encounters, per-survivor career, facts, dynamic goals, kill-burst window, run report, export/import |
| `src/data/challenges.js` | categories, dynamic goals, 18 new conditions, `registerChallenges` / `registerUnlockBinding`, hand-written reward table removed |
| `src/ui/Logbook.js` | Records tab, grouped challenges, encounter lines, survivor career, `renderRunReport` |
| `src/ui/Menus.js` | **surgical, 1 import + 1 block** — the `[data-run-unlocks]` block now calls `renderRunReport(profile.report())`. Both old sources (`newChallenges`, `drainPendingUnlocks`) are still drained so nothing accumulates across runs |
| `src/ui/hud.css` | **append-only block at EOF**, clearly banner-commented. Reuses existing tokens and `.book-prog`; introduces no new visual language |

`src/systems/Progression.js` needed no change — it already owns the profile's
lifecycle correctly.

## Verification

### `npm run build`

Passes. `✓ built in 1.36s`, no errors (only the pre-existing >500 kB chunk
advisory).

### `node tools/capture.mjs --only 01-title,15-logbook,16-run-summary`

```
"ready": true,
"shots": ["01-title", "15-logbook", "16-run-summary"],
"errorCount": 0,
"subjectsOk": true,
"subjectFailures": [],
"toleratedAbsences": [],
"perf": { "programs": 72, "geometries": 400, "textures": 52, "sceneObjects": 809 }
```

`15-logbook` shows the seventh tab (Records) sitting in the existing tab rail
without reflowing it. `16-run-summary` shows the full readout: the earned chips
(two challenges, two artifacts, named not id'd), the personal-best rows, the
"closing in" bars and the career line.

### Behavioural test (`tools/_meta.tmp.mjs`, deleted after the run)

A Playwright script booting `?harness=1`, asserting against real behaviour.
**34 / 34 passed, 0 console errors**, on two separate runs (before and after
the summary-layout fix). The script was deleted after the final run, as
required.

Highlights, with the real numbers it printed:

| assertion | result |
|---|---|
| migration: version bumped to 2 | `2` |
| migration: v1 `discovered` dropped from the shape | pass |
| migration: first-seen stamps carried verbatim | `{at: 1700000000300, count: 0}` |
| migration: every discovered id survived | 2 items, 1 boss, 2 enemies |
| migration: per-survivor career rebuilt from run history | `ranger {runs:1, bestStage:6}`, `anvil {wins:1}` |
| migration: unlocks / challenges / runs / stats intact | glass unlock stamp, `firstBlood.done`, `bossSlayer.progress 4`, 2 runs, 420 lifetime kills, bestStage 6 — all preserved |
| migration: new v2 stat fields default rather than leak `undefined` | `bestLevel === 0` |
| registry: rewards discovered off content cards | 7 bound, `oneShot -> artifact:glass` |
| registry: catalogue sizes are live | `{survivor:5, item:108, equipment:14, enemy:16, boss:6}` |
| registry: one generated mastery per survivor | 5 generated / 5 roster |
| registry: names resolve | `glass -> "Artifact of the Filament"` |
| challenge set size | **38** |
| challenge condition fires and records | `firstBlood` false → true on one `kill` event |
| encounters: kill counted against the monster id | `{count: 1, at: <now>}` |
| survey goal tracks the live bestiary | goal 16 == catalogue 16 |
| unlock: gated before, granted after | locked → unlocked on a 1,200 hit |
| unlock persists across a reload | pass |
| challenge completion persists across a reload | pass |
| encounter counts persist across a reload | `{count: 1}` |
| summary: report built for the committed run | `{runNumber:1, records:4, advanced:3, completed:1, unlocks:1, discoveries:[{item:22}]}` |
| summary: personal-best rows rendered | 4 |
| summary: "closing in" progress rows rendered | 3 |
| summary: career line rendered | `"22 new items — Run 1 · 1 lifetime kill · 17m in the field"` |
| logbook: records tab lists past runs | pass |
| logbook: career panel renders its grids | 19 stat cells |
| logbook: a past run renders its own stat block | 8 cells |
| logbook: challenges grouped into sections | 7 groups over 38 rows |
| logbook: bestiary carries the player's own record | `"1 killed · first recorded 2 Aug 2026"` |
| no console errors | `[]` |

**The generic path proved itself between two runs of the same test.** The suite
was run twice, an hour apart. On the first run the registry reported
`{survivor:5, item:108, equipment:14, enemy:16, boss:6}` and the `fieldGuide`
survey challenge resolved its goal to **16**. On the second run — after another
agent had committed three more monsters — it reported `enemy: 19` and the same
challenge resolved to **19**, with no edit to any file I own. That is the
requirement ("work generically over whatever content exists at runtime")
demonstrated against live, concurrently-changing content rather than asserted.

The migration test is the one worth restating: the input was a hand-written
v1-shaped `localStorage` payload with two runs, five discovered ids, one
unlock, one completed and one part-complete challenge, and a full lifetime
stat block. Every one of those survived, `discovered` became `encounters`
without losing a stamp, and the per-survivor table that did not exist in v1 was
rebuilt from the run history.

## Environment note — `node_modules/.bin` was wiped mid-session

Not caused by anything in this work, but worth flagging to everyone on the
branch. Partway through, `npm run build` began failing with
`'vite' is not recognized`: the entire `node_modules/.bin/` directory had
disappeared while `node_modules/vite/` itself was intact. `npm` on this machine
resolves to **6.13.6** against a modern lockfile, so `npm install` / `npm rebuild`
would be more likely to do further damage than to fix it (and there is a known
prior incident on this repo of a bare `npx` deleting a package's manifest).

Fixed without reinstalling: the five shims were regenerated directly from each
installed package's own `bin` field (`nanoid`, `playwright`, `playwright-core`,
`rolldown`, `vite`). `npm run build` and `node tools/capture.mjs` were both
re-run afterwards and both pass — the `01-title` re-capture returned
`errorCount: 0, subjectsOk: true`.

**If another agent sees `'vite' is not recognized', that is this, not their
change.** Do not run `npm install` to fix it.

## Deferred / notes for whoever picks this up

- `Menus.newChallenges` is now vestigial — the report supersedes it. It is still
  pushed and drained so nothing leaks across runs, but it could be deleted once
  `Menus.js` is not being edited by three agents at once.
- `UNLOCK_TYPES` includes `skin` and nothing produces one. The generated mastery
  challenges are the natural place to bind skins the day a catalogue exists; the
  registry needs one more `CATALOGUES` entry and nothing else.
- Only artifacts declare `unlock` today, so only artifacts are gated. A survivor
  or an item becomes gated the moment its card grows the field — no edit here.
- Run history is capped at `MAX_RUNS = 25`. Lifetime totals and personal bests
  are kept separately for exactly that reason, and the run numbering is derived
  from the lifetime count rather than the window.
