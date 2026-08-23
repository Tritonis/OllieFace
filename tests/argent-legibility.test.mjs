/**
 * The purity route, made legible (issue #154).
 *
 *   node tests/argent-legibility.test.mjs
 *
 * The system was fully live and completely invisible: a playtester noticed
 * none of it. Nothing here changes a mechanic — #36 owns the design question —
 * and every assertion below is about a *signal* that did not exist.
 *
 * Four contracts, one per deliverable, and each is written so that deleting the
 * thing it is about fails it:
 *
 *  1. warding announces itself on every ward, not once per forty points. The
 *     assertion is on the partial `progress`, so restoring the old
 *     "emit only when the mote count moves" behaviour fails it.
 *  2. every act that wards is marked, and marked at *one* site. The coverage is
 *     structural rather than counted: the event is emitted inside
 *     `Corruption.bleed` itself and `VFX` rides the event, so any caller is
 *     covered — including `chime-of-absolution`'s per-kill ward, a third caller
 *     an argument from "there are only two" would have missed. The test presses
 *     a real Argent Font and lands a real Voidtouched kill and expects the same
 *     cue from both, and expects nothing from a kill that wards nothing.
 *  3. the argent tier greys as `grace` falls and comes *back*. The un-grey half
 *     is the one worth having: a latched dead state would pass a one-way test.
 *  4. Sanctuary and Consecration call their own presentation rather than the
 *     generic burst and `shrineWin` every other shrine in the game plays.
 *
 * The HUD assertions drive `HUD.prototype` on a hand-built `this`, the idiom
 * from tests/corruption-purse-hud.test.mjs, so no document is needed.
 */
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { MOTE, RELIQUARY, wardedProgress } from '../src/data/bandBoons.js';
import { VoidBargain, ArgentFont } from '../src/world/Interactables.js';
import { VFX } from '../src/systems/VFX.js';
import { Audio } from '../src/systems/Audio.js';
import { HUD } from '../src/ui/HUD.js';
import { grace, ARGENT } from '../src/data/items.js';
import { VOIDTOUCHED } from '../src/data/corruption.js';
import {
  PURITY_PALETTE, PURITY_STEMS, PURITY_METHODS, PURITY_METHOD_EXCEPTIONS,
} from '../src/data/effects.js';
import { reservedViolationOnFeedback } from '../src/data/colourFamily.js';
import { readFileSync } from 'node:fs';

