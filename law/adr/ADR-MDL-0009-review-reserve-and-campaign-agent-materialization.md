---
id: ADR-MDL-0009
title: Review work keeps reserved capacity and campaigns can materialize agent tasks
type: adr
status: accepted
date: 2026-10-05
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-MDL-0005-opt-in-experimental-agent-execution.md
  - law/adr/ADR-MDL-0007-experimental-completion-recovery-and-capacity.md
  - law/adr/ADR-GOV-0025-governed-campaign-controller.md
  - docs/dev/operations/orchestrator-core-promotion.md
affected_rules:
  - law/policy/round-execution.json
  - law/schemas/round-execution.schema.json
  - law/policy/campaign-execution.json
  - law/schemas/campaign.schema.json
  - packages/loop/src/loop/round-task-admission.ts
  - packages/loop/src/campaign/index.ts
  - packages/cli/src/commands/campaign/index.ts
inspector_acceptance:
  - IA-001 -- With more run workers than the reserve and a same-generation review task (inspector or auditor) admissible but for capacity, a non-review task is refused with TASK_WORKER_CAP once non-review tasks hold the run's workers minus the reserve, while the review task is admitted.
  - IA-002 -- The reserve holds nothing when no review task awaits admission, when the review task is running, failed, or has a dependency that has not completed, and in a serial run; review tasks may use every worker.
  - IA-003 -- In the round runner with two workers, a ready review task starts beside the first implementation task ahead of implementation tasks ordered before it, and the round still completes.
  - IA-004 -- campaign materialize writes a human executor for a task with no executor contract, and for a task that declares one an agent executor with exact selection of its runtime, the declared or default iteration and capability values, and the composed prompt composition id; an identical re-materialization is reported as existing.
  - IA-005 -- An agent contract on an architect task, or with a runtime, effort or model outside experimental-execution.json, the runtime registry or the model tiers, refuses the whole round before any queue write, and so does an agent contract without a binding.
  - IA-006 -- A materialized agent task passes the activation check of round dispatch, its composition id matches the prompt dispatch composes, and a fake-provider dispatch takes it to awaiting_human_review.
---

# Review work keeps reserved capacity and campaigns can materialize agent tasks

## Status

Accepted on 2026-10-05. The Owner decided on 2026-10-05 that issue #297 ships in the next
release. This record closes the reviewer-reserve part of promotion row CP-13 and adds the
agent path to the campaign materializer of ADR-GOV-0025.

## Context

Two orchestrator design items were documented as not implemented:

- **Reviewer reserve.** `round-execution.json` kept `review_reserve` at
  `not-applicable-until-review-tasks`. Agent dispatch now runs Inspector tasks, so review
  is task work. With `--workers` above one, implementation tasks ordered first could take
  every worker, and a ready review task waited behind them.
- **Campaign to agent.** `campaign materialize` wrote only human executors, and
  `round dispatch` refuses those. A campaign could not feed agent dispatch without a hand
  edit of each task record.

## Decision

1. **Review reserve.** `capacity.review_reserve` names the review disciplines (inspector and
   auditor) and reserves one worker for them:
   - While a review task of the candidate's topological generation could be admitted but
     for capacity, non-review tasks may hold at most the run's workers minus the reserve.
     Such a review task is planned, `ready`, not active, not failed, and every dependency
     it has is completed.
   - Review tasks may use every worker.
   - A run with no more workers than the reserve, including the default serial run, is
     unreserved.
   - The refusal is the existing waitable `TASK_WORKER_CAP`: the reserve narrows the worker
     cap for non-review tasks and adds no new blocker.
   - The check lives in the admission decision, so `round run` and `round dispatch` share
     it. A contract test pins the code mirror to the policy.
2. **Agent executor contract.** A campaign task may declare an optional `executor` with
   kind `agent`, a runtime, model, effort and recipe, and optionally a recipe variant,
   `max_iterations` (1 to 4, default 4) and capabilities (default none). Without it the
   materializer writes the human executor, which stays the default.
3. **Validation at materialization.** Each declared contract is checked against these rules
   before anything is written:
   - the discipline is one experimental execution admits, so an architect task never
     becomes an agent task;
   - the runtime is one of the experimental runtimes;
   - the effort is one the runtime registry lists for that runtime;
   - the model is one of the runtime's aliases in the model tiers.

   One failing contract refuses the whole round before any queue write. The Owner
   activation is not required to materialize; `round dispatch --experimental` still requires
   an in-force activation that admits the discipline, runtime, model and effort.

4. **Agent record.** The agent executor selects its runtime exactly, takes `timeout_ms`
   from the task's time budget when one is declared, and is bound to the Article 37
   composition id of the materialized record. The CLI supplies the model aliases and the
   composer, because the loop package cannot depend on the prompt composer. A later change to
   a prompt component changes the id: re-materialization then refuses the differing record,
   and dispatch refuses with `TASK_PROMPT_COMPOSITION_DRIFT` until the Architect re-binds
   the task.

## Consequences

- Promotion row CP-13 has its reviewer reserve, and review work cannot be starved by
  implementation work in a parallel round.
- A campaign can feed `round dispatch --experimental` without a hand edit. Ratification,
  `task finish` and merge stay the human acts of ADR-GOV-0025 and ADR-MDL-0007.
- No action, effect or authority changes. A campaign with no executor contracts
  materializes byte for byte as before, and a serial round schedules as before.

## Alternatives Considered

- **A static reserve that always holds a worker.** Rejected: it would idle a worker in every
  round without review work.
- **A new blocker code for the reserve.** Rejected: it would add a code and a runner change
  for a refusal that already has the same meaning and the same waiting behaviour.
- **Requiring an in-force activation to materialize.** Rejected: an activation expires within
  30 days, while a plan is materialized once. Dispatch already checks the activation for
  every planned task before any lock.
- **Placeholder composition ids filled in at dispatch.** Rejected: dispatch refuses a task
  whose id differs from its composed prompt, and Article 37 requires the binding to be
  recorded.

## Affected Rules

As listed in the frontmatter.

## Inspector Adversarial Acceptance

The six counterexamples in the frontmatter must fail against an implementation that omits
the corresponding rule and pass against the candidate. They run against fixtures and a fake
provider. No live provider call is part of this acceptance.
