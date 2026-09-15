---
id: ADR-REL-0005
title: Separate legacy seams, state generation, and log sequence
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-REL-0004
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0014-durable-v2-remote-execution.md
  - law/adr/ADR-REL-0004-separate-release-log-tail-and-state-head.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Legacy execution_seams fields remain readable but cannot supply generation, head, or compare-and-swap rules to any v2 or v3 active kernel.
  - IA-002 -- HEAD generation equals the generation of the separately verified state document named by the completion state identity, never the completion record sequence.
  - IA-003 -- A completion record sequence remains solely an append-log position even when its numeric value differs from the completed state generation.
---

# Separate legacy seams, state generation, and log sequence

## Status

Accepted as a narrow forward clarification of ADR-REL-0004. Its append-tail,
observed-head, retry, resume, authorization, and full-v2-head decisions remain
unchanged.

## Context

The deprecated `execution_seams.state_store` retains the original v1
generation-and-head layout for wire-compatible historical observation. Although
the enclosing status already called that surface non-authoritative, the legacy
field prose still used imperative language. A reader could therefore apply its
single-generation model to active v2/v3 execution, contradicting the separate
append-log sequence and completed-state head.

The active v3 store rule also said a head and completion record shared a
generation. A completion record contains an append-log `sequence`; its
completion payload identifies a separately stored state document. Only that
state document has the lifecycle generation that `HEAD.generation` represents.

## Decision

All existing `execution_seams` fields and values remain byte-preserved for v1
read compatibility. A new frozen applicability declaration limits the entire
surface to wire-compatible legacy-v1 observation and grants it no v2/v3 write
or execution authority. Every active v2/v3 kernel must ignore the legacy
state-store generation, head, and compare-and-swap constraints.

The active execution compatibility declaration repeats that boundary so an
implementation cannot select the legacy model merely because both surfaces are
present in one policy document.

For a completed action, `HEAD.state_id` and `HEAD.state_digest_sha256` equal the
completion payload's `state_id` and `state_digest_sha256`. The core separately
loads and semantically verifies that exact state document. `HEAD.generation`
equals the verified state document's generation. The completion record's
`sequence` remains only its append-log position and has no required numeric
relationship to the state generation.

Applying a legacy seam constraint to active execution and copying a completion
record sequence into head generation have distinct frozen refusal codes and
negative fixtures.

## Consequences

Historical v1 observations remain readable without gaining current authority.
Active implementations have one unambiguous store model, and state progress can
diverge numerically from audit-log position without being rejected or silently
rewritten.

Head validation now requires the exact completion, state identity, and
separately verified state generation. A matching log sequence alone can never
establish lifecycle generation.

## Alternatives Considered

**Delete the legacy seams.** Rejected because DEVAI 1.x retains read
compatibility for historical v1 records.

**Rewrite the legacy v1 field values.** Rejected because that would alter the
historical wire contract instead of bounding its applicability.

**Set head generation from completion sequence.** Rejected because failures and
attempts advance the append log without advancing completed release state.

## Affected Rules

- `law/policy/release-lifecycle.json` freezes the legacy-only seam boundary and
  the corrected state-generation relationship.
- `law/schemas/release-lifecycle-policy.schema.json` requires those declarations
  and freezes their negative fixture/error mappings.

## Inspector Adversarial Acceptance

The Inspector must validate a history in which attempts and failures make the
completion record sequence greater than the next state generation. The exact
verified state generation must be accepted in `HEAD`; the log sequence in that
field must be refused. Removing the applicability declaration or allowing any
active kernel to consume the legacy seam's generation/head/CAS constraints must
also fail with the frozen errors.
