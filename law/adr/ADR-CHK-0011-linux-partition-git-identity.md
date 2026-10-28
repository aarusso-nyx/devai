---
id: ADR-CHK-0011
title: Bind Linux partition plans to the manifest Git version
type: adr
status: proposed
date: 2026-10-27
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-CHK-0002-toolchain-manifest.md
  - law/adr/ADR-CHK-0007-bounded-parallel-check-plan-execution.md
affected_rules:
  - .github/workflows/pull-request-checks.yml
  - scripts/check-workflows.mjs
  - scripts/aggregate-gate-partitions.mjs
  - scripts/process/summarize-check-report.mjs
  - scripts/process/ci-partition/integrated.mjs
  - scripts/process/ci-partition/verified-buffer.mjs
  - scripts/process/ci-partition/bounded-process.mjs
  - scripts/process/ci-partition/guards.mjs
  - scripts/process/ci-partition/git-signing-key.asc
  - tests/contract/ci-git-installer-inspector.contract.test.ts
  - tests/contract/aggregate-gate-partitions.contract.test.ts
  - tests/contract/pull-request-workflow.contract.test.ts
  - packages/sensors/tests/unit/alignment-partition-jobs.test.ts
  - docs/dev/operations/remote-preflight-contract.md
  - docs/dev/operations/workflows/pull-request-checks.md
inspector_acceptance:
  - IA-001 -- Both Linux partition jobs execute the actual manifest Git version before planning and refuse missing, wrong, substituted, or shadowed installations without fallback.
  - IA-002 -- Partition aggregation retains all candidate, base, plan, policy digest, node ownership and PASS checks; an actual Git version mismatch remains a refusal.
  - IA-003 -- Acquisition refuses altered source and fails closed when the developer signature or the reviewed, independently corroborated signing-key binding is unavailable or invalid.
  - IA-005 -- A hosted Linux trial records toolchain dependencies and end-to-end duration while cancellation, timeout, failed checks and missing reports remain failures.
  - IA-006 -- The workflow checker and tests verify finite Linux partition and native APFS job timeouts without modifying per-task timeout, test assertions or aggregate verdict rules.
---

# Linux partition Git identity

## Status

Proposed. This record grants no workflow or publication authority. Implementation and independent acceptance remain outstanding.

## Context

On run 40569422192, the two Linux partitions observed Git 2.55.0 and 2.56.0. The existing preflight checked Git major while the runner bound the complete observed version into task keys; two Git-dependent task keys and the task-policy digest consequently differed. The aggregate also reported a separate failed CLI test. Passing preflight does not establish identical plan inputs or explain that failure.

## Decision

Before either Linux partition plans or runs affected checks, provision and verify the exact Git version declared by the materialized toolchain manifest. The current version is 2.47.3. A separately reviewed source binding must match that manifest and include an immutable source digest and a developer signing-key fingerprint corroborated against independent publisher information and reviewed under normal repository governance. Verify the source and signature before extraction or execution. Reject a mismatched manifest, uncorroborated key binding, invalid signature, acquisition or installation failure, incorrect version, and path shadowing. Never substitute a system Git on failure. Check exact candidate and base after installation. Do not hand-edit generated configuration.

Preserve the runner's full actual version observation and the aggregate's existing equality, ownership, and outcome requirements. A source digest does not prove identical binaries or an authenticated publisher; the reviewed fingerprint binding and actual hosted compatibility must be established from evidence. The observed signature is cryptographically valid against the Git project key and the primary fingerprint and signing subkey ID are corroborated by the kernel.org web-of-trust page; the local keyring reports undefined trust, and the old web-of-trust page does not establish current key validity or revocation status. The native APFS job remains outside the Linux pin.

Preserve existing failure diagnostics, report handling and aggregate semantics; this decision does not redesign those surfaces. Do not alter existing tests or assertions to accommodate this decision.

## Consequences

Provisioning adds cold-start work and depends on the verified source and signing-key binding. Qualification requires hosted evidence; the proposed budget is not proof of a passing partition.

## Alternatives Considered

Accepting different Git versions would leave partition plans with mismatched inputs. Falling back to the system Git would obscure a failed or substituted installation. Neither satisfies the identity requirement.

## Affected Rules

The affected paths are listed in the `affected_rules` front matter.

## Partition job budget proposed

In PR #439 run 40591180064 attempt 1, the CLI job was cancelled after 20 minutes 14 seconds; its affected step logged an executed PASS for `test:cli` after 1,121,936 ms, while the aggregate failed on the cancelled job. This timing is consistent with the existing 20-minute job budget, but the cancellation actor is not established. The job verdict is not PASS. A cold provisioner adds work whose hosted duration is not yet measured.

Propose a finite 30-minute job timeout for each Linux partition when the source-pinned Git provisioner is integrated. Keep the aggregate timeout unchanged. This is a preliminary operational budget, not a measured completion guarantee: qualify it on representative hosted cold runs and revise before integration if evidence requires. Keep the runner's existing individual task timeout, all tests, ownership and report checks unchanged. A cancelled or timed-out partition and a missing report remain failures. The workflow checker and Inspector tests must enforce these bounds and safeguards.

## Native job budget proposed

Propose changing the hosted `native-apfs` job timeout from 15 to 30 minutes. This is a finite, unverified operational budget, not evidence that the native qualification completes or passes. Qualify it using representative hosted runs and record the full job outcome and duration. A timeout, cancellation, failed qualification, skipped job or missing required result continues to block the required gate. Preserve the native test population, assertions, per-case ceiling, report requirements and aggregate verdict rules. The separate local RC timeout is unchanged. The workflow checker and Inspector tests must enforce the proposed job timeout and existing safeguards without relaxing tests.

The current workflow remains at 15 minutes until an independently reviewed workflow change is authorized and implemented. This proposal itself grants no authority to change the workflow or publish it.

## Inspector Adversarial Acceptance

Inspector acceptance requires adversarial acquisition, path, signature and aggregation tests and a hosted Linux build with measured duration, dependencies, exact tool identity and full partition outcomes. Measure the proposed 30-minute job budget on hosted cold runs and retain all checks; this record alone does not prove it is sufficient. The original CLI failure needs its own evidence and repair, not a claim that the identity correction fixes it.

Evaluate each workflow-changing commit against the forbidden-action scanner, including the active ADR path-coverage exception. Where an Owner receipt is required, bind it to the exact commit; review and receipt are separate from the workflow change. DEVAI AGENTS.md reserves source publication, push, merge and pull requests to appropriately authorized orchestrator operations; this record authorizes none of them.
