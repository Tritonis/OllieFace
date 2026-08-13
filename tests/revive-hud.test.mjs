/**
 * The revive affordance only appears for someone who could actually revive,
 * and on a client its ring never claims more than the client can know.
 *
 *   node tests/revive-hud.test.mjs
 *
 * Three defects in one HUD element, all found by the whole-branch review:
 *
 *  - `reviveTarget` filtered *candidates* but never asked whether the viewer
 *    was a legal reviver, so two downed teammates four metres apart each read
 *    "HOLD E - REVIVE" over their own bleeding-out overlay while
 *    `Revive._reviverFor` refused both. The host's rule is `Roster.targetable`
 *    and so is this one now.
 *  - On a client the ring was a pure local key integration that climbed to a
 *    sticky 100% whatever the host decided. Revive progress does not cross the
 *    wire (the downed pawn's one health fraction is spent on the bleed-out
 *    clock), so the client's ring is *explicitly* an approximation: it moves
 *    only while the viewer is a legal reviver in range of the body's
 *    replicated position, decays when it is not, and stops short of full — the
 *    pawn standing up is what a completed revive looks like.
 *  - The hold was read off a hardcoded `KeyE` rather than the command stream
 *    `Revive` itself consumes, so it duplicated a binding the HUD's own label
 *    already knows can be a pad button.
 *
 * A real `HUD` needs a document, so this drives the prototype on a hand-built
 * `this` holding only the fields the three methods touch — the idiom from
 * tests/hud-strip-hold.test.mjs.
 */
import { HUD } from '../src/ui/HUD.js';
import { REVIVE } from '../src/data/revive.js';
import { BTN } from '../src/net/Protocol.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const H = 1 / 60;

function classSet() {
  const s = new Set();
  return { toggle: (c, v) => { if (v) s.add(c); else s.delete(c); }, contains: (c) => s.has(c) };
}

function fakeHUD() {
  const self = Object.create(HUD.prototype);
  self.c = {};
  self._reviveHeld = null;
  self._reviveMissT = 0;
  self._reviveClientTarget = null;
  self._reviveClientT = 0;
  self.refs = { revive: { classList: classSet() }, reviveArc: { style: {} } };
  return self;
}

const pawn = (x, o = {}) => ({
  isPlayer: true, alive: true, downed: false, revive: 0,
  position: { x, y: 0, z: 0 }, ...o,
});

/** A host's world: real pawns off `ctx.roster.all`. */
function hostCtx(viewer, mates) {
  return { authority: true, roster: { all: [viewer, ...mates] }, player: viewer, input: { down: () => false } };
}

/** A client's world: the viewer's own pawn, teammates as interpolated views. */
function clientCtx(viewer, views) {
  return {
    authority: false, player: viewer, input: { down: () => false },
    net: { views: new Map(views.map((v, i) => [i, v])) },
  };
}

console.log('the prompt asks whether the VIEWER could revive, not just who is down');
{
  const self = fakeHUD();
  const body = pawn(2, { downed: true, netId: 2, isPlayer: true });

  const standing = pawn(0);
  ok(self.reviveTarget(hostCtx(standing, [body]), standing) === body,
    'a standing teammate in range is offered the body (non-vacuity)');

  const downedViewer = pawn(0, { downed: true });
  ok(self.reviveTarget(hostCtx(downedViewer, [body]), downedViewer) === null,
    'a DOWNED viewer is offered nothing — the host would refuse them');

  const deadViewer = pawn(0, { alive: false });
  ok(self.reviveTarget(hostCtx(deadViewer, [body]), deadViewer) === null,
    'a dead viewer is offered nothing either');
}

console.log('and it asks the same question on a client, where the bodies are views');
{
  const self = fakeHUD();
  const view = pawn(2, { downed: true, netId: 9 });

  const standing = pawn(0);
  ok(self.reviveTarget(clientCtx(standing, [view]), standing) === view,
    'a standing client viewer sees the downed teammate view');

  const downedViewer = pawn(0, { downed: true });
  ok(self.reviveTarget(clientCtx(downedViewer, [view]), downedViewer) === null,
    'a downed client viewer sees nothing over their own bleed-out overlay');
}

console.log('the client ring is read off the command stream, not off a hardcoded key');
{
  const self = fakeHUD();
  const view = pawn(2, { downed: true, netId: 9 });
  // No keyboard at all: the only evidence of a hold is the interact bit on the
  // command, which is what a pad press produces and what `Revive` reads.
  const viewer = pawn(0, { lastCommand: { buttons: BTN.INTERACT } });
  const ctx = clientCtx(viewer, [view]);

  for (let i = 0; i < 30; i++) self.updateRevive(ctx, H);
  ok(self.refs.revive.classList.contains('is-on'), 'the prompt is up');
  ok(self._reviveClientT > 0, `a pad hold moves the ring (${self._reviveClientT.toFixed(3)})`);
}

console.log('...and it stops short of full: the pawn standing up is what a finished revive looks like');
{
  const self = fakeHUD();
  const view = pawn(2, { downed: true, netId: 9 });
  const viewer = pawn(0, { lastCommand: { buttons: BTN.INTERACT } });
  const ctx = clientCtx(viewer, [view]);

  const steps = Math.round((REVIVE.REVIVE_S * 4) / H);
  for (let i = 0; i < steps; i++) self.updateRevive(ctx, H);
  ok(self._reviveClientT < 1, `four times REVIVE_S of holding never reaches 1 (${self._reviveClientT.toFixed(3)})`);
  ok(self._reviveClientT > 0.9, 'but it does say "nearly there"');
}

console.log('an ineligible hold drains the ring instead of filling it');
{
  const self = fakeHUD();
  const view = pawn(2, { downed: true, netId: 9 });
  const viewer = pawn(0, { lastCommand: { buttons: BTN.INTERACT } });
  const ctx = clientCtx(viewer, [view]);

  for (let i = 0; i < Math.round(REVIVE.REVIVE_S / H / 2); i++) self.updateRevive(ctx, H);
  const half = self._reviveClientT;
  ok(half > 0.2, `part-way up (${half.toFixed(3)})`);

  // Out of the host's radius, still holding: `Revive._reviverFor` refuses, so
  // the ring has to come back down rather than sit at a number nobody honours.
  view.position.x = REVIVE.REVIVE_RADIUS + 10;
  for (let i = 0; i < Math.round(REVIVE.REVIVE_S / H); i++) self.updateRevive(ctx, H);
  ok(self._reviveClientT === 0, 'held out of range: the ring is empty, not stuck');
  ok(!self.refs.revive.classList.contains('is-on'), 'and the prompt is gone');
}

console.log('a downed client viewer never gets a ring at all, however hard they hold');
{
  const self = fakeHUD();
  const view = pawn(2, { downed: true, netId: 9 });
  const viewer = pawn(0, { downed: true, lastCommand: { buttons: BTN.INTERACT } });
  const ctx = clientCtx(viewer, [view]);

  for (let i = 0; i < 600; i++) self.updateRevive(ctx, H);
  ok(!self.refs.revive.classList.contains('is-on'), 'ten seconds of holding while downed: no prompt');
  ok(self._reviveClientT === 0, 'and no ring');
}

console.log('a host still reads the real clock off the body');
{
  const self = fakeHUD();
  const body = pawn(2, { downed: true, revive: 0.42 });
  const viewer = pawn(0, { lastCommand: { buttons: BTN.INTERACT } });
  const ctx = hostCtx(viewer, [body]);

  self.updateRevive(ctx, H);
  ok(self.reviveFraction(ctx, body, H, true) === 0.42, 'the host ring is `pawn.revive`, untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
