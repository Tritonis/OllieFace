/**
 * The one thing on screen that says the disk is not taking the save.
 *
 * Before this existed, a failed write went to `console.error` in the main
 * process and to `console.error` in the renderer, and the run carried on as if
 * nothing had happened. A player whose save file is locked by a cloud sync or
 * refused by a full disk finished the run, quit, and found the evening gone,
 * with the only record of why in a devtools console they never opened. That is
 * the failure mode this module exists to close: not to fix the write, but to
 * make the player's next decision — keep playing, or quit and go look at the
 * disk — an informed one.
 *
 * Deliberately small and deliberately not a modal. Interrupting play to
 * announce a failed background write would punish the player twice for one
 * disk fault, and there is nothing for them to click that would help. So: a
 * corner strip, out of the play area, that stays up for as long as the claim
 * on it is true.
 *
 * It has no dismiss button, and that is the decision, not an omission. A
 * dismissible warning about silent data loss becomes a silent data loss again
 * the moment it is dismissed, and the state it reports is not one the player
 * can acknowledge away. It clears exactly when it stops being true — on the
 * next successful write — because the sentence it prints ("not being written
 * to disk") is then false, and a warning that outlives its own truth teaches
 * the player to ignore the next one.
 *
 * Same instrument-panel idiom as `GpuNotice.js` and `SteamInviteNotice.js`: a
 * fixed element appended to `document.body` with its own CSS injected once, so
 * it reaches the player over a menu screen or over the game with equal ease.
 * Built element by element rather than through `innerHTML` because the reason
 * string is an OS error message arriving over IPC.
 */

const CSS = `
.save-indicator{position:fixed;left:16px;bottom:16px;z-index:9998;
 max-width:min(420px,calc(100vw - 32px));
 padding:10px 13px;box-sizing:border-box;
 background:rgba(20,10,10,.94);color:#e8d8d8;
 border:1px solid rgba(255,120,90,.30);border-left:3px solid #ff6a4a;
 font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;
 box-shadow:0 10px 40px rgba(0,0,0,.6);
 animation:save-indicator-in .35s ease-out both}
@keyframes save-indicator-in{from{opacity:0;transform:translateY(10px)}
 to{opacity:1;transform:translateY(0)}}
.save-indicator__title{color:#ff6a4a;letter-spacing:.06em;text-transform:uppercase;
 font-size:11px;margin:0 0 4px}
.save-indicator__body{margin:0}
.save-indicator__reason{display:block;margin-top:4px;color:#9aa4ac}
`;

const TITLE = 'Save failed';
const BODY = 'Your progress is not being written to disk. The game keeps running, '
  + 'but anything since the last good save will be lost when you quit.';

let styleInjected = false;
/** The live element, or null. At most one: repeated failures update the reason
 *  line in place rather than stacking a strip per failed write. */
let current = null;
/** The reason line inside `current`, held directly. The alternative is finding
 *  it again on each update — by selector, which would widen what this module
 *  needs from a document, or by child index, which is a silent breakage the
 *  first time anyone adds a paragraph above it. A reference is neither. */
let reasonNode = null;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Show the indicator, or update the reason on the one already up.
 *
 * @param {string|null} reason - the underlying failure, shown muted beneath the
 *   sentence. It comes from an OS errno, so it is set as text, never markup.
 * @returns {HTMLElement}
 */
export function showSaveFailure(reason = null) {
  if (!styleInjected) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  if (!current) {
    const box = el('div', 'save-indicator');
    box.appendChild(el('p', 'save-indicator__title', TITLE));
    const body = el('p', 'save-indicator__body', BODY);
    reasonNode = body.appendChild(el('span', 'save-indicator__reason', ''));
    box.appendChild(body);
    document.body.appendChild(box);
    current = box;
  }
  reasonNode.textContent = reason ? String(reason) : '';
  return current;
}

/** Take the indicator down. Idempotent: called after every successful save. */
export function clearSaveFailure() {
  current?.remove();
  current = null;
  reasonNode = null;
}

/** The live element, or null. For tests and for anything that needs to know
 *  whether the player is currently being warned. */
export function saveFailureElement() { return current; }
