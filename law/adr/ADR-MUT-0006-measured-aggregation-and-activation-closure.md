---
id: ADR-MUT-0006
title: Measured mutation aggregation and activation closure
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-MUT-0005
provenance:
  - law/constitution.md Article 30 (test weakening prohibition)
  - law/constitution.md Article 39 (explicit uncertainty over false precision)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-MUT-0005-unambiguous-mutation-digest-boundaries.md
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
  - law/schemas/mutation-report-set-v2.schema.json
inspector_acceptance:
  - IA-001 -- A required package with zero total mutants or zero scored mutants is incomplete and cannot pass; genuine absence is represented only by a receipt-proven not-required entry.
  - IA-002 -- Every framed digest uses its separately published literal ASCII domain, one NUL octet, U64BE payload length and the frozen RFC 8785 payload shape.
  - IA-003 -- Mixed aggregates pool only required-package status totals and pass exactly when at least one required package exists and every required package is complete and passed.
  - IA-004 -- The inactive policy has approvedSource null; activation requires a later forward policy and schema update that pins the approved source commit and tree as constants and proves exact vendor byte equality.
  - IA-005 -- Certify resolves and validates every reused origin receipt and evidence set, while the signed bundle closes over every required normalized report and package result exactly once.
---

# Measured mutation aggregation and activation closure

## Status

Accepted as the final pre-activation correction to mutation evidence v2. The
protocol remains `2.1.0`; emission and verification remain disabled until a
later forward decision pins the completed canonical verifier source.

## Context

ADR-MUT-0005 removed ambiguity from lifecycle phase ownership and digest
framing, but adversarial fixtures still found five gaps. A required package
could report the legacy empty-population score of one hundred and appear to
pass without measuring a mutant. Digest domains remained embedded in prose
descriptors instead of being published as literal bytes, and the exact payload
shape of some named digests was not machine-frozen. Mixed aggregate verdicts
did not say whether incomplete and failed packages were pooled or prioritized.
The inactive policy could be switched to active with arbitrary source commit
and tree values. Finally, reused origins and normalized reports were not
explicitly part of certify and signed-bundle closure.

## Decision

A required package is measured only when both `targetCensus.totalMutants` and
the binary64 `scored` population are greater than zero. A zero value makes the
required package incomplete and not passed, with `MUTATION_INCOMPLETE`; it can
never inherit the empty-population score as authority. If candidate and profile
semantics establish that no mutation is required, certify emits a
receipt-proven `not-required` entry instead of an empty required result.

Every framed digest uses exactly:

`SHA-256(ASCII(domain) || 0x00 || U64BE(byteLength(payloadBytes)) || payloadBytes)`

The NUL is one octet, `U64BE` is one unsigned eight-octet big-endian integer,
and JSON `payloadBytes` are RFC 8785 JCS UTF-8. The policy publishes each literal
ASCII domain separately from its payload description. The domains are
`devai:mutation-output-contract:v2.1`,
`devai:mutation-package-result-set:v2.1`,
`devai:mutation-composition-entry:v2.1`,
`devai:mutation-evidence-ref:v2.1`, `devai:mutation-input:v2.1`,
`devai:mutation-composition:v2.1`, and
`devai:mutation-semantic-receipt:v2.1`. The package-result-set payload is exactly
the array of objects `{packageName,resultDigest}` for required packages, in
their output-contract order, with exactly those two members. The policy freezes
the complete payload shape and omissions for every other named digest. Raw
normalized-report and package-result artifact digests remain unframed SHA-256
over their exact RFC 8785 JCS UTF-8 document bytes.

An aggregate pools the eight status totals of required packages only, using
checked safe-integer addition. It derives `detected`, `scored`, and `score` from
those pooled totals in the frozen binary64 operation order. Not-required
packages contribute no status or score. The aggregate and composition pass if
and only if at least one required package exists and every required package is
complete and passed. They are unknown if any required package is incomplete,
even when another required package has failed. They fail otherwise. An
all-not-required composition remains complete, `not-applicable`, and not passed,
with null score and zero status totals.

The current inactive policy carries `approvedSource: null`, and its schema
admits no active alternative. After the canonical verifier implements this
contract, a new forward ADR, policy update, and policy-schema update must pin
the approved repository, commit, and tree as exact constants. Only that update
may set the policy active. Its provenance proof must have a source object
exactly equal to `approvedSource` and must additionally bind the vendor root,
manifest path, manifest digest, recorded source commit and tree, vendor byte-set
digest, source byte-set digest, and byte equality. The historical
`sourceBaseline` remains an audit anchor and grants no activation authority.

During certify, every reused entry is resolved through its exact origin
candidate, semantic-receipt digest, and evidence-set digest. Certify validates
the producing receipt, its verifier provenance and passing package entry, the
producing composition and evidence-set digest, and equality of package name,
input digest, report digest, and result digest. A missing, failed, mismatched, or
untrusted origin returns `MUTATION_REUSE_DENIED`. The signed artifact manifest
and portable bundle must contain every required normalized report and package
result exactly once, with no missing, substituted, or additional mutation-v2
evidence artifact. Offline verification recomputes this closure before trusting
the semantic receipt.

## Consequences

Empty mutation selection can no longer manufacture a passing score. A package
that genuinely has no mutatable production surface remains visible as
not-required and must be justified by the exact plan and profile receipt.

Mixed executed, reused, and not-required campaigns now have one deterministic
aggregate algorithm. Refinalization remains pure and launches no mutation
processes.

Activation becomes a deliberate source-pinning change rather than a boolean
flip. The canonical source implementation and vendor manifest must exist before
the future policy can represent an active state.

Reuse and export now preserve a complete provenance chain. A signed bundle that
omits a normalized report is incomplete even when its package result is present.

## Alternatives Considered

**Treat an empty required population as score one hundred.** Rejected because
absence of measurement is not successful mutation evidence.

**Allow runtime activation values under a generic source schema.** Rejected
because a caller could select its own authority. The approved source must be a
law-level constant introduced only after implementation review.

**Average package scores.** Rejected because packages with small mutant counts
would receive the same weight as large populations. The aggregate score is
derived from pooled required-package status totals.

**Sign only package-result documents.** Rejected because a result's report
digest does not prove that the corresponding normalized report is present in
the portable bundle.

## Affected Rules

- `law/policy/mutation-evidence-v2.json` freezes measured-package, digest,
  aggregation, activation, reuse, and bundle-closure semantics.
- `law/schemas/mutation-evidence-policy-v2.schema.json` fixes the inactive policy
  and admits no self-selected approved source.
- `law/schemas/mutation-report-set-v2.schema.json` prevents empty required
  results from passing and fixes package, composition, aggregate, and receipt
  verdict relationships.

## Inspector Adversarial Acceptance

All five frontmatter cases must be exercised against schema and semantic
fixtures. Acceptance additionally requires zero-mutant and zero-scored required
packages to return `MUTATION_INCOMPLETE`, altered domain or payload shapes to
change or invalidate their digest, mixed incomplete-plus-failed input to remain
unknown, inactive activation attempts to fail schema validation, unresolved
reuse origins to fail before reuse, and a signed bundle missing one normalized
report to fail exact closure.
