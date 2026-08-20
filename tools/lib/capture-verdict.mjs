/**
 * The capture gate's exit-code decision, isolated from `tools/capture.mjs`
 * so it can be unit-tested without booting vite/chromium — that file runs a
 * real capture as a top-level side effect the moment it is imported.
 *
 * Decided 2026-08-20 (issue #124): the capture gate is advisory only. It
 * reports; it never blocks a commit, a merge or a deploy. This module draws
 * the line between "the run did not happen" (infrastructure — still fails)
 * and "the pictures were judged imperfect" (advisory — reported, exit 0):
 *
 *   ADVISORY (reported, never flips the exit code):
 *     - subjectFailures — legibility/separation/margin/stage-placement
 *       judgements from Harness.js's own `subjects` contract.
 *     - `[harness]`-prefixed console messages — these ARE subject-failure
 *       detail (siting/legibility diagnostics logged by the scenarios
 *       themselves), not evidence anything crashed.
 *     - audioOk / the audio checks — an inaudible or silenced mix is a
 *       product-behaviour finding read off the game's own state, the same
 *       kind of "judged imperfect" as a subject failure.
 *
 *   INFRASTRUCTURE (still exits non-zero — the run did not happen):
 *     - the dev server / page never reached `ready` (boot failure);
 *     - a per-scenario `error` — page.goto/screenshot timeout, navigation
 *       failure, or any other throw while driving or shooting a scenario.
 *       A black or missing screenshot falls here: `page.screenshot()`
 *       throws on a hung/crashed page, which lands as a shot `error`;
 *     - any console error or page error that is NOT `[harness]`-prefixed —
 *       a real JS crash or unexpected console.error, as opposed to the
 *       harness's own diagnostic logging.
 */
export const HARNESS_PREFIX = '[harness]';

/**
 * @param {{ ready: boolean, shots?: Array<{name:string, error?: string}>,
 *           errors?: string[], subjectFailures?: unknown[], audioOk?: boolean|null }} run
 * @returns {{ infra: { bootFailed: boolean, shotErrors: string[], consoleErrors: string[] },
 *             infraFailed: boolean, advisoryFindings: boolean }}
 */
export function captureVerdict({ ready, shots, errors, subjectFailures, audioOk }) {
  const infraConsoleErrors = (errors ?? []).filter((e) => !e.startsWith(HARNESS_PREFIX));
  const shotErrors = ready ? (shots ?? []).filter((s) => s.error) : [];
  const infra = {
    bootFailed: !ready,
    shotErrors: shotErrors.map((s) => `${s.name}: ${s.error}`),
    consoleErrors: infraConsoleErrors,
  };
  return {
    infra,
    infraFailed: infra.bootFailed || shotErrors.length > 0 || infraConsoleErrors.length > 0,
    advisoryFindings: (subjectFailures ?? []).length > 0 || audioOk === false,
  };
}
