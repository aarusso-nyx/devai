---
id: ADR-REL-0016
title: Bind protected preflight to execution-only host authority
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (authority by path and declared host boundaries)
  - law/constitution.md Article 10 (authority separation)
  - law/constitution.md Article 41 (exact evidence identity)
  - law/adr/ADR-REL-0015-close-certification-provenance-and-sink-ambiguity.md
affected_rules:
  - law/policy/action-registry.json
  - law/schemas/action-registry.schema.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Protected preflight requires Inspector initiation, write consent, an exact valid plan, and an opaque action-bound execution capability; missing or mismatched helper, stage, task selection, candidate, or toolchain refuses without ambient fallback.
  - IA-002 -- Preflight and certification use the same immutable execution toolchain and candidate, while their task subsets remain separately selected and bound; a replayed, cross-action, or substituted capability refuses.
  - IA-003 -- Preflight cannot invoke certification evidence or artifact sinks, produce certification manifests or generated-output receipts, advance certified state, prepare, export, verify offline, or publish.
  - IA-004 -- Exact registry and lifecycle policy constants reject broadened capability, selector, adapter, role, consent, or projection fields; no generic process, container, remote, or filesystem-cache admission substitutes for the protected boundary.
---

# Bind protected preflight to execution-only host authority

## Status

Accepted as a narrow forward extension of preflight execution authority. The
nine-state lifecycle, state and receipt formats, certification requirements,
pure prepare boundary, and separate publication authorization are unchanged.
Historical accepted ADR bytes remain unchanged.

## Context

Protected certification already executes immutable tasks outside candidate
authority. Running its prerequisite preflight through a different ambient
toolchain would not establish the required matching execution identity. The
preflight action's filesystem and Git permissions do not authorize invoking an
isolated task executor, and a container command must not be disguised as a
filesystem-cache mutation.

## Decision

`release preflight` gains only the execution capability
`protected-certification-provider-v3:execute` and the corresponding
`protected-certification-provider` target kind and
`protected-certification-provider-v3` boundary adapter. Its existing filesystem
and Git capabilities, Inspector initiation, write consent, bounded planner,
final re-verification, and `harness-write` ceiling are preserved. The registry
schema fixes the complete preflight authority contract rather than accepting
an arbitrary capability or adapter superset.

The same host-owned helper is used for preflight and certification, but its
opaque invocation capability binds the exact action and stage. Preflight runs
only the preflight subset derived from the exact immutable task policy and
bound plan. Helper identity covers that stage's selected task identities,
argv, cwd, executable digests, plan, toolchain, container image, platform and
dependencies. Both stages use the same immutable execution toolchain and
candidate; this does not mean their task subsets or helper identity digests
are interchangeable. The binding additionally names the repository and
candidate commit/tree, plan receipt digest and task-policy digest. The
host-owned capability is single-use and bound to the live invocation; the
candidate cannot choose helper code, isolation profile, toolchain or ambient
environment.

The generic authority implementation may represent this exact named boundary
as the fixed semantic remote target
`devai-protected-certification-provider-v3` / `host` / `execute`, with
`publication: false` and adapter `protected-certification-provider-v3`.
This is an internal representation, not network or publication permission.
Selector materialization, preparation, application and final re-verification
must enforce the same mapping and full opaque binding. A target id alone,
caller-authored remote target, generic process or Docker argv allowance, or
filesystem-cache selector cannot grant this capability.

Preflight tasks have no certification-evidence, artifact-sink, signing,
control-store or publication capabilities. Bounded results are captured in
host-owned proofs, and descendant quiescence must be proved before acceptance.
Only the lifecycle core can verify those results and append the existing
`preflight_passed` state. Preflight cannot produce a certification manifest or
generated-output receipt, promote `certified`, prepare, export, verify offline,
or publish. The certification evidence sink remains exclusive to the
separately authorized certification action. Provider absence or any identity
mismatch refuses before task execution or a success-state append; built-in
preflight orchestration has no ambient or unprotected execution fallback.

The exact rules are materialized in lifecycle policy version `2.6.0` and its
schema. This decision authorizes a boundary implementation, not a readiness
claim: the isolated executor and installed-package path still need independent
positive and adversarial verification. The trust claim remains trusted local
execution, not independent attestation.

## Consequences

Engineer regenerates the package-owned action views with
`node scripts/generate-action-registry.mjs`, then checks them with the same
command's `--check` option. Generated CLI and effects catalog changes are
mechanical consequences of the law source; they must not be hand-maintained.
Inspector verifies capability replay, cross-stage substitution, denied sink
access, missing isolation, descendant lifetime and stale-policy refusal.

## Alternatives Considered

**Admit Docker as a filesystem-cache effect.** Rejected because filesystem
write scope does not authorize task-executor invocation.

**Grant preflight the full certification provider and sink interface.**
Rejected because preflight establishes prerequisite evidence, not certified
package output or publication authority.

## Affected Rules

- The action registry and its schema add and close only protected preflight
  execution authority; certification and other action contracts are unchanged.
- The lifecycle policy and schema bind stage selection, exact identity,
  isolation, source mapping and the non-promoting result boundary.

## Inspector Adversarial Acceptance

Require positive execution with the matching immutable toolchain and selected
preflight tasks. Refuse missing helpers, altered stage/task subset/image or
dependencies, cross-action capabilities, reused invocation tokens, ambient
fallback, generic executor targets and every sink or publication attempt.
Require failure when children remain writable after the main process exits;
do not treat a timeout or infrastructure failure as a passing observation.
