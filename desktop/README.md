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
- **Playwright `1.62.1`** — the version the Task 3 probe drives it with.

The `_electron` driver against a latest-stable Electron is an **unverified
pair** until Task 3 passes. If `_electron.launch` hangs there, the fix is
environmental, not code: step Electron down to the newest major Playwright
supports, re-pin exact, and record the reason here.

**Steam overlay warning (docs/STEAM.md):** overlay behaviour is not stable
across Electron majors. Re-test the overlay after every bump. Never bump
casually — a version change here is a change to a shipped compatibility
surface, not a dependency refresh.
