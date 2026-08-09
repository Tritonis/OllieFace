import * as THREE from 'three';

/**
 * Combat is the single damage authority. Every point of damage in the game —
 * bullets, explosions, burn ticks, item procs — funnels through applyDamage so
 * crit, armor, shields and the proc chain are resolved in exactly one place.
 *
 * The proc chain is the heart of the RoR2 power fantasy: a hit fires item
 * hooks, those hooks deal damage, that damage fires item hooks again. Left
 * unbounded a single shot can crash the frame, so every hit carries a
 * `procCoefficient` (how strongly it triggers items) and a `procDepth`
 * (how many chain links deep we already are). Depth is hard-capped and the
 * whole step shares a dispatch budget.
 */

const CELL = 8;              // spatial hash cell size, metres
const MAX_PROC_DEPTH = 3;    // a proc's proc's proc cannot proc
const PROC_BUDGET = 512;     // hook dispatches per fixed step, a hard circuit breaker
const HIT_POOL = 64;
const OVERLAP_POOL = 256;
const CANDIDATE_POOL = 256;

// Status tuning. `stackDamage` is a fraction of the source's damage stat per
// tick, so DoT scales with the attacker rather than with the victim's health.
const STATUS_DEFS = {
  burn: { duration: 4.0, tick: 0.5, stackDamage: 0.25, colour: 0xff7a2a },
  bleed: { duration: 3.0, tick: 0.4, stackDamage: 0.35, colour: 0xd0203a },
  slow: { duration: 2.0, tick: 0, magnitude: 0.4, colour: 0x5ad2ff },
  freeze: { duration: 1.6, tick: 0, magnitude: 1.0, colour: 0x9fe8ff },
  shock: { duration: 1.4, tick: 0.25, stackDamage: 0.15, colour: 0xc9b5ff },
};

// How many stacks of one damage-over-time type may sit on the survivor at
// once. Monsters are uncapped. This is a balance number, not a correctness
// one: at 8 (the steady state an aura reaches unaided) a blazing elite kills
// a full-health survivor through the rider alone.
const PLAYER_DOT_STACK_CAP = 3;

export class Combat {
  constructor() {
    this.entities = [];
    this.cells = new Map();          // hash key -> array of entities
    this.statuses = new Map();       // entity -> array of active status instances

    // Pools. Query results are valid only until the next query of the same
    // kind — callers must consume them before calling back into Combat.
    this._hitPool = [];
    for (let i = 0; i < HIT_POOL; i++) {
      this._hitPool.push({ entity: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, isWorld: false });
    }
    this._hits = [];
    this._overlap = new Array(OVERLAP_POOL);
    this._overlapCount = 0;
    this._cand = new Array(CANDIDATE_POOL);
    // Largest radius in the registry, so a broadphase can size its search by
    // the biggest thing that could reach into it. Radii come from spawn cards,
    // not from a constant, so this is measured rather than assumed.
    this._maxEntityRadius = 0;

    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    this._procBudget = PROC_BUDGET;
    // Target snapshots are taken per nesting level: an explosion's damage can
    // trigger an item that explodes again, and the inner call must not clobber
    // the list the outer one is still walking.
    this._scratch = [[], [], [], [], [], []];
    this._scratchDepth = 0;
  }

  _pushScratch() {
    const d = Math.min(this._scratchDepth++, this._scratch.length - 1);
    const arr = this._scratch[d];
    arr.length = 0;
    return arr;
  }

  _popScratch(arr) {
    arr.length = 0;
    this._scratchDepth = Math.max(0, this._scratchDepth - 1);
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.combat = this;
    this.MAX_PROC_DEPTH = MAX_PROC_DEPTH;
  }

  // ---------------------------------------------------------------- registry

  register(entity) {
    if (entity._combatIndex !== undefined && this.entities[entity._combatIndex] === entity) return entity;
    entity._combatIndex = this.entities.length;
    entity._cellKey = null;
    // A unit spawned after this step's reindex has to widen the broadphase
    // immediately; the reindex will re-measure the whole registry next step.
    const r = entity.radius || 0.5;
    if (r > this._maxEntityRadius) this._maxEntityRadius = r;
    entity._iframeUntil = 0;
    this.entities.push(entity);
    this._insert(entity);
    return entity;
  }

