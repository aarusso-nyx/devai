---
id: ADR-REL-0020
title: Explicit historical resume observation
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 39 (explicit uncertainty)
  - law/constitution.md Article 41 (immutable evidence)
  - law/adr/ADR-REL-0019-preserve-and-restate-installed-release-policy.md
  - law/adr/ADR-REL-0006-blocked-retry-observation-requirement.md
  - law/adr/ADR-REL-0002-nine-state-release-lifecycle-and-observed-publication.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-observation.schema.json
inspector_acceptance:
  - IA-001 -- A valid plan-v1 history emits deterministic observation 1.1.0 with legacy-plan-non-authoritative, blocked outcome, null next action, empty derived states and requirements, no observed publication and no effects.
  - IA-002 -- Every original 1.0.0 observation shape remains readable unchanged; the new reason under 1.0.0, an unknown version or a historical observation with readiness, derived states, retry, reconciliation or publication claims refuses.
  - IA-003 -- Malformed historical schema, id, digest, candidate identity or recorded chain remains the existing fail-closed refusal and never becomes valid historical evidence; mixed v1/v2 evidence remains historical and current actions still reject plan v1 as non-authoritative.
---

# Explicit historical resume observation

## Status

Accepted as a narrow supplemental implementation of ADR-REL-0019's historical
observation requirement. Accepted records remain byte-identical; no effect,
state, role or publication-verification kernel changes.

## Context

ADR-REL-0019 requires historical plan-v1 evidence to remain readable under its
original contract without current authority. The closed observation 1.0.0
reason set can report an identity mismatch but cannot truthfully identify
valid historical evidence. A valid old receipt is not corrupt, yet it is not
a current plan. Reinterpreting its origin or producing a current next action
would violate that accepted decision.

## Decision

Lifecycle policy 2.9.0 emits observation `schemaVersion: 1.1.0`. The existing
schema identifier accepts versions 1.0.0 and 1.1.0 explicitly; all original
1.0.0 shapes retain their existing validation semantics. Unknown versions
refuse. Existing examples and historical observation bytes stay unchanged.
The new stable blocked reason is `legacy-plan-non-authoritative`, accepted
only under 1.1.0. This reason is itself the explicit historical label; no
additional evidence wrapper or redundant historical object is introduced.

The historical shape requires `next_outcome: blocked`, `next_action: null`,
`blocked_requirements: []`, `derived_states: []`, and `published` exactly
`{observed: false, receipt: null, verified_against: null}`. It cannot carry
`reconciliation_requirements`. Existing all-false grants and read-only
emission remain mandatory. No readiness, executable next action, retry,
publication or current lifecycle state is derived from historical evidence.

Before assigning this label, verify the v1 receipt against its original
schema, canonical id and digest, and exact observed repository/candidate
identity. Independently validate any recorded history.
Missing, malformed, stale or mismatched required evidence and broken chains
retain the existing refusal; a schema-valid receipt alone does not establish
valid historical evidence. Version detection never bypasses those checks.
The observation may report the actual independently verified recorded head;
it never advances that head or substitutes a derived current state for it.

The historical classification precedes current-next-action derivation when
valid v1 plan evidence is present, including mixed valid v1/v2 evidence.
Conflicting receipt or candidate identities retain their existing refusal.
This label recognizes a historical format and its integrity, not a historical
PASS or readiness verdict. It requires no reconstruction of external original
input bytes and makes no claim that those inputs were independently replayed;
the receipt's recorded input metadata remains subject to its v1 schema and
complete canonical digest. No current
operation may use a v1 receipt as authority: the existing operation error
`rpl-legacy-plan-non-authoritative` remains distinct from the observation's
blocked reason `legacy-plan-non-authoritative`.

The observation digest still covers every member except `observation_id` and
`observation_digest_sha256`, including the version and historical reason.
No historical receipt is edited, relabelled, rehashed, migrated or wrapped
into current authority. New current evidence requires fresh verified inputs.

The publication observation kernel remains
`devai.kernel.release-lifecycle-observation.v1`: its published-derivation
algorithm and error set are unchanged. This classification cannot enter that
derivation. No action, state, effect, role, authorization or trust boundary
changes, and no new operation error code is required.

## Consequences

Engineer emits 1.1.0 observations and implements the explicit historical
classification before deriving a current next action. Readers keep original
1.0.0 observation compatibility. Inspector verifies the version boundary,
closed historical shape, unchanged publication/refusal behavior, original
v1 evidence validation, mixed-history refusal and zero writes or provider
calls. No accepted ADR or stored evidence is rewritten.

## Alternatives Considered

**Report receipt-identity-mismatch for valid history.** Rejected: it falsely
classifies validity and does not identify the historical boundary.

**Add the reason silently to observation 1.0.0.** Rejected: it changes a
closed historical contract without a version boundary.

**Add a historical wrapper or a new publication kernel.** Rejected: the
closed reason already identifies historicity, and the publication algorithm
has not changed. Neither extra representation nor extra authority is needed.

## Affected Rules

Only the lifecycle policy and its schema declare emission/read versions and
the historical shape. The observation schema closes that shape to 1.1.0.
ADR-REL-0019 remains effective and byte-identical; this supplemental decision
implements its observational requirement without superseding its policy
resolution or evidence rules.

## Inspector Adversarial Acceptance

Exercise valid v1 receipt and chain integrity, mixed valid v1/v2 inputs,
malformed ids/digests/schema members and foreign candidate/repository values.
Require deterministic historical-only output and zero mutations, provider
calls or derived readiness. Reject each deviation from the closed historical
shape, including a non-null action, nonempty derived states or requirements,
publication, reconciliation, a 1.0.0 version with the new reason and unknown
versions. Preserve original 1.0.0 read shapes and current v2 refusal behavior.
