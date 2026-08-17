// tests/undefined-idents.test.mjs
//
// On 2026-08-17, `src/ui/Menus.js` called `shouldArmTutorial(...)` without
// ever importing it from `src/systems/Tutorial.js`. It is legal JavaScript —
// a free identifier only fails at runtime — so `npm run gates:cheap`
// (test + build + audit) passed identically before and after the fix, and
// `gate:sp` never exercises `Menus.launch`. It shipped to master and broke
// Play at launch, and was found only because a co-op probe happened to drive
// the real UI.
//
// This is a static, scope-*insensitive* guard against exactly that class of
// defect: for every bare call expression `foo(...)` in a `src/**/*.js` file,
// confirm `foo` is imported, declared somewhere in the file, or an
// allowlisted global. There is no AST parser available in this tree (vite 8
// here runs on rolldown, a Rust bundler with no bundled JS parser; no
// `acorn`/`espree`/etc. exists anywhere under `node_modules`), and the spec
// for this guard is explicit that a new runtime dependency is not to be
// added without saying so — so this is deliberately NOT a real parser. It is
// a tokenizer: comments and string/template literals are stripped, then
// identifiers are matched against a "names available anywhere in this file"
// pool built from import specifiers, declarations, and parameters.
//
// WHAT THIS CATCHES: a call to a name that is not imported, not declared
// anywhere in the file (module scope OR any nested scope), and not on the
// curated global allowlist below. That is exactly the `shouldArmTutorial`
// shape: a rename, a deleted import, a copy-pasted call with no import added.
//
// WHAT THIS DOES NOT CATCH:
//   - Shadowing bugs (a name declared in the wrong scope but present
//     *somewhere* in the file passes, because the pool is file-wide, not a
//     real scope tree).
//   - Property/method access (`obj.foo()`) — deliberately out of scope; a
//     typo'd method call is a distinct defect shape from a missing import
//     and needs type information this tokenizer does not have.
//   - Anything not shaped like `identifier(` — a value passed as a bare
//     reference (`setTimeout(tick, 16)` is fine, `tick` itself unchecked as
//     a non-call reference) is not checked.
//   - Dynamic globals reached only through `window.x` or `globalThis.x`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Curated global allowlist: browser/runtime globals actually used in this
// tree, plus the handful of built-in constructors/objects invoked as bare
// calls. Deliberately NOT "anything in globalThis" — the point is to catch
// typos, and a huge allowlist defeats that.
const GLOBALS = new Set([
  // browser / DOM
  'window', 'document', 'navigator', 'performance', 'localStorage',
  'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'console', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'structuredClone', 'queueMicrotask', 'addEventListener', 'removeEventListener',
  'dispatchEvent', 'getComputedStyle', 'matchMedia', 'crypto',
  // constructors / built-ins invoked as bare calls (`new` and plain)
  'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Number', 'String', 'Boolean', 'Symbol', 'Date', 'RegExp', 'Proxy',
  'Function', 'ArrayBuffer', 'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'DataView', 'ImageData', 'AudioContext', 'OfflineAudioContext',
  'Uint8ClampedArray', 'TextEncoder', 'TextDecoder',
  'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI',
  'Image', 'Audio', 'Worker', 'MessageChannel', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'CustomEvent', 'Event', 'AbortController',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver',
  'WebSocket', 'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate',
  'XMLHttpRequest', 'FormData', 'Headers', 'Request', 'Response',
  // namespaced globals invoked as `Math.foo(`, `JSON.foo(` — the identifier
  // matched is the namespace itself when used bare (rare) or is skipped
  // entirely because these are always property access (`Math.random()`),
  // which this checker does not flag in the first place. Listed anyway for
  // completeness/documentation.
  'Math', 'JSON', 'Reflect', 'Intl',
  // Node/Electron-adjacent globals that leak into a handful of desktop-aware
  // modules under src/
  'require', 'process', 'Buffer', 'globalThis', 'gc',
  // language keywords that can precede `(` and are never call targets, kept
  // here as a defensive belt (the KEYWORDS set below is the real filter)
]);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'in', 'of', 'new', 'class', 'extends', 'super', 'this', 'yield', 'await',
  'delete', 'void', 'instanceof', 'else', 'try', 'finally', 'do', 'throw',
  'with', 'case', 'break', 'continue', 'default', 'const', 'let', 'var',
  'import', 'export', 'from', 'as', 'static', 'get', 'set', 'async',
  'true', 'false', 'null', 'undefined',
]);

