/**
 * What the player sees when the Engine gives up on a noncritical system.
 *
 * A noncritical failure is by definition survivable, so nothing stops and there
 * is no overlay to raise. But "survivable" is not "invisible": when `Audio` is
 * dropped the game goes silent, when `VFX` is dropped nothing explodes, and a
 * player who is told neither concludes the game is broken in some way they
 * cannot describe. The disable is the right call — six failed calls in a row is
 * a system that will not come back, and calling it sixty times a second for the
 * rest of the run only burns stack unwinds — but a silent disable trades a loud
 * fault for a quiet one.
 *
 * So this is the other half of that decision. Same instrument-panel idiom as
 * `SaveIndicator.js` and `GpuNotice.js`: a corner strip, out of the play area,
 * that names the system and says the run is continuing without it. Not a modal
 * — there is nothing to click that would bring the system back, and interrupting
 * play to announce a lost particle system punishes the player for the fault.
 *
 * Several systems can fail in one run, so the strip lists them rather than
 * stacking one box per system. It has no dismiss button for the same reason
 * `SaveIndicator` has none: the state it reports stays true for the rest of the
 * run.
 *
 * Built element by element rather than through `innerHTML`, because a system
 * name and an exception message are not markup this page gets to trust.
 */

import { FALLBACK_PAUSE_LABEL } from './FallbackPause.js';

const CSS = `
.system-notice{position:fixed;right:16px;bottom:16px;z-index:9997;
 max-width:min(420px,calc(100vw - 32px));
 padding:10px 13px;box-sizing:border-box;
 background:rgba(14,12,20,.94);color:#ddd8e8;
 border:1px solid rgba(255,190,90,.30);border-left:3px solid #ffbe5a;
 font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;
 box-shadow:0 10px 40px rgba(0,0,0,.6);
 animation:system-notice-in .35s ease-out both}
@keyframes system-notice-in{from{opacity:0;transform:translateY(10px)}
 to{opacity:1;transform:translateY(0)}}
.system-notice__title{color:#ffbe5a;letter-spacing:.06em;text-transform:uppercase;
 font-size:11px;margin:0 0 4px}
.system-notice__body{margin:0 0 4px}
.system-notice__list{margin:0;padding-left:16px;color:#9aa4ac}
.system-notice__recovery{margin:6px 0 0;color:#ffbe5a}
`;

const TITLE = 'A system was switched off';
// Only shown when the system that went is `Menus`, because only then is there
// nothing left to press. See `ui/FallbackPause.js`.
const MENUS_LINE = `The menus are gone with it: press ${FALLBACK_PAUSE_LABEL} to pause, resume or restart.`;
const BODY = 'It failed on every frame, so the game stopped running it. The run '
  + 'continues, but whatever it was responsible for is gone until you restart.';

let styleInjected = false;
/** The live element, or null. At most one — a second disabled system adds a
 *  line rather than a second strip. */
let current = null;
let listNode = null;
/** The "press F8" line, added once and only when it is the menus that went. */
let recoveryNode = null;
/** Names already listed, so a repeat cannot double an entry. */
const listed = new Set();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Subscribe to the Engine's `systemDisabled`. Returns the unsubscribe handle,
 * matching `installFatalOverlay`.
 */
export function installSystemNotice(ctx) {
  return ctx.events.on('systemDisabled', (entry) => showSystemDisabled(entry));
}

/**
 * Show the strip, or add a line to the one already up.
 *
 * @param {{name?:string, who?:string, message?:string}} entry - as emitted by
 *   `Engine._noteFailure`.
 * @returns {HTMLElement}
 */
export function showSystemDisabled(entry) {
  if (!styleInjected) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  if (!current) {
    const box = el('div', 'system-notice');
    box.appendChild(el('p', 'system-notice__title', TITLE));
    box.appendChild(el('p', 'system-notice__body', BODY));
    listNode = box.appendChild(el('ul', 'system-notice__list'));
    document.body.appendChild(box);
    current = box;
  }

  const name = entry?.name || entry?.who || 'a system';
  if (!listed.has(name)) {
    listed.add(name);
    const message = entry?.message ? ` — ${entry.message}` : '';
    listNode.appendChild(el('li', null, `${name}${message}`));
  }
  if (name === 'Menus' && !recoveryNode) {
    recoveryNode = current.appendChild(el('p', 'system-notice__recovery', MENUS_LINE));
  }
  return current;
}

/** Take the strip down. For tests, and for anything that restarts a page-level run. */
export function clearSystemNotices() {
  current?.remove();
  current = null;
  listNode = null;
  recoveryNode = null;
  listed.clear();
}

/** The live element, or null. */
export function systemNoticeElement() { return current; }
