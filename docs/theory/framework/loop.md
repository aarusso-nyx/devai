---
title: Loop
sidebar_position: 6
---

# Loop

> The control loop regulates error from triage through gates through escalation. The loop has three cycle levels, four triage classes, an iteration cap with bump-model escalation, and a Reference Gap Report (RGR) as the only authorised upward semantic feedback path.

**Supported vs experimental (current Constitution).** In the supported harness,
every remediation dispatch, model evaluation, rebase, and re-queue described
below is **human-authorized**. An explicitly enabled experimental controller may
automate the bounded subset called out per section; experimental automation is
non-promoting, must preserve recoverable work, and never merges, publishes, or
destroys anything (Articles 1–3, 15–26). The exact Constitution version is
machine-bound to explicit evidence, so this mechanism page
does not freeze a second version claim.

## Loop entry: triage (Article 15)

Every failure that enters the framework is classified by the triage skill before a human authorizes remediation. No discipline begins feedback work until triage has classified the failure **and a human has selected or approved its route**; an experimental controller may perform the bounded dispatch only when its policy is explicitly enabled. Triage assigns each failure to exactly one of four classes:

| Class             | Meaning                                                        | Routes to                  |
| ----------------- | -------------------------------------------------------------- | -------------------------- |
| **plant-bug**     | Code violates clear specification.                             | Engineer                   |
| **sensor-error**  | Test, probe, or adapter is incorrect, stale, or misconfigured. | Inspector                  |
| **policy-issue**  | Harness policy or threshold is misconfigured.                  | Harness review             |
| **reference-gap** | Specification is silent, contradictory, or ambiguous.          | Architect or Owner via RGR |

This rule prevents the canonical failure mode where Engineer "fixes" a test failure by modifying the test (a sensor-error class problem treated as plant-bug class).

## Three cycle levels (Article 16)

| Cycle | Scope                       | Frequency                      | Gate set                                                     |
| ----- | --------------------------- | ------------------------------ | ------------------------------------------------------------ |
| **A** | Within-iteration checkpoint | Continuously during agent work | Affected-only hard gate (type-check, lint, unit tests)       |
| **B** | Pre-merge gate              | Once per merge attempt         | Full hard gate on task scope. Iteration cap applies.         |
| **C** | Post-merge integration      | Once per merge                 | Full scorecard including soft gates and Auditor regeneration |

A merge requires Cycle B clean; Cycle C runs immediately after.

## Iteration cap and bump-model escalation (Article 19)

A mutation-capable Cycle-B convergence attempt is bounded by policy and explicit human consent. **The supported default is one attempt**; a human may authorize a larger bounded value. Exhaustion blocks the task and returns control to the human.

**Experimental only:** when autonomous execution is explicitly enabled, its policy may authorize **three default-tier attempts plus one bumped-tier attempt** — the same task re-spawned at the next tier of model power, the bump counting as the fourth and final attempt. Failure after that attempt produces `experimental_blocked`; it never authorizes an automatic merge, a replacement task, or destructive cleanup.

**Cycle-A micro-iterations within a Cycle-B attempt do not count against the cap.** The cap exists to prevent agent thrashing, not to prevent work.

## RGR — Reference Gap Report (Article 22)

Any agent discipline (Engineer, Inspector, Auditor) may emit an RGR when:

- Triage classified a failure as reference-gap, or
- The discipline encounters a specification ambiguity it cannot resolve within its authority.

An RGR contains:

- The invariant or artifact under examination.
- The specific ambiguity.
- The impacted surfaces.
- The risk classification.
- Evidence gathered.
- An optional non-authoritative suggested resolution.
- Structured questions (each with a `qid` and optional candidate answers) so resolution is concrete rather than open-ended.

**RGR pauses the emitting task:** module locks released, branch preserved as `rgr/<task-id>`, worktree destroyed, backlog entry status changes to `rgr-pending`. The RGR routes as a high-priority backlog item to Architect or Owner.

When the spec update is merged to integration, the paused task becomes **eligible for human re-queue** with the RGR resolution as additional context. Experimental auto-resume requires explicit policy and must remain recoverable.

RGR is **the only authorized upward semantic feedback path** from implementation disciplines to specification disciplines. An Engineer that wants the spec changed cannot edit the spec directly (Article 9 authority chain forbids it); the only sanctioned route is RGR.

## Tie-breaker ladder (Article 23)

When soft-gate verdicts are REVIEW or when two disciplines disagree, the [tie-breaker ladder](./scorecard.md) resolves: cross-family model first, then larger same-family, then larger cross-family, then human. Concrete model families are F5 policy configuration, not doctrine; in the supported harness each model invocation is human-initiated.

## No automatic revert (Article 20)

Once work has been merged to the integration branch and the post-merge gate has passed, **that work is committed history**. The framework shall not roll back integration HEAD as part of any automated remediation.

Rework caused by rebase onto new integration HEAD is not a revert; it is normal pipeline behavior.

A human Architect may deliberately spawn a corrective task that performs a `git revert` of a specific merge. That is a human action, not framework automation.

## Escalation lifecycle (Article 21)

When a task escalates to human after iteration-cap exhaustion:

1. Backlog entry status changes to `escalated` with full failure context.
2. Task branch is preserved; an experimental controller may record the intended `escalated/<task-id>` name but shall not claim a rename it did not perform.
3. Module locks held by the task are released.
4. **Recoverable work and its worktree are preserved until explicit human disposition.** Disposable databases may be dropped only after their connection details and relevant evidence are retained.
5. Human is notified via the configured channel.
6. **The orchestrator does not spawn a replacement task.** Resolution awaits human action.

Human resolution paths: adopt the escalated branch in a human-owned worktree (not counted against the worktree cap); edit the specification to make the task feasible and re-queue; or cancel. Escalated branches are preserved indefinitely; pruning is a manual human-invoked operation.

## See also

- [Constitution Part V — Articles 15-23](../../reference/law.md) — the loop's binding text.
- [Scorecard](./scorecard.md) — gates + thresholds + tie-breaker ladder.
- [Concurrency](./concurrency.md) — coupled triplets, locks, checkpoints.
