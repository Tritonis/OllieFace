# Parked save/id migration — report

Branch `master`, **not committed**. Browser gates (`sp-equivalence`, `gate:elite`,
probes) deliberately **not run** — the main session serialises those. Evidence
below is `node tests/run.mjs` and `node node_modules/vite/bin/vite.js build`.

---

## Phase 1 — storage key migration: APPLIED

All five `petrichor.*` keys are now `telluric.*`, each with a one-time adoption
at its single read site.

| Old key | New key | Read site |
|---|---|---|
| `petrichor.profile.v1` | `telluric.profile.v1` | `src/systems/Profile.js` `_load` |
| `petrichor.run.v1` | `telluric.run.v1` | `src/systems/Artifacts.js` `_load` |
| `petrichor.settings` | `telluric.settings` | `src/ui/Menus.js` `load` |
| `petrichor.gpuNoticeDismissed` | `telluric.gpuNoticeDismissed` | `src/ui/GpuNotice.js` `maybeShowGpuNotice` |
| `petrichor.net.*` (prefix) | `telluric.net.*` | `src/net/NetConfig.js` `store.get` |

### The seam

`src/core/LegacyStorage.js` — `adoptLegacyKey(key, legacyKey, storage)`. Placed
in `core/` because `systems/`, `ui/` and `net/` all need it and a `systems/`
module imported by `ui/` would violate the CONTRACTS layering. It is the whole
of the logic, which is what makes it testable without a browser: every call site
passes the real `localStorage`, the tests pass a fake store object.

Semantics, and the choices behind them:

- **New key present** → its value wins, and the old key is **removed**.
  *Documented choice.* Leaving the stale key would make the check re-run for the
  life of the install, and any later reader that fell back to it would resurrect
  a profile the player has already moved past.
- **Only the old key** → bytes copied to the new key, old key removed, bytes
  returned.
- **Neither** → `null`, nothing written. A fresh install leaves no empty keys.
- **Value is moved as bytes, never parsed.** Every call site already turns an
  unreadable blob into a working default; a second validation here would be free
  to disagree with the first. So a corrupt old value cannot crash the adoption —
  it is handed to the caller's existing parse guard exactly as before.
- **A failing write does not take the removal with it.** On quota / a storage
  partition that went away, the value is still returned and the old key is
  *kept*, so the adoption retries next boot. Losing the copy *and* the original
  is the one outcome worse than migrating twice.

### Two non-obvious call-site details

1. **`Profile` has two reads of its key**, `_load` and `_reconcile`. The
   adoption goes only in `_load` (the boot read). `_reconcile` is the cross-tab
   re-read and by the time another tab can write, nothing is left under the old
   name. `localStorage` is passed **explicitly** rather than defaulting to
   `globalThis.localStorage`, so a private-mode access that throws still reaches
   the `catch` that sets `_storageBlocked` — the default would have swallowed it
   and left the flag false.
2. **`NetConfig.store.del` now removes both prefixes.** This is a real bug the
   naive version would have shipped: `?turn=` means "stop using TURN", and a
   clear that dropped only `telluric.net.turn` would have the next `get` adopt
   `petrichor.net.turn` and switch the setting straight back on.

### Tests — `tests/storage-migration.test.mjs`, 36 assertions, all passing

Written first; the first run failed with `ERR_MODULE_NOT_FOUND` on
`src/core/LegacyStorage.js`, then failed on the source-grep block until every
call site was converted.

Covers: fresh install (no keys, nothing written); old key only (adopted, old
removed, second read stable); both present (new wins, old removed); corrupt old
value (`{not json`, `''`, `null`, `[]`, a lone-surrogate string — none throw,
each handed back verbatim); a store whose `setItem` throws (value still
returned, old key kept); absent/`null` storage.

The last block is a source grep over `src/`: `petrichor.` may appear **only** as
a `const LEGACY_… = 'petrichor.…';` declaration, exactly one per key, exactly
five in total. It fails on a live key, a stale doc comment, or a forgotten sixth
call site.

---

## Phase 2 — item id migration: APPLIED

**Reason, one line:** the ids provably cannot reach any compared field —
`sp-equivalence`'s `sourceKey` reads `s.def.id` off a *damage source*, which is
only ever the player or an enemy spawn card, and the roll pools are positional
arrays, so no seed, draw or fingerprint moves.

Renames applied in `src/data/items.js`:

- `hopoo-feather` → `hollow-plume` (line 875; displays "Hollow Plume", unchanged)
- `shatterspleen` → `hoarfrost-band` (line 815; displays "Hoarfrost Band", unchanged)
- cooldown key `'runald'` → `'hoarfrost-band'` (line 821), matching the file's
  convention of keying a cooldown by its own item's id

