---
id: ADR-GOV-0010
title: Complete instance-validatable ADR validation result
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0009
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0009-instance-validatable-adr-results.md
affected_rules:
  - law/policy/adr-validation.json
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - scripts/check-workflows.mjs
inspector_acceptance:
  - IA-001 -- A valid result requires exactly ok, kernel_id, semantic_resolution_performed, files_scanned, errors, adrs, effective_authorities, and subject_authorities; missing, renamed, or extra properties fail.
  - IA-002 -- ADR entries preserve every public field and errors preserve file/message with optional code/pointer; an omitted preserved field or unexpected nested field fails.
  - IA-003 -- An orphan authority head, an orphan effective subject, an unknown lineage member, a member not declaring its subject, a non-component lineage, or a non-unique head fails semantic validation.
  - IA-004 -- Every effective subject has exactly one matching subject-authority headed by that ADR, every authority head is reflected in that ADR, and effective_authorities equals both defined sorted unique head sets.
  - IA-005 -- Sorting uses RFC8785 JCS UTF-8 byte lexicographic order everywhere; global and per-subject graph, path, legacy catalog, and malformed-result attacks remain fail closed.
---

# ADR-GOV-0010 — Complete instance-validatable ADR validation result

## Status

Accepted. This forward ADR supersedes ADR-GOV-0009 on their shared subjects;
all prior ADR bytes, statuses, and historical evidence remain unchanged.

## Context

ADR-GOV-0009 made the projection structurally representable but modeled only a
projection fragment. The public `validateAdrs()` result also carries outcome,
kernel, semantic-resolution, scan-count, diagnostics, and preserved ADR fields.
Leaving those fields outside the result schema would permit a consumer to
silently change or drop a compatibility field.

The fragment also lacked an explicit bidirectional relation between ADR rows
and subject authorities. A structurally valid result could invent a head with
no ADR row or mark an ADR subject effective without an authority entry.

## Decision

`$defs/adrValidationResult` is the full backward-compatible public
`validateAdrs()` result. It has exactly the required top-level fields `ok`,
`kernel_id`, `semantic_resolution_performed`, `files_scanned`, `errors`,
`adrs`, `effective_authorities`, and `subject_authorities`, with no additional
properties. Diagnostics preserve required `file` and `message` and optional
`code` and `pointer`. ADR rows preserve required `file`, `adr_id`, `title`,
`status`, `date`, `format`, `supersedes`, `affected_rules`, `effective`, and
additive `effective_affected_rules`.

Every subject-authority member and head must be a known ADR row; every member
declares that subject; the members are exactly that subject's accepted weak
component; and the head is the component's unique effective ADR. There is a
strict bijection: each `adrs[].effective_affected_rules` subject has exactly
one corresponding subject-authority headed by that ADR, and every authority
head is reflected in its row. `effective_authorities` equals both the sorted
unique authority-head set and the sorted unique IDs whose effective lists are
nonempty. Coverage uses only that bijective effective-subject relation.

All ordering uses one comparator: ascending UTF-8 byte order of RFC 8785 JCS
serialization. The global supersession graph is still checked before subject
projection, and all prior path, scoped cycle, conflict, and legacy checks stay
mandatory.

## Consequences

Consumers can validate the complete public result envelope offline and then
apply one exact semantic relation to link diagnostics, rows, lineages, heads,
and coverage. Neither a flat compatibility list nor an incomplete projection is
authority evidence.

The v3 kernel remains stable: this ADR completes its concrete result contract
without changing the subject-lineage authority model or its failure conditions.

## Alternatives Considered

**Schema only the newly added projection fields.** Rejected because it leaves
the public envelope and preserved compatibility fields unbound.

**Allow subject authorities independent of rows.** Rejected because it permits
invented or omitted coverage.

**Use different string and object comparators.** Rejected because an ambiguous
ordering can yield different deterministic-looking result bytes.

**Add a separate result schema.** Rejected because the result is inseparable
from ADR validation policy and is self-contained in its existing `$defs`.

## Affected Rules

- `law/policy/adr-validation.json`: full public envelope and bijection rules.
- `law/schemas/adr-v2.schema.json`: retained portable subject syntax.
- `law/schemas/adr-validation-policy.schema.json`: complete result and nested
  object schema definitions.
- `scripts/check-workflows.mjs`: retained non-`law/` review subject; unchanged.

## Inspector Adversarial Acceptance

- IA-001 -- Every required public envelope, error, and ADR field is present and
  an extra or renamed field is rejected by the embedded schema.
- IA-002 -- Orphaned, unknown, omitted, duplicated, or cross-subject authority
  mappings fail the explicit row/lineage/head bijection.
- IA-003 -- Partial effectiveness retains all declared subjects and exactly
  matches one head entry for each effective subject.
- IA-004 -- RFC8785-JCS UTF-8 sorting is consistent for rows, subjects,
  members, and effective-authorities; no canonical-json alias remains.
- IA-005 -- Global cycles, scoped branch conflicts, unresolved or self targets,
  invalid paths, catalog digest drift, and malformed result instances fail.
