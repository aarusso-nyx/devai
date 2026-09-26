---
id: ADR-CHK-0001
title: Execute preflight probes as task DAG nodes with a blocked outcome
type: adr
status: accepted
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - docs/dev/operations/remote-preflight-contract.md
  - scripts/process/release-prerequisites.mjs
  - packages/cli/src/services/check-runner/runner.ts
  - .github/workflows/pull-request-checks.yml
affected_rules:
  - law/schemas/preflight-probe.schema.json
  - law/schemas/test-task-descriptor.schema.json
  - test-tasks.json
  - packages/cli/src/services/check-runner/types.ts
  - packages/cli/src/services/check-runner/runner.ts
  - packages/cli/src/services/check-runner/cache.ts
  - .github/workflows/pull-request-checks.yml
  - scripts/run-pr-release-gate.mjs
  - docs/adopters/test-tasks.md
  - AGENTS.md
inspector_acceptance:
  - IA-001 -- An extrinsic probe failure yields BLOCKED for the probe and blocked-environment for every dependent, and no FAIL result is written to the cache.
  - IA-002 -- A BLOCKED result is never reusable on a later plan even when the task key is unchanged.
  - IA-003 -- The probe descriptor run locally and the one run in the pull-request lane produce byte-identical planned node sets for the same base and candidate.
  - IA-004 -- A probe that redacts its observed value cannot leak the raw value through the failure diagnostics path.
---

# Preflight probes as DAG nodes

## Status

Accepted on 2026-09-26 by maintainer decision. Adds a runner kind and an outcome value, so the task-policy digest
changes and the RC attestation must be re-issued for the adopting candidate.

## Context

The pull-request lane is already a probe chain expressed in workflow YAML:
install, verifier package, bootstrap, product, each with continue-on-error
and a final aggregator. The release prerequisites script expresses the same
idea with pass, blocked, and fail statuses and dependency blocking. The check
runner refuses RC execution without the database flag. But the shape lives in
three places, and an environment failure inside a task surfaces as FAIL, is
cached as FAIL, and is indistinguishable from a real observation. Ten of the
last sixty commits are release fixes for drifting pins and environment.

## Decision

Law declares a preflight probe schema: identity, class (`extrinsic` or
`intrinsic`), probe kind (`environment`, `file`, `command`, `git`,
`registry`, `toolchain`, `credential`), expected value, redacted observed
value, status, remediation text, and dependencies. Probes are nodes in the
task descriptor under a new `preflight-v1` runner kind, selected
unconditionally for every target, so they execute identically locally and in
the pull-request lane from the same descriptor.

The task outcome set gains `BLOCKED`. An extrinsic probe failure yields
`BLOCKED`, dependents are marked blocked-environment and not executed, and
nothing blocked is written as a reusable result. An intrinsic probe failure
yields `FAIL` as today. The pull-request workflow reduces to install, check
with the preflight target, and check with the affected target; the step-level
aggregator moves into the runner report. The local invocation against a
freshly fetched base is the "ready for a pull request" command and is
required by the agent contract before opening a pull request.

## Consequences

A red test means a real observation. Environment drift reports the probe
that caught it and its remediation, in seconds, before any expensive node.
The cache gains one outcome that is never reusable. Flaky tests are neither
class; they receive no automatic retry and are recorded to the backlog under
ADR-GOV-0019. The credential and toolchain manifests under ADR-SEC-0001 and
ADR-CHK-0002 are the inputs of the `credential` and `toolchain` probe kinds.

## Alternatives Considered

A separate stage before the DAG is rejected because it would leave the
task-policy digest untouched at the cost of two execution paths that can
diverge. Keeping probes in workflow YAML is rejected because adopters cannot
run YAML locally. Automatic retry for flaky nodes is rejected because a retry
hides a defect instead of recording it.

## Affected Rules

A new probe schema, the descriptor schema and descriptor, the runner types,
runner, and cache, the pull-request workflow, the gate script, the adopter
descriptor documentation, and the agent contract.

## Inspector Adversarial Acceptance

Point the registry probe at an unreachable host and confirm `BLOCKED` with
blocked-environment dependents and no cached FAIL. Re-plan with the same
inputs and confirm the probe executes again. Diff the planned node sets from
a local run and the lane run for the same commits. Inject a secret-shaped
observed value into a failing probe and confirm the diagnostics output is
redacted. Confirm a failing lint node still yields `FAIL` and is cached as
such.
