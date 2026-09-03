---
id: ADR-REL-0014
title: Repin offline receipt example digest
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0013-canonical-v3-artifact-projection-vocabulary.md
affected_rules:
  - law/schemas/release-offline-verification-receipt.schema.json
inspector_acceptance:
  - IA-001 -- The example receipt digest and ROV identifier recompute from its JCS projection after exactly excluding receipt_id and receipt_digest_sha256.
---

# Repin offline receipt example digest

## Status

Accepted as a narrow example-integrity correction.

## Context

The offline receipt contract defines a non-circular projection by excluding
`receipt_id` and `receipt_digest_sha256` before UTF-8 RFC 8785 JCS SHA-256.
The current example's stored digest and its ID prefix no longer matched that
projection after contract evolution.

## Decision

Repin the example digest and the identifier derived from its first sixteen
lowercase hexadecimal characters. The digest domain remains exactly the full
receipt object with those two fields omitted; it neither substitutes a default
nor recursively includes either derived field.

## Consequences

The example is independently reproducible. A direct fixture recomputes the
digest and verifies that changing either excluded field cannot change the
projection while changing a covered field does.

## Alternatives Considered

**Hash a receipt containing its own digest.** Rejected because it is circular
and does not define a stable content identity.

## Affected Rules

- Only the offline receipt example's derived identity fields are repinned.

## Inspector Adversarial Acceptance

Alter either excluded derived field and observe an unchanged projection digest;
alter a covered field and observe a changed digest.
