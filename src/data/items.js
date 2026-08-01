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

export const TIERS = {
  common: { name: 'Common', colour: 0xd8dde6, css: '#d8dde6', weight: 80 },
  uncommon: { name: 'Uncommon', colour: 0x49d67a, css: '#49d67a', weight: 20 },
  legendary: { name: 'Legendary', colour: 0xf0453f, css: '#f0453f', weight: 1 },
  boss: { name: 'Boss', colour: 0xffd23f, css: '#ffd23f', weight: 0 },
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
function chainLightning(api, origin, damage, bounces) {
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

function seekingStrike(api, from, damage, count, colour, type) {
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

export const ITEMS = [
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
    description: (n) => `+${linear(1, n)} equipment charge and ${pct(1 - hyperbolicMult(0.15, n))} cooldown reduction.`,
    stat: (n, s) => {
      s.extraCharges += linear(1, n);
      s.cooldownMult *= hyperbolicMult(0.15, n);
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
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const ITEMS_BY_TIER = ITEMS.reduce((acc, i) => {
  (acc[i.tier] ||= []).push(i);
  return acc;
}, {});

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
    case 'triangle': poly(g, 3, r, -Math.PI / 2); g.fill(); g.stroke(); break;
    case 'diamond': poly(g, 4, r, -Math.PI / 2); g.fill(); g.stroke(); break;
    case 'hex': poly(g, 6, r, 0); g.fill(); g.stroke(); break;
    case 'star': poly(g, 5, r, -Math.PI / 2, 0.45); g.fill(); g.stroke(); break;
    // A table-cut brooch, not a soft hexagon — `shield` is the other broad
    // six-ish blob in the common tier.
    case 'gem':
      g.beginPath();
      g.moveTo(-r * 0.5, -r * 0.62); g.lineTo(r * 0.5, -r * 0.62);
      g.lineTo(r, -r * 0.1); g.lineTo(0, r); g.lineTo(-r, -r * 0.1);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(-r, -r * 0.1); g.lineTo(r, -r * 0.1);
      g.moveTo(-r * 0.5, -r * 0.62); g.lineTo(-r * 0.16, -r * 0.1);
      g.moveTo(r * 0.5, -r * 0.62); g.lineTo(r * 0.16, -r * 0.1);
      g.stroke(); break;
    case 'monolith':
      g.fillRect(-r * 0.45, -r, r * 0.9, r * 2); g.strokeRect(-r * 0.45, -r, r * 0.9, r * 2); break;
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
    case 'drop': case 'polyp':
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
      g.beginPath(); g.moveTo(0, r); g.lineTo(0, -r); g.stroke(); break;
    case 'plume':
      for (let i = -1; i <= 1; i++) {
        g.save(); g.translate(0, r * 0.78); g.rotate(i * 0.62);
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(r * 0.4, -r * 0.85, 0, -r * 1.5);
        g.quadraticCurveTo(-r * 0.4, -r * 0.85, 0, 0); g.fill(); g.stroke(); g.restore();
      }
      break;
    case 'shield': case 'pauldron':
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.8, -r * 0.5); g.lineTo(r * 0.6, r * 0.6);
      g.lineTo(0, r); g.lineTo(-r * 0.6, r * 0.6); g.lineTo(-r * 0.8, -r * 0.5);
      g.closePath(); g.fill(); g.stroke(); break;
    case 'cell':
      g.fillRect(-r * 0.55, -r * 0.8, r * 1.1, r * 1.6);
      g.strokeRect(-r * 0.55, -r * 0.8, r * 1.1, r * 1.6);
      g.fillRect(-r * 0.2, -r, r * 0.4, r * 0.25); break;
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
    default: poly(g, 4, r, 0); g.fill(); g.stroke();
  }
}
