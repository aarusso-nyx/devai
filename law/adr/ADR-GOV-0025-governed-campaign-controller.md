---
id: ADR-GOV-0025
title: Campaigns reach the runtime through one projection, one materializer, and human ratification
type: adr
status: accepted
date: 2026-10-04
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-MDL-0005-opt-in-experimental-agent-execution.md
  - law/policy/campaign-execution.json
  - docs/dev/operations/orchestrator-core-promotion.md
affected_rules:
  - law/policy/campaign-execution.json
  - law/policy/action-registry.json
  - packages/loop/src/campaign/index.ts
  - packages/cli/src/commands/campaign/index.ts
  - packages/cli/src/commands/round/ratify.ts
  - packages/loop/src/loop/ratification.ts
  - packages/schemas/src/roster.ts
  - law/invariants/INV-CORE-006.json
inspector_acceptance:
  - IA-001 -- campaign status is read-only, reports every campaign round, wave and task beside its runtime task state, and names each drift (planned-but-missing, runtime-ahead-of-plan, unknown runtime task) without changing a byte.
  - IA-002 -- campaign materialize writes only through the existing task queue, only for an open round with an active authorization, maps each task exactly as campaign-execution.json materialization declares, is idempotent for an identical record, and refuses any differing existing record instead of overwriting it.
  - IA-003 -- round ratify records a human decision on a task awaiting review and moves it only to pre_merge (accept) or escalated (reject); it never merges, pushes, closes the round, or ratifies on a model's verdict, and refuses any other task state.
  - IA-004 -- With the external controller retired, a campaign round still runs end to end through round run or round dispatch, and removing every experimental activation returns the repository to the supported serial runner with no other change.
---

# Campaigns reach the runtime through one projection, one materializer, and human ratification

## Status

Accepted on 2026-10-04 as orchestrator stage S4. The Owner directed that S4a through S4d
ship in 2.0.0 and authorized the Architect's design for this campaign.

## Context

A campaign is a plan and a ledger (`campaign.schema.json`), validated only statically by
`scripts/check-campaign.mjs`. No code turns a campaign round into canonical task records, so
campaigns ran either as hand-driven pull requests or through an external Codex controller
whose state lived untracked under `.git/`. `campaign-execution.json` already declares the
exact mapping from campaign tasks to task records, under `materialization`. Review,
ratification and `merged_as` are recorded by hand, and S3 leaves passing experimental work
`awaiting_human_review` with no governed action to record the human decision.

## Decision

1. **S4a — `campaign status` (read).** It projects
   `product/campaigns/<id>/campaign.json` onto canonical identities. For each round, wave and
   task it reports the plan status beside the runtime task record, and names each drift:
   - a plan task with no runtime record once the round is open;
   - a runtime record ahead of the plan, such as completed but not marked merged;
   - a runtime task the plan does not name.

   It writes nothing.

2. **S4b — `campaign materialize` (Architect, write).** For one open campaign round whose
   governed round has an active authorization, it builds each task's record exactly by
   `campaign-execution.json` `materialization.governed_task_record`:
   - the task fields, with the wave as the coupled group;
   - a `human` executor whose role is the discipline;
   - the campaign prompt as `instructions_ref`.

   It writes them through the existing round task queue. The backlog queue stays the only
   queue (Article 35). The human executor completes on a merged pull request and escalates
   after the task's `time_budget_minutes`, or seven days when none is declared.
   `created_at` is the campaign date, so an identical plan yields identical records, and
   `campaign.schema.json` joins the runtime schema roster so the plan is validated. An identical existing record is accepted, and a differing one is
   refused, never overwritten.

3. **S4c — `round ratify` (Owner or Architect, write).** It records a human ratification for
   one task in `awaiting_human_review`: accept moves it to `pre_merge`, and reject escalates
   it. The record is written to `.devai/state/round-runs/<round>/ratifications/<task>.json`
   and names the role, the decision, the reviewed evidence, and the branch or worktree. It
   never merges, pushes, closes a round, or treats a model verdict as ratification
   (Article 28; `campaign-execution.json` `gates.review`).
4. **S4d — retire the external controller.** `campaign-execution.json` names
   `campaign materialize` as the only materialization path and records the external
   controller as retired. Campaign rounds run through `round run` (supported) or
   `round dispatch` (experimental). Nothing is deleted: the pilot stays archived, the
   historical ledgers are evidence, and the legacy hand-driven pull-request path remains
   valid. Rollback means removing the activation and not calling the new actions; no
   migration of stored state is needed.

## Consequences

- Campaign plans and runtime state meet in one read-only report, and drift is named
  instead of found by hand.
- Experimental or human work ends in an explicit human ratification, separate from merge.
- Three preview actions join the registry, and the materialization section of
  `campaign-execution.json` becomes operative.

## Alternatives Considered

- **A long-running controller process.** Rejected: Article 3 keeps the supported harness
  from dequeuing by itself, and S3 already provides bounded, human-initiated experimental
  dispatch.
- **Automatic merge after ratification.** Rejected: Article 28 keeps merge human.

## Affected Rules

As listed in the frontmatter.

## Inspector Adversarial Acceptance

The four counterexamples in the frontmatter must fail against an implementation that omits
the corresponding rule and pass against the candidate.
