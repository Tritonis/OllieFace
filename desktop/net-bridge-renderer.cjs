/**
 * The renderer half of the Steam bridge, LIFTED OUT OF `desktop/preload.cjs`.
 *
 * This file holds no copy of the code. `preload.cjs` cannot require anything
 * project-local -- Electron's sandboxed preload loader resolves built-ins only,
 * and a relative require there took the whole desktop bridge down once already
 * (#128) -- so the bridge lives inline in that file, and this module reads it
 * back out of the source between the `net-bridge-renderer` markers and compiles
 * it for `tests/transport-steam-bridged.mjs`.
 *
 * That indirection is the point. The contract suite asserts against the exact
 * characters the shell runs; for a test to pass against a stale twin there
 * would have to BE a twin, and there is not one.
 *
 * Test-only, and node-only: nothing in `desktop/` or `src/` imports it, and
 * nothing may -- see the shouting comment at the top of `preload.cjs`.
 */
const fs = require('node:fs');
const path = require('node:path');

const PRELOAD = path.join(__dirname, 'preload.cjs');
const OPEN = '// >>> net-bridge-renderer >>>';
const CLOSE = '// <<< net-bridge-renderer <<<';

function extract() {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const a = src.indexOf(OPEN);
  const b = src.indexOf(CLOSE);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(`desktop/preload.cjs has no net-bridge-renderer block between ${OPEN} and ${CLOSE}`);
  }
  return src.slice(src.indexOf('\n', a) + 1, b);
}

// The shell's own source, compiled. `new Function` rather than `require`
// because there is nothing to require: the code has no module of its own.
const createNetBridgeRenderer = new Function(`${extract()}\nreturn createNetBridgeRenderer;`)();
if (typeof createNetBridgeRenderer !== 'function') {
  throw new Error('the net-bridge-renderer block in desktop/preload.cjs defined no createNetBridgeRenderer');
}

module.exports = { createNetBridgeRenderer, PRELOAD, MARKERS: { OPEN, CLOSE } };
