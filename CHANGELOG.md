# Changelog

## 0.1.4 — 2026-10-20

Documentation only. Adds a **Migrating from 0.1.2** section for the `failOn: any`
change in 0.1.3: which batches now exit `1`, and how to choose `urgent` / `none`
if that is not the policy you want. No behavior change.

## 0.1.3 — 2026-10-20

### Changed — a prefilter `needs_review` is now a finding under `failOn: any`

`failOn: any` counted only urgent items and *escalations* (residual items with no
rule / no model / no budget). A `needs_review` decided by a rule — `regression`,
`wrong_result`, `performance`, `flaky`, or `severity: high|medium` — has
`escalate: false`, so a batch containing a single regression ticket exited
`0 clean`. Reproduced with:

```js
triageBatch([{ id: 'r1', text: 'Regression: this worked in 0.1.1 and now returns the wrong total.' }],
  resolveConfig({}))
// before: class needs_review, exitCode 0, exitBasis 'clean'
// after : class needs_review, exitCode 1, exitBasis 'findings'
```

`any` now means exactly what its name says: urgent, any escalation, or any
`needs_review`. `failOn: urgent` still narrows to urgent only; `failOn: none`
still reports without gating. This is a deliberate semantics change for callers
who used `any` as "urgent or residual only" — the alternative was a gate that
looked green on a ticket a rule had already flagged for a human.

Exit-code precedence is unchanged: a residual item with no model client still
exits `6` before the finding rung, and usage/config errors still outrank both.

Tests: the existing prefilter-to-`needs_review` end-to-end test now asserts
`exitCode 1` / `exitBasis findings`, and `failOn narrows…` gains the
lone-regression case plus `urgent`/`none` negative controls.

### Added — CI and an OIDC publishing path

The package had no `.github/workflows`, so its 45 tests and 71 artefact
conditions ran only on the machine that wrote them, and publishing required the
long-lived npm token. `ci.yml` now runs both on Linux, Windows and macOS (Node 22
and 24); `release.yml` publishes with npm trusted publishing (`id-token: write`,
npm >= 11.5.1). The publish job fails cleanly until a trusted publisher is
configured on npmjs.com — there is deliberately no token to fall back to.

## 0.1.2 — 2026-10-15

One defect, in the same direction 0.1.1 was released to close: a production outage read
as `routine` and the run exited **0 as clean**. 0.1.1 fixed the half where a *field*
could bury an outage. This fixes the half that was still open, where a *rule* decided a
whole ticket from one of its sentences.

### Blocker — "and that is a test" was a test that could not fail

`README.md` promised, in writing:

> a ticket that reports an outage *and* phrases itself as a question must not be
> swallowed by the question rule. **That is a test.**

There was a test. Both halves of its fixture came from the rule table's own vocabulary:
the body was `'How do I stop the outage? The service is down for all users.'`, and the
`outage` rule recognises "the service is down". The fixture and the rule it was testing
shared an assumption, so the assertion passed for a reason unrelated to the promise — it
never exercised precedence against an outage the rules did not already know.

That is the general shape worth remembering: **a test whose fixture is drawn from the
implementation's own vocabulary cannot see a vocabulary gap.** The fixture has to come
from the world the tool is pointed at.

Written the way a ticket is actually written, the promise is gone. Six tickets, verbatim
from the audit that measured this, all six on 0.1.1:

```
How do I install this? Also our production API returns 500 for every request.
  -> routine / INSTALL_QUESTION        exit 0 clean

Is there documentation for the auth flow? We are seeing records deleted from our database.
  -> routine / DOCUMENTATION_REQUEST   exit 0 clean

Feature request: please add CSV export. Meanwhile the app is unusable for our whole team.
  -> routine / FEATURE_REQUEST         exit 0 clean

How do I configure SSRF protection? Our pentest found we can read other users files.
  -> routine / INSTALL_QUESTION        exit 0 clean

where can i find the logs? the service has been returning 503 all morning
  -> routine / INSTALL_QUESTION        exit 0 clean

What is the right way to rotate keys? Our API token leaked in a public repo.
  -> routine / USAGE_QUESTION          exit 0 clean
```

The mechanism: `outage` recognised `down`/`unavailable`/`unreachable`/`offline` and
nothing else, so "returns 500 for every request" matched no severity rule at all and
nothing raised. The `install_question` rule then matched the *other sentence*, and a rule
anchored to a phrase decided the entire ticket. No rule was wrong about the phrase it
matched — the defect is that a phrase was treated as a verdict about a ticket, and the
run reported the one pair that reads as "nothing needs a human".

