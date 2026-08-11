/**
 * The one place the drawing-buffer scale is computed. Pure — no DOM, no
 * renderer — so the clamp order is testable in node without a WebGL context.
 *
 * Order matters and is load-bearing: the quality cap and pixel budget exist to
 * stop the ratio *climbing* on high-DPI panels, so they clamp first and the
 * budget term never drops below 1. The two scales multiply last and are
 * allowed to take the ratio below 1 — `userScale` is the player's Render
 * scale setting (a hard ceiling they chose), `adaptScale` is the adaptive
 * controller's live correction underneath it.
 */
export function effectivePixelRatio({ dpr, qualityCap, budget, width, height, userScale = 1, adaptScale = 1 }) {
  let ratio = Math.min(dpr, qualityCap);
  if (width > 0 && height > 0) {
    const b = Math.sqrt(budget / (width * height));
    ratio = Math.min(ratio, Math.max(1, b));
  }
  return ratio * userScale * adaptScale;
}
