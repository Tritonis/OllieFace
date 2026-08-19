/**
 * The pause that is left when there are no menus.
 *
 * `Menus` is the pause screen, the death screen, settings, title, survivor
 * select and co-op — all of it. It is `static critical = false`, correctly: a
 * throw in a menu must not end a run. But six consecutive throws in one phase
 * drop it for the rest of the run and blank `ctx.menus`, and `ctx.paused` is
 * written in exactly one place in the whole tree that a player can reach —
 * `Menus.open()`. So a run that loses its menus stays playable and becomes
 * *uninterruptible*: no pause, no settings, no quit, no death screen. The
 * player's only exit is the window's close button.
 *
 * This is the exit of last resort. Deliberately not a second menu system: one
 * key, one plain box, two things to press. It is styled to look like the
 * fault report it is, not like the menus it stands in for.
 *
 * **Where it lives, and why not in a system.** Nothing here runs in a frame
 * phase. It is one `keydown` listener on the document, installed once at boot
 * beside `installSystemNotice`, so there is no host system whose disable could
 * take it with them — not `Menus`, and not `HUD` either, which is noncritical
 * for its own reasons and can be dropped by the same mechanism. A fallback
 * hosted inside a system that can be switched off is a fallback with the same
 * failure mode as the thing it insures.
 *
 * **Arbitration with Menus is absolute and one-directional:** every entry
 * point below returns immediately while `ctx.menus` is truthy. While the menus
 * are alive they own `ctx.paused` outright and this file writes nothing,
 * listens for nothing, and shows nothing. It does not touch Escape at all —
 * Escape is pointer-lock's, and `Menus` reads the resulting
 * `pointerlockchange` — so the two cannot fight over a key even in the window
 * where both are alive.
 */

/** The key that raises it. Chosen off the bound set entirely: not Escape, and
 *  not something a survivor is steering with. `SystemNotice` names it. */
export const FALLBACK_PAUSE_KEY = 'F8';
export const FALLBACK_PAUSE_LABEL = 'F8';

const CSS = `
.fallback-pause{position:fixed;inset:0;z-index:9999;display:flex;
 align-items:center;justify-content:center;
 background:rgba(8,7,12,.86);
 font:13px/1.6 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#ddd8e8}
.fallback-pause__box{max-width:440px;padding:18px 20px;box-sizing:border-box;
 background:#12101a;border:1px solid rgba(255,190,90,.35);border-left:3px solid #ffbe5a}
.fallback-pause__title{margin:0 0 8px;color:#ffbe5a;font-size:12px;
 letter-spacing:.06em;text-transform:uppercase}
.fallback-pause__body{margin:0 0 14px;color:#9aa4ac}
.fallback-pause__row{display:flex;gap:10px;flex-wrap:wrap}
.fallback-pause__btn{font:inherit;color:#ddd8e8;background:#1c1926;
 border:1px solid rgba(255,255,255,.2);padding:7px 14px;cursor:pointer}
.fallback-pause__btn:hover,.fallback-pause__btn:focus{border-color:#ffbe5a;outline:none}
`;

const TITLE = 'Emergency pause';
const BODY = 'The menus were switched off after repeated failures, so this is '
  + 'standing in for them. The run is frozen. Restarting reloads the game and '
  + 'ends this run.';

let overlay = null;
let styleInjected = false;

/** Are the menus gone? The single arbitration test — everything below asks it. */
export function fallbackPauseNeeded(ctx) { return !ctx?.menus; }

/** Is the emergency overlay currently up? */
export function fallbackPauseOpen() { return overlay !== null; }

/**
 * Freeze or unfreeze the world without `Menus`.
 *
 * Writes `ctx.paused` — the same flag `Menus.open()` writes and the same flag
 * `Engine`'s fixedUpdate loop gates on — and only ever while the menus are
 * absent, so the two writers cannot both be live.
 *
 * @param {object} ctx
 * @param {boolean} [want] - force a state; omitted, it toggles.
 * @param {Document|null} [doc] - injectable so the state half is testable with
 *   no DOM at all; the shipped call passes the real document.
 * @returns {boolean} the resulting paused state, or `ctx.paused` untouched if
 *   the menus are alive and this had no business acting.
 */
export function setFallbackPause(ctx, want, doc = globalThis.document ?? null) {
  if (!fallbackPauseNeeded(ctx)) return !!ctx?.paused;
  const next = want === undefined ? !ctx.paused : !!want;
  ctx.paused = next;
  // Give the stick back on resume, and take it away while frozen — `Menus`
  // does the same through its own screen state, which is gone.
  if (ctx.input) ctx.input.enabled = !next;
  if (next) showOverlay(ctx, doc); else hideOverlay();
  return next;
}

/**
 * End the run and start over. This is `Menus.act('restart')` and the pause
 * screen's `act('quit')` verbatim — both are `location.reload()` — reached
 * directly because the object that used to own that switch is gone.
 */
export function fallbackRestart(loc = globalThis.location ?? null) {
  loc?.reload?.();
}

function showOverlay(ctx, doc) {
  if (!doc || overlay) return;
  if (!styleInjected) {
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);
    styleInjected = true;
  }
  const box = doc.createElement('div');
  box.className = 'fallback-pause__box';
  const h = doc.createElement('p');
  h.className = 'fallback-pause__title';
  h.textContent = TITLE;
  const p = doc.createElement('p');
  p.className = 'fallback-pause__body';
  p.textContent = BODY;
  const row = doc.createElement('div');
  row.className = 'fallback-pause__row';

  const resume = doc.createElement('button');
  resume.className = 'fallback-pause__btn';
  resume.textContent = `Resume (${FALLBACK_PAUSE_LABEL})`;
  resume.addEventListener('click', () => setFallbackPause(ctx, false, doc));

  const restart = doc.createElement('button');
  restart.className = 'fallback-pause__btn';
  restart.textContent = 'Restart run';
  restart.addEventListener('click', () => fallbackRestart());

  row.appendChild(resume);
  row.appendChild(restart);
  box.appendChild(h); box.appendChild(p); box.appendChild(row);

  overlay = doc.createElement('div');
  overlay.className = 'fallback-pause';
  overlay.appendChild(box);
  doc.body.appendChild(overlay);
  resume.focus?.();
}

function hideOverlay() {
  overlay?.remove();
  overlay = null;
}

/** For tests and anything restarting a page-level run. */
export function clearFallbackPause() { hideOverlay(); }

/**
 * Listen for the key. Returns an unsubscribe handle, matching
 * `installSystemNotice`.
 */
export function installFallbackPause(ctx, doc = globalThis.document ?? null) {
  const onKey = (e) => {
    if (e.key !== FALLBACK_PAUSE_KEY) return;
    // The menus are alive: theirs, not ours. Not even a preventDefault.
    if (!fallbackPauseNeeded(ctx)) return;
    e.preventDefault?.();
    setFallbackPause(ctx, undefined, doc);
  };
  doc?.addEventListener('keydown', onKey);
  return () => doc?.removeEventListener('keydown', onKey);
}
