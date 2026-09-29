# Workflow economy campaign

The plan that implements the nine records indexed in
[workflow economy proposals](../workflow-economy-proposals.md) lives at
[`product/campaigns/CMP-0001-workflow-economy/campaign.json`](../../../../product/campaigns/CMP-0001-workflow-economy/campaign.json).
Its structure is `law/schemas/campaign.schema.json`; its semantics are
`law/policy/campaign-execution.json`. This page is the human guide.

## Vocabulary

- **Campaign.** An ordered set of rounds implementing an explicit set of
  accepted decision records under one mandate.
- **Round.** The smallest set of waves that closes with one merged head and,
  when the task descriptor changed, one attestation re-issue.
- **Wave.** One coupled task group in the sense of Constitution Article 24:
  an Architect, an Inspector, and an Engineer task in pipeline order, or one
  single-role task. Waves in a round run in parallel when their lock scopes
  are disjoint.
- **Task.** One role, one session, one branch, one pull request, one boundary.

## Models, effort, and time

Every task carries an `execution` block with a tier and an effort. Tiers are
the only model names prompts use. The tier map is the repository default in
[`law/policy/model-tiers.json`](../../../../law/policy/model-tiers.json),
validated by
[`law/schemas/model-tiers.schema.json`](../../../../law/schemas/model-tiers.schema.json)
(ADR-MDL-0002): each tier has a rank, one host alias per host, and a default
effort, and the document carries a `policy_version` that every change bumps.
At policy version 1.0.0 the default is:

| Tier          | Rank | Claude alias | Codex alias   | Default effort |
| ------------- | ---- | ------------ | ------------- | -------------- |
| `architect`   | 1    | `fable`      | `gpt-6-astra` | high           |
| `worker-high` | 2    | `opus`       | `gpt-6-sol`   | high           |
| `worker`      | 3    | `sonnet`     | `gpt-6-sol`   | medium         |
| `clerk`       | 4    | `haiku`      | `gpt-6-luna`  | low            |

The aliases are the names the Claude Code and Codex CLIs accept; the Claude
host resolves through the `claude-cli` runtime and the Codex host through
`codex-cli` in
[`law/policy/model-runtime-registry.json`](../../../../law/policy/model-runtime-registry.json).
The tier named `architect` is a capability rank and the escalation ceiling,
not the Architect discipline; the name is kept because the closed campaigns
reference it. The orchestrator runs at the architect tier.

A campaign declares nothing about models unless it needs a different alias
for one tier. Its optional `models.tiers` block overrides the default by tier
name, and a tier it does not name resolves to the default. A campaign never
introduces a host. An unknown tier, an effort outside `low`, `medium`,
`high`, `max`, a host the default does not declare, or an alias the host
does not declare fails `pnpm run campaign:check`. Closed campaigns keep their
own `models` blocks byte-for-byte as evidence.

At task start the orchestrator pins the merged map on the task as
`execution.resolved`, together with the default's `policy_version`. Every
pinned entry is in the `runtime:model` registry id form the executor code
enforces: the runtime id, a colon, and the alias, for example
`claude-cli:fable` or `codex-cli:gpt-6-astra`. A later change to the default
or to the override never reinterprets a started task; only a task started
after the change resolves the new map.

Escalation is the orchestrator's call: after one failed iteration, a blocked
report, or a time budget exceeded without a pull request, rerun the task one
rank up the pinned map, up to its ceiling. A second failure at the ceiling is
a gap for a human. Every prompt states that time matters and that partial
progress beats perfection.

## Review mode

Review of a task pull request has four steps (ADR-GOV-0023): model
evaluation, gate ratification, merge, and dispatch of any remote effect.
Only the first may be delegated, and the campaign says so with
`review.mode`. `human`, the default when the field is absent, delegates
nothing. `model-advisory` lets a model instance distinct from the task's
working agent evaluate the pull request inside the human-initiated
orchestrator session and produce an advisory verdict in the shape
ADR-MDL-0001 declares.

Under `model-advisory`, before the human ratifies the gate, the orchestrator
records a `review` block on the task: the verdict document, the SHA-256 of
the reply it was extracted from, the evaluator in `runtime:model` form, and
the time. A task in `pre_merge` without that block, with a verdict that fails
the verdict schema, or with a digest that does not match cannot move to
`merged`, and `pnpm run campaign:check` names the task. The verdict is advice
to the ratifying human and nothing else: it never satisfies a gate, merges,
or authorizes an effect, and the ledger shows a human actor on the gate, the
merge, and every remote effect.

## Opening a round

1. The Architect sets each of the round's records to `accepted` in a
   `law(adr)` commit, after the Inspector acceptance items are agreed.
2. Confirm every round in `depends_on` is `closed`.
3. Set the round to `open` in the campaign document, in a `plan(campaign)`
   commit, and run `pnpm run campaign:check`.

## Running a task

1. Confirm the round is open: its records are accepted and its upstream
   rounds are closed. Confirm the wave is open and the task's upstream task
   is merged.
2. Open a session with the task's discipline declared. Paste
   `prompts/preamble.md`, then the task's prompt file, verbatim.
3. Record the prompt file's sha256 on the task before work starts, and pin
   the resolved tier map as `execution.resolved` with the default's
   `policy_version`.
4. When the pull request is open and the acceptance commands pass, set the
   task to `pre_merge`. Under `review.mode` `model-advisory`, record the
   `review` block before ratifying the gate. After merge, record
   `pull_request` and `merged_as`.
5. After the last task of a round merges, run the universal close checks and
   the round's `close_checks` on the merged head, perform any owner effect the
   round requires, re-issue the attestation when the round says so, and record
   the closure.

The campaign document is the ledger. Update it after every merge and every
close in a commit of type `plan(campaign)`, and run `pnpm run campaign:check`
before committing it.

## Closing a round

1. Run the universal close checks (`adrs`, `schemas`, `docs-links`,
   `format:check:all`, `action-registry:check`) and the round's
   `close_checks` on the merged head.
2. Perform and date every owner effect the round requires.
3. When `attestation_reissue` is true, record the new task-policy digest in
   the round closure and re-issue the RC attestation for it as described in
   [release discipline](../release-discipline.md) before any release plan
   uses that head.
4. Set the round to `closed` with its `closure` block in a `plan(campaign)`
   commit.

## Self-dogfood limits

This is DEVAI's own repository. Every session is human-invoked, one role per
session, no backlog dequeue, no self-dispatch, no remote effect. The campaign
is executed as maintainer-driven pull requests; materializing a round into a
governed round record is optional and follows the mapping in the policy.

## Known discrepancies to resolve in flight

- `law/policy/round-execution.json` orders coupled tasks inspector first;
  Constitution Article 24 and the cross-role documentation order Architect
  first. The campaign follows the constitution. TASK-0121 reconciles the
  policy.
- `packages/loop/src/loop/backlog.ts` names the round task queue. The
  repository backlog of ADR-GOV-0019 uses a distinct module name.
