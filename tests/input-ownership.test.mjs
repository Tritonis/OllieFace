/**
 * Who owns `input.enabled` (#197).
 *
 *   node tests/input-ownership.test.mjs
 *
 * Three parts of the build take the stick away from the player, and until this
 * file they did it by writing one boolean from three clocks:
 *
 *   · `Progression` — for the length of a stage transition, saved-and-restored;
 *   · `NetHost._holdSession` — every frame, while a co-op host sits at a menu
 *     over a world somebody else is still playing;
 *   · `FallbackPause` — on a toggle, for the packaged shell that has no
 *     `ctx.menus` at all.
 *
 * The combination none of the existing files covered is a menu going up *during*
 * a transition. The transition's restore replays a value saved before the menu
 * existed, so the far side of the fade hands control back under an open menu —
 * and in the `FallbackPause` case nothing ever takes it away again, because that
 * writer only speaks on a toggle. The host drives its survivor from the pause
 * screen for the rest of the run.
 *
 * The first three arms below are red on the pre-#197 code and green after it.
 * The third is there because the first two are not enough: both of them close
 * their menu *after* the fade has finished, by which point the transition is
 * claiming nothing and the old `enabled = true` release is observationally
 * identical to a claims-based one. Only a release that lands while another
 * owner is still claiming can tell them apart, and that is the ordering the fix
 * exists for. The fourth arm is the guard-can-fail check on the registry
 * itself.
 */
import * as THREE from 'three';
import { Stage } from '../src/world/Stage.js';
import { Progression } from '../src/systems/Progression.js';
import { RNG } from '../src/core/MathUtil.js';
import { NetHost } from '../src/net/NetHost.js';
import { setFallbackPause } from '../src/ui/FallbackPause.js';
import { muteInput } from '../src/core/InputMute.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const SEED = 1234;

/** A ctx with a real Progression driving a real Stage, and no renderer to fake. */
function makeWorld({ menus = null } = {}) {
  const listeners = new Map();
  const events = {
    on(n, fn) { (listeners.get(n) ?? listeners.set(n, []).get(n)).push(fn); return () => {}; },
    emit(n, p) { for (const fn of listeners.get(n) ?? []) fn(p); },
  };
  const stage = new Stage();
  const input = { enabled: true };
  const ctx = {
    scene: new THREE.Scene(), seed: SEED, settings: {}, time: 0, paused: false,
    camera: new THREE.PerspectiveCamera(), input, events, authority: true,
    netRole: 'host', rng: new RNG(SEED), menus,
    hud: {}, combat: { entities: [] }, progression: { stageIndex: 0 },
    artifacts: { netPack: () => ({ mask: 0, difficulty: 1 }) },
    player: { position: new THREE.Vector3(), velocity: new THREE.Vector3(), alive: true },
    spawnRemotePlayer() {
      const p = {
        isPlayer: true, alive: true, health: 100, maxHealth: 100, shield: 0,
        position: { x: 0, y: 0, z: 0 }, yaw: 0, applyCommand() {}, lastCommand: null,
      };
      ctx.combat.entities.push(p);
      return p;
    },
    despawnRemotePlayer(p) {
      const i = ctx.combat.entities.indexOf(p);
      if (i >= 0) ctx.combat.entities.splice(i, 1);
    },
  };
  stage.init(ctx);
  const p = new Progression();
  p.stretchTransitions = true;   // spread over frames, so a menu can open mid-fade
  p.init(ctx);
  p.interactables.populate = () => ({ position: new THREE.Vector3(1, 0, 2) });
  p.interactables.clear = () => {};
  return { ctx, p, input };
}

function makePeer(id = 1) {
  const p = {
    id, states: 0, events_: 0, closed: false,
    events: { readyState: 'open', bufferedAmount: 0 },
    sendState() { p.states++; }, sendEvent() { p.events_++; }, pumpSim() {},
    drained() { return p.events.bufferedAmount === 0; },
    close() { if (p.closed) return; p.closed = true; p.onClose?.(); },
  };
  return p;
}

