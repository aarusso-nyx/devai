---
id: ADR-REL-0013
title: Canonical v3 artifact projection vocabulary
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0012-close-offline-receipt-sink-continuity.md
affected_rules:
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Every current state artifact has exactly one matching current receipt projection with the same kind, sink, handle, digest, and size.
  - IA-002 -- A package or evidence manifest cannot be relabelled as another current artifact kind.
---

# Canonical v3 artifact projection vocabulary

## Status

Accepted as a forward correction to ADR-REL-0012.

## Context

The v3 lifecycle state used generic `manifest` and `sbom` package labels while
the v2.1 receipt introduced `evidence-manifest`. That allowed two different
meanings for an otherwise identical opaque-handle projection and prevented a
one-to-one state-to-receipt closure.

## Decision

Current v3 package evidence has the exact fields and kinds
`package_manifest`/`package-manifest`, `package_tarball`/`package-tarball`,
`package_sbom`/`package-sbom`, `evidence_manifest`/`evidence-manifest`, and
`provider_result`/`provider-result`. A current aggregate artifact uses the
same kind vocabulary. The external semantic kernel must require a sorted,
duplicate-free, one-to-one equality projection by
`kind,sink_id,opaque_handle,sha256,size_bytes` between exported state,
per-package evidence, offline receipt, and evidence-publish input.

`manifest`, `tarball`, `sbom`, and other former generic labels remain only in
the version-bound legacy state and receipt branches.

## Consequences

Current preparation, export, offline verification, and evidence publication
share one unambiguous vocabulary. A mislabelled handle, duplicate, omission,
or substituted projection fails closed before a remote effect.

## Alternatives Considered

**Infer a manifest's meaning from its caller or path.** Rejected because an
opaque handle deliberately has no pathname authority and caller context cannot
prove a stable cross-document projection.

## Affected Rules

- State and receipt schemas use matching current v3 opaque references and
  field-kind constraints.
- Policy pins the canonical package artifact roster and projection equality.

## Inspector Adversarial Acceptance

Construct a valid current exported state and receipt projection, then mutate
each kind, field, handle, duplicate, and omission independently. The schemas
or semantic projection kernel must reject every mutation.
