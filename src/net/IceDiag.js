/**
 * ICE diagnostics — the connection can explain itself.
 *
 * A WebRTC connection that never forms behind a strict NAT fails silently:
 * no error, no exception, just a co-op screen that says "connecting..."
 * forever. `summarizeStats` turns one `pc.getStats()` report into the
 * handful of facts a player (or a bug report) actually needs, and
 * `attachIceDiag` keeps that summary current while the lobby screen is open.
 */

const POLL_MS = 2000;

/**
 * Pure reduction over the iterable `pc.getStats()` resolves to.
 *
 * `gathering` and `turnConfigured` cannot be derived from the stats report
 * itself — the former is `pc.iceGatheringState`, the latter comes from
 * `iceServers()` — so the caller supplies both.
 *
 * `RTCStatsReport` is Map-like: its default iterator (what a bare `for...of`
 * uses) yields `[id, statsObject]` pairs, not the stats objects themselves —
 * the same protocol as `Map.prototype[Symbol.iterator]`. `entries.values()`
 * is called whenever it exists to unwrap that correctly; a plain array also
 * has a `.values()` (Array.prototype's own) that yields its own elements
 * unchanged, so the one check below handles a real `RTCStatsReport`, a `Map`
 * built to look like one, and a bare array of already-unwrapped objects.
 */
export function summarizeStats(statsIterable, { gathering = 'new', turnConfigured = false } = {}) {
  const candidates = new Map();  // id -> candidateType
  const localTypes = [];
  const remoteTypes = [];
  let selectedPair = null;

  const entries = typeof statsIterable?.values === 'function'
    ? statsIterable.values() : statsIterable;
  for (const entry of entries) {
    if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') {
      candidates.set(entry.id, entry.candidateType);
      const list = entry.type === 'local-candidate' ? localTypes : remoteTypes;
      if (!list.includes(entry.candidateType)) list.push(entry.candidateType);
    } else if (entry.type === 'candidate-pair') {
      // First qualifying pair wins rather than last: a stats report can carry
      // a stale `succeeded` pair from before an ICE restart alongside a fresh
      // one, and iteration order is not a guarantee either way, so "first
      // seen" is at least a stated, stable rule rather than an accidental one.
      if (!selectedPair && (entry.state === 'succeeded' || entry.nominated === true)) selectedPair = entry;
    }
  }

  let selected = null;
  if (selectedPair) {
    const local = candidates.get(selectedPair.localCandidateId);
    const remote = candidates.get(selectedPair.remoteCandidateId);
    selected = {
      local,
      remote,
      rttMs: typeof selectedPair.currentRoundTripTime === 'number'
        ? Math.round(selectedPair.currentRoundTripTime * 1000)
        : null,
    };
  }

  return { gathering, localTypes, remoteTypes, selected, turnConfigured };
}

/**
 * Poll `peer.pc.getStats()` every `POLL_MS` while the connection lives, and
 * hand the reduced summary to `onUpdate`. `summary.completeForMs` is how long
 * `iceGatheringState` has been `'complete'`, which is what the panel's "no
 * route found 15 s after gathering finished" verdict needs — anchored to the
 * transition this poller itself observes, not to when the poller happened to
 * attach. A panel opened mid-gathering (or reopened later, onto an already-
 * complete connection) still gets the transition-relative window this way;
 * `null` while gathering has not reached `'complete'` yet.
 *
 * If gathering was already `'complete'` on this poller's very first tick, the
 * transition itself was never observed — the moment this poller noticed is
 * the least-wrong epoch available (the true transition can only be earlier,
 * so this under-counts elapsed time rather than over-counting it, which is
 * the safer direction for an alarming verdict).
 *
 * Returns a detach function; calling it clears the interval, so a closed
 * lobby screen costs nothing. Imported only by the lobby UI (see
 * `src/ui/Menus.js`) — a build that never opens the co-op screen never pays
 * for a timer.
 */
export function attachIceDiag(peer, onUpdate, { turnConfigured = false, pollMs = POLL_MS } = {}) {
  const pc = peer?.pc;
  if (!pc) return () => {};

  let completeAt = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let stats;
    try { stats = await pc.getStats(); } catch { return; }
    if (stopped) return;
    const gathering = pc.iceGatheringState;
    if (gathering === 'complete' && completeAt === null) completeAt = Date.now();
    const summary = summarizeStats(stats, { gathering, turnConfigured });
    summary.completeForMs = completeAt === null ? null : Date.now() - completeAt;
    onUpdate(summary);
  };

  tick();
  const timer = setInterval(tick, pollMs);
  timer?.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
