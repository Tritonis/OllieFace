/**
 * Status-overlay dedup: keyed, not scanned.
 *
 *   node tests/vfx-status-dedup.test.mjs
 *
 * `VFX.statusApplied` used to linear-scan every live overlay to decide whether
 * a proc was a new status or a refresh — O(live overlays) on every proc, and a
 * boss fight procs it from every hit on every entity. The structure is now
 * `target -> type -> entry`, so the same decision is two Map lookups.
 *
 * A real `VFX` cannot be constructed headless (it builds meshes and shaders
 * against a live renderer context), so the two methods that own the structure
 * are exercised through the prototype on a hand-built `this`. No test-only
 * code exists in VFX.js; these call the shipped methods verbatim.
 */
import { VFX } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** The smallest `this` the status methods touch. */
function fakeVFX() {
  const self = Object.create(VFX.prototype);
  self._statuses = new Map();
  self.emitted = [];
  self._ep = () => ({
    position: { x: 0, y: 0, z: 0, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } },
    dir: { set() {} },
    color0: { set() {} },
    color1: { set() {} },
  });
  self.particles = { emit: (e) => self.emitted.push(e) };
  return self;
}

const target = (extra = {}) => ({ alive: true, position: { x: 0, y: 0, z: 0 }, height: 1.6, radius: 0.5, ...extra });

/** Every live entry, in iteration order — the order overlays are emitted in. */
function flat(self) {
  const out = [];
  for (const [t, byType] of self._statuses) for (const [type, s] of byType) out.push({ t, type, s });
  return out;
}

console.log('a new status inserts one keyed entry');
{
  const self = fakeVFX(), a = target();
  const s = self.statusApplied(a, 'burn');
  ok(self._statuses.size === 1, 'one target key');
  ok(self._statuses.get(a) instanceof Map, 'target maps to a per-type Map');
  ok(self._statuses.get(a).get('burn') === s, 'the entry is reachable by target then type');
  ok(s.t === 0 && s.dur === 4.0 && s.accum === 0 && s.def, 'entry carries t/dur/accum/def');
  ok(flat(self).length === 1, 'exactly one live overlay');
}

console.log('an explicit duration overrides the catalogue default');
{
  const self = fakeVFX(), a = target();
  ok(self.statusApplied(a, 'burn', 9).dur === 9, 'duration argument wins');
}

console.log('reapplying the same status on the same target refreshes, never doubles');
{
  const self = fakeVFX(), a = target();
  const first = self.statusApplied(a, 'burn', 4);
  first.t = 3.2; first.accum = 0.01;
  const again = self.statusApplied(a, 'burn', 6);
  ok(again === first, 'the same entry object comes back — no second overlay allocated');
  ok(again.t === 0, 't reset to 0');
  ok(again.dur === 6, 'dur updated to the new application');
  ok(self._statuses.get(a).size === 1, 'still one entry for this target');
  ok(flat(self).length === 1, 'still one live overlay in total');
}

console.log('a different type on the same target coexists');
{
  const self = fakeVFX(), a = target();
  self.statusApplied(a, 'burn');
  self.statusApplied(a, 'bleed');
  ok(self._statuses.size === 1, 'still one target key');
  ok(self._statuses.get(a).size === 2, 'two types under it');
  ok(flat(self).map((e) => e.type).join(',') === 'burn,bleed', 'insertion order preserved');
}

console.log('a refresh does not reorder — emission order is stable');
{
  const self = fakeVFX(), a = target();
  self.statusApplied(a, 'burn');
  self.statusApplied(a, 'bleed');
  self.statusApplied(a, 'shock');
  self.statusApplied(a, 'burn', 2);      // refresh the oldest
  ok(flat(self).map((e) => e.type).join(',') === 'burn,bleed,shock', 'refreshed entry stays where it was');
}

console.log('two targets are independent');
{
  const self = fakeVFX(), a = target(), b = target();
  self.statusApplied(a, 'burn');
  self.statusApplied(b, 'burn');
  ok(self._statuses.size === 2, 'one key each');
  ok(self._statuses.get(a).get('burn') !== self._statuses.get(b).get('burn'), 'separate entries');
}

console.log('a bad type or a missing target inserts nothing');
{
  const self = fakeVFX(), a = target();
  ok(!self.statusApplied(a, 'nosuchstatus'), 'unknown type returns nothing');
  ok(!self.statusApplied(null, 'burn'), 'null target returns nothing');
  ok(self._statuses.size === 0, 'and neither left a key behind');
}

console.log('expiry removes the entry AND the target key — no leak');
{
  const self = fakeVFX(), a = target();
  self.statusApplied(a, 'slow', 2.0);
  self._updateStatuses(1.0);
  ok(self._statuses.has(a), 'still live at half its duration');
  self._updateStatuses(1.0);
  ok(!self._statuses.get(a)?.has('slow'), 'expired entry dropped');
  ok(!self._statuses.has(a), 'target key dropped too, so the Map does not grow without bound');
  ok(self._statuses.size === 0, 'structure is empty again');
}

console.log('one type expiring leaves the other, and keeps the target key');
{
  const self = fakeVFX(), a = target();
  self.statusApplied(a, 'burn', 5.0);
  self.statusApplied(a, 'slow', 1.0);
  self._updateStatuses(1.5);
  ok(self._statuses.has(a), 'target key survives');
  ok(self._statuses.get(a).size === 1, 'only one entry left');
  ok(self._statuses.get(a).has('burn'), 'the long one is the survivor');
}

console.log('a dead target drops every overlay it was carrying');
{
  const self = fakeVFX(), a = target(), b = target();
  self.statusApplied(a, 'burn', 10);
  self.statusApplied(a, 'bleed', 10);
  self.statusApplied(b, 'burn', 10);
  a.alive = false;
  self._updateStatuses(0.016);
  ok(!self._statuses.has(a), 'the dead target is gone from the Map entirely');
  ok(self._statuses.has(b), 'the live one is untouched');
  ok(flat(self).length === 1, 'one overlay left');
}

console.log('many procs on many targets churn without leaking');
{
  const self = fakeVFX();
  const mob = Array.from({ length: 50 }, () => target());
  for (let i = 0; i < 20; i++) for (const m of mob) { self.statusApplied(m, 'burn', 1.0); self.statusApplied(m, 'bleed', 1.0); }
  ok(self._statuses.size === 50, '50 target keys after 2000 procs');
  ok(flat(self).length === 100, '100 overlays, not 2000 — every reproc refreshed');
  for (const m of mob) m.alive = false;
  self._updateStatuses(0.016);
  ok(self._statuses.size === 0, 'a wipe empties the structure completely');
}

console.log('the one-shot pop still fires for the entry that was just applied');
{
  const self = fakeVFX(), a = target();
  self.status(a, 'burn', 0xff0000);
  ok(self.emitted.length === 1, 'a coloured proc emits its pop');
  self.emitted.length = 0;
  self.status(a, 'burn');
  ok(self.emitted.length === 0, 'no colour, no pop');
  ok(self._statuses.get(a).size === 1, 'and still no duplicate overlay');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
