/**
 * The confirmation for a friend's Steam "Join game" click. (Important 4.)
 *
 * That invite used to run unconditionally: mid single-player run or already
 * networked, `Menus.bindSteam`'s handler discarded whatever the player was
 * doing with no confirmation and no way to say no. The decision is to never
 * hijack an in-progress session silently — surface the invite as an explicit,
 * dismissible prompt and only act on Accept.
 *
 * This is `GpuNotice.js`'s own idiom, not a new one: a fixed banner appended
 * straight to `document.body` (so it reaches the player over any menu screen
 * or none — the same reason `GpuNotice` does it), the same instrument-panel
 * language (monospace, dark panel, teal accent border), self-contained CSS
 * injected once. It differs only where the decision requires it to: two
 * buttons instead of a bare dismiss, because "do nothing" here must mean
 * Decline, not silently expire.
 *
 * FIX ROUND 2 (re-review): accepting is not always a real choice. When the
 * player is already networked (`SteamLobby.steamInviteBlocked`), the join
 * would refuse outright no matter what they click — there is no trade to
 * confirm, only a fact to report. `actionable: false` swaps the two buttons
 * for one dismiss, so the banner never dangles a "Join" button in front of a
 * gesture that cannot succeed.
 */

const CSS = `
.steam-invite-notice{position:fixed;left:50%;top:26px;transform:translateX(-50%);
 z-index:9999;max-width:min(520px,calc(100vw - 32px));
 display:flex;gap:14px;align-items:center;
 padding:14px 16px;box-sizing:border-box;
 background:rgba(10,14,20,.94);color:#d8e2ea;
 border:1px solid rgba(120,200,220,.30);border-left:3px solid #39d6d2;
 font:13px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;
 box-shadow:0 10px 40px rgba(0,0,0,.6);
 animation:steam-invite-notice-in .35s ease-out both}
@keyframes steam-invite-notice-in{from{opacity:0;transform:translate(-50%,-10px)}
 to{opacity:1;transform:translate(-50%,0)}}
.steam-invite-notice__body{flex:1;min-width:0}
.steam-invite-notice__title{color:#39d6d2;letter-spacing:.06em;text-transform:uppercase;
 font-size:11px;margin:0 0 6px}
.steam-invite-notice p{margin:0}
.steam-invite-notice__actions{display:flex;gap:8px;flex:0 0 auto}
.steam-invite-notice button{background:none;border:1px solid rgba(216,226,234,.25);
 color:#d8e2ea;cursor:pointer;font:inherit;line-height:1;padding:6px 12px}
.steam-invite-notice__accept{border-color:#39d6d2;color:#39d6d2}
.steam-invite-notice__accept:hover{background:rgba(57,214,210,.12)}
.steam-invite-notice__decline:hover,.steam-invite-notice__ok:hover{border-color:#d8e2ea}
`;

let styleInjected = false;
// At most one on screen: a second invite while the first is still up replaces
// it rather than stacking banners the player has to clear one at a time.
let current = null;

const DEFAULT_BODY = "A friend wants you to join their game. Joining leaves what you're doing now.";

/**
 * @param {{
 *   body?: string,
 *   actionable?: boolean,
 *   onAccept?: () => void,
 *   onDecline?: () => void,
 * }} opts - `actionable: false` renders a single dismiss button (no Accept
 *   semantics) for the case where accepting cannot succeed; `onDecline` still
 *   fires on dismiss either way, so a caller can treat both uniformly.
 * @returns {HTMLElement}
 */
export function showSteamInviteNotice({ body = DEFAULT_BODY, actionable = true, onAccept, onDecline } = {}) {
  current?.remove();

  if (!styleInjected) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  const el = document.createElement('div');
  el.className = 'steam-invite-notice';
  const actionsHtml = actionable
    ? `<button class="steam-invite-notice__decline" type="button">Decline</button>
       <button class="steam-invite-notice__accept" type="button">Join</button>`
    : `<button class="steam-invite-notice__ok" type="button">OK</button>`;
  el.innerHTML = `
    <div class="steam-invite-notice__body">
      <p class="steam-invite-notice__title">Steam invite</p>
      <p></p>
    </div>
    <div class="steam-invite-notice__actions">${actionsHtml}</div>`;
  // textContent, not interpolation: same discipline as `GpuNotice.js` even
  // though every caller today passes a literal -- the field exists so a
  // future caller cannot turn it into an innerHTML hole by accident.
  el.querySelector('.steam-invite-notice__body p:last-child').textContent = body;

  const dismiss = () => { el.remove(); if (current === el) current = null; };
  if (actionable) {
    el.querySelector('.steam-invite-notice__accept').addEventListener('click', () => { dismiss(); onAccept?.(); });
    el.querySelector('.steam-invite-notice__decline').addEventListener('click', () => { dismiss(); onDecline?.(); });
  } else {
    el.querySelector('.steam-invite-notice__ok').addEventListener('click', () => { dismiss(); onDecline?.(); });
  }

  document.body.appendChild(el);
  current = el;
  return el;
}
