/**
 * Tiny argv parser shared by the repo's lane-aware tools (#162).
 *
 * Every hand-rolled parser this repo grew accepted only `--flag value`, so
 * `--lane=A` (a spelling every one of these tools' own examples never uses,
 * but that a caller reaches for reflexively) silently fell through to the
 * flag's default — the #68/#158 silent-default failure via a different
 * spelling. This helper accepts both `--flag value` and `--flag=value`, plus
 * bare boolean flags (`--no-signal`, or any flag immediately followed by
 * another flag or nothing), in one place.
 */

/**
 * Parse argv (typically `process.argv.slice(2)`) into a flat object keyed by
 * camelCase flag name. `--foo-bar value` / `--foo-bar=value` both become
 * `fooBar: value`; a flag with no following value (end of argv, or the next
 * token is itself a `--flag`) becomes `true`.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|true>}
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.match(/^--([\w-]+)=(.*)$/);
    if (eq) {
      if (eq[2] === '') {
        throw new Error(`--${eq[1]}= was given an empty value — drop the '=' for a boolean flag, or supply a value.`);
      }
      args[camel(eq[1])] = eq[2];
      continue;
    }
    const bare = tok.match(/^--([\w-]+)$/);
    if (!bare) continue;
    const key = camel(bare[1]);
    const next = argv[i + 1];
    if (next === undefined || /^--/.test(next)) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function camel(name) {
  return name.replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

/**
 * Find a flag's value in a raw argv array, honoring both `--flag value` and
 * `--flag=value`. For call sites that index into argv directly (gates.mjs,
 * sp-equivalence.mjs) rather than pre-parsing into an object. Returns
 * `undefined` if the flag is absent.
 *
 * @param {string[]} argv
 * @param {string} flag  e.g. '--lane'
 * @returns {string|undefined}
 */
export function argValue(argv, flag) {
  const eqPrefix = `${flag}=`;
  const eqTok = argv.find((t) => t.startsWith(eqPrefix));
  if (eqTok !== undefined) {
    const value = eqTok.slice(eqPrefix.length);
    if (value === '') {
      throw new Error(`${flag}= was given an empty value — supply a value after '='.`);
    }
    return value;
  }
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * True if `flag` appears in argv, in either `--flag` or `--flag=value` form.
 *
 * @param {string[]} argv
 * @param {string} flag
 * @returns {boolean}
 */
export function hasArg(argv, flag) {
  const eqPrefix = `${flag}=`;
  return argv.includes(flag) || argv.some((t) => t.startsWith(eqPrefix));
}
