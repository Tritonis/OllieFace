/**
 * What the player sees when a critical system fails.
 *
 * The Engine stops the frame loop the first time a system it cannot do without
 * throws (see `isCriticalSystem`). Stopping is the right call — a run that
 * keeps going after its damage authority died is a run that has quietly stopped
 * being the game — but on its own it leaves a frozen canvas and no account of
 * itself, which is not obviously better than the broken run it replaced.
 *
 * So this is the other half of the decision, not a decoration on it: name the
 * system, name the frame, and give the player the one action that can possibly
 * help. The text is deliberately plain about what happened; a player who is
 * told the run stopped on purpose will report it, and a player shown nothing
 * will conclude the game hung.
 */
import { restartRun } from '../core/restartRun.js';

const CSS = `
.fatal-overlay{position:fixed;inset:0;z-index:10000;
 display:flex;align-items:center;justify-content:center;
 background:rgba(6,8,11,.90);backdrop-filter:blur(3px);
 font:14px/1.6 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#d8e2ea}
.fatal-overlay__box{max-width:min(620px,calc(100vw - 40px));box-sizing:border-box;
 padding:22px 24px;background:rgba(12,16,22,.98);
 border:1px solid rgba(255,110,90,.35);border-left:3px solid #ff6e5a;
 box-shadow:0 18px 60px rgba(0,0,0,.7)}
.fatal-overlay__title{color:#ff6e5a;letter-spacing:.08em;text-transform:uppercase;
 font-size:11px;margin:0 0 10px}
.fatal-overlay p{margin:0 0 10px}
.fatal-overlay__code{color:#ffd9a0;background:rgba(255,217,160,.08);padding:1px 5px;
 word-break:break-word}
.fatal-overlay__msg{color:#9fb0bd;font-size:12px;margin:0 0 16px;word-break:break-word}
.fatal-overlay__btn{background:none;border:1px solid rgba(216,226,234,.3);
 color:#d8e2ea;cursor:pointer;font:inherit;padding:7px 16px}
.fatal-overlay__btn:hover{border-color:#ff6e5a;color:#ff6e5a}
`;

/**
 * Subscribe to the Engine's `fatalError`. Returns the unsubscribe handle so a
 * test — or a second page-level owner, should there ever be one — can take it
 * back off the bus.
 */
export function installFatalOverlay(ctx) {
  return ctx.events.on('fatalError', (entry) => showFatalOverlay(entry));
}

export function showFatalOverlay(entry) {
  // Once. A second call could only come from a second halt, and the Engine
  // halts at most once, but the guard costs nothing and the alternative is a
  // stack of identical boxes if that ever stops being true.
  if (document.querySelector('.fatal-overlay')) return null;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'fatal-overlay';
  el.innerHTML = `
    <div class="fatal-overlay__box">
      <p class="fatal-overlay__title">The run has stopped</p>
      <p>A system the run depends on failed, so the game stopped rather than
         carry on simulating something it can no longer vouch for.</p>
      <p>Failed in <span class="fatal-overlay__code"></span> on frame
         <span class="fatal-overlay__frame"></span>.</p>
      <p class="fatal-overlay__msg"></p>
      <button class="fatal-overlay__btn">Reload</button>
    </div>`;
  // textContent throughout: every one of these came out of an exception, and an
  // exception message is not markup this page gets to trust.
  el.querySelector('.fatal-overlay__code').textContent = entry?.who ?? 'unknown';
  el.querySelector('.fatal-overlay__frame').textContent = String(entry?.frame ?? -1);
  el.querySelector('.fatal-overlay__msg').textContent = entry?.message ?? '';
  el.querySelector('.fatal-overlay__btn').addEventListener('click', () => restartRun());

  document.body.appendChild(el);
  return el;
}
