/**
 * Start the run over by reloading the page.
 *
 * In a browser `location.reload()` is the whole story. In the packaged Electron
 * shell it is a no-op: `desktop/main.mjs` installs a `will-navigate` blocker to
 * keep the preload-bearing window on `app://`, and Chromium DOES route a
 * renderer-initiated reload through `will-navigate` — so the preventDefault
 * swallowed every "Restart run" in the shipped build (#136). The shell answers
 * that by lending the page `__DESKTOP__.reload()`, which asks MAIN to call
 * `webContents.reload()`; a main-initiated reload is not renderer navigation
 * and is not blocked, while `did-start-navigation` still fires, so the Steam
 * lobby, the pump and both callback handles are still released on the way out.
 *
 * The bridge is preferred when present; the browser path is unchanged.
 *
 * @returns {'bridge'|'location'} which path was taken — the probe reads this.
 */
export function restartRun(
  bridge = globalThis.__DESKTOP__,
  loc = globalThis.location ?? null,
) {
  if (typeof bridge?.reload === 'function') { bridge.reload(); return 'bridge'; }
  loc?.reload?.();
  return 'location';
}
