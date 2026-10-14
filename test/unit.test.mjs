/**
 * Test suite for dsh-batch-triage.
 *
 * No host, no network, no model. The assertions that matter most are the ones
 * pinning the direction this tool must never fail in:
 *
 *  - an item no rule can place is `needs_review`, never `routine` — including an
 *    item with an empty body;
 *  - the exit-code ladder resolves eight conditions in one documented order, and
 *    a usage error outranks a finding;
 *  - a budget cap produces `needs_review` with the budget named, so a truncated
 *    run cannot read as a complete one;
 *  - `tau` can only make a result more cautious.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EXIT, EXIT_PRIORITY, CI_ACCEPTED, exitCode } from '../lib/exit.mjs'
import { resolveConfig, validateItems, MAX_ITEMS, FAIL_ON } from '../lib/config.mjs'
import { ERROR_CODES, TriageError } from '../lib/errors.mjs'
import { prefilter, PREFILTER_RULES, FIELD_OVERRIDES, raiseClass } from '../lib/prefilter.mjs'
import { triageBatch } from '../lib/triage.mjs'
import { createTools } from '../tools.mjs'
import { createSkill } from '../lib/skill.mjs'

const config = resolveConfig({})

function item(id, text, fields) {
  return fields === undefined ? { id, text } : { id, text, fields }
}

// ---------------------------------------------------------------------------
// A. the prefilter's direction
// ---------------------------------------------------------------------------

test('an item no rule matches is undecided, not routine', () => {
  const verdict = prefilter(item('1', 'The frobnitz is blorp and the wibble is spang.'), config)
  assert.equal(verdict.class, 'undecided')
  assert.equal(verdict.reason, 'NO_RULE_MATCHED')
})

test('an item with an EMPTY body is undecided, not routine', () => {
  for (const text of ['', '   ', '\n\t ']) {
    const verdict = prefilter(item('1', text), config)
    assert.equal(verdict.class, 'undecided', JSON.stringify(text))
    assert.equal(verdict.reason, 'EMPTY_TEXT')
  }
})

test('AND AN UNDECIDED ITEM BECOMES needs_review, NEVER routine', () => {
  const result = triageBatch([item('1', 'The frobnitz is blorp.')], config)
  assert.equal(result.items[0].class, 'needs_review')
  assert.equal(result.items[0].deterministicClass, 'undecided')
  assert.equal(result.items[0].escalate, true)
  assert.notEqual(result.items[0].class, 'routine')
})

test('urgent wording is recognised', () => {
  const cases = [
    ['The service is down for all users', 'OUTAGE_REPORTED'],
    ['We lost all data after the upgrade', 'DATA_LOSS_REPORTED'],
    ['Possible CVE-2026-1234 in the parser', 'SECURITY_REPORTED'],
    ['Traceback (most recent call last): boom', 'CRASH_WITH_STACK_TRACE'],
    ['I cannot log in and my account is locked', 'BLOCKED_WORKFLOW'],
  ]
  for (const [text, reason] of cases) {
    const verdict = prefilter(item('1', text), config)
    assert.equal(verdict.class, 'urgent', text)
    assert.equal(verdict.reason, reason, text)
  }
})

test('routine wording is recognised', () => {
  const cases = [
    ['How do I install this on Windows?', 'INSTALL_QUESTION'],
    ['Where can I find the download?', 'INSTALL_QUESTION'],
    ['The documentation is outdated', 'DOCUMENTATION_REQUEST'],
    ['Feature request: please add CSV export', 'FEATURE_REQUEST'],
    ['Thanks!', 'NO_ACTION_NEEDED'],
  ]
  for (const [text, reason] of cases) {
    const verdict = prefilter(item('1', text), config)
    assert.equal(verdict.class, 'routine', text)
    assert.equal(verdict.reason, reason, text)
  }
})

test('urgent rules are evaluated before routine ones', () => {
  // A ticket that is both an outage report and phrased as a question must not be
  // swallowed by the question rule. This is why the order is documented rather
  // than derived from a score.
  const text = 'How do I stop the outage? The service is down for all users.'
  const verdict = prefilter(item('1', text), config)
  assert.equal(verdict.class, 'urgent')
  assert.equal(verdict.reason, 'OUTAGE_REPORTED')
})

test('a structured field outranks the body text', () => {
  // The body looks routine; the field says critical. The field wins.
  const verdict = prefilter(
    item('1', 'How do I install this?', { severity: 'critical' }), config)
  assert.equal(verdict.class, 'urgent')
  assert.equal(verdict.reason, 'FIELD_SEVERITY_CRITICAL')
})

test('A FIELD CAN NEVER BURY AN OUTAGE', () => {
  // This is the blocker an independent check found in 0.1.0. The field override
  // returned immediately, so a field could only ever *lower* a verdict:
  // `{severity: 'high'}` beside "The service is down for all users" produced
  // `needs_review`, and the run then exited 0 as clean. A production outage was
  // silenced by a field that was only meant to add information.
  //
  // `raiseClass` was written for exactly this, exported, imported -- and never
  // called.
  const body = 'The service is down for all users'
  for (const fields of [
    { severity: 'high' }, { severity: 'major' }, { severity: 'sev2' },
    { severity: 's2' }, { reporter_tier: 'enterprise' },
  ]) {
    const verdict = prefilter(item('1', body, fields), config)
    assert.equal(verdict.class, 'urgent', JSON.stringify(fields))
    assert.equal(verdict.reason, 'OUTAGE_REPORTED')
    assert.ok(
      verdict.reasonCodes.some((code) => code.includes('OVERRULED_BY_STRONGER_TEXT')),
      `the disagreement must be recorded, got ${JSON.stringify(verdict.reasonCodes)}`,
    )
  }

  // And the end-to-end consequence: the batch reports the outage, not a clean run.
  const result = triageBatch([item('a', body, { severity: 'high' })], config)
  assert.equal(result.items[0].class, 'urgent')
  assert.deepEqual(result.summary.urgentIds, ['a'])
  assert.equal(result.exitCode, EXIT.FINDINGS)
})

test('the two signals are combined, and the stronger one wins either way', () => {
  // Field higher than text.
  assert.equal(prefilter(item('1', 'How do I install this?',
    { severity: 'critical' }), config).class, 'urgent')
  // Text higher than field.
  assert.equal(prefilter(item('1', 'The service is down for all users',
    { severity: 'high' }), config).class, 'urgent')
  // Agreement produces one code, not a spurious disagreement.
  const agree = prefilter(item('1', 'The service is down for all users',
    { severity: 'critical' }), config)
  assert.equal(agree.class, 'urgent')
  assert.ok(!agree.reasonCodes.some((code) => code.includes('OVERRULED')),
    JSON.stringify(agree.reasonCodes))
  // A field with no readable text still decides on its own.
  assert.equal(prefilter(item('1', '', { severity: 'critical' }), config).class, 'urgent')
})

test('field overrides cover the documented signals', () => {
  const cases = [
    [{ severity: 'BLOCKER' }, 'urgent'],
    [{ severity: 'high' }, 'needs_review'],
    [{ security: true }, 'urgent'],
    [{ data_loss: 'yes' }, 'urgent'],
    [{ reporter_tier: 'enterprise' }, 'needs_review'],
  ]
  for (const [fields, expected] of cases) {
    const verdict = prefilter(item('1', 'anything at all', fields), config)
    assert.equal(verdict.class, expected, JSON.stringify(fields))
  }
})

test('the severity vocabulary covers the labels reporters actually use', () => {
  // 0.1.0 accepted four labels per tier, so `severity: 'P0'` -- standard vocabulary
  // for the most severe class -- was indistinguishable from *no severity at all*,
  // and an innocuous body then came out `routine`.
  for (const value of ['critical', 'blocker', 'sev1', 's1', 'P0', 'p1', 'urgent',
    'emergency', 'showstopper', 'sev-1', 'severity 1', '1', 'highest']) {
    const verdict = prefilter(item('1', 'body', { severity: value }), config)
    assert.equal(verdict.class, 'urgent', `severity ${value}`)
  }
  for (const value of ['high', 'major', 'sev2', 's2', 'P2', 'medium', 'moderate', 'P3']) {
    const verdict = prefilter(item('1', 'body', { severity: value }), config)
    assert.equal(verdict.class, 'needs_review', `severity ${value}`)
  }
})

test('AN UNRECOGNISED SEVERITY IS A QUESTION, NOT AN ABSENCE', () => {
  // `severity: 'banana'` dropping to "no severity set" is how a real priority
  // silently becomes routine. Raising it to urgent would invent a signal. So it
  // is needs_review with its own code -- the same answer this prefilter gives
  // everything it cannot place.
  for (const value of ['P4', 'banana', 'kritisch', 'sev9']) {
    const verdict = prefilter(
      item('1', 'How do I install this?', { severity: value }), config)
    assert.notEqual(verdict.class, 'routine', `severity ${value}`)
    assert.equal(verdict.class, 'needs_review', `severity ${value}`)
    assert.equal(verdict.reason, 'FIELD_SEVERITY_UNRECOGNISED')
  }

  // An absent severity is not unrecognised, and must not raise anything.
  assert.equal(prefilter(item('1', 'How do I install this?', {}), config).class, 'routine')
  assert.equal(prefilter(item('1', 'How do I install this?',
    { severity: '' }), config).class, 'routine')

  // An unrecognised severity never lowers a body that is already more severe.
  const urgent = prefilter(
    item('1', 'The service is down for all users', { severity: 'banana' }), config)
  assert.equal(urgent.class, 'urgent')
})

test('raiseClass can only go up', () => {
  assert.equal(raiseClass('routine', 'urgent'), 'urgent')
  assert.equal(raiseClass('urgent', 'routine'), 'urgent')
  assert.equal(raiseClass('needs_review', 'routine'), 'needs_review')
  assert.equal(raiseClass('undecided', 'routine'), 'routine', 'undecided loses to any class')
  assert.equal(raiseClass('undecided', 'undecided'), 'undecided')
})

test('every rule has a unique id and a describable class', () => {
  const ids = PREFILTER_RULES.map((rule) => rule.id)
  assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique')
  for (const rule of PREFILTER_RULES) {
    assert.ok(['routine', 'needs_review', 'urgent'].includes(rule.class), rule.id)
    assert.ok(rule.describes && rule.describes.length > 5, rule.id)
    assert.ok(rule.reason && rule.reason.length > 3, rule.id)
  }
  assert.ok(FIELD_OVERRIDES.length >= 4)
})

// ---------------------------------------------------------------------------
// B. the exit-code ladder
// ---------------------------------------------------------------------------

test('the ladder resolves single conditions', () => {
  assert.equal(exitCode({}), EXIT.CLEAN)
  assert.equal(exitCode({ findings: true }), EXIT.FINDINGS)
  assert.equal(exitCode({ expectFailed: true }), EXIT.EXPECT_FAILED)
  assert.equal(exitCode({ modelUnavailable: true }), EXIT.MODEL_UNAVAILABLE)
  assert.equal(exitCode({ budgetZero: true }), EXIT.BUDGET_ZERO)
  assert.equal(exitCode({ emptyScan: true }), EXIT.EMPTY_SCAN)
  assert.equal(exitCode({ config: true }), EXIT.CONFIG)
  assert.equal(exitCode({ usage: true }), EXIT.USAGE)
})

test('THE LADDER HAS A DOCUMENTED PRIORITY, and it holds', () => {
  // Everything at once: the top of the ladder wins.
  assert.equal(exitCode({
    usage: true, config: true, emptyScan: true, budgetZero: true,
    modelUnavailable: true, expectFailed: true, findings: true,
  }), EXIT.USAGE)

  // A usage error outranks a finding, because a run that was never valid cannot
  // have found anything.
  assert.equal(exitCode({ usage: true, findings: true }), EXIT.USAGE)

  // An empty scan outranks a clean result.
  assert.equal(exitCode({ emptyScan: true, findings: false }), EXIT.EMPTY_SCAN)

  // But config outranks empty scan: a misconfiguration is more actionable.
  assert.equal(exitCode({ emptyScan: true, config: true }), EXIT.CONFIG)

  // And findings is the lowest rung above clean.
  assert.equal(exitCode({ findings: true, modelUnavailable: true }),
    EXIT.MODEL_UNAVAILABLE)
})

test('the ladder is ordered by code as documented', () => {
  const order = EXIT_PRIORITY.map((rung) => rung.code)
  assert.deepEqual(order, [
    EXIT.USAGE, EXIT.CONFIG, EXIT.EMPTY_SCAN, EXIT.BUDGET_ZERO,
    EXIT.MODEL_UNAVAILABLE, EXIT.EXPECT_FAILED, EXIT.FINDINGS, EXIT.CLEAN,
  ])
  for (const rung of EXIT_PRIORITY) {
    assert.ok(rung.why && rung.why.length > 10, String(rung.code))
  }
})

test('an unrecognised condition is refused, not ignored', () => {
  // Silently ignoring an unknown flag could drop the very condition that should
  // have produced a non-zero code.
  assert.throws(() => exitCode({ findigns: true }), (error) => {
    assert.equal(error.code, 'TRIAGE_BAD_EXIT_FACT')
    assert.equal(error.exitCode, EXIT.USAGE)
    return true
  })
})

test('the CI-accepted set is stated, because 1 is not a failure', () => {
  assert.deepEqual([...CI_ACCEPTED], [EXIT.CLEAN, EXIT.FINDINGS, EXIT.MODEL_UNAVAILABLE])
  assert.ok(!CI_ACCEPTED.includes(EXIT.EMPTY_SCAN))
  assert.ok(!CI_ACCEPTED.includes(EXIT.CONFIG))
})

// ---------------------------------------------------------------------------
// C. the batch runner
// ---------------------------------------------------------------------------

test('a mixed batch classifies every item, and the coverage gap outranks the finding', () => {
  // The design's ladder puts model-unavailable (6) above findings (1), and this
  // test originally expected 1 -- which was my expectation being wrong, not the
  // code. The reasoning is worth writing down, because it looks backwards:
  //
  // 6 does not mean "nothing happened". It means "this run could not cover
  // everything it needed to", which is a statement about the whole run. 1 means
  // "the run covered what it needed and some of it needs a human". When both are
  // true, 6 is the stronger fact and it is a superset: a caller who reacts to 6
  // will look, and will see the urgent item in the summary.
  //
  // The danger this creates is a caller reading only the exit code and concluding
  // the batch was fine. So the assertion that matters is not the code -- it is
  // that the urgent item survives in the summary, where a reader cannot miss it.
  const result = triageBatch([
    item('a', 'The service is down for all users'),
    item('b', 'How do I install this?'),
    item('c', 'The frobnitz is blorp.'),
  ], config)
  assert.equal(result.summary.total, 3)
  assert.equal(result.summary.counts.urgent, 1)
  assert.equal(result.summary.counts.routine, 1)
  assert.equal(result.summary.counts.needs_review, 1)
  assert.equal(result.exitCode, EXIT.MODEL_UNAVAILABLE)
  assert.equal(result.exitBasis, 'modelUnavailable')

  // The finding is not lost behind the coverage gap.
  assert.deepEqual(result.summary.urgentIds, ['a'])
  assert.deepEqual(result.summary.escalatedIds, ['c'])
  const urgent = result.items.find((entry) => entry.id === 'a')
  assert.equal(urgent.class, 'urgent')
})

test('with a model client configured, a mixed batch is findings, not a gap', () => {
  // Same batch, but the residue can be handled, so the coverage-gap rung does
  // not fire and the finding is what remains.
  const withClient = resolveConfig({ modelClient: () => ({}) })
  const result = triageBatch([
    item('a', 'The service is down for all users'),
    item('b', 'How do I install this?'),
    item('c', 'The frobnitz is blorp.'),
  ], withClient)
  assert.equal(result.summary.skippedModel, false)
  assert.equal(result.exitCode, EXIT.FINDINGS)
  assert.equal(result.exitBasis, 'findings')
})

test('a batch of nothing but routine items exits 0', () => {
  const result = triageBatch([
    item('a', 'How do I install this?'),
    item('b', 'Thanks!'),
  ], config)
  assert.equal(result.exitCode, EXIT.CLEAN)
  assert.deepEqual(result.summary.escalatedIds, [])
})

test('an all-undecided batch exits 6, not 0', () => {
  // Nothing could be classified, so the run must not read as clean. Exit 6 says
  // "the model was not there", which is a successful run with a stated gap.
  const result = triageBatch([item('a', 'blorp spang wibble')], config)
  assert.equal(result.summary.skippedModel, true)
  assert.equal(result.exitCode, EXIT.MODEL_UNAVAILABLE)
  assert.equal(result.items[0].class, 'needs_review')
  assert.ok(result.items[0].reasonCodes.includes('MODEL_NOT_CONFIGURED'))
})

test('a budget cap produces needs_review with the budget NAMED', () => {
  // A cap is a decision, not a silent drop. The item must say which budget
  // stopped it, or a truncated run reads as a complete one.
  //
  // The cap is 1 and the batch has 2 residual items, so exactly one is refused.
  // `modelStateCap: 0` is a *configuration error* rather than this state, and is
  // covered separately below -- accepting 0 would turn a contradiction ("give
  // these model coverage, and also forbid it") into a triage result.
  const capped = resolveConfig({ modelClient: () => ({}), modelStateCap: 1 })
  const result = triageBatch([
    item('a', 'blorp spang wibble'),
    item('b', 'frobnitz quux'),
  ], capped)
  const refused = result.items.find((entry) => entry.decidedBy === 'budget')
  assert.ok(refused, 'exactly one item should have been refused by the cap')
  assert.ok(refused.reasonCodes.includes('BUDGET_EXHAUSTED'))
  assert.equal(refused.class, 'needs_review')
  assert.equal(result.summary.budgetRefusals, 1)
})

test('modelStateCap of 0 is refused at load, as a bad config rather than a result', () => {
  assert.throws(() => resolveConfig({ modelStateCap: 0 }), (error) => {
    assert.equal(error.code, ERROR_CODES.BAD_CONFIG)
    assert.match(error.message, /configuration error/)
    return true
  })
  // `-0` is the same cap spelled differently and must be refused the same way:
  // `-0 < 0` is false, so without an explicit check it would load as a cap of 0 and
  // reach `deriveExit`'s "the cap was zero" rung, which `min: 1` exists to prevent.
  assert.throws(() => resolveConfig({ modelStateCap: -0 }), (error) => {
    assert.equal(error.code, ERROR_CODES.BAD_CONFIG)
    return true
  })
})

test('failOn narrows what counts as a finding', () => {
  const withClient = resolveConfig({ modelClient: () => ({}) })
  const batch = [
    item('a', 'The service is down for all users'),
    item('b', 'The frobnitz is blorp.'),
  ]
  assert.equal(triageBatch(batch, withClient).exitCode, EXIT.FINDINGS)
  assert.equal(
    triageBatch(batch, resolveConfig({ modelClient: () => ({}), failOn: 'urgent' })).exitCode,
    EXIT.FINDINGS,
  )

  // An escalation with no urgent item: `any` counts it, `urgent` does not.
  const onlyEscalation = [item('b', 'The frobnitz is blorp.')]
  assert.equal(triageBatch(onlyEscalation, withClient).exitCode, EXIT.FINDINGS)
  assert.equal(
    triageBatch(onlyEscalation,
      resolveConfig({ modelClient: () => ({}), failOn: 'urgent' })).exitCode,
    EXIT.CLEAN,
    'failOn: urgent ignores a non-urgent escalation',
  )

  // failOn: none asks for a report rather than a gate, so nothing is a finding.
  assert.equal(
    triageBatch([item('a', 'The service is down for all users')],
      resolveConfig({ modelClient: () => ({}), failOn: 'none' })).exitCode,
    EXIT.CLEAN,
  )
})

test('a model client being configured does not fabricate a model tier', () => {
  // The branch must say it is unimplemented rather than pretend. A configured
  // client that is never driven must not change the class.
  const withClient = resolveConfig({ modelClient: () => ({}) })
  const result = triageBatch([item('a', 'blorp spang')], withClient)
  assert.equal(result.items[0].class, 'needs_review')
  assert.ok(result.items[0].reasonCodes.includes('MODEL_TIER_NOT_IMPLEMENTED'))
  assert.equal(result.summary.modelClientConfigured, true)
  assert.equal(result.summary.skippedModel, false, 'a client is configured, so nothing was skipped')
})

test('tau can only make the result MORE cautious', () => {
  const borderline = [item('a', 'This used to work before the update.')]
  const without = triageBatch(borderline, config)
  assert.equal(without.items[0].class, 'needs_review')

  const withTau = triageBatch(borderline, resolveConfig({ tau: 0.9 }))
  assert.equal(withTau.items[0].class, 'needs_review', 'tau never lowers a class')
  assert.ok(withTau.items[0].escalate)
  assert.ok(withTau.items[0].reasonCodes.includes('TAU_ESCALATION_GATE_NOT_MET_BY_PREFILTER'))
})

test('tau never downgrades an urgent item', () => {
  const urgent = [item('a', 'The service is down for all users')]
  const result = triageBatch(urgent, resolveConfig({ tau: 0.001 }))
  assert.equal(result.items[0].class, 'urgent')
})

// ---------------------------------------------------------------------------
// D. batch validation
// ---------------------------------------------------------------------------

test('an empty batch is a usage error and never a finding', () => {
  assert.throws(() => triageBatch([], config), (error) => {
    assert.equal(error.code, ERROR_CODES.NO_ITEMS)
    assert.equal(error.exitCode, EXIT.USAGE)
    return true
  })
})

test('an oversized batch is REJECTED, not truncated', () => {
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item(`i${i}`, 'How do I install?'))
  assert.throws(() => triageBatch(many, config), (error) => {
    assert.equal(error.code, ERROR_CODES.TOO_MANY_ITEMS)
    assert.match(error.message, /refused rather than truncated/)
    return true
  })
  // The cap itself is allowed.
  const exact = Array.from({ length: MAX_ITEMS }, (_, i) => item(`i${i}`, 'How do I install?'))
  assert.equal(triageBatch(exact, config).summary.total, MAX_ITEMS)
})

test('duplicate ids are refused, because ids key the answers', () => {
  assert.throws(() => triageBatch([item('a', 'x'), item('a', 'y')], config), (error) => {
    assert.equal(error.code, ERROR_CODES.DUPLICATE_ID)
    assert.equal(error.exitCode, EXIT.CONFIG)
    return true
  })
})

test('a malformed item is refused with its index', () => {
  const cases = [
    [[item('a', 'x'), { text: 'no id' }], ERROR_CODES.BAD_ITEM],
    [[item('a', 'x'), { id: '', text: 'x' }], ERROR_CODES.BAD_ITEM],
    [[item('a', 'x'), { id: 'b' }], ERROR_CODES.BAD_ITEM],
    ['not an array', ERROR_CODES.BAD_ITEM],
  ]
  for (const [items, code] of cases) {
    assert.throws(() => triageBatch(items, config), (error) => {
      assert.equal(error.code, code, JSON.stringify(items))
      return true
    })
  }
})

test('validateItems returns true for a well-formed batch', () => {
  assert.equal(validateItems([item('a', 'x')], config), true)
})

// ---------------------------------------------------------------------------
// E. configuration
// ---------------------------------------------------------------------------

test('tau outside [0,1] is refused rather than silently clamped', () => {
  for (const tau of [-0.1, 1.1, 2, Number.NaN, '0.5']) {
    assert.throws(() => resolveConfig({ tau }), (error) => {
      assert.equal(error.code, ERROR_CODES.BAD_TAU)
      return true
    }, JSON.stringify(tau))
  }
  assert.equal(resolveConfig({ tau: 0 }).tau, 0)
  assert.equal(resolveConfig({ tau: 1 }).tau, 1)
  assert.equal(resolveConfig({}).tau, null)
})

test('a zero or negative cap is refused', () => {
  for (const maxItems of [0, -1, 1.5]) {
    assert.throws(() => resolveConfig({ maxItems }), TriageError, String(maxItems))
  }
  for (const batchSize of [0, -1]) {
    assert.throws(() => resolveConfig({ batchSize }), (error) => {
      assert.equal(error.code, ERROR_CODES.BAD_BATCH_SIZE)
      return true
    })
  }
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), TriageError)
})

test('an unknown failOn is refused and the valid set is discoverable', () => {
  assert.throws(() => resolveConfig({ failOn: 'maybe' }), (error) => {
    assert.match(error.message, new RegExp(FAIL_ON.join('|')))
    return true
  })
})

// ---------------------------------------------------------------------------
// F. the tool definition and the skill
// ---------------------------------------------------------------------------

test('the tool definition stays inside the host JSON Schema subset', () => {
  const tools = createTools(config)
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'batch_triage')
  assert.ok(tool.parameters, 'the model-facing field is `parameters`')
  assert.equal(tool.inputSchema, undefined)
  assert.ok(tool.output && tool.output.schema)

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (!node || typeof node !== 'object') return
    if ('type' in node) {
      assert.equal(typeof node.type, 'string', `${path}.type must be one scalar type`)
    }
    if ('required' in node) assert.ok(Array.isArray(node.required), `${path}.required`)
    assert.notEqual(node.required, true, `${path} must not use per-property required: true`)
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
  walk(tool.parameters, 'parameters')
  walk(tool.output.schema, 'output.schema')
})

test('the tool output carries exactly the declared keys', async () => {
  const tool = createTools(config)[0]
  const result = await tool.execute({ items: [item('a', 'How do I install?')] })
  const declaredTop = new Set(Object.keys(tool.output.schema.properties))
  for (const key of Object.keys(result)) {
    assert.ok(declaredTop.has(key), `undeclared top-level output key ${key}`)
  }
  for (const key of declaredTop) assert.ok(key in result, `declared key ${key} missing`)

  const summaryDeclared = new Set(
    Object.keys(tool.output.schema.properties.summary.properties))
  for (const key of Object.keys(result.summary)) {
    assert.ok(summaryDeclared.has(key), `undeclared summary key ${key}`)
  }

  const itemDeclared = new Set(
    Object.keys(tool.output.schema.properties.items.items.properties))
  for (const entry of result.items) {
    for (const key of Object.keys(entry)) {
      assert.ok(itemDeclared.has(key), `undeclared item key ${key}`)
    }
  }
})

test('the tool reports the gap rather than hiding it', async () => {
  const tool = createTools(config)[0]
  const result = await tool.execute({ items: [item('a', 'blorp spang wibble')] })
  assert.equal(result.summary.skippedModel, true)
  assert.equal(result.exitCode, EXIT.MODEL_UNAVAILABLE)
  assert.match(result.note, /none is reported as routine/)
})

test('the skill is generated from the live rule table', () => {
  const skill = createSkill(config)
  assert.equal(skill.name, 'batch-triage')
  for (const rule of PREFILTER_RULES) {
    assert.match(skill.body, new RegExp(rule.id), `skill must mention ${rule.id}`)
  }
  assert.match(skill.body, /never/)
  assert.equal(skill.maxItems, config.maxItems)
})