function makeHost(ctx) {
  const host = new NetHost({ maxPlayers: 4 });
  host._t = 0;
  host._now = () => host._t;
  host.init(ctx);
  return host;
}

/* ------------------------------------------------------------------ *
 * 1. The pause overlay, up while a stage transition finishes
 * ------------------------------------------------------------------ */
console.log('the pause overlay goes up mid-transition');
{
  // `fallbackPauseNeeded` is `!ctx.menus`, which is exactly the packaged-shell
  // host this file cares about. `doc` is null so no DOM is touched; the state
  // half is what writes input, and it is passed an explicit `want` either way.
  const { ctx, p, input } = makeWorld({ menus: null });
  ctx.net = { hasLivePeer: () => true };   // a co-op host: the world keeps running

  p.advanceStage();
  ok(p.transition !== null, 'a transition is open');
  ok(input.enabled === false, 'the transition took the controls');

  setFallbackPause(ctx, true, null);
  ok(input.enabled === false, 'the overlay is up and the controls are still gone');

  let frames = 0;
  while (p.transition && frames < 600) { p.update(ctx, 1 / 60); frames++; }
  ok(p.transition === null, `the transition finished (${frames} frames)`);

  // THE CLAIM. The overlay is still up. Nothing has closed it, and nothing else
  // writes this boolean on this path — so if the transition handed the stick
  // back, the run is now being driven from the pause screen, permanently.
  ok(input.enabled === false,
     `the controls stay gone while the pause overlay is up (enabled=${input.enabled})`);

  setFallbackPause(ctx, false, null);
  ok(input.enabled === true, 'and come back when the overlay is dismissed');
}

/* ------------------------------------------------------------------ *
 * 2. A co-op hold, active while a stage transition finishes
 * ------------------------------------------------------------------ */
console.log('\na co-op menu hold spans a stage transition');
{
  const { ctx, p, input } = makeWorld({ menus: { screen: null } });
  const host = makeHost(ctx);
  ctx.net = host;
  const peer = makePeer(1);
  host._onPeer(peer);
  host._t = 1;
  host.update(ctx, 1 / 60);
  ok(input.enabled === true, 'a playing host has its controls');

  p.advanceStage();
  ok(input.enabled === false, 'the transition took them');

  // The host opens a menu under the veil. The world is still being played by
  // the peer, so `_holdSession` claims the mute for as long as the menu is up.
  ctx.menus.screen = 'pause';
  host._t += 1 / 60;
  host.update(ctx, 1 / 60);
  ok(input.enabled === false, 'and the hold claims them too');

  let frames = 0;
  while (p.transition && frames < 600) { p.update(ctx, 1 / 60); frames++; }
  ok(p.transition === null, `the transition finished (${frames} frames)`);

  // THE CLAIM, checked in the same frame the transition ended — a survivor
  // sampling input here is driven by pause-menu keystrokes. `_holdSession` does
  // re-mute on the *next* host update, which is what made this a one-frame
  // window rather than a permanent one; a one-frame window is still a frame in
  // which `Player._sampleCommand` reads a live stick.
  ok(input.enabled === false,
     `the hold's claim survives the transition ending (enabled=${input.enabled})`);

  ctx.menus.screen = null;
  host._t += 1 / 60;
  host.update(ctx, 1 / 60);
  ok(input.enabled === true, 'and the controls come back when the menu closes');
}

/* ------------------------------------------------------------------ *
 * 3. The menu closes first, and the transition is still open
 * ------------------------------------------------------------------ */