globalThis.addEventListener = globalThis.addEventListener || (() => {});

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n         got  ${got}\n         want ${want}`);
const near = (got, want, msg) => ok(Math.abs(got - want) < 1e-9, `${msg}\n         got  ${got}\n         want ${want}`);

/* ------------------------------------------------------------------ 1. data */

console.log('warded progress is a real fraction of the mote being earned');
{
  near(wardedProgress(0), 0, 'a run that has warded nothing is at the start of its first mote');
  near(wardedProgress(MOTE.per / 2), 0.5, 'half a mote reads as half');
  near(wardedProgress(MOTE.per), 0, 'and the mote boundary resets, because a mote was minted there');
  near(wardedProgress(MOTE.per * 2.25), 0.25, 'the second mote counts from its own start');
  near(wardedProgress(-5), 0, 'negative degrades to zero');
  near(wardedProgress(undefined), 0, 'and so does a missing value, rather than throwing');
}

/* -------------------------------------------------------- 2. the event bus */

/** A ctx with a real `Corruption` and the stubs `bleed` and the font touch. */
function makeCtx() {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority: true, seed: 1, time: 0, netRole: 'single',
    player: { isPlayer: true, alive: true, position: new THREE.Vector3(1, 0, 2) },
    events: {
      emit(name, p) { emitted.push({ name, p }); for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    interactables: { list: [] },
  };
  ctx.items = {
    grant: () => true, addBuff: () => {}, spendGold: () => true,
    blightHeld: () => new Map(), convertibleStacks: () => new Map(),
    rollArgent: () => 'pale-standard', argentStocked: () => true,
    stabilisable: () => [], stabilise: () => {}, nextTollBand: () => 1,
  };
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, emitted, wards: () => emitted.filter((e) => e.name === 'corruptionWarded').map((e) => e.p) };
}

console.log('\nevery ward speaks, not only the fortieth point of one');
{
  const f = makeCtx();
  const cor = f.ctx.corruption;
  cor.feed(f.ctx.player, MOTE.per * 3);

  cor.bleed(f.ctx.player, MOTE.per / 4);
  eq(f.wards().length, 1, 'a quarter-mote ward emits `corruptionWarded`');
  const first = f.wards()[0];
  near(first.progress, 0.25, 'and carries the partial progress the purse had no way to show');
  eq(first.minted, false, 'a partial ward mints nothing and says so');
  eq(cor.motes, 0, 'and really has not minted');
  ok(f.emitted.filter((e) => e.name === 'argentMotesChanged').length === 0,
    'the mote channel stays silent, which is exactly why a second channel was needed');
  eq(first.player, f.ctx.player, 'the payload names the hand that did it, so the cue can land on it');
  near(first.amount, MOTE.per / 4, 'and the amount actually taken');

  cor.bleed(f.ctx.player, MOTE.per / 4);
  near(f.wards()[1].progress, 0.5, 'the second ward is further along the same mote');

  cor.bleed(f.ctx.player, MOTE.per / 2);
  const minted = f.wards()[2];
  eq(minted.minted, true, 'the ward that completes the mote flags the mint');
  eq(minted.motes, 1, 'and reports the purse it filled');
  near(minted.progress, 0, 'progress rolls over to the next mote');
}

console.log('\nwarding rides what was taken, never what was asked for');
{
  const f = makeCtx();
  const cor = f.ctx.corruption;
  cor.feed(f.ctx.player, 5);
  cor.bleed(f.ctx.player, 500);
  near(f.wards()[0].amount, 5, 'scrubbing an almost-clean world wards only the 5 that existed');
  near(f.wards()[0].progress, 5 / MOTE.per, 'and the bar moves by that much and no more');
}

console.log('\na bleed of nothing is not an event');
{
  const f = makeCtx();
  f.ctx.corruption.bleed(f.ctx.player, 10);
  eq(f.wards().length, 0, 'a pristine world cannot be warded, and does not claim to have been');
}

/* -------------------------------------------- 3. both sources are marked */

/** A `VFX` with the pools stubbed, wired to a bus, recording its cues. */
function spyVfx(ctx) {
  const vfx = Object.create(VFX.prototype);
  const cues = [];
  vfx.ctx = ctx;
  vfx.wardingMote = (pos, progress, minted) => cues.push({ pos, progress, minted });
  // The *real* handler body — `VFX._onWarded` — not a copy of it. Only the
  // `e.on` line is re-registered here, because calling `VFX.init` would need a
  // renderer; that one line is asserted verbatim below.
  ctx.events.on('corruptionWarded', (p) => vfx._onWarded(p));
  return { vfx, cues };
}

console.log('\nboth mote sources are marked, from one listener');
{
  // (a) An Argent Font press.
  const f = makeCtx();
  const { cues } = spyVfx(f.ctx);
  f.ctx.corruption.feed(f.ctx.player, 80);
  const font = new ArgentFont(f.ctx, new THREE.Vector3(3, 0, 4), 0);
  ok(font.interact(f.ctx.player) === true, 'the font press goes through');
  eq(cues.length, 1, 'and the press is marked, exactly once');
  ok(cues[0].progress > 0, 'with the progress it bought');

  // (b) A Voidtouched kill, through the `kill` listener `Corruption.init` set.
  const g = makeCtx();
  const gs = spyVfx(g.ctx);
  g.ctx.corruption.feed(g.ctx.player, 200);
  const victim = { isEnemy: true, affix: VOIDTOUCHED.affix, position: new THREE.Vector3() };
  g.ctx.events.emit('kill', { victim, source: g.ctx.player });
  eq(gs.cues.length, 1, 'and a Voidtouched kill is marked by the same listener');
  ok(gs.cues[0].progress > 0, 'with progress of its own');

  // (c) The thing that must NOT be marked.
  const h = makeCtx();
  const hs = spyVfx(h.ctx);
  h.ctx.corruption.feed(h.ctx.player, 200);
  h.ctx.events.emit('kill', { victim: { isEnemy: true, position: new THREE.Vector3() }, source: h.ctx.player });
  eq(hs.cues.length, 0, 'an ordinary kill wards nothing and is not dressed as if it did');
}

/**
 * A `VFX` running the REAL `wardingMote` against stubbed pools, recording one
 * entry per ring actually drawn. The gate lives in `wardingMote`, so a double
 * that stubs it out (`spyVfx`) cannot see the gate at all — this is the only
 * shape that tests it, and it is also the shape the Showcase uses.
 */
function ringVfx() {
  const v = Object.create(VFX.prototype);
  const draws = [];
  v.ctx = { audio: { warding: () => {} } };
  v.particles = { emit: () => {} };
  v.rings = { spawn: (pos, r, ...rest) => draws.push({ r, rest }) };
  v.lights = { flick: () => {} };
  v._ep = () => ({
    position: new THREE.Vector3(), dir: new THREE.Vector3(),
    color0: new THREE.Color(), color1: new THREE.Color(),
  });
  v.time = 0;
  return { v, draws };
}

console.log('\nthe ring is gated wherever it is called from (#161)');
{
  // The Showcase's `warding`/`wardingMint` moments call `wardingMote` directly
  // and `fireGroup` fires marked entries in one synchronous pass — so a `g`
  // pile-up drew two rings while Audio's own gate dropped the second chime.
  const { v, draws } = ringVfx();
  const at = new THREE.Vector3();

  v.wardingMote(at, 0.85, false);
  eq(draws.length, 1, 'a lone Showcase press after idle always draws');
  v.wardingMote(at, 1, true);
  eq(draws.length, 1, 'but a second call in the same instant — the `g` pile-up — draws nothing more');

  v.time = 0.141;
  v.wardingMote(at, 0.85, false);
  eq(draws.length, 2, 'and once the window has passed the ring returns');

  // Minted rides the shorter gate, exactly as the voice does.
  const m = ringVfx();
  m.v.wardingMote(at, 1, true);
  m.v.time = 0.06;
  m.v.wardingMote(at, 1, true);
  eq(m.draws.length, 2, 'a minted ring is gated at 0.05s, not 0.14s');
  m.v.time = 0.09;
  m.v.wardingMote(at, 1, true);
  eq(m.draws.length, 2, 'but 0.03s after the last one is still too soon');
}

console.log('\nand the gate is reached through the real event path too (#161)');
{
  // A ward storm: `Audio.warding` drops everything inside 0.14s, so an ungated
  // ring drew ~8 times per chime. `_onWarded` stays thin, but the ring it asks
  // for must still be dropped — so this drives the real handler into the real
  // `wardingMote` against a hand-wound clock.
  const f = makeCtx();
  const { v, draws } = ringVfx();
  v.ctx.player = f.ctx.player;
  f.ctx.events.on('corruptionWarded', (p) => v._onWarded(p));
  const ward = () => f.ctx.events.emit('corruptionWarded', { progress: 0.5, minted: false });

  ward();
  eq(draws.length, 1, 'the first ward after idle always draws');
  ward();
  v.time = 0.13;
  ward();
  eq(draws.length, 1, 'and two more inside the 0.14s window draw nothing');

  v.time = 0.141;
  ward();
  eq(draws.length, 2, 'past the window the ring returns');
}

console.log('\nand the game really subscribes — not just this test');
{
  ok(typeof VFX.prototype.wardingMote === 'function', '`VFX.wardingMote` exists');
  ok(typeof VFX.prototype.sanctuaryOpen === 'function', '`VFX.sanctuaryOpen` exists');
  ok(typeof VFX.prototype.consecration === 'function', '`VFX.consecration` exists');
  ok(typeof Audio.prototype.warding === 'function', '`Audio.warding` exists');
  ok(typeof Audio.prototype.sanctuary === 'function', '`Audio.sanctuary` exists');
  ok(typeof Audio.prototype.consecrate === 'function', '`Audio.consecrate` exists');
  // `init` is where the subscription lives; asserting on its text is the only
  // way to prove the wiring without standing a renderer up. Matched against the
  // exact quoted name and the exact handler, so renaming either end fails —
  // a substring test passed happily against `'corruptionWardedXX'`.
  ok(/e\.on\('corruptionWarded', \(p\) => this\._onWarded\(p\)\)/.test(VFX.prototype.init.toString()),
    '`VFX.init` subscribes corruptionWarded to `_onWarded` — cut or rename either and this fails');
}

console.log('\nthe cues survive a stubbed world without throwing, and refuse a missing point');
{
  const pool = { emit: () => {} };
  const rings = { spawn: () => {} };
  const lights = { flick: () => {} };
  const shakes = [];
  for (const name of ['wardingMote', 'sanctuaryOpen', 'consecration']) {
    const v = Object.create(VFX.prototype);
    v.ctx = { audio: { warding: () => {} } };
    v.particles = pool; v.rings = rings; v.lights = lights;
    v._ep = () => ({
      position: new THREE.Vector3(), dir: new THREE.Vector3(),
      color0: new THREE.Color(), color1: new THREE.Color(),
    });
    v._shakeAt = (p, a) => shakes.push(a);
    let threw = null;
    try { v[name](new THREE.Vector3(), 0.6, true); } catch (err) { threw = err; }
    ok(threw === null, `${name} runs against the real pools' interface (${threw?.message ?? 'ok'})`);
    let nullThrew = null;
    try { v[name](null); } catch (err) { nullThrew = err; }
    ok(nullThrew === null, `${name} declines a missing position rather than throwing`);
  }
}