/**
 * Strip comments and string/template literals, replacing their contents
 * with spaces (preserving line breaks so line numbers stay accurate) so
 * identifier scanning never matches inside them. Regex literals are also
 * blanked using a conservative heuristic (division is far rarer than regex
 * in this codebase's call-adjacent context, and a missed `/.../ ` just
 * risks a rare false negative, not a false positive).
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSignificant = ''; // last non-space char emitted, for regex-vs-divide heuristic
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // string literals
    if (c === '"' || c === "'") {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      lastSignificant = 'X';
      continue;
    }
    // template literals — entirely blanked, `${...}` interpolations
    // included, since interpolated identifiers aren't call targets this
    // checker cares about. Handled with an explicit nesting stack rather
    // than "scan to the next backtick": a naive scan breaks the moment one
    // template nests inside another's `${...}` (`` `<div>${x ? `<b>` : ''}</div>` ``
    // is real CSS-building code in this file), because the *inner* open
    // backtick reads as the outer literal's close, desyncing every char
    // after it for the rest of the file. The stack tracks "inside a
    // template" vs "inside a `${...}` expression" (itself brace-depth
    // aware, and itself able to contain a nested template) so the true
    // closing backtick is the one actually matched.
    if (c === '`') {
      out += ' ';
      i++;
      const stack = [{ type: 'template' }];
      while (i < n && stack.length) {
        const top = stack[stack.length - 1];
        const ch = src[i];
        if (top.type === 'template') {
          if (ch === '\\') { out += '  '; i += 2; continue; }
          if (ch === '`') { out += ' '; i++; stack.pop(); continue; }
          if (ch === '$' && src[i + 1] === '{') { out += '  '; i += 2; stack.push({ type: 'expr', depth: 0 }); continue; }
          out += ch === '\n' ? '\n' : ' ';
          i++;
          continue;
        }
        // top.type === 'expr': inside `${ ... }`
        if (ch === '`') { out += ' '; i++; stack.push({ type: 'template' }); continue; }
        if (ch === '"' || ch === "'") {
          const quote = ch;
          out += ' ';
          i++;
          while (i < n && src[i] !== quote) {
            if (src[i] === '\\') { out += '  '; i += 2; continue; }
            out += src[i] === '\n' ? '\n' : ' ';
            i++;
          }
          out += ' ';
          i++;
          continue;
        }
        if (ch === '{') { top.depth++; out += ' '; i++; continue; }
        if (ch === '}') {
          if (top.depth === 0) { out += ' '; i++; stack.pop(); continue; }
          top.depth--; out += ' '; i++; continue;
        }
        out += ch === '\n' ? '\n' : ' ';
        i++;
      }
      lastSignificant = 'X';
      continue;
    }
    // regex literal heuristic: '/' not preceded by an identifier, ), or ]
    if (c === '/' && !/[\w$)\]]/.test(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break;
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        out += ' '.repeat(j - i + 1);
        i = j + 1;
        lastSignificant = 'X';
        continue;
      }
      // not a regex after all (unterminated) — fall through, treat as divide
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

const IDENT = '[A-Za-z_$][\\w$]*';

/** Index of the `)` matching the `(` at `open`, scanning forward. */
function matchingParenGlobal(code, open) {
  let depth = 1;
  for (let i = open + 1; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Names available anywhere in the file: imports, declarations, params. */
function collectDeclared(code) {
  const names = new Set();

  // import default: `import Foo from '...'`  /  `import Foo, { a, b } ...`
  for (const m of code.matchAll(new RegExp(`import\\s+(${IDENT})\\s*,?`, 'g'))) {
    names.add(m[1]);
  }
  // import namespace: `import * as Foo from '...'`
  for (const m of code.matchAll(new RegExp(`import\\s+\\*\\s+as\\s+(${IDENT})`, 'g'))) {
    names.add(m[1]);
  }
  // named imports: `import { a, b as c } from '...'` (possibly multi-line)
  for (const m of code.matchAll(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(new RegExp(`as\\s+(${IDENT})`));
      const name = asMatch ? asMatch[1] : piece.split(/\s+/)[0];
      if (name) names.add(name);
    }
  }

  // function declarations: `function foo(` / `async function foo(` / `function* foo(`
  for (const m of code.matchAll(new RegExp(`function\\s*\\*?\\s*(${IDENT})\\s*\\(`, 'g'))) {
    names.add(m[1]);
  }
  // class declarations
  for (const m of code.matchAll(new RegExp(`class\\s+(${IDENT})`, 'g'))) {
    names.add(m[1]);
  }
  // const/let/var declarations, including destructuring — capture every
  // identifier between the keyword and the next `=` or statement end, minus
  // punctuation. Handles `const { a, b: c, ...rest } = x`, `let [a, b] = x`,
  // and plain `const foo = ...`.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^=;\n]+?)\s*(?:=|;|\n)/g)) {
    const chunk = m[1];
    for (const im of chunk.matchAll(new RegExp(IDENT, 'g'))) {
      names.add(im[0]);
    }
  }
  // catch (e)
  for (const m of code.matchAll(new RegExp(`catch\\s*\\(\\s*(${IDENT})`, 'g'))) {
    names.add(m[1]);
  }
  // function parameters (regular functions, methods, arrows) — grab every
  // identifier inside any `( ... )` that is immediately followed by `{` or
  // `=>`, which covers declarations, expressions, methods, and arrows alike.
  // Uses balanced-paren matching rather than a `[^()]*` regex because a
  // default parameter can itself contain parens (`weighted(arr, weightOf =
  // (e) => e.weight)`), which a non-nesting regex chops mid-signature.
  // Over-inclusive by construction (identifiers inside a default value's own
  // body are swept in too) — safe here, since this pool only ever *suppresses*
  // a finding, never manufactures one.
  {
    let idx = 0;
    while ((idx = code.indexOf('(', idx)) !== -1) {
      const close = matchingParenGlobal(code, idx);
      if (close === -1) { idx++; continue; }
      let j = close + 1;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] === '{' || (code[j] === '=' && code[j + 1] === '>')) {
        const inner = code.slice(idx + 1, close);
        for (const im of inner.matchAll(new RegExp(IDENT, 'g'))) names.add(im[0]);
      }
      // Advance by one, not to `close + 1`: a nested `(...)` inside this
      // span (e.g. the inner `(resolve, reject) =>` of
      // `new Promise((resolve, reject) => {...})`) must still be visited on
      // its own, since jumping past the whole outer span would skip it.
      idx++;
    }
  }
  // bare single-arg arrow without parens: `x => ...`
  for (const m of code.matchAll(new RegExp(`(?:^|[^\\w$.])(${IDENT})\\s*=>`, 'g'))) {
    names.add(m[1]);
  }
  // for (const x of/in ...), for (let i = ...)
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([^=;)]+)/g)) {
    for (const im of m[1].matchAll(new RegExp(IDENT, 'g'))) {
      names.add(im[0]);
    }
  }

  return names;
}

