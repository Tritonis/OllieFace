/**
 * One accepted Steam invite, delivered exactly once, to a page that is
 * listening.
 *
 * There are THREE ways an accepted invite reaches this process, and the
 * dangerous thing they have in common is that none of them waits for the page:
 *
 *  1. The game was closed. Steam launches it with `+connect_lobby <id>`, which
 *     is over before a window exists, let alone a bundle.
 *  2. The game was running. Steam launches it AGAIN; the single-instance lock
 *     turns that into `second-instance`, and the second command line carries
 *     the id.
 *  3. The game was running and the Binding heard `GameLobbyJoinRequested`
 *     (callback 333). Registered in `registerSteamBridge()`, which runs BEFORE
 *     `app.whenReady()` — so this one can fire with no window at all.
 *
 * All three used to end in a `webContents.send`, and a send is not a delivery:
 * `pushToRenderer` no-ops when there is no window, and a push into a page whose
 * bundle has not run yet lands where nothing is listening and is gone. A player
 * who watched Steam accept an invite then sees the game ignore it. So delivery
 * is routed through here instead, and the rule is the same whichever way the
 * invite arrived.
 *
 * WHAT COUNTS AS LISTENING. Not a window — `mainWindow` is constructed long
 * before the bundle runs. The proof is the renderer ASKING for its parked
 * invite: `bindSteam` subscribes to `steam:join-requested` and only then calls
 * `collect()`, so a `collect()` that has happened is proof the subscription
 * exists. Before that, every invite parks.
 *
 * ONE INVITE, ONE PARK, and never both a park and a push — an id that is pushed
 * is not left parked for `collect()` to hand over a second time, which would
 * drag the player into the same lobby twice. A second invite arriving before
 * the first is collected replaces it: what the player last accepted is where
 * they meant to go.
 *
 * Deliberately imports nothing — not Electron, not the Binding — so the whole
 * of this decision is exercisable in plain node.
 */

/**
 * @param {{
 *   push: (lobbyId: string) => void,
 *   windowAlive: () => boolean,
 *   initial?: string|null,
 * }} deps
 */
export function createJoinDelivery({ push, windowAlive, initial = null }) {
  let parked = typeof initial === 'string' && initial ? initial : null;
  let subscribed = false;

  return {
    /**
     * An invite arrived, by any of the three routes.
     * @returns {'pushed'|'parked'|'ignored'} what became of it. The return is
     *   for tests and logging; no caller branches on it.
     */
    offer(lobbyId) {
      if (typeof lobbyId !== 'string' || !lobbyId) return 'ignored';
      if (subscribed && windowAlive()) { push(lobbyId); return 'pushed'; }
      parked = lobbyId;
      return 'parked';
    },

    /**
     * The renderer asking for whatever is parked. Marks the subscription live
     * — even when there is nothing to hand over, because what the ask records
     * is that a page is listening, not that an invite arrived.
     * @returns {string|null}
     */
    collect() {
      subscribed = true;
      const lobbyId = parked;
      parked = null;
      return lobbyId;
    },

    /**
     * The page that held the subscription is gone: a main-frame navigation, a
     * dead renderer, the window closing. Anything pushed from here until the
     * next `collect()` would land nowhere, so the next invite parks again.
     * Whatever is ALREADY parked stays parked — a reload is not a refusal.
     */
    release() { subscribed = false; },

    /** Test seam only. */
    get state() { return { parked, subscribed }; },
  };
}
