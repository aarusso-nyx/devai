---
id: ADR-REL-0009
title: Complete SPDX and stored DEFLATE byte rules
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0008-handle-based-prepared-state-and-complete-pack-spec.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
inspector_acceptance:
  - IA-001 -- The v3 canonical specification hash is exact and fixes a valid SPDX 2.3 package, every file and relationship, and all optional-field absence/defaults.
  - IA-002 -- Stored DEFLATE uses exactly consecutive 65535-byte blocks plus a final remainder, with BFINAL only on that last block and one final zero-length block for an empty stream.
  - IA-003 -- Altering SPDX package identity, package verification code rule, file identifier/checksum, optional-field rule, DEFLATE block rule, BFINAL rule, or canonical digest refuses.
---

# Complete SPDX and stored DEFLATE byte rules

## Status

Accepted as a narrow forward correction to ADR-REL-0008. It does not alter the
opaque ArtifactSink, receipt, or state-identity decisions.

## Context

The prior pack specification named stored DEFLATE but permitted multiple legal
block partitions. Its SPDX line also did not completely define a valid package
element, leaving libraries free to select package fields and optional defaults.
Either freedom can change a release byte stream.

## Decision

The frozen v3 pack specification replaces the maximum-only DEFLATE rule with
the exact greedy 65,535-byte partition, final-block flag rule, and empty-stream
encoding. It fully defines the SPDX 2.3 document, package, file, checksum,
verification-code, relationship, and optional-field behavior. The state schema
metadata version advances to 2.1.0 to match the handle-era state contract.

## Consequences

Independent implementations now have one valid gzip block sequence and one
valid SPDX package element for a given certified manifest. A package or file
library default cannot silently introduce a release difference.

## Alternatives Considered

**Allow any valid stored-block partition.** Rejected because valid output would
not be byte-identical.

**Leave package fields to an SPDX serializer.** Rejected because serializers
may emit valid but different optional defaults and identifiers.

## Affected Rules

- `law/policy/release-lifecycle.json` pins the v3 canonical bytes and digest.
- `law/schemas/release-lifecycle-policy.schema.json` pins policy and canonical
  example values.
- `law/schemas/release-lifecycle-state.schema.json` correctly reports 2.1.0
  metadata for the forward handle-state schema.

## Inspector Adversarial Acceptance

The Inspector mutates every byte-rule named in the frontmatter, including a
65,536-byte boundary and empty stream, and proves both the policy schema and
golden digest refuse the altered contract.
