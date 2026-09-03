---
id: ADR-GOV-0008
title: Canonical subject projections and global supersession safety
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0007
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0007-subject-scoped-effective-authority.md
affected_rules:
  - law/policy/adr-validation.json
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - scripts/check-workflows.mjs
inspector_acceptance:
  - IA-001 -- A tracked non-law review path such as scripts/check-workflows.mjs is accepted while absolute, backslash, empty-segment, dot-segment, duplicate-separator, NUL, glob, trailing-separator, and non-NFC alias paths fail before projection.
  - IA-002 -- A record with partial subject effectiveness retains its declared affected_rules, emits only sorted effective_affected_rules, and has effective true if and only if that list is nonempty.
  - IA-003 -- Multiple independent lineages for one subject produce distinct sorted subject_authorities entries, each with sorted lineage_members and one effective_head.
  - IA-004 -- A cycle across different subjects fails in the global supersession graph before subject projection even when every projected subject graph would be acyclic.
  - IA-005 -- effective_authorities is exactly the sorted unique union of subject_authorities effective_head values, and downstream coverage uses records[].effective_affected_rules.
---

# ADR-GOV-0008 — Canonical subject projections and global supersession safety

## Status

Accepted. This forward decision supersedes the listed record only for their
shared affected-rule subjects. It preserves the predecessor's historical bytes,
status, and authority over subjects not carried here.

## Context

ADR-GOV-0007 correctly separated effective authority by exact subject and
supersession-connected lineage, but its lexical subject contract was too narrow:
governed review surfaces may live outside `law/`, including
`scripts/check-workflows.mjs`. It also described heads without freezing an
unambiguous result projection for partial effectiveness and multiple lineages.

Finally, subject projection alone can conceal a malformed global supersession
cycle when each edge names different subjects. The full historical relation must
remain acyclic before any scoped authority is derived.

## Decision

An affected-rule subject is a literal, canonical repository-relative tracked
regular file path for a governed or review surface. It is accepted only when it
is already Unicode NFC and has no absolute form, backslash, empty, dot, or
dotdot segment, duplicate or trailing separator, NUL, or glob. Comparison and
sorting use UTF-8 byte lexicographic order after NFC validation. The path is not
restricted to `law/`.

The v3 resolver first builds an edge for every resolved `supersedes` reference
and rejects any global cycle. It then applies the subject-intersection graph and
the existing per-subject-lineage cycle and conflict checks.

The v3 result is additive and deterministic. Each ID-sorted record projection
retains its declaration-order `affected_rules`, adds sorted unique
`effective_affected_rules`, and sets `effective` exactly when that new list is
nonempty. The compatibility `effective_authorities` field is the sorted unique
union of all subject-authority heads. `subject_authorities` is sorted by subject
and canonical lineage membership and records `subject`, sorted
`lineage_members`, and `effective_head` for every accepted subject-lineage.
Every downstream coverage consumer uses only
`records[].effective_affected_rules`.

## Consequences

The resolver kernel remains v3 because this is an additive, fully specified
result contract and a restored mandatory safety condition, not an alternate
authority model. Implementations cannot infer an unstated projection shape,
choose a head by incidental input order, or count a record's non-effective
subjects as coverage.

The new review-path subject demonstrates that authority can bind a governed
repository surface outside `law/`. Existing catalog entries, their digest and
their exact reference/path bijection remain unchanged.

## Alternatives Considered

**Restrict subjects to `law/`.** Rejected because authoritative review rules
can reside in tracked scripts and other repository surfaces.

**Normalize non-NFC input silently.** Rejected because aliases would create
different signed bytes that compare as one path; rejecting the alias preserves
one auditable spelling.

**Expose only a flat effective-authorities union.** Rejected because it loses
the subject and lineage needed to explain partial authority.

**Rely solely on per-subject cycles.** Rejected because a cross-subject cycle is
still an inconsistent global historical relation.

## Affected Rules

- `law/policy/adr-validation.json`: canonical subject, global-cycle, and v3
  output-contract requirements.
- `law/schemas/adr-v2.schema.json`: repository-relative subject lexical shape.
- `law/schemas/adr-validation-policy.schema.json`: exact policy and projection
  contract validation.
- `scripts/check-workflows.mjs`: a governed review-path subject covered by the
  canonical subject contract; its bytes are not changed by this ADR.

## Inspector Adversarial Acceptance

- IA-001 -- A valid NFC `scripts/check-workflows.mjs` subject passes while a
  decomposed Unicode alias and every prohibited path shape fail.
- IA-002 -- Partial effectiveness does not erase declared subjects and produces
  a deterministic sorted effective-subject list and boolean.
- IA-003 -- Two disconnected lineages for one subject remain separately visible
  in sorted subject_authorities rather than collapsing to one ambiguous entry.
- IA-004 -- A global cross-subject supersession cycle fails before scoped graph
  construction.
- IA-005 -- Legacy digest and reference/path-bijection checks remain mandatory
  before any projection is emitted.
