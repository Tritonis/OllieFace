/**
 * "Restart run" must actually restart, in the shell as well as the browser.
 *
 *   node tests/restart-run.test.mjs
 *
 * What this CAN prove: that the decision `restartRun` makes is the bridge when
 * the shell lends one and `location.reload()` when it does not, and that the
 * three call sites in `src/ui` route through that decision instead of calling
 * `location.reload()` themselves — which is the shape of #136, where a page
 * that reloads itself is silently blocked by the window's `will-navigate`
 * denial.
 *
 * What it CANNOT prove, and does not claim: that Electron lets a
 * main-initiated `webContents.reload()` through the denial, or that the Steam
 * teardown still fires. Nothing in plain node can. That half is
 * `tools/desktopprobe.mjs`'s sentinel arm, which boots the real shell.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartRun } from '../src/core/restartRun.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, '..', rel), 'utf8');
// Comments talk ABOUT `location.reload()` in all three of these files now —
// that is the point of the fix being documented. Only code counts.
const code = (rel) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('\n-- the shell bridge wins when it is there');
{
  let bridged = 0, located = 0;
  const took = restartRun({ reload: () => { bridged++; } }, { reload: () => { located++; } });
  ok(bridged === 1 && located === 0, 'the shell is asked to reload, the page does not navigate itself');
  ok(took === 'bridge', `and it says which path it took (${took})`);
}

console.log('\n-- the browser path is unchanged');
{
  let located = 0;
  const took = restartRun(undefined, { reload: () => { located++; } });
  ok(located === 1 && took === 'location', 'no bridge: plain location.reload()');

  // A shell that exposes a store bridge but no reload (an older preload against
  // a newer page) must still restart rather than doing nothing at all.
  let l2 = 0;
  restartRun({ loadStore: () => ({}) }, { reload: () => { l2++; } });
  ok(l2 === 1, 'a bridge without reload falls back rather than swallowing the restart');
}

console.log('\n-- nothing to reload is not a crash');
{
  restartRun(null, null);
  restartRun({}, {});
  ok(true, 'no bridge and no location: returns rather than throwing');
}

console.log('\n-- no UI call site reloads the page itself');
{
  // The regression guard proper. Before the fix each of these read
  // `location.reload()` and each was dead in the packaged shell. Asserted as
  // absence of the literal, so re-introducing one anywhere in these files goes
  // red even if `restartRun` is still imported beside it.
  for (const f of ['src/ui/Menus.js', 'src/ui/FallbackPause.js', 'src/ui/FatalOverlay.js']) {
    ok(!/location\s*\.\s*reload\s*\(/.test(code(f)), `${f} does not call location.reload() directly`);
    ok(src(f).includes('restartRun'), `${f} routes its restart through restartRun`);
  }
}

console.log('\n-- the shell half of the wiring is present');
{
  const preload = src('desktop/preload.cjs');
  ok(/reload:\s*\(\)\s*=>\s*\{\s*ipcRenderer\.send\('shell:reload'\)/.test(preload),
    'preload exposes __DESKTOP__.reload over shell:reload');

  const main = src('desktop/main.mjs');
  ok(/ipcMain\.on\('shell:reload'/.test(main), 'main listens on shell:reload');
  ok(/wc\.reload\(\)/.test(main), 'and answers it with a main-initiated webContents.reload()');
  // The teardown that hangs off did-start-navigation is what a reload must not
  // lose; #136's fix moves the reload but must not move that.
  ok(/did-start-navigation[\s\S]{0,200}releaseAllSteamState/.test(main),
    'did-start-navigation still releases the Steam lobby, pump and callbacks');
  // The comment that made the bug invisible for a release.
  ok(!/`will-navigate` never fires for a reload/.test(main),
    'the false claim that will-navigate never fires for a reload is gone');
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