/* -------------------------------------- 3b. the reserved-hue guard reaches */

console.log('\nthe new effects are inside the reserved-hue guard, not beside it');
{
  // The hole this closes was demonstrated, not theorised: with the hues written
  // as hex literals in `VFX`, planting full magenta (0xff00ff, the void-only
  // family) on the warding core left the ENTIRE suite green — `assertLanguage`
  // walks `ELEMENT_HUE` and this file's own table, and reaches nothing a hero
  // effect types by hand. Two assertions hold it shut, and both must be here:
  // the table is walked, AND the call sites are made to use the table.
  ok(Object.keys(PURITY_PALETTE).length >= 10, 'the purity palette is declared as data');
  for (const [name, { hex, element }] of Object.entries(PURITY_PALETTE)) {
    ok(reservedViolationOnFeedback(hex, element) === null,
      `${name} spends no reserved hue`);
  }

  // The predicate itself can fail — a guard nobody has watched fail is worth
  // nothing. This is the reviewer's exact mutation, run against the check.
  eq(reservedViolationOnFeedback(0xff00ff, 'restorative'), 'magenta',
    'and full magenta on a restorative surface IS caught — the mutation that used to pass');
  eq(reservedViolationOnFeedback(0xff00ff, 'void'), null,
    'while void may still wear it, the narrow reading effects.js documents');
  eq(reservedViolationOnFeedback(0x6fe0a8, 'restorative'), null,
    'and mint is legal on feedback, which is the whole difference from the damage predicate');

  // The other half of the seam. A hue typed at the call site would be outside
  // the walk again however well the table is guarded, so the three methods must
  // carry no colour literal of their own. Written against the mutation: paste
  // `0xff00ff` into wardingMote and this fails.
  // The scanned set is DERIVED, not typed here. Two independent derivations off
  // the palette itself must both agree with `PURITY_METHODS`: every method that
  // reads `PURITY.`, and every method whose name carries a palette word. Either
  // one alone catches a forgotten purity method, so the list cannot silently
  // fall behind `VFX`.
  //
  // Be exact about the reach, because the first draft of this comment was not
  // and a reviewer falsified it: a method with NEITHER a palette word in its
  // name NOR a `PURITY.` read enters neither derivation and is invisible to the
  // per-method scans below. `absolveGlow(pos) { e.color0.set(0xff00ff); }` is
  // the demonstrated case. Its *decimal* half is caught anyway by the file-wide
  // scan further down; its hex half is not, and belongs to whole-file literal
  // discipline — issue #163, filed for exactly this class. A hue reached
  // through a variable escapes all of it, and always did.
  const protoNames = Object.getOwnPropertyNames(VFX.prototype)
    .filter((n) => n !== 'constructor' && typeof VFX.prototype[n] === 'function');
  const bySource = protoNames.filter((n) => /\bPURITY\./.test(VFX.prototype[n].toString()));
  const stemRe = new RegExp(`(${PURITY_STEMS.join('|')})`, 'i');
  const byName = protoNames.filter((n) => stemRe.test(n));

  const declared = new Set(PURITY_METHODS);
  const excused = new Set(Object.keys(PURITY_METHOD_EXCEPTIONS));
  for (const n of bySource) {
    ok(declared.has(n),
      `${n} reads the purity palette, so it must be declared in PURITY_METHODS`);
  }
  for (const n of PURITY_METHODS) {
    ok(bySource.includes(n), `${n} is declared purity and really reads PURITY.`);
  }
  for (const n of byName) {
    ok(declared.has(n) || excused.has(n),
      `${n} wears a purity word (${PURITY_STEMS.join('/')}), so it is either a purity`
      + ' method or an explicitly excused one — silence is not an option');
  }
  for (const n of excused) {
    ok(protoNames.includes(n), `the excused ${n} still exists — stale exemptions rot`);
  }

  // Colour positions: `.set(x)`, `.setHex(x)`, `new THREE.Color(x)`, the rings'
  // third argument and the lights' second. A *numeric* literal in any of them is
  // a hue typed at the call site — which is what `16711935` was: plain decimal
  // 0xff00ff, invisible to a hex scan. Value is irrelevant; the rule is that a
  // colour position holds a name, never a number.
  //
  // `.set(0, 1, 0)` is a direction, not a colour, so the single-argument form is
  // what the setters match: a hue is always set with one number.
  const NUM = '(0x[0-9a-fA-F]+|\\d[\\d_.eE+]*)';
  const COLOUR_POSITIONS = [
    new RegExp(`\\.set(?:Hex)?\\(\\s*${NUM}\\s*\\)`, 'g'),
    new RegExp(`\\bColor\\(\\s*${NUM}\\s*[,)]`, 'g'),
    new RegExp(`\\.spawn\\(\\s*[^,()]+,\\s*[^,()]+,\\s*${NUM}`, 'g'),
    new RegExp(`\\.flick\\(\\s*[^,()]+,\\s*${NUM}`, 'g'),
  ];
  const colourLiterals = (body) => {
    const found = [];
    for (const re of COLOUR_POSITIONS) {
      re.lastIndex = 0;
      for (const m of body.matchAll(re)) found.push(m[1]);
    }
    return found;
  };

  for (const name of [...new Set([...PURITY_METHODS, ...bySource, ...byName.filter((n) => !excused.has(n))])]) {
    const body = VFX.prototype[name].toString();
    const literals = body.match(/0x[0-9a-fA-F]{3,8}/g) || [];
    ok(literals.length === 0,
      `${name} draws only declared hues — no raw colour literal (found: ${literals.join(', ') || 'none'})`);
    const positional = colourLiterals(body);
    ok(positional.length === 0,
      `${name} puts no bare number in a colour position — decimal is a colour too`
      + ` (found: ${positional.join(', ') || 'none'})`);
    ok(/PURITY\./.test(body), `${name} reads its hues from the guarded palette`);
  }

  // An excused method skips the *classification* checks, not the hue scan. Its
  // literals are pinned verbatim, so a third one arriving in `wardReflect` is a
  // failure rather than a free ride bought with a name.
  for (const [name, allowed] of Object.entries(PURITY_METHOD_EXCEPTIONS)) {
    const body = VFX.prototype[name].toString();
    const found = body.match(/0x[0-9a-fA-F]{3,8}/g) || [];
    eq(found.join(','), allowed.join(','),
      `the excused ${name} carries exactly its declared hues and no others`);
    const stray = colourLiterals(body).filter((lit) => !allowed.includes(lit));
    ok(stray.length === 0,
      `and no undeclared number in a colour position (found: ${stray.join(', ') || 'none'})`);
  }

  // The residual, narrowed where it is free. A method that neither wears a
  // palette word nor reads `PURITY.` escapes everything above — but no colour
  // position anywhere in `VFX.js` holds a decimal literal today, so that scan
  // costs an allow-list of exactly zero entries and runs over the whole file.
  // It catches `set(16711935)` wherever it is written, in a method nobody has
  // classified. The same treatment of *hex* would need ~50 allow-list entries
  // (74 hex literals sit in colour positions, all legitimately named at their
  // own call sites), which is a rival registry rather than a guard — left to
  // #163 deliberately.
  const vfxSrc = readFileSync(new URL('../src/systems/VFX.js', import.meta.url), 'utf8');
  const fileWideDecimals = colourLiterals(vfxSrc).filter((lit) => !/^0x/.test(lit));
  eq(fileWideDecimals.length, 0,
    'no colour position anywhere in VFX.js holds a decimal hue'
    + ` (found: ${fileWideDecimals.join(', ') || 'none'})`);

  // And the positional scanner can itself fail — the decimal evasion, run
  // against the check rather than merely asserted about it.
  ok(colourLiterals('e.color0.set(16711935);').length === 1,
    'a decimal hue in a colour position IS seen — the evasion that used to pass');
  ok(colourLiterals('this.rings.spawn(pos, UP, 16711935, 1, 2);').length === 1,
    'and in the rings\' hue argument too');
  eq(colourLiterals('e.dir.set(0, 1, 0);').length, 0,
    'while a three-argument direction is left alone — the scan is about hues');
  ok(colourLiterals('e.color1.setHex(0xff00ff);').length === 1,
    'and the hex form of the same position is seen too');

  // And the walk actually runs at load, rather than being an exported function
  // nobody calls.
  // `assertLanguage` is module-private, so the call is read off the file. The
  // regex is anchored on the call inside the aggregate, not on the definition.
  const effectsSrc = readFileSync(new URL('../src/data/effects.js', import.meta.url), 'utf8');
  ok(/\n\s*assertAuthoredPalette\(\);/.test(effectsSrc),
    'the palette arm is called from `assertLanguage`, at module load');
}

