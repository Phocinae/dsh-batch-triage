# Changelog

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
