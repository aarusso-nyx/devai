---
id: ADR-GOV-0016
title: Preserve one invalid accepted ADR through a digest-bound classification
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/adr/ADR-GOV-0001-adr-identity-and-fail-closed-validation.md
  - law/adr/ADR-GOV-0006-catalogued-legacy-adr-visibility.md
  - law/adr/ADR-MUT-0006-measured-aggregation-and-activation-closure.md
affected_rules:
  - law/adr/ADR-MUT-0005-unambiguous-mutation-digest-boundaries.md
  - law/policy/adr-validation.json
  - law/schemas/adr-validation-policy.schema.json
  - packages/spec/src/adr/index.ts
inspector_acceptance:
  - IA-001 -- ADR-MUT-0005 hashes exactly to its accepted bytes at d37bfb4 and remains materialized only when its catalog entry, metadata, allowlist disposition, and catalog digest all match.
  - IA-002 -- Reintroducing the appended Inspector section, changing the catalog file hash or metadata, omitting the special allowlist member, or changing its disposition fails before effective authority is emitted.
  - IA-003 -- A normal v2 ADR missing a mandatory section is rejected; no generic invalid-v2 parsing or repair-in-place path exists.
  - IA-004 -- ADR-MUT-0006 resolves ADR-MUT-0005 as its exact supersession target and is the effective accepted head for their shared mutation-rule subjects.
---

# Preserve one invalid accepted ADR through a digest-bound classification

## Status

Accepted. This is a narrow history-preservation decision. It does not amend,
repair, or reaccept the earlier record.

## Context

After ADR-MUT-0005 was accepted, a later commit appended its missing
`Inspector Adversarial Acceptance` section. That made the current file validate,
but changed accepted predecessor bytes. Editing accepted history invalidates the
very evidence that the ADR system is meant to preserve.

The bytes accepted at `d37bfb4` have valid v2 frontmatter and decision content,
but are invalid under the later policy because that one required body heading is
absent. Treating them as ordinary pre-v2 history would be false. Ignoring them
would make ADR-MUT-0006's explicit supersession target unresolved.

## Decision

Restore ADR-MUT-0005 exactly to its accepted `d37bfb4` bytes. Its file is one
`preserved-invalid-accepted-record` catalog entry, identified by exact path,
file SHA-256, RFC 8785 catalog digest, normalized metadata, and a matching
reference/path/disposition allowlist member. The special source format is only
`v2-record-missing-required-section`; its materialized status is exactly
`accepted`.

The semantic resolver materializes this catalogued record from the bound
metadata only after every binding matches. It may then resolve
ADR-MUT-0006's existing forward supersession. The classification never parses
invalid v2 bytes as generally valid, never migrates when the bytes change, and
never permits repair in place. ADR-014 retains its existing
`preserved-pre-v2-record` classification unchanged.

## Consequences

The accepted historical bytes remain auditable and the mutation authority
lineage remains resolvable. A damaged catalog, an unallowlisted special record,
or any later file edit fails closed rather than silently transferring authority.

This adds one explicit catalog disposition and one exact source format, but no
open-ended exception. A future distinct case requires a new forward ADR,
schema/policy change, immutable digest binding, and Inspector evidence.

## Alternatives Considered

**Keep the appended section.** Rejected because it mutates accepted history.

**Call the record pre-v2.** Rejected because its failure is a missing required
body section in an otherwise v2-shaped accepted record, not a pre-v2 dialect.

**Loosen the v2 section requirement.** Rejected because that would hide new
invalid records and weaken the current fail-closed contract.

**Teach the parser to repair missing headings.** Rejected because inferred
repair would create new authority from non-conforming bytes.

## Affected Rules

- `law/adr/ADR-MUT-0005-unambiguous-mutation-digest-boundaries.md`: restored
  exactly to accepted historical bytes.
- `law/policy/adr-validation.json`: pins the sole special catalog entry and
  matching resolver allowlist member.
- `law/schemas/adr-validation-policy.schema.json`: constrains the special
  disposition to accepted metadata and the one source format.
- `packages/spec/src/adr/index.ts`: requires allowlist and catalog disposition
  equality before semantic materialization.

## Inspector Adversarial Acceptance

- IA-001 -- ADR-MUT-0005's exact accepted bytes, file digest, catalog metadata,
  allowlist disposition, and catalog digest are all required for materialization.
- IA-002 -- Any mutation of those bytes or bindings fails closed with no
  effective authority.
- IA-003 -- New invalid v2 records remain invalid and have no repair path.
- IA-004 -- ADR-MUT-0006 remains the forward effective head for the mutation
  subjects it shares with the materialized ADR-MUT-0005.
