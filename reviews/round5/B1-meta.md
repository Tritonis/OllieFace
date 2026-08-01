# B1 — Meta-progression layer

Status: **complete and verified.** 66/66 unit assertions pass, build clean, capture
clean (`ready: true`, `frameErrors: 0`, `newErrors: []` on all 8 shots), perf unchanged.

## Files touched

| file | change |
|---|---|
| `src/systems/Profile.js` | **new** — persistent profile, the only localStorage owner for meta state |
| `src/data/challenges.js` | **new** — challenge definitions + the `UNLOCK_BINDINGS` extension point |
| `src/systems/Progression.js` | 4 small edits: import, construct `Profile`, `profile.init(ctx)`, `profile.commitRun()` in `_endRun` |
| `reviews/round5/B1-profile.test.mjs` | **new** — the verification harness below (`node reviews/round5/B1-profile.test.mjs`) |

**Nothing else was touched.** In particular `main.js` and `core/Engine.js` were *not*
modified — see "Why no registration line" below. No other agent's file was opened for
writing.

---

## The `ctx.profile` API — for B3

`ctx.profile` is set during `Progression.init`, which runs before `HUD`/`Menus` are
constructed in `main.js`, so it is always available to UI code.

### Read

```js
ctx.profile.isUnlocked(type, id) -> boolean
ctx.profile.unlockedIds(type)    -> string[]        // oldest unlock first
ctx.profile.challengeState(id)   -> { id, name, description, hidden, masked,
                                      progress, goal, fraction, done, doneAt,
                                      unlocks } | null
ctx.profile.challengeStates()    -> the above for every challenge, in definition order
ctx.profile.isDiscovered(kind, id) -> boolean       // logbook greying
ctx.profile.runHistory()         -> run records, newest first (defensive copy)
ctx.profile.lifetime()           -> aggregate stats (defensive copy)
ctx.profile.currentRun()         -> live run counters, or null between runs
ctx.profile.data                 -> the raw profile; read-only by convention
```

`type` is one of `UNLOCK_TYPES` from `data/challenges.js`:
`'survivor' | 'item' | 'equipment' | 'artifact' | 'skin'`.
`kind` for discovery is `'item' | 'equipment' | 'enemy' | 'boss' | 'survivor'`.

**`isUnlocked` defaults to `true`.** Only an id that some challenge names as its reward
is gated, and only until that challenge is done. This is the most important line for B3:
a survivor-select screen can call `isUnlocked('survivor', id)` today and get `true` for
everything, and it will start returning `false` the moment the bindings land — no UI
change required either side of that.

**Hidden challenges are masked for you.** `challengeState` returns `name: '???'`,
`description: 'Hidden challenge.'` and `masked: true` for a hidden, incomplete
challenge. Render what you are given; do not read `CHALLENGE_BY_ID` directly or you
will leak the ones that are supposed to be a surprise.

`fraction` is `progress / goal`, pre-clamped, so a progress bar is a one-liner.

### Write / notify

```js
ctx.profile.unlock(type, id, { challenge, silent })  -> true only the first time
ctx.profile.discover(kind, id)                       -> true only the first time
ctx.profile.drainPendingUnlocks()                    -> [{ type, id, challenge }] , then empty
ctx.profile.reset()                                  -> wipe (settings screen; no undo)
ctx.profile.flush()                                  -> force a write now
```

`drainPendingUnlocks()` is the toast's queue. It is session state, not profile state, so
it does not survive a reload and the same unlock is never announced twice. Two ways to
drive the toast, use whichever fits:

- push: subscribe to the events below;
- pull: drain on the death screen / main menu.

### New events (additive — no existing payload was changed)

| name | payload | when |
|---|---|---|
| `unlockEarned` | `{ type, id, challenge }` | first time an id is unlocked |
| `challengeComplete` | `{ id, name }` | a challenge reaches its goal |
| `challengeProgress` | `{ id, progress, goal }` | progress advanced, not yet complete |

