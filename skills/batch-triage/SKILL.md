# batch-triage

A tool for classifying a batch of tickets, and the one rule that matters most
about how it answers.

## Use it for volume, not for one ticket

`batch_triage` takes 1–64 items and returns a class for each. A rule table decides
the clear cases with no round trip per item, so a batch of fifty tickets where six
are interesting costs the same as a batch of fifty dull ones.

## What decides what

A **structured field outranks the body text.** If the item carries
`severity: critical`, `security: true` or `data_loss: true`, that sets the class
before any wording is read — a reporter who filled in a form has already told you.

Otherwise the first matching text rule wins, in this order:

| class | what the rules recognise |
|---|---|
| `urgent` | an outage, data loss, a security report, a crash with a stack trace, a blocked login or checkout |
| `needs_review` | a regression, a wrong result, a performance problem, intermittent behaviour |
| `routine` | an install or usage question, a docs problem, a feature request, a bare thank-you |

Urgent rules run first on purpose: a ticket that reports an outage *and* phrases
itself as a question must not be swallowed by the question rule.

## The rule that matters most

**An item no rule can place is `needs_review`, never `routine`.** That includes an
item with an empty body. "I could not tell" and "nothing to see here" are different
answers, and this tool never turns the first into the second.

When you read the output:

- `decidedBy: "prefilter"` — a rule placed it, and `reasonCodes` names which;
- `decidedBy: "unavailable"` — nothing could place it, and no model tier is
  configured in this session;
- `decidedBy: "budget"` — a cap was reached, so this item was not assessed.

The last two are both `needs_review` with `escalate: true`. Neither is a verdict
about the ticket; both are statements about what this run was able to do.

## Do not paraphrase before calling

The prefilter matches wording. Summarising a ticket changes its class. Pass the
body verbatim in `text` and put anything you inferred into `fields` instead —
`fields` is where a judgement belongs, and `text` is evidence.

## Reading the exit code

| code | meaning |
|---|---|
| 0 | ran, and nothing needs a human |
| 1 | ran and found something — **not a failure** |
| 6 | every item needing the model was skipped — also a successful run |
| 2 | the call was invalid (empty batch, more than 64 items, duplicate id) |
| 3 | configuration could not be honoured |
| 5 | a recorded expectation was not met |

`1` and `6` are normal outcomes for a working tool. A CI job that treats them as
failures will be red on every batch worth running.

If both are true at once, `6` wins, because "this run could not cover everything"
is a stronger statement than "some of it needs a human". Read the summary, not
only the code: the urgent ids are listed there either way.
