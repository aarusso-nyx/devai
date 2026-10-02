---
id: ADR-REL-0034
title: Cancellable read-only Pages preparation precedes serialized publication
type: adr
status: accepted
date: 2026-10-02
authority: Architect
supersedes:
  - ADR-REL-0030
provenance:
  - ADR-REL-0030
  - docs/dev/operations/open-issue-closure-campaign/execution-discipline.md
  - docs/dev/operations/open-issue-closure-campaign/ci-invariant-contract.md
affected_rules:
  - .github/workflows/site-publish.yml
  - scripts/check-workflows.mjs
  - scripts/process/verify-site-preparation-artifact.mjs
  - law/policy/credential-requirements.json
  - docs/dev/operations/release-discipline.md
  - docs/dev/operations/workflows/site-publish.md
  - packages/sensors/src/harness-coherence.ts
  - packages/sensors/src/harness/workflow-parser.ts
  - packages/sensors/src/ci-invariant-gate.ts
inspector_acceptance:
  - IA-001 -- A non-main manual dispatch or any added dispatch input refuses; preparation has no environment, journal/provider call or write permission.
  - IA-002 -- Preparation ref groups cancel superseded preparation only; publishing uses the shared case-insensitive devai-pages-publication group withcancel-in-progress false.
  - IA-003 -- Top-level cancellation or incomplete job-effect coverage, aliases, bypass predicates, unknown effects and reusable/local-call ambiguity remain findings.
  - IA-004 -- Wrong run/artifact/source/tree/digest/member population, unsafe archive entries, duplicate paths or hidden/symlink/special members refuse before extraction.
  - IA-005 -- Publishing consumes the exact successful preparation without rebuilding; a cancelled/failed/skipped preparation never invokes publication.
  - IA-006 -- Known same-run submission resumes only its original artifact and Pages deploymentID; ambiguous intent or unknown cross-run predecessor refuses without duplicate publication.
  - IA-007 -- Manual cancellation, timeout or runnerloss cannot establish new verification; independently persisted verified evidence from before interruption remains valid. Changed retry population cannot replace the original deployment identity.
  - IA-008 -- All release approval/environment/credential safeguards and release-mode baseline/other-mode unresolved-journal refusals remain unchanged.
---

# Cancellable read-only Pages preparation precedes serialized publication

## Status

Accepted source decision under CMP0006-OD-EXEC-20261002 and standing Owner autoaccept, following distinct exact Architect review. No implementation, live evaluation, signing, trust setting, publication or deployment is reported. The accepted predecessor stays byte-exact.

## Context

Issue234 reports a harness finding despite the existing Pages noncancellable shared group. Cancelling publishing is unsafe while an intent/deployment may be unresolved. Safe cancellation is limited to read-only preparation before publishing intent.

## Decision

Only ADR-REL-0030 single publish-site job/build placement clause changes. Every other approval, credential, environment, main/manual trigger and journal clause remains binding. All ADR-REL-0029 publication/journal/same-release-baseline clauses remain.

Two jobs separate cancellable read-only prepare-site from noncancellable publish-site. Preparation checks out the exact dispatched source without persisted credentials, performs the existing build/security/type/local-byte/upload sequence with the docs/site lockfile and contents:read only, and emits exact source/tree/run/artifact/population identities. Publication depends on preparation success, binds the same-run artifact and current dispatched identity, performs complete bounded archive validation before extraction, uses the original siteMembers hashing semantics and never rebuilds.

The original siteMembers population hash is SHA256 over UTF8 JSON.stringify(siteMembers(dir)); existing empty.nojekyll is excluded, other dot/special/unsafe entries refuse. Preparation returns numeric immutable artifactID, not latest/name lookup. Retried submissions retain originalartifact/PagesID and journal identity; unknown cross-run reconciliation is not introduced. Job publication lock is devai-pages-publication withcancel-in-progress false shared withrelease.yml, and preparation uses a separate exact ref-scoped cancellable group. Group aliasing is checked case-insensitively. Remove workflow-level concurrency only when the complete per-job effect/call graph proves safe coverage. Pending publisher replacement is possible before intent and cannot promise every queued request deploys. All post-intent unknown/submitted/verified refusal/reconciliation behavior remains.

Generic harness coherence derives actual effects, permissions, environments and local/reusable calls per job; no workflow filename exception or not-applicable waiver is admitted. Complete archive entry validation must precede any extraction and preserve bounded input/expanded/member limits. The .mjs archive helper is an I/O wrapper; deterministic validation belongs to a typed operation in the already owned packages/sensors/src/ci-invariant-gate.ts, preserving the approved public CLI action set. Archives produced by the pinned upload action must be covered by complete ordinary-file/directory and approved metadata fixtures before adoption; unknown extension/link/special/path semantics refuse. Manual cancellation/timeouts/runnerloss retain the original fail-closed journal behavior.

The credential matrix documents both exact jobs: preparation has no environment and onlycontents:read; publish-site keepsgithub-pages and the complete existing contents:read/pages:write/deployments:write/id-token:write set. GITHUB_TOKEN rows and workflow checker docs pins reflect this placement without expanding permissions or changing protections.

## Consequences

This makes the declared producer/validator boundary reviewable and testable. Missing observations or custody remain explicit refusals. Source checks establish only their declared source result; final candidate and actual effect gates remain mandatory.

## Alternatives Considered

Blanket exceptions, inferred successful observations, candidate-selected trust and weakening existing assertions or permissions are rejected. Reusing independent exact content-addressed evidence is permitted only when every bound input matches.

## Affected Rules

- .github/workflows/site-publish.yml
- scripts/check-workflows.mjs
- scripts/process/verify-site-preparation-artifact.mjs
- law/policy/credential-requirements.json
- docs/dev/operations/release-discipline.md
- docs/dev/operations/workflows/site-publish.md
- packages/sensors/src/harness-coherence.ts
- packages/sensors/src/harness/workflow-parser.ts
- packages/sensors/src/ci-invariant-gate.ts

## Inspector Adversarial Acceptance

- IA-001 -- A non-main manual dispatch or any added dispatch input refuses; preparation has no environment, journal/provider call or write permission.
- IA-002 -- Preparation ref groups cancel superseded preparation only; publishing uses the shared case-insensitive devai-pages-publication group withcancel-in-progress false.
- IA-003 -- Top-level cancellation or incomplete job-effect coverage, aliases, bypass predicates, unknown effects and reusable/local-call ambiguity remain findings.
- IA-004 -- Wrong run/artifact/source/tree/digest/member population, unsafe archive entries, duplicate paths or hidden/symlink/special members refuse before extraction.
- IA-005 -- Publishing consumes the exact successful preparation without rebuilding; a cancelled/failed/skipped preparation never invokes publication.
- IA-006 -- Known same-run submission resumes only its original artifact and Pages deploymentID; ambiguous intent or unknown cross-run predecessor refuses without duplicate publication.
- IA-007 -- Manual cancellation, timeout or runnerloss cannot establish new verification; independently persisted verified evidence from before interruption remains valid. Changed retry population cannot replace the original deployment identity.
- IA-008 -- All release approval/environment/credential safeguards and release-mode baseline/other-mode unresolved-journal refusals remain unchanged.
