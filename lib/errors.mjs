/**
 * Error codes and the error type.
 *
 * A closed vocabulary for the same reason the exit codes are a closed set: a code
 * no reader can look up is not actionable, and a typo in one fails a test rather
 * than reaching a user as an undefined string.
 */
export const ERROR_CODES = Object.freeze({
  BAD_CONTEXT: 'TRIAGE_BAD_CONTEXT',
  BAD_CONFIG: 'TRIAGE_BAD_CONFIG',
  BAD_POLICY: 'TRIAGE_BAD_POLICY',
  BAD_ITEM: 'TRIAGE_BAD_ITEM',
  DUPLICATE_ID: 'TRIAGE_DUPLICATE_ID',
  TOO_MANY_ITEMS: 'TRIAGE_TOO_MANY_ITEMS',
  NO_ITEMS: 'TRIAGE_NO_ITEMS',
  BAD_EXIT_FACT: 'TRIAGE_BAD_EXIT_FACT',
  BAD_BATCH_SIZE: 'TRIAGE_BAD_BATCH_SIZE',
  BAD_TAU: 'TRIAGE_BAD_TAU',
  BAD_BUDGET: 'TRIAGE_BAD_BUDGET',
})

export class TriageError extends Error {
  constructor(code, message, detail = null, exitCode = 2) {
    super(`${code}: ${message}`)
    this.name = 'TriageError'
    this.code = code
    this.detail = detail
    this.exitCode = exitCode
  }
}
