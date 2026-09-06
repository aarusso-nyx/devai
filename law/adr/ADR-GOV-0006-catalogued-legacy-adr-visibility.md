---
id: ADR-GOV-0006
title: Digest-bound catalog metadata preserves legacy ADR visibility
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0001
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 39 (explicit uncertainty over false precision)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0001-adr-identity-and-fail-closed-validation.md
affected_rules:
  - law/schemas/adr-v2.schema.json
  - law/schemas/adr-validation-policy.schema.json
  - law/policy/adr-validation.json
inspector_acceptance:
  - IA-001 -- Numeric, date, scoped, no-frontmatter, and adr_id historical records are each visible with catalog-supplied stable identity and metadata while their file bytes remain unchanged.
  - IA-002 -- A preserved legacy entry missing any required metadata, carrying an invalid stable reference, or disagreeing with its pinned file digest fails closed.
  - IA-003 -- Adding, removing, or modifying legacy metadata without recomputing the RFC 8785 catalog digest fails closed even when path and file digest are unchanged.
  - IA-004 -- A legacy supersession target absent from the exact reference-and-path allowlist is unresolved even when a matching catalog entry exists.
  - IA-005 -- An allowlist entry without exactly one matching preserved catalog record also fails; catalog membership and resolvability remain a checked bijection.
  - IA-006 -- A Markdown file absent from both the v2 record population and the exact digest-bound catalog remains an unmatched-file failure.
---

# Digest-bound catalog metadata preserves legacy ADR visibility

## Status

Accepted. Supersedes ADR-GOV-0001 while retaining scoped v2 identity,
forward-only supersession, recursive total census, and fail-closed exceptions.

## Context

ADR-GOV-0001 preserved one numeric pre-v2 record by exact path and digest. It
treated that file as an exception to the v2 parser, but its catalog supplied no
record metadata. The semantic resolver therefore needed to recover identity
from historical bytes even though the catalog existed specifically to avoid
rewriting or reinterpreting those bytes.

That narrow shape cannot adopt an established repository whose historical ADRs
use numeric IDs, date IDs, scoped IDs, no frontmatter, or the old `adr_id`
field. Requiring those records to validate as v2 would rewrite accepted
history. Treating them as non-record exceptions would make real decisions
invisible. A path-and-file-digest-only catalog also failed to bind any metadata
added later.

## Decision

Every `preserved-pre-v2-record` catalog entry supplies normalized immutable
record metadata: a stable reference, title, lifecycle status, nullable date,
declared source format, supersedes list, and affected rules. The five supported
source-format classifications are `numeric-id-frontmatter`,
`date-id-frontmatter`, `scoped-id-frontmatter`, `no-frontmatter`, and
`adr_id-frontmatter`.

Numeric legacy references retain their `ADR-NNN` identity. All other historical
forms receive an Architect-declared stable identity in the collision-free
`LEGACY:` namespace. The identity is not derived by a validator. V2 records may
name a `LEGACY:` identity only when the policy contains an exact reference and
path allowlist entry for it.

The allowlist and preserved catalog entries form a bijection by reference and
path. A catalog entry does not implicitly authorize a supersession reference;
an allowlist entry does not manufacture a record. Both sides must exist and
match exactly before the semantic graph is built.

The exception-catalog digest is SHA-256 over the UTF-8 RFC 8785 canonical JSON
bytes of the complete entries array in UTF-8 path order. It therefore binds
path, file digest, disposition, reason, and every normalized metadata field.
Only after both the catalog digest and the historical file-byte digest match is
the catalogued record materialized into the recursive census and semantic
supersession graph.

## Consequences

An adopter can classify an arbitrary finite legacy ADR population without
changing one historical byte. Every genuine historical decision remains
visible in the census with stable metadata, and every unlisted or modified file
still fails closed.

Metadata normalization is an Architect decision visible as a policy change. It
does not pretend the historical file contained fields it did not contain. A
nullable date records uncertainty honestly, while the source-format field
preserves how the original record was represented.

The ADR semantic resolver advances to v2 because its census population,
catalog canonicalization, and allowlist checks changed. DEVAI's `ADR-014` bytes
and every earlier v2 ADR byte remain unchanged.

## Alternatives Considered

**Rewrite every historical record into v2.** Rejected: it destroys immutable
accepted history and creates noisy, authority-sensitive changes in adopters.

**Parse every legacy dialect heuristically.** Rejected: missing frontmatter and
field-name variation force inference precisely where stable identity must be
explicit.

**Catalogue legacy records as non-record prose.** Rejected: the recursive scan
would pass by making binding historical decisions invisible.

**Bind only paths and file digests.** Rejected: metadata could then change
without changing the catalog digest, so the semantic record would not be
digest-bound.

**Resolve every catalogued legacy identity automatically.** Rejected: catalog
membership preserves visibility; supersession resolvability is a separate
explicit choice and must remain allowlisted.

## Affected Rules

- `law/schemas/adr-v2.schema.json` — explicitly allowlisted `LEGACY:` supersession references.
- `law/schemas/adr-validation-policy.schema.json` — normalized legacy metadata, digest canonicalization, and resolver v2.
- `law/policy/adr-validation.json` — normalized metadata for the byte-preserved `ADR-014` and its recomputed catalog digest.

## Inspector Adversarial Acceptance

The Inspector builds one immutable fixture for each legacy source format and
demonstrates visibility without byte edits. It separately corrupts the file,
each metadata field, the catalog digest, and each side of the allowlist
bijection, and confirms every attack refuses before effective authority is
reported.
