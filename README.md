# dsh-batch-triage

**Rules decide the easy tickets. Anything the rules cannot place is handed to a
human — never quietly filed as routine.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
No model, no service, no network, no API key.

```
$ node -e "
  import('dsh-batch-triage').then(m => {
    const r = m.triageBatch([
      { id: 'a', text: 'The service is down for all users' },
      { id: 'b', text: 'How do I install this on Windows?' },
      { id: 'c', text: 'The frobnitz is blorp.' },
    ], m.resolveConfig({}));
    console.log(r.items.map(i => i.id + ' ' + i.class + '  ' + i.reasonCodes[0]).join('\n'));
    console.log('exit', r.exitCode, r.exitBasis);
  })"

a urgent        OUTAGE_REPORTED
b routine       INSTALL_QUESTION
c needs_review  NO_RULE_MATCHED
exit 6 modelUnavailable
```

## Why rules first

A ticket batch is the wrong shape for one model call per item: the volume is high,
the interesting items are few, and every item costs a round trip whether or not it
needed one. So the order is inverted from the obvious one.

**The prefilter runs on every item, first.** Rules place the clear cases — a crash
with a stack trace is urgent, "how do I install this" is routine — and they place
them without asking anything. Only the residue would ever reach a model, and this
release does not reach one at all: it says so instead.

That ordering is not an optimisation. It is the design's main path, and it changes
what the tool is for: **the prefilter is the product, and the model is a fallback.**

## The rule that matters most

> **An item is never `routine` unless a rule said so.**

Every path that cannot classify — an empty body, no matching rule, no model
configured, a budget exhausted — produces `needs_review`. Turning "I could not
tell" into "nothing to see here" is the one failure this tool exists to prevent,
and the test suite pins it in both directions.

`decidedBy` says which tier actually decided:

| value | meaning |
|---|---|
| `prefilter` | a rule placed it; `reasonCodes` names which |
| `unavailable` | nothing could place it and no model tier is configured |
| `budget` | a cap was reached, so it was not assessed |

The last two both carry `escalate: true`. Neither is a verdict about the ticket.

## What the rules look at

A **structured field outranks the body text**: `severity: critical`,
`security: true`, `data_loss: true`, `reporter_tier: enterprise`. A reporter who
filled in a form has already told you, and no wording in the body should be able
to overrule that.

Otherwise the first matching text rule wins, in a documented order:

| class | rules |
|---|---|
| `urgent` | `outage`, `data_loss`, `security`, `crash_with_trace`, `blocked_workflow` |
| `needs_review` | `regression`, `wrong_result`, `performance`, `flaky` |
| `routine` | `install_question`, `usage_question`, `documentation`, `feature_request`, `thanks` |

Urgent rules run first on purpose: a ticket that reports an outage *and* phrases
itself as a question must not be swallowed by the question rule. That is a test.

First-match-wins is chosen over "most specific wins" deliberately. A scoring system
would need weights nobody could defend; a documented order is inspectable, and a
rule that never fires is a bug you can see.

## Exit codes

| code | meaning |
|---|---|
| `0` | ran, and nothing needs a human |
| `1` | ran and found something — **not a failure** |
| `2` | the call was invalid (empty batch, over the cap, duplicate id) |
| `3` | configuration could not be honoured |
| `4` | empty scan |
| `5` | a recorded expectation was not met |
| `6` | every item needing the model was skipped |
| `7` | a cap was zero before any item could reach the model |

The priority between them is one documented ladder in `lib/exit.mjs`, because a run
can satisfy several at once and the order decides which one you are told about:

```
2 usage → 3 config → 4 empty scan → 7 zero budget →
6 model unavailable → 5 expectation → 1 findings → 0 clean
```

Two of those orderings are judgements worth stating:

* **A usage error outranks everything.** A run that was never valid cannot have
  found anything, so reporting a finding would be a lie about what happened.
* **A coverage gap outranks a finding.** `6` means "this run could not cover
  everything it needed to", which is a stronger statement than `1`'s "some of it
  needs a human" — and it is a superset, since a caller who reacts to `6` will look
  and will find the urgent item listed in the summary.

The hazard in that second one is a caller reading only the exit code and
concluding the batch was fine. So the summary always lists `urgentIds` and
`escalatedIds`, and a test asserts an urgent item survives there alongside a
coverage gap.

**For CI:** `{0, 1, 6}` are all successful runs, exported as `CI_ACCEPTED`. A job
that treats `1` as a failure will be red on every batch worth running.

## A cap is a decision, not a silent drop

An item the budget could not afford is `needs_review` with `BUDGET_EXHAUSTED`, and
the summary counts `budgetRefusals`. A truncated run must not read as a complete
one.

`modelStateCap: 0` is **refused at load time** rather than accepted. It forbids in
the same call what the caller asked for, and turning that contradiction into a
triage result would blame the tickets for a configuration mistake.

## Limits and validation

1–64 items per call. More than that is **rejected, not truncated**, because a
truncated batch reports a summary of the items that happened to arrive first —
which reads exactly like a summary of the whole batch. Duplicate ids are refused
rather than merged: ids key the answers, so a merge would drop a ticket and leave
no way to tell which.

## What `tau` can and cannot do here

`tau` is the escalation threshold on confidence, and this release has no confidence
to compare against. So it does the one thing the design permits: it can make a
`needs_review` item escalate, and it **never downgrades anything**. An option that
was accepted and had no effect would be worse than one that is rejected, because
the caller would believe something had been checked.

## Configuration

```yaml
- insert:
    - id: batch_triage
      name: dsh-batch-triage
      config:
        maxItems: 64
        tau: null
        modelStateCap: null
        tokenCap: null
        failOn: any        # any | urgent | none
        timeoutMs: 20000
        batchSize: 16
```

## What is not in this release

**The model tier.** The design specifies a local 150M Phocinae model as the fallback
for the residue, with a fail-closed rule when the service is unreachable. It is not
here. The output already carries the fields it would fill (`modelClass`,
`confidence`, `top2Margin`, `score`), and `modelClass` is reported as
`unavailable` because that is the truth.

Left out for the reason the family applies everywhere: the deterministic tier is
where the measured value is, and a tier that adds a model call needs the same
evidential standard as everything else — a measurement, not an assumption. Shipping
the field honestly as `unavailable` is better than shipping an unmeasured tier.

Also not here: `policyId` (a named prefilter policy loaded from a file) and
`tokenCap` enforcement past the point where a model would report `input_tokens`.
Both are inert without the model tier.

## Requirements

Node `^22.19.0 || >=24.0.0`. No runtime dependencies. `@deepseek-ai/cordis` is an
optional peer.

## Testing

```sh
npm test                  # 37 assertions, no host required
npm run verify:artifacts   # what npm publish would actually ship
```

The verifier checks behaviour, not only structure: it runs the real prefilter and
asserts that **every rule in the table can still fire**. A rule that cannot match
is indistinguishable from a rule that found nothing, and that exact failure shipped
twice in this project's family before this check existed.

## License

Apache-2.0.
