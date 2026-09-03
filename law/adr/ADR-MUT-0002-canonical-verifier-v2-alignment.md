---
id: ADR-MUT-0002
title: Canonical verifier owns mutation v2 composition
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-MUT-0001
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-MUT-0001-mutation-assurance-v2.md
  - canonical devai-verifier commit fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1
affected_rules:
  - law/policy/mutation-assurance-v2.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- The divergent DEVAI assurance-v2 policy is read-compatible only and cannot authorize a new release mutation verdict.
  - IA-002 -- The next executable DEVAI mutation contract is byte- and semantic-compatible with canonical verifier `mutation-report-set-v2` and `mutation-composed-report-set-v2` before vendoring.
  - IA-003 -- Candidate/baseline/semantic-rebind envelopes, per-package Stryker report/result references, evidenceRef/evidenceSetDigest, and all raw status semantics are preserved.
  - IA-004 -- Stryker `CompileError` and `Ignored` remain non-scored statuses, never infrastructure failures; no outcome normalization silently changes that meaning.
---

# ADR-MUT-0002 — Canonical verifier owns mutation v2 composition

## Status

Accepted. This forward ADR supersedes ADR-MUT-0001 for future executable
mutation-contract authority and preserves its bytes for read compatibility.

## Context

Canonical verifier commit `fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1`
implements `mutation-report-set-v2` and `mutation-composed-report-set-v2` over
per-package Stryker report and result artifacts. DEVAI's independently drafted
`mutation-assurance-v2` has a different artifact population and normalizes
outcomes differently. Treating both as active v2 would create incompatible
evidence and make source-first verifier vendoring impossible.

## Decision

The canonical verifier is the sole source of executable mutation-v2
composition. DEVAI's divergent assurance-v2 policy is deprecated read-only and
blocks new release use until DEVAI adopts the verifier's exact report-set and
composed-report-set contract. The migration must preserve candidate, baseline,
and semantic-rebind envelopes; package evidence references and evidence-set
digests; and the complete raw Stryker status vocabulary. `CompileError` and
`Ignored` are non-scored statuses, not infrastructure failures.

No verifier vendoring, runtime adapter, or release may claim mutation-v2
contract freeze until the shared schema and kernel have been independently
verified against the immutable verifier source.

## Consequences

This deliberately blocks mutation-v2 release execution before it creates a
second incompatible evidence format. Existing assurance records remain
readable but cannot gain new release authority. The subsequent implementation
is a source-first, byte- and semantic-equivalence adoption task.

## Alternatives Considered

**Normalize verifier statuses into the DEVAI assurance model.** Rejected:
`CompileError` and `Ignored` would acquire an incorrect infrastructure meaning.

**Patch the canonical verifier after DEVAI implementation.** Rejected: it
reverses source-first authority and invalidates already collected STYNX
evidence.

**Keep both v2 contracts active.** Rejected: a version label cannot establish
interoperability.

## Affected Rules

- `law/policy/mutation-assurance-v2.json`: read-compatible blocked status and
  pinned successor contract.
- `law/schemas/mutation-assurance-policy-v2.schema.json`: closed successor
  contract declaration.

## Inspector Adversarial Acceptance

- IA-001 -- A new release path consuming the divergent assurance-v2 policy is
  refused.
- IA-002 -- The adoption fixture rejects omitted package Stryker artifacts,
  altered evidence references or evidence-set digest, candidate/baseline/rebind
  mismatch, unknown status, and changed non-scored status treatment.
