/**
 * Every accepted Steam invite reaches a page that is listening, or waits.
 *
 *   node tests/desktop-join-delivery.test.mjs
 *
 * Integration review wave 2, MAJOR (#54): the fix that taught the launch-args
 * route to park before the renderer subscribes left the *callback 333* route
 * pushing straight at `webContents.send`. That route is registered inside
 * `registerSteamBridge()`, which `desktop/main.mjs` calls BEFORE
 * `app.whenReady()` — so it can fire with no window at all, and routinely fires
 * while the bundle is still loading. `pushToRenderer` no-ops without a window
 * and a send into a page with no subscription is discarded, so the invite was
 * lost with nothing parked and `steam:pending-join` answered null forever.
 *
 * `desktop/join-delivery.mjs` is the seam that ends the difference between the
 * three routes: they all call `offer()`, and whether that pushes or parks is
 * one decision made in one place. It imports nothing — not Electron, not the
 * Binding — which is what makes the decision provable here in plain node.
 *
 * The four facts under test are the four the fix has to hold:
 *   - fired before a window exists -> parked, not pushed;
 *   - fired before the renderer subscribes -> parked, even with a live window;
 *   - fired after -> pushed live;
 *   - and a parked id is handed over exactly once, on either side of a reload.
 */
import { readFileSync } from 'node:fs';
import { createJoinDelivery } from '../desktop/join-delivery.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const ID = '109775241996081388';
const ID2 = '109775241996081389';

/** A stand-in for the pair `main.mjs` supplies: the push, and the window. */
function rig({ alive = true, initial = null } = {}) {
  const pushed = [];
  const d = createJoinDelivery({
    push: (lobbyId) => pushed.push(lobbyId),
    windowAlive: () => alive,
    initial,
  });
  return { d, pushed, kill() { alive = false; }, revive() { alive = true; } };
}

console.log('-- an invite that arrives before the page is listening');
{
  // Callback 333 during boot: registerSteamBridge runs before whenReady, so
  // there is no window and never was.
  const { d, pushed } = rig({ alive: false });
  ok(d.offer(ID) === 'parked', 'with no window at all it parks');
  ok(pushed.length === 0, 'and pushes nothing into the void');
  ok(d.state.parked === ID, 'the id is held, not dropped -- this is the whole bug');
  ok(d.collect() === ID, 'and the renderer collects it the moment it asks');
}
{
  // The nastier half: the window EXISTS but the bundle has not run bindSteam,
  // so nothing is subscribed. A window is not a listener.
  const { d, pushed } = rig({ alive: true });
  ok(d.offer(ID) === 'parked', 'a live window is not enough -- it still parks');
  ok(pushed.length === 0, 'because a send into an unsubscribed page is discarded, not queued');
  ok(d.collect() === ID, 'and it survives to the collect');
}

console.log('\n-- an invite that arrives after the renderer has subscribed');
{
  const { d, pushed } = rig();
  ok(d.collect() === null, 'a cold start collects nothing');
  ok(d.state.subscribed === true, 'but the ask itself is what proves a page is listening');
  ok(d.offer(ID) === 'pushed', 'so the next invite goes live');
  ok(pushed.join() === ID, 'to the renderer, once');
  ok(d.state.parked === null, 'and is NOT also parked -- a push plus a park is the same lobby joined twice');
  ok(d.collect() === null, 'which a later collect confirms');
}

console.log('\n-- a window that dies after the subscription did not');
{
  const r = rig();
  r.d.collect();
  r.kill();
  ok(r.d.offer(ID) === 'parked', 'a destroyed window parks even while subscribed -- pushToRenderer would no-op');
  ok(r.pushed.length === 0, 'nothing was pushed at a dead window');
  r.revive();
  ok(r.d.collect() === ID, 'and the id is still there when a page comes back');
}

console.log('\n-- exactly once, and the newest one');
{
  const { d } = rig({ initial: ID });
  ok(d.state.parked === ID, 'a +connect_lobby launch is parked from the first line of the module');
  ok(d.collect() === ID, 'collected');
  ok(d.collect() === null, 'and never handed over twice -- replaying it would drag the player back into a lobby they left');
}
{
  const { d } = rig({ alive: false });
  d.offer(ID);
  d.offer(ID2);
  ok(d.collect() === ID2, 'two invites before anyone is listening: the last one wins, because that is the one they just accepted');
  ok(d.collect() === null, 'and only one is delivered');
}

