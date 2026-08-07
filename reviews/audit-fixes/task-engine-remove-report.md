# Engine.remove / Lobby teardown leak — fix report

Status: **done**. Not committed (per instructions).

## Defect

`Engine` had `add()` but no `remove()`. `Lobby.leave()` closed the net system and
nulled its own `this.net`, but the system stayed in `engine.systems` (still
ticked every frame) and `ctx.net` — published by `NetHost.init` / `NetClient.init`
— still pointed at the closed instance. Leave-then-rehost therefore left two live
`NetHost` instances registered.

## TDD sequence (tests written and failing first)

New tests added to `tests/lobby-lifecycle.test.mjs`, run before any src change:

```
leave() deregisters the net system and clears ctx.net
  PASS  precondition: hosting registers the NetHost
  PASS  precondition: NetHost.init published itself as ctx.net
  FAIL  net system deregistered (systems: 1)
  FAIL  ctx.net cleared — it pointed at the closed instance
host -> leave -> host again leaves exactly one NetHost registered
  FAIL  exactly one NetHost registered (got 2)
  FAIL  the registered host is the live one, not the closed one
Engine.remove — the deregistration half of add()
  PASS  added system is registered
  TypeError: engine.remove is not a function
```

Failures matched the reported defect exactly: stale registration (1), duplicate
host on rehost (2), and the missing method.

The failed-join test was added after that first cycle; its fix was re-verified by
temporarily neutralising the new `catch` body in `joinManual`, which reproduced
`failed client deregistered (systems: 1)`, `ctx.net cleared`, and `a retry is not
blocked by a dead session` as FAILs. The neutralisation was reverted from a
byte-identical backup and the suite re-run.

## Test fixture

- `makeEngine(ctx)` now mirrors the real Engine contract: a `systems` array,
  `add` pushing and running `init(ctx)`, `remove` splicing. Registration is the
  quantity the leak is measured in, so the fake had to hold the list.
- `Engine.remove` is tested against the **real** `Engine`, not a seam: `src/core/Engine.js`
  imports `three`, but constructs only `Scene` / `PerspectiveCamera` / `Clock`,
  all of which build headless under node (no renderer, no GL context). Verified
  by direct construction. `engine._frame()` is driven once to prove a removed
  system is no longer updated.
- Real `NetHost` and `NetClient` also construct under node, so the lobby tests
  exercise the actual systems rather than stand-ins.

## Changes

### src/core/Engine.js
- `remove(system)` next to `add()`: `indexOf` + `splice`, returns the system.
  Removing a system that was never added is a deliberate no-op — teardown paths
  run on both the "we registered it" and "we failed before we did" branches.
- The three phase loops in `_frame` now iterate `[...this.systems]`. `remove()`
  splicing the live array under `for...of` would silently skip whichever system
  followed the removed one for that phase — the same hazard `EventBus.emit`
  already copies for, and now reachable because a system's own tick can end a
  session. Side effect, named: a system added during a frame no longer runs in
  that frame's remaining phases. Nothing in `src/` adds a system from inside a
  frame.

### src/net/Lobby.js
- `_release()`: undoes `engine.add` and clears `ctx.net` (only if it still points
  at this system), then nulls `this.net`. `engine.remove?.()` is optional-called
  so the existing hand-rolled engine fakes elsewhere keep working.
- `leave()` calls `_release()` in place of `this.net = null`.
- `joinManual()` wraps `client.join` in try/catch: the client is registered
  *before* the await, so a join that never lands used to leave a dead `NetClient`
  ticking and owning `ctx.net`, and the natural retry died on 'Already
  networked'. The catch releases, restores `mode`, and restores
  `ctx.authority` / `ctx.netRole` (C-2's reasoning applies verbatim to a session
  that failed before it began), then rethrows.

Paths considered and left alone:
- `netRefused` / `netDisconnected` handlers only set status; the session is torn
  down by the `leave()` the UI issues, which is now correct.
- `hostViaRelay` rejects on socket error with the `NetHost` registered, but the
  lobby is genuinely still hosting at that point and `leave()` now cleans it.
- `acceptAnswer` registers nothing; only the invite, already handled.

## Verification

- `node tests/lobby-lifecycle.test.mjs` → **24 passed, 0 failed** (was 7 tests,
  now 24 assertions across 7 blocks).
- `node tests/run.mjs` → all 8 tracked test files pass:
  connect-deadline, enemy-targeting, heal-denial, lobby-lifecycle,
  nethost-hello-gate, netlag, roster, targeting.
- The runner also picked up `tests/vfx-status-dedup.test.mjs`, which is
  **untracked** (`git status`: `?? tests/vfx-status-dedup.test.mjs`) and not part
  of this task. It fails inside `src/systems/VFX.js:931`
  (`this._statuses.push is not a function`) — a file this task never touched.
  Pre-existing and unrelated.

## Files changed

- `C:\Users\tpzap\source\repos\OllieFace\src\core\Engine.js`
- `C:\Users\tpzap\source\repos\OllieFace\src\net\Lobby.js`
- `C:\Users\tpzap\source\repos\OllieFace\tests\lobby-lifecycle.test.mjs`
