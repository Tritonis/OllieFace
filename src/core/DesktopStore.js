/**
 * The desktop save mirror.
 *
 * In the browser this module is a no-op: no bridge, nothing changes, and the
 * game's storage story is exactly what it was. Under the Electron shell the
 * preload exposes `__DESKTOP__` and this module does two things at boot:
 *
 *   1. Hydrate: the save file (one JSON object, key -> string) is copied into
 *      localStorage for every key matching MIRROR_PREFIXES. The file is the
 *      desktop source of truth; localStorage stays the live store the six
 *      existing call sites keep talking to.
 *   2. Mirror: localStorage.setItem/removeItem are wrapped so any write to a
 *      prefixed key schedules a debounced snapshot of ALL prefixed keys back
 *      through the bridge. First boot (no file yet) migrates the browser-era
 *      profile out on the first flush.
 *
 * Why localStorage stays live instead of being replaced: docs/STEAM.md's
 * actual requirement is a single JSON file Steam Cloud can sync; the six call
 * sites (Profile, GpuNotice, Artifacts, NetConfig, Menus, LegacyStorage) are
 * all correct against localStorage today, and the mirror gets the file
 * without rewriting any of them. The wrap must survive future call sites too,
 * which per-site rewrites would not.
 */
// 'telluric.' is the complete live key set (Profile, GpuNotice, Artifacts,
// Menus settings, and NetConfig's telluric.net.*). Bare 'net.' matches no
// live key today and is reserved headroom only.
export const MIRROR_PREFIXES = ['telluric.', 'net.'];

const mirrored = (k) => MIRROR_PREFIXES.some((p) => String(k).startsWith(p));

export function initDesktopStore(
  storage = globalThis.localStorage,
  bridge = globalThis.__DESKTOP__,
  { debounceMs = 250 } = {},
) {
  if (!bridge || typeof bridge.loadStore !== 'function' || typeof bridge.saveStore !== 'function' || !storage) {
    return { active: false, hydrated: false, flush: () => {} };
  }

  let hydrated = false;
  // Only a file that genuinely is not there earns the first-boot migration
  // flush. An unreadable file (locked by Steam Cloud, antivirus, a backup
  // agent) and a corrupt one both leave this false, so boot writes NOTHING
  // and the bytes on disk survive until real gameplay produces a real save.
  let firstBoot = false;
  try {
    const { ok, raw } = bridge.loadStore() ?? { ok: false, raw: null };
    if (!ok) {
      console.error('DesktopStore: save file could not be read; not migrating, leaving the file alone');
    } else if (raw == null) {
      firstBoot = true;
    } else {
      const file = JSON.parse(raw);
      for (const [k, v] of Object.entries(file)) {
        if (mirrored(k) && typeof v === 'string') storage.setItem(k, v);
      }
      hydrated = true;
    }
  } catch (e) {
    // A corrupt save file must never brick the boot: keep whatever
    // localStorage has and mirror from here on. But do not schedule a flush --
    // that would commit an empty snapshot over a file a human could still
    // repair by hand. The next real write is what replaces it.
    console.error('DesktopStore: save file unparseable, continuing from localStorage', e);
  }

  const snapshot = () => {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k != null && mirrored(k)) out[k] = storage.getItem(k);
    }
    return out;
  };

  let timer = 0;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    try { bridge.saveStore(JSON.stringify(snapshot())); }
    catch (e) { console.error('DesktopStore: saveStore failed', e); }
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
  };

  // Storage is a legacy platform object with a named setter: assigning
  // `storage.setItem = fn` stores a phantom item named "setItem" and leaves
  // the real prototype method in place -- the mirror would never install in
  // a real renderer while plain-object test fakes pass green. So: patch own
  // methods when they are own properties (test fakes), else patch the
  // prototype (real Storage), guarded on `this` so sessionStorage never
  // joins the mirror.
  // Idempotent: a second init on the same storage (or the same
  // Storage.prototype) would stack a second wrapper, giving every write two
  // schedules and two independent debounce timers.
  const wrap = (obj, name, guardThis) => {
    const raw = obj[name];
    if (raw.__telluricMirror) return;
    obj[name] = function (...a) {
      const out = raw.apply(this, a);
      if ((!guardThis || this === storage) && mirrored(a[0])) schedule();
      return out;
    };
    obj[name].__telluricMirror = true;
  };
  if (Object.prototype.hasOwnProperty.call(storage, 'setItem')) {
    wrap(storage, 'setItem'); wrap(storage, 'removeItem');
  } else {
    const proto = Object.getPrototypeOf(storage);
    wrap(proto, 'setItem', true); wrap(proto, 'removeItem', true);
  }

  // The debounce must never eat the last write of a session: flush on
  // pagehide (fires on window close in Chromium/Electron; a no-op addend in
  // headless node where addEventListener is absent).
  globalThis.addEventListener?.('pagehide', flush);

  // First boot on desktop: nothing on disk yet -> migrate the browser-era
  // keys out immediately rather than waiting for the first gameplay write.
  if (firstBoot) schedule();

  return { active: true, hydrated, flush };
}
