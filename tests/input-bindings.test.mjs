/**
 * Rebindable controls (#42 part 1).
 *
 *   node tests/input-bindings.test.mjs
 *
 * The claims that matter are behavioural, not structural: a rebound key has to
 * change what `moveAxis()` and the action polls actually read, through the same
 * listeners the browser drives. Every check below goes through a real `Input`
 * on stub listeners (the idiom from tests/pad-input-glue.test.mjs) rather than
 * inspecting the map it was given.
 *
 * Two guards were shown to be capable of failing, by cutting the code under
 * them and watching them go red:
 *   - bypass the binding lookup in Input's keydown (`const code = e.code`) and
 *     'after remap, old key is inert', 'rebound interact reads as KeyE' and
 *     'key bound to primary fires' all fail;
 *   - resolve keyup against the live map instead of `_pressedVirtual` and both
 *     'mid-hold rebind ...' checks fail — the review Critical this file now
 *     covers.
 */
const listeners = {};
globalThis.addEventListener = (t, fn) => { (listeners[t] ??= []).push(fn); };
globalThis.removeEventListener = () => {};
globalThis.document = {
  addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
  pointerLockElement: null,
};
const canvas = {
  addEventListener: (t, fn) => { (listeners[`canvas:${t}`] ??= []).push(fn); },
  requestPointerLock: () => {},
};
const fire = (t, e = {}) => (listeners[t] ?? []).forEach((fn) => fn(e));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { Input } = await import('../src/core/Input.js');
const { PAD_BUTTON } = await import('../src/core/PadState.js');
const {
  Bindings, ACTIONS, DEFAULT_BINDINGS, VIRTUAL, isReserved, keyLabel, padLabel,
} = await import('../src/core/Bindings.js');

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
  if (!pass) failures++;
};

// --- the defaults ARE the legacy constants ----------------------------------
// Written out literally, not derived from the table under test: the point is to
// notice the day somebody edits ACTIONS and silently moves a shipped default.
const LEGACY_PAD_KEYS = [
  [PAD_BUTTON.A, 'Space'],
  [PAD_BUTTON.B, 'ShiftLeft'],
  [PAD_BUTTON.X, 'KeyE'],
  [PAD_BUTTON.Y, 'KeyF'],
  [PAD_BUTTON.LB, 'KeyQ'],
  [PAD_BUTTON.RB, 'KeyR'],
];
{
  const b = new Bindings();
  for (const [btn, code] of LEGACY_PAD_KEYS) {
    check(`default pad ${btn} -> ${code}`, b.virtualForPad(btn) === code, b.virtualForPad(btn));
  }
  check('default movement WASD', ['moveForward', 'moveBack', 'moveLeft', 'moveRight']
    .map((id) => b.keyOf(id)).join(',') === 'KeyW,KeyS,KeyA,KeyD');
  check('default RT -> left mouse', b.virtualForPad(PAD_BUTTON.RT) === 'Mouse0');
  check('default LT -> right mouse', b.virtualForPad(PAD_BUTTON.LT) === 'Mouse2');
  check('equipment default is KeyF (Items EQUIP_KEY)', VIRTUAL.equipment === 'KeyF');
  check('DEFAULT_BINDINGS matches a fresh map',
    ACTIONS.every((a) => DEFAULT_BINDINGS[a.id].key === b.keyOf(a.id)
      && DEFAULT_BINDINGS[a.id].pad === b.padOf(a.id)));
  check('labels read for humans', keyLabel('KeyE') === 'E' && keyLabel('ShiftLeft') === 'Shift'
    && keyLabel('Mouse0') === 'LMB' && padLabel(PAD_BUTTON.Y) === 'Y');
}

// --- a rebind changes what the game reads ------------------------------------
let padList = [];
const bindings = new Bindings();
const input = new Input(canvas, { getPads: () => padList, bindings });

fire('keydown', { code: 'KeyW' });
check('default W moves forward', input.moveAxis().z === 1, input.moveAxis());
fire('keyup', { code: 'KeyW' });

bindings.bindKey('moveForward', 'KeyI');
fire('keydown', { code: 'KeyW' });
check('after remap, old key is inert', input.moveAxis().z === 0, input.moveAxis());
fire('keyup', { code: 'KeyW' });
fire('keydown', { code: 'KeyI' });
check('after remap, new key moves forward', input.moveAxis().z === 1, input.moveAxis());
fire('keyup', { code: 'KeyI' });
check('remapped key released', input.moveAxis().z === 0);

