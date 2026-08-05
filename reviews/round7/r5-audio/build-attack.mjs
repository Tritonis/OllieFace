/**
 * Builds `gate-attack.mjs`: a byte-faithful copy of the SHIPPED `tools/capture.mjs`
 * with a `--sabotage=<arm>` switch injected and nothing else changed.
 *
 * The arms here are deliberately different from round 4's six. Round 4 proved the
 * gate catches *silence* (a graph that produces nothing). These arms produce
 * audio that is loud, continuous and wrong — the class the gate's design cannot
 * distinguish from correct — plus one that never touches the music engine at all.
 *
 *   node reviews/round7/r5-audio/build-attack.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';

const SRC = 'tools/capture.mjs';
const DST = 'reviews/round7/r5-audio/gate-attack.mjs';

let s = await readFile(SRC, 'utf8');
const L = (...lines) => lines.join('\n');

// --- 1. the flag -----------------------------------------------------------
const anchor1 = "const SOFTWARE = 'software' in args;";
if (!s.includes(anchor1)) throw new Error('anchor 1 missing');
s = s.replace(anchor1, L(
  'const SABOTAGE = args.sabotage ? String(args.sabotage) : null;',
  anchor1));

// --- 2. an init-script arm, installed before any product code runs ---------
const anchor2 = "log('navigating...');";
if (!s.includes(anchor2)) throw new Error('anchor 2 missing');
s = s.replace(anchor2, L(
  "if (SABOTAGE === 'sfxdead') {",
  '  // The whole SFX catalogue, silent: every emitter still runs, still counts',
  '  // voices, still throttles and still gates — and creates no source node. The',
  "  // music engine has its own private _osc/_noise and is untouched, so the",
  '  // soundtrack is unaffected and only the game world goes quiet.',
  '  await page.addInitScript(() => {',
  '    const iv = setInterval(() => {',
  '      const a = globalThis.__GAME__?.ctx?.audio;',
  '      if (!a) return;',
  '      const P = Object.getPrototypeOf(a);',
  '      P._tone = function () { return {}; };',
  '      P._noise = function () { return {}; };',
  '      clearInterval(iv);',
  '    }, 25);',
  '  });',
  '}',
  anchor2));

// --- 3. the in-page arms, after the graph is up and before the gate arms ---
const anchor3 = "  await page.keyboard.press('KeyZ');";
if (!s.includes(anchor3)) throw new Error('anchor 3 missing');
s = s.replace(anchor3, L(
  anchor3,
  "  if (SABOTAGE && SABOTAGE !== 'sfxdead') {",
  '    const applied = await page.evaluate((arm) => {',
  '      const a = globalThis.__GAME__?.ctx?.audio;',
  "      if (!a?.ac) return 'NO AUDIO GRAPH';",
  '      const after = (fn) => { const orig = a.beginRun.bind(a); a.beginRun = () => { orig(); fn(); }; };',
  '      switch (arm) {',
  "        case 'killkit':",
  '          // Eight of the ten layers never reach the bus again. The gate revives',
  '          // the engine with reset(), which puts the run clock back to zero, so',
  '          // the only two layers it was ever going to hear are the two left.',
  '          after(() => {',
  '            for (const [n, Ly] of a.musicEngine.layers) {',
  "              if (n !== 'sub' && n !== 'pad') { try { Ly.g.disconnect(); } catch { /* already */ } }",
  '            }',
  '          });',
  "          return 'kick/hat/bass/openhat/clap/perc/acid/lead unwired from the bus';",
  "        case 'dconly':",
  "          // The music engine is unwired exactly as round 4's `unwired` arm does",
  '          // it — and a DC source that is not the game is connected to the music',
  '          // bus in its place. Nothing about this is the soundtrack.',
  '          after(() => {',
  '            a.musicEngine.duck.disconnect();',
  '            for (const Ly of a.musicEngine.layers.values()) { try { Ly.g.disconnect(); } catch { /* already */ } }',
  '            const dc = a.ac.createConstantSource();',
  '            dc.offset.value = 0.03;',
  '            dc.connect(a.music);',
  '            dc.start();',
  '            globalThis.__DC__ = dc;',
  '          });',
  "          return 'engine unwired; 0.03 DC injected into the music bus';",
  "        case 'wrongtempo':",
  '          // 600 bpm. Every note still fires; the arrangement is unrecognisable.',
  '          after(() => {',
  "            Object.defineProperty(a.musicEngine, 'bpm', { get: () => 600, set() {}, configurable: true });",
  '          });',
  "          return 'bpm pinned to 600';",
  "        case 'blown':",
  '          // 25x on the master. Everything is audible; all of it is destroyed.',
  '          after(() => {',
  '            a.master.gain.cancelScheduledValues(a.ac.currentTime);',
  '            a.master.gain.setValueAtTime(25, a.ac.currentTime);',
  '          });',
  "          return 'master gain 25x';",
  '        default:',
  "          return 'UNKNOWN ARM ' + arm;",
  '      }',
  '    }, SABOTAGE);',
  "    log('SABOTAGE[' + SABOTAGE + ']: ' + applied);",
  '    manifest.sabotage = { arm: SABOTAGE, applied };',
  '  }'));

await writeFile(DST, s);
console.log('wrote ' + DST + ' (' + s.length + ' bytes)');
