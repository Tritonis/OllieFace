/**
 * One-time adoption of a `localStorage` key that was renamed under a player.
 *
 * The game shipped as Petrichor and is now Telluric Void. Five keys carry the
 * old name — the profile, the settings blob, the artifact/difficulty selection,
 * the GPU notice dismissal, and the `net.*` prefix. Renaming them outright
 * would read as a save wipe to everyone who already played: a fresh profile, a
 * quality slider back at its default, and the banner they dismissed returning.
 *
 * So every read of a renamed key goes through here first. The rule is the same
 * everywhere and deliberately dull:
 *
 *   - new key present  -> that value wins, and the old key is dropped. The old
 *     one is *removed* rather than left because leaving it makes the check
 *     re-run for the life of the install, and any later reader that fell back
 *     to it would resurrect a profile the player has moved past.
 *   - only the old key -> its bytes are copied to the new key, the old key is
 *     removed, and the bytes are returned.
 *   - neither          -> null, and nothing is written. A fresh install must
 *     not leave a trail of empty keys behind it.
 *
 * The value is moved as bytes, never parsed. Every call site already turns an
 * unreadable blob into a working default; validating here would be a second
 * copy of that judgement, free to disagree with the first.
 */
export function adoptLegacyKey(key, legacyKey, storage = globalThis.localStorage) {
  if (!storage) return null;

  const current = storage.getItem(key);
  if (current !== null && current !== undefined) {
    try { storage.removeItem(legacyKey); } catch { /* see below */ }
    return current;
  }

  const legacy = storage.getItem(legacyKey);
  if (legacy === null || legacy === undefined) return null;

  // A write that fails (quota, a storage partition that went away) must not
  // take the removal with it — losing the copy *and* the original is the one
  // outcome worse than migrating again on the next boot.
  try {
    storage.setItem(key, legacy);
    storage.removeItem(legacyKey);
  } catch { /* retried next boot */ }

  return legacy;
}
