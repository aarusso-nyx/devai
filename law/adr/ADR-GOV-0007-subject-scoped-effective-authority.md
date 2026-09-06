---
id: ADR-GOV-0007
title: Subject-scoped effective ADR authority
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0003
  - ADR-GOV-0004
  - ADR-GOV-0006
  - ADR-REL-0003
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0003-mandatory-semantic-kernels.md
  - law/adr/ADR-GOV-0004-exact-semantic-kernel-closure.md
  - law/adr/ADR-GOV-0006-catalogued-legacy-adr-visibility.md
  - law/adr/ADR-REL-0003-blocked-plan-receipts.md
affected_rules:
  - law/policy/adr-validation.json
  - law/policy/release-lifecycle.json
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-plan-receipt.schema.json
inspector_acceptance:
  - IA-001 -- Disjoint accepted successors of one record remain independently effective for their distinct normalized affected-rule subjects.
  - IA-002 -- Two accepted successors that both remain effective for the same normalized affected-rule subject fail before authority is emitted.
  - IA-003 -- A successor transfers authority only for the intersection of its subjects and its target's subjects; a target remains effective for every unrelated subject.
  - IA-004 -- An accepted record with an empty, noncanonical, or duplicate affected-rule subject set fails before graph construction.
  - IA-005 -- A same-subject cycle, unresolved target, self-reference, or multiple effective heads fails closed; legacy catalog and allowlist validation remains unchanged.
---

# ADR-GOV-0007 — Subject-scoped effective ADR authority

## Status

Accepted. This forward decision supersedes the affected authority subjects of
the listed records without changing their historical bytes or recorded status.

## Context

The v2 resolver treated every supersession edge as if it transferred all
authority of a record. That model is invalid for cross-cutting governance ADRs:
one record can refine an ADR parser, a release receipt, a mutation contract, or
a self-dogfood rule independently. A later correction to one subject then
appears as an unrelated global branch even when it is the only authority for
that subject.

The existing records demonstrate the defect. `ADR-GOV-0003` crossed several
subjects, while `ADR-GOV-0006` refined ADR validation and `ADR-REL-0003`
refined blocked release receipts. Whole-lineage uniqueness cannot distinguish
those subject boundaries, so it either rejects a legitimate independent
correction or incorrectly erases unrelated authority.

## Decision

Effective accepted authority is resolved per exact normalized `affected_rules`
subject and its explicit supersession-connected lineage. Every accepted v2
record and every accepted catalogued legacy record must declare one or more
canonical repository-relative `law/` paths. A supersession edge transfers
authority only for the intersection of the successor's and target's subject
sets. It transfers no unrelated subject.

For each subject, the resolver builds its accepted supersession graph and
partitions it into deterministic weakly connected lineages. Independent records
with no supersession relation may coexist on a common file because a file may
contain several rules. Within one subject-lineage, the resolver fails closed on
a cycle, multiple accepted direct successors that both remain effective, or
multiple effective accepted heads. A later accepted record may converge
previously competing branches; a branch already superseded for the subject is
not an effective direct successor.

This ADR converges the previously conflicting subjects forward. It carries the
three ADR-validation subjects and four blocked-plan subjects, superseding the
records that were effective on those exact subjects. It does not alter the
authority of their other affected rules.

The legacy exception catalog, its RFC 8785 digest, exact file digests, and
reference/path allowlist bijection remain prerequisites before any legacy record
is materialized. This decision changes neither legacy bytes nor their metadata.

## Consequences

The semantic resolver advances to v3. Its output is a deterministic mapping
from each canonical affected-rule subject and sorted lineage membership to one
accepted effective head; it is not a single global ADR head. New accepted ADRs
must explicitly name their subjects, and an implementation must reject a
missing, malformed, duplicate, or noncanonical subject before authority
resolution.

An ADR still never rewrites its predecessor. Supersession remains forward-only,
and a path merely listed in a successor cannot silently revoke an unrelated
predecessor rule.

## Alternatives Considered

**Keep one effective head for each global lineage.** Rejected because
cross-cutting decisions make independent later corrections unrepresentable.

**Resolve by ADR namespace or filename.** Rejected because namespace and path
are organizational labels, not the exact rule subject an authority claim
changes.

**Let any overlapping accepted successor win by date or identifier.** Rejected
because it invents precedence and can hide a real conflicting authority claim.

**Rewrite historical ADRs to split their subjects.** Rejected because accepted
records are immutable evidence; a new forward record can express the correction
without fabricating historical intent.

## Affected Rules

- `law/policy/adr-validation.json`: v3 subject-scoped resolver algorithm.
- `law/policy/release-lifecycle.json`: current blocked-plan authority is
  converged without changing the lifecycle content.
- `law/schemas/adr-v2.schema.json`: accepted records require canonical,
  nonempty affected-rule subjects.
- `law/schemas/adr-validation-policy.schema.json`: legacy metadata and the
  resolver enforce the same canonical subject model.
- `law/schemas/release-lifecycle-policy.schema.json`: current blocked-plan
  policy authority is converged without altering its contract.
- `law/schemas/release-lifecycle-state.schema.json`: current blocked-plan state
  binding authority is converged without altering its contract.
- `law/schemas/release-plan-receipt.schema.json`: current blocked-plan receipt
  authority is converged without altering its contract.

## Inspector Adversarial Acceptance

- IA-001 -- Disjoint successors remain independently effective only for their
  own normalized subjects.
- IA-002 -- Two effective accepted successors for one normalized
  subject-lineage fail before an authority head is emitted.
- IA-003 -- A successor cannot erase a target's subject that is outside their
  intersection.
- IA-004 -- Empty, duplicate, absolute, dot-segment, backslash, repeated-slash,
  glob, and trailing-slash affected-rule subjects fail before graph construction.
- IA-005 -- Same-subject cycles, unresolved targets, self-references, legacy
  catalog-digest drift, and allowlist-bijection drift fail closed.
