---
id: ADR-EVI-0003
title: round status reads the governed lifecycle without an active task round
type: adr
status: proposed
date: 2026-09-29
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0002
  - packages/cli/src/commands/round/workflow.ts
  - packages/loop/src/round-lifecycle/index.ts
  - packages/loop/src/loop/task-services.ts
  - docs/dev/operations/harness-convergence-extension-proposal.md
affected_rules:
  - packages/cli/src/commands/round/workflow.ts
  - packages/loop/src/round-lifecycle/index.ts
  - packages/loop/src/loop/task-services.ts
  - docs/reference/cli.md
  - docs/adopters/governance-tracking.md
inspector_acceptance:
  - IA-001 -- After round seal --write on a fixture round, round status --format json exits 0 and reports lifecycle closed, and the bytes of close-state.jsonl and of the proof chain are unchanged by the status read.
  - IA-002 -- On an active round, round status still returns the task summary it returned before; on a sealed round the task summary is absent or marked inactive, and its absence never turns the exit code non-zero.
  - IA-003 -- round run and task dispatch on a sealed round still refuse with ACTION_PRECONDITION_UNSATISFIED and context TASK_ROUND_INACTIVE, so the precondition is narrowed to dispatch and not removed.
  - IA-004 -- round status on a round that does not exist, or whose close-state.jsonl is malformed, fails with its existing named code and never reports closed.
---

# round status reads the governed lifecycle without an active task round

## Status

Proposed on 2026-09-29 from DETRAN R-0003 and R-0017 (#175). Binds nothing
until the Architect sets it to accepted before round R-0308 opens. The
reproduction on this repository is the first step of the round; if it does
not reproduce on `main`, the task reports blocked and this record is
revisited before any change lands. Seal evidence and its append-only rule
are unchanged.

## Context

`round seal --write` succeeds and writes `close-state.jsonl` with `status:
closed`. `round status` on the same round then exits 5 with
`ACTION_PRECONDITION_UNSATISFIED` and context `TASK_ROUND_INACTIVE`, because
the handler in `packages/cli/src/commands/round/workflow.ts` calls
`governedRoundStatus` and then unconditionally calls `roundTaskStatus`,
which requires an active task round; an existing `close-state.jsonl` makes
`authorizationIsActive` false. The published 1.5.6 and 1.6.0 bundles share
the control flow. A governed adopter can therefore seal a round and pass its
closure checks yet cannot satisfy a documented post-seal checkpoint that
expects `round status` to report `closed` (#175).

## Decision

`round status` returns the governed lifecycle for every governed round,
including `closed`, from `governedRoundStatus`. The task summary from
`roundTaskStatus` is attached only when the task round is active; when it is
not, the summary is absent or marked inactive, and its absence never changes
the exit code. `TASK_ROUND_INACTIVE` remains the precondition of `round run`
and of task dispatch, which are unchanged.

The status read writes nothing. `close-state.jsonl`, the proof chain, and
the tracking files are read only, and their bytes are asserted unchanged
across a status read. A missing round or a malformed close state fails with
its existing named code and never reports `closed`.

The CLI reference states the lifecycle-read contract, the governance-tracking
page records the reproduction and the post-seal checkpoint, and the
error-codes reference narrows the description of `TASK_ROUND_INACTIVE` to
dispatch.

## Consequences

An adopter's post-seal checkpoint can be satisfied by the framework command
instead of a local workaround. The change is confined to one handler and, if
needed, one lifecycle helper; the seal, the closure index of ADR-EVI-0001,
and the chain of ADR-EVI-0002 are untouched. The overlap with ADR-EVI-0001 is
in `round seal`, not in `round status`, so the two records land
independently.

## Alternatives Considered

Making `roundTaskStatus` tolerate an inactive round by returning an empty
summary is rejected because dispatch relies on the same function to refuse.
Adding a `--lifecycle-only` flag is rejected because the documented
checkpoint calls `round status` without flags and a flag would leave the
default broken. Treating the sealed state as active for reads is rejected
because it would let dispatch queries succeed on a sealed round.

## Affected Rules

- `packages/cli/src/commands/round/workflow.ts` attaches the task summary conditionally.
- `packages/loop/src/round-lifecycle/index.ts` and `packages/loop/src/loop/task-services.ts` keep the lifecycle read and the dispatch precondition separate.
- `docs/reference/cli.md` and `docs/adopters/governance-tracking.md` state the contract.

## Inspector Adversarial Acceptance

Seal a fixture round, hash `close-state.jsonl` and the chain, run `round
status --format json`, and confirm exit 0, lifecycle `closed`, and unchanged
hashes. Run `round status` on an active fixture round and confirm the task
summary is present as before. Run `round run` and a task dispatch on the
sealed round and confirm `TASK_ROUND_INACTIVE`. Run `round status` on an
unknown round id and on a round whose `close-state.jsonl` is truncated, and
confirm each fails with its existing named code.
