# Desktop shell

The Electron wrapper that turns the built web game into a Windows application.
Two files do all of it:

- `main.mjs` — the main process: registers the `app://` scheme, opens the
  window, owns the save file, logs the GPU adapter.
- `preload.cjs` — the only bridge the renderer gets: `window.__DESKTOP__`
  with exactly `loadStore()` and `saveStore(json)`. CommonJS on purpose;
  preloads run in a hybrid context and CJS is the no-surprises path.

## Running it

```
npm install            # the postinstall fetches the Electron binary
npm run desktop        # vite build, then electron .
npm run desktop:run    # electron . against the existing dist/ (probe loops)
```

Both call the local binary through npm scripts. Never `npx` — a bare `npx`
run in this repo once destroyed a package binding.

**The `postinstall` step is not optional.** Electron `43.3.0` ships no install
script of its own — the download moved to an explicitly-invoked bin
(`"bin": { "electron": "cli.js", "install-electron": "install.js" }`), so
`npm ci` alone leaves `node_modules/electron/dist/` empty and every command
above fails at `require('electron')`. `package.json` therefore carries
`"postinstall": "install-electron"`. It is idempotent: `install.js` exits 0
immediately when `dist/` already holds the pinned version. If a clean clone
still has no `dist/`, run it directly:

```
node node_modules/electron/install.js
```

(`npm run desktop:pack` is unaffected either way — electron-builder fetches its
own runtime through `@electron/get` into a separate cache.)

## Packing

```
npm run desktop:pack   # vite build, then electron-builder --win --dir
```

Output: `dist-desktop/win-unpacked/`, with `TELLURIC VOID.exe` at its root.
That folder *is* the deliverable — the directory SteamPipe will eventually be
pointed at. It is git-ignored; nothing under it is committed.

### What ships

```
dist-desktop/win-unpacked/
  TELLURIC VOID.exe          the Electron 43.3.0 runtime, renamed
  *.dll, *.pak, locales/     Chromium's runtime
  resources/app/
    desktop/main.mjs         the shell
    desktop/preload.cjs      the bridge
    dist/                    the built game (index.html + assets/)
    package.json             for `main` and metadata
```

Two exclusions in the `build.files` list are load-bearing, both verified after
every pack:

- **`!dist/**/*.map`** — `vite.config.js` sets `sourcemap: true`, so maps
  always exist in `dist/`. They must never leave this machine. Packed folder
  must contain **zero** `.map` files.
- **`!node_modules/**`** — electron-builder ships production `dependencies`
  by default, which would drag `three`'s entire `src/` tree into the build.
  The game is already bundled *inside* `dist/`; the shell imports nothing but
  `electron` and node builtins. Packed folder must contain **no**
  `node_modules/` at all. (This is docs/STEAM.md section 4's warning read in
  reverse: the source tree must not ride along.)

### What is deliberately absent

- **No Steam SDK / greenworks.** Achievements, cloud saves, and the overlay's
  API side are a later phase; this shell knows nothing about Steam.
- **No code signing.** `signAndEditExecutable: false`. Valve launches the exe
  itself, so an Authenticode certificate buys nothing for a Steam-only launch.
  It also means the exe carries no icon or version metadata yet.
- **No installer.** `"target": "dir"` only — no NSIS, no MSI, no portable
  self-extractor. SteamPipe uploads a folder; an installer would be a second
  thing to keep correct for no gain.
- **No auto-update.** Steam is the updater.

### `asar: false` is load-bearing

Do not turn asar on to "tidy" the package. `main.mjs` serves the `app://`
scheme with `net.fetch(pathToFileURL(...))`, and a `file://` URL pointing
*inside* an asar archive is resolved by Chromium's URL loader, whose asar
support is an implementation detail rather than a contract. The failure mode
is nasty: the dev probe stays green and the packed app opens a black window.
A portable directory target gains nothing from asar anyway.

If someone does enable it later, it is not done until
`node tools/desktopprobe.mjs --exe "dist-desktop/win-unpacked/TELLURIC VOID.exe"`
passes all eleven checks against the packed build.

### If `desktop:pack` fails with `EPERM ... rename win-unpacked.tmp`

A file watcher is holding the output directory. electron-builder extracts the
Electron runtime to `dist-desktop/win-unpacked.tmp` and renames it into place,
and on Windows an open directory handle makes `rename()` fail with EPERM.
A running vite dev server was the culprit; `vite.config.js` now carries
`server.watch.ignored: ['**/dist-desktop/**']` so it no longer watches the
build output. If it recurs, look for another watcher over the repo — the
diagnostic is that the same tree renames fine when copied outside the repo.

## Why `app://` and not `file://`

