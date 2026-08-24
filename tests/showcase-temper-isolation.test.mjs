/**
 * Integration review (merged master), Major M1: `moment:temper` was the only
 * showcase entry that permanently wrote state — `items.give` + `items.temper`
 * fired the real `itemTempered` event, which `Corruption.init` commits to the
 * alignment ledger unconditionally (`commit` only ever adds; see its own doc
 * comment) and which a codex unlock listens for and flushes to disk off the
 * same event. Neither has an undo, so a `give`/`take` revoke around the real
 * call would still leave a showcase fire as a permanent mark on whatever
 * profile the evaluator is running against.
 *
 * The fix joins the house pattern its four alignment siblings already keep
 * (`sanctuary`, `consecrate`, `warding`, `wardingMint`, Showcase.js:434-453):
 * VFX/Audio presentation only, no real `Items`/`Corruption` write. This file
 * is the red-then-green: the RED arm below is the pre-fix shape, reproduced
 * directly against `Items`/`Corruption` (not through Showcase, so it stays
 * red regardless of what Showcase.js currently does) to prove the write really
 * is irreversible and really is what the old code did. The GREEN arm fires
 * the actual showcase entry and asserts the pack, the ledger and the event
 * stream are byte-identical before and after.
 */
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { TEMPERED_ITEMS } from '../src/data/items.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority: true, seed: 1, time: 0, netRole: 'single',
    rng: new RNG(9001),
    player: { isPlayer: true, alive: true, position: { x: 0, y: 0, z: 0 } },
    events: {
      emit(name, p) { emitted.push(name); for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, items, corruption, emitted };
}

// ------------------------------------------------------------------ red arm

console.log('RED — the pre-fix shape really does write the ledger permanently and irreversibly');
{
  const f = makeCtx();
  const before = f.corruption.ledgerSummary();
  const t = TEMPERED_ITEMS[0];
  const { argent, blight } = t.tempers;
  // The pre-fix `moment:temper` body, verbatim: give both parents, call the
  // real `Items.temper`, then (as the reviewer's repro names) a `take`-style
  // revoke of the inventory alone — which is all a naive "wrap and restore"
  // could touch, because the ledger commit is not inventory.
  f.items.give(argent, 1);
  f.items.give(blight, 1);
  f.items.temper(t.id);
  f.items.take(t.id, 1); // the only half a bare revoke can undo
  const after = f.corruption.ledgerSummary();
  ok(f.emitted.includes('itemTempered'), 'the real event fired');
  ok(after.commitMixed !== before.commitMixed || after.alignment !== before.alignment,
    'and the ledger moved — a bare inventory revoke does not undo it (this is the bug M1 reports)');
}

// ---------------------------------------------------------------- green arm

console.log('GREEN — the fixed showcase entry is presentation only: pack, ledger and event stream untouched');
{
  const el = () => {
    const node = { style: { cssText: '' }, textContent: '', innerHTML: '', id: '', children: [],
      append: (...k) => node.children.push(...k), appendChild: (k) => { node.children.push(k); return k; },
      scrollIntoView() {}, remove() {} };
    return node;
  };
  globalThis.document = { createElement: el, body: el() };
  const winListeners = [];
  globalThis.window = { addEventListener: (t, fn, cap) => winListeners.push({ t, fn, cap }), removeEventListener() {} };

  const { installShowcase } = await import('../src/core/Showcase.js');
  const f = makeCtx();
  f.ctx.camera = { position: { x: 0, y: 2, z: 0 }, getWorldDirection: (v) => v.set(0, 0, -1) };
  f.ctx.stage = { sampleHeight: () => 0 };
  f.ctx.vfx = {}; f.ctx.audio = {};

  const api = installShowcase(f.ctx);
  const entry = api.entries.find((e) => e.id === 'temper');
  ok(!!entry, 'the moment:temper entry exists');

  const invBefore = JSON.stringify(f.items.inventory());
  const ledgerBefore = JSON.stringify(f.corruption.ledgerSummary());
  const emittedBefore = f.emitted.length;

  entry.fire(0);

  ok(JSON.stringify(f.items.inventory()) === invBefore, 'the pack is byte-identical after a fire');
  ok(JSON.stringify(f.corruption.ledgerSummary()) === ledgerBefore, 'the alignment ledger is byte-identical after a fire');
  ok(f.emitted.slice(emittedBefore).every((n) => n !== 'itemTempered' && n !== 'alignmentCommitted'),
    'no itemTempered or alignmentCommitted event reached the bus — nothing downstream (Corruption, a codex unlock) can react');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
