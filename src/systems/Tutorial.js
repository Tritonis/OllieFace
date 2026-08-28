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
// ends the stage, and the void's first bargain is the last thing offered on
// the numbered list, `BEATS`. A beat whose event never arrives simply stays on
// screen; nothing here can deadlock a run because nothing here gates one.
//
// The alignment economy (issue #180, `GLOSSARY` below) is not on that list,
// because it has no fixed place in one — a run might not mint a mark until
// stage 3 or ward until stage 6. So it runs on its own clock, past `BEATS`
// finishing and past stage 0, teaching each concept off the real event that
// first makes it true and never off a schedule.
//
// One line at a time and never a paragraph: the issue's "no text wall" is
// enforced by the shape of this file, not by discipline. There is exactly one
// string on screen and it is replaced, never appended to.
import { bindings, keyLabel } from '../core/Bindings.js';
import { PAD_BUTTON } from '../core/PadState.js';
import { glyphLabel, DEFAULT_GLYPH_SET } from '../data/glyphs.js';
import { BOON, MOTE, RELIQUARY } from '../data/bandBoons.js';
import { TOLERANCE, CAPSTONE, SOURCES } from '../data/alignment.js';
import { S } from '../ai/StateMachine.js';

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
    line: (ctx) => `Kill for gold, then open a chest — ${promptLabel(ctx, 'interact')}.`
      // The three-way claim (#175). Not "press 2 to corrupt": the corrupted
      // card is only dealt for items with a blight counterpart, so a numbered
      // instruction would be wrong for most of the catalogue. The cards carry
      // their own keys and their own prices.
      + ' Take it clean, corrupt it, or salvage it back — each card is priced.',
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
 * How long a glossary line holds the screen before yielding (issue #180). Not
 * a table number — it is a UI dwell, not a game-balance quantity, so it is
 * fine as a constant here rather than derived. Long enough to read a short
 * line, short enough that it cannot camp the HUD past the moment that made it
 * relevant.
 */
export const GLOSSARY_HOLD = 6;

/**
 * The alignment economy's curriculum (issue #180) — the second half of the
 * scenario, and a different shape from `BEATS` on purpose. `BEATS` is a
 * sequence: one beat is ever "current", and a real outcome retires it before
 * the next opens. The economy above does not arrive in an order anybody
 * chose — a party might mint a mark on stage 1 and never ward until stage 4 —
 * so each entry here fires once, off its own event, whenever that event first
 * makes the entry true. `Tutorial` queues entries that fire together (or that
 * fire while `BEATS` still owns the line) and shows them one at a time.
 *
 * Every quoted number is imported from the table that prices it, never
 * retyped — `tests/alignment-glossary.test.mjs` proves a stale copy would be
 * caught by patching the table in place.
 *
 * `owner` names the field on the event payload that identifies the pawn who
 * acted, for the same co-op filter `voidBargain`/`corruptionPact` use above.
 * Left unset, the entry is world-level and shown to every seat — the same
 * choice `teleporterComplete` makes for the same reason: nobody at the table
 * "owns" a band crossing or a ledger total.
 */
export const GLOSSARY = [
  {
    id: 'marks',
    event: 'voidMarksChanged',
    when: (e) => e?.spent === 0,
    line: () => `Corruption just minted a void mark — one per ${BOON.markPer} points of the run's peak. `
      + 'The void will take it in trade.',
  },
  {
    id: 'warding',
    event: 'corruptionWarded',
    owner: 'player',
    line: () => `Warding bleeds corruption back down — bank ${MOTE.per} of it and an argent mote mints.`,
  },
  {
    id: 'motes',
    event: 'argentMotesChanged',
    when: (e) => e?.spent === 0,
    line: () => 'An argent mote, earned by warding — spend it on Sanctuary, or save toward a warded card.',
  },
  {
    id: 'sanctuary',
    event: 'voidBargain',
    when: (e) => e?.kind === 'sanctuary',
    owner: 'owner',
    line: () => `Sanctuary bought — for ${MOTE.sanctuarySeconds}s nothing you take feeds the void.`,
  },
  {
    id: 'consecration',
    event: 'voidBargain',
    when: (e) => e?.kind === 'consecrate',
    owner: 'owner',
    line: () => `Consecration bought — ${RELIQUARY.motes} motes wards a card into the run for good.`,
  },
  {
    id: 'grace',
    event: 'corruptionBand',
    when: (e) => (e?.band ?? 0) > 0,
    line: () => `The void's grace fades as the world corrupts — Consecration pays less past Pristine, `
      + `nothing at all by ${RELIQUARY.fadeAt}.`,
  },
  {
    id: 'commitment',
    event: 'alignmentCommitted',
    line: () => `That choice doesn't wash off — corrupt and pure acts both add to a ledger that never falls, `
      + `past ${TOLERANCE.corrupt} of one and a route is closing.`,
  },
  {
    id: 'route',
    event: 'alignmentCommitted',
    when: (e) => e?.alignment && e.alignment !== 'neutral',
    // Mixed is reached two ways (`alignmentOf`, data/alignment.js:236-245):
    // a deliberate Tempering reads as mixed on its own, weight and all, with
    // corrupt and pure never having crossed anything; or both tolerances got
    // crossed independently. Those are different claims about the run and get
    // different lines — the fusion is a single act, the double-crossing is an
    // accumulation, and quoting "past N/N of each" for a Tempering-only ledger
    // would be false (issue #180 review, FIX 1).
    line: (ctx, e) => {
      if (e.alignment === 'mixed') {
        return (e?.mixed ?? 0) > TOLERANCE.mixed
          ? `A Tempering just claimed this run — fusing two items weighs ${SOURCES.tempered.per}, `
            + `past ${TOLERANCE.mixed} and the fusion alone reads as mixed.`
          : `Committed to both sides now — past ${TOLERANCE.corrupt}/${TOLERANCE.pure} of each, mixed is where this run lands.`;
      }
      // A corrupt-classed ledger gets one more clause than a pure one: it
      // bars the clean gate on its own, band notwithstanding (#171/#218/#219,
      // `cleanRouteEligible`) — a low-band run that went this way still finds
      // the door, just not the plain ending behind it.
      if (e.alignment === 'corrupt') {
        return `This run has a side now: corrupt — ${CAPSTONE.corrupt} commitments seals its ending, `
          + 'and even a low band no longer opens the clean gate on its own — a redeemed route stands open instead.';
      }
      return `This run has a side now: ${e.alignment} — ${CAPSTONE[e.alignment]} commitments seals its ending.`;
    },
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
    // The glossary (issue #180): a separate on/off switch from `active`,
    // because it has to keep listening long after `BEATS` finishes — the
    // economy it teaches shows up on whatever stage the party first reaches
    // it, which is routinely well past stage 0.
    this.glossaryOn = false;
    this.glossarySeen = new Set();
    this.glossaryQueue = [];
    this.glossaryText = null;
    this.glossaryT = 0;
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
    // the Covenant Stone -- and both filtered to the party who CHOSE, for the
    // same reason `loot` is: a teammate dealing with the void taught this
    // player nothing. `voidBargain` names the dealer in `owner`.
    //
    // `corruptionPact` carries both parties and only `to` is one of them.
    // `Corruption.transfer` has exactly one caller, `CovenantStone.interact`
    // (Interactables.js:1686), where `to` is the pawn who pressed and `from` is
    // auto-selected as the heaviest OTHER ledger -- a limit that file documents
    // itself. So a donor made no decision at all, and crediting them would mark
    // this beat complete for a player who never interacted with anything.
    on('voidBargain', (e) => { if (this.isAt('corruption') && this.isLocal(e?.owner)) this.next(); });
    on('corruptionPact', (e) => { if (this.isAt('corruption') && this.isLocal(e?.to)) this.next(); });
    // A run that ends takes the scenario with it, however far it got.
    on('runEnd', () => this.endAll());
    // The glossary listens off the same bus, on its own schedule (see the
    // `GLOSSARY` doc comment). One listener per entry rather than a single
    // dispatcher keyed on event name, because two entries below share an
    // event (`voidBargain`, `alignmentCommitted`) and both must be free to
    // fire off the same payload.
    for (const g of GLOSSARY) {
      on(g.event, (e) => {
        if (!this.glossaryOn || this.glossarySeen.has(g.id)) return;
        if (g.owner && !this.isLocal(e?.[g.owner])) return;
        if (g.when && !g.when(e)) return;
        this.glossarySeen.add(g.id);
        this.glossaryQueue.push(g.line(this.ctx, e));
        this.pumpGlossary();
      });
    }
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
    // The glossary arms alongside `BEATS` and, unlike it, stays armed past
    // `stop()` — see the constructor's comment.
    this.glossaryOn = true;
    this.glossarySeen = new Set();
    this.glossaryQueue = [];
    this.glossaryText = null;
    this.glossaryT = 0;
    this.render();
  }

  next() {
    if (!this.active) return;
    this.beat++;
    if (this.beat >= BEATS.length) { this.stop(); return; }
    this.render();
  }

  /**
   * End the numbered curriculum — completed, skipped or run over, all the
   * same ending. Deliberately leaves the glossary running: `BEATS` finishing
   * (routinely on stage 0, at the first bargain) says nothing about whether
   * the economy it just gestured at has actually come up yet.
   *
   * `tutorialArmed` is cleared here rather than at `start`, so a scenario
   * interrupted by a reload is still owed to the player.
   */
  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.ctx) this.ctx.tutorialArmed = false;
    this.write('');
    // A glossary entry that arrived while `BEATS` still owned the line has
    // been waiting in the queue; the line is free the instant this returns.
    this.pumpGlossary();
  }

  /**
   * The real off switch — the pause screen's Skip, and a run ending. Both are
   * "stop teaching me", not just "stop the numbered list", so both take the
   * glossary down with the curriculum; `stop()` alone does not.
   */
  endAll() {
    if (this.active) this.stop();
    this.glossaryOn = false;
    this.glossaryQueue = [];
    this.glossaryText = null;
    this.write('');
  }

  /** The pause screen's Skip. */
  skip() { this.endAll(); }

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

  /**
   * Is a live enemy mid-windup or mid-swing at the local pawn right now?
   * (issue #180 review, FIX 2.) `ctx.director` owns `enemies`
   * (`systems/Director.js`), each carries its own `fsm.state`
   * (`ai/StateMachine.js`) and its current `targetPlayer`
   * (`entities/Enemy.js`) — a glossary toast landing mid-telegraph would be
   * exactly the "interrupts a real choice" failure this exists to avoid,
   * except the choice is a dodge rather than a menu. Tolerates a director
   * that does not exist (every unit test's ctx, and any screen with no
   * combat system wired) by reading nothing off it.
   */
  localUnderAttack() {
    const list = this.ctx?.director?.enemies;
    if (!list) return false;
    return list.some((e) => e?.targetPlayer === this.ctx?.player
      && (e?.fsm?.state === S.WINDUP || e?.fsm?.state === S.ATTACK));
  }

  /**
   * Show the next queued glossary line, if the line is actually free.
   *
   * Three things hold it back on purpose: `BEATS` still being active (a
   * glossary line must never steal the line an in-progress beat owns — see
   * `stop()`), the local pawn standing in a choice window (the argent card
   * panel, the blight toll), and a live enemy mid-windup or mid-swing at the
   * local pawn (`localUnderAttack`) — a toast landing on top of a decision
   * the player is mid-choosing, or a hit they are mid-dodging, is exactly the
   * "interrupts a real choice" / "never during an active attack window"
   * failure #180 asks this not to be. All three clear on their own, so a
   * deferred entry is never lost, only delayed.
   */
  pumpGlossary() {
    if (!this.glossaryOn || this.active || this.glossaryText) return;
    if (this.ctx?.items?.hasChoiceWindow?.()) return;
    if (this.localUnderAttack()) return;
    if (!this.glossaryQueue.length) return;
    this.glossaryText = this.glossaryQueue.shift();
    this.glossaryT = GLOSSARY_HOLD;
    this.write(this.glossaryText);
  }

  update(dt) {
    if (this.active) {
      // Re-rendered every frame the *text* would change: the prompt names
      // live bindings and the live glyph set, so a player who rebinds
      // mid-scenario or picks up a pad sees the new name rather than the one
      // that was true when the beat opened. `write` makes the no-change case
      // a comparison.
      if (BEATS[this.beat]?.id === 'move') this.trackMovement(dt);
      this.render();
    } else if (this.glossaryText) {
      this.glossaryT -= dt;
      if (this.glossaryT <= 0) { this.glossaryText = null; this.write(''); this.pumpGlossary(); }
    } else {
      this.pumpGlossary();
    }
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
