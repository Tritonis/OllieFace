/**
 * DesktopStore: hydrate localStorage from the desktop save file at boot,
 * mirror every `telluric.` / `net.` write back through the bridge, debounced,
 * atomically ordered. No bridge -> inert no-op.
 */
import { initDesktopStore, MIRROR_PREFIXES } from '../src/core/DesktopStore.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
  if (!pass) failures++;
};

// A faithful-enough localStorage: string map + the real method surface.
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}
// The bridge answers { ok, raw }. ok:false means the file is there and could
// not be read (locked, EACCES); raw:null with ok:true means there is no file
// yet. Only the second is a first boot.
function fakeBridge(raw = null, ok = true) {
  const saves = [];
  return { loadStore: () => ({ ok, raw }), saveStore: (json) => saves.push(json), _saves: saves };
}
const settle = () => new Promise((res) => setTimeout(res, 10));

// 1. No bridge: inert, storage untouched, flush callable.
{
  const s = fakeStorage({ 'telluric.profile': '{"v":3}' });
  const r = initDesktopStore(s, undefined);
  check('no bridge -> inactive', r.active === false && r.hydrated === false);
  s.setItem('telluric.profile', '{"v":4}');
  r.flush();
  check('no bridge -> setItem still works, nothing mirrored', s.getItem('telluric.profile') === '{"v":4}');
}

// 2. Hydration: file keys land in storage, non-prefixed file keys are ignored.
{
  const s = fakeStorage();
  const b = fakeBridge(JSON.stringify({ 'telluric.profile': '{"v":3}', 'net.name': 'olli', 'evil': 'x' }));
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  check('hydrates prefixed keys', s.getItem('telluric.profile') === '{"v":3}' && s.getItem('net.name') === 'olli');
  check('ignores non-prefixed keys', s.getItem('evil') === null);
  check('reports active + hydrated', r.active === true && r.hydrated === true);
}

// 3. First boot (no file): existing localStorage migrates out on first flush.
{
  const s = fakeStorage({ 'telluric.profile': '{"v":3}', 'unrelated': 'y' });
  const b = fakeBridge(null);
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  await settle();
  check('no file at all -> the first-boot migration flush does fire', b._saves.length === 1);
  r.flush();
  const snap = JSON.parse(b._saves.at(-1));
  check('migration snapshot has the prefixed key', snap['telluric.profile'] === '{"v":3}');
  check('migration snapshot omits unrelated keys', !('unrelated' in snap));
}

// 4. Mirroring: a patched setItem schedules a snapshot; corrupt file does not throw.
{
  const s = fakeStorage();
  const b = fakeBridge(null);
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  s.setItem('telluric.gpuNoticeDismissed', '1');
  s.setItem('ephemeral', 'z');
  r.flush();
  const snap = JSON.parse(b._saves.at(-1));
  check('mirrors prefixed writes', snap['telluric.gpuNoticeDismissed'] === '1');
  check('omits non-prefixed writes', !('ephemeral' in snap));

  const s2 = fakeStorage({ 'telluric.profile': '{"v":3}' });
  const b2 = fakeBridge('{not json');
  const r2 = initDesktopStore(s2, b2, { debounceMs: 0 });
  check('corrupt file -> boots inert-hydrated, storage untouched',
    r2.active === true && r2.hydrated === false && s2.getItem('telluric.profile') === '{"v":3}');
}

// 4b. A corrupt file is NOT a first boot: boot must schedule no write at all,
// or the debounce commits an empty snapshot over a file still repairable by
// hand (final-review Major 1, the JSON.parse half).
{
  const s = fakeStorage();
  const b = fakeBridge('{"telluric.profile": "{\\"level\\":42}"');   // truncated
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  await settle();
  check('corrupt file -> no boot flush scheduled', b._saves.length === 0);
  s.setItem('telluric.profile', '{"level":43}');
  r.flush();
  check('corrupt file -> a real gameplay write still mirrors',
    JSON.parse(b._saves.at(-1))['telluric.profile'] === '{"level":43}');
}

// 4c. An unreadable file (EACCES/EBUSY -- Steam Cloud, antivirus, a backup
// agent holding the handle) is not a first boot either. This is the path that
// silently erased a real profile: null-for-every-error made a locked file look
// like a fresh install and the migration flush wrote {} over it.
{
  const s = fakeStorage({ 'telluric.stale': 'x' });
  const b = fakeBridge(null, false);
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  await settle();
  check('unreadable file -> active but not hydrated', r.active === true && r.hydrated === false);
  check('unreadable file -> no boot flush scheduled, nothing overwrites the file', b._saves.length === 0);
  check('unreadable file -> storage left as it was', s.getItem('telluric.stale') === 'x');
}

// 5. Shutdown flush: the debounce must not eat the last write of a session.
// Node has no `globalThis.addEventListener`, so shim one to capture the
// handler the module registers, then fire it as the window close would.
{
  const listeners = [];
  const hadAEL = 'addEventListener' in globalThis;
  const prevAEL = globalThis.addEventListener;
  globalThis.addEventListener = (type, fn) => { listeners.push([type, fn]); };
  let b;
  try {
    const s = fakeStorage();
    b = fakeBridge(JSON.stringify({ 'telluric.profile': '{"v":3}' }));
    initDesktopStore(s, b, { debounceMs: 60_000 });
    s.setItem('telluric.profile', '{"v":9}');
    check('pagehide handler registered', listeners.some(([t]) => t === 'pagehide'));
    check('debounce still pending -> nothing written yet', b._saves.length === 0);
    for (const [t, fn] of listeners) if (t === 'pagehide') fn();
  } finally {
    if (hadAEL) globalThis.addEventListener = prevAEL;
    else delete globalThis.addEventListener;
  }
  const snap = JSON.parse(b._saves.at(-1));
  check('pagehide flushes the pending write', b._saves.length === 1 && snap['telluric.profile'] === '{"v":9}');
}

check('prefixes are the documented pair', JSON.stringify(MIRROR_PREFIXES) === '["telluric.","net."]');
process.exit(failures ? 1 : 0);
