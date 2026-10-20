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

## Quick start

```sh
dsh plugin --profile web add dsh-batch-triage@0.1.3
```

batch_triage is now available; Rules place the tickets they can; anything they cannot place is returned as `needs_review` — never quietly filed as routine.


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

0.1.2 tightened what "a rule said so" is allowed to mean. A rule decides on a
*phrase*, and a ticket has more than one sentence: when the phrase that matched is a
question and another sentence reports something broken, the question rule does not get
to decide the ticket. It becomes `needs_review` with `MALFUNCTION_REPORTED`, and the
rule that would have swallowed it stays in `reasonCodes` so a reader sees both halves.

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
filled in a form has already told you, and no wording in the body can lower what the
field said. Wording that reports something *worse* still raises it — a field can never
bury an outage, and when the two disagree the item carries both reason codes.

Otherwise **the highest class any rule claims wins**, and the table is written
strongest first so that a tie inside a class goes to the rule listed first:

| class | rules |
|---|---|
| `urgent` | `outage`, `data_loss`, `security`, `crash_with_trace`, `blocked_workflow` |
| `needs_review` | `regression`, `wrong_result`, `performance`, `flaky` |
| `routine` | `install_question`, `usage_question`, `documentation`, `feature_request`, `thanks` |

A ticket that reports an outage *and* phrases itself as a question must not be
swallowed by the question rule. That is a test — and in 0.1.1 it was a test that could
not fail, because its fixture used wording the `outage` rule already recognised, so the
fixture and the rule shared an assumption and the precedence was never really exercised.
Precedence is by class rather than by position now, which also means a caller-supplied
`rules` array cannot reorder the table into a fail-open.

Class precedence alone was not enough, and the six measured tickets below are why.
`outage` did not know "returns 500 for every request", so *no* severity rule matched,
and the question rule decided the whole ticket from one sentence of it. So a `routine`
verdict gets one more check: if the body reports a malfunction — an error, a crash,
something "unusable", a 5xx, deleted records, a leaked credential — in wording no
severity rule could name, the item becomes `needs_review` with `MALFUNCTION_REPORTED`
instead of `routine`. That guard only ever *refuses* a `routine`; it cannot raise
anything to `urgent`, and it cannot touch a verdict a severity rule already made.

Precedence by class is chosen over "most specific wins" deliberately. A scoring system
would need weights nobody could defend; a class ladder needs none, and the table stays
inspectable — a rule that never fires is a bug you can see.

The wordings the fix was measured against, verbatim from the audit. All six were
`routine` with exit **0** on 0.1.1:

| ticket | 0.1.1 | 0.1.2 |
|---|---|---|
| `How do I install this? Also our production API returns 500 for every request.` | `routine` `INSTALL_QUESTION`, exit 0 | `urgent` `OUTAGE_REPORTED`, exit 1 |
| `Is there documentation for the auth flow? We are seeing records deleted from our database.` | `routine` `DOCUMENTATION_REQUEST`, exit 0 | `urgent` `DATA_LOSS_REPORTED`, exit 1 |
| `Feature request: please add CSV export. Meanwhile the app is unusable for our whole team.` | `routine` `FEATURE_REQUEST`, exit 0 | `urgent` `OUTAGE_REPORTED`, exit 1 |
| `How do I configure SSRF protection? Our pentest found we can read other users files.` | `routine` `INSTALL_QUESTION`, exit 0 | `urgent` `SECURITY_REPORTED`, exit 1 |
| `where can i find the logs? the service has been returning 503 all morning` | `routine` `INSTALL_QUESTION`, exit 0 | `urgent` `OUTAGE_REPORTED`, exit 1 |
| `What is the right way to rotate keys? Our API token leaked in a public repo.` | `routine` `USAGE_QUESTION`, exit 0 | `urgent` `SECURITY_REPORTED`, exit 1 |

A ticket that is *only* a question is unaffected: `How do I install this on Windows?` is
still `routine`, and a batch of nothing but routine items still exits 0. The guard is a
floor, not a bias toward urgency.

**What the guard costs, stated rather than discovered later.** It is conservative on
purpose, so a question that merely *mentions* a failure word is bumped as well:
`How do I handle errors returned by the parser?` comes out `needs_review` instead of
`routine`. The class changes; the exit code does not, because a `needs_review` the
prefilter decided is not a finding in this release. That is a real remaining gap — the
guard's own items still exit 0, which is why the six above had to land `urgent` on
their merits rather than merely `needs_review`. It is written up in the CHANGELOG
rather than left for a reader to find.

## Exit codes

| code | meaning |
|---|---|
| `0` | ran, and nothing needs a human |
| `1` | ran and found something — **not a failure** |
| `2` | the call was invalid (empty batch, over the cap, malformed item) |
| `3` | the input or policy could not be honoured (duplicate `id`) |
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

A batch of 1–64 items can only reach `0`, `1`, `2`, `3` and `6`. The other three are
rungs of the ladder that this batch runner has no producer for:

* **`4` empty scan** is pre-empted by `2`: an empty batch is refused as a usage error
  before any item could be scanned, so `emptyScan` never becomes true here. Rung 4
  exists for a caller driving `exitCode()` directly.
* **`5` expectation** has no producer at all — there is no `expect` API in this
  release. The rung is reserved and documented rather than invented.
* **`7` zero budget** is refused at load, because `modelStateCap: 0` is a
  configuration error (see below). `7` is reachable only through `exitCode()`
  itself, or through a config object that never passed `resolveConfig`.