`file://` breaks ES module resolution (docs/STEAM.md section 5). The scheme is
registered as `standard` + `secure` before app-ready, and the handler maps
`app://game/<path>` onto `dist/<path>`, rejecting anything that normalizes
outside `dist/`. `vite.config.js` carries `base: './'` so the built HTML asks
for assets by relative URL under that origin.

## Saves

One file, `<userData>/save.json`, written tmp+rename so a crash mid-write can
never leave a half save as the only copy. The first write of each session
copies the previous good file to `save.json.bak`. The renderer never touches
the filesystem: it calls `saveStore(json)` and the main process owns atomicity.

`loadStore()` is **synchronous** — the value is fetched once via `sendSync` at
preload time, because the game hydrates storage before its first system boots.
Do not make it async.

It answers `{ ok, raw }`, and the distinction is load-bearing:

| answer | meaning | renderer does |
|---|---|---|
| `{ ok: true, raw: null }` | `ENOENT` — no save file at all | first boot: migrate the browser-era localStorage out |
| `{ ok: true, raw: "…" }` | the file, read | hydrate from it |
| `{ ok: false }` | the file is there and could not be read | **nothing** — log, mirror later writes, leave the bytes alone |

Collapsing the last row into the first is how a save gets erased. `EBUSY` /
`EACCES` from Steam Cloud, an antivirus scan, or a backup agent holding the
handle is the ordinary case on Windows, and treating it as "first boot" writes
a snapshot of an empty localStorage over a real profile. An unparseable file is
the same story and takes the same path: no boot flush, so a human can still
repair it. Two more guards back this up in `main.mjs`: `store:save` refuses to
replace a non-empty `save.json` with an empty snapshot, and the once-per-session
`.bak` copy never shrinks what the backup already holds.

**One instance per userData.** `app.requestSingleInstanceLock()`; a second
launch quits and focuses the first. Each renderer writes a snapshot of its own
localStorage over the whole file, so two live instances clobber each other
wholesale rather than merging. Steam's client blocks a double launch, but the
deliverable is a double-clickable exe and that mitigation is not ours.

Set `TELLURIC_USERDATA` to relocate userData (probes, packaging tests):

```
$env:TELLURIC_USERDATA = "C:\some\scratch\dir"; npm run desktop:run
```

Default userData on Windows is `%APPDATA%/telluric-void`.

## GPU log

On ready the shell writes `<userData>/gpu-info.json` (`app.getGPUInfo('complete')`)
so the Optimus problem (docs/STEAM.md section 1) — which adapter Chromium
actually picked — is diagnosable from a player report.

## `backgroundThrottling: false`

Non-negotiable. This game is host-authoritative; a host whose renderer throttles
on alt-tab desyncs every client.

## Pinned versions

- **Electron `43.3.0`** — pinned exact (`--save-exact`), not a range.
- **Playwright `1.62.1`** — the version `tools/desktopprobe.mjs` drives it with.
- **electron-builder `26.15.3`** — pinned exact.

**The pair is verified.** Playwright `1.62.1`'s `_electron` driver launches
Electron `43.3.0` without hanging, in both probe modes: against
`desktop/main.mjs` in dev, and against the packed `TELLURIC VOID.exe` via
`--exe`. Eleven of eleven checks pass in each. No step-down was needed, and
this paragraph is the record that none is warranted at these versions.

Re-run both modes after any bump here — if `_electron.launch` ever hangs, the
fix is environmental, not code: step Electron down to the newest major
Playwright supports, re-pin exact, and record the reason here.

**Steam overlay warning (docs/STEAM.md):** overlay behaviour is not stable
across Electron majors. Re-test the overlay after every bump. Never bump
casually — a version change here is a change to a shipped compatibility
surface, not a dependency refresh.

### Overlay verification, Electron 43.3.0 (2026-08-13)

`desktop/main.mjs` calls `electronEnableSteamOverlay()` before `app.whenReady()`,
and **only** when `initSteam()` reported `available: true`. That call appends
`in-process-gpu` and `disable-direct-composition` and attaches a 60 Hz repaint
timer.

**VERDICT: PROVISIONAL — no capability failure *detected*, and the one
determinative check is still open.** Nothing found so far argues for an Electron
bump, and on that basis the invite path ships. But the fact the slice's STOP
clause actually turns on — whether the overlay *paints on screen* — was not
verified, and neither piece of evidence below is capable of falsifying it. Read
this section as "nothing is wrong yet", not as "the overlay works".

**To close it,** somebody with eyes on this machine must observe both of these
in one sitting of `npm run desktop`:

> Pressing **Shift+Tab** visibly draws the Steam overlay over the running game,
> and **Host via Steam -> Invite friend** on the co-op screen visibly opens
> Steam's friend-picker dialog on top of the game.

Task 4's two-seat checkpoint performs that exact gesture for real, so it costs
no extra sitting. **If either fails to appear, that is the capability failure
`docs/superpowers/plans/2026-08-12-steamworks-wiring.md`'s Global Constraints
call a STOP: do not ship the invite button, and put the Electron-bump decision
to the user.**

What the run on this box (RTX 2070, driver 32.0.15.9174) did establish:

- **The overlay hook injects.** `gameoverlayrenderer64.dll` is resident in the
  Electron renderer process with Steam running, so Electron 43.3.0 does not
  block the injection. Evidence: `reviews/round8/overlay/overlay-run.txt`.
  **This proves the hook loaded, not that it painted** — a fully non-compositing
  overlay would load the same DLL.
- **Rendering does not regress.** WebGL still reaches the discrete GPU:
  `ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 (0x00001F07) Direct3D11 vs_5_0 ps_5_0,
  D3D11)`, canvas 1584x861, title screen and the whole co-op screen render. The
  `electronEnableSteamOverlay(true)` fallback (which skips only the repaint
  timer) was therefore **not** needed.
- **`openInviteDialog()` returns success**, and the co-op screen advances through
  `Host via Steam` -> `Invite friend` against live Steam. **This is a bridge call
  that did not throw**; `overlayStatus.ok` only records that
  `electronEnableSteamOverlay()` itself did not throw. Neither says anything
  about a dialog appearing.
- **Why no screenshot settles it:** a background process cannot take the Windows
  foreground, so a screen grab captures whichever window is on top instead — on
  this box, during the attempt, the user's browser. It needs a human, not a
  better script.

**The cost: the support artifact, not the player-facing protection.** Be precise
about which of the two Optimus mitigations `in-process-gpu` affects, because
they are not the same mechanism and only one is hurt.

- **The in-game detect-and-warn path is UNAFFECTED.** `docs/STEAM.md` section 1
  names the mitigation as "log `WEBGL_debug_renderer_info` at startup and warn
  in-game", which is `src/core/GpuTier.js`'s `probeRenderer()` feeding
  `src/ui/GpuNotice.js`. That reads the string off the **live WebGL context in
  the renderer**, which `in-process-gpu` does not touch. Proven by this run's own
  capture, taken *with the overlay on*: `"renderer": "ANGLE (NVIDIA, NVIDIA
  GeForce RTX 2070 ...)"` (`reviews/round8/overlay/overlay-run.txt`). A
  Steam-present player on an Optimus laptop still gets the correct detection and
  the same warning as anybody else.
- **The `gpu-info.json` support dump is DEGRADED.** With the overlay off it is
  7049 bytes and names the adapter, driver version, GL/D3D strings and overlay
  support. With the overlay on it is 1248 bytes: `"glImplementationParts":
  "(gl=none,angle=none)"`, `"inProcessGpu": true`, `"initializationTime": 0`, and
  **the NVIDIA adapter entry is gone entirely**. That is `getGPUInfo('complete')`
  being unable to report on a GPU that is no longer in its own process. Rendering
  is unaffected.

So the real cost is: **a support engineer triaging a Steam player's GPU report
gets a near-empty `gpu-info.json`** and has to lean on the in-game notice and the
player's own description instead. It is not a loss of Optimus protection for
Steam players.

`TELLURIC_NO_OVERLAY=1` skips the `enableOverlay()` call and nothing else. It
exists so the pair of captures below stays re-derivable from this tree rather
than from a hand edit somebody made once, and it is a **developer tool, not a
field-recovery mechanism** — nobody sets an environment variable before
double-clicking a game in their Steam library, so do not offer it to a customer
as a way to produce a usable `gpu-info.json`. It cannot affect a real player
either way: the condition is `steamStatus.available && !TELLURIC_NO_OVERLAY`, so
with the variable unset (always, for a Steam Store launch) both the Steam-present
and Steam-absent paths are exactly what they were before the line existed. Both
captures are on disk: `reviews/round8/overlay/gpu-info-before.json`
(`TELLURIC_NO_OVERLAY=1`) and `reviews/round8/overlay/gpu-info-after.json`
(overlay on), same tree, same box, minutes apart, Steam running for both.

**Steam-absent `init()` costs 26 ms** (25.89 / 27.07 / 27.32 ms across three
runs with the Steam client actually shut down; ~110-157 ms when Steam is
running, 78 ms while Steam is starting but not yet signed in). Moving the call
before `app.whenReady()` therefore costs a Steam-less player about a fortieth of
a second, and no registry fast-path guard is warranted.
