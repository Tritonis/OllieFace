/**
 * PadState: pure gamepad reader. Radial deadzone on move, curved per-axis
 * deadzone on look, edge detection across polls, device-activity tracking.
 * No DOM, no navigator — the pad source is injected.
 */
import { PadState, DEADZONE, PAD_BUTTON } from '../src/core/PadState.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
  if (!pass) failures++;
};

const pad = (axes = [0, 0, 0, 0], pressed = []) => ({
  connected: true,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

// --- no pad: inert -----------------------------------------------------------
{
  const ps = new PadState(() => [null, null]);
  ps.poll();
  const s = ps.snapshot;
  check('no pad: not present', s.present === false);
  check('no pad: zero axes', s.moveX === 0 && s.moveZ === 0 && s.lookX === 0 && s.lookY === 0);
  check('no pad: no buttons', s.held.size === 0 && s.edges.size === 0);
}

// --- deadzone ----------------------------------------------------------------
{
  let p = pad([0.1, -0.1, 0.1, -0.1]);
  const ps = new PadState(() => [p]);
  ps.poll();
  check('inside deadzone: all zero',
    ps.snapshot.moveX === 0 && ps.snapshot.moveZ === 0
    && ps.snapshot.lookX === 0 && ps.snapshot.lookY === 0);
  check('inside deadzone: not active', ps.snapshot.active === false);

  p = pad([1, 1, 0, 0]);
  ps.poll();
  const m = Math.hypot(ps.snapshot.moveX, ps.snapshot.moveZ);
  check('diagonal move normalized to <= 1', m <= 1 + 1e-9, m);
  // Gamepad y-axis is +down; game forward is +z. Full-up stick (-1) must be forward (+1).
  check('stick up is forward', (() => { const q = new PadState(() => [pad([0, -1])]); q.poll(); return q.snapshot.moveZ; })() === 1);

  // Deadzone is rescaled, not a cliff: just past the zone is near-zero, not 0.18.
  const just = new PadState(() => [pad([DEADZONE + 0.01, 0])]);
  just.poll();
  check('deadzone rescaled: just past zone is small', Math.abs(just.snapshot.moveX) < 0.05, just.snapshot.moveX);
}

// --- look curve --------------------------------------------------------------
{
  const half = new PadState(() => [pad([0, 0, 0.5, 0])]);
  half.poll();
  const full = new PadState(() => [pad([0, 0, 1, 0])]);
  full.poll();
  check('look full deflection is 1', Math.abs(full.snapshot.lookX - 1) < 1e-9, full.snapshot.lookX);
  // Squared curve: half deflection gives well under half rate (precision aiming).
  check('look curve: half stick < 0.35 rate', half.snapshot.lookX > 0 && half.snapshot.lookX < 0.35, half.snapshot.lookX);
  const neg = new PadState(() => [pad([0, 0, -1, 0])]);
  neg.poll();
  check('look curve preserves sign', neg.snapshot.lookX === -1, neg.snapshot.lookX);
}

// --- edges -------------------------------------------------------------------
{
  let pressed = [PAD_BUTTON.RT];
  const ps = new PadState(() => [pad([0, 0, 0, 0], pressed)]);
  ps.poll();
  check('press: held + edge', ps.snapshot.held.has(PAD_BUTTON.RT) && ps.snapshot.edges.has(PAD_BUTTON.RT));
  ps.poll();
  check('hold: held, no edge', ps.snapshot.held.has(PAD_BUTTON.RT) && !ps.snapshot.edges.has(PAD_BUTTON.RT));
  pressed = [];
  ps.poll();
  check('release: neither', !ps.snapshot.held.has(PAD_BUTTON.RT) && !ps.snapshot.edges.has(PAD_BUTTON.RT));
}

// --- device activity ---------------------------------------------------------
{
  let axes = [0, 0, 0, 0];
  let pressed = [];
  const ps = new PadState(() => [pad(axes, pressed)]);
  ps.poll();
  check('idle pad: inactive', ps.snapshot.active === false);
  pressed = [PAD_BUTTON.A];
  ps.poll();
  check('button press activates', ps.snapshot.active === true);
  ps.deviceUsed('kb');
  check('keyboard use deactivates', ps.snapshot.active === false);
  pressed = []; axes = [0.8, 0, 0, 0];
  ps.poll();
  check('stick past deadzone re-activates', ps.snapshot.active === true);
}

// --- disconnect --------------------------------------------------------------
{
  let list = [pad([0, 0, 0, 0], [PAD_BUTTON.A])];
  const ps = new PadState(() => list);
  ps.poll();
  list = [null];
  ps.poll();
  const s = ps.snapshot;
  check('disconnect: everything clears',
    !s.present && !s.active && s.held.size === 0 && s.edges.size === 0
    && s.moveX === 0 && s.moveZ === 0 && s.lookX === 0 && s.lookY === 0);
}

process.exit(failures ? 1 : 0);
