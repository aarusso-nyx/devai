---
id: ADR-MDL-0007
title: Agent work completes, recovers and fits capacity through registered actions
type: adr
status: accepted
date: 2026-10-05
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-MDL-0005-opt-in-experimental-agent-execution.md
  - law/adr/ADR-MDL-0006-owner-action-writes-experimental-activation.md
  - law/adr/ADR-GOV-0025-governed-campaign-controller.md
  - docs/dev/operations/orchestrator-core-promotion.md
affected_rules:
  - law/policy/experimental-execution.json
  - law/schemas/experimental-execution.schema.json
  - law/schemas/dispatch-journal-event.schema.json
  - law/policy/action-registry.json
  - law/invariants/INV-AUTH-002.json
  - packages/loop/src/loop/dispatch-journal.ts
  - packages/loop/src/loop/dispatch-disposition.ts
  - packages/loop/src/loop/task-services.ts
  - packages/loop/src/loop/ratification.ts
  - packages/loop/src/loop/worktrees.ts
  - packages/cli/src/services/experimental-dispatch/index.ts
  - packages/cli/src/commands/round/dispatch-deactivate.ts
  - packages/cli/src/commands/round/dispatch-dispose.ts
inspector_acceptance:
  - IA-001 -- An agent task accepted by round ratify completes only through task finish with an accepted ratification and merge evidence, passing through merging, and its attempt worktree is released; a rejected or escalated agent task releases its worktree too, and routine and human tasks behave as before.
  - IA-002 -- An open journal attempt, or an agent task left in progress with no journal record, blocks round dispatch whatever the task status, and clears only through a recorded disposition that closes each open attempt; the refusal names every such task.
  - IA-003 -- Only the Owner with --write and --experimental can dispose or deactivate; each writes a durable record before it changes anything else, never runs a provider, and a retry continues the attempt ladder and refuses once it is spent.
  - IA-004 -- A damaged journal is quarantined only on the Owner's request, moved aside byte for byte under its SHA-256 name with a record written first; a readable journal is never quarantined, and tasks left in flight still need their own disposition.
  - IA-005 -- A task whose ladder starts no attempt in a dispatch stays ready, keeping its locks under round-execution.json release_on; a budget never blocks untouched work.
  - IA-006 -- The worktree cap equals round-execution.json capacity.max_workers; worktrees retained for review or disposition, and those left by a provably gone attempt process, hold no capacity, so every admitted worker can run beside pending reviews.
---

# Agent work completes, recovers and fits capacity through registered actions

## Status

Accepted on 2026-10-05. The Owner directed that orchestrator gaps 1 to 3 be closed before
2.0.0. This record amends ADR-MDL-0005 D-6 and records the worktree cap default that
Constitution Article 27 leaves to the decision log.

## Context

Experimental agent work had no registered way to finish, recover, or fit in capacity:

- **Completion.** `round dispatch` leaves a passing agent task `awaiting_human_review`,
  and `round ratify --decision accept` moves it to `pre_merge`. Nothing then advanced it:
  `task finish` accepted non-human tasks only in `merging`, so escalation was the only exit.
- **Recovery.** ADR-MDL-0005 D-6 named `task escalate` as the only disposition and made a
  retry a new task. Any terminal status silently cleared an uncertain attempt, with no
  record. A damaged journal blocked its round forever, and withdrawing an activation meant
  deleting a file by hand. A crash before the first intent left a task `in_progress` with
  no record at all. Budget exhaustion marked every untouched task `experimental_blocked`.
- **Capacity.** The worktree cap was 3, while `round-execution.json` admits four workers.
  Worktrees retained for review counted against it, so a fourth worker or a fourth pending
  review failed setup and blocked its task.

## Decision

1. **Completion.** After `round ratify --decision accept` and the human merge, which stays a
   separate human act (ADR-GOV-0025), `task finish` completes an agent task in `pre_merge`:
   - It needs the accepted ratification record and at least one `EV-` merge evidence
     reference, and refuses while an attempt is open.
   - It writes a completion record binding the ratification digest and the merge evidence.
   - It moves the task through `merging` to `completed` and releases the attempt worktree.

   Escalating an agent task through `task escalate` or a rejecting ratification also
   releases its worktree. Branches are kept. Routine and human tasks are unchanged.