// The action polls gameplay uses: the virtual code never moves, so
// Player/NetClient/Items keep asking the question they always asked.
bindings.bindKey('interact', 'KeyZ');
fire('keydown', { code: 'KeyZ' });
check('rebound interact reads as KeyE', input.down('KeyE') && input.actionDown('interact'));
fire('keyup', { code: 'KeyZ' });

// A keyboard key bound to primary fire drives the mouse flag.
bindings.bindKey('primary', 'KeyM');
fire('keydown', { code: 'KeyM' });
check('key bound to primary fires', input.mouse.left === true && input.mouse.leftEdge === true);
fire('keyup', { code: 'KeyM' });
check('key bound to primary releases', input.mouse.left === false);

// A rebind BETWEEN a press and its release must not strand the press. The
// release follows the translation the press was given, not the current map.
bindings.bindKey('primary', 'KeyM');
fire('keydown', { code: 'KeyM' });
bindings.bindKey('primary', 'KeyN');            // rebound mid-hold
fire('keyup', { code: 'KeyM' });
check('mid-hold rebind releases the fire flag', input.mouse.left === false, input.mouse.left);
bindings.bindKey('sprint', 'KeyG');
fire('keydown', { code: 'KeyG' });
bindings.bindKey('sprint', 'KeyH');
fire('keyup', { code: 'KeyG' });
check('mid-hold rebind releases a held key', !input.down('ShiftLeft'));
// ...and while a SECOND physical source still holds the same action, the first
// one letting go must not clear it. The state is per virtual code, refcounted
// by the physical presses holding it.
bindings.bindKey('primary', 'KeyM');
fire('keydown', { code: 'KeyM' });
bindings.bindKey('primary', 'KeyN');
fire('keydown', { code: 'KeyN' });
fire('keyup', { code: 'KeyM' });
check('fire survives releasing one of two holders', input.mouse.left === true, input.mouse.left);
fire('keyup', { code: 'KeyN' });
check('fire clears when the last holder lets go', input.mouse.left === false);

bindings.bindKey('utility', 'KeyM');
fire('keydown', { code: 'KeyM' });
bindings.bindKey('utility', 'KeyJ');
fire('keydown', { code: 'KeyJ' });
fire('keyup', { code: 'KeyM' });
check('a key survives releasing one of two holders', input.actionDown('utility') === true);
fire('keyup', { code: 'KeyJ' });
check('the key clears when the last holder lets go', input.actionDown('utility') === false);

bindings.bindKey('primary', 'Mouse0');
bindings.bindKey('sprint', 'ShiftLeft');
bindings.bindKey('utility', 'KeyQ');

// A rebound PAD button reaches the same virtual code.
bindings.bindPad('utility', PAD_BUTTON.RB);   // swaps with `special`
padList = [{
  connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === PAD_BUTTON.RB })),
}];
input.pollPad();
check('rebound pad button drives its action', input.down('KeyQ') && !input.down('KeyR'));
padList = [];
input.pollPad();

// --- the conflict rule: swap -------------------------------------------------
{
  const b = new Bindings();
  const displaced = b.bindKey('jump', 'KeyE');   // interact holds KeyE
  check('conflict returns the displaced action', displaced === 'interact', displaced);
  check('conflict: new holder took the key', b.keyOf('jump') === 'KeyE');
  check('conflict: displaced action took the swap', b.keyOf('interact') === 'Space');
  const codes = ACTIONS.map((a) => b.keyOf(a.id));
  check('conflict: no key drives two actions', new Set(codes).size === codes.length);
  const p = b.bindPad('jump', PAD_BUTTON.X);
  check('pad conflict swaps too', p === 'interact' && b.padOf('interact') === PAD_BUTTON.A);
}

