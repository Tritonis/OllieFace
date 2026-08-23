// A deliberately tiny finite state machine.
//
// State tables are module-level constants shared by every instance of an
// archetype — a machine only carries the current state *name*, so switching
// states allocates nothing and 60+ enemies cost one Map-free lookup each.
// Handlers receive `(owner, ctx, h, fsm)` rather than closing over the owner.

export const S = {
  SPAWN: 'spawn',
  IDLE: 'idle',
  CHASE: 'chase',
  CIRCLE: 'circle',
  REPOSITION: 'reposition',
  WINDUP: 'windup',
  ATTACK: 'attack',
  RECOVER: 'recover',
  STAGGER: 'stagger',
  DIE: 'die',
  // Committed straight-line dash. Separate from ATTACK because the unit is
  // steering itself (badly, on purpose) rather than standing still swinging.
  CHARGE: 'charge',
  // Under the terrain: untouchable, unshootable, and closing. The surfacing
  // eruption is a normal WINDUP/ATTACK pair on the other side of it.
  SUBMERGED: 'submerged',
  // Self-rescue. A unit that has made no progress toward its goal for several
  // seconds — wedged in a water channel, pinned in a crevasse — sinks, travels
  // under the terrain to a validated point on the player's level, and comes
  // back up. Mechanically it is the burrow, minus the attack on the far end.
  EXTRACT: 'extract',
  // Support units park here while their heal channel runs; they hold position
  // on an ally rather than on the player, which is what makes them read as
  // something other than a shy shooter.
  TEND: 'tend',
};

export class StateMachine {
  constructor(owner = null, table = null) {
    this.owner = owner;
    this.table = table;
    this.state = '';
    this.prev = '';
    this.t = 0;
  }

  /** Point the machine at a (shared) table and clear history. */
  reset(owner, table) {
    this.owner = owner;
    this.table = table;
    this.state = '';
    this.prev = '';
    this.t = 0;
  }

  is(name) { return this.state === name; }

  set(name, ctx) {
    if (name === this.state) return;
    const table = this.table;
    if (!table) return;
    const cur = table[this.state];
    const from = this.state;
    if (cur && cur.exit) cur.exit(this.owner, ctx, this);
    // An exit handler is allowed to transition the machine itself, and when it
    // does, its transition is the one that counts — this one was decided
    // before the handler ran and is now stale. Writing it anyway would undo a
    // completed transition on the way back out.
    //
    // The Blind Shrike is why. A dive that misses runs its window out, so
    // ATTACK.update calls set(RECOVER); ATTACK.exit detonates the still-alive
    // diver, the detonation self-kills through Combat, and onDeath sets DIE.
    // Resuming here would stamp RECOVER onto a corpse — a dead unit in a live
    // state, which is unhittable (the ray path skips !alive), unkillable
    // (takeDamage early-returns on the dead), never reaped (`finished`
    // requires DIE), and still detonating at the player every cooldown.
    if (this.state !== from) return;
    this.prev = this.state;
    this.state = name;
    this.t = 0;
    const next = table[name];
    if (next && next.enter) next.enter(this.owner, ctx, this);
  }

  /** Re-enter the current state (useful for chaining attacks). */
  restart(ctx) {
    const s = this.table && this.table[this.state];
    this.t = 0;
    if (s && s.enter) s.enter(this.owner, ctx, this);
  }

  update(ctx, h) {
    this.t += h;
    const s = this.table && this.table[this.state];
    if (s && s.update) s.update(this.owner, ctx, h, this);
  }
}
