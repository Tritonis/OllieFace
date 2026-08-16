/**
 * A failed save reaches the player, and a good one takes the warning back.
 *
 *   node tests/save-failure-ui.test.mjs
 *
 * This is the half of the save story that is not about the disk. Before it,
 * every failure path ended at a `console.error`: the write was refused, the
 * run continued, and the player learned about it after quitting. The chain
 * asserted here is the whole of the replacement -- main's verdict crosses the
 * bridge, `DesktopStore` normalises it, and `SaveIndicator` is the only thing
 * on screen that says so.
 *
 * There is no jsdom in this repo, so `document` is a hand-built stub with the
 * four members `SaveIndicator` uses. That the module needs only those four is
 * itself the reason it can be tested at all, and worth keeping true.
 */
import { initDesktopStore } from '../src/core/DesktopStore.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function stubNode(tagName) {
  const node = {
    tagName, className: '', textContent: '', children: [], parent: null,
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    remove() {
      const p = node.parent;
      if (p) { p.children = p.children.filter((c) => c !== node); node.parent = null; }
    },
  };
  return node;
}
globalThis.document = {
  head: stubNode('head'),
  body: stubNode('body'),
  createElement: (tag) => stubNode(tag),
};

// Imported after the stub is installed. `SaveIndicator` touches the document
// only inside its functions, but importing it first would still be relying on
// that rather than asserting it.
const { showSaveFailure, clearSaveFailure, saveFailureElement } = await import('../src/ui/SaveIndicator.js');

const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
const indicators = () => document.body.children.filter((c) => c.className === 'save-indicator');

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** A bridge whose save status is pushed from outside, as main's is. */
function fakeBridge() {
  const listeners = [];
  return {
    loadStore: () => ({ ok: true, raw: '{}' }),
    saveStore: () => {},
    onSaveStatus: (cb) => { listeners.push(cb); return () => {}; },
    _push: (status) => { for (const cb of listeners) cb(status); },
  };
}

console.log('\n-- the indicator says what is wrong and what it costs');
{
  showSaveFailure('EBUSY: the file is locked');
  const el = saveFailureElement();
  ok(el !== null, 'showing a failure puts an element on screen');
  ok(indicators().length === 1, 'and exactly one, appended to the body');
  const body = text(el);
  ok(/not being written to disk/i.test(body), 'it names the actual problem, not "an error occurred"');
  ok(/lost when you quit/i.test(body), 'it names the consequence, which is what makes it worth reading');
  ok(body.includes('EBUSY: the file is locked'), 'and it carries the underlying reason for a bug report');

  showSaveFailure('ENOSPC: no space left on device');
  ok(indicators().length === 1, 'a second failure updates the strip rather than stacking a second one');
  ok(text(saveFailureElement()).includes('ENOSPC'), 'with the newer reason');
}

console.log('\n-- and it goes away when it stops being true');
{
  clearSaveFailure();
  ok(saveFailureElement() === null, 'clearing drops the reference');
  ok(indicators().length === 0, 'and takes the element out of the document');
  clearSaveFailure();
  ok(indicators().length === 0, 'clearing again is a no-op, not a throw');
}

console.log('\n-- the whole chain: a push from main raises it, the next good save lowers it');
{
  const bridge = fakeBridge();
  // Wired exactly as `src/main.js` wires it.
  initDesktopStore(fakeStorage(), bridge, {
    debounceMs: 0,
    onSaveStatus: ({ ok: good, reason }) => { if (good) clearSaveFailure(); else showSaveFailure(reason); },
  });

  bridge._push({ ok: false, reason: 'EACCES: permission denied' });
  ok(saveFailureElement() !== null, 'a main-process failure raises the indicator');
  ok(text(saveFailureElement()).includes('EACCES'), 'carrying the reason across the bridge');

  bridge._push({ ok: true, reason: null });
  ok(saveFailureElement() === null, 'the next successful save clears it');

  // A malformed push must not silently read as success -- that is the failure
  // mode this whole feature exists to remove.
  bridge._push({});
  ok(saveFailureElement() !== null, 'a status with no ok flag is treated as a failure, not a success');
  clearSaveFailure();
}

console.log('\n-- a bridge that throws on save is the same news, one step earlier');
{
  const bridge = fakeBridge();
  bridge.saveStore = () => { throw new Error('bridge is gone'); };
  const store = initDesktopStore(fakeStorage(), bridge, {
    debounceMs: 0,
    onSaveStatus: ({ ok: good, reason }) => { if (good) clearSaveFailure(); else showSaveFailure(reason); },
  });
  store.flush();
  ok(saveFailureElement() !== null, 'a throwing saveStore raises the indicator too');
  ok(text(saveFailureElement()).includes('bridge is gone'), 'with the thrown message as the reason');
  clearSaveFailure();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
