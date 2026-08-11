/**
 * Input + PadState glue: pad buttons appear as the same key codes and mouse
 * flags gameplay already polls; stick folds into moveAxis(); keyboard use
 * flips the device flag back; no pad means byte-identical behaviour.
 */
const listeners = {};
globalThis.addEventListener = (t, fn) => { (listeners[t] ??= []).push(fn); };
globalThis.document = {
  addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
  pointerLockElement: null,
};
const canvas = { addEventListener: (t, fn) => { (listeners[`canvas:${t}`] ??= []).push(fn); }, requestPointerLock: () => {} };
const fire = (t, e = {}) => (listeners[t] ?? []).forEach((fn) => fn(e));

const { Input } = await import('../src/core/Input.js');
const { PAD_BUTTON } = await import('../src/core/PadState.js');

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

// Injectable pad list, mutated per scenario.
let padList = [];
const input = new Input(canvas, { getPads: () => padList });

// --- inert without a pad -----------------------------------------------------
input.pollPad();
check('no pad: down() false', !input.down('Space'));
check('no pad: moveAxis zero', input.moveAxis().x === 0 && input.moveAxis().z === 0);
check('no pad: mouse untouched', !input.mouse.left && !input.mouse.right);
check('no pad: padActive false', input.padActive === false);

// --- buttons map to the codes Player polls -----------------------------------
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.A, PAD_BUTTON.B, PAD_BUTTON.X, PAD_BUTTON.Y, PAD_BUTTON.LB, PAD_BUTTON.RB])];
input.pollPad();
check('A -> Space held + edge', input.down('Space') && input.hit('Space'));
check('B -> ShiftLeft', input.down('ShiftLeft'));
check('X -> KeyE', input.down('KeyE'));
check('Y -> KeyF (equipment)', input.down('KeyF') && input.hit('KeyF'));
check('LB -> KeyQ', input.down('KeyQ'));
check('RB -> KeyR', input.down('KeyR'));
input.endFrame();
input.pollPad();
check('held next frame: down yes, hit no', input.down('Space') && !input.hit('Space'));

// --- triggers are the mouse --------------------------------------------------
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.RT, PAD_BUTTON.LT])];
input.pollPad();
check('RT -> mouse.left (+edge)', input.mouse.left && input.mouse.leftEdge);
check('LT -> mouse.right (+edge)', input.mouse.right && input.mouse.rightEdge);
padList = [pad()];
input.endFrame();
input.pollPad();
check('trigger release clears mouse', !input.mouse.left && !input.mouse.right);

// --- external mouse writes survive polling (the Harness idiom) ---------------
// Harness.js:1492 fireBurst sets ctx.input.mouse.left = true ONCE and awaits
// frames. pollPad must never recompute the flag when the pad state hasn't
// transitioned, or every firing capture scenario silently stops firing.
padList = [];
input.pollPad();
input.mouse.left = true;
input.pollPad();
check('external mouse.left write survives pollPad', input.mouse.left === true);
input.mouse.left = false;

// --- pad release does not eat a held real key --------------------------------
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.A])];
input.pollPad();
fire('keydown', { code: 'Space', repeat: false });   // real spacebar also held
padList = [pad()];
input.endFrame();
input.pollPad();
check('pad A release: real Space still down', input.down('Space'));
fire('keyup', { code: 'Space' });
check('real keyup clears it', !input.down('Space'));

// --- stick into moveAxis, kb+stick clamps ------------------------------------
padList = [pad([0, -1, 0, 0])];
input.pollPad();
check('stick forward: moveAxis z=1', input.moveAxis().z === 1, input.moveAxis());
fire('keydown', { code: 'KeyW', repeat: false });
const both = input.moveAxis();
check('kb + stick never exceeds unit', Math.hypot(both.x, both.z) <= 1 + 1e-9, both);
fire('keyup', { code: 'KeyW' });

// --- device flag -------------------------------------------------------------
// The keydown above cleared the flag; padList still holds the deflected stick,
// so one poll re-activates it before we assert. (Without this poll the check
// fails against a CORRECT implementation -- pre-flight review B2.)
input.pollPad();
check('pad input set padActive', input.padActive === true);
fire('keydown', { code: 'KeyA', repeat: false });
check('keydown clears padActive', input.padActive === false);
fire('keyup', { code: 'KeyA' });
padList = [pad([0, 0, 0.9, 0])];
input.pollPad();
check('right stick re-activates', input.padActive === true);
check('look exposed on input.pad', input.pad.lookX > 0, input.pad.lookX);

// --- Start consumes the frame's pad edges ------------------------------------
// Menus' Start branch calls this when it opens the pause screen. Without it a
// same-frame A+Start opens the pause and navigate()'s hit('Space') immediately
// clicks Resume — the flicker pre-flight I3 was raised to kill, through the
// second door I3 did not close.
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.A, PAD_BUTTON.START])];
input.endFrame();
input.pollPad();
check('same-frame A+Start: the virtual Space edge is there to eat',
  input.hit('Space') && input.pad.edges.has(PAD_BUTTON.START));
input.clearPadEdges();
check('clearPadEdges drops every pad-mapped edge', !input.hit('Space') && !input.hit('KeyF'));
check('clearPadEdges leaves the held state alone', input.down('Space'));

process.exit(failures ? 1 : 0);