/* ----------------------------------------------------------- 4. the gauge */

function el() {
  const classes = new Set();
  return {
    textContent: '', attrs: {}, style: {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      set width(v) { this._w = v; }, get width() { return this._w; },
    },
    classList: {
      toggle: (c, v) => { if (v) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

function boundHUD() {
  const self = Object.create(HUD.prototype);
  self.c = {};
  self.refs = {
    corruptionPurse: el(), purseMarks: el(), purseMotes: el(),
    wardingFill: el(), sanctuaryTime: el(),
    tierGroups: { argent: el() },
    inventory: { addEventListener: () => {} },
  };
  self.toast = () => {};
  const listeners = new Map();
  const ctx = {
    events: {
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
    },
  };
  self.ctx = ctx;
  HUD.prototype.bind.call(self, ctx);
  return { self, emit: (n, p) => ctx.events.emit(n, p), listeners };
}

console.log('\nthe gauge fills toward a mote instead of jumping to one');
{
  const { self, emit, listeners } = boundHUD();
  ok(listeners.has('corruptionWarded'), '`bind` subscribes to corruptionWarded');
  ok(!self.refs.corruptionPurse.classList.contains('is-on'), 'a run that has warded nothing shows nothing');

  emit('corruptionWarded', { warded: 10, progress: 0.25, motes: 0 });
  eq(self.refs.wardingFill.style.width, '25%', 'the bar paints the partial mote');
  ok(self.refs.corruptionPurse.classList.contains('is-on'),
    'and the row lights BEFORE a mote exists — the whole point of the deliverable');
  ok(self.refs.corruptionPurse.classList.contains('has-warding'), 'warding reads as under way');
  ok(!self.refs.corruptionPurse.classList.contains('has-motes'), 'with no mote claimed yet');
  ok(/25% toward the next mote/.test(self.refs.corruptionPurse.attrs['aria-label']),
    'and the row announces it: ' + self.refs.corruptionPurse.attrs['aria-label']);

  emit('corruptionWarded', { warded: 40, progress: 0, motes: 1 });
  eq(self.refs.wardingFill.style.width, '0%', 'the bar empties as the mote is banked');
  eq(self.refs.purseMotes.textContent, '1', 'and the count takes it over');
  ok(self.refs.corruptionPurse.classList.contains('has-warding'),
    'the bar stays visible, because the next mote is already being earned');
}

console.log('\nthe sanctuary window is a clock the player can read');
{
  const { self, emit } = boundHUD();
  ok(!self.refs.corruptionPurse.classList.contains('is-sanctified'), 'no window, no chip');

  emit('voidSanctuary', { seconds: MOTE.sanctuarySeconds });
  ok(self.refs.corruptionPurse.classList.contains('is-sanctified'), 'the press opens the chip');
  eq(self.refs.sanctuaryTime.textContent, String(MOTE.sanctuarySeconds), 'showing the seconds bought');

  emit('voidSanctuaryEnd', {});
  ok(!self.refs.corruptionPurse.classList.contains('is-sanctified'), 'and expiry closes it');
  eq(self.refs.sanctuaryTime.textContent, '0', 'with the clock at zero, not stuck mid-count');
}

console.log('\nthe argent tier shows its dead state, and un-shows it');
{
  const { self } = boundHUD();
  const group = self.refs.tierGroups.argent;
  // The real method, not a re-typed copy of it: `update` does far more than the
  // argent group and would need a document, so the branch lives in
  // `setArgentGrace` and this drives that. The line below is what proves
  // `update` still calls it — delete the call and this fails.
  ok(/setArgentGrace/.test(HUD.prototype.updateMoney.toString()),
    'the per-frame pass polls the argent grace');
  ok(/updateMoney/.test(HUD.prototype.update.toString()),
    'and that pass is on the frame loop');
  const paint = (world) => self.setArgentGrace({ corruption: { world } });

  paint(0);
  ok(!group.classList.contains('is-graceless'), 'a pristine world leaves the tier alive');
  eq(group.style._p['--grace'], '1', 'at full pay');

  paint(ARGENT.fadeAt / 2);
  ok(!group.classList.contains('is-graceless'), 'half-way is not dead');
  eq(group.style._p['--grace'], '0.5', 'but it visibly fades on the way — half pay reads as half');

  paint(ARGENT.fadeAt);
  ok(group.classList.contains('is-graceless'), 'at Overrun the tier is marked spent');
  eq(group.style._p['--grace'], '0', 'with nothing left to pay');
  ok(/spent/.test(group.attrs.title), 'and says why: ' + group.attrs.title);

  paint(ARGENT.fadeAt * 2);
  ok(group.classList.contains('is-graceless'), 'past Overrun it stays spent rather than going negative');

  // The half that a latched implementation would fail.
  paint(0);
  ok(!group.classList.contains('is-graceless'),
    'and grace bought back at a font brings the tier straight back');
  eq(group.style._p['--grace'], '1', 'to full pay');
}

/* ------------------------------------------------- 5. the two paid presses */

console.log('\nSanctuary and Consecration stop sounding like a chest');
{
  const f = makeCtx();
  const calls = [];
  f.ctx.vfx = {
    burst: () => calls.push('burst'),
    sanctuaryOpen: () => calls.push('vfx:sanctuary'),
    consecration: () => calls.push('vfx:consecrate'),
  };
  f.ctx.audio = {
    play: (n) => calls.push(`play:${n}`),
    sanctuary: () => calls.push('audio:sanctuary'),
    consecrate: () => calls.push('audio:consecrate'),
  };
  const cor = f.ctx.corruption;
  // Fed and bled in equal measure, the fixture idiom from
  // tests/argent-reliquary.test.mjs: the world lands back at Pristine so no
  // band's own bargain stands and the purity offer is the one being pressed.
  cor.feed(f.ctx.player, MOTE.per * 2);
  cor.bleed(f.ctx.player, MOTE.per * 2);
  ok(cor.motes >= 1, 'a mote in the purse');

  const altar = new VoidBargain(f.ctx, new THREE.Vector3(5, 0, 5), 0);
  ok(altar.offer()?.kind === 'sanctuary', 'the standing offer really is the window');
  ok(altar.interact(f.ctx.player) === true, 'the Sanctuary press goes through');
  ok(calls.includes('vfx:sanctuary'), 'and draws its own effect');
  ok(calls.includes('audio:sanctuary'), 'and plays its own voice');
  ok(!calls.includes('play:shrineWin'), 'not the shrine payout every other prop plays');
  ok(!calls.includes('burst'), 'and not the generic burst');

  // Consecration: bank to the deeper rung on a second fixture.
  const g = makeCtx();
  const gcalls = [];
  g.ctx.vfx = {
    burst: () => gcalls.push('burst'),
    consecration: () => gcalls.push('vfx:consecrate'),
  };
  g.ctx.audio = {
    play: (n) => gcalls.push(`play:${n}`),
    consecrate: () => gcalls.push('audio:consecrate'),
  };
  const gcor = g.ctx.corruption;
  gcor.feed(g.ctx.player, MOTE.per * RELIQUARY.motes);
  gcor.bleed(g.ctx.player, MOTE.per * RELIQUARY.motes);
  ok(gcor.motes >= RELIQUARY.motes, `${RELIQUARY.motes} motes in the purse`);
  const relic = new VoidBargain(g.ctx, new THREE.Vector3(6, 0, 6), 0);
  ok(relic._argent()?.kind === 'consecrate', 'the altar is offering the deeper rung');
  ok(relic.interact(g.ctx.player) === true, 'the Consecration press goes through');
  ok(gcalls.includes('vfx:consecrate'), 'and draws its own effect');
  ok(gcalls.includes('audio:consecrate'),
    'and has a voice at all, which the most expensive press on the route did not');
  ok(!gcalls.includes('play:shrineWin'), 'and is not the shrine payout either');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
