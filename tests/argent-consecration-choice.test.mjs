/**
 * Consecration offers a table, not a card (issue #173).
 *
 * The audit's complaint was an asymmetry: corruption tells you exactly what it
 * is charging you for, and purity's most expensive purchase handed over a blind
 * draw. The reason it did was mechanical rather than deliberate - the only
 * stream available was `ctx.rng`, `prompt()` runs off the render loop, and a
 * card named before the press therefore made the run's random sequence a
 * function of frame rate.
 *
 * So the guards here are written against that, not against the feature:
 *
 *  1. the offer is *derived* - re-reading and re-rendering it a thousand times
 *     moves the gameplay stream nowhere. Point `Items.previewArgent` at
 *     `this._rng()` instead of its salted stream and this arm goes red;
 *  2. the offer is *stable* - same seed, same stage, same three cards, so an
 *     altar rebuilt after a save or a HUD teardown is selling what it was.
 *     Salt the derivation with anything that is not (seed, offer id) - the
 *     clock, a frame counter, `Math.random` - and this arm goes red;
 *  3. exactly one card resolves, and it is the one the player was aiming at;
 *  4. telemetry records the table as well as the pick, which is the only way
 *     the resulting data can tell a wanted card from an unopposed one.
 */
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { MOTE, RELIQUARY } from '../src/data/bandBoons.js';
import { ITEMS_BY_TIER } from '../src/data/items.js';
import { VoidBargain } from '../src/world/Interactables.js';
import {
  installTelemetry, setTelemetryEnabled,
} from '../src/systems/Telemetry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A ctx with a real `Corruption` and a real `Items`, so the derivation is the real one. */
function makeCtx({ seed = 4242 } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority: true, seed, time: 0, netRole: 'single',
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    events: {
      emit(name, p) { emitted.push({ name, p }); for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    interactables: { list: [] },
  };
  // A counted proxy over the shared gameplay stream. Every arm below asserts
  // against this number, and it is the number a same-seed run shares.
  ctx.rng = { n: 0, next() { this.n++; return 0.5; }, range(a) { this.n++; return a; }, int(a) { this.n++; return a; }, pick(l) { this.n++; return l[0]; }, weighted(l) { this.n++; return l[0]; } };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, emitted, items };
}

function withMotes(f, motes) {
  const cor = f.ctx.corruption;
  cor.feed(f.ctx.player, MOTE.per * motes);
  cor.bleed(f.ctx.player, MOTE.per * motes);
  return f;
}

const altarAt = (f, stage = 0) => new VoidBargain(f.ctx, new THREE.Vector3(), stage);

console.log('the offer is derived, so reading it costs the gameplay stream nothing');
{
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const altar = altarAt(f);
  f.ctx.rng.n = 0;
  // Render it the way the game does: `update` reads `signal` reads `offer`,
  // and `prompt` paints the cards. A thousand frames of it.
  for (let i = 0; i < 1000; i++) { altar.update(1 / 60); altar.signal(); altar.prompt(); }
  ok(f.ctx.rng.n === 0, `1000 rendered frames took ${f.ctx.rng.n} draws off ctx.rng`);
  ok(altar.consecrationPreview().length >= 2, 'and there is a real table to read');
  // The counter can move - it is the live stream, not a dead stub.
  f.ctx.rng.next();
  ok(f.ctx.rng.n === 1, 'and that counter does move when something draws');
}

console.log('the offer is stable: same seed, same stage, same cards');
{
  const a = altarAt(withMotes(makeCtx({ seed: 99 }), RELIQUARY.motes), 3).consecrationPreview().map((c) => c.id);
  const b = altarAt(withMotes(makeCtx({ seed: 99 }), RELIQUARY.motes), 3).consecrationPreview().map((c) => c.id);
  ok(a.length >= 2 && a.join() === b.join(), `a rebuilt altar sells the same cards (${a.join(', ')})`);

  // ...and it is genuinely a function of both terms, not a constant list.
  const otherStage = altarAt(withMotes(makeCtx({ seed: 99 }), RELIQUARY.motes), 4).consecrationPreview().map((c) => c.id);
  const otherSeed = altarAt(withMotes(makeCtx({ seed: 7 }), RELIQUARY.motes), 3).consecrationPreview().map((c) => c.id);
  ok(otherStage.join() !== a.join(), `the next stage's altar sells another table (${otherStage.join(', ')})`);
  ok(otherSeed.join() !== a.join(), `and so does another seed (${otherSeed.join(', ')})`);
}

