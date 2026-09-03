---
id: ADR-REL-0010
title: Finalize SPDX checksum and document semantics
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0009-complete-spdx-and-stored-deflate-byte-rules.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Package verification code inputs are lowercase raw-byte SHA1 values sorted lexicographically by checksum before concatenation and SHA1.
  - IA-002 -- File IDs and SHA1/SHA256 checksum strings are lowercase hex, and documentDescribes plus every named optional document property have the frozen value or absence.
---

# Finalize SPDX checksum and document semantics

## Status

Accepted as a narrow correction to ADR-REL-0009.

## Context

SPDX package verification codes sort checksums, not source-file order. A stable
document also needs explicit document-level optional fields and exact creator
syntax.

## Decision

The pack contract sorts lowercase raw-byte SHA1 checksum strings lexicographically
before deriving the package verification code. File IDs and all checksums use
lowercase hexadecimal. `documentDescribes` is explicit and comment,
external-document references, annotations, extracted licensing information,
reviews, snippets, and builds are absent. The sole creator is exactly
`Tool: devai.pure-npm-compatible-pack.v3`.

## Consequences

SPDX serialization no longer varies with entry order or serializer defaults.

## Alternatives Considered

**Use entry order for verification code inputs.** Rejected because it disagrees
with SPDX 2.3 semantics.

## Affected Rules

- Policy and schema canonical bytes/digest are repinned together.

## Inspector Adversarial Acceptance

Alter each sort, case, creator, and document field independently and verify
policy-schema rejection and golden digest mismatch.
