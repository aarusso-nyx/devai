---
id: ADR-REL-0011
title: Finalize SPDX document vocabulary
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0010-finalize-spdx-checksum-semantics.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Package verification-code encoding and every named optional SPDX document property are fixed in the canonical pack specification.
---

# Finalize SPDX document vocabulary

## Status

Accepted as a narrow correction to ADR-REL-0010.

## Context

The prior contract fixed the verification-code inputs but did not explicitly
name its lowercase-hex output encoding. It also named optional SPDX properties
at the wrong document scope and included non-SPDX `reviews` and `builds`
properties.

## Decision

The package verification-code value is exactly
`lowercase-hex(SHA1(utf8-concatenation-of-each-file-raw-byte-SHA1-lowercase-hex-sorted-ascending-lexicographically-by-checksum-value))`.
`creationInfo.optionalFields=comment-licenseListVersion=absent` is explicit.
At document scope, `revieweds` is the SPDX 2.3 optional property; `reviews`
and `builds` are not claimed. The prior accepted ADRs remain historical bytes.

## Consequences

Independent implementations have one output encoding and one valid SPDX 2.3
document vocabulary, so the canonical pack-spec digest changes again.

## Alternatives Considered

**Leave unspecified serializer defaults.** Rejected because they permit
byte-different SBOMs and can claim properties absent from SPDX 2.3.

## Affected Rules

- Policy, schema constant, canonical example, and golden digest are repinned
  together.

## Inspector Adversarial Acceptance

Change the verification-code output encoding, move `licenseListVersion`, or
replace `revieweds` with `reviews` or `builds`; then verify the policy-schema
validation and golden digest checks fail.
