/**
 * Finds silently-dead cross-system calls.
 *
 * Every system reaches other systems through `ctx.<system>?.<method>?.(...)`.
 * Optional chaining was mandated so a system coming up late could not throw —
 * but it also turns a method that DOESN'T EXIST into a permanent no-op with no
 * error, no log, and no symptom until a player notices a feature missing. Five
 * shipped bugs in this project had exactly that shape.
 *
 * This scans every such call site statically, then boots the real game and
 * asks each live system what methods it actually has, and reports the
 * difference.
 *
 *   node tools/apicheck.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SRC = path.resolve('src');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// One regex for both forms; call-vs-property is decided by looking at what
// follows the match. Doing that discrimination inside the regex (a negative
// lookahead after `\w+`) lets the engine backtrack a character to satisfy it,
// so every method call also matched as a property with its last letter shaved
// off — `addShake` reported as a dead read of `addShak`.
const REF = /(?:this\.)?ctx\.(\w+)\?\.(\w+)/g;

const files = await walk(SRC);
const calls = new Map();   // "system.method" -> [{file, line}]
const props = new Map();

for (const f of files) {
  const text = await readFile(f, 'utf8');
  const lines = text.split('\n');
  const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
  REF.lastIndex = 0;
  let m;
  while ((m = REF.exec(text))) {
    const key = `${m[1]}.${m[2]}`;
    const line = text.slice(0, m.index).split('\n').length;
    if (lines[line - 1]?.trimStart().startsWith('*')) continue; // in a doc comment
    // `?.(` or `(` immediately after the identifier means it is being invoked.
    const rest = text.slice(m.index + m[0].length);
    const sink = /^\s*\??\s*\(/.test(rest) ? calls : props;
    if (!sink.has(key)) sink.set(key, []);
    sink.get(key).push(`${rel}:${line}`);
  }
}

// --- boot the real game and introspect the live systems ---------------------
const server = await createServer({ server: { port: 5205, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? [] : ['--window-position=-2400,-2400', '--window-size=1280,720'];
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', ...OFFSCREEN],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
await page.goto('http://127.0.0.1:5205/?seed=1337&quality=1&harness=1', { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
// Let every system finish init and publish itself onto ctx.
await page.evaluate(() => globalThis.__HARNESS__.gameplay());
await page.waitForTimeout(1500);

const live = await page.evaluate(() => {
  const { ctx } = globalThis.__GAME__;
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (!v || typeof v !== 'object') continue;
    const names = new Set();
    // Own properties plus the prototype chain, so class methods are included.
    for (let o = v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    out[k] = [...names];
  }
  out.__present = Object.keys(ctx).filter((k) => ctx[k] != null);
  return out;
});

await browser.close();
await server.close();

// --- report -----------------------------------------------------------------
const deadCalls = [];
const deadProps = [];
const unknownSystems = new Set();

for (const [key, sites] of calls) {
  const [sys, method] = key.split('.');
  if (!live[sys]) { unknownSystems.add(sys); continue; }
  if (!live[sys].includes(method)) deadCalls.push({ key, sites });
}
for (const [key, sites] of props) {
  const [sys, prop] = key.split('.');
  if (!live[sys]) continue;
  if (!live[sys].includes(prop)) deadProps.push({ key, sites });
}

const fmt = (rows) => rows
  .sort((a, b) => b.sites.length - a.sites.length)
  .map((r) => `  ${r.key.padEnd(34)} ${r.sites.length} site(s)  ${r.sites.slice(0, 3).join(', ')}`)
  .join('\n');

console.log(`scanned ${files.length} files`);
console.log(`ctx systems live at runtime: ${live.__present.join(', ')}\n`);
console.log(`=== DEAD METHOD CALLS (${deadCalls.length}) — optional-chained to a method that does not exist ===`);
console.log(deadCalls.length ? fmt(deadCalls) : '  none');
console.log(`\n=== DEAD PROPERTY READS (${deadProps.length}) — may be legitimately undefined, review each ===`);
console.log(deadProps.length ? fmt(deadProps) : '  none');
if (unknownSystems.size) {
  console.log(`\n=== ctx keys referenced but absent at runtime ===\n  ${[...unknownSystems].join(', ')}`);
}
process.exit(deadCalls.length ? 1 : 0);
