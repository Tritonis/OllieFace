// Throwaway: prove the re-baseline is a rename and nothing else.
// Re-key the round-8 baselines with the round-7 rename map and deep-compare
// against the fresh captures, over exactly the fields each gate reads.
import { readFileSync } from 'node:fs';

const MAP = {
  beetle: 'scarab', lemurian: 'skink', wisp: 'mote', pest: 'shrike',
  golem: 'sentinel', titan: 'colossus',
  blazing: 'emberclad', overloading: 'galvanic', glacial: 'rimebound',
};
// Item ids can appear in damage-source keys too.
const ITEMS = { behemoth: 'shrapnel-heart' };
const ALL = { ...MAP, ...ITEMS };

const rekey = (v) => {
  if (Array.isArray(v)) return v.map(rekey);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      let nk = k;
      for (const [from, to] of Object.entries(ALL)) {
        nk = nk.replace(new RegExp(`(^|[^a-z])${from}($|[^a-z])`, 'g'), `$1${to}$2`);
      }
      out[nk] = rekey(val);
    }
    return out;
  }
  if (typeof v === 'string') return ALL[v] ?? v;
  return v;
};

const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
};

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const arms = [
  ['fingerprint gate', read('reviews/round8/baseline-HEAD.json').fingerprint,
    read('reviews/round7/baseline-00f8900.json').fingerprint],
  ['elite gate', (({ mode, card, arms: a, lethal }) => ({ mode, card, arms: a, lethal }))(read('reviews/round8/elite-baseline-HEAD.json')),
    (({ mode, card, arms: a, lethal }) => ({ mode, card, arms: a, lethal }))(read('reviews/round7/elite-baseline-00f8900.json'))],
];

let bad = 0;
for (const [name, oldView, freshView] of arms) {
  const a = flat(rekey(oldView));
  const b = flat(freshView);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const moved = keys.filter((k) => a[k] !== b[k]);
  console.log(`${name}: ${keys.length} fields, ${moved.length} moved after re-keying the old baseline`);
  for (const k of moved) console.log(`    ${k}\n      old(re-keyed): ${JSON.stringify(a[k])}\n      fresh:         ${JSON.stringify(b[k])}`);
  bad += moved.length;
}
console.log(bad === 0
  ? '\nPROVEN: every number in both baselines is byte-identical once the ids are translated.'
  : `\n${bad} field(s) are not explained by the rename.`);
