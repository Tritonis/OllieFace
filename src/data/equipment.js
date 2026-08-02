/**
 * Equipment — the active Q slot.
 *
 * Items are passive and stack; equipment is the opposite of both. You hold
 * exactly one, it does nothing until you press the key, and picking up a second
 * one drops the first. That single difference is what the whole tier exists for:
 * items make the run better on a curve, equipment gives the player one loud
 * button to spend at the moment of their choosing.
 *
 * Shape: `{ id, name, tier, glyph, flavour, description(), cooldown, use(api) }`
 *
 *   cooldown   seconds, before Fuel Cell / cooldown items scale it. The floor is
 *              deliberately high (18s+) — an active that can be held down is a
 *              primary attack with extra steps.
 *   use(api)   fires the effect. Returns `false` to *refuse* the activation (no
 *              target, nothing to do), which refunds the cooldown rather than
 *              burning it. Everything else is treated as a successful use.
 *
 * `api` is the same object item hooks receive — `{ ctx, items, combat, player,
 * count, procDepth, roll, rng }` — so equipment shares the proc-depth
 * accounting and the damage helpers with the item table instead of inventing a
 * parallel set. An equipment nuke is a player-sourced hit like any other: it
 * procs items, it feeds the chain, and it is bounded by the same depth budget.
 *
 * **Authority.** `Items.useEquipment` gates the whole path on `ctx.authority`
 * before any of this runs, so nothing below re-checks it except where it moves
 * a monster (which is state a client must not touch even cosmetically).
 * VFX and audio inside a `use` therefore only ever play on the machine that
 * resolved it; that is the same trade every other host-authoritative effect in
 * the game makes, and it is why the durable ones below also emit a bus event.
 *
 * **Stacking.** Equipment does not stack — you hold one. What *does* scale is
 * the cooldown (via `equipCooldownMult` on the stat block, fed by Fuel Cell and
 * friends) and the charge count (`extraCharges`). Every card below therefore
 * declares a flat, non-scaling effect and says so in its description; that is
 * the tier's stacking rule and it lives in `Items.js` like all the others.
 */

import * as THREE from 'three';
import { chainLightning, seekingStrike, nearbyHostiles } from './items.js';

// Scratch vectors. Equipment fires at human rates, not per-frame, but the
// allocation-free idiom is the house style and a blink that runs during a
// horde should not be the thing that trips a GC pause.
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _sky = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** How long a duration-style equipment effect runs, in seconds. */
const BUFF = { stim: 8, veil: 6, drone: 18, lantern: 12, crown: 10, aegis: 8 };

/**
 * Recall Beacon's anchor lifetime, in seconds. Long enough to plant before a
 * fight and use during it; far shorter than a stage, so an anchor can never
 * outlive the terrain whose coordinates it holds.
 */
const RECALL_LIFE = 60;
/** Aegis Emitter's footprint and the armour it is worth to stand in it. */
const AEGIS_RADIUS = 10;
const AEGIS_ARMOR = 30;

