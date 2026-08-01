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
    if (cur && cur.exit) cur.exit(this.owner, ctx, this);
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
