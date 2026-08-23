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
 *  2. both mote sources are marked, and they are marked at *one* site: `bleed`
 *     has exactly two callers and `VFX` rides the event rather than the call
 *     sites, so the test presses a real Argent Font and lands a real
 *     Voidtouched kill and expects the same cue from both.
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