export const EQUIPMENT = [
  {
    id: 'blink-anchor', name: 'Blink Anchor', tier: 'equipment', glyph: 'blink',
    flavour: 'The distance is still there. You just stop attending it.',
    cooldown: 18,
    description: () => 'Teleport 22m in the direction you are facing.',
    use: (api) => {
      const p = api.player;
      const ctx = api.ctx;
      // Aim comes off the camera, not the pawn yaw: the player is looking at
      // where they want to be, and a third-person survivor's facing lags the
      // lens by up to a quarter turn while strafing.
      ctx.camera.getWorldDirection(_dir);
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-6) return false;
      _dir.normalize();

      const from = p.position.clone();
      // Step out in increments and keep the last point that is above ground
      // rather than trusting one long raycast: the blink has to *end* on the
      // terrain, and a single cast that clears a ridge lands the player inside
      // the far side of it. Bailing on a >4m step up is what makes a cliff a
      // wall instead of a shortcut through it.
      _to.copy(from);
      let travelled = 0;
      for (let d = 2; d <= 22; d += 2) {
        const x = from.x + _dir.x * d, z = from.z + _dir.z * d;
        const y = ctx.stage?.sampleHeight?.(x, z);
        if (!Number.isFinite(y) || y - _to.y > 4) break;
        _to.set(x, y + 0.1, z);
        travelled = d;
      }
      if (travelled < 2) return false;

      ctx.vfx?.burst?.(from, 0x9ad8ff);
      ctx.vfx?.beam?.(from, _to, 0x9ad8ff);
      p.position.copy(_to);
      p.velocity?.set?.(0, 0, 0);
      ctx.vfx?.burst?.(_to, 0x9ad8ff);
      ctx.audio?.play?.('ability', _to, 2);
      return true;
    },
  },
  {
    id: 'mending-flare', name: 'Mending Flare', tier: 'equipment', glyph: 'flare',
    flavour: 'Burns bright, burns short, and puts you back together on the way.',
    cooldown: 40,
    description: () => 'Instantly heal 50% of maximum health and gain a barrier worth another 25%.',
    use: (api) => {
      const p = api.player;
      const max = p.stats?.maxHealth || 100;
      api.combat.heal(p, max * 0.5);
      api.items.addBarrier(max * 0.25);
      api.ctx.vfx?.ring?.(p.position, 6, 0x8bffbe);
      api.ctx.vfx?.healPop?.(p.position, Math.round(max * 0.5));
      api.ctx.audio?.play?.('heal', p.position);
      return true;
    },
  },
  {
    id: 'thermal-lance', name: 'Thermal Lance', tier: 'equipment', glyph: 'lance',
    flavour: 'A mining tool. The manual is very clear about that.',
    cooldown: 26,
    description: () => 'Bore a searing lance through up to 5 enemies for 1400% damage each, igniting them.',
    use: (api) => {
      const hit = seekingStrikeCount(api, api.player.position,
        api.items.baseDamage() * 14, 5, 0xffb347, 'lance');
      if (!hit) return false;
      api.ctx.pipeline?.addShake?.(0.35);
      api.ctx.audio?.play?.('explosion', api.player.position, 6);
      return true;
    },
  },
  {
    id: 'gravity-snare', name: 'Gravity Snare', tier: 'equipment', glyph: 'snare',
    flavour: 'Everything within twenty metres agrees to be somewhere else.',
    cooldown: 34,
    description: () => 'Drag every enemy within 22m to your reticle and slow them for 5s.',
    use: (api) => {
      const at = api.player.position.clone();
      const targets = nearbyHostiles(api, at, 22);
      if (!targets.length) return false;
      if (api.ctx.authority) {
        for (const t of targets) {
          if (t.isBoss) continue;             // bosses are not furniture
          t.position.lerp(at, 0.7);
          t.velocity?.set?.(0, 0, 0);
          api.combat.applyStatus(t, 'slow', api.player, 2);
        }
      }
      api.ctx.vfx?.ring?.(at, 22, 0x9b5cff);
      api.ctx.vfx?.burst?.(at, 0x9b5cff);
      api.ctx.audio?.play?.('zap', at);
      return true;
    },
  },
  {
    id: 'sentry-drone', name: 'Sentry Drone', tier: 'equipment', glyph: 'drone',
    flavour: 'Loyal, stupid, and armed.',
    cooldown: 45,
    description: () => `Deploy a drone for ${BUFF.drone}s that strikes a nearby enemy for 300% damage twice a second.`,
    // Implemented as a timed effect on Items rather than as an entity: the
    // drone has no collision, no pathing and no health, so an Enemy-shaped
    // object for it would be a rig and a snapshot slot bought for a beam.
    use: (api) => {
      api.items.addEffect('sentry-drone', BUFF.drone, 0.5, (a) => {
        seekingStrike(a, a.player.position, a.items.baseDamage() * 3, 1, 0xffd08a, 'sentry');
      });
      api.ctx.vfx?.burst?.(api.player.position, 0xffd08a);
      api.ctx.audio?.play?.('ability', api.player.position, 1);
      return true;
    },
  },
  {
    id: 'overload-cell', name: 'Overload Cell', tier: 'equipment', glyph: 'overload',
    flavour: 'The safety interlock was removed by a previous owner.',
    cooldown: 30,
    description: () => 'Detonate a 16m nova for 1100% damage that stuns everything caught in it.',
    use: (api) => {
      const at = api.player.position;
      api.combat.explode(at, 16, api.items.baseDamage() * 11, api.player, {
        team: 'player', proc: 0.6, procDepth: api.procDepth, type: 'overload', status: 'shock',
      });
      api.ctx.vfx?.explosion?.(at, 12, 0xffd76a);
      api.ctx.pipeline?.addShake?.(0.7);
      api.ctx.hitstop = Math.max(api.ctx.hitstop || 0, 0.07);
      return true;
    },
  },
  {
    id: 'frostbite-canister', name: 'Frostbite Canister', tier: 'equipment', glyph: 'canister',
    flavour: 'Cryogenic. Handle with the gloves you did not bring.',
    cooldown: 50,
    description: () => 'Freeze every enemy within 26m for 4s. Frozen enemies take 35% more damage.',
    use: (api) => {
      const at = api.player.position;
      const targets = nearbyHostiles(api, at, 26);
      if (!targets.length) return false;
      for (const t of targets) api.combat.applyStatus(t, 'freeze', api.player, 2);
      api.ctx.vfx?.ring?.(at, 26, 0x9fe8ff);
      api.ctx.vfx?.burst?.(at, 0xd8f6ff);
      api.ctx.audio?.play?.('shieldBreak', at);
      return true;
    },
  },
  {
    id: 'stim-injector', name: 'Combat Stim', tier: 'equipment', glyph: 'stim',
    flavour: 'Eight good seconds and a bill that comes due later.',
    cooldown: 32,
    description: () => `+150% attack speed and +50% movement speed for ${BUFF.stim}s.`,
    use: (api) => {
      // Rides the existing `berzerk` buff so the stat pipeline needs no new
      // case — one buff name, one place it is folded into the block.
      api.items.addBuff('berzerk', BUFF.stim, 1, 0.5);
      api.items.addBuff('frenzy', BUFF.stim, 3, 0.5);
      api.ctx.vfx?.burst?.(api.player.position, 0xff7a5a);
      api.ctx.audio?.play?.('ability', api.player.position, 3);
      return true;
    },
  },
  {
    id: 'phase-veil', name: 'Phase Veil', tier: 'equipment', glyph: 'veil',
    flavour: 'Briefly, convincingly, not there.',
    cooldown: 55,
    description: () => `Become untouchable for ${BUFF.veil}s and move 30% faster.`,
    use: (api) => {
      const p = api.player;
      // Combat gates on `_iframeUntil` directly, which is exactly the hook the
      // harness uses to make a capture survivable — so this is the supported
      // way to be invulnerable rather than a second mechanism for it.
      p._iframeUntil = Math.max(p._iframeUntil || 0, (api.ctx.time || 0) + BUFF.veil);
      api.items.addBuff('berzerk', BUFF.veil, 1, 0.3);
      api.ctx.vfx?.burst?.(p.position, 0xc8b4ff);
      api.ctx.vfx?.ring?.(p.position, 4, 0xc8b4ff);
      api.ctx.audio?.play?.('ability', p.position, 2);
      return true;
    },
  },
  {
    id: 'spirit-lantern', name: 'Spirit Lantern', tier: 'equipment', glyph: 'lantern',
    flavour: 'It keeps what it collects, and it is generous with the interest.',
    cooldown: 48,
    description: () => `For ${BUFF.lantern}s, release 3 vengeful spirits every second dealing 180% damage.`,
    use: (api) => {
      api.items.addEffect('spirit-lantern', BUFF.lantern, 1.0, (a) => {
        seekingStrike(a, a.player.position, a.items.baseDamage() * 1.8, 3, 0xa8ffe0, 'spirit');
      });
      api.ctx.vfx?.ring?.(api.player.position, 5, 0xa8ffe0);
      api.ctx.audio?.play?.('ability', api.player.position, 0);
      return true;
    },
  },
  {
    id: 'meteor-beacon', name: 'Meteor Beacon', tier: 'equipment', glyph: 'meteor',
    flavour: 'Painted the sky orange for four seconds. Worth it.',
    cooldown: 60,
    description: () => 'Call down 8 meteors over 4s, each blasting for 600% damage in a 7m radius.',
    use: (api) => {
      api.items.addEffect('meteor-beacon', 4, 0.5, (a) => {
        const target = a.combat.nearestHostile(a.player.position, 45, 'player', null);
        const at = target ? target.position : a.player.position;
        // The tracer starts 40m overhead so the blast reads as arriving from
        // the sky rather than appearing on the ground.
        a.ctx.vfx?.missile?.(_sky.set(at.x, at.y + 40, at.z), at, 0xff8a20);
        a.combat.explode(at, 7, a.items.baseDamage() * 6, a.player, {
          team: 'player', proc: 0.5, procDepth: a.procDepth, type: 'meteor', status: 'burn',
        });
        a.ctx.pipeline?.addShake?.(0.25);
      });
      api.ctx.audio?.play?.('boss', api.player.position);
      return true;
    },
  },
  {
    id: 'tesla-crown', name: 'Tesla Crown', tier: 'equipment', glyph: 'crown',
    flavour: 'Wear it. Do not touch anyone.',
    cooldown: 42,
    description: () => `For ${BUFF.crown}s, arc chain lightning through 5 enemies every 0.4s for 250% damage.`,
    use: (api) => {
      api.items.addEffect('tesla-crown', BUFF.crown, 0.4, (a) => {
        const target = a.combat.nearestHostile(a.player.position, 26, 'player', null);
        if (!target) return;
        chainLightning(a, { position: a.player.position, entity: a.player },
          a.items.baseDamage() * 2.5, 5);
        a.ctx.vfx?.beam?.(a.player.position, target.position, 0x9fd8ff);
      });
      api.ctx.audio?.play?.('zap', api.player.position);
      return true;
    },
  },
  {
    id: 'recall-beacon', name: 'Recall Beacon', tier: 'equipment', glyph: 'beacon',
    flavour: 'Leave a mark on the world. The world will hold you to it.',
    cooldown: 24,
    description: () => `Press with no beacon planted to plant one, free. Press again within ${RECALL_LIFE}s to return to it and heal 25%.`,
    /**
     * The only two-state card in the tier, and the reason it is worth having.
     * Every other equipment is a button that does a thing; this one is a
     * *decision made in advance* — you plant on the safe ledge before you drop
     * into the pit, and the value of the press is decided by where you were
     * standing a minute ago rather than by where you are now.
     *
     * Planting deliberately returns `false`. `Items.useEquipment` treats that as
     * a refusal and refunds the charge, so the plant costs nothing and only the
     * recall pays the cooldown — which is the right price, because the plant is
     * the part with no immediate effect and charging for it would make the card
     * feel like it did nothing half the time it was pressed.
     */
    use: (api) => {
      const p = api.player;
      const ctx = api.ctx;
      const now = ctx.time || 0;
      const anchor = p._recallAnchor;

      // No live anchor: plant one. The stamp bounds staleness — an anchor is a
      // set of coordinates and nothing else, and a stage transition rebuilds the
      // terrain under them, so an anchor that outlived the stage it was planted
      // on would recall the survivor to a point that no longer means anything.
      // A minute is long enough to cross an arena and far shorter than a stage.
      if (!anchor || now - anchor.t > RECALL_LIFE) {
        p._recallAnchor = { at: p.position.clone(), t: now };
        ctx.vfx?.rings?.spawn?.(p.position, _up, 0x7ad8ff, 0.3, 2.6, 0.45, 0.9);
        ctx.vfx?.burst?.(p.position, 0x7ad8ff);
        ctx.audio?.play?.('ability', p.position, 1);
        return false;
      }

      // Recall. The destination is re-sampled against the height field rather
      // than trusted: the survivor may have planted mid-jump, and a stored Y
      // that was 6 m of air is a fall the player did not ask for.
      _to.copy(anchor.at);
      const y = ctx.stage?.sampleHeight?.(_to.x, _to.z);
      if (Number.isFinite(y)) _to.y = Math.max(_to.y, y + 0.1);

      const from = p.position.clone();
      ctx.vfx?.burst?.(from, 0x7ad8ff);
      ctx.vfx?.beam?.(from, _to, 0x7ad8ff);
      p.position.copy(_to);
      p.velocity?.set?.(0, 0, 0);
      p._recallAnchor = null;
      api.combat.heal(p, (p.stats?.maxHealth || 100) * 0.25);
      ctx.vfx?.burst?.(_to, 0x7ad8ff);
      ctx.vfx?.healPop?.(_to, Math.round((p.stats?.maxHealth || 100) * 0.25));
      ctx.audio?.play?.('ability', _to, 2);
      return true;
    },
  },
  {
    id: 'aegis-emitter', name: 'Aegis Emitter', tier: 'equipment', glyph: 'aegis',
    flavour: 'A ten-metre opinion about who is allowed to move quickly.',
    cooldown: 38,
    description: () => `Drop a ${AEGIS_RADIUS}m dome for ${BUFF.aegis}s. Enemies inside it are slowed; while you stand inside it you gain +${AEGIS_ARMOR} armor.`,
    /**
     * The tier's only *positional* card. Every other durable equipment here
     * (drone, lantern, crown) follows the player, which means holding it changes
     * nothing about where they choose to stand. This one is nailed to the ground
     * at the moment of the press, so its whole value is the player agreeing to
     * fight in one place for eight seconds — which is a real cost in a game
     * whose entire defensive vocabulary is movement.
     *
     * Built out of `addEffect` rather than as an entity for the same reason
     * Sentry Drone is: it has no collision, no health and no pathing, so an
     * Enemy-shaped object for it would be a rig and a snapshot slot bought for
     * an overlap query.
     */
    use: (api) => {
      const at = api.player.position.clone();
      api.items.addEffect('aegis-emitter', BUFF.aegis, 0.5, (a) => {
        for (const t of nearbyHostiles(a, at, AEGIS_RADIUS)) {
          a.combat.applyStatus(t, 'slow', a.player, 1);
        }
        // Re-granted every half second rather than once for the duration: the
        // buff has to lapse the moment the survivor steps out of the dome, and
        // a short buff refreshed while inside expires on its own with no
        // enter/exit bookkeeping to get wrong.
        if (a.player.position.distanceTo(at) <= AEGIS_RADIUS) {
          a.player.grantBuff?.({ armor: AEGIS_ARMOR }, 0.7);
        }
        a.ctx.vfx?.ring?.(at, AEGIS_RADIUS, 0x8fd8ff);
      });
      api.ctx.vfx?.rings?.spawn?.(at, _up, 0x8fd8ff, 0.4, AEGIS_RADIUS, 0.6, 0.9);
      api.ctx.vfx?.burst?.(at, 0xbfe8ff);
      api.ctx.audio?.play?.('shieldBreak', at);
      return true;
    },
  },
];

/**
 * `seekingStrike` with a hit count back, so an equipment that has nothing to
 * shoot can refuse the activation instead of eating its own cooldown.
 */
function seekingStrikeCount(api, from, damage, count, colour, type) {
  const before = api.combat.nearestHostile(from, 40, 'player', null);
  if (!before) return 0;
  seekingStrike(api, from, damage, count, colour, type);
  return 1;
}

export const EQUIPMENT_BY_ID = new Map(EQUIPMENT.map((e) => [e.id, e]));
export const EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);