  unregister(entity) {
    const i = entity._combatIndex;
    if (i === undefined || this.entities[i] !== entity) return;
    this._removeFromCell(entity);
    const last = this.entities.pop();
    if (last !== entity) {
      this.entities[i] = last;
      last._combatIndex = i;
    }
    entity._combatIndex = undefined;
    this.statuses.delete(entity);
  }

  _key(x, z) {
    // Offset keeps negative coordinates from colliding with positive ones.
    return ((Math.floor(x / CELL) + 4096) << 13) | (Math.floor(z / CELL) + 4096);
  }

  _insert(entity) {
    const key = this._key(entity.position.x, entity.position.z);
    entity._cellKey = key;
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = []; this.cells.set(key, bucket); }
    bucket.push(entity);
  }

  _removeFromCell(entity) {
    const bucket = this.cells.get(entity._cellKey);
    if (!bucket) return;
    const i = bucket.indexOf(entity);
    if (i >= 0) { bucket[i] = bucket[bucket.length - 1]; bucket.pop(); }
  }

  _reindex(entity) {
    const key = this._key(entity.position.x, entity.position.z);
    if (key === entity._cellKey) return;
    this._removeFromCell(entity);
    this._insert(entity);
  }

  // ------------------------------------------------------------------ update

  fixedUpdate(ctx, h) {
    this._procBudget = PROC_BUDGET;

    let maxR = 0;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      const r = e.radius || 0.5;
      if (r > maxR) maxR = r;
      if (!e.alive) continue;
      this._reindex(e);
    }
    this._maxEntityRadius = maxR;

    this._tickStatuses(ctx, h);
  }

  // --------------------------------------------------------------- broadphase

  /**
   * Fills the shared overlap buffer with living entities of a hostile team
   * whose capsule intersects the sphere. Returns the count; read results with
   * `overlapAt(i)`. Avoids allocating an array per explosion.
   */
  sphereOverlap(point, radius, team) {
    this._overlapCount = 0;
    const minX = Math.floor((point.x - radius) / CELL);
    const maxX = Math.floor((point.x + radius) / CELL);
    const minZ = Math.floor((point.z - radius) / CELL);
    const maxZ = Math.floor((point.z + radius) / CELL);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(((cx + 4096) << 13) | (cz + 4096));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (!e.alive) continue;
          if (team && e.team === team) continue;
          const r = radius + (e.radius || 0.5);
          // Compare against the capsule centre so tall enemies aren't missed
          // by a blast that lands at their feet.
          const cy = e.position.y + (e.height || 1.8) * 0.5;
          const dx = e.position.x - point.x;
          const dy = cy - point.y;
          const dz = e.position.z - point.z;
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          if (this._overlapCount < OVERLAP_POOL) this._overlap[this._overlapCount++] = e;
        }
      }
    }
    return this._overlapCount;
  }

  overlapAt(i) { return this._overlap[i]; }

  /** The largest radius currently registered — the reach of the biggest unit. */
  get maxEntityRadius() { return this._maxEntityRadius; }

  /**
   * Broadphase for a caller that has to reproduce a full-registry scan exactly.
   * Fills the shared candidate buffer with every registered entity bucketed
   * near the point and returns the count; read results with `candidateAt(i)`.
   *
   * Deliberately unlike `sphereOverlap`: nothing is filtered — not liveness,
   * not team, not distance — because the caller's accept test is the one that
   * has to stay bit-identical, and this must not apply a second, subtly
   * different one. Results arrive in bucket order, which is insertion order
   * with swap-removal and therefore NOT `entities` order, so a caller whose
   * answer depends on registry order must re-derive it from `_combatIndex`.
   *
   * Returns -1 when more entities are bucketed nearby than the buffer holds:
   * there is no correct truncation of an exhaustive query, so the caller has to
   * scan the registry itself.
   *
   * Cells are widened by one on each side, as the hitscan queries are. The hash
   * is only reindexed at the top of the fixed step, so an entity that has moved
   * since is still found under its stale key — a whole cell of slack against a
   * step's worth of travel.
   */
  candidatesNear(point, radius) {
    const minX = Math.floor((point.x - radius) / CELL) - 1;
    const maxX = Math.floor((point.x + radius) / CELL) + 1;
    const minZ = Math.floor((point.z - radius) / CELL) - 1;
    const maxZ = Math.floor((point.z + radius) / CELL) + 1;
    let n = 0;
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(((cx + 4096) << 13) | (cz + 4096));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          if (n >= CANDIDATE_POOL) return -1;
          this._cand[n++] = bucket[i];
        }
      }
    }
    return n;
  }

  candidateAt(i) { return this._cand[i]; }

  /** Nearest living hostile within `radius`, or null. Used by chain lightning. */
  nearestHostile(point, radius, team, exclude) {
    const n = this.sphereOverlap(point, radius, team);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const e = this._overlap[i];
      if (e === exclude) continue;
      if (exclude && Array.isArray(exclude) && exclude.includes(e)) continue;
      const d = e.position.distanceToSquared(point);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // ------------------------------------------------------------------ hitscan

  /**
   * Resolves a ray against stage geometry and registered entities. Returns a
   * pooled array of hits sorted near-to-far, truncated at the world surface
   * unless `pierce` lets it through. The array and its entries are reused on
   * the next hitscan — apply damage before scanning again.
   */
  hitscan(origin, dir, maxDist, opts = {}) {
    const { damage = 0, source = null, team = null, pierce = 0, falloff = 0, proc = 1, type = 'hitscan' } = opts;
    this._hits.length = 0;

    // World geometry first: it caps how far entity hits can count.
    let limit = maxDist;
    const world = this.ctx.stage?.raycast?.(origin, dir, maxDist) || null;

    const minX = Math.floor(Math.min(origin.x, origin.x + dir.x * maxDist) / CELL) - 1;
    const maxX = Math.floor(Math.max(origin.x, origin.x + dir.x * maxDist) / CELL) + 1;
    const minZ = Math.floor(Math.min(origin.z, origin.z + dir.z * maxDist) / CELL) - 1;
    const maxZ = Math.floor(Math.max(origin.z, origin.z + dir.z * maxDist) / CELL) + 1;

    if (world) limit = Math.min(limit, world.distance);

    let poolIdx = 0;
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(((cx + 4096) << 13) | (cz + 4096));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (!e.alive || e === source) continue;
          if (team && e.team === team) continue;
          const t = this._raySphere(origin, dir, e, limit);
          if (t < 0) continue;
          if (poolIdx >= HIT_POOL) continue;
          const hit = this._hitPool[poolIdx++];
          hit.entity = e;
          hit.isWorld = false;
          hit.distance = t;
          hit.point.copy(dir).multiplyScalar(t).add(origin);
          hit.normal.copy(origin).sub(hit.point).normalize();
          this._hits.push(hit);
        }
      }
    }

    this._hits.sort(sortByDistance);

    // A pierce budget of N lets the shot pass through N bodies; the rest of
    // the list is discarded so callers can just iterate what they're given.
    const allowed = pierce + 1;
    if (this._hits.length > allowed) this._hits.length = allowed;

    if (world && poolIdx < HIT_POOL) {
      const wh = this._hitPool[poolIdx++];
      wh.entity = null;
      wh.isWorld = true;
      wh.distance = world.distance;
      wh.point.copy(world.point);
      wh.normal.copy(world.normal);
      this._hits.push(wh);
    }

    // Damage is applied inline against the pooled hits. That is only safe
    // because no item hook performs a hitscan — procs explode, chain or apply
    // status, all of which use the separate overlap path.
    if (damage > 0) {
      for (let i = 0; i < this._hits.length; i++) {
        const hit = this._hits[i];
        if (!hit.entity) continue;
        const scale = falloff > 0 ? Math.max(1 - (hit.distance / maxDist) * falloff, 0.2) : 1;
        this.applyDamage(hit.entity, damage * scale, {
          source, procCoefficient: proc, procDepth: 0, position: hit.point, type,
        });
      }
    }

    return this._hits;
  }

  // Ray vs vertical capsule approximated as a sphere at capsule centre; enemy
  // hitboxes are chunky enough that the difference is invisible and this keeps
  // the inner loop branch-free.
  /**
   * Distance to the first hostile body along a ray, or -1.
   *
   * Exists for aim convergence, not for damage: `Player.aimRay` needs to know
   * how far away the thing under the crosshair actually is, and the only other
   * ray query in the engine is `hitscan`, which cannot be borrowed for it. That
   * one writes into `_hits` and `_hitPool`, both of which are reused in place
   * and are live between a shot's scan and its damage application — calling it
   * speculatively once a frame would hand the shot a clobbered hit list.
   *
   * So this walks the same cells with the same sphere test and returns one
   * number, touching no shared buffer.
   */
  probeDistance(origin, dir, maxDist, team = null, exclude = null) {
    let best = -1;
    const minX = Math.floor(Math.min(origin.x, origin.x + dir.x * maxDist) / CELL) - 1;
    const maxX = Math.floor(Math.max(origin.x, origin.x + dir.x * maxDist) / CELL) + 1;
    const minZ = Math.floor(Math.min(origin.z, origin.z + dir.z * maxDist) / CELL) - 1;
    const maxZ = Math.floor(Math.max(origin.z, origin.z + dir.z * maxDist) / CELL) + 1;

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(((cx + 4096) << 13) | (cz + 4096));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (!e.alive || e === exclude) continue;
          if (team && e.team === team) continue;
          const t = this._raySphere(origin, dir, e, maxDist);
          if (t < 0) continue;
          if (best < 0 || t < best) best = t;
        }
      }
    }
    return best;
  }

  _raySphere(origin, dir, e, limit) {
    const r = (e.radius || 0.5) * 1.15;
    const cy = e.position.y + (e.height || 1.8) * 0.5;
    const ox = origin.x - e.position.x;
    const oy = origin.y - cy;
    const oz = origin.z - e.position.z;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    if (c > 0 && b > 0) return -1;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const t = -b - Math.sqrt(disc);
    if (t < 0 || t > limit) return -1;
    return t;
  }

  // ---------------------------------------------------------------- explosion

  explode(point, radius, damage, source, opts = {}) {
    const { falloff = true, team = source?.team || null, proc = 0.7, procDepth = 0, type = 'blast', status = null } = opts;
    const n = this.sphereOverlap(point, radius, team);
    // Snapshot: applyDamage can spawn more explosions and clobber the buffer.
    const targets = this._pushScratch();
    for (let i = 0; i < n; i++) targets.push(this._overlap[i]);

    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      let amount = damage;
      if (falloff) {
        const d = Math.sqrt(e.position.distanceToSquared(point));
        amount *= Math.max(0.35, 1 - d / radius);
      }
      // `status` rides along for presentation only — `applyStatus` below is
      // still the thing that applies it. Without this the blast that lights a
      // burn colours its own spark correctly (its `type` is real) but has no
      // way to tell the tick sparks that follow what family they belong to.
      this.applyDamage(e, amount, { source, procCoefficient: proc, procDepth, position: point, type, status });
      if (status) this.applyStatus(e, status, source, 1);
    }
    this._popScratch(targets);
    this.ctx.vfx?.explosion?.(point, radius);
    this.ctx.audio?.play?.('explosion', point);
    return n;
  }

  // ------------------------------------------------------------------ damage

  /**
   * The one path. `info` carries:
   *   source           attacker entity (for kill credit and DoT attribution)
   *   procCoefficient  0..1+, how strongly this hit triggers items (0 = silent)
   *   procDepth        chain link index; hooks must pass depth+1
   *   crit             force crit/no-crit, otherwise rolled from stats
   *   position         impact point for VFX and floating numbers
   *   ignoreArmor      true for true-damage effects like Shrine of Blood
   *
   * Returns the damage the hit landed for after crit, items and armour — the
   * same figure it puts on the `damage` event as `amount`, including anything
   * a barrier absorbed. 0 means the hit did not happen at all (i-frames, a
   * block, a dead target, or a client).
   */
  applyDamage(target, amount, info = {}) {
    if (!target || !target.alive || amount <= 0) return 0;
    const ctx = this.ctx;

    // Damage is resolved in exactly one place across the whole session: the
    // host. A client's health comes from snapshot `healthFrac`, and its damage
    // numbers and hit sparks come off the `damage` event the host forwards —
    // both cosmetic, both still fire here as well as there.
    if (!ctx.authority) return 0;

    // i-frames stop a single explosion resolving twice in the same step and
    // give the player a beat of mercy between big hits.
    const now = ctx.time;
    if (!info.isDot && target._iframeUntil > now) return 0;
    if (!info.isDot && target.iframeDuration) target._iframeUntil = now + target.iframeDuration;

    const source = info.source || null;
    const stats = source?.stats || null;

    // Crit. Rolled once per hit, before any multiplier, so the number the
    // player sees on screen is the number that landed.
    let crit = info.crit === true;
    if (info.crit === undefined && stats && !info.isDot) {
      const chance = stats.critChance || 0;
      if (chance > 0 && ctx.rng.next() < chance) crit = true;
    }
    if (crit) amount *= stats?.critMult || 2;

    // Conditional item multipliers (vs full health, airborne, stunned...).
    if (source?.isPlayer && ctx.items) {
      amount = ctx.items.modifyOutgoing(amount, target, info, this);
    }

    // Frozen targets take extra — freeze is meant to be a damage window.
    if (this.hasStatus(target, 'freeze')) amount *= 1.35;

    // Tougher Times: a full negate, rolled before mitigation so the block
    // feedback the player sees is unambiguous.
    if (target.isPlayer && target.stats?.blockChance > 0 && !info.isDot) {
      if (ctx.rng.next() < target.stats.blockChance) {
        ctx.events.emit('blocked', { target, source });
        ctx.vfx?.block?.(info.position || target.position);
        return 0;
      }
    }

    // RoR2 armor: positive armor is diminishing damage reduction, negative
    // armor amplifies, both asymptotic so nothing ever hits zero or infinity.
    const armor = info.ignoreArmor ? 0 : this.armorOf(target);
    if (armor >= 0) amount *= 100 / (100 + armor);
    else amount *= 2 - 100 / (100 - armor);

    // Armor Plate is a flat subtraction after the curve, which is why it is
    // disproportionately strong against swarms of small hits.
    if (target.isPlayer && target.stats?.flatReduction) amount -= target.stats.flatReduction;

    amount = Math.max(1, amount);

    // Shields absorb first and regenerate out of combat (owner's job).
    //
    // A hit produces two quantities and they are not interchangeable:
    // `incoming` is what it was worth on arrival (post-crit, post-armour) and
    // `dealt` is what reached health after a barrier took its cut. Which one a
    // consumer wants depends entirely on whose barrier it was.
    //
    // Attacking side — `incoming`. A hit into a barrier landed; the barrier is
    // the thing it landed on. Reporting `dealt` on the outgoing channels made
    // every point spent breaking an elite's shield read as zero: floating
    // numbers rendered "1", the run counter froze, and the `warded` affix —
    // whose reflect by construction only fires *while* the barrier is up
    // (`Director.js`) — multiplied 0.22 by nothing for its entire window.
    //
    // Defending side — `dealt`. `onDamaged` hooks are the paying customers and
    // a gold-on-hurt item must not mint gold off a barrier; `playerHurt` must
    // not reset "time since hurt" for a hit that cost nothing. Those stay on
    // health lost, and a fully-absorbed hit does not emit `playerHurt` at all.
    //
    // `toHealth`/`absorbed` ride along on `damage` so anything that wants the
    // other figure has it without a second event.
    const incoming = amount;
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, amount);
      target.shield -= absorbed;
      amount -= absorbed;
      // `isPlayer` is true of every remote pawn too, and this channel drives the
      // local camera shake and the local HUD. It has to mean *this client's*
      // survivor, not "a survivor".
      if (target === ctx.player) ctx.events.emit('shieldBroken', { target, remaining: target.shield, absorbed });
    }
    const dealt = amount;

    const pos = info.position || target.position;

    if (amount > 0) {
      if (target.takeDamage) target.takeDamage(amount, info);
      else target.health -= amount;
    }

    ctx.events.emit('damage', {
      target, source, amount: incoming, toHealth: dealt, absorbed: incoming - dealt,
      crit, position: pos, proc: info.procCoefficient || 0,
      // What the hit was, for presentation only. `'hit'` is the same default
      // the proc dispatch below already uses, so an info with no type reads
      // identically on both channels. Nothing in gameplay may key off this:
      // the authority for what a hit *does* is `info`, and this is what it
      // looks like. `status` rides along because most on-hit procs are plain
      // bullets that light something — the colour is the status, not the gun.
      type: info.type || 'hit', status: info.status || null,
    });

    if (target === ctx.player && dealt > 0) {
      // Gated at the emit rather than in each listener. Four systems subscribe
      // and only one of them checked the amount, so a hit a barrier ate whole
      // still reset the hurt timer three items key off, fired a hitstop, an
      // aberration bump and a vignette flash, and ducked the music to a third
      // for 0.7s. `shieldBroken` above is the channel for "a barrier took
      // that"; this one means health was lost.
      //
      // And it is `=== ctx.player`, not `isPlayer`, for the same reason: a
      // remote pawn is `isPlayer`, so a teammate 40 m away losing health used to
      // reset *this* player's "time since hurt" (Field Dressing and Siege
      // Battery both key off it), flash their HUD and duck their music. The
      // `onDamaged` hooks below are the local inventory's and must only be paid
      // for the local survivor's blood.
      ctx.events.emit('playerHurt', { target, amount: dealt, absorbed: incoming - dealt, remaining: target.health });
      if (ctx.items) {
        this._dispatch('onDamaged', { target, source, amount: dealt, position: pos, procDepth: (info.procDepth || 0) + 1 });
      }
    }

    // Proc chain. A hit only fires hooks if it carries coefficient and we are
    // not already too deep; hooks receive depth+1 so their own damage cannot
    // recurse forever.
    const coeff = info.procCoefficient || 0;
    const depth = info.procDepth || 0;
    if (coeff > 0 && depth < MAX_PROC_DEPTH && source?.isPlayer && target.alive) {
      this._dispatch('onHit', {
        target, source, amount: incoming, toHealth: dealt, crit, position: pos,
        procCoefficient: coeff, procDepth: depth + 1, type: info.type || 'hit',
      });
    }

    if (target.health <= 0 && target.alive) this._kill(target, source, pos, depth);

    return incoming;
  }

  _kill(victim, source, position, depth) {
    const ctx = this.ctx;
    victim.alive = false;
    victim.health = 0;
    this.statuses.delete(victim);
    if (victim.onDeath) victim.onDeath();

    ctx.events.emit('kill', {
      victim, source, position, isElite: !!victim.isElite, isBoss: !!victim.isBoss,
    });

    if (victim.isPlayer) {
      // Name the victim. `NetHost` broadcasts this to every client and
      // `sanitise` reduces an entity to `{ netId }`, so the receiver can tell
      // its own death from a teammate's — which is not something a client can
      // infer from its own state, since nothing ever clears `alive` locally
      // (`applyDamage` returns above for a non-authority).
      ctx.events.emit('playerDead', { victim });
      return;
    }

    // Gold. Every monster death pays, not just the ones the player landed the
    // last hit on — burns, proc chains and elite death novas all finish kills,
    // and an income that quietly skipped them would read as the drop table
    // being broken. This is only reachable on the host: applyDamage early-
    // returns for clients, so no client ever mints its own gold.
    ctx.items?.rewardKill?.(victim);

    if (source?.isPlayer && depth < MAX_PROC_DEPTH) {
      this._dispatch('onKill', { victim, source, position, procDepth: depth + 1, procCoefficient: 1 });
    }
  }

  // Every hook dispatch pays into a shared per-step budget. If a legendary
  // stack somehow builds a self-sustaining chain the budget starves it instead
  // of hanging the tab.
  _dispatch(hook, payload) {
    if (this._procBudget <= 0) return;
    this._procBudget--;
    this.ctx.items?.[hook]?.(payload);
  }

  armorOf(entity) {
    if (entity.isPlayer) return entity.stats?.armor || 0;
    let armor = entity.armor || 0;
    // Slow chills armor plating; the debuff is meant to be offensive.
    if (this.hasStatus(entity, 'slow')) armor -= 15;
    return armor;
  }

  // ------------------------------------------------------------------ status

  /** Adds `count` independent stacks. Each stack has its own timer, RoR2-style. */
  applyStatus(entity, type, source, count = 1, overrides = null) {
    const def = STATUS_DEFS[type];
    if (!def || !entity || !entity.alive) return;
    // Uncapped damage-over-time stacks are fine on a monster and a death
    // spiral on the survivor. A blazing aura re-applies every 0.5 s and burn
    // lasts 4.0 s, so one elite parks eight stacks on the player and the
    // rider out-damages the hit that carries it — 73.95 dps against a 110 HP
    // survivor, 5.3x the equal-cost `glacial` affix on the same card.
    // Monsters keep the uncapped RoR2 behaviour; only the player is capped,
    // for the same reason `speedMultiplier` refuses to hand the player a hard
    // zero: a survivor needs the debuff to be survivable and legible.
    if (entity.isPlayer && (def.stackDamage ?? 0) > 0) {
      const live = this.statusStacks(entity, type);
      if (live >= PLAYER_DOT_STACK_CAP) return;
      count = Math.min(count, PLAYER_DOT_STACK_CAP - live);
    }
    let list = this.statuses.get(entity);
    if (!list) { list = []; this.statuses.set(entity, list); }
    const srcDamage = source?.stats?.damage || source?.damage || 12;
    for (let i = 0; i < count; i++) {
      list.push({
        type,
        source,
        remaining: (overrides?.duration ?? def.duration),
        tick: def.tick,
        timer: def.tick,
        // DoT damage is locked in at application time so a later stat change
        // can't retroactively buff burns already on the field.
        damage: srcDamage * (overrides?.stackDamage ?? def.stackDamage ?? 0),
        magnitude: overrides?.magnitude ?? def.magnitude ?? 0,
      });
    }
    this.ctx.vfx?.status?.(entity, type, def.colour);
  }

  hasStatus(entity, type) {
    const list = this.statuses.get(entity);
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (list[i].type === type) return true;
    return false;
  }

  statusStacks(entity, type) {
    const list = this.statuses.get(entity);
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) if (list[i].type === type) n++;
    return n;
  }

  /** Multiplier applied by movers. Freeze wins outright, slows stack down to 25%. */
  speedMultiplier(entity) {
    const list = this.statuses.get(entity);
    if (!list) return 1;
    let mult = 1;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      // A hard zero is the point on a monster — a frozen thing stops. On a
      // player it is a total movement lock with no duration readout and no
      // counterplay, and it also skips the 0.25 floor below that every other
      // status obeys. Nothing in shipping enemy data applies `freeze` to the
      // player yet; this is here so the first card that does is a hard slow and
      // not a stun.
      if (s.type === 'freeze') return entity?.isPlayer ? 0.15 : 0;
      if (s.type === 'slow') mult *= 1 - s.magnitude;
    }
    return Math.max(0.25, mult);
  }

  isStunned(entity) {
    return this.hasStatus(entity, 'freeze') || this.hasStatus(entity, 'shock');
  }

  _tickStatuses(ctx, h) {
    for (const [entity, list] of this.statuses) {
      if (!entity.alive) { this.statuses.delete(entity); continue; }
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        s.remaining -= h;
        if (s.tick > 0 && s.damage > 0) {
          s.timer -= h;
          if (s.timer <= 0) {
            s.timer += s.tick;
            // isDot keeps ticks out of i-frames and out of the crit roll, and
            // procCoefficient 0 stops burns re-triggering the item that lit them.
            this.applyDamage(entity, s.damage, {
              source: s.source, isDot: true, crit: false,
              // `type` stays the status name because items key off it. `status`
              // is the same string on a channel only presentation reads, which
              // is what lets `elementOf` resolve a burn tick to fire instead of
              // falling through to kinetic. Two keys, one value, two audiences.
              procCoefficient: 0, procDepth: MAX_PROC_DEPTH, type: s.type, status: s.type,
            });
            if (!entity.alive) break;
          }
        }
        if (s.remaining <= 0) { list[i] = list[list.length - 1]; list.pop(); }
      }
      if (list.length === 0) this.statuses.delete(entity);
    }
  }

  /** Convenience for items: heal without exceeding max, returns amount healed. */
  heal(entity, amount) {
    if (!entity?.alive || amount <= 0) return 0;
    // The stat block is authoritative where one exists — the player's raw
    // maxHealth field never sees item stacking.
    const max = entity.stats?.maxHealth || entity.maxHealth || 100;
    const before = entity.health;
    entity.health = Math.min(max, entity.health + amount);
    const healed = entity.health - before;
    if (healed > 0) this.ctx.events.emit('heal', { entity, amount: healed });
    return healed;
  }
}

function sortByDistance(a, b) { return a.distance - b.distance; }