console.log('\nthe co-op menu closes while the transition is still running');
{
  // The ordering the fix actually exists for, and the one scenario 2 cannot
  // reach: `_holdSession`'s *release* running while another owner still holds a
  // claim. In scenario 2 the menu closes after the fade has finished, so the
  // transition is claiming nothing by then and the pre-#197 `enabled = true`
  // is observationally identical to a claims-based release. Here it is not:
  // revert `NetHost.js`'s release to that direct write and this arm goes red.
  const { ctx, p, input } = makeWorld({ menus: { screen: null } });
  const host = makeHost(ctx);
  ctx.net = host;
  const peer = makePeer(1);
  host._onPeer(peer);
  host._t = 1;
  host.update(ctx, 1 / 60);

  ctx.menus.screen = 'pause';
  host._t += 1 / 60;
  host.update(ctx, 1 / 60);
  ok(input.enabled === false, 'the hold has the controls with the menu up');

  p.advanceStage();
  ok(p.transition !== null, 'a transition opens underneath the open menu');

  // The host dismisses the menu mid-fade. `_holdSession` releases its own claim
  // on the next frame — and must release only its own.
  ctx.menus.screen = null;
  host._t += 1 / 60;
  host.update(ctx, 1 / 60);
  ok(p.transition !== null, 'the transition is still open');
  ok(input.enabled === false,
     `closing the menu mid-transition does not hand the stick back (enabled=${input.enabled})`);

  let frames = 0;
  while (p.transition && frames < 600) { p.update(ctx, 1 / 60); frames++; }
  ok(input.enabled === true, 'the transition\'s own release is what gives it back');
}

/* ------------------------------------------------------------------ *
 * 4. The claims are independent — this guard can fail
 * ------------------------------------------------------------------ */
console.log('\nthe claims are independent');
{
  const input = { enabled: true };
  muteInput(input, 'a', true);
  muteInput(input, 'b', true);
  ok(input.enabled === false, 'two claims mute');
  muteInput(input, 'a', false);
  ok(input.enabled === false, 'releasing one of two does not un-mute');
  muteInput(input, 'a', false);
  ok(input.enabled === false, 'nor does releasing it twice');
  muteInput(input, 'b', false);
  ok(input.enabled === true, 'releasing the last claim un-mutes');
  muteInput(null, 'a', true);
  ok(true, 'a missing input is not an error');
}

/* ------------------------------------------------------------------ *
 * 5. close() while holding must release its own claim (#201)
 * ------------------------------------------------------------------ */
console.log('\nclose() releases a held coopHold claim');
{
  const { ctx, input } = makeWorld({ menus: { screen: 'pause' } });
  const host = makeHost(ctx);
  ctx.net = host;
  const peer = makePeer(1);
  host._onPeer(peer);
  host._t = 1;
  host.update(ctx, 1 / 60);
  ok(input.enabled === false, 'the hold has claimed the controls with the menu up');
  ok(input.muteClaims.has('coopHold'), 'the coopHold claim is registered');

  host.close();
  ok(!input.muteClaims.has('coopHold'), 'close() released the coopHold claim');
  ok(input.enabled === true, 'and the controls are usable again');

  // #201: close() must also clear `_holding`, not just release the mute —
  // otherwise a stray `update()` after close() re-enters `_holdSession`,
  // which reads `_holding` to gate its own release path, and can re-claim
  // the stick on a host that is already dead.
  host.update(ctx, 1 / 60);
  ok(!input.muteClaims.has('coopHold'), 'a post-close update() does not re-claim coopHold');
  ok(input.enabled === true, 'and the controls remain usable after a post-close tick');
}

console.log('\nclose() on a non-holding host is a no-op for other claims');
{
  const { ctx, input } = makeWorld({ menus: { screen: null } });
  const host = makeHost(ctx);
  ctx.net = host;
  muteInput(input, 'someoneElse', true);
  ok(input.muteClaims.has('someoneElse'), 'another owner holds a claim');

  let threw = false;
  try { host.close(); } catch { threw = true; }
  ok(!threw, 'close() on a non-holding host does not throw');
  ok(input.muteClaims.has('someoneElse'), 'and does not disturb another owner\'s claim');
  ok(!input.muteClaims.has('coopHold'), 'and never held coopHold itself');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
