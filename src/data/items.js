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
export const TIERS = {
  common: { name: 'Common', colour: 0xd8dde6, css: '#d8dde6', weight: 80 },
  uncommon: { name: 'Uncommon', colour: 0x49d67a, css: '#49d67a', weight: 20 },
  legendary: { name: 'Legendary', colour: 0xf0453f, css: '#f0453f', weight: 1 },
  boss: { name: 'Boss', colour: 0xffd23f, css: '#ffd23f', weight: 0 },
  lunar: { name: 'Lunar', colour: 0x5fd9f7, css: '#5fd9f7', weight: 0 },
  // Blight sits at weight 0 for the same reason boss and lunar do: it is never
  // reached by multiplying the generic ladder. `Items.rollTier` adds it as an
  // explicit share of whatever table it was handed, so one constant sets the
  // rate for every chest in the game at once — see BLIGHT_SHARE there.
  blight: { name: 'Blight', colour: 0xd8479b, css: '#d8479b', weight: 0 },
  equipment: { name: 'Equipment', colour: 0xff9a3c, css: '#ff9a3c', weight: 0 },
};

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
export function chainLightning(api, origin, damage, bounces) {
  const { combat, player, ctx } = api;
  let from = origin.position || origin;
  let last = origin.entity || origin;
  const hit = [last];
  for (let i = 0; i < bounces; i++) {
    const next = combat.nearestHostile(last.position || from, 14, 'player', hit);
    if (!next) break;
    ctx.vfx?.beam?.(last.position || from, next.position, 0x9fd8ff);
    combat.applyDamage(next, damage, {
      source: player, position: next.position, type: 'lightning',
      procCoefficient: 0.2, procDepth: api.procDepth,
    });
    hit.push(next);
    last = next;
  }
}

