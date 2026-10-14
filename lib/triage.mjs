/**
 * The triage runner.
 *
 * Order of work, and why:
 *
 * 1. **Validate the batch.** Before any IO, so a usage error is exit 2 and can
 *    never be reported as a finding.
 * 2. **Prefilter every item.** The main path. Rules decide the clear cases.
 * 3. **Decide what the residue needs.** Items no rule placed are the only ones
 *    that would reach a model. This release has no model client, so they become
 *    `needs_review` with an explicit reason.
 * 4. **Apply the caps.** An item the budget could not afford is `needs_review`
 *    with the budget named.
 * 5. **Summarise and derive the exit code.**
 *
 * The invariant that shapes all of it: **an item is never `routine` unless a rule
 * said so.** Every path that cannot classify — an empty body, no matching rule,
 * no model, no budget — produces `needs_review`. Turning "I could not tell" into
 * "nothing to see" is the one failure this tool exists to prevent.
 */
import { validateItems } from './config.mjs'
import { prefilter, raiseClass } from './prefilter.mjs'
import { EXIT, exitCode } from './exit.mjs'

/** Classes an item can carry, in increasing severity. */
export const CLASSES = Object.freeze(['routine', 'needs_review', 'urgent'])

/**
 * Triage a batch.
 *
 * Returns `{items, summary, exitCode, exitBasis}`. Pure and synchronous when no
 * model client is configured, which is what makes it testable without a service.
 */
export function triageBatch(items, config, options = {}) {
  validateItems(items, config)

  const modelAvailable = typeof config.modelClient === 'function'
  const results = []
  let modelBudget = config.modelStateCap === null ? Infinity : config.modelStateCap
  let budgetRefusals = 0

  for (const item of items) {
    const verdict = prefilter(item, config)
    const result = {
      id: item.id,
      class: verdict.class === 'undecided' ? 'needs_review' : verdict.class,
      deterministicClass: verdict.class,
      modelClass: 'unavailable',
      score: 0,
      confidence: null,
      top2Margin: null,
      escalate: false,
      decidedBy: 'prefilter',
      // The prefilter may report more than one code: a structured field and the
      // wording can disagree, and when they do the item carries both, so a reader
      // sees a field that was overruled rather than one confident answer.
      reasonCodes: [...(verdict.reasonCodes ?? [verdict.reason])],
    }
    if (verdict.ruleId) result.reasonCodes.push(`RULE_${verdict.ruleId.toUpperCase()}`)

    if (verdict.class === 'undecided') {
      // The residue: the only place a model would ever be consulted.
      if (!modelAvailable) {
        result.decidedBy = 'unavailable'
        result.reasonCodes.push('MODEL_NOT_CONFIGURED')
      } else if (modelBudget <= 0) {
        budgetRefusals += 1
        result.decidedBy = 'budget'
        result.reasonCodes.push('BUDGET_EXHAUSTED')
      } else {
        modelBudget -= 1
        // A client exists but this release does not drive one. Saying so beats
        // leaving the branch looking implemented.
        result.decidedBy = 'unavailable'
        result.reasonCodes.push('MODEL_TIER_NOT_IMPLEMENTED')
      }
      // Whatever the reason, the class stays needs_review. `escalate` records
      // that this is the kind of item the model tier exists for, which is a
      // different fact from what class it received.
      result.escalate = true
    } else if (config.tau !== null) {
      // `tau` is the escalation threshold on confidence, and this release has no
      // confidence to compare it against. So the honest use of it is the one the
      // design permits: it may only make the prefilter's answer *more* cautious.
      //
      // Applying it as "a stricter tau escalates borderline items" keeps the
      // option meaningful instead of silently ignored -- an option that is
      // accepted and has no effect is worse than one that is rejected, because
      // the caller believes something was checked.
      if (verdict.class === 'needs_review') {
        result.escalate = true
        result.reasonCodes.push('TAU_ESCALATION_GATE_NOT_MET_BY_PREFILTER')
      }
    }

    results.push(result)
  }

  const summary = summarise(results, {
    modelAvailable,
    budgetRefusals,
    config,
    items,
  })
  const basis = deriveExit(summary, config, modelAvailable, results)
  return { items: results, summary, exitCode: basis.code, exitBasis: basis.basis }
}

function summarise(results, context) {
  const counts = { routine: 0, needs_review: 0, urgent: 0 }
  const escalatedIds = []
  const urgentIds = []
  for (const result of results) {
    counts[result.class] += 1
    if (result.escalate) escalatedIds.push(result.id)
    if (result.class === 'urgent') urgentIds.push(result.id)
  }
  const decidedBy = {}
  for (const result of results) {
    decidedBy[result.decidedBy] = (decidedBy[result.decidedBy] || 0) + 1
  }

  // `skippedModel` is true only when the model tier would have been needed and
  // was not available at all. It is reported separately from `needs_review`
  // because the two call for different responses: one is "these items are hard",
  // the other is "this environment cannot do that part".
  const skippedModel = !context.modelAvailable
    && results.some((result) => result.reasonCodes.includes('MODEL_NOT_CONFIGURED'))

  return {
    total: results.length,
    counts,
    urgentIds,
    escalatedIds,
    decidedBy,
    skippedModel,
    budgetRefusals: context.budgetRefusals,
    modelClientConfigured: context.modelAvailable,
  }
}

function deriveExit(summary, config, modelAvailable, results) {
  const decided = summary.counts.routine + summary.counts.needs_review + summary.counts.urgent
  // `config.modelStateCap === 0` is unreachable through `resolveConfig`, which
  // refuses a cap of 0 at load (the design files that as a configuration error:
  // asking for model coverage and forbidding it in the same call). Anything that
  // reads this rung has to know that, or it will hunt for a producer that does not
  // exist. `emptyScan` has the same shape: `validateItems` refuses an empty batch as
  // a usage error before this function runs, so rung 4 is reserved for a caller that
  // drives `exitCode()` directly. Both are stated here rather than left to be
  // rediscovered.
  const budgetZero = config.modelStateCap === 0
    && results.some((result) => result.decidedBy === 'budget')

  let findings = false
  if (config.failOn === 'any') findings = summary.urgentIds.length > 0 || summary.escalatedIds.length > 0
  else if (config.failOn === 'urgent') findings = summary.urgentIds.length > 0
  // failOn === 'none' leaves findings false: the caller asked for a report, not a gate.

  const facts = {
    emptyScan: decided === 0,
    budgetZero,
    modelUnavailable: summary.skippedModel,
    findings,
  }
  const code = exitCode(facts)
  const basis = Object.entries(facts).find(([, value]) => value)?.[0] ?? 'clean'
  return { code, basis }
}

export { EXIT }
