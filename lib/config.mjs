/**
 * Configuration: the caps, the policy, and the validation that refuses to load.
 *
 * Every limit here exists because the alternative is a silent behaviour change.
 * A batch cap that truncates instead of refusing means the caller believes 200
 * tickets were triaged when 64 were. A tau that silently accepts a negative value
 * means every item escalates and nobody knows why.
 */
import { ERROR_CODES, TriageError } from './errors.mjs'

/**
 * The maximum number of items in one call.
 *
 * A larger submission is **rejected, not truncated**. Truncation would make the
 * result look complete: the caller sees a summary, not a summary of the first 64.
 */
export const MAX_ITEMS = 64

export const DEFAULT_CONFIG = Object.freeze({
  maxItems: MAX_ITEMS,
  policyId: 'default',
  tau: null,
  modelStateCap: null,
  tokenCap: null,
  timeoutMs: 20000,
  batchSize: 16,
  failOn: 'any',
})

/**
 * `--fail-on` narrows what counts as a finding for exit code 1.
 *
 * `any` is the default: an urgent item or any escalation means the run has
 * something for a human. `urgent` narrows it to urgent items only, for a team
 * that triages escalations on a different cadence.
 */
export const FAIL_ON = Object.freeze(['any', 'urgent', 'none'])

function positiveInteger(value, name, { allowNull = true, min = 0, code = ERROR_CODES.BAD_CONFIG } = {}) {
  if (value === undefined || value === null) {
    if (allowNull) return null
    throw new TriageError(code, `${name} is required`)
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TriageError(
      code,
      `${name} must be a non-negative integer, got ${JSON.stringify(value)}`,
    )
  }
  if (value < min) {
    throw new TriageError(
      code,
      `${name} must be at least ${min}, got ${value}`
        + (min === 1
          ? '; a cap of 0 would refuse every item, which is a configuration error '
            + 'rather than a triage result'
          : ''),
    )
  }
  return value
}

export function resolveConfig(options = {}) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TriageError(ERROR_CODES.BAD_CONFIG, 'options must be an object')
  }

  const maxItems = options.maxItems === undefined
    ? MAX_ITEMS
    : positiveInteger(options.maxItems, 'maxItems', { allowNull: false, min: 1 })

  // `modelStateCap: 0` is refused rather than accepted. A cap of zero refuses
  // every residual item, which the design files as a configuration error (exit
  // 3) precisely because the cap and the input cannot both be honoured: the
  // caller asked for model coverage and forbade it in the same call. Accepting
  // it would turn a contradiction into a triage result.
  let tau = options.tau ?? null
  if (tau !== null) {
    if (typeof tau !== 'number' || Number.isNaN(tau) || tau < 0 || tau > 1) {
      throw new TriageError(
        ERROR_CODES.BAD_TAU,
        `tau must be a number in [0,1] or null, got ${JSON.stringify(options.tau)}`,
      )
    }
  }

  const failOn = options.failOn ?? DEFAULT_CONFIG.failOn
  if (!FAIL_ON.includes(failOn)) {
    throw new TriageError(
      ERROR_CODES.BAD_CONFIG,
      `failOn must be one of ${FAIL_ON.join(', ')}, got ${JSON.stringify(failOn)}`,
    )
  }

  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_CONFIG.timeoutMs
    : positiveInteger(options.timeoutMs, 'timeoutMs', { allowNull: false, min: 1 })

  const batchSize = options.batchSize === undefined
    ? DEFAULT_CONFIG.batchSize
    : positiveInteger(options.batchSize, 'batchSize', {
      allowNull: false, min: 1, code: ERROR_CODES.BAD_BATCH_SIZE,
    })

  return Object.freeze({
    maxItems,
    policyId: options.policyId ?? DEFAULT_CONFIG.policyId,
    tau,
    modelStateCap: positiveInteger(options.modelStateCap, 'modelStateCap', { min: 1 }),
    tokenCap: positiveInteger(options.tokenCap, 'tokenCap', { min: 1 }),
    timeoutMs,
    batchSize,
    failOn,
    // This release has no model client. Recorded rather than implied, so a report
    // can say which tier actually ran.
    modelClient: options.modelClient ?? null,
    rules: options.rules ?? null,
  })
}

/**
 * Validate the batch itself, before any work happens.
 *
 * Runs before IO so that a usage error is exit 2 and never a finding: a batch
 * that was never valid cannot have found anything.
 */
export function validateItems(items, config) {
  if (!Array.isArray(items)) {
    throw new TriageError(ERROR_CODES.BAD_ITEM, 'items must be an array')
  }
  if (items.length === 0) {
    throw new TriageError(ERROR_CODES.NO_ITEMS, 'items is empty', null, 2)
  }
  if (items.length > config.maxItems) {
    throw new TriageError(
      ERROR_CODES.TOO_MANY_ITEMS,
      `${items.length} items exceeds the cap of ${config.maxItems}; submit a smaller batch. `
        + 'This is refused rather than truncated, because a truncated batch reports a '
        + 'summary of the items that happened to arrive first.',
      null,
      2,
    )
  }
  const seen = new Set()
  items.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TriageError(ERROR_CODES.BAD_ITEM, `items[${index}] must be an object`, null, 2)
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      throw new TriageError(
        ERROR_CODES.BAD_ITEM,
        `items[${index}].id is required and must be a non-empty string; answers are keyed `
          + 'by it, so an item without one cannot be reported',
        null,
        2,
      )
    }
    if (typeof item.text !== 'string') {
      throw new TriageError(
        ERROR_CODES.BAD_ITEM,
        `items[${index}].text must be a string`,
        null,
        2,
      )
    }
    if (seen.has(item.id)) {
      // Duplicate ids are refused rather than deduplicated: silently keeping one
      // would drop a ticket, and the caller would have no way to tell which.
      throw new TriageError(
        ERROR_CODES.DUPLICATE_ID,
        `duplicate item id ${JSON.stringify(item.id)} at index ${index}; ids key the `
          + 'answers, so a duplicate makes the result ambiguous',
        null,
        3,
      )
    }
    seen.add(item.id)
  })
  return true
}
