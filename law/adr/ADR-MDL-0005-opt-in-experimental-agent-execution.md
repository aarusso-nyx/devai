---
id: ADR-MDL-0005
title: Opt-in experimental agent execution through host CLI providers
type: adr
status: proposed
date: 2026-10-04
authority: Architect
supersedes: []
provenance:
  - law/constitution.md
  - law/adr/ADR-MDL-0002-versioned-model-defaults.md
  - law/policy/round-execution.json
  - law/policy/model-runtime-registry.json
  - docs/dev/operations/orchestrator-core-promotion.md
affected_rules:
  - law/policy/experimental-execution.json
  - law/schemas/experimental-execution.schema.json
  - law/schemas/experimental-activation.schema.json
  - law/schemas/dispatch-journal-event.schema.json
  - law/schemas/task-execution-evidence.schema.json
  - law/schemas/action-registry.schema.json
  - law/policy/action-registry.json
  - law/policy/model-runtime-registry.json
  - packages/authority/src/boundaries/host-effects.ts
  - packages/loop/src/loop/agent-executor.ts
  - packages/loop/src/loop/round-runner.ts
  - packages/cli/src/commands/round/dispatch.ts
  - packages/skills/src/model-bridge/index.ts
inspector_acceptance:
  - IA-001 -- Without both an unexpired Owner activation record and per-invocation experimental consent, an agent task refuses before any provider process starts, exactly as it does today.
  - IA-002 -- A runtime, model, effort, discipline, or budget outside the activation record refuses before spawn; nothing falls back to another runtime or model.
  - IA-003 -- An agent attempt runs only inside its own task worktree; a write outside the discipline's Article 6 paths fails the attempt even when the provider reports success, and no attempt pushes, merges, or opens a pull request.
  - IA-004 -- A crash at each dispatch boundary (before intent, after intent, after spawn, after exit, after evidence) leaves the task either untouched or uncertain; an uncertain task blocks the round until a human disposition, and is never retried automatically.
  - IA-005 -- A provider counter that is missing, regressed, or cumulative-only is recorded as unknown or derived, never as zero; a cost the provider does not report is unknown, never 0.
  - IA-006 -- Three default-tier attempts plus one bumped-tier attempt end in experimental_blocked; the fourth failure never triggers a merge, a replacement task, or cleanup of the worktree.
  - IA-007 -- Every evidence record from this mode carries the experimental label and is refused by supported gates, scorecards, round close, and release certification.
  - IA-008 -- The same composition inputs produce the same prompt stack hash, and a change to any component changes exactly that component's hash.
---

# Opt-in experimental agent execution

## Status

Proposed by the Architect on 2026-10-04 as orchestrator stage S3a. It needs Owner
ratification before any S3 code is written. The decision points marked **D-n**
record a recommended choice; the Owner may ratify, amend, or reject each one.

## Context

`round run` executes routine and human tasks. An `agent` task refuses with
`TASK_AGENT_ADAPTER_UNBOUND`: `executeAgentExecutor` validates the request and then
calls an `invokeAgent` callback that nothing supplies. The model runtime registry
already lists `claude-cli` and `codex-cli`, but the only code that starts them is
the one-shot, read-only bridge used by the judge and triage sensors.

The constitution already reserves a mode for this. Article 1 allows autonomous
controllers "only as explicitly enabled experimental F5 policy" without
production-readiness standing. Article 3 lets an enabled experimental controller
automate a bounded subset under stricter F5 policy. Article 8 forbids agent dispatch
without human initiation except under that policy. Article 19 fixes the experimental
ladder at three default-tier attempts plus one bumped-tier attempt, ending in
`experimental_blocked`. Article 23 makes each supported model invocation human-
initiated, and experimental traversal non-promoting. Article 35 requires experimental
evidence to be labelled. Article 37 requires deterministic prompt composition with
component and stack hashes.

The action registry's consent object has an `experimental` bit, but every action
sets it false and nothing defines how it is satisfied. Task-execution evidence
records usage as two required integers, so a missing counter can only be written as
zero; the Claude CLI bridge does exactly that today. Nothing records that a dispatch
was started, so a crash leaves a task `in_progress` with no record of whether a
provider process ever ran. The authority layer offers only synchronous process
effects, so no executor can overlap another (orchestrator S2c).

The orchestrator pilot proved the shapes this needs: streaming provider adapters,
an append-only dispatch journal with explicit recovery dispositions, and cumulative-
counter usage normalization. It left crash recovery, host enforcement, and
accounting semantics only partially proven. This decision promotes those shapes
under the canonical contracts instead of copying the pilot.

## Decision

**D-1. Two-key activation.** Experimental agent execution needs both:

1. an Owner-authored activation record, `.devai/config/experimental-execution.json`
   (new schema `experimental-activation.schema.json`), that names the allowed
   runtimes, exact models and efforts, the allowed disciplines, the budgets, and an
   expiry date at most 30 days after it is written; and
2. per-invocation consent: a new experimental-lifecycle action, `round dispatch`,
   whose consent is `{ write: true, allow_publish: false, experimental: true }`,
   satisfied only by `--write --experimental` on that invocation.

`round run` keeps `experimental: false` and its current behavior. The schema gains
the description "Satisfied only by explicit --experimental consent for the resolved
invocation; never implied by --write" for the `experimental` bit. Without a valid,
unexpired record, `round dispatch` refuses before planning.

**D-2. Disciplines.** The activation record may allow `engineer` and `inspector`
only. `architect` stays human-executed because it writes law, and `owner` and
`auditor` are never inferred (round-execution.json roles).