### The fix, in two halves — plus a third that was not the fix

**1. The vocabularies now contain the symptom as well as the state.** `outage` knew the
service *is* something; it did not know the service *returns* something. It now accepts
`returns/returning/throwing/serving/giving … 5xx` and `5xx errors/responses/status` —
the symptom form — alongside `is unusable`, `is not working`, `is dead` and three more
nouns a reporter actually names (`dashboard`, `backend`, `endpoint`). `data_loss` accepts
what reporters write instead of `deleted my`: `(records|rows|entries|files|documents) …
deleted|removed|missing|gone|lost|dropped`, and `deleted from our database`. `security`
accepts the word orders that were missing — `token leaked` as well as `leaked token`,
`read other users files`, `access other tenants`, `pentest found …`.

Two boundaries are deliberate, because "widen the regex" is how a rule becomes a
liability. **`5xx` only**: a `4xx` is as often the caller's own request being rejected,
and accepting every status code would make "why does this return 401?" an outage. **Bare
`SSRF` and bare `pentest` are not added**: "how do I configure SSRF protection?" is a
question *about* security, not a report of it, and it stays `routine`.

**2. A `routine` verdict is now refused when the body reports a malfunction.** This is
the half that is not a vocabulary, because a vocabulary is always finite and the next
wording nobody thought of is exactly the case that shipped. A rule matching a phrase is
the problem; so a `routine` result gets one more check against `MALFUNCTION_WORDING` — an
error, an exception, a crash, "unusable", "not working", a 5xx, an outage, records gone,
a leaked credential, unauthorised access, a wrong answer, a regression. When it hits, the
item becomes `needs_review` with `MALFUNCTION_REPORTED` and the routine rule's own reason
code is kept beside it, so a reader sees "this is broken **and** the question rule matched
the other half".

The guard is asymmetric on purpose, in three ways worth stating:

* it can only **refuse** a `routine`. It cannot raise anything to `urgent` — inventing a
  severity is the opposite failure — and it never touches a verdict a severity rule
  already made;
* it applies **only when the winning rule is `routine`**. An item no rule placed is
  already `undecided`, which the runner reports as `needs_review` **with the coverage gap
  attached** (`MODEL_NOT_CONFIGURED`, exit 6). Letting the guard claim those items would
  convert that gap into a prefilter verdict and quietly lower the exit code to 0 — fixing
  one fail-open by opening another;
* it is a guard, not a classifier: it never places an item, it only stops a rule placing
  one.

**3. Precedence is by class, not by position — and this alone changed nothing.** The rule
loop used to break on the first match. It now evaluates every rule, the highest class
wins, and ties go to the earlier rule. For the shipped table that is the *same answer*,
because the table is written strongest class first; this is verified, not assumed (the
whole suite passes unchanged with that edit applied on its own). It is here because
first-match made precedence a property of whoever typed the table: `config.rules` accepts
a caller's table in any order, and a routine rule listed first would have put the
fail-open straight back. Precedence by class is a property of the rules.

### What the guard costs, and the gap this release names rather than closes

**The cost.** The guard is deliberately conservative, so a question that merely *mentions*
a failure word is bumped too: `How do I handle errors returned by the parser?`,
`Is it possible to configure a custom 500 page?` and `What is the right way to catch an
exception in a plugin?` all become `needs_review` rather than `routine`. A ticket that is
only a question is unaffected — `How do I install this on Windows?` is still `routine`,
and a batch of nothing but routine items still exits 0 — but the guard is a floor, not a
bias toward urgency, and this is what a floor costs.

**The gap.** A `needs_review` the *prefilter* decided is not a finding in this release, so
the guard's own items still exit 0. The class stops lying; the exit code does not change,
which is why the six tickets above had to land `urgent` on their own merits rather than
merely `needs_review`. Closing that is a change to what `failOn: any` means for
`regression`, `wrong_result`, `performance` and `flaky` as well, so it belongs in its own
release with its own measurement rather than riding along inside a bug fix.

### Tests

41 → 45 cases, and the new ones were verified by mutation rather than by passing:

