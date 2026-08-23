/**
 * The showcase's enemy-attack entries claim to fire down the real path
 * (CLAUDE.md: "Effects fire down their real paths ... there is no mixer bypass
 * to find"). For all 52 of them that claim used to be false: they were
 * hand-written stand-ins — a ring, a blip, an `explosion()` with three
 * arguments — and the moment play grew a windup ring, a held element voice and
 * an element-tinted nova core (#151), the stand-ins began staging the *absence*
 * of precisely what the #149 jury presets were convened to judge.
 *
 * So this test refuses "an entry exists" as evidence and asks the real modules
 * what happened. It installs the showcase over a recording ctx whose
 * `director.spawnOne` builds a real `Enemy`, fires a nova entry and a beam
 * entry, steps the real `fixedUpdate` across the window, and insists on the
 * three things a stand-in cannot produce:
 *
 *   1. the nova's `explosion` carries a fourth argument — `enemyCore(element)`,
 *      which *is* #151's C2 fix, and which a three-argument stand-in leaves as
 *      the fixed warm centre that made thirteen novas one nova;
 *   2. the window holds a rising voice in the attacker's element and *returns*
 *      it when the window ends;
 *   3. the beam finds `elementBeam`, not the universal `shoot` blip.
 *
 * And the budget clause: closing the showcase mid-window must release every
 * held voice. A leaked windup chord would poison the very voice-budget
 * evidence these presets exist to collect.
 */
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { attackElement, enemyCore } from '../src/data/elementVoice.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`PASS  ${msg}`); } else { fail++; console.log(`FAIL  ${msg}`); } };

/* -- the thinnest DOM the overlay can be built against --------------------- */
const el = () => {
  const node = {
    style: { cssText: '' }, textContent: '', innerHTML: '', id: '',
    children: [],
    append: (...k) => node.children.push(...k),
    appendChild: (k) => { node.children.push(k); return k; },
    scrollIntoView() {}, remove() {},
  };
  return node;
};
globalThis.document = { createElement: el, body: el() };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { installShowcase } = await import('../src/core/Showcase.js');

function makeRng(seed = 1234) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

function makeWorld() {
  const rec = { explosions: [], voices: [], beams: [], telegraphs: [] };
  const ctx = {
    rng: makeRng(), time: 0, scene: new THREE.Scene(),
    events: { emit() {}, on() {} },
    camera: { position: { x: 0, y: 2, z: 0 }, getWorldDirection: (v) => v.set(0, 0, -1) },
    stage: { sampleHeight: () => 0 },
  };
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 110, maxHealth: 110, iframeSeconds: 0,
    grantIFrames(s) { this.iframeSeconds = Math.max(this.iframeSeconds, s); },
    takeDamage() { return 0; },
  };
  const roster = new Roster();
  roster.init(ctx);
  ctx.player = player;
  roster.add(player);

  const enemies = [];
  ctx.director = {
    enemies,
    spawnOne(c, card, at) {
      const e = new Enemy();
      e.spawn(c, card, { x: at.x, y: at.y, z: at.z }, {});
      enemies.push(e);
      return e;
    },
    spawnTelegraph: (x, z, r, life, colour) => rec.telegraphs.push({ r, life, colour }),
    spawnWave() {}, spawnBeamTrail() {}, denyHealing() {},
  };
  ctx.vfx = {
    explosion: (...args) => rec.explosions.push(args),
    beams: { spawn() {} }, lights: { flick() {} }, impact() {},
  };
  ctx.audio = {
    windupVoice(pos, element) {
      const v = { element, released: false, release() { this.released = true; }, move() {} };
      rec.voices.push(v);
      return v;
    },
    elementBeam: (pos, element) => rec.beams.push(element),
    play() {}, explosion() {}, elementTransient() {}, elementTick() {},
  };
  return { ctx, rec, enemies, player };
}

const step = (ctx, enemies, seconds) => {
  const h = 1 / 60;
  for (let t = 0; t < seconds; t += h) {
    for (const e of [...enemies]) e.fixedUpdate(ctx, h);
    ctx.time += h;
  }
};

/* -- 1. a nova entry reaches the real nova, core colour and all ------------ */
console.log('-- a nova showcase entry fires the real nova');
{
  const { ctx, rec, enemies, player } = makeWorld();
  const api = installShowcase(ctx);
  const entry = api.entries.find((e) => e.meta.kind === 'nova');
  ok(!!entry, 'the catalogue has a nova entry to fire');

  const { SPAWN_CARDS, BOSS_CARDS } = await import('../src/data/enemies.js');
  const card = [...SPAWN_CARDS, ...BOSS_CARDS].find((c) => c.id === entry.meta.cardId);
  const a = card.attacks.find((x) => x.id === entry.meta.attackId);
  const wantCore = enemyCore(attackElement(a));

  entry.fire(0);
  ok(enemies.length === 1, 'a real unit off the card was stood up');
  ok(player.iframeSeconds > 0, 'the evaluator is inside a mercy window while it lands');

  step(ctx, enemies, (a.windup ?? 0.6) * 0.6);
  ok(rec.voices.length === 1 && rec.voices[0].element === attackElement(a),
    `the window holds a rising voice in the attack's element (${attackElement(a)})`);
  ok(rec.telegraphs.length >= 1, 'and draws a ground ring for the window');
  ok(rec.explosions.length === 0, 'nothing has released yet, mid-window');

  step(ctx, enemies, (a.windup ?? 0.6) * 0.6 + 0.4);
  ok(rec.voices[0].released, 'the held voice is returned when the window ends');
  ok(rec.explosions.length >= 1, 'the nova released');
  const call = rec.explosions[0];
  ok(call.length === 4 && call[3] === wantCore,
    `the nova core carries enemyCore('${attackElement(a)}') = 0x${wantCore.toString(16)} ` +
    `(got ${call[3] == null ? String(call[3]) : `0x${Number(call[3]).toString(16)}`})`);
  api.dispose();
}

/* -- 2. a beam entry reaches its own throat -------------------------------- */
console.log('-- a beam showcase entry reaches elementBeam, not the universal blip');
{
  const { ctx, rec, enemies } = makeWorld();
  const api = installShowcase(ctx);
  const entry = api.entries.find((e) => e.meta.kind === 'beam');
  ok(!!entry, 'the catalogue has a beam entry to fire');
  entry.fire(0);
  const { SPAWN_CARDS, BOSS_CARDS } = await import('../src/data/enemies.js');
  const card = [...SPAWN_CARDS, ...BOSS_CARDS].find((c) => c.id === entry.meta.cardId);
  const a = card.attacks.find((x) => x.id === entry.meta.attackId);
  step(ctx, enemies, (a.windup ?? 1) + 0.3);
  ok(rec.beams.length >= 1 && rec.beams[0] === attackElement(a),
    `the beam sounds its own element (${attackElement(a)})`);
  ok(rec.voices.length >= 1 && rec.voices[0].released,
    'and its charge voice was returned at the end of the window');
  api.dispose();
}

/* -- 3. closing mid-window returns every held voice ------------------------ */
console.log('-- closing the showcase mid-window returns every held voice');
{
  const { ctx, rec, enemies } = makeWorld();
  const api = installShowcase(ctx);
  const entry = api.entries.find((e) => e.meta.kind === 'nova');
  entry.fire(0);
  step(ctx, enemies, 0.2);
  ok(rec.voices.length === 1 && !rec.voices[0].released, 'a voice is held mid-window');
  api.close();
  ok(rec.voices[0].released, 'closing the showcase released it');
  ok(enemies.length === 0, 'and retired the demonstrator');
  api.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
