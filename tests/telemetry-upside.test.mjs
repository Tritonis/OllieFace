/**
 * Issue #36's acceptance criterion is a measurement, and until now nothing
 * measured it.
 *
 * `Telemetry.init` subscribed to sixteen events; `voidBargain`, `voidRuin` and
 * `voidMarksChanged` were not among them, so the run export carried the tax
 * (`corruption.fed` / `.bled`) and not one field recording that a player had
 * ever *bought* anything with corruption. "Blind-test players voluntarily take
 * corruption-positive actions" was un-evaluable from the export.
 *
 * The failure this guards against is a silent one — a listener quietly removed
 * leaves a well-formed record with an empty list, which reads exactly like a
 * player who took no bargains. So the test drives real events and asserts the
 * entries, not merely the presence of the keys.
 */
import {
  installTelemetry, readRuns, setTelemetryEnabled, ENABLED_KEY, RUNS_KEY, PARTIAL_KEY,
} from '../src/systems/Telemetry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function makeBus() {
  const l = new Map();
  return {
    emit(n, p) { for (const fn of [...(l.get(n) || [])]) fn(p); },
    on(n, fn) { if (!l.has(n)) l.set(n, []); l.get(n).push(fn); return () => {}; },
  };
}

const storage = fakeStorage();
setTelemetryEnabled(true, storage);
ok(storage.getItem(ENABLED_KEY) === '1', 'recording is on for this fixture');

const bus = makeBus();
const player = { isPlayer: true };
const cor = { world: 0, band: 0, marks: 0, ruined: false };
const ctx = { events: bus, time: 0, seed: 7, player, corruption: cor, netRole: 'single' };
const rec = installTelemetry(ctx, { storage });
ok(rec.active === true, 'the recorder is live');

const at = (t) => { ctx.time = t; };
const setCor = (world, band) => {
  const prev = cor.band;
  cor.world = world; cor.band = band;
  bus.emit('corruptionChanged', { world, band });
  if (band !== prev) bus.emit('corruptionBand', { band, prev });
};

at(0);
bus.emit('stageStart', { index: 0, name: 'Ashen Shelf' });

// Three marks minted by descending into Blighted, one of them spent on a
// reroll. The run's mint and spend totals are deliberately different numbers
// (5 and 4), so a handler that conflated the two would still be caught.
at(40);
setCor(60, 2);
cor.marks = 4;
bus.emit('voidMarksChanged', { marks: 4, spent: 0 });
at(45);
cor.marks = 3;
bus.emit('voidMarksChanged', { marks: 3, spent: 1 });
bus.emit('voidBargain', { kind: 'reroll', marks: 1, count: 2, owner: player });

// A pact, deeper, which is the entry that proves a corruption-*positive*
// action: the player paid fresh debt for it on purpose.
at(90);
setCor(130, 3);
cor.marks = 4;
bus.emit('voidMarksChanged', { marks: 4, spent: 0 });
cor.marks = 1;
bus.emit('voidMarksChanged', { marks: 1, spent: 3 });
bus.emit('voidBargain', { kind: 'pact', marks: 3, id: 'famine', owner: player });

// And the one-way door.
at(150);
setCor(200, 4);
cor.ruined = true;
bus.emit('voidRuin', { world: 200, band: 4 });

at(180);
bus.emit('runEnd', { won: false, stats: { time: 180, kills: 0 } });

const runs = readRuns(storage);
ok(runs.length === 1, `exactly one run was filed (got ${runs.length})`);
const r = runs[0] || {};
const b = r.bargains || [];

console.log('the bargains list');
ok(Array.isArray(r.bargains), 'the record carries a `bargains` list at all');
ok(b.length === 2, `both struck bargains are in it (got ${b.length})`);
ok(b[0]?.kind === 'reroll' && b[0]?.marks === 1, 'the reroll is recorded with its price');
ok(b[1]?.kind === 'pact' && b[1]?.id === 'famine', 'and the pact with the pact it was');
// The world and band at the moment of the press are what turn a list of
// purchases into evidence about *when* players choose to go deeper.
ok(b[1]?.world === 130 && b[1]?.band === 3, `the pact records the world it was struck in (${b[1]?.world}/${b[1]?.band})`);
ok(b[0]?.t === 45, `and the clock, so the two economies can be lined up (${b[0]?.t})`);

console.log('the currency, and the door');
const m = r.corruption?.marks || {};
ok(m.minted === 5, `every mark minted across the run is counted (got ${m.minted})`);
ok(m.spent === 4, `and every mark spent (got ${m.spent})`);
ok(r.corruption?.ruined === true, 'a ruined run says so in the export');

// The refutation condition the design doc names: minted-but-never-spent is the
// signature of an upside nobody found. It has to be distinguishable from a run
// that never minted anything at all.
ok(m.minted > 0 && m.spent > 0, 'this fixture is the healthy shape, not the refuted one');

console.log(`\n${pass} passed, ${fail} failed`);
storage.removeItem(RUNS_KEY); storage.removeItem(PARTIAL_KEY);
process.exit(fail ? 1 : 0);