* **the six tickets above, verbatim**, asserting class `urgent`, the reason code, and
  `exitCode === 1` — with `notEqual(routine)` and `notEqual(EXIT.CLEAN)` alongside, so the
  pair that burned the caller is named in the assertion;
* **a reverse verification** for the promise, built to distinguish the two
  implementations instead of agreeing with whichever is shipped: it computes the
  first-match verdict from the live table, asserts that a first-match prefilter says
  `routine` for the fixture, and then asserts the shipped prefilter does not. If the
  prefilter is put back to first-match, both sides collapse to `routine` and it fails;
* **the four rules that had no reason-code assertion** — `wrong_result`, `performance`,
  `flaky`, `usage_question`. Measured: replacing all four `re:` with `/(?!)/` left the
  0.1.1 suite at **41 pass / 0 fail**, because `INCORRECT_RESULT`, `PERFORMANCE_REPORTED`,
  `INTERMITTENT_REPORTED` and `USAGE_QUESTION` appeared nowhere in it. A class-level
  assertion cannot see this: the item still lands `needs_review` or `routine` by way of
  another rule, and only the reason code shows the rule is gone.

The mutation matrix, run against copies of the package (never the working tree):

| mutation | result |
|---|---|
| pre-fix implementation, new tests | 42 pass / **3 fail** — the six-ticket, guard and rule-order tests |
| pre-fix implementation, pre-fix tests, four rules neutered | 41 pass / 0 fail — the audit's measurement, reproduced |
| new implementation, four rules neutered | 44 pass / **1 fail** — the reason-code test, alone |
| vocabulary widening reverted, guard kept | 44 pass / **1 fail** — the six-ticket test |
| guard removed, vocabulary kept | 43 pass / **2 fail** — the two guard tests |
| guard kept but its word boundaries removed | 44 pass / **1 fail** — the guard test's precision assertions |

That last row is a defect this release introduced and caught in review: the guard's
alternatives were joined without `\b`, so `hangs?` matched "change" and `fail…` matched
"failsafe" — a routine question pulled to `needs_review` by a fragment of another word.
The boundaries are there now, and `How do I configure a change-detection hook?` pins them.

