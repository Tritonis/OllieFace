/**
 * A one-time banner shown when the game is running on integrated graphics.
 *
 * This is not a nag. On a switchable-graphics laptop the browser decides which
 * adapter its GPU process uses before any page script runs, and nothing the
 * game can do at runtime will move it — `powerPreference: 'high-performance'`
 * is a hint consulted at process launch, not per context. Measured on the
 * development machine, the same frame costs 5.8fps on the Intel UHD 630 and
 * 80fps on the GTX 1660 Ti sitting idle beside it.
 *
 * So the player can be handed a two-click fix worth 14x, or left to conclude
 * the game is badly optimised. The banner is the difference between those.
 * Dismissal is remembered, and it never appears on a discrete adapter.
 */

import { adoptLegacyKey } from '../core/LegacyStorage.js';

const STORE_KEY = 'telluric.gpuNoticeDismissed';

/** The pre-rename key. A player who dismissed this once must not see it again. */
const LEGACY_STORE_KEY = 'petrichor.gpuNoticeDismissed';

const CSS = `
.gpu-notice{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
 z-index:9999;max-width:min(680px,calc(100vw - 32px));
 display:flex;gap:14px;align-items:flex-start;
 padding:14px 16px;box-sizing:border-box;
 background:rgba(10,14,20,.94);color:#d8e2ea;
 border:1px solid rgba(120,200,220,.30);border-left:3px solid #39d6d2;
 font:13px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;
 box-shadow:0 10px 40px rgba(0,0,0,.6);
 animation:gpu-notice-in .35s ease-out both;
 pointer-events:none}
@keyframes gpu-notice-in{from{opacity:0;transform:translate(-50%,10px)}
 to{opacity:1;transform:translate(-50%,0)}}
.gpu-notice__body{flex:1;min-width:0}
.gpu-notice__title{color:#39d6d2;letter-spacing:.06em;text-transform:uppercase;
 font-size:11px;margin:0 0 6px}
.gpu-notice p{margin:0 0 6px}
.gpu-notice ol{margin:6px 0 0;padding-left:18px}
.gpu-notice li{margin:2px 0}
.gpu-notice code{color:#ffd9a0;background:rgba(255,217,160,.08);padding:0 4px}
.gpu-notice__gpu{color:#ff9a6a}
.gpu-notice__x{flex:0 0 auto;background:none;border:1px solid rgba(216,226,234,.25);
 color:#d8e2ea;cursor:pointer;font:inherit;line-height:1;padding:4px 9px;
 pointer-events:auto}
.gpu-notice__x:hover{border-color:#39d6d2;color:#39d6d2}
`;

export function maybeShowGpuNotice(gpu) {
  if (!gpu?.integrated) return null;
  try { if (adoptLegacyKey(STORE_KEY, LEGACY_STORE_KEY, localStorage)) return null; } catch { /* private mode */ }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'gpu-notice';
  el.innerHTML = `
    <div class="gpu-notice__body">
      <p class="gpu-notice__title">Running on integrated graphics</p>
      <p>This browser is rendering on <span class="gpu-notice__gpu"></span>, not your
         discrete GPU. Expect roughly <strong>10x lower framerate</strong> until that changes —
         the page cannot switch adapters on its own.</p>
      <ol>
        <li>Windows <code>Settings &gt; Display &gt; Graphics</code></li>
        <li>Add or select your browser, choose <code>High performance</code></li>
        <li>Quit the browser completely and reopen it</li>
      </ol>
    </div>
    <button class="gpu-notice__x" title="Dismiss">&times;</button>`;
  // textContent, not interpolation: the adapter string comes from the driver
  // and goes straight into the DOM.
  el.querySelector('.gpu-notice__gpu').textContent = gpu.name;

  el.querySelector('.gpu-notice__x').addEventListener('click', () => {
    try { localStorage.setItem(STORE_KEY, '1'); } catch { /* private mode */ }
    el.remove();
  });

  document.body.appendChild(el);
  return el;
}
