// tests/install-health.test.mjs
//
// node_modules/.bin is a common casualty of a partial install here: npm links
// bins at the *end* of reify, so an install that dies partway (koffi/CMake,
// EBUSY on a zombie Electron) leaves .bin sparse or entirely missing, and an
// agent under pressure has hand-written a shim to unblock a build arm rather
// than fixing the install (#83). A two-line forgery runs the right binary
// just well enough to hide the real fault until the next machine hits it.
//
// This is a *static* check against local machine state, deliberately: it
// reads root package.json's scripts and node_modules/.bin, and asserts every
// binary those scripts invoke is present and is an npm-generated shim, not a
// hand-written one. node_modules is gitignored, so this test's very reason
// to exist is to assert something git cannot — it belongs in the cheap tier
// via `npm test` for exactly that reason.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const binDir = join(root, 'node_modules', '.bin');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// The binaries this repo's own scripts must be able to run. Pinned by name so
// that an extractor which silently stops finding anything is itself a
// failure, rather than a green suite sitting on top of a blind check — the
// dominant defect shape in this repo (see tests/probe-ports.test.mjs).
const KNOWN_BINARIES = ['vite', 'electron', 'electron-builder'];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};

let binEntries = [];
let binListReadable = true;
try {
  binEntries = readdirSync(binDir);
} catch {
  binListReadable = false;
}
// Basenames without the .cmd/.ps1 extension, so `vite`, `vite.cmd`, `vite.ps1`
// all collapse to one claim of `vite`.
const binNames = new Set(binEntries.map((f) => f.replace(/\.(cmd|ps1)$/i, '')));

/**
 * Every whitespace-delimited first token of every `&&` / `||` / `;` / `|`
 * separated segment of a script string, e.g. "npm run build && electron ."
 * yields ["npm", "electron"]. This is the same "first token of a command
 * segment" idiom as the shell scripts themselves use to invoke a binary.
 */
function firstTokensOf(script) {
  return script
    .split(/&&|\|\||[;|]/)
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter(Boolean);
}

console.log('the scan finds something to check');
{
  ok(Object.keys(scripts).length > 5, `scanned ${Object.keys(scripts).length} package.json scripts`);
  ok(binListReadable, `node_modules/.bin is readable at ${binDir}`);
}

// Extract every script-invoked token that is also a real .bin entry. This is
// the "filtered to those that appear in node_modules/.bin" heuristic from the
// spec: it naturally excludes `node` and repo-local script paths (they are
// not .bin entries), with no hand-maintained exclusion list to go stale.
const invokedBinaries = new Set();
for (const script of Object.values(scripts)) {
  for (const token of firstTokensOf(script)) {
    if (binNames.has(token)) invokedBinaries.add(token);
  }
}

console.log('the extractor still recognises the binaries this repo depends on');
{
  // If a refactor changes how scripts are written (a new separator, a
  // wrapper script) and the extractor above stops matching, `invokedBinaries`
  // silently empties and every downstream check would vacuously pass. Pin
  // the known set by name so that going blind is a named failure, not green.
  for (const name of KNOWN_BINARIES) {
    ok(invokedBinaries.has(name), `the extractor still sees "${name}" invoked from package.json scripts`);
  }
}

console.log('every invoked binary has a node_modules/.bin entry');
{
  for (const name of invokedBinaries) {
    ok(binNames.has(name), `"${name}" has an entry in node_modules/.bin`);
  }
}

/**
 * npm's generated Windows .cmd shim carries a `:find_dp0` preamble and is
 * well over a dozen lines; a hand-written forgery (the #83 incident) was two
 * lines: `@ECHO off` and a bare `exec node ../pkg/bin/x.js`. Both the
 * preamble text and a minimum line count are checked, so a forgery that
 * copies one but not the other still fails.
 */
function assertNpmGeneratedCmd(name) {
  const cmdPath = join(binDir, `${name}.cmd`);
  if (!existsSync(cmdPath)) {
    ok(false, `${name}.cmd exists at ${cmdPath} (cannot verify shim provenance without it)`);
    return;
  }
  const src = readFileSync(cmdPath, 'utf8');
  const lines = src.split(/\r\n|\n/).filter((l) => l.length > 0);
  ok(/:find_dp0/.test(src), `${name}.cmd carries npm's :find_dp0 preamble`);
  ok(lines.length >= 10, `${name}.cmd has >=10 non-blank lines (has ${lines.length}) — a hand-written forgery is ~2, npm's template ~15+; 10 leaves margin against npm trimming a line`);
}

/**
 * npm also emits an extensionless POSIX shim alongside the .cmd, used on
 * WSL/Git-Bash. It follows a ~14-line `#!/bin/sh` / `basedir=` template.
 * Checked only when the file exists — its absence is not itself a defect,
 * but if it exists and looks wrong, that is.
 */
function assertNpmGeneratedSh(name) {
  const shPath = join(binDir, name);
  if (!existsSync(shPath)) return; // not every install carries this file; absence is not asserted
  const src = readFileSync(shPath, 'utf8');
  const lines = src.split(/\r\n|\n/).filter((l) => l.length > 0);
  ok(/^#!\/bin\/sh/.test(src), `${name} (extensionless) starts with the npm sh template's shebang`);
  ok(/basedir=/.test(src), `${name} (extensionless) declares basedir= per the npm sh template`);
  ok(lines.length >= 12, `${name} (extensionless) has >=12 non-blank lines (has ${lines.length})`);
}

console.log('invoked binaries are npm-generated shims, not hand-written forgeries');
{
  for (const name of invokedBinaries) {
    assertNpmGeneratedCmd(name);
    assertNpmGeneratedSh(name);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
