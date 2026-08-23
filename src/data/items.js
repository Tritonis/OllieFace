/**
 * Item definitions.
 *
 * Stacking follows RoR2 convention and it matters more than the numbers do:
 *  - flat adds stack LINEARLY (`per * count`) so health/damage/speed keep
 *    climbing forever and the run keeps feeling better;
 *  - anything that is a CHANCE stacks HYPERBOLICALLY (`1 - 1/(1 + k*count)`)
 *    so twenty stacks approach but never reach certainty, which keeps
 *    chance-on-hit items worth picking up without ever trivialising them.
 *
 * Shape: { id, name, tier, flavour, description(count), stat?, hooks? }
 *   stat(count, s)    mutates the stat block (see CONTRACTS.md)
 *   hooks.onHit/onKill/onDamaged/onJump/onInterval(payload, api)
 *   hooks.outgoing(amount, target, info, api) -> amount   conditional multipliers
 *
 * `api` = { ctx, count, combat, items, player, roll(p), rng }. `roll` already
 * folds in the hit's proc coefficient and any luck (Clover) the player has.
 */

// The Warden's Tally asks the same question the void's own reward multiplier
// does, and there is exactly one answer to it in the codebase.
import { isVoidtouched } from './corruption.js';
// The Effect Language (docs/art/EFFECT-LANGUAGE.md), as data: element hues and
// the proc-grammar floor every item hook now speaks through.
import { ELEMENTS, cue } from './effects.js';

/**
 * Tier table. `weight` is the *default* pull weight for a generic roll; the
 * concrete drop tables live in `systems/Items.js` (DROP_TABLES) because which
 * pool a chest reaches into is a systems decision, not a data one.
 *
 * Boss, lunar and equipment all sit at weight 0 on purpose: none of them is
 * ever reachable from an ordinary chest. Boss items come off a dead boss,
 * lunar off the lunar pool, equipment off equipment barrels — each names its
 * pool explicitly, which is what stops a white chest from occasionally handing
 * out a Lunar drawback the player never opted into.
 */
/*
 * The colours here used to be a near-miss of the HUD's: 0xd8dde6 against the
 * HUD's #e6ecf4, 0x49d67a against #63e06a, and so on down the table. Two
 * palettes for one concept is how one of them silently stops being safe, so
 * they are now the same seven values, and `tests/readability-gate.test.mjs`
 * fails if they diverge again. The rationale for each colour lives with the
 * table it is measured against, above `TIERS` in `src/ui/Icons.js`.
 */
export const TIERS = {
  common: { name: 'Common', colour: 0xf0f4f9, css: '#f0f4f9', weight: 80 },
  uncommon: { name: 'Uncommon', colour: 0x7af8a1, css: '#7af8a1', weight: 20 },
  legendary: { name: 'Legendary', colour: 0xfc6c78, css: '#fc6c78', weight: 1 },
  boss: { name: 'Boss', colour: 0xe8cc00, css: '#e8cc00', weight: 0 },
  lunar: { name: 'Umbral', colour: 0x1abbcf, css: '#1abbcf', weight: 0 },
  // Blight sits at weight 0 for the same reason boss and lunar do: it is never
  // reached by multiplying the generic ladder. `Items.rollTier` adds it as an
  // explicit share of whatever table it was handed, so one constant sets the
  // rate for every chest in the game at once — see BLIGHT_SHARE there.
  blight: { name: 'Blight', colour: 0xc547d8, css: '#c547d8', weight: 0 },
  // Argent is the only tier no chest can reach at all. Blight is weight 0 but
  // `rollTier` folds it back in as an explicit share; argent is not folded in
  // anywhere, and the single door into the pool is `Items.rollArgent()`, which
  // the Consecration press calls. A run that never presses the reliquary takes
  // no extra `ctx.rng` draw, which is what keeps the sp-equivalence baseline
  // still.
  argent: { name: 'Argent', colour: 0xbbbbaf, css: '#bbbbaf', weight: 0 },
  equipment: { name: 'Equipment', colour: 0xb98116, css: '#b98116', weight: 0 },
};

/**
 * The argent tier's one dial and its one rule.
 *
 * `fadeAt` is Overrun's `at` (`data/corruption.js` BANDS), so the fade lands on
 * a band boundary the player already reads: full pay at Pristine, half at
 * Blighted, nothing at Overrun. Blight cards do the opposite, which is what
 * makes a hedged inventory worse than either pure line.
 *
 * `reliquary.motes` is the Consecration price; Lane A's altar reads it.
 */
export const ARGENT = { fadeAt: 110, reliquary: { motes: 3 } };

/**
 * How much an argent card pays right now: 1 at Pristine, 0 at Overrun.
 *
 * This reads LIVE world corruption, which is why every argent payoff rides a
 * `hooks` entry and never `stat(count, s)`: `Items.stats()` is frame-cached
 * behind `_dirty`, and `_dirty` moves on inventory and buff changes only, so a
 * `stat` that called this would hand back whatever the gauge said the last time
 * somebody picked something up. Hooks are evaluated at use and get `api.ctx`.
 */
export const grace = (ctx) =>
  Math.max(0, Math.min(1, 1 - (ctx?.corruption?.world ?? 0) / ARGENT.fadeAt));

/** Chance stacking. k is the first-stack value; the curve never reaches 1. */
export const hyperbolic = (k, count) => (count <= 0 ? 0 : 1 - 1 / (1 + k * count));
/** Flat stacking. */
export const linear = (per, count) => per * count;
/** Multiplicative reduction that also never reaches zero (cooldowns). */
export const hyperbolicMult = (k, count) => 1 / (1 + k * count);

const pct = (v) => `${Math.round(v * 1000) / 10}%`;

// Small shared effect helpers. They all guard cross-system calls and always
// pass procDepth through so item damage can keep the chain alive but bounded.
// Exported because `data/equipment.js` builds its actives out of exactly the
// same primitives — an equipment nuke that reached for its own copy of these
// would be the second place proc depth is accounted for, and one of the two
// would eventually be wrong.
export function chainLightning(api, origin, damage, bounces, opts = {}) {
  const { combat, player, ctx } = api;
  // Colour and frame are the caller's, because they are the caller's *element*
  // and *effect class* (EFFECT-LANGUAGE §1.1, §1.3) and not a property of
  // chaining. Seven items shared this one blue line, which is precisely the
  // C1 collision: Arc Rot is rot, Quicksilver Vein is a metal, and neither is
  // lightning. The defaults are the shock recipe, so a caller that says nothing
  // still lands somewhere legible.
  const colour = opts.colour ?? ELEMENTS.shock.hue;
  const frame = opts.frame || 'line';
  let from = origin.position || origin;
  let last = origin.entity || origin;
  const hit = [last];
  for (let i = 0; i < bounces; i++) {
    const next = combat.nearestHostile(last.position || from, 14, 'player', hit);
    if (!next) break;
    if (frame === 'radial-spark') ctx.vfx?.hitSpark?.(next.position, colour, 0.9);
    else if (frame === 'streak') ctx.vfx?.missile?.(last.position || from, next.position, colour);
    else ctx.vfx?.beam?.(last.position || from, next.position, colour);
    combat.applyDamage(next, damage, {
      source: player, position: next.position, type: 'lightning',
      procCoefficient: 0.2, procDepth: api.procDepth,
    });
    hit.push(next);
    last = next;
  }
}

export function seekingStrike(api, from, damage, count, colour, type, frame = 'line') {
  const { combat, player, ctx } = api;
  const seen = [];
  for (let i = 0; i < count; i++) {
    const target = combat.nearestHostile(from, 30, 'player', seen);
    if (!target) break;
    seen.push(target);
    // Effect class, per EFFECT-LANGUAGE §1.3: a line is a directed strike, a
    // streak is travelling ordnance, a radial-spark is a shatter that happens
    // at a point. Three items that were all lines are three different things.
    if (frame === 'radial-spark') ctx.vfx?.hitSpark?.(target.position, colour, 0.9);
    else if (frame === 'streak') ctx.vfx?.missile?.(from, target.position, colour);
    else ctx.vfx?.beam?.(from, target.position, colour);
    combat.applyDamage(target, damage, {
      source: player, position: target.position, type,
      procCoefficient: 1, procDepth: api.procDepth,
    });
  }
}

/**
 * Everything hostile inside `radius`, copied out of Combat's shared overlap
 * buffer.
 *
 * The copy is the whole point: `_overlap` is one reusable array and any
 * `applyDamage` inside the loop can trigger a proc that overlaps again and
 * clobbers it mid-iteration. Half the AoE items in the file were open-coding
 * this three-line dance; the ones written later are the ones most likely to
 * have got it wrong.
 */
export function nearbyHostiles(api, point, radius) {
  const n = api.combat.sphereOverlap(point, radius, 'player');
  const out = [];
  for (let i = 0; i < n; i++) out.push(api.combat.overlapAt(i));
  return out;
}

/**
 * Self-inflicted cost for the Lunar tier, with a floor.
 *
 * The floor is the difference between a trade and a bug. Brittle Edge bills a
 * fraction of health per critical strike, and at a late-run crit rate that is
 * several bills a second — uncapped, it walks the survivor down to 1 HP and
 * parks him there, so the "drawback" stops being a decision and becomes a
 * permanent state the player cannot act on. Refusing to bill below 30% of
 * maximum keeps the cost sharp while the bar is full (where it is a real risk)
 * and silent once it is low (where it would just be a stuck HUD).
 *
 * Never lethal, ever. Losing a run to your own item, with no enemy involved and
 * no way to react, is not a trade — it is the item playing the game for you.
 *
 * `floorFrac` is per-card because the floor is not only a safety rail, it is
 * also where the card *parks* the player, and that is a design number. A cost
 * billed on an event (Brittle Edge's crit, Gale Reliquary's cast) only reaches
 * the floor if the player keeps paying, so 30% is fine there. A cost billed on
 * a timer reaches it unconditionally and then holds the player at it for the
 * rest of the run — see Ashen Pact, which used 30% and thereby handed Prey
 * Instinct (below 40%) and Entropy Ledger (missing health) their full payout
 * for free and forever, which is the opposite of a Lunar drawback.
 */
const SELF_COST_FLOOR = 0.30;
function payHealth(api, amount, floorFrac = SELF_COST_FLOOR) {
  const p = api.player;
  if (!p?.alive || amount <= 0) return 0;
  const floor = (p.stats?.maxHealth || 100) * floorFrac;
  const cost = Math.min(amount, Math.max(0, p.health - floor));
  if (cost <= 0) return 0;
  p.health -= cost;
  return cost;
}

/**
 * The display name of the item a Blight card eats, looked up at call time.
 *
 * Written as a lookup rather than a literal because the branding pass in
 * `reviews/round6/BRANDING-LEDGER.md` is going to rewrite ~40 `name:` fields
 * and a corrupted item whose description quotes a stale name is a lie the
 * rename has no way to find.
 */
const consumes = (id) => ITEM_BY_ID.get(id)?.name || id;

/**
 * When each monster was last hit by the player, for Chipped Whetstone.
 *
 * A WeakMap rather than `Items.mark`: the mark table is Hunter's Tag's, and two
 * items writing one shared set of marks would mean picking up either of them
 * silently powers the other.
 *
 * The entry carries `Enemy.id` — the counter the entity mints fresh on every
 * `spawn` — and not just a timestamp, because the key alone does not identify a
 * *monster*. `Director` pools dead `Enemy` instances and `spawnOne` pops them
 * back out, so a newly spawned body is literally the previous one's object and
 * used to inherit its stamp: a fresh spawn arriving inside the four-second
 * window was denied the opener bonus entirely (measured 100 against 170). A
 * mismatched `id` now reads as "never struck", which is what a new monster is.
 *
 * Those same strong pool references are also why the weak keys buy nothing —
 * the Director holds every Enemy for the life of the run, so nothing here is
 * ever actually collected. Kept weak anyway: it costs nothing and it is correct
 * for the bodies (bosses, summons) that are not pooled.
 */
const _lastStruck = new WeakMap();
/** How long a target has to be left alone before it counts as fresh again. */
const OPENING_WINDOW = 4;

/**
 * Per-spawn rate limiter for hooks that must not fire repeatedly on one body.
 *
 * Same `Enemy.id` guard as `_lastStruck` and for the same reason: the key is a
 * pooled object, so without the id a fresh spawn inherits the previous
 * monster's cooldown. Returns true and stamps when the caller may act.
 */
function onceEvery(map, entity, now, seconds) {
  const prev = map.get(entity);
  if (prev && prev.id === entity?.id && now - prev.t < seconds) return false;
  if (prev) { prev.id = entity?.id; prev.t = now; }
  else map.set(entity, { id: entity?.id, t: now });
  return true;
}

/** Grapnel Tether's per-body reel cooldown. */
const _reeled = new WeakMap();
/**
 * How close the tether may ever bring a body, and how long it must leave that
 * body alone afterwards. See the item for why both exist.
 */
const TETHER_FLOOR = 6;
const TETHER_RECOVER = 1.5;

/**
 * The statuses Afflictor's Index recognises — i.e. every entry in Combat's
 * `STATUS_DEFS`. Listed rather than asking Combat for its table because the
 * data layer must not reach into a system's internals, and a status that
 * existed but was not worth the Index's bonus would want leaving out anyway.
 */
const AILMENTS = ['burn', 'bleed', 'slow', 'freeze', 'shock'];

/**
 * Gilded Reliquary's exchange rate, and the ceiling on it.
 *
 * 250 is a little under a tenth of the first stage's chest price, so the bar
 * moves visibly on a couple of kills rather than being a number that only
 * changes when a boss dies. Eight steps caps the card at 2000 gold held — about
 * two large chests — which is the point at which "I am saving" stops being a
 * plan and starts being a refusal to play the run.
 */
const GOLD_STEP = 250;
const GOLD_CAP_STEPS = 8;
function afflicted(combat, target) {
  for (let i = 0; i < AILMENTS.length; i++) if (combat.hasStatus(target, AILMENTS[i])) return true;
  return false;
}