export function seekingStrike(api, from, damage, count, colour, type) {
  const { combat, player, ctx } = api;
  const seen = [];
  for (let i = 0; i < count; i++) {
    const target = combat.nearestHostile(from, 30, 'player', seen);
    if (!target) break;
    seen.push(target);
    ctx.vfx?.beam?.(from, target.position, colour);
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
 */
const SELF_COST_FLOOR = 0.30;
function payHealth(api, amount) {
  const p = api.player;
  if (!p?.alive || amount <= 0) return 0;
  const floor = (p.stats?.maxHealth || 100) * SELF_COST_FLOOR;
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
    corrupts: 'syringe',
    flavour: 'It fires whether or not you asked. The asking was always the slow part.',
    description: (n) => `+${pct(linear(0.26, n))} attack speed. Your maximum health is reduced to ${pct(hyperbolicMult(0.15, n))}. Consumes every ${consumes('syringe')} you hold.`,
    stat: (n, s) => {
      s.attackSpeed += linear(0.26, n);
      s.healthMult *= hyperbolicMult(0.15, n);
    },
  },
  {
    id: 'bloat-cyst', name: 'Bloat Cyst', tier: 'blight', glyph: 'bloatcyst',
    corrupts: 'steak',
    flavour: 'More of you to hit, and less of you willing to stop it.',
    description: (n) => `+${linear(55, n)} maximum health. -${linear(9, n)} armor. Consumes every ${consumes('steak')} you hold.`,
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
    corrupts: 'glasses',
    flavour: 'You see the weak point in everything now. You just cannot see it well.',
    description: (n) => `+${pct(hyperbolic(0.20, n))} critical strike chance. Critical strikes deal ${pct(1 - hyperbolicMult(0.30, n))} less bonus damage. Consumes every ${consumes('glasses')} you hold.`,
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
    corrupts: 'armor-plate',
    flavour: 'Poured straight onto the plate carrier while it was still on him.',
    description: (n) => `Reduce all incoming damage by ${linear(13, n)}. Your movement speed is reduced to ${pct(hyperbolicMult(0.20, n))}. Consumes every ${consumes('armor-plate')} you hold.`,
    stat: (n, s) => {
      s.flatReduction += linear(13, n);
      s.moveSpeed *= hyperbolicMult(0.20, n);
    },
  },
  {
    id: 'arc-rot', name: 'Arc Rot', tier: 'blight', glyph: 'arcrot',
    corrupts: 'ukulele',
    flavour: 'The current has to come from somewhere, and you are the nearest wet thing.',
    description: (n) => `${pct(hyperbolic(0.40, n))} chance on hit to arc for 110% damage across ${3 + linear(2, n)} targets. Every arc costs 1.5% of your current health, down to 30%. Consumes every ${consumes('ukulele')} you hold.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.40, api.count))) return;
        chainLightning(api, e, api.items.baseDamage() * 1.1, 3 + linear(2, api.count));
        // Charged per *proc*, not per stack: stacking already buys more procs, so
        // a per-stack bill would make the cost quadratic in the count.
        payHealth(api, api.player.health * 0.015);
      },
    },
  },
  {
    id: 'bile-shell', name: 'Bile Shell', tier: 'blight', glyph: 'bileshell',
    corrupts: 'atg',
    flavour: 'It was a warhead before something digested it.',
    description: (n) => `${pct(hyperbolic(0.22, n))} chance on hit to fire a shell for ${pct(linear(4.5, n))} damage. All of your damage is reduced to ${pct(hyperbolicMult(0.20, n))}. Consumes every ${consumes('atg')} you hold.`,
    stat: (n, s) => { s.damageMult *= hyperbolicMult(0.20, n); },
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.22, api.count))) return;
        api.ctx.vfx?.missile?.(api.player.position, e.position);
        api.combat.explode(e.position, 5, api.items.baseDamage() * linear(4.5, api.count), api.player, {
          team: 'player', proc: 0.6, procDepth: api.procDepth, type: 'missile',
        });
      },
    },
  },
  {
    id: 'gristle-sickle', name: 'Gristle Sickle', tier: 'blight', glyph: 'gristlesickle',
    corrupts: 'harvesters-scythe',
    flavour: 'It will keep you alive exactly as long as you keep finding throats.',
    description: (n) => `Critical strikes heal you for ${linear(24, n)}. You no longer regenerate health passively. Consumes every ${consumes('harvesters-scythe')} you hold.`,
    stat: (n, s) => { s.noRegen = true; },
    hooks: {
      onHit: (e, api) => { if (e.crit) api.combat.heal(api.player, linear(24, api.count)); },
    },
  },
  {
    id: 'rupture-gall', name: 'Rupture Gall', tier: 'blight', glyph: 'rupturegall',
    corrupts: 'behemoth',
    flavour: 'A tumour that learned what a shaped charge is.',
    description: (n) => `ALL of your attacks explode in a ${2.5 + linear(1, n)}m radius for an extra 105% damage. Your maximum health is reduced to ${pct(hyperbolicMult(0.35, n))}. Consumes every ${consumes('behemoth')} you hold.`,
    stat: (n, s) => { s.healthMult *= hyperbolicMult(0.35, n); },
    hooks: {
      onHit: (e, api) => {
        if (e.type === 'gall') return; // never detonate our own detonation
        if (api.procDepth > api.combat.MAX_PROC_DEPTH - 1) return;
        api.combat.explode(e.position, 2.5 + linear(1, api.count), e.amount * 1.05, api.player, {
          team: 'player', proc: 0, procDepth: api.procDepth, type: 'gall', falloff: false,
        });
      },
    },
  },
  {
    id: 'loaded-knucklebone', name: 'Loaded Knucklebone', tier: 'blight', glyph: 'knucklebone',
    corrupts: 'clover',
    flavour: 'Weighted on one face. Someone had to be hollowed out to do it.',
    description: (n) => `All random effects are rolled +${linear(2, n)} extra times for a favourable outcome. You take ${pct(2 - 100 / (100 + linear(40, n)))} more damage. Consumes every ${consumes('clover')} you hold.`,
    stat: (n, s) => {
      s.luck += linear(2, n);
      s.armor -= linear(40, n);
    },
  },

  // ------------------------------------------------------------------ COMMON
  {
    id: 'syringe', name: "Soldier's Syringe", tier: 'common', glyph: 'bars',
    flavour: 'Property of Dr. E. Fenwick. Do not remove from the medbay.',
    description: (n) => `+${pct(linear(0.15, n))} attack speed.`,
    stat: (n, s) => { s.attackSpeed += linear(0.15, n); },
  },
  {
    id: 'hoof', name: "Paul's Goat Hoof", tier: 'common', glyph: 'arrow',
    flavour: 'It still smells of the pasture.',
    description: (n) => `+${pct(linear(0.14, n))} movement speed.`,
    stat: (n, s) => { s.moveSpeed *= 1 + linear(0.14, n); },
  },
  {
    id: 'steak', name: 'Bison Steak', tier: 'common', glyph: 'drop',
    flavour: 'Rare. Very rare.',
    description: (n) => `+${linear(25, n)} maximum health.`,
    stat: (n, s) => { s.maxHealth += linear(25, n); },
  },
  {
    id: 'roll-of-pennies', name: 'Roll of Pennies', tier: 'common', glyph: 'circle',
    flavour: 'Found under the vending machine. Still counts.',
    description: (n) => `Gain ${linear(2, n)} gold whenever you are hurt.`,
    hooks: {
      onDamaged: (e, api) => { api.items.addGold(linear(2, api.count)); },
    },
  },
  {
    id: 'tougher-times', name: 'Tougher Times', tier: 'common', glyph: 'hex',
    flavour: 'Bounce, dodge, weave. Repeat.',
    description: (n) => `${pct(hyperbolic(0.15, n))} chance to block incoming damage.`,
    stat: (n, s) => { s.blockChance = 1 - (1 - (s.blockChance || 0)) * (1 - hyperbolic(0.15, n)); },
  },
  {
    id: 'armor-plate', name: 'Repulsion Armor Plate', tier: 'common', glyph: 'shield',
    flavour: 'Rated for small-arms fire. Mostly.',
    description: (n) => `Reduce all incoming damage by ${linear(5, n)}.`,
    stat: (n, s) => { s.flatReduction += linear(5, n); },
  },
  {
    id: 'crowbar', name: 'Crowbar', tier: 'common', glyph: 'cross',
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
    id: 'predatory', name: 'Predatory Instincts', tier: 'common', glyph: 'triangle',
    flavour: 'Blood in the water.',
    description: (n) => `Critical strikes grant +${pct(linear(0.12, n))} attack speed for 3s, up to 3 stacks.`,
    hooks: {
      onHit: (e, api) => {
        if (!e.crit) return;
        api.items.addBuff('frenzy', 3, 3, linear(0.12, api.count));
      },
    },
  },
  {
    id: 'glasses', name: "Lens-Maker's Glasses", tier: 'common', glyph: 'ring',
    flavour: 'Perfect vision is a weapon.',
    description: (n) => `+${pct(hyperbolic(0.10, n))} critical strike chance.`,
    stat: (n, s) => { s.critChance = 1 - (1 - s.critChance) * (1 - hyperbolic(0.10, n)); },
  },
  {
    id: 'sticky-bomb', name: 'Sticky Bomb', tier: 'common', glyph: 'diamond',
    flavour: 'Warning: adhesive is permanent.',
    description: (n) => `${pct(hyperbolic(0.05, n))} chance on hit to attach a bomb for 180% damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.05, api.count))) return;
        api.combat.explode(e.position, 4, api.items.baseDamage() * 1.8, api.player, {
          team: 'player', proc: 0.3, procDepth: api.procDepth, type: 'sticky',
        });
      },
    },
  },
  {
    id: 'gasoline', name: 'Gasoline', tier: 'common', glyph: 'flame',
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
        api.ctx.vfx?.ring?.(e.position, radius, 0xff7a2a);
      },
    },
  },
  {
    id: 'monster-tooth', name: 'Monster Tooth', tier: 'common', glyph: 'star',
    flavour: 'Still warm.',
    description: (n) => `Killing an enemy heals you for ${linear(8, n)} plus ${pct(linear(0.02, n))} of max health.`,
    hooks: {
      onKill: (e, api) => {
        const p = api.player;
        api.combat.heal(p, linear(8, api.count) + (p.stats?.maxHealth || 100) * linear(0.02, api.count));
      },
    },
  },
  {
    id: 'topaz-brooch', name: 'Topaz Brooch', tier: 'common', glyph: 'gem',
    flavour: 'A gift from someone who is now dead.',
    description: (n) => `Killing an enemy grants a temporary ${linear(15, n)} point barrier.`,
    hooks: {
      onKill: (e, api) => { api.items.addBarrier(linear(15, api.count)); },
    },
  },
  {
    id: 'medkit', name: 'Medkit', tier: 'common', glyph: 'plus',
    flavour: 'Standard issue. Rarely enough.',
    description: (n) => `After being hurt, heal for ${linear(10, n)} plus ${pct(linear(0.03, n))} of max health.`,
    hooks: {
      onDamaged: (e, api) => {
        if (!api.items.cooldownReady('medkit', 1.2)) return;
        const p = api.player;
        api.combat.heal(p, linear(10, api.count) + (p.stats?.maxHealth || 100) * linear(0.03, api.count));
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
      onKill: (e, api) => { api.items.addBuff('quickfoot', linear(3, api.count), 1, 0.2); },
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
      // The bookend to Crowbar: one pays for opening a fight, this pays for
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
      },
    },
  },
  {
    id: 'rubber-soles', name: 'Rubber Soles', tier: 'common', glyph: 'sole',
    flavour: 'Air is the safest place to be.',
    description: (n) => `Jumping grants a ${linear(10, n)} point barrier.`,
    hooks: {
      onJump: (e, api) => { api.items.addBarrier(linear(10, api.count)); },
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
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.1, api.count), 1, 0xb9e4ff, 'spark');
      },
    },
  },

  // ---------------------------------------------------------------- UNCOMMON
  {
    id: 'ukulele', name: 'Ukulele', tier: 'uncommon', glyph: 'bolt',
    flavour: 'It only knows one chord and the chord is lightning.',
    description: (n) => `${pct(hyperbolic(0.25, n))} chance on hit to fire chain lightning for 80% damage, bouncing to ${2 + linear(2, n)} targets.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.25, api.count))) return;
        chainLightning(api, e, api.items.baseDamage() * 0.8, 2 + linear(2, api.count));
      },
    },
  },
  {
    id: 'atg', name: 'AtG Missile Mk. 1', tier: 'uncommon', glyph: 'rocket',
    flavour: 'Fire and forget. Mostly forget.',
    description: (n) => `${pct(hyperbolic(0.10, n))} chance on hit to fire a missile for ${pct(linear(3, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.10, api.count))) return;
        api.ctx.vfx?.missile?.(api.player.position, e.position);
        api.combat.explode(e.position, 5, api.items.baseDamage() * linear(3, api.count), api.player, {
          team: 'player', proc: 0.6, procDepth: api.procDepth, type: 'missile',
        });
      },
    },
  },
  {
    id: 'tri-tip', name: 'Tri-Tip Dagger', tier: 'uncommon', glyph: 'blade',
    flavour: 'Three edges, three reasons.',
    description: (n) => `${pct(hyperbolic(0.15, n))} chance on hit to cause bleeding for 240% damage over 3s.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.15, api.count))) return;
        api.combat.applyStatus(e.target, 'bleed', api.player, 1);
      },
    },
  },
  {
    id: 'stun-grenade', name: 'Stun Grenade', tier: 'uncommon', glyph: 'burst',
    flavour: 'Loud. Bright. Effective.',
    description: (n) => `${pct(hyperbolic(0.05, n))} chance on hit to stun enemies for 2s.`,
    hooks: {
      onHit: (e, api) => {
        if (!api.roll(hyperbolic(0.05, api.count))) return;
        api.combat.applyStatus(e.target, 'shock', api.player, 1);
      },
    },
  },
  {
    id: 'shatterspleen', name: 'Runald\'s Band', tier: 'uncommon', glyph: 'snowflake',
    flavour: 'Cold enough to stop a heart mid-beat.',
    description: (n) => `Hits that deal over 400% damage freeze and blast for ${pct(linear(2.5, n))} damage.`,
    hooks: {
      onHit: (e, api) => {
        if (e.amount < api.items.baseDamage() * 4) return;
        if (!api.items.cooldownReady('runald', 5)) return;
        api.combat.applyStatus(e.target, 'freeze', api.player, 1);
        api.combat.explode(e.position, 6, api.items.baseDamage() * linear(2.5, api.count), api.player, {
          team: 'player', proc: 0.3, procDepth: api.procDepth, type: 'frost',
        });
      },
    },
  },
  {
    id: 'infusion', name: 'Infusion', tier: 'uncommon', glyph: 'spiral',
    flavour: 'Every kill makes you a little more permanent.',
    description: (n) => `Killing an enemy permanently grants +1 max health, up to +${linear(100, n)}.`,
    hooks: {
      onKill: (e, api) => { api.items.addPermanentHealth(1, linear(100, api.count)); },
    },
  },
  {
    id: 'harvesters-scythe', name: "Harvester's Scythe", tier: 'uncommon', glyph: 'scythe',
    flavour: 'Reap what the Providence sowed.',
    description: (n) => `Critical strikes heal you for ${linear(8, n)}.`,
    hooks: {
      onHit: (e, api) => { if (e.crit) api.combat.heal(api.player, linear(8, api.count)); },
    },
  },
  {
    id: 'leeching-seed', name: 'Leeching Seed', tier: 'uncommon', glyph: 'leaf',
    flavour: 'It drinks and it grows.',
    description: (n) => `Dealing damage heals you for ${linear(1, n)}.`,
    hooks: {
      onHit: (e, api) => { api.combat.heal(api.player, linear(1, api.count)); },
    },
  },
  {
    id: 'afterburner', name: 'Hardlight Afterburner', tier: 'uncommon', glyph: 'wing',
    flavour: 'Two more chances to be somewhere else.',
    description: (n) => `+${linear(2, n)} utility charges and ${pct(1 - hyperbolicMult(0.15, n))} utility cooldown reduction.`,
    stat: (n, s) => {
      s.extraCharges += linear(2, n);
      s.cooldownMult *= hyperbolicMult(0.15, n);
    },
  },
  {
    id: 'wax-quail', name: 'Wax Quail', tier: 'uncommon', glyph: 'feather',
    flavour: 'Up is a direction. Forward is a lifestyle.',
    description: (n) => `Jumping while sprinting boosts you forward by ${linear(10, n)} m/s.`,
    stat: (n, s) => { s.jumpCount += 0; },
    hooks: {
      onJump: (e, api) => { api.items.applyImpulse(linear(10, api.count)); },
    },
  },
  {
    id: 'hopoo-feather', name: 'Hopoo Feather', tier: 'uncommon', glyph: 'plume',
    flavour: 'Weightless, mostly.',
    description: (n) => `+${linear(1, n)} maximum jump count.`,
    stat: (n, s) => { s.jumpCount += linear(1, n); },
  },
  {
    id: 'will-o-wisp', name: "Will-o'-the-Wisp", tier: 'uncommon', glyph: 'flamering',
    flavour: 'Follow the light. It is on fire.',
    description: (n) => `Killing an enemy detonates a ${pct(linear(3, n))} damage flame pillar.`,
    hooks: {
      onKill: (e, api) => {
        api.combat.explode(e.position, 8, api.items.baseDamage() * linear(3, api.count), api.player, {
          team: 'player', proc: 0.2, procDepth: api.procDepth, type: 'fire', status: 'burn',
        });
      },
    },
  },
  {
    id: 'fuel-cell', name: 'Fuel Cell', tier: 'uncommon', glyph: 'cell',
    flavour: 'Charged, sealed, and ready to be abused.',
    description: (n) => `+${linear(1, n)} equipment charge and ${pct(1 - hyperbolicMult(0.15, n))} equipment cooldown reduction.`,
    // The one item that pays into the equipment slot's own two dials. It writes
    // `equipCharges`, not `extraCharges`: the latter is the survivor's skill
    // charges, and letting one item silently buy both was the difference
    // between "Fuel Cell is good with equipment" and "Fuel Cell is mandatory".
    stat: (n, s) => {
      s.equipCharges += linear(1, n);
      s.equipCooldownMult *= hyperbolicMult(0.15, n);
    },
  },
  {
    id: 'berzerkers-pauldron', name: "Berzerker's Pauldron", tier: 'uncommon', glyph: 'pauldron',
    flavour: 'Three at once and the world goes red.',
    description: (n) => `Killing 3 enemies within 1s sends you into frenzy: +${pct(0.3)} attack and move speed for ${linear(6, n)}s.`,
    hooks: {
      onKill: (e, api) => {
        if (!api.items.tallyKillWindow(3, 1.0)) return;
        api.items.addBuff('berzerk', linear(6, api.count), 1, 0.3);
      },
    },
  },

  {
    id: 'razor-wire', name: 'Razor Wire', tier: 'uncommon', glyph: 'razor',
    flavour: 'Strung at ankle height by someone who never came back for it.',
    description: (n) => `Being hurt lashes all enemies within ${6 + linear(2, n)}m for ${pct(linear(1.6, n))} damage.`,
    hooks: {
      onDamaged: (e, api) => {
        if (!api.items.cooldownReady('razor-wire', 0.5)) return;
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
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.8, api.count), 4, 0xd6f4ff, 'wind');
      },
    },
  },
  {
    id: 'ration-pack', name: 'Sealed Ration Pack', tier: 'uncommon', glyph: 'ration',
    flavour: 'Expiry: illegible. Contents: enthusiastic.',
    description: (n) => `Killing an enemy heals ${linear(20, n)} health over 4s.`,
    hooks: {
      onKill: (e, api) => { api.items.addBuff('mending', 4, 8, linear(5, api.count)); },
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
      onHit: (e, api) => { api.items.mark(e.target, 8); },
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
      },
    },
  },
  {
    id: 'battle-hymn', name: 'Battle Hymn', tier: 'uncommon', glyph: 'hymn',
    flavour: 'Sung once, badly, by a survivor who did not survive.',
    description: (n) => `Being hurt grants +${pct(linear(0.15, n))} attack speed for 5s, up to 3 stacks.`,
    hooks: {
      onDamaged: (e, api) => { api.items.addBuff('frenzy', 5, 3, linear(0.15, api.count)); },
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

  // --------------------------------------------------------------- LEGENDARY
  {
    id: 'behemoth', name: 'Brilliant Behemoth', tier: 'legendary', glyph: 'nova',
    flavour: 'Everything you touch detonates. Including the things you did not mean to touch.',
    description: (n) => `ALL of your attacks explode in a ${linear(1.5, n) + 2.5}m radius for an extra 60% damage.`,
    hooks: {
      // The build-definer: it converts every single-target proc into an AoE,
      // which is what turns a linear DPS curve into the minute-20 slot machine.
      onHit: (e, api) => {
        if (e.type === 'behemoth') return; // never detonate our own detonation
        if (api.procDepth > api.combat.MAX_PROC_DEPTH - 1) return;
        api.combat.explode(e.position, 2.5 + linear(1.5, api.count), e.amount * 0.6, api.player, {
          team: 'player', proc: 0, procDepth: api.procDepth, type: 'behemoth', falloff: false,
        });
      },
    },
  },
  {
    id: 'clover', name: '57 Leaf Clover', tier: 'legendary', glyph: 'clover',
    flavour: 'Luck is a statistic you can purchase.',
    description: (n) => `All random effects are rolled +${linear(1, n)} extra times for a favourable outcome.`,
    stat: (n, s) => { s.luck += linear(1, n); },
  },
  {
    id: 'alien-head', name: 'Alien Head', tier: 'legendary', glyph: 'alien',
    flavour: 'It is still thinking.',
    description: (n) => `Reduce skill cooldowns by ${pct(1 - hyperbolicMult(0.25, n))}.`,
    stat: (n, s) => { s.cooldownMult *= hyperbolicMult(0.25, n); },
  },
  {
    id: 'frost-relic', name: 'Frost Relic', tier: 'legendary', glyph: 'shard',
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
    id: 'ceremonial-dagger', name: 'Ceremonial Dagger', tier: 'legendary', glyph: 'daggers',
    flavour: 'The dead keep fighting for you.',
    description: (n) => `Killing an enemy releases ${linear(1, n) + 2} seeking daggers dealing ${pct(linear(1.5, n))} damage.`,
    hooks: {
      onKill: (e, api) => {
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.5, api.count), 2 + linear(1, api.count), 0xff5fd0, 'dagger');
      },
    },
  },
  {
    id: 'brainstalks', name: 'Brainstalks', tier: 'legendary', glyph: 'stalk',
    flavour: 'It whispers cooldown numbers at you.',
    description: (n) => `Killing an elite removes all skill cooldowns for ${linear(4, n)}s.`,
    hooks: {
      onKill: (e, api) => {
        if (!e.victim?.isElite) return;
        api.items.addBuff('nocooldown', linear(4, api.count), 1, 1);
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
      },
    },
  },
  {
    id: 'chronal-governor', name: 'Chronal Governor', tier: 'legendary', glyph: 'chronal',
    flavour: 'It does not make you faster. It makes the wait shorter.',
    description: (n) => `Each kill grants a stacking ${pct(0.05)} cooldown reduction for 8s, up to ${linear(4, n) + 4} stacks.`,
    hooks: {
      onKill: (e, api) => { api.items.addBuff('overclock', 8, 4 + linear(4, api.count), 0.05); },
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
        seekingStrike(api, e.position, api.items.baseDamage() * linear(1.1, api.count),
          2 + linear(2, api.count), 0xb98cff, 'prism');
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
        api.ctx.vfx?.ring?.(at, 12, 0x9b5cff);
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
          api.ctx.vfx?.beam?.(e.position, t.position, 0xff7a2a);
          api.combat.applyStatus(t, 'burn', api.player, 1);
          api.combat.applyDamage(t, api.items.baseDamage() * linear(2, api.count), {
            source: api.player, position: t.position, type: 'fire',
            procCoefficient: 0.2, procDepth: api.procDepth,
          });
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
      },
    },
  },

  // -------------------------------------------------------------------- BOSS
  {
    id: 'titanic-knurl', name: 'Titanic Knurl', tier: 'boss', glyph: 'monolith',
    flavour: 'A shard of something that used to walk.',
    description: (n) => `+${linear(40, n)} maximum health and +${linear(1.6, n)} health regeneration.`,
    stat: (n, s) => {
      s.maxHealth += linear(40, n);
      s.healthRegen += linear(1.6, n);
    },
  },
  {
    id: 'planula', name: 'Planula', tier: 'boss', glyph: 'polyp',
    flavour: 'It feeds on the pain of its host. Symbiotically.',
    description: (n) => `Heal for ${linear(15, n)} whenever you are hit.`,
    hooks: {
      onDamaged: (e, api) => { api.combat.heal(api.player, linear(15, api.count)); },
    },
  },
  {
    id: 'queens-gland', name: "Queen's Gland", tier: 'boss', glyph: 'hive',
    flavour: 'Something in here is still gestating.',
    description: (n) => `Every 10s, release a swarm striking ${linear(3, n)} enemies for ${pct(2)} damage.`,
    hooks: {
      onInterval: (e, api) => {
        if (!api.items.cooldownReady('gland', 10)) return;
        seekingStrike(api, api.player.position, api.items.baseDamage() * 2, linear(3, api.count), 0xd9b8ff, 'swarm');
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
      onKill: (e, api) => { api.items.addCloud(e.position, 6, 5, linear(1.2, api.count)); },
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
      onKill: (e, api) => { api.items.addGold(api.items.killReward(e.victim) * linear(2, api.count)); },
    },
  },
  {
    id: 'corpse-bloom', name: 'Corpse Bloom', tier: 'lunar', glyph: 'bloom',
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
    // Roll of Pennies — a stack of coins. A plain disc was a hexagon with the
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
    // Predatory Instincts — a fang, not a plain triangle. The dark inner wedge
    // is what separates it from `arrow`, `flint` and `flame` at 20px: three
    // solid convex blobs of the same area differ by less than a tenth of their
    // mask, which is round 4's D3 floor failing.
    case 'triangle':
      poly(g, 3, r, -Math.PI / 2); g.fill(); g.stroke();
      g.save(); g.fillStyle = '#0d0f14';
      poly(g, 3, r * 0.42, Math.PI / 2); g.fill(); g.restore(); break;
    // Sticky Bomb — a charge with a lit fuse and a seam, not a bare rhombus.
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
    // Tougher Times — a hollow shell that took the hit. Hollowing it is the
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
    // Titanic Knurl — a standing stone with strata cut into it, so it is not a
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
    // Bison Steak: a cut of meat, so it carries marbling. As a bare teardrop it
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
    // so the shapes have to carry Afterburner / Wax Quail / Hopoo Feather on
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
    // Berzerker's Pauldron — the same silhouette with the spikes it is named
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
    // item is thematically close to an old one (Warm Coals next to Gasoline,
    // Frost Lattice next to Runald's Band) the new glyph deliberately takes a
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
    // Corpse Bloom: a flower opening out of a rib.
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
    // count of the same primitive, slumped, split or overgrown. The tile art
    // inverts figure and ground for this tier (`ui/Icons.js`), so these read as
    // dark holes in a solid plate rather than as bright emblems on a dark one —
    // which means they need chunkier masses and fewer hairlines than the rest of
    // the set to survive the 33px inventory strip.

    // Spasm Gland (Soldier's Syringe): the three bars, seizing.
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
    // Bloat Cyst (Bison Steak): the drop, swollen and split.
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
    // Clouded Eye (Lens-Maker's Glasses): the ring, filmed over.
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
    // Slag Ingot (Repulsion Armor Plate): the shield, poured and set.
    case 'slagingot':
      g.beginPath();
      g.moveTo(-r * 0.72, -r * 0.62); g.lineTo(r * 0.72, -r * 0.62);
      g.lineTo(r * 1.0, r * 0.42); g.lineTo(-r * 1.0, r * 0.42);
      g.closePath(); g.fill(); g.stroke();
      for (const x of [-0.55, 0.0, 0.6]) {
        g.beginPath(); g.arc(r * x, r * 0.72, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      break;
    // Arc Rot (Ukulele): the bolt, coming apart down its own length.
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
    // Bile Shell (AtG Missile): the rocket, with its nose gone soft.
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
    // Gristle Sickle (Harvester's Scythe): the blade, notched to the bone.
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
    // Rupture Gall (Brilliant Behemoth): the nova, going off inside a growth.
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
    // Loaded Knucklebone (57 Leaf Clover): a die cut from a joint, weighted.
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

    default: poly(g, 4, r, 0); g.fill(); g.stroke();
  }
}
