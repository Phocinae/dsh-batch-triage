/**
 * The deterministic prefilter — the main path, not a fast path.
 *
 * The design is explicit that this is where most items should be decided, and
 * that the model is a fallback for the residue. So the rules here are written to
 * be *decided*: each one either places an item or declines to, and none of them
 * guesses. An item no rule places is `undecided`, which is a real answer.
 *
 * Ordering and precedence
 * -----------------------
 *
 * Rules are evaluated in order and the **first** match wins. That is deliberate
 * over "most specific wins": severity rules are written before volume rules, so
 * "production is down" is urgent whether or not it also mentions a typo. A
 * scoring system would need weights nobody could defend; a documented first-match
 * order is inspectable and testable.
 *
 * What the rules deliberately do not do
 * -------------------------------------
 *
 * They do not read sentiment, and they do not try to understand the ticket. A
 * rule fires on wording a maintainer would recognise, and the pattern table is
 * short on purpose: every rule added is a rule that can be wrong, and a prefilter
 * that mis-classifies confidently is worse than one that declines.
 */

/**
 * `fields` values that force a class by themselves, checked before any text rule.
 *
 * These come first because a structured field is a stronger signal than prose: a
 * reporter who sets `severity: critical` in a form has already told us, and no
 * wording in the body should be able to overrule that.
 */
export const FIELD_OVERRIDES = Object.freeze([
  { field: 'severity', values: ['critical', 'blocker', 'sev1', 's1'], class: 'urgent',
    reason: 'FIELD_SEVERITY_CRITICAL' },
  { field: 'severity', values: ['high', 'major', 'sev2', 's2'], class: 'needs_review',
    reason: 'FIELD_SEVERITY_HIGH' },
  { field: 'security', values: [true, 'true', 'yes'], class: 'urgent',
    reason: 'FIELD_SECURITY' },
  { field: 'data_loss', values: [true, 'true', 'yes'], class: 'urgent',
    reason: 'FIELD_DATA_LOSS' },
  { field: 'reporter_tier', values: ['enterprise', 'paid'], class: 'needs_review',
    reason: 'FIELD_REPORTER_TIER' },
])

/**
 * Text rules, in evaluation order.
 *
 * `urgent` rules come first so that a ticket describing an outage is not
 * downgraded because it also contains a question mark. `routine` rules come last
 * so that a ticket which *looks* like a support question but is actually a crash
 * report is not swallowed by the question rule.
 */
