/**
 * The `batch_triage` tool.
 *
 * Hand-built `ToolDefinition` rather than a builder's output, so the plugin has no
 * run-time dependency on the harness's tool helpers. Two schema facts the registry
 * enforces, learned by registering against a real host:
 *
 *  - the model-facing field is `parameters` (raw JSON Schema), not `inputSchema`;
 *  - both `parameters` and `output.schema` must stay inside the harness's enforced
 *    JSON Schema subset: one scalar `type` per node, `required` as an array of
 *    names, `oneOf` for unions, and no author-only keywords such as a per-property
 *    `required: true`.
 *
 * The `enum` lists are written out rather than imported from `CLASSES`, because
 * the schema is the contract the host validates against and a computed list would
 * change shape silently if the constant ever moved.
 */
import { resolveConfig } from './lib/config.mjs'
import { triageBatch } from './lib/triage.mjs'

const TRIAGE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Unique id for this ticket. Answers are keyed by it, and a duplicate '
        + 'is refused rather than merged.',
    },
    source: {
      type: 'string',
      description: 'Origin marker, e.g. "github:owner/repo#12". Free text.',
    },
    text: {
      type: 'string',
      description: 'The ticket body, verbatim. Do not paraphrase: the prefilter matches '
        + 'wording, and rewording it changes the verdict.',
    },
    fields: {
      type: 'object',
      description: 'Structured fields (severity, security, data_loss, reporter_tier, ...). '
        + 'A structured field outranks the body text, because a reporter who set '
        + 'severity=critical has already said so.',
    },
  },
  required: ['id', 'text'],
}

const BATCH_TRIAGE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: TRIAGE_ITEM_SCHEMA,
      description: 'Tickets to triage, 1..64 per call. A larger submission is rejected, '
        + 'not truncated.',
    },
    tau: {
      type: 'number',
      description: 'Escalation threshold in [0,1]. Asymmetric: it can only make the '
        + 'result more cautious, never less.',
    },
    modelStateCap: {
      type: 'integer',
      description: 'Max tickets that may reach the model in this call. Tickets beyond it '
        + 'are needs_review with reason BUDGET_EXHAUSTED.',
    },
    failOn: {
      type: 'string',
      enum: ['any', 'urgent', 'none'],
      description: 'What counts as a finding for the exit code. Default "any".',
    },
  },
  required: ['items'],
}

const ITEM_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    class: { type: 'string', enum: ['routine', 'needs_review', 'urgent'] },
    deterministicClass: {
      type: 'string',
      enum: ['routine', 'needs_review', 'urgent', 'undecided'],
    },
    modelClass: {
      type: 'string',
      enum: ['routine', 'needs_review', 'urgent', 'unavailable'],
    },
    score: { type: 'integer', description: 'Urgency 2..10; 0 means not scored.' },
    confidence: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    top2Margin: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    escalate: { type: 'boolean' },
    decidedBy: {
      type: 'string',
      enum: ['prefilter', 'rulepack', 'model', 'budget', 'unavailable', 'error'],
    },
    reasonCodes: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'class', 'deterministicClass', 'modelClass', 'score', 'confidence',
    'top2Margin', 'escalate', 'decidedBy', 'reasonCodes'],
}

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    routine: { type: 'integer' },
    needsReview: { type: 'integer' },
    urgent: { type: 'integer' },
    urgentIds: { type: 'array', items: { type: 'string' } },
    escalatedIds: { type: 'array', items: { type: 'string' } },
    decidedByPrefilter: { type: 'integer' },
    decidedByUnavailable: { type: 'integer' },
    decidedByBudget: { type: 'integer' },
    skippedModel: { type: 'boolean' },
    modelClientConfigured: { type: 'boolean' },
  },
  required: ['total', 'routine', 'needsReview', 'urgent', 'urgentIds', 'escalatedIds',
    'decidedByPrefilter', 'decidedByUnavailable', 'decidedByBudget', 'skippedModel',
    'modelClientConfigured'],
}

const BATCH_TRIAGE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: SUMMARY_SCHEMA,
    items: { type: 'array', items: ITEM_OUTPUT_SCHEMA },
    exitCode: { type: 'integer' },
    exitBasis: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['summary', 'items', 'exitCode', 'exitBasis', 'note'],
}

export function createTools(config, logger = null) {
  return [
    {
      name: 'batch_triage',
      description:
        'Triage a batch of tickets deterministically. A rule-based prefilter classifies '
        + 'every item first; items no rule can place become needs_review rather than '
        + 'being guessed at. Never reports an unclassified item as routine. Returns '
        + 'per-item classes with the reason code that decided each one.',
      parameters: BATCH_TRIAGE_PARAMETERS,
      output: { schema: BATCH_TRIAGE_OUTPUT },
      async execute(input = {}) {
        // Per-call overrides are resolved through the same validator as the
        // plugin config, so `tau: 2` fails here the same way it fails at load.
        const callConfig = resolveConfig({
          ...config,
          tau: input.tau === undefined ? config.tau : input.tau,
          modelStateCap: input.modelStateCap === undefined
            ? config.modelStateCap
            : input.modelStateCap,
          failOn: input.failOn === undefined ? config.failOn : input.failOn,
        })
        const result = triageBatch(input.items, callConfig)
        const counts = result.summary.counts
        if (logger && typeof logger.info === 'function') {
          logger.info(`batch_triage: ${result.summary.total} items, exit ${result.exitCode}`)
        }
        return {
          summary: {
            total: result.summary.total,
            routine: counts.routine,
            needsReview: counts.needs_review,
            urgent: counts.urgent,
            urgentIds: result.summary.urgentIds,
            escalatedIds: result.summary.escalatedIds,
            decidedByPrefilter: result.summary.decidedBy.prefilter || 0,
            decidedByUnavailable: result.summary.decidedBy.unavailable || 0,
            decidedByBudget: result.summary.decidedBy.budget || 0,
            skippedModel: result.summary.skippedModel,
            modelClientConfigured: result.summary.modelClientConfigured,
          },
          items: result.items,
          exitCode: result.exitCode,
          exitBasis: result.exitBasis,
          note: 'Deterministic tier only. Items no rule placed are needs_review with the '
            + 'reason stated; none is reported as routine.',
        }
      },
    },
  ]
}

/** Names this plugin registers, for tests and for a host's diffing. */
export const TOOL_NAMES = Object.freeze(['batch_triage'])
