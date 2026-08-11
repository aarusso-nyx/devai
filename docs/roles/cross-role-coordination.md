---
title: Cross-role coordination
sidebar_position: 8
---

# Cross-role coordination

> No single discipline may both set its own reference and actuate against it ([Article 10](../reference/law.md)). Cross-substrate work is therefore impossible _within one task_. Coordinated multi-role work uses the **coupled-triplet pattern** ([Article 24](../reference/law.md)), which stages three tasks along the authority chain and synchronises them via checkpoints.

## Coupled task triplets

A coupled triplet groups three tasks that together advance a cross-substrate change:

| Position | Role      | Task type      | Produces                                                       |
| -------- | --------- | -------------- | -------------------------------------------------------------- |
| 1        | Architect | spec-change    | New / modified invariants, trace updates, ADR if cross-cutting |
| 2        | Inspector | test-author    | Tests probing the new / modified invariants                    |
| 3        | Engineer  | code-implement | Code satisfying the tests                                      |

The three tasks share a `coupled_task_group` ID in the backlog. The orchestrator dispatches them as a unit; the human Architect approves the triplet's framing before it starts.

## Branch pipelining (Article 24)

Triplet branches form a pipeline:

```
integration HEAD
       │
       ▼
   Architect branch       ← created from integration HEAD
       │
       ▼ checkpoint emission
   Inspector branch        ← created from Architect's HEAD
       │
       ▼ checkpoint emission
   Engineer branch         ← created from Inspector's HEAD
```

Each downstream branch starts from the upstream's HEAD at branch-creation time. After upstream emits a checkpoint, downstream rebases to the new checkpoint. After upstream merges to integration, downstream rebases to the new integration HEAD.

## Checkpoints (Article 26)

Upstream branches emit explicit checkpoints when their work reaches a **stable consumable state**:

- Architect emits a checkpoint when an invariant's canonical statement + scope + change_policy + measurable_via fields are settled (even if some review iterations remain).
- Inspector emits a checkpoint when test files exist + compile + assert the invariant's measurement (even if some mutation-scenario authoring remains).
- Engineer emits a checkpoint at task completion (mandatory) — never mid-task.

Downstream branches **do not rebase on every upstream commit**. Checkpoint cadence is at the upstream discipline's discretion, with one mandatory checkpoint at task completion.

## Merge order

Merge to integration respects the authority chain:

1. **Architect first.** The new / modified invariant lands. Trace is updated.
2. **Inspector second.** Tests probing the invariant land. The test references the invariant; the trace records the test.
3. **Engineer third.** Code satisfying the tests lands. The code references the invariant via its scope.

After Architect merges, Inspector's branch rebases on the new integration HEAD. After Inspector merges, Engineer's branch rebases. The pipeline serialises at merge time even though the work parallelises during authoring.

## Module locks (Article 25)

Each task in a triplet acquires its own module locks. Locks are **not** held across triplet boundaries — Architect releases its locks at merge, Inspector acquires fresh locks, etc.

This means a non-triplet task running concurrently can still acquire locks on different modules. The triplet doesn't gridlock the orchestrator; it just sequences the merge order for the modules it touches.

## Worked example

**Scenario.** A new security requirement: "All endpoints that accept PII must log a redacted-only request body to the audit log."

### Architect task

1. Authors `INV-SECURITY-027` in `law/invariants/`: canonical statement, severity `must`, scope `apps/api/src/controllers/**`, `change_policy.requires_human_approval: true`, `measurable_via: [sense-api, sense-data-handling]`.
2. Updates `law/trace.json` to add the invariant.
3. Files an ADR at `meta/adr/ADR-SECURITY-AUDIT-LOG.md` documenting the design.
4. Emits checkpoint when invariant + trace settle.
5. Merges to integration.

### Inspector task (starts after Architect checkpoint, merges after Architect merge)

1. Authors `apps/api/test/security/audit-log.spec.ts` with assertions probing `INV-SECURITY-027`.
2. Tests reference `INV-SECURITY-027` via the test header's `invariants:` declaration.
3. Updates `law/trace.json` to add the test reference (joint Architect+Inspector edit at trace).
4. Emits checkpoint at task completion (mandatory).
5. Merges to integration.

### Engineer task (starts after Inspector checkpoint, merges after Inspector merge)

1. Implements the audit-log middleware in `apps/api/src/middleware/audit-log.ts`.
2. Wires the middleware into the controllers under scope.
3. Verifies tests pass + scorecard cell `F2 × T6` flips to PASS.
4. Merges to integration.

### Post-triplet

- Cycle C runs the full scorecard. `F1 × T6` (spec security coverage) reflects the new invariant; `F3 × T6` (test security coverage) reflects the new test; `F2 × T6` reflects the code.
- Auditor regeneration captures the new invariant in the rollup; backlog item closes.

## When NOT to use a triplet

- **Plant-bug-class failure.** Triage classified the failure as plant-bug. The fix is Engineer-only — code violates clear specification. No triplet needed; just an Engineer task.
- **Sensor-error-class failure.** Triage classified the failure as sensor-error. The fix is Inspector-only — the test was wrong. No triplet needed.
- **Reference-gap-class failure.** Triage classified the failure as reference-gap. The fix path is RGR ([Article 22](../reference/law.md)), not a triplet — the implementing discipline pauses and the spec discipline resolves.

Triplets are the pattern for **deliberate cross-substrate change**, not for failure remediation.

## See also

- [Constitution Articles 24-26](../reference/law.md) — binding text.
- [Loop](../theory/framework/loop.md) — how triplets interact with cycle stages.
- [Concurrency](../theory/framework/concurrency.md) — locks, worktrees, pipelined rebase mechanics.
