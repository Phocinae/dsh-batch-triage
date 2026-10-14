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
 * A rule's **class** decides, not its position: every rule is evaluated and the
 * highest class wins, with ties going to the earlier rule in the table. A scoring
 * system would need weights nobody could defend; a class ladder needs none, and
 * the table order stays as the documented tiebreak.
 *
 * It used to be a race — the first match decided the whole ticket. For the table
 * below that is the *same* answer, because the table is sorted by class. It stops
 * being the same answer the moment a rule can match one sentence of a ticket whose
 * other sentence reports an outage, or the moment a caller passes its own `rules`
 * array in any order, which `config.rules` permits. Precedence by class is a
 * property of the rules; precedence by position is a property of whoever typed the
 * table, and 0.1.2 exists because that property was load-bearing and nobody said so.
 *
 * Class precedence alone is not enough, though, and the guard in `prefilter()` is
 * the other half: a `routine` rule matching the question half of a ticket must not
 * decide the ticket while the other half reports something broken that no severity
 * rule could name. Severity rules lose that race only when their vocabulary does
 * not contain the wording, and a vocabulary is always finite.
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
 *
 * The vocabularies are deliberately wide. An earlier version accepted only four
 * labels per tier, which meant `severity: 'P0'` — standard reporter vocabulary for
 * the most severe class — was indistinguishable from *no severity at all*, and an
 * innocuous body then came out `routine`. An unrecognised severity is now handled
 * by `unrecognisedSeverity()` rather than being silently dropped.
 */
export const FIELD_OVERRIDES = Object.freeze([
  {
    field: 'severity',
    values: [
      'critical', 'blocker', 'sev1', 's1', 'p0', 'p1', 'urgent', 'emergency',
      'showstopper', 'sev-1', 'sev_1', 'severity 1', '1', 'highest', 'production down',
    ],
    class: 'urgent',
    reason: 'FIELD_SEVERITY_CRITICAL',
  },
  {
    field: 'severity',
    values: ['high', 'major', 'sev2', 's2', 'p2', 'sev-2', 'sev_2', 'severity 2', '2'],
    class: 'needs_review',
    reason: 'FIELD_SEVERITY_HIGH',
  },
  {
    field: 'severity',
    values: ['medium', 'moderate', 'normal', 'sev3', 's3', 'p3', 'severity 3', '3'],
    class: 'needs_review',
    reason: 'FIELD_SEVERITY_MEDIUM',
  },
  { field: 'security', values: [true, 'true', 'yes'], class: 'urgent',
    reason: 'FIELD_SECURITY' },
  { field: 'data_loss', values: [true, 'true', 'yes'], class: 'urgent',
    reason: 'FIELD_DATA_LOSS' },
  { field: 'reporter_tier', values: ['enterprise', 'paid'], class: 'needs_review',
    reason: 'FIELD_REPORTER_TIER' },
])

/**
 * A severity value that is set but not recognised.
 *
 * The question this answers: what should happen to `severity: 'P4'`, or
 * `severity: 'banana'`? Dropping it makes an unrecognised value behave exactly
 * like an absent one, which is how a real priority silently becomes `routine`.
 * Raising it to urgent would invent a signal.
 *
 * So it becomes `needs_review` with its own reason code: the field said
 * *something* about priority and this release does not know what, which is a
 * question for a human rather than a guess in either direction. That is the same
 * answer the prefilter gives everything it cannot place.
 */
export function unrecognisedSeverity(fields) {
  if (!fields || typeof fields !== 'object') return null
  const value = fields.severity
  if (value === undefined || value === null || value === '') return null
  for (const override of FIELD_OVERRIDES) {
    if (override.field !== 'severity') continue
    if (fieldMatches(value, override.values)) return null
  }
  return { value: String(value) }
}

/**
 * Text rules.
 *
 * The list is written strongest class first so that it reads as the ladder it is,
 * and so that a tie inside a class resolves to the rule a maintainer listed first.
 * Precedence itself is by class, not by position — see the header.
 */