export const PREFILTER_RULES = Object.freeze([
  // -- urgent: something is broken for real users right now -------------------
  {
    id: 'outage',
    class: 'urgent',
    reason: 'OUTAGE_REPORTED',
    re: /\b(outage|down for (all|every)|(the |our |your |a )?(service|system|site|api|app|server|platform)s? (is |are |was |were )?(down|unavailable|unreachable|offline)|production (is )?(down|broken)|everything is (down|broken)|complete(ly)? (down|broken))\b/i,
    describes: 'says the service is down',
  },
  {
    id: 'data_loss',
    class: 'urgent',
    reason: 'DATA_LOSS_REPORTED',
    re: /\b(data ?loss|lost (all |my )?(data|files|work)|deleted (my|all)|corrupt(ed|ion)? (data|database|db)|dropped (the )?(table|database))\b/i,
    describes: 'reports data loss or corruption',
  },
  {
    id: 'security',
    class: 'urgent',
    reason: 'SECURITY_REPORTED',
    re: /\b(security (issue|vulnerabilit|hole|flaw)|vulnerabilit|exploit|CVE-\d{4}-\d+|unauthori[sz]ed access|credential (leak|expos)|leaked (key|token|password)|RCE|SQL ?injection|XSS)\b/i,
    describes: 'reports a security problem',
  },
  {
    id: 'crash_with_trace',
    class: 'urgent',
    reason: 'CRASH_WITH_STACK_TRACE',
    // Guarded by letter lookarounds, NOT by `\b`.
    //
    // This rule failed in two different ways, and the second is the instructive
    // one. First the parentheses were unescaped, so the phrase was a capture
    // group and the pattern matched `traceback most recent call last` — a string
    // nobody writes. Then, with them escaped, a trailing `\b` still killed it:
    // `\b` asserts a boundary between a word character and a non-word one, and
    // `)` is itself non-word, so `) ` has no boundary and the alternation could
    // never match.
    //
    // `(?<![a-z])` / `(?![a-z])` express what was actually meant — "not in the
    // middle of a word" — and hold whatever punctuation the phrase ends with.
    re: /(?<![a-z])(traceback \(most recent call last\)|panic:|segmentation fault|core dumped|fatal error|unhandled exception|stack ?trace:)(?![a-z])/i,
    describes: 'reports a crash with a stack trace',
  },
  {
    id: 'blocked_workflow',
    class: 'urgent',
    reason: 'BLOCKED_WORKFLOW',
    re: /\b(cannot (log ?in|sign ?in|checkout|pay)|can'?t (log ?in|sign ?in|access)|locked out|account (is )?(locked|suspended)|blocks? (all|our|the) (users?|team|customers?))\b/i,
    describes: 'says a workflow is blocked for users',
  },

  // -- needs review: a human should look, but nothing is on fire --------------
  {
    id: 'regression',
    class: 'needs_review',
    reason: 'REGRESSION_REPORTED',
    re: /\b(regression|used to work|worked (before|in|until)|stopped working|broke after|no longer works|new in this version)\b/i,
    describes: 'describes a regression',
  },
  {
    id: 'wrong_result',
    class: 'needs_review',
    reason: 'INCORRECT_RESULT',
    re: /\b(wrong (result|answer|output|value|number)|incorrect(ly)?|gives? the wrong|miscalculat|off by|silently (wrong|drops?|ignores?))\b/i,
    describes: 'reports an incorrect result',
  },
  {
    id: 'performance',
    class: 'needs_review',
    reason: 'PERFORMANCE_REPORTED',
    re: /\b(slow|slower|takes? \d+ ?(s|sec|seconds|min|minutes|hours)|timeout|time(s)? out|hangs?|freezes?|memory (leak|usage|spike)|OOM|out of memory)\b/i,
    describes: 'reports a performance problem',
  },
  {
    id: 'flaky',
    class: 'needs_review',
    reason: 'INTERMITTENT_REPORTED',
    re: /\b(intermittent|flaky|sometimes|occasionally|randomly|not always|sporadic)\b/i,
    describes: 'reports intermittent behaviour',
  },

  // -- routine: answerable without a maintainer's judgement -------------------
  {
    id: 'install_question',
    class: 'routine',
    reason: 'INSTALL_QUESTION',
    re: /\b(how (do|can) i (install|set ?up|configure|use)|where (do|can) i (find|download)|installation (instructions|steps)|getting started|quick ?start)\b/i,
    describes: 'asks how to install or configure',
  },
  {
    id: 'usage_question',
    class: 'routine',
    reason: 'USAGE_QUESTION',
    re: /\b(how (do|can) i\b|is it possible to|can i use .* for|what(?:'s| is) the (right|correct) way|which (option|flag|command))\b/i,
    describes: 'asks how to do something',
  },
  {
    id: 'documentation',
    class: 'routine',
    reason: 'DOCUMENTATION_REQUEST',
    re: /\b(documentation|docs? (are|is) (wrong|outdated|missing|unclear)|typo in the (docs?|readme)|readme (is )?(wrong|outdated))\b/i,
    describes: 'reports a documentation problem',
  },
  {
    id: 'feature_request',
    class: 'routine',
    reason: 'FEATURE_REQUEST',
    re: /\b(feature request|would be (nice|great|helpful) (if|to)|please (add|support)|enhancement|nice[- ]to[- ]have)\b/i,
    describes: 'requests a feature',
  },
  {
    id: 'thanks',
    class: 'routine',
    reason: 'NO_ACTION_NEEDED',
    re: /^\s*(thanks?|thank you|thx|cheers|great,? thanks)[\s!.,]*$/i,
    describes: 'is a thank-you with no request',
  },
])

const SEVERITY_ORDER = Object.freeze({ routine: 0, needs_review: 1, urgent: 2 })

/** Normalise a field value for override comparison. */
function fieldMatches(value, candidates) {
  if (value === undefined || value === null) return false
  const lowered = typeof value === 'string' ? value.trim().toLowerCase() : value
  return candidates.some((candidate) => {
    if (typeof candidate === 'boolean') return value === true || lowered === 'true' || lowered === 'yes'
    return lowered === String(candidate).toLowerCase()
  })
}

/**
 * Classify one item deterministically.
 *
 * Returns `{class, reason, ruleId, matched}` where `class` is `'routine'`,
 * `'needs_review'`, `'urgent'` or `'undecided'`. `undecided` is a first-class
 * answer: it means no rule claimed the item, which is different from a rule
 * saying "routine".
 */
export function prefilter(item, config) {
  const fields = item && typeof item.fields === 'object' && item.fields !== null
    ? item.fields
    : {}
  const rules = (config && config.rules) || PREFILTER_RULES

  for (const override of FIELD_OVERRIDES) {
    if (fieldMatches(fields[override.field], override.values)) {
      return {
        class: override.class,
        reason: override.reason,
        ruleId: `field:${override.field}`,
        matched: String(fields[override.field]),
      }
    }
  }

  const text = typeof item?.text === 'string' ? item.text : ''
  if (text.trim() === '') {
    // An item with no body cannot be classified by a text rule, and inventing a
    // class for it would be the guess this prefilter exists to avoid.
    return { class: 'undecided', reason: 'EMPTY_TEXT', ruleId: null, matched: '' }
  }

  for (const rule of rules) {
    const match = text.match(rule.re)
    if (match) {
      return {
        class: rule.class,
        reason: rule.reason,
        ruleId: rule.id,
        matched: match[0].length > 80 ? `${match[0].slice(0, 80)}…` : match[0],
      }
    }
  }

  return { class: 'undecided', reason: 'NO_RULE_MATCHED', ruleId: null, matched: '' }
}

/**
 * Raise a class, never lower it.
 *
 * Used when two signals disagree: the structured field says `critical` and the
 * text looks like a question. The stronger class wins, because downgrading on a
 * disagreement is the direction that loses a real outage, and the whole point of
 * the prefilter is to not lose those.
 */
export function raiseClass(a, b) {
  const left = SEVERITY_ORDER[a]
  const right = SEVERITY_ORDER[b]
  if (left === undefined || right === undefined) {
    // `undecided` is not on the ladder: it loses to any actual class, and two
    // undecideds stay undecided.
    if (left === undefined && right === undefined) return 'undecided'
    return left === undefined ? b : a
  }
  return left >= right ? a : b
}