The 0.1.1 test itself is kept, renamed to what it actually checks ("urgent wording is not
swallowed by a question in the same ticket"), with a comment saying why it was not
evidence and pointing at the test that is.

### The verifier is now on the publish path

`prepack` was `npm test`. `scripts/verify-artifacts.mjs` carries a positive sample for
every rule and asserts each one still fires — but nothing ran it on the way out, which is
how the four rules above could be dead in a package that passed its own suite. `prepack`
is now `npm test && npm run verify:artifacts`, and the verifier gained the same promise as
a behavioural check: a question-shaped ticket with an unrecognised malfunction in the
other sentence must not come back `routine`. Checked against a mutant with the guard
removed, it fails with `routine / INSTALL_QUESTION` — the fail-open itself.

## 0.1.1 — 2026-10-14

Two defects from an independent verification pass over 0.1.0, one of them a
fail-open in the direction this project exists to prevent.

### Blocker — a structured field could bury an outage

The field override returned immediately, so a structured field could only ever
**lower** a verdict. `{severity: 'high'}` beside "The service is down for all users"
produced `needs_review`, and the run then exited **0 as clean**:

```
{severity:'high'} + 'The service is down for all users'
  -> needs_review   exit 0   urgentIds []

same body, no field
  -> urgent         exit 1   urgentIds ['a']
```

A production outage silenced by a field that was only meant to add information, and
a caller using the documented `failOn: 'urgent'` gate got a green run for it.

`raiseClass` was written for exactly this case — "Raise a class, never lower it" —
and was exported, imported by `triage.mjs`, and **never called**. Both signals are
now computed and the stronger wins, which keeps both promises true at once: a field
can never bury an outage, and a field still lifts an innocuous question to urgent.
When the two disagree the item carries both reason codes, so a reader sees a field
that was overruled rather than one confident answer.

### Major — `severity: 'P0'` behaved exactly like no severity at all

The vocabulary accepted four labels per tier (`critical`/`blocker`/`sev1`/`s1`),
so standard reporter vocabulary for the most severe class was indistinguishable
from an absent field. An innocuous body then came out `routine`:

```
{severity:'P0'} + 'How do I install this?'  ->  routine  INSTALL_QUESTION
{severity:'s1'} + same body                 ->  urgent   FIELD_SEVERITY_CRITICAL
```

The vocabulary is widened (`P0`, `urgent`, `emergency`, `showstopper`, `highest`,
`sev-1`, `severity 1`, …), and — the more important half — a value that is **set
but unrecognised** now becomes `needs_review` with `FIELD_SEVERITY_UNRECOGNISED`
rather than being dropped. Dropping it is how a real priority silently becomes
`routine`; raising it to urgent would invent a signal. "The field said something
about priority and this release does not know what" is a question, and this
prefilter's answer to a question is always a human.

### Documented rather than silently accepted

`policyId`, `tokenCap`, `timeoutMs` and `batchSize` are accepted and do nothing
without the model tier, and `failOn` is operative only once a `modelClient` is
configured. On the shipped path any batch containing a residue item exits 6, and no
`failOn` value changes that.

They are still range-validated, which is deliberate rather than tidy: the validation
is the part that will still be correct when the tier lands.

This is the defect shape the README already criticises — *"an option that was
accepted and had no effect would be worse than one that is rejected"* — committed by
the same release that says it. Naming all four is the minimum; the choice between
rejecting them and making them work belongs with the model tier.

### Tests

37 → 41 assertions. The two new groups pin the blocker in both directions (a field
cannot lower an urgent body; a field can still raise a routine one) and pin that an
unrecognised severity is a question rather than an absence.

## 0.1.0 — 2026-10-14

First release. Deterministic-first triage for batches of tickets.

### What it does

A rule prefilter classifies every item in a batch. Items no rule can place become
`needs_review` with the reason stated, and the run reports the coverage gap. No
model, no network, no runtime dependencies.

### The shape, and why it is that shape

The obvious design is one model call per ticket. This inverts it: rules decide the
clear cases for free, and only the residue would ever reach a model. That makes the
prefilter the product rather than a fast path — a batch of fifty tickets where six
are interesting costs the same as fifty dull ones.

Two invariants hold everywhere:

* **An item is never `routine` unless a rule said so.** An empty body, an unmatched
  body, an absent model, an exhausted budget — all four produce `needs_review`.
  Turning "I could not tell" into "nothing to see here" is the failure this tool
  exists to prevent.
* **A cap is a decision, not a silent drop.** An item the budget could not afford
  carries `BUDGET_EXHAUSTED` and is counted in `budgetRefusals`, because a
  truncated run must not read as a complete one.

### Two defects found by the test suite

Both were the same failure mode this project's verifier now checks for by name: **a
rule that cannot match is indistinguishable from a rule that found nothing.**

**`crash_with_trace` never fired, twice over.** The phrase
`traceback (most recent call last)` had unescaped parentheses, so they were a
capture group and the pattern matched `traceback most recent call last` — a string
nobody writes. Escaping them was not enough: the trailing `\b` still killed it,
because `\b` asserts a boundary between a word character and a non-word one, and
`)` is itself non-word, so `) ` has no boundary. Now guarded by letter lookarounds
(`(?<![a-z])` / `(?![a-z])`), which express "not in the middle of a word" and hold
whatever punctuation the phrase ends with.

**`outage` missed "The service is down".** The alternation required the noun with
no article, so a leading `The` defeated it. Widened, and the noun set with it.

Neither showed up as an error. Both showed up as a ticket quietly classified as
"nothing matched", which is the whole reason the suite asserts a **positive** case
for every rule rather than only negative ones.

### An expectation of mine that was wrong

The mixed-batch test originally expected exit `1`. The design's ladder puts
model-unavailable (`6`) above findings (`1`), and the design is right: `6` says
"this run could not cover everything", which is a stronger claim than `1`'s "some
of it needs a human", and it is a superset — a caller who reacts to `6` will look
and find the urgent item in the summary.

The hazard is a caller reading only the exit code. So the summary always lists
`urgentIds` and `escalatedIds`, and a test asserts an urgent item survives there
next to a coverage gap. A second test pins that with a model client configured the
same batch is `1`, not `6` — the gap is real, not permanent.

### Not in this release

The model tier. The output already carries the fields it would fill, and
`modelClass` reports `unavailable` because that is the truth. `policyId` and
`tokenCap` enforcement are likewise inert without it.

The reason is the family's usual one: the deterministic tier is where the measured
value is, and a tier that adds a model call needs a measurement rather than an
assumption. Reporting the field honestly as `unavailable` is better than shipping
an unmeasured tier.