These are emitted by `Profile` only. No other system's event payload was touched, and
no new event is *required* of any other system — everything the profile counts comes
from the events already in `CONTRACTS.md`.

### Run record shape (for the logbook run list)

```js
{ at, survivorId, difficultyId, difficulty, stage, stageName, time,
  kills, elites, bosses, damageDealt, damageTaken, highestHit,
  items, gold, level, outcome: 'death'|'victory'|'quit',
  inventory: [{ id, count }] }
```

`survivorId` and `difficultyId` are **`null` today**. They are read from
`ctx.player.survivorId` / `ctx.survivorId` and `ctx.difficultyId` respectively, and
neither exists yet (A1 owns the first, B2/B3 the second). They start populating with no
change here the moment those fields appear. B3 should render a `null` as "—" rather
than assume a string. Last 25 runs are kept.

`outcome: 'victory'` is defined but currently unreachable — `Progression._endRun` is
only ever called with `won = false`, from `playerDead`. There is no victory condition in
the game yet. Left in place rather than removed because it costs nothing and the
alternative is a schema change later.

---

## Challenge definition shape

`src/data/challenges.js`:

```js
{
  id,          // stable string; persisted as a key, so never rename one in place
  name,        // logbook title
  description, // the condition in the player's words
  hidden,      // true = name/description masked until complete
  goal,        // the number `track` has to reach
  track(profileStats, runStats) -> number,
  unlocks,     // { type, id } | null — written by applyUnlockBindings()
}
```

- `track` is a **pure read** of two plain objects. No `ctx`, no DOM, no randomness.
  `profileStats` is `profile.data.stats` (lifetime sums + personal bests); `runStats` is
  the live run counter block, and may be `null`-ish between runs, so guard with `?.`.
- A one-shot is `goal: 1` and a `track` returning `0` or `1`.
- **Progress is a high-water mark**, never an assignment. That is what lets a run-scoped
  condition ("30 items in one run") survive the end of the run instead of being reset to
  0 when the run counters go away. A completed challenge is never re-evaluated.
- A `track` that throws costs that challenge, not the profile — same posture `Engine`
  takes with a throwing system. Warned once, skipped.

**Evaluation is event-driven, never polled.** `Profile` has no `update`/`fixedUpdate`
and is not in the engine's system list. High-frequency counters (`kill`, `damage`,
`itemPickup`, `goldChanged`) mark evaluation dirty and a 250 ms timer runs it; discrete
milestones (`stageStart`, `bossDead`, `teleporterComplete`, run commit) evaluate
immediately so the toast lands on the same beat as the banner.

### The 15 challenges shipped

`firstBlood`, `warmingUp`, `shockAndAwe`, `theLongHaul` (stage 5), `looper` (stage 13),
`marathon` (30 min), `bossSlayer` (10), `eliteHunter` (100), `thousandCuts` (1000),
`oneShot` (1000 dmg in one hit), `untouchable` (clear a stage untouched),
`hoarder` (30 items in a run), `richBeyondReason` (5000 gold in a run),
`veteran` (25 runs), `noSurvivors` (25 deaths, hidden).

Every one of these depends **only on generic run and lifetime numbers**. Not one
references a survivor, item, equipment, enemy or artifact id, because none of those
catalogues could be verified from here while A1–A3 are rewriting them. A challenge
referencing a nonexistent id is worse than a missing challenge, so there are none.

---

## The extension point (A1–A3 / whoever binds content)

Bottom of `src/data/challenges.js`:

```js
export const UNLOCK_BINDINGS = {};   // <- fill this in

export function applyUnlockBindings() { ... }  // idempotent; call after editing
applyUnlockBindings();                          // runs once at module load
```

Add `'<challengeId>': { type, id }` and that content becomes locked until the challenge
is complete. **Nothing else has to change** — this table is the single switch between
"content exists" and "content must be earned". Example once ids are real:

```js
export const UNLOCK_BINDINGS = {
  looper:      { type: 'artifact',  id: 'sacrifice' },
  bossSlayer:  { type: 'survivor',  id: 'engineer' },
  untouchable: { type: 'equipment', id: 'blastShower' },
};
```

Rules, in order of blast radius:

1. `type` must be in `UNLOCK_TYPES`.
2. `id` must exist in the relevant data module. `applyUnlockBindings` validates the
   *challenge* id and the shape of the reward and warns on either, but **cannot** check
   the content id — nothing in `data/challenges.js` may import a content catalogue, or a
   data module and the profile become an import cycle. A typo here deletes content.
3. Never gate the starting survivor or a common-tier item. The default is unlocked.

`applyUnlockBindings()` clears previous bindings first, so removing an entry really does
un-gate the id (verified in test §4). `Profile`'s cached gate map invalidates off
`bindingStamp()`, so a rebind at runtime or under hot reload is seen immediately.

Adding a new unlock namespace is one string in `UNLOCK_TYPES`; the profile builds and
persists a map per entry automatically.

---

## Persistence & migration strategy

- **One key, one owner.** `localStorage['petrichor.profile.v1']`. `Menus.js` owns the
  settings blob and `GpuNotice.js` one dismissal flag; neither overlaps. Nothing else in
  the codebase touches storage for meta state.
- **Debounced.** `_touch()` marks dirty and arms a 1500 ms timer; a burst of twenty
  kills is one write. `flush()` also runs on `pagehide`, on `visibilitychange → hidden`,
  and immediately on run commit (the player is about to alt-tab off the death screen).
  A write never happens inside a frame callback, and the payload is bounded by
  construction (25 runs + id maps), so the stringify is sub-millisecond.
- **Storage that throws** (private mode, quota, a partition that went away) sets
  `_storageBlocked` and the game plays on un-persisted rather than retrying every 1.5 s.
- **Migration is a chain**, `MIGRATIONS[fromVersion] -> next`, walked until
  `PROFILE_VERSION`. Entry `0` covers profiles written before the payload carried a
  version stamp. A missing link in the chain warns and falls through to normalisation
  rather than discarding the profile. A profile from a *newer* build is not migrated
  backwards (there is no honest way to); it is normalised, keeping every field this
  build understands.
- **`_coerce` is the half that needs no per-version code.** Every load merges onto the
  fresh defaults with per-field type checks. That makes every migration additive-safe:
  a field added after the blob was written appears with its default instead of leaking
  `undefined` into arithmetic, a field removed is dropped, and a hand-edited string
  where a number belongs cannot poison a stat. It is also why a hostile blob cannot
  produce a `NaN` that then persists forever.
- **Corrupt input never throws.** Unparseable, `null`, an array, a primitive, a
  half-written blob, wrong-typed fields — all degrade to a working profile. Throwing
  here would take the page down before the first frame, which is strictly worse than a
  lost profile.

## Co-op

Per-client, local, never synced, and deliberately **not** gated on `ctx.authority` — a
client earns their own unlocks on someone else's host, and gating on authority would
mean only hosts ever unlock anything.

What replaces the authority gate is a **witness rule** (`_isLocalSource`). A client
receives the host's replicated `kill` and `damage` events for the whole session, so
without this a player could farm someone else's playtime:

| fact | credited to |
|---|---|
| kills, damage dealt, damage taken, highest hit | **only the local player** (`src === ctx.player`, or `src.owner === ctx.player` for procs/summons) |
| boss downed, teleporter charged, stage cleared | **everyone present** — they were in that fight |
| item pickup | local, unfiltered — `itemPickup` is already replicated as *this* client's inventory change (NETCODE.md) |
| discovery (logbook "seen") | everyone — a client that watched a Titan die has seen a Titan |

In single-player (`netRole === 'single'`) the filter is a no-op.

One real bug the co-op test caught and fixed: a client joining a host on stage 7
receives one `stageStart` with `index: 7`, and the naive "index went up = a stage was
cleared" rule credited it seven stage clears it never played. The first `stageStart` of
a session now *opens* the run at that index instead of arriving at it.