console.log('the preview says what the player is buying');
{
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const altar = altarAt(f);
  const line = altar.prompt();
  for (const c of altar.consecrationPreview()) {
    ok(line.includes(c.name), `the prompt names ${c.name}`);
    ok(c.description.length > 0 && line.includes(c.description), `and quotes what it does`);
  }
  ok(/paying \d+%/.test(line), 'and what the gauge will pay for it');
  // The effect is quoted at the stack the purchase would leave, which is the
  // synergy preview: hold one already and the number moves.
  const id = altar.consecrationPreview()[0].id;
  const first = altar.consecrationPreview()[0].description;
  f.ctx.items.grant(id);
  const second = altarAt(f).consecrationPreview()[0].description;
  ok(second !== first, `a card you already hold previews its next stack (${first} -> ${second})`);
  ok(altarAt(f).prompt().includes('you hold 1'), 'and the prompt says you hold one');
}

console.log('exactly one card resolves, and it is the one the window was answered with');
{
  for (let i = 0; i < RELIQUARY.choices; i++) {
    const f = withMotes(makeCtx(), RELIQUARY.motes);
    const altar = altarAt(f);
    const table = altar.consecrationPreview().map((c) => c.id);
    ok(altar.selectConsecration(i) === true, `card ${i + 1} can be aimed at`);
    ok(altar.prompt().includes(`> ${i + 1}.`), 'and the prompt marks the aim');
    f.ctx.rng.n = 0;
    ok(altar.interact(f.ctx.player) === true, 'the press succeeds');
    // The press now opens the window rather than settling it (issue #204):
    // nothing is granted until the panel is answered.
    ok(f.ctx.items.hasChoiceWindow() === true, 'and opens the choice window');
    ok(table.every((id) => f.ctx.items.count(id) === 0), 'with nothing granted yet');
    ok(f.ctx.items.chooseMutation(table[i]) === true, 'the card is pressed');
    ok(f.ctx.rng.n === 0, `and the whole transaction took no gameplay draw (${f.ctx.rng.n})`);
    ok(f.ctx.items.count(table[i]) === 1, `${table[i]} was granted`);
    const others = table.filter((_, j) => j !== i);
    ok(others.every((id) => f.ctx.items.count(id) === 0), 'and none of the others were');
    ok(altar.spent === true, 'the altar is spent');
    ok(altar.consecratePick() === i, 'and the aim followed the pick');
  }
  // Out of range aims are refused rather than clamped silently.
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const altar = altarAt(f);
  ok(altar.selectConsecration(99) === false && altar.selectConsecration(-1) === false,
    'an aim off the table is refused');
  ok(altar.consecratePick() === 0, 'and the aim is left where it was');
}

console.log('telemetry records the table as well as the pick');
{
  const storage = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  setTelemetryEnabled(true, storage);
  const f = withMotes(makeCtx(), RELIQUARY.motes);
  const rec = installTelemetry(f.ctx, { storage });
  const altar = altarAt(f);
  const table = altar.consecrationPreview().map((c) => c.id);
  altar.selectConsecration(1);
  ok(altar.interact(f.ctx.player) === true, 'the press succeeds');
  ok(f.ctx.items.chooseMutation(table[1]) === true, 'and the window is answered');
  const row = rec.record.argent[0];
  ok(row?.id === table[1], `the chosen card is recorded (${row?.id})`);
  ok(Array.isArray(row?.offered) && row.offered.join() === table.join(),
    `and the table it came off (${row?.offered?.join(', ')})`);
  ok(row.offered.includes(row.id), 'the pick is one of the offered');
}

console.log('the pool bounds the table');
{
  ok(ITEMS_BY_TIER.argent.length >= RELIQUARY.choices,
    `the tier can fill an offer (${ITEMS_BY_TIER.argent.length} cards, ${RELIQUARY.choices} offered)`);
  const f = makeCtx();
  ok(f.items.previewArgent(99, 0).length === ITEMS_BY_TIER.argent.length,
    'and an over-large ask is capped at the pool rather than repeating a card');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
