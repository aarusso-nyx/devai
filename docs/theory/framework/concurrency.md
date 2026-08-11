---
title: Concurrency
sidebar_position: 7
---

# Concurrency

> The framework runs multiple agents simultaneously. [Constitution Part VI — Articles 24-28](../../reference/law.md) defines the mechanisms that prevent them from colliding: coupled triplets stage work along the authority chain, module locks coordinate concurrent writes, checkpoints synchronise pipelined branches, and worktree discipline isolates each agent's workspace.

## Coupled triplets (Article 24)

Work that spans the authority chain is grouped into **coupled triplets**:

- An **Architect task** that produces invariant changes.
- An **Inspector task** that produces tests for those invariants.
- An **Engineer task** that produces code satisfying those tests.

The three tasks share a `coupled_task_group` ID in the backlog.

**Triplet branches form a pipeline:**

- Architect branch is created from integration HEAD.
- Inspector branch is created from Architect's HEAD.
- Engineer branch is created from Inspector's HEAD.

**Merge order respects the authority chain:** Architect to integration first, then Inspector, then Engineer. Each merge triggers rebase of downstream pipeline branches.

Triplet branches may execute concurrently in separate worktrees. They synchronize via **checkpoints**.

## Module-level semantic locking (Article 25)

Concurrent tasks coordinate through module-level locks tied to F4 inventory units. Before spawning a task worktree, the orchestrator acquires locks on the `(substrate, module)` pairs the task declares in its `target_modules` field.

- If any required lock is held, the task is **denied and re-queued with priority bump**.
- After repeated denials, a task is flagged blocked for human review.

Locks are held for the lifetime of the task worktree and released on merge, escalation, or RGR pause. **Locks are not held across coupled-triplet boundaries** — each task in a triplet acquires and releases its own locks.

## Checkpoints and pipelined rebase (Article 26)

Upstream branches in a coupled triplet emit explicit checkpoints when their work reaches a stable consumable state. Downstream branches rebase automatically on:

1. Upstream checkpoint emission.
2. Upstream merge to integration.

Downstream branches do **not** rebase on every upstream commit. Checkpoint cadence is at the upstream discipline's discretion, with **one mandatory checkpoint at task completion**.

## Worktree discipline (Article 27)

All agent work occurs in dedicated worktrees under `.devai/worktrees/<task-id>`. The repository root checkout is **reserved for human use**; agents do not operate in the root.

**The active agent worktree count is capped by F5 policy.** Harness-owned worktrees are tracked separately and do not count against the cap. Consult the active runtime policy instead of freezing a second numeric authority in documentation.

A worktree is provisioned with:

- Cache symlinks to shared `node_modules`, TypeScript build cache, Jest/Vitest cache, ESLint cache.
- The symlinks are honoured only if the package lockfile hash matches integration HEAD.
- On lockfile mismatch, the worktree falls back to fresh install.

## Single integration branch (Article 28)

The repository has a single integration branch (`main`). Task branches merge directly to it. **No `staging` layer exists in the default DEVAI configuration.**

The single-branch rule simplifies the merge graph: a task knows what it's rebasing onto, the auditor knows what to score, the evidence chain has a linear history. Multi-branch staging is rejected as substrate complexity that the iteration cap + worktree cap render unnecessary.

## See also

- [Constitution Articles 24-28](../../reference/law.md) — the binding text.
- [Loop](./loop.md) — how concurrency fits the cycle/iteration model.
- [Roles → cross-role coordination](../../roles) — worked examples of triplet flow.