### Blast radius — established before touching anything

Every occurrence of the three strings in the repo, before the change:

```
src/data/items.js:815   id: 'shatterspleen', ...
src/data/items.js:821   api.items.cooldownReady('runald', 5)
src/data/items.js:875   id: 'hopoo-feather', ...
```

…plus prose in `reviews/round3-charui.md`, `reviews/round6/BRANDING-LEDGER.md`,
`reviews/round6/C4-branding.md`, `reviews/round6/HANDOFF.md`. **No hits** in
`tests/`, `tools/`, `docs/`, any `*.html`, or any `*.json` — including all six
baseline files in `reviews/round8/`.

#### Why the gates cannot move — four independent checks, each verified in source

1. **`sourceKey` never sees an item id.** Both copies (`tests/sp-equivalence.mjs:438`
   elite-dps arm, `:872` fingerprint arm) are byte-identical:
   `if (!s) return 'environment'; if (s.isPlayer) return 'player'; const id = s.def?.id; …`
   `s` is a *damage source*. The only sources item hooks produce are
   `api.player` (`src/data/items.js:820`, `src/systems/Items.js:1142` both pass
   `ctx.player`), which takes the `s.isPlayer` branch. `s.def.id` is the enemy
   spawn-card id from `data/enemies.js`, as the comment above it states.
   The fields keyed by it — `damageToPlayerBySource`, `damageToEnemiesBySource`,
   the elite arm's `sourceKeys`/`byType` — therefore cannot contain an item id.
2. **No other compared field can either.** The remaining fingerprint fields are
   numeric or positional; the only item-touching value in the whole file is
   `goldTotal: ctx.items?.gold ?? 0` (`:981`), a number.
3. **The roll pools are positional.** `ITEMS_BY_TIER` is a `reduce` over the
   `ITEMS` array literal (`src/data/items.js:1830`) that pushes in source order —
   no sort, no id-keyed iteration. `rollItem` ends at
   `this.ctx.rng.pick(pool).id` (`src/systems/Items.js:1037`) and `rollEquipment`
   at `rng.pick(EQUIPMENT).id` (`:1043`): the draw is an index, the id is only
   read *after* the RNG has already been consumed. The one sort touching item
   defs (`Items.js:381`) orders by `def.name`, which did not change. No string
   hash of an id exists anywhere in the codebase.
4. **The baselines contain none of the strings.** `grep` over all six
   `reviews/round8/*.json` returns zero hits for any of `hopoo-feather`,
   `shatterspleen`, `runald`, `hollow-plume`, `hoarfrost-band`; the word `item`
   appears **0** times in `elite-baseline-HEAD.json`.

Supporting: `UNLOCK_BINDINGS` (`src/data/challenges.js:520`) starts empty and is
populated at runtime from each content card's own `unlock` field — **neither
item has an `unlock` field**, so neither has a binding. `bindingStamp()` returns
`_stamp`, a plain counter incremented per registration (`challenges.js:545,597,631,648`),
not a hash over ids, so it cannot move either. The `'runald'` cooldown key is an
in-memory `Map` (`Items.js:130`) cleared at run reset (`:180`), never persisted,
and no other cooldown key collides with `'hoarfrost-band'`.

#### What actually needed migrating

Four persisted structures key on item ids. The context brief named three; the
fourth (`edict`) was found during this investigation and is **not** in `Profile`.

| Structure | Where | Handled by |
|---|---|---|
| `unlocks.item[id]` → unlock timestamp | `telluric.profile.v1` | `MIGRATIONS[2]` |
| `encounters.item[id]` → `{ at, count }` (discovery/bestiary log) | `telluric.profile.v1` | `MIGRATIONS[2]` |
| `runs[].inventory[].id` → recorded run loadouts | `telluric.profile.v1` | `MIGRATIONS[2]` |
| **`edict[tier]` → item id (Command pick)** | `telluric.run.v1` | `Artifacts._load` |

Challenge state is keyed by *challenge* id and the per-survivor career table by
*survivor* id; neither carries an item id. Nothing else does.

### Implementation

`src/data/renamedItems.js` — the table plus `renameItemId(id)`. A file of its
own because `Profile` and `Artifacts` both need it and **neither may import the
item catalogue**; `Artifacts` in particular documents that it stores an edict
without ever loading the item table, and pulling in `data/items.js` to translate
two strings would undo that. Unknown ids pass through untouched rather than
being dropped — an unrecognised id may belong to a newer build, and every
consumer already validates against the live table.