/** Line number (1-based) of a character offset. */
function lineAt(code, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (code[i] === '\n') line++;
  return line;
}

/** Index of the character matching the `(` at `open`, scanning forward. */
function matchingParen(code, open) {
  let depth = 1;
  for (let i = open + 1; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function findUndefinedCalls(code) {
  const declared = collectDeclared(code);
  const findings = [];
  const callRe = new RegExp(`(^|[^\\w$.])(${IDENT})\\s*\\(`, 'g');
  let m;
  while ((m = callRe.exec(code)) !== null) {
    const name = m[2];
    if (KEYWORDS.has(name)) continue;
    if (GLOBALS.has(name)) continue;
    if (declared.has(name)) continue;
    // A method/function *definition* looks identical up to this point:
    // `name(params) {`. A real call is never immediately followed (after
    // whitespace/newlines, past its own matching close-paren) by `{` — only
    // an arrow body (`=>`) or nothing (`;`, `,`, `)`, EOL) follows a call.
    // Skip anything whose closing paren is followed by `{`.
    const openParen = m.index + m[0].length - 1;
    const close = matchingParen(code, openParen);
    if (close === -1) continue;
    let j = close + 1;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] === '{') continue;
    const offset = m.index + m[1].length;
    findings.push({ name, line: lineAt(code, offset) });
  }
  return findings;
}

const files = walk(srcDir).sort();

console.log('every src/**/*.js call target resolves to an import, a declaration, or an allowlisted global');
{
  const allFindings = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const code = stripNonCode(raw);
    const findings = findUndefinedCalls(code);
    const rel = relative(root, file).replace(/\\/g, '/');
    for (const f of findings) allFindings.push({ file: rel, ...f });
  }
  for (const f of allFindings) {
    console.log(`    ${f.file}:${f.line}  ${f.name}(...) is not imported, declared, or allowlisted`);
  }
  ok(files.length > 50, `scanned ${files.length} files under src/`);
  ok(allFindings.length === 0,
    allFindings.length === 0
      ? 'no unresolved call targets found'
      : `${allFindings.length} unresolved call target(s) found`);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
