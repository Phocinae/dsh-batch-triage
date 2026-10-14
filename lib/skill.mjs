/**
 * The bundled skill.
 *
 * Generated from the live configuration rather than hand-written: a hand-written
 * skill drifts from the config it describes and then teaches the wrong thing.
 */
import { PREFILTER_RULES } from './prefilter.mjs'

export const SKILL_NAME = 'batch-triage'

export function createSkill(config) {
  const ruleLines = PREFILTER_RULES
    .map((rule) => `| \`${rule.id}\` | ${rule.class} | ${rule.describes} |`)
    .join('\n')

  const body = `# batch-triage — rules first, and an honest "I could not tell"

This session has a \`batch_triage\` tool. It classifies tickets into \`routine\`,
\`needs_review\` or \`urgent\`, using a deterministic rule table.

## Use it for volume, not for one ticket

The prefilter is the point. A batch of fifty tickets where six are interesting
costs nothing to triage, because rules decide the forty-four clear ones and no
per-item round trip is made.

## The table

| rule | class | what it notices |
|---|---|---|
${ruleLines}

A structured field outranks the body: \`severity: critical\`, \`security: true\` and
\`data_loss: true\` force a class before any text rule runs.

## The rule that matters most

**An item no rule can place is \`needs_review\`, never \`routine\`.** That includes an
item with an empty body. "I could not tell" and "nothing to see here" are
different answers, and this tool never turns the first into the second.

A \`routine\` verdict has one further condition on it, because a rule matches a *phrase*
and a ticket has more than one sentence. If the matched phrase is a question and another
sentence reports something broken — an error, a crash, something unusable, a 5xx,
deleted records, a leaked credential — the item is \`needs_review\` with
\`MALFUNCTION_REPORTED\`, not \`routine\`, and the question rule that nearly swallowed it
is still named in \`reasonCodes\`. A ticket phrased as a question can therefore still
come back as something to act on, and that is deliberate rather than a mis-read.

So when you read the output:

* \`decidedBy: "prefilter"\` — a rule placed it, and \`reasonCodes\` names the rule;
* \`decidedBy: "unavailable"\` — nothing could place it and no model tier is
  configured in this session;
* \`decidedBy: "budget"\` — a cap was reached, so this item was not assessed.

The last two are both \`needs_review\`, and both \`escalate: true\`. Neither is a
verdict about the ticket; they are statements about what this run could do.

## Do not paraphrase before calling

The prefilter matches wording. Summarising a ticket changes its class. Pass the
body verbatim in \`text\` and put anything you inferred into \`fields\` instead —
\`fields\` is where a judgement belongs, and \`text\` is evidence.

## Reading the result

The tool returns \`exitCode\` and \`exitBasis\` alongside the items. \`1\` means the
run succeeded and found something for a human — it is not a failure. \`6\` means
every item that needed the model was skipped, which is also a successful run.

If you pass \`tau\`, note what it can and cannot do here: with no confidence to
compare against, it can only make a \`needs_review\` item escalate. It never
downgrades anything.
`

  return {
    name: SKILL_NAME,
    description:
      'How the batch_triage tool works: a deterministic prefilter classifies every '
      + 'ticket, and anything no rule can place is needs_review rather than guessed at.',
    body,
    ruleIds: PREFILTER_RULES.map((rule) => rule.id),
    maxItems: config.maxItems,
  }
}
