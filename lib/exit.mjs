/**
 * Exit codes, and the one place their priority is decided.
 *
 * Eight codes, and the priority between them is not obvious — a run can satisfy
 * several conditions at once. Rather than let callers guess, `exitCode()` takes a
 * facts object and applies the design's ladder in one place:
 *
 *   2 usage → 3 config/input → 4 empty scan → 7 zero budget →
 *   6 all model-needed skipped → 5 assertion → 1 findings → 0 clean
 *
 * The ordering encodes two judgements worth stating:
 *
 *  * **A usage error outranks everything.** A run that was never valid cannot
 *    have found anything, so reporting a finding would be a lie about what
 *    happened.
 *  * **An empty scan outranks a clean result but not a configuration error.** A
 *    batch where nothing was triaged is not a clean batch. It is exit 4, and it
 *    sits below config errors because a misconfiguration is the more actionable
 *    fact.
 */

export const EXIT = Object.freeze({
  CLEAN: 0,
  FINDINGS: 1,
  USAGE: 2,
  CONFIG: 3,
  EMPTY_SCAN: 4,
  EXPECT_FAILED: 5,
  MODEL_UNAVAILABLE: 6,
  BUDGET_ZERO: 7,
})

/** The ladder, as data, so a reader can see the order without reading the code. */
export const EXIT_PRIORITY = Object.freeze([
  { code: EXIT.USAGE, when: 'usage', why: 'the run was never valid, so it cannot have found anything' },
  { code: EXIT.CONFIG, when: 'config', why: 'the input or policy could not be read' },
  { code: EXIT.EMPTY_SCAN, when: 'emptyScan', why: 'nothing was triaged, which is not a clean batch' },
  { code: EXIT.BUDGET_ZERO, when: 'budgetZero', why: 'a cap was zero before any item could reach the model' },
  { code: EXIT.MODEL_UNAVAILABLE, when: 'modelUnavailable', why: 'every item needing the model was skipped' },
  { code: EXIT.EXPECT_FAILED, when: 'expectFailed', why: 'a recorded expectation was not met' },
  { code: EXIT.FINDINGS, when: 'findings', why: 'urgent items or escalations are present' },
  { code: EXIT.CLEAN, when: null, why: 'nothing needs a human' },
])

/**
 * Map a facts object to an exit code.
 *
 * `facts` keys are the `when` names above; anything absent is false. A truthy
 * value selects that rung. Using named flags rather than counts keeps the caller
 * from having to know the precedence — which is the thing that goes wrong when
 * eight conditions share one integer.
 */
export function exitCode(facts = {}) {
  const unknown = Object.keys(facts).filter(
    (key) => !EXIT_PRIORITY.some((rung) => rung.when === key),
  )
  if (unknown.length > 0) {
    // An unrecognised flag means the caller believes something is being checked
    // that is not. Silently ignoring it could drop the very condition that
    // should have produced a non-zero code, so this is a usage error.
    const error = new Error(
      `exitCode: unrecognised condition(s) ${unknown.join(', ')}; `
      + `known conditions are ${EXIT_PRIORITY.map((r) => r.when).filter(Boolean).join(', ')}`,
    )
    error.name = 'TriageError'
    error.code = 'TRIAGE_BAD_EXIT_FACT'
    error.exitCode = EXIT.USAGE
    throw error
  }
  for (const rung of EXIT_PRIORITY) {
    if (rung.when !== null && facts[rung.when]) return rung.code
  }
  return EXIT.CLEAN
}

/**
 * Which codes a CI job should accept for `triage`.
 *
 * Exported because it is a contract, not a convenience: `{0,1,6}` means "clean",
 * "found things", and "the model was not there" are all *successful runs*. A job
 * that treats 1 as a failure will be red on every batch that contains anything
 * interesting, which is every batch worth running.
 */
export const CI_ACCEPTED = Object.freeze([EXIT.CLEAN, EXIT.FINDINGS, EXIT.MODEL_UNAVAILABLE])
