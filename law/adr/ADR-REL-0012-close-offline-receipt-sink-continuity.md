---
id: ADR-REL-0012
title: Close offline receipt ArtifactSink continuity
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0007-pure-sink-mediated-release-prepare.md
  - law/adr/ADR-REL-0011-finalize-spdx-document-vocabulary.md
affected_rules:
  - law/schemas/release-offline-verification-receipt.schema.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- A current receipt requires one exact ArtifactSink transaction and committed-manifest identity plus a complete opaque aggregate and per-package artifact closure.
  - IA-002 -- Pathname artifacts remain valid only for legacy read-only receipt versions and are rejected by the current receipt branch.
---

# Close offline receipt ArtifactSink continuity

## Status

Accepted as a forward correction to the v3 prepare contract.

## Context

The lifecycle state schema already requires v2.1 prepared and exported states
to use opaque ArtifactSink handles plus one committed-manifest transaction
identity. The offline-verification receipt still required pathname references,
which made a valid current exported state impossible to verify and therefore
impossible to use as evidence-publish input.

## Decision

Receipt versions 1.0 and 2.0 preserve pathname artifact references solely for
read-only legacy observation. Current version 2.1 requires aggregate and
per-package artifacts in the closed opaque form
`kind,sink_id,opaque_handle,sha256,size_bytes`, together with the exact
`artifact_sink_commit` identity: sink, transaction, committed-manifest handle,
digest, size, and two-phase protocol.

The external offline verifier resolves every handle through the trusted sink,
rehashes bytes, digest, and size, and requires one identical complete aggregate
and per-package set, exported-state/release-unit identity, committed sink
identity, and external trust input. Evidence publication repeats that exact
comparison before remote dispatch. Schema validity alone never establishes
those cross-document equalities.

## Consequences

Current prepared/exported state can yield a valid offline receipt without
reintroducing a pathname sink. Missing or pathname-mixed current receipts fail
closed. Existing historical receipt bytes remain readable but cannot be used to
claim current v2.1 continuity.

## Alternatives Considered

**Return to pathname receipts for current states.** Rejected because it widens
the artifact authority boundary and contradicts the v3 sink-mediated contract.

**Infer the sink commit from individual handles.** Rejected because a complete
atomic transaction identity must be explicit and independently checkable.

## Affected Rules

- The offline receipt schema receives a version-bound opaque form and direct
  positive and negative fixtures.
- Lifecycle policy pins external sink rehashing and evidence-publish continuity.

## Inspector Adversarial Acceptance

Substitute a pathname artifact, remove the sink commit, alter an opaque handle,
or omit one package artifact. Verify the schema or semantic verifier refuses
before evidence publication can dispatch.
