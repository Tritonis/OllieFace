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
npm run desktop        # vite build, then electron .
npm run desktop:run    # electron . against the existing dist/ (probe loops)
```

Both call the local binary through npm scripts. Never `npx` — a bare `npx`
run in this repo once destroyed a package binding.

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
passes all eight checks against the packed build.

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
`--exe`. Eight of eight checks pass in each. No step-down was needed, and
this paragraph is the record that none is warranted at these versions.

Re-run both modes after any bump here — if `_electron.launch` ever hangs, the
fix is environmental, not code: step Electron down to the newest major
Playwright supports, re-pin exact, and record the reason here.

**Steam overlay warning (docs/STEAM.md):** overlay behaviour is not stable
across Electron majors. Re-test the overlay after every bump. Never bump
casually — a version change here is a change to a shipped compatibility
surface, not a dependency refresh.
