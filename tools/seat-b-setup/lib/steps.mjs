// Step-running harness, separated from prompting so it can be driven by
// injected exec/answer functions in tests.

/**
 * Runs one step:
 *  1. calls detect(ctx) -> { done, detail }
 *  2. if done, reports and returns without calling action or asking anything
 *  3. else explains, and if the step needsElevation and ctx.elevated is
 *     false, refuses without asking or running the action
 *  4. else asks the human (via ctx.confirm) before running a machine-changing action
 *  5. re-runs detect() to verify
 *
 * `ctx` = { exec, confirm, elevated, log }
 * `step` = { id, title, detect, explain, needsElevation, action }
 */
export async function runStep(step, ctx) {
  const before = await step.detect(ctx);
  if (before.done) {
    ctx.log(`[skip] ${step.title}: already done (${before.detail || 'ok'})`);
    return { id: step.id, status: 'skipped', detail: before.detail };
  }

  ctx.log(`[todo] ${step.title}`);
  if (step.explain) ctx.log(step.explain(ctx));

  if (step.needsElevation && !ctx.elevated) {
    ctx.log('[refused] this step changes machine state and needs an elevated shell; re-run as Administrator.');
    return { id: step.id, status: 'refused', detail: 'not elevated' };
  }

  if (step.action) {
    const proceed = await ctx.confirm(`Run this now? (${step.title}) [y/N] `);
    if (!proceed) {
      return { id: step.id, status: 'declined' };
    }
    await step.action(ctx);
  } else {
    await ctx.confirm(`Press enter once done: ${step.title} `);
  }

  const after = await step.detect(ctx);
  if (!after.done) {
    ctx.log(`[still-not-done] ${step.title}: ${after.detail || ''}`);
    return { id: step.id, status: 'failed', detail: after.detail };
  }
  ctx.log(`[done] ${step.title}`);
  return { id: step.id, status: 'done', detail: after.detail };
}

export async function runSteps(steps, ctx) {
  const results = [];
  for (const step of steps) {
    results.push(await runStep(step, ctx));
  }
  return results;
}