export const ITEMS = [
  // ------------------------------------------------------------------ BLIGHT
  //
  // The corruption tier. A Blight card does not add to the build — it *rewrites*
  // part of it: on pickup it converts every copy of one named ordinary item into
  // another copy of itself, and any later copy of that item converts on arrival.
  // The transform lives in `Items._settleBlight`; the pairing is the `corrupts`
  // field below and nothing else keys off it.
  //
  // Two rules the whole tier is built on:
  //
  //  1. **No card here is strictly better than the one it eats.** Every one pays
  //     for its upside on an axis the HUD already shows. A corrupted item that
  //     only upgrades would make the tier a free jackpot rather than a bet, and
  //     the bet is the only reason to hand the player an item that deletes part
  //     of the inventory they earned.
  //  2. **Every cost is order-independent.** Costs go through the multiplicative
  //     accumulators (`healthMult`, `damageMult`, `critEdge`) or through fields
  //     that are already multiplicative for every item (`moveSpeed`), or through
  //     a flag consumed after the whole inventory has contributed (`noRegen`).
  //     A cost applied directly to `attackSpeed` or `damage` mid-iteration would
  //     scale whichever items happened to be inserted into the Map first, i.e.
  //     the survivor's stats would depend on the order chests were opened in.
  //
  // The section is declared **before** COMMON rather than in rarity order, which
  // is deliberate and worth stating: anything that replays this catalogue in
  // order and gives one of everything (`Harness.js`'s `10-inventory` is the live
  // example) then introduces each corrupting card before the card it corrupts,
  // so the replay ends in the state a real run would reach and not in one with a
  // pile of items that were converted the moment after they landed. See the note
  // on the HUD's append-only item strip in `Items._settleBlight`.
  {
    id: 'spasm-gland', name: 'Spasm Gland', tier: 'blight', glyph: 'spasmgland',
    corrupts: 'adrenal-syringe',
    flavour: 'It fires whether or not you asked. The asking was always the slow part.',
    description: (n) => `+${pct(linear(0.26, n))} attack speed. Your maximum health is reduced to ${pct(hyperbolicMult(0.15, n))}. Consumes every ${consumes('adrenal-syringe')} you hold.`,
    stat: (n, s) => {
      s.attackSpeed += linear(0.26, n);
      s.healthMult *= hyperbolicMult(0.15, n);
    },
  },
  {
    id: 'bloat-cyst', name: 'Bloat Cyst', tier: 'blight', glyph: 'bloatcyst',
    corrupts: 'cured-haunch',
    flavour: 'More of you to hit, and less of you willing to stop it.',
    description: (n) => `+${linear(55, n)} maximum health. -${linear(9, n)} armor. Consumes every ${consumes('cured-haunch')} you hold.`,
    stat: (n, s) => {
      s.maxHealth += linear(55, n);
      // Negative armor is asymptotic in Combat's mitigation curve, so no stack
      // count turns this into infinite incoming damage the way a multiplier
      // eventually would.
      s.armor -= linear(9, n);
    },
  },
  {
    id: 'clouded-eye', name: 'Clouded Eye', tier: 'blight', glyph: 'cloudedeye',
    corrupts: 'gunsmiths-loupe',
    flavour: 'You see the weak point in everything now. You just cannot see it well.',
    description: (n) => `+${pct(hyperbolic(0.20, n))} critical strike chance. Critical strikes deal ${pct(1 - hyperbolicMult(0.30, n))} less bonus damage. Consumes every ${consumes('gunsmiths-loupe')} you hold.`,
    stat: (n, s) => {
      s.critChance = 1 - (1 - s.critChance) * (1 - hyperbolic(0.20, n));
      // `critEdge` scales the *bonus* half of the multiplier and is applied once
      // the inventory has finished, so a crit can never land below a normal hit
      // and the result never depends on pickup order.
      s.critEdge *= hyperbolicMult(0.30, n);
    },
  },
  {
    id: 'slag-ingot', name: 'Slag Ingot', tier: 'blight', glyph: 'slagingot',
    corrupts: 'trauma-plate',
    flavour: 'Poured straight onto the plate carrier while it was still on him.',
    description: (n) => `Reduce all incoming damage by ${linear(13, n)}. Your movement speed is reduced to ${pct(hyperbolicMult(0.20, n))}. Consumes every ${consumes('trauma-plate')} you hold.`,
    stat: (n, s) => {
      s.flatReduction += linear(13, n);
      s.moveSpeed *= hyperbolicMult(0.20, n);
    },
  },
  {
    id: 'arc-rot', name: 'Arc Rot', tier: 'blight', glyph: 'arcrot',
    corrupts: 'cracked-zither',
    flavour: 'The current has to come from somewhere, and you are the nearest wet thing.',
    description: (n) => `${pct(hyperbolic(0.40, n))} chance on hit to arc for 110% damage across ${3 + linear(2, n)} targets. Every arc costs 1.5% of your current health, down to 30%. Consumes every ${consumes('cracked-zither')} you hold.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.40, api.count))) return;
        chainLightning(api, e, api.items.baseDamage() * 1.1, 3 + linear(2, api.count),
          { colour: ELEMENTS.toxic.hue });
        cue(api, 'arc-rot', e);
        // Charged per *proc*, not per stack: stacking already buys more procs, so
        // a per-stack bill would make the cost quadratic in the count.
        payHealth(api, api.player.health * 0.015);
      },
    },
  },
  {
    id: 'bile-shell', name: 'Bile Shell', tier: 'blight', glyph: 'bileshell',
    corrupts: 'missile-rack',
    flavour: 'It was a warhead before something digested it.',
    description: (n) => `${pct(hyperbolic(0.22, n))} chance on hit to fire a shell for ${pct(linear(4.5, n))} damage. All of your damage is reduced to ${pct(hyperbolicMult(0.20, n))}. Consumes every ${consumes('missile-rack')} you hold.`,
    stat: (n, s) => { s.damageMult *= hyperbolicMult(0.20, n); },
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.22, api.count))) return;
        api.ctx.vfx?.missile?.(api.player.position, e.position, ELEMENTS.toxic.hue);
        cue(api, 'bile-shell', e);
        api.combat.explode(e.position, 5, api.items.baseDamage() * linear(4.5, api.count), api.player, {
          team: 'player', proc: 0.6, procDepth: api.procDepth, type: 'missile',
        });
      },
    },
  },
  {
    id: 'gristle-sickle', name: 'Gristle Sickle', tier: 'blight', glyph: 'gristlesickle',
    corrupts: 'reaping-hook',
    flavour: 'It will keep you alive exactly as long as you keep finding throats.',
    description: (n) => `Critical strikes heal you for ${linear(24, n)}. You no longer regenerate health passively. Consumes every ${consumes('reaping-hook')} you hold.`,
    stat: (n, s) => { s.noRegen = true; },
    hooks: {
      onHit: (e, api) => {
        if (!e.crit) return;
        api.combat.heal(api.player, linear(24, api.count));
        cue(api, 'gristle-sickle');
      },
    },
  },
  {
    id: 'rupture-gall', name: 'Rupture Gall', tier: 'blight', glyph: 'rupturegall',
    corrupts: 'shrapnel-heart',
    flavour: 'A tumour that learned what a shaped charge is.',
    description: (n) => `ALL of your attacks explode in a ${2.5 + linear(1, n)}m radius for an extra 105% damage. Your maximum health is reduced to ${pct(hyperbolicMult(0.35, n))}. Consumes every ${consumes('shrapnel-heart')} you hold.`,
    stat: (n, s) => { s.healthMult *= hyperbolicMult(0.35, n); },
    hooks: {
      onHit: (e, api) => {
        if (e.type === 'gall') return; // never detonate our own detonation
        if (api.procDepth > api.combat.MAX_PROC_DEPTH - 1) return;
        api.combat.explode(e.position, 2.5 + linear(1, api.count), e.amount * 1.05, api.player, {
          team: 'player', proc: 0, procDepth: api.procDepth, type: 'gall', falloff: false,
        });
        cue(api, 'rupture-gall', e);
      },
    },
  },
  {
    id: 'loaded-knucklebone', name: 'Loaded Knucklebone', tier: 'blight', glyph: 'knucklebone',
    corrupts: 'pressed-clover',
    flavour: 'Weighted on one face. Someone had to be hollowed out to do it.',
    description: (n) => `All random effects are rolled +${linear(2, n)} extra times for a favourable outcome. You take ${pct(2 - 100 / (100 + linear(40, n)))} more damage. Consumes every ${consumes('pressed-clover')} you hold.`,
    stat: (n, s) => {
      s.luck += linear(2, n);
      s.armor -= linear(40, n);
    },
  },

  {
    id: 'gorge-tooth', name: 'Gorging Tooth', tier: 'blight', glyph: 'gorgetooth',
    corrupts: 'marrow-tooth',
    flavour: 'It does not chew. It only ever swallows, and it is always the wrong size for you.',
    description: (n) => `Killing an enemy heals ${pct(linear(0.07, n))} of maximum health. Your maximum health is reduced to ${pct(hyperbolicMult(0.22, n))}. Consumes every ${consumes('marrow-tooth')} you hold.`,
    // The base heals a flat amount plus a small fraction; this heals a *large*
    // fraction of a bar it has also shrunk. The two halves fight each other on
    // purpose: the smaller the pool, the larger a percentage heal refills and
    // the fewer hits it survives. That makes the card excellent while the horde
    // is dense and lethal the moment the kills stop, which is the trade the
    // whole tier is supposed to be asking about.
    stat: (n, s) => { s.healthMult *= hyperbolicMult(0.22, n); },
    hooks: {
      onKill: (e, api) => {
        const p = api.player;
        api.combat.heal(p, (p.stats?.maxHealth || 100) * linear(0.07, api.count));
        cue(api, 'gorge-tooth');
      },
    },
  },
  {
    id: 'splinter-bar', name: 'Splinter Bar', tier: 'blight', glyph: 'splinterbar',
    corrupts: 'pry-bar',
    flavour: 'Superb at opening things. Useless once they are open, and it knows it.',
    description: (n) => `Deal +${pct(linear(1.3, n))} damage to enemies above 90% health. You deal ${pct(1 - hyperbolicMult(0.5, n))} less damage to enemies below 25% health. Consumes every ${consumes('pry-bar')} you hold.`,
    // Both halves live in one `outgoing` and are therefore multiplicative and
    // order-independent by construction, which is the rule the tier is written
    // to. The cost is deliberately placed on the *other* end of the health bar
    // rather than on a stat: it turns Splinter Bar into an explicit argument
    // with Hollowpoint Pouch, so a common-heavy inventory has a reason to refuse
    // a corruption it would otherwise take for free.
    hooks: {
      outgoing: (amount, target, info, api) => {
        const frac = target.health / (target.maxHealth || 1);
        if (frac > 0.9) return amount * (1 + linear(1.3, api.count));
        if (frac < 0.25) return amount * hyperbolicMult(0.5, api.count);
        return amount;
      },
    },
  },

  // ------------------------------------------------------------------ ARGENT
  //
  // The purity pool. Zero-weight, unreachable from any chest, bought one card
  // at a time off the Argent Reliquary for three warded motes. Every payoff
  // except the Warden's Tally is multiplied by `grace(api.ctx)` and every one
  // of them lives in `hooks` - see the note on `grace` for why `stat` is
  // forbidden here.
  {
    id: 'wardens-tally', name: "Warden's Tally", tier: 'argent', glyph: 'ring',
    flavour: 'One notch for every thing you sent back where it came from.',
    description: (n) => `Killing a Voidtouched enemy grants +${pct(linear(0.12, n))} attack speed for 8s, up to 3 stacks.`,
    // The one argent card the gauge does not fade, because it pays the purity
    // verb directly: Voidtouched exist in proportion to World Corruption, so a
    // clean world already rate-limits it harder than any multiplier would.
    hooks: {
      onKill: (e, api) => {
        if (!isVoidtouched(e.victim)) return;
        api.items.addBuff('frenzy', 8, 3, linear(0.12, api.count));
        cue(api, 'wardens-tally');
      },
    },
  },
  {
    id: 'quicksilver-vein', name: 'Quicksilver Vein', tier: 'argent', glyph: 'drop',
    flavour: 'It runs bright, and it runs cold, and it will not run through filth.',
    description: (n) => `${pct(hyperbolic(0.08, n))} chance on hit to arc for 160% damage across 2 targets. Scaled by how clean the world is.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.08, api.count) * grace(api.ctx))) return;
        chainLightning(api, e, api.items.baseDamage() * 1.6, 2,
          { colour: ELEMENTS.physical.hue });
        cue(api, 'quicksilver-vein', e);
      },
    },
  },
  {
    id: 'unblemished-plate', name: 'Unblemished Plate', tier: 'argent', glyph: 'shield',
    flavour: 'Not one scratch. That is either very good armour or a very short career.',
    description: (n) => `Taking damage grants +${linear(14, n)} armour for 4s. Scaled by how clean the world is.`,
    hooks: {
      onDamaged: (e, api) => {
        api.items.addBuff('aegis', 4, 1, linear(14, api.count) * grace(api.ctx));
        cue(api, 'unblemished-plate');
      },
    },
  },
  {
    id: 'chime-of-absolution', name: 'Chime of Absolution', tier: 'argent', glyph: 'hex',
    flavour: 'It only rings in consecrated air. Elsewhere it is a lump of cold metal.',
    description: (n) => `While a Sanctuary is open, each kill wards ${linear(1.5, n)} corruption out of the world.`,
    // The only argent card that is worthless at Pristine, deliberately: `bleed`
    // clamps to what exists. It closes the purity loop into an engine - ward,
    // mote, window, the Chime wards harder - while still requiring the spend
    // verb to turn the crank, so it can never run without the player choosing.
    hooks: {
      onKill: (e, api) => {
        const cor = api.ctx?.corruption;
        if (!api.ctx?.authority || !cor?.sanctified) return;
        cor.bleed(api.player, linear(1.5, api.count));
        cue(api, 'chime-of-absolution');
      },
    },
  },
  {
    id: 'pale-standard', name: 'Pale Standard', tier: 'argent', glyph: 'triangle',
    flavour: 'Carried ahead of the column so that everyone behind it knows what they are for.',
    description: (n) => `Deal +${pct(linear(0.30, n))} damage, scaled by how clean the world is. Half again as much while you hold a Warden's Tally.`,
    // The whole of the "argent synergies" shape: a held-other multiplier inside
    // one card's own hook needs no second table and no new preview surface, and
    // it is the seam a previewed argent bargain would grow from.
    hooks: {
      outgoing: (amount, target, info, api) => amount * (1 + linear(0.30, api.count)
        * grace(api.ctx)
        * (api.items.count('wardens-tally') > 0 ? 1.5 : 1)),
    },
  },

  // ------------------------------------------------------------------ COMMON
  {
    id: 'adrenal-syringe', name: 'Adrenal Syringe', tier: 'common', glyph: 'bars',
    flavour: 'Property of Dr. E. Fenwick. Do not remove from the medbay.',
    description: (n) => `+${pct(linear(0.15, n))} attack speed.`,
    stat: (n, s) => { s.attackSpeed += linear(0.15, n); },
  },
  {
    id: 'cloven-hoof', name: 'Cloven Hoof', tier: 'common', glyph: 'arrow',
    flavour: 'It still smells of the pasture.',
    description: (n) => `+${pct(linear(0.14, n))} movement speed.`,
    stat: (n, s) => { s.moveSpeed *= 1 + linear(0.14, n); },
  },
  {
    id: 'cured-haunch', name: 'Cured Haunch', tier: 'common', glyph: 'drop',
    flavour: 'Salted three winters ago. It has outlasted the man who salted it.',
    description: (n) => `+${linear(25, n)} maximum health.`,
    stat: (n, s) => { s.maxHealth += linear(25, n); },
  },
  {
    id: 'bruised-coinpurse', name: 'Bruised Coinpurse', tier: 'common', glyph: 'circle',
    flavour: 'Found under the vending machine. Still counts.',
    description: (n) => `Gain ${linear(2, n)} gold whenever you are hurt.`,
    hooks: {
      onDamaged: (e, api) => {
        api.items.addGold(linear(2, api.count));
        cue(api, 'bruised-coinpurse');
      },
    },
  },
  {
    id: 'dented-buckler', name: 'Dented Buckler', tier: 'common', glyph: 'hex',
    flavour: 'Bounce, dodge, weave. Repeat.',
    description: (n) => `${pct(hyperbolic(0.15, n))} chance to block incoming damage.`,
    stat: (n, s) => { s.blockChance = 1 - (1 - (s.blockChance || 0)) * (1 - hyperbolic(0.15, n)); },
  },
  {
    id: 'trauma-plate', name: 'Trauma Plate', tier: 'common', glyph: 'shield',
    flavour: 'Rated for small-arms fire. Mostly.',
    description: (n) => `Reduce all incoming damage by ${linear(5, n)}.`,
    stat: (n, s) => { s.flatReduction += linear(5, n); },
  },
  {
    id: 'pry-bar', name: 'Pry Bar', tier: 'common', glyph: 'cross',
    flavour: 'It opens things. Some of them are people.',
    description: (n) => `Deal +${pct(linear(0.75, n))} damage to enemies above 90% health.`,
    hooks: {
      outgoing: (amount, target, info, api) => {
        const max = target.maxHealth || 1;
        return target.health / max > 0.9 ? amount * (1 + linear(0.75, api.count)) : amount;
      },
    },
  },
  {
    id: 'bloodscent', name: 'Bloodscent', tier: 'common', glyph: 'triangle',
    flavour: 'Blood in the water.',
    description: (n) => `Critical strikes grant +${pct(linear(0.12, n))} attack speed for 3s, up to 3 stacks.`,
    hooks: {
      onHit: (e, api) => {
        if (!e.crit) return;
        api.items.addBuff('frenzy', 3, 3, linear(0.12, api.count));
        cue(api, 'bloodscent');
      },
    },
  },
  {
    id: 'gunsmiths-loupe', name: "Gunsmith's Loupe", tier: 'common', glyph: 'ring',
    flavour: 'Perfect vision is a weapon.',
    description: (n) => `+${pct(hyperbolic(0.10, n))} critical strike chance.`,
    stat: (n, s) => { s.critChance = 1 - (1 - s.critChance) * (1 - hyperbolic(0.10, n)); },
  },
  {
    id: 'tar-charge', name: 'Tar Charge', tier: 'common', glyph: 'diamond',
    flavour: 'Warning: adhesive is permanent.',
    description: (n) => `${pct(hyperbolic(0.05, n))} chance on hit to attach a bomb for 180% damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.05, api.count))) return;
        api.combat.explode(e.position, 4, api.items.baseDamage() * 1.8, api.player, {
          team: 'player', proc: 0.3, procDepth: api.procDepth, type: 'sticky',
        });
        cue(api, 'tar-charge', e);
      },
    },
  },
  {
    id: 'leaking-jerrycan', name: 'Leaking Jerrycan', tier: 'common', glyph: 'flame',
    flavour: 'Burn it all down.',
    description: (n) => `Killing an enemy ignites all enemies within ${linear(2, n) + 6}m for 75% damage.`,
    hooks: {
      onKill: (e, api) => {
        const radius = 6 + linear(2, api.count);
        const n = api.combat.sphereOverlap(e.position, radius, 'player');
        const targets = [];
        for (let i = 0; i < n; i++) targets.push(api.combat.overlapAt(i));
        for (const t of targets) {
          api.combat.applyDamage(t, api.items.baseDamage() * 0.75, {
            source: api.player, position: t.position, type: 'fire',
            procCoefficient: 0, procDepth: api.procDepth,
          });
          api.combat.applyStatus(t, 'burn', api.player, api.count);
        }
        api.ctx.vfx?.ring?.(e.position, radius, ELEMENTS.fire.hue);
        cue(api, 'leaking-jerrycan', e);
      },
    },
  },
  {
    id: 'marrow-tooth', name: 'Marrow Tooth', tier: 'common', glyph: 'star',
    flavour: 'Still warm.',
    description: (n) => `Killing an enemy heals you for ${linear(8, n)} plus ${pct(linear(0.02, n))} of max health.`,
    hooks: {
      onKill: (e, api) => {
        const p = api.player;
        api.combat.heal(p, linear(8, api.count) + (p.stats?.maxHealth || 100) * linear(0.02, api.count));
        cue(api, 'marrow-tooth');
      },
    },
  },
  {
    id: 'amber-clasp', name: 'Amber Clasp', tier: 'common', glyph: 'gem',
    flavour: 'A gift from someone who is now dead.',
    description: (n) => `Killing an enemy grants a temporary ${linear(15, n)} point barrier.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addBarrier(linear(15, api.count));
        cue(api, 'amber-clasp');
      },
    },
  },
  {
    id: 'stitch-kit', name: 'Stitch Kit', tier: 'common', glyph: 'plus',
    flavour: 'Standard issue. Rarely enough.',
    description: (n) => `After being hurt, heal for ${linear(10, n)} plus ${pct(linear(0.03, n))} of max health.`,
    hooks: {
      onDamaged: (e, api) => {
        if (!api.items.cooldownReady('stitch-kit', 1.2)) return;
        const p = api.player;
        api.combat.heal(p, linear(10, api.count) + (p.stats?.maxHealth || 100) * linear(0.03, api.count));
        cue(api, 'stitch-kit');
      },
    },
  },

  {
    id: 'flint-shard', name: 'Flint Shard', tier: 'common', glyph: 'flint',
    flavour: 'Chipped to an edge that predates the colony by ten thousand years.',
    description: (n) => `+${linear(2, n)} base damage.`,
    stat: (n, s) => { s.damage += linear(2, n); },
  },
  {
    id: 'kevlar-weave', name: 'Kevlar Weave', tier: 'common', glyph: 'weave',
    flavour: 'Stops most things. "Most" is doing a lot of work in that sentence.',
    description: (n) => `+${linear(6, n)} armor.`,
    stat: (n, s) => { s.armor += linear(6, n); },
  },
  {
    id: 'rebreather', name: 'Salvaged Rebreather', tier: 'common', glyph: 'lung',
    flavour: 'Someone else stopped needing it.',
    description: (n) => `+${linear(0.7, n)} health regeneration per second.`,
    stat: (n, s) => { s.healthRegen += linear(0.7, n); },
  },
  {
    id: 'runners-chalk', name: "Runner's Chalk", tier: 'common', glyph: 'chalk',
    flavour: 'Grip is a stat.',
    description: (n) => `+${pct(linear(0.05, n))} attack speed and +${pct(linear(0.05, n))} movement speed.`,
    stat: (n, s) => {
      s.attackSpeed += linear(0.05, n);
      s.moveSpeed *= 1 + linear(0.05, n);
    },
  },
  {
    id: 'spurs', name: 'Bloodied Spurs', tier: 'common', glyph: 'spur',
    flavour: 'Keep moving. Whatever it was is still behind you.',
    description: (n) => `Killing an enemy grants +${pct(0.2)} movement speed for ${linear(3, n)}s.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addBuff('quickfoot', linear(3, api.count), 1, 0.2);
        cue(api, 'spurs');
      },
    },
  },
  {
    id: 'warm-coals', name: 'Warm Coals', tier: 'common', glyph: 'coal',
    flavour: 'Still glowing. It has been three years.',
    description: (n) => `${pct(hyperbolic(0.08, n))} chance on hit to ignite for 100% damage over 3s.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.08, api.count))) return;
        api.combat.applyStatus(e.target, 'burn', api.player, 1);
        cue(api, 'warm-coals', e);
      },
    },
  },
  {
    id: 'copper-wire', name: 'Coil of Copper Wire', tier: 'common', glyph: 'wire',
    flavour: 'The cheap version of a very expensive idea.',
    description: (n) => `${pct(hyperbolic(0.05, n))} chance on hit to arc to 1 nearby enemy for ${pct(linear(0.6, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.05, api.count))) return;
        chainLightning(api, e, api.items.baseDamage() * linear(0.6, api.count), 1);
        cue(api, 'copper-wire', e);
      },
    },
  },
  {
    id: 'glass-marble', name: 'Cracked Marble', tier: 'common', glyph: 'marble',
    flavour: 'It magnifies. Mostly it magnifies the part that hurts.',
    description: (n) => `Critical strikes deal +${pct(linear(0.25, n))} damage.`,
    stat: (n, s) => { s.critMult += linear(0.25, n); },
  },
  {
    id: 'ammo-pouch', name: 'Hollowpoint Pouch', tier: 'common', glyph: 'pouch',
    flavour: 'Finishing is a separate skill from starting.',
    description: (n) => `Deal +${pct(linear(0.35, n))} damage to enemies below 25% health.`,
    hooks: {
      // The bookend to Pry Bar: one pays for opening a fight, this pays for
      // closing it, so a common-heavy inventory covers the whole health bar
      // instead of stacking one end of it twice.
      outgoing: (amount, target, info, api) => {
        const max = target.maxHealth || 1;
        return target.health / max < 0.25 ? amount * (1 + linear(0.35, api.count)) : amount;
      },
    },
  },
  {
    id: 'field-dressing', name: 'Field Dressing', tier: 'common', glyph: 'dressing',
    flavour: 'Wrap it. Keep walking.',
    description: (n) => `After 5s without taking damage, gain a ${linear(12, n)} point barrier every second.`,
    hooks: {
      onInterval: (e, api) => {
        if (api.items.timeSinceHurt() < 5) return;
        if (!api.items.cooldownReady('field-dressing', 1)) return;
        api.items.addBarrier(linear(12, api.count));
        cue(api, 'field-dressing');
      },
    },
  },
  {
    id: 'salt-lick', name: 'Mineral Lick', tier: 'common', glyph: 'saltcube',
    flavour: 'Livestock supplement. The label says nothing about people.',
    description: (n) => `Regenerate ${linear(2.5, n)} health per second while below half health.`,
    hooks: {
      onInterval: (e, api) => {
        const p = api.player;
        if (!p?.alive || p.health > (p.stats?.maxHealth || 100) * 0.5) return;
        api.combat.heal(p, linear(2.5, api.count) * e.dt);
        cue(api, 'salt-lick');
      },
    },
  },
  {
    id: 'rubber-soles', name: 'Rubber Soles', tier: 'common', glyph: 'sole',
    flavour: 'Air is the safest place to be.',
    description: (n) => `Jumping grants a ${linear(10, n)} point barrier.`,
    hooks: {
      // `e.local === false` is a *remote pawn's* jump, seen on the host. The
      // barrier lands on `api.player`, which is always this machine's own
      // survivor, so paying it for somebody else's jump would hand the host a
      // free barrier every time a teammate 25 m away pressed space. The launch
      // impulse is not gated this way — that one belongs to the jumper and the
      // host has to reproduce it (see `Player._jump`).
      onJump: (e, api) => { if (e.local === false) return; api.items.addBarrier(linear(10, api.count)); },
    },
  },
  {
    id: 'bandolier', name: 'Scrap Bandolier', tier: 'common', glyph: 'bandolier',
    flavour: 'Reload is a state of mind.',
    description: (n) => `${pct(hyperbolic(0.10, n))} chance on kill to slash skill cooldowns by 60% for 3s.`,
    hooks: {
      onKill: (e, api) => {
        if (!api.roll(hyperbolic(0.10, api.count))) return;
        api.items.addBuff('quickhands', 3, 1, 0.4);
        cue(api, 'bandolier');
      },
    },
  },
  {
    id: 'spark-plug', name: 'Spark Plug', tier: 'common', glyph: 'plug',
    flavour: 'Removed from something that has not run since the crash.',
    description: (n) => `${pct(hyperbolic(0.12, n))} chance on kill to zap a nearby enemy for ${pct(linear(1.1, n))} damage.`,
    hooks: {
      onKill: (e, api) => {
        if (!api.roll(hyperbolic(0.12, api.count))) return;
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.1, api.count), 1,
          ELEMENTS.shock.hue, 'spark', 'streak');
        cue(api, 'spark-plug', e);
      },
    },
  },

  // --------------------------------------------------- round 7 commons
  //
  // The three below deliberately buy *positions* rather than numbers. The white
  // tier already owns the flat stat ladder (Flint Shard, Kevlar Weave, Cured
  // Haunch) and a fourth entry on it would be dead weight; what it was missing
  // was cards that change where the player chooses to stand, which is the axis
  // the whole survivor roster is separated on.
  {
    id: 'bipod', name: 'Folding Bipod', tier: 'common', glyph: 'bipod',
    flavour: 'Two of the three legs you need. You are the third one, and you are not to move.',
    description: (n) => `Deal +${pct(linear(0.40, n))} damage while standing still.`,
    hooks: {
      // Reads `player.moving`, which is the same flag the spread model in
      // `data/abilities.js` uses — so the item makes the *existing* planted/
      // mobile split pay out instead of inventing a second notion of standing
      // still that could disagree with the one the guns already use.
      outgoing: (amount, target, info, api) =>
        (api.player?.moving ? amount : amount * (1 + linear(0.40, api.count))),
    },
  },
  {
    id: 'whetstone', name: 'Chipped Whetstone', tier: 'common', glyph: 'whetstone',
    flavour: 'The first cut is the only one it was ever ground for.',
    description: (n) => `Deal +${pct(linear(0.70, n))} damage to an enemy you have not hit in the last ${OPENING_WINDOW}s.`,
    hooks: {
      // The mirror of Hunter's Tag: the Tag pays for staying on one target,
      // this pays for leaving it. Holding both is coherent rather than
      // contradictory — you open on everything, then finish the one you marked.
      //
      // The stamp is written *before* the answer is computed, using the value
      // read a line earlier: the bonus is a property of the previous hit's age,
      // not of this one's, and stamping afterwards would make a burst of two
      // rounds in the same tick both count as openers.
      //
      // Damage-over-time is excluded and does not stamp. `Combat.modifyOutgoing`
      // runs for DoT ticks as well as for hits, and burn ticks every 0.5 s for
      // 4 s — so any burn the player applied re-stamped its own target often
      // enough that the four-second window could never elapse and the item
      // switched itself off. That is not a corner case: it is CINDER's primary,
      // Ashen Pact, Warm Coals, the Leaking Jerrycan and every cloud on the
      // field. An opener is a *hit*; a tick of something already burning is not
      // one, and it should neither be paid the bonus nor reset the clock.
      outgoing: (amount, target, info, api) => {
        if (info?.isDot) return amount;
        const now = api.ctx.time;
        const prev = _lastStruck.get(target);
        // `Enemy.id` is minted per spawn, so a pooled body that came back as a
        // different monster does not inherit the old one's stamp.
        const last = (prev && prev.id === target?.id) ? prev.t : undefined;
        if (prev) { prev.id = target?.id; prev.t = now; }
        else _lastStruck.set(target, { id: target?.id, t: now });
        return (last === undefined || now - last >= OPENING_WINDOW)
          ? amount * (1 + linear(0.70, api.count)) : amount;
      },
    },
  },
  {
    id: 'prey-instinct', name: 'Prey Instinct', tier: 'common', glyph: 'instinct',
    flavour: 'Whatever it was taken from spent its whole life being chased, and won.',
    description: (n) => `While below 40% health, gain +${pct(linear(0.18, n))} movement speed.`,
    hooks: {
      // Refreshed every step onto a buff slot rather than being a conditional
      // entry in the stat block. Conditional *stats* are the one shape
      // `Items.stats` cannot express — the cache is keyed on the base block and
      // would not rebuild when health crossed the threshold — whereas a short
      // buff re-applied while the condition holds expires on its own the moment
      // it stops, with no edge case to get wrong.
      //
      // Its own slot, `preyfoot`, and not Bloodied Spurs' `quickfoot`. A buff
      // name is a shared slot: `Items.addBuff` overwrites both magnitude and
      // remaining, so writing `quickfoot` here meant this item stamped its 0.5 s
      // +18% over the Spurs' 15 s +20% every single step while the player was
      // hurt. Holding both commons made the player *slower* than holding Spurs
      // alone (8.26 against 8.40 m/s, measured) — picking up an item was a
      // strict downgrade. `Items.stats` now multiplies the two together, which
      // is what two independent movement commons should do.
      onInterval: (e, api) => {
        const p = api.player;
        if (!p?.alive || p.health > (p.stats?.maxHealth || 100) * 0.4) return;
        api.items.addBuff('preyfoot', 0.5, 1, linear(0.18, api.count));
        cue(api, 'prey-instinct');
      },
    },
  },

  // ---------------------------------------------------------------- UNCOMMON
  {
    id: 'cracked-zither', name: 'Cracked Zither', tier: 'uncommon', glyph: 'bolt',
    flavour: 'It only knows one chord and the chord is lightning.',
    description: (n) => `${pct(hyperbolic(0.25, n))} chance on hit to fire chain lightning for 80% damage, bouncing to ${2 + linear(2, n)} targets.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.25, api.count))) return;
        chainLightning(api, e, api.items.baseDamage() * 0.8, 2 + linear(2, api.count));
        cue(api, 'cracked-zither', e);
      },
    },
  },
  {
    id: 'missile-rack', name: 'Missile Rack Mk. I', tier: 'uncommon', glyph: 'rocket',
    flavour: 'Fire and forget. Mostly forget.',
    description: (n) => `${pct(hyperbolic(0.10, n))} chance on hit to fire a missile for ${pct(linear(3, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.10, api.count))) return;
        api.ctx.vfx?.missile?.(api.player.position, e.position, ELEMENTS.blast.hue);
        cue(api, 'missile-rack', e);
        api.combat.explode(e.position, 5, api.items.baseDamage() * linear(3, api.count), api.player, {
          team: 'player', proc: 0.6, procDepth: api.procDepth, type: 'missile',
        });
      },
    },
  },
  {
    id: 'gutting-shiv', name: 'Gutting Shiv', tier: 'uncommon', glyph: 'blade',
    flavour: 'One edge, and it never lets the wound close.',
    description: (n) => `${pct(hyperbolic(0.15, n))} chance on hit to cause bleeding for 240% damage over 3s.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.15, api.count))) return;
        api.combat.applyStatus(e.target, 'bleed', api.player, 1);
        cue(api, 'gutting-shiv', e);
      },
    },
  },
  {
    id: 'concussion-charge', name: 'Concussion Charge', tier: 'uncommon', glyph: 'burst',
    flavour: 'Loud. Bright. Effective.',
    description: (n) => `${pct(hyperbolic(0.05, n))} chance on hit to stun enemies for 2s.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.05, api.count))) return;
        api.combat.applyStatus(e.target, 'shock', api.player, 1);
        cue(api, 'concussion-charge', e);
      },
    },
  },
  {
    id: 'hoarfrost-band', name: 'Hoarfrost Band', tier: 'uncommon', glyph: 'snowflake',
    flavour: 'Cold enough to stop a heart mid-beat.',
    description: (n) => `Hits that deal over 400% damage freeze and blast for ${pct(linear(2.5, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (e.amount < api.items.baseDamage() * 4) return;
        if (!api.items.cooldownReady('hoarfrost-band', 5)) return;
        api.combat.applyStatus(e.target, 'freeze', api.player, 1);
        api.combat.explode(e.position, 6, api.items.baseDamage() * linear(2.5, api.count), api.player, {
          team: 'player', proc: 0.3, procDepth: api.procDepth, type: 'frost',
        });
        cue(api, 'hoarfrost-band', e);
      },
    },
  },
  {
    id: 'feeding-vial', name: 'Feeding Vial', tier: 'uncommon', glyph: 'spiral',
    flavour: 'Every kill makes you a little more permanent.',
    description: (n) => `Killing an enemy permanently grants +1 max health, up to +${linear(100, n)}.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addPermanentHealth(1, linear(100, api.count));
        cue(api, 'feeding-vial');
      },
    },
  },
  {
    id: 'reaping-hook', name: 'Reaping Hook', tier: 'uncommon', glyph: 'scythe',
    flavour: 'It takes its cut on the way past.',
    description: (n) => `Critical strikes heal you for ${linear(8, n)}.`,
    hooks: {
      onHit: (e, api) => {
        if (!e.crit) return;
        api.combat.heal(api.player, linear(8, api.count));
        cue(api, 'reaping-hook');
      },
    },
  },
  {
    id: 'thirsting-burr', name: 'Thirsting Burr', tier: 'uncommon', glyph: 'leaf',
    flavour: 'It drinks and it grows.',
    description: (n) => `Dealing damage heals you for ${linear(1, n)}.`,
    hooks: {
      onHit: (e, api) => {
        api.combat.heal(api.player, linear(1, api.count));
        cue(api, 'thirsting-burr');
      },
    },
  },
  {
    id: 'bailout-thrusters', name: 'Bailout Thrusters', tier: 'uncommon', glyph: 'wing',
    flavour: 'Two more chances to be somewhere else.',
    description: (n) => `+${linear(2, n)} utility charges and ${pct(1 - hyperbolicMult(0.15, n))} utility cooldown reduction.`,
    stat: (n, s) => {
      s.extraCharges += linear(2, n);
      s.cooldownMult *= hyperbolicMult(0.15, n);
    },
  },
  {
    id: 'waxed-wing', name: 'Waxed Wing', tier: 'uncommon', glyph: 'feather',
    flavour: 'Up is a direction. Forward is a lifestyle.',
    // "While sprinting" was in this text and never in the hook, and until the
    // `jump` event existed nothing fired either way. Now that it does, the text
    // says what the code does: every jump.
    description: (n) => `Every jump boosts you forward by ${linear(10, n)} m/s.`,
    stat: (n, s) => { s.jumpCount += 0; },
    hooks: {
      onJump: (e, api) => { api.items.applyImpulse(linear(10, api.count)); },
    },
  },
  {
    id: 'hollow-plume', name: 'Hollow Plume', tier: 'uncommon', glyph: 'plume',
    flavour: 'Weightless, mostly.',
    description: (n) => `+${linear(1, n)} maximum jump count.`,
    stat: (n, s) => { s.jumpCount += linear(1, n); },
  },
  {
    id: 'corpse-flare', name: 'Corpse Flare', tier: 'uncommon', glyph: 'flamering',
    flavour: 'Follow the light. It is on fire.',
    description: (n) => `Killing an enemy detonates a ${pct(linear(3, n))} damage flame pillar.`,
    hooks: {
      onKill: (e, api) => {
        api.combat.explode(e.position, 8, api.items.baseDamage() * linear(3, api.count), api.player, {
          team: 'player', proc: 0.2, procDepth: api.procDepth, type: 'fire', status: 'burn',
        });
        cue(api, 'corpse-flare', e);
      },
    },
  },
  {
    id: 'dry-cell', name: 'Dry Cell', tier: 'uncommon', glyph: 'cell',
    flavour: 'Charged, sealed, and ready to be abused.',
    description: (n) => `+${linear(1, n)} equipment charge and ${pct(1 - hyperbolicMult(0.15, n))} equipment cooldown reduction.`,
    // The one item that pays into the equipment slot's own two dials. It writes
    // `equipCharges`, not `extraCharges`: the latter is the survivor's skill
    // charges, and letting one item silently buy both was the difference
    // between "Dry Cell is good with equipment" and "Dry Cell is mandatory".
    stat: (n, s) => {
      s.equipCharges += linear(1, n);
      s.equipCooldownMult *= hyperbolicMult(0.15, n);
    },
  },
  {
    id: 'red-mist-pauldron', name: 'Red-Mist Pauldron', tier: 'uncommon', glyph: 'pauldron',
    flavour: 'Three at once and the world goes red.',
    description: (n) => `Killing 3 enemies within 1s sends you into frenzy: +${pct(0.3)} attack and move speed for ${linear(6, n)}s.`,
    hooks: {
      onKill: (e, api) => {
        if (!api.items.tallyKillWindow(3, 1.0)) return;
        api.items.addBuff('berzerk', linear(6, api.count), 1, 0.3);
        cue(api, 'red-mist-pauldron');
      },
    },
  },

  {
    id: 'barb-snare', name: 'Barb Snare', tier: 'uncommon', glyph: 'razor',
    flavour: 'Strung at ankle height by someone who never came back for it.',
    description: (n) => `Being hurt lashes all enemies within ${6 + linear(2, n)}m for ${pct(linear(1.6, n))} damage.`,
    hooks: {
      onDamaged: (e, api) => {
        if (!api.items.cooldownReady('barb-snare', 0.5)) return;
        const radius = 6 + linear(2, api.count);
        for (const t of nearbyHostiles(api, api.player.position, radius)) {
          api.combat.applyDamage(t, api.items.baseDamage() * linear(1.6, api.count), {
            source: api.player, position: t.position, type: 'razor',
            procCoefficient: 0.2, procDepth: api.procDepth,
          });
        }
        api.ctx.vfx?.ring?.(api.player.position, radius, 0xff8fa0);
      },
    },
  },
  {
    id: 'squall-charm', name: 'Squall Charm', tier: 'uncommon', glyph: 'squall',
    flavour: 'The weather owes you a favour.',
    description: (n) => `${pct(hyperbolic(0.12, n))} chance on hit to cut a wind arc for ${pct(linear(1.8, n))} damage to 4 enemies.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.12, api.count))) return;
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.8, api.count), 4,
          ELEMENTS.bone.hue, 'wind', 'streak');
        cue(api, 'squall-charm', e);
      },
    },
  },
  {
    id: 'ration-pack', name: 'Sealed Ration Pack', tier: 'uncommon', glyph: 'ration',
    flavour: 'Expiry: illegible. Contents: enthusiastic.',
    description: (n) => `Killing an enemy heals ${linear(20, n)} health over 4s.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addBuff('mending', 4, 8, linear(5, api.count));
        cue(api, 'ration-pack');
      },
      onInterval: (e, api) => {
        const b = api.items.buffStacks('mending');
        if (b <= 0) return;
        api.combat.heal(api.player, b * api.items.buffMagnitude('mending') * e.dt);
      },
    },
  },
  {
    id: 'iron-thorns', name: 'Iron Thornplate', tier: 'uncommon', glyph: 'thorns',
    flavour: 'Defence that argues back.',
    description: (n) => `+${linear(14, n)} armor. Reflect ${pct(linear(0.5, n))} of damage taken back at the attacker.`,
    stat: (n, s) => { s.armor += linear(14, n); },
    hooks: {
      onDamaged: (e, api) => {
        const src = e.source;
        if (!src?.alive || src.isPlayer) return;
        api.combat.applyDamage(src, e.amount * linear(0.5, api.count), {
          source: api.player, position: src.position, type: 'thorns',
          procCoefficient: 0, procDepth: api.procDepth,
        });
        cue(api, 'iron-thorns', src);
      },
    },
  },
  {
    id: 'updraft-vents', name: 'Updraft Vents', tier: 'uncommon', glyph: 'updraft',
    flavour: 'Down is optional.',
    description: (n) => `+${linear(1, n)} jump count and each jump launches you forward ${linear(5, n)} m/s.`,
    stat: (n, s) => { s.jumpCount += linear(1, n); },
    hooks: {
      onJump: (e, api) => { api.items.applyImpulse(linear(5, api.count)); },
    },
  },
  {
    id: 'hunters-tag', name: "Hunter's Tag", tier: 'uncommon', glyph: 'tag',
    flavour: 'Marked. Filed. Collected.',
    description: (n) => `Your first hit marks an enemy for 8s; marked enemies take +${pct(linear(0.18, n))} damage.`,
    hooks: {
      // The mark itself is bookkeeping, not a status: Combat's status table is
      // for things that tick, and a pure damage multiplier that ticks nothing
      // would pay a full status slot plus its VFX for a number.
      onHit: (e, api) => {
        api.items.mark(e.target, 8);
        cue(api, 'hunters-tag', e);
      },
      outgoing: (amount, target, info, api) =>
        (api.items.isMarked(target) ? amount * (1 + linear(0.18, api.count)) : amount),
    },
  },
  {
    id: 'overcharge-cell', name: 'Overcharge Cell', tier: 'uncommon', glyph: 'overcharge',
    flavour: 'Rated for one discharge. It has had nine.',
    description: (n) => `Killing an enemy has a ${pct(hyperbolic(0.20, n))} chance to burst chain lightning through ${3 + linear(1, n)} targets for ${pct(linear(1.4, n))} damage.`,
    hooks: {
      onKill: (e, api) => {
        if (!api.roll(hyperbolic(0.20, api.count))) return;
        chainLightning(api, e, api.items.baseDamage() * linear(1.4, api.count), 3 + linear(1, api.count));
        api.ctx.audio?.play?.('zap', e.position);
      },
    },
  },
  {
    id: 'frost-lattice', name: 'Frost Lattice', tier: 'uncommon', glyph: 'lattice',
    flavour: 'It grows back overnight, whatever you do to it.',
    description: (n) => `${pct(hyperbolic(0.15, n))} chance on hit to chill an enemy, and every 4th chill freezes.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.15, api.count))) return;
        const deep = api.items.tally('frost-lattice', 4);
        api.combat.applyStatus(e.target, deep ? 'freeze' : 'slow', api.player, 1);
        cue(api, 'frost-lattice', e);
      },
    },
  },
  {
    id: 'scrap-magnet', name: 'Scrap Magnet', tier: 'uncommon', glyph: 'magnet',
    flavour: 'Everything valuable is ferrous, eventually.',
    description: (n) => `Killing an enemy pays +${pct(linear(0.30, n))} extra gold.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addGold(api.items.killReward(e.victim) * linear(0.30, api.count));
        cue(api, 'scrap-magnet');
      },
    },
  },
  {
    id: 'battle-hymn', name: 'Battle Hymn', tier: 'uncommon', glyph: 'hymn',
    flavour: 'Sung once, badly, by a survivor who did not survive.',
    description: (n) => `Being hurt grants +${pct(linear(0.15, n))} attack speed for 5s, up to 3 stacks.`,
    hooks: {
      onDamaged: (e, api) => {
        api.items.addBuff('frenzy', 5, 3, linear(0.15, api.count));
        cue(api, 'battle-hymn');
      },
    },
  },
  {
    id: 'carrion-flies', name: 'Carrion Flies', tier: 'uncommon', glyph: 'flies',
    flavour: 'They were here before you and they will stay after.',
    description: (n) => `A swarm orbits you, dealing ${pct(linear(0.5, n))} damage per second within 7m.`,
    hooks: {
      onInterval: (e, api) => {
        const targets = nearbyHostiles(api, api.player.position, 7);
        if (!targets.length) return;
        for (const t of targets) {
          api.combat.applyDamage(t, api.items.baseDamage() * linear(0.5, api.count) * e.dt, {
            source: api.player, position: t.position, type: 'swarm',
            procCoefficient: 0, procDepth: api.procDepth,
          });
          cue(api, 'carrion-flies', t);
        }
      },
    },
  },
  {
    id: 'rebar-launcher', name: 'Rebar Launcher', tier: 'uncommon', glyph: 'rebar',
    flavour: 'Construction surplus, repurposed enthusiastically.',
    description: (n) => `${pct(hyperbolic(0.08, n))} chance on hit to nail one enemy for ${pct(linear(5, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.08, api.count))) return;
        api.ctx.vfx?.beam?.(api.player.position, e.position, 0xd8b06a);
        api.combat.applyDamage(e.target, api.items.baseDamage() * linear(5, api.count), {
          source: api.player, position: e.position, type: 'rebar',
          procCoefficient: 0.4, procDepth: api.procDepth,
        });
      },
    },
  },

  // ------------------------------------------------- round 7 uncommons
  //
  // Green is the tier that decides what a build *is*, so every card here is a
  // multiplier on something the rest of the inventory is already doing rather
  // than a source of its own: one pays out the status effects the whites and
  // greens apply, one pays out movement, one pays out skill casts, one pays out
  // whatever the player is standing next to. Nothing below is worth much on an
  // empty run, and all of it compounds on a full one.
  {
    id: 'affliction-index', name: "Afflictor's Index", tier: 'uncommon', glyph: 'index',
    flavour: 'A field guide to everything that can be wrong with a body, cross-referenced.',
    description: (n) => `Deal +${pct(linear(0.25, n))} damage to enemies suffering burn, bleed, slow, freeze or shock.`,
    hooks: {
      // The one card in the file that scales off *other items' statuses* rather
      // than off a stat. Warm Coals, Gutting Shiv, Frost Lattice, Concussion
      // Charge and Hoarfrost Band are all cheap and all previously terminal —
      // they applied an ailment and the ailment did its own small damage. This
      // gives the whole ailment half of the pool a second output, which is what
      // turns "I keep picking up status commons" into a build.
      outgoing: (amount, target, info, api) =>
        (afflicted(api.combat, target) ? amount * (1 + linear(0.25, api.count)) : amount),
    },
  },
  {
    id: 'tether-harpoon', name: 'Grapnel Tether', tier: 'uncommon', glyph: 'harpoon',
    flavour: 'Range is a negotiation and this is the only argument it accepts.',
    description: (n) => `${pct(hyperbolic(0.10, n))} chance on hit to reel an enemy a third of the way to you — no closer than ${TETHER_FLOOR}m — and slow it.`,
    hooks: {
      // The stacking curve is deliberately in *breadth*, not in depth.
      //
      // Stacks buy proc chance and nothing else: `hyperbolic(0.10, n)` takes ten
      // of them from 10% to 50%, so a full stack reels far more of the field —
      // but each body may only be reeled once every `TETHER_RECOVER` seconds and
      // never inside `TETHER_FLOOR` metres. Without those two floors the curve
      // compounded: at 10 stacks, thirty hits (about four seconds of Ranger
      // primary fire) landed sixteen procs on the *same* body and 0.66^16 x 20 m
      // put it 0.02 m from the player's feet. That is not a strong item, it is
      // an item that deletes the game's whole positional layer, and the card's
      // own boss exclusion — "a boss whose position the player controls has no
      // fight left in it" — is exactly the argument against letting it happen to
      // everything else.
      //
      // The floor is 6 m rather than contact for a specific reason too: it is
      // outside the melee reach of every ordinary spawn, so a reel drags a
      // shooter into your kill zone without also stacking a pack inside your
      // own hitbox.
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.10, api.count))) return;
        const t = e.target;
        // Bosses are not furniture — the same rule Collapsing Well and Gravity
        // Snare keep, and for the same reason: a boss whose position the player
        // controls has no fight left in it.
        if (!t?.alive || t.isBoss) return;
        // Moving a monster is game state even though the beam that draws it is
        // not, so the displacement re-checks authority while the VFX below does
        // not. `onHit` only reaches here on the host today; the guard is what
        // stops that being load-bearing.
        if (api.ctx.authority) {
          if (!onceEvery(_reeled, t, api.ctx.time, TETHER_RECOVER)) return;
          const p = api.player.position;
          // Horizontal only. The old `Vector3.lerp` interpolated y as well, so
          // it hauled the Gloomshriver — a flyer whose entire card is holding
          // 6.4 m of altitude — down onto the floor and left it there. Altitude
          // belongs to the mover, which is the only thing that knows about
          // `hoverHeight` and terrain.
          const dx = p.x - t.position.x;
          const dz = p.z - t.position.z;
          const d = Math.hypot(dx, dz);
          if (d <= TETHER_FLOOR) return;
          const f = (d - Math.max(TETHER_FLOOR, d * 0.66)) / d;
          t.position.x += dx * f;
          t.position.z += dz * f;
          // Horizontal velocity only, for the same reason: zeroing y drops a
          // hovering unit for a frame.
          if (t.velocity) { t.velocity.x = 0; t.velocity.z = 0; }
          api.combat.applyStatus(t, 'slow', api.player, 1);
        }
        api.ctx.vfx?.beam?.(api.player.position, t.position, 0xd8c07a);
      },
    },
  },
  {
    id: 'emberwake', name: 'Emberwake Cleats', tier: 'uncommon', glyph: 'emberwake',
    flavour: 'The soles never cooled after the foundry. Neither did the man wearing them.',
    description: (n) => `While moving, scorch the ground behind you: a 3.2m cinder patch every 0.6s dealing ${pct(linear(0.55, n))} damage per second for 4s.`,
    hooks: {
      // Kiting becomes damage. Every other AoE in the file is anchored to a kill
      // or to a proc, so the player earns it by shooting; this one is earned by
      // *retreating*, which is the pattern the genre otherwise never rewards.
      // Bounded for free: `Items.addCloud` keeps at most MAX_CLOUDS alive and
      // discards the oldest, so a full lap of the arena costs a fixed number of
      // overlap queries rather than a growing one.
      onInterval: (e, api) => {
        if (!api.player?.moving) return;
        if (!api.items.cooldownReady('emberwake', 0.6)) return;
        // Fire colour and fire damage type, not the primitive's Spore Sac
        // default — a "cinder patch" that drew as a green spore ring was a
        // cosmetic lie about which hazard the player was standing in. No
        // `status`: this card never claimed to ignite, and giving it burn would
        // quietly make an uncommon into an ailment engine.
        api.items.addCloud(api.player.position, 3.2, 4, linear(0.55, api.count), {
          colour: ELEMENTS.fire.hue, type: 'fire',
        });
        cue(api, 'emberwake', api.player.position);
      },
    },
  },
  {
    id: 'arc-capacitor', name: 'Arc Capacitor', tier: 'uncommon', glyph: 'capacitor',
    flavour: 'It stores whatever you were about to do and gives it back louder.',
    description: (n) => `Using a skill charges your next hit: it arcs for ${pct(linear(2.2, n))} damage through ${3 + linear(1, n)} enemies.`,
    hooks: {
      // Rewards *weaving* — cast, then shoot — which is a rhythm no other item
      // asks for. The primary is excluded on purpose: a held M1 is a skill use
      // sixty times a minute and would make the charge permanent, i.e. would
      // turn a rhythm item into an unconditional chain lightning proc.
      onAbility: (e, api) => {
        if (!e.ability || e.ability.slot === 'primary') return;
        api.items.addBuff('arccharge', 5, 1, 1);
      },
      onHit: (e, api) => {
        if (api.items.buffStacks('arccharge') <= 0) return;
        api.items.clearBuff('arccharge');
        chainLightning(api, e, api.items.baseDamage() * linear(2.2, api.count), 3 + linear(1, api.count),
          { frame: 'radial-spark' });
        cue(api, 'arc-capacitor', e);
      },
    },
  },
  {
    id: 'scrapfly-hive', name: 'Scrapfly Hive', tier: 'uncommon', glyph: 'scrapfly',
    flavour: 'They eat metal, they nest in wounds, and they are extremely loyal about it.',
    description: (n) => `Every 14s, release a scrapfly that hunts one enemy at a time, striking for ${pct(linear(1.3, n))} damage and causing bleed once a second for 5s.`,
    hooks: {
      // What makes this card not a slower Hive Gland.
      //
      // It used to be exactly that and nothing else: five `seekingStrike` calls
      // fired from `player.position`, which is the identical call Hive Gland
      // makes from the identical origin, at a lower rate. There was no fly, no
      // follower and no DoT — the description promised all three. Two of the
      // three are now real, and they are the two that change how the item plays:
      //
      //  - The fly is a *position*. It is released at the player and closes on
      //    whatever it is chasing, and it re-acquires from where it is rather
      //    than from where the player is. So it works while the player retreats,
      //    it follows a pack the player has disengaged from, and its reach is
      //    measured from the front line instead of from the survivor.
      //  - It commits to one body until that body dies, applying `bleed` on
      //    every strike. Hive Gland sprays N distinct targets for burst; this
      //    picks one and takes it apart, which is a different answer to a
      //    different problem and ties the card to Afflictor's Index and the rest
      //    of the ailment half of the pool.
      onInterval: (e, api) => {
        if (!api.items.cooldownReady('scrapfly-hive', 14)) return;
        // The stack count is captured *now*: `Items._tickEffects` runs its
        // callbacks with `api.count = 1` (an effect is not an item stack), so a
        // closure that read `a.count` would silently price every hive at one.
        const stacks = api.count;
        // Released at the survivor; from here on it is the fly's own position
        // that matters, carried across the whole flight by this closure.
        const fly = api.player.position.clone();
        let quarry = null;
        // Ticked four times a second and striking on every fourth tick, so the
        // damage keeps its stated rhythm — five strikes about a second apart,
        // measured at 1.07/1.06/1.07/1.07 s — while the fly itself gets sixteen
        // intermediate positions to be *drawn* at. The card promised "release a
        // scrapfly" and drew nothing but a beam that teleported between two
        // points; a description of a creature the player never sees is the same
        // defect as a description of a radius that is not the radius. Now there
        // is a mote that leaves the survivor, crosses the arena, and lashes
        // what it catches: 22 of them per release, measured. Sixteen extra
        // no-op callbacks per 14 s is not a cost worth measuring against
        // `Items.fixedUpdate`'s 0.020 ms at 880 stacks.
        let tick = 0, struck = 0;
        api.ctx.vfx?.burst?.(fly, 0xc8d86a);
        api.items.addEffect('scrapfly-hive', 5.6, 0.25, (a) => {
          if (!quarry?.alive) quarry = a.combat.nearestHostile(fly, 30, 'player', null);
          if (!quarry) return;
          // Closes rather than teleports, so the fly reads as a thing crossing
          // the arena and the next re-acquire happens from where it ended up.
          // 0.18 a tick over four ticks covers the same ground the old 0.6 a
          // second did, so the reach measured from the front line is the same.
          fly.lerp(quarry.position, 0.18);
          a.ctx.vfx?.hitSpark?.(fly, 0xc8d86a, 0.45);
          // Five strikes, counted rather than inferred, and the duration above
          // carries the slack that lets the fifth one land.
          //
          // `Items._tickEffects` re-arms `t` to `interval` *after* subtracting
          // the step, so the realised period is a whole number of fixed steps
          // and lands at 0.267 s rather than 0.25. Over a 5.0 s effect that is
          // 18-19 ticks, not 20 — measured, one whole release from its first
          // tick paid **four** strikes at 1.07/1.06/1.07 s spacing for 62.4,
          // against a card that prints five. That shortfall predates this
          // change (the old 1.0 s interval quantised to 1.067 s and lost the
          // same strike); it is fixed here because the number a card prints is
          // the contract. 5.6 s buys the twenty-first tick, and the counter is
          // what stops the slack from ever buying a sixth strike.
          if (++tick % 4 || struck >= 5) return;
          struck++;
          a.ctx.vfx?.beam?.(fly, quarry.position, 0xc8d86a);
          a.combat.applyDamage(quarry, a.items.baseDamage() * linear(1.3, stacks), {
            source: a.player, position: quarry.position, type: 'scrapfly',
            procCoefficient: 1, procDepth: a.procDepth,
          });
          a.combat.applyStatus(quarry, 'bleed', a.player, 1);
        });
      },
    },
  },

  // --------------------------------------------------------------- LEGENDARY
  {
    id: 'shrapnel-heart', name: 'Shrapnel Heart', tier: 'legendary', glyph: 'nova',
    flavour: 'Everything you touch detonates. Including the things you did not mean to touch.',
    description: (n) => `ALL of your attacks explode in a ${linear(1.5, n) + 2.5}m radius for an extra 60% damage.`,
    hooks: {
      // The build-definer: it converts every single-target proc into an AoE,
      // which is what turns a linear DPS curve into the minute-20 slot machine.
      onHit: (e, api) => {
        if (e.type === 'shrapnel-heart') return; // never detonate our own detonation
        if (api.procDepth > api.combat.MAX_PROC_DEPTH - 1) return;
        api.combat.explode(e.position, 2.5 + linear(1.5, api.count), e.amount * 0.6, api.player, {
          team: 'player', proc: 0, procDepth: api.procDepth, type: 'shrapnel-heart', falloff: false,
        });
        // Tick intensity and throttled, per §4.2: this is the highest-frequency
        // proc in the game and a full-intensity cue on it dominates the mix.
        cue(api, 'shrapnel-heart', e);
      },
    },
  },
  {
    id: 'pressed-clover', name: 'Pressed Clover', tier: 'legendary', glyph: 'clover',
    flavour: 'Luck is a statistic you can purchase.',
    description: (n) => `All random effects are rolled +${linear(1, n)} extra times for a favourable outcome.`,
    stat: (n, s) => { s.luck += linear(1, n); },
  },
  {
    id: 'cortex-jar', name: 'Cortex Jar', tier: 'legendary', glyph: 'alien',
    flavour: 'It is still thinking.',
    description: (n) => `Reduce skill cooldowns by ${pct(1 - hyperbolicMult(0.25, n))}.`,
    stat: (n, s) => { s.cooldownMult *= hyperbolicMult(0.25, n); },
  },
  {
    id: 'killing-frost', name: 'Killing Frost', tier: 'legendary', glyph: 'shard',
    flavour: 'The cold follows you now.',
    description: (n) => `Killing an enemy surrounds you with an icy storm dealing ${pct(linear(1.2, n))} damage per second, growing with each kill.`,
    hooks: {
      onKill: (e, api) => { api.items.addBuff('frost', 6, 20, 1); },
      onInterval: (e, api) => {
        const stacks = api.items.buffStacks('frost');
        if (stacks <= 0) return;
        const radius = 5 + stacks * 0.7;
        const n = api.combat.sphereOverlap(api.player.position, radius, 'player');
        const targets = [];
        for (let i = 0; i < n; i++) targets.push(api.combat.overlapAt(i));
        for (const t of targets) {
          api.combat.applyDamage(t, api.items.baseDamage() * linear(1.2, api.count) * e.dt, {
            source: api.player, position: t.position, type: 'frost',
            procCoefficient: 0, procDepth: api.procDepth,
          });
          api.combat.applyStatus(t, 'slow', api.player, 1);
        }
        api.ctx.vfx?.ring?.(api.player.position, radius, 0x9fe8ff);
      },
    },
  },
  {
    id: 'mourners-dagger', name: "Mourner's Dagger", tier: 'legendary', glyph: 'daggers',
    flavour: 'The dead keep fighting for you.',
    description: (n) => `Killing an enemy releases ${linear(1, n) + 2} seeking daggers dealing ${pct(linear(1.5, n))} damage.`,
    hooks: {
      onKill: (e, api) => {
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.5, api.count),
          2 + linear(1, api.count), ELEMENTS.void.hue, 'dagger');
        cue(api, 'mourners-dagger', e);
      },
    },
  },
  {
    id: 'whisper-stalks', name: 'Whisper Stalks', tier: 'legendary', glyph: 'stalk',
    flavour: 'It whispers cooldown numbers at you.',
    description: (n) => `Killing an elite removes all skill cooldowns for ${linear(4, n)}s.`,
    hooks: {
      onKill: (e, api) => {
        if (!e.victim?.isElite) return;
        api.items.addBuff('nocooldown', linear(4, api.count), 1, 1);
        cue(api, 'whisper-stalks');
      },
    },
  },

  {
    id: 'star-chart', name: 'Star Chart', tier: 'legendary', glyph: 'chart',
    flavour: 'Someone plotted every coincidence and found a pattern.',
    description: (n) => `All of your chance-on-hit effects trigger ${pct(linear(0.30, n))} more often.`,
    // Lives on the stat block rather than in each item because `Items.roll` is
    // the single random gate every chance item goes through — putting the bonus
    // anywhere else would mean 30-odd items each remembering to apply it.
    stat: (n, s) => { s.procBonus += linear(0.30, n); },
  },
  {
    id: 'resonance-coil', name: 'Resonance Coil', tier: 'legendary', glyph: 'resonance',
    flavour: 'Every ninth strike is the one the metal remembers.',
    description: (n) => `Every 8th hit detonates a resonant pulse for ${pct(linear(6, n))} damage in a 7m radius.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.items.tally('resonance-coil', 8)) return;
        api.combat.explode(e.position, 7, api.items.baseDamage() * linear(6, api.count), api.player, {
          team: 'player', proc: 0.5, procDepth: api.procDepth, type: 'resonance',
        });
        cue(api, 'resonance-coil', e);
      },
    },
  },
  {
    id: 'chronal-governor', name: 'Chronal Governor', tier: 'legendary', glyph: 'chronal',
    flavour: 'It does not make you faster. It makes the wait shorter.',
    description: (n) => `Each kill grants a stacking ${pct(0.05)} cooldown reduction for 8s, up to ${linear(4, n) + 4} stacks.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addBuff('overclock', 8, 4 + linear(4, api.count), 0.05);
        cue(api, 'chronal-governor');
      },
    },
  },
  {
    id: 'siege-battery', name: 'Siege Battery', tier: 'legendary', glyph: 'battery',
    flavour: 'Charge is patience with a voltage.',
    description: (n) => `Every second without taking damage banks +${pct(linear(0.06, n))} damage, up to 10 charges. Losing health spends them all.`,
    hooks: {
      onDamaged: (e, api) => { api.items.clearBuff('siege'); },
      onInterval: (e, api) => {
        if (api.items.timeSinceHurt() < 1) return;
        if (!api.items.cooldownReady('siege-battery', 1)) return;
        api.items.addBuff('siege', 999, 10, linear(0.06, api.count));
        cue(api, 'siege-battery');
      },
      outgoing: (amount, target, info, api) =>
        amount * (1 + api.items.buffStacks('siege') * api.items.buffMagnitude('siege')),
    },
  },
  {
    id: 'vultures-mantle', name: "Vulture's Mantle", tier: 'legendary', glyph: 'mantle',
    flavour: 'It only fits once you have earned it, and it never comes off.',
    description: (n) => `Killing an elite grants +${pct(0.4)} movement speed and a ${linear(80, n)} point barrier for ${linear(8, n)}s.`,
    hooks: {
      onKill: (e, api) => {
        if (!e.victim?.isElite && !e.victim?.isBoss) return;
        api.items.addBuff('berzerk', linear(8, api.count), 1, 0.4);
        api.items.addBarrier(linear(80, api.count));
        api.ctx.vfx?.burst?.(api.player.position, 0xffc46a);
      },
    },
  },
  {
    id: 'prism-splinter', name: 'Prism Splinter', tier: 'legendary', glyph: 'prism',
    flavour: 'One shot went in. Nobody agrees how many came out.',
    description: (n) => `Critical strikes split into ${2 + linear(2, n)} shards dealing ${pct(linear(1.1, n))} damage each.`,
    hooks: {
      onHit: (e, api) => {
        if (!e.crit) return;
        // A crit shatter, so it happens *at the crit point*: bone-cream shards
        // in a radial-spark, not violet lines (§3 C9).
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.1, api.count),
          2 + linear(2, api.count), ELEMENTS.bone.hue, 'prism', 'radial-spark');
        cue(api, 'prism-splinter', e);
      },
    },
  },
  {
    id: 'gravity-well', name: 'Collapsing Well', tier: 'legendary', glyph: 'wellhole',
    flavour: 'It is not a hole. It is an opinion about where things belong.',
    description: (n) => `${pct(hyperbolic(0.06, n))} chance on hit to collapse a 12m sphere, dragging enemies in and dealing ${pct(linear(3, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.06, api.count))) return;
        const at = e.position;
        // Moving a monster is game state, so this half is host-only even though
        // the ring and the blast it rides with are not.
        if (api.ctx.authority) {
          for (const t of nearbyHostiles(api, at, 12)) {
            if (t.isBoss) continue;             // bosses are not furniture
            t.position.lerp(at, 0.55);
            t.velocity?.set?.(0, 0, 0);
            api.combat.applyStatus(t, 'slow', api.player, 1);
          }
        }
        api.ctx.vfx?.ring?.(at, 12, ELEMENTS.gravity.hue);
        cue(api, 'gravity-well', { position: at });
        api.combat.explode(at, 12, api.items.baseDamage() * linear(3, api.count), api.player, {
          team: 'player', proc: 0.4, procDepth: api.procDepth, type: 'gravity', falloff: false,
        });
      },
    },
  },
  {
    id: 'warlock-ember', name: 'Warlock Ember', tier: 'legendary', glyph: 'ember',
    flavour: 'Fire that has learned to look for the next one.',
    description: (n) => `Enemies killed while burning spread the fire to ${linear(3, n) + 2} enemies for ${pct(linear(2, n))} damage.`,
    hooks: {
      onKill: (e, api) => {
        if (!api.combat.hasStatus(e.victim, 'burn')) return;
        const targets = nearbyHostiles(api, e.position, 14).slice(0, 2 + linear(3, api.count));
        for (const t of targets) {
          // A spread, not an arc: travelling streaks between victims (§3 C7).
          api.ctx.vfx?.missile?.(e.position, t.position, ELEMENTS.fire.hue);
          api.combat.applyStatus(t, 'burn', api.player, 1);
          api.combat.applyDamage(t, api.items.baseDamage() * linear(2, api.count), {
            source: api.player, position: t.position, type: 'fire',
            procCoefficient: 0.2, procDepth: api.procDepth,
          });
          cue(api, 'warlock-ember', t);
        }
      },
    },
  },
  {
    id: 'kinetic-recycler', name: 'Kinetic Recycler', tier: 'legendary', glyph: 'recycler',
    flavour: 'Nothing is wasted. Especially not the parts that hurt.',
    description: (n) => `Blocking or absorbing a hit refunds a ${linear(60, n)} point barrier and detonates for ${pct(linear(4, n))} damage.`,
    hooks: {
      onDamaged: (e, api) => {
        if (!api.items.cooldownReady('kinetic-recycler', 2)) return;
        api.items.addBarrier(linear(60, api.count));
        api.combat.explode(api.player.position, 9, api.items.baseDamage() * linear(4, api.count), api.player, {
          team: 'player', proc: 0.3, procDepth: api.procDepth, type: 'kinetic',
        });
        cue(api, 'kinetic-recycler');
      },
    },
  },

  // ------------------------------------------------ round 7 legendaries
  //
  // Red is the tier where the run *changes*, so none of the three below is a
  // multiplier the player can hold and forget. Each one attaches its payout to a
  // resource the player was already managing — health, casts, gold — and makes
  // managing it differently the correct play.
  {
    id: 'entropy-ledger', name: 'Entropy Ledger', tier: 'legendary', glyph: 'entropy',
    flavour: 'It has been keeping score since before you arrived and it is nearly finished.',
    description: (n) => `Deal up to +${pct(linear(0.80, n))} damage, scaling with the fraction of your health that is missing.`,
    hooks: {
      // The inverse of every defensive item in the file, which is exactly why it
      // is worth a red slot: with Trauma Plate and Dented Buckler the correct
      // play is to stay topped up, and with this one it is to hold a wound. The
      // scale is capped at 80% missing rather than at 100% so the peak is
      // reachable without standing on 1 HP — an item that pays best at the point
      // of death is not a risk, it is a dare with no play in it.
      outgoing: (amount, target, info, api) => {
        const p = api.player;
        const max = p?.stats?.maxHealth || 100;
        const missing = Math.min(0.8, Math.max(0, 1 - (p?.health ?? max) / max)) / 0.8;
        return amount * (1 + missing * linear(0.80, api.count));
      },
    },
  },
  {
    id: 'temporal-echo', name: 'Temporal Echo', tier: 'legendary', glyph: 'echo',
    flavour: 'The second one is the one that was always going to happen.',
    description: (n) => `${pct(hyperbolic(0.35, n))} chance for your Secondary and Special skills to cast a second time, free, 0.9s later.`,
    hooks: {
      onAbility: (e, api) => {
        const ability = e.ability;
        if (!ability?.fire) return;
        // Primary is excluded because it fires several times a second and an
        // echo of it is just an attack-speed item with a delay. Utility is
        // excluded because every utility on the roster *displaces the caster* —
        // replaying a dash 0.9s after the fact would teleport the survivor out
        // of wherever they dodged to, i.e. the item would be at its most
        // dangerous exactly when it fired.
        if (ability.slot !== 'secondary' && ability.slot !== 'special') return;
        if (!api.roll(hyperbolic(0.35, api.count))) return;
        const { ctx, player } = api;
        player.schedule?.(0.9, () => {
          if (!player.alive) return;
          // The echo calls `fire` directly and therefore never emits
          // `abilityUsed` — which is what stops an echo echoing itself. It also
          // pays no cooldown and consumes no charge, which is the whole card.
          try { ability.fire(ctx, player); } catch (err) {
            console.error(`[items] temporal-echo replay of ${ability.id} threw:`, err);
          }
        });
      },
    },
  },
  {
    // `glyph: 'gildedcup'` and not `'reliquary'`: Gale Reliquary already owns
    // that case, and two items sharing a glyph is two identical tiles the moment
    // the tier recolour makes them the same plate.
    id: 'gilded-reliquary', name: 'Gilded Reliquary', tier: 'legendary', glyph: 'gildedcup',
    flavour: 'Value is a physical property. It just needed someone willing to test that.',
    description: (n) => `Deal +${pct(linear(0.05, n))} damage per ${GOLD_STEP} gold carried, up to +${pct(linear(0.05 * GOLD_CAP_STEPS, n))}. Spending gold spends the bonus.`,
    hooks: {
      // The only item in the game that argues with the shop. Every chest, drone
      // and shrine in a stage is now a choice between the item behind it and the
      // damage the gold itself is worth, and the cap is what keeps that a
      // decision rather than a strategy: at eight steps a full purse is worth
      // roughly one Shattered Covenant, so hoarding forever is strong and never
      // strictly correct.
      outgoing: (amount, target, info, api) => {
        const steps = Math.min(GOLD_CAP_STEPS, (api.items.gold || 0) / GOLD_STEP);
        return amount * (1 + steps * linear(0.05, api.count));
      },
    },
  },

  // -------------------------------------------------------------------- BOSS
  {
    id: 'monolith-knuckle', name: 'Monolith Knuckle', tier: 'boss', glyph: 'monolith',
    flavour: 'A shard of something that used to walk.',
    description: (n) => `+${linear(40, n)} maximum health and +${linear(1.6, n)} health regeneration.`,
    stat: (n, s) => {
      s.maxHealth += linear(40, n);
      s.healthRegen += linear(1.6, n);
    },
  },
  {
    id: 'grafted-polyp', name: 'Grafted Polyp', tier: 'boss', glyph: 'polyp',
    flavour: 'It feeds on the pain of its host. Symbiotically.',
    description: (n) => `Heal for ${linear(15, n)} whenever you are hit.`,
    hooks: {
      onDamaged: (e, api) => {
        api.combat.heal(api.player, linear(15, api.count));
        cue(api, 'grafted-polyp');
      },
    },
  },
  {
    id: 'hive-gland', name: 'Hive Gland', tier: 'boss', glyph: 'hive',
    flavour: 'Something in here is still gestating.',
    description: (n) => `Every 10s, release a swarm striking ${linear(3, n)} enemies for ${pct(2)} damage.`,
    hooks: {
      onInterval: (e, api) => {
        if (!api.items.cooldownReady('gland', 10)) return;
        // A swarm of motes, so acid-green streaks — the gland was never gravity.
        seekingStrike(api, api.player.position, api.items.baseDamage() * 2, linear(3, api.count),
          ELEMENTS.toxic.hue, 'swarm', 'streak');
        cue(api, 'hive-gland', api.player.position);
      },
    },
  },
  {
    id: 'sunken-vertebra', name: 'Sunken Vertebra', tier: 'boss', glyph: 'vertebra',
    flavour: 'Part of a spine that held up something the size of a hill.',
    description: (n) => `+${linear(20, n)} armor, and being hurt grants a ${linear(30, n)} point barrier.`,
    stat: (n, s) => { s.armor += linear(20, n); },
    hooks: {
      onDamaged: (e, api) => {
        if (!api.items.cooldownReady('sunken-vertebra', 1)) return;
        api.items.addBarrier(linear(30, api.count));
        cue(api, 'sunken-vertebra');
      },
    },
  },
  {
    id: 'molten-core', name: 'Molten Core', tier: 'boss', glyph: 'moltencore',
    flavour: 'It has not cooled since the mountain opened.',
    description: (n) => `Every 6s, erupt for ${pct(linear(4, n))} damage in a 10m radius and ignite everything caught.`,
    hooks: {
      onInterval: (e, api) => {
        if (!api.items.cooldownReady('molten-core', 6)) return;
        api.combat.explode(api.player.position, 10, api.items.baseDamage() * linear(4, api.count), api.player, {
          team: 'player', proc: 0.3, procDepth: api.procDepth, type: 'fire', status: 'burn',
        });
        cue(api, 'molten-core');
      },
    },
  },
  {
    id: 'carapace-plate', name: 'Carapace Plate', tier: 'boss', glyph: 'carapace',
    flavour: 'Peeled off something that resented losing it.',
    description: (n) => `Reduce all incoming damage by ${linear(9, n)} and gain +${linear(60, n)} maximum health.`,
    stat: (n, s) => {
      s.flatReduction += linear(9, n);
      s.maxHealth += linear(60, n);
    },
  },
  {
    id: 'spore-sac', name: 'Spore Sac', tier: 'boss', glyph: 'sporesac',
    flavour: 'It bursts. Then everything nearby has a very bad week.',
    description: (n) => `Killing an enemy leaves a spore cloud dealing ${pct(linear(1.2, n))} damage per second for 5s.`,
    hooks: {
      onKill: (e, api) => {
        api.items.addCloud(e.position, 6, 5, linear(1.2, api.count));
        cue(api, 'spore-sac', e);
      },
    },
  },

  {
    id: 'tectonic-heart', name: 'Tectonic Heart', tier: 'boss', glyph: 'tectonic',
    flavour: 'Still beating, on the geological schedule it was built to.',
    description: (n) => `Every 3rd jump erupts a 9m quake for ${pct(linear(3.5, n))} damage and throws you forward.`,
    hooks: {
      // The boss tier is otherwise entirely passive — health, armour, a timer —
      // and this is the one card in it the player has a button for. It rides
      // `tally` rather than a chance so the third jump is a beat you can count
      // and set up, which is the difference between an item that goes off and an
      // item you play around. `tally` is host-only, so a client never advances
      // the counter and the two machines cannot disagree about which jump it was.
      onJump: (e, api) => {
        // A remote pawn's jump, seen on the host, must not advance this tally
        // or erupt at this player's feet — and because `tally` is host-only the
        // client cannot fire this card for its own jump either, so skipping the
        // pawn here is also what keeps the two machines agreeing about the
        // impulse: both compute 0 from this card for a client's jump.
        if (e.local === false) return;
        if (!api.items.tally('tectonic-heart', 3)) return;
        api.combat.explode(api.player.position, 9, api.items.baseDamage() * linear(3.5, api.count), api.player, {
          team: 'player', proc: 0.4, procDepth: api.procDepth, type: 'quake',
        });
        // Composes with Waxed Wing and Updraft Vents. That sentence used to be
        // written here beside a `Math.max` channel, which is the definition of
        // competing — measured, one Waxed Wing plus one Updraft Vents launched
        // at exactly the Wing's own 20.15 m/s and this 6 was unreachable in any
        // inventory holding either. `Items.applyImpulse` sums now, so the throw
        // is worth its 6 m/s on top of whatever else the jump banked.
        api.items.applyImpulse(6);
        api.ctx.vfx?.ring?.(api.player.position, 9, 0xffa514);
        api.ctx.pipeline?.addShake?.(0.12);
      },
    },
  },

  // ------------------------------------------------------------------- LUNAR
  //
  // Every card here is a *trade*, not an upgrade. That is the entire identity of
  // the tier: a Lunar item with a downside the player can ignore is a green item
  // wearing a blue frame, and the moment one of these stops being a real
  // decision the tier stops being interesting. Each drawback below is expressed
  // in something the player already reads on the HUD — health, regeneration,
  // armor, block — so the cost is legible the instant it lands rather than
  // hiding in a spreadsheet.
  //
  // Note that the drawbacks are implemented purely through the stat block and
  // the hook bus, which is deliberate: nothing in Combat or Player needed a
  // special case for the tier, so "Lunar" is a data label the rest of the game
  // never has to know about.
  {
    id: 'shattered-covenant', name: 'Shattered Covenant', tier: 'lunar', glyph: 'covenant',
    flavour: 'It offered a bargain. It did not offer to explain it.',
    description: (n) => `+${pct(linear(0.8, n))} damage. Your maximum health is reduced to ${pct(hyperbolicMult(0.55, n))}.`,
    // Both halves go through the *Mult accumulators rather than touching
    // `damage`/`maxHealth` directly. Those two fields are additively built up by
    // a dozen other items, and a multiplier applied mid-iteration would scale
    // whichever of them happened to be inserted into the inventory Map first —
    // i.e. the outcome would depend on the order chests were opened in.
    stat: (n, s) => {
      s.damageMult *= 1 + linear(0.8, n);
      s.healthMult *= hyperbolicMult(0.55, n);
    },
  },
  {
    id: 'hollow-vow', name: 'Hollow Vow', tier: 'lunar', glyph: 'vow',
    flavour: 'Swear off the shield and the hand moves quicker.',
    description: (n) => `+${pct(linear(1.0, n))} attack speed. You can no longer block or reduce flat damage.`,
    // `noDefensive` is consumed at the end of the stat build, after every other
    // item has contributed — otherwise the outcome would depend on inventory
    // iteration order, i.e. on the order chests happened to be opened in.
    stat: (n, s) => {
      s.attackSpeed += linear(1.0, n);
      s.noDefensive = true;
    },
  },
  {
    id: 'mercury-anklet', name: 'Mercury Anklet', tier: 'lunar', glyph: 'anklet',
    flavour: 'Quicksilver in the joint. It runs. You follow.',
    description: (n) => `+${pct(linear(0.5, n))} movement speed and +${linear(1, n)} jump. You take ${pct(2 - 100 / (100 + linear(35, n)))} more damage.`,
    stat: (n, s) => {
      s.moveSpeed *= 1 + linear(0.5, n);
      s.jumpCount += linear(1, n);
      // Negative armor is already an amplifier in Combat's mitigation curve and
      // is asymptotic, so no stack count can make the player take infinite
      // damage — which is what a naive multiplier would eventually do.
      s.armor -= linear(35, n);
    },
  },
  {
    id: 'tithe-of-ash', name: 'Tithe of Ash', tier: 'lunar', glyph: 'tithe',
    flavour: 'Pay in what you were going to lose anyway.',
    description: (n) => `Kills pay +${pct(linear(2, n))} gold. All of your damage is reduced by ${pct(1 - hyperbolicMult(0.45, n))}.`,
    stat: (n, s) => { s.damageMult *= hyperbolicMult(0.45, n); },
    hooks: {
      onKill: (e, api) => {
        api.items.addGold(api.items.killReward(e.victim) * linear(2, api.count));
        cue(api, 'tithe-of-ash');
      },
    },
  },
  {
    id: 'charnel-bloom', name: 'Charnel Bloom', tier: 'lunar', glyph: 'bloom',
    flavour: 'It only flowers where something stopped.',
    description: (n) => `Killing an enemy heals ${pct(linear(0.08, n))} of maximum health. You no longer regenerate health passively.`,
    // A flag rather than `s.healthRegen = 0`, for the same reason `noDefensive`
    // is one: zeroing the field mid-iteration keeps whatever regeneration an
    // item inserted later in the Map adds, so the survivor's regen depended on
    // which order the two were picked up in.
    stat: (n, s) => { s.noRegen = true; },
    hooks: {
      onKill: (e, api) => {
        const p = api.player;
        api.combat.heal(p, (p.stats?.maxHealth || 100) * linear(0.08, api.count));
        cue(api, 'charnel-bloom');
      },
    },
  },
  {
    id: 'brittle-edge', name: 'Brittle Edge', tier: 'lunar', glyph: 'brittle',
    flavour: 'It cuts both ways, and it is honest about which way is which.',
    description: (n) => `+${pct(hyperbolic(0.45, n))} critical strike chance. Every critical strike costs ${pct(linear(0.03, n))} of your current health, down to 30%.`,
    stat: (n, s) => { s.critChance = 1 - (1 - s.critChance) * (1 - hyperbolic(0.45, n)); },
    hooks: {
      onHit: (e, api) => {
        if (!e.crit) return;
        payHealth(api, api.player.health * linear(0.03, api.count));
        cue(api, 'brittle-edge');
      },
    },
  },
  {
    id: 'gale-reliquary', name: 'Gale Reliquary', tier: 'lunar', glyph: 'reliquary',
    flavour: 'The saint inside is very fast and very tired.',
    description: (n) => `Reduce skill cooldowns by ${pct(1 - hyperbolicMult(0.85, n))}. Every skill use costs ${pct(linear(0.04, n))} of your maximum health, down to 30%.`,
    stat: (n, s) => { s.cooldownMult *= hyperbolicMult(0.85, n); },
    hooks: {
      // Fired off the `abilityUsed` bus event rather than a bespoke hook —
      // Player already announces every cast, and inventing a second channel for
      // the same fact is how two systems end up disagreeing about it.
      onAbility: (e, api) => {
        payHealth(api, (api.player.stats?.maxHealth || 100) * linear(0.04, api.count));
      },
    },
  },
  {
    id: 'vow-of-momentum', name: 'Vow of Momentum', tier: 'lunar', glyph: 'momentum',
    flavour: 'Swear never to plant your feet. It is listening, and it checks.',
    description: (n) => `+${pct(linear(1.1, n))} damage while moving. Your damage is reduced to ${pct(hyperbolicMult(0.9, n))} while standing still.`,
    hooks: {
      // The tier's rule is that a Lunar has to be a decision, and the sharpest
      // way to make one is to have the card argue with something the player may
      // already own: this is Folding Bipod inverted, and a run holding both is
      // holding two items that cancel. It is also the only drawback in the tier
      // the player can *play around* moment to moment rather than eat — which is
      // why it can afford a much larger upside than Shattered Covenant's.
      //
      // Both halves are one multiplicative `outgoing`, so there is no stat-block
      // ordering question at all.
      outgoing: (amount, target, info, api) =>
        (api.player?.moving
          ? amount * (1 + linear(1.1, api.count))
          : amount * hyperbolicMult(0.9, api.count)),
    },
  },
  {
    id: 'ashen-pact', name: 'Ashen Pact', tier: 'lunar', glyph: 'ashenpact',
    flavour: 'It agreed to burn everything you touch. You were not excluded from the list.',
    description: (n) => `All of your hits ignite. You burn too: lose ${pct(linear(0.015, n))} of your maximum health every second, down to 50%.`,
    hooks: {
      // Unconditional ignite is a bigger card than it looks: it hands the whole
      // burn half of the pool — Ash-adjacent commons, Warlock Ember, Afflictor's
      // Index — a guaranteed trigger instead of a chance one. The cost is paid
      // per *second held* rather than per hit, so it does not scale with attack
      // speed and cannot be outrun by a fast primary; the only way to reduce it
      // is to be worth less health, which is its own decision.
      onHit: (e, api) => {
        api.combat.applyStatus(e.target, 'burn', api.player, 1);
        cue(api, 'ashen-pact', e);
      },
      onInterval: (e, api) => {
        if (!api.items.cooldownReady('ashen-pact', 1)) return;
        // Two numbers here, and both of them were wrong in the same direction.
        //
        // A fraction of *current* health is a cost that pays itself off: it is
        // an exponential decay onto the floor, so the bill shrinks every second
        // and the last one before the floor is nearly nothing. Measured, ten
        // stacks settled at 0.303 of maximum in eight seconds and then cost
        // exactly zero for the rest of the run. A fraction of *maximum* keeps
        // costing the same every second, so healing, shields and level-up
        // health are all eaten at a constant rate for as long as the card is
        // held — the player has to keep paying to stay where they are.
        //
        // And the floor is 50%, not the shared 30%. At 30% this card was not a
        // drawback at all, it was a free enabler: it parks the player, without
        // any decision on their part, inside Prey Instinct's below-40% band and
        // at 87% of Entropy Ledger's one-stack maximum (+69.7% on a 100 hit).
        // Three cards from this same round, and holding all three made the
        // Lunar strictly positive. At 50% the pact spends half the health bar
        // — a real and permanent loss of effective HP, which is the trade the
        // tier promises — and the low-health payoffs still have to be earned by
        // taking actual damage, with actual risk, on top of it.
        payHealth(api, (api.player.stats?.maxHealth || 100) * linear(0.015, api.count), 0.50);
      },
    },
  },
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const ITEMS_BY_TIER = ITEMS.reduce((acc, i) => {
  (acc[i.tier] ||= []).push(i);
  return acc;
}, {});

/**
 * The corruption index, both directions.
 *
 * `BLIGHT_BY_BASE` is the read the pickup path actually needs — "is anything I
 * am holding waiting to eat this id" — and it is a Map rather than a scan
 * because `give` is on the pickup hot path. Building it here also makes the
 * one-blight-card-per-base rule structural: a second card naming an already
 * corrupted base would silently overwrite the first in this Map, so the
 * constructor throws instead of shipping a pairing that only works half the
 * time. `reviews/round6/C2-corruption.test.mjs` asserts the same thing, but a
 * data file that can express an impossible state is worth closing at the source.
 */
export const BLIGHT_ITEMS = ITEMS.filter((i) => i.tier === 'blight');
export const BLIGHT_BY_BASE = (() => {
  const m = new Map();
  for (const i of BLIGHT_ITEMS) {
    if (!i.corrupts) throw new Error(`[items] blight card "${i.id}" names no base item`);
    if (!ITEM_BY_ID.has(i.corrupts)) throw new Error(`[items] blight card "${i.id}" corrupts unknown item "${i.corrupts}"`);
    if (ITEM_BY_ID.get(i.corrupts).tier === 'blight') throw new Error(`[items] blight card "${i.id}" corrupts another blight card`);
    if (m.has(i.corrupts)) throw new Error(`[items] "${i.corrupts}" is corrupted by both "${m.get(i.corrupts).id}" and "${i.id}"`);
    m.set(i.corrupts, i);
  }
  return m;
})();

// ---------------------------------------------------------------------- icons

const iconCache = new Map();

/**
 * Procedural item icons: a tier-coloured frame plus a geometric emblem derived
 * from the item's `glyph`. Drawing them beats shipping 30 sprites and keeps the
 * project asset-free, which the build depends on.
 */
export function itemIcon(id, size = 64) {
  const key = `${id}:${size}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const item = ITEM_BY_ID.get(id);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!item) return canvas;

  const tier = TIERS[item.tier];
  const s = size;
  const c = s / 2;

  // Backing: a dark plate with a tier-tinted radial glow so legendaries read
  // hot at a glance in the HUD strip.
  const grad = g.createRadialGradient(c, c, s * 0.05, c, c, s * 0.6);
  grad.addColorStop(0, shade(tier.css, 0.35));
  grad.addColorStop(1, '#0d0f14');
  g.fillStyle = grad;
  roundRect(g, s * 0.04, s * 0.04, s * 0.92, s * 0.92, s * 0.14);
  g.fill();

  g.strokeStyle = tier.css;
  g.lineWidth = Math.max(2, s * 0.05);
  roundRect(g, s * 0.06, s * 0.06, s * 0.88, s * 0.88, s * 0.13);
  g.stroke();

  g.save();
  g.translate(c, c);
  g.strokeStyle = '#ffffff';
  g.fillStyle = tier.css;
  g.lineWidth = Math.max(1.5, s * 0.045);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  drawGlyph(g, item.glyph, s * 0.28, hashHue(item.id));
  g.restore();

  iconCache.set(key, canvas);
  return canvas;
}