`PROFILE_VERSION` 2 → **3**, with `MIGRATIONS[2]` added to the existing chain
(so a v0 profile still walks 0→1→2→3 through three small functions). Joins are
the ones the cross-tab merge already uses for each field: **earliest wins** for
an unlock or first-seen stamp, **counts add**, and inventory collapses to one
row per id. Old and new id cannot both appear in a profile *this build* wrote,
but `importProfile` accepts arbitrary blobs through the identical
`_migrate`/`_coerce` path, and a collision that silently dropped one side would
be data loss discovered months later.

`Artifacts._load` passes each stored edict id through `renameItemId`. A stale id
there is not a crash — `commandPick` validates against the live pool — it is a
Command pick that quietly stops being honoured, which is the harder bug to see.

### Tests — `tests/item-id-migration.test.mjs`, 53 assertions, all passing

Written first (first run: `ERR_MODULE_NOT_FOUND` on `src/data/renamedItems.js`).

Covers: the catalogue no longer carries either old id and both new ids resolve,
ids still unique, display names unmoved; the rename table is total and injective
onto live ids (no entry maps onto an id that is also live); `renameItemId` is
idempotent and passes unknowns through; a v2 profile carrying both old ids in
all three profile structures migrates with every timestamp and count intact and
no row dropped or duplicated; a blob holding **both** old and new id merges
(counts add, earliest stamp wins) instead of clobbering; migrating twice does
not double a count; four malformed v2 blobs (`{}`, null/`'no'`/non-array fields,
`[null, 3]` runs) migrate without throwing; and the artifact store's edict moves
onto the new ids with untouched tiers left alone, driven through a stubbed
`globalThis.localStorage` that is restored in a `finally`.

**Mutation check** (the tests went green on first run, so the assertions were
verified to be load-bearing): stubbing `renameItemId` to the identity function
turns **15 assertions red** across all four structures. Restored immediately;
the file on disk is unmodified.

The two pinned-index assertions — `ITEMS_BY_TIER.uncommon[4]` is Hoarfrost Band,
`[10]` is Hollow Plume, pool length 31, catalogue 108 — are the falsifiable form
of the "the roll pools did not move" argument. **If a future edit reorders
`ITEMS`, this test fails and the determinism baselines are genuinely in
question.** That is the intended tripwire.

---

## Verification

```
node tests/run.mjs                      → 17/17 test files passed
  tests/storage-migration.test.mjs      → 36 passed, 0 failed
  tests/item-id-migration.test.mjs      → 53 passed, 0 failed
node node_modules/vite/bin/vite.js build → ✓ built in 726ms, no errors
```

Browser gates not run, per instruction. Given the four checks above I expect no
movement in either `sp-equivalence` or `gate:elite`, but that expectation is
**unverified by execution** and the main session should confirm it.

## Files changed

New:
- `src/core/LegacyStorage.js`
- `src/data/renamedItems.js`
- `tests/storage-migration.test.mjs`
- `tests/item-id-migration.test.mjs`

Modified:
- `src/systems/Profile.js` (key + adoption, `PROFILE_VERSION` 3, `MIGRATIONS[2]`)
- `src/systems/Artifacts.js` (key + adoption, edict remap, stale doc comment)
- `src/ui/Menus.js` (key + adoption)
- `src/ui/GpuNotice.js` (key + adoption)
- `src/net/NetConfig.js` (prefix + adoption, `del` clears both prefixes)
- `src/data/items.js` (two ids, one cooldown key)

## Notes for whoever picks this up

- **The working tree was not clean.** `src/net/Lobby.js`, `src/net/NetHost.js`,
  `src/net/Transport.js`, `tools/signal-server.mjs`,
  `reviews/round8/probe-targeting.mjs`, `tests/nethost-dead-host-join.test.mjs`
  and `tests/trickle-ice.test.mjs` were already modified/untracked by concurrent
  work when this task started and were **not touched here**. Note that
  `src/net/NetConfig.js` *is* in this task's change set — check for overlap
  before committing.
- **`package-lock.json` still says `"name": "petrichor"`** (lines 2 and 8), while
  `package.json` says `telluric-void`. Out of scope here (not a storage key) and
  left alone deliberately — regenerating the lockfile is its own risk.
- Prose references to the old ids remain in `reviews/round3-charui.md`,
  `reviews/round6/BRANDING-LEDGER.md`, `reviews/round6/C4-branding.md` and
  `reviews/round6/HANDOFF.md`. Those are historical review records; the ledger's
  deferral note at `BRANDING-LEDGER.md:102` is now discharged by this work.