**D-3. Containment.** Each attempt runs in its own task worktree created from the
round's base ref, never in the main checkout. The adapter requests the provider's
own containment (Codex `--sandbox workspace-write` for authors, `read-only` for
review; Claude `--permission-mode` with the worktree as the only added directory),
records it as _requested_, and never claims it as verified. After the attempt, the
runner checks every changed path against the discipline's Article 6 write scope;
any path outside it fails the attempt. No attempt pushes, merges, opens a pull
request, or makes any other remote effect. The result is a local branch for human
review and merge (Article 28).

**D-4. Attempt ladder.** Article 19 as written: three attempts at the task's
resolved tier, then one attempt at the next tier from `model-tiers.json`, then
`experimental_blocked`. The ladder is bounded further by the task's
`max_iterations` when that is lower. There is no other fallback (round-execution
`selection_fallback: forbidden-exact-host-selection-only`).

**D-5. Budgets.** The framework policy `experimental-execution.json` fixes ceilings;
the activation record sets the values, which must not exceed them:

| Budget                           | Ceiling                                     | Enforcement                                                                                        |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| provider attempts per task       | 4                                           | hard: refused before spawn                                                                         |
| provider attempts per invocation | 32                                          | hard: refused before spawn                                                                         |
| wall-clock per attempt           | 60 min                                      | hard: process group terminated                                                                     |
| tokens per invocation            | declared, no default                        | soft: checked before each spawn; an attempt in flight may overshoot, and the overshoot is recorded |
| concurrent agent workers         | `round-execution.json` capacity.max_workers | hard                                                                                               |

A token budget can only stop the next attempt, not one already running, because
neither CLI accepts a hard token limit. The evidence records the overshoot.

**D-6. Crash safety.** The runner appends fsynced events to
`.devai/state/round-runs/<round>/dispatch-journal.jsonl` (new schema
`dispatch-journal-event.schema.json`): `intent`, `spawned`, `exited`,
`evidence-written`, and `settled`. When the round controller starts, any task with
`intent` but no `settled` is **uncertain**. An uncertain task blocks `round dispatch`
for the whole round with `TASK_DISPATCH_UNCERTAIN` until a human disposes of it with
the existing `task escalate` action, which records the abandonment. A retry is a new
task. Nothing is retried, replayed, or cleaned up automatically, and the worktree is
kept for inspection.

**D-7. Usage and cost evidence.** `task-execution-evidence` gains a version-2 usage
record. Each counter (input, output, cache read, cache write) is `{ value, status }`,
where `status` is `reported`, `derived`, or `missing` and `value` is null when
missing. The record also states whether the provider counters are per-attempt or
cumulative and how the delta was derived. A regressed cumulative counter is
`missing`, never negative. Cost gains the source `unknown`, with a null amount.
Version-1 records stay valid and are never rewritten.

**D-8. Prompt composition.** A deterministic composer builds the prompt from four
components in order:

1. global: the adopter's `AGENTS.md`;
2. role: the discipline charter under `docs/roles/`;
3. task: the canonical task record without mutable lifecycle fields;
4. payload: the task's recipe and declared inputs.

It records each component's SHA-256, the stack hash, and a `PC-` identity under
`prompt-composition.schema.json`, and writes `prompt.prompt_sha256` into the evidence.
A missing component refuses; it is never silently skipped.

**D-9. Non-promoting evidence.** Every task-execution record from `round dispatch`
carries `experimental: true`, and so does every derived journal and composition
record. Supported gates, scorecards, round close, and release certification refuse
experimental evidence as acceptance.

**D-10. Asynchronous governed process effect.** The authority layer gains a guarded
asynchronous `spawn` effect. It is classified, planned, and authorized like
`spawnSync`, and adds process-group termination and a streamed-output bound. Agent
adapters use only this effect. It is also what lets S2c's concurrent scheduler
overlap executors.

## Consequences

- Agent tasks can run under DEVAI's own runner without the external Codex
  controller, inside the same locks, round controller, admission, and evidence
  boundaries as routine tasks.
- Supported behavior is unchanged. `round run`, every existing action, and
  version-1 evidence keep their meaning; an adopter that never writes an activation
  record sees no change.
- New law: one policy, three schemas, a version-2 usage record, one experimental
  action, and the consent description. Schema and catalogue counts change with them.
- Live provider calls still need a separate Owner authorization naming the budget
  for the first live probe (S3c). This decision authorizes design and fake-provider
  tests only.

## Alternatives Considered

- **Make `--experimental` a flag on `round run`.** Rejected: consent is a static
  property of an action, and a single action that is sometimes experimental would
  blur which evidence is promoting.
- **Activation in framework policy alone.** Rejected: whether an adopter runs agents
  is that adopter Owner's decision, and the record must expire.
- **Automatic retry of uncertain dispatches.** Rejected: a provider may have written
  files or spent budget, and Article 19 forbids destructive automatic recovery.
- **Treat missing usage as zero.** Rejected: it understates spend and hides provider
  changes; this is the current bridge defect.
- **Copy the pilot controller.** Rejected by the S1 design: one canonical task
  queue, no second journal format, no private plan model.

## Affected Rules

The policies, schemas, and modules in the frontmatter. No constitutional text
changes: Articles 1, 3, 8, 19, 23, 35, and 37 already provide for this mode.

## Inspector Adversarial Acceptance

The eight counterexamples in the frontmatter must each fail against an
implementation that omits the corresponding rule and pass against the candidate.
They run against a fake provider that scripts exits, partial output, missing and
regressed counters, out-of-scope writes, and crashes at each journal boundary. No
live provider call is part of S3a or S3b acceptance.