/** Data URL form, for HUD code that would rather set a CSS background. */
export function itemIconURL(id, size = 64) {
  return itemIcon(id, size).toDataURL();
}

function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function shade(css, amount) {
  const n = parseInt(css.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * amount);
  const gg = Math.round(((n >> 8) & 255) * amount);
  const b = Math.round((n & 255) * amount);
  return `rgb(${r},${gg},${b})`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function poly(g, sides, r, rot = 0, inner = 0) {
  g.beginPath();
  const steps = inner ? sides * 2 : sides;
  for (let i = 0; i < steps; i++) {
    const rad = inner && i % 2 ? r * inner : r;
    const a = rot + (i / steps) * Math.PI * 2;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.closePath();
}

/**
 * Draws one item glyph centred on the current transform origin, inside a
 * roughly `r`-radius box. Exported because the HUD's icon factory
 * (`src/ui/Icons.js`) draws it straight onto its own plate: it used to blit
 * this whole canvas overscanned to push the rounded plate off the clip, which
 * also scaled the glyph and cropped the wide ones flush into the tile border.
 */
export function drawGlyph(g, glyph, r, hue) {
  g.fillStyle = `hsl(${hue} 70% 62%)`;
  switch (glyph) {
    // Bruised Coinpurse — a stack of coins. A plain disc was a hexagon with the
    // corners knocked off next to `hex`, and the tier recolour means the two
    // no longer differ in anything but shape.
    case 'circle':
      for (let i = 1; i >= -1; i--) {
        g.beginPath(); g.ellipse(0, i * r * 0.52, r * 0.92, r * 0.34, 0, 0, Math.PI * 2);
        g.fill(); g.stroke();
      }
      // Dark rims, or the white strokes weld the three coins into one blob at
      // 33px and it reads as `hex`.
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      for (let i = 1; i >= 0; i--) {
        g.beginPath(); g.ellipse(0, i * r * 0.52 - r * 0.26, r * 0.92, r * 0.34, 0, 0.15, Math.PI - 0.15);
        g.stroke();
      }
      g.restore(); break;
    case 'ring':
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(0, 0, r * 0.45, 0, Math.PI * 2); g.fill(); break;
    // Bloodscent — a fang, not a plain triangle. The dark inner wedge
    // is what separates it from `arrow`, `flint` and `flame` at 20px: three
    // solid convex blobs of the same area differ by less than a tenth of their
    // mask, which is round 4's D3 floor failing.
    case 'triangle':
      poly(g, 3, r, -Math.PI / 2); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      poly(g, 3, r * 0.42, Math.PI / 2); g.fill(); g.restore(); break;
    // Tar Charge — a charge with a lit fuse and a seam, not a bare rhombus.
    case 'diamond':
      poly(g, 4, r * 0.92, -Math.PI / 2); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.2);
      g.beginPath(); g.moveTo(-r * 0.5, r * 0.1); g.lineTo(r * 0.5, r * 0.1); g.stroke();
      g.restore();
      g.beginPath();
      g.moveTo(r * 0.16, -r * 0.76);
      g.quadraticCurveTo(r * 0.86, -r * 0.9, r * 0.72, -r * 1.24);
      g.stroke();
      g.beginPath(); g.arc(r * 0.72, -r * 1.24, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
      break;
    // Dented Buckler — a hollow shell that took the hit. Hollowing it is the
    // only thing that separates it from `shield`, `saltcube`, `pouch` and
    // `diamond`, all of which are convex commons of the same optical area.
    case 'hex':
      poly(g, 6, r, 0); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14'; poly(g, 6, r * 0.58, 0); g.fill(); g.restore();
      poly(g, 6, r * 0.58, 0); g.stroke();
      poly(g, 6, r * 0.24, Math.PI / 6); g.fill(); g.stroke(); break;
    case 'star': poly(g, 5, r, -Math.PI / 2, 0.45); g.fill(); g.stroke(); break;
    // A table-cut brooch, not a soft hexagon — `shield` is the other broad
    // six-ish blob in the common tier.
    case 'gem':
      g.beginPath();
      g.moveTo(-r * 0.5, -r * 0.62); g.lineTo(r * 0.5, -r * 0.62);
      g.lineTo(r, -r * 0.1); g.lineTo(0, r); g.lineTo(-r, -r * 0.1);
      g.closePath(); g.fill(); g.stroke();
      // Facets in the *plate* colour, not white. A white facet line has the same
      // luminosity as the white outline, so it added no mask difference at all
      // and the brooch measured 5.8% from a bare `diamond`.
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.16);
      g.beginPath();
      g.moveTo(-r * 0.86, -r * 0.1); g.lineTo(r * 0.86, -r * 0.1);
      g.moveTo(-r * 0.5, -r * 0.56); g.lineTo(-r * 0.16, -r * 0.1);
      g.moveTo(r * 0.5, -r * 0.56); g.lineTo(r * 0.16, -r * 0.1);
      g.moveTo(-r * 0.5, -r * 0.1); g.lineTo(0, r * 0.86);
      g.moveTo(r * 0.5, -r * 0.1); g.lineTo(0, r * 0.86);
      g.stroke(); g.restore(); break;
    // Monolith Knuckle — a standing stone with strata cut into it, so it is not a
    // bare filled rectangle beside `polyp` in the boss tier.
    case 'monolith':
      g.fillRect(-r * 0.45, -r, r * 0.9, r * 2); g.strokeRect(-r * 0.45, -r, r * 0.9, r * 2);
      g.save(); g.fillStyle = '#0d0f14';
      for (let i = -1; i <= 1; i++) g.fillRect(-r * 0.45, i * r * 0.56 - r * 0.1, r * 0.9, r * 0.2);
      g.restore(); break;
    case 'plus':
      g.fillRect(-r * 0.28, -r, r * 0.56, r * 2);
      g.fillRect(-r, -r * 0.28, r * 2, r * 0.56); break;
    // A crowbar, not a second medkit. `plus` and `cross` used to share this
    // case; once the tier recolour made every common item the same grey, two
    // items drawing one shape became two identical tiles.
    case 'cross':
      g.save(); g.rotate(-0.62);
      g.fillRect(-r * 0.17, -r * 0.5, r * 0.34, r * 1.5);
      g.strokeRect(-r * 0.17, -r * 0.5, r * 0.34, r * 1.5);
      g.beginPath();
      g.moveTo(-r * 0.17, -r * 0.44);
      g.lineTo(-r * 0.78, -r * 0.86);
      g.lineTo(-r * 0.34, -r * 1.04);
      g.lineTo(0, -r * 0.72);
      g.lineTo(r * 0.34, -r * 1.04);
      g.lineTo(r * 0.78, -r * 0.86);
      g.lineTo(r * 0.17, -r * 0.44);
      g.closePath(); g.fill(); g.stroke();
      g.restore(); break;
    case 'bars':
      for (let i = -1; i <= 1; i++) g.fillRect(i * r * 0.55 - r * 0.16, -r, r * 0.32, r * 2);
      break;
    case 'arrow':
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.8, r * 0.3); g.lineTo(0, r * 0.05); g.lineTo(-r * 0.8, r * 0.3);
      g.closePath(); g.fill(); g.stroke(); break;
    case 'bolt':
      g.beginPath(); g.moveTo(r * 0.25, -r); g.lineTo(-r * 0.6, r * 0.1); g.lineTo(0, r * 0.1);
      g.lineTo(-r * 0.25, r); g.lineTo(r * 0.6, -r * 0.1); g.lineTo(0, -r * 0.1);
      g.closePath(); g.fill(); g.stroke(); break;
    // Cured Haunch: a cut of meat, so it carries marbling. As a bare teardrop it
    // measured 5.2% from `plug` — the tightest same-tier pair in the set.
    case 'drop':
      g.beginPath(); g.moveTo(0, -r); g.quadraticCurveTo(r, 0, 0, r); g.quadraticCurveTo(-r, 0, 0, -r);
      g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.15);
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(-r * 0.42, i * r * 0.38 + r * 0.12);
        g.quadraticCurveTo(0, i * r * 0.38 - r * 0.14, r * 0.42, i * r * 0.38 + r * 0.12);
        g.stroke();
      }
      g.restore(); break;
    case 'polyp':
      g.beginPath(); g.moveTo(0, -r); g.quadraticCurveTo(r, 0, 0, r); g.quadraticCurveTo(-r, 0, 0, -r);
      g.fill(); g.stroke(); break;
    // Three licks off a common base. The old single lobe was a teardrop with a
    // kinked bottom, i.e. `drop` — and drop and flame are both common tier, so
    // they have nothing but shape to tell them apart.
    case 'flame': case 'flamering':
      g.beginPath(); g.moveTo(0, -r);
      g.quadraticCurveTo(r * 0.92, -r * 0.15, r * 0.62, r * 0.9);
      g.lineTo(r * 0.3, r * 0.26);
      g.lineTo(r * 0.04, r * 0.9);
      g.lineTo(-r * 0.3, r * 0.26);
      g.lineTo(-r * 0.62, r * 0.9);
      g.quadraticCurveTo(-r * 0.92, -r * 0.15, 0, -r);
      g.closePath(); g.fill(); g.stroke();
      // Dark inner lick — a flame has a cool core, and without it the outline
      // is a convex blob indistinguishable from `triangle` or `flint`.
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.moveTo(0, -r * 0.3);
      g.quadraticCurveTo(r * 0.42, r * 0.1, r * 0.2, r * 0.6);
      g.lineTo(-r * 0.2, r * 0.6);
      g.quadraticCurveTo(-r * 0.42, r * 0.1, 0, -r * 0.3);
      g.closePath(); g.fill(); g.restore();
      if (glyph === 'flamering') { g.beginPath(); g.arc(0, 0, r * 1.15, 0, Math.PI * 2); g.stroke(); }
      break;
    case 'rocket':
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.4, -r * 0.1); g.lineTo(r * 0.4, r * 0.7);
      g.lineTo(-r * 0.4, r * 0.7); g.lineTo(-r * 0.4, -r * 0.1); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.4, r * 0.2); g.lineTo(-r * 0.9, r); g.lineTo(-r * 0.4, r);
      g.moveTo(r * 0.4, r * 0.2); g.lineTo(r * 0.9, r); g.lineTo(r * 0.4, r); g.stroke(); break;
    case 'blade': case 'daggers':
      g.beginPath(); g.moveTo(-r * 0.1, r); g.lineTo(-r * 0.1, -r * 0.3);
      g.lineTo(r * 0.6, -r); g.lineTo(r * 0.25, r * 0.2); g.closePath(); g.fill(); g.stroke();
      if (glyph === 'daggers') { g.save(); g.rotate(Math.PI); g.beginPath(); g.moveTo(-r * 0.1, r); g.lineTo(-r * 0.1, -r * 0.3); g.lineTo(r * 0.6, -r); g.lineTo(r * 0.25, r * 0.2); g.closePath(); g.fill(); g.stroke(); g.restore(); }
      break;
    // Haft plus a hooked blade — the silhouette a straight `blade` cannot make.
    case 'scythe':
      g.beginPath();
      g.moveTo(r * 0.34, r); g.lineTo(r * 0.62, r * 0.86);
      g.lineTo(r * 0.05, -r * 0.52); g.lineTo(-r * 0.22, -r * 0.4);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(r * 0.1, -r * 0.6);
      g.quadraticCurveTo(-r * 1.0, -r * 0.95, -r * 0.86, r * 0.3);
      g.quadraticCurveTo(-r * 0.62, -r * 0.36, r * 0.02, -r * 0.2);
      g.closePath(); g.fill(); g.stroke(); break;
    case 'burst': case 'nova':
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.beginPath(); g.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35);
        g.lineTo(Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1); g.stroke();
      }
      g.beginPath(); g.arc(0, 0, r * 0.35, 0, Math.PI * 2); g.fill(); break;
    case 'snowflake': case 'shard':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); g.stroke();
      }
      break;
    case 'spiral':
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        const a = t * Math.PI * 4;
        const rr = r * t;
        i === 0 ? g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.stroke(); break;
    case 'leaf': case 'clover':
      for (let i = 0; i < (glyph === 'clover' ? 4 : 1); i++) {
        g.save(); g.rotate((i / 4) * Math.PI * 2);
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(r * 0.8, -r * 0.5, 0, -r);
        g.quadraticCurveTo(-r * 0.8, -r * 0.5, 0, 0); g.fill(); g.stroke(); g.restore();
      }
      break;
    // Three items used to share one upright quill. Uncommon is a single hue,
    // so the shapes have to carry Bailout Thrusters / Waxed Wing / Hollow Plume on
    // their own: a swept wing, one quill, a three-quill plume.
    case 'wing':
      g.beginPath();
      g.moveTo(-r, -r * 0.42); g.quadraticCurveTo(r * 0.55, -r * 0.9, r, -r * 0.05);
      g.lineTo(-r * 0.86, r * 0.16); g.closePath(); g.fill(); g.stroke();
      for (let i = 0; i < 3; i++) {
        const x = -r * 0.46 + i * r * 0.46;
        g.beginPath(); g.moveTo(x, r * 0.06); g.lineTo(x - r * 0.2, r * 0.9);
        g.lineTo(x + r * 0.2, r * 0.72); g.closePath(); g.fill(); g.stroke();
      }
      break;
    case 'feather':
      g.beginPath(); g.moveTo(0, r); g.quadraticCurveTo(r * 0.9, 0, 0, -r);
      g.quadraticCurveTo(-r * 0.3, 0, 0, r); g.fill(); g.stroke();
      // Barbs cut in the plate colour. The white rachis alone left the vane a
      // solid lobe, which measured 7.8% from `blade` in the same tier.
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.14);
      g.beginPath(); g.moveTo(0, r); g.lineTo(0, -r); g.stroke();
      for (let i = 0; i < 4; i++) {
        const y = -r * 0.62 + i * r * 0.4;
        g.beginPath(); g.moveTo(0, y); g.lineTo(r * 0.62, y + r * 0.3); g.stroke();
      }
      g.restore(); break;
    case 'plume':
      for (let i = -1; i <= 1; i++) {
        g.save(); g.translate(0, r * 0.78); g.rotate(i * 0.62);
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(r * 0.4, -r * 0.85, 0, -r * 1.5);
        g.quadraticCurveTo(-r * 0.4, -r * 0.85, 0, 0); g.fill(); g.stroke(); g.restore();
      }
      break;
    // Round 4's N11: `shield` and `hex` were two bare grey polygons in the same
    // tier. The specified fix was a band or rivet row across the shield; this is
    // it — a dark strap and three bright rivets, so the plate reads as bolted
    // armour and not as a sixth polygon.
    case 'shield':
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.8, -r * 0.5); g.lineTo(r * 0.6, r * 0.6);
      g.lineTo(0, r); g.lineTo(-r * 0.6, r * 0.6); g.lineTo(-r * 0.8, -r * 0.5);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      g.fillRect(-r * 0.75, -r * 0.12, r * 1.5, r * 0.3);
      g.restore();
      for (const x of [-r * 0.44, 0, r * 0.44]) {
        g.beginPath(); g.arc(x, -r * 0.44, r * 0.13, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    // Red-Mist Pauldron — the same silhouette with the spikes it is named
    // for, so it is not a third rectangle beside `cell` and `overcharge`.
    case 'pauldron':
      g.beginPath(); g.moveTo(0, -r * 0.9); g.lineTo(r * 0.8, -r * 0.45); g.lineTo(r * 0.6, r * 0.55);
      g.lineTo(0, r * 0.95); g.lineTo(-r * 0.6, r * 0.55); g.lineTo(-r * 0.8, -r * 0.45);
      g.closePath(); g.fill(); g.stroke();
      for (const [x, y, dx, dy] of [[-r * 0.7, -r * 0.6, -r * 0.5, -r * 0.5],
                                    [0, -r * 0.9, 0, -r * 0.72],
                                    [r * 0.7, -r * 0.6, r * 0.5, -r * 0.5]]) {
        g.beginPath();
        g.moveTo(x - r * 0.16, y + r * 0.14); g.lineTo(x + dx, y + dy);
        g.lineTo(x + r * 0.16, y + r * 0.14);
        g.closePath(); g.fill(); g.stroke();
      }
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.18);
      g.beginPath(); g.arc(0, r * 0.05, r * 0.34, 0, Math.PI * 2); g.stroke(); g.restore();
      break;
    case 'cell':
      g.fillRect(-r * 0.55, -r * 0.8, r * 1.1, r * 1.6);
      g.strokeRect(-r * 0.55, -r * 0.8, r * 1.1, r * 1.6);
      g.fillRect(-r * 0.2, -r, r * 0.4, r * 0.25);
      // Charge bands. Three uncommon items are upright boxes; the ones that
      // stayed plain measured 6.8–8.8% from each other.
      g.save(); g.fillStyle = '#0d0f14';
      for (let i = 0; i < 3; i++) g.fillRect(-r * 0.55, -r * 0.5 + i * r * 0.44, r * 1.1, r * 0.16);
      g.restore(); break;
    case 'alien':
      g.beginPath(); g.ellipse(0, 0, r * 0.75, r, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#0d0f14';
      g.beginPath(); g.ellipse(-r * 0.3, -r * 0.1, r * 0.22, r * 0.34, 0.4, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(r * 0.3, -r * 0.1, r * 0.22, r * 0.34, -0.4, 0, Math.PI * 2); g.fill(); break;
    case 'stalk': case 'hive':
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(i * r * 0.5, r); g.quadraticCurveTo(i * r * 0.9, 0, i * r * 0.3, -r); g.stroke();
        g.beginPath(); g.arc(i * r * 0.3, -r, r * 0.22, 0, Math.PI * 2); g.fill();
      }
      break;
    // ------------------------------------------------ round 5 content glyphs
    //
    // The constraint every one of these is drawn against: inside a tier the
    // plate colour is identical, so *shape alone* has to name the item at the
    // 33px the inventory strip actually renders. That rules out detail — a
    // glyph is one silhouette plus at most one interior cut, and any two glyphs
    // in the same tier have to differ in outline, not in ornament. Where a new
    // item is thematically close to an old one (Warm Coals next to Leaking Jerrycan,
    // Frost Lattice next to Hoarfrost Band) the new glyph deliberately takes a
    // different primitive family rather than a variation on the same one.

    // --- common ---
    // A struck flake: one long fracture edge, one blunt back.
    case 'flint':
      g.beginPath();
      g.moveTo(-r * 0.9, r * 0.35); g.lineTo(-r * 0.25, -r * 0.95);
      g.lineTo(r * 0.55, -r * 0.5); g.lineTo(r * 0.9, r * 0.55); g.lineTo(-r * 0.2, r * 0.9);
      g.closePath(); g.fill(); g.stroke();
      // Conchoidal flake scars, in the plate colour — a white line here has the
      // outline's luminosity and left the shard a solid blob against `triangle`,
      // `diamond` and `shield`.
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.16);
      g.beginPath(); g.moveTo(-r * 0.25, -r * 0.9); g.lineTo(-r * 0.05, r * 0.5);
      g.moveTo(-r * 0.55, -r * 0.2); g.lineTo(r * 0.5, -r * 0.1);
      g.moveTo(r * 0.2, r * 0.72); g.lineTo(r * 0.45, r * 0.05);
      g.stroke(); g.restore(); break;
    // Basket weave: two interlocking bands. Reads as cloth, not as a grid.
    case 'weave':
      for (let i = -1; i <= 1; i++) {
        g.fillRect(i * r * 0.62 - r * 0.2, -r, r * 0.4, r * 2);
        g.strokeRect(i * r * 0.62 - r * 0.2, -r, r * 0.4, r * 2);
      }
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.16);
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(-r, i * r * 0.62); g.lineTo(r, i * r * 0.62); g.stroke();
      }
      g.restore(); break;
    // Rebreather: mask bowl plus a hose curling off it.
    case 'lung':
      g.beginPath(); g.ellipse(-r * 0.15, -r * 0.15, r * 0.72, r * 0.6, 0, 0, Math.PI * 2);
      g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(r * 0.4, r * 0.2);
      g.quadraticCurveTo(r * 1.0, r * 0.45, r * 0.5, r * 0.95);
      g.stroke();
      g.beginPath(); g.arc(r * 0.5, r * 0.95, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke(); break;
    // Chalk block with a scuffed trail — two marks, not a shape.
    case 'chalk':
      g.beginPath();
      g.moveTo(-r * 0.55, -r * 0.85); g.lineTo(r * 0.2, -r * 0.85);
      g.lineTo(r * 0.2, r * 0.1); g.lineTo(-r * 0.55, r * 0.1);
      g.closePath(); g.fill(); g.stroke();
      for (let i = 0; i < 3; i++) {
        g.beginPath(); g.moveTo(-r * 0.5 + i * r * 0.3, r * 0.4);
        g.lineTo(-r * 0.2 + i * r * 0.3, r * 0.95); g.stroke();
      }
      break;
    // Rowel spur: a star wheel on a curved heel band.
    case 'spur':
      g.beginPath(); g.arc(-r * 0.2, 0, r * 0.75, Math.PI * 0.4, Math.PI * 1.6); g.stroke();
      g.save(); g.translate(r * 0.45, 0);
      poly(g, 6, r * 0.5, 0, 0.42); g.fill(); g.stroke(); g.restore(); break;
    // Banked coals: three lumps under a heat shimmer, never a flame lobe.
    case 'coal':
      for (const [x, y, rr] of [[-r * 0.5, r * 0.4, r * 0.42], [r * 0.45, r * 0.45, r * 0.36], [0, r * 0.15, r * 0.5]]) {
        g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(i * r * 0.5, -r * 0.35);
        g.quadraticCurveTo(i * r * 0.5 + r * 0.28, -r * 0.7, i * r * 0.5, -r * 1.0); g.stroke();
      }
      break;
    // A coil of wire seen from the side: a flat helix, not a spiral disc.
    case 'wire':
      g.beginPath();
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        const x = -r + t * r * 2;
        const y = Math.sin(t * Math.PI * 5) * r * 0.65;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke(); break;
    // Marble: a sphere with the internal twist and a crack across it.
    case 'marble':
      g.beginPath(); g.arc(0, 0, r * 0.88, 0, Math.PI * 2); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.16);
      g.beginPath(); g.moveTo(-r * 0.7, -r * 0.35);
      g.quadraticCurveTo(0, r * 0.3, r * 0.7, -r * 0.35); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.2, -r * 0.85); g.lineTo(r * 0.15, r * 0.85); g.stroke();
      g.restore(); break;
    // Ammo pouch: a flap-topped satchel with two rounds standing proud.
    case 'pouch':
      g.beginPath();
      g.moveTo(-r * 0.8, -r * 0.15); g.lineTo(r * 0.8, -r * 0.15);
      g.lineTo(r * 0.62, r * 0.92); g.lineTo(-r * 0.62, r * 0.92);
      g.closePath(); g.fill(); g.stroke();
      g.fillRect(-r * 0.88, -r * 0.42, r * 1.76, r * 0.3);
      g.strokeRect(-r * 0.88, -r * 0.42, r * 1.76, r * 0.3);
      for (const x of [-r * 0.4, r * 0.4]) {
        g.beginPath(); g.moveTo(x - r * 0.16, -r * 0.42); g.lineTo(x - r * 0.16, -r * 0.9);
        g.lineTo(x, -r * 1.1); g.lineTo(x + r * 0.16, -r * 0.9); g.lineTo(x + r * 0.16, -r * 0.42);
        g.closePath(); g.fill(); g.stroke();
      }
      break;
    // Rolled bandage: a spiral end on a wrapped band.
    case 'dressing':
      g.beginPath();
      g.moveTo(-r * 0.95, -r * 0.5); g.lineTo(r * 0.3, -r * 0.5);
      g.lineTo(r * 0.3, r * 0.5); g.lineTo(-r * 0.95, r * 0.5);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.arc(r * 0.3, 0, r * 0.5, -Math.PI / 2, Math.PI / 2); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      g.beginPath(); g.arc(r * 0.3, 0, r * 0.24, 0, Math.PI * 2); g.stroke(); g.restore(); break;
    // Salt block: a cube in isometric, so it cannot be read as `hex`.
    case 'saltcube':
      g.beginPath();
      g.moveTo(0, -r); g.lineTo(r * 0.92, -r * 0.48); g.lineTo(r * 0.92, r * 0.5);
      g.lineTo(0, r); g.lineTo(-r * 0.92, r * 0.5); g.lineTo(-r * 0.92, -r * 0.48);
      g.closePath(); g.fill(); g.stroke();
      // Cube edges in the plate colour and one shaded face. In white they had
      // the luminosity of the outline, so the cube's mask was a filled hexagon
      // and it measured 6.3% from `hex`.
      g.save();
      g.fillStyle = '#0d0f14';
      g.beginPath();
      g.moveTo(0, r * 0.03); g.lineTo(r * 0.92, -r * 0.48);
      g.lineTo(r * 0.92, r * 0.5); g.lineTo(0, r);
      g.closePath(); g.fill();
      g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.16);
      g.beginPath();
      g.moveTo(-r * 0.92, -r * 0.48); g.lineTo(0, r * 0.03); g.lineTo(r * 0.92, -r * 0.48);
      g.moveTo(0, r * 0.03); g.lineTo(0, r);
      g.stroke(); g.restore(); break;
    // Boot sole: an outline with a tread pattern punched through it.
    case 'sole':
      g.beginPath();
      g.moveTo(-r * 0.42, -r); g.quadraticCurveTo(r * 0.62, -r * 0.75, r * 0.4, r * 0.05);
      g.quadraticCurveTo(r * 0.62, r * 0.85, -r * 0.1, r);
      g.quadraticCurveTo(-r * 0.72, r * 0.8, -r * 0.42, -r);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      for (let i = 0; i < 4; i++) {
        g.beginPath(); g.moveTo(-r * 0.42, -r * 0.6 + i * r * 0.44);
        g.lineTo(r * 0.42, -r * 0.72 + i * r * 0.44); g.stroke();
      }
      g.restore(); break;
    // Bandolier: a diagonal strap carrying loops.
    case 'bandolier':
      g.save(); g.rotate(-0.72);
      g.fillRect(-r * 0.26, -r * 1.15, r * 0.52, r * 2.3);
      g.strokeRect(-r * 0.26, -r * 1.15, r * 0.52, r * 2.3);
      g.save(); g.fillStyle = '#0d0f14';
      for (let i = -2; i <= 2; i++) g.fillRect(-r * 0.2, i * r * 0.44 - r * 0.11, r * 0.4, r * 0.22);
      g.restore(); g.restore(); break;
    // Spark plug: hex body, threaded nose, one electrode hook.
    case 'plug':
      g.fillRect(-r * 0.3, -r, r * 0.6, r * 0.7);
      g.strokeRect(-r * 0.3, -r, r * 0.6, r * 0.7);
      poly(g, 6, r * 0.55, Math.PI / 6); g.fill(); g.stroke();
      g.fillRect(-r * 0.22, r * 0.45, r * 0.44, r * 0.5);
      g.strokeRect(-r * 0.22, r * 0.45, r * 0.44, r * 0.5);
      g.beginPath(); g.moveTo(r * 0.4, r * 0.5); g.lineTo(r * 0.4, r * 0.95); g.lineTo(0, r * 0.95);
      g.stroke(); break;

    // --- uncommon ---
    // Barbed wire: a strand with two X barbs.
    case 'razor':
      g.beginPath(); g.moveTo(-r, -r * 0.3); g.lineTo(r, r * 0.3); g.stroke();
      g.beginPath(); g.moveTo(-r, r * 0.3); g.lineTo(r, -r * 0.3); g.stroke();
      for (const x of [-r * 0.45, r * 0.45]) {
        g.beginPath();
        g.moveTo(x - r * 0.3, -r * 0.65); g.lineTo(x + r * 0.3, r * 0.65);
        g.moveTo(x + r * 0.3, -r * 0.65); g.lineTo(x - r * 0.3, r * 0.65);
        g.stroke();
      }
      break;
    // Three sweeping wind arcs, open on the right.
    case 'squall':
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.arc(r * 0.15, i * r * 0.58, r * 0.72 - Math.abs(i) * r * 0.16,
          Math.PI * 0.15, Math.PI * 1.55);
        g.stroke();
      }
      break;
    // Ration tin: a can with a peel ring.
    case 'ration':
      g.beginPath(); g.ellipse(0, -r * 0.55, r * 0.85, r * 0.28, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillRect(-r * 0.85, -r * 0.55, r * 1.7, r * 1.2);
      g.strokeRect(-r * 0.85, -r * 0.55, r * 1.7, r * 1.2);
      g.beginPath(); g.ellipse(0, r * 0.65, r * 0.85, r * 0.28, 0, 0, Math.PI); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      g.beginPath(); g.ellipse(0, -r * 0.55, r * 0.3, r * 0.12, 0, 0, Math.PI * 2); g.stroke();
      g.restore(); break;
    // Thornplate: a plate with spikes standing off its top edge.
    case 'thorns':
      g.fillRect(-r * 0.9, r * 0.05, r * 1.8, r * 0.8);
      g.strokeRect(-r * 0.9, r * 0.05, r * 1.8, r * 0.8);
      for (let i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(i * r * 0.4 - r * 0.16, r * 0.05);
        g.lineTo(i * r * 0.4, -r * 0.95 + Math.abs(i) * r * 0.2);
        g.lineTo(i * r * 0.4 + r * 0.16, r * 0.05);
        g.closePath(); g.fill(); g.stroke();
      }
      // Bolt line through the base plate, in the plate colour — without it the
      // plate is a solid bar and the glyph sat at the same-tier floor.
      g.save(); g.fillStyle = '#0d0f14';
      g.fillRect(-r * 0.9, r * 0.34, r * 1.8, r * 0.2);
      g.restore();
      break;
    // Updraft vent: a louvred grille with an arrow rising out of it.
    case 'updraft':
      for (let i = 0; i < 3; i++) {
        g.fillRect(-r * 0.85, r * 0.25 + i * r * 0.3, r * 1.7, r * 0.16);
        g.strokeRect(-r * 0.85, r * 0.25 + i * r * 0.3, r * 1.7, r * 0.16);
      }
      g.beginPath();
      g.moveTo(0, -r); g.lineTo(r * 0.5, -r * 0.3); g.lineTo(r * 0.18, -r * 0.3);
      g.lineTo(r * 0.18, r * 0.1); g.lineTo(-r * 0.18, r * 0.1); g.lineTo(-r * 0.18, -r * 0.3);
      g.lineTo(-r * 0.5, -r * 0.3);
      g.closePath(); g.fill(); g.stroke(); break;
    // Hunter's tag: a punched label on a wire, with a reticle notch.
    case 'tag':
      g.beginPath();
      g.moveTo(-r * 0.85, -r * 0.3); g.lineTo(r * 0.3, -r * 0.85);
      g.lineTo(r * 0.9, r * 0.35); g.lineTo(-r * 0.25, r * 0.9);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.16);
      g.beginPath(); g.arc(-r * 0.4, -r * 0.24, r * 0.2, 0, Math.PI * 2); g.stroke();
      g.restore();
      g.beginPath(); g.moveTo(-r * 0.4, -r * 0.24); g.lineTo(-r * 1.1, -r * 0.85); g.stroke(); break;
    // Overcharge cell: a battery whose terminals are throwing an arc across.
    case 'overcharge':
      g.fillRect(-r * 0.62, -r * 0.55, r * 1.24, r * 1.45);
      g.strokeRect(-r * 0.62, -r * 0.55, r * 1.24, r * 1.45);
      for (const x of [-r * 0.34, r * 0.34]) {
        g.fillRect(x - r * 0.12, -r * 0.8, r * 0.24, r * 0.28);
        g.strokeRect(x - r * 0.12, -r * 0.8, r * 0.24, r * 0.28);
      }
      g.beginPath();
      g.moveTo(-r * 0.34, -r * 0.82); g.lineTo(-r * 0.05, -r * 1.02);
      g.lineTo(r * 0.08, -r * 0.86); g.lineTo(r * 0.34, -r * 1.06);
      g.stroke();
      // The overcharge itself, cut through the cell in the plate colour.
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath();
      g.moveTo(r * 0.22, -r * 0.42); g.lineTo(-r * 0.3, r * 0.16); g.lineTo(r * 0.02, r * 0.16);
      g.lineTo(-r * 0.16, r * 0.78); g.lineTo(r * 0.36, r * 0.1); g.lineTo(r * 0.04, r * 0.1);
      g.closePath(); g.fill(); g.restore(); break;
    // Frost lattice: a rectilinear crystal grid — never the radial `snowflake`.
    case 'lattice':
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(i * r * 0.55, -r); g.lineTo(i * r * 0.55, r); g.stroke();
        g.beginPath(); g.moveTo(-r, i * r * 0.55); g.lineTo(r, i * r * 0.55); g.stroke();
      }
      // Nodes on three of the four crossings, not all four: an asymmetric set
      // reads as a growing crystal, a symmetric one reads as a window frame.
      for (const [x, y] of [[-r * 0.55, -r * 0.55], [r * 0.55, r * 0.55], [r * 0.55, -r * 0.55]]) {
        g.save(); g.translate(x, y); poly(g, 4, r * 0.22, Math.PI / 4); g.fill(); g.stroke(); g.restore();
      }
      break;
    // Horseshoe magnet, poles down. The one glyph in the tier with a gap in it.
    case 'magnet':
      g.lineWidth = Math.max(2, r * 0.42);
      g.beginPath(); g.arc(0, r * 0.1, r * 0.62, Math.PI, 0); g.stroke();
      g.lineWidth = Math.max(1.5, r * 0.16);
      for (const x of [-r * 0.62, r * 0.62]) {
        g.beginPath(); g.moveTo(x, r * 0.1); g.lineTo(x, r * 0.85); g.stroke();
        g.beginPath(); g.arc(x, r * 0.9, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    // Battle hymn: a horn with three sound bars leaving the bell.
    case 'hymn':
      g.beginPath();
      g.moveTo(-r * 0.9, -r * 0.15); g.lineTo(-r * 0.2, -r * 0.15);
      g.lineTo(r * 0.35, -r * 0.85); g.lineTo(r * 0.35, r * 0.55);
      g.lineTo(-r * 0.2, -r * 0.15 + r * 0.5); g.lineTo(-r * 0.9, r * 0.35);
      g.closePath(); g.fill(); g.stroke();
      for (let i = 1; i <= 3; i++) {
        g.beginPath(); g.arc(r * 0.35, -r * 0.15, r * 0.24 * i + r * 0.3,
          -Math.PI * 0.42, Math.PI * 0.42); g.stroke();
      }
      break;
    // Fly swarm: three winged bodies at different scales.
    case 'flies':
      for (const [x, y, s] of [[-r * 0.45, -r * 0.35, 1], [r * 0.5, r * 0.1, 0.75], [-r * 0.1, r * 0.62, 0.6]]) {
        g.save(); g.translate(x, y); g.scale(s, s);
        g.beginPath(); g.ellipse(0, 0, r * 0.2, r * 0.32, 0.3, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.ellipse(-r * 0.34, -r * 0.2, r * 0.3, r * 0.13, -0.5, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(r * 0.34, -r * 0.2, r * 0.3, r * 0.13, 0.5, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      break;
    // Rebar: a ribbed rod on the diagonal with a chisel point.
    case 'rebar':
      g.save(); g.rotate(-0.72);
      g.beginPath();
      g.moveTo(-r * 0.2, r * 1.05); g.lineTo(r * 0.2, r * 1.05);
      g.lineTo(r * 0.2, -r * 0.75); g.lineTo(0, -r * 1.15); g.lineTo(-r * 0.2, -r * 0.75);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      for (let i = -2; i <= 2; i++) {
        g.beginPath(); g.moveTo(-r * 0.2, i * r * 0.38); g.lineTo(r * 0.2, i * r * 0.38 - r * 0.16); g.stroke();
      }
      g.restore(); g.restore(); break;

    // --- legendary ---
    // Star chart: plotted nodes joined into a constellation.
    case 'chart':
      {
        const pts = [[-r * 0.75, -r * 0.5], [-r * 0.1, -r * 0.85], [r * 0.55, -r * 0.3],
          [r * 0.3, r * 0.55], [-r * 0.5, r * 0.7]];
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
        g.stroke();
        for (const [x, y] of pts) { g.beginPath(); g.arc(x, y, r * 0.16, 0, Math.PI * 2); g.fill(); g.stroke(); }
      }
      break;
    // Resonance coil: concentric rings with a struck core — a pulse, not a nova.
    case 'resonance':
      for (let i = 1; i <= 3; i++) {
        g.beginPath(); g.arc(0, 0, r * (0.34 + i * 0.24), Math.PI * 0.1, Math.PI * 1.5); g.stroke();
      }
      g.beginPath(); g.arc(0, 0, r * 0.3, 0, Math.PI * 2); g.fill(); g.stroke(); break;
    // Chronal governor: an escapement — a gear sector with one hand.
    case 'chronal':
      poly(g, 12, r * 0.9, 0, 0.78); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.arc(0, 0, r * 0.5, 0, Math.PI * 2); g.fill(); g.restore();
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -r * 0.45);
      g.moveTo(0, 0); g.lineTo(r * 0.34, r * 0.14); g.stroke(); break;
    // Siege battery: a charge stack — bars filling from the bottom.
    case 'battery':
      g.strokeRect(-r * 0.6, -r * 0.85, r * 1.2, r * 1.7);
      g.fillRect(-r * 0.22, -r * 1.08, r * 0.44, r * 0.24);
      for (let i = 0; i < 3; i++) {
        g.fillRect(-r * 0.44, r * 0.55 - i * r * 0.44, r * 0.88, r * 0.28);
      }
      break;
    // Vulture's mantle: a hooded collar with two folded wing lines.
    case 'mantle':
      g.beginPath();
      g.moveTo(0, -r); g.quadraticCurveTo(r * 1.05, -r * 0.5, r * 0.85, r * 0.85);
      g.lineTo(r * 0.25, r * 0.3); g.lineTo(-r * 0.25, r * 0.3); g.lineTo(-r * 0.85, r * 0.85);
      g.quadraticCurveTo(-r * 1.05, -r * 0.5, 0, -r);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      g.beginPath(); g.moveTo(-r * 0.45, -r * 0.35); g.lineTo(-r * 0.6, r * 0.55);
      g.moveTo(r * 0.45, -r * 0.35); g.lineTo(r * 0.6, r * 0.55); g.stroke();
      g.restore(); break;
    // Prism splinter: an incoming line refracting into three.
    case 'prism':
      poly(g, 3, r * 0.75, -Math.PI / 2); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-r * 1.05, r * 0.1); g.lineTo(-r * 0.3, r * 0.1); g.stroke();
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(r * 0.3, r * 0.1); g.lineTo(r * 1.1, r * 0.1 + i * r * 0.5); g.stroke();
      }
      break;
    // Collapsing well: an event horizon with infalling streaks.
    case 'wellhole':
      g.beginPath(); g.arc(0, 0, r * 0.42, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(0, 0, r * 0.62, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        g.beginPath();
        g.moveTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
        g.quadraticCurveTo(Math.cos(a + 0.5) * r * 0.9, Math.sin(a + 0.5) * r * 0.9,
          Math.cos(a + 0.9) * r * 0.68, Math.sin(a + 0.9) * r * 0.68);
        g.stroke();
      }
      break;
    // Warlock ember: a floating mote trailing two sparks that leave it.
    case 'ember':
      g.beginPath(); poly(g, 4, r * 0.5, Math.PI / 4, 0.4); g.fill(); g.stroke();
      for (const [dx, dy] of [[r * 0.85, -r * 0.6], [-r * 0.8, -r * 0.35], [r * 0.4, r * 0.9]]) {
        g.beginPath(); g.moveTo(dx * 0.35, dy * 0.35); g.lineTo(dx, dy); g.stroke();
        g.beginPath(); g.arc(dx, dy, r * 0.17, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    // Kinetic recycler: two arrows chasing each other round a square.
    case 'recycler':
      for (let k = 0; k < 2; k++) {
        g.save(); g.rotate(k * Math.PI);
        g.beginPath(); g.arc(0, 0, r * 0.7, Math.PI * 0.1, Math.PI * 0.85); g.stroke();
        g.save();
        g.translate(Math.cos(Math.PI * 0.85) * r * 0.7, Math.sin(Math.PI * 0.85) * r * 0.7);
        g.rotate(Math.PI * 0.35);
        poly(g, 3, r * 0.3, -Math.PI / 2); g.fill(); g.stroke();
        g.restore(); g.restore();
      }
      break;

    // --- boss ---
    // Vertebra: a centrum with two transverse processes and a neural spine.
    case 'vertebra':
      g.beginPath(); g.ellipse(0, r * 0.3, r * 0.55, r * 0.42, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      for (const sx of [-1, 1]) {
        g.beginPath();
        g.moveTo(sx * r * 0.4, r * 0.15); g.lineTo(sx * r * 1.05, -r * 0.15);
        g.lineTo(sx * r * 0.95, r * 0.3); g.lineTo(sx * r * 0.35, r * 0.5);
        g.closePath(); g.fill(); g.stroke();
      }
      g.beginPath();
      g.moveTo(-r * 0.24, -r * 0.05); g.lineTo(0, -r * 1.05); g.lineTo(r * 0.24, -r * 0.05);
      g.closePath(); g.fill(); g.stroke(); break;
    // Molten core: a cracked shell with the heat showing through the fissures.
    case 'moltencore':
      g.beginPath(); g.arc(0, 0, r * 0.95, 0, Math.PI * 2); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.2);
      g.beginPath();
      g.moveTo(-r * 0.95, -r * 0.2); g.lineTo(-r * 0.2, -r * 0.05); g.lineTo(-r * 0.35, r * 0.9);
      g.moveTo(-r * 0.2, -r * 0.05); g.lineTo(r * 0.5, -r * 0.75);
      g.moveTo(-r * 0.2, -r * 0.05); g.lineTo(r * 0.85, r * 0.5);
      g.stroke(); g.restore(); break;
    // Carapace plate: an overlapping chitin scale with a ridged keel.
    case 'carapace':
      g.beginPath();
      g.moveTo(0, -r); g.quadraticCurveTo(r * 1.0, -r * 0.5, r * 0.78, r * 0.9);
      g.quadraticCurveTo(0, r * 0.55, -r * 0.78, r * 0.9);
      g.quadraticCurveTo(-r * 1.0, -r * 0.5, 0, -r);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.15);
      for (let i = 1; i <= 3; i++) {
        g.beginPath();
        g.moveTo(-r * (0.9 - i * 0.12), -r * 0.5 + i * r * 0.36);
        g.quadraticCurveTo(0, -r * 0.85 + i * r * 0.36, r * (0.9 - i * 0.12), -r * 0.5 + i * r * 0.36);
        g.stroke();
      }
      g.restore(); break;
    // Spore sac: a bulging pod venting three puffs.
    case 'sporesac':
      g.beginPath();
      g.moveTo(0, r); g.quadraticCurveTo(r * 0.95, r * 0.35, r * 0.5, -r * 0.4);
      g.quadraticCurveTo(0, -r * 0.75, -r * 0.5, -r * 0.4);
      g.quadraticCurveTo(-r * 0.95, r * 0.35, 0, r);
      g.closePath(); g.fill(); g.stroke();
      for (const [x, y, rr] of [[0, -r * 0.95, r * 0.2], [-r * 0.62, -r * 0.72, r * 0.14], [r * 0.6, -r * 0.68, r * 0.16]]) {
        g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;

    // --- lunar ---
    // Lunar glyphs are all *broken* or *paired* forms on purpose: the tier's
    // whole read is "this costs you something", and a split silhouette says that
    // before the tooltip does.
    case 'covenant':
      g.beginPath();
      g.moveTo(-r * 0.1, -r); g.lineTo(-r * 0.85, -r * 0.1); g.lineTo(-r * 0.3, r * 0.15);
      g.lineTo(-r * 0.7, r); g.lineTo(0, r * 0.25);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(r * 0.2, -r * 0.95); g.lineTo(r * 0.9, -r * 0.05); g.lineTo(r * 0.35, r * 0.2);
      g.lineTo(r * 0.8, r * 0.98); g.lineTo(r * 0.12, r * 0.28);
      g.closePath(); g.fill(); g.stroke(); break;
    // Hollow Vow: an open ring with a sealed lower lip — a shield with no face.
    case 'vow':
      g.beginPath(); g.arc(0, 0, r * 0.82, Math.PI * 0.18, Math.PI * 0.82, true); g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.78, r * 0.25); g.lineTo(r * 0.78, r * 0.25);
      g.lineTo(0, r * 1.05);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.5, -r * 0.75); g.lineTo(r * 0.5, -r * 0.2); g.stroke(); break;
    // Mercury Anklet: a cuff with a bead of liquid metal running out of it.
    case 'anklet':
      g.lineWidth = Math.max(2, r * 0.3);
      g.beginPath(); g.arc(0, -r * 0.2, r * 0.68, Math.PI * 0.2, Math.PI * 0.8, true); g.stroke();
      g.lineWidth = Math.max(1.5, r * 0.16);
      g.beginPath(); g.arc(-r * 0.2, r * 0.62, r * 0.3, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.arc(r * 0.55, r * 0.85, r * 0.16, 0, Math.PI * 2); g.fill(); g.stroke(); break;
    // Tithe of Ash: a coin dissolving into ash from one edge.
    case 'tithe':
      g.beginPath(); g.arc(0, 0, r * 0.8, Math.PI * 0.6, Math.PI * 2.4); g.fill(); g.stroke();
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * 0.62 + i * 0.34;
        const d = r * (1.0 + i * 0.06);
        g.save(); g.translate(Math.cos(a) * d, Math.sin(a) * d); g.rotate(a);
        poly(g, 4, r * (0.2 - i * 0.025), 0); g.fill(); g.restore();
      }
      break;
    // Charnel Bloom: a flower opening out of a rib.
    case 'bloom':
      for (let i = 0; i < 5; i++) {
        g.save(); g.rotate((i / 5) * Math.PI * 2);
        g.beginPath(); g.moveTo(0, -r * 0.2);
        g.quadraticCurveTo(r * 0.42, -r * 0.75, 0, -r * 1.0);
        g.quadraticCurveTo(-r * 0.42, -r * 0.75, 0, -r * 0.2);
        g.fill(); g.stroke(); g.restore();
      }
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.arc(0, 0, r * 0.26, 0, Math.PI * 2); g.fill(); g.restore(); break;
    // Brittle Edge: a blade snapped mid-length, the tip drifting free.
    case 'brittle':
      g.beginPath();
      g.moveTo(-r * 0.35, r); g.lineTo(-r * 0.05, r * 0.95);
      g.lineTo(r * 0.2, -r * 0.05); g.lineTo(-r * 0.3, r * 0.1);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.translate(r * 0.32, -r * 0.32); g.rotate(0.42);
      g.beginPath();
      g.moveTo(-r * 0.28, r * 0.3); g.lineTo(r * 0.05, r * 0.2);
      g.lineTo(r * 0.3, -r * 0.7); g.lineTo(-r * 0.18, -r * 0.45);
      g.closePath(); g.fill(); g.stroke(); g.restore(); break;
    // Gale Reliquary: a sealed casket with wind streaming past it.
    case 'reliquary':
      g.beginPath();
      g.moveTo(-r * 0.45, -r * 0.65); g.lineTo(r * 0.45, -r * 0.65);
      g.lineTo(r * 0.6, r * 0.85); g.lineTo(-r * 0.6, r * 0.85);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-r * 0.45, -r * 0.65); g.lineTo(0, -r * 1.05);
      g.lineTo(r * 0.45, -r * 0.65); g.stroke();
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(-r * 1.15, i * r * 0.42 + r * 0.05);
        g.lineTo(-r * 0.7, i * r * 0.42 + r * 0.05); g.stroke();
      }
      break;

    // --- equipment ---
    // Equipment glyphs are the only ones that never share a family with an item
    // glyph: the Q slot is a different kind of object and has to read as one
    // even before its orange plate is noticed.
    case 'blink':
      g.beginPath();
      g.moveTo(-r * 0.95, -r * 0.15); g.lineTo(-r * 0.2, -r * 0.15); g.lineTo(-r * 0.45, -r * 0.8);
      g.lineTo(r * 0.4, r * 0.1); g.lineTo(-r * 0.15, r * 0.1); g.lineTo(r * 0.2, r * 0.9);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.arc(r * 0.72, -r * 0.62, r * 0.2, 0, Math.PI * 2); g.fill(); break;
    case 'flare':
      g.beginPath(); g.arc(0, 0, r * 0.42, 0, Math.PI * 2); g.fill(); g.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.beginPath();
        g.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6);
        g.lineTo(Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1); g.stroke();
      }
      g.save(); g.fillStyle = '#0d0f14';
      g.fillRect(-r * 0.06, -r * 0.26, r * 0.12, r * 0.52);
      g.fillRect(-r * 0.26, -r * 0.06, r * 0.52, r * 0.12); g.restore(); break;
    case 'lance':
      g.beginPath();
      g.moveTo(0, -r * 1.05); g.lineTo(r * 0.3, -r * 0.2); g.lineTo(r * 0.16, r * 0.85);
      g.lineTo(-r * 0.16, r * 0.85); g.lineTo(-r * 0.3, -r * 0.2);
      g.closePath(); g.fill(); g.stroke();
      for (const sx of [-1, 1]) {
        g.beginPath(); g.moveTo(sx * r * 0.42, -r * 0.35); g.lineTo(sx * r * 0.95, r * 0.55); g.stroke();
      }
      break;
    case 'snare':
      g.beginPath(); g.arc(0, 0, r * 0.3, 0, Math.PI * 2); g.fill(); g.stroke();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        g.save(); g.rotate(a); g.translate(0, -r * 0.95);
        poly(g, 3, r * 0.3, Math.PI / 2); g.fill(); g.stroke(); g.restore();
      }
      g.beginPath(); g.arc(0, 0, r * 0.66, 0, Math.PI * 2); g.stroke(); break;
    case 'drone':
      g.beginPath();
      g.moveTo(0, -r * 0.55); g.lineTo(r * 0.55, 0); g.lineTo(0, r * 0.55); g.lineTo(-r * 0.55, 0);
      g.closePath(); g.fill(); g.stroke();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        g.beginPath(); g.moveTo(sx * r * 0.3, sy * r * 0.3); g.lineTo(sx * r * 0.85, sy * r * 0.85); g.stroke();
        g.beginPath(); g.ellipse(sx * r * 0.95, sy * r * 0.95, r * 0.26, r * 0.1, 0, 0, Math.PI * 2); g.fill();
      }
      break;
    case 'overload':
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const rr = i % 2 ? r * 1.15 : r * 0.8;
        g.beginPath(); g.moveTo(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42);
        g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); g.stroke();
      }
      poly(g, 6, r * 0.42, Math.PI / 6); g.fill(); g.stroke(); break;
    case 'canister':
      g.beginPath(); g.ellipse(0, -r * 0.62, r * 0.5, r * 0.2, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillRect(-r * 0.5, -r * 0.62, r * 1.0, r * 1.3);
      g.strokeRect(-r * 0.5, -r * 0.62, r * 1.0, r * 1.3);
      g.beginPath(); g.ellipse(0, r * 0.68, r * 0.5, r * 0.2, 0, 0, Math.PI); g.stroke();
      g.fillRect(-r * 0.16, -r * 0.95, r * 0.32, r * 0.34);
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(i * r * 0.3, -r * 0.2); g.lineTo(i * r * 0.3, r * 0.35); g.stroke();
      }
      break;
    case 'stim':
      g.save(); g.rotate(-0.68);
      g.fillRect(-r * 0.24, -r * 0.75, r * 0.48, r * 1.2);
      g.strokeRect(-r * 0.24, -r * 0.75, r * 0.48, r * 1.2);
      g.fillRect(-r * 0.42, -r * 0.95, r * 0.84, r * 0.22);
      g.beginPath(); g.moveTo(-r * 0.1, r * 0.45); g.lineTo(r * 0.1, r * 0.45);
      g.lineTo(0, r * 1.15); g.closePath(); g.fill(); g.stroke();
      g.restore(); break;
    case 'veil':
      g.beginPath();
      g.moveTo(0, -r); g.quadraticCurveTo(r * 0.95, -r * 0.45, r * 0.7, r * 0.9);
      g.quadraticCurveTo(0, r * 0.55, -r * 0.7, r * 0.9);
      g.quadraticCurveTo(-r * 0.95, -r * 0.45, 0, -r);
      g.closePath(); g.stroke();
      g.save(); g.globalAlpha = 0.5; g.fill(); g.restore();
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(-r * 0.7, i * r * 0.44); g.lineTo(r * 0.7, i * r * 0.44 - r * 0.18); g.stroke();
      }
      break;
    case 'lantern':
      g.beginPath(); g.arc(0, -r * 0.85, r * 0.28, Math.PI, 0); g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.55, -r * 0.5); g.lineTo(r * 0.55, -r * 0.5);
      g.lineTo(r * 0.72, r * 0.9); g.lineTo(-r * 0.72, r * 0.9);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.ellipse(0, r * 0.2, r * 0.3, r * 0.42, 0, 0, Math.PI * 2); g.fill(); g.restore(); break;
    case 'meteor':
      g.beginPath();
      g.moveTo(r * 0.15, r * 0.15); g.lineTo(r * 1.1, -r * 0.8);
      g.lineTo(r * 0.55, -r * 0.95); g.lineTo(-r * 0.1, -r * 0.1);
      g.closePath(); g.fill();
      g.beginPath(); g.arc(-r * 0.35, r * 0.35, r * 0.5, 0, Math.PI * 2); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.arc(-r * 0.5, r * 0.2, r * 0.14, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(-r * 0.15, r * 0.55, r * 0.1, 0, Math.PI * 2); g.fill(); g.restore(); break;
    case 'crown':
      g.beginPath();
      g.moveTo(-r * 0.95, r * 0.55); g.lineTo(-r * 0.8, -r * 0.6);
      g.lineTo(-r * 0.35, r * 0.02); g.lineTo(0, -r * 0.95);
      g.lineTo(r * 0.35, r * 0.02); g.lineTo(r * 0.8, -r * 0.6); g.lineTo(r * 0.95, r * 0.55);
      g.closePath(); g.fill(); g.stroke();
      g.fillRect(-r * 0.95, r * 0.58, r * 1.9, r * 0.3);
      g.strokeRect(-r * 0.95, r * 0.58, r * 1.9, r * 0.3); break;

    // --- blight ---
    // Every glyph here is a *deformed echo* of the glyph it eats: the same
    // count of the same primitive, slumped, split or overgrown. They are drawn
    // chunkier than the rest of the set — heavier masses, fewer hairlines —
    // because the deformations that make an echo legible (a split, a slump) are
    // exactly what a 33px inventory strip eats first. That was authored when the
    // tile art inverted figure and ground for this tier; the tiles now take the
    // ordinary `ui/Icons.js` path, and the chunkiness earns its keep either way.

    // Spasm Gland (Adrenal Syringe): the three bars, seizing.
    case 'spasmgland':
      for (let i = 0; i < 3; i++) {
        const x = (i - 1) * r * 0.62;
        const h = r * (i === 1 ? 1.0 : 0.72);
        const skew = (i - 1) * r * 0.22;
        g.beginPath();
        g.moveTo(x - r * 0.2, r * 0.9); g.lineTo(x - r * 0.2 + skew, -h);
        g.lineTo(x + r * 0.2 + skew, -h); g.lineTo(x + r * 0.2, r * 0.9);
        g.closePath(); g.fill(); g.stroke();
      }
      g.beginPath(); g.moveTo(-r * 1.0, r * 0.1); g.lineTo(r * 1.0, -r * 0.25); g.stroke();
      break;
    // Bloat Cyst (Cured Haunch): the drop, swollen and split.
    case 'bloatcyst':
      g.beginPath();
      g.moveTo(0, -r * 1.0);
      g.bezierCurveTo(r * 1.1, -r * 0.6, r * 1.05, r * 0.75, 0, r * 1.0);
      g.bezierCurveTo(-r * 1.05, r * 0.75, -r * 1.1, -r * 0.6, 0, -r * 1.0);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.18);
      g.beginPath();
      g.moveTo(-r * 0.15, -r * 0.72); g.lineTo(r * 0.12, -r * 0.1);
      g.lineTo(-r * 0.2, r * 0.34); g.lineTo(r * 0.05, r * 0.82);
      g.stroke(); g.restore();
      break;
    // Clouded Eye (Gunsmith's Loupe): the ring, filmed over.
    case 'cloudedeye':
      g.lineWidth = Math.max(2, r * 0.26);
      g.beginPath(); g.arc(0, 0, r * 0.82, 0, Math.PI * 2); g.stroke();
      g.lineWidth = Math.max(1.5, r * 0.16);
      g.beginPath(); g.arc(0, 0, r * 0.46, 0, Math.PI * 2); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1, r * 0.14);
      for (let i = -1; i <= 1; i++) {
        g.beginPath(); g.moveTo(-r * 0.42, i * r * 0.24); g.lineTo(r * 0.42, i * r * 0.24 - r * 0.1); g.stroke();
      }
      g.restore();
      break;
    // Slag Ingot (Trauma Plate): the shield, poured and set.
    case 'slagingot':
      g.beginPath();
      g.moveTo(-r * 0.72, -r * 0.62); g.lineTo(r * 0.72, -r * 0.62);
      g.lineTo(r * 1.0, r * 0.42); g.lineTo(-r * 1.0, r * 0.42);
      g.closePath(); g.fill(); g.stroke();
      for (const x of [-0.55, 0.0, 0.6]) {
        g.beginPath(); g.arc(r * x, r * 0.72, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    // Arc Rot (Cracked Zither): the bolt, coming apart down its own length.
    case 'arcrot':
      g.beginPath();
      g.moveTo(r * 0.28, -r * 1.05); g.lineTo(-r * 0.62, r * 0.05);
      g.lineTo(-r * 0.05, r * 0.05); g.lineTo(-r * 0.3, r * 0.55);
      g.lineTo(r * 0.5, -r * 0.35); g.lineTo(-r * 0.02, -r * 0.35);
      g.closePath(); g.fill(); g.stroke();
      for (const [x, y, rr] of [[r * 0.55, r * 0.62, r * 0.22], [r * 0.9, r * 0.2, r * 0.15], [r * 0.2, r * 0.98, r * 0.13]]) {
        g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    // Bile Shell (Missile Rack): the rocket, with its nose gone soft.
    case 'bileshell':
      g.beginPath();
      g.moveTo(0, -r * 1.05);
      g.quadraticCurveTo(r * 0.62, -r * 0.5, r * 0.44, r * 0.5);
      g.lineTo(-r * 0.44, r * 0.5);
      g.quadraticCurveTo(-r * 0.62, -r * 0.5, 0, -r * 1.05);
      g.closePath(); g.fill(); g.stroke();
      for (const sx of [-1, 1]) {
        g.beginPath();
        g.moveTo(sx * r * 0.44, r * 0.1); g.lineTo(sx * r * 0.95, r * 0.72);
        g.lineTo(sx * r * 0.44, r * 0.5); g.closePath(); g.fill(); g.stroke();
      }
      g.beginPath(); g.arc(0, r * 0.86, r * 0.24, 0, Math.PI * 2); g.fill(); g.stroke();
      break;
    // Gristle Sickle (Reaping Hook): the blade, notched to the bone.
    case 'gristlesickle':
      g.beginPath();
      g.moveTo(-r * 0.85, r * 0.95);
      g.bezierCurveTo(-r * 1.0, -r * 0.35, r * 0.05, -r * 1.05, r * 0.92, -r * 0.72);
      g.bezierCurveTo(r * 0.2, -r * 0.42, -r * 0.3, r * 0.15, -r * 0.42, r * 0.95);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      for (const [x, y] of [[-0.62, 0.12], [-0.2, -0.42], [0.35, -0.72]]) {
        g.beginPath(); g.arc(r * x, r * y, r * 0.13, 0, Math.PI * 2); g.fill();
      }
      g.restore();
      break;
    // Rupture Gall (Shrapnel Heart): the nova, going off inside a growth.
    case 'rupturegall':
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        g.beginPath();
        g.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
        g.lineTo(Math.cos(a) * r * (i % 2 ? 1.05 : 0.78), Math.sin(a) * r * (i % 2 ? 1.05 : 0.78));
        g.stroke();
      }
      g.beginPath();
      g.moveTo(0, -r * 0.68);
      g.bezierCurveTo(r * 0.78, -r * 0.5, r * 0.6, r * 0.62, 0, r * 0.66);
      g.bezierCurveTo(-r * 0.6, r * 0.62, -r * 0.78, -r * 0.5, 0, -r * 0.68);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.arc(0, 0, r * 0.22, 0, Math.PI * 2); g.fill(); g.restore();
      break;
    // Loaded Knucklebone (Pressed Clover): a die cut from a joint, weighted.
    case 'knucklebone':
      g.beginPath();
      g.moveTo(-r * 0.78, -r * 0.6);
      g.quadraticCurveTo(-r * 1.0, 0, -r * 0.72, r * 0.72);
      g.lineTo(r * 0.72, r * 0.72);
      g.quadraticCurveTo(r * 1.0, 0, r * 0.78, -r * 0.6);
      g.quadraticCurveTo(0, -r * 1.02, -r * 0.78, -r * 0.6);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      for (const [x, y] of [[-0.36, -0.24], [0.36, -0.24], [0, 0.08], [-0.36, 0.4], [0.36, 0.4]]) {
        g.beginPath(); g.arc(r * x, r * y, r * 0.13, 0, Math.PI * 2); g.fill();
      }
      g.restore();
      break;

    // ------------------------------------------------ round 7 content glyphs
    //
    // Same constraint as the round-5 set above: inside a tier every plate is the
    // same colour, so the outline alone has to name the item at the 33 px the
    // inventory strip actually renders. Each case below was picked for a
    // primitive family its own tier does not already use — a splayed A-frame
    // where the commons are all convex blobs, a book where the uncommons are all
    // blades and coils, an hourglass where the legendaries are all radial
    // bursts — rather than for how much the drawing resembles the object.

    // --- common ---
    // Folding Bipod: an A-frame on a rail. The only splayed open shape in a tier
    // otherwise made entirely of filled convex lumps.
    case 'bipod':
      g.beginPath();
      g.moveTo(0, -r * 0.95); g.lineTo(-r * 0.8, r * 0.9);
      g.moveTo(0, -r * 0.95); g.lineTo(r * 0.8, r * 0.9);
      g.stroke();
      // Feet and the collar that holds the legs together — three separate marks,
      // so the shape survives being reduced to a mask.
      for (const x of [-r * 0.8, r * 0.8]) {
        g.beginPath(); g.moveTo(x - r * 0.28, r * 0.9); g.lineTo(x + r * 0.28, r * 0.9); g.stroke();
      }
      g.beginPath(); g.moveTo(-r * 0.34, r * 0.05); g.lineTo(r * 0.34, r * 0.05); g.stroke();
      g.beginPath(); g.arc(0, -r * 0.95, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke(); break;
    // Chipped Whetstone: a long canted bar with a bite out of one edge. Reads
    // against `flint` because it is a rectangle at an angle rather than a
    // knapped polygon, and the notch is on the silhouette, not inside it.
    case 'whetstone':
      g.save(); g.rotate(-0.5);
      g.beginPath();
      g.moveTo(-r * 1.05, -r * 0.3);
      g.lineTo(r * 0.15, -r * 0.3);
      g.lineTo(r * 0.4, -r * 0.02);
      g.lineTo(r * 1.0, -r * 0.02);
      g.lineTo(r * 1.0, r * 0.3);
      g.lineTo(-r * 1.05, r * 0.3);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.15);
      g.beginPath(); g.moveTo(-r * 0.9, 0); g.lineTo(r * 0.1, 0); g.stroke();
      g.restore(); g.restore(); break;
    // Prey Instinct: three raked claw scores. No fill at all — the only glyph in
    // the common tier that is pure line, which is what separates it from every
    // filled lump around it before shape is even considered.
    case 'instinct':
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(i * r * 0.46 - r * 0.3, -r * 0.95);
        g.quadraticCurveTo(i * r * 0.46 + r * 0.1, 0, i * r * 0.46 + r * 0.34, r * 0.95);
        g.stroke();
      }
      break;

    // --- uncommon ---
    // Afflictor's Index: a bound codex seen edge-on, with tabs. Rectangular and
    // horizontal where the tier's other rectangles (`cell`, `overcharge`) stand
    // upright.
    case 'index':
      g.beginPath();
      g.moveTo(-r * 0.95, -r * 0.62); g.lineTo(r * 0.75, -r * 0.62);
      g.lineTo(r * 0.95, r * 0.72); g.lineTo(-r * 0.75, r * 0.72);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(1.5, r * 0.14);
      g.beginPath(); g.moveTo(-r * 0.62, -r * 0.62); g.lineTo(-r * 0.42, r * 0.72); g.stroke();
      for (let i = 0; i < 3; i++) {
        const y = -r * 0.24 + i * r * 0.34;
        g.beginPath(); g.moveTo(-r * 0.28, y); g.lineTo(r * 0.6, y); g.stroke();
      }
      g.restore(); break;
    // Grapnel Tether: a barbed hook on a taut line. `razor` is the other line in
    // the tier and it is a straight X — this one is a hooked curve with mass at
    // one end, so the two do not share a mask.
    case 'harpoon':
      g.beginPath(); g.moveTo(-r, -r * 0.95); g.lineTo(r * 0.1, r * 0.1); g.stroke();
      g.beginPath();
      g.moveTo(r * 0.1, r * 0.1);
      g.quadraticCurveTo(r * 1.05, r * 0.35, r * 0.5, r * 0.95);
      g.stroke();
      // Two barbs off the shank, on the same side, so the hook has a direction.
      for (const [x, y] of [[r * 0.62, r * 0.42], [r * 0.34, r * 0.86]]) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - r * 0.45, y - r * 0.12); g.stroke();
      }
      g.beginPath(); g.arc(-r, -r * 0.95, r * 0.18, 0, Math.PI * 2); g.fill(); g.stroke(); break;
    // Emberwake Cleats: a cleated tread plate with a trailing wake. `sole` is the
    // other footwear glyph but it is a common, and this one is a wedge with a
    // comet tail rather than an outlined footprint.
    case 'emberwake':
      g.beginPath();
      g.moveTo(r * 0.1, -r * 0.95); g.lineTo(r * 0.9, -r * 0.2);
      g.lineTo(r * 0.55, r * 0.55); g.lineTo(-r * 0.2, r * 0.3);
      g.closePath(); g.fill(); g.stroke();
      for (let i = 0; i < 3; i++) {
        const t = i / 2;
        g.beginPath();
        g.moveTo(-r * 0.3 - t * r * 0.55, r * 0.1 + t * r * 0.3);
        g.lineTo(-r * 0.75 - t * r * 0.35, r * 0.5 + t * r * 0.42);
        g.stroke();
      }
      break;
    // Arc Capacitor: two parallel plates with a discharge jumping the gap. The
    // gap is the read — nothing else in the tier has a hole through its middle.
    case 'capacitor':
      g.fillRect(-r * 0.95, -r * 0.85, r * 0.42, r * 1.7);
      g.strokeRect(-r * 0.95, -r * 0.85, r * 0.42, r * 1.7);
      g.fillRect(r * 0.53, -r * 0.85, r * 0.42, r * 1.7);
      g.strokeRect(r * 0.53, -r * 0.85, r * 0.42, r * 1.7);
      g.beginPath();
      g.moveTo(-r * 0.5, -r * 0.4); g.lineTo(r * 0.05, -r * 0.05);
      g.lineTo(-r * 0.15, r * 0.1); g.lineTo(r * 0.5, r * 0.45);
      g.stroke(); break;
    // Scrapfly Hive: a chevron body with two swept wings. The only glyph in the
    // tier built from a horizontal V, and `flies` — the nearest neighbour by
    // theme — is a scatter of discs, so they share nothing.
    case 'scrapfly':
      g.beginPath();
      g.moveTo(0, -r * 0.9); g.lineTo(r * 0.28, r * 0.2); g.lineTo(0, r * 0.95);
      g.lineTo(-r * 0.28, r * 0.2); g.closePath(); g.fill(); g.stroke();
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(s * r * 0.2, -r * 0.5);
        g.quadraticCurveTo(s * r * 1.1, -r * 0.62, s * r * 0.95, r * 0.2);
        g.quadraticCurveTo(s * r * 0.6, -r * 0.05, s * r * 0.2, -r * 0.5);
        g.closePath(); g.fill(); g.stroke();
      }
      break;

    // --- legendary ---
    // Entropy Ledger: an hourglass, mostly run out. The legendary tier is almost
    // all radial (`nova`, `burst`, `prism`, `chart`); this is the one waisted
    // vertical shape in it.
    case 'entropy':
      g.beginPath();
      g.moveTo(-r * 0.8, -r * 0.95); g.lineTo(r * 0.8, -r * 0.95);
      g.lineTo(r * 0.12, 0); g.lineTo(r * 0.8, r * 0.95);
      g.lineTo(-r * 0.8, r * 0.95); g.lineTo(-r * 0.12, 0);
      g.closePath(); g.fill(); g.stroke();
      // The sand: dark in the drained upper bulb, so the interior cut is on the
      // half that matters and the glyph is not symmetrical top to bottom.
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath();
      g.moveTo(-r * 0.66, -r * 0.82); g.lineTo(r * 0.66, -r * 0.82);
      g.lineTo(r * 0.1, -r * 0.1); g.lineTo(-r * 0.1, -r * 0.1);
      g.closePath(); g.fill(); g.restore(); break;
    // Temporal Echo: one arrowhead with two ghosts of itself trailing behind it,
    // each smaller. The repetition is the whole idea, and repetition is a shape
    // no other glyph in the file uses.
    case 'echo':
      for (let i = 0; i < 3; i++) {
        const k = 1 - i * 0.3;
        g.save();
        g.translate(-i * r * 0.44, 0);
        g.beginPath();
        g.moveTo(r * 0.75 * k, 0);
        g.lineTo(-r * 0.35 * k, -r * 0.8 * k);
        g.lineTo(-r * 0.05 * k, 0);
        g.lineTo(-r * 0.35 * k, r * 0.8 * k);
        g.closePath();
        if (i === 0) { g.fill(); g.stroke(); } else g.stroke();
        g.restore();
      }
      break;
    // Gilded Reliquary: a footed cup with coins stacked over its lip. `clover`
    // and `alien` are the other rounded legendaries and both are lobed; this one
    // is a stemmed silhouette with a flat base.
    case 'gildedcup':
      g.beginPath();
      g.moveTo(-r * 0.7, -r * 0.35);
      g.quadraticCurveTo(0, r * 0.6, r * 0.7, -r * 0.35);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.1, r * 0.2); g.lineTo(-r * 0.1, r * 0.72);
      g.lineTo(-r * 0.6, r * 0.92); g.lineTo(r * 0.6, r * 0.92);
      g.lineTo(r * 0.1, r * 0.72); g.lineTo(r * 0.1, r * 0.2);
      g.closePath(); g.fill(); g.stroke();
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.ellipse((i - 1) * r * 0.42, -r * 0.62 - (i === 1 ? r * 0.24 : 0), r * 0.24, r * 0.11, 0, 0, Math.PI * 2);
        g.fill(); g.stroke();
      }
      break;

    // --- boss ---
    // Tectonic Heart: a disc split by three fissures. The boss tier is a
    // standing stone, a teardrop, a stalk cluster and three plates — none of
    // them is a circle with cracks through it.
    case 'tectonic':
      g.beginPath(); g.arc(0, 0, r * 0.92, 0, Math.PI * 2); g.fill(); g.stroke();
      g.save(); g.strokeStyle = '#0d0f14'; g.lineWidth = Math.max(2, r * 0.2);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
        g.lineTo(Math.cos(a + 0.4) * r * 0.95, Math.sin(a + 0.4) * r * 0.95);
        g.stroke();
      }
      g.restore();
      g.beginPath(); g.arc(0, 0, r * 0.22, 0, Math.PI * 2); g.fill(); g.stroke(); break;

    // --- lunar ---
    // Vow of Momentum: three speed chevrons, stacked and offset. The lunar tier
    // is otherwise a broken ring, a bound circle, a chain, a coin, a flower and a
    // cracked blade; nothing in it is a run of repeated angles.
    case 'momentum':
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(-r * 0.9 + i * r * 0.12, i * r * 0.6 - r * 0.34);
        g.lineTo(r * 0.1 + i * r * 0.12, i * r * 0.6);
        g.lineTo(-r * 0.9 + i * r * 0.12, i * r * 0.6 + r * 0.34);
        g.stroke();
        g.beginPath();
        g.moveTo(r * 0.35 + i * r * 0.12, i * r * 0.6 - r * 0.34);
        g.lineTo(r * 0.95 + i * r * 0.12, i * r * 0.6);
        g.lineTo(r * 0.35 + i * r * 0.12, i * r * 0.6 + r * 0.34);
        g.stroke();
      }
      break;
    // Ashen Pact: a flame held inside a closed ring — the bargain and the thing
    // it burns, one enclosing the other. `bloom` and `brittle` are the other
    // lunar organics and neither is a containment shape.
    case 'ashenpact':
      g.beginPath(); g.arc(0, 0, r * 0.98, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(0, 0, r * 0.78, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.moveTo(0, -r * 0.62);
      g.quadraticCurveTo(r * 0.55, -r * 0.05, r * 0.3, r * 0.55);
      g.lineTo(0, r * 0.2);
      g.lineTo(-r * 0.3, r * 0.55);
      g.quadraticCurveTo(-r * 0.55, -r * 0.05, 0, -r * 0.62);
      g.closePath(); g.fill(); g.stroke(); break;

    // --- blight ---
    // Gorging Tooth: a molar with the roots still on it and a hollow bored
    // through the crown. `gristlesickle` is the tier's other bone shape and it
    // is a curve; this is a blunt block on two prongs.
    case 'gorgetooth':
      g.beginPath();
      g.moveTo(-r * 0.72, -r * 0.85); g.lineTo(r * 0.72, -r * 0.85);
      g.lineTo(r * 0.6, r * 0.05); g.lineTo(r * 0.34, r * 0.95);
      g.lineTo(r * 0.06, r * 0.1); g.lineTo(-r * 0.34, r * 0.95);
      g.lineTo(-r * 0.6, r * 0.05);
      g.closePath(); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      g.beginPath(); g.ellipse(0, -r * 0.42, r * 0.28, r * 0.2, 0, 0, Math.PI * 2); g.fill();
      g.restore(); break;
    // Splinter Bar: the Pry Bar's hooked head, snapped clean through the shaft.
    // The break is the silhouette — two pieces with a gap, which no other glyph
    // in the file has.
    case 'splinterbar':
      g.save(); g.rotate(-0.62);
      g.beginPath();
      g.moveTo(-r * 0.2, -r * 0.44);
      g.lineTo(-r * 0.8, -r * 0.86);
      g.lineTo(-r * 0.36, -r * 1.06);
      g.lineTo(0, -r * 0.74);
      g.lineTo(r * 0.36, -r * 1.06);
      g.lineTo(r * 0.8, -r * 0.86);
      g.lineTo(r * 0.2, -r * 0.44);
      g.lineTo(r * 0.16, r * 0.1);
      g.lineTo(-r * 0.02, r * 0.02);
      g.lineTo(-r * 0.16, r * 0.16);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.16, r * 0.44);
      g.lineTo(0, r * 0.32);
      g.lineTo(r * 0.16, r * 0.46);
      g.lineTo(r * 0.16, r * 1.1);
      g.lineTo(-r * 0.16, r * 1.1);
      g.closePath(); g.fill(); g.stroke();
      g.restore(); break;

    // --- equipment ---
    // Recall Beacon: a planted stake throwing two return arcs. The equipment set
    // is otherwise all held objects; this is the only one that is a thing left
    // in the ground.
    case 'beacon':
      g.beginPath();
      g.moveTo(-r * 0.16, -r * 0.4); g.lineTo(r * 0.16, -r * 0.4);
      g.lineTo(r * 0.1, r * 0.95); g.lineTo(-r * 0.1, r * 0.95);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.arc(0, -r * 0.66, r * 0.26, 0, Math.PI * 2); g.fill(); g.stroke();
      for (let i = 1; i <= 2; i++) {
        g.beginPath();
        g.arc(0, -r * 0.66, r * (0.42 + i * 0.28), Math.PI * 1.15, Math.PI * 1.85);
        g.stroke();
      }
      break;
    // Aegis Emitter: a dome on a base plate. A half-disc, which nothing else in
    // the set is — `snare` is a full ring and `veil` is a lens.
    case 'aegis':
      g.beginPath(); g.arc(0, r * 0.35, r * 0.92, Math.PI, 0); g.stroke();
      g.beginPath(); g.arc(0, r * 0.35, r * 0.62, Math.PI, 0); g.stroke();
      g.beginPath();
      g.moveTo(-r * 0.5, r * 0.35); g.lineTo(r * 0.5, r * 0.35);
      g.lineTo(r * 0.34, r * 0.9); g.lineTo(-r * 0.34, r * 0.9);
      g.closePath(); g.fill(); g.stroke();
      break;

    default: poly(g, 4, r, 0); g.fill(); g.stroke();
  }
}
