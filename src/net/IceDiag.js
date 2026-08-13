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
 */
export function summarizeStats(statsIterable, { gathering = 'new', turnConfigured = false } = {}) {
  const candidates = new Map();  // id -> candidateType
  const localTypes = [];
  const remoteTypes = [];
  let selectedPair = null;

  for (const entry of statsIterable) {
    if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') {
      candidates.set(entry.id, entry.candidateType);
      const list = entry.type === 'local-candidate' ? localTypes : remoteTypes;
      if (!list.includes(entry.candidateType)) list.push(entry.candidateType);
    } else if (entry.type === 'candidate-pair') {
      if (entry.state === 'succeeded' || entry.nominated === true) selectedPair = entry;
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
 * hand the reduced summary to `onUpdate`. `summary.elapsedMs` is how long
 * this poller has been attached, which is what the panel's "no route found
 * after 15 s" verdict needs and cannot get from a stats report itself.
 *
 * Returns a detach function; calling it clears the interval, so a closed
 * lobby screen costs nothing. Imported only by the lobby UI (see
 * `src/ui/Menus.js`) — a build that never opens the co-op screen never pays
 * for a timer.
 */
export function attachIceDiag(peer, onUpdate, { turnConfigured = false, pollMs = POLL_MS } = {}) {
  const pc = peer?.pc;
  if (!pc) return () => {};

  const startedAt = Date.now();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let stats;
    try { stats = await pc.getStats(); } catch { return; }
    if (stopped) return;
    const summary = summarizeStats(stats, { gathering: pc.iceGatheringState, turnConfigured });
    summary.elapsedMs = Date.now() - startedAt;
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