2. **Recorded dispositions.** Uncertainty clears only through a disposition record. That is
   a create-only, fsynced file under `.devai/state/round-runs/<round>/dispositions/`, written
   before anything else changes. Each open attempt is then closed by a journal `settled`
   event with outcome `cancelled`, which names the disposition and its record, at whatever
   boundary the attempt reached. `task escalate` writes one for an agent task with open
   attempts. An agent task left `in_progress` with no open attempt is uncertain too. This
   amends D-6 and the policy's journal rule (`blocks-round-until-recorded-human-disposition`).
3. **`round dispatch dispose`** (Owner, `--write --experimental`, preview). It holds the
   round controller, so it never races a live dispatch.
   - `--task T --as retry|escalate` disposes of one agent task: one with an open attempt,
     one left in progress, or one that is `experimental_blocked`. It releases the attempt
     worktrees; its locks follow `round-execution.json` release_on.
   - A retry returns the task to `ready`. Attempts are numbered for the task's lifetime, so
     the Article 19 ladder continues rather than restarting. Once the ladder is spent, a
     retry refuses: a further try is a new task.
   - `--quarantine-journal` moves a damaged journal aside byte for byte, named by its SHA-256,
     after writing the record. A readable journal refuses.
4. **`round dispatch deactivate`** (Owner, `--write --experimental`, preview). It writes a
   withdrawal record with the time and the withdrawn activation's digests, then removes the
   activation durably.
5. **Untouched work stays ready.** When a budget or setup refusal means a task's ladder
   starts no attempt in a dispatch, the task returns to `ready` and keeps its locks, which
   `round-execution.json` release_on frees only on completion, escalation, a gap pause or
   cancellation; the next dispatch reuses them.
6. **Capacity.** The worktree cap mirrors `round-execution.json` capacity.max_workers,
   pinned by a contract test, replacing D-52's value of 3. A worktree retained after its
   attempt settles holds no capacity, and neither does one left by an attempt process that is
   provably gone (Article 27 tracks such worktrees separately). Each retained worktree stays
   bound to its task: the passing attempt for review, the last failed attempt for a blocked
   task (IA-006 of ADR-MDL-0005), or the uncertain one.
7. **Hardening.** Each of these rules follows from D-3, D-6 or D-7:
   - Journal appends and every new record write all their bytes and fsync the directories
     they create.
   - The task outcome and worktree binding are persisted before an attempt settles.
   - Any failure after a provider started leaves the attempt uncertain.
   - A pass is never persisted after a lost lock.
   - A missing usage counter makes the spend unverifiable.
   - Symbolic links that resolve outside the worktree fail the attempt.
   - Efforts are checked against the runtime registry.
   - `round dispatch` validates the whole planned dependency closure before any lock.

## Consequences

- An accepted agent task has a registered path to `completed`, and uncertainty always ends
  in an auditable record.
- The approved action set grows to 68. `task escalate` and `round ratify` gain git-ref
  targets so they can release worktrees.
- An adopter that never activates experimental dispatch sees no change beyond the larger
  worktree cap.

## Alternatives Considered

- **Keep "a retry is a new task".** Rejected: it forces a new task record for a crash in
  a narrow window and loses the attempt history that bounds the ladder.
- **Restart the ladder on retry.** Rejected: Article 19 bounds attempts per task.
- **Count retained worktrees and raise the cap further.** Rejected: pending reviews would
  still crowd out workers, and the cap would stop reflecting real parallelism.

## Affected Rules

As listed in the frontmatter.

## Inspector Adversarial Acceptance

The six counterexamples in the frontmatter must fail against an implementation that omits
the corresponding rule and pass against the candidate. They run against a fake provider and
constructed crash states. No live provider call is part of this acceptance.
