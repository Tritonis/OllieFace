import { effectivePixelRatio } from '../src/core/ResolutionMath.js';
import { RenderPipeline, QUALITY } from '../src/core/RenderPipeline.js';

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

// 9. B1 regression: setQuality is the second, unguarded path to the
//    drawing-buffer scale. Once setAdaptive(false, ...) has pinned the
//    capture harness, a later setQuality must not move the ratio either —
//    the quality-tier cap has to stay frozen at the value it had at pin
//    time. Exercises the real prototype methods against a fake renderer,
//    same shape as the final-review's state-machine probe.
{
  globalThis.devicePixelRatio = 2;
  globalThis.innerWidth = 1600;
  globalThis.innerHeight = 900;
  const renderer = {
    _ratio: 1,
    setPixelRatio(r) { this._ratio = r; },
    getPixelRatio() { return this._ratio; },
    setSize() {},
  };
  const rp = Object.create(RenderPipeline.prototype);
  rp.renderer = renderer;
  rp.composer = null;
  rp.passes = {};
  rp.ctx = null;
  rp.quality = QUALITY.ULTRA;
  rp._userScale = 1;
  rp._resScale = 1;
  rp._adaptOn = true;
  rp._pinned = false;
  rp._frameMs = [];
  rp._failedAt = Infinity;
  rp._sinceFail = 0;

  rp.setAdaptive(false, 1);
  const pinnedRatio = renderer.getPixelRatio();
  rp.setQuality(QUALITY.LOW);
  ok(close(renderer.getPixelRatio(), pinnedRatio),
    `setQuality after the pin does not move the drawing-buffer ratio (${pinnedRatio} -> ${renderer.getPixelRatio()})`);
}

console.log(fail ? `FAIL (${fail})` : `PASS (${pass})`);
process.exit(fail ? 1 : 0);
