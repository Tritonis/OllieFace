// The first-run scenario (#41).
//
// Not a bespoke sandbox: this system spawns nothing, moves nothing and changes
// no rule. It is a *reader* of the same bus `ui/Announcer.js` reads, with one
// extra signal — the local pawn's travelled distance, which is the only beat
// here that no existing event covers. A normal stage 0 of a normal run teaches
// the whole curriculum on its own; all that was missing was somebody naming
// the next thing to do while it happened.
//
// So the ordering below is a claim about what stage 0 already presents, in the
// order it presents it — you walk before anything is in range, your skills come
// off cooldown before the first chest is affordable, the teleporter is what
// ends the stage, and the void's first bargain is the last thing offered. A
// beat whose event never arrives simply stays on screen; nothing here can
// deadlock a run because nothing here gates one.
//
// One line at a time and never a paragraph: the issue's "no text wall" is
// enforced by the shape of this file, not by discipline. There is exactly one
// string on screen and it is replaced, never appended to.
import { bindings, keyLabel } from '../core/Bindings.js';
import { PAD_BUTTON } from '../core/PadState.js';
import { glyphLabel, DEFAULT_GLYPH_SET } from '../data/glyphs.js';

/** Metres the player must cover before the movement beat is satisfied. Far
 *  enough to be a walk rather than a twitch, short enough to clear inside the
 *  first few seconds of a stage. */
export const MOVE_DISTANCE = 12;

/** The four skill slots, in the order the prompt lists them. */
export const SKILL_SLOTS = ['primary', 'secondary', 'utility', 'special'];

/** Which action's button a slot is cast with, for the prompt. */
const SLOT_ACTION = {
  primary: 'primary', secondary: 'secondary', utility: 'utility', special: 'special',
};

const SLOT_LABEL = {
  primary: 'Primary', secondary: 'Secondary', utility: 'Utility', special: 'Special',
};

/**
 * The name to print for an action, in the device the player is actually using.
 *
 * Pad names go through `glyphLabel` with the player's chosen set (#42) rather
 * than the Xbox face names the binding table is keyed on — a prompt that says
 * "A" to somebody holding a DualSense is the exact defect that setting exists
 * to close, and a tutorial is the worst possible place to reintroduce it.
 */
export function promptLabel(ctx, actionId) {
  const set = ctx?.settings?.controllerGlyphs ?? DEFAULT_GLYPH_SET;
  if (ctx?.input?.padActive) return glyphLabel(bindings.padOf(actionId), set);
  // `keyOf`, not `code`: `code` returns the frozen VIRTUAL name gameplay polls
  // for, which is keyed on the SHIPPED default and never moves when a player
  // rebinds. Printing it would name the key the action used to be on -- caught
  // by the rebind guard in tests/first-run-scenario.test.mjs.
  return keyLabel(bindings.keyOf(actionId));
}

/** How the player reaches the pause screen, where the skip lives. */
function pauseLabel(ctx) {
  const set = ctx?.settings?.controllerGlyphs ?? DEFAULT_GLYPH_SET;
  return ctx?.input?.padActive ? glyphLabel(PAD_BUTTON.START, set) : 'Esc';
}

/**
 * The curriculum, in the order issue #41 asks for.
 *
 * `done` is what ADVANCES the beat, and every one of them is a real gameplay
 * outcome observed off the bus — not a keypress. Pressing the fire button with
 * the skill on cooldown emits no `abilityUsed`, so the beat correctly does not
 * clear; picking an item up off the floor clears the loot beat as surely as
 * opening the chest does.
 */
export const BEATS = [
  {
    id: 'move',
    line: (ctx) => (ctx?.input?.padActive
      ? 'Move with the left stick. Look with the right.'
      : `Move with ${['moveForward', 'moveLeft', 'moveBack', 'moveRight']
        .map((a) => promptLabel(ctx, a)).join('')}. Look with the mouse.`),
  },
  {
    id: 'skills',
    line: (ctx, state) => {
      const left = SKILL_SLOTS.filter((s) => !state.slots.has(s));
      return `Use all four skills — ${left
        .map((s) => `${SLOT_LABEL[s]} ${promptLabel(ctx, SLOT_ACTION[s])}`).join(', ')}`;
    },
  },
  {
    id: 'loot',
    line: (ctx) => `Kill for gold, then open a chest — ${promptLabel(ctx, 'interact')}`,
  },
  {
    id: 'teleporter',
    line: (ctx) => `Find the teleporter and hold it — ${promptLabel(ctx, 'interact')}. `
      + 'Everything on the map comes to you while it charges.',
  },
  {
    id: 'corruption',
    line: (ctx) => `The void will trade. Its price is corruption — ${promptLabel(ctx, 'interact')} to deal, or walk away.`,
  },
];

