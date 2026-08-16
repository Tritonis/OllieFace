/**
 * The single writer behind `store:save`.
 *
 * The save path used to be `fs.writeFileSync` plus `statSync`/`copyFileSync`
 * around it, called straight from the IPC handler. Two problems, one visible
 * and one not. The visible one is that every one of those calls parks the main
 * process on a disk that may be a spinning platter behind an antivirus filter
 * driver, and the main process is where the window's own event loop lives — a
 * save during play was a stutter. The invisible one is that `writeFileSync`
 * only *looks* serialised: two flushes arriving in the same tick each ran to
 * completion, so the second one's bytes always won even when the first one's
 * snapshot was newer, and there was no ordering guarantee worth the name.
 *
 * So: one writer, asynchronous, and exactly one write in flight. Requests do
 * not queue, they COALESCE — a save is a snapshot of the whole mirrored key
 * set, so three requests arriving during one write are three descriptions of
 * the same file and only the newest is worth writing. Queueing them would burn
 * two writes producing bytes nobody will ever read, and would push the write
 * that matters further behind.
 *
 * Durability is tmp -> fsync -> rename, in that order and with the fsync
 * mattering as much as the rename. `rename` is atomic against a crash of the
 * *process*, but without the fsync it is not atomic against a loss of *power*
 * or a hard kill of the machine: the directory entry can reach the platter
 * while the tmp file's data is still in the page cache, and the save comes back
 * as a correctly-named file full of zeroes. The old code had the rename and not
 * the fsync.
 *
 * Electron-free on purpose, like `steam.mjs`: `savePath` and `fs` are injected,
 * which is what makes the coalescing and the write ordering testable in plain
 * node rather than only observable in a packaged build.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * A ceiling on an accepted snapshot. The real save is a few kilobytes of
 * profile, settings and artifact state; a megabyte is three orders of
 * magnitude of headroom and still small enough that a renderer looping a
 * `setItem` cannot grow the file until the disk is full.
 */
export const MAX_SNAPSHOT_BYTES = 1 << 20;

/** Refusals carry this so the retry loop knows not to bother. Retrying a
 *  snapshot the main process has already judged unacceptable just fails
 *  identically three times and reports the same reason later. */
class RefusedError extends Error {
  constructor(message) { super(message); this.name = 'RefusedError'; this.permanent = true; }
}

/**
 * The shape half of the bound. There is no version integer in this format —
 * the file is a flat `key -> string` mirror of localStorage and nothing has
 * ever written a header into it — so the schema that can actually be checked
 * is the one the format really has: a plain object whose every value is a
 * string. Anything else did not come from `DesktopStore.snapshot`, and writing
 * it would hand the next boot's hydrate a value it will silently skip.
 *
 * @returns {string|null} a reason to refuse, or null to accept.
 */
export function checkSnapshot(json) {
  if (typeof json !== 'string') return 'the snapshot was not a string';
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) return `the snapshot is ${bytes} bytes, over the ${MAX_SNAPSHOT_BYTES} limit`;
  let parsed;
  try { parsed = JSON.parse(json); }
  catch { return 'the snapshot is not valid JSON'; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the snapshot is not a JSON object';
  for (const v of Object.values(parsed)) {
    if (typeof v !== 'string') return 'the snapshot holds a non-string value';
  }
  return null;
}

/** Is this the empty object? Kept separate from `checkSnapshot` because an
 *  empty snapshot is only a refusal when there is something on disk to lose. */
const isEmptySnapshot = (json) => {
  try { return Object.keys(JSON.parse(json)).length === 0; }
  catch { return false; }
};

/** One line a human can act on, from an error that may carry a stack, a path
 *  and an errno. Bounded: it crosses IPC and lands in a fixed-width banner. */
const describe = (err) => {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  return `${code ? `${code}: ` : ''}${message}`.slice(0, 200);
};

/**
 * @param {{
 *   savePath: () => string,
 *   fs?: object,
 *   onStatus?: (status: { ok: boolean, reason: string|null }) => void,
 *   maxRetries?: number,
 *   retryDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (message: string) => void,
 * }} deps
 */
