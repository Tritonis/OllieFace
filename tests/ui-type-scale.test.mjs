/**
 * The type ladder is a rule, not a habit.
 *
 *   node tests/ui-type-scale.test.mjs
 *
 * The 2026-08-08 playtest reported the UI font as "too weak". It was three
 * faults at once and all three are token-level: `--u` floored at 11px, no
 * `font-weight` declared for body text anywhere (so prose rendered at 400),
 * and 38 declarations sized below 0.80em, several carrying 0.28-0.40em of
 * tracking. At that size, tracking that wide dissolves the word shape and the
 * label stops being read and starts being scanned past.
 *
 * CSS cannot be unit-tested for how it looks; the shot harness judges that.
 * What IS testable is the discipline, so this file pins it: a floor on size, a
 * declared weight, and a cap on tracking for anything under 1em. It reads the
 * two places CSS lives — hud.css and the Edict block injected by Menus.js —
 * so the treatment cannot be defined once and then quietly re-litigated in the
 * runtime sheet. `GpuNotice.js` is deliberately not read: it renders before any
 * stylesheet exists and must carry its own px.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const css = readFileSync(join(root, 'src/ui/hud.css'), 'utf8');
const menus = readFileSync(join(root, 'src/ui/Menus.js'), 'utf8');
const sources = [['hud.css', css], ['Menus.js (Edict block)', menus]];

const FLOOR_EM = 0.80;
const TRACK_CAP_EM = 0.24;

console.log('the tokens exist');
{
  for (const t of ['--fs-micro', '--fs-small', '--fw-body', '--fw-label',
                   '--fw-read', '--fw-display', '--track-label',
                   '--track-eyebrow', '--track-hero']) {
    ok(new RegExp(`\\n\\s*${t}\\s*:`).test(css), `${t} is declared in hud.css`);
  }
  const u = css.match(/--u:\s*clamp\(\s*([\d.]+)px/);
  ok(!!u && parseFloat(u[1]) >= 12, `--u floors at ${u?.[1]}px (>= 12)`);
}

console.log('body text declares a weight');
{
  const body = css.match(/\nhtml,\s*body\s*\{([\s\S]*?)\}/);
  ok(!!body, 'the html, body block is findable');
  ok(/font-weight:\s*var\(--fw-body\)/.test(body?.[1] ?? ''),
     'html, body sets font-weight: var(--fw-body) — nothing renders at the 400 default');
  for (const [name, src] of sources) {
    ok(!/font-weight:\s*400\b/.test(src), `${name} declares no font-weight: 400`);
  }
}

console.log('nothing on the ladder is too small to read');
{
  for (const [name, src] of sources) {
    const bad = [...src.matchAll(/font-size:\s*(0?\.\d+)em/g)]
      .map((m) => parseFloat(m[1]))
      .filter((v) => v < FLOOR_EM);
    ok(bad.length === 0, `${name} has no font-size below ${FLOOR_EM}em (found ${bad.join(', ') || 'none'})`);
    const px = [...src.matchAll(/font-size:\s*(\d+)px/g)].map((m) => m[1]);
    ok(px.length === 0, `${name} sizes nothing in raw px — every size derives from --u (found ${px.join(', ') || 'none'})`);
  }
}

console.log('small text is not tracked into illegibility');
{
  // A crude but sufficient block scanner: split on `}`, and for each rule read
  // its own font-size and letter-spacing. Nested blocks (@media, @keyframes)
  // split harmlessly into fragments that declare neither.
  for (const [name, src] of sources) {
    const blocks = src.split('}');
    const offenders = [];
    for (const b of blocks) {
      const fs = b.match(/font-size:\s*(0?\.\d+)em/);
      const ls = b.match(/letter-spacing:\s*(0?\.\d+)em/);
      if (!fs || !ls) continue;
      if (parseFloat(fs[1]) < 1 && parseFloat(ls[1]) > TRACK_CAP_EM) {
        offenders.push(`${(b.split('\n').find((l) => l.includes('{')) ?? b).trim().slice(0, 48)} (${fs[1]}em / ${ls[1]}em)`);
      }
    }
    ok(offenders.length === 0,
       `${name}: nothing under 1em tracks past ${TRACK_CAP_EM}em\n    ${offenders.join('\n    ')}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
