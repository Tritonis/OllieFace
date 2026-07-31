/**
 * Which GPU are we actually on, and what should we ask of it?
 *
 * This exists because of a 14x discrepancy that nothing in the codebase could
 * see: on a laptop with switchable graphics, the browser brings its GPU process
 * up on the *integrated* adapter and stays there for the life of the process.
 * The renderer's `powerPreference: 'high-performance'` does not move it —
 * that hint is consulted when the GPU process launches, not per WebGL context,
 * so by the time our code runs the decision is already made and unappealable.
 *
 * Measured on the development machine (GTX 1660 Ti + Intel UHD 630), same
 * scene, same settings, 1600x900:
 *
 *     Intel UHD 630   5.8 fps
 *     GTX 1660 Ti    80.0 fps
 *
 * No amount of shader budgeting closes a gap like that, so the single most
 * valuable thing this module does is *notice* and tell the player, because the
 * fix is a two-click OS setting and not a graphics option. Picking a survivable
 * quality tier is the consolation prize for when they can't or won't.
 */

export const TIER = { INTEGRATED: 0, LOW: 1, MID: 2, HIGH: 3 };

/**
 * Ask the driver what it is. Returns the raw `UNMASKED_RENDERER_WEBGL` string,
 * or '' when the extension is unavailable — some browsers withhold it for
 * fingerprinting reasons, and an unknown GPU must never be treated as a bad one.
 */
export function probeRenderer(gl) {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbg) return '';
    return String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
  } catch {
    return '';
  }
}

// Integrated parts, by the names ANGLE actually reports. Intel's discrete Arc
// line is deliberately absent — "Intel" alone is not the signal, the UHD/HD/Iris
// family names are.
const INTEGRATED = /\b(intel\s*\(r\)?\s*)?(uhd|hd)\s*graphics\b|\biris\b|\bvega\s*\d\s*graphics\b|\bradeon\s*(r[2-7])?\s*graphics\b|\bmicrosoft\s*basic\s*render\b|\bswiftshader\b|\bllvmpipe\b|\bsoftware\s*adapter\b/i;

// Discrete families we're confident can carry the full pipeline.
const DISCRETE = /\b(geforce|quadro|nvidia|rtx|gtx)\b|\bradeon\s*(rx|pro)\b|\barc\s*a\d/i;

// The bottom of the discrete range — real GPUs, but not ones to hand a 4k
// shadow map and full-res GTAO to.
const WEAK_DISCRETE = /\b(gtx\s*(750|760|950|960|1030|1050)|mx\d{3}|radeon\s*rx\s*5[0-5]0)\b/i;

/**
 * Classify a renderer string into a capability tier.
 *
 * Unknown strings get MID, not HIGH: an unrecognised GPU is more often a
 * locked-down browser on modest hardware than an exotic workstation card, and
 * being wrong toward "too pretty" is the failure the player actually feels.
 */
export function classify(rendererString) {
  const s = rendererString || '';
  if (!s) return { tier: TIER.MID, integrated: false, known: false, name: 'unknown' };

  const name = cleanName(s);
  if (INTEGRATED.test(s)) return { tier: TIER.INTEGRATED, integrated: true, known: true, name };
  if (WEAK_DISCRETE.test(s)) return { tier: TIER.LOW, integrated: false, known: true, name };
  if (DISCRETE.test(s)) return { tier: TIER.HIGH, integrated: false, known: true, name };
  return { tier: TIER.MID, integrated: false, known: false, name };
}

/**
 * `ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti (0x00002191) Direct3D11 vs_5_0
 * ps_5_0, D3D11)` is not something to put in front of a player. Pull the model
 * out of the middle of it.
 */
function cleanName(s) {
  const angle = /^ANGLE\s*\(([^,]+),\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?(?:\s+Direct3D.*)?\)$/i.exec(s.trim());
  let name = angle ? angle[2] : s;
  name = name.replace(/\s*\(0x[0-9a-f]+\)/i, '')
    .replace(/\s+Direct3D\d*.*$/i, '')
    .replace(/\s+vs_\d_\d.*$/i, '')
    .replace(/,\s*D3D\d+\s*\)?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "NVIDIA NVIDIA GeForce ..." — ANGLE repeats the vendor.
  name = name.replace(/^(\w+)\s+\1\b/i, '$1');
  return name || s;
}

/**
 * Full detection against a live renderer. `QUALITY` is passed in rather than
 * imported so this module stays free of a cycle with RenderPipeline.
 */
export function detectGpu(renderer, QUALITY) {
  let raw = '';
  try { raw = probeRenderer(renderer.getContext()); } catch { /* context lost */ }
  const info = classify(raw);
  info.raw = raw;
  info.quality = [QUALITY.LOW, QUALITY.MEDIUM, QUALITY.HIGH, QUALITY.HIGH][info.tier];
  return info;
}
