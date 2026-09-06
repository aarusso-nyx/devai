---
id: ADR-GOV-0011
title: Fail-closed ADR validation result state
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0010
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0010-complete-adr-validation-result.md
affected_rules:
  - law/policy/adr-validation.json
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - scripts/check-workflows.mjs
inspector_acceptance:
  - IA-001 -- ADR row format accepts only v2 or legacy-catalog and rejects every invented spelling.
  - IA-002 -- ok is true exactly when semantic_resolution_performed is true and errors is empty; all other state combinations fail.
  - IA-003 -- Any ok:false result with a live ADR effective flag, effective subject, effective authority, or subject authority fails before coverage is consumed.
  - IA-004 -- semantic_resolution_performed:false requires ok:false and at least one adr-semantic-resolution-not-performed error, with no live authority.
  - IA-005 -- A valid success preserves the seven graph/bijection rules; global, scoped, path, catalog, malformed, and state-confusion attacks remain fail closed.
---

# ADR-GOV-0011 — Fail-closed ADR validation result state

## Status

Accepted. This forward ADR supersedes ADR-GOV-0010 only for their shared
subjects and preserves every predecessor byte and historical record.

## Context

The complete v3 result envelope and row/lineage bijection are necessary but not
sufficient if a failed validation can still carry stale or partially parsed
authority. A consumer could otherwise read an effective subject from an
`ok:false` result and treat it as coverage despite a failed diagnostic.

The result also needs a finite provenance format vocabulary; an arbitrary string
would let callers invent an evidence source that the contract never defined.

## Decision

Every ADR row `format` is exactly `v2` or `legacy-catalog`. No other format is
accepted.

`ok` is true if and only if `semantic_resolution_performed` is true and
`errors` is empty. If semantic resolution was not performed, `ok` is false and
the result contains at least one `adr-semantic-resolution-not-performed` error.

Any `ok:false` result grants no effective authority regardless of partial
parsing: every ADR has `effective:false` and an empty
`effective_affected_rules`; `effective_authorities` and
`subject_authorities` are empty. JSON Schema enforces the local state and
emptiness properties where possible; the policy's mandatory state rule enforces
the whole-result equivalence before any downstream coverage use.

Only successful results use the seven existing graph and bijection rules. The
global supersession precheck, per-subject conflict rules, canonical path rules,
legacy digest and allowlist checks all remain prerequisites.

## Consequences

No caller may rescue authority from a failed or semantically incomplete report.
A result is either a fully resolved success with demonstrable coverage or a
non-authoritative failure carrying diagnostics only.

The v3 kernel remains unchanged: this ADR closes result-state interpretation,
not subject-lineage graph resolution.

## Alternatives Considered

**Keep partial effective rows on failure for debugging.** Rejected because
debugging data must not be indistinguishable from authority evidence.

**Infer format from filename or fields.** Rejected because inference is mutable
and makes source provenance ambiguous.

**Make only top-level authorities empty on failure.** Rejected because a row's
effective flag or subject list could still leak authority to coverage consumers.

**Permit semantic-resolution false without a diagnostic.** Rejected because an
absent semantic result must be observable and fail closed.

## Affected Rules

- `law/policy/adr-validation.json`: finite format vocabulary and fail-closed
  success/failure state semantics.
- `law/schemas/adr-v2.schema.json`: retained portable subject syntax.
- `law/schemas/adr-validation-policy.schema.json`: structural conditionals for
  result state and format.
- `scripts/check-workflows.mjs`: retained non-`law/` review subject; unchanged.

## Inspector Adversarial Acceptance

- IA-001 -- Invented formats, false-pass states, false results with authority,
  and semantic-false results without their required diagnostic fail.
- IA-002 -- A valid failed result can carry parsed ADR metadata only when every
  effective field and top-level authority collection is empty.
- IA-003 -- A valid success has semantic resolution, zero errors, and the full
  seven graph/bijection invariants.
- IA-004 -- No coverage consumer reads anything except an effective subject from
  a successful result.
- IA-005 -- Global/scoped graph, path, catalog, malformed-envelope, orphan,
  omission, and ordering attacks remain rejected.