export function createSaveWriter({
  savePath,
  fs = fsp,
  onStatus = () => {},
  maxRetries = 2,
  retryDelayMs = 150,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = (message) => { console.error(message); },
} = {}) {
  /** The newest snapshot nobody has written yet, or null. At most one: this
   *  field IS the coalescing. */
  let pending = null;
  /** The in-flight drain, or null. At most one: this field IS the single
   *  writer. */
  let draining = null;
  /** One backup per session: the first write of a run preserves the file the
   *  player launched with, and later writes do not churn over it. */
  let backedUp = false;
  /** The last status the renderer was told, so a save every 250 ms of play
   *  does not become an IPC message every 250 ms of play. Starts unknown, so
   *  the first result of either polarity is reported. */
  let lastOk = null;

  /**
   * Run one of the two injected callbacks and swallow whatever it does.
   *
   * `onStatus` and `log` are foreign code — whatever the caller passed, doing
   * whatever it does — and both are called from inside `writeOnce`'s `catch`,
   * where a throw has nothing above it to land
   * on. It would reject the drain promise, skip the `draining = null` that
   * lets the next drain start, and leave `save()` accepting snapshots into a
   * `pending` nobody will ever read: every save for the life of the process,
   * lost in silence. The `finally` in `drain` is the structural guard against
   * that; this is the one that stops it happening in the first place.
   */
  const safely = (fn) => {
    try { fn(); }
    catch (err) {
      // Last resort, and never `log` — `log` is one of the two things that may
      // just have thrown.
      try { console.error('store:save: a save-status callback threw', err); } catch { /* nothing left */ }
    }
  };

  const report = (ok, reason) => {
    if (!ok) safely(() => log(`store:save failed: ${reason}`));
    // The latch is assigned before the callback runs, but do not read that as
    // load-bearing: `safely` already returns control whatever the subscriber
    // does, so moving this below the call would behave identically today. It
    // is belt-and-braces, and it is where it is only because a latch that is
    // set before the thing it guards needs one less argument to be sure of.
    if (lastOk === ok) return;
    lastOk = ok;
    safely(() => onStatus({ ok, reason: ok ? null : reason }));
  };

  const sizeOf = async (file) => {
    try { return (await fs.stat(file)).size; }
    catch { return -1; }
  };

  /** Write the snapshot, or throw. Everything durability-related lives here. */
  async function commit(json) {
    const target = savePath();
    const existing = await sizeOf(target);

    // An empty snapshot over a non-empty save is data loss, never intent: no
    // gameplay path clears every mirrored key at once. The renderer already
    // refuses to migrate after a failed read; this is the second half of the
    // chain, so a future renderer bug cannot erase the file either.
    if (existing > 2 && isEmptySnapshot(json)) {
      throw new RefusedError('an empty snapshot would have erased a non-empty save');
    }

    await fs.mkdir(path.dirname(target), { recursive: true });

    // A backup is only worth taking if it does not shrink: one generation of
    // grace is all there is, and overwriting it with less than it holds spends
    // it.
    if (!backedUp && existing >= 0) {
      const bak = `${target}.bak`;
      if (existing >= await sizeOf(bak)) await fs.copyFile(target, bak);
      else log('store:save: kept the larger save.json.bak');
      backedUp = true;
    }

    const tmp = `${target}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  }

  async function writeOnce(json) {
    const refusal = checkSnapshot(json);
    if (refusal !== null) { report(false, refusal); return; }

    for (let attempt = 0; ; attempt++) {
      try {
        await commit(json);
        report(true, null);
        return;
      } catch (err) {
        if (err instanceof RefusedError) { report(false, err.message); return; }
        // A newer snapshot has already arrived, so this one describes a state
        // the player has left. Abandoning the retries hands the drain loop
        // straight to the fresh snapshot, which answers the same question —
        // "is the disk writable?" — sooner and with the right bytes.
        if (pending !== null) return;
        if (attempt >= maxRetries) { report(false, describe(err)); return; }
        // Linear backoff. The failures worth retrying here are the transient
        // exclusive-lock ones — Steam Cloud syncing the file, an antivirus
        // scanning it, a backup agent holding the handle — and those clear in
        // hundreds of milliseconds or not at all.
        await sleep(retryDelayMs * (attempt + 1));
        if (pending !== null) return;
      }
    }
  }

  async function drain() {
    try {
      while (pending !== null) {
        const json = pending;
        pending = null;
        // `pending` is already cleared, so this loop cannot spin on a snapshot
        // that keeps throwing: it turns over only when a genuinely new save
        // has arrived. Catching here rather than letting the drain reject
        // means one unforeseen throw costs one snapshot, not the session.
        try { await writeOnce(json); }
        catch (err) { safely(() => log(`store:save: the writer itself threw: ${describe(err)}`)); }
      }
    } finally {
      // In a `finally`, and inside `drain` rather than on the caller's side.
      //
      // Inside, because it must run in the same tick as the loop's last
      // condition check: a `.finally()` chained onto the promise clears one
      // microtask late, and a `save()` landing in that window would set
      // `pending`, find `draining` still truthy, and never be written.
      //
      // A `finally`, because before this was one it was a plain statement
      // after the loop — and a throw from the injected `onStatus` on the
      // refusal or retry-exhausted paths skipped straight past it. `draining`
      // stayed set to a rejected promise, which is still truthy, so `save()`
      // never started another drain and every subsequent save in the process
      // was accepted and silently dropped. The guard is structural on purpose:
      // it holds for whatever the next unforeseen throw turns out to be.
      draining = null;
    }
  }

  return {
    /**
     * Request that `json` become the save file. Fire-and-forget by contract —
     * the returned promise exists so tests can await the writer settling, not
     * so callers can await a save.
     */
    save(json) {
      pending = String(json);
      if (!draining) draining = drain();
      return draining;
    },
    /** Resolves when nothing is in flight and nothing is pending. */
    idle() { return draining ?? Promise.resolve(); },
    /** True while a write is in flight or a snapshot is waiting behind one. */
    get busy() { return draining !== null; },
  };
}

/**
 * How long quitting waits for a write that is already going.
 *
 * The write path's own worst case is bounded and known: three attempts with
 * 150 ms and 300 ms of backoff between them, so 450 ms of waiting plus three
 * disk round-trips. Two seconds covers that with room for a slow platter and
 * still reads as a shutdown rather than a hang.
 *
 * It is a CEILING and not a wait, because the failure this exists for is a
 * contended disk, and a disk contended enough to lose a save is exactly the
 * one that can leave a handle wedged. A player must always be able to quit. So
 * the bad case costs two seconds and loses the last write — precisely what
 * happened before, unbounded — and the ordinary case costs nothing at all.
 */
export const QUIT_DRAIN_CEILING_MS = 2000;

/**
 * Wait, bounded, for the writer to settle before the process goes.
 *
 * The `pagehide` flush in `DesktopStore` hands the main process one last
 * snapshot and does not wait for it, and quitting used to not wait either.
 * Crash-atomicity does not cover this: `tmp -> fsync -> rename` guarantees the
 * file is never *corrupt*, and says nothing about the last write being
 * *present*. Under the disk contention this whole feature exists for, the
 * retry budget made that window wider than the old synchronous handler's — a
 * player quitting just after a notable event lost it, silently.
 *
 * Timers are injected so the ceiling is testable without spending it.
 *
 * @returns {Promise<'nothing-pending'|'idle'|'timeout'>} never rejects.
 */
export function drainBeforeQuit(writer, {
  ceilingMs = QUIT_DRAIN_CEILING_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!writer || !writer.busy) return Promise.resolve('nothing-pending');
  return new Promise((resolve) => {
    const timer = setTimer(() => resolve('timeout'), ceilingMs);
    // Settled either way: a drain that rejected still means nothing more is
    // going to be written, and holding the quit open for it would be the same
    // hang from a different direction.
    const done = () => { clearTimer(timer); resolve('idle'); };
    Promise.resolve(writer.idle()).then(done, done);
  });
}

/**
 * The `before-quit` handler, as a state machine, because a boolean is not
 * enough and the way it is not enough is invisible from the call site.
 *
 * Electron resets its own `is_quitting_` the instant a handler calls
 * `preventDefault()` (`shell/browser/browser.cc`, `Browser::Quit`), so a
 * SECOND quit request — the player hitting Quit again, Alt+F4, the task
 * manager — re-emits `before-quit` while the first drain is still going. A
 * two-state latch that says "I have already started draining, let this one
 * through" reads that as permission to shut down mid-write, which loses
 * exactly the save this whole hook exists to keep. The middle state has to
 * refuse the quit, not wave it past.
 *
 *   idle     -> prevent, start the one drain, become draining
 *   draining -> prevent AGAIN and do nothing else; the running drain owns the
 *               eventual quit, so a second request cannot start a second drain
 *               nor extend the wait past the single ceiling
 *   done     -> let it go; this is the drain's own `quit()` coming back round
 *
 * An idle writer never reaches the machine at all: with nothing in flight
 * there is nothing to wait for, and preventing a quit only to re-issue it is a
 * needless trip through the event loop.
 *
 * @returns {(event: { preventDefault: () => void }) => void}
 */
export function createQuitGuard(writer, {
  quit,
  drain = drainBeforeQuit,
  log = (message) => { console.error(message); },
} = {}) {
  let state = 'idle';
  return (event) => {
    if (state === 'done') return;
    if (state === 'idle' && !writer.busy) return;
    event.preventDefault();
    if (state === 'draining') return;
    state = 'draining';
    drain(writer).then((outcome) => {
      if (outcome === 'timeout') log('store:save: quitting without waiting further for the save');
      state = 'done';
      quit();
    });
  };
}
