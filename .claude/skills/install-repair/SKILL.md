---
name: install-repair
description: Diagnose and repair a broken npm install in this repo — use when a local binary "isn't found", node_modules/.bin is nearly empty, npm install aborts (koffi/CMake failure or EBUSY on electron), or the build arm fails against a suspect tree.
---

# Install health

`node_modules/.bin` is the thing to check when a local binary "isn't found". A healthy tree here has
**~87 entries**; anything in the single digits means an `npm install` aborted partway, because npm
links bins at the *end* of reify. On 2026-08-16 (#83) it held exactly two — hand-written `vite`
shims an agent had added to unblock the build arm — which meant `gates:cheap`'s build arm had only
ever been observed green against a fake binding, and `npm run desktop` / `desktop:pack` were broken
outright. **Never hand-write a `.bin` shim.** npm's are ~14 lines with a `find_dp0` preamble; a
two-line `exec node ../vite/bin/vite.js` is a forgery, and it hides the real fault.

Two failure modes abort install here, both seen in the same session:

- **koffi builds from source and dies on missing CMake.** `koffi` ships its native binary as an
  optional per-platform package (`@koromix/koffi-win32-x64`). If that package is absent,
  `cnoke.cjs` falls back to a source build, cannot find CMake, and takes the whole install down
  before any bin is linked. Check `node_modules/@koromix/` exists; there is no CMake on this box and
  there does not need to be.
- **A zombie Electron holds `dist/resources/default_app.asar`,** and install fails `EBUSY` renaming
  it. The one on 2026-08-16 was three days old, orphaned from a Playwright desktop run. It is
  properly dead — `Get-Process` lists it but both `Stop-Process` and `taskkill /F` report *"no
  running instance of the task"*. What actually clears it is CIM:
  `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Invoke-CimMethod -MethodName Terminate`.

Repair is plain `npm install` once both are cleared — `npm rebuild` is not enough, since it hits the
same koffi wall. Confirm afterwards that the postinstall line (`> install-electron`) appeared in the
output, and that `@rolldown/binding-win32-x64-msvc/package.json` still exists.
