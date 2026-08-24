// src/core/InputMute.js
//
// One owner for `input.enabled` (#197).
//
// Three unrelated parts of the build take the stick away from the player, and
// each of them used to do it by writing the boolean directly:
//
//  · `Progression._startTransition` — the player is a passenger for the length
//    of a stage change, and must not be killed while holding no controls.
//  · `NetHost._holdSession` — a co-op host standing at a menu is looking at a
//    world somebody else is still playing, and must not be driving a survivor
//    in it.
//  · `FallbackPause.setFallbackPause` — the same rule again, off its own
//    predicate, for the packaged shell where `ctx.menus` does not exist.
//
// A boolean cannot represent three simultaneous claims, and the writers do not
// run on the same clock: the transition writes twice (once at each end, the
// second time restoring a value *saved before the other two had spoken*),
// `_holdSession` writes every frame, and the pause overlay writes only on a
// toggle. Open the overlay during a stage change and the transition's restore
// handed the stick back under an open menu, with nothing left that would ever
// take it away again — the run keeps being driven from the pause screen.
//
// So the boolean stops being written and starts being *derived*. Each claimant
// names itself; `enabled` is true exactly when nobody is claiming. Order stops
// mattering, a stale save cannot outvote a live claim, and releasing one claim
// can no longer release another's.
//
// Deliberately the whole mechanism: a `Set` on the input object, no lifecycle,
// no registration. `enabled` stays a plain boolean because
// `Player._sampleCommand` and `CameraRig` read it and should not have to know
// any of this exists.

/**
 * Claim or release the input mute on behalf of one owner.
 *
 * @param {{enabled?: boolean}|null|undefined} input - `ctx.input`; a missing
 *   one is not an error, plenty of headless contexts have none.
 * @param {string} reason - the claimant's stable name. Same string to release.
 * @param {boolean} muted - true to claim, false to release.
 */
export function muteInput(input, reason, muted) {
  if (!input) return;
  const claims = (input.muteClaims ??= new Set());
  if (muted) claims.add(reason);
  else claims.delete(reason);
  input.enabled = claims.size === 0;
}

/** Whether `reason` currently holds a claim. For tests and diagnostics. */
export function inputMutedBy(input, reason) {
  return !!input?.muteClaims?.has(reason);
}