console.log('\n-- a reload re-parks, and does not lose what was already parked');
{
  const { d, pushed } = rig();
  d.collect();                       // page one is listening
  d.release();                       // navigation / renderer gone
  ok(d.offer(ID) === 'parked', 'an invite during the reload window parks rather than pushing at a page that is gone');
  ok(pushed.length === 0, 'nothing pushed');
  ok(d.collect() === ID, 'and page two collects it when it subscribes');
}
{
  const { d } = rig({ alive: false });
  d.offer(ID);
  d.release();
  ok(d.state.parked === ID, 'a release does not discard what is already parked -- a reload is not a refusal');
}

console.log('\n-- nothing is not an invite');
{
  const { d, pushed } = rig();
  d.collect();
  for (const bad of [null, undefined, '', 0, 123, {}]) {
    ok(d.offer(bad) === 'ignored', `${JSON.stringify(bad) ?? String(bad)} is ignored rather than pushed or parked`);
  }
  ok(pushed.length === 0 && d.state.parked === null, 'and none of them disturbed the state');
}

console.log('\n-- and main.mjs has no way around the door');
{
  // The seam is only worth what its call sites are. Every proof above is about
  // `join-delivery.mjs`; this is the one fact that keeps the bug from coming
  // back by a different route -- a second direct `webContents.send` of
  // `steam:join-requested`, which is exactly what callback 333 had.
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

  const pushes = main.match(/pushToRenderer\(\s*'steam:join-requested'/g) || [];
  ok(pushes.length === 1, `exactly one push of steam:join-requested exists in main.mjs (found ${pushes.length})`);

  // ...and it is the seam's own, handed to createJoinDelivery as its `push`.
  const wiring = main.slice(main.indexOf('createJoinDelivery({'), main.indexOf('});', main.indexOf('createJoinDelivery({')));
  ok(/push:\s*\(lobbyId\)\s*=>\s*pushToRenderer\('steam:join-requested'/.test(wiring),
    'and it is the one createJoinDelivery was given, not a second path beside it');

  // The three routes all go through `offer`, and none of them anywhere else.
  const offers = main.match(/joinDelivery\.offer\(/g) || [];
  ok(offers.length === 2,
    `both runtime routes -- callback 333 and second-instance -- offer rather than push (found ${offers.length}); the third is seeded as \`initial\``);
  ok(/initial: parseConnectLobbyArg\(process\.argv\)/.test(wiring),
    'and the launch-args route is the seam\'s initial value');

  // Callback 333 specifically -- the reported MAJOR. Sliced to the wiring's own
  // body rather than matched within a character budget, so a comment growing
  // between the two lines cannot quietly retire the check.
  //
  // RE-ANCHORED 2026-08-21 with the Binding swap. The claim is unchanged and so
  // is its strength: 333 must reach the renderer through the seam and by no
  // other path. What changed underneath is where 333 is heard --
  // `steamworks.js` had a callback registry (`SteamCallback.GameLobbyJoin-
  // Requested`) and `steamworks-ffi-node` has none, so the shell runs its own
  // manual-dispatch pump and the anchor is that pump's wiring. Leaving the old
  // anchor in place would have been the worse outcome by far: the string is
  // gone from the file, so the check would have found nothing and could only
  // ever fail -- or, matched loosely, pass while watching a call site that no
  // longer exists.
  const cbStart = main.indexOf('startCallbackPump({');
  const cbEnd = main.indexOf('    });', cbStart);
  const cbBody = main.slice(cbStart, cbEnd);
  ok(cbStart > 0 && /onJoinRequested:\s*\(lobbyId\)\s*=>\s*joinDelivery\.offer\(lobbyId\)/.test(cbBody),
    'callback 333 reaches the renderer through the seam');
  ok(!cbBody.includes('pushToRenderer'),
    'and does NOT push at the renderer itself -- the exact shape of the reported MAJOR');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
