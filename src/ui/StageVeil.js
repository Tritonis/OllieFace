/**
 * The black the world goes through on the way between stages.
 *
 * A stage transition tears the whole world down and generates a new one, and
 * however finely that work is sliced it cannot be made instant — the terrain
 * has to be generated, the props sited, the reflection probe re-photographed
 * off a scene that only exists once all of it is standing. `Stage.buildSteps`
 * spreads the cost so the frame loop keeps running through it; this is the
 * other half of the same fix, and the half the player actually sees. Without
 * it the transition is a legible sequence of pops — the old biome's palette
 * landing on the old geometry, the sky changing, then the swap — which reads
 * as a glitch even when no frame was ever dropped.
 *
 * DOM rather than a post-process pass, deliberately. The whole point of the
 * exercise is to stay responsive while the renderer is busy, and a veil drawn
 * by the renderer is a veil that stops moving at exactly the moment the
 * renderer stalls. The compositor owns this one; it keeps fading through a
 * frame the game never got to draw.
 */

const CSS = `
.stage-veil{position:fixed;inset:0;z-index:9000;pointer-events:none;
 background:#04060a;opacity:0;will-change:opacity}
`;

let el = null;

/**
 * Paint the veil at `alpha` (0..1). Removes itself at zero, so a session that
 * never changes stage carries no extra layer over the canvas.
 *
 * Silently does nothing without a document: every headless driver — tests, the
 * probe tools, the co-op probe — runs the same transition code, and a veil is
 * not something any of them can or should have an opinion about.
 */
export function setStageVeil(alpha) {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc?.body) return;
  const a = Math.max(0, Math.min(1, alpha || 0));

  if (a <= 0) {
    el?.remove();
    el = null;
    return;
  }
  if (!el) {
    if (!doc.querySelector('style[data-stage-veil]')) {
      const style = doc.createElement('style');
      style.setAttribute('data-stage-veil', '');
      style.textContent = CSS;
      doc.head.appendChild(style);
    }
    el = doc.createElement('div');
    el.className = 'stage-veil';
    el.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(el);
  }
  el.style.opacity = String(a);
}

/** Current veil opacity — 0 when there is no veil. Test and harness handle. */
export function stageVeilAlpha() {
  return el ? Number(el.style.opacity) || 0 : 0;
}

/**
 * Hang the veil off the bus. Called from the composition root, because
 * `Progression` is a system and a system may not reach into `src/ui/` —
 * `tests/import-boundaries.test.mjs` rule 1, and it is right to: the stage
 * transition is a piece of run logic that happens to want a picture drawn, and
 * routing that through an event is what keeps the headless drivers able to run
 * the same transition without a DOM anywhere in the graph.
 *
 * Returns the unsubscribe handle.
 */
export function installStageVeil(ctx) {
  return ctx.events.on('stageVeil', (e) => setStageVeil(e?.alpha ?? 0));
}
