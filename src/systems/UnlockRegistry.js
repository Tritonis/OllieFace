/**
 * The seam between "content that exists" and "content that must be earned".
 *
 * ## Why this module exists at all
 *
 * `data/challenges.js` may not import a content catalogue — it is imported by
 * `systems/Profile.js`, and a data file reaching back into the save system is
 * the cycle that CONTRACTS.md's "do not import one system from another" rule is
 * protecting. But *something* has to know both halves: the challenge list, and
 * the survivors / items / equipment / artifacts that challenges reward. This is
 * that something, and it is the only module that imports both.
 *
 * ## The inversion
 *
 * The reward table used to be authored in `challenges.js` as a literal map of
 * challenge id to content id. That shape has one fatal property: adding content
 * means editing a file you do not own, and the id you write there is a second
 * copy of a fact that already lives on the card. The two copies drifting is not
 * hypothetical — it is exactly what `Artifacts._auditUnlocks` was written to
 * catch, and a boot-time `console.warn` is a poor substitute for the drift
 * being impossible.
 *
 * So the direction is reversed. A content card declares its own condition:
 *
 * ```js
 * { id: 'engineer', name: 'Engineer', unlock: 'bossSlayer', ... }
 * ```
 *
 * and this module discovers it. A content agent adds a survivor with an
 * `unlock` field and it is gated, with no edit here, no edit to `challenges.js`,
 * and no id of theirs written down anywhere but on their own card. The catalogue
 * scan is generic over the card shape, so a catalogue that does not exist yet
 * costs nothing and a card without an `unlock` field is simply always available
 * — which is `Profile.isUnlocked`'s default and the safe direction to fail in.
 *
 * ## What runs when
 *
 * Everything below runs at **module evaluation**, not from an `init`. ES modules
 * finish evaluating before `main.js` constructs a single system, so by the time
 * `Artifacts.init` audits its cards or `Profile.init` asks a gate question, the
 * table is already resolved. An `init` hook would have to be ordered against
 * `Artifacts`, which is registered *before* `Progression` in `main.js` — i.e.
 * before the system that owns the profile exists. `Profile.js` imports this
 * module for that reason and for no other.
 */

import {
  CHALLENGE_BY_ID, registerChallenges, registerUnlockBinding, bindingStamp,
} from '../data/challenges.js';
import { SURVIVORS } from '../data/survivors.js';
import { ITEMS } from '../data/items.js';
import { EQUIPMENT } from '../data/equipment.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { SPAWN_CARDS, BOSS_CARDS } from '../data/enemies.js';

/**
 * Every catalogue this build knows about, keyed by the name the profile files
 * its encounters under.
 *
 * `unlockType` is null for the two the player cannot own — a monster is met,
 * never earned — which is what keeps the discovery scan from trying to gate a
 * boss behind a challenge. They are still listed because the *survey*
 * challenges ("record every monster") are sized off these counts, and a
 * catalogue that is invisible here would give them a goal of one.
 */
const CATALOGUES = [
  { kind: 'survivor', unlockType: 'survivor', cards: SURVIVORS },
  { kind: 'item', unlockType: 'item', cards: ITEMS },
  { kind: 'equipment', unlockType: 'equipment', cards: EQUIPMENT },
  { kind: 'enemy', unlockType: null, cards: SPAWN_CARDS },
  { kind: 'boss', unlockType: null, cards: BOSS_CARDS },
  // Artifacts have no `kind` in the profile's encounter map — you do not "meet"
  // one — but they are the catalogue that carries every reward in the game
  // today, so they are scanned for `unlock` like everything else.
  { kind: null, unlockType: 'artifact', cards: ARTIFACTS },
];

/** kind -> how many ids exist. Read by the survey challenges' dynamic goals. */
const _sizes = {};
/** `${type}:${id}` -> display name, so no surface has to print a storage key. */
const _names = new Map();

/**
 * Read every catalogue once: sizes for the survey goals, names for the UI, and
 * the `unlock` declarations for the gate table.
 *
 * Defensive about card shape on purpose. These arrays are owned by other agents
 * and are being edited in parallel with this file; a half-written card with no
 * `id` must cost that card, not the boot.
 */
