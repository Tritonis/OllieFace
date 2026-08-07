# VFX status dedup + HUD strip-hold unit — report

Two independent fixes, TDD, not committed.

## Fix 1 — VFX status-overlay dedup is now O(1)

`src/systems/VFX.js`

**Was:** `_statuses` was a flat array of `{target, type, def, t, dur, accum}`.
`statusApplied` linear-scanned the whole array on every proc to decide
new-vs-refresh. Every hit that procs a status paid O(live overlays).

**Now:** `_statuses` is a `Map<target, Map<type, entry>>`. Dedup is two Map
lookups. Entry shape is unchanged, so nothing downstream of an entry moved.

Every use of `_statuses` in the file was updated (there were four sites; the
symbol does not appear anywhere else in `src/`):

- ctor (~line 134) — `[]` becomes `new Map()`, with a comment on why it is keyed.
- `statusApplied` (~922) — find-or-refresh via `get`/`get`, insert via `set`.
  Refresh still sets `t = 0` and overwrites `dur`, identical semantics.
- `status` (~940) — see the behaviour note below.
- `_updateStatuses` (~1492) — nested `for…of` over both Maps. Expiry
  (`t >= dur`) and death (`alive === false`) `delete` the type key; when a
  target's inner Map empties, the **target key is deleted from the outer Map**.
  That last line is the leak guard — without it the outer Map would retain
  every entity that was ever set on fire, which the old `splice` did not.
  Deleting from a Map during its own `for…of` is well-defined in JS.

**Iteration order:** both levels are `Map`, which iterates in insertion order,
so overlays still emit in application order exactly as the array did. A refresh
mutates in place rather than re-inserting, so it does not move to the back —
pinned by a test. Noted in the ctor comment since it is load-bearing for
draw order.

### One intentional behaviour normalisation, in `status()`

The old `status(entity, type, colour)` fished the entry back out with
`this._statuses[this._statuses.length - 1]` and then checked
`s.target === entity && s.type === type && s.t === 0` to confirm it had the
right one. That check only passes when the entry happens to sit at the array
tail — true for a fresh insert (always the tail), but for a **refresh** it was
true only if that entry was already last. So the one-shot application pop fired
on some refreshes and silently not on others, depending on the order unrelated
entities happened to catch fire in.

`statusApplied` now **returns the live entry** (previously it returned
`undefined`; no caller used the return value), and `status()` uses it directly.
The pop therefore fires on every coloured proc, refresh included — which is
what the existing comment there asks for ("a fresh proc reads distinctly from
the ongoing overlay").

This is the only behaviour that is not bit-identical to before. It is a
normalisation of an order-dependent inconsistency, not a new effect: in the
common single-target case the entry *was* the tail, so the pop already fired on
every reproc. Flagging it because it is a visible-particle change and was not
literally in the brief. The ongoing-overlay rate — the thing the dedup exists
to cap — is untouched.

## Fix 2 — HUD strip-rect hold is wall-clock, not frames

`src/ui/HUD.js`

**Was:** `this._stripHold = 60`, decremented once per `update()` inside
`updateStripRect()`, reset to 60 by `markStripDirty()`. The docblock promised
"re-read for a second". At 30 fps that is 2 s of a forced layout flush every
frame; at 144 fps it is 0.42 s, which can close before the tiles finish
animating in (~0.34 s) and leaves `VFX.DamageNumbers` clipping against a stale
rect.

**Now:** module constant `STRIP_HOLD_SEC = 1.0` near the top of the file, with a
comment in the same shape as `NetHost.js`'s `HELLO_MAX_AGE_SEC` (~line 43-50):
the unit, what the old count read as at two real frame rates, and the cost at
each end of the range. Field renamed `_stripHoldT`; `updateStripRect(dt)` does
`this._stripHoldT -= dt`; `markStripDirty()` resets to `STRIP_HOLD_SEC`.

`dt` convention: `update(ctx, dt)` is the HUD's own signature and the neighbours
on the same lines take it the same way (`updateDirections(ctx, dt)`,
`updateToasts(dt)`). The single call site at `update()` now passes `dt`.
`updateStripRect` has no other caller in `src/`.

Side effect, for free: a frame hitch now spends the window in proportion to the
stall instead of banking 60 whole frames of re-measure behind it.

## Tests

Both files test the shipped methods through the prototype on a hand-built
`this`. Neither `VFX` nor `HUD` is constructible headless (meshes/shaders
against a live renderer context; a document), but both **modules** import fine
under plain node, so `Object.create(Class.prototype)` plus only the fields the
method under test touches is a real seam. **No test-only code was added to
production** — the only production signature change is `statusApplied`'s return
value, which `status()` itself consumes.

### `tests/vfx-status-dedup.test.mjs` — 36 assertions

Insert; explicit duration override; refresh (same object identity, `t` reset,
`dur` updated, no duplicate); second type on the same target coexists; refresh
does not reorder; two targets independent; unknown type / null target leave no
key; expiry drops the entry **and** the target key; one of two types expiring
keeps the target key; a dead target drops all its overlays and its key; a
2000-proc / 50-target churn settles at 100 overlays and empties completely on a
wipe; the `status()` pop still fires (and does not fire without a colour).

### `tests/hud-strip-hold.test.mjs` — 16 assertions

The window measured in simulated wall clock at 1/30 and 1/144 dt: last
re-measure lands at ~1.0 s in both, with ~30 vs ~144 calls; the two rates agree
on duration within 50 ms while their call counts differ by ~5x; a 0.5 s hitch
spends the window in ~2 steps; the rect is published from the element and
re-measuring then stops entirely; `markStripDirty` re-opens a full second
mid-flight; a missing element clears the rect.

## Failed first — confirmed

Both suites were written and run before any production edit.

- `vfx-status-dedup` died at the first assertion with
  `TypeError: this._statuses.push is not a function` at `VFX.js:931` — the
  array structure the tests were written against replacing.
- `hud-strip-hold` ran to completion **8 passed, 8 failed**, and the failures
  named the bug directly: `last re-measure at ~2.000s` at 30 fps, and at
  144 fps `the window did not close early at high frame rate` failed against a
  measured `~0.417s`. The 8 that passed are the structural ones (rect
  publication, stop-after-lapse, dirty re-opens, null element) that the fix was
  required not to break — correct for pinning tests.

## Verification

- `node tests/vfx-status-dedup.test.mjs` — 36 passed, 0 failed
- `node tests/hud-strip-hold.test.mjs` — 16 passed, 0 failed
- `node tests/run.mjs` — **10/10 test files passed**
- `node node_modules/vite/bin/vite.js build` — `✓ built in 1.30s`, exit 0
  (the pre-existing >500 kB chunk-size warning is unchanged)

Not run, per the brief: `sp-equivalence` and the browser gates.

## Files changed

- `src/systems/VFX.js`
- `src/ui/HUD.js`
- `tests/vfx-status-dedup.test.mjs` (new)
- `tests/hud-strip-hold.test.mjs` (new)

Nothing committed. `git status` also shows `src/core/Engine.js`,
`src/net/Lobby.js` and `tests/lobby-lifecycle.test.mjs` modified — those are
another agent's lane, untouched here.