Reading the ladder as "these are all the outcomes you will see" would be wrong in the
other direction; it is the complete priority order, not the complete list of
observable codes.

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
triage result would blame the tickets for a configuration mistake. The refusal is
reported as `TRIAGE_BAD_CONFIG` with exit `2`, not `3`: a cap of zero is a request
that contradicts itself, which the ladder classes as an invalid call rather than an
input that could not be read. Nothing reaches the model, so rung `7` is never
reached — see the note under the exit-code table.

## Limits and validation

1–64 items per call, where 64 is the default `maxItems` cap and not the only value it
can take: an operator who raises `maxItems` raises the batch cap with it, and the
prefilter is linear in the batch size. More than the cap is **rejected, not
truncated**, because a truncated batch reports a summary of the items that happened to
arrive first — which reads exactly like a summary of the whole batch. Duplicate ids are
refused rather than merged: ids key the answers, so a merge would drop a ticket and
leave no way to tell which. That refusal is exit `3`, not `2`: the batch itself is
well-formed, and it is the identity mapping that cannot be honoured.

## What `failOn` does

`failOn` decides which classes count as a finding (exit `1`):

| value | a finding is… |
|---|---|
| `any` (default) | an urgent item, any escalation, **or any `needs_review`** |
| `urgent` | an urgent item only |
| `none` | nothing — the caller asked for a report, not a gate |

A `needs_review` is a "a human should look" decision whether it came from a
prefilter rule (`regression`, `wrong_result`, `performance`, `flaky`, field
`severity: high|medium`) or from a residual (`no rule matched`, model unavailable,
budget exhausted). Before 0.1.3 only residual items counted, so a batch containing a
single regression ticket exited `0 clean` even though a rule had already said it
needs a human. That gap is closed: under `any`, a rule-decided `needs_review` is a
finding.

Exit codes still outrank findings. A residual item with no model client exits `6`
(`modelUnavailable`) before the finding rung, and a usage/config error outranks
both. So the shipped plugin has two visible cases:

| batch | effect of `failOn` |
|---|---|
| contains a residual item (no rule matched) | exits `6` regardless of `failOn` |
| every item was decided, at least one as `needs_review` | `any` → `1`; `urgent` / `none` → `0` |

`modelClient` is a library-level option and is deliberately not part of the YAML
config block below: it is a seam for tests and for a host that supplies a client
programmatically. It is still never called in this release — `modelClass` stays
`unavailable`.

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

## Options that do nothing in this release

Four accepted keys have no effect without the model tier. They are listed together
because the alternative — accepting them silently — is the thing this project
criticises elsewhere in its own documentation.

| key | status |
|---|---|
| `policyId` | accepted, no policy file is loaded |
| `tokenCap` | accepted, nothing reports `input_tokens` to enforce it against |
| `timeoutMs` | accepted, nothing spawns a subprocess to time out |
| `batchSize` | accepted, nothing is sent anywhere to be batched |

They are still range-validated, so `timeoutMs: 0` is refused at load. That is
deliberate rather than tidy: the validation is the part that will still be correct
when the tier lands, and removing it now would mean re-adding it later under
pressure.

`failOn` is a special case worth its own sentence: it is operative on the shipped
path. A batch whose items were all decided, with at least one `needs_review`, exits
`1` under `any` and `0` under `urgent` / `none`. Only a residual item (one no rule
could place, with no model client) outranks the finding rung at `6`.

## What the rules do with a severity they do not recognise

An unrecognised `severity` — `P4`, `banana`, `kritisch` — is **not** treated as an
absent one. Dropping it is how a real priority silently becomes `routine`, and
raising it to urgent would invent a signal. So it becomes `needs_review` with
`FIELD_SEVERITY_UNRECOGNISED`: the field said something about priority and this
release does not know what, which is a question rather than a guess in either
direction.

The recognised vocabulary is wide on purpose (`critical`, `blocker`, `sev1`, `s1`,
`P0`, `urgent`, `emergency`, `showstopper`, `severity 1`, `1`, `highest` for the top
tier), because 0.1.0 accepted four labels and `severity: 'P0'` then behaved exactly
like no severity at all.

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
npm test                  # 45 test cases, no host required
npm run verify:artifacts   # what npm publish would actually ship
```

Both run on the publish path: `prepack` is `npm test && npm run verify:artifacts`, so a
rule that stopped firing cannot be published. It could before 0.1.2 — `verify:artifacts`
carries a positive sample for every rule and would have gone red, but nothing ran it on
the way out.

`node --test` reports *test cases*, not assertions: this suite is 45 cases containing
roughly 170 `assert` calls, many of them inside loops. The distinction matters when a
case loops — one case failing on the third of five iterations is one failure, and the
case count alone will not tell you which.

The verifier checks behaviour, not only structure: it runs the real prefilter and
asserts that **every rule in the table can still fire**. A rule that cannot match
is indistinguishable from a rule that found nothing, and that exact failure shipped
twice in this project's family before this check existed.

Two skill artefacts ship, and they are not the same text:

* `lib/skill.mjs` generates a body from the live rule table, and that is what
  `createPlugin` registers with the host.
* `skills/batch-triage/SKILL.md` is a hand-written file that travels with the
  package. Nothing compares the two, and the verifier only asserts that the file
  exists and is covered by `files[]`. Change the rule table and this one is on you
  to update.

## License

Apache-2.0.