function scan() {
  let bound = 0;
  for (const cat of CATALOGUES) {
    const cards = Array.isArray(cat.cards) ? cat.cards : [];
    if (cat.kind) _sizes[cat.kind] = 0;
    for (const card of cards) {
      if (!card || typeof card.id !== 'string' || !card.id) continue;
      if (cat.kind) _sizes[cat.kind]++;
      if (cat.unlockType) _names.set(`${cat.unlockType}:${card.id}`, card.name || card.id);

      if (typeof card.unlock !== 'string' || !card.unlock) continue;
      if (!cat.unlockType) {
        // A monster card carrying `unlock` means somebody used the field for
        // something else (enemies.js uses `unlock` on the *elite tier* table as
        // a difficulty threshold, which is why this branch is not an error).
        continue;
      }
      if (!CHALLENGE_BY_ID[card.unlock]) {
        console.warn(`[unlocks] ${cat.unlockType} "${card.id}" names unknown challenge `
          + `"${card.unlock}" — leaving it unlocked rather than gating it on nothing`);
        continue;
      }
      if (registerUnlockBinding(card.unlock, { type: cat.unlockType, id: card.id })) bound++;
    }
  }
  return bound;
}

/**
 * One mastery challenge per survivor, generated rather than authored.
 *
 * This is the whole reason the generic path had to exist: a roster that grows
 * should grow its own mastery track. Writing four of these by hand would mean
 * the fifth survivor ships without one, and nothing would notice — a missing
 * challenge is invisible in a way a broken one is not.
 *
 * Deliberately *not* bound to a reward. RoR2 pays mastery in skins and there is
 * no skin catalogue here yet; a mastery challenge that unlocks the survivor it
 * is about is a circular gate, and one that unlocks an artifact would put a
 * roster-sized number of claims on a seven-entry pool. Prestige is the point,
 * and the logbook shows it.
 *
 * The id is namespaced (`mastery.<survivorId>`) so it can never collide with a
 * hand-written challenge, and it is stable across builds because it is derived
 * from the survivor id, which is itself a persisted key.
 */
const MASTERY_STAGE = 5;
function generateMastery() {
  const defs = [];
  for (const c of SURVIVORS) {
    if (!c || typeof c.id !== 'string' || !c.id) continue;
    defs.push({
      id: `mastery.${c.id}`,
      name: `${c.name} — Mastery`,
      description: `Reach stage ${MASTERY_STAGE} as ${c.name}.`,
      category: 'mastery',
      hidden: false,
      goal: MASTERY_STAGE,
      // Reads the *career* record rather than the live run, so the challenge is
      // satisfied by any past run with this survivor. Tracking the live run
      // instead would work identically while playing and would read as zero on
      // the menu, which is where a player looks at a mastery list.
      track: (p, r, f) => Math.min(MASTERY_STAGE, f?.survivorRuns?.[c.id]?.bestStage ?? 0),
      unlocks: null,
    });
  }
  return defs;
}

const _generated = generateMastery();
registerChallenges(_generated);
const _bound = scan();

// ------------------------------------------------------------------- read API

/** How many ids the given catalogue holds right now. Zero if unknown. */
export function catalogueSize(kind) { return _sizes[kind] ?? 0; }

/** The full size map, shaped for `Profile.facts().catalogue`. */
export function catalogueSizes() { return { ..._sizes }; }

/**
 * The player-facing name of a piece of unlockable content.
 *
 * Falls back to the id rather than to a placeholder: an id in the UI is ugly but
 * it is also *actionable* — it tells whoever sees it exactly which card is
 * missing a name. "Unknown" tells them nothing.
 */
export function unlockName(type, id) {
  return _names.get(`${type}:${id}`) || id;
}

/** Every generated (as opposed to authored) challenge id. Used by the logbook. */
export function generatedChallengeIds() { return _generated.map((d) => d.id); }

/** Diagnostics for the harness and for tests: what did the scan actually do? */
export function unlockRegistryReport() {
  return {
    sizes: { ..._sizes },
    bound: _bound,
    generated: _generated.length,
    stamp: bindingStamp(),
  };
}
