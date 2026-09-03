---
id: ADR-MUT-0005
title: Unambiguous mutation digest and verification boundaries
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-MUT-0004
provenance:
  - law/adr/ADR-MUT-0004-complete-verifiable-mutation-evidence-v2.md
  - devai-verifier source commit fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
  - law/schemas/mutation-report-set-v2.schema.json
inspector_acceptance:
  - IA-001 -- Certify recomputes source-derived populations and selection rules; offline verification does not claim access to absent members.
  - IA-002 -- Every named mutation-v2 digest has one exact domain framing payload order and canonical-byte rule.
  - IA-003 -- Input identity is equal across output contract package result evidence reference composition and semantic receipt.
  - IA-004 -- A missing required binding reports MUTATION_INPUT_IDENTITY_MISSING before digest comparison; a present divergent identity reports MUTATION_INPUT_DIGEST_MISMATCH.
---

# Unambiguous mutation digest and verification boundaries

## Status

Accepted as a narrow forward clarification of ADR-MUT-0004. The underlying
mutation-v2 architecture and schema version remain unchanged.

## Context

ADR-MUT-0004 closed the substantive evidence, threshold, provenance, and
offline-verification gaps. Independent fixture design exposed four remaining
places where two conforming implementations could make different choices.

Its semantic algorithm did not assign source-derived population recomputation
to one lifecycle phase. Several digests were described only as canonical
SHA-256 values without a unique domain, framing, and payload order. One policy
summary still named only three of the five locations that carry `inputDigest`.
Finally, the error roster did not say whether an absent binding was a missing
identity or a digest mismatch.

## Decision

Certify is the only phase that recomputes source-derived population and
selection-rule digests, because it has the selected members, release plan,
profile, candidate, and protected controls. It emits the semantic receipt that
proves that derivation. Offline verification embeds no invented population
provider: it recomputes `inputDigest` from the complete input projection in the
output contract, checks five-way identity equality, and trusts source derivation
only through the valid signed semantic receipt and its exact closure.

Every domain-separated digest uses this byte sequence:

`UTF8(domain) || 0x00 || U64BE(payloadByteLength) || payloadBytes`

JSON payload bytes are RFC 8785 JCS UTF-8. The policy names the exact domain and
payload for `outputContractDigest`, `packageResultSetDigest`,
`compositionEntryDigest`, `evidenceRefDigest`, `inputDigest`,
`evidenceSetDigest`, and `semanticReceiptDigest`. The package-result-set payload
is the output-contract-ordered array of `packageName` and `resultDigest` pairs.
The semantic-receipt payload omits only its `receiptDigest` member. Raw canonical
report and package-result artifact digests are SHA-256 of their exact RFC 8785
JCS UTF-8 document bytes with no domain prefix or framing. No generic
"canonical SHA-256" alias is permitted.

One `inputDigest` must match across the required output-contract entry, package
result, evidence reference, composition entry, and semantic-receipt package
entry. A missing required binding is detected before digest computation and
returns `MUTATION_INPUT_IDENTITY_MISSING`. Once the complete binding set exists,
any identity or digest divergence returns `MUTATION_INPUT_DIGEST_MISMATCH`.

## Consequences

Certify and offline verification now have non-overlapping, implementable trust
boundaries. Offline verification remains portable and fails closed without
pretending that source members are present.

Equivalent payloads in different mutation documents cannot collide through
domain confusion. Implementations can share one framing primitive while tests
assert each exact domain and payload order.

Failure reporting is deterministic. Callers can distinguish incomplete input
capture from substitution or divergence without relying on incidental check
order.

## Alternatives Considered

**Recompute source populations offline.** Rejected because the selected source
members and selection providers are intentionally absent from the portable
bundle model.

**Use raw SHA-256 for every JSON value.** Rejected because it permits cross-kind
digest ambiguity and leaves ordered-set payloads underspecified.

**Collapse missing and mismatched identity into one error.** Rejected because
the distinction is operationally useful and already exists in the frozen error
roster.

## Affected Rules

- `law/policy/mutation-evidence-v2.json` freezes phase boundaries, digest domains,
  framing, payload order, five-way equality, and error precedence.
- `law/schemas/mutation-evidence-policy-v2.schema.json` rejects any replacement
  of those constants.
- `law/schemas/mutation-report-set-v2.schema.json` remains the strict document
  shape consumed by the clarified semantic kernel.

## Inspector Adversarial Acceptance

Each frontmatter case must be exercised against both the strict document schema
and the mandatory semantic kernel. Acceptance requires certify-only source
population recomputation, one exact framed digest definition for every named
digest, five-way input-identity equality, and deterministic precedence between
missing and divergent input identity failures.
