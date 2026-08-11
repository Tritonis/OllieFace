import { effectivePixelRatio } from '../src/core/ResolutionMath.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const close = (a, b) => Math.abs(a - b) < 1e-9;

const base = { dpr: 1, qualityCap: 2, budget: 5.0e6, width: 1600, height: 900, userScale: 1, adaptScale: 1 };

// 1. Identity: 1080p-class window, dpr 1, everything at 1 -> ratio 1.
ok(close(effectivePixelRatio(base), 1), 'defaults pass dpr through untouched');

// 2. Quality cap: dpr 2 on the low tier (cap 1) is clamped to 1.
ok(close(effectivePixelRatio({ ...base, dpr: 2, qualityCap: 1 }), 1), 'quality cap clamps high-DPI down');

// 3. Pixel budget: dpr 2 at 2560x1440 CSS pixels busts the 5MP budget.
//    budget term = sqrt(5e6 / (2560*1440)) = 1.16451..., so ratio = 1.16451, not 2.
const busted = effectivePixelRatio({ ...base, dpr: 2, width: 2560, height: 1440 });
ok(close(busted, Math.sqrt(5.0e6 / (2560 * 1440))), `pixel budget clamps a 4K buffer (${busted})`);

// 4. Budget floor: the budget clamp never pushes the ratio below 1 on huge
//    windows — that is the adaptive controller's job, not the budget's.
ok(close(effectivePixelRatio({ ...base, width: 3840, height: 2160 }), 1), 'budget clamp floors at 1');

// 5. User scale multiplies after the clamps and may go below 1.
ok(close(effectivePixelRatio({ ...base, userScale: 0.5 }), 0.5), 'userScale halves the ratio');

// 6. Adaptive scale composes with user scale.
ok(close(effectivePixelRatio({ ...base, userScale: 0.8, adaptScale: 0.75 }), 0.6), 'userScale and adaptScale compose');

// 7. Zero-size window: clamps are skipped, scales still apply (matches the
//    old guard `if (w > 0 && h > 0)`).
ok(close(effectivePixelRatio({ ...base, width: 0, height: 0, userScale: 0.5 }), 0.5), 'zero-size window skips the budget clamp');

// 8. Today's exact formula with userScale 1 — the capture-regression invariant.
for (const [w, h, dpr, cap, adapt] of [[1600, 900, 1, 2, 1], [1920, 1080, 1.5, 1.5, 0.85], [2560, 1440, 2, 2, 0.55]]) {
  let old = Math.min(dpr, cap);
  const b = Math.sqrt(5.0e6 / (w * h));
  old = Math.min(old, Math.max(1, b));
  old *= adapt;
  const now = effectivePixelRatio({ dpr, qualityCap: cap, budget: 5.0e6, width: w, height: h, userScale: 1, adaptScale: adapt });
  ok(close(now, old), `userScale 1 reproduces the old formula at ${w}x${h} dpr ${dpr}`);
}

console.log(fail ? `FAIL (${fail})` : `PASS (${pass})`);
process.exit(fail ? 1 : 0);
