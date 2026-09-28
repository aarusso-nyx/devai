---
id: ADR-GOV-0023
title: Delegate model evaluation of task pull requests and keep ratification, merge, and dispatch human
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 18 (soft gate)
  - law/constitution.md Article 23 (tie-breaking ladder)
  - law/constitution.md Article 3 (operating mode)
  - law/constitution.md Article 7 (human roles)
  - ADR-GOV-0002
  - ADR-GOV-0012
  - law/policy/campaign-execution.json
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - law/schemas/campaign.schema.json
  - law/policy/campaign-execution.json
  - scripts/check-campaign.mjs
inspector_acceptance:
  - IA-001 -- A campaign declaring `review.mode` as `model-advisory` validates, and a campaign that omits the field resolves to `human` while any other value is rejected by the schema.
  - IA-002 -- A task in `pre_merge` under `model-advisory` with no recorded verdict and digest cannot transition to `merged`, and the campaign check names the task.
  - IA-003 -- A recorded verdict whose digest does not match the reply bytes, or that fails the verdict schema, blocks ratification exactly as a missing verdict does.
  - IA-004 -- A model verdict of pass never ratifies, merges, or dispatches anything by itself; the ledger shows a human actor on the gate, the merge, and every remote effect.
  - IA-005 -- The constitution is byte-identical before and after the record lands, and a verdict produced outside a human-initiated orchestrator session is refused.
---

# Review boundaries

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Adds a review mode to the campaign
plan schema and its policy; it changes which of four review steps a campaign
may delegate to a model and leaves the constitution untouched.

## Context

Article 18 permits a model to evaluate a gate when a human initiates the
evaluation in the supported harness, and requires the evaluator to be
distinct from the working agent. Article 23 orders model escalation before
human escalation and states that each model invocation is human-initiated.
The campaign execution policy requires a human to evaluate and record every
gate: "no gate is inferred from a green check alone". The brainstorm's
request 7 asked that a campaign be able to delegate review to a model, and
the maintainer answered on 2026-09-28 that the request changes model
evaluation only. Today the campaign plan has no field that says whether a
model took part in a review, so a verdict a review subagent produced inside
the orchestrator session leaves no trace on the task, and a human ratifying a
gate cannot tell whether an advisory evaluation happened, or what it said.

## Decision

The review of a task pull request is separated into four steps, and the
record says which a campaign may delegate. Model evaluation of the pull
request is delegable: it runs inside the human-initiated orchestrator
session, is produced by a model instance distinct from the task's working
agent as Article 18 requires, and yields an advisory verdict in the shape
ADR-MDL-0001 defines. Gate ratification is human. Merge is human. Dispatch of
any remote effect is human, exact, and single-use, as ADR-GOV-0012 and the
authorization ledger already require. Nothing in this record moves a human
step to a model.

`law/schemas/campaign.schema.json` gains `review.mode` with the values
`human`, the default when the field is absent, and `model-advisory`. In
`model-advisory` the orchestrator records on the task, before the human
ratifies the gate, the model verdict and the SHA-256 digest of the reply it
was extracted from; the campaign policy states the recording rule and the
checker enforces it. A task in `pre_merge` whose verdict is missing, fails the
verdict schema, or carries a digest that does not match the recorded reply
cannot transition to `merged`. In `human` mode the field is absent from the
task and the checker requires nothing.

A model verdict is advice to the ratifying human and to no one else. It never
satisfies a gate, triggers a merge, or authorizes an effect. The tri-state
verdict vocabulary of Article 18 and the escalation ladder of Article 23 are
unchanged; a `review` verdict is still routed through the ladder by the human
who ratifies. The constitution text is not edited by this record.

## Consequences

A campaign can state, in its plan, that its task reviews are model-assisted,
and an auditor can later see for each merged task which verdict the human
ratified against. The verdict recording depends on the shared extractor and
schema of ADR-MDL-0001, so that record lands in the same round or earlier.
The campaign checker gains one more transition rule, and closed campaigns are
unaffected because they omit the field and resolve to `human`. Delegating
evaluation does not shorten the human path: ratification, merge, and dispatch
remain three separate human acts per task.

## Alternatives Considered

Delegating gate ratification to a model on a `pass` verdict is rejected by
the maintainer's decision and by the campaign policy's rule that a human
evaluates and records every gate. Letting the model merge is rejected because
merge is the integration effect of Article 28 and belongs to a human role
under ADR-GOV-0002. Recording the verdict outside the campaign ledger, for
example only in the pull request conversation, is rejected because the ledger
is the plan and record of the campaign and the digest must be checkable.
Treating request 7 as a non-decision is rejected because the review found the
question deserves a record.

## Affected Rules

- `law/schemas/campaign.schema.json`: the `review.mode` enumeration and the
  per-task verdict and digest fields it admits under `model-advisory`.
- `law/policy/campaign-execution.json`: the four review steps, who performs
  each, and the recording rule for the advisory verdict.
- `scripts/check-campaign.mjs`: the `pre_merge` to `merged` transition rule
  under `model-advisory`.

## Inspector Adversarial Acceptance

Validate a fixture campaign that declares `review.mode` as `model-advisory`
and confirm it passes; omit the field and confirm it validates as `human`;
declare any other value and confirm the schema rejects it. Under
`model-advisory`, move a task to `merged` with no verdict recorded and
confirm the campaign check refuses and names the task. Record a verdict whose
digest is one byte off the reply, and separately a verdict that fails the
schema, and confirm both refusals. Inspect a merged task and confirm the
gate, the merge, and every remote effect carry a human actor, and that no
path in the checker, the policy, or the orchestrator recipe merges on a model
verdict. Diff `law/constitution.md` against the base and confirm no change.
Present a verdict produced outside an orchestrator session and confirm it is
refused.