/**
 * Should the next launch carry the scenario?
 *
 * A function rather than three lines inside `Menus.launch` because it is the
 * whole of the "reachable on a first run" claim, and a claim that only exists
 * inside a method that also mutates six other things and closes a screen is one
 * no test can put a finger on.
 */
export function shouldArmTutorial(settings, asked) {
  return !!asked || settings?.firstRunSeen !== 1;
}

export class Tutorial {
  /**
   * `refs` is `{ line }`, an element-like the HUD owns — passed in for the same
   * reason `Announcer`'s sinks are: the markup stays in one file and the tests
   * hand over a stub.
   */
  constructor(ctx, refs, events = ctx?.events) {
    this.ctx = ctx;
    this.line = refs?.line || null;
    this.active = false;
    this.beat = 0;
    this.slots = new Set();
    this.travelled = 0;
    this._last = null;
    this._text = null;
    if (events?.on) this.bind(events);
  }

  bind(events) {
    const on = (name, fn) => events.on(name, fn);
    // Armed by `Menus.launch`, consumed here. Stage 0 only: a scenario that
    // reintroduced itself on stage 3 would be teaching a player who has just
    // proved they do not need it.
    on('stageStart', (e) => { if ((e?.index ?? 0) === 0 && this.ctx?.tutorialArmed) this.start(); });
    on('abilityUsed', (e) => {
      if (!this.isAt('skills') || !this.isLocal(e?.player)) return;
      if (!SKILL_SLOTS.includes(e?.slot)) return;
      this.slots.add(e.slot);
      if (this.slots.size >= SKILL_SLOTS.length) this.next();
      else this.render();
    });
    on('itemPickup', (e) => { if (this.isAt('loot') && this.isLocal(e?.owner ?? e?.player)) this.next(); });
    // Deliberately NOT owner-filtered, unlike everything around it: the
    // teleporter is one shared objective with no actor on its payload, and a
    // stage that has already ended cannot still be teaching this beat.
    on('teleporterComplete', () => { if (this.isAt('teleporter')) this.next(); });
    // Either shape of the first corruption choice -- the altar's bargains and
    // the pact shrine -- and both owner-filtered, for the same reason `loot` is:
    // a teammate dealing with the void taught this player nothing. `voidBargain`
    // names the dealer in `owner`; `transfer` names both parties, and either end
    // of a pact is the local player's own choice about their own ledger.
    on('voidBargain', (e) => { if (this.isAt('corruption') && this.isLocal(e?.owner)) this.next(); });
    on('corruptionPact', (e) => {
      if (this.isAt('corruption') && (this.isLocal(e?.from) || this.isLocal(e?.to))) this.next();
    });
    // A run that ends takes the scenario with it, however far it got.
    on('runEnd', () => this.stop());
  }

  /** Is this event about the pawn the player at this screen is driving? */
  isLocal(who) { return !who || who === this.ctx?.player; }

  isAt(id) { return this.active && BEATS[this.beat]?.id === id; }

  start() {
    this.active = true;
    this.beat = 0;
    this.slots.clear();
    this.travelled = 0;
    this._last = null;
    this.render();
  }

  next() {
    if (!this.active) return;
    this.beat++;
    if (this.beat >= BEATS.length) { this.stop(); return; }
    this.render();
  }

  /**
   * End it — completed, skipped or run over, all the same ending.
   *
   * `tutorialArmed` is cleared here rather than at `start`, so a scenario
   * interrupted by a reload is still owed to the player.
   */
  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.ctx) this.ctx.tutorialArmed = false;
    this.write('');
  }

  /** The pause screen's Skip. Same ending as finishing it. */
  skip() { this.stop(); }

  render() {
    const beat = BEATS[this.beat];
    if (!beat) return;
    this.write(`${beat.line(this.ctx, this)}   (${pauseLabel(this.ctx)} to skip)`);
  }

  write(text) {
    if (this._text === text) return;
    this._text = text;
    if (!this.line) return;
    this.line.textContent = text;
    this.line.classList?.toggle('is-on', !!text);
  }

  update(dt) {
    if (!this.active) return;
    // Re-rendered every frame the *text* would change: the prompt names live
    // bindings and the live glyph set, so a player who rebinds mid-scenario or
    // picks up a pad sees the new name rather than the one that was true when
    // the beat opened. `write` makes the no-change case a comparison.
    if (BEATS[this.beat]?.id === 'move') this.trackMovement(dt);
    this.render();
  }

  trackMovement() {
    const p = this.ctx?.player?.position;
    if (!p) return;
    if (this._last) {
      this.travelled += Math.hypot(p.x - this._last.x, p.z - this._last.z);
    }
    this._last = { x: p.x, z: p.z };
    if (this.travelled >= MOVE_DISTANCE) this.next();
  }
}
