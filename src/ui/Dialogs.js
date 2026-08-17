/**
 * The assistive-technology layer for the menu overlays (#45).
 *
 * The menus have had keyboard and gamepad navigation for a long time, but that
 * navigation is a *painted ring* — a class on a div — and a screen reader can
 * see none of it. To an AT user the overlay was an anonymous stack of divs over
 * a canvas, with the tab ring free to walk straight past the open panel into
 * the game underneath.
 *
 * Everything here is deliberately free of `document` at module scope and takes
 * its element-likes as arguments, because this repo has no jsdom and the tests
 * drive these functions on hand-built stubs.
 */

/**
 * Anything a browser would put in the tab order, less the things this codebase
 * disables in place (`[disabled]`, `[hidden]`) or hides behind a class.
 */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]),'
  + ' textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Give one `<section class="screen">` its dialog semantics.
 *
 * `aria-labelledby` where the panel has a heading — the heading is the name a
 * sighted player reads, so it is the name the screen reader should say — and a
 * plain `aria-label` fallback off `data-screen` for the two screens (title,
 * pause) whose name is not carried by an `h1`/`h2`.
 */
export function markDialog(el) {
  if (!el) return null;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  const head = el.querySelector?.('h1, h2');
  if (head) {
    let id = head.getAttribute?.('id');
    if (!id) {
      id = `dlg-${el.dataset?.screen || 'screen'}`;
      head.setAttribute('id', id);
    }
    el.setAttribute('aria-labelledby', id);
    return id;
  }
  const name = el.dataset?.screen || 'menu';
  el.setAttribute('aria-label', `${name[0].toUpperCase()}${name.slice(1)} menu`);
  return null;
}

/** Every focusable control inside `el`, in DOM order. */
export function focusablesIn(el) {
  if (!el?.querySelectorAll) return [];
  return [...el.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && !n.hidden);
}

/**
 * Where Tab should land, given the open panel and what currently has focus.
 *
 * Returns the element to focus, or `null` when the browser's own default is
 * already correct (mid-list moves). The two cases that are NOT correct by
 * default are the ends: forwards off the last control and backwards off the
 * first both walk out of the dialog and into the canvas behind it. Focus that
 * is not inside the dialog at all is pulled back to the first control, which is
 * what makes this a trap rather than a wrap.
 */
export function trapTab(el, active, shift = false) {
  const list = focusablesIn(el);
  if (!list.length) return null;
  const i = list.indexOf(active);
  if (i < 0) return list[0];
  if (!shift && i === list.length - 1) return list[0];
  if (shift && i === 0) return list[list.length - 1];
  return null;
}

/**
 * Wire the trap to a real keydown stream.
 *
 * Split out from `Menus` so a test can hand it a stub document, capture the
 * listener and press Tab at both edges — the trap silently not cycling is
 * exactly the shape of guard this repo keeps catching, so it has to be driven
 * through the same path the browser uses rather than asserted on in isolation.
 */
export function installFocusTrap(menus, doc) {
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const el = menus.screens?.[menus.screen];
    if (!el) return;
    const next = trapTab(el, doc.activeElement, !!e.shiftKey);
    if (!next) return;
    e.preventDefault?.();
    next.focus?.();
  };
  doc.addEventListener('keydown', handler);
  return handler;
}
