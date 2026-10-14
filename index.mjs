/**
 * dsh-batch-triage — deterministic-first triage for batches of tickets.
 *
 * Ticketing batches are the wrong shape for an LLM call per item: the volume is
 * high, the interesting items are few, and every item costs a round trip whether
 * or not it needed one. So the order here is inverted from the obvious one.
 *
 *   **The deterministic prefilter runs on every item, first.** Rules decide the
 *   clear cases — a crash with a stack trace is urgent, a "how do I install
 *   this" question is routine — and they decide them without asking anything.
 *   Only items the rules cannot place reach the model, and this release does not
 *   reach it at all: it reports them as `needs_review` with `decidedBy: model`
 *   replaced by an explicit budget or unavailability reason.
 *
 * That ordering is not an optimisation. It is the design's main path (its §0.3),
 * and it changes what the tool is for: the prefilter is the product, and the
 * model is a fallback for the residue.
 *
 * Three properties this is built to have:
 *
 *  1. **No model, no service, no network.** Every verdict here comes from rules
 *     or from an explicit "I could not decide". There is no confidence interval
 *     on a question the rules can answer.
 *  2. **SKIP is never PASS.** An item that no tier could classify exits as
 *     `needs_review`, never `routine`, and the run reports `skippedModel`.
 *  3. **A cap is a decision, not a silent drop.** An item the budget could not
 *     afford is `needs_review` with the budget named, so a truncated run cannot
 *     read as a complete one.
 */

export const PLUGIN_ID = 'batch_triage'
export const BUNDLE_NAME = 'dsh-batch-triage'

export { EXIT, exitCode, EXIT_PRIORITY, CI_ACCEPTED } from './lib/exit.mjs'
export { resolveConfig, DEFAULT_CONFIG, MAX_ITEMS, FAIL_ON, validateItems } from './lib/config.mjs'
export { createTools } from './tools.mjs'
export { triageBatch, CLASSES } from './lib/triage.mjs'
export { SKILL_NAME, createSkill } from './lib/skill.mjs'
export { TriageError, ERROR_CODES } from './lib/errors.mjs'
export { prefilter, PREFILTER_RULES, FIELD_OVERRIDES, raiseClass } from './lib/prefilter.mjs'

import { resolveConfig } from './lib/config.mjs'
import { TriageError, ERROR_CODES } from './lib/errors.mjs'
import { createTools } from './tools.mjs'
import { SKILL_NAME, createSkill } from './lib/skill.mjs'

/**
 * Compose the plugin onto a host context.
 *
 * Throws only for configuration that cannot be honoured. A missing model service
 * is never a load failure — it is a verdict about every item that needed it.
 */
export function createPlugin(ctx, options = {}) {
  if (!ctx || typeof ctx.inject !== 'function') {
    throw new TriageError(
      ERROR_CODES.BAD_CONTEXT,
      'createPlugin needs a ctx with .inject(); the host did not supply one',
    )
  }
  const config = resolveConfig(options)
  const logger = typeof ctx.logger === 'object' && ctx.logger !== null ? ctx.logger : null

  ctx.inject(['tools'], (toolCtx) => {
    for (const tool of createTools(config, logger)) {
      toolCtx.tools.register(tool)
    }
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.register(createSkill(config))
  })

  return { config, toolNames: createTools(config, logger).map((tool) => tool.name) }
}

export default createPlugin