// --- reserved codes ----------------------------------------------------------
{
  // Every code `Menus.navigate`/`update` reads raw must be refused, or a player
  // can bind an action onto it and lose the way back to this screen.
  const rawReads = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter',
    'NumpadEnter', 'Backspace', 'Escape', 'KeyC', 'Digit1', 'Digit2', 'Digit3'];
  check('every raw-read menu code is reserved', rawReads.every((c) => isReserved(c)),
    rawReads.filter((c) => !isReserved(c)));
  check('ordinary and default keys are not reserved',
    !isReserved('KeyM') && !isReserved('Space') && !isReserved('KeyW'));
  const b = new Bindings({ jump: { key: 'ArrowUp' } });
  check('a stored blob cannot claim a reserved code', b.keyOf('jump') === 'Space');
  // The `.mutate-choice` window's only input path — a capture dialog must
  // refuse Digit1 exactly as it refuses ArrowUp, or a rebind can steal a
  // player's only way to answer the blight-toll offer.
  const b2 = new Bindings({ jump: { key: 'Digit1' } });
  check('a stored blob cannot claim Digit1 either', b2.keyOf('jump') === 'Space');
  check('isReserved refuses Digit1 the same way it refuses ArrowUp',
    isReserved('Digit1') === isReserved('ArrowUp') && isReserved('Digit1') === true);
}

// --- reset -------------------------------------------------------------------
{
  const b = new Bindings();
  b.bindKey('jump', 'KeyN');
  b.bindPad('sprint', PAD_BUTTON.BACK);
  b.reset();
  check('reset restores every default',
    ACTIONS.every((a) => b.keyOf(a.id) === DEFAULT_BINDINGS[a.id].key
      && b.padOf(a.id) === DEFAULT_BINDINGS[a.id].pad));
}

// --- persistence round-trip and corrupt blobs --------------------------------
{
  const a = new Bindings();
  a.bindKey('sprint', 'KeyV');
  a.bindPad('special', PAD_BUTTON.BACK);
  const b = new Bindings(JSON.parse(JSON.stringify(a.toJSON())));
  check('round-trip keeps the rebind', b.keyOf('sprint') === 'KeyV' && b.padOf('special') === PAD_BUTTON.BACK);
  check('round-trip keeps the rest at default', b.keyOf('jump') === 'Space');

  const corrupt = [
    null, 'nonsense', 42, [],
    { jump: 7 },
    { jump: { key: 12, pad: 'X' } },
    { jump: { key: '' } },
    { nosuchaction: { key: 'KeyP' } },
    // Two actions claiming one key: the second is dropped, not shadowed.
    { jump: { key: 'KeyE' } },
  ];
  let clean = true;
  for (const blob of corrupt) {
    const c = new Bindings(blob);
    const codes = ACTIONS.map((x) => c.keyOf(x.id));
    if (codes.some((v) => typeof v !== 'string' || !v)) clean = false;
    if (new Set(codes).size !== codes.length) clean = false;
  }
  check('corrupt blobs leave a complete, conflict-free map', clean);
  check('a duplicate-key blob is refused, not adopted',
    new Bindings({ jump: { key: 'KeyE' } }).keyOf('jump') === 'Space');
}

// --- the settings store carries it ------------------------------------------
{
  const { loadSettings, saveSettings, DEFAULTS } = await import('../src/ui/Menus.js');
  const { bindings: live } = await import('../src/core/Bindings.js');

  live.reset();
  live.bindKey('utility', 'KeyB');
  saveSettings({ ...DEFAULTS });
  const raw = store.get('telluric.settings');
  check('save writes the binding map', /"utility"/.test(raw) && /KeyB/.test(raw));

  live.reset();
  const loaded = loadSettings();
  check('load restores the binding map', live.keyOf('utility') === 'KeyB');
  check('load leaves the numeric settings alone', loaded.master === DEFAULTS.master);
  check('bindings are not folded into the numeric blob', loaded.bindings === undefined);

  store.set('telluric.settings', '{"master":0.5,"bindings":"not an object"}');
  live.bindKey('utility', 'KeyB');
  const l2 = loadSettings();
  check('corrupt stored bindings fall back to defaults', live.keyOf('utility') === 'KeyQ');
  check('corrupt bindings do not poison the numbers', l2.master === 0.5);

  store.set('telluric.settings', '{not json');
  live.bindKey('utility', 'KeyB');
  loadSettings();
  check('unparseable store falls back to defaults', live.keyOf('utility') === 'KeyQ');
}

console.log(failures ? `\n${failures} FAILED` : '\nall bindings checks passed');
process.exit(failures ? 1 : 0);
