---
id: ADR-GOV-0009
title: Instance-validatable ADR results and pure subject syntax
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0008
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0008-canonical-subject-projections.md
affected_rules:
  - law/policy/adr-validation.json
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - scripts/check-workflows.mjs
inspector_acceptance:
  - IA-001 -- a.txt and scripts/check-workflows.mjs are valid subjects without filesystem or Git access, while POSIX and Windows-drive absolute forms, backslashes, dot segments, duplicate or trailing separators, NUL, glob syntax, and non-NFC aliases fail.
  - IA-002 -- A result with top-level adrs, effective_authorities, and subject_authorities validates only when every nested object has its exact required fields and no additional properties.
  - IA-003 -- Partial effectiveness preserves declared affected_rules, uses adr_id, and makes effective true if and only if sorted effective_affected_rules is nonempty and a subset of the declaration.
  - IA-004 -- Multiple same-subject lineages remain distinct sorted subject_authorities entries, each containing sorted unique lineage_members and its effective_head.
  - IA-005 -- A cross-subject global cycle, same-subject conflict, unresolved reference, malformed result shape, or union mismatch fails before authority or downstream coverage is accepted.
---

# ADR-GOV-0009 — Instance-validatable ADR results and pure subject syntax

## Status

Accepted. This forward decision supersedes ADR-GOV-0008 for the shared
subjects, preserving all prior ADR bytes and historical authority evidence.

## Context

ADR-GOV-0008 correctly made the authority projection deterministic, but it
incorrectly made a declarative subject depend on the checkout: an evaluator
would need filesystem and Git access to decide whether a string was admissible.
That makes a portable policy less reusable and turns current repository state
into unstated authority.

The prior output description also did not define an actual result instance in a
schema. Consumers therefore could not validate field spelling, exact object
shape, or compatibility fields without independently inventing a contract.

## Decision

Affected rules are canonical Unicode-NFC repository-relative POSIX
governed/review subject strings. They are syntax only: validation must not read
Git or require that the path currently exists. Valid examples include `a.txt`
and `scripts/check-workflows.mjs`. Invalid forms include POSIX absolute paths,
Windows drive-absolute `C:/...` paths, backslashes, empty, dot, or dotdot
segments, duplicate or trailing separators, NUL, glob syntax, and a string that
is not already NFC.

The existing ADR validation policy schema defines
`$defs/adrValidationResult`, referenced by the policy's exact
`result_schema_pointer`; no additional schema file exists. A result has exactly
three top-level fields: `adrs`, `effective_authorities`, and
`subject_authorities`. Every `adrs` item has exactly `adr_id`,
`affected_rules`, `effective_affected_rules`, and `effective`. Every
subject-authority item has exactly `subject`, `lineage_members`, and
`effective_head`.

The policy freezes the semantic rules that JSON Schema alone cannot express:
UTF-8 byte ordering, unique ADR identifiers, sorted unique subset relation for
effective subjects, the iff relation for `effective`, sorted lineage members
that contain their head, sorted subject-lineage entries, and the exact
sorted-unique effective-authorities union. Downstream coverage consumes only
`adrs[].effective_affected_rules`.

Global supersession-cycle rejection still occurs before subject projection; the
per-subject cycle, direct-successor, and effective-head rules remain unchanged.

## Consequences

An evaluator can validate the portable lexical subject contract and the result
object shape offline. It must perform the policy's stated semantic comparisons
after structural validation; it cannot substitute incidental input ordering,
filesystem membership, or a flat authority list for the defined result.

The v3 kernel identifier remains stable: the subject-lineage authority model
and its failure conditions are unchanged, while the result is made concretely
representable in the existing schema.

## Alternatives Considered

**Require a tracked current file.** Rejected because it adds checkout and Git
state to a declarative authority subject and prevents portable evaluation.

**Add a fourteenth schema file.** Rejected because the result belongs to the
ADR validation policy and can be precisely defined under its existing `$defs`.

**Keep `records` and `id` as informal output names.** Rejected because they
collide with other result vocabulary and fail to bind a concrete instance.

**Use JSON Schema as the only sorting and cross-field check.** Rejected because
those comparisons require the frozen semantic rules as well as structural
validation.

## Affected Rules

- `law/policy/adr-validation.json`: pure subject syntax and exact result
  projection semantics.
- `law/schemas/adr-v2.schema.json`: portable POSIX subject lexical grammar.
- `law/schemas/adr-validation-policy.schema.json`: result `$defs` and policy
  pointer.
- `scripts/check-workflows.mjs`: retained as a non-`law/` review-path subject;
  its bytes are unchanged.

## Inspector Adversarial Acceptance

- IA-001 -- `a.txt` and `scripts/check-workflows.mjs` validate without a
  checkout lookup; every prohibited path form and non-NFC alias fails.
- IA-002 -- Result instances reject `records`, `id`, missing required fields,
  and any unexpected top-level, ADR, or subject-authority property.
- IA-003 -- Partial effectiveness is structurally valid only with `adr_id` and
  the exact declared/effective field types; semantic subset and iff checks hold.
- IA-004 -- Independent same-subject lineages remain separately represented;
  their sorted members include the effective head.
- IA-005 -- Global and scoped graph failures, legacy catalog digest drift, and
  effective-authorities union drift fail before coverage is consumed.