## Why no registration line in Engine.js / main.js

The brief allowed appending a registration line to `core/Engine.js`. `Engine.js` has no
system list — registration lives in `main.js` (`engine.add(...)`), which four other
agents are also editing this round. So: `Progression` constructs and inits `Profile`,
exactly the way it already owns `Interactables` and for the same stated reason. This is
a **zero-conflict** integration; not one shared file was modified.

It is also the honest shape: `Profile` owns no frame time (every counter is an event
handler, every write is on a timer), so a slot in the engine's update loop would
advertise a cost it does not have. `tools/perf.mjs` confirms it — there is no
`Profile.*` entry in `perSystemMs` at all.

---

## Verification evidence

### 1. Unit suite — 66/66

`node reviews/round5/B1-profile.test.mjs` (self-contained; fakes `localStorage` and the
event bus, imports the real `Profile` and `challenges`).

```
[1] round trip: write, reload, read back identical
  PASS  something was written
  PASS  reload is byte-identical to what was written
  PASS  run record survived
  PASS  lifetime kills survived
  PASS  lifetime bosses survived
  PASS  teleporters counted
  PASS  stagesCleared counted
  PASS  highestHit recorded
  PASS  explicit unlock survived
  PASS  discovery survived
  PASS  run outcome is death
  PASS  firstBlood completed
  PASS  warmingUp completed
  PASS  shockAndAwe completed
  PASS  oneShot completed (1234 >= 1000)
  PASS  thousandCuts in progress, not done
  PASS  hidden challenge is masked

[2] corrupt storage degrades to a fresh profile without throwing
  PASS  garbage "" -> usable profile
[profile] stored profile is not valid JSON — starting fresh
  PASS  garbage "not json at all" -> usable profile
[profile] stored profile is not valid JSON — starting fresh
  PASS  garbage "{" -> usable profile
[profile] stored profile is not valid JSON — starting fresh
  PASS  garbage "{\"version\":" -> usable profile
[profile] stored profile is not an object — starting fresh
  PASS  garbage "null" -> usable profile
[profile] stored profile is not an object — starting fresh
  PASS  garbage "[]" -> usable profile
[profile] stored profile is not an object — starting fresh
  PASS  garbage "[1,2,3]" -> usable profile
[profile] stored profile is not an object — starting fresh
  PASS  garbage "\"a string\"" -> usable profile
[profile] stored profile is not an object — starting fresh
  PASS  garbage "42" -> usable profile
[profile] stored profile is not an object — starting fresh
  PASS  garbage "true" -> usable profile
  PASS  garbage "{\"version\":\"banana\",\"stats\":\"nope\",\" -> usable profile
  PASS  garbage "{\"version\":1,\"stats\":{\"kills\":\"NaN\",\ -> usable profile
  PASS  garbage "{\"version\":999999,\"stats\":{\"kills\":11}, -> usable profile
  PASS  garbage "{\"version\":1,\"runs\":[{\"kills\":{},\"outc -> usable profile
[profile] stored profile is not valid JSON — starting fresh
  PASS  garbage " " -> usable profile
  PASS  garbage "{\"version\":1,\"stats\":{\"kills\":3}}" -> usable profile
  PASS  Object.prototype was not polluted

[2b] storage that throws (private mode / quota)
  PASS  blocked storage does not throw and still plays

[3] old-schema profile migrates without data loss
  PASS  version stamped to current
  PASS  createdAt preserved
  PASS  unlocks preserved
  PASS  challenge progress preserved
  PASS  discoveries preserved
  PASS  run history preserved
  PASS  lifetime stats preserved
  PASS  new fields defaulted, not undefined
  PASS  migrated profile re-round-trips

[4] unlock gating via the UNLOCK_BINDINGS extension point
  PASS  with no bindings, everything is unlocked
[challenges] UNLOCK_BINDINGS names unknown challenge "nonexistentChallenge"
  PASS  bound id is now locked
  PASS  unbound ids stay unlocked
  PASS  challenge completed
  PASS  unlock granted
  PASS  unlockEarned emitted once
  PASS  drainPendingUnlocks drains
  PASS  unlock persists across reload
  PASS  unbinding un-gates

[5] co-op: a client is not credited for what it only watched
  PASS  only own kills counted (4 direct + 2 proc)
  PASS  only own damage dealt counted
  PASS  only own damage taken counted
  PASS  highestHit not inflated by the host
  PASS  but the enemy was still discovered
  PASS  shared facts credited to the client
  PASS  run began at the joined stage index

[6] run-scoped high-water marks survive the end of the run
  PASS  hoarder done
  PASS  richBeyondReason done
  PASS  untouchable done
  PASS  run-scoped progress not erased by run end
  PASS  run cleared after commit
  PASS  a second commit is a no-op

ALL PASS: 66 passed, 0 failed
```

