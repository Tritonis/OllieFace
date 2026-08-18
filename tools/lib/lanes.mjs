// tools/lib/lanes.mjs — the parallel-lane port blocks, in one place.
//
// CLAUDE.md hands each concurrent work lane a block of ten ports so that two
// agents running the same gate from two worktrees cannot collide (#68). Until
// now that table lived only in prose, and every brief had to restate three
// port numbers per command. `--lane A|B|C` derives the whole block from one
// flag instead.
//
// WHY A MODULE AND NOT A LITERAL IN EACH TOOL. `tests/probe-ports.test.mjs`
// answers "does any two scripts claim the same default port?" by scanning the
// *source text* of `tools/*.mjs` and `tests/sp-equivalence.mjs` with regexes.
// A lane mapping that existed only as runtime arithmetic would be invisible to
// that scan: the ports a lane actually binds would stop being a thing the
// collision detector could reason about, which is the "guard that reports green
// on a question it can no longer ask" shape this repo keeps getting bitten by.
// So the blocks are declared once, here, as data — and probe-ports *imports*
// this table (rather than pattern-matching it) and asserts that no scanned
// script's default port falls inside any lane block. The invariant CLAUDE.md
// states in prose — "nothing in tools/ or tests/ claims above 5236, so 5240+ is
// free by construction" — is now a check that can go red.
//
// THIS DIRECTORY IS SCANNED. It was not when this file was written, and the
// note that used to sit here said so — which stopped being true at `5eb0b17`,
// when the scan became recursive. Anyone who trusted the old note and put a
// port default under `tools/lib/` would now meet a red test and read it as
// somebody else's bug.
//
// The table below still contributes no claims, but by naming rather than by
// location: probe-ports counts a port only where the identifier or object key
// says "port", and `LANE_BASES` is keyed by lane name. A real bind written in
// this file — `const PORT = 5240`, or `{ port: 5240 }` — is caught here exactly
// as it would be anywhere else, and probe-ports asserts both halves.

/** How many ports one lane owns: base .. base + SIZE - 1. */
export const LANE_BLOCK_SIZE = 10;

/** Lane name -> the first port of its block. Matches CLAUDE.md's lane table. */
export const LANE_BASES = Object.freeze({ A: 5240, B: 5250, C: 5260 });

export const LANE_NAMES = Object.freeze(Object.keys(LANE_BASES));

/** Every port a lane owns, as a half-open range [from, to). */
export function laneBlock(name) {
  const base = laneBase(name);
  return { from: base, to: base + LANE_BLOCK_SIZE };
}

/** Resolves a lane name (case-insensitive) to its port base, or throws. */
export function laneBase(name) {
  const key = String(name ?? '').toUpperCase();
  const base = LANE_BASES[key];
  if (base === undefined) {
    throw new Error(
      `unknown lane ${JSON.stringify(name)} — expected one of ${LANE_NAMES.join(', ')}\n`
      + LANE_NAMES.map((n) => `    ${n}: ${LANE_BASES[n]}-${LANE_BASES[n] + LANE_BLOCK_SIZE - 1}`).join('\n'),
    );
  }
  return base;
}

/** The lane owning `port`, or null. Used by probe-ports to report a trespass. */
export function laneOwning(port) {
  for (const n of LANE_NAMES) {
    const { from, to } = laneBlock(n);
    if (port >= from && port < to) return n;
  }
  return null;
}