export const PREFILTER_RULES = Object.freeze([
  // -- urgent: something is broken for real users right now -------------------
  {
    id: 'outage',
    class: 'urgent',
    reason: 'OUTAGE_REPORTED',
    // The vocabulary is the half of this rule that failed in 0.1.1: `outage` knew
    // `down`/`unavailable`/`unreachable`/`offline` and nothing else, so a ticket
    // saying the API "returns 500 for every request" or that the app "is unusable"
    // matched no severity rule at all and was then decided by whichever routine rule
    // recognised the question half. Both halves of how a real outage is written —
    // the state (`is unusable`) and the symptom (`returns 500`) — are now here.
    //
    // `5xx` only, deliberately. A `4xx` is as often the caller's own request being
    // rejected as it is the service failing, and widening this rule to every HTTP
    // status code would make "why does this return 401?" an outage.
    re: /\b(outage|down for (all|every)|(the |our |your |a )?(service|system|site|api|app|server|platform|dashboard|backend|endpoint)s? (is |are |was |were )?(down|unavailable|unreachable|offline|unusable|not usable|not working|dead)|production (is )?(down|broken|unusable|failing)|everything is (down|broken|unusable)|complete(ly)? (down|broken|unusable)|(returns?|returning|throwing|throws?|serving|serves?|giving|gives?) (a |an |me )?5\d\d|5\d\d (errors?|responses?|status))\b/i,
    describes: 'says the service is down, unusable or erroring',
  },
  {
    id: 'data_loss',
    class: 'urgent',
    reason: 'DATA_LOSS_REPORTED',
    // "We are seeing records deleted from our database" matched none of the 0.1.1
    // alternatives — `deleted (my|all)` wanted a possessive and `dropped the table`
    // wanted a different verb — so the rule reported nothing and the ticket was
    // decided by its question half. A report of rows going missing is the same fact
    // however it is phrased, so the noun set is widened to what reporters actually
    // name (records, rows, entries, files) and the verb set to the whole family.
    re: /\b(data ?loss|lost (all |my )?(data|files|work)|deleted (my|all)|corrupt(ed|ion)? (data|database|db)|dropped (the )?(table|database)|(data|records?|rows?|entries|files?|documents?|messages?)\s+(are |were |is |was |being |have been |has been )?(deleted|removed|missing|gone|lost|dropped)|deleted (from|out of) (our|my|the) (database|db|account|bucket|table|repo))\b/i,
    describes: 'reports data loss or corruption',
  },
  {
    id: 'security',
    class: 'urgent',
    reason: 'SECURITY_REPORTED',
    // Three real wordings were missing. `leaked (key|token|password)` wanted the
    // adjective first, so "our API token leaked in a public repo" matched nothing --
    // the same fact in the word order people actually use. A vulnerability report
    // rarely says "unauthorised access"; it says what the pentest *found*, or that
    // one tenant can read another's records. Those are added; bare `SSRF` and bare
    // `pentest` are not, because "how do I configure SSRF protection?" is a question
    // about security rather than a report of it, and this rule is for the report.
    re: /\b(security (issue|vulnerabilit|hole|flaw)|vulnerabilit|exploit|CVE-\d{4}-\d+|unauthori[sz]ed access|credential (leak|expos)|leaked (key|token|password)|RCE|SQL ?injection|XSS|(api |access |auth |signing |private )?(token|key|password|credential|secret)s? (was |were |is |are |has been |have been )?(leaked|exposed|compromised|committed|public)|read (other|another|any|all) (users?'?|customers?'?|tenants?'?) ?(files?|data|records?|documents?|inbox|accounts?)|access(?:ing|ed)? (other|another|all) (users?'?|customers?'?|tenants?'?)|(pentest|pen ?test|penetration test)s? (found|showed|revealed|reported|result))\b/i,
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

/**
 * Wording that reports something broken, beyond what the rules above know how to
 * name.
 *
 * This is a **guard, not a classifier**: it never places an item, it only stops a
 * `routine` rule from placing one. The distinction is the whole fix, so it is worth
 * stating plainly.
 *
 * The 0.1.1 fail-open was not that a severity rule was missing a phrasing — that is
 * unavoidable, a vocabulary is finite. It was that *nothing noticed the gap*: the
 * `outage` rule did not recognise "returns 500 for every request", so the item fell
 * through to the `install_question` rule, which matched the *other sentence* of the
 * same ticket and decided the whole thing `routine`. The run exited 0 as clean on a
 * production outage, and the README had promised in writing that this could not
 * happen.
 *
 * So the guard asks a question a finite vocabulary *can* answer: does this body
 * report a malfunction at all? If it does and the best a rule could do was
 * `routine`, the honest answer is "a human should look" — not "routine", and not
 * `urgent` either, because inventing a severity is the opposite failure. The item
 * becomes `needs_review` with `MALFUNCTION_REPORTED`, and the routine rule that
 * would have swallowed it is kept in `reasonCodes` so a reader sees both halves.
 *
 * Two boundaries are deliberate:
 *
 *  - It only applies when the winning rule is `routine`. An item no rule placed is
 *    already `undecided`, which the runner reports as `needs_review` *with the
 *    coverage gap attached* (`MODEL_NOT_CONFIGURED`, exit 6). Letting this guard
 *    claim those items would turn that gap into a prefilter verdict and quietly
 *    lower the exit code to 0 — a fix for one fail-open that opens another.
 *  - It does not try to be a taxonomy. `is unusable` is here because a body saying
 *    it is not a question, not because this list is complete.
 *
 * The alternatives are joined inside `\b…\b`, which is not decoration. Without the
 * boundaries `hangs?` matches "change" and `fail…` matches "failsafe", so "How do I
 * change the theme?" — a routine question with nothing broken in it — would be pulled
 * to `needs_review` by a word inside another word. The boundary is tested.
 */
export const MALFUNCTION_WORDING = new RegExp('\\b(' + [
  // the system is not doing what it should
  'errors?', 'exceptions?', 'stack ?traces?', 'crash(?:es|ed|ing)?', 'broken', 'unusable',
  'not (?:working|usable|responding|loading|saving)', "does ?n'?t work", 'stopped working',
  'freezes?', 'frozen', 'hangs?', 'fail(?:s|ed|ing|ure|ures)?', 'timeouts?', 'time(?:s|d)? out',
  // the service is not up
  'outage', '(?:is|are|was|were|been|goes|going|went)\\s+down', '5\\d\\d',
  // data that is gone, and access that should not have happened
  '(?:data|records?|rows?|entries|files?|documents?|messages?|accounts?|orders?|invoices?)'
    + '\\s+(?:are |were |is |was |being |have been |has been )?'
    + '(?:deleted|removed|missing|gone|lost|dropped)',
  'data ?loss', 'corrupt(?:ed|ion)?', 'leaked', 'exposed', 'compromised', 'unauthori[sz]ed',
  // answers that are wrong, and behaviour that is not stable
  'wrong (?:result|answer|output|value|number|numbers|data)',
  'regression', 'intermittent|flaky|sporadic',
].join('|') + ')\\b', 'i')

const SEVERITY_ORDER = Object.freeze({ routine: 0, needs_review: 1, urgent: 2 })

/** A class's rung on the ladder. Anything not on it ranks below `routine`. */
function rank(cls) {
  return SEVERITY_ORDER[cls] ?? -1
}

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
 * Refuse to let a `routine` verdict stand on a body that reports a malfunction.
 *
 * The last word before a verdict leaves this module, and the only thing it can do
 * is turn `routine` into `needs_review`. It cannot raise anything to `urgent` and
 * cannot touch a verdict a severity rule already made, so a ticket that is only a
 * question stays a question and no rule's vocabulary is second-guessed.
 */
function guardRoutine(verdict, text) {
  if (verdict.class !== 'routine') return verdict
  const match = text.match(MALFUNCTION_WORDING)
  if (!match) return verdict
  return {
    class: 'needs_review',
    reason: 'MALFUNCTION_REPORTED',
    ruleId: 'malfunction_guard',
    matched: match[0].length > 80 ? `${match[0].slice(0, 80)}…` : match[0],
    // Both facts, in the order they mattered: something is broken, *and* this rule
    // matched the other half of the ticket. The runner appends RULE_MALFUNCTION_GUARD.
    reasonCodes: ['MALFUNCTION_REPORTED', ...(verdict.reasonCodes ?? [verdict.reason])],
  }
}

/**
 * Classify one item deterministically.
 *
 * Returns `{class, reason, ruleId, matched}` where `class` is `'routine'`,
 * `'needs_review'`, `'urgent'` or `'undecided'`. `undecided` is a first-class
 * answer: it means no rule claimed the item, which is different from a rule
 * saying "routine".
 *
 * **The two signals are combined, not ranked.** This used to return the field
 * override immediately, which made a structured field able to *lower* a verdict:
 * `{severity: 'high'}` alongside "The service is down for all users" produced
 * `needs_review`, and the run then exited 0 as clean. A production outage was
 * silenced by a field that was only meant to add information.
 *
 * `raiseClass` is the guard for exactly that, and it was written, exported,
 * imported -- and never called. Both signals are now computed and the stronger
 * one wins, which keeps both halves of the promise true: a field can never bury
 * an outage, and a field still lifts an item the wording alone would leave as a
 * question.
 *
 * **And a routine verdict has to survive one more check.** A `routine` rule decides
 * on a phrase, and a ticket has more than one sentence; when the other sentence
 * reports a malfunction, the phrase is all the rule saw. Every return below that
 * can carry `routine` therefore goes through `guardRoutine` first. See
 * `MALFUNCTION_WORDING` for the case that made this necessary.
 */
export function prefilter(item, config) {
  const fields = item && typeof item.fields === 'object' && item.fields !== null
    ? item.fields
    : {}
  const rules = (config && config.rules) || PREFILTER_RULES

  let override = null
  for (const candidate of FIELD_OVERRIDES) {
    if (fieldMatches(fields[candidate.field], candidate.values)) {
      override = {
        class: candidate.class,
        reason: candidate.reason,
        ruleId: `field:${candidate.field}`,
        matched: String(fields[candidate.field]),
      }
      break
    }
  }

  const text = typeof item?.text === 'string' ? item.text : ''
  let fromText = null
  if (text.trim() === '') {
    fromText = { class: 'undecided', reason: 'EMPTY_TEXT', ruleId: null, matched: '' }
  } else {
    // Every rule runs. The strongest class wins; inside a class the earliest rule
    // wins, which is what the table's order is for. `rank` is the same ladder
    // `raiseClass` walks, with an unrecognised class ranked below `routine`: a
    // caller-supplied rule that names a class this release does not know must not
    // be able to outrank one that does.
    let best = null
    for (const rule of rules) {
      const match = text.match(rule.re)
      if (!match) continue
      if (best === null || rank(rule.class) > rank(best.rule.class)) {
        best = { rule, match }
      }
    }
    fromText = best === null
      ? { class: 'undecided', reason: 'NO_RULE_MATCHED', ruleId: null, matched: '' }
      : {
        class: best.rule.class,
        reason: best.rule.reason,
        ruleId: best.rule.id,
        matched: best.match[0].length > 80
          ? `${best.match[0].slice(0, 80)}…`
          : best.match[0],
      }
  }

  // A severity nobody recognises is a question, not an absence. Handled before
  // the combination below so it can never be overruled down to routine by an
  // innocuous body -- which is exactly what used to happen.
  const odd = unrecognisedSeverity(fields)
  if (odd && override === null) {
    const floor = { class: 'needs_review', reason: 'FIELD_SEVERITY_UNRECOGNISED' }
    if (fromText.class === 'undecided' || fromText.class === 'routine') {
      return {
        ...floor,
        ruleId: fromText.ruleId,
        matched: odd.value,
        reasonCodes: [floor.reason, fromText.reason],
      }
    }
    return guardRoutine(fromText, text)
  }

  if (override === null) return guardRoutine(fromText, text)
  if (fromText.class === 'undecided') return override

  const combined = raiseClass(override.class, fromText.class)
  if (combined === override.class && combined !== fromText.class) {
    // The field won, so the field's reason is the one that decided.
    return { ...override, reasonCodes: [override.reason] }
  }

  // The stronger signal was the wording, or the two agreed. Either way the text
  // rule is what the verdict rests on -- and when they *disagreed*, say so, so a
  // reader sees a field that was overruled rather than one confident answer.
  const codes = [fromText.reason]
  if (override.class !== fromText.class) {
    codes.push(`FIELD_${override.reason}_OVERRULED_BY_STRONGER_TEXT`)
  } else {
    codes.push(override.reason)
  }
  return guardRoutine({ ...fromText, reasonCodes: codes }, text)
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