The `[profile] ...` lines interleaved above are the warnings the code is *supposed* to
print; they are evidence, not failures. The `__proto__` case confirms no prototype
pollution through `JSON.parse` + merge. The `version: 999999` case is the
newer-build-then-older-build path.

### 2. Build — clean

`npm run build` in the live working tree (i.e. *with* A1–A4's in-flight edits present):

```
> vite build
vite v8.2.0 building client environment for production...
transforming...✓ 77 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                    0.94 kB │ gzip:   0.58 kB
dist/assets/index-DKY3L9_F.css    30.62 kB │ gzip:   7.67 kB
dist/assets/Harness-Ba-EijLq.js   10.60 kB │ gzip:   4.53 kB │ map:    69.67 kB
dist/assets/enemies-Bju1srjg.js  440.44 kB │ gzip: 116.77 kB │ map: 2,228.45 kB
dist/assets/index-CufbMsnE.js    857.99 kB │ gzip: 267.41 kB │ map: 2,576.45 kB
✓ built in 750ms
```

(The 500 kB chunk-size advisory is pre-existing and unrelated.)

### 3. Capture — clean, but run in isolation. Read this.

`node tools/capture.mjs` **against the live working tree fails**, and not because of
anything in this task:

```
[vite] (client) [Unhandled error] TypeError: Cannot read properties of undefined (reading 'name')
 > src/entities/Player.js:171:35
    171 |          slot, ability: a, name: a.name, description: a.description, key: a.key,
 > Player.init src/entities/Player.js:168:29
{ "ready": false, "shots": [], "errorCount": 1 }
```

`git diff --stat` shows `src/data/abilities.js` at **+809/-5** with `Player.js`
unmodified: A1 has landed the new ability table but not yet the `Player.js` that reads
it, so `ABILITIES[slot]` is `undefined`. Neither file is mine and I did not touch them.

So capture was verified in a detached worktree at `HEAD` (4ec7258) with **only my three
files** copied in — clean baseline + B1, nothing else:

```
[15.029s] scenario 04-combat...
[17.133s] scenario 05-boss...
[19.696s] scenario 07-interactables...
[21.526s] scenario 08-explosion...
[23.132s] scenario 06-loaded-hud...
{
  "ready": true,
  "shots": ["01-title","02-vista","03-thirdperson","04-combat","05-boss",
            "06-loaded-hud","07-interactables","08-explosion"],
  "errorCount": 0,
  "perf": { "programs": 64, "geometries": 165, "textures": 47, "sceneObjects": 600 }
}
```

Per-shot, from `shots/manifest.json`:

```
01-title         frameErrors=0 lastFrameError=null newErrors=[]
02-vista         frameErrors=0 lastFrameError=null newErrors=[]
03-thirdperson   frameErrors=0 lastFrameError=null newErrors=[]
04-combat        frameErrors=0 lastFrameError=null newErrors=[]
05-boss          frameErrors=0 lastFrameError=null newErrors=[]
06-loaded-hud    frameErrors=0 lastFrameError=null newErrors=[]
07-interactables frameErrors=0 lastFrameError=null newErrors=[]
08-explosion     frameErrors=0 lastFrameError=null newErrors=[]
```

Top-level: `ready: true`, `partial: false`, `errors: []`.

Note the success criteria named top-level `frameErrors` / `newErrors` keys in
`manifest.json`. Those keys do not exist at top level in this version of
`tools/capture.mjs` — `frameErrors` and `newErrors` are recorded **per shot** (see
`capture.mjs:218-220`), and the top level carries `ready` / `errors` / `partial`. All
eight are zero/empty, which is the same claim.

The worktree was removed afterwards; `git worktree list` shows only the main checkout.

### 4. Perf — unchanged

Three runs of `node tools/perf.mjs` at HEAD, three with B1 applied, same worktree, same
machine (`combat-24` scenario):

```
BASE-1      frames  21 avg  12.82 med   13.3 p95   15.2 | Progression.fixedUpdate 0.014 | Profile entries 0
BASE-2      frames  10 avg  18.51 med     19 p95   20.7 | Progression.fixedUpdate 0.01  | Profile entries 0
BASE-3      frames  11 avg   17.1 med   16.7 p95   20.3 | Progression.fixedUpdate 0.018 | Profile entries 0
MINE-1      frames  17 avg  16.12 med     17 p95     21 | Progression.fixedUpdate 0.006 | Profile entries 0
MINE-2      frames  15 avg  17.06 med     17 p95   22.1 | Progression.fixedUpdate 0.02  | Profile entries 0
MINE-3      frames  10 avg  13.33 med   14.3 p95   16.8 | Progression.fixedUpdate 0     | Profile entries 0
```

Baseline spans 12.82–18.51 ms; B1 spans 13.33–17.06 ms — inside the baseline's own
range. The sample is 10–21 frames on a machine currently running four other agents'
builds and headless Chromiums, so total frame time is dominated by scheduling noise.

The number that is actually attributable is `Progression.fixedUpdate`: 0.010–0.018 ms
baseline vs 0.000–0.020 ms with B1 — indistinguishable, as expected, since nothing was
added to that function. And **`Profile entries 0`**: there is no `Profile.*` key in
`perSystemMs` in any run, because `Profile` is not in the engine's system list and owns
no frame time at all. That is the structural argument, and it is stronger than the
timing one.

---

## Left undone / notes for whoever picks this up

1. **`UNLOCK_BINDINGS` is empty.** By design and stated above — this is the deliverable's
   marked extension point, not an omission. Until it is filled, every id is unlocked and
   the 15 challenges are pure achievements. Someone with the final id lists must fill it.
2. **`survivorId` / `difficultyId` are `null` in every run record** until `ctx.player.survivorId`
   and `ctx.difficultyId` exist. No code change needed here when they land; they are
   read defensively. B3 should render `null` as "—".
3. **`outcome: 'victory'` is unreachable** — there is no victory condition in the game.
   `Progression._endRun` is only called with `won = false`. Any challenge phrased "win a
   run" would be unattainable, which is why none was written.
4. **No `quit` path.** `outcome: 'quit'` is accepted by the schema but never produced;
   abandoning a run mid-way currently discards it (the run is only committed on death).
   If B3 adds a "return to menu" button it should call
   `ctx.progression.profile.commitRun(false, ctx.progression.runStats())` — or better,
   ask for a `Progression.abandonRun()` and I/someone will add it, since `_endRun` is
   mine.
5. **The capture failure in the live tree is A1's** (`abilities.js` rewritten,
   `Player.js` not yet). It will resolve when A1 lands `Player.js`. Whoever integrates
   should re-run capture on the merged tree; B1 is verified clean against a baseline
   that isolates it.
6. `reviews/round5/B1-profile.test.mjs` is not wired into any npm script — there is no
   test runner in this project. Run it directly: `node reviews/round5/B1-profile.test.mjs`.
